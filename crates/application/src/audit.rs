//! ADR-026：回测结果的**执行完整度审计**（Execution Audit）——**纯函数**派生计算，无 IO。
//!
//! 契约：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md` §2.1/§2.2。
//!
//! 分层：application 层（Domain/Application），**无 IO、无 DB、无 web 依赖** ⇒ 表驱动单测；
//! 读侧接线（per_bar / fills / trades 的读取）在 `workbench::WorkbenchService`，HTTP/MCP 各自
//! 只做参数与错误码映射。
//!
//! 口径（ADR-026 §2.1，唯一口径，**不得**在别处重算）：
//! - `reachable_batches` = in-range（`warmup=false`）`orders[side=Buy]` 意图数；
//! - `batches_done`      = `side=Buy` 成交笔数；
//! - `unexecuted_orders` = `intents − buy_fills`（**saturating**，≥ 0）；
//! - `deployed_notional` = `Σ buy_fill.qty × buy_fill.price`（**敞口**口径，不含费用）；
//! - `cash_consumed`     = 名义投入 + `Σ buy 佣金`（佣金**复用仓内 fee 模型** `backtest::FeeModel`
//!   = `max(额×费率, 最低佣金)`，禁止另写一套）；
//! - `round_trips_total` = `strategy_run_result.trades` 长度；
//! - `round_trips_force_closed` = 存在 `reason='ForceClose'` 的 Sell 成交且其成交 bar == `trade.close_bar`；
//! - `planned_tranches`  = run config `policy` 仅 `Dca` 有值，其余 `null`。
//!
//! **口径消歧（ADR-026 §2.1 固化）**：`deployed_*`（敞口，不含费用）与 `cash_consumed*`（含佣金）
//! 是**两个不同的量**，必须分别命名、分别披露。
//!
//! **`recorded`**：事实源是否齐全（`per_bar` 可得，或 `fills` 块可得）。`recorded=false` 时
//! 一切派生量都无从谈起 ⇒ 审计**只报零值与空 warnings**，不给「0% 投入」这类伪事实（诚实留白）。

use backtest::FeeModel;
use serde::Serialize;
use strategy_core::{ExecutionPolicy, OrderReason, OrderSide};

// ---------------------------------------------------------------------------
// 判据常量（ADR-026 §2.2：阈值/警告码集中为具名常量，禁魔法值）
// ---------------------------------------------------------------------------

/// `PARTIAL_DEPLOYMENT` 判据阈值：**敞口**占比低于该值即告警（ADR-026 §2.2，冻结 0.99）。
pub const PARTIAL_DEPLOYMENT_THRESHOLD: f64 = 0.99;

/// 警告码：未满仓（`deployed_pct < PARTIAL_DEPLOYMENT_THRESHOLD`）。
pub const WARN_PARTIAL_DEPLOYMENT: &str = "PARTIAL_DEPLOYMENT";
/// 警告码：DCA 计划未推进完（`planned_tranches` 非空且 `batches_done < planned_tranches`）。
pub const WARN_DCA_PLAN_UNDERFILLED: &str = "DCA_PLAN_UNDERFILLED";
/// 警告码：存在未执行挂单（`unexecuted_orders > 0`）。
pub const WARN_ORDERS_UNEXECUTED: &str = "ORDERS_UNEXECUTED";

/// 逐回合对账容差（ADR-027 D10 / 02-spec §2 I1-I2；**显式**常量，禁魔法值）。
///
/// 判据：`|Σ_L2 − L1| ≤ tolerance × max(1, |L1|)`（相对容差 + 绝对下界，浮点累加）。
pub const RT_RECONCILE_TOLERANCE: f64 = 1e-6;

/// 严重度：需注意（改变读者结论的风险披露）。
pub const SEVERITY_WARN: &str = "warn";
/// 严重度：信息性（事实陈述，非风险）。
pub const SEVERITY_INFO: &str = "info";

// ---------------------------------------------------------------------------
// 输入事实（由读侧从已落库事实投影而来；纯函数只认这些）
// ---------------------------------------------------------------------------

/// 订单意图（in-range；投影自 `per_bar[i].orders[]`）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AuditOrder {
    /// 决策 bar 序号（= `per_bar` 数组下标）。
    pub bar_index: usize,
    pub side: OrderSide,
    pub qty: f64,
}

/// 成交（投影自 `fills` 块或 `per_bar[i].events[]` 的 `fill` 事件；两源同事实）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AuditFill {
    /// **执行** bar 序号（= 决策 bar + 1；Intrabar 止损例外）。
    pub bar_index: usize,
    pub side: OrderSide,
    pub qty: f64,
    /// 成交价（含滑点）。
    pub price: f64,
    pub reason: Option<OrderReason>,
}

/// 回合（投影自 `strategy_run_result.trades`；审计只用 `close_bar`）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AuditTrade {
    pub close_bar: usize,
}

/// 审计输入（全部为已落库事实的投影 + 费用/资金契约）。
#[derive(Debug, Clone)]
pub struct AuditInput<'a> {
    /// 事实源是否齐全（读侧判定；false ⇒ 只报零值 + 空 warnings）。
    pub recorded: bool,
    pub orders: &'a [AuditOrder],
    pub fills: &'a [AuditFill],
    pub trades: &'a [AuditTrade],
    /// 末根 in-range bar 的序号（`None` = 无 in-range bar）。
    pub last_bar_index: Option<usize>,
    /// run config 钉住的**生效** fee 契约（佣金/最低/印花税/滑点）。
    pub fee: FeeModel,
    /// 绩效分母口径（= run config `initial_capital`）。
    pub initial_capital: f64,
    /// run config `policy`（仅用于 `planned_tranches`）。
    pub policy: Option<&'a ExecutionPolicy>,
}

// ---------------------------------------------------------------------------
// 输出（ADR-026 §2.2 全部字段）
// ---------------------------------------------------------------------------

/// 一条审计警告（非阻断；仅信息性披露）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuditWarning {
    pub code: &'static str,
    pub severity: &'static str,
    pub message: String,
}

