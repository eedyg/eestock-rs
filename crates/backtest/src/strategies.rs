//! 内建策略（ADR §5）。Phase 1 落地第 1 款「双均线交叉」；Phase 2 补全其余 6 款并改为**编译期注册表**。
//!
//! 权威名单（ADR §5，7 款，`builtinStrategyCount: 7`）：双均线 / 均线+RSI / MACD / BOLL / KDJ / 动量 / ATR 通道。
//!
//! 本模块同时提供 4 个公开入口（父级 2026-xx 批复）：
//! - [`builtin_strategies`] → **运行时实例** `Vec<Box<dyn Strategy>>`（恰好 7 款、默认参数、固定顺序；供引擎 `Engine::run` 使用）。
//! - [`builtin_strategy_catalog`] → **UI 目录** `Vec<StrategyResult>`（id/name/description/params_schema；供 `GET /api/backtest/strategies` 下拉渲染）。
//! - [`create_strategy`] → **运行时工厂**（按 `id` + 参数构造成实例；参数网格展开时由它构建每格实例）。
//! - [`builtin_strategy_ids`] → id 清单（恰好 7、唯一）。
//!
//! catalog 的 id 与 runtime 的 id 一一对应、顺序一致（7×7）；两者 `params_schema()` 一致。
//!
//! 少数 ADR 未明确的口径（按推荐实现并在此注明，供父级确认）：
//! - **BOLL `mode`**：`mean_reversion`（收破下轨 Buy / 回中轨上方 Sell，均值回归）为默认；`trend`（收破上轨 Buy / 下破下轨 Sell，突破/趋势）仍为可选。以 band 交叉（`prev_close` 相对当前 band）判定一次信号。
//! - **动量突破 / ATR 通道**的 Donchian 上/下轨：取**当前 bar 之前** `lookback/channel_period` 根 bar 的最高 high / 最低 low（不含当前 bar，避免 close 恒 ≤ 当前 high 造成的自破位）；无新增指标，各策略自持固定长度滚动窗口，故不改 `indicators.rs`。
//! - **ATR 止损**：持仓时若 `close < entry − atr_multiplier × ATR` 则触发 Sell；`entry` 取 Buy 信号当根 close（近似，实际成交在下一 open）。
//! - **均线+RSI**：金叉（快线>慢线）且 `RSI < 超买线` 才 Buy；死叉且 `RSI > 超卖线` 才 Sell；RSI 数据不足时按通过处理（`map_or(true,...)`）。
//!
//! 所有策略测试均为**手工构造固定 bar 序列 + 显式固定参数**，无 RNG / 无时间依赖 / 无实时数据，可完全复现。

use std::collections::{HashMap, VecDeque};

use crate::indicators::Indicators;
use crate::types::{Bar, Ctx, ParamDef, ParamKind, Signal, Strategy, StrategyResult};

// ---------------------------------------------------------------------------
// 运行时参数（自包含，供 create_strategy 构造实例；与 ParamKind 对应，无第三方依赖）
// ---------------------------------------------------------------------------

/// 运行时策略参数值：数值参数用 `Num(f64)`；枚举参数用 `Choice(String)`（对应 `ParamKind::Choice.options` 之一）。
#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Num(f64),
    Choice(String),
}

/// `create_strategy(id, params)` 的参数集合（key 与 `params_schema()` 的 `ParamDef.key` 对应）。
pub type StrategyParams = HashMap<String, ParamValue>;

fn get_num(params: &StrategyParams, key: &str, def: f64) -> f64 {
    match params.get(key) {
        Some(ParamValue::Num(v)) => *v,
        _ => def,
    }
}

fn get_choice(params: &StrategyParams, key: &str, def: &str) -> String {
    match params.get(key) {
        Some(ParamValue::Choice(v)) => v.clone(),
        _ => def.to_string(),
    }
}

// ---------------------------------------------------------------------------
// 1. 双均线交叉（Phase 1 已有，保留）
// ---------------------------------------------------------------------------

/// 双均线交叉：快/慢均线金叉买、死叉卖（ADR §5 第 1 款）。
#[derive(Debug, Clone)]
pub struct DualMaStrategy {
    fast: usize,
    slow: usize,
    position_pct: f64,
    prev_above: Option<bool>,
}

impl DualMaStrategy {
    pub fn new(fast: usize, slow: usize, position_pct: f64) -> Self {
        Self {
            fast,
            slow,
            position_pct,
            prev_above: None,
        }
    }
}

impl Strategy for DualMaStrategy {
    fn id(&self) -> &str {
        "dual_ma"
    }

    fn params_schema(&self) -> Vec<ParamDef> {
        vec![
            ParamDef {
                key: "fast".into(),
                label: "快线".into(),
                kind: ParamKind::Num { min: 2.0, max: 200.0, step: 1.0, def: 5.0 },
            },
            ParamDef {
                key: "slow".into(),
                label: "慢线".into(),
                kind: ParamKind::Num { min: 2.0, max: 250.0, step: 1.0, def: 20.0 },
            },
            ParamDef {
                key: "position_pct".into(),
                label: "仓位比例".into(),
                kind: ParamKind::Num { min: 0.0, max: 1.0, step: 0.05, def: 1.0 },
            },
        ]
    }

    fn on_bar(&mut self, _ctx: &mut Ctx, _bar: &Bar, ind: &Indicators) -> Signal {
        let f = ind.ma(self.fast);
        let s = ind.ma(self.slow);
        if let (Some(f), Some(s)) = (f, s) {
            let above = f > s;
            let sig = match self.prev_above {
                Some(prev) if above && !prev => Signal::Buy(self.position_pct),
                Some(prev) if !above && prev => Signal::Sell,
                _ => Signal::Hold,
            };
            self.prev_above = Some(above);
            sig
        } else {
            Signal::Hold
        }
    }
}

// ---------------------------------------------------------------------------
// 2. 均线 + RSI 过滤
// ---------------------------------------------------------------------------

/// 均线+RSI 过滤：均线交叉定方向 + RSI 超买(>超买线)/超卖(<超卖线)过滤（方向正确才开仓）。
#[derive(Debug, Clone)]
pub struct MaRsiStrategy {
    fast: usize,
    slow: usize,
    rsi_period: usize,
    rsi_overbought: f64,
    rsi_oversold: f64,
    position_pct: f64,
    prev_above: Option<bool>,
}

impl MaRsiStrategy {
    pub fn new(fast: usize, slow: usize, rsi_period: usize, rsi_overbought: f64, rsi_oversold: f64, position_pct: f64) -> Self {
        Self {
            fast,
            slow,
            rsi_period,
            rsi_overbought,
            rsi_oversold,
            position_pct,
            prev_above: None,
        }
    }
}

