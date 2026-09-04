// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/tests/mcp_tools_db.rs>>[init]
//! MCP 工具数据通路集成测试（需 TimescaleDB :5433）：
//! 真实 storage 端口实现注入 → rpc::dispatch tools/call → 解析 content 文本 JSON 断言。
//! 独立 code 段 9955xx + 独立 source 名，前后清理可重入（同 binary 测试并行，共享清理会互删——实锤踩坑）。

use mcp::rpc::{dispatch, RpcRequest};
use mcp::state::{McpState, SessionRegistry};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;

const CODE: &str = "995501";
const HSRC: &str = "mcp_test_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅 dev-dependencies（分层红线：cargo tree -p mcp -e normal 无 storage/sqlx）。
fn state(pool: PgPool) -> Arc<McpState> {
    Arc::new(McpState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        default_window_secs: 3600,
        sessions: SessionRegistry::default(),
    })
}

async fn call_tool(st: &McpState, name: &str, args: Value) -> Value {
    let req = RpcRequest { jsonrpc: Some("2.0".into()), id: Some(json!(1)),
        method: "tools/call".into(),
        params: Some(json!({ "name": name, "arguments": args })) };
    let resp = dispatch(st, &req).await.expect("tools/call 有响应");
    let text = resp["result"]["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).expect("content 文本为 JSON payload")
}

// 每测试独立 clean（同 binary 测试并行执行，共享清理会互删——实锤踩坑，见 storage kline_reader.rs 注记）
async fn clean_kline(pool: &PgPool) {
    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(CODE).execute(pool).await.unwrap();
    }
}

async fn clean_health(pool: &PgPool) {
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(HSRC).execute(pool).await.unwrap();
}

#[tokio::test]
async fn get_kline_merged_accurate_first_via_tool() {
    let pool = pool().await;
    clean_kline(&pool).await;
    let base = chrono::DateTime::parse_from_rfc3339("2026-09-03T01:30:00Z").unwrap().to_utc();
    // 3 根 raw（收盘 1..3）+ base+1min 准确层覆盖（收盘 9.99）
    for i in 0..3i64 {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(CODE).bind(base + chrono::Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 'M1', 9.99, 9.99, 9.99, 9.99, 777, 777.0, 'tushare') \
                 ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close")
        .bind(CODE).bind(base + chrono::Duration::minutes(1))
        .execute(&pool).await.unwrap();

    let st = state(pool.clone());
    let payload = call_tool(&st, "get_kline",
        json!({ "code": CODE, "period": "1m", "limit": 10 })).await;
    assert_eq!(payload["code"], CODE);
    let bars = payload["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 3);
    assert!(bars.windows(2).all(|w| w[0]["ts"].as_str() < w[1]["ts"].as_str()), "升序");
    assert_eq!(bars[1]["close"], 9.99, "merge 视图准确层优先（ADR-003）");
    assert_eq!(bars[1]["source"], "tushare");
    assert_eq!(bars[2]["close"], 3.0);
    clean_kline(&pool).await;
}

#[tokio::test]
async fn get_sources_health_aggregation_via_tool() {
    let pool = pool().await;
    clean_health(&pool).await;
    // 3 成功 + 1 失败 → 成功率 0.75、degraded、最近错误 timeout（diagnose 口径）
    for i in 0..3 {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms) \
                     VALUES (now() - make_interval(secs => $1), $2, true, 120)")
            .bind(10 + i).bind(HSRC).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind) \
                 VALUES (now(), $1, false, 'timeout')")
        .bind(HSRC).execute(&pool).await.unwrap();

    let st = state(pool.clone());
    let payload = call_tool(&st, "get_sources_health", json!({ "window_secs": 3600 })).await;
    assert_eq!(payload["window_secs"], 3600);
    let h = payload["sources"].as_array().unwrap().iter()
        .find(|x| x["source"] == HSRC).expect("含测试源");
    assert_eq!(h["attempts"], 4);
    assert!((h["success_rate"].as_f64().unwrap() - 0.75).abs() < 1e-9);
    assert_eq!(h["status"], "degraded");
    assert_eq!(h["last_error"]["err_kind"], "timeout");
    clean_health(&pool).await;
}
// ~/~ end
