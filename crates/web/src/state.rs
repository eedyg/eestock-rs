// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/src/state.rs>>[init]
//! 应用状态：DI 装配产物（app crate 注入具体实现）。
//! 分层红线（Phase A 审查返工）：web 只见 domain 端口 + diagnose 服务，不依赖 storage/sqlx。

use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    /// K线只读端口（domain::ports::KlineRead；具体实现由 app 装配，storage 提供）。
    pub kline: Arc<dyn domain::ports::KlineRead>,
    /// 健康查询服务（diagnose；内部注入 domain::ports::HealthEventsRead）。
    pub health: diagnose::health::HealthService,
    /// 标的管理写端口（Phase C：POST/PATCH /api/symbols；DB 控制通道，ADR-017）。
    pub symbols_admin: Arc<dyn domain::ports::SymbolAdminWrite>,
    /// 标的当日统计只读端口（Phase C：GET /api/symbols?with_stats=1）。
    pub symbol_stats: Arc<dyn domain::ports::SymbolStatsRead>,
    /// 熔断复位写端口（Phase C：POST /api/sources/{id}/reset；DB 控制通道）。
    pub resets: Arc<dyn domain::ports::CircuitResetWrite>,
    /// 数据质量服务（Wave 2 Phase A：diagnose::quality，页面④ 三端点 + tushare status 数据源）。
    pub quality: diagnose::quality::QualityService,
    /// 告警引擎服务（Wave 2 Phase B：alert crate，Application 层；02-alerts.md）。
    /// 评估节拍由 web::alerts::AlertEvaluator 驱动；本字段供 REST handlers 查询/确认/规则调整。
    pub alerts: alert::engine::AlertService,
    /// 页面⑧ 系统信息数据源（S1：版本/DB 探测/运行时长；08-settings.md）。
    pub system_info: crate::settings::SystemInfoSource,
    /// 页面⑧ raw 层清空端口（S1：POST /api/system/purge-raw；08-settings.md）。
    pub raw_purge: Arc<dyn domain::ports::RawPurgePort>,
    /// 回测服务（Wave 3 Phase 3c：application 层 BacktestService，§1.5；app bin 装配）。
    pub backtest: Arc<application::service::BacktestService>,
    /// 回测 WS 进度分发 sink（Wave 3 Phase 3c：web 实现 domain::ports::BacktestProgressSink，§1.5）。
    pub backtest_ws: Arc<dyn domain::ports::BacktestProgressSink>,
    /// 看板收藏端口（Wave 3 页面①：FavoriteStore，favorite_symbols 表，0013；POST/DELETE/PUT 收藏端点 + /api/symbols 注入）。
    pub favorites: Arc<dyn domain::ports::FavoriteStore>,
    /// 行情看板 MA 可配置端口（后端 W1：MaConfigStore，ma_config 表，0015；GET/PUT /api/config/ma——主图+宫格应用，回测弹窗不动）。
    pub ma_config: Arc<dyn domain::ports::MaConfigStore>,
    /// 模拟实盘服务（11-sim-live / L3b：web 面板 /api/sim-live/*；与 MCP 共享同一 SimLiveService 实例）。
    /// `None` = 未配置，/api/sim-live/* 返回 503。storage::sim::PgSimSessionStore 由 app bin 装配。
    pub sim: Option<Arc<application::simlive::SimLiveService>>,
    pub static_dir: PathBuf,
    /// /api/sources/health 与 WS health 推送的默认窗口（秒）。
    pub health_window_secs: i64,
    pub hub: crate::ws::WsHub,
    pub subs: crate::ws::SubscriptionRegistry,
}
// ~/~ end
