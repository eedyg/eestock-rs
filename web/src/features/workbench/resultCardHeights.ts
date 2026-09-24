/**
 * ADR-028 §2.6（**D6｜K 线卡尺寸与主视图优先分配**）—— 结果页 K 线卡高度 / pane 分配的**纯函数层**。
 *
 * 事实源（唯一出口，本文件不新增口径）：
 *  - `design/01-architecture/adr/ADR-028-…§2.6` 第 1/2/3/4/5/7 项（+ 2026-09-23「有效下限」裁决修正、
 *    「接口条款」）；
 *  - `design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md` §2 表 D6-1..D6-7、§4 边界、§3 清单。
 *
 * 几何真身（2026-09-23 冻结探针 `tester/evidence/20260923_result_ux_probe`，两点交叉一致）：
 *  - 卡 256 → 内层 194（candle 67 / VOL 100 / x 轴 26 / 分隔 1）
 *  - 卡 496 → 内层 434（candle 307 / VOL 100 / x 轴 26 / 分隔 1）
 *  ⇒ klinecharts 10.0.3 中 **candle 是唯一 flexible pane**（吃剩余高），其余 pane 高由各自
 *    `options.height`（默认 100）决定 ⇒ `主图 = 容器高 − x轴(26) − 分隔(1) − Σ副图`。
 *
 * 「有效下限」口径（ADR-028 §2.6 第 4 项裁决）：名义下限 200 保留，
 * **有效拖拽下限 = max(200, 卡头实高 + 1 + 26 + 160 + 30×副图数)**（副图有效下限 30px，保持可见不隐藏）。
 *
 * 本文件**无副作用**（storage 由调用方注入）、**不依赖 React / dashboard**（依赖方向 workbench → dashboard 不倒置）。
 */

/** 默认 K 线卡高（D6-1）。 */
export const DEFAULT_KLINE_PX = 520;
/** 名义下限（D6-2/D6-4）。 */
export const CARD_MIN_PX = 200;
/** 卡高上限相对视口高的余量：`max = 视口高 − 200`（保证明细区不被顶出屏幕，D6-2）。 */
export const CARD_MAX_VIEWPORT_MARGIN_PX = 200;
/** 头部预设 S/M/L（D6-2）。 */
export const CARD_HEIGHT_PRESETS = { s: 260, m: 420, l: 560 } as const;
export type CardHeightPresetKey = keyof typeof CARD_HEIGHT_PRESETS;

/** 蜡烛主图硬下限（卡高拖拽与引擎 pane 分隔条拖拽两条路径都受此约束，D6-4）。 */
export const KLINE_CANDLE_MIN_PX = 160;
/** 副图 pane 有效下限（保持可见，不隐藏，D6-4）。 */
export const SUB_PANE_MIN_PX = 30;
/** 副图 pane 引擎默认高（`options.height` 默认 100，真身读数）。 */
export const SUB_PANE_DEFAULT_PX = 100;
/** 默认 520 态副图**合计**上限（D6-3）。 */
export const SUB_PANE_TOTAL_MAX_PX = 120;
/** x 轴 pane 高（真身读数 26px，非可配；用于「有效下限」派生）。 */
export const KLINE_AXIS_PX = 26;
/** pane 分隔条高（真身读数 1px）。 */
export const PANE_SEPARATOR_PX = 1;
/**
 * 卡片自身边框占用（真身读数：上/下各 1px）。
 * 实测（2026-09-23，沙箱真身）：卡 237 − 卡头 20 − klinecharts 容器 215 = **2** ⇒ 有效下限必须计入，
 * 否则卡高到达下限时主图为 158 < 160（D6-4 硬下限失守 2px）。
 */
export const KLINE_CARD_BORDER_PX = 2;
/** 卡头实高兜底（未测量时；真渲染下由 DOM 实测覆盖）。 */
export const CARD_HEADER_FALLBACK_PX = 24;
/** 曲线卡下限（沿用既有结果页口径 `RESULT_CARD_MIN_PX`，本批不改）。 */
export const CURVE_CARD_MIN_PX = 120;

/**
 * 副图指标（占用**独立 pane** 的那些；`ma` 叠在主图上、不占 pane）。
 * 与 `KlineChart.syncIndicators` 的 pane 创建口径一致：除 `ma` 外均 `createIndicator(value, true)`。
 *
 * ADR-028 §2.9（D9）：副图数决定 K 线视图的**有效可读下限**（1 副图 299 / 2 副图 329）
 * ⇒ 该口径必须与 `KlineResultChart` / `useResultLayout` **共用同一处**（禁各自维护一份）。
 */
export const SUB_PANE_INDICATORS: readonly string[] = ['vol', 'macd', 'kdj', 'boll', 'dcap'];