/// 执行完整度审计报告（`run_id` 由读侧包裹，纯函数不产出）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuditReport {
    /// 事实源齐全（`per_bar.orders/events` 或 `fills` 可得）。
    pub recorded: bool,
    /// 绩效分母口径（= run config `initial_capital`）。
    pub capital_basis: f64,
    /// **敞口**：`Σ buy_fill.qty × buy_fill.price`（不含费用）。
    pub deployed_notional: f64,
    /// `deployed_notional / capital_basis`。
    pub deployed_pct: f64,
    /// **资金占用**：名义投入 + `Σ buy 佣金`。
    pub cash_consumed: f64,
    /// `cash_consumed / capital_basis`。
    pub cash_consumed_pct: f64,
    /// DCA 计划批次数（非 Dca → `null`）。
    pub planned_tranches: Option<usize>,
    /// in-range Buy 意图数（区间内**最多可推进**的批数）。
    pub reachable_batches: usize,
    /// 实际买入成交笔数。
    pub batches_done: usize,
    /// 未执行挂单数（`intents − buy_fills`，≥ 0）。
    pub unexecuted_orders: usize,
    /// 末根 in-range bar 存在 Buy 意图（其决策无次 bar 可成交）。
    pub last_bar_unfilled: bool,
    /// 回合数（= `trades` 长度；**完全平仓**口径）。
    pub round_trips_total: usize,
    /// 由期末强平合成的回合数。
    pub round_trips_force_closed: usize,
    /// **已终结**回合数（`status='Closed'`；ADR-027 §5.5）。
    ///
    /// 注：本字段与 `rt_reconcile` 由 [`compute_audit`] 之外的读径（`run_audit`）在
    /// `recorded` 门禁后合并——它们需要 `trades`/`fills` 的**逐回合明细**，而 `compute_audit`
    /// 只认已投影的扁平事实（KISS）。
    pub round_trips_closed: usize,
    /// **未终结**回合数（`status='Open'`；回测恒 0）。
    pub round_trips_open: usize,
    /// 逐回合自洽对账（I1/I2；ADR-027 D10 强告警源）。
    pub rt_reconcile: RtReconcile,
    /// 非阻断警告（顺序：DCA 未推进完 → 未满仓 → 挂单未成交）。
    pub warnings: Vec<AuditWarning>,
}

/// 逐回合对账结果（02-spec §5.5 / ADR-027 D10/I1-I2）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RtReconcile {
    /// 已核对回合数（有 `rt_seq` 且 L2 事实可归属）。
    pub checked: usize,
    /// 不一致的 `rt_seq` 列表（**非空 ⇒ UI 必须显式告警**，ADR-027 D10：禁静默按 L1 渲染）。
    pub mismatched: Vec<u32>,
    /// 对账容差（= [`RT_RECONCILE_TOLERANCE`]，显式披露）。
    pub tolerance: f64,
}

/// 回合计数 + 对账（`AuditReport` 两块增量的纯函数产物；读侧在 `recorded` 门禁后合并）。
#[derive(Debug, Clone, PartialEq)]
pub struct RtAudit {
    pub closed: usize,
    pub open: usize,
    pub reconcile: RtReconcile,
}

/// 逐回合对账（I1/I2）：把 L2 逐笔事实按 `rt_seq` 分组求和，与 L1 同名字段比对。
///
/// - `gross_value` ← Σ_`side==Sell` `trade_value`；`commission` ← Σ 全笔 commission；
///   `stamp_duty` ← Σ 全笔 stamp_duty（与 [`crate::audit`] / `aggregate_round_trips` 同口径）；
/// - **事实缺失不冒充一致**（ADR-027 D11）：`fills_recorded=false` 或成交无 `rt_seq` ⇒ `checked=0`
///   且 `mismatched` 为空（无可核项，诚实留白）；
/// - `Closed`/`Open` 由 `status` 字段判定；**缺该字段 ⇒ 计 `Closed`**（回测恒 Closed；旧 JSON 无该列）。
pub fn reconcile_round_trips(
    trades: &serde_json::Value,
    fills: &[serde_json::Value],
    fills_recorded: bool,
) -> RtAudit {
    let l1 = trades.as_array().cloned().unwrap_or_default();
    let mut closed = 0usize;
    let mut open = 0usize;
    for t in &l1 {
        if t.get("status").and_then(serde_json::Value::as_str) == Some("Open") {
            open += 1;
        } else {
            closed += 1;
        }
    }
    // L2 聚合（仅带 `rt_seq` 的事实可归属）
    let mut sums: std::collections::HashMap<u32, (f64, f64, f64)> =
        std::collections::HashMap::new();
    let mut has_rt = false;
    for f in fills {
        let Some(rt) = f
            .get("rt_seq")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v as u32)
        else {
            continue;
        };
        has_rt = true;
        let side = f.get("side").and_then(serde_json::Value::as_str).unwrap_or("");
        let e = sums.entry(rt).or_insert((0.0, 0.0, 0.0));
        e.1 += f.get("commission").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        e.2 += f.get("stamp_duty").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        if side == "Sell" {
            e.0 += f.get("trade_value").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
        }
    }
    let mut checked = 0usize;
    let mut mismatched: Vec<u32> = Vec::new();
    if fills_recorded && has_rt {
        for t in &l1 {
            let (Some(rt), Some(l1_gross)) = (
                t.get("rt_seq").and_then(serde_json::Value::as_u64).map(|v| v as u32),
                t.get("gross_value").and_then(serde_json::Value::as_f64),
            ) else {
                continue;
            };
            checked += 1;
            let s = sums.get(&rt).copied().unwrap_or((0.0, 0.0, 0.0));
            let l1_comm = t.get("commission").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
            let l1_stamp =
                t.get("stamp_duty").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
            if !rt_close_enough(s.0, l1_gross)
                || !rt_close_enough(s.1, l1_comm)
                || !rt_close_enough(s.2, l1_stamp)
            {
                mismatched.push(rt);
            }
        }
    }
    RtAudit {
        closed,
        open,
        reconcile: RtReconcile {
            checked,
            mismatched,
            tolerance: RT_RECONCILE_TOLERANCE,
        },
    }
}

/// 对账判据：`|a − b| ≤ tolerance × max(1, |b|)`（`b` = L1 字段值）。
fn rt_close_enough(a: f64, b: f64) -> bool {
    (a - b).abs() <= RT_RECONCILE_TOLERANCE * b.abs().max(1.0)
}

