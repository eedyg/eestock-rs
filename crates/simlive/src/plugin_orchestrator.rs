//! 插件策略编排器（P4a 切源：Registry published 策略 + QuickJS 实例内核；ADR 12-strategy-system §13.6）。
//!
//! 纯逻辑、同步、无 IO/无随机（与旧编排器同纪律）：**!Send**（QuickJS 实例内含 Rc），
//! 单测直调；应用层（SimLiveService）以每会话专用 worker 线程承载（actor 模式，父级裁决）。
//!
//! 与旧 `RealtimeStrategyOrchestrator` 的口径差（切源定稿，报告注明）：
//! - **策略来源**：Registry **published 版本钉住**（strategy_id+version_id+version+sha256+code
//!   启动时定格，与 workbench 同口径）；实例化失败 → 显式 `Err`（会话启动失败）——
//!   旧编排器「未知策略静默跳过」语义**废止**。
//! - **评分**：插件连续分 0-100 直通（host 侧已 clamp，ABI G6），取代
//!   `Buy=100/Hold=50/Sell=0` 三档映射；**聚合/阈值/信号判定语义不变**
//!   （加权平均、60/40 可配、buy/sell/hold——复用本 crate `weighted_aggregate`/`aggregate_to_signal`）。
//! - **position 注入**（ABI §2.5）：每 bar 构建 `BarCtx` 时携带该标的实际持仓快照
//!   （[`PositionInput`] 由应用层从 SimAccount + 成交台账推导）；空仓 → `None`（插件见 null）。
//! - **G5 熔断语义对齐引擎**：插件错误 → 该 bar 该策略记中立分 50 + [`SessionEvent::PluginError`]
//!   （自含 sha256/bar_index）；**连续** [`strategy_core::CIRCUIT_BREAKER_THRESHOLD`] 次 →
//!   本实例熔断停用 + [`SessionEvent::CircuitBreaker`] 告警；停用后按「无覆盖」处理
//!   （全部熔断 → 聚合中立 50 → 不产交易信号）。成功即清零连续计数。
//! - 沿用 3 策略 × 30 股上限校验（构造时显式拒绝）。
//!
//! 持仓快照口径：`avg_cost` = SimAccount 加权成本（**未摊费用**，与 PositionView 一致；
//! 引擎 `Holding` 的 avg_cost 含买入佣金——两口径差异有意保留，勿对齐数值）；
//! `entry_ts` = **sticky-first-entry**（自空仓以来首笔建仓 ts 钉死，部分卖出不前进、清仓重钉，
//! 与引擎 `Holding.entry_ts` 一致，MINOR-2）；`unrealized_pnl = qty × (当前 bar close − avg_cost)`；
//! `bars_since_entry` 以本会话已见 bar 序列计数（entry_ts 早于首根已知 bar 时按已知序列计数，
//! 恢复场景残差注明）。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use backtest::{Bar, StrategyParams};
use strategy_runtime::{
    BarCtx, PluginInstance, PluginRuntime, PositionSnapshot, QuickJsRuntime, RuntimeLimits,
};

use crate::fill::{Side, SimTrade};
use crate::session::SessionEvent;
use crate::strategy_orchestrator::{
    aggregate_to_signal, weighted_aggregate, StockEvaluation, StrategyScore, NEUTRAL_SCORE,
};

/// 单会话策略数上限（ADR 11-sim-live §4：3 策略）。
pub const MAX_STRATEGIES: usize = 3;
/// 单策略标的集上限（ADR 11-sim-live §4：≤30 股）。
pub const MAX_STOCKS_PER_STRATEGY: usize = 30;

/// 钉住的插件策略配置（会话启动时定格；published 不可变保证 code 与 sha256 一致，恢复同源）。
///
/// 对应 wire 元素 `{strategy_id, version_id?, params, stocks, weight, stock_weights?}` 的
/// 应用层解析产物：version_id 缺省 = 最新 published（由应用层解析后填入）。
#[derive(Debug, Clone, PartialEq)]
pub struct PluginStrategyConfig {
    /// Registry 策略 id（st_ 前缀）。
    pub strategy_id: String,
    /// 钉住版本 id（sv_ 前缀）。
    pub version_id: String,
    /// 钉住版本号。
    pub version: i32,
    /// 发布版本 sha256（ABI G4 寻址/留痕；错误事件自含）。
    pub sha256: String,
    /// 策略显示名（web/MCP 面板展示用，钉住时取自 Registry）。
    pub name: String,
    /// 发布版本 JS 源码（published 不可变；实例化素材）。
    pub code: String,
    /// 运行参数（已按版本 schema 校验/缺省填充）。
    pub params: StrategyParams,
    /// 该策略实时评估的标的集（≤ [`MAX_STOCKS_PER_STRATEGY`]）。
    pub stocks: Vec<String>,
    /// 聚合权重（>0）。
    pub weight: f64,
    /// 按标的覆盖权重（策略×股票级）；未指定某股 → 用 `weight`。
    pub stock_weights: HashMap<String, f64>,
}

