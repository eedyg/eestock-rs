/**
 * ADR-026 §5 A6：执行完整度审计与口径披露的**真浏览器** E2E（阶段 4 验收）。
 *
 * 契约（冻结）：design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md
 * 事实源：线上 :8081 真实进程 + 真实库（**不读 mock**；冻结基线与阶段 2 实测响应一致）。
 *
 * 覆盖：
 *  1. A3 目标 run 交易明细 Tab：审计摘要（成交合计 N 笔（含期末强平卖出 K 笔）/回合/名义投入/
 *     现金消耗/计划批数/可达轮次/买入成交 M 笔（= 审计 batches_done，与 L1 全口径分别命名）/
 *     未执行挂单）+ 3 条 warning 提示条 + 表头「来源」列 + 来源列标签「期末强平」
 *     （**真实**基线 run 的 rt1 `reason=ForceClose` 读数；见下「两条标签如何被钉住」）；
 *     切「8项绩效」Tab 出现口径注（分母 = 初始资金）与资金投入率。
 *  2. 无 `reason` 字段的载荷（`TradeDetail.reason` 缺字段）：**全部**行的来源列显示「未记录」
 *     —— 该形态**不可再生**（后端自 ADR-027 起必然写 `reason`）⇒ 改由**客户端注入**验证（含变异反证）。
 *  3. 变异反证（禁假绿）：
 *     ① 响应拦截改 `deployed_pct=1.0` / `batches_done=7` / `warnings=[]` ⇒ UI 随之变，
 *        且同一套基线断言此时必须**变红**（断言真绑在数据上）；
 *     ② 页面摘要渲染被注掉（外部源码突变）⇒ `10_baseline_trades` 必须变红（由 runner 脚本执行）。
 *  4. 真浏览器 + 响应注入：`reason=ForceClose` ⇒ 来源列显「期末强平」（标签映射非硬编码）。
 *
 * 写法约定：基线断言集中在 `summaryMismatches()`（**单一事实源**），正向用例断言其为空、
 * 变异用例断言其非空 —— 同一套断言在两边复用，故「绿」不可能来自不绑数据的断言。
 *
 * ## 目标 run 的**谓词解析**（ADR-028 §2.10.1 **裁决 3｜规格耐久**；2026-09-25 重锚）
 *
 * 本规格原以**硬编码** `sr_1789738328788_000005` 取靶。实测（2026-09-25，:8081 + 真实库）：
 *  - `GET /api/workbench/runs/sr_1789738328788_000005` → **404**，且**不在** `GET /runs?limit=500`（95 run）内
 *    ⇒ 该 run **行已删除**（与 §2.10.1 的 kline-history 先例「仅被顶出首屏」不同）；
 *  - 逐字段扫描全部 **93** 个 succeeded run 的 `/audit`：满足冻结基线
 *    （`planned_tranches=100 ∧ reachable_batches=43 ∧ batches_done=42 ∧ unexecuted_orders=1 ∧
 *    deployed_pct=0.41398 ∧ cash_consumed_pct=0.41608`）者 **0 个**；
 *  - 历史 run `sr_1789282762943_000014` 同样 404，且**已无 legacy 形态 run**
 *    （93/93 为 `chunked_v1`；`trades[].reason` 为 null 的 **0** 条；`round_trips_open` 全 **0**）。
 *  ⇒ 本文件把「取哪个 run」从**字面量**改为**谓词解析**（`audit`，见 `./adr028RunResolve`）：
 *    解析失败 ⇒ **显式红**（抛错，携扫描证据），**禁**静默换 run / **禁**回退为 `skip`。
 *  ⇒ **审计摘要判据（全部 `expect` 文本与常量）本批一字未改**：`BASE` / `summaryMismatches()` /
 *    `metricsMismatches()` 均保持原样。
 *
 * ## 基线**数据主体**（2026-09-29 补齐）：由 `scripts/seed_adr026_audit_baseline.sh` 保证存在
 *
 * 谓词解析**不创造数据**：2026-09-28 实测 108 个 `D1/succeeded` 候选中满足 `audit` 谓词者 **0 个**
 * （最接近者 rt1 `l2_count=51 ≠ 43`；其余多为 2/4/7/9/37/51/59/101/143）⇒ 规格必红。
 * 被删 run 的完整 config 快照**逐字**存于 `coder/evidence/20260918_sr_trades_strategy_side/raw/11_run_row.txt`，
 * 已由 `scripts/seed_adr026_audit_baseline.sh` **重放**（`from=2026-01-04T16:00:00Z` /
 * `to=2026-09-16T16:00:01Z` 取归档**实际** `from_ts`/`to_ts`，**不用**会被服务端重新 clamp 的
 * `requested_from/requested_to`；区间右端取死值 ⇒ 后补行情**不会**改变读数）。
 * 脚本**幂等**：先按**同一谓词**扫描现存 run ⇒ 命中即复用（不重复提交）；未命中才 POST 并轮询到
 * `succeeded`，随后逐字段核对 `/audit` 与归档 `coder/evidence/20260919_adr026_redeploy/raw/12_audit_resp.json`，
 * 不符 ⇒ 退出 1（显式红，**不静默**）。
 * **本次实测（2026-09-29，:8081 + 真实库）：`sr_1790614578393_000009`**——`/audit` 与归档**逐字段一致**
 * （`cash_consumed_pct=0.41607972080760863`；注：任务书把该值写成 `0.41607972060876086`，与归档不符，
 * **以归档为准**，脚本已按归档值核对），rt1 `l2_count=43` / fills=43（42 Buy + 1 Sell）。
 * **跑本规格前请先跑该脚本**（否则谓词 0 命中 ⇒ 显式红）。
 *
 * ## 来源列的**两条标签**如何被钉住（2026-09-29 架构侧裁决：方案 B）
 *
 * 被删的基线 run 是 **ADR-026 §2.3 / ADR-027 之前的 legacy 形态**（`strategy_run_result.trades[]` 无
 * `reason` 字段）；而**后端自 ADR-027 起必然写 `reason`**（本 run 的 fills/trades `reason='ForceClose'`）
 * ⇒ 经 API 重放的任何 run 都**不可能是** legacy 形态 ⇒「某个**真实** run 的来源列全为『未记录』」这一
 * 数据主体**不可再生**。故两条标签**分侧**承担，避免同一判据被重复覆盖、也避免恒红：
 *  - **「期末强平」**（用例 10，**真实数据**）：断言改为**真实基线 run 的读数** `['期末强平']`，并在
 *    断言**之前**加**前置校验** `round-trips[0].reason === 'ForceClose'`（不满足 ⇒ 明确文案 fail，
 *    禁静默继续）——原判据 `['未记录']` 绑定的 legacy run 已**行删除**且不可再生，保留即为**恒红**。
 *  - **「未记录」**（用例 12，**客户端注入**）：`page.route` 拦截**回合列表端点**（glob 末尾段为
 *    `runs` + 任意 id + `round-trips`；见常量 {@link ROUND_TRIPS_ROUTE}），载荷取
 *    **真实回合载荷去掉 `reason`**（33 回合）⇒ 断言全部「未记录」；**变异反证**：同一载荷改成带
 *    `reason` ⇒ **同一断言必红**（证明断言真绑数据、不是恒真）。
 *    `adr028RunResolve.ts` 的 `legacy` 谓词**保留**为通用解析能力（`adr028RunResolve.test.ts` 继续覆盖），
 *    但**不再被本规格依赖**（本规格内已移除其解析调用）。
 *  判据口径变更登记：原「真实 run 显示『未记录』」→ 新「真实 run 显示『期末强平』+ 注入载荷显示『未记录』」；
 *  决策日期 **2026-09-29**，决策人 = **架构侧**（证据：`…/11_run_row.txt` 的 config 快照 +
 *  `…/12_audit_resp.json` 的冻结读数，见 `coder/report/20260929_adr026_reanchor.md`）。
 *  这是**判据口径变更**，不是「为变绿而放宽」：真实数据侧的断言强度未降（仍逐字段绑读数），
 *  注入侧新增变异反证（原用例 12 无）。
 *
 * ## 证据落盘出口（2026-09-29 修）
 *
 * 默认出口原为 `tester/evidence/20260919_adr026_e2e_verify/raw/e2e`（**已跟踪**目录，71 个已跟踪文件）
 * ⇒ 不带 env 跑一次即覆盖写 **35 个已跟踪文件**（`AGENTS.md`「代理产物与提交纪律」登记的同类事故）。
 * 现默认改为**未跟踪**路径 `web/e2e/artifacts/adr026-audit`（`web/e2e/.gitignore` 已忽略 `artifacts/`；
 * 实测 `git ls-files web/e2e/artifacts` = 0）；`ADR026_E2E_OUT` 环境变量仍可覆盖。
 *
 * `ADR026_E2E_RUN` = **显式覆盖逃生门**（调试/复跑历史靶）：覆盖仍须**现场校验满足谓词**
 * （`assertRunMatchesPredicate`），不满足 ⇒ 同样显式红。
 *
 * ## 「选中靶 run」的窗口无关化（2026-09-29 修，**顺序敏感**修复）
 *
 * 现象（独立复验实测）：本批 ADR-029 e2e 向开发库新建 run 后，本规格 **7/7 红**，但根因不是产品缺陷——
 * UI 运行列表只取 `limit=50&offset=0`（`web/src/features/workbench/store.ts` 的 `runLimit=50`），靶 run
 * 被顶到**下标 57**（库内 185 run）⇒ `wb-run-select-<id>` **根本不渲染** ⇒ 原写法超时。
 * 修法：选中步骤统一走 {@link selectRunById}（**唯一**选中入口）——优先直接找；找不到则有界点产品自带的
 * **「加载更多」**（真实 testid `wb-runs-more`，源码 `web/src/features/workbench/RunList.tsx`：仅 `hasMore`
 * 时渲染、`loadingMore` 时 disabled；每轮等列表**实际变长**，无硬 sleep）；仍找不到 ⇒ 明确文案抛错。
 * 边界：**只**扩展「查找 run」的能力；解析谓词 / `guardResolved` 反硬编码护栏 / 所有断言的期望值与
 * 用例集合**一字未改**，无 skip/only/fixme，无「重试到通过」式柔性重试。
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
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
const OUT =
  process.env.ADR026_E2E_OUT ??
  /** 默认出口 = **未跟踪**目录（见头部「证据落盘出口」）；env `ADR026_E2E_OUT` 仍可覆盖。 */
  resolve(REPO, 'web/e2e/artifacts/adr026-audit');
