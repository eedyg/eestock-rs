//! 策略 Registry 端点集成测试（需 TimescaleDB :5433，含 0022 迁移）：真实起 axum server + reqwest 断言。
//! ⚠️ **非 tangle 手写**（ADR-007 例外）：契约在 design/07-app-plane/00-web-api.md §1.7，本文件不 tangle。
//! 覆盖：create/get/versions/diff/publish/archive/test-run 全端点 + 错误语义（400/404/409）。
//! 每测试用独立 name 前缀（并行执行互不共享清理）；test-run 用独立 code 造 M1 accurate bar。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 8, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn pref(tag: &str) -> String {
    format!("w{}{}", std::process::id(), tag)
}

const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

const NO_ON_BAR: &str = "function score_it(ctx) { return 1; }";
const TREND: &str = "function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }";

/// 测试装配（与 app bin 同口径）：storage 具体实现注入 domain 端口 + StrategyService。
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
    let strategies = Arc::new(application::strategy::StrategyService::new(
        Arc::new(storage::strategy::PgStrategyStore::new(pool.clone())),
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
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
        backtest,
        backtest_ws,
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        strategies: Some(strategies),
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

/// 清理本测试创建的策略（published 先 archive 再删；trigger 拦 published 删除）。
async fn clean_strategies(pool: &PgPool, name_prefix: &str) {
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
}

async fn create(http: &reqwest::Client, base_url: &str, name: &str, code: &str) -> Value {
    let r = http
        .post(format!("{base_url}/api/strategies"))
        .json(&json!({ "name": name, "code": code }))
        .send().await.unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    r.json().await.unwrap()
}

#[tokio::test]
async fn registry_lifecycle_end_to_end() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let p = pref("lc");
    clean_strategies(&pool, &p).await;

    // create → v1 draft
    let name = format!("{p}-策略");
    let created = create(&http, &url, &name, CONST_SCORE).await;
    let sid = created["strategy"]["id"].as_str().unwrap().to_string();
    let vid = created["version"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["version"]["version"], 1);
    assert_eq!(created["version"]["status"], "draft");
    assert!(created["version"]["sha256"].as_str().unwrap().len() == 64);
    assert_eq!(created["version"]["params_schema"][0]["key"], "score");

    // get / 404
    let r = http.get(format!("{url}/api/strategies/{sid}")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["name"], name);
    let r = http.get(format!("{url}/api/strategies/st_none")).send().await.unwrap();
    assert_eq!(r.status(), 404);

    // PUT draft → updated 原地更新
    let r = http.put(format!("{url}/api/strategies/versions/{vid}"))
        .json(&json!({ "code": TREND })).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["outcome"], "updated");
    assert_eq!(body["version"]["version"], 1);

    // publish → 200 published
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish")).send().await.unwrap();
    assert_eq!(r.status(), 200, "{:?}", r.text().await);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "published");
    assert!(v["published_at"].is_string());

    // 重复 publish → 409
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish")).send().await.unwrap();
    assert_eq!(r.status(), 409);

    // PUT published → 自动新 draft（201, version=2）
    let r = http.put(format!("{url}/api/strategies/versions/{vid}"))
        .json(&json!({ "code": CONST_SCORE })).send().await.unwrap();
    assert_eq!(r.status(), 201);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["outcome"], "new_draft");
    assert_eq!(body["version"]["version"], 2);
    assert_eq!(body["version"]["status"], "draft");
    let v2id = body["version"]["id"].as_str().unwrap().to_string();

    // versions 列表（升序 2 条）
    let r = http.get(format!("{url}/api/strategies/{sid}/versions")).send().await.unwrap();
    let vs: Value = r.json().await.unwrap();
    assert_eq!(vs.as_array().unwrap().len(), 2);

    // POST versions（从 v1 派生 draft → version 3）
    let r = http.post(format!("{url}/api/strategies/{sid}/versions"))
        .json(&json!({ "from_version_id": vid })).send().await.unwrap();
    assert_eq!(r.status(), 201);
    let v3: Value = r.json().await.unwrap();
    assert_eq!(v3["version"], 3);
    assert_eq!(v3["code"], TREND);

    // diff（v1 vs v2）
    let r = http.get(format!("{url}/api/strategies/versions/diff?from={vid}&to={v2id}"))
        .send().await.unwrap();
    assert_eq!(r.status(), 200);
    let d: Value = r.json().await.unwrap();
    assert_eq!(d["from"]["code"], TREND);
    assert_eq!(d["to"]["code"], CONST_SCORE);
    // diff 缺参数 → 400；未知版本 → 404
    let r = http.get(format!("{url}/api/strategies/versions/diff?from={vid}")).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let r = http.get(format!("{url}/api/strategies/versions/diff?from={vid}&to=sv_none"))
        .send().await.unwrap();
    assert_eq!(r.status(), 404);

    // archive：draft → 409；published → 200；archived → 409
    let r = http.post(format!("{url}/api/strategies/versions/{v2id}/archive")).send().await.unwrap();
    assert_eq!(r.status(), 409, "draft 不可 archive");
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/archive")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["status"], "archived");
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/archive")).send().await.unwrap();
    assert_eq!(r.status(), 409);

    clean_strategies(&pool, &p).await;
}

