//! EnsembleEngine（ADR §6 完整管线，单标的，D5）。
//!
//! 每 bar 事件循环（顺序即口径，勿调）：
//! 1. 执行上一 bar 决策的挂单（本 bar open 成交；滑点/FeeModel 复用 backtest 口径）；
//! 2. Intrabar 硬止损检查（持仓中且 trigger=Intrabar）：bar.low 触线 → 按止损价
//!    ×(1−slippage) **当 bar** 成交——「close 判定次 bar open 成交」的唯一例外场景
//!    （ADR §13.3 注明）；ATR 线用**截至上一 bar** 数据计算（当 bar close 在 bar 内
//!    尚不可知，避免前视，ADR §13.1 MINOR-1 裁决）；触发即平仓并**重置 PolicyState**
//!    （外部中断，ADR §13.1 MAJOR-2 裁决）；
//! 3. 构建 [`BarCtx`]（含 [`PositionSnapshot`] 只读持仓全景，ABI §2.5——position-aware
//!    插件依赖；空仓时 host 给 `None`）；
//! 4. 各活跃 slot `on_bar` 评分：错误走 G5（中立分 50 + 错误事件自含 sha256/bar_index +
//!    连续错误计数；≥ [`CIRCUIT_BREAKER_THRESHOLD`] 次 → 本运行停用 + 熔断告警事件，
//!    后续按「无覆盖」处理——熔断计数/停用属引擎层职责，ABI §3 G5 归属澄清）；
//! 5. 聚合 = Σ(w·s)/Σw（仅活跃 slot；无覆盖 → 中立 50）→ 阈值判定信号；
//! 6. CloseBasis 硬止损检查（持仓中且 trigger=CloseBasis）：收盘触线 → 次 bar open
//!    平仓挂单（标注 stop_trigger，**绕过 Policy**）；ATR 线含当前 bar（收盘后判定，
//!    无前视）；触发同时**重置 PolicyState**（MAJOR-2 裁决，强平后首个 Buy 重新计数）；
//! 7. 否则 ExecutionPolicy 换算目标仓位（幂等）→ 订单 = 目标 − 当前 → 次 bar open 挂单；
//! 8. 记录收盘净值 + per_bar 全量数据（ADR §13.4 全量落库的数据源）。
//! 9. observer 钩子调用（每 bar 末恰一次，P3a 裁决：进度上报 + 协作式取消）：
//!    返回 [`LoopControl::Break`] → 立即跳出循环（不做期末强平、不产出结果）
//!    → [`EnsembleError::Canceled`]。
//!
//! 期末仍持仓 → 最后 close 强制平仓（沿用 backtest 引擎口径，净值最后一点修正为已实现净值）。
//! 绩效 = `backtest::metrics::compute_metrics`（8 项）+ `compute_drawdown`，与内建回测一致。

use std::rc::Rc;

use backtest::{
    aggregate_round_trips, assign_rt_seq, compute_drawdown, compute_metrics, Bar, FeeModel,
    FillFact, FillReason, OnlineIndicators, Period, RtSeqAssigner, TradeDetail,
};
use serde::{Deserialize, Serialize};
use strategy_runtime::{
    BarCtx, BarHistory, PluginError, PluginInstance, PluginRuntime, PositionSnapshot,
    RuntimeLimits,
};

use crate::aggregate::{aggregate, classify, StrategySlot, TradeSignal, NEUTRAL_SCORE};
use crate::policy::{ExecutionPolicy, PolicyState};
use crate::stop::{StopConfig, StopTrigger, TrailingState};

/// G5 熔断阈值：单插件实例**连续**错误达到此次数 → 本运行停用（ABI §3 G5）。
pub const CIRCUIT_BREAKER_THRESHOLD: u32 = 10;

/// 观察者返回的运行控制（P3a 裁决 2026-09-09：进度上报 + 协作式取消钩子）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopControl {
    /// 继续下一 bar。
    Continue,
    /// 立即跳出循环（协作式取消）：不做期末强平、不产出结果 → [`EnsembleError::Canceled`]。
    Break,
}

/// Ensemble 运行错误（P3a 加法）。**取消不是插件错误**（裁决契约），独立 variant 表达；
/// 插件运行时错误经 [`EnsembleError::Plugin`] 包装（`From<PluginError>` 转换）。
#[derive(Debug, Clone, PartialEq)]
pub enum EnsembleError {
    /// 运行被协作式取消（observer 返回 [`LoopControl::Break`]）。
    Canceled,
    /// 插件运行时错误（实例化失败等；原样包装 [`PluginError`]）。
    Plugin(PluginError),
}

impl From<PluginError> for EnsembleError {
    fn from(e: PluginError) -> Self {
        EnsembleError::Plugin(e)
    }
}

