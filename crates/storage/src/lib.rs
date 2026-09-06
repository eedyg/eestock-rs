// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/storage/src/lib.rs>>[init]
//! storage —— 基础设施：TimescaleDB 读写（sqlx）。
//! 由 design/04-storage/*.md tangle 生成（ADR-007），禁止手改。

/// crate 编译时版本（settings 页 system-info 展示；由 app 装配 CrateVersions）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod accurate;
pub mod events;
pub mod kline;
pub mod migrate_check;
// reader：应用面只读加法扩展（Wave 1 Phase A，ADR-017 授权口径；代码块在 design/07-app-plane/00-web-api.md）
pub mod reader;
pub mod symbols;
// admin：应用面写/控制通道加法扩展（Wave 1 Phase C：标的管理写 + 熔断复位 DB 通道；
// 代码块在 design/07-app-plane/00-web-api.md）
pub mod admin;
// alerts：告警引擎端口实现加法扩展（Wave 2 Phase B：PgAlertStore + PgAlertEval；
// 代码块在 design/07-app-plane/02-alerts.md）
pub mod alerts;
// system：页面⑧ 设置页 S1 端口实现加法扩展（SystemInfoRead + RawPurgePort；
// 代码块在 design/06-web/08-settings.md）
pub mod system;
// backtest：回测端口实现加法扩展（Wave 3 Phase 3a：BacktestBarRead + BacktestRunStore；
// 代码块在 design/04-storage/schema.md §4.3.5。backtest.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod backtest;
// favorite：看板收藏端口实现加法扩展（Wave 3 页面①：FavoriteStore；
// 代码块在 design/04-storage/schema.md §4.3.6。favorite.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod favorite;
// ~/~ end
