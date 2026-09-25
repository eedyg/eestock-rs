/**
 * ADR-027 D9/§2.10 + **D12/§2.14（2026-09-25 架构侧裁定）** —— L2 逐笔的**双口径均价**、`cum_*` 累计列与
 * **成本归属派生列**（纯函数，无 IO）。
 *
 * 口径冻结（与 `design/17-trade-detail-layering/02-spec.md` §2 的 L1 聚合同序同算式）：
 * - `avg_price_excl_fee`（**不含费**，与 L1 `open_price`/`close_price` 同口径）
 *   = 该笔所属侧「累计 `trade_value`」/「累计 `qty`」（买入侧 → 买均价；卖出侧 → 卖均价）；
 * - `avg_cost_incl_fee`（**含费**，对账口径）= 该笔所属侧「累计含费成本」/「累计 `qty`」：
 *   买入侧 = `Σ(trade_value + commission)`（买入总成本）；卖出侧 = `Σ(trade_value − commission − stamp_duty)`（卖出净收入）；
 * - `cum_commission` / `cum_stamp_duty` = 该回合**逐笔顺序**累加（Σ 全部成交，不分侧）；
 * - `cum_cashflow` = 该回合**净现金流**逐笔累计（买 `−(trade_value + commission)`、卖 `+(trade_value − commission − stamp_duty)`），
 *   即 L1 `pnl` 的逐笔分解（**无成本分摊 / 无 FIFO 归属**）。**原字段名 `cum_realized_pnl` 已不再表示净现金流**
 *   （D12 命名消歧）—— 逐回合对账（{@link reconcileRoundTrip}）仍以本字段末值与 L1 `pnl` 对照；
 * - `cum_realized_pnl`（**D12 重定义**）= 回合累计**已实现盈亏** = Σ 该回合各笔 `sell_pnl`（买入时不变）。
 *
 * D12 成本归属口径 = **移动加权平均成本（含费）**，按同回合 L2 成交顺序递推（**L2 事实字段为准，禁复算费用**）：
 * - 买入：`qty += q`；`cost_total += trade_value + commission`；`unit_cost = cost_total / qty`；
 * - 卖出：`consumed = q_s × unit_cost`（**unit_cost 不因部分卖出而改变**）；`qty −= q_s`；`cost_total −= consumed`；
 * - 卖出净收入 `= trade_value − commission − stamp_duty` ⇒ `sell_pnl = 净收入 − consumed`、`sell_pnl_pct = sell_pnl / consumed`；
 * - `position_cost_incl_fee` = 该笔成交**后**的 `unit_cost`（无持仓 ⇒ `null`，UI 显示 `—`）。
 *
 * **越卖（无成本基准的卖出）⇒ 不造数**（架构侧 2026-09-26 裁定 1 原文：「现实现构成「造数」，违反「不造数」纪律……
 * `consumed = 0` ⇒ `sell_pnl = 净收入全额`……把一笔无成本基准的卖出的全额收入记成已实现盈利（虚增 `cum_realized_pnl`，
 * 并可能污染 I5 语义）」；裁定要求：「命中时**一律**：`sell_pnl = null`、`sell_pnl_pct = null`；`cum_realized_pnl`
 * **不累加**（保持上一值）——**不得**把无基准收入计入；`position_cost_incl_fee = null`；`positionQty`/`positionCost`
 * **一律夹到 0**（不得留负残值污染后续笔）」）：
 * - 判定用**相对容差**（与 `rt_reconcile.tolerance` 相对口径同源）：真越卖 = `f.qty > positionQty + qtyTol`，
 *   `qtyTol = 1e-9 × max(1, positionQty)`（2026-09-26 追加裁定 1：无容差会把「本应全平、qty 差 1e-13」的浮点
 *   噪声判成越卖 ⇒ 该笔 `—` 且不计入累计 ⇒ **打断 I5**；噪声不得变成判据失败）；
 * - **全平（含浮点噪声）**：`qty >= positionQty − qtyTol` ⇒ `consumed` 直接取成本池**总额**（精确）、持仓/成本归 0、
 *   `position_cost_incl_fee = null` ⇒ 保证「同一回合 ∑ `sell_pnl` == 净现金流末值」（**I5** 成立）；
 * - 残留的 0 分母情形（`consumed == 0`，如 0 股卖出）⇒ `sell_pnl_pct = null`（裁定 2 通过：不出 NaN/Infinity）。
 *
 * **0 股卖出（有持仓）= 费用事件**（2026-09-26 追加裁定 2：**保持现状**）：走部分卖出分支 ⇒ `consumed = 0`、
 * `sell_pnl = 净收入 = −（佣金 + 印花税）`（纯费用**事实**字段，**不是造数**）、`sell_pnl_pct = null`（不成比例）、持仓与持仓成本不变。
 *
 * **为什么不是 FIFO**：① FIFO 会在部分卖出时把**持仓成本跳到较晚批次**的成本（用户看到「莫名跳变」）；
 * ② FIFO 需在回测侧引入 lot 重算 ⇒ 正是 ADR-027 §2.10 **Q9b** 所忌的**第二事实源**（Q9b 的「不引入」结论已由
 * D12 显式修订，但其担忧被「不引入 FIFO / 纯函数派生 / display-only」消解）；③ 移动加权平均在部分卖出后
 * 持仓成本**保持不变**，是 A 股券商「持仓成本价」的通行口径，且与回测侧加权平均语义同源。
 *
 * **display-only（硬约束）**：本模块全部 D12 派生列**只供展示**，**不得**回灌绩效 / 对账 / 审计或被任何计算消费；
 * 对账判据（I2）的输入仍是**事实字段**，不由本模块改写。
 *
 * **硬约束**：本模块只做「按给定顺序的累加」，不重排、不重算费用、不引入 lot 匹配；同序累加保证
 * `Σ(L2) == L1` 在浮点层面逐位可对账（恒等式 I2）。
 * 恒等式 **I5**：`status='Closed'` 且全平的回合 ⇒ 末笔 `cum_realized_pnl == L1 pnl`（容差沿用 `rt_reconcile.tolerance` 相对口径）；
 * 恒等式 **I6**（2026-09-26 独立复验**更正**：原字面判据「买入行不得为负」被活库推翻 —— 买入行承载的是
 * **回合累计已实现盈亏**，首笔卖出之后自然可正可负，原缺陷只是「买入即显示净投入」与此无关）：
 *   ① **首笔卖出之前**的买入行 `cum_realized_pnl === 0`（防「净投入伪装」）；
 *   ② **买入不改变**累计 ⇒ 买入行值 == 其**前一笔**的值（首笔卖出后买入行**可正可负**，这是正确行为）。
 * 命名消歧（ADR-027 §2.10 强制）：UI 标签必须带限定词，裸用「均价」「累计盈亏」视为违约。
 */
