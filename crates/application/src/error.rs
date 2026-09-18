//! 结构化应用层错误（ADR-024 §3.1.1；手写，非 tangle）。
//!
//! 目的：把「可编程消费」的 400 从「人类可读字符串」升级为
//! `{"error":{"code","message","detail":{...}}}`，前端据此分支展示
//! （`range_empty` 展示可用区间、`resource_guard` 走二次确认）。
//!
//! 分层：application 只产出**纯数据**（code/message/detail）；HTTP 形状（状态码/JSON 包裹）
//! 由 web 层决定（`crates/web` 的 `map_svc_err`）。

use serde::Serialize;

/// ADR-024 §3.1.1 的 400 `code` 常量（**稳定标识**）。
///
/// 约定（架构师 N1 裁决）：snake_case、`名词_原因`；**一旦发布不得改名**（改名 = 契约变更）。
/// 命名权在 application 层：码与**产生该消息的校验点**同源给出，web 侧只读取、禁字符串解析。
pub mod codes {
    // ── §3.1.1 明确列举 ──
    pub const RANGE_EMPTY: &str = "range_empty";
    pub const RESOURCE_GUARD: &str = "resource_guard";
    pub const PERIOD_INVALID: &str = "period_invalid";
    pub const FROM_AFTER_TO: &str = "from_after_to";
    /// RFC3339 解析失败（与 `from_after_to` 并存，不合并）。
    pub const TIMESTAMP_INVALID: &str = "timestamp_invalid";

    // ── 提交/试算参数类 ──
    pub const SYMBOL_REQUIRED: &str = "symbol_required";
    pub const SYMBOL_UNREGISTERED: &str = "symbol_unregistered";
    pub const SLOTS_INVALID: &str = "slots_invalid";
    pub const WEIGHT_INVALID: &str = "weight_invalid";
    pub const PARAMS_INVALID: &str = "params_invalid";
    pub const THRESHOLD_INVALID: &str = "threshold_invalid";
    pub const POLICY_INVALID: &str = "policy_invalid";
    pub const STOP_INVALID: &str = "stop_invalid";
    pub const FEE_INVALID: &str = "fee_invalid";
    pub const CAPITAL_INVALID: &str = "capital_invalid";
    pub const VERSION_NOT_RUNNABLE: &str = "version_not_runnable";
    /// 试算 `code` / `version_id` 二选一（或缺档）非法。
    pub const SOURCE_INVALID: &str = "source_invalid";
    pub const MODE_INVALID: &str = "mode_invalid";
    /// 插件代码本身非法（冒烟/发布门禁不通过）。
    pub const CODE_INVALID: &str = "code_invalid";

    // ── 两模块内其余 400（架构师裁决：同模块 400 一律结构化，故需自明码）──
    pub const NAME_REQUIRED: &str = "name_required";
    pub const CODE_REQUIRED: &str = "code_required";
    pub const IDS_REQUIRED: &str = "ids_required";
    pub const STATUS_INVALID: &str = "status_invalid";
    pub const KIND_INVALID: &str = "kind_invalid";
    pub const LEVEL_INVALID: &str = "level_invalid";
    pub const CONFIG_INVALID: &str = "config_invalid";
    /// 兜底（结构性/互斥/字段缺失等无语义专属码者）。
    pub const REQUEST_INVALID: &str = "request_invalid";

    /// **全部**码（供 parity/防漂移用例枚举；新增码必须同时加入本表）。
    pub const ALL: &[&str] = &[
        RANGE_EMPTY,
        RESOURCE_GUARD,
        PERIOD_INVALID,
        FROM_AFTER_TO,
        TIMESTAMP_INVALID,
        SYMBOL_REQUIRED,
        SYMBOL_UNREGISTERED,
        SLOTS_INVALID,
        WEIGHT_INVALID,
        PARAMS_INVALID,
        THRESHOLD_INVALID,
        POLICY_INVALID,
        STOP_INVALID,
        FEE_INVALID,
        CAPITAL_INVALID,
        VERSION_NOT_RUNNABLE,
        SOURCE_INVALID,
        MODE_INVALID,
        CODE_INVALID,
        NAME_REQUIRED,
        CODE_REQUIRED,
        IDS_REQUIRED,
        STATUS_INVALID,
        KIND_INVALID,
        LEVEL_INVALID,
        CONFIG_INVALID,
        REQUEST_INVALID,
    ];
}

