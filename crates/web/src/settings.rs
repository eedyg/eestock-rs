// ~/~ begin <<design/06-web/08-settings.md#crates/web/src/settings.rs>>[init]
//! 页面⑧ 系统设置 S1：系统信息 / 危险运维 / 只读配置快照端点（08-settings.md §6）。
//! 由 08-settings.md tangle 生成（ADR-007），禁止手改。
//! S1 边界：只读 + 运维；配置持久化（PATCH /api/config/*）与日志采集/WS 属 S2，本模块不实现。

use axum::{Json, extract::State, http::StatusCode, response::{IntoResponse, Response}};
use domain::ports::SystemInfoRead;
use std::sync::Arc;

use crate::dto::*;
use crate::state::AppState;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "settings handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// 系统信息数据源（app 装配注入；web 不依赖 collector/storage，版本走 DI）。
pub struct SystemInfoSource {
    pub app_version: String,
    pub crate_versions: CrateVersions,
    pub db: Arc<dyn SystemInfoRead>,
    pub started_at: std::time::Instant,
}

/// GET /api/system/info —— 应用/crate 版本、DB 状态、运行时长（只读）。
pub async fn system_info(State(st): State<Arc<AppState>>) -> Response {
    let db_ok = st.system_info.db.ping().await.is_ok();
    let uptime_secs = st.system_info.started_at.elapsed().as_secs();
    Json(SystemInfoDto {
        app_version: st.system_info.app_version.clone(),
        crate_versions: st.system_info.crate_versions.clone(),
        db_ok,
        uptime_secs,
    })
    .into_response()
}

/// POST /api/system/purge-raw —— 清空 kline_raw（危险；confirm 须为 PURGE，否则 400）。
pub async fn purge_raw(State(st): State<Arc<AppState>>, Json(req): Json<ConfirmReq>) -> Response {
    if req.confirm.as_deref() != Some("PURGE") {
        return err(StatusCode::BAD_REQUEST, "confirm 须为 PURGE（危险操作：清空 kline_raw）");
    }
    match st.raw_purge.purge_raw().await {
        Ok(rows) => Json(PurgeRawResultDto { rows_deleted: rows }).into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/system/reset-circuits —— 全部内置源熔断状态重置（危险；confirm 须为 RESET，否则 400）。
/// 复用既有熔断复位 DB 控制通道（ADR-017）：对 RESET_SOURCES 逐源写 circuit_reset_requests。
pub async fn reset_circuits(State(st): State<Arc<AppState>>, Json(req): Json<ConfirmReq>) -> Response {
    if req.confirm.as_deref() != Some("RESET") {
        return err(StatusCode::BAD_REQUEST, "confirm 须为 RESET（危险操作：全部源熔断重置）");
    }
    let mut n = 0usize;
    for &s in RESET_SOURCES {
        match st.resets.request_reset(s).await {
            Ok(()) => n += 1,
            Err(e) => return internal(e),
        }
    }
    Json(ResetCircuitsResultDto { requests: n }).into_response()
}

/// GET /api/config/sources —— 内置源只读快照（值 = SETTINGS_DEFAULTS 默认；S1 不落库）。
pub async fn get_config_sources() -> Response {
    Json(SourceConfigSnapshotDto { sources: default_source_config() }).into_response()
}

/// GET /api/config/collector —— 采集参数只读快照（默认间隔 + 写死交易时段）。
pub async fn get_config_collector() -> Response {
    Json(CollectorConfigSnapshotDto {
        default_interval_sec: 60,
        trading_hours: "09:30-11:30/13:00-15:00".into(),
    })
    .into_response()
}

/// GET /api/config/mcp —— MCP 配置只读快照（总开关/交易工具/每日限额默认值）。
pub async fn get_config_mcp() -> Response {
    Json(McpConfigSnapshotDto {
        enabled: true,
        trading_tools_enabled: false,
        daily_limit_amount: 50_000,
        daily_limit_count: 20,
    })
    .into_response()
}

/// 内置源快照（id, label, role, rotation_locked）。非近似变体 = 数据面真实注册源。
const SOURCE_CONFIG: &[(&str, &str, &str, bool)] = &[
    ("tencent_ifzq", "腾讯ifzq", "1m", false),
    ("sina_jsonp", "新浪jsonp", "1m", false),
    ("tencent_qt", "腾讯qt", "snapshot", false),
    ("sina_hq", "新浪hq", "snapshot", false),
    ("ths_cs", "同花顺", "snapshot", false),
    ("push2delay", "push2delay（东财系）", "snapshot", true), // ADR-006 锁定末位
    ("exchange", "交易所", "snapshot", false),
    ("tushare", "tushare（历史层）", "snapshot", false),
];

/// SETTINGS_DEFAULTS（08-settings.md L3）默认值：1 req/s / 熔断 3 / 退避 5s→10s→30s。
fn default_source_config() -> Vec<SourceConfigItemDto> {
    SOURCE_CONFIG
        .iter()
        .map(|&(id, label, role, locked)| SourceConfigItemDto {
            id: id.into(),
            label: label.into(),
            role: role.into(),
            rate_per_sec: 1,
            jitter_ms: 0,
            circuit_fail_count: 3,
            backoff_steps: vec!["5s".into(), "10s".into(), "30s".into()],
            enabled: true,
            rotation_locked: locked,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_source_config_has_all_real_and_rotation_lock() {
        let cfg = default_source_config();
        assert_eq!(cfg.len(), RESET_SOURCES.len(), "源清单与 reset-circuits 同构");
        assert!(cfg.iter().any(|s| s.id == "push2delay" && s.rotation_locked));
        assert!(cfg.iter().all(|s| s.rate_per_sec == 1 && s.circuit_fail_count == 3));
        assert!(cfg.iter().all(|s| s.backoff_steps == vec!["5s", "10s", "30s"]));
    }

    #[test]
    fn reset_sources_are_real_non_approx() {
        assert!(!RESET_SOURCES.contains(&"tencent_qt_approx"));
        assert!(!RESET_SOURCES.contains(&"push2delay_approx"));
        assert!(RESET_SOURCES.contains(&"tencent_ifzq"));
    }
}
