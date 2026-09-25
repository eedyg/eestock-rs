import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { fmtPct, fmtTs } from '@/features/backtest/format';
import { curveXs, type CurveXDomain } from './chartUtils';

/**
 * ADR-028 **D12（Y 轴刻度）+ D13（时刻取值）** 的**唯一共用实现**（09-plan §2/§3）。
 *
 * 三件事只在这里实现一次：刻度几何/渲染、十字线、读数（四张曲线卡复用，禁四份复制）：
 *  - **刻度生成** = 纯函数 `niceTicks`（见 `./axisTicks`，3–5 条、只标注现有 y 域、不外扩）；
 *  - **刻度/网格/十字线/读数渲染** = 本文件的 `<CurveReadoutFrame>`（**一个**共用组件）；
 *  - **y 映射** = {@link valueToY}，与 `chartUtils::mapLineByDomain` **同一式**
 *    （`y = height − pad − (v−min)/span × (height−2·pad)`）⇒ 刻度/读数与曲线不可能错位。
 *
 * ## 硬约束的落地方式（09-plan §1.2 / §2.1）
 * 1. **`preserveAspectRatio="none"` 下文字不得变形**：刻度文本画在 **HTML 绝对定位叠加层**
 *    （`wb-axis-ticks-{card}`），**不在**曲线 svg 内 ⇒ 卡片被横向拉伸时文本形状不变。
 *    网格线（无文字）留在 svg 内、与曲线同一 user unit 坐标系、且是 `svg` 的**第一个**子元素
 *    ⇒ **最底层**（压不过曲线与既有阈值线/分区）。
 * 2. **不改值域**：本组件只接收调用方（各卡**既有**实现）算出的 `ticks` 与 `series` 原值，
 *    自身不回算/不 padding 任何域；x 与 y 都来自既有几何函数。
 * 3. **x 映射 = bar 索引空间**：取样点的 x 由 `curveXs`（冻结实现）给出；鼠标 → 最近**已加载原点**
 *    （{@link nearestAnchorIndex}），**禁插值**、**禁由 ts 反算 bar 索引**。
 * 4. **锁定态不持久化**：`useState` 会话内状态，无 storage 写入。
 *
 * 可观测（09-plan §2/§3）：刻度带 `wb-axis-ticks-{card}`、第 i 个标签 `wb-axis-tick-{card}-{i}`、
 * 网格组 `wb-axis-grid-{card}`、十字线 `wb-crosshair-{card}`、读数 `wb-readout-{card}`、锁定 `wb-readout-locked`。
 */

export type ReadoutCard = 'aggregate' | 'slot' | 'equity' | 'position';

/** 一个**已加载原始点**的读数样本（x/y = 与曲线同一 user unit 坐标系）。 */
export interface ReadoutSample {
  ts: number;
  x: number;
  y: number;
  /** 序列**原值**（禁插值/禁复算）。 */
  value: number;
}

/** 一条曲线的读数配置（label/颜色/原值格式化）。 */
export interface ReadoutSeries {
  label: string;
  color?: string;
  samples: ReadoutSample[];
  fmt: (value: number) => string;
}

/** 一条刻度的**布局结果**（值 + 文本 + 纵向位置）。 */
export interface AxisTickItem {
  value: number;
  label: string;
  /** 纵向位置（绘图区高度的百分比；HTML 叠加层用）。 */
  pct: number;
  /** 同一位置的 svg user unit y（网格线用）。 */
  y: number;
  /** 是否 0 刻度（含 0 的卡必须含 0 且视觉区别，09-plan §2 表格）。 */
  zero: boolean;
}

// ───────────────────────── 格式化（按卡固定口径，09-plan §2 表格） ─────────────────────────

