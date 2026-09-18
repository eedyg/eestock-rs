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
//!
//! ADR-024 P2（D6）新增 [`OnlineIndicators`]（**增量状态**，每 bar O(1)/O(window)）：
//! - 切片视图 [`Indicators`] **保留不动**，作为口径参考与等价性对照（P2 gate 的 A/B 层判据）；
//! - `OnlineIndicators` 对 `ema`/`rsi`/`macd`/`kdj`/`atr` 用**同序递推**（与切片视图逐字相同的
//!   f64 运算与累加顺序）⇒ 期望**位级一致**（单测以 `to_bits()` 锁定）；
//! - `ma`/`boll` 仍按窗口直接求和（O(window)，未改求和顺序）⇒ 同样位级一致；
//!   有意**不**用「滑动和（running sum）」：那会改变求和顺序，且在长序列上引入随 n 累积的
//!   漂移，违反 03-test-plan.md §1.1 C 层「偏差不得随 n 增长」。

use std::collections::HashMap;

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

// ---------------------------------------------------------------------------
// 增量指标状态（ADR-024 P2 / D6）
// ---------------------------------------------------------------------------

/// 增量指标状态：按 bar 顺序推进（每 bar 取值 O(1)，`ma`/`boll` 为 O(window)），
/// 与切片视图 [`Indicators`] **位级一致**（见模块头注）。
///
/// 用法：`let mut on = OnlineIndicators::new(); on.ema(bars, i, 12)` —— 每个
/// `(指标, 参数)` 组合各持一份递推状态，随 `index` 单调推进；同一组合重复调用只读当前值。
///
/// 口径：
/// - `index >= bars.len()`（数据尚未喂到）或周期为 0 → `None`（不推进状态）；
/// - 非单调（回退）请求：重建该组合状态（正确性优先；最坏 O(index)，属异常路径）。
#[derive(Debug, Default)]
pub struct OnlineIndicators {
    ema: HashMap<usize, EmaState>,
    rsi: HashMap<usize, RsiState>,
    macd: HashMap<(usize, usize, usize), MacdState>,
    kdj: HashMap<(usize, usize, usize), KdjState>,
    atr: HashMap<usize, AtrState>,
}

impl OnlineIndicators {
    pub fn new() -> Self {
        Self::default()
    }

    /// 简单移动平均（O(period)，与切片视图同一条求和顺序 ⇒ 位级一致）。
    pub fn ma(&mut self, bars: &[Bar], index: usize, period: usize) -> Option<f64> {
        if index >= bars.len() {
            return None;
        }
        Indicators::new(bars, index).ma(period)
    }

    /// 指数移动平均（同序递推：`close[i]*k + prev*(1-k)`，种子 = `close[0]`）。
    pub fn ema(&mut self, bars: &[Bar], index: usize, period: usize) -> Option<f64> {
        if period == 0 || bars.is_empty() || index >= bars.len() {
            return None;
        }
        let st = self.ema.entry(period).or_insert_with(|| EmaState::new(period));
        st.advance(bars, index);
        st.value_at(index)
    }

    /// RSI（Wilder 平滑；同序递推：种子 = 前 period 个涨跌幅均值，之后逐 bar 递推）。
    pub fn rsi(&mut self, bars: &[Bar], index: usize, period: usize) -> Option<f64> {
        if period == 0 || bars.is_empty() || index >= bars.len() {
            return None;
        }
        let st = self.rsi.entry(period).or_insert_with(|| RsiState::new(period));
        st.advance(bars, index);
        st.value_at(index)
    }

    /// MACD（DIF/DEA/hist；同序递推：EMAf/EMAs 递推 + DEA 以 DIF[0] 为种子）。
    pub fn macd(
        &mut self,
        bars: &[Bar],
        index: usize,
        fast: usize,
        slow: usize,
        signal: usize,
    ) -> Option<MacdValue> {
        if fast == 0 || slow == 0 || signal == 0 || bars.is_empty() || index >= bars.len() {
            return None;
        }
        let st = self
            .macd
            .entry((fast, slow, signal))
            .or_insert_with(|| MacdState::new(fast, slow, signal));
        st.advance(bars, index);
        st.value_at(index)
    }

