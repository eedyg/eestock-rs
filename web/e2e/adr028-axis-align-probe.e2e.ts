/**
 * ADR-027/028 时间轴对齐探针（**tester 车道**；`v2 = 主口径修正版`，2026-09-20）。
 *
 * ─────────────────────────────────── 本版（v2）为什么改口径 ───────────────────────────────────
 * v1 的**主口径** Δ984 把曲线**渲染 x** 用「ts 线性」反解成 ts（`ts(x) = D0 + ((x−8)/984)·(D1−D0)`），
 * 再与同一 ts 的 K 线像素比。该反解**只在曲线本身按 ts 线性绘制时与渲染同源**。
 * 修复方（`coder/evidence/20260920_adr027_axis_fix/report.md` §3）证明：修复把曲线 x 改成
 * **bar 索引空间**（ADR-028 D2.1）后，反解与渲染不再同源 ⇒ v1 主口径测的是「K 线按 ts 插值口径 vs
 * ts 线性口径」之差，**与曲线怎么画无关**（其量级在执行前后均为 119~352px）。架构师裁决：
 * 该 119~352px 属**度量口径错误**，不属缺陷；偏差的**唯一有效口径** = **同一根 bar（同一 ts）在 K 线与
 * 各曲线图上的 x 坐标配对偏差**，判据 ≤2px（984px 参考宽度）。
 *
 * ⇒ v2 修正（**只改口径，不改判据阈值，不放宽**）：
 *   1. **主口径 `pair`**：同一根 bar 配对 —— 曲线**渲染顶点**（已渲染 `<polyline>`）与 K 线**真身可见 bar**
 *      （`convertToPixel({timestamp})` 实测像素）一一配对（ts 最近邻 + 容差，禁止钳位；配对单调一对一）。
 *      判据 `max|Δ984| ≤ 2px`（归一化，锚点 = 配对首末）且 `max|Δraw| ≤ 2px`（真身屏幕像素，未归一化）。
 *   2. **v1 主口径降级为诊断字段** `legacy.tsLinearInverseSolve984`，字段内显式标注
 *      `applicableTo: '仅适用于修复前口径（曲线按 ts 线性绘制）'`；其代码路径与 v1 逐行相同，
 *      故在**修复前产物/ts 线性产物**上可逐位复现 v1 的历史数值（口径可比性证明见报告）。
 *   3. **映射身份检查（自校验配对 + 反假绿）**：对每个配对点，比较渲染 userX 与
 *      ① 索引空间预测 `8 + j/(N−1)·984`、② ts 线性预测 `8 + (ts−ts₀)/(ts_N−ts₀)·984`。
 *      ① 残差 ≈ 0 ⇒ 配对与「索引空间映射」自洽（配对错则残差巨大 ⇒ 自校验）；
 *      ② 残差在大缺口态巨大 ⇒ 证明本探针**能区分**两种映射（口径有牙），不是对映射不敏感的空判据。
 *   4. **跟随性**：每态给出「曲线首/末渲染顶点 vs K 线首/末可见 bar」的配对偏差（Δraw/Δ984）+
 *      曲线顶点数 vs 可见 bar 数 + 曲线 plot 覆盖率（修复要求 = 1.000，修复前全览态 0.0253）。
 *   5. **数据/域原子性**：窗口切换**前后逐帧采样**（页面侧 setInterval），断言
 *      ①「数据 ⊂ 声明定义域」；② 非加载态样本的渲染签名必须已到**新快照**（旧数据静默残留 = 红）；
 *      ③ 加载态样本的渲染签名必须**恰等于**切换前/后的整组快照之一（旧数据+新域 / 新数据+旧域 = 红）。
 *   6. **披露类**：全览 `wb-window-cap`（`显示 N / 共 M 根`，N = 真身可见根数、M = run 总根数）、
 *      `wb-window-clamped`、`wb-axis-degraded`（**注入降级**验证：K 线 bar 序列不可得 ⇒ per_bar 降级；
 *      再令 per_bar 亦不可得 ⇒ 纯 ts 线性降级）、`wb-curve-unmatched`、`data-x-mode`。
 *
 * 探针纪律：页面侧**只读**（仅包 `Map.prototype.set` 捕获 klinecharts 实例以调其只读 getter；
 * 拖拽/滚轮为用户手势；若手势平移不可用，才回退到 `scrollToDataIndex` 的**视口**移动并在报告中披露）。
 * 测量有效性用恒真反证约束（K 线真身可读、相邻 bar 像素间隔 ≈ barSpace、曲线已渲染、配对点数 > 0）。
 *
 * 运行（对已在跑的线上版本 8081，**不起 vite preview**）：
 *   cd web && E2E_BASE_URL=http://localhost:8081 npx playwright test e2e/adr028-axis-align-probe.e2e.ts --reporter=list --retries=0
 * 产物落盘：`ADR027_ALIGN_OUT`（默认 `tester/evidence/20260920_adr027_axis_verify/raw`）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertResolvedByIdFresh,
  resolveRun,
  type ResolvedRun,
  type RunFetchPort,
  type RunFill,
  type RunListItem,
  type RunRoundTrip,
} from './adr028RunResolve';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/**
 * 证据落盘目录：**必须落未跟踪目录**（`AGENTS.md`「代理产物与提交纪律」；旧默认路径
 * `tester/evidence/20260920_adr027_axis_verify/raw/` 已被 git 跟踪 ⇒ 每次真跑都会覆写已跟踪文件）。
 * 可用 `ADR027_ALIGN_OUT` 覆盖。
 */
const OUT = process.env.ADR027_ALIGN_OUT ?? resolve(REPO, 'coder/evidence/20260925_adr028_d10_ruling/raw_axis_probe');
/**
 * **ADR-028 §2.10.1 裁决 3｜规格耐久**：目标 run（518880 / M5 / 根数足够、含周末·隔夜·午休缺口）
 * 按**谓词解析** —— 禁硬编码 run id（库增长会把目标 run 顶出历史列表首屏）；解析失败 ⇒ 显式红。
 * `RUN_ID` 由 {@link resolveTargetRun} 在用例开始时填入（**已废除**的历史字面量：`sr_1789832517800_000006`）。
 */
let RUN_ID = '';
/** M5 ⇒ 单根 bar 秒数（配对容差与「根」换算用）。 */
const BAR_SECONDS = 300;
/** 曲线 plot 宽度（user units）：`AggregateScoreChart` W=1000 / PAD=8 ⇒ 984。 */
const CURVE_W = 1000;
const CURVE_PAD = 8;
const CURVE_PLOT_W = CURVE_W - 2 * CURVE_PAD;
/** 判据阈值（px）。 */
const ALIGN_TOL_PX = 2;
/** 配对容差（秒）：真身 per_bar ts 与 K 线 bar ts 可差数秒（实测 ~4s）⇒ 最近邻吸附。 */
const PAIR_TOL_SEC = Math.max(60, Math.round(BAR_SECONDS / 2));
/** 滚轮缩小目标可见根数（⑥ ~300 根）。 */
const ZOOM_TARGET_BARS = 300;
/** 无缺口对照（补充态）：滚轮放大到 ≤ 该根数并贴收盘。 */
const ZOOM_IN_TARGET_BARS = 40;

// ─────────────────────────────────── 页面侧探针（自包含，勿引用外部作用域） ───────────────────────────────────

/** 只读捕获 klinecharts 真身实例。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { scrollToDataIndex?: unknown; setBarSpace?: unknown; convertToPixel?: unknown } | null;
    if (
      o != null &&
      typeof o === 'object' &&
      typeof o['scrollToDataIndex'] === 'function' &&
      typeof o['setBarSpace'] === 'function' &&
      typeof o['convertToPixel'] === 'function'
    ) {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}

/** K 线真身读回：dataList 端点/可见区间/barSpace + **可见 bar 的真实渲染像素 x**（绝对屏幕坐标）。 */
function probeKline() {
  interface ChartLike {
    getDataList?: () => Array<{ timestamp: number }>;
    getVisibleRange?: () => { from: number; to: number; realFrom?: number; realTo?: number };
    getBarSpace?: () => { bar: number };
    getSize?: () => { width: number; height?: number } | null;
    convertToPixel?: (p: { timestamp: number }, f?: { paneId?: string }) => { x?: number; y?: number } | undefined;
  }
  const empty = (error: string, extra: Record<string, unknown> = {}) => ({
    ok: false,
    error,
    chartCount: 0,
    withDataCount: 0,
    dataLen: -1,
    dataFirstTs: null as number | null,
    dataLastTs: null as number | null,
    container: null as null | { left: number; top: number; width: number; height: number },
    ts: [] as number[],
    xRaw: [] as number[],
    xAbs: [] as number[],
    fromIdx: -1,
    toIdx: -1,
    realFrom: null as number | null,
    realTo: null as number | null,
    barSpace: null as number | null,
    spacingDistinct: [] as number[],
    visibleCount: 0,
    candidates: [] as Array<{ n: number; width: number; err: string }>,
    ...extra,
  });
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const chartDiv = document.querySelector('[data-testid="kline-chart"]');
  const host = document.querySelector('[data-testid="wb-kline-chart"]');
  const rectOf = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const container = rectOf(chartDiv ?? host);
  const cands = (w.__wbCharts ?? []).map((chart) => {
    let n = -1;
    let width = -1;
    let err = '';
    try {
      n = (chart.getDataList?.() ?? []).length;
      width = chart.getSize?.()?.width ?? -1;
    } catch (e) {
      err = String(e);
    }
    return { chart, n, width, err };
  });
  const withData = cands.filter((c) => c.n > 0);
  const chosen =
    withData.length > 0
      ? withData.reduce((a, b) =>
          Math.abs(a.width - (container?.width ?? 0)) <= Math.abs(b.width - (container?.width ?? 0)) ? a : b,
        )
      : null;
  if (!chosen || !container) {
    return empty(!chosen ? '未捕获到有数据的 K 线实例' : 'K 线容器不可测', {
      chartCount: cands.length,
      withDataCount: withData.length,
      container,
      candidates: cands.map((c) => ({ n: c.n, width: c.width, err: c.err })),
    });
  }
  const chart = chosen.chart;
  const list = chart.getDataList!();
  const range = chart.getVisibleRange!();
  const barSpace = chart.getBarSpace?.()?.bar ?? null;
  const last = list.length - 1;
  const fromIdx = Math.max(0, Math.min(last, Math.round(range.from)));
  const toIdx = Math.max(fromIdx, Math.min(last, Math.round(range.to)));
  const ts: number[] = [];
  const xRaw: number[] = [];
  const xAbs: number[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const ms = list[i]!.timestamp;
    let px: number | null = null;
    try {
      const p = chart.convertToPixel!({ timestamp: ms }, { paneId: 'candle_pane' });
      px = typeof p?.x === 'number' ? p.x : null;
    } catch {
      px = null;
    }
    ts.push(Math.floor(ms / 1000));
    xRaw.push(px ?? Number.NaN);
    xAbs.push(px == null ? Number.NaN : px + container.left);
  }
  const diffs: number[] = [];
  for (let i = 1; i < xRaw.length; i++) {
    const d = xRaw[i]! - xRaw[i - 1]!;
    if (Number.isFinite(d)) diffs.push(Math.round(d * 1000) / 1000);
  }
  return {
    ok: true,
    error: '',
    chartCount: cands.length,
    withDataCount: withData.length,
    dataLen: list.length,
    dataFirstTs: Math.floor(list[0]!.timestamp / 1000),
    dataLastTs: Math.floor(list[last]!.timestamp / 1000),
    container,
    ts,
    xRaw,
    xAbs,
    fromIdx,
    toIdx,
    realFrom: Number.isFinite(range.realFrom as number) ? (range.realFrom as number) : null,
    realTo: Number.isFinite(range.realTo as number) ? (range.realTo as number) : null,
    barSpace,
    spacingDistinct: Array.from(new Set(diffs)).sort((a, b) => a - b),
    visibleCount: toIdx - fromIdx + 1,
    candidates: cands.map((c) => ({ n: c.n, width: c.width, err: c.err })),
  };
}

