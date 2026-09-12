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
// backtest：回测取数端口实现（Wave 3 Phase 3a：BacktestBarRead；P4b 起 BacktestRunStore 随旧回测服务退役删除，
// BacktestBarReader 保留供 strategy 试算 / workbench / mcp 复用；
// 代码块在 design/04-storage/schema.md §4.3.5。backtest.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod backtest;
// favorite：看板收藏端口实现加法扩展（Wave 3 页面①：FavoriteStore；
// 代码块在 design/04-storage/schema.md §4.3.6。favorite.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod favorite;
// ma_config：行情看板 MA 可配置端口实现加法扩展（后端 W1：MaConfigStore；
// 代码块在 design/04-storage/schema.md §4.3.7。ma_config.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod ma_config;
// config_store：页面⑧ 系统设置 S2 配置持久化端口实现加法扩展（ConfigStore，app_config 表，迁移 0021；
// 代码块在 design/04-storage/schema.md。config_store.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod config_store;
// sim：模拟实盘会话存储端口实现加法扩展（L1 sim-live：SimSessionStore；
// 代码块在 design/04-storage/schema.md §4.3.10。sim.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod sim;
// strategy：策略 Registry 存储端口实现加法扩展（12-strategy-system / P2a：StrategyStore；
// 代码块在 design/04-storage/schema.md §4.3.13。strategy.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod strategy;
// workbench：回测工作台存储端口实现加法扩展（12-strategy-system / P3a：StrategyRunStore + StrategyPresetStore；
// 代码块在 design/04-storage/schema.md §4.3.14。workbench.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod workbench;
// fee_profile：按标的类型推断费率档案端口实现加法扩展（ADR-019 / D11：FeeProfileStore，fee_profiles 表，迁移 0025；
// 代码块在 design/04-storage/schema.md §4.3.16。fee_profile.rs 本身为非 tangle 手写，此处仅注册模块）
pub mod fee_profile;
// ~/~ end
