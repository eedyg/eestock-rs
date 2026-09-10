//! 回测工作台端点集成测试（需 TimescaleDB :5433，含 0022+0023 迁移）：真实起 axum server + reqwest 断言。
//! ⚠️ **非 tangle 手写**（ADR-007 例外）：契约在 design/07-app-plane/00-web-api.md §1.8，本文件不 tangle。
//! 覆盖：submit 生命周期（queued→succeeded + 钉住快照 + 结果五 jsonb）/ 校验 400/404 全路径 /
//! 取消语义（queued 取消 200 / 终态 409 / 未知 404）/ compare 并排结构 / preset CRUD+apply（重名 409）。
//! 每测试用独立 symbol/preset 名前缀（并行隔离）；运行轮询带超时防挂死。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use domain::ports::StrategyRunStore as _;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn pref(tag: &str) -> String {
    format!("wb{}{}", std::process::id(), tag)
}

/// 趋势插件（close > 105 → 90 分 Buy，否则 20 分 Sell；6 bar fixture 产生 1 笔交易）。
const TREND: &str = "function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }";

/// 恒分插件（带参数 schema，验证 params 缺省填充入快照）。
const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

/// 测试装配（与 app bin 同口径）：storage 具体实现注入 domain 端口 + WorkbenchService + StrategyService。
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
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

// ── 测试辅助 ──

/// 注册 symbol + 造 6 根 M1 accurate bar（trend closes；submit 数据源）。
async fn seed_symbol_and_bars(pool: &PgPool, code: &str) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    for (i, c) in [100.0, 100.0, 110.0, 110.0, 100.0, 100.0].iter().enumerate() {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i as i64)).bind(c)
            .execute(pool).await.unwrap();
    }
}

/// 创建并发布策略（经 REST /api/strategies；返回 version_id）。
async fn create_published(http: &reqwest::Client, url: &str, name: &str, code: &str) -> String {
    let r = http.post(format!("{url}/api/strategies"))
        .json(&json!({ "name": name, "code": code }))
        .send().await.unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    let created: Value = r.json().await.unwrap();
    let vid = created["version"]["id"].as_str().unwrap().to_string();
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish"))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "publish 应 200: {:?}", r.text().await);
    vid
}

fn submit_body(symbol: &str, version_id: &str) -> Value {
    json!({
        "symbol": symbol,
        "period": "M1",
        "from": (base() - Duration::minutes(1)).to_rfc3339(),
        "to": (base() + Duration::minutes(10)).to_rfc3339(),
        "slots": [{"version_id": version_id, "params": {}, "weight": 1.0}],
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    })
}

