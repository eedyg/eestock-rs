//! # strategy-runtime —— 策略插件运行时（12-strategy-system P0，手写，非 tangle）。
//!
//! ## 定位
//! eestock-rs 统一策略系统的 Domain 层组件（ADR `design/12-strategy-system/01-adr.md` §3）：
//! 同一策略内核驱动回测/模拟实盘/实盘（实盘本期仅架构预留）。本 crate 提供
//! [`PluginRuntime`] / [`PluginInstance`] Port（ABI §4）与首个实现 [`QuickJsRuntime`]
//! （ADR D1：QuickJS 先行，WASM 未来可替换——满足同一 trait + 契约测试套件即可插拔）。
//!
//! ## 权威契约
//! `design/12-strategy-system/02-plugin-abi.md` 是插件 ABI 的**唯一权威契约**：
//! - 生命周期：eval 源码 → 读取全局 `PARAMS_SCHEMA`（可选）→ `init(params)`（可选）
//!   → 每 bar `on_bar(ctx) → f64` → 可选 `save()/load(state)`（JSON round-trip，G3）。
//! - ctx 注入（§2/§2.5）：index / params（冻结）/ bar / indicators（host 侧复用
//!   `backtest::Indicators`，口径与 Rust 内建策略一致）/ position（只读持仓全景，
//!   纯试算恒 null）/ log（归集宿主侧 sink，插件唯一副作用通道）。
//! - 返回值（G6）：有限数值 clamp [0,100]；NaN/非数值 → [`PluginError::InvalidScore`]。
//!
//! ## 确定性守卫（机制强制，ADR §4 / ABI §3）
//! - G1 能力禁区：intrinsics 裁剪（不注入 Date/Eval/Performance/Promise 等）+
//!   Math.random 抛错桩；引用即异常 → [`PluginError::CapabilityViolation`]。
//! - G2 限额：interrupt handler + 单调时钟实现 per-call 超时（默认 50ms）→
//!   [`PluginError::Timeout`]；内存硬上限（默认 64MB）→ [`PluginError::MemoryExceeded`]。
//!   本 crate 唯一时钟用途即 interrupt 超时（分层红线豁免项）。
//! - G5 异常隔离：插件一切错误以 `Err(PluginError)` 上报，由引擎层记中立分 50/熔断；
//!   本 crate 自身永不 panic 中断运行（契约测试以引擎循环模拟锁定该语义）。
//!
//! ## 分层红线
//! 无 IO / 无 DB / 无网络；不依赖 web/storage/application/mcp；仅复用 `backtest` 的
//! Bar / Indicators / StrategyParams / ParamValue（参照 simlive 做法，保持指标口径一致）。

pub mod error;
pub mod quickjs;
pub mod runtime;
pub mod types;

// 常用类型再导出，方便应用层 `use strategy_runtime::*;`。
pub use error::PluginError;
pub use quickjs::{QuickJsInstance, QuickJsRuntime};
pub use runtime::{PluginInstance, PluginRuntime};
pub use types::{BarCtx, ParamDef, ParamKind, PositionSnapshot, RuntimeLimits};

// 复用 backtest 数据/参数类型（ABI §2 指标口径一致），避免上层重复依赖。
pub use backtest::{Bar, ParamValue, StrategyParams};