impl std::fmt::Display for EnsembleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnsembleError::Canceled => write!(f, "运行已被取消（observer Break）"),
            EnsembleError::Plugin(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for EnsembleError {}

impl EnsembleConfig {
    /// 配置校验（`run_ensemble` 启动时调用；非法配置直接拒绝运行，NIT-3）：
    /// - `buy_threshold` 必须严格大于 `sell_threshold`（且均为有限值）；
    /// - **阈值必须夹中立 50**（MINOR-4：`buy_threshold > 50` 且 `sell_threshold < 50`）——
    ///   保证「全部熔断 → 聚合中立 50 → Hold」契约不被阈值配置破坏
    ///   （buy ≤ 50 则中立 50 误判 Buy；sell ≥ 50 则中立 50 误判 Sell）；
    /// - `initial_capital` 必须为正有限值；
    /// - `policy` 自身校验（LumpSum position_pct ∈ (0,1]；Dca tranches ≥ 1 等）。
    ///
    /// 零 slot 属合法「无覆盖」场景（全程中立 50），不在此拒绝（MINOR-4 裁决）。
    pub fn validate(&self) -> Result<(), String> {
        if !self.buy_threshold.is_finite()
            || !self.sell_threshold.is_finite()
            || self.buy_threshold <= self.sell_threshold
        {
            return Err(format!(
                "buy_threshold 必须严格大于 sell_threshold，got {} <= {}",
                self.buy_threshold, self.sell_threshold
            ));
        }
        if self.buy_threshold <= NEUTRAL_SCORE || self.sell_threshold >= NEUTRAL_SCORE {
            return Err(format!(
                "buy_threshold 必须 > 50 且 sell_threshold 必须 < 50（夹中立 50，全熔断→Hold 契约），got {} / {}",
                self.buy_threshold, self.sell_threshold
            ));
        }
        if !self.initial_capital.is_finite() || self.initial_capital <= 0.0 {
            return Err(format!(
                "initial_capital 必须为正有限值，got {}",
                self.initial_capital
            ));
        }
        // P1b（02-spec §1.1/§1.2）：`symbol` 是 `FillFact.code`/`TradeDetail.code` 的取值来源，
        // 也是 L1 聚合的分组键 ⇒ 空串属静默失真，fail loud。
        if self.symbol.trim().is_empty() {
            return Err(
                "symbol（标的代码）必填：FillFact.code / TradeDetail.code 的取值来源（02-spec §1.1）"
                    .to_string(),
            );
        }
        self.policy.validate()?;
        Ok(())
    }
}

/// Ensemble 运行配置。
#[derive(Debug, Clone, PartialEq)]
pub struct EnsembleConfig {
    /// **标的代码**（run 的 symbol）：逐笔成交事实 `FillFact.code` / L1 `TradeDetail.code` 的
    /// **取值来源**（02-spec §1.1/§1.2；`code` 是 L1 聚合的分组键 ⇒ 禁止空串/占位）。
    /// 架构裁决 2026-09-20（P1b）：本字段为本轮新增的唯一 symbol 来源。
    pub symbol: String,
    /// 策略槽位（代码 + sha256 + 参数 + 权重）。
    pub slots: Vec<StrategySlot>,
    /// 买入阈值（聚合 ≥ 此值 → Buy；ADR 默认 60）。
    pub buy_threshold: f64,
    /// 卖出阈值（聚合 ≤ 此值 → Sell；ADR 默认 40）。
    pub sell_threshold: f64,
    /// 执行策略（信号 → 目标仓位）。
    pub policy: ExecutionPolicy,
    /// 硬止损（可选；ADR §13.3 第二层）。
    pub stop: Option<StopConfig>,
    pub initial_capital: f64,
    /// 费用模型（复用 backtest::FeeModel：佣金 + 最低费用 + 印花税 + 滑点）。
    pub fee: FeeModel,
    /// 周期（绩效年化因子用，对应 backtest::Period）。
    pub period: Period,
    /// 前置预热根数（I-2/D6，架构师 2026-09-12 裁决 = 方案 A）。`bars` 前 `warmup_bars` 根
    /// 为 **warmup 段**：引擎仍逐 bar 调用插件（真预热指标/插件状态），per_bar 记 `warmup=true`，
    /// 但**不执行 Policy、不产订单、不成交、不计净值/回撤/绩效**；warmup 结束后从空仓开始正常执行。
    /// `0` = 旧行为（无预热，向后兼容）。引擎内部按 `min(warmup_bars, bars.len())` 截断。
    pub warmup_bars: usize,
    /// 运行时限额（`run_ensemble_with_quickjs` 便捷入口据此构造 QuickJsRuntime；
    /// 使用 [`run_ensemble`] 注入自定义运行时时本字段仅作文档性声明）。
    pub runtime_limits: RuntimeLimits,
}

/// 订单方向（ADR-027 P1a 裁决 2026-09-20：**唯一定义**已迁至 `backtest`（ABI 最低层），
/// 本处 `pub use` 再导出以保持 `strategy_core::{OrderSide}` / `strategy_core::engine::OrderSide`
/// 消费方路径与 serde 形状（`"Buy"/"Sell"`）零改动）。
pub use backtest::OrderSide;

/// 订单/成因缘由。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderReason {
    /// Policy 目标仓位换算产生。
    Policy,
    /// 硬止损触发（绕过评分直接平仓，ADR §13.3）。
    StopTrigger,
    /// 期末强制平仓。
    ForceClose,
}

impl OrderReason {
    /// 稳定字符串形态（**唯一映射源**：`per_bar[].orders/events` 落库、`fills` 事实源、
    /// `TradeDetail.reason` 三处共用；与 serde 外部标记形态一致，ADR-026 §2.3）。
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderReason::Policy => "Policy",
            OrderReason::StopTrigger => "StopTrigger",
            OrderReason::ForceClose => "ForceClose",
        }
    }

    /// [`OrderReason::as_str`] 的逆映射（`None` = 未知字符串，调用方自行决定语义）。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "Policy" => Some(OrderReason::Policy),
            "StopTrigger" => Some(OrderReason::StopTrigger),
            "ForceClose" => Some(OrderReason::ForceClose),
            _ => None,
        }
    }
}

/// ADR-027 P1a 裁决：`OrderReason`（三值，订单意图）→ [`FillReason`]（四值，成交事实）的
/// **唯一映射**；`Manual` 不来自策略订单（sim-live 人工/外部来源）。
impl From<OrderReason> for FillReason {
    fn from(r: OrderReason) -> Self {
        match r {
            OrderReason::Policy => FillReason::Policy,
            OrderReason::StopTrigger => FillReason::StopTrigger,
            OrderReason::ForceClose => FillReason::ForceClose,
        }
    }
}