/// 轮询 GET run 直至终态（30s 超时）。
async fn wait_terminal(http: &reqwest::Client, url: &str, id: &str) -> Value {
    for _ in 0..1500 {
        let r = http.get(format!("{url}/api/workbench/runs/{id}")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        let status = v["status"].as_str().unwrap();
        if matches!(status, "succeeded" | "failed" | "canceled") {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("run {id} 30s 未达终态");
}

async fn clean(pool: &PgPool, code: &str, name_prefix: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy_preset WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

// ── 端到端：submit → 钉住快照 → succeeded → 结果五 jsonb → list ──

#[tokio::test]
async fn submit_run_lifecycle_end_to_end() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("88{}", std::process::id() % 10000);
    let p = pref("lc");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-trend"), TREND).await;

    // submit → 201 queued + config 钉住快照
    let r = http.post(format!("{url}/api/workbench/runs"))
        .json(&submit_body(&code, &vid)).send().await.unwrap();
    assert_eq!(r.status(), 201, "submit 应 201: {:?}", r.text().await);
    let run: Value = r.json().await.unwrap();
    let run_id = run["id"].as_str().unwrap().to_string();
    assert_eq!(run["status"], "queued");
    let slot = &run["config"]["slots"][0];
    assert_eq!(slot["version_id"], vid, "快照钉住 version_id");
    assert_eq!(slot["sha256"].as_str().unwrap().len(), 64, "快照钉住 sha256");
    assert!(slot["strategy_id"].as_str().unwrap().starts_with("st_"));
    assert_eq!(slot["archived"], false, "published 版本审计标记为 false");
    assert_eq!(run["config"]["buy_threshold"], 60.0, "阈值缺省 60");

    // 等待成功 → progress 1 / started_at/finished_at 齐
    let fin = wait_terminal(&http, &url, &run_id).await;
    assert_eq!(fin["status"], "succeeded", "应成功: {:?}", fin["error"]);
    assert_eq!(fin["progress"], 1.0);
    assert!(fin["started_at"].is_string() && fin["finished_at"].is_string());

    // 结果：per_bar 全量（6 bar）+ trades 1 笔 + net_value/drawdown + metrics 对象
    let r = http.get(format!("{url}/api/workbench/runs/{run_id}/result")).send().await.unwrap();
    assert_eq!(r.status(), 200, "result 应 200: {:?}", r.text().await);
    let res: Value = r.json().await.unwrap();
    let per_bar = res["per_bar"].as_array().unwrap();
    assert_eq!(per_bar.len(), 6, "per_bar 全量 6 bar");
    for key in ["ts", "scores", "aggregate", "signal", "orders", "events"] {
        assert!(per_bar[0].get(key).is_some(), "per_bar 记录缺字段 {key}");
    }
    assert_eq!(res["trades"].as_array().unwrap().len(), 1, "TREND fixture 1 笔交易");
    assert_eq!(res["net_value"].as_array().unwrap().len(), 6);
    assert_eq!(res["drawdown"].as_array().unwrap().len(), 6);
    assert!(res["metrics"].is_object());

    // list：状态过滤命中 + 轻量（无结果列）
    let r = http.get(format!("{url}/api/workbench/runs?status=succeeded&limit=50"))
        .send().await.unwrap();
    assert_eq!(r.status(), 200);
    let list: Value = r.json().await.unwrap();
    let mine: Vec<_> = list.as_array().unwrap().iter()
        .filter(|v| v["id"].as_str() == Some(run_id.as_str())).collect();
    assert_eq!(mine.len(), 1, "succeeded 过滤应命中");
    // 非法 status → 400
    let r = http.get(format!("{url}/api/workbench/runs?status=bogus")).send().await.unwrap();
    assert_eq!(r.status(), 400);

    // 未知 id → 404
    let r = http.get(format!("{url}/api/workbench/runs/sr_none")).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let r = http.get(format!("{url}/api/workbench/runs/sr_none/result")).send().await.unwrap();
    assert_eq!(r.status(), 404);

    clean(&pool, &code, &p).await;
}

// ── submit 校验错误语义（400/404）──

#[tokio::test]
async fn submit_validation_error_matrix() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("87{}", std::process::id() % 10000);
    let p = pref("val");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-const"), CONST_SCORE).await;
    // draft 版本（未发布）
    let r = http.post(format!("{url}/api/strategies"))
        .json(&json!({ "name": format!("{p}-draft"), "code": CONST_SCORE }))
        .send().await.unwrap();
    let draft_vid = r.json::<Value>().await.unwrap()["version"]["id"].as_str().unwrap().to_string();

    // 未注册 symbol → 400
    let r = http.post(format!("{url}/api/workbench/runs"))
        .json(&submit_body("000000", &vid)).send().await.unwrap();
    assert_eq!(r.status(), 400, "未注册 symbol 应 400: {:?}", r.text().await);
    // draft 版本 → 400（未发布不可运行，与 404 不存在区分）
    let r = http.post(format!("{url}/api/workbench/runs"))
        .json(&submit_body(&code, &draft_vid)).send().await.unwrap();
    assert_eq!(r.status(), 400, "draft 版本应 400: {:?}", r.text().await);
    let body: Value = r.json().await.unwrap();
    let msg = body["error"].as_str().unwrap_or_default().to_string();
    assert!(msg.contains("未发布") && msg.contains("draft"),
        "draft 文案须区分「未发布不可运行」: {msg}");
    // 未知版本 → 404
    let r = http.post(format!("{url}/api/workbench/runs"))
        .json(&submit_body(&code, "sv_none")).send().await.unwrap();
    assert_eq!(r.status(), 404, "未知版本应 404");
    // period 非法 → 400
    let mut b = submit_body(&code, &vid);
    b["period"] = json!("H1");
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // from/to 非 RFC3339 → 400
    let mut b = submit_body(&code, &vid);
    b["from"] = json!("not-a-time");
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // 区间超限（M1 > 3 个月）→ 400
    let mut b = submit_body(&code, &vid);
    b["to"] = json!((base() + Duration::days(94)).to_rfc3339());
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400, "区间超限应 400");
    // slots 空 → 400
    let mut b = submit_body(&code, &vid);
    b["slots"] = json!([]);
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // weight ≤ 0 → 400
    let mut b = submit_body(&code, &vid);
    b["slots"][0]["weight"] = json!(0.0);
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // 阈值倒挂 → 400
    let mut b = submit_body(&code, &vid);
    b["buy_threshold"] = json!(30.0);
    b["sell_threshold"] = json!(50.0);
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // 非法 policy → 400
    let mut b = submit_body(&code, &vid);
    b["policy"] = json!({"LumpSum": {"position_pct": 2.0}});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // 非法 stop → 400
    let mut b = submit_body(&code, &vid);
    b["stop"] = json!({"kind": "FixedPct", "value": -0.1});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // fee 缺字段 → 400
    let mut b = submit_body(&code, &vid);
    b["fee"] = json!({"rate_pct": 0.025});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // params 越 schema → 400
    let mut b = submit_body(&code, &vid);
    b["slots"][0]["params"] = json!({"score": 500});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // 区间无 bar（未播种的已注册 symbol）→ 400
    let code2 = format!("86{}", std::process::id() % 10000);
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(&code2).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(&code2).execute(&pool).await.unwrap();
    let r = http.post(format!("{url}/api/workbench/runs"))
        .json(&submit_body(&code2, &vid)).send().await.unwrap();
    assert_eq!(r.status(), 400, "空区间应 400: {:?}", r.text().await);

    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(&code2).execute(&pool).await.unwrap();
    clean(&pool, &code, &p).await;
}

// ── 审计重跑（2026-09-10 裁决）：archived 版本可 submit，config 快照钉住 archived 审计标记 ──

#[tokio::test]
async fn submit_archived_version_audit_rerun_201() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("85{}", std::process::id() % 10000);
    let p = pref("audit");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-const"), CONST_SCORE).await;
    // 归档（published → archived）
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/archive"))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "archive 应 200: {:?}", r.text().await);

    // archived 版本审计重跑 → 201 + 审计标记
    let r = http.post(format!("{url}/api/workbench/runs"))
        .json(&submit_body(&code, &vid)).send().await.unwrap();
    assert_eq!(r.status(), 201, "archived 版本审计重跑应 201: {:?}", r.text().await);
    let run: Value = r.json().await.unwrap();
    let run_id = run["id"].as_str().unwrap().to_string();
    let slot = &run["config"]["slots"][0];
    assert_eq!(slot["version_id"], vid, "快照钉住 version_id");
    assert_eq!(slot["archived"], true, "审计标记 archived=true");
    assert_eq!(slot["sha256"].as_str().unwrap().len(), 64, "快照钉住 sha256");

    // 详情返回该标记 + 审计重跑至成功
    let fin = wait_terminal(&http, &url, &run_id).await;
    assert_eq!(fin["status"], "succeeded", "审计重跑应成功: {:?}", fin["error"]);
    assert_eq!(fin["config"]["slots"][0]["archived"], true, "详情返回审计标记");

    clean(&pool, &code, &p).await;
}

