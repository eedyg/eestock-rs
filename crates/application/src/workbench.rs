//! `WorkbenchService`（application 层，12-strategy-system / P3a；手写，非 tangle）。
//! 依赖注入 domain 端口（`BacktestBarRead`/`StrategyRunStore`/`StrategyPresetStore`/`StrategyStore`/
//! `SymbolRegistry`/`StrategyRunProgressSink`/`Clock`）+ `strategy-core`（EnsembleEngine 观察者入口）；
//! 不依赖 web/storage/sqlx（DI 由 app bin 装配）。
//!
//! 职责（ADR 12-strategy-system §6 管线 / §8 接口 / §11 P3 范围 / §13.4 全量落库 / §13.5 组合预设）：
//! - **任务制 ensemble 运行**（与 BacktestService 同模式）：submit 校验 → 入库 queued →
//!   `tokio::spawn` 后台任务（`Semaphore` 限并发）→ `mark_started` 原子认领（queued→running，
//!   防「排队期被取消后又被执行」）→ `spawn_blocking` 跑
//!   `strategy_core::run_ensemble_with_quickjs_observed`（QuickJS 非 Send 实例在闭包内创建/drop）→
//!   观察者钩子（每 bar 末回调点）做两件事：①进度经 mpsc 桥接到异步报告任务
//!   （WS sink 逐帧推送，0..1，按 0.1% 粒度产生帧；**落库**按 ≥250ms 时间窗节流且终态必写，
//!   ADR-024 D15）；②**协作式取消**——
//!   检查内存取消标记（cancel() 设置），置位即 `LoopControl::Break` → `EnsembleError::Canceled`
//!   → 落 canceled（不落结果）。完成 `mark_succeeded`（同事务落五 jsonb 结果）/ 插件错误
//!   `mark_failed`。
//! - **运行钉住快照**：submit 时把 (strategy_id, version_id, version, sha256, params[缺省填充],
//!   weight, archived) 快照进 `config`（复现前提，published 不可变由 0022 trigger 保证 sha256 不失配；
//!   `archived` 为审计标记——2026-09-10 裁决：archived 版本允许审计重跑）。
//! - 提交校验全路径（400/404）：版本存在（404）且非 draft（400；published|archived 可运行——
//!   archived 为审计重跑，draft 未发布代码不可运行）；symbol 已注册（400）；
//!   区间上限 D1≤5年 / 分钟级≤3个月（400）；slots 1..=10；weight>0；params 按 schema 校验填充；
//!   阈值/Policy 经 `EnsembleConfig::validate`（strategy-core）；Stop value 正有限；fee 三字段；
//!   bar 数 ≥ `GUARD_CONFIRM_BARS`（500_000，≈M1 五年）需二次确认、> `MAX_BARS_GUARD`
//!   （2_000_000）硬拒（400 `resource_guard`；两常量与契约向量绑定）。
//! - 查询：get_run / list_runs（分页+状态过滤）/ compare（并排 net_value+metrics，输入序，
//!   未知/未成功跳过）。
//! - 组合预设：create/list/get/update/delete/apply（apply=返回钉住 config 供 submit 用；
//!   重名 409——预检查 find_preset_by_name，DB UNIQUE 兜底）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::Semaphore;
use tracing::Instrument;

use domain::ports::{
    BacktestBarRead, Clock, NewStrategyPreset, NewStrategyRun, StrategyPresetRow,
    FeeProfileStore, ResultChunk, ResultKind, StrategyPresetStore, StrategyRunFilter,
    StrategyRunResult, StrategyRunStore, StrategyRunView, StrategyStore, SymbolRegistry,
    RESULT_FORMAT_CHUNKED, RESULT_FORMAT_LEGACY,
};
use strategy_core::{BarRecord, EnsembleConfig, EnsembleError, EnsembleSession, ExecutionPolicy, LoopControl, StopConfig};
use strategy_runtime::{QuickJsRuntime, StrategyParams};

use crate::fee::{resolve_fee, to_fee_model};
use crate::strategy::{fill_and_validate_params, new_id, schema_from_json};

/// 单次 ensemble 运行并发上限（与回测同口径，ADR §7 默认 4；由 DI 传入）。
pub static DEFAULT_MAX_CONCURRENT: usize = 4;

// ── ADR-024 P5 / D1：资源护栏（**删除一切日历天数档**后的唯一物理护栏） ──
// 实现落在 `crate::error`（workbench 与试算同口径共用）；此处 re-export 保留既有导入路径。
pub use crate::error::{
    estimate_secs, guard_bars, range_empty_error, GUARD_CONFIRM_BARS, MAX_BARS_GUARD,
};

use crate::error::codes;

/// 结果分块大小（ADR-024 D8/D4：chunk = 5,000 根；`strategy_run_bars` 每块行数）。
pub const RESULT_CHUNK_BARS: usize = 5_000;
/// `GET /bars` 分页 `limit` 默认值（= 一个分块）。
pub const BARS_LIMIT_DEFAULT: i64 = 5_000;
/// `GET /bars` 分页 `limit` 上限（防单包过大）。
pub const BARS_LIMIT_MAX: i64 = 20_000;
/// `GET /curve` 目标点数 `k` 默认值。
pub const CURVE_K_DEFAULT: usize = 2_000;
/// `GET /curve` 目标点数 `k` 上限。
pub const CURVE_K_MAX: usize = 20_000;
/// `POST /compare` 净值曲线抽样目标点数默认值（ADR-024 D9/D10）。
pub const COMPARE_K_DEFAULT: usize = 2_000;

/// 进度上报节流粒度：0.1%（每 bar 回调仅当千分位前进或最后一 bar 才发帧，防 20 万帧洪泛）。
const PROGRESS_THROTTLE_MILLI: f64 = 1000.0;

/// ADR-024 D15：**进度落库**时间窗节流（≥ 此间隔才 `store.update_progress` 一次）。
///
/// 分工（不改帧粒度、只降落库频率）：
/// - **WS 帧粒度不变** —— 引擎 observer 仍按 [`PROGRESS_THROTTLE_MILLI`] 产生帧、每帧仍 `sink.send`（保 UI 流畅）；
/// - **落库降频** —— report 任务（consumer）距上次 `store.update_progress` 不足本间隔则**跳过落库**，
///   仅暂存最近一帧；
/// - **终态必写** —— 通道关闭（引擎结束）后，若最后一帧因节流未落库则补写一次；另 `progress>=1.0`
///   的完成帧无条件落库 ⇒ 完成/失败/取消三条路径的最终进度**写入都不会被时间窗节流吞掉**
///   （写调用是否在 DB 生效仍受既有 `store.update_progress` 的 `status='running'` 守卫约束）。
///
/// 依据：每 run 固定 1003 次 `UPDATE strategy_run`（1001 帧 + 2 状态迁移）≈ 0.85–3.45 s，
/// 占端到端时长 ~95%（ADR-024 §2.6 / D15 实测）。
const PROGRESS_DB_MIN_INTERVAL: Duration = Duration::from_millis(250);

/// 默认初始资金（与回测/试算一致，ADR §4）。
const DEFAULT_INITIAL_CAPITAL: f64 = 100_000.0;

/// I-2/D6：缺省前置预热根数（架构师 2026-09-12 裁决；与试算同值）。
pub const DEFAULT_WARMUP_BARS: usize = 250;

// ── 错误类型（web 映射：NotFound→404 / Conflict→409 / Validation→400）──

/// 未找到（run/preset/版本）。web 映射 404。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkbenchNotFound(pub String);
impl std::fmt::Display for WorkbenchNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for WorkbenchNotFound {}

/// 冲突（终态取消 / 预设重名）。web 映射 409。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkbenchConflict(pub String);
impl std::fmt::Display for WorkbenchConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for WorkbenchConflict {}

/// 校验失败（入参/区间/配置/bar 数）。web 映射 400。
///
/// ADR-024 §3.1.1：携带 `code`（错误码，与**产生该消息的校验点**同源）+ `message`（人类可读）。
/// web 侧一律取 [`WorkbenchValidation::code`] 组装 `{error:{code,message,detail}}`；**禁止**解析消息文本。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkbenchValidation {
    pub code: &'static str,
    pub message: String,
}

impl WorkbenchValidation {
    /// 构造（`code` 取 `application::error::codes` 常量）。
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// 错误码（ADR-024 §3.1.1；稳定标识）。
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// 人类可读消息。
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for WorkbenchValidation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for WorkbenchValidation {}

// ── 请求/响应类型 ──

/// 提交槽位（web 层 JSON 解析后传入）。
#[derive(Debug, Clone, PartialEq)]
pub struct SlotReq {
    /// 已发布版本 id（sv_ 前缀）。
    pub version_id: String,
    /// 参数（按版本 schema 校验/缺省填充；缺省 `{}`）。
    pub params: serde_json::Value,
    /// 聚合权重（>0 有限）。
    pub weight: f64,
}

/// 提交运行请求（web 层已完成 from/to RFC3339 解析与 from<to 预校验）。
#[derive(Debug, Clone, PartialEq)]
pub struct SubmitRunReq {
    /// 运行名（可空字符串，缺省 ''）。
    pub name: String,
    pub symbol: String,
    pub period: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub slots: Vec<SlotReq>,
    /// 缺省 60（ADR §6）。
    pub buy_threshold: Option<f64>,
    /// 缺省 40（ADR §6）。
    pub sell_threshold: Option<f64>,
    /// ExecutionPolicy JSON（serde 外部标签：`{"LumpSum":{"position_pct":..}}` / `{"Dca":{..}}`）。
    pub policy: serde_json::Value,
    /// StopConfig JSON（可空 = 无硬止损）。
    pub stop: Option<serde_json::Value>,
    /// 缺省 100_000。
    pub initial_capital: Option<f64>,
    /// `{rate_pct, min_fee, slippage_bp, stamp_duty_pct?}`；**None = 未显式传** →
    /// 按标的 `type` 查 `fee_profiles` 解析默认值（ADR-019 D11-3），无档案 → 回落旧 ADR bt-1 默认。
    pub fee: Option<serde_json::Value>,
    /// I-2/D6：前置预热根数（缺省 [`DEFAULT_WARMUP_BARS`]=250；0 = 无预热）。
    pub warmup_bars: usize,
    /// ADR-024 P5 / §3.1.1：资源护栏二次确认（预估 bar 数 ≥ [`GUARD_CONFIRM_BARS`] 时需 `true` 放行）。
    pub confirm: bool,
}

/// compare 并排条目（前端净值叠加 + 绩效并排，ADR §13.5）。
/// ADR-024 D9/D10：净值曲线经**显式抽样**（均匀保首尾），响应带 `downsampled` + `original_bars`。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CompareItem {
    pub run_id: String,
    pub name: String,
    pub symbol: String,
    pub period: String,
    pub net_value: serde_json::Value,
    pub metrics: serde_json::Value,
    /// 净值是否经抽样（false = 全量/未抽样）。
    pub downsampled: bool,
    /// 抽样前净值点数（downsampled=true 时用于提示）。
    pub original_bars: i64,
}

// ── ADR-024 P4 / D8-D10：结果读取读模型（web 直接序列化；application 不依赖 web） ──

/// `GET /runs/{id}/brief` 响应（轻量：列表/轮询用，避免拉大包）。
///
/// P5 备注：`effective_from/to` / `clamped` 在 P4 = 未收缩时期的真值（effective == from_ts/to_ts，
/// clamped=false）；`estimated_bars` 为 P5/D12 的提交预估值（P4 恒 null）。这些字段先占位，
/// 由 P5 填充，避免前端在 P5 改 wire。
#[derive(Debug, Clone, Serialize)]
pub struct ResultBrief {
    pub id: String,
    pub name: String,
    pub symbol: String,
    pub period: String,
    pub status: domain::ports::StrategyRunStatus,
    pub progress: f64,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub requested_from: DateTime<Utc>,
    pub requested_to: DateTime<Utc>,
    pub effective_from: DateTime<Utc>,
    pub effective_to: DateTime<Utc>,
    pub clamped: bool,
    pub estimated_bars: Option<i64>,
    /// per_bar 总根数（chunked = 由 chunk_count + 末块长度推得；legacy = 内联数组长度）。
    pub bars_total: i64,
    /// `legacy_single` | `chunked_v1`；无结果行为 None（未成功）。
    pub result_format: Option<String>,
    /// per_bar 分块数（legacy = 0——无 `strategy_run_bars` 行）。
    pub chunk_count: i64,
    /// 8 项绩效指标（无结果行为 None）。
    pub metrics: Option<serde_json::Value>,
}

