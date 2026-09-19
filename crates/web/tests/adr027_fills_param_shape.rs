//! ADR-027 §5.4 闸门 2 整改 **L-2** —— `/fills` 族端点「参数**形态**错误 ⇒ 结构化 400 信封」。
//! ⚠️ **非 tangle 手写**（ADR-007 例外，与 `adr024_workbench_period_ssot.rs` 同模式）。
//!
//! 契约（`design/17-trade-detail-layering/02-spec.md` §5.4）：
//! - 「校验失败必须返回结构化错误信封（JSON），禁止纯文本 400（含非数字 `rt_seq` 等参数形态错误）」。
//! - 信封形状 = ADR-024 §3.1.1：`{"error":{"code","message","detail"}}`（`detail` 恒为对象）。
//!
//! 现状（红）：`?round_trip=abc` / `?offset=abc` / `?limit=abc` / 路径 `{rt_seq}=abc` 由 axum 内置
//! extractor 拒绝，响应体是**纯文本** `Failed to deserialize query string: …`（前端无法编程消费）。
//! 目标（绿）：一律 400 + 上述 JSON 信封（`code=request_invalid`）。
//!
//! ## 卫生（**不建库、不连活库、不写库**）
//! `PgPoolOptions::connect_lazy` + 不可达地址（`test_support::UNREACHABLE_TEST_DB_URL`）：
//! 形态错误在 handler 之前被拒，**永不触达**存储；作为负向对照，形态合法的请求必须**不**是 400
//! （无库 ⇒ 服务层失败 500，证明「400 只出自形态门禁」）。

use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

/// 不可达端口（**不是**活库 5433）：确保本测试文件永不连接任何数据库。
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

/// 发请求并**强制**按 JSON 解析（纯文本 400 ⇒ 解析失败即测试失败，正是 L-2 的判据）。
async fn get_json(base: &str, path: &str) -> (u16, Value, String) {
    let r = reqwest::Client::new()
        .get(format!("{base}{path}"))
        .send()
        .await
        .expect("HTTP 请求发出");
    let status = r.status().as_u16();
    let text = r.text().await.unwrap();
    let body: Value = serde_json::from_str(&text).unwrap_or_else(|e| {
        panic!("响应体必须是 JSON（L-2：禁止纯文本 400）；实际 status={status} body={text:?}: {e}")
    });
    (status, body, text)
}

/// 结构化错误信封断言（ADR-024 §3.1.1 / 02-spec §5.4）。
fn assert_envelope(status: u16, body: &Value, path: &str) {
    assert_eq!(status, 400, "{path} 应 400（参数形态错误），实际 body={body}");
    let e = &body["error"];
    assert!(
        e.is_object(),
        "{path} 的 `error` 必须是**对象**（结构化信封），禁止字符串/纯文本：{body}"
    );
    assert_eq!(
        e["code"],
        json!("request_invalid"),
        "{path} 的 code 须为形态错误码（application::error::codes::REQUEST_INVALID）：{body}"
    );
    assert!(
        e["message"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
        "{path} 的 message 须非空字符串：{body}"
    );
    assert!(e["detail"].is_object(), "{path} 的 detail 必须恒为对象：{body}");
    // 键集冻结（与既有 400 一致）：error 只含 code/message/detail（排序后比较，`Value` 对象为有序映射）
    let mut keys: Vec<&str> = e.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["code", "detail", "message"], "{path} 的信封键集漂移：{body}");
}

/// 表驱动：**全部**形态错误路径 ⇒ 结构化 400 信封（含非数字 `rt_seq`/`offset`/`limit`）。
#[tokio::test]
async fn param_shape_errors_are_structured_json_envelope() {
    let base = spawn(state(lazy_pool())).await;
    // (说明, 路径)
    let cases: &[(&str, &str)] = &[
        ("非数字 round_trip（§5.4 明列）", "/api/workbench/runs/sr_probe/fills?round_trip=abc"),
        ("非数字 offset", "/api/workbench/runs/sr_probe/fills?offset=abc"),
        ("非数字 limit", "/api/workbench/runs/sr_probe/fills?limit=abc"),
        ("越界 round_trip（负数 → u32 形态错）", "/api/workbench/runs/sr_probe/fills?round_trip=-1"),
        ("空串 round_trip", "/api/workbench/runs/sr_probe/fills?round_trip="),
        ("非数字路径 rt_seq（L2 切片）", "/api/workbench/runs/sr_probe/round-trips/abc/fills"),
        ("非数字 L1 分页 offset", "/api/workbench/runs/sr_probe/round-trips?offset=abc"),
        ("非数字 L2 分页 limit", "/api/workbench/runs/sr_probe/round-trips/1/fills?limit=abc"),
    ];
    for (what, path) in cases {
        let (status, body, raw) = get_json(&base, path).await;
        assert!(
            raw.trim_start().starts_with('{'),
            "{what}：400 响应体必须是 JSON 对象（禁 axum 内置纯文本 rejection）：{raw}"
        );
        assert_envelope(status, &body, what);
        // detail 必须能指出**哪个**参数形态错（前端可编程消费）
        assert!(
            body["error"]["detail"].get("param").is_some(),
            "{what}：detail 须含 param（指出出错参数）：{body}"
        );
    }
}

/// 负向对照：形态**合法**的请求不得被形态门禁 400（无库 ⇒ 服务层失败，但**非** 400）。
///
/// 防「把门禁做宽了，任何请求都 400」的假绿。
#[tokio::test]
async fn wellformed_params_are_not_rejected_as_shape_error() {
    let base = spawn(state(lazy_pool())).await;
    for path in [
        "/api/workbench/runs/sr_probe/fills",
        "/api/workbench/runs/sr_probe/fills?offset=0&limit=10&round_trip=1",
        "/api/workbench/runs/sr_probe/round-trips?offset=0&limit=10",
        "/api/workbench/runs/sr_probe/round-trips/1/fills",
    ] {
        let (status, body, _) = get_json(&base, path).await;
        assert_ne!(status, 400, "{path} 形态合法 ⇒ 不得 400（实际 body={body}）");
    }
}
