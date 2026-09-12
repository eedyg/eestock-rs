// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/tools.rs>>[init]
// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/tools.rs>>[init]
// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/tools.rs>>[init]
//! MCP 工具实现（ADR-009 范围①②）：
//! - get_kline(code, period, limit)：merge 视图准确层优先（经 domain::ports::KlineRead）；
//!   I-1（P0）修复：**未注册代码 → isError**（以平台 symbols 注册表判定，不以「有无 K 线」推断）
//! - get_sources_health(window_secs?)：源健康卡片数据（经 diagnose::health::HealthService）
//!
//! 参数校验失败 → -32602（协议层）；端口/聚合执行失败 → result.isError=true（MCP 工具错误惯例）。
//! 交易类工具不做（ADR-009 范围④ Wave 4，独立开关默认关）。
//! 12-strategy-system / P3c：strategy_*（统一策略系统 Registry，经 StrategyService）+
//! bt_*（回测工作台任务，经 WorkbenchService）——落现有 SSE server（ADR §13.7，无 transport 迁移）。

use chrono::{DateTime, TimeZone, Utc};
use domain::types::Period;
use serde::Serialize;
use serde_json::{json, Value};

use crate::rpc::{result_err, result_ok, INVALID_PARAMS};
use crate::state::McpState;
// 11-sim-live / L1：模拟实盘工具（sim_*；经 application::SimLiveService，非真实券商）
use application::simlive::{PlaceOrderReq, SimLiveService, StartSessionReq, StrategyConfigInput};
// 12-strategy-system / P3c：统一策略系统工具族（strategy_*：StrategyService；bt_*：WorkbenchService）
use application::strategy::{
    CreateStrategyInput, StrategyService, TestRunMode, TestRunRequest, TestRunSource,
    UpdateDraftOutcome,
};
use application::workbench::{SlotReq, SubmitRunReq, WorkbenchService};
use domain::ports::StrategyRunStatus;
use domain::strategy_state::{ApprovalLevel, StrategyKind};
use std::sync::Arc;

/// limit 上限/缺省（与 REST /api/kline 同口径，07 §1.1）。
/// I-10/I-5（D2）：上限 1000→10000（M15 最大窗口 1188 根 > 旧上限）；超上限**不再静默封顶**。
pub const MAX_LIMIT: i64 = 10000;
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
    json!({ "tools": tool_schemas() })
}

/// 全部工具 schema（每工具独立 json! 构造——32 工具单宏展开会触 serde_json 递归上限）。
fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "get_kline",
            "description": "查询标的 K 线（1m 为 merge 视图：准确层优先、raw 补缺；5m/15m/1d 连续聚合；1h 由 15m rollup）。bars 升序返回。code 须为平台已注册标的：未注册 → isError（与「已注册但区间无数据」的空 bars 区分）。I-5/I-10（D2）：可选 from/to 区间（ISO 日期 Asia/Shanghai 日界 或 RFC3339；from 闭、to 开），limit 上限 10000。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "6 位标的代码，如 518880（须为平台已注册标的）" },
                    "period": { "type": "string", "enum": ["1m", "5m", "15m", "1h", "1d"], "description": "周期，默认 1m" },
                    "from": { "type": "string", "description": "区间起点（闭）：YYYY-MM-DD（Asia/Shanghai 日界）或 RFC3339" },
                    "to": { "type": "string", "description": "区间终点（开）：YYYY-MM-DD（含 to 整日）或 RFC3339" },
                    "limit": { "type": "integer", "description": "根数，默认 240，上限 10000（超上限 → 参数错误并提示分段取数）" }
                },
                "required": ["code"]
            }
        }),
        json!({
            "name": "get_sources_health",
            "description": "数据源健康卡片：窗口成功率（分母排除 na）/延迟分位数/熔断态/状态灯/最近错误。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "window_secs": { "type": "integer", "description": "统计窗口秒数，默认 3600，钳制 60..604800" }
                }
            }
        }),
        json!({
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
        }),
        json!({
            "name": "list_symbols",
            "description": "统一策略系统 Registry：返回平台 symbols 注册表全部标的（含 enabled=false 的停用标的；与 web GET /api/symbols 同源同字段）：code/name/type/interval_secs/settlement/enabled + 数据可用区间（latest={ts,last,change_pct}，无 bar → null）。`type`=ADR-019 D11-1 标的类型（etf/lof/stock；null=未设置），决定试算/回测省略 fee 时的费率推断。按 code 升序（确定性输出）。适用场景：调用方选标的（get_kline / strategy_test_run / bt_run_ensemble）。",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "sim_start_session",
            "description": "模拟实盘，不触真实券商：开启模拟会话（name/period 必填；cash_init 默认 1000000）。⚠️ P4a 破坏性 wire 变更（系统 pre-1.0）：策略源切换为统一策略系统 Registry——strategies 元素为 {strategy_id, version_id?, params, stocks, weight, stock_weights?}（strategy_id=Registry 策略 id（st_ 前缀），version_id 缺省=最新 published；旧内建 id（dual_ma 等 7 款）不再接受，请先用 strategy_list 查询可用策略；无 published 版本 → isError）。若提供 strategies 按每策略参数/标的集/权重钉住 published 版本建插件实例，否则回退 strategy_set × stock_set（strategy_set 元素=Registry strategy_id，默认参数、weight=1）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "period": { "type": "string", "enum": ["M1", "M5", "M15", "D1"], "description": "周期" },
                    "cash_init": { "type": "number", "description": "初始资金，默认 1000000" },
                    "strategy_set": { "type": "array", "items": { "type": "string" }, "description": "P4a：元素为 Registry strategy_id（st_ 前缀），非旧内建 id" },
                    "stock_set": { "type": "array", "items": { "type": "string" } },
                    "buy_long_threshold": { "type": "number", "description": "聚合做多阈值（可选，默认 60；会话级钉住，回测对比同源；须 > 50 且 > sell_threshold——夹中立 50 契约）" },
                    "sell_threshold": { "type": "number", "description": "聚合卖出阈值（可选，默认 40；须 < 50 且 < buy_long_threshold——夹中立 50 契约）" },
                    "strategies": { "type": "array", "description": "可选：每策略配置（P4a 新 wire：strategy_id/version_id?/params/stocks/weight/stock_weights?），覆盖 strategy_set×stock_set 简单档", "items": { "type": "object", "properties": { "strategy_id": { "type": "string", "description": "Registry 策略 id（st_ 前缀；strategy_list 可查）" }, "version_id": { "type": "string", "description": "钉住版本 id（sv_ 前缀；缺省=最新 published）" }, "params": { "type": "object", "description": "策略参数（按版本 params_schema，缺省填充）" }, "stocks": { "type": "array", "items": { "type": "string" }, "description": "该策略标的子集（须非空 ≤30）" }, "weight": { "type": "number", "description": "聚合权重，>0，默认 1.0" }, "stock_weights": { "type": "object", "description": "策略×股票级权重（可选；未指定的股用 weight）" } }, "required": ["strategy_id", "stocks"] } },
                    "source": { "type": "string", "description": "mcp/web/preset/manual" }
                },
                "required": ["name", "period"]
            }
        }),
        json!({
            "name": "sim_stop_session",
            "description": "模拟实盘，不触真实券商：停止会话并落库结束结果（净值/成交/指标）。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "sim_get_account",
            "description": "模拟实盘，不触真实券商：查询会话账户（现金/净值/市值/已实现+未实现盈亏/费用）。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "sim_get_positions",
            "description": "模拟实盘，不触真实券商：查询会话持仓（code/qty/avg_cost/latest/市值/盈亏）。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "sim_get_orders",
            "description": "模拟实盘，不触真实券商：查询会话订单（含 pending/filled/cancelled）。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "sim_get_pnl",
            "description": "模拟实盘，不触真实券商：查询会话已实现/未实现盈亏与费用。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "sim_place_order",
            "description": "模拟实盘，不触真实券商：下模拟单（市价按 price 即时成交；限价 price 触及成交；滑点/费用按 FeeModel）。price 为模拟行情最新价。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string" },
                    "code": { "type": "string" },
                    "side": { "type": "string", "enum": ["buy", "sell"] },
                    "qty": { "type": "number" },
                    "price": { "type": "number", "description": "模拟行情最新价（成交参考价）" },
                    "limit_price": { "type": "number" },
                    "intent_id": { "type": "string", "description": "幂等键（同 intent 不重复执行）" },
                    "source": { "type": "string" }
                },
                "required": ["session_id", "code", "side", "qty", "price"]
            }
        }),
        json!({
            "name": "sim_cancel_order",
            "description": "模拟实盘，不触真实券商：撤除未成交（pending）模拟单；已成交/未知单返回 false。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string" },
                    "order_id": { "type": "string" }
                },
                "required": ["session_id", "order_id"]
            }
        }),
        json!({
            "name": "sim_list_strategies",
            "description": "模拟实盘，不触真实券商：策略目录（⚠️ P4a 数据源切换为统一策略系统 Registry catalog——仅 published 策略的最新 published 版本，{strategy, version} 条目；旧内置 7 款目录废止。与 strategy_list 同源，供 sim_start_session 策略选择）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "strategy_id": { "type": "string", "description": "可选：仅返回指定策略" }
                }
            }
        }),
        json!({
            "name": "sim_get_strategy_signal",
            "description": "模拟实盘，不触真实券商：查询单标的当前策略信号（聚合分 + 各策略独立分 + 信号/最新价）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string" },
                    "code": { "type": "string", "description": "6 位标的代码" }
                },
                "required": ["session_id", "code"]
            }
        }),
        json!({
            "name": "sim_get_strategy_analysis",
            "description": "模拟实盘，不触真实券商：多标的评估概览（每标的聚合分 + 各策略独立分）。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "sim_list_sessions",
            "description": "模拟实盘，不触真实券商：历史会话列表（已结束；含周期/策略集/标的数/净收益/最大回撤/夏普摘要指标）。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "sim_get_session",
            "description": "模拟实盘，不触真实券商：会话详情回看（元数据 + 结束结果：净值/交易/指标）。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "sim_run_backtest_compare",
            "description": "模拟实盘，不触真实券商：「回测一下」对比（⚠️ P4a 口径变化：切换为统一 ensemble 引擎——会话每标的 1 个 ensemble run，slots=覆盖该标的的钉住策略版本，阈值=会话钉住阈值，LumpSum 全仓+会话费用口径；评分语义与 sim-live 一致，但与切源前历史对比结果绝对值不可直接比）。异步：返回 run_ids（sr_ 前缀字符串，调用方轮询 bt_get_run 完成）+ 会话自身结束结果。",
            "inputSchema": {
                "type": "object",
                "properties": { "session_id": { "type": "string" } },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "strategy_list",
            "description": "统一策略系统 Registry：查询已发布策略目录（catalog，仅 published 版本入册，每策略取最新 published；level 为权限分级 at-least 过滤，kind 精确过滤）。适用场景：为 strategy_test_run / bt_run_ensemble 挑选策略与版本（与 web 下拉同源）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "level": { "type": "string", "enum": ["backtest_ok", "sim_ok", "live_approved"], "description": "权限分级 at-least 过滤（缺省不过滤）" },
                    "kind": { "type": "string", "enum": ["strategy", "template"], "description": "类别过滤（缺省不过滤）" },
                    "include_source": { "type": "boolean", "description": "I-7（D5）：默认 false 只回摘要（version 不含 code，体积小）；true 显式返回全量源码" }
                }
            }
        }),
        json!({
            "name": "strategy_get",
            "description": "统一策略系统 Registry：策略详情 + 全部版本列表（version 升序，含 status/approval_level/sha256/published_at）。适用场景：查看版本演化、挑选运行/试算版本。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "strategy_id": { "type": "string", "description": "策略 id（st_ 前缀）" }
                },
                "required": ["strategy_id"]
            }
        }),
        json!({
            "name": "strategy_create",
            "description": "统一策略系统 Registry：新建策略（v1 draft；QuickJS 插件源码，params_schema 从代码 PARAMS_SCHEMA 提取；随后 strategy_update 改代码、strategy_publish 过门禁发布）。params 仅作提示，创建不持久化（Registry 不存实例参数，试算/运行时传入）。适用场景：agent 自动建策略。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "策略名（非空）" },
                    "description": { "type": "string", "description": "描述（可空）" },
                    "kind": { "type": "string", "enum": ["strategy", "template"], "description": "类别，默认 strategy" },
                    "code": { "type": "string", "description": "QuickJS 插件源码（须含 on_bar(ctx)；可选 PARAMS_SCHEMA 声明）" },
                    "params": { "type": "object", "description": "提示用参数（不持久化；试算/运行时传入）" }
                },
                "required": ["name", "code"]
            }
        }),
        json!({
            "name": "strategy_update",
            "description": "统一策略系统 Registry：编辑版本代码。draft 原地更新（outcome=updated）；published 自动落新 draft（outcome=new_draft，版本号+1，ADR §13.5 防呆）；archived 拒绝（isError）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "version_id": { "type": "string", "description": "版本 id（sv_ 前缀）" },
                    "code": { "type": "string", "description": "新插件源码" }
                },
                "required": ["version_id", "code"]
            }
        }),
        json!({
            "name": "strategy_publish",
            "description": "统一策略系统 Registry：发布版本（draft→published）。发布门禁：QuickJS 真实实例化冒烟（eval + on_bar + PARAMS_SCHEMA + init(defaults)），不过 → isError；published 不可变，可被 bt_run_ensemble 运行。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "version_id": { "type": "string", "description": "版本 id（sv_ 前缀，须 draft）" }
                },
                "required": ["version_id"]
            }
        }),
        json!({
            "name": "strategy_archive",
            "description": "统一策略系统 Registry：归档版本（published→archived，单向；归档后不再入 catalog，历史 run 钉住快照不受影响）。适用场景：下线旧版本。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "version_id": { "type": "string", "description": "版本 id（sv_ 前缀，须 published）" }
                },
                "required": ["version_id"]
            }
        }),
        json!({
            "name": "strategy_test_run",
            "description": "统一策略系统 Registry：在线试算（同步，单标的区间）。双模式：pure_score 裸评分（position 恒 null，看原始反应）/ sim_position 模拟持仓（默认 60/40 阈值 + LumpSum 全仓 + 默认费用，逐 bar 信号+成交）。code 内联源码与 version_id 已存版本二选一（恰一个）。区间上限：D1/H1≤5年 / 分钟级≤3个月。适用场景：发布前验证插件行为/调参。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "内联插件源码（与 version_id 二选一）" },
                    "version_id": { "type": "string", "description": "已存版本 id（sv_ 前缀；draft/published 均可试算）" },
                    "symbol": { "type": "string", "description": "6 位标的代码" },
                    "period": { "type": "string", "enum": ["M1", "M5", "M15", "H1", "D1"], "description": "周期（I-6：补 H1，与数据层 cagg 1h 口径对齐）" },
                    "from": { "type": "string", "description": "区间起点 RFC3339（闭）" },
                    "to": { "type": "string", "description": "区间终点 RFC3339（开）" },
                    "mode": { "type": "string", "enum": ["pure_score", "sim_position"], "description": "试算模式" },
                    "params": { "type": "object", "description": "插件参数（按版本 schema 校验/缺省填充）" },
                    "warmup_bars": { "type": "integer", "description": "前置预热根数（I-2/D6；默认 250，0=不预热）。服务层向前多取历史后按 from 切分；历史不足时响应回显 warmup_effective < warmup_requested。" },
                    "fee": { "type": "object", "description": "{rate_pct, min_fee, slippage_bp, stamp_duty_pct?}；**省略 = 按标的 type 查 fee_profiles 解析**（ADR-019 D11-3：etf/lof 印花税不征 0、过户费 0、经手费/证管费按全佣口径已含于佣金 → 列 0；stock 印花税 0.05；type 未设/无档案 → 旧默认 {0.025, 5.0, 0.05}）。**显式对象按字段优先级（ADR-019 v1.1 R-2）**：出现的字段以其值（并校验，stamp 值域 [0,1]）为准，缺失字段逐字段回退档案→旧默认（如 UI 三键 fee 无 stamp + ETF 档案 → stamp=0）；`source` 取最高优先级来源（任一字段来自显式 → explicit，R-3）。**v1.1 补守卫**：显式对象**存在但无可识别字段**（`{}`/全未知键）→ **报错（isError，消息含可识别字段集与当前收到键）**；含 ≥1 可识别字段（rate_pct/min_fee/slippage_bp/stamp_duty_pct）即放行（缺失字段逐级回退）。响应回显**显式两段**：`fee.effective`（引擎**实际应用**参数 commission_rate_pct/min_fee/stamp_duty_pct/slippage_bp + source=explicit|profile|default）与 `fee.profile`（档案**全量事实**，含经手费/证管费/过户费 + `not_modeled` 显式清单——这三项**引擎未建模、未计入成本**，不得出现在 effective 段）。" },
                    "policy": { "type": "object", "description": "ExecutionPolicy（与 bt_run_ensemble 同 JSON 口径）：{\"LumpSum\":{\"position_pct\":0..1}} 或 {\"Dca\":{\"tranches\":..,\"mode\":..,\"amount\":..,\"interval\":..}}；缺省 LumpSum 全仓。" },
                    "capital": { "type": "number", "description": "初始资金，默认 100000（与回测 ADR §4 一致）。" }
                },
                "required": ["symbol", "period", "from", "to", "mode"]
            }
        }),
        json!({
            "name": "strategy_guide",
            "description": "统一策略系统 Registry：返回《策略编程手册》全文（markdown；include_str! 静态内嵌 design/12-strategy-system/04-strategy-programming-guide.md，与 GET /api/strategies/guide 同字节）。适用场景：编写/调试策略插件前取最新 ctx/指标/PARAMS_SCHEMA 契约。",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "bt_run_ensemble",
            "description": "回测工作台（统一策略系统 Registry 策略源）：提交多策略 ensemble 回测（异步任务，返回 run_id；bt_get_run 轮询进度/状态，进度另经 web WS 推送）。slots 1..=10，published|archived 版本可运行（archived = 审计重跑，2026-09-10 裁决：代码不可变+sha256 钉住、不触真实资金；config 快照钉住 archived 审计标记；draft 未发布不可运行）；version_id 缺省 = 该策略最新 published（catalog 解析）。fee **省略 = 按标的 type 查 fee_profiles 解析**（ADR-019 D11-3：etf/lof 印花税不征 0、过户费免收 0；stock 印花税 0.05；type 未设/无档案 → 旧默认 {0.025,5.0,0.05}），**显式对象按字段优先级**（ADR-019 v1.1 R-2：出现字段优先，缺失字段逐字段回退档案→旧默认）；**生效 fee 以扁平形态钉入 config 快照**（`fee_model_to_json`：`{rate_pct,min_fee,slippage_bp,stamp_duty_pct}`，R-1——预设往返/前端读取兼容），响应回显分 `effective`（引擎实际应用参数 + source=explicit|profile|default）与 `profile`（档案全量事实 + `not_modeled` 显式未建模清单）两段。适用场景：策略组合历史表现验证/参数与阈值对比。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "运行名（可空）" },
                    "symbol": { "type": "string", "description": "6 位标的代码（须已注册启用）" },
                    "period": { "type": "string", "enum": ["M1", "M5", "M15", "H1", "D1"], "description": "周期（I-6：补 H1，与数据层 cagg 1h 口径对齐）" },
                    "from": { "type": "string", "description": "区间起点 RFC3339（闭）" },
                    "to": { "type": "string", "description": "区间终点 RFC3339（开）；D1/H1≤5年 / 分钟级≤3个月" },
                    "slots": { "type": "array", "description": "策略槽位 1..=10", "items": { "type": "object", "properties": {
                        "strategy_id": { "type": "string", "description": "策略 id（st_ 前缀）" },
                        "version_id": { "type": "string", "description": "版本 id（缺省 = 该策略最新 published）" },
                        "weight": { "type": "number", "description": "聚合权重（>0）" },
                        "params": { "type": "object", "description": "插件参数（按版本 schema 校验/缺省填充）" }
                    }, "required": ["strategy_id", "weight"] } },
                    "buy_threshold": { "type": "number", "description": "买入阈值，默认 60" },
                    "sell_threshold": { "type": "number", "description": "卖出阈值，默认 40" },
                    "policy": { "type": "object", "description": "ExecutionPolicy：{\"LumpSum\":{\"position_pct\":0..1}} 或 {\"Dca\":{\"tranches\":..,\"mode\":..,\"amount\":..,\"interval\":..}}" },
                    "stop": { "type": "object", "description": "硬止损（可空）：{\"kind\":\"FixedPct|Trailing|Atr\", \"value\":>0, \"trigger\":\"Intrabar|CloseBasis\"}" },
                    "initial_capital": { "type": "number", "description": "初始资金，默认 100000" },
                    "fee": { "type": "object", "description": "{rate_pct, min_fee, slippage_bp, stamp_duty_pct?}；**省略 = 按标的 type 查 fee_profiles 解析**（ADR-019 D11-3：etf/lof 印花税 0/过户费 0；stock 0.05；无档案 → 旧默认）；**显式对象按字段优先级**（ADR-019 v1.1 R-2：出现字段优先，缺失字段逐字段回退档案→旧默认）；**v1.1 补守卫**：显式对象存在但**无可识别字段**（`{}`/全未知键）→ isError（消息含可识别字段集与收到键）；stamp_duty_pct 值域 [0,1]。**config 快照钉入生效 fee 的扁平形态**（R-1：`{rate_pct,min_fee,slippage_bp,stamp_duty_pct}`，不含两段结构）；两段（`effective`+source / `profile`+`not_modeled`）仅出现在试算/回测的**响应回显**。" },
                    "warmup_bars": { "type": "integer", "description": "前置预热根数（I-2/D6；默认 250，0=不预热）。服务层向前多取历史后按 from 切分；warmup 段不执行 Policy、不计净值/绩效；config 钉住 warmup_requested/effective 并逐 bar 标记 warmup。" }
                },
                "required": ["symbol", "period", "from", "to", "slots", "policy"]
            }
        }),
        json!({
            "name": "bt_get_run",
            "description": "回测工作台：查询运行状态与进度（queued/running/succeeded/failed/canceled + progress 0..1 + 钉住 config 快照）。适用场景：bt_run_ensemble 提交后轮询。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "运行 id（sr_ 前缀）" }
                },
                "required": ["run_id"]
            }
        }),
        json!({
            "name": "bt_get_run_result",
            "description": "回测工作台：读取运行结果（per_bar 各策略分+聚合分+信号+订单+事件全量 / 成交明细 / 净值 / 回撤 / 8 项绩效）。未成功或无结果 → isError（先 bt_get_run 确认 succeeded）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "运行 id（sr_ 前缀）" }
                },
                "required": ["run_id"]
            }
        }),
        json!({
            "name": "bt_list_runs",
            "description": "回测工作台：运行列表（status 过滤 + page/page_size 分页，created_at 倒序；轻量不含结果）。适用场景：挑选 compare 对象。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["queued", "running", "succeeded", "failed", "canceled"], "description": "状态过滤（缺省不过滤）" },
                    "page": { "type": "integer", "description": "页码（1 起，默认 1）" },
                    "page_size": { "type": "integer", "description": "每页条数（默认 100，封顶 500）" }
                }
            }
        }),
        json!({
            "name": "bt_cancel_run",
            "description": "回测工作台：取消运行（协作式：queued 直接落 canceled；running 下一 bar 边界生效）。终态（succeeded/failed/canceled）→ isError。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string", "description": "运行 id（sr_ 前缀）" }
                },
                "required": ["run_id"]
            }
        }),
        json!({
            "name": "bt_compare_runs",
            "description": "回测工作台：多运行对比（净值 + 绩效指标并排，按输入序；未知/未成功 run 跳过）。适用场景：参数/阈值/策略组合择优。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_ids": { "type": "array", "items": { "type": "string" }, "description": "运行 id 列表（非空）" }
                },
                "required": ["run_ids"]
            }
        }),
        json!({
            "name": "bt_list_presets",
            "description": "回测工作台：组合预设列表（命名保存的 {策略集+权重/参数, 阈值, Policy, 止损, fee}，与 sim-live 共用，保证回测↔模拟实盘配置一致）。预设 CRUD 在 web 页面，MCP 侧只读+应用。",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "bt_apply_preset",
            "description": "回测工作台：应用组合预设，返回钉住 config（slots 含 version_id/sha256/参数缺省填充）。合并 symbol/period/from/to 后即可作为 bt_run_ensemble 参数提交。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "preset_id": { "type": "string", "description": "预设 id（sp_ 前缀）" }
                },
                "required": ["preset_id"]
            }
        })
    ]
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
        "list_symbols" => list_symbols(st, id, &args).await,
        // 11-sim-live / L1：模拟实盘工具（sim_*，不触真实券商）
        "sim_start_session" => sim_start_session(st, id, &args).await,
        "sim_stop_session" => sim_stop_session(st, id, &args).await,
        "sim_get_account" => sim_get_account(st, id, &args),
        "sim_get_positions" => sim_get_positions(st, id, &args).await,
        "sim_get_orders" => sim_get_orders(st, id, &args),
        "sim_get_pnl" => sim_get_pnl(st, id, &args),
        "sim_place_order" => sim_place_order(st, id, &args).await,
        "sim_cancel_order" => sim_cancel_order(st, id, &args).await,
        "sim_list_strategies" => sim_list_strategies(st, id, &args).await,
        "sim_get_strategy_signal" => sim_get_strategy_signal(st, id, &args),
        "sim_get_strategy_analysis" => sim_get_strategy_analysis(st, id, &args),
        // 11-sim-live / L3：会话记录回看 + 回测对比
        "sim_list_sessions" => sim_list_sessions(st, id, &args).await,
        "sim_get_session" => sim_get_session(st, id, &args).await,
        "sim_run_backtest_compare" => sim_run_backtest_compare(st, id, &args).await,
        // 12-strategy-system / P3c：统一策略系统 Registry 工具（strategy_*）
        "strategy_list" => strategy_list(st, id, &args).await,
        "strategy_get" => strategy_get(st, id, &args).await,
        "strategy_create" => strategy_create(st, id, &args).await,
        "strategy_update" => strategy_update(st, id, &args).await,
        "strategy_publish" => strategy_publish(st, id, &args).await,
        "strategy_archive" => strategy_archive(st, id, &args).await,
        "strategy_test_run" => strategy_test_run(st, id, &args).await,
        "strategy_guide" => strategy_guide(st, id),
        // 12-strategy-system / P3c：回测工作台工具（bt_*）
        "bt_run_ensemble" => bt_run_ensemble(st, id, &args).await,
        "bt_get_run" => bt_get_run(st, id, &args).await,
        "bt_get_run_result" => bt_get_run_result(st, id, &args).await,
        "bt_list_runs" => bt_list_runs(st, id, &args).await,
        "bt_cancel_run" => bt_cancel_run(st, id, &args).await,
        "bt_compare_runs" => bt_compare_runs(st, id, &args).await,
        "bt_list_presets" => bt_list_presets(st, id, &args).await,
        "bt_apply_preset" => bt_apply_preset(st, id, &args).await,
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

