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

// ── ADR-029 Step 1（`exposure` 模式）审计增量 ──────────────────────────────

/// 警告码（ADR-029 D7）：意图（`target_pct`）与实际暴露（`position_ratio`）**最大差**超阈。
pub const WARN_EXPOSURE_INTENT_GAP: &str = "EXPOSURE_INTENT_GAP";
/// 警告码（ADR-029 D7）：抖动指标超阈（下单频度 / 费用占净值比）。
pub const WARN_EXPOSURE_CHURN: &str = "EXPOSURE_CHURN";

/// 意图差判据阈值（ADR-029 D7/R7 **钉死** 0.05；本批以构造场景标定复核，见单测）。
pub const EXPOSURE_INTENT_GAP_THRESHOLD: f64 = 0.05;

/// 抖动判据：评估段**每 bar 下单比**上限（ADR-029 D7“不下每 bar 微单”；标定见单测）。
pub const EXPOSURE_CHURN_ORDERS_PER_BAR_THRESHOLD: f64 = 0.5;

/// 抖动判据：**费用占净值比**上限 0.5%（分母 = `capital_basis`，同 `deployed_pct` 口径）。
pub const EXPOSURE_CHURN_FEE_PCT_THRESHOLD: f64 = 0.005;

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

/// per_bar 曝光观测投影（ADR-029 D7；仅 in-range bar，`target_pct`/`current_pct` 齐备者）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AuditExposureBar {
    /// 决策 bar 序号（= `per_bar` 数组下标）。
    pub bar_index: usize,
    /// 本 bar 输出目标占净值比（`target_pct`，决策 bar 收盘估值）。
    pub target_pct: f64,
    /// 本 bar **收盘时点**的实际暴露占净值比（与持仓序列 `position_ratio` 同点同值）。
    ///
    /// 注：`t` 的挂单在 `t+1` 开盘成交 ⇒ 「`t` 的意图是否达成」只能拿 `t+1` 的 `current_pct` 判
    /// （ADR-029 R18 滞后一 bar 对齐）。
    pub current_pct: f64,
    pub clamped_by_guard: bool,
    pub deadzone_blocked: bool,
    pub rate_limited: bool,
    pub sell_transition: bool,
    /// 本 bar 目标因现金不可达被一次性下调（ADR-029 E17）。
    pub affordability_capped: bool,
}

/// ADR-029 D7 审计增量：**意图 vs 实际差值** + **抖动指标**（纯派生，无 IO）。
///
/// 口径（ADR-029 D7/R18/§4 第 15 条**钉死**）：
/// - **`max_intent_gap` 滞后一 bar 对齐**（ADR-029 R18）：`max_t |target_pct_t − current_pct_{t+1}|`
///   （`t` 与其**相邻决策 bar** `t+1`；**末根无 `t+1` ⇒ 排除**）。理由：既有执行口径是「决策 bar 收盘
///   挂单、**次 bar 开盘成交**」⇒ 同 bar 比较会把**成交时滞**误判成「意图未达成」（实测
///   `Fixed{0.6}+Immediate` 同 bar 0.6031 ⇒ 每根清仓 bar 均告警；滞后一 bar 后 0.0135 ⇒ 零告警）。
///   **「建仓首根排除」特例已取消**（滞后口径下首根自然≈0）；
/// - `orders` = 评估段挂单数（= 既有 `orders` 投影条数，含止损/强平挂单）；
/// - `fee_pct` = 评估段**费用**（买入佣金 + 卖出佣金 + 印花税，按 run 生效 `FeeModel` 复算）
///   / `capital_basis`（与 `deployed_pct` **同分母**；本审计无净值序列，故不用时点净值作分母）；
/// - `warnings` 仅当 run 策略为 `Exposure` 时发声（**与 `WARN_PARTIAL_DEPLOYMENT`
///   并列、禁止互相解释**，R8：旧变体的欠配由既有两条告警负责）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExposureAudit {
    /// 评估段带曝光观测的 bar 数（0 ⇒ 无意图可核，派生量为零值）。
    pub bars: usize,
    /// 评估段 `max_t |target_pct_t − current_pct_{t+1}|`（滞后一 bar 对齐；末根无 `t+1` 不计）。
    pub max_intent_gap: f64,
    /// 取到最大差的**决策 bar** 序号 `t`（可追溯；无观测或全段无差 ⇒ `None`）。
    pub max_intent_gap_bar: Option<usize>,
    /// 评估段挂单数。
    pub orders: usize,
    /// 评估段每 bar 下单比（`bars = 0` ⇒ 0）。
    pub orders_per_bar: f64,
    /// 费用占净值比（分母 = `capital_basis`）。
    pub fee_pct: f64,
    /// guard 夹取 bar 数。
    pub clamped_bars: usize,
    /// 死区拦下 bar 数。
    pub deadzone_blocked_bars: usize,
    /// 限速命中 bar 数。
    pub rate_limited_bars: usize,
    /// 跨卖出档边界 bar 数。
    pub sell_transition_bars: usize,
    /// 因现金不可达被下调目标的 bar 数（ADR-029 E17 披露）。
    pub affordability_capped_bars: usize,
    /// 非阻断警告（仅 `Exposure` 策略下非空）。
    pub warnings: Vec<AuditWarning>,
}

