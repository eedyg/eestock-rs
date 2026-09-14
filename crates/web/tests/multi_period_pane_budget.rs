//! 多周期**总 pane 数护栏**（`02-spec.md` §7.4）纯函数契约测试（**红测试，P1-A**）。
//!
//! 口径：`总 pane 数 = 1（基准 candle）+ Σ_卫星(该卫星指标 pane 数)`，每受支持指标占 1 个 pane；
//! 上限 **12**，超限必须**明确报错并拒绝保存**（**不得静默截断**）；**计数必须基于归一化（去重）后的
//! `indicators` 集合**（§2 校验 6「`indicators` ⊆ 受支持集合，去重」+ §7.4）。
//!
//! ### 为什么用纯函数而不是 HTTP 负例（**修订版：P1-D-1 D3 修正**，原论断已被 P1-C 反证）
//! 原文件头曾称「v1 HTTP 面无法表达 >12 pane ⇒ 只做纯函数契约测试」并给出理由「任何 >12 的 body 都会
//! 先被 `indicators` 未支持项规则拒掉」——该论断**不成立**（P1-C 实测：`3 周期 × ["dcap"]×11` 能构造出
//! `23 pane` 并被 pane 护栏拦下，即护栏在 HTTP 面**当时确实可达**）。但可达性的**根因是未去重**
//! （按原始数组长度计数）——那是缺陷 D1，不是护栏语义。
//!
//! 准确的表述（去重语义正确之后）：
//! - v1 受支持指标集合 = `{dcap}`（§2 校验 6）且去重后 ⇒ 每卫星至多 1 个指标 pane；
//! - 卫星 ≤ 3（§2 校验 4 总周期 ≤4）⇒ **总 pane ≤ 1 + 3×1 = 4 < 12**；
//! - 因此任何靠**重复项**堆出来的 >12 都是假象（去重后不增加 pane 数），而靠**不同指标名**堆出的
//!   >12 在 v1 会被「未支持指标」规则先拒（错误维度 = `indicators`）；
//! ⇒ **在 v1（去重语义正确的前提下）HTTP 层无法构造 >12 pane**。「未去重时的 400」是假象，不是反例。
//!
//! 因此本文件把护栏锚定为 `web::dto` 的**纯函数契约**（`multi_period_pane_count` /
//! `verify_multi_period_panes` / 常量 + **去重语义**），并要求 `validate_multi_period_config` 调用之；
//! HTTP 面在 v1 只保留**正例**（去重后最大合法形态必 200、重复项不得伪造 >12 pane —— 见
//! `api_multi_period_config.rs` 的 §2-6 / D1 用例）。
//! **P2 起**（受支持指标集合扩张 ⇒ 去重后仍可 >12）**必须补 HTTP 级负例**（现成构造：多个不同受支持指标）。
//!
//! 预期 red 理由：P1-A 阶段上述三个符号**尚不存在** ⇒ 编译失败；P1-D-1 阶段新增的 D1/D2 用例在
//! **去重语义**落地前必须保持红（见文件末尾「D1/D2 红用例」段）。
//! ⚠️ 红阶段勿跑 `cargo test -p web`（本文件未编译会挡住同 crate 其它 test target）；
//! 单目标取证命令见执行报告。本文件**非 tangle 生成物**（`file=` 未声明 ⇒ 改注释/加用例无需 doc-first）。

use web::dto::{multi_period_pane_count, verify_multi_period_panes, MULTI_PERIOD_MAX_PANES};

fn periods(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_string()).collect()
}

/// 指标集合需 >1 项才能触到上限 ⇒ 这里的「受支持集」是**公式输入**（非 v1 配置面约束）
fn indicators(n: usize) -> Vec<String> {
    (0..n).map(|i| format!("ind{i}")).collect()
}

/// 重复项构造器（D1：**同一个**指标名重复 n 次；例 `["dcap"]×11`）。
fn repeated(name: &str, n: usize) -> Vec<String> {
    vec![name.to_string(); n]
}

/// 「错误串是否指名了被拒维度」判据（D2；P1-C D2 判定 + 架构师 P1-D-1 派单口径）。
///
/// 接受的形式（**可被调用方定位**的维度名，与被拒字段名 `periods`/`heights`/`indicators` 同一风格）：
/// - `indicators`（v1 中真正需要缩减的请求字段）；
/// - **字段标记形式**的 `pane`：`pane:` / `pane：` / `pane=` / `"pane"` / `[pane]` / `` `pane` ``，
///   或错误串**以 `pane` 开头**（字段名在句首）。
///
/// 反面样本（**不算**）：`总 pane 数 16 超上限 12（基准 1 + Σ_卫星指标 pane）` —— 句中「pane」只是算式
/// 里的量词，既不是请求字段名、也不是字段标记（P1-C D2 判定：调用方无法据此定位该改哪个字段）。
fn names_rejected_dimension(err: &str) -> bool {
    const FIELD_FORMS: [&str; 7] = [
        "pane:", "pane：", "pane=", "\"pane\"", "[pane]", "`pane`", "pane]",
    ];
    err.contains("indicators")
        || FIELD_FORMS.iter().any(|f| err.contains(f))
        || err.trim_start().starts_with("pane")
}