/// 持仓输入（应用层从 SimAccount + 成交台账推导；空仓 → feed_bar 传 `None`）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PositionInput {
    /// 当前持仓股数。
    pub qty: f64,
    /// 加权平均成本（SimAccount 口径，未摊费用）。
    pub avg_cost: f64,
    /// 当前持仓建仓时间（Unix 秒；**sticky-first-entry**，部分卖出不前进、清仓重钉——
    /// 与 strategy-core `Holding.entry_ts` 口径一致，推导见 [`current_entry_ts`]）。
    pub entry_ts: i64,
}

/// 编排器错误（实例化失败 / 配置非法）。含 strategy_id + version_id 上下文，显式上报。
#[derive(Debug, Clone, PartialEq)]
pub struct OrchestratorError(pub String);

impl std::fmt::Display for OrchestratorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for OrchestratorError {}

/// 单策略×单标的的插件实例运行态。
struct PluginSlot {
    instance: Box<dyn PluginInstance>,
    /// G5 连续错误计数（成功即清零）。
    consecutive_errors: u32,
    /// 熔断停用标记（停用后按「无覆盖」处理）。
    disabled: bool,
}

/// 单策略运行态（钉住配置 + 各标的实例）。
struct PluginStrategyRuntime {
    config: PluginStrategyConfig,
    /// code → 该策略在该标的上的实例（每「策略×标的」一实例）。
    slots: BTreeMap<String, PluginSlot>,
}

/// 插件策略编排器（**!Send**：QuickJS 实例内含 Rc；应用层以专用 worker 线程承载）。
pub struct PluginStrategyOrchestrator {
    strategies: Vec<PluginStrategyRuntime>,
    /// code → 累计 bar 序列（BarCtx 全量历史，指标口径与 backtest::Indicators 一致）。
    bars: BTreeMap<String, Vec<Bar>>,
    /// code → 最近一次评估（查询用）。
    latest: BTreeMap<String, StockEvaluation>,
    buy_long_threshold: f64,
    sell_threshold: f64,
    /// 待取走的会话事件（应用层 feed 后 `take_events` 归集进会话事件流）。
    events: Vec<SessionEvent>,
}

impl PluginStrategyOrchestrator {
    /// 构建编排器：校验上限/阈值 → 每「策略×标的」实例化插件。
    /// **实例化失败 → 显式 `Err`**（会话启动失败；旧「未知策略静默跳过」语义废止）。
    pub fn new(
        configs: Vec<PluginStrategyConfig>,
        buy_long_threshold: f64,
        sell_threshold: f64,
        rt: &mut dyn PluginRuntime,
    ) -> Result<Self, OrchestratorError> {
        if configs.len() > MAX_STRATEGIES {
            return Err(OrchestratorError(format!(
                "策略数 {} 超上限 {MAX_STRATEGIES}（ADR §4：3 策略）",
                configs.len()
            )));
        }
        if !buy_long_threshold.is_finite()
            || !sell_threshold.is_finite()
            || buy_long_threshold <= sell_threshold
        {
            return Err(OrchestratorError(format!(
                "buy_long_threshold 须严格大于 sell_threshold 且均有限，got {buy_long_threshold} <= {sell_threshold}"
            )));
        }
        // MINOR-4（红线豁免，与 strategy-core EnsembleConfig::validate 同规）：阈值须夹中立 50
        //（buy > 50 且 sell < 50），保证「全熔断→聚合中立 50→Hold」契约不被阈值配置破坏。
        if buy_long_threshold <= crate::strategy_orchestrator::NEUTRAL_SCORE
            || sell_threshold >= crate::strategy_orchestrator::NEUTRAL_SCORE
        {
            return Err(OrchestratorError(format!(
                "buy_long_threshold 须 > 50 且 sell_threshold 须 < 50（夹中立 50，全熔断→Hold 契约），\
                 got {buy_long_threshold} / {sell_threshold}"
            )));
        }
        let mut strategies = Vec::with_capacity(configs.len());
        for config in configs {
            if config.stocks.len() > MAX_STOCKS_PER_STRATEGY {
                return Err(OrchestratorError(format!(
                    "策略 {} 标的数 {} 超上限 {MAX_STOCKS_PER_STRATEGY}（ADR §4：≤30 股）",
                    config.strategy_id,
                    config.stocks.len()
                )));
            }
            let mut slots = BTreeMap::new();
            for code in &config.stocks {
                let instance = rt
                    .instantiate(&config.sha256, &config.code, &config.params)
                    .map_err(|e| {
                        OrchestratorError(format!(
                            "插件实例化失败（策略 {} 版本 {} sha256 {} 标的 {code}）: {e}",
                            config.strategy_id, config.version_id, config.sha256
                        ))
                    })?;
                slots.insert(
                    code.clone(),
                    PluginSlot { instance, consecutive_errors: 0, disabled: false },
                );
            }
            strategies.push(PluginStrategyRuntime { config, slots });
        }
        Ok(Self {
            strategies,
            bars: BTreeMap::new(),
            latest: BTreeMap::new(),
            buy_long_threshold,
            sell_threshold,
            events: Vec::new(),
        })
    }