impl Strategy for MaRsiStrategy {
    fn id(&self) -> &str {
        "ma_rsi"
    }

    fn params_schema(&self) -> Vec<ParamDef> {
        vec![
            ParamDef {
                key: "fast".into(),
                label: "快线".into(),
                kind: ParamKind::Num { min: 2.0, max: 200.0, step: 1.0, def: 5.0 },
            },
            ParamDef {
                key: "slow".into(),
                label: "慢线".into(),
                kind: ParamKind::Num { min: 2.0, max: 250.0, step: 1.0, def: 20.0 },
            },
            ParamDef {
                key: "rsi_period".into(),
                label: "RSI 周期".into(),
                kind: ParamKind::Num { min: 2.0, max: 60.0, step: 1.0, def: 14.0 },
            },
            ParamDef {
                key: "rsi_oversold".into(),
                label: "RSI 超卖线".into(),
                kind: ParamKind::Num { min: 10.0, max: 50.0, step: 1.0, def: 30.0 },
            },
            ParamDef {
                key: "rsi_overbought".into(),
                label: "RSI 超买线".into(),
                kind: ParamKind::Num { min: 50.0, max: 90.0, step: 1.0, def: 70.0 },
            },
            ParamDef {
                key: "position_pct".into(),
                label: "仓位比例".into(),
                kind: ParamKind::Num { min: 0.0, max: 1.0, step: 0.05, def: 1.0 },
            },
        ]
    }

    fn on_bar(&mut self, _ctx: &mut Ctx, _bar: &Bar, ind: &Indicators) -> Signal {
        let f = ind.ma(self.fast);
        let s = ind.ma(self.slow);
        let rsi = ind.rsi(self.rsi_period);
        if let (Some(f), Some(s)) = (f, s) {
            let above = f > s;
            let mut sig = Signal::Hold;
            if let Some(prev) = self.prev_above {
                if above && !prev {
                    // 金叉：方向正确（多头），且 RSI 未进入超买 → 开仓
                    if rsi.is_none_or(|r| r < self.rsi_overbought) {
                        sig = Signal::Buy(self.position_pct);
                    }
                } else if !above && prev {
                    // 死叉：方向转空，且 RSI 未进入超卖 → 平仓
                    if rsi.is_none_or(|r| r > self.rsi_oversold) {
                        sig = Signal::Sell;
                    }
                }
            }
            self.prev_above = Some(above);
            sig
        } else {
            Signal::Hold
        }
    }
}

// ---------------------------------------------------------------------------
// 3. MACD 金叉/死叉
// ---------------------------------------------------------------------------

/// MACD 金叉/死叉：DIF 上穿 DEA 金叉 Buy、下穿死叉 Sell。
#[derive(Debug, Clone)]
pub struct MacdStrategy {
    fast: usize,
    slow: usize,
    signal: usize,
    position_pct: f64,
    prev_dif_gt_dea: Option<bool>,
}

impl MacdStrategy {
    pub fn new(fast: usize, slow: usize, signal: usize, position_pct: f64) -> Self {
        Self {
            fast,
            slow,
            signal,
            position_pct,
            prev_dif_gt_dea: None,
        }
    }
}

impl Strategy for MacdStrategy {
    fn id(&self) -> &str {
        "macd"
    }

    fn params_schema(&self) -> Vec<ParamDef> {
        vec![
            ParamDef {
                key: "fast".into(),
                label: "快线 EMA".into(),
                kind: ParamKind::Num { min: 2.0, max: 100.0, step: 1.0, def: 12.0 },
            },
            ParamDef {
                key: "slow".into(),
                label: "慢线 EMA".into(),
                kind: ParamKind::Num { min: 2.0, max: 200.0, step: 1.0, def: 26.0 },
            },
            ParamDef {
                key: "signal".into(),
                label: "信号线".into(),
                kind: ParamKind::Num { min: 2.0, max: 100.0, step: 1.0, def: 9.0 },
            },
            ParamDef {
                key: "position_pct".into(),
                label: "仓位比例".into(),
                kind: ParamKind::Num { min: 0.0, max: 1.0, step: 0.05, def: 1.0 },
            },
        ]
    }

    fn on_bar(&mut self, _ctx: &mut Ctx, _bar: &Bar, ind: &Indicators) -> Signal {
        if let Some(m) = ind.macd(self.fast, self.slow, self.signal) {
            let gt = m.dif > m.dea;
            let mut sig = Signal::Hold;
            if let Some(prev) = self.prev_dif_gt_dea {
                if gt && !prev {
                    sig = Signal::Buy(self.position_pct);
                } else if !gt && prev {
                    sig = Signal::Sell;
                }
            }
            self.prev_dif_gt_dea = Some(gt);
            sig
        } else {
            Signal::Hold
        }
    }
}

// ---------------------------------------------------------------------------
// 4. BOLL 带突破
// ---------------------------------------------------------------------------

/// BOLL 带突破：收破上轨/下轨触发 Buy/Sell；`mode` 选择均值回归(`mean_reversion` 默认)或趋势(`trend`)。
#[derive(Debug, Clone)]
pub struct BollStrategy {
    period: usize,
    k: f64,
    mode: String,
    position_pct: f64,
    prev_close: Option<f64>,
}

impl BollStrategy {
    pub fn new(period: usize, k: f64, mode: &str, position_pct: f64) -> Self {
        Self {
            period,
            k,
            mode: mode.to_string(),
            position_pct,
            prev_close: None,
        }
    }
}

impl Strategy for BollStrategy {
    fn id(&self) -> &str {
        "boll"
    }

    fn params_schema(&self) -> Vec<ParamDef> {
        vec![
            ParamDef {
                key: "period".into(),
                label: "周期".into(),
                kind: ParamKind::Num { min: 2.0, max: 200.0, step: 1.0, def: 20.0 },
            },
            ParamDef {
                key: "k".into(),
                label: "标准差倍数".into(),
                kind: ParamKind::Num { min: 0.5, max: 4.0, step: 0.1, def: 2.0 },
            },
            ParamDef {
                key: "mode".into(),
                label: "模式".into(),
                kind: ParamKind::Choice {
                    options: vec!["mean_reversion".into(), "trend".into()],
                    def: "mean_reversion".into(),
                },
            },
            ParamDef {
                key: "position_pct".into(),
                label: "仓位比例".into(),
                kind: ParamKind::Num { min: 0.0, max: 1.0, step: 0.05, def: 1.0 },
            },
        ]
    }