// ── 取消语义 ──

#[tokio::test]
async fn cancel_run_semantics() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("85{}", std::process::id() % 10000);
    let p = pref("cxl");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-trend"), TREND).await;

    // 未知 id → 404
    let r = http.post(format!("{url}/api/workbench/runs/sr_none/cancel")).send().await.unwrap();
    assert_eq!(r.status(), 404);

    // 直插 queued 行（确定性，不与引擎竞速）→ cancel 200 canceled
    let store = storage::workbench::PgStrategyRunStore::new(pool.clone());
    let qid = format!("sr_{}_queued", std::process::id());
    store
        .create_run(&domain::ports::NewStrategyRun {
            id: qid.clone(),
            name: "q".into(),
            symbol: code.clone(),
            period: "M1".into(),
            from_ts: base(),
            to_ts: base() + Duration::minutes(10),
            config: json!({"slots": []}),
        })
        .await
        .unwrap();
    let r = http.post(format!("{url}/api/workbench/runs/{qid}/cancel")).send().await.unwrap();
    assert_eq!(r.status(), 200, "queued 取消应 200: {:?}", r.text().await);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "canceled");
    assert!(v["finished_at"].is_string());
    // 已终态再取消 → 409
    let r = http.post(format!("{url}/api/workbench/runs/{qid}/cancel")).send().await.unwrap();
    assert_eq!(r.status(), 409, "终态取消应 409");
    // canceled run 无结果 → result 404
    let r = http.get(format!("{url}/api/workbench/runs/{qid}/result")).send().await.unwrap();
    assert_eq!(r.status(), 404);

    // succeeded 终态取消 → 409
    let r = http.post(format!("{url}/api/workbench/runs"))
        .json(&submit_body(&code, &vid)).send().await.unwrap();
    let run_id = r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let fin = wait_terminal(&http, &url, &run_id).await;
    assert_eq!(fin["status"], "succeeded");
    let r = http.post(format!("{url}/api/workbench/runs/{run_id}/cancel")).send().await.unwrap();
    assert_eq!(r.status(), 409, "succeeded 取消应 409");

    clean(&pool, &code, &p).await;
}

