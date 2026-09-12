//! [TESTER 临时独立验收夹具 — 跑完即删，不提交，不属于实现]
//! 010 批（MCP 接口批 + 引擎口径批）独立验收：
//!   D1 list_symbols / D2 get_kline from-to-limit / D5 strategy_list include_source /
//!   D9 strategy_test_run 注册校验 / I-6 H1 / I-2 warmup / I-3 fee·policy·capital。
//! 真实 DB 注册表 + 真实 storage 端口 + 真实 axum SSE 链路（与 app bin 同构装配，只读为主）。
//! 用法：
//!   EV_DIR=/abs/evidence cargo test -p mcp --test zz_tester_010_acceptance -- --nocapture --test-threads=1

use chrono::Utc;
use mcp::state::{McpState, SessionRegistry};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;

const CODE: &str = "518880"; // 已注册标的
const UNREG: &str = "510300"; // 不在 44 条注册表内（I-1/D9 判据）

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn ev_dir() -> String {
    std::env::var("EV_DIR").unwrap_or_else(|_| "/tmp".into())
}

fn dump_file(name: &str, content: &str) {
    let p = format!("{}/{}", ev_dir(), name);
    std::fs::write(&p, content).unwrap_or_else(|e| panic!("写 {p} 失败: {e}"));
    println!("EV file {p} ({} bytes)", content.len());
}

struct NoopProgress;
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for NoopProgress {
    async fn send(&self, _r: &str, _p: f64, _b: Option<chrono::DateTime<chrono::Utc>>)
        -> anyhow::Result<()> { Ok(()) }
}

/// 与 app bin 同构的全量装配（不做 seed/recover —— 不写运行控制数据）。
async fn full_state(pool: PgPool, kline: Arc<dyn domain::ports::KlineRead>) -> Arc<McpState> {
    let strategy_store = Arc::new(storage::strategy::PgStrategyStore::new(pool.clone()));
    let strategy_service = Arc::new(application::strategy::StrategyService::new(
        strategy_store.clone(),
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    ));
    let workbench_service = Arc::new(application::workbench::WorkbenchService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
        strategy_store.clone(),
        Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
        Arc::new(NoopProgress),
        Arc::new(domain::ports::SystemClock),
        application::workbench::DEFAULT_MAX_CONCURRENT,
    ));
    let sim_service = Arc::new(application::simlive::SimLiveService::with_default_fee(
        Arc::new(storage::sim::PgSimSessionStore::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    )
    .with_strategies(strategy_store.clone())
    .with_workbench(workbench_service.clone())
    .with_kline(Arc::new(storage::reader::KlineReader::new(pool.clone()))));

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
        sim: Some(sim_service),
        strategies: Some(strategy_service),
        workbench: Some(workbench_service),
        strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    })
}

/// 垫片：注册表查询失败（fail-closed），bars 委派真实 KlineReader。
struct FailingRegistryRealBars(storage::reader::KlineReader);
#[async_trait::async_trait]
impl domain::ports::KlineRead for FailingRegistryRealBars {
    async fn bars(&self, p: domain::types::Period, c: &str,
                  b: Option<chrono::DateTime<chrono::Utc>>, l: i64)
        -> anyhow::Result<Vec<domain::ports::KlineBarView>> { self.0.bars(p, c, b, l).await }
    async fn symbols_with_latest(&self)
        -> anyhow::Result<Vec<domain::ports::SymbolLatestView>> {
        anyhow::bail!("injected registry outage (tester 010)")
    }
}

// ── JSON-RPC 直呼（dispatch）+ 真实 SSE 链路（server::build_router） ──

async fn call(st: &Arc<McpState>, name: &str, args: Value) -> Value {
    mcp::rpc::dispatch(st, &mcp::rpc::RpcRequest {
        jsonrpc: Some("2.0".into()),
        id: Some(json!(7)),
        method: "tools/call".into(),
        params: Some(json!({ "name": name, "arguments": args })),
    }).await.expect("tools/call 有响应")
}

fn payload(resp: &Value) -> Value {
    let t = resp["result"]["content"][0]["text"].as_str()
        .unwrap_or_else(|| panic!("无 content 文本：{resp}"));
    serde_json::from_str(t).unwrap_or_else(|e| panic!("payload 非 JSON ({e})：{t}"))
}

fn is_err(resp: &Value) -> bool { resp["result"]["isError"] == json!(true) }
fn err_text(resp: &Value) -> String {
    resp["result"]["content"][0]["text"].as_str().unwrap_or("").to_string()
}
fn proto_err_code(resp: &Value) -> Option<i64> { resp["error"]["code"].as_i64() }
fn proto_err_msg(resp: &Value) -> String {
    resp["error"]["message"].as_str().unwrap_or("").to_string()
}

/// 结果打印：EV <tag> <JSON>
fn ev(tag: impl AsRef<str>, v: impl serde::Serialize) {
    println!("EV {} {}", tag.as_ref(), serde_json::to_string(&v).unwrap());
}

// ── SSE 客户端（reqwest 真链路；仅用于契约/传输层证明） ──
struct SseClient {
    base: String,
    endpoint: String,
    rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    _reader: tokio::task::JoinHandle<()>,
}

async fn sse_state(st: Arc<McpState>) -> SseClient {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, mcp::server::build_router(st)).await.unwrap();
    });
    let base = format!("http://{addr}");
    let mut resp = reqwest::get(format!("{base}/sse")).await.unwrap();
    assert_eq!(resp.status(), 200);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let reader = tokio::spawn(async move {
        let mut buf = String::new();
        while let Ok(Some(chunk)) = resp.chunk().await {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                if let Some(d) = frame.lines().find_map(|l| l.strip_prefix("data: ")) {
                    if tx.send(d.to_string()).is_err() { return; }
                }
            }
        }
    });
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await.expect("endpoint 帧超时").expect("SSE 流存活");
    assert!(first.starts_with("/messages?sessionId="), "endpoint 帧: {first}");
    SseClient { base, endpoint: first, rx, _reader: reader }
}

async fn sse_req(client: &mut SseClient, body: Value) -> Value {
    let http = reqwest::Client::new();
    let r = http.post(format!("{}{}", client.base, client.endpoint)).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 202, "POST /messages 202");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(30), client.rx.recv())
        .await.expect("SSE 帧超时").expect("SSE 流存活");
    serde_json::from_str(&frame).unwrap()
}