const TAG = process.env.ADR026_E2E_TAG ?? 'base';

/**
 * **已废除的历史字面量**（**不得**作为目标 run；仅作证据里的反硬编码对照）：
 * 2026-09-25 实测已 404 且不在列表内（行已删除）⇒ 规格 7/7 红的根因。
 * 2026-09-29：其 config 快照已由 `scripts/seed_adr026_audit_baseline.sh` **重放**为新的基线数据主体
 * （见头部「基线数据主体」）；本字面量仍**只作对照**，**不得**回写成靶。
 */
const HISTORICAL_LITERAL = 'sr_1789738328788_000005';
/** 已废除的历史字面量（用例 12 的旧靶，33 回合的 legacy run；实测同 404，且该形态不可再生）。 */
const HISTORICAL_LEGACY_LITERAL = 'sr_1789282762943_000014';
/**
 * 用例 12 的**行数判据**（**原判据原文，未改**）：33 个回合 ⇒ 来源列 33 行全部「未记录」。
 * 2026-09-29 前由「解析到的历史 run」提供；该 run 已行删除且 legacy 形态不可再生
 * （后端自 ADR-027 起必然写 `reason`）⇒ 改由**客户端注入载荷**提供同样 33 行（见用例 12）。
 * **刻意保留 33**：判据强度（精确行数 + 全部同标签）与变更前完全一致。
 */
const LEGACY_MULTI_TRADES = 33;

