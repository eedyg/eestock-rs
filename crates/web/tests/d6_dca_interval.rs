//! **手写测试（非 entangled 生成物）**：D6 —— `Dca.interval` 后端直连入口（HTTP）契约。
//!
//! 判据来源：
//! - 契约①（fail loud）：`interval == 0` → 结构化 400，`code = policy_invalid`，消息点名
//!   「Dca.interval 必须 ≥ 1（省略即为默认 1）」（错误码体系复用 ADR-024 §3.1.1）。
//! - 契约②（省略 = 默认 1）：`{"Dca":{...}}` 省略 `interval` → 201 接受，且**执行等价于 interval=1**。
//! - 契约③（≥1 行为不变）：以 `interval=5` 作对照 run（同一 fixture 上 `batches_done` 必须不同）
//!   ——证明本用例的等价性断言**可判别**（不是恒真）。
//!
//! 需 TimescaleDB（ADR-025 临时库：`EESTOCK_TEST_DB_NAME=tmp_<lane>_<ts> scripts/testdb-init.sh`）。

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
    // ADR-023 E6b：统一测试库入口（EESTOCK_TEST_DATABASE_URL + 哨兵表校验），不得回退活库。
    test_support::test_pool().await
}

/// 用例私有夹具（并发隔离键 = 全 pid + 进程内原子序号），与 `adr026_run_audit.rs` 同模板。
struct Fix {
    code: String,
    source: String,
    name_prefix: String,
}

static FIX_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn fix(tag: &str) -> Fix {
    let seq = FIX_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let key = format!("{}_{}_{}", std::process::id(), seq, tag);
    Fix {
        code: format!("9{}{:03}", std::process::id(), seq),
        source: format!("d6_{key}"),
        name_prefix: format!("d6_{key}"),
    }
}

/// 趋势插件（close > 105 → 90 分 Buy，否则 20 分 Sell；6 bar fixture ⇒ 恰好 2 个 Buy 意图）。
const TREND: &str = "function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }";

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

async fn seed_symbol_and_bars(pool: &PgPool, fx: &Fix) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(&fx.code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(&fx.code).execute(pool).await.unwrap();
    for (i, c) in [100.0, 100.0, 110.0, 110.0, 100.0, 100.0].iter().enumerate() {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, $4) ON CONFLICT DO NOTHING")
            .bind(&fx.code).bind(base() + Duration::minutes(i as i64)).bind(c).bind(&fx.source)
            .execute(pool).await.unwrap();
    }
}

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

fn submit_body(symbol: &str, version_id: &str, policy: Value) -> Value {
    json!({
        "symbol": symbol,
        "period": "M1",
        "from": (base() - Duration::minutes(1)).to_rfc3339(),
        "to": (base() + Duration::minutes(10)).to_rfc3339(),
        "slots": [{"version_id": version_id, "params": {}, "weight": 1.0}],
        "policy": policy,
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    })
}

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

/// 提交一条 DCA run 并取审计（`batches_done` = Buy 成交批次数）。
async fn submit_and_audit(
    http: &reqwest::Client,
    url: &str,
    fx: &Fix,
    vid: &str,
    policy: Value,
    what: &str,
) -> Value {
    let body = submit_body(&fx.code, vid, policy);
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let status = r.status();
    let txt = r.text().await.unwrap();
    println!("[D6 {what}] submit status={status} body={txt}");
    assert_eq!(status, 201, "[{what}] 应 201（接受）: {txt}");
    let run: Value = serde_json::from_str(&txt).unwrap();
    let run_id = run["id"].as_str().unwrap().to_string();
    println!("[D6 {what}] pinned config.policy={}", run["config"]["policy"]);
    let fin = wait_terminal(http, url, &run_id).await;
    assert_eq!(fin["status"], "succeeded", "[{what}] 应成功: {:?}", fin["error"]);
    let a: Value = http
        .get(format!("{url}/api/workbench/runs/{run_id}/audit"))
        .send().await.unwrap().json().await.unwrap();
    println!("[D6 {what}] audit batches_done={} reachable_batches={} planned_tranches={}",
        a["batches_done"], a["reachable_batches"], a["planned_tranches"]);
    a
}

