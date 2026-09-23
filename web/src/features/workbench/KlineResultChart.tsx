import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '@/api/client';
import type { WorkbenchRunFill, WorkbenchRunView } from '@/api/types';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import type { IndicatorName } from '@/features/dashboard/Toolbar';
import { CardHeightPresets, useCardResize, type CardResizeApi } from './cardResize';
import {
  CARD_HEADER_FALLBACK_PX,
  DEFAULT_KLINE_PX,
  KLINE_CANDLE_MIN_PX,
  SUB_PANE_MIN_PX,
  SUB_PANE_TOTAL_MAX_PX,
  cardBoundsFor,
  clampCardPx,
  planKlinePanes,
} from './resultCardHeights';
import {
  HIGHLIGHT_DURATION_MS,
  KlineChart,
  findMarkerByFillKey,
  type KlineMarkerOverlay,
  type KlinePaneMetrics,
} from '@/features/dashboard/KlineChart';
import type { VisibleRangeTs, WindowApplyResult, WindowCommand } from '@/features/dashboard/klineWindowOps';
import { ScopedKlineFeed } from '@/features/backtest/ScopedKlineFeed';
import { periodCodeToPeriod } from '@/features/backtest/format';
import { fmtNum } from './roundTripAccum';
import type { RunFillsState } from './useRunSeries';

/** 买卖标记颜色（与页面⑤弹窗同口径：B 红 / S 绿；硬止损 ⊗ 橙——不同图标不同色）。 */
const COLOR_BUY = '#ff5c6c';
const COLOR_SELL = '#00e0a4';
const COLOR_STOP = '#fb923c';

/** ADR-028 D4.1 **判别身份键**：`rt_seq:回合成交序号`（均 0 基/后端原值直通）。
 *  L2 表的行下标（= 该回合内成交序号，按 `ts` 升序）与 `/fills` 事实源内的出现次序同序
 *  ⇒ 两侧可一一对应；**禁止**用 bar 粗定位。 */
export function makeFillKey(rtSeq: number, fillSeq: number): string {
  return `${rtSeq}:${fillSeq}`;
}

/** 成交明细 → K 线标记 overlay（ADR §13.5：K线+买卖标记，含硬止损触发点不同图标）。
 *
 * ADR-024 P6：数据源**必须是成交明细事实源**（后端 `kind='fills'` / `GET …/fills`），
 * 不用抽样 per_bar（抽样丢真实成交），也不用 `trades`（`TradeDetail` 仅在**完全平仓**时合成
 * ⇒ 部分买入/加仓（DCA、`position_pct<1`）与部分卖出**不进** `trades` ⇒ 会漏标记）。
 * 标记锚定 `fill.ts`（所在 bar），由 KlineChart 的 snapTsToBars 吸附到已加载 bar。
 *
 * ADR-028 D4.1（本波醒目化 + 可定位）：
 *  - `shape:'dot'` ⇒ 实心圆点 + 描边（买红 / 卖绿 / 硬止损橙）；
 *  - `label` = **价格×股数**文本（`B 8.417×118`，数字口径 = 页面既有 `fmtNum`）；
 *  - `stackIndex` = **同 bar 堆叠序**（同 ts 的第 k 笔 ⇒ 像素纵向偏移，**禁止相互遮盖**）；
 *  - `fillKey` = 判别身份键（点击 → 目标标记一一对应；精确到笔）。
 *  **不加跨点连线**（避免与蜡烛重叠成噪声）。 */
export function buildMarkers(fills: WorkbenchRunFill[]): KlineMarkerOverlay[] {
  const rtCounters = new Map<number, number>();
  const tsCounters = new Map<number, number>();
  return fills.map((f) => {
    const ts = f.ts * 1000; // overlay 锚定 Unix 毫秒
    const fillSeq = rtCounters.get(f.rt_seq) ?? 0;
    rtCounters.set(f.rt_seq, fillSeq + 1);
    // 同 bar（同一 `ts`）的第 k 笔 ⇒ 堆叠序（含不同 rt_seq 在同一 bar 的情形）
    const stackIndex = tsCounters.get(ts) ?? 0;
    tsCounters.set(ts, stackIndex + 1);
    const stop = f.reason === 'StopTrigger';
    const buy = f.side === 'Buy';
    const text = stop ? '⊗' : buy ? 'B' : 'S';
    const color = stop ? COLOR_STOP : buy ? COLOR_BUY : COLOR_SELL;
    return {
      type: 'marker' as const,
      ts,
      text,
      price: f.price,
      color,
      shape: 'dot' as const,
      // 价格×股数标签（数字格式与页面既有 fmtNum 口径一致：price 3 位 / qty 0 位）
      label: `${text} ${fmtNum(f.price, 'price')}×${fmtNum(f.qty, 'qty')}`,
      fillKey: makeFillKey(f.rt_seq, fillSeq),
      stackIndex,
    };
  });
}