// ---------------------------------------------------------------------------
// 投影（JSON 事实 → 纯函数入参）
// ---------------------------------------------------------------------------

/// `per_bar` 数组（chunked 分块拼接 或 legacy 内联，**同一 JSON 形态**）→ 订单意图 + 末根 in-range bar 序号。
///
/// - `warmup` 字段**缺失**视为 in-range（legacy_single 记录早于 I-2/D6，无该字段）；
/// - warmup 段的 orders 不计数（引擎在 warmup 段不执行 Policy，防御性再排一层）。
pub fn orders_from_per_bar(bars: &[serde_json::Value]) -> (Vec<AuditOrder>, Option<usize>) {
    let mut orders = Vec::new();
    let mut last_in_range: Option<usize> = None;
    for (i, bar) in bars.iter().enumerate() {
        // `warmup` 缺失 = in-range（legacy_single 记录无该字段；ADR-024 P4 之前的 run）。
        let warmup = bar.get("warmup").and_then(serde_json::Value::as_bool).unwrap_or(false);
        if warmup {
            continue;
        }
        last_in_range = Some(i);
        let Some(list) = bar.get("orders").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for o in list {
            // `side` 未知/缺失 ⇒ 跳过（引擎恒写；防御面不产生幽灵意图）。
            let Some(side) = o.get("side").and_then(serde_json::Value::as_str).and_then(parse_side)
            else {
                continue;
            };
            orders.push(AuditOrder {
                bar_index: i,
                side,
                qty: o.get("qty").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
            });
        }
    }
    (orders, last_in_range)
}

