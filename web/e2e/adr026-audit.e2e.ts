/**
 * ADR-026 §5 A6：执行完整度审计与口径披露的**真浏览器** E2E（阶段 4 验收）。
 *
 * 契约（冻结）：design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md
 * 事实源：线上 :8081 真实进程 + 真实库（**不读 mock**；冻结基线与阶段 2 实测响应一致）。
 *
 * 覆盖：
 *  1. A3 目标 run 交易明细 Tab：审计摘要（成交合计 N 笔（含期末强平卖出 K 笔）/回合/名义投入/
 *     现金消耗/计划批数/可达轮次/买入成交 M 笔（= 审计 batches_done，与 L1 全口径分别命名）/
 *     未执行挂单）+ 3 条 warning 提示条 + 表头「来源」列 + 历史 run「未记录」；
 *     切「8项绩效」Tab 出现口径注（分母 = 初始资金）与资金投入率。
 *  2. 历史 run（`TradeDetail.reason` 缺字段）：**全部**行的来源列显示「未记录」。
 *  3. 变异反证（禁假绿）：
 *     ① 响应拦截改 `deployed_pct=1.0` / `batches_done=7` / `warnings=[]` ⇒ UI 随之变，
 *        且同一套基线断言此时必须**变红**（断言真绑在数据上）；
 *     ② 页面摘要渲染被注掉（外部源码突变）⇒ `10_baseline_trades` 必须变红（由 runner 脚本执行）。
 *  4. 真浏览器 + 响应注入：`reason=ForceClose` ⇒ 来源列显「期末强平」（标签映射非硬编码）。
 *
 * 写法约定：基线断言集中在 `summaryMismatches()`（**单一事实源**），正向用例断言其为空、
 * 变异用例断言其非空 —— 同一套断言在两边复用，故「绿」不可能来自不绑数据的断言。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT =
  process.env.ADR026_E2E_OUT ?? resolve(REPO, 'tester/evidence/20260919_adr026_e2e_verify/raw/e2e');
const TAG = process.env.ADR026_E2E_TAG ?? 'base';

/** A3 目标 run（518880/D1，dca_baseline + Dca{mode:Equal,tranches:100,interval:1}）。 */
const TARGET = 'sr_1789738328788_000005';
/** 历史 run（33 回合；`trades[*].reason` 缺字段 ⇒ 来源列「未记录」），在运行历史首页内。 */
const LEGACY_MULTI = 'sr_1789282762943_000014';
const LEGACY_MULTI_TRADES = 33;

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

/** 打开工作台并选中 run，等到结果视图与审计摘要（交易明细 Tab 为默认 Tab）上屏。 */
async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select).toBeVisible();
  await select.click();
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
    .locator('[data-testid^="wb-trade-source-"]')
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

  const headers = (await page.getByTestId('wb-trades-table').locator('th').allInnerTexts()).map((s) => s.trim());
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

// ---------------------------------------------------------------- 正向（A6）----

test('10_baseline_trades：目标 run 交易明细 Tab 出审计摘要 + warning 条 + 来源列', async ({ page }) => {
  const obs = attachObservers(page);
  await openRun(page, TARGET);
  await shot(page, '10_trades_tab');
  await shot(page, '10b_trades_tab_fullpage', true);
  await shotEl(page, 'wb-audit-summary', '10c_audit_summary_el');
  await shotEl(page, 'wb-trades-table', '10d_trades_table_el');

  const lines = await summaryLines(page);
  writeJson('10_baseline_trades_lines', lines);

  const mismatch = await summaryMismatches(page);
  writeJson('10_baseline_trades_mismatch', { mismatch });
  expect(mismatch, '审计摘要基线断言（变异时同一集合必须变红）').toEqual([]);

  // 历史 run（该 run 的 trades 无 reason 字段）⇒ 摘要「未记录」而非伪造 0%
  const sources = await sourceCells(page);
  writeJson('10_baseline_trades_sources', { sources });
  expect(sources).toEqual(['未记录']);

  dump('10_baseline_trades', obs, { runId: TARGET, mismatches: mismatch.length });
  expect(obs.consoleErrors, 'console error 清单').toEqual([]);
  expect(obs.pageErrors, '未捕获页面异常').toEqual([]);
});

test('11_baseline_metrics：8项绩效 Tab 出口径注（分母 = 初始资金）+ 资金投入率', async ({ page }) => {
  const obs = attachObservers(page);
  await openRun(page, TARGET);
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

  dump('11_baseline_metrics', obs, { runId: TARGET, mismatches: mismatch.length });
  expect(obs.consoleErrors, 'console error 清单').toEqual([]);
  expect(obs.pageErrors, '未捕获页面异常').toEqual([]);
});

test('12_legacy_sources：历史 run（无 reason 字段）来源列全部「未记录」', async ({ page }) => {
  const obs = attachObservers(page);
  await openRun(page, LEGACY_MULTI);
  await shot(page, '12_legacy_sources');
  await shotEl(page, 'wb-trades-table', '12b_legacy_trades_table_el');

  const sources = await sourceCells(page);
  writeJson('12_legacy_sources', { runId: LEGACY_MULTI, sources });
  expect(sources.length).toBe(LEGACY_MULTI_TRADES);
  expect(new Set(sources)).toEqual(new Set(['未记录']));

  dump('12_legacy_sources_obs', obs, { runId: LEGACY_MULTI, rows: sources.length });
  expect(obs.consoleErrors, 'console error 清单').toEqual([]);
  expect(obs.pageErrors, '未捕获页面异常').toEqual([]);
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
  await openRun(page, TARGET);
  await shot(page, '13_reason_injection');
  await shotEl(page, 'wb-trades-table', '13b_reason_table_el');
  const sources = await sourceCells(page);
  writeJson('13_reason_injection', { runId: TARGET, sources });
  expect(sources[0]).toBe('期末强平');

  dump('13_reason_injection_obs', obs, { runId: TARGET, sources });
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
  await page.getByTestId(`wb-run-select-${TARGET}`).click();
  // 审计失败不得拖垮结果视图（非阻断）：错误态 + 重试按钮，表照常渲染
  await expect(page.getByTestId('wb-audit-error')).toBeVisible();
  const errText = await page.getByTestId('wb-audit-error').innerText();
  expect(errText).toContain('审计加载失败');
  await expect(page.getByTestId('wb-audit-retry')).toBeVisible();
  await expect(page.getByTestId('wb-trades-table')).toBeVisible();
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
  await openRun(page, TARGET);
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

  dump('90_mutation_deployed_obs', obs, { runId: TARGET, mismatch });
});

test('91_mutation_warnings：拦截把 warnings 置空 ⇒ 提示条消失且基线断言变红', async ({ page }) => {
  const obs = attachObservers(page);
  await page.route('**/api/workbench/runs/*/audit*', async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Record<string, unknown>;
    json.warnings = [];
    await route.fulfill({ response: resp, json });
  });
  await openRun(page, TARGET);
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

  dump('91_mutation_warnings_obs', obs, { runId: TARGET, mismatch });
});
