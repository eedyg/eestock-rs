//! ADR-023 D1 红测试（**手写**）：判据 J4 —— M30 的合并读源 / 兜底 / forming 桶。
//!
//! ## 可达性说明（IMPORTANT，不许用「无法测试」跳过）
//! `period_merged_sql(p)`（crates/storage/src/reader.rs:103）与 `forming_sql(period)`（:118）均为**私有**
//! 自由函数（`fn`，无 `pub`），且 crate 内**没有任何 pub 访问器**暴露其产出的 SQL（`KlineReader` 只暴露
//! `bars/latest_bar/...`，全部直接打 DB）。因此从外部测试 crate **无法调用**它们。
//!
//! 选用的可执行断言路径：**对 `crates/storage/src/reader.rs` 源码文本做结构化断言**（`include_str!` 编译期
//! 绑定同一文件），逐条映射 ADR-023 §5.1 的 SQL 判据：
//!   - M30 分支必须引用 accurate cagg 关系 `kline_accurate_30m`；
//!   - 兜底必须是 **30m 的查询期 rollup，源 `kline_15m`，桶宽 `30 minutes`**（ADR-023 §2.2「不新建 raw 层 kline_30m，采 1h 风格」）；
//!   - forming（进行中桶）对 M30 必须非 None 且桶宽 `30 minutes`（ADR-023 §2.3）；
//!   - 既有 M5/M15/H1 forming 与「非日内周期返回 None」不得被弱化。
//! 局限（已在执行报告残留风险中登记）：本断言证明的是**实现文本**，非运行时行为（运行时行为需 DB，D1 阶段无库）。
//! 契约出处：ADR-023 §2.2 / §2.3 / §5.1。

const READER_SRC: &str = include_str!("../src/reader.rs");

/// 取 `start` 之后、`end` 之前的第一段文本（找不到 start ⇒ panic）。
fn slice_between<'a>(src: &'a str, start: &str, end: &str, what: &str) -> &'a str {
    let i = src
        .find(start)
        .unwrap_or_else(|| panic!("reader.rs 中找不到 {what} 的起点 `{start}`（ADR-023 要求其存在）"));
    let rest = &src[i..];
    match rest.find(end) {
        Some(j) if j > 0 => &rest[..j],
        _ => rest,
    }
}

/// 取 `Period::M30 => ...` 那一条 match 臂的整行文本。
fn m30_arm_line<'a>(src: &'a str, what: &str) -> &'a str {
    let i = src
        .find("Period::M30")
        .unwrap_or_else(|| panic!("{what} 中没有 `Period::M30` 分支（ADR-023 要求补该分支）"));
    let rest = &src[i..];
    match rest.find('\n') {
        Some(j) => &rest[..j],
        None => rest,
    }
}

/// 取从 `needle` 起、最多 `len` 字节的窗口（越界自动截断）。
fn window_from<'a>(src: &'a str, needle: &str, len: usize, what: &str) -> &'a str {
    let i = src
        .find(needle)
        .unwrap_or_else(|| panic!("reader.rs 中找不到 {what}（`{needle}`）——ADR-023 要求其存在"));
    &src[i..(i + len).min(src.len())]
}

fn merged_body() -> &'static str {
    slice_between(READER_SRC, "fn period_merged_sql(", "\n}\n", "period_merged_sql()")
}

fn forming_body() -> &'static str {
    slice_between(READER_SRC, "fn forming_sql(", "\n}\n", "forming_sql()")
}

/// J4-a：合并读 SQL 的 M30 分支必须走 accurate cagg 关系 `kline_accurate_30m`。
#[test]
fn j4a_merged_sql_m30_uses_accurate_30m_relation() {
    let arm = m30_arm_line(merged_body(), "period_merged_sql()");
    assert!(
        arm.contains("kline_accurate_30m"),
        "ADR-023 §2.2/§5.1：period_merged_sql 的 M30 臂必须引用 `kline_accurate_30m`；实际该臂 = {arm:?}"
    );
}

/// J4-b：兜底分支 = 30m 查询期 rollup（源 `kline_15m`，桶宽 `30 minutes`）。
/// 容错：常量可命名 `FALLBACK_30M`（ADR-023 §2.2 命名），也可在 M30 臂内联 SQL；两种写法都接受，
/// 只要「M30 读源附近」同时出现 `kline_15m` 与 `30 minutes` rollup 语义。
#[test]
fn j4b_fallback_is_30m_rollup_over_kline_15m() {
    let fb = if READER_SRC.contains("const FALLBACK_30M") {
        window_from(READER_SRC, "const FALLBACK_30M", 1200, "FALLBACK_30M 常量定义")
    } else {
        // 退化路径：实现把兜底内联进 M30 臂 → 从 M30 臂起取窗口
        window_from(merged_body(), "Period::M30", 1200, "period_merged_sql 的 M30 臂")
    };
    assert!(
        fb.contains("kline_15m"),
        "ADR-023 §2.2：30m 兜底必须是 kline_15m 的查询期 rollup（镜像 FALLBACK_1H 形态）；实际窗口 = {fb:?}"
    );
    assert!(
        fb.contains("30 minutes"),
        "ADR-023 §2.2：30m 兜底桶宽必须是 `30 minutes`（与 15m 桶 2:1 对齐）；实际窗口 = {fb:?}"
    );
    assert!(
        fb.contains("time_bucket"),
        "ADR-023 §2.2：30m 兜底必须是查询期 `time_bucket` rollup；实际窗口 = {fb:?}"
    );
}

/// J4-c：forming（进行中桶）对 M30 非 None 且桶宽 = `30 minutes`。
#[test]
fn j4c_forming_sql_m30_is_30_minutes() {
    let arm = m30_arm_line(forming_body(), "forming_sql()");
    assert!(
        arm.contains("30 minutes"),
        "ADR-023 §2.3：forming_sql 的 M30 桶宽必须是 \"30 minutes\"（否则 30m 进行中 bar 不随 1m 前进）；实际该臂 = {arm:?}"
    );
}

/// J4-d 反向护栏：既有日内 forming 桶与非日内 None 语义不得被弱化。
#[test]
fn j4d_existing_forming_and_non_intraday_none_unchanged() {
    let body = forming_body();
    for needle in ["Period::M5", "5 minutes", "Period::M15", "15 minutes", "Period::H1", "1 hour"] {
        assert!(body.contains(needle), "既有 forming 契约被弱化：缺 {needle:?}");
    }
    assert!(
        body.contains("_ => return None"),
        "非日内周期（D1/W1/MO1）forming 必须仍返回 None（ADR-023 §2.3 未改动该语义）"
    );
}

/// J4-e 反向护栏：M30 兜底**不得**新建 raw 层 `kline_30m`（ADR-023 §2.2 明确「不新建 raw 层 kline_30m」）。
#[test]
fn j4e_no_raw_layer_kline_30m_reference() {
    assert!(
        !READER_SRC.contains("kline_30m"),
        "ADR-023 §2.2：本 ADR 不新建 raw 层 `kline_30m`；reader.rs 不得出现该关系名（只允许 kline_accurate_30m）"
    );
}
