/**
 * **结果页 K 线历史被截断**（缺陷修复）的**真渲染**判据。
 *
 * ## 现象（用户实测）
 * 结果页 K 线本应从 run 起点（2026-01-01）开始，实际最早只到 **2026-07-08**。
 *
 * ## 根因（架构侧定位，本规格按契约复核，不按实现倒推）
 * 1. `web/src/features/backtest/ScopedKlineFeed.ts` 的 `loadInitial` 把**整段区间**当 `limit` 一次拉
 *    （M15 × 266 天 ⇒ `needBars = 25539`）；服务端 `crates/web/src/rest.rs`
 *    `let limit = q.limit.clamp(1, MAX_LIMIT)`（`dto.rs: MAX_LIMIT = 1000`）⇒ **只回最新 1000 根**
 *    ⇒ 数据域被截成 `[2026-07-08T03:30Z, 2026-09-23T07:00Z]`。
 * 2. `hasMore = fetched.length >= needBars`（1000 ≥ 25539 为假）⇒ `loadBefore()` 首行 `if (!this.hasMore) return 0`
 *    ⇒ **向左拖/滚永不触发分页**，用户无法自行拉回历史。
 *
 * ## 契约（本规格断言的对象）
 * - **D2.3-4**：结果页 K 线的 bar 域**必须**与 run 的 `per_bar` 数据域一致 ⇒ 修后 `dataList`
 *   必须覆盖 `[run.from_ts, run.to_ts]`（K1）。
 * - **ADR-024 D10（禁静默有损）**：分页有上限时必须**显式披露** ⇒ 「未覆盖 run 起点」与
 *   「无触顶披露」不得同时成立（K2）。
 * - **hasMore 语义**：一页取满（= 服务端 `next_before` 非空）⇒ 左侧仍有历史可拉（K3，真身向左到底必须发新请求）。
 *
 * ## 鉴别力（真身、非「元素存在」）
 * - K1 的判据是**图内数据域左端**（`getDataList()[0].timestamp`）与 run 的 `per_bar` 域左端的**逐值比较**：
 *   修复前实测 `2026-07-08T03:30Z`（相差 3005 根）⇒ 必红；仅断言「K 线图存在」则两侧皆绿（无鉴别力）。
 * - K3 的判据是**真身向左到底后是否发新请求 + 左端是否前移**：修复前 `hasMore=false` ⇒ 零新增请求 ⇒ 必红。
 *
 * ## 运行（沙箱预览，**不碰线上 web/dist**）
 *   cd web && npx vite build --outDir /tmp/khline && \
 *     VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/khline --strictPort --port 4181 &
 *   E2E_BASE_URL=http://127.0.0.1:4181 npx playwright test e2e/adr028-kline-history.e2e.ts --retries=0 --workers=1
 *
 * 原始读数落盘：`ADR028_KH_OUT`（默认 `coder/evidence/20260925_kline_history_resolve/raw`，**未跟踪**目录）。
 *
 * ## 目标 run（ADR-028 §2.10.1 **裁决 3｜规格耐久**）
 * **按谓词解析**（`klineHistory`：最新 `period=M15 ∧ status=succeeded ∧ per_bar ≥ 3000` 的 run），
 * **禁硬编码 run id**；解析失败 ⇒ **显式红**（抛错），禁静默换 run / 禁回退为跳过；
 * `ADR028_KH_RUN` 仅作**显式覆盖**逃生门，且**覆盖时仍须满足谓词**（不满足 ⇒ 红）。
 * 本规格的 K1/K2/K3 三条判据**未因去硬编码而改动**（只改「取哪个 run」）。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertResolvedByIdFresh,
  assertRunMatchesPredicate,
  resolveRun,
  type ResolvedRun,
  type RunFetchPort,
  type RunFill,
  type RunLabel,
  type RunListItem,
  type RunRoundTrip,
} from './adr028RunResolve';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/**
 * 证据落盘目录（**必须未跟踪**）：`ADR028_KH_OUT` 可覆盖；默认落在本批新增的未跟踪目录。
 * （`AGENTS.md`「代理产物与提交纪律」：`coder/evidence/` 已 gitignore；**禁**写 `web/dist`。）
 */
const OUT = process.env.ADR028_KH_OUT ?? resolve(REPO, 'coder/evidence/20260925_kline_history_resolve/raw');

