/**
 * klinecharts 10.0.3 「跨图同步所需公开面」的**最小忠实模型**（测试基建，非生产代码）。
 *
 * 依据（全部为实测锚定，非推断；出处 `tester/test/260_p03_barspace_anchor_execution.md` 与
 * `tester/evidence/250_multiperiod_route_probe/p7b2_result.json`）：
 *  - `getBarSpace()` 返回 `{bar, halfBar, gapBar, halfGapBar}`（`index.d.ts:29-34`），同步用 `.bar`；
 *  - `setBarSpace(space)` 越界（∉ `barSpaceLimit`）**静默 return**（P0.3 §2.3：req 350 在 max=50 下被吞、零告警）；
 *  - `scrollToTimestamp(ts)` = `scrollToDataIndex(binarySearchNearest(ts))`（`index.esm.js:15639-15641`）
 *    ⇒ 落点是**右缘方向**（不是居中），但**不贴右缘**：真身落点距右缘**固定 2 根**
 *    （P3-C PROBE 实测，见 `REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS`）；
 *  - `getVisibleRange()` 是**索引空间** `{from,to,realFrom,realTo}`（`index.esm.js:13556-13567`）；
 *  - `getOffsetRightDistance()` ≡ `8 × barSpace`（P0.3 §6-I6 实测 px 序列 8/16/40/64/160）；
 *  - `satBS ≫ pane 宽` 时 `getVisibleRange()` 失效（NaN，P0.3 §6-I3a）。
 *
 * 之所以需要它：jsdom 无 canvas，真身 klinecharts 跑不起来；而**跨图同步的判据全部落在上述调用面上**
 * （barSpace / 索引窗 / 右偏移）。真身几何与事件由 Playwright harness（`web/tester/p3-sync-harness/`）承担。
 *
 * 语义简化（**必须在读断言时知道**）：
 *  1. `getVisibleRange()` 是**纯读**（真身内部会 `executeAction('onVisibleRangeChange')`；此处不触发，
 *     否则抑制关闭的用例会无限回环）。事件只由**状态真变化**的写操作触发 ⇒ 幂等写入不产生回声。
 *  2. 可见根数 = `floor(paneWidth / barSpace)`；右缘索引 = `rightIndex`（`scrollToDataIndex` 直设）。
 *  3. `__appendBar()`（数据追加）**不触发任何事件**：新 bar 到达不是用户交互，不得引起滚动/对齐。
 *  4. `scrollToTimestamp(ts)` 落点 = `nearestIndex(ts) + REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS`（2 根），
 *     **不再**简化为「贴右缘」（P3-C 独立验收判 FAIL(B1,B2,B4) 的根因：jsdom 桩过于理想 ⇒ 20/20 假绿）。
 *
 * 已知的**剩余不忠实面**（勿误用为仪器证明；见 P3-C 实测 `tester/evidence/273_p3c_acceptance/p3c_harness.json`）：
 *  a. 可见根数 `floor(paneWidth/barSpace)` 与真身**不完全一致**（真身含部分 bar：bs=8/520px 实测 62 根、
 *     bs=260 实测 4 根、bs=302 实测 4 根；桩分别为 65/2/1）⇒ 桩内「`floor(520/302)=1` ⇒ 可见 <2 根」这类
 *     推论**只在桩内成立**，不得当作真身证据（P3-C：`setBarSpace(302)` 在真渲染仍报 4 根可见）。
 *  b. `satBS ≫ pane 宽 ⇒ NaN` 的**前置条件**在真身不可达（引擎把 barSpace 夹到 `width/2`）⇒
 *     `NAN_WHEN_BARSPACE_EXCEEDS_PANE_FACTOR` 及依赖它的用例是**防御性路径**，其仪器证明只在桩内有效。
 */

export interface SyncChartStubOptions {
  /** 该实例的 bar 时间戳（ms，升序；模拟后端该周期的 bar）。 */
  bars: number[];
  /** pane 宽度 px（`getSize().width`；jsdom 无布局 ⇒ 由桩提供）。 */
  paneWidthPx?: number;
  /** 初始 barSpace（引擎默认 10，`index.esm.js:13056`）。 */
  barSpace?: number;
  /** `barSpaceLimit`（init 选项；卫星放宽到 350，基准保持默认 50 —— ADR-022 §2.3）。 */
  limit?: { min: number; max: number };
  /** 右偏移（bar 数；引擎默认 8 ⇒ `getOffsetRightDistance() = 8 × barSpace`）。 */
  offsetRightBars?: number;
}

export interface SyncChartStubCall {
  method: string;
  args: unknown[];
}

