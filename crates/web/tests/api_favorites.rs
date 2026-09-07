//! 看板收藏端点集成测试（需 TimescaleDB :5433，含 0013 迁移）：真实起 axum server + reqwest 断言。
//! 非 tangle 手写（契约在 design/07-app-plane/00-web-api.md §1.1 收藏三条；行为测试装配同 api_rest.rs）。
//! 覆盖：POST 收藏（自动置顶）/ 幂等、DELETE 取消（幂等）、PUT 重排、
//! /api/symbols favorite 标注且收藏优先、404（code 未注册）、400（reorder 含未收藏 code）。

use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const FAV_A: &str = "996831";
const FAV_B: &str = "996832";
const FAV_C: &str = "996833";
// 测试 2 独立 code（未收藏而非未注册），避免与测试 1 并行 clean 互删
const FAV_D: &str = "996834";
const UNKNOWN: &str = "993399";

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

/// 测试 1（star/unstar/reorder）独享 code 集的清理与播种：只碰 A/B/C。
async fn clean_abc(pool: &PgPool) {
    for c in [FAV_A, FAV_B, FAV_C] {
        sqlx::query("DELETE FROM favorite_symbols WHERE code = $1").bind(c).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(c).execute(pool).await.unwrap();
    }
}

async fn seed_abc(pool: &PgPool) {
    for (i, c) in [FAV_A, FAV_B, FAV_C].iter().enumerate() {
        sqlx::query("INSERT INTO symbols (code, name, interval_secs, settlement, enabled) \
                     VALUES ($1, $2, 60, 'T1', true) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
            .bind(c).bind(format!("收藏标的{i}"))
            .execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn favorite_star_unstar_reorder_and_symbols_order() {
    let pool = pool().await;
    clean_abc(&pool).await;
    seed_abc(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // POST 收藏 A → 200；再收藏 B → 200；重复收藏 A → 200 幂等
    for c in [FAV_A, FAV_B] {
        let r = http.post(format!("{url}/api/symbols/{c}/favorite")).send().await.unwrap();
        assert_eq!(r.status(), 200, "{c} 收藏返回 200");
    }
    let r = http.post(format!("{url}/api/symbols/{FAV_A}/favorite")).send().await.unwrap();
    assert_eq!(r.status(), 200, "重复收藏幂等 200");

    // /api/symbols：favorite 标注 + 收藏优先（A 在 B 前，favorite_sort 1/2）
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let arr = v.as_array().unwrap();
    let a = arr.iter().find(|x| x["code"] == FAV_A).expect("含 A");
    let b = arr.iter().find(|x| x["code"] == FAV_B).expect("含 B");
    assert_eq!(a["favorite"], true);
    assert_eq!(b["favorite"], true);
    // 收藏标注：A 先收藏 → favorite_sort < B 的（自动置顶递增）；绝对值不断言（全局表可能含其他测试残留行）
    assert!(a["favorite_sort"].as_i64() < b["favorite_sort"].as_i64(), "A.sort < B.sort");
    let pos_a = arr.iter().position(|x| x["code"] == FAV_A).unwrap();
    let pos_b = arr.iter().position(|x| x["code"] == FAV_B).unwrap();
    let pos_c = arr.iter().position(|x| x["code"] == FAV_C).unwrap();
    assert!(pos_a < pos_b && pos_b < pos_c, "收藏（A,B）在非收藏 C 之前，且按 sort 升序");
    // 非收藏：favorite=false, favorite_sort=null
    assert_eq!(arr[pos_c]["favorite"], false);
    assert!(arr[pos_c]["favorite_sort"].is_null());

    // PUT 重排 B → A（逆序）；可子集（仅两个已收藏）
    let r = http.put(format!("{url}/api/symbols/favorites/order"))
        .json(&serde_json::json!({ "codes": [FAV_B, FAV_A] }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "重排返回 200");
    let v2: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let arr2 = v2.as_array().unwrap();
    let pos_b2 = arr2.iter().position(|x| x["code"] == FAV_B).unwrap();
    let pos_a2 = arr2.iter().position(|x| x["code"] == FAV_A).unwrap();
    assert!(pos_b2 < pos_a2, "重排后 B 在前");
    // 重排后立即回读校验不在 map 的 C 仍为非收藏
    let c2 = arr2.iter().find(|x| x["code"] == FAV_C).unwrap();
    assert_eq!(c2["favorite"], false);

    // DELETE A → 200；重复 DELETE A → 200 幂等
    let r = http.delete(format!("{url}/api/symbols/{FAV_A}/favorite")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let r = http.delete(format!("{url}/api/symbols/{FAV_A}/favorite")).send().await.unwrap();
    assert_eq!(r.status(), 200, "取消不存在收藏幂等 200");
    let v3: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let a3 = v3.as_array().unwrap().iter().find(|x| x["code"] == FAV_A).unwrap();
    assert_eq!(a3["favorite"], false);
    assert!(a3["favorite_sort"].is_null());

    clean_abc(&pool).await;
}

#[tokio::test]
async fn favorite_not_found_and_reorder_validation() {
    let pool = pool().await;
    // 只清理/播种本测试独享的 FAV_D（不影响测试 1 的 A/B/C）
    sqlx::query("DELETE FROM favorite_symbols WHERE code = $1").bind(FAV_D).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(FAV_D).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, settlement, enabled) \
                 VALUES ($1, '未收藏标的', 60, 'T1', true) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
        .bind(FAV_D).execute(&pool).await.unwrap();
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // POST 未注册 code → 404
    let r = http.post(format!("{url}/api/symbols/{UNKNOWN}/favorite")).send().await.unwrap();
    assert_eq!(r.status(), 404, "收藏未注册 code → 404");
    // DELETE 未注册 code → 404
    let r = http.delete(format!("{url}/api/symbols/{UNKNOWN}/favorite")).send().await.unwrap();
    assert_eq!(r.status(), 404, "取消未注册 code → 404");

    // PUT 重排含未收藏 code → 400（FAV_D 已注册但未收藏）
    let r = http.put(format!("{url}/api/symbols/favorites/order"))
        .json(&serde_json::json!({ "codes": [FAV_D] }))
        .send().await.unwrap();
    assert_eq!(r.status(), 400, "reorder 含未收藏 code → 400");

    // PUT 空数组 → 200（无收藏，空重排）
    let r = http.put(format!("{url}/api/symbols/favorites/order"))
        .json(&serde_json::json!({ "codes": [] }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "空重排 200");

    // 清理本测试独享的 FAV_D
    sqlx::query("DELETE FROM favorite_symbols WHERE code = $1").bind(FAV_D).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(FAV_D).execute(&pool).await.unwrap();
}
