//! MA 配置端点集成测试（需 TimescaleDB :5433，含 0015 迁移）：真实起 axum server + reqwest 断言。
//! 非 tangle 手写（契约在 design/07-app-plane/00-web-api.md §1.1 config/ma 两条；行为测试装配同 api_rest.rs）。
//! 覆盖：GET 默认 [5,10,20]、PUT 校验+归一化写回、GET 读回持久化、400（条目数/量纲不合规）。
//! ⚠️ ma_config 为全局单行：本测试与 storage::tests::ma_config_store 共用同一行，均先清后收；
//! 跨 binary 并行时可能互踩（残余风险见 coder/report/060）。

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

/// 测试装配（与 app bin 同结构；storage/sqlx 仅 dev-deps）。
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

async fn clear_config(pool: &PgPool) {
    sqlx::query("DELETE FROM ma_config").execute(pool).await.unwrap();
}

#[tokio::test]
async fn ma_config_get_default_put_normalize_and_validate() {
    let pool = pool().await;
    clear_config(&pool).await; // 收敛默认（表空）
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 1) GET 默认 [5,10,20]（表空）
    let v: Value = http.get(format!("{url}/api/config/ma")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["windows"], serde_json::json!([5, 10, 20]), "表空 → 默认 [5,10,20]");

    // 2) PUT 乱序 {windows:[20,5,10]} → 200，归一化升序返回 [5,10,20]
    let r = http.put(format!("{url}/api/config/ma"))
        .json(&serde_json::json!({ "windows": [20, 5, 10] }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["windows"], serde_json::json!([5, 10, 20]), "乱序归一化升序");

    // 3) GET 读回持久化（已入库）
    let v: Value = http.get(format!("{url}/api/config/ma")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["windows"], serde_json::json!([5, 10, 20]), "写回持久化读回一致");

    // 4) 400 校验：条目数（0 / >3）
    for bad in [serde_json::json!({ "windows": [] }), serde_json::json!({ "windows": [5, 10, 20, 30] })] {
        let r = http.put(format!("{url}/api/config/ma")).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), 400, "条目数不合规 → 400：{bad}");
    }
    // 5) 400 校验：量纲（0 / 501 / 负值）
    for bad in [serde_json::json!({ "windows": [0] }), serde_json::json!({ "windows": [501] }),
                serde_json::json!({ "windows": [-1] })] {
        let r = http.put(format!("{url}/api/config/ma")).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), 400, "量纲不合规 → 400：{bad}");
    }

    // 6) 400 后配置未变（仍为 [5,10,20]）
    let v: Value = http.get(format!("{url}/api/config/ma")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["windows"], serde_json::json!([5, 10, 20]), "400 不落库");

    clear_config(&pool).await;
}