    /// KDJ（同序递推：K/D 以 50 为种子；(m-1)/m 平滑；RSV 窗口 min/max 每 bar O(n) 重算，
    /// min/max 精确无舍入 ⇒ 与切片视图位级一致）。
    pub fn kdj(
        &mut self,
        bars: &[Bar],
        index: usize,
        n: usize,
        k_period: usize,
        d_period: usize,
    ) -> Option<KdjValue> {
        if n == 0 || k_period == 0 || d_period == 0 || bars.is_empty() || index >= bars.len() {
            return None;
        }
        let st = self
            .kdj
            .entry((n, k_period, d_period))
            .or_insert_with(|| KdjState::new(n, k_period, d_period));
        st.advance(bars, index);
        st.value_at(index)
    }

    /// BOLL（O(period)，与切片视图同一条求和顺序 ⇒ 位级一致）。
    pub fn boll(&mut self, bars: &[Bar], index: usize, period: usize, k: f64) -> Option<BollValue> {
        if index >= bars.len() {
            return None;
        }
        Indicators::new(bars, index).boll(period, k)
    }

    /// ATR（Wilder 平滑；同序递推：种子 = 前 period 个 TR 均值，之后逐 bar 递推）。
    pub fn atr(&mut self, bars: &[Bar], index: usize, period: usize) -> Option<f64> {
        if period == 0 || bars.is_empty() || index >= bars.len() {
            return None;
        }
        let st = self.atr.entry(period).or_insert_with(|| AtrState::new(period));
        st.advance(bars, index);
        st.value_at(index)
    }
}

/// 递推状态推进游标的公共语义：`next` = 下一个待消费 bar 下标（= 已消费 bar 数）。
/// - 请求回退（`index + 1 < next`）⇒ 重建状态（正确性优先）；
/// - 数据不足（`index >= bars.len()`）由调用方提前返回 `None`。
macro_rules! advance_cursor {
    ($self:ident, $bars:ident, $index:expr) => {{
        if $index + 1 < $self.next {
            let rebuilt = $self.new_params();
            *$self = rebuilt;
        }
        let target = $index.min($bars.len() - 1);
        while $self.next <= target {
            $self.consume($bars, $self.next);
            $self.next += 1;
        }
    }};
}

#[derive(Debug, Clone)]
struct EmaState {
    period: usize,
    k: f64,
    value: f64,
    next: usize,
}

impl EmaState {
    fn new(period: usize) -> Self {
        Self {
            period,
            k: 2.0 / (period as f64 + 1.0),
            value: 0.0,
            next: 0,
        }
    }

    fn new_params(&self) -> Self {
        Self::new(self.period)
    }

    fn advance(&mut self, bars: &[Bar], index: usize) {
        advance_cursor!(self, bars, index);
    }

    fn consume(&mut self, bars: &[Bar], i: usize) {
        self.value = if i == 0 {
            bars[0].close
        } else {
            bars[i].close * self.k + self.value * (1.0 - self.k)
        };
    }

    fn value_at(&self, index: usize) -> Option<f64> {
        (self.next == index + 1).then_some(self.value)
    }
}

#[derive(Debug, Clone)]
struct RsiState {
    period: usize,
    sum_gain: f64,
    sum_loss: f64,
    avg_gain: f64,
    avg_loss: f64,
    next: usize,
}

impl RsiState {
    fn new(period: usize) -> Self {
        Self {
            period,
            sum_gain: 0.0,
            sum_loss: 0.0,
            avg_gain: 0.0,
            avg_loss: 0.0,
            next: 0,
        }
    }

    fn new_params(&self) -> Self {
        Self::new(self.period)
    }

    fn advance(&mut self, bars: &[Bar], index: usize) {
        advance_cursor!(self, bars, index);
    }

    /// 与 `Indicators::rsi` 逐字同序：种子段累加 → 除以 period → Wilder 递推。
    fn consume(&mut self, bars: &[Bar], i: usize) {
        if i == 0 {
            return;
        }
        let diff = bars[i].close - bars[i - 1].close;
        if i <= self.period {
            if diff > 0.0 {
                self.sum_gain += diff;
            } else {
                self.sum_loss -= diff;
            }
            if i == self.period {
                self.avg_gain = self.sum_gain / self.period as f64;
                self.avg_loss = self.sum_loss / self.period as f64;
            }
        } else {
            let gain = if diff > 0.0 { diff } else { 0.0 };
            let loss = if diff < 0.0 { -diff } else { 0.0 };
            self.avg_gain =
                (self.avg_gain * (self.period as f64 - 1.0) + gain) / self.period as f64;
            self.avg_loss =
                (self.avg_loss * (self.period as f64 - 1.0) + loss) / self.period as f64;
        }
    }

