//! 回测 crate 的领域类型：Bar / Period / Signal / Ctx / ParamDef / Strategy trait / 输出结构。
//!
//! 口径说明（ADR 08-backtest §1-§6，已批复 6 决策按推荐）：
//! - 本 crate 定义**精简**的 `Bar`（`{ts,open,high,low,close,volume}`）与 `Period`（M1/M5/M15/D1），
//!   与 `domain::Bar`（含 code/period/amount/source 采集字段）解耦。application 层的端口适配器负责
//!   `domain::Bar -> backtest::Bar` 映射（Phase 1 本 crate 无 IO/无 DB，不依赖 domain）。
//! - `ts` 使用 Unix 秒（i64），方便纯逻辑单测；web 层负责转 datetime 展示。
//! - `Signal::Buy(fraction)` 的 `fraction` ∈ (0,1]，为在该 bar 收盘市值上用于建仓的资金比例
//!   （策略自身的 `position_pct` 参数在此体现，默认 1.0=全仓）。

use serde::{Deserialize, Serialize};

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

/// 回测周期（ADR §3；UI：1m/5m/15m/日）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Period {
    M1,
    M5,
    M15,
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
            Period::D1 => 252.0,
        }
    }
}

/// 策略信号（ADR §5）。单 bar 一信号。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Signal {
    Hold,
    /// 建仓，`fraction` 为投入当前市值比例（默认 1.0=全仓）。
    Buy(f64),
    /// 平仓（卖出全部持仓）。
    Sell,
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

/// `on_bar` 回调的上下文：当前 bar 序号/时间 + 资金/持仓快照。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ctx {
    pub bar_index: usize,
    pub ts: i64,
    /// 当前现金。
    pub cash: f64,
    /// 当前持仓数量（股）。
    pub position: f64,
    /// 当前净值（现金 + 持仓 × close）。
    pub equity: f64,
}

/// 策略目录条目（供 `GET /api/backtest/strategies` 返回策略清单 + 参数 schema）。
/// Signal 单 bar 决策由 `Strategy::on_bar` 返回；本结构描述一个**编译期注册的内置策略**。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyResult {
    pub id: String,
    pub name: String,
    pub description: String,
    pub params_schema: Vec<ParamDef>,
}

/// 策略 trait（ADR §5）。`on_bar` 每 bar 调用一次，返回 `Signal`。
pub trait Strategy: Send + Sync {
    fn id(&self) -> &str;
    fn params_schema(&self) -> Vec<ParamDef>;
    /// 每 bar：先算指标（`ind`），再调用本方法；返回的 signal 在**下一 bar open** 成交（bt-2）。
    fn on_bar(&mut self, ctx: &mut Ctx, bar: &Bar, ind: &crate::indicators::Indicators) -> Signal;
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

/// 单次回测的运行配置。
#[derive(Debug, Clone, PartialEq)]
pub struct RunConfig {
    pub initial_capital: f64,
    pub fee: crate::fee::FeeModel,
    pub period: Period,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            initial_capital: 100_000.0,
            fee: crate::fee::FeeModel::default(),
            period: Period::D1,
        }
    }
}

/// 回测结果：净值/回撤序列 + 交易明细 + 绩效指标。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BacktestResult {
    /// `(ts, equity)` 每 bar 收盘净值（期末强制平仓后反映到最后一个点）。
    pub net_value_series: Vec<(i64, f64)>,
    /// `(ts, drawdown)` 每 bar 回撤（0.0 = 峰值，>0 为从峰值回落比例）。
    pub drawdown_series: Vec<(i64, f64)>,
    pub trades: Vec<TradeDetail>,
    pub metrics: crate::metrics::BacktestMetrics,
}
