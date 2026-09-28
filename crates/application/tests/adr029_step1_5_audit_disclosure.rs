//! ADR-029 **Step 1.5** Lane B 判据（`06-plan` §3/§4：E22/E23/E24）——审计披露与成本感知。
//!
//! 契约源：`design/12-strategy-system/06-plan-exposure-step1_5.md` §3（审计与披露）§4（判据）
//! + `ADR-029` §8（D14/D15）。**本文件只做判据，无 IO**。
//!
//! 全部经公开投影/纯函数入口进入（`exposure_from_per_bar` / `orders_from_per_bar` /
//! `fills_from_json` / `exposure_audit` / `compute_audit`）⇒ **不写任何 `AuditExposureBar`
//! 结构体字面量**（新键由 JSON 侧进入），保证判据锁的是「**落库键 → 派生量**」这条链，
//! 而非 Rust 结构体形状。
//!
//! 真实读数来源（`docker exec eestock-timescaledb psql … strategy_run_bars`，逐字节落盘为 fixture）：
//! - `fixtures/adr029_step1_5_run000007_fills.json`：`sr_1790610997443_000007`
//!   （Exposure/ScoreMapped(Scaled)＋RateCap(0.05)；59 笔成交、佣金 297.88046603388085、
//!   成交额 93287.71795623182、`capital_basis` 100000、fee = {0.025 / 5.0 / 0.0 / 2.0}）；
//! - `fixtures/adr029_step1_5_run000023_fills.json`：`sr_1790349931357_000023`
//!   （F2/F3 那例：末笔 `ForceClose` 卖出 **28.422648758307673** 股 = 残仓，
//!   末根 bar（bar 427）的 `current_pct = 0.002496` —— **低于** 判据阈值 0.005）。

use application::audit::{
    compute_audit, exposure_audit, exposure_from_per_bar, fills_from_json, orders_from_per_bar,
    AuditFill, AuditInput, AuditOrder, ExposureAudit,
};
use backtest::FeeModel;
use serde_json::{json, Value};
use strategy_core::{ExecutionPolicy, OrderReason, OrderSide};

// ── 真实读数（fixture 逐字节取自活库；见模块头注） ─────────────────────────────

const RUN_000007_FILLS: &str = include_str!("fixtures/adr029_step1_5_run000007_fills.json");
const RUN_000023_FILLS: &str = include_str!("fixtures/adr029_step1_5_run000023_fills.json");

/// 两个 run 的 `config.initial_capital`（真实值 100000）。
const CAPITAL: f64 = 100_000.0;

/// 生效 fee 契约（`config.fee` 逐字：`{"min_fee":5.0,"rate_pct":0.025,"slippage_bp":2.0,"stamp_duty_pct":0.0}`）。
fn fee_run() -> FeeModel {
    FeeModel { commission_rate_pct: 0.025, min_commission: 5.0, stamp_duty_pct: 0.0, slippage_bp: 2.0 }
}

fn fills_of(raw: &str) -> Vec<AuditFill> {
    let v: Vec<Value> = serde_json::from_str(raw).expect("fixture 须是成交数组");
    fills_from_json(&v)
}

/// `Exposure` 缺省形态策略（`ScoreMapped(0.2, 0.5, Flat)` × `RateCap(0.05)` × `guard`）。
///
/// `down_pct_per_bar` / `on_signal_break` / `deadzone_min_notional` 全缺省 ⇒ 与现行（Step 1）逐字节一致。
fn exposure_policy() -> ExecutionPolicy {
    serde_json::from_value(json!({
        "Exposure": {
            "target": {"ScoreMapped": {"at_threshold_pct": 0.2, "at_full_pct": 0.5, "sell": "Flat"}},
            "ramp": {"RateCap": {"pct_per_bar": 0.05}},
            "guard": {"max_pct": 0.9, "min_pct": 0.0, "deadzone_pct": 0.005}
        }
    }))
    .expect("Exposure 策略 JSON 须可解析")
}

fn lump_policy() -> ExecutionPolicy {
    serde_json::from_value(json!({"LumpSum": {"position_pct": 1.0}})).expect("LumpSum JSON")
}

