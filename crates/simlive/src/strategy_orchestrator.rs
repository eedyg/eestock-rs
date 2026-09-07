//! 实时策略编排器（ADR 11-sim-live §4/§10，L2）：3 策略 × 标的集，每新 bar 评估 → 每 stock 独立评分 + 聚合评分。
//!
//! 纯逻辑、无 IO/无随机：复用 `backtest::{create_strategy, Indicators, Signal}`（不改 backtest 引擎/策略内部）。
//! 口径（本模块明确定义并注明）：
//! - **独立评分**（0-100）：把每策略对单标的的 `Signal` 映射为数值分。映射见 [`signal_to_score`]：
//!   `Buy(_) → 100`、`Hold → 50`、`Sell → 0`（保守中立取 50，Buy 满分、Sell 零分）。
//! - **聚合评分**（0-100）：各策略评分按 `weight` 加权平均（仅对**覆盖该 stock 的策略**），即
//!   `Σ(weight_i × score_i) / Σ(weight_i)`；无覆盖策略时取 50（中立）。
//! - **交易信号**：由聚合评分阈值决定——`aggregate ≥ buy_long_threshold`（默认 60）→ `buy`；
//!   `aggregate ≤ sell_threshold`（默认 40）→ `sell`；否则 `hold`。
//! - **评估上下文**：每策略以独立 `Ctx{position:0}` 评估（策略视作「未持仓」视角），`ctx.position` 恒 0，
//!   故依赖持仓状态的策略（如 ATR 通道止损的卖出腿）在评分模式下不产生卖出信号；实际交易决策的持仓状态
//!   由 application 层（SimLiveService）依据**聚合信号 + 账户持仓**独立判定，见其 `process_bar`。
//! - **内建状态按标的隔离**：策略的 `on_bar` 带内部状态（如 `dual_ma` 的 `prev_above`、`momentum` 的滚动窗），
//!   这些状态是**按标的**的，故对每个「策略 × 标的」建独立实例（`create_strategy` 各建一次）。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use backtest::{Bar, Ctx, Indicators, Signal, Strategy, create_strategy, StrategyParams};

/// 策略配置（ADR §4）：id/params/stocks/weight。
/// 注：`params` 为 `backtest::StrategyParams`（`ParamValue` 未实现 serde），故本结构不导出 serde
/// （不在 MCP/存储边界传输）；MCP 侧只传 id/weight/stocks（可序列化），params 由应用层持有。
#[derive(Debug, Clone, PartialEq)]
pub struct StrategyConfig {
    pub id: String,
    pub params: StrategyParams,
    /// 该策略实时评估的标的集（≤30 股）。
    pub stocks: Vec<String>,
    /// 聚合权重（策略级默认）。
    pub weight: f64,
    /// 按标的覆盖权重（ADR §4 补充：策略×股票级权重）；未指定某股 → 用 `weight`。
    pub stock_weights: HashMap<String, f64>,
}

/// 单策略对单标的的独立评分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyScore {
    pub strategy_id: String,
    /// 0-100（见 [`signal_to_score`] 映射）。
    pub score: f64,
    /// 原始信号：buy / sell / hold。
    pub signal: String,
}

/// 单 stock 的一次评估结果（每新 bar 产出）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StockEvaluation {
    pub code: String,
    pub ts: i64,
    /// 最新（当前评估 bar）收盘价。
    pub latest_price: f64,
    pub per_strategy_scores: Vec<StrategyScore>,
    /// 0-100（加权平均）。
    pub aggregate_score: f64,
    /// 由聚合阈值决定：buy / sell / hold。
    pub signal: String,
}

/// 每个策略在其标的集内的运行时（每标的一个独立策略实例）。
struct StrategyRuntime {
    config: StrategyConfig,
    /// code → 该策略在该标的上的实例。
    instances: BTreeMap<String, Box<dyn Strategy>>,
}

/// 实时策略编排器。
pub struct RealtimeStrategyOrchestrator {
    strategies: Vec<StrategyRuntime>,
    /// code → 累计 bar 序列（供 Indicators 惰性计算）。
    bars: BTreeMap<String, Vec<Bar>>,
    /// code → 最近一次评估（查询用）。
    latest: BTreeMap<String, StockEvaluation>,
    /// 做多阈值（聚合分 ≥ 该值 → buy）。
    buy_long_threshold: f64,
    /// 卖出阈值（聚合分 ≤ 该值 → sell）。
    sell_threshold: f64,
}