// ── compare 并排结构 ──

#[tokio::test]
async fn compare_endpoint_side_by_side() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("84{}", std::process::id() % 10000);
    let p = pref("cmp");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-trend"), TREND).await;

    let mut ids = vec![];
    for _ in 0..2 {
        let r = http.post(format!("{url}/api/workbench/runs"))
            .json(&submit_body(&code, &vid)).send().await.unwrap();
        assert_eq!(r.status(), 201);
        ids.push(r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string());
    }
    for id in &ids {
        assert_eq!(wait_terminal(&http, &url, id).await["status"], "succeeded");
    }

    // 输入序保持；未知 id 跳过
    let r = http.post(format!("{url}/api/workbench/runs/compare"))
        .json(&json!({ "ids": [ids[1], "sr_none".to_string(), ids[0]] }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "compare 应 200: {:?}", r.text().await);
    let items: Value = r.json().await.unwrap();
    let arr = items.as_array().unwrap();
    assert_eq!(arr.len(), 2, "未知 id 跳过");
    assert_eq!(arr[0]["run_id"], ids[1], "按输入序");
    assert_eq!(arr[1]["run_id"], ids[0]);
    assert!(arr[0]["net_value"].is_array() && !arr[0]["net_value"].as_array().unwrap().is_empty());
    assert!(arr[0]["metrics"].is_object(), "metrics 并排");
    assert_eq!(arr[0]["symbol"], code);

    // ids 空 → 400
    let r = http.post(format!("{url}/api/workbench/runs/compare"))
        .json(&json!({ "ids": [] })).send().await.unwrap();
    assert_eq!(r.status(), 400);

    clean(&pool, &code, &p).await;
}

// ── preset CRUD + apply ──

