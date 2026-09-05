//! 指标计算（ADR §6 / §5）。每 bar 调用一次，窗口取 `bars[0..=index]`。
//!
//! 口径（单测锁定）：
//! - MA：简单移动平均，需 `index+1 >= period`。
//! - EMA：指数移动平均，以 `close[0]` 为种子，自 index 0 起即有值。
//! - RSI：Wilder 平滑，首个值在 `index == period`（前 period 个涨跌幅的均值作种子）。
//! - MACD：DIF=EMA(fast)−EMA(slow)；DEA=EMA(signal) of DIF（以 DIF[0] 为种子）；hist = DIF−DEA。
//! - KDJ：RSV 取 n 周期高低区间，K/D 以 50 为种子做 (m-1)/m 平滑；J = 3K−2D。
//! - BOLL：中轨=MA(period)，上下轨=中轨±k×总体标准差（ddof=0）。
//! - ATR：True Range 的 Wilder 平滑，首个值在 `index == period-1`（前 period 个 TR 的均值）。

use crate::types::Bar;

/// MACD 三元组（DIF/DEA/hist）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MacdValue {
    pub dif: f64,
    pub dea: f64,
    pub hist: f64,
}

/// KDJ 三元组。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KdjValue {
    pub k: f64,
    pub d: f64,
    pub j: f64,
}

/// BOLL 轨道。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BollValue {
    pub mid: f64,
    pub upper: f64,
    pub lower: f64,
}

/// 指标访问器：持有 `&[Bar]` 与当前 bar 序号，按需惰性计算。
#[derive(Debug, Clone, Copy)]
pub struct Indicators<'a> {
    bars: &'a [Bar],
    index: usize,
}

impl<'a> Indicators<'a> {
    pub fn new(bars: &'a [Bar], index: usize) -> Self {
        Self { bars, index }
    }

    pub fn index(&self) -> usize {
        self.index
    }

    /// 简单移动平均。
    pub fn ma(&self, period: usize) -> Option<f64> {
        if period == 0 {
            return None;
        }
        if self.index + 1 < period {
            return None;
        }
        let start = self.index + 1 - period;
        let sum: f64 = self.bars[start..=self.index].iter().map(|b| b.close).sum();
        Some(sum / period as f64)
    }

    /// 指数移动平均（种子 = close[0]）。
    pub fn ema(&self, period: usize) -> Option<f64> {
        if period == 0 || self.bars.is_empty() {
            return None;
        }
        let k = 2.0 / (period as f64 + 1.0);
        let mut ema = self.bars[0].close;
        for i in 1..=self.index {
            ema = self.bars[i].close * k + ema * (1.0 - k);
        }
        Some(ema)
    }

    /// RSI（Wilder 平滑）。
    pub fn rsi(&self, period: usize) -> Option<f64> {
        if period == 0 || self.index < period {
            return None;
        }
        let mut avg_gain = 0.0;
        let mut avg_loss = 0.0;
        for i in 1..=period {
            let diff = self.bars[i].close - self.bars[i - 1].close;
            if diff > 0.0 {
                avg_gain += diff;
            } else {
                avg_loss -= diff;
            }
        }
        avg_gain /= period as f64;
        avg_loss /= period as f64;
        for i in (period + 1)..=self.index {
            let diff = self.bars[i].close - self.bars[i - 1].close;
            let gain = if diff > 0.0 { diff } else { 0.0 };
            let loss = if diff < 0.0 { -diff } else { 0.0 };
            avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
            avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
        }
        if avg_loss == 0.0 {
            return Some(100.0);
        }
        let rs = avg_gain / avg_loss;
        Some(100.0 - 100.0 / (1.0 + rs))
    }

