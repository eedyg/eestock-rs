import { useMemo } from 'react';
import type { WorkbenchBarRecord } from '@/api/types';
/** 曲线绘图区几何（x）**唯一来源** = `./curveGeometry`（四张曲线共用；禁各自声明 PAD/W 常量）。
 *  别名导入 ⇒ 组件内既有算式（`W`/`PAD`）零改动，而常量本体只有一处。 */
import { CURVE_PAD as PAD, CURVE_W as W } from './curveGeometry';
import { CardTitle, type CardResizeApi } from './cardResize';
import {
  curveDomainAttr,
  downsample,
  lineFrom,
  mapLineByDomain,
  resolveCurveX,
  vlineX,
  type CurveXDomain,
} from './chartUtils';

const H = 160;

/** 曲线抽样标注（后端 `/curve` 的 `downsampled`/`original_bars`；ADR-024 D10 禁止隐式有损）。 */
export interface CurveSampling {
  downsampled: boolean;
  originalBars: number;
  /**
   * **ADR-028 D2.4**：被裁掉的 warmup 预热段根数（按 `ts` 判定，`useRunSeries` 计算）。
   * > 0 ⇒ 曲线只覆盖 run 的评估段 `[from_ts, to_ts]`，UI **必须**显式标注（禁静默有损）。
   */
  excludedWarmupBars?: number;
}

/**
 * 总分曲线（ADR §13.5）：聚合分 0-100 折线 + buy/sell 阈值虚线 + 三区着色
 * （≥buy 买入区绿 tint / 中间持有区 / ≤sell 卖出区红 tint）。
 *
 * ADR-024 P6：数据来自 `/curve?kind=per_bar`（**显式抽样**）；渲染时标注抽样点数与原始根数
 * （沿用既有「抽样 N 点」文案模式 + `original_bars`），禁止隐式有损（D10）。
 */
