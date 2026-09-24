import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * 结果页**曲线卡**「上下缩放」原语（ADR-028 §2.4c 第 2/3 项）。
 *
 * **ADR-028 §2.9（D9-5）范围收敛**：K 线卡的卡高机制（S/M/L 预设条 + 下沿把手 + 卡高记忆）**已删**
 * ⇒ 本模块**只服务四张曲线卡**（D4.2 有效，勿删）；K 线的高度由「K 线视图」分隔条控制。
 *
 * 契约（本波实测事实所定）：
 *  - **只做高度缩放**（宽度变化会破坏 D2.3-4 的共用绘图区几何；高度不影响 x 映射）；
 *  - 拖拽把手 = 卡片**下边缘**（`cursor: ns-resize`，与 klinecharts 内建分隔线同口径），
 *    `data-card-resize="<cardId>"` 供真渲染规格定位；
 *  - **双击卡片标题复位**（`reset()` = 提交 `null` ⇒ 回默认渲染）；
 *  - 受控高度下卡片必须 `flex-shrink: 0`：否则 flex 列会把注入高度**吞回**（探针实测缺陷）；
 *  - 内层图（`svg` / klinecharts 容器）必须 `flex:1 min-h-0` 才能跟随卡片高度；
 *  - **D6-5（2026-09-23）**：把手可命中带 **≥12px**（原 6px 实测「上方 20px 全归引擎」）、**悬停必须可见**。
 *    旧实现用 `hover:bg-acc1/40`，而 `tailwind.config.js` 把 token 写成 `var(--acc1)`（无 `<alpha-value>`）
 *    ⇒ Tailwind v3 **不产出**该规则（构建 CSS 内规则数 = 0，实测证据
 *    `coder/evidence/20260923_result_d6d7/raw/tailwind-css-fix-rules.txt`）⇒ 悬停零反馈。
 *    现改用**能产出规则**的 arbitrary 写法 `hover:bg-[color-mix(in_srgb,var(--acc1)_40%,transparent)]`
 *    （保留 token、不硬编码色值）。
 */
export const CARD_MIN_PX = 120;
export const CARD_MAX_PX = 1200;
/** 把手**可命中带**高（D6-5：≥12px；`h-3` = 12px）。 */
export const CARD_HANDLE_HIT_PX = 12;
/** 把手悬停高亮类（可产出规则；见文件头 CSS 缺规则根因）。 */
export const CARD_HANDLE_HOVER_CLASS =
  'hover:bg-[color-mix(in_srgb,var(--acc1)_40%,transparent)]';

/** 把手 div 的属性（显式列出 ⇒ 可直接展开到 JSX，无索引签名带来的类型噪音）。 */
export interface CardResizeHandleProps {
  'data-testid': string;
  'data-card-resize': string;
  'aria-label': string;
  onMouseDown(e: ReactMouseEvent<HTMLDivElement>): void;
  onDoubleClick(): void;
  style: CSSProperties;
  className: string;
}

export interface CardResizeApi {
  /** 是否处于「受控高度」态（false ⇒ 默认渲染，不写 inline 高度、svg 用默认固定类）。 */
  active: boolean;
  /** 受控高度（拖拽中 = 实时草稿；否则 = 已提交值；`null` = 默认）。 */
  heightPx: number | null;
  /** 供内层图切换类名：受控态 ⇒ `h-full`（随容器），否则用传入的默认类。 */
  svgClass(defaultClass: string): string;
  cardRef: RefObject<HTMLDivElement>;
  cardStyle: CSSProperties | undefined;
  /** 透传到卡片内下边缘把手 div 的属性（含 `data-testid` / `data-card-resize` / mousedown / 双击复位）。 */
  handleProps: CardResizeHandleProps;
  /** 直接提交一个高度（预设/程序化入口；`null` = 复位到默认；非法值⇒ 不提交）。 */
  commit(px: number | null): void;
  reset(): void;
}

