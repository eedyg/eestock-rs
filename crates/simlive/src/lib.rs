//! # simlive —— 模拟实盘核心（ADR 11-sim-live，L1；手写，非 tangle）。
//!
//! 无 IO / 无 DB：SimAccount（账户）、FillEngine（撮合）、SessionManager（会话）、StrategySignal（基础信号）。
//! application 层（SimLiveService）通过本 crate 端口调用；web/storage/mcp 不得反向依赖其 IO。
//! 复用 backtest::FeeModel（费用/滑点同步口径）。权威依据：design/11-sim-live/01-adr.md（§5/6/9/10/11）。

pub mod account;
pub mod fill;
pub mod session;
pub mod strategy_orchestrator;

pub use account::{Position, SimAccount, SimPosition};
pub use fill::{Fill, FillEngine, IntentId, Order, Side, SimTrade};
pub use session::{
    OrderStatus, SessionManager, SessionState, SessionStatus, SimOrder, SimSession,
    SignalEvent, StrategySignal,
};
pub use strategy_orchestrator::{
    DEFAULT_BUY_LONG_THRESHOLD, DEFAULT_SELL_THRESHOLD, NEUTRAL_SCORE,
    RealtimeStrategyOrchestrator, StockEvaluation, StrategyConfig, StrategyScore,
    aggregate_to_signal, signal_str, signal_to_score, weighted_aggregate,
};