/**
 * **已废除的历史字面量**（**不得**用作目标 run；仅作为证据里的「反硬编码」对照）：
 * 该 run **仍在库中**（symbol 159776 / M15 / 3436 根 / succeeded），但在**新→旧**排序里已跌到 **71/93**
 * ⇒ 被顶出历史列表首屏 ⇒ 本规格曾以「运行不在历史列表内」的形式**假红**
 * （读数：`coder/evidence/20260925_adr028_d10d11_fix/BLOCKED_kline_history_run_id.md`）。
 * 它与谓词命中者的结构性事实等价（同 symbol/周期/区间/根数）⇒ 那次红是**可达性**，不是判据回归。
 */
const HISTORICAL_LITERAL = 'sr_1790247371321_000015';
/**
 * 谓词标签：`klineHistory` = `period=M15 ∧ status=succeeded ∧ per_bar ≥ 3000`
 * （阈值 = 3 × 服务端单页上限 1000 根 ⇒ 单页拉不回 ⇒ K1 数据域覆盖 / K3 向前分页**有前提**，不退化恒真）。
 * 定义与逐候选拒因见 `./adr028RunResolve`（**禁硬编码 run id**；§2.10.1 裁决 3）。
 */
const PREDICATE: RunLabel = 'klineHistory';
/** **逃生门（显式覆盖）**：给出具体 run id 时用它（调试/复跑用）；覆盖时仍须现场校验其满足谓词。 */
const OVERRIDE_RUN = process.env.ADR028_KH_RUN?.trim() || null;
/** 后端身份（进落盘缓存键；防跨构建/跨后端复用同一缓存条目）。 */
const RESOLVE_SOURCE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
/** 周期步长（ms）：契约常量（M15 = 900s），用于「±1 根」容差；不 import 产品模块（避免按实现倒推）。 */
const STEP_MS = 15 * 60 * 1000;

/** 解析结果（`beforeAll` 现场解析一次）；**取不到即抛错**（禁静默换 run / 禁跳过）。 */
let TARGET: ResolvedRun | null = null;
function runId(): string {
  if (!TARGET) throw new Error('目标 run 未解析（beforeAll 未产出 ⇒ 显式红，不得静默换 run）');
  return TARGET.id;
}

/** `APIRequestContext` → {@link RunFetchPort} 适配器（只读；口径同 `adr028-window-sync`）。 */
function runPort(ctx: APIRequestContext): RunFetchPort {
  return {
    listRuns: async () => {
      const resp = await ctx.get('/api/workbench/runs?limit=500');
      expect(resp.ok(), 'GET /api/workbench/runs').toBeTruthy();
      return (await resp.json()) as RunListItem[];
    },
    totalBars: async (id: string) => {
      const resp = await ctx.get(`/api/workbench/runs/${id}/bars?kind=per_bar&offset=0&limit=1`);
      expect(resp.ok(), `GET /bars per_bar ${id}`).toBeTruthy();
      const total = ((await resp.json()) as { total?: number }).total;
      expect(typeof total, '/bars per_bar 必须回 total').toBe('number');
      return total!;
    },
    roundTrips: async (id: string) => {
      const resp = await ctx.get(`/api/workbench/runs/${id}/round-trips?limit=5000`);
      expect(resp.ok(), `GET /round-trips ${id}`).toBeTruthy();
      return ((await resp.json()) as { round_trips?: RunRoundTrip[] }).round_trips ?? [];
    },
    fills: async (id: string, rtSeq: number) => {
      const resp = await ctx.get(`/api/workbench/runs/${id}/round-trips/${rtSeq}/fills?limit=200`);
      expect(resp.ok(), `GET /fills ${id}/${rtSeq}`).toBeTruthy();
      return ((await resp.json()) as { fills?: RunFill[] }).fills ?? [];
    },
  };
}

/**
 * **反硬编码护栏**（裁决 3）：规格实际使用的 run id 必须 == **现场重解析**结果（**不走落盘缓存**）。
 * 把目标改回字面量（硬编码）后，只要该字面量不是谓词命中的最新匹配 ⇒ 本护栏抛错 ⇒ 规格必红。
 */
async function guardResolved(ctx: APIRequestContext): Promise<void> {
  if (OVERRIDE_RUN) return; // 覆盖路径已在 beforeAll 校验「满足谓词」（覆盖允许 ≠ 最新命中者）
  const fresh = await resolveRun(runPort(ctx), PREDICATE, { cacheDir: null, sourceKey: RESOLVE_SOURCE });
  assertResolvedByIdFresh(runId(), fresh, PREDICATE);
}

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

// ───────────────────────────────── 页面侧探针（真身、只读） ─────────────────────────────────