/** 曲线视图**已渲染**几何：`data-x-mode`/`data-x-domain` + `<polyline>` 的 user-unit x 与屏幕 x。 */
function probeCurve(testId: string) {
  interface Poly {
    n: number;
    firstUserX: number | null;
    lastUserX: number | null;
    sumUserX: number | null;
    userX: number[];
    screenX: Array<number | null>;
    diag?: string;
  }
  const host = document.querySelector(`[data-testid="${testId}"]`);
  if (!host) return { present: false, mode: null as string | null, domain: null as string | null, svg: false, polys: [] as Poly[] };
  const svg = host.querySelector('svg') as SVGSVGElement | null;
  const mode = host.getAttribute('data-x-mode');
  const domain = host.getAttribute('data-x-domain');
  if (!svg) return { present: true, mode, domain, svg: false, polys: [] as Poly[] };
  const r = svg.getBoundingClientRect();
  const ctm = svg.getScreenCTM();
  const pt = svg.createSVGPoint();
  const toScreenX = (x: number): number | null => {
    if (!ctm) return null;
    pt.x = x;
    pt.y = 0;
    return pt.matrixTransform(ctm).x;
  };
  const polys: Poly[] = Array.from(svg.querySelectorAll('polyline')).map((p) => {
    const attr = p.getAttribute('points') ?? '';
    const nums = attr
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => Number(tok.split(',')[0]))
      .filter((v) => Number.isFinite(v));
    return {
      n: nums.length,
      firstUserX: nums[0] ?? null,
      lastUserX: nums[nums.length - 1] ?? null,
      sumUserX: nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null,
      userX: nums,
      screenX: nums.map((x) => toScreenX(x)),
      diag: `attrLen=${attr.length}`,
    };
  });
  return {
    present: true,
    mode,
    domain,
    svg: true,
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    viewBox: svg.getAttribute('viewBox'),
    ctmAvailable: ctm != null,
    polys,
  };
}

/** 轻量读回：K 线可见根数 + 可见索引区间（拖拽/滚轮循环用）。 */
function probeVisibleCount() {
  const w = window as unknown as {
    __wbCharts?: Array<{
      getDataList?: () => unknown[];
      getVisibleRange?: () => { from: number; to: number };
      scrollToDataIndex?: (i: number) => void;
    }>;
  };
  let count = 0;
  let to = -1;
  let len = -1;
  for (const c of w.__wbCharts ?? []) {
    try {
      const n = (c.getDataList?.() ?? []).length;
      if (n <= 0) continue;
      const r = c.getVisibleRange?.();
      if (!r) continue;
      const cur = Math.round(r.to) - Math.round(r.from) + 1;
      if (cur > count) {
        count = cur;
        to = Math.round(r.to);
        len = n;
      }
    } catch {
      /* ignore */
    }
  }
  return { count, to, len };
}

/** 视口移动到最右（**仅当手势平移不可用时**的回退；调用方须在报告中披露）。 */
function engineScrollToLatest() {
  const w = window as unknown as {
    __wbCharts?: Array<{ getDataList?: () => unknown[]; scrollToDataIndex?: (i: number) => void }>;
  };
  for (const c of w.__wbCharts ?? []) {
    const n = (c.getDataList?.() ?? []).length;
    if (n > 0 && typeof c.scrollToDataIndex === 'function') {
      c.scrollToDataIndex(n - 1);
      return { ok: true, chartLen: n };
    }
  }
  return { ok: false, chartLen: 0 };
}

/** 逐帧采样（窗口切换原子性）：页面侧 setInterval 收集渲染签名。 */
function startSampler(): void {
  const w = window as unknown as { __wbSamples?: unknown[]; __wbSampler?: number };
  w.__wbSamples = [];
  const snap = () => {
    const txt = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    const has = (id: string) => document.querySelector(`[data-testid="${id}"]`) != null;
    const st = document.querySelector('[data-testid="wb-window-state"]');
    const host = document.querySelector('[data-testid="wb-aggregate-chart"]');
    const svg = host?.querySelector('svg') ?? null;
    const poly = host?.querySelector('polyline');
    const nums = (poly?.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => Number(t.split(',')[0]))
      .filter((v) => Number.isFinite(v));
    const kcharts = (window as unknown as {
      __wbCharts?: Array<{
        getDataList?: () => unknown[];
        getVisibleRange?: () => { from: number; to: number };
        convertToPixel?: (p: { timestamp: number }) => { x?: number } | undefined;
      }>;
    }).__wbCharts;
    let kFrom = -1;
    let kTo = -1;
    let kLen = -1;
    let kFirstTs: number | null = null;
    let kLastTs: number | null = null;
    let kXFirst: number | null = null;
    let kXLast: number | null = null;
    const hostRect = document.querySelector('[data-testid="kline-chart"]')?.getBoundingClientRect() ?? null;
    for (const c of kcharts ?? []) {
      try {
        const list = c.getDataList?.() ?? [];
        if (list.length <= 0) continue;
        const r = c.getVisibleRange?.();
        if (!r) continue;
        kFrom = Math.max(0, Math.min(list.length - 1, Math.round(r.from)));
        kTo = Math.max(kFrom, Math.min(list.length - 1, Math.round(r.to)));
        kLen = list.length;
        type BarLike = { timestamp: number };
        const first = (list as BarLike[])[kFrom]!;
        const lastB = (list as BarLike[])[kTo]!;
        kFirstTs = Math.floor(first.timestamp / 1000);
        kLastTs = Math.floor(lastB.timestamp / 1000);
        const p1 = c.convertToPixel?.({ timestamp: first.timestamp });
        const p2 = c.convertToPixel?.({ timestamp: lastB.timestamp });
        kXFirst = typeof p1?.x === 'number' ? p1.x + (hostRect?.left ?? 0) : null;
        kXLast = typeof p2?.x === 'number' ? p2.x + (hostRect?.left ?? 0) : null;
        break;
      } catch {
        /* ignore */
      }
    }
    const sig =
      nums.length === 0
        ? 'empty'
        : `${host?.getAttribute('data-x-mode') ?? '?'}|${nums.length}|${nums[0]!.toFixed(2)}|${nums[nums.length - 1]!.toFixed(2)}|${nums.reduce((a, b) => a + b, 0).toFixed(2)}|${svg?.getAttribute('viewBox') ?? ''}`;
    return {
      wallMs: Date.now(),
      source: st?.getAttribute('data-source') ?? null,
      rev: st?.getAttribute('data-rev') ?? null,
      fromTs: st?.getAttribute('data-from-ts') ?? null,
      toTs: st?.getAttribute('data-to-ts') ?? null,
      spanBars: st?.getAttribute('data-span-bars') ?? null,
      applying: has('wb-window-applying'),
      loadNote: txt('wb-window-load-note'),
      capNote: txt('wb-window-cap'),
      degraded: txt('wb-axis-degraded'),
      unmatched: txt('wb-curve-unmatched'),
      xMode: host?.getAttribute('data-x-mode') ?? null,
      domainAttr: host?.getAttribute('data-x-domain') ?? null,
      viewBox: svg?.getAttribute('viewBox') ?? null,
      vertices: nums.length,
      sig,
      kFrom,
      kTo,
      kLen,
      kFirstTs,
      kLastTs,
      kXFirst,
      kXLast,
    };
  };
  w.__wbSampler = window.setInterval(() => {
    try {
      w.__wbSamples!.push(snap());
    } catch {
      /* ignore */
    }
  }, 50);
  w.__wbSamples!.push(snap());
}

function stopSampler() {
  const w = window as unknown as { __wbSamples?: unknown[]; __wbSampler?: number };
  if (w.__wbSampler != null) window.clearInterval(w.__wbSampler);
  const out = w.__wbSamples ?? [];
  w.__wbSamples = [];
  w.__wbSampler = undefined;
  return out;
}

// ────────────────────────────────────────────── 类型与工具 ──────────────────────────────────────────────

interface WindowAttrs {
  state: Record<string, string> | null;
  probe: Record<string, string> | null;
  charts: Record<string, string | null>;
  modes: Record<string, string | null>;
  note: string | null;
  capNote: string | null;
  clampNote: string | null;
  degradedNote: string | null;
  unmatchedNote: string | null;
  applying: boolean;
  sampling: { aggregate: string | null; slot: string | null };
}

interface CurveApi {
  ok: boolean;
  status: number;
  ts: number[];
  downsampled: boolean | null;
  originalBars: number | null;
}

interface CurveGeom {
  present: boolean;
  mode: string | null;
  domain: string | null;
  svg: boolean;
  rect?: { left: number; top: number; width: number; height: number };
  viewBox?: string | null;
  ctmAvailable?: boolean;
  polys?: Array<{
    n: number;
    firstUserX: number | null;
    lastUserX: number | null;
    sumUserX: number | null;
    userX: number[];
    screenX: Array<number | null>;
    diag?: string;
  }>;
}

interface PairRow {
  i: number;
  j: number;
  ts: number;
  barTs: number;
  dTs: number;
  xK: number;
  xC: number;
  dRaw: number;
  d984: number;
  userX: number;
  predIndexUserX: number;
  predTsLinearUserX: number;
}