/// 注册表成员校验（I-1 / 03-symbols §3 口径）：以平台 `symbols` 注册表为准（经
/// `KlineRead::symbols_with_latest`），**不以「是否有 K 线」推断**——未注册代码必须显式报错，
/// 否则调用方会把「标的不存在」误读为「该标的无数据」（P0 静默失败，污染策略研发结论）。
/// 注册表查询失败 → Err（fail-closed：无法确认注册即拒，与 `application::simlive` 既有口径一致）。
async fn ensure_registered(st: &McpState, code: &str) -> anyhow::Result<()> {
    let symbols = st.kline.symbols_with_latest().await
        .map_err(|e| anyhow::anyhow!("标的注册表查询失败：{e}"))?;
    if symbols.iter().any(|s| s.code == code) { return Ok(()); }
    anyhow::bail!("标的 {code} 未注册（不在平台 symbols 注册表内）——已拒绝查询；\
                   请核对代码（注册标的见 web /api/symbols）")
}

/// get_kline 边界解析（I-5/D2）：严格 ISO 日期 YYYY-MM-DD（Asia/Shanghai 当日 00:00 = UTC 前一日 16:00）
/// 或 RFC3339（归一 UTC）。非法 → None（调用方映射 -32602）。
fn parse_kline_bound(s: &str) -> Option<DateTime<Utc>> {
    if let Some(d) = parse_date_strict(s) {
        let cst = chrono::FixedOffset::east_opt(8 * 3600).expect("CST 固定偏移");
        let naive = d.and_hms_opt(0, 0, 0)?;
        return cst.from_local_datetime(&naive).single().map(|t| t.with_timezone(&Utc));
    }
    parse_rfc3339_utc(s)
}

