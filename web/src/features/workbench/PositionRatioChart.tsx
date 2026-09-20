import { useMemo } from 'react';
import type { WorkbenchPositionPoint } from '@/api/types';
import { fmtPct } from '@/features/backtest/format';
import {
  curveDomainAttr,
  downsample,
  extentOf,
  lineFrom,
  mapLineByDomain,
  resolveCurveX,
  vlineX,
  type CurveXDomain,
} from './chartUtils';

const W = 1000;
const H = 220;
const PAD = 10;

/** 三口径消歧所需的「区间累计」侧数值（ADR-026 §2.1；来自 `/audit`）。 */
export interface CumulativeRatioBasis {
  /** 区间累计敞口 / **初始资金**（ADR-026 `deployed_pct`）。 */
  deployedPct: number | null;
  /** 区间累计资金占用（含佣金）/ **初始资金**（ADR-026 `cash_consumed_pct`）。 */
  cashConsumedPct: number | null;
  /** `recorded=false` ⇒ 事实源缺失：**不得**把缺失读成 0%。 */
  recorded: boolean;
}

/**
 * 持仓比率视图（ADR-028 D1 / 02-spec §4.2；「与净值同风格的曲线视图」）。
 *
 * **口径强制消歧**（ADR-028 §2.1「冻结，禁止裸用持仓比率」）：同屏必须能区分三个不同的量，
 * 且**每个标签都写分母**：
 *  - `position_ratio` = **时点**持仓市值 / **时点**净值（本视图的曲线）；
 *  - `cash_ratio` = 1 − `position_ratio`（并列披露，免用户自算）；
 *  - `deployed_pct` = **区间累计**敞口 / **初始资金**（单值，**不得**与曲线互解）；
 *  - `cash_consumed_pct` = **区间累计**资金占用（含佣金）/ **初始资金**（单值）。
 *
 * x 轴定义域**必须**是共享窗口 `[from_ts, to_ts]`（D2.1：禁止用数据自身 min/max）⇒ 用 `mapLineByTs`。
 * 数据可抽样（ADR-028 D1）：`downsampled`/`original_bars` 显式标注（ADR-024 D10）。
 */
