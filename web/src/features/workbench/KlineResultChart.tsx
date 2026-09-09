import { useEffect, useMemo } from 'react';
import type { ApiClient } from '@/api/client';
import type { WorkbenchBarRecord, WorkbenchRunResult, WorkbenchRunView } from '@/api/types';
import { DASHBOARD_DEFAULTS } from '@/layouts/DashboardGrid';
import { KlineChart, type KlineMarkerOverlay } from '@/features/dashboard/KlineChart';
import { ScopedKlineFeed } from '@/features/backtest/ScopedKlineFeed';
import { periodCodeToPeriod } from '@/features/backtest/format';

/** 买卖标记颜色（与页面⑤弹窗同口径：B 红 / S 绿；硬止损 ⊗ 橙——不同图标不同色）。 */
const COLOR_BUY = '#ff5c6c';
const COLOR_SELL = '#00e0a4';
const COLOR_STOP = '#fb923c';

/** per_bar 成交事件 → K 线标记 overlay（ADR §13.5：K线+买卖标记，含硬止损触发点不同图标）。
 *  Intrabar 止损成交在当 bar（rec.ts 即触发 bar）；Policy/ForceClose 成交在次 bar open——
 *  标记锚定事件所在 bar 的 ts，由 KlineChart 的 snapTsToBars 吸附到已加载 bar。 */
export function buildMarkers(perBar: WorkbenchBarRecord[]): KlineMarkerOverlay[] {
  const out: KlineMarkerOverlay[] = [];
  for (const rec of perBar) {
    for (const ev of rec.events) {
      if (ev.type !== 'fill') continue;
      const ts = rec.ts * 1000; // overlay 锚定 Unix 毫秒
      if (ev.reason === 'StopTrigger') {
        out.push({ type: 'marker', ts, text: '⊗', price: ev.price, color: COLOR_STOP });
      } else if (ev.side === 'Buy') {
        out.push({ type: 'marker', ts, text: 'B', price: ev.price, color: COLOR_BUY });
      } else {
        out.push({ type: 'marker', ts, text: 'S', price: ev.price, color: COLOR_SELL });
      }
    }
  }
  return out;
}

/**
 * K线 + 买卖标记（复用看板 `KlineChart` + 页面⑤ `ScopedKlineFeed` 区间取数）：
 * 区间 = run [from_ts, to_ts]（小 buffer）；markers 由 per_bar fill 事件生成
 * （B=买入 / S=卖出 / ⊗=硬止损触发强平）。
 */
export function KlineResultChart({
  run,
  result,
  api,
}: {
  run: WorkbenchRunView;
  result: WorkbenchRunResult;
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
  const overlays = useMemo(() => buildMarkers(result.per_bar), [result]);

  return (
    <div className="h-64 shrink-0 rounded-lg border border-line bg-panel2" data-testid="wb-kline-chart">
      <div className="flex items-center gap-3 px-2 pt-1 text-[10px] text-dim">
        <span>K线 {run.symbol}（{run.period}）</span>
        <span style={{ color: COLOR_BUY }}>B 买入</span>
        <span style={{ color: COLOR_SELL }}>S 卖出</span>
        <span style={{ color: COLOR_STOP }}>⊗ 硬止损触发</span>
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
