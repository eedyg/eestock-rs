import { useCallback, useRef, useState } from 'react';
import type { ApiClient } from '@/api/client';
import type { StrategyCatalogEntry, WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
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
import { cardBoundsFor, readCardHeight, writeCardHeight } from './resultCardHeights';
import { useResultLayout } from './useResultLayout';
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
  /** ADR-028 D4.1 ①：focus 锚点（跳转后把 K 线区域在上栏容器内滚回可见）。 */
  const klineWrapRef = useRef<HTMLDivElement>(null);
  /** ADR-028 §2.7（D7）①：**上栏**滚动容器（focus 滚动作用域收敛于此，整页不再滚动）。 */
  const chartPaneRef = useRef<HTMLDivElement>(null);
  /** ADR-028 §2.7（D7）③：下栏比例 / 折叠 / 记忆（默认 40% 视口高）。 */
  const layout = useResultLayout();
  /**
   * ADR-028 §2.6 第 3 项（D6-7）：卡片高度存**结果页独立 key**（`eestock.result.cardHeights.v1`）。
   * 旧实现存在结果页指标 key 的 `cardHeights` 字段里（同一 key 混放两类配置）——现拆分：
   * 高度走本 state（新 key），指标仍走 `resultChartConfig`（旧 key，语义不变）。
   */
  const [cardHeights, setCardHeights] = useState<Record<ResultCardId, number | null>>(() => ({
    kline: readCardHeight('kline'),
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
    // ① focus（ADR-028 §2.7 第 5 项）：**作用域收敛到上栏容器内**（不再 scrollIntoView 到「页面」——
    //    页面级滚动已移除；下栏**完全不动**，即 B1-1 口径）。
    const pane = chartPaneRef.current;
    const card = klineWrapRef.current;
    if (pane && card) {
      const pRect = pane.getBoundingClientRect();
      const cRect = card.getBoundingClientRect();
      pane.scrollTop = Math.max(0, pane.scrollTop + (cRect.top - pRect.top));
      // 可观测：上栏内确实发生过 focus 滚动（旧契约 scrollIntoView 已被取代）
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
  const chartCfg = useResultChartConfig();
  /** 四张**曲线卡**高度 API（K 线卡改由 `KlineResultChart` 内部按 pane 几何派生 bounds，见 D6-4）。 */
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
    // ADR-028 §2.7（D7，方案 B = 上下分层）：
    //  ① 页面级滚动**移除**（`wb-result` 不再 `overflow-auto`）⇒ 上下栏各自内部滚动（D7-1）；
    //  ② 上栏 `wb-chart-pane` = K 线 + 窗口条 + 四张曲线卡（自身滚动，保住全宽）；
    //  ③ 下栏 `wb-detail-pane` = 明细（自身滚动）+ `wb-detail-tabs`；
    //  ④ 比例/折叠/记忆见 `useResultLayout`（默认 40% 视口高；D7-3）。
    <div
      className="flex h-full min-h-0 flex-col gap-2 p-3"
      data-testid="wb-result"
      data-pane-collapsed={layout.collapsed ? 'true' : 'false'}
      data-pane-ratio={layout.ratio.toFixed(4)}
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

      <div ref={layout.splitRef} data-testid="wb-result-split" className="flex min-h-0 flex-1 flex-col gap-2">
        {/* ── 上栏（自身滚动；focus 作用域收敛于此） ── */}
        <div
          ref={chartPaneRef}
          data-testid="wb-chart-pane"
          data-focus-scroll={focusScrollRev}
          data-pane-height={layout.availablePx > 0 && !layout.collapsed ? layout.availablePx - layout.detailPx - 12 : ''}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto"
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
              {/* ADR-028 D4.1 ①：focus 锚点（跳转时在**上栏容器内**滚回可见，见 handleJump） */}
              <div ref={klineWrapRef} data-testid="wb-kline-focus-anchor" data-marker-ts={markerTs ?? ''}>
                <KlineResultChart
                  run={run}
                  fills={series.fills}
                  api={api}
                  onVisibleRangeChange={win.applyKlineRange}
                  windowCommand={win.command}
                  onWindowApplied={win.onApplied}
                  highlight={highlight}
                  indicators={chartCfg.indicators}
                  heightPx={cardHeights.kline}
                  onCommitHeight={(px) => commitHeight('kline', px)}
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
          {/* ADR-028 D2/D4：窗口控制条（全览 + 历史回退 + 当前窗口观测） */}
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel2 px-2 py-1 text-[11px] text-dim"
            data-testid="wb-window-bar"
          >
            <button
              type="button"
              onClick={handleReset}
              data-testid="wb-window-reset"
              className="rounded-lg border border-line px-2 py-0.5 hover:text-txt"
            >
              全览
            </button>
            <button
              type="button"
              onClick={win.back}
              disabled={!win.canBack}
              data-testid="wb-window-back"
              className="rounded-lg border border-line px-2 py-0.5 hover:text-txt disabled:opacity-40"
            >
              回退
            </button>
            {/* 页面级窗口（**请求态**）：文本 + 机器可读 data-*（E2E 真渲染断言用） */}
            <span
              data-testid="wb-window-state"
              data-source={win.window?.source ?? 'full'}
              data-rev={win.window?.rev ?? ''}
              data-from-ts={win.window?.from_ts ?? ''}
              data-to-ts={win.window?.to_ts ?? ''}
              data-span-bars={win.window?.span_bars ?? ''}
            >
              {win.window
                ? `窗口 [${win.window.from_ts}, ${win.window.to_ts}] · ${win.window.span_bars} 根 · 来源 ${win.window.source} · rev ${win.window.rev}`
                : '全区间（未显式写窗）'}
            </span>
            {/**
             * **真身回执探针**（ADR-028 §3.4 / F18）：值来自 K 线实例 `getBarSpace()` /
             * `getVisibleRange()` 的**实际读回**（`WindowApplyResult.observed`），**不是**请求态。
             * 若 `setBarSpace` 越界被引擎静默 return ⇒ `ok=false` / `error` 非空且 `observed=null`，
             * 真渲染 E2E 必须据此变红（禁止「没报错就算绿」）。
             */}
            <span
              data-testid="wb-window-probe"
              data-ok={win.observed ? String(win.observed.ok) : ''}
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
              <span className="text-sky-300" data-testid="wb-window-applying">
                跳转中…
              </span>
            )}
            {win.applyError && (
              <span className="text-up" role="alert" data-testid="wb-window-apply-error">
                窗口应用失败：{win.applyError}
              </span>
            )}
            {/* ADR-028 D2.3-1 ②：程序化写窗**被钳位**必须显式披露（禁「请求即发布」） */}
            {win.clampNote && (
              <span className="text-amber-300" data-testid="wb-window-clamped">
                {win.clampNote}
              </span>
            )}
            {/* ADR-028 D2.3-3：全览的**物理上限**必须显式披露（显示 N / 共 M 根） */}
            {win.capNote && (
              <span className="text-amber-300" data-testid="wb-window-cap">
                {win.capNote}
              </span>
            )}
            {/* ADR-028 D2.1 第 2/4 条：定义域**降级**必须显式标注（禁静默） */}
            {series.appliedDegraded && (
              <span className="text-amber-300" data-testid="wb-axis-degraded">
                {series.appliedXSource === 'per_bar'
                  ? '时间轴降级（run per_bar 索引）：K 线所绘制的 bar 序列不可得 ⇒ 与 K 线蜡烛位置不保证对齐'
                  : '时间轴降级（ts 线性，与 K 线可能存在缺口偏差）：K 线 bar 序列与 run per_bar 均不可得'}
              </span>
            )}
            <span data-testid="wb-window-history">{`可回退 ${win.historyDepth} 步（上限 20）`}</span>
          </div>
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
              {/* ADR-028 §9.8：窗口加载中显式标注；失败时不得用旧数据冒充当前窗口 */}
              {win.window && (
                <div className="text-[11px] text-dim" data-testid="wb-window-load-note">
                  {series.windowLoading
                    ? `窗口加载中：[${win.window.from_ts}, ${win.window.to_ts}]（共享 ~200ms 节流，以最后一次为准）`
                    : series.windowError
                      ? `窗口取数失败：${series.windowError}；当前显示的是上一窗口数据（from ${series.windowApplied?.from_ts ?? '—'} 到 ${series.windowApplied?.to_ts ?? '—'}，非当前窗口）`
                      : series.windowApplied &&
                          series.windowApplied.from_ts === win.window.from_ts &&
                          series.windowApplied.to_ts === win.window.to_ts
                        ? `窗口已应用：[${series.windowApplied.from_ts}, ${series.windowApplied.to_ts}] rev ${series.windowApplied.rev}`
                        : '窗口待应用（等待取数）'}
                </div>
              )}
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
            </>
          ) : (
            /* 非终态/无结果：上栏显示状态提示，下栏仍存在（显式空态），页面不滚动 */
            <div className="flex h-40 items-center justify-center text-xs text-dim" data-testid="wb-result-pending">
              {run.status === 'canceled'
                ? '运行已取消（无结果）'
                : run.status === 'failed'
                  ? '运行失败（无结果）'
                  : `运行${STATUS_LABEL[run.status] ?? run.status}…进度 ${progressPct}%`}
            </div>
          )}
        </div>
        {/* ── 下栏分隔条（拖拽改比例 + 双击复位 40%；折叠时隐藏但保留键盘可恢复入口） ── */}
        {!layout.collapsed && <div {...layout.splitterProps} />}
        {layout.collapsed ? (
          <div className="flex shrink-0 items-center justify-center" data-testid="wb-detail-collapsed-bar">
            <button
              type="button"
              data-testid="wb-detail-expand"
              onClick={layout.expand}
              aria-label="展开明细面板（恢复记忆比例）"
              className="rounded border border-line px-3 py-0.5 text-[10px] text-dim hover:text-txt"
            >
              明细已收起 ▲
            </button>
          </div>
        ) : (
          /* ── 下栏（明细独立视图；自身滚动；D7-1/D7-2） ── */
          <DetailPane
            tab={tab}
            onTabChange={setTab}
            heightPx={layout.detailPx}
            onCollapse={layout.collapse}
            content={{
              /* 1) L1 回合 + 2) L2 逐笔（默认 tab） */
              trades: readyForDetail ? (
                <div className="flex flex-col gap-2">
                  <AuditSummary audit={audit} fills={series.fills} />
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
                <MetricsTable
                  result={result as WorkbenchRunResult}
                  audit={audit}
                  capitalBasis={audit.data?.capital_basis ?? run.config.initial_capital}
                />
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
