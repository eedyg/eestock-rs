import { useMemo } from 'react';
import { fmtPct } from '@/features/backtest/format';
/** 曲线绘图区几何（x）**唯一来源** = `./curveGeometry`（四张曲线共用；禁各自声明 PAD/W 常量）。
 *  **历史缺陷**：本图原为 `PAD = 10`，与聚合/各策略的 8 相差 2 user unit ⇒ 跨视图同一根 bar
 *  恒差 1.244px（吃掉 ≤2px 判据余量的 62%）。本波统一到 8（唯一同时满足「跨视图 ≤0.1px」与
 *  「冻结规格 adr028-axis-align-probe 全绿且禁改」的取值，见 `curveGeometry.ts` 的契约说明）。 */
import { CURVE_PAD as PAD, CURVE_W as W } from './curveGeometry';
import { CardTitle, type CardResizeApi } from './cardResize';
import {
  areaBelow,
  curveDomainAttr,
  downsample,
  extentOf,
  lineFrom,
  mapLineByDomain,
  resolveCurveX,
  vlineX,
  type CurveXDomain,
} from './chartUtils';
import { niceTicks } from './axisTicks';
/** ADR-028 D12/D13：刻度/十字线/读数 = **唯一共用实现**（09-plan §2.3 DRY 要求）。 */
import {
  CurveReadoutFrame,
  buildSamples,
  fmtEquityValue,
  fmtTickPct,
  layoutTicks,
  type AxisTickItem,
  type ReadoutSeries,
} from './curveReadout';

const H = 220;

/**
 * 净值 + 回撤双曲线（ADR §13.5；与页面⑤ ResultOverview 同风格：净值面积线 + 回撤着色区）。
 * ADR-024 P6：数据来自 `/curve?kind=net_value|drawdown`（**显式抽样**）；`downsampled`/`original_bars`
 * 在右下角显式标注（禁止静默有损，D10）。
 */