/// 订单意图（决策 bar 记录；次 bar open 成交——Intrabar 止损除外，决策即成交）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OrderIntent {
    pub side: OrderSide,
    /// 数量（股）。Buy 为增量、Sell 为减量。
    pub qty: f64,
    pub reason: OrderReason,
}

/// 单 slot 单 bar 评分结果（per_bar 全量落库的数据源，ADR §13.4）。
#[derive(Debug, Clone, PartialEq)]
pub enum SlotScoreOutcome {
    /// 插件正常返回（host 已 clamp [0,100]，G6）。
    Ok(f64),
    /// 插件错误（G5：score 记中立 50；错误自含 sha256/bar_index——OnBar 包装）。
    Err(PluginError),
}

/// 单 slot 单 bar 评分记录。
#[derive(Debug, Clone, PartialEq)]
pub struct SlotScore {
    pub slot_idx: usize,
    /// 参与聚合的分数（错误 bar 为中立 50）。
    pub score: f64,
    pub outcome: SlotScoreOutcome,
}

/// 结构化运行事件（ADR §10：信号/订单/成交/插件异常/熔断全量入流，禁止静默吞错）。
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// 插件 on_bar 错误（G5；error 自含 sha256/bar_index）。
    PluginError {
        slot_idx: usize,
        code_hash: String,
        bar_index: usize,
        error: PluginError,
    },
    /// 熔断告警（连续错误达阈值，本运行停用该实例）。
    CircuitBreaker {
        slot_idx: usize,
        code_hash: String,
        bar_index: usize,
    },
    /// 插件 ctx.log 输出（ABI §2：log 是插件唯一副作用通道，落 run 事件流）。
    PluginLog {
        slot_idx: usize,
        bar_index: usize,
        msg: String,
    },
    /// 成交记录（逐笔携带全部金额与归属，02-spec §1.1）。
    ///
    /// 费用三件套（`trade_value`/`commission`/`stamp_duty`）为 `FeeModel::buy/sell` 的**实算结果**，
    /// 禁止下游用 `(side, qty, price)` + 费率复算（`fee.rs` 最低佣金分支先减后除不可逆，ADR-027 D4/F10）。
    Fill {
        bar_index: usize,
        side: OrderSide,
        qty: f64,
        /// 成交价（含滑点）。
        price: f64,
        /// 成交额 = `qty × price`（撮合点写入的事实值）。
        trade_value: f64,
        /// 本笔佣金（含最低佣金）。
        commission: f64,
        /// 本笔印花税（买入恒 0）。
        stamp_duty: f64,
        /// 回合序号（ADR-027 D6；经 [`backtest::RtSeqAssigner`] / [`backtest::assign_rt_seq`]
        /// 同一规则分配，禁窗口推断）。
        rt_seq: u32,
        reason: OrderReason,
    },
}

/// 每 bar 全量记录（ADR §13.4：各策略分+聚合分全量，UI 端自行抽样）。
#[derive(Debug, Clone, PartialEq)]
pub struct BarRecord {
    pub ts: i64,
    /// 是否属于前置 warmup 段（I-2/D6）：true 的 bar 仅用于预热指标/插件状态，
    /// 不计入绩效统计、不产订单/成交（响应层据此逐根标记）。
    pub warmup: bool,
    /// 各活跃 slot 评分（已熔断 slot 不出现——按「无覆盖」处理）。
    pub scores: Vec<SlotScore>,
    pub aggregate: f64,
    pub signal: TradeSignal,
    /// 本 bar 决策产生的订单意图。
    pub orders: Vec<OrderIntent>,
    /// 本 bar 发生的事件（成交/插件错误/熔断/插件日志）。
    pub events: Vec<EngineEvent>,
}

/// 持仓序列点（02-spec §4.1）：与净值**同点**产出（在既有净值压入点同步写入）。
///
/// 口径（消歧冻结，02-spec §4.2）：`position_ratio` = `position_value / nav`
/// （**时点市值 / 时点净值**；`nav <= 0` ⇒ 0）——与 ADR-026 的区间累计口径
/// `deployed_pct` / `cash_consumed_pct` **不是**同一个物。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PositionPoint {
    pub ts: i64,
    /// 该点持仓股数（期末强平后末点为 0）。
    pub qty: f64,
    /// 持仓市值 = `qty × close`（bar close 计价）。
    pub position_value: f64,
    /// 该点现金。
    pub cash: f64,
    /// 该点净值 = `cash + position_value`（与 `net_value` 同点、同值）。
    pub nav: f64,
    /// 持仓比率（分母 = 时点净值；`nav <= 0` ⇒ 0）。
    pub position_ratio: f64,
}

/// Ensemble 运行结果。
#[derive(Debug, Clone, PartialEq)]
pub struct EnsembleResult {
    pub per_bar: Vec<BarRecord>,
    pub trades: Vec<TradeDetail>,
    /// `(ts, equity)` 每 bar 收盘净值（期末强平后最后一点为已实现净值）。
    pub net_value: Vec<(i64, f64)>,
    /// 持仓序列（与 `net_value` **逐点一一对应**：同 `ts`、同 `nav`；02-spec §4.1）。
    pub positions: Vec<PositionPoint>,
    pub drawdown: Vec<(i64, f64)>,
    pub metrics: backtest::BacktestMetrics,
}

/// 实际持仓台账（引擎内部；支持 DCA 多次建仓的摊薄口径）。
#[derive(Debug, Clone, Copy)]
struct Holding {
    qty: f64,
    /// 总成本（Σ 买入 total_cost，含买入佣金；部分卖出按比例扣减）。
    cost_basis: f64,
    entry_ts: i64,
    entry_bar: usize,
}