/** 捕获 klinecharts 实例（形状过滤：同时具备 `setBarSpace` + `convertToPixel` + `getDataList`）。 */
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

/** 真身 K 线数据域（取 dataList 最长者 = 结果页主图）。 */
function readDataList(): number[] {
  const w = window as unknown as { __wbCharts?: Array<{ getDataList?: () => Array<{ timestamp: number }> }> };
  let best: number[] = [];
  for (const c of w.__wbCharts ?? []) {
    try {
      const l = (c.getDataList?.() ?? []).map((k) => k.timestamp);
      if (l.length > best.length) best = l;
    } catch {
      /* ignore */
    }
  }
  return best;
}

/** 把真身视口移到数据最左（`scrollToDataIndex(0)`；真身引擎 API，见 adr028-axis-align-probe 先例）。 */
function scrollToStart(): boolean {
  const w = window as unknown as {
    __wbCharts?: Array<{ getDataList?: () => unknown[]; scrollToDataIndex?: (i: number) => void }>;
  };
  for (const c of w.__wbCharts ?? []) {
    const n = (c.getDataList?.() ?? []).length;
    if (n > 0 && typeof c.scrollToDataIndex === 'function') {
      c.scrollToDataIndex(0);
      return true;
    }
  }
  return false;
}

interface RunFacts {
  runId: string;
  period: string;
  symbol: string;
  fromMs: number;
  toMs: number;
  /** run 的 `per_bar` 域（`/curve?kind=per_bar`）：`original_bars` + 落在 `[from_ts, to_ts]` 的 ts（ms）。 */
  originalBars: number;
  inRangeCount: number;
  expFirstMs: number;
  expLastMs: number;
}

async function readFacts(page: Page): Promise<RunFacts> {
  const id = runId();
  const runResp = await page.request.get(`/api/workbench/runs/${id}`);
  expect(runResp.ok(), `/api/workbench/runs/${id}`).toBeTruthy();
  const run = (await runResp.json()) as { period: string; symbol: string; from_ts: string; to_ts: string };
  const fromMs = Date.parse(run.from_ts);
  const toMs = Date.parse(run.to_ts);
  const curveResp = await page.request.get(`/api/workbench/runs/${id}/curve?kind=per_bar&k=5000`);
  expect(curveResp.ok(), `/curve?kind=per_bar ${id}`).toBeTruthy();
  const curve = (await curveResp.json()) as {
    original_bars?: number;
    points?: Array<{ ts: number }>;
  };
  const allMs = (curve.points ?? []).map((p) => p.ts * 1000);
  const inRange = allMs.filter((t) => t >= fromMs && t <= toMs);
  expect(inRange.length, 'run 的 per_bar 必须在区间内有数据（否则判据无意义）').toBeGreaterThan(0);
  return {
    runId: id,
    period: run.period,
    symbol: run.symbol,
    fromMs,
    toMs,
    originalBars: curve.original_bars ?? allMs.length,
    inRangeCount: inRange.length,
    expFirstMs: inRange[0]!,
    expLastMs: inRange[inRange.length - 1]!,
  };
}

async function openRunSettled(page: Page, expectedCount: number): Promise<void> {
  const id = runId();
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${id}`);
  // 靶 run 由谓词解析为「**最新**命中者」⇒ 本就在历史列表首屏（位次证据见 `kh_run_resolution.json`）；
  // 此处**不翻页**：把「取哪个 run」交给谓词解析，而不是靠翻页去海里捞旧的硬编码靶。
  await expect(select, `运行 ${id}（谓词 ${PREDICATE} 的现场解析结果）必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'kline');
  // 初始装载落定：dataList 长度「连续 ~2.5s 不变」（或已达 run 区间根数）。
  // 修复前会停在被截断的 1000 根 ⇒ 退出等待后由断言报红（不在等待里超时，保住红读数的可读性）。
  const t0 = Date.now();
  let prev = -1;
  let lastChange = Date.now();
  while (Date.now() - t0 < 30_000) {
    const n = (await page.evaluate(readDataList)).length;
    if (n !== prev) {
      prev = n;
      lastChange = Date.now();
    } else if (n >= expectedCount) {
      return;
    } else if (n > 0 && Date.now() - lastChange > 2500) {
      return;
    }
    await page.waitForTimeout(250);
  }
}

// ─────────────────────────────── 断言集合（单一事实源；变异用例复用） ───────────────────────────────

/**
 * **K1｜数据域覆盖**（D2.3-4）：`dataList` 的左端必须落在 run `per_bar` 域左端 **±1 根**内，
 * 右端同样 ±1 根；根数不得少于区间内根数；首根必须与周期网格对齐。
 */
