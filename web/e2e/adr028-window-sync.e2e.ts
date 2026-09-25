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
import {
  assertResolvedByIdFresh,
  L2_END_FILL_IDX as PRED_L2_END_IDX,
  L2_MID_IDX as PRED_L2_MID_IDX,
  resolveRun,
  type ResolvedRun,
  type RunFetchPort,
  type RunLabel,
  type RunListItem,
  type RunRoundTrip,
} from './adr028RunResolve';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/**
 * **规格内显式预算**（§7.2 修法 ①）：不再依赖 CLI `--timeout`。
 * 动因（独立复验实测）：`d1` 谓词解析在**库增长后**开销 48.8s（`page.request` 150–300ms/次 × 159 次）；
 * 默认 60s 预算会被解析吃穿 ⇒ 报「谓词解析失败 / Test timeout 60000ms exceeded」= **假红**（非断言失败）。
 * 并发解析（{@link resolveRun} 默认 8 路）已把该开销降到 ~7s；本行是**第二道保险**（库/网络再变时仍不假红）。
 */
test.describe.configure({ timeout: 180_000 });
/**
 * 证据落盘目录：**必须落未跟踪目录**（`AGENTS.md`「代理产物与提交纪律」）——历史实测把证据写进
 * 已跟踪的 `coder/evidence/20260920_adr027_p9c_final/raw/` ⇒ 一次验收跑脏 **67 个**已跟踪文件。
 * 可用 `ADR028_E2E_OUT` 覆盖（CI/复验）。
 */
const OUT = process.env.ADR028_E2E_OUT ?? resolve(REPO, 'coder/evidence/20260925_adr028_d10_ruling/raw');

/**
 * **ADR-028 §2.10.1 裁决 3｜规格耐久**：目标 run **一律按谓词解析**（`./adr028RunResolve`），
 * **禁硬编码 run id**（库会增长：实测 93 个 run，新 run 把目标 run 顶出历史列表首屏）。
 * 解析失败 ⇒ 显式红（抛错），禁静默换 run / 禁回退为跳过；{@link guardResolved} 是反硬编码护栏。
 *
 * **已废除的历史字面量**（仅用于「反硬编码」鉴别力自证 `D10P_run_resolution`；**不得**用作目标 run）：
 *  - `d1`     : `sr_1789832477006_000002`（315 根 D1 / 16 笔）
 *  - `center` : `sr_1789832517708_000005`（424 根 D1 / 5 回合）
 *  - `excl`   : `sr_1790267761446_000013`（3436 根 M15）
 */
const HISTORICAL_LITERAL: Record<'d1' | 'center' | 'excl', string> = {
  d1: 'sr_1789832477006_000002',
  center: 'sr_1789832517708_000005',
  excl: 'sr_1790267761446_000013',
};
/** E2 部分夹取目标：L2 行下标（距数据末端 >旧宽，span=120 ⇒ 物理上无法居中；谓词 `d1` 已核对）。 */
const L2_FILL_IDX = PRED_L2_MID_IDX;
/** E2 数据末端目标：L2 行下标（= 数据末根上的成交 ⇒ 完全右夹取；谓词 `d1` 已核对）。 */
const L2_END_FILL_IDX = PRED_L2_END_IDX;
/** E3 目标回合（谓词 `center` 已核对本回合有 ≥2 笔且第 2 笔距两侧各 ≥60 根）。 */
const CENTER_RT_SEQ = 3;
/** E3 目标行下标。 */
const CENTER_ROW = 1;
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

/**
 * 真身探针读数（ADR-028 §2.10 D10 决策 3 拆分后）：
 *  - `applied*` = **申请回执**（`data-applied-*`，写窗那一刻的真身读回；一次性）；
 *  - `live*`    = **当前真身**（`data-live-*`，随 `onVisibleRangeChange` 更新）——窗口一致性判据用**这套**；
 *  - `ok`       = **活体一致性**（含「写窗成功 **且其后未被改写**」）；旧口径把一次性快照当 ok = 假绿。
 *  `fromIdx/fromTs/...`（无前缀）向后兼容旧字段名并**一律读 live**（可见窗口真身）。
 */
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
  appliedOk: boolean | null;
  appliedRequestedBarSpace: number | null;
  /** **生效值**（回执读回）：端点/索引/根数（「申请未被逐值兑现」的对照基准）。 */
  appliedFromTs: number | null;
  appliedToTs: number | null;
  appliedFromIdx: number | null;
  appliedToIdx: number | null;
  appliedError: string;
  liveConsistent: boolean | null;
  liveBarSpace: number | null;
  liveFromTs: number | null;
  liveToTs: number | null;
  liveFromIdx: number | null;
  liveToIdx: number | null;
  liveBars: number | null;
  liveReasons: string;
}

interface StateAttrs {
  source: string;
  rev: number | null;
  fromTs: number | null;
  toTs: number | null;
  spanBars: number | null;
}