impl Holding {
    fn avg_cost(&self) -> f64 {
        // 摊薄成本价 = 总成本（含买入佣金）/ 持仓股数。
        self.cost_basis / self.qty
    }

    fn snapshot(&self, bar_index: usize, close: f64) -> PositionSnapshot {
        PositionSnapshot {
            qty: self.qty,
            avg_cost: self.avg_cost(),
            entry_ts: self.entry_ts,
            bars_since_entry: (bar_index - self.entry_bar) as u64,
            unrealized_pnl: self.qty * close - self.cost_basis,
        }
    }
}

/// 上一 bar 决策产生的挂单（本 bar open 执行）。
#[derive(Debug, Clone, Copy)]
enum Pending {
    BuyDelta { qty: f64, reason: OrderReason },
    SellQty { qty: f64, reason: OrderReason },
}

/// 单个 slot 的运行态。
struct SlotState {
    instance: Box<dyn PluginInstance>,
    code_hash: String,
    weight: f64,
    consecutive_errors: u32,
    disabled: bool,
}

/// 运行一次 Ensemble 回测（ADR §6 管线；`rt` 为插件运行时 Port，ABI §4）。
///
/// 实例化失败（配置级错误，非 per-bar 异常）直接返回 `Err`；per-bar 插件错误
/// 按 G5 兜底为中立分 50 + 错误事件，引擎永不因插件崩溃中断。
///
/// **签名/行为零变更**（P3a 裁决契约第 3 条）：内部以 no-op observer 委托
/// [`run_ensemble_with_observer`]；`EnsembleError::Canceled` 对 no-op observer 不可达
/// （expect 不可达分支，注释备案）。
pub fn run_ensemble(
    cfg: &EnsembleConfig,
    bars: &[Bar],
    rt: &mut dyn PluginRuntime,
) -> Result<EnsembleResult, PluginError> {
    match run_ensemble_with_observer(cfg, bars, rt, &mut |_i, _total| LoopControl::Continue) {
        Ok(res) => Ok(res),
        Err(EnsembleError::Plugin(e)) => Err(e),
        // 不可达：no-op observer 恒 Continue，Break 分支不会触发。
        Err(EnsembleError::Canceled) => unreachable!("no-op observer 恒 Continue，Canceled 不可达"),
    }
}

/// 带观察者钩子的 Ensemble 运行（P3a 裁决 2026-09-09 增量加法）：
/// `observer` 在每 bar 末（步骤 8 记录后）恰调用一次，参数 `(bar_index, total)`；
/// 返回 [`LoopControl::Break`] → 引擎**立即跳出循环**（不做期末强平、不产出结果），
/// 返回 [`EnsembleError::Canceled`]（协作式取消，供 application 层进度回调点检查取消标记）。
///
/// **ADR-024 P2**：签名/行为零变更 —— 本函数现为 [`EnsembleSession`] 的薄封装
/// （构造会话 → `set_total_hint(bars.len())` → `push_batch(bars, observer)` → `finish()`）。
pub fn run_ensemble_with_observer(
    cfg: &EnsembleConfig,
    bars: &[Bar],
    rt: &mut dyn PluginRuntime,
    observer: &mut dyn FnMut(usize, usize) -> LoopControl,
) -> Result<EnsembleResult, EnsembleError> {
    let mut session = EnsembleSession::new(cfg, rt)?;
    session.set_total_hint(bars.len());
    session.push_batch(bars, observer)?;
    Ok(session.finish())
}

/// 会话式 Ensemble 运行（ADR-024 P2 / D5：批式函数 → 会话，持仓 / Policy / Trailing /
/// 插件实例常驻；`push(bar)` 逐 bar 喂入）。
///
/// 口径与批式入口**完全一致**（同一条步骤 1–8 序列；ADR D5「顺序即口径，勿调」）：
/// [`run_ensemble`] / [`run_ensemble_with_observer`] / [`run_ensemble_with_quickjs_observed`]
/// 全部是本会话的薄封装，调用方零改动。会话化**不引入新语义**，只把「入参切片」换成「喂入」：
/// - 会话不要求预先知道总 bar 数；`is_warmup = i < cfg.warmup_bars`（与批式 `min(warmup, n)` 等价）；
/// - 协作式取消仍是**每 bar** 检查（[`LoopControl::Break`] → 立即停止、不产出结果）；
/// - 期末仍在最后一个 close 强平（[`EnsembleSession::finish`]）。
///
/// 共享历史缓冲（ADR-024 D7）：会话持有**单一增长式** [`BarHistory`]，每 bar `push` 后经
/// [`BarCtx::with_history`] 注入；插件指标闭包共享同一句柄按 `index` 取值
/// （消灭改造前每 slot × 每 bar 的 `bars[..=index].to_vec()` 整段复制）。
pub struct EnsembleSession {
    cfg: EnsembleConfig,
    /// run 的标的（`FillFact.code` 取值来源，02-spec §1.1）。
    symbol: String,
    slots: Vec<SlotState>,
    /// 单一增长式共享历史缓冲（`bars[0..=i]` = 截至当前 bar 的全量历史）。
    shared: Rc<BarHistory>,
    /// 引擎自用指标状态（步骤 2/6 的 ATR(14) 止损线）：增量递推（ADR-024 D6）。
    online: OnlineIndicators,
    cash: f64,
    holding: Option<Holding>,
    pending: Option<Pending>,
    policy_state: PolicyState,
    trailing: TrailingState,
    /// 已喂入 bar 数（= 下一根 bar 的 `index`）。
    bars_seen: usize,
    /// observer 的 `total` 参数（批式入口 = `bars.len()`；流式未声明时退化为已喂入数）。
    total_hint: usize,
    per_bar: Vec<BarRecord>,
    nav: Vec<(i64, f64)>,
    /// 持仓序列（与 `nav` 同点；02-spec §4.1）。
    positions: Vec<PositionPoint>,
    /// 逐笔成交账本（**L2 唯一事实源**；L1 于期末由 [`aggregate_round_trips`] 物化，
    /// 引擎内禁止第二处聚合）。
    ledger: Vec<FillFact>,
    /// `rt_seq` 在线分配器（与 [`assign_rt_seq`] **同一规则单一体** [`RtSeqAssigner`]）。
    rt_assigner: RtSeqAssigner,
}

