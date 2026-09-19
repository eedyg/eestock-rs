/**
 * ADR-028 P5c/P9b：**真渲染**端到端 —— L1/L2 `[跳转]` 成功性与窗口联动（闸门 2 中危发现 M1）。
 *
 * 契约（冻结）：
 *  - `design/01-architecture/adr/ADR-028-result-visualization-position-ratio-and-window-sync.md`
 *    §4 验收第 1/2 条（窗口一致性 / 跳转确定性，`setBarSpace` 未被静默吞掉）；
 *  - `design/17-trade-detail-layering/02-spec.md` §9（前端交互契约：唯一窗口事实源 / 消费者 /
 *    断言跳转成功 / `barSpaceLimit` 放宽**不得泄漏到看板基准图与宫格**）；
 *  - `design/17-trade-detail-layering/03-test-plan.md` E 段 E1–E4。
 *
 * **为什么必须真渲染**（M1）：既有 F7/F9 断言全部落在 `@/test/syncChartStub`（**桩**，自陈
 * 「可见根数与真身不完全一致」）；历史实测在真身 klinecharts 下 `setBarSpace(302)` 只得到 4 根可见
 * （越界被引擎静默 `return`）。故本规格：
 *  1. 断言**真身回执**：`ResultView` 把 `WindowApplyResult.observed`（来自真身
 *     `getBarSpace()` / `getVisibleRange()` 的**读回值**）上屏为 `wb-window-probe` 的 `data-*`；
 *  2. 断言**真身可见窗口**（ts 端点 + **中心 bar**，后者对稀疏 bar 用 `observed_center_ts`，
 *     **不能**用 `(from_ts+to_ts)/2` —— 稀疏 bar 下二者不等）；
 *  3. **禁假绿**：同一套 `*Mismatches()` 断言在「基线用例断言为空、变异用例断言非空」两侧复用
 *     —— 若 `setBarSpace` 被静默吞掉（窗口不生效），真身窗口不会匹配 ⇒ 必红。
 *
 * **P9b 复验整改（本文件本轮硬化，对应冻结判词 B2 的两个洞）**：
 *  - **G1（恒真豁免已移除）**：旧版 L2 的居中判据写成 `p.edgeClamped || |中心−目标| ≤ 1`，而默认目标
 *    （成交贴数据末端）在 span=120 下**物理上恒被夹取** ⇒ 该条**永远不执行**（实测中心偏差 29 根仍判过）。
 *    现在：**按数据侧边界算出期望值**再断言 —— 夹取时断言「窗口右缘**恰在**数据末端」+「中心 = 右缘 −
 *    floor((可见根数−1)/2)」+「居中确实被数据末端阻断」，不做任何豁免（见 {@link l2ClampedMismatches}）。
 *  - **G2（窗口过宽/只改 barSpace 不滚动）**：L1 增**上界**断言与**居中**断言
 *    （{@link l1Mismatches} 第 4/5 条）；L2 增「目标 bar 必须落在可见 fromIdx..toIdx 内」；
 *    并新增 **E3 真居中用例**（目标两侧各有 ≥60 根 ⇒ `edge_clamped=false` 路径**至少被真跑一次**）与
 *    **M2 变异反证**（真身 `scrollToDataIndex` 被替换为 no-op ⇒ `barSpace` 生效但窗口不滚 ⇒ 断言必红）。
 *
 * **真身索引口径（实测锚定，断言里会自证）**：`wb-window-probe` 的 `data-*-idx` 是**图表 dataList
 * 内的索引**；对「K 线数据窗口 = run 区间（+前向分页）」的 run，图表索引空间与 `/fills` 的
 * `bar_index`（引擎 bar 序）**重合**。E2 因此显式断言 `centerIdx === fill.bar_index` 与
 * `toIdx === centerIdx`（数据末端目标）——若某天两者不再重合，**测试会响亮变红**，不会静默放行。
 *
 * 运行（**真身** = 生产构建产物 + 真实 :8081 后端/库；dev server 因 React StrictMode 双次 effect
 * 与 `WorkbenchStore.dispose` 组合不可用，见报告）：
 *   npx vite build && VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --port 4173 &
 *   E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/adr028-window-sync.e2e.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 落盘目录（P9c 复验沿用 coder 证据包；可用 `ADR028_E2E_OUT` 覆盖）。 */
const OUT = process.env.ADR028_E2E_OUT ?? resolve(REPO, 'coder/evidence/20260920_adr027_p9c_final/raw');

