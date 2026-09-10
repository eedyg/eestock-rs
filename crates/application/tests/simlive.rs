//! 应用层 SimLiveService 集成测试（**mock 端口**，确定性、无实时 DB）。
//! 全部输入为手工固定数据 + 固定时钟，无 RNG / 无时间依赖 / 无实时行情，任意次运行一致。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use domain::ports::{
    BacktestBarRead, CatalogEntry, Clock, KlineBarView, KlineRead, NewSimSession, NewSimTrade,
    NewStrategy, NewStrategyPreset, NewStrategyRun, NewStrategyVersion, SimPositionRow,
    SimSessionResult, SimSessionState, SimSessionStatus, SimSessionStore, SimSessionView,
    StrategyManageItem, StrategyPresetRow, StrategyPresetStore, StrategyRow, StrategyRunFilter,
    StrategyRunResult, StrategyRunStatus, StrategyRunStore, StrategyRunView, StrategyStore,
    StrategyVersionRow, SymbolLatestView, SymbolRegistry,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use domain::types::Period;

use application::simlive::{
    InvalidConfig, PlaceOrderReq, SimLiveService, StartSessionReq, StrategyConfigInput,
};
use application::simlive_feed::SimLiveFeed;
use application::workbench::WorkbenchService;
use backtest::Bar;

/// 固定时钟（确定性；11-sim-live 会话/成交 ts 全部来自此）。
struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()
}

/// mock SimSessionStore：记录调用 + 提供会话读模型；mark_end 按状态机转移。
#[derive(Default)]
struct MockSimStore {
    created: Mutex<Vec<NewSimSession>>,
    trades: Mutex<Vec<NewSimTrade>>,
    pos_updates: Mutex<Vec<(String, Vec<SimPositionRow>)>>,
    ended: Mutex<Vec<(String, SimSessionResult)>>,
    sessions: Mutex<HashMap<String, SimSessionView>>,
    results: Mutex<HashMap<String, SimSessionResult>>,
    states: Mutex<HashMap<String, SimSessionState>>,
}

#[async_trait]
impl SimSessionStore for MockSimStore {
    async fn create_session(&self, s: &NewSimSession) -> Result<()> {
        self.created.lock().unwrap().push(s.clone());
        self.sessions.lock().unwrap().insert(
            s.id.clone(),
            SimSessionView {
                id: s.id.clone(),
                name: s.name.clone(),
                cash_init: s.cash_init,
                strategy_set: s.strategy_set.clone(),
                stock_set: s.stock_set.clone(),
                period: s.period.clone(),
                start_ts: s.start_ts,
                end_ts: None,
                status: SimSessionStatus::Running,
                source: s.source.clone(),
            },
        );
        Ok(())
    }
    async fn get_session(&self, id: &str) -> Result<Option<SimSessionView>> {
        Ok(self.sessions.lock().unwrap().get(id).cloned())
    }
    async fn list_sessions(&self) -> Result<Vec<SimSessionView>> {
        Ok(self.sessions.lock().unwrap().values().cloned().collect())
    }
    async fn append_trade(&self, t: &NewSimTrade) -> Result<()> {
        self.trades.lock().unwrap().push(t.clone());
        Ok(())
    }
    async fn list_trades(&self, session_id: &str) -> Result<Vec<NewSimTrade>> {
        Ok(self
            .trades
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect())
    }
    async fn update_positions(&self, session_id: &str, positions: &[SimPositionRow]) -> Result<()> {
        self.pos_updates
            .lock()
            .unwrap()
            .push((session_id.into(), positions.to_vec()));
        Ok(())
    }
    async fn mark_end(
        &self,
        session_id: &str,
        end_ts: DateTime<Utc>,
        result: &SimSessionResult,
    ) -> Result<bool> {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(v) = sessions.get_mut(session_id) else {
            return Ok(false);
        };
        if v.status != SimSessionStatus::Running {
            return Ok(false);
        }
        v.status = SimSessionStatus::Ended;
        v.end_ts = Some(end_ts);
        self.ended
            .lock()
            .unwrap()
            .push((session_id.into(), result.clone()));
        self.results
            .lock()
            .unwrap()
            .insert(session_id.into(), result.clone());
        Ok(true)
    }
    async fn get_result(&self, session_id: &str) -> Result<Option<SimSessionResult>> {
        Ok(self.results.lock().unwrap().get(session_id).cloned())
    }
    async fn upsert_state(&self, session_id: &str, state: &SimSessionState) -> Result<()> {
        self.states
            .lock()
            .unwrap()
            .insert(session_id.into(), state.clone());
        Ok(())
    }
    async fn get_state(&self, session_id: &str) -> Result<Option<SimSessionState>> {
        Ok(self.states.lock().unwrap().get(session_id).cloned())
    }
    async fn delete_session(&self, session_id: &str) -> Result<bool> {
        Ok(self.sessions.lock().unwrap().remove(session_id).is_some())
    }
}

/// 默认 Registry mock：播种 published 插件策略（id 直用 "dual_ma"/"momentum"，code 为
/// strategy-core 参考插件真身——与 Rust 内建 1:1 迁移，golden bar 序列行为等价，
/// 评分映射 Buy→80/Sell→20/Hold→50）。
fn service(store: Arc<MockSimStore>) -> SimLiveService {
    SimLiveService::new(
        store,
        Arc::new(FixedClock(fixed_now())),
        backtest::FeeModel::default(),
    )
    .with_strategies(default_registry())
}

async fn started(store: Arc<MockSimStore>) -> (SimLiveService, String) {
    let svc = service(store);
    let view = svc
        .start_session(&StartSessionReq {
            name: "t1".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .unwrap();
    (svc, view.id.clone())
}

// ── P4a：策略 Registry mock（StrategyStore 内存实现，与 PgStrategyStore 同语义子集）──

/// 内存 Registry：strategies + versions（published 播种直插）。
#[derive(Default)]
struct MockStrategyStore {
    strategies: Mutex<HashMap<String, StrategyRow>>,
    versions: Mutex<HashMap<String, StrategyVersionRow>>,
}

impl MockStrategyStore {
    /// 播种一个 published 策略（version=1，version_id = "sv_{strategy_id}"）。
    fn seed_published(
        &self,
        strategy_id: &str,
        name: &str,
        code: &str,
        params_schema: serde_json::Value,
    ) {
        let now = fixed_now();
        self.strategies.lock().unwrap().insert(
            strategy_id.to_string(),
            StrategyRow {
                id: strategy_id.to_string(),
                name: name.to_string(),
                description: String::new(),
                kind: StrategyKind::Strategy,
                created_by: "test".into(),
                created_at: now,
                updated_at: now,
            },
        );
        self.versions.lock().unwrap().insert(
            format!("sv_{strategy_id}"),
            StrategyVersionRow {
                id: format!("sv_{strategy_id}"),
                strategy_id: strategy_id.to_string(),
                version: 1,
                code: code.to_string(),
                params_schema,
                sha256: application::strategy::sha256_hex(code),
                status: StrategyStatus::Published,
                approval_level: ApprovalLevel::BacktestOk,
                created_at: now,
                published_at: Some(now),
            },
        );
    }

    /// 把某策略的 published 版本转 archived（恢复失败路径测试用）。
    fn archive_version(&self, version_id: &str) {
        if let Some(v) = self.versions.lock().unwrap().get_mut(version_id) {
            v.status = StrategyStatus::Archived;
        }
    }
}

#[async_trait]
impl StrategyStore for MockStrategyStore {
    async fn create_strategy(&self, s: &NewStrategy) -> Result<StrategyRow> {
        let row = StrategyRow {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            kind: s.kind,
            created_by: s.created_by.clone(),
            created_at: fixed_now(),
            updated_at: fixed_now(),
        };
        self.strategies
            .lock()
            .unwrap()
            .insert(row.id.clone(), row.clone());
        Ok(row)
    }
    async fn get_strategy(&self, id: &str) -> Result<Option<StrategyRow>> {
        Ok(self.strategies.lock().unwrap().get(id).cloned())
    }
    async fn count_strategies(&self) -> Result<i64> {
        Ok(self.strategies.lock().unwrap().len() as i64)
    }
    async fn catalog(
        &self,
        level: Option<ApprovalLevel>,
        kind: Option<StrategyKind>,
    ) -> Result<Vec<CatalogEntry>> {
        let strategies = self.strategies.lock().unwrap();
        let versions = self.versions.lock().unwrap();
        let mut out = Vec::new();
        for st in strategies.values() {
            if let Some(k) = kind {
                if st.kind != k {
                    continue;
                }
            }
            let latest = versions
                .values()
                .filter(|v| v.strategy_id == st.id && v.status == StrategyStatus::Published)
                .filter(|v| level.is_none_or(|req| v.approval_level.satisfies(&req)))
                .max_by_key(|v| v.version);
            if let Some(v) = latest {
                out.push(CatalogEntry {
                    strategy: st.clone(),
                    version: v.clone(),
                });
            }
        }
        out.sort_by(|a, b| a.strategy.id.cmp(&b.strategy.id));
        Ok(out)
    }
    async fn create_version(&self, v: &NewStrategyVersion) -> Result<StrategyVersionRow> {
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
        self.versions
            .lock()
            .unwrap()
            .insert(row.id.clone(), row.clone());
        Ok(row)
    }
    async fn get_version(&self, id: &str) -> Result<Option<StrategyVersionRow>> {
        Ok(self.versions.lock().unwrap().get(id).cloned())
    }
    async fn find_version_by_name_sha(
        &self,
        name: &str,
        sha256: &str,
    ) -> Result<Option<StrategyVersionRow>> {
        let strategies = self.strategies.lock().unwrap();
        let versions = self.versions.lock().unwrap();
        Ok(versions
            .values()
            .find(|v| {
                v.sha256 == sha256
                    && strategies
                        .get(&v.strategy_id)
                        .is_some_and(|s| s.name == name)
            })
            .cloned())
    }
    async fn list_versions(&self, strategy_id: &str) -> Result<Vec<StrategyVersionRow>> {
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
    async fn next_version_number(&self, strategy_id: &str) -> Result<i32> {
        Ok(self
            .versions
            .lock()
            .unwrap()
            .values()
            .filter(|v| v.strategy_id == strategy_id)
            .map(|v| v.version)
            .max()
            .unwrap_or(0)
            + 1)
    }
    async fn update_draft(
        &self,
        _id: &str,
        _code: &str,
        _params_schema: &serde_json::Value,
        _sha256: &str,
    ) -> Result<Option<StrategyVersionRow>> {
        Ok(None)
    }
    async fn mark_published(
        &self,
        _id: &str,
        _expected_code: &str,
        _sha256: &str,
        _params_schema: &serde_json::Value,
        _published_at: DateTime<Utc>,
    ) -> Result<Option<StrategyVersionRow>> {
        Ok(None)
    }
    async fn set_status(
        &self,
        id: &str,
        status: StrategyStatus,
    ) -> Result<Option<StrategyVersionRow>> {
        let mut versions = self.versions.lock().unwrap();
        let Some(v) = versions.get_mut(id) else {
            return Ok(None);
        };
        v.status = status;
        Ok(Some(v.clone()))
    }
    async fn manage_list(&self, _kind: Option<StrategyKind>) -> Result<Vec<StrategyManageItem>> {
        Ok(Vec::new())
    }
    async fn update_meta(
        &self,
        id: &str,
        name: &str,
        description: &str,
    ) -> Result<Option<StrategyRow>> {
        let mut strategies = self.strategies.lock().unwrap();
        let Some(s) = strategies.get_mut(id) else {
            return Ok(None);
        };
        s.name = name.to_string();
        s.description = description.to_string();
        Ok(Some(s.clone()))
    }
    async fn delete_strategy(&self, _id: &str) -> Result<u64> {
        unimplemented!()
    }
}

/// 参考插件 code 取数（strategy-core::reference；与 Rust 内建 1:1 迁移）。
fn reference_plugin_code(id: &str) -> &'static str {
    strategy_core::reference::reference_plugins()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("参考插件不存在: {id}"))
        .code
}

/// 默认 Registry：播种 dual_ma（fast/slow schema）+ momentum（lookback schema）published 版本。
fn default_registry() -> Arc<MockStrategyStore> {
    let reg = Arc::new(MockStrategyStore::default());
    reg.seed_published(
        "dual_ma",
        "双均线交叉",
        reference_plugin_code("dual_ma"),
        serde_json::json!([
            { "key": "fast", "type": "int", "default": 5.0, "min": 2.0, "max": 200.0 },
            { "key": "slow", "type": "int", "default": 20.0, "min": 2.0, "max": 250.0 }
        ]),
    );
    reg.seed_published(
        "momentum",
        "动量突破",
        reference_plugin_code("momentum"),
        serde_json::json!([
            { "key": "lookback", "type": "int", "default": 20.0, "min": 2.0, "max": 150.0 }
        ]),
    );
    reg
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

/// F2：mock `KlineRead` —— 按 code 存最近一根 bar（确定性、无 DB）。`latest_bar` 走默认 `bars(None,1)`。
/// 另存「注册表」= `set_registered` 设定的 code 集（`symbols_with_latest` 返回这些注册行），
/// 供 `start_session` 的**注册表成员校验**（ADR 11-sim-live §4：strategies[].stocks 须为注册标的）。
#[derive(Default)]
struct MockKline {
    latest: Mutex<HashMap<String, KlineBarView>>,
    registered: Mutex<HashSet<String>>,
}

impl MockKline {
    fn set_latest(&self, code: &str, bar: Bar) {
        self.latest.lock().unwrap().insert(
            code.to_string(),
            KlineBarView {
                code: code.to_string(),
                ts: DateTime::from_timestamp(bar.ts, 0).unwrap(),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume as i64,
                amount: 0.0,
                source: None,
            },
        );
    }
    fn set_registered(&self, codes: &[&str]) {
        self.registered
            .lock()
            .unwrap()
            .extend(codes.iter().map(|s| s.to_string()));
    }
}

#[async_trait]
impl KlineRead for MockKline {
    async fn bars(
        &self,
        _period: Period,
        code: &str,
        _before: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<KlineBarView>> {
        if limit < 1 {
            return Ok(Vec::new());
        }
        Ok(self
            .latest
            .lock()
            .unwrap()
            .get(code)
            .cloned()
            .into_iter()
            .collect())
    }
    async fn symbols_with_latest(&self) -> Result<Vec<SymbolLatestView>> {
        Ok(self
            .registered
            .lock()
            .unwrap()
            .iter()
            .map(|code| SymbolLatestView {
                code: code.clone(),
                name: None,
                interval_secs: 60,
                settlement: "T1".into(),
                enabled: true,
                last_ts: None,
                last_close: None,
                prev_close: None,
            })
            .collect())
    }
}

#[tokio::test]
async fn start_session_defaults_cash_to_1m_and_persists() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    assert!(id.starts_with("s_"), "会话 id 前缀 s_");
    // 默认账户状态
    let acct = svc.get_account(&id).unwrap();
    close(acct.cash, 1_000_000.0);
    close(acct.equity, 1_000_000.0);
    assert_eq!(acct.session_id, id);
    // 落库计数
    assert_eq!(store.created.lock().unwrap().len(), 1);
    assert_eq!(store.created.lock().unwrap()[0].cash_init, DEFAULT_CASH);
}

#[tokio::test]
async fn market_buy_fills_at_latest_applies_account_and_persists() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let fill = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: None,
                intent_id: Some("int-1".into()),
                source: "manual".into(),
            },
            10.0,
        )
        .await
        .unwrap()
        .expect("市价即时成交");
    close(fill.price, 10.002); // 含滑点
    close(fill.qty, 1000.0);
    close(fill.fee, 5.0); // 佣金 10002×0.025% < 5 → 取 5

    let acct = svc.get_account(&id).unwrap();
    close(acct.cash, 1_000_000.0 - 1000.0 * 10.002 - 5.0);
    let pos = svc.get_positions(&id).await.unwrap();
    assert_eq!(pos.len(), 1);
    assert_eq!(pos[0].code, "510300");
    close(pos[0].qty, 1000.0);
    close(pos[0].avg_cost, 10.002);

    // 落库：成交明细 + 持仓
    assert_eq!(store.trades.lock().unwrap().len(), 1);
    assert_eq!(store.trades.lock().unwrap()[0].code, "510300");
    assert_eq!(store.pos_updates.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn limit_not_touched_records_pending_no_fill_no_trade_persist() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let fill = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: Some(9.0),
                intent_id: Some("int-l1".into()),
                source: "manual".into(),
            },
            10.5, // 最新 10.5 > 限价 9 → 不触及
        )
        .await
        .unwrap();
    assert!(fill.is_none(), "限价未触及不成交");
    // pending 单记录
    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].status, "pending");
    assert_eq!(orders[0].filled_qty, 0.0);
    // 不落成交明细 / 不动持仓
    assert!(store.trades.lock().unwrap().is_empty());
    assert!(store.pos_updates.lock().unwrap().is_empty());
    assert!(svc.get_account(&id).unwrap().cash == 1_000_000.0);
}

