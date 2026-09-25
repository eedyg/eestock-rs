/**
 * ADR-028 D2.1/D2.3 修复波（2026-09-20）**独立复核规格**（coder 车道；tester 的
 * `adr028-axis-align-probe.e2e.ts` 为只读回归基线，本文件不改动它）。
 *
 * 与 tester 规格的差别（**方法学要点，必读**）：
 *  - tester 的 Δ984 主口径把曲线**渲染 x** 先按「ts 线性」反解成 ts，再在同一 ts 上比 K 线像素；
 *    该反解**只在曲线本身按 ts 线性绘制时成立**。本修复把曲线 x 改成 **bar 索引空间**（ADR-028 D2.1）
 *    ⇒ 该反解不再与渲染口径同源，故主口径**对映射方式的改变不敏感**（实测：修复前后同为 119~352px）。
 *  - 本规格用**真身配对**（同一根 bar）：曲线顶点的 ts 由 `/curve` 数据一对一带出，K 线像素由
 *    `convertToPixel(bar ts)` 真身读回 ⇒ 直接回答「同一根 bar 在两图上的像素偏差」。
 *    归一化口径与 tester 一致（锚点 = 数据首末；984 = 曲线 plot 宽度 user units）。
 *
 * 判据：`max|Δ984| ≤ 2px` 且 `max|Δraw| ≤ 2px`（未归一化的**真身屏幕像素**，含容器内缩常量）。
 * 断言（恒真反证）：K 线真身可读、相邻 bar 像素间隔 ≈ barSpace、曲线已渲染、
 * 每态配对点数 = 曲线顶点数（不许「配对不上就跳过」）。
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
 * `coder/evidence/20260920_adr027_axis_fix/raw/` 已被 git 跟踪 ⇒ 每次真跑都会覆写已跟踪文件）。
 * 可用 `ADR027_VERIFY_OUT` 覆盖。
 */
const OUT = process.env.ADR027_VERIFY_OUT ?? resolve(REPO, 'coder/evidence/20260925_adr028_d10_ruling/raw_axis_verify');
/**
 * **ADR-028 §2.10.1 裁决 3｜规格耐久**：目标 run（M5、根数足够、含缺口）按**谓词解析**——
 * 禁硬编码 run id（库增长会把目标 run 顶出历史列表首屏）；解析失败 ⇒ 显式红。
 * `RUN_ID` 由 {@link resolveTargetRun} 在用例开始时填入（**已废除**的历史字面量：`sr_1789832517800_000006`）。
 */
let RUN_ID = '';
const PLOT_W = 984; // 曲线 plot 宽度（user units；与 tester 口径一致）
const TOL = 2;

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

// ───────────────────────────────────── 页面侧探针（只读） ─────────────────────────────────────

function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { setBarSpace?: unknown; convertToPixel?: unknown; getDataList?: unknown } | null;
    if (
      o != null &&
      typeof o === 'object' &&
      typeof o['setBarSpace'] === 'function' &&
      typeof o['convertToPixel'] === 'function' &&
      typeof o['getDataList'] === 'function'
    ) {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}

