//! 策略 Registry 服务（application 层，12-strategy-system / P2a；手写，非 tangle）。
//! 依赖注入 domain 端口 `StrategyStore` + `BacktestBarRead` + `Clock`，并经
//! `strategy-runtime`（QuickJS 冒烟/试算）与 `strategy-core`（sim_position 试算引擎）；
//! 不依赖 web/storage/sqlx（DI 由 app bin 装配）。
//!
//! 职责（ADR 12-strategy-system §5/§13.5）：
//! - Registry CRUD：create_strategy（v1 draft）/ versions / diff / catalog（仅 published，
//!   approval_level at-least 过滤）。
//! - 版本编辑：`update_draft`——draft 原地更新；**published 被编辑时自动落新 draft**
//!   （version+1，ADR §13.5 防呆）；archived 拒绝（409）。
//! - 状态机：draft→published→archived 单向（`domain::strategy_state` 纯函数校验，非法 → 409）；
//!   published 不可变另有 DB trigger 双保险（schema §4.3.13）。
//! - **发布门禁**：`publish` 前以 `QuickJsRuntime` 真实实例化冒烟（eval + PARAMS_SCHEMA 解析 +
//!   on_bar 存在 + init(defaults) 两阶段），通过才计算 sha256 并 draft→published。
//! - **在线试算 `test_run`**：pure_score（裸评分，position 恒 None）/ sim_position
//!   （单 slot EnsembleEngine：默认阈值 60/40 + LumpSum pct=1.0 + 默认 FeeModel）；
//!   收紧 RuntimeLimits（per_call 20ms / 内存 32MB）；区间上限 D1≤5年 / 分钟级≤3个月。
//! - **参考插件播种**：strategy 表为空时将 strategy-core::reference 的 7 款插件 + 4 模板
//!   以 published 入库（幂等：按 name+sha256 存在则跳过）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::Digest;

use domain::ports::{
    BacktestBarRead, CatalogEntry, Clock, NewStrategy, NewStrategyVersion, StrategyManageItem,
    StrategyRow, StrategyStore, StrategyVersionRow,
};
use domain::strategy_state::{validate_transition, ApprovalLevel, StrategyKind, StrategyStatus};
use strategy_runtime::{
    BarCtx, ParamDef, PluginRuntime, QuickJsRuntime, RuntimeLimits, StrategyParams,
};

// 复用回测服务的周期解析口径（M1/M5/M15/D1；H1 拒绝）。
pub use crate::bar_map::parse_period;

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// 试算收紧限额（任务书：per_call 20ms / 内存 32MB；实例化时限沿用默认公式 max(20×per_call,1s)=1s）。
pub const TEST_RUN_PER_CALL_TIMEOUT_MS: u64 = 20;
pub const TEST_RUN_MEMORY_LIMIT: usize = 32 * 1024 * 1024;

/// 试算返回截断上限（防巨包）：评分点 50_000（覆盖 1m×3个月 ≈ 2.2 万 bar 上限全量）、
/// 事件 1_000、成交 5_000。截断口径：超出上限即丢弃尾部并在 `truncated` 标记。
pub const MAX_SCORE_POINTS: usize = 50_000;
pub const MAX_EVENTS: usize = 1_000;
pub const MAX_TRADES: usize = 5_000;

/// 试算区间上限：日线 ≤ 5 年（366×5 天含闰年冗余）/ 分钟级（M1/M5/M15）≤ 3 个月（93 天）。
pub const D1_MAX_SPAN_DAYS: i64 = 366 * 5;
pub const MINUTE_MAX_SPAN_DAYS: i64 = 93;

/// sim_position 试算默认初始资金（与回测 ADR §4 默认一致）。
pub const DEFAULT_TEST_RUN_CAPITAL: f64 = 100_000.0;

fn test_run_limits() -> RuntimeLimits {
    let per_call_timeout = Duration::from_millis(TEST_RUN_PER_CALL_TIMEOUT_MS);
    RuntimeLimits {
        per_call_timeout,
        instantiate_timeout: (per_call_timeout * 20).max(Duration::from_secs(1)),
        memory_limit: TEST_RUN_MEMORY_LIMIT,
    }
}

/// 应用层生成 id（st_/sv_ 前缀，simsession 的 s_<ts>_<seq> 同口径）。
/// P3a：pub(crate) 供 workbench 复用（sr_/sp_ 前缀）。
pub(crate) fn new_id(prefix: &str, now: DateTime<Utc>) -> String {
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}_{:06}", now.timestamp_millis(), n)
}

