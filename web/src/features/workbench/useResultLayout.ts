import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import {
  DEFAULT_VIEW_RATIOS,
  DRAG_CLAMP_DISCLOSURE,
  FROZEN_SHARE_SHRINK_DISCLOSURE,
  SPLITTER_PX,
  viewMinPx,
  availableFromSplitPx,
  availableForViewport,
  defaultLayoutStorage,
  dragRatiosFromViewPx,
  planThreeViews,
  RESULT_LAYOUT_NOTICE_STORAGE_KEY,
  readResultLayoutDetailed,
  toggleViewCollapsed,
  writeResultLayoutDetailed,
  type CollapsibleViewKey,
  type LayoutStorage,
  type ResultLayoutV2,
  type ThreeViewPlan,
  type ViewCollapsed,
  type ViewRatios,
} from './resultLayout';

/**
 * ADR-028 §2.9（**D9｜三视图**）—— 结果页三段视图的**状态层**（拖拽 / 双击复位 / per-view 收起 / 记忆）。
 *
 * 契约（唯一事实源 = ADR-028 §2.9 第 2/3/5/6/7/8 项）：
 *  - 两条分隔条（`wb-splitter-kline-indicators` / `wb-splitter-indicators-detail`）；
 *    **方向语义（2026-09-24 二次纠错后为准）= 鼠标向上 ⇒ 下方视图变高、上方视图变矮**、位移 **1:1**
 *    （同 §2.7-3/§2.8；与卡片把手的下沿符号相反，禁止互相套用）；
 *  - 双击各自复位该边界的默认比例；
 *  - **K 线视图常驻**（无收起 API）；指标/明细 per-view 收起/展开 + 记忆 + 常驻恢复条 props；
 *  - **可用高实测**：`可用 = split 容器实测高 − 40`（两条分隔条 + 4 条 gap）；未布局 ⇒ `视口高 − 132`；
 *  - **D9-13 必修**：视图高由 {@link planThreeViews} 在**每次渲染**按**当前副图数**重新夹取
 *    （`subPaneCount` 变化 ⇒ 有效下限 299↔329 变化 ⇒ 自动重夹），记忆路径不得绕过夹取。
 */
export type Boundary = 'kline-indicators' | 'indicators-detail';

export interface SplitterProps {
  'data-testid': string;
  role: 'separator';
  'aria-orientation': 'horizontal';
  'aria-label': string;
  tabIndex: number;
  style: CSSProperties;
  className: string;
  onMouseDown(e: ReactMouseEvent<HTMLDivElement>): void;
  onDoubleClick(): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void;
}

export interface RestoreBarProps {
  'data-testid': string;
  role: 'button';
  'aria-label': string;
  tabIndex: number;
  style: CSSProperties;
  className: string;
  onClick(): void;
  onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void;
}

export interface ResultLayoutApi {
  ratios: ViewRatios;
  collapsed: ViewCollapsed;
  /** 三段视图 px（已夹取；收起段 = 0）。 */
  klinePx: number;
  indicatorsPx: number;
  detailPx: number;
  /** 可用高（实测优先；未布局 ⇒ 视口高 − 132）。 */
  availablePx: number;
  /** 是否发生夹取（可读下限被施加）。 */
  clamped: boolean;
  /** 是否发生压缩（下限之和 > 可用高，已显式披露）。 */
  compressed: boolean;
  /** 显式披露文本（禁静默）。 */
  disclosure: string | null;
  viewportH: number;
  splitRef: RefObject<HTMLDivElement>;
  splitterProps(boundary: Boundary): SplitterProps;
  restoreProps(view: CollapsibleViewKey): RestoreBarProps;
  /** 收起某视图（K 线视图**不可收起**，故入参只有 indicators/detail）。 */
  collapse(view: CollapsibleViewKey): void;
  expand(view: CollapsibleViewKey): void;
  toggleView(view: CollapsibleViewKey): void;
  /** 双击复位某边界的默认比例（保持另一段不变）。 */
  resetBoundary(boundary: Boundary): void;
}

const SPLITTER_HOVER_CLASS = 'hover:bg-[color-mix(in_srgb,var(--acc1)_40%,transparent)]';
/** 键盘步进（可达性：分隔条与恢复条均可键盘操作）。 */
const KEY_STEP_PX = 16;

