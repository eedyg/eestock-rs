/**
 * `ChartSyncGroup` —— 多周期**跨图同步原语**（`design/15-multi-period/02-spec.md` §3；ADR-022 §2.3）。
 *
 * 职责：把 N 个 klinecharts 实例按**时间跨度**对齐（口径 8）。只有交互源（leader）驱动广播，
 * 其余实例（follower）被单向写入；写入期间/紧随其后的回传事件被**抑制**（P7b 实测：单次滚动即
 * `reentrantCalls=1`）⇒ 无回声、无漂移。
 *
 * 关键实测锚定（P0.3 `tester/test/260_p03_barspace_anchor_execution.md`，**不得重新发现**）：
 *  - klinecharts 10.0.3 **无** `setVisibleRange`；可用 `getVisibleRange / scrollToTimestamp /
 *    scrollToDataIndex / setBarSpace / subscribeAction('onScroll'|'onZoom'|'onVisibleRangeChange')`；
 *  - `setBarSpace(space)` 越界（∉ `barSpaceLimit`）**静默 return**（零告警）⇒ 写入后**必须读回校验**，
 *    不一致即**显式降级**（禁止静默留在旧值）；
 *  - `barSpaceLimit` **无运行时 setter** ⇒ 放宽只能在卫星 `init({layout:{barSpaceLimit}})` 完成
 *    （`MultiPeriodChartSatellite` → `KlineChart` 的 `barSpaceLimit` prop）；**基准不放宽**（ADR-020 不变）；
 *  - `getOffsetRightDistance()` 是**像素**量级（实测 bs=1/2/5/8/20 → 8/16/40/64/160 px）⇒ 右端对齐必须
 *    补偿右偏移（本组统一置 0，`setOffsetRightDistance(0)`；`ChartImp.scrollToDataIndex` 按
 *    `_lastBarRightSideDiffBarCount` 定位 ⇒ 偏移为 0 时右缘才是"最右 bar"）；
 *  - `scrollToTimestamp(ts) = scrollToDataIndex(binarySearchNearest(ts))` ⇒ 落点是**右缘**（不是居中，
 *    02-spec §3.2 的 `center` 表述按实测修正为**边缘对齐**）；
 *  - `satBS ≫ pane 宽` ⇒ `getVisibleRange()` 返回 **NaN** ⇒ 必须显式降级（不崩、不静默）；
 *  - **barSpace 必须用实测密度比 D**（非名义周期比）：1m→5m 4.7 / 1m→15m 12.2 / 1m→1h 37.8 /
 *    1d→1w 4.67 / 1h→1w 24（名义比 7 在 1d↔1w 下必超容差）。
 *
 * 诚实降级（用户裁决 2026-09-14，方案 1）：推导出的 `satBS` 容不下 ≥2 根时 ⇒ 取「能容纳 ≥2 根的
 * 最大 barSpace」= `floor(paneWidth/2)`、右端对齐、置 `degraded`（UI 侧角标「对齐受限」）；
 * **严禁静默虚假对齐**（口径 8 的"跨度 ≤1 根高周期 bar"会被"卫星仅 1 根"的退化态虚假满足）。
 *
 * ── P3-D-2 口径修订（架构裁决 2026-09-14；真渲染证据 `coder/report/275_p3d2_align_index_closedloop.md`）──
 *  1. **索引定位**：不再用 `scrollToTimestamp`（真身落点恒距右缘 2 根且 `setOffsetRightDistance(0)` 无法消除），
 *     改为在 follower 自身数据上二分出目标索引后用 `scrollToDataIndex` 定位；
 *  2. **有界闭环校正**：读回 `getVisibleRange()` 算残差（以 follower 自身 bar 为单位），受限校正；
 *     迭代上限 `MAX_ALIGN_CORRECTION_ITERATIONS`（=3：定位 1 次 + 校正 ≤2 次）、单步幅度上限
 *     `MAX_BAR_SPACE_STEP_RATIO`、确定性、震荡/无改善即停手（**禁止无界重试**）；
 *  3. **判据**（分路径，均**以 follower 自身 bar 为单位**）：
 *     · **对齐成功路径**（可对齐）：跨度差 ≤1 根 **且** 右端差 ≤1 根 **且** follower 可见 bar ≥2（原口径，**不放宽**）；
 *     · **降级路径**（仅当 reachability 探针证明不可达）：可见 bar ≥2 + 右端差 ≤1 根 + `degraded`/`degradedPeriod`
 *       + 角标 + 统计可读，并把**实测可达下界**（`stats.spanResidualBars`）作为记录项（例：1m↔1h 退化容量受限 ≈2.37 根，
 *       真 1m 下 ≈2.95 根 —— 引擎把 barSpace 夹到 ~300、可见恒 4 根）；
 *       **fail-closed**：必须先尝试完整对齐，仅当探针证明不可达才降级，**降级态不得宣称已对齐**；
 *  4. **barSpace 是初始估计而非契约**：密度推导值 `idealBarSpace` 之后，闭环会在受限范围内微调
 *     （记录于 `stats.barSpaceAdjust` = 最终值 − 推导值）；未对齐/降级均不得静默；
 *  5. 【硬约束】**基准实例永不作为 follower**（ADR-020）：基准视口只由容器宽/视口根数与**用户手势**决定，
 *     不得被卫星同步**反向改写**；用户在**卫星**上拖动/缩放 ⇒ 以该卫星为 leader，仅对齐**其它卫星**，基准保持不动。
 *     唯一的基准重定位路径是显式的「回到最新」（`scrollAllToLatest`，不写 barSpace）。
 */

/** 同步所需的最小 chart 面（klinecharts `Chart` 结构兼容；测试用忠实桩同样满足）。 */
export interface SyncChartApi {
  getBarSpace?: () => { bar: number; halfBar?: number; gapBar?: number; halfGapBar?: number };
  setBarSpace?: (space: number) => void;
  getSize?: (paneId?: string, position?: unknown) => { width: number; height: number } | null | undefined;
  getVisibleRange?: () => { from: number; to: number; realFrom: number; realTo: number };
  getDataList?: () => Array<{ timestamp: number }>;
  scrollToTimestamp?: (timestamp: number, animationDuration?: number) => void;
  scrollToDataIndex?: (dataIndex: number, animationDuration?: number) => void;
  scrollToRealTime?: () => void;
  getOffsetRightDistance?: () => number;
  setOffsetRightDistance?: (distance: number) => void;
  subscribeAction?: (type: string, callback: (payload?: unknown) => void) => void;
  unsubscribeAction?: (type: string, callback?: (payload?: unknown) => void) => void;
}