export function EquityDrawdownChart({
  netValue,
  drawdown,
  sampling,
  domain,
  xDomain,
  plot,
  markerTs,
  resize,
}: {
  netValue: Array<[number, number]>;
  drawdown: Array<[number, number]>;
  /** 后端抽样标注（`/curve` 的 `downsampled`/`original_bars`；ADR-024 D10）。 */
  sampling?: { netValue: { downsampled: boolean; originalBars: number }; drawdown: { downsampled: boolean; originalBars: number } };
  /** ADR-028 D2.1：共享窗口（Unix 秒）——`data-x-domain` 标注与**降级**路径用（页面一律传 xDomain）。 */
  domain?: { from_ts: number; to_ts: number } | null;
  /** ADR-028 D2.1（**主路**）：x 定义域 = bar 索引空间；`undefined` ⇒ 按 `domain` 降级 ts 线性。 */
  xDomain?: CurveXDomain | null;
  /** ADR-028 D2.3-4：与 K 线共用的绘图区几何（`viewBox` x 起点/宽度）。 */
  plot?: { x0: number; w: number } | null;
  /** ADR-028 D4.1 ④：竖线标记时点（Unix 秒）。 */
  markerTs?: number | null;
  /** ADR-028 §2.4c 第 3 项：卡片高度缩放 API（缺省 ⇒ 默认渲染，逐像素与修复前一致）。 */
  resize?: CardResizeApi;
}) {
  const series = useMemo(() => downsample(netValue), [netValue]);
  const dd = useMemo(() => downsample(drawdown), [drawdown]);
  const xd = resolveCurveX({ xDomain, domain });
  /**
   * D12/D13：刻度与读数样本。
   * **值域口径：与曲线完全一致** —— 仍用既有 `extentOf(equities)`（数据 min/max，**无 padding**）
   * 的同参数复算（纯函数 ⇒ 同值），不新增 padding、不强制含 0（09-plan §1.2-2 禁改 y 映射）。
   */
  const axis = useMemo<{ ticks: AxisTickItem[]; series: ReadoutSeries[] }>(() => {
    if (series.length === 0) return { ticks: [], series: [] };
    const equities = series.map((s) => s[1]);
    const { min, max } = extentOf(equities);
    const net = buildSamples({ pts: series, xd, min, max, width: W, height: H, pad: PAD });
    const ddSamples = buildSamples({ pts: dd, xd, min, max, width: W, height: H, pad: PAD });
    return {
      ticks: layoutTicks({ ticks: niceTicks(min, max, 4), min, max, height: H, pad: PAD, fmt: fmtEquityValue }),
      series: [
        { label: '净值', color: '#38bdf8', samples: net.samples, fmt: fmtEquityValue },
        { label: '回撤', color: '#ff5c6c', samples: ddSamples.samples, fmt: fmtTickPct },
      ],
    };
  }, [series, dd, xd]);

  if (series.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-line bg-panel2 text-xs text-dim" data-testid="wb-equity-chart">
        无净值数据
      </div>
    );
  }

  const equities = series.map((s) => s[1]);
  const lastEquity = equities[equities.length - 1] ?? 0;
  const initial = equities[0] ?? 0;
  const retPct = initial > 0 ? (lastEquity - initial) / initial : 0;
  const { min, max } = extentOf(equities);
  const ddMax = Math.max(...dd.map((d) => d[1]), 0);
  const eq = mapLineByDomain(series, xd, min, max, W, H, PAD);
  const eqPoints = eq.points;
  const viewX0 = plot ? plot.x0 : 0;
  const viewW = plot ? plot.w : W;
  const markX = vlineX(markerTs, xd, W, PAD);
  const depth = H * 0.35;

  return (
    <div
      ref={resize?.cardRef}
      style={resize?.cardStyle}
      className="relative flex flex-col rounded-lg border border-line bg-panel2 py-1"
      data-testid="wb-equity-chart"
      data-resizable="equity"
      // ADR-028 D2.1：x 轴**数据窗口**实测标注（E2E 冻结口径）
      data-x-domain={curveDomainAttr({ xDomain: xd, domain })}
      data-x-mode={xd ? xd.mode : 'none'}
    >
      <CardTitle cardId="equity" onReset={() => resize?.reset()} hint={resize?.active ? '双击复位高度' : null}>
        净值 + 回撤
      </CardTitle>
      <CurveReadoutFrame
        card="equity"
        height={H}
        viewX0={viewX0}
        viewW={viewW}
        svgClassName={resize ? resize.svgClass('h-52 w-full') : 'h-52 w-full'}
        ariaLabel="净值与回撤"
        ticks={axis.ticks}
        series={axis.series}
        overlay={
          <>
            <div className="pointer-events-none absolute left-3 top-2">
              <div className="num text-sm text-acc1" data-testid="wb-last-equity">
                净值 {lastEquity.toFixed(2)}
              </div>
              <div className={`num text-xs ${retPct >= 0 ? 'text-up' : 'text-down'}`} data-testid="wb-net-return">
                {retPct >= 0 ? '+' : ''}
                {fmtPct(retPct)}
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-dim">
              回撤（最大 −{fmtPct(ddMax)}，着色区间）
            </div>
            <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-dim" data-testid="wb-equity-sampling">
              净值 共 {sampling?.netValue.originalBars ?? netValue.length} bar
              {eq.unmatched > 0 ? ` · ${eq.unmatched} 点不在 K 线 bar 序列上（已剔除）` : ''}
              {sampling?.netValue.downsampled ? `（服务端抽样 ${series.length} 点）` : ''}
              {' · '}回撤 共 {sampling?.drawdown.originalBars ?? drawdown.length} bar
              {sampling?.drawdown.downsampled ? `（服务端抽样 ${dd.length} 点）` : ''}
            </div>
          </>
        }
      >
        <polygon points={areaBelow(eqPoints, H - PAD)} fill="#38bdf8" opacity="0.08" />
        <polyline points={lineFrom(eqPoints)} fill="none" stroke="#38bdf8" strokeWidth="2" data-testid="equity-line" />
        {dd.map((d, i) => {
          if (d[1] <= 0) return null;
          const x = eqPoints[i]?.x ?? PAD;
          const plotW = W - PAD * 2;
          const step = eqPoints.length > 1 ? plotW / (eqPoints.length - 1) : plotW;
          const rectW = Math.max(0.5, step - 1);
          return <rect key={`dd-${i}`} x={x} y={H - depth} width={rectW} height={depth} fill="#ff5c6c" opacity={Math.min(0.25, d[1] / (ddMax || 1))} />;
        })}
        {/* ADR-028 D4.1 ④：竖线标记（与曲线同定义域 ⇒ 各视图同一时点同位） */}
        {markX != null && (
          <line
            data-testid="wb-vline"
            data-view="equity"
            data-vline-ts={String(markerTs)}
            x1={markX}
            y1={0}
            x2={markX}
            y2={H}
            stroke="#facc15"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity="0.9"
          />
        )}
      </CurveReadoutFrame>
      {resize && <div {...resize.handleProps} />}
    </div>
  );
}