#[tokio::test]
async fn publish_gate_rejects_bad_code_400() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let p = pref("gate");
    clean_strategies(&pool, &p).await;

    let created = create(&http, &url, &format!("{p}-bad"), NO_ON_BAR).await;
    let vid = created["version"]["id"].as_str().unwrap();
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish")).send().await.unwrap();
    assert_eq!(r.status(), 400, "无 on_bar 应被发布门禁拒绝");
    let body: Value = r.json().await.unwrap();
    assert!(body["error"].as_str().unwrap().contains("发布门禁"));

    clean_strategies(&pool, &p).await;
}

#[tokio::test]
async fn catalog_filters_and_validation() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let p = pref("cat");
    clean_strategies(&pool, &p).await;

    // published 一条（入册）+ 仅 draft 一条（不入册）
    let created = create(&http, &url, &format!("{p}-pub"), CONST_SCORE).await;
    let vid = created["version"]["id"].as_str().unwrap();
    http.post(format!("{url}/api/strategies/versions/{vid}/publish")).send().await.unwrap();
    create(&http, &url, &format!("{p}-draft"), TREND).await;

    let r = http.get(format!("{url}/api/strategies")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let list: Value = r.json().await.unwrap();
    let mine: Vec<&Value> = list.as_array().unwrap().iter()
        .filter(|e| e["strategy"]["name"].as_str().unwrap().starts_with(&p)).collect();
    assert_eq!(mine.len(), 1, "仅 published 入册");
    assert_eq!(mine[0]["version"]["status"], "published");

    // kind 过滤：template → 无本测试条目；strategy → 有
    let r = http.get(format!("{url}/api/strategies?kind=template")).send().await.unwrap();
    let list: Value = r.json().await.unwrap();
    assert!(!list.as_array().unwrap().iter()
        .any(|e| e["strategy"]["name"].as_str().unwrap().starts_with(&p)));
    // level 过滤：live_approved → 无；非法 level → 400；非法 kind → 400
    let r = http.get(format!("{url}/api/strategies?level=live_approved")).send().await.unwrap();
    let list: Value = r.json().await.unwrap();
    assert!(!list.as_array().unwrap().iter()
        .any(|e| e["strategy"]["name"].as_str().unwrap().starts_with(&p)));
    let r = http.get(format!("{url}/api/strategies?level=admin")).send().await.unwrap();
    assert_eq!(r.status(), 400);
    let r = http.get(format!("{url}/api/strategies?kind=builtin")).send().await.unwrap();
    assert_eq!(r.status(), 400);

    clean_strategies(&pool, &p).await;
}

