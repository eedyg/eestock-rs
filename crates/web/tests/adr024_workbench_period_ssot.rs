//! ADR-024 P0 —— web 工作台周期门禁「单一事实源」断言（**手写**，非 tangle）。
//!
//! 现状（红）：`crates/web/src/workbench.rs::submit_run` 手写 `matches!(req.period.as_str(), "M1"|...")`
//! 白名单，M30 被 400 拒绝，且与 `application::bar_map` 双事实源漂移。
//! 目标（绿）：删除硬编码，改调 `application::bar_map::parse_period`（唯一事实源）。
//!
//! ## 卫生（不建库、不连活库）
//! `PgPoolOptions::connect_lazy` + **不可达地址**（`test_support::UNREACHABLE_TEST_DB_URL`）⇒
//! 绝不触碰任何真实数据库。判据是纯**周期门禁**：
//! - `period=M30` 走通 web 预校验后才可能触达服务层；服务层连不上库 ⇒ 500 也是**非 400**
//!   （门禁通过），但若仍走硬编码白名单 ⇒ 400（门禁失败）。
//! - `period=W1`（看板扩展周期，不属回测）必须在触达服务层**之前**返回 400（保留既有语义）。
//!
//! 另有源码级反回归：断言 `src/workbench.rs` 已无硬编码 `matches!(req.period.as_str()` 白名单，
//! 且确实调用 `parse_period`（防「行为对了但双事实源又长回来」）。

use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

/// 不可达端口（**不是**活库 5433）：确保本测试文件永不连接 eestock 数据库。
const UNREACHABLE_DB: &str = test_support::UNREACHABLE_TEST_DB_URL;

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect_lazy(UNREACHABLE_DB)
        .expect("lazy connect 只解析 URL，不建连")
}

/// 测试装配：与 `api_workbench.rs` 同口径，但池指向不可达地址（无库）。
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
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
        ),
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
                collector: "0.1.0".into(),
                storage: "0.1.0".into(),
                diagnose: "0.1.0".into(),
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
    tokio::spawn(async move {
        axum::serve(listener, web::build_router(state)).await.unwrap();
    });
    format!("http://{addr}")
}

/// 合法形状的 submit body（period 由调用方覆盖）。
fn submit_body(period: &str) -> Value {
    json!({
        "symbol": "518880",
        "period": period,
        "from": "2026-01-01T00:00:00Z",
        "to": "2026-01-20T00:00:00Z",
        "slots": [{ "version_id": "sv_probe", "weight": 1.0 }],
        "policy": { "LumpSum": { "position_pct": 1.0 } },
        "fee": { "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 0.0 }
    })
}

async fn post(base: &str, body: &Value) -> (u16, Value) {
    let r = reqwest::Client::new()
        .post(format!("{base}/api/workbench/runs"))
        .json(body)
        .send()
        .await
        .expect("HTTP 请求发出");
    let s = r.status().as_u16();
    let b: Value = r.json().await.unwrap_or(Value::Null);
    (s, b)
}

/// M30 必须走通 web 周期门禁（非 400）；无库 ⇒ 预期 500（服务层连不上）。
#[tokio::test]
async fn m30_passes_web_period_gate_not_400() {
    let base = spawn(state(lazy_pool())).await;
    let (s, b) = post(&base, &submit_body("M30")).await;
    println!("[证据] POST /api/workbench/runs period=M30 状态码 = {s}（无库 ⇒ 预期 500 亦合规）body = {b}");
    assert_ne!(
        s, 400,
        "ADR-024 P0：period=M30 被 web 硬编码白名单 400 拒绝；body = {b}"
    );
}

/// 保留既有 400 语义：看板扩展周期 W1 不属回测白名单 → 400，且**结构化 code** 为 `period_invalid`。
/// （ADR-024 P5 整改 N1：400 恒为 `{error:{code,message,detail}}`；旧 `error:"<字符串>"` 形状已删。）
#[tokio::test]
async fn w1_still_rejected_400_with_period_message() {
    let base = spawn(state(lazy_pool())).await;
    let (s, b) = post(&base, &submit_body("W1")).await;
    println!("[证据] POST /api/workbench/runs period=W1 状态码 = {s} body = {b}");
    assert_eq!(s, 400, "W1 不属回测白名单，须 400；body = {b}");
    assert_eq!(b["error"]["code"], serde_json::json!("period_invalid"), "须结构化 period_invalid：{b}");
    let msg = b["error"]["message"].as_str().unwrap_or("");
    assert!(msg.contains("period"), "400 消息须明确报 period 校验失败：{msg}");
}

/// 保留既有 400 语义：未知周期 → 400。
#[tokio::test]
async fn unknown_period_still_rejected_400() {
    let base = spawn(state(lazy_pool())).await;
    let (s, b) = post(&base, &submit_body("M300")).await;
    println!("[证据] POST /api/workbench/runs period=M300 状态码 = {s} body = {b}");
    assert_eq!(s, 400, "M300 非白名单档位，须 400；body = {b}");
}

/// 源码级反回归：web 层不得再出现手写周期白名单（双事实源），且必须调 `parse_period`。
#[test]
fn web_source_has_no_hardcoded_period_whitelist() {
    let src = include_str!("../src/workbench.rs");
    assert!(
        !src.contains("matches!(req.period.as_str()"),
        "crates/web/src/workbench.rs 仍含硬编码 period 白名单（双事实源回归，ADR-024 §5.1）"
    );
    assert!(
        src.contains("bar_map::parse_period"),
        "crates/web/src/workbench.rs 必须改调 application::bar_map::parse_period（唯一事实源）"
    );
}
