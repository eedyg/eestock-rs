// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/tests/api_quality.rs>>[init]
//! 数据质量端点集成测试（需 TimescaleDB :5433；真实库 + 真实 server）：
//! divergence / source-accuracy / gaps（含三级分类与节假日/周末排除）/ tushare status / D6 SPA 404。

use chrono::{DateTime, NaiveDate, Timelike, Utc};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const CODE: &str = "996611";   // 独立测试标的（并行安全）
const SRC: &str = "webq_test_src";
const DAY: &str = "2026-09-02"; // 周三，交易日（测试运行时已成历史日，241 标签全到期）

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn state(pool: PgPool) -> Arc<AppState> {
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase B：告警引擎（仅装配齐全，本文件不涉及其行为）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: WsHub::new(),
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

fn cst(day: NaiveDate, h: u32, mi: u32, s: u32) -> DateTime<Utc> {
    domain::tz::cst_to_utc(day.and_hms_opt(h, mi, s).unwrap())
}

async fn clean(pool: &PgPool) {
    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(CODE).execute(pool).await.unwrap();
    }
    sqlx::query("DELETE FROM source_health_events WHERE code = $1")
        .bind(CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM sync_checkpoints WHERE code = $1")
        .bind(CODE).execute(pool).await.unwrap();
}

/// 造数：交易日 2026-09-02 全 241 标签（除 10:41/10:42/13:05/14:00 四分钟缺口）；
/// accurate 全覆盖（09:30 close 10.00 vs raw 10.10 → +1.0% 分歧 bar；其余一致）；
/// 事件：10:41:30 timeout（源故障）、13:05:20 na（源无数据）、14:00 邻近无事件（系统缺口）。
async fn seed(pool: &PgPool) {
    let day = NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    let skip = [(10u32, 41u32), (10, 42), (13, 5), (14, 0)];
    for l in domain::calendar::trading_minute_labels(day) {
        let (h, m) = (l.time().hour(), l.time().minute());
        if skip.contains(&(h, m)) { continue; }
        let ts = domain::tz::cst_to_utc(l);
        let raw_close = if (h, m) == (9, 30) { 10.10 } else { 10.00 };
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, $4) ON CONFLICT DO NOTHING")
            .bind(CODE).bind(ts).bind(raw_close).bind(SRC)
            .execute(pool).await.unwrap();
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount) \
                     VALUES ($1, $2, 'M1', 10.0, 10.0, 10.0, 10.0, 100, 100.0) ON CONFLICT DO NOTHING")
            .bind(CODE).bind(ts)
            .execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind, code) \
                 VALUES ($1, $2, false, 'timeout', $3), ($4, $2, true, 'na', $3)")
        .bind(cst(day, 10, 41, 30)).bind(SRC).bind(CODE).bind(cst(day, 13, 5, 20))
        .execute(pool).await.unwrap();
    sqlx::query("INSERT INTO sync_checkpoints (code, period, last_synced_date) \
                 VALUES ($1, 'M1', '2026-09-02') ON CONFLICT (code, period) DO NOTHING")
        .bind(CODE).execute(pool).await.unwrap();
}

