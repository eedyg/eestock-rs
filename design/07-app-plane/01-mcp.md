# 07-app-plane / 01 — MCP HTTP/SSE 服务（mcp crate）

> 本文档 tangle 生成：
> `crates/mcp/src/{lib,state,rpc,tools,server,mocks}.rs`、`crates/mcp/tests/{mcp_protocol,mcp_tools_db}.rs`。
>
> 决策依据：ADR-009（MCP 形态 = HTTP/SSE 常驻服务；工具开放范围 ①查行情 ②数据源健康——本阶段交付；
> ③数据质量、④交易后续波次）、ADR-017（应用面与数据面零 API 直连，唯一耦合点 = TimescaleDB）、
> ADR-008（axum 栈）、ADR-010（免认证内网）、wave-1.md 验收（「MCP 客户端能查到行情与源健康」）。
>
> **分层红线**（与 web 同口径，07 §0 既定）：mcp crate **只允许依赖 domain + diagnose**——
> 行情经 `domain::ports::KlineRead`、源健康经 `diagnose::health::HealthService`（内部注入
> `domain::ports::HealthEventsRead`）；**禁止 storage/sqlx 直达**（storage/sqlx 仅在
> dev-dependencies 做集成测试装配与造数，`cargo tree -p mcp -e normal` 验证）。
>
> **数据面零改动**：本阶段不触碰 collector/providers/tushare/storage 写入路径一行。
> 既有代码仅有三处父级授权的加法扩展（代码块维护在 00-web-api.md，因 tangle 单属主原则）：
> ① `crates/app/src/app_config.rs` 增加 `mcp_listen` 配置项（默认 `0.0.0.0:8082`，env `MCP_LISTEN` 覆盖）；
> ② `crates/app/src/bin/eestock-app.rs` 装配 MCP（**与 web 同进程**——复用同一 DI 产物最简单，
> 符合 KISS；**端口独立** 8082，见 §4）；③ `Dockerfile.app` `EXPOSE 8081 8082`。
> 手写例外（不 tangle，README 既定口径）：`docker-compose.yml`（app 服务加 8082 端口映射）、
> `config/app.toml.example`、`crates/mcp/Cargo.toml`、`crates/app/Cargo.toml`、workspace `Cargo.toml`。

## 0. 决策注记（2026-09-04，父级裁决）

**SSE 流实现依赖裁决**：ADR-009 定稿形态为 HTTP/SSE（MCP spec 2024-11-05 transport：GET /sse 长连接 +
POST /messages）。axum 0.8 不内置 SSE（在 axum-extra），`Body::from_stream` 需要 futures-core TryStream，
workspace 均未声明。候选：

- **A（批准）**：mcp crate 加 `tokio-stream`（workspace 级声明 `0.1`，features `sync`）——
  `ReceiverStream`/`IntervalStream` 实现真 SSE transport，完全忠于 ADR-009；锁文件零变化
  （tokio-stream 已作为 sqlx 传递依赖在树内，实际零新增编译单元），手写代码最少，风险最低。
- B：只加 `futures-core` 手写 Stream impl（~15 行 poll 样板）——同样真 SSE 但多手写样板。
- C：零新增依赖改走 Streamable HTTP transport（2025-03-26 spec，POST 直回 JSON，无 SSE 流）——
  偏离 ADR-009「HTTP/SSE」字面口径，否决。

**附加口径**（父级裁决）：SSE 端点须有关闭/超时清理（连接泄漏防护——§3 SessionGuard + 会话登记注销）；
MCP Streamable HTTP transport（SSE 在 2025-03-26 spec 已标记 deprecated）列 **Wave 2 评估 backlog**
（届时评估双 transport 并存或迁移，本期不做，已记 99-decisions-log.md）。

**同进程决策**：任务书授权「与 web 同进程 or 独立 bin——若同进程更简单选同进程」。同进程复用
eestock-app 既有 DI（KlineRead/HealthEventsRead 同一实现实例），零新增配置面（仅一个监听地址），
故选**同进程**；端口独立（8082）保证 MCP 面与 web 面可独立封禁/审计。

