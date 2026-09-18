//! **tester 独立验收**（ADR-024 P4 / D8-D10 / §4）——MCP `bt_get_run_result` 分块/兼容读。
//! ⚠️ 非 tangle 手写；由 tester 独立编写（不复用 worker 的 `crates/mcp/tests/*` 断言）。
//!
//! 判据：`02-spec.md` §3.2 兼容矩阵 + §4「`bt_get_run_result` 默认行为与 REST `/result` 一致
//! （首页 + `has_more`）」；硬要求「禁止静默读空」。
//! 造行方式：直接在临时库手工插 `strategy_run` + `strategy_run_result` + `strategy_run_bars`
//! （不跑引擎）；只经 `mcp::rpc::dispatch` 的 `tools/call` 观察工具出口。

use mcp::rpc::{dispatch, RpcRequest};
use mcp::state::{McpState, SessionRegistry};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;

async fn pool() -> PgPool {
    test_support::test_pool().await
}

/// 空进度汇（本测试不起引擎；端口必须装配）。
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

async fn call(st: &McpState, name: &str, args: Value) -> Value {
    let resp = call_raw(st, name, args).await;
    let text = resp["result"]["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).unwrap_or_else(|e| {
        panic!("content 文本不是 JSON（{e}）：raw resp = {resp}")
    })
}

fn t0() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-09-09T01:30:00Z").unwrap().to_utc()
}
fn ts_min(i: i64) -> chrono::DateTime<chrono::Utc> {
    t0() + chrono::Duration::minutes(i)
}
fn per_bar_obj(i: i64) -> Value {
    json!({"ts": ts_min(i).timestamp(), "scores": [], "aggregate": 80.0, "signal": "Hold",
           "orders": [], "events": []})
}
fn rid(tag: &str) -> String {
    format!("tp4m{}_{tag}", std::process::id())
}

async fn craft_run(pool: &PgPool, id: &str, status: &str) {
    sqlx::query(
        "INSERT INTO strategy_run (id, name, symbol, period, from_ts, to_ts, config, status, progress, \
                                   created_at, started_at, finished_at) \
         VALUES ($1, $2, '999999', 'M1', $3, $4, '{}'::jsonb, $5, 1.0, now(), now(), now())")
        .bind(id).bind(format!("tester-mcp-{id}")).bind(t0()).bind(t0() + chrono::Duration::days(1))
        .bind(status).execute(pool).await.unwrap();
}

async fn clean(pool: &PgPool, id: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE id = $1").bind(id).execute(pool).await.unwrap();
}

