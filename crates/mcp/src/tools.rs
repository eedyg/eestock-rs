// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/tools.rs>>[init]
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
// ~/~ end