    /// MACD（DIF/DEA/hist）。
    pub fn macd(&self, fast: usize, slow: usize, signal: usize) -> Option<MacdValue> {
        if fast == 0 || slow == 0 || signal == 0 || self.bars.is_empty() {
            return None;
        }
        let kf = 2.0 / (fast as f64 + 1.0);
        let ks = 2.0 / (slow as f64 + 1.0);
        let ksig = 2.0 / (signal as f64 + 1.0);

        let mut ema_fast = self.bars[0].close;
        let mut ema_slow = self.bars[0].close;
        let mut difs = Vec::with_capacity(self.index + 1);
        for i in 0..=self.index {
            ema_fast = if i == 0 {
                self.bars[0].close
            } else {
                self.bars[i].close * kf + ema_fast * (1.0 - kf)
            };
            ema_slow = if i == 0 {
                self.bars[0].close
            } else {
                self.bars[i].close * ks + ema_slow * (1.0 - ks)
            };
            difs.push(ema_fast - ema_slow);
        }
        let mut dea = difs[0];
        for &d in difs.iter().skip(1) {
            dea = d * ksig + dea * (1.0 - ksig);
        }
        let dif = difs[difs.len() - 1];
        Some(MacdValue {
            dif,
            dea,
            hist: dif - dea,
        })
    }

    /// KDJ。
    pub fn kdj(&self, n: usize, k_period: usize, d_period: usize) -> Option<KdjValue> {
        if n == 0 || k_period == 0 || d_period == 0 || self.index + 1 < n {
            return None;
        }
        let mk = (k_period as f64 - 1.0) / k_period as f64;
        let md = (d_period as f64 - 1.0) / d_period as f64;
        let mut k = 50.0;
        let mut d = 50.0;
        for i in (n - 1)..=self.index {
            let start = i + 1 - n;
            let window = &self.bars[start..=i];
            let low_n = window.iter().map(|b| b.low).fold(f64::INFINITY, f64::min);
            let high_n = window.iter().map(|b| b.high).fold(f64::NEG_INFINITY, f64::max);
            let rsv = if high_n == low_n {
                50.0
            } else {
                (self.bars[i].close - low_n) / (high_n - low_n) * 100.0
            };
            k = mk * k + (1.0 / k_period as f64) * rsv;
            d = md * d + (1.0 / d_period as f64) * k;
        }
        Some(KdjValue { k, d, j: 3.0 * k - 2.0 * d })
    }

    /// BOLL。
    pub fn boll(&self, period: usize, k: f64) -> Option<BollValue> {
        if period == 0 || self.index + 1 < period {
            return None;
        }
        let start = self.index + 1 - period;
        let window: Vec<f64> = self.bars[start..=self.index].iter().map(|b| b.close).collect();
        let mid = window.iter().sum::<f64>() / period as f64;
        let var = window.iter().map(|x| (x - mid) * (x - mid)).sum::<f64>() / period as f64;
        let std = var.sqrt();
        Some(BollValue {
            mid,
            upper: mid + k * std,
            lower: mid - k * std,
        })
    }

    /// ATR（Wilder 平滑）。
    pub fn atr(&self, period: usize) -> Option<f64> {
        if period == 0 || self.index + 1 < period {
            return None;
        }
        let tr0 = self.bars[0].high - self.bars[0].low;
        let mut atr = tr0;
        for i in 1..period {
            atr += true_range(&self.bars[i], self.bars[i - 1].close);
        }
        atr /= period as f64;
        for i in period..=self.index {
            let tr = true_range(&self.bars[i], self.bars[i - 1].close);
            atr = (atr * (period as f64 - 1.0) + tr) / period as f64;
        }
        Some(atr)
    }

    /// True Range 序列（供 ATR 测试）；`i` 从 0 起。
    pub fn true_range_at(&self, i: usize) -> f64 {
        if i == 0 {
            self.bars[0].high - self.bars[0].low
        } else {
            true_range(&self.bars[i], self.bars[i - 1].close)
        }
    }
}

fn true_range(bar: &Bar, prev_close: f64) -> f64 {
    let hl = bar.high - bar.low;
    let hc = (bar.high - prev_close).abs();
    let lc = (bar.low - prev_close).abs();
    hl.max(hc).max(lc)
}