/// get_kline(code, period=1m, from?, to?, limit=240≤10000)：merge 视图准确层优先（经 domain::ports::KlineRead）。
/// I-5/I-10（D2）：可选 from/to 区间（from 闭、to 开；ISO 日期按 Asia/Shanghai 日界，to 含整日）；
/// limit 超上限 → -32602（提示分段取数，不静默封顶）；区间内根数 > limit → 工具错误（不静默截断）。
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
            // I-10（D2）：超上限不再静默封顶 → 明确参数错误 + 分段取数提示。
            Some(n) if n > MAX_LIMIT => return result_err(id, INVALID_PARAMS,
                "limit 超上限 10000——请缩小 limit 或用 from/to 分段取数"),
            Some(n) => n.clamp(1, MAX_LIMIT),
            None => return result_err(id, INVALID_PARAMS, "limit 须为整数"),
        },
    };
    // from/to（可独立可选，I-5）：from 闭 / to 开；ISO 日期按 Asia/Shanghai 日界（to 含整日）。
    let from_raw = match args.get("from") {
        None => None,
        Some(v) => match v.as_str() {
            Some(s) => Some(s),
            None => return result_err(id, INVALID_PARAMS, "from 须为字符串（YYYY-MM-DD 或 RFC3339）"),
        },
    };
    let to_raw = match args.get("to") {
        None => None,
        Some(v) => match v.as_str() {
            Some(s) => Some(s),
            None => return result_err(id, INVALID_PARAMS, "to 须为字符串（YYYY-MM-DD 或 RFC3339）"),
        },
    };
    let from = match from_raw {
        None => None,
        Some(s) => match parse_kline_bound(s) {
            Some(t) => Some(t),
            None => return result_err(id, INVALID_PARAMS, "from 须为 YYYY-MM-DD 或 RFC3339"),
        },
    };
    let to = match to_raw {
        None => None,
        Some(s) => match parse_kline_bound(s) {
            Some(t) => Some(t),
            None => return result_err(id, INVALID_PARAMS, "to 须为 YYYY-MM-DD 或 RFC3339"),
        },
    };
    // to 含整日：ISO 日期形式 → 次日 00:00 CST（开区间上界）。
    // F1（010 验收）：**本归一必须先于下面的是否空区间判定**——否则同日 date 形式
    // （from=to=YYYY-MM-DD，应为「该日整日」）与「RFC3339 from + date to」混合形式会被误判为
    // from ≥ to；同日 date 在归一后是天然合法区间（展开后 t > f）。
    let to = match (to_raw, to) {
        (Some(s), Some(t)) if parse_date_strict(s).is_some() =>
            Some(t + chrono::Duration::days(1)),
        (_, t) => t,
    };
    // 归一后 f ≥ t = 空区间（from 闭 / to 开无任何 bar）→ 协议层参数错误；不静默返回空 bars。
    if let (Some(f), Some(t)) = (from, to) {
        if f >= t { return result_err(id, INVALID_PARAMS, "from 须早于 to"); }
    }
    // I-1（P0）：注册成员校验先于取数（参数校验之后、bars 之前）——未注册 → isError；
    // 已注册但该区间无数据 → 仍为正常空 bars（两种语义由此可区分）。
    if let Err(e) = ensure_registered(st, code).await {
        return tool_fail(id, e);
    }
    // 有 from 时多取一根以判定「区间根数 > limit」（不静默截断）。
    let fetch_limit = if from.is_some() { limit + 1 } else { limit };
    match st.kline.bars(period, code, to, fetch_limit).await {
        Ok(bars) => {
            let filtered: Vec<&domain::ports::KlineBarView> = bars.iter()
                .filter(|b| from.is_none_or(|f| b.ts >= f))
                .filter(|b| to.is_none_or(|t| b.ts < t))
                .collect();
            if from.is_some() && filtered.len() > limit as usize {
                return tool_fail(id, anyhow::anyhow!(
                    "区间内根数 {} 超 limit {limit}——请缩小 from/to 区间或分段取数",
                    filtered.len()));
            }
            let out: Vec<BarOut> = filtered.iter().take(limit as usize).map(|b| BarOut {
                ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close,
                volume: b.volume, amount: b.amount, source: b.source.clone(),
            }).collect();
            match (from, to) {
                (Some(f), Some(t)) => tool_ok(id, &json!({
                    "code": code, "period": period_s, "from": f, "to": t, "bars": out })),
                _ => tool_ok(id, &json!({ "code": code, "period": period_s, "bars": out })),
            }
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

/// list_symbols()：平台 symbols 注册表全部标的（含 enabled=false）+ 数据可用区间
/// （latest={ts,last,change_pct}；无 bar → null）+ ADR-019 D11-1 标的类型 `type`（null=未设置），
/// 按 code 升序（确定性）。
/// 与 web `GET /api/symbols` **同源**（同一 `KlineRead::symbols_with_latest` 端口）；注册表不可读 → isError（fail-closed）。
async fn list_symbols(st: &McpState, id: Option<Value>, _args: &Value) -> Value {
    match st.kline.symbols_with_latest().await {
        Ok(rows) => {
            let mut syms: Vec<Value> = rows.iter().map(|r| {
                let latest = match (r.last_ts, r.last_close) {
                    (Some(ts), Some(last)) => {
                        let change_pct = r.prev_close
                            .filter(|p| *p != 0.0)
                            .map(|p| (last - p) / p * 100.0);
                        json!({ "ts": ts, "last": last, "change_pct": change_pct })
                    }
                    _ => Value::Null,
                };
                json!({
                    "code": r.code, "name": r.name, "type": r.type_,
                    "interval_secs": r.interval_secs,
                    "settlement": r.settlement, "enabled": r.enabled, "latest": latest,
                })
            }).collect();
            syms.sort_by(|a, b| a["code"].as_str().cmp(&b["code"].as_str()));
            tool_ok(id, &json!({ "symbols": syms }))
        }
        Err(e) => tool_fail(id, anyhow::anyhow!("标的注册表查询失败：{e}")),
    }
}

// ── 11-sim-live / L1：模拟实盘工具（sim_*）──

/// 取注入的 SimLiveService；未配置（None）→ 工具错误帧（isError）；
/// MCP sim_* 服务开关关闭（web/共享实例 `set_mcp_enabled(false)`）→ 工具错误帧（isError，提示已停用）。
fn sim_service(st: &McpState, id: Option<Value>) -> Result<Arc<SimLiveService>, Value> {
    match st.sim.clone() {
        Some(s) => {
            if !s.mcp_enabled() {
                return Err(tool_fail(id, anyhow::anyhow!("sim-live MCP 服务已停用（模拟实盘，不触真实券商）")));
            }
            Ok(s)
        }
        None => Err(tool_fail(id, anyhow::anyhow!("sim-live 未配置（McpState.sim=None）"))),
    }
}

/// sim_start_session(name, period, cash_init?, strategy_set?, stock_set?, source?, strategies?)：开模拟会话。
/// `strategies`（ADR §4 多策略）可选：每策略 {id, params, stocks, weight}；提供则用之，否则回退 strategy_set × stock_set（默认参数、weight=1）。
async fn sim_start_session(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(name) = args.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return result_err(id, INVALID_PARAMS, "name 必填（非空 string）");
    };
    let Some(period) = args.get("period").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "period 必填");
    };
    let cash_init = args.get("cash_init").and_then(Value::as_f64);
    let strategy_set = str_array(args, "strategy_set");
    let stock_set = str_array(args, "stock_set");
    let source = args.get("source").and_then(Value::as_str).unwrap_or("manual").to_string();
    // strategies（可选）：json 数组 → Vec<StrategyConfigInput>（serde 默认 params={}/weight=1）。
    let strategies: Vec<StrategyConfigInput> = match args.get("strategies") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(list) => list,
            Err(e) => return result_err(id, INVALID_PARAMS, format!("strategies 解析失败: {e}")),
        },
        None => Vec::new(),
    };
    let req = StartSessionReq {
        name: name.into(),
        cash_init,
        strategy_set,
        stock_set,
        period: period.into(),
        source,
        buy_long_threshold: args.get("buy_long_threshold").and_then(Value::as_f64),
        sell_threshold: args.get("sell_threshold").and_then(Value::as_f64),
        strategies,
    };
    match sim.start_session(&req).await {
        Ok(view) => tool_ok(id, &view),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_stop_session(session_id)：停止会话（落库结束结果）。
async fn sim_stop_session(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.stop_session(session_id).await {
        Ok(true) => tool_ok(id, &json!({ "session_id": session_id, "stopped": true })),
        Ok(false) => tool_ok(id, &json!({ "session_id": session_id, "stopped": false })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_get_account(session_id)。
fn sim_get_account(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.get_account(session_id) {
        Ok(view) => tool_ok(id, &view),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_get_positions(session_id)。持仓 latest/market_value 由 SimLiveService 经行情源解析。
async fn sim_get_positions(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.get_positions(session_id).await {
        Ok(pos) => tool_ok(id, &json!({ "session_id": session_id, "positions": pos })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_get_orders(session_id)。
fn sim_get_orders(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.get_orders(session_id) {
        Ok(orders) => tool_ok(id, &json!({ "session_id": session_id, "orders": orders })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_get_pnl(session_id)。
fn sim_get_pnl(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.get_pnl(session_id) {
        Ok(pnl) => tool_ok(id, &json!({ "session_id": session_id, "pnl": pnl })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_place_order(session_id, code, side, qty, price, limit_price?, intent_id?, source?)：下模拟单。
async fn sim_place_order(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    let Some(code) = args.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()) else {
        return result_err(id, INVALID_PARAMS, "code 必填（非空 string）");
    };
    let Some(side) = args.get("side").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "side 必填（buy/sell）");
    };
    let Some(qty) = args.get("qty").and_then(Value::as_f64) else {
        return result_err(id, INVALID_PARAMS, "qty 必填（number）");
    };
    let Some(price) = args.get("price").and_then(Value::as_f64) else {
        return result_err(id, INVALID_PARAMS, "price 必填（模拟行情最新价）");
    };
    let req = PlaceOrderReq {
        code: code.into(),
        side: side.into(),
        qty,
        limit_price: args.get("limit_price").and_then(Value::as_f64),
        intent_id: args.get("intent_id").and_then(Value::as_str).map(|s| s.into()),
        source: args.get("source").and_then(Value::as_str).unwrap_or("manual").into(),
    };
    match sim.place_order(session_id, &req, price).await {
        Ok(Some(fill)) => tool_ok(id, &json!({ "session_id": session_id, "filled": true, "fill": fill })),
        Ok(None) => tool_ok(id, &json!({ "session_id": session_id, "filled": false,
            "fill": null, "reason": "限价未触及，记为 pending 单" })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_cancel_order(session_id, order_id)。
async fn sim_cancel_order(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    let Some(order_id) = args.get("order_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "order_id 必填");
    };
    match sim.cancel_order(session_id, order_id).await {
        Ok(cancelled) => tool_ok(id, &json!({ "session_id": session_id, "order_id": order_id, "cancelled": cancelled })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_list_strategies(strategy_id?)：策略目录（P4a 数据源 = Registry catalog，仅 published
/// 最新版本；旧内置目录废止）。复用 sim_* 开关门禁；Registry 服务未注入 → isError。
async fn sim_list_strategies(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let _sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(strategies) = st.strategies.clone() else {
        return tool_fail(id, anyhow::anyhow!(
            "策略 Registry 未配置（McpState.strategies=None；P4a 起 sim_list_strategies 数据源为 Registry catalog）"
        ));
    };
    let filter = args.get("strategy_id").and_then(Value::as_str);
    match strategies.catalog(None, None).await {
        Ok(catalog) => {
            let entries: Vec<Value> = catalog
                .into_iter()
                .filter(|e| filter.is_none_or(|fid| e.strategy.id == fid))
                .map(|e| serde_json::to_value(&e).unwrap_or_else(|_| json!({})))
                .collect();
            tool_ok(id, &json!(entries))
        }
        Err(e) => tool_fail(id, e),
    }
}

/// sim_get_strategy_signal(session_id, code)：单标的当前策略信号（聚合分 + 各策略独立分）。
fn sim_get_strategy_signal(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    let Some(code) = args.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()) else {
        return result_err(id, INVALID_PARAMS, "code 必填（非空 string）");
    };
    match sim.get_strategy_signal(session_id, code) {
        Ok(Some(eval)) => tool_ok(id, &serde_json::to_value(&eval).unwrap_or_else(|_| json!({}))),
        Ok(None) => tool_ok(id, &json!({ "session_id": session_id, "code": code, "evaluation": null })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_get_strategy_analysis(session_id)：多标的评估概览。
fn sim_get_strategy_analysis(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.get_strategy_analysis(session_id) {
        Ok(evals) => tool_ok(id, &json!({ "session_id": session_id,
            "evaluations": serde_json::to_value(&evals).unwrap_or_else(|_| json!([])) })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_list_sessions()：历史会话列表（已结束附指标摘要）。
async fn sim_list_sessions(st: &McpState, id: Option<Value>, _args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    match sim.list_sessions().await {
        Ok(entries) => tool_ok(id, &serde_json::to_value(&entries).unwrap_or_else(|_| json!([]))),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_get_session(session_id)：会话详情回看（元数据 + 结束结果）。
async fn sim_get_session(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.get_session(session_id).await {
        Ok(Some(detail)) => tool_ok(id, &detail),
        Ok(None) => tool_ok(id, &json!({ "session_id": session_id, "session": null, "result": null })),
        Err(e) => tool_fail(id, e),
    }
}

/// sim_run_backtest_compare(session_id)：触发一次回测 run（异步），返回会话结果 + run id 列表。
async fn sim_run_backtest_compare(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let sim = match sim_service(st, id.clone()) { Ok(s) => s, Err(e) => return e };
    let Some(session_id) = args.get("session_id").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "session_id 必填");
    };
    match sim.run_backtest_compare(session_id).await {
        Ok(view) => tool_ok(id, &view),
        Err(e) => tool_fail(id, e),
    }
}

// ── 12-strategy-system / P3c：统一策略系统工具族（strategy_* / bt_*）──

/// bt_list_runs page_size 封顶（与 web MAX_WORKBENCH_LIMIT 同口径）。
pub const BT_MAX_PAGE_SIZE: i64 = 500;

/// strategy_*/bt_* 工具族门禁（父级裁决：McpState 本地单开关，默认开）：
/// 停用 → 工具错误帧（isError，提示已停用；参照 sim_* `sim_service` 既有实现）。
fn strategy_gate(st: &McpState, id: &Option<Value>) -> Result<(), Value> {
    if !st.strategy_tools_enabled() {
        return Err(tool_fail(id.clone(),
            anyhow::anyhow!("统一策略系统 MCP 工具已停用（strategy_*/bt_* 工具族）")));
    }
    Ok(())
}

/// 取注入的 StrategyService；停用/未配置（None）→ 工具错误帧（isError）。
fn strategy_service(st: &McpState, id: &Option<Value>) -> Result<Arc<StrategyService>, Value> {
    strategy_gate(st, id)?;
    st.strategies.clone().ok_or_else(||
        tool_fail(id.clone(), anyhow::anyhow!("strategy registry 未配置（McpState.strategies=None）")))
}

/// 取注入的 WorkbenchService；停用/未配置（None）→ 工具错误帧（isError）。
fn workbench_service(st: &McpState, id: &Option<Value>) -> Result<Arc<WorkbenchService>, Value> {
    strategy_gate(st, id)?;
    st.workbench.clone().ok_or_else(||
        tool_fail(id.clone(), anyhow::anyhow!("backtest workbench 未配置（McpState.workbench=None）")))
}

/// 必填非空 string 参数（缺/空 → None；调用方映射 -32602）。
fn req_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// 回测/试算周期口径（M1/M5/M15/H1/D1；与 application::bar_map::parse_period 同集；
/// I-6/D3：补 H1 与数据层 cagg 1h 对齐；W1/MO1 不入回测）。
fn valid_bt_period(s: &str) -> bool {
    matches!(s, "M1" | "M5" | "M15" | "H1" | "D1")
}

/// RFC3339 时间戳解析（非法 → None → -32602；与 get_data_quality date 校验同层口径）。
fn parse_rfc3339_utc(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

/// 试算缺省前置预热根数（I-2/D6 架构师裁决；与 application::workbench::DEFAULT_WARMUP_BARS 同值）。
pub const DEFAULT_TEST_RUN_WARMUP_BARS: usize = 250;
/// 试算缺省初始资金（与回测 ADR §4 一致）。
pub const DEFAULT_TEST_RUN_CAPITAL: f64 = 100_000.0;
/// strategy_list(level?, kind?, include_source?)：catalog（仅 published，每策略最新 published 版本；level at-least 过滤）。
/// I-7（D5）：默认只回摘要（version 不含 code）；include_source=true 显式返回全量源码。
async fn strategy_list(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let svc = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let level = match args.get("level") {
        None => None,
        Some(v) => match v.as_str().and_then(ApprovalLevel::parse) {
            Some(l) => Some(l),
            None => return result_err(id, INVALID_PARAMS, "level 须为 backtest_ok/sim_ok/live_approved"),
        },
    };
    let kind = match args.get("kind") {
        None => None,
        Some(v) => match v.as_str().and_then(StrategyKind::parse) {
            Some(k) => Some(k),
            None => return result_err(id, INVALID_PARAMS, "kind 须为 strategy/template"),
        },
    };
    let include_source = match args.get("include_source") {
        None => false,
        Some(v) => match v.as_bool() {
            Some(b) => b,
            None => return result_err(id, INVALID_PARAMS, "include_source 须为 boolean"),
        },
    };
    match svc.catalog(level, kind).await {
        Ok(entries) => {
            if include_source { return tool_ok(id, &entries); }
            // I-7（D5）瘦身：摘要剔除 version.code（身份/版本/sha256/状态保留）。
            let slim: Vec<Value> = entries.iter().map(|e| {
                let mut v = serde_json::to_value(e).expect("CatalogEntry 可序列化");
                if let Some(ver) = v.get_mut("version").and_then(Value::as_object_mut) {
                    ver.remove("code");
                }
                v
            }).collect();
            tool_ok(id, &slim)
        }
        Err(e) => tool_fail(id, e),
    }
}

/// strategy_get(strategy_id)：策略详情 + 版本列表（version 升序）。
async fn strategy_get(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let svc = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(strategy_id) = req_str(args, "strategy_id") else {
        return result_err(id, INVALID_PARAMS, "strategy_id 必填（非空 string，st_ 前缀）");
    };
    match svc.get_strategy(strategy_id).await {
        Ok(strategy) => match svc.list_versions(strategy_id).await {
            Ok(versions) => tool_ok(id, &json!({ "strategy": strategy, "versions": versions })),
            Err(e) => tool_fail(id, e),
        },
        Err(e) => tool_fail(id, e),
    }
}

/// strategy_create(name, description?, kind?, code, params?)：新建策略（v1 draft）。
async fn strategy_create(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let svc = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(name) = req_str(args, "name") else {
        return result_err(id, INVALID_PARAMS, "name 必填（非空 string）");
    };
    let Some(code) = req_str(args, "code") else {
        return result_err(id, INVALID_PARAMS, "code 必填（非空 string，QuickJS 插件源码）");
    };
    let kind = match args.get("kind") {
        None => StrategyKind::Strategy,
        Some(v) => match v.as_str().and_then(StrategyKind::parse) {
            Some(k) => k,
            None => return result_err(id, INVALID_PARAMS, "kind 须为 strategy/template"),
        },
    };
    // params 仅作提示（Registry 不存实例参数——试算/运行时传入）；提供时仅校验形状。
    if let Some(p) = args.get("params") {
        if !p.is_object() {
            return result_err(id, INVALID_PARAMS, "params 须为 object（创建不持久化，仅提示）");
        }
    }
    let input = CreateStrategyInput {
        name: name.to_string(),
        description: args.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
        kind,
        code: code.to_string(),
    };
    match svc.create_strategy(&input).await {
        Ok((strategy, version)) => tool_ok(id, &json!({ "strategy": strategy, "version": version })),
        Err(e) => tool_fail(id, e),
    }
}

/// strategy_update(version_id, code)：draft 原地更新 / published 自动落新 draft（返回 outcome）。
async fn strategy_update(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let svc = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(version_id) = req_str(args, "version_id") else {
        return result_err(id, INVALID_PARAMS, "version_id 必填（非空 string，sv_ 前缀）");
    };
    let Some(code) = req_str(args, "code") else {
        return result_err(id, INVALID_PARAMS, "code 必填（非空 string）");
    };
    match svc.update_draft(version_id, code).await {
        Ok(UpdateDraftOutcome::Updated(row)) => {
            tool_ok(id, &json!({ "outcome": "updated", "version": row }))
        }
        Ok(UpdateDraftOutcome::NewDraft(row)) => {
            tool_ok(id, &json!({ "outcome": "new_draft", "version": row }))
        }
        Err(e) => tool_fail(id, e),
    }
}

/// strategy_publish(version_id)：发布门禁冒烟通过 → draft→published。
async fn strategy_publish(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let svc = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(version_id) = req_str(args, "version_id") else {
        return result_err(id, INVALID_PARAMS, "version_id 必填（非空 string，sv_ 前缀）");
    };
    match svc.publish(version_id).await {
        Ok(row) => tool_ok(id, &row),
        Err(e) => tool_fail(id, e),
    }
}

/// strategy_archive(version_id)：published→archived（单向）。
async fn strategy_archive(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let svc = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(version_id) = req_str(args, "version_id") else {
        return result_err(id, INVALID_PARAMS, "version_id 必填（非空 string，sv_ 前缀）");
    };
    match svc.archive(version_id).await {
        Ok(row) => tool_ok(id, &row),
        Err(e) => tool_fail(id, e),
    }
}

/// strategy_test_run(code?|version_id?, symbol, period, from, to, mode, params?)：在线试算（双模式）。
async fn strategy_test_run(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let svc = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let code = args.get("code").and_then(Value::as_str).filter(|s| !s.is_empty());
    let version_id = args.get("version_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let source = match (code, version_id) {
        (Some(c), None) => TestRunSource::Inline(c.to_string()),
        (None, Some(v)) => TestRunSource::VersionId(v.to_string()),
        _ => return result_err(id, INVALID_PARAMS, "code 与 version_id 须恰提供一个（二选一）"),
    };
    let Some(symbol) = req_str(args, "symbol") else {
        return result_err(id, INVALID_PARAMS, "symbol 必填（非空 string）");
    };
    let Some(period) = args.get("period").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "period 必填（M1/M5/M15/H1/D1）");
    };
    if !valid_bt_period(period) {
        return result_err(id, INVALID_PARAMS, "period 须为 M1/M5/M15/H1/D1");
    }
    let Some(from_s) = args.get("from").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "from 必填（RFC3339 时间戳）");
    };
    let Some(from) = parse_rfc3339_utc(from_s) else {
        return result_err(id, INVALID_PARAMS, "from 须为 RFC3339 时间戳");
    };
    let Some(to_s) = args.get("to").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "to 必填（RFC3339 时间戳）");
    };
    let Some(to) = parse_rfc3339_utc(to_s) else {
        return result_err(id, INVALID_PARAMS, "to 须为 RFC3339 时间戳");
    };
    let mode = match args.get("mode").and_then(Value::as_str) {
        Some("pure_score") => TestRunMode::PureScore,
        Some("sim_position") => TestRunMode::SimPosition,
        _ => return result_err(id, INVALID_PARAMS, "mode 必填（pure_score/sim_position）"),
    };
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return result_err(id, INVALID_PARAMS, "params 须为 object");
    }
    // I-9（D9）：symbol 注册校验（口径同 get_kline I-1）——未注册/注册表不可读 → isError（不静默无数据）。
    if let Err(e) = ensure_registered(st, symbol).await {
        return tool_fail(id, e);
    }
    // I-2/D6：前置预热根数（缺省 250；0=不预热）。
    let warmup_bars = match args.get("warmup_bars") {
        None => DEFAULT_TEST_RUN_WARMUP_BARS,
        Some(v) => match v.as_u64() {
            Some(n) => n as usize,
            None => return result_err(id, INVALID_PARAMS, "warmup_bars 须为非负整数"),
        },
    };
    // I-3/D6 + ADR-019 D11-3：fee **省略** = 传 None 交服务层按标的 type 查 `fee_profiles` 解析
    // （无档案/type 未设 → 旧 ADR bt-1 默认）；显式对象按字段优先级（v1.1 R-2：出现字段优先，缺失字段逐字段回退档案→旧默认；
    // v1.1 补守卫：显式对象**无可识别字段**（空对象/全未知键）→ 服务层报错 isError）。
    let fee = match args.get("fee") {
        None => None,
        Some(v) if v.is_object() => Some(v.clone()),
        Some(_) => return result_err(id, INVALID_PARAMS, "fee 须为 object"),
    };
    let policy = args.get("policy").cloned()
        .unwrap_or_else(|| json!({ "LumpSum": { "position_pct": 1.0 } }));
    if !policy.is_object() {
        return result_err(id, INVALID_PARAMS, "policy 须为 object");
    }
    let capital = match args.get("capital") {
        None => DEFAULT_TEST_RUN_CAPITAL,
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() && n > 0.0 => n,
            _ => return result_err(id, INVALID_PARAMS, "capital 须为正有限数值"),
        },
    };
    let req = TestRunRequest {
        source, params, symbol: symbol.to_string(), period: period.to_string(), from, to, mode,
        warmup_bars, fee, policy, initial_capital: capital,
    };
    match svc.test_run(&req).await {
        Ok(resp) => tool_ok(id, &resp),
        Err(e) => tool_fail(id, e),
    }
}

/// 策略编程手册全文（架构师主笔事实源；include_str! 静态内嵌，与 web
/// GET /api/strategies/guide 共用同一文件字节，双通道一致）。
const STRATEGY_GUIDE: &str =
    include_str!("../../../design/12-strategy-system/04-strategy-programming-guide.md");

/// strategy_guide()：返回手册全文（markdown；无参数）。不经 StrategyService（纯静态内容），
/// 但 `strategy_tools_enabled` 单开关对本工具同样生效（停用 → isError）。
fn strategy_guide(st: &McpState, id: Option<Value>) -> Value {
    if let Err(e) = strategy_gate(st, &id) { return e; }
    tool_ok(id, &json!({ "format": "markdown", "guide": STRATEGY_GUIDE }))
}

/// bt_run_ensemble(...)：提交 ensemble 回测（异步任务，返回 run_id）。
/// slot.version_id 缺省 → catalog 解析该策略最新 published（父级批准口径；无 published → isError）。
/// 显式 version_id：published|archived 可运行（archived = 审计重跑，2026-09-10 裁决；config 快照
/// 钉住 archived 审计标记）；draft → isError（未发布代码不可运行）。语义校验归服务层。
async fn bt_run_ensemble(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let strategies = match strategy_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let name = args.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let Some(symbol) = req_str(args, "symbol") else {
        return result_err(id, INVALID_PARAMS, "symbol 必填（非空 string）");
    };
    let Some(period) = args.get("period").and_then(Value::as_str) else {
        return result_err(id, INVALID_PARAMS, "period 必填（M1/M5/M15/H1/D1）");
    };
    if !valid_bt_period(period) {
        return result_err(id, INVALID_PARAMS, "period 须为 M1/M5/M15/H1/D1");
    }
    let Some(from) = args.get("from").and_then(Value::as_str).and_then(parse_rfc3339_utc) else {
        return result_err(id, INVALID_PARAMS, "from 必填（RFC3339 时间戳）");
    };
    let Some(to) = args.get("to").and_then(Value::as_str).and_then(parse_rfc3339_utc) else {
        return result_err(id, INVALID_PARAMS, "to 必填（RFC3339 时间戳）");
    };
    let Some(slots_v) = args.get("slots").and_then(Value::as_array).filter(|a| !a.is_empty()) else {
        return result_err(id, INVALID_PARAMS, "slots 必填（非空数组，1..=10）");
    };
    // 槽位结构校验（-32602）；语义校验（draft 拒绝/weight>0/params schema）归服务层（isError）。
    let mut pending: Vec<(String, Option<String>, f64, Value)> = Vec::with_capacity(slots_v.len());
    for (i, s) in slots_v.iter().enumerate() {
        let Some(strategy_id) = s.get("strategy_id").and_then(Value::as_str).filter(|x| !x.is_empty()) else {
            return result_err(id, INVALID_PARAMS, format!("slots[{i}].strategy_id 必填（非空 string）"));
        };
        let version_id = s.get("version_id").and_then(Value::as_str)
            .filter(|x| !x.is_empty()).map(str::to_string);
        let Some(weight) = s.get("weight").and_then(Value::as_f64) else {
            return result_err(id, INVALID_PARAMS, format!("slots[{i}].weight 必填（number，>0）"));
        };
        let params = s.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() {
            return result_err(id, INVALID_PARAMS, format!("slots[{i}].params 须为 object"));
        }
        pending.push((strategy_id.to_string(), version_id, weight, params));
    }
    // version_id 缺省解析：catalog = 每策略最新 published（仅在有缺省时取一次）。
    let catalog = if pending.iter().any(|(_, v, _, _)| v.is_none()) {
        match strategies.catalog(None, None).await {
            Ok(c) => Some(c),
            Err(e) => return tool_fail(id, e),
        }
    } else {
        None
    };
    let mut slots = Vec::with_capacity(pending.len());
    for (strategy_id, version_id, weight, params) in pending {
        let vid = match version_id {
            Some(v) => v,
            None => {
                let found = catalog.as_ref().expect("有缺省 version_id 时已取 catalog")
                    .iter().find(|e| e.strategy.id == strategy_id);
                match found {
                    Some(e) => e.version.id.clone(),
                    None => return tool_fail(id, anyhow::anyhow!(
                        "策略 {strategy_id} 无已发布（published）版本，version_id 缺省无法解析")),
                }
            }
        };
        slots.push(SlotReq { version_id: vid, params, weight });
    }
    let buy_threshold = match args.get("buy_threshold") {
        None => None,
        Some(v) => match v.as_f64() {
            Some(n) => Some(n),
            None => return result_err(id, INVALID_PARAMS, "buy_threshold 须为 number"),
        },
    };
    let sell_threshold = match args.get("sell_threshold") {
        None => None,
        Some(v) => match v.as_f64() {
            Some(n) => Some(n),
            None => return result_err(id, INVALID_PARAMS, "sell_threshold 须为 number"),
        },
    };
    let Some(policy) = args.get("policy").cloned() else {
        return result_err(id, INVALID_PARAMS,
            "policy 必填（{\"LumpSum\":{\"position_pct\":..}} 或 {\"Dca\":{..}}）");
    };
    let initial_capital = match args.get("initial_capital") {
        None => None,
        Some(v) => match v.as_f64() {
            Some(n) => Some(n),
            None => return result_err(id, INVALID_PARAMS, "initial_capital 须为 number"),
        },
    };
    // ADR-019 D11-3（v1.1 R-2）：同上（省略 = 按标的 type 查 fee_profiles；显式对象按字段优先级）。
    // v1.1 补守卫：无可识别字段的显式对象由服务层报错（isError），此处仅透传 object。
    let fee = match args.get("fee") {
        None => None,
        Some(v) if v.is_object() => Some(v.clone()),
        Some(_) => return result_err(id, INVALID_PARAMS, "fee 须为 object"),
    };
    // I-2/D6：前置预热根数（缺省 250）。
    let warmup_bars = match args.get("warmup_bars") {
        None => DEFAULT_TEST_RUN_WARMUP_BARS,
        Some(v) => match v.as_u64() {
            Some(n) => n as usize,
            None => return result_err(id, INVALID_PARAMS, "warmup_bars 须为非负整数"),
        },
    };
    let req = SubmitRunReq {
        name, symbol: symbol.to_string(), period: period.to_string(), from, to, slots,
        buy_threshold, sell_threshold, policy,
        stop: args.get("stop").cloned(), initial_capital, fee, warmup_bars,
    };
    match wb.submit(req).await {
        Ok(run) => tool_ok(id, &json!({ "run_id": run.id, "run": run })),
        Err(e) => tool_fail(id, e),
    }
}

/// bt_get_run(run_id)：运行状态/进度/钉住 config。
async fn bt_get_run(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(run_id) = req_str(args, "run_id") else {
        return result_err(id, INVALID_PARAMS, "run_id 必填（非空 string，sr_ 前缀）");
    };
    match wb.get_run(run_id).await {
        Ok(run) => tool_ok(id, &run),
        Err(e) => tool_fail(id, e),
    }
}

/// bt_get_run_result(run_id)：五 jsonb 结果（未成功 → isError）。
async fn bt_get_run_result(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(run_id) = req_str(args, "run_id") else {
        return result_err(id, INVALID_PARAMS, "run_id 必填（非空 string，sr_ 前缀）");
    };
    match wb.get_result(run_id).await {
        Ok(result) => tool_ok(id, &result),
        Err(e) => tool_fail(id, e),
    }
}

/// bt_list_runs(status?, page?, page_size?)：列表（created_at 倒序；轻量不含结果）。
async fn bt_list_runs(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let status = match args.get("status") {
        None => None,
        Some(v) => match v.as_str().and_then(StrategyRunStatus::parse) {
            Some(s) => Some(s),
            None => return result_err(id, INVALID_PARAMS,
                "status 须为 queued/running/succeeded/failed/canceled"),
        },
    };
    let page = match args.get("page") {
        None => 1,
        Some(v) => match v.as_i64() {
            Some(n) if n >= 1 => n,
            _ => return result_err(id, INVALID_PARAMS, "page 须为 ≥1 整数"),
        },
    };
    let page_size = match args.get("page_size") {
        None => 100,
        Some(v) => match v.as_i64() {
            Some(n) => n.clamp(1, BT_MAX_PAGE_SIZE),
            None => return result_err(id, INVALID_PARAMS, "page_size 须为整数"),
        },
    };
    let filter = domain::ports::StrategyRunFilter {
        status, limit: page_size, offset: (page - 1) * page_size,
    };
    match wb.list_runs(&filter).await {
        Ok(runs) => tool_ok(id, &json!({ "page": page, "page_size": page_size, "runs": runs })),
        Err(e) => tool_fail(id, e),
    }
}

/// bt_cancel_run(run_id)：协作式取消（终态 → isError）。
async fn bt_cancel_run(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(run_id) = req_str(args, "run_id") else {
        return result_err(id, INVALID_PARAMS, "run_id 必填（非空 string，sr_ 前缀）");
    };
    match wb.cancel(run_id).await {
        Ok(run) => tool_ok(id, &run),
        Err(e) => tool_fail(id, e),
    }
}

/// bt_compare_runs(run_ids[])：净值+绩效并排（输入序；未知/未成功跳过）。
async fn bt_compare_runs(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(ids_v) = args.get("run_ids").and_then(Value::as_array).filter(|a| !a.is_empty()) else {
        return result_err(id, INVALID_PARAMS, "run_ids 必填（非空 string 数组）");
    };
    let mut ids = Vec::with_capacity(ids_v.len());
    for v in ids_v {
        match v.as_str() {
            Some(s) => ids.push(s.to_string()),
            None => return result_err(id, INVALID_PARAMS, "run_ids 元素须为 string"),
        }
    }
    match wb.compare(&ids).await {
        Ok(items) => tool_ok(id, &items),
        Err(e) => tool_fail(id, e),
    }
}

/// bt_list_presets()：组合预设列表（CRUD 在 web；MCP 只读+apply）。
async fn bt_list_presets(st: &McpState, id: Option<Value>, _args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    match wb.list_presets().await {
        Ok(rows) => tool_ok(id, &rows),
        Err(e) => tool_fail(id, e),
    }
}

/// bt_apply_preset(preset_id)：返回钉住 config（供 bt_run_ensemble 合并区间后提交）。
async fn bt_apply_preset(st: &McpState, id: Option<Value>, args: &Value) -> Value {
    let wb = match workbench_service(st, &id) { Ok(s) => s, Err(e) => return e };
    let Some(preset_id) = req_str(args, "preset_id") else {
        return result_err(id, INVALID_PARAMS, "preset_id 必填（非空 string，sp_ 前缀）");
    };
    match wb.apply_preset(preset_id).await {
        Ok(config) => tool_ok(id, &json!({ "preset_id": preset_id, "config": config })),
        Err(e) => tool_fail(id, e),
    }
}

/// 解析字符串数组参数（缺省/非数组 → 空）。
fn str_array(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.into()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mocks::{quality_for, test_state, MockEvents, MockKline};
    use chrono::TimeZone;
    use domain::ports::BacktestBarRead;
    use std::sync::atomic::{AtomicI64, Ordering};
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
        assert_eq!(tools.len(), 34, "4 只读工具（I-4 加 list_symbols）+ 14 模拟实盘（11-sim-live）+ 8 strategy_* + 8 bt_*（12-strategy-system / P3c + 手册暴露裁决 2026-09-10）");
        assert_eq!(tools[0]["name"], "get_kline");
        assert_eq!(tools[0]["inputSchema"]["required"], json!(["code"]));
        assert_eq!(tools[0]["inputSchema"]["properties"]["period"]["enum"],
            json!(["1m", "5m", "15m", "1h", "1d"]));
        // I-5/I-10（D2）：from/to 边界 + limit 上限 10000
        assert!(tools[0]["inputSchema"]["properties"]["from"].is_object(), "get_kline 增 from");
        assert!(tools[0]["inputSchema"]["properties"]["to"].is_object(), "get_kline 增 to");
        assert!(tools[0]["inputSchema"]["properties"]["limit"]["description"]
            .as_str().unwrap().contains("10000"), "limit 描述注明上限 10000");
        assert_eq!(tools[1]["name"], "get_sources_health");
        assert!(tools[1]["inputSchema"]["properties"]["window_secs"].is_object());
        assert_eq!(tools[2]["name"], "get_data_quality", "MCP④ 数据质量（范围④）");
        assert_eq!(tools[2]["inputSchema"]["required"], json!(["code", "date"]));
        assert_eq!(tools[3]["name"], "list_symbols", "I-4（D1）标的列表工具（与 web /api/symbols 同源）");
        assert!(tools[3]["inputSchema"]["required"].is_null(), "list_symbols 无必填参数");
        // 模拟实盘工具（11-sim-live / L1）
        let sim_names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).filter(|n| n.starts_with("sim_")).collect();
        assert_eq!(sim_names, vec!["sim_start_session", "sim_stop_session", "sim_get_account",
            "sim_get_positions", "sim_get_orders", "sim_get_pnl", "sim_place_order", "sim_cancel_order",
            "sim_list_strategies", "sim_get_strategy_signal", "sim_get_strategy_analysis",
            "sim_list_sessions", "sim_get_session", "sim_run_backtest_compare"]);
        // 每个 sim 工具 description 均注明「模拟实盘，不触真实券商」
        for t in tools.iter().filter(|t| t["name"].as_str().unwrap().starts_with("sim_")) {
            assert!(t["description"].as_str().unwrap().contains("模拟实盘，不触真实券商"),
                "{} 描述须注明模拟实盘", t["name"]);
        }
        assert!(!tools.iter().any(|t| t["name"].as_str().unwrap().contains("trade")),
            "交易类（真实）工具不做（ADR-009 范围④ Wave 4）；sim_* 为模拟，非真实");
        // 统一策略系统工具族（12-strategy-system / P3c；ADR §8 矩阵，落现有 SSE server §13.7）
        let strategy_names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).filter(|n| n.starts_with("strategy_")).collect();
        assert_eq!(strategy_names, vec!["strategy_list", "strategy_get", "strategy_create",
            "strategy_update", "strategy_publish", "strategy_archive", "strategy_test_run",
            "strategy_guide"]);
        let bt_names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).filter(|n| n.starts_with("bt_")).collect();
        assert_eq!(bt_names, vec!["bt_run_ensemble", "bt_get_run", "bt_get_run_result",
            "bt_list_runs", "bt_cancel_run", "bt_compare_runs", "bt_list_presets", "bt_apply_preset"]);
        // 策略管理类描述注明「统一策略系统 Registry」（任务书口径）
        for t in tools.iter().filter(|t| t["name"].as_str().unwrap().starts_with("strategy_")) {
            assert!(t["description"].as_str().unwrap().contains("统一策略系统 Registry"),
                "{} 描述须注明统一策略系统 Registry", t["name"]);
        }
        // inputSchema 必填契约
        let by_name = |n: &str| tools.iter().find(|t| t["name"] == n).cloned().expect("工具存在");
        assert_eq!(by_name("strategy_list")["inputSchema"]["properties"]["level"]["enum"],
            json!(["backtest_ok", "sim_ok", "live_approved"]));
        assert_eq!(by_name("strategy_list")["inputSchema"]["properties"]["kind"]["enum"],
            json!(["strategy", "template"]));
        assert_eq!(by_name("strategy_list")["inputSchema"]["properties"]["include_source"]["type"],
            json!("boolean"), "I-7（D5）：include_source 显式索取源码");
        assert_eq!(by_name("strategy_create")["inputSchema"]["required"], json!(["name", "code"]));
        assert_eq!(by_name("strategy_get")["inputSchema"]["required"], json!(["strategy_id"]));
        assert_eq!(by_name("strategy_update")["inputSchema"]["required"], json!(["version_id", "code"]));
        assert_eq!(by_name("strategy_publish")["inputSchema"]["required"], json!(["version_id"]));
        assert_eq!(by_name("strategy_archive")["inputSchema"]["required"], json!(["version_id"]));
        assert_eq!(by_name("strategy_test_run")["inputSchema"]["required"],
            json!(["symbol", "period", "from", "to", "mode"]));
        assert!(by_name("strategy_guide")["inputSchema"]["required"].is_null(),
            "strategy_guide 无参数（无 required）");
        assert_eq!(by_name("bt_run_ensemble")["inputSchema"]["required"],
            json!(["symbol", "period", "from", "to", "slots", "policy"]));
        assert_eq!(by_name("bt_get_run")["inputSchema"]["required"], json!(["run_id"]));
        assert_eq!(by_name("bt_get_run_result")["inputSchema"]["required"], json!(["run_id"]));
        assert_eq!(by_name("bt_cancel_run")["inputSchema"]["required"], json!(["run_id"]));
        assert_eq!(by_name("bt_compare_runs")["inputSchema"]["required"], json!(["run_ids"]));
        assert_eq!(by_name("bt_apply_preset")["inputSchema"]["required"], json!(["preset_id"]));
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
        // I-10（D2 契约变更）：limit 上限 1000→10000 且**超限不再静默封顶**（见
        // get_kline_limit_cap_and_segment_hint）；本用例保留下限钳制与周期映射契约。
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let _ = call(&st, "get_kline",
            json!({ "code": "518880", "period": "5m", "limit": 0 })).await;
        let calls = kline.calls.lock().unwrap();
        assert_eq!(calls[0].period, Period::M5);
        assert_eq!(calls[0].limit, 1, "limit 下限钳制 1");
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

    /// I-1（P0）：未注册代码 → 显式 isError（拒绝），且**不落到 K 线查询**
    /// （以 symbols 注册表判定「标的存在」，不以「有无 K 线」推断）。
    #[tokio::test]
    async fn get_kline_unregistered_code_is_tool_error() {
        let kline = Arc::new(MockKline::with_registered(&["518880", "159985"]));
        // （注册表只有 518880/159985，无被测的三个未注册 code）
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        for code in ["510300", "999999", "ABC123"] {
            let r = call(&st, "get_kline", json!({ "code": code })).await;
            assert_eq!(r["result"]["isError"], true, "{code} 未注册 → isError=true（非静默空数组）");
            assert!(r.get("error").is_none(), "{code} 走工具错误惯例（非 -32602 协议错误帧）");
            let text = r["result"]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains(code), "错误消息须含被拒 code：{text}");
            assert!(text.contains("未注册"), "错误消息须含原因：{text}");
        }
        assert!(kline.calls.lock().unwrap().is_empty(),
            "未注册 code 不得落到 bars 查询（注册表判定，非数据推断）");
    }

    /// I-1：已注册但区间无数据 → 正常空结果（无 isError），与「未注册」语义可区分。
    #[tokio::test]
    async fn get_kline_registered_without_bars_is_empty_not_error() {
        let st = test_state(Arc::new(MockKline::empty_bars()), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({ "code": "518880" })).await;
        assert!(r["result"]["isError"].is_null(), "已注册无数据 → 非错误（isError 不出现）");
        let payload = payload_of(&r);
        assert_eq!(payload["bars"], json!([]), "正常空结果：已注册标的该区间无数据");
    }

    /// I-1：注册表查询失败 → fail-closed（无法确认注册即拒，与 sim-live 既有口径一致）。
    #[tokio::test]
    async fn get_kline_registry_failure_is_tool_error_fail_closed() {
        let st = test_state(Arc::new(MockKline::failing_registry()), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({ "code": "518880" })).await;
        assert_eq!(r["result"]["isError"], true, "注册表不可查 → isError（fail-closed）");
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("mock registry failure"), "{text}");
    }

    // ── I-4（D1）：list_symbols（与 web GET /api/symbols 同源）──

    /// 注册表行构造（I-4 用例：注册状态/采集间隔/交割类型/最新快照均可控）。
    #[allow(clippy::too_many_arguments)] // 9 参（I-4 用例可控字段 + D11 type）
    fn sample_symbol(code: &str, name: Option<&str>, type_: Option<&str>, interval_secs: i32,
                     settlement: &str, enabled: bool, last_ts: Option<DateTime<Utc>>,
                     last_close: Option<f64>, prev_close: Option<f64>)
        -> domain::ports::SymbolLatestView {
        domain::ports::SymbolLatestView {
            code: code.into(), name: name.map(str::to_string), type_: type_.map(str::to_string),
            interval_secs, settlement: settlement.into(), enabled, last_ts, last_close, prev_close,
        }
    }

    /// I-4：全部注册标的（含 enabled=false）+ 注册状态 + 数据可用区间（最新可用 bar ts/last/日涨跌幅）；
    /// 与 web /api/symbols 同源同字段（KlineRead::symbols_with_latest），按 code 升序。
    #[tokio::test]
    async fn list_symbols_returns_registered_with_status_and_latest() {
        let kline = Arc::new(MockKline::new().with_symbols(vec![
            sample_symbol("518880", Some("黄金ETF"), Some("etf"), 60, "T1", true,
                Some(Utc.with_ymd_and_hms(2026, 9, 11, 7, 0, 0).unwrap()), Some(5.0), Some(4.0)),
            sample_symbol("600000", None, None, 15, "T0", false, None, None, None),
        ]));
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let r = call(&st, "list_symbols", json!({})).await;
        assert!(r.get("error").is_none(), "list_symbols 无协议错误：{r}");
        let p = payload_of(&r);
        let syms = p["symbols"].as_array().expect("symbols 数组");
        assert_eq!(syms.len(), 2, "全部注册标的（含 enabled=false 的停用标的）");
        // 同源 web `GET /api/symbols`：按 code 升序（确定性输出）——修复 A1 遗留断言与注释自相矛盾
        // （原断言 syms[0]=="600000" 与注释「按 code 升序」矛盾，且与端到端 `list_symbols_matches_real_symbols_registry`
        //  的 `want.sort()`（升序）不相容；以 web 同源升序为准，冲突已报架构师）。
        assert_eq!(syms[0]["code"], "518880", "按 code 升序（确定性输出）");
        assert_eq!(syms[0]["name"], "黄金ETF");
        assert_eq!(syms[0]["interval_secs"], 60, "采集间隔（与 REST 同源字段）");
        assert_eq!(syms[0]["settlement"], "T1", "交割类型 T0/T1（与 REST 同源字段）");
        assert_eq!(syms[0]["latest"]["ts"], "2026-09-11T07:00:00Z", "数据可用区间终点（最新 bar ts）");
        assert_eq!(syms[0]["latest"]["last"], json!(5.0));
        assert_eq!(syms[0]["latest"]["change_pct"], json!(25.0), "日涨跌幅 vs 昨收 (5-4)/4×100");
        assert_eq!(syms[1]["code"], "600000");
        assert_eq!(syms[1]["enabled"], false, "注册状态 = enabled（停用标的仍在册）");
        assert!(syms[1]["latest"].is_null(), "无 bar → latest=null（可用区间为空）");
        assert!(kline.calls.lock().unwrap().is_empty(), "list_symbols 只读注册表，不查 K 线");
    }

    /// I-4：注册表不可读 → isError（fail-closed，与 I-1 同口径）。
    #[tokio::test]
    async fn list_symbols_registry_failure_is_tool_error_fail_closed() {
        let st = test_state(Arc::new(MockKline::failing_registry()), Arc::new(MockEvents::new()));
        let r = call(&st, "list_symbols", json!({})).await;
        assert_eq!(r["result"]["isError"], true, "注册表不可读 → isError（fail-closed）");
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("注册表"), "错误消息须指明注册表失败：{text}");
    }

    // ── I-5/I-10（D2）：get_kline from/to 区间 + limit 上限（10000）──

    /// I-5：from/to 接受 ISO 日期（Asia/Shanghai 日界）与 RFC3339；from 闭、to 开；区间过滤。
    #[tokio::test]
    async fn get_kline_from_to_date_bounds_and_range_filter() {
        let base = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
        let bars: Vec<domain::ports::KlineBarView> = (0..4i64).map(|i| domain::ports::KlineBarView {
            code: "518880".into(), ts: base + chrono::Duration::days(i),
            open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
            source: Some("tushare".into()),
        }).collect();
        let kline = Arc::new(MockKline::new().with_bars(bars));
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({
            "code": "518880", "period": "1d", "from": "2026-09-02", "to": "2026-09-04",
            "limit": 10,
        })).await;
        let p = payload_of(&r);
        let out = p["bars"].as_array().unwrap();
        assert_eq!(out.len(), 3, "from 闭：仅保留 ts ≥ from 的 bar");
        let calls = kline.calls.lock().unwrap();
        assert_eq!(calls[0].before, Some(Utc.with_ymd_and_hms(2026, 9, 4, 16, 0, 0).unwrap()),
            "to 为日期 → 次日 00:00 CST（含 to 整日）= 2026-09-04T16:00Z，作 before（开）");
        assert_eq!(calls[0].limit, 11, "有 from 时多取一根以判定区间根数超限");
        assert_eq!(p["from"], "2026-09-01T16:00:00Z", "边界回声（归一 UTC）");
        assert_eq!(p["to"], "2026-09-04T16:00:00Z");
    }

    /// I-5：RFC3339 边界带偏移 → 归一 UTC；from 闭语义保留。
    #[tokio::test]
    async fn get_kline_from_to_rfc3339_bounds() {
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({
            "code": "518880", "from": "2026-09-02T00:00:00Z",
            "to": "2026-09-03T00:00:00+08:00", "limit": 5,
        })).await;
        let p = payload_of(&r);
        assert_eq!(p["to"], "2026-09-02T16:00:00Z", "带偏移的 RFC3339 归一为 UTC");
        let calls = kline.calls.lock().unwrap();
        assert_eq!(calls[0].before, Some(Utc.with_ymd_and_hms(2026, 9, 2, 16, 0, 0).unwrap()));
    }

    /// I-5/F1（010 验收缺陷 F1）：**同日 date 形式（from=to=YYYY-MM-DD）合法** = 该 CST 日整日；
    /// 「RFC3339 from + date to」混合形式亦合法。
    /// 依据契约「from 闭 / to 开 / to 含整日」：date 形式 to 先展开为次日 00:00 CST，再比较 f ≥ t
    ///（即 f ≥ t 只表达「空区间」，不等于「同日非法」）。
    #[tokio::test]
    async fn get_kline_same_day_date_bounds_legal() {
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        // 同日 date：2026-09-03 00:00 CST（闭）→ 2026-09-04 00:00 CST（开）= 2026-09-03 整日
        let r = call(&st, "get_kline", json!({
            "code": "518880", "from": "2026-09-03", "to": "2026-09-03", "limit": 10,
        })).await;
        assert!(r.get("error").is_none(), "同日 date 区间合法（该 CST 日整日）：{r}");
        let p = payload_of(&r);
        assert_eq!(p["from"], "2026-09-02T16:00:00Z", "from = 该日 00:00 CST（闭）");
        assert_eq!(p["to"], "2026-09-03T16:00:00Z", "to = 次日 00:00 CST（开，含 to 整日）");
        assert_eq!(p["bars"].as_array().unwrap().len(), 2, "该日内的样例 bar（09-03T01:30/01:31Z）全保留");
        // 混合形式：RFC3339 from（晚于该日 00:00 CST，但仍早于展开后的 to）+ date to
        let r = call(&st, "get_kline", json!({
            "code": "518880", "from": "2026-09-03T01:31:00Z", "to": "2026-09-03", "limit": 10,
        })).await;
        assert!(r.get("error").is_none(), "RFC3339 from + date to 合法：{r}");
        let p = payload_of(&r);
        assert_eq!(p["from"], "2026-09-03T01:31:00Z");
        assert_eq!(p["to"], "2026-09-03T16:00:00Z", "date to 展开为次日 00:00 CST");
        assert_eq!(p["bars"].as_array().unwrap().len(), 1, "from 闭：仅 01:31Z 一根");
        let calls = kline.calls.lock().unwrap();
        assert_eq!(calls[1].before, Some(Utc.with_ymd_and_hms(2026, 9, 3, 16, 0, 0).unwrap()),
            "取数 before = 展开后的 to（开）");
    }

    /// I-5：边界校验 —— 非法格式 / 非法类型 / 空或反向区间 → -32602（不落取数）。
    /// 注：同日 date 形式（from=to=YYYY-MM-DD）合法（见 get_kline_same_day_date_bounds_legal），
    /// 此处只保留真非法：反向 date、RFC3339 f==t（空区间）、RFC3339 from 晚于 date to 展开后的日界。
    #[tokio::test]
    async fn get_kline_from_to_validation_is_32602() {
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        for args in [
            json!({ "code": "518880", "from": "2026/09/02" }),
            json!({ "code": "518880", "to": "2026-9-2" }),
            json!({ "code": "518880", "from": "2026-09-03", "to": "2026-09-02" }),
            json!({ "code": "518880", "from": "2026-09-02T00:00:00Z", "to": "2026-09-02T00:00:00Z" }),
            json!({ "code": "518880", "from": "2026-09-03T01:31:00Z", "to": "2026-09-02" }),
            json!({ "code": "518880", "from": 20260902 }),
        ] {
            let r = call(&st, "get_kline", args.clone()).await;
            assert_eq!(r["error"]["code"], -32602, "{args} → invalid params");
        }
        assert!(kline.calls.lock().unwrap().is_empty(), "边界非法不落取数");
    }

    /// I-10/I-5（D2）：limit 上限提升至 10000；超限 → 明确 -32602 + 分段取数提示（不再静默钳制）。
    #[tokio::test]
    async fn get_kline_limit_cap_and_segment_hint() {
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({ "code": "518880", "limit": MAX_LIMIT + 1 })).await;
        assert_eq!(r["error"]["code"], -32602, "超限 → 协议层参数错误（不再静默封顶）");
        let msg = r["error"]["message"].as_str().unwrap();
        assert!(msg.contains("10000") && msg.contains("分段"), "提示上限与分段取数：{msg}");
        assert!(kline.calls.lock().unwrap().is_empty(), "超限不落取数");
        // 上限内：足额透传（I-10：M15 最大窗口 1188 根 > 旧上限 1000）
        let r = call(&st, "get_kline", json!({ "code": "518880", "period": "15m", "limit": 1188 })).await;
        assert!(r.get("error").is_none(), "上限内不报错：{r}");
        assert_eq!(kline.calls.lock().unwrap()[0].limit, 1188, "足额透传（不再封顶 1000）");
    }

    /// I-5（D2）：区间内根数 > limit → 显式 isError + 分段取数提示（不静默截断）。
    #[tokio::test]
    async fn get_kline_range_over_limit_is_tool_error() {
        let base = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
        let bars: Vec<domain::ports::KlineBarView> = (0..5i64).map(|i| domain::ports::KlineBarView {
            code: "518880".into(), ts: base + chrono::Duration::days(i),
            open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 1, amount: 1.0,
            source: Some("tushare".into()),
        }).collect();
        let kline = Arc::new(MockKline::new().with_bars(bars));
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({ "code": "518880", "from": "2026-09-01", "limit": 2 })).await;
        assert_eq!(r["result"]["isError"], true, "区间根数 > limit → isError");
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("分段"), "提示分段取数：{text}");
        assert_eq!(kline.calls.lock().unwrap()[0].limit, 3, "多取一根（limit+1）判定区间超限");
    }

    /// 向后兼容（D2）：不传 from/to → payload 键与取数参数与现状一致。
    #[tokio::test]
    async fn get_kline_without_bounds_keeps_legacy_shape() {
        let kline = Arc::new(MockKline::new());
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let r = call(&st, "get_kline", json!({ "code": "518880" })).await;
        let p = payload_of(&r);
        let mut keys: Vec<&str> = p.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["bars", "code", "period"], "无 from/to 时不回声边界（向后兼容）");
        let calls = kline.calls.lock().unwrap();
        assert!(calls[0].before.is_none(), "无 to → 仍取最新页（行为不变）");
        assert_eq!(calls[0].limit, DEFAULT_LIMIT, "缺省 limit=240 不变");
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

            strategies: None,
            workbench: None,
            strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            sim: None,
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

    // ── 11-sim-live / L1：sim_* 工具（mock SimSessionStore + 固定时钟，无实时 DB）──

    #[derive(Default)]
    struct MockSimStore {
        sessions: std::sync::Mutex<std::collections::HashMap<String, domain::ports::SimSessionView>>,
        results: std::sync::Mutex<std::collections::HashMap<String, domain::ports::SimSessionResult>>,
        states: std::sync::Mutex<std::collections::HashMap<String, domain::ports::SimSessionState>>,
        trades: std::sync::Mutex<Vec<domain::ports::NewSimTrade>>,
    }

    #[async_trait::async_trait]
    impl domain::ports::SimSessionStore for MockSimStore {
        async fn create_session(&self, s: &domain::ports::NewSimSession) -> anyhow::Result<()> {
            self.sessions.lock().unwrap().insert(s.id.clone(), domain::ports::SimSessionView {
                id: s.id.clone(), name: s.name.clone(), cash_init: s.cash_init,
                strategy_set: s.strategy_set.clone(), stock_set: s.stock_set.clone(),
                period: s.period.clone(), start_ts: s.start_ts, end_ts: None,
                status: domain::ports::SimSessionStatus::Running, source: s.source.clone(),
            });
            Ok(())
        }
        async fn get_session(&self, id: &str) -> anyhow::Result<Option<domain::ports::SimSessionView>> {
            Ok(self.sessions.lock().unwrap().get(id).cloned())
        }
        async fn list_sessions(&self) -> anyhow::Result<Vec<domain::ports::SimSessionView>> {
            Ok(self.sessions.lock().unwrap().values().cloned().collect())
        }
        async fn append_trade(&self, t: &domain::ports::NewSimTrade) -> anyhow::Result<()> {
            self.trades.lock().unwrap().push(t.clone());
            Ok(())
        }
        async fn list_trades(&self, session_id: &str) -> anyhow::Result<Vec<domain::ports::NewSimTrade>> {
            Ok(self.trades.lock().unwrap().iter().filter(|t| t.session_id == session_id).cloned().collect())
        }
        async fn update_positions(&self, session_id: &str, _: &[domain::ports::SimPositionRow]) -> anyhow::Result<()> {
            // 留空：get_positions 读模型走状态重建，不依赖此表。
            let _ = session_id;
            Ok(())
        }
        async fn upsert_state(&self, session_id: &str, state: &domain::ports::SimSessionState) -> anyhow::Result<()> {
            self.states.lock().unwrap().insert(session_id.into(), state.clone());
            Ok(())
        }
        async fn get_state(&self, session_id: &str) -> anyhow::Result<Option<domain::ports::SimSessionState>> {
            Ok(self.states.lock().unwrap().get(session_id).cloned())
        }
        async fn mark_end(&self, id: &str, end_ts: DateTime<Utc>, result: &domain::ports::SimSessionResult) -> anyhow::Result<bool> {
            let mut s = self.sessions.lock().unwrap();
            let Some(v) = s.get_mut(id) else { return Ok(false) };
            if v.status != domain::ports::SimSessionStatus::Running { return Ok(false) }
            v.status = domain::ports::SimSessionStatus::Ended;
            v.end_ts = Some(end_ts);
            self.results.lock().unwrap().insert(id.into(), result.clone());
            Ok(true)
        }
        async fn get_result(&self, id: &str) -> anyhow::Result<Option<domain::ports::SimSessionResult>> {
            Ok(self.results.lock().unwrap().get(id).cloned())
        }
        async fn delete_session(&self, id: &str) -> anyhow::Result<bool> {
            Ok(self.sessions.lock().unwrap().remove(id).is_some())
        }
    }

    struct FixedClock(DateTime<Utc>);
    impl domain::ports::Clock for FixedClock { fn now(&self) -> DateTime<Utc> { self.0 } }

    /// P4a sim 测试插件真身（strategy-core 参考插件：与 Rust 内建 1:1 迁移，80/20/50 评分口径）。
    fn sim_reference_js(id: &str) -> &'static str {
        strategy_core::reference::reference_plugins()
            .into_iter()
            .find(|p| p.id == id)
            .unwrap_or_else(|| panic!("参考插件不存在: {id}"))
            .code
    }

    /// P4a：播种 sim 用 Registry（dual_ma/momentum 参考插件 published；id 直用插件 id 便于测试）。
    fn sim_registry() -> Arc<MockStrategyStore> {
        let reg = Arc::new(MockStrategyStore::default());
        reg.seed_published("dual_ma", "双均线交叉", sim_reference_js("dual_ma"), json!([
            { "key": "fast", "type": "int", "default": 5.0, "min": 2.0, "max": 200.0 },
            { "key": "slow", "type": "int", "default": 20.0, "min": 2.0, "max": 250.0 }
        ]));
        reg.seed_published("momentum", "动量突破", sim_reference_js("momentum"), json!([
            { "key": "lookback", "type": "int", "default": 20.0, "min": 2.0, "max": 150.0 }
        ]));
        reg
    }

    fn sim_state() -> Arc<McpState> {
        let store = Arc::new(MockSimStore::default());
        let registry = sim_registry();
        let clock = Arc::new(FixedClock(Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()));
        let svc = application::simlive::SimLiveService::with_default_fee(store, clock.clone())
            .with_strategies(registry.clone());
        // strategies service 同源（sim_list_strategies P4a 数据源 = Registry catalog）。
        let strategies = Arc::new(application::strategy::StrategyService::new(
            registry, Arc::new(MockStrategyBars), clock));
        Arc::new(McpState {
            kline: Arc::new(MockKline::new()),
            health: diagnose::health::HealthService::new(Arc::new(MockEvents::new())),
            quality: quality_for(vec![], std::collections::HashMap::new(), std::collections::HashSet::new()),
            default_window_secs: 3600,
            sessions: crate::state::SessionRegistry::default(),

            strategies: Some(strategies),
            workbench: None,
            strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            sim: Some(Arc::new(svc)),
        })
    }

    #[tokio::test]
    async fn sim_start_session_and_get_account_happy() {
        let st = sim_state();
        let r = call(&st, "sim_start_session", json!({ "name": "t1", "period": "M1", "cash_init": 200000 })).await;
        let p = payload_of(&r);
        assert!(p["id"].as_str().unwrap().starts_with("s_"), "会话 id s_ 前缀");
        assert_eq!(p["name"], "t1");
        assert_eq!(p["cash_init"], json!(200000.0), "cash_init 透传");
        assert_eq!(p["status"], "running");

        let sid = p["id"].as_str().unwrap();
        let r = call(&st, "sim_get_account", json!({ "session_id": sid })).await;
        let p = payload_of(&r);
        assert_eq!(p["cash"], json!(200000.0));
        assert_eq!(p["equity"], json!(200000.0));
    }

    // ADR §4 多策略：MCP sim_start_session 带 strategies → 编排器按每策略 参数/标的集 配置（固定输入断言）。
    #[tokio::test]
    async fn sim_start_session_with_strategies_wires_orchestrator() {
        let st = sim_state();
        let svc = st.sim.clone().unwrap();
        let r = call(&st, "sim_start_session", json!({
            "name": "s1", "period": "M1",
            "strategies": [{ "strategy_id": "dual_ma", "params": { "fast": 2.0, "slow": 3.0 }, "stocks": ["510300"], "weight": 2.0 }],
        })).await;
        let p = payload_of(&r);
        assert_eq!(p["status"], "running");
        let sid = p["id"].as_str().unwrap().to_string();
        // 会话级 strategy_set/stock_set 由策略派生。
        let r = call(&st, "sim_get_session", json!({ "session_id": sid })).await;
        let p = payload_of(&r);
        assert_eq!(p["session"]["strategy_set"], json!(["dual_ma"]));
        assert_eq!(p["session"]["stock_set"], json!(["510300"]));

        // 喂入先低后高序列 → dual_ma 金叉 → Buy(100)；编排器已用 per-strategy 参数。
        for (i, c) in [12.0, 8.0, 9.0, 14.0].into_iter().enumerate() {
            svc.process_bar(&sid, "510300", backtest::Bar {
                ts: 100 + i as i64, open: c, high: c, low: c, close: c, volume: 10_000.0,
            }).await.unwrap();
        }
        let r = call(&st, "sim_get_strategy_signal", json!({ "session_id": sid, "code": "510300" })).await;
        let p = payload_of(&r);
        assert_eq!(p["signal"], "buy");
        assert_eq!(p["aggregate_score"], json!(80.0));
        assert_eq!(p["per_strategy_scores"][0]["strategy_id"], "dual_ma");
        // 未覆盖标的不评估。
        let r = call(&st, "sim_get_strategy_signal", json!({ "session_id": sid, "code": "999999" })).await;
        assert_eq!(payload_of(&r)["evaluation"], json!(null));
    }

    // ADR §4：MCP sim_start_session 带非法 strategies → isError（未知 id / weight≤0）。
    #[tokio::test]
    async fn sim_start_session_invalid_strategies_is_error() {
        let st = sim_state();
        let r = call(&st, "sim_start_session", json!({
            "name": "s2", "period": "M1",
            "strategies": [{ "strategy_id": "bad", "stocks": ["510300"] }],
        })).await;
        assert_eq!(r["result"]["isError"], true, "未知策略 id → isError");
        let st2 = sim_state();
        let r = call(&st2, "sim_start_session", json!({
            "name": "s2", "period": "M1",
            "strategies": [{ "strategy_id": "dual_ma", "stocks": ["510300"], "weight": 0.0 }],
        })).await;
        assert_eq!(r["result"]["isError"], true, "weight≤0 → isError");
    }

    /// P4a 破坏性 wire 变更：旧内建 id（注册表无此 strategy_id）→ isError + 明确引导 strategy_list。
    #[tokio::test]
    async fn sim_start_session_legacy_builtin_id_rejected_with_guidance() {
        let st = sim_state();
        let r = call(&st, "sim_start_session", json!({
            "name": "legacy", "period": "M1",
            "strategies": [{ "strategy_id": "kdj", "stocks": ["510300"] }],
        })).await;
        assert_eq!(r["result"]["isError"], true, "未播种的 kdj（旧内建 id 形态）→ isError");
        let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("未知策略 id"), "错误提示未知策略：{text}");
        assert!(text.contains("strategy_list"), "引导 strategy_list：{text}");

        // 未发布（仅 draft）策略 → isError。
        let st2 = sim_state();
        let r = call(&st2, "sim_start_session", json!({
            "name": "draft-only", "period": "M1",
            "strategies": [{ "strategy_id": "dual_ma", "version_id": "sv_not_exist", "stocks": ["510300"] }],
        })).await;
        assert_eq!(r["result"]["isError"], true, "不存在版本 → isError");
    }

    #[tokio::test]
    async fn sim_place_order_market_fills_and_updates_account() {
        let st = sim_state();
        let r = call(&st, "sim_start_session", json!({ "name": "t1", "period": "M1" })).await;
        let sid = payload_of(&r)["id"].as_str().unwrap().to_string();
        let r = call(&st, "sim_place_order", json!({ "session_id": sid, "code": "510300", "side": "buy", "qty": 1000, "price": 10.0 })).await;
        let p = payload_of(&r);
        assert_eq!(p["filled"], true, "市价即时成交");
        assert!(p["fill"]["price"].as_f64().unwrap() > 10.0, "含滑点");
        // 账户现金减少、持仓存在
        let r = call(&st, "sim_get_account", json!({ "session_id": sid })).await;
        assert!(payload_of(&r)["cash"].as_f64().unwrap() < 1_000_000.0);
        let r = call(&st, "sim_get_positions", json!({ "session_id": sid })).await;
        let pos = &payload_of(&r)["positions"][0];
        assert_eq!(pos["code"], "510300");
        assert_eq!(pos["qty"], json!(1000.0));
    }

    #[tokio::test]
    async fn sim_place_order_limit_not_touched_pending() {
        let st = sim_state();
        let r = call(&st, "sim_start_session", json!({ "name": "t1", "period": "M1" })).await;
        let sid = payload_of(&r)["id"].as_str().unwrap().to_string();
        // 限价买 9，最新 10.5 > 9 → 不触及
        let r = call(&st, "sim_place_order", json!({ "session_id": sid, "code": "510300", "side": "buy", "qty": 1000, "price": 10.5, "limit_price": 9.0 })).await;
        let p = payload_of(&r);
        assert_eq!(p["filled"], false, "限价未触及 pending");
        // pending 单可查
        let r = call(&st, "sim_get_orders", json!({ "session_id": sid })).await;
        assert_eq!(payload_of(&r)["orders"][0]["status"], "pending");
    }

    #[tokio::test]
    async fn sim_tool_unconfigured_returns_is_error() {
        let st = test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()));
        let r = call(&st, "sim_get_account", json!({ "session_id": "x" })).await;
        assert_eq!(r["result"]["isError"], true, "sim=None → 工具错误帧");
    }

    /// L3b：mcp-toggle 关闭后 sim_* 工具返回 isError；重开后恢复（共享同一实例）。
    #[tokio::test]
    async fn sim_tools_gated_by_mcp_enabled_toggle() {
        let st = sim_state();
        let r = call(&st, "sim_start_session", json!({ "name": "t1", "period": "M1" })).await;
        let sid = payload_of(&r)["id"].as_str().unwrap().to_string();

        // 关闭 MCP 服务开关（共享实例）→ sim_get_account 错误帧。
        let svc = st.sim.clone().unwrap();
        assert!(!svc.set_mcp_enabled(false));
        let r = call(&st, "sim_get_account", json!({ "session_id": sid })).await;
        assert_eq!(r["result"]["isError"], true, "关闭后 sim_* 工具 isError");
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("停用"),
            "描述含停用提示");

        // 重开 → 恢复（成功帧无 isError，payload 返回账户）。
        assert!(svc.set_mcp_enabled(true));
        let r = call(&st, "sim_get_account", json!({ "session_id": sid })).await;
        assert_ne!(r["result"]["isError"], true, "重开后工具不再 isError");
        assert!(payload_of(&r)["cash"].as_f64().unwrap() > 0.0, "恢复后返回账户");
    }

    #[tokio::test]
    async fn sim_place_order_param_validation_is_32602() {
        let st = sim_state();
        let r = call(&st, "sim_start_session", json!({ "name": "t1", "period": "M1" })).await;
        let p = payload_of(&r);
        let sid = p["id"].as_str().unwrap();
        for args in [json!({ "session_id": sid, "code": "510300", "side": "buy", "qty": 1000 }),  // 缺 price
                     json!({ "session_id": sid, "side": "buy", "qty": 1000, "price": 10.0 }), // 缺 code
                     json!({ "session_id": sid, "code": "510300", "qty": 1000, "price": 10.0 }), // 缺 side
                     json!({ "code": "510300", "side": "buy", "qty": 1000, "price": 10.0 })] {
            let r = call(&st, "sim_place_order", args.clone()).await;
            assert_eq!(r["error"]["code"], -32602, "{args} → invalid params");
        }
    }

    // ── 11-sim-live / L2：sim_* 策略工具（sim_list_strategies / sim_get_strategy_signal / sim_get_strategy_analysis）──

    /// P4a：数据源 = Registry catalog（仅 published 最新版本；{strategy, version} 条目）。
    #[tokio::test]
    async fn sim_list_strategies_returns_catalog() {
        let st = sim_state();
        let r = call(&st, "sim_list_strategies", json!({})).await;
        let p = payload_of(&r);
        let arr = p.as_array().expect("策略目录为数组");
        assert_eq!(arr.len(), 2, "mock registry 播种 dual_ma + momentum");
        assert!(arr.iter().all(|e| e["strategy"]["id"].is_string()
            && e["strategy"]["name"].is_string()
            && e["version"]["id"].is_string()
            && e["version"]["params_schema"].is_array()
            && e["version"]["status"] == "published"), "每项为 catalog 条目（strategy+published version）");
        assert_eq!(arr[0]["strategy"]["id"], "dual_ma");
        assert_eq!(arr[0]["version"]["id"], "sv_dual_ma");
    }

    #[tokio::test]
    async fn sim_list_strategies_filter_by_id() {
        let st = sim_state();
        let r = call(&st, "sim_list_strategies", json!({ "strategy_id": "momentum" })).await;
        let p = payload_of(&r);
        let arr = p.as_array().unwrap();
        assert_eq!(arr.len(), 1, "过滤后仅 1 项");
        assert_eq!(arr[0]["strategy"]["id"], "momentum");
    }

    #[tokio::test]
    async fn sim_get_strategy_signal_and_analysis_happy() {
        let st = sim_state();
        let svc = st.sim.clone().unwrap();
        let r = call(&st, "sim_start_session", json!({ "name": "t1", "period": "M1" })).await;
        let sid = payload_of(&r)["id"].as_str().unwrap().to_string();

        // 配置双均线（先低后高序列末 bar 金叉 → 80 分 Buy 区）。
        let configs = vec![application::simlive::StrategyConfigInput {
            strategy_id: "dual_ma".into(),
            version_id: None,
            params: json!({ "fast": 2.0, "slow": 3.0 }),
            stocks: vec!["510300".into()],
            weight: 1.0,
            stock_weights: std::collections::HashMap::new(),
        }];
        svc.configure_strategies(&sid, configs).await.unwrap();
        for (i, c) in [12.0, 8.0, 9.0, 14.0].into_iter().enumerate() {
            svc.process_bar(
                &sid, "510300",
                backtest::Bar { ts: 100 + i as i64, open: c, high: c, low: c, close: c, volume: 10_000.0 },
            ).await.unwrap();
        }

        // 单标的信号：聚合分=80（插件 Buy 区高分）、信号=buy、含各策略独立分。
        let r = call(&st, "sim_get_strategy_signal", json!({ "session_id": sid, "code": "510300" })).await;
        let p = payload_of(&r);
        assert_eq!(p["code"], "510300");
        assert_eq!(p["signal"], "buy");
        assert_eq!(p["aggregate_score"], json!(80.0));
        assert_eq!(p["per_strategy_scores"][0]["strategy_id"], "dual_ma");
        assert_eq!(p["latest_price"], json!(14.0));

        // 未评估标的目标 → evaluation null。
        let r = call(&st, "sim_get_strategy_signal", json!({ "session_id": sid, "code": "999999" })).await;
        assert_eq!(payload_of(&r)["evaluation"], json!(null));

        // 多标的评估概览。
        let r = call(&st, "sim_get_strategy_analysis", json!({ "session_id": sid })).await;
        let p = payload_of(&r);
        assert_eq!(p["evaluations"].as_array().unwrap().len(), 1);
        assert_eq!(p["evaluations"][0]["code"], "510300");
    }

    #[tokio::test]
    async fn sim_get_strategy_tool_param_validation_is_32602() {
        let st = sim_state();
        let r = call(&st, "sim_get_strategy_signal", json!({ "code": "510300" })).await;
        assert_eq!(r["error"]["code"], -32602, "sim_get_strategy_signal 缺 session_id");
        let r = call(&st, "sim_get_strategy_signal", json!({ "session_id": "s_x", "code": "" })).await;
        assert_eq!(r["error"]["code"], -32602, "code 空");
        let r = call(&st, "sim_get_strategy_analysis", json!({})).await;
        assert_eq!(r["error"]["code"], -32602, "sim_get_strategy_analysis 缺 session_id");
    }

    // ── 11-sim-live / L3：会话记录/详情/回测对比工具 ──

    /// 注入回测工作台的 sim state（P4a：对比走统一 ensemble 引擎；返回可推进时钟，保证 start<end）。
    fn sim_state_with_workbench() -> (Arc<McpState>, Arc<MockStrategyRunStore>, Arc<TestClock>) {
        let store = Arc::new(MockSimStore::default());
        let registry = sim_registry();
        let clock = Arc::new(TestClock(AtomicI64::new(1_784_000_000)));
        let run_store = Arc::new(MockStrategyRunStore::default());
        let preset_store = Arc::new(MockStrategyPresetStore::default());
        let workbench = Arc::new(application::workbench::WorkbenchService::new(
            Arc::new(MockStrategyBars), run_store.clone(), preset_store, registry.clone(),
            Arc::new(MockSimCompareSymbols), Arc::new(MockStrategySink), clock.clone(), 1));
        let svc = application::simlive::SimLiveService::with_default_fee(store, clock.clone())
            .with_strategies(registry)
            .with_workbench(workbench.clone());
        (Arc::new(McpState {
            kline: Arc::new(MockKline::new()),
            health: diagnose::health::HealthService::new(Arc::new(MockEvents::new())),
            quality: quality_for(vec![], std::collections::HashMap::new(), std::collections::HashSet::new()),
            default_window_secs: 3600,
            sessions: crate::state::SessionRegistry::default(),

            strategies: None,
            workbench: Some(workbench),
            strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            sim: Some(Arc::new(svc)),
        }), run_store, clock)
    }

    /// 对比回测 symbol 注册表 mock（含 510300）。
    struct MockSimCompareSymbols;
    #[async_trait::async_trait]
    impl domain::ports::SymbolRegistry for MockSimCompareSymbols {
        async fn enabled_codes(&self) -> anyhow::Result<Vec<domain::types::Code>> {
            Ok(vec![domain::types::Code("510300".into()), domain::types::Code("600000".into())])
        }
        async fn interval_secs(&self, _: &domain::types::Code) -> anyhow::Result<u64> { Ok(60) }
        async fn upsert(&self, _: domain::types::Code, _: u64, _: bool) -> anyhow::Result<()> { Ok(()) }
    }

    struct TestClock(AtomicI64);
    impl domain::ports::Clock for TestClock {
        fn now(&self) -> DateTime<Utc> { DateTime::from_timestamp(self.0.load(Ordering::Relaxed), 0).unwrap() }
    }
    impl TestClock {
        fn set(&self, ts: i64) { self.0.store(ts, Ordering::Relaxed); }
    }

    #[tokio::test]
    async fn sim_list_and_get_session_returns_history() {
        let st = sim_state();
        let svc = st.sim.clone().unwrap();
        let r = call(&st, "sim_start_session", json!({ "name": "h1", "period": "M1", "cash_init": 200000 })).await;
        let sid = payload_of(&r)["id"].as_str().unwrap().to_string();
        // 放一单再 stop，产生结束结果。
        let _ = svc.place_order(&sid, &application::simlive::PlaceOrderReq {
            code: "510300".into(), side: "buy".into(), qty: 1000.0,
            limit_price: None, intent_id: None, source: "manual".into(),
        }, 10.0).await.unwrap();
        assert!(svc.stop_session(&sid).await.unwrap());

        // 列表：已结束会话附指标摘要。
        let r = call(&st, "sim_list_sessions", json!({})).await;
        let list = payload_of(&r);
        let arr = list.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["session"]["id"], json!(sid));
        assert_eq!(arr[0]["session"]["status"], "ended");
        assert!(arr[0]["metrics"]["trade_count"].is_number());

        // 详情：元数据 + 结束结果。
        let r = call(&st, "sim_get_session", json!({ "session_id": sid })).await;
        let p = payload_of(&r);
        assert_eq!(p["session"]["id"], json!(sid));
        assert!(p["result"]["metrics"]["sharpe"].is_number());
        assert!(p["result"]["net_value"]["series"].is_array());

        // 未知会话 → session:null.
        let r = call(&st, "sim_get_session", json!({ "session_id": "no-such" })).await;
        assert_eq!(payload_of(&r)["session"], json!(null));
    }

    /// P4a：对比走统一 ensemble 引擎——每标的 1 个 ensemble run（钉住 slots + 会话阈值 + LumpSum 全仓）。
    #[tokio::test]
    async fn sim_run_backtest_compare_triggers_run() {
        let (st, run_store, clock) = sim_state_with_workbench();
        let svc = st.sim.clone().unwrap();
        let r = call(&st, "sim_start_session", json!({ "name": "c1", "period": "M1", "cash_init": 200000,
            "strategy_set": ["dual_ma"], "stock_set": ["510300"] })).await;
        let sid = payload_of(&r)["id"].as_str().unwrap().to_string();
        let _ = svc.place_order(&sid, &application::simlive::PlaceOrderReq {
            code: "510300".into(), side: "buy".into(), qty: 100.0,
            limit_price: None, intent_id: None, source: "manual".into(),
        }, 10.0).await.unwrap();
        // 推进时钟使 start<end。
        clock.set(1_784_003_600);
        assert!(svc.stop_session(&sid).await.unwrap());

        let r = call(&st, "sim_run_backtest_compare", json!({ "session_id": sid })).await;
        let p = payload_of(&r);
        let run_ids = p["run_ids"].as_array().unwrap();
        assert_eq!(run_ids.len(), 1, "单 stock × 1 覆盖策略 → 1 个 ensemble run");
        assert!(run_ids[0].as_str().unwrap().starts_with("sr_"), "run id 为 sr_ 前缀字符串");
        assert!(p["session_result"]["metrics"]["trade_count"].is_number());
        // 钉住快照：slots[0] = 钉住版本（sv_dual_ma）+ 阈值 60/40 + LumpSum。
        let runs = run_store.runs.lock().unwrap();
        assert_eq!(runs.len(), 1);
        let run = runs.values().next().unwrap();
        assert_eq!(run.symbol, "510300");
        assert_eq!(run.period, "M1");
        let slots = run.config["slots"].as_array().unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0]["strategy_id"], json!("dual_ma"));
        assert_eq!(slots[0]["version_id"], json!("sv_dual_ma"));
        assert_eq!(run.config["buy_threshold"], json!(60.0));
        assert_eq!(run.config["sell_threshold"], json!(40.0));
        assert_eq!(run.config["policy"], json!({ "LumpSum": { "position_pct": 1.0 } }));
        assert!(run.to_ts > run.from_ts);
    }

    #[tokio::test]
    async fn sim_l3_param_validation_is_32602() {
        let st = sim_state();
        let r = call(&st, "sim_get_session", json!({})).await;
        assert_eq!(r["error"]["code"], -32602, "sim_get_session 缺 session_id");
        let r = call(&st, "sim_run_backtest_compare", json!({})).await;
        assert_eq!(r["error"]["code"], -32602, "sim_run_backtest_compare 缺 session_id");
        // sim_list_sessions 无参数，正常调用（sim 未注入 backtest 也能列出）。
        let r = call(&st, "sim_list_sessions", json!({})).await;
        let p = payload_of(&r);
        assert!(p.is_array());
    }

    // ── 12-strategy-system / P3c：strategy_*/bt_* 工具族（统一策略系统 Registry + 回测工作台）──
    // 真实 StrategyService/WorkbenchService + 全内存 mock 端口（无 DB；与 application 测试同工艺）。

    /// 恒分插件（恒 80 分 → Buy 区；无 PARAMS_SCHEMA，发布门禁/试算均可用）。
    const CONST_80: &str = "function on_bar(ctx) { return 80; }";
    /// 恒分 42（纯评分断言用）。
    const CONST_42: &str = "function on_bar(ctx) { return 42; }";

    fn p3c_now() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 9, 1, 0, 0).unwrap() }

    fn p3c_bar(i: i64, close: f64) -> domain::types::Bar {
        domain::types::Bar {
            code: domain::types::Code("600000".into()),
            period: Period::D1,
            ts: Utc.with_ymd_and_hms(2026, 9, 1, 1, 30, 0).unwrap() + chrono::Duration::days(i),
            open: close, high: close + 1.0, low: close - 1.0, close,
            volume: 1000, amount: close * 1000.0,
            source: domain::types::SourceId::Tushare,
        }
    }

    /// 6 根日线（100,100,110,110,100,100）。
    fn p3c_bars() -> Vec<domain::types::Bar> {
        [100.0, 100.0, 110.0, 110.0, 100.0, 100.0]
            .iter().enumerate().map(|(i, c)| p3c_bar(i as i64, *c)).collect()
    }

    struct MockStrategyBars;
    #[async_trait::async_trait]
    impl BacktestBarRead for MockStrategyBars {
        async fn bars(&self, _: &str, _: &Period, _: DateTime<Utc>, _: DateTime<Utc>)
            -> anyhow::Result<Vec<domain::types::Bar>> {
            Ok(p3c_bars())
        }
    }

    struct MockStrategySymbols;
    #[async_trait::async_trait]
    impl domain::ports::SymbolRegistry for MockStrategySymbols {
        async fn enabled_codes(&self) -> anyhow::Result<Vec<domain::types::Code>> {
            Ok(vec![domain::types::Code("600000".into())])
        }
        async fn interval_secs(&self, _: &domain::types::Code) -> anyhow::Result<u64> { Ok(60) }
        async fn upsert(&self, _: domain::types::Code, _: u64, _: bool) -> anyhow::Result<()> { Ok(()) }
    }

    #[derive(Default)]
    struct MockStrategySink;
    #[async_trait::async_trait]
    impl domain::ports::StrategyRunProgressSink for MockStrategySink {
        async fn send(&self, _: &str, _: f64, _: Option<DateTime<Utc>>) -> anyhow::Result<()> { Ok(()) }
    }

    /// 全内存 StrategyStore（与 Pg 同语义子集：状态机原语 + catalog 最新 published/at-least 过滤）。
    #[derive(Default)]
    struct MockStrategyStore {
        strategies: std::sync::Mutex<std::collections::HashMap<String, domain::ports::StrategyRow>>,
        versions: std::sync::Mutex<std::collections::HashMap<String, domain::ports::StrategyVersionRow>>,
    }

    impl MockStrategyStore {
        /// P4a：直插 published 策略（version=1，version_id = "sv_{strategy_id}"；sim_* 切源测试播种用）。
        fn seed_published(&self, strategy_id: &str, name: &str, code: &str, params_schema: serde_json::Value) {
            self.strategies.lock().unwrap().insert(strategy_id.to_string(), domain::ports::StrategyRow {
                id: strategy_id.to_string(), name: name.to_string(), description: String::new(),
                kind: domain::strategy_state::StrategyKind::Strategy, created_by: "test".into(),
                created_at: p3c_now(), updated_at: p3c_now(),
            });
            self.versions.lock().unwrap().insert(format!("sv_{strategy_id}"), domain::ports::StrategyVersionRow {
                id: format!("sv_{strategy_id}"), strategy_id: strategy_id.to_string(), version: 1,
                code: code.to_string(), params_schema,
                sha256: application::strategy::sha256_hex(code),
                status: domain::strategy_state::StrategyStatus::Published,
                approval_level: domain::strategy_state::ApprovalLevel::BacktestOk,
                created_at: p3c_now(), published_at: Some(p3c_now()),
            });
        }
    }

    #[async_trait::async_trait]
    impl domain::ports::StrategyStore for MockStrategyStore {
        async fn create_strategy(&self, s: &domain::ports::NewStrategy) -> anyhow::Result<domain::ports::StrategyRow> {
            let row = domain::ports::StrategyRow {
                id: s.id.clone(), name: s.name.clone(), description: s.description.clone(),
                kind: s.kind, created_by: s.created_by.clone(),
                created_at: p3c_now(), updated_at: p3c_now(),
            };
            self.strategies.lock().unwrap().insert(s.id.clone(), row.clone());
            Ok(row)
        }
        async fn get_strategy(&self, id: &str) -> anyhow::Result<Option<domain::ports::StrategyRow>> {
            Ok(self.strategies.lock().unwrap().get(id).cloned())
        }
        async fn count_strategies(&self) -> anyhow::Result<i64> {
            Ok(self.strategies.lock().unwrap().len() as i64)
        }
        async fn catalog(&self, level: Option<domain::strategy_state::ApprovalLevel>,
                         kind: Option<domain::strategy_state::StrategyKind>)
            -> anyhow::Result<Vec<domain::ports::CatalogEntry>> {
            let strategies = self.strategies.lock().unwrap();
            let versions = self.versions.lock().unwrap();
            let mut out = Vec::new();
            for s in strategies.values() {
                if kind.is_some_and(|k| s.kind != k) { continue; }
                let Some(v) = versions.values()
                    .filter(|v| v.strategy_id == s.id
                        && v.status == domain::strategy_state::StrategyStatus::Published)
                    .max_by_key(|v| v.version) else { continue; };
                if level.is_some_and(|l| !v.approval_level.satisfies(&l)) { continue; }
                out.push(domain::ports::CatalogEntry { strategy: s.clone(), version: v.clone() });
            }
            out.sort_by(|a, b| a.strategy.id.cmp(&b.strategy.id));
            Ok(out)
        }
        async fn create_version(&self, v: &domain::ports::NewStrategyVersion) -> anyhow::Result<domain::ports::StrategyVersionRow> {
            let row = domain::ports::StrategyVersionRow {
                id: v.id.clone(), strategy_id: v.strategy_id.clone(), version: v.version,
                code: v.code.clone(), params_schema: v.params_schema.clone(), sha256: v.sha256.clone(),
                status: domain::strategy_state::StrategyStatus::Draft,
                approval_level: domain::strategy_state::ApprovalLevel::BacktestOk,
                created_at: p3c_now(), published_at: None,
            };
            self.versions.lock().unwrap().insert(v.id.clone(), row.clone());
            Ok(row)
        }
        async fn get_version(&self, id: &str) -> anyhow::Result<Option<domain::ports::StrategyVersionRow>> {
            Ok(self.versions.lock().unwrap().get(id).cloned())
        }
        async fn find_version_by_name_sha(&self, name: &str, sha256: &str)
            -> anyhow::Result<Option<domain::ports::StrategyVersionRow>> {
            let strategies = self.strategies.lock().unwrap();
            Ok(self.versions.lock().unwrap().values()
                .find(|v| v.sha256 == sha256
                    && strategies.get(&v.strategy_id).is_some_and(|s| s.name == name))
                .cloned())
        }
        async fn list_versions(&self, strategy_id: &str) -> anyhow::Result<Vec<domain::ports::StrategyVersionRow>> {
            let mut out: Vec<_> = self.versions.lock().unwrap().values()
                .filter(|v| v.strategy_id == strategy_id).cloned().collect();
            out.sort_by_key(|v| v.version);
            Ok(out)
        }
        async fn next_version_number(&self, strategy_id: &str) -> anyhow::Result<i32> {
            Ok(self.versions.lock().unwrap().values()
                .filter(|v| v.strategy_id == strategy_id)
                .map(|v| v.version).max().unwrap_or(0) + 1)
        }
        async fn update_draft(&self, id: &str, code: &str, params_schema: &serde_json::Value, sha256: &str)
            -> anyhow::Result<Option<domain::ports::StrategyVersionRow>> {
            let mut versions = self.versions.lock().unwrap();
            let Some(v) = versions.get_mut(id) else { return Ok(None) };
            if v.status != domain::strategy_state::StrategyStatus::Draft { return Ok(None) }
            v.code = code.into();
            v.params_schema = params_schema.clone();
            v.sha256 = sha256.into();
            Ok(Some(v.clone()))
        }
        async fn mark_published(&self, id: &str, expected_code: &str, sha256: &str,
                                params_schema: &serde_json::Value, published_at: DateTime<Utc>)
            -> anyhow::Result<Option<domain::ports::StrategyVersionRow>> {
            let mut versions = self.versions.lock().unwrap();
            let Some(v) = versions.get_mut(id) else { return Ok(None) };
            if v.status != domain::strategy_state::StrategyStatus::Draft || v.code != expected_code {
                return Ok(None)
            }
            v.status = domain::strategy_state::StrategyStatus::Published;
            v.sha256 = sha256.into();
            v.params_schema = params_schema.clone();
            v.published_at = Some(published_at);
            Ok(Some(v.clone()))
        }
        async fn set_status(&self, id: &str, status: domain::strategy_state::StrategyStatus)
            -> anyhow::Result<Option<domain::ports::StrategyVersionRow>> {
            let mut versions = self.versions.lock().unwrap();
            let Some(v) = versions.get_mut(id) else { return Ok(None) };
            v.status = status;
            Ok(Some(v.clone()))
        }
        async fn manage_list(&self, _: Option<domain::strategy_state::StrategyKind>)
            -> anyhow::Result<Vec<domain::ports::StrategyManageItem>> {
            unimplemented!("MCP 不暴露 manage_list")
        }
        async fn update_meta(&self, _: &str, _: &str, _: &str) -> anyhow::Result<Option<domain::ports::StrategyRow>> {
            unimplemented!("MCP 不暴露 update_meta")
        }
        async fn delete_strategy(&self, _: &str) -> anyhow::Result<u64> {
            unimplemented!("MCP 不暴露 delete_strategy")
        }
    }

    /// 全内存 StrategyRunStore（条件更新/原子认领与 Pg 同语义；结果级联）。
    #[derive(Default)]
    struct MockStrategyRunStore {
        runs: std::sync::Mutex<std::collections::HashMap<String, domain::ports::StrategyRunView>>,
        results: std::sync::Mutex<std::collections::HashMap<String, domain::ports::StrategyRunResult>>,
    }

    impl MockStrategyRunStore {
        /// 直插 queued 行（不触发后台任务；取消语义确定性测试用）。
        fn insert_queued(&self, id: &str) {
            self.runs.lock().unwrap().insert(id.into(), domain::ports::StrategyRunView {
                id: id.into(), name: "seed".into(), symbol: "600000".into(), period: "D1".into(),
                from_ts: p3c_now(), to_ts: p3c_now(), config: json!({}),
                status: domain::ports::StrategyRunStatus::Queued, progress: 0.0, error: None,
                created_at: p3c_now(), started_at: None, finished_at: None,
            });
        }
    }

    #[async_trait::async_trait]
    impl domain::ports::StrategyRunStore for MockStrategyRunStore {
        async fn create_run(&self, run: &domain::ports::NewStrategyRun) -> anyhow::Result<domain::ports::StrategyRunView> {
            let view = domain::ports::StrategyRunView {
                id: run.id.clone(), name: run.name.clone(), symbol: run.symbol.clone(),
                period: run.period.clone(), from_ts: run.from_ts, to_ts: run.to_ts,
                config: run.config.clone(), status: domain::ports::StrategyRunStatus::Queued,
                progress: 0.0, error: None, created_at: p3c_now(), started_at: None, finished_at: None,
            };
            self.runs.lock().unwrap().insert(run.id.clone(), view.clone());
            Ok(view)
        }
        async fn get_run(&self, id: &str) -> anyhow::Result<Option<domain::ports::StrategyRunView>> {
            Ok(self.runs.lock().unwrap().get(id).cloned())
        }
        async fn list_runs(&self, filter: &domain::ports::StrategyRunFilter) -> anyhow::Result<Vec<domain::ports::StrategyRunView>> {
            let mut all: Vec<_> = self.runs.lock().unwrap().values().cloned().collect();
            all.sort_by(|a, b| (b.created_at, &b.id).cmp(&(a.created_at, &a.id)));
            Ok(all.into_iter()
                .filter(|r| filter.status.is_none_or(|s| r.status == s))
                .skip(filter.offset as usize).take(filter.limit as usize).collect())
        }
        async fn mark_started(&self, id: &str, started_at: DateTime<Utc>) -> anyhow::Result<bool> {
            let mut runs = self.runs.lock().unwrap();
            let Some(r) = runs.get_mut(id) else { return Ok(false) };
            if r.status != domain::ports::StrategyRunStatus::Queued { return Ok(false) }
            r.status = domain::ports::StrategyRunStatus::Running;
            r.started_at = Some(started_at);
            Ok(true)
        }
        async fn update_progress(&self, id: &str, progress: f64) -> anyhow::Result<()> {
            let mut runs = self.runs.lock().unwrap();
            if let Some(r) = runs.get_mut(id) {
                if r.status == domain::ports::StrategyRunStatus::Running { r.progress = progress; }
            }
            Ok(())
        }
        async fn mark_succeeded(&self, id: &str, result: &domain::ports::StrategyRunResult, finished_at: DateTime<Utc>) -> anyhow::Result<bool> {
            let mut runs = self.runs.lock().unwrap();
            let Some(r) = runs.get_mut(id) else { return Ok(false) };
            if r.status != domain::ports::StrategyRunStatus::Running { return Ok(false) }
            r.status = domain::ports::StrategyRunStatus::Succeeded;
            r.progress = 1.0;
            r.finished_at = Some(finished_at);
            self.results.lock().unwrap().insert(id.into(), result.clone());
            Ok(true)
        }
        async fn mark_failed(&self, id: &str, error: &str, finished_at: DateTime<Utc>) -> anyhow::Result<bool> {
            let mut runs = self.runs.lock().unwrap();
            let Some(r) = runs.get_mut(id) else { return Ok(false) };
            if r.status != domain::ports::StrategyRunStatus::Queued
                && r.status != domain::ports::StrategyRunStatus::Running { return Ok(false) }
            r.status = domain::ports::StrategyRunStatus::Failed;
            r.error = Some(error.into());
            r.finished_at = Some(finished_at);
            Ok(true)
        }
        async fn mark_canceled(&self, id: &str, finished_at: DateTime<Utc>) -> anyhow::Result<Option<bool>> {
            let mut runs = self.runs.lock().unwrap();
            let Some(r) = runs.get_mut(id) else { return Ok(None) };
            if r.status.is_terminal() { return Ok(Some(false)) }
            r.status = domain::ports::StrategyRunStatus::Canceled;
            r.finished_at = Some(finished_at);
            Ok(Some(true))
        }
        async fn get_result(&self, run_id: &str) -> anyhow::Result<Option<domain::ports::StrategyRunResult>> {
            Ok(self.results.lock().unwrap().get(run_id).cloned())
        }
    }

    /// 全内存 StrategyPresetStore（name UNIQUE 语义）。
    #[derive(Default)]
    struct MockStrategyPresetStore {
        rows: std::sync::Mutex<std::collections::HashMap<String, domain::ports::StrategyPresetRow>>,
    }

    impl MockStrategyPresetStore {
        /// 直插预设行（MCP 侧无 create_preset 工具——CRUD 在 web；测试经 store 播种）。
        fn insert(&self, id: &str, name: &str, config: serde_json::Value) {
            self.rows.lock().unwrap().insert(id.into(), domain::ports::StrategyPresetRow {
                id: id.into(), name: name.into(), config,
                created_at: p3c_now(), updated_at: p3c_now(),
            });
        }
    }

    #[async_trait::async_trait]
    impl domain::ports::StrategyPresetStore for MockStrategyPresetStore {
        async fn create_preset(&self, p: &domain::ports::NewStrategyPreset) -> anyhow::Result<domain::ports::StrategyPresetRow> {
            let row = domain::ports::StrategyPresetRow {
                id: p.id.clone(), name: p.name.clone(), config: p.config.clone(),
                created_at: p3c_now(), updated_at: p3c_now(),
            };
            self.rows.lock().unwrap().insert(p.id.clone(), row.clone());
            Ok(row)
        }
        async fn get_preset(&self, id: &str) -> anyhow::Result<Option<domain::ports::StrategyPresetRow>> {
            Ok(self.rows.lock().unwrap().get(id).cloned())
        }
        async fn find_preset_by_name(&self, name: &str) -> anyhow::Result<Option<domain::ports::StrategyPresetRow>> {
            Ok(self.rows.lock().unwrap().values().find(|r| r.name == name).cloned())
        }
        async fn list_presets(&self) -> anyhow::Result<Vec<domain::ports::StrategyPresetRow>> {
            let mut all: Vec<_> = self.rows.lock().unwrap().values().cloned().collect();
            all.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
            Ok(all)
        }
        async fn update_preset(&self, id: &str, name: &str, config: &serde_json::Value)
            -> anyhow::Result<Option<domain::ports::StrategyPresetRow>> {
            let mut rows = self.rows.lock().unwrap();
            let Some(r) = rows.get_mut(id) else { return Ok(None) };
            r.name = name.into();
            r.config = config.clone();
            Ok(Some(r.clone()))
        }
        async fn delete_preset(&self, id: &str) -> anyhow::Result<bool> {
            Ok(self.rows.lock().unwrap().remove(id).is_some())
        }
    }

    /// P3c 测试夹具（暴露 mock store 供播种/断言）。
    struct P3cFixture {
        run_store: Arc<MockStrategyRunStore>,
        preset_store: Arc<MockStrategyPresetStore>,
    }

    /// 装配 P3c state：真实 StrategyService/WorkbenchService + 内存 mock 端口（开关默认开）。
    /// I-9（D9）：strategy_test_run 走 symbols 注册表校验 → 夹具注册表须含用例 symbol（600000）。
    fn strategy_state() -> (Arc<McpState>, P3cFixture) {
        strategy_state_with_kline(Arc::new(MockKline::with_registered(&["518880", "600000"])))
    }

    /// ADR-019 D11-3 测试替身：`etf_codes` 内的 code 解析为 etf 档案（其余 → None = 无档案）。
    /// 用于锁定「按标的 type 推断费率」而不影响既有「缺省旧默认」用例。
    struct StubEtfFeeProfiles {
        etf_codes: Vec<String>,
    }

    #[async_trait::async_trait]
    impl domain::ports::FeeProfileStore for StubEtfFeeProfiles {
        async fn for_symbol(&self, code: &str)
            -> anyhow::Result<Option<domain::ports::FeeProfileRow>> {
            if !self.etf_codes.iter().any(|c| c == code) { return Ok(None); }
            Ok(Some(domain::ports::FeeProfileRow {
                type_: "etf".into(), commission_rate_pct: 0.025, min_fee: 5.0,
                exchange_fee_pct: 0.0, regulatory_fee_pct: 0.0, stamp_duty_pct: 0.0,
                transfer_fee_pct: 0.0,
                note: "测试档案（全佣口径：经手费/证管费列 0；印花税不征）".into(),
                source: "test".into(),
            }))
        }
    }

    /// 同 strategy_state，但注入自定义 KlineRead（I-9：注册表不可读 fail-closed 用例）。
    fn strategy_state_with_kline(kline: Arc<MockKline>) -> (Arc<McpState>, P3cFixture) {
        strategy_state_full(kline, None)
    }

    /// ADR-019 D11-3：装配 FeeProfileStore 的 P3c state（etf_codes 内的标的解析为 etf 档案）。
    fn strategy_state_with_fee_profiles(kline: Arc<MockKline>, etf_codes: &[&str])
        -> (Arc<McpState>, P3cFixture) {
        strategy_state_full(kline, Some(Arc::new(StubEtfFeeProfiles {
            etf_codes: etf_codes.iter().map(|c| c.to_string()).collect(),
        })))
    }

    fn strategy_state_full(kline: Arc<MockKline>,
                           fee_profiles: Option<Arc<dyn domain::ports::FeeProfileStore>>)
        -> (Arc<McpState>, P3cFixture) {
        let store = Arc::new(MockStrategyStore::default());
        let bars = Arc::new(MockStrategyBars);
        let clock = Arc::new(FixedClock(p3c_now()));
        let run_store = Arc::new(MockStrategyRunStore::default());
        let preset_store = Arc::new(MockStrategyPresetStore::default());
        let mut strategies = application::strategy::StrategyService::new(
            store.clone(), bars.clone(), clock.clone());
        let mut workbench = application::workbench::WorkbenchService::new(
            bars, run_store.clone(), preset_store.clone(), store,
            Arc::new(MockStrategySymbols), Arc::new(MockStrategySink), clock, 2);
        if let Some(fp) = fee_profiles {
            strategies = strategies.with_fee_profiles(fp.clone());
            workbench = workbench.with_fee_profiles(fp);
        }
        let strategies = Arc::new(strategies);
        let workbench = Arc::new(workbench);
        let st = Arc::new(McpState {
            kline,
            health: diagnose::health::HealthService::new(Arc::new(MockEvents::new())),
            quality: quality_for(vec![], std::collections::HashMap::new(), std::collections::HashSet::new()),
            default_window_secs: 3600,
            sessions: crate::state::SessionRegistry::default(),
            sim: None,
            strategies: Some(strategies),
            workbench: Some(workbench),
            strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        });
        (st, P3cFixture { run_store, preset_store })
    }

    /// 建并发布一个策略（返回 (strategy_id, version_id)）。
    async fn create_published(st: &McpState, name: &str, code: &str) -> (String, String) {
        let r = call(st, "strategy_create", json!({ "name": name, "code": code })).await;
        let p = payload_of(&r);
        let sid = p["strategy"]["id"].as_str().unwrap().to_string();
        let vid = p["version"]["id"].as_str().unwrap().to_string();
        let r = call(st, "strategy_publish", json!({ "version_id": vid })).await;
        assert_eq!(payload_of(&r)["status"], "published", "夹具发布须成功");
        (sid, vid)
    }

    #[tokio::test]
    async fn strategy_crud_flow_via_tools() {
        let (st, _fx) = strategy_state();
        // create：v1 draft
        let r = call(&st, "strategy_create", json!({ "name": "恒分80", "description": "t", "code": CONST_80 })).await;
        let p = payload_of(&r);
        let sid = p["strategy"]["id"].as_str().unwrap().to_string();
        let vid = p["version"]["id"].as_str().unwrap().to_string();
        assert!(sid.starts_with("st_"));
        assert!(vid.starts_with("sv_"));
        assert_eq!(p["version"]["version"], 1);
        assert_eq!(p["version"]["status"], "draft");
        // get：详情 + 版本列表
        let r = call(&st, "strategy_get", json!({ "strategy_id": sid })).await;
        let p = payload_of(&r);
        assert_eq!(p["strategy"]["name"], "恒分80");
        assert_eq!(p["versions"].as_array().unwrap().len(), 1);
        // update draft → 原地更新
        let r = call(&st, "strategy_update", json!({ "version_id": vid, "code": CONST_80 })).await;
        let p = payload_of(&r);
        assert_eq!(p["outcome"], "updated");
        assert_eq!(p["version"]["version"], 1);
        // publish
        let r = call(&st, "strategy_publish", json!({ "version_id": vid })).await;
        assert_eq!(payload_of(&r)["status"], "published");
        // update published → 自动落新 draft（ADR §13.5 防呆）
        let r = call(&st, "strategy_update", json!({ "version_id": vid, "code": CONST_42 })).await;
        let p = payload_of(&r);
        assert_eq!(p["outcome"], "new_draft");
        assert_eq!(p["version"]["version"], 2);
        assert_eq!(p["version"]["status"], "draft");
        // list catalog：仅 published（v1）；kind 过滤
        let r = call(&st, "strategy_list", json!({})).await;
        let list = payload_of(&r);
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["strategy"]["id"], json!(sid));
        assert_eq!(list[0]["version"]["id"], json!(vid), "catalog = 最新 published");
        let r = call(&st, "strategy_list", json!({ "kind": "template" })).await;
        assert_eq!(payload_of(&r).as_array().unwrap().len(), 0, "kind=template 过滤");
        let r = call(&st, "strategy_list", json!({ "level": "sim_ok" })).await;
        assert_eq!(payload_of(&r).as_array().unwrap().len(), 0, "backtest_ok 不满足 sim_ok at-least");
        // archive（published→archived）→ catalog 空
        let r = call(&st, "strategy_archive", json!({ "version_id": vid })).await;
        assert_eq!(payload_of(&r)["status"], "archived");
        let r = call(&st, "strategy_list", json!({})).await;
        assert_eq!(payload_of(&r).as_array().unwrap().len(), 0, "archived 不入册");
    }

    #[tokio::test]
    async fn strategy_test_run_inline_and_version_modes() {
        let (st, _fx) = strategy_state();
        // 内联代码 pure_score：裸评分序列
        let r = call(&st, "strategy_test_run", json!({
            "code": CONST_42, "symbol": "600000", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "mode": "pure_score"
        })).await;
        let p = payload_of(&r);
        assert_eq!(p["mode"], "pure_score");
        assert_eq!(p["bar_count"], 6);
        assert_eq!(p["scores"].as_array().unwrap().len(), 6);
        assert_eq!(p["scores"][0]["score"], json!(42.0));
        assert!(p["signals"].as_array().unwrap().is_empty(), "pure_score 无信号");
        // version_id sim_position：逐 bar 信号 + 成交
        let (_sid, vid) = create_published(&st, "恒分80", CONST_80).await;
        let r = call(&st, "strategy_test_run", json!({
            "version_id": vid, "symbol": "600000", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "mode": "sim_position"
        })).await;
        let p = payload_of(&r);
        assert_eq!(p["mode"], "sim_position");
        assert_eq!(p["signals"].as_array().unwrap().len(), 6);
        assert_eq!(p["signals"][0]["signal"], "buy", "恒 80 ≥ 60 阈值");
        assert!(!p["trades"].as_array().unwrap().is_empty(), "LumpSum 有成交");
        // I-6/D3：H1 周期被接受（原「H1 拒绝」口径作废，与数据层 cagg 1h 对齐）。
        let r = call(&st, "strategy_test_run", json!({
            "code": CONST_42, "symbol": "600000", "period": "H1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "mode": "pure_score"
        })).await;
        assert!(r["error"].is_null(), "H1 不应被拒: {r}");
        let p = payload_of(&r);
        assert_eq!(p["period"], "H1");
        assert_eq!(p["scores"].as_array().unwrap().len(), 6);
    }

    // ── I-7（D5）：strategy_list 默认瘦身（摘要不含源码）──

    /// I-7：默认只回摘要（不含源码）；include_source=true 显式取全量；体积显著下降。
    #[tokio::test]
    async fn strategy_list_default_slim_and_include_source_full() {
        let (st, _fx) = strategy_state();
        // 真实体量量级的插件源码（多 KB 注释）——体积对比须有意义（改前 39097 字符实测基准）。
        let code = format!("// {}\nfunction on_bar(ctx) {{ return 80; }}", "x".repeat(4000));
        let (_sid, _vid) = create_published(&st, "大源码策略", &code).await;
        let r = call(&st, "strategy_list", json!({})).await;
        let slim = payload_of(&r);
        let entry = &slim[0];
        assert_eq!(entry["strategy"]["name"], "大源码策略", "摘要保留身份字段");
        assert_eq!(entry["version"]["status"], "published");
        assert!(entry["version"].get("code").is_none(), "默认不含源码（I-7 瘦身）");
        assert!(entry["version"]["id"].as_str().unwrap().starts_with("sv_"),
            "版本 id 保留（供 strategy_test_run / bt_run_ensemble 选版）");
        assert!(entry["version"]["sha256"].is_string(), "sha256 保留（钉住可复现性）");
        // 显式索取全量 → 与改动前同形（含 code）
        let r = call(&st, "strategy_list", json!({ "include_source": true })).await;
        let full = payload_of(&r);
        assert_eq!(full[0]["version"]["code"], json!(code), "include_source=true 返回源码");
        assert_eq!(full[0]["strategy"]["id"], slim[0]["strategy"]["id"], "两种口径同条目");
        let (slim_len, full_len) = (slim.to_string().len(), full.to_string().len());
        assert!(slim_len * 2 < full_len,
            "体积显著下降（I-7）：slim={slim_len} full={full_len}");
    }

    /// I-7：include_source 类型校验（非 boolean → -32602）。
    #[tokio::test]
    async fn strategy_list_include_source_type_validation_is_32602() {
        let (st, _fx) = strategy_state();
        for v in [json!("yes"), json!(1)] {
            let r = call(&st, "strategy_list", json!({ "include_source": v })).await;
            assert_eq!(r["error"]["code"], -32602, "include_source 须 boolean：{v}");
        }
    }

    // ── I-9（D9）：strategy_test_run symbol 注册校验（口径同 get_kline I-1）──

    /// I-9：未注册 symbol → 明确 isError（含被拒 code 与原因）；已注册 → 既有语义不变。
    #[tokio::test]
    async fn strategy_test_run_unregistered_symbol_is_tool_error() {
        let (st, _fx) = strategy_state();
        let args = json!({ "code": CONST_42, "symbol": "510300", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "pure_score" });
        let r = call(&st, "strategy_test_run", args.clone()).await;
        assert!(r.get("error").is_none(), "注册校验走工具错误惯例（非 -32602）：{r}");
        assert_eq!(r["result"]["isError"], true, "未注册 symbol → isError（非静默无数据）");
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("510300") && text.contains("未注册"), "错误须含被拒 code 与原因：{text}");
        // 对照：已注册 600000 → 正常返回（既有语义不变）
        let mut ok = args.clone();
        ok["symbol"] = json!("600000");
        let r = call(&st, "strategy_test_run", ok).await;
        assert!(r.get("error").is_none(), "已注册 symbol 不报协议错误：{r}");
        assert_eq!(payload_of(&r)["bar_count"], 6, "已注册 → 试算照常");
    }

    /// I-9：注册表不可读 → fail-closed（isError），与 get_kline 同口径。
    #[tokio::test]
    async fn strategy_test_run_registry_failure_is_tool_error_fail_closed() {
        let (st, _fx) = strategy_state_with_kline(Arc::new(MockKline::failing_registry()));
        let r = call(&st, "strategy_test_run", json!({ "code": CONST_42, "symbol": "600000",
            "period": "D1", "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "mode": "pure_score" })).await;
        assert_eq!(r["result"]["isError"], true, "注册表不可读 → 拒（fail-closed）");
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("注册表"), "{text}");
    }

    // ── I-2/I-3（D6）：strategy_test_run 增 warmup_bars/fee/policy/capital 参数组 ──

    /// I-3：fee 生效回显（含 stamp_duty_pct）；ETF 显式 0；policy/capital 接受；非法 → 错误。
    #[tokio::test]
    async fn strategy_test_run_fee_policy_capital_channel() {
        let (st, _fx) = strategy_state();
        let base = json!({ "code": CONST_80, "symbol": "600000", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "sim_position" });
        // 缺省：股票口径 0.05 回显 + I-2 warmup 缺省 250/effective 0（mock 无 from 前置历史）。
        let p = payload_of(&call(&st, "strategy_test_run", base.clone()).await);
        assert_eq!(p["fee"]["effective"]["stamp_duty_pct"], json!(0.05), "缺省股票口径回显");
        assert_eq!(p["fee"]["effective"]["commission_rate_pct"], json!(0.025));
        assert_eq!(p["warmup_requested"], json!(250), "缺省预热 250");
        assert_eq!(p["warmup_effective"], json!(0), "mock 无 from 前置历史");
        // ETF：显式 stamp_duty_pct=0 → 回显 0。
        let mut a = base.clone();
        a["fee"] = json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0 });
        let p = payload_of(&call(&st, "strategy_test_run", a).await);
        assert_eq!(p["fee"]["effective"]["stamp_duty_pct"], json!(0.0), "ETF 显式 0 回显");
        // policy=Dca + capital 接受。
        let mut a = base.clone();
        a["policy"] = json!({ "Dca": { "tranches": 3, "mode": "Equal", "amount": null, "interval": 1 } });
        a["capital"] = json!(200000);
        let r = call(&st, "strategy_test_run", a).await;
        assert!(r.get("error").is_none(), "Dca/capital 接受：{r}");
        // 非法 capital（≤0）→ -32602。
        let mut a = base.clone();
        a["mode"] = json!("pure_score");
        a["capital"] = json!(0);
        assert_eq!(call(&st, "strategy_test_run", a).await["error"]["code"], -32602);
        // 非法 fee（字段非数值）→ 服务层工具错误（isError）。
        // v1.1 R-2：**缺字段不再报错**（改为字段级回退）；出现的非法字段仍报错。
        let mut a = base.clone();
        a["mode"] = json!("pure_score");
        a["fee"] = json!({ "rate_pct": "x" });
        assert_eq!(call(&st, "strategy_test_run", a).await["result"]["isError"], true);
        // 缺字段 fee（三键缺二）不再报错：字段级回退（无档案 → 旧默认）。
        let mut a = base.clone();
        a["mode"] = json!("pure_score");
        a["fee"] = json!({ "rate_pct": 0.025 });
        assert_ne!(call(&st, "strategy_test_run", a).await["result"]["isError"], true);
        // v1.1 补守卫（架构师裁决）：显式对象存在但**无可识别字段**（空对象/全未知键）→ 报错（fail-fast）。
        for no_field in [json!({}), json!({ "foo": 1 })] {
            let mut a = base.clone();
            a["mode"] = json!("pure_score");
            a["fee"] = no_field.clone();
            assert_eq!(call(&st, "strategy_test_run", a).await["result"]["isError"], true,
                "无可识别字段 {} 须报错", no_field);
        }
    }

    // ── ADR-019（D11-3）：按标的 type 推断费率 + 生效 fee/source 回显 ──

    /// ETF 标的 + 省略 fee → 印花税 0（D11 主目标）；显式传参优先（旧行为可复现）；无档案 → 旧默认。
    #[tokio::test]
    async fn strategy_test_run_fee_resolves_by_symbol_type() {
        let (st, _fx) = strategy_state_with_fee_profiles(
            Arc::new(MockKline::with_registered(&["518880", "600000"])), &["518880"]);
        let base = json!({ "code": CONST_80, "symbol": "518880", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "sim_position" });
        // ① 省略 fee → profile 分支：ETF 无印花税/无过户费/规费列 0（全佣口径），回显来源。
        let p = payload_of(&call(&st, "strategy_test_run", base.clone()).await);
        assert_eq!(p["fee"]["effective"]["stamp_duty_pct"], json!(0.0), "ETF 印花税不征 → 0（D11 主目标）");
        assert_eq!(p["fee"]["effective"]["commission_rate_pct"], json!(0.025), "佣金仍为全佣口径默认");
        assert_eq!(p["fee"]["effective"]["source"], json!("profile"), "来源=profile（按 type 查档案）");
        assert_eq!(p["fee"]["symbol_type"], json!("etf"));
        assert_eq!(p["fee"]["profile"]["exchange_fee_pct"], json!(0.0), "全佣口径：经手费列 0");
        assert_eq!(p["fee"]["profile"]["regulatory_fee_pct"], json!(0.0), "证管费列 0");
        assert_eq!(p["fee"]["profile"]["transfer_fee_pct"], json!(0.0), "过户费免收 → 0");
        assert_eq!(p["fee"]["profile"]["not_modeled"],
            json!(["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"]),
            "三项规费未建模 → 显式标注，不得误读为已计入");
        assert!(p["fee"]["effective"].get("exchange_fee_pct").is_none(), "未建模字段不得入 effective");
        // ② 显式三键（无 stamp，UI 形态）+ ETF 档案 → **字段级回退** stamp=0（v1.1 R-2 本批核心断言）
        let mut a = base.clone();
        a["fee"] = json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 });
        let p = payload_of(&call(&st, "strategy_test_run", a).await);
        assert_eq!(p["fee"]["effective"]["source"], json!("explicit"), "有字段来自显式 → explicit");
        assert_eq!(p["fee"]["effective"]["stamp_duty_pct"], json!(0.0), "缺 stamp → 回退 ETF 档案 0（非旧 0.05）");
        // ②b 显式 stamp=0.05 → 显式字段最高优先（旧行为可复现）
        let mut a = base.clone();
        a["fee"] = json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.05 });
        let p = payload_of(&call(&st, "strategy_test_run", a).await);
        assert_eq!(p["fee"]["effective"]["stamp_duty_pct"], json!(0.05), "显式 stamp 优先");
        // ③ 未建档标的（600000 不在 etf_codes）→ default 分支：旧默认，不借用他类型档案
        let mut a = base.clone();
        a["symbol"] = json!("600000");
        let p = payload_of(&call(&st, "strategy_test_run", a).await);
        assert_eq!(p["fee"]["effective"]["source"], json!("default"));
        assert_eq!(p["fee"]["effective"]["stamp_duty_pct"], json!(0.05), "type 未知 → 旧 ADR bt-1 默认");
        assert!(p["fee"].get("profile").is_none(), "无档案 → 不回显 profile 明细");
        assert!(p["fee"]["symbol_type"].is_null());
    }

    /// bt_run_ensemble：省略 fee → config 快照钉住 profile 生效值（**扁平**形态，R-1）；显式三键 fee 按字段级回退。
    #[tokio::test]
    async fn bt_run_ensemble_fee_resolves_by_symbol_type_and_pins_source() {
        // 注：工作台注册表替身（MockStrategySymbols）仅含 600000，故本用例的档案替身按 600000 建档。
        let (st, _fx) = strategy_state_with_fee_profiles(
            Arc::new(MockKline::with_registered(&["600000"])), &["600000"]);
        let (sid, vid) = create_published(&st, "D11费率", CONST_80).await;
        let mk = |fee: Option<Value>| {
            let mut a = json!({
                "name": "d11", "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
                "slots": [{ "strategy_id": sid, "version_id": vid, "weight": 1.0, "params": {} }],
                "policy": { "LumpSum": { "position_pct": 1.0 } }
            });
            if let Some(f) = fee { a["fee"] = f; }
            a
        };
        // 省略 fee → 按 type 解析（ETF 印花税 0）并**扁平**钉入 config 快照（R-1 复现前提）
        let p = payload_of(&call(&st, "bt_run_ensemble", mk(None)).await);
        assert_eq!(p["run"]["config"]["fee"]["stamp_duty_pct"], json!(0.0), "ETF 缺省印花税 0（扁平）");
        assert_eq!(p["run"]["config"]["fee"]["rate_pct"], json!(0.025));
        assert!(p["run"]["config"]["fee"].get("effective").is_none(), "R-1：config.fee 扁平，无两段结构");
        // 显式三键 fee（无 stamp）+ ETF → 字段级回退 stamp=0 并扁平钉入（R-2 核心）
        let p2 = payload_of(&call(&st, "bt_run_ensemble", mk(Some(json!(
            { "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 })))).await);
        assert_eq!(p2["run"]["config"]["fee"]["stamp_duty_pct"], json!(0.0),
            "三键 fee 无 stamp + ETF → 回退档案 stamp=0 并钉入 config");
    }

    /// list_symbols：注册表行回显 type（ADR-019 D11-1；null = 未设置）。
    #[tokio::test]
    async fn list_symbols_exposes_symbol_type_or_null() {
        let kline = Arc::new(MockKline::new().with_symbols(vec![
            sample_symbol("518880", Some("黄金ETF"), Some("etf"), 60, "T1", true, None, None, None),
            sample_symbol("600000", None, None, 15, "T0", false, None, None, None),
        ]));
        let st = test_state(kline.clone(), Arc::new(MockEvents::new()));
        let p = payload_of(&call(&st, "list_symbols", json!({})).await);
        let syms = p["symbols"].as_array().expect("symbols 数组");
        assert_eq!(syms[0]["code"], "518880");
        assert_eq!(syms[0]["type"], json!("etf"), "已判定标的回显 type");
        assert_eq!(syms[1]["code"], "600000");
        assert!(syms[1]["type"].is_null(), "未设置 type → null（不静默错判）");
    }

    /// I-2：bt_run_ensemble schema 含 warmup_bars（缺省可选，不入 required）。
    #[test]
    fn bt_run_ensemble_schema_has_warmup_bars() {
        let v = tool_list();
        let tools = v["tools"].as_array().unwrap();
        let bt = tools.iter().find(|t| t["name"] == "bt_run_ensemble").unwrap();
        assert!(bt["inputSchema"]["properties"]["warmup_bars"].is_object(),
            "I-2（D6）：bt_run_ensemble 增 warmup_bars");
        assert!(!bt["inputSchema"]["required"].as_array().unwrap()
            .iter().any(|x| x == "warmup_bars"), "warmup_bars 可选（兼容既有调用）");
    }

    #[tokio::test]
    async fn strategy_tools_param_validation_is_32602() {
        let (st, _fx) = strategy_state();
        for (tool, args) in [
            ("strategy_get", json!({})),
            ("strategy_create", json!({ "code": "x" })),                       // 缺 name
            ("strategy_create", json!({ "name": "x" })),                        // 缺 code
            ("strategy_create", json!({ "name": "x", "code": "y", "kind": "bogus" })),
            ("strategy_update", json!({ "version_id": "sv_1" })),               // 缺 code
            ("strategy_update", json!({ "code": "x" })),                        // 缺 version_id
            ("strategy_publish", json!({})),
            ("strategy_archive", json!({})),
            ("strategy_list", json!({ "level": "bogus" })),
            ("strategy_list", json!({ "kind": "bogus" })),
            // strategy_test_run：code/version_id 须恰一个
            ("strategy_test_run", json!({ "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "pure_score" })),
            ("strategy_test_run", json!({ "code": "x", "version_id": "sv_1", "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "pure_score" })),
            ("strategy_test_run", json!({ "code": "x", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "pure_score" })), // 缺 symbol
            ("strategy_test_run", json!({ "code": "x", "symbol": "600000", "period": "W1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "pure_score" })), // 非法 period（H1 已支持）
            ("strategy_test_run", json!({ "code": "x", "symbol": "600000", "period": "D1",
                "from": "2026/09/01", "to": "2026-09-10T00:00:00Z", "mode": "pure_score" })),          // 非法 from
            ("strategy_test_run", json!({ "code": "x", "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z", "mode": "bogus" })),     // 非法 mode
        ] {
            let r = call(&st, tool, args.clone()).await;
            assert_eq!(r["error"]["code"], -32602, "{tool} {args} → invalid params");
        }
    }

    #[tokio::test]
    async fn strategy_tools_unknown_id_and_state_errors_are_is_error() {
        let (st, _fx) = strategy_state();
        // 未知 id → isError（非协议错误）
        let r = call(&st, "strategy_get", json!({ "strategy_id": "no-such" })).await;
        assert_eq!(r["result"]["isError"], true);
        let r = call(&st, "strategy_publish", json!({ "version_id": "no-such" })).await;
        assert_eq!(r["result"]["isError"], true);
        let r = call(&st, "strategy_archive", json!({ "version_id": "no-such" })).await;
        assert_eq!(r["result"]["isError"], true);
        // 状态机：重复发布 → isError；draft 归档 → isError
        let (_sid, vid) = create_published(&st, "恒分80", CONST_80).await;
        let r = call(&st, "strategy_publish", json!({ "version_id": vid })).await;
        assert_eq!(r["result"]["isError"], true, "published 不可再发布");
        let r = call(&st, "strategy_create", json!({ "name": "d", "code": CONST_42 })).await;
        let draft_vid = payload_of(&r)["version"]["id"].as_str().unwrap().to_string();
        let r = call(&st, "strategy_archive", json!({ "version_id": draft_vid })).await;
        assert_eq!(r["result"]["isError"], true, "draft→archived 非法流转");
    }

    #[tokio::test]
    async fn bt_run_ensemble_happy_path_and_run_queries() {
        let (st, _fx) = strategy_state();
        let (sid, vid) = create_published(&st, "恒分80", CONST_80).await;
        // version_id 缺省 → catalog 解析最新 published；fee 缺省 ADR bt-1 默认
        let r = call(&st, "bt_run_ensemble", json!({
            "name": "e1", "symbol": "600000", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "slots": [{ "strategy_id": sid, "weight": 1.0 }],
            "policy": { "LumpSum": { "position_pct": 1.0 } }
        })).await;
        let p = payload_of(&r);
        let run_id = p["run_id"].as_str().unwrap().to_string();
        assert!(run_id.starts_with("sr_"));
        assert_eq!(p["run"]["status"], "queued");
        assert_eq!(p["run"]["config"]["slots"][0]["strategy_id"], json!(sid));
        assert_eq!(p["run"]["config"]["slots"][0]["version_id"], json!(vid), "钉住解析的最新 published");
        assert_eq!(p["run"]["config"]["fee"]["rate_pct"], json!(0.025), "fee 缺省 ADR bt-1 默认（扁平 config.fee，R-1）");
        assert!(p["run"]["config"]["fee"].get("effective").is_none(), "config.fee 不得含两段结构");
        // 轮询至完成（后台真实 QuickJS 引擎跑 6 bar）
        let mut status = String::new();
        for _ in 0..200 {
            let r = call(&st, "bt_get_run", json!({ "run_id": run_id })).await;
            let p = payload_of(&r);
            status = p["status"].as_str().unwrap().to_string();
            if status != "queued" && status != "running" { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(status, "succeeded");
        let r = call(&st, "bt_get_run", json!({ "run_id": run_id })).await;
        assert_eq!(payload_of(&r)["progress"], json!(1.0));
        // 结果：五 jsonb 齐全，per_bar 全量 6 条
        let r = call(&st, "bt_get_run_result", json!({ "run_id": run_id })).await;
        let p = payload_of(&r);
        assert_eq!(p["per_bar"].as_array().unwrap().len(), 6);
        assert!(!p["net_value"].is_null());
        assert!(p["metrics"].is_object());
        // 列表：status 过滤 + 分页回声
        let r = call(&st, "bt_list_runs", json!({})).await;
        let p = payload_of(&r);
        assert_eq!(p["runs"].as_array().unwrap().len(), 1);
        assert_eq!(p["page"], 1);
        assert_eq!(p["page_size"], 100);
        let r = call(&st, "bt_list_runs", json!({ "status": "failed" })).await;
        assert_eq!(payload_of(&r)["runs"].as_array().unwrap().len(), 0);
        // compare：并排（未知 id 跳过）
        let r = call(&st, "bt_compare_runs", json!({ "run_ids": [run_id, "no-such"] })).await;
        let items = payload_of(&r);
        assert_eq!(items.as_array().unwrap().len(), 1);
        assert_eq!(items[0]["run_id"], json!(run_id));
        // 终态取消 → isError（409 语义）
        let r = call(&st, "bt_cancel_run", json!({ "run_id": run_id })).await;
        assert_eq!(r["result"]["isError"], true);
    }

    #[tokio::test]
    async fn bt_run_ensemble_unpublished_and_invalid_config_are_is_error() {
        let (st, _fx) = strategy_state();
        // draft 版本显式 version_id → isError（未发布代码不可运行；published|archived 可运行）
        let r = call(&st, "strategy_create", json!({ "name": "d", "code": CONST_80 })).await;
        let draft_vid = payload_of(&r)["version"]["id"].as_str().unwrap().to_string();
        let draft_sid = payload_of(&r)["strategy"]["id"].as_str().unwrap().to_string();
        let base = json!({
            "symbol": "600000", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "policy": { "LumpSum": { "position_pct": 1.0 } }
        });
        let mut a = base.clone();
        a["slots"] = json!([{ "strategy_id": draft_sid, "version_id": draft_vid, "weight": 1.0 }]);
        let r = call(&st, "bt_run_ensemble", a).await;
        assert_eq!(r["result"]["isError"], true, "draft 版本不可运行");
        // strategy_id 无任何 published → isError（信息含 strategy_id）
        let mut a = base.clone();
        a["slots"] = json!([{ "strategy_id": draft_sid, "weight": 1.0 }]);
        let r = call(&st, "bt_run_ensemble", a).await;
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains(&draft_sid));
        // 非法配置：weight=0 / 未知策略 version_id / 非法 policy
        let (sid, vid) = create_published(&st, "恒分80", CONST_80).await;
        let mut a = base.clone();
        a["slots"] = json!([{ "strategy_id": sid, "version_id": vid, "weight": 0.0 }]);
        let r = call(&st, "bt_run_ensemble", a).await;
        assert_eq!(r["result"]["isError"], true, "weight≤0");
        let mut a = base.clone();
        a["slots"] = json!([{ "strategy_id": sid, "version_id": "no-such", "weight": 1.0 }]);
        let r = call(&st, "bt_run_ensemble", a).await;
        assert_eq!(r["result"]["isError"], true, "未知 version_id");
        let mut a = base.clone();
        a["slots"] = json!([{ "strategy_id": sid, "weight": 1.0 }]);
        a["policy"] = json!({ "Bogus": {} });
        let r = call(&st, "bt_run_ensemble", a).await;
        assert_eq!(r["result"]["isError"], true, "非法 policy");
    }

    /// 2026-09-10 裁决：archived 版本可审计重跑（显式 version_id；config 快照钉住 archived 审计标记）。
    #[tokio::test]
    async fn bt_run_ensemble_archived_version_audit_rerun() {
        let (st, _fx) = strategy_state();
        let (sid, vid) = create_published(&st, "恒分80", CONST_80).await;
        let r = call(&st, "strategy_archive", json!({ "version_id": vid })).await;
        assert_eq!(payload_of(&r)["status"], json!("archived"), "published→archived 归档成功");
        let r = call(&st, "bt_run_ensemble", json!({
            "name": "audit", "symbol": "600000", "period": "D1",
            "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
            "slots": [{ "strategy_id": sid, "version_id": vid, "weight": 1.0 }],
            "policy": { "LumpSum": { "position_pct": 1.0 } }
        })).await;
        let p = payload_of(&r);
        let run_id = p["run_id"].as_str().unwrap().to_string();
        assert!(run_id.starts_with("sr_"), "archived 版本审计重跑应提交成功: {p}");
        let slot = &p["run"]["config"]["slots"][0];
        assert_eq!(slot["version_id"], json!(vid), "钉住 archived version_id");
        assert_eq!(slot["archived"], json!(true), "审计标记 archived=true");
        assert_eq!(slot["sha256"].as_str().unwrap().len(), 64, "sha256 钉住");
        // 轮询至成功（真实 QuickJS 引擎跑 6 bar，不触真实资金）
        let mut status = String::new();
        for _ in 0..200 {
            let r = call(&st, "bt_get_run", json!({ "run_id": run_id })).await;
            status = payload_of(&r)["status"].as_str().unwrap().to_string();
            if status != "queued" && status != "running" { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(status, "succeeded", "审计重跑应成功");
        // 详情（bt_get_run）返回 config 快照含审计标记
        let r = call(&st, "bt_get_run", json!({ "run_id": run_id })).await;
        assert_eq!(payload_of(&r)["config"]["slots"][0]["archived"], json!(true));
    }

    #[tokio::test]
    async fn bt_tools_param_validation_and_unknown_id() {
        let (st, fx) = strategy_state();
        for (tool, args) in [
            ("bt_run_ensemble", json!({ "period": "D1", "from": "2026-09-01T00:00:00Z",
                "to": "2026-09-10T00:00:00Z", "slots": [{ "strategy_id": "s", "weight": 1.0 }],
                "policy": {} })),                                                     // 缺 symbol
            ("bt_run_ensemble", json!({ "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
                "policy": {} })),                                                     // 缺 slots
            ("bt_run_ensemble", json!({ "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
                "slots": [] })),                                                      // slots 空 + 缺 policy
            ("bt_run_ensemble", json!({ "symbol": "600000", "period": "W1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
                "slots": [{ "strategy_id": "s", "weight": 1.0 }], "policy": {} })), // 非法 period（H1 已支持）
            ("bt_run_ensemble", json!({ "symbol": "600000", "period": "D1",
                "from": "bad", "to": "2026-09-10T00:00:00Z",
                "slots": [{ "strategy_id": "s", "weight": 1.0 }], "policy": {} })), // 非法 from
            ("bt_run_ensemble", json!({ "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
                "slots": [{ "weight": 1.0 }], "policy": {} })),                      // slot 缺 strategy_id
            ("bt_run_ensemble", json!({ "symbol": "600000", "period": "D1",
                "from": "2026-09-01T00:00:00Z", "to": "2026-09-10T00:00:00Z",
                "slots": [{ "strategy_id": "s" }], "policy": {} })),                 // slot 缺 weight
            ("bt_get_run", json!({})),
            ("bt_get_run_result", json!({})),
            ("bt_cancel_run", json!({})),
            ("bt_list_runs", json!({ "status": "bogus" })),
            ("bt_list_runs", json!({ "page": 0 })),
            ("bt_compare_runs", json!({})),
            ("bt_compare_runs", json!({ "run_ids": [] })),
            ("bt_compare_runs", json!({ "run_ids": [1] })),
            ("bt_apply_preset", json!({})),
        ] {
            let r = call(&st, tool, args.clone()).await;
            assert_eq!(r["error"]["code"], -32602, "{tool} {args} → invalid params");
        }
        // 未知 id → isError
        let r = call(&st, "bt_get_run", json!({ "run_id": "no-such" })).await;
        assert_eq!(r["result"]["isError"], true);
        let r = call(&st, "bt_cancel_run", json!({ "run_id": "no-such" })).await;
        assert_eq!(r["result"]["isError"], true);
        // queued 未成功 → 无结果 isError；取消 queued → canceled（确定性：直插不行后台任务）
        fx.run_store.insert_queued("sr_seed1");
        let r = call(&st, "bt_get_run_result", json!({ "run_id": "sr_seed1" })).await;
        assert_eq!(r["result"]["isError"], true, "未成功无结果");
        let r = call(&st, "bt_cancel_run", json!({ "run_id": "sr_seed1" })).await;
        assert_eq!(payload_of(&r)["status"], "canceled");
    }

    #[tokio::test]
    async fn bt_presets_list_and_apply() {
        let (st, fx) = strategy_state();
        // MCP 侧无 create_preset（CRUD 在 web）；经 store 播种一行。
        fx.preset_store.insert("sp_t1", "趋势组合", json!({
            "slots": [{ "strategy_id": "st_x", "version_id": "sv_x", "version": 1,
                "sha256": "abc", "params": {}, "weight": 1.0 }],
            "buy_threshold": 60, "sell_threshold": 40,
            "policy": { "LumpSum": { "position_pct": 1.0 } },
            "stop": null, "initial_capital": 100000,
            "fee": { "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 }
        }));
        let r = call(&st, "bt_list_presets", json!({})).await;
        let list = payload_of(&r);
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "趋势组合");
        // apply：返回钉住 config 供 bt_run_ensemble 合并 symbol/period/from/to 后提交
        let r = call(&st, "bt_apply_preset", json!({ "preset_id": "sp_t1" })).await;
        let p = payload_of(&r);
        assert_eq!(p["preset_id"], "sp_t1");
        assert!(p["config"]["slots"].is_array());
        assert_eq!(p["config"]["buy_threshold"], json!(60));
        // 未知预设 → isError
        let r = call(&st, "bt_apply_preset", json!({ "preset_id": "no-such" })).await;
        assert_eq!(r["result"]["isError"], true);
    }

    #[tokio::test]
    async fn strategy_tools_gated_by_mcp_disable_switch() {
        let (st, _fx) = strategy_state();
        // 关闭单开关 → strategy_*/bt_* 全族 isError（提示已停用）
        assert!(!st.set_strategy_tools_enabled(false));
        let r = call(&st, "strategy_list", json!({})).await;
        assert_eq!(r["result"]["isError"], true, "停用后 strategy_* isError");
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("停用"));
        let r = call(&st, "strategy_guide", json!({})).await;
        assert_eq!(r["result"]["isError"], true, "停用后 strategy_guide 同样 isError");
        let r = call(&st, "bt_list_runs", json!({})).await;
        assert_eq!(r["result"]["isError"], true, "停用后 bt_* isError");
        // 重开 → 恢复
        assert!(st.set_strategy_tools_enabled(true));
        let r = call(&st, "strategy_list", json!({})).await;
        assert_ne!(r["result"]["isError"], true, "重开后恢复");
    }

    #[tokio::test]
    async fn strategy_guide_returns_handbook_full_text() {
        let (st, _fx) = strategy_state();
        let r = call(&st, "strategy_guide", json!({})).await;
        assert_ne!(r["result"]["isError"], true, "手册工具恒可用（不经 StrategyService）");
        let p = payload_of(&r);
        assert_eq!(p["format"], "markdown");
        let guide = p["guide"].as_str().expect("guide 全文");
        assert!(guide.contains("PARAMS_SCHEMA"), "手册应含 PARAMS_SCHEMA 章节");
        assert!(guide.contains("ctx.position"), "手册应含 ctx.position 章节");
        // 与 design 源文件字节一致（include_str! 静态内嵌，与 REST /api/strategies/guide 同字节）
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../design/12-strategy-system/04-strategy-programming-guide.md"),
        ).unwrap();
        assert_eq!(guide, src, "strategy_guide 应 = design 手册全文");
        // 不经 StrategyService：未装配 strategies 的 state 也可用
        let bare = test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()));
        let r = call(&bare, "strategy_guide", json!({})).await;
        assert_ne!(r["result"]["isError"], true, "未装配 StrategyService 仍可取手册");
    }

    #[tokio::test]
    async fn strategy_tools_unconfigured_returns_is_error() {
        let st = test_state(Arc::new(MockKline::new()), Arc::new(MockEvents::new()));
        let r = call(&st, "strategy_list", json!({})).await;
        assert_eq!(r["result"]["isError"], true, "strategies=None → 工具错误帧");
        let r = call(&st, "bt_get_run", json!({ "run_id": "x" })).await;
        assert_eq!(r["result"]["isError"], true, "workbench=None → 工具错误帧");
    }
}
// ~/~ end
// ~/~ end
// ~/~ end