/// `GET /runs/{id}/bars` 分页/区间读窗口（互斥；web 已保证不同时给）。
#[derive(Debug, Clone)]
pub enum BarsWindow {
    /// 序号分页（`offset` 以 bar 为单位；`limit` 默认 5000/上限 20000）。
    Offset { offset: i64, limit: i64 },
    /// 时间区间（跨 chunk；应用层在块内按 ts 精确过滤）。
    Range { from: DateTime<Utc>, to: DateTime<Utc> },
}

/// `GET /runs/{id}/bars` 响应。
#[derive(Debug, Clone, Serialize)]
pub struct BarsResponse {
    pub kind: String,
    pub bars: Vec<serde_json::Value>,
    pub total: i64,
    pub has_more: bool,
    pub next_offset: Option<i64>,
    /// 序号分页回声（区间读为 0）。
    pub offset: i64,
    pub limit: i64,
    /// 区间读回声（序号分页为 null）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<DateTime<Utc>>,
}

/// `GET /runs/{id}/fills` 响应（成交明细分页；ADR-024 P6：**有界精确源，禁止抽样**）。
///
/// 与 `/curve` 的语义差别：成交是**事实**，抽样会丢真实成交 ⇒ 只提供分页读。
#[derive(Debug, Clone, Serialize)]
pub struct FillsResponse {
    pub run_id: String,
    /// 成交总数（全量，不受分页影响）。
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
    pub has_more: bool,
    pub next_offset: Option<i64>,
    /// 事实源是否可得：`true` = 有 `kind='fills'` 块（chunked）或由内联 per_bar 事件派生（legacy）；
    /// `false` = **未写**（P6 之前的 chunked run 无 fills 块）⇒ 与「无成交」（`true`, `total=0`）可区分。
    pub recorded: bool,
    pub fills: Vec<serde_json::Value>,
}

/// `GET /runs/{id}/curve` 响应（显式抽样：ADR-024 D10 必须带 `downsampled` + `original_bars`）。
#[derive(Debug, Clone, Serialize)]
pub struct CurveResponse {
    pub kind: String,
    pub points: Vec<serde_json::Value>,
    pub downsampled: bool,
    pub original_bars: i64,
    pub k: i64,
}

/// `GET /runs/{id}/audit` 响应（ADR-026 §2.2）：**只读派生的执行完整度审计**。
///
/// `run_id` + [`crate::audit::AuditReport`] 的展平（字段名即 ADR-026 §2.2 契约，`run_id` 在前）。
#[derive(Debug, Clone, Serialize)]
pub struct RunAudit {
    pub run_id: String,
    #[serde(flatten)]
    pub report: crate::audit::AuditReport,
}

/// `GET /runs/{id}/result` 兼容响应（legacy 全量；chunked 首页 + has_more + next_offset）。
#[derive(Debug, Clone, Serialize)]
pub struct RunResultCompat {
    pub result_format: String,
    pub summary: ResultBrief,
    pub per_bar: Vec<serde_json::Value>,
    pub net_value: Vec<serde_json::Value>,
    pub drawdown: Vec<serde_json::Value>,
    pub trades: serde_json::Value,
    pub metrics: serde_json::Value,
    pub has_more: bool,
    pub next_offset: Option<i64>,
}

/// 均匀抽样下标（**保首尾**；ADR-024 D10）。`k >= n` → 全量下标；`k < n` → k 个下标（首 0、末 n-1）。
fn sample_indices(n: usize, k: usize) -> Vec<usize> {
    if n == 0 {
        return Vec::new();
    }
    if k == 0 {
        return vec![0];
    }
    if k >= n {
        return (0..n).collect();
    }
    let mut out: Vec<usize> = Vec::with_capacity(k);
    for i in 0..k {
        let idx = ((i as f64) * ((n - 1) as f64) / ((k - 1) as f64)).round() as usize;
        if out.last() != Some(&idx) {
            out.push(idx);
        }
    }
    if out.last() != Some(&(n - 1)) {
        out.push(n - 1);
    }
    out
}

/// 取一个结果元素的 bar ts（epoch 秒）：per_bar 记录为对象字段 `ts`；净值/回撤为 `[ts, value]`。
fn bar_ts_secs(v: &serde_json::Value, kind: ResultKind) -> Option<i64> {
    match kind {
        ResultKind::PerBar | ResultKind::Fills => v.get("ts").and_then(|t| t.as_i64()),
        ResultKind::NetValue | ResultKind::Drawdown => {
            v.as_array().and_then(|a| a.first()).and_then(|t| t.as_i64())
        }
    }
}

