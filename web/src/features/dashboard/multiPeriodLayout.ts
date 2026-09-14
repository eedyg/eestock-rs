/**
 * 多周期栈的**高度分配纯函数**（`design/15-multi-period/02-spec.md` §6；实施计划 P5）。
 *
 * 本文件位置：`web/src/features/dashboard/multiPeriodLayout.ts`
 *
 * 职责边界（严格）：
 *  - 纯计算（无 React、无 DOM、无副作用）⇒ 可单测、可预测；
 *  - 输入 = 各 pane 的**请求高度 px**（基准来自配置 `heights[periods[0]]`，卫星来自 `heights[period]`）
 *    + `main-chart` 的**可用高度 px**；输出 = 每 pane 的**分配高度 px**（整数）+ 退化状态。
 *
 * 为什么需要它（P2-C 实测缺陷：`tester/test/271_p2c_independent_acceptance_execution.md` §9）：
 * 旧实现把卫星按普通流追加（基准 `h-full` 拉满 600 + 3×180 卫星）⇒ `#main` clientHeight 600 /
 * scrollHeight 1140 ⇒ **540px 纵向溢出**。修法：由栈容器按可用高度**统一分配**，各 pane 高度之和
 * 恰等于可用高度（放不下时退化可滚动且**可观测**，绝不静默裁剪）。
 *
 * 判据口径（P5-A 红测试 `multiPeriodLayout.test.ts` A1–A15 钉死）：
 *  1. 请求值先净化：非有限/≤0 ⇒ 兜底（基准 420 / 卫星 180）；否则 round 并夹到 `[80, 1200]`；
 *  2. `available` 非有限或 ≤0 ⇒ `unavailable`：**保持净化后的请求高度**（不得猜默认值）；
 *  3. 需求 ≤ 可用 ⇒ `fit`：卫星直用请求值，**基准吸收余量**（Σ == 可用）；
 *  4. 需求 > 可用 ⇒ `shrunk`（统一比例 + 下限 + 残差修正；Σ == 可用）或
 *     `min-overflow`（连下限和都放不下 ⇒ 各 pane 取下限、`scrollable = true`；Σ == 下限和 > 可用）。
 */

/** 基准 pane 分配下限（px）。 */
export const BASE_MIN_HEIGHT = 200;
/** 卫星 pane 分配下限（px）。 */
export const SATELLITE_MIN_HEIGHT = 80;
/** 配置面 `heights` 取值域（与 P1 的 dto 校验一致：`[80, 1200]`）。 */
export const HEIGHT_MIN = 80;
export const HEIGHT_MAX = 1200;
/** 基准 pane 请求高度兜底（= 02-spec §6 默认 420）。 */
export const DEFAULT_BASE_HEIGHT = 420;
/** 卫星 pane 请求高度兜底（= 02-spec §6 默认 180）。 */
export const DEFAULT_SATELLITE_HEIGHT = 180;
/** 拖拽 → 持久化的防抖窗（ms）。 */
export const DRAG_DEBOUNCE_MS = 300;

/** 分配输入：一个 pane 的请求高度。 */
export interface StackPane {
  /** pane 身份键（= 周期；与 `periods` 一一对应）。 */
  key: string;
  period: string;
  /** 请求高度 px（配置 `heights[period]`；拖拽会改写本值）。 */
  requested: number;
  /** 是否基准（基准吸收余量且下限更高）。 */
  isBase: boolean;
  /**
   * 请求值来自**拖拽**（已按拖拽口径净化）⇒ 允许用拖拽期望值覆盖请求高度。
   *
   * 期望值仍被夹在**配置域** `[80, 1200]`（见 `sanitizeDragHeight`；02-spec §6.1 尾注，架构裁决
   * 2026-09-15）：`onHeightsChange` 的载荷会**逐字节**成为 `PUT /api/config/multi_period` 的 `heights`，
   * 而配置面校验（`crates/web/src/dto.rs`）只接受 `[80, 1200]` ⇒ 域外值会被 400 拒绝并回滚
   * （用户表现「拖了但没保存」）。
   *
   * 与**渲染侧分配下界**（基准 200 / 卫星 80）**不得混同**：那两个下限由 `distributeStackHeights`
   * 的缩小路径在「放不下」时保证（B6 钉死），而不是对期望值的域夹取。
   */
  fromDrag?: boolean;
}

/** 分配输出：一个 pane 的最终高度。 */
export interface StackPaneHeight {
  key: string;
  period: string;
  height: number;
  isBase: boolean;
}

export type StackLayoutReason = 'fit' | 'shrunk' | 'min-overflow' | 'unavailable';