#[tokio::test]
async fn create_validation_400() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    for body in [
        json!({ "name": "", "code": "x" }),
        json!({ "name": "x", "code": " " }),
        json!({ "name": "x", "code": "x", "kind": "builtin" }),
    ] {
        let r = http.post(format!("{url}/api/strategies")).json(&body).send().await.unwrap();
        assert_eq!(r.status(), 400, "{body}");
    }
}

/// 造 M1 accurate bar（close 递变；test-run 数据源）。
async fn seed_m1_bars(pool: &PgPool, code: &str, closes: &[f64]) {
    for (i, c) in closes.iter().enumerate() {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i as i64)).bind(c)
            .execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn test_run_both_modes_and_errors() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("99{}", std::process::id() % 10000);
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(&code).execute(&pool).await.unwrap();
    seed_m1_bars(&pool, &code, &[100.0, 100.0, 110.0, 110.0, 100.0, 100.0]).await;
    let from = (base() - Duration::minutes(1)).to_rfc3339();
    let to = (base() + Duration::minutes(10)).to_rfc3339();

    // pure_score：内联代码 + params
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&json!({ "code": CONST_SCORE, "params": {"score": 66}, "symbol": code,
                       "period": "M1", "from": from, "to": to, "mode": "pure_score" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "{:?}", r.text().await);
    let resp: Value = r.json().await.unwrap();
    assert_eq!(resp["bar_count"], 6);
    assert_eq!(resp["scores"].as_array().unwrap().len(), 6);
    assert_eq!(resp["scores"][0]["score"], 66.0);

    // sim_position：信号 + 成交
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&json!({ "code": TREND, "symbol": code,
                       "period": "M1", "from": from, "to": to, "mode": "sim_position" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "{:?}", r.text().await);
    let resp: Value = r.json().await.unwrap();
    assert_eq!(resp["signals"].as_array().unwrap().len(), 6);
    assert_eq!(resp["signals"][2]["signal"], "buy");
    assert_eq!(resp["trades"].as_array().unwrap().len(), 1);

    // version_id 源（draft 版本亦可试算）
    let p = pref("tr");
    clean_strategies(&pool, &p).await;
    let created = create(&http, &url, &format!("{p}-v"), CONST_SCORE).await;
    let vid = created["version"]["id"].as_str().unwrap();
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&json!({ "version_id": vid, "symbol": code,
                       "period": "M1", "from": from, "to": to, "mode": "pure_score" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["scores"][0]["score"], 80.0, "schema 默认填充");

    // 错误语义
    let cases = [
        // code 与 version_id 同给 → 400
        json!({ "code": "x", "version_id": "v", "symbol": code, "period": "M1",
                "from": from, "to": to, "mode": "pure_score" }),
        // mode 非法 → 400
        json!({ "code": CONST_SCORE, "symbol": code, "period": "M1",
                "from": from, "to": to, "mode": "xxx" }),
        // from 非 RFC3339 → 400
        json!({ "code": CONST_SCORE, "symbol": code, "period": "M1",
                "from": "2026-09-08", "to": to, "mode": "pure_score" }),
        // 未知 version_id → 404（单独断言）
    ];
    for (i, body) in cases.iter().enumerate() {
        let r = http.post(format!("{url}/api/strategies/test-run")).json(body).send().await.unwrap();
        assert_eq!(r.status(), 400, "case {i}");
    }
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&json!({ "version_id": "sv_none", "symbol": code, "period": "M1",
                       "from": from, "to": to, "mode": "pure_score" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 404);
    // 区间超限（D1 > 5 年）→ 400
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&json!({ "code": CONST_SCORE, "symbol": code, "period": "D1",
                       "from": "2020-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z",
                       "mode": "pure_score" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 400, "D1 超 5 年应 400");
    // 非法参数（未知键）→ 400
    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&json!({ "code": CONST_SCORE, "params": {"nope": 1}, "symbol": code,
                       "period": "M1", "from": from, "to": to, "mode": "pure_score" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 400);

    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(&code).execute(&pool).await.unwrap();
    clean_strategies(&pool, &p).await;
}
