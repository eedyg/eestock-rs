//! StrategyService 测试（application 层；mock store + mock bar reader，真实 QuickJsRuntime）。
//! 覆盖：自动新 draft（ADR §13.5）/ 发布门禁拒绝坏代码 / sha256 稳定 / catalog 过滤 /
//! 状态机 409 语义 / 播种幂等 / test_run 双模式 + 区间上限 + 参数校验。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    BacktestBarRead, CatalogEntry, Clock, NewStrategy, NewStrategyVersion,
    StrategyManageItem, StrategyManagePublishedSummary, StrategyManageVersionSummary,
    StrategyRow, StrategyStore, StrategyVersionRow,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use domain::types::{Code, Period, SourceId};

use application::strategy::{
    sha256_hex, CreateStrategyInput, StrategyInvalidTransition, StrategyNotFound, StrategyService,
    StrategyValidation, TestRunMode, TestRunRequest, TestRunSource, UpdateDraftOutcome,
    MAX_EVENTS,
};

// ── fixtures ──

/// 恒分插件（带一个参数，验证 params 校验/缺省填充）。
const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

/// 无 on_bar（发布门禁应拒绝）。
const NO_ON_BAR: &str = "function score_it(ctx) { return 1; }";

/// 语法错误（eval 阶段即失败）。
const SYNTAX_ERR: &str = "function on_bar(ctx) { return ;";

/// 每 bar 抛错（pure_score G5：中立分 50 + 连续 10 次熔断）。
const THROWER: &str = "function on_bar(ctx) { throw new Error('boom'); }";

/// 每 bar 记日志（事件截断测试）。
const LOGGER: &str = "function on_bar(ctx) { ctx.log('hello'); return 50; }";

/// 趋势跟随：close > 105 给 90 分（Buy），否则 20 分（Sell）。
const TREND: &str = "function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }";

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 0, 0).unwrap()
}

struct FixedClock;
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        fixed_now()
    }
}

/// mock bar reader（固定 bar 序列；EmptyBars 返回空）。
struct MockBars(Vec<domain::types::Bar>);
#[async_trait::async_trait]
impl BacktestBarRead for MockBars {
    async fn bars(
        &self,
        _code: &str,
        _period: &Period,
        _from: DateTime<Utc>,
        _to: DateTime<Utc>,
    ) -> anyhow::Result<Vec<domain::types::Bar>> {
        Ok(self.0.clone())
    }
}

fn dbar(i: i64, close: f64) -> domain::types::Bar {
    domain::types::Bar {
        code: Code("600000".into()),
        period: Period::D1,
        ts: Utc.with_ymd_and_hms(2026, 9, 1, 1, 30, 0).unwrap() + Duration::days(i),
        open: close,
        high: close + 1.0,
        low: close - 1.0,
        close,
        volume: 1000,
        amount: close * 1000.0,
        source: SourceId::Tushare,
    }
}

/// 6 根日线：100,100,110,110,100,100（TREND 插件 → 1 笔完整交易）。
fn trend_bars() -> Vec<domain::types::Bar> {
    [100.0, 100.0, 110.0, 110.0, 100.0, 100.0]
        .iter()
        .enumerate()
        .map(|(i, c)| dbar(i as i64, *c))
        .collect()
}

// ── mock store（与 PgStrategyStore 同语义）──

#[derive(Default)]
struct MockStore {
    strategies: Mutex<HashMap<String, StrategyRow>>,
    versions: Mutex<HashMap<String, StrategyVersionRow>>,
    /// updated_at 推进序列（FixedClock 恒定时钟下使推进可观测：每次 bump +1s）。
    bump_seq: Mutex<i64>,
    /// 竞态注入钩子（TOCTOU 测试专用）：mark_published 落库检查前改写行，
    /// 模拟「publish 读出 code 之后、原子更新之前」的并发写。
    race_inject_code: Mutex<Option<String>>,
    race_inject_status: Mutex<Option<StrategyStatus>>,
}

impl MockStore {
    fn bump_updated(&self, strategy: &mut StrategyRow) {
        let mut n = self.bump_seq.lock().unwrap();
        *n += 1;
        strategy.updated_at = fixed_now() + Duration::seconds(*n);
    }

    /// 测试辅助：把某策略的 published 版本 approval_level 直升 sim_ok（模拟显式升级动作）。
    fn set_status_level_for_test(&self, strategy_id: &str) {
        let mut versions = self.versions.lock().unwrap();
        for v in versions.values_mut() {
            if v.strategy_id == strategy_id && v.status == StrategyStatus::Published {
                v.approval_level = ApprovalLevel::SimOk;
            }
        }
    }
}

#[async_trait::async_trait]
impl StrategyStore for MockStore {
    async fn create_strategy(&self, s: &NewStrategy) -> anyhow::Result<StrategyRow> {
        let row = StrategyRow {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            kind: s.kind,
            created_by: s.created_by.clone(),
            created_at: fixed_now(),
            updated_at: fixed_now(),
        };
        self.strategies.lock().unwrap().insert(row.id.clone(), row.clone());
        Ok(row)
    }

    async fn get_strategy(&self, id: &str) -> anyhow::Result<Option<StrategyRow>> {
        Ok(self.strategies.lock().unwrap().get(id).cloned())
    }

    async fn count_strategies(&self) -> anyhow::Result<i64> {
        Ok(self.strategies.lock().unwrap().len() as i64)
    }