/// 契约口径：区间读 `[from, to]` **闭区间**。
fn bar_ts_in_range(
    v: &serde_json::Value,
    kind: ResultKind,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> bool {
    match bar_ts_secs(v, kind) {
        Some(ts) => ts >= from.timestamp() && ts <= to.timestamp(),
        None => false,
    }
}

/// 校验后的槽位（内部；钉住快照 + 运行素材）。
struct ValidatedSlot {
    strategy_id: String,
    version_id: String,
    version: i32,
    sha256: String,
    code: String,
    params: StrategyParams,
    params_json: serde_json::Value,
    weight: f64,
    /// 审计标记：archived 版本提交的运行（2026-09-10 裁决审计重跑），钉入 config 快照。
    archived: bool,
}

/// 回测工作台服务。
pub struct WorkbenchService {
    bar_read: Arc<dyn BacktestBarRead>,
    run_store: Arc<dyn StrategyRunStore>,
    preset_store: Arc<dyn StrategyPresetStore>,
    strategies: Arc<dyn StrategyStore>,
    symbols: Arc<dyn SymbolRegistry>,
    progress: Arc<dyn domain::ports::StrategyRunProgressSink>,
    clock: Arc<dyn Clock>,
    /// ADR-019 D11-3：费率档案读端口（None = 未装配 → 保持旧默认行为，向后兼容既有测试装配）。
    fee_profiles: Option<Arc<dyn FeeProfileStore>>,
    semaphore: Arc<Semaphore>,
    /// running 运行取消标记（协作式：引擎 observer 回调点检查）。
    cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl WorkbenchService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        bar_read: Arc<dyn BacktestBarRead>,
        run_store: Arc<dyn StrategyRunStore>,
        preset_store: Arc<dyn StrategyPresetStore>,
        strategies: Arc<dyn StrategyStore>,
        symbols: Arc<dyn SymbolRegistry>,
        progress: Arc<dyn domain::ports::StrategyRunProgressSink>,
        clock: Arc<dyn Clock>,
        max_concurrent: usize,
    ) -> Self {
        Self {
            bar_read,
            run_store,
            preset_store,
            strategies,
            symbols,
            progress,
            clock,
            fee_profiles: None,
            semaphore: Arc::new(Semaphore::new(max_concurrent.max(1))),
            cancel_flags: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// ADR-019 D11-3：装配费率档案端口（app bin 调用）。未装配 = 不按类型推断（旧行为）。
    pub fn with_fee_profiles(mut self, store: Arc<dyn FeeProfileStore>) -> Self {
        self.fee_profiles = Some(store);
        self
    }

    /// 提交 ensemble 运行：校验全路径 → 钉住快照入库 queued → 后台任务异步执行。
    /// 返回 queued 行（web 201）。
    pub async fn submit(&self, req: SubmitRunReq) -> anyhow::Result<StrategyRunView> {
        if req.symbol.trim().is_empty() {
            return Err(WorkbenchValidation::new(codes::SYMBOL_REQUIRED, "symbol 必填").into());
        }
        // symbol 已注册（400）。
        let symbol = req.symbol.trim().to_string();
        let enabled = self.symbols.enabled_codes().await?;
        if !enabled.iter().any(|c| c.0 == symbol) {
            return Err(WorkbenchValidation::new(
                codes::SYMBOL_UNREGISTERED,
                format!("symbol 未注册: {symbol}"),
            )
            .into());
        }
        let (domain_period, bt_period) = crate::bar_map::parse_period(&req.period)
            .map_err(|e| WorkbenchValidation::new(codes::PERIOD_INVALID, e.to_string()))?;
        if req.from >= req.to {
            return Err(WorkbenchValidation::new(codes::FROM_AFTER_TO, "from 须早于 to").into());
        }
        // ── ADR-024 P5（D1/D2/D3）：删除一切日历天数档；区间按数据真实范围收缩 ──
        // 原「D1≤5 年 / 分钟级≤3 个月」硬 400 **物理删除**（不是调值）。
        // 可得区间取**服务口径并集**（accurate ∪ 兜底，D3）——不得只查 accurate 单层（其 cagg 已知滞后）。
        let requested_from = req.from;
        let requested_to = req.to;
        let Some(avail) = self.bar_read.available_range(&symbol, &domain_period).await? else {
            return Err(range_empty_error(
                &symbol, &req.period, requested_from, requested_to, None,
            )
            .into());
        };
        let mut eff_from = requested_from.max(avail.from);
        let mut eff_to = requested_to.min(avail.to);
        if eff_from >= eff_to {
            return Err(range_empty_error(
                &symbol, &req.period, requested_from, requested_to, Some(avail),
            )
            .into());
        }
        let clamped = eff_from != requested_from || eff_to != requested_to;
        // slots 1..=10。
        if req.slots.is_empty() || req.slots.len() > 10 {
            return Err(WorkbenchValidation::new(
                codes::SLOTS_INVALID,
                format!("slots 数量须为 1..=10，got {}", req.slots.len()),
            )
            .into());
        }
        // 槽位钉住校验（版本存在 404 / draft 400——published|archived 可运行 / weight>0 / params schema 校验填充）。
        let mut slots = Vec::with_capacity(req.slots.len());
        for s in &req.slots {
            slots.push(self.validate_slot(s).await?);
        }
        // 阈值/Policy/资金 经 strategy-core validate（400）。
        let buy = req.buy_threshold.unwrap_or(strategy_core::DEFAULT_BUY_THRESHOLD);
        let sell = req.sell_threshold.unwrap_or(strategy_core::DEFAULT_SELL_THRESHOLD);
        let policy: ExecutionPolicy = serde_json::from_value(req.policy.clone())
            .map_err(|e| WorkbenchValidation::new(codes::POLICY_INVALID, format!("policy 非法: {e}")))?;
        let stop: Option<StopConfig> = match &req.stop {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => {
                let sc: StopConfig = serde_json::from_value(v.clone())
                    .map_err(|e| WorkbenchValidation::new(codes::STOP_INVALID, format!("stop 非法: {e}")))?;
                if !sc.value.is_finite() || sc.value <= 0.0 {
                    return Err(WorkbenchValidation::new(
                        codes::STOP_INVALID,
                        format!("stop.value 须为正有限值，got {}", sc.value),
                    )
                    .into());
                }
                Some(sc)
            }
        };
        let initial_capital = req.initial_capital.unwrap_or(DEFAULT_INITIAL_CAPITAL);
        // ADR-019 D11-3 + v1.1 R-2：fee 按**字段优先级**解析（显式字段 > 按标的 type 查档案 > 旧 ADR bt-1 默认）。
        let profile = match &self.fee_profiles {
            Some(store) => store.for_symbol(&symbol).await?,
            None => None,
        };
        let resolved = resolve_fee(req.fee.as_ref(), profile)
            .map_err(|e| WorkbenchValidation::new(codes::FEE_INVALID, e.to_string()))?;
        let fee = resolved.model;
        let mut probe = EnsembleConfig {
            slots: vec![], // validate 不检视 slots（零 slot 合法）；钉住校验已先行
            buy_threshold: buy,
            sell_threshold: sell,
            policy,
            stop,
            initial_capital,
            fee,
            period: bt_period,
            warmup_bars: 0,
            runtime_limits: strategy_runtime::RuntimeLimits::default(),
        };
        probe.validate().map_err(|m| {
            WorkbenchValidation::new(crate::error::classify_config_error(&m), m)
        })?;

        // ── ADR-024 P5（D12）：进度/护栏 `count(*)` 预扫描 ──
        // 成功 → 精确 total（口径 = `count`）；失败/超时 → 退化按 ts 归一化（口径 = `ts_norm`，**日志标明**）。
        let (estimated_bars, prescan_caliber) = match self
            .bar_read
            .count_bars(&symbol, &domain_period, eff_from, eff_to)
            .await
        {
            Ok(n) if n >= 0 => (Some(n as usize), "count"),
            Ok(_) => (None, "ts_norm"),
            Err(e) => {
                tracing::warn!(
                    symbol = %symbol, period = %req.period, error = %e,
                    "ADR-024 D12 进度预扫描失败：退化为按 ts 归一化口径（prescan=ts_norm）"
                );
                (None, "ts_norm")
            }
        };
        // ── ADR-024 P5（D1）：资源护栏（预估 bar 数 + 端到端预估耗时；**无日历天数档**）──
        if let Some(n) = estimated_bars {
            if let Some(err) = guard_bars(
                n,
                req.confirm,
                &req.period,
                &symbol,
                Some((avail.from, avail.to)),
            ) {
                return Err(err.into());
            }
        }

        // ── P4b（D15）观测：每 run 一条 `trace_id` + 一段父 span `workbench_run` ──
        // 父 span 早于取数创建（取数段是它的子 span），run_id/bars_total 以 `Empty` 声明后 record；
        // `trace_id` 沿用既有观测约定（`domain::new_trace_id()` 32 位十六进制），
        // 贯穿 submit → mark_started → 引擎 → 进度落库 → 结果落库。
        let trace_id = domain::types::new_trace_id();
        let run_span = tracing::info_span!(
            "workbench_run",
            trace_id = %trace_id,
            symbol = %symbol,
            period = %req.period,
            run_id = tracing::field::Empty,
            bars_total = tracing::field::Empty,
        );
        let p4b = Arc::new(P4bRunCounters::default());

        // 读 bar（[warmup_start, eff_to)）；IM-2/D6 前置预热，再按 eff_from 切分。
        let warmup_requested = req.warmup_bars;
        let warmup_start = if warmup_requested == 0 {
            eff_from
        } else {
            eff_from - crate::bar_map::warmup_lookback(&domain_period, warmup_requested)
        };
        let fetch_span =
            tracing::info_span!(
                parent: &run_span,
                "p4b.segment",
                segment = "fetch",
                trace_id = %trace_id
            );
        let t_fetch = Instant::now();
        let all: Vec<backtest::Bar> = self
            .bar_read
            .bars(&symbol, &domain_period, warmup_start, eff_to)
            .instrument(fetch_span.clone())
            .await?
            .iter()
            .map(crate::bar_map::to_bt_bar)
            .collect();
        let fetch_us = p4b_add_us(&p4b.fetch_us, t_fetch);
        fetch_span.in_scope(|| {
            tracing::info!(
                trace_id = %trace_id,
                symbol = %symbol,
                period = %req.period,
                elapsed_us = fetch_us,
                bars_fetched = all.len(),
                "p4b.segment"
            )
        });
        let split = all
            .iter()
            .position(|b| b.ts >= eff_from.timestamp())
            .unwrap_or(all.len());
        let warmup_effective = split.min(warmup_requested);
        let slice_start = split - warmup_effective;
        let bars: Vec<backtest::Bar> = all[slice_start..].to_vec();
        let in_range: &[backtest::Bar] = &bars[warmup_effective..];
        if in_range.is_empty() {
            // D3：执行时以真实取到的首末 bar 为准—若区间内空 ⇒ 仍落 range_empty（不产出 0 bar 的「成功」run）。
            return Err(range_empty_error(
                &symbol, &req.period, requested_from, requested_to, Some(avail),
            )
            .into());
        }
        // ── D3：执行时以真实取到的首末 bar 为准做最终收缩（与提交时不一致以执行时为准）──
        // 仅当该端在提交时被**夹取**（clamped）时才按实际数据再收窄（避免「from 未对齐 bar」造成无意义紧缩）。
        if clamped {
            let actual_from = DateTime::from_timestamp(in_range[0].ts, 0).unwrap_or(eff_from);
            let actual_to =
                DateTime::from_timestamp(in_range[in_range.len() - 1].ts + 1, 0).unwrap_or(eff_to);
            if actual_from > eff_from {
                eff_from = actual_from;
            }
            if actual_to < eff_to {
                eff_to = actual_to;
            }
        }
        // 预扫描失败时（无法提前护栏）：以实际 bar 数兜底护栏。
        if estimated_bars.is_none() {
            if let Some(err) = guard_bars(
                in_range.len(),
                req.confirm,
                &req.period,
                &symbol,
                Some((avail.from, avail.to)),
            ) {
                return Err(err.into());
            }
        }
        let estimated_bars = estimated_bars.map(|n| n as i64);
        // I-2/D6：引擎按 warmup_effective 标记前缀（不执行/不计绩效）。
        probe.warmup_bars = warmup_effective;
        // P4b：本 run bar 数（父 span 字段 + 汇总事件口径）。
        p4b.bars_total.store(bars.len() as u64, Ordering::Relaxed);
        run_span.record("bars_total", bars.len() as u64);

        // 钉住快照（复现前提）：slots 全字段 + 阈值 + policy/stop 原文 + 资金 + **生效** fee。
        // `archived` 为审计标记（2026-09-10 裁决：archived 版本可审计重跑，避免误解为「在用策略」）。
        // I-3/D6 + ADR-019 v1.1 R-1：`config.fee` 保持**扁平** [`fee_model_to_json`] 形态
        // （`{rate_pct,min_fee,slippage_bp,stamp_duty_pct}`，含 stamp 实际取值）——预设往返/前端读取
        // 必须向后兼容；两段结构（effective/profile）**只用于响应回显**（`resolved_fee_to_json`），不得混入 config。
        // I-2/D6：warmup 段钉住 requested/effective。
        let config = serde_json::json!({
            "slots": slots.iter().map(|s| serde_json::json!({
                "strategy_id": s.strategy_id,
                "version_id": s.version_id,
                "version": s.version,
                "sha256": s.sha256,
                "params": s.params_json,
                "weight": s.weight,
                "archived": s.archived,
            })).collect::<Vec<_>>(),
            "buy_threshold": buy,
            "sell_threshold": sell,
            "policy": req.policy,
            "stop": req.stop,
            "initial_capital": initial_capital,
            "fee": crate::fee::fee_model_to_json(&fee),
            "warmup_requested": warmup_requested,
            "warmup_effective": warmup_effective,
            // ADR-024 P5 §3.1：requested/effective/clamped/预估落 config 快照（审计与复现前提）。
            // `from_ts`/`to_ts` 存 **effective**（D2/D3）；`requested_*` 与 clamp 真相在此。
            "requested_from": requested_from.to_rfc3339(),
            "requested_to": requested_to.to_rfc3339(),
            "clamped": clamped,
            "clamp_reason": clamped.then_some("data_range"),
            "estimated_bars": estimated_bars,
            // D12：进度/护栏预扫描口径（`count` = 精确；`ts_norm` = 降级）——便于事后回查。
            "progress_prescan": prescan_caliber,
        });

        let now = self.clock.now();
        let run = self
            .run_store
            .create_run(&NewStrategyRun {
                id: new_id("sr", now),
                name: req.name.clone(),
                symbol,
                period: req.period.clone(),
                from_ts: eff_from,
                to_ts: eff_to,
                config,
            })
            .await?;

        // P4b：父 span 补全 run_id + 提交侧事件（与引擎/落库段同一 `trace_id`，可串成一条链）。
        run_span.record("run_id", run.id.as_str());
        tracing::info!(
            trace_id = %trace_id,
            run_id = %run.id,
            symbol = %req.symbol,
            period = %req.period,
            bars_total = bars.len(),
            warmup_effective,
            submit_fetch_ms = p4b_ms(fetch_us),
            "p4b.submit"
        );
        let run_span2 = run_span.clone();

        // 后台任务（与 BacktestService 同模式：入队即 spawn，Semaphore 在任务内阻塞限并发）。
        let run_store = Arc::clone(&self.run_store);
        let progress = Arc::clone(&self.progress);
        let semaphore = Arc::clone(&self.semaphore);
        let cancel_flags = Arc::clone(&self.cancel_flags);
        let clock = Arc::clone(&self.clock);
        let id = run.id.clone();
        let trace_id2 = trace_id.clone();
        let p4b2 = Arc::clone(&p4b);
        tokio::spawn(
            async move {
                // P4b：排队等 permit（**不**计入持有）；获取后立即进入 execute_run。
                let t_wait = Instant::now();
                let _permit = semaphore.acquire().await.expect("semaphore closed");
                p4b2.permit_wait_us
                    .store(t_wait.elapsed().as_micros() as u64, Ordering::Relaxed);
                execute_run(
                    run_store, progress, cancel_flags, clock, id, trace_id2, p4b2, probe, slots,
                    bars,
                )
                .await;
            }
            .instrument(run_span2),
        );
        Ok(run)
    }

    /// 槽位校验 + 钉住（版本存在 404 / draft 400 / weight>0 / params schema 填充）。
    /// 2026-09-10 裁决：published|archived 可运行（archived = 审计重跑，快照带 `archived` 标记）；
    /// draft 仍拒绝（未发布代码不可运行，门禁语义保留）。
    async fn validate_slot(&self, s: &SlotReq) -> anyhow::Result<ValidatedSlot> {
        if s.version_id.trim().is_empty() {
            return Err(WorkbenchValidation::new(codes::SLOTS_INVALID, "slot.version_id 必填").into());
        }
        if !s.weight.is_finite() || s.weight <= 0.0 {
            return Err(WorkbenchValidation::new(
                codes::WEIGHT_INVALID,
                format!("slot.weight 须为正有限值，got {}", s.weight),
            )
            .into());
        }
        let v = self
            .strategies
            .get_version(&s.version_id)
            .await?
            .ok_or_else(|| WorkbenchNotFound(format!("策略版本不存在: {}", s.version_id)))?;
        let status = v.status;
        if status == domain::strategy_state::StrategyStatus::Draft {
            return Err(WorkbenchValidation::new(
                codes::VERSION_NOT_RUNNABLE,
                format!(
                    "策略版本 {} 未发布（status=draft），draft 版本不可运行（published/archived 版本可运行）",
                    s.version_id
                ),
            )
            .into());
        }
        debug_assert!(
            matches!(
                status,
                domain::strategy_state::StrategyStatus::Published
                    | domain::strategy_state::StrategyStatus::Archived
            ),
            "状态机仅 draft/published/archived 三态"
        );
        let archived = status == domain::strategy_state::StrategyStatus::Archived;
        let schema = schema_from_json(&v.params_schema);
        let params = fill_and_validate_params(&schema, &s.params)
            .map_err(|m| WorkbenchValidation::new(codes::PARAMS_INVALID, m))?;
        let params_json = serde_json::Value::Object(
            params
                .iter()
                .map(|(k, v)| {
                    // ABI §1：插件参数 schema 仅数值型（min/max 数值校验）；Choice 为内建策略遗留形态，
                    // 插件 schema 不产生——防御性兜底序列化为字符串。
                    let jv = match v {
                        backtest::ParamValue::Num(n) => serde_json::json!(n),
                        backtest::ParamValue::Choice(c) => serde_json::json!(c),
                    };
                    (k.clone(), jv)
                })
                .collect(),
        );
        Ok(ValidatedSlot {
            strategy_id: v.strategy_id,
            version_id: v.id,
            version: v.version,
            sha256: v.sha256,
            code: v.code,
            params,
            params_json,
            weight: s.weight,
            archived,
        })
    }

    /// ADR-024 P5 §5.2：可得区间读（前端日期控件 min/max 联动用）。
    /// 周期非法 → [`WorkbenchValidation`]（400）；无数据 → `Ok(None)`。
    pub async fn available_range(
        &self,
        symbol: &str,
        period: &str,
    ) -> anyhow::Result<Option<domain::ports::AvailableRange>> {
        let (domain_period, _) = crate::bar_map::parse_period(period)
            .map_err(|e| WorkbenchValidation::new(codes::PERIOD_INVALID, e.to_string()))?;
        self.bar_read.available_range(symbol.trim(), &domain_period).await
    }

    /// 读 run（404）。
    pub async fn get_run(&self, id: &str) -> anyhow::Result<StrategyRunView> {
        self.run_store
            .get_run(id)
            .await?
            .ok_or_else(|| anyhow!(WorkbenchNotFound(format!("运行不存在: {id}"))))
    }

    /// 列表（分页 + 状态过滤）。
    pub async fn list_runs(&self, filter: &StrategyRunFilter) -> anyhow::Result<Vec<StrategyRunView>> {
        self.run_store.list_runs(filter).await
    }

    /// 读结果（run 未知 → 404；未成功无结果 → 404）。
    pub async fn get_result(&self, run_id: &str) -> anyhow::Result<StrategyRunResult> {
        self.get_run(run_id).await?;
        self.run_store
            .get_result(run_id)
            .await?
            .ok_or_else(|| {
                anyhow!(WorkbenchNotFound(format!("运行 {run_id} 尚无结果（未成功完成）")))
            })
    }

    /// 取消（协作式）：queued → DB 直接落 canceled（后台任务认领时自动放弃）；
    /// running → 置内存取消标记（引擎 observer 回调点检查，下一 bar 边界 Break）+ DB 落 canceled。
    /// 未知 id → 404；终态 → 409。
    pub async fn cancel(&self, id: &str) -> anyhow::Result<StrategyRunView> {
        let run = self.get_run(id).await?; // 404
        if run.status.is_terminal() {
            return Err(WorkbenchConflict(format!(
                "运行 {id} 已终态（{}），不可取消",
                run.status.as_str()
            ))
            .into());
        }
        // running：先置协作式取消标记（引擎下一 bar 边界生效）；queued：标记不存在亦无妨
        //（认领时 mark_started 会读到 canceled 而放弃）。
        if let Some(flag) = self.cancel_flags.lock().expect("flags poisoned").get(id) {
            flag.store(true, Ordering::Relaxed);
        }
        match self.run_store.mark_canceled(id, self.clock.now()).await? {
            None => Err(anyhow!(WorkbenchNotFound(format!("运行不存在: {id}")))),
            Some(false) => Err(WorkbenchConflict(format!(
                "运行 {id} 已终态，不可取消（并发迁移）"
            ))
            .into()),
            Some(true) => self.get_run(id).await,
        }
    }

    /// 多 run 对比：并排 net_value + metrics（输入序；未知/未成功 run 跳过）。
    ///
    /// ADR-024 D9/D10：净值经**显式抽样**（默认 `k=2000`，均匀保首尾），响应带
    /// `downsampled` + `original_bars`；禁止 N × 全量净值。`k = usize::MAX` 表示不抽样
    /// （MCP 旧路径兼容）。
    pub async fn compare(&self, ids: &[String]) -> anyhow::Result<Vec<CompareItem>> {
        self.compare_sampled(ids, COMPARE_K_DEFAULT).await
    }

    /// 多 run 对比（指定抽样目标点数 `k`；`k >= n` 则全量）。
    pub async fn compare_sampled(
        &self,
        ids: &[String],
        k: usize,
    ) -> anyhow::Result<Vec<CompareItem>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(run) = self.run_store.get_run(id).await? else { continue };
            let Some(res) = self.run_store.get_result(id).await? else { continue };
            // D8 双读：chunked_v1 的净值在 strategy_run_bars；legacy_single 为内联列。
            let all = self.series_all(id, &res, ResultKind::NetValue).await?;
            let n = all.len();
            let idx = sample_indices(n, k);
            let sampled: Vec<serde_json::Value> = idx.iter().map(|&i| all[i].clone()).collect();
            out.push(CompareItem {
                run_id: run.id,
                name: run.name,
                symbol: run.symbol,
                period: run.period,
                net_value: serde_json::Value::Array(sampled),
                metrics: res.metrics,
                downsampled: idx.len() < n,
                original_bars: n as i64,
            });
        }
        Ok(out)
    }

    // ── ADR-024 P4 / D8-D10：结果读取（brief / bars 分页|区间 / curve 抽样 / result 兼容）──

    /// 结果为 `legacy_single` 时从内联列取数组；否则为空（数据在分块表）。
    fn legacy_series(res: &StrategyRunResult, kind: ResultKind) -> Vec<serde_json::Value> {
        let v = match kind {
            ResultKind::PerBar => &res.per_bar,
            ResultKind::NetValue => &res.net_value,
            ResultKind::Drawdown => &res.drawdown,
            // fills 无内联列（旧 run 由 `legacy_fills` 从内联 per_bar 事件派生，不回填）。
            ResultKind::Fills => return Vec::new(),
        };
        v.as_array().cloned().unwrap_or_default()
    }

    /// fills 事实源（D8 双读）：chunked 读 `kind='fills'` 块（**有块 = 已记录**）；
    /// legacy 由内联 per_bar 的 `fill` 事件派生（旧 run 不回填）。
    /// 返回 `(fills, recorded)`：`recorded=false` = 「未写」（P6 之前的 chunked run）。
    async fn fills_all(
        &self,
        run_id: &str,
        res: &StrategyRunResult,
    ) -> anyhow::Result<(Vec<serde_json::Value>, bool)> {
        if !res.is_chunked() {
            return Ok((legacy_fills(res), true));
        }
        let blocks = self.run_store.result_chunk_count(run_id, ResultKind::Fills).await?;
        if blocks == 0 {
            return Ok((Vec::new(), false));
        }
        let all = self.series_all(run_id, res, ResultKind::Fills).await?;
        Ok((all, true))
    }

    /// `GET /runs/{id}/fills?offset=&limit=`：成交明细分页读（ADR-024 P6 有界精确源）。
    ///
    /// 硬约束：**不得**用 `/curve`（抽样丢真实成交）或 `trades`（仅完全平仓时合成 ⇒
    /// 部分买入/加仓与部分卖出不进 `trades`）代替本端点。
    pub async fn result_fills(
        &self,
        run_id: &str,
        offset: i64,
        limit: i64,
    ) -> anyhow::Result<FillsResponse> {
        self.get_run(run_id).await?;
        let res = self.run_store.get_result(run_id).await?.ok_or_else(|| {
            anyhow!(WorkbenchNotFound(format!("运行 {run_id} 尚无结果（未成功完成）")))
        })?;
        let (all, recorded) = self.fills_all(run_id, &res).await?;
        let total = all.len() as i64;
        let offset = offset.max(0);
        let start = offset.min(total) as usize;
        let end = (offset + limit.max(0)).min(total) as usize;
        let fills: Vec<serde_json::Value> = all[start..end].to_vec();
        let next = start as i64 + fills.len() as i64;
        let has_more = next < total;
        Ok(FillsResponse {
            run_id: run_id.to_string(),
            total,
            offset,
            limit,
            has_more,
            next_offset: has_more.then_some(next),
            recorded,
            fills,
        })
    }

    /// 全量物化某 kind 的 bar 数组（D8 双读）：chunked 逐页读分块拼接；legacy 取内联列。
    ///
    /// ⚠ 大区间 chunked run 会全量载入内存——仅用于 curve 抽样/compare 等需全局视野的路由；
    /// 分页/区间读走分块窗口路径（`bars_page` / `bars_range`）。
    async fn series_all(
        &self,
        run_id: &str,
        res: &StrategyRunResult,
        kind: ResultKind,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        if !res.is_chunked() {
            return Ok(Self::legacy_series(res, kind));
        }
        let mut out = Vec::new();
        let page = 1000i64;
        let mut off = 0i64;
        loop {
            let chunks = self.run_store.result_chunks(run_id, kind, off, page).await?;
            let got = chunks.len() as i64;
            for c in &chunks {
                if let Some(arr) = c.payload.as_array() {
                    out.extend(arr.iter().cloned());
                }
            }
            off += got;
            if got < page {
                break;
            }
        }
        Ok(out)
    }

    /// per_bar 总根数（D8 双读）：chunked = (chunk_count-1)*5000 + 末块长度；legacy = 内联长度。
    async fn bars_total_of(
        &self,
        run_id: &str,
        res: &StrategyRunResult,
        kind: ResultKind,
    ) -> anyhow::Result<i64> {
        if !res.is_chunked() {
            return Ok(Self::legacy_series(res, kind).len() as i64);
        }
        let count = self.run_store.result_chunk_count(run_id, kind).await?;
        if count == 0 {
            return Ok(0);
        }
        let last = self.run_store.result_chunks(run_id, kind, count - 1, 1).await?;
        let last_len = last
            .first()
            .and_then(|c| c.payload.as_array())
            .map(|a| a.len() as i64)
            .unwrap_or(0);
        Ok((count - 1) * RESULT_CHUNK_BARS as i64 + last_len)
    }

    /// 构建 brief 读模型（轻量）。
    async fn build_brief(
        &self,
        run: &StrategyRunView,
        res: Option<&StrategyRunResult>,
    ) -> anyhow::Result<ResultBrief> {
        let (result_format, chunk_count, bars_total, metrics) = match res {
            None => (None, 0, 0, None),
            Some(r) => {
                let chunk_count = if r.is_chunked() {
                    self.run_store.result_chunk_count(&run.id, ResultKind::PerBar).await?
                } else {
                    0
                };
                let bars_total = self.bars_total_of(&run.id, r, ResultKind::PerBar).await?;
                (Some(r.result_format.clone()), chunk_count, bars_total, Some(r.metrics.clone()))
            }
        };
        Ok(ResultBrief {
            id: run.id.clone(),
            name: run.name.clone(),
            symbol: run.symbol.clone(),
            period: run.period.clone(),
            status: run.status,
            progress: run.progress,
            error: run.error.clone(),
            created_at: run.created_at,
            started_at: run.started_at,
            finished_at: run.finished_at,
            // P5：requested/effective 分离（from_ts/to_ts = effective；requested 来自 run 视图/config 快照）。
            requested_from: run.requested_from,
            requested_to: run.requested_to,
            effective_from: run.from_ts,
            effective_to: run.to_ts,
            clamped: run.clamped,
            estimated_bars: run.estimated_bars,
            bars_total,
            result_format,
            chunk_count,
            metrics,
        })
    }

    /// `GET /runs/{id}/brief`：轻量读（未成功且无结果也可读；run 未知 → 404）。
    pub async fn result_brief(&self, run_id: &str) -> anyhow::Result<ResultBrief> {
        let run = self.get_run(run_id).await?;
        let res = self.run_store.get_result(run_id).await?;
        self.build_brief(&run, res.as_ref()).await
    }

    /// 序号分页读 bar（chunked：只读命中分块；legacy：内存切片）。
    async fn bars_page(
        &self,
        run_id: &str,
        res: &StrategyRunResult,
        kind: ResultKind,
        offset: i64,
        limit: i64,
    ) -> anyhow::Result<BarsResponse> {
        let total = self.bars_total_of(run_id, res, kind).await?;
        let bars = if !res.is_chunked() {
            let all = Self::legacy_series(res, kind);
            let start = offset.min(all.len() as i64) as usize;
            let end = (offset + limit).min(all.len() as i64) as usize;
            all[start..end].to_vec()
        } else {
            self.chunked_page(run_id, kind, offset, limit).await?
        };
        let next = offset + bars.len() as i64;
        let has_more = next < total;
        Ok(BarsResponse {
            kind: kind.as_str().to_string(),
            bars,
            total,
            has_more,
            next_offset: has_more.then_some(next),
            offset,
            limit,
            from: None,
            to: None,
        })
    }

    /// chunked 序号分页：定位首块（假设非末块恰 RESULT_CHUNK_BARS 根）后多读一块，块内切片。
    async fn chunked_page(
        &self,
        run_id: &str,
        kind: ResultKind,
        offset: i64,
        limit: i64,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let chunk = RESULT_CHUNK_BARS as i64;
        let first_chunk = offset / chunk;
        let intra = (offset % chunk) as usize;
        // 需要覆盖 intra+limit 根 ⇒ 需跨越的块数（+1 保险处理末块偏小）。
        let span = ((intra as i64 + limit - 1) / chunk) + 1;
        let chunks = self.run_store.result_chunks(run_id, kind, first_chunk, span).await?;
        let mut out: Vec<serde_json::Value> = Vec::new();
        let mut skip = intra;
        for c in &chunks {
            let Some(arr) = c.payload.as_array() else { continue };
            for v in arr {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                if out.len() as i64 >= limit {
                    return Ok(out);
                }
                out.push(v.clone());
            }
        }
        Ok(out)
    }

    /// 区间读 bar：chunked 读命中整块后在**块内按 ts 精确过滤**（含外沿）；legacy 内存过滤。
    async fn bars_range(
        &self,
        run_id: &str,
        res: &StrategyRunResult,
        kind: ResultKind,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> anyhow::Result<BarsResponse> {
        let all: Vec<serde_json::Value> = if !res.is_chunked() {
            Self::legacy_series(res, kind)
        } else {
            let chunks = self
                .run_store
                .result_chunks_in_range(run_id, kind, from, to)
                .await?;
            let mut out = Vec::new();
            for c in &chunks {
                if let Some(arr) = c.payload.as_array() {
                    out.extend(arr.iter().cloned());
                }
            }
            out
        };
        let bars: Vec<serde_json::Value> = all
            .into_iter()
            .filter(|v| bar_ts_in_range(v, kind, from, to))
            .collect();
        Ok(BarsResponse {
            kind: kind.as_str().to_string(),
            total: bars.len() as i64,
            has_more: false,
            next_offset: None,
            offset: 0,
            limit: 0,
            bars,
            from: Some(from),
            to: Some(to),
        })
    }

    /// `GET /runs/{id}/bars?kind=&offset=&limit=` 或 `...&from=&to=`（互斥）。
    pub async fn result_bars(
        &self,
        run_id: &str,
        kind: ResultKind,
        window: BarsWindow,
    ) -> anyhow::Result<BarsResponse> {
        self.get_run(run_id).await?;
        let res = self.run_store.get_result(run_id).await?.ok_or_else(|| {
            anyhow!(WorkbenchNotFound(format!("运行 {run_id} 尚无结果（未成功完成）")))
        })?;
        match window {
            BarsWindow::Offset { offset, limit } => {
                self.bars_page(run_id, &res, kind, offset, limit).await
            }
            BarsWindow::Range { from, to } => {
                self.bars_range(run_id, &res, kind, from, to).await
            }
        }
    }

    /// `GET /runs/{id}/curve?k=&kind=`：显式抽样（均匀保首尾；`downsampled`/`original_bars`）。
    ///
    /// 硬约束（ADR-024 P6）：`fills` 是**事实源**，**不得抽样**（会丢真实成交）⇒ 拒绝。
    pub async fn result_curve(
        &self,
        run_id: &str,
        kind: ResultKind,
        k: Option<usize>,
    ) -> anyhow::Result<CurveResponse> {
        if !kind.is_sampleable() {
            return Err(anyhow!(WorkbenchValidation::new(
                codes::KIND_INVALID,
                format!("{} 为事实源，不可抽样（请用 /fills 分页读）", kind.as_str()),
            )));
        }
        self.get_run(run_id).await?;
        let res = self.run_store.get_result(run_id).await?.ok_or_else(|| {
            anyhow!(WorkbenchNotFound(format!("运行 {run_id} 尚无结果（未成功完成）")))
        })?;
        let k = k.unwrap_or(CURVE_K_DEFAULT).clamp(1, CURVE_K_MAX);
        let all = self.series_all(run_id, &res, kind).await?;
        let n = all.len();
        let idx = sample_indices(n, k);
        let points: Vec<serde_json::Value> = idx.iter().map(|&i| all[i].clone()).collect();
        let downsampled = points.len() < n;
        Ok(CurveResponse {
            kind: kind.as_str().to_string(),
            points,
            downsampled,
            original_bars: n as i64,
            k: k as i64,
        })
    }

    /// `GET /runs/{id}/result`：兼容（legacy 全量；chunked 首页 per_bar + `has_more` + `next_offset`）。
    pub async fn result_compat(&self, run_id: &str, page_limit: i64) -> anyhow::Result<RunResultCompat> {
        let run = self.get_run(run_id).await?;
        let res = self.run_store.get_result(run_id).await?.ok_or_else(|| {
            anyhow!(WorkbenchNotFound(format!("运行 {run_id} 尚无结果（未成功完成）")))
        })?;
        let summary = self.build_brief(&run, Some(&res)).await?;
        if res.is_chunked() {
            let page = self
                .bars_page(run_id, &res, ResultKind::PerBar, 0, page_limit)
                .await?;
            Ok(RunResultCompat {
                result_format: RESULT_FORMAT_CHUNKED.to_string(),
                summary,
                per_bar: page.bars,
                // chunked_v1：净值/回撤在分块表且体量可大 ⇒ 本端点只回首页 per_bar；
                // 图表改走 `/curve`（ADR-024 §3.2 兼容矩阵）。
                net_value: Vec::new(),
                drawdown: Vec::new(),
                trades: res.trades.clone(),
                metrics: res.metrics.clone(),
                has_more: page.has_more,
                next_offset: page.next_offset,
            })
        } else {
            // legacy 全量（前端可渐进迁移）。
            Ok(RunResultCompat {
                result_format: RESULT_FORMAT_LEGACY.to_string(),
                summary,
                per_bar: res.per_bar.as_array().cloned().unwrap_or_default(),
                net_value: res.net_value.as_array().cloned().unwrap_or_default(),
                drawdown: res.drawdown.as_array().cloned().unwrap_or_default(),
                trades: res.trades.clone(),
                metrics: res.metrics.clone(),
                has_more: false,
                next_offset: None,
            })
        }
    }

    /// `GET /runs/{id}/audit`：**执行完整度审计**（ADR-026 §2.2；只读派生，不落库）。
    ///
    /// 事实源（ADR-026 §2.1）：
    /// - `per_bar`（chunked 分块 或 legacy 内联——同一 JSON 形态）⇒ 意图/成交/末根 bar；
    /// - `fills`（chunked 块；legacy 由内联 per_bar 事件派生，即 ADR-024 P6 双读）⇒ 敞口/佣金复算；
    /// - `strategy_run_result.trades` ⇒ 回合数与强平合成判据。
    ///
    /// 错误语义与 `/result` `/fills` **完全一致**：run 未知 → 404；run 存在但无结果 → 404。
    ///
    /// 派生计算本身在 [`crate::audit::compute_audit`]（纯函数，无 IO；表驱动单测锁定）。
    pub async fn run_audit(&self, run_id: &str) -> anyhow::Result<RunAudit> {
        let run = self.get_run(run_id).await?;
        let res = self.run_store.get_result(run_id).await?.ok_or_else(|| {
            anyhow!(WorkbenchNotFound(format!("运行 {run_id} 尚无结果（未成功完成）")))
        })?;
        // 事实源读取：per_bar 按既有分段（RESULT_CHUNK_BARS）逐页流式扫描（ADR-026 §4 性能）。
        let per_bar = self.series_all(run_id, &res, ResultKind::PerBar).await?;
        let (fills_json, fills_recorded) = self.fills_all(run_id, &res).await?;
        // `recorded`：per_bar 可得（旧/新 run 都有）**或** fills 块可得。两者皆无 ⇒ 审计无事实可依。
        let recorded = !per_bar.is_empty() || fills_recorded;
        let (orders, last_bar_index) = crate::audit::orders_from_per_bar(&per_bar);
        let fills = crate::audit::fills_from_json(&fills_json);
        let trades = crate::audit::trades_from_json(&res.trades);
        let fee = run
            .config
            .get("fee")
            .and_then(|v| to_fee_model(v).ok())
            .unwrap_or_default();
        let initial_capital = run
            .config
            .get("initial_capital")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(DEFAULT_INITIAL_CAPITAL);
        // `policy` 解析失败/缺失 ⇒ `None`（`planned_tranches=null`，不报错：审计是只读读径，
        // 不得因历史 config 形态差异而 500）。
        let policy: Option<ExecutionPolicy> = run
            .config
            .get("policy")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let report = crate::audit::compute_audit(&crate::audit::AuditInput {
            recorded,
            orders: &orders,
            fills: &fills,
            trades: &trades,
            last_bar_index,
            fee,
            initial_capital,
            policy: policy.as_ref(),
        });
        Ok(RunAudit { run_id: run_id.to_string(), report })
    }

    // ── 组合预设（ADR §13.5）──

    /// 新建预设：config 校验（同 submit 配置口径，钉住 sha256/params）→ 入库（重名 409）。
    pub async fn create_preset(
        &self,
        name: &str,
        config: &serde_json::Value,
    ) -> anyhow::Result<StrategyPresetRow> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkbenchValidation::new(codes::NAME_REQUIRED, "name 必填").into());
        }
        if self.preset_store.find_preset_by_name(name).await?.is_some() {
            return Err(WorkbenchConflict(format!("预设名已存在: {name}")).into());
        }
        let pinned = self.validate_preset_config(config).await?;
        let row = self
            .preset_store
            .create_preset(&NewStrategyPreset {
                id: new_id("sp", self.clock.now()),
                name: name.to_string(),
                config: pinned,
            })
            .await
            .map_err(|e| {
                // DB UNIQUE 兜底（预检查后并发撞名）。
                if e.to_string().contains("duplicate key") {
                    anyhow!(WorkbenchConflict(format!("预设名已存在: {name}")))
                } else {
                    e
                }
            })?;
        Ok(row)
    }

    /// 读预设（404）。
    pub async fn get_preset(&self, id: &str) -> anyhow::Result<StrategyPresetRow> {
        self.preset_store
            .get_preset(id)
            .await?
            .ok_or_else(|| anyhow!(WorkbenchNotFound(format!("预设不存在: {id}"))))
    }

    /// 全部预设（created_at ASC, id ASC）。
    pub async fn list_presets(&self) -> anyhow::Result<Vec<StrategyPresetRow>> {
        self.preset_store.list_presets().await
    }

    /// 更新预设（name trim 非空；config 同 create 校验；未知 404；撞名 409）。
    pub async fn update_preset(
        &self,
        id: &str,
        name: &str,
        config: &serde_json::Value,
    ) -> anyhow::Result<StrategyPresetRow> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkbenchValidation::new(codes::NAME_REQUIRED, "name 必填").into());
        }
        self.get_preset(id).await?; // 404
        if self
            .preset_store
            .find_preset_by_name(name)
            .await?
            .is_some_and(|p| p.id != id)
        {
            return Err(WorkbenchConflict(format!("预设名已存在: {name}")).into());
        }
        let pinned = self.validate_preset_config(config).await?;
        self.preset_store
            .update_preset(id, name, &pinned)
            .await
            .map_err(|e| {
                if e.to_string().contains("duplicate key") {
                    anyhow!(WorkbenchConflict(format!("预设名已存在: {name}")))
                } else {
                    e
                }
            })?
            .ok_or_else(|| anyhow!(WorkbenchNotFound(format!("预设不存在: {id}"))))
    }

    /// 删除预设（未知 404）。
    pub async fn delete_preset(&self, id: &str) -> anyhow::Result<()> {
        if !self.preset_store.delete_preset(id).await? {
            return Err(WorkbenchNotFound(format!("预设不存在: {id}")).into());
        }
        Ok(())
    }

    /// apply：返回钉住 config（供 submit 用；前端合并 symbol/period/from/to 后提交）。404。
    pub async fn apply_preset(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        Ok(self.get_preset(id).await?.config)
    }

    /// 预设 config 校验 + 钉住（与 submit 同口径：slots 1..=10 / weight>0 / 版本存在+非 draft /
    /// params schema 填充 / 阈值+policy 经 strategy-core validate / stop 正有限 / fee 三字段）。
    /// 输出钉住形态（slots 展开为 {strategy_id, version_id, version, sha256, params, weight, archived}）。
    async fn validate_preset_config(
        &self,
        config: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let obj = config
            .as_object()
            .ok_or_else(|| WorkbenchValidation::new(codes::CONFIG_INVALID, "config 应为对象"))?;
        let slots_json = obj
            .get("slots")
            .and_then(|v| v.as_array())
            .ok_or_else(|| WorkbenchValidation::new(codes::CONFIG_INVALID, "config.slots 应为数组"))?;
        if slots_json.is_empty() || slots_json.len() > 10 {
            return Err(WorkbenchValidation::new(
                codes::SLOTS_INVALID,
                format!("slots 数量须为 1..=10，got {}", slots_json.len()),
            )
            .into());
        }
        let mut slots = Vec::with_capacity(slots_json.len());
        for s in slots_json {
            let req = SlotReq {
                version_id: s
                    .get("version_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                params: s.get("params").cloned().unwrap_or_else(|| serde_json::json!({})),
                weight: s.get("weight").and_then(|v| v.as_f64()).unwrap_or(f64::NAN),
            };
            slots.push(self.validate_slot(&req).await?);
        }
        let num = |key: &str, default: f64| -> Result<f64, WorkbenchValidation> {
            match obj.get(key) {
                None => Ok(default),
                Some(v) => v
                    .as_f64()
                    .ok_or_else(|| WorkbenchValidation::new(codes::CONFIG_INVALID, format!("config.{key} 应为数值"))),
            }
        };
        let buy = num("buy_threshold", strategy_core::DEFAULT_BUY_THRESHOLD)?;
        let sell = num("sell_threshold", strategy_core::DEFAULT_SELL_THRESHOLD)?;
        let initial_capital = num("initial_capital", DEFAULT_INITIAL_CAPITAL)?;
        let policy_json = obj
            .get("policy")
            .cloned()
            .ok_or_else(|| WorkbenchValidation::new(codes::POLICY_INVALID, "config.policy 必填"))?;
        let policy: ExecutionPolicy = serde_json::from_value(policy_json.clone())
            .map_err(|e| WorkbenchValidation::new(codes::POLICY_INVALID, format!("policy 非法: {e}")))?;
        let stop_json = obj.get("stop").cloned().unwrap_or(serde_json::Value::Null);
        let stop: Option<StopConfig> = if stop_json.is_null() {
            None
        } else {
            let sc: StopConfig = serde_json::from_value(stop_json.clone())
                .map_err(|e| WorkbenchValidation::new(codes::STOP_INVALID, format!("stop 非法: {e}")))?;
            if !sc.value.is_finite() || sc.value <= 0.0 {
                return Err(WorkbenchValidation::new(
                    codes::STOP_INVALID,
                    format!("stop.value 须为正有限值，got {}", sc.value),
                )
                .into());
            }
            Some(sc)
        };
        let fee_json = obj
            .get("fee")
            .cloned()
            .ok_or_else(|| WorkbenchValidation::new(codes::FEE_INVALID, "config.fee 必填"))?;
        let fee = to_fee_model(&fee_json)
            .map_err(|e| WorkbenchValidation::new(codes::FEE_INVALID, e.to_string()))?;
        // I-2/D6：预设可携带 warmup_bars（缺省 250）；非整数 → 400。
        let warmup_bars = match obj.get("warmup_bars") {
            None => DEFAULT_WARMUP_BARS,
            Some(v) => v
                .as_u64()
                .filter(|n| *n <= u32::MAX as u64)
                .map(|n| n as usize)
                .ok_or_else(|| {
                    WorkbenchValidation::new(codes::CONFIG_INVALID, "config.warmup_bars 应为非负整数")
                })?,
        };
        let probe = EnsembleConfig {
            slots: vec![],
            buy_threshold: buy,
            sell_threshold: sell,
            policy,
            stop,
            initial_capital,
            fee,
            period: backtest::Period::D1, // validate 不检视 period（仅占位）
            warmup_bars: 0,
            runtime_limits: strategy_runtime::RuntimeLimits::default(),
        };
        probe
            .validate()
            .map_err(|m| WorkbenchValidation::new(crate::error::classify_config_error(&m), m))?;

        Ok(serde_json::json!({
            "slots": slots.iter().map(|s| serde_json::json!({
                "strategy_id": s.strategy_id,
                "version_id": s.version_id,
                "version": s.version,
                "sha256": s.sha256,
                "params": s.params_json,
                "weight": s.weight,
                "archived": s.archived,
            })).collect::<Vec<_>>(),
            "buy_threshold": buy,
            "sell_threshold": sell,
            "policy": policy_json,
            "stop": stop_json,
            "initial_capital": initial_capital,
            "fee": crate::fee::fee_model_to_json(&fee),
            "warmup_bars": warmup_bars,
        }))
    }
}