impl EnsembleSession {
    /// 构造会话：校验配置 + 实例化全部 slot（与批式入口同一启动口径；实例化失败直接 `Err`）。
    pub fn new(cfg: &EnsembleConfig, rt: &mut dyn PluginRuntime) -> Result<Self, EnsembleError> {
        cfg.validate()
            .map_err(|e| PluginError::SchemaError(format!("EnsembleConfig 非法: {e}")))?;

        let slots: Vec<SlotState> = cfg
            .slots
            .iter()
            .map(|s| {
                Ok(SlotState {
                    instance: rt.instantiate(s.code_hash(), s.code(), s.params())?,
                    code_hash: s.code_hash().to_string(),
                    weight: s.weight(),
                    consecutive_errors: 0,
                    disabled: false,
                })
            })
            .collect::<Result<_, EnsembleError>>()?;

        Ok(Self {
            cash: cfg.initial_capital,
            symbol: cfg.symbol.clone(),
            cfg: cfg.clone(),
            slots,
            shared: BarHistory::new(),
            online: OnlineIndicators::new(),
            holding: None,
            pending: None,
            policy_state: PolicyState::new(),
            trailing: TrailingState::new(),
            bars_seen: 0,
            total_hint: 0,
            per_bar: Vec::new(),
            nav: Vec::new(),
            positions: Vec::new(),
            ledger: Vec::new(),
            rt_assigner: RtSeqAssigner::new(),
        })
    }

    /// 声明预期总 bar 数（observer 的 `total` 参数；同时按该规模预留结果缓冲，避免增长期重分配）。
    pub fn set_total_hint(&mut self, total: usize) {
        self.total_hint = total;
        self.per_bar.reserve(total);
        self.nav.reserve(total);
        self.positions.reserve(total);
    }

    /// 已喂入 bar 数（= 下一次 [`EnsembleSession::push`] 的 `bar_index`）。
    pub fn bars_seen(&self) -> usize {
        self.bars_seen
    }

    /// 已产出但未取走的 per-bar 记录（分块落库用，ADR-024 P4）。
    pub fn records(&self) -> &[BarRecord] {
        &self.per_bar
    }

    /// 记一笔成交：写入逐笔账本（L2 唯一事实源）→ 分配 `rt_seq`（与 [`assign_rt_seq`] 同一规则）
    /// → 返回携带**实算**费用三件套的 [`EngineEvent::Fill`]。
    ///
    /// 事实与事件**同点产成**（同一次 `FeeModel` 撮合结果），调用方只需把返回的事件推入本 bar 事件流
    /// （成交→账本→回合归属在同一步完成，不存在「只摊薄、丢弃记录」的路径）。
    #[allow(clippy::too_many_arguments)]
    fn record_fill(
        &mut self,
        bar_index: usize,
        ts: i64,
        side: OrderSide,
        qty: f64,
        price: f64,
        trade_value: f64,
        commission: f64,
        stamp_duty: f64,
        reason: OrderReason,
    ) -> EngineEvent {
        let mut fact = FillFact {
            rt_seq: 0, // 占位：紧接着由 rt_assigner 就地分配（唯一规则，禁止在引擎里另写一套）
            code: self.symbol.clone(),
            bar_index,
            ts,
            side,
            qty,
            price,
            trade_value,
            commission,
            stamp_duty,
            reason: reason.into(),
        };
        self.rt_assigner.assign(&mut fact);
        let rt_seq = fact.rt_seq;
        self.ledger.push(fact);
        EngineEvent::Fill {
            bar_index,
            side,
            qty,
            price,
            trade_value,
            commission,
            stamp_duty,
            rt_seq,
            reason,
        }
    }

    /// 取走已产出的 per-bar 记录（分块落库；`finish()` 产出剩余部分）。
    pub fn drain_records(&mut self) -> Vec<BarRecord> {
        std::mem::take(&mut self.per_bar)
    }

    /// 喂入一根 bar：执行步骤 1–8（原批式循环体逐字搬运），返回本 bar 记录。
    ///
    /// 注：返回值为会话内部记录的克隆（便利 API）；高频路径请用
    /// [`EnsembleSession::push_batch`]（零复制）。
    pub fn push(&mut self, bar: &Bar) -> BarRecord {
        self.step(bar);
        self.per_bar
            .last()
            .expect("step 必产一条 per_bar 记录")
            .clone()
    }

    /// 批量喂入（chunk 粒度由调用方决定）：每 bar 末调用 `observer`（参数 `(bar_index, total)`），
    /// 返回 [`LoopControl::Break`] → **立即停止**并返回 [`EnsembleError::Canceled`]
    /// （不做期末强平、不产出结果）。
    pub fn push_batch(
        &mut self,
        bars: &[Bar],
        observer: &mut dyn FnMut(usize, usize) -> LoopControl,
    ) -> Result<(), EnsembleError> {
        for bar in bars {
            self.step(bar);
            let i = self.bars_seen - 1;
            let total = if self.total_hint > 0 {
                self.total_hint
            } else {
                self.bars_seen
            };
            if observer(i, total) == LoopControl::Break {
                return Err(EnsembleError::Canceled);
            }
        }
        Ok(())
    }