// ── 探针策略（warmup 取证：恒为 buy 的评分） ──
const PROBE_BUY: &str = "function on_bar(ctx) { return 100; }";
const PROBE_FLAT: &str = "function on_bar(ctx) { return 50; }";

fn ts(s: &str) -> chrono::DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

/// ts 字符串归一比对（"Z" 与 "+00:00" 等价）
fn same_ts(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| {
        chrono::DateTime::parse_from_rfc3339(x).unwrap().to_utc()
            == chrono::DateTime::parse_from_rfc3339(y).unwrap().to_utc()
    })
}

#[tokio::test]
async fn zz_tester_010_full_acceptance() {
    let pool = pool().await;
    let st = full_state(pool.clone(),
        Arc::new(storage::reader::KlineReader::new(pool.clone()))).await;

    // ═══════════════════ D1 list_symbols ═══════════════════
    // D1-a schema（tools/list）：无 required 参数
    let tl = mcp::rpc::dispatch(&st, &mcp::rpc::RpcRequest {
        jsonrpc: Some("2.0".into()), id: Some(json!(1)),
        method: "tools/list".into(), params: None }).await.unwrap();
    let tools = tl["result"]["tools"].as_array().unwrap();
    let ls = tools.iter().find(|t| t["name"] == "list_symbols").expect("list_symbols 在 tools/list");
    ev("D1.schema", json!({
        "name": ls["name"], "properties": ls["inputSchema"]["properties"],
        "required_present": ls["inputSchema"].get("required").is_some(),
        "required": ls["inputSchema"]["required"],
        "additionalProperties": ls["inputSchema"].get("additionalProperties"),
    }));

    // D1-b 返回 vs raw SQL（同源 + 升序）
    let sql_rows: Vec<(String, Option<String>, i32, String, bool)> = sqlx::query_as(
        "select code, name, interval_secs, settlement, enabled from symbols order by code")
        .fetch_all(&pool).await.unwrap();
    let sql_codes: Vec<String> = sql_rows.iter().map(|r| r.0.clone()).collect();
    ev("D1.sql_order_head", &sql_codes[..3]);
    ev("D1.sql_order_tail", &sql_codes[sql_codes.len() - 3..]);

    let r = call(&st, "list_symbols", json!({})).await;
    assert!(!is_err(&r), "list_symbols 正常路径不应 isError：{}", err_text(&r));
    let p = payload(&r);
    dump_file("list_symbols_payload.json", &serde_json::to_string(&p).unwrap());
    let syms = p["symbols"].as_array().unwrap().clone();
    let tool_codes: Vec<String> = syms.iter().map(|s| s["code"].as_str().unwrap().to_string()).collect();
    ev("D1.tool_n", syms.len());
    ev("D1.tool_order_head", &tool_codes[..3]);
    ev("D1.tool_order_tail", &tool_codes[tool_codes.len() - 3..]);
    ev("D1.same_order_as_sql", tool_codes == sql_codes);
    ev("D1.ascending", tool_codes.windows(2).all(|w| w[0] < w[1]));
    ev("D1.count_eq_sql", syms.len() == sql_rows.len());
    // 字段逐行同源比对（code/name/interval_secs/settlement/enabled）
    let mut mismatches: Vec<String> = vec![];
    for (i, row) in sql_rows.iter().enumerate() {
        let s = &syms[i];
        let ok = s["code"].as_str().unwrap() == row.0
            && s["name"].as_str() == row.1.as_deref()
            && s["interval_secs"].as_i64() == Some(row.2 as i64)
            && s["settlement"].as_str() == Some(row.3.as_str())
            && s["enabled"].as_bool() == Some(row.4);
        if !ok { mismatches.push(format!("{i}:{}", row.0)); }
    }
    ev("D1.field_mismatches", &mismatches);
    ev("D1.sample_first", &syms[0]);
    ev("D1.sample_with_null_latest",
        syms.iter().find(|s| s["latest"].is_null()).cloned().unwrap_or(Value::Null));
    ev("D1.latest_keys",
        syms.iter().find(|s| !s["latest"].is_null())
            .map(|s| s["latest"].clone()).unwrap_or(Value::Null));
    ev("D1.unknown_args_ignored",
        { let rr = call(&st, "list_symbols", json!({"bogus": 1})).await;
          json!({"isError": is_err(&rr), "n": payload(&rr)["symbols"].as_array().map(|a| a.len())}) });

    // D1-c 注册表不可用 → fail-closed isError
    let st_fail = full_state(pool.clone(),
        Arc::new(FailingRegistryRealBars(storage::reader::KlineReader::new(pool.clone())))).await;
    let rf = call(&st_fail, "list_symbols", json!({})).await;
    ev("D1.registry_down", json!({"isError": is_err(&rf), "text": err_text(&rf)}));
    assert!(is_err(&rf), "注册表不可用必须 isError");

    // ═══════════════════ D2 get_kline ═══════════════════
    // D2-a 兼容形状：不传 from/to
    let r = call(&st, "get_kline", json!({"code": CODE})).await;
    let p = payload(&r);
    let keys: Vec<String> = p.as_object().unwrap().keys().cloned().collect();
    ev("D2.legacy_shape", json!({
        "keys": keys, "n_bars": p["bars"].as_array().map(|a| a.len()),
        "default_limit_expected": 240,
        "bar_keys": p["bars"].as_array().unwrap()[0].as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
    }));
    dump_file("get_kline_legacy_payload_shape.json",
        &serde_json::to_string(&json!({"keys": p.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
                                       "n_bars": p["bars"].as_array().unwrap().len()})).unwrap());

    // D2-b limit 上限：恰好 10000 通过 / 10001 → -32602（含 10000 与 分段）
    let r = call(&st, "get_kline", json!({"code": CODE, "limit": 10001})).await;
    ev("D2.limit_10001", json!({"code": proto_err_code(&r), "message": proto_err_msg(&r),
        "has_10000": proto_err_msg(&r).contains("10000"),
        "has_segment": proto_err_msg(&r).contains("分段")}));
    assert_eq!(proto_err_code(&r), Some(-32602), "10001 必须 -32602（不得静默钳制）");

    // 用同一读端口取样本构造「恰好 10000 根」的区间（避免依赖表结构假设）
    let t_ref = ts("2020-06-01T00:00:00Z");
    let probe: Vec<domain::ports::KlineBarView> =
        st.kline.bars(domain::types::Period::M1, CODE, Some(t_ref), 20000).await.unwrap();
    assert!(probe.len() >= 14000, "样本不足：{}", probe.len());
    let from_ts = probe[3000].ts;
    let to_ts = probe[13000].ts;          // 区间 [from,to) 恰 10000 根
    let to2_ts = probe[13001].ts;         // 区间 [from,to2) 恰 10001 根
    ev("D2.exact_window", json!({"n_probe": probe.len(), "from": from_ts, "to": to_ts, "to2": to2_ts}));

    let r = call(&st, "get_kline", json!({"code": CODE, "period": "1m",
        "from": from_ts.to_rfc3339(), "to": to_ts.to_rfc3339(), "limit": 10000})).await;
    let p = payload(&r);
    ev("D2.exactly_10000", json!({"isError": is_err(&r), "n_bars": p["bars"].as_array().map(|a| a.len()),
        "from": p["from"], "to": p["to"], "text": if is_err(&r) { err_text(&r) } else { String::new() }}));
    assert!(!is_err(&r) && p["bars"].as_array().unwrap().len() == 10000,
        "恰好 10000 根应正常返回 10000 根");

    let r = call(&st, "get_kline", json!({"code": CODE, "period": "1m",
        "from": from_ts.to_rfc3339(), "to": to2_ts.to_rfc3339(), "limit": 10000})).await;
    ev("D2.over_limit_interval", json!({"isError": is_err(&r), "text": err_text(&r)}));
    assert!(is_err(&r), "区间 10001 根 > limit 10000 必须显式错误（不得静默截断）");

    // D2-c date 形式（Asia/Shanghai 日界）to 含整日
    // c1：同日 from=to（date 形式）——记录实测行为（潜在边界缺陷）
    let r = call(&st, "get_kline", json!({"code": CODE, "period": "1h",
        "from": "2026-09-10", "to": "2026-09-10", "limit": 100})).await;
    ev("D2.date_same_from_to", json!({"protocol_error": proto_err_code(&r),
        "message": proto_err_msg(&r),
        "isError": r["result"].get("isError"),
        "text": if r.get("error").is_none() { err_text(&r) } else { String::new() }}));
    // c1b：RFC3339 from 晚于 CST 日界 + date 形式 to（混合形式）
    let r = call(&st, "get_kline", json!({"code": CODE, "period": "1h",
        "from": "2026-09-10T00:00:00Z", "to": "2026-09-10", "limit": 100})).await;
    ev("D2.date_mixed_forms", json!({"protocol_error": proto_err_code(&r),
        "message": proto_err_msg(&r)}));
    // c2：from=2026-09-10 / to=2026-09-11（to 含整日 → 含 CST 09-10、09-11 两天）
    let r = call(&st, "get_kline", json!({"code": CODE, "period": "1h",
        "from": "2026-09-10", "to": "2026-09-11", "limit": 100})).await;
    let p = payload(&r);
    let tool_ts: Vec<String> = p["bars"].as_array().unwrap().iter()
        .map(|b| b["ts"].as_str().unwrap().to_string()).collect();
    // 独立期望：同端口拉取 [CST 09-12 00:00 = 2026-09-11T16:00Z) 之前), 再按 CST 09-10 00:00 起过滤
    let expect: Vec<domain::ports::KlineBarView> = st.kline.bars(
        domain::types::Period::H1, CODE, Some(ts("2026-09-11T16:00:00Z")), 100).await.unwrap();
    let expect_ts: Vec<String> = expect.iter().filter(|b| b.ts >= ts("2026-09-09T16:00:00Z"))
        .map(|b| b.ts.to_rfc3339()).collect();
    let date_ok = same_ts(&tool_ts, &expect_ts);
    ev("D2.date_bounds", json!({"from_echo": p["from"], "to_echo": p["to"], "n": tool_ts.len(),
        "expect_from": "2026-09-09T16:00:00Z (CST 2026-09-10 00:00)",
        "expect_to": "2026-09-11T16:00:00Z (CST 2026-09-12 00:00；to 含整日 09-11)",
        "ts_equal_port_expectation": date_ok,
        "expect_ts": expect_ts,
        "ts_head": &tool_ts[..tool_ts.len().min(2)], "ts_tail": &tool_ts[tool_ts.len().saturating_sub(2)..]}));
    assert!(date_ok, "日界换算与端口期望不一致");
    // c3：与显式 RFC3339 等价形式逐位一致
    let r2 = call(&st, "get_kline", json!({"code": CODE, "period": "1h",
        "from": "2026-09-09T16:00:00Z", "to": "2026-09-11T16:00:00Z", "limit": 100})).await;
    let p2 = payload(&r2);
    let ts2: Vec<String> = p2["bars"].as_array().unwrap().iter()
        .map(|b| b["ts"].as_str().unwrap().to_string()).collect();
    ev("D2.date_vs_rfc3339_equivalent", json!({"equal": same_ts(&ts2, &tool_ts),
        "from": p2["from"], "to": p2["to"]}));
    // c4：单日（RFC3339 显式）——CST 09-10 整日
    let r3 = call(&st, "get_kline", json!({"code": CODE, "period": "1h",
        "from": "2026-09-09T16:00:00Z", "to": "2026-09-10T16:00:00Z", "limit": 100})).await;
    let p3 = payload(&r3);
    ev("D2.single_day_rfc3339", json!({"n": p3["bars"].as_array().map(|a| a.len()),
        "ts": p3["bars"].as_array().unwrap().iter().map(|b| b["ts"].clone()).collect::<Vec<_>>()}));

    // D2-d RFC3339 from/to（不做整日换算）
    let r = call(&st, "get_kline", json!({"code": CODE, "period": "1h",
        "from": "2026-09-10T01:00:00Z", "to": "2026-09-10T04:00:00Z", "limit": 100})).await;
    let p = payload(&r);
    ev("D2.rfc3339_bounds", json!({"from": p["from"], "to": p["to"],
        "n": p["bars"].as_array().map(|a| a.len()),
        "ts": p["bars"].as_array().unwrap().iter().map(|b| b["ts"].clone()).collect::<Vec<_>>()}));

    // D2-e 参数校验
    for (tag, args) in [
        ("from_gt_to", json!({"code": CODE, "from": "2026-09-10T00:00:00Z", "to": "2026-09-09T00:00:00Z"})),
        ("bad_from", json!({"code": CODE, "from": "2026/09/10"})),
        ("from_number", json!({"code": CODE, "from": 12345})),
        ("limit_string", json!({"code": CODE, "limit": "100"})),
    ] {
        let r = call(&st, "get_kline", args).await;
        ev(format!("D2.validation.{tag}"), json!({"code": proto_err_code(&r), "message": proto_err_msg(&r)}));
    }
    // 1h 数据层可用（I-6 伴随项）
    let r = call(&st, "get_kline", json!({"code": CODE, "period": "1h", "limit": 3})).await;
    let p = payload(&r);
    ev("D2.1h_available", json!({"n": p["bars"].as_array().map(|a| a.len()),
        "last": p["bars"].as_array().unwrap().last().cloned().unwrap_or(Value::Null)}));

    // ═══════════════════ D5 strategy_list ═══════════════════
    let slim_r = call(&st, "strategy_list", json!({})).await;
    let full_r = call(&st, "strategy_list", json!({"include_source": true})).await;
    let slim_txt = slim_r["result"]["content"][0]["text"].as_str().unwrap().to_string();
    let full_txt = full_r["result"]["content"][0]["text"].as_str().unwrap().to_string();
    dump_file("strategy_list_slim.json", &slim_txt);
    dump_file("strategy_list_full.json", &full_txt);
    let slim: Value = serde_json::from_str(&slim_txt).unwrap();
    let full: Value = serde_json::from_str(&full_txt).unwrap();
    let se = slim.as_array().unwrap();
    let fe = full.as_array().unwrap();
    ev("D5.sizes", json!({
        "slim_chars": slim_txt.chars().count(), "full_chars": full_txt.chars().count(),
        "slim_bytes": slim_txt.len(), "full_bytes": full_txt.len(),
        "baseline_before_change": 39097,
        "delta_vs_baseline": full_txt.chars().count() as i64 - 39097,
        "ratio_full_over_slim": full_txt.chars().count() as f64 / slim_txt.chars().count() as f64,
    }));
    ev("D5.slim_has_no_code", se.iter().all(|e| e["version"].get("code").is_none()));
    ev("D5.full_has_code", fe.iter().all(|e| e["version"]["code"].as_str().is_some_and(|c| !c.is_empty())));
    ev("D5.slim_keeps_identity", se.iter().all(|e| e["strategy"]["id"].as_str().is_some()
        && e["version"]["id"].as_str().is_some() && e["version"]["sha256"].as_str().is_some()
        && e["version"]["status"].as_str().is_some()));
    ev("D5.n_entries", json!({"slim": se.len(), "full": fe.len()}));
    ev("D5.slim_entry_sample", &se[0]);
    ev("D5.slim_keys", se[0].as_object().unwrap().keys().cloned().collect::<Vec<_>>());
    ev("D5.version_keys_slim", se[0]["version"].as_object().unwrap().keys().cloned().collect::<Vec<_>>());
    ev("D5.version_keys_full", fe[0]["version"].as_object().unwrap().keys().cloned().collect::<Vec<_>>());
    let r = call(&st, "strategy_list", json!({"include_source": "yes"})).await;
    ev("D5.invalid_type", json!({"code": proto_err_code(&r), "message": proto_err_msg(&r)}));

    // ═══════════════════ D9 strategy_test_run 注册校验 ═══════════════════
    let base_args = |sym: &str| json!({
        "code": PROBE_FLAT, "symbol": sym, "period": "D1",
        "from": "2026-08-01T00:00:00Z", "to": "2026-09-01T00:00:00Z", "mode": "pure_score" });
    let r = call(&st, "strategy_test_run", base_args(UNREG)).await;
    ev("D9.unregistered", json!({"isError": is_err(&r), "text": err_text(&r),
        "mentions_code": err_text(&r).contains(UNREG), "mentions_未注册": err_text(&r).contains("未注册")}));
    assert!(is_err(&r) && err_text(&r).contains(UNREG) && err_text(&r).contains("未注册"));
    let r = call(&st, "strategy_test_run", base_args(CODE)).await;
    ev("D9.registered_ok", json!({"isError": is_err(&r),
        "ok": !is_err(&r), "text": if is_err(&r) { err_text(&r) } else { "ok".into() }}));
    assert!(!is_err(&r), "已注册标的应正常试算");
    let rf = call(&st_fail, "strategy_test_run", base_args(CODE)).await;
    ev("D9.registry_down", json!({"isError": is_err(&rf), "text": err_text(&rf)}));

    // ═══════════════════ I-6 / H1 ═══════════════════
    let h1_args = |from: &str, to: &str, extra: Value| {
        let mut a = json!({"code": PROBE_BUY, "symbol": CODE, "period": "H1",
            "from": from, "to": to, "mode": "sim_position"});
        if let (Some(o), Some(e)) = (a.as_object_mut(), extra.as_object()) {
            for (k, v) in e { o.insert(k.clone(), v.clone()); }
        }
        a
    };
    let r = call(&st, "strategy_test_run", h1_args("2024-01-02T00:00:00Z", "2024-06-30T00:00:00Z", json!({}))).await;
    ev("I6.h1_test_run", json!({"isError": is_err(&r), "period": payload(&r)["period"],
        "bar_count": payload(&r)["bar_count"],
        "warmup_requested": payload(&r)["warmup_requested"],
        "warmup_effective": payload(&r)["warmup_effective"],
        "text": if is_err(&r) { err_text(&r) } else { String::new() }}));
    assert!(!is_err(&r), "H1 试算必须可用");
    // H1 区间档 = 日线档（≤5y）：1826 天过 / 2192 天（6y）拒
    let r5 = call(&st, "strategy_test_run",
        h1_args("2019-01-01T00:00:00Z", "2024-01-01T00:00:00Z", json!({"mode": "pure_score"}))).await;
    ev("I6.h1_span_5y", json!({"isError": is_err(&r5), "text": if is_err(&r5) { err_text(&r5) } else { "accepted".into() }}));
    let r6 = call(&st, "strategy_test_run",
        h1_args("2019-01-01T00:00:00Z", "2025-01-01T00:00:00Z", json!({"mode": "pure_score"}))).await;
    ev("I6.h1_span_6y", json!({"isError": is_err(&r6), "text": err_text(&r6)}));
    // 同日线档对照：H1 与 D1 同上限（H1 6y 拒、D1 6y 拒；H1 5y 过、D1 5y 过）
    let r6d = call(&st, "strategy_test_run", json!({"code": PROBE_FLAT, "symbol": CODE,
        "period": "D1", "from": "2019-01-01T00:00:00Z", "to": "2025-01-01T00:00:00Z",
        "mode": "pure_score"})).await;
    ev("I6.d1_span_6y", json!({"isError": is_err(&r6d), "text": if is_err(&r6d) { err_text(&r6d) } else { "accepted".into() }}));
    // 非法周期（W1）仍拒
    let rw = call(&st, "strategy_test_run", json!({"code": PROBE_FLAT, "symbol": CODE,
        "period": "W1", "from": "2026-08-01T00:00:00Z", "to": "2026-09-01T00:00:00Z",
        "mode": "pure_score"})).await;
    ev("I6.w1_rejected", json!({"code": proto_err_code(&rw), "message": proto_err_msg(&rw)}));

    // ═══════════════════ I-2 warmup（MCP 通道探针策略取证） ═══════════════════
    let wr = |wm: Value| {
        let mut a = h1_args("2024-01-02T00:00:00Z", "2024-04-01T00:00:00Z", json!({}));
        if let Some(o) = a.as_object_mut() {
            if !wm.is_null() { o.insert("warmup_bars".into(), wm); }
        }
        a
    };
    // 默认 250
    let r_def = call(&st, "strategy_test_run", wr(Value::Null)).await;
    let p_def = payload(&r_def);
    ev("I2.default_warmup", json!({"requested": p_def["warmup_requested"],
        "effective": p_def["warmup_effective"], "bar_count": p_def["bar_count"]}));
    // 显式 0
    let r0 = call(&st, "strategy_test_run", wr(json!(0))).await;
    let p0 = payload(&r0);
    ev("I2.warmup0", json!({"requested": p0["warmup_requested"], "effective": p0["warmup_effective"],
        "bar_count": p0["bar_count"],
        "n_scores_warmup_true": p0["scores"].as_array().unwrap().iter().filter(|s| s["warmup"]==json!(true)).count(),
        "n_signals_warmup_true": p0["signals"].as_array().unwrap().iter().filter(|s| s["warmup"]==json!(true)).count(),
        "n_trades": p0["trades"].as_array().unwrap().len(),
        "first_trade": p0["trades"].as_array().unwrap().first().cloned().unwrap_or(Value::Null)}));
    // 显式 5
    let r5 = call(&st, "strategy_test_run", wr(json!(5))).await;
    let p5 = payload(&r5);
    let scores5 = p5["scores"].as_array().unwrap();
    let sigs5 = p5["signals"].as_array().unwrap();
    let trades5 = p5["trades"].as_array().unwrap();
    ev("I2.warmup5", json!({
        "requested": p5["warmup_requested"], "effective": p5["warmup_effective"],
        "bar_count": p5["bar_count"],
        "scores_len": scores5.len(), "signals_len": sigs5.len(),
        "n_scores_warmup_true": scores5.iter().filter(|s| s["warmup"]==json!(true)).count(),
        "n_signals_warmup_true": sigs5.iter().filter(|s| s["warmup"]==json!(true)).count(),
        "prefix_all_true": scores5.iter().take(5).all(|s| s["warmup"]==json!(true)),
        "suffix_all_false": scores5.iter().skip(5).all(|s| s["warmup"]==json!(false)),
        "warmup_signals": sigs5.iter().take(5).map(|s| s["signal"].clone()).collect::<Vec<_>>(),
        "warmup_scores": scores5.iter().take(5).map(|s| s["score"].clone()).collect::<Vec<_>>(),
        "n_trades": trades5.len(),
        "first_trade": trades5.first().cloned().unwrap_or(Value::Null),
        "min_trade_open_bar": trades5.iter().map(|t| t["open_bar"].as_u64().unwrap()).min(),
        "trades_in_warmup": trades5.iter().filter(|t| t["open_bar"].as_u64().unwrap() < 5).count(),
    }));
    assert_eq!(p5["warmup_requested"], json!(5));
    assert_eq!(p5["warmup_effective"], json!(5));
    assert_eq!(scores5.len(), 5 + (p5["bar_count"].as_u64().unwrap() as usize - 5));
    assert!(scores5.iter().take(5).all(|s| s["warmup"] == json!(true)));
    assert!(scores5.iter().skip(5).all(|s| s["warmup"] == json!(false)));
    assert!(sigs5.iter().take(5).all(|s| s["warmup"] == json!(true)));
    // 探针恒 buy：warmup 段信号确为 buy，但无任何成交落在 warmup 段
    assert!(sigs5.iter().take(5).all(|s| s["signal"] == json!("buy")),
        "探针策略 warmup 段信号应恒为 buy");
    assert!(trades5.iter().all(|t| t["open_bar"].as_u64().unwrap() >= 5),
        "warmup 段不得产成交");
    // 默认 250 逐 bar 标记
    let s_def = p_def["scores"].as_array().unwrap();
    ev("I2.default_250_marks", json!({
        "requested": p_def["warmup_requested"], "effective": p_def["warmup_effective"],
        "n_true": s_def.iter().filter(|s| s["warmup"]==json!(true)).count(),
        "scores_len": s_def.len(),
        "min_trade_open_bar": p_def["trades"].as_array().unwrap().iter()
            .map(|t| t["open_bar"].as_u64().unwrap()).min(),
    }));
    assert_eq!(p_def["warmup_requested"], json!(250));
    // 历史不足 → effective < requested（贴数据起点构造）
    let min_h1: (chrono::DateTime<Utc>,) = sqlx::query_as(
        "select min(ts) from kline_accurate_1h where code = $1").bind(CODE).fetch_one(&pool).await.unwrap();
    let from_near_start = min_h1.0 + chrono::Duration::hours(1);
    let r_short = call(&st, "strategy_test_run", json!({
        "code": PROBE_FLAT, "symbol": CODE, "period": "H1",
        "from": from_near_start.to_rfc3339(),
        "to": (from_near_start + chrono::Duration::days(20)).to_rfc3339(),
        "mode": "pure_score", "warmup_bars": 250 })).await;
    let p_short = payload(&r_short);
    ev("I2.shortfall", json!({"data_start_h1": min_h1.0, "from": from_near_start,
        "requested": p_short["warmup_requested"], "effective": p_short["warmup_effective"],
        "bar_count": p_short["bar_count"],
        "n_true": p_short["scores"].as_array().unwrap().iter().filter(|s| s["warmup"]==json!(true)).count()}));
    assert!(p_short["warmup_effective"].as_u64().unwrap() < 250, "历史不足须可见 shortfall");

    // ═══════════════════ I-3 fee / policy / capital ═══════════════════
    let fee_args = |extra: Value| {
        let mut a = h1_args("2024-01-02T00:00:00Z", "2024-04-01T00:00:00Z", json!({}));
        if let Some(o) = a.as_object_mut() {
            if let Some(e) = extra.as_object() { for (k, v) in e { o.insert(k.clone(), v.clone()); } }
        }
        a
    };
    let sum = |trades: &[Value], key: &str| -> f64 {
        trades.iter().map(|t| t[key].as_f64().unwrap_or(0.0)).sum()
    };
    let r_fee_def = call(&st, "strategy_test_run", fee_args(json!({"warmup_bars": 5}))).await;
    let p_fee_def = payload(&r_fee_def);
    let tr_def = p_fee_def["trades"].as_array().unwrap();
    ev("I3.fee_default_echo", json!({"fee": p_fee_def["fee"], "n_trades": tr_def.len(),
        "stamp_duty_sum": sum(tr_def, "stamp_duty"), "commission_sum": sum(tr_def, "commission"),
        "pnl_sum": sum(tr_def, "pnl"), "shares_first": tr_def.first().map(|t| t["shares"].clone())}));

    let r_fee_etf = call(&st, "strategy_test_run",
        fee_args(json!({"warmup_bars": 5,
            "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0}}))).await;
    let p_fee_etf = payload(&r_fee_etf);
    let tr_etf = p_fee_etf["trades"].as_array().unwrap();
    ev("I3.fee_etf_echo", json!({"fee": p_fee_etf["fee"], "n_trades": tr_etf.len(),
        "stamp_duty_sum": sum(tr_etf, "stamp_duty"), "commission_sum": sum(tr_etf, "commission"),
        "pnl_sum": sum(tr_etf, "pnl"),
        "commission_same_as_default": (sum(tr_etf, "commission") - sum(tr_def, "commission")).abs() < 1e-6,
        "pnl_differs": (sum(tr_etf, "pnl") - sum(tr_def, "pnl")).abs() > 1e-9}));
    // 装配前提：本夹具 full_state **未装配** fee_profiles → 省略 fee 走 default（旧股票口径 0.05）。
    // 若按生产装配复验（.with_fee_profiles(PgFeeProfileStore)），518880=etf → source=profile、印花税 0。
    // v1.1（ADR-019 §6）：解析改为**按字段优先级**（R-2）——显式对象**出现的字段**优先、**缺失字段逐字段回退档案**；
    // `source` 取**最高优先级来源**（R-3）。故缺省分支随 effective.source 取值；**显式 stamp 仍最高优先**。
    let eff_def = &p_fee_def["fee"]["effective"];
    assert_eq!(eff_def["stamp_duty_pct"],
        match eff_def["source"].as_str() {
            Some("default") => json!(0.05),
            Some("profile") => json!(0.0),
            other => panic!("缺省 fee source 应为 default|profile，实际 {other:?}"),
        },
        "缺省 fee：default→0.05（未装配）/ profile→0.0（生产装配 ETF 不征）");
    assert_eq!(p_fee_etf["fee"]["effective"]["stamp_duty_pct"], json!(0.0), "显式 0 须回显 0");
    assert_eq!(p_fee_etf["fee"]["effective"]["source"], json!("explicit"), "显式优先");
    assert!(sum(tr_etf, "stamp_duty") == 0.0, "ETF 显式 0 → 印花税合计为 0");
    assert!(sum(tr_def, "stamp_duty") > 0.0, "缺省股票口径 → 印花税合计 > 0");

    // ── v1.1 R-2/R-3 复核：显式对象按**字段优先级**（出现字段优先，缺失字段回退档案→旧默认）──
    // UI 三键 fee（rate/min/slippage，**无 stamp**）：本夹具无 fee_profiles → 缺失 stamp 回退第三级默认 0.05，
    // source=explicit（有字段来自显式）；**生产装配（ETF 档案）下同一入参 → stamp 回退 0**（R2-① 本批核心断言，
    // 已由 application 单测 fee::explicit_three_keys_without_stamp_falls_back_to_etf_profile 与 d11 端到端锁定）。
    let r_fee_ui3 = call(&st, "strategy_test_run",
        fee_args(json!({"warmup_bars": 5,
            "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0}}))).await;
    let p_fee_ui3 = payload(&r_fee_ui3);
    ev("I3.fee_ui3_field_level", json!({"fee": p_fee_ui3["fee"]}));
    assert_eq!(p_fee_ui3["fee"]["effective"]["source"], json!("explicit"),
        "显式字段存在 → source=explicit（R-3）");
    assert_eq!(p_fee_ui3["fee"]["effective"]["stamp_duty_pct"], json!(0.05),
        "未装配 fee_profiles → 缺失 stamp 回退旧默认 0.05（生产装配 ETF → 0）");
    // v1.1 R-2：仅**部分字段**（含 ≥1 可识别字段）**不报错**（字段级回退）。
    // v1.1 补守卫（架构师裁决）：显式对象**存在但无可识别字段**（`{}`/全未知键）→ **须报错**（fail-fast）。
    for (tag, extra) in [
        ("fee_missing_rate", json!({"fee": {"min_fee": 5.0}})),
    ] {
        let r = call(&st, "strategy_test_run", fee_args(extra)).await;
        ev(format!("I3.v11.{tag}"), json!({
            "isError": is_err(&r), "fee": payload(&r)["fee"],
            "text": err_text(&r).chars().take(160).collect::<String>()}));
        assert!(!is_err(&r), "v1.1 补守卫：{tag} 含 ≥1 可识别字段 → 不报错（字段级回退）");
    }
    // 空对象 / 全未知键：无任何可识别字段 → fail-fast，且消息须指明可识别字段集与收到键。
    for (tag, extra) in [
        ("fee_empty_object", json!({"fee": {}})),
        ("fee_unknown_keys", json!({"fee": {"foo": 1}})),
    ] {
        let r = call(&st, "strategy_test_run", fee_args(extra)).await;
        let text = err_text(&r);
        ev(format!("I3.guard.{tag}"), json!({
            "isError": is_err(&r),
            "text": text.chars().take(200).collect::<String>()}));
        assert!(is_err(&r), "v1.1 补守卫：{tag} 无可识别字段 → 须报错（fail-fast）");
        assert!(text.contains("可识别"), "{tag}: 错误消息须指明可识别字段集: {text}");
        for k in ["rate_pct", "min_fee", "slippage_bp", "stamp_duty_pct"] {
            assert!(text.contains(k), "{tag}: 错误消息须列出可识别字段 {k}: {text}");
        }
    }

    let r_cap = call(&st, "strategy_test_run",
        fee_args(json!({"warmup_bars": 5, "capital": 200000}))).await;
    let p_cap = payload(&r_cap);
    let tr_cap = p_cap["trades"].as_array().unwrap();
    ev("I3.capital_effect", json!({"n_trades": tr_cap.len(),
        "shares_first_100k": tr_def.first().map(|t| t["shares"].clone()),
        "shares_first_200k": tr_cap.first().map(|t| t["shares"].clone()),
        "ratio": tr_cap.first().map(|t| t["shares"].as_f64().unwrap() / tr_def.first().unwrap()["shares"].as_f64().unwrap()),
        "threshold_effect_applied": p_cap["fee"]}));
    assert!(tr_cap.first().unwrap()["shares"].as_f64().unwrap()
        > tr_def.first().unwrap()["shares"].as_f64().unwrap() * 1.9, "capital 须生效");

    let r_dca = call(&st, "strategy_test_run", fee_args(json!({"warmup_bars": 5,
        "policy": {"Dca": {"tranches": 3, "mode": "Equal", "amount": null, "interval": 5}}}))).await;
    ev("I3.policy_dca", json!({"isError": is_err(&r_dca),
        "n_trades": payload(&r_dca)["trades"].as_array().map(|a| a.len()),
        "text": if is_err(&r_dca) { err_text(&r_dca) } else { String::new() }}));
    let r_ls = call(&st, "strategy_test_run", fee_args(json!({"warmup_bars": 5,
        "policy": {"LumpSum": {"position_pct": 0.5}}}))).await;
    ev("I3.policy_lumpsum_half", json!({"isError": is_err(&r_ls),
        "n_trades": payload(&r_ls)["trades"].as_array().map(|a| a.len()),
        "shares_first": payload(&r_ls)["trades"].as_array().unwrap().first().map(|t| t["shares"].clone()),
        "vs_full_shares": tr_def.first().map(|t| t["shares"].clone())}));
    for (tag, extra) in [
        ("fee_stamp_out_of_range", json!({"fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 3.0}})),
        ("policy_bad", json!({"policy": {"Nope": {}}})),
        ("capital_zero", json!({"capital": 0})),
        ("capital_negative", json!({"capital": -5})),
        ("warmup_negative", json!({"warmup_bars": -1})),
        ("warmup_float", json!({"warmup_bars": 1.5})),
    ] {
        let r = call(&st, "strategy_test_run", fee_args(extra)).await;
        ev(format!("I3.validation.{tag}"), json!({
            "protocol_error": proto_err_code(&r), "message": proto_err_msg(&r),
            "isError": is_err(&r), "text": err_text(&r).chars().take(160).collect::<String>()}));
    }

    // ═══════════════════ 双通道一致性（strategy_test_run vs bt_run_ensemble） ═══════════════════
    let (vid, sid): (String, String) = sqlx::query_as(
        "select v.id, v.strategy_id from strategy_version v where v.status='published' order by v.id limit 1")
        .fetch_one(&pool).await.unwrap();
    ev("X.version", json!({"version_id": vid, "strategy_id": sid}));
    let common = |mode: &str, extra: Value| {
        let mut a = json!({"version_id": vid, "symbol": CODE, "period": "H1",
            "from": "2024-01-02T00:00:00Z", "to": "2024-04-01T00:00:00Z",
            "mode": mode, "params": {}, "warmup_bars": 250, "capital": 100000,
            "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0},
            "policy": {"LumpSum": {"position_pct": 1.0}}});
        if let (Some(o), Some(e)) = (a.as_object_mut(), extra.as_object()) {
            for (k, v) in e { o.insert(k.clone(), v.clone()); }
        }
        a
    };
    let tr_resp = call(&st, "strategy_test_run", common("sim_position", json!({}))).await;
    let p_tr = payload(&tr_resp);
    ev("X.test_run", json!({"isError": is_err(&tr_resp),
        "bar_count": p_tr["bar_count"], "warmup_requested": p_tr["warmup_requested"],
        "warmup_effective": p_tr["warmup_effective"], "fee": p_tr["fee"],
        "n_trades": p_tr["trades"].as_array().map(|a| a.len()),
        "n_scores": p_tr["scores"].as_array().map(|a| a.len()),
        "text": if is_err(&tr_resp) { err_text(&tr_resp) } else { String::new() }}));
    assert!(!is_err(&tr_resp), "双通道对照的试算通道须可用");

    let bt_args = json!({
        "name": "tester-010-h1-warmup", "symbol": CODE, "period": "H1",
        "from": "2024-01-02T00:00:00Z", "to": "2024-04-01T00:00:00Z",
        "slots": [{"strategy_id": sid, "version_id": vid, "weight": 1.0, "params": {}}],
        "buy_threshold": 60, "sell_threshold": 40,
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "initial_capital": 100000, "warmup_bars": 250,
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0}});
    let sub = call(&st, "bt_run_ensemble", bt_args.clone()).await;
    ev("X.bt_submit", json!({"isError": is_err(&sub),
        "run_id": payload(&sub)["run_id"], "config": payload(&sub)["run"]["config"],
        "status": payload(&sub)["run"]["status"],
        "text": if is_err(&sub) { err_text(&sub) } else { String::new() }}));
    assert!(!is_err(&sub), "bt_run_ensemble H1 提交须可用");
    let run_id = payload(&sub)["run_id"].as_str().unwrap().to_string();
    // 轮询至终态
    let mut status = String::new();
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let g = call(&st, "bt_get_run", json!({"run_id": run_id})).await;
        let gp = payload(&g);
        status = gp["status"].as_str().unwrap_or("").to_string();
        if status != "queued" && status != "running" {
            ev("X.bt_run_view", json!({"status": status, "config": gp["config"], "error": gp["error"]}));
            break;
        }
    }
    assert_eq!(status, "succeeded", "bt 运行须成功（终态 {status}）");
    let res = call(&st, "bt_get_run_result", json!({"run_id": run_id})).await;
    let rp = payload(&res);
    let per_bar = rp["per_bar"].as_array().unwrap();
    let bt_trades = rp["trades"].as_array().unwrap();
    let net_value = rp["net_value"].as_array().unwrap();
    let drawdown = rp["drawdown"].as_array().unwrap();
    let tr_trades = p_tr["trades"].as_array().unwrap();
    ev("X.bt_result", json!({
        "n_per_bar": per_bar.len(),
        "n_per_bar_warmup_true": per_bar.iter().filter(|b| b["warmup"]==json!(true)).count(),
        "net_value_len": net_value.len(), "drawdown_len": drawdown.len(),
        "n_trades": bt_trades.len(),
        "metrics": rp["metrics"],
        "trades_equal_to_test_run": bt_trades == tr_trades,
        "bar_count_test_run": p_tr["bar_count"], "warmup_effective_test_run": p_tr["warmup_effective"],
        "net_value_equals_inrange": net_value.len() as u64
            == p_tr["bar_count"].as_u64().unwrap() - p_tr["warmup_effective"].as_u64().unwrap(),
        "first_bt_trade": bt_trades.first().cloned().unwrap_or(Value::Null),
        "first_tr_trade": tr_trades.first().cloned().unwrap_or(Value::Null),
    }));
    ev("X.per_bar_first3", &per_bar[..3.min(per_bar.len())]);
    ev("X.per_bar_warmup_boundary",
        &per_bar.iter().skip(p_tr["warmup_effective"].as_u64().unwrap() as usize - 1).take(2)
            .map(|b| json!({"ts": b["ts"], "warmup": b["warmup"], "signal": b["signal"]}))
            .collect::<Vec<_>>());
    assert_eq!(net_value.len() as u64,
        p_tr["bar_count"].as_u64().unwrap() - p_tr["warmup_effective"].as_u64().unwrap(),
        "净值序列只含 in-range（warmup 不计净值）");
    assert!(per_bar.iter().take(250).all(|b| b["warmup"] == json!(true)), "per_bar 前 250 根标记 warmup");

    // 双通道 Dca 口径对照
    let dca = json!({"Dca": {"tranches": 3, "mode": "Equal", "amount": null, "interval": 5}});
    let tr_dca = call(&st, "strategy_test_run", common("sim_position", json!({"policy": dca}))).await;
    let p_tr_dca = payload(&tr_dca);
    let mut bt_dca_args = bt_args.clone();
    bt_dca_args["policy"] = dca.clone();
    bt_dca_args["name"] = json!("tester-010-h1-dca");
    let sub_dca = call(&st, "bt_run_ensemble", bt_dca_args).await;
    let run_dca = payload(&sub_dca)["run_id"].as_str().unwrap().to_string();
    let mut st_dca = String::new();
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let g = call(&st, "bt_get_run", json!({"run_id": run_dca})).await;
        st_dca = payload(&g)["status"].as_str().unwrap_or("").to_string();
        if st_dca != "queued" && st_dca != "running" { break; }
    }
    let res_dca = call(&st, "bt_get_run_result", json!({"run_id": run_dca})).await;
    let rp_dca = payload(&res_dca);
    ev("X.dca_two_channel", json!({
        "bt_status": st_dca,
        "tr_isError": is_err(&tr_dca), "tr_n_trades": p_tr_dca["trades"].as_array().map(|a| a.len()),
        "bt_n_trades": rp_dca["trades"].as_array().map(|a| a.len()),
        "trades_equal": rp_dca["trades"] == p_tr_dca["trades"],
        "lumpsum_n_trades": bt_trades.len(),
        "metrics": rp_dca["metrics"],
    }));

    // ═══════════════════ SSE 真链路（传输层） ═══════════════════
    let st_sse = full_state(pool.clone(),
        Arc::new(storage::reader::KlineReader::new(pool.clone()))).await;
    let mut c = sse_state(Arc::clone(&st_sse)).await;
    let tl_sse = sse_req(&mut c, json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}})).await;
    ev("SSE.tools_list", json!({"n_tools": tl_sse["result"]["tools"].as_array().map(|a| a.len()),
        "has_list_symbols": tl_sse["result"]["tools"].as_array().unwrap()
            .iter().any(|t| t["name"] == "list_symbols"),
        "has_get_kline": tl_sse["result"]["tools"].as_array().unwrap()
            .iter().any(|t| t["name"] == "get_kline"),
        "has_strategy_test_run": tl_sse["result"]["tools"].as_array().unwrap()
            .iter().any(|t| t["name"] == "strategy_test_run"),
        "has_bt_run_ensemble": tl_sse["result"]["tools"].as_array().unwrap()
            .iter().any(|t| t["name"] == "bt_run_ensemble")}));
    let ls_sse = sse_req(&mut c, json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"list_symbols","arguments":{}}})).await;
    ev("SSE.list_symbols", json!({"isError": ls_sse["result"].get("isError"),
        "n": serde_json::from_str::<Value>(ls_sse["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap()["symbols"].as_array().map(|a| a.len())}));
    let gk = sse_req(&mut c, json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
        "params":{"name":"get_kline","arguments":{"code":CODE,"limit":10001}}})).await;
    ev("SSE.get_kline_limit_over", json!({"error": gk["error"], "isError": gk["result"].get("isError")}));

    // 工具 schema 摘要（warmup/fee/policy/capital 契约面）
    let tr_schema = tools.iter().find(|t| t["name"] == "strategy_test_run").unwrap();
    let bt_schema = tools.iter().find(|t| t["name"] == "bt_run_ensemble").unwrap();
    ev("SCHEMA.strategy_test_run", json!({
        "properties": tr_schema["inputSchema"]["properties"].as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        "required": tr_schema["inputSchema"]["required"],
        "period_enum": tr_schema["inputSchema"]["properties"]["period"]["enum"],
        "warmup_bars": tr_schema["inputSchema"]["properties"]["warmup_bars"],
    }));
    ev("SCHEMA.bt_run_ensemble", json!({
        "properties": bt_schema["inputSchema"]["properties"].as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        "required": bt_schema["inputSchema"]["required"],
        "period_enum": bt_schema["inputSchema"]["properties"]["period"]["enum"],
    }));
    ev("SCHEMA.get_kline", json!({
        "properties": tools.iter().find(|t| t["name"] == "get_kline").unwrap()
            ["inputSchema"]["properties"],
        "required": tools.iter().find(|t| t["name"] == "get_kline").unwrap()
            ["inputSchema"]["required"],
    }));
    ev("SCHEMA.strategy_list", json!({
        "properties": tools.iter().find(|t| t["name"] == "strategy_list").unwrap()
            ["inputSchema"]["properties"],
    }));

    println!("DONE zz_tester_010_acceptance");
    let _ = (&st_fail, &st_sse, c);
}
