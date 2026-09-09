//! sim-live 策略聚合共享件（ADR 11-sim-live §4/§10；P4b 后为新编排器服务）。
//!
//! P4b（D16 终章）：旧 `RealtimeStrategyOrchestrator`（基于 backtest 内建策略 `create_strategy`）已物理删除，
//! 策略源切换为 Registry 插件（见 `plugin_orchestrator::PluginStrategyOrchestrator`，ADR 12-strategy-system §13.6）。
//! 本模块保留新编排器复用的聚合语义件：
//! - **聚合评分**（0-100）：各策略评分按 `weight` 加权平均（仅对**覆盖该 stock 的策略**），即
//!   `Σ(weight_i × score_i) / Σ(weight_i)`；无覆盖策略时取 50（中立，[`NEUTRAL_SCORE`]）。
//! - **交易信号**：由聚合评分阈值决定——`aggregate ≥ buy_long_threshold`（默认 60）→ `buy`；
//!   `aggregate ≤ sell_threshold`（默认 40）→ `sell`；否则 `hold`（[`aggregate_to_signal`]）。
//! - 评估结果读模型：[`StrategyScore`] / [`StockEvaluation`]（web/MCP 展示与 application 层共享）。

use serde::{Deserialize, Serialize};

/// 单策略对单标的的独立评分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyScore {
    pub strategy_id: String,
    /// 0-100（P4a 切源后：插件连续分直通）。
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

/// 默认做多阈值。
pub const DEFAULT_BUY_LONG_THRESHOLD: f64 = 60.0;
/// 默认卖出阈值。
pub const DEFAULT_SELL_THRESHOLD: f64 = 40.0;
/// 无覆盖策略时的中立聚合分。
pub const NEUTRAL_SCORE: f64 = 50.0;

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
}