#[tokio::test]
async fn cancel_order_cancels_pending_but_not_filled() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    // pending 单
    let _ = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: Some(9.0),
                intent_id: None,
                source: "manual".into(),
            },
            10.5,
        )
        .await
        .unwrap();
    let orders = svc.get_orders(&id).unwrap();
    let pend_id = orders[0].id.clone();
    assert!(
        svc.cancel_order(&id, &pend_id).await.unwrap(),
        "撤 pending 成功"
    );
    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders[0].status, "cancelled");

    // 已成交不可撤
    let fill = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 100.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            10.0,
        )
        .await
        .unwrap()
        .expect("成交");
    let filled_id = svc
        .get_orders(&id)
        .unwrap()
        .iter()
        .rev()
        .find(|o| o.status == "filled")
        .unwrap()
        .id
        .clone();
    assert!(
        !svc.cancel_order(&id, &filled_id).await.unwrap(),
        "已成交不可撤"
    );
    assert!(
        !svc.cancel_order(&id, "no-such").await.unwrap(),
        "未知单返回 false"
    );
    let _ = fill;
}

#[tokio::test]
async fn pnl_and_mark_to_market_reflect_unrealized() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let _ = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            10.0,
        )
        .await
        .unwrap();
    // 打市值到 11.0 → 未实现 = 1000×(11 - 10.002) ≈ 998
    let mut latest = std::collections::BTreeMap::new();
    latest.insert("510300".into(), 11.0);
    svc.mark_to_market(&id, &latest, 2000).unwrap();
    let pnl = svc.get_pnl(&id).unwrap();
    close(pnl.realized_pnl, 0.0);
    close(pnl.unrealized_pnl, 1000.0 * (11.0 - 10.002));
    let acct = svc.get_account(&id).unwrap();
    close(
        acct.equity,
        1_000_000.0 - 1000.0 * 10.002 - 5.0 + 1000.0 * 11.0,
    );
}

#[tokio::test]
async fn place_order_is_idempotent_by_intent() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let req = PlaceOrderReq {
        code: "510300".into(),
        side: "buy".into(),
        qty: 1000.0,
        limit_price: None,
        intent_id: Some("int-dup".into()),
        source: "manual".into(),
    };
    let f1 = svc
        .place_order(&id, &req, 10.0)
        .await
        .unwrap()
        .expect("首次成交");
    let f2 = svc
        .place_order(&id, &req, 20.0)
        .await
        .unwrap()
        .expect("重复调用返回首次");
    // 幂等：返回同一次成交（即便最新价不同）
    assert_eq!(f1, f2);
    // 只记一笔成交明细
    assert_eq!(
        store.trades.lock().unwrap().len(),
        1,
        "intent 去重不重复落单"
    );
    let pos = svc.get_positions(&id).await.unwrap();
    close(pos[0].qty, 1000.0); // 不重复加仓
}

/// bug 修复（510880 持仓「最新价」=0.000）：持仓 latest/market_value 从本系统行情源解析。
/// start + place(buy 510880) → 持仓 latest=行情源 close（mock 返回 3.389）、market_value=qty×3.389。
#[tokio::test]
async fn place_order_position_latest_resolves_from_market_quote() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    // 模拟 /api/symbols latest last=3.389（510880 真实标的）；mock KlineRead 返回该 close。
    kline.set_latest("510880", dma_bar(100, 3.389));
    kline.set_registered(&["510880"]);
    let svc = service(store.clone()).with_kline(kline.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t-quote".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510880".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let sid = view.id;

    let fill = svc
        .place_order(
            &sid,
            &PlaceOrderReq {
                code: "510880".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            3.389,
        )
        .await
        .unwrap()
        .expect("市价即时成交");
    let _ = fill;

    let pos = svc.get_positions(&sid).await.unwrap();
    assert_eq!(pos.len(), 1);
    assert_eq!(pos[0].code, "510880");
    // 持仓最新价=行情源 close（非 0.000）；市值=qty×行情价（与成交价含滑点无关）。
    close(pos[0].latest, 3.389);
    close(pos[0].market_value, 1000.0 * 3.389);
}

/// bug 兜底：缺行情（未注入行情端口）→ 持仓 latest 回退 0.000（注明）。
#[tokio::test]
async fn place_order_position_latest_falls_back_zero_without_quote() {
    let store = Arc::new(MockSimStore::default());
    // 不注入 kline → 无行情源 → 回退 0.000。
    let svc = service(store.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t-noq".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let sid = view.id;

    svc.place_order(
        &sid,
        &PlaceOrderReq {
            code: "510300".into(),
            side: "buy".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: None,
            source: "manual".into(),
        },
        10.0,
    )
    .await
    .unwrap()
    .expect("成交");

    let pos = svc.get_positions(&sid).await.unwrap();
    assert_eq!(pos.len(), 1);
    close(pos[0].latest, 0.000); // 无行情兜底
    close(pos[0].market_value, 0.0);
}

/// 评分/持仓价格一致：二者同源（KlineRead::latest_bar close）。
#[tokio::test]
async fn position_latest_matches_scoring_latest_price_same_quote_source() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    kline.set_latest("510300", dma_bar(100, 10.0));
    kline.set_registered(&["510300"]);
    let svc = service(store.clone()).with_kline(kline.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t-sync".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let sid = view.id;

    // 手动建仓 510300。
    svc.place_order(
        &sid,
        &PlaceOrderReq {
            code: "510300".into(),
            side: "buy".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: None,
            source: "manual".into(),
        },
        10.0,
    )
    .await
    .unwrap()
    .expect("成交");

    // 配置策略 + 喂 bar → 评分 latest_price = 该 bar close。
    let configs = vec![StrategyConfigInput {
        strategy_id: "dual_ma".into(),
        version_id: None,
        params: serde_json::json!({"fast": 2.0, "slow": 3.0}),
        stocks: vec!["510300".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    svc.configure_strategies(&sid, configs).await.unwrap();
    let events = svc
        .process_bar(&sid, "510300", dma_bar(100, 10.0))
        .await
        .unwrap();
    // dual_ma 单策略 → 1 条信号事件。
    assert_eq!(events.len(), 1, "单策略一条事件");

    let signal = svc
        .get_strategy_signal(&sid, "510300")
        .unwrap()
        .expect("有评估");
    close(signal.latest_price, 10.0);
    let pos = svc.get_positions(&sid).await.unwrap();
    assert_eq!(pos.len(), 1);
    close(pos[0].latest, signal.latest_price); // 持仓与评分同价
}

#[tokio::test]
async fn stop_session_ends_and_persists_result_two_stop_returns_false() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let _ = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            10.0,
        )
        .await
        .unwrap();
    assert!(svc.stop_session(&id).await.unwrap(), "stop 成功");
    let view = store.get_session(&id).await.unwrap().expect("会话存在");
    assert_eq!(view.status, SimSessionStatus::Ended);
    assert!(view.end_ts.is_some());
    // 结束结果落库
    assert_eq!(store.ended.lock().unwrap().len(), 1);
    // 二次 stop → false（内存已 ended）
    assert!(!svc.stop_session(&id).await.unwrap(), "二次 stop false");
    assert!(
        !svc.stop_session("no-such").await.unwrap(),
        "未知会话 false"
    );
}

#[tokio::test]
async fn unknown_session_errors() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store);
    assert!(svc.get_account("no-such").is_err());
    assert!(svc
        .mark_to_market("no-such", &Default::default(), 0)
        .is_err());
    let r = svc
        .place_order(
            "no-such",
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            10.0,
        )
        .await;
    assert!(r.is_err(), "未知会话下单应 Err");
}

/// 常量镜像 DEFAULT_CASH_INIT（测试断言用）。
const DEFAULT_CASH: f64 = 1_000_000.0;

// ── 11-sim-live / L2：策略编排器联动（固定 bar，无实时 DB；P4a 起策略源为 Registry 插件编排器 PluginStrategyOrchestrator）──

fn dma_bar(ts: i64, close: f64) -> Bar {
    Bar {
        ts,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 10_000.0,
    }
}

/// 配置一个会产生「金叉买入」的编排器（dual_ma fast=2 slow=3，序列末 bar 金叉）。
async fn configured_buy_service(store: Arc<MockSimStore>) -> (SimLiveService, String) {
    let (svc, id) = started(store.clone()).await;
    let configs = vec![StrategyConfigInput {
        strategy_id: "dual_ma".into(),
        version_id: None,
        params: serde_json::json!({"fast": 2.0, "slow": 3.0}),
        stocks: vec!["510300".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    svc.configure_strategies(&id, configs).await.unwrap();
    (svc, id)
}

/// 先低后高序列 → dual_ma 于末 bar（ts=103）金叉 → Buy(100)。返回逐 bar。
fn golden_buy_bars() -> Vec<Bar> {
    vec![
        dma_bar(100, 12.0),
        dma_bar(101, 8.0),
        dma_bar(102, 9.0),
        dma_bar(103, 14.0),
    ]
}

/// 喂入全部 bar，返回最后一次 process_bar 的事件。
async fn feed_all(svc: &SimLiveService, id: &str, bars: &[Bar]) -> Vec<simlive::SignalEvent> {
    let mut last = Vec::new();
    for b in bars {
        last = svc.process_bar(id, "510300", b.clone()).await.unwrap();
    }
    last
}

/// F1：`get_orders`（OrderView）须含 `source`——手动单 source=manual；聚合自动单 source=aggregate_strategy。
/// （L4 修复：SimOrder/OrderView 未透传 source → 面板「来源」列空白。）
#[tokio::test]
async fn orders_include_source_manual_and_aggregate() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;

    // 手动市价单（码「600000」不在策略标的集内，避免占用聚合标的的持仓判定） → source=manual
    svc.place_order(
        &id,
        &PlaceOrderReq {
            code: "600000".into(),
            side: "buy".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: Some("int-src-manual".into()),
            source: "manual".into(),
        },
        10.0,
    )
    .await
    .unwrap()
    .expect("市价成交");
    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].code, "600000");
    assert_eq!(orders[0].source, "manual");

    // 聚合自动单 → source=aggregate_strategy（配置策略 + 开启开关 + 达阈值）
    let configs = vec![StrategyConfigInput {
        strategy_id: "dual_ma".into(),
        version_id: None,
        params: serde_json::json!({"fast": 2.0, "slow": 3.0}),
        stocks: vec!["510300".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    svc.configure_strategies(&id, configs).await.unwrap();
    svc.set_trading(&id, true).await.unwrap();
    feed_all(&svc, &id, &golden_buy_bars()).await;

    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders.len(), 2, "手动 + 聚合自动各 1 单");
    let agg = orders
        .iter()
        .rev()
        .find(|o| o.status == "filled")
        .expect("存在 filled 单");
    assert_eq!(agg.source, "aggregate_strategy");
}

/// F2：`SimLiveFeed` poll 驱动——喂新 bar → `process_bar` → 会话 evaluation 非空 + 聚合自动单（enabled+达阈值）。
#[tokio::test]
async fn feed_polls_new_bar_drives_evaluation_and_auto_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc_inst, id) = configured_buy_service(store.clone()).await;
    let svc = Arc::new(svc_inst);
    svc.set_trading(&id, true).await.unwrap();

    let kline = Arc::new(MockKline::default());
    let feed = SimLiveFeed::new(svc.clone(), kline.clone(), Duration::from_millis(10));

    // 逐根 bar 推进 mock kline 的“最新”一根，再 tick —— 模拟 poll 式 feed 发现新 bar。
    for b in golden_buy_bars() {
        kline.set_latest("510300", b);
        feed.tick().await.unwrap();
    }

    // evaluation 非空（会话评分真实驱动）
    let analysis = svc.get_strategy_analysis(&id).unwrap();
    assert_eq!(analysis.len(), 1);
    assert_eq!(analysis[0].code, "510300");
    assert_eq!(analysis[0].signal, "buy");
    close(analysis[0].aggregate_score, 80.0);

    // 聚合自动单（enabled + 达阈值 → source=aggregate_strategy）
    let pos = svc.get_positions(&id).await.unwrap();
    assert_eq!(pos.len(), 1);
    close(pos[0].qty, 100.0);
    let orders = svc.get_orders(&id).unwrap();
    let agg = orders
        .iter()
        .rev()
        .find(|o| o.status == "filled")
        .expect("存在自动单");
    assert_eq!(agg.source, "aggregate_strategy");
}

/// F2：`feed_targets` 返回**已钉住编排器** running 会话的 poll 目标（P4a：策略在
/// start_session 时已钉住实例化，feed 不再自动配置）；poll 喂新 bar → 评估出现。
#[tokio::test]
async fn feed_targets_returns_pinned_session_poll_targets() {
    let store = Arc::new(MockSimStore::default());
    let (svc_inst, id) = started(store.clone()).await; // strategy_set=["dual_ma"] → 启动即钉住建编排器, stock_set=["510300"]
    let svc = Arc::new(svc_inst);

    // 初始：编排器已在启动时钉住，未 feed 前 → 无评估
    assert!(svc.get_strategy_analysis(&id).unwrap().is_empty());

    // feed_targets 返回该会话的 poll 目标（标的 = 钉住配置股票并集）
    let targets = svc.feed_targets().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].session_id, id);
    assert_eq!(targets[0].period, "M1");
    assert_eq!(targets[0].codes, vec!["510300".to_string()]);

    // 喂一根 bar → 评估出现（默认 fast/slow 单 bar → Hold(50)）
    let kline = Arc::new(MockKline::default());
    kline.set_latest("510300", dma_bar(100, 10.0));
    let feed = SimLiveFeed::new(svc.clone(), kline.clone(), Duration::from_millis(10));
    feed.tick().await.unwrap();
    let analysis = svc.get_strategy_analysis(&id).unwrap();
    assert_eq!(analysis.len(), 1);
    assert_eq!(analysis[0].code, "510300");
    assert_eq!(analysis[0].signal, "hold");
}

