/**
 * ADR-028 §2.9（**D9｜结果页三视图拆分**）—— 结果页**三段视图布局**的纯函数层。
 *
 * 事实源（唯一出口，本文件不新增口径）：
 *  - `design/01-architecture/adr/ADR-028-…§2.9`（含 2026-09-24 标定回填的第 6/7 项、
 *    「三视图高度均可调（2 自由度守恒）」、必修缺陷 D9-13）；
 *  - `design/17-trade-detail-layering/08-plan-three-view-split.md` §2 表 D9-1..13、§4 边界、§3 改动清单。
 *
 * ## 口径摘要（**契约数值，非推导**）
 *  - **结构**：上 = K 线视图（**常驻、不可收起**，它是 x 域锚）｜中 = 指标视图（仅四张曲线卡）｜
 *    下 = 明细视图（4 tab）；两条分隔条（K线↔指标、指标↔明细）。
 *  - **可用高**：`可用 = 视口高 − 132`（= split 容器高 `视口−92` − 两条分隔条 24 − 4 条 gap 16）。
 *    旧口径 `ratio × 视口高` 三档均溢出 92px ⇒ D9 必修。
 *  - **守恒（2 自由度）**：`klinePx + indicatorsPx + detailPx == 可用高`（±2px）。三视图只有 2 个自由度，
 *    故「三者各自独立取值」几何不可实现；本文件即该守恒的唯一算术入口。
 *  - **可读下限**：K 线视图 **299**（1 副图）/ **329**（2 副图）、指标 **180**（≈一张曲线卡完整可读）、
 *    明细 **95**（tab 29 + p-2 16 + 表头 25 + 一行 25）。夹取优先级 **K 线 → 指标 → 明细**。
 *  - **几何恒等式**：`卡高 = K 线视图高 − 60`（窗口条 34 + 载入提示 18 + gap 8）；
 *    `内层 = 卡高 − 22`（卡头 20 + 边框 2）；`主图 = 内层 − x轴26 − 分隔1×副图数 − Σ副图`。
 *    **硬不变量**：`主图 ≥ 160 ∧ 副图 ≥ 30`（任意记忆值 / 任意副图数 / 任意视口，D9-13）。
 *  - **记忆**：新键 `eestock.result.layout.v2`（三段比例 + 两个收起态）；旧 `eestock.result.layout.v1`
 *    （`ratio`/`collapsed`）与 `eestock.result.cardHeights.v1`（`kline` px）**只读迁移**、界内才采信；
 *    冲突时 **v2 已存值优先**。
 *  - **收起段比例冻结**（2026-09-24 架构裁决 / ADR §2.9-2）：收起 = 临时置 0 并把空间按原比例分给可见段
 *    ⇒ 收起段的比例是「**暂停使用**」而非「重新分配」⇒ 拖拽写盘**不得改写**其已存比例，**展开回到收起前几何**。
 *  - **收起态相邻边界的拖拽**（同裁决第二轮）：位移**只在可见两段之间** 1:1 重分配（收起段那一份不可分配），
 *    两侧各受自身可读下限夹取 ⇒ 收起态下相邻边界**不是死控件**。
 *  - **真实比例口径夹取**（裁决第四轮）：收起态下每次拖拽都额外保证「**展开后的真实 px** ≥ 各段可读下限」
 *    （`r_v · 可用高 ≥ min_v` ⇒ 显示 px 下限 `min_v / (1 − S)`）⇒ **展开永不触发重夹** ⇒ 收起→拖→展开
 *    **无条件**回到收起前几何（±2px）。调用方需传 `collapsedRatioSum = S`（收起段已存比例之和）。
 *
 * 本文件**无副作用**（storage 由调用方注入）、不依赖 React / dashboard（依赖方向 workbench → dashboard 不倒置）。
 */

import { KLINE_AXIS_PX, PANE_SEPARATOR_PX, planKlinePanes } from './resultCardHeights';

export type ViewKey = 'kline' | 'indicators' | 'detail';
/** 可收起的视图（**K 线视图常驻**，D9-2 ⇒ 不在其中）。 */
export type CollapsibleViewKey = 'indicators' | 'detail';

export interface ViewRatios {
  kline: number;
  indicators: number;
  detail: number;
}
export interface ViewCollapsed {
  indicators: boolean;
  detail: boolean;
}
/** 拖拽提交结果：比例 + **是否被可读下限夹取**（`clamped` ⇒ 调用方**必须披露**，禁静默）。 */
export interface ViewDragResult {
  ratios: ViewRatios;
  clamped: boolean;
}
/** 收起段份额被**收缩**时的披露文本（第六轮裁决：归一必须完备，禁静默）。 */
export const FROZEN_SHARE_SHRINK_DISCLOSURE =
  '原收起比例在当前视口不可行（可见视图的可读下限无法满足）⇒ 已把收起段份额**收缩**到可行上界（份额不会被置 0；展开后即为该收缩值）';

/** 拖拽路径的夹取披露文本（plan §4「口径澄清」①；BLOCKED-2）。 */
export const DRAG_CLAMP_DISCLOSURE =
  '拖拽已到可读下限 ⇒ 位移在该边界停止（K 线视图 299/329px、指标 180px、明细 95px；禁静默）';
/** 三段视图键（固定顺序，供逐字段解析/合并复用）。 */
export const VIEW_KEYS = ['kline', 'indicators', 'detail'] as const satisfies readonly ViewKey[];
export interface ResultLayoutV2 {
  ratios: ViewRatios;
  collapsed: ViewCollapsed;
}

/** 结果页布局**新键**（D9-11）。 */
export const RESULT_LAYOUT_STORAGE_KEY = 'eestock.result.layout.v2';
/** 旧结果页布局键（`{ratio, collapsed}`）——**只读迁移源**。 */
export const RESULT_LAYOUT_V1_STORAGE_KEY = 'eestock.result.layout.v1';
/** 旧卡高键（`{kline: px, …}`）——**只读迁移源**（`kline` 作一次性初始视图高，D9-3）。 */
export const CARD_HEIGHT_STORAGE_KEY_LEGACY = 'eestock.result.cardHeights.v1';
/**
 * **瞬时通知键**（实现细节，**不属** D9-11 记忆契约）：记录「收起段份额曾被归一收缩」这一**一次性事件**，
 * 使 `clamped` + 披露在**跨挂载/刷新**后仍可复现（读-迁移可能发生在被丢弃的渲染里，事件级标志会丢）。
 * 用户下一次交互（收起/展开/拖拽/键盘/复位）即清除。
 */