/** 启用中的「独立 pane」指标数（`ma` 叠主图，不占 pane）。 */
export function subPaneCountFor(indicators: Record<string, boolean | undefined> | null | undefined): number {
  if (!indicators) return 0;
  return SUB_PANE_INDICATORS.reduce((n, k) => n + (indicators[k] ? 1 : 0), 0);
}
/** 记忆值合理上界（超出视为坏数据 ⇒ 回默认，禁把坏值当高）。 */
const CARD_PX_SANE_MAX = 4000;

/** 结果页**独立** key（D6-7；与看板 `eestock.dashboard.layout.v1` 无关）。 */
export const CARD_HEIGHT_STORAGE_KEY = 'eestock.result.cardHeights.v1';
/** 看板布局 key（**只用于「不得触碰」断言/文档**，本模块绝不读写它）。 */
export const DASHBOARD_LAYOUT_KEY = 'eestock.dashboard.layout.v1';
/** 旧结果页配置 key（含 `cardHeights`；**只读迁移源**，禁止写入）。 */
export const LEGACY_RESULT_CHART_CONFIG_KEY = 'eestock.wb.result.chartConfig.v1';

/** 注入式存储适配器（真环境 = `localStorage`；单测 = 内存实现）。 */
export interface CardHeightStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** 结果页可缩放卡片 id（kline = K 线卡；其余四张 = 曲线卡）。 */
export type CardHeightId = string;

export interface CardBounds {
  min: number;
  max: number;
}

/** 安全 default storage（`localStorage` 不可用/抛异常 ⇒ null ⇒ 调用方按默认渲染）。 */
export function defaultCardHeightStorage(): CardHeightStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 夹取（非法入参 ⇒ `null`，**禁止**落成 0 高/NaN）。 */
export function clampCardPx(px: unknown, bounds: CardBounds): number | null {
  if (typeof px !== 'number' || !Number.isFinite(px)) return null;
  const n = Math.round(px);
  const min = Number.isFinite(bounds.min) ? bounds.min : CARD_MIN_PX;
  const max = Number.isFinite(bounds.max) ? bounds.max : min;
  return Math.min(Math.max(min, max), Math.max(min, n));
}

/**
 * 有效下限（D6-4 裁决口径）：`max(200, 卡头实高 + 卡边框2 + 分隔1 + x轴26 + 160 + 30×副图数)`。
 * 其中「卡边框 2px」为真身实测补项（见 {@link KLINE_CARD_BORDER_PX}）：内层容器 = 卡高 − 卡头 − 2。
 */
export function effectiveMinCardPx(args: { headerPx?: number; subPaneCount: number }): number {
  const header = Math.max(0, Math.round(args.headerPx ?? CARD_HEADER_FALLBACK_PX));
  const subCount = Math.max(0, Math.floor(args.subPaneCount));
  const derived =
    header +
    KLINE_CARD_BORDER_PX +
    PANE_SEPARATOR_PX +
    KLINE_AXIS_PX +
    KLINE_CANDLE_MIN_PX +
    SUB_PANE_MIN_PX * subCount;
  return Math.max(CARD_MIN_PX, derived);
}

/** 卡片高度上下限：K 线卡用「有效下限 / 视口高 − 200」；曲线卡沿用既有 [120, 视口高 − 200]。 */
export function cardBoundsFor(args: {
  viewportH: number;
  headerPx?: number;
  subPaneCount: number;
  cardId?: CardHeightId;
}): CardBounds {
  const viewportH = Number.isFinite(args.viewportH) && args.viewportH > 0 ? args.viewportH : 800;
  const max = Math.max(CARD_MIN_PX, Math.round(viewportH - CARD_MAX_VIEWPORT_MARGIN_PX));
  if (args.cardId != null && args.cardId !== 'kline') {
    return { min: Math.min(CURVE_CARD_MIN_PX, max), max: Math.max(CURVE_CARD_MIN_PX, max) };
  }
  const min = effectiveMinCardPx({ headerPx: args.headerPx, subPaneCount: args.subPaneCount });
  return { min, max: Math.max(min, max) };
}

/** 记忆值 → 渲染高（坏数据/越界 ⇒ 默认 520，再按 bounds 夹取；**禁 NaN/0**）。 */
export function resolveCardPx(raw: unknown, bounds: CardBounds): number {
  const valid = typeof raw === 'number' && Number.isFinite(raw) && raw >= CARD_MIN_PX && raw <= CARD_PX_SANE_MAX;
  const base = valid ? (raw as number) : DEFAULT_KLINE_PX;
  return clampCardPx(base, bounds) ?? Math.max(bounds.min, Math.min(bounds.max, DEFAULT_KLINE_PX));
}