/// `per_bar` JSON 族生成（键名与 `bar_record_json` 同：`warmup`/`target_pct`/`current_pct`/`intent_pct`）。
/// `intent = None` ⇒ **不写该键**（= 旧 run / Step 1.5 之前的记录形态）。
///
/// 元组首元素是**期望的 `bar_index`**（投影按数组下标取值，见 `exposure_from_per_bar`）⇒
/// 不一致直接 panic（防「写 427 实得 1」这类脚枪；真实 bar 序号对 message 有意义）。
fn bars_json(rows: &[(usize, f64, f64, Option<f64>)]) -> Vec<Value> {
    bars_json_at(0, rows)
}

/// 同 `bars_json`，但首根 bar 的数组下标 = `base`（供 [`bars_with_prefix`] 接续）。
fn bars_json_at(base: usize, rows: &[(usize, f64, f64, Option<f64>)]) -> Vec<Value> {
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row.0, base + i, "元组首元素须 = 数组下标（bar_index 口径）");
    }
    rows.iter()
        .map(|(_, target, current, intent)| {
            let mut o = serde_json::Map::new();
            o.insert("warmup".into(), json!(false));
            o.insert("target_pct".into(), json!(target));
            o.insert("current_pct".into(), json!(current));
            if let Some(v) = intent {
                o.insert("intent_pct".into(), json!(v));
            }
            o.insert("orders".into(), json!([]));
            Value::Object(o)
        })
        .collect()
}

/// 指定 `bar_index` 的观测序列：前 `prefix` 根平凡 bar（`target == current`、无 `intent_pct`）
/// 后再接 `rows`（`rows[0].0` 必须 = `prefix`）。
fn bars_with_prefix(prefix: usize, rows: &[(usize, f64, f64, Option<f64>)]) -> Vec<Value> {
    let mut v: Vec<Value> = (0..prefix)
        .map(|_| json!({"warmup": false, "target_pct": 0.05, "current_pct": 0.05, "orders": []}))
        .collect();
    v.extend(bars_json_at(prefix, rows));
    v
}

/// 计数型输入：`n` 根平凡观测 bar（`target == current` ⇒ 零差、零告警）。
fn flat_bars(n: usize) -> Vec<Value> {
    (0..n)
        .map(|_| json!({"warmup": false, "target_pct": 0.05, "current_pct": 0.05, "orders": []}))
        .collect()
}

/// 计数型输入：`n` 笔 Buy 挂单（经 `orders_from_per_bar` 投影 ⇒ 与线上同一条路）。
fn orders_n(n: usize) -> Vec<AuditOrder> {
    let bars: Vec<Value> = (0..n)
        .map(|_| json!({"warmup": false, "orders": [{"side": "Buy", "qty": 1.0, "reason": "Policy"}]}))
        .collect();
    orders_from_per_bar(&bars).0
}

fn json_of<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("审计结构须可序列化")
}

/// 告警码列表（读**结构字段**：`ExposureAudit.warnings` 是结构内字段，按契约**不出 JSON**
/// —— 读侧把它合并进顶层 `warnings[]`，避免同一事实两个出口）。
fn wcodes(r: &ExposureAudit) -> Vec<String> {
    r.warnings.iter().map(|w| w.code.to_string()).collect()
}

fn wmsg<'a>(r: &'a ExposureAudit, code: &str) -> &'a str {
    r.warnings
        .iter()
        .find(|w| w.code == code)
        .unwrap_or_else(|| panic!("缺告警 {code}：{:?}", r.warnings))
        .message
        .as_str()
}

/// 结构化段 JSON（= `06-plan` §3.1 的 `exposure` 对象形态）。
fn segment(r: &ExposureAudit) -> Value {
    json_of(r)
}

