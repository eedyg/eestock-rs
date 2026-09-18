//! ADR-024 P5 整改 N1 —— **结构化 400 表驱动覆盖**（`{error:{code,message,detail}}`）。
//! ⚠️ **非 tangle 手写**（ADR-007 例外）：契约在 `design/16-backtest-scalability/02-spec.md` §3.1.1。
//!
//! 判据来源（架构师 N1 裁决）：
//! - `crates/web/src/workbench.rs` 与 `crates/web/src/strategies.rs` 两模块内**所有** 400 一律结构化；
//!   `error` 字段**只允许一种类型**（对象），禁止 `{"error":"<字符串>"}` 与结构化混用；
//! - `code` 由**产生该消息的校验点**同源给出（application 层 `code()`），web 侧禁字符串解析；
//! - `detail` 恒为对象；提交/试算路径须含 `period`（有则）。
//!
//! 本文件是**表驱动**的：`CASES` 枚举每条 400 路径 → 断言 `(status, code)`；另加形状断言与
//! 「未知码回退」不适用（前端面在 vitest）。反向证据：把源头某个 code 改掉 ⇒ 本表必红。
//!
//! 需 TimescaleDB :5433（`EESTOCK_TEST_DATABASE_URL` + 哨兵表；ADR-023 E6b）。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    test_support::test_pool().await
}

fn pref(tag: &str) -> String {
    format!("se{}{}", std::process::id(), tag)
}

const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

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
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

// ── 夹具 ──

async fn seed_symbol_and_bars(pool: &PgPool, code: &str) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(code)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    for (i, c) in [100.0, 100.0, 110.0, 110.0, 100.0, 100.0].iter().enumerate() {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') ON CONFLICT DO NOTHING")
            .bind(code)
            .bind(base() + Duration::minutes(i as i64))
            .bind(c)
            .execute(pool)
            .await
            .unwrap();
    }
}

