/**
 * ADR-028 D2/D4 —— K 线实例侧的窗口**读/写原语**（图表层；被结果页时间窗状态机消费）。
 *
 * 放在 `features/dashboard/`（图表层）而不是 `features/workbench/`：依赖方向必须是
 * `workbench → dashboard`（workbench 已 import `KlineChart`），不得倒置。
 * 本文件只依赖 klinecharts 的**结构子集**（`KlineWindowOps`），故可用测试桩（jsdom 无 canvas）
 * 逐条断言 F18 的「`setBarSpace` 越界静默 return」路径。
 *
 * 事实锚定（ADR-028 F18/F19，源自 `tester/test/260_p03_barspace_anchor_execution.md`）：
 * - `setBarSpace(space)` 越界（∉ `barSpaceLimit`）**静默 return**，零告警；
 * - `scrollToTimestamp(ts)` 真身落点恒距右缘 **2 根**且 `setOffsetRightDistance(0)` 无法消除
 *   ⇒ 居中定位必须用 `scrollToDataIndex`；
 * - `getVisibleRange()` 是索引空间 `{from,to,realFrom,realTo}`；`barSpace ≫ pane 宽` 时可能返回 NaN。
 */

/** 窗口读/写所需的最小 klinecharts 公开面（`Chart` 结构上直接满足 ⇒ 组件侧零 cast）。 */
export interface KlineWindowOps {
  getSize?(): { width: number; height?: number } | null;
  getBarSpace?(): { bar: number };
  setBarSpace?(space: number): void;
  getVisibleRange?(): { from: number; to: number; realFrom?: number; realTo?: number };
  getDataList?(): Array<{ timestamp: number }>;
  scrollToDataIndex?(dataIndex: number): void;
  scrollToTimestamp?(timestamp: number): void;
  /** 索引/时间 → 绘图区局部像素（`Chart.convertToPixel`；ADR-028 D2.3-4 几何锚点）。可选。
   *  返回类型按 klinecharts 真实签名放宽（`Partial<Coordinate> | Partial<Coordinate>[]`）⇒ 组件侧零 cast。 */
  convertToPixel?(
    p: { timestamp: number },
    f?: { paneId?: string },
  ): { x?: number; y?: number } | Array<{ x?: number; y?: number }> | undefined;
}

/**
 * **时间单位契约（强制）**：`from_ts`/`to_ts` 一律是 **Unix 秒**（与 `/curve?from_ts=`、`RoundTrip.open_ts`、
 * `RoundTripFill.ts` 同源）；klinecharts 的 `KLineData.timestamp` / `getVisibleRange()` 是**毫秒**
 * （既有 `buildMarkers` 的 `f.ts * 1000` 即此口径）⇒ 转换**只**在本文件内做一次，禁止散落各调用点。
 */
export const CHART_TS_MS = 1000;

/**
 * `readVisibleRangeTs` 的返回值：索引空间 + 时间空间（`onVisibleRangeChange` 回调负载，02-spec §7）。
 *
 * **口径（2026-09-20 修正，ADR-028 D2.3-1）**：`from_ts`/`to_ts`/`from_idx`/`to_idx` 取
 * 引擎 `getVisibleRange()` 的 **`from`/`to`**（可见 bar 集合，取整并夹到数据长度）——
 * **不得**再混用 `realFrom/realTo`：`realTo` 是**未夹取**的内部扫描上界（可 > `dataList.length-1`，
 * 实测 1014 vs 999），而 `realFrom` 只在右侧偏移 > 0 时 ≠ `from` ⇒ 旧实现发布的是「realFrom + 夹取后的
 * realTo」这种**混合端点**，实测导致 6 态中 5 态「窗口 ≠ 视口」（1.680×/1.309×/1.661×/0.398×/27×）。
 */