export const RESULT_LAYOUT_NOTICE_STORAGE_KEY = 'eestock.result.layout.v2.notice';

/** 看板布局 key（**仅用于「不得触碰」断言/文档**，本模块绝不读写）。 */
export const DASHBOARD_LAYOUT_KEY = 'eestock.dashboard.layout.v1';

/** 默认三段比例（2026-09-24 标定回填：指标默认只保证「1 张卡可读」，其余滚动）。 */
export const DEFAULT_VIEW_RATIOS: ViewRatios = { kline: 0.55, indicators: 0.29, detail: 0.16 };
/** 可用高口径：`可用 = 视口高 − 132`（D9-8 必修口径）。 */
export const VIEW_AVAILABLE_CHROME_PX = 132;
/** 分隔条高（px；真身读数）。 */
export const SPLITTER_PX = 12;
/** split 容器内相邻元素间距（`gap-1`，共 4 条）。 */
export const SPLIT_GAP_PX = 4;
/** split 容器内**非视图**占用 = 两条分隔条 + 4 条 gap = 40px（`可用 = split − 40 = 视口 − 132`）。 */
export const SPLIT_CHROME_PX = 2 * SPLITTER_PX + 4 * SPLIT_GAP_PX;
/** 可读下限（px；D9-7 标定值）。 */
export const VIEW_MIN_PX = { klineOneSub: 299, klineTwoSub: 329, indicators: 180, detail: 95 } as const;
/** K 线视图内固定占用（窗口控制条 34 + 载入提示 18 + gap 8）⇒ `卡高 = 视图高 − 60`。 */
export const KLINE_VIEW_CHROME_PX = 60;
/** 卡片头部 + 上下边框（`内层 = 卡高 − 22`）。 */
export const KLINE_CARD_BORDER_HEADER_PX = 22;

/** 比例合理区间（记忆值界外 ⇒ 不采信，回默认）。 */
const RATIO_MIN = 0.05;
const RATIO_MAX = 0.92;
/** 旧卡高记忆的合理区间（界外 = 坏数据 ⇒ 不迁移）。 */
const LEGACY_CARD_PX_MIN = 200;
const LEGACY_CARD_PX_MAX = 4000;
const DEFAULT_VIEWPORT_H = 800;

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function defaultLayoutStorage(): LayoutStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 段比例是否**可用**（有限、为正、不超上限）。
 *
 * 契约（ADR §2.9-7 / plan §4「界外/坏数据 ⇒ 忽略该源、用默认」）：`0`、负值、`NaN`、越界值一律**不可用**
 * ⇒ 既不得进入 v2（写入侧，BLOCKED-1），也不得充当「已存值」（读取侧）。
 */
function isUsableRatio(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= RATIO_MAX;
}

function normalizeViewportH(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : DEFAULT_VIEWPORT_H;
}

/** 可用高（D9-8 口径）：`视口高 − 132`。 */
export function availableForViewport(viewportH: number): number {
  return Math.max(0, normalizeViewportH(viewportH) - VIEW_AVAILABLE_CHROME_PX);
}

/** split 容器实测高 → 可用高（扣掉两条分隔条 + 4 条 gap = 40px）；与 {@link availableForViewport} 同口径。 */
export function availableFromSplitPx(splitPx: number): number {
  if (!(typeof splitPx === 'number' && Number.isFinite(splitPx) && splitPx > 0)) return 0;
  return Math.max(0, Math.round(splitPx) - SPLIT_CHROME_PX);
}

/**
 * 三视图可读下限（K 线视图**按副图数分档**）。
 * 副图数 ≥2 ⇒ 329（实测卡高下限 269 + 60）；副图数 0/1 ⇒ 299（239 + 60）。
 */
export function viewMinPx(subPaneCount: number): ViewRatios {
  const n = Number.isFinite(subPaneCount) ? Math.max(0, Math.floor(subPaneCount)) : 0;
  return {
    kline: n >= 2 ? VIEW_MIN_PX.klineTwoSub : VIEW_MIN_PX.klineOneSub,
    indicators: VIEW_MIN_PX.indicators,
    detail: VIEW_MIN_PX.detail,
  };
}

/** 比例净化：非负有限值归一化到和 1；全 0/非法 ⇒ 默认。 */
export function sanitizeViewRatios(raw: unknown): ViewRatios {
  const o = raw as Partial<Record<ViewKey, unknown>> | null | undefined;
  if (o == null || typeof o !== 'object') return { ...DEFAULT_VIEW_RATIOS };
  const pick = (k: ViewKey): number => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const k = pick('kline');
  const i = pick('indicators');
  const d = pick('detail');
  const sum = k + i + d;
  if (!(sum > 0)) return { ...DEFAULT_VIEW_RATIOS };
  return { kline: k / sum, indicators: i / sum, detail: d / sum };
}

/**
 * 比例合并（**记忆语义唯一算术入口**）：
 * `preserved` 段**原值保留**（不得被归零/改动）；`valid` 段按**原比例**填满剩余份额 ⇒ 和 = 1。
 *
 * 用途（BLOCKED-1 修复）：
 *  - **写入侧**：非法段用其「最后一次有效值」充当 `preserved`，其余段缩放填满；
 *  - **读取侧**：v2 缺失/坏值的字段充当 `preserved`（默认或迁移源），v2 的有效字段缩放填满。
 * 依据：ADR §2.9-2「收起态与比例均**记忆**」+ §2.9-7「以 v2 已存值为准」⇒ 收起段必须保留其比例，
 * 不得因「收起 ⇒ 段高 0」被归一成 0。
 */