/// sha256 内容哈希（ABI G4 寻址；hex 小写）。
pub fn sha256_hex(code: &str) -> String {
    let mut h = sha2::Sha256::new();
    h.update(code.as_bytes());
    format!("{:x}", h.finalize())
}

// ── 错误类型（web 映射：NotFound→404 / InvalidTransition→409 / Validation→400）──

/// 未找到（策略/版本）。web 映射 404。
#[derive(Debug, Clone, PartialEq)]
pub struct StrategyNotFound(pub String);
impl std::fmt::Display for StrategyNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for StrategyNotFound {}

/// 非法状态流转（状态机拒绝）。web 映射 409。
#[derive(Debug, Clone, PartialEq)]
pub struct StrategyInvalidTransition(pub String);
impl std::fmt::Display for StrategyInvalidTransition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for StrategyInvalidTransition {}

/// 校验失败（入参/发布门禁/区间上限）。web 映射 400。
#[derive(Debug, Clone, PartialEq)]
pub struct StrategyValidation(pub String);
impl std::fmt::Display for StrategyValidation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for StrategyValidation {}

// ── 请求/响应类型 ──

/// 新建策略输入（web 层已做非空预校验；服务层同口径防御复核）。
#[derive(Debug, Clone, PartialEq)]
pub struct CreateStrategyInput {
    pub name: String,
    pub description: String,
    pub kind: StrategyKind,
    pub code: String,
}

/// update_draft 结果：draft 原地更新 / published 自动落新 draft（ADR §13.5）。
#[derive(Debug, Clone, PartialEq)]
pub enum UpdateDraftOutcome {
    Updated(StrategyVersionRow),
    NewDraft(StrategyVersionRow),
}

/// 试算代码来源（二选一）。
#[derive(Debug, Clone, PartialEq)]
pub enum TestRunSource {
    /// 内联 JS 源码（编辑器即写即跑）。
    Inline(String),
    /// 已存版本（draft/published 均可试算）。
    VersionId(String),
}

/// 试算模式（ADR §13.5 双模式）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestRunMode {
    /// 裸评分（position 恒 null，看原始反应）。
    PureScore,
    /// 模拟持仓（单 slot EnsembleEngine：默认 60/40 阈值 + LumpSum pct=1.0 + 默认 FeeModel）。
    SimPosition,
}

/// 试算请求（web 层完成 JSON 解析与 from<to 预校验）。
#[derive(Debug, Clone, PartialEq)]
pub struct TestRunRequest {
    pub source: TestRunSource,
    pub params: serde_json::Value,
    pub symbol: String,
    pub period: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub mode: TestRunMode,
}

/// 评分点（score=None：插件熔断停用后的 bar）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScorePoint {
    pub ts: i64,
    pub score: Option<f64>,
}

/// 信号点（sim_position 模式逐 bar 信号）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SignalPoint {
    pub ts: i64,
    pub signal: String,
}

/// 试算事件（插件日志/插件错误/熔断；JSON 便于前端直渲）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TestRunEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub bar_index: usize,
    pub message: String,
}

/// 截断标记（true = 该项超出上限被截尾）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub struct Truncation {
    pub scores: bool,
    pub events: bool,
    pub trades: bool,
}

/// 试算响应（同步执行结果）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TestRunResponse {
    pub mode: TestRunMode,
    pub symbol: String,
    pub period: String,
    pub bar_count: usize,
    pub scores: Vec<ScorePoint>,
    /// sim_position 模式逐 bar 信号；pure_score 恒空。
    pub signals: Vec<SignalPoint>,
    /// sim_position 模式成交明细（backtest::TradeDetail JSON）；pure_score 恒空数组。
    pub trades: serde_json::Value,
    pub events: Vec<TestRunEvent>,
    pub truncated: Truncation,
}

/// 播种报告。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedReport {
    pub seeded: usize,
    pub skipped: usize,
}

// ── 运行时冒烟 / schema 提取（同步 QuickJS 段；一律经 spawn_blocking 执行，不阻塞 async executor）──

/// spawn_blocking 包装（与 service.rs:242 回测引擎同模式）：QuickJS 非 Send 实例在闭包内
/// 创建/drop，不跨 await 持有；JoinError（panic）转 anyhow。
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> anyhow::Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| anyhow!("阻塞任务 panic: {e}"))
}