export interface VisibleRangeTs {
  from_ts: number;
  to_ts: number;
  from_idx: number;
  to_idx: number;
  /**
   * ADR-028 D2.1：**K 线所绘制的同一 bar 序列**（可见 bar 的 ts，Unix 秒，升序；索引 i ⇒ `bar_ts[i]`）。
   * 曲线视图的 ts→bar 索引查表源（禁在曲线侧另造 bar 序列）。
   */
  bar_ts?: number[];
  /** 每槽像素宽（`getBarSpace().bar`）——曲线与 K 线共用绘图区几何用（D2.3-4）。 */
  bar_space?: number;
  /** 窗口首根 bar 的**绘图区局部**像素 x（`convertToPixel` 实测）——几何锚点。 */
  x_from_px?: number;
  /** K 线容器宽（px，`getSize().width`）——曲线 SVG 与其同宽时可直接换算屏幕坐标。 */
  chart_width_px?: number;
}

/** 下发给 K 线实例的程序化写窗命令（rev 单调；同一窗口重复跳转也换 rev ⇒ 组件侧必须重放）。 */
export interface WindowCommand {
  rev: number;
  from_ts: number;
  to_ts: number;
  span_bars: number;
  /** 居中目标 ts（L2 = 该笔成交 bar；L1 = 回合区间中点）。 */
  center_ts: number;
  /**
   * `span_bars` 的解释（ADR-028 D4 / §4.2）：
   *  - `'range'`（L1）：窗口 = 已加载 bar 落在 `[from_ts, to_ts]` 的**全部 bar**（回合完整可见，不受稀疏影响）；
   *  - `'bars'`（L2，缺省）：窗口 = `span_bars` **根**（成交 bar 居中 120 根）。
   */
  span_mode?: 'range' | 'bars';
}

export interface WindowApplyObserved {
  from_idx: number;
  to_idx: number;
  from_ts: number;
  to_ts: number;
  bar_space: number;
  /** 首次（未校准）选定并读回的 barSpace（观测性：区分「初选」与「校准后生效」）。 */
  requested_bar_space?: number;
  /** 目标 bar 在图表 dataList 中的索引（定位目标；E2 中心判据用）。 */
  center_idx?: number;
  /** 目标 bar 的 ts（Unix 秒；稀疏 bar 下 ≠ `(from_ts+to_ts)/2`）。 */
  center_ts?: number;
  /** 实测可见窗口中心 bar 的索引（= floor((from_idx+to_idx)/2)）。 */
  observed_center_idx?: number;
  /** 实测可见窗口中心 bar 的 ts（Unix 秒）——**E2「中心 bar == 成交 bar」的真身判据**。 */
  observed_center_ts?: number;
  /** 目标被数据边缘夹住（无法真正居中）⇒ 中心判据豁免（真身物理约束）。 */
  edge_clamped?: boolean;
}

export interface WindowApplyResult {
  rev: number;
  ok: boolean;
  /** 失败原因（**必填**：跳转失败必须显式报错，禁止静默无反应）。 */
  error: string | null;
  requested_bar_space: number | null;
  observed: WindowApplyObserved | null;
}

/** 索引空间的 `realFrom/realTo` 是否可用（真身更细；桩上存在但语义等价）。 */
function pickFrom(r: { from: number; realFrom?: number }): number {
  return r.realFrom ?? r.from;
}
function pickTo(r: { to: number; realTo?: number }): number {
  return r.realTo ?? r.to;
}

/**
 * 读回**引擎实际生效的可见范围**并把**索引 → ts**（D2/D2.1「对齐基准 = K 线可见 bar 的 ts 区间」）。
 *
 * 口径见 {@link VisibleRangeTs}（`from`/`to`，不是 `realFrom/realTo`）；同时回传曲线侧所需的
 * **同一 bar 序列**（`bar_ts`）与绘图区几何（`bar_space`/`x_from_px`/`chart_width_px`，D2.3-4）。
 * 不可读（无数据 / NaN 视口）⇒ 返回 `null`（**不猜**，调用方不得把 null 当成 0 区间使用）。
 */
