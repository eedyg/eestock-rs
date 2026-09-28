import { useCallback, useRef, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { StrategyCatalogEntry, WorkbenchExposureAudit, WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
import { fmtHoldBars, fmtMoney, fmtPct, fmtRatio, periodLabel } from '@/features/backtest/format';
import { KlineResultChart } from './KlineResultChart';
import { AggregateScoreChart } from './AggregateScoreChart';
import { SlotScoresChart } from './SlotScoresChart';
import { EquityDrawdownChart } from './EquityDrawdownChart';
import { PositionRatioChart } from './PositionRatioChart';
import { PerBarTable } from './PerBarTable';
import { RoundTripsTable, type JumpTarget } from './RoundTripsTable';
import { makeFillKey } from './KlineResultChart';
import { EventLog } from './EventLog';
import { useRunSeries, type RunFillsState } from './useRunSeries';
import { useRunAudit, type RunAuditState } from './useRunAudit';
import { useResultWindow } from './useResultWindow';
import { useCardResize } from './cardResize';
import { useResultChartConfig, type ResultCardId } from './resultChartConfig';
import { cardBoundsFor, readCardHeight, subPaneCountFor, writeCardHeight } from './resultCardHeights';
import { useResultLayout } from './useResultLayout';
import { SPLITTER_PX } from './resultLayout';
import { DetailPane, type DetailTabKey } from './DetailPane';
import { IndicatorToggles } from '@/features/dashboard/IndicatorToggles';

/** 明细 tab（ADR-028 §2.7 第 2 项：①②③④ 全搬 + 内部 tab；默认「回合与逐笔」）。 */
type TabKey = DetailTabKey;

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '完成',
  failed: '失败',
  canceled: '已取消',
};

/** 8 项绩效表（口径由后端 strategy-core 锁定，前端只读展示）。
 *  ADR-026 §2.4-2：**必须**带口径注（分母 = 初始资金）并并列披露资金投入率 ——
 *  未满仓时年化/回撤/夏普按初始资金为分母会低估风险，两个口径必须同时可见。 */
function MetricsTable({
  result,
  audit,
  capitalBasis,
}: {
  result: WorkbenchRunResult;
  audit: RunAuditState;
  capitalBasis: number;
}) {
  const m = result.metrics;
  /** ADR-026 §2.4-3：`profit_factor=null` = 区间内无亏损（JSON 无法表达 ∞）⇒ 显「∞（无亏损）」并注明。 */
  const pfInfinite = m.profit_factor == null;
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'net_profit', label: 'net_profit（净盈亏）', value: fmtMoney(m.net_profit) },
    { key: 'max_drawdown', label: 'max_drawdown（最大回撤）', value: fmtPct(m.max_drawdown) },
    { key: 'sharpe', label: 'sharpe（夏普）', value: fmtRatio(m.sharpe) },
    { key: 'win_rate', label: 'win_rate（胜率）', value: fmtPct(m.win_rate) },
    { key: 'profit_factor', label: 'profit_factor（盈亏比）', value: pfInfinite ? '∞（无亏损）' : fmtRatio(m.profit_factor) },
    { key: 'annualized_return', label: 'annualized_return（年化）', value: fmtPct(m.annualized_return) },
    { key: 'trade_count', label: 'trade_count（交易数）', value: String(m.trade_count) },
    { key: 'avg_hold_bars', label: 'avg_hold_bars（平均持仓）', value: fmtHoldBars(m.avg_hold_bars) },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-dim" data-testid="wb-metrics-basis">
        {`口径：年化 / 最大回撤 / 夏普的分母 = 初始资金 ${fmtMoney(capitalBasis)}（未满仓时按实际投入口径的风险更高，故并列披露资金投入率）`}
      </div>
      <DeployedRate audit={audit} />
      <table className="w-full border-collapse text-xs" data-testid="wb-metrics-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line/40">
              <td className="px-2 py-1.5 text-dim">{r.label}</td>
              <td className="num px-2 py-1.5 text-right">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pfInfinite && (
        <div className="text-[11px] text-dim" data-testid="wb-metrics-pf-note">
          profit_factor = ∞（无亏损）：区间内无亏损平仓，JSON 无法表达 ∞ 故后端回 null
        </div>
      )}
    </div>
  );
}

/** 资金投入率（ADR-026 §2.1 口径消歧：名义投入=敞口；现金消耗=含佣金）。
 *  三态沿用仓内既有模式；`recorded=false` ⇒ 显式「未记录」，**不得**把 0 读成 0% 投入。 */
function DeployedRate({ audit }: { audit: RunAuditState }) {
  if (audit.loading) {
    return (
      <div className="text-[11px] text-dim" data-testid="wb-metrics-deployed">
        资金投入率：加载中…
      </div>
    );
  }
  if (audit.error) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-up" data-testid="wb-audit-error">
        <span>审计加载失败：{audit.error}</span>
        <button
          type="button"
          onClick={audit.retry}
          data-testid="wb-audit-retry"
          className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt"
        >
          重试
        </button>
      </div>
    );
  }
  if (!audit.data) return null;
  return (
    <div className="text-[11px] text-dim" data-testid="wb-metrics-deployed">
      {audit.data.recorded
        ? `资金投入率（名义投入 / 初始资金）= ${fmtPct(audit.data.deployed_pct, 2)}；资金占用（含佣金）/ 初始资金 = ${fmtPct(audit.data.cash_consumed_pct, 2)}`
        : '资金投入率：未记录（该 run 无执行事实源）'}
    </div>
  );
}

/**
 * 交易明细 Tab 表上方的审计摘要行（ADR-026 §2.4-1）。
 * 成交笔数取**逐笔源** `/fills`（不用 `trades`：部分买入/加仓不进 trades）；
 * 回合数与强平合成数取审计派生（历史 run 也能辨识「胜率 100%」的真伪）。
 * `warnings` **非阻断**：仅信息性提示条，不影响提交/结果/既有响应。
 *
 * 口径消歧（2026-09-19 整改）：`/fills` 全口径（含期末强平 Sell）与审计 `batches_done`（**买入批数**）
 * 是两个不同的数（实例 run：43 笔成交合计 = 42 笔买入 + 1 笔期末强平卖出），故 L1 写明
 * 「成交合计 N 笔（含期末强平卖出 K 笔）」、L2 写明「买入成交 M 笔」，两个数**分别命名**。
 * 两个数都来自接口响应（N = `/fills` total，K = 审计 `round_trips_force_closed`，M = 审计 `batches_done`），
 * 前端不硬编码。
 */