// ── P4b（ADR-024 D15）每 run 固定开销仪表：**只加观测、不改行为** ───────────────
//
// 口径（时间一律以 µs 累计，汇总时换算 ms）：
// - `progress_frames_produced`：引擎 observer 内**入队**帧数（与 `tx.send` 同一判定分支）；
// - `progress_db_writes`：`store.update_progress` 实际调用次数（report 任务内，含终态补写）；
// - `progress_db_throttled`：因时间窗节流而**未在收帧时落库**的帧数（D15；含随后由终态补写补上的那一帧）；
// - `progress_db_write_ms`：上述调用累计耗时（含 await 往返与 PG fsync）；
// - `progress_ws_send_ms`：`sink.send`（WS 推送）累计耗时；
// - 分段（permit 持有或 submit 阶段）：fetch / mark_started / engine / progress_drain（report
//   任务自存活）/ progress_drain_tail（引擎结束后等排水）/ result_serialize / result_write；
// - `permit_hold_us`：`Semaphore` permit 获取成功 → `execute_run` 返回（permit 随即 drop）；
// - `permit_wait_us`：submit → permit 获取前的排队等待（**不**计入持有）。
//
// 并发性说明（判读约束）：report 任务与引擎**并行**（observer 只入队、不等待）
// ⇒ `progress_*` 段与 `engine_ms` 可重叠；**只有 `progress_drain_tail_ms` 是不重叠的等待**。
// 故不得把各段直接相加当作 permit 持有；permit 持有是各段的上界。

