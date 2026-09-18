//! 插件 ABI 共享历史缓冲（ADR-024 P2 / D7）。
//!
//! ## 背景（根因锚点，ADR-024 §2.2）
//! `quickjs.rs::build_indicators` 原实现每 **slot × 每 bar** 执行
//! `Rc::new(bctx.bars[..=bctx.index].to_vec())`（O(index) 复制 + 大额分配）⇒ 整机 O(n²)。
//! 本模块提供**单一增长式共享缓冲**：引擎会话（`strategy-core::EnsembleSession`）持有
//! `Rc<BarHistory>`，逐 bar `push`，插件指标闭包共享同一句柄按 `index` 取值
//! （ADR D7：「保留 `ctx.bars` = 全量历史语义，实现改单一增长式共享缓冲」，**零 ABI 变更**）。
//!
//! ## 语义
//! - `bars` = **从第 0 根到当前 index 的全量历史**（`len() == index + 1`；不含未来 bar ⇒ 无前视）；
//! - 指标取值委托 [`backtest::OnlineIndicators`]（增量状态：`ema/rsi/macd/kdj/atr` 每 bar O(1)，
//!   `ma/boll` 每 bar O(window)），与切片视图 `backtest::Indicators` **位级一致**；
//! - 无共享句柄的调用方（试算 / sim-live / 单测走 [`crate::BarCtx::new`] 的兼容路径）行为与改造前**完全一致**
//!   （每 bar 一次性构造等价缓冲），不受本模块影响。
//!
//! ## 分层
//! 纯内存、无 IO/无时钟（Domain 层红线）；`Rc/RefCell` 为单线程插件实例（ABI §4：实现不保证 `Send`）。

use std::cell::RefCell;
use std::rc::Rc;

use backtest::{Bar, BollValue, KdjValue, MacdValue, OnlineIndicators};

/// 共享历史缓冲（增长式，指标状态随 bar 推进）。
///
/// 典型用法（引擎会话）：
/// ```ignore
/// let hist = BarHistory::with_capacity(n);
/// for (i, bar) in bars.iter().enumerate() {
///     hist.push(bar.clone());
///     let ctx = BarCtx::new(i, bar.clone(), &bars[..=i], position).with_history(hist.clone());
///     // slot.on_bar(&ctx) —— 指标闭包直接读共享缓冲，不再复制整段历史
/// }
/// ```
#[derive(Debug)]
pub struct BarHistory {
    bars: RefCell<Vec<Bar>>,
    online: RefCell<OnlineIndicators>,
}

impl BarHistory {
    /// 空缓冲（`Rc` 句柄：引擎与会话/各 slot 插件闭包共享同一实例）。
    pub fn new() -> Rc<Self> {
        Self::with_capacity(0)
    }

    /// 预分配容量的空缓冲（批式入口已知 bar 总数时避免增长期重分配）。
    pub fn with_capacity(capacity: usize) -> Rc<Self> {
        Rc::new(Self {
            bars: RefCell::new(Vec::with_capacity(capacity)),
            online: RefCell::new(OnlineIndicators::new()),
        })
    }

    /// 由切片一次性构造（**兼容路径**用：试算/sim-live 无共享句柄时按 `bars[..=index]` 建等价缓冲）。
    /// 语义与 `push` 序列完全等价（同一 bar 序列 ⇒ 同一指标值）。
    pub fn from_bars(bars: &[Bar]) -> Rc<Self> {
        let h = Self::with_capacity(bars.len());
        h.bars.borrow_mut().extend_from_slice(bars);
        h
    }

    /// 追加一根 bar（摊销 O(1)；不复制既有历史）。
    pub fn push(&self, bar: Bar) {
        self.bars.borrow_mut().push(bar);
    }

    /// 当前历史长度（= 已喂入 bar 数 = 合法 `index` 上界 + 1）。
    pub fn len(&self) -> usize {
        self.bars.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.bars.borrow().is_empty()
    }

    /// 以只读切片访问历史（`0..len`）。**不得**在闭包内 `push`（RefCell 借用在闭包期间存活）。
    pub fn with_slice<R>(&self, f: impl FnOnce(&[Bar]) -> R) -> R {
        let guard = self.bars.borrow();
        f(&guard)
    }