    fn on_bar(&mut self, _ctx: &mut Ctx, bar: &Bar, ind: &Indicators) -> Signal {
        // 无条件记录 prev_close，确保 band 首次可用时能检测到「越过 band」的一次性信号。
        let mut sig = Signal::Hold;
        if let Some(b) = ind.boll(self.period, self.k) {
            let close = bar.close;
            let crossed_up = self.prev_close.is_some_and(|pc| pc <= b.upper) && close > b.upper;
            let crossed_down = self.prev_close.is_some_and(|pc| pc >= b.lower) && close < b.lower;
            if self.mode == "mean_reversion" {
                if crossed_down {
                    sig = Signal::Buy(self.position_pct);
                } else if crossed_up {
                    sig = Signal::Sell;
                }
            } else {
                if crossed_up {
                    sig = Signal::Buy(self.position_pct);
                } else if crossed_down {
                    sig = Signal::Sell;
                }
            }
        }
        self.prev_close = Some(bar.close);
        sig
    }
}

// ---------------------------------------------------------------------------
// 5. KDJ 金叉/死叉
// ---------------------------------------------------------------------------

/// KDJ 金叉/死叉：K 上穿 D 金叉 Buy、下穿死叉 Sell。
#[derive(Debug, Clone)]
pub struct KdjStrategy {
    n: usize,
    k_period: usize,
    d_period: usize,
    position_pct: f64,
    prev_k_gt_d: Option<bool>,
}

impl KdjStrategy {
    pub fn new(n: usize, k_period: usize, d_period: usize, position_pct: f64) -> Self {
        Self {
            n,
            k_period,
            d_period,
            position_pct,
            prev_k_gt_d: None,
        }
    }
}

impl Strategy for KdjStrategy {
    fn id(&self) -> &str {
        "kdj"
    }

    fn params_schema(&self) -> Vec<ParamDef> {
        vec![
            ParamDef {
                key: "n".into(),
                label: "RSV 周期".into(),
                kind: ParamKind::Num { min: 2.0, max: 100.0, step: 1.0, def: 9.0 },
            },
            ParamDef {
                key: "k_period".into(),
                label: "K 平滑".into(),
                kind: ParamKind::Num { min: 2.0, max: 30.0, step: 1.0, def: 3.0 },
            },
            ParamDef {
                key: "d_period".into(),
                label: "D 平滑".into(),
                kind: ParamKind::Num { min: 2.0, max: 30.0, step: 1.0, def: 3.0 },
            },
            ParamDef {
                key: "position_pct".into(),
                label: "仓位比例".into(),
                kind: ParamKind::Num { min: 0.0, max: 1.0, step: 0.05, def: 1.0 },
            },
        ]
    }

    fn on_bar(&mut self, _ctx: &mut Ctx, _bar: &Bar, ind: &Indicators) -> Signal {
        if let Some(kd) = ind.kdj(self.n, self.k_period, self.d_period) {
            let gt = kd.k > kd.d;
            let mut sig = Signal::Hold;
            if let Some(prev) = self.prev_k_gt_d {
                if gt && !prev {
                    sig = Signal::Buy(self.position_pct);
                } else if !gt && prev {
                    sig = Signal::Sell;
                }
            }
            self.prev_k_gt_d = Some(gt);
            sig
        } else {
            Signal::Hold
        }
    }
}

// ---------------------------------------------------------------------------
// 6. 动量突破
// ---------------------------------------------------------------------------

/// 动量突破：close 突破 N 日最高 high → Buy；跌破 N 日最低 low → Sell（`lookback` 参数）。
/// Donchian 上/下轨取「当前 bar 之前」`lookback` 根 bar 的最高 high / 最低 low（不含当前 bar）。
#[derive(Debug, Clone)]
pub struct MomentumStrategy {
    lookback: usize,
    position_pct: f64,
    highs: VecDeque<f64>,
    lows: VecDeque<f64>,
}

impl MomentumStrategy {
    pub fn new(lookback: usize, position_pct: f64) -> Self {
        Self {
            lookback,
            position_pct,
            highs: VecDeque::with_capacity(lookback + 1),
            lows: VecDeque::with_capacity(lookback + 1),
        }
    }
}

impl Strategy for MomentumStrategy {
    fn id(&self) -> &str {
        "momentum"
    }

    fn params_schema(&self) -> Vec<ParamDef> {
        vec![
            ParamDef {
                key: "lookback".into(),
                label: "回看日数".into(),
                kind: ParamKind::Num { min: 2.0, max: 150.0, step: 1.0, def: 20.0 },
            },
            ParamDef {
                key: "position_pct".into(),
                label: "仓位比例".into(),
                kind: ParamKind::Num { min: 0.0, max: 1.0, step: 0.05, def: 1.0 },
            },
        ]
    }

    fn on_bar(&mut self, _ctx: &mut Ctx, bar: &Bar, _ind: &Indicators) -> Signal {
        let mut sig = Signal::Hold;
        if self.highs.len() == self.lookback {
            let highest = self.highs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let lowest = self.lows.iter().copied().fold(f64::INFINITY, f64::min);
            if bar.close > highest {
                sig = Signal::Buy(self.position_pct);
            } else if bar.close < lowest {
                sig = Signal::Sell;
            }
        }
        self.highs.push_back(bar.high);
        self.lows.push_back(bar.low);
        if self.highs.len() > self.lookback {
            self.highs.pop_front();
        }
        if self.lows.len() > self.lookback {
            self.lows.pop_front();
        }
        sig
    }
}

// ---------------------------------------------------------------------------
// 7. ATR 通道突破
// ---------------------------------------------------------------------------

/// ATR 通道突破：Donchian 上/下轨（`channel_period`）突破 Buy/Sell，持仓时以 ATR 止损（`close < entry − atr_multiplier×ATR`）。
#[derive(Debug, Clone)]
pub struct AtrChannelStrategy {
    channel_period: usize,
    atr_period: usize,
    atr_multiplier: f64,
    position_pct: f64,
    highs: VecDeque<f64>,
    lows: VecDeque<f64>,
    entry: Option<f64>,
}

impl AtrChannelStrategy {
    pub fn new(channel_period: usize, atr_period: usize, atr_multiplier: f64, position_pct: f64) -> Self {
        Self {
            channel_period,
            atr_period,
            atr_multiplier,
            position_pct,
            highs: VecDeque::with_capacity(channel_period + 1),
            lows: VecDeque::with_capacity(channel_period + 1),
            entry: None,
        }
    }
}

impl Strategy for AtrChannelStrategy {
    fn id(&self) -> &str {
        "atr_channel"
    }