    fn value_at(&self, index: usize) -> Option<f64> {
        if self.next != index + 1 || index < self.period {
            return None;
        }
        if self.avg_loss == 0.0 {
            return Some(100.0);
        }
        let rs = self.avg_gain / self.avg_loss;
        Some(100.0 - 100.0 / (1.0 + rs))
    }
}

#[derive(Debug, Clone)]
struct MacdState {
    fast: usize,
    slow: usize,
    signal: usize,
    ema_fast: f64,
    ema_slow: f64,
    dea: f64,
    dif: f64,
    next: usize,
}

impl MacdState {
    fn new(fast: usize, slow: usize, signal: usize) -> Self {
        Self {
            fast,
            slow,
            signal,
            ema_fast: 0.0,
            ema_slow: 0.0,
            dea: 0.0,
            dif: 0.0,
            next: 0,
        }
    }

    fn new_params(&self) -> Self {
        Self::new(self.fast, self.slow, self.signal)
    }

    fn advance(&mut self, bars: &[Bar], index: usize) {
        advance_cursor!(self, bars, index);
    }

    fn consume(&mut self, bars: &[Bar], i: usize) {
        let kf = 2.0 / (self.fast as f64 + 1.0);
        let ks = 2.0 / (self.slow as f64 + 1.0);
        let ksig = 2.0 / (self.signal as f64 + 1.0);
        if i == 0 {
            self.ema_fast = bars[0].close;
            self.ema_slow = bars[0].close;
        } else {
            self.ema_fast = bars[i].close * kf + self.ema_fast * (1.0 - kf);
            self.ema_slow = bars[i].close * ks + self.ema_slow * (1.0 - ks);
        }
        let dif = self.ema_fast - self.ema_slow;
        self.dea = if i == 0 {
            dif
        } else {
            dif * ksig + self.dea * (1.0 - ksig)
        };
        self.dif = dif;
    }

    fn value_at(&self, index: usize) -> Option<MacdValue> {
        if self.next != index + 1 {
            return None;
        }
        Some(MacdValue {
            dif: self.dif,
            dea: self.dea,
            hist: self.dif - self.dea,
        })
    }
}

#[derive(Debug, Clone)]
struct KdjState {
    n: usize,
    k_period: usize,
    d_period: usize,
    mk: f64,
    md: f64,
    k: f64,
    d: f64,
    next: usize,
}

impl KdjState {
    fn new(n: usize, k_period: usize, d_period: usize) -> Self {
        Self {
            n,
            k_period,
            d_period,
            mk: (k_period as f64 - 1.0) / k_period as f64,
            md: (d_period as f64 - 1.0) / d_period as f64,
            k: 50.0,
            d: 50.0,
            next: 0,
        }
    }

    fn new_params(&self) -> Self {
        Self::new(self.n, self.k_period, self.d_period)
    }

    fn advance(&mut self, bars: &[Bar], index: usize) {
        advance_cursor!(self, bars, index);
    }

    fn consume(&mut self, bars: &[Bar], i: usize) {
        if i + 1 < self.n {
            return;
        }
        let window = &bars[i + 1 - self.n..=i];
        let low_n = window.iter().map(|b| b.low).fold(f64::INFINITY, f64::min);
        let high_n = window
            .iter()
            .map(|b| b.high)
            .fold(f64::NEG_INFINITY, f64::max);
        let rsv = if high_n == low_n {
            50.0
        } else {
            (bars[i].close - low_n) / (high_n - low_n) * 100.0
        };
        self.k = self.mk * self.k + (1.0 / self.k_period as f64) * rsv;
        self.d = self.md * self.d + (1.0 / self.d_period as f64) * self.k;
    }

    fn value_at(&self, index: usize) -> Option<KdjValue> {
        if self.next != index + 1 || self.next < self.n {
            return None;
        }
        Some(KdjValue {
            k: self.k,
            d: self.d,
            j: 3.0 * self.k - 2.0 * self.d,
        })
    }
}

#[derive(Debug, Clone)]
struct AtrState {
    period: usize,
    acc: f64,
    atr: f64,
    next: usize,
}

