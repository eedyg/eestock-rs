import { useEffect, useMemo } from 'react';
import type { ApiClient } from '@/api/client';
import type { WorkbenchRunFill, WorkbenchRunView } from '@/api/types';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { KlineChart, type KlineMarkerOverlay } from '@/features/dashboard/KlineChart';
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
}: {
  run: WorkbenchRunView;
  fills: RunFillsState;
  api: ApiClient;
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
          <span data-testid="wb-fills-note">
            成交 {overlays.length} 笔（精确源 /fills
            {fills.total > fills.rows.length ? `，已加载 ${fills.rows.length} / 共 ${fills.total}` : ''}）
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
        />
      </div>
    </div>
  );
}
