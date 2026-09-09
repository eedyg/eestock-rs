//! # simlive —— 模拟实盘核心（ADR 11-sim-live，L1；手写，非 tangle）。
//!
//! 无 IO / 无 DB：SimAccount（账户）、FillEngine（撮合）、SessionManager（会话）、StrategySignal（基础信号）。
//! application 层（SimLiveService）通过本 crate 端口调用；web/storage/mcp 不得反向依赖其 IO。
//! 复用 backtest::FeeModel（费用/滑点同步口径）。权威依据：design/11-sim-live/01-adr.md（§5/6/9/10/11）。

pub mod account;
pub mod fill;
pub mod plugin_orchestrator;
pub mod session;
pub mod strategy_orchestrator;

pub use account::{Position, SimAccount, SimPosition};
pub use fill::{Fill, FillEngine, IntentId, Order, Side, SimTrade};
pub use plugin_orchestrator::{
    current_entry_ts, OrchestratorError, PluginStrategyConfig, PluginStrategyOrchestrator,
    PositionInput, MAX_STOCKS_PER_STRATEGY, MAX_STRATEGIES,
};
pub use session::{
    OrderStatus, SessionEvent, SessionManager, SessionState, SessionStatus, SimOrder, SimSession,
    SignalEvent, StrategySignal,
};
// P4a 切源：旧编排器标 deprecated 保留至 P4b 物理删除（ADR §13.8 并存期结束）。
#[allow(deprecated)]
pub use strategy_orchestrator::{
    signal_str, signal_to_score, RealtimeStrategyOrchestrator, StrategyConfig,
};
pub use strategy_orchestrator::{
    aggregate_to_signal, weighted_aggregate, StockEvaluation, StrategyScore,
    DEFAULT_BUY_LONG_THRESHOLD, DEFAULT_SELL_THRESHOLD, NEUTRAL_SCORE,
};
