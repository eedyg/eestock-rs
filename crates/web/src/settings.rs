// ~/~ begin <<design/06-web/08-settings.md#crates/web/src/settings.rs>>[init]
//! 页面⑧ 系统设置 S1+S2：系统信息 / 危险运维 / 配置持久化 + PATCH / 只读快照端点（08-settings.md §6）。
//! 由 08-settings.md tangle 生成（ADR-007），禁止手改。
//! S2 边界（本模块）：config 持久化 + PATCH /api/config/{sources,collector,mcp} + GET 读持久（缺则默认）；
//! 日志采集/WS 仍属 S2 后续，本模块不实现。

use axum::{Json, extract::State, http::StatusCode, response::{IntoResponse, Response}};
use domain::ports::SystemInfoRead;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

/// app_config 键名约定（sources/collector/mcp/kline 四块）。
const K_SOURCES: &str = "sources";
const K_COLLECTOR: &str = "collector";
const K_MCP: &str = "mcp";
const K_KLINE: &str = "kline";

/// K线默认视口缺省值（GET 缺 / 解析失败 → 2 交易日；1-50 整数）。
const DEFAULT_KLINE_VIEWPORT_DAYS: i32 = 2;
/// 交易时段写死只读（无合理变更理由，08-settings §3）。
const TRADING_HOURS: &str = "09:30-11:30/13:00-15:00";

/// MCP 配置默认（总开关开 / 交易工具默认关 ADR-009 / 限额 50000·20）。
fn default_mcp() -> McpConfigSnapshotDto {
    McpConfigSnapshotDto { enabled: true, trading_tools_enabled: false,
        daily_limit_amount: 50_000, daily_limit_count: 20 }
}

/// 把持久化的可编辑源参数（按轮转序）合并回完整快照（label/role/rotation_locked 由 SOURCE_CONFIG 派生；
/// 缺省源补默认参数）。轮转序 = items 数组顺序（push2delay 末位，ADR-006 已由 PATCH 校验保证）。
fn merge_source_config(items: &[SourceConfigPatchItemDto]) -> Vec<SourceConfigItemDto> {
    let meta: HashMap<&str, (&str, &str, bool)> = SOURCE_CONFIG
        .iter().map(|&(id, l, r, lock)| (id, (l, r, lock))).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for it in items {
        if let Some(&(label, role, locked)) = meta.get(it.id.as_str()) {
            out.push(SourceConfigItemDto {
                id: it.id.clone(), label: label.into(), role: role.into(),
                rate_per_sec: it.rate_per_sec, jitter_ms: it.jitter_ms,
                circuit_fail_count: it.circuit_fail_count,
                backoff_steps: it.backoff_steps.clone(), enabled: it.enabled,
                rotation_locked: locked,
            });
            seen.insert(it.id.clone());
        }
    }
    // 补齐内置源（未在持久化清单中出现的，按默认参数追加末尾）
    for &(id, label, role, locked) in SOURCE_CONFIG {
        if !seen.contains(id) {
            out.push(SourceConfigItemDto {
                id: id.into(), label: label.into(), role: role.into(),
                rate_per_sec: 1, jitter_ms: 0, circuit_fail_count: 3,
                backoff_steps: vec!["5s".into(), "10s".into(), "30s".into()],
                enabled: true, rotation_locked: locked,
            });
        }
    }
    out
}

/// GET /api/config/sources —— 内置源快照（读持久化；缺 → SETTINGS_DEFAULTS 默认）。
pub async fn get_config_sources(State(st): State<Arc<AppState>>) -> Response {
    match st.config.get(K_SOURCES).await {
        Ok(Some(v)) => match serde_json::from_value::<Vec<SourceConfigPatchItemDto>>(v) {
            Ok(items) => Json(SourceConfigSnapshotDto { sources: merge_source_config(&items) }).into_response(),
            Err(e) => {
                tracing::warn!(error = %e, "sources config parse failed; fallback default");
                Json(SourceConfigSnapshotDto { sources: default_source_config() }).into_response()
            }
        },
        _ => Json(SourceConfigSnapshotDto { sources: default_source_config() }).into_response(),
    }
}

/// PATCH /api/config/sources —— body {sources:[...]}（完整清单 + 轮转序；东财末位校验 ADR-006）。
/// 校验（值域/已知源/无重复/缺源/东财末位）失败 → 400；写库后返回完整快照。
/// 手动反序列化（Json<Value>）以把字段类型错（如 enabled 非布尔）映射为 400 而非 axum 默认 422。
pub async fn patch_config_sources(State(st): State<Arc<AppState>>,
                                  Json(req): Json<serde_json::Value>) -> Response {
    let dto: SourceConfigPatchDto = match serde_json::from_value(req) {
        Ok(d) => d,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("sources 请求体非法：{e}")),
    };
    if let Err(e) = validate_source_config(&dto) { return err(StatusCode::BAD_REQUEST, &e); }
    let items = dto.sources;
    let value = match serde_json::to_value(&items) {
        Ok(v) => v,
        Err(e) => return internal(e.into()),
    };
    if let Err(e) = st.config.set(K_SOURCES, value).await { return internal(e); }
    Json(SourceConfigSnapshotDto { sources: merge_source_config(&items) }).into_response()
}