export function mergeViewRatios(valid: Partial<ViewRatios>, preserved: Partial<ViewRatios>): ViewRatios {
  const fixed: ViewRatios = {
    kline: preserved.kline ?? 0,
    indicators: preserved.indicators ?? 0,
    detail: preserved.detail ?? 0,
  };
  const fixedSum = fixed.kline + fixed.indicators + fixed.detail;
  const openKeys = VIEW_KEYS.filter((k) => isUsableRatio(valid[k]));
  const openSum = openKeys.reduce((s, k) => s + (valid[k] as number), 0);
  if (openKeys.length === 0) {
    if (Math.abs(fixedSum - 1) < 1e-9) return { ...fixed };
    return sanitizeViewRatios(fixed);
  }
  if (fixedSum === 0 && openKeys.length === VIEW_KEYS.length && Math.abs(openSum - 1) < 1e-9) {
    // 全字段有效且已归一 ⇒ **逐位保留**（写入/读回逐字节一致；微小浮点差不得引入漂移）
    return { kline: valid.kline as number, indicators: valid.indicators as number, detail: valid.detail as number };
  }
  if (!(openSum > 0) || fixedSum >= 1 - 1e-9) {
    return sanitizeViewRatios({
      kline: fixed.kline + (valid.kline ?? 0),
      indicators: fixed.indicators + (valid.indicators ?? 0),
      detail: fixed.detail + (valid.detail ?? 0),
    });
  }
  const scale = (1 - fixedSum) / openSum;
  const out: ViewRatios = { ...fixed };
  for (const k of openKeys) out[k] = fixed[k] + (valid[k] as number) * scale;
  return out;
}

/** 收起态切换（纯函数）。 */
export function toggleViewCollapsed(collapsed: ViewCollapsed, view: CollapsibleViewKey): ViewCollapsed {
  return { ...collapsed, [view]: !collapsed[view] };
}

export interface ThreeViewPlan {
  klinePx: number;
  indicatorsPx: number;
  detailPx: number;
  /** 计划所用可用高（实测值优先）。 */
  availablePx: number;
  /** 是否发生夹取（任一视图被抬到可读下限或被让位）。 */
  clamped: boolean;
  /** 是否发生**压缩**（下限之和 > 可用高 ⇒ 显式披露）。 */
  compressed: boolean;
  /** 显式披露文本（`clamped`/`compressed` 时非空，禁静默）。 */
  disclosure: string | null;
  collapsed: ViewCollapsed;
}

/**
 * 三段分配（唯一算术入口；**2 自由度守恒**）。
 *
 * 规则（逐条对应 ADR §2.9 第 6/7/8 项与 plan §4）：
 *  1. 可用高 = 实测 split 空间（缺省 `视口高 − 132`）；
 *  2. 收起视图 ⇒ 该段 0，其余按**原比例**（重新归一化）分享其空间；
 *  3. 比例 → px 后：低于可读下限者被抬到下限，缺口从 **K 线（残差承接者，D9-8-3②）→ 指标 → 明细**
 *     「超出下限」的部分里取；
 *  4. 下限之和 > 可用高 ⇒ **K 线优先保下限**，指标/明细按比例压缩，并**显式披露**（禁静默）。
 *     该支与 D9-8 的硬不变量（主图 ≥160）相容：K 线视图下限本身即由硬不变量派生。
 *  5. 舍入用最大余数法把残差补齐 ⇒ `三段之和 == 可用高`（±0）。
 */
export function planThreeViews(args: {
  ratios: ViewRatios;
  viewportH: number;
  /** 实测可用高（split 空间）；≤0/缺省 ⇒ 用 `视口高 − 132`。 */
  availablePx?: number;
  subPaneCount?: number;
  collapsed?: Partial<ViewCollapsed>;
  /**
   * 可读下限**覆盖**（缺省 = `viewMinPx(subPaneCount)`）。
   * 用途（第五轮裁决）：收起态下按**真实比例**口径传入 `min_v / (1 − S)`，
   * 使夹取结果直接编码「展开后该段仍不低于其可读下限」⇒ 存储 == 渲染。
   */
  mins?: ViewRatios;
}): ThreeViewPlan {
  const available =
    typeof args.availablePx === 'number' && Number.isFinite(args.availablePx) && args.availablePx > 0
      ? Math.round(args.availablePx)
      : availableForViewport(args.viewportH);
  const collapsed: ViewCollapsed = {
    indicators: args.collapsed?.indicators === true,
    detail: args.collapsed?.detail === true,
  };
  const mins = args.mins ?? viewMinPx(args.subPaneCount ?? 0);
  const rs = sanitizeViewRatios(args.ratios);

  // K 线视图**恒在**（D9-2 常驻）；仅指标/明细可收起。
  const active: ViewKey[] = (['kline', 'indicators', 'detail'] as ViewKey[]).filter(
    (k) => k === 'kline' || !collapsed[k as CollapsibleViewKey],
  );
  const minOf: Record<ViewKey, number> = {
    kline: active.includes('kline') ? mins.kline : 0,
    indicators: active.includes('indicators') ? mins.indicators : 0,
    detail: active.includes('detail') ? mins.detail : 0,
  };
  const sumActiveRatio = active.reduce((s, k) => s + rs[k], 0) || 1;
  const desired: Record<ViewKey, number> = { kline: 0, indicators: 0, detail: 0 };
  for (const k of active) desired[k] = (rs[k] / sumActiveRatio) * available;

  let clamped = false;
  let compressed = false;
  let disclosure: string | null = null;
  const px: Record<ViewKey, number> = { kline: 0, indicators: 0, detail: 0 };
  for (const k of active) px[k] = desired[k];

  const minSum = active.reduce((s, k) => s + minOf[k], 0);
  if (minSum > available) {
    // 不可行：K 线优先保下限，其余按比例压缩并披露。
    compressed = true;
    clamped = true;
    const klineMin = active.includes('kline') ? Math.min(minOf.kline, available) : 0;
    const others = active.filter((k) => k !== 'kline');
    const otherMinSum = others.reduce((s, k) => s + minOf[k], 0);
    const rest = Math.max(0, available - klineMin);
    px.kline = klineMin;
    if (others.length === 0) {
      px.kline = available;
    } else if (otherMinSum > 0) {
      for (const k of others) px[k] = (minOf[k] / otherMinSum) * rest;
    } else {
      for (const k of others) px[k] = rest / others.length;
    }
    disclosure = `可用高不足（${available}px < 三视图可读下限之和 ${minSum}px）⇒ 已按夹取优先级压缩：K 线视图 ${Math.round(
      px.kline,
    )}px（优先保下限）、指标 ${Math.round(px.indicators)}px、明细 ${Math.round(px.detail)}px`;
  } else {
    let need = 0;
    for (const k of active) need += Math.max(0, minOf[k] - px[k]);
    if (need > 0) {
      clamped = true;
      // 缺口从 **K 线（残差承接者，D9-8-3②）→ 指标 → 明细** 的「超出自身可读下限」的部分里取
      // ⇒ 让位不会把任何视图压到可读下限之下。拖拽产生的比例已在 `ratiosFromViewPx`
      // 内部按**边界**夹取（不会把无关的第三个视图拉向下限）。
      let remaining = need;
      for (const donor of ['kline', 'indicators', 'detail'] as ViewKey[]) {
        if (remaining <= 0) break;
        if (!active.includes(donor)) continue;
        const surplus = Math.max(0, px[donor] - minOf[donor]);
        const take = Math.min(surplus, remaining);
        px[donor] -= take;
        remaining -= take;
      }
      for (const k of active) if (px[k] < minOf[k]) px[k] = minOf[k];
      disclosure = `默认比例在该视口低于可读下限 ⇒ 已按夹取优先级（K 线 → 指标 → 明细）调整：K 线视图 ${Math.round(
        px.kline,
      )}px / 指标 ${Math.round(px.indicators)}px / 明细 ${Math.round(px.detail)}px`;
    }
  }

  // 舍入：floor + 最大余数法补齐残差 ⇒ 三段之和 == 可用高（守恒不因舍入破）。
  const floored: Record<ViewKey, number> = { kline: 0, indicators: 0, detail: 0 };
  const frac: Array<{ k: ViewKey; f: number }> = [];
  for (const k of active) {
    const f = Math.floor(px[k]);
    floored[k] = f;
    frac.push({ k, f: px[k] - f });
  }
  let remainder = available - active.reduce((s, k) => s + floored[k], 0);
  frac.sort((a, b) => b.f - a.f);
  let i = 0;
  while (remainder > 0 && frac.length > 0) {
    const slot = frac[i % frac.length];
    if (slot) floored[slot.k] += 1;
    remainder -= 1;
    i += 1;
  }
  while (remainder < 0) {
    // 理论不可达（floor 后和 ≤ available）；保守兜底：从最大段扣。
    const biggest = active.slice().sort((a, b) => floored[b] - floored[a])[0];
    if (biggest == null || floored[biggest] <= 0) break;
    floored[biggest] -= 1;
    remainder += 1;
  }

  return {
    klinePx: floored.kline,
    indicatorsPx: floored.indicators,
    detailPx: floored.detail,
    availablePx: available,
    clamped,
    compressed,
    disclosure,
    collapsed,
  };
}

