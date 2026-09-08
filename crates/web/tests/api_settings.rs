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
        // 行情看板 MA 可配置（装配齐全；行为测试见 api_ma_config.rs）
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
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

/// 清空 app_config（收敛到默认；GET 缺则默认回退）。
async fn clear_config(pool: &PgPool) {
    sqlx::query("DELETE FROM app_config").execute(pool).await.unwrap();
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
    clear_config(&pool).await; // 收敛到空表 → GET 缺则默认
    let url = spawn(state(pool.clone())).await;
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

/// 有效 sources PATCH body（前 7 真实源 + push2delay 末位，ADR-006）。
fn valid_sources_json() -> serde_json::Value {
    let mut arr = Vec::new();
    for id in ["tencent_ifzq", "sina_jsonp", "tencent_qt", "sina_hq", "ths_cs", "exchange", "tushare"] {
        arr.push(serde_json::json!({ "id": id, "rate_per_sec": 1, "jitter_ms": 0,
            "circuit_fail_count": 3, "backoff_steps": ["5s", "10s", "30s"], "enabled": true }));
    }
    arr.push(serde_json::json!({ "id": "push2delay", "rate_per_sec": 2, "jitter_ms": 150,
        "circuit_fail_count": 5, "backoff_steps": ["5s", "10s", "30s"], "enabled": true }));
    serde_json::json!({ "sources": arr })
}

#[tokio::test]
async fn config_patch_persists_get_reads_back_and_validates() {
    let pool = pool().await;
    clear_config(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 0) 空表 → GET 默认（sources / collector / mcp）
    let s: Value = http.get(format!("{url}/api/config/sources")).send().await.unwrap()
        .json().await.unwrap();
    assert!(s["sources"].as_array().unwrap().len() >= 8, "空表 → 默认清单");
    let c: Value = http.get(format!("{url}/api/config/collector")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(c["default_interval_sec"], 60);
    let m: Value = http.get(format!("{url}/api/config/mcp")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(m["daily_limit_amount"], 50000);

    // 1) PATCH sources 合法 → 200 + GET 读回持久化（含 push2delay 末位参数）
    let body = valid_sources_json();
    let r = http.patch(format!("{url}/api/config/sources")).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 200, "合法 sources → 200");
    let v: Value = r.json().await.unwrap();
    let push = v["sources"].as_array().unwrap().iter()
        .find(|x| x["id"] == "push2delay").unwrap().clone();
    assert_eq!(push["rate_per_sec"], 2, "写回参数回显");
    let got: Value = http.get(format!("{url}/api/config/sources")).send().await.unwrap()
        .json().await.unwrap();
    let push_got = got["sources"].as_array().unwrap().iter()
        .find(|x| x["id"] == "push2delay").unwrap();
    assert_eq!(push_got["rate_per_sec"], 2, "GET 读回持久化");
    assert_eq!(push_got["jitter_ms"], 150);

    // 2) PATCH sources 非法（rate<0 / 东财非末位 / enabled 非布尔） → 400
    let mut bad = body.clone();
    bad["sources"][1]["rate_per_sec"] = serde_json::json!(-1);
    assert_eq!(http.patch(format!("{url}/api/config/sources")).json(&bad)
        .send().await.unwrap().status(), 400, "rate<0 → 400");
    let mut bad = body.clone();
    let arr = bad["sources"].as_array_mut().unwrap();
    let push = arr.remove(arr.len() - 1);
    arr.insert(0, push); // push2delay 移到首位（东财非末位）
    assert_eq!(http.patch(format!("{url}/api/config/sources")).json(&bad)
        .send().await.unwrap().status(), 400, "东财非末位 → 400（ADR-006）");
    let mut bad = body.clone();
    bad["sources"][0]["enabled"] = serde_json::json!("yes");
    assert_eq!(http.patch(format!("{url}/api/config/sources")).json(&bad)
        .send().await.unwrap().status(), 400, "enabled 非布尔 → 400");

    // 3) PATCH collector 合法（≥60）→ 200 + GET 读回；非法（<60）→ 400
    let r = http.patch(format!("{url}/api/config/collector"))
        .json(&serde_json::json!({ "default_interval_sec": 120 })).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let c: Value = http.get(format!("{url}/api/config/collector")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(c["default_interval_sec"], 120, "GET 读回 collector 持久化");
    let r = http.patch(format!("{url}/api/config/collector"))
        .json(&serde_json::json!({ "default_interval_sec": 59 })).send().await.unwrap();
    assert_eq!(r.status(), 400, "<60 → 400");

    // 4) PATCH mcp 合法 → 200 + GET 读回；非法（金额<0）→ 400
    let r = http.patch(format!("{url}/api/config/mcp"))
        .json(&serde_json::json!({ "enabled": true, "trading_tools_enabled": true,
            "daily_limit_amount": 100000, "daily_limit_count": 30 })).send().await.unwrap();
    assert_eq!(r.status(), 200, "合法 mcp → 200");
    let m: Value = http.get(format!("{url}/api/config/mcp")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(m["daily_limit_amount"], 100000, "GET 读回 mcp 持久化");
    assert_eq!(m["trading_tools_enabled"], true);
    let r = http.patch(format!("{url}/api/config/mcp"))
        .json(&serde_json::json!({ "enabled": true, "trading_tools_enabled": false,
            "daily_limit_amount": -1, "daily_limit_count": 20 })).send().await.unwrap();
    assert_eq!(r.status(), 400, "金额<0 → 400");

    clear_config(&pool).await;
}

/// 清理 kline 配置键（只删该 key，避免抹掉同 binary 其它配置键，配合并行测试隔离）。
async fn clear_kline_config(pool: &PgPool) {
    sqlx::query("DELETE FROM app_config WHERE key = 'kline'")
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn config_kline_put_get_and_validate() {
    let pool = pool().await;
    clear_kline_config(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 0) 表无 kline 键 → GET 缺省 2
    let v: Value = http.get(format!("{url}/api/config/kline"))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v["viewport_days"], 2, "GET 缺省 2（app_config 无 kline 键）");

    // 1) PUT 10 → 200 + GET 读回 10（落库持久化）
    let r = http.put(format!("{url}/api/config/kline"))
        .json(&serde_json::json!({ "viewport_days": 10 })).send().await.unwrap();
    assert_eq!(r.status(), 200, "合法 PUT → 200");
    let v: Value = http.get(format!("{url}/api/config/kline"))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v["viewport_days"], 10, "GET 读回持久化（2→10）");

    // 2) 0 / 51 / 非整 → 400
    for bad in [
        serde_json::json!({ "viewport_days": 0 }),
        serde_json::json!({ "viewport_days": 51 }),
        serde_json::json!({ "viewport_days": 10.5 }),
    ] {
        let r = http.put(format!("{url}/api/config/kline"))
            .json(&bad).send().await.unwrap();
        assert_eq!(r.status(), 400, "非法值 {bad} → 400");
    }

    clear_kline_config(&pool).await;
}