interface StateMeasure {
  label: string;
  kline: ReturnType<typeof probeKline>;
  curve: CurveGeom;
  slot: CurveGeom;
  attrs: WindowAttrs;
  domainAttr: string | null;
  domain: [number, number] | null;
  api: {
    ok: boolean;
    status: number;
    pointCount: number;
    downsampled: boolean | null;
    originalBars: number | null;
    firstTs: number | null;
    lastTs: number | null;
  };
  /** ── 主口径（v2）：同一根 bar 配对 ── */
  pair: {
    n: number;
    vertices: number;
    visibleBars: number;
    barsCovered: number;
    unpairedVertices: number;
    duplicateBars: number;
    outOfTolerance: number;
    maxAbsRaw: number | null;
    maxAbsRawTs: number | null;
    maxAbs984: number | null;
    maxAbs984Ts: number | null;
    spanK: number | null;
    spanC: number | null;
    first: PairRow | null;
    last: PairRow | null;
    /** 判据（≤2px）：配对偏差两个口径都必须达标 */
    ok: boolean;
  };
  /** ── 跟随性（曲线首/末顶点 vs K 线首/末可见 bar） ── */
  follow: {
    firstPairRaw: number | null;
    firstPair984: number | null;
    lastPairRaw: number | null;
    lastPair984: number | null;
    firstPairedBarIdx: number | null;
    lastPairedBarIdx: number | null;
    headUncoveredBars: number | null;
    tailUncoveredBars: number | null;
    spanDiffPx: number | null;
    coverageRatio: number | null;
    headDeficitPx984: number | null;
    tailDeficitPx984: number | null;
    ok: boolean;
  };
  /** ── 数据/域原子性 ── */
  atomic: {
    dataTsRange: [number, number] | null;
    dataInDomain: boolean | null;
    dataInKlineVisible: boolean | null;
    coverageRatio: number | null;
    ok: boolean;
    notes: string[];
  };
  /** ── 映射身份（自校验配对 + 映射可判别性） ── */
  mapping: {
    indexResidualMaxUser: number | null;
    tsLinearResidualMaxUser: number | null;
    tsLinearResidualMaxPx984: number | null;
    verdict: string;
  };
  /** ── 披露 ── */
  disclose: {
    capText: string | null;
    capVisible: number | null;
    capTotal: number | null;
    capMatchesTruth: boolean | null;
    clampText: string | null;
    degradedText: string | null;
    unmatchedText: string | null;
    unmatchedCount: number | null;
    unmatchedMatchesTruth: boolean | null;
    xMode: string | null;
    xModeAll: Record<string, string | null>;
    ok: boolean;
  };
  /** ── 诊断（仅适用于修复前口径；见文件头） ── */
  legacy: {
    applicableTo: string;
    curveDataTsRange: [number, number] | null;
    overlap: [number, number] | null;
    overlapBars: number;
    tsLinearInverseSolve984: number | null;
    indexVsTsModel984: number | null;
    fullDomainModel984: number | null;
    vertexMatch: boolean | null;
  };
  curveCoverage: {
    firstUserX: number | null;
    lastUserX: number | null;
    coverageRatio: number | null;
  };
  windowLevel: {
    klineVisible: [number, number] | null;
    domain: [number, number] | null;
    coverage: number | null;
  };
  gapCensus: Record<string, number>;
  spacingDistinct: number[];
  /** 主口径逐点序列（落盘用）。 */
  pairSeries: Array<Record<string, number | null>>;
  notes: string[];
  screenshots?: string[];
  zoom?: { steps: number; zoomEffective: boolean; targetBars: number };
  gesture?: Record<string, unknown>;
}

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

/** 分段线性求值（ts 升序；区间外返回 null，避免把「窗口不覆盖」静默当成 0）。 */
function lerpStrict(ts: number[], xs: number[], t: number): number | null {
  if (ts.length === 0 || xs.length !== ts.length) return null;
  const first = ts[0]!;
  const last = ts[ts.length - 1]!;
  if (t < first || t > last) return null;
  if (t === first) return xs[0]!;
  if (t === last) return xs[xs.length - 1]!;
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (ts[m]! <= t) lo = m;
    else hi = m;
  }
  const t0 = ts[lo]!;
  const t1 = ts[hi]!;
  if (t1 === t0) return xs[lo]!;
  const f = (t - t0) / (t1 - t0);
  return xs[lo]! + f * (xs[hi]! - xs[lo]!);
}

/** **v1 口径（诊断保留）**：曲线渲染 x（user units）→ ts 反解（假设曲线按 ts 线性绘制）。 */
function tsAtUserX(x: number, domain: [number, number]): number {
  const dSpan = domain[1] - domain[0];
  return domain[0] + ((x - CURVE_PAD) / CURVE_PLOT_W) * dSpan;
}

/** 索引空间预测（主路映射）：bar 索引 j 在 N 根可见 bar 下的 user-unit x。 */
function predictIndexUserX(j: number, nBars: number): number {
  return CURVE_PAD + (j / Math.max(1, nBars - 1)) * CURVE_PLOT_W;
}

/** ts 线性预测（修复前口径 / 降级口径）：在 [ts0, ts1] 区间内按 ts 线性映射。 */
function predictTsLinearUserX(ts: number, ts0: number, ts1: number): number {
  const span = ts1 - ts0;
  return CURVE_PAD + (span === 0 ? 0 : ((ts - ts0) / span) * CURVE_PLOT_W);
}

function gapCensus(ts: number[], from: number, to: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i]!;
    if (t < from || t > to) continue;
    const key = String(t - ts[i - 1]!);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const finite = (v: number): boolean => Number.isFinite(v);
const round2 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const round1 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

/**
 * **主口径配对**：曲线渲染顶点（按数据点顺序）→ K 线可见 bar（ts 最近邻、容差内、单调一对一）。
 * 返回配对表 + 未配对/重复/超容差计数（禁「配不上就跳过」的静默）。
 */
function pairByNearestBar(klineTs: number[], dataTs: number[], tol: number) {
  const pairs: Array<{ i: number; j: number; ts: number; barTs: number; dTs: number }> = [];
  let j = 0;
  let prevJ = -1;
  let duplicate = 0;
  let outOfTol = 0;
  for (let i = 0; i < dataTs.length; i++) {
    const t = dataTs[i]!;
    while (j + 1 < klineTs.length && Math.abs(klineTs[j + 1]! - t) <= Math.abs(klineTs[j]! - t)) j += 1;
    if (j < prevJ) {
      // 数据点 ts 非升序 ⇒ 无法与渲染顺序对齐（不应发生）
      outOfTol += 1;
      continue;
    }
    if (Math.abs(klineTs[j]! - t) > tol) {
      outOfTol += 1;
      continue;
    }
    if (j === prevJ) duplicate += 1;
    pairs.push({ i, j, ts: t, barTs: klineTs[j]!, dTs: t - klineTs[j]! });
    prevJ = j;
  }
  return { pairs, duplicate, outOfTol };
}

// ─────────────────────────────────────────────── 页面动作 ───────────────────────────────────────────────

async function readWindowAttrs(page: Page): Promise<WindowAttrs> {
  return page.evaluate(() => {
    const pick = (id: string): Record<string, string> | null => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      return Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value]));
    };
    const charts: Record<string, string | null> = {};
    const modes: Record<string, string | null> = {};
    for (const id of ['wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart']) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      charts[id] = el?.getAttribute('data-x-domain') ?? null;
      modes[id] = el?.getAttribute('data-x-mode') ?? null;
    }
    const txt = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? (el.textContent ?? null) : null;
    };
    return {
      state: pick('wb-window-state'),
      probe: pick('wb-window-probe'),
      charts,
      modes,
      note: txt('wb-window-load-note'),
      capNote: txt('wb-window-cap'),
      clampNote: txt('wb-window-clamped'),
      degradedNote: txt('wb-axis-degraded'),
      unmatchedNote: txt('wb-curve-unmatched'),
      applying: document.querySelector('[data-testid="wb-window-applying"]') != null,
      sampling: { aggregate: txt('wb-aggregate-sampling'), slot: txt('wb-slot-sampling') },
    };
  });
}

/** `page.request` → {@link RunFetchPort}（只读；规格侧唯一取数面）。 */
function runPort(page: Page): RunFetchPort {
  return {
    listRuns: async () => {
      const resp = await page.request.get('/api/workbench/runs?limit=500');
      expect(resp.ok(), 'GET /api/workbench/runs').toBeTruthy();
      return (await resp.json()) as RunListItem[];
    },
    totalBars: async (id) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/bars?kind=per_bar&offset=0&limit=1`);
      expect(resp.ok(), `GET /bars per_bar ${id}`).toBeTruthy();
      const total = ((await resp.json()) as { total?: number }).total;
      expect(typeof total, `/bars per_bar ${id} 必须回 total`).toBe('number');
      return total!;
    },
    roundTrips: async (id) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/round-trips?limit=5000`);
      expect(resp.ok(), `GET /round-trips ${id}`).toBeTruthy();
      return ((await resp.json()) as { round_trips?: RunRoundTrip[] }).round_trips ?? [];
    },
    fills: async (id, rtSeq) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/round-trips/${rtSeq}/fills?limit=200`);
      expect(resp.ok(), `GET /fills ${id}#${rtSeq}`).toBeTruthy();
      return ((await resp.json()) as { fills?: RunFill[] }).fills ?? [];
    },
  };
}

/**
 * 解析目标 run（谓词 `m5`）+ **反硬编码护栏**（规格使用的 id 必须 == 现场重解析结果）。
 * 解析失败 ⇒ 抛错（显式红），禁静默换用别的 run / 禁跳过。
 */
async function resolveTargetRun(page: Page): Promise<ResolvedRun> {
  // 落盘缓存（未跟踪目录；命中仍校验）+ **护栏走现场解析（不走缓存）**
  const sourceKey = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
  const run = await resolveRun(runPort(page), 'm5', { sourceKey });
  const fresh = await resolveRun(runPort(page), 'm5', { cacheDir: null, sourceKey });
  assertResolvedByIdFresh(run.id, fresh, 'm5');
  RUN_ID = run.id;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, 'run_resolution.json'),
    JSON.stringify({ id: run.id, predicate: run.predicate, totalBars: run.totalBars, evidence: run.evidence }, null, 2),
    'utf8',
  );
  return run;
}