/** 谓词标签（`./adr028RunResolve` 的**结构性**前提，非「某个 run id」）。 */
const PREDICATE: RunLabel = 'audit';
/**
 * 本规格**不再**解析 `legacy` 谓词（2026-09-29 架构侧裁决）：
 *  - 该形态在当前库**结构性不可满足**（实测全库 0 命中；后端自 ADR-027 起必然写 `reason`，
 *    历史 run 已行删除）⇒ 每跑一次只会往 `RESOLUTION_FAILURES` 里塞一条永远无法消除的记录；
 *  - 用例 12 改用**客户端注入**（数据主体无关），不再依赖该谓词。
 *  `adr028RunResolve.ts` 的 `legacy` 谓词与其单测**保留**（通用解析能力，别的场景可用）。
 */
/** **逃生门（显式覆盖）**：给出具体 run id 时用它；覆盖时仍须现场校验其满足谓词。 */
const OVERRIDE_RUN = process.env.ADR026_E2E_RUN?.trim() || null;
/** 后端身份（进落盘缓存键；防跨构建/跨后端复用同一缓存条目）。 */
const RESOLVE_SOURCE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';

/** 解析结果（`beforeAll` 现场解析一次）；**取不到即在该用例内抛错**（显式红，禁静默换 run / 禁跳过）。
 *
 * 为什么不由 `beforeAll` 抛错：Playwright 在 `beforeAll` 抛错时把后续用例标为 **did not run / skipped**
 * （实测），而本批纪律要求「解析失败 ⇒ **显式红（非 skip）**」⇒ 改为把失败留在本进程，由每个用例的
 * 第一行（`targetRunId()`）自行抛错 ⇒ 报到层面是 **failed**（可计数、不可被 skip 掩盖）。 */
let TARGET_RESOLVED: ResolvedRun | null = null;
let RESOLUTION_FAILURES: string[] = [];
function unresolvable(what: string, label: RunLabel): Error {
  return new Error(
    `[ADR-028 §2.10.1 裁决 3] ${what}未解析（谓词 ${label}）⇒ **显式红**（禁静默换 run / 禁回退为 skip）。` +
      `扫描证据：\n${RESOLUTION_FAILURES.join('\n') || '（无）'}`,
  );
}
function targetRunId(): string {
  if (!TARGET_RESOLVED) throw unresolvable('目标 run', PREDICATE);
  return TARGET_RESOLVED.id;
}

/** `APIRequestContext` → {@link RunFetchPort} 适配器（只读；口径同 `adr028-kline-history`）。 */
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
      const resp = await ctx.get(`/api/workbench/runs/${id}/round-trips?limit=500`);
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

/** 冻结基准（ADR-026 §2.2 示例 + 阶段 2 实测响应；阶段 4 由 :8081 线上端点复核，逐字段相同）。 */
const BASE = {
  /** `/fills` 全口径 = 42 Buy(Policy) + 1 Sell(ForceClose) = 43（ADR-026 §2.4-1「逐笔源 /fills」）。 */
  fillsTotal: 43,
  batchesDone: 42,
  reachableBatches: 43,
  unexecutedOrders: 1,
  plannedTranches: 100,
  deployedPct: '41.40%',
  cashPct: '41.61%',
  roundTrips: 1,
  forceClosed: 1,
  warnings: [
    ['DCA_PLAN_UNDERFILLED', 'warn', '计划 100 批，区间内最多可推进 43 批、已成交 42 批（剩余批次随买入区结束取消）'],
    ['PARTIAL_DEPLOYMENT', 'warn', '名义投入 41.40% 初始资金，年化/回撤/夏普分母仍为初始资金'],
    ['ORDERS_UNEXECUTED', 'info', '1 笔挂单未成交（末根 bar 无次 bar 可执行）'],
  ] as Array<[string, string, string]>,
};

interface Obs {
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
}

