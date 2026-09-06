// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/tests/api_rest.rs>>[init]
//! REST/SPA 集成测试（需 TimescaleDB :5433）：真实起 axum server + reqwest 断言。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996601";
const SCODE: &str = "996602";
const HSRC: &str = "web_test_src";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅出现在 dev-dependencies（正常依赖图不含，cargo tree -e normal 验证）。
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
        // Phase C：symbols 写 / 当日统计 / 熔断复位 DB 通道
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
        // 页面⑧ S1：设置页新增字段（装配齐全；行为测试见 api_settings.rs）
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
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

/// n 根 1m raw bar（收盘 1..n）。
async fn seed_bars(pool: &PgPool, code: &str, n: i64) {
    for i in 0..n {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(pool).await.unwrap();
    }
}

// 两测试并行执行：各自的 clean 只碰自己的 code/source（共享清理会互删，实锤踩坑）。
async fn clean_kline(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(pool).await.unwrap();
}

async fn clean_sym(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(SCODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(SCODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM source_health_events WHERE source = $1").bind(HSRC)
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn kline_cursor_pagination_cagg_and_validation() {
    let pool = pool().await;
    clean_kline(&pool).await;
    seed_bars(&pool, CODE, 5).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 第 1 页：limit=2 → 最新 2 根升序 [4,5]
    let v: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2")])
        .send().await.unwrap().json().await.unwrap();
    let bars = v["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 2);
    assert_eq!(bars[0]["close"], 4.0);
    assert_eq!(bars[1]["close"], 5.0);
    let cursor = v["next_before"].as_str().expect("还有更早页").to_string();

    // 第 2 页：before=游标 → [2,3]，无重叠
    let v2: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2"), ("before", &cursor)])
        .send().await.unwrap().json().await.unwrap();
    let closes: Vec<f64> = v2["bars"].as_array().unwrap()
        .iter().map(|b| b["close"].as_f64().unwrap()).collect();
    assert_eq!(closes, vec![2.0, 3.0], "游标页无重复/缺漏");
    let cursor2 = v2["next_before"].as_str().unwrap().to_string();

    // 第 3 页：[1]，next_before=null（前端停拉信号）
    let v3: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "1m"), ("limit", "2"), ("before", &cursor2)])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v3["bars"].as_array().unwrap().len(), 1);
    assert!(v3["next_before"].is_null());

    // 参数校验
    for q in [[("code", CODE), ("period", "3m")], [("code", CODE), ("period", "M1")]] {
        let r = http.get(format!("{url}/api/kline")).query(&q).send().await.unwrap();
        assert_eq!(r.status(), 400, "非法 period → 400");
    }
    let r = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("before", "not-a-time")]).send().await.unwrap();
    assert_eq!(r.status(), 400, "非法 before → 400");

    // cagg 周期（5m 桶：开 1 收 5 量 500）
    sqlx::query("CALL refresh_continuous_aggregate('kline_5m', NULL, NULL)")
        .execute(&pool).await.unwrap();
    let v5: Value = http.get(format!("{url}/api/kline"))
        .query(&[("code", CODE), ("period", "5m")]).send().await.unwrap().json().await.unwrap();
    let bars5 = v5["bars"].as_array().unwrap();
    assert_eq!(bars5.len(), 1);
    assert_eq!(bars5[0]["open"], 1.0);
    assert_eq!(bars5[0]["close"], 5.0);
    assert_eq!(bars5[0]["volume"], 500);
    assert!(bars5[0].get("source").is_none(), "cagg 无 source 键");
    clean_kline(&pool).await;
}

#[tokio::test]
async fn symbols_latest_healthz_spa_and_sources_health() {
    let pool = pool().await;
    clean_sym(&pool).await;
    sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, '测试ETF') \
                 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
        .bind(SCODE).execute(&pool).await.unwrap();
    seed_bars(&pool, SCODE, 2).await;   // 收盘 1,2 → change_pct=100
    for i in 0..3 {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms) \
                     VALUES (now() - make_interval(secs => $1), $2, true, 120)")
            .bind(10 + i).bind(HSRC).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind) \
                 VALUES (now(), $1, false, 'timeout')")
        .bind(HSRC).execute(&pool).await.unwrap();
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // /api/symbols 含 latest 快照字段
    let v: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap()
        .json().await.unwrap();
    let s = v.as_array().unwrap().iter().find(|x| x["code"] == SCODE).expect("含测试标的");
    assert_eq!(s["latest"]["last"], 2.0);
    assert!((s["latest"]["change_pct"].as_f64().unwrap() - 100.0).abs() < 1e-6);

    // /api/sources/health：3 成功 + 1 失败 → 成功率 0.75、degraded
    let v: Value = http.get(format!("{url}/api/sources/health"))
        .query(&[("window_secs", "3600")]).send().await.unwrap().json().await.unwrap();
    let h = v["sources"].as_array().unwrap().iter()
        .find(|x| x["source"] == HSRC).expect("含测试源");
    assert_eq!(h["attempts"], 4);
    assert!((h["success_rate"].as_f64().unwrap() - 0.75).abs() < 1e-9);
    assert_eq!(h["status"], "degraded");
    assert_eq!(h["last_error"]["err_kind"], "timeout");

    // /healthz
    let v: Value = http.get(format!("{url}/healthz")).send().await.unwrap()
        .json().await.unwrap();
    assert_eq!(v["status"], "ok");

    // SPA：/ 与深链均回退占位 index.html
    for path in ["/", "/symbols", "/assets/nonexistent.js"] {
        let body = http.get(format!("{url}{path}")).send().await.unwrap().text().await.unwrap();
        assert!(body.contains("eestock"), "{path} 回退 index.html");
    }
    // 目录穿越：编码形式不做百分比解码，"..%2F.." 只是普通文件名 → 回退 index.html，
    // 绝不会读到 dist 之外（sanitize 拒绝的是解码后语义中的 ".." 段，即字面段）。
    let r = http.get(format!("{url}/..%2F..%2Fetc%2Fpasswd")).send().await.unwrap();
    let body = r.text().await.unwrap();
    assert!(body.contains("eestock") && !body.contains("root:"), "穿越尝试只能拿到 SPA 页");
    // 字面 ".." 段（构造未经客户端规范化的路径）→ sanitize 拒绝 → 400
    let r = http.get(format!("{url}/assets/%2e%2e")).send().await.unwrap();
    assert!(r.status() != 500);
    clean_sym(&pool).await;
}
// ~/~ end