impl AtrState {
    fn new(period: usize) -> Self {
        Self {
            period,
            acc: 0.0,
            atr: 0.0,
            next: 0,
        }
    }

    fn new_params(&self) -> Self {
        Self::new(self.period)
    }

    fn advance(&mut self, bars: &[Bar], index: usize) {
        advance_cursor!(self, bars, index);
    }

    /// 与 `Indicators::atr` 逐字同序：种子段 `tr0 + Σ tr_i` → 除以 period → Wilder 递推。
    fn consume(&mut self, bars: &[Bar], i: usize) {
        let tr = if i == 0 {
            bars[0].high - bars[0].low
        } else {
            true_range(&bars[i], bars[i - 1].close)
        };
        if i < self.period {
            if i == 0 {
                self.acc = tr;
            } else {
                self.acc += tr;
            }
            if i + 1 == self.period {
                self.atr = self.acc / self.period as f64;
            }
        } else {
            self.atr = (self.atr * (self.period as f64 - 1.0) + tr) / self.period as f64;
        }
    }

    fn value_at(&self, index: usize) -> Option<f64> {
        if self.next != index + 1 || self.next < self.period {
            return None;
        }
        Some(self.atr)
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

    // -----------------------------------------------------------------------
    // ADR-024 P2（D6）：增量指标状态 [`OnlineIndicators`] 与切片视图 [`Indicators`] 等价
    //
    // 判据（03-test-plan.md §1.1）：本实现的递推与切片视图**同序**（同一条
    // f64 累加顺序）⇒ 期望 **A 层位级一致**（含 `ma`：仍按窗口直接求和，未改求和顺序，
    // 故同样位级一致）；覆盖 `i ∈ {period-1, period, 2×period, n-1}` + 全序列扫描。
    // -----------------------------------------------------------------------

    /// 决定性「近真实」序列（无 RNG、无时间依赖）：
    /// - `i % 37 == 0` 保持 close 不变 → 覆盖 RSI 的 `diff == 0` 分支；
    /// - `[200, 215)` 整段 `high == low == close` → 覆盖 KDJ 的 `high == low → rsv=50` 分支
    ///   与 ATR 的 `TR == 0` 分支。
    fn series(n: usize) -> Vec<Bar> {
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        let mut close = 10.0_f64;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            if i % 37 != 0 {
                let step = ((state >> 33) % 21) as f64 - 10.0; // -10..=10
                close += step * 0.01;
            }
            let (open, high, low, c) = if (200..215).contains(&i) {
                (10.0, 10.0, 10.0, 10.0)
            } else {
                let hi = close + 0.02 + ((state >> 21) % 5) as f64 * 0.01;
                let lo = close - 0.02 - ((state >> 11) % 5) as f64 * 0.01;
                (close - 0.01, hi, lo, close)
            };
            out.push(Bar {
                ts: 1_700_000_000 + i as i64 * 60,
                open,
                high,
                low,
                close: c,
                volume: 1_000.0 + i as f64,
            });
        }
        out
    }

    fn assert_bits(label: &str, i: usize, got: Option<f64>, want: Option<f64>) {
        match (got, want) {
            (Some(g), Some(w)) => assert_eq!(
                g.to_bits(),
                w.to_bits(),
                "{label} @i={i}: 位级不一致 got={g:?} want={w:?}"
            ),
            (None, None) => {}
            (g, w) => panic!("{label} @i={i}: 存在性不一致 got={g:?} want={w:?}"),
        }
    }

    fn assert_bits3(
        label: &str,
        i: usize,
        got: Option<(f64, f64, f64)>,
        want: Option<(f64, f64, f64)>,
    ) {
        match (got, want) {
            (Some(g), Some(w)) => {
                for (k, (a, b)) in [(g.0, w.0), (g.1, w.1), (g.2, w.2)].iter().enumerate() {
                    assert_eq!(
                        a.to_bits(),
                        b.to_bits(),
                        "{label} @i={i} 第 {k} 字段: 位级不一致 got={a:?} want={b:?}"
                    );
                }
            }
            (None, None) => {}
            (g, w) => panic!("{label} @i={i}: 存在性不一致 got={g:?} want={w:?}"),
        }
    }