/// `strategy-core` 配置校验字符串错误 → 码。
///
/// 理由：`EnsembleConfig::validate` / `ExecutionPolicy::validate` 的产物是 `String`，而
/// strategy-core **不属本单范围**（不改引擎/指标），故按**其稳定消息前缀**在此单点归类；
/// 归类结果由 `crates/web/tests/adr024_structured_errors.rs` 的 HTTP 级表驱动用例钉住。
pub fn classify_config_error(msg: &str) -> &'static str {
    if msg.starts_with("buy_threshold") || msg.starts_with("sell_threshold") {
        codes::THRESHOLD_INVALID
    } else if msg.starts_with("initial_capital") || msg.starts_with("capital") {
        codes::CAPITAL_INVALID
    } else if msg.starts_with("LumpSum") || msg.starts_with("Dca") || msg.starts_with("policy") {
        codes::POLICY_INVALID
    } else {
        codes::REQUEST_INVALID
    }
}

/// 结构化错误（`code` + 人类可读 `message` + 机器可读 `detail`）。
///
/// `code` 取值（ADR-024 §3.1.1）：`range_empty` | `resource_guard` | `period_invalid` |
/// `from_after_to` | …（本批实装前两者 + 周期/区间基础校验）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StructuredError {
    pub code: String,
    pub message: String,
    /// 机器可读补充（对象；无补充时为 `{}`）。
    pub detail: serde_json::Value,
}

impl StructuredError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, detail: serde_json::Value) -> Self {
        Self { code: code.into(), message: message.into(), detail }
    }
}

impl std::fmt::Display for StructuredError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for StructuredError {}

/// RFC3339 序列化 `DateTime<Utc>`（JSON detail 回显口径）。
pub fn ts(v: chrono::DateTime<chrono::Utc>) -> serde_json::Value {
    serde_json::Value::String(v.to_rfc3339())
}

// ── ADR-024 P5 / D1：资源护栏（**删除一切日历天数档**后的唯一物理护栏） ──
//
// 依据：M1 全历史（2012-01-04→今）≈ **0.86M bar** ⇒ 合法请求永不触发硬上界；2M bar ≈ 96 MB（48 B/bar）。
// 旧 `MAX_BARS = 200_000`（读完 bar 后才判的补偿性补丁）随 O(n²)→O(n) 一并**删除**。

/// 硬上界（**无 confirm 放行**）：预估/实际 bar 数 > 此值 ⇒ 400 `resource_guard`。
///
/// 2026-09-18 修订：保持 `2_000_000` 不变（M1 全历史≈86 万 bar ⇒ 合法请求永不触发）。
pub const MAX_BARS_GUARD: usize = 2_000_000;
/// 二次确认阈值：预估/实际 bar 数 ≥ 此值 ⇒ 400 `resource_guard` 带 `detail`；客户端 `confirm=true` 重提 ⇒ 放行。
///
/// 2026-09-18 用户「按推荐」修订：由 `200_000` 提到 **`500_000`（≈M1 五年）** ——
/// 低于此值的合法区间一次提交即过（不再被二次确认打断）；硬上界 [`MAX_BARS_GUARD`] 不变。
/// 两常量与 `design/16-backtest-scalability/contract-vectors.json`
/// `span_limit_semantics.resource_guard.{max_bars_guard, confirm_bars}` **绑定**
/// （防漂移断言：`crates/application/tests/resource_guard_contract_vectors.rs`）。
pub const GUARD_CONFIRM_BARS: usize = 500_000;

/// 每 run **固定成本**（秒）：P1c 真路径实测每 run 1003 次 `UPDATE strategy_run`（1001 进度帧 + 2 状态迁移）
/// × 每帧写库中位 ~0.86 ms ≈ 0.85 s（与 bars 无关）。**必须计入**预估算子（ADR-024 D1 修订）。
const RUN_FIXED_SECS: f64 = 0.85;
/// 每 bar **端到端口径**系数（秒/bar）：生产端到端 ~1,600 bars/s（ADR-024 §2.3）⇒ ~6.25e-4。
/// **不得**用引擎内核口径（内核 b≈3.8 µs/bar，二者差 ~2 个量级；P1b 教训）。
const RUN_PER_BAR_SECS: f64 = 6.25e-4;