/// 顶层 `AuditReport` 的 `warnings[]`（读侧合并后的出口）。
fn codes(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("warnings 须为数组")
        .iter()
        .map(|w| w["code"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "expected {b}, got {a}（差 {}）", (a - b).abs());
}

// ════════════════════════════════════════════════════════════════════════════
// E24：结构化 `exposure` 段
// ════════════════════════════════════════════════════════════════════════════

/// E24 ①（**历史兼容**）：`per_bar` **无** `intent_pct` 键（旧 run / Step 1.5 之前）
/// ⇒ 意图层三个指标一律 `null`，**且意图类告警不得触发**（禁把「无数据」读成「意图达成」）。
#[test]
fn e24_intent_metrics_are_null_for_runs_without_intent_key() {
    let policy = exposure_policy();
    // 旧 run 形态：只有 target_pct/current_pct（无 intent_pct）。执行层差 0.30 超阈 ⇒ 只有
    // `EXPOSURE_INTENT_GAP` 发声；若把「缺数据」当 0.0 或按 target 兜底，意图层两码会误触发（本用例的鉴别力）。
    let bars = exposure_from_per_bar(&bars_json(&[
        (0, 0.10, 0.00, None),
        (1, 0.60, 0.10, None),
        (2, 0.60, 0.30, None),
    ]));
    let r = exposure_audit(&bars, &[], &[], fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);
    assert_eq!(j["max_intent_gap"], json!(null), "无 intent_pct 键 ⇒ 意图层差一律 null：{j}");
    assert_eq!(j["max_intent_gap_bar"], json!(null), "{j}");
    assert_eq!(j["unmet_intent_bars"], json!(null), "{j}");
    close(j["max_target_gap"].as_f64().unwrap(), 0.3);
    assert_eq!(j["max_target_gap_bar"], json!(1), "执行层定位照常（与意图层无关）");
    let cs = wcodes(&r);
    assert_eq!(cs, vec![INTENT_GAP], "无意图数据 ⇒ 只有执行层码发声：{j}");
    assert!(!cs.contains(&UNMET.to_string()) && !cs.contains(&RESIDUAL.to_string()));
}

/// E24 ②：有 `intent_pct` ⇒ 三指标按契约口径计算（**滞后一 bar**；末根无 `t+1` 排除）。
#[test]
fn e24_intent_metrics_are_computed_when_intent_is_recorded() {
    let policy = exposure_policy();
    // 意图差：bar0 |0.30 − c1 0.31| = 0.01；bar1 |0.60 − c2 0.35| = 0.25（max）；bar2 无 t+1 ⇒ 排除。
    // 未达成意图：|intent − target| > deadzone(0.005) ⇒ 仅 bar2（|0.62 − 0.50| = 0.12）计 1 根。
    let bars = exposure_from_per_bar(&bars_json(&[
        (0, 0.30, 0.00, Some(0.30)),
        (1, 0.60, 0.31, Some(0.60)),
        (2, 0.50, 0.35, Some(0.62)),
    ]));
    let r = exposure_audit(&bars, &[], &[], fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);
    close(j["max_intent_gap"].as_f64().unwrap(), 0.25);
    assert_eq!(j["max_intent_gap_bar"], json!(1), "差出在决策 bar 1（对齐 bar2 的实际暴露）");
    assert_eq!(j["unmet_intent_bars"], json!(1), "仅 bar2 满足 |intent − target| > deadzone");
    close(j["max_target_gap"].as_f64().unwrap(), 0.25); // |target_1 0.60 − current_2 0.35|
}

/// E24 ③：结构化段的**冻结键集/键序**（`06-plan` §3.1 样例逐字 17 键）＋
/// `warnings` **不出 JSON**（结构内字段，已合并进顶层 `warnings[]`，禁重复出口）。
#[test]
fn e24_exposure_segment_serializes_frozen_key_set() {
    let policy = exposure_policy();
    let bars = exposure_from_per_bar(&bars_json(&[
        (0, 0.30, 0.00, Some(0.30)),
        (1, 0.30, 0.30, Some(0.30)),
    ]));
    let r = exposure_audit(&bars, &[], &[], fee_run(), CAPITAL, Some(&policy));
    // 键**序**只能在原始序列化文本上断言（`Value` 的 `Map` 是 BTreeMap ⇒ 键序丢失）。
    let raw = serde_json::to_string(&r).unwrap();
    let frozen = [
        "bars",
        "orders",
        "orders_per_bar",
        "fees",
        "fee_pct",
        "nominal_fee_rate",
        "cost_amplification",
        "max_target_gap",
        "max_target_gap_bar",
        "max_intent_gap",
        "max_intent_gap_bar",
        "unmet_intent_bars",
        "clamped_bars",
        "deadzone_blocked_bars",
        "rate_limited_bars",
        "sell_transition_bars",
        "affordability_capped_bars",
    ];
    let mut cursor = 0usize;
    for k in frozen {
        let pos = raw[cursor..]
            .find(&format!("\"{k}\":"))
            .unwrap_or_else(|| panic!("序列化文本缺键 {k}（或键序与契约序不一致）：{raw}"))
            + cursor;
        cursor = pos;
    }
    let obj = segment(&r);
    let keys: std::collections::BTreeSet<&str> =
        obj.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        frozen.iter().copied().collect::<std::collections::BTreeSet<_>>(),
        "exposure 段键集 = 06-plan §3.1 样例；`warnings` 为结构内字段但**不出 JSON**（有意）"
    );
    assert_eq!(obj.as_object().unwrap().len(), frozen.len(), "不得多出/少字段");
    assert!(!raw.contains("\"warnings\""));
}

