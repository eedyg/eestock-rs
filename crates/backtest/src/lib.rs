//! # backtest —— 纯逻辑回测引擎（Wave 3，手写，非 tangle）。
//!
//! 无 IO / 无 DB：事件驱动 bar 循环 + 策略 trait + 组合/订单/费用/滑点 + 指标 + 8 项绩效指标。
//! application 层（BacktestService）通过本 crate 端口调用；web/storage 不得反向依赖其 IO。
//! 权威依据：`design/08-backtest/01-engine-adr.md`（已批复，6 决策按推荐）。

pub mod engine;
pub mod fee;
pub mod indicators;
pub mod metrics;
pub mod strategies;
pub mod types;

// 常用类型再导出，方便应用层 `use backtest::*;`。
pub use engine::{run, run_with_progress, Engine};
pub use fee::{BuyExecution, FeeModel, SellExecution};
pub use indicators::{BollValue, Indicators, KdjValue, MacdValue};
pub use metrics::{compute_drawdown, compute_metrics, BacktestMetrics};
pub use strategies::{
    builtin_strategies, builtin_strategy_catalog, builtin_strategy_ids, create_strategy,
    AtrChannelStrategy, BollStrategy, DualMaStrategy, KdjStrategy, MaRsiStrategy, MacdStrategy,
    MomentumStrategy, ParamValue, StrategyParams,
};
pub use types::{
    BacktestResult, Bar, Ctx, ParamDef, ParamKind, Period, RunConfig, Signal, Strategy,
    StrategyResult, TradeDetail,
};