/** E1/E4/E2/M1 目标 run（159776/D1，16 笔 L2、1 个回合；回合区间落在已加载 K 线区间内）。 */
const RUN_ID = process.env.ADR028_E2E_RUN ?? 'sr_1789832477006_000002';
/** E2 部分夹取目标：L2 行下标（该 run 数据末端 31 根之前的成交 bar，span=120 ⇒ 物理上无法居中）。 */
const L2_FILL_IDX = Number(process.env.ADR028_E2E_FILL ?? '7');
/** E2 数据末端目标：L2 行下标（= 本 run 最后一笔成交 = 数据末端 bar ⇒ 完全右夹取）。 */
const L2_END_FILL_IDX = Number(process.env.ADR028_E2E_END_FILL ?? '15');
/** E3 真居中目标 run（159776/D1，5 个回合；回合 #3 落在数据中部 ⇒ 两侧各 ≥60 根可真居中）。 */
const CENTER_RUN_ID = process.env.ADR028_E2E_CENTER_RUN ?? 'sr_1789832517708_000005';
/** E3 目标回合（`l2_count=2`，第 1 行 = 该回合卖出，距数据末端 >60 根）。 */
const CENTER_RT_SEQ = Number(process.env.ADR028_E2E_CENTER_RT ?? '3');
/** E3 目标行下标。 */
const CENTER_ROW = Number(process.env.ADR028_E2E_CENTER_ROW ?? '1');
/** D1 单根 bar 秒数（本规格全部目标 run 均为 D1）。 */
const BAR_SECONDS = 86_400;
/** L1 回合窗口两侧 buffer（根）——`resultWindow.DEFAULT_JUMP_BUFFER_BARS`（ADR-028 D4）。 */
const L1_BUFFER_BARS = 2;
/** L2 跳转窗口根数（`resultWindow.DEFAULT_L2_JUMP_SPAN_BARS`，D4）。 */
const L2_SPAN_BARS = 120;
/** 可见根数容差（根）：barSpace 为整数 + 真身含部分 bar ⇒ 量化残差。 */
const SPAN_TOL = 5;
/** L2 请求跨度的半宽（与生产 `centeredWindow` 同口径：`half = floor((span-1)/2)`）。 */
const L2_HALF_WANT = Math.floor((L2_SPAN_BARS - 1) / 2);
/** 居中容差（根）：barSpace 整数化 + 稀疏 bar ⇒ 允许 1 根量化残差。 */
const CENTER_TOL_BARS = 1;
/**
 * L1 可见根数**上界**的相对系数（G2 防「窗口过宽/取全量」）。
 * 为什么不用“恰好 wantBars + SPAN_TOL”：真身 barSpace 只能取整数，且生产的校准以
 * `getSize().width` 起步、有效绘图宽度可比其大 ~40%（实测 span=18 时可见 26 根，超 44%），
 * 故小跨度下相对残差大；`1.5×` 仍能捕获「窗口取全量/未跟随跳转」类静默失败（实测超 5×）。
 */
const L1_SPAN_UPPER_REL = 1.5;

interface Probe {
  ok: boolean | null;
  rev: number | null;
  requestedBarSpace: number | null;
  barSpace: number | null;
  fromIdx: number | null;
  toIdx: number | null;
  fromTs: number | null;
  toTs: number | null;
  centerIdx: number | null;
  centerTs: number | null;
  observedCenterIdx: number | null;
  observedCenterTs: number | null;
  edgeClamped: boolean;
  error: string;
}

interface StateAttrs {
  source: string;
  rev: number | null;
  fromTs: number | null;
  toTs: number | null;
  spanBars: number | null;
}

interface RoundTripDto {
  rt_seq: number;
  open_ts: number;
  close_ts: number;
  open_bar: number;
  close_bar: number;
  l2_count: number;
}

interface FillDto {
  bar_index: number;
  ts: number;
  side: string;
  rt_seq: number;
}

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function readAttrs(page: Page, testId: string): Promise<Record<string, string>> {
  return page.getByTestId(testId).evaluate((e) =>
    Object.fromEntries(Array.from(e.attributes).map((x) => [x.name, x.value])),
  );
}

async function readProbe(page: Page): Promise<Probe> {
  const a = await readAttrs(page, 'wb-window-probe');
  return {
    ok: a['data-ok'] === '' ? null : a['data-ok'] === 'true',
    rev: num(a['data-rev']),
    requestedBarSpace: num(a['data-requested-bar-space']),
    barSpace: num(a['data-bar-space']),
    fromIdx: num(a['data-from-idx']),
    toIdx: num(a['data-to-idx']),
    fromTs: num(a['data-from-ts']),
    toTs: num(a['data-to-ts']),
    centerIdx: num(a['data-center-idx']),
    centerTs: num(a['data-center-ts']),
    observedCenterIdx: num(a['data-observed-center-idx']),
    observedCenterTs: num(a['data-observed-center-ts']),
    edgeClamped: a['data-edge-clamped'] === 'true',
    error: a['data-error'] ?? '',
  };
}

async function readState(page: Page): Promise<StateAttrs> {
  const a = await readAttrs(page, 'wb-window-state');
  return {
    source: a['data-source'] ?? '',
    rev: num(a['data-rev']),
    fromTs: num(a['data-from-ts']),
    toTs: num(a['data-to-ts']),
    spanBars: num(a['data-span-bars']),
  };
}

/** 各曲线视图 x 定义域（`data-x-domain="from,to"`；`data` = 既有下标轴，未消费窗口）。 */
async function readDomains(page: Page): Promise<Record<string, [number, number] | 'data' | 'ABSENT'>> {
  const out: Record<string, [number, number] | 'data' | 'ABSENT'> = {};
  for (const id of ['wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart']) {
    const loc = page.getByTestId(id);
    if ((await loc.count()) === 0) {
      out[id] = 'ABSENT';
      continue;
    }
    const v = await loc.first().getAttribute('data-x-domain');
    if (!v || v === 'data') out[id] = 'data';
    else {
      const [f, t] = v.split(',').map(Number);
      out[id] = [f ?? NaN, t ?? NaN];
    }
  }
  return out;
}