#[tokio::test]
async fn preset_crud_apply_end_to_end() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("83{}", std::process::id() % 10000);
    let p = pref("pre");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid = create_published(&http, &url, &format!("{p}-const"), CONST_SCORE).await;

    let cfg = json!({
        "slots": [{"version_id": vid, "params": {}, "weight": 1.0}],
        "buy_threshold": 60.0, "sell_threshold": 40.0,
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "stop": null,
        "initial_capital": 100000.0,
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    });
    let name = format!("{p}-组合A");

    // create → 201 + 钉住 sha256/params 缺省填充
    let r = http.post(format!("{url}/api/workbench/presets"))
        .json(&json!({ "name": name, "config": cfg })).send().await.unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    let preset: Value = r.json().await.unwrap();
    let pid = preset["id"].as_str().unwrap().to_string();
    assert!(pid.starts_with("sp_"));
    assert_eq!(preset["config"]["slots"][0]["sha256"].as_str().unwrap().len(), 64, "钉住 sha256");
    assert_eq!(preset["config"]["slots"][0]["params"]["score"], 80.0, "params 缺省填充");
    assert_eq!(preset["config"]["slots"][0]["version_id"], vid);

    // 重名 → 409
    let r = http.post(format!("{url}/api/workbench/presets"))
        .json(&json!({ "name": name, "config": cfg })).send().await.unwrap();
    assert_eq!(r.status(), 409, "重名应 409");
    // name 空 → 400
    let r = http.post(format!("{url}/api/workbench/presets"))
        .json(&json!({ "name": "  ", "config": cfg })).send().await.unwrap();
    assert_eq!(r.status(), 400);
    // 非法配置（weight=0）→ 400
    let mut bad = cfg.clone();
    bad["slots"][0]["weight"] = json!(0.0);
    let r = http.post(format!("{url}/api/workbench/presets"))
        .json(&json!({ "name": format!("{p}-组合B"), "config": bad })).send().await.unwrap();
    assert_eq!(r.status(), 400, "非法配置应 400");

    // get / list
    let r = http.get(format!("{url}/api/workbench/presets/{pid}")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let r = http.get(format!("{url}/api/workbench/presets/sp_none")).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let r = http.get(format!("{url}/api/workbench/presets")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.json::<Value>().await.unwrap().as_array().unwrap().iter()
        .any(|v| v["id"].as_str() == Some(pid.as_str())));

    // update → 200（改名；updated_at 推进）
    let updated_at0 = preset["updated_at"].as_str().unwrap().to_string();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let r = http.put(format!("{url}/api/workbench/presets/{pid}"))
        .json(&json!({ "name": format!("{p}-组合A改"), "config": cfg })).send().await.unwrap();
    assert_eq!(r.status(), 200, "update 应 200: {:?}", r.text().await);
    let up: Value = r.json().await.unwrap();
    assert_eq!(up["name"], format!("{p}-组合A改"));
    assert_ne!(up["updated_at"].as_str().unwrap(), updated_at0, "updated_at 应推进");
    // update 未知 → 404
    let r = http.put(format!("{url}/api/workbench/presets/sp_none"))
        .json(&json!({ "name": "x", "config": cfg })).send().await.unwrap();
    assert_eq!(r.status(), 404);

    // apply → 200 返回钉住 config（供 submit 用）
    let r = http.post(format!("{url}/api/workbench/presets/{pid}/apply")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let applied: Value = r.json().await.unwrap();
    assert_eq!(applied["slots"][0]["version_id"], vid);
    assert!(applied["slots"][0]["sha256"].is_string());
    let r = http.post(format!("{url}/api/workbench/presets/sp_none/apply")).send().await.unwrap();
    assert_eq!(r.status(), 404);

    // apply 的 config 可直接用于 submit（合并 symbol/period/from/to）→ 201
    let mut submit = applied.clone();
    submit["symbol"] = json!(code);
    submit["period"] = json!("M1");
    submit["from"] = json!((base() - Duration::minutes(1)).to_rfc3339());
    submit["to"] = json!((base() + Duration::minutes(10)).to_rfc3339());
    let r = http.post(format!("{url}/api/workbench/runs")).json(&submit).send().await.unwrap();
    assert_eq!(r.status(), 201, "apply config 应可直接 submit: {:?}", r.text().await);
    let run_id = r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(wait_terminal(&http, &url, &run_id).await["status"], "succeeded");

    // delete → 200；再删 → 404
    let r = http.delete(format!("{url}/api/workbench/presets/{pid}")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let r = http.delete(format!("{url}/api/workbench/presets/{pid}")).send().await.unwrap();
    assert_eq!(r.status(), 404);

    clean(&pool, &code, &p).await;
}