/** 同步组成员（`isBase` 唯一 = 基准 K 线实例）。 */
export interface SyncMember {
  id: string;
  chart: SyncChartApi;
  period: string;
  isBase: boolean;
}

export interface ChartSyncGroupOptions {
  /** 卫星 `barSpace` 上限（P0.3 锚定 350；默认 50 会静默吞掉大倍率）。 */
  satelliteMaxBarSpace?: number;
  /** 重入抑制（默认 **true**；`false` 仅用于反向证据，生产不得使用）。 */
  reentrySuppression?: boolean;
  /** 追加密度比条目（`"base:sat" → D`；测试/扩展用，默认空）。 */
  densityTable?: Record<string, number>;
}

export interface SyncStats {
  /** 成功完成的对齐广播次数（每次 leader 事件）。 */
  applied: number;
  /** 被抑制的**非交互**回传事件数（重入/程序化写入）。 */
  suppressed: number;
  /** 跟随者回传**被反向镜像处理**的次数（抑制开启时恒 0）。 */
  echoEvents: number;
  /** 最近一次对齐的两侧日历跨度差（分钟，一位小数）；无可读窗口 ⇒ null（不得伪造 0）。 */
  lastSpanDiffMinutes: number | null;
  /** 「对齐受限」降级标志（最近一次对齐里任一跟随者降级）。 */
  degraded: boolean;
  /** 退化的跟随者周期（正常 null）。**base 作为 follower 时此处即基准周期**。 */
  degradedPeriod: string | null;
  /**
   * P3-D-2 可观测：最近一次对齐里**未能对齐**的跟随者数（未布局/无数据/无可用密度锚点/容差不可达）。
   * >0 即表示存在**被跳过**的跟随者 ⇒ 必须与 `degraded`/原因一起可读（**禁止静默虚假对齐**）。
   */
  unalignedFollowers: number;
  /** 最近一次未对齐的原因（`<period>:<reason>`；无 ⇒ null）。 */
  lastUnalignedReason: string | null;
  /** 最近一次对齐的闭环迭代次数（1 = 一次索引定位即收敛；上限 `MAX_ALIGN_CORRECTION_ITERATIONS`）。 */
  lastCorrectionIterations: number;
  /**
   * P3-D-2 可观测：最近一次对齐的**跨度残差**（以 follower 自身 bar 为单位；最差者；读不到 ⇒ null）。
   * 降级路径（容差不可达）时必须记录**实测可达下界**（例：1m↔1h 退化容量受限下 ≈2.37 根）。
   */
  spanResidualBars: number | null;
  /** P3-D-2 可观测：最近一次对齐的**右端残差**（以 follower 自身 bar 为单位；最差者；读不到 ⇒ null）。 */
  edgeResidualBars: number | null;
  /**
   * P3-D-2 可观测：**barSpace 微调量**（= 最终 follower barSpace − 密度推导值 `idealBarSpace`；无调整 ⇒ 0）。
   * 密度值是**初始估计**而非契约：闭环为把残差压到最小会在**受限**范围内微调（≤2 次、每步幅度受限、确定性）。
   */
  barSpaceAdjust: number;
}

/**
 * 有界闭环校正的**迭代上限**（P3-D-2）：索引定位 1 次 + 最多 2 次受限校正。
 * 超过即**停手**并置 `degraded`（**禁止无界重试**；残差不下降/候选重复即提前停手）。
 */
export const MAX_ALIGN_CORRECTION_ITERATIONS = 3;

/** barSpace 微调的**单步幅度上限（相对当前值的比例）**：防止一次跳过多个邻域候选（震荡/不可解释）。 */
export const MAX_BAR_SPACE_STEP_RATIO = 0.5;

export interface AlignResult {
  /** `round(baseBarSpace × density)`（不变；降级时 `barSpace !== idealBarSpace`）。 */
  idealBarSpace: number;
  /** 实际下发/可下发的 barSpace。 */
  barSpace: number;
  degraded: boolean;
  degradedReason: 'base-zoom' | 'limit' | null;
  /** `floor(paneWidthPx / barSpace)`（口径 8 的第二道判据：必须 ≥2）。 */
  visibleBars: number;
}

export interface DensityResolver {
  ratio: number | null;
  source: 'measured' | 'static' | 'none';
}

/** 卫星 `barSpaceLimit.max` 建议值（P0.3 §2.3：1d→1w 需 233–280，取 350 留余量）。 */
export const SATELLITE_MAX_BAR_SPACE = 350;
/** 基准 `barSpaceLimit.max`（ADR-020 严格：`barSpace ∈ [1,50]`；放宽**只作用于卫星**）。 */
export const BASE_MAX_BAR_SPACE = 50;
/** 应用同步后的抑制窗（≥1 帧/16ms；P7b 重入实测）。 */
export const SUPPRESSION_WINDOW_MS = 16;

/** 周期桶宽（ms；`1mo` 不提供 —— 用户裁决）。 */
export const PERIOD_BUCKET_MS: Readonly<Record<string, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

/**
 * **实测密度比**表（P0.3 锚定；pane 宽 520px）——`D = 同窗基准 bar 数 / 卫星 bar 数`。
 * ⚠️ 非名义周期比：1d→1w 名义 7 而实测 4.67（名义比会超容差）。
 */
export const MEASURED_DENSITY_TABLE: Readonly<Record<string, number>> = {
  '1m:5m': 4.7,
  '1m:15m': 12.2,
  '1m:1h': 37.8,
  '1d:1w': 4.67,
  '1h:1w': 24,
};

