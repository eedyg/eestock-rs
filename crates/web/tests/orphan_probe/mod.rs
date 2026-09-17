// ADR-023 E6a 红阶段：孤儿检测红测试共用装配辅助（非测试目标文件，被以下两个测试二进制 `mod orphan_probe;` 引用）
//   - crates/web/tests/orphan_detect_endpoint_red.rs（R1/R2-static/R4a/R5）
//   - crates/web/tests/orphan_detect_sql_constant_red.rs（R2 符号契约）
// 仅只读装配：池上的 SQL 只做 SELECT / 端点只做 GET（绝不写活库 eestock）。
#![allow(dead_code)]

use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

/// 10 张 cagg（R2 口径：7 accurate + 3 raw 派生），顺序固定。
pub const CAGGS: [&str; 10] = [
    "kline_accurate_5m", "kline_accurate_15m", "kline_accurate_30m", "kline_accurate_1h",
    "kline_accurate_1d", "kline_accurate_1w", "kline_accurate_1mo",
    "kline_5m", "kline_15m", "kline_1d",
];

pub async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 装配（复制 crates/web/tests/api_quality.rs 的 state()：web 无 test-support 装配器）。
/// 注意：若实现给 AppState 增字段，本文件须同步补齐（否则整个测试目标编译失败）。
pub fn state(pool: PgPool) -> Arc<AppState> {
    let backtest_hub = WsHub::new();
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        strategies: None,
        workbench: None,
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

pub async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

/// 仓库根（crates/web → ../..）。
pub fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// 递归收集 <root> 下扩展名为 .rs 的文件。
pub fn rs_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// 抽取 `async fn <name>` / `fn <name>` 的函数体文本（顶层函数：取到下一个行首 `}`）。
pub fn fn_body(src: &str, marker: &str) -> Option<String> {
    let i = src.find(marker)?;
    let rest = &src[i..];
    let end = rest.find("\n}")?;
    Some(rest[..end].to_string())
}