/// E24 ④：纯函数 `compute_audit` 不产出 `exposure`（读侧门禁后由 `run_audit` 组装）
/// ⇒ 占位 `null`；且序列化文本上 `exposure` **排在 `warnings` 之后**（契约键序）。
#[test]
fn e24_compute_audit_leaves_exposure_null_placeholder() {
    let policy = exposure_policy();
    let report = compute_audit(&AuditInput {
        recorded: true,
        orders: &[],
        fills: &[],
        trades: &[],
        last_bar_index: None,
        fee: fee_run(),
        initial_capital: CAPITAL,
        policy: Some(&policy),
    });
    let raw = serde_json::to_string(&report).unwrap();
    let w = raw.find("\"warnings\":").expect("顶层须有 warnings");
    let e = raw.find("\"exposure\":").expect("顶层须有 exposure（追加在 warnings 之后）");
    assert!(w < e, "`exposure` 须追加在 `warnings` 之后：{raw}");
    assert_eq!(json_of(&report)["exposure"], json!(null), "占位必须为 null（组装在读侧）");
    // 顶层 `warnings[]`（既有出口）不受新增段影响：本输入无持仓 ⇒ 仅既有 PARTIAL_DEPLOYMENT。
    assert_eq!(codes(&json_of(&report)["warnings"]), vec!["PARTIAL_DEPLOYMENT"]);
}

// ════════════════════════════════════════════════════════════════════════════
// E22：残仓披露（`EXPOSURE_RESIDUAL_INTENT`）
// ════════════════════════════════════════════════════════════════════════════

const RESIDUAL: &str = "EXPOSURE_RESIDUAL_INTENT";

/// E22 ①（**构造用例**，形态取自 000023）：末根 `intent_pct == 0 ∧ current_pct > 0.005`
/// ⇒ 必出 `EXPOSURE_RESIDUAL_INTENT`；message 含 残仓比例 / 残仓股数 / 末根 bar 序号 / **口径标签**，
/// 且主口径股数与该 run 的真实 `ForceClose` 成交量**逐位相等**（28.422648758307673）。
///
/// ⚠ **构造**说明：真实 `sr_1790349931357_000023` 的末根 `current_pct = 0.002496 < 0.005`
/// （阈值 0.005 为契约钉死值）⇒ **真实 run 不触发**（见下一条负向判据）。构造只把比例抬到阈值之上，
/// 其余（末笔 `ForceClose` 股数 / 末根 bar 序号 427 / 无政策挂单）全部取真实值。
#[test]
fn e22_residual_intent_constructed_000023_shape_uses_real_force_close_qty() {
    let policy = exposure_policy();
    let fills = fills_of(RUN_000023_FILLS);
    // 末根 bar 序号 = 427（= 该 run `ForceClose` 成交的 bar_index，真实值）。
    let bars = exposure_from_per_bar(&bars_with_prefix(426, &[
        (426, 0.0, 0.002_508, Some(0.0)),
        (427, 0.0, 0.006_000, Some(0.0)), // 构造：抬到阈值 0.005 之上（真实 = 0.002496）
    ]));
    let r = exposure_audit(&bars, &[], &fills, fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);
    assert_eq!(wcodes(&r), vec![RESIDUAL], "残仓必披露：{j}");
    let msg = wmsg(&r, RESIDUAL);
    assert!(msg.contains("0.0060"), "须含残仓比例（末根 current_pct）：{msg}");
    assert!(msg.contains("bar 427"), "须含末根 bar 序号：{msg}");
    assert!(msg.contains("口径：收尾强平成交量"), "须显式标注所用口径（主口径）：{msg}");
    assert!(
        !msg.contains("进入末根 bar 时持仓"),
        "两口径一致时只报主口径（不必并列）：{msg}"
    );
    // 主口径逐位相等：Σ signed qty over reason == ForceClose 的绝对值。
    let fc: f64 = fills
        .iter()
        .filter(|f| f.reason == Some(OrderReason::ForceClose))
        .map(|f| if f.side == OrderSide::Buy { f.qty } else { -f.qty })
        .sum::<f64>()
        .abs();
    assert!((fc - 28.422_648_758_307_673).abs() < 1e-12, "真实 ForceClose 合计须可复现：{fc}");
    assert!(msg.contains("28.422649"), "须含残仓股数（= 主口径实测值 28.422649）：{msg}");
}

