//! # application —— 应用层：回测 `BacktestService`（异步任务队列 + 真实进度上报）。
//!
//! ADR-007：本 crate 为**手写**新 crate（非 tangle 生成）。权威依据 `design/08-backtest/01-engine-adr.md` §7。
//! 依赖注入 domain 端口（`BacktestBarRead`/`BacktestRunStore`/`BacktestProgressSink`）+ `backtest` crate；
//! **不依赖 web/storage**（差异在哪层均不反向依赖基础设施，DI 由 app bin / 阶段 3c 装配）。
//!
//! 分层红线：本层负责 `domain::Bar -> backtest::Bar` 映射、`backtest::run_with_progress` 的进度上报桥接、
//! `backtest::BacktestResult -> domain::RunResult` 拆分；`backtest` crate 保持纯逻辑无 IO。

pub mod fee;
pub mod params;
pub mod service;
pub mod simlive; // 11-sim-live / L1：模拟实盘服务（SimLiveService，手写，非 tangle）
pub mod simlive_feed; // 11-sim-live / L4（F2）：实时评分 feed（poll 式，接入 KlineRead→process_bar；手写，非 tangle）
pub mod strategy; // 12-strategy-system / P2a：策略 Registry 服务（StrategyService，手写，非 tangle）
pub mod workbench; // 12-strategy-system / P3a：回测工作台服务（WorkbenchService 任务制 ensemble，手写，非 tangle）
pub mod types;