/// O1：已有 running 会话时再 start → Err（`AlreadyRunning`），防多 running。
#[tokio::test]
async fn start_session_when_already_running_returns_already_running_error() {
    let store = Arc::new(MockSimStore::default());
    let (svc, _first) = started(store.clone()).await;
    let err = svc
        .start_session(&StartSessionReq {
            name: "dup".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<application::simlive::AlreadyRunning>()
            .is_some(),
        "重复 start 应返回 AlreadyRunning（防多 running）"
    );
}

/// ADR §4 多策略：start_session 带 strategies → 编排器按每策略 参数/标的集 配置（固定输入断言）。
#[tokio::test]
async fn start_session_with_strategies_wires_orchestrator() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "s-multi".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![
                StrategyConfigInput {
                    strategy_id: "dual_ma".into(),
                    version_id: None,
                    params: serde_json::json!({"fast": 2.0, "slow": 3.0}),
                    stocks: vec!["510300".into()],
                    weight: 2.0,
                    stock_weights: HashMap::new(),
                },
                StrategyConfigInput {
                    strategy_id: "momentum".into(),
                    version_id: None,
                    params: serde_json::json!({"lookback": 2.0}),
                    stocks: vec!["159577".into()],
                    weight: 1.0,
                    stock_weights: HashMap::new(),
                },
            ],
        })
        .await
        .unwrap();
    let sid = view.id.clone();

    // 会话级 strategy_set/stock_set 由策略派生（去重、保序）。
    let meta = svc.get_session(&sid).await.unwrap().unwrap().session;
    assert_eq!(
        meta.strategy_set,
        vec!["dual_ma".to_string(), "momentum".to_string()]
    );
    assert_eq!(
        meta.stock_set,
        vec!["510300".to_string(), "159577".to_string()]
    );

    // 编排器：dual_ma 只覆盖 510300；momentum 只覆盖 159577。
    svc.process_bar(&sid, "510300", dma_bar(100, 10.0))
        .await
        .unwrap();
    let a = svc
        .get_strategy_signal(&sid, "510300")
        .unwrap()
        .expect("有评估");
    assert_eq!(a.code, "510300");
    assert_eq!(a.per_strategy_scores.len(), 1, "仅 dual_ma 覆盖 510300");
    assert_eq!(a.per_strategy_scores[0].strategy_id, "dual_ma");

    svc.process_bar(&sid, "159577", dma_bar(100, 12.0))
        .await
        .unwrap();
    let b = svc
        .get_strategy_signal(&sid, "159577")
        .unwrap()
        .expect("有评估");
    assert_eq!(b.code, "159577");
    assert_eq!(b.per_strategy_scores.len(), 1, "仅 momentum 覆盖 159577");
    assert_eq!(b.per_strategy_scores[0].strategy_id, "momentum");

    // 未覆盖标的不评估。
    assert!(svc.get_strategy_signal(&sid, "999999").unwrap().is_none());
}

/// ADR §4：start_session 带非法 strategies（未知 id / weight≤0 / params 越界 / 未知标的 / 空标的集）→ Err(InvalidConfig)。
#[tokio::test]
async fn start_session_invalid_strategies_rejects() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    let base = |strategies: Vec<StrategyConfigInput>| StartSessionReq {
        name: "bad".into(),
        cash_init: None,
        strategy_set: vec![],
        stock_set: vec![],
        period: "M1".into(),
        source: "manual".into(),
        buy_long_threshold: None,
        sell_threshold: None,
        strategies,
    };
    // 未知策略 id
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            strategy_id: "not_a_strategy".into(),
            params: serde_json::json!({}),
            version_id: None,
            stocks: vec!["510300".into()],
            weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<InvalidConfig>().is_some(),
        "未知策略 id → InvalidConfig"
    );
    // weight ≤ 0
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            strategy_id: "dual_ma".into(),
            params: serde_json::json!({}),
            version_id: None,
            stocks: vec!["510300".into()],
            weight: 0.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<InvalidConfig>().is_some(),
        "weight≤0 → InvalidConfig"
    );
    // params 越界（fast 超 max=200）
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            strategy_id: "dual_ma".into(),
            params: serde_json::json!({"fast": 99999.0, "slow": 3.0}),
            version_id: None,
            stocks: vec!["510300".into()],
            weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<InvalidConfig>().is_some(),
        "params 越界 → InvalidConfig"
    );
    // 未知标的（非 6 位数字）
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            strategy_id: "dual_ma".into(),
            params: serde_json::json!({}),
            version_id: None,
            stocks: vec!["abc".into()],
            weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<InvalidConfig>().is_some(),
        "未知标的 → InvalidConfig"
    );
    // 空标的集
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            strategy_id: "dual_ma".into(),
            params: serde_json::json!({}),
            version_id: None,
            stocks: vec![],
            weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<InvalidConfig>().is_some(),
        "空标的集 → InvalidConfig"
    );
    // stock_weights 键不在标的集
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            strategy_id: "dual_ma".into(),
            params: serde_json::json!({}),
            version_id: None,
            stocks: vec!["510300".into()],
            weight: 1.0,
            stock_weights: HashMap::from([("159577".to_string(), 2.0)]),
        }]))
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<InvalidConfig>().is_some(),
        "stock_weights 键不在标的集 → InvalidConfig"
    );
    // stock_weights 值 ≤0
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            strategy_id: "dual_ma".into(),
            params: serde_json::json!({}),
            version_id: None,
            stocks: vec!["510300".into()],
            weight: 1.0,
            stock_weights: HashMap::from([("510300".to_string(), 0.0)]),
        }]))
        .await
        .unwrap_err();
    assert!(
        err.downcast_ref::<InvalidConfig>().is_some(),
        "stock_weights 值≤0 → InvalidConfig"
    );
}

// ADR §4：strategies[].stocks 注册表成员校验——格式合法（6 位数字 + 市场前缀）但**未注册**的 code（如 999999）应拒（修复偏差：原来只验格式、不查注册表）。
// 注入 mock 注册表只含 518880/510300；999999 未注册 → Err(InvalidConfig)「未注册」；未落库。
#[tokio::test]
async fn start_session_with_strategies_rejects_unregistered_code() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    kline.set_registered(&["518880", "510300"]); // 注册表={518880,510300}
    let svc = service(store.clone()).with_kline(kline.clone());
    let err = svc
        .start_session(&StartSessionReq {
            name: "reg-reject".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![StrategyConfigInput {
                strategy_id: "dual_ma".into(),
                version_id: None,
                params: serde_json::json!({}),
                stocks: vec!["999999".into()], // 格式合法（6 位数字 + 前缀 9→沪）但未注册
                weight: 1.0,
                stock_weights: HashMap::new(),
            }],
        })
        .await
        .unwrap_err();
    let e = err
        .downcast_ref::<InvalidConfig>()
        .expect("应为 InvalidConfig");
    assert!(
        e.0.contains("999999") && e.0.contains("未注册"),
        "应提示未注册：{}",
        e.0
    );
    // 校验即拒 → 未落库会话元数据
    assert!(
        store.created.lock().unwrap().is_empty(),
        "未注册 code → start 应拒且不落库"
    );
}

// ADR §4 反向：已注册 code（518880，注册表内）→ 200，会话 stock_set 由策略派生。
#[tokio::test]
async fn start_session_with_strategies_accepts_registered_code() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    kline.set_registered(&["518880"]);
    let svc = service(store.clone()).with_kline(kline.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "reg-ok".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![StrategyConfigInput {
                strategy_id: "dual_ma".into(),
                version_id: None,
                params: serde_json::json!({}),
                stocks: vec!["518880".into()],
                weight: 1.0,
                stock_weights: HashMap::new(),
            }],
        })
        .await
        .unwrap();
    let meta = svc.get_session(&view.id).await.unwrap().unwrap().session;
    assert_eq!(
        meta.stock_set,
        vec!["518880".to_string()],
        "会话 stock_set 由策略派生"
    );
}

// ADR §4 反向：未注入注册表端口（kline=None）→ 回退格式校验（兼容既有不注入构造），
// 格式合法的 510300 仍可 start 成功（注册表校验仅在注入端口时强制）。
#[tokio::test]
async fn start_session_with_strategies_without_registry_port_falls_back_to_format() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone()); // 不注入 kline
    let view = svc
        .start_session(&StartSessionReq {
            name: "no-reg".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![StrategyConfigInput {
                strategy_id: "dual_ma".into(),
                version_id: None,
                params: serde_json::json!({}),
                stocks: vec!["510300".into()],
                weight: 1.0,
                stock_weights: HashMap::new(),
            }],
        })
        .await
        .unwrap();
    let meta = svc.get_session(&view.id).await.unwrap().unwrap().session;
    assert_eq!(meta.stock_set, vec!["510300".to_string()]);
}

