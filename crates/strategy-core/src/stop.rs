//! Policy 层硬止损（ADR §13.3 第二层）：触发即绕过评分直接平仓。
//!
//! 三种机制（作用于**实际持仓**，以 avg_cost 为基准）：
//! - `FixedPct(v)`：close/low < avg_cost × (1−v)；
//! - `Trailing(v)`：自持仓期最高收盘价（不含当前 bar，见 [`TrailingState`]）回撤 v；
//! - `Atr(v)`：close < avg_cost − v × ATR(14)。
//!
//! 两种 trigger（默认 Intrabar）：
//! - `Intrabar`：bar.low 触线 → 按止损价 ×(1−slippage) **当 bar** 成交
//!   （「close 判定次 bar open 成交」的唯一例外场景，ADR §13.3 注明）；
//! - `CloseBasis`：收盘判定 → 次 bar open 成交（与信号成交口径一致）。

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests {
    use super::*;
    use backtest::{Bar, FeeModel};

    fn bar(low: f64, close: f64) -> Bar {
        Bar { ts: 0, open: close, high: close + 0.5, low, close, volume: 1.0 }
    }

    fn close_eq(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "expected {b}, got {a}");
    }

    // ---- 三种止损线 ----

    #[test]
    fn fixed_pct_line() {
        let s = StopConfig { kind: StopKind::FixedPct, value: 0.05, trigger: StopTrigger::Intrabar };
        close_eq(s.stop_line(10.0, None, None).unwrap(), 9.5);
    }

    #[test]
    fn trailing_line_uses_peak_close() {
        let s = StopConfig { kind: StopKind::Trailing, value: 0.1, trigger: StopTrigger::Intrabar };
        // 峰值 12（与 avg_cost 无关）→ 线 = 12 × 0.9
        close_eq(s.stop_line(10.0, Some(12.0), None).unwrap(), 10.8);
        // 无峰值（未建仓）→ 不触发
        assert!(s.stop_line(10.0, None, None).is_none());
    }

    #[test]
    fn atr_line() {
        let s = StopConfig { kind: StopKind::Atr, value: 2.0, trigger: StopTrigger::CloseBasis };
        // 线 = avg_cost − 2 × ATR(14) = 10 − 2×0.5 = 9
        close_eq(s.stop_line(10.0, None, Some(0.5)).unwrap(), 9.0);
        // ATR 数据不足 → 不触发
        assert!(s.stop_line(10.0, None, None).is_none());
    }

    // ---- 触发点判定（严格小于）----

    #[test]
    fn intrabar_triggers_on_low_cross() {
        let s = StopConfig { kind: StopKind::FixedPct, value: 0.05, trigger: StopTrigger::Intrabar };
        assert!(s.intrabar_triggered(9.5, &bar(9.49, 10.0)), "low 9.49 < 9.5 → 触发");
        assert!(!s.intrabar_triggered(9.5, &bar(9.5, 10.0)), "low 恰触线不触发（严格小于）");
        assert!(!s.intrabar_triggered(9.5, &bar(9.6, 9.4)), "low 未触线不触发（即使 close 破线）");
    }

    #[test]
    fn close_basis_triggers_on_close_cross() {
        let s = StopConfig { kind: StopKind::FixedPct, value: 0.05, trigger: StopTrigger::CloseBasis };
        assert!(s.close_triggered(9.5, &bar(10.0, 9.49)), "close 9.49 < 9.5 → 触发");
        assert!(!s.close_triggered(9.5, &bar(9.0, 9.5)), "close 恰触线不触发");
        assert!(!s.close_triggered(9.5, &bar(9.0, 10.0)), "low 破线但 close 未破 → 不触发");
    }

    // ---- 成交价口径（ADR §13.3：止损价 ×(1−slippage)，Intrabar 当 bar 成交）----

    #[test]
    fn intrabar_fill_price_is_line_minus_slippage() {
        let fee = FeeModel::default(); // slippage 2bp
        let line = 9.5;
        let exec = fee.sell(100.0, line);
        close_eq(exec.effective_price, 9.5 * (1.0 - 0.0002));
    }

    // ---- Trailing 峰值状态机 ----

    #[test]
    fn trailing_peak_tracks_max_close_since_entry() {
        let mut t = TrailingState::new();
        assert_eq!(t.peak(), None);
        t.on_entry(10.0);
        assert_eq!(t.peak(), Some(10.0));
        t.on_bar_close(11.0);
        t.on_bar_close(10.5);
        t.on_bar_close(12.0);
        assert_eq!(t.peak(), Some(12.0), "峰值 = 建仓以来最高收盘价");
        t.reset();
        assert_eq!(t.peak(), None);
    }

    #[test]
    fn default_trigger_is_intrabar() {
        assert_eq!(StopTrigger::default(), StopTrigger::Intrabar);
    }
}

