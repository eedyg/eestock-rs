// ~/~ begin <<design/03-collector/02-data-plane.md#crates/app/src/config.rs>>[init]
//! 数据面配置：TOML 文件 + 环境变量覆盖（secret 走 env，不落配置文件）。

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct DataConfig {
    pub database_url: String,
    /// tushare token（建议 TUSHARE_TOKEN env 注入；配置文件可省略）
    #[serde(default)]
    pub tushare_token: Option<String>,
    #[serde(default = "default_true")]
    pub tushare_enabled: bool,
    #[serde(default = "default_healthz_port")]
    pub healthz_port: u16,
    #[serde(default = "default_interval_ms")]
    pub tushare_interval_ms: i64,
}

fn default_true() -> bool { true }
fn default_healthz_port() -> u16 { 8080 }
fn default_interval_ms() -> i64 { 1000 }

/// 加载：TOML → env 覆盖（DATABASE_URL / TUSHARE_TOKEN）。
pub fn load(path: &str) -> anyhow::Result<DataConfig> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read config {path}: {e}"))?;
    let mut cfg: DataConfig = toml::from_str(&text)
        .map_err(|e| anyhow::anyhow!("parse config {path}: {e}"))?;
    if let Ok(v) = std::env::var("DATABASE_URL") { cfg.database_url = v; }
    if let Ok(v) = std::env::var("TUSHARE_TOKEN") { cfg.tushare_token = Some(v); }
    Ok(cfg)
}
// ~/~ end