export interface KlineGeometry {
  cardPx: number;
  innerPx: number;
  mainPx: number;
  subPanePx: number;
  subPaneTotalPx: number;
  subPaneCount: number;
  clamped: boolean;
}

/**
 * K 线视图高 → 卡片/主图几何（D9-8 恒等式）。
 * `卡高 = 视图高 − 60`；`内层 = 卡高 − 22`；`主图 = 内层 − 26 − 1×副图数 − Σ副图`（副图规则见 `planKlinePanes`）。
 */
export function klineGeometryForViewPx(args: { viewPx: number; subPaneCount: number }): KlineGeometry {
  const viewPx = isFinitePositive(args.viewPx) ? Math.round(args.viewPx) : 0;
  const n = Number.isFinite(args.subPaneCount) ? Math.max(0, Math.floor(args.subPaneCount)) : 0;
  const cardPx = viewPx - KLINE_VIEW_CHROME_PX;
  const innerPx = cardPx - KLINE_CARD_BORDER_HEADER_PX;
  const panes = planKlinePanes({ containerPx: innerPx, subPaneCount: n });
  return {
    cardPx,
    innerPx,
    mainPx: panes.candlePx,
    subPanePx: panes.subPanePx,
    subPaneTotalPx: panes.subPaneTotalPx,
    subPaneCount: n,
    clamped: panes.clamped,
  };
}

/** 恒等式右端（用于判据自检）：`主图 = 内层 − 26 − 1×副图数 − Σ副图`。 */
export function mainPanePxByIdentity(args: { innerPx: number; subPaneCount: number; subPaneTotalPx: number }): number {
  const n = Number.isFinite(args.subPaneCount) ? Math.max(0, Math.floor(args.subPaneCount)) : 0;
  return Math.round(args.innerPx - KLINE_AXIS_PX - PANE_SEPARATOR_PX * n - args.subPaneTotalPx);
}

/**
 * 拖拽提交：给定**起点 px** + 边界 + 鼠标位移 `dy`（正 = 向下），返回新的三段比例。
 *
 * **方向语义（ADR-028 §2.8/§2.9 第 8 项）**：分隔条位于其**上方视图的下沿** ⇒
 * **鼠标向上（dy < 0）⇒ 上方视图变高、下方视图变矮**，位移 **1:1**；
 * 夹取（D9-7）：**只对本边界的两个视图**按其可读下限夹取（位移 1:1 在夹取处停止，差额回吐给另一侧）；
 * 第三个视图**完全不动**。
 *
 * @returns `ratios` + **该次拖拽是否被夹取**（`clamped`）——
 * 拖到下限必须携带该标记（plan §4「口径澄清」①：**拖拽路径也必须披露夹取**，禁只在默认分配路径披露）。
 *
 * **收起态语义（架构裁决 2026-09-24 第二轮）**：调用方传**计划 px**（`planThreeViews` 产物）⇒
 * **收起段 px 恒为 0**；本函数据 `px <= 0` 判定「该段不在场」。若**本边界含收起段**
 * （且恰有一个收起段）⇒ 收起段那一份「**不可分配**」⇒ 位移**只在可见两段之间** 1:1 重分配
 * （收起态下相邻边界不得成为「拖不动的死控件」；展开时收起段回其冻结比例、可见两段等比收缩）。
 */
