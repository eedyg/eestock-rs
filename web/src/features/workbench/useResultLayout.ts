import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import {
  DEFAULT_DETAIL_RATIO,
  defaultLayoutStorage,
  detailPxForRatio,
  layoutForViewport,
  ratioForDetailPx,
  readResultLayout,
  toggleCollapsed,
  writeResultLayout,
  type LayoutStorage,
  type ResultLayout,
} from './resultLayout';

/**
 * ADR-028 §2.7（D7）下栏布局**状态与持久化**（拖拽 / 折叠 / 记忆）。
 *
 * - 默认 `ratio = 0.4`（40% 视口高，D7-3）；比例 clamp 到 `[0.15, 0.85]`（§4）；
 * - 折叠 ⇒ 下栏不占位（上栏占满）、比例记忆保留（展开恢复）；
 * - 记忆写入结果页**独立** key（`eestock.result.layout.v1`）；DI storage 适配器（单测注入内存实现）；
 * - 可用高由 split 容器**实测**（ResizeObserver）注入纯函数 ⇒ 不依赖视口假设。
 */
export interface ResultLayoutApi {
  ratio: number;
  collapsed: boolean;
  /** 下栏高度 px（折叠 ⇒ 0）。 */
  detailPx: number;
  /** split 容器实测高（未布局 ⇒ 0）。 */
  availablePx: number;
  viewportH: number;
  splitRef: RefObject<HTMLDivElement>;
  /** 透传到下栏分隔条的属性（拖拽 + 双击复位比例）。 */
  splitterProps: {
    'data-testid': string;
    role: 'separator';
    'aria-orientation': 'horizontal';
    'aria-label': string;
    style: CSSProperties;
    className: string;
    onMouseDown(e: ReactMouseEvent<HTMLDivElement>): void;
    onDoubleClick(): void;
  };
  collapse(): void;
  expand(): void;
  toggle(): void;
  resetRatio(): void;
}

export function useResultLayout(args: { storage?: LayoutStorage | null } = {}): ResultLayoutApi {
  const storage = args.storage === undefined ? defaultLayoutStorage() : args.storage;
  const [layout, setLayout] = useState<ResultLayout>(() => readResultLayout(storage));
  const splitRef = useRef<HTMLDivElement>(null);
  const [availablePx, setAvailablePx] = useState(0);
  const [viewportH, setViewportH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));

  const commit = useCallback(
    (next: ResultLayout) => {
      setLayout(next);
      writeResultLayout(next, storage);
    },
    [storage],
  );

  // 可用高实测（split 容器）：ResizeObserver 不可用（jsdom）⇒ 保持 0 ⇒ 纯函数按视口高换算
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const measure = () => setAvailablePx(Math.max(0, Math.round(el.getBoundingClientRect().height)));
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

  const geo = useMemo(
    () => layoutForViewport({ layout, viewportH, availablePx: availablePx > 0 ? availablePx : undefined }),
    [layout, viewportH, availablePx],
  );

  const dragRef = useRef<{ startY: number; startDetail: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = splitRef.current;
      const avail = el ? el.getBoundingClientRect().height : availablePx;
      const startDetail = layout.collapsed
        ? 0
        : detailPxForRatio({ ratio: layout.ratio, viewportH, availablePx: avail > 0 ? avail : undefined });
      dragRef.current = { startY: e.clientY, startDetail };
      setDragging(true);
    },
    [availablePx, layout.collapsed, layout.ratio, viewportH],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const nextPx = d.startDetail + (e.clientY - d.startY);
      commit({ ratio: ratioForDetailPx({ detailPx: nextPx, viewportH }), collapsed: false });
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
  }, [commit, dragging, viewportH]);

  const collapse = useCallback(() => commit({ ratio: layout.ratio, collapsed: true }), [commit, layout.ratio]);
  const expand = useCallback(() => commit({ ratio: layout.ratio, collapsed: false }), [commit, layout.ratio]);
  const toggle = useCallback(() => commit({ ratio: layout.ratio, collapsed: toggleCollapsed(layout.collapsed) }), [commit, layout.collapsed, layout.ratio]);
  const resetRatio = useCallback(
    () => commit({ ratio: DEFAULT_DETAIL_RATIO, collapsed: layout.collapsed }),
    [commit, layout.collapsed],
  );

  return {
    ratio: geo.ratio,
    collapsed: layout.collapsed,
    detailPx: geo.detailPx,
    availablePx,
    viewportH,
    splitRef,
    splitterProps: {
      'data-testid': 'wb-pane-splitter',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': '明细面板高度拖拽分隔条（双击复位 40%）',
      style: { cursor: 'ns-resize' },
      className:
        'relative z-20 h-3 shrink-0 cursor-ns-resize touch-none select-none bg-transparent hover:bg-[color-mix(in_srgb,var(--acc1)_40%,transparent)]',
      onMouseDown,
      onDoubleClick: resetRatio,
    },
    collapse,
    expand,
    toggle,
    resetRatio,
  };
}