/// 最佳-effort schema 提取：实例化成功 → 插件声明的 PARAMS_SCHEMA；失败 → None
/// （draft 允许暂存坏代码，发布门禁兜底）。**同步函数——调用点须经 `blocking`**。
fn extract_schema(code: &str) -> Option<Vec<ParamDef>> {
    let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
    rt.instantiate("sha256:draft", code, &StrategyParams::new())
        .ok()
        .map(|inst| inst.params_schema().to_vec())
}

/// 按 schema 默认值构建参数对象（发布门禁第二阶段 / 试算缺省填充）。
fn defaults_params(schema: &[ParamDef]) -> StrategyParams {
    schema
        .iter()
        .map(|p| (p.key.clone(), backtest::ParamValue::Num(p.default)))
        .collect()
}

/// **发布门禁**：QuickJsRuntime 真实实例化冒烟（ADR 任务书口径）。
/// 两阶段：① 空参实例化（eval 源码 + on_bar 存在 + PARAMS_SCHEMA 解析）；
/// ② 按 schema 默认值填参再实例化（验证 init(params) 路径）。
/// 通过 → 插件声明的 schema；失败 → 错误描述（400）。**同步函数——调用点须经 `blocking`**。
fn publish_smoke(code: &str, code_hash: &str) -> Result<Vec<ParamDef>, String> {
    let schema = {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        let inst = rt
            .instantiate(code_hash, code, &StrategyParams::new())
            .map_err(|e| format!("发布门禁未通过（eval/on_bar/schema 冒烟）: {e}"))?;
        inst.params_schema().to_vec()
    };
    {
        let mut rt = QuickJsRuntime::new(RuntimeLimits::default());
        rt.instantiate(code_hash, code, &defaults_params(&schema))
            .map_err(|e| format!("发布门禁未通过（init(params) 冒烟）: {e}"))?;
    }
    Ok(schema)
}

/// 参数校验 + 缺省填充（ABI §1 NIT-6：Registry/消费方职责）。
/// 规则：params 须为对象；未知键拒绝；值须为数值；声明 min/max 越界拒绝；缺省按键默认值填充。
/// P3a：pub(crate) 供 workbench submit/preset 校验复用。
pub(crate) fn fill_and_validate_params(
    schema: &[ParamDef],
    params: &serde_json::Value,
) -> Result<StrategyParams, String> {
    let obj = params
        .as_object()
        .ok_or_else(|| "params 应为对象".to_string())?;
    for (k, v) in obj {
        let def = schema
            .iter()
            .find(|d| &d.key == k)
            .ok_or_else(|| format!("未知参数键: {k}（schema 未声明）"))?;
        let n = v
            .as_f64()
            .ok_or_else(|| format!("参数 {k} 须为数值，got {v}"))?;
        if let Some(min) = def.min {
            if n < min {
                return Err(format!("参数 {k}={n} 低于 min={min}"));
            }
        }
        if let Some(max) = def.max {
            if n > max {
                return Err(format!("参数 {k}={n} 高于 max={max}"));
            }
        }
    }
    let mut out = defaults_params(schema);
    for (k, v) in obj {
        out.insert(k.clone(), backtest::ParamValue::Num(v.as_f64().expect("已校验数值")));
    }
    Ok(out)
}

fn schema_to_json(schema: &[ParamDef]) -> serde_json::Value {
    serde_json::to_value(schema).expect("ParamDef 可序列化")
}

pub(crate) fn schema_from_json(v: &serde_json::Value) -> Vec<ParamDef> {
    serde_json::from_value(v.clone()).unwrap_or_default()
}