export function dragRatiosFromViewPx(args: {
  klinePx: number;
  indicatorsPx: number;
  detailPx: number;
  viewSpacePx: number;
  boundary: 'kline-indicators' | 'indicators-detail';
  dy: number;
  /** 可读下限（缺省 = 1 副图档）。 */
  mins?: ViewRatios;
  /**
   * 收起段的**已存比例之和**（= 不可分配份额 `S`；未收起 ⇒ 0）。
   *
   * 收起态下可见段的**显示 px** 与**真实比例**的关系：`r_v = (1 − S) · px_v / 可用高`
   * ⇒ `r_v · 可用高 ≥ min_v` 等价于 `px_v ≥ min_v / (1 − S)`。
   * 据此夹取（第四轮裁决）⇒ **展开永不触发重夹** ⇒ 收起→拖→展开**无条件**回到收起前几何。
   */
  collapsedRatioSum?: number;
}): ViewDragResult {
  // `viewSpacePx` 不参与归一（比例 = px/总和，尺度天然约消）；保留形参以便调用方单点换算。
  void args.viewSpacePx;
  const dy = Number.isFinite(args.dy) ? args.dy : 0;
  const mins = args.mins ?? viewMinPx(1);
  const start: Record<ViewKey, number> = {
    kline: args.klinePx,
    indicators: args.indicatorsPx,
    detail: args.detailPx,
  };
  /** 是否发生过夹取（下限被施加 ⇒ 位移未 1:1 全部生效）。 */
  let clamped = false;

  // 位移 1:1 + **只对参与分配的两个视图**按可读下限夹取（差额回吐给另一侧）；
  // 其余视图**完全不动** ⇒ 「各管一侧」与 D9-8-3② 的守恒要求同时成立。
  const clampPair = (
    upper: number,
    lower: number,
    upperMin: number,
    lowerMin: number,
  ): [number, number] => {
    if (lower < lowerMin) {
      upper -= lowerMin - lower;
      lower = lowerMin;
      clamped = true;
    }
    if (upper < upperMin) {
      lower -= upperMin - upper;
      upper = upperMin;
      clamped = true;
    }
    return [upper, lower];
  };

  // **在场**（px > 0）判定：计划 px 中收起段恒为 0 ⇒ 其份额**不可分配**。
  const present = (k: ViewKey) => start[k] > 0;
  const activeViews = VIEW_KEYS.filter((k) => present(k));
  /** 本边界的两侧。 */
  const [up, low]: [ViewKey, ViewKey] =
    args.boundary === 'kline-indicators' ? ['kline', 'indicators'] : ['indicators', 'detail'];
  /**
   * 位移作用的两个视图：
   *  - 本边界两侧**都在场** ⇒ 就是它们（与未收起时完全一致）；
   *  - **本边界含收起段**（且恰有一个收起段）⇒ 改取**可见两段**（架构裁决第二轮：
   *    收起段那一份不可分配 ⇒ 位移只在可见两段之间 1:1 重分配）。
   *    不变式：三步视图 + 恰一收起 ⇒ 可见两段恰 2 个 ⇒ 代入绝不会重叠。
   */
  let tUp: ViewKey = up;
  let tLow: ViewKey = low;
  if (!(present(up) && present(low)) && activeViews.length === 2) {
    if (!present(up)) tUp = activeViews.find((k) => k !== low) ?? up;
    if (!present(low)) tLow = activeViews.find((k) => k !== up) ?? low;
  }

  // **真实比例口径的可读下限**（第四轮裁决）：收起段份额不可分配 ⇒ 可见段被拉伸显示 ⇒
  // 约束必须按**展开后的真实 px** `r_v · 可用高 ≥ min_v` 折算为显示 px 下限 `min_v / (1 − S)`。
  // 未收起（S = 0）⇒ 与显示帧下限逐字相同。
  const collapsedSum = Number.isFinite(args.collapsedRatioSum)
    ? Math.max(0, Math.min(1, args.collapsedRatioSum as number))
    : 0;
  const share = 1 - collapsedSum;
  /**
   * 展开后真实 px 下限折算到**显示 px**：`min_v / (1 − S)`；
   * 收起态（`S > 0`）追加 **1px 浮点余量**——夹取点恰在边界时，`r_v · 可用高` 的舍入误差会让
   * plan 判为「低于下限」而**误触发重夹**（`data-view-clamped` 变 true 并把折叠段挤走）；
   * 未收起（`S = 0`）⇒ 下限**逐字不变**（保持 D9-7「拖到极限 == 可读下限」的像素精确判读）。
   */
  const minTrue = (v: number) => (share > 0 && share < 1 ? v / share + 1 : v);

  const [upperNext, lowerNext] = clampPair(
    start[tUp] - dy,
    start[tLow] + dy,
    minTrue(mins[tUp]),
    minTrue(mins[tLow]),
  );
  const px: Record<ViewKey, number> = { ...start, [tUp]: upperNext, [tLow]: lowerNext };

  const clamp0 = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const k = clamp0(px.kline);
  const i = clamp0(px.indicators);
  const d = clamp0(px.detail);
  const sum = k + i + d;
  // 退化（无可分配 px）⇒ 回默认比例，并如实披露「位移未生效」（禁静默）。
  if (!(sum > 0)) return { ratios: { ...DEFAULT_VIEW_RATIOS }, clamped: true };
  return { ratios: { kline: k / sum, indicators: i / sum, detail: d / sum }, clamped };
}

/** 兼容旧签名（只取比例）。新调用方应直接用 {@link dragRatiosFromViewPx} 取夹取披露。 */
export function ratiosFromViewPx(args: {
  klinePx: number;
  indicatorsPx: number;
  detailPx: number;
  viewSpacePx: number;
  boundary: 'kline-indicators' | 'indicators-detail';
  dy: number;
  /** 可读下限（缺省 = 1 副图档）。 */
  mins?: ViewRatios;
}): ViewRatios {
  return dragRatiosFromViewPx(args).ratios;
}

// ───────────────────────────── 记忆与迁移（D9-11） ─────────────────────────────

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function objOf(v: unknown): Record<string, unknown> | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** 已存 v2 中的**合法**段比例（逐字段；坏值不得充当「最后一次有效值」）。 */
function storedUsableRatios(storage: LayoutStorage | null | undefined): Partial<ViewRatios> {
  const out: Partial<ViewRatios> = {};
  if (!storage) return out;
  try {
    const r = objOf(objOf(parseJson(storage.getItem(RESULT_LAYOUT_STORAGE_KEY)))?.['ratios']);
    if (!r) return out;
    for (const k of VIEW_KEYS) if (isUsableRatio(r[k])) out[k] = r[k] as number;
  } catch {
    /* 读失败（隐私模式/坏 JSON）⇒ 无「已存值」可用 */
  }
  return out;
}