function attachObservers(page: Page): Obs {
  const obs: Obs = {
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
  };
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    if (msg.type() === 'error') obs.consoleErrors.push(line);
    if (msg.type() === 'warning') obs.consoleWarnings.push(line);
  });
  page.on('pageerror', (err) => obs.pageErrors.push(String(err)));
  page.on('requestfailed', (req) =>
    obs.failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText ?? 'unknown'}`),
  );
  page.on('response', (res) => {
    if (res.status() >= 400) obs.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  return obs;
}

function dump(name: string, obs: Obs, extra: Record<string, unknown> = {}): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, `${TAG}_${name}.json`),
    JSON.stringify({ tag: TAG, name, ...extra, ...obs }, null, 2),
    'utf8',
  );
}

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${TAG}_${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: resolve(OUT, `${TAG}_${name}.png`), fullPage });
}

/** 元素级截图（审计摘要是内部滚动容器里的一块，视口截图不足以看清文案）。 */
async function shotEl(page: Page, testId: string, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.getByTestId(testId).screenshot({ path: resolve(OUT, `${TAG}_${name}.png`) });
}

// ------------------------------------------------ 选中 run（**窗口无关**；2026-09-29 修）----
/**
 * `wb-run-list` 的**分页事实源**：`web/src/features/workbench/RunList.tsx` 的历史列表**只渲染已加载页**
 * （`web/src/features/workbench/store.ts`：`runLimit = 50`，首屏 `offset=0`），余量靠产品自带的
 * 「加载更多」按钮（下称 {@link RUNS_MORE_TESTID}）逐页**追加**（`loadMoreRuns()` 消费 `has_more`）。
 * ⇒ 只要本轮别的工作流提交了新 run，历史更早的靶 run 就会被顶到第 2 页之后而**根本不渲染**
 * ⇒ 原「`expect(select).toBeVisible()` 等它出现」的写法会**超时假红**（看似产品缺陷，实为**顺序敏感**）。
 * 2026-09-29 实测（:8081 + 真实库）：库内 **185** run，`sr_1790614578393_000009` 落**下标 57**（首屏 50）。
 *
 * 修法**只扩展「查找 run」的能力**（有界翻页），**不软化任何断言**：解析失败仍是显式红、仍禁 skip、
 * 仍禁静默换 run（谓词解析 + `guardResolved` 反硬编码护栏一字未动）。
 */
const RUNS_MORE_TESTID = 'wb-runs-more';
/** 有界轮数上限（每页 50 条；实测 185 run ⇒ 3 页足够，给 20 轮余量）。 */
const LOAD_MORE_MAX_ROUNDS = 20;
/** 单轮「列表必须**实际变长**」的等待上限（消费 `loadingMore` ⇒ patch ⇒ 重渲染；不用硬 sleep）。 */
const LOAD_MORE_WAIT_MS = 10_000;

/** 本进程内「加载更多」实际点击轮数 / `selectRunById` 调用次数（进 stdout 读数 + 收尾汇总）。 */
let LOAD_MORE_CLICKS = 0;
let SELECT_RUN_CALLS = 0;

/** 一轮「加载更多」之后的三种去向：已变长 / 已到底（按钮消失且未变长）/ 既未变长也未到底（超时）。 */
type LoadMoreTick = 'grew' | 'exhausted' | 'timeout';

/** 等**列表实际变长**（或确认已到底）——不用硬 sleep；超时返回 `timeout` 由调用方显式抛错。 */
async function waitLoadMoreTick(page: Page, rows: Locator, before: number): Promise<LoadMoreTick> {
  const deadline = Date.now() + LOAD_MORE_WAIT_MS;
  for (;;) {
    if ((await rows.count()) > before) return 'grew';
    if ((await page.getByTestId(RUNS_MORE_TESTID).count()) === 0) return 'exhausted';
    if (Date.now() > deadline) return 'timeout';
    await page.waitForTimeout(50);
  }
}

/** 找不到 run 的**显式红**错误（携现场读数：已加载行数 / 已点轮数 / 失败原因）。 */
async function runNotFound(page: Page, runId: string, why: string, clicks: number): Promise<Error> {
  const loaded = await page.locator('[data-testid^="wb-run-select-"]').count();
  return new Error(
    `[ADR-026 e2e] 历史列表里找不到 run ${runId} ⇒ **显式红**（禁静默换 run / 禁 skip）。` +
      `原因：${why}；已点「加载更多」${clicks} 轮；当前已加载行数=${loaded}；` +
      `列表底部仍有「${RUNS_MORE_TESTID}」=${(await page.getByTestId(RUNS_MORE_TESTID).count()) > 0}`,
  );
}

/**
 * **窗口无关**地选中列表里的某个 run（本规格**唯一**的选中入口）：
 *  ① 优先直接找 `wb-run-select-<id>`（靶在首屏 ⇒ 零额外点击）；
 *  ② 找不到 ⇒ 有界点产品自带的「加载更多」，每轮等列表**实际变长**后重试（最多 {@link LOAD_MORE_MAX_ROUNDS} 轮）；
 *  ③ 仍找不到（或列表已到底 / 某轮后列表未变长）⇒ 以 {@link runNotFound} 的明确文案**抛错**。
 * 只改「怎么找到 run」，**不改**任何断言的期望值。
 */
async function selectRunById(page: Page, runId: string): Promise<void> {
  SELECT_RUN_CALLS += 1;
  const rows = page.locator('[data-testid^="wb-run-select-"]');
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(rows.first(), '运行历史列表必须至少渲染 1 行').toBeVisible();

  let clicks = 0;
  for (;;) {
    if ((await select.count()) > 0) break;
    if (clicks >= LOAD_MORE_MAX_ROUNDS) {
      throw await runNotFound(page, runId, `已点 ${clicks} 轮「加载更多」仍未见（上限 ${LOAD_MORE_MAX_ROUNDS} 轮）`, clicks);
    }
    const more = page.getByTestId(RUNS_MORE_TESTID);
    if ((await more.count()) === 0) {
      throw await runNotFound(page, runId, '列表已到底（无「加载更多」按钮）', clicks);
    }
    const before = await rows.count();
    await more.scrollIntoViewIfNeeded();
    await more.click(); // disabled（loadingMore）时 Playwright 自带等待
    clicks += 1;
    LOAD_MORE_CLICKS += 1;
    const tick = await waitLoadMoreTick(page, rows, before);
    if (tick === 'timeout') {
      throw await runNotFound(page, runId, `点第 ${clicks} 轮后列表未变长（等待 ${LOAD_MORE_WAIT_MS}ms）`, clicks);
    }
    if (tick === 'exhausted' && (await select.count()) === 0) {
      throw await runNotFound(page, runId, `点第 ${clicks} 轮后列表到底，最后一批仍未含目标`, clicks);
    }
  }
  console.log(`[adr026-audit] selectRunById(${runId})：点「加载更多」${clicks} 轮（本进程累计 ${LOAD_MORE_CLICKS} 轮）`);
  await expect(select).toBeVisible();
  await select.scrollIntoViewIfNeeded();
  await select.click();
}

/** 打开工作台并选中 run，等到结果视图与审计摘要（交易明细 Tab 为默认 Tab）上屏。 */
async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  await selectRunById(page, runId);
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-run-title')).toBeVisible();
  await expect(page.getByTestId('wb-audit-summary')).toBeVisible();
}

/**
 * 摘要三行（L1 精确行 / L2 cash 行 / warnings 文案）。
 * L1 用 XPath 取第一个直接子 div：`warnings` 的文案里也含「名义投入 41.40%（服务端合成）」，
 * 若用整块 innerText 断言会误命中 warning 文案 ⇒ 必须按行断言。
 */
async function summaryLines(page: Page): Promise<{ l1: string; l2: string; warnings: string }> {
  const root = page.getByTestId('wb-audit-summary');
  return {
    l1: (await root.locator('xpath=./div[1]').innerText()).trim(),
    l2: (await root.getByTestId('wb-audit-cash').innerText()).trim(),
    warnings: (await root.innerText()).trim(),
  };
}

/** 来源列全部取值（逐行）。 */
async function sourceCells(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="wb-rt-source-"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
}

/**
 * **单一事实源**：A3 目标 run 的基线断言集合（返回不满足项；空数组 = 全绿）。
 * 正向用例断言 `[]`；变异用例断言非空（⇒ 断言确实绑在数据上，不是恒真）。
 */
async function summaryMismatches(page: Page): Promise<string[]> {
  const m: string[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  const { l1, l2 } = await summaryLines(page);

  push(
    'L1 成交合计（/fills 全口径）= 43 笔（含期末强平卖出 1 笔）',
    l1.includes(`成交合计 ${BASE.fillsTotal} 笔（含期末强平卖出 ${BASE.forceClosed} 笔）`),
    l1,
  );
  push('L1 回合数 = 1', l1.includes(`回合 ${BASE.roundTrips} 条`), l1);
  push('L1 强平合成 = 1', l1.includes(`其中强平合成 ${BASE.forceClosed} 条`), l1);
  push('L1 名义投入 = 41.40%', l1.includes(`名义投入 ${BASE.deployedPct}`), l1);
  push('L1 分母披露', l1.includes('分母 = 初始资金'), l1);
  push('L2 现金消耗（含佣金）= 41.61%', l2.includes(`现金消耗（含佣金）${BASE.cashPct}`), l2);
  push('L2 计划批数 = 100', l2.includes(`计划批数 ${BASE.plannedTranches}`), l2);
  push('L2 可达轮次 = 43', l2.includes(`可达轮次 ${BASE.reachableBatches}`), l2);
  push('L2 买入成交 = 42 笔（= 审计 batches_done，与 L1 全口径分别命名）', l2.includes(`买入成交 ${BASE.batchesDone} 笔`), l2);
  push('L2 未执行挂单 = 1', l2.includes(`未执行挂单 ${BASE.unexecutedOrders}`), l2);
  push('L2 末根 bar 注', l2.includes('末根 bar 无次 bar 可执行'), l2);

  for (const [code, sev, msg] of BASE.warnings) {
    const loc = page.getByTestId(`wb-audit-warning-${code}`);
    const visible = await loc.isVisible().catch(() => false);
    const text = visible ? await loc.innerText() : '';
    push(
      `warning ${code}`,
      visible && text.includes(msg) && text.includes(sev === 'warn' ? '⚠' : 'ℹ'),
      `visible=${visible} text=${JSON.stringify(text)}`,
    );
  }

  const headers = (await page.getByTestId('wb-round-trips-table').locator('th').allInnerTexts()).map((s) => s.trim());
  push('交易明细表头含「来源」', headers.includes('来源'), JSON.stringify(headers));
  return m;
}

/** 8项绩效 Tab 的口径注 + 资金投入率断言集合。 */
async function metricsMismatches(page: Page): Promise<string[]> {
  const m: string[] = [];
  const push = (name: string, ok: boolean, detail: string) => {
    if (!ok) m.push(`${name} ‖ ${detail}`);
  };
  const basis = await page.getByTestId('wb-metrics-basis').innerText();
  const deployed = await page.getByTestId('wb-metrics-deployed').innerText();
  push('口径注含「口径」', basis.includes('口径'), basis);
  push('口径注分母 = 初始资金 ¥100,000', basis.includes('分母 = 初始资金 ¥100,000'), basis);
  push('资金投入率披露', deployed.includes('资金投入率'), deployed);
  push('资金投入率 = 41.40%', deployed.includes(BASE.deployedPct), deployed);
  push('资金占用（含佣金）= 41.61%', deployed.includes(BASE.cashPct), deployed);
  return m;
}

// ---------------------------------------------------------------- 靶 run 解析（裁决 3）----

/**
 * **反硬编码护栏**（裁决 3）：规格实际使用的 run id 必须 == **现场重解析**结果（**不走落盘缓存**）。
 * 把靶改回字面量（硬编码）后，只要该字面量不是谓词命中的最新匹配 ⇒ 本护栏抛错 ⇒ 规格必红。
 */
async function guardResolved(
  ctx: APIRequestContext,
  label: RunLabel,
  usedId: string,
  override: string | null,
): Promise<void> {
  if (override) return; // 覆盖路径已在 beforeAll 校验「满足谓词」（覆盖允许 ≠ 最新命中者）
  const fresh = await resolveRun(runPort(ctx), label, { cacheDir: null, sourceKey: RESOLVE_SOURCE });
  assertResolvedByIdFresh(usedId, fresh, label);
}

/** 现场按谓词解析靶 run（显式覆盖时改为「覆盖 + 现场校验满足谓词」）+ 反硬编码护栏 + 落盘证据。
 *
 * **禁静默换 run**：解析失败记入 `failures`（由每个用例首行合并抛错）。
 * 2026-09-29 起**只解析 `audit`**：用例 12 的数据主体改由客户端注入提供（见头部「两条标签如何被钉住」）。 */
async function resolveTargets(ctx: APIRequestContext): Promise<void> {
  const port = runPort(ctx);
  const failures: string[] = [];
  const attempt = async (label: RunLabel, override: string | null): Promise<ResolvedRun | null> => {
    try {
      return override
        ? await assertRunMatchesPredicate(port, label, override)
        : await resolveRun(port, label, { sourceKey: RESOLVE_SOURCE });
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  TARGET_RESOLVED = await attempt(PREDICATE, OVERRIDE_RUN);
  RESOLUTION_FAILURES = failures;
  writeJson('run_resolution', {
    predicate: PREDICATE,
    overrideRun: OVERRIDE_RUN,
    historicalLiteral: HISTORICAL_LITERAL,
    historicalLegacyLiteral: HISTORICAL_LEGACY_LITERAL,
    target: TARGET_RESOLVED,
    failures,
  });
  if (TARGET_RESOLVED) {
    console.log(`[adr026-audit] 靶 run = ${TARGET_RESOLVED.id}（${OVERRIDE_RUN ? '显式覆盖' : `谓词 ${PREDICATE}`}）`);
  }
  // 反硬编码护栏：现场重解析（关缓存）必须与使用的 id 一致（硬编码 ⇒ 抛错）。
  if (TARGET_RESOLVED) await guardResolved(ctx, PREDICATE, TARGET_RESOLVED.id, OVERRIDE_RUN);
  if (failures.length > 0) {
    // 不在此处抛错：由每个用例首行（`targetRunId()`/`legacyRunId()`）抛 ⇒ 报到层面是 failed（非 skip）。
    writeJson('run_resolution_failures', { failures });
  }
}

test.beforeAll(async ({ request }) => {
  await resolveTargets(request);
});

/** 翻页读数汇总（stdout）：证明「窗口无关」不是靠首屏碰巧命中。 */
test.afterAll(() => {
  console.log(
    `[adr026-audit] 汇总：selectRunById 调用 ${SELECT_RUN_CALLS} 次，共点「加载更多」${LOAD_MORE_CLICKS} 轮`,
  );
});

// ---------------------------------------------------------------- 正向（A6）----

test('10_baseline_trades：目标 run 交易明细 Tab 出审计摘要 + warning 条 + 来源列', async ({ page, request }) => {
  const obs = attachObservers(page);
  await openRun(page, targetRunId());
  await shot(page, '10_trades_tab');
  await shot(page, '10b_trades_tab_fullpage', true);
  await shotEl(page, 'wb-audit-summary', '10c_audit_summary_el');
  await shotEl(page, 'wb-round-trips-table', '10d_trades_table_el');

  const lines = await summaryLines(page);
  writeJson('10_baseline_trades_lines', lines);

  const mismatch = await summaryMismatches(page);
  writeJson('10_baseline_trades_mismatch', { mismatch });
  expect(mismatch, '审计摘要基线断言（变异时同一集合必须变红）').toEqual([]);

  // 来源列：**真实**基线 run 的 rt1 带 `reason='ForceClose'`（ADR-027 之后后端必然写 `reason`）
  // ⇒ 期望值 = 标签映射「期末强平」。**先**做前置校验再断言，避免期望值与数据主体脱钩（禁循环）。
  //
  // 2026-09-29 判据口径变更（架构侧裁决「方案 B」）：原判据 `toEqual(['未记录'])` 绑定的是被删的
  // `sr_1789738328788_000005` —— 它是 **ADR-026 §2.3 / ADR-027 之前的 legacy 形态**（`trades[]` 无
  // `reason` 字段）；该 run 已**行删除**，且**后端自 ADR-027 起必然写 `reason`** ⇒ 经 API 重放的任何 run
  // 都**不可能**再是 legacy 形态 ⇒ 原判据在当前数据下**结构性不可满足**（恒红）。
  // 「缺 `reason` ⇒ 未记录」这一判据**未删除**，改由用例 12 以客户端注入 + 变异反证承担（且更严）。
  const rtResp = await request.get(`/api/workbench/runs/${targetRunId()}/round-trips?limit=500`);
  expect(rtResp.ok(), 'GET /round-trips（前置校验取数）').toBeTruthy();
  const rtBody = (await rtResp.json()) as { round_trips?: RunRoundTrip[] };
  const rt1Reason = rtBody.round_trips?.[0]?.reason ?? null;
  writeJson('10_baseline_trades_rt1_reason', { runId: targetRunId(), rt1Reason });
  expect(
    rt1Reason,
    '前置校验：基线 run 的 round-trips[0].reason 必须是 ForceClose（「期末强平」期望值的唯一依据）',
  ).toBe('ForceClose');

  const sources = await sourceCells(page);
  writeJson('10_baseline_trades_sources', { sources });
  expect(sources).toEqual(['期末强平']);

  dump('10_baseline_trades', obs, { runId: targetRunId(), mismatches: mismatch.length });
  expect(obs.consoleErrors, 'console error 清单').toEqual([]);
  expect(obs.pageErrors, '未捕获页面异常').toEqual([]);
});

test('11_baseline_metrics：8项绩效 Tab 出口径注（分母 = 初始资金）+ 资金投入率', async ({ page }) => {
  const obs = attachObservers(page);
  await openRun(page, targetRunId());
  await page.getByTestId('wb-tab-metrics').click();
  await expect(page.getByTestId('wb-metrics-basis')).toBeVisible();
  await expect(page.getByTestId('wb-metrics-deployed')).toBeVisible();
  await shot(page, '11_metrics_tab');
  await shot(page, '11b_metrics_tab_fullpage', true);
  await shotEl(page, 'wb-metrics-basis', '11c_metrics_basis_el');
  await shotEl(page, 'wb-metrics-deployed', '11d_metrics_deployed_el');

  writeJson('11_baseline_metrics_lines', {
    basis: await page.getByTestId('wb-metrics-basis').innerText(),
    deployed: await page.getByTestId('wb-metrics-deployed').innerText(),
  });

  const mismatch = await metricsMismatches(page);
  writeJson('11_baseline_metrics_mismatch', { mismatch });
  expect(mismatch, '8项绩效口径注/投入率断言').toEqual([]);

  // 表格 8 项齐备（口径注存在的上下文是 8 项绩效表）
  const rows = await page.getByTestId('wb-metrics-table').locator('tr').count();
  expect(rows).toBe(8);

  dump('11_baseline_metrics', obs, { runId: targetRunId(), mismatches: mismatch.length });
  expect(obs.consoleErrors, 'console error 清单').toEqual([]);
  expect(obs.pageErrors, '未捕获页面异常').toEqual([]);
});

/**
 * 用例 12 的**注入拦截点**：回合列表端点（`chunked_v1` run 的 L1 行来自 `/round-trips`，
 * 见 `useRunSeries.ts`：`legacy_single` 才走 `/result.trades`；基线 run 实测 = `chunked_v1`）。
 */
const ROUND_TRIPS_ROUTE = '**/api/workbench/runs/*/round-trips*';
/** 变异用的注入标签（`StopTrigger` ⇒ 「止损」；与「未记录」在 UI 上可判别）。 */
const INJECTED_REASON = 'StopTrigger';

/**
 * **客户端注入**回合列表载荷（不改库、不改后端）：基座 = 目标 run 的**真实** `/round-trips` 响应，
 * 只做两件事：①把唯一回合**克隆**成 {@link LEGACY_MULTI_TRADES} 行（`rt_seq` 1..33，其它字段逐字保留）；
 * ②按 `withReason` 删除/保留 `reason` 字段。
 *
 * 为何只能注入（2026-09-29 架构侧裁决）：本用例要验证的**数据形态**是「`TradeDetail.reason` 缺字段」
 * —— 即 ADR-026 §2.3 / ADR-027 之前的 legacy run。该形态在当前库里：
 *  ① `legacy` 谓词实测**全库 0 命中**（逐 run 扫描：回合全带 `reason` 或回合数 0）；
 *  ② 旧靶 `sr_1789282762943_000014` 已**行删除**（404，且不在 `/runs?limit=500` 内）；
 *  ③ **后端自 ADR-027 起必然写 `reason`** ⇒ 该形态**不可再生**（不可能靠重跑造出来）。
 * ⇒ 「用真实 run 跑出 33 行未记录」在当前数据下**结构性不可满足**；判据本身（全部行标签 = 「未记录」）
 * 与行数判据（33）**一字未改**，只把**数据主体**从「不可再生的历史 run」换成「真实载荷的等价形态」。
 *
 * 另一侧（「期末强平」）仍绑**真实**基线 run 的数据（用例 10 / 13），两侧合计覆盖两个标签。
 */
async function injectRoundTrips(page: Page, opts: { withReason: boolean }): Promise<void> {
  await page.route(ROUND_TRIPS_ROUTE, async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as {
      total?: number;
      has_more?: boolean;
      next_offset?: number | null;
      limit?: number;
      round_trips?: Array<Record<string, unknown>>;
    };
    const base = json.round_trips?.[0];
    if (!base) throw new Error('注入基座缺失：目标 run 的 /round-trips 必须至少 1 个回合（禁凭空造行）');
    json.round_trips = Array.from({ length: LEGACY_MULTI_TRADES }, (_, i) => {
      const row: Record<string, unknown> = { ...base, rt_seq: i + 1 };
      if (opts.withReason) row.reason = INJECTED_REASON;
      else delete row.reason; // 缺字段（legacy 形态）——不是 null，是字段不存在
      return row;
    });
    json.total = LEGACY_MULTI_TRADES;
    json.has_more = false;
    json.next_offset = null;
    json.limit = LEGACY_MULTI_TRADES;
    await route.fulfill({ response: resp, json });
  });
}

/**
 * 用例 12 的**单一事实源**断言（与 `summaryMismatches()` 同口径：正向断言为 `[]`，变异断言非空）。
 * 编码的判据 = **变更前原断言逐条等价**：行数精确 = {@link LEGACY_MULTI_TRADES} ∧ 全部行标签 =「未记录」。
 */
function legacySourceMismatches(sources: string[]): string[] {
  const m: string[] = [];
  if (sources.length !== LEGACY_MULTI_TRADES) m.push(`行数 ${sources.length} ≠ ${LEGACY_MULTI_TRADES}`);
  const labels = [...new Set(sources)];
  if (labels.length !== 1 || labels[0] !== '未记录') {
    m.push(`来源列标签 = ${JSON.stringify(labels)} ≠ ["未记录"]`);
  }
  return m;
}

test('12_legacy_sources：无 reason 字段载荷（客户端注入）来源列全部「未记录」+ 变异反证', async ({ page }) => {
  const obs = attachObservers(page);

  // ① 注入缺 `reason` 的载荷（基于真实回合载荷去字段）⇒ 全部行「未记录」
  await injectRoundTrips(page, { withReason: false });
  await openRun(page, targetRunId());
  await shot(page, '12_legacy_sources');
  await shotEl(page, 'wb-round-trips-table', '12b_legacy_trades_table_el');

  const sources = await sourceCells(page);
  writeJson('12_legacy_sources', { runId: targetRunId(), injected: 'reason 字段不存在', sources });
  expect(sources.length).toBe(LEGACY_MULTI_TRADES);
  expect(new Set(sources)).toEqual(new Set(['未记录']));
  expect(legacySourceMismatches(sources), '注入缺 reason ⇒ 该断言集必须全绿').toEqual([]);

  dump('12_legacy_sources_obs', obs, { runId: targetRunId(), rows: sources.length });
  expect(obs.consoleErrors, 'console error 清单').toEqual([]);
  expect(obs.pageErrors, '未捕获页面异常').toEqual([]);

  // ② **变异反证**（同用例内，禁假绿）：同一拦截点改为**带** `reason` ⇒ 同一断言集必须**变红**。
  //    若上一步的「全部未记录」是恒真断言（不绑数据），这一步会同样绿 ⇒ 本块失败（故本块是鉴别力证明）。
  await page.unroute(ROUND_TRIPS_ROUTE);
  await injectRoundTrips(page, { withReason: true });
  const obs2 = attachObservers(page);
  await openRun(page, targetRunId());
  await shot(page, '12c_mutation_reason');
  await shotEl(page, 'wb-round-trips-table', '12d_mutation_trades_table_el');

  const mutSources = await sourceCells(page);
  const mutMismatch = legacySourceMismatches(mutSources);
  writeJson('12c_mutation_reason', {
    runId: targetRunId(),
    injected: `reason=${INJECTED_REASON}`,
    rows: mutSources.length,
    labels: [...new Set(mutSources)],
  });
  // (a) UI 必须**真的随数据变**（证明注入生效，而不是两次拿到同一载荷）
  expect(new Set(mutSources)).toEqual(new Set(['止损']));
  expect(mutSources.length).toBe(LEGACY_MULTI_TRADES);
  // (b) **同一断言变红**（原断言表达式原样，只加 `.not`）+ 同一断言集此刻必须非空
  expect(new Set(mutSources)).not.toEqual(new Set(['未记录']));
  writeJson('12c_mutation_reason_mismatch', {
    positive: { rows: sources.length, labels: [...new Set(sources)], mismatch: legacySourceMismatches(sources) },
    mutated: { rows: mutSources.length, labels: [...new Set(mutSources)], mismatch: mutMismatch },
    verdict: '同一断言集（行数=33 ∧ 全部行=`未记录`）在带 reason 载荷下不成立 ⇒ 断言真绑数据',
  });
  expect(mutMismatch.length, '变异后同一断言集必须变红').toBeGreaterThan(0);
  expect(mutMismatch.join('\n')).toContain('未记录');

  dump('12c_mutation_reason_obs', obs2, { runId: targetRunId(), rows: mutSources.length });
  expect(obs2.pageErrors, '未捕获页面异常（变异侧）').toEqual([]);
});

test('13_reason_injection：真实浏览器下 reason=ForceClose ⇒ 来源列「期末强平」', async ({ page }) => {
  const obs = attachObservers(page);
  // 响应注入（不改库、不改代码）：给目标 run 的 trades[0] 补一个 reason 字段
  await page.route('**/api/workbench/runs/*/result*', async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as { trades?: Array<Record<string, unknown>> };
    if (json.trades && json.trades.length > 0) json.trades[0]!.reason = 'ForceClose';
    await route.fulfill({ response: resp, json });
  });
  await openRun(page, targetRunId());
  await shot(page, '13_reason_injection');
  await shotEl(page, 'wb-round-trips-table', '13b_reason_table_el');
  const sources = await sourceCells(page);
  writeJson('13_reason_injection', { runId: targetRunId(), sources });
  expect(sources[0]).toBe('期末强平');

  dump('13_reason_injection_obs', obs, { runId: targetRunId(), sources });
  expect(obs.consoleErrors, 'console error 清单').toEqual([]);
});

test('14_control_audit_500：审计端点 500 ⇒ 错误态 + console/网络采集器**非恒空**（采集器对照）', async ({
  page,
}) => {
  const obs = attachObservers(page);
  await page.route('**/api/workbench/runs/*/audit*', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'boom-e2e-control' }),
    }),
  );
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  await selectRunById(page, targetRunId()); // 窗口无关（靶可能在列表第 2 页之后）
  // 审计失败不得拖垮结果视图（非阻断）：错误态 + 重试按钮，表照常渲染
  await expect(page.getByTestId('wb-audit-error')).toBeVisible();
  const errText = await page.getByTestId('wb-audit-error').innerText();
  expect(errText).toContain('审计加载失败');
  await expect(page.getByTestId('wb-audit-retry')).toBeVisible();
  await expect(page.getByTestId('wb-round-trips-table')).toBeVisible();
  await shot(page, '14_control_audit_500');

  // 采集器对照：正向用例里 consoleErrors/httpErrors 为空数组，必须有「非空」的对照才不算假绿
  writeJson('14_control_audit_500_obs', { errText, ...obs });
  expect(obs.httpErrors.join('\n'), 'HTTP ≥400 采集器必须能捕获').toContain('500');
  dump('14_control_audit_500', obs, { errText });
});

// ------------------------------------------------------- 变异反证（禁假绿）----

test('90_mutation_deployed：拦截改 deployed_pct=1.0/batches_done=7 ⇒ UI 随之变且基线断言变红', async ({
  page,
}) => {
  const obs = attachObservers(page);
  await page.route('**/api/workbench/runs/*/audit*', async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Record<string, unknown>;
    json.deployed_pct = 1.0;
    json.deployed_notional = json.capital_basis;
    json.cash_consumed_pct = 1.0;
    json.batches_done = 7;
    await route.fulfill({ response: resp, json });
  });
  await openRun(page, targetRunId());
  await shot(page, '90_mutation_deployed');
  await shotEl(page, 'wb-audit-summary', '90b_mutation_summary_el');

  const { l1, l2, warnings } = await summaryLines(page);
  writeJson('90_mutation_deployed_lines', { l1, l2 });
  // ① UI 必须随数据变（证明摘要不是写死的）
  expect(l1).toContain('名义投入 100.00%');
  expect(l2).toContain('买入成交 7 笔');
  expect(l1).not.toContain('名义投入 41.40%');
  expect(l2).not.toContain('买入成交 42 笔');
  // 注：warnings 文案由**服务端**按当时 deployed_pct 合成，随响应一起下发 ⇒ 拦截只改数字字段时
  // 文案里的「名义投入 41.40%」保持不变（这是数据流的正确表现，故按行断言、不按整块 innerText）。
  expect(warnings).toContain('名义投入 41.40% 初始资金');
  // ② 同一套基线断言此时必须**不成立**（否则断言恒真、正向绿无意义）
  const mismatch = await summaryMismatches(page);
  writeJson('90_mutation_deployed_mismatch', { mismatch });
  expect(mismatch.length, '变异后基线断言必须变红').toBeGreaterThan(0);
  expect(mismatch.join('\n')).toContain('名义投入');
  expect(mismatch.join('\n')).toContain('买入成交');

  dump('90_mutation_deployed_obs', obs, { runId: targetRunId(), mismatch });
});

test('91_mutation_warnings：拦截把 warnings 置空 ⇒ 提示条消失且基线断言变红', async ({ page }) => {
  const obs = attachObservers(page);
  await page.route('**/api/workbench/runs/*/audit*', async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Record<string, unknown>;
    json.warnings = [];
    await route.fulfill({ response: resp, json });
  });
  await openRun(page, targetRunId());
  await shot(page, '91_mutation_warnings');
  await shotEl(page, 'wb-audit-summary', '91b_mutation_summary_el');

  // ① UI 必须变：warnings 容器与 3 条提示条全部消失（摘要仍渲染 = 非阻断）
  await expect(page.getByTestId('wb-audit-warnings')).toHaveCount(0);
  await expect(page.getByTestId('wb-audit-warning-DCA_PLAN_UNDERFILLED')).toHaveCount(0);
  await expect(page.getByTestId('wb-audit-summary')).toBeVisible();
  // ② 同一套基线断言必须变红
  const mismatch = await summaryMismatches(page);
  writeJson('91_mutation_warnings_mismatch', { mismatch });
  expect(mismatch.length, '变异后基线断言必须变红').toBeGreaterThan(0);
  for (const [code] of BASE.warnings) {
    expect(mismatch.join('\n'), `应因 ${code} 缺失而红`).toContain(code);
  }

  dump('91_mutation_warnings_obs', obs, { runId: targetRunId(), mismatch });
});