/// 预估耗时（秒；**过渡口径**，P4b 后须重标定）：含每 run 固定成本 + 每 bar 端到端成本。
///
/// 形式：`t = RUN_FIXED_SECS + bars × RUN_PER_BAR_SECS`。固定项是短区间的**主导**成本
/// （千根 bar 的 run：引擎 ~6–15 ms vs 端到端 ~854 ms），不得省略。
pub fn estimate_secs(bars: usize) -> f64 {
    ((RUN_FIXED_SECS + bars as f64 * RUN_PER_BAR_SECS) * 1000.0).round() / 1000.0
}

/// 资源护栏判定（ADR-024 D1）：`Some(错误)` = 拒绝；`None` = 放行。
/// 硬上界（> [`MAX_BARS_GUARD`]）不可 confirm 放行；二次确认阈值（≥ [`GUARD_CONFIRM_BARS`]）需 `confirm=true`。
pub fn guard_bars(
    bars: usize,
    confirm: bool,
    period: &str,
    symbol: &str,
    available: Option<(chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)>,
) -> Option<StructuredError> {
    if bars <= MAX_BARS_GUARD && (bars < GUARD_CONFIRM_BARS || confirm) {
        return None;
    }
    let secs = estimate_secs(bars);
    let hard = bars > MAX_BARS_GUARD;
    // `detail` 口径（与 contract-vectors.json `span_limit_semantics.resource_guard` 绑定）：
    //   limit_bars = MAX_BARS_GUARD（硬上界，confirm 不放行）；
    //   confirm_bars = GUARD_CONFIRM_BARS（二次确认阈值，confirm=true 放行）；
    //   requested_bars = 预估/实际 bar 数；confirmable = 非硬上界。
    let mut detail = serde_json::json!({
        "symbol": symbol,
        "period": period,
        "requested_bars": bars,
        "limit_bars": MAX_BARS_GUARD,
        "confirm_bars": GUARD_CONFIRM_BARS,
        "estimated_secs": secs,
        "confirmable": !hard,
    });
    if let Some((from, to)) = available {
        detail["available_from"] = ts(from);
        detail["available_to"] = ts(to);
    }
    let message = if hard {
        format!("预估 {bars} 根 bar 超过硬上界 {MAX_BARS_GUARD} 根（资源护栏；不可放行）")
    } else {
        format!(
            "预估 {bars} 根 bar（≈{secs:.1} 秒）达到二次确认阈值 {GUARD_CONFIRM_BARS} 根；如仍要提交，带 confirm=true 重提"
        )
    };
    Some(StructuredError::new("resource_guard", message, detail))
}

/// 空交集 400（`range_empty`）：该标的该周期无数据或请求区间与可得区间无交集；回显可用区间。
pub fn range_empty_error(
    symbol: &str,
    period: &str,
    requested_from: chrono::DateTime<chrono::Utc>,
    requested_to: chrono::DateTime<chrono::Utc>,
    available: Option<domain::ports::AvailableRange>,
) -> StructuredError {
    let mut detail = serde_json::json!({
        "symbol": symbol,
        "period": period,
        "requested_from": ts(requested_from),
        "requested_to": ts(requested_to),
        "available_from": serde_json::Value::Null,
        "available_to": serde_json::Value::Null,
    });
    if let Some(a) = available {
        detail["available_from"] = ts(a.from);
        detail["available_to"] = ts(a.to);
    }
    let message = match available {
        Some(a) => format!(
            "请求区间与可得区间无交集（{symbol} {period} 可用区间：{} ~ {}）",
            a.from.to_rfc3339(),
            a.to.to_rfc3339()
        ),
        None => format!("该标的该周期无数据（{symbol} {period}）"),
    };
    StructuredError::new("range_empty", message, detail)
}
