/**
 * ADR-028 §2.7（**D7｜明细上下分层**）—— 下栏（明细视图）布局的**纯函数层**。
 *
 * 事实源：`design/01-architecture/adr/ADR-028-…§2.7` 第 3 项（下栏默认 40% 视口高、可拖拽、可折叠、记忆）＋
 *        `design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md` §2 表 D7-3、§4 边界
 *        （比例 clamp [0.15, 0.85]、折叠后上栏占满、比例记忆保留、坏数据回默认）。
 *
 * 纯函数 + 注入式 storage（无副作用、无 React 依赖）；px ↔ 比例换算**注入视口高**以便单测。
 */

/** 下栏默认占视口高的比例（D7-3）。 */
export const DEFAULT_DETAIL_RATIO = 0.4;
/** 比例下限（§4：不得把任一侧压到 0）。 */
export const DETAIL_RATIO_MIN = 0.15;
/** 比例上限。 */
export const DETAIL_RATIO_MAX = 0.85;
/** 上栏保底高（下栏不得把上栏压到该值以下；上栏自身可滚动，故保底=可读的最小一块）。 */
export const DETAIL_UPPER_MIN_PX = 200;
/** 下栏可见下限（极窄可用高时兜底，避免「下栏消失」）。 */
export const DETAIL_MIN_PX = 120;
/** 结果页布局记忆 key（下栏比例 + 折叠态；结果页**独立** key，不碰看板配置）。 */
export const RESULT_LAYOUT_STORAGE_KEY = 'eestock.result.layout.v1';

export interface ResultLayout {
  ratio: number;
  collapsed: boolean;
}

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const DEFAULT_RESULT_LAYOUT: ResultLayout = { ratio: DEFAULT_DETAIL_RATIO, collapsed: false };

export function defaultLayoutStorage(): LayoutStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 比例净化：越界夹取；非法（NaN/字符串/null）⇒ 默认 0.4。 */
export function clampRatio(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_DETAIL_RATIO;
  return Math.min(DETAIL_RATIO_MAX, Math.max(DETAIL_RATIO_MIN, raw));
}

/** 折叠/展开切换（纯函数）。 */
export function toggleCollapsed(collapsed: boolean): boolean {
  return !collapsed;
}

/** 比例 → 下栏 px（注入视口高；可选 `availablePx`/`upperMinPx` 保证上栏保底）。 */
export function detailPxForRatio(args: {
  ratio: number;
  viewportH: number;
  availablePx?: number;
  upperMinPx?: number;
}): number {
  const viewportH = Number.isFinite(args.viewportH) && args.viewportH > 0 ? args.viewportH : 800;
  const desired = Math.round(viewportH * clampRatio(args.ratio));
  if (args.availablePx == null) return desired;
  const available = Math.max(0, args.availablePx);
  const upperMin = Math.max(0, args.upperMinPx ?? DETAIL_UPPER_MIN_PX);
  const upperCap = Math.max(0, available - upperMin);
  const floor = Math.min(DETAIL_MIN_PX, available);
  return Math.round(Math.min(available, Math.max(floor, Math.min(desired, upperCap))));
}

/** 下栏 px → 比例（拖拽提交用；越界/非法 ⇒ clamp/默认）。 */
export function ratioForDetailPx(args: { detailPx: number; viewportH: number }): number {
  const viewportH = Number.isFinite(args.viewportH) && args.viewportH > 0 ? args.viewportH : 800;
  if (!Number.isFinite(args.detailPx)) return DEFAULT_DETAIL_RATIO;
  return clampRatio(args.detailPx / viewportH);
}

/** 布局 → 渲染几何（下栏 px / 上栏 px / 折叠态；折叠 ⇒ 下栏 0、上栏占满）。 */
export function layoutForViewport(args: {
  layout: ResultLayout;
  viewportH: number;
  availablePx?: number;
}): { detailPx: number; chartPx: number | null; collapsed: boolean; ratio: number } {
  const ratio = clampRatio(args.layout.ratio);
  const collapsed = Boolean(args.layout.collapsed);
  if (collapsed) {
    return { detailPx: 0, chartPx: args.availablePx ?? null, collapsed: true, ratio };
  }
  const detailPx = detailPxForRatio({ ratio, viewportH: args.viewportH, availablePx: args.availablePx });
  const chartPx = args.availablePx == null ? null : Math.max(0, Math.round(args.availablePx - detailPx));
  return { detailPx, chartPx, collapsed: false, ratio };
}

function parseLayout(raw: string | null): ResultLayout {
  if (raw == null) return { ...DEFAULT_RESULT_LAYOUT };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_RESULT_LAYOUT };
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return { ...DEFAULT_RESULT_LAYOUT };
  const o = obj as { ratio?: unknown; collapsed?: unknown };
  return {
    ratio: clampRatio(o.ratio),
    collapsed: typeof o.collapsed === 'boolean' ? o.collapsed : false,
  };
}

export function readResultLayout(storage: LayoutStorage | null = defaultLayoutStorage()): ResultLayout {
  if (!storage) return { ...DEFAULT_RESULT_LAYOUT };
  try {
    return parseLayout(storage.getItem(RESULT_LAYOUT_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_RESULT_LAYOUT };
  }
}

export function writeResultLayout(
  layout: ResultLayout,
  storage: LayoutStorage | null = defaultLayoutStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      RESULT_LAYOUT_STORAGE_KEY,
      JSON.stringify({ ratio: clampRatio(layout.ratio), collapsed: Boolean(layout.collapsed) }),
    );
  } catch {
    // 写失败不得打断交互（刷新后回默认）
  }
}
