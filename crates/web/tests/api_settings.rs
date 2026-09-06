// ~/~ begin <<design/06-web/08-settings.md#crates/web/tests/api_settings.rs>>[init]
//! 页面⑧ 系统设置 S1 端点集成测试（需 TimescaleDB :5433）：真实起 axum server + reqwest 断言。
//! 危险操作（purge-raw / reset-circuits）只测「拒绝路径」（confirm 缺失/不匹配 → 400），不真删 kline_raw。

use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（与 app bin 同口径；本文件不涉及行为，仅装配齐全）
    let backtest_hub = WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: "0.1.0".into(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest,
        backtest_ws,
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

#[tokio::test]
async fn system_info_returns_version_db_and_uptime() {
    let pool = pool().await;
    let url = spawn(state(pool)).await;
    let http = reqwest::Client::new();

    let v: Value = http.get(format!("{url}/api/system/info"))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v["app_version"], "0.1.0");
    assert!(v["crate_versions"]["collector"].is_string());
    assert!(v["crate_versions"]["storage"].is_string());
    assert!(v["crate_versions"]["diagnose"].is_string());
    assert!(v["db_ok"].as_bool().unwrap(), "db_ok=true（TimescaleDB 可用）");
    assert!(v["uptime_secs"].is_u64(), "uptime_secs 为无符号秒数");
}

#[tokio::test]
async fn config_snapshots_return_readonly_defaults() {
    let pool = pool().await;
    let url = spawn(state(pool)).await;
    let http = reqwest::Client::new();

    // GET /api/config/sources：内置源清单 + 默认参数
    let s: Value = http.get(format!("{url}/api/config/sources"))
        .send().await.unwrap().json().await.unwrap();
    let sources = s["sources"].as_array().unwrap();
    assert!(sources.len() >= 8, "内置源清单不少于 8（含 push2delay 东财）");
    let push = sources.iter().find(|x| x["id"] == "push2delay").unwrap();
    assert!(push["rotation_locked"].as_bool().unwrap(), "东财系锁定末位（ADR-006）");
    let ifzq = sources.iter().find(|x| x["id"] == "tencent_ifzq").unwrap();
    assert_eq!(ifzq["rate_per_sec"], 1);
    assert_eq!(ifzq["circuit_fail_count"], 3);
    assert_eq!(ifzq["backoff_steps"].as_array().unwrap().len(), 3);

    // GET /api/config/collector：默认间隔 + 写死交易时段
    let c: Value = http.get(format!("{url}/api/config/collector"))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(c["default_interval_sec"], 60);
    assert_eq!(c["trading_hours"], "09:30-11:30/13:00-15:00");

    // GET /api/config/mcp：总开关/交易工具默认关/限额默认
    let m: Value = http.get(format!("{url}/api/config/mcp"))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(m["enabled"], true);
    assert_eq!(m["trading_tools_enabled"], false, "交易工具默认关（ADR-009）");
    assert_eq!(m["daily_limit_amount"], 50000);
    assert_eq!(m["daily_limit_count"], 20);
}

#[tokio::test]
async fn purge_raw_rejects_missing_or_mismatched_confirm() {
    let pool = pool().await;
    let url = spawn(state(pool)).await;
    let http = reqwest::Client::new();

    // confirm 缺失 → 400（服务端拒绝；不真删 kline_raw）
    let r = http.post(format!("{url}/api/system/purge-raw"))
        .json(&serde_json::json!({})).send().await.unwrap();
    assert_eq!(r.status(), 400, "confirm 缺失 → 400");

    // confirm 不匹配 → 400
    let r = http.post(format!("{url}/api/system/purge-raw"))
        .json(&serde_json::json!({ "confirm": "PURGE!" })).send().await.unwrap();
    assert_eq!(r.status(), 400, "confirm 不匹配 → 400");

    // confirm 错误单词 → 400
    let r = http.post(format!("{url}/api/system/purge-raw"))
        .json(&serde_json::json!({ "confirm": "" })).send().await.unwrap();
    assert_eq!(r.status(), 400, "空 confirm → 400");
}

#[tokio::test]
async fn reset_circuits_rejects_missing_or_mismatched_confirm() {
    let pool = pool().await;
    let url = spawn(state(pool)).await;
    let http = reqwest::Client::new();

    // confirm 缺失 → 400
    let r = http.post(format!("{url}/api/system/reset-circuits"))
        .json(&serde_json::json!({})).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // confirm 不匹配 → 400
    let r = http.post(format!("{url}/api/system/reset-circuits"))
        .json(&serde_json::json!({ "confirm": "reset" })).send().await.unwrap();
    assert_eq!(r.status(), 400);
}