/// 每 run 仪表计数器（不经端口、不进 DB schema：观测面 = 既有 tracing）。
#[derive(Default)]
struct P4bRunCounters {
    bars_total: AtomicU64,
    frames_produced: AtomicU64,
    db_writes: AtomicU64,
    db_throttled: AtomicU64,
    db_write_us: AtomicU64,
    ws_send_us: AtomicU64,
    fetch_us: AtomicU64,
    permit_wait_us: AtomicU64,
    permit_hold_us: AtomicU64,
    mark_started_us: AtomicU64,
    engine_us: AtomicU64,
    drain_total_us: AtomicU64,
    drain_tail_us: AtomicU64,
    serialize_us: AtomicU64,
    result_write_us: AtomicU64,
    chunk_writes: AtomicU64,
    chunk_write_us: AtomicU64,
}

/// 进程级累计计数器（P4b：「按 run + 全局累计」的全局半边；随每 run 汇总事件一并落日志）。
#[derive(Default)]
struct P4bGlobalCounters {
    runs: AtomicU64,
    frames_produced: AtomicU64,
    db_writes: AtomicU64,
    db_write_us: AtomicU64,
    permit_hold_us: AtomicU64,
}

impl P4bGlobalCounters {
    const fn new() -> Self {
        Self {
            runs: AtomicU64::new(0),
            frames_produced: AtomicU64::new(0),
            db_writes: AtomicU64::new(0),
            db_write_us: AtomicU64::new(0),
            permit_hold_us: AtomicU64::new(0),
        }
    }
}