/// 成交数组（`fills` 块 或 `legacy_fills` 派生形态）→ 纯函数入参。
pub fn fills_from_json(fills: &[serde_json::Value]) -> Vec<AuditFill> {
    let mut out = Vec::with_capacity(fills.len());
    for f in fills {
        let Some(side) = f.get("side").and_then(serde_json::Value::as_str).and_then(parse_side)
        else {
            continue;
        };
        out.push(AuditFill {
            bar_index: f
                .get("bar_index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as usize,
            side,
            qty: f.get("qty").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
            price: f.get("price").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
            reason: f
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .and_then(OrderReason::parse),
        });
    }
    out
}

/// `strategy_run_result.trades`（JSON 数组）→ 纯函数入参（只取 `close_bar`）。
pub fn trades_from_json(trades: &serde_json::Value) -> Vec<AuditTrade> {
    trades
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    t.get("close_bar")
                        .and_then(serde_json::Value::as_u64)
                        .map(|b| AuditTrade { close_bar: b as usize })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 订单/成交侧标签（`"Buy" | "Sell"`；其它 → `None`）。
fn parse_side(s: &str) -> Option<OrderSide> {
    match s {
        "Buy" => Some(OrderSide::Buy),
        "Sell" => Some(OrderSide::Sell),
        _ => None,
    }
}

/// 执行完整度审计（纯函数，无 IO）。
///
/// `recorded=false`（事实源不齐）⇒ 派生量全为零值 + 空 `warnings`（不给伪事实，见模块头注）。
pub fn compute_audit(input: &AuditInput<'_>) -> AuditReport {
    let capital_basis = input.initial_capital;
    let planned_tranches = match input.policy {
        Some(ExecutionPolicy::Dca { tranches, .. }) => Some(*tranches),
        _ => None,
    };

    // 事实源不齐：只回零值 + 空 warnings（诚实留白，不制造「0% 投入」伪事实）。
    if !input.recorded {
        return AuditReport {
            recorded: false,
            capital_basis,
            deployed_notional: 0.0,
            deployed_pct: 0.0,
            cash_consumed: 0.0,
            cash_consumed_pct: 0.0,
            planned_tranches,
            reachable_batches: 0,
            batches_done: 0,
            unexecuted_orders: 0,
            last_bar_unfilled: false,
            round_trips_total: 0,
            round_trips_force_closed: 0,
            round_trips_closed: 0,
            round_trips_open: 0,
            rt_reconcile: RtReconcile {
                checked: 0,
                mismatched: Vec::new(),
                tolerance: RT_RECONCILE_TOLERANCE,
            },
            warnings: Vec::new(),
        };
    }

    let buy_intents = input.orders.iter().filter(|o| o.side == OrderSide::Buy).count();
    let buy_fills: Vec<&AuditFill> = input.fills.iter().filter(|f| f.side == OrderSide::Buy).collect();
    let batches_done = buy_fills.len();
    let unexecuted_orders = buy_intents.saturating_sub(batches_done);

    // 敞口（不含费用）：Σ qty × price。
    let deployed_notional: f64 = buy_fills.iter().map(|f| f.qty * f.price).sum();
    // 资金占用（含佣金）：佣金逐笔按 run config 的生效 fee 契约复算（`FeeModel::commission`
    // = max(额×费率, 最低佣金)；引擎建仓侧同一公式，禁止另写一套）。
    let buy_commission: f64 = buy_fills
        .iter()
        .map(|f| input.fee.commission(f.qty * f.price))
        .sum();
    let cash_consumed = deployed_notional + buy_commission;

    let last_bar_unfilled = input.last_bar_index.is_some_and(|last| {
        input
            .orders
            .iter()
            .any(|o| o.bar_index == last && o.side == OrderSide::Buy)
    });

    let round_trips_total = input.trades.len();
    // 强平合成回合：ForceClose 卖出成交的**执行 bar** 与该回合 `close_bar` 一致（ADR-026 §2.1，
    // 读侧派生 ⇒ 历史 run 同样可判——`TradeDetail.reason` 对历史 run 恒 null）。
    let round_trips_force_closed = input
        .trades
        .iter()
        .filter(|t| {
            input.fills.iter().any(|f| {
                f.side == OrderSide::Sell
                    && f.reason == Some(OrderReason::ForceClose)
                    && f.bar_index == t.close_bar
            })
        })
        .count();

    let deployed_pct = ratio(deployed_notional, capital_basis);
    let cash_consumed_pct = ratio(cash_consumed, capital_basis);

    let mut warnings = Vec::new();
    if let Some(planned) = planned_tranches {
        if batches_done < planned {
            warnings.push(AuditWarning {
                code: WARN_DCA_PLAN_UNDERFILLED,
                severity: SEVERITY_WARN,
                message: format!(
                    "计划 {planned} 批，区间内最多可推进 {buy_intents} 批、已成交 {batches_done} 批（剩余批次随买入区结束取消）"
                ),
            });
        }
    }
    if deployed_pct < PARTIAL_DEPLOYMENT_THRESHOLD {
        warnings.push(AuditWarning {
            code: WARN_PARTIAL_DEPLOYMENT,
            severity: SEVERITY_WARN,
            message: format!(
                "名义投入 {:.2}% 初始资金，年化/回撤/夏普分母仍为初始资金",
                deployed_pct * 100.0
            ),
        });
    }
    if unexecuted_orders > 0 {
        warnings.push(AuditWarning {
            code: WARN_ORDERS_UNEXECUTED,
            severity: SEVERITY_INFO,
            message: format!("{} 笔挂单未成交（末根 bar 无次 bar 可执行）", unexecuted_orders),
        });
    }

    AuditReport {
        recorded: true,
        capital_basis,
        deployed_notional,
        deployed_pct,
        cash_consumed,
        cash_consumed_pct,
        planned_tranches,
        reachable_batches: buy_intents,
        batches_done,
        unexecuted_orders,
        last_bar_unfilled,
        round_trips_total,
        round_trips_force_closed,
        // `round_trips_closed/open` 与 `rt_reconcile` 需逐回合明细 ⇒ 由读径
        // （`WorkbenchService::run_audit` 调 `reconcile_round_trips`）在 `recorded` 门禁后合并；
        // 本纯函数只产出零值占位（不伪造事实，ADR-027 D11）。
        round_trips_closed: 0,
        round_trips_open: 0,
        rt_reconcile: RtReconcile {
            checked: 0,
            mismatched: Vec::new(),
            tolerance: RT_RECONCILE_TOLERANCE,
        },
        warnings,
    }
}

/// 占比（分母为 0 → 0.0；不产生 NaN/inf）。
fn ratio(part: f64, total: f64) -> f64 {
    if total > 0.0 {
        part / total
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use strategy_core::DcaMode;

    // ── 夹具 ──

    fn fee(rate_pct: f64, min_fee: f64) -> FeeModel {
        FeeModel { commission_rate_pct: rate_pct, min_commission: min_fee, stamp_duty_pct: 0.0, slippage_bp: 2.0 }
    }

    fn dca(tranches: usize) -> ExecutionPolicy {
        ExecutionPolicy::Dca { tranches, mode: DcaMode::Equal, amount: None, interval: 1 }
    }

    fn lump(pct: f64) -> ExecutionPolicy {
        ExecutionPolicy::LumpSum { position_pct: pct }
    }

    fn buy(bar_index: usize) -> AuditOrder {
        AuditOrder { bar_index, side: OrderSide::Buy, qty: 1.0 }
    }

    fn buy_fill(bar_index: usize, qty: f64, price: f64) -> AuditFill {
        AuditFill { bar_index, side: OrderSide::Buy, qty, price, reason: Some(OrderReason::Policy) }
    }

    fn sell_fill(bar_index: usize, reason: OrderReason) -> AuditFill {
        AuditFill { bar_index, side: OrderSide::Sell, qty: 10.0, price: 8.0, reason: Some(reason) }
    }

    fn codes(r: &AuditReport) -> Vec<&'static str> {
        r.warnings.iter().map(|w| w.code).collect()
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    // ── A1-①：目标 run 形态（43 意图 / 42 成交 / 1 未执行 / 1 强平回合） ──

    /// 目标 run `sr_1789738328788_000005` 的形态复现（数值取实测基准，容差 1e-6）：
    /// Dca{tranches:100,interval:1}、100000 本金、fee{0.025,5,2,0}；
    /// 43 个 Buy 意图（含末根 bar 422）、42 笔成交（名义 41397.972081）、1 笔 ForceClose 平仓。
    #[test]
    fn target_run_shape_dca_underfilled() {
        let notional_per_fill = 41397.97208076086_f64 / 42.0;
        let orders: Vec<AuditOrder> = (0..42).map(buy).chain(std::iter::once(buy(422))).collect();
        let fills: Vec<AuditFill> = (0..42)
            .map(|i| buy_fill(i + 1, 1.0, notional_per_fill))
            .chain(std::iter::once(sell_fill(422, OrderReason::ForceClose)))
            .collect();
        let trades = vec![AuditTrade { close_bar: 422 }];
        let policy = dca(100);
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &orders,
            fills: &fills,
            trades: &trades,
            last_bar_index: Some(422),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: Some(&policy),
        });

        assert!(r.recorded);
        close(r.capital_basis, 100_000.0);
        assert_eq!(r.reachable_batches, 43, "43 个 Buy 意图");
        assert_eq!(r.batches_done, 42, "42 笔 Buy 成交");
        assert_eq!(r.unexecuted_orders, 1, "末根 bar 的意图无次 bar 可成交");
        assert!(r.last_bar_unfilled);
        close(r.deployed_notional, 41_397.97208076086);
        close(r.deployed_pct, 0.41397972);
        close(r.cash_consumed, 41_607.97208076086);
        close(r.cash_consumed_pct, 0.41607972);
        assert_eq!(r.planned_tranches, Some(100));
        assert_eq!(r.round_trips_total, 1);
        assert_eq!(r.round_trips_force_closed, 1);
        assert_eq!(
            codes(&r),
            vec![WARN_DCA_PLAN_UNDERFILLED, WARN_PARTIAL_DEPLOYMENT, WARN_ORDERS_UNEXECUTED],
            "三条 warning，顺序 = ADR-026 §2.2"
        );
        let sev: Vec<&str> = r.warnings.iter().map(|w| w.severity).collect();
        assert_eq!(sev, vec![SEVERITY_WARN, SEVERITY_WARN, SEVERITY_INFO]);
        assert!(
            r.warnings[0].message.contains("计划 100 批")
                && r.warnings[0].message.contains("43")
                && r.warnings[0].message.contains("42"),
            "DCA 警告须含计划/可达/已成交三数：{}",
            r.warnings[0].message
        );
        assert!(
            r.warnings[1].message.contains("41.40%"),
            "未满仓警告须含投入率：{}",
            r.warnings[1].message
        );
        assert!(
            r.warnings[2].message.contains("1 笔挂单"),
            "挂单警告须含笔数：{}",
            r.warnings[2].message
        );
    }

    // ── A1-②：满仓（LumpSum{1}）—— 无 PARTIAL_DEPLOYMENT ──

    /// 对照 run `sr_1789738272901_000004`（同区间 LumpSum{1}）：
    /// 1 意图 / 1 成交 / 名义 99975.006248 ≈ 99.98% ⇒ 满仓、无 warning、`planned_tranches=null`。
    #[test]
    fn full_deployment_lumpsum_has_no_warnings() {
        let orders = vec![buy(0)];
        let fills = vec![buy_fill(1, 1.0, 99_975.00624843787), sell_fill(422, OrderReason::ForceClose)];
        let trades = vec![AuditTrade { close_bar: 422 }];
        let policy = lump(1.0);
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &orders,
            fills: &fills,
            trades: &trades,
            last_bar_index: Some(422),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: Some(&policy),
        });
        close(r.deployed_pct, 0.9997500624843787);
        assert!(r.deployed_pct >= PARTIAL_DEPLOYMENT_THRESHOLD, "满仓不触发未满仓告警");
        assert_eq!(r.planned_tranches, None, "非 Dca ⇒ planned_tranches=null");
        assert_eq!(r.reachable_batches, 1);
        assert_eq!(r.batches_done, 1);
        assert_eq!(r.unexecuted_orders, 0);
        assert!(!r.last_bar_unfilled);
        close(r.deployed_notional, 99_975.00624843787);
        // 满仓成交的「资金占用」= 预算本身（佣金折入成交额，`FeeModel::buy` 冻结口径）。
        close(r.cash_consumed, 100_000.0);
        assert!(codes(&r).is_empty(), "满仓 + 无挂单 ⇒ 无 warning：{:?}", codes(&r));
    }

    // ── A1-③：零成交（意图全未执行 + 零投入） ──

    #[test]
    fn zero_fills_reports_partial_deployment_and_unexecuted() {
        let orders: Vec<AuditOrder> = (0..3).map(buy).chain(std::iter::once(buy(9))).collect();
        let fills: Vec<AuditFill> = Vec::new();
        let policy = lump(1.0);
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &orders,
            fills: &fills,
            trades: &[],
            last_bar_index: Some(9),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: Some(&policy),
        });
        assert_eq!(r.reachable_batches, 4);
        assert_eq!(r.batches_done, 0);
        assert_eq!(r.unexecuted_orders, 4);
        assert!(r.last_bar_unfilled);
        close(r.deployed_notional, 0.0);
        close(r.cash_consumed, 0.0);
        close(r.deployed_pct, 0.0);
        assert_eq!(
            codes(&r),
            vec![WARN_PARTIAL_DEPLOYMENT, WARN_ORDERS_UNEXECUTED],
            "零成交：仅未满仓 + 挂单未成交（非 Dca ⇒ 无 DCA 警告）"
        );
    }

    // ── A1-④：legacy_single 双向 run（40 Buy 意图 / 40 Buy 成交 / 40 回合 / 无强平） ──

    /// `sr_1789044295239_000111` 形态：40 Buy + 40 Sell 意图、双边各 40 笔成交、40 个回合、无 ForceClose。
    /// 三方自洽：`batches_done == buy fills 数`、`round_trips_total == trades 长度`、
    /// `round_trips_force_closed == ForceClose 事件数`。
    #[test]
    fn legacy_two_way_run_is_self_consistent() {
        let notional = 5_167_755.165733984_f64;
        let orders: Vec<AuditOrder> = (0..40)
            .map(buy)
            .chain((0..40).map(|i| AuditOrder { bar_index: i, side: OrderSide::Sell, qty: 1.0 }))
            .collect();
        let mut fills: Vec<AuditFill> = (0..40)
            .map(|i| buy_fill(i + 1, 1.0, notional / 40.0))
            .collect();
        fills.extend((0..40).map(|i| sell_fill(i + 2, OrderReason::Policy)));
        let trades: Vec<AuditTrade> =
            [47, 80, 93, 122, 155, 170, 179, 229, 235, 245, 297, 338, 406, 431, 457, 497, 522, 571,
             590, 633, 653, 673, 694, 701, 724, 762, 792, 836, 883, 895, 913, 938, 950, 998, 1067,
             1087, 1116, 1166, 1179, 1205]
                .iter()
                .map(|&b| AuditTrade { close_bar: b })
                .collect();
        let policy = lump(1.0);
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &orders,
            fills: &fills,
            trades: &trades,
            last_bar_index: Some(1208),
            // `sr_1789044295239_000111` 的生效 fee：ETF 口径 rate 0.005% / min_fee 0。
            fee: fee(0.005, 0.0),
            initial_capital: 100_000.0,
            policy: Some(&policy),
        });
        assert_eq!(r.batches_done, 40, "batches_done == Buy 成交笔数");
        assert_eq!(r.reachable_batches, 40, "Sell 意图不计入 reachable_batches");
        assert_eq!(r.unexecuted_orders, 0);
        assert!(!r.last_bar_unfilled, "末根 bar 无挂单");
        assert_eq!(r.round_trips_total, 40, "round_trips_total == trades 长度");
        assert_eq!(r.round_trips_force_closed, 0, "无 ForceClose 事件 ⇒ 0");
        close(r.deployed_notional, notional);
        close(r.cash_consumed, notional + 258.3877582866992);
        assert!(codes(&r).is_empty(), "双边 run 无 warning：{:?}", codes(&r));
    }

    // ── A1-⑤：Dca 与非 Dca 的 planned_tranches / DCA 警告 ──

    #[test]
    fn dca_plan_met_has_no_dca_warning() {
        let orders: Vec<AuditOrder> = (0..5).map(buy).collect();
        let fills: Vec<AuditFill> = (0..5).map(|i| buy_fill(i + 1, 1.0, 10_000.0)).collect();
        let policy = dca(5);
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &orders,
            fills: &fills,
            trades: &[],
            last_bar_index: Some(4),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: Some(&policy),
        });
        assert_eq!(r.planned_tranches, Some(5));
        assert_eq!(r.batches_done, 5);
        assert!(!codes(&r).contains(&WARN_DCA_PLAN_UNDERFILLED), "计划已推进完 ⇒ 无 DCA 警告");
        assert!(!codes(&r).contains(&WARN_ORDERS_UNEXECUTED));
    }

    #[test]
    fn no_policy_means_null_planned_tranches_and_no_dca_warning() {
        let orders = vec![buy(0)];
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &orders,
            fills: &[],
            trades: &[],
            last_bar_index: Some(0),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        assert_eq!(r.planned_tranches, None, "无 policy ⇒ null");
        assert!(!codes(&r).contains(&WARN_DCA_PLAN_UNDERFILLED), "无计划 ⇒ 不告警");
    }

    // ── A1-⑥：`deployed_pct` 0.99 阈值两侧（表驱动） ──

    #[test]
    fn partial_deployment_threshold_table() {
        // (敞口金额, 是否应告警) —— 阈值 0.99 严格小于；边界值本身**不**告警。
        let cases = [
            (98_999.0_f64, true),
            (98_999.999, true),
            (99_000.0, false),
            (99_001.0, false),
            (100_000.0, false),
            (0.0, true),
        ];
        for (notional, expect_warn) in cases {
            let fills = vec![buy_fill(1, 1.0, notional)];
            let orders = vec![buy(0)];
            let r = compute_audit(&AuditInput {
                recorded: true,
                orders: &orders,
                fills: &fills,
                trades: &[],
                last_bar_index: Some(1),
                fee: fee(0.025, 5.0),
                initial_capital: 100_000.0,
                policy: None,
            });
            let got = codes(&r).contains(&WARN_PARTIAL_DEPLOYMENT);
            assert_eq!(
                got, expect_warn,
                "deployed_pct={} 的 PARTIAL_DEPLOYMENT 判据（阈值 {PARTIAL_DEPLOYMENT_THRESHOLD}）",
                r.deployed_pct
            );
        }
    }

    // ── 佣金复用 fee 契约（禁止硬编码费率/最低值） ──

    #[test]
    fn commission_follows_fee_contract_min_and_rate() {
        // 最低佣金主导：10000 × 0.025% = 2.5 < 5 ⇒ 收 5。
        let min_driven = compute_audit(&AuditInput {
            recorded: true,
            orders: &[buy(0)],
            fills: &[buy_fill(1, 1.0, 10_000.0)],
            trades: &[],
            last_bar_index: Some(1),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        close(min_driven.cash_consumed, 10_005.0);

        // 费率主导：100000 × 0.025% = 25 > 5 ⇒ 收 25。
        let rate_driven = compute_audit(&AuditInput {
            recorded: true,
            orders: &[buy(0)],
            fills: &[buy_fill(1, 1.0, 100_000.0)],
            trades: &[],
            last_bar_index: Some(1),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        close(rate_driven.cash_consumed, 100_025.0);

        // 免最低佣金（ETF 口径）：10000 × 0.005% = 0.5。
        let no_min = compute_audit(&AuditInput {
            recorded: true,
            orders: &[buy(0)],
            fills: &[buy_fill(1, 1.0, 10_000.0)],
            trades: &[],
            last_bar_index: Some(1),
            fee: fee(0.005, 0.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        close(no_min.cash_consumed, 10_000.5);

        // 多笔逐笔取最低（非总额取最低）：3 × 5 = 15。
        let per_fill = compute_audit(&AuditInput {
            recorded: true,
            orders: &[buy(0), buy(1), buy(2)],
            fills: &[
                buy_fill(1, 1.0, 1_000.0),
                buy_fill(2, 1.0, 1_000.0),
                buy_fill(3, 1.0, 1_000.0),
            ],
            trades: &[],
            last_bar_index: Some(3),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        close(per_fill.cash_consumed, 3_015.0);
    }

    // ── 强平回合判据：按 close_bar 配对（非按序号） ──

    #[test]
    fn force_closed_round_trips_match_by_close_bar() {
        let fills = vec![
            sell_fill(5, OrderReason::ForceClose),
            sell_fill(7, OrderReason::Policy),
        ];
        let trades = vec![
            AuditTrade { close_bar: 5 },
            AuditTrade { close_bar: 7 },
            AuditTrade { close_bar: 9 },
        ];
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &[],
            fills: &fills,
            trades: &trades,
            last_bar_index: Some(9),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        assert_eq!(r.round_trips_total, 3);
        assert_eq!(r.round_trips_force_closed, 1, "只有 close_bar=5 的回合与 ForceClose 成交配对");
    }

    // ── 防御面：未执行数不为负 / 无 in-range bar / recorded=false 诚实留白 ──

    #[test]
    fn unexecuted_orders_is_saturating() {
        // 成交多于意图（理论不可达，防御面）：不得出现负值。
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &[buy(0)],
            fills: &[buy_fill(1, 1.0, 1_000.0), buy_fill(2, 1.0, 1_000.0)],
            trades: &[],
            last_bar_index: Some(2),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        assert_eq!(r.unexecuted_orders, 0, "saturating：不得出现负值");
        assert_eq!(r.batches_done, 2);
    }

    #[test]
    fn no_in_range_bar_means_no_last_bar_unfilled() {
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &[],
            fills: &[],
            trades: &[],
            last_bar_index: None,
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        assert!(!r.last_bar_unfilled, "无 in-range bar ⇒ 无末根挂单可言");
        assert_eq!(r.deployed_pct, 0.0);
    }

    #[test]
    fn recorded_false_reports_zeros_and_no_warnings() {
        let r = compute_audit(&AuditInput {
            recorded: false,
            orders: &[buy(0)],
            fills: &[],
            trades: &[],
            last_bar_index: Some(0),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: None,
        });
        assert!(!r.recorded);
        close(r.capital_basis, 100_000.0);
        // 事实源不齐 ⇒ 派生量不得给「0% 投入」这类伪事实。
        assert!(
            codes(&r).is_empty(),
            "recorded=false 不得产出警示性警告（诚实留白）：{:?}",
            codes(&r)
        );
    }

    #[test]
    fn zero_capital_basis_does_not_divide_by_zero() {
        let r = compute_audit(&AuditInput {
            recorded: true,
            orders: &[buy(0)],
            fills: &[buy_fill(1, 1.0, 1_000.0)],
            trades: &[],
            last_bar_index: Some(1),
            fee: fee(0.025, 5.0),
            initial_capital: 0.0,
            policy: None,
        });
        assert_eq!(r.deployed_pct, 0.0, "分母为 0 ⇒ 占比恒 0（不 panic/NaN）");
        assert_eq!(r.cash_consumed_pct, 0.0);
    }

    // ── 投影（JSON 事实 → 入参）：形态兼容 + legacy 缺 warmup 字段 ──

    #[test]
    fn orders_projection_filters_warmup_and_tracks_last_in_range_bar() {
        let bars = vec![
            serde_json::json!({"ts": 1, "warmup": true, "orders": [{"side": "Buy", "qty": 1.0, "reason": "Policy"}]}),
            serde_json::json!({"ts": 2, "warmup": false, "orders": []}),
            serde_json::json!({"ts": 3, "warmup": false, "orders": [{"side": "Buy", "qty": 2.0, "reason": "Policy"},
                                                                   {"side": "Sell", "qty": 1.0, "reason": "Policy"}]}),
        ];
        let (orders, last) = orders_from_per_bar(&bars);
        assert_eq!(last, Some(2), "末根 in-range bar 序号");
        assert_eq!(orders.len(), 2, "warmup 段意图不计数");
        assert_eq!(orders[0], AuditOrder { bar_index: 2, side: OrderSide::Buy, qty: 2.0 });
        assert_eq!(orders[1], AuditOrder { bar_index: 2, side: OrderSide::Sell, qty: 1.0 });
    }

    #[test]
    fn orders_projection_treats_missing_warmup_as_in_range() {
        // legacy_single（P4 之前的 run）记录**无** `warmup` 字段 ⇒ 视为 in-range（否则历史 run 全被排除）。
        let bars = vec![
            serde_json::json!({"ts": 1, "orders": [{"side": "Buy", "qty": 1.0, "reason": "Policy"}]}),
            serde_json::json!({"ts": 2, "orders": []}),
        ];
        let (orders, last) = orders_from_per_bar(&bars);
        assert_eq!(orders.len(), 1, "缺 warmup 字段视为 in-range");
        assert_eq!(last, Some(1));
    }

    #[test]
    fn fills_and_trades_projection_reads_documented_fields() {
        let fills = vec![
            serde_json::json!({"type": "fill", "bar_index": 5, "ts": 10, "side": "Buy", "qty": 2.0,
                               "price": 9.5, "reason": "Policy"}),
            serde_json::json!({"type": "fill", "bar_index": 7, "ts": 12, "side": "Sell", "qty": 2.0,
                               "price": 9.0, "reason": "ForceClose"}),
        ];
        let parsed = fills_from_json(&fills);
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            parsed[0],
            AuditFill { bar_index: 5, side: OrderSide::Buy, qty: 2.0, price: 9.5, reason: Some(OrderReason::Policy) }
        );
        assert_eq!(parsed[1].reason, Some(OrderReason::ForceClose));

        let trades = serde_json::json!([{"close_bar": 7, "pnl": -1.0}, {"close_bar": 12, "pnl": 1.0}]);
        assert_eq!(
            trades_from_json(&trades),
            vec![AuditTrade { close_bar: 7 }, AuditTrade { close_bar: 12 }]
        );
        // 空/非数组 → 空列表（不得 panic）
        assert!(trades_from_json(&serde_json::json!([])).is_empty());
        assert!(trades_from_json(&serde_json::Value::Null).is_empty());
    }

    // ── ADR-027 D3：**v2 形状契约**（无 v1 兼容层；缺字段 = 静默失真 ⇒ fail loud） ──

    /// P1b（2026-09-20 架构裁决 ①）：废弃的 v1 兼容用例 `trade_detail_json_reads_legacy_without_reason_field`
    /// **改写为 v2 形状测试**（不删覆盖）：
    /// 1. v2 全字段 JSON 可读且逐字段正确（含 `Option` 字段的 `Null` 语义）；
    /// 2. 新序列化形态含全部 v2 键（`Open` 回合的 `close_*`/`pnl`/`hold_bars`/`reason` 为 `Null`，**禁造数**）；
    /// 3. **v1 形状（缺 `rt_seq` 等 v2 字段）必须被拒绝**（D3 无兼容窗口，禁止 `serde(default)` 静默通过）。
    #[test]
    fn trade_detail_json_v2_shape_is_locked_and_v1_shape_is_rejected() {
        use backtest::{RoundTripStatus, TradeDetail};

        // (1) v2 全字段（Closed 回合）⇒ 逐字段正确。
        let v2 = serde_json::json!({
            "rt_seq": 3,
            "code": "600000.SH",
            "status": "Closed",
            "open_ts": 1,
            "close_ts": 2,
            "open_bar": 0,
            "close_bar": 1,
            "open_price": 10.0,
            "close_price": 11.0,
            "shares": 100.0,
            "gross_value": 1100.0,
            "commission": 5.0,
            "stamp_duty": 0.55,
            "pnl": 95.0,
            "hold_bars": 1,
            "l2_count": 2,
            "buy_count": 1,
            "sell_count": 1,
            "reason": "Policy"
        });
        let t: TradeDetail = serde_json::from_value(v2).expect("v2 JSON 必须可读");
        assert_eq!(t.rt_seq, 3);
        assert_eq!(t.code, "600000.SH");
        assert_eq!(t.status, RoundTripStatus::Closed);
        assert_eq!(t.close_ts, Some(2));
        assert_eq!(t.close_bar, Some(1));
        assert_eq!(t.close_price, Some(11.0));
        assert_eq!(t.pnl, Some(95.0));
        assert_eq!(t.hold_bars, Some(1));
        assert_eq!(t.l2_count, 2);
        assert_eq!(t.reason.as_deref(), Some("Policy"));

        // (2) `Open` 回合：未定义语义的字段必须序列化为 `Null`（**禁止造 0**，02-spec §2）。
        let open = TradeDetail {
            rt_seq: 1,
            code: "600000.SH".to_string(),
            status: RoundTripStatus::Open,
            open_ts: 1,
            close_ts: None,
            open_bar: 0,
            close_bar: None,
            open_price: 10.0,
            close_price: None,
            shares: 100.0,
            gross_value: 0.0,
            commission: 5.0,
            stamp_duty: 0.0,
            pnl: None,
            hold_bars: None,
            l2_count: 1,
            buy_count: 1,
            sell_count: 0,
            reason: None,
        };
        let j = serde_json::to_value(&open).unwrap();
        for key in [
            "rt_seq",
            "code",
            "status",
            "close_ts",
            "close_bar",
            "close_price",
            "pnl",
            "hold_bars",
            "l2_count",
            "buy_count",
            "sell_count",
            "reason",
        ] {
            assert!(j.get(key).is_some(), "v2 序列化形态必须含 `{key}` 键：{j}");
        }
        for key in ["close_ts", "close_bar", "close_price", "pnl", "hold_bars", "reason"] {
            assert_eq!(j[key], serde_json::Value::Null, "Open 回合 `{key}` 必须为 Null（禁造数）");
        }
        assert_eq!(j["status"], serde_json::json!("Open"));

        // (3) **v1 形状必须被拒绝**：ADR-027 D3 已清空历史、不提供兼容窗口；
        //     `rt_seq` 等 v2 字段**无** `serde(default)` ⇒ 缺字段 = 静默失真 ⇒ 必须报错。
        let v1 = serde_json::json!({
            "open_ts": 1, "close_ts": 2, "open_bar": 0, "close_bar": 1,
            "open_price": 10.0, "close_price": 11.0, "shares": 100.0, "gross_value": 1100.0,
            "commission": 5.0, "stamp_duty": 0.0, "pnl": 95.0, "hold_bars": 1
        });
        let err = serde_json::from_value::<TradeDetail>(v1)
            .expect_err("v1 形状（缺 v2 字段）必须被拒绝，不得静默兼容（ADR-027 D3）");
        assert!(
            err.to_string().contains("rt_seq"),
            "拒绝原因必须指向缺失的 v2 字段（无兼容默认值）：{err}"
        );
    }

    // ── 序列化契约（ADR-026 §2.2 字段名冻结） ──

    #[test]
    fn report_serializes_frozen_field_names() {
        let orders = vec![buy(0)];
        let fills = vec![buy_fill(1, 1.0, 50_000.0)];
        let policy = dca(3);
        let report = compute_audit(&AuditInput {
            recorded: true,
            orders: &orders,
            fills: &fills,
            trades: &[AuditTrade { close_bar: 1 }],
            last_bar_index: Some(1),
            fee: fee(0.025, 5.0),
            initial_capital: 100_000.0,
            policy: Some(&policy),
        });
        let j = serde_json::to_value(&report).unwrap();
        // ADR-026 §2.2 冻结字段 + ADR-027 §5.5 增量（`round_trips_closed`/`round_trips_open`/
        // `rt_reconcile`）——后者由 02-spec §5.5 批准，是**受控**的契约演进。
        let frozen = [
            "recorded", "capital_basis", "deployed_notional", "deployed_pct", "cash_consumed",
            "cash_consumed_pct", "planned_tranches", "reachable_batches", "batches_done",
            "unexecuted_orders", "last_bar_unfilled", "round_trips_total",
            "round_trips_force_closed", "round_trips_closed", "round_trips_open", "rt_reconcile",
            "warnings",
        ];
        // 字段**集**（`serde_json::Value` 用 BTreeMap ⇒ 键序不可断言，仅比集合）。
        let keys: std::collections::BTreeSet<&str> = j
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            frozen.iter().copied().collect::<std::collections::BTreeSet<_>>(),
            "字段名 = ADR-026 §2.2 + ADR-027 §5.5（敞口/资金占用分别命名）"
        );
        assert_eq!(j.as_object().unwrap().len(), frozen.len(), "不得多出/少字段");
        // 字段**顺序**在序列化文本上断言（结构体声明序 = ADR-026 §2.2 的契约序）。
        let text = serde_json::to_string(&report).unwrap();
        let mut cursor = 0usize;
        for k in frozen {
            let pos = text[cursor..]
                .find(&format!("\"{k}\":"))
                .unwrap_or_else(|| panic!("序列化文本缺字段 {k}：{text}"))
                + cursor;
            cursor = pos;
        }
        assert!(text.starts_with("{\"recorded\":"), "首字段须为 recorded：{text}");
        assert_eq!(j["warnings"][0]["code"], WARN_DCA_PLAN_UNDERFILLED);
        assert_eq!(j["warnings"][0]["severity"], SEVERITY_WARN);
    }

    // ── ADR-027 P1a（2026-09-20）：`OrderSide` 唯一定义迁至 `backtest`，strategy-core `pub use` 再导出 ──

    /// 迁移守卫（架构师硬约束）：
    /// 1. 两路径为**同一类型**（`strategy_core::OrderSide` 可直接喂 `backtest::OrderSide` 形参）；
    /// 2. serde 形状**逐字节不变**（外部标记 `"Buy"/"Sell"`，两边互转）；
    /// 3. 与 audit 读侧字符串解析口径一致（同一事实源，无第二套字符串映射）。
    #[test]
    fn order_side_relocation_keeps_type_identity_and_serde_shape() {
        fn takes_backtest_side(s: backtest::OrderSide) -> backtest::OrderSide {
            s
        }

        // 1) 类型恒等（编译期）：strategy_core 的再导出就是 backtest 的类型
        let via_core: OrderSide = OrderSide::Buy;
        assert_eq!(takes_backtest_side(via_core), backtest::OrderSide::Buy);

        // 2) serde 形状逐字节不变 + 往返相等
        assert_eq!(serde_json::to_string(&OrderSide::Buy).unwrap(), "\"Buy\"");
        assert_eq!(serde_json::to_string(&OrderSide::Sell).unwrap(), "\"Sell\"");
        assert_eq!(
            serde_json::from_str::<backtest::OrderSide>("\"Buy\"").unwrap(),
            backtest::OrderSide::Buy,
            "backtest 定义处可反向读出（同一 serde 形状）"
        );
        assert_eq!(
            serde_json::from_str::<OrderSide>("\"Sell\"").unwrap(),
            OrderSide::Sell
        );

        // 3) 字符串读侧口径一致
        assert_eq!(parse_side("Buy"), Some(OrderSide::Buy));
        assert_eq!(parse_side("Sell"), Some(OrderSide::Sell));
    }
}
