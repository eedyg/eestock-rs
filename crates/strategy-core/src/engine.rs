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

use backtest::{compute_drawdown, compute_metrics, Bar, FeeModel, Indicators, Period, TradeDetail};
use serde::{Deserialize, Serialize};
use strategy_runtime::{
    BarCtx, PluginError, PluginInstance, PluginRuntime, PositionSnapshot, RuntimeLimits,
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
        if !self.initial_capital.is_finite() || self.initial_capital <= 0.0 {
            return Err(format!(
                "initial_capital 必须为正有限值，got {}",
                self.initial_capital
            ));
        }
        self.policy.validate()?;
        Ok(())
    }
}

/// Ensemble 运行配置。
#[derive(Debug, Clone, PartialEq)]
pub struct EnsembleConfig {
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
    /// 运行时限额（`run_ensemble_with_quickjs` 便捷入口据此构造 QuickJsRuntime；
    /// 使用 [`run_ensemble`] 注入自定义运行时时本字段仅作文档性声明）。
    pub runtime_limits: RuntimeLimits,
}

/// 订单方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    Buy,
    Sell,
}

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
    /// 成交记录。
    Fill {
        bar_index: usize,
        side: OrderSide,
        qty: f64,
        /// 成交价（含滑点）。
        price: f64,
        reason: OrderReason,
    },
}

/// 每 bar 全量记录（ADR §13.4：各策略分+聚合分全量，UI 端自行抽样）。
#[derive(Debug, Clone, PartialEq)]
pub struct BarRecord {
    pub ts: i64,
    /// 各活跃 slot 评分（已熔断 slot 不出现——按「无覆盖」处理）。
    pub scores: Vec<SlotScore>,
    pub aggregate: f64,
    pub signal: TradeSignal,
    /// 本 bar 决策产生的订单意图。
    pub orders: Vec<OrderIntent>,
    /// 本 bar 发生的事件（成交/插件错误/熔断/插件日志）。
    pub events: Vec<EngineEvent>,
}

/// Ensemble 运行结果。
#[derive(Debug, Clone, PartialEq)]
pub struct EnsembleResult {
    pub per_bar: Vec<BarRecord>,
    pub trades: Vec<TradeDetail>,
    /// `(ts, equity)` 每 bar 收盘净值（期末强平后最后一点为已实现净值）。
    pub net_value: Vec<(i64, f64)>,
    pub drawdown: Vec<(i64, f64)>,
    pub metrics: backtest::BacktestMetrics,
}

