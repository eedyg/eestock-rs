//! ADR-023 D1 红测试（**手写**）：判据 J2（`parse_period("30m") == Some(Period::M30)`）
//! 与 J5（`GET /api/kline` 周期契约：30m 不得 400；未知周期 400 且错误信息含全部现行档位）。
//!
//! ## 设计要点（本阶段不连库）
//! - `PgPoolOptions::connect_lazy` + **不可达地址**（127.0.0.1:59999）⇒ 绝不触碰活库（eestock@5433）。
//! - J5 的两条断言都是**纯契约**：
//!   ① `period=30m` 走通 `parse_period` 后才可能触达数据层；数据层连不上 ⇒ 500 也是**非 400**（契约通过），
//!      但如果 `parse_period("30m")` 返回 None ⇒ 400（契约失败）。故「不得 400」不需要真库。
//!   ② `period=30x` 在触达数据层**之前**返回 400 ⇒ 断言错误信息文本，不需要真库。
//! - J2 用 `{:?}` 比对而非直接命名 `Period::M30`：让 J2 以**运行时断言失败**呈现（可读证据），
//!   而 J1（变体存在性）由 crates/domain/tests/period30m_contract.rs 的编译期断言承担。
//! 契约出处：ADR-023 §5.1。

use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

/// 不可达端口（**不是**活库 5433）：确保本测试文件永不连接 eestock 数据库。
///
/// 连接串集中自 dev-only crate `test-support`（门禁 R1：任何构造池的测试文件必须经 `test_support::`
/// 统一入口，不许自造 URL 落点）。
const UNREACHABLE_DB: &str = test_support::UNREACHABLE_TEST_DB_URL;

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect_lazy(UNREACHABLE_DB)
        .expect("lazy connect 只解析 URL，不建连")
}

/// 测试装配（结构同 crates/web/tests/api_kline_period.rs；隐藏 storage 具体实现由 dev-dep 提供）。
fn state(pool: PgPool) -> Arc<AppState> {
    let backtest_hub = WsHub::new();
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

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

#[tokio::test]
async fn j5a_api_kline_period_30m_must_not_be_400() {
    let base = spawn(state(lazy_pool())).await;
    let r30 = reqwest::Client::new()
        .get(format!("{base}/api/kline?code=518880&period=30m&limit=10"))
        .send().await.expect("HTTP 请求发出");
    let s30 = r30.status().as_u16();
    let b30: Value = r30.json().await.unwrap_or(Value::Null);
    println!("[证据] GET /api/kline?period=30m 实际状态码 = {s30}（本阶段无库 ⇒ 预期 500 亦合规）body = {b30}");
    assert_ne!(
        s30, 400,
        "ADR-023 §5.1：`period=30m` 被 400 拒绝（parse_period(\"30m\") 仍为 None）；body = {b30}"
    );
}

#[tokio::test]
async fn j5b_unknown_period_400_message_lists_all_eight_tiers() {
    let base = spawn(state(lazy_pool())).await;
    let rbad = reqwest::Client::new()
        .get(format!("{base}/api/kline?code=518880&period=30x&limit=10"))
        .send().await.expect("HTTP 请求发出");
    assert_eq!(rbad.status().as_u16(), 400, "未知周期必须 400");
    let bbad: Value = rbad.json().await.unwrap_or(Value::Null);
    let msg = bbad.get("error").and_then(|v| v.as_str()).unwrap_or("");
    println!("[证据] period=30x 的实际 400 body = {bbad}");
    let missing: Vec<&str> = ["1m", "5m", "15m", "30m", "1h", "1d", "1w", "1mo"]
        .into_iter()
        .filter(|t| !msg.contains(*t))
        .collect();
    assert!(
        missing.is_empty(),
        "ADR-023 §5.1/§2.6-1：400 错误信息必须含全部现行档位字面名，缺 = {missing:?}；实际 error = {msg:?}"
    );
}
