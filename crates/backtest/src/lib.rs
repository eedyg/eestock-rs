//! # backtest —— 回测共享纯逻辑（费用/指标/绩效/类型；Wave 3 手写，非 tangle）。
//!
//! P4b（D16 终章，旧系统退役）：旧单策略引擎 `engine.rs` 与 7 款内建策略 `strategies.rs` 已物理删除
//! （功能由 strategy-core ensemble 引擎 + Registry 插件全覆盖；详见 design/12-strategy-system/01-adr.md §13.8）。
//! 本 crate 保留 strategy-core / strategy-runtime / simlive / application 共用的纯逻辑件：
//! `fee`（费用/滑点模型）/ `indicators`（指标口径）/ `metrics`（8 项绩效）/ `types`（Bar/Period/
//! ParamDef/ParamValue/StrategyParams/TradeDetail 等 ABI 类型）/ `round_trip`（ADR-027 L1 回合聚合，
//! 全系统唯一实现）。旧引擎专用的
//! `Signal`/`Ctx`/`Strategy`/`RunConfig`/`BacktestResult`/`StrategyResult` 已随 P4b 删除（零消费方）。
//!
//! 权威依据：`design/08-backtest/01-engine-adr.md`（保留部分）；`design/12-strategy-system/01-adr.md` §13.8（退役）。

pub mod fee;
pub mod indicators;
pub mod metrics;
pub mod round_trip;
pub mod types;

// 常用类型再导出，方便应用层 `use backtest::*;`。
pub use fee::{BuyExecution, FeeModel, SellExecution};
pub use indicators::{BollValue, Indicators, KdjValue, MacdValue, OnlineIndicators};
pub use metrics::{compute_drawdown, compute_metrics, BacktestMetrics};
// ADR-027 P1a：OrderSide 为跨 crate ABI 类型（唯一定义在 backtest，strategy-core 经 `pub use` 再导出）；
// `aggregate_round_trips` 为全系统唯一回合聚合实现（禁止第二处）。
pub use round_trip::{
    aggregate_round_trips, assign_rt_seq, FillFact, FillReason, OrderSide, RoundTripStatus,
    RtSeqAssigner,
};
pub use types::{Bar, ParamDef, ParamKind, ParamValue, Period, StrategyParams, TradeDetail};
