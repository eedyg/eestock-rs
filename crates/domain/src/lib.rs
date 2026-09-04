//! domain —— 纯领域层（手写例外：本模块声明文件为工程基建，不 tangle）。
//! 各模块源码由 design/02-domain/contracts.md 经 `entangled tangle` 单向生成，禁止手改。

pub mod merge;
pub mod ports;
// calendar：交易日历分钟标签口径（Wave 2 Phase A 加法；代码块在 contracts.md §2.8）
pub mod calendar;
pub mod provider;
pub mod selector;
pub mod types;
pub mod tz;