/**
 * **写入侧合法性归一**（BLOCKED-1 唯一修复入口）：非法（`0`/负/`NaN`/越界）段比例**不得持久化**。
 *
 * 规则（ADR §2.9-2「收起态与比例均记忆」+ 2026-09-24 架构裁决「收起段比例**冻结**」）：
 *  - 全段合法且无收起段 ⇒ 按和归一（与旧行为一致）；
 *  - 非法的段 ⇒ 该段保留**最后一次有效值**（已存 v2 → 默认值）；
 *  - **已收起的段（`collapsed[k] === true`）⇒ 比例「暂停使用」= 必须冻结**：优先取**已存值**
 *    （= 收起时的比例），拖拽写盘不得改写它（否则「收起再展开」会变矮，见 R1 裁决）；
 *    无已存值（首次写盘/无 storage）时才采信入参的合法值，否则默认。
 *  - 其余（可见且合法）段按**原比例**填满剩余份额；兜底 ⇒ 绝不产出 `0`/`NaN`。
 */
export function legalizeLayoutRatios(
  ratios: Partial<ViewRatios> | null | undefined,
  storage: LayoutStorage | null = defaultLayoutStorage(),
  collapsed?: Partial<ViewCollapsed> | null,
): ViewRatios {
  if (ratios == null || typeof ratios !== 'object') return { ...DEFAULT_VIEW_RATIOS };
  const r = ratios as Record<string, unknown>;
  /** 收起段（K 线视图常驻不可收起 ⇒ 不可能入列）。 */
  const frozen = VIEW_KEYS.filter((k) => k !== 'kline' && collapsed?.[k as CollapsibleViewKey] === true);
  /** 需保留的段 = 非法段 ∪ 收起段。 */
  const preserve = VIEW_KEYS.filter((k) => frozen.includes(k) || !isUsableRatio(r[k]));
  const valid: Partial<ViewRatios> = {};
  if (preserve.length === 0) {
    for (const k of VIEW_KEYS) valid[k] = r[k] as number;
    return mergeViewRatios(valid, {});
  }
  const prev = storedUsableRatios(storage);
  const preserved: Partial<ViewRatios> = {};
  for (const k of VIEW_KEYS) {
    if (!preserve.includes(k)) {
      valid[k] = r[k] as number;
      continue;
    }
    // 收起段：**优先已存值**（冻结）；无已存值 ⇒ 入参合法则采信入参，否则默认。
    // 非法段（非收起）：**优先已存值**（最后一次有效值），否则默认。
    const fallback = frozen.includes(k) && isUsableRatio(r[k]) ? (r[k] as number) : DEFAULT_VIEW_RATIOS[k];
    preserved[k] = prev[k] ?? fallback;
  }
  return mergeViewRatios(valid, preserved);
}

/** 旧卡高 px → 视图高 px（界内才采信）。 */
function legacyKlineViewPx(storage: LayoutStorage): number | null {
  const o = objOf(parseJson(storage.getItem(CARD_HEIGHT_STORAGE_KEY_LEGACY)));
  const raw = o?.['kline'];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const px = Math.round(raw);
  if (px < LEGACY_CARD_PX_MIN || px > LEGACY_CARD_PX_MAX) return null;
  return px + KLINE_VIEW_CHROME_PX;
}

/**
 * 读布局（**逐字段**解析：v2 已存字段优先；仅 v2 未提供的字段才采信只读迁移源；迁移成功回写 v2 一次）。
 *
 * 契约（ADR §2.9-7 / plan §4「迁移源冲突」行）：**以 v2 已存值为准**；两源仅在 v2 **无该字段**时采信；
 * 界外/坏数据 ⇒ 忽略该源、用默认。
 *
 * **BLOCKED-1 修复点**：v2 只要**存在**，其**已有字段**就不得因其他字段坏而被整份丢弃（旧实现要求三段比例齐全且为正，
 * 否则整份 v2 作废 ⇒ 静默回落旧键迁移）。坏字段按其自身语义回默认（不回落后备源），且由
 * `mergeViewRatios` 保证「坏字段取默认原值、其余字段按原比例填满」（不产生归一漂移）。
 *
 * `viewportH` 仅用于把旧**卡高 px** 换算成比例（比例本身与视口无关）。
 */
