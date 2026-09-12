//! [TESTER 临时独立验收夹具 — 跑完即删，不提交，不属于实现]
//! I-1 独立验收：真实 DB 注册表 + 真实 storage 端口 + 真实 axum SSE 链路。
//! 用法：cargo test -p mcp --test zz_tester_i1_acceptance -- --nocapture --test-threads=1

use mcp::state::{McpState, SessionRegistry};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试用 no-op 进度 sink（web crate 不可用；只读回归调用不触发进度）。
struct NoopProgress;
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for NoopProgress {
    async fn send(&self, _r: &str, _p: f64, _b: Option<chrono::DateTime<chrono::Utc>>)
        -> anyhow::Result<()> { Ok(()) }
}

/// 与 app bin 同构的全量装配（只读使用；不做 seed/recover —— 避免任何写库）。
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

/// 垫片 A：注册表委派真实 KlineReader，bars 恒空（已注册但区间无数据）。
struct EmptyBarsRealRegistry(storage::reader::KlineReader);
#[async_trait::async_trait]
impl domain::ports::KlineRead for EmptyBarsRealRegistry {
    async fn bars(&self, _p: domain::types::Period, _c: &str,
                  _b: Option<chrono::DateTime<chrono::Utc>>, _l: i64)
        -> anyhow::Result<Vec<domain::ports::KlineBarView>> { Ok(vec![]) }
    async fn symbols_with_latest(&self)
        -> anyhow::Result<Vec<domain::ports::SymbolLatestView>> {
        self.0.symbols_with_latest().await
    }
}

/// 垫片 B：注册表查询失败（fail-closed），bars 委派真实 KlineReader。
struct FailingRegistryRealBars(storage::reader::KlineReader);
#[async_trait::async_trait]
impl domain::ports::KlineRead for FailingRegistryRealBars {
    async fn bars(&self, p: domain::types::Period, c: &str,
                  b: Option<chrono::DateTime<chrono::Utc>>, l: i64)
        -> anyhow::Result<Vec<domain::ports::KlineBarView>> { self.0.bars(p, c, b, l).await }
    async fn symbols_with_latest(&self)
        -> anyhow::Result<Vec<domain::ports::SymbolLatestView>> {
        anyhow::bail!("injected registry outage (tester)")
    }
}

// ── SSE 客户端（reqwest 真链路） ──
struct SseClient {
    base: String,
    endpoint: String,
    rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    reader: tokio::task::JoinHandle<()>,
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
    assert_eq!(resp.headers()["content-type"], "text/event-stream");
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
    SseClient { base, endpoint: first, rx, reader }
}

async fn call(client: &mut SseClient, id: i64, name: &str, args: Value) -> Value {
    let http = reqwest::Client::new();
    let r = http.post(format!("{}{}", client.base, client.endpoint))
        .json(&json!({"jsonrpc":"2.0","id":id,"method":"tools/call",
                      "params":{"name":name,"arguments":args}}))
        .send().await.unwrap();
    assert_eq!(r.status(), 202, "POST /messages 202");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(20), client.rx.recv())
        .await.expect("SSE 帧超时").expect("SSE 流存活");
    serde_json::from_str(&frame).unwrap()
}

/// 原始 JSON-RPC 帧（含协议错误帧路径）
async fn raw_call(client: &mut SseClient, body: Value) -> Value {
    let http = reqwest::Client::new();
    let r = http.post(format!("{}{}", client.base, client.endpoint))
        .json(&body).send().await.unwrap();
    assert_eq!(r.status(), 202, "POST /messages 202");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(20), client.rx.recv())
        .await.expect("SSE 帧超时").expect("SSE 流存活");
    serde_json::from_str(&frame).unwrap()
}

fn dump(tag: &str, name: &str, args: &Value, resp: &Value) {
    println!("TOOL {name} ARGS {}", serde_json::to_string(args).unwrap());
    println!("FRAME [{tag}] {}", serde_json::to_string(resp).unwrap());
}