    #[test]
    fn online_ma_matches_slice_view() {
        let b = series(600);
        let mut on = OnlineIndicators::new();
        for period in [1usize, 3, 20] {
            // 关键下标（03-test-plan.md §1.2）：period-1 / period / 2×period / n-1
            for i in [period - 1, period, 2 * period, 599] {
                assert_bits(
                    &format!("ma({period})"),
                    i,
                    on.ma(&b, i, period),
                    Indicators::new(&b, i).ma(period),
                );
            }
            for i in 0..b.len() {
                assert_bits(
                    &format!("ma({period})"),
                    i,
                    on.ma(&b, i, period),
                    Indicators::new(&b, i).ma(period),
                );
            }
        }
        // period == 0 → 与切片视图一致（None）
        assert!(on.ma(&b, 10, 0).is_none());
    }

    #[test]
    fn online_ema_matches_slice_view() {
        let b = series(600);
        let mut on = OnlineIndicators::new();
        for period in [3usize, 12, 200] {
            for i in [period - 1, period, 2 * period, 599] {
                assert_bits(
                    &format!("ema({period})"),
                    i,
                    on.ema(&b, i, period),
                    Indicators::new(&b, i).ema(period),
                );
            }
            for i in 0..b.len() {
                assert_bits(
                    &format!("ema({period})"),
                    i,
                    on.ema(&b, i, period),
                    Indicators::new(&b, i).ema(period),
                );
            }
        }
        assert!(on.ema(&b, 10, 0).is_none());
        assert!(on.ema(&[], 0, 5).is_none());
    }

    #[test]
    fn online_rsi_matches_slice_view() {
        let b = series(600);
        let mut on = OnlineIndicators::new();
        for period in [3usize, 14, 50] {
            for i in [period - 1, period, 2 * period, 599] {
                assert_bits(
                    &format!("rsi({period})"),
                    i,
                    on.rsi(&b, i, period),
                    Indicators::new(&b, i).rsi(period),
                );
            }
            for i in 0..b.len() {
                assert_bits(
                    &format!("rsi({period})"),
                    i,
                    on.rsi(&b, i, period),
                    Indicators::new(&b, i).rsi(period),
                );
            }
        }
        assert!(on.rsi(&b, 10, 0).is_none());
    }

    #[test]
    fn online_macd_matches_slice_view() {
        let b = series(600);
        let mut on = OnlineIndicators::new();
        for (fast, slow, signal) in [(2usize, 3usize, 3usize), (12, 26, 9)] {
            let last = b.len() - 1;
            for i in [slow - 1, slow, 2 * slow, last] {
                assert_bits3(
                    "macd",
                    i,
                    on.macd(&b, i, fast, slow, signal)
                        .map(|m| (m.dif, m.dea, m.hist)),
                    Indicators::new(&b, i)
                        .macd(fast, slow, signal)
                        .map(|m| (m.dif, m.dea, m.hist)),
                );
            }
            for i in 0..b.len() {
                assert_bits3(
                    "macd",
                    i,
                    on.macd(&b, i, fast, slow, signal)
                        .map(|m| (m.dif, m.dea, m.hist)),
                    Indicators::new(&b, i)
                        .macd(fast, slow, signal)
                        .map(|m| (m.dif, m.dea, m.hist)),
                );
            }
        }
        assert!(on.macd(&b, 10, 0, 3, 3).is_none());
        assert!(on.macd(&[], 0, 12, 26, 9).is_none());
    }

    #[test]
    fn online_kdj_matches_slice_view() {
        let b = series(600);
        let mut on = OnlineIndicators::new();
        for (n, kp, dp) in [(9usize, 3usize, 3usize), (3, 2, 2), (20, 5, 5)] {
            for i in [n - 1, n, 2 * n, 599] {
                assert_bits3(
                    &format!("kdj({n},{kp},{dp})"),
                    i,
                    on.kdj(&b, i, n, kp, dp).map(|k| (k.k, k.d, k.j)),
                    Indicators::new(&b, i)
                        .kdj(n, kp, dp)
                        .map(|k| (k.k, k.d, k.j)),
                );
            }
            for i in 0..b.len() {
                assert_bits3(
                    &format!("kdj({n},{kp},{dp})"),
                    i,
                    on.kdj(&b, i, n, kp, dp).map(|k| (k.k, k.d, k.j)),
                    Indicators::new(&b, i)
                        .kdj(n, kp, dp)
                        .map(|k| (k.k, k.d, k.j)),
                );
            }
        }
        assert!(on.kdj(&b, 10, 0, 3, 3).is_none());
    }