    async fn catalog(
        &self,
        level: Option<ApprovalLevel>,
        kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<CatalogEntry>> {
        let strategies = self.strategies.lock().unwrap();
        let versions = self.versions.lock().unwrap();
        let mut out = Vec::new();
        for s in strategies.values() {
            if let Some(k) = kind {
                if s.kind != k {
                    continue;
                }
            }
            // 语义对齐 SQL（MINOR-3）：**先按 level 集合过滤版本行**（at-least），
            // 再取每策略最新 published 版本；而非先取最新再过滤。
            let latest = versions
                .values()
                .filter(|v| v.strategy_id == s.id && v.status == StrategyStatus::Published)
                .filter(|v| level.is_none_or(|req| v.approval_level.satisfies(&req)))
                .max_by_key(|v| v.version);
            if let Some(v) = latest {
                out.push(CatalogEntry { strategy: s.clone(), version: v.clone() });
            }
        }
        out.sort_by(|a, b| a.strategy.id.cmp(&b.strategy.id));
        Ok(out)
    }

    async fn create_version(&self, v: &NewStrategyVersion) -> anyhow::Result<StrategyVersionRow> {
        let row = StrategyVersionRow {
            id: v.id.clone(),
            strategy_id: v.strategy_id.clone(),
            version: v.version,
            code: v.code.clone(),
            params_schema: v.params_schema.clone(),
            sha256: v.sha256.clone(),
            status: StrategyStatus::Draft,
            approval_level: ApprovalLevel::BacktestOk,
            created_at: fixed_now(),
            published_at: None,
        };
        self.versions.lock().unwrap().insert(row.id.clone(), row.clone());
        if let Some(s) = self.strategies.lock().unwrap().get_mut(&v.strategy_id) {
            self.bump_updated(s);
        }
        Ok(row)
    }

    async fn get_version(&self, id: &str) -> anyhow::Result<Option<StrategyVersionRow>> {
        Ok(self.versions.lock().unwrap().get(id).cloned())
    }

    async fn find_version_by_name_sha(
        &self,
        name: &str,
        sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        let strategies = self.strategies.lock().unwrap();
        let versions = self.versions.lock().unwrap();
        Ok(versions.values().find(|v| {
            v.sha256 == sha256
                && strategies.get(&v.strategy_id).is_some_and(|s| s.name == name)
        }).cloned())
    }

    async fn list_versions(&self, strategy_id: &str) -> anyhow::Result<Vec<StrategyVersionRow>> {
        let mut vs: Vec<_> = self
            .versions
            .lock()
            .unwrap()
            .values()
            .filter(|v| v.strategy_id == strategy_id)
            .cloned()
            .collect();
        vs.sort_by_key(|v| v.version);
        Ok(vs)
    }

    async fn next_version_number(&self, strategy_id: &str) -> anyhow::Result<i32> {
        let max = self
            .versions
            .lock()
            .unwrap()
            .values()
            .filter(|v| v.strategy_id == strategy_id)
            .map(|v| v.version)
            .max()
            .unwrap_or(0);
        Ok(max + 1)
    }

    async fn update_draft(
        &self,
        id: &str,
        code: &str,
        params_schema: &serde_json::Value,
        sha256: &str,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        let mut versions = self.versions.lock().unwrap();
        let Some(v) = versions.get_mut(id) else { return Ok(None) };
        if v.status != StrategyStatus::Draft {
            return Ok(None);
        }
        v.code = code.to_string();
        v.params_schema = params_schema.clone();
        v.sha256 = sha256.to_string();
        let strategy_id = v.strategy_id.clone();
        let out = v.clone();
        drop(versions);
        // NIT-1：draft 原地更新同样推进 strategy.updated_at（与 create_version 对齐）。
        if let Some(s) = self.strategies.lock().unwrap().get_mut(&strategy_id) {
            self.bump_updated(s);
        }
        Ok(Some(out))
    }

    async fn mark_published(
        &self,
        id: &str,
        expected_code: &str,
        sha256: &str,
        params_schema: &serde_json::Value,
        published_at: DateTime<Utc>,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        let mut versions = self.versions.lock().unwrap();
        // 竞态注入：模拟并发请求在乐观条件检查前改写了行
        if let Some(code) = self.race_inject_code.lock().unwrap().take() {
            if let Some(v) = versions.get_mut(id) { v.code = code; }
        }
        if let Some(st) = self.race_inject_status.lock().unwrap().take() {
            if let Some(v) = versions.get_mut(id) { v.status = st; }
        }
        let Some(v) = versions.get_mut(id) else { return Ok(None) };
        // 乐观条件（MAJOR-2 TOCTOU 防护）：仅当行仍为 draft 且 code 未被并发改写才定格。
        if v.status != StrategyStatus::Draft || v.code != expected_code {
            return Ok(None);
        }
        v.status = StrategyStatus::Published;
        v.sha256 = sha256.to_string();
        v.params_schema = params_schema.clone();
        v.published_at = Some(published_at);
        Ok(Some(v.clone()))
    }

    async fn set_status(
        &self,
        id: &str,
        status: StrategyStatus,
    ) -> anyhow::Result<Option<StrategyVersionRow>> {
        let mut versions = self.versions.lock().unwrap();
        let Some(v) = versions.get_mut(id) else { return Ok(None) };
        v.status = status;
        Ok(Some(v.clone()))
    }

    // P2b：manage_list——语义对齐 SQL（全部策略含仅 draft/零版本；latest_version=版本号最大
    // 任意状态；latest_published=最新 published）。
    async fn manage_list(
        &self,
        kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<StrategyManageItem>> {
        let strategies = self.strategies.lock().unwrap();
        let versions = self.versions.lock().unwrap();
        let mut out = Vec::new();
        for s in strategies.values() {
            if let Some(k) = kind {
                if s.kind != k {
                    continue;
                }
            }
            let mine: Vec<_> =
                versions.values().filter(|v| v.strategy_id == s.id).collect();
            let latest_version = mine.iter().max_by_key(|v| v.version).map(|v| {
                StrategyManageVersionSummary {
                    id: v.id.clone(),
                    version: v.version,
                    status: v.status,
                    approval_level: v.approval_level,
                    sha256: v.sha256.clone(),
                    created_at: v.created_at,
                    published_at: v.published_at,
                }
            });
            let latest_published = mine
                .iter()
                .filter(|v| v.status == StrategyStatus::Published)
                .max_by_key(|v| v.version)
                .map(|v| StrategyManagePublishedSummary {
                    id: v.id.clone(),
                    version: v.version,
                    approval_level: v.approval_level,
                });
            out.push(StrategyManageItem {
                id: s.id.clone(),
                name: s.name.clone(),
                description: s.description.clone(),
                kind: s.kind,
                created_by: s.created_by.clone(),
                created_at: s.created_at,
                updated_at: s.updated_at,
                version_count: mine.len() as i64,
                latest_version,
                latest_published,
                // 裁决 2026-09-10：全部版本 draft 或无版本才可删（与 SQL NOT EXISTS 同语义）。
                deletable: !mine.iter().any(|v| v.status != StrategyStatus::Draft),
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    // P2b：update_meta——最终值落库 + updated_at 推进；未知 id → None。
    async fn update_meta(
        &self,
        id: &str,
        name: &str,
        description: &str,
    ) -> anyhow::Result<Option<StrategyRow>> {
        let mut strategies = self.strategies.lock().unwrap();
        let Some(s) = strategies.get_mut(id) else { return Ok(None) };
        s.name = name.to_string();
        s.description = description.to_string();
        self.bump_updated(s);
        Ok(Some(s.clone()))
    }

    // 策略删除（裁决 2026-09-10）：与 SQL 单语句同语义——存在非 draft 版本 → 0 行；
    // 否则删除策略 + 级联 draft 版本（锁内原子，等价单语句防竞态）。
    async fn delete_strategy(&self, id: &str) -> anyhow::Result<u64> {
        let mut strategies = self.strategies.lock().unwrap();
        let mut versions = self.versions.lock().unwrap();
        if versions
            .values()
            .any(|v| v.strategy_id == id && v.status != StrategyStatus::Draft)
        {
            return Ok(0);
        }
        if strategies.remove(id).is_none() {
            return Ok(0);
        }
        versions.retain(|_, v| v.strategy_id != id);
        Ok(1)
    }
}

fn service(bars: Vec<domain::types::Bar>) -> (StrategyService, Arc<MockStore>) {
    let store = Arc::new(MockStore::default());
    let svc = StrategyService::new(
        store.clone(),
        Arc::new(MockBars(bars)),
        Arc::new(FixedClock),
    );
    (svc, store)
}

fn input(name: &str, code: &str) -> CreateStrategyInput {
    CreateStrategyInput {
        name: name.into(),
        description: "desc".into(),
        kind: StrategyKind::Strategy,
        code: code.into(),
    }
}

async fn create_published(svc: &StrategyService, name: &str, code: &str) -> (StrategyRow, StrategyVersionRow) {
    let (s, v) = svc.create_strategy(&input(name, code)).await.unwrap();
    let v = svc.publish(&v.id).await.unwrap();
    (s, v)
}

// ── Registry CRUD / 状态机 ──

#[tokio::test]
async fn create_strategy_makes_v1_draft_with_sha_and_schema() {
    let (svc, _) = service(vec![]);
    let (s, v) = svc.create_strategy(&input("s1", CONST_SCORE)).await.unwrap();
    assert!(s.id.starts_with("st_"));
    assert!(v.id.starts_with("sv_"));
    assert_eq!(v.version, 1);
    assert_eq!(v.status, StrategyStatus::Draft);
    assert_eq!(v.approval_level, ApprovalLevel::BacktestOk);
    assert_eq!(v.sha256, sha256_hex(CONST_SCORE));
    // schema 提取成功（PARAMS_SCHEMA 一项）
    let schema = v.params_schema.as_array().unwrap();
    assert_eq!(schema.len(), 1);
    assert_eq!(schema[0]["key"], "score");
}

#[tokio::test]
async fn create_rejects_empty_name_or_code() {
    let (svc, _) = service(vec![]);
    let e = svc.create_strategy(&input("  ", CONST_SCORE)).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyValidation>().is_some());
    let e = svc.create_strategy(&input("s", "  ")).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyValidation>().is_some());
}

#[tokio::test]
async fn publish_gate_rejects_bad_code() {
    let (svc, _) = service(vec![]);
    // 无 on_bar → 门禁拒绝（400 语义），版本保持 draft
    let (_, v) = svc.create_strategy(&input("bad1", NO_ON_BAR)).await.unwrap();
    let e = svc.publish(&v.id).await.unwrap_err();
    let ve = e.downcast_ref::<StrategyValidation>().expect("应为校验失败");
    assert!(ve.0.contains("发布门禁"), "{}", ve.0);
    assert_eq!(svc.get_version(&v.id).await.unwrap().status, StrategyStatus::Draft);

    // 语法错误 → 同样拒绝
    let (_, v2) = svc.create_strategy(&input("bad2", SYNTAX_ERR)).await.unwrap();
    assert!(svc.publish(&v2.id).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
}

#[tokio::test]
async fn publish_happy_sets_status_published_at_and_stable_sha() {
    let (svc, _) = service(vec![]);
    let (_, v1) = create_published(&svc, "p1", CONST_SCORE).await;
    assert_eq!(v1.status, StrategyStatus::Published);
    assert_eq!(v1.published_at, Some(fixed_now()));
    assert_eq!(v1.sha256, sha256_hex(CONST_SCORE), "sha256 稳定（同代码同哈希）");
    // 同代码另建策略发布 → 同 sha（内容寻址）
    let (_, v2) = create_published(&svc, "p2", CONST_SCORE).await;
    assert_eq!(v1.sha256, v2.sha256);
}

#[tokio::test]
async fn publish_non_draft_is_invalid_transition() {
    let (svc, _) = service(vec![]);
    let (_, v) = create_published(&svc, "pp", CONST_SCORE).await;
    let e = svc.publish(&v.id).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyInvalidTransition>().is_some(), "published 再 publish → 409");
}

// MAJOR-2：publish TOCTOU——读 code → 并发改 draft → publish 应 409 且版本保持 draft。
#[tokio::test]
async fn publish_conflict_when_code_changed_concurrently() {
    let (svc, store) = service(vec![]);
    let (_, v) = svc.create_strategy(&input("toctou1", CONST_SCORE)).await.unwrap();
    // 模拟竞态：publish 读出 code 后、mark_published 落库前，并发请求改写了 draft 代码
    *store.race_inject_code.lock().unwrap() = Some(TREND.to_string());
    let e = svc.publish(&v.id).await.unwrap_err();
    assert!(
        e.downcast_ref::<StrategyInvalidTransition>().is_some(),
        "code 被并发改写 → 409，got {e:?}"
    );
    let after = svc.get_version(&v.id).await.unwrap();
    assert_eq!(after.status, StrategyStatus::Draft, "冲突后版本保持 draft");
    assert_eq!(after.code, TREND, "并发写入的 code 不被冒烟过的旧 code 覆盖");
}

// MAJOR-2/NIT-2：publish TOCTOU——并发抢先发布（status 已非 draft）→ 409。
#[tokio::test]
async fn publish_conflict_when_status_changed_concurrently() {
    let (svc, store) = service(vec![]);
    let (_, v) = svc.create_strategy(&input("toctou2", CONST_SCORE)).await.unwrap();
    // 模拟竞态：mark_published 落库前，并发请求抢先完成发布
    *store.race_inject_status.lock().unwrap() = Some(StrategyStatus::Published);
    let e = svc.publish(&v.id).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyInvalidTransition>().is_some(), "status 漂移 → 409");
    assert_eq!(svc.get_version(&v.id).await.unwrap().status, StrategyStatus::Published);
}

// NIT-1：update_draft 推进 strategy.updated_at（与 create_version 对齐）。
#[tokio::test]
async fn update_draft_advances_strategy_updated_at() {
    let (svc, _) = service(vec![]);
    let (s, v) = svc.create_strategy(&input("upd-ts", CONST_SCORE)).await.unwrap();
    let before = svc.get_strategy(&s.id).await.unwrap().updated_at;
    svc.update_draft(&v.id, TREND).await.unwrap();
    let after = svc.get_strategy(&s.id).await.unwrap().updated_at;
    assert!(after > before, "update_draft 应推进 updated_at（{before} → {after}）");
}

// MINOR-3：catalog 先按 level 集合过滤版本行、再取每策略最新 published。
// 形态：v1 published(sim_ok) → v2 published(backtest_ok)；查 level=sim_ok 应返回 v1 条目。
#[tokio::test]
async fn catalog_filters_level_set_before_latest_published() {
    let (svc, store) = service(vec![]);
    let (s, v1) = create_published(&svc, "lvl-form", CONST_SCORE).await;
    store.set_status_level_for_test(&s.id); // v1 直升 sim_ok
    // 编辑 published v1 → 自动新 draft v2 → 发布（backtest_ok）
    let UpdateDraftOutcome::NewDraft(v2) = svc.update_draft(&v1.id, TREND).await.unwrap() else {
        panic!("published 编辑应自动落新 draft")
    };
    let v2 = svc.publish(&v2.id).await.unwrap();
    assert_eq!(v2.approval_level, ApprovalLevel::BacktestOk);

    // level=sim_ok：v2(backtest_ok) 不满足集合 → 取满足集合的最新 published = v1
    let sim = svc.catalog(Some(ApprovalLevel::SimOk), None).await.unwrap();
    assert_eq!(sim.len(), 1, "level 集合先过滤版本行，v1(sim_ok) 应入册");
    assert_eq!(sim[0].version.version, 1);
    assert_eq!(sim[0].version.approval_level, ApprovalLevel::SimOk);
    // 无过滤：取每策略最新 published = v2
    let all = svc.catalog(None, None).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].version.version, 2);
}

#[tokio::test]
async fn update_draft_edits_in_place_when_draft() {
    let (svc, _) = service(vec![]);
    let (_, v) = svc.create_strategy(&input("u1", CONST_SCORE)).await.unwrap();
    let out = svc.update_draft(&v.id, TREND).await.unwrap();
    let UpdateDraftOutcome::Updated(row) = out else { panic!("draft 应原地更新") };
    assert_eq!(row.id, v.id);
    assert_eq!(row.version, 1);
    assert_eq!(row.code, TREND);
    assert_eq!(row.sha256, sha256_hex(TREND));
    assert_eq!(svc.list_versions(&row.strategy_id).await.unwrap().len(), 1);
}

#[tokio::test]
async fn update_draft_on_published_auto_creates_new_draft() {
    let (svc, _) = service(vec![]);
    let (s, v) = create_published(&svc, "u2", CONST_SCORE).await;
    let out = svc.update_draft(&v.id, TREND).await.unwrap();
    let UpdateDraftOutcome::NewDraft(draft) = out else { panic!("published 编辑应自动落新 draft") };
    assert_eq!(draft.version, 2);
    assert_eq!(draft.status, StrategyStatus::Draft);
    assert_eq!(draft.code, TREND);
    assert_eq!(draft.strategy_id, s.id);
    // 原 published 版本不可变
    let orig = svc.get_version(&v.id).await.unwrap();
    assert_eq!(orig.code, CONST_SCORE);
    assert_eq!(orig.status, StrategyStatus::Published);
    assert_eq!(svc.list_versions(&s.id).await.unwrap().len(), 2);
}

#[tokio::test]
async fn update_draft_on_archived_is_conflict() {
    let (svc, _) = service(vec![]);
    let (_, v) = create_published(&svc, "u3", CONST_SCORE).await;
    svc.archive(&v.id).await.unwrap();
    let e = svc.update_draft(&v.id, TREND).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyInvalidTransition>().is_some());
}