#[tokio::test]
async fn quality_endpoints_full_flow() {
    let pool = pool().await;
    clean(&pool).await;
    seed(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // ── divergence：对照汇总 + 降序 + 只比 close ──
    let v: Value = http.get(format!("{url}/api/quality/divergence"))
        .query(&[("code", CODE), ("from", DAY), ("to", DAY)])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v["code"], CODE);
    assert_eq!(v["threshold_pct"], 0.5, "默认阈值 = 页面④ 定稿 0.5");
    assert_eq!(v["summary"]["compared_bars"], 237);
    assert_eq!(v["summary"]["divergent_bars"], 1, "仅 09:30 +1.0% 超阈");
    let rate = v["summary"]["divergence_rate"].as_f64().unwrap();
    assert!((rate - 1.0 / 237.0).abs() < 1e-9);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 237);
    assert!((rows[0]["deviation_pct"].as_f64().unwrap() - 1.0).abs() < 1e-6, "偏差降序首位 = 最大偏差");
    assert_eq!(rows[0]["raw_source"], SRC);
    // 阈值参数可调
    let v2: Value = http.get(format!("{url}/api/quality/divergence"))
        .query(&[("code", CODE), ("from", DAY), ("to", DAY), ("threshold_pct", "2")])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(v2["summary"]["divergent_bars"], 0, "阈值 2% 时 +1.0% 计一致");

    // ── source-accuracy：按 raw_source 归组（本测试源独立，不受库中真实数据污染）──
    let v: Value = http.get(format!("{url}/api/quality/source-accuracy"))
        .query(&[("from", DAY), ("to", DAY)]).send().await.unwrap().json().await.unwrap();
    let mine = v["sources"].as_array().unwrap().iter()
        .find(|s| s["source"] == SRC).expect("含本测试源");
    assert_eq!(mine["samples"], 237);
    let cr = mine["consistency_rate"].as_f64().unwrap();
    assert!((cr - 236.0 / 237.0).abs() < 1e-9);

    // ── gaps：三级分类 + 段合并 + 仅缺口日出卡 ──
    let v: Value = http.get(format!("{url}/api/quality/gaps"))
        .query(&[("code", CODE), ("from", DAY), ("to", DAY)])
        .send().await.unwrap().json().await.unwrap();
    let days = v["days"].as_array().unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0]["date"], DAY);
    assert_eq!(days[0]["expected_bars"], 241);
    assert_eq!(days[0]["actual_bars"], 237);
    assert_eq!(days[0]["missing_bars"], 4);
    let segs = days[0]["segments"].as_array().unwrap();
    assert_eq!(segs.len(), 3);
    assert_eq!((segs[0]["start"].as_str().unwrap(), segs[0]["end"].as_str().unwrap(),
                segs[0]["count"].as_i64().unwrap(), segs[0]["class"].as_str().unwrap()),
        ("10:41", "10:42", 2, "source_fault"));
    assert_eq!((segs[1]["start"].as_str().unwrap(), segs[1]["class"].as_str().unwrap()),
        ("13:05", "upstream_no_data"));
    assert_eq!((segs[2]["start"].as_str().unwrap(), segs[2]["class"].as_str().unwrap()),
        ("14:00", "system_gap"));

    // 节假日/周末整日排除（0008 已落库：国庆 10-01..08；09-05/06 周末）
    for (from, to) in [("2026-10-01", "2026-10-08"), ("2026-09-05", "2026-09-06"),
                       ("2026-01-01", "2026-01-01")] {
        let v: Value = http.get(format!("{url}/api/quality/gaps"))
            .query(&[("code", CODE), ("from", from), ("to", to)])
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(v["days"].as_array().unwrap().len(), 0, "{from}..{to} 非交易日排除");
    }

    // ── tushare status：检查点透传 + quota 恒 null ──
    let v: Value = http.get(format!("{url}/api/tushare/status")).send().await.unwrap()
        .json().await.unwrap();
    let cps = v["checkpoints"].as_array().unwrap();
    assert!(cps.iter().any(|c| c["code"] == CODE
        && c["last_synced_date"] == "2026-09-02"), "检查点含测试标的");
    assert!(v["covered_codes"].as_i64().unwrap() >= 1);
    assert!(v["quota_remaining"].is_null(), "积分余额未入库 → 恒 null（§1.1 注明）");
    assert!(v.as_object().unwrap().contains_key("last_event"));

    // ── 参数校验 400 矩阵 ──
    for q in [
        vec![("from", DAY), ("to", DAY)],                          // 缺 code
        vec![("code", ""), ("from", DAY), ("to", DAY)],            // code 空
        vec![("code", CODE), ("from", "2026/09/02"), ("to", DAY)], // 非法日期
        vec![("code", CODE), ("from", DAY), ("to", "2026-09-01")], // from>to
        vec![("code", CODE), ("from", "2026-01-01"), ("to", "2026-12-31")], // 超跨度
        vec![("code", CODE), ("from", DAY), ("to", DAY), ("threshold_pct", "0")], // 阈值非正
    ] {
        let r = http.get(format!("{url}/api/quality/divergence")).query(&q).send().await.unwrap();
        assert_eq!(r.status(), 400, "{q:?} → 400");
    }
    let r = http.get(format!("{url}/api/quality/gaps"))
        .query(&[("from", DAY), ("to", DAY)]).send().await.unwrap();
    assert_eq!(r.status(), 400, "gaps 缺 code → 400");

    // ── D6：/api/* 未命中不回退 index.html → 404 JSON ──
    let r = http.get(format!("{url}/api/quality/nope")).send().await.unwrap();
    assert_eq!(r.status(), 404, "D6：/api/* 未匹配 → 404");
    assert_eq!(r.json::<Value>().await.unwrap()["error"], "not found");
    // 对照：非 /api 深链仍回退 index.html（前端 history 路由）
    let body = http.get(format!("{url}/quality")).send().await.unwrap().text().await.unwrap();
    assert!(body.contains("eestock"), "页面④ 深链回退 index.html");

    clean(&pool).await;
}
// ~/~ end