/// E22 ②（**负向**，抗「阈值被偷偷放宽」）：真实 000023 的末根读数 `current_pct = 0.002496`
/// ⇒ **不得**触发（阈值 0.005 为契约值；本判据防阈值被改大后被阳性用例掩盖）。
#[test]
fn e22_real_000023_reading_does_not_trigger() {
    let policy = exposure_policy();
    let fills = fills_of(RUN_000023_FILLS);
    // 真实读数（活库逐字）：末根 `current_pct = 0.002496`；该 run 死区命中 ⇒ `target ≡ current`。
    let bars = exposure_from_per_bar(&bars_with_prefix(426, &[
        (426, 0.002_508, 0.002_508, Some(0.0)),
        (427, 0.002_496, 0.002_496, Some(0.0)),
    ]));
    let r = exposure_audit(&bars, &[], &fills, fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);
    assert_eq!(wcodes(&r), Vec::<String>::new(), "0.002496 < 0.005 ⇒ 不得触发：{j}");
}

/// E22 ③：fills 的 `reason` 不可得（旧记录/缺列）⇒ 走**降级口径**「进入末根 bar 时持仓」，
/// message 的口径标签随之改变（禁静默沿用主口径标签）。
#[test]
fn e22_missing_reason_falls_back_to_entry_holdings_with_changed_label() {
    let policy = exposure_policy();
    let raw: Vec<Value> = serde_json::from_str(RUN_000023_FILLS).unwrap();
    let no_reason: Vec<Value> = raw
        .iter()
        .map(|f| {
            let mut o = f.as_object().unwrap().clone();
            o.remove("reason");
            Value::Object(o)
        })
        .collect();
    let fills = fills_from_json(&no_reason);
    assert!(fills.iter().all(|f| f.reason.is_none()), "本用例须真的没有 reason");
    let bars = exposure_from_per_bar(&bars_with_prefix(426, &[
        (426, 0.0, 0.002_508, Some(0.0)),
        (427, 0.0, 0.006_000, Some(0.0)),
    ]));
    let r = exposure_audit(&bars, &[], &fills, fee_run(), CAPITAL, Some(&policy));
    assert_eq!(wcodes(&r), vec![RESIDUAL], "{:?}", r.warnings);
    let msg = wmsg(&r, RESIDUAL);
    assert!(msg.contains("口径：进入末根 bar 时持仓"), "降级口径须显式标注：{msg}");
    assert!(
        !msg.contains("口径：收尾强平成交量"),
        "不得把主口径当**已采用的**口径标注（标签必须随口径改变）：{msg}"
    );
    assert!(msg.contains("主口径"), "须说明降级原因（主口径不可得）：{msg}");
    // 降级口径 = Σ signed qty over `bar_index < 427` = 28.422648758307673（与真实残仓逐位相等）。
    assert!(msg.contains("28.422649"), "须含降级口径股数：{msg}");
}