async fn clean(pool: &PgPool, fx: &Fix) {
    let code = &fx.code;
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{}%", fx.name_prefix)).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{}%", fx.name_prefix)).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    for t in storage::reader::ORPHAN_TABLES {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1")).bind(code).execute(pool).await.unwrap();
    }
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

#[tokio::test]
async fn d6_workbench_entry_rejects_interval_zero_loudly() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let fx = fix("zero");
    clean(&pool, &fx).await;
    seed_symbol_and_bars(&pool, &fx).await;
    let vid = create_published(&http, &url, &format!("{}-trend", fx.name_prefix), TREND).await;

    let body = submit_body(
        &fx.code,
        &vid,
        json!({"Dca": {"mode": "Equal", "tranches": 2, "interval": 0}}),
    );
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let status = r.status();
    let txt = r.text().await.unwrap();
    println!("[D6 workbench/interval=0] status={status} raw body={txt}");
    assert_eq!(status, 400, "显式 interval=0 必须 400（fail loud），实得 {status}: {txt}");
    let v: Value = serde_json::from_str(&txt).unwrap();
    assert!(v["error"].is_object(), "`error` 须为对象（ADR-024 §3.1.1）: {txt}");
    assert_eq!(v["error"]["code"], json!("policy_invalid"), "code 须复用既有体系: {txt}");
    let msg = v["error"]["message"].as_str().unwrap();
    assert!(msg.contains("Dca.interval"), "消息须字段级定位: {msg}");
    assert!(msg.contains("≥ 1"), "消息须含下限语义: {msg}");
    assert!(msg.contains("默认 1"), "消息须点明「省略即为默认 1」: {msg}");

    // 不得落 run（拒绝于提交态）。
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM strategy_run WHERE symbol = $1")
        .bind(&fx.code).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0, "interval=0 被拒 ⇒ 不得入队任何 run");

    clean(&pool, &fx).await;
}

#[tokio::test]
async fn d6_workbench_entry_omitted_interval_defaults_to_one_and_executes_like_one() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let fx = fix("omit");
    clean(&pool, &fx).await;
    seed_symbol_and_bars(&pool, &fx).await;
    let vid = create_published(&http, &url, &format!("{}-trend", fx.name_prefix), TREND).await;

    // (a) 省略 interval（文档契约：可选，默认 1）→ 必须被接受。
    let omitted = submit_and_audit(
        &http, &url, &fx, &vid,
        json!({"Dca": {"mode": "Equal", "tranches": 10}}),
        "omit/omitted",
    ).await;
    // (b) 显式 interval=1 → 基准。
    let explicit1 = submit_and_audit(
        &http, &url, &fx, &vid,
        json!({"Dca": {"mode": "Equal", "tranches": 10, "interval": 1}}),
        "omit/interval=1",
    ).await;
    // (c) 对照 interval=5（证明该判据可判别：不同 k ⇒ 批次数不同）。
    let explicit5 = submit_and_audit(
        &http, &url, &fx, &vid,
        json!({"Dca": {"mode": "Equal", "tranches": 10, "interval": 5}}),
        "omit/interval=5",
    ).await;

    // 夹具语义：6 根 bar 中 bar2/bar3 为 Buy（trend）⇒ 2 个可达批次。
    assert_eq!(omitted["planned_tranches"], json!(10));
    assert_eq!(omitted["reachable_batches"], json!(2), "trend fixture ⇒ 2 个 Buy 意图");
    // 核心断言：省略 == 显式 1（数值级）。
    assert_eq!(omitted["batches_done"], json!(2), "省略 interval ⇒ 等价 interval=1 ⇒ 2 批");
    assert_eq!(omitted["batches_done"], explicit1["batches_done"], "省略 vs 显式 1 批次数须相等");
    assert_eq!(omitted["deployed_notional"], explicit1["deployed_notional"], "省略 vs 显式 1 敞口须相等");
    // 判据可判别性：interval=5 时 bar3（第 2 个 Buy bar）不触发 ⇒ 1 批。
    assert_eq!(explicit5["batches_done"], json!(1), "interval=5 在 2 个 Buy bar 上只应触发 1 批");
    assert_ne!(explicit5["batches_done"], omitted["batches_done"], "判据须能区分 k=1 与 k=5");

    clean(&pool, &fx).await;
}