/// 默认做多阈值。
pub const DEFAULT_BUY_LONG_THRESHOLD: f64 = 60.0;
/// 默认卖出阈值。
pub const DEFAULT_SELL_THRESHOLD: f64 = 40.0;
/// 无覆盖策略时的中立聚合分。
pub const NEUTRAL_SCORE: f64 = 50.0;

impl RealtimeStrategyOrchestrator {
    /// 用给定策略配置构建编排器。未知策略 id（`create_strategy` 返回 None）被静默跳过。
    /// `buy_long_threshold`/`sell_threshold` 为聚合信号阈值（缺省 60/40）。
    pub fn new(configs: Vec<StrategyConfig>, buy_long_threshold: f64, sell_threshold: f64) -> Self {
        let strategies = configs
            .into_iter()
            .map(|config| {
                let instances = config
                    .stocks
                    .iter()
                    .filter_map(|code| {
                        create_strategy(&config.id, &config.params)
                            .map(|s| (code.clone(), s))
                    })
                    .collect();
                StrategyRuntime { config, instances }
            })
            .collect();
        Self {
            strategies,
            bars: BTreeMap::new(),
            latest: BTreeMap::new(),
            buy_long_threshold,
            sell_threshold,
        }
    }

    /// 默认阈值构造。
    pub fn with_default_thresholds(configs: Vec<StrategyConfig>) -> Self {
        Self::new(configs, DEFAULT_BUY_LONG_THRESHOLD, DEFAULT_SELL_THRESHOLD)
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

    /// 该策略标的集是否为某策略覆盖（供 application 判定是否属于策略域）。
    pub fn covers(&self, code: &str) -> bool {
        self.strategies
            .iter()
            .any(|s| s.config.stocks.iter().any(|c| c == code))
    }

    /// 喂入某标的一根新 bar，评估并返回该标的的 `StockEvaluation`。
    /// 标的不在任何策略标的集内 → 仍记录行情但不评估，返回 `None`。
    pub fn feed_bar(&mut self, code: &str, bar: Bar) -> Option<StockEvaluation> {
        self.bars.entry(code.to_string()).or_default().push(bar);
        self.evaluate(code)
    }

    /// 对某标的按最新 bar 重新评估（每 feed 后内部调用；亦可供查询重算）。
    /// 无该标的 bar 或不在任何策略标的集内 → `None`。
    pub fn evaluate(&mut self, code: &str) -> Option<StockEvaluation> {
        let bars = self.bars.get(code)?;
        if bars.is_empty() {
            return None;
        }
        if !self.covers(code) {
            return None;
        }
        let idx = bars.len() - 1;
        let latest_bar = bars[idx].clone();
        let ind = Indicators::new(bars, idx);

        let mut scores: Vec<StrategyScore> = Vec::new();
        let mut weighted_sum = 0.0;
        let mut weight_sum = 0.0;

        for rt in &mut self.strategies {
            if !rt.config.stocks.iter().any(|c| c == code) {
                continue;
            }
            let Some(inst) = rt.instances.get_mut(code) else {
                continue;
            };
            let mut ctx = Ctx {
                bar_index: idx,
                ts: latest_bar.ts,
                cash: 0.0,
                position: 0.0,
                equity: 0.0,
            };
            let signal = inst.on_bar(&mut ctx, &latest_bar, &ind);
            let score = signal_to_score(&signal);
            scores.push(StrategyScore {
                strategy_id: rt.config.id.clone(),
                score,
                signal: signal_str(&signal).to_string(),
            });
            // 仅当该策略覆盖该标的且有分才累加权重。
            // 权重 w[S,X] = stock_weights[X] ?? weight（ADR §4 补充：策略×股票级权重覆盖）。
            let w = rt.config.stock_weights.get(code).copied().unwrap_or(rt.config.weight);
            weighted_sum += w * score;
            weight_sum += w;
        }

        let aggregate_score = if weight_sum > 0.0 {
            weighted_sum / weight_sum
        } else {
            NEUTRAL_SCORE
        };
        let signal = aggregate_to_signal(aggregate_score, self.buy_long_threshold, self.sell_threshold);

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

    /// 最近一次评估（查询用；未评估过 → `None`）。
    pub fn latest_evaluation(&self, code: &str) -> Option<&StockEvaluation> {
        self.latest.get(code)
    }

    /// 全部最近评估（多标的概览；按 code 升序）。
    pub fn all_evaluations(&self) -> Vec<&StockEvaluation> {
        self.latest.values().collect()
    }

    /// 全部策略配置（供 web/MCP 展示每策略 参数/标的/权重；含 stock_weights）。
    pub fn configs(&self) -> Vec<StrategyConfig> {
        self.strategies.iter().map(|rt| rt.config.clone()).collect()
    }

    pub fn buy_long_threshold(&self) -> f64 {
        self.buy_long_threshold
    }

    pub fn sell_threshold(&self) -> f64 {
        self.sell_threshold
    }
}

/// `Signal → 0-100 分数` 映射（`Buy(_) → 100`、`Hold → 50`、`Sell → 0`）。
pub fn signal_to_score(signal: &Signal) -> f64 {
    match signal {
        Signal::Buy(_) => 100.0,
        Signal::Hold => NEUTRAL_SCORE,
        Signal::Sell => 0.0,
    }
}

/// 信号 → 文本（buy/sell/hold）。
pub fn signal_str(signal: &Signal) -> &'static str {
    match signal {
        Signal::Buy(_) => "buy",
        Signal::Hold => "hold",
        Signal::Sell => "sell",
    }
}

/// 聚合分 → 信号（`≥ buy_long_threshold → buy`；`≤ sell_threshold → sell`；否则 `hold`）。
pub fn aggregate_to_signal(
    aggregate: f64,
    buy_long_threshold: f64,
    sell_threshold: f64,
) -> &'static str {
    if aggregate >= buy_long_threshold {
        "buy"
    } else if aggregate <= sell_threshold {
        "sell"
    } else {
        "hold"
    }
}

