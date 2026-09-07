// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/tests/mcp_protocol.rs>>[init]
//! MCP 协议级集成测试（无 DB；mock domain 端口）：
//! 真实起 axum server，reqwest 开 SSE 长连接读帧、POST /messages 发 JSON-RPC——
//! 锁定 initialize / tools/list / tools/call / 通知 / 错误帧 / 会话生命周期全链路行为。

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{HealthEventRow, HealthEventsRead, KlineBarView, KlineRead, SymbolLatestView};
use domain::types::Period;
use mcp::state::{McpState, SessionRegistry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration as StdDuration;
use tokio::sync::mpsc;

// ── mock 端口（集成测试无法复用 lib 内 #[cfg(test)] mocks，按同构自带）──

struct MockKline;

#[async_trait::async_trait]
impl KlineRead for MockKline {
    async fn bars(&self, _period: Period, code: &str,
                  _before: Option<DateTime<Utc>>, _limit: i64)
        -> anyhow::Result<Vec<KlineBarView>> {
        let base = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap();
        Ok(vec![KlineBarView {
            code: code.into(), ts: base + Duration::minutes(1),
            open: 1.0, high: 1.1, low: 0.9, close: 1.05,
            volume: 100, amount: 105.0, source: Some("tencent_ifzq".into()),
        }])
    }
    async fn symbols_with_latest(&self) -> anyhow::Result<Vec<SymbolLatestView>> { Ok(vec![]) }
}

struct MockEvents;

#[async_trait::async_trait]
impl HealthEventsRead for MockEvents {
    async fn window_events(&self, _window_secs: i64) -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(vec![HealthEventRow {
            ts: Utc::now(), source: "mock_src".into(), ok: true,
            latency_ms: Some(80), err_kind: None, code: None,
        }])
    }
}

// ── Wave 2 Phase A：MCP④ 装配（本文件不涉其行锁，空口径 mock 仅求装配齐全）──

struct MockQuality;