#[tokio::test]
async fn set_trading_on_and_buy_threshold_places_aggregate_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    assert!(
        svc.set_trading(&id, true).await.unwrap(),
        "开关打开返回 true"
    );
    assert!(svc.trading_enabled(&id).unwrap(), "查询开关态 true");

    let last_events = feed_all(&svc, &id, &golden_buy_bars()).await;

    // 达做多阈值 → 下单（source=aggregate_strategy）。
    let pos = svc.get_positions(&id).await.unwrap();
    assert_eq!(pos.len(), 1, "建立持仓");
    assert_eq!(pos[0].code, "510300");
    close(pos[0].qty, 100.0); // DEFAULT_AGGREGATE_QTY

    // 落库一笔成交（source=aggregate_strategy）。
    let trades = store.trades.lock().unwrap();
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].source, "aggregate_strategy");
    assert_eq!(trades[0].code, "510300");

    // 事件流：末 bar 两策略事件均 ordered=true，聚合分=100。
    assert_eq!(last_events.len(), 1, "仅一个策略覆盖该 stock");
    assert_eq!(last_events[0].strategy_id, "dual_ma");
    assert!(last_events[0].ordered);
    close(last_events[0].aggregate_score, 80.0);
    assert_eq!(last_events[0].signal, "buy");
    assert_eq!(last_events[0].code, "510300");
}

#[tokio::test]
async fn set_trading_off_only_scores_no_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    // 关闭（默认也 off）：只评估/评分，不入单。
    assert!(
        !svc.set_trading(&id, false).await.unwrap(),
        "开关关闭返回 false"
    );
    assert!(!svc.trading_enabled(&id).unwrap());

    let last_events = feed_all(&svc, &id, &golden_buy_bars()).await;

    assert!(last_events.iter().all(|e| !e.ordered), "off 时不下单");
    close(last_events[0].aggregate_score, 80.0);
    assert_eq!(svc.get_positions(&id).await.unwrap().len(), 0, "无持仓");
    assert!(store.trades.lock().unwrap().is_empty(), "无成交落库");
}

#[tokio::test]
async fn trading_on_no_threshold_no_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    svc.set_trading(&id, true).await.unwrap();
    // 单调上涨但无「升级金叉」（首根即有 prev_above=None → Hold；后续一直 above → Hold）。
    let bars = vec![
        dma_bar(100, 10.0),
        dma_bar(101, 11.0),
        dma_bar(102, 12.0),
        dma_bar(103, 13.0),
    ];
    let last = feed_all(&svc, &id, &bars).await;
    assert!(last.iter().all(|e| !e.ordered), "未达做多阈值不下单");
    assert_eq!(svc.get_positions(&id).await.unwrap().len(), 0);
}

#[tokio::test]
async fn get_strategy_signal_and_analysis_return_evaluations() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    feed_all(&svc, &id, &golden_buy_bars()).await;

    let sig = svc
        .get_strategy_signal(&id, "510300")
        .unwrap()
        .expect("有评估");
    close(sig.aggregate_score, 80.0);
    assert_eq!(sig.signal, "buy");
    assert_eq!(sig.per_strategy_scores.len(), 1);
    assert_eq!(sig.per_strategy_scores[0].strategy_id, "dual_ma");
    close(sig.per_strategy_scores[0].score, 80.0);
    close(sig.latest_price, 14.0);

    // 未覆盖标的不评估。
    assert!(svc.get_strategy_signal(&id, "999999").unwrap().is_none());

    let analysis = svc.get_strategy_analysis(&id).unwrap();
    assert_eq!(analysis.len(), 1);
    assert_eq!(analysis[0].code, "510300");
}

#[tokio::test]
async fn process_bar_unconfigured_errors_and_unknown_stock_no_event() {
    let store = Arc::new(MockSimStore::default());
    // 纯手动会话（无策略）→ 未配置编排器 → process_bar Err。
    let svc = service(store.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "manual-only".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![],
        })
        .await
        .unwrap();
    let id = view.id;
    let r = svc.process_bar(&id, "510300", dma_bar(100, 10.0)).await;
    assert!(r.is_err(), "未配置策略应 Err");

    let (svc2, id2) = configured_buy_service(store).await;
    // 已配置但未覆盖的标的 → Ok(空事件)。
    let ev = svc2
        .process_bar(&id2, "999999", dma_bar(100, 10.0))
        .await
        .unwrap();
    assert!(ev.is_empty(), "未覆盖标的无事件");
}

// ── 11-sim-live / L3：会话记录回看 + 回测对比 ──

/// ensemble run 存储 mock（P4a 对比走统一引擎）：记录 create_run 钉住 config。
#[derive(Default)]
struct MockRunStore {
    runs: Mutex<HashMap<String, StrategyRunView>>,
    created: Mutex<Vec<NewStrategyRun>>,
}

#[async_trait]
impl StrategyRunStore for MockRunStore {
    async fn create_run(&self, run: &NewStrategyRun) -> Result<StrategyRunView> {
        let view = StrategyRunView {
            id: run.id.clone(),
            name: run.name.clone(),
            symbol: run.symbol.clone(),
            period: run.period.clone(),
            from_ts: run.from_ts,
            to_ts: run.to_ts,
            config: run.config.clone(),
            status: StrategyRunStatus::Queued,
            progress: 0.0,
            error: None,
            created_at: fixed_now(),
            started_at: None,
            finished_at: None,
        };
        self.created.lock().unwrap().push(run.clone());
        self.runs.lock().unwrap().insert(run.id.clone(), view.clone());
        Ok(view)
    }
    async fn get_run(&self, id: &str) -> Result<Option<StrategyRunView>> {
        Ok(self.runs.lock().unwrap().get(id).cloned())
    }
    async fn list_runs(&self, _: &StrategyRunFilter) -> Result<Vec<StrategyRunView>> {
        Ok(Vec::new())
    }
    async fn mark_started(&self, _: &str, _: DateTime<Utc>) -> Result<bool> {
        Ok(false) // 后台任务认领失败即放弃（测试不关心执行结果，只关心提交钉住）
    }
    async fn update_progress(&self, _: &str, _: f64) -> Result<()> {
        Ok(())
    }
    async fn mark_succeeded(&self, _: &str, _: &StrategyRunResult, _: DateTime<Utc>) -> Result<bool> {
        Ok(false)
    }
    async fn mark_failed(&self, _: &str, _: &str, _: DateTime<Utc>) -> Result<bool> {
        Ok(false)
    }
    async fn mark_canceled(&self, _: &str, _: DateTime<Utc>) -> Result<Option<bool>> {
        Ok(None)
    }
    async fn get_result(&self, _: &str) -> Result<Option<StrategyRunResult>> {
        Ok(None)
    }
}

struct MockPresetStore;
#[async_trait]
impl StrategyPresetStore for MockPresetStore {
    async fn create_preset(&self, _: &NewStrategyPreset) -> Result<StrategyPresetRow> {
        unimplemented!()
    }
    async fn get_preset(&self, _: &str) -> Result<Option<StrategyPresetRow>> {
        Ok(None)
    }
    async fn find_preset_by_name(&self, _: &str) -> Result<Option<StrategyPresetRow>> {
        Ok(None)
    }
    async fn list_presets(&self) -> Result<Vec<StrategyPresetRow>> {
        Ok(Vec::new())
    }
    async fn update_preset(&self, _: &str, _: &str, _: &serde_json::Value) -> Result<Option<StrategyPresetRow>> {
        Ok(None)
    }
    async fn delete_preset(&self, _: &str) -> Result<bool> {
        Ok(false)
    }
}

/// 对比回测 bar 源：固定 6 根 M1 bar（10→11 上升；区间内非空即可，执行结果不在断言面）。
struct MockCompareBars;
#[async_trait]
impl BacktestBarRead for MockCompareBars {
    async fn bars(
        &self,
        code: &str,
        _: &domain::types::Period,
        from: DateTime<Utc>,
        _: DateTime<Utc>,
    ) -> Result<Vec<domain::types::Bar>> {
        Ok((0..6)
            .map(|i| domain::types::Bar {
                code: domain::types::Code(code.to_string()),
                period: domain::types::Period::M1,
                ts: from + chrono::Duration::minutes(i),
                open: 10.0 + i as f64,
                high: 11.0 + i as f64,
                low: 9.0 + i as f64,
                close: 10.0 + i as f64,
                volume: 1000,
                amount: 10_000.0,
                source: domain::types::SourceId::Tushare,
            })
            .collect())
    }
}

struct MockSymbols;
#[async_trait]
impl SymbolRegistry for MockSymbols {
    async fn enabled_codes(&self) -> Result<Vec<domain::types::Code>> {
        Ok(vec![
            domain::types::Code("510300".into()),
            domain::types::Code("159577".into()),
        ])
    }
    async fn interval_secs(&self, _: &domain::types::Code) -> Result<u64> {
        Ok(60)
    }
    async fn upsert(&self, _: domain::types::Code, _: u64, _: bool) -> Result<()> {
        Ok(())
    }
}

struct MockRunProgress;
#[async_trait]
impl domain::ports::StrategyRunProgressSink for MockRunProgress {
    async fn send(&self, _: &str, _: f64, _: Option<DateTime<Utc>>) -> Result<()> {
        Ok(())
    }
}

/// mock 回测工作台（P4a：统一 ensemble 引擎；记录 create_run 钉住快照供断言）。
fn mock_workbench_service(
    strategies: Arc<MockStrategyStore>,
) -> (Arc<MockRunStore>, WorkbenchService) {
    let run_store = Arc::new(MockRunStore::default());
    let wb = WorkbenchService::new(
        Arc::new(MockCompareBars),
        run_store.clone(),
        Arc::new(MockPresetStore),
        strategies,
        Arc::new(MockSymbols),
        Arc::new(MockRunProgress),
        Arc::new(FixedClock(fixed_now())),
        1,
    );
    (run_store, wb)
}

/// 可控时钟：不再恒返回固定时刻（start/end 需可推进，保证回测区间 start<end）。
struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::Relaxed), 0).unwrap()
    }
}
impl TestClock {
    fn set(&self, ts: i64) {
        self.0.store(ts, Ordering::Relaxed);
    }
}

/// 以市价买/卖一笔，并两次打市值，得到固定净值序列（3 点）+ 1 个已平仓 round-trip。
/// 用可控时钟：start=base、end=base+3600（start<end，供回测对比区间）。并在开始时推进时钟使 start≠end。
async fn build_closed_session(store: Arc<MockSimStore>) -> (SimLiveService, String) {
    let base = fixed_now().timestamp();
    let clock = Arc::new(TestClock(AtomicI64::new(base)));
    let svc = SimLiveService::new(store.clone(), clock.clone(), backtest::FeeModel::default())
        .with_strategies(default_registry());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t1".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let id = view.id.clone();
    // 推进时钟（在会话内，模拟“一段时间后”），使商谈/stop 的 ts 与 start 不同。
    clock.set(base + 1800);
    // 买 1000 @ 10.0（市价 → 有效价 10.002、费 5）
    svc.place_order(
        &id,
        &PlaceOrderReq {
            code: "510300".into(),
            side: "buy".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: None,
            source: "manual".into(),
        },
        10.0,
    )
    .await
    .unwrap()
    .expect("买成交");
    // 打市值 12.0
    let mut latest = std::collections::BTreeMap::new();
    latest.insert("510300".to_string(), 12.0);
    svc.mark_to_market(&id, &latest, 2000).unwrap();
    // 卖 1000 @ 12.0（市价 → 有效价 11.9976、费 5 + 印花税）
    svc.place_order(
        &id,
        &PlaceOrderReq {
            code: "510300".into(),
            side: "sell".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: None,
            source: "manual".into(),
        },
        12.0,
    )
    .await
    .unwrap()
    .expect("卖成交");
    // 打市值 12.0（已无持仓 → equity = cash）
    svc.mark_to_market(&id, &latest, 3000).unwrap();
    // 推进到会话结束（end > start）。
    clock.set(base + 3600);
    (svc, id)
}