#[tokio::test]
async fn archive_transition_rules() {
    let (svc, _) = service(vec![]);
    let (_, draft) = svc.create_strategy(&input("a1", CONST_SCORE)).await.unwrap();
    // draft → archived 非法
    assert!(svc.archive(&draft.id).await.unwrap_err().downcast_ref::<StrategyInvalidTransition>().is_some());
    // published → archived 合法
    svc.publish(&draft.id).await.unwrap();
    let archived = svc.archive(&draft.id).await.unwrap();
    assert_eq!(archived.status, StrategyStatus::Archived);
    // archived → archived 非法（同态自转）
    assert!(svc.archive(&draft.id).await.unwrap_err().downcast_ref::<StrategyInvalidTransition>().is_some());
}

#[tokio::test]
async fn not_found_semantics() {
    let (svc, _) = service(vec![]);
    assert!(svc.get_strategy("st_none").await.unwrap_err().downcast_ref::<StrategyNotFound>().is_some());
    assert!(svc.get_version("sv_none").await.unwrap_err().downcast_ref::<StrategyNotFound>().is_some());
    assert!(svc.publish("sv_none").await.unwrap_err().downcast_ref::<StrategyNotFound>().is_some());
    assert!(svc.archive("sv_none").await.unwrap_err().downcast_ref::<StrategyNotFound>().is_some());
    assert!(svc.list_versions("st_none").await.unwrap_err().downcast_ref::<StrategyNotFound>().is_some());
    assert!(svc.diff("sv_none", "sv_none2").await.unwrap_err().downcast_ref::<StrategyNotFound>().is_some());
}