export function PositionRatioChart({
  points,
  sampling,
  domain,
  xDomain,
  plot,
  cumulative,
  markerTs,
}: {
  points: WorkbenchPositionPoint[];
  sampling?: { downsampled: boolean; originalBars: number };
  /** 共享窗口（Unix 秒）——`data-x-domain` 标注与**降级**路径用（页面一律传 xDomain）。 */
  domain: { from_ts: number; to_ts: number } | null;
  /** ADR-028 D2.1（**主路**）：x 定义域 = bar 索引空间；`undefined` ⇒ 按 `domain` 降级 ts 线性。 */
  xDomain?: CurveXDomain | null;
  /** ADR-028 D2.3-4：与 K 线共用的绘图区几何（`viewBox` x 起点/宽度）。 */
  plot?: { x0: number; w: number } | null;
  /** 区间累计口径（消歧用；`null` = 审计未加载）。 */
  cumulative: CumulativeRatioBasis | null;
  /** ADR-028 D4.1 ④：竖线标记时点（Unix 秒）。 */
  markerTs?: number | null;
}) {
  const series = useMemo(() => downsample(points), [points]);
  const xd = useMemo(() => resolveCurveX({ xDomain, domain }), [xDomain, domain]);

  const chart = useMemo(() => {
    if (series.length === 0) return null;
    const ratios = series.map((p) => p.position_ratio);
    const { min, max } = extentOf(ratios.concat([0, 1]));
    const pts = series.map((p) => [p.ts, p.position_ratio] as [number, number]);
    const mapped = mapLineByDomain(pts, xd, min, max, W, H, PAD);
    const last = series[series.length - 1]!;
    return { line: lineFrom(mapped.points), last, min, max, unmatched: mapped.unmatched };
  }, [series, xd]);
  const markX = vlineX(markerTs, xd, W, PAD);

  if (!chart) {
    return (
      <div
        className="flex h-40 items-center justify-center rounded-lg border border-line bg-panel2 text-xs text-dim"
        data-testid="wb-position-chart"
      >
        无持仓序列数据（`/curve?kind=position` 未返回点）
      </div>
    );
  }

  const last = chart.last;
  const cashRatio = 1 - last.position_ratio;
  return (
    <div
      className="relative rounded-lg border border-line bg-panel2 py-1"
      data-testid="wb-position-chart"
      // ADR-028 D2.1：x 轴**数据窗口**实测标注（E2E 冻结口径）
      data-x-domain={curveDomainAttr({ xDomain: xd, domain })}
      data-x-mode={xd ? xd.mode : 'none'}
      data-vline-ts={markerTs == null ? '' : String(markerTs)}
    >
      <svg
        viewBox={`${(plot ? plot.x0 : 0).toFixed(2)} 0 ${(plot ? plot.w : W).toFixed(2)} ${H}`}
        preserveAspectRatio="none"
        className="h-52 w-full"
        role="img"
        aria-label="持仓比率曲线"
      >
        <g opacity="0.2" stroke="#fff" strokeWidth="0.5">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={plot ? plot.x0 : 0} y1={H * f} x2={(plot ? plot.x0 : 0) + (plot ? plot.w : W)} y2={H * f} />
          ))}
        </g>
        <polyline points={chart.line} fill="none" stroke="#a78bfa" strokeWidth="2" data-testid="position-line" />
        {/* ADR-028 D4.1 ④：竖线标记（与曲线同定义域 ⇒ 各视图同一时点同位） */}
        {markX != null && (
          <line
            data-testid="wb-vline"
            data-view="position"
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
      <div className="absolute left-3 top-2 flex flex-col">
        <div className="num text-sm text-acc1" data-testid="wb-last-position-ratio">
          position_ratio {fmtPct(last.position_ratio, 2)}
        </div>
        <div className="num text-xs text-dim" data-testid="wb-last-cash-ratio">
          cash_ratio {fmtPct(cashRatio, 2)}
        </div>
        <div className="num text-[10px] text-dim" data-testid="wb-last-nav">
          nav {last.nav.toFixed(2)}（= 持仓市值 {last.position_value.toFixed(2)} + 现金 {last.cash.toFixed(2)}）
        </div>
      </div>
      <div className="absolute bottom-2 left-3 text-[10px] text-dim" data-testid="wb-position-sampling">
        持仓比率 共 {sampling?.originalBars ?? points.length} bar
        {chart.unmatched > 0 ? ` · ${chart.unmatched} 点不在 K 线 bar 序列上（已剔除）` : ''}
        {sampling?.downsampled ? `（服务端抽样 ${series.length} 点）` : ''}
      </div>
      {/* 口径消歧（ADR-028 §4.5：三口径标签各含分母说明，同屏可辨） */}
      <div className="px-1 pt-1 text-[10px] leading-relaxed text-dim" data-testid="wb-position-basis">
        <span data-testid="wb-basis-position-ratio">
          持仓比率 position_ratio（分母 = **时点净值** nav，即 持仓市值 / 时点净值）
        </span>
        {' ｜ '}
        <span data-testid="wb-basis-cash-ratio">现金比率 cash_ratio（分母 = **时点净值** nav，即 1 − position_ratio）</span>
        {' ｜ '}
        <span data-testid="wb-basis-deployed">
          deployed_pct（分母 = **初始资金**，区间**累计**敞口 / 初始资金）=
          {cumulative == null
            ? '审计未加载'
            : !cumulative.recorded
              ? '未记录'
              : cumulative.deployedPct == null
                ? '—'
                : fmtPct(cumulative.deployedPct, 2)}
        </span>
        {' ｜ '}
        <span data-testid="wb-basis-cash-consumed">
          cash_consumed_pct（分母 = **初始资金**，区间**累计**资金占用（含佣金）/ 初始资金）=
          {cumulative == null
            ? '审计未加载'
            : !cumulative.recorded
              ? '未记录'
              : cumulative.cashConsumedPct == null
                ? '—'
                : fmtPct(cumulative.cashConsumedPct, 2)}
        </span>
        ：三者**不同物**，不得互相解释（前者时点/时点，后两者区间累计/初始资金）。
      </div>
    </div>
  );
}