/// E22 ④：`fills` 完全不可得 ⇒ 比例条件仍触发（**不得**因缺事实而静默不披露），
/// 但股数必须明写「不可得」（**不得**填 0 冒充）。
#[test]
fn e22_no_fills_discloses_ratio_and_says_qty_unavailable() {
    let policy = exposure_policy();
    let bars = exposure_from_per_bar(&bars_with_prefix(426, &[
        (426, 0.0, 0.002_508, Some(0.0)),
        (427, 0.0, 0.006_000, Some(0.0)),
    ]));
    let r = exposure_audit(&bars, &[], &[], fee_run(), CAPITAL, Some(&policy));
    assert_eq!(wcodes(&r), vec![RESIDUAL], "不得静默不披露：{:?}", r.warnings);
    let msg = wmsg(&r, RESIDUAL);
    assert!(msg.contains("残仓股数不可得"), "须明写不可得：{msg}");
    assert!(!msg.contains("残仓股数 0"), "不得填 0 冒充：{msg}");
    assert!(msg.contains("bar 427") && msg.contains("0.0060"), "比例与定位仍须披露：{msg}");
}

/// E22 ⑤：清仓意图**已达成**（末根 `current_pct ≤ 0.005`）⇒ 不触发（防「末根有意图就报」）。
#[test]
fn e22_no_warning_when_intent_is_met_at_last_bar() {
    let policy = exposure_policy();
    let bars = exposure_from_per_bar(&bars_with_prefix(426, &[
        (426, 0.0, 0.002_508, Some(0.0)),
        (427, 0.0, 0.0, Some(0.0)),
    ]));
    let r = exposure_audit(&bars, &[], &fills_of(RUN_000023_FILLS), fee_run(), CAPITAL, Some(&policy));
    assert_eq!(wcodes(&r), Vec::<String>::new());
}

// ════════════════════════════════════════════════════════════════════════════
// E23：成本感知（`cost_amplification` / `EXPOSURE_COST_DRAG`）
// ════════════════════════════════════════════════════════════════════════════

const COST_DRAG: &str = "EXPOSURE_COST_DRAG";
const CHURN: &str = "EXPOSURE_CHURN";
const UNMET: &str = "EXPOSURE_UNMET_INTENT";
const INTENT_GAP: &str = "EXPOSURE_INTENT_GAP";

