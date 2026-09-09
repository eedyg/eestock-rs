//! /api/kline 周线/月线（period=1w|1mo）端点集成测试（需 TimescaleDB :5433，含 0014 迁移 cagg）。
//! 非 tangle 手写（契约在 design/07-app-plane/00-web-api.md §1.1 GET /api/kline；装配同 api_rest.rs）。
//! 覆盖：真实 HTTP 路径 parse_period(1w/1mo) → KlineReader W1/MO1 分支 → BarDto 响应升序。
//! ⚠️ 依赖 kline_accurate_1w/1mo cagg 已应用（0014）。cagg refresh 须完全覆盖整桶。

use chrono::{TimeZone, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "997732";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn state(pool: PgPool) -> Arc<AppState> {
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
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        backtest,
        backtest_ws,
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        strategies: None, // P2a：策略 Registry（行为测试见 api_strategies.rs）
        workbench: None, // P3a：回测工作台（行为测试见 api_workbench.rs）
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

async fn clean(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
}

#[tokio::test]
async fn kline_weekly_monthly_period() {
    let pool = pool().await;
    clean(&pool).await;
    // 种子：kline_accurate M1 两周/两月（周一为界周桶 + 自然月桶）。2026-08-31(Mon) 两根 + 2026-09-07(Mon) 一根。
    for (ts, c) in [
        (Utc.with_ymd_and_hms(2026, 8, 31, 1, 30, 0).unwrap(), 1.0),
        (Utc.with_ymd_and_hms(2026, 8, 31, 2, 0, 0).unwrap(), 2.0),
        (Utc.with_ymd_and_hms(2026, 9, 7, 1, 30, 0).unwrap(), 3.0),
    ] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') \
                     ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
            .bind(CODE).bind(ts).bind(c)
            .execute(&pool).await.unwrap();
    }
    // 刷新 cagg（窗口完全覆盖整桶：最长月桶终点 09-30 16:00 UTC 之后）
    for v in ["kline_accurate_1w", "kline_accurate_1mo"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2026-07-25 00:00:00+00', '2026-10-03 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 周线 period=1w → 2 bars（升序；首周 open=1 close=2 vol=200）
    let v: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1w"), ("limit", "10")])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v["period"], "1w");
    let bars = v["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 2, "1w 返回两个交易周");
    assert_eq!(bars[0]["open"], 1.0, "1w 首周 open=first(open)");
    assert_eq!(bars[0]["close"], 2.0, "1w 首周 close=last(close)");
    assert_eq!(bars[0]["volume"], 200);
    assert_eq!(bars[1]["open"], 3.0);

    // 月线 period=1mo → 2 bars（8月/9月）；bars 升序
    let v: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1mo"), ("limit", "10")])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v["period"], "1mo");
    let bars = v["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 2, "1mo 返回两个自然月");
    assert_eq!(bars[0]["open"], 1.0);
    assert_eq!(bars[0]["close"], 2.0);
    assert_eq!(bars[1]["open"], 3.0);

    clean(&pool).await;
}