/** 0–100 整数口径（聚合总分 / 各策略评分）：整数 ⇒ 整数文本；非整数 ⇒ 2 位小数（不四舍五入掉原值）。 */
export function fmtScore(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** 净值卡**现状量纲**（读码：`lastEquity.toFixed(2)`，无千分位、2 位小数）。 */
export function fmtEquityValue(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

/** 百分比 2 位（回撤 / 持仓比率；与 `fmtPct(v, 2)` 同口径）。 */
export function fmtTickPct(v: number): string {
  return fmtPct(v, 2);
}

// ───────────────────────── 几何纯函数 ─────────────────────────

/** 值 → svg user unit y（**与 `mapLineByDomain` 同式**；`span` 退化时与之一致取 1）。 */
export function valueToY(value: number, min: number, max: number, height: number, pad: number): number {
  const span = max - min || 1;
  return height - pad - ((value - min) / span) * (height - pad * 2);
}

/** 刻度值 + 域 + 几何 → 刻度布局（值/文本/pct/userY/zero）。 */
export function layoutTicks(args: {
  ticks: number[];
  min: number;
  max: number;
  height: number;
  pad: number;
  fmt: (v: number) => string;
}): AxisTickItem[] {
  const { ticks, min, max, height, pad, fmt } = args;
  return ticks.map((value) => {
    const y = valueToY(value, min, max, height, pad);
    return { value, label: fmt(value), y, pct: (y / height) * 100, zero: value === 0 };
  });
}

/** 指针像素 x → viewBox user unit x（`preserveAspectRatio="none"` 下为线性映射）。 */
export function clientXToUserX(args: {
  clientX: number;
  left: number;
  width: number;
  viewX0: number;
  viewW: number;
}): number | null {
  const { clientX, left, width, viewX0, viewW } = args;
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || !(width > 0)) return null;
  if (!Number.isFinite(viewW) || !(viewW > 0)) return null;
  return viewX0 + ((clientX - left) / width) * viewW;
}

/** 最近的**已加载点**索引（平手取索引小者）；空集 ⇒ −1。 */
export function nearestAnchorIndex(anchors: ReadonlyArray<{ x: number }>, userX: number): number {
  if (anchors.length === 0 || !Number.isFinite(userX)) return -1;
  let best = 0;
  let bestD = Math.abs(anchors[0]!.x - userX);
  for (let i = 1; i < anchors.length; i++) {
    const d = Math.abs(anchors[i]!.x - userX);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 同卡多线的**共用锚点**（按 ts 去重、按 x 升序）⇒ 一次悬停只取一个 bar，各线给各自该 bar 的原值。 */
export function anchorsOf(series: ReadonlyArray<ReadoutSeries>): Array<{ ts: number; x: number }> {
  const byTs = new Map<number, number>();
  for (const s of series) for (const p of s.samples) byTs.set(p.ts, p.x);
  return [...byTs.entries()].map(([ts, x]) => ({ ts, x })).sort((a, b) => a.x - b.x);
}

/**
 * `[ts,value]` 点集 → 读数样本（x 由 `curveXs` = 冻结 x 映射；y 由 {@link valueToY}）。
 * 无槽位的点**跳过**（与 `mapLineByDomain` 同口径：不钳位、不外推、不插值）。
 */
export function buildSamples(args: {
  pts: ReadonlyArray<[number, number]>;
  xd: CurveXDomain | null;
  min: number;
  max: number;
  width: number;
  height: number;
  pad: number;
}): { samples: ReadoutSample[]; unmatched: number } {
  const { pts, xd, min, max, width, height, pad } = args;
  const { xs, unmatched } = curveXs(
    pts.map((p) => p[0]),
    xd,
    width,
    pad,
  );
  const samples: ReadoutSample[] = [];
  for (let i = 0; i < pts.length; i++) {
    const x = xs[i];
    if (x == null) continue;
    const value = pts[i]![1];
    samples.push({ ts: pts[i]![0], x, y: valueToY(value, min, max, height, pad), value });
  }
  return { samples, unmatched };
}

// ───────────────────────── 共用组件 ─────────────────────────

interface ActiveReadout {
  idx: number;
  locked: boolean;
  /** 来源：`hover` 悬停（鼠标离开即收）、`key` 键盘（鼠标离开仍保留）。 */
  source: 'hover' | 'key';
}

export interface CurveReadoutFrameProps {
  card: ReadoutCard;
  /** 绘图区高度（user units；各卡自有 `H`）。 */
  height: number;
  /** `viewBox` x 起点/宽度（ADR-028 D2.3-4 共用绘图区几何）。 */
  viewX0: number;
  viewW: number;
  svgClassName: string;
  ariaLabel: string;
  ticks: AxisTickItem[];
  series: ReadoutSeries[];
  /** 曲线 svg 内容（由各卡提供；y 映射/x 映射保持各卡既有实现）。 */
  children: ReactNode;
  /** 额外 HTML 叠加内容（各卡既有角标/文案；渲染在读数层之下、不参与交互）。 */
  overlay?: ReactNode;
}

/**
 * 曲线卡绘图区**框架**：渲染被 `preserveAspectRatio="none"` 拉伸的 svg（网格 + 曲线内容）、
 * **不被拉伸的** HTML 刻度文本层、十字线/读数层，并承载 D13 交互（悬停/点击锁定/再点解除/
 * Esc/点击卡外解除/←→ 移动，键盘可达）。四张曲线卡共用此组件 ⇒ 交互与刻度只有一份实现。
 */
export function CurveReadoutFrame({
  card,
  height,
  viewX0,
  viewW,
  svgClassName,
  ariaLabel,
  ticks,
  series,
  children,
  overlay,
}: CurveReadoutFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<ActiveReadout | null>(null);
  const anchors = anchorsOf(series);
  const locked = active?.locked === true;
  const idx = active && anchors.length > 0 ? Math.max(0, Math.min(active.idx, anchors.length - 1)) : -1;
  const anchor = idx >= 0 ? anchors[idx]! : null;

  /** 指针 → 最近已加载点索引（盒子不可测/无点 ⇒ null；**不做** ts 反算）。 */
  const anchorIndexAt = (e: ReactMouseEvent<HTMLDivElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ux = clientXToUserX({ clientX: e.clientX, left: rect.left, width: rect.width, viewX0, viewW });
    if (ux == null) return null;
    const i = nearestAnchorIndex(anchors, ux);
    return i < 0 ? null : i;
  };

  // 锁定态：Esc / 点击卡外 ⇒ 解除（会话内状态，不持久化）
  useEffect(() => {
    if (!locked) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (target && rootRef.current && rootRef.current.contains(target)) return;
      setActive(null);
    };
    const onDocKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') setActive(null);
    };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onDocKey);
    };
  }, [locked]);

  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (locked) return; // 锁定后悬停不改读数
    const i = anchorIndexAt(e);
    if (i == null) return;
    setActive({ idx: i, locked: false, source: 'hover' });
  };

  const onMouseLeave = () => {
    setActive((a) => (a && (a.locked || a.source === 'key') ? a : null));
  };

  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const i = anchorIndexAt(e);
    if (i == null) return;
    setActive((a) => {
      if (a?.locked && a.idx === i) return null; // 再点同点 ⇒ 解除
      return { idx: i, locked: true, source: 'hover' };
    });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (dir === 0 || anchors.length === 0) return;
    e.preventDefault();
    setActive((a) => {
      const cur = a ? a.idx : dir > 0 ? -1 : anchors.length;
      const next = Math.max(0, Math.min(anchors.length - 1, cur + dir));
      return { idx: next, locked: a?.locked ?? false, source: 'key' };
    });
  };

  const xPct = anchor ? Math.max(0, Math.min(100, ((anchor.x - viewX0) / viewW) * 100)) : 0;
  const rows = anchor
    ? series.map((s) => {
        const hit = s.samples.find((p) => p.ts === anchor.ts);
        return { label: s.label, color: s.color, text: hit ? s.fmt(hit.value) : '—', y: hit?.y };
      })
    : [];

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      className="relative isolate min-h-0 flex-1 outline-none"
      data-testid={`wb-readout-frame-${card}`}
      data-readout-locked={locked ? 'true' : 'false'}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <svg
        viewBox={`${viewX0.toFixed(2)} 0 ${viewW.toFixed(2)} ${height}`}
        preserveAspectRatio="none"
        className={svgClassName}
        role="img"
        aria-label={ariaLabel}
      >
        {/* 网格（**最底层**：svg 第一个子元素 ⇒ 压不过曲线/阈值线/分区）；与刻度同一 y（user unit） */}
        <g data-testid={`wb-axis-grid-${card}`}>
          {ticks.map((t, i) => (
            <line
              key={`grid-${i}`}
              data-testid={`wb-axis-grid-${card}-${i}`}
              data-zero={t.zero ? 'true' : 'false'}
              data-tick-value={String(t.value)}
              x1={viewX0}
              x2={viewX0 + viewW}
              y1={t.y}
              y2={t.y}
              stroke="#fff"
              strokeWidth={t.zero ? 0.8 : 0.5}
              opacity={t.zero ? 0.3 : 0.14}
            />
          ))}
        </g>
        {children}
      </svg>

      {/* 刻度文本层：**HTML 绝对定位叠加层**（不在被非等比拉伸的 svg 内 ⇒ 文字不变形） */}
      <div data-testid={`wb-axis-ticks-${card}`} className="pointer-events-none absolute inset-0 z-10">
        {ticks.map((t, i) => (
          <span
            key={`tick-${i}`}
            data-testid={`wb-axis-tick-${card}-${i}`}
            data-zero={t.zero ? 'true' : 'false'}
            data-tick-value={String(t.value)}
            className={`num absolute left-1 -translate-y-1/2 rounded-sm bg-[color-mix(in_srgb,var(--panel2)_70%,transparent)] px-0.5 text-[9px] leading-none ${
              t.zero ? 'text-txt/85' : 'text-dim'
            }`}
            style={{ top: `${t.pct}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>

      {/* 十字线（HTML ⇒ 不受非等比缩放影响）+ 取值点 */}
      {anchor && (
        <div
          data-testid={`wb-crosshair-${card}`}
          data-crosshair-ts={String(anchor.ts)}
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-amber-300/70"
          style={{ left: `${xPct}%` }}
        />
      )}
      {anchor &&
        rows.map((r, i) =>
          r.y == null ? null : (
            <div
              key={`dot-${i}`}
              data-testid={`wb-readout-dot-${card}-${i}`}
              className="pointer-events-none absolute z-10 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${xPct}%`, top: `${(r.y / height) * 100}%`, background: r.color ?? '#e5e7eb' }}
            />
          ),
        )}

      {/* 读数（悬停/锁定；锁定态常驻 + 标记） */}
      {anchor && (
        <div
          data-testid={`wb-readout-${card}`}
          data-readout-ts={String(anchor.ts)}
          className="pointer-events-none absolute top-1 z-20 max-w-[70%] rounded border border-line bg-panel2 px-1.5 py-1 text-[10px] leading-tight text-txt shadow"
          style={{ left: `${xPct}%`, transform: xPct > 55 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
        >
          <div className="num text-dim">{fmtTs(anchor.ts)}</div>
          {rows.map((r, i) => (
            <div key={`row-${i}`} className="num flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: r.color ?? '#e5e7eb' }} />
              <span className="text-dim">{r.label}</span>
              <span data-testid={`wb-readout-value-${card}-${i}`}>{r.text}</span>
            </div>
          ))}
          {locked && (
            <div data-testid="wb-readout-locked" className="num text-amber-300/90">
              已锁定（再点同点 / Esc / 点卡外解除）
            </div>
          )}
        </div>
      )}

      {overlay}
    </div>
  );
}