/// stop_session 结算：结果采用 backtest 指标口径（net_value={series,drawdown}、trades=TradeDetail、metrics=8 项）。
#[tokio::test]
async fn stop_session_result_uses_backtest_metrics_structure_and_trade_pnl() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap(), "stop 成功");

    let ended = store.ended.lock().unwrap();
    let (_, result) = &ended[0];
    // net_value = {series, drawdown}（3 点）
    assert!(result.net_value["series"].is_array(), "series 数组");
    assert_eq!(result.net_value["series"].as_array().unwrap().len(), 3);
    assert!(result.net_value["drawdown"].is_array(), "drawdown 数组");
    assert_eq!(result.net_value["drawdown"].as_array().unwrap().len(), 3);
    // trades = 已平仓 TradeDetail（1 笔 round-trip）
    let trades = result.trades.as_array().expect("trades 数组");
    assert_eq!(trades.len(), 1, "买→卖 → 1 个已平仓段");
    assert_eq!(trades[0]["shares"], serde_json::json!(1000.0));
    assert!(trades[0]["open_price"].as_f64().unwrap() > 0.0);
    assert!(trades[0]["close_price"].as_f64().unwrap() > 0.0);
    assert!(trades[0]["pnl"].as_f64().unwrap() > 0.0, "低买高卖盈利");
    // metrics = 8 项 backtest 指标
    let m = &result.metrics;
    for key in [
        "net_profit",
        "max_drawdown",
        "sharpe",
        "win_rate",
        "annualized_return",
        "trade_count",
        "avg_hold_bars",
    ] {
        assert!(m[key].is_number(), "metrics.{key} 存在且为 number");
    }
    // 全盈（无亏损）⇒ profit_factor=∞ → serde_json 序列化为 null；否则为正 number。
    assert!(
        m["profit_factor"].is_null() || m["profit_factor"].as_f64().unwrap() > 0.0,
        "profit_factor 为 ∞(null) 或正数"
    );
    assert_eq!(
        m["trade_count"],
        serde_json::json!(1),
        "已平仓 1 笔 ⇒ trade_count=1"
    );
    assert_eq!(
        m["win_rate"],
        serde_json::json!(1.0),
        "唯一盈利 ⇒ win_rate=1"
    );
    assert!(m["net_profit"].as_f64().unwrap() > 0.0, "净收益为正");
}

/// sim_list_sessions 返回历史会话（已结束附指标摘要）；sim_get_session 返回详情（元数据 + 结果）。
#[tokio::test]
async fn list_and_get_session_return_history_and_result() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap());

    // 未注入 workbench 时 run_backtest_compare 报错（防御性）。
    let r = svc.run_backtest_compare(&id).await;
    assert!(r.is_err(), "未注入回测工作台 → Err");

    let entries = svc.list_sessions().await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].session.id, id);
    assert_eq!(entries[0].session.status, SimSessionStatus::Ended);
    assert!(entries[0].metrics.is_some(), "已结束会话附指标摘要");
    assert!(entries[0].metrics.as_ref().unwrap()["trade_count"].is_number());

    let detail = svc.get_session(&id).await.unwrap().expect("会话存在");
    assert_eq!(detail.session.id, id);
    assert!(detail.result.is_some(), "详情含结束结果");
    assert!(detail.result.as_ref().unwrap().metrics["sharpe"].is_number());

    // 未知 id → None
    assert!(svc.get_session("no-such").await.unwrap().is_none());
}

/// sim_run_backtest_compare（P4a 口径）：注入回测工作台 → 每标的 1 个 ensemble run，
/// slots = 覆盖该标的的钉住策略（version_id 钉住），阈值 = 会话钉住阈值（60/40），
/// policy = LumpSum 全仓，initial_capital = cash_init，fee = 会话 FeeModel。
#[tokio::test]
async fn run_backtest_compare_triggers_ensemble_run_with_pinned_config() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap());

    let (run_store, wb) = mock_workbench_service(default_registry());
    let svc = svc.with_workbench(Arc::new(wb));
    let view = svc.run_backtest_compare(&id).await.unwrap();

    // 单 stock（510300）× 1 覆盖策略 → 1 个 ensemble run。
    assert_eq!(view.run_ids.len(), 1);
    assert!(view.run_ids[0].starts_with("sr_"), "run id 为 sr_ 前缀字符串");
    assert!(view.session_result.is_some(), "返回会话自身结果供对比");
    assert_eq!(view.session_id, id);

    // 钉住快照断言（config jsonb：slots[version_id/sha256/params 填充/weight] + 阈值 + policy + 资金 + fee）。
    let created = run_store.created.lock().unwrap();
    assert_eq!(created.len(), 1);
    let run = &created[0];
    assert_eq!(run.symbol, "510300");
    assert_eq!(run.period, "M1");
    let cfg = &run.config;
    let slots = cfg["slots"].as_array().expect("slots 数组");
    assert_eq!(slots.len(), 1, "仅覆盖 510300 的钉住策略入 slot");
    assert_eq!(slots[0]["strategy_id"], serde_json::json!("dual_ma"));
    assert_eq!(slots[0]["version_id"], serde_json::json!("sv_dual_ma"));
    assert_eq!(slots[0]["version"], serde_json::json!(1));
    assert_eq!(slots[0]["sha256"], serde_json::json!(application::strategy::sha256_hex(reference_plugin_code("dual_ma"))));
    assert!(slots[0]["weight"].as_f64().unwrap() > 0.0);
    assert_eq!(cfg["buy_threshold"], serde_json::json!(60.0), "阈值=会话钉住值");
    assert_eq!(cfg["sell_threshold"], serde_json::json!(40.0));
    assert_eq!(cfg["policy"], serde_json::json!({"LumpSum": {"position_pct": 1.0}}));
    assert_eq!(cfg["initial_capital"], serde_json::json!(1_000_000.0));
    assert!(run.to_ts > run.from_ts, "to > from");
}

/// run_backtest_compare 未知会话 → Err。
#[tokio::test]
async fn run_backtest_compare_unknown_session_errors() {
    let store = Arc::new(MockSimStore::default());
    let (run_store, wb) = mock_workbench_service(default_registry());
    let svc = service(store).with_workbench(Arc::new(wb));
    let r = svc.run_backtest_compare("no-such").await;
    assert!(r.is_err(), "未知会话 → Err");
    assert!(run_store.created.lock().unwrap().is_empty(), "未触发 run");
}

/// run_backtest_compare：纯手动会话（无策略）→ 明确报错，不触发 run。
#[tokio::test]
async fn run_backtest_compare_manual_session_errors() {
    let store = Arc::new(MockSimStore::default());
    let clock = Arc::new(TestClock(AtomicI64::new(fixed_now().timestamp())));
    let svc = SimLiveService::new(store.clone(), clock.clone(), backtest::FeeModel::default());
    let view = svc
        .start_session(&StartSessionReq {
            name: "manual-only".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![],
        })
        .await
        .unwrap();
    clock.set(fixed_now().timestamp() + 3600);
    assert!(svc.stop_session(&view.id).await.unwrap());
    let (run_store, wb) = mock_workbench_service(default_registry());
    let svc = svc.with_workbench(Arc::new(wb));
    let r = svc.run_backtest_compare(&view.id).await;
    assert!(r.is_err(), "纯手动会话无钉住策略 → Err");
    assert!(run_store.created.lock().unwrap().is_empty());
}

// ── 11-sim-live / L3b：web 面板服务侧（与 MCP 共享同一实例）──

/// mcp_enabled 默认为 true；set_mcp_enabled 切换后读回；MCP 与 web 共享同值（同一实例）。
#[tokio::test]
async fn mcp_enabled_toggle_reads_back_same_instance() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store);
    assert!(svc.mcp_enabled(), "默认开启");
    assert!(!svc.set_mcp_enabled(false), "关闭返回 false");
    assert!(!svc.mcp_enabled(), "读回 false");
    assert!(svc.set_mcp_enabled(true), "恢复 true");
    assert!(svc.mcp_enabled(), "读回 true");
}

/// current_session_id：运行中会话 → 该 running id；stop 后无 running → None（历史回看须显式传 id）。
#[tokio::test]
async fn current_session_resolves_latest_running_only() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    assert_eq!(
        svc.current_session_id().as_deref(),
        Some(id.as_str()),
        "运行中会话=current"
    );

    assert!(svc.stop_session(&id).await.unwrap());
    // 已无 running 会话 → current None（内存里已 ended；回看须显式 id）。
    assert!(
        svc.current_session_id().is_none(),
        "stop 后无 running → None"
    );
}

// ── 11-sim-live / 重启恢复：实时落盘 + 从落盘重建续跑 ──

/// TDD①：process_bar 后 simsession_state 写盘（含现金/持仓/净值序列/策略配置/开关）。
#[tokio::test]
async fn process_bar_persists_running_state() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    svc.set_trading(&id, true).await.unwrap();
    feed_all(&svc, &id, &golden_buy_bars()).await;

    let state = store
        .get_state(&id)
        .await
        .unwrap()
        .expect("process_bar 后应有运行态");
    // 现金/费用/已实现与实时账户一致。
    let live = svc.get_account(&id).unwrap();
    close(state.cash, live.cash);
    close(state.realized_pnl, live.realized_pnl);
    close(state.total_fee, live.total_fee);
    // 持仓（聚合买 100 股）。
    assert_eq!(state.positions.len(), 1);
    assert_eq!(state.positions[0].code, "510300");
    close(state.positions[0].qty, 100.0);
    // 净值序列非空（初始点 + …）。
    assert!(!state.net_value_series.is_empty(), "净现值序列已落盘");
    // 钉住策略快照已落盘（schema=2 对象：阈值 + strategies 数组含 version_id/sha256）。
    let cfg = &state.strategy_configs;
    assert_eq!(cfg["schema"], serde_json::json!(2));
    assert_eq!(cfg["buy_long_threshold"], serde_json::json!(60.0));
    assert_eq!(cfg["sell_threshold"], serde_json::json!(40.0));
    let arr = cfg["strategies"].as_array().expect("strategies 数组");
    assert_eq!(arr.len(), 1, "dual_ma 钉住配置落盘");
    assert_eq!(arr[0]["strategy_id"], serde_json::json!("dual_ma"));
    assert_eq!(arr[0]["version_id"], serde_json::json!("sv_dual_ma"));
    assert!(arr[0]["sha256"].as_str().unwrap().len() == 64, "sha256 hex 落盘");
    // 交易开关键落盘。
    assert!(state.trading_enabled, "trading_enabled 落盘");
}

/// TDD②：模拟重启（新 SimLiveService 实例 + 同一 store）→ recover 重建会话→账户/持仓/PnL/策略配置一致、可继续（不 500）。
#[tokio::test]
async fn recover_sessions_restores_running_session_and_continues() {
    let store = Arc::new(MockSimStore::default());
    let (svc_a, id) = configured_buy_service(store.clone()).await;
    svc_a.set_trading(&id, true).await.unwrap();
    feed_all(&svc_a, &id, &golden_buy_bars()).await;

    let persisted = store.get_state(&id).await.unwrap().expect("运行态已落盘");

    // 模拟重启：全新 SimLiveService 实例，复用同一 store。
    let svc_b = service(store.clone());
    let report = svc_b.recover_sessions().await.unwrap();
    assert!(report.recovered.contains(&id), "应恢复该会话");
    assert!(report.degraded.is_empty(), "有运行态 → 不降级");
    assert!(report.recovered.len() == 1);

    // 会话作为当前运行会话存在（不 500）。
    assert_eq!(svc_b.current_session_id().as_deref(), Some(id.as_str()));

    // 账户一致。
    let acct = svc_b.get_account(&id).unwrap();
    close(acct.cash, persisted.cash);
    close(acct.realized_pnl, persisted.realized_pnl);
    close(acct.total_fee, persisted.total_fee);

    // 持仓一致。
    let pos = svc_b.get_positions(&id).await.unwrap();
    assert_eq!(pos.len(), persisted.positions.len());
    assert_eq!(pos[0].code, "510300");
    close(pos[0].qty, persisted.positions[0].qty);
    close(pos[0].avg_cost, persisted.positions[0].avg_cost);

    // PnL 一致。
    let pnl = svc_b.get_pnl(&id).unwrap();
    close(pnl.realized_pnl, persisted.realized_pnl);

    // 策略配置一致（编排器按持久化配置重建）。
    let cfg = svc_b.strategy_configs(&id).unwrap();
    assert_eq!(cfg.len(), 1);
    assert_eq!(cfg[0].strategy_id, "dual_ma");
    assert_eq!(cfg[0].version_id, "sv_dual_ma");
    assert_eq!(cfg[0].version, 1);

    // 策略查询不 500（重建编排器尚无 bar → 空评估；非 Err）。
    assert!(svc_b.get_strategy_analysis(&id).unwrap().is_empty());
    assert!(svc_b.get_strategy_signal(&id, "510300").unwrap().is_none());

    // 继续运行：喂新 bar → 评估成功（不 500）。
    let events = svc_b
        .process_bar(&id, "510300", dma_bar(200, 12.0))
        .await
        .unwrap();
    assert!(!events.is_empty(), "恢复后 process_bar 继续产生事件");
}

/// TDD③：无状态/损坏 → 标记 ended + 告警（不打崩，get_session 不 500）。
#[tokio::test]
async fn recover_sessions_degraded_when_no_state_marks_ended() {
    let store = Arc::new(MockSimStore::default());
    // 预置一个有 running 视图但**无 simsession_state** 的会话（模拟旧版遗留 running）。
    let id = "s_recover_no_state".to_string();
    store.sessions.lock().unwrap().insert(
        id.clone(),
        SimSessionView {
            id: id.clone(),
            name: "legacy".into(),
            cash_init: 1_000_000.0,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            start_ts: fixed_now(),
            end_ts: None,
            status: SimSessionStatus::Running,
            source: "manual".into(),
        },
    );

    let svc = service(store.clone());
    let report = svc.recover_sessions().await.unwrap();
    assert!(report.recovered.is_empty());
    assert_eq!(report.degraded, vec![id.clone()], "无状态 → 降级标记 ended");

    // 会话已 ended（降级），标记结果写入。
    let view = store.get_session(&id).await.unwrap().expect("会话存在");
    assert_eq!(view.status, SimSessionStatus::Ended, "降级会话标记 ended");
    let result = store
        .get_result(&id)
        .await
        .unwrap()
        .expect("降级结果已落库");
    assert!(
        result.metrics.as_object().unwrap().contains_key("note"),
        "降级结果带注解"
    );
    // 查 get_session 不 500（返回 ended + 结果）。
    let detail = svc
        .get_session(&id)
        .await
        .unwrap()
        .expect("get_session 不 500");
    assert_eq!(detail.session.status, SimSessionStatus::Ended);
    assert!(detail.result.is_some());
}

