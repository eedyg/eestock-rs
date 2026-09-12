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

/// 注册表垫片：bars/latest_bar 委派真实 KlineReader（数据通路集成保真），仅 `symbols_with_latest`
/// 换为进程内集合——测试**不写 symbols 控制表**（ADR-017：写 symbols = 控制数据面采集）。
struct ShimKline {
    inner: storage::reader::KlineReader,
    registered: Vec<String>,
}

#[async_trait::async_trait]
impl domain::ports::KlineRead for ShimKline {
    async fn bars(&self, period: domain::types::Period, code: &str,
                  before: Option<chrono::DateTime<chrono::Utc>>, limit: i64)
        -> anyhow::Result<Vec<domain::ports::KlineBarView>> {
        self.inner.bars(period, code, before, limit).await
    }
    async fn latest_bar(&self, period: domain::types::Period, code: &str)
        -> anyhow::Result<Option<domain::ports::KlineBarView>> {
        self.inner.latest_bar(period, code).await
    }
    async fn symbols_with_latest(&self) -> anyhow::Result<Vec<domain::ports::SymbolLatestView>> {
        Ok(self.registered.iter().map(|c| domain::ports::SymbolLatestView {
            code: c.clone(), name: None, interval_secs: 60, settlement: "T1".into(),
            enabled: true, last_ts: None, last_close: None, prev_close: None,
        }).collect())
    }
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅 dev-dependencies（分层红线：cargo tree -p mcp -e normal 无 storage/sqlx）。
/// `kline` 由调用方给定（缺省 = 真实 KlineReader；注册表口径可经 ShimKline 注入而不写库）。
fn state_with_kline(pool: PgPool, kline: Arc<dyn domain::ports::KlineRead>) -> Arc<McpState> {
    state_full(pool, kline, None)
}

/// 完整装配（P3c 工具族 I-7/I-9 用例需真实 `StrategyService`；与 app bin 同结构）。
fn state_full(pool: PgPool, kline: Arc<dyn domain::ports::KlineRead>,
              strategies: Option<Arc<application::strategy::StrategyService>>) -> Arc<McpState> {
    Arc::new(McpState {
        kline,
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
        sim: None,
        strategies,
        workbench: None,
        strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    })
}

/// 真实 Registry 服务（storage 具体实现；与 app bin 装配同形；catalog 只读）。
fn real_strategies(pool: PgPool) -> Arc<application::strategy::StrategyService> {
    Arc::new(application::strategy::StrategyService::new(
        Arc::new(storage::strategy::PgStrategyStore::new(pool.clone())),
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    ))
}

/// 缺省装配：注册表 = 真实 symbols 表（只读查询）。
fn state(pool: PgPool) -> Arc<McpState> {
    let kline = Arc::new(storage::reader::KlineReader::new(pool.clone()));
    state_with_kline(pool, kline)
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

    let st = state_with_kline(pool.clone(), Arc::new(ShimKline {
        inner: storage::reader::KlineReader::new(pool.clone()),
        registered: vec![CODE.into()], // 995501 = 测试专用 code（进程内注册，不写平台 symbols 表）
    }));
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

/// I-1（P0）端到端：以**真实 symbols 注册表**判定——未注册代码必须 isError（拒绝执行），
/// 不得静默返回空数组（本测试**只读**：不写任何表；510300/999999/ABC123 均不在 44 注册标的内）。
#[tokio::test]
async fn get_kline_unregistered_code_is_tool_error_against_real_registry() {
    let pool = pool().await;
    let st = state(pool);
    let req = |code: &str| RpcRequest { jsonrpc: Some("2.0".into()), id: Some(json!(1)),
        method: "tools/call".into(),
        params: Some(json!({ "name": "get_kline", "arguments": { "code": code } })) };
    for code in ["510300", "999999", "ABC123"] {
        let resp = dispatch(&st, &req(code)).await.expect("tools/call 有响应");
        assert_eq!(resp["result"]["isError"], true, "{code} 未注册 → isError=true（非静默空）");
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(code) && text.contains("未注册"), "错误须含被拒 code 与原因：{text}");
    }
    // 正向对照：已注册 518880 → 非错误（bars 可空，但语义是「该区间无数据」——与未注册可区分）
    let resp = dispatch(&st, &req("518880")).await.expect("tools/call 有响应");
    assert!(resp["result"]["isError"].is_null(), "已注册 518880 → 非错误");
}

/// I-4（D1）端到端：list_symbols 与 web `GET /api/symbols` **同源**（同一
/// `KlineRead::symbols_with_latest` 端口）——逐行 code 集合一致、字段齐全；本测试**只读**。
#[tokio::test]
async fn list_symbols_matches_real_symbols_registry() {
    let pool = pool().await;
    let st = state(pool.clone());
    let payload = call_tool(&st, "list_symbols", json!({})).await;
    let syms = payload["symbols"].as_array().expect("symbols 数组");
    assert!(!syms.is_empty(), "真实注册表非空");
    // 同源：与端口返回的注册表行逐行一致（code 升序）
    let rows = st.kline.symbols_with_latest().await.expect("注册表只读查询");
    let mut want: Vec<String> = rows.iter().map(|r| r.code.clone()).collect();
    want.sort();
    let got: Vec<String> = syms.iter().map(|s| s["code"].as_str().unwrap().to_string()).collect();
    assert_eq!(got, want, "list_symbols 由 symbols_with_latest 同源产出（与 REST 同源口径）");
    // 字段齐备：注册状态 / 采集间隔 / 交割类型 / 可用区间终点
    let hit = syms.iter().find(|s| s["code"] == "518880").expect("518880 已注册");
    assert!(hit["enabled"].is_boolean(), "注册状态");
    assert!(hit["interval_secs"].is_number(), "采集间隔");
    assert!(hit["settlement"].is_string(), "交割类型");
    let row = rows.iter().find(|r| r.code == "518880").unwrap();
    let last_ts = row.last_ts.expect("518880 有数据（可用区间终点非空）");
    let echoed: chrono::DateTime<chrono::Utc> = chrono::DateTime::parse_from_rfc3339(
        hit["latest"]["ts"].as_str().expect("latest.ts 字符串")).unwrap().to_utc();
    assert_eq!(echoed, last_ts, "可用区间终点 = 注册表最新 bar ts");
}

/// I-5/I-10（D2）端到端：from/to 区间（真实 `KlineRead::bars` 的 before 截断语义）+ limit 上限。
/// 独立 code 995502（同 binary 测试并行，共享清理会互删）。
#[tokio::test]
async fn get_kline_from_to_and_limit_cap_against_real_data() {
    const RCODE: &str = "995502";
    let pool = pool().await;
    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(RCODE).execute(&pool).await.unwrap();
    }
    let base = chrono::DateTime::parse_from_rfc3339("2026-09-03T01:30:00Z").unwrap().to_utc();
    for i in 0..5i64 {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(RCODE).bind(base + chrono::Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    let st = state_with_kline(pool.clone(), Arc::new(ShimKline {
        inner: storage::reader::KlineReader::new(pool.clone()),
        registered: vec![RCODE.into()],
    }));
    let req = |args: Value| RpcRequest { jsonrpc: Some("2.0".into()), id: Some(json!(1)),
        method: "tools/call".into(),
        params: Some(json!({ "name": "get_kline", "arguments": args })) };
    let ts = |m: i64| (base + chrono::Duration::minutes(m))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    // from 闭 to 开 → 仅区间内 3 根（min2/min3/min4），升序
    let payload = call_tool(&st, "get_kline", json!({
        "code": RCODE, "period": "1m", "from": ts(2), "to": ts(5), "limit": 10,
    })).await;
    let bars = payload["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 3, "真实 before 截断 + from 闭过滤（min2/min3/min4）");
    assert_eq!(bars[0]["close"], json!(3.0), "区间起点即 from（闭）");
    assert_eq!(bars[2]["close"], json!(5.0), "末根 < to（开）");
    assert_eq!(payload["from"], json!(ts(2)), "边界回声");
    // 超限 → -32602（协议层参数错误，与「静默封顶」语义区分）
    let resp = dispatch(&st, &req(json!({ "code": RCODE, "limit": 10001 }))).await.unwrap();
    assert_eq!(resp["error"]["code"], -32602, "limit 超上限 10000 → 协议层错误");
    assert!(resp["error"]["message"].as_str().unwrap().contains("分段"), "提示分段取数");
    // 区间根数 > limit → 工具错误（多取一根判定：真实 reader 只回 limit+1 根也成立）
    let resp = dispatch(&st, &req(json!({ "code": RCODE, "from": ts(0), "limit": 2 }))).await.unwrap();
    assert_eq!(resp["result"]["isError"], true, "区间 5 根 > limit 2 → 显式错误（不静默截断）");
    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(RCODE).execute(&pool).await.unwrap();
    }
}

/// I-7（D5）端到端：真实 Registry（catalog 实际体量）对比「默认摘要 vs include_source」负载体积。
/// 改前实测基准：39097 字符（11 条含全量 JS）。本测试**只读** catalog（不写策略表）。
#[tokio::test]
async fn strategy_list_slim_reduces_payload_against_real_registry() {
    let pool = pool().await;
    let st = state_full(pool.clone(), Arc::new(storage::reader::KlineReader::new(pool.clone())),
        Some(real_strategies(pool.clone())));
    let slim = call_tool(&st, "strategy_list", json!({})).await;
    let full = call_tool(&st, "strategy_list", json!({ "include_source": true })).await;
    let entries = slim.as_array().expect("catalog 数组");
    assert!(!entries.is_empty(), "真实 Registry 有 published 策略");
    assert!(entries.iter().all(|e| e["version"].get("code").is_none()),
        "默认摘要不含源码（I-7）");
    assert!(entries.iter().all(|e| e["version"]["id"].as_str().unwrap().starts_with("sv_")),
        "摘要保留版本 id（选版依据）");
    assert!(full.as_array().unwrap().iter()
        .all(|e| e["version"]["code"].as_str().is_some_and(|c| !c.is_empty())),
        "include_source=true 含源码");
    let (slim_len, full_len) = (slim.to_string().len(), full.to_string().len());
    println!("I-7 体积对比（真实 Registry）：slim={slim_len} 字符 / full={full_len} 字符（改前 39097 基准）");
    assert!(slim_len * 2 < full_len, "默认摘要体积显著下降：slim={slim_len} full={full_len}");
}

/// I-9（D9）端到端：真实 symbols 注册表 → strategy_test_run 未注册 symbol 明确 isError
/// （口径与 get_kline I-1 一致：510300 不在 44 注册标的内；本测试**只读**）。
#[tokio::test]
async fn strategy_test_run_unregistered_symbol_against_real_registry() {
    let pool = pool().await;
    let st = state_full(pool.clone(), Arc::new(storage::reader::KlineReader::new(pool.clone())),
        Some(real_strategies(pool.clone())));
    let resp = dispatch(&st, &RpcRequest { jsonrpc: Some("2.0".into()), id: Some(json!(1)),
        method: "tools/call".into(),
        params: Some(json!({ "name": "strategy_test_run", "arguments": {
            "code": "function on_bar(ctx) { return 50; }", "symbol": "510300", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "mode": "pure_score" }})) }).await.expect("tools/call 有响应");
    assert_eq!(resp["result"]["isError"], true, "未注册 510300 → isError（非静默无数据）");
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("510300") && text.contains("未注册"), "{text}");
}
// ~/~ end
