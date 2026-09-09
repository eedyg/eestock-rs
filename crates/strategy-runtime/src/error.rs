//! 插件错误类型（ABI 02-plugin-abi.md §3 确定性守卫 G1/G2/G6 的宿主侧表达）。
//!
//! 语义对应：
//! - [`PluginError::JsException`]：插件 JS 抛出的普通异常（G5 异常隔离的处理对象）。
//! - [`PluginError::Timeout`]：`on_bar`/`init`/`load` 单次调用超 per-call 限时（G2），
//!   由 QuickJS interrupt handler 打断产生。
//! - [`PluginError::MemoryExceeded`]：插件触发内存硬上限（G2）。
//! - [`PluginError::CapabilityViolation`]：插件引用被禁能力（G1：Date/Math.random/timer 等）。
//! - [`PluginError::InvalidScore`]：`on_bar` 返回 NaN/无穷/非数值（G6）。
//! - [`PluginError::SchemaError`]：`PARAMS_SCHEMA` 声明缺失/格式非法（ABI §1）。

use std::time::Duration;

/// 插件生命周期各阶段可能产生的错误（引擎按 G5 做中立分兜底/熔断，不得向上中断运行）。
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PluginError {
    /// 插件 JS 异常（含语法错误、运行时 throw、缺失必需钩子等）。
    #[error("插件 JS 异常: {0}")]
    JsException(String),
    /// 单次调用超时（G2）。携带本次生效的限时。
    #[error("插件调用超时（上限 {0:?}，G2）")]
    Timeout(Duration),
    /// 触发内存硬上限（G2）。
    #[error("插件内存超限（G2）")]
    MemoryExceeded,
    /// 引用沙箱禁用能力（G1）。信息中指明被禁能力名。
    #[error("能力禁区违规（G1）: {0}")]
    CapabilityViolation(String),
    /// `on_bar` 返回值非法：NaN / 无穷 / 非数值（G6）。
    #[error("插件返回值非法（G6）: {0}")]
    InvalidScore(String),
    /// `PARAMS_SCHEMA` 声明非法（ABI §1）。
    #[error("PARAMS_SCHEMA 非法: {0}")]
    SchemaError(String),
    /// `on_bar` 路径错误包装（ABI §3 G5 / 评审 MINOR-2 裁决）：
    /// 错误事件自含 sha256（code_hash）+ bar_index，引擎落 run 事件流无需额外补全。
    /// 根本原因用 [`PluginError::root_cause`] 剥离包装获取。
    #[error("插件 {code_hash} bar {bar_index} 出错: {source}")]
    OnBar {
        /// 发布版本 sha256（G4 寻址/留痕）。
        code_hash: String,
        /// 出错 bar 序号（0 起）。
        bar_index: usize,
        /// 根本错误（Timeout/MemoryExceeded/JsException/CapabilityViolation/InvalidScore）。
        source: Box<PluginError>,
    },
}

impl PluginError {
    /// 构造 `on_bar` 路径错误包装（G5：自含 sha256 + bar_index）。
    pub(crate) fn on_bar(code_hash: &str, bar_index: usize, source: PluginError) -> Self {
        Self::OnBar {
            code_hash: code_hash.to_string(),
            bar_index,
            source: Box::new(source),
        }
    }

    /// 剥离 `OnBar` 包装取根本错误（错误归类/引擎熔断计数断言用）。
    pub fn root_cause(&self) -> &PluginError {
        match self {
            PluginError::OnBar { source, .. } => source.root_cause(),
            other => other,
        }
    }
}