function clampPx(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function useCardResize(args: {
  cardId: string;
  /** 已提交高度（来自结果页独立配置 key）；`null` = 默认渲染。 */
  heightPx: number | null;
  /** 提交高度（`null` = 复位）。调用方负责持久化。 */
  onCommit(px: number | null): void;
  /** jsdom/未布局时的拖拽起点兜底（真渲染下以卡片实测高度为准）。 */
  defaultPx: number;
  minPx?: number;
  maxPx?: number;
}): CardResizeApi {
  const { cardId, heightPx, onCommit, defaultPx } = args;
  const min = args.minPx ?? CARD_MIN_PX;
  const max = args.maxPx ?? CARD_MAX_PX;
  const cardRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const draftRef = useRef<number | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const applyDraft = useCallback((v: number | null) => {
    draftRef.current = v;
    setDraft(v);
  }, []);

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rectH = cardRef.current?.getBoundingClientRect().height ?? 0;
      const startH = heightPx ?? draftRef.current ?? (rectH > 0 ? Math.round(rectH) : defaultPx);
      dragRef.current = { startY: e.clientY, startH };
      applyDraft(Math.round(startH));
      setDragging(true);
    },
    [applyDraft, defaultPx, heightPx],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      applyDraft(clampPx(d.startH + (e.clientY - d.startY), min, max));
    };
    const up = () => {
      const d = dragRef.current;
      const next = draftRef.current;
      dragRef.current = null;
      setDragging(false);
      applyDraft(null);
      if (d && next != null) onCommitRef.current(next);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [applyDraft, dragging, max, min]);

  const reset = useCallback(() => {
    applyDraft(null);
    dragRef.current = null;
    onCommitRef.current(null);
  }, [applyDraft]);

  /** 预设入口：直接提交（clamp 到 min/max；非法值（NaN）⇒ 忽略，不写坏记忆）。 */
  const commit = useCallback(
    (px: number | null) => {
      if (px == null) {
        reset();
        return;
      }
      const next = clampPx(px, min, max);
      if (!Number.isFinite(next)) return;
      applyDraft(null);
      dragRef.current = null;
      onCommitRef.current(next);
    },
    [applyDraft, max, min, reset],
  );

  const live = draft ?? heightPx;
  const active = live != null;
  return {
    active,
    heightPx: live,
    svgClass: (defaultClass: string) => (active ? 'h-full w-full' : defaultClass),
    cardRef,
    // 受控高度必须显式 `flex-shrink:0`：否则 flex 列把注入高度吞回（探针实测）
    cardStyle: active ? { height: `${live}px`, flexShrink: 0 } : undefined,
    handleProps: {
      'data-testid': `wb-card-resize-${cardId}`,
      'data-card-resize': cardId,
      'aria-label': `${cardId} 卡片高度拖拽把手（双击复位）`,
      onMouseDown,
      onDoubleClick: reset,
      // inline cursor（与 klinecharts 分隔线同口径：真渲染规格按「宽 > 100 且 cursor = ns-resize」定位）
      style: { cursor: 'ns-resize' },
      className: `absolute inset-x-0 bottom-0 z-30 h-3 cursor-ns-resize touch-none select-none bg-transparent ${CARD_HANDLE_HOVER_CLASS}`,
    },
    commit,
    reset,
  };
}

/** 卡片标题（**双击复位高度**的统一入口；`data-testid="wb-card-title-<cardId>"`）。 */export function CardTitle({
  cardId,
  children,
  onReset,
  hint = '双击复位高度',
  className = '',
}: {
  cardId: string;
  children: ReactNode;
  onReset(): void;
  hint?: string | null;
  className?: string;
}) {
  return (
    <div
      data-testid={`wb-card-title-${cardId}`}
      data-card-title={cardId}
      title={hint ?? undefined}
      onDoubleClick={onReset}
      className={`flex shrink-0 select-none items-center justify-between gap-2 px-1 pb-0.5 text-[10px] text-dim ${className}`}
    >
      <span className="truncate">{children}</span>
      {hint != null && <span className="shrink-0 opacity-50">{hint}</span>}
    </div>
  );
}