/**
 * 主图/副图分配（D6-3/D6-4 的**唯一**算术入口；容器高由调用方实测注入）。
 *
 * 规则（逐条对应 ADR §2.6 第 4 项）：
 *  1. 可用高 `avail = 容器高 − x轴(26) − 分隔(1)×副图数`（无副图时只减 x 轴）；
 *  2. 副图合计目标 = `min(副图数×100, 120)`，但**不得低于** `副图数×30`（保持可见）；
 *  3. 副图合计**不得挤掉主图硬下限**：合计 = `max(N×30, min(目标, avail − 160))`；
 *  4. 主图 = `avail − 副图合计`（引擎侧 candle 恒吃剩余高，见文件头真身）。
 *
 * `clamped` = 分配被下限/上限改写（副图低于引擎默认 100，或容器小到不可行）⇒ 调用方须可观测。
 */
export function planKlinePanes(args: { containerPx: number; subPaneCount: number }): {
  candlePx: number;
  subPanePx: number;
  subPaneTotalPx: number;
  clamped: boolean;
} {
  const containerPx = Number.isFinite(args.containerPx) && args.containerPx > 0 ? Math.round(args.containerPx) : 0;
  const subCount = Math.max(0, Math.floor(args.subPaneCount));
  const avail = Math.max(0, containerPx - KLINE_AXIS_PX - PANE_SEPARATOR_PX * subCount);
  if (subCount === 0) {
    return { candlePx: avail, subPanePx: 0, subPaneTotalPx: 0, clamped: false };
  }
  const subTotalWanted = Math.min(subCount * SUB_PANE_DEFAULT_PX, SUB_PANE_TOTAL_MAX_PX);
  const subTotalFloor = subCount * SUB_PANE_MIN_PX;
  const feasible = avail - KLINE_CANDLE_MIN_PX;
  const subTotal = Math.max(subTotalFloor, Math.min(subTotalWanted, feasible));
  const subPanePx = Math.max(SUB_PANE_MIN_PX, Math.floor(subTotal / subCount));
  const subPaneTotalPx = subPanePx * subCount;
  const candlePx = Math.max(0, avail - subPaneTotalPx);
  return {
    candlePx,
    subPanePx,
    subPaneTotalPx,
    clamped: subPanePx < SUB_PANE_DEFAULT_PX || candlePx < KLINE_CANDLE_MIN_PX,
  };
}

function parseHeightMap(raw: string | null): Record<string, unknown> | null {
  if (raw == null) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 净化单条记忆值：非有限 / < `CARD_MIN_PX` / > 合理上界 ⇒ `null`（调用方回默认）。 */
function sanitizeStoredHeight(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < CARD_MIN_PX || n > CARD_PX_SANE_MAX) return null;
  return n;
}

function writeMap(map: Record<string, unknown>, storage: CardHeightStorage): void {
  try {
    storage.setItem(CARD_HEIGHT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 写失败（配额/隐私模式）不得打断交互（UI 仍以内存态工作，刷新后回默认）
  }
}

/**
 * 读卡片记忆高（结果页独立 key）。
 * 迁移口径：新 key 无该卡记忆时，**只读**旧结果页 key 的 `cardHeights[cardId]`，合法则采信并回写新 key
 * （旧 key 内容**不动**）；不合法/缺失 ⇒ `null`（调用方回默认 520）。
 */
export function readCardHeight(cardId: CardHeightId, storage: CardHeightStorage | null = defaultCardHeightStorage()): number | null {
  if (!storage) return null;
  let own: Record<string, unknown> | null = null;
  try {
    own = parseHeightMap(storage.getItem(CARD_HEIGHT_STORAGE_KEY));
  } catch {
    own = null;
  }
  const direct = sanitizeStoredHeight(own?.[cardId]);
  if (direct != null) return direct;
  if (own != null && cardId in own) return null; // 有显式记录但值坏 ⇒ 不迁移、回默认
  // 迁移：旧结果页 key 的 cardHeights（只读）
  let legacy: Record<string, unknown> | null = null;
  try {
    legacy = parseHeightMap(storage.getItem(LEGACY_RESULT_CHART_CONFIG_KEY));
  } catch {
    legacy = null;
  }
  const legacyHeights = legacy?.['cardHeights'];
  if (legacyHeights == null || typeof legacyHeights !== 'object' || Array.isArray(legacyHeights)) return null;
  const migrated = sanitizeStoredHeight((legacyHeights as Record<string, unknown>)[cardId]);
  if (migrated == null) return null;
  writeMap({ ...(own ?? {}), [cardId]: migrated }, storage);
  return migrated;
}

/** 写卡片记忆高（`null` = 清除该卡记忆 ⇒ 回默认渲染）。 */
export function writeCardHeight(
  cardId: CardHeightId,
  px: number | null,
  storage: CardHeightStorage | null = defaultCardHeightStorage(),
): void {
  if (!storage) return;
  let own: Record<string, unknown> | null = null;
  try {
    own = parseHeightMap(storage.getItem(CARD_HEIGHT_STORAGE_KEY));
  } catch {
    own = null;
  }
  const next: Record<string, unknown> = { ...(own ?? {}) };
  const clean = sanitizeStoredHeight(px);
  if (clean == null) delete next[cardId];
  else next[cardId] = clean;
  writeMap(next, storage);
}