/**
 * ADR-028 §7：结果页 K 线**必须**传放宽后的 `barSpaceLimit`（供宽窗口跳转；F18 的静默越界。
 * 放宽度：L2 跳转要求 120 根居中 ⇒ 在 520px 窗宽下需 barSpace ≈ 4，而看板默认上限 50
 * 会把「回合区间（可能仅数根）」所需的更大 barSpace 吞掉。**该放宽只作用于本实例**：
 * 看板基准图/宫格一律不传（ADR-020 严格）。
 */
export const RESULT_BAR_SPACE_LIMIT = { min: 1, max: 400 } as const;

/**
 * 副图指标（占用**独立 pane** 的那些；`ma` 叠在主图上、不占 pane）。
 * 与 `KlineChart.syncIndicators` 的 pane 创建口径一致：除 `ma` 外均 `createIndicator(value, true)`。
 */
const SUB_PANE_INDICATORS: readonly IndicatorName[] = ['vol', 'macd', 'kdj', 'boll', 'dcap'];

/** 结果页 K 线卡**默认高度**（ADR-028 §2.6 第 1 项；D6-1）。 */
export const KLINE_CARD_DEFAULT_PX = DEFAULT_KLINE_PX;

/** 视口高（挂载/`resize` 时更新；jsdom 兜底 800）。 */
function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  useEffect(() => {
    const onResize = () => setH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return h;
}

/** 元素高度实测（ResizeObserver；不可用 ⇒ 返回 0 = 未测量）。 */
function useMeasuredHeight<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [px, setPx] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setPx(Math.max(0, Math.round(el.getBoundingClientRect().height)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, px];
}

/**
 * K线 + 买卖标记（复用看板 `KlineChart` + 页面⑤ `ScopedKlineFeed` 区间取数）：
 * 区间 = run [from_ts, to_ts]（小 buffer）；markers 由**成交明细事实源**生成
 * （B=买入 / S=卖出 / ⊗=硬止损触发强平）。
 *
 * TODO(P6 未决项)：run 级 API 无 `/available_range` 读端点（P5 后端才出），
 * 故 K 线区间仍取 run [from_ts, to_ts]（既有路径，§5.2「K 线不变」）。
 */
export function KlineResultChart({
  run,
  fills,
  api,
  onVisibleRangeChange,
  windowCommand,
  onWindowApplied,
  highlight,
  onHighlightEnd,
  indicators = DASHBOARD_DEFAULTS.indicators,
  heightPx = null,
  onCommitHeight,
  toggleSlot,
  presetsEnabled = true,
  resize: resizeProp,
}: {
  run: WorkbenchRunView;
  fills: RunFillsState;
  api: ApiClient;
  /** ADR-028 D2：可见范围回调（页面级窗口事实源的 `kline` 写入者）。 */
  onVisibleRangeChange?: (r: VisibleRangeTs) => void;
  /** ADR-028 D4：程序化写窗命令（L1/L2 跳转 / 全览 / 历史回退）。 */
  windowCommand?: WindowCommand | null;
  /** 写窗回执（断言成功/失败；失败必须显式报错）。 */
  onWindowApplied?: (r: WindowApplyResult) => void;
  /** ADR-028 D4.1：跳转高亮请求（`key` = `fillKey`（精确到笔）；`rev` = 重放键）。 */
  highlight?: { key: string; rev: number } | null;
  /** 高亮 3s 回常态回调（可选）。 */
  onHighlightEnd?: () => void;
  /**
   * ADR-028 §2.4c 第 1 项：**副图指标勾选**（默认 = `DASHBOARD_DEFAULTS.indicators`，vol 开）。
   *  **受控 prop**：结果页传入自己的独立配置态（`resultChartConfig`），**不得**再直通看板配置
   *  （旧实现硬编码 `indicators={DASHBOARD_DEFAULTS.indicators}` ⇒ 既无入口、又存在「污染看板」风险）。
   */
  indicators?: Record<IndicatorName, boolean>;
  /** 指标勾选入口（结果页注入共享组件 `IndicatorToggles`；缺省 ⇒ 不渲染入口）。 */
  toggleSlot?: ReactNode;
  /** 已提交的卡片高度（结果页**独立**记忆 key；`null` = 默认 520）。 */
  heightPx?: number | null;
  /** 提交高度（`null` = 复位到默认 520）。 */
  onCommitHeight?: (px: number | null) => void;
  /** S/M/L 预设入口是否渲染（缺省 true）。 */
  presetsEnabled?: boolean;
  /** ADR-028 §2.4c 第 2 项：卡片高度缩放 API（缺省 ⇒ 组件**内部**按结果页口径自建）。 */
  resize?: CardResizeApi;
}) {
  const period = periodCodeToPeriod(run.period);
  const viewportH = useViewportHeight();
  const [headerRef, headerPx] = useMeasuredHeight<HTMLDivElement>();
  const [chartAreaRef, chartAreaPx] = useMeasuredHeight<HTMLDivElement>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paneMetrics, setPaneMetrics] = useState<KlinePaneMetrics | null>(null);
  /** 副图 pane 数（= 启用中的「独立 pane」指标数；`ma` 叠主图不占 pane）。 */
  const subPaneCount = useMemo(
    () => SUB_PANE_INDICATORS.filter((k) => indicators[k]).length,
    [indicators],
  );
  /** 主图/副图分配（ADR-028 §2.6 第 4 项；容器高实测注入）。 */
  const panePlan = useMemo(
    () => planKlinePanes({ containerPx: chartAreaPx, subPaneCount }),
    [chartAreaPx, subPaneCount],
  );
  /** 卡高上下限（**有效下限**口径：卡头实测 + 1 + 26 + 160 + 30×副图数）。 */
  const bounds = useMemo(
    () => cardBoundsFor({ viewportH, headerPx: headerPx > 0 ? headerPx : CARD_HEADER_FALLBACK_PX, subPaneCount }),
    [headerPx, subPaneCount, viewportH],
  );

  /** 内部自建 resize（结果页 K 线卡；缺省 bounds 由本组件派生 ⇒ 调用方无需知道 pane 几何）。 */
  const innerResize = useCardResize({
    cardId: 'kline',
    heightPx,
    onCommit: (px) => onCommitHeight?.(px),
    defaultPx: DEFAULT_KLINE_PX,
    minPx: bounds.min,
    maxPx: bounds.max,
  });
  const resize = resizeProp ?? innerResize;
  const cardPx = resize.heightPx ?? DEFAULT_KLINE_PX;
  const constraints = useMemo(
    () => ({
      candleMinPx: KLINE_CANDLE_MIN_PX,
      subPaneMinPx: SUB_PANE_MIN_PX,
      subPanePx: panePlan.subPanePx,
      subPaneTotalMaxPx: SUB_PANE_TOTAL_MAX_PX,
    }),
    [panePlan.subPanePx],
  );
  const onPaneMetrics = useCallback((m: KlinePaneMetrics) => setPaneMetrics(m), []);

  const feed = useMemo(
    () =>
      new ScopedKlineFeed({
        api,
        code: run.symbol,
        period,
        fromTs: Math.floor(Date.parse(run.from_ts) / 1000),
        toTs: Math.floor(Date.parse(run.to_ts) / 1000),
        // `buffer: 0`（2026-09-20 ADR-028 D2.3-4 修正）：结果页 K 线的 bar 域**必须**与 run 的 per_bar
        // 数据域一致（同一条 bar 序列）——否则缓冲 bar（实测 run 末端 06:58 ⇒ 缓冲拉到 07:00）会在两图
        // 间凭空多出一根「K 线有蜡烛、曲线无数据」的槽位（曲线右端固定少 1 根）。
        // 看板/弹窗的区间 feed 仍用其自身 buffer（本改动只作用于结果页实例）。
        buffer: 0,
      }),
    [api, run, period],
  );
  useEffect(() => () => feed.dispose(), [feed]);
  const overlays = useMemo(() => buildMarkers(fills.rows), [fills.rows]);
  /** ADR-028 D4.1 降级/无数据情形 ⇒ **显式**提示状态（不得静默无反应）。
   *
   * 2026-09-20（本波 R2）：**删除**原 `'loading'` 态与其「标记到位后自动补齐高亮」承诺文案。
   * 理由（可达性）：`bars / fills / round-trips` 由 `useRunSeries` 的 `Promise.allSettled` **同批原子提交**，
   * 成交明细未到位期间 L2 表本身不可达（tester 复验实测 `l2ReachableDuring=false`）⇒ 本组件拿不到
   * `highlight` 而处于 loading：该分支在 UI 上**不可达**，其「标记到位后自动补齐高亮」的承诺**无法被验证**（且事实上高亮
   * 窗口从点击时刻起算，数据晚到不会补画）⇒ 按「禁止不可验证承诺」删除分支与文案。
   * 若后续把三段数据改为**分片提交**，须以「可真实触发」的方式重新引入并配触发测试（不得只留文案）。 */
  const highlightState: 'idle' | 'ok' | 'unrecorded' | 'unmatched' = !highlight
    ? 'idle'
    : !fills.recorded && fills.rows.length === 0
      ? 'unrecorded'
      : findMarkerByFillKey(overlays, highlight.key)
        ? 'ok'
        : 'unmatched';
  const highlightRevRef = useRef(0);
  if (highlight) highlightRevRef.current = highlight.rev;

  return (
    // B1（2026-09-20）：卡片必须**自身**是 flex-col —— 头部图例/提示行**可换行增高**，图表区
    // `flex-1 min-h-0` 随之收缩。旧实现用 `h-[calc(100%-1.25rem)]`（对头部高度做了「恒 1 行」的固定假设）：
    // 新增高亮提示使头部由 1 行涨到 2 行时该高度**不收缩** ⇒ 图表容器溢出卡片 27px，
    // canvas 盖住下方窗口控制条（`elementFromPoint` 命中 canvas）⇒「全览 / 历史回退」真实点击超时。
    // 该布局**不依赖任何头部行数假设**。
    //
    // D6（2026-09-23）：卡高 = 记忆值 ?? 默认 520（inline 高度**恒**存在 ⇒ 默认态也是 520，不再依赖类名）；
    // 卡头**必须 ≤48px** ⇒ 头部只保留一行紧凑内容（指标勾选收进**浮层**，绝对定位不占布局高）；
    // 把手 12px 命中带 + `z-30`（层级优先于 canvas，ADR §2.6 第 6 项）。
    <div
      ref={resize.cardRef}
      style={{ height: `${Math.round(cardPx)}px`, flexShrink: 0 }}
      className="relative flex shrink-0 flex-col rounded-lg border border-line bg-panel2"
      data-testid="wb-kline-chart"
      data-resizable="kline"
      data-card-header-height={headerPx > 0 ? headerPx : undefined}
      data-kline-pane-height={paneMetrics?.candlePx ?? panePlan.candlePx}
      data-kline-sub-pane-count={subPaneCount}
      data-kline-card-bounds={`${bounds.min},${bounds.max}`}
    >
      <div
        ref={headerRef}
        data-testid="wb-kline-card-header"
        className="relative flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 pt-1 text-[10px] leading-4 text-dim"
      >
        {/* 卡片标题 = **双击复位高度**入口（ADR-028 §2.4c 第 2 项；复位到默认 520，D6-6） */}
        <span
          data-testid="wb-card-title-kline"
          data-card-title="kline"
          title="双击复位高度（默认 520）"
          onDoubleClick={() => resize.reset()}
          className="select-none"
        >
          K线 {run.symbol}（{run.period}）
        </span>
        <span style={{ color: COLOR_BUY }}>B 买入</span>
        <span style={{ color: COLOR_SELL }}>S 卖出</span>
        <span style={{ color: COLOR_STOP }}>⊗ 硬止损触发</span>
        {/* 覆盖范围**显式标注**（D9：禁止静默截断/静默缺数据）；长文本截断显示但 textContent 保持完整 */}
        {fills.loading ? (
          <span data-testid="wb-fills-note">成交明细加载中…</span>
        ) : !fills.recorded ? (
          <span className="text-up" data-testid="wb-fills-note">
            该运行未记录成交明细（P6 之前的分块 run）⇒ 标记可能不全
          </span>
        ) : (
          // ADR-027 D11：完整性契约 —— 总量与已加载量**常显**（旧实现在 > 首页时静默缺标记）
          <span className="min-w-0 max-w-[12rem] truncate" data-testid="wb-fills-note">
            成交合计 {fills.total} 笔（精确源 /fills，已加载 {fills.rows.length} / 共 {fills.total}
            {fills.truncated ? '，触达单次拉取护栏 ⇒ 标记不全' : ''}）
          </span>
        )}
        {fills.error && <span className="text-up" data-testid="wb-fills-error">成交明细加载失败：{fills.error}</span>}
        {/* D6-2：头部预设 S/M/L（值受 min/max 夹取后提交） */}
        {presetsEnabled && (
          <CardHeightPresets
            testIdPrefix="wb-kline-preset"
            activePx={cardPx}
            onPick={(px) => {
              const next = clampCardPx(px, bounds);
              if (next != null) resize.commit(next);
            }}
          />
        )}
        {/* D6-5 第 5 项：指标勾选**收进浮层**（不再占整行 40px）；多选与既有 testid 保留 */}
        {toggleSlot != null && (
          <button
            type="button"
            data-testid="wb-indicator-menu"
            aria-expanded={menuOpen}
            aria-haspopup="true"
            onClick={() => setMenuOpen((v) => !v)}
            className="h-4 rounded border border-line px-1.5 text-[10px] leading-4 text-dim hover:text-txt"
          >
            指标 {menuOpen ? '▴' : '▾'}
          </button>
        )}
        {toggleSlot != null && menuOpen && (
          <div
            data-testid="wb-indicator-popover"
            className="absolute right-2 top-full z-40 flex flex-wrap items-center gap-1 rounded border border-acc1/40 bg-panel/95 px-2 py-1 shadow-lg"
          >
            <span className="flex flex-wrap items-center gap-1" data-testid="wb-indicator-toggles">
              <span className="text-dim">指标</span>
              {toggleSlot}
            </span>
          </div>
        )}
        {/* ADR-028 D4.1：跳转高亮的**显式**状态（标记不可得 / 未记录 / 未命中 ⇒ 不得静默无反应） */}
        {highlight && highlightState !== 'idle' && (
          <span
            data-testid="wb-jump-highlight-note"
            data-state={highlightState}
            data-fill-key={highlight.key}
            className={highlightState === 'ok' ? 'text-sky-300' : 'text-amber-300'}
          >
            {highlightState === 'ok'
              ? `已高亮目标成交 ${highlight.key}（放大 + 描边脉冲，${HIGHLIGHT_DURATION_MS / 1000} 秒后回常态）`
              : highlightState === 'unrecorded'
                ? '该运行未记录成交明细（recorded=false）⇒ 无标记可高亮（窗口跳转仍已执行）'
                : `未在 K 线标记中找到目标成交 ${highlight.key}（L2 序号与 /fills 事实源不一致）⇒ 仅跳窗口，无高亮`}
          </span>
        )}
      </div>
      <div ref={chartAreaRef} className="min-h-0 flex-1">
        <KlineChart
          feed={feed}
          code={run.symbol}
          period={period}
          followLatest={false}
          indicators={indicators}
          onManualZoom={() => undefined}
          overlays={overlays}
          barSpaceLimit={RESULT_BAR_SPACE_LIMIT}
          onVisibleRangeChange={onVisibleRangeChange}
          windowCommand={windowCommand}
          onWindowApplied={onWindowApplied}
          highlightFillKey={highlight?.key ?? null}
          highlightRev={highlightRevRef.current}
          onHighlightEnd={onHighlightEnd}
          paneConstraints={constraints}
          onPaneMetrics={onPaneMetrics}
        />
      </div>
      {/* 卡片下边缘拖拽把手（自由调高；双击标题复位）。内层 `min-h-0 flex-1` 承接高度 ⇒
          klinecharts 的 ResizeObserver 自动重排（pane 高度比例与该实例视口保持）。 */}
      <div {...resize.handleProps} />
    </div>
  );
}