    #[test]
    fn online_boll_matches_slice_view() {
        let b = series(600);
        let mut on = OnlineIndicators::new();
        for (period, mult) in [(20usize, 2.0_f64), (3, 1.5)] {
            for i in [period - 1, period, 2 * period, 599] {
                assert_bits3(
                    &format!("boll({period},{mult})"),
                    i,
                    on.boll(&b, i, period, mult)
                        .map(|v| (v.mid, v.upper, v.lower)),
                    Indicators::new(&b, i)
                        .boll(period, mult)
                        .map(|v| (v.mid, v.upper, v.lower)),
                );
            }
            for i in 0..b.len() {
                assert_bits3(
                    &format!("boll({period},{mult})"),
                    i,
                    on.boll(&b, i, period, mult)
                        .map(|v| (v.mid, v.upper, v.lower)),
                    Indicators::new(&b, i)
                        .boll(period, mult)
                        .map(|v| (v.mid, v.upper, v.lower)),
                );
            }
        }
        assert!(on.boll(&b, 10, 0, 2.0).is_none());
    }

    #[test]
    fn online_atr_matches_slice_view() {
        let b = series(600);
        let mut on = OnlineIndicators::new();
        for period in [1usize, 2, 14] {
            for i in [period - 1, period, 2 * period, 599] {
                assert_bits(
                    &format!("atr({period})"),
                    i,
                    on.atr(&b, i, period),
                    Indicators::new(&b, i).atr(period),
                );
            }
            for i in 0..b.len() {
                assert_bits(
                    &format!("atr({period})"),
                    i,
                    on.atr(&b, i, period),
                    Indicators::new(&b, i).atr(period),
                );
            }
        }
        assert!(on.atr(&b, 10, 0).is_none());
    }

    /// 乱序（回退）请求必须重建状态而非读陈旧值：先推进到 n-1，再回问早期下标。
    #[test]
    fn online_handles_non_monotone_requests() {
        let b = series(300);
        let mut on = OnlineIndicators::new();
        for i in 0..b.len() {
            let _ = on.ema(&b, i, 12);
            let _ = on.rsi(&b, i, 14);
            let _ = on.atr(&b, i, 14);
            let _ = on.macd(&b, i, 12, 26, 9);
            let _ = on.kdj(&b, i, 9, 3, 3);
        }
        for i in [0usize, 1, 13, 27, 100, 5, 299] {
            assert_bits(
                "ema(12)",
                i,
                on.ema(&b, i, 12),
                Indicators::new(&b, i).ema(12),
            );
            assert_bits(
                "rsi(14)",
                i,
                on.rsi(&b, i, 14),
                Indicators::new(&b, i).rsi(14),
            );
            assert_bits(
                "atr(14)",
                i,
                on.atr(&b, i, 14),
                Indicators::new(&b, i).atr(14),
            );
            assert_bits3(
                "macd",
                i,
                on.macd(&b, i, 12, 26, 9).map(|m| (m.dif, m.dea, m.hist)),
                Indicators::new(&b, i)
                    .macd(12, 26, 9)
                    .map(|m| (m.dif, m.dea, m.hist)),
            );
            assert_bits3(
                "kdj",
                i,
                on.kdj(&b, i, 9, 3, 3).map(|k| (k.k, k.d, k.j)),
                Indicators::new(&b, i).kdj(9, 3, 3).map(|k| (k.k, k.d, k.j)),
            );
        }
    }

    /// 数据不足 / 越界口径：`index >= bars.len()` 与切片视图一致（None）。
    #[test]
    fn online_out_of_range_index_is_none() {
        let b = series(40);
        let mut on = OnlineIndicators::new();
        assert!(on.ema(&b, 40, 12).is_none());
        assert!(on.rsi(&b, 40, 14).is_none());
        assert!(on.atr(&b, 40, 14).is_none());
        assert!(on.macd(&b, 40, 12, 26, 9).is_none());
        assert!(on.kdj(&b, 40, 9, 3, 3).is_none());
        assert!(on.ma(&b, 40, 5).is_none());
        assert!(on.boll(&b, 40, 5, 2.0).is_none());
    }
}