export interface StackLayout {
  panes: StackPaneHeight[];
  /** Σ height（`fit`/`shrunk` ⇒ == 可用高度；`min-overflow` ⇒ == Σ 下限 > 可用；`unavailable` ⇒ == Σ 请求）。 */
  total: number;
  /** 需求 > 可用（发生过缩小），即使最终仍可完整放置。 */
  shrunk: boolean;
  /** 连最小高度都放不下 ⇒ 栈区域退化为可滚动（`overflow-y:auto`）；**可观测**，不静默裁剪。 */
  scrollable: boolean;
  reason: StackLayoutReason;
}

/** pane 分配下限（基准 200 / 卫星 80）。 */
function minFor(isBase: boolean): number {
  return isBase ? BASE_MIN_HEIGHT : SATELLITE_MIN_HEIGHT;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 单值净化：非有限值（NaN/±Infinity/undefined）或 ≤0 ⇒ 兜底（基准 420 / 卫星 180）；
 * 否则 `round` 并夹取到 `[HEIGHT_MIN, HEIGHT_MAX]`。
 * 字符串数字（如 `'180'`）按数字解析（配置来自 JSON，容错解析不得崩）。
 */
export function sanitizeRequestedHeight(value: unknown, isBase: boolean): number {
  const fallback = isBase ? DEFAULT_BASE_HEIGHT : DEFAULT_SATELLITE_HEIGHT;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return clamp(Math.round(n), HEIGHT_MIN, HEIGHT_MAX);
}

/**
 * 拖拽期望值的净化：非有限值或 ≤0 ⇒ 兜底（基准 420 / 卫星 180）；否则 `round` 并
 * 夹到**配置域** `[HEIGHT_MIN, HEIGHT_MAX]`（= `[80, 1200]`，与配置面校验同域；02-spec §6.1 尾注）。
 *
 * 为什么下界也夹（P5-D-1，2026-09-15）：拖拽改写的是**期望 px**，而期望 px 会被原样（`fit` 路径）
 * 取用为分配高度 ⇒ 成为 `PUT /api/config/multi_period` 的 `heights`；若期望值 < 80，配置面校验
 * （`dto.rs` 第 5 条）会 400 并回滚（用户表现「拖了但没保存」，实测可拖到 42px）。
 *
 * **不得**与渲染侧**分配下界**（基准 200 / 卫星 80，见 `BASE_MIN_HEIGHT` / `SATELLITE_MIN_HEIGHT`）
 * 混同：后者是「放不下时」的分配保证（`distributeStackHeights` 缩小路径），与此处的域夹取无关。
 */
export function sanitizeDragHeight(value: unknown, isBase: boolean): number {
  const fallback = isBase ? DEFAULT_BASE_HEIGHT : DEFAULT_SATELLITE_HEIGHT;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return clamp(Math.round(n), HEIGHT_MIN, HEIGHT_MAX);
}

function requestOf(pane: StackPane): number {
  return pane.fromDrag
    ? sanitizeDragHeight(pane.requested, pane.isBase)
    : sanitizeRequestedHeight(pane.requested, pane.isBase);
}

function build(
  panes: readonly StackPane[],
  heights: readonly number[],
): StackPaneHeight[] {
  return panes.map((p, i) => ({ key: p.key, period: p.period, height: heights[i]!, isBase: p.isBase }));
}

/**
 * 高度分配（纯函数；所有输出高度为**整数** px）。
 *
 * `available <= 0` / 非有限 ⇒ `unavailable`（保持请求高度：jsdom 无布局引擎时 `clientHeight` 恒 0，
 * 若在此伪造默认值，会把 P2 已验收的「卫星 inline height == `heights[period]`」假红）。
 */
export function distributeStackHeights(input: {
  panes: readonly StackPane[];
  available: number;
}): StackLayout {
  const { panes, available } = input;
  const requests = panes.map(requestOf);
  const requestedTotal = requests.reduce((a, b) => a + b, 0);

  if (!(typeof available === 'number' && Number.isFinite(available) && available > 0)) {
    return {
      panes: build(panes, requests),
      total: requestedTotal,
      shrunk: false,
      scrollable: false,
      reason: 'unavailable',
    };
  }
  if (panes.length === 0) {
    return { panes: [], total: 0, shrunk: false, scrollable: false, reason: 'fit' };
  }

  const H = Math.max(0, Math.round(available));

  // ① 放得下 ⇒ 卫星直用请求值，基准吸收余量（Σ == 可用）
  if (requestedTotal <= H) {
    const heights = [...requests];
    const baseIdx = panes.findIndex((p) => p.isBase);
    if (baseIdx >= 0) heights[baseIdx] = H - (requestedTotal - requests[baseIdx]!);
    else heights[heights.length - 1] = heights[heights.length - 1]! + (H - requestedTotal);
    return { panes: build(panes, heights), total: H, shrunk: false, scrollable: false, reason: 'fit' };
  }

  // ② 放不下：先看「连下限和都放不下」⇒ 退化可滚动（可观测，不静默裁剪）
  const mins = panes.map((p) => minFor(p.isBase));
  const minTotal = mins.reduce((a, b) => a + b, 0);
  if (minTotal > H) {
    return {
      panes: build(panes, mins),
      total: minTotal,
      shrunk: true,
      scrollable: true,
      reason: 'min-overflow',
    };
  }

  // ③ 统一比例缩小 + 下限 + 残差修正（Σ == 可用，且各方 ≥ 下限）
  const factor = H / requestedTotal;
  const heights = panes.map((_, i) => Math.floor(Math.max(mins[i]!, requests[i]! * factor)));
  let residual = H - heights.reduce((a, b) => a + b, 0);

  if (residual > 0) {
    // 残差为正：逐 px 加到「离请求值最近（可增空间最大）」的 pane；**基准优先**（设计口径 §2.1-4）。
    while (residual > 0) {
      let best = 0;
      for (let i = 1; i < panes.length; i++) {
        const roomI = requests[i]! - heights[i]!;
        const roomBest = requests[best]! - heights[best]!;
        if (roomI > roomBest || (roomI === roomBest && panes[i]!.isBase && !panes[best]!.isBase)) best = i;
      }
      heights[best] = heights[best]! + 1;
      residual -= 1;
    }
  } else if (residual < 0) {
    // 残差为负（下限撑破了 H）：从「可减空间最大（h − 下限）」的 pane 逐 px 扣。
    const order = panes
      .map((_, i) => i)
      .sort((a, b) => heights[b]! - mins[b]! - (heights[a]! - mins[a]!) || a - b);
    while (residual < 0) {
      let progressed = false;
      for (const i of order) {
        if (residual === 0) break;
        if (heights[i]! > mins[i]!) {
          heights[i] = heights[i]! - 1;
          residual += 1;
          progressed = true;
        }
      }
      // 数学上不可达（Σ(h − min) ≥ Σh − H = −residual）；防御性退出避免死循环。
      if (!progressed) break;
    }
  }

  return { panes: build(panes, heights), total: H, shrunk: true, scrollable: false, reason: 'shrunk' };
}

/** 布局高度按周期取出（拖拽持久化载荷 / store 回写用）。 */
export function heightsByPeriod(layout: StackLayout): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of layout.panes) out[p.period] = p.height;
  return out;
}

