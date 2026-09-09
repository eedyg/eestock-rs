//! # application —— 应用层服务（手写，非 tangle；ADR-007）。
//!
//! P4b（D16 终章，旧系统退役）：旧回测 `BacktestService`（异步任务队列 + 进度上报）已物理删除——
//! 回测能力由 `workbench::WorkbenchService`（统一 ensemble 引擎，12-strategy-system）全覆盖，
//! 详见 design/12-strategy-system/01-adr.md §13.8。保留共享件：`fee`（费用映射）与
//! `bar_map`（周期解析 + `domain::Bar -> backtest::Bar` 映射，试算/工作台复用同口径）。
//!
//! 依赖注入 domain 端口 + `backtest`/`strategy-core`/`simlive` 纯逻辑 crate；
//! **不依赖 web/storage**（差异在哪层均不反向依赖基础设施，DI 由 app bin 装配）。

pub mod bar_map;
pub mod fee;
pub mod simlive; // 11-sim-live / L1：模拟实盘服务（SimLiveService，手写，非 tangle）
pub mod simlive_orch; // 12-strategy-system / P4a：插件编排器 worker 线程承载壳（actor 模式，手写，非 tangle）
pub mod simlive_feed; // 11-sim-live / L4（F2）：实时评分 feed（poll 式，接入 KlineRead→process_bar；手写，非 tangle）
pub mod strategy; // 12-strategy-system / P2a：策略 Registry 服务（StrategyService，手写，非 tangle）
pub mod workbench; // 12-strategy-system / P3a：回测工作台服务（WorkbenchService 任务制 ensemble，手写，非 tangle）