async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  // 历史列表**分页**（新 run 顶掉旧 run 的首屏位置；实测 93 个 run / 首屏 50）⇒ 翻页查找，
  // 否则「运行不在历史列表内」是对 DB 内容漂移的假红（2026-09-25 复验实测）。
  await expect(page.locator('[data-testid^="wb-run-select-"]').first()).toBeVisible();
  for (let i = 0; i < 30 && (await select.count()) === 0; i++) {
    const more = page.getByTestId('wb-runs-more');
    if ((await more.count()) > 0) {
      await more.scrollIntoViewIfNeeded().catch(() => {});
      await more.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  await expect(select, `运行 ${runId} 必须在历史列表内（已翻页查找）`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'kline');
  await page.waitForTimeout(2500);
}

/** 等窗口态 + 曲线定义域 + 取数标注 + 曲线渲染顶点数收敛（连续两次读值相同）。 */
async function waitWindowSettled(page: Page, expectPoints: number | null): Promise<string> {
  let prev = '';
  for (let i = 0; i < 70; i++) {
    const cur = await page.evaluate((want: number | null) => {
      const s = document.querySelector('[data-testid="wb-window-state"]');
      const d = document.querySelector('[data-testid="wb-aggregate-chart"]')?.getAttribute('data-x-domain') ?? '';
      const n = document.querySelector('[data-testid="wb-window-load-note"]')?.textContent ?? '';
      const busy = document.querySelector('[data-testid="wb-window-applying"]') != null;
      const poly = document.querySelector('[data-testid="wb-aggregate-chart"] svg polyline')?.getAttribute('points') ?? '';
      const pts = poly.trim() ? poly.trim().split(/\s+/).length : 0;
      return `${s?.getAttribute('data-source')}|${s?.getAttribute('data-rev')}|${s?.getAttribute('data-from-ts')}|${s?.getAttribute('data-to-ts')}|${d}|${n.includes('窗口已应用') ? 'applied' : n.includes('窗口加载中') ? 'loading' : 'na'}|${busy ? 'busy' : 'idle'}|pts=${pts}|want=${want ?? '-'}`;
    }, expectPoints);
    const stable = i > 2 && cur === prev && !cur.includes('busy') && !cur.includes('loading');
    const pts = Number(/pts=(\d+)/.exec(cur)?.[1] ?? '-1');
    if (stable && (expectPoints == null || pts === expectPoints)) return cur;
    prev = cur;
    await page.waitForTimeout(200);
  }
  return prev;
}

async function fetchCurve(
  page: Page,
  runId: string,
  fromTs: number | null,
  toTs: number | null,
): Promise<CurveApi> {
  const q = new URLSearchParams({ kind: 'per_bar', k: '2000' });
  if (fromTs != null && toTs != null) {
    q.set('from_ts', String(fromTs));
    q.set('to_ts', String(toTs));
  }
  const resp = await page.request.get(`/api/workbench/runs/${runId}/curve?${q.toString()}`);
  if (!resp.ok()) return { ok: false, status: resp.status(), ts: [], downsampled: null, originalBars: null };
  const j = (await resp.json()) as { points?: Array<{ ts: number }>; downsampled?: boolean; original_bars?: number };
  const ts = (j.points ?? []).map((p) => p.ts);
  return {
    ok: true,
    status: 200,
    ts,
    downsampled: j.downsampled ?? null,
    originalBars: j.original_bars ?? null,
  };
}

/** run 总根数（`/bars?kind=per_bar` 的 `total`；用于全览披露的 M 真值）。 */
async function fetchRunTotalBars(page: Page, runId: string): Promise<number | null> {
  const resp = await page.request.get(`/api/workbench/runs/${runId}/bars?kind=per_bar&offset=0&limit=1`);
  if (!resp.ok()) return null;
  const j = (await resp.json()) as { total?: number };
  return typeof j.total === 'number' ? j.total : null;
}

interface RoundTripRow {
  rt_seq: number;
  open_ts: number;
  close_ts: number;
  l2_count: number;
}

/** 选一个**落在 K 线已加载数据内**的 L2 目标（否则跳转落不到已加载 bar 上 ⇒ 窗口退化）。 */
async function pickLateRoundTrip(page: Page, datFirstTs: number, dataLastTs: number): Promise<RoundTripRow> {
  const resp = await page.request.get(`/api/workbench/runs/${RUN_ID}/round-trips?limit=5000`);
  expect(resp.ok(), '/round-trips').toBeTruthy();
  const rows = ((await resp.json()) as { round_trips?: RoundTripRow[] }).round_trips ?? [];
  const lo = datFirstTs + 7200;
  const hi = dataLastTs - 7200;
  const ok = rows.filter((r) => r.open_ts >= lo && r.open_ts <= hi && r.l2_count > 0);
  expect(ok.length, `必须有落在 K 线已加载区间 [${datFirstTs}, ${dataLastTs}] 内的 L2 回合`).toBeGreaterThan(0);
  return ok[ok.length - 1]!;
}

/** 把 K 线滚入视口并返回其**视口内**中心点（滚轮/拖拽必须打在 canvas 上才生效）。 */
async function klineViewportCenter(
  page: Page,
): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number } } | null> {
  const loc = page.locator('[data-testid="kline-chart"]').first();
  await loc.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const b = await loc.boundingBox();
  if (!b) return null;
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.min(Math.max(b.x + b.width / 2, 1), vp.width - 1);
  const y = Math.min(Math.max(b.y + b.height / 2, 1), vp.height - 1);
  return { x, y, box: b };
}

/** 真手势：水平拖拽 K 线画布（dx > 0 = 向右拖）。 */
async function dragKline(page: Page, dx: number): Promise<void> {
  const c = await klineViewportCenter(page);
  if (!c) return;
  const y = c.y;
  const x0 = c.x;
  const x1 = Math.min(Math.max(x0 + dx, 5), (page.viewportSize()?.width ?? 1280) - 5);
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x1, y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

/** 单次视口轻推（手势 / 引擎），返回前后可见索引区间与根数（Δto > 0 ⇒ 向「更新」方向移动）。 */
async function nudgeViewport(
  page: Page,
  method: 'drag' | 'wheelX' | 'engine',
  dir: 1 | -1,
  mag: number,
  engineIdx: number | null,
): Promise<{ before: Record<string, number>; after: Record<string, number>; deltaTo: number; deltaBars: number }> {
  const before = (await page.evaluate(probeVisibleCount)) as Record<string, number>;
  if (method === 'engine') {
    if (engineIdx != null) {
      await page.evaluate((idx: number) => {
        const w = window as unknown as {
          __wbCharts?: Array<{ getDataList?: () => unknown[]; scrollToDataIndex?: (i: number) => void }>;
        };
        for (const c of w.__wbCharts ?? []) {
          const len = (c.getDataList?.() ?? []).length;
          if (len > 0 && typeof c.scrollToDataIndex === 'function') {
            c.scrollToDataIndex(idx);
            return;
          }
        }
      }, engineIdx);
    }
  } else if (method === 'drag') {
    await dragKline(page, dir * mag);
  } else {
    const c = await klineViewportCenter(page);
    if (c) {
      await page.mouse.move(c.x, c.y);
      await page.mouse.wheel(dir * mag, 0);
    }
  }
  await page.waitForTimeout(method === 'engine' ? 700 : 450);
  const after = (await page.evaluate(probeVisibleCount)) as Record<string, number>;
  return {
    before,
    after,
    deltaTo: (after['to'] ?? -1) - (before['to'] ?? -1),
    deltaBars: (after['count'] ?? -1) - (before['count'] ?? -1),
  };
}

/** 平移能力矩阵：探测「拖拽 / 横向滚轮」两种手势在**两个方向**上是否真的移动视口（落盘披露）。 */
async function probePanGestures(page: Page): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const method of ['drag', 'wheelX'] as const) {
    const mag = method === 'drag' ? 120 : 200;
    const fwd = await nudgeViewport(page, method, 1, mag, null);
    const back = await nudgeViewport(page, method, -1, mag, null);
    out[method] = {
      mag,
      plus: { deltaTo: fwd.deltaTo, deltaBars: fwd.deltaBars, to: fwd.after['to'] ?? null },
      minus: { deltaTo: back.deltaTo, deltaBars: back.deltaBars, to: back.after['to'] ?? null },
      pans: fwd.deltaTo !== 0 || back.deltaTo !== 0,
      zooms: fwd.deltaBars !== 0 || back.deltaBars !== 0,
    };
  }
  return out;
}

/** 从能力矩阵挑「向更新方向（Δto > 0）」的可用推法；皆不可用 ⇒ engine（调用方须在报告中披露）。 */
function pickFwdMethod(pan: Record<string, unknown>): { method: 'drag' | 'wheelX' | 'engine'; sign: 1 | -1; mag: number } {
  for (const m of ['drag', 'wheelX'] as const) {
    const e = pan[m] as { mag: number; plus: { deltaTo: number }; minus: { deltaTo: number } } | undefined;
    if (!e) continue;
    if (e.plus.deltaTo > 0) return { method: m, sign: 1, mag: e.mag * 2 };
    if (e.minus.deltaTo > 0) return { method: m, sign: -1, mag: e.mag * 2 };
  }
  return { method: 'engine', sign: 1, mag: 0 };
}

/**
 * 把 K 线可见区间右端推到**最新 bar**（「跟随最新」语义）。
 * 优先真手势（能力矩阵探测到的可用推法）；手势不可用 ⇒ 引擎 `scrollToDataIndex`（**在报告中披露**，
 * 等价于产品自身的程序化写窗路径；仅换输入设备，窗口发布路径同源）。
 */
async function moveToLatest(page: Page, pan: Record<string, unknown>): Promise<Record<string, unknown>> {
  const before = await page.evaluate(probeVisibleCount);
  if ((before as { len: number }).len > 0 && (before as { to: number }).to >= (before as { len: number }).len - 1) {
    return { reachedLatest: true, method: 'already-at-latest', before };
  }
  const pick = pickFwdMethod(pan);
  let method = pick.method;
  let steps = 0;
  if (method !== 'engine') {
    for (; steps < 30; steps++) {
      const cur = (await page.evaluate(probeVisibleCount)) as { to: number; len: number };
      if (cur.len > 0 && cur.to >= cur.len - 1) break;
      const r = await nudgeViewport(page, method, pick.sign, pick.mag, null);
      if (r.deltaTo === 0) {
        method = 'engine';
        break;
      }
    }
  }
  if (method === 'engine') {
    const cur = (await page.evaluate(probeVisibleCount)) as { len: number };
    await nudgeViewport(page, 'engine', 1, 0, Math.max(0, (cur.len ?? 1) - 1));
    steps += 1;
  }
  await page.waitForTimeout(700);
  const after = (await page.evaluate(probeVisibleCount)) as { to: number; len: number };
  return {
    reachedLatest: after.len > 0 && after.to >= after.len - 1,
    method,
    steps,
    pick,
    before,
    after,
  };
}

/**
 * 把 K 线可见区间**左滚若干根**（「左滚」语义 = 看到更早的 bar）。
 * 优先真手势（沿「更新方向」的反方向）；手势不可用/未移动 ⇒ 引擎视口回退（**披露**）。
 */
async function moveEarlierBars(
  page: Page,
  pan: Record<string, unknown>,
  wantBars: number,
): Promise<Record<string, unknown>> {
  const before = (await page.evaluate(probeVisibleCount)) as { to: number; from?: number; count: number };
  const pick = pickFwdMethod(pan);
  let method = pick.method;
  let r: { deltaTo: number } | null = null;
  if (method !== 'engine') {
    r = await nudgeViewport(page, method, (pick.sign * -1) as 1 | -1, pick.mag, null);
    if (r.deltaTo === 0) method = 'engine';
  }
  if (method === 'engine') {
    await nudgeViewport(page, 'engine', -1, 0, Math.max(0, before.to - wantBars));
  }
  await page.waitForTimeout(700);
  const after = (await page.evaluate(probeVisibleCount)) as { to: number; count: number };
  return {
    method,
    pick,
    before,
    after,
    movedBars: before.to - after.to,
    deltaTo: after.to - before.to,
  };
}

/** 真手势：滚轮缩小到 ≥ 目标可见根数。 */
async function zoomOutTo(page: Page, target: number): Promise<{ steps: number; zoomEffective: boolean }> {
  const c = await klineViewportCenter(page);
  let steps = 0;
  let zoomEffective = false;
  let before = (await page.evaluate(probeVisibleCount)).count;
  for (; steps < 60; steps++) {
    if (!c) break;
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(110);
    const cur = (await page.evaluate(probeVisibleCount)).count;
    if (cur !== before) zoomEffective = true;
    before = cur;
    if (cur >= target) break;
  }
  await page.waitForTimeout(900);
  return { steps, zoomEffective };
}