    /// 便捷构造：默认 QuickJS 运行时（`limits` 可调；sim-live 用默认限额，ABI G2）。
    pub fn with_quickjs(
        configs: Vec<PluginStrategyConfig>,
        buy_long_threshold: f64,
        sell_threshold: f64,
        limits: RuntimeLimits,
    ) -> Result<Self, OrchestratorError> {
        let mut rt = QuickJsRuntime::new(limits);
        Self::new(configs, buy_long_threshold, sell_threshold, &mut rt)
    }

    /// 所有策略覆盖的标的全集（去重、升序）。
    pub fn stocks(&self) -> Vec<String> {
        let set: BTreeSet<String> = self
            .strategies
            .iter()
            .flat_map(|s| s.config.stocks.iter().cloned())
            .collect();
        set.into_iter().collect()
    }

    /// 该标的是否为某策略覆盖（供应用层判定是否属于策略域）。
    pub fn covers(&self, code: &str) -> bool {
        self.strategies
            .iter()
            .any(|s| s.config.stocks.iter().any(|c| c == code))
    }

    /// 喂入某标的一根新 bar 并评估；`position` 为该标的当前持仓输入（空仓 → `None`）。
    /// 标的不在任何策略标的集内 → 仍记录行情但不评估，返回 `None`。
    pub fn feed_bar(
        &mut self,
        code: &str,
        bar: Bar,
        position: Option<PositionInput>,
    ) -> Option<StockEvaluation> {
        self.bars.entry(code.to_string()).or_default().push(bar);
        self.evaluate(code, position)
    }

    /// 对某标的按最新 bar 重新评估（feed 后内部调用）。
    fn evaluate(&mut self, code: &str, position: Option<PositionInput>) -> Option<StockEvaluation> {
        let bars = self.bars.get(code)?;
        if bars.is_empty() || !self.covers(code) {
            return None;
        }
        let idx = bars.len() - 1;
        let latest_bar = bars[idx].clone();
        // ABI §2.5 持仓快照：空仓 → None（插件见 null）。
        let snapshot = position.map(|p| PositionSnapshot {
            qty: p.qty,
            avg_cost: p.avg_cost,
            entry_ts: p.entry_ts,
            bars_since_entry: bars_since_entry(bars, idx, p.entry_ts),
            unrealized_pnl: p.qty * (latest_bar.close - p.avg_cost),
        });

        let mut scores: Vec<StrategyScore> = Vec::new();
        let mut weighted: Vec<(f64, f64)> = Vec::new();

        for rt in &mut self.strategies {
            if !rt.config.stocks.iter().any(|c| c == code) {
                continue;
            }
            let Some(slot) = rt.slots.get_mut(code) else { continue };
            if slot.disabled {
                continue; // 熔断停用 → 按「无覆盖」处理（G5 引擎语义）。
            }
            let ctx = BarCtx::new(idx, latest_bar.clone(), bars, snapshot);
            let out = slot.instance.on_bar(&ctx);
            drop(ctx); // 插件日志（ctx.log）本期不归集（P4a 范围外，决策点 3 仅插件错误/熔断入流）。
            match out {
                Ok(score) => {
                    slot.consecutive_errors = 0; // 成功即清零（G5）。
                    scores.push(StrategyScore {
                        strategy_id: rt.config.strategy_id.clone(),
                        score,
                        signal: aggregate_to_signal(
                            score,
                            self.buy_long_threshold,
                            self.sell_threshold,
                        )
                        .to_string(),
                    });
                    let w = rt
                        .config
                        .stock_weights
                        .get(code)
                        .copied()
                        .unwrap_or(rt.config.weight);
                    weighted.push((w, score));
                }
                Err(e) => {
                    slot.consecutive_errors += 1;
                    // G5：错误 bar 记中立分 50 仍参与聚合（与引擎 SlotScore 口径一致）。
                    scores.push(StrategyScore {
                        strategy_id: rt.config.strategy_id.clone(),
                        score: NEUTRAL_SCORE,
                        signal: aggregate_to_signal(
                            NEUTRAL_SCORE,
                            self.buy_long_threshold,
                            self.sell_threshold,
                        )
                        .to_string(),
                    });
                    let w = rt
                        .config
                        .stock_weights
                        .get(code)
                        .copied()
                        .unwrap_or(rt.config.weight);
                    weighted.push((w, NEUTRAL_SCORE));
                    self.events.push(SessionEvent::PluginError {
                        ts: latest_bar.ts,
                        code: code.to_string(),
                        strategy_id: rt.config.strategy_id.clone(),
                        sha256: rt.config.sha256.clone(),
                        bar_index: idx,
                        error: e.to_string(),
                    });
                    if slot.consecutive_errors >= strategy_core::CIRCUIT_BREAKER_THRESHOLD {
                        slot.disabled = true;
                        self.events.push(SessionEvent::CircuitBreaker {
                            ts: latest_bar.ts,
                            code: code.to_string(),
                            strategy_id: rt.config.strategy_id.clone(),
                            sha256: rt.config.sha256.clone(),
                            bar_index: idx,
                        });
                    }
                }
            }
        }

        let aggregate_score = weighted_aggregate(&weighted);
        let signal =
            aggregate_to_signal(aggregate_score, self.buy_long_threshold, self.sell_threshold);
        let eval = StockEvaluation {
            code: code.to_string(),
            ts: latest_bar.ts,
            latest_price: latest_bar.close,
            per_strategy_scores: scores,
            aggregate_score,
            signal: signal.to_string(),
        };
        self.latest.insert(code.to_string(), eval.clone());
        Some(eval)
    }