export function readResultLayoutDetailed(
  storage: LayoutStorage | null = defaultLayoutStorage(),
  opts: { viewportH?: number; availablePx?: number; mins?: ViewRatios } = {},
): LayoutWriteResult {
  const fallback: LayoutWriteResult = {
    layout: { ratios: { ...DEFAULT_VIEW_RATIOS }, collapsed: { indicators: false, detail: false } },
    repaired: false,
    unrepairable: false,
    frozenShrunk: false,
  };
  if (!storage) return fallback;

  // ① v2：**逐字段**可取性（存在即参与判决；坏值 ⇒ 默认）
  let v2Obj: Record<string, unknown> | null = null;
  try {
    v2Obj = objOf(parseJson(storage.getItem(RESULT_LAYOUT_STORAGE_KEY)));
  } catch {
    v2Obj = null;
  }
  const v2Ratios = v2Obj ? objOf(v2Obj['ratios']) : null;
  const v2Collapsed = v2Obj ? objOf(v2Obj['collapsed']) : null;

  // ② 迁移源（**只读**；仅 v2 未提供该字段时采信；界内才采信）
  let v1: Record<string, unknown> | null = null;
  try {
    v1 = objOf(parseJson(storage.getItem(RESULT_LAYOUT_V1_STORAGE_KEY)));
  } catch {
    v1 = null;
  }
  let legacyViewPx: number | null = null;
  try {
    legacyViewPx = legacyKlineViewPx(storage);
  } catch {
    legacyViewPx = null;
  }
  const v1Ratio = v1?.['ratio'];
  const v1RatioOk = typeof v1Ratio === 'number' && Number.isFinite(v1Ratio) && v1Ratio > 0 && v1Ratio < 1;
  const available = availableForViewport(normalizeViewportH(opts.viewportH));

  let legacyRatios: ViewRatios | null = null;
  if (legacyViewPx != null) {
    // 旧**卡高 px** ⇒ 一次性初始视图高（只读、界内才采信）⇒ 换算为比例。
    const k = Math.min(RATIO_MAX, Math.max(RATIO_MIN, legacyViewPx / Math.max(1, available)));
    const rest = 1 - k;
    const share = DEFAULT_VIEW_RATIOS.indicators / (DEFAULT_VIEW_RATIOS.indicators + DEFAULT_VIEW_RATIOS.detail);
    legacyRatios = { kline: k, indicators: rest * share, detail: rest * (1 - share) };
  } else if (v1RatioOk) {
    const d = Math.min(RATIO_MAX, Math.max(RATIO_MIN, v1Ratio as number));
    const rest = 1 - d;
    const share = DEFAULT_VIEW_RATIOS.kline / (DEFAULT_VIEW_RATIOS.kline + DEFAULT_VIEW_RATIOS.indicators);
    legacyRatios = { kline: rest * share, indicators: rest * (1 - share), detail: d };
  }
  const legacyCollapsedDetail = v1?.['collapsed'] === true;

  // ③ 逐字段判决：v2 提供 ⇒ 采信（坏值 ⇒ 默认，不得回落迁移源）；v2 未提供 ⇒ 迁移源/默认
  let migrated = false;
  const valid: Partial<ViewRatios> = {};
  const preserved: Partial<ViewRatios> = {};
  for (const k of VIEW_KEYS) {
    const provided = v2Ratios != null && Object.prototype.hasOwnProperty.call(v2Ratios, k);
    if (provided) {
      const v = v2Ratios?.[k];
      if (isUsableRatio(v)) valid[k] = v as number;
      else preserved[k] = DEFAULT_VIEW_RATIOS[k];
    } else if (legacyRatios) {
      preserved[k] = legacyRatios[k];
      migrated = true;
    } else {
      preserved[k] = DEFAULT_VIEW_RATIOS[k];
    }
  }
  const ratios = mergeViewRatios(valid, preserved);

  const collapsedProvided = v2Collapsed != null;
  const hasDetail = collapsedProvided && Object.prototype.hasOwnProperty.call(v2Collapsed, 'detail');
  if (!collapsedProvided || !hasDetail) {
    if (legacyCollapsedDetail) migrated = true;
  }
  const collapsed: ViewCollapsed = {
    indicators:
      collapsedProvided && Object.prototype.hasOwnProperty.call(v2Collapsed, 'indicators')
        ? v2Collapsed['indicators'] === true
        : false,
    detail: hasDetail ? v2Collapsed?.['detail'] === true : legacyCollapsedDetail,
  };

  const result: ResultLayoutV2 = { ratios, collapsed };
  // 迁移源确实贡献了取值 ⇒ 回写 v2 一次（**旧键内容一律不动**）；写失败不得打断（隐私模式/配额）。
  // **第五/六轮裁决**：迁移回写经**写入侧归一** ⇒ 返回/落盘的都是**生效态**（存储 == 渲染），
  // 并把「收起段份额是否被收缩」透出给调用方（用于 `clamped` + 披露）。
  if (migrated) return writeResultLayoutDetailed(result, storage, opts);
  return { layout: result, repaired: false, unrepairable: false, frozenShrunk: false };
}

/** 兼容旧签名（只取布局；需要收缩标志请用 {@link readResultLayoutDetailed}）。 */
export function readResultLayout(
  storage: LayoutStorage | null = defaultLayoutStorage(),
  opts: { viewportH?: number; availablePx?: number; mins?: ViewRatios } = {},
): ResultLayoutV2 {
  return readResultLayoutDetailed(storage, opts).layout;
}

/**
 * 写布局：持久化前必经 {@link legalizeLayoutRatios}（**非法段比例不得落盘**——BLOCKED-1）。
 *
 * @returns **实际写入**的布局（已归一）⇒ 调用方应把它作为内存态，保证「刷新前后逐 px 一致」。
 */
/**
 * **写入侧归一：存储 == 渲染**（架构裁决第五轮 2026-09-24）。
 *
 * 根因（裁决）：plan 在**夹取态**下的渲染几何**不是比例集合的纯函数**（含 donor 结构）⇒ 一旦存下
 * 一份**不可行**的比例，「收起→拖→展开」在部分路径上必然不可逆（与 BLOCKED-1 的 0-ratio 同族：
 * 持久化 ≠ 生效态）。
 *
 * 规则：
 *  - 若每个**未收起**视图已满足 `r_v · 可用高 ≥ min_v − 1px` ⇒ **逐位保留**（无抖动，既有读数不回退）；
 *  - 否则用 `planThreeViews` 的**夹取结果**反推比例（收起态下可读下限按 `1/(1 − S)` 折算，
 *    `S` = 收起段份额）⇒ 落盘值即**生效态**；收起段比例**冻结**（不参与重分配）；
 *  - 不可修复（可读下限之和 > 可用高，如 2 副图 + 小视口）⇒ 原样返回 + `unrepairable=true`
 *    （**绝不产出 0/非法值**；由 plan 自身的 `clamped/compressed` 披露）。
 */