    fn params_schema(&self) -> Vec<ParamDef> {
        vec![
            ParamDef {
                key: "channel_period".into(),
                label: "通道周期".into(),
                kind: ParamKind::Num { min: 2.0, max: 150.0, step: 1.0, def: 20.0 },
            },
            ParamDef {
                key: "atr_period".into(),
                label: "ATR 周期".into(),
                kind: ParamKind::Num { min: 2.0, max: 60.0, step: 1.0, def: 14.0 },
            },
            ParamDef {
                key: "atr_multiplier".into(),
                label: "ATR 止损倍数".into(),
                kind: ParamKind::Num { min: 0.5, max: 5.0, step: 0.5, def: 1.0 },
            },
            ParamDef {
                key: "position_pct".into(),
                label: "仓位比例".into(),
                kind: ParamKind::Num { min: 0.0, max: 1.0, step: 0.05, def: 1.0 },
            },
        ]
    }

    fn on_bar(&mut self, ctx: &mut Ctx, bar: &Bar, ind: &Indicators) -> Signal {
        let mut sig = Signal::Hold;

        // Donchian 上/下轨：当前 bar 之前 channel_period 根 bar 的最高 high / 最低 low。
        let channel_ready = self.highs.len() == self.channel_period;
        let upper = if channel_ready {
            self.highs.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        } else {
            f64::NEG_INFINITY
        };
        let lower = if channel_ready {
            self.lows.iter().copied().fold(f64::INFINITY, f64::min)
        } else {
            f64::INFINITY
        };

        let holding = ctx.position > 0.0;
        if holding {
            // ATR 止损优先
            if let (Some(a), Some(entry)) = (ind.atr(self.atr_period), self.entry) {
                if bar.close < entry - self.atr_multiplier * a {
                    self.entry = None;
                    sig = Signal::Sell;
                }
            }
            // 通道下轨跌破 → 平仓
            if sig == Signal::Hold && channel_ready && bar.close < lower {
                self.entry = None;
                sig = Signal::Sell;
            }
        } else {
            if channel_ready && bar.close > upper {
                self.entry = Some(bar.close);
                sig = Signal::Buy(self.position_pct);
            }
        }

        // 更新滚动窗口（供下一根 bar 的通道计算）。
        self.highs.push_back(bar.high);
        self.lows.push_back(bar.low);
        if self.highs.len() > self.channel_period {
            self.highs.pop_front();
        }
        if self.lows.len() > self.channel_period {
            self.lows.pop_front();
        }
        sig
    }
}

// ---------------------------------------------------------------------------
// 编译期注册表
// ---------------------------------------------------------------------------

/// 内建策略清单（ADR §5 名单，顺序固定：与 `builtin_strategies`/`builtin_strategy_catalog` 一致）。
const BUILTIN_ORDER: [&str; 7] = ["dual_ma", "ma_rsi", "macd", "boll", "kdj", "momentum", "atr_channel"];

/// 返回每个 id 的 `(名称, 描述)`（供 UI 目录渲染）。
fn name_description(id: &str) -> (&'static str, &'static str) {
    match id {
        "dual_ma" => ("双均线交叉", "快/慢均线金叉买入、死叉卖出"),
        "ma_rsi" => ("均线+RSI 过滤", "均线交叉定方向 + RSI 超买/超卖过滤（方向正确才开仓）"),
        "macd" => ("MACD 金叉/死叉", "DIF 上穿 DEA 金叉买入、下穿死叉卖出"),
        "boll" => ("BOLL 带突破", "收破上轨买/下破下轨卖（趋势或均值回归，mode 参数）"),
        "kdj" => ("KDJ 金叉/死叉", "K 上穿 D 金叉买入、下穿死叉卖出"),
        "momentum" => ("动量突破", "close 突破 N 日高点买入、跌破 N 日低点卖出"),
        "atr_channel" => ("ATR 通道突破", "Donchian 通道突破买卖 + ATR 止损"),
        _ => ("", ""),
    }
}

/// 运行时工厂：按 `id` + 参数构造实例；参数缺省时用 `params_schema()` 的默认值。未知 id 返回 `None`。
pub fn create_strategy(id: &str, params: &StrategyParams) -> Option<Box<dyn Strategy>> {
    match id {
        "dual_ma" => Some(Box::new(DualMaStrategy::new(
            get_num(params, "fast", 5.0) as usize,
            get_num(params, "slow", 20.0) as usize,
            get_num(params, "position_pct", 1.0),
        ))),
        "ma_rsi" => Some(Box::new(MaRsiStrategy::new(
            get_num(params, "fast", 5.0) as usize,
            get_num(params, "slow", 20.0) as usize,
            get_num(params, "rsi_period", 14.0) as usize,
            get_num(params, "rsi_overbought", 70.0),
            get_num(params, "rsi_oversold", 30.0),
            get_num(params, "position_pct", 1.0),
        ))),
        "macd" => Some(Box::new(MacdStrategy::new(
            get_num(params, "fast", 12.0) as usize,
            get_num(params, "slow", 26.0) as usize,
            get_num(params, "signal", 9.0) as usize,
            get_num(params, "position_pct", 1.0),
        ))),
        "boll" => Some(Box::new(BollStrategy::new(
            get_num(params, "period", 20.0) as usize,
            get_num(params, "k", 2.0),
            &get_choice(params, "mode", "mean_reversion"),
            get_num(params, "position_pct", 1.0),
        ))),
        "kdj" => Some(Box::new(KdjStrategy::new(
            get_num(params, "n", 9.0) as usize,
            get_num(params, "k_period", 3.0) as usize,
            get_num(params, "d_period", 3.0) as usize,
            get_num(params, "position_pct", 1.0),
        ))),
        "momentum" => Some(Box::new(MomentumStrategy::new(
            get_num(params, "lookback", 20.0) as usize,
            get_num(params, "position_pct", 1.0),
        ))),
        "atr_channel" => Some(Box::new(AtrChannelStrategy::new(
            get_num(params, "channel_period", 20.0) as usize,
            get_num(params, "atr_period", 14.0) as usize,
            get_num(params, "atr_multiplier", 1.0),
            get_num(params, "position_pct", 1.0),
        ))),
        _ => None,
    }
}

/// 默认参数构造（等价于 `create_strategy(id, &empty_params)`）。
fn default_instance(id: &str) -> Option<Box<dyn Strategy>> {
    create_strategy(id, &StrategyParams::new())
}

/// 运行时实例列表：恰好 7 款、默认参数、固定顺序（与 [`builtin_strategy_catalog`] 的 id 一一对应）。
pub fn builtin_strategies() -> Vec<Box<dyn Strategy>> {
    BUILTIN_ORDER
        .iter()
        .filter_map(|id| default_instance(id))
        .collect()
}