/// 实际持仓台账（引擎内部；支持 DCA 多次建仓的摊薄口径）。
#[derive(Debug, Clone, Copy)]
struct Holding {
    qty: f64,
    /// 总成本（Σ 买入 total_cost，含买入佣金；部分卖出按比例扣减）。
    cost_basis: f64,
    /// Σ 买入成交额（不含费用），用于 open_price = value_basis/qty（加权有效买价）。
    value_basis: f64,
    /// Σ 买入佣金。
    buy_commission: f64,
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
pub fn run_ensemble_with_observer(
    cfg: &EnsembleConfig,
    bars: &[Bar],
    rt: &mut dyn PluginRuntime,
    observer: &mut dyn FnMut(usize, usize) -> LoopControl,
) -> Result<EnsembleResult, EnsembleError> {
    cfg.validate()
        .map_err(|e| PluginError::SchemaError(format!("EnsembleConfig 非法: {e}")))?;

    let mut slots: Vec<SlotState> = cfg
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

    let fee = &cfg.fee;
    let n = bars.len();
    let mut cash = cfg.initial_capital;
    let mut holding: Option<Holding> = None;
    let mut pending: Option<Pending> = None;
    let mut policy_state = PolicyState::new();
    let mut trailing = TrailingState::new();

    let mut per_bar: Vec<BarRecord> = Vec::with_capacity(n);
    let mut nav: Vec<(i64, f64)> = Vec::with_capacity(n);
    let mut trades: Vec<TradeDetail> = Vec::new();

    for i in 0..n {
        let bar = &bars[i];
        let mut events: Vec<EngineEvent> = Vec::new();
        let mut orders: Vec<OrderIntent> = Vec::new();

        // 1) 执行上一 bar 挂单（本 bar open 成交）。
        if let Some(p) = pending.take() {
            match p {
                Pending::BuyDelta { qty, reason } => {
                    if qty > 0.0 && cash > 0.0 {
                        // 预算上限 = min(目标股数所需预算, 可用现金)；FeeModel.buy 将佣金折入，
                        // 保证现金不因费用透支（与 backtest 引擎口径一致）。
                        let need =
                            qty * fee.buy_price(bar.open) * (1.0 + fee.commission_fraction());
                        let exec = fee.buy(need.min(cash), bar.open);
                        if exec.shares > 0.0 {
                            cash -= exec.total_cost;
                            match &mut holding {
                                Some(h) => {
                                    h.qty += exec.shares;
                                    h.cost_basis += exec.total_cost;
                                    h.value_basis += exec.trade_value;
                                    h.buy_commission += exec.commission;
                                }
                                None => {
                                    holding = Some(Holding {
                                        qty: exec.shares,
                                        cost_basis: exec.total_cost,
                                        value_basis: exec.trade_value,
                                        buy_commission: exec.commission,
                                        entry_ts: bar.ts,
                                        entry_bar: i,
                                    });
                                    trailing.on_entry(bar.open);
                                }
                            }
                            events.push(EngineEvent::Fill {
                                bar_index: i,
                                side: OrderSide::Buy,
                                qty: exec.shares,
                                price: exec.effective_price,
                                reason,
                            });
                            // MAJOR-1 冻结口径补全：买入被现金上限截断时（实得 < 冻结目标），
                            // 冻结目标下调至实际持仓，避免对不可达缺口每 bar 重复挂微单。
                            if reason == OrderReason::Policy {
                                if let Some(h) = &holding {
                                    policy_state.clamp_lump_frozen(h.qty);
                                }
                            }
                        }
                    }
                }
                Pending::SellQty { qty, reason } => {
                    if let Some(h) = holding {
                        let q = qty.min(h.qty);
                        if q > 0.0 {
                            let exec = fee.sell(q, bar.open);
                            cash += exec.proceeds;
                            events.push(EngineEvent::Fill {
                                bar_index: i,
                                side: OrderSide::Sell,
                                qty: q,
                                price: exec.effective_price,
                                reason,
                            });
                            apply_sell(
                                &mut holding,
                                &mut trades,
                                &mut trailing,
                                q,
                                bar.ts,
                                i,
                                &exec,
                            );
                        }
                    }
                }
            }
        }

        // 2) Intrabar 硬止损（当 bar 成交，口径唯一例外，ADR §13.3）。
        if let Some(stop) = &cfg.stop {
            if stop.trigger == StopTrigger::Intrabar {
                if let Some(h) = holding {
                    // MINOR-1 裁决：ATR 线用截至上一 bar 数据（当 bar close 在 bar 内
                    // 尚不可知，避免前视）；i=0 → 数据不足 → 不触发。
                    let atr14 = Indicators::new(bars, i.saturating_sub(1)).atr(14);
                    if let Some(line) = stop.stop_line(h.avg_cost(), trailing.peak(), atr14) {
                        if stop.intrabar_triggered(line, bar) {
                            // 按止损价 ×(1−slippage) 当 bar 成交（fee.sell 内含滑点）。
                            let exec = fee.sell(h.qty, line);
                            cash += exec.proceeds;
                            events.push(EngineEvent::Fill {
                                bar_index: i,
                                side: OrderSide::Sell,
                                qty: h.qty,
                                price: exec.effective_price,
                                reason: OrderReason::StopTrigger,
                            });
                            apply_sell(
                                &mut holding,
                                &mut trades,
                                &mut trailing,
                                h.qty,
                                bar.ts,
                                i,
                                &exec,
                            );
                            // MAJOR-2 裁决：强平 = 外部中断 → 重置 PolicyState
                            //（与 trailing.reset() 并列）；次个 Buy 重新计数批次/重新快照。
                            policy_state.reset();
                        }
                    }
                }
            }
        }

        // 3) 构建 BarCtx（含只读持仓全景；空仓 → None，ABI §2.5）。
        let position = holding.map(|h| h.snapshot(i, bar.close));
        let ctx = BarCtx::new(i, bar.clone(), bars, position);

        // 4) 各活跃 slot 评分（错误走 G5）。
        let mut scores: Vec<SlotScore> = Vec::with_capacity(slots.len());
        for (idx, s) in slots.iter_mut().enumerate() {
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
                .map(|s| (slots[s.slot_idx].weight, s.score))
                .collect::<Vec<_>>(),
        );
        let signal = classify(agg, cfg.buy_threshold, cfg.sell_threshold);

        // 6) CloseBasis 硬止损（收盘判定 → 次 bar open 成交；绕过 Policy）。
        //    ATR 线含当前 bar（收盘后判定，无前视，MINOR-1 裁决口径）。
        let mut stop_order = false;
        if let Some(stop) = &cfg.stop {
            if stop.trigger == StopTrigger::CloseBasis {
                if let Some(h) = holding {
                    let atr14 = Indicators::new(bars, i).atr(14);
                    if let Some(line) = stop.stop_line(h.avg_cost(), trailing.peak(), atr14) {
                        if stop.close_triggered(line, bar) {
                            orders.push(OrderIntent {
                                side: OrderSide::Sell,
                                qty: h.qty,
                                reason: OrderReason::StopTrigger,
                            });
                            pending = Some(Pending::SellQty {
                                qty: h.qty,
                                reason: OrderReason::StopTrigger,
                            });
                            stop_order = true;
                            // MAJOR-2 裁决：触发即重置 PolicyState（强平挂单已排定，
                            // 次 bar open 成交）；强平后首个 Buy 重新计数批次/重新快照。
                            policy_state.reset();
                        }
                    }
                }
            }
        }

        // 7) Policy：信号 → 目标仓位（幂等）→ 订单 = 目标 − 当前。
        if !stop_order {
            let current_qty = holding.map(|h| h.qty).unwrap_or(0.0);
            let equity = cash + current_qty * bar.close;
            let target =
                policy_state.target_qty(&cfg.policy, signal, equity, bar.close, current_qty);
            let delta = target - current_qty;
            const EPS: f64 = 1e-9;
            if delta > EPS {
                orders.push(OrderIntent {
                    side: OrderSide::Buy,
                    qty: delta,
                    reason: OrderReason::Policy,
                });
                pending = Some(Pending::BuyDelta {
                    qty: delta,
                    reason: OrderReason::Policy,
                });
            } else if delta < -EPS {
                orders.push(OrderIntent {
                    side: OrderSide::Sell,
                    qty: -delta,
                    reason: OrderReason::Policy,
                });
                pending = Some(Pending::SellQty {
                    qty: -delta,
                    reason: OrderReason::Policy,
                });
            }
        }

        // 8) Trailing 峰值更新（持仓中每 bar 末并入当前 close；清仓已重置）+ 净值/记录。
        if holding.is_some() {
            trailing.on_bar_close(bar.close);
        }
        nav.push((
            bar.ts,
            cash + holding.map(|h| h.qty).unwrap_or(0.0) * bar.close,
        ));
        per_bar.push(BarRecord {
            ts: bar.ts,
            scores,
            aggregate: agg,
            signal,
            orders,
            events,
        });

        // 9) 观察者钩子（每 bar 末恰一次；P3a 裁决）：Break → 协作式取消，
        //    立即跳出（不做期末强平、不产出结果）。
        if observer(i, n) == LoopControl::Break {
            return Err(EnsembleError::Canceled);
        }
    }

    // 期末强制平仓（沿用 backtest 引擎口径：最后 close 成交，净值最后一点修正为已实现净值）。
    if let Some(h) = holding {
        let bar = &bars[n - 1];
        let exec = fee.sell(h.qty, bar.close);
        cash += exec.proceeds;
        if let Some(last) = per_bar.last_mut() {
            last.events.push(EngineEvent::Fill {
                bar_index: n - 1,
                side: OrderSide::Sell,
                qty: h.qty,
                price: exec.effective_price,
                reason: OrderReason::ForceClose,
            });
        }
        apply_sell(
            &mut holding,
            &mut trades,
            &mut trailing,
            h.qty,
            bar.ts,
            n - 1,
            &exec,
        );
        if let Some(last) = nav.last_mut() {
            last.1 = cash;
        }
    }

    let drawdown = compute_drawdown(&nav);
    let metrics = compute_metrics(&nav, &trades, cfg.initial_capital, cfg.period);

    Ok(EnsembleResult {
        per_bar,
        trades,
        net_value: nav,
        drawdown,
        metrics,
    })
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

/// 卖出台账处理：部分卖出按比例摊薄成本；清仓合成完整 [`TradeDetail`] 并重置 Trailing。
fn apply_sell(
    holding: &mut Option<Holding>,
    trades: &mut Vec<TradeDetail>,
    trailing: &mut TrailingState,
    qty: f64,
    ts: i64,
    bar_index: usize,
    exec: &backtest::SellExecution,
) {
    let Some(h) = holding.as_mut() else { return };
    if qty >= h.qty {
        // 清仓 → 合成一笔完整交易（open_price = 加权有效买价，成本含买入佣金）。
        trades.push(TradeDetail {
            open_ts: h.entry_ts,
            close_ts: ts,
            open_bar: h.entry_bar,
            close_bar: bar_index,
            open_price: h.value_basis / h.qty,
            close_price: exec.effective_price,
            shares: h.qty,
            gross_value: exec.trade_value,
            commission: h.buy_commission + exec.commission,
            stamp_duty: exec.stamp_duty,
            pnl: exec.proceeds - h.cost_basis,
            hold_bars: bar_index - h.entry_bar,
        });
        *holding = None;
        trailing.reset();
    } else {
        // 部分卖出（LumpSum 目标下调）：成本/佣金按比例摊薄。
        let ratio = qty / h.qty;
        h.cost_basis *= 1.0 - ratio;
        h.value_basis *= 1.0 - ratio;
        h.buy_commission *= 1.0 - ratio;
        h.qty -= qty;
    }
}