/** 打开工作台、选中 run、等 K 线**初始装载落定**（否则 jump 与初次 fit 抢时序 ⇒ 结果被覆盖）。 */
async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'kline');
  await page.waitForTimeout(2500);
}

/** 打开某回合的 L2 明细并点该行 `[跳转]`。 */
async function jumpL2(page: Page, rtSeq: number, rowIdx: number): Promise<void> {
  await page.getByTestId(`wb-rt-detail-${rtSeq}`).click();
  const row = page.getByTestId(`wb-l2-row-${rtSeq}-${rowIdx}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${rtSeq}-${rowIdx}`).click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(600);
}

async function roundTrip(page: Page, runId: string, rtSeq = 1): Promise<RoundTripDto> {
  const resp = await page.request.get(`/api/workbench/runs/${runId}/round-trips`);
  expect(resp.ok(), `/round-trips ${runId}`).toBeTruthy();
  const list = ((await resp.json()) as { round_trips?: RoundTripDto[] }).round_trips ?? [];
  const rt = list.find((t) => t.rt_seq === rtSeq);
  expect(rt, `目标 run ${runId} 必须有 rt_seq=${rtSeq} 的 L1 回合`).toBeTruthy();
  return rt!;
}

async function fills(page: Page, runId: string, rtSeq: number): Promise<FillDto[]> {
  const resp = await page.request.get(`/api/workbench/runs/${runId}/round-trips/${rtSeq}/fills?limit=200`);
  expect(resp.ok()).toBeTruthy();
  return ((await resp.json()) as { fills?: FillDto[] }).fills ?? [];
}

/** run 的逐 bar 根数（**数据侧锚点**：`/fills` 的 `bar_index` 与图表 dataList 同空间时，其最大值 = 总数−1）。 */
async function perBarTotal(page: Page, runId: string): Promise<number> {
  const resp = await page.request.get(`/api/workbench/runs/${runId}/bars?kind=per_bar&offset=0&limit=1`);
  expect(resp.ok(), `/bars per_bar ${runId}`).toBeTruthy();
  const total = ((await resp.json()) as { total?: number }).total;
  expect(typeof total, `/bars per_bar ${runId} 必须回 total`).toBe('number');
  return total!;
}

// ─────────────────────────────── 断言集合（单一事实源；变异用例复用） ───────────────────────────────

/**
 * **L1 跳转（E1）**：真身可见窗口 == 回合区间 `[open_bar, close_bar]`（± buffer）——按真身可及口径判定：
 *  1. 真身回执 `ok === true` 且 `error === ''`（`setBarSpace` 未被静默吞掉、定位成功）；
 *  2. 可见窗口**覆盖** `[open_ts, close_ts]`（回合必须看得到 —— 真身不可协商的根本判据）；
 *  3. **共享窗口（页面态）== 真身实测窗口**（ADR-028 §4.1：曲线 x 定义域必须 == K 线可见 ts 区间）；
 *  4. 可见根数 == 回合 bar 根数 + `2×buffer`（± {@link SPAN_TOL}）——**双侧**（下界 + 上界）：
 *     下界保证回合完整可见；上界防「窗口取全量/过宽」仍判过（G2）。
 *     根数取 **bar 索引差**（`close_bar - open_bar + 1`）而非 `(ts 差)/step`：真身 bar 可稀疏
 *     （实测 ~0.73 根/日），ts 反算会把窗口放大 ~40%。
 *  5. **居中**：实测窗口中心 bar 与**目标中心**（回合区间在**真身索引空间**的中点 = 回执 `centerIdx`）
 *     相差 ≤ {@link CENTER_TOL_BARS} 根。回合贴数据边缘而真身无法居中时，此条仍按真身回执判定
 *     （`ok`/`error` 已覆盖「引擎静默吞掉」类失败），不允许跳过。
 */
