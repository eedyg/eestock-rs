/**
 * ADR-027 D8/D9/D10 + **D12（L2 成本归属列）** + ADR-028 D4 —— 交易明细 **L1 回合**列表与 **L2 逐笔**子列表（默认只渲染 L1 一层）。
 *
 * 交互契约（02-spec §9-5、ADR-028 §2.4 按钮表）：
 * - L1 行两枚按钮：`[明细]`（展开该回合 L2，**懒加载**，`aria-expanded` 自带状态）/`[跳转]`（回合区间）；
 * - L2 行两枚按钮：`[明细]`（该笔完整字段详情）/`[跳转]`（该笔 bar）；
 * - **取消隐式整行点击**（避免与文本选中/复制冲突；展开/跳转只由显式按钮触发）；
 * - 允许多条同时展开；窄屏横向滚动而不砍列。
 *
 * L2 列（D12 架构侧钦定顺序，09-plan §4.2）：`bar / 时间 / 方向 / 股数 / 价格 / 金额 / 佣金 / 印花税 /
 * **持仓成本** / **本笔卖出盈亏** / 累计佣金 / 累计印花税 / **累计已实现盈亏** / **累计净现金流** / 来源 / 操作`
 * —— 口径与递推定义见 `roundTripAccum.ts` 模块注（移动加权平均含费）；列值均为 **display-only** 派生，
 * 不得回灌绩效/对账/审计。原「累计盈亏」= 净现金流，**改名**为「累计净现金流」（算法一字不改）。
 *
 * 对账（D10 强制失败态）：展开区顶部若出现 `Σ(L2) != L1`（或后端 audit `rt_reconcile.mismatched` 命中该
 * `rt_seq`）⇒ 醒目告警行（含 Δ 值）并**冻结**展示两侧数值，**禁止**静默按 L1 渲染。
 *
 * 本波（P5a）只做按钮与事件派发：`onJump` 由 P5b 接窗口状态机（禁止此处直接操作 K 线实例）。
 */
import { Fragment, useMemo, useState } from 'react';
import type { FillReason, RoundTrip, RoundTripFill } from '@/api/types';
import { fmtHoldBars, fmtTs } from '@/features/backtest/format';
import { accumulateL2, fmtNum, fmtSellPnl, reconcileRoundTrip, type L2Accum, type ReconcileResult } from './roundTripAccum';
import type { RunL2State, RunRoundTripsState } from './useRunSeries';
import type { RunAuditState } from './useRunAudit';

/** 跳转目标（P5a：只派发事件；窗口写入留给 P5b 的状态机）。 */
/** 跳转目标（ADR-028 D4；P5b 接窗口状态机）。
 *  **同时携带索引与 ts**：索引用于「bar 居中」断言口径，ts 是窗口事实源（Unix 秒）的唯一输入 ——
 *  前端**不得**用 ts/bar_index 反算另一侧（P5a 已冻结「禁复算」纪律），两者都取接口原值。 */
export type JumpTarget =
  | {
      level: 'L1';
      rt_seq: number;
      code: string;
      open_bar: number;
      close_bar: number | null;
      /** 回合开/平时刻（Unix 秒；`Open` 回合 `close_ts=null` ⇒ 窗口退化到开仓点）。 */
      open_ts: number;
      close_ts: number | null;
    }
  | { level: 'L2'; rt_seq: number; code: string; bar_index: number; /** 该笔成交 bar 的 ts（Unix 秒）。 */ ts: number;
      /** ADR-028 D4.1：**该回合内成交序号**（0 基，与 L2 切片顺序同源）⇒ 高亮判别键 `rt_seq:fill_index`。 */
      fill_index: number;
      /** 成交有效价 / 股数（跨源降级匹配用；非主路）。 */
      price: number;
      qty: number };

/** ADR-026 §2.3 + ADR-027 §1.1：来源列取值（历史 run 缺字段 = 未记录；`Manual` = sim-live 人工/外部）。 */
export const TRADE_REASON_LABEL: Record<FillReason, string> = {
  Policy: '正常',
  StopTrigger: '止损',
  ForceClose: '期末强平',
  Manual: '人工',
};

export function tradeSourceLabel(reason: FillReason | null | undefined): string {
  if (!reason) return '未记录';
  return TRADE_REASON_LABEL[reason] ?? reason;
}