/// P4b 进程级累计（进程生命周期内累加；纯观测，无同步语义 ⇒ `Relaxed`）。
static P4B_GLOBAL: P4bGlobalCounters = P4bGlobalCounters::new();

/// 记录一段耗时（µs，`Relaxed`）并返回本次耗时。
fn p4b_add_us(counter: &AtomicU64, t0: Instant) -> u64 {
    let us = t0.elapsed().as_micros() as u64;
    counter.fetch_add(us, Ordering::Relaxed);
    us
}

/// ADR-024 D15：单次进度落库（计时 + 计数），供「时间窗到期」与「终态补写」共用。
async fn p4b_write_progress(
    store: &Arc<dyn StrategyRunStore>,
    id: &str,
    progress: f64,
    p4b: &Arc<P4bRunCounters>,
) {
    let t = Instant::now();
    let _ = store.update_progress(id, progress).await;
    p4b_add_us(&p4b.db_write_us, t);
    p4b.db_writes.fetch_add(1, Ordering::Relaxed);
}

/// µs → ms（观测输出口径）。
fn p4b_ms(us: u64) -> f64 {
    us as f64 / 1000.0
}

/// 分段占比（vs permit 持有；持有为 0 时返回 0.0）。
fn p4b_share_pct(part_ms: f64, hold_ms: f64) -> f64 {
    if hold_ms <= 0.0 {
        0.0
    } else {
        (part_ms / hold_ms * 10000.0).round() / 100.0
    }
}