export function AggregateScoreChart({
  perBar,
  buyThreshold,
  sellThreshold,
  sampling,
  domain,
  xDomain,
  plot,
  markerTs,
  resize,
}: {
  perBar: WorkbenchBarRecord[];
  buyThreshold: number;
  sellThreshold: number;
  sampling?: CurveSampling;
  /** ADR-028 D2.1：共享窗口（Unix 秒）——`data-x-domain` 标注与**降级**路径用（页面一律传 xDomain）。 */
  domain?: { from_ts: number; to_ts: number } | null;
  /**
   * ADR-028 D2.1（**主路**）：x 定义域 = **bar 索引空间**（ts 经 K 线所绘制的同一 bar 序列查表得索引）。
   * `undefined` ⇒ 按 `domain` 走 ts 线性**降级**（组件级兜底）；`null` ⇒ 无定义域（不绘制，禁自造域）。
   */
  xDomain?: CurveXDomain | null;
  /** ADR-028 D2.3-4：与 K 线**共用的绘图区几何**（`viewBox` x 起点/宽度；null = 曲线独立几何）。 */
  plot?: { x0: number; w: number } | null;
  /** ADR-028 D4.1 ④：竖线标记时点（Unix 秒；跳转到该笔成交/回合时设置，全览时清）。 */
  markerTs?: number | null;
  /** ADR-028 §2.4c 第 3 项：卡片高度缩放 API（缺省 ⇒ 默认渲染，逐像素与修复前一致）。 */
  resize?: CardResizeApi;
}) {
  const pts = useMemo(
    () => downsample(perBar.map((r) => [r.ts, r.aggregate] as [number, number])),
    [perBar],
  );
  const y = (s: number) => PAD + (1 - s / 100) * (H - 2 * PAD);
  const xd = useMemo(() => resolveCurveX({ xDomain, domain }), [xDomain, domain]);
  const mapped = useMemo(() => mapLineByDomain(pts, xd, 0, 100, W, H, PAD), [pts, xd]);
  const line = useMemo(() => lineFrom(mapped.points), [mapped]);
  const viewX0 = plot ? plot.x0 : 0;
  const viewW = plot ? plot.w : W;
  const markX = vlineX(markerTs, xd, W, PAD);
  /** ADR-028 D2.4：评估段根数 = 服务端口径 − 被裁掉的预热段（预热段不计入曲线）。 */
  const warmupExcluded = sampling?.excludedWarmupBars ?? 0;
  const evaluatedBars = Math.max(0, (sampling?.originalBars ?? perBar.length) - warmupExcluded);

  return (
    <div
      ref={resize?.cardRef}
      style={resize?.cardStyle}
      className="relative flex flex-col rounded-lg border border-line bg-panel2 py-1"
      data-testid="wb-aggregate-chart"
      data-resizable="aggregate"
      // ADR-028 D2.1：x 轴**数据窗口**实测标注（E2E 冻结口径：各视图 == 共享窗口；无窗口 ⇒ 'data'）
      data-x-domain={curveDomainAttr({ xDomain: xd, domain })}
      // 映射方式标注（观测性：主路/降级/无域；与 `data-x-domain` 是两件事）
      data-x-mode={xd ? xd.mode : 'none'}
    >
      {/* 卡片标题：**双击复位高度**（ADR-028 §2.4c 第 3 项）；非受控态也渲染（标题即复位入口） */}
      <CardTitle cardId="aggregate" onReset={() => resize?.reset()} hint={resize?.active ? '双击复位高度' : null}>
        聚合总分曲线
      </CardTitle>
      <div className="min-h-0 flex-1">
      <svg
        viewBox={`${viewX0.toFixed(2)} 0 ${viewW.toFixed(2)} ${H}`}
        className={resize ? resize.svgClass('h-40 w-full') : 'h-40 w-full'}
        preserveAspectRatio="none"
        role="img"
        aria-label="总分曲线"
      >
        {/* 三区着色（x/width 跟随共用绘图区几何：viewBox 位移后不得再用绝对 0..W） */}
        <rect x={viewX0} y={y(100)} width={viewW} height={y(buyThreshold) - y(100)} fill="#00e0a4" opacity="0.07" data-testid="zone-buy" />
        <rect x={viewX0} y={y(buyThreshold)} width={viewW} height={y(sellThreshold) - y(buyThreshold)} fill="#8b93b0" opacity="0.04" data-testid="zone-hold" />
        <rect x={viewX0} y={y(sellThreshold)} width={viewW} height={y(0) - y(sellThreshold)} fill="#ff5c6c" opacity="0.07" data-testid="zone-sell" />
        {/* 阈值虚线 */}
        <line x1={viewX0} x2={viewX0 + viewW} y1={y(buyThreshold)} y2={y(buyThreshold)} stroke="#00e0a4" strokeDasharray="4 4" strokeWidth="0.8" data-testid="threshold-buy" />
        <line x1={viewX0} x2={viewX0 + viewW} y1={y(sellThreshold)} y2={y(sellThreshold)} stroke="#ff5c6c" strokeDasharray="4 4" strokeWidth="0.8" data-testid="threshold-sell" />
        <polyline points={line} fill="none" stroke="#38bdf8" strokeWidth="1.4" />
        {/* ADR-028 D4.1 ④：竖线标记（同共享定义域 ⇒ 各曲线视图同一时点同位）；保留到下一次跳转或「全览」 */}
        {markX != null && (
          <line
            data-testid="wb-vline"
            data-view="aggregate"
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
      </svg>
      </div>
      <div className="flex shrink-0 justify-between px-1 text-[10px] text-dim">
        <span>
          聚合总分 0-100（虚线 = 买入阈 {buyThreshold} / 卖出阈 {sellThreshold}；三区 = 买/持/卖）
          {/* ADR-029 D7：常驻口径披露——总分是**诊断量**，不等于仓位（避免“分数即仓位”误读） */}
          <span data-testid="wb-score-diagnostic-note" className="text-amber-300/70">
            {' '}· 诊断量：总分不等于仓位（ADR-029 D7）
          </span>
        </span>
        {mapped.unmatched > 0 && (
          <span className="text-up" data-testid="wb-curve-unmatched">
            · {mapped.unmatched} 点不在 K 线 bar 序列上（已剔除）
          </span>
        )}
        <span data-testid="wb-aggregate-sampling">
          评估段 共 {evaluatedBars} bar
          {warmupExcluded > 0 && (
            <span data-testid="wb-aggregate-warmup-note" className="text-amber-300/80">
              （预热段 {warmupExcluded} 根不计入）
            </span>
          )}
          {sampling?.downsampled
            ? `（服务端抽样 ${perBar.length} 点）`
            : pts.length < perBar.length
              ? `（抽样 ${pts.length} 点）`
              : ''}
        </span>
      </div>
      {resize && <div {...resize.handleProps} />}
    </div>
  );
}