#[tokio::test]
async fn t_p4_mcp_bt_get_run_result_chunked_first_page_and_legacy_full() {
    let pool = pool().await;
    let st = state(pool.clone());

    // ── (a) chunked_v1：首页 5000 + has_more + next_offset（不得静默读空） ──
    let cid = rid("chunked");
    clean(&pool, &cid).await;
    craft_run(&pool, &cid, "succeeded").await;
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, trades, net_value, drawdown, metrics, result_format) \
         VALUES ($1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{\"total_return_pct\":4.0}'::jsonb, 'chunked_v1')")
        .bind(&cid).execute(&pool).await.unwrap();
    let n = 6000i64;
    let a: Vec<Value> = (0..5000).map(per_bar_obj).collect();
    let b: Vec<Value> = (5000..n).map(per_bar_obj).collect();
    for (seq, payload, from_i, to_i) in [(0i32, a, 0i64, 4999i64), (1, b, 5000, n - 1)] {
        sqlx::query(
            "INSERT INTO strategy_run_bars (run_id, kind, seq, ts_from, ts_to, payload) \
             VALUES ($1, 'per_bar', $2, $3, $4, $5::jsonb)")
            .bind(&cid).bind(seq).bind(ts_min(from_i)).bind(ts_min(to_i))
            .bind(serde_json::to_string(&payload).unwrap()).execute(&pool).await.unwrap();
    }

    let r = call(&st, "bt_get_run_result", json!({ "run_id": cid })).await;
    assert!(r.get("isError").is_none(), "chunked run 不应 isError: {r}");
    assert_eq!(r["result_format"], "chunked_v1", "判别列透出");
    assert_eq!(r["per_bar"].as_array().unwrap().len(), 5000, "首页 per_bar 一整块（非空占位）");
    assert_eq!(r["per_bar"][0]["ts"], ts_min(0).timestamp());
    assert_eq!(r["has_more"], true, "显式 has_more（不静默截断/不静默读空）");
    assert_eq!(r["next_offset"], 5000);
    assert_eq!(r["summary"]["bars_total"], n);
    assert_eq!(r["summary"]["chunk_count"], 2);
    assert_eq!(r["summary"]["result_format"], "chunked_v1");
    assert_eq!(r["metrics"]["total_return_pct"], 4.0, "metrics 透出");

    // limit 参数（P4 加法：MCP 侧 limit 分页）
    let r2 = call(&st, "bt_get_run_result", json!({ "run_id": cid, "limit": 2 })).await;
    assert_eq!(r2["per_bar"].as_array().unwrap().len(), 2);
    assert_eq!(r2["has_more"], true);
    assert_eq!(r2["next_offset"], 2);

    // 工具描述/schema 记录（§4 只要求「默认行为一致 + 说明」；此处记录实际 schema 面）
    let list = mcp::tools::tool_list();
    let tool = list["tools"].as_array().unwrap().iter()
        .find(|t| t["name"] == "bt_get_run_result").expect("工具应在列表");
    println!("[probe] bt_get_run_result description = {}", tool["description"]);
    println!("[probe] bt_get_run_result inputSchema  = {}", tool["inputSchema"]);

    // ── (b) legacy_single：全量（旧 run 不破）+ has_more=false ──
    let lid = rid("legacy");
    clean(&pool, &lid).await;
    craft_run(&pool, &lid, "succeeded").await;
    let l: Vec<Value> = (0..3).map(per_bar_obj).collect();
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, trades, net_value, drawdown, metrics) \
         VALUES ($1, $2::jsonb, '[]'::jsonb, $3::jsonb, $4::jsonb, '{\"total_return_pct\":9.0}'::jsonb)")
        .bind(&lid).bind(serde_json::to_string(&l).unwrap())
        .bind(serde_json::to_string(&json!([[ts_min(0).timestamp(), 100000.0], [ts_min(1).timestamp(), 100005.0], [ts_min(2).timestamp(), 100010.0]])).unwrap())
        .bind(serde_json::to_string(&json!([[ts_min(0).timestamp(), 0.0], [ts_min(1).timestamp(), -0.01], [ts_min(2).timestamp(), -0.02]])).unwrap())
        .execute(&pool).await.unwrap();

    let rl = call(&st, "bt_get_run_result", json!({ "run_id": lid })).await;
    assert!(rl.get("isError").is_none());
    assert_eq!(rl["result_format"], "legacy_single", "旧行默认判别列");
    assert_eq!(rl["per_bar"].as_array().unwrap().len(), 3, "legacy ⇒ 全量");
    assert_eq!(rl["per_bar"], json!(l));
    assert_eq!(rl["net_value"].as_array().unwrap().len(), 3, "legacy ⇒ 全量净值");
    assert_eq!(rl["drawdown"].as_array().unwrap().len(), 3, "legacy ⇒ 全量回撤");
    assert_eq!(rl["has_more"], false);
    assert!(rl["next_offset"].is_null());

    // ── (c) 无结果行的 run ⇒ isError（不得静默读空/静默成功） ──
    let nid = rid("noresult");
    clean(&pool, &nid).await;
    craft_run(&pool, &nid, "running").await;
    let rn = call_raw(&st, "bt_get_run_result", json!({ "run_id": nid })).await;
    assert_eq!(rn["result"]["isError"], true, "无结果 ⇒ isError（非静默空成功）");
    println!("[probe] 无结果 run → {}", rn["result"]["content"][0]["text"]);
    // 未知 run_id 亦 isError
    let rn2 = call_raw(&st, "bt_get_run_result", json!({ "run_id": "sr_does_not_exist" })).await;
    assert_eq!(rn2["result"]["isError"], true);
    println!("[probe] 未知 run → {}", rn2["result"]["content"][0]["text"]);

    clean(&pool, &cid).await;
    clean(&pool, &lid).await;
    clean(&pool, &nid).await;
}