/// 后台执行单个 run（任务制，与 BacktestService::execute_run 同模式）：
/// mark_started 原子认领（queued→running；失败 = 排队期被取消，放弃执行）→
/// spawn_blocking 跑引擎（observer：进度上报 + 协作式取消检查）→
/// 成功 mark_succeeded（同事务落结果）/ Canceled mark_canceled / 插件错误 mark_failed。
///
/// ADR-024 P4b：同一流程内加**分段计时 + 计数器 + 子 span**（只观测）；`trace_id` 由 submit
/// 生成并贯穿 submit → mark_started → 引擎 → 进度落库 → 结果落库（每 run 一条汇总事件）。
#[allow(clippy::too_many_arguments)]
async fn execute_run(
    store: Arc<dyn StrategyRunStore>,
    progress: Arc<dyn domain::ports::StrategyRunProgressSink>,
    cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    clock: Arc<dyn Clock>,
    run_id: String,
    trace_id: String,
    p4b: Arc<P4bRunCounters>,
    probe: EnsembleConfig,
    slots: Vec<ValidatedSlot>,
    bars: Vec<backtest::Bar>,
) {
    // P4b：permit 持有起点（spawn 闭包内 permit 获取成功后立即调用本函数；返回后 permit 随即 drop）。
    let t_permit_hold = Instant::now();

    // 原子认领：queued→running（排队期被取消 → 0 行 → 放弃执行）。
    let started_span =
        tracing::info_span!("p4b.segment", segment = "mark_started", run_id = %run_id);
    let t_mark_started = Instant::now();
    let claimed = store
        .mark_started(&run_id, clock.now())
        .instrument(started_span.clone())
        .await;
    let mark_started_us = p4b_add_us(&p4b.mark_started_us, t_mark_started);
    started_span.in_scope(|| {
        tracing::info!(
            trace_id = %trace_id,
            run_id = %run_id,
            elapsed_us = mark_started_us,
            "p4b.segment"
        )
    });
    match claimed {
        Ok(true) => {}
        Ok(false) => {
            tracing::info!(run_id, "运行已被并发取消/迁移，放弃执行");
            return;
        }
        Err(e) => {
            tracing::error!(run_id, error = %e, "mark_started 失败");
            let _ = store.mark_failed(&run_id, &e.to_string(), clock.now()).await;
            return;
        }
    }

    // 注册协作式取消标记（引擎 observer 回调点检查）。
    let flag = Arc::new(AtomicBool::new(false));
    cancel_flags
        .lock()
        .expect("flags poisoned")
        .insert(run_id.clone(), Arc::clone(&flag));

    // 进度/结果分块桥接：引擎 observer（同步）与分块产出均在 spawn_blocking 内，经**单一** mpsc
    // 到异步 writer 任务（WS sink + update_progress + append_result_chunk）。
    // ADR-024 P4/D8：分块**边跑边写**，先于 `mark_succeeded`；分块写失败 ⇒ run 落 failed。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<RunMsg>();
    let sink = Arc::clone(&progress);
    let store2 = Arc::clone(&store);
    let id2 = run_id.clone();
    // P4b：进度排水段（report 任务自存活周期）+ 计数；该 span 上下文覆盖
    // `store.update_progress` / `store.append_result_chunk` 调用点 ⇒ trace_id 可检索至「落库段」。
    let report_p4b = Arc::clone(&p4b);
    let report_trace = trace_id.clone();
    let drain_span =
        tracing::info_span!("p4b.segment", segment = "progress_drain", run_id = %run_id);
    let drain_span2 = drain_span.clone();
    let t_drain_total = Instant::now();
    let report_task = tokio::spawn(
        async move {
            let mut chunk_err: Option<anyhow::Error> = None;
            // ADR-024 D15：时间窗节流状态 —— 上次落库时刻 + 最近一帧未落库的进度（终态补写用）。
            let mut last_db_write: Option<Instant> = None;
            let mut pending: Option<f64> = None;
            while let Some(msg) = rx.recv().await {
                match msg {
                    RunMsg::Progress(progress, ts) => {
                        // WS 帧粒度不变：每帧仍推送（UI 流畅与落库降频解耦）。
                        let t = Instant::now();
                        let _ = sink.send(&id2, progress, Some(ts)).await;
                        p4b_add_us(&report_p4b.ws_send_us, t);
                        // 时间窗节流：距上次落库 ≥ `PROGRESS_DB_MIN_INTERVAL` 才写；
                        // 完成帧（progress>=1.0）无条件写（终态必写之一）。
                        let due = last_db_write
                            .is_none_or(|t0| t0.elapsed() >= PROGRESS_DB_MIN_INTERVAL);
                        if due || progress >= 1.0 {
                            p4b_write_progress(&store2, &id2, progress, &report_p4b).await;
                            last_db_write = Some(Instant::now());
                            pending = None;
                        } else {
                            report_p4b.db_throttled.fetch_add(1, Ordering::Relaxed);
                            pending = Some(progress);
                        }
                    }
                    RunMsg::Chunk(chunk) => {
                        if chunk_err.is_none() {
                            let t = Instant::now();
                            if let Err(e) = store2.append_result_chunk(&id2, &chunk).await {
                                tracing::error!(run_id = %id2, error = %e, "结果分块落库失败");
                                chunk_err = Some(e);
                            }
                            p4b_add_us(&report_p4b.chunk_write_us, t);
                            report_p4b.chunk_writes.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
            // 终态必写：通道关闭（引擎结束）后补写最后一帧（若它因时间窗未落库）。
            // 完成帧已由 `progress>=1.0` 分支落库；取消/中途失败时末帧 < 1.0 ⇒ 靠此处收口，
            // 保证「完成/失败/取消」三条路径的最终进度写入都不会被时间窗节流吞掉。
            if let Some(progress) = pending {
                p4b_write_progress(&store2, &id2, progress, &report_p4b).await;
            }
            drain_span2.in_scope(|| {
                tracing::info!(
                    trace_id = %report_trace,
                    run_id = %id2,
                    progress_db_writes = report_p4b.db_writes.load(Ordering::Relaxed),
                    progress_db_throttled = report_p4b.db_throttled.load(Ordering::Relaxed),
                    chunk_writes = report_p4b.chunk_writes.load(Ordering::Relaxed),
                    chunk_write_ms = p4b_ms(report_p4b.chunk_write_us.load(Ordering::Relaxed)),
                    progress_db_write_ms = p4b_ms(report_p4b.db_write_us.load(Ordering::Relaxed)),
                    progress_ws_send_ms = p4b_ms(report_p4b.ws_send_us.load(Ordering::Relaxed)),
                    "p4b.segment"
                )
            });
            chunk_err
        }
        .instrument(drain_span.clone()),
    );

    // 引擎配置：钉住槽位（code + sha256 + params + weight）。
    let mut cfg = probe;
    cfg.slots = slots
        .iter()
        .map(|s| {
            strategy_core::StrategySlot::new(
                s.code.clone(),
                s.sha256.clone(),
                s.params.clone(),
                s.weight,
            )
            .expect("submit 已校验 slot 合法")
        })
        .collect();

    let flag2 = Arc::clone(&flag);
    let engine_p4b = Arc::clone(&p4b);
    let engine_span = tracing::info_span!("p4b.segment", segment = "engine", run_id = %run_id);
    let engine_bars_total = bars.len();
    let t_engine = Instant::now();
    let outcome = tokio::task::spawn_blocking(move || {
        // ADR-024 P2/D5：会话式引擎（每 slot 插件实例常驻）；P4/D8：按 chunk 喂入并 drain
        // 已产出 per_bar 记录 **边跑边写**（非末块每满 5000 根即写一块）。
        let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
        let mut session = match EnsembleSession::new(&cfg, &mut rt) {
            Ok(s) => s,
            Err(e) => return EngineOutcome::Failed(e.to_string()),
        };
        session.set_total_hint(bars.len());
        let total = bars.len();
        let chunk = RESULT_CHUNK_BARS;
        let n_chunks = total.div_ceil(chunk);
        let mut per_bar_seq: i32 = 0;
        // ADR-024 P6：成交明细（fills 事实源）——与 per_bar 同遍扫描累积，finish 后写单块。
        let mut fills: Vec<serde_json::Value> = Vec::new();
        let mut last_milli: i64 = -1;
        let mut observer = |i: usize, tot: usize| -> LoopControl {
            // 协作式取消检查点（每 bar 末）。
            if flag2.load(Ordering::Relaxed) {
                return LoopControl::Break;
            }
            let progress = (i + 1) as f64 / tot as f64;
            // 节流：0.1% 粒度前进或最后一 bar 才发帧（防 20 万帧洪泛 WS/DB）。
            let milli = (progress * PROGRESS_THROTTLE_MILLI) as i64;
            if milli != last_milli || i + 1 == tot {
                last_milli = milli;
                // P4b：帧产生计数（与 send 同一判定分支 ⇒ 口径 = 实际入队帧数）。
                engine_p4b.frames_produced.fetch_add(1, Ordering::Relaxed);
                let _ = tx.send(RunMsg::Progress(
                    progress,
                    DateTime::from_timestamp(bars[i].ts, 0).unwrap_or_default(),
                ));
            }
            LoopControl::Continue
        };
        for ci in 0..n_chunks {
            let start = ci * chunk;
            let end = ((ci + 1) * chunk).min(total);
            if let Err(e) = session.push_batch(&bars[start..end], &mut observer) {
                return match e {
                    EnsembleError::Canceled => EngineOutcome::Canceled,
                    other => EngineOutcome::Failed(other.to_string()),
                };
            }
            // 非末块：满 chunk 即落一块（末块留给 finish 补期末强平事件）。
            let is_last = ci + 1 == n_chunks;
            if !is_last {
                let recs = session.drain_records();
                // ADR-024 P6：成交在同一遍扫描中收集（fills 单块在 finish 后写出）。
                collect_fills(&recs, &mut fills);
                if let Some(c) = per_bar_chunk(per_bar_seq, &recs) {
                    if tx.send(RunMsg::Chunk(c)).is_err() {
                        return EngineOutcome::Failed("结果分块写通道已关闭".into());
                    }
                }
                per_bar_seq += 1;
            }
        }
        let res = session.finish();
        // ADR-024 P6：末块（含期末强平成交）同样纳入 fills 事实源。
        collect_fills(&res.per_bar, &mut fills);
        // 末块 per_bar（含期末强平事件）。
        if let Some(c) = per_bar_chunk(per_bar_seq, &res.per_bar) {
            if tx.send(RunMsg::Chunk(c)).is_err() {
                return EngineOutcome::Failed("结果分块写通道已关闭".into());
            }
        }
        // fills 单块（seq=0；无成交也写空数组块 ⇒ 「有块 = 已记录」可判定）。
        if let (Some(first), Some(last)) = (bars.first(), bars.last()) {
            let chunk = fills_chunk(
                fills,
                DateTime::from_timestamp(first.ts, 0).unwrap_or_default(),
                DateTime::from_timestamp(last.ts, 0).unwrap_or_default(),
            );
            if tx.send(RunMsg::Chunk(chunk)).is_err() {
                return EngineOutcome::Failed("结果分块写通道已关闭".into());
            }
        }
        // 净值/回撤分块（仅 in-range；chunk = 5000）。
        for (kind, series) in [
            (ResultKind::NetValue, &res.net_value),
            (ResultKind::Drawdown, &res.drawdown),
        ] {
            for (i, win) in series.chunks(RESULT_CHUNK_BARS).enumerate() {
                if let Some(c) = series_chunk(kind, i as i32, win) {
                    if tx.send(RunMsg::Chunk(c)).is_err() {
                        return EngineOutcome::Failed("结果分块写通道已关闭".into());
                    }
                }
            }
        }
        EngineOutcome::Done(RunTail {
            trades: serde_json::to_value(&res.trades).expect("trades 可序列化"),
            metrics: serde_json::to_value(res.metrics).expect("metrics 可序列化"),
        })
    })
    .instrument(engine_span.clone())
    .await
    .map_err(|e| anyhow!("引擎任务 panic: {e}"));
    let engine_us = p4b_add_us(&p4b.engine_us, t_engine);
    engine_span.in_scope(|| {
        tracing::info!(
            trace_id = %trace_id,
            run_id = %run_id,
            elapsed_us = engine_us,
            bars_total = engine_bars_total,
            "p4b.segment"
        )
    });

    // 引擎结束（含 Break）后 drop 发送端；等报告任务排空（进度/落库完成，确定可复现）。
    // ⚠ P4b 纪律：**排水顺序不变**（仍在 `mark_succeeded` 之前），本批不改行为。
    let tail_span =
        tracing::info_span!("p4b.segment", segment = "progress_drain_tail", run_id = %run_id);
    let t_tail = Instant::now();
    let chunk_err = match report_task.await {
        Ok(e) => e,
        Err(e) => Some(anyhow!("结果 writer 任务 panic: {e}")),
    };
    let tail_us = p4b_add_us(&p4b.drain_tail_us, t_tail);
    let drain_total_us = p4b_add_us(&p4b.drain_total_us, t_drain_total);
    tail_span.in_scope(|| {
        tracing::info!(
            trace_id = %trace_id,
            run_id = %run_id,
            elapsed_us = tail_us,
            progress_drain_total_ms = p4b_ms(drain_total_us),
            "p4b.segment"
        )
    });
    // 摘销取消标记。
    cancel_flags.lock().expect("flags poisoned").remove(&run_id);

    let outcome_label = match &outcome {
        Ok(EngineOutcome::Done(_)) if chunk_err.is_none() => "succeeded",
        Ok(EngineOutcome::Done(_)) => "failed_chunk_write",
        Ok(EngineOutcome::Canceled) => "canceled",
        Ok(EngineOutcome::Failed(_)) => "failed",
        Err(_) => "failed_panic",
    };
    match outcome {
        Ok(EngineOutcome::Done(tail)) => {
            if let Some(e) = chunk_err {
                // D8 硬约束：分块写失败 ⇒ run 必须落 failed（不得留半截结果当 succeeded）。
                let _ = store
                    .mark_failed(&run_id, &format!("结果分块落库失败: {e}"), clock.now())
                    .await;
            } else {
                let serialize_span = tracing::info_span!(
                    "p4b.segment", segment = "result_serialize", run_id = %run_id);
                let t_serialize = Instant::now();
                // 分块已落库；strategy_run_result 仅写 trades/metrics + 占位（读取以 result_format 判别）。
                let result = chunked_result(tail);
                let serialize_us = p4b_add_us(&p4b.serialize_us, t_serialize);
                serialize_span.in_scope(|| {
                    tracing::info!(
                        trace_id = %trace_id,
                        run_id = %run_id,
                        elapsed_us = serialize_us,
                        "p4b.segment"
                    )
                });
                let write_span =
                    tracing::info_span!("p4b.segment", segment = "result_write", run_id = %run_id);
                let t_write = Instant::now();
                let written = store
                    .mark_succeeded(&run_id, &result, clock.now())
                    .instrument(write_span.clone())
                    .await;
                let write_us = p4b_add_us(&p4b.result_write_us, t_write);
                write_span.in_scope(|| {
                    tracing::info!(
                        trace_id = %trace_id,
                        run_id = %run_id,
                        elapsed_us = write_us,
                        "p4b.segment"
                    )
                });
                match written {
                    Ok(true) => {}
                    Ok(false) => {
                        // 如并发取消胜出：分块已在库（取消后分块已写），但 run **不**落 succeeded。
                        tracing::info!(run_id, "运行完成但已被并发迁移（如取消），结果不落库")
                    }
                    Err(e) => tracing::error!(run_id, error = %e, "mark_succeeded 失败"),
                }
            }
        }
        Ok(EngineOutcome::Canceled) => {
            // 协作式取消落 DB（cancel() 通常已置；此处兜底引擎自主 Break 路径）。
            // 已写的分块保留（与 ADR-024 D8 一致：取消不落 succeeded 由 mark_succeeded 守卫保证）。
            let _ = store.mark_canceled(&run_id, clock.now()).await;
        }
        Ok(EngineOutcome::Failed(msg)) => {
            let _ = store.mark_failed(&run_id, &msg, clock.now()).await;
        }
        Err(e) => {
            let _ = store.mark_failed(&run_id, &e.to_string(), clock.now()).await;
        }
    }

    // ── P4b 每 run 汇总（自洽性：`progress_frames_produced == progress_db_writes`）──
    let hold_us = {
        let us = t_permit_hold.elapsed().as_micros() as u64;
        p4b.permit_hold_us.store(us, Ordering::Relaxed);
        us
    };
    let bars_total = p4b.bars_total.load(Ordering::Relaxed);
    let produced = p4b.frames_produced.load(Ordering::Relaxed);
    let writes = p4b.db_writes.load(Ordering::Relaxed);
    let throttled = p4b.db_throttled.load(Ordering::Relaxed);
    let db_write_ms = p4b_ms(p4b.db_write_us.load(Ordering::Relaxed));
    let ws_send_ms = p4b_ms(p4b.ws_send_us.load(Ordering::Relaxed));
    let hold_ms = p4b_ms(hold_us);
    let engine_ms = p4b_ms(p4b.engine_us.load(Ordering::Relaxed));
    let serialize_ms = p4b_ms(p4b.serialize_us.load(Ordering::Relaxed));
    let result_write_ms = p4b_ms(p4b.result_write_us.load(Ordering::Relaxed));
    let drain_tail_ms = p4b_ms(p4b.drain_tail_us.load(Ordering::Relaxed));
    let drain_total_ms = p4b_ms(p4b.drain_total_us.load(Ordering::Relaxed));
    let mark_started_ms = p4b_ms(p4b.mark_started_us.load(Ordering::Relaxed));
    let frame_avg_ms = if writes > 0 { db_write_ms / writes as f64 } else { 0.0 };
    let global_runs = P4B_GLOBAL.runs.fetch_add(1, Ordering::Relaxed) + 1;
    let global_frames = P4B_GLOBAL.frames_produced.fetch_add(produced, Ordering::Relaxed) + produced;
    let global_writes = P4B_GLOBAL.db_writes.fetch_add(writes, Ordering::Relaxed) + writes;
    let db_write_us = p4b.db_write_us.load(Ordering::Relaxed);
    let global_db_write_ms =
        p4b_ms(P4B_GLOBAL.db_write_us.fetch_add(db_write_us, Ordering::Relaxed) + db_write_us);
    let global_hold_ms =
        p4b_ms(P4B_GLOBAL.permit_hold_us.fetch_add(hold_us, Ordering::Relaxed) + hold_us);
    tracing::info!(
        run_id = %run_id,
        trace_id = %trace_id,
        outcome = outcome_label,
        bars_total,
        progress_frames_produced = produced,
        progress_db_writes = writes,
        progress_db_throttled = throttled,
        progress_db_write_ms = db_write_ms,
        progress_ws_send_ms = ws_send_ms,
        progress_frame_avg_ms = frame_avg_ms,
        permit_hold_ms = hold_ms,
        permit_wait_ms = p4b_ms(p4b.permit_wait_us.load(Ordering::Relaxed)),
        fetch_ms = p4b_ms(p4b.fetch_us.load(Ordering::Relaxed)),
        mark_started_ms,
        engine_ms,
        progress_drain_total_ms = drain_total_ms,
        progress_drain_tail_ms = drain_tail_ms,
        result_serialize_ms = serialize_ms,
        result_write_ms,
        engine_share_pct = p4b_share_pct(engine_ms, hold_ms),
        progress_db_share_pct = p4b_share_pct(db_write_ms, hold_ms),
        progress_tail_share_pct = p4b_share_pct(drain_tail_ms, hold_ms),
        result_write_share_pct = p4b_share_pct(result_write_ms, hold_ms),
        result_serialize_share_pct = p4b_share_pct(serialize_ms, hold_ms),
        mark_started_share_pct = p4b_share_pct(mark_started_ms, hold_ms),
        global_runs_total = global_runs,
        global_frames_total = global_frames,
        global_db_writes_total = global_writes,
        global_db_write_ms_total = global_db_write_ms,
        global_permit_hold_ms_total = global_hold_ms,
        "p4b.run_summary"
    );
}

/// 结果 writer 通道消息（ADR-024 P4）：进度帧 + 结果分块。
enum RunMsg {
    /// 进度帧（progress 0..1, bar_ts）。
    Progress(f64, DateTime<Utc>),
    /// 结果分块（边跑边写）。
    Chunk(ResultChunk),
}

/// `mark_succeeded` 所需的尾部信息（per_bar/net_value/drawdown 已分块落库）。
struct RunTail {
    trades: serde_json::Value,
    metrics: serde_json::Value,
}

/// spawn_blocking 引擎结果（ADR-024 P4）：成功/取消/失败三态（分块经通道已写）。
enum EngineOutcome {
    Done(RunTail),
    Canceled,
    Failed(String),
}

/// 构造分块版的 `strategy_run_result`：per_bar/net_value/drawdown 为 `[]` 占位，
/// 数据在 `strategy_run_bars`（读取一律以 `result_format` 判别，禁止把占位当数据）。
fn chunked_result(tail: RunTail) -> StrategyRunResult {
    StrategyRunResult {
        per_bar: serde_json::json!([]),
        trades: tail.trades,
        net_value: serde_json::json!([]),
        drawdown: serde_json::json!([]),
        metrics: tail.metrics,
        result_format: RESULT_FORMAT_CHUNKED.to_string(),
    }
}

/// 从 BarRecord 收集成交事件（解析态；引擎闭包内按 chunk 累积）——ADR-024 P6 fills 事实源。
fn collect_fills(records: &[BarRecord], out: &mut Vec<serde_json::Value>) {
    for rec in records {
        for ev in &rec.events {
            if let strategy_core::EngineEvent::Fill { bar_index, side, qty, price, reason } = ev {
                out.push(serde_json::json!({
                    "type": "fill", "bar_index": bar_index, "ts": rec.ts,
                    "side": side, "qty": qty, "price": price, "reason": reason,
                }));
            }
        }
    }
}

/// fills 单块（`seq=0`；ADR-024 P6）。**无成交也写空数组块** ⇒ 读侧「有块 = 已记录」可判定，
/// 与「未写」（P6 之前的 chunked run）区分；`ts_from`/`ts_to` = 本 run 首/末 bar ts（空成交块取 bar 区间）。
fn fills_chunk(
    fills: Vec<serde_json::Value>,
    ts_from: DateTime<Utc>,
    ts_to: DateTime<Utc>,
) -> ResultChunk {
    ResultChunk {
        kind: ResultKind::Fills,
        seq: 0,
        ts_from,
        ts_to,
        payload: serde_json::Value::Array(fills),
    }
}

/// legacy 内联 per_bar（JSON 投影）的 `fill` 事件 → fills 数组（旧 run 不回填）。
fn legacy_fills(res: &StrategyRunResult) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for v in res.per_bar.as_array().cloned().unwrap_or_default() {
        let ts = v.get("ts").and_then(|t| t.as_i64()).unwrap_or(0);
        for ev in v.get("events").and_then(|e| e.as_array()).cloned().unwrap_or_default() {
            if ev.get("type").and_then(|t| t.as_str()) != Some("fill") {
                continue;
            }
            out.push(serde_json::json!({
                "type": "fill",
                "bar_index": ev.get("bar_index"),
                "ts": ts,
                "side": ev.get("side"),
                "qty": ev.get("qty"),
                "price": ev.get("price"),
                "reason": ev.get("reason"),
            }));
        }
    }
    out
}

/// per_bar 分块（`payload` = 该块 BarRecord 数组；`ts_from`/`ts_to` = 首/末根 bar ts）。
fn per_bar_chunk(seq: i32, records: &[BarRecord]) -> Option<ResultChunk> {
    if records.is_empty() {
        return None;
    }
    let ts_from = DateTime::from_timestamp(records[0].ts, 0).unwrap_or_default();
    let ts_to = DateTime::from_timestamp(records[records.len() - 1].ts, 0).unwrap_or_default();
    let payload = serde_json::to_value(PerBarRecords(records)).expect("per_bar 可序列化");
    Some(ResultChunk { kind: ResultKind::PerBar, seq, ts_from, ts_to, payload })
}

/// 净值/回撤分块（`payload` = `[[ts, value], ...]` 子数组）。
fn series_chunk(kind: ResultKind, seq: i32, series: &[(i64, f64)]) -> Option<ResultChunk> {
    if series.is_empty() {
        return None;
    }
    let ts_from = DateTime::from_timestamp(series[0].0, 0).unwrap_or_default();
    let ts_to = DateTime::from_timestamp(series[series.len() - 1].0, 0).unwrap_or_default();
    let payload = serde_json::to_value(series).expect("净值/回撤可序列化");
    Some(ResultChunk { kind, seq, ts_from, ts_to, payload })
}

/// per_bar 序列化包装（BarRecord 字段含非 Serialize 的 PluginError outcome——
/// 投影为纯 JSON 形态：scores[{slot_idx, score, error?}], aggregate, signal, orders, events）。
struct PerBarRecords<'a>(&'a [BarRecord]);

impl Serialize for PerBarRecords<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = s.serialize_seq(Some(self.0.len()))?;
        for rec in self.0 {
            seq.serialize_element(&bar_record_json(rec))?;
        }
        seq.end()
    }
}