/// 止损机制。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum StopKind {
    /// 固定百分比：跌破 avg_cost × (1−v)。
    FixedPct,
    /// 移动止损：自持仓期最高收盘价回撤 v。
    Trailing,
    /// ATR 吊灯：跌破 avg_cost − v × ATR(14)。
    Atr,
}

/// 触发方式（ADR §13.3；默认 Intrabar）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum StopTrigger {
    /// bar.low 触线当 bar 按止损价成交（成交口径唯一例外）。
    #[default]
    Intrabar,
    /// 收盘判定，次 bar open 成交。
    CloseBasis,
}

/// 硬止损配置（Run 级；`value` 语义随 kind：FixedPct/Trailing 为比例，Atr 为 ATR 倍数）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StopConfig {
    pub kind: StopKind,
    pub value: f64,
    #[serde(default)]
    pub trigger: StopTrigger,
}

/// Trailing 止损运行态：持仓期最高收盘价。
///
/// 口径决策：峰值取**建仓以来至上一 bar** 的最高收盘价（不含当前 bar）——
/// 当前 bar 若创新高，其 close 于 bar 末才并入峰值，避免「新高 bar 因自身峰值立刻触线」
/// 的自指问题；每 bar 末调用 [`TrailingState::on_bar_close`] 更新。清仓后重置。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TrailingState {
    pub(crate) peak_close: Option<f64>,
}

impl TrailingState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前持仓期峰值（未持仓/未建仓 → None）。
    pub fn peak(&self) -> Option<f64> {
        self.peak_close
    }

    /// 建仓时以首笔成交价初始化峰值。
    pub fn on_entry(&mut self, entry_price: f64) {
        self.peak_close = Some(entry_price);
    }

    /// 每 bar 末以当前 close 更新峰值。
    pub fn on_bar_close(&mut self, close: f64) {
        self.peak_close = Some(match self.peak_close {
            Some(p) => p.max(close),
            None => close,
        });
    }

    /// 清仓后重置。
    pub fn reset(&mut self) {
        self.peak_close = None;
    }
}

impl StopConfig {
    /// 计算当前止损线（持仓有效前提下；数据不足 → None 表示本 bar 无法判定/不触发）。
    ///
    /// - `avg_cost`：摊薄成本价（实际持仓基准，ADR §13.3「作用于实际持仓」）；
    /// - `peak_close`：Trailing 专用，持仓期最高收盘价（不含当前 bar）；
    /// - `atr14`：ATR(14) 当前值（`Indicators::atr(14)`，数据不足为 None → 不触发）。
    pub fn stop_line(
        &self,
        avg_cost: f64,
        peak_close: Option<f64>,
        atr14: Option<f64>,
    ) -> Option<f64> {
        match self.kind {
            StopKind::FixedPct => Some(avg_cost * (1.0 - self.value)),
            StopKind::Trailing => peak_close.map(|p| p * (1.0 - self.value)),
            StopKind::Atr => atr14.map(|a| avg_cost - self.value * a),
        }
    }

    /// Intrabar 判定：bar.low 触线（严格小于）。
    pub fn intrabar_triggered(&self, line: f64, bar: &backtest::Bar) -> bool {
        bar.low < line
    }

    /// CloseBasis 判定：bar.close 触线（严格小于）。
    pub fn close_triggered(&self, line: f64, bar: &backtest::Bar) -> bool {
        bar.close < line
    }
}