#[test]
fn pane_budget_cap_is_12() {
    assert_eq!(MULTI_PERIOD_MAX_PANES, 12, "总 pane 上限 = 12（02-spec §7.4）");
}

#[test]
fn pane_count_formula_is_base_plus_per_satellite_panes() {
    // 1 周期（仅基准）⇒ 1 个 pane（基准 candle）
    assert_eq!(multi_period_pane_count(&periods(&["1m"]), &periods(&["dcap"])), 1);
    // 2 周期（基准 + 1 卫星）× 1 指标 ⇒ 1 + 1 = 2
    assert_eq!(multi_period_pane_count(&periods(&["1m", "5m"]), &periods(&["dcap"])), 2);
    // v1 最大合法形态：4 周期 × 1 指标 ⇒ 1 + 3 = 4
    assert_eq!(
        multi_period_pane_count(&periods(&["1m", "5m", "15m", "1h"]), &periods(&["dcap"])),
        4,
        "v1 最大合法配置 = 4 个 pane（远低于上限 ⇒ 护栏不得误拒）"
    );
}

#[test]
fn pane_budget_boundary_is_inclusive_at_12_and_rejects_13() {
    // 边界：1 + 1 卫星 × 11 指标 = 12 ⇒ **恰好等于上限 ⇒ 允许**
    let p2 = periods(&["1m", "5m"]);
    let ind11 = indicators(11);
    let ind12 = indicators(12);
    assert_eq!(multi_period_pane_count(&p2, &ind11), MULTI_PERIOD_MAX_PANES, "12 = 1 + 1×11");
    assert_eq!(multi_period_pane_count(&p2, &ind12), MULTI_PERIOD_MAX_PANES + 1, "13 = 1 + 1×12");
    assert!(verify_multi_period_panes(&p2, &ind11).is_ok(), "恰好 12 ⇒ 允许保存");
}

#[test]
fn over_budget_must_be_rejected_with_explicit_error_not_silent_truncation() {
    let p4 = periods(&["1m", "5m", "15m", "1h"]);
    let ind5 = indicators(5);
    // 1 + 3 卫星 × 5 指标 = 16 > 12
    assert_eq!(multi_period_pane_count(&p4, &ind5), 16, "1 + 3×5 = 16");
    assert!(
        multi_period_pane_count(&p4, &ind5) > MULTI_PERIOD_MAX_PANES,
        "超限判定必须成立（> 12）"
    );

    let err = verify_multi_period_panes(&p4, &ind5)
        .expect_err("总 pane 16 > 12 ⇒ 必须返回 Err（不得静默截断为 12）");
    assert!(err.contains("pane"), "错误信息必须含被拒维度 `pane`（明确报错），收到：{err}");

    // 反向对照：同周期下 5 指标换成 2 指标（1 + 3×2 = 7 ≤ 12）⇒ 允许
    assert!(verify_multi_period_panes(&p4, &indicators(2)).is_ok(), "1 + 3×2 = 7 ≤ 12 ⇒ 允许");
}

// ─────────────────────────────────────────────────────────────────────────────
// D1/D2 红用例（P1-D-1 指派；依据 P1-C 独立验收 D1/D2 与 02-spec §2-6 / §7.4）
// ─────────────────────────────────────────────────────────────────────────────

/// **D1**：pane 计数必须基于**去重后**的 `indicators` 集合（`["dcap"]×n` 与 `["dcap"]` 结果相同）。
///
/// 红理由（P1-C 实测）：`multi_period_pane_count` 用**原始数组长度**计数 ⇒ `["dcap"]×11` 在 3 卫星下
/// 被判 `1 + 3×11 = 34`（P1-C 探针实测 23，2 卫星）⇒ 语义等价的合法配置被 400 误拒。
#[test]
fn d1_pane_count_uses_deduped_indicator_set_not_raw_length() {
    let p4 = periods(&["1m", "5m", "15m", "1h"]);
    let one = periods(&["dcap"]);
    let expect = multi_period_pane_count(&p4, &one);
    assert_eq!(expect, 4, "去重后：基准 1 + 3 卫星 × 1 指标 = 4");

    for n in [2usize, 3, 11, 12, 24] {
        assert_eq!(
            multi_period_pane_count(&p4, &repeated("dcap", n)),
            expect,
            "D1：[\"dcap\"]×{n} 与 [\"dcap\"] 语义等价 ⇒ 总 pane 计数结果必须相同（基于去重后集合，\
             不得按原始数组长度计数）"
        );
    }

    // 2 周期（1 卫星）同理：去重后 = 1 + 1×1 = 2
    let p2 = periods(&["1m", "5m"]);
    assert_eq!(
        multi_period_pane_count(&p2, &repeated("dcap", 11)),
        2,
        "D1：去重后 1 + 1×1 = 2（不得为 1 + 1×11 = 12）"
    );
}