#[tokio::test]
async fn create_draft_from_inherits_code_and_bumps_version() {
    let (svc, _) = service(vec![]);
    let (s, v) = create_published(&svc, "d1", CONST_SCORE).await;
    let draft = svc.create_draft_from(&s.id, &v.id).await.unwrap();
    assert_eq!(draft.version, 2);
    assert_eq!(draft.status, StrategyStatus::Draft);
    assert_eq!(draft.code, CONST_SCORE);
    // 版本不属该策略 → 400
    let (s2, _) = create_published(&svc, "d2", TREND).await;
    let e = svc.create_draft_from(&s2.id, &v.id).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyValidation>().is_some());
}

#[tokio::test]
async fn diff_returns_both_versions() {
    let (svc, _) = service(vec![]);
    let (_, v1) = create_published(&svc, "df", CONST_SCORE).await;
    let UpdateDraftOutcome::NewDraft(v2) = svc.update_draft(&v1.id, TREND).await.unwrap() else {
        panic!("应自动新 draft")
    };
    let (from, to) = svc.diff(&v1.id, &v2.id).await.unwrap();
    assert_eq!(from.code, CONST_SCORE);
    assert_eq!(to.code, TREND);
}

#[tokio::test]
async fn catalog_only_published_with_level_filter() {
    let (svc, store) = service(vec![]);
    let (s1, _) = create_published(&svc, "c1", CONST_SCORE).await;
    // 仅 draft 的策略不入册
    svc.create_strategy(&input("c2", TREND)).await.unwrap();

    let all = svc.catalog(None, None).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].strategy.id, s1.id);
    assert_eq!(all[0].version.status, StrategyStatus::Published);

    // level at-least：live_approved 过滤 → 空；backtest_ok → 全集
    assert!(svc.catalog(Some(ApprovalLevel::LiveApproved), None).await.unwrap().is_empty());
    assert_eq!(svc.catalog(Some(ApprovalLevel::BacktestOk), None).await.unwrap().len(), 1);
    // sim_ok 版本满足 sim_ok 过滤（mock 直改级别模拟升级动作）
    store.set_status_level_for_test(&s1.id);
    let sim_up = svc.catalog(Some(ApprovalLevel::SimOk), None).await.unwrap();
    assert_eq!(sim_up.len(), 1);
    // kind 过滤
    assert_eq!(svc.catalog(None, Some(StrategyKind::Template)).await.unwrap().len(), 0);
    assert_eq!(svc.catalog(None, Some(StrategyKind::Strategy)).await.unwrap().len(), 1);
}

