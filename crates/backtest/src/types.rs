//! 回测 crate 的领域类型：Bar / Period / ParamDef / ParamKind / ParamValue / StrategyParams / TradeDetail。
//!
//! P4b（D16 终章，旧系统退役）：`engine.rs`/`strategies.rs` 已物理删除；`ParamValue`/`StrategyParams`
//! 为 strategy-core / strategy-runtime / simlive / application 共用的 **ABI 类型**，自 strategies.rs 迁入本文件保留。
//! 旧引擎专用的 `Signal`/`Ctx`/`Strategy` trait/`RunConfig`/`BacktestResult`/`StrategyResult`（旧
//! `GET /api/backtest/strategies` 目录条目）已随 P4b 一并删除——全 workspace 零消费方；ensemble 引擎
//! 信号/上下文口径由 strategy-core `TradeSignal` 与 strategy-runtime `BarCtx` 等自有类型承载。
//!
//! 口径说明（ADR 08-backtest §1-§6，已批复 6 决策按推荐）：
//! - 本 crate 定义**精简**的 `Bar`（`{ts,open,high,low,close,volume}`）与 `Period`（M1/M5/M15/D1），
//!   与 `domain::Bar`（含 code/period/amount/source 采集字段）解耦。application 层的端口适配器负责
//!   `domain::Bar -> backtest::Bar` 映射（本 crate 无 IO/无 DB，不依赖 domain）。
//! - `ts` 使用 Unix 秒（i64），方便纯逻辑单测；web 层负责转 datetime 展示。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 运行时策略参数（ABI 共用：strategy-core/strategy-runtime/simlive/application 均引用）
// ---------------------------------------------------------------------------

/// 运行时策略参数值：数值参数用 `Num(f64)`；枚举参数用 `Choice(String)`（对应 `ParamKind::Choice.options` 之一）。
#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Num(f64),
    Choice(String),
}

/// 策略运行时参数集合（key 与 `params_schema()` 的 `ParamDef.key` 对应）。
pub type StrategyParams = std::collections::HashMap<String, ParamValue>;

/// 一根 K 线 bar（回测用精简口径）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bar {
    /// bar 起始时刻（Unix 秒）。
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// 回测周期（ADR §3；UI：1m/5m/15m/1h/日）。
/// I-6/D3（2026-09-12 用户批准）：补 H1——与数据层 cagg 小时线口径对齐，
/// 消除「get_kline 支持 1h 但引擎拒绝 H1」的双口径。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Period {
    M1,
    M5,
    M15,
    H1,
    D1,
}

impl Period {
    /// 年化折返因子（ADR bt-3 推荐：日线 252；1m √(252×240) 等）。
    /// 交易时段假设 A 股 4 小时 = 240 分钟，年 252 个交易日。
    pub fn bars_per_year(&self) -> f64 {
        match self {
            Period::M1 => 252.0 * 240.0,
            Period::M5 => 252.0 * 48.0,
            Period::M15 => 252.0 * 16.0,
            Period::H1 => 252.0 * 4.0,
            Period::D1 => 252.0,
        }
    }
}

/// 参数 schema 类型（驱动 UI 参数表单 / 网格展开）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ParamKind {
    /// 数值参数（含 起:止:步长 网格展开需要的 min/max/step/默认值）。
    Num {
        min: f64,
        max: f64,
        step: f64,
        def: f64,
    },
    /// 枚举参数。
    Choice { options: Vec<String>, def: String },
}

/// 单个参数描述。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParamDef {
    pub key: String,
    pub label: String,
    pub kind: ParamKind,
}

/// 一笔完整交易（开→平）的明细。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TradeDetail {
    pub open_ts: i64,
    pub close_ts: i64,
    pub open_bar: usize,
    pub close_bar: usize,
    /// 成交买入价（含滑点）。
    pub open_price: f64,
    /// 成交卖出价（含滑点）。
    pub close_price: f64,
    pub shares: f64,
    /// 卖出毛额（shares × close_price）。
    pub gross_value: f64,
    /// 总佣金（买入 + 卖出）。
    pub commission: f64,
    /// 卖出印花税。
    pub stamp_duty: f64,
    /// 净盈亏（卖出净得 − 建仓成本）。正=盈。
    pub pnl: f64,
    /// 持仓 bar 数（开仓 bar → 平仓 bar 间隔）。
    pub hold_bars: usize,
}

#[cfg(test)]
mod tests {
    use super::Period;

    /// ADR bt-3 年化折返因子表：日内周期按「A 股每日 4 小时（=240 分钟）」折算。
    /// H1 = 每年 252×4 根小时线（I-6/D3：引擎补 H1，与数据层 cagg 1h 口径对齐）。
    #[test]
    fn bars_per_year_known_factors() {
        assert_eq!(Period::M1.bars_per_year(), 252.0 * 240.0);
        assert_eq!(Period::M5.bars_per_year(), 252.0 * 48.0);
        assert_eq!(Period::M15.bars_per_year(), 252.0 * 16.0);
        assert_eq!(Period::H1.bars_per_year(), 252.0 * 4.0);
        assert_eq!(Period::D1.bars_per_year(), 252.0);
    }
}
