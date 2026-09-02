//! domain —— 纯领域层（手写例外：本模块声明文件为工程基建，不 tangle）。
//! 各模块源码由 design/02-domain/contracts.md 经 `entangled tangle` 单向生成，禁止手改。

pub mod merge;
pub mod ports;
pub mod provider;
pub mod selector;
pub mod types;