/// TDD④：幂等——同一实例二次 recover 不再收敛已恢复会话；已 ended 会话不受影响。
#[tokio::test]
async fn recover_sessions_is_idempotent() {
    let store = Arc::new(MockSimStore::default());
    let (svc_a, id) = configured_buy_service(store.clone()).await;
    feed_all(&svc_a, &id, &golden_buy_bars()).await;

    let svc_b = service(store.clone());
    let report1 = svc_b.recover_sessions().await.unwrap();
    assert!(report1.recovered.contains(&id), "首次恢复含会话");

    // 已恢复会话已在内存 → 二次恢复不再收敛它。
    let report2 = svc_b.recover_sessions().await.unwrap();
    assert!(
        !report2.recovered.contains(&id),
        "幂等：已恢复/在内存不再重复收敛"
    );

    // 已 ended 会话（正常 stop）不会被恢复。
    let store2 = Arc::new(MockSimStore::default());
    let (svc_c, id_c) = started(store2.clone()).await;
    assert!(svc_c.stop_session(&id_c).await.unwrap());
    let svc_d = service(store2.clone());
    let report3 = svc_d.recover_sessions().await.unwrap();
    assert!(
        report3.recovered.is_empty() && report3.degraded.is_empty(),
        "已 ended 会话不恢复"
    );
}

// ── 11-sim-live / 重启恢复：账户级 PnL（unrealized/net_profit）与持仓视图 close 复算自洽 ──

/// ⚠️ bug(深测) 回归：重启恢复后**账户级 unrealized/net_profit 不一致**，而持仓视图按 close 复算自洽。
/// 根因：运行态落盘（`build_live_state`）取内存 `position.latest`——模拟实盘 feed/manual 成交后**从未 mark_to_market**，
/// 故该值为默认 0.0 → 落盘 `latest_prices[code]=0.0`；恢复重建时 `unrealized=qty×(0−avg_cost)=−qty×avg_cost`（大额漂移）。
/// 修复：恢复重建每仓 `latest` 优先用行情源 close（与 `get_positions` 同源）还原，使账户级 PnL 与持仓视图自洽。
/// 本测试：买入后不打市值 → 恢复 → `get_account.unrealized` 应 == 持仓视图（close 复算）的值；且二次恢复不累积。
#[tokio::test]
async fn recover_after_unmarked_positions_pnl_matches_position_view() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    // 行情源最新 close = 11.0（模拟盘后真实收盘/打市值价；成交价含滑点≈10.002）。
    kline.set_latest("510300", dma_bar(100, 11.0));
    let svc_a = service(store.clone()).with_kline(kline.clone());
    let view = svc_a
        .start_session(&StartSessionReq {
            name: "t-unmark".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let sid = view.id.clone();

    // 手动买入，但**从未 mark_to_market**（模拟真实 sim-live 路径：feed 只 process_bar，不打市值）。
    svc_a
        .place_order(
            &sid,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            10.0,
        )
        .await
        .unwrap()
        .expect("市价即成交");

    // 持仓视图（行情源 close 复算）即自洽基准值。
    let pos_before = svc_a.get_positions(&sid).await.unwrap();
    let avg_cost = pos_before[0].avg_cost;
    let expected_unrealized = 1000.0 * (11.0 - avg_cost);

    // 模拟重启：新服务实例（同一 store + 同一 kline）恢复。
    let svc_b = service(store.clone()).with_kline(kline.clone());
    let report = svc_b.recover_sessions().await.unwrap();
    assert!(report.recovered.contains(&sid), "应恢复该会话");
    assert!(report.degraded.is_empty(), "有运行态 → 不降级");

    // 恢复后账户级 unrealized 应与持仓视图自洽（修复前为 −qty×avg_cost 大额漂移）。
    let acct = svc_b.get_account(&sid).unwrap();
    close(acct.unrealized_pnl, expected_unrealized);
    let pnl = svc_b.get_pnl(&sid).unwrap();
    close(pnl.unrealized_pnl, expected_unrealized);
    close(pnl.net_profit, acct.realized_pnl + expected_unrealized);
    let pos_after = svc_b.get_positions(&sid).await.unwrap();
    close(pos_after[0].unrealized_pnl, expected_unrealized);

    // 二次恢复（再重建）不累积/不翻倍。
    let svc_c = service(store.clone()).with_kline(kline.clone());
    let report2 = svc_c.recover_sessions().await.unwrap();
    assert!(report2.recovered.contains(&sid));
    let acct2 = svc_c.get_account(&sid).unwrap();
    close(acct2.unrealized_pnl, expected_unrealized);
    close(acct2.unrealized_pnl, acct.unrealized_pnl); // 二次恢复与一次一致
}

/// bug 回归①：恢复后 unrealized=Σ(qty×(latest−avg_cost))、net_profit=realized+unrealized == 落盘快照。
/// 预置完整 state（cash/positions(latest)/realized）→ recover → get_account PnL == 落盘值（与快照一致）。
#[tokio::test]
async fn recover_reproduces_persisted_pnl_snapshot() {
    let store = Arc::new(MockSimStore::default());
    let sid = "s_state_snap".to_string();
    // 预置 running 视图。
    store.sessions.lock().unwrap().insert(
        sid.clone(),
        SimSessionView {
            id: sid.clone(),
            name: "snap".into(),
            cash_init: 1_000_000.0,
            strategy_set: vec![],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            start_ts: fixed_now(),
            end_ts: None,
            status: SimSessionStatus::Running,
            source: "manual".into(),
        },
    );
    // 预置运行态：买 1000@10、latest=11 → unrealized=1000；realized=200；fee=5。
    let state = SimSessionState {
        cash: 1_000_000.0 - 1000.0 * 10.0 - 5.0,
        realized_pnl: 200.0,
        total_fee: 5.0,
        positions: vec![SimPositionRow {
            session_id: sid.clone(),
            code: "510300".into(),
            qty: 1000.0,
            avg_cost: 10.0,
        }],
        latest_prices: std::collections::BTreeMap::from([("510300".into(), 11.0)]),
        net_value_series: vec![(1, 1_000_000.0), (2, 999_995.0)],
        trading_enabled: false,
        strategy_configs: serde_json::json!([]),
        orders: serde_json::json!([]),
        updated_at: fixed_now(),
    };
    store
        .states
        .lock()
        .unwrap()
        .insert(sid.clone(), state.clone());

    let svc = service(store.clone()); // 不注入 kline → 纯落盘还原（用 latest_prices）。
    let report = svc.recover_sessions().await.unwrap();
    assert!(report.recovered.contains(&sid), "恢复该会话");
    let acct = svc.get_account(&sid).unwrap();
    close(acct.realized_pnl, 200.0);
    close(acct.unrealized_pnl, 1000.0 * (11.0 - 10.0)); // = 1000
    let pnl = svc.get_pnl(&sid).unwrap();
    close(pnl.net_profit, 200.0 + 1000.0); // realized + unrealized
    close(pnl.total_fee, 5.0);

    // 二次恢复（再重建）不累积/不翻倍。
    let svc2 = service(store.clone());
    let report2 = svc2.recover_sessions().await.unwrap();
    assert!(report2.recovered.contains(&sid));
    let acct2 = svc2.get_account(&sid).unwrap();
    close(acct2.unrealized_pnl, 1000.0);
    close(acct2.realized_pnl, 200.0);
    close(acct2.cash, state.cash);
}

// ── 12-strategy-system / P4a：切源 wire / 钉住 / position 注入 / G5 事件流 / 恢复 ──

/// position 门控插件（空仓 80 / 持仓 20；position 注入端到端验证用）。
const POSITION_GATE_JS: &str = "function on_bar(ctx) { return ctx.position === null ? 80 : 20; }";
/// 每 bar 抛错插件（G5 事件流验证用）。
const THROWER_JS: &str = "function on_bar(ctx) { throw new Error('boom'); }";

impl MockStrategyStore {
    /// 播种指定版本号的 published 版本（version_id = sv_{id}_v{n}；多版本钉住测试用）。
    fn seed_published_version(&self, strategy_id: &str, version: i32, code: &str) {
        let now = fixed_now();
        let vid = format!("sv_{strategy_id}_v{version}");
        self.versions.lock().unwrap().insert(
            vid.clone(),
            StrategyVersionRow {
                id: vid,
                strategy_id: strategy_id.to_string(),
                version,
                code: code.to_string(),
                params_schema: serde_json::json!([]),
                sha256: application::strategy::sha256_hex(code),
                status: StrategyStatus::Published,
                approval_level: ApprovalLevel::BacktestOk,
                created_at: now,
                published_at: Some(now),
            },
        );
    }
    /// 播种 draft 版本（未发布拒绝路径用）。
    fn seed_draft(&self, strategy_id: &str, version: i32, code: &str) {
        let vid = format!("sv_{strategy_id}_v{version}");
        self.versions.lock().unwrap().insert(
            vid.clone(),
            StrategyVersionRow {
                id: vid,
                strategy_id: strategy_id.to_string(),
                version,
                code: code.to_string(),
                params_schema: serde_json::json!([]),
                sha256: application::strategy::sha256_hex(code),
                status: StrategyStatus::Draft,
                approval_level: ApprovalLevel::BacktestOk,
                created_at: fixed_now(),
                published_at: None,
            },
        );
    }
}

fn req_with(strategies: Vec<StrategyConfigInput>) -> StartSessionReq {
    StartSessionReq {
        name: "p4a".into(),
        cash_init: None,
        strategy_set: vec![],
        stock_set: vec![],
        period: "M1".into(),
        source: "manual".into(),
        buy_long_threshold: None,
        sell_threshold: None,
        strategies,
    }
}

fn input(strategy_id: &str, stocks: &[&str]) -> StrategyConfigInput {
    StrategyConfigInput {
        strategy_id: strategy_id.into(),
        version_id: None,
        params: serde_json::json!({}),
        stocks: stocks.iter().map(|s| s.to_string()).collect(),
        weight: 1.0,
        stock_weights: HashMap::new(),
    }
}

/// wire 错误路径：旧内建 id（dual_ma_v0 不存在这种——这里用真实旧 id 形态 "not_in_registry" /
/// 以及注册表确实没有的 "dual_ma_old"）→ InvalidConfig + 引导 strategy_list。
#[tokio::test]
async fn p4a_unknown_strategy_id_rejected_with_guidance() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    let err = svc
        .start_session(&req_with(vec![input("dual_ma_old_builtin", &["510300"])]))
        .await
        .unwrap_err();
    let e = err.downcast_ref::<InvalidConfig>().expect("InvalidConfig");
    assert!(e.0.contains("未知策略 id"), "提示未知策略：{}", e.0);
    assert!(e.0.contains("strategy_list"), "引导 strategy_list：{}", e.0);
    assert!(e.0.contains("旧内建 id"), "注明旧内建废止：{}", e.0);
    assert!(store.created.lock().unwrap().is_empty(), "拒绝即不落库");
}

/// wire 错误路径：无 published 版本 → InvalidConfig。
#[tokio::test]
async fn p4a_no_published_version_rejected() {
    let store = Arc::new(MockSimStore::default());
    let reg = default_registry();
    reg.seed_draft("dual_ma", 9, "function on_bar(ctx) { return 50; }"); // 仅多一个 draft；published v1 仍在
    // 造一个只有 draft 的策略
    reg.create_strategy(&NewStrategy {
        id: "st_only_draft".into(),
        name: "仅草稿".into(),
        description: String::new(),
        kind: StrategyKind::Strategy,
        created_by: "test".into(),
    })
    .await
    .unwrap();
    reg.seed_draft("st_only_draft", 1, "function on_bar(ctx) { return 50; }");
    let svc = service(store.clone()).with_strategies(reg);
    let err = svc
        .start_session(&req_with(vec![input("st_only_draft", &["510300"])]))
        .await
        .unwrap_err();
    let e = err.downcast_ref::<InvalidConfig>().expect("InvalidConfig");
    assert!(e.0.contains("无 published 版本"), "提示无 published：{}", e.0);
}