/** 真手势：滚轮放大到 ≤ 目标可见根数（无缺口对照态用）。 */
async function zoomInTo(page: Page, target: number): Promise<{ steps: number; zoomEffective: boolean }> {
  const c = await klineViewportCenter(page);
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.min(Math.max((c?.box.x ?? 0) + (c?.box.width ?? 600) * 0.9, 1), vp.width - 1);
  const y = c?.y ?? vp.height / 2;
  let steps = 0;
  let zoomEffective = false;
  let before = (await page.evaluate(probeVisibleCount)).count;
  for (; steps < 60; steps++) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(110);
    const cur = (await page.evaluate(probeVisibleCount)).count;
    if (cur !== before) zoomEffective = true;
    before = cur;
    if (cur <= target) break;
  }
  await page.waitForTimeout(900);
  return { steps, zoomEffective };
}

// ──────────────────────────────────────────── 测量与判据计算 ────────────────────────────────────────────

async function measureState(
  page: Page,
  label: string,
  opts: { totalBars: number | null },
): Promise<StateMeasure> {
  const attrs = await readWindowAttrs(page);
  const source = attrs.state?.['data-source'] ?? '';
  const domainAttr = attrs.charts['wb-aggregate-chart'] ?? null;
  const domain =
    domainAttr && domainAttr !== 'data' && domainAttr.includes(',')
      ? (domainAttr.split(',').map(Number) as [number, number])
      : null;
  // D10-2/D10-4：`reset` 态窗口 = 真身可达区间（取数窗口 == 可见域）⇒ 与其它窗口态同口径取数
  const windowed = source !== 'full' && domain != null;
  const api = await fetchCurve(page, RUN_ID, windowed ? domain![0] : null, windowed ? domain![1] : null);
  const kline = await page.evaluate(probeKline);
  const curve = (await page.evaluate(probeCurve, 'wb-aggregate-chart')) as CurveGeom;
  const slot = (await page.evaluate(probeCurve, 'wb-slot-chart')) as CurveGeom;

  const notes: string[] = [];
  const agg = curve.polys?.[0];
  const slotPoly = slot.polys?.[0];
  const vertexMatch = { aggregate: agg != null ? agg.n === api.ts.length : null, slot: slotPoly != null ? slotPoly.n === api.ts.length : null };
  if (!kline.ok) notes.push(`K 线真身不可读：${kline.error}`);
  if (!curve.present) notes.push('聚合图未渲染（wb-aggregate-chart 缺失）');
  if (curve.present && curve.ctmAvailable === false) notes.push('SVG getScreenCTM() 不可用 ⇒ 屏幕像素退化为 user units');

  const userX = agg?.userX ?? [];
  const screenX = agg?.screenX ?? [];
  const vertices = userX.length;
  const visibleBars = kline.ok ? kline.visibleCount : 0;

  // ── 主口径：同一根 bar 配对 ──
  // 渲染顶点 ↔ 数据点一一对应（曲线按数据点顺序映射；容差外/无槽位者按设计不绘）。
  // 配对只依赖「ts 最近邻」，不假设曲线的映射方式；映射身份另由 `mapping` 字段自校验。
  const dataTsInRange = kline.ok && kline.ts.length >= 2
    ? api.ts.filter((t) => t >= kline.ts[0]! - PAIR_TOL_SEC && t <= kline.ts[kline.ts.length - 1]! + PAIR_TOL_SEC)
    : api.ts;
  const alignmentExact = dataTsInRange.length === vertices;
  if (!alignmentExact) {
    notes.push(
      `顶点数 ${vertices} ≠ 可见范围内曲线数据点数 ${dataTsInRange.length}（全览态按设计只绘「K 线 bar 序列内」的点）⇒ 配对按「容差内最近邻 + 单调一对一」进行`,
    );
  }
  const pairing = kline.ok
    ? pairByNearestBar(kline.ts, dataTsInRange, PAIR_TOL_SEC)
    : { pairs: [], duplicate: 0, outOfTol: 0 };
  const pairRows: PairRow[] = [];
  const ts0 = kline.ok && kline.ts.length >= 2 ? kline.ts[0]! : 0;
  const tsN = kline.ok && kline.ts.length >= 2 ? kline.ts[kline.ts.length - 1]! : 0;
  for (const p of pairing.pairs) {
    const xK = kline.xAbs[p.j]!;
    const xC = screenX[p.i];
    const ux = userX[p.i];
    if (xC == null || !finite(xC) || !finite(xK) || ux == null || !finite(ux)) continue;
    pairRows.push({
      i: p.i,
      j: p.j,
      ts: p.ts,
      barTs: p.barTs,
      dTs: p.dTs,
      xK,
      xC,
      dRaw: xK - xC,
      d984: Number.NaN,
      userX: ux,
      predIndexUserX: predictIndexUserX(p.j, visibleBars),
      predTsLinearUserX: predictTsLinearUserX(p.ts, ts0, tsN),
    });
  }
  const pairN = pairRows.length;
  const kA = pairN > 0 ? kline.xAbs[pairRows[0]!.j]! : Number.NaN;
  const kB = pairN > 0 ? kline.xAbs[pairRows[pairN - 1]!.j]! : Number.NaN;
  const cA = pairN > 0 ? screenX[pairRows[0]!.i]! : Number.NaN;
  const cB = pairN > 0 ? screenX[pairRows[pairN - 1]!.i]! : Number.NaN;
  const spanK = pairN > 1 ? kB - kA : Number.NaN;
  const spanC = pairN > 1 ? cB - cA : Number.NaN;
  let maxAbsRaw: number | null = null;
  let maxAbsRawTs: number | null = null;
  let maxAbs984: number | null = null;
  let maxAbs984Ts: number | null = null;
  if (pairN > 1 && finite(spanK) && spanK !== 0 && finite(spanC) && spanC !== 0) {
    for (const r of pairRows) {
      r.d984 = ((r.xK - kA) / spanK - (r.xC - cA) / spanC) * CURVE_PLOT_W;
      if (maxAbsRaw == null || Math.abs(r.dRaw) > maxAbsRaw) {
        maxAbsRaw = Math.abs(r.dRaw);
        maxAbsRawTs = r.ts;
      }
      if (maxAbs984 == null || Math.abs(r.d984) > maxAbs984) {
        maxAbs984 = Math.abs(r.d984);
        maxAbs984Ts = r.ts;
      }
    }
  } else if (pairN > 1) {
    notes.push(`配对锚点跨度不可用（spanK=${spanK} spanC=${spanC}）⇒ 主口径 Δ984 不可算`);
  }
  const barsCovered = new Set(pairRows.map((r) => r.j)).size;
  const pairOk =
    pairN > 0 &&
    vertices === pairN &&
    maxAbsRaw != null &&
    maxAbs984 != null &&
    maxAbsRaw <= ALIGN_TOL_PX &&
    maxAbs984 <= ALIGN_TOL_PX;

  // ── 跟随性 ──
  const firstRow = pairRows[0] ?? null;
  const lastRow = pairRows[pairN - 1] ?? null;
  const coverageRatio = agg?.firstUserX != null && agg.lastUserX != null
    ? Math.round(((agg.lastUserX - agg.firstUserX) / CURVE_PLOT_W) * 10000) / 10000
    : null;
  const headDeficitPx984 = agg?.firstUserX != null ? round2(agg.firstUserX - CURVE_PAD) : null;
  const tailDeficitPx984 = agg?.lastUserX != null ? round2(CURVE_W - CURVE_PAD - agg.lastUserX) : null;
  const followOk =
    pairN > 0 &&
    firstRow != null &&
    lastRow != null &&
    firstRow.j === 0 &&
    lastRow.j === visibleBars - 1 &&
    barsCovered === visibleBars &&
    vertices === visibleBars &&
    coverageRatio === 1 &&
    Math.abs(firstRow.dRaw) <= ALIGN_TOL_PX &&
    Math.abs(lastRow.dRaw) <= ALIGN_TOL_PX &&
    spanK != null &&
    spanC != null &&
    Math.abs(spanC - spanK) <= ALIGN_TOL_PX;

  // ── 数据/域原子性 ──
  const dataFirst = api.ts[0] ?? null;
  const dataLast = api.ts[api.ts.length - 1] ?? null;
  const dataTsRange: [number, number] | null = dataFirst != null && dataLast != null ? [dataFirst, dataLast] : null;
  const renderedTsRange: [number, number] | null =
    pairN > 0 ? [pairRows[0]!.ts, pairRows[pairN - 1]!.ts] : null;
  const klineVisRange: [number, number] | null =
    kline.ok && kline.ts.length >= 2 ? [kline.ts[0]!, kline.ts[kline.ts.length - 1]!] : null;
  const atomicNotes: string[] = [];
  // ① 渲染数据必须落在**声明定义域**内（禁「新数据 + 旧域」）
  const dataInDomain =
    renderedTsRange && domain
      ? renderedTsRange[0] >= domain[0] - PAIR_TOL_SEC && renderedTsRange[1] <= domain[1] + PAIR_TOL_SEC
      : null;
  if (dataInDomain === false) atomicNotes.push('渲染曲线数据不在声明定义域内（新数据 + 旧域 嫌疑）');
  // ② 渲染数据必须落在 **K 线可见 bar 区间**内（禁「旧数据 + 新域」：曲线画的是别的时间段）
  const dataInKlineVisible =
    renderedTsRange && klineVisRange
      ? renderedTsRange[0] >= klineVisRange[0] - PAIR_TOL_SEC && renderedTsRange[1] <= klineVisRange[1] + PAIR_TOL_SEC
      : null;
  if (dataInKlineVisible === false) {
    atomicNotes.push(
      `渲染曲线数据区间 [${renderedTsRange?.[0]}, ${renderedTsRange?.[1]}] 不在 K 线可见区间 [${klineVisRange?.[0]}, ${klineVisRange?.[1]}] 内（旧数据 + 新域 / 两图区间不相交）`,
    );
  }
  if (coverageRatio != null && coverageRatio < 1) {
    atomicNotes.push(`曲线 plot 覆盖率 ${coverageRatio} < 1.000（修复前全览态为 0.0253 ⇒ 契约要求 1.000）`);
  }
  const atomicOk =
    pairN > 0 && dataInDomain !== false && dataInKlineVisible !== false && coverageRatio === 1 && barsCovered === visibleBars;

  // ── 映射身份（自校验配对 + 映射可判别性） ──
  let indexResidualMaxUser: number | null = null;
  let tsLinearResidualMaxUser: number | null = null;
  for (const r of pairRows) {
    const d1 = Math.abs(r.userX - r.predIndexUserX);
    const d2 = Math.abs(r.userX - r.predTsLinearUserX);
    indexResidualMaxUser = indexResidualMaxUser == null ? d1 : Math.max(indexResidualMaxUser, d1);
    tsLinearResidualMaxUser = tsLinearResidualMaxUser == null ? d2 : Math.max(tsLinearResidualMaxUser, d2);
  }
  const mode = curve.mode;
  const mappingVerdict =
    mode === 'index'
      ? indexResidualMaxUser != null && indexResidualMaxUser <= 1
        ? 'index 映射与渲染自洽（配对可信）'
        : 'index 声明与渲染不自洽（渲染不是索引线性）'
      : `声明映射 = ${String(mode)}（非主路）`;

  // ── 披露 ──
  const capText = attrs.capNote;
  const capM = capText ? /显示\s*([\d,]+)\s*\/\s*共\s*([\d,]+)\s*根/.exec(capText) : null;
  const capVisible = capM ? Number(capM[1]!.replace(/,/g, '')) : null;
  const capTotal = capM ? Number(capM[2]!.replace(/,/g, '')) : null;
  const capMatchesTruth =
    capVisible == null || capTotal == null
      ? null
      : capVisible === visibleBars && (opts.totalBars == null || capTotal === opts.totalBars);
  if (source === 'full') {
    if (capText == null) notes.push('全览态缺少 wb-window-cap 披露文案（物理上限未披露）');
    else if (capMatchesTruth === false) {
      notes.push(
        `全览披露数值与真身不符：文案 N=${capVisible}/M=${capTotal} vs 真身可见 ${visibleBars}/run 总 ${opts.totalBars}`,
      );
    }
  }
  const unM = attrs.unmatchedNote ? /(\d+)\s*点不在\s*K 线 bar 序列上/.exec(attrs.unmatchedNote) : null;
  const unmatchedCount = unM ? Number(unM[1]) : null;
  const unmatchedMatchesTruth =
    unmatchedCount == null ? null : unmatchedCount === Math.max(0, api.ts.length - vertices);
  const discloseOk =
    mode === 'index' &&
    (source !== 'full' || (capText != null && capMatchesTruth !== false)) &&
    (attrs.degradedNote == null || attrs.degradedNote.length > 0);

  // ── 诊断（v1 口径；仅适用于修复前 ts 线性映射） ──
  const legacyTsInv: number[] = [];
  const legacyXScr: number[] = [];
  if (domain) {
    for (let i = 0; i < userX.length; i++) {
      const sx = screenX[i];
      if (sx == null || !finite(sx)) continue;
      legacyTsInv.push(tsAtUserX(userX[i]!, domain));
      legacyXScr.push(sx);
    }
  }
  const curveDataTsRange: [number, number] | null =
    legacyTsInv.length >= 2 ? [legacyTsInv[0]!, legacyTsInv[legacyTsInv.length - 1]!] : null;
  let overlap: [number, number] | null = null;
  let overlapBars = 0;
  if (klineVisRange && curveDataTsRange) {
    const lo = Math.max(klineVisRange[0], curveDataTsRange[0]);
    const hi = Math.min(klineVisRange[1], curveDataTsRange[1]);
    if (hi > lo) {
      overlap = [lo, hi];
      overlapBars = kline.ts.filter((t) => t >= lo && t <= hi).length;
    }
  }
  let legacyInverse984: number | null = null;
  let legacyModel984: number | null = null;
  if (overlap && kline.ts.length >= 2 && legacyTsInv.length >= 2) {
    const [aFrom, aTo] = overlap;
    const xKa = lerpStrict(kline.ts, kline.xAbs, aFrom);
    const xKb = lerpStrict(kline.ts, kline.xAbs, aTo);
    const xCa = lerpStrict(legacyTsInv, legacyXScr, aFrom);
    const xCb = lerpStrict(legacyTsInv, legacyXScr, aTo);
    if (xKa != null && xKb != null && xCa != null && xCb != null && xKb !== xKa && xCb !== xCa) {
      const kSpan = xKb - xKa;
      const cSpan = xCb - xCa;
      let m = 0;
      for (let i = 0; i < legacyTsInv.length; i++) {
        const t = legacyTsInv[i]!;
        if (t < aFrom || t > aTo) continue;
        const xC = legacyXScr[i]!;
        const xK = lerpStrict(kline.ts, kline.xAbs, t);
        if (xK == null) continue;
        m = Math.max(m, Math.abs(((xK - xKa) / kSpan - (xC - xCa) / cSpan) * CURVE_PLOT_W));
      }
      legacyInverse984 = round2(m);
    }
    // 缺口折叠模型（纯数值：索引线性 vs ts 线性），在共同覆盖区间上算
    const inOverlap = kline.ts.map((t) => t).filter((t) => t >= aFrom && t <= aTo);
    let mm = 0;
    for (let i = 0; i < inOverlap.length; i++) {
      const t = inOverlap[i]!;
      const pT = aTo === aFrom ? 0 : (t - aFrom) / (aTo - aFrom);
      const pI = inOverlap.length <= 1 ? 0 : i / (inOverlap.length - 1);
      mm = Math.max(mm, Math.abs((pI - pT) * CURVE_PLOT_W));
    }
    legacyModel984 = round2(mm);
  }
  let legacyFullModel984: number | null = null;
  if (domain && api.ts.length >= 2) {
    const tsList = api.ts.filter((t) => t >= domain[0] && t <= domain[1]);
    let m = 0;
    for (let i = 0; i < tsList.length; i++) {
      const pT = (tsList[i]! - domain[0]) / Math.max(1, domain[1] - domain[0]);
      const pI = tsList.length <= 1 ? 0 : i / (tsList.length - 1);
      m = Math.max(m, Math.abs((pI - pT) * CURVE_PLOT_W));
    }
    legacyFullModel984 = tsList.length >= 2 ? round2(m) : null;
  }

  const censusRef = klineVisRange;
  return {
    label,
    kline,
    curve,
    slot,
    attrs,
    domainAttr,
    domain,
    api: {
      ok: api.ok,
      status: api.status,
      pointCount: api.ts.length,
      downsampled: api.downsampled,
      originalBars: api.originalBars,
      firstTs: dataFirst,
      lastTs: dataLast,
    },
    pair: {
      n: pairN,
      vertices,
      visibleBars,
      barsCovered,
      unpairedVertices: vertices - pairN,
      duplicateBars: pairing.duplicate,
      outOfTolerance: pairing.outOfTol,
      maxAbsRaw: maxAbsRaw == null ? null : round2(maxAbsRaw),
      maxAbsRawTs,
      maxAbs984: maxAbs984 == null ? null : round2(maxAbs984),
      maxAbs984Ts,
      spanK: finite(spanK) ? round2(spanK) : null,
      spanC: finite(spanC) ? round2(spanC) : null,
      first: firstRow ? { ...firstRow, dRaw: round2(firstRow.dRaw), d984: round2(firstRow.d984) } : null,
      last: lastRow ? { ...lastRow, dRaw: round2(lastRow.dRaw), d984: round2(lastRow.d984) } : null,
      ok: pairOk,
    },
    follow: {
      firstPairRaw: firstRow ? round2(firstRow.dRaw) : null,
      firstPair984: firstRow ? round2(firstRow.d984) : null,
      lastPairRaw: lastRow ? round2(lastRow.dRaw) : null,
      lastPair984: lastRow ? round2(lastRow.d984) : null,
      firstPairedBarIdx: firstRow?.j ?? null,
      lastPairedBarIdx: lastRow?.j ?? null,
      headUncoveredBars: firstRow ? firstRow.j : null,
      tailUncoveredBars: lastRow ? visibleBars - 1 - lastRow.j : null,
      spanDiffPx: finite(spanC) && finite(spanK) ? round2(Math.abs(spanC - spanK)) : null,
      coverageRatio,
      headDeficitPx984,
      tailDeficitPx984,
      ok: followOk,
    },
    atomic: {
      dataTsRange,
      dataInDomain,
      dataInKlineVisible,
      coverageRatio,
      ok: atomicOk,
      notes: atomicNotes,
    },
    mapping: {
      indexResidualMaxUser: indexResidualMaxUser == null ? null : round2(indexResidualMaxUser),
      tsLinearResidualMaxUser: tsLinearResidualMaxUser == null ? null : round2(tsLinearResidualMaxUser),
      tsLinearResidualMaxPx984: tsLinearResidualMaxUser == null ? null : round2(tsLinearResidualMaxUser),
      verdict: mappingVerdict,
    },
    disclose: {
      capText,
      capVisible,
      capTotal,
      capMatchesTruth,
      clampText: attrs.clampNote,
      degradedText: attrs.degradedNote,
      unmatchedText: attrs.unmatchedNote,
      unmatchedCount,
      unmatchedMatchesTruth,
      xMode: curve.mode,
      xModeAll: attrs.modes,
      ok: discloseOk,
    },
    legacy: {
      applicableTo: '仅适用于修复前口径（曲线按 ts 线性绘制）——主口径已改为同一根 bar 配对',
      curveDataTsRange,
      overlap,
      overlapBars,
      tsLinearInverseSolve984: legacyInverse984,
      indexVsTsModel984: legacyModel984,
      fullDomainModel984: legacyFullModel984,
      vertexMatch: vertexMatch.aggregate,
    },
    curveCoverage: {
      firstUserX: agg?.firstUserX ?? null,
      lastUserX: agg?.lastUserX ?? null,
      coverageRatio,
    },
    windowLevel: {
      klineVisible: klineVisRange,
      domain,
      coverage:
        domain && klineVisRange ? (klineVisRange[1] - klineVisRange[0]) / Math.max(1, domain[1] - domain[0]) : null,
    },
    gapCensus: kline.ok && censusRef ? gapCensus(kline.ts, censusRef[0], censusRef[1]) : {},
    spacingDistinct: kline.ok ? kline.spacingDistinct : [],
    pairSeries: pairRows.map((r) => ({
      ts: r.ts,
      barTs: r.barTs,
      barIdx: r.j,
      dTs: r.dTs,
      gapBeforeSec: null,
      xK: round2(r.xK),
      xC: round2(r.xC),
      dRaw: round2(r.dRaw),
      d984: round2(r.d984),
      renderUserX: round2(r.userX),
      predIndexUserX: round2(r.predIndexUserX),
      predTsLinearUserX: round2(r.predTsLinearUserX),
    })),
    notes,
  };
}

