// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/app/src/app_config.rs>>[init]
//! 应用面配置：TOML 文件 + 环境变量覆盖（DATABASE_URL / APP_LISTEN）。
//! 与数据面 DataConfig 并列（同文件级惯例：secret 走 env，不落配置文件）。

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub database_url: String,
    /// 监听地址（REST/WS/SPA 同端口）
    #[serde(default = "default_listen")]
    pub listen: String,
    /// SPA 静态目录（容器 /app/dist；本地 ./web/dist）
    #[serde(default = "default_static_dir")]
    pub static_dir: String,
    /// /api/sources/health 与 WS health 推送的默认统计窗口（秒）
    #[serde(default = "default_health_window")]
    pub health_window_secs: i64,
    /// WS 推送轮询周期（毫秒）
    #[serde(default = "default_ws_poll_ms")]
    pub ws_poll_ms: u64,
    /// MCP HTTP/SSE 监听地址（Wave 1 Phase D，ADR-009；与 web 同进程、端口独立，仅局域网）
    #[serde(default = "default_mcp_listen")]
    pub mcp_listen: String,
}

fn default_listen() -> String { "0.0.0.0:8081".into() }
fn default_mcp_listen() -> String { "0.0.0.0:8082".into() }
fn default_static_dir() -> String { "./web/dist".into() }
fn default_health_window() -> i64 { 3600 }
fn default_ws_poll_ms() -> u64 { 3000 }

/// 加载：TOML → env 覆盖（DATABASE_URL / APP_LISTEN）。
pub fn load(path: &str) -> anyhow::Result<AppConfig> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read config {path}: {e}"))?;
    let mut cfg: AppConfig = toml::from_str(&text)
        .map_err(|e| anyhow::anyhow!("parse config {path}: {e}"))?;
    if let Ok(v) = std::env::var("DATABASE_URL") { cfg.database_url = v; }
    if let Ok(v) = std::env::var("APP_LISTEN") { cfg.listen = v; }
    if let Ok(v) = std::env::var("MCP_LISTEN") { cfg.mcp_listen = v; }
    Ok(cfg)
}
// ~/~ end