#[tokio::test]
async fn zz_tester_i1_full_sse_acceptance() {
    let pool = pool().await;

    // 注册表实况（原始证据）
    let reg: Vec<(String,)> = sqlx::query_as("select code from symbols order by code")
        .fetch_all(&pool).await.unwrap();
    let codes: Vec<String> = reg.into_iter().map(|r| r.0).collect();
    println!("REGISTRY n={} {}", codes.len(), serde_json::to_string(&codes).unwrap());
    for probe in ["510300", "999999", "ABC123", "518880"] {
        println!("REGISTRY_CONTAINS {probe} = {}", codes.iter().any(|c| c == probe));
    }

    // ── A. 真实注册表 + 真实 storage（全链路 SSE） ──
    let st = full_state(pool.clone(),
        Arc::new(storage::reader::KlineReader::new(pool.clone()))).await;
    let mut ca = sse_state(st).await;
    for (i, code) in ["510300", "999999", "ABC123"].iter().enumerate() {
        let args = json!({ "code": code });
        let r = call(&mut ca, 10 + i as i64, "get_kline", args.clone()).await;
        dump("A-real", "get_kline", &args, &r);
    }
    let args = json!({ "code": "518880", "period": "1d", "limit": 3 });
    let r = call(&mut ca, 20, "get_kline", args.clone()).await;
    dump("A-real", "get_kline", &args, &r);

    // ── B. 已注册但区间无数据（注册表=真实 DB；bars=空） ──
    let st_b = full_state(pool.clone(),
        Arc::new(EmptyBarsRealRegistry(storage::reader::KlineReader::new(pool.clone())))).await;
    let mut cb = sse_state(st_b).await;
    for code in ["518880", "510300"] {
        let args = json!({ "code": code });
        let r = call(&mut cb, 30, "get_kline", args.clone()).await;
        dump("B-empty-real-registry", "get_kline", &args, &r);
    }

    // ── C. 注册表不可用 → fail-closed ──
    let st_c = full_state(pool.clone(),
        Arc::new(FailingRegistryRealBars(storage::reader::KlineReader::new(pool.clone())))).await;
    let mut cc = sse_state(st_c).await;
    let args = json!({ "code": "518880" });
    let r = call(&mut cc, 40, "get_kline", args.clone()).await;
    dump("C-registry-down", "get_kline", &args, &r);

    // ── D. 只读回归面（与生产 :8082 同参对比用） ──
    let reg_calls: Vec<(&str, Value)> = vec![
        ("get_sources_health", json!({"window_secs": 60})),
        ("get_data_quality", json!({"code": "518880", "date": "2026-09-10"})),
        ("get_data_quality", json!({"code": "999999", "date": "2026-09-10"})),
        ("strategy_list", json!({})),
        ("bt_list_runs", json!({})),
        ("sim_list_sessions", json!({})),
    ];
    for (i, (name, a)) in reg_calls.iter().enumerate() {
        let r = call(&mut ca, 100 + i as i64, name, a.clone()).await;
        dump("D-regression", name, a, &r);
    }

    // ── E. 参数校验优先级（未注册 + 非法 period → 协议错误 -32602 仍优先） ──
    let r = raw_call(&mut ca, json!({"jsonrpc":"2.0","id":500,"method":"tools/call",
        "params":{"name":"get_kline","arguments":{"code":"510300","period":"3m"}}})).await;
    println!("FRAME [E-invalid-period-unregistered] {}", serde_json::to_string(&r).unwrap());
    let r = raw_call(&mut ca, json!({"jsonrpc":"2.0","id":501,"method":"tools/call",
        "params":{"name":"get_kline","arguments":{"code":"510300","limit":99999}}})).await;
    println!("FRAME [E-limit-too-big-unregistered] {}", serde_json::to_string(&r).unwrap());

    // 保持连接（进程结束即释放）
    let _ = (&ca.reader, &cb.reader, &cc.reader);
}