/// wire 错误路径：显式 version_id 为 draft / 属于其他策略 → InvalidConfig。
#[tokio::test]
async fn p4a_explicit_version_id_must_be_published_and_owned() {
    let store = Arc::new(MockSimStore::default());
    let reg = default_registry();
    reg.seed_draft("dual_ma", 2, "function on_bar(ctx) { return 55; }");
    let svc = service(store.clone()).with_strategies(reg);
    // draft 版本拒绝
    let mut i1 = input("dual_ma", &["510300"]);
    i1.version_id = Some("sv_dual_ma_v2".into());
    let err = svc.start_session(&req_with(vec![i1])).await.unwrap_err();
    let e = err.downcast_ref::<InvalidConfig>().expect("InvalidConfig");
    assert!(e.0.contains("未发布"), "draft 版本拒绝：{}", e.0);
    // 张冠李戴
    let mut i2 = input("dual_ma", &["510300"]);
    i2.version_id = Some("sv_momentum".into()); // 属于 momentum
    let err = svc.start_session(&req_with(vec![i2])).await.unwrap_err();
    let e = err.downcast_ref::<InvalidConfig>().expect("InvalidConfig");
    assert!(e.0.contains("不属于"), "版本归属校验：{}", e.0);
}

/// 钉住：缺省 = 最新 published；显式 version_id = 钉住该版本（非最新）。
#[tokio::test]
async fn p4a_pinning_latest_published_by_default_and_explicit_version() {
    let store = Arc::new(MockSimStore::default());
    let reg = default_registry();
    reg.seed_published_version("dual_ma", 2, "function on_bar(ctx) { return 66; }");
    // 缺省 → 最新 published（v2，66 分）。
    let svc = service(store.clone()).with_strategies(reg.clone());
    let view = svc.start_session(&req_with(vec![input("dual_ma", &["510300"])])).await.unwrap();
    let sid = view.id.clone();
    let pinned = svc.strategy_configs(&sid).unwrap();
    assert_eq!(pinned[0].version, 2, "缺省钉住最新 published");
    assert_eq!(pinned[0].version_id, "sv_dual_ma_v2");
    let ev = svc.process_bar(&sid, "510300", dma_bar(100, 10.0)).await.unwrap();
    assert_eq!(ev.len(), 1);
    close(ev[0].score, 66.0);
    svc.stop_session(&sid).await.unwrap();

    // 显式钉住 v1（参考插件真身，单 bar 数据不足 → 中立 50）。
    let svc2 = service(store.clone()).with_strategies(reg);
    let mut i1 = input("dual_ma", &["510300"]);
    i1.version_id = Some("sv_dual_ma".into());
    let view = svc2.start_session(&req_with(vec![i1])).await.unwrap();
    let pinned = svc2.strategy_configs(&view.id).unwrap();
    assert_eq!(pinned[0].version, 1, "显式钉住 v1");
    assert_eq!(
        pinned[0].sha256,
        application::strategy::sha256_hex(reference_plugin_code("dual_ma")),
        "sha256 钉住"
    );
}

/// 上限校验（ADR §4 沿用）：>3 策略 / 单策略 >30 股 → InvalidConfig。
#[tokio::test]
async fn p4a_limits_3_strategies_30_stocks() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    // 4 策略
    let four = vec![
        input("dual_ma", &["510300"]),
        input("dual_ma", &["510300"]),
        input("momentum", &["510300"]),
        input("momentum", &["510300"]),
    ];
    let err = svc.start_session(&req_with(four)).await.unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "4 策略拒绝");
    // 31 股
    let stocks: Vec<String> = (0..31).map(|i| format!("51{i:04}")).collect();
    let mut i1 = input("dual_ma", &["510300"]);
    i1.stocks = stocks;
    let err = svc.start_session(&req_with(vec![i1])).await.unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "31 股拒绝");
}

/// Registry 未注入 → 带策略启动明确报错（引导装配）。
#[tokio::test]
async fn p4a_registry_not_injected_errors() {
    let store = Arc::new(MockSimStore::default());
    let svc = SimLiveService::new(store.clone(), Arc::new(FixedClock(fixed_now())), backtest::FeeModel::default());
    let err = svc.start_session(&req_with(vec![input("dual_ma", &["510300"])])).await.unwrap_err();
    let e = err.downcast_ref::<InvalidConfig>().expect("InvalidConfig");
    assert!(e.0.contains("Registry 未注入"), "{}", e.0);
}

/// 阈值倒挂 → InvalidConfig；合法自定义阈值钉住并用于信号判定。
#[tokio::test]
async fn p4a_custom_thresholds_pinned_and_used() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    let mut req = req_with(vec![input("dual_ma", &["510300"])]);
    req.buy_long_threshold = Some(40.0);
    req.sell_threshold = Some(60.0); // 倒挂
    assert!(svc.start_session(&req).await.is_err(), "阈值倒挂拒绝");

    // 自定义阈值 30/70：金叉 80 ≥ 70? no → hold；默认 60 → buy。用 30/70 验证生效。
    let svc2 = service(store.clone());
    let mut gate_in = input("dual_ma", &["510300"]);
    gate_in.params = serde_json::json!({"fast": 2.0, "slow": 3.0});
    let mut req2 = req_with(vec![gate_in]);
    req2.buy_long_threshold = Some(70.0);
    req2.sell_threshold = Some(30.0);
    let view = svc2.start_session(&req2).await.unwrap();
    assert_eq!(svc2.pinned_thresholds(&view.id), Some((70.0, 30.0)));
    let last = feed_all(&svc2, &view.id, &golden_buy_bars()).await;
    // 金叉分 80 ≥ 70 → buy 仍成立；死叉 20 ≤ 30 → sell。
    assert_eq!(last[0].signal, "buy");
    close(last[0].aggregate_score, 80.0);
}

/// position 注入端到端（ABI §2.5）：空仓 80 → 聚合 buy → 自动建仓；持仓后 20 → sell → 平仓。
#[tokio::test]
async fn p4a_position_injection_drives_gate_plugin() {
    let store = Arc::new(MockSimStore::default());
    let reg = default_registry();
    reg.seed_published("gate", "门控", POSITION_GATE_JS, serde_json::json!([]));
    let svc = service(store.clone()).with_strategies(reg);
    let view = svc.start_session(&req_with(vec![input("gate", &["510300"])])).await.unwrap();
    let sid = view.id.clone();
    svc.set_trading(&sid, true).await.unwrap();

    // bar1：空仓 → 80 → buy（建仓 100 股）。
    let ev1 = svc.process_bar(&sid, "510300", dma_bar(100, 10.0)).await.unwrap();
    assert_eq!(ev1.len(), 1);
    close(ev1[0].score, 80.0);
    assert_eq!(ev1[0].signal, "buy");
    assert!(ev1[0].ordered, "空仓 80 分达阈值 → 下单");
    let pos = svc.get_positions(&sid).await.unwrap();
    assert_eq!(pos.len(), 1, "已建仓");

    // bar2：持仓 → 20 → sell（清仓）。
    let ev2 = svc.process_bar(&sid, "510300", dma_bar(101, 10.5)).await.unwrap();
    close(ev2[0].score, 20.0);
    assert_eq!(ev2[0].signal, "sell");
    assert!(ev2[0].ordered);
    let pos = svc.get_positions(&sid).await.unwrap();
    assert!(pos.is_empty(), "已清仓");
    assert_eq!(store.trades.lock().unwrap().len(), 2, "买+卖两笔成交");
}

/// G5 事件流端到端：thrower 插件每 bar 抛错 → plugin_error ×10（带 sha256/bar_index）
/// + circuit_breaker ×1；熔断后不再产该策略评分（无覆盖 → 中立 50 → hold）。
#[tokio::test]
async fn p4a_g5_events_stream_and_circuit_breaker() {
    let store = Arc::new(MockSimStore::default());
    let reg = default_registry();
    reg.seed_published("thrower", "抛错", THROWER_JS, serde_json::json!([]));
    let svc = service(store.clone()).with_strategies(reg);
    let view = svc.start_session(&req_with(vec![input("thrower", &["510300"])])).await.unwrap();
    let sid = view.id.clone();

    let n = strategy_core::CIRCUIT_BREAKER_THRESHOLD as usize;
    for i in 0..n + 2 {
        let ev = svc.process_bar(&sid, "510300", dma_bar(100 + i as i64, 10.0)).await.unwrap();
        if i < n {
            assert_eq!(ev.len(), 1, "错误 bar 仍产信号事件（中立分 50）");
            close(ev[0].score, 50.0);
            assert_eq!(ev[0].signal, "hold");
        } else {
            assert!(ev.is_empty(), "熔断后无覆盖 → 无信号事件");
        }
    }
    let events = svc.session_events(&sid, 100).unwrap();
    let errors = events
        .iter()
        .filter(|e| matches!(e, simlive::SessionEvent::PluginError { .. }))
        .count();
    let breakers = events
        .iter()
        .filter(|e| matches!(e, simlive::SessionEvent::CircuitBreaker { .. }))
        .count();
    assert_eq!(errors, n, "plugin_error × {n}");
    assert_eq!(breakers, 1, "circuit_breaker × 1");
    // 事件自含 sha256/bar_index/strategy_id。
    match &events[0] {
        simlive::SessionEvent::PluginError { strategy_id, sha256, bar_index, code, .. } => {
            assert_eq!(strategy_id, "thrower");
            assert_eq!(sha256.as_str(), application::strategy::sha256_hex(THROWER_JS));
            assert_eq!(bar_index, &0);
            assert_eq!(code, "510300");
        }
        other => panic!("首事件应为 PluginError，got {other:?}"),
    }
    // 熔断后聚合中立 50 → 不产交易信号（开关开也不下单）。
    svc.set_trading(&sid, true).await.unwrap();
    let _ = svc.process_bar(&sid, "510300", dma_bar(200, 10.0)).await.unwrap();
    assert!(svc.get_positions(&sid).await.unwrap().is_empty(), "熔断后不下单");
}

/// 恢复失败（P4a 口径）：钉住版本被 archived → recover 降级 ended + 告警（不打崩）。
#[tokio::test]
async fn p4a_recover_degrades_when_pinned_version_archived() {
    let store = Arc::new(MockSimStore::default());
    let reg = default_registry();
    let svc_a = service(store.clone()).with_strategies(reg.clone());
    let view = svc_a.start_session(&req_with(vec![input("dual_ma", &["510300"])])).await.unwrap();
    let sid = view.id.clone();
    feed_all(&svc_a, &sid, &golden_buy_bars()).await;
    assert!(store.get_state(&sid).await.unwrap().is_some(), "运行态已落盘");

    // 版本 archived（published→archived 合法流转）→ 恢复应失败降级。
    reg.archive_version("sv_dual_ma");
    let svc_b = service(store.clone()).with_strategies(reg);
    let report = svc_b.recover_sessions().await.unwrap();
    assert!(!report.recovered.contains(&sid), "archived → 不恢复");
    assert!(report.degraded.contains(&sid), "降级 ended");
    let view = store.get_session(&sid).await.unwrap().unwrap();
    assert_eq!(view.status, SimSessionStatus::Ended);
    let result = store.get_result(&sid).await.unwrap().unwrap();
    assert!(result.metrics.to_string().contains("中断"), "降级注解留痕");
}

/// 恢复失败（P4a 口径）：切源前旧形状 strategy_configs（数组非空）→ 降级 ended。
#[tokio::test]
async fn p4a_recover_degrades_legacy_builtin_configs() {
    let store = Arc::new(MockSimStore::default());
    let sid = "s_legacy".to_string();
    store.sessions.lock().unwrap().insert(
        sid.clone(),
        SimSessionView {
            id: sid.clone(),
            name: "legacy".into(),
            cash_init: 1_000_000.0,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            start_ts: fixed_now(),
            end_ts: None,
            status: SimSessionStatus::Running,
            source: "manual".into(),
        },
    );
    store.states.lock().unwrap().insert(
        sid.clone(),
        SimSessionState {
            cash: 1_000_000.0,
            realized_pnl: 0.0,
            total_fee: 0.0,
            positions: vec![],
            latest_prices: Default::default(),
            net_value_series: vec![(1, 1_000_000.0)],
            trading_enabled: false,
            // 切源前旧形状：内建策略 id 数组。
            strategy_configs: serde_json::json!([{"id": "dual_ma", "params": {}, "stocks": ["510300"], "weight": 1.0, "stock_weights": {}}]),
            orders: serde_json::json!([]),
            updated_at: fixed_now(),
        },
    );
    let svc = service(store.clone());
    let report = svc.recover_sessions().await.unwrap();
    assert!(report.degraded.contains(&sid), "旧形状降级 ended");
    let view = store.get_session(&sid).await.unwrap().unwrap();
    assert_eq!(view.status, SimSessionStatus::Ended);
}