export function readVisibleRangeTs(chart: KlineWindowOps): VisibleRangeTs | null {
  if (typeof chart.getDataList !== 'function' || typeof chart.getVisibleRange !== 'function') return null;
  const list = chart.getDataList();
  if (!list || list.length === 0) return null;
  let r: { from: number; to: number; realFrom?: number; realTo?: number };
  try {
    r = chart.getVisibleRange();
  } catch {
    return null;
  }
  if (!r || Number.isNaN(r.from) || Number.isNaN(r.to)) return null;
  const last = list.length - 1;
  const fromIdx = Math.max(0, Math.min(last, Math.round(r.from)));
  const toIdx = Math.max(fromIdx, Math.min(last, Math.round(r.to)));
  const from = list[fromIdx];
  const to = list[toIdx];
  if (!from || !to) return null;
  const barTs: number[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    barTs.push(Math.floor((list[i] as { timestamp: number }).timestamp / CHART_TS_MS));
  }
  const out: VisibleRangeTs = {
    from_idx: fromIdx,
    to_idx: toIdx,
    from_ts: Math.floor(from.timestamp / CHART_TS_MS),
    to_ts: Math.floor(to.timestamp / CHART_TS_MS),
    bar_ts: barTs,
  };
  const space = chart.getBarSpace?.()?.bar;
  if (typeof space === 'number' && Number.isFinite(space) && space > 0) out.bar_space = space;
  const width = chart.getSize?.()?.width;
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) out.chart_width_px = width;
  if (typeof chart.convertToPixel === 'function') {
    try {
      const px = chart.convertToPixel({ timestamp: from.timestamp }, { paneId: 'candle_pane' });
      const one = Array.isArray(px) ? px[0] : px;
      if (one && typeof one.x === 'number' && Number.isFinite(one.x)) out.x_from_px = one.x;
    } catch {
      /* 像素不可得 ⇒ 几何降级（曲线独立几何），不猜 */
    }
  }
  return out;
}

function nearestIndexByTs(list: ReadonlyArray<{ timestamp: number }>, tsSeconds: number): number {
  const tsMs = tsSeconds * CHART_TS_MS; // 窗口事实源 = 秒；图表 dataList = 毫秒（见 CHART_TS_MS 契约）
  let best = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs((list[i] as { timestamp: number }).timestamp - tsMs);
    if (d < bestDiff) {
      best = i;
      bestDiff = d;
    }
  }
  return best;
}

/** 整数化的可见 bar 根数（真身 `getVisibleRange()` 的 from/to 含部分 bar，四舍五入会**多算**）。 */
function visibleCount(r: { from: number; to: number; realFrom?: number; realTo?: number } | null): number {
  if (!r || Number.isNaN(pickFrom(r)) || Number.isNaN(pickTo(r))) return 0;
  return Math.max(1, Math.round(pickTo(r)) - Math.round(pickFrom(r)) + 1);
}

/**
 * 把共享窗口**程序化**写到 K 线实例并**断言成功**（ADR-028 D2/D4，F18 零容忍静默失败）。
 *
 * 步骤：① `setBarSpace(clamp(round(width/span_bars), limit))` → **读回**校验（越界被引擎静默 return
 * ⇒ 返回 `ok:false` 并给出 barSpaceLimit 原文）② 以「读回的实际可见根数」把目标 bar **居中**
 * （`scrollToDataIndex`，而非 `scrollToTimestamp`：后者真身落点恒距右缘 2 根且不可消除）③ 读回
 * `getVisibleRange()` 校验目标在窗内、非 NaN、居中误差 ≤1 根（数据边缘被夹取时豁免居中判据）。
 *
 * 调用方**必须**在 `programmaticScroll`（回声抑制）窗口内调用本函数。
 */