export interface SyncChartStub {
  // ── klinecharts 公开面（同步所需子集） ──
  getBarSpace(): { bar: number; halfBar: number; gapBar: number; halfGapBar: number };
  setBarSpace(space: number): void;
  getSize(): { width: number; height: number };
  getVisibleRange(): { from: number; to: number; realFrom: number; realTo: number };
  scrollToTimestamp(timestamp: number): void;
  scrollToDataIndex(dataIndex: number): void;
  scrollToRealTime(): void;
  getOffsetRightDistance(): number;
  setOffsetRightDistance(distance: number): void;
  getDataList(): Array<{ timestamp: number }>;
  subscribeAction(type: string, callback: (payload?: unknown) => void): void;
  unsubscribeAction(type: string, callback?: (payload?: unknown) => void): void;
  // ── 测试可见（非引擎 API） ──
  /** 数据列表（ts）。 */
  __bars: number[];
  /** 已派发的动作事件序列（'onScroll' | 'onZoom' | 'onVisibleRangeChange'）。 */
  __events: string[];
  /** 调用日志（含被静默吞掉的越界 `setBarSpace`）。 */
  __log: SyncChartStubCall[];
  /** 现用 `barSpaceLimit`（只读快照）。 */
  __limit(): { min: number; max: number };
  /** 右缘 bar 索引（可见窗最右）。 */
  __rightIndex(): number;
  /** 追加一根 bar（数据到达；**不触发事件**）。 */
  __appendBar(ts: number): void;
  /** 手工派发动作（jsdom 无法产生真实手势；仅测试用）。 */
  __fireAction(type: string, payload?: unknown): void;
  /** 事件处理器数量（订阅/退订断言用）。 */
  __listenerCount(type?: string): number;
  /** 直设右缘索引（数据装载后复位用；非引擎 API）。 */
  __setRightIndex(index: number): void;
  /** 已装配的数据装载器（`setDataLoader`；页面级用例据此喂数据）。 */
  __loader: unknown;
}

/**
 * 真身 `scrollToTimestamp(ts)` 的右缘落点缺口（bar 数）——**固定 2 根**，`setOffsetRightDistance(0)`
 * **无法消除**。
 *
 * 实测锚定（P3-C 独立验收 PROBE；`tester/evidence/273_p3c_acceptance/p3c_harness.json` →
 * `scenarios.PROBE`，页面 `real_render_harness.html`，driver `real_render_driver.mjs`）：
 *  - 配置：真身 klinecharts 10.0.3，pane 520×240，600 根 1m bar（末根 = `Date.UTC(2026,8,14,7,0,0)`），
 *    `setBarSpace(8)`，`setOffsetRightDistance(0)` 后 **读回 0**；
 *  - 两实例同 `scrollToDataIndex` ⇒ 范围 `[241,302] == [241,302]`（**精确相等**，无缺口）；
 *  - `scrollToTimestamp(list[302].timestamp)` ⇒ 范围 `[243,304]` ⇒ **右缘索引 = 目标索引 + 2**，
 *    且 `deltaTs_toTs = 120000ms = 2 × 1m`；
 *  - 该缺口**不是**右偏移（offsets 两侧均为 0）⇒ 跨图镜像必然残留 **≥2 根**相对漂移
 *    （P3-C S1：1m↔1m 20 轮 `maxDrift = 2`、`suppressed=64`、`echo=0`）。
 *
 * 真身成因：`scrollToTimestamp` 先 `binarySearchNearest` 再 `scrollToDataIndex`（`index.esm.js:15639-15641`），
 * 而 `scrollToDataIndex` 的落点由 `scrollByDistance` 的像素换算决定，在「右侧仍有 bar 可滚」时稳定多出
 * 2 根（数据末端会被夹回末根，故 `scrollToDataIndex(lastIndex)` 仍为精确）。
 */
export const REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS = 2;

/** 可见范围失效的判定（P0.3 §6-I3a：`satBS ≫ pane 宽` ⇒ NaN）。 */
export const NAN_WHEN_BARSPACE_EXCEEDS_PANE_FACTOR = 2;