// ── P2b：manage_list / update_meta ──

#[tokio::test]
async fn manage_list_includes_draft_only_with_aggregates() {
    let (svc, _) = service(vec![]);
    // 仅 draft 策略（latest_published 应为 None）
    let (s_draft, _) = svc.create_strategy(&input("mg-draft", CONST_SCORE)).await.unwrap();
    // published v1 + 自动新 draft v2（latest_version=v2 draft / latest_published=v1）
    let (s_pub, v1) = create_published(&svc, "mg-pub", CONST_SCORE).await;
    let UpdateDraftOutcome::NewDraft(_) = svc.update_draft(&v1.id, TREND).await.unwrap() else {
        panic!("published 编辑应自动落新 draft")
    };

    let items = svc.manage_list(None).await.unwrap();
    assert_eq!(items.len(), 2, "含仅 draft 策略");
    let e_draft = items.iter().find(|e| e.id == s_draft.id).unwrap();
    assert_eq!(e_draft.version_count, 1);
    assert_eq!(e_draft.latest_version.as_ref().unwrap().version, 1);
    assert_eq!(e_draft.latest_version.as_ref().unwrap().status, StrategyStatus::Draft);
    assert!(e_draft.latest_published.is_none());

    let e_pub = items.iter().find(|e| e.id == s_pub.id).unwrap();
    assert_eq!(e_pub.version_count, 2);
    assert_eq!(e_pub.latest_version.as_ref().unwrap().version, 2);
    assert_eq!(e_pub.latest_version.as_ref().unwrap().status, StrategyStatus::Draft);
    let lp = e_pub.latest_published.as_ref().unwrap();
    assert_eq!(lp.version, 1);
    assert_eq!(lp.approval_level, ApprovalLevel::BacktestOk);

    // kind 过滤
    assert!(svc.manage_list(Some(StrategyKind::Template)).await.unwrap().is_empty());
    assert_eq!(svc.manage_list(Some(StrategyKind::Strategy)).await.unwrap().len(), 2);
}