async function shoot(page: Page, label: string): Promise<string[]> {
  mkdirSync(OUT, { recursive: true });
  const files: string[] = [];
  await page.screenshot({ path: resolve(OUT, `state_${label}.png`) });
  files.push(`state_${label}.png`);
  for (const [name, sel] of [
    ['kline', '[data-testid="wb-kline-chart"]'],
    ['aggregate', '[data-testid="wb-aggregate-chart"]'],
    ['slot', '[data-testid="wb-slot-chart"]'],
  ] as Array<[string, string]>) {
    try {
      await page.locator(sel).first().screenshot({ path: resolve(OUT, `state_${label}_${name}.png`), timeout: 10_000 });
      files.push(`state_${label}_${name}.png`);
    } catch (e) {
      files.push(`${name}:FAILED(${(e as Error).message.split('\n')[0]})`);
    }
  }
  return files;
}

/** 逐点 Δ 序列落盘（配对口径；供报告画「偏差随 ts 变化」并定位缺口）。 */
function deltaSeries(st: StateMeasure): Array<Record<string, number | null>> {
  return st.pairSeries;
}

// ─────────────────────────────────────────────────── 用例 ───────────────────────────────────────────────────

test.describe.configure({ mode: 'serial', timeout: 180_000 }); // timeout：§7.2 修法 ①（谓词解析不得吃穿默认 60s 预算）