    /// 期末收尾：最后 close 强平（沿用 backtest 引擎口径，净值最后一点修正为已实现净值）
    /// + 绩效（8 项）+ 回撤，产出 [`EnsembleResult`]。
    pub fn finish(mut self) -> EnsembleResult {
        if let Some(h) = self.holding {
            let n = self.bars_seen;
            let bar = self
                .shared
                .with_slice(|s| s.last().cloned().expect("bars_seen > 0 ⇒ 共享缓冲非空"));
            let fee = self.cfg.fee;
            let exec = fee.sell(h.qty, bar.close);
            self.cash += exec.proceeds;
            // 期末强平同样进账本（D6/§3.4：ForceClose 终结最后一个回合 ⇒ 回测侧全部 rt_seq 均 Closed）。
            let ev = self.record_fill(
                n - 1,
                bar.ts,
                OrderSide::Sell,
                h.qty,
                exec.effective_price,
                exec.trade_value,
                exec.commission,
                exec.stamp_duty,
                OrderReason::ForceClose,
            );
            if let Some(last) = self.per_bar.last_mut() {
                last.events.push(ev);
            }
            apply_sell(&mut self.holding, &mut self.trailing, h.qty);
            if let Some(last) = self.nav.last_mut() {
                last.1 = self.cash;
            }
            // 同点持仓序列末点同步修正为空仓（与净值末点**同点同值**；U7 逐点恒等式不被强平破坏）。
            if let Some(last) = self.positions.last_mut() {
                let ts = last.ts;
                *last = PositionPoint {
                    ts,
                    qty: 0.0,
                    position_value: 0.0,
                    cash: self.cash,
                    nav: self.cash,
                    position_ratio: 0.0,
                };
            }
        }

        // L1 回合由逐笔账本**唯一**物化（02-spec §1.3/§2）：
        // 1) 唯一序号实现（幂等：在线分配值已由同一规则得出，此处以批式入口再钉一遍）；
        // 2) 唯一聚合实现（引擎内禁止第二处聚合；金额字段全部来自 L2 事实加总）。
        let mut ledger = std::mem::take(&mut self.ledger);
        assign_rt_seq(&mut ledger);
        let trades = aggregate_round_trips(&ledger);

        let drawdown = compute_drawdown(&self.nav);
        let metrics = compute_metrics(
            &self.nav,
            &trades,
            self.cfg.initial_capital,
            self.cfg.period,
        );

        EnsembleResult {
            per_bar: self.per_bar,
            trades,
            net_value: self.nav,
            positions: self.positions,
            drawdown,
            metrics,
        }
    }

