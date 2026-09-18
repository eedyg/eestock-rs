//! ADR-024 P0 —— 回测周期白名单「单一事实源」后端侧断言（**手写**，非 tangle）。
//!
//! 单一事实源：`application::bar_map::supported_backtest_periods()`（`design/16-backtest-scalability/02-spec.md` §5.1）。
//! 本文件把该事实源钉死为契约向量 `design/16-backtest-scalability/contract-vectors.json` 的
//! `backtest_periods`（逐字相等），并验证 `parse_period` 对全集每个周期都能解析到
//! `(domain::types::Period, backtest::Period)` 两枚举的**同档变体**（含新增 M30）。
//!
//! 卫生：纯函数 + 只读一个仓库内 JSON 文件 ⇒ **无 IO/无 DB/无网络**。
//! 跨层（MCP schema enum / 前端镜像常量）防漂移断言见 `crates/mcp/tests/adr024_period_ssot_drift.rs`。

use application::bar_map::{parse_period, supported_backtest_periods};
use serde_json::Value;
use std::path::PathBuf;

/// 契约期望（与 `contract-vectors.json` 的 `backtest_periods` 逐字相等；顺序即 UI 展示序）。
const EXPECTED: [&str; 6] = ["M1", "M5", "M15", "M30", "H1", "D1"];

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../design/16-backtest-scalability/contract-vectors.json")
}

fn vectors() -> Value {
    let p = vectors_path();
    let raw = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("契约向量文件不可读 {}：{e}", p.display()));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("契约向量文件 JSON 解析失败 {}：{e}", p.display()))
}

/// 单一事实源 = 六档（M1/M5/M15/M30/H1/D1），顺序逐字相等。
#[test]
fn ssot_is_the_canonical_six_tier_set() {
    assert_eq!(
        supported_backtest_periods().to_vec(),
        EXPECTED.to_vec(),
        "supported_backtest_periods() 必须恰为 {EXPECTED:?}（ADR-024 §5.1 唯一权威事实源）"
    );
}

/// 单一事实源 == 契约向量 `backtest_periods`（逐字相等）。
#[test]
fn ssot_matches_contract_vectors_backtest_periods() {
    let v = vectors();
    let want: Vec<&str> = v["backtest_periods"]
        .as_array()
        .unwrap_or_else(|| panic!("contract-vectors.json 缺 `backtest_periods` 数组"))
        .iter()
        .map(|x| x.as_str().expect("backtest_periods 条目须为字符串"))
        .collect();
    assert_eq!(
        supported_backtest_periods().to_vec(),
        want,
        "supported_backtest_periods() != contract-vectors.json `backtest_periods`"
    );
}

/// 事实源无重复（防「多写一档 M30」这类漂移混入）。
#[test]
fn ssot_has_no_duplicates() {
    let mut seen = supported_backtest_periods().to_vec();
    seen.sort_unstable();
    let n_before = seen.len();
    seen.dedup();
    assert_eq!(n_before, seen.len(), "supported_backtest_periods() 含重复档位");
}

/// 全集自洽：事实源里的每一档都能被 `parse_period` 解析，且回环为同一字符串。
#[test]
fn every_ssot_period_parses_roundtrip() {
    for p in supported_backtest_periods() {
        let (d, b) = parse_period(p)
            .unwrap_or_else(|e| panic!("事实源档位 {p:?} 被 parse_period 拒绝：{e}"));
        // 两枚举的 Debug 名与档位字符串同型（M1/M5/M15/M30/H1/D1）。
        assert_eq!(format!("{d:?}"), *p, "domain::Period 变体名与档位不一致");
        assert_eq!(format!("{b:?}"), *p, "backtest::Period 变体名与档位不一致");
    }
}

/// M30 显式映射到两枚举的 M30 变体（ADR-024 P0 的核心行为）。
#[test]
fn m30_maps_to_both_m30_variants() {
    let (d, b) = parse_period("M30").expect("M30 必须被 parse_period 接受（ADR-024 P0）");
    assert_eq!(d, domain::types::Period::M30);
    assert_eq!(b, backtest::Period::M30);
}

/// 反向护栏：看板/非回测档位仍不得混入回测白名单（含小写看板码 `30m` 与 W1/MO1）。
#[test]
fn dashboard_and_non_backtest_tiers_still_rejected() {
    for bad in ["30m", "1h", "1d", "W1", "MO1", "1w", "1mo", ""] {
        assert!(
            parse_period(bad).is_err(),
            "{bad:?} 不在回测白名单内，必须被 parse_period 拒绝（回测档位为大写 M30）"
        );
    }
}