test('P1_pair_alignment：同一根 bar 配对偏差（六态）+ 跟随性 + 原子性 + 披露', async ({ page }) => {
  test.setTimeout(420_000);
  await page.addInitScript(installChartCapture);
  mkdirSync(OUT, { recursive: true });

  const env = {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081',
    runId: RUN_ID,
    barSeconds: BAR_SECONDS,
    pairToleranceSec: PAIR_TOL_SEC,
    curveMapping: { W: CURVE_W, PAD: CURVE_PAD, PLOT_W: CURVE_PLOT_W },
    alignTolPx: ALIGN_TOL_PX,
    viewport: page.viewportSize(),
    startedAt: new Date().toISOString(),
    metricVersion: 'v2: same-bar pairing (main) + ts-linear inverse-solve (legacy diagnostic only)',
  };

  const target = await resolveTargetRun(page);
  await openRunSettled(page, target.id);
  const totalBars = await fetchRunTotalBars(page, target.id);

  const states: StateMeasure[] = [];
  const transitions: Record<string, unknown> = {};
  const record = async (st: StateMeasure) => {
    const s = await shoot(page, st.label);
    st.screenshots = s;
    writeJson(`state_${st.label}`, { ...st, screenshots: s });
    writeJson(`delta_series_${st.label}`, deltaSeries(st));
    states.push(st);
    return st;
  };

  // 采样器包装：切换期间逐帧记录（原子性）
  const sampleDuring = async (name: string, action: () => Promise<void>, settleMs = 2600) => {
    const prevAttrs = await readWindowAttrs(page);
    const prevSnap = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="wb-aggregate-chart"]');
      const svg = host?.querySelector('svg') ?? null;
      const nums = (host?.querySelector('polyline')?.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => Number(t.split(',')[0]))
        .filter((v) => Number.isFinite(v));
      return {
        vertices: nums.length,
        sig:
          nums.length === 0
            ? 'empty'
            : `${host?.getAttribute('data-x-mode') ?? '?'}|${nums.length}|${nums[0]!.toFixed(2)}|${nums[nums.length - 1]!.toFixed(2)}|${nums.reduce((a, b) => a + b, 0).toFixed(2)}|${svg?.getAttribute('viewBox') ?? ''}`,
      };
    });
    await page.evaluate(startSampler);
    await action();
    await page.waitForTimeout(settleMs);
    const samples = (await page.evaluate(stopSampler)) as Array<Record<string, unknown>>;
    await waitWindowSettled(page, null);
    const finalAttrs = await readWindowAttrs(page);
    const finalSnap = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="wb-aggregate-chart"]');
      const svg = host?.querySelector('svg') ?? null;
      const nums = (host?.querySelector('polyline')?.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => Number(t.split(',')[0]))
        .filter((v) => Number.isFinite(v));
      return {
        vertices: nums.length,
        sig:
          nums.length === 0
            ? 'empty'
            : `${host?.getAttribute('data-x-mode') ?? '?'}|${nums.length}|${nums[0]!.toFixed(2)}|${nums[nums.length - 1]!.toFixed(2)}|${nums.reduce((a, b) => a + b, 0).toFixed(2)}|${svg?.getAttribute('viewBox') ?? ''}`,
      };
    });
    // 分类：
    //  - in-flight（applying / 加载中 / 跳转中）⇒ 渲染签名必须恰为「切换前」或「切换后」整组快照之一
    //  - settled（非加载态）⇒ 若窗口态已到**新窗口**，渲染签名必须是**新快照**（旧数据静默残留 = 红）
    const finalWinKey = `${finalAttrs.state?.['data-source']}|${finalAttrs.state?.['data-rev']}|${finalAttrs.state?.['data-from-ts']}|${finalAttrs.state?.['data-to-ts']}`;
    const prevWinKey = `${prevAttrs.state?.['data-source']}|${prevAttrs.state?.['data-rev']}|${prevAttrs.state?.['data-from-ts']}|${prevAttrs.state?.['data-to-ts']}`;
    const inflightMixed: Array<Record<string, unknown>> = [];
    const settledStale: Array<Record<string, unknown>> = [];
    let settledCount = 0;
    let inflightCount = 0;
    let blankDuringLoad = 0;
    for (const s of samples) {
      const sig = String(s['sig']);
      const load = String(s['loadNote'] ?? '');
      const inFlight = s['applying'] === true || load.includes('加载中') || load.includes('跳转中');
      const winKey = `${s['source']}|${s['rev']}|${s['fromTs']}|${s['toTs']}`;
      if (inFlight) {
        inflightCount += 1;
        if (sig !== 'empty' && sig !== finalSnap.sig && sig !== prevSnap.sig) inflightMixed.push(s);
        if (sig === 'empty') blankDuringLoad += 1;
      } else if (winKey === finalWinKey && winKey !== prevWinKey) {
        settledCount += 1;
        if (sig !== finalSnap.sig && sig !== 'empty') settledStale.push(s);
      }
    }
    // 「静默残留」需连续 ≥2 帧（120ms）才判红，避免 React 两次状态更新之间的单帧竞态误报
    const consecutiveStale = settledStale.length >= 2;
    transitions[name] = {
      prevWindowKey: prevWinKey,
      finalWindowKey: finalWinKey,
      prevSig: prevSnap.sig,
      finalSig: finalSnap.sig,
      samples: samples.length,
      inflightCount,
      settledCount,
      blankDuringLoad,
      inflightMixed,
      settledStaleCount: settledStale.length,
      settledStaleSamples: settledStale.slice(0, 6),
      verdict: {
        atomicInFlight: inflightMixed.length === 0,
        noSilentStale: !consecutiveStale,
        ok: inflightMixed.length === 0 && !consecutiveStale,
      },
      rawSamples: samples,
    };
    return transitions[name] as { verdict?: { ok?: boolean } };
  };

  // ───────────── ① 初始（默认 kline 窗口） ─────────────
  const init = await record(await measureState(page, 'init', { totalBars }));
  writeJson('env', {
    ...env,
    totalBars,
    klineDataList: { len: init.kline.dataLen, firstTs: init.kline.dataFirstTs, lastTs: init.kline.dataLastTs },
  });

  // ───────────── ④ 全览（含切换采样：原子性 + 披露） ─────────────
  const fullTrans = await sampleDuring('full', async () => {
    await page.getByTestId('wb-window-reset').click();
    // ADR-028 §2.10 D10 决策 2：全览以实测可达区间写回窗口状态机（source=reset）
    await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'reset');
  });
  const full = await record(await measureState(page, 'full', { totalBars }));

  // ───────────── 平移能力矩阵（探针手段；落盘披露） ─────────────
  const panProbe = await probePanGestures(page);
  writeJson('pan_gesture_probe', panProbe);

  // ───────────── ② 跟随最新（从全览态把 K 线推到最新 bar） ─────────────
  const followGesture = await moveToLatest(page, panProbe);
  await waitWindowSettled(page, null);
  const follow = await measureState(page, 'follow', { totalBars });
  follow.gesture = followGesture;
  await record(follow);

  // ───────────── ③ 左滚若干根（沿「更新方向」的反向；手势不可用 ⇒ 引擎视口回退并披露） ─────────────
  const leftShift = await moveEarlierBars(page, panProbe, 30);
  await waitWindowSettled(page, null);
  const leftscroll = await measureState(page, 'leftscroll', { totalBars });
  leftscroll.gesture = leftShift;
  await record(leftscroll);

  // ───────────── ⑤ 120 根跳转（L2；含切换采样） ─────────────
  const rt = await pickLateRoundTrip(page, init.kline.dataFirstTs!, init.kline.dataLastTs!);
  const jumpTrans = await sampleDuring('jump120', async () => {
    await page.getByTestId(`wb-rt-detail-${rt.rt_seq}`).click();
    const row = page.getByTestId(`wb-l2-row-${rt.rt_seq}-0`);
    await expect(row).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await page.getByTestId(`wb-l2-jump-${rt.rt_seq}-0`).click();
    await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
    await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-ok', 'true');
  });
  const jump120 = await record(await measureState(page, 'jump120', { totalBars }));
  (jump120 as unknown as { jumpTarget?: unknown }).jumpTarget = rt;

  // ───────────── ⑥ 滚轮缩小到 ~300 根（真手势） ─────────────
  const zoom = await zoomOutTo(page, ZOOM_TARGET_BARS);
  await waitWindowSettled(page, null);
  const zoom300 = await measureState(page, 'zoom300', { totalBars });
  zoom300.zoom = { steps: zoom.steps, zoomEffective: zoom.zoomEffective, targetBars: ZOOM_TARGET_BARS };
  await record(zoom300);

  // ───────────── ⑦ 补充态：滚轮放大到 ≤40 根（贴近收盘 ⇒ 无午休/隔夜缺口对照） ─────────────
  const zoomin = await zoomInTo(page, ZOOM_IN_TARGET_BARS);
  await waitWindowSettled(page, null);
  const controlGapless = await measureState(page, 'controlGapless', { totalBars });
  controlGapless.zoom = { steps: zoomin.steps, zoomEffective: zoomin.zoomEffective, targetBars: ZOOM_IN_TARGET_BARS };
  await record(controlGapless);

  writeJson('transitions', transitions);

  // ───────────── 测量有效性（恒真反证） ─────────────
  for (const st of states) {
    expect(st.kline.ok, `${st.label}：K 线真身必须可读；notes=${JSON.stringify(st.notes)}`).toBe(true);
    const bs = st.kline.barSpace ?? Number.NaN;
    const dirty = st.spacingDistinct.filter((d) => Math.abs(d - bs) > 1.001);
    expect(
      dirty,
      `${st.label}：K 线相邻 bar 像素间隔必须 ≈ barSpace（每 bar 一槽）；distinct=${JSON.stringify(st.spacingDistinct)} barSpace=${bs}`,
    ).toEqual([]);
    expect(st.curve.present, `${st.label}：聚合图必须已渲染`).toBe(true);
    expect(st.pair.n, `${st.label}：主口径配对点数必须 > 0（禁止「配不上就跳过」）`).toBeGreaterThan(0);
    expect(st.pair.unpairedVertices, `${st.label}：渲染顶点必须全部配对`).toBe(0);
    expect(st.pair.duplicateBars, `${st.label}：不得多个顶点配到同一根 bar`).toBe(0);
    expect(st.curve.mode, `${st.label}：正常态映射必须是主路 index（非降级）`).toBe('index');
    expect(
      st.mapping.indexResidualMaxUser,
      `${st.label}：索引空间预测残差必须 ≈ 0（配对自校验；>1 user unit ⇒ 配对或映射不自洽）`,
    ).toBeLessThanOrEqual(1);
  }
  {
    const ls = states.find((s) => s.label === 'leftscroll');
    expect(
      (ls?.gesture?.['movedBars'] as number) ?? 0,
      `leftscroll：视口必须真实左移若干根（gesture=${JSON.stringify(ls?.gesture)}）`,
    ).not.toBe(0);
    const fw = states.find((s) => s.label === 'follow');
    expect(
      fw?.gesture?.['reachedLatest'],
      `follow：K 线必须推到最新 bar（gesture=${JSON.stringify(fw?.gesture)}）`,
    ).toBe(true);
  }

  // ───────────── 汇总（判词输入） ─────────────
  const brief = (st: StateMeasure) => ({
    label: st.label,
    windowSource: st.attrs.state?.['data-source'] ?? null,
    windowSpanBars: st.attrs.state?.['data-span-bars'] ?? null,
    domain: st.domainAttr,
    xMode: st.curve.mode,
    kline: st.kline.ok
      ? {
          dataLen: st.kline.dataLen,
          fromIdx: st.kline.fromIdx,
          toIdx: st.kline.toIdx,
          bars: st.kline.visibleCount,
          barSpace: st.kline.barSpace,
          firstTs: st.kline.ts[0],
          lastTs: st.kline.ts[st.kline.ts.length - 1],
        }
      : null,
    curve: {
      apiPoints: st.api.pointCount,
      renderedVertices: st.pair.vertices,
      coverageRatio: st.curveCoverage.coverageRatio,
      firstUserX: st.curveCoverage.firstUserX,
      lastUserX: st.curveCoverage.lastUserX,
    },
    windowState: st.attrs.state,
    pair: st.pair,
    follow: st.follow,
    atomic: st.atomic,
    mapping: st.mapping,
    disclose: st.disclose,
    legacy: st.legacy,
    windowLevel: st.windowLevel,
    gapCensus: st.gapCensus,
    zoom: st.zoom ?? null,
    gesture: st.gesture ?? null,
    notes: st.notes,
    screenshots: st.screenshots,
  });
  const summary = {
    runId: RUN_ID,
    totalBars,
    finishedAt: new Date().toISOString(),
    metric: {
      primary: `同一根 bar 配对：曲线渲染顶点 ↔ K 线真身可见 bar（ts 最近邻，容差 ${PAIR_TOL_SEC}s）⇒ Δ984 = 归一化 x 差 × ${CURVE_PLOT_W}；Δraw = 屏幕像素差；判据 max ≤ ${ALIGN_TOL_PX}px`,
      legacy: 'ts 线性反解口径（diagnostic only；仅适用于修复前口径）',
    },
    states: states.map(brief),
    transitions,
  };
  writeJson('summary', summary);

  const pick = (label: string) => states.find((x) => x.label === label);
  const deltas = (f: (s: StateMeasure) => number | null) =>
    Object.fromEntries(states.map((s) => [s.label, f(s)]));
  const verdict = {
    tolPx: ALIGN_TOL_PX,
    /** 主口径（v2）逐态最大配对偏差 */
    pairMaxAbsRawPx: deltas((s) => s.pair.maxAbsRaw),
    pairMaxAbs984Px: deltas((s) => s.pair.maxAbs984),
    pairOk: Object.fromEntries(states.map((s) => [s.label, s.pair.ok])),
    followOk: Object.fromEntries(states.map((s) => [s.label, s.follow.ok])),
    atomicOk: Object.fromEntries(states.map((s) => [s.label, s.atomic.ok])),
    discloseOk: Object.fromEntries(states.map((s) => [s.label, s.disclose.ok])),
    /** 诊断（v1 口径，仅修复前可比） */
    legacyTsLinearInverseSolve984: deltas((s) => s.legacy.tsLinearInverseSolve984),
    legacyIndexVsTsModel984: deltas((s) => s.legacy.indexVsTsModel984),
    /** 可判别性：ts 线性预测残差（大 ⇒ 本探针能区分两种映射） */
    tsLinearPredictResidualPx984: deltas((s) => s.mapping.tsLinearResidualMaxPx984),
    indexPredictResidualUser: deltas((s) => s.mapping.indexResidualMaxUser),
    transitionVerdict: Object.fromEntries(
      Object.entries(transitions).map(([k, v]) => [k, (v as { verdict?: unknown }).verdict]),
    ),
  };
  writeJson('verdict', verdict);
  // eslint-disable-next-line no-console
  console.log('[axis-align-probe-v2] ' + JSON.stringify(verdict, null, 1));

  // ───────────── 判据（主口径） ─────────────
  for (const st of states) {
    expect(
      st.pair.maxAbs984,
      `${st.label}：主口径 max|Δ984| 必须 ≤ ${ALIGN_TOL_PX}px（配对 n=${st.pair.n}，Bars=${st.pair.visibleBars}，notes=${JSON.stringify(st.notes)}）`,
    ).toBeLessThanOrEqual(ALIGN_TOL_PX);
    expect(
      st.pair.maxAbsRaw,
      `${st.label}：主口径 max|Δraw| 必须 ≤ ${ALIGN_TOL_PX}px（真身屏幕像素）`,
    ).toBeLessThanOrEqual(ALIGN_TOL_PX);
  }
  for (const st of states) {
    expect(st.follow.ok, `${st.label}：跟随性（首/末顶点 = 首/末可见 bar，覆盖率 1.000，跨度差 ≤2px）`).toBe(true);
    expect(st.atomic.ok, `${st.label}：数据/域原子性（数据 ⊂ 声明域 ∧ 数据 ⊂ 可见 bar 区间 ∧ 覆盖率 1.000）`).toBe(true);
  }
  expect(
    pick('full')?.disclose.capMatchesTruth,
    `全览披露数值必须与真身一致（文案=${pick('full')?.disclose.capText}；真身可见=${pick('full')?.kline.visibleCount}/run 总=${totalBars}）`,
  ).toBe(true);
  for (const [name, t] of Object.entries(transitions)) {
    expect((t as { verdict?: { ok?: boolean } }).verdict?.ok, `窗口切换「${name}」必须原子（${JSON.stringify((t as { verdict?: unknown }).verdict)}）`).toBe(true);
  }
});