/// 加权平均：`(weight, score)` 列表 → 聚合分；空即中立 50。
pub fn weighted_aggregate(scores: &[(f64, f64)]) -> f64 {
    let mut wsum = 0.0;
    let mut ssum = 0.0;
    for (w, s) in scores {
        wsum += *w;
        ssum += *w * *s;
    }
    if wsum > 0.0 {
        ssum / wsum
    } else {
        NEUTRAL_SCORE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    fn bar(ts: i64, close: f64) -> Bar {
        Bar { ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 10_000.0 }
    }

    fn num_params(pairs: &[(&str, f64)]) -> StrategyParams {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), backtest::ParamValue::Num(*v)))
            .collect()
    }

    // ── Signal → 0-100 映射（黄金样本）──
    #[test]
    fn signal_to_score_mapping() {
        close(signal_to_score(&Signal::Buy(1.0)), 100.0);
        close(signal_to_score(&Signal::Buy(0.5)), 100.0);
        close(signal_to_score(&Signal::Hold), 50.0);
        close(signal_to_score(&Signal::Sell), 0.0);
        assert_eq!(signal_str(&Signal::Buy(1.0)), "buy");
        assert_eq!(signal_str(&Signal::Hold), "hold");
        assert_eq!(signal_str(&Signal::Sell), "sell");
    }

    // ── 聚合加权平均（黄金样本）──
    #[test]
    fn weighted_aggregate_computes_weighted_mean() {
        // (1.0,100) + (3.0,50) → (100+150)/4 = 62.5
        close(weighted_aggregate(&[(1.0, 100.0), (3.0, 50.0)]), 62.5);
        // 空 → 中立 50
        close(weighted_aggregate(&[]), 50.0);
        // 单一 = 自身
        close(weighted_aggregate(&[(2.0, 80.0)]), 80.0);
    }

    // ── 聚合 → 交易信号（阈值）──
    #[test]
    fn aggregate_to_signal_thresholds() {
        assert_eq!(aggregate_to_signal(60.0, 60.0, 40.0), "buy");
        assert_eq!(aggregate_to_signal(70.0, 60.0, 40.0), "buy");
        assert_eq!(aggregate_to_signal(40.0, 60.0, 40.0), "sell");
        assert_eq!(aggregate_to_signal(30.0, 60.0, 40.0), "sell");
        assert_eq!(aggregate_to_signal(50.0, 60.0, 40.0), "hold");
    }

    // ── 编排器：3 策略 × 2 股票，对固定 bar 序列算每策略独立分 + 聚合分 ──
    // 可信口径：预期信号由「同样 bars/参数的独立策略实例（参考运行）」计算（非手抄），
    // 断言编排器正确接线（各策略实例 × 标的）并按 weight 聚合。固定输入可复现。
    #[test]
    fn orchestrator_scores_each_strategy_and_aggregates() {
        let configs = vec![
            StrategyConfig {
                id: "momentum".into(),
                params: num_params(&[("lookback", 2.0)]),
                stocks: vec!["AAA".into(), "BBB".into()],
                weight: 2.0,
                stock_weights: HashMap::new(),
            },
            StrategyConfig {
                id: "momentum".into(),
                params: num_params(&[("lookback", 3.0)]),
                stocks: vec!["AAA".into()],
                weight: 1.0,
                stock_weights: HashMap::new(),
            },
            StrategyConfig {
                id: "dual_ma".into(),
                params: num_params(&[("fast", 2.0), ("slow", 3.0)]),
                stocks: vec!["BBB".into()],
                weight: 3.0,
                stock_weights: HashMap::new(),
            },
        ];
        let mut orch = RealtimeStrategyOrchestrator::new(configs, 60.0, 40.0);

        // 固定 bar 序列（收盘价做手算：AAA 末 bar 突破 → momentum Buy；
        // BBB 单调上升 → momentum Buy、dual_ma Hold）。
        let aaa_bars = vec![
            bar(100, 10.0), bar(101, 10.0), bar(102, 10.0),
            bar(103, 11.0), bar(104, 13.0),
        ];
        let bbb_bars = vec![
            bar(100, 10.0), bar(101, 11.0), bar(102, 12.0),
            bar(103, 13.0), bar(104, 14.0),
        ];

        let mut ref_aaa: Vec<(String, f64)> = Vec::new();
        let mut ref_bbb: Vec<(String, f64)> = Vec::new();

        // 参考运行：独立实例逐 bar 喂入，记录末 bar 信号→分值。
        let mut m2_a = create_strategy("momentum", &num_params(&[("lookback", 2.0)])).unwrap();
        let mut m3_a = create_strategy("momentum", &num_params(&[("lookback", 3.0)])).unwrap();
        let mut dm_b = create_strategy("dual_ma", &num_params(&[("fast", 2.0), ("slow", 3.0)])).unwrap();
        let mut m2_b = create_strategy("momentum", &num_params(&[("lookback", 2.0)])).unwrap();

        let (last_a2, last_a3, last_b2, last_b3) = reference_signals(
            &aaa_bars, &bbb_bars,
            &mut *m2_a, &mut *m3_a, &mut *m2_b, &mut *dm_b,
        );
        ref_aaa.push(("momentum".into(), signal_to_score(&last_a2)));
        ref_aaa.push(("momentum".into(), signal_to_score(&last_a3)));
        ref_bbb.push(("momentum".into(), signal_to_score(&last_b2)));
        ref_bbb.push(("dual_ma".into(), signal_to_score(&last_b3)));

        // 编排器逐 bar 喂入。
        for b in &aaa_bars {
            orch.feed_bar("AAA", b.clone());
        }
        for b in &bbb_bars {
            orch.feed_bar("BBB", b.clone());
        }

        let ev_a = orch.latest_evaluation("AAA").unwrap().clone();
        let ev_b = orch.latest_evaluation("BBB").unwrap().clone();

        // 独立分：AAA 两策略（momentum 2 / momentum 3）。
        assert_eq!(ev_a.per_strategy_scores.len(), 2);
        assert_eq!(ev_a.per_strategy_scores[0].strategy_id, "momentum");
        assert_eq!(ev_a.per_strategy_scores[1].strategy_id, "momentum");
        close(ev_a.per_strategy_scores[0].score, ref_aaa[0].1);
        close(ev_a.per_strategy_scores[1].score, ref_aaa[1].1);

        // 独立分：BBB 两策略（momentum 2 / dual_ma）。
        assert_eq!(ev_b.per_strategy_scores.len(), 2);
        assert_eq!(ev_b.per_strategy_scores[0].strategy_id, "momentum");
        assert_eq!(ev_b.per_strategy_scores[1].strategy_id, "dual_ma");
        close(ev_b.per_strategy_scores[0].score, ref_bbb[0].1);
        close(ev_b.per_strategy_scores[1].score, ref_bbb[1].1);

        // 聚合分 = Σ(weight×score)/Σ(weight)：AAA(2*S1+1*S2)/3；BBB(2*S1+3*S3)/5。
        let agg_a = (2.0 * ref_aaa[0].1 + 1.0 * ref_aaa[1].1) / 3.0;
        let agg_b = (2.0 * ref_bbb[0].1 + 3.0 * ref_bbb[1].1) / 5.0;
        close(ev_a.aggregate_score, agg_a);
        close(ev_b.aggregate_score, agg_b);

        // 信号由聚合阈值（60/40）判定。
        assert_eq!(ev_a.signal, aggregate_to_signal(agg_a, 60.0, 40.0));
        assert_eq!(ev_b.signal, aggregate_to_signal(agg_b, 60.0, 40.0));

        // 标的集与最新价。
        assert_eq!(orch.stocks(), vec!["AAA".to_string(), "BBB".to_string()]);
        close(ev_a.latest_price, 13.0);
        close(ev_b.latest_price, 14.0);
        assert_eq!(ev_a.ts, 104);
        assert_eq!(ev_b.ts, 104);
    }

    /// 对固定 bars 参考运行各策略，返回末 bar 信号。
    #[allow(clippy::too_many_arguments)]
    fn reference_signals(
        aaa: &[Bar],
        bbb: &[Bar],
        m2_a: &mut dyn Strategy,
        m3_a: &mut dyn Strategy,
        m2_b: &mut dyn Strategy,
        dm_b: &mut dyn Strategy,
    ) -> (Signal, Signal, Signal, Signal) {
        let mut last_a2 = Signal::Hold;
        let mut last_a3 = Signal::Hold;
        let mut last_b2 = Signal::Hold;
        let mut last_b3 = Signal::Hold;
        for (i, b) in aaa.iter().enumerate() {
            let ind = Indicators::new(aaa, i);
            let mut ctx = Ctx { bar_index: i, ts: b.ts, cash: 0.0, position: 0.0, equity: 0.0 };
            last_a2 = m2_a.on_bar(&mut ctx, b, &ind);
            let ind = Indicators::new(aaa, i);
            let mut ctx = Ctx { bar_index: i, ts: b.ts, cash: 0.0, position: 0.0, equity: 0.0 };
            last_a3 = m3_a.on_bar(&mut ctx, b, &ind);
        }
        for (i, b) in bbb.iter().enumerate() {
            let ind = Indicators::new(bbb, i);
            let mut ctx = Ctx { bar_index: i, ts: b.ts, cash: 0.0, position: 0.0, equity: 0.0 };
            last_b2 = m2_b.on_bar(&mut ctx, b, &ind);
            let ind = Indicators::new(bbb, i);
            let mut ctx = Ctx { bar_index: i, ts: b.ts, cash: 0.0, position: 0.0, equity: 0.0 };
            last_b3 = dm_b.on_bar(&mut ctx, b, &ind);
        }
        (last_a2, last_a3, last_b2, last_b3)
    }

    /// 未覆盖标的不评估；空指标序列。
    #[test]
    fn feed_unknown_stock_returns_none() {
        let configs = vec![StrategyConfig {
            id: "momentum".into(),
            params: num_params(&[("lookback", 2.0)]),
            stocks: vec!["AAA".into()],
            weight: 1.0,
            stock_weights: HashMap::new(),
        }];
        let mut orch = RealtimeStrategyOrchestrator::with_default_thresholds(configs);
        // 未覆盖标的不评估。
        assert!(orch.feed_bar("ZZZ", bar(100, 10.0)).is_none());
        assert!(orch.latest_evaluation("ZZZ").is_none());
        // 覆盖标的可评估。
        assert!(orch.feed_bar("AAA", bar(100, 10.0)).is_some());
        assert!(orch.latest_evaluation("AAA").is_some());
    }

    /// 策略内部状态按标的隔离（同一策略 × 两标的互不污染）。
    #[test]
    fn strategy_state_isolated_per_stock() {
        let configs = vec![StrategyConfig {
            id: "dual_ma".into(),
            params: num_params(&[("fast", 2.0), ("slow", 3.0)]),
            stocks: vec!["AAA".into(), "BBB".into()],
            weight: 1.0,
            stock_weights: HashMap::new(),
        }];
        let mut orch = RealtimeStrategyOrchestrator::with_default_thresholds(configs);
        // AAA：先高后低（始终低于快慢线 → 未金叉）；BBB：先低后高 → 于 bar3 金叉。
        // AAA：5 根全下降 → dual_ma 未金叉 → Hold(50)。
        for b in &[bar(100, 15.0), bar(101, 14.0), bar(102, 13.0), bar(103, 12.0), bar(104, 11.0)] {
            orch.feed_bar("AAA", b.clone());
        }
        // BBB：4 根（先低后高，末 bar=bar3）→ dual_ma 金叉 → Buy(100)。
        for b in &[bar(100, 12.0), bar(101, 8.0), bar(102, 9.0), bar(103, 14.0)] {
            orch.feed_bar("BBB", b.clone());
        }
        let a = orch.latest_evaluation("AAA").unwrap();
        let b = orch.latest_evaluation("BBB").unwrap();
        // 状态隔离：AAA 未金叉 → Hold(50)；BBB 于末 bar 金叉 → Buy(100)。
        close(a.aggregate_score, 50.0);
        close(b.aggregate_score, 100.0);
    }

    /// ADR §4 补充：策略×股票级权重 `stock_weights[X]` 覆盖默认 `weight` 参与聚合。
    /// 两策略均覆盖 AAA（momentum lookback=2 权重默认 1，但 stock_weights[AAA]=3；momentum lookback=3 权重 1）；
    /// 聚合 = Σ(w[S,X]·score)/Σ(w[S,X]) = (3·s2 + 1·s3)/4。
    #[test]
    fn orchestrator_stock_weights_override_default_weight() {
        let configs = vec![
            StrategyConfig {
                id: "momentum".into(),
                params: num_params(&[("lookback", 2.0)]),
                stocks: vec!["AAA".into()],
                weight: 1.0,
                stock_weights: HashMap::from([("AAA".to_string(), 3.0)]),
            },
            StrategyConfig {
                id: "momentum".into(),
                params: num_params(&[("lookback", 3.0)]),
                stocks: vec!["AAA".into()],
                weight: 1.0,
                stock_weights: HashMap::new(),
            },
        ];
        let mut orch = RealtimeStrategyOrchestrator::new(configs, 60.0, 40.0);
        let aaa_bars = vec![bar(100, 10.0), bar(101, 10.0), bar(102, 10.0), bar(103, 11.0), bar(104, 13.0)];
        for b in &aaa_bars {
            orch.feed_bar("AAA", b.clone());
        }
        // 参考运行：独立实例逐 bar 喂入，取末 bar 信号 → 分。
        let mut m2 = create_strategy("momentum", &num_params(&[("lookback", 2.0)])).unwrap();
        let mut m3 = create_strategy("momentum", &num_params(&[("lookback", 3.0)])).unwrap();
        let mut s2 = Signal::Hold;
        let mut s3 = Signal::Hold;
        for (i, b) in aaa_bars.iter().enumerate() {
            let ind = Indicators::new(&aaa_bars, i);
            let mut ctx = Ctx { bar_index: i, ts: b.ts, cash: 0.0, position: 0.0, equity: 0.0 };
            s2 = m2.on_bar(&mut ctx, b, &ind);
            let ind = Indicators::new(&aaa_bars, i);
            let mut ctx = Ctx { bar_index: i, ts: b.ts, cash: 0.0, position: 0.0, equity: 0.0 };
            s3 = m3.on_bar(&mut ctx, b, &ind);
        }
        let score2 = signal_to_score(&s2);
        let score3 = signal_to_score(&s3);
        let ev = orch.latest_evaluation("AAA").unwrap();
        assert_eq!(ev.per_strategy_scores.len(), 2);
        // stock_weights 生效：w[AAA] 对策略1=3、对策略2=1 → (3·score2 + 1·score3)/4。
        let agg_stock = (3.0 * score2 + 1.0 * score3) / 4.0;
        close(ev.aggregate_score, agg_stock);
        // 若忽略 stock_weights（均=weight=1）→ (score2+score3)/2；score2≠score3 时二者必不同。
        let agg_uniform = (score2 + score3) / 2.0;
        if (score2 - score3).abs() > 1e-9 {
            assert!((ev.aggregate_score - agg_uniform).abs() > 1e-9,
                "stock_weights 应在评分不同时改变聚合分");
        }
    }
}