    /// 单 bar 管线（步骤 1–8；**与原批式循环体逐字一致**，仅把「入参切片」换成「已喂入历史」）。
    fn step(&mut self, bar: &Bar) {
        let i = self.bars_seen;
        // ADR-024 P2/D7：共享历史缓冲增长（摊销 O(1)；48B/bar 一次拷贝，替代改造前每 bar O(index) 复制）。
        self.shared.push(bar.clone());
        let shared = self.shared.clone();
        shared.with_slice(|bars| {
            let bar = &bars[i];
            let is_warmup = i < self.cfg.warmup_bars;
            let mut events: Vec<EngineEvent> = Vec::new();
            let mut orders: Vec<OrderIntent> = Vec::new();

            // 1) 执行上一 bar 挂单（本 bar open 成交）。
            //    I-2/D6：warmup 段不执行任何挂单（warmup 段本身也不产挂单，此处为显式隔离）。
            if !is_warmup {
                if let Some(p) = self.pending.take() {
                    match p {
                        Pending::BuyDelta { qty, reason } => {
                            if qty > 0.0 && self.cash > 0.0 {
                                // 预算上限 = min(目标股数所需预算, 可用现金)；FeeModel.buy 将佣金折入，
                                // 保证现金不因费用透支（与 backtest 引擎口径一致）。
                                let fee = self.cfg.fee;
                                let need =
                                    qty * fee.buy_price(bar.open) * (1.0 + fee.commission_fraction());
                                let exec = fee.buy(need.min(self.cash), bar.open);
                                if exec.shares > 0.0 {
                                    self.cash -= exec.total_cost;
                                    match &mut self.holding {
                                        Some(h) => {
                                            h.qty += exec.shares;
                                            h.cost_basis += exec.total_cost;
                                        }
                                        None => {
                                            self.holding = Some(Holding {
                                                qty: exec.shares,
                                                cost_basis: exec.total_cost,
                                                entry_ts: bar.ts,
                                                entry_bar: i,
                                            });
                                            self.trailing.on_entry(bar.open);
                                        }
                                    }
                                    let ev = self.record_fill(
                                        i,
                                        bar.ts,
                                        OrderSide::Buy,
                                        exec.shares,
                                        exec.effective_price,
                                        exec.trade_value,
                                        exec.commission,
                                        0.0, // 买入无印花税（FeeModel 仅卖出收取，D4）
                                        reason,
                                    );
                                    events.push(ev);
                                    // MAJOR-1 冻结口径补全：买入被现金上限截断时（实得 < 冻结目标），
                                    // 冻结目标下调至实际持仓，避免对不可达缺口每 bar 重复挂微单。
                                    if reason == OrderReason::Policy {
                                        if let Some(h) = &self.holding {
                                            self.policy_state.clamp_lump_frozen(h.qty);
                                        }
                                    }
                                }
                            }
                        }
                        Pending::SellQty { qty, reason } => {
                            if let Some(h) = self.holding {
                                let q = qty.min(h.qty);
                                if q > 0.0 {
                                    let exec = self.cfg.fee.sell(q, bar.open);
                                    self.cash += exec.proceeds;
                                    let ev = self.record_fill(
                                        i,
                                        bar.ts,
                                        OrderSide::Sell,
                                        q,
                                        exec.effective_price,
                                        exec.trade_value,
                                        exec.commission,
                                        exec.stamp_duty,
                                        reason,
                                    );
                                    events.push(ev);
                                    apply_sell(&mut self.holding, &mut self.trailing, q);
                                }
                            }
                        }
                    }
                }
            }

            // 2) Intrabar 硬止损（当 bar 成交，口径唯一例外，ADR §13.3）。
            if let Some(stop) = &self.cfg.stop {
                if stop.trigger == StopTrigger::Intrabar {
                    if let Some(h) = self.holding {
                        // MINOR-1 裁决：ATR 线用截至上一 bar 数据（当 bar close 在 bar 内
                        // 尚不可知，避免前视）；i=0 → 数据不足 → 不触发。
                        // ADR-024 P2/D6：增量 ATR 状态（与原 `Indicators::atr` 位级一致）。
                        let atr14 = self
                            .online
                            .atr(bars, i.saturating_sub(1), 14);
                        if let Some(line) = stop.stop_line(h.avg_cost(), self.trailing.peak(), atr14)
                        {
                            if stop.intrabar_triggered(line, bar) {
                                // 按止损价 ×(1−slippage) 当 bar 成交（fee.sell 内含滑点）。
                                let exec = self.cfg.fee.sell(h.qty, line);
                                self.cash += exec.proceeds;
                                let ev = self.record_fill(
                                    i,
                                    bar.ts,
                                    OrderSide::Sell,
                                    h.qty,
                                    exec.effective_price,
                                    exec.trade_value,
                                    exec.commission,
                                    exec.stamp_duty,
                                    OrderReason::StopTrigger,
                                );
                                events.push(ev);
                                apply_sell(&mut self.holding, &mut self.trailing, h.qty);
                                // MAJOR-2 裁决：强平 = 外部中断 → 重置 PolicyState
                                //（与 trailing.reset() 并列）；次个 Buy 重新计数批次/重新快照。
                                self.policy_state.reset();
                            }
                        }
                    }
                }
            }

            // 3) 构建 BarCtx（含只读持仓全景；空仓 → None，ABI §2.5）。
            //    ADR-024 P2/D7：注入共享历史缓冲句柄（插件指标闭包共享同一缓冲，零复制）。
            //    ADR-024 P2c：宿主侧**无前视自检** —— 送入 `BarCtx` 的切片必须恰为共享缓冲前缀
            //    `bars[0..=i]`（仅 debug 生效，release 零成本；退化 ⇒ 构造点立即 panic）。
            let ctx_bars: &[Bar] = bars;
            debug_assert_eq!(
                ctx_bars.len(),
                i + 1,
                "P2c 前视自检（引擎会话）：ctx.bars 必须恰为 bars[0..=index]（len == index+1）"
            );
            let position = self.holding.map(|h| h.snapshot(i, bar.close));
            let ctx = BarCtx::new(i, bar.clone(), ctx_bars, position).with_history(shared.clone());

            // 4) 各活跃 slot 评分（错误走 G5）。
            let mut scores: Vec<SlotScore> = Vec::with_capacity(self.slots.len());
            for (idx, s) in self.slots.iter_mut().enumerate() {
                if s.disabled {
                    continue; // 已熔断 → 按「无覆盖」处理
                }
                match s.instance.on_bar(&ctx) {
                    Ok(score) => {
                        s.consecutive_errors = 0;
                        scores.push(SlotScore {
                            slot_idx: idx,
                            score,
                            outcome: SlotScoreOutcome::Ok(score),
                        });
                    }
                    Err(e) => {
                        s.consecutive_errors += 1;
                        events.push(EngineEvent::PluginError {
                            slot_idx: idx,
                            code_hash: s.code_hash.clone(),
                            bar_index: i,
                            error: e.clone(),
                        });
                        if s.consecutive_errors >= CIRCUIT_BREAKER_THRESHOLD {
                            s.disabled = true;
                            events.push(EngineEvent::CircuitBreaker {
                                slot_idx: idx,
                                code_hash: s.code_hash.clone(),
                                bar_index: i,
                            });
                        }
                        scores.push(SlotScore {
                            slot_idx: idx,
                            score: NEUTRAL_SCORE,
                            outcome: SlotScoreOutcome::Err(e),
                        });
                    }
                }
                // 插件日志落 run 事件流（ABI §2 log 通道，ADR §10）。
                for msg in ctx.take_logs() {
                    events.push(EngineEvent::PluginLog {
                        slot_idx: idx,
                        bar_index: i,
                        msg,
                    });
                }
            }

            // 5) 聚合（仅活跃 slot；无覆盖 → 中立 50）→ 信号。
            let agg = aggregate(
                &scores
                    .iter()
                    .map(|s| (self.slots[s.slot_idx].weight, s.score))
                    .collect::<Vec<_>>(),
            );
            let signal = classify(agg, self.cfg.buy_threshold, self.cfg.sell_threshold);

            // 6) CloseBasis 硬止损（收盘判定 → 次 bar open 成交；绕过 Policy）。
            //    ATR 线含当前 bar（收盘后判定，无前视，MINOR-1 裁决口径）。
            let mut stop_order = false;
            if let Some(stop) = &self.cfg.stop {
                if stop.trigger == StopTrigger::CloseBasis {
                    if let Some(h) = self.holding {
                        let atr14 = self.online.atr(bars, i, 14);
                        if let Some(line) = stop.stop_line(h.avg_cost(), self.trailing.peak(), atr14)
                        {
                            if stop.close_triggered(line, bar) {
                                orders.push(OrderIntent {
                                    side: OrderSide::Sell,
                                    qty: h.qty,
                                    reason: OrderReason::StopTrigger,
                                });
                                self.pending = Some(Pending::SellQty {
                                    qty: h.qty,
                                    reason: OrderReason::StopTrigger,
                                });
                                stop_order = true;
                                // MAJOR-2 裁决：触发即重置 PolicyState（强平挂单已排定，
                                // 次 bar open 成交）；强平后首个 Buy 重新计数批次/重新快照。
                                self.policy_state.reset();
                            }
                        }
                    }
                }
            }

            // 7) Policy：信号 → 目标仓位（幂等）→ 订单 = 目标 − 当前。
            //    I-2/D6：warmup 段不执行 Policy（不产订单），from 起从空仓开始。
            if !stop_order && !is_warmup {
                let current_qty = self.holding.map(|h| h.qty).unwrap_or(0.0);
                let equity = self.cash + current_qty * bar.close;
                let target = self.policy_state.target_qty(
                    &self.cfg.policy,
                    signal,
                    equity,
                    bar.close,
                    current_qty,
                );
                let delta = target - current_qty;
                const EPS: f64 = 1e-9;
                if delta > EPS {
                    orders.push(OrderIntent {
                        side: OrderSide::Buy,
                        qty: delta,
                        reason: OrderReason::Policy,
                    });
                    self.pending = Some(Pending::BuyDelta {
                        qty: delta,
                        reason: OrderReason::Policy,
                    });
                } else if delta < -EPS {
                    orders.push(OrderIntent {
                        side: OrderSide::Sell,
                        qty: -delta,
                        reason: OrderReason::Policy,
                    });
                    self.pending = Some(Pending::SellQty {
                        qty: -delta,
                        reason: OrderReason::Policy,
                    });
                }
            }

            // 8) Trailing 峰值更新（持仓中每 bar 末并入当前 close；清仓已重置）+ 净值/记录。
            //    I-2/D6：warmup 段不计净值（绩效序列仅含 in-range）；per_bar 仍全量记录并标记 warmup。
            if self.holding.is_some() {
                self.trailing.on_bar_close(bar.close);
            }
            if !is_warmup {
                let qty = self.holding.map(|h| h.qty).unwrap_or(0.0);
                let position_value = qty * bar.close;
                let nav = self.cash + position_value;
                self.nav.push((bar.ts, nav));
                // 02-spec §4.1：持仓序列与净值**同点**产出（同一压入点，已同时持有 cash 与 qty×close）。
                self.positions.push(PositionPoint {
                    ts: bar.ts,
                    qty,
                    position_value,
                    cash: self.cash,
                    nav,
                    position_ratio: if nav <= 0.0 { 0.0 } else { position_value / nav },
                });
            }
            self.per_bar.push(BarRecord {
                ts: bar.ts,
                warmup: is_warmup,
                scores,
                aggregate: agg,
                signal,
                orders,
                events,
            });
        });
        self.bars_seen += 1;
    }
}