test('P2_degraded_disclosure：注入降级（K 线 bar 序列不可得 / per_bar 亦不可得）必须出 wb-axis-degraded', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(installChartCapture);
  mkdirSync(OUT, { recursive: true });
  await resolveTargetRun(page);
  /** 网络留痕（原始输出）：/api/kline 与 /bars 的请求 URL 与响应体摘要。 */
  const net: Array<{ phase: string; url: string; status: number; summary: string }> = [];
  let phase = 'inject1';
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/\/api\/kline|\/bars|\/curve/.test(u)) return;
    let summary = '';
    try {
      const j = (await resp.json()) as { bars?: unknown[]; points?: unknown[]; total?: number; error?: string };
      summary = `bars=${Array.isArray(j.bars) ? j.bars.length : '-'} points=${Array.isArray(j.points) ? j.points.length : '-'} total=${j.total ?? '-'} err=${j.error ?? '-'}`;
    } catch (e) {
      summary = `non-json(${(e as Error).message.slice(0, 40)})`;
    }
    net.push({ phase, url: u.replace(/^https?:\/\/[^/]+/, ''), status: resp.status(), summary });
  });

  // ── 注入 ①：K 线取数返回空 bar 序列 ⇒ 主路（K 线 bar 序列）不可得 ⇒ 降级到 run per_bar 索引 ──
  await page.route('**/api/kline**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: url.searchParams.get('code') ?? '', period: url.searchParams.get('period') ?? '', bars: [], next_before: null }),
    });
  });
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  {
    const sel = page.getByTestId(`wb-run-select-${RUN_ID}`);
    for (let i = 0; i < 30 && (await sel.count()) === 0; i++) {
      const more = page.getByTestId('wb-runs-more');
      if ((await more.count()) > 0) {
        await more.scrollIntoViewIfNeeded().catch(() => {});
        await more.click({ timeout: 5000 }).catch(() => {});
      }
      await page.waitForTimeout(300);
    }
    await sel.click();
  }
  await expect(page.getByTestId('wb-result')).toBeVisible();
  // 逐帧留痕：降级档位随时间的演进（一次渲染滞后 ⇒ 档位可能后发）
  const progression: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const a = await readWindowAttrs(page);
    progression.push({
      atMs: i * 500,
      mode: a.modes['wb-aggregate-chart'],
      degraded: a.degradedNote,
      source: a.state?.['data-source'] ?? null,
      domain: a.charts['wb-aggregate-chart'],
    });
  }
  // 强制一次额外渲染（切 Tab；图表区不卸载）⇒ 观察档位是否因渲染时序而后发
  await page.getByTestId('wb-tab-perbar').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('wb-tab-trades').click();
  await page.waitForTimeout(1200);
  const afterTab = await readWindowAttrs(page);
  progression.push({ atMs: 'after-tab-switch', mode: afterTab.modes['wb-aggregate-chart'], degraded: afterTab.degradedNote });
  const d1 = await readWindowAttrs(page);
  const k1 = await page.evaluate(probeKline);
  writeJson('degraded_inject1_kline_empty', { attrs: d1, kline: k1, network: net.slice(), progression });
  expect(d1.degradedNote, '降级①（K 线 bar 序列不可得）必须出 wb-axis-degraded 披露（禁静默）').not.toBeNull();
  expect(
    /per_bar 索引|ts 线性/.test(d1.degradedNote ?? ''),
    `降级① 文案必须显式给出降级档位（收到：${String(d1.degradedNote)}）`,
  ).toBe(true);
  expect(
    d1.modes['wb-aggregate-chart'],
    `降级① 必须离开主路（index/ts 均可，但不得静默主路）：mode=${String(d1.modes['wb-aggregate-chart'])}`,
  ).not.toBe(null);

  // ── 注入 ②：**保持 K 线不可得**，再令 run per_bar 亦不可得 ⇒ 纯 ts 线性降级（终档） ──
  writeJson('degraded_inject1_network', net.slice());
  phase = 'inject2';
  await page.route('**/api/workbench/runs/**/bars**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('kind') === 'per_bar') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bars: [], total: 0, has_more: false, next_offset: null }),
      });
      return;
    }
    await route.continue();
  });
  await page.reload();
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  {
    const sel = page.getByTestId(`wb-run-select-${RUN_ID}`);
    for (let i = 0; i < 30 && (await sel.count()) === 0; i++) {
      const more = page.getByTestId('wb-runs-more');
      if ((await more.count()) > 0) {
        await more.scrollIntoViewIfNeeded().catch(() => {});
        await more.click({ timeout: 5000 }).catch(() => {});
      }
      await page.waitForTimeout(300);
    }
    await sel.click();
  }
  await expect(page.getByTestId('wb-result')).toBeVisible();
  const progression2: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    const a = await readWindowAttrs(page);
    progression2.push({ atMs: i * 500, mode: a.modes['wb-aggregate-chart'], degraded: a.degradedNote });
  }
  const d2 = await readWindowAttrs(page);
  writeJson('degraded_inject2_ts_linear', { attrs: d2, probe: d2.probe, progression: progression2, network: net.filter((n) => n.phase === 'inject2') });
  expect(d2.degradedNote, '降级②（K 线 bar 序列与 per_bar 均不可得）必须出 wb-axis-degraded 披露（禁静默）').not.toBeNull();
  expect(d2.degradedNote ?? '', '降级② 文案必须指向 ts 线性降解').toContain('ts 线性');
  expect(d2.modes['wb-aggregate-chart'], '降级② 映射方式必须标注为 ts').toBe('ts');
  expect(
    d2.probe?.['data-ok'],
    '降级② 仍必须给出真身回执探针字段（观测性：data-ok 字段存在）',
  ).toBeDefined();
});