/// BarRecord → JSON（各策略分 + 聚合分 + 信号 + 订单 + 事件全量；错误以字符串落——
/// PluginError 非 Serialize，错误事件自含 sha256/bar_index 于 message，ADR §10 不静默吞错）。
fn bar_record_json(rec: &strategy_core::BarRecord) -> serde_json::Value {
    let scores: Vec<serde_json::Value> = rec
        .scores
        .iter()
        .map(|sc| match &sc.outcome {
            strategy_core::SlotScoreOutcome::Ok(_) => serde_json::json!({
                "slot_idx": sc.slot_idx,
                "score": sc.score,
            }),
            strategy_core::SlotScoreOutcome::Err(e) => serde_json::json!({
                "slot_idx": sc.slot_idx,
                "score": sc.score,
                "error": e.to_string(),
            }),
        })
        .collect();
    let events: Vec<serde_json::Value> = rec
        .events
        .iter()
        .map(|ev| match ev {
            strategy_core::EngineEvent::PluginError { slot_idx, code_hash, bar_index, error } => {
                serde_json::json!({
                    "type": "plugin_error", "slot_idx": slot_idx, "sha256": code_hash,
                    "bar_index": bar_index, "error": error.to_string(),
                })
            }
            strategy_core::EngineEvent::CircuitBreaker { slot_idx, code_hash, bar_index } => {
                serde_json::json!({
                    "type": "circuit_breaker", "slot_idx": slot_idx, "sha256": code_hash,
                    "bar_index": bar_index,
                })
            }
            strategy_core::EngineEvent::PluginLog { slot_idx, bar_index, msg } => {
                serde_json::json!({
                    "type": "plugin_log", "slot_idx": slot_idx, "bar_index": bar_index,
                    "message": msg,
                })
            }
            strategy_core::EngineEvent::Fill { bar_index, side, qty, price, reason } => {
                serde_json::json!({
                    "type": "fill", "bar_index": bar_index, "side": side, "qty": qty,
                    "price": price, "reason": reason,
                })
            }
        })
        .collect();
    serde_json::json!({
        "ts": rec.ts,
        "warmup": rec.warmup,
        "scores": scores,
        "aggregate": rec.aggregate,
        "signal": rec.signal,
        "orders": rec.orders,
        "events": events,
    })
}