#[tokio::test]
async fn update_meta_validation_400_and_404() {
    let (svc, _) = service(vec![]);
    let (s, _) = svc.create_strategy(&input("meta", CONST_SCORE)).await.unwrap();
    // name/description 均空 → 400
    let e = svc.update_meta(&s.id, None, None).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyValidation>().is_some(), "均空应 400");
    // name trim 后为空 → 400
    let e = svc.update_meta(&s.id, Some("   "), None).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyValidation>().is_some(), "空白 name 应 400");
    // 未知 id → 404
    let e = svc.update_meta("st_none", Some("x"), None).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyNotFound>().is_some(), "未知 id 应 404");
}

#[tokio::test]
async fn update_meta_happy_trims_name_and_keeps_missing_fields() {
    let (svc, _) = service(vec![]);
    let (s, _) = svc.create_strategy(&input("meta-old", CONST_SCORE)).await.unwrap();
    // 仅改 name（trim 后落库）；description 保持原值
    let row = svc.update_meta(&s.id, Some("  meta-new  "), None).await.unwrap();
    assert_eq!(row.name, "meta-new");
    assert_eq!(row.description, "desc", "未给 description 应保持");
    assert!(row.updated_at > s.updated_at, "update_meta 应推进 updated_at");
    // 仅改 description；name 保持
    let row2 = svc.update_meta(&s.id, None, Some("desc-new")).await.unwrap();
    assert_eq!(row2.name, "meta-new", "未给 name 应保持");
    assert_eq!(row2.description, "desc-new");
    // 读回一致
    let got = svc.get_strategy(&s.id).await.unwrap();
    assert_eq!(got.name, "meta-new");
    assert_eq!(got.description, "desc-new");
}

// ── 播种 ──