import type { RoundTrip, RoundTripFill } from '@/api/types';

/** 单笔成交的累计派生量（与 {@link RoundTripFill} 一一对应，同 index）。 */
export interface L2Accum {
  /** 该笔成交后：所属侧累计有效价（不含费）。 */
  avg_price_excl_fee: number;
  /** 该笔成交后：所属侧累计含费均价（对账口径）。 */
  avg_cost_incl_fee: number;
  /** 该笔成交后：回合累计佣金。 */
  cum_commission: number;
  /** 该笔成交后：回合累计印花税。 */
  cum_stamp_duty: number;
  /** 该笔成交后：回合累计**净现金流**（买 `−(trade_value+commission)`、卖 `+(trade_value−commission−stamp_duty)`）。
   *  **原 `cum_realized_pnl` 的算法一字不改并改名至此**（D12 命名消歧）；对账（{@link reconcileRoundTrip}）取本字段末值与 L1 `pnl` 比。 */
  cum_cashflow: number;
  /** 该笔成交后：回合累计**已实现盈亏**（移动加权平均含费口径；买入不变、卖出加该笔 {@link L2Accum.sell_pnl}）。
   *  **I6**（2026-09-26 更正）：① 首笔卖出前的买入行恒 `0`（防「净投入伪装」）；② 买入**不改变**累计
   *  （买入行 == 其前一笔的值；首笔卖出后买入行**可正可负**）。**I5**：全平回合末笔 == L1 `pnl`。 */
  cum_realized_pnl: number;
  /** 该笔成交**后**持仓的**含费**移动加权单位成本 `= cost_total / qty`；**无持仓 ⇒ `null`**（UI 显示 `—`）。 */
  position_cost_incl_fee: number | null;
  /** 本笔卖出盈亏（绝对额）`= 卖出净收入 − q_s × unit_cost(卖出前)`；**仅卖出行有值，买出行 `null`**。
   *  **真越卖**（`f.qty > positionQty + qtyTol`，无成本基准）⇒ `null`（不造数；2026-09-26 裁定 1）；
   *  **0 股卖出 = 费用事件** ⇒ `−（佣金+印花税）`（2026-09-26 追加裁定 2）。 */
  sell_pnl: number | null;
  /** 本笔卖出盈亏率 `= sell_pnl / 被消耗成本`（**比例小数**，UI 负责百分号）；仅卖出行且被消耗成本 > 0，
   *  否则（含**越卖**与 0 分母）`null`。 */
  sell_pnl_pct: number | null;
}

