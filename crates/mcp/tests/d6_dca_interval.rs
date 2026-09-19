//! **手写测试（非 entangled 生成物）**：D6 —— `Dca.interval` MCP 入口（`bt_run_ensemble`）契约。
//!
//! 与 `crates/web/tests/d6_dca_interval.rs` 同判据、不同入口：
//! - 契约①：`policy.Dca.interval = 0` → `isError`，文本含既有错误码 `[policy_invalid]` 且点名
//!   `Dca.interval`（MCP 无 HTTP 码，码由 `StructuredError::Display` 承载）。
//! - 契约②：省略 `interval` → 接受（返回 `run_id`），且执行等价 `interval=1`
//!   （`bt_get_run_audit` 的 `batches_done` 数值断言）。
//!
//! 需 TimescaleDB（ADR-025 临时库：`EESTOCK_TEST_DB_NAME=tmp_<lane>_<ts> scripts/testdb-init.sh`）。

use mcp::rpc::{dispatch, RpcRequest};
use mcp::state::{McpState, SessionRegistry};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;

async fn pool() -> PgPool {
    test_support::test_pool().await
}

/// 空进度汇（端口必须装配；本测试只观察提交/审计出口）。
struct NoopSink;
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for NoopSink {
    async fn send(&self, _run_id: &str, _progress: f64,
                  _bar_ts: Option<chrono::DateTime<chrono::Utc>>) -> anyhow::Result<()> {
        Ok(())
    }
}

fn state(pool: PgPool) -> Arc<McpState> {
    let strategy_store = Arc::new(storage::strategy::PgStrategyStore::new(pool.clone()));
    let strategies = Arc::new(application::strategy::StrategyService::new(
        strategy_store.clone(),
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    ));
    let kline = Arc::new(storage::reader::KlineReader::new(pool.clone()));
    let workbench = Arc::new(application::workbench::WorkbenchService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
        strategy_store,
        Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
        Arc::new(NoopSink),
        Arc::new(domain::ports::SystemClock),
        application::workbench::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(McpState {
        kline,
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        default_window_secs: 3600,
        sessions: SessionRegistry::default(),
        sim: None,
        strategies: Some(strategies),
        workbench: Some(workbench),
        strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    })
}

async fn call_raw(st: &McpState, name: &str, args: Value) -> Value {
    let req = RpcRequest {
        jsonrpc: Some("2.0".into()), id: Some(json!(1)), method: "tools/call".into(),
        params: Some(json!({ "name": name, "arguments": args })),
    };
    dispatch(st, &req).await.expect("tools/call 有响应")
}

/// 取 `result.content[0].text` 原文（不解析 —— 失败时文本是 message 而非 JSON）。
fn text(resp: &Value) -> String {
    resp["result"]["content"][0]["text"].as_str()
        .unwrap_or_else(|| panic!("缺 content[0].text：{resp}"))
        .to_string()
}

async fn call_ok(st: &McpState, name: &str, args: Value) -> Value {
    let resp = call_raw(st, name, args).await;
    assert_ne!(resp["result"]["isError"], json!(true), "[{name}] 不应失败：{resp}");
    serde_json::from_str(&text(&resp)).unwrap_or_else(|e| panic!("[{name}] content 非 JSON（{e}）：{resp}"))
}

// ── 夹具（隔离键 = 全 pid + 原子序号）──

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
        source: format!("d6mcp_{key}"),
        name_prefix: format!("d6mcp_{key}"),
    }
}

const TREND: &str = "function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }";

async fn seed_symbol_and_bars(pool: &PgPool, fx: &Fix) {
    use chrono::{Duration, TimeZone, Utc};
    let base = Utc.with_ymd_and_hms(2026, 9, 9, 1, 30, 0).unwrap();
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(&fx.code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(&fx.code).execute(pool).await.unwrap();
    for (i, c) in [100.0, 100.0, 110.0, 110.0, 100.0, 100.0].iter().enumerate() {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, $4) ON CONFLICT DO NOTHING")
            .bind(&fx.code).bind(base + Duration::minutes(i as i64)).bind(c).bind(&fx.source)
            .execute(pool).await.unwrap();
    }
}

async fn clean(pool: &PgPool, fx: &Fix) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(&fx.code).execute(pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{}%", fx.name_prefix)).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{}%", fx.name_prefix)).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(&fx.code).execute(pool).await.unwrap();
    for t in storage::reader::ORPHAN_TABLES {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1")).bind(&fx.code).execute(pool).await.unwrap();
    }
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(&fx.code).execute(pool).await.unwrap();
}