**Wave 2 Phase A 补记（2026-09-04）**：ADR-009 范围④ 数据质量工具落地为 `get_data_quality(code, date)`
——单日质量卡（交易日历 + 缺口三级分类 + 分歧汇总），经 `diagnose::quality::QualityService`
（与 REST /api/quality/* 同服务同口径，web/mcp 共享同一实例 Clone=同 Arc 组）。

## 1. 协议契约

### 1.1 传输（MCP SSE transport，spec 2024-11-05）

| 端点 | 方法 | 行为 |
|---|---|---|
| `/sse` | GET | `text/event-stream` 长连接。首帧 `event: endpoint`，`data: /messages?sessionId=<32hex>`；随后每个 JSON-RPC 响应为 `event: message`（data = 响应帧 JSON 单行）；15s 保活注释帧（`:ka`）。客户端断开即注销会话（SessionGuard drop） |
| `/messages?sessionId=<id>` | POST | 接收 JSON-RPC 2.0 请求帧（UTF-8 JSON 文本）；一律 `202 Accepted`（响应经 SSE 流异步下发；通知类无响应也 202）。缺 sessionId → 400；未知/已关闭会话 → 404；通道溢出 → 410 |

会话通道容量 64（溢出 410，客户端重连重建会话兜底）。免认证（ADR-010 内网），仅监听局域网
（容器内 0.0.0.0，宿主机端口映射由 compose 控制；无公网暴露口径与 web 一致）。

### 1.2 JSON-RPC 方法

| 方法 | 响应 | 说明 |
|---|---|---|
| `initialize` | `{protocolVersion:"2024-11-05", capabilities:{tools:{listChanged:false}}, serverInfo:{name:"eestock-mcp",version}}` | 协议版本不回读客户端取值，恒返回本服务口径 |
| `notifications/*`（或无 id 帧） | 无响应（202 照收） | 通知语义 |
| `ping` | `{}` | 保活 |
| `tools/list` | `{tools:[...]}`（§1.3） | ADR-009 范围①②（Wave 1）+ 范围④ 数据质量（Wave 2 Phase A），共三个只读工具 |
| `tools/call` | `{content:[{type:"text",text:<pretty JSON>}], isError?}` | 工具结果以 pretty JSON 文本承载（MCP 惯例） |
| 其他 | 错误 `-32601 method not found` | — |

错误口径：**协议层**错误（帧非法 → `-32700`；未知方法 → `-32601`；参数缺失/非法 → `-32602`）走
JSON-RPC error 帧；**工具执行**错误（读端口/聚合失败）走 result 帧 `isError:true`（MCP 惯例——
LLM 客户端据此把错误当工具输出处理）。响应 echo 请求 id（string/number 原样回）。

### 1.3 工具 schema 与结果线格式

- `get_kline(code, period="1m", limit=240≤1000)`：inputSchema required=["code"]，period
  enum=["1m","5m","15m","1h","1d"]。结果 payload `{"code","period","bars":[{ts,open,high,low,close,
  volume,amount,source?}]}`——**bars 升序**；1m 经 `KlineRead` 走 `kline_merged` 合并视图
  （准确层优先，ADR-003），5m/15m/1d 连续聚合、1h 由 15m rollup（与 REST /api/kline 同端口同语义）；
  source 仅 1m merge 视图带（cagg 序列化时省略该键）。
- `get_sources_health(window_secs=默认≤604800)`：结果 payload `{"window_secs","sources":[SourceHealth]}`，
  复用 diagnose 聚合口径（成功率分母排除 na / 熔断迁移推导 / 状态灯 95% 边界，05-diagnose §1）；
  window_secs 缺省 = app 配置 `health_window_secs`，钳制 60..604800（与 REST 同口径）。
- `get_data_quality(code, date)`（**Wave 2 Phase A，ADR-009 范围④落地**）：required=["code","date"]；
  date 为 YYYY-MM-DD。结果 payload = `diagnose::quality::DailyQuality`（{"code","date","trading_day",
  "gap":DayGap\|null,"divergence":DivergenceSummary}）——单日缺口卡（交易日历口径：非交易日
  trading_day=false 且 gap=null）+ 当日 raw vs accurate 分歧汇总（阈值 = 页面④ 定稿 0.5%）。
  经 `QualityService`（与 REST /api/quality/* 同服务同口径）。
- **交易类工具不做**（ADR-009 范围④ Wave 4，独立开关默认关）。

## 2. mcp crate（Presentation 层）

``` {.rust file=crates/mcp/src/lib.rs}
//! mcp —— Presentation：MCP HTTP/SSE 常驻服务（ADR-009 范围①②：行情查询 + 源健康；
//! Wave 2 Phase A 加法：范围④ 数据质量 get_data_quality）。
//! 由 design/07-app-plane/01-mcp.md tangle 生成（ADR-007），禁止手改。

pub mod rpc;
pub mod server;
pub mod state;
pub mod tools;

#[cfg(test)]
pub(crate) mod mocks;
```

``` {.rust file=crates/mcp/src/state.rs}
//! MCP 应用状态与会话登记（DI 装配产物；app crate 注入具体实现）。
//! 分层红线：mcp 只见 domain 端口 + diagnose 服务，不依赖 storage/sqlx（同 web 口径）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// MCP 应用状态（与 web::state::AppState 同模式，只读端口注入）。
pub struct McpState {
    /// K线只读端口（domain::ports::KlineRead；storage 实现由 app 装配）。
    pub kline: Arc<dyn domain::ports::KlineRead>,
    /// 健康查询服务（diagnose；内部注入 domain::ports::HealthEventsRead）。
    pub health: diagnose::health::HealthService,
    /// 数据质量服务（Wave 2 Phase A：MCP④ get_data_quality；diagnose::quality，与 web 同实例）。
    pub quality: diagnose::quality::QualityService,
    /// get_sources_health 缺省统计窗口（秒；与 app 配置 health_window_secs 同源）。
    pub default_window_secs: i64,
    /// SSE 会话登记（sessionId → 消息通道）。
    pub sessions: SessionRegistry,
}

/// 会话登记表（std Mutex 不跨 await；与 web SubscriptionRegistry 同模式）。
#[derive(Clone, Default)]
pub struct SessionRegistry {
    inner: Arc<Mutex<HashMap<String, tokio::sync::mpsc::Sender<String>>>>,
}

impl SessionRegistry {
    /// 开新会话：生成 32 位 hex sessionId（rand，与 Trace ID 同口径，不引 uuid）。
    pub fn create(&self, cap: usize) -> (String, tokio::sync::mpsc::Receiver<String>) {
        let (tx, rx) = tokio::sync::mpsc::channel(cap);
        let id = new_session_id();
        self.inner.lock().expect("sessions poisoned").insert(id.clone(), tx);
        (id, rx)
    }

    /// 取会话发送端（POST /messages 路由）；会话被移除 → None（404）。
    pub fn sender(&self, id: &str) -> Option<tokio::sync::mpsc::Sender<String>> {
        self.inner.lock().expect("sessions poisoned").get(id).cloned()
    }

    /// 注销会话（SSE 断开时由 SessionGuard 调用；通道发送端随之失效）。
    pub fn remove(&self, id: &str) {
        self.inner.lock().expect("sessions poisoned").remove(id);
    }

    /// 活跃会话数（连接泄漏观测/测试断言用）。
    pub fn len(&self) -> usize { self.inner.lock().expect("sessions poisoned").len() }

    pub fn is_empty(&self) -> bool { self.len() == 0 }
}

/// 32 位 hex 随机会话 id（rand 16 字节；99-decisions-log 既定口径：不引 uuid）。
fn new_session_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_lifecycle_and_id_shape() {
        let reg = SessionRegistry::default();
        let (id1, _rx1) = reg.create(8);
        let (id2, _rx2) = reg.create(8);
        assert_eq!(reg.len(), 2);
        assert_ne!(id1, id2);
        assert_eq!(id1.len(), 32, "16 字节 hex = 32 字符");
        assert!(id1.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(reg.sender(&id1).is_some());
        assert!(reg.sender("no-such-session").is_none());
        reg.remove(&id1);
        assert_eq!(reg.len(), 1);
        assert!(reg.sender(&id1).is_none(), "注销后 POST 路由 404");
    }
}
```

``` {.rust file=crates/mcp/src/rpc.rs}
//! MCP JSON-RPC 2.0 协议帧分发（spec 2024-11-05 口径）：
//! initialize / ping / tools/list / tools/call；通知无响应；未知方法 -32601。
//! 纯分发层（可离线 TDD）：输入 RpcRequest、输出 Option<Value>（通知 → None）；HTTP/SSE 传输在 server.rs。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::McpState;

/// MCP 协议版本（ADR-009 SSE transport 口径；Streamable HTTP 迁移列 Wave 2 评估，99-decisions-log）。
pub const PROTOCOL_VERSION: &str = "2024-11-05";
pub const SERVER_NAME: &str = "eestock-mcp";

pub const PARSE_ERROR: i64 = -32700;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

/// JSON-RPC 请求帧（jsonrpc 字段容忍缺省——免认证内网 ADR-010，宽容解析；坏帧由 server 层 -32700）。
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

/// 成功响应帧（echo id；id=None → null——仅用于解析失败等无 id 可得场景）。
pub fn result_ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 错误响应帧（JSON-RPC 标准错误码）。
pub fn result_err(id: Option<Value>, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// 协议分发：通知（notifications/* 或无 id 帧）→ None；未知方法 → -32601。
pub async fn dispatch(st: &McpState, req: &RpcRequest) -> Option<Value> {
    if req.method.starts_with("notifications/") || req.id.is_none() {
        return None;
    }
    match req.method.as_str() {
        "initialize" => Some(result_ok(req.id.clone(), json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        }))),
        "ping" => Some(result_ok(req.id.clone(), json!({}))),
        "tools/list" => Some(result_ok(req.id.clone(), crate::tools::tool_list())),
        "tools/call" => Some(crate::tools::call_tool(st, req.id.clone(), req.params.clone()).await),
        _ => Some(result_err(req.id.clone(), METHOD_NOT_FOUND, "method not found")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{test_state, MockEvents, MockKline};
    use std::sync::Arc;

    fn st() -> Arc<McpState> {
        test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()))
    }

    fn req(id: Option<Value>, method: &str, params: Option<Value>) -> RpcRequest {
        RpcRequest { jsonrpc: Some("2.0".into()), id, method: method.into(), params }
    }

    #[tokio::test]
    async fn initialize_returns_protocol_capabilities_serverinfo() {
        let r = dispatch(&st(), &req(Some(json!(1)), "initialize", Some(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "claude-desktop", "version": "1" },
        })))).await.expect("initialize 有响应");
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(r["result"]["capabilities"]["tools"].is_object());
        assert_eq!(r["result"]["serverInfo"]["name"], "eestock-mcp");
    }

    #[tokio::test]
    async fn id_echo_string_and_numeric_and_ping() {
        let r = dispatch(&st(), &req(Some(json!("abc-1")), "ping", None)).await.unwrap();
        assert_eq!(r["id"], "abc-1", "string id 原样 echo");
        let r = dispatch(&st(), &req(Some(json!(42)), "ping", None)).await.unwrap();
        assert_eq!(r["id"], 42);
        assert_eq!(r["result"], json!({}));
    }

    #[tokio::test]
    async fn notifications_yield_no_response() {
        assert!(dispatch(&st(), &req(None, "notifications/initialized", None)).await.is_none());
        assert!(dispatch(&st(), &req(None, "notifications/cancelled", Some(json!({})))).await.is_none());
    }

    #[tokio::test]
    async fn unknown_method_is_32601() {
        let r = dispatch(&st(), &req(Some(json!(7)), "resources/list", None)).await.unwrap();
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["id"], 7);
    }

    #[tokio::test]
    async fn tools_list_and_call_route_to_tools_layer() {
        let r = dispatch(&st(), &req(Some(json!(2)), "tools/list", None)).await.unwrap();
        let names: Vec<&str> = r["result"]["tools"].as_array().unwrap()
            .iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["get_kline", "get_sources_health", "get_data_quality"]);
        let r = dispatch(&st(), &req(Some(json!(3)), "tools/call", Some(json!({
            "name": "get_sources_health", "arguments": {},
        })))).await.unwrap();
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("mock_src"));
    }
}
```

``` {.rust file=crates/mcp/src/tools.rs}
//! MCP 工具实现（ADR-009 范围①②）：
//! - get_kline(code, period, limit)：merge 视图准确层优先（经 domain::ports::KlineRead）
//! - get_sources_health(window_secs?)：源健康卡片数据（经 diagnose::health::HealthService）
//!
//! 参数校验失败 → -32602（协议层）；端口/聚合执行失败 → result.isError=true（MCP 工具错误惯例）。
//! 交易类工具不做（ADR-009 范围④ Wave 4，独立开关默认关）。

use chrono::{DateTime, Utc};
use domain::types::Period;
use serde::Serialize;
use serde_json::{json, Value};

use crate::rpc::{result_err, result_ok, INVALID_PARAMS};
use crate::state::McpState;

/// limit 上限/缺省（与 REST /api/kline 同口径，07 §1.1）。
pub const MAX_LIMIT: i64 = 1000;
pub const DEFAULT_LIMIT: i64 = 240;
/// window_secs 钳制区间（与 REST /api/sources/health 同口径）。
pub const MIN_WINDOW_SECS: i64 = 60;
pub const MAX_WINDOW_SECS: i64 = 604800;

/// 外部周期口径 → domain Period（与 web dto 同映射；mcp 不依赖 web——
/// 两 Presentation 层各自承载 5 行映射，防跨层反向依赖）。
fn parse_period(s: &str) -> Option<Period> {
    match s {
        "1m" => Some(Period::M1),
        "5m" => Some(Period::M5),
        "15m" => Some(Period::M15),
        "1h" => Some(Period::H1),
        "1d" => Some(Period::D1),
        _ => None,
    }
}

/// tools/list 响应：工具描述 + JSON Schema（MCP 客户端据此构造调用）。
pub fn tool_list() -> Value {
    json!({
        "tools": [
            {
                "name": "get_kline",
                "description": "查询标的 K 线（1m 为 merge 视图：准确层优先、raw 补缺；5m/15m/1d 连续聚合；1h 由 15m rollup）。bars 升序返回。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "code": { "type": "string", "description": "6 位标的代码，如 518880" },
                        "period": { "type": "string", "enum": ["1m", "5m", "15m", "1h", "1d"], "description": "周期，默认 1m" },
                        "limit": { "type": "integer", "description": "根数，默认 240，上限 1000" }
                    },
                    "required": ["code"]
                }
            },
            {
                "name": "get_sources_health",
                "description": "数据源健康卡片：窗口成功率（分母排除 na）/延迟分位数/熔断态/状态灯/最近错误。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "window_secs": { "type": "integer", "description": "统计窗口秒数，默认 3600，钳制 60..604800" }
                    }
                }
            },
            {
                "name": "get_data_quality",
                "description": "单日数据质量卡（ADR-009 范围④）：交易日历判定（trading_day）+ 缺口段（三级分类 source_fault/upstream_no_data/system_gap）+ 当日 raw vs accurate 分歧汇总（阈值 0.5%）。非交易日 gap=null。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "code": { "type": "string", "description": "6 位标的代码，如 518880" },
                        "date": { "type": "string", "description": "日期 YYYY-MM-DD（Asia/Shanghai 日界）" }
                    },
                    "required": ["code", "date"]
                }
            }
        ]
    })
}

/// tools/call 分发：缺 params/name、未知工具 → -32602。
pub async fn call_tool(st: &McpState, id: Option<Value>, params: Option<Value>) -> Value {
    let Some(params) = params else {
        return result_err(id, INVALID_PARAMS, "tools/call 缺 params");
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "tools/call.params.name 必填（string）");
    };
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    match name {
        "get_kline" => get_kline(st, id, &args).await,
        "get_sources_health" => get_sources_health(st, id, &args).await,
        "get_data_quality" => get_data_quality(st, id, &args).await,
        _ => result_err(id, INVALID_PARAMS, format!("未知工具：{name}")),
    }
}

/// 工具成功结果：payload pretty JSON 包进 text content（MCP 惯例）。
fn tool_ok(id: Option<Value>, payload: &impl Serialize) -> Value {
    let text = serde_json::to_string_pretty(payload).expect("tool payload serialize");
    result_ok(id, json!({ "content": [{ "type": "text", "text": text }] }))
}

/// 工具执行失败（端口/聚合错误）：result.isError=true（MCP 惯例，非协议错误）。
fn tool_fail(id: Option<Value>, e: anyhow::Error) -> Value {
    result_ok(id, json!({
        "content": [{ "type": "text", "text": format!("工具执行失败：{e}") }],
        "isError": true,
    }))
}

/// K线 bar 输出（source 仅 1m merge 视图带；cagg 省略该键——与 REST BarDto 同口径）。
#[derive(Debug, Serialize)]
struct BarOut {
    ts: DateTime<Utc>,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: i64,
    amount: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// get_kline(code, period=1m, limit=240≤1000)：merge 视图准确层优先（经 domain::ports::KlineRead）。
async fn get_kline(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let Some(code) = args.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()) else {
        return result_err(id, INVALID_PARAMS, "code 必填（非空 string）");
    };
    let period_s = args.get("period").and_then(Value::as_str).unwrap_or("1m");
    let Some(period) = parse_period(period_s) else {
        return result_err(id, INVALID_PARAMS, "period 须为 1m/5m/15m/1h/1d");
    };
    let limit = match args.get("limit") {
        None => DEFAULT_LIMIT,
        Some(v) => match v.as_i64() {
            Some(n) => n.clamp(1, MAX_LIMIT),
            None => return result_err(id, INVALID_PARAMS, "limit 须为整数"),
        },
    };
    match st.kline.bars(period, code, None, limit).await {
        Ok(bars) => {
            let out: Vec<BarOut> = bars.iter().map(|b| BarOut {
                ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close,
                volume: b.volume, amount: b.amount, source: b.source.clone(),
            }).collect();
            tool_ok(id, &json!({ "code": code, "period": period_s, "bars": out }))
        }
        Err(e) => tool_fail(id, e),
    }
}

/// get_sources_health(window_secs=配置默认，钳制 60..604800)：源健康卡片数据（diagnose 聚合）。
async fn get_sources_health(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let window = match args.get("window_secs") {
        None => st.default_window_secs,
        Some(v) => match v.as_i64() {
            Some(n) => n.clamp(MIN_WINDOW_SECS, MAX_WINDOW_SECS),
            None => return result_err(id, INVALID_PARAMS, "window_secs 须为整数"),
        },
    };
    match st.health.aggregate(window).await {
        Ok(sources) => tool_ok(id, &json!({ "window_secs": window, "sources": sources })),
        Err(e) => tool_fail(id, e),
    }
}

/// 严格 YYYY-MM-DD（chrono %Y-%m-%d 容忍未补零——线格式契约要求定长 10 字符）。
pub fn parse_date_strict(s: &str) -> Option<chrono::NaiveDate> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' { return None; }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// get_data_quality(code, date)（Wave 2 Phase A，ADR-009 范围④）：单日质量卡（QualityService）。
async fn get_data_quality(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let Some(code) = args.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()) else {
        return result_err(id, INVALID_PARAMS, "code 必填（非空 string）");
    };
    let Some(date_s) = args.get("date").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "date 必填（YYYY-MM-DD）");
    };
    let Some(date) = parse_date_strict(date_s) else {
        return result_err(id, INVALID_PARAMS, "date 须为 YYYY-MM-DD");
    };
    match st.quality.daily_quality(code, date).await {
        Ok(q) => tool_ok(id, &q),
        Err(e) => tool_fail(id, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{test_state, MockEvents, MockKline};
    use std::sync::Arc;

    async fn call(st: &McpState, name: &str, args: Value) -> Value {
        call_tool(st, Some(json!(9)), Some(json!({ "name": name, "arguments": args }))).await
    }

    /// content[0].text 内的 payload JSON（工具成功结果）。
    fn payload_of(resp: &Value) -> Value {
        let text = resp["result"]["content"][0]["text"].as_str().expect("text content");
        serde_json::from_str(text).expect("content 文本为 JSON payload")
    }

    #[test]
    fn tool_list_schema_contract() {
        let v = tool_list();
        let tools = v["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3, "ADR-009 范围①②（Wave 1）+ 范围④（Wave 2 Phase A），三个只读工具");
        assert_eq!(tools[0]["name"], "get_kline");
        assert_eq!(tools[0]["inputSchema"]["required"], json!(["code"]));
        assert_eq!(tools[0]["inputSchema"]["properties"]["period"]["enum"],
            json!(["1m", "5m", "15m", "1h", "1d"]));
        assert_eq!(tools[1]["name"], "get_sources_health");
        assert!(tools[1]["inputSchema"]["properties"]["window_secs"].is_object());
        assert_eq!(tools[2]["name"], "get_data_quality", "MCP④ 数据质量（范围④）");
        assert_eq!(tools[2]["inputSchema"]["required"], json!(["code", "date"]));
        assert!(!tools.iter().any(|t| t["name"].as_str().unwrap().contains("trade")),
            "交易类工具不做（ADR-009 范围④ Wave 4）");
    }

    #[tokio::test]
    async fn get_kline_happy_path_and_defaults() {
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({ "code": "518880" })).await;
        let payload = payload_of(&r);
        assert_eq!(payload["code"], "518880");
        assert_eq!(payload["period"], "1m", "缺省 period=1m");
        let bars = payload["bars"].as_array().unwrap();
        assert_eq!(bars.len(), 2);
        assert!(bars[0]["ts"].as_str().unwrap() < bars[1]["ts"].as_str().unwrap(), "升序");
        assert_eq!(bars[0]["source"], "tencent_ifzq", "1m merge 视图带来源");
        let calls = kline.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].code, "518880", "code 透传端口");
        assert_eq!(calls[0].period, Period::M1);
        assert_eq!(calls[0].limit, DEFAULT_LIMIT, "缺省 limit=240");
        assert!(calls[0].before.is_none(), "MCP 工具无游标参数，恒取最新页");
    }

    #[tokio::test]
    async fn get_kline_limit_clamped_and_period_mapped() {
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let _ = call(&st, "get_kline",
            json!({ "code": "518880", "period": "5m", "limit": 99999 })).await;
        let calls = kline.calls.lock().unwrap();
        assert_eq!(calls[0].period, Period::M5);
        assert_eq!(calls[0].limit, MAX_LIMIT, "limit 封顶 1000（与 REST 同口径）");
    }

    #[tokio::test]
    async fn get_kline_param_validation_is_32602() {
        let st = test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()));
        for args in [json!({}), json!({ "code": "" }),
                     json!({ "code": "518880", "period": "3m" }),
                     json!({ "code": "518880", "period": "M1" }),
                     json!({ "code": "518880", "limit": "abc" })] {
            let r = call(&st, "get_kline", args.clone()).await;
            assert_eq!(r["error"]["code"], -32602, "{args} → invalid params");
            assert_eq!(r["id"], 9, "错误帧 echo 请求 id");
        }
        let r = call(&st, "no_such_tool", json!({})).await;
        assert_eq!(r["error"]["code"], -32602, "未知工具 → -32602");
    }

    #[tokio::test]
    async fn get_kline_port_failure_is_tool_error_not_protocol_error() {
        let st = test_state(Arc::new(MockKline::failing()), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({ "code": "518880" })).await;
        assert_eq!(r["result"]["isError"], true, "端口失败 → isError=true（非 JSON-RPC 错误帧）");
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("mock kline failure"));
    }

    #[tokio::test]
    async fn get_sources_health_happy_and_window_clamp() {
        let events = Arc::new(MockEvents::new());
        let st = test_state(Arc::new(MockKline::new()), events.clone());
        let r = call(&st, "get_sources_health", json!({})).await;
        let payload = payload_of(&r);
        assert_eq!(payload["window_secs"], 3600, "缺省窗口 = 配置默认");
        let srcs = payload["sources"].as_array().unwrap();
        assert_eq!(srcs[0]["source"], "mock_src");
        assert_eq!(srcs[0]["success_rate"], 1.0);
        assert_eq!(srcs[0]["status"], "healthy");

        let _ = call(&st, "get_sources_health", json!({ "window_secs": 1 })).await;
        assert_eq!(events.windows.lock().unwrap()[1], MIN_WINDOW_SECS,
            "窗口下限钳制 60（与 REST 同口径）");
        let r = call(&st, "get_sources_health", json!({ "window_secs": "abc" })).await;
        assert_eq!(r["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn get_sources_health_failure_is_tool_error() {
        let st = test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::failing()));
        let r = call(&st, "get_sources_health", json!({})).await;
        assert_eq!(r["result"]["isError"], true);
    }

    #[tokio::test]
    async fn call_tool_requires_params_and_name() {
        let st = test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()));
        let r = call_tool(&st, Some(json!(1)), None).await;
        assert_eq!(r["error"]["code"], -32602, "缺 params");
        let r = call_tool(&st, Some(json!(1)), Some(json!({}))).await;
        assert_eq!(r["error"]["code"], -32602, "缺 name");
    }

    // ── Wave 2 Phase A：MCP④ get_data_quality ──

    fn quality_state(rows: Vec<domain::ports::DivergenceRow>,
                     raw: std::collections::HashMap<(String, chrono::NaiveDate),
                         std::collections::HashSet<DateTime<Utc>>>,
                     holidays: std::collections::HashSet<chrono::NaiveDate>) -> Arc<McpState> {
        Arc::new(McpState {
            kline: Arc::new(MockKline::new()),
            health: diagnose::health::HealthService::new(Arc::new(MockEvents::new())),
            quality: crate::mocks::quality_for(rows, raw, holidays),
            default_window_secs: 3600,
            sessions: crate::state::SessionRegistry::default(),
        })
    }

    #[tokio::test]
    async fn get_data_quality_happy_path() {
        let day = chrono::NaiveDate::from_ymd_opt(2026, 9, 3).unwrap(); // 周四交易日
        // 缺口造数：raw 已有全 241 标签除 10:41；对照行 1 条 +1.0% 分歧
        let mut raw = std::collections::HashMap::new();
        let set: std::collections::HashSet<_> = domain::calendar::trading_minute_labels(day)
            .into_iter()
            .filter(|l| l.time() != domain::calendar::hm(10, 41))
            .map(domain::tz::cst_to_utc).collect();
        raw.insert(("518880".to_string(), day), set);
        let rows = vec![domain::ports::DivergenceRow {
            ts: domain::tz::cst_to_utc(day.and_hms_opt(9, 30, 0).unwrap()),
            code: "518880".into(), raw_close: 10.1, accurate_close: 10.0,
            raw_source: Some("tencent_ifzq".into()) }];
        let st = quality_state(rows, raw, std::collections::HashSet::new());
        let r = call(&st, "get_data_quality", json!({ "code": "518880", "date": "2026-09-03" })).await;
        let p = payload_of(&r);
        assert_eq!(p["code"], "518880");
        assert_eq!(p["date"], "2026-09-03");
        assert_eq!(p["trading_day"], true);
        assert_eq!(p["gap"]["missing_bars"], 1);
        assert_eq!(p["gap"]["expected_bars"], 241);
        assert_eq!(p["gap"]["segments"][0]["class"], "system_gap", "邻近无事件 → 系统缺口");
        assert!(p["gap"]["segments"][0]["start"].as_str().unwrap().contains("T10:41"));
        assert_eq!(p["divergence"]["compared_bars"], 1);
        assert_eq!(p["divergence"]["divergent_bars"], 1, "+1.0% > 0.5% 默认阈值");
    }

    #[tokio::test]
    async fn get_data_quality_holiday_and_param_validation() {
        // 节假日：trading_day=false + gap=null + 零对照
        let mut hol = std::collections::HashSet::new();
        hol.insert(chrono::NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()); // 国庆
        let st = quality_state(vec![], std::collections::HashMap::new(), hol);
        let r = call(&st, "get_data_quality", json!({ "code": "518880", "date": "2026-10-01" })).await;
        let p = payload_of(&r);
        assert_eq!(p["trading_day"], false, "国庆非交易日");
        assert!(p["gap"].is_null());
        assert_eq!(p["divergence"]["compared_bars"], 0);

        // 参数校验 → -32602
        let st = test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()));
        for args in [json!({ "date": "2026-09-03" }),                  // 缺 code
                     json!({ "code": "518880" }),                       // 缺 date
                     json!({ "code": "", "date": "2026-09-03" }),      // code 空
                     json!({ "code": "518880", "date": "2026/09/03" }), // 非法日期
                     json!({ "code": "518880", "date": "2026-9-3" })] {
            let r = call(&st, "get_data_quality", args.clone()).await;
            assert_eq!(r["error"]["code"], -32602, "{args} → invalid params");
        }
    }
}
```

``` {.rust file=crates/mcp/src/mocks.rs}
//! 测试替身（仅 #[cfg(test)] 单测用）：mock domain 只读端口装配 McpState——
//! 证明 mcp 与 storage 解耦（分层红线；真实装配由 tests/mcp_tools_db.rs 经 storage 实现锁定）。

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use domain::ports::{
    Clock, DivergenceRow, HealthEventRow, HealthEventsRangeRead, HealthEventsRead,
    HolidayCalendarRead, KlineBarView, KlineRead, QualityRead, RawBarReader, SyncCheckpointView,
    SymbolLatestView, TushareStatusRead,
};
use domain::types::{Code, Period};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::state::McpState;

/// bars 调用记录（断言参数映射/钳制）。
#[derive(Debug, Clone)]
pub struct BarsCall {
    pub period: Period,
    pub code: String,
    pub before: Option<DateTime<Utc>>,
    pub limit: i64,
}

/// mock KlineRead：记录调用参数；正常返回两根升序 1m bar（source=tencent_ifzq）；failing → Err。
pub struct MockKline {
    pub calls: Mutex<Vec<BarsCall>>,
    pub fail: bool,
}

impl MockKline {
    pub fn new() -> Self { Self { calls: Mutex::new(vec![]), fail: false } }
    pub fn failing() -> Self { Self { calls: Mutex::new(vec![]), fail: true } }
}

/// 两根升序样例 bar（收盘 1.00 / 1.05）。
pub fn sample_bars(code: &str) -> Vec<KlineBarView> {
    let base = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap();
    (0..2i64).map(|i| KlineBarView {
        code: code.into(),
        ts: base + Duration::minutes(i),
        open: 1.0, high: 1.1, low: 0.9, close: 1.0 + i as f64 * 0.05,
        volume: 100, amount: 105.0, source: Some("tencent_ifzq".into()),
    }).collect()
}

#[async_trait::async_trait]
impl KlineRead for MockKline {
    async fn bars(&self, period: Period, code: &str,
                  before: Option<DateTime<Utc>>, limit: i64)
        -> anyhow::Result<Vec<KlineBarView>> {
        self.calls.lock().expect("calls poisoned")
            .push(BarsCall { period, code: code.into(), before, limit });
        if self.fail { anyhow::bail!("mock kline failure"); }
        Ok(sample_bars(code))
    }

    async fn symbols_with_latest(&self) -> anyhow::Result<Vec<SymbolLatestView>> { Ok(vec![]) }
}

/// mock HealthEventsRead：记录窗口参数；正常返回一条 mock_src 成功事件；failing → Err。
pub struct MockEvents {
    pub windows: Mutex<Vec<i64>>,
    pub fail: bool,
}

impl MockEvents {
    pub fn new() -> Self { Self { windows: Mutex::new(vec![]), fail: false } }
    pub fn failing() -> Self { Self { windows: Mutex::new(vec![]), fail: true } }
}

#[async_trait::async_trait]
impl HealthEventsRead for MockEvents {
    async fn window_events(&self, window_secs: i64) -> anyhow::Result<Vec<HealthEventRow>> {
        self.windows.lock().expect("windows poisoned").push(window_secs);
        if self.fail { anyhow::bail!("mock events failure"); }
        Ok(vec![HealthEventRow {
            ts: Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap(),
            source: "mock_src".into(), ok: true, latency_ms: Some(80),
            err_kind: None, code: None,
        }])
    }
}

// ── Wave 2 Phase A：质量端口 mock（MCP④ get_data_quality 测试）──

struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock { fn now(&self) -> DateTime<Utc> { self.0 } }

/// mock QualityRead：返回预设对照行（可按 code 过滤）。
pub struct MockQualityRows(pub Vec<DivergenceRow>);

#[async_trait::async_trait]
impl QualityRead for MockQualityRows {
    async fn divergence_rows(&self, code: Option<&str>, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<DivergenceRow>> {
        Ok(self.0.iter().filter(|r| code.is_none_or(|c| r.code == c)).cloned().collect())
    }
}

/// mock RawBarReader：按 (code, date) 返回预设已有 ts 集合。
pub struct MockRawDays(pub HashMap<(String, NaiveDate), HashSet<DateTime<Utc>>>);

#[async_trait::async_trait]
impl RawBarReader for MockRawDays {
    async fn existing_ts(&self, code: &Code, date: NaiveDate)
        -> anyhow::Result<HashSet<DateTime<Utc>>> {
        Ok(self.0.get(&(code.0.clone(), date)).cloned().unwrap_or_default())
    }
}

/// mock HealthEventsRangeRead：恒空（缺口分类走 SystemGap 路径）。
pub struct MockRangeEvents;

#[async_trait::async_trait]
impl HealthEventsRangeRead for MockRangeEvents {
    async fn events_between(&self, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(vec![])
    }
}

/// mock HolidayCalendarRead：预设节假日集合。
pub struct MockHolidays(pub HashSet<NaiveDate>);

#[async_trait::async_trait]
impl HolidayCalendarRead for MockHolidays {
    async fn holidays(&self) -> anyhow::Result<HashSet<NaiveDate>> { Ok(self.0.clone()) }
}

/// mock TushareStatusRead：恒空检查点。
pub struct MockTushareStatus;

#[async_trait::async_trait]
impl TushareStatusRead for MockTushareStatus {
    async fn sync_checkpoints(&self) -> anyhow::Result<Vec<SyncCheckpointView>> { Ok(vec![]) }
}

/// 装配质量服务（mock 端口；时钟固定 2026-09-04 12:00 CST = 04:00 UTC——历史日全到期）。
pub fn quality_for(rows: Vec<DivergenceRow>,
                   raw: HashMap<(String, NaiveDate), HashSet<DateTime<Utc>>>,
                   holidays: HashSet<NaiveDate>) -> diagnose::quality::QualityService {
    diagnose::quality::QualityService::new(
        Arc::new(MockQualityRows(rows)), Arc::new(MockRawDays(raw)), Arc::new(MockRangeEvents),
        Arc::new(MockHolidays(holidays)), Arc::new(MockTushareStatus),
        Arc::new(FixedClock(Utc.with_ymd_and_hms(2026, 9, 4, 4, 0, 0).unwrap())))
}

/// 装配测试用 McpState（default_window_secs=3600；质量服务默认空口径）。
pub fn test_state(kline: Arc<MockKline>, events: Arc<MockEvents>) -> Arc<McpState> {
    Arc::new(McpState {
        kline,
        health: diagnose::health::HealthService::new(events),
        quality: quality_for(vec![], HashMap::new(), HashSet::new()),
        default_window_secs: 3600,
        sessions: crate::state::SessionRegistry::default(),
    })
}
```

``` {.rust file=crates/mcp/src/server.rs}
//! MCP HTTP/SSE 传输（spec 2024-11-05 SSE transport，ADR-009）：
//! - GET  /sse → text/event-stream 长连接：首帧 `event: endpoint`（data=/messages?sessionId=<32hex>），
//!   随后每个 JSON-RPC 响应为 `event: message` 帧；15s 保活注释帧（:ka，防代理空闲断连）；
//!   连接断开即注销会话（SessionGuard drop——连接泄漏防护，父级裁决口径）。
//! - POST /messages?sessionId=<id> → 202 Accepted（响应经 SSE 流异步下发；通知无响应也 202）；
//!   缺 sessionId → 400；未知/已关闭会话 → 404；会话通道溢出 → 410。
//!
//! 免认证（ADR-010 内网）；端口独立（默认 8082，配置化，见 00-web-api §5 app_config）。

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::StreamExt;

use crate::rpc;
use crate::state::{McpState, SessionRegistry};

/// SSE 保活间隔（秒）。
pub const KEEPALIVE_SECS: u64 = 15;
/// 会话消息通道容量（溢出即 410，客户端重连重建会话兜底）。
pub const SESSION_CHANNEL_CAP: usize = 64;

/// 路由装配（DI 入口；state 由 app crate 注入）。
pub fn build_router(state: Arc<McpState>) -> Router {
    Router::new()
        .route("/sse", get(sse_handler))
        .route("/messages", post(post_message))
        .with_state(state)
}

/// 常驻服务入口（eestock-app 同进程 spawn；端口独立，ADR-009）。
pub async fn serve(state: Arc<McpState>, listen: &str) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!(listen = %listen, "mcp server (HTTP/SSE) serving");
    axum::serve(listener, build_router(state)).await?;
    Ok(())
}

async fn sse_handler(State(st): State<Arc<McpState>>) -> Response {
    let (id, rx) = st.sessions.create(SESSION_CHANNEL_CAP);
    tracing::info!(session = %id, "mcp sse session opened");
    let stream = sse_stream(&st, id, rx);
    (
        [(header::CONTENT_TYPE, "text/event-stream"),
         (header::CACHE_CONTROL, "no-cache")],
        Body::from_stream(stream),
    ).into_response()
}

/// SSE 帧流：endpoint 首帧 → (message | keepalive) 合并流；guard 随流 drop 注销会话。
fn sse_stream(st: &McpState, id: String, rx: tokio::sync::mpsc::Receiver<String>)
    -> impl tokio_stream::Stream<Item = Result<axum::body::Bytes, Infallible>>
{
    let endpoint = tokio_stream::once(
        format!("event: endpoint\ndata: /messages?sessionId={id}\n\n"));
    let messages = tokio_stream::wrappers::ReceiverStream::new(rx)
        .map(|m| format!("event: message\ndata: {m}\n\n"));
    let ka = tokio::time::interval_at(
        tokio::time::Instant::now() + std::time::Duration::from_secs(KEEPALIVE_SECS),
        std::time::Duration::from_secs(KEEPALIVE_SECS));
    let keepalive = tokio_stream::wrappers::IntervalStream::new(ka)
        .map(|_| ":ka\n\n".to_string());
    let guard = SessionGuard { sessions: st.sessions.clone(), id };
    endpoint
        .chain(messages.merge(keepalive))
        .map(move |frame| { let _guard = &guard; Ok(axum::body::Bytes::from(frame)) })
}

/// 会话清理哨兵：SSE 流被 drop（客户端断开/服务关闭）即注销会话（连接泄漏防护）。
struct SessionGuard {
    sessions: SessionRegistry,
    id: String,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.sessions.remove(&self.id);
        tracing::info!(session = %self.id, "mcp sse session closed");
    }
}

/// POST /messages 查询参数（MCP SSE transport 口径：sessionId camelCase）。
#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

/// POST /messages：解析 JSON-RPC → dispatch → 响应经会话通道下发 SSE；通知（无响应）也 202。
async fn post_message(State(st): State<Arc<McpState>>, Query(q): Query<MessagesQuery>,
                      body: String) -> Response {
    let Some(sid) = q.session_id.filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "sessionId 必填").into_response();
    };
    let Some(tx) = st.sessions.sender(&sid) else {
        return (StatusCode::NOT_FOUND, "未知或已关闭会话").into_response();
    };
    let resp = match serde_json::from_str::<rpc::RpcRequest>(&body) {
        Ok(req) => rpc::dispatch(&st, &req).await,
        Err(_) => Some(rpc::result_err(None, rpc::PARSE_ERROR, "parse error: 非法 JSON-RPC 帧")),
    };
    if let Some(resp) = resp {
        if tx.try_send(resp.to_string()).is_err() {
            return (StatusCode::GONE, "会话通道已满或已关闭，请重连 /sse").into_response();
        }
    }
    StatusCode::ACCEPTED.into_response()
}
```

## 3. 测试

### 3.1 协议级集成测试（无 DB；mock 端口，锁定传输 + JSON-RPC 帧行为）

经真实 HTTP server + 真实 SSE 流：initialize/tools/list/tools/call 全链路、SSE 帧格式
（endpoint 首帧 + message 帧）、通知 202 无响应、未知方法 -32601、未知会话 404、缺 sessionId 400、
断连会话注销（连接泄漏防护断言）。

``` {.rust file=crates/mcp/tests/mcp_protocol.rs}
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

    // 3. tools/list → 三个只读工具（ADR-009 范围①② Wave 1 + 范围④ Wave 2 Phase A）
    let status = post(&http, &base, &client.endpoint, &json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    assert_eq!(status, 202);
    let resp = next_resp(&mut client).await;
    let tools = resp["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 3, "通知无响应帧——本帧即 tools/list 响应（帧序锁定）");
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
```

### 3.2 工具数据通路集成测试（需 TimescaleDB :5433；真实 storage 端口实现）

锁定「merge 视图准确层优先」与「源健康聚合口径」经 MCP 工具端到端成立；
传输层已由 §3.1 锁定，本文件直调 `rpc::dispatch`（免 SSE 夹具重复）。

``` {.rust file=crates/mcp/tests/mcp_tools_db.rs}
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
```

## 4. eestock-app 装配与部署（加法扩展；代码块维护在 00-web-api.md）

tangle 单属主原则：`crates/app/**` 与 `Dockerfile.app` 的代码块属主是 00-web-api.md，本节只记口径：

- **app_config.rs**：新增 `mcp_listen: String`（默认 `0.0.0.0:8082`，env `MCP_LISTEN` 覆盖；
  仅监听局域网——容器内 0.0.0.0，宿主机暴露由 compose 控制，免认证 ADR-010）。
- **eestock-app.rs**：web state 装配后追加——`McpState { kline: state.kline.clone(),
  health: HealthService::new(health_events), quality: state.quality.clone()（Wave 2 Phase A）,
  default_window_secs: cfg.health_window_secs, .. }`
  （与 web **同进程**、复用同一 `KlineRead`/`HealthEventsRead` 端口实现实例与 `QualityService`；
  **端口独立** 8082），`tokio::spawn(mcp::server::serve(...))`。
- **Dockerfile.app**：`EXPOSE 8081 8082`。
- **手写例外**：`docker-compose.yml` app 服务加 `"8082:8082"`；`config/app.toml.example` 加
  `mcp_listen` 行；`crates/app/Cargo.toml` 加 `mcp = { path = "../mcp" }`；`crates/mcp/Cargo.toml`
  正常依赖 = domain/diagnose/axum/tokio-stream(sync)/serde/serde_json/chrono/tokio/tracing/anyhow/rand，
  dev 依赖 = storage/sqlx/reqwest/async-trait（分层红线同 web 口径）。

## 5. TDD 规格要点（Red-Green 记录）

- state：会话生命周期（create→sender→remove→404）、32hex 唯一 id。
- rpc：initialize 三要素（protocolVersion/capabilities.tools/serverInfo）、id echo（string/number）、
  通知无响应、未知方法 -32601、tools/list·tools/call 路由（mock 端口，无 DB）。
- tools：schema 契约（三工具、required 与 enum、无交易类工具）；get_kline 缺省
  period=1m/limit=240、limit 封顶 1000、升序、source 透传、参数错误 -32602 矩阵、未知工具 -32602、
  端口失败 isError=true；get_sources_health 缺省窗口=配置默认、窗口钳制 60、聚合字段、失败 isError=true；
  **get_data_quality（Wave 2 Phase A）**：缺口卡 + 分歧汇总 + 节假日 trading_day=false、
  code/date 参数校验 -32602 矩阵。
- server/协议级（无 DB）：SSE content-type 与 endpoint 首帧、POST 202 + 响应经 SSE message 帧下发、
  initialize/tools/list/tools/call 全链路、通知 202 无事件、未知方法 -32601 帧、未知会话 404、
  缺 sessionId 400、断连后会话注销（泄漏防护）。
- 工具数据通路（真实库 :5433）：merge 准确层优先、健康聚合 0.75/degraded/last_error——
  与 web REST 同端口同口径（storage 端口实现复用，零新 SQL）。
