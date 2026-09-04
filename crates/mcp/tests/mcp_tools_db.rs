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
        // Wave 2 Phase A：MCP④ 质量服务（真实 storage 端口实现）
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

#[tokio::test]
async fn get_data_quality_via_tool() {
    // MCP④ 端到端：真实库 → QualityService → tools/call payload
    const QCODE: &str = "995521";
    let pool = pool().await;
    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(QCODE).execute(&pool).await.unwrap();
    }
    // 造数：2026-09-02（周三交易日，测试运行时为历史日）raw 全 241 标签除 10:41；
    // accurate 仅 09:30（close 9.90 vs raw 10.00 → −1.0% 分歧）
    let day = chrono::NaiveDate::from_ymd_opt(2026, 9, 2).unwrap();
    for l in domain::calendar::trading_minute_labels(day) {
        let ts = domain::tz::cst_to_utc(l);
        let is_930 = l.time() == domain::calendar::hm(9, 30);
        if l.time() != domain::calendar::hm(10, 41) {
            sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                         VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'mcpq_src') ON CONFLICT DO NOTHING")
                .bind(QCODE).bind(ts).bind(if is_930 { 10.0 } else { 1.0 })
                .execute(&pool).await.unwrap();
        }
        if is_930 {
            sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount) \
                         VALUES ($1, $2, 'M1', 9.9, 9.9, 9.9, 9.9, 100, 100.0) ON CONFLICT DO NOTHING")
                .bind(QCODE).bind(ts).execute(&pool).await.unwrap();
        }
    }
    let st = state(pool.clone());
    let payload = call_tool(&st, "get_data_quality",
        json!({ "code": QCODE, "date": "2026-09-02" })).await;
    assert_eq!(payload["code"], QCODE);
    assert_eq!(payload["trading_day"], true);
    assert_eq!(payload["gap"]["missing_bars"], 1);
    assert_eq!(payload["gap"]["expected_bars"], 241, "交易日历 241 标签口径（13:00 伪缺口结案）");
    assert_eq!(payload["gap"]["segments"][0]["class"], "system_gap",
        "邻近无事件 → 系统缺口（D5）");
    assert_eq!(payload["divergence"]["compared_bars"], 1);
    assert_eq!(payload["divergence"]["divergent_bars"], 1, "−1.0% 超 0.5% 阈值");
    // 节假日：国庆 2026-10-01（0008 已落库）
    let payload = call_tool(&st, "get_data_quality",
        json!({ "code": QCODE, "date": "2026-10-01" })).await;
    assert_eq!(payload["trading_day"], false, "国庆非交易日");
    assert!(payload["gap"].is_null());
    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(QCODE).execute(&pool).await.unwrap();
    }
}
// ~/~ end
