//! [TESTER 临时独立验收夹具 — 跑完即删，不提交，不属于实现]
//! 010 批：web（REST）通道独立验收——H1 白名单（`crates/web/src/workbench.rs`）+
//! 试算 DTO 的 warmup/fee/policy/capital（`crates/web/src/strategies.rs`）。
//! 装配复制自 crates/web/tests/api_workbench.rs（同口径），只读+自建独立 symbol 前缀，跑完清理。
//! 用法：DATABASE_URL=... cargo test -p web --test zz_tester_010_web -- --nocapture --test-threads=1

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

fn pref(tag: &str) -> String { format!("t10w{}{}", std::process::id(), tag) }

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
        .json(&json!({ "name": name, "code": code })).send().await.unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    let created: Value = r.json().await.unwrap();
    let vid = created["version"]["id"].as_str().unwrap().to_string();
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish"))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "publish 应 200: {:?}", r.text().await);
    vid
}

async fn clean(pool: &PgPool, code: &str, name_prefix: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

fn body(symbol: &str, version_id: &str, period: &str) -> Value {
    json!({
        "symbol": symbol, "period": period,
        "from": (base() - Duration::minutes(1)).to_rfc3339(),
        "to": (base() + Duration::minutes(10)).to_rfc3339(),
        "slots": [{"version_id": version_id, "params": {}, "weight": 1.0}],
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    })
}

#[tokio::test]
async fn zz_tester_010_web_h1_and_testrun_dto() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("88{}", std::process::id() % 10000);
    let p = pref("h1");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-const"), CONST_SCORE).await;

    for period in ["M1", "H1", "W1", "1h", "D1"] {
        let r = http.post(format!("{url}/api/workbench/runs"))
            .json(&body(&code, &vid, period)).send().await.unwrap();
        let status = r.status().as_u16();
        let txt = r.text().await.unwrap();
        println!("WEB_RUN period={period} status={status} body={}",
            txt.chars().take(220).collect::<String>());
    }

    // 试算 DTO（I-2/I-3 web 通道）：缺省 / 显式字段
    let tr_body = |extra: Value| {
        let mut v = json!({
            "code": CONST_SCORE, "symbol": code, "period": "M1",
            "from": (base() - Duration::minutes(1)).to_rfc3339(),
            "to": (base() + Duration::minutes(10)).to_rfc3339(),
            "mode": "sim_position"});
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in e { o.insert(k.clone(), val.clone()); }
        }
        v
    };
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&tr_body(json!({}))).send().await.unwrap();
    let st = r.status().as_u16();
    let v: Value = r.json().await.unwrap();
    println!("WEB_TESTRUN default status={st} warmup_requested={} warmup_effective={} fee={} n_scores={} n_signals={} first_signal={}",
        v["warmup_requested"], v["warmup_effective"], v["fee"],
        v["scores"].as_array().map(|a| a.len()).unwrap_or(0),
        v["signals"].as_array().map(|a| a.len()).unwrap_or(0),
        v["signals"].as_array().and_then(|a| a.first()).map(|s| s["signal"].clone()).unwrap_or(Value::Null));
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&tr_body(json!({"warmup_bars": 2, "initial_capital": 200000,
            "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0},
            "policy": {"Dca": {"tranches": 2, "mode": "Equal", "amount": null, "interval": 1}}})))
        .send().await.unwrap();
    let st2 = r.status().as_u16();
    let v2: Value = r.json().await.unwrap();
    println!("WEB_TESTRUN explicit status={st2} warmup_requested={} warmup_effective={} fee={} n_scores={} n_trades={} capital_echo_present={}",
        v2["warmup_requested"], v2["warmup_effective"], v2["fee"],
        v2["scores"].as_array().map(|a| a.len()).unwrap_or(0),
        v2["trades"].as_array().map(|a| a.len()).unwrap_or(0),
        v2.get("initial_capital").is_some());
    // H1 试算（web 通道）
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&tr_body(json!({"period": "H1"}))).send().await.unwrap();
    let st3 = r.status().as_u16();
    let v3: Value = r.json().await.unwrap();
    println!("WEB_TESTRUN H1 status={st3} period={} bar_count={} warmup_effective={} err={}",
        v3["period"], v3["bar_count"], v3["warmup_effective"],
        v3["error"].as_str().unwrap_or(""));

    // 清理（含本测试创建的 symbol/策略/运行）
    clean(&pool, &code, &p).await;
    let left: (i64,) = sqlx::query_as("SELECT count(*) FROM strategy WHERE name LIKE $1")
        .bind(format!("{p}%")).fetch_one(&pool).await.unwrap();
    println!("WEB_CLEANUP leftover_strategies={}", left.0);
}