function AuditSummary({ audit, fills }: { audit: RunAuditState; fills: RunFillsState }) {
  if (audit.loading) {
    return (
      <div className="text-[11px] text-dim" data-testid="wb-audit-loading">
        执行完整度审计加载中…
      </div>
    );
  }
  if (audit.error) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-up" data-testid="wb-audit-error">
        <span>审计加载失败：{audit.error}</span>
        <button
          type="button"
          onClick={audit.retry}
          data-testid="wb-audit-retry"
          className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt"
        >
          重试
        </button>
      </div>
    );
  }
  if (!audit.data) return null;
  const a = audit.data;
  // recorded=false = 事实源缺失 ⇒ 诚实留白（把 0 展示成 0% 投入比缺字段更危险）
  if (!a.recorded) {
    return (
      <div
        className="rounded-lg border border-line bg-panel2 px-2 py-1 text-[11px] text-dim"
        data-testid="wb-audit-unrecorded"
      >
        执行完整度审计：未记录（该 run 无 per_bar.orders/events 与 fills 事实源，故不展示投入率以免把缺失读成 0%）
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="wb-audit-summary">
      <div className="text-[11px] text-dim">
        {`${fills.recorded ? `成交合计 ${fills.total} 笔（含期末强平卖出 ${a.round_trips_force_closed} 笔）` : '成交合计 未记录（/fills 事实源缺失）'}｜回合 ${a.round_trips_total} 条（其中强平合成 ${a.round_trips_force_closed} 条）｜名义投入 ${fmtPct(a.deployed_pct, 2)}（分母 = 初始资金）`}
      </div>
      <div className="text-[11px] text-dim" data-testid="wb-audit-cash">
        {`现金消耗（含佣金）${fmtPct(a.cash_consumed_pct, 2)}｜计划批数 ${a.planned_tranches ?? '—'}｜可达轮次 ${a.reachable_batches}｜买入成交 ${a.batches_done} 笔｜未执行挂单 ${a.unexecuted_orders}${a.last_bar_unfilled ? '（末根 bar 无次 bar 可执行）' : ''}`}
      </div>
      {a.warnings.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="wb-audit-warnings">
          {a.warnings.map((w) => (
            <div
              key={w.code}
              role="status"
              data-testid={`wb-audit-warning-${w.code}`}
              className={`rounded-lg border px-2 py-1 text-[11px] ${
                w.severity === 'warn' ? 'border-up/40 bg-up/10 text-up' : 'border-line bg-panel2 text-dim'
              }`}
            >
              {w.severity === 'warn' ? '⚠ ' : 'ℹ '}
              {w.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ADR-029 Step 1.5 D15/E24：审计 **结构化 `exposure` 段**披露（`06-plan` §3.1，17 键）。
 *
 * 纪律：
 *  - `exposure === null`（非 `Exposure` / 无观测 / `recorded=false`）⇒ 显式「未记录」，**不得**把 0 当读数；
 *  - 两层 gap **名称相近、口径不同**：`max_target_gap` = 执行层（输出目标 vs 实际）、`max_intent_gap` = 意图层
 *    （声明意图 vs 实际），二者均为滞后一 bar 对齐；
 *  - 成本放大的**分母消歧**：`fee_pct` 分母是初始资金，`cost_amplification` 的分母是成交额。
 */
function ExposureAuditBlock({ audit }: { audit: RunAuditState }) {
  if (audit.loading) {
    return (
      <div className="text-dim" data-testid="wb-result-exposure-audit-loading">
        结构化曝光审计：加载中…
      </div>
    );
  }
  if (!audit.data) return null;
  const seg: WorkbenchExposureAudit | null | undefined = audit.data.exposure;
  if (!seg) {
    return (
      <div className="text-up" data-testid="wb-result-exposure-audit-unrecorded">
        结构化曝光审计（`exposure` 段）：未记录（非 Exposure 策略 / 无逐 bar 观测 / `recorded=false`）—— 不以 0
        冒充读数。
      </div>
    );
  }
  const deadzoneShare = seg.bars > 0 ? seg.deadzone_blocked_bars / seg.bars : null;
  const fmtOrUnrecorded = (v: number | null | undefined, digits = 2): string =>
    v == null ? '未记录' : fmtPct(v, digits);
  return (
    <div className="flex flex-col gap-0.5" data-testid="wb-result-exposure-audit">
      <div className="text-dim" data-testid="wb-result-exposure-audit-counters">
        {`结构化曝光审计（评估段 ${seg.bars} bar，不含预热）：挂单 ${seg.orders} 笔（${seg.orders_per_bar}/bar）｜死区拦截 ${seg.deadzone_blocked_bars} bar（占比 ${
          deadzoneShare === null ? '不可计算（bars=0）' : fmtPct(deadzoneShare, 1)
        }）｜限速 ${seg.rate_limited_bars} bar｜guard 夹取 ${seg.clamped_bars} bar｜跨卖出档 ${seg.sell_transition_bars} bar｜现金下调 ${seg.affordability_capped_bars} bar`}
      </div>
      <div className="text-dim" data-testid="wb-result-exposure-audit-gaps">
        {`执行层 max_target_gap=${fmtOrUnrecorded(seg.max_target_gap)}（bar ${seg.max_target_gap_bar ?? '未记录'}）= max_t |target_pct_t − current_pct_{t+1}|（**输出目标 vs 实际**，滞后一 bar 对齐）`}
        {`；意图层 max_intent_gap=${fmtOrUnrecorded(seg.max_intent_gap)}（bar ${
          seg.max_intent_gap_bar ?? '未记录'
        }）= max_t |intent_pct_t − current_pct_{t+1}|（**声明意图 vs 实际**）；unmet_intent_bars=${
          seg.unmet_intent_bars ?? '未记录'
        }（|intent_pct − target_pct| > deadzone_pct 的 bar 数：意图未被输出目标体现）`}
      </div>
      <div className="text-dim" data-testid="wb-result-exposure-audit-cost">
        {`成本：cost_amplification=${
          seg.cost_amplification == null ? '未记录' : `${seg.cost_amplification.toFixed(1)}×`
        }（= 实际佣金率 / 名义佣金率）；名义佣金率 nominal_fee_rate=${fmtOrUnrecorded(seg.nominal_fee_rate, 3)}；区间费用 fees=${fmtMoney(
          seg.fees,
        )}，占**初始资金** fee_pct=${fmtPct(seg.fee_pct, 2)}`}
        {'。'}消歧：`fee_pct` 的分母是**初始资金**，`cost_amplification` 的分子分母是**成交额**口径（两者不可混读）。
      </div>
    </div>
  );
}

/**
 * ADR-029 D7/§4-E10 + Step 1.5 D11/D12/D15：目标暴露披露（结果页 / 审计区）。
 *
 * - **目标侧**：`run.config.policy.Exposure`（run 快照 = 事实源，前端**不重算**）⇒ 端点 / ramp / guard 原文披露；
 * - **三层读数**（D11，本轮 F1「意图不可见」的修复）：`intent_pct`（意图）/ `target_pct`（输出目标）/
 *   `current_pct`（当前持仓）**同时**披露，并写明各自口径；
 * - **实测侧缺失** ⇒ 显式「未记录」并仅以既有事实（审计 `deployed_pct`）占位——禁把缺失读成 0（ADR-024 D10）；
 * - **`null` 处理（独立复验 R6 必查项）**：预热段的 `per_bar` **带键但值为 `null`** ⇒ 观测根数/末值读数/计数
 *   只统计**有真实读数**的 bar（`number`），否则会把预热计成观测（虚高）并把末值取成 `—`；
 * - 常驻口径注：**总分曲线是诊断量、不等于仓位**（D7）；非 `Exposure` run ⇒ **不渲染**（旧配置零回归）。
 */
function ExposureDisclosure({
  run,
  result,
  audit,
}: {
  run: WorkbenchRunView;
  result: WorkbenchRunResult;
  audit: RunAuditState;
}) {
  const policy = run.config.policy;
  if (!('Exposure' in policy)) return null;
  const ex = policy.Exposure;
  const targetText =
    'Fixed' in ex.target
      ? `Fixed pct=${fmtPct(ex.target.Fixed.pct)}（常数目标；score ≤ sell_threshold ⇒ 目标 0，净值占比）`
      : `ScoreMapped at_threshold_pct=${fmtPct(ex.target.ScoreMapped.at_threshold_pct)}（score=${run.config.buy_threshold} 起）→ at_full_pct=${fmtPct(ex.target.ScoreMapped.at_full_pct)}（score=100）；sell=${ex.target.ScoreMapped.sell}`;
  const rampText =
    'Immediate' in ex.ramp
      ? 'Immediate（当 bar 目标即全额；该变体**无** on_signal_break，恒取 Pause 语义）'
      : `RateCap pct_per_bar=${fmtPct(ex.ramp.RateCap.pct_per_bar)}（每 bar 允许变动金额 / 净值）；下行 down_pct_per_bar=${
          ex.ramp.RateCap.down_pct_per_bar == null
            ? `${fmtPct(ex.ramp.RateCap.pct_per_bar)}（缺省 ⇒ 对称）`
            : `${fmtPct(ex.ramp.RateCap.down_pct_per_bar)}${ex.ramp.RateCap.down_pct_per_bar === 0 ? '（0 = 下行不限速）' : ''}`
        }；信号中断 on_signal_break=${ex.ramp.RateCap.on_signal_break ?? 'Pause（缺省）'}`;
  const guardText = `max_pct=${fmtPct(ex.guard.max_pct)}（强制夹取，策略无权覆盖）/ min_pct=${fmtPct(ex.guard.min_pct)} / deadzone_pct=${fmtPct(ex.guard.deadzone_pct, 2)}（暴露比例差；是意图 gap 门、不是订单规模下限）${
    ex.guard.deadzone_min_notional == null
      ? ' / deadzone_min_notional=缺省（仅比例口径）'
      : ` / deadzone_min_notional=${fmtMoney(ex.guard.deadzone_min_notional)}（元；阈值 = max(deadzone_pct × equity, 该值)）`
  }`;

  /** 有**真实读数**的 bar：`null`（预热段 / 非 Exposure / 旧 run）**不计入**（R6/null 修复点）。 */
  const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  const rows = result.per_bar;
  const liveIdx = rows.reduce<number[]>((acc, r, i) => {
    if (isNum(r.target_pct) || isNum(r.current_pct)) acc.push(i);
    return acc;
  }, []);
  const lastLiveIdx = liveIdx.length > 0 ? liveIdx[liveIdx.length - 1]! : null;
  const lastLive = lastLiveIdx === null ? null : rows[lastLiveIdx]!;
  const liveRows = liveIdx.map((i) => rows[i]!);
  const deadzoneBars = liveRows.filter((r) => r.deadzone_blocked === true).length;
  const rateLimitedBars = liveRows.filter((r) => r.rate_limited === true).length;
  const clampedBars = liveRows.filter((r) => r.clamped_by_guard === true).length;
  const intentText = isNum(lastLive?.intent_pct)
    ? fmtPct(lastLive!.intent_pct)
    : '未记录（该 run 的 per_bar 无 intent_pct：预热段 / 旧 run，不以 0 冒充）';
  const unmetBars = audit.data?.exposure?.unmet_intent_bars ?? null;
  const auditFallback = audit.data
    ? audit.data.recorded
      ? `名义投入 ${fmtPct(audit.data.deployed_pct, 2)}（审计 deployed_pct，分母 = 初始资金）`
      : '审计未记录（该 run 无执行事实源）'
    : '审计加载中…';
  const rateCapBreak = 'RateCap' in ex.ramp ? (ex.ramp.RateCap.on_signal_break ?? 'Pause') : null;

  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-line bg-panel2 px-2 py-1 text-[11px]"
      /* BLOCKED-1/R26：结果侧**专属** testid（`wb-result-*`）—— 工作台选中 run 后
         `ConfigPanel` 与 `ResultView` **同时挂载**：两侧同名 id ⇒ e2e `getByTestId` strict mode
         双命中（用例 ③ 首条披露断言即红）。配置侧保留 `wb-exposure-*`（用例 ② 未选中 run 时断言）。 */
      data-testid="wb-result-exposure-disclosure"
    >
      <div className="text-dim" data-testid="wb-result-exposure-target">
        {`目标暴露（run 配置快照）：target=${targetText}；ramp=${rampText}；guard ${guardText}`}
      </div>
      {liveIdx.length > 0 ? (
        <>
          {/* D11：三层读数同时披露（意图 / 输出目标 / 当前持仓）—— F1「意图不可见」的修复 */}
          <div className="text-dim" data-testid="wb-result-exposure-readings">
            {`三层读数（末根有观测 bar，idx ${lastLiveIdx}）：意图 intent_pct=${intentText}｜输出目标 target_pct=${fmtPct(
              lastLive?.target_pct,
            )}｜当前持仓 current_pct=${fmtPct(lastLive?.current_pct)}`}
            <div>
              消歧：**意图** = 分数映射 + guard 夹取后**想持有**的水位（**死区/限速不影响它**）；**输出目标** = 本 bar
              实际下达的目标（死区命中 ⇒ 等于当前持仓）；**当前持仓** = **次 bar 开盘**成交后的实际持仓。
            </div>
          </div>
          <div className="text-dim" data-testid="wb-exposure-observed">
            {`逐 bar 观测（已加载 ${liveRows.length} 根，仅计**有真实读数**的 bar——预热段/非 Exposure 的 null 不计入）：` +
              `目标 ${fmtPct(lastLive?.target_pct)}｜当前 ${fmtPct(lastLive?.current_pct)}｜死区拦截 ${deadzoneBars} bar｜限速 ${rateLimitedBars} bar｜guard 夹取 ${clampedBars} bar`}
          </div>
        </>
      ) : (
        <div className="text-up" data-testid="wb-exposure-unrecorded">
          {`逐 bar 目标/实际暴露观测：未记录（该 run 的 per_bar 未携带 target_pct/current_pct 读数，或仅有预热段 null，不以 0 冒充）。既有事实：${auditFallback}`}
        </div>
      )}
      {/* D12：信号中断语义（`on_signal_break`）—— 「停在半途」是 Pause 下的**契约行为**，必须写清 */}
      {rateCapBreak !== null && (
        <div className="text-amber-300/80" data-testid="wb-result-exposure-break-note">
          {`on_signal_break=${'RateCap' in ex.ramp && ex.ramp.RateCap.on_signal_break != null ? ex.ramp.RateCap.on_signal_break : 'Pause（缺省/未声明）'}：${
            rateCapBreak === 'Pause'
              ? `中立带（本 bar 无新声明）输出目标冻结在上一目标 ⇒ 未走完的路径会**停在半途**（契约行为，非缺陷）；未达成的意图由上行的 intent_pct 读数揭示${
                  unmetBars == null ? '' : `（审计 unmet_intent_bars=${unmetBars}）`
                }。要走到意图需把 on_signal_break 改为 Continue。`
              : '中立带继续朝**意图**推进（未走完的路径会在后续 bar 继续补完）。'
          }`}
        </div>
      )}
      <ExposureAuditBlock audit={audit} />
      <div className="text-dim" data-testid="wb-exposure-score-note">
        披露：总分曲线是诊断量、不等于仓位 —— 目标由聚合分映射、实际暴露由 ramp/guard 与成交共同决定。
      </div>
    </div>
  );
}

/**
 * 结果视图（ADR §13.5 布局定稿）：
 * K线+买卖标记（含硬止损 ⊗）/ 总分曲线（阈值线+三区着色）/ 各策略评分曲线（图例开关默认前 3）/
 * 净值+回撤 / Tab（交易明细 | 8项绩效 | 逐bar评分表 | 事件日志）。
 * 三态：未选中占位 / loading 骨架 / 错误+重试；失败 run 显示 error；非终态显示状态提示。
 */
export function ResultView({
  run,
  result,
  loading,
  error,
  onRetry,
  api,
  catalog,
  progressMap,
  onJump,
}: {
  run: WorkbenchRunView | null;
  result: WorkbenchRunResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  api: ApiClient;
  catalog: StrategyCatalogEntry[] | null;
  /** WS strategy_run_progress 增量（run_id → 进度），头部进度叠加覆盖 REST 行进度（与 RunList 同模式）。 */
  progressMap?: Record<string, { progress: number; barTs: string | null }>;
  /** ADR-028 D4：L1/L2 `[跳转]` 的事件出口（P5a 只派发；窗口状态机由 P5b 接入）。 */
  onJump?: (target: JumpTarget) => void;
}) {
  const [tab, setTab] = useState<TabKey>('trades');
  /** ADR-028 D4.1 ① + §2.9（D9）：focus 锚点 = **K 线视图**容器（跳转只在该视图内回到可见，不得动其他视图）。 */
  const klineWrapRef = useRef<HTMLDivElement>(null);
  /** ADR-028 §2.4c 第 2/3/5/6 项：结果页图表卡配置（指标 = 独立 key；本批不变）。
   *  **先于**布局 hook 求值：副图数决定 K 线视图的有效可读下限（299/329，D9-7/D9-13）。 */
  const chartCfg = useResultChartConfig();
  const subPaneCount = subPaneCountFor(chartCfg.indicators);
  /** ADR-028 §2.9（D9）③：三段视图比例 / 两条分隔条 / per-view 收起 / 记忆。 */
  const layout = useResultLayout({ subPaneCount });
  /**
   * ADR-028 §2.6 第 3 项（D6-7）＋ §2.9 第 5 项（D9-5）：
   * **曲线卡**高度仍走结果页独立 key（D4.2 有效，**勿删**）；**K 线卡高语义已删**
   * （`kline` 旧值仅作一次性只读迁移源 → 初始视图高，见 `resultLayout.readResultLayout`）。
   */
  const [cardHeights, setCardHeights] = useState<Record<ResultCardId, number | null>>(() => ({
    kline: null,
    aggregate: readCardHeight('aggregate'),
    slot: readCardHeight('slot'),
    equity: readCardHeight('equity'),
    position: readCardHeight('position'),
  }));
  const commitHeight = useCallback((id: ResultCardId, px: number | null) => {
    writeCardHeight(id, px);
    setCardHeights((prev) => ({ ...prev, [id]: px }));
  }, []);
  /** ADR-028 D4.1 ②：高亮目标（**精确到笔**：fillKey = `rt_seq:成交序号`）；null = 无高亮。 */
  const [highlight, setHighlight] = useState<{ key: string; rev: number } | null>(null);
  /** 高亮重放键（同一笔再次跳转须重开 3s 窗口）。 */
  const highlightRevRef = useRef(0);
  /** ADR-028 §2.7 第 5 项：focus 滚动**作用域收敛到上栏容器内**的可观测计数（页级 scrollIntoView 已废弃）。 */
  const [focusScrollRev, setFocusScrollRev] = useState(0);
  /** ADR-028 D4.1 ④：曲线视图竖线标记所在时点（Unix 秒）；保留到下一次跳转或「全览」。 */
  const [markerTs, setMarkerTs] = useState<number | null>(null);
  // ADR-028 D2：页面级共享窗口事实源（唯一；写入者 = kline 交互 / L1·L2 跳转 / 全览与历史回退）。
  // `totalBars` 由下面 `useRunSeries` 的 bars 总数回填（同一渲染帧内用 ref 传递，避免 hooks 循环依赖）。
  const totalBarsRef = useRef(0);
  /** run per_bar 的 ts（降级定义域用；同一渲染帧内由下面的 `useRunSeries` 回填 ⇒ 滞后 1 帧可接受）。 */
  const perBarRowsRef = useRef<Array<{ ts: number }> | null>(null);
  const fullFromTs = run ? Math.floor(Date.parse(run.from_ts) / 1000) : null;
  const fullToTs = run ? Math.floor(Date.parse(run.to_ts) / 1000) : null;
  const win = useResultWindow({
    runId: run?.id ?? null,
    fullFromTs: Number.isFinite(fullFromTs) ? fullFromTs : null,
    fullToTs: Number.isFinite(fullToTs) ? fullToTs : null,
    period: run?.period ?? null,
    totalBars: totalBarsRef.current,
    perBarRows: perBarRowsRef.current,
  });
  // ADR-024 P6：结果取数**单一入口**（曲线 /curve、明细 /bars 分页、成交 /fills；
  // legacy_single 从 `/result` 内联列同步派生 ⇒ 旧行为零回归）。
  // ADR-028 D3 + D2.1/D2.3-2：窗口 + **x 定义域**以同一请求对象注入（rev 单调）⇒ 数据/定义域原子切换。
  const series = useRunSeries({ api, run, result, request: win.request });
  totalBarsRef.current = series.bars.total || result?.per_bar.length || 0;
  perBarRowsRef.current = series.bars.rows;
  // ADR-026 §2.4：审计按 Tab **懒加载**（交易明细/8项绩效需要；逐bar/事件不请求；无结果 run 不请求）。
  const auditEnabled = (tab === 'trades' || tab === 'metrics') && run?.status === 'succeeded' && !!result;
  const audit = useRunAudit({ api, runId: run?.id ?? null, enabled: auditEnabled });

  /** L1/L2 `[跳转]`：先写窗口状态机（程序化写窗 + 断言），再向父层派发（P5a 已预留给与 5b 并行）。
   *  ADR-028 D4.1：同时完成 ①focus 滚动、②精确到笔的高亮、④曲线竖线标记。 */
  const handleJump = (t: JumpTarget) => {
    win.jumpTo(t);
    onJump?.(t);
    // ① focus（ADR-028 §2.9 D9-10 / D7 第 5 项）：**作用域收敛到 K 线视图容器内**。
    //    K 线视图不滚动（D9-4）⇒ 该操作在默认布局下为 no-op，但保留「回到可见」语义与可观测计数。
    const card = klineWrapRef.current;
    if (card) {
      const cRect = card.getBoundingClientRect();
      const vRect = card.parentElement ? card.parentElement.getBoundingClientRect() : cRect;
      card.parentElement && (card.parentElement.scrollTop = Math.max(0, card.parentElement.scrollTop + (cRect.top - vRect.top)));
      // 可观测：K 线视图内确实执行过 focus 滚动（旧契约 scrollIntoView 已被取代）
      setFocusScrollRev((r) => r + 1);
    }
    // ② 高亮：**只高亮被点击的那一笔**（按 rt_seq + 该回合成交序号 ⇒ `fillKey`，禁按 bar 粗定位）；
    //    L1 是区间跳转、无单笔目标 ⇒ 不残留上一笔高亮。
    if (t.level === 'L2') {
      highlightRevRef.current += 1;
      setHighlight({ key: makeFillKey(t.rt_seq, t.fill_index), rev: highlightRevRef.current });
    } else {
      setHighlight(null);
    }
    // ④ 曲线竖线：同一时点（L2 = 该笔成交 bar 的 ts；L1 = 回合开仓 ts）
    setMarkerTs(t.level === 'L2' ? t.ts : t.open_ts);
  };

  /** ADR-028 §2.4c 第 2/3/5/6 项：结果页图表卡配置（**指标** key 不变）。 */
  /** 四张**曲线卡**高度 API（D4.2 有效，D9 保留；K 线卡改由 K 线视图高度决定，见 D9-5）。 */
  const resizeOf = (id: ResultCardId, defaultPx: number) => {
    const b = cardBoundsFor({ viewportH: layout.viewportH, subPaneCount: 0, cardId: id });
    return {
      cardId: id,
      heightPx: cardHeights[id],
      onCommit: (px: number | null) => commitHeight(id, px),
      defaultPx,
      minPx: b.min,
      maxPx: b.max,
    };
  };
  const resizeAggregate = useCardResize(resizeOf('aggregate', 186));
  const resizeSlot = useCardResize(resizeOf('slot', 190));
  const resizeEquity = useCardResize(resizeOf('equity', 218));
  const resizePosition = useCardResize(resizeOf('position', 271));

  /** 「全览」：清窗口 + **清高亮与曲线竖线**（ADR-028 D4.1：保留到下一次跳转或点「全览」）。 */
  const handleReset = () => {
    win.reset();
    setHighlight(null);
    setMarkerTs(null);
  };

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-dim" data-testid="wb-result-empty">
        选择左侧已完成运行查看结果（或勾选 2-4 个运行进入对比）
      </div>
    );
  }

  // 头部进度叠加：WS progressMap 优先，REST 行进度兜底（与 RunList 行进度同口径）
  const progressPct = Math.round((progressMap?.[run.id]?.progress ?? run.progress) * 100);
  /** 明细内容就绪（= 结果就绪；未就绪时下栏仍存在并显式空态，§4）。 */
  const readyForDetail = !loading && !error && run.status === 'succeeded' && result != null;

  return (
    // ADR-028 §2.9（D9，三视图拆分）：
    //  ① 页面级滚动**移除**（`wb-result` 不滚动）⇒ 三视图各自内部滚动（D9-4）；
    //  ② `wb-kline-view` = 窗口条 + 载入提示 + K 线卡（**常驻、不可收起**，x 域锚）；
    //  ③ `wb-indicator-view` = **仅**四张曲线卡（自身滚动）；④ `wb-detail-view` = 4 tab（自身滚动）；
    //  ⑤ 两条分隔条 + 两枚常驻恢复条；三段比例/收起/记忆见 `useResultLayout`。
    <div
      className="relative flex h-full min-h-0 flex-col gap-2 p-3"
      data-testid="wb-result"
      data-view-ratio-kline={layout.ratios.kline.toFixed(4)}
      data-view-ratio-indicators={layout.ratios.indicators.toFixed(4)}
      data-view-ratio-detail={layout.ratios.detail.toFixed(4)}
      data-view-height-kline={layout.klinePx}
      data-view-height-indicators={layout.indicatorsPx}
      data-view-height-detail={layout.detailPx}
      data-view-collapsed-indicators={layout.collapsed.indicators ? 'true' : 'false'}
      data-view-collapsed-detail={layout.collapsed.detail ? 'true' : 'false'}
      data-view-available={layout.availablePx}
      data-view-clamped={layout.clamped ? 'true' : 'false'}
      data-view-compressed={layout.compressed ? 'true' : 'false'}
      data-view-splitter={SPLITTER_PX}
      data-kline-sub-pane-count={subPaneCount}
    >
      {/* 头部：run 概要 + 状态/错误 */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="text-sm text-txt" data-testid="wb-run-title">
          {run.name || run.id}
        </span>
        <span className="text-dim">
          {run.symbol} · {periodLabel(run.period)} · {STATUS_LABEL[run.status] ?? run.status} ·{' '}
          <span data-testid="wb-run-progress">进度 {progressPct}%</span>
        </span>
      </div>
      {run.status === 'failed' && (
        <div className="rounded-lg border border-up/40 bg-up/10 px-2 py-1 text-xs text-up" role="alert" data-testid="wb-run-error">
          运行失败：{run.error ?? '未知错误'}
        </div>
      )}
      {/* D9-7：三段可读下限不可同时满足（或默认比例低于下限）⇒ **显式披露**（禁静默）。
          绝对定位（不占布局高）⇒ K 线视图几何恒等式与「可用高 = 视口 − 132」不随披露状态漂移。 */}
      {layout.disclosure && (
        <div
          className="absolute right-3 top-1 z-30 max-w-[36rem] rounded border border-amber-400/40 bg-panel/95 px-2 py-0.5 text-[10px] text-amber-300"
          data-testid="wb-view-clamp-note"
          role="status"
        >
          {layout.disclosure}
        </div>
      )}

      <div ref={layout.splitRef} data-testid="wb-result-split" className="flex min-h-0 flex-1 flex-col gap-1">
        {/* ── ① K 线视图（**常驻、不可收起**；D9-1/D9-2；focus 作用域收敛于此） ──
            内部固定占用 60px（窗口控制条 34 + 载入提示 18 + gap 8）⇒ `卡高 = 视图高 − 60`（D9-8 恒等式） */}
        <section
          ref={klineWrapRef}
          data-testid="wb-kline-view"
          data-view="kline"
          data-view-height={layout.klinePx}
          data-focus-scroll={focusScrollRev}
          data-marker-ts={markerTs ?? ''}
          style={{ height: `${layout.klinePx}px` }}
          className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        >
          {error ? (
            <div className="flex items-center gap-3 text-xs text-up" data-testid="wb-result-error">
              <span>结果加载失败：{error}</span>
              <button type="button" onClick={onRetry} className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt">
                重试
              </button>
            </div>
          ) : loading ? (
            <div className="flex h-40 items-center justify-center" data-testid="wb-result-skeleton">
              <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
            </div>
          ) : run.status === 'succeeded' && result ? (
            <>
              {/* ADR-028 D2/D4：窗口控制条（全览 + 历史回退 + 当前窗口观测）—— 固定 34px（D9-8 恒等式项） */}
              <div
                className="flex h-[34px] shrink-0 flex-nowrap items-center gap-2 overflow-hidden rounded-lg border border-line bg-panel2 px-2 text-[11px] text-dim"
                data-testid="wb-window-bar"
              >
                <button
                  type="button"
                  onClick={handleReset}
                  data-testid="wb-window-reset"
                  className="shrink-0 rounded-lg border border-line px-2 py-0.5 hover:text-txt"
                >
                  全览
                </button>
                <button
                  type="button"
                  onClick={win.back}
                  disabled={!win.canBack}
                  data-testid="wb-window-back"
                  className="shrink-0 rounded-lg border border-line px-2 py-0.5 hover:text-txt disabled:opacity-40"
                >
                  回退
                </button>
                {/*
                  ADR-028 §2.11（D11 决策 4）：**买卖标记标签开关**（默认关 = 只显圆点）。
                  与指标/卡高同一结果页 key（`eestock.wb.result.chartConfig.v1`）⇒ 刷新后保持；
                  **禁**写看板配置。按钮固定 34px 行高内（不改变 D9-8 的 34px 恒等式）。
                */}
                <button
                  type="button"
                  onClick={chartCfg.toggleMarkerLabels}
                  data-testid="wb-marker-labels-toggle"
                  data-marker-labels={chartCfg.markerLabels ? 'on' : 'off'}
                  aria-pressed={chartCfg.markerLabels}
                  aria-label={`买卖标记标签（${chartCfg.markerLabels ? '开' : '关'}）`}
                  title="默认只显示买卖圆点（不遮挡 K 线）；开启后常显方向×数量标签；悬停仍可单笔看标签"
                  className="shrink-0 rounded-lg border border-line px-2 py-0.5 hover:text-txt"
                >
                  标记标签 {chartCfg.markerLabels ? '开' : '关'}
                </button>
                {/* 页面级窗口（**请求态**）：文本 + 机器可读 data-*（E2E 真渲染断言用） */}
                <span
                  data-testid="wb-window-state"
                  data-source={win.window?.source ?? 'full'}
                  data-rev={win.window?.rev ?? ''}
                  data-from-ts={win.window?.from_ts ?? ''}
                  data-to-ts={win.window?.to_ts ?? ''}
                  data-span-bars={win.window?.span_bars ?? ''}
                  className="shrink-0"
                >
                  {win.window
                    ? `窗口 [${win.window.from_ts}, ${win.window.to_ts}] · ${win.window.span_bars} 根 · 来源 ${win.window.source} · rev ${win.window.rev}`
                    : '全区间（未显式写窗）'}
                </span>
                {/**
                 * **真身探针**（ADR-028 §3.4 / F18；§2.10 D10 决策 3 拆分；§2.10.1 裁决 1 定口径）：
                 *  - `data-applied-*` = **申请回执**（写窗那一刻的一次性真身读回；越界被静默吞掉 ⇒ ok=false）；
                 *  - `data-live-*`    = **当前真身**（随 `onVisibleRangeChange` 的可见 bar 序列/引擎读回更新）。
                 * `data-ok` = **活体一致性** = 申请回执 ∧ 当期 rev ∧ **真身 == 生效值**
                 * （`applied.observed.bar_space`，**不**是 `requested`）∧ 可见域 == **写回后的**窗口域；
                 * 即：写窗成功**且其后未被改写**才算绿。旧口径把「写窗当时成功」当 `ok` ⇒ 16ms 后被重拟合亦为绿（假绿）。
                 * 「申请未被逐值兑现」（引擎校准如 L1 初选 12→11 / 全览 10→9；或不可达夹取）**不**改判 `ok`
                 * —— 它由 `wb-window-clamped` 独立披露（必含 requested/observed），以免真实缺陷信号被噪声淹没。
                 * 被改写的两类信号在 `data-live-reasons` 上（且文案与「校准/夹取」分开）：
                 * `bar-space-rewritten`（真身 ≠ 生效值）/ `domain-drift`（可见域偏离写回窗口域）。
                 */}
                <span
                  data-testid="wb-window-probe"
                  data-ok={String(win.liveOk)}
                  data-live-consistent={String(win.liveOk)}
                  data-live-rev={win.expectRev}
                  data-live-bar-space={win.live?.bar_space ?? ''}
                  data-live-from-ts={win.live?.from_ts ?? ''}
                  data-live-to-ts={win.live?.to_ts ?? ''}
                  data-live-from-idx={win.live?.from_idx ?? ''}
                  data-live-to-idx={win.live?.to_idx ?? ''}
                  data-live-bars={win.live?.bars ?? ''}
                  data-live-reasons={win.liveReasons.join(' | ')}
                  data-applied-ok={win.observed ? String(win.observed.ok) : ''}
                  data-applied-rev={win.observed?.rev ?? ''}
                  data-applied-requested-bar-space={win.observed?.requested_bar_space ?? ''}
                  data-applied-bar-space={win.observed?.observed?.bar_space ?? ''}
                  data-applied-from-idx={win.observed?.observed?.from_idx ?? ''}
                  data-applied-to-idx={win.observed?.observed?.to_idx ?? ''}
                  data-applied-from-ts={win.observed?.observed?.from_ts ?? ''}
                  data-applied-to-ts={win.observed?.observed?.to_ts ?? ''}
                  data-applied-error={win.observed?.error ?? ''}
                  data-applied-center-idx={win.observed?.observed?.center_idx ?? ''}
                  data-applied-center-ts={win.observed?.observed?.center_ts ?? ''}
                  data-applied-observed-center-idx={win.observed?.observed?.observed_center_idx ?? ''}
                  data-applied-observed-center-ts={win.observed?.observed?.observed_center_ts ?? ''}
                  data-applied-edge-clamped={win.observed?.observed?.edge_clamped == null ? '' : String(win.observed.observed.edge_clamped)}
                  /* 向后兼容别名（= 申请回执；既有规格/探针读它们 ⇒ 语义不变，禁把 live 值写进来混淆） */
                  data-rev={win.observed?.rev ?? ''}
                  data-requested-bar-space={win.observed?.requested_bar_space ?? ''}
                  data-bar-space={win.observed?.observed?.bar_space ?? ''}
                  data-from-idx={win.observed?.observed?.from_idx ?? ''}
                  data-to-idx={win.observed?.observed?.to_idx ?? ''}
                  data-from-ts={win.observed?.observed?.from_ts ?? ''}
                  data-to-ts={win.observed?.observed?.to_ts ?? ''}
                  data-error={win.observed?.error ?? ''}
                  data-center-idx={win.observed?.observed?.center_idx ?? ''}
                  data-center-ts={win.observed?.observed?.center_ts ?? ''}
                  data-observed-center-idx={win.observed?.observed?.observed_center_idx ?? ''}
                  data-observed-center-ts={win.observed?.observed?.observed_center_ts ?? ''}
                  data-edge-clamped={win.observed?.observed?.edge_clamped == null ? '' : String(win.observed.observed.edge_clamped)}
                  data-cmd-rev={win.command?.rev ?? ''}
                  data-cmd-from-ts={win.command?.from_ts ?? ''}
                  data-cmd-to-ts={win.command?.to_ts ?? ''}
                  data-cmd-span={win.command?.span_bars ?? ''}
                  data-cmd-center-ts={win.command?.center_ts ?? ''}
                  hidden
                />
                {win.applying && (
                  <span className="shrink-0 text-sky-300" data-testid="wb-window-applying">
                    跳转中…
                  </span>
                )}
                {win.applyError && (
                  <span className="shrink-0 text-up" role="alert" data-testid="wb-window-apply-error">
                    窗口应用失败：{win.applyError}
                  </span>
                )}
                {/* ADR-028 D2.3-1 ②：程序化写窗**被钳位**必须显式披露（禁「请求即发布」） */}
                {win.clampNote && (
                  <span className="shrink-0 text-amber-300" data-testid="wb-window-clamped">
                    {win.clampNote}
                  </span>
                )}
                {/* ADR-028 D2.3-3：全览的**物理上限**必须显式披露（显示 N / 共 M 根） */}
                {win.capNote && (
                  <span className="shrink-0 text-amber-300" data-testid="wb-window-cap">
                    {win.capNote}
                  </span>
                )}
                {/* ADR-028 D2.1 第 2/4 条：定义域**降级**必须显式标注（禁静默） */}
                {series.appliedDegraded && (
                  <span className="shrink-0 text-amber-300" data-testid="wb-axis-degraded">
                    {series.appliedXSource === 'per_bar'
                      ? '时间轴降级（run per_bar 索引）'
                      : '时间轴降级（ts 线性）'}
                  </span>
                )}
                <span className="shrink-0" data-testid="wb-window-history">{`可回退 ${win.historyDepth} 步（上限 20）`}</span>
              </div>
              {/*
                ADR-028 §9.8：窗口加载/应用状态 **恒常驻**（固定 18px）——「载入提示」在 D9 几何里
                属于 K 线视图的固定 60px（D9-8：34 + 18 + 8）；未写窗时显式标注「全区间」，
                不得因缺省而让 K 线视图高度改变（否则「卡高 = 视图高 − 60」恒等式随状态漂移）。
              */}
              <div className="h-[18px] shrink-0 overflow-hidden text-[11px] leading-[18px] text-dim" data-testid="wb-window-load-note">
                {win.window
                  ? series.windowLoading
                    ? `窗口加载中：[${win.window.from_ts}, ${win.window.to_ts}]（共享 ~200ms 节流，以最后一次为准）`
                    : series.windowError
                      ? `窗口取数失败：${series.windowError}；当前显示的是上一窗口数据（from ${series.windowApplied?.from_ts ?? '—'} 到 ${series.windowApplied?.to_ts ?? '—'}，非当前窗口）`
                      : series.windowApplied &&
                          series.windowApplied.from_ts === win.window.from_ts &&
                          series.windowApplied.to_ts === win.window.to_ts
                        ? `窗口已应用：[${series.windowApplied.from_ts}, ${series.windowApplied.to_ts}] rev ${series.windowApplied.rev}`
                        : '窗口待应用（等待取数）'
                  : '窗口：全区间（未显式写窗）'}
              </div>
              {/* ADR-028 §2.9（D9-5）：K 线卡 **h-full**（高度 = K 线视图高 − 60） */}
              <div data-testid="wb-kline-focus-anchor" className="mt-2 min-h-0 flex-1">
                <KlineResultChart
                  run={run}
                  fills={series.fills}
                  api={api}
                  onVisibleRangeChange={win.applyKlineRange}
                  windowCommand={win.command}
                  onWindowApplied={win.onApplied}
                  highlight={highlight}
                  indicators={chartCfg.indicators}
                  viewPx={layout.klinePx}
                  markerLabels={chartCfg.markerLabels}
                  toggleSlot={
                    /* 指标勾选 = 与看板**同一实现**（共享组件）；结果页配置独立 key（硬约束）。
                       aria-pressed + 稳定 testid ⇒ 真渲染规格可点、可断言。 */
                    <IndicatorToggles
                      indicators={chartCfg.indicators}
                      onToggle={chartCfg.toggleIndicator}
                      testIdPrefix="wb-indicator-toggle"
                    />
                  }
                />
              </div>
            </>
          ) : (
            /* 非终态/无结果：K 线视图内显示状态提示（其余视图仍存在），页面不滚动 */
            <div className="flex h-40 items-center justify-center text-xs text-dim" data-testid="wb-result-pending">
              {run.status === 'canceled'
                ? '运行已取消（无结果）'
                : run.status === 'failed'
                  ? '运行失败（无结果）'
                  : `运行${STATUS_LABEL[run.status] ?? run.status}…进度 ${progressPct}%`}
            </div>
          )}
        </section>

        {/* ── ② 分隔条 `K线↔指标`（收起指标时**原位**换成常驻恢复条，占据同一 12px 带） ── */}
        {layout.collapsed.indicators ? (
          <div {...layout.restoreProps('indicators')} className={`${layout.restoreProps('indicators').className} w-full`}>
            指标 ▲
          </div>
        ) : (
          <div {...layout.splitterProps('kline-indicators')} />
        )}

        {/* ── ③ 指标视图（**仅**四张曲线卡；自身滚动；D9-1/D9-4） ── */}
        {!layout.collapsed.indicators && (
          <section
            data-testid="wb-indicator-view"
            data-view="indicators"
            data-view-height={layout.indicatorsPx}
            style={{ height: `${layout.indicatorsPx}px` }}
            className="flex min-h-0 shrink-0 flex-col gap-2 overflow-auto"
          >
            {/* D9-9：指标视图**不得**引入横向内缩（padding/border）——四张曲线卡与 K 线卡必须同宽同左缘，
                否则同一根 bar 在两视图上的**屏幕像素**偏差会因容器内缩而变大（实测 15.3px > 2px 判据）。 */}
            <div
              data-testid="wb-indicator-view-header"
              className="sticky top-0 z-10 flex h-4 shrink-0 items-center gap-2 bg-panel bg-opacity-90 px-1 text-[10px] text-dim"
            >
              <span className="shrink-0">指标视图</span>
              <span className="flex-1" />
              {/* 指标**视图**的收起入口（D9-3）；K 线视图**无**收起入口（D9-2） */}
              <button
                type="button"
                onClick={() => layout.collapse('indicators')}
                data-testid="wb-indicator-collapse"
                data-collapse-view="indicators"
                aria-label="收起指标视图（其余视图按原比例分享其空间）"
                title="收起指标视图"
                className="rounded border border-line px-2 text-[10px] text-dim hover:text-txt"
              >
                指标 收起 ▾
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {series.curvesError && (
                <div className="flex items-center gap-2 text-[11px] text-up" data-testid="wb-series-error">
                  <span>曲线加载失败：{series.curvesError}</span>
                  <button
                    type="button"
                    onClick={series.reload}
                    className="rounded-lg border border-line px-3 py-0.5 text-dim hover:text-txt"
                  >
                    重试
                  </button>
                </div>
              )}
              {series.curvesLoading ? (
                <div
                  className="flex h-32 items-center justify-center rounded-lg border border-line bg-panel2 text-xs text-dim"
                  data-testid="wb-series-skeleton"
                >
                  曲线加载中（`/curve` 显式抽样）…
                </div>
              ) : (
                <>
                  {/* ADR-028 D2.1/D2.3-4：x 一律消费**已提交**的定义域（`series.appliedXDomain`）+ 共用绘图区
                      几何（`series.appliedPlot`）；`domain` 仅供 `data-x-domain` 标注与降级路径（E2E 冻结口径）。 */}
                  <AggregateScoreChart
                    perBar={series.perBar.points}
                    sampling={series.perBar}
                    buyThreshold={run.config.buy_threshold}
                    sellThreshold={run.config.sell_threshold}
                    domain={win.domain}
                    xDomain={series.appliedXDomain}
                    plot={series.appliedPlot}
                    markerTs={markerTs}
                    resize={resizeAggregate}
                  />
                  <SlotScoresChart
                    perBar={series.perBar.points}
                    sampling={series.perBar}
                    slots={run.config.slots}
                    catalog={catalog}
                    domain={win.domain}
                    xDomain={series.appliedXDomain}
                    plot={series.appliedPlot}
                    markerTs={markerTs}
                    resize={resizeSlot}
                  />
                  <EquityDrawdownChart
                    netValue={series.netValue.points}
                    drawdown={series.drawdown.points}
                    sampling={{ netValue: series.netValue, drawdown: series.drawdown }}
                    domain={win.domain}
                    xDomain={series.appliedXDomain}
                    plot={series.appliedPlot}
                    markerTs={markerTs}
                    resize={resizeEquity}
                  />
                  {/* ADR-028 D1：持仓比率视图（口径消歧三件套：position_ratio / ratio / deployed_pct / cash_consumed_pct 各带分母） */}
                  <PositionRatioChart
                    points={series.position.points}
                    sampling={series.position}
                    domain={win.domain}
                    xDomain={series.appliedXDomain}
                    plot={series.appliedPlot}
                    markerTs={markerTs}
                    resize={resizePosition}
                    cumulative={
                      audit.data
                        ? {
                            deployedPct: audit.data.deployed_pct,
                            cashConsumedPct: audit.data.cash_consumed_pct,
                            recorded: audit.data.recorded,
                          }
                        : null
                    }
                  />
                </>
              )}
            </div>
          </section>
        )}

        {/* ── ④ 分隔条 `指标↔明细`（收起明细时**原位**换成常驻恢复条） ── */}
        {layout.collapsed.detail ? (
          <div {...layout.restoreProps('detail')} className={`${layout.restoreProps('detail').className} w-full`}>
            明细 ▲
          </div>
        ) : (
          <div {...layout.splitterProps('indicators-detail')} />
        )}

        {/* ── ⑤ 明细视图（4 tab；自身滚动；D9-1） ── */}
        {!layout.collapsed.detail && (
          <div data-testid="wb-detail-view" data-view="detail" data-view-height={layout.detailPx} className="flex min-h-0 shrink-0 flex-col">
            <DetailPane
              tab={tab}
              onTabChange={setTab}
              heightPx={layout.detailPx}
              onCollapse={() => layout.collapse('detail')}
              content={{
                /* 1) L1 回合 + 2) L2 逐笔（默认 tab） */
                trades: readyForDetail ? (
                  <div className="flex flex-col gap-2">
                    <AuditSummary audit={audit} fills={series.fills} />
                    {/* ADR-029 D7：审计区的目标暴露披露（非 Exposure run 自行返回 null ⇒ 零回归） */}
                    <ExposureDisclosure run={run} result={result as WorkbenchRunResult} audit={audit} />
                    {/* ADR-027 D8/D10：L1 回合（默认一层）→ 展开按 rt_seq 懒加载 L2 + 逐回合对账告警 */}
                    <RoundTripsTable
                      state={series.roundTrips}
                      l2={series.l2}
                      ensureL2={series.ensureL2}
                      onLoadMore={series.loadMoreRoundTrips}
                      onJump={handleJump}
                      audit={audit}
                    />
                  </div>
                ) : (
                  <DetailEmpty />
                ),
                metrics: readyForDetail ? (
                  <div className="flex flex-col gap-2">
                    <ExposureDisclosure run={run} result={result as WorkbenchRunResult} audit={audit} />
                    <MetricsTable
                      result={result as WorkbenchRunResult}
                      audit={audit}
                      capitalBasis={audit.data?.capital_basis ?? run.config.initial_capital}
                    />
                  </div>
                ) : (
                  <DetailEmpty />
                ),
                /* 3) 逐 bar 明细 */
                perbar: readyForDetail ? (
                  <PerBarTable
                    bars={series.bars}
                    slotCount={run.config.slots.length}
                    onLoadMore={series.loadMore}
                    onJumpRange={series.jumpToRange}
                    onResetRange={series.resetRange}
                  />
                ) : (
                  <DetailEmpty />
                ),
                /* 4) 事件日志 */
                events: readyForDetail ? (
                  <EventLog
                    perBar={series.bars.rows}
                    total={series.bars.total}
                    hasMore={series.bars.hasMore}
                    loadingMore={series.bars.loadingMore}
                    onLoadMore={series.loadMore}
                    range={series.bars.range}
                  />
                ) : (
                  <DetailEmpty />
                ),
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** 明细数据未就绪/不可得时的**显式空态**（§4：下栏不因空数据消失）。 */
function DetailEmpty() {
  return (
    <div className="p-3 text-xs text-dim" data-testid="wb-detail-empty">
      明细尚未就绪（运行完成后展示回合与逐笔 / 逐 bar 明细 / 事件日志）
    </div>
  );
}