/// GET /api/config/collector —— 采集参数快照（读持久化；缺 → 默认 60s + 写死交易时段）。
pub async fn get_config_collector(State(st): State<Arc<AppState>>) -> Response {
    match st.config.get(K_COLLECTOR).await {
        Ok(Some(v)) => match serde_json::from_value::<CollectorConfigPatchDto>(v) {
            Ok(c) => Json(CollectorConfigSnapshotDto {
                default_interval_sec: c.default_interval_sec, trading_hours: TRADING_HOURS.into() }).into_response(),
            Err(e) => {
                tracing::warn!(error = %e, "collector config parse failed; fallback default");
                Json(CollectorConfigSnapshotDto { default_interval_sec: 60, trading_hours: TRADING_HOURS.into() }).into_response()
            }
        },
        _ => Json(CollectorConfigSnapshotDto { default_interval_sec: 60, trading_hours: TRADING_HOURS.into() }).into_response(),
    }
}

/// PATCH /api/config/collector —— body {default_interval_sec}（≥60 校验 → 400），写库返回快照。
pub async fn patch_config_collector(State(st): State<Arc<AppState>>,
                                    Json(req): Json<serde_json::Value>) -> Response {
    let dto: CollectorConfigPatchDto = match serde_json::from_value(req) {
        Ok(d) => d,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("collector 请求体非法：{e}")),
    };
    if let Err(e) = verify_collector_interval(dto.default_interval_sec) {
        return err(StatusCode::BAD_REQUEST, &e);
    }
    let value = match serde_json::to_value(&dto) { Ok(v) => v, Err(e) => return internal(e.into()) };
    if let Err(e) = st.config.set(K_COLLECTOR, value).await { return internal(e); }
    Json(CollectorConfigSnapshotDto { default_interval_sec: dto.default_interval_sec, trading_hours: TRADING_HOURS.into() }).into_response()
}

/// GET /api/config/mcp —— MCP 配置快照（读持久化；缺 → 默认）。
pub async fn get_config_mcp(State(st): State<Arc<AppState>>) -> Response {
    match st.config.get(K_MCP).await {
        Ok(Some(v)) => match serde_json::from_value::<McpConfigPatchDto>(v) {
            Ok(m) => Json(McpConfigSnapshotDto {
                enabled: m.enabled, trading_tools_enabled: m.trading_tools_enabled,
                daily_limit_amount: m.daily_limit_amount, daily_limit_count: m.daily_limit_count }).into_response(),
            Err(e) => {
                tracing::warn!(error = %e, "mcp config parse failed; fallback default");
                Json(default_mcp()).into_response()
            }
        },
        _ => Json(default_mcp()).into_response(),
    }
}

/// PATCH /api/config/mcp —— body {enabled, trading_tools_enabled, daily_limit_amount, daily_limit_count}。
/// 校验（金额/笔数 ≥0）失败 → 400；写库返回快照。
pub async fn patch_config_mcp(State(st): State<Arc<AppState>>,
                              Json(req): Json<serde_json::Value>) -> Response {
    let dto: McpConfigPatchDto = match serde_json::from_value(req) {
        Ok(d) => d,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("mcp 请求体非法：{e}")),
    };
    if let Err(e) = verify_mcp_daily_limit(&dto) { return err(StatusCode::BAD_REQUEST, &e); }
    let value = match serde_json::to_value(&dto) { Ok(v) => v, Err(e) => return internal(e.into()) };
    if let Err(e) = st.config.set(K_MCP, value).await { return internal(e); }
    Json(McpConfigSnapshotDto {
        enabled: dto.enabled, trading_tools_enabled: dto.trading_tools_enabled,
        daily_limit_amount: dto.daily_limit_amount, daily_limit_count: dto.daily_limit_count }).into_response()
}

/// GET /api/config/kline 响应/请求体：K线默认视口（app_config key "kline"，迁移 0021；缺省 2）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KlineConfigDto {
    /// 默认视口的交易日数（1-50 整数；每周期实际 bar = 该周期每日 bar 数 × viewport_days）。
    pub viewport_days: i32,
}

