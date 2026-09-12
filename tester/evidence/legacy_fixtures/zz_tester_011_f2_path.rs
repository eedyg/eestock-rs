//! tester 011 验收夹具：F2「两条 400 路径可区分」动态证明（**非实现改动，仅 tester 夹具**）。
//! 目的：独立证明 `crates/web/tests/api_workbench.rs::submit_validation_error_matrix` 中
//! `msg.contains("period")` 断言命中的是 **period 白名单分支**，而非数据路径碰巧 400。
//! 方法：成对提交 —— `W1`（白名单外，走 web 预校验）vs `H1`（已合法，走数据路径且无数据）。
//! 需 TimescaleDB :5433。位于 tester 夹具命名空间 `zz_tester_*`，不属于 tangle 生成物。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn pref(tag: &str) -> String {
    format!("wb{}f2{}", std::process::id(), tag)
}

/// 恒分插件（带参数 schema）。
const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

fn state(pool: PgPool) -> Arc<AppState> {
    let hub = WsHub::new();
    let strategy_store = Arc::new(storage::strategy::PgStrategyStore::new(pool.clone()));
    let strategies = Arc::new(application::strategy::StrategyService::new(
        strategy_store.clone(),
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    ));
    let workbench_ws: Arc<dyn domain::ports::StrategyRunProgressSink> =
        Arc::new(web::workbench::WorkbenchWsSink::new(hub.clone()));
    let workbench = Arc::new(application::workbench::WorkbenchService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
        strategy_store,
        Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
        workbench_ws,
        Arc::new(domain::ports::SystemClock),
        application::workbench::DEFAULT_MAX_CONCURRENT,
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
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        strategies: Some(strategies),
        workbench: Some(workbench),
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

async fn seed_symbol_and_bars(pool: &PgPool, code: &str) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    for (i, c) in [100.0, 100.0, 110.0, 110.0, 100.0, 100.0].iter().enumerate() {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i as i64)).bind(c)
            .execute(pool).await.unwrap();
    }
}

async fn create_published(http: &reqwest::Client, url: &str, name: &str, code: &str) -> String {
    let r = http.post(format!("{url}/api/strategies"))
        .json(&json!({ "name": name, "code": code }))
        .send().await.unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    let created: Value = r.json().await.unwrap();
    let vid = created["version"]["id"].as_str().unwrap().to_string();
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish"))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "publish 应 200: {:?}", r.text().await);
    vid
}

fn submit_body(symbol: &str, version_id: &str) -> Value {
    json!({
        "symbol": symbol,
        "period": "M1",
        "from": (base() - Duration::minutes(1)).to_rfc3339(),
        "to": (base() + Duration::minutes(10)).to_rfc3339(),
        "slots": [{"version_id": version_id, "params": {}, "weight": 1.0}],
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    })
}

async fn clean(pool: &PgPool, code: &str, name_prefix: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy_preset WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

/// F2 路径区分：W1（白名单外）→ 文案含 `period`；H1（数据路径无数据）→ 文案不含 `period`。
#[tokio::test]
async fn f2_period_paths_are_distinguishable() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("89{}", std::process::id() % 10000);
    let p = pref("path");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-const"), CONST_SCORE).await;

    // 路径 A：W1（白名单外）→ web 预校验分支 → 文案含 "period"
    let mut b = submit_body(&code, &vid);
    b["period"] = json!("W1");
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400, "W1 应 400");
    let body: Value = r.json().await.unwrap();
    let msg_w1 = body["error"].as_str().unwrap_or_default().to_string();
    eprintln!("F2 EVIDENCE path_A(W1) status=400 error={msg_w1:?}");
    assert!(msg_w1.contains("period"), "W1 文案须含 period: {msg_w1}");
    assert!(msg_w1.contains("M1") && msg_w1.contains("D1"),
        "W1 文案须为白名单文案（含 M1..D1）: {msg_w1}");

    // 路径 B：H1（已合法）在只有 M1 数据的标的上 → 数据路径（区间无 H1 数据）→ 文案不含 "period"
    let mut b = submit_body(&code, &vid);
    b["period"] = json!("H1");
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400, "H1 无数据应 400");
    let body: Value = r.json().await.unwrap();
    let msg_h1 = body["error"].as_str().unwrap_or_default().to_string();
    eprintln!("F2 EVIDENCE path_B(H1) status=400 error={msg_h1:?}");
    assert!(!msg_h1.contains("period"),
        "H1 数据路径文案不得含 period（否则 contains 断言无法区分路径）: {msg_h1}");
    // 两路径文案必须不同（区分性）
    assert_ne!(msg_w1, msg_h1, "两路径文案须不同");

    clean(&pool, &code, &p).await;
}
