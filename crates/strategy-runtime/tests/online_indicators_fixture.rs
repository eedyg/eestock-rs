//! ADR-024 P2（D6）—— 增量指标 vs 切片视图：**真实 fixture 序列**等价性 + B′ 层偏差枚举。
//!
//! 判据来源：`03-test-plan.md`
//! - §1.2 单测要求「覆盖 `i ∈ {period-1, period, 2×period, n-1}` 与至少一组**真实 fixture 序列**」；
//! - §1.1 **B′ 层报告硬要求**：必须逐字段列出所有 `dev > 0` 的条目（`field, expected, actual, abs, rel`），
//!   禁止只给全局 max 的聚合通过；
//! - §1.1 **C 层禁止项**：偏差不得随 n 增长。
//!
//! 为什么放在 strategy-runtime 的测试目录：`OnlineIndicators` 属 backtest crate，而本仓
//! `backtest` 无 dev-dependencies（不引入新依赖 ⇒ 用 `strategy-runtime` 既有的 `serde_json`
//! 读 golden `bars.jsonl`）。被测对象仍是生产 API（`backtest::OnlineIndicators` /
//! `backtest::Indicators`），无任何替身。
//!
//! fixture 来源：`tester/evidence/240_adr024_golden_baseline/<case>/bars.jsonl`（**只读**，
//! P1 冻结的活库导出序列）。文件不存在时跳过（并打印跳过原因），避免把 tester 资产变成
//! 本 crate 测试的硬依赖。

use backtest::{Bar, Indicators, OnlineIndicators};
use serde_json::Value;

fn golden_bars(case: &str) -> Option<Vec<Bar>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tester/evidence/240_adr024_golden_baseline")
        .join(case)
        .join("bars.jsonl");
    let text = std::fs::read_to_string(&path).ok()?;
    let bars: Vec<Bar> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: Value = serde_json::from_str(l).expect("golden bars.jsonl 应为合法 JSON 行");
            Bar {
                ts: v["ts"].as_i64().expect("ts"),
                open: v["open"].as_f64().expect("open"),
                high: v["high"].as_f64().expect("high"),
                low: v["low"].as_f64().expect("low"),
                close: v["close"].as_f64().expect("close"),
                volume: v["volume"].as_f64().expect("volume"),
            }
        })
        .collect();
    Some(bars)
}

/// B 层判据（03-test-plan.md §1.1）：`|Δ| ≤ max(1e-12, 1e-9 × |expected|)`。
fn b_layer_ok(expected: f64, actual: f64) -> bool {
    (actual - expected).abs() <= 1e-12_f64.max(1e-9 * expected.abs())
}

/// 逐字段枚举（B′）：返回 `(dev>0 条目数, 最大 abs 偏差, 最大 rel 偏差)`，并打印枚举明细。
fn b_prime_report(
    label: &str,
    case: &str,
    index: usize,
    samples: &[(String, Option<f64>, Option<f64>)],
    dev_entries: &mut Vec<String>,
) -> (f64, f64) {
    let mut max_abs = 0.0_f64;
    let mut max_rel = 0.0_f64;
    for (field, expected, actual) in samples {
        let (e, a) = match (expected, actual) {
            (Some(e), Some(a)) => (*e, *a),
            (None, None) => continue,
            _ => {
                dev_entries.push(format!(
                    "[B′-dev] {case} @i={index} {label}.{field}: 存在性不一致 expected={expected:?} actual={actual:?}"
                ));
                continue;
            }
        };
        let abs = (a - e).abs();
        let rel = if e == 0.0 { abs } else { abs / e.abs() };
        if abs > 0.0 {
            dev_entries.push(format!(
                "[B′-dev] {case} @i={index} {label}.{field}: expected={e:.17e} actual={a:.17e} abs={abs:.3e} rel={rel:.3e}"
            ));
        }
        assert!(
            b_layer_ok(e, a),
            "{case} @i={index} {label}.{field}: |Δ|={abs:.3e} 超出 B 层容差 max(1e-12, 1e-9×|{e:.17e}|)"
        );
        max_abs = max_abs.max(abs);
        max_rel = max_rel.max(rel);
    }
    (max_abs, max_rel)
}

