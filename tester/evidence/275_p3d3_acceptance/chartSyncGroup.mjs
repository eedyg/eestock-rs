const MAX_ALIGN_CORRECTION_ITERATIONS = 3;
const MAX_BAR_SPACE_STEP_RATIO = 0.5;
const SATELLITE_MAX_BAR_SPACE = 350;
const BASE_MAX_BAR_SPACE = 50;
const SUPPRESSION_WINDOW_MS = 16;
const PERIOD_BUCKET_MS = {
  "1m": 6e4,
  "5m": 3e5,
  "15m": 9e5,
  "1h": 36e5,
  "1d": 864e5,
  "1w": 6048e5
};
const MEASURED_DENSITY_TABLE = {
  "1m:5m": 4.7,
  "1m:15m": 12.2,
  "1m:1h": 37.8,
  "1d:1w": 4.67,
  "1h:1w": 24
};
function periodBucketMs(period) {
  const b = PERIOD_BUCKET_MS[period];
  return typeof b === "number" && Number.isFinite(b) && b > 0 ? b : null;
}
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function clampIndex(v, max) {
  if (!isNum(v)) return 0;
  const i = Math.round(v);
  return i < 0 ? 0 : i > max ? max : i;
}
function densityRatio(basePeriod, satellitePeriod) {
  if (basePeriod === satellitePeriod) return 1;
  const d = MEASURED_DENSITY_TABLE[`${basePeriod}:${satellitePeriod}`];
  return isNum(d) && d > 0 ? d : null;
}
function estimateDensityRatio(input) {
  const { baseBarCount, satBarCount } = input;
  if (!isNum(baseBarCount) || baseBarCount <= 0) return null;
  if (!isNum(satBarCount) || satBarCount <= 1) return null;
  const ratio = baseBarCount / satBarCount;
  return isNum(ratio) && ratio > 0 ? ratio : null;
}
function resolveDensityRatio(basePeriod, satellitePeriod, measured) {
  if (isNum(measured) && measured > 0) return { ratio: measured, source: "measured" };
  const stat = densityRatio(basePeriod, satellitePeriod);
  return stat === null ? { ratio: null, source: "none" } : { ratio: stat, source: "static" };
}
function alignSatelliteBarSpace(input) {
  const { baseBarSpace, density, paneWidthPx, maxBarSpace } = input;
  const idealRaw = isNum(baseBarSpace) && isNum(density) ? Math.round(baseBarSpace * density) : 0;
  const idealBarSpace = Math.max(1, idealRaw);
  const capacity = Math.max(1, Math.floor(paneWidthPx / 2));
  const hardMax = isNum(maxBarSpace) && maxBarSpace >= 1 ? Math.floor(maxBarSpace) : 1;
  let barSpace = idealBarSpace;
  let degraded = false;
  let degradedReason = null;
  if (idealBarSpace > capacity) {
    barSpace = capacity;
    degraded = true;
    degradedReason = "base-zoom";
  } else if (idealBarSpace > hardMax) {
    barSpace = hardMax;
    degraded = true;
    degradedReason = "limit";
  }
  barSpace = Math.max(1, barSpace);
  const visibleBars = Math.max(0, Math.floor(paneWidthPx / barSpace));
  return { idealBarSpace, barSpace, degraded, degradedReason, visibleBars };
}
function mirrorRightOffsetPx(baseOffsetRightPx, spaceRatio) {
  if (!isNum(baseOffsetRightPx) || !isNum(spaceRatio)) return 0;
  const px = baseOffsetRightPx * spaceRatio;
  return isNum(px) ? Math.round(px) : 0;
}
function periodOrder(period) {
  const order = {
    "1m": 1,
    "5m": 2,
    "15m": 3,
    "1h": 4,
    "1d": 5,
    "1w": 6
  };
  return order[period] ?? null;
}
function isSyncCombinationAllowed(basePeriod, satellitePeriod) {
  const a = periodOrder(basePeriod);
  const b = periodOrder(satellitePeriod);
  if (a === null || b === null) return false;
  if (b < a) return false;
  if (satellitePeriod === "1w" && a < periodOrder("1d")) return false;
  if (basePeriod === satellitePeriod) return true;
  return densityRatio(basePeriod, satellitePeriod) !== null;
}
function densityFactors() {
  const factors = {};
  const put = (period, anchor, factor) => {
    const m = factors[period] ?? {};
    m[anchor] = factor;
    factors[period] = m;
  };
  for (const [key, d] of Object.entries(MEASURED_DENSITY_TABLE)) {
    const [base, sat] = key.split(":");
    if (base === void 0 || sat === void 0) continue;
    put(sat, base, d);
    put(base, base, 1);
  }
  return factors;
}
function composeDensity(basePeriod, satellitePeriod) {
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
function lowerBoundByTs(list, ts) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    const item = list[mid];
    if (item !== void 0 && item.timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function countBarsInWindow(list, fromTs, toTs) {
  if (list.length === 0 || !isNum(fromTs) || !isNum(toTs) || toTs < fromTs) return 0;
  const start = lowerBoundByTs(list, fromTs);
  const end = lowerBoundByTs(list, toTs + 1);
  return Math.max(0, end - start);
}
function nearestIndexByTs(list, ts) {
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
const SYNC_ACTIONS = ["onScroll", "onZoom", "onVisibleRangeChange"];
class ChartSyncGroup {
  members;
  satelliteMaxBarSpace;
  suppressionEnabled;
  extraDensityTable;
  statsObj = {
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
    barSpaceAdjust: 0
  };
  listeners = /* @__PURE__ */ new Set();
  /** 成员 id → 已知 `barSpace` 上限（基准恒 50；卫星首次被静默吞掉时**探测**真实上限）。 */
  caps = /* @__PURE__ */ new Map();
  subscriptions = [];
  started = false;
  /** 应用同步的嵌套深度（>0 ⇒ 回传事件属于重入）。 */
  applyDepth = 0;
  /** 程序化写入深度（实时跟随/回到最新；此窗内的图表事件不属于用户交互）。 */
  programmaticDepth = 0;
  suppressUntil = 0;
  lastLeaderId = null;
  constructor(members, options = {}) {
    this.members = [...members];
    this.satelliteMaxBarSpace = options.satelliteMaxBarSpace ?? SATELLITE_MAX_BAR_SPACE;
    this.suppressionEnabled = options.reentrySuppression !== false;
    this.extraDensityTable = { ...options.densityTable ?? {} };
    const base = this.members.find((m) => m.isBase);
    if (base) {
      for (const m of this.members) {
        if (m === base) continue;
        if (!isSyncCombinationAllowed(base.period, m.period)) {
          throw new Error(
            `\u591A\u5468\u671F\u540C\u6B65\u7EC4\u5408\u4E0D\u53EF\u7528\uFF1A\u57FA\u51C6 ${base.period} \u2194 \u536B\u661F ${m.period} \u6052\u9000\u5316/\u65E0\u91CD\u53E0\uFF08\u7981\u6B62\u9759\u9ED8\u865A\u5047\u5BF9\u9F50\uFF09`
          );
        }
      }
    }
    for (const m of this.members) this.caps.set(m.id, m.isBase ? BASE_MAX_BAR_SPACE : this.satelliteMaxBarSpace);
  }
  get stats() {
    return this.statsObj;
  }
  /** 订阅同步统计（返回退订函数）。 */
  onChange(cb) {
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
  applySatelliteLimits() {
    for (const m of this.members) {
      this.caps.set(m.id, m.isBase ? BASE_MAX_BAR_SPACE : this.satelliteMaxBarSpace);
    }
  }
  start() {
    if (this.started) return;
    this.started = true;
    for (const m of this.members) {
      const chart = m.chart;
      if (typeof chart.subscribeAction !== "function") continue;
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
  stop() {
    this.started = false;
    for (const s of this.subscriptions) {
      try {
        s.member.chart.unsubscribeAction?.(s.type, s.handler);
      } catch {
      }
    }
    this.subscriptions.length = 0;
    this.applyDepth = 0;
  }
  /** 程序化写入标记（实时跟随 / 回到最新）：此窗内的图表事件不是用户交互 ⇒ 不作为 leader。 */
  beginProgrammatic() {
    this.programmaticDepth += 1;
  }
  endProgrammatic() {
    if (this.programmaticDepth > 0) this.programmaticDepth = 0;
  }
  /** 「回到最新」：所有成员右端对齐（各自末根 bar + 右偏移归零 ⇒ 右缘同刻度）。 */
  scrollAllToLatest() {
    this.applyDepth += 1;
    try {
      this.zeroRightOffsets(this.members);
      for (const m of this.members) {
        const chart = m.chart;
        if (typeof chart.getDataList !== "function") continue;
        const list = chart.getDataList();
        if (!Array.isArray(list) || list.length === 0) continue;
        const lastIndex = list.length - 1;
        try {
          if (typeof chart.scrollToDataIndex === "function") chart.scrollToDataIndex(lastIndex);
          else chart.scrollToRealTime?.();
        } catch {
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
  handleEvent(member) {
    if (!this.started) return;
    if (this.programmaticDepth > 0) {
      this.statsObj.suppressed += 1;
      return;
    }
    if (this.applyDepth > 0) {
      if (this.suppressionEnabled) {
        this.statsObj.suppressed += 1;
        return;
      }
      this.statsObj.echoEvents += 1;
      if (this.applyDepth <= 1) this.alignFrom(member);
      return;
    }
    if (this.suppressionEnabled && Date.now() < this.suppressUntil && member.id !== this.lastLeaderId) {
      this.statsObj.suppressed += 1;
      return;
    }
    this.alignFrom(member);
  }
  /** 以 `leader` 的可见时间窗对齐其余成员（单向广播：leader → followers）。 */
  alignFrom(leader) {
    this.applyDepth += 1;
    this.lastLeaderId = leader.id;
    let degraded = false;
    let degradedPeriod = null;
    let spanDiffMinutes = null;
    let applied = false;
    let unaligned = 0;
    let lastUnalignedReason = null;
    let iterations = 0;
    let spanResidualBars = null;
    let edgeResidualBars = null;
    let barSpaceAdjust = 0;
    try {
      const targets = this.members.filter((m) => m !== leader && !m.isBase);
      this.zeroRightOffsets([leader, ...targets]);
      const leaderWindow = this.readWindow(leader);
      const leaderBarSpace = this.barSpaceOf(leader);
      if (!leaderWindow || !isNum(leaderBarSpace) || leaderBarSpace <= 0) {
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
        if (typeof f.chart.setBarSpace !== "function" || typeof f.chart.getBarSpace !== "function") {
          unaligned += 1;
          lastUnalignedReason = `${f.period}:no-barspace-api`;
          continue;
        }
        const paneWidth = this.paneWidth(f);
        if (!(paneWidth > 0)) {
          unaligned += 1;
          lastUnalignedReason = `${f.period}:no-layout`;
          continue;
        }
        const density = this.effectiveDensity(leader, f);
        if (!isNum(density) || density <= 0) {
          unaligned += 1;
          lastUnalignedReason = `${f.period}:no-density-anchor`;
          continue;
        }
        const cap = f.isBase ? BASE_MAX_BAR_SPACE : this.caps.get(f.id) ?? this.satelliteMaxBarSpace;
        let result = alignSatelliteBarSpace({
          baseBarSpace: leaderBarSpace,
          density,
          paneWidthPx: paneWidth,
          maxBarSpace: cap
        });
        this.writeBarSpace(f, result.barSpace);
        let actual = this.barSpaceOf(f);
        if (actual !== result.barSpace && !f.isBase) {
          const probed = this.probeMaxBarSpace(f, Math.max(1, Math.min(result.barSpace, cap)));
          if (isNum(probed) && probed >= 1 && probed < result.barSpace) {
            this.caps.set(f.id, probed);
            result = alignSatelliteBarSpace({
              baseBarSpace: leaderBarSpace,
              density,
              paneWidthPx: paneWidth,
              maxBarSpace: probed
            });
            this.writeBarSpace(f, result.barSpace);
            actual = this.barSpaceOf(f);
          }
        }
        if (actual !== result.barSpace) {
          result = {
            ...result,
            barSpace: isNum(actual) && actual > 0 ? actual : result.barSpace,
            degraded: true,
            degradedReason: "limit"
          };
        }
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
        const adjust = isNum(finalBarSpace) && isNum(result.idealBarSpace) ? finalBarSpace - result.idealBarSpace : 0;
        if (Math.abs(adjust) > Math.abs(barSpaceAdjust)) barSpaceAdjust = adjust;
        if (!outcome.aligned) {
          unaligned += 1;
          lastUnalignedReason = `${f.period}:${outcome.reason ?? "unconverged"}`;
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
  alignFollowerWindow(f, leaderWindow, paneWidth, cap) {
    const none = { spanDiffMinutes: null, spanResidualBars: null, edgeResidualBars: null };
    const list = this.dataList(f);
    if (!list || list.length === 0) {
      return { aligned: false, degraded: false, iterations: 0, ...none, reason: "no-data" };
    }
    const measuredSpacing = medianSpacing(list) ?? 0;
    const spacing = measuredSpacing > 0 ? measuredSpacing : periodBucketMs(f.period) ?? 0;
    const tolMs = spacing > 0 ? spacing : 0;
    const capacity = Math.max(1, Math.min(cap, Math.max(1, Math.floor(paneWidth / 2))));
    const lastIndex = list.length - 1;
    let requestedIdx = clampIndex(nearestIndexByTs(list, leaderWindow.toTs), lastIndex);
    const triedIdx = /* @__PURE__ */ new Set([requestedIdx]);
    const triedBarSpaces = /* @__PURE__ */ new Set([Math.round(this.barSpaceOf(f))]);
    let iterations = 0;
    let bestEdgeResidualMs = Number.POSITIVE_INFINITY;
    let bestSpanResidualMs = Number.POSITIVE_INFINITY;
    if (!this.positionFollower(f, requestedIdx)) {
      return { aligned: false, degraded: true, iterations: 0, ...none, reason: "no-scroll-api" };
    }
    iterations += 1;
    for (; ; ) {
      const fw = this.readWindow(f);
      if (!fw) {
        return { aligned: false, degraded: true, iterations, ...none, reason: "no-window" };
      }
      const spanDiffMs = fw.spanMs - leaderWindow.spanMs;
      const edgeDiffMs = fw.toTs - leaderWindow.toTs;
      const spanDiffMinutes = Math.round(Math.abs(spanDiffMs) / 6e4 * 10) / 10;
      const spanResidualBars = spacing > 0 ? Math.abs(spanDiffMs) / spacing : null;
      const edgeResidualBars = spacing > 0 ? Math.abs(edgeDiffMs) / spacing : null;
      const residual = { spanDiffMinutes, spanResidualBars, edgeResidualBars };
      if (Math.abs(spanDiffMs) <= tolMs && Math.abs(edgeDiffMs) <= tolMs) {
        return { aligned: true, degraded: false, iterations, ...residual, reason: null };
      }
      if (iterations >= MAX_ALIGN_CORRECTION_ITERATIONS) {
        return { aligned: false, degraded: true, iterations, ...residual, reason: "iteration-cap" };
      }
      let corrected = false;
      if (Math.abs(edgeDiffMs) > tolMs) {
        if (Math.abs(edgeDiffMs) >= bestEdgeResidualMs) {
          return { aligned: false, degraded: true, iterations, ...residual, reason: "no-improvement" };
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
      if (Math.abs(spanDiffMs) > tolMs) {
        if (Math.abs(spanDiffMs) >= bestSpanResidualMs) {
          return { aligned: false, degraded: true, iterations, ...residual, reason: "no-improvement" };
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
        return { aligned: false, degraded: true, iterations, ...residual, reason: "unreachable" };
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
  positionFollower(f, index) {
    const chart = f.chart;
    if (typeof chart.scrollToDataIndex === "function") {
      try {
        chart.scrollToDataIndex(index);
        return true;
      } catch {
      }
    }
    if (typeof chart.scrollToTimestamp === "function") {
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
  effectiveDensity(leader, follower) {
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
  lookupDensity(base, sat, table) {
    if (base === sat) return 1;
    const d = table[`${base}:${sat}`];
    return isNum(d) && d > 0 ? d : null;
  }
  /**
   * 运行时密度估计：在两侧可见窗的**交叠 ts 窗**内统计 bar 数（二分求解索引窗）后取比值；
   * 交叠不存在 / 任一侧 ≤1 根 / 无 bar ⇒ null（估计器失效，交由静态表兜底）。
   */
  measureDensity(leader, follower) {
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
      satBarCount: countBarsInWindow(fList, from, to)
    });
  }
  readWindow(m) {
    const chart = m.chart;
    if (typeof chart.getVisibleRange !== "function") return null;
    let range;
    try {
      range = chart.getVisibleRange();
    } catch {
      return null;
    }
    if (!range || !isNum(range.realTo) || !isNum(range.realFrom)) return null;
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
  dataList(m) {
    const chart = m.chart;
    if (typeof chart.getDataList !== "function") return null;
    try {
      const list = chart.getDataList();
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }
  barSpaceOf(m) {
    try {
      const bs = m.chart.getBarSpace?.();
      return isNum(bs?.bar) ? bs.bar : Number.NaN;
    } catch {
      return Number.NaN;
    }
  }
  paneWidth(m) {
    try {
      const size = m.chart.getSize?.();
      return isNum(size?.width) ? size.width : 0;
    } catch {
      return 0;
    }
  }
  writeBarSpace(m, space) {
    try {
      m.chart.setBarSpace?.(space);
    } catch {
    }
  }
  /** 右偏移归零（右缘对齐前置；`getOffsetRightDistance()` 是 px 量级）。 */
  zeroRightOffsets(members) {
    for (const m of members) {
      const chart = m.chart;
      if (typeof chart.getOffsetRightDistance !== "function" || typeof chart.setOffsetRightDistance !== "function") {
        continue;
      }
      let current = null;
      try {
        current = chart.getOffsetRightDistance();
      } catch {
        current = null;
      }
      if (!isNum(current) || current <= 0) continue;
      try {
        chart.setOffsetRightDistance(0);
      } catch {
      }
    }
  }
  /**
   * 探测真实 `barSpaceLimit.max`（klinecharts 无 getter）：在 `[1, upper]` 二分，取**被接受的最大值**
   * （读回校验；越界被静默吞掉 ⇒ 读回 ≠ 请求）。探测后**还原**原 barSpace，避免留下副作用。
   */
  probeMaxBarSpace(m, upper) {
    const chart = m.chart;
    if (typeof chart.setBarSpace !== "function" || typeof chart.getBarSpace !== "function") return null;
    const original = this.barSpaceOf(m);
    let lo = 1;
    let hi = Math.max(1, Math.floor(upper));
    let best = null;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
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
  broadcast() {
    const snapshot = { ...this.statsObj };
    for (const cb of [...this.listeners]) {
      try {
        cb(snapshot);
      } catch {
      }
    }
  }
}
function medianSpacing(list) {
  if (list.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]?.timestamp;
    const b = list[i]?.timestamp;
    if (isNum(a) && isNum(b) && b > a) gaps.push(b - a);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  const mid = gaps.length >> 1;
  const v = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return isNum(v) && v > 0 ? v : null;
}
export {
  BASE_MAX_BAR_SPACE,
  ChartSyncGroup,
  MAX_ALIGN_CORRECTION_ITERATIONS,
  MAX_BAR_SPACE_STEP_RATIO,
  MEASURED_DENSITY_TABLE,
  PERIOD_BUCKET_MS,
  SATELLITE_MAX_BAR_SPACE,
  SUPPRESSION_WINDOW_MS,
  alignSatelliteBarSpace,
  countBarsInWindow,
  densityRatio,
  estimateDensityRatio,
  isSyncCombinationAllowed,
  lowerBoundByTs,
  mirrorRightOffsetPx,
  nearestIndexByTs,
  periodBucketMs,
  resolveDensityRatio
};