/// viewport_days 校验（纯函数）：整数 1..=50；失败返回描述性错误（handler `err(400, e)`）。
pub fn verify_kline_viewport_days(viewport_days: i32) -> Result<(), String> {
    if !(1..=50).contains(&viewport_days) {
        return Err(format!("viewport_days 须为 1..=50 整数，收到 {viewport_days}"));
    }
    Ok(())
}

/// GET /api/config/kline —— 读 K线默认视口（app_config key "kline"；缺/解析失败 → 默认 2）。
pub async fn get_config_kline(State(st): State<Arc<AppState>>) -> Response {
    match st.config.get(K_KLINE).await {
        Ok(Some(v)) => match serde_json::from_value::<KlineConfigDto>(v) {
            Ok(c) => Json(KlineConfigDto { viewport_days: c.viewport_days }).into_response(),
            Err(e) => {
                tracing::warn!(error = %e, "kline config parse failed; fallback default");
                Json(KlineConfigDto { viewport_days: DEFAULT_KLINE_VIEWPORT_DAYS }).into_response()
            }
        },
        _ => Json(KlineConfigDto { viewport_days: DEFAULT_KLINE_VIEWPORT_DAYS }).into_response(),
    }
}

/// PUT /api/config/kline —— body {viewport_days}：校验（整数 1-50）失败 400；落库返回。
pub async fn put_config_kline(State(st): State<Arc<AppState>>,
                              Json(req): Json<serde_json::Value>) -> Response {
    let dto: KlineConfigDto = match serde_json::from_value(req) {
        Ok(d) => d,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("kline 请求体非法：{e}")),
    };
    if let Err(e) = verify_kline_viewport_days(dto.viewport_days) {
        return err(StatusCode::BAD_REQUEST, &e);
    }
    let value = match serde_json::to_value(&dto) { Ok(v) => v, Err(e) => return internal(e.into()) };
    if let Err(e) = st.config.set(K_KLINE, value).await { return internal(e); }
    Json(KlineConfigDto { viewport_days: dto.viewport_days }).into_response()
}

/// 内置源快照（id, label, role, rotation_locked）。非近似变体 = 数据面真实注册源。
/// 轮转序 = 数组顺序；push2delay（东财系，ADR-006）锁定末位。
const SOURCE_CONFIG: &[(&str, &str, &str, bool)] = &[
    ("tencent_ifzq", "腾讯ifzq", "1m", false),
    ("sina_jsonp", "新浪jsonp", "1m", false),
    ("tencent_qt", "腾讯qt", "snapshot", false),
    ("sina_hq", "新浪hq", "snapshot", false),
    ("ths_cs", "同花顺", "snapshot", false),
    ("exchange", "交易所", "snapshot", false),
    ("tushare", "tushare（历史层）", "snapshot", false),
    ("push2delay", "push2delay（东财系）", "snapshot", true), // ADR-006 锁定末位
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
        // 东财末位（ADR-006 对齐）：push2delay 必须为最后一个元素（默认轮转序与 PATCH 校验一致）
        assert_eq!(cfg.last().unwrap().id, "push2delay", "push2delay 默认锁定末位（ADR-006）");
    }

    #[test]
    fn reset_sources_are_real_non_approx() {
        assert!(!RESET_SOURCES.contains(&"tencent_qt_approx"));
        assert!(!RESET_SOURCES.contains(&"push2delay_approx"));
        assert!(RESET_SOURCES.contains(&"tencent_ifzq"));
    }

    #[test]
    fn kline_viewport_days_validation() {
        assert!(verify_kline_viewport_days(2).is_ok());
        assert!(verify_kline_viewport_days(10).is_ok());
        assert!(verify_kline_viewport_days(1).is_ok(), "下界 1 合法");
        assert!(verify_kline_viewport_days(50).is_ok(), "上界 50 合法");
        assert!(verify_kline_viewport_days(0).is_err(), "0 → 拒");
        assert!(verify_kline_viewport_days(51).is_err(), "51 → 拒");
        assert!(verify_kline_viewport_days(-1).is_err(), "负值 → 拒");
    }

    #[test]
    fn kline_config_dto_roundtrip_and_non_integer_rejected() {
        let dto = KlineConfigDto { viewport_days: 10 };
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["viewport_days"], 10);
        let back: KlineConfigDto = serde_json::from_value(v).unwrap();
        assert_eq!(back.viewport_days, 10);
        // 非整（10.5）反序列化为 i32 失败 → 上层 handler 映射 400
        assert!(serde_json::from_value::<KlineConfigDto>(serde_json::json!({"viewport_days": 10.5})).is_err());
        // 缺字段 → 反序列化失败
        assert!(serde_json::from_value::<KlineConfigDto>(serde_json::json!({})).is_err());
    }
}