/// E23 ①（**真实读数**）：000007 的 59 笔成交（fixture 逐字节）⇒
/// `cost_amplification = 12.7725 ≥ 10` **且** `fee_pct = 0.0029788 ≥ 0.0005` ⇒ `EXPOSURE_COST_DRAG` 必触发；
/// **同一构造**下既有 `EXPOSURE_CHURN` **不**触发（`orders_per_bar 0.0319 < 0.5`、`fee_pct < 0.5%`）
/// —— 这正是「新码有鉴别力」的证据。
///
/// 口径（`06-plan` §3.1 写死 = all_fills）：`(Σcommission_all / Σtrade_value_all) / nominal_fee_rate`。
/// **并列披露**（Architecture Lead 要求）：仅 `reason=Policy` 的 58 笔（剔除末笔 `ForceClose` 的
/// 31521.86 元大额卖单）⇒ `18.7806`；契约值只认 `all_fills`（= 12.7725）。
#[test]
fn e23_real_000007_readings_trigger_cost_drag_but_not_churn() {
    let policy = exposure_policy();
    let fills = fills_of(RUN_000007_FILLS);
    assert_eq!(fills.len(), 59, "000007 真实成交笔数（活库 fills 块）");
    // 计数型输入按**真实计数**构造（活库 per_bar 实测：评估段 1818 根 bar / 58 笔挂单）。
    let bars = exposure_from_per_bar(&flat_bars(1818));
    let orders = orders_n(58);
    assert_eq!(orders.len(), 58);
    let r = exposure_audit(&bars, &orders, &fills, fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);

    // 计数型读数（真实值）
    assert_eq!(j["bars"], json!(1818));
    assert_eq!(j["orders"], json!(58));
    close(j["orders_per_bar"].as_f64().unwrap(), 58.0 / 1818.0);
    // 成本读数（真实值）
    close(j["fees"].as_f64().unwrap(), 297.880_466_033_880_85);
    close(j["fee_pct"].as_f64().unwrap(), 0.002_978_804_660_338_808_5);
    close(j["nominal_fee_rate"].as_f64().unwrap(), 0.000_25);
    close(j["cost_amplification"].as_f64().unwrap(), 12.772_548_093_571_7);

    // 鉴别力：新码触发，既有 CHURN 不触发
    assert_eq!(wcodes(&r), vec![COST_DRAG], "COST_DRAG 必触发且 CHURN 必不触发：{j}");
    assert!(!wcodes(&r).contains(&CHURN.to_string()), "既有 CHURN 门限未达 ⇒ 不得触发：{j}");
    let msg = wmsg(&r, COST_DRAG);
    assert!(msg.contains("12.77"), "须含放大倍数：{msg}");
    assert!(msg.contains("0.003193") || msg.contains("0.3193%"), "须含实际费率：{msg}");
    assert!(msg.contains("0.000250") || msg.contains("0.025"), "须含名义费率：{msg}");
    assert!(msg.contains("deadzone_min_notional"), "未设置时须给配置建议：{msg}");
    assert!(msg.contains("100.00"), "建议值 = 20 × min_fee = 100.00 元：{msg}");
    // CHURN 门限复核（防「新码靠放宽旧码」成立）
    assert!(j["orders_per_bar"].as_f64().unwrap() < 0.5, "每 bar 下单比远低于 CHURN 门限");
    assert!(j["fee_pct"].as_f64().unwrap() < 0.005, "费用占净值比低于 CHURN 门限");

    // 并列披露：仅 Policy 成交口径 ⇒ 18.7806（差异来源 = 末笔 ForceClose 大额卖单）
    let policy_only: Vec<AuditFill> =
        fills.iter().copied().filter(|f| f.reason == Some(OrderReason::Policy)).collect();
    assert_eq!(policy_only.len(), 58);
    let r2 =
        exposure_audit(&bars, &orders, &policy_only, fee_run(), CAPITAL, Some(&policy));
    let j2 = json_of(&r2);
    close(j2["cost_amplification"].as_f64().unwrap(), 18.780_603_330_882_55);
    close(j2["fees"].as_f64().unwrap(), 290.0);
    assert_eq!(wcodes(&r2), vec![COST_DRAG], "两种口径都触发（结论稳健）：{j2}");
}

/// E23 ②（**不造数**）：无成交额（无 fills）⇒ `nominal_fee_rate` 与 `cost_amplification` 一律 `null`；
/// 名义费率 0（不可归一）⇒ `cost_amplification` 亦为 `null`（不得造 ∞/NaN）。
#[test]
fn e23_cost_metrics_are_null_without_trade_value() {
    let policy = exposure_policy();
    let bars = exposure_from_per_bar(&bars_json(&[(0, 0.05, 0.05, Some(0.05))]));
    let r = exposure_audit(&bars, &[], &[], fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);
    assert_eq!(j["nominal_fee_rate"], json!(null), "无成交额 ⇒ null（不得造名义费率）：{j}");
    assert_eq!(j["cost_amplification"], json!(null), "无成交额 ⇒ null（不得造放大倍数）：{j}");

    let zero_fee =
        FeeModel { commission_rate_pct: 0.0, min_commission: 5.0, stamp_duty_pct: 0.0, slippage_bp: 2.0 };
    let fills = fills_of(RUN_000007_FILLS);
    let r = exposure_audit(&bars, &[], &fills, zero_fee, CAPITAL, Some(&policy));
    let j = json_of(&r);
    assert_eq!(j["nominal_fee_rate"], json!(0.0), "名义费率 0 是事实（照实披露）");
    assert_eq!(j["cost_amplification"], json!(null), "分母 0 ⇒ null（不得造数）：{j}");
    assert!(!wcodes(&r).contains(&COST_DRAG.to_string()), "无放大倍数 ⇒ 不得触发：{j}");
}