/** 累计与 L1 不一致的失败态（ADR-027 D10）：两侧数值**冻结**并列，禁止按 L1 静默渲染。 */
function ReconcileAlert({ rt, file }: { rt: RoundTrip; file: ReconcileResult }) {
  const lines = file.fields
    .filter((f) => f.mismatched)
    .map((f) => `${f.key}：L1 ${fmtNum(f.l1, f.fmt)} ｜ 累计 ${fmtNum(f.l2, f.fmt)} ｜ Δ ${fmtNum(Math.abs(f.delta), f.fmt)}`);
  return (
    <div
      role="alert"
      data-testid={`wb-rt-reconcile-${rt.rt_seq}`}
      className="rounded-lg border border-up/60 bg-up/10 px-2 py-1 text-[11px] text-up"
    >
      <div className="font-medium">
        ⚠ 对账不一致（rt_seq {rt.rt_seq}）：Σ L2 与 L1 不相等 ⇒ 两侧数值**冻结**展示，不按 L1 静默渲染
      </div>
      {file.auditMismatch && (
        <div data-testid={`wb-rt-reconcile-audit-${rt.rt_seq}`}>
          audit rt_reconcile.mismatched 报该回合不一致（rt_seq {rt.rt_seq}）；本页累加结论仅供参考
        </div>
      )}
      {lines.length > 0 && <div data-testid={`wb-rt-reconcile-delta-${rt.rt_seq}`}>{lines.join('；')}</div>}
    </div>
  );
}