/**
 * 逐笔累计（同序、单遍）：返回数组与 `fills` 等长、同 index 对应。
 * 空输入 ⇒ 空输出（不造零行）。
 */
export function accumulateL2(fills: RoundTripFill[]): L2Accum[] {
  let buyQty = 0;
  let buyValue = 0;
  let buyNet = 0; // Σ(trade_value + commission)
  let sellQty = 0;
  let sellValue = 0;
  let sellNet = 0; // Σ(trade_value − commission − stamp_duty)
  let cumCommission = 0;
  let cumStampDuty = 0;
  let cumCashflow = 0; // 净现金流（原 cum_realized_pnl 算法，一字不改）
  let positionQty = 0; // 持仓股数（占位；**不由费用/成交额重算**）
  let positionCost = 0; // 持仓含费成本池 = Σ(买入 trade_value + commission) − Σ 已消耗成本
  let cumRealizedPnl = 0; // 已实现盈亏（D12：买入不变、卖出加该笔 sell_pnl）
  const out: L2Accum[] = [];
  for (const f of fills) {
    cumCommission += f.commission;
    cumStampDuty += f.stamp_duty;
    if (f.side === 'Buy') {
      buyQty += f.qty;
      buyValue += f.trade_value;
      buyNet += f.trade_value + f.commission;
      cumCashflow -= f.trade_value + f.commission;
      positionQty += f.qty;
      positionCost += f.trade_value + f.commission;
      out.push({
        avg_price_excl_fee: buyQty > 0 ? buyValue / buyQty : 0,
        avg_cost_incl_fee: buyQty > 0 ? buyNet / buyQty : 0,
        cum_commission: cumCommission,
        cum_stamp_duty: cumStampDuty,
        cum_cashflow: cumCashflow,
        cum_realized_pnl: cumRealizedPnl, // 买入**不改变**累计已实现盈亏（I6②；值可为 0 / 正 / 负）
        position_cost_incl_fee: positionQty > 0 ? positionCost / positionQty : null,
        sell_pnl: null,
        sell_pnl_pct: null,
      });
    } else {
      sellQty += f.qty;
      sellValue += f.trade_value;
      sellNet += f.trade_value - f.commission - f.stamp_duty;
      cumCashflow += f.trade_value - f.commission - f.stamp_duty; // 净现金流始终按事实字段累加（不因越卖改变）
      const netIncome = f.trade_value - f.commission - f.stamp_duty;
      // 全平/越卖的**相对容差**（与 `rt_reconcile.tolerance` 相对口径同源；架构侧 2026-09-26 追加裁定 1）：
      // 无容差时「本应全平、但 `f.qty` 比 `positionQty` 大 1e-13」会被判**越卖** ⇒ 该笔 `—` 且不计入累计
      // ⇒ 直接**打断 I5**（末笔累计 ≠ L1 pnl）——“噪声变判据失败”不可接受。故取 `1e-9 × max(1, positionQty)`。
      const qtyTol = 1e-9 * Math.max(1, positionQty);
      let sellPnl: number | null = null;
      let sellPnlPct: number | null = null;
      let positionCostInclFee: number | null = null;
      if (f.qty > positionQty + qtyTol) {
        // 真越卖（无成本基准）⇒ 不造数：sell_pnl/_pct = null、不计入 cum_realized_pnl、持仓夹到 0（不留负残值）
        positionQty = 0;
        positionCost = 0;
      } else if (positionQty > 0 && f.qty >= positionQty - qtyTol) {
        // **全平（含浮点噪声）**：被消耗成本直接取成本池**总额**（精确）⇒「同一回合 Σ sell_pnl == 净现金流末值」
        // 不被 1e-13 噪声破坏（**I5** 成立）；持仓/成本归 0 ⇒ `position_cost_incl_fee = null`。
        const consumed = positionCost;
        sellPnl = netIncome - consumed;
        cumRealizedPnl += sellPnl;
        sellPnlPct = consumed > 0 ? sellPnl / consumed : null;
        positionQty = 0;
        positionCost = 0;
      } else {
        // 部分卖出（含 `f.qty == 0` 的**费用事件**）⇒ 原递推：单位成本取**卖出前**成本池均价（不变 ⇒ 部分卖出后持仓成本不变）。
        // 0 股成交口径（架构侧 2026-09-26 追加裁定 2，**保持现状**）：`consumed = 0` ⇒ `sell_pnl = 净收入 = −（佣金+印花税）`
        // （纯费用**事实**字段，不是造数）、`sell_pnl_pct = null`（0 分母不成比例）、持仓与持仓成本不变。
        const unitCost = positionQty > 0 ? positionCost / positionQty : 0;
        const consumed = f.qty * unitCost; // 被消耗成本
        sellPnl = netIncome - consumed;
        cumRealizedPnl += sellPnl;
        positionQty -= f.qty;
        positionCost -= consumed;
        sellPnlPct = consumed > 0 ? sellPnl / consumed : null; // 0 分母 ⇒ null（裁定 2 通过）
        positionCostInclFee = positionQty > 0 ? positionCost / positionQty : null;
      }
      out.push({
        avg_price_excl_fee: sellQty > 0 ? sellValue / sellQty : 0,
        avg_cost_incl_fee: sellQty > 0 ? sellNet / sellQty : 0,
        cum_commission: cumCommission,
        cum_stamp_duty: cumStampDuty,
        cum_cashflow: cumCashflow,
        cum_realized_pnl: cumRealizedPnl,
        position_cost_incl_fee: positionCostInclFee,
        sell_pnl: sellPnl,
        sell_pnl_pct: sellPnlPct,
      });
    }
  }
  return out;
}