/**
 * **持久化载荷夹取**（`onHeightsChange` 的唯一出口；02-spec §6.2，架构裁决 2026-09-15）：
 * 每一项夹到配置域 `[HEIGHT_MIN, HEIGHT_MAX]`（= `[80, 1200]`，与 `crates/web/src/dto.rs` 的
 * `validate_multi_period_config` 第 5 条同域）。
 *
 * 为什么必须有（P5-E-1 缺陷）：`fit` 路径让**基准吸收余量**（`基准 = H − Σ卫星请求`）
 * ⇒ 可用高度 ≥ ~1201px 时**分配高度**可 > `HEIGHT_MAX`；若把分配结果原样当载荷，
 * `PUT /api/config/multi_period` 会被配置面 400 拒绝并回滚（用户表现「调大窗口后拖一下就保存失败」）。
 *
 * **只夹载荷，不动渲染分配**：分配必须保持 `Σ == 可用高度` 不变量（强行夹分配会破坏它）；
 * 故口径为 `payload == clamp(DOM 末次分配高度, 80, 1200)`——分配本就在域内时即为逐值相等。
 */
export function toPersistableHeights(heights: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const period of Object.keys(heights)) {
    out[period] = clamp(Math.round(heights[period]!), HEIGHT_MIN, HEIGHT_MAX);
  }
  return out;
}

/**
 * 拖拽一步：把「相邻两 pane 的期望 px」按鼠标纵向位移改写（上 pane += delta，下 pane −= delta），
 * 再由 `distributeStackHeights` 统一分配。
 *
 * 之所以「改写期望值 + 重跑分配」而不是「直接改分配结果」：分配算法本身就是**唯一**的高度权威
 * （下限/比例/残差/退化都由它保证），拖拽不得绕过它；后果是：
 *  - 未触界时相邻两者互补、其它 pane 不变（期望值之和不变 ⇒ 比例带不动其它 pane）；
 *  - 触界时（如基准已到下限）由算法把余量交给另一个 pane、并把其它 pane 压向下限（不越界、不溢出）。
 */
export function dragPair(
  base: Record<string, number>,
  upper: string,
  lower: string,
  delta: number,
): Record<string, number> {
  const up = base[upper];
  const low = base[lower];
  if (!Number.isFinite(up) || !Number.isFinite(low) || !Number.isFinite(delta) || delta === 0) return { ...base };
  return { ...base, [upper]: up! + delta, [lower]: low! - delta };
}
