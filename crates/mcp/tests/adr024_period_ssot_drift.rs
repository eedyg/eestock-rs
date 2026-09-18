//! ADR-024 P0 —— 回测周期白名单「四者逐字相等」防漂移断言（**手写**，非 tangle）。
//!
//! 断言链（任一环节漂移 ⇒ 本文件变红）：
//! ```text
//! application::bar_map::supported_backtest_periods()   （后端唯一权威事实源）
//!   == mcp tool_list() 的 bt_run_ensemble / strategy_test_run 的 period.enum
//!   == design/16-backtest-scalability/contract-vectors.json 的 backtest_periods
//!   == web/src/features/backtest/periods.ts::SUPPORTED_BACKTEST_PERIODS（前端镜像常量）
//! ```
//! 另加源码级反回归：`crates/mcp/src/tools.rs` 必须由 `supported_backtest_periods()` 生成
//! enum/校验，不得再手写第二份白名单。
//!
//! 卫生：纯函数 + 只读仓库内文件 ⇒ **无 IO 网络/无 DB**。

use application::bar_map::supported_backtest_periods;
use serde_json::Value;
use std::path::PathBuf;

/// 前端镜像常量文件（相对 `crates/mcp`）。
const FRONTEND_MIRROR: &str = "../../web/src/features/backtest/periods.ts";
/// 契约向量文件（相对 `crates/mcp`）。
const CONTRACT_VECTORS: &str = "../../design/16-backtest-scalability/contract-vectors.json";

/// 后端 SSOT（`&[&str]` → `Vec<String>`）。
fn ssot() -> Vec<String> {
    supported_backtest_periods().iter().map(|s| s.to_string()).collect()
}

/// 契约向量 `backtest_periods`。
fn contract_vector_periods() -> Vec<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(CONTRACT_VECTORS);
    let raw = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("契约向量文件不可读 {}：{e}", p.display()));
    let v: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("契约向量文件 JSON 解析失败 {}：{e}", p.display()));
    v["backtest_periods"]
        .as_array()
        .unwrap_or_else(|| panic!("contract-vectors.json 缺 `backtest_periods` 数组"))
        .iter()
        .map(|x| x.as_str().expect("backtest_periods 条目须为字符串").to_string())
        .collect()
}

/// 前端镜像常量 `SUPPORTED_BACKTEST_PERIODS = [ ... ]` 的字面量条目。
fn frontend_mirror_periods() -> Vec<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FRONTEND_MIRROR);
    let src = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("前端镜像常量文件不可读 {}：{e}", p.display()));
    let name_at = src
        .find("SUPPORTED_BACKTEST_PERIODS")
        .unwrap_or_else(|| panic!("{} 缺 `SUPPORTED_BACKTEST_PERIODS`", p.display()));
    let open = src[name_at..]
        .find('[')
        .map(|j| name_at + j)
        .unwrap_or_else(|| panic!("SUPPORTED_BACKTEST_PERIODS 未接数组字面量"));
    let close = src[open..]
        .find(']')
        .map(|j| open + j)
        .unwrap_or_else(|| panic!("SUPPORTED_BACKTEST_PERIODS 数组未闭合"));
    src[open + 1..close]
        .split(',')
        .map(|s| s.trim().trim_matches(|c| c == '\'' || c == '"').trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 从 `tool_list()` 取指定工具 `inputSchema.properties.period.enum`。
fn mcp_period_enum(tool: &str) -> Vec<String> {
    let list = mcp::tools::tool_list();
    let tools = list["tools"].as_array().expect("tool_list 缺 `tools` 数组");
    let t = tools
        .iter()
        .find(|t| t["name"] == tool)
        .unwrap_or_else(|| panic!("tool_list 缺工具 {tool}"));
    let enum_v = &t["inputSchema"]["properties"]["period"]["enum"];
    enum_v
        .as_array()
        .unwrap_or_else(|| panic!("{tool}.inputSchema.properties.period.enum 缺/非数组"))
        .iter()
        .map(|x| x.as_str().expect("period.enum 条目须为字符串").to_string())
        .collect()
}

/// ① MCP 两个回测工具的 schema enum == 后端 SSOT。
#[test]
fn mcp_schema_enums_match_backend_ssot() {
    for tool in ["bt_run_ensemble", "strategy_test_run"] {
        assert_eq!(
            mcp_period_enum(tool),
            ssot(),
            "{tool} 的 period.enum 与 supported_backtest_periods() 不一致（ADR-024 §5.1）"
        );
    }
}

/// ② 后端 SSOT == 契约向量（逐字相等）。
#[test]
fn backend_ssot_matches_contract_vectors() {
    assert_eq!(
        ssot(),
        contract_vector_periods(),
        "supported_backtest_periods() != contract-vectors.json `backtest_periods`"
    );
}

/// ③ 后端 SSOT == 前端镜像常量（逐字相等）。
#[test]
fn backend_ssot_matches_frontend_mirror() {
    assert_eq!(
        ssot(),
        frontend_mirror_periods(),
        "supported_backtest_periods() != web/src/features/backtest/periods.ts 的前端镜像常量"
    );
}

/// ④ 四者逐字相等（合并断言，给出唯一判据）。
#[test]
fn all_four_period_sources_are_byte_equal() {
    let backend = ssot();
    let vectors = contract_vector_periods();
    let frontend = frontend_mirror_periods();
    let mcp_bt = mcp_period_enum("bt_run_ensemble");
    let mcp_tr = mcp_period_enum("strategy_test_run");
    assert_eq!(backend, vectors, "backend != contract-vectors");
    assert_eq!(backend, frontend, "backend != frontend mirror");
    assert_eq!(backend, mcp_bt, "backend != mcp bt_run_ensemble enum");
    assert_eq!(backend, mcp_tr, "backend != mcp strategy_test_run enum");
    assert_eq!(
        backend,
        vec!["M1", "M5", "M15", "M30", "H1", "D1"],
        "四者相等但集合本身不是契约六档（契约向量被削弱）"
    );
}

/// 源码级反回归：MCP 必须由 SSOT 生成 enum/校验，不得手写第二份白名单。
#[test]
fn mcp_source_derives_from_ssot_not_handwritten() {
    let src = include_str!("../src/tools.rs");
    assert!(
        src.contains("supported_backtest_periods()"),
        "crates/mcp/src/tools.rs 未使用 supported_backtest_periods()（单一事实源）"
    );
    assert!(
        !src.contains("\"M1\", \"M5\", \"M15\", \"H1\", \"D1\""),
        "crates/mcp/src/tools.rs 仍含手写周期白名单字面量（双事实源回归）"
    );
    assert!(
        !src.contains("matches!(s, \"M1\""),
        "crates/mcp/src/tools.rs::valid_bt_period 仍是手写 matches! 白名单"
    );
}