/** 对账字段（一侧的 L1 值 + 另一侧 L2 累计值 + Δ）。 */
export interface ReconcileField {
  key: string;
  label: string;
  /** L1 侧数值（`null` = L1 无该值，如 Open 回合的 `pnl`）。 */
  l1: number | null;
  /** L2 累计/求和侧数值。 */
  l2: number;
  /** `l2 − l1`（`l1=null` ⇒ Δ 记为 NaN，不参与判定）。 */
  delta: number;
  /** 该字段是否超容差。 */
  mismatched: boolean;
  /** 展示精度类别（money=2 位小数 / qty=股数 / int=计数）。 */
  fmt: 'money' | 'qty' | 'int';
}

export interface ReconcileResult {
  /** 全部字段在容差内且后端 audit 未报该回合不一致。 */
  ok: boolean;
  fields: ReconcileField[];
  /** 后端 `/audit` 的 `rt_reconcile.mismatched` 含该 `rt_seq`（独立于本页累加结论）。 */
  auditMismatch: boolean;
}

/**
 * 逐回合对账（ADR-027 D10 的守卫）：
 * 1. 本页 `Σ(L2)` 与 L1 逐字段比较（容差 = `/audit.rt_reconcile.tolerance`，相对口径 `tol × max(1, |l1|)`）；
 * 2. 后端 audit `mismatched` 命中该 `rt_seq` ⇒ 即使本页相加一致也必须告警（接口版本不一致等场景）。
 *
 * **输入语义与输出口径由 D12 冻结**：`pnl` 字段的 L2 侧仍取「**净现金流**」末值（`cum_cashflow`，D12 重定义前
 * 的 `cum_realized_pnl` 算法一字不改）—— 不得改用已实现盈亏（后者是 display-only 派生，不参与对账）。
 * 不修改任何一侧数值（调用方**冻结**两侧展示，禁止「按 L1 静默渲染」）。
 */