#[async_trait::async_trait]
impl domain::ports::QualityRead for MockQuality {
    async fn divergence_rows(&self, _c: Option<&str>, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<domain::ports::DivergenceRow>> { Ok(vec![]) }
}

struct MockRaw;

#[async_trait::async_trait]
impl domain::ports::RawBarReader for MockRaw {
    async fn existing_ts(&self, _c: &domain::types::Code, _d: chrono::NaiveDate)
        -> anyhow::Result<std::collections::HashSet<DateTime<Utc>>> { Ok(Default::default()) }
}

struct MockRangeEvents;

#[async_trait::async_trait]
impl domain::ports::HealthEventsRangeRead for MockRangeEvents {
    async fn events_between(&self, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<HealthEventRow>> { Ok(vec![]) }
}

struct MockHolidays;

#[async_trait::async_trait]
impl domain::ports::HolidayCalendarRead for MockHolidays {
    async fn holidays(&self) -> anyhow::Result<std::collections::HashSet<chrono::NaiveDate>> {
        Ok(Default::default())
    }
}

struct MockTushare;

#[async_trait::async_trait]
impl domain::ports::TushareStatusRead for MockTushare {
    async fn sync_checkpoints(&self) -> anyhow::Result<Vec<domain::ports::SyncCheckpointView>> {
        Ok(vec![])
    }
}

struct NowClock;
impl domain::ports::Clock for NowClock { fn now(&self) -> DateTime<Utc> { Utc::now() } }

fn state() -> Arc<McpState> {
    Arc::new(McpState {
        kline: Arc::new(MockKline),
        health: diagnose::health::HealthService::new(Arc::new(MockEvents)),
        quality: diagnose::quality::QualityService::new(
            Arc::new(MockQuality), Arc::new(MockRaw), Arc::new(MockRangeEvents),
            Arc::new(MockHolidays), Arc::new(MockTushare), Arc::new(NowClock)),
        default_window_secs: 3600,
        sessions: SessionRegistry::default(),
        sim: None,
    })
}

async fn spawn(state: Arc<McpState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, mcp::server::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

// ── SSE 客户端测试夹具：读流按 "\n\n" 分帧，抽取 data: 行入通道 ──

struct SseClient {
    endpoint: String,
    events: mpsc::UnboundedReceiver<String>,
    /// 读流任务句柄（断连需 abort：任务持有 resp/连接，仅 drop 接收端不会关 TCP）。
    reader: tokio::task::JoinHandle<()>,
}

/// 断开 SSE 连接（abort 读流任务 → resp 被 drop → TCP FIN → 服务端写失败清理会话）。
fn sse_close(client: SseClient) {
    client.reader.abort();
}

async fn sse_connect(http: &reqwest::Client, base: &str) -> SseClient {
    let mut resp = http.get(format!("{base}/sse")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "text/event-stream");
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let reader = tokio::spawn(async move {
        let mut buf = String::new();
        while let Ok(Some(chunk)) = resp.chunk().await {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                // 注释帧（:ka）无 data 行，自然忽略
                if let Some(data) = frame.lines().find_map(|l| l.strip_prefix("data: ")) {
                    if tx.send(data.to_string()).is_err() { break; }   // 客户端关闭 → 断连
                }
            }
        }
    });
    let mut client = SseClient { endpoint: String::new(), events: rx, reader };
    // 首帧必为 endpoint（MCP SSE transport 契约）
    let first = next_event(&mut client).await;
    assert!(first.starts_with("/messages?sessionId="), "首帧 endpoint：{first}");
    client.endpoint = first;
    client
}

async fn next_event(client: &mut SseClient) -> String {
    tokio::time::timeout(StdDuration::from_secs(5), client.events.recv())
        .await.expect("SSE 事件超时").expect("SSE 流存活")
}

async fn post(http: &reqwest::Client, base: &str, endpoint: &str, body: &Value) -> reqwest::StatusCode {
    http.post(format!("{base}{endpoint}")).json(body).send().await.unwrap().status()
}

async fn next_resp(client: &mut SseClient) -> Value {
    serde_json::from_str(&next_event(client).await).expect("message 帧 data 为 JSON-RPC 响应")
}

#[tokio::test]
async fn mcp_sse_full_protocol_roundtrip() {
    let st = state();
    let sessions = st.sessions.clone();
    let base = spawn(st).await;
    let http = reqwest::Client::new();
    let mut client = sse_connect(&http, &base).await;
    assert_eq!(sessions.len(), 1, "SSE 连接即注册会话");

    // 1. initialize → 202 + SSE message 帧（protocolVersion/capabilities/serverInfo）
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": { "name": "test", "version": "0" } },
    })).await;
    assert_eq!(status, 202, "POST /messages 一律 202（响应经 SSE 下发）");
    let resp = next_resp(&mut client).await;
    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 1);
    assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(resp["result"]["serverInfo"]["name"], "eestock-mcp");
    assert!(resp["result"]["capabilities"]["tools"].is_object());

    // 2. 通知：202 照收，无响应帧（后续帧序不被打乱即证明）
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!(status, 202);

    // 3. tools/list → 17 个工具（3 只读 + 8 模拟实盘 L1 + 3 策略工具 L2 + 3 会话记录/对比 L3；ADR-009 范围①② Wave 1 + 范围④ Wave 2 Phase A + 11-sim-live L1/L2/L3）
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    assert_eq!(status, 202);
    let resp = next_resp(&mut client).await;
    let tools = resp["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 17, "通知无响应帧——本帧即 tools/list 响应（帧序锁定）");
    assert_eq!(tools[0]["name"], "get_kline");
    assert_eq!(tools[0]["inputSchema"]["required"], json!(["code"]));
    assert_eq!(tools[0]["inputSchema"]["properties"]["period"]["enum"],
        json!(["1m", "5m", "15m", "1h", "1d"]));
    assert_eq!(tools[1]["name"], "get_sources_health");

    // 4. tools/call get_kline → content text 为 payload JSON
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "get_kline", "arguments": { "code": "518880" } } })).await;
    assert_eq!(status, 202);
    let resp = next_resp(&mut client).await;
    assert_eq!(resp["id"], 3);
    assert_eq!(resp["result"]["content"][0]["type"], "text");
    let payload: Value = serde_json::from_str(
        resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(payload["code"], "518880");
    assert_eq!(payload["period"], "1m", "缺省 period=1m");
    assert_eq!(payload["bars"][0]["close"], 1.05);
    assert_eq!(payload["bars"][0]["source"], "tencent_ifzq");

    // 5. tools/call get_sources_health
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": { "name": "get_sources_health", "arguments": {} } })).await;
    assert_eq!(status, 202);
    let resp = next_resp(&mut client).await;
    let payload: Value = serde_json::from_str(
        resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(payload["window_secs"], 3600, "缺省窗口 = 配置默认");
    assert_eq!(payload["sources"][0]["source"], "mock_src");

    // 6. 未知方法 → -32601 帧（经 SSE 下发，echo id）
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "id": 5, "method": "resources/list" })).await;
    assert_eq!(status, 202);
    let resp = next_resp(&mut client).await;
    assert_eq!(resp["error"]["code"], -32601);
    assert_eq!(resp["id"], 5);

    // 7. 坏帧（非 JSON）→ 202 + -32700（id=null）
    let r = http.post(format!("{base}{}", client.endpoint))
        .body("not json at all").send().await.unwrap();
    assert_eq!(r.status(), 202);
    let resp = next_resp(&mut client).await;
    assert_eq!(resp["error"]["code"], -32700);
    assert!(resp["id"].is_null(), "解析失败无 id 可得 → null");

    // 8. 工具参数错误 → -32602
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "id": 6, "method": "tools/call",
        "params": { "name": "get_kline", "arguments": { "period": "3m" } } })).await;
    assert_eq!(status, 202);
    let resp = next_resp(&mut client).await;
    assert_eq!(resp["error"]["code"], -32602, "缺 code → invalid params");

    // 9. 断连 → 会话注销（连接泄漏防护：SessionGuard drop；
    //    服务端在下一写帧（保活 ≤15s）时发现写失败而清理，容差 20s）
    sse_close(client);
    let deadline = std::time::Instant::now() + StdDuration::from_secs(20);
    while !sessions.is_empty() && std::time::Instant::now() < deadline {
        tokio::time::sleep(StdDuration::from_millis(50)).await;
    }
    assert_eq!(sessions.len(), 0, "SSE 断连后会话注销（泄漏防护）");
}

#[tokio::test]
async fn messages_requires_known_session() {
    let base = spawn(state()).await;
    let http = reqwest::Client::new();
    // 缺 sessionId → 400
    let r = http.post(format!("{base}/messages"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        .send().await.unwrap();
    assert_eq!(r.status(), 400);
    // 未知会话 → 404
    let r = http.post(format!("{base}/messages?sessionId=no-such"))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        .send().await.unwrap();
    assert_eq!(r.status(), 404);
}
// ~/~ end