/// 建并发布一个插件策略（走 MCP 工具本身，确保入参口径与调用方一致）。
/// 返回 `(strategy_id, version_id)`：`bt_run_ensemble` 的 slots 要求 `strategy_id`（+ 可选 version_id）。
async fn create_published(st: &McpState, fx: &Fix) -> (String, String) {
    let created = call_ok(st, "strategy_create", json!({
        "name": format!("{}-trend", fx.name_prefix), "code": TREND,
    })).await;
    let sid = created["strategy"]["id"].as_str().unwrap().to_string();
    let vid = created["version"]["id"].as_str().unwrap().to_string();
    call_ok(st, "strategy_publish", json!({ "version_id": vid })).await;
    (sid, vid)
}

fn bt_args(fx: &Fix, sid: &str, vid: &str, policy: Value) -> Value {
    json!({
        "symbol": fx.code, "period": "M1",
        "from": "2026-09-09T01:29:00Z", "to": "2026-09-09T01:40:00Z",
        "slots": [{ "strategy_id": sid, "version_id": vid, "params": {}, "weight": 1.0 }],
        "policy": policy,
        "fee": { "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 },
    })
}

async fn wait_terminal(st: &McpState, run_id: &str) -> Value {
    for _ in 0..1500 {
        let v = call_ok(st, "bt_get_run", json!({ "run_id": run_id })).await;
        let status = v["status"].as_str().unwrap();
        if matches!(status, "succeeded" | "failed" | "canceled") {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("run {run_id} 30s 未达终态");
}

#[tokio::test]
async fn d6_mcp_bt_run_ensemble_rejects_interval_zero_loudly() {
    let pool = pool().await;
    let st = state(pool.clone());
    let fx = fix("zero");
    clean(&pool, &fx).await;
    seed_symbol_and_bars(&pool, &fx).await;
    let (sid, vid) = create_published(&st, &fx).await;

    let resp = call_raw(&st, "bt_run_ensemble", bt_args(
        &fx, &sid, &vid, json!({"Dca": {"mode": "Equal", "tranches": 2, "interval": 0}}),
    )).await;
    let raw = text(&resp);
    println!("[D6 mcp/interval=0] isError={} raw text={raw}", resp["result"]["isError"]);
    assert_eq!(resp["result"]["isError"], json!(true), "显式 interval=0 必须 isError：{resp}");
    // ⚠ MCP wire **不含** `code` 字段：`tools.rs::tool_fail` 只透传 Display message（全工具族一致，
    // 非 D6 引入；`WorkbenchValidation`/`StrategyValidation` 的 Display 不输出 code）。
    // ⇒ 结构化码 `policy_invalid` 在 **HTTP 面**断言（`crates/web/tests/d6_dca_interval.rs`）。
    // 本处只断言 MCP 面确实能拿到的信息：字段级定位 + 省略语义。
    assert!(raw.contains("Dca.interval"), "须字段级定位：{raw}");
    assert!(raw.contains("默认 1"), "须点明省略语义：{raw}");

    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM strategy_run WHERE symbol = $1")
        .bind(&fx.code).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0, "interval=0 被拒 ⇒ 不得入队任何 run");

    clean(&pool, &fx).await;
}

#[tokio::test]
async fn d6_mcp_bt_run_ensemble_omitted_interval_defaults_to_one() {
    let pool = pool().await;
    let st = state(pool.clone());
    let fx = fix("omit");
    clean(&pool, &fx).await;
    seed_symbol_and_bars(&pool, &fx).await;
    let (sid, vid) = create_published(&st, &fx).await;

    // 省略 interval（文档契约：可选，默认 1）→ 必须被接受。
    let resp = call_raw(&st, "bt_run_ensemble", bt_args(
        &fx, &sid, &vid, json!({"Dca": {"mode": "Equal", "tranches": 10}}),
    )).await;
    let raw = text(&resp);
    println!("[D6 mcp/omitted] isError={} raw text={raw}", resp["result"]["isError"]);
    assert_ne!(resp["result"]["isError"], json!(true), "省略 interval 必须被接受：{resp}");
    let out: Value = serde_json::from_str(&raw).unwrap();
    let run_id = out["run_id"].as_str().expect("须回 run_id").to_string();
    println!("[D6 mcp/omitted] pinned config.policy={}", out["run"]["config"]["policy"]);

    let fin = wait_terminal(&st, &run_id).await;
    assert_eq!(fin["status"], "succeeded", "应成功：{:?}", fin["error"]);
    let audit = call_ok(&st, "bt_get_run_audit", json!({ "run_id": run_id })).await;
    println!("[D6 mcp/omitted] audit batches_done={} reachable_batches={} planned_tranches={}",
        audit["batches_done"], audit["reachable_batches"], audit["planned_tranches"]);
    assert_eq!(audit["planned_tranches"], json!(10));
    assert_eq!(audit["reachable_batches"], json!(2), "trend fixture ⇒ 2 个 Buy 意图");
    assert_eq!(audit["batches_done"], json!(2), "省略 interval 等价 1 ⇒ 2 批");

    clean(&pool, &fx).await;
}