/// 恢复成功（P4a 口径）：新快照 + Registry 一致 → 重建编排器续跑（process_bar 产事件）。
/// （主恢复路径已由 recover_sessions_restores_running_session_and_continues 覆盖；
/// 本用例补：恢复后插件评分真实可用 + 钉住配置完整。）
#[tokio::test]
async fn p4a_recover_reinstantiates_plugin_and_continues() {
    let store = Arc::new(MockSimStore::default());
    let svc_a = service(store.clone());
    let mut dma_in = input("dual_ma", &["510300"]);
    dma_in.params = serde_json::json!({"fast": 2.0, "slow": 3.0});
    let view = svc_a.start_session(&req_with(vec![dma_in])).await.unwrap();
    let sid = view.id.clone();
    feed_all(&svc_a, &sid, &golden_buy_bars()).await;

    let svc_b = service(store.clone());
    let report = svc_b.recover_sessions().await.unwrap();
    assert!(report.recovered.contains(&sid));
    let pinned = svc_b.strategy_configs(&sid).unwrap();
    assert_eq!(pinned.len(), 1);
    assert_eq!(pinned[0].version_id, "sv_dual_ma");
    assert_eq!(pinned[0].name, "双均线交叉", "name 快照恢复");
    // 恢复后插件真实评分（金叉序列重喂 → buy 区 80）。
    let last = feed_all(&svc_b, &sid, &golden_buy_bars()).await;
    assert_eq!(last.len(), 1);
    close(last[0].aggregate_score, 80.0);
    assert_eq!(last[0].signal, "buy");
}

/// feed_targets：纯手动会话（无策略）不产轮询目标；带策略会话返回钉住覆盖标的。
#[tokio::test]
async fn p4a_feed_targets_from_pinned_configs_only() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    // 纯手动会话 → 无目标。
    let view = svc
        .start_session(&StartSessionReq {
            name: "manual".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![],
        })
        .await
        .unwrap();
    assert!(svc.feed_targets().unwrap().is_empty(), "纯手动会话不轮询");
    svc.stop_session(&view.id).await.unwrap();
    // 带策略（strategy_set 回退）→ 目标 = 钉住标的集。
    let view2 = svc
        .start_session(&StartSessionReq {
            name: "with-strat".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: vec![],
        })
        .await
        .unwrap();
    let targets = svc.feed_targets().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].session_id, view2.id);
    assert_eq!(targets[0].codes, vec!["510300".to_string()]);
}

// ── P4a 评审修复（MINOR-1/MINOR-3b/MINOR-4）：在飞窗口守卫 + actor 生命周期 + 阈值夹中立 50 ──

use application::simlive_orch::spawn_orchestrator_with;
use simlive::{PluginStrategyConfig, PluginStrategyOrchestrator};
use strategy_runtime::{BarCtx, ParamDef, PluginError, PluginInstance, PluginRuntime};

/// 测试用编排器配置（code 对 Mock 运行时无意义；hash 仅作标识）。
fn orch_cfg(strategy_id: &str, stocks: &[&str]) -> PluginStrategyConfig {
    PluginStrategyConfig {
        strategy_id: strategy_id.into(),
        version_id: format!("sv_{strategy_id}"),
        version: 1,
        sha256: format!("sha_{strategy_id}"),
        name: strategy_id.into(),
        code: format!("// {strategy_id}"),
        params: backtest::StrategyParams::new(),
        stocks: stocks.iter().map(|s| s.to_string()).collect(),
        weight: 1.0,
        stock_weights: HashMap::new(),
    }
}

/// MINOR-1 故障注入：门控插件——on_bar 进入时发 entered 信号并**阻塞至测试释放**，
/// 使 `process_bar` 阶段 2（锁外 await worker）确定性地「在飞」，构造 stop/重配与
/// 迟到结果的竞态窗口（无门控则该窗口为微秒级竞态，测试不可复现）。
struct GatedInstance {
    score: f64,
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

impl PluginInstance for GatedInstance {
    fn on_bar(&mut self, _ctx: &BarCtx<'_>) -> Result<f64, PluginError> {
        let _ = self.entered.send(());
        // 阻塞 worker 线程直至测试释放（测试必须先 stop/重配再 release）。
        let _ = self.release.recv();
        Ok(self.score)
    }
    fn save(&self) -> Result<Option<serde_json::Value>, PluginError> {
        Ok(None)
    }
    fn load(&mut self, _state: &serde_json::Value) -> Result<(), PluginError> {
        Ok(())
    }
    fn params_schema(&self) -> &[ParamDef] {
        &[]
    }
}

/// 门控运行时（仅支持 1 策略×1 标的——release Receiver 只能移动一次）。
struct GatedRuntime {
    score: f64,
    entered: std::sync::mpsc::Sender<()>,
    release: Option<std::sync::mpsc::Receiver<()>>,
}

impl PluginRuntime for GatedRuntime {
    fn instantiate(
        &mut self,
        _code_hash: &str,
        _code: &str,
        _params: &backtest::StrategyParams,
    ) -> Result<Box<dyn PluginInstance>, PluginError> {
        let release = self
            .release
            .take()
            .ok_or_else(|| PluginError::JsException("gated runtime 仅支持单实例".into()))?;
        Ok(Box::new(GatedInstance {
            score: self.score,
            entered: self.entered.clone(),
            release,
        }))
    }
}

/// MINOR-3b 故障注入：on_bar 直接 panic 的插件（Rust 侧 panic；JS 异常由运行时捕获走 G5，
/// 不构成 worker 死亡路径）。
struct PanicInstance;
impl PluginInstance for PanicInstance {
    fn on_bar(&mut self, _ctx: &BarCtx<'_>) -> Result<f64, PluginError> {
        panic!("fault injection: on_bar panic");
    }
    fn save(&self) -> Result<Option<serde_json::Value>, PluginError> {
        Ok(None)
    }
    fn load(&mut self, _state: &serde_json::Value) -> Result<(), PluginError> {
        Ok(())
    }
    fn params_schema(&self) -> &[ParamDef] {
        &[]
    }
}

struct PanicRuntime;
impl PluginRuntime for PanicRuntime {
    fn instantiate(
        &mut self,
        _code_hash: &str,
        _code: &str,
        _params: &backtest::StrategyParams,
    ) -> Result<Box<dyn PluginInstance>, PluginError> {
        Ok(Box::new(PanicInstance))
    }
}

/// MINOR-1：会话 stop 发生在 feed 评估**在飞**期间 → 迟到的评估结果不得落账
/// （ended 会话不补成交 sim_trades、不写 latest、不产信号事件）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p4a_late_feed_after_stop_does_not_trade() {
    let store = Arc::new(MockSimStore::default());
    let (svc_inst, id) = started(store.clone()).await;
    let svc = Arc::new(svc_inst);
    svc.set_trading(&id, true).await.unwrap();
    // 注入门控编排器（score=80 ≥ 60 → 若无守卫，迟到结果会下 buy 单）。
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let handle = spawn_orchestrator_with(move || {
        let mut rt = GatedRuntime { score: 80.0, entered: entered_tx, release: Some(release_rx) };
        PluginStrategyOrchestrator::new(vec![orch_cfg("gated", &["510300"])], 60.0, 40.0, &mut rt)
    })
    .expect("spawn gated worker");
    svc.__test_inject_orchestrator(&id, handle).unwrap();

    // 在飞：process_bar 阶段 2 阻塞于门控插件。
    let svc2 = svc.clone();
    let sid = id.clone();
    let feed =
        tokio::spawn(async move { svc2.process_bar(&sid, "510300", dma_bar(100, 10.0)).await });
    // 等 worker 进入 on_bar（确定性在飞窗口）。
    tokio::task::spawn_blocking(move || entered_rx.recv())
        .await
        .unwrap()
        .expect("worker 已进入 on_bar");
    // stop 在评估在飞期间完成 → 会话 ended + 编排器句柄 drop。
    assert!(svc.stop_session(&id).await.unwrap(), "stop 成功");
    // 释放门控 → 迟到结果返回给调用方。
    release_tx.send(()).unwrap();
    let events = feed.await.unwrap().expect("process_bar 调用本身不报错");
    assert!(events.is_empty(), "迟到结果不产信号事件");
    assert!(store.trades.lock().unwrap().is_empty(), "ended 会话不落 sim_trades");
    assert!(svc.get_orders(&id).unwrap().is_empty(), "无订单落账");
    assert!(
        svc.get_strategy_signal(&id, "510300").unwrap().is_none(),
        "迟到结果不写 latest"
    );
}

/// MINOR-1 同源窗口：configure_strategies 重配发生在 feed 在飞期间 → 旧 worker 的迟到
/// 评估不得写入 latest（代际检查；否则展示层看到已替换策略集的旧评分）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p4a_late_eval_from_replaced_worker_does_not_pollute_latest() {
    let store = Arc::new(MockSimStore::default());
    let (svc_inst, id) = started(store.clone()).await;
    let svc = Arc::new(svc_inst);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let handle = spawn_orchestrator_with(move || {
        let mut rt = GatedRuntime { score: 80.0, entered: entered_tx, release: Some(release_rx) };
        PluginStrategyOrchestrator::new(vec![orch_cfg("gated", &["510300"])], 60.0, 40.0, &mut rt)
    })
    .expect("spawn gated worker");
    svc.__test_inject_orchestrator(&id, handle).unwrap();

    let svc2 = svc.clone();
    let sid = id.clone();
    let feed =
        tokio::spawn(async move { svc2.process_bar(&sid, "510300", dma_bar(100, 10.0)).await });
    tokio::task::spawn_blocking(move || entered_rx.recv())
        .await
        .unwrap()
        .expect("worker 已进入 on_bar");
    // 重配（换成 momentum 真实插件 worker）→ 旧句柄 drop + latest.clear + 代际 +1。
    svc.configure_strategies(&id, vec![input("momentum", &["510300"])])
        .await
        .unwrap();
    release_tx.send(()).unwrap();
    let events = feed.await.unwrap().expect("process_bar 调用本身不报错");
    assert!(events.is_empty(), "旧 worker 迟到 eval 不产信号事件");
    assert!(
        svc.get_strategy_signal(&id, "510300").unwrap().is_none(),
        "旧 worker 迟到 eval 不写 latest"
    );
}

/// MINOR-3b（应用层）：worker 线程内真实 panic（故障注入）→ 调用方收 OrchestratorDead →
/// SimLiveService 记错误事件 + 会话降级 ended（不毒化服务，裁决契约 ② 端到端）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p4a_worker_panic_degrades_session_to_ended() {
    let store = Arc::new(MockSimStore::default());
    let (svc_inst, id) = started(store.clone()).await;
    let svc = Arc::new(svc_inst);
    svc.set_trading(&id, true).await.unwrap();
    let handle = spawn_orchestrator_with(|| {
        let mut rt = PanicRuntime;
        PluginStrategyOrchestrator::new(vec![orch_cfg("panicky", &["510300"])], 60.0, 40.0, &mut rt)
    })
    .expect("spawn panicking worker");
    svc.__test_inject_orchestrator(&id, handle).unwrap();

    let err = svc
        .process_bar(&id, "510300", dma_bar(100, 10.0))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("worker"), "OrchestratorDead：{err}");
    // 会话降级 ended：内存 + 落库一致。
    assert!(svc.current_session_id().is_none(), "降级后无 running 会话");
    let detail = svc.get_session(&id).await.unwrap().expect("会话在库");
    assert_eq!(detail.session.status, SimSessionStatus::Ended, "降级 ended");
    // 降级错误事件入流（诊断留痕）。
    let events = svc.session_events(&id, 10).unwrap();
    assert!(
        events.iter().any(|e| matches!(e, simlive::SessionEvent::PluginError { error, .. } if error.contains("降级"))),
        "降级事件入流：{events:?}"
    );
    // 降级后再 feed → 明确错误（编排器已 drop），服务不崩。
    assert!(svc.process_bar(&id, "510300", dma_bar(101, 10.0)).await.is_err());
    // 不下单、不落成交。
    assert!(store.trades.lock().unwrap().is_empty());
}

/// MINOR-4：会话阈值须夹中立 50（与 strategy-core `EnsembleConfig::validate` 同规；
/// web 映射 400 / MCP isError）——buy=45/sell=40 这类「中立 50 误判 buy」配置显式拒绝。
#[tokio::test]
async fn p4a_thresholds_must_straddle_neutral_50() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    // buy=45/sell=40：buy 未过中立 50 → 全熔断中立 50 会误判 buy → 拒绝（web 400）。
    let mut req = req_with(vec![input("dual_ma", &["510300"])]);
    req.buy_long_threshold = Some(45.0);
    req.sell_threshold = Some(40.0);
    let err = svc.start_session(&req).await.unwrap_err();
    let e = err.downcast_ref::<InvalidConfig>().expect("InvalidConfig（web 400）");
    assert!(e.0.contains("50"), "错误说明夹中立 50 契约：{}", e.0);
    // buy 恰值 50（须严格大于）→ 拒绝。
    let mut req2 = req_with(vec![input("dual_ma", &["510300"])]);
    req2.buy_long_threshold = Some(50.0);
    let err = svc.start_session(&req2).await.unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "buy=50 拒绝");
    // sell 恰值 50（须严格小于）→ 拒绝。
    let mut req3 = req_with(vec![input("dual_ma", &["510300"])]);
    req3.sell_threshold = Some(50.0);
    let err = svc.start_session(&req3).await.unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "sell=50 拒绝");
    // sell 超 50 → 拒绝。
    let mut req4 = req_with(vec![input("dual_ma", &["510300"])]);
    req4.sell_threshold = Some(55.0);
    let err = svc.start_session(&req4).await.unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "sell=55 拒绝");
    // 合法夹 50 自定义阈值仍可用（30/70 已由 p4a_custom_thresholds_pinned_and_used 覆盖）。
}