#[cfg(test)]
// 黄金样本字面量为锁定的精确参考值（用 close() 以 1e-6 容差断言）。
#[allow(clippy::excessive_precision)]
mod tests {
    use super::*;
    use crate::types::Bar;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    fn bars() -> Vec<Bar> {
        // (ts, o, h, l, c, v)
        let raw: [(i64, f64, f64, f64, f64, f64); 6] = [
            (100, 10.0, 10.5, 9.5, 10.0, 1000.0),
            (101, 11.0, 11.5, 10.5, 11.0, 1000.0),
            (102, 12.0, 12.5, 11.5, 12.0, 1000.0),
            (103, 11.0, 11.5, 10.4, 11.0, 1000.0),
            (104, 13.0, 13.5, 12.5, 13.0, 1000.0),
            (105, 14.0, 14.5, 13.5, 14.0, 1000.0),
        ];
        raw.iter()
            .map(|(ts, o, h, l, c, v)| Bar { ts: *ts, open: *o, high: *h, low: *l, close: *c, volume: *v })
            .collect()
    }

    #[test]
    fn ma_simple() {
        let b = bars();
        close(Indicators::new(&b, 2).ma(3).unwrap(), 11.0);
        close(Indicators::new(&b, 3).ma(3).unwrap(), 11.333333333333);
        close(Indicators::new(&b, 4).ma(3).unwrap(), 12.0);
        close(Indicators::new(&b, 5).ma(3).unwrap(), 12.666666666667);
        // 数据不足
        assert!(Indicators::new(&b, 1).ma(3).is_none());
    }

    #[test]
    fn ema_recursive() {
        let b = bars();
        close(Indicators::new(&b, 4).ema(3).unwrap(), 12.0625);
        close(Indicators::new(&b, 5).ema(3).unwrap(), 13.03125);
    }

    #[test]
    fn rsi_wilder() {
        let b = bars();
        close(Indicators::new(&b, 3).rsi(3).unwrap(), 66.666666666667);
        close(Indicators::new(&b, 4).rsi(3).unwrap(), 83.333333333333);
        close(Indicators::new(&b, 5).rsi(3).unwrap(), 87.878787878788);
        assert!(Indicators::new(&b, 2).rsi(3).is_none());
    }

    #[test]
    fn macd_dif_dea_hist() {
        let b = bars();
        let m = Indicators::new(&b, 5).macd(2, 3, 3).unwrap();
        close(m.dif, 0.433770576132);
        close(m.dea, 0.331854423868);
        close(m.hist, 0.101916152263);
    }

    #[test]
    fn kdj_smoothing() {
        let b = bars();
        let k2 = Indicators::new(&b, 2).kdj(3, 2, 2).unwrap();
        close(k2.k, 66.666666666667);
        close(k2.d, 58.333333333333);
        close(k2.j, 83.333333333333);
        let k3 = Indicators::new(&b, 3).kdj(3, 2, 2).unwrap();
        close(k3.k, 47.619047619048);
        close(k3.d, 52.976190476190);
        close(k3.j, 36.904761904762);
    }

    #[test]
    fn boll_population_std() {
        let b = bars();
        let bo = Indicators::new(&b, 2).boll(3, 2.0).unwrap();
        close(bo.mid, 11.0);
        close(bo.upper, 12.632993161855);
        close(bo.lower, 9.367006838145);
    }

    #[test]
    fn atr_wilder() {
        let b = bars();
        close(Indicators::new(&b, 1).atr(2).unwrap(), 1.25);
        close(Indicators::new(&b, 2).atr(2).unwrap(), 1.375);
        close(Indicators::new(&b, 3).atr(2).unwrap(), 1.4875);
        close(Indicators::new(&b, 4).atr(2).unwrap(), 1.99375);
    }

    #[test]
    fn true_range_definition() {
        let b = bars();
        let ind = Indicators::new(&b, 5);
        close(ind.true_range_at(0), 1.0);
        close(ind.true_range_at(1), 1.5);
        close(ind.true_range_at(2), 1.5);
        close(ind.true_range_at(3), 1.6);
    }
}