/** L2 单笔的字段详情（D9：双口径均价必须带限定词 + 费用三件套 + cum_* 累计）。 */
function L2Fields({
  rt,
  fill,
  acc,
  idx,
}: {
  rt: RoundTrip;
  fill: RoundTripFill;
  acc: L2Accum;
  idx: number;
}) {
  const rows: Array<{ label: string; value: string; testid?: string }> = [
    { label: 'rt_seq', value: String(fill.rt_seq) },
    { label: 'code', value: fill.code },
    { label: 'bar_index（真实 bar 序号）', value: String(fill.bar_index) },
    { label: 'ts', value: fmtTs(fill.ts) },
    { label: 'side', value: fill.side === 'Buy' ? 'Buy（买入）' : 'Sell（卖出）' },
    { label: 'qty（股数）', value: fmtNum(fill.qty, 'qty') },
    { label: 'price（成交有效价，含滑点）', value: fmtNum(fill.price, 'price') },
    { label: 'trade_value（= qty × price，引擎事实）', value: fmtNum(fill.trade_value), testid: `wb-l2-trade-value-${rt.rt_seq}-${idx}` },
    { label: 'commission（本笔佣金，引擎事实）', value: fmtNum(fill.commission), testid: `wb-l2-commission-${rt.rt_seq}-${idx}` },
    { label: 'stamp_duty（本笔印花税，买入恒 0）', value: fmtNum(fill.stamp_duty), testid: `wb-l2-stamp-${rt.rt_seq}-${idx}` },
    { label: 'reason（来源）', value: tradeSourceLabel(fill.reason) },
    { label: 'avg_price_excl_fee（不含费，= 累计成交额/累计股数）', value: fmtNum(acc.avg_price_excl_fee, 'price'), testid: `wb-l2-avg-price-${rt.rt_seq}-${idx}` },
    { label: 'avg_cost_incl_fee（含费，对账口径）', value: fmtNum(acc.avg_cost_incl_fee, 'price'), testid: `wb-l2-avg-cost-${rt.rt_seq}-${idx}` },
    { label: 'cum_commission（回合累计佣金）', value: fmtNum(acc.cum_commission), testid: `wb-l2-detail-cum-commission-${rt.rt_seq}-${idx}` },
    { label: 'cum_stamp_duty（回合累计印花税）', value: fmtNum(acc.cum_stamp_duty), testid: `wb-l2-detail-cum-stamp-${rt.rt_seq}-${idx}` },
    // D12 成本归属派生列（display-only；口径 = 移动加权平均含费，见 roundTripAccum.ts 模块注）
    { label: 'position_cost_incl_fee（本笔成交后持仓含费移动加权单位成本；无持仓 = —）', value: fmtNum(acc.position_cost_incl_fee, 'price'), testid: `wb-l2-detail-cost-${rt.rt_seq}-${idx}` },
    { label: 'sell_pnl（本笔卖出盈亏 = 卖出净收入 − 被消耗成本；仅卖出行）', value: fmtNum(acc.sell_pnl), testid: `wb-l2-detail-sellpnl-${rt.rt_seq}-${idx}` },
    { label: 'sell_pnl_pct（本笔卖出盈亏率 = sell_pnl / 被消耗成本）', value: acc.sell_pnl_pct == null ? '—' : `${fmtNum(acc.sell_pnl_pct * 100)}%`, testid: `wb-l2-detail-sellpnl-pct-${rt.rt_seq}-${idx}` },
    { label: 'cum_realized_pnl（回合累计已实现盈亏，移动加权平均含费成本口径）', value: fmtNum(acc.cum_realized_pnl), testid: `wb-l2-detail-cum-realized-pnl-${rt.rt_seq}-${idx}` },
    { label: 'cum_cashflow（回合累计净现金流 = L1 pnl 的逐笔分解）', value: fmtNum(acc.cum_cashflow), testid: `wb-l2-detail-cum-cashflow-${rt.rt_seq}-${idx}` },
  ];
  return (
    <div
      className="rounded-lg border border-line bg-panel px-2 py-1 text-[11px] text-dim"
      data-testid={`wb-l2-fields-${rt.rt_seq}-${idx}`}
    >
      {rows.map((r) => (
        <div key={r.label} className="flex gap-2">
          <span className="shrink-0">{r.label}</span>
          <span className="num text-txt" data-testid={r.testid}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** L2 子列表（缩进一行；含「已加载 N / 共 M 笔」显式披露 —— ADR-027 D11）。 */
function L2Table({
  rt,
  state,
  accs,
  openFields,
  onToggleFields,
  onJump,
}: {
  rt: RoundTrip;
  state: RunL2State | undefined;
  accs: L2Accum[];
  openFields: Set<string>;
  onToggleFields: (key: string) => void;
  onJump?: (t: JumpTarget) => void;
}) {
  if (!state || (state.loading && state.rows.length === 0)) {
    return (
      <div className="text-[11px] text-dim" data-testid={`wb-l2-loading-${rt.rt_seq}`}>
        L2 成交加载中（懒加载：仅展开该回合时按 rt_seq 请求）…
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="text-[11px] text-up" data-testid={`wb-l2-error-${rt.rt_seq}`}>
        L2 成交加载失败：{state.error}
      </div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <div className="text-[11px] text-dim" data-testid={`wb-l2-empty-${rt.rt_seq}`}>
        该回合无成交（服务端 total=0）
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 overflow-auto">
      <div className="text-[11px] text-dim" data-testid={`wb-l2-coverage-${rt.rt_seq}`}>
        {`L2 已加载 ${state.rows.length} / 共 ${state.total} 笔`}
        {state.truncated ? '（触达单次拉取护栏，未拉全 ⇒ 累计列仅供参考）' : ''}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-line text-left text-[11px] text-dim">
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-bar-${rt.rt_seq}`}>bar</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-ts-${rt.rt_seq}`}>时间</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-side-${rt.rt_seq}`}>方向</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-qty-${rt.rt_seq}`}>股数</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-price-${rt.rt_seq}`}>价格</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-value-${rt.rt_seq}`}>金额</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-commission-${rt.rt_seq}`}>佣金</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-stamp-${rt.rt_seq}`}>印花税</th>
            {/* D12 新增：持仓成本（含费移动加权单位成本；无持仓 —） */}
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-cost-${rt.rt_seq}`}>持仓成本</th>
            {/* D12 新增：本笔卖出盈亏（仅卖出行；`+123.45 (+2.31%)`） */}
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-sellpnl-${rt.rt_seq}`}>本笔卖出盈亏</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-cum-commission-${rt.rt_seq}`}>累计佣金</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-cum-stamp-${rt.rt_seq}`}>累计印花税</th>
            {/* D12 新增：累计已实现盈亏（移动加权平均口径；I6① 首笔卖出前买入行恒 0；② 买入不改变累计 ⇒ 首笔卖出后可正可负） */}
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-cum-realized-pnl-${rt.rt_seq}`}>累计已实现盈亏</th>
            {/* D12 改名：原「累计盈亏」→「累计净现金流」（算法一字不改 = cum_cashflow） */}
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-cum-cashflow-${rt.rt_seq}`}>累计净现金流</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-source-${rt.rt_seq}`}>来源</th>
            <th className="px-2 py-1 font-normal" data-testid={`wb-l2-th-op-${rt.rt_seq}`}>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.rows.map((f, i) => {
            const acc = accs[i]!;
            const key = `${rt.rt_seq}-${i}`;
            const fieldsOpen = openFields.has(key);
            const last = i === state.rows.length - 1;
            return (
              <Fragment key={key}>
                <tr
                  className="border-b border-line/40"
                  data-testid={`wb-l2-row-${rt.rt_seq}-${i}`}
                  data-last-row={last ? 'true' : 'false'}
                >
                  <td className="num px-2 py-1 text-dim">{f.bar_index}</td>
                  <td className="num px-2 py-1 text-dim">{fmtTs(f.ts)}</td>
                  <td className={`px-2 py-1 ${f.side === 'Buy' ? 'text-up' : 'text-down'}`}>{f.side === 'Buy' ? '买' : '卖'}</td>
                  <td className="num px-2 py-1">{fmtNum(f.qty, 'qty')}</td>
                  <td className="num px-2 py-1">{fmtNum(f.price, 'price')}</td>
                  <td className="num px-2 py-1" data-testid={`wb-l2-trade-value-cell-${rt.rt_seq}-${i}`}>{fmtNum(f.trade_value)}</td>
                  <td className="num px-2 py-1">{fmtNum(f.commission)}</td>
                  <td className="num px-2 py-1">{fmtNum(f.stamp_duty)}</td>
                  <td className="num px-2 py-1" data-testid={`wb-l2-cost-${rt.rt_seq}-${i}`}>{fmtNum(acc.position_cost_incl_fee, 'price')}</td>
                  <td
                    className={`num px-2 py-1 ${acc.sell_pnl == null ? 'text-dim' : acc.sell_pnl >= 0 ? 'text-up' : 'text-down'}`}
                    data-testid={`wb-l2-sellpnl-${rt.rt_seq}-${i}`}
                  >
                    {fmtSellPnl(acc.sell_pnl, acc.sell_pnl_pct)}
                  </td>
                  <td className="num px-2 py-1" data-testid={`wb-l2-cum-commission-${rt.rt_seq}-${i}`}>{fmtNum(acc.cum_commission)}</td>
                  <td className="num px-2 py-1" data-testid={`wb-l2-cum-stamp-${rt.rt_seq}-${i}`}>{fmtNum(acc.cum_stamp_duty)}</td>
                  <td
                    className={`num px-2 py-1 ${acc.cum_realized_pnl >= 0 ? 'text-up' : 'text-down'}`}
                    data-testid={`wb-l2-cum-realized-pnl-${rt.rt_seq}-${i}`}
                  >
                    {fmtNum(acc.cum_realized_pnl)}
                  </td>
                  <td className="num px-2 py-1" data-testid={`wb-l2-cum-cashflow-${rt.rt_seq}-${i}`}>{fmtNum(acc.cum_cashflow)}</td>
                  <td className="px-2 py-1 text-dim">{tradeSourceLabel(f.reason)}</td>
                  <td className="whitespace-nowrap px-2 py-1">
                    <button
                      type="button"
                      aria-expanded={fieldsOpen}
                      aria-controls={`wb-l2-fields-${rt.rt_seq}-${i}`}
                      data-testid={`wb-l2-detail-${rt.rt_seq}-${i}`}
                      className="rounded border border-line px-2 py-0.5 text-dim hover:text-txt"
                      onClick={() => onToggleFields(key)}
                    >
                      明细
                    </button>
                    <button
                      type="button"
                      data-testid={`wb-l2-jump-${rt.rt_seq}-${i}`}
                      className="ml-1 rounded border border-line px-2 py-0.5 text-dim hover:text-txt"
                      onClick={() =>
                        onJump?.({
                          level: 'L2',
                          rt_seq: rt.rt_seq,
                          code: rt.code,
                          bar_index: f.bar_index,
                          ts: f.ts,
                          fill_index: i,
                          price: f.price,
                          qty: f.qty,
                        })
                      }
                    >
                      跳转
                    </button>
                  </td>
                </tr>
                {fieldsOpen && (
                  <tr className="border-b border-line/40">
                    <td colSpan={16} className="px-2 py-1">
                      <L2Fields rt={rt} fill={f} acc={acc} idx={i} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * L1 表 + 展开的 L2 子列表。
 * `ensureL2` 只在 `[明细]` 展开时调用（展开前**零** L2 请求 —— F2 懒加载判据）。
 */
export function RoundTripsTable({
  state,
  l2,
  ensureL2,
  onLoadMore,
  onJump,
  audit,
}: {
  state: RunRoundTripsState;
  l2: Record<number, RunL2State>;
  ensureL2: (rtSeq: number) => void;
  onLoadMore: () => void;
  onJump?: (t: JumpTarget) => void;
  audit: RunAuditState;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [openFields, setOpenFields] = useState<Set<string>>(new Set());

  const toggleRt = (rtSeq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rtSeq)) next.delete(rtSeq);
      else {
        next.add(rtSeq);
        ensureL2(rtSeq); // 懒加载：仅展开时取数
      }
      return next;
    });
  };

  const toggleFields = (key: string) => {
    setOpenFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const tolerance = audit.data?.rt_reconcile.tolerance ?? 1e-6;
  const mismatchedSeqs = useMemo(() => new Set(audit.data?.rt_reconcile.mismatched ?? []), [audit.data]);

  if (state.loading && state.rows.length === 0) {
    return (
      <div className="p-3 text-xs text-dim" data-testid="wb-rt-loading">
        交易明细（L1 回合）加载中…
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="p-3 text-xs text-up" data-testid="wb-rt-error">
        交易明细（L1 回合）加载失败：{state.error}
      </div>
    );
  }
  if (!state.recorded) {
    return (
      <div
        className="rounded-lg border border-line bg-panel2 px-2 py-1 text-[11px] text-dim"
        data-testid="wb-rt-unrecorded"
      >
        交易明细：未记录（该 run 无成交事实源 ⇒ L1 回合不可得，不以空表冒充「无成交」）
      </div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <div className="p-3 text-xs text-dim" data-testid="wb-round-trips-table">
        无成交回合（服务端 total=0）
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 overflow-auto">
      <div className="text-[11px] text-dim" data-testid="wb-rt-coverage">
        {`回合 已加载 ${state.rows.length} / 共 ${state.total} 条（ADR-027 D8：L2 逐笔按 rt_seq 懒加载）`}
      </div>
      <table className="w-full border-collapse text-xs" data-testid="wb-round-trips-table">
        <thead>
          <tr className="border-b border-line text-left text-[11px] text-dim">
            <th className="px-2 py-1 font-normal">回合</th>
            <th className="px-2 py-1 font-normal">标的</th>
            <th className="px-2 py-1 font-normal">状态</th>
            <th className="px-2 py-1 font-normal">开仓</th>
            <th className="px-2 py-1 font-normal">平仓</th>
            <th className="px-2 py-1 font-normal">开价</th>
            <th className="px-2 py-1 font-normal">平价</th>
            <th className="px-2 py-1 font-normal">股数</th>
            <th className="px-2 py-1 font-normal">卖出金额</th>
            <th className="px-2 py-1 font-normal">佣金</th>
            <th className="px-2 py-1 font-normal">印花税</th>
            <th className="px-2 py-1 font-normal">盈亏</th>
            <th className="px-2 py-1 font-normal">持仓</th>
            <th className="px-2 py-1 font-normal">来源</th>
            <th className="px-2 py-1 font-normal">成交</th>
            <th className="px-2 py-1 font-normal">操作</th>
          </tr>
        </thead>
        <tbody>
          {state.rows.map((rt) => {
            const open = expanded.has(rt.rt_seq);
            const l2State = l2[rt.rt_seq];
            const accs = l2State ? accumulateL2(l2State.rows) : [];
            const recon =
              l2State && !l2State.loading && l2State.rows.length > 0
                ? reconcileRoundTrip(rt, l2State.rows, { tolerance, auditMismatch: mismatchedSeqs.has(rt.rt_seq) })
                : null;
            return (
              <Fragment key={rt.rt_seq}>
                <tr className="border-b border-line/40" data-testid={`wb-rt-row-${rt.rt_seq}`}>
                  <td className="num px-2 py-1" data-testid={`wb-rt-seq-${rt.rt_seq}`}>{rt.rt_seq}</td>
                  <td className="px-2 py-1 text-dim">{rt.code}</td>
                  <td className="px-2 py-1 text-dim" data-testid={`wb-rt-status-${rt.rt_seq}`}>
                    {rt.status === 'Closed' ? '已平仓' : '持仓中（Open）'}
                  </td>
                  <td className="num px-2 py-1 text-dim" data-testid={`wb-rt-open-${rt.rt_seq}`}>{fmtTs(rt.open_ts)}</td>
                  <td className="num px-2 py-1 text-dim" data-testid={`wb-rt-close-${rt.rt_seq}`}>
                    {rt.close_ts != null ? fmtTs(rt.close_ts) : '—'}
                  </td>
                  <td className="num px-2 py-1" data-testid={`wb-rt-open-price-${rt.rt_seq}`}>{fmtNum(rt.open_price, 'price')}</td>
                  <td className="num px-2 py-1" data-testid={`wb-rt-close-price-${rt.rt_seq}`}>
                    {rt.close_price != null ? fmtNum(rt.close_price, 'price') : '—'}
                  </td>
                  <td className="num px-2 py-1" data-testid={`wb-rt-shares-${rt.rt_seq}`}>{fmtNum(rt.shares, 'qty')}</td>
                  <td className="num px-2 py-1" data-testid={`wb-rt-gross-${rt.rt_seq}`}>{fmtNum(rt.gross_value)}</td>
                  <td className="num px-2 py-1" data-testid={`wb-rt-commission-${rt.rt_seq}`}>{fmtNum(rt.commission)}</td>
                  <td className="num px-2 py-1" data-testid={`wb-rt-stamp-${rt.rt_seq}`}>{fmtNum(rt.stamp_duty)}</td>
                  <td
                    className={`num px-2 py-1 ${rt.pnl == null ? 'text-dim' : rt.pnl >= 0 ? 'text-up' : 'text-down'}`}
                    data-testid={`wb-rt-pnl-${rt.rt_seq}`}
                  >
                    {fmtNum(rt.pnl)}
                  </td>
                  <td className="num px-2 py-1 text-dim">{fmtHoldBars(rt.hold_bars ?? undefined)}</td>
                  <td className="px-2 py-1 text-dim" data-testid={`wb-rt-source-${rt.rt_seq}`}>
                    {tradeSourceLabel(rt.reason)}
                  </td>
                  <td className="px-2 py-1 text-dim" data-testid={`wb-rt-summary-${rt.rt_seq}`}>
                    {`成交 ${rt.l2_count} 笔（买 ${rt.buy_count} / 卖 ${rt.sell_count}）`}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`wb-rt-l2-${rt.rt_seq}`}
                      data-testid={`wb-rt-detail-${rt.rt_seq}`}
                      className="rounded border border-line px-2 py-0.5 text-dim hover:text-txt"
                      onClick={() => toggleRt(rt.rt_seq)}
                    >
                      明细
                    </button>
                    <button
                      type="button"
                      data-testid={`wb-rt-jump-${rt.rt_seq}`}
                      className="ml-1 rounded border border-line px-2 py-0.5 text-dim hover:text-txt"
                      onClick={() =>
                        onJump?.({
                          level: 'L1',
                          rt_seq: rt.rt_seq,
                          code: rt.code,
                          open_bar: rt.open_bar,
                          close_bar: rt.close_bar,
                          open_ts: rt.open_ts,
                          close_ts: rt.close_ts,
                        })
                      }
                    >
                      跳转
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-line/40 bg-panel2/40">
                    <td colSpan={16} className="px-2 py-1" data-testid={`wb-rt-l2-${rt.rt_seq}`}>
                      <div className="flex flex-col gap-1">
                        {/* D10：对账不一致 ⇒ 展开区**顶部**醒目告警（冻结两侧数值） */}
                        {recon && !recon.ok && <ReconcileAlert rt={rt} file={recon} />}
                        <L2Table
                          rt={rt}
                          state={l2State}
                          accs={accs}
                          openFields={openFields}
                          onToggleFields={toggleFields}
                          onJump={onJump}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {state.hasMore && (
        <div className="flex items-center gap-2 text-[11px] text-dim" data-testid="wb-rt-more-note">
          <span>{`已加载 ${state.rows.length} / 共 ${state.total} 条回合（未加载 ${state.total - state.rows.length} 条）`}</span>
          <button
            type="button"
            data-testid="wb-rt-load-more"
            className="rounded border border-line px-2 py-0.5 hover:text-txt"
            onClick={onLoadMore}
            disabled={state.loadingMore}
          >
            {state.loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