/// 真实 fixture 序列（golden 冻结的活库导出）× 全部指标 × 全下标扫描：
/// 逐个 `i` 断言 A 层**位级一致**（`to_bits`），并输出 B/B′/C 层汇总。
#[test]
fn online_indicators_match_slice_view_on_golden_fixture() {
    let cases = ["m1_1slot", "m5_3slots", "h1_1slot"];
    let mut checked_cases = 0;
    let mut dev_entries: Vec<String> = Vec::new();
    let mut global_max_abs = 0.0_f64;
    let mut global_max_rel = 0.0_f64;
    let mut per_case_slope_points: Vec<(usize, f64)> = Vec::new();

    for case in cases {
        let Some(bars) = golden_bars(case) else {
            eprintln!("[skip] golden fixture 不存在：{case}/bars.jsonl（只读资产缺失）");
            continue;
        };
        checked_cases += 1;
        let n = bars.len();
        let key_indices = [13usize, 14, 28, n - 1]; // period=14 的 period-1/period/2×period/n-1
        let mut online = OnlineIndicators::new();
        let mut case_max_abs = 0.0_f64;
        let mut case_max_rel = 0.0_f64;
        let mut leaf_checks = 0usize;

        for i in 0..n {
            let slice = Indicators::new(&bars, i);
            let samples: Vec<(String, Option<f64>, Option<f64>)> = vec![
                (
                    "ma20".into(),
                    slice.ma(20),
                    online.ma(&bars, i, 20),
                ),
                ("ma5".into(), slice.ma(5), online.ma(&bars, i, 5)),
                (
                    "ema12".into(),
                    slice.ema(12),
                    online.ema(&bars, i, 12),
                ),
                (
                    "ema26".into(),
                    slice.ema(26),
                    online.ema(&bars, i, 26),
                ),
                (
                    "rsi14".into(),
                    slice.rsi(14),
                    online.rsi(&bars, i, 14),
                ),
                (
                    "rsi6".into(),
                    slice.rsi(6),
                    online.rsi(&bars, i, 6),
                ),
                (
                    "macd.dif".into(),
                    slice.macd(12, 26, 9).map(|m| m.dif),
                    online.macd(&bars, i, 12, 26, 9).map(|m| m.dif),
                ),
                (
                    "macd.dea".into(),
                    slice.macd(12, 26, 9).map(|m| m.dea),
                    online.macd(&bars, i, 12, 26, 9).map(|m| m.dea),
                ),
                (
                    "macd.hist".into(),
                    slice.macd(12, 26, 9).map(|m| m.hist),
                    online.macd(&bars, i, 12, 26, 9).map(|m| m.hist),
                ),
                (
                    "kdj.k".into(),
                    slice.kdj(9, 3, 3).map(|k| k.k),
                    online.kdj(&bars, i, 9, 3, 3).map(|k| k.k),
                ),
                (
                    "kdj.j".into(),
                    slice.kdj(9, 3, 3).map(|k| k.j),
                    online.kdj(&bars, i, 9, 3, 3).map(|k| k.j),
                ),
                (
                    "boll.mid".into(),
                    slice.boll(20, 2.0).map(|b| b.mid),
                    online.boll(&bars, i, 20, 2.0).map(|b| b.mid),
                ),
                (
                    "boll.upper".into(),
                    slice.boll(20, 2.0).map(|b| b.upper),
                    online.boll(&bars, i, 20, 2.0).map(|b| b.upper),
                ),
                (
                    "atr14".into(),
                    slice.atr(14),
                    online.atr(&bars, i, 14),
                ),
                (
                    "atr2".into(),
                    slice.atr(2),
                    online.atr(&bars, i, 2),
                ),
            ];

            // A 层：位级一致（本项目实现选择同序递推 ⇒ 期望 0 偏差）
            for (field, want, got) in &samples {
                match (want, got) {
                    (Some(w), Some(g)) => assert_eq!(
                        w.to_bits(),
                        g.to_bits(),
                        "{case} @i={i} {field}: 位级不一致 want={w:?} got={g:?}"
                    ),
                    (None, None) => {}
                    _ => panic!("{case} @i={i} {field}: 存在性不一致 want={want:?} got={got:?}"),
                }
            }
            leaf_checks += samples.len();

            // B/B′ 层：显式算出偏差（应恒为 0，此处同时作为判据公式的活体断言）
            let (abs, rel) = b_prime_report("ind", case, i, &samples, &mut dev_entries);
            case_max_abs = case_max_abs.max(abs);
            case_max_rel = case_max_rel.max(rel);

            // 关键下标：额外断言（period-1 / period / 2×period / n-1）
            if key_indices.contains(&i) {
                for (field, want, got) in &samples {
                    println!("[key] {case} @i={i} {field}: slice={want:?} online={got:?}");
                }
            }
        }

        global_max_abs = global_max_abs.max(case_max_abs);
        global_max_rel = global_max_rel.max(case_max_rel);
        per_case_slope_points.push((n, case_max_abs));
        println!(
            "[case] {case}: bars={n} 叶节点比较={leaf_checks} max_abs_dev={case_max_abs:.3e} max_rel_dev={case_max_rel:.3e}"
        );
    }

    assert!(checked_cases > 0, "未找到任何 golden fixture，等价性取证未执行");
    println!(
        "[汇总] cases={checked_cases} 全局 max_abs_dev={global_max_abs:.3e} 全局 max_rel_dev={global_max_rel:.3e} dev>0 条目={}",
        dev_entries.len()
    );
    for e in &dev_entries {
        println!("{e}");
    }
    // C 层：偏差不得随 n 增长 ⇒ 各用例 max_abs_dev 必须全为 0（不随 n 上升）
    assert_eq!(
        dev_entries.len(),
        0,
        "B′ 层要求列出全部 dev>0 条目（见上），且增量实现应位级一致"
    );
    assert_eq!(global_max_abs, 0.0, "C 层：偏差恒为 0 ⇒ 不随 n 增长");
}