/// 建策略（返回 draft version_id；created 即 draft）。
async fn create_draft(http: &reqwest::Client, url: &str, name: &str, code: &str) -> String {
    let r = http
        .post(format!("{url}/api/strategies"))
        .json(&json!({ "name": name, "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    let created: Value = r.json().await.unwrap();
    created["version"]["id"].as_str().unwrap().to_string()
}

/// 建策略并发布（返回 published version_id）。
async fn create_published(http: &reqwest::Client, url: &str, name: &str, code: &str) -> String {
    let vid = create_draft(http, url, name, code).await;
    let r = http
        .post(format!("{url}/api/strategies/versions/{vid}/publish"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "publish 应 200: {:?}", r.text().await);
    vid
}

async fn clean(pool: &PgPool, code: &str, name_prefix: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy_preset WHERE name LIKE $1")
        .bind(format!("{name_prefix}%"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{name_prefix}%"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{name_prefix}%"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

// ── 断言：结构化形状（`error` 单一类型 + code + message + object detail）──

fn structured_code(v: &Value, expected: &str, what: &str) {
    assert!(
        v["error"].is_object(),
        "[{what}] `error` 必须是对象（禁与字符串混用）: {v}"
    );
    assert_eq!(v["error"]["code"], json!(expected), "[{what}] code 不符: {v}");
    assert!(v["error"]["message"].is_string(), "[{what}] message 须为字符串: {v}");
    assert!(
        v["error"]["detail"].is_object(),
        "[{what}] detail 须为对象: {v}"
    );
}

/// 发请求 → 断言 400 + 结构化 code。
async fn expect_400_code(
    what: &str,
    req: reqwest::RequestBuilder,
    expected_code: &str,
) -> Value {
    let r = req.send().await.unwrap();
    let status = r.status();
    let txt = r.text().await.unwrap();
    let v: Value = serde_json::from_str(&txt)
        .unwrap_or_else(|e| panic!("[{what}] 响应体非 JSON（{e}）: {txt:?}"));
    assert_eq!(status, 400, "[{what}] 应 400，实得 {status}: {txt}");
    structured_code(&v, expected_code, what);
    println!("[N1 {what}] 400 code={expected_code} body={v}");
    v
}

fn post(url: &str, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new().post(format!("{url}{path}"))
}

// ── 用例主体 ──

#[tokio::test]
async fn every_400_path_is_structured_with_code() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("97{}", std::process::id() % 10000);
    let p = pref("se");
    clean(&pool, &code, &p).await;
    seed_symbol_and_bars(&pool, &code).await;
    let vid_pub = create_published(&http, &url, &format!("{p}-pub"), CONST_SCORE).await;
    let vid_draft = create_draft(&http, &url, &format!("{p}-draft"), CONST_SCORE).await;

    let from = (base() - Duration::minutes(1)).to_rfc3339();
    let to = (base() + Duration::minutes(10)).to_rfc3339();
    let fee = json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 });
    let policy = json!({ "LumpSum": { "position_pct": 1.0 } });
    let slot = |vid: &str, w: f64| json!([{ "version_id": vid, "params": {}, "weight": w }]);
    // 提交体基线（各用例只覆盖一处，保证 400 归因唯一）。
    let submit = |over: Value| -> Value {
        let mut b = json!({
            "symbol": code, "period": "M1", "from": from, "to": to,
            "slots": slot(&vid_pub, 1.0), "policy": policy, "fee": fee,
        });
        for (k, v) in over.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    };
    let testrun = |over: Value| -> Value {
        let mut b = json!({
            "code": CONST_SCORE, "symbol": code, "period": "M1",
            "from": from, "to": to, "mode": "pure_score",
        });
        for (k, v) in over.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    };

    // ════════ POST /api/workbench/runs ════════
    let runs = "/api/workbench/runs";
    expect_400_code(
        "runs/symbol_required", post(&url, runs).json(&submit(json!({"symbol": "  "}))), "symbol_required").await;
    expect_400_code(
        "runs/period_invalid", post(&url, runs).json(&submit(json!({"period": "W1"}))), "period_invalid").await;
    expect_400_code(
        "runs/timestamp_invalid_from", post(&url, runs).json(&submit(json!({"from": "2026-09-08"}))), "timestamp_invalid").await;
    expect_400_code(
        "runs/timestamp_invalid_to", post(&url, runs).json(&submit(json!({"to": "2026-09-08"}))), "timestamp_invalid").await;
    expect_400_code(
        "runs/from_after_to", post(&url, runs).json(&submit(json!({"from": to, "to": from}))), "from_after_to").await;
    expect_400_code(
        "runs/slots_empty", post(&url, runs).json(&submit(json!({"slots": []}))), "slots_invalid").await;
    expect_400_code(
        "runs/slots_too_many",
        post(&url, runs).json(&submit(json!({"slots": (0..11).map(|_| json!({"version_id": vid_pub, "params": {}, "weight": 1.0})).collect::<Vec<_>>()}))),
        "slots_invalid",
    ).await;
    expect_400_code(
        "runs/fee_invalid_shape", post(&url, runs).json(&submit(json!({"fee": {"rate_pct": 0.025}}))), "fee_invalid").await;
    // 以下进入服务层（真库）
    expect_400_code(
        "runs/symbol_unregistered", post(&url, runs).json(&submit(json!({"symbol": "999999"}))), "symbol_unregistered").await;
    expect_400_code(
        "runs/slots_version_blank", post(&url, runs).json(&submit(json!({"slots": slot("  ", 1.0)}))), "slots_invalid").await;
    expect_400_code(
        "runs/weight_invalid", post(&url, runs).json(&submit(json!({"slots": slot(&vid_pub, 0.0)}))), "weight_invalid").await;
    expect_400_code(
        "runs/version_not_runnable", post(&url, runs).json(&submit(json!({"slots": slot(&vid_draft, 1.0)}))), "version_not_runnable").await;
    expect_400_code(
        "runs/params_invalid",
        post(&url, runs).json(&submit(json!({"slots": [{"version_id": vid_pub, "params": {"nope": 1}, "weight": 1.0}]}))),
        "params_invalid",
    ).await;
    expect_400_code(
        "runs/threshold_invalid", post(&url, runs).json(&submit(json!({"buy_threshold": 30.0, "sell_threshold": 70.0}))), "threshold_invalid").await;
    expect_400_code(
        "runs/policy_invalid", post(&url, runs).json(&submit(json!({"policy": {}}))), "policy_invalid").await;
    expect_400_code(
        "runs/stop_invalid", post(&url, runs).json(&submit(json!({"stop": {"kind": "FixedPct", "value": -1.0}}))), "stop_invalid").await;
    expect_400_code(
        "runs/capital_invalid", post(&url, runs).json(&submit(json!({"initial_capital": 0.0}))), "capital_invalid").await;
    expect_400_code(
        "runs/range_empty",
        post(&url, runs).json(&submit(json!({"from": (base() + Duration::days(10)).to_rfc3339(), "to": (base() + Duration::days(20)).to_rfc3339()}))),
        "range_empty",
    ).await;
    // 真库 518880 全历史 M1（≈77 万 bar ≥ 20 万）⇒ 资源护栏（不落 run）。
    expect_400_code(
        "runs/resource_guard",
        post(&url, runs).json(&json!({
            "symbol": "518880", "period": "M1",
            "from": "2013-07-29T01:30:00Z", "to": "2026-09-18T00:00:00Z",
            "slots": slot(&vid_pub, 1.0), "policy": policy, "fee": fee,
        })),
        "resource_guard",
    ).await;

    // 提交路径须在 detail 回显 period（架构师裁决：detail 至少含 period（有则））。
    let v = expect_400_code("runs/detail_period", post(&url, runs).json(&submit(json!({"period": "W1"}))), "period_invalid").await;
    assert_eq!(v["error"]["detail"]["period"], json!("W1"), "detail 须含请求 period: {v}");

    // ════════ 工作台其它端点（同模块 400 一律结构化）════════
    expect_400_code(
        "available_range/symbol_required", http.get(format!("{url}/api/workbench/available_range?symbol=&period=M1")), "symbol_required").await;
    expect_400_code(
        "available_range/period_invalid", http.get(format!("{url}/api/workbench/available_range?symbol=518880&period=W1")), "period_invalid").await;
    expect_400_code(
        "runs_list/status_invalid", http.get(format!("{url}/api/workbench/runs?status=nope")), "status_invalid").await;
    expect_400_code(
        "bars/kind_invalid",
        http.get(format!("{url}/api/workbench/runs/sr_x/bars?kind=nope")),
        "kind_invalid",
    ).await;
    expect_400_code(
        "bars/request_invalid_mutex",
        http.get(format!("{url}/api/workbench/runs/sr_x/bars?offset=0&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z")),
        "request_invalid",
    ).await;
    expect_400_code(
        "bars/request_invalid_from_only",
        http.get(format!("{url}/api/workbench/runs/sr_x/bars?from=2026-01-01T00:00:00Z")),
        "request_invalid",
    ).await;
    expect_400_code(
        "bars/timestamp_invalid",
        http.get(format!("{url}/api/workbench/runs/sr_x/bars?from=2026-01-01&to=2026-02-01T00:00:00Z")),
        "timestamp_invalid",
    ).await;
    expect_400_code(
        "bars/from_after_to",
        http.get(format!("{url}/api/workbench/runs/sr_x/bars?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z")),
        "from_after_to",
    ).await;
    expect_400_code(
        "curve/kind_invalid", http.get(format!("{url}/api/workbench/runs/sr_x/curve?kind=nope")), "kind_invalid").await;
    expect_400_code(
        "compare/ids_required", post(&url, "/api/workbench/runs/compare").json(&json!({"ids": []})), "ids_required").await;
    expect_400_code(
        "presets/name_required", post(&url, "/api/workbench/presets").json(&json!({"name": "  ", "config": {}})), "name_required").await;
    expect_400_code(
        "presets/config_invalid", post(&url, "/api/workbench/presets").json(&json!({"name": format!("{p}-preset"), "config": 42})), "config_invalid").await;
    expect_400_code(
        "presets/slots_invalid",
        post(&url, "/api/workbench/presets").json(&json!({"name": format!("{p}-preset"), "config": {"slots": []}})),
        "slots_invalid",
    ).await;
    expect_400_code(
        "presets/policy_invalid",
        post(&url, "/api/workbench/presets").json(&json!({"name": format!("{p}-preset"), "config": {
            "slots": slot(&vid_pub, 1.0), "fee": fee, "policy": {}
        }})),
        "policy_invalid",
    ).await;

    // ════════ /api/strategies 族 ════════
    expect_400_code(
        "catalog/level_invalid", http.get(format!("{url}/api/strategies?level=nope")), "level_invalid").await;
    expect_400_code(
        "catalog/kind_invalid", http.get(format!("{url}/api/strategies?kind=nope")), "kind_invalid").await;
    expect_400_code(
        "manage/kind_invalid", http.get(format!("{url}/api/strategies/manage?kind=nope")), "kind_invalid").await;
    expect_400_code(
        "create/name_required", post(&url, "/api/strategies").json(&json!({"name": " ", "code": CONST_SCORE})), "name_required").await;
    expect_400_code(
        "create/code_required", post(&url, "/api/strategies").json(&json!({"name": format!("{p}-x"), "code": "  "})), "code_required").await;
    expect_400_code(
        "create/kind_invalid", post(&url, "/api/strategies").json(&json!({"name": format!("{p}-x"), "code": CONST_SCORE, "kind": "nope"})), "kind_invalid").await;
    expect_400_code(
        "create_draft/source_invalid",
        post(&url, "/api/strategies/st_x/versions").json(&json!({"from_version_id": "  "})),
        "source_invalid",
    ).await;
    expect_400_code(
        "update_draft/code_required", reqwest::Client::new().put(format!("{url}/api/strategies/versions/{vid_draft}")).json(&json!({"code": "  "})), "code_required").await;
    expect_400_code(
        "diff/request_invalid", http.get(format!("{url}/api/strategies/versions/diff")), "request_invalid").await;
    // publish 门禁失败（坏代码 draft 可创建）
    let vid_bad = create_draft(&http, &url, &format!("{p}-bad"), "function score_it(ctx){return 1;}").await;
    expect_400_code(
        "publish/code_invalid",
        post(&url, &format!("/api/strategies/versions/{vid_bad}/publish")),
        "code_invalid",
    ).await;

    // ════════ POST /api/strategies/test-run（试算路径）════════
    let tr = "/api/strategies/test-run";
    expect_400_code(
        "testrun/source_invalid_both", post(&url, tr).json(&testrun(json!({"version_id": vid_pub}))), "source_invalid").await;
    expect_400_code(
        "testrun/source_invalid_none", post(&url, tr).json(&testrun(json!({"code": null}))), "source_invalid").await;
    expect_400_code(
        "testrun/symbol_required", post(&url, tr).json(&testrun(json!({"symbol": "  "}))), "symbol_required").await;
    expect_400_code(
        "testrun/mode_invalid", post(&url, tr).json(&testrun(json!({"mode": "xxx"}))), "mode_invalid").await;
    expect_400_code(
        "testrun/timestamp_invalid", post(&url, tr).json(&testrun(json!({"from": "2026-09-08"}))), "timestamp_invalid").await;
    expect_400_code(
        "testrun/timestamp_invalid_to", post(&url, tr).json(&testrun(json!({"to": "x"}))), "timestamp_invalid").await;
    expect_400_code(
        "testrun/from_after_to", post(&url, tr).json(&testrun(json!({"from": to, "to": from}))), "from_after_to").await;
    expect_400_code(
        "testrun/code_invalid", post(&url, tr).json(&testrun(json!({"code": "function score_it(ctx){return 1;}"}))), "code_invalid").await;
    expect_400_code(
        "testrun/params_invalid", post(&url, tr).json(&testrun(json!({"params": {"nope": 1}}))), "params_invalid").await;
    expect_400_code(
        "testrun/period_invalid", post(&url, tr).json(&testrun(json!({"period": "W1"}))), "period_invalid").await;
    expect_400_code(
        "testrun/policy_invalid", post(&url, tr).json(&testrun(json!({"policy": {}}))), "policy_invalid").await;
    expect_400_code(
        "testrun/capital_invalid", post(&url, tr).json(&testrun(json!({"initial_capital": 0.0}))), "capital_invalid").await;
    expect_400_code(
        "testrun/range_empty",
        post(&url, tr).json(&testrun(json!({"from": (base() + Duration::days(10)).to_rfc3339(), "to": (base() + Duration::days(20)).to_rfc3339()}))),
        "range_empty",
    ).await;
    // 试算 detail 亦须回显 period。
    let v = expect_400_code(
        "testrun/detail_period", post(&url, tr).json(&testrun(json!({"period": "W1"}))), "period_invalid").await;
    assert_eq!(v["error"]["detail"]["period"], json!("W1"), "试算 detail 须含请求 period: {v}");

    clean(&pool, &code, &p).await;
}

/// 前端 parity（ADR-024 §3.1.1 硬要求「前端必须能**编程**消费」）：
/// `web/src/api/errorMessages.ts` 的 `code → 中文提示` 映射必须覆盖
/// `application::error::codes::ALL` 的**每一个**码（新增码未覆盖 ⇒ 本用例红）。
#[test]
fn frontend_code_message_map_covers_every_backend_code() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web/src/api/errorMessages.ts");
    let src = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到前端码映射 {}: {e}", path.display()));
    let mut missing = Vec::new();
    for c in application::error::codes::ALL {
        // 映射表键写成 `code:` 形式（TS 对象字面量）。
        if !src.contains(&format!("{c}:")) {
            missing.push(*c);
        }
    }
    assert!(missing.is_empty(), "前端映射缺码（新增码须同步 web/src/api/errorMessages.ts）: {missing:?}");
}