    /// 取走并清空待归集的会话事件（应用层每 feed 后调用，入会话事件流）。
    pub fn take_events(&mut self) -> Vec<SessionEvent> {
        std::mem::take(&mut self.events)
    }

    /// 最近一次评估（查询用；未评估过 → `None`）。
    pub fn latest_evaluation(&self, code: &str) -> Option<&StockEvaluation> {
        self.latest.get(code)
    }

    /// 全部最近评估（多标的概览；按 code 升序）。
    pub fn all_evaluations(&self) -> Vec<&StockEvaluation> {
        self.latest.values().collect()
    }

    /// 全部钉住策略配置（供 web/MCP 展示 + 应用层落盘快照）。
    pub fn configs(&self) -> Vec<PluginStrategyConfig> {
        self.strategies.iter().map(|rt| rt.config.clone()).collect()
    }

    pub fn buy_long_threshold(&self) -> f64 {
        self.buy_long_threshold
    }

    pub fn sell_threshold(&self) -> f64 {
        self.sell_threshold
    }
}

/// `bars_since_entry`：entry_ts 起（含）到当前 bar 的 bar 数差。
/// entry_ts 落在已知序列首根之前（恢复场景）→ 按首根计（残差：仅计本会话已见 bar）。
fn bars_since_entry(bars: &[Bar], idx: usize, entry_ts: i64) -> u64 {
    let entry_idx = bars.partition_point(|b| b.ts < entry_ts);
    (idx.saturating_sub(entry_idx)) as u64
}

/// 从成交台账推导某标的当前持仓的建仓时间（`PositionInput.entry_ts` 来源）。
/// **sticky-first-entry 口径（MINOR-2，与 strategy-core `Holding` 一致）**：自空仓以来**首笔
/// 建仓 ts 钉死**——加仓不动、**部分卖出不前进**（即便卖超 FIFO 口径的首 lot）；清仓后
/// 下一笔建仓重新钉死。当前无持仓 → `None`。卖超持仓的损坏数据 → 防御性视为清仓（不 panic）。
pub fn current_entry_ts(trades: &[SimTrade], code: &str) -> Option<i64> {
    let mut qty = 0.0;
    let mut pinned: Option<i64> = None;
    for t in trades.iter().filter(|t| t.code == code) {
        match t.side {
            Side::Buy => {
                if qty <= 1e-9 {
                    pinned = Some(t.ts); // 空仓以来首笔建仓 → 钉死
                }
                qty += t.qty;
            }
            Side::Sell => {
                qty -= t.qty;
                if qty <= 1e-9 {
                    qty = 0.0;
                    pinned = None; // 清仓 → 复位，下次建仓重钉
                }
            }
        }
    }
    if qty <= 1e-9 { None } else { pinned }
}

#[cfg(test)]
#[path = "plugin_orchestrator_tests.rs"]
mod tests;
