/**
 * ADR-027 D9/§2.10 —— L2 逐笔的**双口径均价**与 `cum_*` 累计列（纯函数，无 IO）。
 *
 * 口径冻结（与 `design/17-trade-detail-layering/02-spec.md` §2 的 L1 聚合同序同算式）：
 * - `avg_price_excl_fee`（**不含费**，与 L1 `open_price`/`close_price` 同口径）
 *   = 该笔所属侧「累计 `trade_value`」/「累计 `qty`」（买入侧 → 买均价；卖出侧 → 卖均价）；
 * - `avg_cost_incl_fee`（**含费**，对账口径）= 该笔所属侧「累计含费成本」/「累计 `qty`」：
 *   买入侧 = `Σ(trade_value + commission)`（买入总成本）；卖出侧 = `Σ(trade_value − commission − stamp_duty)`（卖出净收入）；
 * - `cum_commission` / `cum_stamp_duty` = 该回合**逐笔顺序**累加（Σ 全部成交，不分侧）；
 * - `cum_realized_pnl` = 该回合**现金流差**逐笔累计（买 `−(trade_value + commission)`、卖 `+(trade_value − commission − stamp_duty)`），
 *   即 L1 `pnl` 的逐笔分解（**无成本分摊 / 无 FIFO 归属**，ADR-027 D1 / Q9b）。
 *
 * **硬约束**：本模块只做「按给定顺序的累加」，不重排、不重算费用、不引入 lot 匹配；同序累加保证
 * `Σ(L2) == L1` 在浮点层面逐位可对账（恒等式 I2）。
 * 命名消歧（ADR-027 §2.10 强制）：UI 标签必须带限定词，裸用「均价」视为违约。
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
  /** 该笔成交后：回合累计已实现盈亏（现金流差）。 */
  cum_realized_pnl: number;
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
  let cumPnl = 0;
  const out: L2Accum[] = [];
  for (const f of fills) {
    cumCommission += f.commission;
    cumStampDuty += f.stamp_duty;
    if (f.side === 'Buy') {
      buyQty += f.qty;
      buyValue += f.trade_value;
      buyNet += f.trade_value + f.commission;
      cumPnl -= f.trade_value + f.commission;
      out.push({
        avg_price_excl_fee: buyQty > 0 ? buyValue / buyQty : 0,
        avg_cost_incl_fee: buyQty > 0 ? buyNet / buyQty : 0,
        cum_commission: cumCommission,
        cum_stamp_duty: cumStampDuty,
        cum_realized_pnl: cumPnl,
      });
    } else {
      sellQty += f.qty;
      sellValue += f.trade_value;
      sellNet += f.trade_value - f.commission - f.stamp_duty;
      cumPnl += f.trade_value - f.commission - f.stamp_duty;
      out.push({
        avg_price_excl_fee: sellQty > 0 ? sellValue / sellQty : 0,
        avg_cost_incl_fee: sellQty > 0 ? sellNet / sellQty : 0,
        cum_commission: cumCommission,
        cum_stamp_duty: cumStampDuty,
        cum_realized_pnl: cumPnl,
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
    mk('pnl', 'pnl（回合盈亏）', rt.pnl, last?.cum_realized_pnl ?? 0, 'money'),
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