export function reconcileRoundTrip(
  rt: RoundTrip,
  fills: RoundTripFill[],
  opts: { tolerance: number; auditMismatch?: boolean },
): ReconcileResult {
  const acc = accumulateL2(fills);
  const last = acc[acc.length - 1];
  let sellValue = 0;
  let buyQty = 0;
  let commission = 0;
  let stampDuty = 0;
  for (const f of fills) {
    commission += f.commission;
    stampDuty += f.stamp_duty;
    if (f.side === 'Buy') buyQty += f.qty;
    else sellValue += f.trade_value;
  }
  const tol = opts.tolerance > 0 ? opts.tolerance : 1e-6;
  const mk = (key: string, label: string, l1: number | null, l2: number, fmt: ReconcileField['fmt']): ReconcileField => {
    const delta = l1 == null ? Number.NaN : l2 - l1;
    const mismatched = l1 != null && Math.abs(delta) > tol * Math.max(1, Math.abs(l1));
    return { key, label, l1, l2, delta, mismatched, fmt };
  };
  const fields: ReconcileField[] = [
    mk('commission', 'commission（佣金）', rt.commission, commission, 'money'),
    mk('stamp_duty', 'stamp_duty（印花税）', rt.stamp_duty, stampDuty, 'money'),
    mk('gross_value', 'gross_value（卖出金额）', rt.gross_value, sellValue, 'money'),
    mk('shares', 'shares（股数）', rt.shares, buyQty, 'qty'),
    mk('pnl', 'pnl（回合盈亏）', rt.pnl, last?.cum_cashflow ?? 0, 'money'),
    mk('l2_count', 'l2_count（成交笔数）', rt.l2_count, fills.length, 'int'),
  ];
  const auditMismatch = opts.auditMismatch === true;
  return { ok: !auditMismatch && fields.every((f) => !f.mismatched), fields, auditMismatch };
}

/** 金额 / 股数 / 价格 / 计数展示（L1 表与 L2 累计列**共用**同一格式化 ⇒「末行 == L1」可直接字符串断言）。
 *  `price` = 3 位（成交价/均价口径，与既有页面⑤逐笔价格精度一致）；`money` = 2 位。 */
export function fmtNum(
  x: number | null | undefined,
  fmt: 'money' | 'qty' | 'int' | 'price' = 'money',
): string {
  if (x == null || Number.isNaN(x)) return '—';
  if (fmt === 'int') return String(x);
  if (fmt === 'qty') return x.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  if (fmt === 'price') return x.toFixed(3);
  return x.toFixed(2);
}

/**
 * 「本笔卖出盈亏」单元格文本（**唯一格式出口**：L2 表与后续真渲染 e2e 共用；数值仍走 {@link fmtNum}，禁自造数字格式）。
 *
 * 格式（09-plan §4.2 / ADR-027 §2.14）：`+123.45 (+2.31%)` —— 绝对额带 `+` 号（D12 冻结格式），
 * 百分比由**比例小数** × 100 后取 **2 位**并带 `%`。买出行 / 未知 ⇒ `—`；百分比不可定义（无被消耗成本）⇒ 只出绝对额。
 */
export function fmtSellPnl(pnl: number | null | undefined, pct: number | null | undefined): string {
  if (pnl == null || Number.isNaN(pnl)) return '—';
  const abs = `${pnl >= 0 ? '+' : ''}${fmtNum(pnl)}`;
  if (pct == null || Number.isNaN(pct)) return abs;
  return `${abs} (${pct >= 0 ? '+' : ''}${fmtNum(pct * 100)}%)`;
}