/// `domain::types::Bar -> backtest::Bar`（ts 转 Unix 秒；volume 转 f64；与 bar_map.rs 同口径）。
fn to_bt_bar(b: &domain::types::Bar) -> backtest::Bar {
    backtest::Bar {
        ts: b.ts.timestamp(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume as f64,
    }
}

/// 策略 Registry 服务。
pub struct StrategyService {
    store: Arc<dyn StrategyStore>,
    bar_read: Arc<dyn BacktestBarRead>,
    clock: Arc<dyn Clock>,
}

impl StrategyService {
    pub fn new(
        store: Arc<dyn StrategyStore>,
        bar_read: Arc<dyn BacktestBarRead>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { store, bar_read, clock }
    }

    /// 新建策略（v1 draft；sha256 创建即计算，schema 最佳-effort 提取——draft 允许暂存坏代码）。
    pub async fn create_strategy(
        &self,
        input: &CreateStrategyInput,
    ) -> anyhow::Result<(StrategyRow, StrategyVersionRow)> {
        if input.name.trim().is_empty() {
            return Err(StrategyValidation("name 必填".into()).into());
        }
        if input.code.trim().is_empty() {
            return Err(StrategyValidation("code 必填".into()).into());
        }
        let now = self.clock.now();
        let sha = sha256_hex(&input.code);
        let code = input.code.clone();
        let schema_json = blocking(move || extract_schema(&code))
            .await?
            .map(|s| schema_to_json(&s))
            .unwrap_or_else(|| serde_json::json!([]));
        let strategy = self
            .store
            .create_strategy(&NewStrategy {
                id: new_id("st", now),
                name: input.name.trim().to_string(),
                description: input.description.clone(),
                kind: input.kind,
                created_by: "local".into(),
            })
            .await?;
        let version = self
            .store
            .create_version(&NewStrategyVersion {
                id: new_id("sv", now),
                strategy_id: strategy.id.clone(),
                version: 1,
                code: input.code.clone(),
                params_schema: schema_json,
                sha256: sha,
            })
            .await?;
        Ok((strategy, version))
    }

    /// 读策略（404）。
    pub async fn get_strategy(&self, id: &str) -> anyhow::Result<StrategyRow> {
        self.store
            .get_strategy(id)
            .await?
            .ok_or_else(|| anyhow!(StrategyNotFound(format!("策略不存在: {id}"))))
    }

    /// 版本列表（version 升序；策略不存在 → 404）。
    pub async fn list_versions(&self, strategy_id: &str) -> anyhow::Result<Vec<StrategyVersionRow>> {
        self.get_strategy(strategy_id).await?;
        self.store.list_versions(strategy_id).await
    }

    /// 读版本（404）。
    pub async fn get_version(&self, version_id: &str) -> anyhow::Result<StrategyVersionRow> {
        self.store
            .get_version(version_id)
            .await?
            .ok_or_else(|| anyhow!(StrategyNotFound(format!("版本不存在: {version_id}"))))
    }

    /// 从指定版本新建 draft（回滚/派生：版本号 = max+1，代码继承源版本）。
    pub async fn create_draft_from(
        &self,
        strategy_id: &str,
        from_version_id: &str,
    ) -> anyhow::Result<StrategyVersionRow> {
        self.get_strategy(strategy_id).await?;
        let src = self.get_version(from_version_id).await?;
        if src.strategy_id != strategy_id {
            return Err(StrategyValidation(format!(
                "版本 {from_version_id} 不属于策略 {strategy_id}"
            ))
            .into());
        }
        let now = self.clock.now();
        let n = self.store.next_version_number(strategy_id).await?;
        let sha = sha256_hex(&src.code);
        let code = src.code.clone();
        let schema_json = blocking(move || extract_schema(&code))
            .await?
            .map(|s| schema_to_json(&s))
            .unwrap_or_else(|| serde_json::json!([]));
        self.store
            .create_version(&NewStrategyVersion {
                id: new_id("sv", now),
                strategy_id: strategy_id.into(),
                version: n,
                code: src.code,
                params_schema: schema_json,
                sha256: sha,
            })
            .await
    }

    /// 编辑版本代码：draft → 原地更新；published → **自动落新 draft**（version+1，ADR §13.5）；
    /// archived → 409。
    pub async fn update_draft(
        &self,
        version_id: &str,
        code: &str,
    ) -> anyhow::Result<UpdateDraftOutcome> {
        if code.trim().is_empty() {
            return Err(StrategyValidation("code 必填".into()).into());
        }
        let v = self.get_version(version_id).await?;
        let sha = sha256_hex(code);
        let code_owned = code.to_string();
        let schema_json = blocking(move || extract_schema(&code_owned))
            .await?
            .map(|s| schema_to_json(&s))
            .unwrap_or_else(|| serde_json::json!([]));
        match v.status {
            StrategyStatus::Draft => {
                let row = self
                    .store
                    .update_draft(version_id, code, &schema_json, &sha)
                    .await?
                    .ok_or_else(|| anyhow!("update_draft 未命中（并发状态漂移）: {version_id}"))?;
                Ok(UpdateDraftOutcome::Updated(row))
            }
            StrategyStatus::Published => {
                // ADR §13.5：编辑已发布版本自动产生新 draft（防呆）。
                let now = self.clock.now();
                let n = self.store.next_version_number(&v.strategy_id).await?;
                let row = self
                    .store
                    .create_version(&NewStrategyVersion {
                        id: new_id("sv", now),
                        strategy_id: v.strategy_id.clone(),
                        version: n,
                        code: code.to_string(),
                        params_schema: schema_json,
                        sha256: sha,
                    })
                    .await?;
                Ok(UpdateDraftOutcome::NewDraft(row))
            }
            StrategyStatus::Archived => Err(StrategyInvalidTransition(
                validate_transition(StrategyStatus::Archived, StrategyStatus::Draft)
                    .expect_err("archived→draft 必非法")
                    .to_string(),
            )
            .into()),
        }
    }

    /// 发布：**门禁冒烟（eval+schema+on_bar+init(defaults)）通过** → sha256 → draft→published。
    /// 非 draft → 409；门禁失败 → 400。
    pub async fn publish(&self, version_id: &str) -> anyhow::Result<StrategyVersionRow> {
        let v = self.get_version(version_id).await?;
        if let Err(e) = validate_transition(v.status, StrategyStatus::Published) {
            return Err(StrategyInvalidTransition(e.to_string()).into());
        }
        let sha = sha256_hex(&v.code);
        // 冒烟为同步阻塞段：经 spawn_blocking 执行（QuickJS 非 Send 实例在闭包内创建/drop）。
        let smoke_code = v.code.clone();
        let smoke_sha = sha.clone();
        let schema = blocking(move || publish_smoke(&smoke_code, &smoke_sha))
            .await?
            .map_err(StrategyValidation)?;
        // 乐观并发（TOCTOU 防护）：传入冒烟过的 code 原文；0 行命中 = 版本已被并发修改 → 409。
        let row = self
            .store
            .mark_published(version_id, &v.code, &sha, &schema_to_json(&schema), self.clock.now())
            .await?
            .ok_or_else(|| {
                anyhow!(StrategyInvalidTransition(format!(
                    "发布冲突：版本 {version_id} 已被并发修改或不再是 draft（请刷新后重试）"
                )))
            })?;
        Ok(row)
    }

    /// 归档：published→archived（唯一合法来源）；其余 → 409。
    pub async fn archive(&self, version_id: &str) -> anyhow::Result<StrategyVersionRow> {
        let v = self.get_version(version_id).await?;
        if let Err(e) = validate_transition(v.status, StrategyStatus::Archived) {
            return Err(StrategyInvalidTransition(e.to_string()).into());
        }
        let row = self
            .store
            .set_status(version_id, StrategyStatus::Archived)
            .await?
            .ok_or_else(|| anyhow!("set_status 未命中: {version_id}"))?;
        Ok(row)
    }

    /// catalog（仅 published，每策略最新 published 版本；level at-least 过滤）。
    pub async fn catalog(
        &self,
        level: Option<ApprovalLevel>,
        kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<CatalogEntry>> {
        self.store.catalog(level, kind).await
    }

    /// 管理列表（P2b：GET /api/strategies/manage）——**全部策略（含仅 draft / 零版本）**，
    /// 聚合 version_count / latest_version（版本号最大，任意状态）/ latest_published（无 → None）。
    pub async fn manage_list(
        &self,
        kind: Option<StrategyKind>,
    ) -> anyhow::Result<Vec<StrategyManageItem>> {
        self.store.manage_list(kind).await
    }

    /// 更新策略元数据（P2b：PATCH /api/strategies/{id}）。
    /// 校验（400）：name/description 均为 None；name trim 后为空。未知 id → 404。
    /// 合并口径：未给字段保持原值；name trim 后落库；命中推进 updated_at（storage）。
    pub async fn update_meta(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
    ) -> anyhow::Result<StrategyRow> {
        if name.is_none() && description.is_none() {
            return Err(StrategyValidation("name/description 至少提供一个".into()).into());
        }
        if let Some(n) = name {
            if n.trim().is_empty() {
                return Err(StrategyValidation("name trim 后为空".into()).into());
            }
        }
        let cur = self.get_strategy(id).await?; // 未知 id → 404
        let new_name = name.map(|n| n.trim().to_string()).unwrap_or(cur.name);
        let new_description = description.map(str::to_string).unwrap_or(cur.description);
        self.store
            .update_meta(id, &new_name, &new_description)
            .await?
            .ok_or_else(|| anyhow!(StrategyNotFound(format!("策略不存在: {id}"))))
    }

    /// diff：取两版本（前端渲染 diff）；任一未知 → 404。
    pub async fn diff(
        &self,
        from_version_id: &str,
        to_version_id: &str,
    ) -> anyhow::Result<(StrategyVersionRow, StrategyVersionRow)> {
        let from = self.get_version(from_version_id).await?;
        let to = self.get_version(to_version_id).await?;
        Ok((from, to))
    }

    /// 在线试算（同步执行；ADR §13.5 双模式 + 区间上限 + 收紧限额）。
    pub async fn test_run(&self, req: &TestRunRequest) -> anyhow::Result<TestRunResponse> {
        if req.symbol.trim().is_empty() {
            return Err(StrategyValidation("symbol（标的代码）必填".into()).into());
        }
        if req.from >= req.to {
            return Err(StrategyValidation("from 须早于 to".into()).into());
        }
        // 代码 + schema 来源：内联代码须先过冒烟（坏代码 → 400）；版本取库存 code/schema。
        let (code, schema) = match &req.source {
            TestRunSource::Inline(code) => {
                if code.trim().is_empty() {
                    return Err(StrategyValidation("code 必填".into()).into());
                }
                let sha = sha256_hex(code);
                let smoke_code = code.clone();
                let schema = blocking(move || publish_smoke(&smoke_code, &sha))
                    .await?
                    .map_err(StrategyValidation)?;
                (code.clone(), schema)
            }
            TestRunSource::VersionId(vid) => {
                let v = self.get_version(vid).await?;
                let schema = schema_from_json(&v.params_schema);
                // 版本可能为 draft（未过门禁）：同口径冒烟兜底（坏代码 → 400）。
                let schema = if schema.is_empty() {
                    let sha = sha256_hex(&v.code);
                    let smoke_code = v.code.clone();
                    blocking(move || publish_smoke(&smoke_code, &sha))
                        .await?
                        .map_err(StrategyValidation)?
                } else {
                    schema
                };
                (v.code, schema)
            }
        };
        let params = fill_and_validate_params(&schema, &req.params).map_err(StrategyValidation)?;

        let (domain_period, bt_period) = crate::bar_map::parse_period(&req.period)
            .map_err(|e| StrategyValidation(e.to_string()))?;
        // 区间上限（400）：D1 ≤ 5 年；分钟级（M1/M5/M15）≤ 3 个月。
        let span_days = (req.to - req.from).num_days();
        let limit_days = match domain_period {
            domain::types::Period::D1 => D1_MAX_SPAN_DAYS,
            _ => MINUTE_MAX_SPAN_DAYS,
        };
        if span_days > limit_days {
            return Err(StrategyValidation(format!(
                "试算区间超限：{period} 跨度 {span_days} 天 > 上限 {limit_days} 天",
                period = req.period
            ))
            .into());
        }

        let bars: Vec<backtest::Bar> = self
            .bar_read
            .bars(req.symbol.trim(), &domain_period, req.from, req.to)
            .await?
            .iter()
            .map(to_bt_bar)
            .collect();
        if bars.is_empty() {
            return Err(StrategyValidation(format!(
                "区间内无 K 线数据（{} {} {}~{}）",
                req.symbol, req.period, req.from, req.to
            ))
            .into());
        }

        // 以下为同步引擎段：经 spawn_blocking 执行（QuickJS 非 Send 实例在闭包内创建/drop）。
        let code_hash = sha256_hex(&code);
        let mode = req.mode;
        let req_owned = req.clone();
        blocking(move || match mode {
            TestRunMode::PureScore => Ok(run_pure_score(&req_owned, &code, &code_hash, &params, &bars)),
            TestRunMode::SimPosition => {
                run_sim_position(&req_owned, &code, &code_hash, &params, &bars, bt_period)
            }
        })
        .await?
    }

    /// 参考插件播种（启动时）：strategy 表为空 → 7 参考插件（kind=strategy）+ 4 官方模板
    /// （kind=template）以 published 入库；幂等——按 name+sha256 存在则跳过。
    /// 选址 application 层（非 app 装配层）：播种是 Registry 领域行为（与 create/publish 同
    /// 一套状态机/sha256 口径），可在 service 测试中以 mock store 锁定幂等语义；app bin 仅调用。
    /// 免发布门禁：播种内容 = 仓内 fixture 字节（strategy-core::reference），契约测试已锁定。
    pub async fn seed_reference_plugins(&self) -> anyhow::Result<SeedReport> {
        if self.store.count_strategies().await? > 0 {
            return Ok(SeedReport { seeded: 0, skipped: 0 });
        }
        let mut report = SeedReport { seeded: 0, skipped: 0 };
        let entries: Vec<(strategy_core::reference::ReferencePlugin, StrategyKind)> =
            strategy_core::reference::reference_plugins()
                .into_iter()
                .map(|p| (p, StrategyKind::Strategy))
                .chain(
                    strategy_core::reference::official_templates()
                        .into_iter()
                        .map(|t| (t, StrategyKind::Template)),
                )
                .collect();
        for (plugin, kind) in entries {
            let sha = sha256_hex(plugin.code);
            if self
                .store
                .find_version_by_name_sha(plugin.name, &sha)
                .await?
                .is_some()
            {
                report.skipped += 1;
                continue;
            }
            let now = self.clock.now();
            let seed_code = plugin.code.to_string();
            let schema_json = blocking(move || extract_schema(&seed_code))
                .await?
                .map(|s| schema_to_json(&s))
                .unwrap_or_else(|| serde_json::json!([]));
            let strategy = self
                .store
                .create_strategy(&NewStrategy {
                    id: new_id("st", now),
                    name: plugin.name.to_string(),
                    description: plugin.description.to_string(),
                    kind,
                    created_by: "seed".into(),
                })
                .await?;
            let version = self
                .store
                .create_version(&NewStrategyVersion {
                    id: new_id("sv", now),
                    strategy_id: strategy.id,
                    version: 1,
                    code: plugin.code.to_string(),
                    params_schema: schema_json.clone(),
                    sha256: sha.clone(),
                })
                .await?;
            self.store
                .mark_published(&version.id, plugin.code, &sha, &schema_json, now)
                .await?
                .ok_or_else(|| anyhow!("播种 mark_published 未命中: {}", version.id))?;
            report.seeded += 1;
        }
        Ok(report)
    }
}

/// pure_score 试算：逐 bar on_bar（position 恒 None）；G5 语义——错误 bar 中立分 50 +
/// 错误事件，连续 10 次熔断停用（后续 bar score=None）。
fn run_pure_score(
    req: &TestRunRequest,
    code: &str,
    code_hash: &str,
    params: &StrategyParams,
    bars: &[backtest::Bar],
) -> TestRunResponse {
    let mut scores = Vec::with_capacity(bars.len());
    let mut events = Vec::new();
    let mut truncated = Truncation::default();
    let mut consecutive_errors = 0u32;
    let mut disabled = false;

    let mut rt = QuickJsRuntime::new(test_run_limits());
    let mut inst = match rt.instantiate(code_hash, code, params) {
        Ok(inst) => inst,
        Err(e) => {
            // 实例化失败（冒烟已前置，此处理论不达；防御性返回单事件空结果）。
            events.push(TestRunEvent {
                kind: "instantiate_error".into(),
                bar_index: 0,
                message: e.to_string(),
            });
            return TestRunResponse {
                mode: req.mode,
                symbol: req.symbol.clone(),
                period: req.period.clone(),
                bar_count: bars.len(),
                scores,
                signals: vec![],
                trades: serde_json::json!([]),
                events,
                truncated,
            };
        }
    };

    for (i, bar) in bars.iter().enumerate() {
        if scores.len() >= MAX_SCORE_POINTS {
            truncated.scores = true;
            break;
        }
        if disabled {
            scores.push(ScorePoint { ts: bar.ts, score: None });
            continue;
        }
        let ctx = BarCtx::new(i, bar.clone(), bars, None);
        let out = inst.on_bar(&ctx);
        for msg in ctx.take_logs() {
            if events.len() >= MAX_EVENTS {
                truncated.events = true;
            } else {
                events.push(TestRunEvent { kind: "log".into(), bar_index: i, message: msg });
            }
        }
        match out {
            Ok(score) => {
                consecutive_errors = 0;
                scores.push(ScorePoint { ts: bar.ts, score: Some(score) });
            }
            Err(e) => {
                consecutive_errors += 1;
                if events.len() >= MAX_EVENTS {
                    truncated.events = true;
                } else {
                    events.push(TestRunEvent {
                        kind: "plugin_error".into(),
                        bar_index: i,
                        message: e.to_string(),
                    });
                }
                scores.push(ScorePoint { ts: bar.ts, score: Some(strategy_core::NEUTRAL_SCORE) });
                if consecutive_errors >= strategy_core::CIRCUIT_BREAKER_THRESHOLD {
                    disabled = true;
                    if events.len() >= MAX_EVENTS {
                        truncated.events = true;
                    } else {
                        events.push(TestRunEvent {
                            kind: "circuit_breaker".into(),
                            bar_index: i,
                            message: format!("连续 {consecutive_errors} 次错误，本运行熔断停用"),
                        });
                    }
                }
            }
        }
    }

    TestRunResponse {
        mode: req.mode,
        symbol: req.symbol.clone(),
        period: req.period.clone(),
        bar_count: bars.len(),
        scores,
        signals: vec![],
        trades: serde_json::json!([]),
        events,
        truncated,
    }
}

/// sim_position 试算：单 slot EnsembleEngine（默认阈值 60/40 + LumpSum pct=1.0 + 默认 FeeModel，
/// ADR §13.5），收紧 RuntimeLimits。
fn run_sim_position(
    req: &TestRunRequest,
    code: &str,
    code_hash: &str,
    params: &StrategyParams,
    bars: &[backtest::Bar],
    period: backtest::Period,
) -> anyhow::Result<TestRunResponse> {
    let slot = strategy_core::StrategySlot::new(code, code_hash, params.clone(), 1.0)
        .map_err(StrategyValidation)?;
    let cfg = strategy_core::EnsembleConfig {
        slots: vec![slot],
        buy_threshold: strategy_core::DEFAULT_BUY_THRESHOLD,
        sell_threshold: strategy_core::DEFAULT_SELL_THRESHOLD,
        policy: strategy_core::ExecutionPolicy::LumpSum { position_pct: 1.0 },
        stop: None,
        initial_capital: DEFAULT_TEST_RUN_CAPITAL,
        fee: backtest::FeeModel::default(),
        period,
        runtime_limits: test_run_limits(),
    };
    let result = strategy_core::engine::run_ensemble_with_quickjs(&cfg, bars)
        .map_err(|e| StrategyValidation(format!("试算运行失败: {e}")))?;

    let mut truncated = Truncation::default();
    let mut scores = Vec::with_capacity(result.per_bar.len());
    let mut signals = Vec::with_capacity(result.per_bar.len());
    let mut events = Vec::new();
    for rec in &result.per_bar {
        if scores.len() >= MAX_SCORE_POINTS {
            truncated.scores = true;
            break;
        }
        scores.push(ScorePoint { ts: rec.ts, score: Some(rec.aggregate) });
        signals.push(SignalPoint {
            ts: rec.ts,
            signal: match rec.signal {
                strategy_core::TradeSignal::Buy => "buy",
                strategy_core::TradeSignal::Sell => "sell",
                strategy_core::TradeSignal::Hold => "hold",
            }
            .to_string(),
        });
        for ev in &rec.events {
            let (kind, bar_index, message) = match ev {
                strategy_core::EngineEvent::PluginLog { bar_index, msg, .. } => {
                    ("log", bar_index, msg.clone())
                }
                strategy_core::EngineEvent::PluginError { bar_index, error, .. } => {
                    ("plugin_error", bar_index, error.to_string())
                }
                strategy_core::EngineEvent::CircuitBreaker { bar_index, .. } => {
                    ("circuit_breaker", bar_index, "连续错误达阈值，本运行熔断停用".to_string())
                }
                strategy_core::EngineEvent::Fill { .. } => continue, // 成交走 trades 序列
            };
            let bar_index = *bar_index;
            if events.len() >= MAX_EVENTS {
                truncated.events = true;
            } else {
                events.push(TestRunEvent { kind: kind.into(), bar_index, message });
            }
        }
    }
    let trades = if result.trades.len() > MAX_TRADES {
        truncated.trades = true;
        serde_json::to_value(&result.trades[..MAX_TRADES]).expect("trades 可序列化")
    } else {
        serde_json::to_value(&result.trades).expect("trades 可序列化")
    };

    Ok(TestRunResponse {
        mode: req.mode,
        symbol: req.symbol.clone(),
        period: req.period.clone(),
        bar_count: bars.len(),
        scores,
        signals,
        trades,
        events,
        truncated,
    })
}