const BOUNDARY_LABEL: Record<Boundary, string> = {
  'kline-indicators': 'K 线视图 / 指标视图 分隔条',
  'indicators-detail': '指标视图 / 明细视图 分隔条',
};
const VIEW_LABEL: Record<CollapsibleViewKey, string> = { indicators: '指标', detail: '明细' };

export function useResultLayout(args: {
  storage?: LayoutStorage | null;
  /** **当前副图数**（K 线视图有效下限 299/329 分档；变化时自动重夹 —— D9-13）。 */
  subPaneCount?: number;
} = {}): ResultLayoutApi {
  const storage = args.storage === undefined ? defaultLayoutStorage() : args.storage;
  const subPaneCount = args.subPaneCount ?? 0;
  const splitRef = useRef<HTMLDivElement>(null);
  const [viewportH, setViewportH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  /**
   * 首帧诊断读（**一次**）：读路径只在**迁移回写**时归一（未迁移的原始态保持原样 ⇒ 各档既有读数不回退），
   * 并透出「收起段份额是否被收缩」⇒ 用于 `clamped` + 披露（第六轮裁决：归一必须完备且禁静默）。
   */
  const bootRef = useRef<ReturnType<typeof readResultLayoutDetailed> | null>(null);
  if (bootRef.current === null) {
    bootRef.current = readResultLayoutDetailed(storage, {
      viewportH,
      availablePx: availableForViewport(viewportH),
      mins: viewMinPx(subPaneCount),
    });
  }
  const [layout, setLayout] = useState<ResultLayoutV2>(bootRef.current.layout);
  /** 归一**收缩**了收起段份额 ⇒ 置位 `clamped` 并披露（下一次不收缩的写盘即清除）。 */
  const [writeShrinkNote, setWriteShrinkNote] = useState<string | null>(() => {
    if (bootRef.current?.frozenShrunk) return FROZEN_SHARE_SHRINK_DISCLOSURE;
    // 读-迁移可能发生在**被丢弃的渲染**里 ⇒ 事件标志会丢；以**瞬时通知键**兜底（跨挂载/刷新可复现）
    try {
      return storage?.getItem(RESULT_LAYOUT_NOTICE_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  });
  /** 用户交互 ⇒ 清除「收缩披露」（一次性事件已展示完毕）。 */
  const clearShrinkNotice = useCallback(() => {
    setWriteShrinkNote(null);
    try {
      storage?.removeItem?.(RESULT_LAYOUT_NOTICE_STORAGE_KEY);
    } catch {
      /* 清除失败不影响交互 */
    }
  }, [storage]);
  const [splitPx, setSplitPx] = useState(0);
  /** 写盘归一用的可用高（与渲染同口径：实测 split 优先，未布局 ⇒ 视口 − 132）。 */
  const availablePxNow = (splitPx > 0 ? availableFromSplitPx(splitPx) : 0) || availableForViewport(viewportH);
  /** 写盘上下文（可用高/可读下限）——每渲染刷新，供 `commit` 做**写入侧归一**。 */
  const writeCtxRef = useRef({ availablePx: 0, mins: viewMinPx(0) });
  writeCtxRef.current = { availablePx: availablePxNow, mins: viewMinPx(subPaneCount) };


  const commit = useCallback(
    (next: ResultLayoutV2) => {
      // 写盘前必过两道归一：①「非法段比例不得持久化」（BLOCKED-1）；②**存储 == 渲染**（第五轮裁决：
      // 存储态必须是生效态，否则夹取态下的 donor 结构会在「收起→拖→展开」路径上破坏可逆性）。
      // 返回值即**内存态 = 落盘态** ⇒ 刷新前后逐 px 一致。
      const ctx = writeCtxRef.current;
      const res = writeResultLayoutDetailed(next, storage, { availablePx: ctx.availablePx, mins: ctx.mins });
      setLayout(res.layout);
      setWriteShrinkNote(res.frozenShrunk ? FROZEN_SHARE_SHRINK_DISCLOSURE : null);
    },
    [storage],
  );

  // 可用高实测（split 容器）：`可用 = split 实测 − 40`（两条分隔条 + 4 条 gap）。
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const measure = () => setSplitPx(Math.max(0, Math.round(el.getBoundingClientRect().height)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const availablePx = availablePxNow;

  // **每次渲染**按当前 `subPaneCount` 重新计划（记忆值/比例一律再经夹取 ⇒ D9-13 修复）。
  const plan: ThreeViewPlan = useMemo(
    () =>
      planThreeViews({
        ratios: layout.ratios,
        viewportH,
        availablePx: availablePx > 0 ? availablePx : undefined,
        subPaneCount,
        collapsed: layout.collapsed,
      }),
    [availablePx, layout.collapsed, layout.ratios, subPaneCount, viewportH],
  );

  const viewPxOf = useCallback(
    (k: 'kline' | 'indicators' | 'detail') => (k === 'kline' ? plan.klinePx : k === 'indicators' ? plan.indicatorsPx : plan.detailPx),
    [plan.detailPx, plan.indicatorsPx, plan.klinePx],
  );

  const viewSpace = plan.availablePx > 0 ? plan.availablePx : availableForViewport(viewportH);
  const mins = viewMinPx(subPaneCount);
  /**
   * **收起段的已存比例之和**（= 不可分配份额 `S`）——传给拖拽层做「**真实比例**口径」夹取
   * （显示 px 下限 = `min_v / (1 − S)`）⇒ 展开永不触发重夹 ⇒ 收起→拖→展开**无条件**回收起前。
   */
  const collapsedRatioSum =
    (layout.collapsed.indicators ? layout.ratios.indicators : 0) +
    (layout.collapsed.detail ? layout.ratios.detail : 0);
  /** 拖拽起点 = 按下瞬间的**计划 px**（与 DOM 一致 ⇒ 1:1 不漂移）。 */
  const dragRef = useRef<{ startY: number; k: number; i: number; d: number; collapsedRatioSum: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** **拖拽路径的夹取披露**（BLOCKED-2：拖到下限 / 不可行支也必顶置位，禁只在默认分配路径置位）。 */
  const [dragClamped, setDragClamped] = useState(false);
  const boundaryRef = useRef<Boundary>('kline-indicators');
  const planRef = useRef({ k: 0, i: 0, d: 0, collapsed: layout.collapsed, collapsedRatioSum });
  planRef.current = {
    k: plan.klinePx,
    i: plan.indicatorsPx,
    d: plan.detailPx,
    collapsed: layout.collapsed,
    collapsedRatioSum,
  };
  const minsRef = useRef(mins);
  minsRef.current = mins;

  const onMouseDown = useCallback((boundary: Boundary, e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = planRef.current;
    clearShrinkNotice();
    dragRef.current = { startY: e.clientY, k: p.k, i: p.i, d: p.d, collapsedRatioSum: p.collapsedRatioSum };
    setDragging(true);
    void boundary;
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const outcome = dragRatiosFromViewPx({
        klinePx: d.k,
        indicatorsPx: d.i,
        detailPx: d.d,
        viewSpacePx: viewSpace,
        boundary: boundaryRef.current,
        dy: e.clientY - d.startY,
        mins: minsRef.current,
        collapsedRatioSum: d.collapsedRatioSum,
      });
      setDragClamped(outcome.clamped);
      commit({ ratios: outcome.ratios, collapsed: planRef.current.collapsed });
    };
    const up = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [commit, dragging, viewSpace]);

  const dragWithKeyboard = useCallback(
    (boundary: Boundary, dy: number) => {
      clearShrinkNotice();
      const outcome = dragRatiosFromViewPx({
        klinePx: viewPxOf('kline'),
        indicatorsPx: viewPxOf('indicators'),
        detailPx: viewPxOf('detail'),
        viewSpacePx: viewSpace,
        boundary,
        dy,
        mins: minsRef.current,
        collapsedRatioSum,
      });
      setDragClamped(outcome.clamped);
      commit({ ratios: outcome.ratios, collapsed: layout.collapsed });
    },
    [clearShrinkNotice, collapsedRatioSum, commit, layout.collapsed, viewPxOf, viewSpace],
  );

  const resetBoundary = useCallback(
    (boundary: Boundary) => {
      clearShrinkNotice();
      const k = viewPxOf('kline');
      const i = viewPxOf('indicators');
      const d = viewPxOf('detail');
      const next = { kline: k, indicators: i, detail: d };
      if (boundary === 'kline-indicators') {
        const total = k + i;
        const share = DEFAULT_VIEW_RATIOS.kline / (DEFAULT_VIEW_RATIOS.kline + DEFAULT_VIEW_RATIOS.indicators);
        next.kline = total * share;
        next.indicators = total * (1 - share);
      } else {
        const total = i + d;
        const share = DEFAULT_VIEW_RATIOS.indicators / (DEFAULT_VIEW_RATIOS.indicators + DEFAULT_VIEW_RATIOS.detail);
        next.indicators = total * share;
        next.detail = total * (1 - share);
      }
      const sum = next.kline + next.indicators + next.detail;
      if (!(sum > 0)) return;
      // 非拖拽提交（双击复位）⇒ 清除拖拽夹取披露（避免陈旧披露）
      setDragClamped(false);
      commit({
        ratios: { kline: next.kline / sum, indicators: next.indicators / sum, detail: next.detail / sum },
        collapsed: layout.collapsed,
      });
    },
    [clearShrinkNotice, commit, layout.collapsed, viewPxOf],
  );

  const collapse = useCallback(
    (view: CollapsibleViewKey) => {
      setDragClamped(false);
      clearShrinkNotice();
      commit({ ratios: layout.ratios, collapsed: { ...layout.collapsed, [view]: true } });
    },
    [commit, layout.collapsed, layout.ratios],
  );
  const expand = useCallback(
    (view: CollapsibleViewKey) => {
      setDragClamped(false);
      clearShrinkNotice();
      commit({ ratios: layout.ratios, collapsed: { ...layout.collapsed, [view]: false } });
    },
    [commit, layout.collapsed, layout.ratios],
  );
  const toggleView = useCallback(
    (view: CollapsibleViewKey) => {
      setDragClamped(false);
      clearShrinkNotice();
      commit({ ratios: layout.ratios, collapsed: toggleViewCollapsed(layout.collapsed, view) });
    },
    [clearShrinkNotice, commit, layout.collapsed, layout.ratios],
  );

  const splitterProps = useCallback(
    (boundary: Boundary): SplitterProps => ({
      'data-testid': `wb-splitter-${boundary}`,
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': `${BOUNDARY_LABEL[boundary]}（向上拖 ⇒ 下方视图变高；双击复位默认比例）`,
      tabIndex: 0,
      style: { cursor: 'ns-resize', height: `${SPLITTER_PX}px`, flexShrink: 0, touchAction: 'none' },
      className: `relative z-20 w-full select-none bg-transparent ${SPLITTER_HOVER_CLASS}`,
      onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => {
        boundaryRef.current = boundary;
        onMouseDown(boundary, e);
      },
      onDoubleClick: () => resetBoundary(boundary),
      onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          dragWithKeyboard(boundary, -KEY_STEP_PX);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          dragWithKeyboard(boundary, KEY_STEP_PX);
        }
      },
    }),
    [dragWithKeyboard, onMouseDown, resetBoundary],
  );

  const restoreProps = useCallback(
    (view: CollapsibleViewKey): RestoreBarProps => ({
      'data-testid': `wb-restore-${view}`,
      role: 'button',
      'aria-label': `展开${VIEW_LABEL[view]}视图（恢复记忆比例）`,
      tabIndex: 0,
      style: { height: `${SPLITTER_PX}px`, flexShrink: 0 },
      className:
        'flex w-full items-center justify-center gap-1 rounded border border-line bg-panel2 text-[10px] text-dim hover:text-txt',
      onClick: () => expand(view),
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          expand(view);
        }
      },
    }),
    [expand],
  );

  return {
    ratios: layout.ratios,
    collapsed: layout.collapsed,
    klinePx: plan.klinePx,
    indicatorsPx: plan.indicatorsPx,
    detailPx: plan.detailPx,
    availablePx: plan.availablePx,
    // 拖拽夹取（BLOCKED-2）与**归一收缩**（第六轮裁决）都计入披露；并存时**合并披露**（禁静默、禁相互掩盖）
    clamped: plan.clamped || dragClamped || writeShrinkNote !== null,
    compressed: plan.compressed,
    disclosure: [plan.disclosure, dragClamped ? DRAG_CLAMP_DISCLOSURE : null, writeShrinkNote].filter(Boolean).join(' ') || null,
    viewportH,
    splitRef,
    splitterProps,
    restoreProps,
    collapse,
    expand,
    toggleView,
    resetBoundary,
  };
}