export function domainMismatches(dataList: number[], f: RunFacts): string[] {
  const m: string[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push('dataList 非空', dataList.length > 0, `len=${dataList.length}`);
  if (dataList.length === 0) return m;
  const first = dataList[0]!;
  const last = dataList[dataList.length - 1]!;
  push(
    '左端覆盖：dataList[0] ≤ run 首个在区间内 bar + 1 根（修复前实测首根 = 2026-07-08T03:30Z，缺 2185 根）',
    first <= f.expFirstMs + STEP_MS,
    `dataList[0]=${iso(first)} expFirst=${iso(f.expFirstMs)}（滞后 ${(first - f.expFirstMs) / STEP_MS} 个周期步长）`,
  );
  push(
    '左端不越域：dataList[0] ≥ run 首个在区间内 bar − 1 根（bar 域须与 per_bar 一致，禁多取）',
    first >= f.expFirstMs - STEP_MS,
    `dataList[0]=${iso(first)} expFirst=${iso(f.expFirstMs)}`,
  );
  push(
    '右端对齐：dataList[last] == run 最后一个在区间内 bar（±1 根）',
    Math.abs(last - f.expLastMs) <= STEP_MS,
    `dataList[last]=${iso(last)} expLast=${iso(f.expLastMs)}`,
  );
  push(
    '根数：dataList.length ≥ 区间内 per_bar 根数',
    dataList.length >= f.inRangeCount,
    `len=${dataList.length} inRange=${f.inRangeCount}（original_bars=${f.originalBars}）`,
  );
  push(
    '网格对齐：dataList[0] 与 expFirst 同余（周期网格一致）',
    (first - f.expFirstMs) % STEP_MS === 0,
    `Δ=${first - f.expFirstMs}ms step=${STEP_MS}ms`,
  );
  return m;
}

// ─────────────────────────────────────────── 用例 ───────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

/**
 * **目标 run 解析**（§2.10.1 裁决 3）：解析失败 ⇒ 抛错 ⇒ 整个文件**显式红**（禁静默换 run / 禁跳过）。
 * 两条路径都写进证据（谓词原文 / 扫描面 / 逐候选拒因 / 新→旧位次 / 历史字面量对照）。
 */
test.beforeAll(async ({ request }) => {
  const port = runPort(request);
  TARGET = OVERRIDE_RUN
    ? await assertRunMatchesPredicate(port, PREDICATE, OVERRIDE_RUN)
    : await resolveRun(port, PREDICATE, { sourceKey: RESOLVE_SOURCE });
  writeJson('kh_run_resolution', { overrideRun: OVERRIDE_RUN, historicalLiteral: HISTORICAL_LITERAL, resolved: TARGET });
  console.log(`[adr028-kline-history] 靶 run = ${TARGET.id}（${OVERRIDE_RUN ? '显式覆盖' : '谓词解析'}；${PREDICATE}）`);
});

test('K1_data_domain：初始装载后 K 线数据域必须覆盖 run 区间（首根 = run 区间首个 bar，非 2026-07-08）', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.addInitScript(installChartCapture);
  await guardResolved(request);
  const f = await readFacts(page);
  await openRunSettled(page, f.inRangeCount);
  const dataList = await page.evaluate(readDataList);
  const rec = {
    facts: f,
    dataListLen: dataList.length,
    dataListFirst: dataList.length ? new Date(dataList[0]!).toISOString() : null,
    dataListLast: dataList.length ? new Date(dataList[dataList.length - 1]!).toISOString() : null,
    mismatch: [] as string[],
  };
  rec.mismatch = domainMismatches(dataList, f);
  writeJson('k1_data_domain', rec);
  expect(rec.mismatch, 'K1：K 线数据域必须与 run per_bar 域一致（变异/回退时必红）').toEqual([]);
});

