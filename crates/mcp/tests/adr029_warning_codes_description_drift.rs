//! **ADR-029 §5 R13/R16 收口**：MCP 工具描述 ↔ 审计**告警码集合**的**双向防漂移**（手写，非 tangle）。
//!
//! 背景：ADR-029 新增的告警码（**只**经 `warnings[]` 披露，裁决 Q2=A），而 `bt_get_run_audit` 的工具描述
//! 若漏列 ⇒ 调用方（agent）读不到新语义。本文件把「描述与告警码集合一致」变成可执行判据
//!（**加码/删码/改名任一方向漂移都红**）：
//!
//! ```text
//! crates/application/src/audit.rs 的 `pub const WARN_*: &str`（唯一事实源，源码解析）
//!   == mcp::tools::tool_list()["tools"][bt_get_run_audit]["description"] 中出现的告警码集合
//! ```
//!
//! 卫生：纯函数 + 只读仓库内文件 ⇒ **无 DB / 无网络**。
//!
//! **Step 1.5（2026-09-29）**：`EXPOSURE_UNMET_INTENT` / `EXPOSURE_RESIDUAL_INTENT` / `EXPOSURE_COST_DRAG`
//! 三个新码纳入（既有五个码**一个都不删**，码名不动）。

use std::collections::BTreeSet;
use std::path::PathBuf;

/// 工具名（本断言只锁 `bt_get_run_audit`：`warnings[]` 的唯一披露点）。
const TOOL: &str = "bt_get_run_audit";
/// ADR-029 告警码（若被删/改名 ⇒ 本文件红，提示同步 ADR 与描述）。
///
/// `EXPOSURE_INTENT_GAP` / `EXPOSURE_CHURN` = Step 1（D7/E10）；三个 `Step 1.5` 码 = D14/D15。
const ADR029_NEW_CODES: [&str; 5] = [
    "EXPOSURE_INTENT_GAP",
    "EXPOSURE_CHURN",
    "EXPOSURE_UNMET_INTENT",
    "EXPOSURE_RESIDUAL_INTENT",
    "EXPOSURE_COST_DRAG",
];

/// 告警码事实源：解析 `crates/application/src/audit.rs` 里 `pub const WARN_*: &str = "CODE";`。
fn warn_codes() -> BTreeSet<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../application/src/audit.rs");
    let src = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("告警码事实源不可读 {}：{e}", p.display()));
    let mut out = BTreeSet::new();
    for line in src.lines() {
        let line = line.trim();
        if !line.starts_with("pub const WARN_") {
            continue;
        }
        let code = line
            .split_once('"')
            .and_then(|(_, rest)| rest.split_once('"'))
            .map(|(code, _)| code.to_string())
            .unwrap_or_else(|| panic!("无法解析告警码常量行：{line}"));
        assert!(!code.is_empty(), "告警码不得为空串：{line}");
        out.insert(code);
    }
    out
}

/// `bt_get_run_audit` 的工具描述（经 `tool_list()`，与线上工具清单同源）。
fn audit_description() -> String {
    let list = mcp::tools::tool_list();
    let tools = list["tools"].as_array().expect("tool_list 缺 `tools` 数组");
    let t = tools
        .iter()
        .find(|t| t["name"] == TOOL)
        .unwrap_or_else(|| panic!("tool_list 缺工具 {TOOL}"));
    t["description"]
        .as_str()
        .unwrap_or_else(|| panic!("{TOOL}.description 缺/非字符串"))
        .to_string()
}

/// 描述里出现的「SCREAMING_SNAKE 码式 token」（至少含一个 `_`，各段非空且全为大写/数字）。
/// 用于反向断言：描述里**不得**出现事实源之外的码（防重命名只改一半、防手写错码）。
fn code_tokens(desc: &str) -> BTreeSet<String> {
    let bytes = desc.as_bytes();
    let mut out = BTreeSet::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if !c.is_ascii_uppercase() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() {
            let c = bytes[i] as char;
            if c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_' {
                i += 1;
            } else {
                break;
            }
        }
        let tok = &desc[start..i];
        let segs: Vec<&str> = tok.split('_').collect();
        let shaped = tok.contains('_')
            && tok.len() >= 4
            && segs.iter().all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        if shaped {
            out.insert(tok.to_string());
        }
    }
    out
}

/// ① 事实源健全性：解析必须真的读到码集合（否则本文件恒真、无鉴别力）。
#[test]
fn warn_code_source_is_parsed() {
    let codes = warn_codes();
    assert!(
        codes.len() >= 8,
        "audit.rs 的 `pub const WARN_*` 至少 8 个（PARTIAL_DEPLOYMENT/DCA_PLAN_UNDERFILLED/ORDERS_UNEXECUTED + ADR-029 五个）：{codes:?}"
    );
    for c in ADR029_NEW_CODES {
        assert!(codes.contains(c), "ADR-029 新增码 {c} 必须存在于审计事实源：{codes:?}");
    }
}

/// ② 正向：**每个**告警码都必须出现在 MCP 工具描述里（新增码未同步描述 ⇒ 红）。
#[test]
fn every_warn_code_is_documented_in_mcp_tool_description() {
    let desc = audit_description();
    let missing: Vec<String> = warn_codes().into_iter().filter(|c| !desc.contains(c.as_str())).collect();
    assert!(
        missing.is_empty(),
        "以下告警码未出现在 {TOOL} 工具描述中（调用方读不到语义）：{missing:?}\n描述：{desc}"
    );
}

/// ③ 反向：描述里的码式 token 不得超出事实源（防手写错码/重命名只改一半）。
#[test]
fn mcp_tool_description_mentions_no_unknown_warning_code() {
    let desc = audit_description();
    let known = warn_codes();
    let extra: Vec<String> = code_tokens(&desc).into_iter().filter(|t| !known.contains(t)).collect();
    assert!(
        extra.is_empty(),
        "描述里出现事实源之外的 SCREAMING_SNAKE token（码名字漂移或手写错码）：{extra:?}\n描述：{desc}"
    );
}

/// ④ 本批收口证据：ADR-029 各码在描述里各出现**至少一次**且带语义（非仅列名）。
#[test]
fn adr029_codes_are_described_with_semantics() {
    let desc = audit_description();
    for c in ADR029_NEW_CODES {
        assert!(desc.contains(c), "{c} 必须在描述中");
    }
    assert!(
        desc.contains("Exposure"),
        "这些码只在 `Exposure` 策略变体发声 ⇒ 描述必须点明该前提"
    );
    // Step 1.5 三个新码各自的**语义关键词**（防「只补名字不补语义」的假同步）。
    assert!(desc.contains("意图未被达成"), "EXPOSURE_UNMET_INTENT 须带语义：{desc}");
    assert!(desc.contains("残仓"), "EXPOSURE_RESIDUAL_INTENT 须带语义（残仓）：{desc}");
    assert!(desc.contains("成本放大"), "EXPOSURE_COST_DRAG 须带语义（成本放大）：{desc}");
    assert!(desc.contains("on_signal_break"), "UNMET_INTENT 须点明 on_signal_break 口径：{desc}");
    assert!(desc.contains("exposure"), "描述须披露结构化 `exposure` 段：{desc}");
}