#[tokio::test]
async fn seed_reference_plugins_seeds_11_and_is_idempotent() {
    let (svc, _) = service(vec![]);
    let report = svc.seed_reference_plugins().await.unwrap();
    assert_eq!(report.seeded, 11, "7 参考插件 + 4 官方模板");
    assert_eq!(report.skipped, 0);

    let strategies = svc.catalog(None, None).await.unwrap();
    assert_eq!(strategies.len(), 11);
    let n_strategy = strategies.iter().filter(|e| e.strategy.kind == StrategyKind::Strategy).count();
    let n_template = strategies.iter().filter(|e| e.strategy.kind == StrategyKind::Template).count();
    assert_eq!((n_strategy, n_template), (7, 4));
    for e in &strategies {
        assert_eq!(e.version.status, StrategyStatus::Published);
        assert_eq!(e.version.version, 1);
        assert_eq!(e.version.sha256, sha256_hex(&e.version.code), "sha256=内容哈希");
        assert!(e.version.published_at.is_some());
        assert!(e.version.params_schema.as_array().is_some_and(|a| !a.is_empty()),
            "{} 应有 PARAMS_SCHEMA", e.strategy.name);
    }
    // 幂等：表非空 → 整体跳过
    let again = svc.seed_reference_plugins().await.unwrap();
    assert_eq!((again.seeded, again.skipped), (0, 0));
    assert_eq!(svc.catalog(None, None).await.unwrap().len(), 11);
}

// ── test_run ──

fn test_req(source: TestRunSource, mode: TestRunMode, from: DateTime<Utc>, to: DateTime<Utc>) -> TestRunRequest {
    TestRunRequest {
        source,
        params: serde_json::json!({}),
        symbol: "600000".into(),
        period: "D1".into(),
        from,
        to,
        mode,
    }
}

fn span(days: i64) -> (DateTime<Utc>, DateTime<Utc>) {
    let from = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
    (from, from + Duration::days(days))
}

#[tokio::test]
async fn test_run_pure_score_inline_code() {
    let (svc, _) = service(trend_bars());
    let (from, to) = span(30);
    let mut req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, from, to);
    req.params = serde_json::json!({"score": 66});
    let resp = svc.test_run(&req).await.unwrap();
    assert_eq!(resp.bar_count, 6);
    assert_eq!(resp.scores.len(), 6);
    assert!(resp.scores.iter().all(|p| p.score == Some(66.0)));
    assert!(resp.signals.is_empty());
    assert_eq!(resp.trades, serde_json::json!([]));
    assert!(!resp.truncated.scores && !resp.truncated.events);
}

#[tokio::test]
async fn test_run_pure_score_defaults_fill_and_neutral_on_error() {
    let (svc, _) = service(trend_bars());
    let (from, to) = span(30);
    // 缺省填充：params={} → score=80（schema 默认值）
    let req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, from, to);
    let resp = svc.test_run(&req).await.unwrap();
    assert!(resp.scores.iter().all(|p| p.score == Some(80.0)));

    // thrower：错误 bar 中立分 50 + 错误事件；连续 10 次熔断 → 之后 score=None
    let bars: Vec<_> = (0..12).map(|i| dbar(i, 100.0)).collect();
    let (svc2, _) = service(bars);
    let req2 = test_req(TestRunSource::Inline(THROWER.into()), TestRunMode::PureScore, from, to);
    let resp2 = svc2.test_run(&req2).await.unwrap();
    assert_eq!(resp2.scores.len(), 12);
    assert!(resp2.scores[..10].iter().all(|p| p.score == Some(50.0)));
    assert!(resp2.scores[10..].iter().all(|p| p.score.is_none()), "熔断后 score=None");
    let errors = resp2.events.iter().filter(|e| e.kind == "plugin_error").count();
    let breakers = resp2.events.iter().filter(|e| e.kind == "circuit_breaker").count();
    assert_eq!((errors, breakers), (10, 1));
}

#[tokio::test]
async fn test_run_sim_position_produces_signals_and_trade() {
    let (svc, _) = service(trend_bars());
    let (from, to) = span(30);
    let req = test_req(TestRunSource::Inline(TREND.into()), TestRunMode::SimPosition, from, to);
    let resp = svc.test_run(&req).await.unwrap();
    assert_eq!(resp.scores.len(), 6);
    assert_eq!(resp.signals.len(), 6);
    assert_eq!(resp.signals[2].signal, "buy", "close 110 > 105 → 90 分 ≥ 60 → buy");
    assert_eq!(resp.signals[4].signal, "sell");
    let trades = resp.trades.as_array().unwrap();
    assert_eq!(trades.len(), 1, "一买一卖合成一笔交易");
}

#[tokio::test]
async fn test_run_interval_limits() {
    let (svc, _) = service(trend_bars());
    // D1 超过 5 年 → 400
    let (from, to) = span(366 * 5 + 10);
    let req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, from, to);
    let e = svc.test_run(&req).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyValidation>().unwrap().0.contains("区间超限"));
    // M1 超过 3 个月 → 400
    let (from, to) = span(100);
    let mut req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, from, to);
    req.period = "M1".into();
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
    // 非法周期 → 400
    let (from, to) = span(10);
    let mut req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, from, to);
    req.period = "W1".into();
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
}

#[tokio::test]
async fn test_run_param_validation() {
    let (svc, _) = service(trend_bars());
    let (from, to) = span(30);
    // 未知参数键 → 400
    let mut req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, from, to);
    req.params = serde_json::json!({"unknown": 1});
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
    // 越界（max=100）→ 400
    req.params = serde_json::json!({"score": 120});
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
    // 非数值 → 400
    req.params = serde_json::json!({"score": "high"});
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
}

