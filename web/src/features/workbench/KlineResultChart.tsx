import { useEffect, useMemo, useRef } from 'react';
import type { ApiClient } from '@/api/client';
import type { WorkbenchRunFill, WorkbenchRunView } from '@/api/types';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import {
  HIGHLIGHT_DURATION_MS,
  KlineChart,
  findMarkerByFillKey,
  type KlineMarkerOverlay,
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
}) {
  const period = periodCodeToPeriod(run.period);
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
  /** ADR-028 D4.1 降级/无数据情形 ⇒ **显式**提示状态（不得静默无反应）。 */
  const highlightState: 'idle' | 'ok' | 'loading' | 'unrecorded' | 'unmatched' = !highlight
    ? 'idle'
    : fills.loading && fills.rows.length === 0
      ? 'loading'
      : !fills.recorded && fills.rows.length === 0
        ? 'unrecorded'
        : findMarkerByFillKey(overlays, highlight.key)
          ? 'ok'
          : 'unmatched';
  const highlightRevRef = useRef(0);
  if (highlight) highlightRevRef.current = highlight.rev;

  return (
    <div className="h-64 shrink-0 rounded-lg border border-line bg-panel2" data-testid="wb-kline-chart">
      <div className="flex flex-wrap items-center gap-3 px-2 pt-1 text-[10px] text-dim">
        <span>K线 {run.symbol}（{run.period}）</span>
        <span style={{ color: COLOR_BUY }}>B 买入</span>
        <span style={{ color: COLOR_SELL }}>S 卖出</span>
        <span style={{ color: COLOR_STOP }}>⊗ 硬止损触发</span>
        {/* 覆盖范围**显式标注**（D9：禁止静默截断/静默缺数据） */}
        {fills.loading ? (
          <span data-testid="wb-fills-note">成交明细加载中…</span>
        ) : !fills.recorded ? (
          <span className="text-up" data-testid="wb-fills-note">
            该运行未记录成交明细（P6 之前的分块 run）⇒ 标记可能不全
          </span>
        ) : (
          // ADR-027 D11：完整性契约 —— 总量与已加载量**常显**（旧实现在 > 首页时静默缺标记）
          <span data-testid="wb-fills-note">
            成交合计 {fills.total} 笔（精确源 /fills，已加载 {fills.rows.length} / 共 {fills.total}
            {fills.truncated ? '，触达单次拉取护栏 ⇒ 标记不全' : ''}）
          </span>
        )}
        {fills.error && <span className="text-up" data-testid="wb-fills-error">成交明细加载失败：{fills.error}</span>}
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
              : highlightState === 'loading'
                ? '成交明细加载中：标记不可得 ⇒ 暂无法高亮目标成交（标记就绪后自动补高亮）'
                : highlightState === 'unrecorded'
                  ? '该运行未记录成交明细（recorded=false）⇒ 无标记可高亮（窗口跳转仍已执行）'
                  : `未在 K 线标记中找到目标成交 ${highlight.key}（L2 序号与 /fills 事实源不一致）⇒ 仅跳窗口，无高亮`}
          </span>
        )}
      </div>
      <div className="h-[calc(100%-1.25rem)]">
        <KlineChart
          feed={feed}
          code={run.symbol}
          period={period}
          followLatest={false}
          indicators={DASHBOARD_DEFAULTS.indicators}
          onManualZoom={() => undefined}
          overlays={overlays}
          barSpaceLimit={RESULT_BAR_SPACE_LIMIT}
          onVisibleRangeChange={onVisibleRangeChange}
          windowCommand={windowCommand}
          onWindowApplied={onWindowApplied}
          highlightFillKey={highlight?.key ?? null}
          highlightRev={highlightRevRef.current}
          onHighlightEnd={onHighlightEnd}
        />
      </div>
    </div>
  );
}
