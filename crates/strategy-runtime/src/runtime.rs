//! 插件运行时 Port（ABI 02-plugin-abi.md §4，权威签名）。
//!
//! `QuickJsRuntime`（本 crate）为首个实现；未来 WASM 运行时满足同一 trait +
//! 契约测试套件（ADR §9）即可插拔替换（D1）。

use backtest::StrategyParams;

use crate::error::PluginError;
use crate::types::{BarCtx, ParamDef};

/// 插件运行时工厂：按内容哈希 + 源码 + 参数实例化一个插件。
///
/// `code_hash` 为发布版本的 sha256（ABI G4 寻址/留痕用），运行时仅用于错误信息标注，
/// 不参与任何执行语义。
pub trait PluginRuntime {
    fn instantiate(
        &mut self,
        code_hash: &str,
        code: &str,
        params: &StrategyParams,
    ) -> Result<Box<dyn PluginInstance>, PluginError>;
}

/// 单个插件实例（生命周期：eval → init(params) → 每 bar on_bar(ctx) → 可选 save/load）。
///
/// 注意：实现不保证 `Send`（QuickJS 运行时为单线程对象）；bar 内插件间并行由
/// 引擎层按实例拆分调度，不在本 trait 约束内。
pub trait PluginInstance {
    /// 每 bar 评分。host 侧负责 clamp（G6）：有限数值收敛 [0,100]；
    /// NaN/非数值/插件异常/超时/超限 → `Err(PluginError)`，由引擎按 G5 兜底中立分。
    fn on_bar(&mut self, ctx: &BarCtx<'_>) -> Result<f64, PluginError>;

    /// 状态快照（ABI G3 / §4，评审 MAJOR-1 裁决）。
    /// - 插件未定义 `save()` → `Ok(None)`；
    /// - `save()` 抛异常/超时/返回值不可 JSON 序列化/serde 解析失败 → `Err(PluginError)`，
    ///   **不得静默折叠为 `None`**（ADR §10 禁止静默吞错，宿主须可上报错误事件）。
    ///
    /// 成功返回值保证 JSON 可序列化。
    fn save(&self) -> Result<Option<serde_json::Value>, PluginError>;

    /// 恢复状态快照（ABI G3）。插件未定义 `load(state)` 时报错。
    fn load(&mut self, state: &serde_json::Value) -> Result<(), PluginError>;

    /// 插件声明的 `PARAMS_SCHEMA`（ABI §1；未声明则为空）。编辑器/消费方 UI 据此渲染表单。
    fn params_schema(&self) -> &[ParamDef];
}