export function createSyncChartStub(opts: SyncChartStubOptions): SyncChartStub {
  const bars = [...opts.bars].sort((a, b) => a - b);
  const width = opts.paneWidthPx ?? 520;
  const limit = { ...(opts.limit ?? { min: 1, max: 50 }) };
  /** 右偏移 = `_lastBarRightSideDiffBarCount`（bar 数）；px = `diffBarCount × barSpace`。
   *  忠实建模 `StoreImp.setOffsetRightDistance/getOffsetRightDistance`（`index.esm.js:13692-13710`）：
   *  setter 记 `diffBarCount = distance / barSpace`（默认 `80px / barSpace` = 8 根 @bs10），
   *  getter 返回 `max(0, diffBarCount × barSpace)` ⇒ **传给 setter 的 px 必须真的生效**
   *  （旧实现把 setter 写成 no-op，`setOffsetRightDistance(0)` 无法被观测 ⇒ 右端对齐判据不可达）。 */
  let offsetRightBarsCount = opts.offsetRightBars ?? 8;
  let barSpace = opts.barSpace ?? 10;
  let rightIndex = Math.max(0, bars.length - 1);
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  const events: string[] = [];
  const log: SyncChartStubCall[] = [];

  const fire = (type: string, payload?: unknown): void => {
    events.push(type);
    const set = handlers.get(type);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  };

  const nearestIndex = (ts: number): number => {
    let best = 0;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (bar === undefined) continue;
      const d = Math.abs(bar - ts);
      if (d < bestDiff) {
        best = i;
        bestDiff = d;
      }
    }
    return best;
  };

  const stub: SyncChartStub = {
    getBarSpace: () => ({ bar: barSpace, halfBar: barSpace / 2, gapBar: 0, halfGapBar: 0 }),

    setBarSpace: (space: number) => {
      log.push({ method: 'setBarSpace', args: [space] });
      if (space < limit.min || space > limit.max) return; // 静默吞掉（P0.3 §2.3）
      if (space === barSpace) return; // 幂等 ⇒ 不产生事件（不得回声）
      barSpace = space;
      fire('onZoom');
      fire('onVisibleRangeChange');
    },

    getSize: () => ({ width, height: 400 }),

    getVisibleRange: () => {
      if (barSpace > NAN_WHEN_BARSPACE_EXCEEDS_PANE_FACTOR * width) {
        // 过度放宽 ⇒ 无有效视口（P0.3 §6-I3a 实测：1m→1d@2880 / 1m→1w@20160 取不到读数）
        return { from: NaN, to: NaN, realFrom: NaN, realTo: NaN };
      }
      const slots = Math.floor(width / barSpace);
      const to = Math.min(rightIndex, Math.max(0, bars.length - 1));
      const from = Math.max(0, to - slots + 1);
      return { from, to, realFrom: from, realTo: to };
    },

    scrollToTimestamp: (ts: number) => {
      log.push({ method: 'scrollToTimestamp', args: [ts] });
      // 忠实真身落点：目标 bar 距右缘 `REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS` 根（**不是**贴右缘）。
      // 数据末端由 `scrollToDataIndex` 的索引夹取兜底（真身同样被夹回末根 ⇒ T4「回到最新」不受影响）。
      stub.scrollToDataIndex(nearestIndex(ts) + REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS);
    },

    scrollToDataIndex: (dataIndex: number) => {
      log.push({ method: 'scrollToDataIndex', args: [dataIndex] });
      const idx = Math.max(0, Math.min(bars.length - 1, Math.round(dataIndex)));
      if (idx === rightIndex) return; // 幂等 ⇒ 无事件
      rightIndex = idx;
      fire('onScroll');
      fire('onVisibleRangeChange');
    },

    scrollToRealTime: () => {
      log.push({ method: 'scrollToRealTime', args: [] });
      const idx = Math.max(0, bars.length - 1);
      if (idx === rightIndex) return;
      rightIndex = idx;
      fire('onScroll');
      fire('onVisibleRangeChange');
    },

    getOffsetRightDistance: () => Math.round(Math.max(0, offsetRightBarsCount * barSpace)),
    setOffsetRightDistance: (distance: number) => {
      log.push({ method: 'setOffsetRightDistance', args: [distance] });
      // 忠实 `StoreImp.setOffsetRightDistance`：记 bar 数（px / barSpace），getter 再按当前 barSpace 折算
      if (Number.isFinite(distance) && barSpace > 0) offsetRightBarsCount = distance / barSpace;
    },

    getDataList: () => bars.map((timestamp) => ({ timestamp })),

    subscribeAction: (type: string, callback: (payload?: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(callback);
    },

    unsubscribeAction: (type: string, callback?: (payload?: unknown) => void) => {
      if (!callback) handlers.delete(type);
      else handlers.get(type)?.delete(callback);
    },

    __bars: bars,
    __events: events,
    __log: log,
    __limit: () => ({ ...limit }),
    __rightIndex: () => rightIndex,
    __appendBar: (ts: number) => {
      bars.push(ts);
    },
    __fireAction: (type: string, payload?: unknown) => {
      fire(type, payload);
    },
    __listenerCount: (type?: string) =>
      type === undefined
        ? [...handlers.values()].reduce((n, s) => n + s.size, 0)
        : (handlers.get(type)?.size ?? 0),
    __setRightIndex: (index: number) => {
      rightIndex = Math.max(0, Math.min(bars.length - 1, index));
    },
    __loader: null,
  };

  return stub;
}

/** 合成序列的工具：以 `bucketMs` / 实测密度比 D 校准的等间隔 ts（末根 = `endTs`）。 */
export function makeSeries(opts: {
  count: number;
  spacingMs: number;
  endTs: number;
}): number[] {
  const { count, spacingMs, endTs } = opts;
  return Array.from({ length: count }, (_, i) => endTs - (count - 1 - i) * spacingMs);
}