export function applyWindowOps(
  chart: KlineWindowOps,
  cmd: WindowCommand,
  limit: { min?: number; max?: number } | undefined = undefined,
): WindowApplyResult {
  const base = { rev: cmd.rev };
  let firstApplied: number | null = null;
  const fail = (error: string, extra?: Partial<WindowApplyResult>): WindowApplyResult => ({
    ...base,
    ok: false,
    error,
    requested_bar_space: null,
    observed: null,
    ...extra,
  });
  const methods: Array<keyof KlineWindowOps> = [
    'getSize',
    'getBarSpace',
    'setBarSpace',
    'getVisibleRange',
    'getDataList',
    'scrollToDataIndex',
  ];
  const missing = methods.filter((m) => typeof chart[m] !== 'function');
  if (missing.length > 0) {
    return fail(`K 线实例不支持窗口命令（缺少 ${missing.join('/')}）`);
  }
  const list = chart.getDataList!();
  if (!list || list.length === 0) return fail('K 线数据未加载（dataList 为空）⇒ 无法定位');
  const size = chart.getSize!();
  const width = size?.width ?? 0;
  if (!Number.isFinite(width) || width <= 0) {
    return fail('K 线容器宽度不可测（未布局）⇒ 无法计算窗口 barSpace');
  }
  const min = limit?.min ?? 1;
  const max = limit?.max ?? 50;
  // ── 目标 ts 区间 → **图表已加载 bar 索引区间**（D4：以已加载 K 线为准定位）──
  // 根数**必须**取「已加载 dataList 中落在 [from_ts, to_ts] 的 bar 数」，不得用 `(ts 差)/周期` 或
  // 回合 bar 索引差反算：真身每日 bar 可稀疏（实测 ~0.4–0.7 根/日），两种反算都会系统性偏差
  // （P5c 真渲染实测：回合 53 根被 ts 反算成 78 根 / 被 run 索引差算成 18 根，均不覆盖回合）。
  const rangeFromMs = cmd.from_ts * CHART_TS_MS;
  const rangeToMs = cmd.to_ts * CHART_TS_MS;
  let firstIn = -1;
  let lastIn = -1;
  for (let i = 0; i < list.length; i++) {
    const ts = (list[i] as { timestamp: number }).timestamp;
    if (ts >= rangeFromMs && ts <= rangeToMs) {
      if (firstIn < 0) firstIn = i;
      lastIn = i;
    }
  }
  const rangeBars = firstIn >= 0 ? lastIn - firstIn + 1 : 0;
  // 居中目标恒取 `center_ts` 的最近 bar：L1 = 回合 ts 中点，L2 = 成交 bar（不得用区间**索引**中点——
  // 稀疏 bar 下区间在索引空间不对称，会把 L2 的中心错位到窗外）。
  const idx =
    cmd.span_mode === 'range' && rangeBars > 0
      ? Math.round((firstIn + lastIn) / 2)
      : nearestIndexByTs(list, cmd.center_ts);
  const wantBars = cmd.span_mode === 'range' && rangeBars > 0 ? rangeBars : Math.round(cmd.span_bars) || 1;
  const span = Math.max(1, Math.min(wantBars, list.length));

  /** 设 barSpace 并**读回**；越界被静默吞掉时返回错误对象（F18 零容忍），成功则写入 `applied` 并返回 null。 */
  let applied = 0;
  const setAndVerify = (want: number): WindowApplyResult | null => {
    chart.setBarSpace!(want);
    const got = Math.round(chart.getBarSpace!()?.bar ?? Number.NaN);
    if (got !== want) {
      return fail(
        `setBarSpace(${want}) 未生效（读回 ${got}；barSpaceLimit min=${min} max=${max}）⇒ 跳转被引擎静默吞掉`,
        { requested_bar_space: want },
      );
    }
    applied = got;
    return null;
  };

  // ── ① barSpace 选值 ──
  // 初选用 **floor**（而非 round）：round 可能向下取整可见根数（真身可见根数 ≠ floor(paneWidth/barSpace)），
  // 使实测窗口比请求**更窄**（P5c 真渲染实测：请求 78 根 → round 得 9 → 只可见 68 根）。
  const e0 = setAndVerify(Math.max(min, Math.min(max, Math.floor(width / span) || min)));
  if (e0) return e0;
  firstApplied = applied;
  // ② 用**实测**可见根数校准有效绘图宽度（真身可见宽度 < getSize().width），再取「可见根数 ≥ span」的最大 barSpace。
  const measured = visibleCount(chart.getVisibleRange!());
  if (measured > 0) {
    const effW = measured * applied;
    const want = Math.max(min, Math.min(max, Math.floor(effW / span) || min));
    if (want < applied) {
      const e1 = setAndVerify(want);
      if (e1) return e1;
    }
  }
  // ③ 若实测可见根数仍 < span（校准残差 / 数据不足），逐步减小 barSpace（每次 1，至多 8 次）。
  for (let i = 0; i < 8 && applied > min; i++) {
    if (visibleCount(chart.getVisibleRange!()) >= span) break;
    const e2 = setAndVerify(Math.max(min, applied - 1));
    if (e2) return e2;
  }

  // ── ④ 居中 + **覆盖保证**（读回迭代） ──
  // 目标：目标 bar 居中（±1 根）**且**可见根数 ≥ span（回合必须完整可见）。
  // 真身可见根数与 `floor(paneWidth/barSpace)` 不等（含部分 bar）⇒ 必须**滚动后**读回计数。
  const last = list.length - 1;
  const centerOn = (): { fromIdx: number; toIdx: number } | null => {
    let right = Math.max(0, Math.min(last, idx + Math.floor((visibleCount(chart.getVisibleRange!()) - 1) / 2)));
    chart.scrollToDataIndex!(right);
    let rr = chart.getVisibleRange!();
    if (!rr || Number.isNaN(rr.from) || Number.isNaN(rr.to)) return null;
    for (let it = 0; it < 4; it++) {
      const f = Math.round(pickFrom(rr));
      const t = Math.round(pickTo(rr));
      const err = (f + t) / 2 - idx;
      if (Math.abs(err) <= 1) break;
      const nr = Math.max(0, Math.min(last, right - Math.round(err)));
      if (nr === right) break; // 已被边缘夹住（不再移动）
      right = nr;
      chart.scrollToDataIndex!(right);
      const r2 = chart.getVisibleRange!();
      if (!r2 || Number.isNaN(r2.from) || Number.isNaN(r2.to)) break;
      rr = r2;
    }
    const f = Math.max(0, Math.min(last, Math.round(pickFrom(rr))));
    const t = Math.max(f, Math.min(last, Math.round(pickTo(rr))));
    return { fromIdx: f, toIdx: t };
  };
  let centered = centerOn();
  // 覆盖不足（实到根数 < span）⇒ 减小 barSpace 重居中（至多 10 次），保证回合完整可见。
  for (let i = 0; i < 10 && applied > min; i++) {
    if (!centered || centered.toIdx - centered.fromIdx + 1 >= span) break;
    const e3 = setAndVerify(Math.max(min, applied - 1));
    if (e3) return e3;
    centered = centerOn();
  }
  if (!centered) {
    return fail('getVisibleRange() 返回 NaN（视口不可读）⇒ 跳转结果无法断言', {
      requested_bar_space: firstApplied,
    });
  }
  const { fromIdx, toIdx } = centered;
  const halfVis = Math.floor((toIdx - fromIdx) / 2);
  const obsCenterIdx = Math.round((fromIdx + toIdx) / 2);
  const edgeClamped = idx - halfVis < 0 || idx + halfVis > last;
  const observed: WindowApplyObserved = {
    from_idx: fromIdx,
    to_idx: toIdx,
    from_ts: Math.floor((list[fromIdx] as { timestamp: number }).timestamp / CHART_TS_MS),
    to_ts: Math.floor((list[toIdx] as { timestamp: number }).timestamp / CHART_TS_MS),
    bar_space: applied,
    requested_bar_space: firstApplied,
    center_idx: idx,
    center_ts: Math.floor((list[idx] as { timestamp: number }).timestamp / CHART_TS_MS),
    observed_center_idx: obsCenterIdx,
    observed_center_ts: Math.floor((list[obsCenterIdx] as { timestamp: number }).timestamp / CHART_TS_MS),
    edge_clamped: edgeClamped,
  };
  if (idx < fromIdx - 1 || idx > toIdx + 1) {
    return fail(`跳转后目标 bar（索引 ${idx}）不在可视窗口 [${fromIdx}, ${toIdx}] 内`, {
      requested_bar_space: firstApplied,
      observed,
    });
  }
  const centerErr = Math.abs((fromIdx + toIdx) / 2 - idx);
  if (!edgeClamped && centerErr > 1) {
    return fail(
      `跳转后窗口未居中：中心误差 ${centerErr.toFixed(1)} 根 > 1（目标 ${idx}，实测 [${fromIdx}, ${toIdx}]）`,
      { requested_bar_space: firstApplied, observed },
    );
  }
  return { rev: cmd.rev, ok: true, error: null, requested_bar_space: firstApplied, observed };
}