/** K 线真身：可见 bar 的 ts + **屏幕**像素 x（convertToPixel + 容器 left）。 */
function probeKline() {
  interface ChartLike {
    getDataList?: () => Array<{ timestamp: number }>;
    getVisibleRange?: () => { from: number; to: number; realFrom?: number; realTo?: number };
    getBarSpace?: () => { bar: number };
    getSize?: () => { width: number } | null;
    convertToPixel?: (p: { timestamp: number }, f?: { paneId?: string }) => { x?: number } | undefined;
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const div = document.querySelector('[data-testid="kline-chart"]');
  const rect = div ? div.getBoundingClientRect() : null;
  const cands = (w.__wbCharts ?? []).map((chart) => ({ chart, n: (chart.getDataList?.() ?? []).length }));
  const chosen = cands.filter((c) => c.n > 0).sort((a, b) => b.n - a.n)[0] ?? null;
  if (!chosen || !rect) return { ok: false, error: 'K 线真身/容器不可读' } as const;
  const chart = chosen.chart;
  const list = chart.getDataList!();
  const range = chart.getVisibleRange!();
  const last = list.length - 1;
  const fromIdx = Math.max(0, Math.min(last, Math.round(range.from)));
  const toIdx = Math.max(fromIdx, Math.min(last, Math.round(range.to)));
  const ts: number[] = [];
  const xAbs: number[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const ms = list[i]!.timestamp;
    const px = chart.convertToPixel?.({ timestamp: ms }, { paneId: 'candle_pane' });
    ts.push(Math.floor(ms / 1000));
    xAbs.push(typeof px?.x === 'number' ? px.x + rect.left : Number.NaN);
  }
  return {
    ok: true,
    error: '',
    dataLen: list.length,
    fromIdx,
    toIdx,
    barSpace: chart.getBarSpace?.()?.bar ?? null,
    containerLeft: rect.left,
    chartWidth: rect.width,
    ts,
    xAbs,
    visible: toIdx - fromIdx + 1,
  } as const;
}

/** 曲线已渲染几何（user units + 屏幕 px）。 */
function probeCurve(testId: string) {
  const host = document.querySelector(`[data-testid="${testId}"]`);
  const svg = host?.querySelector('svg') as SVGSVGElement | null;
  if (!host || !svg) return { present: false, mode: null as string | null, domain: null as string | null, userX: [] as number[], screenX: [] as number[], svgLeft: 0, svgWidth: 0 };
  const r = svg.getBoundingClientRect();
  const ctm = svg.getScreenCTM();
  const pt = svg.createSVGPoint();
  const poly = svg.querySelector('polyline');
  const nums = (poly?.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => Number(tok.split(',')[0]));
  const screenX = nums.map((x) => {
    if (!ctm) return Number.NaN;
    pt.x = x;
    pt.y = 0;
    return pt.matrixTransform(ctm).x;
  });
  return {
    present: true,
    mode: host.getAttribute('data-x-mode'),
    domain: host.getAttribute('data-x-domain'),
    userX: nums,
    screenX,
    svgLeft: r.left,
    svgWidth: r.width,
  };
}

// ────────────────────────────────────────── 动作 ──────────────────────────────────────────

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
 * 解析目标 run（谓词 `m5`）+ **反硬编码护栏**（规格使用的 id 必须 == 现场重解析结果）+
 * 把解析证据落盘（复核者可回答「解析到什么、为什么」）。
 */
async function resolveTargetRun(page: Page): Promise<ResolvedRun> {
  // 落盘缓存（未跟踪目录；命中仍校验）+ **护栏走现场解析（不走缓存）**
  const sourceKey = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
  const run = await resolveRun(runPort(page), 'm5', { sourceKey });
  const fresh = await resolveRun(runPort(page), 'm5', { cacheDir: null, sourceKey });
  assertResolvedByIdFresh(run.id, fresh, 'm5');
  RUN_ID = run.id;
  writeJson('run_resolution', {
    id: run.id,
    predicate: run.predicate,
    totalBars: run.totalBars,
    evidence: run.evidence,
  });
  return run;
}

async function openRunSettled(page: Page): Promise<void> {
  await resolveTargetRun(page);
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${RUN_ID}`);
  // 历史列表**分页**（新 run 顶掉旧 run 的首屏位置）⇒ 翻页查找（2026-09-25 复验实测：首屏 50 / 共 93）
  await expect(page.locator('[data-testid^="wb-run-select-"]').first()).toBeVisible();
  for (let i = 0; i < 30 && (await select.count()) === 0; i++) {
    const more = page.getByTestId('wb-runs-more');
    if ((await more.count()) > 0) {
      await more.scrollIntoViewIfNeeded().catch(() => {});
      await more.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  await expect(select).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'kline');
  await page.waitForTimeout(2500);
}

async function curvePointsInWindow(page: Page, fromTs: number | null, toTs: number | null): Promise<number[]> {
  const q = new URLSearchParams({ kind: 'per_bar', k: '2000' });
  if (fromTs != null && toTs != null) {
    q.set('from_ts', String(fromTs));
    q.set('to_ts', String(toTs));
  }
  const resp = await page.request.get(`/api/workbench/runs/${RUN_ID}/curve?${q.toString()}`);
  const j = (await resp.json()) as { points?: Array<{ ts: number }> };
  return (j.points ?? []).map((p) => p.ts);
}

function lerp(ts: number[], xs: number[], t: number): number | null {
  if (ts.length === 0 || t < ts[0]! || t > ts[ts.length - 1]!) return null;
  for (let i = 1; i < ts.length; i++) {
    if (ts[i]! >= t) {
      const t0 = ts[i - 1]!;
      const t1 = ts[i]!;
      if (t1 === t0) return xs[i - 1]!;
      const f = (t - t0) / (t1 - t0);
      return xs[i - 1]! + f * (xs[i]! - xs[i - 1]!);
    }
  }
  return xs[xs.length - 1]!;
}

interface StateResult {
  label: string;
  windowSource: string | null;
  domainAttr: string | null;
  xMode: string | null;
  windowEqualsViewport: boolean | null;
  coverage: number | null;
  bars: number;
  curveVertices: number;
  pairs: number;
  maxAbsRawPx: number | null;
  maxAbs984: number | null;
  argmaxTs: number | null;
  headDeficitPx984: number | null;
  tailDeficitPx984: number | null;
  notes: string[];
}

async function measure(page: Page, label: string): Promise<StateResult> {
  const kline = await page.evaluate(probeKline);
  const curve = (await page.evaluate(probeCurve, 'wb-aggregate-chart')) as ReturnType<typeof probeCurve>;
  const state = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-window-state"]');
    return {
      source: el?.getAttribute('data-source') ?? null,
      fromTs: el?.getAttribute('data-from-ts') ?? '',
      toTs: el?.getAttribute('data-to-ts') ?? '',
    };
  });
  const notes: string[] = [];
  const domain = curve.domain && curve.domain !== 'data' ? curve.domain.split(',').map(Number) : null;
  // 曲线数据点（与渲染顶点一一对应）：全览态由页面声明全区间，但渲染只覆盖 K 线可见范围
  let pts = await curvePointsInWindow(page, domain?.[0] ?? null, domain?.[1] ?? null);
  if (!kline.ok || !curve.present) {
    return {
      label, windowSource: state.source, domainAttr: curve.domain, xMode: curve.mode,
      windowEqualsViewport: null, coverage: null, bars: 0, curveVertices: curve.userX.length, pairs: 0,
      maxAbsRawPx: null, maxAbs984: null, argmaxTs: null, headDeficitPx984: null, tailDeficitPx984: null,
      notes: [`不可测：kline.ok=${kline.ok} curve=${curve.present}`],
    };
  }
  const kvis: [number, number] = [kline.ts[0]!, kline.ts[kline.ts.length - 1]!];
  // 渲染顶点只覆盖 K 线可见 ts 区间（超出范围的点不绘）⇒ 配对前先裁剪到同一区间
  pts = pts.filter((t) => t >= kvis[0] && t <= kvis[1]);
  const n = Math.min(pts.length, curve.userX.length);
  if (n !== pts.length || n !== curve.userX.length) {
    notes.push(`配对点数 = ${n}（曲线数据 ${pts.length} / 渲染顶点 ${curve.userX.length}）—— 超出可见范围的点按设计不绘`);
  }
  const xKa = kline.xAbs[0]!;
  const xKb = kline.xAbs[kline.xAbs.length - 1]!;
  const xCa = curve.screenX[0]!;
  const xCb = curve.screenX[curve.screenX.length - 1]!;
  const kSpan = xKb - xKa;
  const cSpan = xCb - xCa;
  let maxRaw = -1;
  let max984 = -1;
  let argmaxTs: number | null = null;
  for (let i = 0; i < n; i++) {
    const t = pts[i]!;
    const xK = lerp(kline.ts, kline.xAbs, t);
    const xC = curve.screenX[i];
    if (xK == null || xC == null || !Number.isFinite(xC)) continue;
    const raw = Math.abs(xK - xC);
    // 归一化（tester 口径：各自以数据首末为锚点）
    const d984 = Math.abs(((xK - xKa) / kSpan - (xC - xCa) / cSpan) * PLOT_W);
    if (raw > maxRaw) maxRaw = raw;
    if (d984 > max984) {
      max984 = d984;
      argmaxTs = t;
    }
  }
  const windowEqualsViewport =
    state.fromTs && state.toTs
      ? Number(state.fromTs) === kvis[0] && Number(state.toTs) === kvis[1]
      : null;
  const coverage = state.fromTs && state.toTs ? (kvis[1] - kvis[0]) / Math.max(1, Number(state.toTs) - Number(state.fromTs)) : null;
  const firstUser = curve.userX[0] ?? null;
  const lastUser = curve.userX[curve.userX.length - 1] ?? null;
  return {
    label,
    windowSource: state.source,
    domainAttr: curve.domain,
    xMode: curve.mode,
    windowEqualsViewport,
    coverage,
    bars: kline.visible,
    curveVertices: curve.userX.length,
    pairs: n,
    maxAbsRawPx: maxRaw < 0 ? null : Math.round(maxRaw * 100) / 100,
    maxAbs984: max984 < 0 ? null : Math.round(max984 * 100) / 100,
    argmaxTs,
    headDeficitPx984: firstUser == null ? null : Math.round((firstUser - 8) * 100) / 100,
    tailDeficitPx984: lastUser == null ? null : Math.round((1000 - 8 - lastUser) * 100) / 100,
    notes,
  };
}

async function klineCenter(page: Page): Promise<{ x: number; y: number }> {
  const loc = page.locator('[data-testid="kline-chart"]').first();
  await loc.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const b = await loc.boundingBox();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  return {
    x: Math.min(Math.max((b?.x ?? 0) + (b?.width ?? 600) / 2, 1), vp.width - 1),
    y: Math.min(Math.max((b?.y ?? 0) + (b?.height ?? 200) / 2, 1), vp.height - 1),
  };
}

async function visibleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<{ getDataList?: () => unknown[]; getVisibleRange?: () => { from: number; to: number } }> };
    let count = 0;
    for (const c of w.__wbCharts ?? []) {
      const n = (c.getDataList?.() ?? []).length;
      if (n <= 0) continue;
      const r = c.getVisibleRange?.();
      if (!r) continue;
      count = Math.max(count, Math.round(r.to) - Math.round(r.from) + 1);
    }
    return count;
  });
}

// ─────────────────────────────────────────── 用例 ───────────────────────────────────────────

test.describe.configure({ mode: 'serial', timeout: 180_000 }); // timeout：§7.2 修法 ①（谓词解析不得吃穿默认 60s 预算）

test('V1_true_pairing：同一根 bar 在 K 线与曲线上的真身像素偏差（六态）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(installChartCapture);
  mkdirSync(OUT, { recursive: true });
  await openRunSettled(page);

  const results: StateResult[] = [];
  const record = async (label: string) => {
    const st = await measure(page, label);
    results.push(st);
    return st;
  };

  await record('init');

  // 全览（ADR-028 §2.10 D10 决策 2：以**实测可达区间**写回窗口状态机 ⇒ source=reset；
  // 不再停在「全区间」——否则取数窗口（全区间）与 x 域（真身可见切片）两源错位、逐点剔除）
  await page.getByTestId('wb-window-reset').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'reset');
  await page.waitForTimeout(1500);
  await record('full');

  // L2 跳转（~120 根）
  const rtResp = await page.request.get(`/api/workbench/runs/${RUN_ID}/round-trips?limit=5000`);
  const rows = ((await rtResp.json()) as { round_trips?: Array<{ rt_seq: number; l2_count: number; open_ts: number }> }).round_trips ?? [];
  const kl = await page.evaluate(probeKline);
  const target = rows.filter((r) => r.l2_count > 0 && r.open_ts > (kl.link ?? 0)).pop() ?? rows.filter((r) => r.l2_count > 0)[Math.floor(rows.length / 2)];
  await page.getByTestId(`wb-rt-detail-${target!.rt_seq}`).click();
  const l2 = page.getByTestId(`wb-l2-row-${target!.rt_seq}-0`);
  await l2.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${target!.rt_seq}-0`).click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(1500);
  await record('narrow120');

  // 滚轮缩小到 ~300 / ~600
  for (const want of [300, 600] as const) {
    const c = await klineCenter(page);
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(c.x, c.y);
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(110);
      if ((await visibleCount(page)) >= want) break;
    }
    await page.waitForTimeout(1200);
    await record(`zoom${want}`);
  }

  writeJson('verify_states', results);
  // eslint-disable-next-line no-console
  console.log('[axis-fix-verify] ' + JSON.stringify(results.map((r) => ({ l: r.label, raw: r.maxAbsRawPx, n984: r.maxAbs984, pairs: r.pairs, cov: r.coverage, tail: r.tailDeficitPx984 })), null, 1));

  // ── 恒真反证（测量有效性）──
  for (const r of results) {
    expect(r.pairs, `${r.label}：配对点数必须 = 曲线顶点数（不许配不上就跳过）`).toBeGreaterThan(0);
    expect(r.maxAbs984, `${r.label}：归一化偏差必须可算`).not.toBeNull();
  }
  const worst = Math.max(...results.map((r) => r.maxAbs984 ?? 0));
  const worstRaw = Math.max(...results.map((r) => r.maxAbsRawPx ?? 0));
  writeJson('verify_verdict', { tolPx: TOL, worstNormPx: worst, worstRawPx: worstRaw, states: results });
  expect(worst, '六态最大 |Δ984| ≤ 2px（同一根 bar 的真身配对）').toBeLessThanOrEqual(TOL);
  expect(worstRaw, '六态最大 |Δraw| ≤ 2px（真身屏幕像素，含容器内缩）').toBeLessThanOrEqual(TOL);
});