export function normalizeLayoutToEffective(
  layout: ResultLayoutV2,
  opts: { availablePx?: number; mins?: ViewRatios },
): { layout: ResultLayoutV2; repaired: boolean; unrepairable: boolean; frozenShrunk: boolean } {
  const available =
    typeof opts.availablePx === 'number' && Number.isFinite(opts.availablePx) ? Math.round(opts.availablePx) : 0;
  const unchanged = { layout, repaired: false, unrepairable: false, frozenShrunk: false };
  if (available <= 0) return unchanged;
  const mins = opts.mins ?? viewMinPx(0);
  const r = layout.ratios;
  const active = VIEW_KEYS.filter((k) => k === 'kline' || layout.collapsed[k as CollapsibleViewKey] !== true);
  const frozenKeys = VIEW_KEYS.filter((k) => !active.includes(k));
  const frozenSum0 = frozenKeys.reduce((s, k) => s + (isUsableRatio(r[k]) ? r[k] : 0), 0);
  /**
   * **收起段份额上界**（第六轮裁决）：可见段与冻结份额**两侧都要落在可行域内**——
   * `Σ_{可见} min_v / 可用高 + S ≤ 1` ⇒ `S ≤ 1 − Σ(可见段可读下限)/可用高`
   * （`Σ(可见段下限)` = 收起视图之外那些视图各自下限之和；契约文字以 `min_i + min_d` 记，推导见报告 §14.1）。
   */
  const visibleMinSum = active.reduce((s, k) => s + mins[k], 0);
  /**
   * **浮点余量**（1px/可见段；仅**收起态**启用，未收起保持第五轮既有口径 ⇒ 既有读数逐 px 不回退）：
   * 要求展开后每个可见段的真实 px **严格高于**其下限（否则展开时 plan 会因 1e-10 级舍入误差
   * 误判「低于下限」而错误置位 `clamped`）。
   */
  const margin = frozenKeys.length > 0 ? 1 : 0;
  const sMax = 1 - (visibleMinSum + margin * active.length) / available;
  const needShrink = frozenKeys.length > 0 && frozenSum0 > sMax + 1e-9;
  if (needShrink && !(sMax > 0)) return { layout, repaired: false, unrepairable: true, frozenShrunk: false };
  const frozenShrunk = needShrink;
  const frozenRatios: Partial<ViewRatios> = {};
  for (const k of frozenKeys) {
    // **收缩 = 按比例缩放到上界**（份额可被归一修改，但**永不为 0**）
    frozenRatios[k] = frozenShrunk ? r[k] * (sMax / frozenSum0) : r[k];
  }
  const frozenSum = frozenShrunk ? sMax : frozenSum0;
  const share = 1 - frozenSum;
  const visibleOk = share > 0 && active.every((k) => r[k] * available >= mins[k] - 1);
  // 可见段已可行且无需收缩 ⇒ **逐位保留**（无抖动，既有读数不回退）
  if (visibleOk && !frozenShrunk) return unchanged;

  // 生效化：按**真实比例**口径夹取（下限 / share），再用夹取结果反推比例
  const scaled: ViewRatios | null =
    share > 0
      ? {
          kline: (mins.kline + margin) / share,
          indicators: (mins.indicators + margin) / share,
          detail: (mins.detail + margin) / share,
        }
      : null;
  const plan = planThreeViews({
    ratios: r,
    viewportH: 800,
    availablePx: available,
    subPaneCount: 0,
    collapsed: layout.collapsed,
    mins: scaled ?? mins,
  });
  const px: Record<ViewKey, number> = { kline: plan.klinePx, indicators: plan.indicatorsPx, detail: plan.detailPx };
  const out: Partial<ViewRatios> = {};
  for (const k of VIEW_KEYS) {
    if (!active.includes(k)) {
      out[k] = frozenRatios[k];
      continue;
    }
    const eff = share > 0 ? (share * px[k]) / available : px[k] / available;
    if (!isUsableRatio(eff)) return { layout, repaired: false, unrepairable: true, frozenShrunk: false };
    out[k] = eff;
  }
  const normalized = mergeViewRatios(out, {});
  // 归一后再次校验（舍入）：可见段可行 ∧ S 上界 ∧ 全段 > 0；不成立则回退原样（宁可不归一，也不产生不可行态）
  const sumFrozen = frozenKeys.reduce((s, k) => s + normalized[k], 0);
  const share2 = 1 - sumFrozen;
  const okAfter =
    share2 > 0 &&
    active.every((k) => normalized[k] * available >= mins[k] + margin - 1 && normalized[k] > 0) &&
    VIEW_KEYS.every((k) => normalized[k] > 0) &&
    (frozenKeys.length === 0 || sumFrozen <= sMax + 1 / available);
  if (!okAfter) return { layout, repaired: false, unrepairable: true, frozenShrunk: false };
  return {
    layout: { ratios: normalized, collapsed: { ...layout.collapsed } },
    repaired: true,
    unrepairable: false,
    frozenShrunk,
  };
}

export interface LayoutWriteResult {
  layout: ResultLayoutV2;
  repaired: boolean;
  unrepairable: boolean;
  /** 是否**收缩**了收起段份额（⇒ 必须 `clamped` + 披露，见第六轮裁决）。 */
  frozenShrunk: boolean;
}

export function writeResultLayoutDetailed(
  layout: ResultLayoutV2,
  storage: LayoutStorage | null = defaultLayoutStorage(),
  opts: { availablePx?: number; mins?: ViewRatios } = {},
): LayoutWriteResult {
  const legal: ResultLayoutV2 = {
    ratios: legalizeLayoutRatios(layout?.ratios, storage, layout?.collapsed),
    collapsed: {
      indicators: layout?.collapsed?.indicators === true,
      detail: layout?.collapsed?.detail === true,
    },
  };
  // **写入侧归一**（第五/六轮裁决）：落盘值必须是**生效态**（存储 == 渲染）⇒ 不再存不可行比例；
  // 收起态另需 `S ≤ 1 − Σ(可见段下限)/可用高` ⇒ 超出时**收缩**冻结份额并置披露标志。
  const n = normalizeLayoutToEffective(legal, opts);
  const persisted = n.layout;
  if (storage) {
    try {
      storage.setItem(RESULT_LAYOUT_STORAGE_KEY, JSON.stringify(persisted));
      // 收缩是**一次性事件** ⇒ 落瞬时通知键（跨挂载/刷新可复现披露；用户下一次交互清除）
      if (n.frozenShrunk) storage.setItem(RESULT_LAYOUT_NOTICE_STORAGE_KEY, FROZEN_SHARE_SHRINK_DISCLOSURE);
    } catch {
      // 写失败不得打断交互（刷新后回默认）
    }
  }
  return { layout: persisted, repaired: n.repaired, unrepairable: n.unrepairable, frozenShrunk: n.frozenShrunk };
}

export function writeResultLayout(
  layout: ResultLayoutV2,
  storage: LayoutStorage | null = defaultLayoutStorage(),
  opts: { availablePx?: number; mins?: ViewRatios } = {},
): ResultLayoutV2 {
  return writeResultLayoutDetailed(layout, storage, opts).layout;
}