test('K2_disclosure：全览披露「共 N 根」与 /curve original_bars 一致；未覆盖起点时必须显式披露触顶', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.addInitScript(installChartCapture);
  await guardResolved(request);
  const f = await readFacts(page);
  await openRunSettled(page, f.inRangeCount);

  await page.getByTestId('wb-window-reset').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'full');
  await page.waitForTimeout(1500);

  const dataList = await page.evaluate(readDataList);
  const capLoc = page.getByTestId('wb-window-cap');
  const capText = (await capLoc.count()) > 0 ? ((await capLoc.first().textContent()) ?? '').trim() : '';
  const capBars = /共\s*(\d+)\s*根/.exec(capText)?.[1];
  const truncLoc = page.getByTestId('wb-kline-history-cap');
  const truncVisible = (await truncLoc.count()) > 0;
  const truncText = truncVisible ? (((await truncLoc.first().textContent()) ?? '').trim()) : '';

  const leftCovered =
    dataList.length > 0 && dataList[0]! <= f.expFirstMs + STEP_MS;
  const rec = {
    facts: f,
    dataListLen: dataList.length,
    dataListFirst: dataList.length ? new Date(dataList[0]!).toISOString() : null,
    capText,
    capBars: capBars ? Number(capBars) : null,
    originalBars: f.originalBars,
    truncationDisclosureVisible: truncVisible,
    truncationDisclosureText: truncText,
    leftCovered,
    mismatch: [] as string[],
  };

  const m: string[] = [];
  m.push(
    ...domainMismatches(dataList, f).map((x) => `[域] ${x}`),
  );
  if (capText) {
    if (rec.capBars == null) m.push(`全览披露存在但无法解析「共 N 根」：${JSON.stringify(capText)}`);
    else if (rec.capBars !== f.originalBars)
      m.push(
        `全览披露的「共 ${rec.capBars} 根」≠ /curve original_bars（${f.originalBars}）‖ text=${JSON.stringify(capText)}`,
      );
  }
  // ADR-024 D10：**禁静默有损** —— 「未覆盖 run 起点」与「无触顶披露」不得同时成立。
  if (!leftCovered && !truncVisible) {
    m.push(
      `静默截断：K 线左端 ${rec.dataListFirst} 未覆盖 run 起点 ${new Date(f.expFirstMs).toISOString()}，且页面无触顶披露（wb-kline-history-cap 缺席）`,
    );
  }
  rec.mismatch = m;
  writeJson('k2_disclosure', rec);
  expect(m, 'K2：披露口径必须与事实源一致且不得静默截断').toEqual([]);
});

test('K3_forward_page：真身向左到底必须触发向前分页（hasMore 不再被服务端夹取堵死）', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.addInitScript(installChartCapture);
  await guardResolved(request);
  const f = await readFacts(page);

  const reqs: Array<{ url: string; before: string | null; limit: string | null }> = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.includes('/api/kline?')) return;
    const p = new URL(u).searchParams;
    reqs.push({ url: u, before: p.get('before'), limit: p.get('limit') });
  });

  await openRunSettled(page, f.inRangeCount);
  const before = await page.evaluate(readDataList);
  const n0 = reqs.length;
  const scrolled = await page.evaluate(scrollToStart);
  // 边界处补一次**真手势**（用户拖拽），确保引擎派发滚动事件（scrollToDataIndex 已把视口放到数据最左）
  const box = await page.locator('[data-testid="kline-chart"]').first().boundingBox();
  if (box) {
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 8 });
    await page.mouse.up();
  }

  const grew = await expect
    .poll(() => reqs.length, { timeout: 15_000, message: '向左到底必须发新 /api/kline 请求（hasMore 分页）' })
    .toBeGreaterThan(n0)
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(2000);
  const after = await page.evaluate(readDataList);
  const extra = reqs.slice(n0);
  const rec = {
    facts: f,
    scrollToStartOk: scrolled,
    initialRequests: n0,
    extraRequests: extra,
    beforeFirst: before.length ? new Date(before[0]!).toISOString() : null,
    afterFirst: after.length ? new Date(after[0]!).toISOString() : null,
    beforeLen: before.length,
    afterLen: after.length,
    mismatch: [] as string[],
  };
  const m: string[] = [];
  if (!grew) m.push(`向左到底未触发任何新 /api/kline 请求（initial=${n0}，修复前 hasMore=false 即此态）`);
  for (const r of extra) {
    if (r.before == null) m.push(`新请求缺 before 游标：${r.url}`);
    else if (before.length > 0 && Date.parse(r.before) > before[0]!)
      m.push(`新请求游标 ${r.before} 未早于当前最左 bar ${rec.beforeFirst}`);
    if (r.limit != null && Number(r.limit) > 1000)
      m.push(`新请求 limit=${r.limit} 超服务端单页上限 1000（只会被夹取）`);
  }
  if (before.length > 0 && after.length > 0 && after[0]! >= before[0]!)
    m.push(`左端未前移：before=${rec.beforeFirst} after=${rec.afterFirst}`);
  rec.mismatch = m;
  writeJson('k3_forward_page', rec);
  expect(m, 'K3：向前分页必须真身可达（变异 hasMore 为旧式时必红）').toEqual([]);
});