/// 便捷入口：按 `cfg.runtime_limits` 构造 `QuickJsRuntime` 并运行。
/// 需要自定义运行时（WASM 未来实现 / 测试注入 mock）时用 [`run_ensemble`]。
pub fn run_ensemble_with_quickjs(
    cfg: &EnsembleConfig,
    bars: &[Bar],
) -> Result<EnsembleResult, PluginError> {
    let mut rt = strategy_runtime::QuickJsRuntime::new(cfg.runtime_limits);
    run_ensemble(cfg, bars, &mut rt)
}

/// 便捷入口（带观察者钩子）：按 `cfg.runtime_limits` 构造 `QuickJsRuntime` 并运行。
/// application 层据此实现进度上报 + 协作式取消（P3a）。
pub fn run_ensemble_with_quickjs_observed(
    cfg: &EnsembleConfig,
    bars: &[Bar],
    observer: &mut dyn FnMut(usize, usize) -> LoopControl,
) -> Result<EnsembleResult, EnsembleError> {
    let mut rt = strategy_runtime::QuickJsRuntime::new(cfg.runtime_limits);
    run_ensemble_with_observer(cfg, bars, &mut rt, observer)
}

/// 卖出台账处理（**只做持仓簿记**）：部分卖出按比例摊薄成本；清仓结束持仓并重置 Trailing。
///
/// P1b（ADR-027 D1/D7）：本函数**不再**合成 L1 `TradeDetail` —— 旧口径「部分卖出只摊薄、已实现
/// 部分不进账本」的缺陷由「逐笔账本 + 全回合口径」消除：每笔成交（含部分卖出）在**调用点**经
/// [`EnsembleSession::record_fill`] 写入 L2 账本（与事件同点产成），L1 由
/// [`aggregate_round_trips`] 在期末**唯一**物化（引擎内无第二处聚合、无占位值）。
fn apply_sell(holding: &mut Option<Holding>, trailing: &mut TrailingState, qty: f64) {
    let Some(h) = holding.as_mut() else { return };
    if qty >= h.qty {
        // 清仓：持仓归零 + Trailing 重置（成交已由调用点记入账本）。
        *holding = None;
        trailing.reset();
    } else {
        // 部分卖出（LumpSum 目标下调）：成本按比例摊薄（成交已由调用点记入账本）。
        let ratio = qty / h.qty;
        h.cost_basis *= 1.0 - ratio;
        h.qty -= qty;
    }
}