function l1Mismatches(rt: RoundTripDto, p: Probe, state: StateAttrs): string[] {
  const m: string[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push('真身回执 ok=true', p.ok === true, `ok=${p.ok} error=${JSON.stringify(p.error)}`);
  push('真身回执 error 为空', p.error === '', JSON.stringify(p.error));
  push(
    '可见窗口覆盖回合区间 [open_ts, close_ts]',
    p.fromTs != null && p.toTs != null && p.fromTs <= rt.open_ts && p.toTs >= rt.close_ts,
    `visible=[${p.fromTs}, ${p.toTs}] rt=[${rt.open_ts}, ${rt.close_ts}]`,
  );
  push(
    '共享窗口 == 真身实测窗口（端点精确相等）',
    stateEqualsVisible(p, state),
    `state=[${state.fromTs}, ${state.toTs}] visible=[${p.fromTs}, ${p.toTs}]`,
  );
  const legs = Math.abs(rt.close_bar - rt.open_bar) + 1;
  const wantBars = legs + 2 * L1_BUFFER_BARS;
  const vis = p.fromIdx != null && p.toIdx != null ? p.toIdx - p.fromIdx + 1 : 0;
  push(
    `可见根数 ≥ ${wantBars} − ${SPAN_TOL}（回合完整可见）`,
    p.fromIdx != null && p.toIdx != null && vis >= wantBars - SPAN_TOL,
    `visible=${p.fromIdx}-${p.toIdx}(${vis}) 期望≈${wantBars}（=legs ${legs} + 2×buffer ${L1_BUFFER_BARS}）`,
  );
  push(
    `可见根数 ≤ ceil(${wantBars}×${L1_SPAN_UPPER_REL}) + ${SPAN_TOL}（窗口未过宽：禁「取全量」冒充跳转）`,
    p.fromIdx != null &&
      p.toIdx != null &&
      vis <= Math.ceil(wantBars * L1_SPAN_UPPER_REL) + SPAN_TOL,
    `visible=${p.fromIdx}-${p.toIdx}(${vis}) 期望≈${wantBars}（barSpace=${p.barSpace}）`,
  );
  push(
    `窗口居中：|实测中心 − 目标中心| ≤ ${CENTER_TOL_BARS} 根`,
    p.centerIdx != null &&
      p.observedCenterIdx != null &&
      Math.abs(p.observedCenterIdx - p.centerIdx) <= CENTER_TOL_BARS,
    `centerIdx=${p.centerIdx} observedCenterIdx=${p.observedCenterIdx}`,
  );
  push('窗口来源 = jump', state.source === 'jump', state.source);
  return m;
}

/**
 * **L2 公共判据（E2/E3/M2 复用）**：真身回执成功性 + 目标落在窗内 + 跨度符合请求 + 共享窗口一致。
 *  - 「目标落在窗内」用**图表索引空间**的目标（回执 `centerIdx`，由真身 `nearestIndexByTs` 算出）；
 *    对索引空间与 `/fills.bar_index` 重合的 run（E2）另有**显式锚定断言**（见 E2 用例）。
 *  - 跨度**双侧**断言：下界防「窗口取全量也过」的反向洞（旧版只有 `==span±tol` 但配合居中豁免），
 *    上界防「窗口过宽」静默失败（G2）。
 */
function l2CommonMismatches(fill: FillDto, p: Probe, state: StateAttrs): string[] {
  const m: string[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push('真身回执 ok=true', p.ok === true, `ok=${p.ok} error=${JSON.stringify(p.error)}`);
  push('真身回执 error 为空', p.error === '', JSON.stringify(p.error));
  push(
    '成交 ts 落在可见窗口内',
    p.fromTs != null && p.toTs != null && p.fromTs <= fill.ts && fill.ts <= p.toTs,
    `visible=[${p.fromTs}, ${p.toTs}] fill.ts=${fill.ts}`,
  );
  push(
    '目标 bar 落在可见 [fromIdx, toIdx] 内（用真身中心索引判定）',
    p.fromIdx != null && p.toIdx != null && p.centerIdx != null && p.fromIdx <= p.centerIdx && p.centerIdx <= p.toIdx,
    `visible=${p.fromIdx}-${p.toIdx} centerIdx=${p.centerIdx}`,
  );
  push(
    '可见根数 == ' + L2_SPAN_BARS + '（±' + SPAN_TOL + '）',
    p.fromIdx != null && p.toIdx != null && Math.abs(p.toIdx - p.fromIdx + 1 - L2_SPAN_BARS) <= SPAN_TOL,
    `visible=${p.fromIdx}-${p.toIdx}(${p.fromIdx != null && p.toIdx != null ? p.toIdx - p.fromIdx + 1 : '?'})`,
  );
  push('窗口来源 = jump', state.source === 'jump', state.source);
  push(
    '共享窗口 == 真身实测窗口（端点精确相等）',
    stateEqualsVisible(p, state),
    `state=[${state.fromTs}, ${state.toTs}] visible=[${p.fromTs}, ${p.toTs}]`,
  );
  push(
    '页面态 span_bars == 真身可见根数（窗口事实源一致）',
    p.fromIdx != null && p.toIdx != null && state.spanBars === p.toIdx - p.fromIdx + 1,
    `state.spanBars=${state.spanBars} visible=${p.fromIdx}-${p.toIdx}`,
  );
  return m;
}

/**
 * **L2 真居中判据（E3）**：目标两侧都有足够 bar（数据侧确证 `edge_clamped=false`）⇒ 断言**真居中**：
 *  - `edge_clamped === false`（真身自陈「未被数据边缘夹取」—— 这是「可居中路径**真被跑到**」的证据，
 *    而不是旧版那种「夹取即豁免」的恒真分支）；
 *  - `|实测中心 − 目标| ≤ 1` 根；
 *  - 中心 bar ts == 成交 ts（±1 根）；窗口未贴左缘（`fromIdx ≥ 1`，防「窗口退化成数据头」）。
 */
function l2CenteredMismatches(fill: FillDto, p: Probe, state: StateAttrs): string[] {
  const m = l2CommonMismatches(fill, p, state);
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push(
    '目标未被数据边缘夹取（可居中路径必须被真跑到）',
    p.edgeClamped === false,
    `edgeClamped=${p.edgeClamped}`,
  );
  push(
    `窗口真居中：|实测中心 − 目标| ≤ ${CENTER_TOL_BARS} 根`,
    p.centerIdx != null &&
      p.observedCenterIdx != null &&
      Math.abs(p.observedCenterIdx - p.centerIdx) <= CENTER_TOL_BARS,
    `centerIdx=${p.centerIdx} observedCenterIdx=${p.observedCenterIdx}`,
  );
  push(
    '中心 bar ts == 成交 bar ts（±1 根；真身中心 bar 取自回执，禁 (from_ts+to_ts)/2）',
    p.observedCenterTs != null && Math.abs(p.observedCenterTs - fill.ts) <= BAR_SECONDS,
    `observedCenterTs=${p.observedCenterTs} fill.ts=${fill.ts}`,
  );
  push(
    '窗口未贴数据左缘（fromIdx ≥ 1，防窗口塌到数据头）',
    p.fromIdx != null && p.fromIdx >= 1,
    `fromIdx=${p.fromIdx}`,
  );
  return m;
}

/**
 * **L2 夹取判据（E2）**：目标贴数据末端、请求跨度物理上放不下 ⇒ **把边界条件算出来断言精确期望**，
 * **不做任何豁免**：
 *  1. `目标 + 半宽 > 数据末端`（居中确实被数据末端阻断 —— 边界条件由数据侧算出）；
 *  2. `toIdx === 数据末端`（窗口右缘**恰**钉在数据末端）；
 *  3. `observedCenterIdx === 数据末端 − floor((可见根数−1)/2)`（在该右缘下**做到了最大可居中程度**，
 *     即「夹取后的精确期望值」，而不是「不满足居中就跳过」）。
 * `dataEndIdx` 由**真身数据末端目标**的一次跳转回执给出（见 E2 用例：该目标本身就是数据末端 bar，
 * 其 `toIdx === centerIdx` 自证），不是猜测值。
 */
function l2ClampedMismatches(fill: FillDto, p: Probe, state: StateAttrs, dataEndIdx: number): string[] {
  const m = l2CommonMismatches(fill, p, state);
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push(
    `居中确实被数据末端阻断：目标 ${p.centerIdx} + 半宽 ${L2_HALF_WANT} > 数据末端 ${dataEndIdx}`,
    p.centerIdx != null && p.centerIdx + L2_HALF_WANT > dataEndIdx,
    `centerIdx=${p.centerIdx} halfWant=${L2_HALF_WANT} dataEndIdx=${dataEndIdx}`,
  );
  push(
    '窗口右缘恰在数据末端（精确夹取期望，非豁免）',
    p.toIdx === dataEndIdx,
    `toIdx=${p.toIdx} dataEndIdx=${dataEndIdx}`,
  );
  const vis = p.fromIdx != null && p.toIdx != null ? p.toIdx - p.fromIdx + 1 : 0;
  push(
    '夹取后中心 == 数据末端 − floor((可见根数−1)/2)（最大可居中程度，精确期望值）',
    p.observedCenterIdx === dataEndIdx - Math.floor((vis - 1) / 2),
    `observedCenterIdx=${p.observedCenterIdx} 期望=${dataEndIdx - Math.floor((vis - 1) / 2)}（dataEndIdx=${dataEndIdx} vis=${vis}）`,
  );
  return m;
}

/** 页面窗口（请求态）与真身可见窗口（回执）**端点精确相等**（跳转路径：回执校正后按构造成立）。 */
function stateEqualsVisible(p: Probe, state: StateAttrs): boolean {
  return state.fromTs != null && state.toTs != null && state.fromTs === p.fromTs && state.toTs === p.toTs;
}

/** 各曲线视图 x 定义域 == 共享窗口（D2.1：禁止用数据自身 min/max）。 */
function domainMismatches(
  domains: Record<string, [number, number] | 'data' | 'ABSENT'>,
  from: number,
  to: number,
): string[] {
  const m: string[] = [];
  for (const [id, d] of Object.entries(domains)) {
    if (d === 'ABSENT' || d === 'data') m.push(`曲线视图 ${id} 未消费共享窗口（data-x-domain=${d}）`);
    else if (d[0] !== from || d[1] !== to)
      m.push(`曲线视图 ${id} 定义域 [${d[0]}, ${d[1]}] != 共享窗口 [${from}, ${to}]`);
  }
  return m;
}

// ─────────────────────────────────────────── E1：L1 跳转 ───────────────────────────────────────────

test('E1_L1_jump：真渲染下 [跳转] 后 K 线可见窗口 == 回合区间（± buffer ±1 根）', async ({ page }) => {
  await openRunSettled(page, RUN_ID);
  const rt = await roundTrip(page, RUN_ID);
  await page.getByTestId('wb-rt-jump-1').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-ok', 'true');
  await page.waitForTimeout(600);

  const probe = await readProbe(page);
  const state = await readState(page);
  const domains = await readDomains(page);
  writeJson('e1_l1_jump', { runId: RUN_ID, rt, probe, state, domains });

  const mismatch = [
    ...l1Mismatches(rt, probe, state),
    ...domainMismatches(domains, state.fromTs!, state.toTs!),
  ];
  writeJson('e1_l1_jump_mismatch', { mismatch });
  expect(mismatch, 'L1 跳转真身断言（变异时必须变红）').toEqual([]);
});

// ────────────────────────── E2：L2 跳转（夹取用例：精确 clamp 期望值） ──────────────────────────

test('E2_L2_jump_clamped：贴数据末端的两笔成交 ⇒ 右缘精确钉在数据末端、中心 = 最大可居中程度', async ({ page }) => {
  await openRunSettled(page, RUN_ID);
  const rt = await roundTrip(page, RUN_ID);
  const rows = await fills(page, RUN_ID, rt.rt_seq);
  const total = await perBarTotal(page, RUN_ID);
  const lastBarIdx = total - 1;
  expect(rows.length, 'L2 成交数').toBeGreaterThan(Math.max(L2_FILL_IDX, L2_END_FILL_IDX));
  const fillEnd = rows[L2_END_FILL_IDX]!;
  const fillMid = rows[L2_FILL_IDX]!;

  // 数据侧事实（API 口径）：末端目标必须是本 run 最后一根 bar 上的成交；中段目标不得是末端。
  expect(fillEnd.bar_index, `行 ${L2_END_FILL_IDX} 必须是数据末端 bar（per_bar total=${total}）`).toBe(lastBarIdx);
  expect(fillMid.bar_index, `行 ${L2_FILL_IDX} 不得贴数据末端`).toBeLessThan(lastBarIdx);

  // ① 数据末端目标：窗口右缘必须恰在该 bar（= 数据末端）⇒ 自证「图表索引空间 == bar_index 空间」。
  await jumpL2(page, rt.rt_seq, L2_END_FILL_IDX);
  const probeEnd = await readProbe(page);
  const stateEnd = await readState(page);
  const endAnchor = [
    {
      name: '索引空间锚定：回执 centerIdx == /fills.bar_index（数据末端目标）',
      ok: probeEnd.centerIdx === fillEnd.bar_index,
      detail: `centerIdx=${probeEnd.centerIdx} bar_index=${fillEnd.bar_index}`,
    },
    {
      name: '数据末端目标：窗口右缘 == 目标（toIdx == centerIdx ⇒ 右缘钉在数据末端）',
      ok: probeEnd.toIdx != null && probeEnd.toIdx === probeEnd.centerIdx,
      detail: `toIdx=${probeEnd.toIdx} centerIdx=${probeEnd.centerIdx}`,
    },
  ].filter((x) => !x.ok).map((x) => `${x.name} ‖ ${x.detail}`);
  await expect(probeEnd.ok, `数据末端目标跳转必须成功（error=${probeEnd.error}）`).toBe(true);
  writeJson('e2a_l2_end_target', { runId: RUN_ID, fill: fillEnd, total, probe: probeEnd, state: stateEnd, mismatch: endAnchor });
  expect(endAnchor, '数据末端目标锚定（若图表索引空间变了必须响亮变红，禁止静默放行）').toEqual([]);

  // 数据末端索引由**真身回执**给出（该目标即数据末端 bar）。
  const dataEndIdx = probeEnd.toIdx!;

  // ② 中段目标（距末端 31 根，span=120 ⇒ 物理上无法居中）：断言**精确**夹取期望值。
  await page.getByTestId(`wb-l2-row-${rt.rt_seq}-${L2_FILL_IDX}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${rt.rt_seq}-${L2_FILL_IDX}`).click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(600);
  const probeMid = await readProbe(page);
  const stateMid = await readState(page);
  const domainsMid = await readDomains(page);

  expect(probeMid.centerIdx, '索引空间锚定：回执 centerIdx == /fills.bar_index（中段目标）').toBe(fillMid.bar_index);
  const mismatch = [
    ...l2ClampedMismatches(fillMid, probeMid, stateMid, dataEndIdx),
    ...domainMismatches(domainsMid, stateMid.fromTs!, stateMid.toTs!),
  ];
  writeJson('e2b_l2_clamped_target', {
    runId: RUN_ID, fill: fillMid, dataEndIdx, probe: probeMid, state: stateMid, mismatch,
  });
  expect(mismatch, 'L2 夹取精确期望断言（禁止豁免；变异时必须变红）').toEqual([]);
});

// ────────────────────────── E3：L2 跳转（真居中用例：不贴数据末端） ──────────────────────────

test('E3_L2_jump_centered：目标两侧各有 ≥60 根 ⇒ 窗口必须真居中（edge_clamped=false 路径被真跑到）', async ({ page }) => {
  await openRunSettled(page, CENTER_RUN_ID);
  const rt = await roundTrip(page, CENTER_RUN_ID, CENTER_RT_SEQ);
  const rows = await fills(page, CENTER_RUN_ID, CENTER_RT_SEQ);
  expect(rows.length, `rt ${CENTER_RT_SEQ} 的 L2 成交数`).toBeGreaterThan(CENTER_ROW);
  const fill = rows[CENTER_ROW]!;

  await jumpL2(page, CENTER_RT_SEQ, CENTER_ROW);
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-ok', 'true');
  const probe = await readProbe(page);
  const state = await readState(page);
  const domains = await readDomains(page);
  writeJson('e3_l2_centered', { runId: CENTER_RUN_ID, rt, fill, probe, state, domains });

  const mismatch = [
    ...l2CenteredMismatches(fill, probe, state),
    ...domainMismatches(domains, state.fromTs!, state.toTs!),
  ];
  writeJson('e3_l2_centered_mismatch', { mismatch });
  expect(mismatch, 'L2 真居中断言（无豁免；变异时必须变红）').toEqual([]);
});

// ────────────────────────────────────── E4：全览 + 历史回退 ──────────────────────────────────────

test('E4_reset_back：全览恢复全区间、历史回退恢复跳转窗口（真身）', async ({ page }) => {
  await openRunSettled(page, RUN_ID);
  const rt = await roundTrip(page, RUN_ID);
  const run = await (await page.request.get(`/api/workbench/runs/${RUN_ID}`)).json();
  const fullFrom = Math.floor(Date.parse(run.from_ts) / 1000);
  const fullTo = Math.floor(Date.parse(run.to_ts) / 1000);

  await page.getByTestId('wb-rt-jump-1').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(400);
  const jumped = await readState(page);
  const jumpedProbe = await readProbe(page);

  // 全览 ⇒ 回全区间（页面窗口 = 全区间；各曲线定义域 = 全区间）
  await page.getByTestId('wb-window-reset').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'full');
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-ok', 'true');
  await page.waitForTimeout(400);
  const full = await readState(page);
  const fullProbe = await readProbe(page);
  const fullDomains = await readDomains(page);
  writeJson('e4_reset_back', { runId: RUN_ID, rt, fullFrom, fullTo, jumped, jumpedProbe, full, fullProbe, fullDomains });

  const m: string[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push('全览后窗口态 = full（未显式写窗）', full.source === 'full', full.source);
  push('全览后真身 ok=true', fullProbe.ok === true, `${fullProbe.ok} ${fullProbe.error}`);
  push(
    '全览历史栈 = 2 步（跳转入栈 + 全览入栈；上限 20）',
    (await page.getByTestId('wb-window-history').innerText()).includes('可回退 2 步'),
    await page.getByTestId('wb-window-history').innerText(),
  );
  const fd = domainMismatches(fullDomains, fullFrom, fullTo);
  push('各曲线视图定义域 = run 全区间', fd.length === 0, JSON.stringify(fd));

  // 历史回退 ⇒ 回到跳转窗口（真身再次落到回合区间）
  await page.getByTestId('wb-window-back').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-ok', 'true');
  await page.waitForTimeout(400);
  const back = await readState(page);
  const backProbe = await readProbe(page);
  const backDomains = await readDomains(page);
  writeJson('e4_back', { back, backProbe, backDomains });

  push('回退后真身 ok=true', backProbe.ok === true, `${backProbe.ok} ${backProbe.error}`);
  const bd = domainMismatches(backDomains, back.fromTs!, back.toTs!);
  push('回退后各曲线定义域 = 回退窗口', bd.length === 0, JSON.stringify(bd));
  const bm = l1Mismatches(rt, backProbe, back);
  push('L1 真身判据在回退后仍成立（覆盖 + 双侧根数 + 居中 + 共享窗口一致）', bm.length === 0, JSON.stringify(bm));
  // 回退窗口必须与首次跳转窗口**逐端点相等**（历史栈语义：回到同一窗，不是「随便一个窗」）
  push(
    '回退窗口 == 首次跳转窗口（端点精确相等）',
    back.fromTs === jumped.fromTs && back.toTs === jumped.toTs,
    `back=[${back.fromTs}, ${back.toTs}] jumped=[${jumped.fromTs}, ${jumped.toTs}]`,
  );

  writeJson('e4_reset_back_mismatch', { mismatch: m });
  expect(m, '全览/历史回退真身断言').toEqual([]);
});

// ─────────────────────────────────────── 禁假绿：变异反证 ───────────────────────────────────────

test('M1_mutation_silent_noop：拦截回合区间 ⇒ 原始基线真身断言必须变红（证断言非恒真）', async ({ page }) => {
  const rt = await roundTrip(page, RUN_ID);
  // 变异：把回合区间**收窄**（两侧各内收 20 根）⇒ 跳转窗口随之变小；
  // 用**原始**回合基线断言时，真身窗口必然不再匹配 ⇒ 断言非恒真，且「窗口未生效」类静默失败必被捕获。
  await page.route(/\/api\/workbench\/runs\/[^/]+\/round-trips/, async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as { round_trips?: RoundTripDto[] };
    if (json.round_trips?.[0]) {
      json.round_trips[0].open_ts = rt.open_ts + 20 * BAR_SECONDS;
      json.round_trips[0].close_ts = rt.close_ts - 20 * BAR_SECONDS;
      json.round_trips[0].open_bar = rt.open_bar + 20;
      json.round_trips[0].close_bar = rt.close_bar - 20;
    }
    await route.fulfill({ response: resp, json });
  });

  await openRunSettled(page, RUN_ID);
  await page.getByTestId('wb-rt-jump-1').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(600);

  const probe = await readProbe(page);
  const state = await readState(page);
  // 期望值按**注入的变异**构造（`page.request` 不经 `page.route`，不能回读该路由）
  const mutated: RoundTripDto = {
    ...rt,
    open_ts: rt.open_ts + 20 * BAR_SECONDS,
    close_ts: rt.close_ts - 20 * BAR_SECONDS,
    open_bar: rt.open_bar + 20,
    close_bar: rt.close_bar - 20,
  };
  writeJson('m1_mutation', { original: rt, mutated, probe, state });

  // ① 真身窗口必须随**变异**区间变（证明跳转确实驱动了真身）
  const mutatedMismatch = l1Mismatches(mutated, probe, state);
  writeJson('m1_mutation_mutated_mismatch', { mismatch: mutatedMismatch });
  expect(mutatedMismatch, '窗口必须跟随变异后的回合区间').toEqual([]);

  // ② 用**原始**区间同一套断言 ⇒ 必须非空（否则断言恒真，正向绿无意义）
  const originalMismatch = l1Mismatches(rt, probe, state);
  writeJson('m1_mutation_original_mismatch', { mismatch: originalMismatch });
  expect(originalMismatch.length, '原始基线在变异下必须变红').toBeGreaterThan(0);
});

test('M2_mutation_barspace_only_no_scroll：barSpace 生效但真身滚动被替换为 no-op ⇒ 居中断言必红', async ({ page }) => {
  // 变异载体：真身 klinecharts 实例（`ChartImp`）经 `charts.set(id, chart)` 注册进模块内 `Map`；
  // 这里包一层 `Map.prototype.set` 捕获该实例（形状过滤：同时具备 `scrollToDataIndex`+`setBarSpace`），
  // 在**页面加载后**把 `scrollToDataIndex` 替换成 no-op ⇒ 模拟「只改 barSpace、窗口不滚动」的静默失败。
  await page.addInitScript(() => {
    const w = window as unknown as { __wbCharts?: unknown[]; __wbScrollCalls?: number };
    w.__wbCharts = [];
    w.__wbScrollCalls = 0;
    const orig = Map.prototype.set;
    Map.prototype.set = function (k: unknown, v: unknown) {
      const o = v as { scrollToDataIndex?: unknown; setBarSpace?: unknown } | null;
      if (o && typeof o === 'object' && typeof o['scrollToDataIndex'] === 'function' && typeof o['setBarSpace'] === 'function') {
        w.__wbCharts!.push(v);
      }
      return orig.call(this, k, v);
    };
  });
  await openRunSettled(page, CENTER_RUN_ID);
  const rows = await fills(page, CENTER_RUN_ID, CENTER_RT_SEQ);
  expect(rows.length, `rt ${CENTER_RT_SEQ} 的 L2 成交数`).toBeGreaterThan(1);
  const fill1 = rows[1]!;
  const fill0 = rows[0]!;

  // 基线（未变异）：row1 跳转的**居中**判据为绿 ⇒ 该断言可满足（不是恒红）。
  await jumpL2(page, CENTER_RT_SEQ, 1);
  const baseProbe = await readProbe(page);
  const baseState = await readState(page);
  const baseCentered = l2CenteredMismatches(fill1, baseProbe, baseState);

  // 变异：真身滚动 no-op（barSpace 仍生效）。
  const chartCount = await page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: { scrollToDataIndex?: unknown }[]; __wbScrollCalls?: number };
    let n = 0;
    for (const c of w.__wbCharts ?? []) c.scrollToDataIndex = () => { n += 1; w.__wbScrollCalls = n; };
    return (w.__wbCharts ?? []).length;
  });
  expect(chartCount, '必须捕获到真身图表实例（否则变异无效，本用例失去意义）').toBeGreaterThan(0);

  // 变异后跳**另一个**目标（row0，与该行相距 17 根）：barSpace 会变，但窗口不动 ⇒ 居中判据必红。
  await page.getByTestId(`wb-l2-row-${CENTER_RT_SEQ}-0`).scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${CENTER_RT_SEQ}-0`).click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(600);
  const mutProbe = await readProbe(page);
  const mutState = await readState(page);
  const scrollCalls = await page.evaluate(
    () => (window as unknown as { __wbScrollCalls?: number }).__wbScrollCalls ?? 0,
  );
  const mutMismatch = l2CenteredMismatches(fill0, mutProbe, mutState);
  writeJson('m2_mutation_no_scroll', {
    runId: CENTER_RUN_ID, rtSeq: CENTER_RT_SEQ, fill0, fill1,
    baseCenteredMismatch: baseCentered, baseProbe, baseState,
    mutatedProbe: mutProbe, mutatedState: mutState, scrollCalls, mutatedMismatch: mutMismatch,
  });

  // ① 基线（未变异）该判据为绿：证明断言可满足（否则本用例的红无意义）。
  expect(baseCentered, '未变异基线：L2 居中判据必须为绿').toEqual([]);
  // ② 变异后必须**变红**，且红点落在「居中」上（证有牙）。
  expect(mutMismatch.length, '「只改 barSpace 不滚动」变异下 L2 断言必须变红').toBeGreaterThan(0);
  expect(
    mutMismatch.some((x) => x.includes('居中') || x.includes('夹取')),
    `红点必须落在真身居中断言上；实际 ${JSON.stringify(mutMismatch)}`,
  ).toBe(true);
  // ③ 变异确实是「barSpace 生效、只切掉滚动」：barSpace 有读回值，且生产确实调用过滚动。
  expect(mutProbe.barSpace, '变异下 barSpace 仍生效（证明只切掉了滚动）').not.toBeNull();
  expect(scrollCalls, '生产必须确实调用过 scrollToDataIndex（被 no-op 吞掉）').toBeGreaterThan(0);
  // ④ 变异下窗口**确实没动**（与基线端点相同）：这是静默失败的本体。
  expect(
    mutProbe.fromIdx === baseProbe.fromIdx && mutProbe.toIdx === baseProbe.toIdx,
    `变异下窗口不得移动（基线 [${baseProbe.fromIdx},${baseProbe.toIdx}] 实测 [${mutProbe.fromIdx},${mutProbe.toIdx}]）`,
  ).toBe(true);
});
