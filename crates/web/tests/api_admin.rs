// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/tests/api_admin.rs>>[init]
//! Phase C 写端点集成测试（需 TimescaleDB :5433）：
//! POST/PATCH /api/symbols（校验 400/422、冲突 409、未知 404、with_stats）、
//! POST /api/sources/{id}/reset（202 + DB 通道行落库待消费）。

use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996820";
/// ADR-019 D11 用例独占 code（同 binary 测试并行执行，共享 code 的 clean 会互删——实锤踩坑）。
const CODE_TYPE: &str = "996822";
const RSRC: &str = "web_test_reset_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构；storage/sqlx 仅 dev-dependencies）。
fn state(pool: PgPool) -> Arc<AppState> {
    let backtest_hub = WsHub::new();
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎装配（02-alerts.md；本文件不涉及行为，仅装配齐全）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（quality 端口组；仅装配齐全，行为测试见 api_quality.rs）
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
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        // 行情看板 MA 可配置（装配齐全；行为测试见 api_ma_config.rs）
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

// 每测试独立 clean（同 binary 测试并行执行，共享清理会互删——实锤踩坑）
async fn clean(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
}

/// D11 type 用例独占清理（只删自己的 CODE_TYPE，避免与同 binary 并行用例互删）。
async fn clean_type(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE_TYPE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CODE_TYPE).execute(pool).await.unwrap();
}

async fn clean_reset(pool: &PgPool) {
    sqlx::query("DELETE FROM circuit_reset_requests WHERE source IN ($1, 'no_such_source')")
        .bind(RSRC).execute(pool).await.unwrap();
}

#[tokio::test]
async fn symbols_register_edit_disable_and_stats() {
    let pool = pool().await;
    clean(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 注册（缺省值：interval=60 / settlement=T1 / enabled=true）→ 201 + 回读完整行
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": CODE})).send().await.unwrap();
    assert_eq!(r.status(), 201);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["code"], CODE);
    assert_eq!(v["interval_secs"], 60);
    assert_eq!(v["settlement"], "T1");
    assert_eq!(v["enabled"], true);
    assert!(v["latest"].is_null(), "无 bar 标的 latest 为 null");

    // 重复注册 → 409
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": CODE, "interval_secs": 120})).send().await.unwrap();
    assert_eq!(r.status(), 409);

    // 校验：北交所 422 / 非 6 位数字 400 / 间隔下限 400 / 非法 settlement 400
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "830799"})).send().await.unwrap();
    assert_eq!(r.status(), 422, "北交所前缀拒绝（暂不支持）");
    let body: Value = r.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("北交所"));
    for bad in [serde_json::json!({"code": "12345"}), serde_json::json!({"code": "60051a"})] {
        let r = http.post(format!("{url}/api/symbols")).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), 400, "{bad} → 400");
    }
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "996821", "interval_secs": 30})).send().await.unwrap();
    assert_eq!(r.status(), 400, "interval_secs<60 → 400");
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": "996821", "settlement": "T2"})).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // 编辑：间隔 60→300 + 名称（热生效语义由数据面重读承载，本层锁落库与回读）
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"interval_secs": 300, "name": "测试ETF"})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["interval_secs"], 300);
    assert_eq!(v["name"], "测试ETF");
    assert_eq!(v["settlement"], "T1", "未给字段不变");

    // 停用（唯一删除语义，03-symbols §4）
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"enabled": false})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["enabled"], false);

    // 未知 code → 404；非法 PATCH 值 → 400
    let r = http.patch(format!("{url}/api/symbols/996899"))
        .json(&serde_json::json!({"enabled": true})).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let r = http.patch(format!("{url}/api/symbols/{CODE}"))
        .json(&serde_json::json!({"interval_secs": 10})).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // with_stats=1：今日 bar 数入列；不带参数不出 today_bars 键（Phase A 契约不回归）
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
        .bind(CODE).bind(Utc::now() - Duration::minutes(1)).execute(&pool).await.unwrap();
    let v: Value = http.get(format!("{url}/api/symbols"))
        .query(&[("with_stats", "1")]).send().await.unwrap().json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == CODE).expect("含测试标的");
    assert_eq!(s["today_bars"], 1);
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == CODE).unwrap();
    assert!(s.get("today_bars").is_none(), "无 with_stats 不出 today_bars 键");
    clean(&pool).await;
}

/// ADR-019 D11-1/D11-5：POST/PATCH /api/symbols 的可选 `type`（校验 / 落库 / 回读 / null 语义）。
#[tokio::test]
async fn symbols_type_optional_register_and_patch() {
    let pool = pool().await;
    clean_type(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 省略 type → null（未知；**不得**静默错判为某类型）
    let r = http.post(format!("{url}/api/symbols"))
        .json(&serde_json::json!({"code": CODE_TYPE})).send().await.unwrap();
    assert_eq!(r.status(), 201);
    let v: Value = r.json().await.unwrap();
    assert!(v["type"].is_null(), "省略 type → null（未知）");
    let t: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
        .bind(CODE_TYPE).fetch_one(&pool).await.unwrap();
    assert!(t.is_none(), "落库为 NULL");

    // 枚举外 / 空串 → 400（大小写敏感；空串禁用以免「意外清空」歧义）
    for bad in ["stockx", "", "ETF", "fund"] {
        let r = http.post(format!("{url}/api/symbols"))
            .json(&serde_json::json!({"code": "996823", "type": bad})).send().await.unwrap();
        assert_eq!(r.status(), 400, "type={bad:?} → 400");
    }

    // PATCH 设 etf → 200 + 回读 type（写 symbols.type 即控制通道，数据面重读热生效）
    let r = http.patch(format!("{url}/api/symbols/{CODE_TYPE}"))
        .json(&serde_json::json!({"type": "etf"})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["type"], "etf");

    // 未给 type 的 PATCH 不改 type（COALESCE 语义）；D11-6 保留位可登记
    let r = http.patch(format!("{url}/api/symbols/{CODE_TYPE}"))
        .json(&serde_json::json!({"interval_secs": 300})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["type"], "etf", "未给 type → 保留原值");
    assert_eq!(v["interval_secs"], 300);
    let r = http.patch(format!("{url}/api/symbols/{CODE_TYPE}"))
        .json(&serde_json::json!({"type": "bond_etf"})).send().await.unwrap();
    assert_eq!(r.status(), 200, "D11-6 保留位枚举可登记（费率档案未播种 → 解析回退旧默认）");

    // GET /api/symbols 回显 type（与 MCP list_symbols 同源字段）
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == CODE_TYPE).expect("含测试标的");
    assert_eq!(s["type"], "bond_etf");
    clean_type(&pool).await;
}

#[tokio::test]
async fn reset_endpoint_enqueues_db_control_row() {
    let pool = pool().await;
    clean_reset(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    let r = http.post(format!("{url}/api/sources/{RSRC}/reset")).send().await.unwrap();
    assert_eq!(r.status(), 202, "异步接受（数据面消费后生效）");
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "accepted");

    // DB 控制通道行落库且待消费（数据面 ResetWatcher 轮询取出）
    let (cnt,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM circuit_reset_requests WHERE source = $1 AND consumed_at IS NULL")
        .bind(RSRC).fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1);

    // 未知源 id 同样 202（应用面不知编译期源清单；数据面消费端跳过并告警）
    let r = http.post(format!("{url}/api/sources/no_such_source/reset")).send().await.unwrap();
    assert_eq!(r.status(), 202);
    clean_reset(&pool).await;
}
// ~/~ end