/** 周期桶宽（未知周期 ⇒ null；调用方不得按名义比兜底）。 */
export function periodBucketMs(period: string): number | null {
  const b = PERIOD_BUCKET_MS[period];
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : null;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampIndex(v: number, max: number): number {
  if (!isNum(v)) return 0;
  const i = Math.round(v);
  return i < 0 ? 0 : i > max ? max : i;
}

/**
 * 静态锚定密度比（同周期 = 1）。**表外 ⇒ null**（`1m↔1w` / `1m↔1d` / 含 `1mo` 等），
 * **禁止按名义周期比兜底**（口径 8 的反向证据）。
 */
export function densityRatio(basePeriod: string, satellitePeriod: string): number | null {
  if (basePeriod === satellitePeriod) return 1;
  const d = MEASURED_DENSITY_TABLE[`${basePeriod}:${satellitePeriod}`];
  return isNum(d) && d > 0 ? d : null;
}

/**
 * 运行时密度估计器：同一时间窗内 `baseBarCount / satBarCount`。
 * 失效面（P0.3 §6-I5）：任一侧缺失/为 0，或**卫星 ≤1 根**（可见根数不足以定标）⇒ **null**
 * （不得按 0/名义比兜底）。
 */
export function estimateDensityRatio(input: { baseBarCount: number; satBarCount: number }): number | null {
  const { baseBarCount, satBarCount } = input;
  if (!isNum(baseBarCount) || baseBarCount <= 0) return null;
  if (!isNum(satBarCount) || satBarCount <= 1) return null;
  const ratio = baseBarCount / satBarCount;
  return isNum(ratio) && ratio > 0 ? ratio : null;
}

/**
 * 密度比解析：可用的实测值优先（`source='measured'`）；否则回退**静态锚定表**（`source='static'`）；
 * 表外 ⇒ `{ratio:null, source:'none'}`（显式不可用，**不静默兜底**）。非法实测值（0/负/NaN）视同失效。
 */
export function resolveDensityRatio(
  basePeriod: string,
  satellitePeriod: string,
  measured: number | null,
): DensityResolver {
  if (isNum(measured) && measured > 0) return { ratio: measured, source: 'measured' };
  const stat = densityRatio(basePeriod, satellitePeriod);
  return stat === null ? { ratio: null, source: 'none' } : { ratio: stat, source: 'static' };
}

/**
 * 卫星 `barSpace` 推导 + **诚实降级**（口径 8/9 + 用户裁决方案 1）：
 *  - `idealBarSpace = round(baseBarSpace × density)`；
 *  - `ideal > floor(paneWidthPx/2)`（**容不下 ≥2 根**）⇒ `barSpace = floor(paneWidthPx/2)`、`reason='base-zoom'`；
 *  - 否则 `ideal > maxBarSpace`（卫星上限不足）⇒ `barSpace = maxBarSpace`、`reason='limit'`；
 *  - `visibleBars = floor(paneWidthPx / barSpace)`（退化时必须仍 ≥2；**不得**照用 `ideal`）。
 */
export function alignSatelliteBarSpace(input: {
  baseBarSpace: number;
  density: number;
  paneWidthPx: number;
  maxBarSpace: number;
}): AlignResult {
  const { baseBarSpace, density, paneWidthPx, maxBarSpace } = input;
  const idealRaw = isNum(baseBarSpace) && isNum(density) ? Math.round(baseBarSpace * density) : 0;
  const idealBarSpace = Math.max(1, idealRaw);
  const capacity = Math.max(1, Math.floor(paneWidthPx / 2)); // 能容纳 ≥2 根的最大 barSpace
  const hardMax = isNum(maxBarSpace) && maxBarSpace >= 1 ? Math.floor(maxBarSpace) : 1;

  let barSpace = idealBarSpace;
  let degraded = false;
  let degradedReason: AlignResult['degradedReason'] = null;

  if (idealBarSpace > capacity) {
    barSpace = capacity;
    degraded = true;
    degradedReason = 'base-zoom';
  } else if (idealBarSpace > hardMax) {
    barSpace = hardMax;
    degraded = true;
    degradedReason = 'limit';
  }
  barSpace = Math.max(1, barSpace);
  const visibleBars = Math.max(0, Math.floor(paneWidthPx / barSpace));
  return { idealBarSpace, barSpace, degraded, degradedReason, visibleBars };
}

/**
 * 右偏移镜像：`getOffsetRightDistance()` 是**像素**量级（P0.3 §6-I6：bs=1/2/5/8/20 → 8/16/40/64/160）
 * ⇒ 直接透传基准 px ≠ 同一时间偏移，必须按 barSpace **倍率**换算。
 */
export function mirrorRightOffsetPx(baseOffsetRightPx: number, spaceRatio: number): number {
  if (!isNum(baseOffsetRightPx) || !isNum(spaceRatio)) return 0;
  const px = baseOffsetRightPx * spaceRatio;
  return isNum(px) ? Math.round(px) : 0;
}

/** 周期序（同序才可比较；未知周期 ⇒ null）。 */
function periodOrder(period: string): number | null {
  const order: Readonly<Record<string, number>> = {
    '1m': 1,
    '5m': 2,
    '15m': 3,
    '1h': 4,
    '1d': 5,
    '1w': 6,
  };
  return order[period] ?? null;
}

/**
 * 组合护栏（口径 10 + P0.3 量化）：拒绝 `1m↔1w`（恒退化：任何基准缩放下卫星仅 1 根）、`1m↔1d`
 * （无重叠）、卫星周期 < 基准、含 `1mo`；`1w` 仅基准 ≥1d 开放；表内锚定组合与同周期放行。
 */
export function isSyncCombinationAllowed(basePeriod: string, satellitePeriod: string): boolean {
  const a = periodOrder(basePeriod);
  const b = periodOrder(satellitePeriod);
  if (a === null || b === null) return false; // 含 1mo / 未知周期
  if (b < a) return false; // 卫星周期必须 ≥ 基准
  if (satellitePeriod === '1w' && a < (periodOrder('1d') as number)) return false; // 1w ⇒ 基准 ≥ 1d
  if (basePeriod === satellitePeriod) return true; // 口径 2：允许等于基准
  return densityRatio(basePeriod, satellitePeriod) !== null;
}

/** 周期 → 各锚点密度因子（用于跨卫星组合的密度合成；同一锚点内才可比）。 */
function densityFactors(): Record<string, Record<string, number>> {
  const factors: Record<string, Record<string, number>> = {};
  const put = (period: string, anchor: string, factor: number) => {
    const m = factors[period] ?? {};
    m[anchor] = factor;
    factors[period] = m;
  };
  for (const [key, d] of Object.entries(MEASURED_DENSITY_TABLE)) {
    const [base, sat] = key.split(':');
    if (base === undefined || sat === undefined) continue;
    put(sat, base, d);
    put(base, base, 1);
  }
  return factors;
}

/** 同锚点密度合成（例：15m→1h = D(1m→1h)/D(1m→15m)）；无公共锚点 ⇒ null。 */
function composeDensity(basePeriod: string, satellitePeriod: string): number | null {
  const factors = densityFactors();
  const a = factors[basePeriod];
  const b = factors[satellitePeriod];
  if (!a || !b) return null;
  for (const anchor of Object.keys(a)) {
    const fa = a[anchor];
    const fb = b[anchor];
    if (isNum(fa) && isNum(fb) && fa > 0 && fb > 0) return fb / fa;
  }
  return null;
}

/** 二分：ts 列表里第一条 `timestamp >= ts` 的下标（越界 ⇒ length）。 */
export function lowerBoundByTs(list: ReadonlyArray<{ timestamp: number }>, ts: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const item = list[mid];
    if (item !== undefined && item.timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 统计 ts 窗 `[fromTs, toTs]` 内的 bar 数（二分求解，名义比不成立 ⇒ 只认 ts 窗）。 */
export function countBarsInWindow(
  list: ReadonlyArray<{ timestamp: number }>,
  fromTs: number,
  toTs: number,
): number {
  if (list.length === 0 || !isNum(fromTs) || !isNum(toTs) || toTs < fromTs) return 0;
  const start = lowerBoundByTs(list, fromTs);
  const end = lowerBoundByTs(list, toTs + 1);
  return Math.max(0, end - start);
}

/**
 * 与 `ts` **最接近**的 bar 索引（真身 `binarySearchNearest` 口径：精确命中取该索引，等距取靠前）。
 * P3-D-2 的**索引定位**即据此把 leader 的目标时间窗映射到 follower 自身数据的索引（不依赖
 * `scrollToTimestamp` 的落点语义 —— 后者在真身恒距右缘 2 根且 `setOffsetRightDistance(0)` 无法消除）。
 */
export function nearestIndexByTs(list: ReadonlyArray<{ timestamp: number }>, ts: number): number {
  if (list.length === 0 || !isNum(ts)) return 0;
  const lo = lowerBoundByTs(list, ts);
  if (lo <= 0) return 0;
  if (lo >= list.length) return list.length - 1;
  const hiBar = list[lo];
  const loBar = list[lo - 1];
  const hiTs = hiBar?.timestamp;
  const loTs = loBar?.timestamp;
  if (!isNum(hiTs)) return Math.max(0, lo - 1);
  if (!isNum(loTs)) return lo;
  return Math.abs(hiTs - ts) < Math.abs(ts - loTs) ? lo : lo - 1;
}

interface VisibleWindow {
  fromTs: number;
  toTs: number;
  spanMs: number;
  bars: number;
}

const SYNC_ACTIONS: readonly string[] = ['onScroll', 'onZoom', 'onVisibleRangeChange'];

/**
 * 跨图同步组。**无 UI**；只读写 klinecharts 公开面。
 *
 * 生命周期：`new ChartSyncGroup(members)`（成员组合不可用 ⇒ 构造即抛错）→ `start()` → `stop()`。
 * 可观测：`stats` + `onChange(cb)`（UI 角标/store 的数据源）。
 */
export class ChartSyncGroup {
  private readonly members: SyncMember[];
  private readonly satelliteMaxBarSpace: number;
  private readonly suppressionEnabled: boolean;
  private readonly extraDensityTable: Record<string, number>;
  private readonly statsObj: SyncStats = {
    applied: 0,
    suppressed: 0,
    echoEvents: 0,
    lastSpanDiffMinutes: null,
    degraded: false,
    degradedPeriod: null,
    unalignedFollowers: 0,
    lastUnalignedReason: null,
    lastCorrectionIterations: 0,
    spanResidualBars: null,
    edgeResidualBars: null,
    barSpaceAdjust: 0,
  };
  private readonly listeners = new Set<(stats: SyncStats) => void>();
  /** 成员 id → 已知 `barSpace` 上限（基准恒 50；卫星首次被静默吞掉时**探测**真实上限）。 */
  private readonly caps = new Map<string, number>();
  private readonly subscriptions: Array<{ member: SyncMember; type: string; handler: () => void }> = [];
  private started = false;
  /** 应用同步的嵌套深度（>0 ⇒ 回传事件属于重入）。 */
  private applyDepth = 0;
  /** 程序化写入深度（实时跟随/回到最新；此窗内的图表事件不属于用户交互）。 */
  private programmaticDepth = 0;
  private suppressUntil = 0;
  private lastLeaderId: string | null = null;

  constructor(members: SyncMember[], options: ChartSyncGroupOptions = {}) {
    this.members = [...members];
    this.satelliteMaxBarSpace = options.satelliteMaxBarSpace ?? SATELLITE_MAX_BAR_SPACE;
    this.suppressionEnabled = options.reentrySuppression !== false;
    this.extraDensityTable = { ...(options.densityTable ?? {}) };

    // 护栏：基准 ↔ 每个卫星的周期组合必须可用（恒退化组合直接拒绝，禁止静默虚假对齐）。
    const base = this.members.find((m) => m.isBase);
    if (base) {
      for (const m of this.members) {
        if (m === base) continue;
        if (!isSyncCombinationAllowed(base.period, m.period)) {
          throw new Error(
            `多周期同步组合不可用：基准 ${base.period} ↔ 卫星 ${m.period} 恒退化/无重叠（禁止静默虚假对齐）`,
          );
        }
      }
    }
    for (const m of this.members) this.caps.set(m.id, m.isBase ? BASE_MAX_BAR_SPACE : this.satelliteMaxBarSpace);
  }

  get stats(): SyncStats {
    return this.statsObj;
  }

  /** 订阅同步统计（返回退订函数）。 */
  onChange(cb: (stats: SyncStats) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * 卫星 `barSpaceLimit` 应用/校验（口径 9）：klinecharts **无运行时 setter** ⇒ 真正的放宽在卫星
   * `init({layout:{barSpaceLimit:{min:1,max:350}}})`（`KlineChart` 的 `barSpaceLimit` prop）完成。
   * 本方法登记每个成员的**声明上限**（基准恒 50 ⇒ **不放宽，ADR-020 严格**）；首次对齐若写入被
   * 静默吞掉，则**探测真实上限**并显式降级（`reason='limit'`）——绝不静默留在旧值。
   */
  applySatelliteLimits(): void {
    for (const m of this.members) {
      this.caps.set(m.id, m.isBase ? BASE_MAX_BAR_SPACE : this.satelliteMaxBarSpace);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const m of this.members) {
      const chart = m.chart;
      if (typeof chart.subscribeAction !== 'function') continue;
      for (const type of SYNC_ACTIONS) {
        const handler = () => this.handleEvent(m);
        try {
          chart.subscribeAction(type, handler);
        } catch {
          continue;
        }
        this.subscriptions.push({ member: m, type, handler });
      }
    }
  }

  stop(): void {
    this.started = false;
    for (const s of this.subscriptions) {
      try {
        s.member.chart.unsubscribeAction?.(s.type, s.handler);
      } catch {
        /* 退订失败不应打断拆卸（零残留由容器卸载兜底） */
      }
    }
    this.subscriptions.length = 0;
    this.applyDepth = 0;
  }

  /** 程序化写入标记（实时跟随 / 回到最新）：此窗内的图表事件不是用户交互 ⇒ 不作为 leader。 */
  beginProgrammatic(): void {
    this.programmaticDepth += 1;
  }

  endProgrammatic(): void {
    if (this.programmaticDepth > 0) this.programmaticDepth = 0;
  }

  /** 「回到最新」：所有成员右端对齐（各自末根 bar + 右偏移归零 ⇒ 右缘同刻度）。 */
  scrollAllToLatest(): void {
    this.applyDepth += 1;
    try {
      this.zeroRightOffsets(this.members);
      for (const m of this.members) {
        const chart = m.chart;
        if (typeof chart.getDataList !== 'function') continue;
        const list = chart.getDataList();
        if (!Array.isArray(list) || list.length === 0) continue;
        const lastIndex = list.length - 1;
        try {
          if (typeof chart.scrollToDataIndex === 'function') chart.scrollToDataIndex(lastIndex);
          else chart.scrollToRealTime?.();
        } catch {
          /* 单个实例失败不阻塞其余成员 */
        }
      }
      this.statsObj.applied += 1;
    } finally {
      this.applyDepth -= 1;
      if (this.applyDepth === 0) this.suppressUntil = Date.now() + SUPPRESSION_WINDOW_MS;
      this.broadcast();
    }
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private handleEvent(member: SyncMember): void {
    if (!this.started) return;
    if (this.programmaticDepth > 0) {
      // 程序化写入（非用户交互）⇒ 不作为 leader（否则跨周期实时跟随会互相拉扯）
      this.statsObj.suppressed += 1;
      return;
    }
    if (this.applyDepth > 0) {
      if (this.suppressionEnabled) {
        this.statsObj.suppressed += 1; // 重入：应用同步期间 follower 回传的事件被丢弃
        return;
      }
      this.statsObj.echoEvents += 1; // 反向旋钮：观察到回声（真实镜像一级，防止无界回声）
      if (this.applyDepth <= 1) this.alignFrom(member);
      return;
    }
    if (
      this.suppressionEnabled &&
      Date.now() < this.suppressUntil &&
      member.id !== this.lastLeaderId
    ) {
      this.statsObj.suppressed += 1;
      return;
    }
    this.alignFrom(member);
  }

  /** 以 `leader` 的可见时间窗对齐其余成员（单向广播：leader → followers）。 */
  private alignFrom(leader: SyncMember): void {
    this.applyDepth += 1;
    this.lastLeaderId = leader.id;
    let degraded = false;
    let degradedPeriod: string | null = null;
    let spanDiffMinutes: number | null = null;
    let applied = false;
    let unaligned = 0;
    let lastUnalignedReason: string | null = null;
    let iterations = 0;
    let spanResidualBars: number | null = null;
    let edgeResidualBars: number | null = null;
    let barSpaceAdjust = 0;
    try {
      // 【硬约束（架构裁决 2026-09-14）】**基准实例永不作为 follower**：
      // 基准图（ADR-020）的视口只由容器宽/视口根数与**用户手势**决定，不得被卫星同步**反向改写**。
      // 用户在**卫星**上拖动/缩放 ⇒ 以该卫星为 leader，仅对齐**其它卫星**，基准保持不动。
      const targets = this.members.filter((m) => m !== leader && !m.isBase);
      // 右偏移归零必须在**读取 leader 窗口之前**：真身 `scrollToDataIndex` 按 `_lastBarRightSideDiffBarCount`
      // 定位 ⇒ 偏移不为 0 时"最右可见 bar"不等于右缘 bar（P0.3 §6-I6）。
      // 未参与本次对齐的成员（如卫星做 leader 时的基准）**不写**（基准保持不动）。
      this.zeroRightOffsets([leader, ...targets]);

      const leaderWindow = this.readWindow(leader);
      const leaderBarSpace = this.barSpaceOf(leader);
      if (!leaderWindow || !isNum(leaderBarSpace) || leaderBarSpace <= 0) {
        // 视口读数失效（`satBS ≫ pane 宽` ⇒ NaN）：显式降级，绝不静默
        this.statsObj.degraded = true;
        this.statsObj.degradedPeriod = leader.period;
        this.statsObj.lastSpanDiffMinutes = null;
        this.statsObj.unalignedFollowers = targets.length;
        this.statsObj.lastUnalignedReason = `${leader.period}:leader-window`;
        this.statsObj.lastCorrectionIterations = 0;
        this.statsObj.spanResidualBars = null;
        this.statsObj.edgeResidualBars = null;
        this.statsObj.barSpaceAdjust = 0;
        return;
      }

      for (const f of targets) {
        if (typeof f.chart.setBarSpace !== 'function' || typeof f.chart.getBarSpace !== 'function') {
          unaligned += 1;
          lastUnalignedReason = `${f.period}:no-barspace-api`;
          continue;
        }
        const paneWidth = this.paneWidth(f);
        if (!(paneWidth > 0)) {
          // 未布局（宽度不可测）⇒ 无法推导 barSpace/无法索引定位 ⇒ **计数并记因**（禁止静默跳过）
          unaligned += 1;
          lastUnalignedReason = `${f.period}:no-layout`;
          continue;
        }
        const density = this.effectiveDensity(leader, f);
        if (!isNum(density) || density <= 0) {
          // 无可用密度（含卫星↔卫星无公共锚点）⇒ **计数并记因**（禁止静默跳过）
          unaligned += 1;
          lastUnalignedReason = `${f.period}:no-density-anchor`;
          continue;
        }

        const cap = f.isBase ? BASE_MAX_BAR_SPACE : this.caps.get(f.id) ?? this.satelliteMaxBarSpace;
        let result = alignSatelliteBarSpace({
          baseBarSpace: leaderBarSpace,
          density,
          paneWidthPx: paneWidth,
          maxBarSpace: cap,
        });
        this.writeBarSpace(f, result.barSpace);
        let actual = this.barSpaceOf(f);

        if (actual !== result.barSpace && !f.isBase) {
          // 写入被静默吞掉（P0.3 §2.3）⇒ 探测真实上限，再按真实上限**显式降级**
          const probed = this.probeMaxBarSpace(f, Math.max(1, Math.min(result.barSpace, cap)));
          if (isNum(probed) && probed >= 1 && probed < result.barSpace) {
            this.caps.set(f.id, probed);
            result = alignSatelliteBarSpace({
              baseBarSpace: leaderBarSpace,
              density,
              paneWidthPx: paneWidth,
              maxBarSpace: probed,
            });
            this.writeBarSpace(f, result.barSpace);
            actual = this.barSpaceOf(f);
          }
        }
        if (actual !== result.barSpace) {
          // 仍对不上 ⇒ 显式降级（reason='limit'）：不得把"留在旧值"当作对齐成功
          result = {
            ...result,
            barSpace: isNum(actual) && actual > 0 ? actual : result.barSpace,
            degraded: true,
            degradedReason: 'limit',
          };
        }

        // 索引定位 + **有界闭环校正**（P3-D-2）：按 leader 目标时间窗在 follower 自身数据上二分出目标索引，
        // 用 `scrollToDataIndex` 定位（真身两图同索引 ⇒ 可见范围精确一致），再读回 `getVisibleRange()`
        // 算残差并受限校正（详见 `alignFollowerWindow`）。
        const outcome = this.alignFollowerWindow(f, leaderWindow, paneWidth, cap);
        iterations = Math.max(iterations, outcome.iterations);
        applied = true;
        if (outcome.spanResidualBars !== null) {
          spanResidualBars = Math.max(spanResidualBars ?? 0, outcome.spanResidualBars);
        }
        if (outcome.edgeResidualBars !== null) {
          edgeResidualBars = Math.max(edgeResidualBars ?? 0, outcome.edgeResidualBars);
        }
        const finalBarSpace = this.barSpaceOf(f);
        const adjust =
          isNum(finalBarSpace) && isNum(result.idealBarSpace) ? finalBarSpace - result.idealBarSpace : 0;
        if (Math.abs(adjust) > Math.abs(barSpaceAdjust)) barSpaceAdjust = adjust;
        if (!outcome.aligned) {
          unaligned += 1;
          lastUnalignedReason = `${f.period}:${outcome.reason ?? 'unconverged'}`;
        }
        if (result.degraded || outcome.degraded) {
          degraded = true;
          degradedPeriod = f.period;
        }
        if (outcome.spanDiffMinutes !== null) spanDiffMinutes = outcome.spanDiffMinutes;
      }

      this.statsObj.degraded = degraded;
      this.statsObj.degradedPeriod = degraded ? degradedPeriod : null;
      this.statsObj.unalignedFollowers = unaligned;
      this.statsObj.lastUnalignedReason = lastUnalignedReason;
      this.statsObj.lastCorrectionIterations = iterations;
      this.statsObj.spanResidualBars = spanResidualBars;
      this.statsObj.edgeResidualBars = edgeResidualBars;
      this.statsObj.barSpaceAdjust = barSpaceAdjust;
      // 最近一次对齐的跨度差（读不到窗口 ⇒ 保留上一次读数，不得伪造 0）
      if (spanDiffMinutes !== null) this.statsObj.lastSpanDiffMinutes = spanDiffMinutes;
      if (applied) this.statsObj.applied += 1;
    } finally {
      this.applyDepth -= 1;
      if (this.applyDepth === 0) this.suppressUntil = Date.now() + SUPPRESSION_WINDOW_MS;
      this.broadcast();
    }
  }

  /**
   * 跟随者的**索引定位 + 有界闭环校正**（P3-D-2 核心；`design/15-multi-period/02-spec.md` §3 口径 8）。
   *
   * 背景（P3-C 独立验收 PROBE，`tester/evidence/273_p3c_acceptance/p3c_harness.json`）：
   *  - 真身 `scrollToTimestamp(ts)` 落点**恒距右缘 2 根**，且 `setOffsetRightDistance(0)` **无法消除**
   *    （⇒ 跨图镜像必然残留 ≥2 根相对漂移；1m↔1m 20 轮 `maxDrift=2`）；
   *  - 而两图**同 `scrollToDataIndex(idx)`** 时可见范围**精确一致**（`[241,302]==[241,302]`）。
   *
   * 因此：
   *  1. **索引定位**：把 leader 的右端时间戳在 follower 自身数据上二分出**最近索引**，用
   *     `scrollToDataIndex` 定位（`scrollToDataIndex` 缺失时才回退 `scrollToTimestamp`）；
   *  2. **读回校正**：`getVisibleRange()` 读回后计算残差（**右端差 / 跨度差，以 follower 自身 bar 为单位**），
   *     容差 = **1 根自身 bar**；超容差时用**受限手段**校正：
   *      ① 按右端残差平移请求索引（补偿引擎落点偏移）；
   *      ② 按实测可见根数微调 `barSpace`（跨度）—— 受 `cap` 与「能容纳 ≥2 根」双重限制；
   *  3. **收敛/震荡保护**：迭代上限 `MAX_ALIGN_CORRECTION_ITERATIONS`；残差**不下降**、候选索引/`barSpace`
   *     重复、或目标根数不可达 ⇒ **立即停手**并返回未收敛（调用方置 `degraded` + 统计）。
   *     **禁止无界重试**；任何未达成容差都**不得**被当作对齐成功（严禁静默虚假对齐）。
   */
  private alignFollowerWindow(
    f: SyncMember,
    leaderWindow: VisibleWindow,
    paneWidth: number,
    cap: number,
  ): {
    aligned: boolean;
    degraded: boolean;
    iterations: number;
    spanDiffMinutes: number | null;
    spanResidualBars: number | null;
    edgeResidualBars: number | null;
    reason: string | null;
  } {
    const none = { spanDiffMinutes: null, spanResidualBars: null, edgeResidualBars: null };
    const list = this.dataList(f);
    if (!list || list.length === 0) {
      return { aligned: false, degraded: false, iterations: 0, ...none, reason: 'no-data' };
    }
    const measuredSpacing = medianSpacing(list) ?? 0;
    // 残差/容差以 **follower 自身 bar** 为单位（P3-D-2 口径）：优先用**实测**相邻 ts 中位间隔，
    // 周期桶宽仅作兜底（数据仅 1 根 / 间隔不可测时）。
    const spacing = measuredSpacing > 0 ? measuredSpacing : (periodBucketMs(f.period) ?? 0);
    const tolMs = spacing > 0 ? spacing : 0;
    const capacity = Math.max(1, Math.min(cap, Math.max(1, Math.floor(paneWidth / 2))));
    const lastIndex = list.length - 1;
    let requestedIdx = clampIndex(nearestIndexByTs(list, leaderWindow.toTs), lastIndex);
    const triedIdx = new Set<number>([requestedIdx]);
    const triedBarSpaces = new Set<number>([Math.round(this.barSpaceOf(f))]);
    let iterations = 0;
    /** 分量级最优残差（右端 / 跨度）——“不下降即停手”的震荡保护必须**按分量各自比较**：
     *  否则一个分量的改善会被另一分量的平台期误判为“无改善”而提前停手（真渲染实测）。 */
    let bestEdgeResidualMs = Number.POSITIVE_INFINITY;
    let bestSpanResidualMs = Number.POSITIVE_INFINITY;

    if (!this.positionFollower(f, requestedIdx)) {
      return { aligned: false, degraded: true, iterations: 0, ...none, reason: 'no-scroll-api' };
    }
    iterations += 1;

    for (;;) {
      const fw = this.readWindow(f);
      if (!fw) {
        return { aligned: false, degraded: true, iterations, ...none, reason: 'no-window' };
      }
      const spanDiffMs = fw.spanMs - leaderWindow.spanMs;
      const edgeDiffMs = fw.toTs - leaderWindow.toTs;
      const spanDiffMinutes = Math.round((Math.abs(spanDiffMs) / 60_000) * 10) / 10;
      // 残差以 **follower 自身 bar** 为单位（降级时这就是**实测可达下界**的记录量）
      const spanResidualBars = spacing > 0 ? Math.abs(spanDiffMs) / spacing : null;
      const edgeResidualBars = spacing > 0 ? Math.abs(edgeDiffMs) / spacing : null;
      const residual = { spanDiffMinutes, spanResidualBars, edgeResidualBars };
      if (Math.abs(spanDiffMs) <= tolMs && Math.abs(edgeDiffMs) <= tolMs) {
        return { aligned: true, degraded: false, iterations, ...residual, reason: null };
      }
      if (iterations >= MAX_ALIGN_CORRECTION_ITERATIONS) {
        return { aligned: false, degraded: true, iterations, ...residual, reason: 'iteration-cap' };
      }

      let corrected = false;

      // ① 右端残差：按 follower 自身 bar 平移请求索引（补偿引擎落点偏移）
      if (Math.abs(edgeDiffMs) > tolMs) {
        if (Math.abs(edgeDiffMs) >= bestEdgeResidualMs) {
          return { aligned: false, degraded: true, iterations, ...residual, reason: 'no-improvement' };
        }
        bestEdgeResidualMs = Math.abs(edgeDiffMs);
        const shiftBars = spacing > 0 ? Math.round(edgeDiffMs / spacing) : 0;
        const next = shiftBars !== 0 ? clampIndex(requestedIdx - shiftBars, lastIndex) : requestedIdx;
        if (next !== requestedIdx && !triedIdx.has(next)) {
          triedIdx.add(next);
          requestedIdx = next;
          corrected = true;
        }
      }

      // ② 跨度残差：按实测可见根数微调 barSpace（受限：≤ cap、≥2 根可见、**单步幅度 ≤ MAX_BAR_SPACE_STEP_RATIO**）
      if (Math.abs(spanDiffMs) > tolMs) {
        if (Math.abs(spanDiffMs) >= bestSpanResidualMs) {
          return { aligned: false, degraded: true, iterations, ...residual, reason: 'no-improvement' };
        }
        bestSpanResidualMs = Math.abs(spanDiffMs);
        const currentBarSpace = this.barSpaceOf(f);
        const targetBars = spacing > 0 ? Math.max(2, Math.round(leaderWindow.spanMs / spacing)) : 0;
        const nowBars = Math.max(1, fw.bars);
        if (spacing > 0 && targetBars > 0 && nowBars !== targetBars && isNum(currentBarSpace)) {
          let nextBarSpace = Math.round(currentBarSpace * (nowBars / targetBars));
          const maxStep = Math.max(1, Math.round(currentBarSpace * MAX_BAR_SPACE_STEP_RATIO));
          nextBarSpace = Math.max(currentBarSpace - maxStep, Math.min(currentBarSpace + maxStep, nextBarSpace));
          if (nextBarSpace === currentBarSpace) {
            nextBarSpace = spanDiffMs > 0 ? currentBarSpace + 1 : currentBarSpace - 1;
          }
          nextBarSpace = Math.max(1, Math.min(capacity, nextBarSpace));
          if (nextBarSpace !== currentBarSpace && !triedBarSpaces.has(nextBarSpace)) {
            triedBarSpaces.add(nextBarSpace);
            this.writeBarSpace(f, nextBarSpace);
            corrected = true;
          }
        }
      }

      if (!corrected) {
        // 受限手段已用尽（索引/barSpace 候选皆不可行）⇒ 停手（禁止无界重试）
        return { aligned: false, degraded: true, iterations, ...residual, reason: 'unreachable' };
      }
      this.positionFollower(f, requestedIdx);
      iterations += 1;
    }
  }

  /**
   * **索引定位**：用 `scrollToDataIndex(index)` 把跟随者右缘放到目标索引上
   * （真身两图同索引 ⇒ 可见范围精确一致，而 `scrollToTimestamp` 落点恒距右缘 2 根）。
   * `scrollToDataIndex` 缺失时才回退 `scrollToTimestamp(对应 bar 的 ts)`（并由此进入闭环校正）。
   */
  private positionFollower(f: SyncMember, index: number): boolean {
    const chart = f.chart;
    if (typeof chart.scrollToDataIndex === 'function') {
      try {
        chart.scrollToDataIndex(index);
        return true;
      } catch {
        /* 回退到 scrollToTimestamp */
      }
    }
    if (typeof chart.scrollToTimestamp === 'function') {
      const bar = this.dataList(f)?.[index];
      if (isNum(bar?.timestamp)) {
        try {
          chart.scrollToTimestamp(bar.timestamp);
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  /** 有效密度比：静态锚定表（正/反向）→ 同锚点合成 → 运行时估计（仅两侧窗口非退化）。 */
  private effectiveDensity(leader: SyncMember, follower: SyncMember): number | null {
    const table = { ...MEASURED_DENSITY_TABLE, ...this.extraDensityTable };
    const direct = this.lookupDensity(leader.period, follower.period, table);
    if (direct !== null) return direct;
    const reverse = this.lookupDensity(follower.period, leader.period, table);
    if (reverse !== null && reverse > 0) return 1 / reverse;
    const composed = composeDensity(leader.period, follower.period);
    if (composed !== null && composed > 0) return composed;
    const measured = this.measureDensity(leader, follower);
    return resolveDensityRatio(leader.period, follower.period, measured).ratio;
  }

  private lookupDensity(base: string, sat: string, table: Record<string, number>): number | null {
    if (base === sat) return 1;
    const d = table[`${base}:${sat}`];
    return isNum(d) && d > 0 ? d : null;
  }

  /**
   * 运行时密度估计：在两侧可见窗的**交叠 ts 窗**内统计 bar 数（二分求解索引窗）后取比值；
   * 交叠不存在 / 任一侧 ≤1 根 / 无 bar ⇒ null（估计器失效，交由静态表兜底）。
   */
  private measureDensity(leader: SyncMember, follower: SyncMember): number | null {
    const lw = this.readWindow(leader);
    const fw = this.readWindow(follower);
    if (!lw || !fw) return null;
    const from = Math.max(lw.fromTs, fw.fromTs);
    const to = Math.min(lw.toTs, fw.toTs);
    if (!(to > from)) return null;
    const lList = this.dataList(leader);
    const fList = this.dataList(follower);
    if (!lList || !fList) return null;
    return estimateDensityRatio({
      baseBarCount: countBarsInWindow(lList, from, to),
      satBarCount: countBarsInWindow(fList, from, to),
    });
  }

  private readWindow(m: SyncMember): VisibleWindow | null {
    const chart = m.chart;
    if (typeof chart.getVisibleRange !== 'function') return null;
    let range: { from: number; to: number; realFrom: number; realTo: number } | undefined;
    try {
      range = chart.getVisibleRange();
    } catch {
      return null;
    }
    if (!range || !isNum(range.realTo) || !isNum(range.realFrom)) return null; // NaN 视口 ⇒ 显式降级
    const list = this.dataList(m);
    if (!list || list.length === 0) return null;
    const last = list.length - 1;
    const toIdx = clampIndex(range.realTo, last);
    const fromIdx = clampIndex(range.realFrom, last);
    const toBar = list[toIdx];
    const fromBar = list[fromIdx];
    const toTs = toBar?.timestamp;
    const fromTs = fromBar?.timestamp;
    if (!isNum(toTs) || !isNum(fromTs)) return null;
    const bucket = periodBucketMs(m.period) ?? medianSpacing(list) ?? 0;
    return { fromTs, toTs, spanMs: toTs - fromTs + bucket, bars: toIdx - fromIdx + 1 };
  }

  private dataList(m: SyncMember): Array<{ timestamp: number }> | null {
    const chart = m.chart;
    if (typeof chart.getDataList !== 'function') return null;
    try {
      const list = chart.getDataList();
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }

  private barSpaceOf(m: SyncMember): number {
    try {
      const bs = m.chart.getBarSpace?.();
      return isNum(bs?.bar) ? bs.bar : Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  private paneWidth(m: SyncMember): number {
    try {
      const size = m.chart.getSize?.();
      return isNum(size?.width) ? size.width : 0;
    } catch {
      return 0;
    }
  }

  private writeBarSpace(m: SyncMember, space: number): void {
    try {
      m.chart.setBarSpace?.(space);
    } catch {
      /* 越界/异常：由调用方读回校验并显式降级 */
    }
  }

  /** 右偏移归零（右缘对齐前置；`getOffsetRightDistance()` 是 px 量级）。 */
  private zeroRightOffsets(members: ReadonlyArray<SyncMember>): void {
    for (const m of members) {
      const chart = m.chart;
      if (typeof chart.getOffsetRightDistance !== 'function' || typeof chart.setOffsetRightDistance !== 'function') {
        continue;
      }
      let current: number | null = null;
      try {
        current = chart.getOffsetRightDistance();
      } catch {
        current = null;
      }
      if (!isNum(current) || current <= 0) continue;
      try {
        chart.setOffsetRightDistance(0);
      } catch {
        /* 补偿失败：后续按 ts 逐边对齐仍成立（容差 ≤1 根高周期 bar） */
      }
    }
  }

  /**
   * 探测真实 `barSpaceLimit.max`（klinecharts 无 getter）：在 `[1, upper]` 二分，取**被接受的最大值**
   * （读回校验；越界被静默吞掉 ⇒ 读回 ≠ 请求）。探测后**还原**原 barSpace，避免留下副作用。
   */
  private probeMaxBarSpace(m: SyncMember, upper: number): number | null {
    const chart = m.chart;
    if (typeof chart.setBarSpace !== 'function' || typeof chart.getBarSpace !== 'function') return null;
    const original = this.barSpaceOf(m);
    let lo = 1;
    let hi = Math.max(1, Math.floor(upper));
    let best: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      this.writeBarSpace(m, mid);
      if (this.barSpaceOf(m) === mid) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (isNum(original) && original >= 1 && this.barSpaceOf(m) !== original) this.writeBarSpace(m, original);
    return best;
  }

  private broadcast(): void {
    const snapshot: SyncStats = { ...this.statsObj };
    for (const cb of [...this.listeners]) {
      try {
        cb(snapshot);
      } catch {
        /* 单个订阅者异常不应打断同步/其它订阅者 */
      }
    }
  }
}

/** 相邻 ts 的中位间隔（周期桶宽缺失时的兜底；bar 数 <2 ⇒ null）。 */
function medianSpacing(list: ReadonlyArray<{ timestamp: number }>): number | null {
  if (list.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]?.timestamp;
    const b = list[i]?.timestamp;
    if (isNum(a) && isNum(b) && b > a) gaps.push(b - a);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  const mid = gaps.length >> 1;
  const v = gaps.length % 2 === 1 ? gaps[mid] : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
  return isNum(v) && v > 0 ? v : null;
}