/// `per_bar` 数组 → 曝光观测（ADR-029 D7；`target_pct`/`current_pct` 齐备的 in-range bar）。
///
/// - `warmup` 缺失视为 in-range（与 [`orders_from_per_bar`] 同口径）；
/// - 观测字段缺失（本 ADR 之前的 run / legacy 记录）⇒ 该 bar 跳过（**不造数**，诚实留白）；
/// - 死区命中时引擎写的 `target_pct` = 当前暴露占比（无订单），与 `deadzone_blocked` 一起可复原事实。
pub fn exposure_from_per_bar(bars: &[serde_json::Value]) -> Vec<AuditExposureBar> {
    let mut out = Vec::new();
    for (i, bar) in bars.iter().enumerate() {
        if bar
            .get("warmup")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let (Some(target_pct), Some(current_pct)) = (
            bar.get("target_pct").and_then(serde_json::Value::as_f64),
            bar.get("current_pct").and_then(serde_json::Value::as_f64),
        ) else {
            continue;
        };
        let flag = |k: &str| {
            bar.get(k)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        out.push(AuditExposureBar {
            bar_index: i,
            target_pct,
            current_pct,
            clamped_by_guard: flag("clamped_by_guard"),
            deadzone_blocked: flag("deadzone_blocked"),
            rate_limited: flag("rate_limited"),
            sell_transition: flag("sell_transition"),
            affordability_capped: flag("affordability_capped"),
        });
    }
    out
}

/// ADR-029 D7 审计增量（纯函数，无 IO）。
///
/// `policy` 仅为**告警发声门禁**（`Exposure` 才发声；旧变体的欠配/计划缺口由 ADR-026 既有
/// 两条告警负责，R8 禁互相解释）；指标本身与策略无关，均照实计算（透明度优先）。
pub fn exposure_audit(
    bars: &[AuditExposureBar],
    orders: &[AuditOrder],
    fills: &[AuditFill],
    fee: FeeModel,
    capital_basis: f64,
    policy: Option<&ExecutionPolicy>,
) -> ExposureAudit {
    let n = bars.len();
    let mut max_intent_gap = 0.0f64;
    let mut max_intent_gap_bar: Option<usize> = None;
    let mut clamped_bars = 0usize;
    let mut deadzone_blocked_bars = 0usize;
    let mut rate_limited_bars = 0usize;
    let mut sell_transition_bars = 0usize;
    let mut affordability_capped_bars = 0usize;
    // ADR-029 D7/R18/§4-15：**滞后一 bar 对齐** —— `gap_t = |target_pct_t − current_pct_{t+1}|`。
    // 「决策 bar 收盘挂单、次 bar 开盘成交」是既有执行口径 ⇒ 只有 `t` 与**相邻决策 bar** `t+1` 的
    // 实际暴露可比；同 bar 比较会把成交时滞当「意图未达成」（R18）。配对要求 `bar_index` 相邻
    // （观测缺字段/跨段 ⇒ 不成对，不造数）；**末根无 `t+1` ⇒ 不参与统计**（`windows(2)` 天然排除）。
    // 计数 `gap_pairs` 仅入告警 message（不新增结构字段，键集不变）。
    let mut gap_pairs = 0usize;
    for w in bars.windows(2) {
        let (cur, next) = (&w[0], &w[1]);
        if next.bar_index != cur.bar_index + 1 {
            continue;
        }
        gap_pairs += 1;
        let gap = (cur.target_pct - next.current_pct).abs();
        // 逐 bar 取最大；严格大于才更新 ⇒ 首个最大者优先（确定性）。
        // 仅**正差**才定位 bar：全段无差 ⇒ `max_intent_gap_bar = None`（无「最大差 bar」可言）。
        if gap > 0.0 && (max_intent_gap_bar.is_none() || gap > max_intent_gap) {
            max_intent_gap = gap;
            max_intent_gap_bar = Some(cur.bar_index);
        }
    }
    for b in bars {
        clamped_bars += b.clamped_by_guard as usize;
        deadzone_blocked_bars += b.deadzone_blocked as usize;
        rate_limited_bars += b.rate_limited as usize;
        sell_transition_bars += b.sell_transition as usize;
        affordability_capped_bars += b.affordability_capped as usize;
    }
    // 费用口径：与 `cash_consumed` 同源（`FeeModel` 复算，禁另写一套），卖出另计印花税。
    let fees: f64 = fills
        .iter()
        .map(|f| {
            let trade_value = f.qty * f.price;
            match f.side {
                OrderSide::Buy => fee.commission(trade_value),
                OrderSide::Sell => fee.commission(trade_value) + fee.stamp_duty(trade_value),
            }
        })
        .sum();
    let orders_per_bar = if n > 0 {
        orders.len() as f64 / n as f64
    } else {
        0.0
    };
    let fee_pct = ratio(fees, capital_basis);

    let mut warnings = Vec::new();
    let exposure_mode = matches!(policy, Some(ExecutionPolicy::Exposure { .. }));
    if exposure_mode && n > 0 {
        if max_intent_gap > EXPOSURE_INTENT_GAP_THRESHOLD {
            warnings.push(AuditWarning {
                code: WARN_EXPOSURE_INTENT_GAP,
                severity: SEVERITY_WARN,
                message: format!(
                    "意图（target_pct）与实际暴露最大差 {max_intent_gap:.4}，超过阈值 {EXPOSURE_INTENT_GAP_THRESHOLD:.2}（口径：**滞后一 bar 对齐** max_t |target_pct_t − current_pct_{{t+1}}|；评估段 {n} 根 bar，末根无次 bar 已排除，参与配对 {gap_pairs} 对；最大差出现在 bar {}（决策 bar t）；限速/死区/现金不足/意图下调均可致差）",
                    max_intent_gap_bar.unwrap_or(0)
                ),
            });
        }
        if orders_per_bar > EXPOSURE_CHURN_ORDERS_PER_BAR_THRESHOLD
            || fee_pct > EXPOSURE_CHURN_FEE_PCT_THRESHOLD
        {
            warnings.push(AuditWarning {
                code: WARN_EXPOSURE_CHURN,
                severity: SEVERITY_WARN,
                message: format!(
                    "抖动指标超阈：评估段挂单 {} 笔 / {} 根 bar（每 bar {orders_per_bar:.3}，阈值 {EXPOSURE_CHURN_ORDERS_PER_BAR_THRESHOLD:.2}），费用占净值 {:.4}%（阈值 {:.2}%）——检查 deadzone_pct/ramp 配置是否让分数抖动直接变成订单抖动",
                    orders.len(),
                    n,
                    fee_pct * 100.0,
                    EXPOSURE_CHURN_FEE_PCT_THRESHOLD * 100.0
                ),
            });
        }
    }

    ExposureAudit {
        bars: n,
        max_intent_gap,
        max_intent_gap_bar,
        orders: orders.len(),
        orders_per_bar,
        fee_pct,
        clamped_bars,
        deadzone_blocked_bars,
        rate_limited_bars,
        sell_transition_bars,
        affordability_capped_bars,
        warnings,
    }
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
    // =====================================================================
    // ADR-029 Step 1：审计增量（意图 vs 实际 + 抖动指标；E10 / D7 / R7）
    // =====================================================================

    fn exp_policy() -> ExecutionPolicy {
        ExecutionPolicy::Exposure {
            target: strategy_core::ExposureTarget::ScoreMapped {
                at_threshold_pct: 0.2,
                at_full_pct: 0.8,
                sell: strategy_core::SellPolicy::Flat,
            },
            ramp: strategy_core::RampSpec::RateCap { pct_per_bar: 0.05 },
            guard: strategy_core::GuardSpec { max_pct: 0.9, min_pct: 0.0, deadzone_pct: 0.005 },
        }
    }

    fn obs(bar_index: usize, target_pct: f64, current_pct: f64) -> AuditExposureBar {
        AuditExposureBar {
            bar_index,
            target_pct,
            current_pct,
            clamped_by_guard: false,
            deadzone_blocked: false,
            rate_limited: false,
            sell_transition: false,
            affordability_capped: false,
        }
    }

    /// `per_bar` JSON → 曝光观测投影：跳过 warmup 与缺字段（本 ADR 之前的 run）⇒ 不造数。
    #[test]
    fn exposure_projection_skips_warmup_and_legacy_records() {
        let bars = vec![
            // warmup：有观测字段但属预热段 ⇒ 跳过
            serde_json::json!({"warmup": true, "target_pct": 0.5, "current_pct": 0.0}),
            // legacy（本 ADR 之前）记录：无观测字段 ⇒ 跳过（诚实留白）
            serde_json::json!({"warmup": false, "orders": []}),
            // in-range 且字段齐备 ⇒ 取用（warmup 缺失按 in-range 处理）
            serde_json::json!({"target_pct": 0.4, "current_pct": 0.1, "rate_limited": true}),
            serde_json::json!({"warmup": false, "target_pct": 0.4, "current_pct": 0.4,
                               "deadzone_blocked": true, "clamped_by_guard": true}),
        ];
        let out = exposure_from_per_bar(&bars);
        assert_eq!(out.len(), 2, "只取 in-range 且字段齐备的 bar");
        assert_eq!(out[0].bar_index, 2);
        assert!(out[0].rate_limited && !out[0].deadzone_blocked);
        assert!(out[1].deadzone_blocked && out[1].clamped_by_guard);
        close(out[1].target_pct, 0.4);
    }

    /// E10：意图 vs 实际差值 + 抖动指标可读；两条新告警**只在 `Exposure` 策略下发声**。
    #[test]
    fn exposure_audit_reports_gap_and_churn_and_is_gated_to_exposure() {
        let policy = exp_policy();
        // 评估段 6 根 bar：**滞后一 bar** 最大差 0.12（bar2 = |target_2 0.32 − current_3 0.20|）> 0.05；
        // 挂单 4 笔 / 6 bar = 0.667 > 0.5（末根 bar5 无次 bar ⇒ 不参与差值统计）
        let bars = vec![
            obs(0, 0.20, 0.10),
            obs(1, 0.25, 0.15),
            obs(2, 0.32, 0.20),
            obs(3, 0.32, 0.20),
            obs(4, 0.32, 0.28),
            obs(5, 0.32, 0.32),
        ];
        let orders = vec![buy(0), buy(1), buy(2), buy(3)];
        let fills = vec![buy_fill(1, 1.0, 5_000.0)];
        let r = exposure_audit(&bars, &orders, &fills, fee(0.025, 5.0), 100_000.0, Some(&policy));
        assert_eq!(r.bars, 6);
        close(r.max_intent_gap, 0.12);
        assert_eq!(r.max_intent_gap_bar, Some(2), "最大差可追溯到 bar");
        assert_eq!(r.orders, 4);
        close(r.orders_per_bar, 4.0 / 6.0);
        close(r.fee_pct, 5.0 / 100_000.0); // 5000×0.025% = 1.25 元 → 最低佣金 5 元（FeeModel 口径）
        assert_eq!(
            r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
            vec![WARN_EXPOSURE_INTENT_GAP, WARN_EXPOSURE_CHURN],
            "两条告警：意图差（阈 0.05）+ 抖动（每 bar 下单比 0.667 > 0.5）"
        );
        assert_eq!(r.warnings[0].severity, SEVERITY_WARN);
        assert!(
            r.warnings[0].message.contains("0.1200") && r.warnings[0].message.contains("bar 2"),
            "意图差告警须含数值与定位：{}",
            r.warnings[0].message
        );
        assert!(
            r.warnings[0].message.contains("滞后一 bar"),
            "口径（滞后一 bar 对齐）须在消息中披露：{}",
            r.warnings[0].message
        );
        assert!(
            r.warnings[1].message.contains("每 bar 0.667"),
            "抖动告警须含实测量：{}",
            r.warnings[1].message
        );

        // 达标场景（滞后差 ≤ 0.05、下单稀疏）⇒ 零告警
        // （建仓首根 bar0（current 0）不再享特例：其差 = |0.30 − current_1 0.28| = 0.02，仍远低于阈值）
        let good = vec![obs(0, 0.30, 0.0), obs(1, 0.30, 0.28), obs(2, 0.30, 0.30)];
        let r = exposure_audit(&good, &[buy(0)], &[buy_fill(1, 1.0, 5_000.0)], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, 0.02);
        assert!(r.warnings.is_empty(), "达标场景不得告警：{:?}", r.warnings);

        // 门禁（R8）：非 `Exposure` 策略（旧变体的欠配由既有告警负责）⇒ 指标照算、**不发声**
        let legacy = lump(0.5);
        let r = exposure_audit(&bars, &orders, &fills, fee(0.025, 5.0), 100_000.0, Some(&legacy));
        close(r.max_intent_gap, 0.12);
        assert_eq!(r.max_intent_gap_bar, Some(2), "指标（含定位）与策略无关，照实计算");
        assert!(r.warnings.is_empty(), "旧变体不得新增告警（防噪音/禁互相解释）");
        // policy 缺失（解析失败/历史 config）同样不发声
        let r = exposure_audit(&bars, &orders, &fills, fee(0.025, 5.0), 100_000.0, None);
        assert!(r.warnings.is_empty());
    }

    /// 阈值标定取证（先标定后写死）：同一 ±5 分抖动序列下「有死区 / 无死区」两组读数，
    /// 证明 `EXPOSURE_CHURN_ORDERS_PER_BAR_THRESHOLD = 0.5` 有鉴别力。
    ///
    /// 读数（本用例实测，见交付报告）：
    /// - 有死区：20 根 bar / 1 笔挂单 ⇒ 每 bar 0.05、费用 5 元 / 10 万 = 0.005%（不告警）；
    /// - 无死区：20 根 bar / 20 笔挂单 ⇒ 每 bar 1.0、费用 100 元 / 10 万 = 0.1%（告警）。
    #[test]
    fn exposure_audit_churn_threshold_is_calibrated() {
        let policy = exp_policy();
        let with_deadzone: Vec<AuditExposureBar> = (0..20)
            .map(|i| {
                let mut b = obs(i, 0.2, 0.2);
                b.deadzone_blocked = i > 0;
                b
            })
            .collect();
        let r = exposure_audit(
            &with_deadzone,
            &[buy(0)],
            &[buy_fill(1, 1.0, 20_375.0)],
            fee(0.025, 5.0),
            100_000.0,
            Some(&policy),
        );
        close(r.orders_per_bar, 0.05);
        assert!(r.warnings.is_empty(), "有死区 ⇒ 不告警");

        let no_deadzone: Vec<AuditExposureBar> = (0..20).map(|i| obs(i, 0.2, 0.2)).collect();
        let orders: Vec<AuditOrder> = (0..20).map(buy).collect();
        let fills: Vec<AuditFill> = (0..20).map(|i| buy_fill(i + 1, 1.0, 5_000.0)).collect();
        let r = exposure_audit(
            &no_deadzone,
            &orders,
            &fills,
            fee(0.025, 5.0),
            100_000.0,
            Some(&policy),
        );
        assert_eq!(r.orders, 20);
        close(r.orders_per_bar, 1.0);
        close(r.fee_pct, 100.0 / 100_000.0);
        assert_eq!(
            r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
            vec![WARN_EXPOSURE_CHURN],
            "无死区 ⇒ 每 bar 一单被判抖动"
        );

        // 费用维度：小净值下最低佣金累积 ⇒ 费用占比告警（分母 = capital_basis，与 deployed_pct 同口径）
        let r = exposure_audit(
            &no_deadzone,
            &orders,
            &fills,
            fee(0.025, 5.0),
            10_000.0,
            Some(&policy),
        );
        close(r.fee_pct, 0.01);
        assert!(r.warnings[0].message.contains("1.0000%"), "费用读数须写入消息：{}", r.warnings[0].message);
    }

    /// 同 bar（**旧口径**）最大差：只用于判据的**鉴别力自证**与红/绿对照，**不**参与实现。
    ///
    /// ADR-029 D7/R18 定案的旧口径是 `max |target_pct_t − current_pct_t|`（加「排除建仓首根」特例）；
    /// 本函数给出其**去特例**上界（不排除任何根）⇒ 旧口径读数 ≥ 本读数，故用它能证「旧口径必误报」。
    fn same_bar_max_gap(bars: &[AuditExposureBar]) -> f64 {
        bars.iter()
            .map(|b| (b.target_pct - b.current_pct).abs())
            .fold(0.0f64, f64::max)
    }

    /// **E16（D7/R18/§4-15）· 清仓/翻转根不得误报**（真实 run 窗口）。
    ///
    /// 取值来自真实 run `sr_1790266267194_000009`（`Fixed{pct=0.6}+ramp=Immediate`）的
    /// `per_bar` bar 310–318 原文（in-range；取证见交付报告 §BLOCKED-2）：
    /// bar313 `Buy`（目标 0.6、持仓 0）→ 其成交落在 **bar314 开盘**，故 bar314（`Sell`，目标 0）
    /// 的 `current_pct` 仍为 0.6031 ⇒ **同 bar 口径必然误报**；滞后一 bar 后该窗口最大差仅 0.0045。
    #[test]
    fn e16_liquidation_and_flip_bars_do_not_false_alarm() {
        let policy = exp_policy();
        let bars = vec![
            obs(310, 0.0, 0.0),
            obs(311, 0.0, 0.0),
            obs(312, 0.0, 0.0),
            obs(313, 0.6, 0.0),                     // Buy 决策（成交在 bar314）
            obs(314, 0.0, 0.6030701464124579),      // Sell 决策（清仓成交在 bar315）
            obs(315, 0.6, 0.0),                     // 重建 Buy
            obs(316, 0.6045024187463942, 0.6045024187463942),
            obs(317, 0.6010406210011352, 0.6010406210011352),
            obs(318, 0.6004577542061642, 0.6004577542061642),
        ];
        // ① 判别力自证（防空壳用例）：该序列在**同 bar** 口径下必然越阈
        let broken = same_bar_max_gap(&bars);
        close(broken, 0.6030701464124579);
        assert!(
            broken > EXPOSURE_INTENT_GAP_THRESHOLD,
            "序列须能复现旧口径误报（同 bar 最大差 {broken:.6}）"
        );
        // ② 清仓/翻转根零告警（滞后一 bar 对齐 = |target_t − current_{{t+1}}|）
        let r = exposure_audit(&bars, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, 0.0045024187463942); // |target_315 0.6 − current_316 0.6045024|
        assert_eq!(r.max_intent_gap_bar, Some(315), "定位到差最大的**决策 bar**（t 而非 t+1）");
        assert!(
            r.max_intent_gap < EXPOSURE_INTENT_GAP_THRESHOLD,
            "滞后口径读数须低于阈值（实测 {}）",
            r.max_intent_gap
        );
        assert!(
            r.warnings.is_empty(),
            "清仓/翻转根不得误报 EXPOSURE_INTENT_GAP：{:?}",
            r.warnings
        );
    }

    /// **E16（D7/R18/§4-15）· 持续未达成仍须告警**（判据**不得**被削弱）。
    ///
    /// 构造「目标与净值脱钩 / 现金受限」：目标恒 0.60 而实际暴露被卡在 0.20 ⇒ 逐 bar 未达成。
    #[test]
    fn e16_persistent_unmet_target_still_warns() {
        let policy = exp_policy();
        // ① 连续 4 根都未达成（滞后差恒 0.40）
        let stuck = vec![obs(0, 0.60, 0.0), obs(1, 0.60, 0.20), obs(2, 0.60, 0.20), obs(3, 0.60, 0.20)];
        let r = exposure_audit(&stuck, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, 0.40);
        assert_eq!(r.max_intent_gap_bar, Some(0), "首个最大者优先（确定性）");
        assert_eq!(
            r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
            vec![WARN_EXPOSURE_INTENT_GAP],
            "持续未达成必须告警：{:?}",
            r.warnings
        );
        let msg = &r.warnings[0].message;
        assert!(
            msg.contains("0.4000") && msg.contains("bar 0"),
            "告警须给出 max_intent_gap 与定位 bar：{msg}"
        );
        // ② 中途偏离后**持续**不修复（0.30 目标 vs 0.14 实际）⇒ 告警定位到偏离根 bar2
        let drifted = vec![
            obs(0, 0.30, 0.0),
            obs(1, 0.30, 0.30),
            obs(2, 0.30, 0.30),
            obs(3, 0.30, 0.14),
            obs(4, 0.30, 0.14),
        ];
        let r = exposure_audit(&drifted, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, 0.16); // |target_2 0.30 − current_3 0.14|
        assert_eq!(r.max_intent_gap_bar, Some(2));
        assert_eq!(
            r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
            vec![WARN_EXPOSURE_INTENT_GAP]
        );
        assert!(r.warnings[0].message.contains("0.1600") && r.warnings[0].message.contains("bar 2"));
    }

    /// **E16（D7/R18/§4-15）· 末根不参与统计**（无 `t+1`）。
    ///
    /// 末根的「目标 vs 持仓」差**无可比对的次 bar**（其挂单本就无 bar 可成交）⇒ 不计入。
    #[test]
    fn e16_last_bar_is_excluded_no_t_plus_one() {
        let policy = exp_policy();
        // 末根 bar2（`Sell` 决策，目标 0）持仓仍 0.60：同 bar 差 0.60，但无 t+1 ⇒ 不统计
        let bars = vec![obs(0, 0.60, 0.0), obs(1, 0.60, 0.60), obs(2, 0.0, 0.60)];
        assert!(
            same_bar_max_gap(&bars) > EXPOSURE_INTENT_GAP_THRESHOLD,
            "判别力：该序列同 bar 差超阈（否则本用例不具鉴别力）"
        );
        let r = exposure_audit(&bars, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        assert_eq!(r.bars, 3, "观测根数照实计数（末根照入）");
        close(r.max_intent_gap, 0.0);
        assert_eq!(r.max_intent_gap_bar, None, "末根无 t+1 ⇒ 无差可说");
        assert!(r.warnings.is_empty(), "末根不计入：{:?}", r.warnings);
        // 反向对照（同一「未达成」差，但存在次 bar）⇒ 立即可判、且定位到决策 bar2
        let with_next = vec![obs(0, 0.60, 0.0), obs(1, 0.60, 0.60), obs(2, 0.0, 0.60), obs(3, 0.60, 0.60)];
        let r = exposure_audit(&with_next, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, 0.60); // |target_2 0.0 − current_3 0.60|：清仓意图在次 bar 仍未达成
        assert_eq!(r.max_intent_gap_bar, Some(2));
        assert_eq!(
            r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
            vec![WARN_EXPOSURE_INTENT_GAP],
            "有次 bar 的未达成必须告警（证明上一条是「末根排除」而非「差被吞了」）"
        );
    }

    /// **E16（D7/R18/§4-15）· 观测缺失导致跨 bar ⇒ 不配对**（`t` 与 `t+1` 必须是**相邻决策 bar**）。
    ///
    /// 若拿 `t` 与 `t+2` 比，就是把两次成交时滞混成一次读数（造数）；观测缺失（legacy 记录/字段不齐）
    /// 时诚实放弃该配对。
    #[test]
    fn e16_non_contiguous_observations_are_not_paired() {
        let policy = exp_policy();
        // bar12 观测缺失 ⇒ (11,13) 不成对（若强行按列表相邻配对将得 0.30 的伪读数）
        let gapped = vec![obs(10, 0.60, 0.0), obs(11, 0.60, 0.60), obs(13, 0.90, 0.90)];
        let r = exposure_audit(&gapped, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, 0.0);
        assert_eq!(r.max_intent_gap_bar, None);
        assert!(r.warnings.is_empty(), "跨缺失观测不得配对：{:?}", r.warnings);
        // 对照：把 bar12 补回（观测齐全）⇒ 立即可配对并计入（证明上一条是「不配对」而非「漏算」）
        let complete = vec![
            obs(10, 0.60, 0.0),
            obs(11, 0.60, 0.60),
            obs(12, 0.60, 0.60),
            obs(13, 0.90, 0.90),
        ];
        let r = exposure_audit(&complete, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, 0.30); // |target_12 0.60 − current_13 0.90|
        assert_eq!(r.max_intent_gap_bar, Some(12));
        assert_eq!(
            r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
            vec![WARN_EXPOSURE_INTENT_GAP]
        );
    }

    /// **E16（D7/R18）· 阈值严格性**：恰好等于阈值**不**告警，超过才告警（`>` 而非 `>=`）。
    #[test]
    fn e16_threshold_is_strictly_greater() {
        let policy = exp_policy();
        // 滞后差恰为阈值位级同值（0.05）⇒ 不告警
        let at = vec![obs(0, EXPOSURE_INTENT_GAP_THRESHOLD, 0.0), obs(1, 0.0, 0.0)];
        let r = exposure_audit(&at, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, EXPOSURE_INTENT_GAP_THRESHOLD);
        assert!(r.warnings.is_empty(), "恰等于阈值不得告警：{:?}", r.warnings);
        // 略高于阈值 ⇒ 告警
        let over = vec![obs(0, EXPOSURE_INTENT_GAP_THRESHOLD * 1.2, 0.0), obs(1, 0.0, 0.0)];
        let r = exposure_audit(&over, &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        close(r.max_intent_gap, EXPOSURE_INTENT_GAP_THRESHOLD * 1.2);
        assert_eq!(
            r.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
            vec![WARN_EXPOSURE_INTENT_GAP]
        );
    }

    /// 观测桶计数（guard 夹取 / 死区 / 限速 / 卖出跳变）逐 bar 汇总可读。
    #[test]
    fn exposure_audit_counts_flag_bars() {
        let policy = exp_policy();
        let mut a = obs(0, 0.9, 0.0);
        a.clamped_by_guard = true;
        a.rate_limited = true;
        let mut b = obs(1, 0.9, 0.9);
        b.deadzone_blocked = true;
        let mut c = obs(2, 0.0, 0.9);
        c.sell_transition = true;
        let r = exposure_audit(
            &[a, b, c],
            &[],
            &[],
            fee(0.025, 5.0),
            100_000.0,
            Some(&policy),
        );
        assert_eq!(r.clamped_bars, 1);
        assert_eq!(r.deadzone_blocked_bars, 1);
        assert_eq!(r.rate_limited_bars, 1);
        assert_eq!(r.sell_transition_bars, 1);
        // 空评估段：派生量零值（不造数）
        let r = exposure_audit(&[], &[], &[], fee(0.025, 5.0), 100_000.0, Some(&policy));
        assert_eq!(r.bars, 0);
        assert_eq!(r.max_intent_gap_bar, None);
        close(r.orders_per_bar, 0.0);
        assert!(r.warnings.is_empty());
    }
}