    // ---------------------------------------------------------------------
    // 指标访问器（与 `backtest::Indicators` 位级一致；见 backtest::OnlineIndicators 单测）
    // ---------------------------------------------------------------------

    /// 简单移动平均（O(period)）。
    pub fn ma(&self, index: usize, period: usize) -> Option<f64> {
        self.online_indicators(|bars, online| online.ma(bars, index, period))
    }

    /// 指数移动平均（增量 O(1)）。
    pub fn ema(&self, index: usize, period: usize) -> Option<f64> {
        self.online_indicators(|bars, online| online.ema(bars, index, period))
    }

    /// RSI（Wilder，增量 O(1)）。
    pub fn rsi(&self, index: usize, period: usize) -> Option<f64> {
        self.online_indicators(|bars, online| online.rsi(bars, index, period))
    }

    /// MACD（增量 O(1)）。
    pub fn macd(&self, index: usize, fast: usize, slow: usize, signal: usize) -> Option<MacdValue> {
        self.online_indicators(|bars, online| online.macd(bars, index, fast, slow, signal))
    }

    /// KDJ（增量 O(n) 窗口 min/max；平滑为 O(1)）。
    pub fn kdj(
        &self,
        index: usize,
        n: usize,
        k_period: usize,
        d_period: usize,
    ) -> Option<KdjValue> {
        self.online_indicators(|bars, online| online.kdj(bars, index, n, k_period, d_period))
    }

    /// BOLL（O(period)）。
    pub fn boll(&self, index: usize, period: usize, k: f64) -> Option<BollValue> {
        self.online_indicators(|bars, online| online.boll(bars, index, period, k))
    }

    /// ATR（Wilder，增量 O(1)）。
    pub fn atr(&self, index: usize, period: usize) -> Option<f64> {
        self.online_indicators(|bars, online| online.atr(bars, index, period))
    }

    /// 统一入口：同一把 `bars` 只读借用下推进 `online` 状态（两把锁无嵌套冲突：
    /// `bars` 为只读借用、`online` 为可变借用，且互不重入）。
    fn online_indicators<R>(
        &self,
        f: impl FnOnce(&[Bar], &mut OnlineIndicators) -> R,
    ) -> R {
        let bars = self.bars.borrow();
        let mut online = self.online.borrow_mut();
        f(&bars, &mut online)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(ts: i64, close: f64) -> Bar {
        Bar {
            ts,
            open: close,
            high: close + 1.0,
            low: close - 1.0,
            close,
            volume: 1.0,
        }
    }

    #[test]
    fn push_and_prefix_access() {
        let h = BarHistory::new();
        assert!(h.is_empty());
        h.push(bar(1, 10.0));
        h.push(bar(2, 11.0));
        assert_eq!(h.len(), 2);
        h.with_slice(|s| {
            assert_eq!(s[0].ts, 1);
            assert_eq!(s[1].ts, 2);
        });
    }

    #[test]
    fn from_bars_equals_push_sequence() {
        let bars: Vec<Bar> = (0..30).map(|i| bar(i as i64, 10.0 + i as f64 * 0.1)).collect();
        let a = BarHistory::from_bars(&bars);
        let b = BarHistory::new();
        for x in &bars {
            b.push(x.clone());
        }
        assert_eq!(a.len(), b.len());
        assert_eq!(a.ema(29, 12).map(f64::to_bits), b.ema(29, 12).map(f64::to_bits));
        assert_eq!(a.atr(29, 14).map(f64::to_bits), b.atr(29, 14).map(f64::to_bits));
        assert_eq!(
            a.macd(29, 12, 26, 9).map(|m| m.dif.to_bits()),
            b.macd(29, 12, 26, 9).map(|m| m.dif.to_bits())
        );
    }

    #[test]
    fn indicators_before_data_are_none() {
        let h = BarHistory::new();
        assert!(h.ema(0, 12).is_none());
        h.push(bar(1, 10.0));
        assert!(h.ema(0, 12).is_some(), "ema 自 bar 0 起有值（种子 = close[0]）");
        assert!(h.rsi(0, 14).is_none(), "rsi 数据不足 → None");
        assert!(h.atr(0, 14).is_none(), "atr 数据不足 → None");
    }
}