/// UI 目录列表：id/name/description/params_schema（供 `GET /api/backtest/strategies` 渲染下拉 + 参数表单）。
pub fn builtin_strategy_catalog() -> Vec<StrategyResult> {
    BUILTIN_ORDER
        .iter()
        .filter_map(|id| {
            let inst = default_instance(id)?;
            Some(StrategyResult {
                id: inst.id().to_string(),
                name: name_description(id).0.to_string(),
                description: name_description(id).1.to_string(),
                params_schema: inst.params_schema(),
            })
        })
        .collect()
}

/// id 清单：恰好 7、唯一、顺序固定。
pub fn builtin_strategy_ids() -> Vec<&'static str> {
    BUILTIN_ORDER.to_vec()
}

// ---------------------------------------------------------------------------
// 单测：手工构造固定 bar 序列 + 显式固定参数，无随机/时间依赖，完全可复现。
// 每个策略先用固定序列断言 Buy/Sell/Hold 信号，再断言参数(阈值/mode)生效。
// 最后做注册表测试（7 款、id 唯一、schema 非空、catalog 与 runtime 一一对应）。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    fn bar(ts: i64, open: f64, high: f64, low: f64, close: f64) -> Bar {
        Bar { ts, open, high, low, close, volume: 10_000.0 }
    }

    fn ctx(i: usize, ts: i64) -> Ctx {
        Ctx { bar_index: i, ts, cash: 100_000.0, position: 0.0, equity: 100_000.0 }
    }

    fn pos_ctx(i: usize, ts: i64, position: f64) -> Ctx {
        Ctx { bar_index: i, ts, cash: 0.0, position, equity: 100_000.0 }
    }

    /// 对一条策略跑固定序列，返回每 bar 的 `(ctx, signal)`。
    fn run_signals(
        strat: &mut dyn Strategy,
        bars: &[Bar],
        positions: &[f64],
    ) -> Vec<(usize, Signal)> {
        let mut out = Vec::new();
        for (i, b) in bars.iter().enumerate() {
            let ind = Indicators::new(bars, i);
            let mut c = if positions.is_empty() || positions[i] == 0.0 {
                ctx(i, b.ts)
            } else {
                pos_ctx(i, b.ts, positions[i])
            };
            let sig = strat.on_bar(&mut c, b, &ind);
            out.push((i, sig));
        }
        out
    }

    fn nums(pairs: &[(&str, f64)]) -> HashMap<String, ParamValue> {
        pairs.iter().map(|(k, v)| (k.to_string(), ParamValue::Num(*v))).collect()
    }

    // ---- DualMa（保留，回归确认逻辑不因注册表改动而变化） ----
    #[test]
    fn dual_ma_signals() {
        // 序列：先跌(10→8)再涨(9→11)，快线(2)在慢线(3)上方金叉。
        let bars = vec![
            bar(0, 10.0, 10.0, 10.0, 10.0),
            bar(1, 8.0, 8.0, 8.0, 8.0),
            bar(2, 9.0, 9.0, 9.0, 9.0),
            bar(3, 11.0, 11.0, 11.0, 11.0),
        ];
        let mut s = DualMaStrategy::new(2, 3, 0.5);
        let sigs = run_signals(&mut s, &bars, &[]);
        // index2: ma(2)=8.5 < ma(3)=9.0（below）；index3: ma(2)=10.0 > ma(3)=9.333（金叉）→ Buy(0.5)
        assert!(matches!(sigs[3].1, Signal::Buy(f) if (f - 0.5).abs() < 1e-9), "快线上穿慢线应在 index3 金叉 Buy");
    }

    // ---- 均线 + RSI ----
    #[test]
    fn ma_rsi_golden_cross_filter() {
        // 序列先跌(10→6)再大反弹(8→14)：index3 快线(2)上穿慢线(3)金叉。
        let bars = vec![
            bar(0, 10.0, 10.0, 10.0, 10.0),
            bar(1, 6.0, 6.0, 6.0, 6.0),
            bar(2, 8.0, 8.0, 8.0, 8.0),
            bar(3, 14.0, 14.0, 14.0, 14.0),
        ];
        // index3 RSI(2) ≈ 77.8（超买）。默认超买 70 → 过滤金叉 → Hold。
        let mut s = MaRsiStrategy::new(2, 3, 2, 70.0, 30.0, 0.5);
        let sigs = run_signals(&mut s, &bars, &[]);
        assert!(matches!(sigs[3].1, Signal::Hold), "RSI 超买应过滤金叉（index3）");

        // 放宽超买阈值到 110 → 金叉不过滤 → Buy(0.5)
        let mut s2 = MaRsiStrategy::new(2, 3, 2, 110.0, 30.0, 0.5);
        let sigs2 = run_signals(&mut s2, &bars, &[]);
        assert!(matches!(sigs2[3].1, Signal::Buy(f) if (f - 0.5).abs() < 1e-9), "放宽超买阈值后金叉应 Buy");
    }

    #[test]
    fn ma_rsi_oversold_blocks_death_cross_sell() {
        // 序列先涨(8→12)再回落(11→7)：index4 快线(2)下穿慢线(3)死叉。
        let bars = vec![
            bar(0, 8.0, 8.0, 8.0, 8.0),
            bar(1, 10.0, 10.0, 10.0, 10.0),
            bar(2, 12.0, 12.0, 12.0, 12.0),
            bar(3, 11.0, 11.0, 11.0, 11.0),
            bar(4, 7.0, 7.0, 7.0, 7.0),
        ];
        // index4 RSI(2) ≈ 18.2（超卖）。默认超卖 30 → 过滤死叉 → Hold。
        let mut s = MaRsiStrategy::new(2, 3, 2, 70.0, 30.0, 1.0);
        let sigs = run_signals(&mut s, &bars, &[]);
        assert!(matches!(sigs[4].1, Signal::Hold), "超卖应过滤死叉 Sell（index4）");

        // 超卖阈值压到 -1 → 死叉不过滤 → Sell
        let mut s2 = MaRsiStrategy::new(2, 3, 2, 70.0, -1.0, 1.0);
        let sigs2 = run_signals(&mut s2, &bars, &[]);
        assert!(matches!(sigs2[4].1, Signal::Sell), "放宽超卖阈值后死叉应 Sell");
    }

    // ---- 通用交叉一致性：根据指标推导（dif-dea / k-d）的 Buy/Sell/Hold 应与策略输出一致 ----
    fn assert_cross_consistency(
        strategy: &mut dyn Strategy,
        bars: &[Bar],
        compute: impl Fn(&Indicators) -> f64,
        fraction: f64,
        label: &str,
    ) -> Vec<usize> {
        let mut prev: Option<bool> = None;
        let mut cross_bars = Vec::new();
        for (i, b) in bars.iter().enumerate() {
            let ind = Indicators::new(bars, i);
            let v = compute(&ind);
            let gt = v > 0.0;
            let expected = match prev {
                Some(p) if gt && !p => Signal::Buy(fraction),
                Some(p) if !gt && p => Signal::Sell,
                _ => Signal::Hold,
            };
            prev = Some(gt);
            let mut c = ctx(i, b.ts);
            let got = strategy.on_bar(&mut c, b, &ind);
            assert!(
                matches!(got, Signal::Buy(f) if (f - fraction).abs() < 1e-9)
                    || matches!(got, Signal::Sell)
                    || matches!(got, Signal::Hold),
                "{label} i={i}: 信号非 Buy/Sell/Hold"
            );
            // 与指标推导的交叉信号一致（都应在交叉 bar 触发，且非交叉 bar 为 Hold）。
            assert_eq!(matches!(got, Signal::Buy(_)), matches!(expected, Signal::Buy(_)), "{label} i={i} buy 不一致");
            assert_eq!(matches!(got, Signal::Sell), matches!(expected, Signal::Sell), "{label} i={i} sell 不一致");
            if !matches!(expected, Signal::Hold) {
                cross_bars.push(i);
            }
        }
        cross_bars
    }

    // ---- MACD ----
    #[test]
    fn macd_golden_death_cross() {
        let bars = vec![
            bar(100, 10.0, 10.5, 9.5, 10.0),
            bar(101, 11.0, 11.5, 10.5, 11.0),
            bar(102, 12.0, 12.5, 11.5, 12.0),
            bar(103, 11.0, 11.5, 10.4, 11.0),
            bar(104, 13.0, 13.5, 12.5, 13.0),
            bar(105, 14.0, 14.5, 13.5, 14.0),
        ];
        let mut s = MacdStrategy::new(2, 3, 3, 0.5);
        let cross = assert_cross_consistency(
            &mut s,
            &bars,
            |ind| ind.macd(2, 3, 3).map(|m| m.dif - m.dea).unwrap_or(0.0),
            0.5,
            "macd",
        );
        // 该固定序列应同时出现一次金叉 Buy 与一次死叉 Sell。
        let mut saw_buy = false;
        let mut saw_sell = false;
        for &i in cross.iter() {
            let gt0 = Indicators::new(&bars, i).macd(2, 3, 3).map(|m| m.dif > m.dea).unwrap_or(false);
            let prev_gt = Indicators::new(&bars, i - 1).macd(2, 3, 3).map(|m| m.dif > m.dea).unwrap_or(false);
            if gt0 && !prev_gt {
                saw_buy = true;
            }
            if !gt0 && prev_gt {
                saw_sell = true;
            }
        }
        assert!(saw_buy && saw_sell, "MACD 固定序列应同时有金叉 Buy 与死叉 Sell");
    }

    // ---- BOLL ----
    #[test]
    fn boll_trend_mode_cross() {
        // 前 4 根稳定在 10，第 5 根大突破到 15：boll(5, k=1.5) 上轨收破。
        let bars = vec![
            bar(0, 10.0, 10.0, 10.0, 10.0),
            bar(1, 10.0, 10.0, 10.0, 10.0),
            bar(2, 10.0, 10.0, 10.0, 10.0),
            bar(3, 10.0, 10.0, 10.0, 10.0),
            bar(4, 15.0, 15.0, 15.0, 15.0),
        ];
        let mut s = BollStrategy::new(5, 1.5, "trend", 0.5);
        let sigs = run_signals(&mut s, &bars, &[]);
        // index4 close(15) > 上轨(11+1.5×2=14)，且 prev_close(10) ≤ 上轨 → trend Buy
        assert!(matches!(sigs[4].1, Signal::Buy(f) if (f - 0.5).abs() < 1e-9), "trend 模式收破上轨应 Buy");
    }

    #[test]
    fn boll_mean_reversion_mode_inverted() {
        // 前 4 根稳定 10，第 5 根深跌到 5：boll(5, k=1.5) 下轨收破。
        let bars = vec![
            bar(0, 10.0, 10.0, 10.0, 10.0),
            bar(1, 10.0, 10.0, 10.0, 10.0),
            bar(2, 10.0, 10.0, 10.0, 10.0),
            bar(3, 10.0, 10.0, 10.0, 10.0),
            bar(4, 5.0, 5.0, 5.0, 5.0),
        ];
        // mean_reversion：收破下轨 → Buy；trend：收破下轨 → Sell。
        let mut s = BollStrategy::new(5, 1.5, "mean_reversion", 0.5);
        let sigs = run_signals(&mut s, &bars, &[]);
        assert!(matches!(sigs[4].1, Signal::Buy(_)), "均值回归收破下轨应 Buy");

        let mut s2 = BollStrategy::new(5, 1.5, "trend", 0.5);
        let sigs2 = run_signals(&mut s2, &bars, &[]);
        assert!(matches!(sigs2[4].1, Signal::Sell), "trend 模式收破下轨应 Sell");
    }

    #[test]
    fn boll_default_mode_is_mean_reversion() {
        // 显式 period/k（默认 period=20 需更多 bar），但**不传 mode**，验证无参构造默认 mode 为 mean_reversion。
        let bars = vec![
            bar(0, 10.0, 10.0, 10.0, 10.0),
            bar(1, 10.0, 10.0, 10.0, 10.0),
            bar(2, 10.0, 10.0, 10.0, 10.0),
            bar(3, 10.0, 10.0, 10.0, 10.0),
            bar(4, 5.0, 5.0, 5.0, 5.0),
        ];
        let params = nums(&[("period", 5.0), ("k", 1.5)]); // 不传 mode
        let mut inst = create_strategy("boll", &params).unwrap();
        let sigs = run_signals(inst.as_mut(), &bars, &[]);
        assert!(
            matches!(sigs[4].1, Signal::Buy(_)),
            "默认 mode 应为 mean_reversion，收破下轨应 Buy"
        );

        // schema 默认值与 options 顺序：均值回归在前。
        let cat = builtin_strategy_catalog();
        let boll = cat.iter().find(|c| c.id == "boll").unwrap();
        let mode_def = boll.params_schema.iter().find(|p| p.key == "mode").unwrap();
        match &mode_def.kind {
            ParamKind::Choice { options, def } => {
                assert_eq!(def, "mean_reversion", "mode schema 默认值应为 mean_reversion");
                assert_eq!(
                    options,
                    &vec!["mean_reversion".to_string(), "trend".to_string()],
                    "options 应为 [mean_reversion, trend]（均值回归在前）"
                );
            }
            other => panic!("mode 应为 Choice，实际 {other:?}"),
        }
    }

    // ---- KDJ ----
    #[test]
    fn kdj_cross() {
        let bars = vec![
            bar(100, 10.0, 10.5, 9.5, 10.0),
            bar(101, 11.0, 11.5, 10.5, 11.0),
            bar(102, 12.0, 12.5, 11.5, 12.0),
            bar(103, 11.0, 11.5, 10.4, 11.0),
            bar(104, 13.0, 13.5, 12.5, 13.0),
            bar(105, 14.0, 14.5, 13.5, 14.0),
        ];
        let mut s = KdjStrategy::new(3, 2, 2, 0.5);
        // None-aware：kdj 仅在足够 bar 后可用；不可用时策略返回 Hold 且不更新 prev。
        let mut prev: Option<bool> = None;
        let mut saw_buy = false;
        let mut saw_sell = false;
        let mut got_signals = Vec::new();
        for (i, b) in bars.iter().enumerate() {
            let ind = Indicators::new(&bars, i);
            let kd = ind.kdj(3, 2, 2);
            let mut expected = Signal::Hold;
            if let Some(k) = kd {
                let gt = k.k > k.d;
                if let Some(p) = prev {
                    if gt && !p {
                        expected = Signal::Buy(0.5);
                    } else if !gt && p {
                        expected = Signal::Sell;
                    }
                }
                prev = Some(gt);
            }
            if matches!(expected, Signal::Buy(_)) {
                saw_buy = true;
            }
            if matches!(expected, Signal::Sell) {
                saw_sell = true;
            }
            let mut c = ctx(i, b.ts);
            let got = s.on_bar(&mut c, b, &ind);
            got_signals.push(got);
            assert_eq!(matches!(got, Signal::Buy(_)), matches!(expected, Signal::Buy(_)), "KDJ i={i} buy 不一致");
            assert_eq!(matches!(got, Signal::Sell), matches!(expected, Signal::Sell), "KDJ i={i} sell 不一致");
        }
        assert!(saw_buy, "KDJ 固定序列应出现一次金叉 Buy（signals={got_signals:?}）");
        assert!(saw_sell, "KDJ 固定序列应出现一次死叉 Sell（signals={got_signals:?}）");
    }

    // ---- 动量突破 ----
    #[test]
    fn momentum_breakout_buy() {
        // lookback=2：需要前 2 根 bar 作为通道；第 3 根 close 突破前 2 根最高 high。
        let bars = vec![
            bar(0, 10.0, 10.0, 9.0, 10.0),
            bar(1, 10.0, 10.0, 9.0, 10.0),
            bar(2, 12.0, 12.0, 11.0, 12.0), // close 12 > max(high)=10 → Buy
        ];
        let mut s = MomentumStrategy::new(2, 0.5);
        let sigs = run_signals(&mut s, &bars, &[]);
        assert!(matches!(sigs[2].1, Signal::Buy(_)), "close 突破前 N 日高点应 Buy");
    }

    #[test]
    fn momentum_breakout_sell_when_not_holding() {
        // 突破下轨：close 跌破前 N 日最低 low → Sell（即使无持仓也按信号发出；引擎仅在持仓时执行）。
        let bars = vec![
            bar(0, 10.0, 11.0, 9.0, 10.0),
            bar(1, 10.0, 11.0, 9.0, 10.0),
            bar(2, 8.0, 8.5, 7.5, 8.0), // close 8 < min(low)=9 → Sell
        ];
        let mut s = MomentumStrategy::new(2, 0.5);
        let sigs = run_signals(&mut s, &bars, &[]);
        assert!(matches!(sigs[2].1, Signal::Sell), "close 跌破前 N 日低点应 Sell");
    }

    // ---- ATR 通道突破 ----
    #[test]
    fn atr_channel_breakout_buy_and_stop() {
        // lookback=2 建立通道；第 3 根 close 突破上轨 → Buy（entry 记 close）。
        let bars = vec![
            bar(0, 10.0, 10.0, 9.0, 10.0),
            bar(1, 10.0, 10.0, 9.0, 10.0),
            bar(2, 12.0, 12.0, 11.0, 12.0),
            bar(3, 10.0, 10.0, 10.0, 10.0), // 持票中，close 跌破 entry−1×ATR → 触发 ATR 止损 → Sell
        ];
        // atr_period=2，atr_multiplier=1；用 ctx 已持仓模拟持票状态。
        let mut s = AtrChannelStrategy::new(2, 2, 1.0, 0.5);
        let mut sigs = Vec::new();
        let positions = [0.0, 0.0, 0.0, 100.0];
        for (i, b) in bars.iter().enumerate() {
            let ind = Indicators::new(&bars, i);
            let mut c = if positions[i] > 0.0 {
                pos_ctx(i, b.ts, positions[i])
            } else {
                ctx(i, b.ts)
            };
            let sig = s.on_bar(&mut c, b, &ind);
            sigs.push((i, sig));
        }
        // index2 close 突破上轨 → Buy
        assert!(matches!(sigs[2].1, Signal::Buy(_)), "通道突破应 Buy");
        // index3 已持仓（entry≈12.0），ATR(aperiod=2) 在 index3 计算，止损价 = 12 - 1*atr。
        // 10.7 < 12 - atr 若 atr>1.3 → Sell。
        let atr3 = Indicators::new(&bars, 3).atr(2).unwrap();
        let _ = atr3;
        assert!(matches!(sigs[3].1, Signal::Sell), "ATR 止损应 Sell");
    }

    #[test]
    fn atr_channel_breakout_sell_channel_exit() {
        let bars = vec![
            bar(0, 10.0, 10.0, 9.0, 10.0),
            bar(1, 10.0, 10.0, 9.0, 10.0),
            bar(2, 12.0, 12.0, 11.0, 12.0),
            bar(3, 8.0, 8.5, 7.5, 8.0), // 持票中跌破通道下轨 → Sell（channel exit）
        ];
        let mut s = AtrChannelStrategy::new(2, 2, 100.0, 0.5); // 超大倍数使 ATR 止损不触发
        let mut sigs = Vec::new();
        let positions = [0.0, 0.0, 0.0, 100.0];
        for (i, b) in bars.iter().enumerate() {
            let ind = Indicators::new(&bars, i);
            let mut c = if positions[i] > 0.0 {
                pos_ctx(i, b.ts, positions[i])
            } else {
                ctx(i, b.ts)
            };
            let sig = s.on_bar(&mut c, b, &ind);
            sigs.push((i, sig));
        }
        assert!(matches!(sigs[3].1, Signal::Sell), "跌破通道下轨应 Sell");
    }

    // ---- 跨策略一致性抽查（用 phase1 指标验证各策略信号与指标口径一致） ----
    #[test]
    fn cross_strategy_consistency_macd_signal_matches_dif_dea() {
        let bars = vec![
            bar(100, 10.0, 10.5, 9.5, 10.0),
            bar(101, 11.0, 11.5, 10.5, 11.0),
            bar(102, 12.0, 12.5, 11.5, 12.0),
            bar(103, 11.0, 11.5, 10.4, 11.0),
            bar(104, 13.0, 13.5, 12.5, 13.0),
            bar(105, 14.0, 14.5, 13.5, 14.0),
        ];
        // 手动跟踪 dif>dea 关系，检查交叉发生的 bar 与策略信号一致。
        let mut prev: Option<bool> = None;
        let mut s = MacdStrategy::new(2, 3, 3, 0.5);
        for (i, b) in bars.iter().enumerate() {
            let gt = Indicators::new(&bars, i).macd(2, 3, 3).map(|m| m.dif > m.dea).unwrap_or(false);
            let expected_buy = matches!(prev, Some(p) if gt && !p);
            let expected_sell = matches!(prev, Some(p) if !gt && p);
            prev = Some(gt);
            let ind = Indicators::new(&bars, i);
            let mut c = ctx(i, b.ts);
            let got = s.on_bar(&mut c, b, &ind);
            assert_eq!(matches!(got, Signal::Buy(_)), expected_buy, "i={i} MACD Buy 应与指标口径一致");
            assert_eq!(matches!(got, Signal::Sell), expected_sell, "i={i} MACD Sell 应与指标口径一致");
        }
    }

    #[test]
    fn cross_strategy_consistency_boll_band() {
        let bars = vec![
            bar(0, 10.0, 10.0, 10.0, 10.0),
            bar(1, 10.0, 10.0, 10.0, 10.0),
            bar(2, 10.0, 10.0, 10.0, 10.0),
            bar(3, 10.0, 10.0, 10.0, 10.0),
            bar(4, 15.0, 15.0, 15.0, 15.0),
        ];
        let b4 = Indicators::new(&bars, 4).boll(5, 1.5).unwrap();
        assert!(15.0 > b4.upper, "close(15) 应大于 BOLL 上轨(实际 {})", b4.upper);
        let mut s = BollStrategy::new(5, 1.5, "trend", 0.5);
        let sigs = run_signals(&mut s, &bars, &[]);
        assert!(matches!(sigs[4].1, Signal::Buy(_)));
    }

    // ---- 注册表 ----
    #[test]
    fn registry_has_7_unique_ids() {
        let ids = builtin_strategy_ids();
        assert_eq!(ids.len(), 7, "应恰有 7 款内置策略");
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            assert!(seen.insert(*id), "id {id} 重复");
        }
    }

    #[test]
    fn registry_runtime_len_7() {
        assert_eq!(builtin_strategies().len(), 7);
    }

    #[test]
    fn registry_catalog_len_7_and_schema_nonempty() {
        let cat = builtin_strategy_catalog();
        assert_eq!(cat.len(), 7);
        for c in &cat {
            assert!(!c.params_schema.is_empty(), "策略 {} schema 不应为空", c.id);
            assert!(!c.name.is_empty());
            assert!(!c.description.is_empty());
        }
    }

    #[test]
    fn registry_catalog_matches_runtime_order_and_ids() {
        let cat = builtin_strategy_catalog();
        let rt = builtin_strategies();
        assert_eq!(cat.len(), rt.len());
        for (c, r) in cat.iter().zip(rt.iter()) {
            assert_eq!(c.id, r.id(), "catalog.id 与 runtime.id 应一致");
            assert_eq!(c.params_schema.len(), r.params_schema().len(), "schema 长度应一致");
        }
    }

    #[test]
    fn registry_create_strategy_defaults_ok_for_all() {
        // 每个 id 都能用空参数（默认值）创建实例，且 id 正确、schema 非空、与目录一致。
        let cat = builtin_strategy_catalog();
        let cat_schema = || cat.iter().map(|c| (c.id.clone(), c.params_schema.len())).collect::<HashMap<_, _>>();
        for id in builtin_strategy_ids() {
            let inst = create_strategy(id, &StrategyParams::new());
            assert!(inst.is_some(), "create_strategy({id}) 应返回 Some");
            let inst = inst.unwrap();
            assert_eq!(inst.id(), id);
            let schema_len = inst.params_schema().len();
            assert!(schema_len > 0, "策略 {id} schema 不应为空");
            assert_eq!(schema_len, cat_schema()[id], "{id} 运行实例 schema 长度应与目录一致");
        }
    }

    #[test]
    fn registry_create_strategy_unknown_id_returns_none() {
        assert!(create_strategy("not_a_strategy", &StrategyParams::new()).is_none());
    }

    #[test]
    fn registry_create_strategy_params_override_defaults() {
        // 用显式参数覆盖默认并验证实例 schema/信号。
        let p = nums(&[("lookback", 3.0), ("position_pct", 0.25)]);
        let mut inst = create_strategy("momentum", &p).unwrap();
        assert_eq!(inst.id(), "momentum");
        // 构造一根序列：lookback=3 需 3 前根，第 4 根 close 突破 → Buy(0.25)。
        let bars = vec![
            bar(0, 10.0, 10.0, 9.0, 10.0),
            bar(1, 10.0, 10.0, 9.0, 10.0),
            bar(2, 10.0, 10.0, 9.0, 10.0),
            bar(3, 12.0, 12.0, 11.0, 12.0),
        ];
        let sigs = run_signals(inst.as_mut(), &bars, &[]);
        assert!(matches!(sigs[3].1, Signal::Buy(0.25)), "lookback 覆盖应生效");
    }

    #[test]
    fn registry_schema_has_grid_expandable_num_params() {
        // 每款策略至少含一个 Num 参数（供网格「起:止:步长」展开）。
        for c in builtin_strategy_catalog() {
            let has_num = c.params_schema.iter().any(|p| matches!(p.kind, ParamKind::Num { .. }));
            assert!(has_num, "策略 {} 至少应有一个数值参数", c.id);
        }
    }

    // ---- 数值抽查：跨策略用 phase1 指标做交叉一致性（不依赖完整回测） ----
    #[test]
    fn crossover_indicators_rsi_num() {
        let bars = vec![
            bar(0, 10.0, 10.0, 10.0, 10.0),
            bar(1, 11.0, 11.0, 11.0, 11.0),
            bar(2, 12.0, 12.0, 12.0, 12.0),
            bar(3, 13.0, 13.0, 13.0, 13.0),
        ];
        let r = Indicators::new(&bars, 3).rsi(2).unwrap();
        close(r, 100.0);
    }
}