/// **D1**：去重后 4 周期形态（卫星 ≤3 × 去重后 1 指标 ⇒ pane 4）**必 200/允许**；
/// 重复项**无法**伪造 >12 pane（P1-C 缺陷 D1 的直接后果）。
#[test]
fn d1_duplicate_items_cannot_forge_over_budget_and_legal_shape_is_accepted() {
    let p4 = periods(&["1m", "5m", "15m", "1h"]);
    for n in [1usize, 2, 3, 11, 12, 24] {
        let inds = repeated("dcap", n);
        let got = multi_period_pane_count(&p4, &inds);
        assert!(
            verify_multi_period_panes(&p4, &inds).is_ok(),
            "D1：去重后总 pane = {got} ≤ {MULTI_PERIOD_MAX_PANES} ⇒ 必须允许保存\
             （重复 {n} 次不得伪造 >12 pane、不得误拒）"
        );
    }

    // 反向对照（护栏不得被削弱）：**去重后仍有 5 个不同指标** ⇒ 1 + 3×5 = 16 > 12 ⇒ 必须拒绝
    let err = verify_multi_period_panes(&p4, &indicators(5))
        .expect_err("去重后 5 个不同指标 ⇒ 1+3×5=16 > 12 ⇒ 必须拒绝");
    assert!(!err.is_empty(), "拒绝必须给出非空错误串");
}

/// **D2**：pane 预算越限的错误串**必须含被拒维度名**（纯函数路径构造；v1 HTTP 面无法构造 >12）。
///
/// 红理由（P1-C D2）：现状为 `总 pane 数 16 超上限 12（基准 1 + Σ_卫星指标 pane）` —— 只出现算式里的
/// 「pane」字样，**不含被拒字段名**（对照 `periods`/`heights`/`indicators` 负例均含字段名）。
#[test]
fn d2_over_budget_error_names_the_rejected_dimension() {
    let p4 = periods(&["1m", "5m", "15m", "1h"]);
    let err = verify_multi_period_panes(&p4, &indicators(5))
        .expect_err("去重后 1 + 3×5 = 16 > 12 ⇒ 必须 Err");

    assert!(
        names_rejected_dimension(&err),
        "D2：pane 预算错误串必须含**可定位的被拒维度名**——`indicators`（请求字段），或字段标记形式的 \
         `pane`（`pane:` / `pane：` / `pane=` / `\"pane\"` / `[pane]` / 句首 `pane`）；\
         仅中文算式里出现「pane」字样不算（P1-C D2 判定）。收到：{err}"
    );

    // 反向对照（判据不得过宽）：P1-C 记录的现状字符串必须被判为「未指名维度」
    let p1c_observed =
        "总 pane 数 23 超上限 12（基准 1 + Σ_卫星指标 pane）".to_string();
    assert!(
        !names_rejected_dimension(&p1c_observed),
        "D2 判据自检：P1-C 实测字符串（算式里的 pane 字样）必须被判为未指名被拒维度"
    );
}

/// **D2 判据自检**（**独立于红断言**：即使 `d2_over_budget_error_names_the_rejected_dimension` 仍红，
/// 本用例也持续用机检证明「哪些串算指名了被拒维度」，供实现方对齐；口径见本文件 `names_rejected_dimension`）。
#[test]
fn d2_dimension_predicate_boundary_is_pinned() {
    // 不接受：P1-C 实测现状串（算式里的 pane 字样，不是被拒字段名）
    assert!(
        !names_rejected_dimension("总 pane 数 23 超上限 12（基准 1 + Σ_卫星指标 pane）"),
        "现状串必须被判为『未指名被拒维度』（否则 D2 判据过宽、失去判别力）"
    );
    assert!(
        !names_rejected_dimension("总 pane 数 16 超上限 12"),
        "只报数量不报维度名 ⇒ 不算指名"
    );
    // 接受：请求字段名 `indicators`
    assert!(names_rejected_dimension("indicators 总 pane 数 16 超上限 12（基准 1 + Σ_卫星指标 pane）"));
    assert!(names_rejected_dimension("multi_period 请求体非法：indicators 过大"));
    // 接受：字段标记形式的 `pane`
    assert!(names_rejected_dimension("pane: 16 > 12（基准 1 + Σ_卫星指标 pane 数）"));
    assert!(names_rejected_dimension("pane=16 超上限 12"));
    assert!(names_rejected_dimension("pane 预算超限：16 > 12"));
    assert!(names_rejected_dimension("{\"error\":\"总 pane 数 16 超上限 12\",\"field\":\"pane\"}"));
    assert!(names_rejected_dimension("[pane] 16 > 12"));
    assert!(names_rejected_dimension("`pane` 16 > 12"));
}