#[tokio::test]
async fn test_run_version_source_and_bad_inputs() {
    let (svc, _) = service(trend_bars());
    let (from, to) = span(30);
    // version 源：draft 版本亦可试算（冒烟兜底）
    let (_, v) = svc.create_strategy(&input("tr", CONST_SCORE)).await.unwrap();
    let req = test_req(TestRunSource::VersionId(v.id.clone()), TestRunMode::PureScore, from, to);
    let resp = svc.test_run(&req).await.unwrap();
    assert_eq!(resp.scores.len(), 6);
    // 未知版本 → 404
    let req = test_req(TestRunSource::VersionId("sv_none".into()), TestRunMode::PureScore, from, to);
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyNotFound>().is_some());
    // 坏代码（内联）→ 400（冒烟前置拒绝）
    let req = test_req(TestRunSource::Inline(NO_ON_BAR.into()), TestRunMode::PureScore, from, to);
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
    // 空区间数据 → 400
    let (svc_empty, _) = service(vec![]);
    let req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, from, to);
    let e = svc_empty.test_run(&req).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyValidation>().unwrap().0.contains("无 K 线数据"));
    // from >= to → 400
    let req = test_req(TestRunSource::Inline(CONST_SCORE.into()), TestRunMode::PureScore, to, from);
    assert!(svc.test_run(&req).await.unwrap_err().downcast_ref::<StrategyValidation>().is_some());
}

#[tokio::test]
async fn test_run_events_truncation_cap() {
    // 每 bar 一条日志，bar 数 > MAX_EVENTS → events 截断并标记。
    let bars: Vec<_> = (0..(MAX_EVENTS + 50) as i64).map(|i| dbar(i, 100.0)).collect();
    let (svc, _) = service(bars);
    let (from, to) = span(366 * 5); // D1 上限内
    let req = test_req(TestRunSource::Inline(LOGGER.into()), TestRunMode::PureScore, from, to);
    let resp = svc.test_run(&req).await.unwrap();
    assert_eq!(resp.events.len(), MAX_EVENTS);
    assert!(resp.truncated.events);
    assert_eq!(resp.scores.len(), MAX_EVENTS + 50);
}

// ── 策略删除（裁决 2026-09-10）：仅全 draft / 零版本可删；404/409 区分 ──

#[tokio::test]
async fn delete_strategy_all_draft_ok_and_cascades() {
    let (svc, store) = service(vec![]);
    let (s, _v1) = svc.create_strategy(&input("del-draft", CONST_SCORE)).await.unwrap();
    let v2 = svc.create_draft_from(&s.id, &svc.list_versions(&s.id).await.unwrap()[0].id)
        .await.unwrap();
    assert_eq!(v2.version, 2);
    // manage_list deletable=true（全 draft）
    let items = svc.manage_list(None).await.unwrap();
    assert!(items.iter().find(|e| e.id == s.id).unwrap().deletable, "全 draft → deletable");

    svc.delete_strategy(&s.id).await.unwrap();
    assert!(store.get_strategy(&s.id).await.unwrap().is_none(), "策略行已删");
    assert!(store.list_versions(&s.id).await.unwrap().is_empty(), "draft 版本级联清除");
}

#[tokio::test]
async fn delete_strategy_with_published_is_409() {
    let (svc, _) = service(vec![]);
    let (s, _v) = create_published(&svc, "del-pub", CONST_SCORE).await;
    let items = svc.manage_list(None).await.unwrap();
    assert!(!items.iter().find(|e| e.id == s.id).unwrap().deletable, "含 published → !deletable");

    let e = svc.delete_strategy(&s.id).await.unwrap_err();
    let c = e.downcast_ref::<StrategyInvalidTransition>().expect("409 语义");
    assert!(c.0.contains("含已发布版本的策略不可删除，请归档"), "409 文案：{}", c.0);
    // 策略仍在
    assert!(svc.get_strategy(&s.id).await.is_ok());
}

#[tokio::test]
async fn delete_strategy_with_archived_history_is_409() {
    let (svc, _) = service(vec![]);
    let (s, v) = create_published(&svc, "del-arch", CONST_SCORE).await;
    svc.archive(&v.id).await.unwrap();
    let items = svc.manage_list(None).await.unwrap();
    assert!(!items.iter().find(|e| e.id == s.id).unwrap().deletable,
        "published→archived 历史 → !deletable");

    let e = svc.delete_strategy(&s.id).await.unwrap_err();
    assert!(e.downcast_ref::<StrategyInvalidTransition>().is_some(), "archived 历史同样 409");
    assert!(svc.get_strategy(&s.id).await.is_ok());
}

#[tokio::test]
async fn delete_strategy_unknown_id_is_404() {
    let (svc, _) = service(vec![]);
    let e = svc.delete_strategy("st_none").await.unwrap_err();
    assert!(e.downcast_ref::<StrategyNotFound>().is_some(), "未知 id → 404");
}

#[tokio::test]
async fn delete_strategy_zero_version_ok() {
    let (svc, store) = service(vec![]);
    // 零版本策略：直接走 store 建行（service create_strategy 恒带 v1）
    store
        .create_strategy(&NewStrategy {
            id: "st_zero".into(),
            name: "zero".into(),
            description: String::new(),
            kind: StrategyKind::Strategy,
            created_by: "test".into(),
        })
        .await
        .unwrap();
    let items = svc.manage_list(None).await.unwrap();
    assert!(items.iter().find(|e| e.id == "st_zero").unwrap().deletable, "零版本 → deletable");
    svc.delete_strategy("st_zero").await.unwrap();
    assert!(store.get_strategy("st_zero").await.unwrap().is_none());
}