/// E23 ③（**意图层告警** `EXPOSURE_UNMET_INTENT`）：`max_intent_gap > 0.05` ⇒ 触发，
/// message 含 最大差 / 出现 bar / 参与配对 bar 数 / `on_signal_break` 口径提示（`Pause` 下
/// 「停在中途」属**预期**但必须披露）；既有 `EXPOSURE_INTENT_GAP` 名称/触发语义不变，
/// message 显式标注「输出目标 vs 实际」并含 `max_target_gap` 数值。
#[test]
fn e23_unmet_intent_warning_carries_pairs_and_on_signal_break_semantics() {
    let policy = exposure_policy();
    // 意图差：bar1 |0.60 − c2 0.39| = 0.21；bar2 |0.60 − c3 0.31| = 0.29（max，`Pause` 下停在中途）；
    // 目标差：bar1 |0.60 − 0.39| = 0.21（max）。
    let bars = exposure_from_per_bar(&bars_json(&[
        (0, 0.30, 0.00, Some(0.30)),
        (1, 0.60, 0.31, Some(0.60)),
        (2, 0.31, 0.39, Some(0.60)),
        (3, 0.31, 0.31, Some(0.60)),
    ]));
    let r = exposure_audit(&bars, &[], &[], fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);
    let cs = wcodes(&r);
    assert!(cs.contains(&UNMET.to_string()), "意图层差超阈必披露：{j}");
    assert!(cs.contains(&INTENT_GAP.to_string()), "既有执行层码名称不变：{j}");

    let msg = wmsg(&r, UNMET);
    assert!(msg.contains("0.2900"), "须含最大意图差：{msg}");
    assert!(msg.contains("bar 2"), "须含最大差的决策 bar：{msg}");
    assert!(msg.contains("配对"), "须含参与配对的 bar 对数：{msg}");
    assert!(msg.contains("on_signal_break"), "须含 on_signal_break 口径提示：{msg}");
    assert!(msg.contains("Pause"), "缺省 = Pause，且须点明「停在中途属预期但必须披露」：{msg}");

    let emsg = wmsg(&r, INTENT_GAP);
    assert!(emsg.contains("输出目标"), "message 须显式标注口径「输出目标 vs 实际」：{emsg}");
    assert!(emsg.contains("实际"), "{emsg}");
    assert!(emsg.contains("0.2100"), "须把 max_target_gap 写进文本：{emsg}");
}

/// E23 ④：意图**达成**（差 ≤ 0.05）⇒ `EXPOSURE_UNMET_INTENT` 不触发（防「恒触发」）。
#[test]
fn e23_unmet_intent_not_triggered_when_intent_is_met() {
    let policy = exposure_policy();
    let bars = exposure_from_per_bar(&bars_json(&[
        (0, 0.30, 0.00, Some(0.30)),
        (1, 0.30, 0.29, Some(0.30)),
        (2, 0.30, 0.30, Some(0.30)),
    ]));
    let r = exposure_audit(&bars, &[], &[], fee_run(), CAPITAL, Some(&policy));
    let j = json_of(&r);
    assert_eq!(wcodes(&r), Vec::<String>::new(), "意图达成 ⇒ 零告警：{j}");
    close(j["max_intent_gap"].as_f64().unwrap(), 0.01);
    assert_eq!(j["unmet_intent_bars"], json!(0));
}

/// E23 ⑤（门禁 R8）：非 `Exposure`（`LumpSum`）⇒ 意图/成本类告警**一律不发声**
/// （指标照算；旧变体的欠配由既有告警负责，禁互相解释）。
#[test]
fn e23_new_codes_are_gated_to_exposure_policy() {
    let fills = fills_of(RUN_000007_FILLS);
    let bars = exposure_from_per_bar(&bars_json(&[
        (0, 0.30, 0.00, Some(0.30)),
        (1, 0.60, 0.31, Some(0.60)),
        (2, 0.31, 0.39, Some(0.60)),
        (3, 0.31, 0.31, Some(0.60)),
    ]));
    let r = exposure_audit(&bars, &[], &fills, fee_run(), CAPITAL, Some(&lump_policy()));
    let j = json_of(&r);
    assert_eq!(wcodes(&r), Vec::<String>::new(), "旧变体不得新增发声：{j}");
    close(j["cost_amplification"].as_f64().unwrap(), 12.772_548_093_571_7);
    close(j["max_intent_gap"].as_f64().unwrap(), 0.29);
    // 无 policy（config 缺失/解析失败）同样不发声
    let r = exposure_audit(&bars, &[], &fills, fee_run(), CAPITAL, None);
    assert_eq!(wcodes(&r), Vec::<String>::new());
}
