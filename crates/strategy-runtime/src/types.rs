//! 宿主侧 ABI 类型：`RuntimeLimits` / `BarCtx` / `PositionSnapshot` / `ParamDef`。
//!
//! 权威契约：02-plugin-abi.md §2（ctx 注入对象）、§2.5（持仓全景，D9）、§3（G2 限额）、
//! §1（PARAMS_SCHEMA 声明式参数 schema）。

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use backtest::Bar;
use serde::{Deserialize, Serialize};

/// 运行时限额（ABI §3 G2；RunConfig 级可配，测试可收紧）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeLimits {
    /// 单次插件调用（`on_bar`/`save`/`load`）限时，超时由 interrupt handler 打断。
    /// 默认 50ms（ABI G2）。
    pub per_call_timeout: Duration,
    /// 实例化阶段（eval 源码 + `init(params)`）独立限时（NIT-7 裁决）：
    /// 与 per-call 时限解耦，默认 max(per_call_timeout × 20, 1s)。
    pub instantiate_timeout: Duration,
    /// QuickJS 运行时内存硬上限（字节）。默认 64MB（ABI G2）。
    pub memory_limit: usize,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        let per_call_timeout = Duration::from_millis(50);
        Self {
            per_call_timeout,
            instantiate_timeout: (per_call_timeout * 20).max(Duration::from_secs(1)),
            memory_limit: 64 * 1024 * 1024,
        }
    }
}

/// 持仓全景快照（ABI §2.5，D9 增补；只读。纯试算模式下恒 `None`）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PositionSnapshot {
    /// 当前持仓股数。
    pub qty: f64,
    /// 摊薄成本价。
    pub avg_cost: f64,
    /// 首次建仓时间（Unix 秒）。
    pub entry_ts: i64,
    /// 建仓以来经过的 bar 数（定投节奏/门控用）。
    pub bars_since_entry: u64,
    /// 浮动盈亏（金额）。
    pub unrealized_pnl: f64,
}

/// `on_bar` 的宿主侧上下文（对应 ABI §2 注入的 JS `ctx` 对象）。
///
/// - `bars` 为**全量历史序列**（至少到 `index`），指标按 `bars[0..=index]` 惰性计算，
///   口径与 `backtest::Indicators` 完全一致（插件不可自行取数，G1）。
/// - `logs` 为 `ctx.log(msg)` 的宿主侧归集 sink（ABI §2：log 是插件唯一副作用通道，
///   落 run 事件流；不在 JS 内直接 tracing）。调用方在 `on_bar` 返回后 [`BarCtx::take_logs`] 取走。
#[derive(Debug)]
pub struct BarCtx<'a> {
    /// 当前 bar 序号（0 起）。
    pub index: usize,
    /// 当前 bar（OHLCV + ts，Unix 秒）。
    pub bar: Bar,
    /// 全量 bar 序列（指标窗口取 `bars[0..=index]`）。
    pub bars: &'a [Bar],
    /// 持仓全景；纯评分试算模式恒 `None`（ABI §2.5）。
    pub position: Option<PositionSnapshot>,
    /// 日志 sink 用 `Rc<RefCell>`：JS 侧 `ctx.log` 闭包需持有 'static 句柄
    /// （rquickjs 回调生命周期约束），宿主与沙箱共享同一归集缓冲。
    logs: Rc<RefCell<Vec<String>>>,
}

impl<'a> BarCtx<'a> {
    pub fn new(index: usize, bar: Bar, bars: &'a [Bar], position: Option<PositionSnapshot>) -> Self {
        debug_assert!(index < bars.len(), "BarCtx.index 必须在 bars 范围内");
        Self {
            index,
            bar,
            bars,
            position,
            logs: Rc::new(RefCell::new(Vec::new())),
        }
    }

    /// 归集一条插件日志（宿主侧 sink；由运行时在 JS `ctx.log` 回调中调用）。
    pub fn push_log(&self, msg: String) {
        self.logs.borrow_mut().push(msg);
    }

    /// 取走并清空本次调用归集的日志。
    pub fn take_logs(&self) -> Vec<String> {
        self.logs.borrow_mut().drain(..).collect()
    }

    /// 日志 sink 的共享句柄（供运行时注入 JS 闭包）。
    pub(crate) fn log_sink(&self) -> Rc<RefCell<Vec<String>>> {
        self.logs.clone()
    }
}

/// 参数 schema 类型（ABI §1：`type: "int" | "float"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamKind {
    Int,
    Float,
}

/// 单个参数声明（ABI §1 `PARAMS_SCHEMA` 数组元素；serde 可序列化，Registry JSONB 落库用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParamDef {
    pub key: String,
    /// NIT-1 裁决：serde 字段名与 ABI §1 对齐为 `"type"`。
    #[serde(rename = "type")]
    pub kind: ParamKind,
    pub default: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 评分 clamp（ABI G6）：仅对**有限**数值收敛到 [0,100]；NaN/无穷由调用方按异常处理。
pub(crate) fn clamp_score(v: f64) -> f64 {
    debug_assert!(v.is_finite(), "clamp_score 只接受有限数值");
    v.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_boundaries() {
        assert_eq!(clamp_score(-5.0), 0.0);
        assert_eq!(clamp_score(150.0), 100.0);
        assert_eq!(clamp_score(0.0), 0.0);
        assert_eq!(clamp_score(100.0), 100.0);
        assert_eq!(clamp_score(42.5), 42.5);
    }

    #[test]
    fn default_limits_match_abi() {
        let l = RuntimeLimits::default();
        assert_eq!(l.per_call_timeout, Duration::from_millis(50));
        assert_eq!(l.memory_limit, 64 * 1024 * 1024);
        // NIT-7：实例化时限独立且更宽 = max(per_call×20, 1s)。
        assert_eq!(l.instantiate_timeout, Duration::from_secs(1));
        assert_eq!(
            l.instantiate_timeout,
            (l.per_call_timeout * 20).max(Duration::from_secs(1))
        );
    }
}
