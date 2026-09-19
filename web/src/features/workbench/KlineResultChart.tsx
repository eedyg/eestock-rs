import { useEffect, useMemo } from 'react';
import type { ApiClient } from '@/api/client';
import type { WorkbenchRunFill, WorkbenchRunView } from '@/api/types';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { KlineChart, type KlineMarkerOverlay } from '@/features/dashboard/KlineChart';
import type { VisibleRangeTs, WindowApplyResult, WindowCommand } from '@/features/dashboard/klineWindowOps';
import { ScopedKlineFeed } from '@/features/backtest/ScopedKlineFeed';
import { periodCodeToPeriod } from '@/features/backtest/format';
import type { RunFillsState } from './useRunSeries';

/** 买卖标记颜色（与页面⑤弹窗同口径：B 红 / S 绿；硬止损 ⊗ 橙——不同图标不同色）。 */
const COLOR_BUY = '#ff5c6c';
const COLOR_SELL = '#00e0a4';
const COLOR_STOP = '#fb923c';

/** 成交明细 → K 线标记 overlay（ADR §13.5：K线+买卖标记，含硬止损触发点不同图标）。
 *
 * ADR-024 P6：数据源**必须是成交明细事实源**（后端 `kind='fills'` / `GET …/fills`），
 * 不用抽样 per_bar（抽样丢真实成交），也不用 `trades`（`TradeDetail` 仅在**完全平仓**时合成
 * ⇒ 部分买入/加仓（DCA、`position_pct<1`）与部分卖出**不进** `trades` ⇒ 会漏标记）。
 * 标记锚定 `fill.ts`（所在 bar），由 KlineChart 的 snapTsToBars 吸附到已加载 bar。 */
export function buildMarkers(fills: WorkbenchRunFill[]): KlineMarkerOverlay[] {
  return fills.map((f) => {
    const ts = f.ts * 1000; // overlay 锚定 Unix 毫秒
    if (f.reason === 'StopTrigger') {
      return { type: 'marker' as const, ts, text: '⊗', price: f.price, color: COLOR_STOP };
    }
    const buy = f.side === 'Buy';
    return {
      type: 'marker' as const,
      ts,
      text: buy ? 'B' : 'S',
      price: f.price,
      color: buy ? COLOR_BUY : COLOR_SELL,
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
        buffer: 2,
      }),
    [api, run, period],
  );
  useEffect(() => () => feed.dispose(), [feed]);
  const overlays = useMemo(() => buildMarkers(fills.rows), [fills.rows]);

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
        />
      </div>
    </div>
  );
}
