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
    pub static_dir: PathBuf,
    /// /api/sources/health 与 WS health 推送的默认窗口（秒）。
    pub health_window_secs: i64,
    pub hub: crate::ws::WsHub,
    pub subs: crate::ws::SubscriptionRegistry,
}
// ~/~ end