/** 当前写窗**申请**（`wb-window-state` 的 `data-cmd-*`）。 */
interface CmdAttrs {
  rev: number | null;
  fromTs: number | null;
  toTs: number | null;
  span: number | null;
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

// ───────────────────── 目标 run：**按谓词解析**（§2.10.1 裁决 3；禁硬编码） ─────────────────────

/** `page.request` → {@link RunFetchPort} 适配器（规格侧唯一取数面；只读）。 */
function runPort(page: Page): RunFetchPort {
  return {
    listRuns: async () => {
      const resp = await page.request.get('/api/workbench/runs?limit=500');
      expect(resp.ok(), 'GET /api/workbench/runs').toBeTruthy();
      return (await resp.json()) as RunListItem[];
    },
    totalBars: (id) => perBarTotal(page, id),
    roundTrips: async (id) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/round-trips?limit=5000`);
      expect(resp.ok(), `GET /round-trips ${id}`).toBeTruthy();
      return ((await resp.json()) as { round_trips?: RunRoundTrip[] }).round_trips ?? [];
    },
    fills: (id, rtSeq) => fills(page, id, rtSeq),
  };
}

/** 解析缓存（每个 worker 一次；`D10P_run_resolution` 会**现场重解析**校验缓存不是「记死的」）。 */
const RESOLVED = new Map<RunLabel, Promise<ResolvedRun>>();
/** 后端身份（进落盘缓存键；防跨构建/跨后端复用同一缓存条目）。 */
const RESOLVE_SOURCE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
function resolved(page: Page, label: RunLabel): Promise<ResolvedRun> {
  const hit = RESOLVED.get(label);
  if (hit) return hit;
  const p = resolveRun(runPort(page), label, { sourceKey: RESOLVE_SOURCE });
  RESOLVED.set(label, p);
  return p;
}

/**
 * **反硬编码护栏**（裁决 3）：规格使用的 run id 必须 == **现场重解析**结果。
 * 把 run id 改回字面量（硬编码）后，只要该字面量不是谓词命中的最新匹配 ⇒ 本护栏抛错 ⇒ 规格必红。
 */
const GUARDED = new Set<string>();
async function guardResolved(page: Page, run: ResolvedRun): Promise<void> {
  const key = `${run.label}#${run.id}`;
  if (GUARDED.has(key)) return;
  // **护栏必须走现场解析（不走落盘缓存）**：否则缓存一旦陈旧，护栏会拿缓存自证缓存 ⇒ 不失灵。
  const fresh = await resolveRun(runPort(page), run.label, { cacheDir: null, sourceKey: RESOLVE_SOURCE });
  assertResolvedByIdFresh(run.id, fresh, run.label);
  GUARDED.add(key);
}

/** 证据里的 run 摘要（**带谓词与解析证据** ⇒ 复核者能回答「解析到什么、为什么」）。 */
function resolution(run: ResolvedRun): Record<string, unknown> {
  return { id: run.id, label: run.label, predicate: run.predicate, totalBars: run.totalBars, rtSeq: run.rtSeq, l2Count: run.l2Count, evidence: run.evidence };
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
  const bool = (v: string | undefined): boolean | null =>
    v == null || v === '' ? null : v === 'true';
  return {
    ok: bool(a['data-ok']),
    rev: num(a['data-applied-rev'] ?? a['data-rev']),
    requestedBarSpace: num(a['data-applied-requested-bar-space'] ?? a['data-requested-bar-space']),
    barSpace: num(a['data-applied-bar-space'] ?? a['data-bar-space']),
    // 真身可见窗口一律取 **live**（不是申请回执；回执是写窗那一刻的一次性快照）
    fromIdx: num(a['data-live-from-idx']),
    toIdx: num(a['data-live-to-idx']),
    fromTs: num(a['data-live-from-ts']),
    toTs: num(a['data-live-to-ts']),
    // 目标中心 / 数据边界夹取属「申请回执」语义（由写窗函数读回算出）
    centerIdx: num(a['data-applied-center-idx'] ?? a['data-center-idx']),
    centerTs: num(a['data-applied-center-ts'] ?? a['data-center-ts']),
    observedCenterIdx: num(a['data-applied-observed-center-idx'] ?? a['data-observed-center-idx']),
    observedCenterTs: num(a['data-applied-observed-center-ts'] ?? a['data-observed-center-ts']),
    edgeClamped: (a['data-applied-edge-clamped'] ?? a['data-edge-clamped']) === 'true',
    error: a['data-applied-error'] ?? a['data-error'] ?? '',
    appliedOk: bool(a['data-applied-ok']),
    appliedRequestedBarSpace: num(a['data-applied-requested-bar-space']),
    appliedFromTs: num(a['data-applied-from-ts']),
    appliedToTs: num(a['data-applied-to-ts']),
    appliedFromIdx: num(a['data-applied-from-idx']),
    appliedToIdx: num(a['data-applied-to-idx']),
    appliedError: a['data-applied-error'] ?? '',
    liveConsistent: bool(a['data-live-consistent']),
    liveBarSpace: num(a['data-live-bar-space']),
    liveFromTs: num(a['data-live-from-ts']),
    liveToTs: num(a['data-live-to-ts']),
    liveFromIdx: num(a['data-live-from-idx']),
    liveToIdx: num(a['data-live-to-idx']),
    liveBars: num(a['data-live-bars']),
    liveReasons: a['data-live-reasons'] ?? '',
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

/** 当前**写窗申请**（`data-cmd-*`）——「申请未被逐值兑现」的对照基准（裁决 1）。 */
async function readCmd(page: Page): Promise<CmdAttrs> {
  const a = await readAttrs(page, 'wb-window-probe');
  return {
    rev: num(a['data-cmd-rev']),
    fromTs: num(a['data-cmd-from-ts']),
    toTs: num(a['data-cmd-to-ts']),
    span: num(a['data-cmd-span']),
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
async function openRunSettled(page: Page, run: ResolvedRun): Promise<void> {
  // 反硬编码护栏（裁决 3）：打开任何 run 之前，先核对它确实来自谓词解析
  await guardResolved(page, run);
  const runId = run.id;
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  // 历史列表**分页**（新 run 会顶掉旧 run 的首屏位置；实测 93 个 run / 首屏 50）⇒ 反复「加载更多」
  // 直到目标 run 出现；否则「运行不在历史列表内」会变成对 DB 内容漂移的假红（2026-09-25 复验实测）。
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
/**
 * **常态判据（§2.10.1 裁决 1，严格版）**：写窗成功 ∧ 活体一致（`data-ok=true`）∧ **`data-live-reasons` 为空**。
 *
 * 为什么可以严格断言（旧版在此处不得不放宽）：`data-ok` 的对照基准已改为**生效值**
 * （`applied.observed.bar_space`）+ **写回后的窗口域**，因此「引擎校准」（L1 初选 12→11、全览 10→9）
 * 与「不可达夹取」**不再**把 `ok` 打成 false —— 它们由 {@link clampStateMismatches} 单独验披露。
 * 于是 `ok=false` 只剩一个含义：**写窗后真身被改写/漂移**（这正是要抓的缺陷信号）。
 */
function steadyMismatches(p: Probe): string[] {
  const m: string[] = [];
  if (p.appliedOk !== true) {
    m.push(`真身回执 applied-ok=true ‖ appliedOk=${p.appliedOk} error=${JSON.stringify(p.appliedError)}`);
  }
  if (p.ok !== true) {
    m.push(`常态必须 data-ok=true（真身 == 生效值 ∧ 可见域 == 写回窗口域）‖ ok=${p.ok} reasons=${JSON.stringify(p.liveReasons)}`);
  }
  if (p.liveReasons !== '') {
    m.push(`常态必须 data-live-reasons 为空 ‖ ${JSON.stringify(p.liveReasons)}`);
  }
  return m;
}

/**
 * **被改写态判据**（§2.10.1 裁决 1 防退化约束）：写窗后真身被改写 ⇒ `data-ok=false` ∧ `reasons` 非空，
 * 且 reason 文案必须落在「**被改写**」一类（**不得**把「校准/夹取」写进 reasons —— 那是 `wb-window-clamped` 的职责）。
 */
function rewrittenMismatches(p: Probe): string[] {
  const m: string[] = [];
  if (p.appliedOk !== true) {
    m.push(`被改写态：写窗当时的回执必须成功 ‖ appliedOk=${p.appliedOk} error=${JSON.stringify(p.appliedError)}`);
  }
  if (p.ok !== false) m.push(`被改写态：data-ok 必须为 false ‖ ok=${p.ok}`);
  if (p.liveReasons.trim() === '') {
    m.push('被改写态：data-live-reasons 必须非空（禁静默）');
  } else {
    if (!p.liveReasons.includes('被改写')) {
      m.push(`被改写态：reason 必须明示「被改写」‖ ${JSON.stringify(p.liveReasons)}`);
    }
    if (p.liveReasons.includes('校准') || p.liveReasons.includes('夹取')) {
      m.push(`被改写态：reason 不得读作「校准/夹取」（两者必须可分）‖ ${JSON.stringify(p.liveReasons)}`);
    }
  }
  return m;
}

/**
 * **钳位/校准态判据（§2.10.1 裁决 1）**：「申请未被逐值兑现」⇔ `wb-window-clamped` 必含 requested/observed
 * 两侧读数；**且不得**因此把 `data-ok` 打成 false（本函数只判披露，`ok` 由 {@link steadyMismatches} 判）。
 *
 * 「是否未被兑现」由**回执两套量**在规格侧独立重算（`data-cmd-*` = 申请、`data-applied-*` = 生效），
 * 不复用披露文本 ⇒ 判据**非恒真**：把披露删掉、或把校准误当改写，两侧都会变红。
 */
function clampStateMismatches(p: Probe, cmd: CmdAttrs, clampedNote: string | null, label: string): string[] {
  const m: string[] = [];
  const bsDiff =
    p.appliedRequestedBarSpace != null && p.barSpace != null && p.appliedRequestedBarSpace !== p.barSpace;
  const obsBars =
    p.appliedFromIdx != null && p.appliedToIdx != null ? p.appliedToIdx - p.appliedFromIdx + 1 : null;
  const spanDiff = cmd.span != null && obsBars != null && Math.abs(obsBars - cmd.span) > 1;
  const endDiff =
    cmd.fromTs != null &&
    cmd.toTs != null &&
    p.appliedFromTs != null &&
    p.appliedToTs != null &&
    (Math.abs(p.appliedFromTs - cmd.fromTs) > BAR_SECONDS || Math.abs(p.appliedToTs - cmd.toTs) > BAR_SECONDS);
  const notFulfilled = bsDiff || spanDiff || endDiff;
  const detail = `bsDiff=${bsDiff}(${p.appliedRequestedBarSpace}→${p.barSpace}) spanDiff=${spanDiff}(申请 ${cmd.span} / 生效 ${obsBars}) endDiff=${endDiff}`;
  if (notFulfilled) {
    if (clampedNote == null || !clampedNote.includes('被钳位')) {
      m.push(`${label}：申请未被逐值兑现（${detail}）⇒ 必须披露 wb-window-clamped ‖ ${JSON.stringify(clampedNote)}`);
    } else {
      if (!/请求/.test(clampedNote) || !/实际/.test(clampedNote)) {
        m.push(`${label}：披露必含 requested/observed 两侧读数 ‖ ${JSON.stringify(clampedNote)}`);
      }
      if (bsDiff && !clampedNote.includes(`barSpace 申请 ${p.appliedRequestedBarSpace} → 生效 ${p.barSpace}`)) {
        m.push(`${label}：barSpace 被校准（${p.appliedRequestedBarSpace}→${p.barSpace}）时披露必含两侧 barSpace ‖ ${JSON.stringify(clampedNote)}`);
      }
    }
  } else if (clampedNote != null) {
    m.push(`${label}：申请已逐值兑现（${detail}）却仍披露钳位 ⇒ 披露失准 ‖ ${JSON.stringify(clampedNote)}`);
  }
  return m;
}

/** 读 `wb-window-clamped` 披露文本（无披露 ⇒ null）。 */
async function readClampedNote(page: Page): Promise<string | null> {
  const loc = page.getByTestId('wb-window-clamped');
  if ((await loc.count()) === 0) return null;
  return (await loc.first().innerText()).trim();
}

function l1Mismatches(rt: RoundTripDto, p: Probe, state: StateAttrs): string[] {
  const m: string[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push('真身回执 applied-ok=true', p.appliedOk === true, `appliedOk=${p.appliedOk} error=${JSON.stringify(p.appliedError)}`);
  push('真身回执 error 为空', p.appliedError === '', JSON.stringify(p.appliedError));
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
  push('真身回执 applied-ok=true', p.appliedOk === true, `appliedOk=${p.appliedOk} error=${JSON.stringify(p.appliedError)}`);
  push('真身回执 error 为空', p.appliedError === '', JSON.stringify(p.appliedError));
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


// ────────────────────────── D10-L：视口锁定（真身 barSpace 真身读回） ──────────────────────────

/** 捕获真身 chart 实例（与轴对齐规格同款手法：patch `Map.prototype.set`，形状过滤）。 */
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

/** 真身读数：barSpace / 可见根数 / 可见 ts 区间（取 dataList 最长者 = 主图）。 */
async function chartTruth(page: Page): Promise<{
  ok: boolean;
  barSpace: number | null;
  fromIdx: number | null;
  toIdx: number | null;
  fromTs: number | null;
  toTs: number | null;
  bars: number | null;
  paneWidth: number | null;
}> {
  return page.evaluate(() => {
    interface ChartLike {
      getDataList?: () => Array<{ timestamp: number }>;
      getVisibleRange?: () => { from: number; to: number };
      getBarSpace?: () => { bar: number };
      getSize?: () => { width: number } | null;
    }
    const w = window as unknown as { __wbCharts?: ChartLike[] };
    const cands = (w.__wbCharts ?? [])
      .map((chart) => ({ chart, n: (chart.getDataList?.() ?? []).length }))
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n);
    const chosen = cands[0];
    if (!chosen) {
      return { ok: false, barSpace: null, fromIdx: null, toIdx: null, fromTs: null, toTs: null, bars: null, paneWidth: null };
    }
    const list = chosen.chart.getDataList!();
    const r = chosen.chart.getVisibleRange!();
    const last = list.length - 1;
    const from = Math.max(0, Math.min(last, Math.round(r.from)));
    const to = Math.max(from, Math.min(last, Math.round(r.to)));
    return {
      ok: true,
      barSpace: chosen.chart.getBarSpace?.()?.bar ?? null,
      fromIdx: from,
      toIdx: to,
      fromTs: Math.floor(list[from]!.timestamp / 1000),
      toTs: Math.floor(list[to]!.timestamp / 1000),
      bars: to - from + 1,
      paneWidth: chosen.chart.getSize?.()?.width ?? null,
    };
  });
}

// ─────────────────────────────────────────── E1：L1 跳转 ───────────────────────────────────────────

test('E1_L1_jump：真渲染下 [跳转] 后 K 线可见窗口 == 回合区间（± buffer ±1 根）；常态 data-ok 严格为真', async ({ page }) => {
  const run = await resolved(page, 'd1');
  await openRunSettled(page, run);
  const rt = await roundTrip(page, run.id);
  await page.getByTestId('wb-rt-jump-1').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-applied-ok', 'true');
  await page.waitForTimeout(600);

  const probe = await readProbe(page);
  const state = await readState(page);
  const cmd = await readCmd(page);
  const domains = await readDomains(page);
  const clampedNote = await readClampedNote(page);
  writeJson('e1_l1_jump', { run: resolution(run), rt, probe, state, cmd, domains, clampedNote });

  const mismatch = [
    ...l1Mismatches(rt, probe, state),
    // §2.10.1 裁决 1：常态**严格** `data-ok=true ∧ reasons=""`（校准/夹取不再踩这个信号）
    ...steadyMismatches(probe),
    // 同一条用例同时覆盖「钳位/校准态」：披露必含 requested/observed，且**不**影响 `ok`
    ...clampStateMismatches(probe, cmd, clampedNote, 'L1 跳转'),
    ...domainMismatches(domains, probe.fromTs!, probe.toTs!),
  ];
  writeJson('e1_l1_jump_mismatch', { mismatch });
  expect(mismatch, 'L1 跳转真身断言（变异时必须变红）').toEqual([]);
});

// ────────────────────────── E2：L2 跳转（夹取用例：精确 clamp 期望值） ──────────────────────────

test('E2_L2_jump_clamped：贴数据末端的两笔成交 ⇒ 右缘精确钉在数据末端、中心 = 最大可居中程度', async ({ page }) => {
  const run = await resolved(page, 'd1');
  await openRunSettled(page, run);
  const rt = await roundTrip(page, run.id);
  const rows = await fills(page, run.id, rt.rt_seq);
  const total = await perBarTotal(page, run.id);
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
  writeJson('e2a_l2_end_target', { run: resolution(run), fill: fillEnd, total, probe: probeEnd, state: stateEnd, mismatch: endAnchor });
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
  const clampedNoteMid = await readClampedNote(page);
  const cmdMid = await readCmd(page);
  const mismatch = [
    ...l2ClampedMismatches(fillMid, probeMid, stateMid, dataEndIdx),
    // §2.10.1 裁决 1：夹取不改判 ok（常态严格）；夹取本身由 wb-window-clamped 披露（含两侧读数）
    ...steadyMismatches(probeMid),
    ...clampStateMismatches(probeMid, cmdMid, clampedNoteMid, 'L2 夹取'),
    ...domainMismatches(domainsMid, probeMid.fromTs!, probeMid.toTs!),
  ];
  writeJson('e2b_l2_clamped_target', {
    run: resolution(run), fill: fillMid, dataEndIdx, probe: probeMid, state: stateMid, cmd: cmdMid, clampedNote: clampedNoteMid, mismatch,
  });
  expect(mismatch, 'L2 夹取精确期望断言（禁止豁免；变异时必须变红）').toEqual([]);
});

// ────────────────────────── E3：L2 跳转（真居中用例：不贴数据末端） ──────────────────────────

test('E3_L2_jump_centered：目标两侧各有 ≥60 根 ⇒ 窗口必须真居中（edge_clamped=false 路径被真跑到）', async ({ page }) => {
  const run = await resolved(page, 'center');
  await openRunSettled(page, run);
  const rt = await roundTrip(page, run.id, CENTER_RT_SEQ);
  const rows = await fills(page, run.id, CENTER_RT_SEQ);
  expect(rows.length, `rt ${CENTER_RT_SEQ} 的 L2 成交数`).toBeGreaterThan(CENTER_ROW);
  const fill = rows[CENTER_ROW]!;

  await jumpL2(page, CENTER_RT_SEQ, CENTER_ROW);
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-applied-ok', 'true');
  const probe = await readProbe(page);
  const state = await readState(page);
  const cmd = await readCmd(page);
  const domains = await readDomains(page);
  const clampedNote = await readClampedNote(page);
  writeJson('e3_l2_centered', { run: resolution(run), rt, fill, probe, state, cmd, domains, clampedNote });

  const mismatch = [
    ...l2CenteredMismatches(fill, probe, state),
    ...steadyMismatches(probe),
    ...clampStateMismatches(probe, cmd, clampedNote, 'L2 真居中'),
    ...domainMismatches(domains, probe.fromTs!, probe.toTs!),
  ];
  writeJson('e3_l2_centered_mismatch', { mismatch });
  expect(mismatch, 'L2 真居中断言（无豁免；变异时必须变红）').toEqual([]);
});

// ────────────────────────────────────── E4：全览 + 历史回退 ──────────────────────────────────────

test('E4_reset_back：全览以**实测可达区间**重建窗口（D10-2 真值写回）、历史回退恢复跳转窗口（真身）', async ({ page }) => {
  const target = await resolved(page, 'd1');
  await openRunSettled(page, target);
  const rt = await roundTrip(page, target.id);
  const runDto = (await (await page.request.get(`/api/workbench/runs/${target.id}`)).json()) as {
    from_ts: string;
    to_ts: string;
  };
  const fullFrom = Math.floor(Date.parse(runDto.from_ts) / 1000);
  const fullTo = Math.floor(Date.parse(runDto.to_ts) / 1000);

  await page.getByTestId('wb-rt-jump-1').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(400);
  const jumped = await readState(page);
  const jumpedProbe = await readProbe(page);

  // 全览 ⇒ 请求全区间，但物理上只能显示可达子区间 ⇒ 以**实测可达区间**写回窗口状态机
  // （ADR-028 §2.10 D10 决策 2；source = reset），使「取数窗口 == 可见域」重新成立
  await page.getByTestId('wb-window-reset').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'reset');
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-applied-ok', 'true');
  await page.waitForTimeout(400);
  const full = await readState(page);
  const fullProbe = await readProbe(page);
  const fullDomains = await readDomains(page);
  const fullClamped = await readClampedNote(page);
  const fullCmd = await readCmd(page);
  const capNote = (await page.getByTestId('wb-window-cap').count()) > 0
    ? (await page.getByTestId('wb-window-cap').first().innerText()).trim()
    : null;
  writeJson('e4_reset_back', {
    run: resolution(target), rt, fullFrom, fullTo, jumped, jumpedProbe, full, fullProbe, fullDomains, fullClamped, capNote,
  });

  const m: string[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  push('全览后窗口态 = reset（D10-2 真值写回：以实测可达区间建立窗口）', full.source === 'reset', full.source);
  push('全览后窗口 == 真身实测可达区间（端点精确相等）', stateEqualsVisible(fullProbe, full), `state=[${full.fromTs}, ${full.toTs}] live=[${fullProbe.fromTs}, ${fullProbe.toTs}]`);
  push(
    '窗口根数 == 真身可见根数（取数窗口 == 可见域；D10-2/D10-4）',
    full.spanBars != null && fullProbe.liveBars != null && full.spanBars === fullProbe.liveBars,
    `spanBars=${full.spanBars} liveBars=${fullProbe.liveBars}`,
  );
  push(
    '全览后物理上限必须披露（wb-window-cap 或 wb-window-clamped 至少其一非空）',
    capNote != null || fullClamped != null,
    `cap=${JSON.stringify(capNote)} clamped=${JSON.stringify(fullClamped)}`,
  );
  push('全览后写窗回执 applied-ok=true', fullProbe.appliedOk === true, `${fullProbe.appliedOk} ${fullProbe.appliedError}`);
  // §2.10.1 裁决 1：全览（请求全区间而物理上不可达）属**钳位/校准** ⇒ 只披露、**不**改判 ok
  const steadyFull = steadyMismatches(fullProbe);
  push('全览后常态严格：data-ok=true ∧ reasons=""（校准/夹取不得踩 ok）', steadyFull.length === 0, JSON.stringify(steadyFull));
  const clampFull = clampStateMismatches(fullProbe, fullCmd, fullClamped, '全览');
  push('全览：申请未被逐值兑现 ⇒ 披露含 requested/observed（且不因此判 ok=false）', clampFull.length === 0, JSON.stringify(clampFull));
  push(
    '全览历史栈 = 2 步（跳转入栈 + 全览入栈；上限 20）',
    (await page.getByTestId('wb-window-history').innerText()).includes('可回退 2 步'),
    await page.getByTestId('wb-window-history').innerText(),
  );
  const fd = domainMismatches(fullDomains, fullProbe.fromTs!, fullProbe.toTs!);
  push('各曲线视图定义域 = 真身可达区间（不是 run 名义全区间）', fd.length === 0, JSON.stringify(fd));

  // 历史回退 ⇒ 回到跳转窗口（真身再次落到回合区间）
  await page.getByTestId('wb-window-back').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-applied-ok', 'true');
  await page.waitForTimeout(400);
  const back = await readState(page);
  const backProbe = await readProbe(page);
  const backDomains = await readDomains(page);
  const backClamped = await readClampedNote(page);
  const backCmd = await readCmd(page);
  writeJson('e4_back', { back, backProbe, backCmd, backClamped, backDomains });
  push('回退后写窗回执 applied-ok=true', backProbe.appliedOk === true, `${backProbe.appliedOk} ${backProbe.appliedError}`);
  const bwo = [...steadyMismatches(backProbe), ...clampStateMismatches(backProbe, backCmd, backClamped, '回退')];
  push('回退后常态严格（data-ok=true ∧ reasons=""）且钳位披露准确', bwo.length === 0, JSON.stringify(bwo));
  const bd = domainMismatches(backDomains, backProbe.fromTs!, backProbe.toTs!);
  push('回退后各曲线定义域 = 回退窗口（真身）', bd.length === 0, JSON.stringify(bd));
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



// ──────────────── D10-E：消除剔除（曲线取数与 x 域同源；D10 决策 4）────────────────

test('D10E_no_exclusion：跳转/全览后曲线剔除率 0、各卡顶点数 == 真身可见根数、定义域 == 真身可见 ts 区间', async ({ page }) => {
  test.setTimeout(180_000);
  const target = await resolved(page, 'excl');
  const runDto = (await (await page.request.get(`/api/workbench/runs/${target.id}`)).json()) as { period?: string };
  const PERIOD_SEC: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, D1: 86400 };
  const barSeconds = PERIOD_SEC[runDto.period ?? ''] ?? 86400;
  await openRunSettled(page, target);
  // 取**成交最多**的回合（本 run 各回合 l2_count 不等；剔除判据需要目标两侧都有数据）
  const rtResp = await page.request.get(`/api/workbench/runs/${target.id}/round-trips?limit=5000`);
  const rtList = ((await rtResp.json()) as { round_trips?: RoundTripDto[] }).round_trips ?? [];
  expect(rtList.length, '至少一个回合').toBeGreaterThan(0);
  const rt = rtList.slice().sort((a, b) => b.l2_count - a.l2_count)[0]!;
  const rows = await fills(page, target.id, rt.rt_seq);
  expect(rows.length, 'L2 成交数（剔除判据需要目标两侧都有数据）').toBeGreaterThan(1);
  const rowIdx = Math.floor(rows.length / 2);

  const read = () =>
    page.evaluate(() => {
      const cards: Record<string, { vertices: number; unmatched: string | null; domain: string | null }> = {};
      for (const id of ['wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart']) {
        const host = document.querySelector(`[data-testid="${id}"]`);
        const poly = host?.querySelector('svg polyline');
        cards[id] = {
          vertices: (poly?.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean).length,
          unmatched: host?.querySelector('[data-testid="wb-curve-unmatched"]')?.textContent?.trim() ?? null,
          domain: host?.getAttribute('data-x-domain') ?? null,
        };
      }
      return cards;
    });

  const check = async (label: string): Promise<string[]> => {
    const m: string[] = [];
    const probe = await readProbe(page);
    const cards = await read();
    for (const [id, c] of Object.entries(cards)) {
      if (c.unmatched != null && c.unmatched !== '') m.push(`${label}：${id} 存在剔除披露「${c.unmatched}」（D10-4 要求剔除率 0）`);
      if (probe.liveBars != null && c.vertices !== probe.liveBars) {
        m.push(`${label}：${id} 顶点数 ${c.vertices} ≠ 真身可见根数 ${probe.liveBars}（取数窗口必须 == 可见域）`);
      }
      // 定义域（= 窗口写回值）与「此刻真身」：允许 ±1 根 bar 量化容差。
      // **双向强制**（§2.10.1 裁决 2 ②「不一致必披露、禁静默」）：
      //  - 漂移 > 容差 ⇒ **必须** `data-ok=false` ∧ `data-live-reasons` 非空（「被改写/漂移」类文案）；
      //  - 漂移 ≤ 容差 ⇒ **必须** `data-ok=true` ∧ reasons 为空（常态严格；否则本判据可被「恒 false」蒙过）。
      // 实测（前序车道同一 run）：全览后向前分页改变 dataList 左端 ⇒ 写回值与此刻真身差 6 根 = 5400s，
      // 此时 ok=false + reasons 非空（**已披露残差**），而**剔除率仍为 0**（取数窗口与 x 域都取真身）。
      const [df, dt] = (c.domain ?? '').split(',').map(Number);
      const drift = Math.max(Math.abs(df! - probe.liveFromTs!), Math.abs(dt! - probe.liveToTs!));
      if (drift > barSeconds) {
        if (probe.ok !== false || probe.liveReasons.trim() === '') {
          m.push(
            `${label}：${id} 定义域 ${c.domain} 偏离真身可见 ts 区间 [${probe.liveFromTs}, ${probe.liveToTs}] 达 ${drift}s（> 1 根 bar=${barSeconds}s）**未披露**‖ ok=${probe.ok} reasons=${JSON.stringify(probe.liveReasons)}`,
          );
        } else if (!probe.liveReasons.includes('被改写') && !probe.liveReasons.includes('漂移')) {
          m.push(`${label}：${id} 漂移的 reason 必须读作「被改写/漂移」‖ ${JSON.stringify(probe.liveReasons)}`);
        }
      } else if (probe.ok !== true || probe.liveReasons !== '') {
        m.push(
          `${label}：${id} 定义域与真身一致（漂移 ${drift}s ≤ 1 根）却判不一致 ⇒ 常态必须严格 ok=true ∧ reasons="" ‖ ok=${probe.ok} reasons=${JSON.stringify(probe.liveReasons)}`,
        );
      }
    }
    if (probe.liveBars == null || probe.liveBars <= 0) m.push(`${label}：真身可见根数不可读（探针 live 字段缺失）`);
    return m;
  };

  // ① L2 跳转（中部行）
  await page.getByTestId(`wb-rt-detail-${rt.rt_seq}`).click();
  const l2row = page.getByTestId(`wb-l2-row-${rt.rt_seq}-${rowIdx}`);
  await expect(l2row).toBeVisible();
  await l2row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${rt.rt_seq}-${rowIdx}`).click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(900);
  const jumped = await readProbe(page);
  const mJump = await check('L2 跳转');

  // ② 全览（可达根数 ≪ run 全根数 ⇒ 两源错位的最大判别态）
  await page.getByTestId('wb-window-reset').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'reset');
  await page.waitForTimeout(1200);
  const full = await readProbe(page);
  const mFull = await check('全览');

  writeJson('d10e_no_exclusion', { run: resolution(target), rtSeq: rt.rt_seq, rowIdx, jumped, full, mJump, mFull, stateJumped: await readState(page) });
  expect(
    jumped.liveBars != null && full.liveBars != null && full.liveBars !== jumped.liveBars,
    '本用例须覆盖「窗口态变化」两侧（否则剔除判据可能恒真）',
  ).toBe(true);
  expect([...mJump, ...mFull], 'D10-4 消除剔除：跳转/全览两侧都必须 0 剔除且顶点数 == 真身可见根数').toEqual([]);
});

// ────────────────────── D10-L：锁定视口（ADR-028 §2.10 D10 决策 1）──────────────────────

test('D10L_lock：跳转后容器尺寸变化不得重拟合 barSpace（真实主因＝ResizeObserver 16ms 覆盖）；活体读数与真身一致；手势解锁', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(installChartCapture);
  const run = await resolved(page, 'd1');
  await openRunSettled(page, run);
  await page.getByTestId('wb-rt-jump-1').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-applied-ok', 'true');
  await page.waitForTimeout(600);

  const before = await chartTruth(page);
  const probeBefore = await readProbe(page);
  const stateBefore = await readState(page);
  expect(before.ok, '真身 chart 实例必须可读（否则本用例失去意义）').toBe(true);
  expect(before.barSpace, '真身 barSpace 必须有读数').not.toBeNull();
  await expect(page.getByTestId('kline-chart').first()).toHaveAttribute('data-viewport-lock', '1');

  // ① 活体探针 == 真身读数（D10 决策 3 判据 ②）+ 常态严格（§2.10.1 裁决 1：ok 对照生效值）
  expect(steadyMismatches(probeBefore), '跳转后常态：data-ok 必须为 true 且无 reason').toEqual([]);
  expect(probeBefore.liveBarSpace).toBe(before.barSpace);
  expect(probeBefore.liveFromTs).toBe(before.fromTs);
  expect(probeBefore.liveToTs).toBe(before.toTs);
  expect(probeBefore.liveFromIdx).toBe(before.fromIdx);
  expect(probeBefore.liveToIdx).toBe(before.toIdx);

  // ② 容器尺寸变化（真身 ResizeObserver 的唯一输入）：加宽视口 ⇒ 面板变宽
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(1200);
  const after = await chartTruth(page);
  const probeAfter = await readProbe(page);
  const refitWouldBe = after.paneWidth != null ? Math.round(after.paneWidth / 120) : null;
  writeJson('d10l_lock', {
    run: resolution(run), before, after, probeBefore, probeAfter, stateBefore, refitWouldBe,
    locked: await page.getByTestId('kline-chart').first().getAttribute('data-viewport-lock'),
  });
  // 判据自证有牙：若「未锁定时应拟合出的 barSpace」与锁定值相同，本用例无鉴别力 ⇒ 直接红
  expect(
    refitWouldBe,
    `本用例必须有鉴别力：未锁定时拟合值（round(${after.paneWidth}/120)=${refitWouldBe}）必须 ≠ 锁定值 ${before.barSpace}`,
  ).not.toBe(before.barSpace);
  expect(after.barSpace, '锁定期间容器尺寸变化**不得**改写真身 barSpace（D10 决策 1）').toBe(before.barSpace);
  expect(probeAfter.liveBarSpace, '活体探针必须跟随真身').toBe(after.barSpace);
  await expect(page.getByTestId('kline-chart').first()).toHaveAttribute('data-viewport-lock', '1');

  // ③ 真实手势解锁（不得「窗跳不动」）：滚轮缩放 ⇒ 锁定解除，且窗口确实再变
  const box = await page.locator('[data-testid="kline-chart"]').first().boundingBox();
  const cx = Math.min(Math.max((box?.x ?? 0) + (box?.width ?? 600) / 2, 1), 1500);
  const cy = Math.min(Math.max((box?.y ?? 0) + (box?.height ?? 200) / 2, 1), 880);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(600);
  const afterGesture = await chartTruth(page);
  expect(
    await page.getByTestId('kline-chart').first().getAttribute('data-viewport-lock'),
    '真实手势 ⇒ 锁定必须解除（交还视口自主权）',
  ).toBeNull();
  expect(afterGesture.barSpace, '手势后窗口可再变（禁「锁死」）').not.toBe(after.barSpace);
});

test('D10L_reset_writeback：全览以实测可达区间写回窗口（D10 决策 2）且窗口可再变（不锁死）', async ({ page }) => {
  await page.addInitScript(installChartCapture);
  const run = await resolved(page, 'd1');
  await openRunSettled(page, run);
  await page.getByTestId('wb-rt-jump-1').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(400);
  const jumped = await readProbe(page);

  await page.getByTestId('wb-window-reset').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'reset');
  await page.waitForTimeout(700);
  const full = await readProbe(page);
  const fullState = await readState(page);
  const truth = await chartTruth(page);
  writeJson('d10l_reset_writeback', { run: resolution(run), jumped, full, fullState, truth });
  // §2.10.1 裁决 1：跳转/全览两侧都必须**常态严格**为真（校准/夹取不改判 ok）
  expect(steadyMismatches(jumped), '跳转后常态严格').toEqual([]);
  expect(steadyMismatches(full), '全览后常态严格').toEqual([]);

  // 窗口状态机 == 真身可达区间（D10 决策 2）
  expect(fullState.fromTs).toBe(truth.fromTs);
  expect(fullState.toTs).toBe(truth.toTs);
  expect(fullState.spanBars).toBe(truth.bars);
  expect(full.liveBarSpace).toBe(truth.barSpace);
  // 全览后可再变（不锁死）：历史回退恢复跳转窗口
  await page.getByTestId('wb-window-back').click();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
  await page.waitForTimeout(600);
  const back = await readProbe(page);
  expect(back.fromTs, '回退后窗口必须回到跳转窗（≠ 全览可达区间）').not.toBe(fullState.fromTs);
});

// ─────────────────────────────────────── 禁假绿：变异反证 ───────────────────────────────────────

test('M1_mutation_silent_noop：拦截回合区间 ⇒ 原始基线真身断言必须变红（证断言非恒真）', async ({ page }) => {
  const run = await resolved(page, 'd1');
  const rt = await roundTrip(page, run.id);
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

  await openRunSettled(page, run);
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
  const run = await resolved(page, 'center');
  await openRunSettled(page, run);
  const rows = await fills(page, run.id, CENTER_RT_SEQ);
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
    run: resolution(run), rtSeq: CENTER_RT_SEQ, fill0, fill1,
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

// ──────────── D10-R：**被改写构造态**（§2.10.1 裁决 1 的防退化约束） ────────────

/**
 * 真身图表实例**直接写** barSpace（模拟实测到的「程序化跳转后 16ms 被 ResizeObserver 重拟合」：
 * 视口锁定只挡**自动重拟合**，挡不住引擎被外部写入者直接改写 —— 这正是 `data-ok` 要抓的信号）。
 */
async function externalSetBarSpace(page: Page, barSpace: number): Promise<number> {
  return page.evaluate((bs) => {
    interface ChartLike {
      getDataList?: () => Array<{ timestamp: number }>;
      setBarSpace?: (n: number) => void;
      getBarSpace?: () => { bar: number };
    }
    const w = window as unknown as { __wbCharts?: ChartLike[] };
    const cands = (w.__wbCharts ?? [])
      .map((chart) => ({ chart, n: (chart.getDataList?.() ?? []).length }))
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n);
    const chosen = cands[0];
    if (!chosen?.chart.setBarSpace) return -1;
    chosen.chart.setBarSpace(bs);
    return chosen.chart.getBarSpace?.()?.bar ?? -1;
  }, barSpace);
}

test('D10R_rewritten：【构造态】写窗成功 → 其后真身被**外部写入者**改写 ⇒ data-ok=false ∧ reasons 非空（且明示「被改写」，≠校准/夹取）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(installChartCapture);
  const run = await resolved(page, 'd1');
  await openRunSettled(page, run);

  let after: Probe | null = null;
  let stateAfter: StateAttrs | null = null;
  let attempts = 0;
  const trace: Array<Record<string, unknown>> = [];
  // 改写在**写窗的回声抑制窗（400ms）内**完成 ⇒ 窗口状态机不跟随（真身被改写而窗口不动）。
  // 时序若不成立（窗口被 `kline` 手势路径写走）⇒ 本次构造无效，重开一次写窗重试（**不得**把构造失效当断言通过）。
  for (attempts = 1; attempts <= 3 && after == null; attempts++) {
    await page.getByTestId('wb-rt-jump-1').click();
    await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
    await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-applied-ok', 'true');
    const t0 = Date.now();
    const base = await readProbe(page);
    const newBs = (base.barSpace ?? 4) + 3;
    const readBack = await externalSetBarSpace(page, newBs);
    let observed = false;
    try {
      await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-live-bar-space', String(newBs), {
        timeout: 2000,
      });
      observed = true;
    } catch {
      observed = false;
    }
    const candidate = await readProbe(page);
    const st = await readState(page);
    trace.push({
      attempt: attempts, newBs, readBack, observed, mutateDelayMs: Date.now() - t0,
      source: st.source, ok: candidate.ok, liveBarSpace: candidate.liveBarSpace,
      appliedBarSpace: candidate.barSpace, reasons: candidate.liveReasons,
    });
    if (observed && st.source === 'jump') {
      after = candidate;
      stateAfter = st;
    } else {
      await page.waitForTimeout(150);
    }
  }
  writeJson('d10r_rewritten', { run: resolution(run), attempts: trace.length, trace, after, stateAfter });
  expect(
    after,
    `构造失效：${trace.length} 次尝试内未能在写窗抑制窗内完成「外部改写真身 barSpace」‖ trace=${JSON.stringify(trace)}`,
  ).not.toBeNull();
  const mismatch = rewrittenMismatches(after!);
  writeJson('d10r_rewritten_mismatch', { mismatch });
  expect(mismatch, '「写窗成功 → 其后被改写」必须 ok=false ∧ reasons 非空（变异：删掉该信号 ⇒ 本断言必红）').toEqual([]);
  // 反衬：同一时刻「申请回执」仍是成功的（旧快照语义在此恒绿 = 假绿本体）
  expect(after!.appliedOk, '写窗当时的回执必须仍为 true（否则本构造失去意义）').toBe(true);
});

// ──────────── D10-P：**目标 run 谓词解析**（§2.10.1 裁决 3） ────────────

test('D10P_run_resolution：三条谓词各解析到「最新命中者」；现场重解析一致（反硬编码）；解析失败显式红', async ({ page }) => {
  test.setTimeout(180_000);
  const labels: Array<'d1' | 'center' | 'excl'> = ['d1', 'center', 'excl'];
  const out: Record<string, unknown> = {};
  let anyDiffers = 0;
  for (const label of labels) {
    const used = await resolved(page, label);
    // **现场重解析**（显式**不走落盘缓存**）⇒ 核对「规格使用的 run」确实是谓词当前命中的最新匹配
    const fresh = await resolveRun(runPort(page), label, { cacheDir: null, sourceKey: RESOLVE_SOURCE });
    assertResolvedByIdFresh(used.id, fresh, label);
    expect(used.id, `${label}：解析结果必须可复现（最新命中者）`).toBe(fresh.id);
    expect(used.totalBars, `${label}：谓词声明的根数必须与真库一致`).toBe(await perBarTotal(page, used.id));
    const differs = used.id !== HISTORICAL_LITERAL[label];
    if (differs) anyDiffers += 1;
    out[label] = {
      id: used.id,
      predicate: used.predicate,
      totalBars: used.totalBars,
      rtSeq: used.rtSeq,
      l2Count: used.l2Count,
      evidence: used.evidence,
      historicalLiteral: HISTORICAL_LITERAL[label],
      differsFromHistoricalLiteral: differs,
    };
  }
  writeJson('d10p_run_resolution', out);
  // 反硬编码的**鉴别力自证**：至少一族必须解析到「≠ 历史字面量」的 run ⇒
  // 若把 run id 改回字面量，`assertResolvedByIdFresh` 必红（本断言保证该护栏不是空转）。
  expect(
    anyDiffers,
    '至少一族必须解析到不同于历史字面量的 run（否则反硬编码护栏无鉴别力）',
  ).toBeGreaterThan(0);
});
