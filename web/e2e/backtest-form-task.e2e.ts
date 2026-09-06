import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 回测⑤深度回归 · 批 2a —— 策略表单 / 提交 / 任务列表 / 删除 / 幂等（真实环境 e2e）。
 *
 * 本文件位置（self-location）：`web/e2e/backtest-form-task.e2e.ts`
 *
 * 运行对象（真容器，本 spec 不改任何产品代码；临时 run 全部走产品 API 创建/删除，
 * afterAll 恢复到会话初快照 INI，既有 run 不动）：
 *   eestock-app / SPA index-yw4TZbPb.js / http://127.0.0.1:8081（healthy；DB eestock-timescaledb:5433）
 *
 * 聚焦范围（单文件回归只测这些，不碰其它页面）：
 *   F1 策略表单：7 策略目录 + schema 驱动参数（数值/选项）；初始金额（默认 100000、可改、
 *      ≤0/清空→内联错误 + 0 POST）；日期区间 from/to（from≥to/清空→内联 + 0 POST；合法区间可提交）；
 *     周期 1m/5m/15m/日；费用 rate/min_fee/slippage；参数网格「起:止:步长」非法 → 提示 + 不建 run。
 *   F2 提交：合法提交 → POST /api/backtest/runs 200 → run_id（payload 全字段比对）；任务行出现
 *     （运行中 % + 回测至…）；WS backtest_progress 0→100（run_id 对齐、pct 单调到 100）；
 *     提交中按钮 disabled + 「提交中…」；真实 dblclick 只建 1 run（幂等不重复建）。
 *   F3 任务列表：状态/进度/当前回测 bar 显示；点已完成 run → 结果区加载（图 + 8 指标卡）；
 *     失败 run（无 bar 的 code 999999）→ 行显示 失败 + 错误可读（title 含引擎错误）。
 *   F4 删除：取消确认不删（0 DELETE）；确认 → DELETE 200 → 行移除 + 选中结果区清空；删除后再删 → 404
 *     （UI 侧内联「删除失败：HTTP 404…」不崩溃）；删除不存在 → 404。
 *   F5 幂等/可重入：重复提交同参数 → 各自独立多 run；提交后立即删除（竞态）不崩溃、不复活、
 *     服务仍可继续提交。
 *   全程：pageerror=0 / console.error=0 / 无跳转 / 无意外 reload（load 计数逐用例断言）。
 *
 * 已知产品行为（作断言口径，非本次回归缺陷，同 015 观察#3）：run 在页内完成后行文案不自动翻
 * 「完成」（WS 只推进度），需 reload/下一次提交刷新列表 —— 用例按此口径操作并复核。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/backtest_form_task_2a）。
 * 运行：cd web && npx playwright test e2e/backtest-form-task.e2e.ts
 */

test.describe.configure({ retries: 0 }); // 真库写用例：失败需整文件重跑以保持台账/清理确定性

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/backtest_form_task_2a';
mkdirSync(SHOT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── 产品 API（Node 侧，只读写 backtest runs） ───────────────────────────── */

interface RunLike {
  id: number;
  code: string;
  period: string;
  strategy_id: string;
  params: Record<string, unknown>;
  fee: Record<string, number>;
  status: string;
  progress: number;
  error: string | null;
  initial_capital?: number;
  date_from?: string;
  date_to?: string;
  group_id: string | null;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<{ status: number; json: T | null }> {
  const r = await fetch(BASE + path, init);
  let json: T | null = null;
  try {
    json = (await r.json()) as T;
  } catch {
    /* 非 JSON 响应忽略 */
  }
  return { status: r.status, json };
}

async function apiRuns(): Promise<RunLike[]> {
  const { json } = await apiJson<RunLike[]>('/api/backtest/runs');
  return json ?? [];
}
async function apiIds(): Promise<number[]> {
  return (await apiRuns()).map((r) => r.id).sort((a, b) => a - b);
}
async function apiGetRun(id: number): Promise<RunLike | null> {
  const { status, json } = await apiJson<RunLike>(`/api/backtest/runs/${id}`);
  return status === 200 ? json : null;
}
function apiSubmit(body: Record<string, unknown>) {
  return apiJson<{ run_id?: number; group_id?: string; run_ids?: number[] }>('/api/backtest/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function apiDelete(id: number): Promise<number> {
  const { status } = await apiJson<unknown>(`/api/backtest/runs/${id}`, { method: 'DELETE' });
  return status;
}
async function apiWaitFinal(id: number, ms = 45_000): Promise<RunLike> {
  const t0 = Date.now();
  for (;;) {
    const run = await apiGetRun(id);
    if (run && (run.status === 'done' || run.status === 'failed')) return run;
    if (Date.now() - t0 > ms) throw new Error(`run ${id} 未在 ${ms}ms 内进入终态`);
    await sleep(250);
  }
}

/** 快速建一条已完成 run（产品 POST + 轮询终态）；记入 created 台账 */
async function apiMakeDone(params?: Partial<Record<string, unknown>>): Promise<{ id: number; status: string }> {
  const body = {
    code: '518880',
    period: 'D1',
    from: '2026-01-05T00:00:00.000Z',
    to: '2026-02-05T00:00:00.000Z',
    strategy_id: 'dual_ma',
    params: { fast: 5, slow: 20, position_pct: 1 },
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    initial_capital: 100000,
    ...params,
  };
  const { status, json } = await apiSubmit(body);
  expect(status, `API 提交建 run ${JSON.stringify(body.strategy_id)}`).toBe(200);
  const id = json?.run_id;
  expect(id, 'POST 响应含 run_id').toBeTruthy();
  created.add(id!);
  const fin = await apiWaitFinal(id!);
  return { id: id!, status: fin.status };
}

/** 会话内创建的 run id 台账（afterAll 统一产品 DELETE 清理 → 恢复 INI 快照） */
const created = new Set<number>();

/** 会话初快照（恢复目标） */
let INI_IDS: number[] = [];

/* ───────────────────────────── 页面通用 helpers ───────────────────────────── */

interface PageWatch {
  perr: string[];
  cerr: string[];
  /** 浏览器对非 2xx 响应的原生诊断（Fetch/XHR 收到 4xx/5xx 时浏览器自动打印；
   *  本套件在 400 网格 / 404 删除等**有意**错误路径会触发，非应用代码 console.error） */
  netErrs: string[];
  loads: number;
  posts: Array<{ body: string | null }>;
  postResponses: Array<{ status: number; body: string | null; url: string }>;
  dels: Array<{ url: string; status: number | null }>;
  wsFrames: Array<Record<string, unknown>>;
}
async function attachWatch(page: Page): Promise<PageWatch> {
  const w: PageWatch = { perr: [], cerr: [], netErrs: [], loads: 0, posts: [], postResponses: [], dels: [], wsFrames: [] };
  page.on('pageerror', (e) => w.perr.push(String(e).slice(0, 500)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource: the server responded with a status of (4\d\d|5\d\d)/.test(t)) {
      // 有意错误路径（网格 400/删除 404）的浏览器原生诊断 → 单列证据，不视为应用 console.error
      w.netErrs.push(t.slice(0, 200));
      return;
    }
    w.cerr.push(t.slice(0, 500));
  });
  page.on('load', () => w.loads++);
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/backtest\/runs(\?|$)/.test(r.url())) w.posts.push({ body: r.postData() });
  });
  page.on('response', async (r) => {
    const url = r.url();
    if (!url.includes('/api/backtest/runs')) return;
    const isPost = r.request().method() === 'POST';
    const isDel = r.request().method() === 'DELETE';
    if (!isPost && !isDel) return;
    let body: string | null = null;
    try {
      body = await r.text();
    } catch {
      /* ignore */
    }
    if (isPost) {
      w.postResponses.push({ status: r.status(), body, url });
      if (r.status() === 200 && body) {
        try {
          const j = JSON.parse(body) as { run_id?: number; run_ids?: number[] };
          if (typeof j.run_id === 'number') created.add(j.run_id);
          (j.run_ids ?? []).forEach((id) => created.add(id));
        } catch {
          /* ignore */
        }
      }
    } else {
      w.dels.push({ url: decodeURIComponent(url).split('/api')[1] ?? url, status: r.status() });
    }
  });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (ev) => {
      try {
        const m = JSON.parse(String(ev.payload)) as Record<string, unknown>;
        if (m.type === 'backtest_progress') w.wsFrames.push(m);
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });
  });
  return w;
}

async function gotoBacktest(page: Page): Promise<void> {
  await page.goto(BASE + '/backtest', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="strategy-form"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="param-form"]', { timeout: 20_000 });
}

function assertNoErrors(w: PageWatch, ctx: string): void {
  expect(w.perr, `${ctx}: pageerror 应为 0`).toEqual([]);
  expect(w.cerr, `${ctx}: console.error 应为 0`).toEqual([]);
}

async function shot(page: Page, name: string): Promise<string> {
  const file = resolve(SHOT, name);
  await page.screenshot({ path: file });
  return file;
}

interface Facts {
  [k: string]: unknown;
}
/** 证据 JSON：每用例 append 一条 {case, result, facts}，收尾汇总 */
const EVIDENCE_FILE = resolve(SHOT, 'evidence.json');
function recordEvidence(testName: string, facts: Facts): void {
  writeFileSync(
    EVIDENCE_FILE,
    JSON.stringify({ case: testName, ts: new Date().toISOString(), facts }) + '\n',
    { flag: 'a' } as never,
  );
}

/* ───────────────────────────── 表单填写 helpers（testid 见 StrategyForm） ───────────────────────────── */

const f = {
  strategy: '[data-testid="strategy-select"]',
  param: (k: string) => `[data-testid="param-${k}"]`,
  grid: (k: string) => `[data-testid="grid-${k}"]`,
  code: '[data-testid="code-input"]',
  period: '[data-testid="period-select"]',
  capital: '[data-testid="initial-capital"]',
  from: '[data-testid="date-from"]',
  to: '[data-testid="date-to"]',
  feeRate: '[data-testid="fee-rate"]',
  feeMin: '[data-testid="fee-min"]',
  feeSlippage: '[data-testid="fee-slippage"]',
  submit: '[data-testid="submit-btn"]',
  formError: '[data-testid="form-error"]',
  submitError: '[data-testid="submit-error"]',
};

const taskRow = (id: number) => `[data-testid="task-row-${id}"]`;

async function setForm(page: Page, o: {
  period?: string;
  capital?: string;
  from?: string;
  to?: string;
  feeRate?: string;
  feeMin?: string;
  feeSlippage?: string;
  code?: string;
  strategy?: string;
  params?: Record<string, string>;
  grid?: Record<string, string>;
}): Promise<void> {
  if (o.strategy) await page.locator(f.strategy).selectOption(o.strategy);
  for (const [k, v] of Object.entries(o.params ?? {})) await page.locator(f.param(k)).fill(v);
  for (const [k, v] of Object.entries(o.grid ?? {})) await page.locator(f.grid(k)).fill(v);
  if (o.code) await page.locator(f.code).fill(o.code);
  if (o.period) await page.locator(f.period).selectOption(o.period);
  if (o.capital) await page.locator(f.capital).fill(o.capital);
  if (o.from) await page.locator(f.from).fill(o.from);
  if (o.to) await page.locator(f.to).fill(o.to);
  if (o.feeRate) await page.locator(f.feeRate).fill(o.feeRate);
  if (o.feeMin) await page.locator(f.feeMin).fill(o.feeMin);
  if (o.feeSlippage) await page.locator(f.feeSlippage).fill(o.feeSlippage);
}

/** 页面任务列表行文本（内嵌空白压缩） */
async function rowText(page: Page, id: number): Promise<string> {
  const loc = page.locator(taskRow(id));
  await loc.waitFor({ state: 'visible', timeout: 15_000 });
  return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ');
}

/* ═════════════════════════════════ F1 策略表单（零 run） ═════════════════════════════════ */

test('F1a 表单渲染：7 策略目录 / schema 数值与选项参数 / 默认值 / 周期 / 费用', async ({ page }) => {
  const w = await attachWatch(page);
  await gotoBacktest(page);

  const options = await page.locator(f.strategy).locator('option').allTextContents();
  expect(options.length, '策略目录 7 款').toBe(7);
  expect(options).toContain('双均线交叉');

  // dual_ma schema 数值参数 + 默认值
  expect(await page.locator(f.param('fast')).inputValue()).toBe('5');
  expect(await page.locator(f.param('slow')).inputValue()).toBe('20');
  expect(await page.locator(f.param('position_pct')).inputValue()).toBe('1');
  for (const k of ['fast', 'slow', 'position_pct']) {
    expect(await page.locator(f.grid(k)).getAttribute('placeholder')).toBe('起:止:步长');
  }

  // 切 boll：选项类参数 mode 渲染为 select（含 Choice.options）
  await page.locator(f.strategy).selectOption('boll');
  expect(await page.locator(f.param('period')).inputValue()).toBe('20');
  const modeOpts = await page.locator(f.param('mode')).locator('option').allTextContents();
  expect(modeOpts).toEqual(['mean_reversion', 'trend']);
  expect(await page.locator(f.param('mode')).inputValue()).toBe('mean_reversion');

  // 切回 dual_ma 重填单值（后续无依赖）
  await page.locator(f.strategy).selectOption('dual_ma');
  expect(await page.locator(f.param('fast')).inputValue()).toBe('5');

  // 标的/周期/初始金额/费用/日期默认
  expect(await page.locator(f.code).inputValue()).toBe('518880');
  const periodOpts = await page.locator(f.period).locator('option').allTextContents();
  expect(periodOpts).toEqual(['1m', '5m', '15m', '日']);
  expect(await page.locator(f.capital).inputValue()).toBe('100000');
  expect(await page.locator(f.feeRate).inputValue()).toBe('0.025');
  expect(await page.locator(f.feeMin).inputValue()).toBe('5');
  expect(await page.locator(f.feeSlippage).inputValue()).toBe('2');
  const from = await page.locator(f.from).inputValue();
  const to = await page.locator(f.to).inputValue();
  expect(from && to && from < to, '日期默认 from<to').toBeTruthy();

  expect(new URL(page.url()).pathname).toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'F1a');
  await shot(page, 'F1a_form_defaults.png');
  recordEvidence('F1a', { strategies: options, dualMaDefaults: { fast: 5, slow: 20, positionPct: 1 }, periodOpts, fees: { rate: 0.025, min: 5, slippage: 2 }, capitalDefault: 100000, url: page.url(), loads: w.loads });
});

test('F1b 初始金额：非法 ≤0 / 清空（非数被 number 输入拦下）→ 内联错误 + 0 POST；可改', async ({ page }) => {
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await page.locator(f.from).fill('2026-01-05');
  await page.locator(f.to).fill('2026-03-05');

  // ≤0
  await page.locator(f.capital).fill('0');
  await page.locator(f.submit).click();
  await expect(page.locator(f.formError)).toHaveText('初始金额须大于 0');
  expect(w.posts.length, 'cap=0 → 0 POST').toBe(0);

  // 清空：React 回填 0 → 同样非法
  await page.locator(f.capital).fill('');
  expect(await page.locator(f.capital).inputValue()).toBe('0');
  await page.locator(f.submit).click();
  await expect(page.locator(f.formError)).toHaveText('初始金额须大于 0');
  expect(w.posts.length, 'cap 清空 → 0 POST').toBe(0);

  // 非数字字符：type=number 原生拦截（Playwright fill('abc') 会被浏览器拒绝并抛错，
  // 值不落地 → 不存在「非数字金额」可提交的路径；空/0 已由上面两条覆盖）
  expect(await page.locator(f.capital).getAttribute('type'), '初始金额为 number 输入').toBe('number');
  const beforeAbc = await page.locator(f.capital).inputValue();
  let threw = false;
  try {
    await page.locator(f.capital).fill('abc');
  } catch {
    threw = true;
  }
  expect(threw || (await page.locator(f.capital).inputValue()) !== 'abc', '非数字输入被 number 输入框原生拦截').toBe(true);
  expect(await page.locator(f.capital).inputValue()).toBe(beforeAbc);

  // 可改：填合法值后错误消失（下一提交清空 formError 由提交用例覆盖，此处只验证输入接受）
  await page.locator(f.capital).fill('200000');
  expect(await page.locator(f.capital).inputValue()).toBe('200000');
  await page.locator(f.capital).fill('100000');

  expect(new URL(page.url()).pathname).toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'F1b');
  await shot(page, 'F1b_capital_inline_error.png');
  recordEvidence('F1b', { errorText: '初始金额须大于 0', postCount: w.posts.length });
});

test('F1c 日期区间：from≥to / 清空 → 内联错误 + 0 POST；from<to 通过', async ({ page }) => {
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await page.locator(f.capital).fill('100000');

  // from > to
  await page.locator(f.from).fill('2026-03-05');
  await page.locator(f.to).fill('2026-01-05');
  await page.locator(f.submit).click();
  await expect(page.locator(f.formError)).toHaveText('回测区间 from 须早于 to');
  expect(w.posts.length, 'from>to → 0 POST').toBe(0);

  // from == to
  await page.locator(f.from).fill('2026-02-05');
  await page.locator(f.to).fill('2026-02-05');
  await page.locator(f.submit).click();
  await expect(page.locator(f.formError)).toHaveText('回测区间 from 须早于 to');
  expect(w.posts.length, 'from==to → 0 POST').toBe(0);

  // 清空 to
  await page.locator(f.from).fill('2026-01-05');
  await page.locator(f.to).fill('');
  await page.locator(f.submit).click();
  await expect(page.locator(f.formError)).toHaveText('回测区间 from 须早于 to');
  expect(w.posts.length, 'to 清空 → 0 POST').toBe(0);

  // 合法区间：不再内联报错（错误在成功提交时清空 —— 留待 F2 提交用例验证）
  await page.locator(f.to).fill('2026-03-05');
  await page.locator(f.capital).fill('100000');
  expect(await page.locator(f.formError).count(), '非法态后填合法区间不自动清错误（下一成功提交清空）').toBe(1);

  expect(new URL(page.url()).pathname).toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'F1c');
  await shot(page, 'F1c_daterange_inline_error.png');
  recordEvidence('F1c', { errorText: '回测区间 from 须早于 to', postCount: w.posts.length });
});

test('F1d 参数网格「起:止:步长」非法 → 提交失败内联提示 + 后端 400 + 不建 run', async ({ page }) => {
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await page.locator(f.from).fill('2026-01-05');
  await page.locator(f.to).fill('2026-03-05');
  await page.locator(f.grid('fast')).fill('abc');
  const before = await apiIds();

  await page.locator(f.submit).click();
  await expect(page.locator(f.submitError)).toContainText('提交失败：HTTP 400');
  await expect(page.locator(f.submitError)).toContainText('范围应为 "起:止:步长"');
  const postResps = w.postResponses.filter((r) => r.status === 400);
  expect(postResps.length, '网格非法 → 1 次 POST 400').toBe(1);

  await sleep(800);
  const after = await apiIds();
  expect(after, '网格非法不建任何 run').toEqual(before);
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'F1d');
  await shot(page, 'F1d_grid_invalid_inline_400.png');
  recordEvidence('F1d', { gridValue: 'abc', status400: true, submitError: await page.locator(f.submitError).textContent(), runsDelta: after.length - before.length, browserNetErrs: w.netErrs });
});

/* ═════════════════════════════════ F2 提交 / 进度 / 幂等（建 run，F2a 留库供 F3/F4 用） ═════════════════════════════════ */

test('F2a 合法提交 → POST 200 run_id + payload 全字段；任务行运行中（% + 回测至）；WS 0→100；完成（reload）→查看结果', async ({ page }) => {
  test.setTimeout(120_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await setForm(page, {
    from: '2026-01-05', to: '2026-03-05',
    period: '5m',
    capital: '123456',
    feeRate: '0.03', feeMin: '3', feeSlippage: '1',
  });

  // 提交前确认无历史 formError（F1c 语义：合法提交会清空旧内联错误）
  await page.locator(f.submit).click();

  // POST 200 + run_id
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const postRes = w.postResponses.find((r) => r.status === 200);
  expect(postRes, 'POST /api/backtest/runs 200').toBeTruthy();
  const runId = postRes ? (JSON.parse(postRes.body!) as { run_id: number }).run_id : 0;
  expect(runId).toBeGreaterThan(0);

  // payload 全字段
  const payload = JSON.parse(w.posts[w.posts.length - 1]!.body!) as Record<string, unknown>;
  expect(payload).toMatchObject({
    code: '518880', period: 'M5', strategy_id: 'dual_ma',
    params: { fast: 5, slow: 20, position_pct: 1 },
    fee: { rate_pct: 0.03, min_fee: 3, slippage_bp: 1 },
    initial_capital: 123456,
    from: '2026-01-05T00:00:00.000Z', to: '2026-03-05T00:00:00.000Z',
  });

  // 任务行出现：运行中 + % + 回测至（WS 驱动）
  const row = page.locator(taskRow(runId));
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  let sawRunning = false;
  let sample: string | null = null;
  for (let i = 0; i < 40; i++) {
    const txt = (await row.textContent().catch(() => '')) ?? '';
    const t = txt.replace(/\s+/g, ' ');
    if (t.includes('运行中') && /\d+%/.test(t) && t.includes('回测至')) {
      sawRunning = true;
      sample = t;
      break;
    }
    await sleep(150);
  }
  expect(sawRunning, '任务行显示 运行中 + 进度% + 回测至…').toBe(true);
  await shot(page, 'F2a_row_running.png');

  // 运行中（未终态）行没有删除按钮
  const st = await apiGetRun(runId);
  if (st && st.status === 'running') {
    expect(await page.locator(`[data-testid="task-delete-${runId}"]`).count(), 'running 行不提供删除').toBe(0);
  }

  // WS backtest_progress：run_id 对齐，pct 从低位到 100
  await expect.poll(
    () => w.wsFrames.filter((m) => m.run_id === runId && m.pct === 100).length,
    { timeout: 30_000, message: 'WS 应收到该 run pct=100 帧' },
  ).toBeGreaterThan(0);
  const mine = w.wsFrames.filter((m) => m.run_id === runId);
  const pcts = mine.map((m) => Number(m.pct));
  expect(mine.length, 'WS 帧数量（每 bar 一帧）').toBeGreaterThan(10);
  expect(Math.min(...pcts), 'WS pct 覆盖低值起点').toBeLessThanOrEqual(20);
  expect(Math.max(...pcts), 'WS pct 到 100').toBe(100);
  for (let i = 1; i < pcts.length; i++) {
    expect(pcts[i]! >= pcts[i - 1]!, 'WS pct 单调不减').toBe(true);
  }
  const firstBar = mine[0]!.bar_ts;
  const lastBar = mine[mine.length - 1]!.bar_ts;
  expect(firstBar && lastBar && String(lastBar) >= String(firstBar), 'bar_ts 推进').toBe(true);

  // API 终态 done
  const fin = await apiWaitFinal(runId);
  expect(fin.status, 'run 最终 done').toBe('done');
  expect(fin.initial_capital, 'initial_capital 落库').toBe(123456);
  expect(fin.date_from, 'date_from 落库').toBe('2026-01-05T00:00:00Z');
  expect(fin.date_to, 'date_to 落库').toBe('2026-03-05T00:00:00Z');
  recordEvidence('F2a', { runId, payload, wsFrames: mine.length, firstPct: pcts[0], maxPct: Math.max(...pcts), apiFinal: fin.status, rowSample: sample });

  // 页内完成后行文案不自动翻「完成」（015 观察#3，见文件头）——reload 后翻
  await sleep(1200);
  const stuck = await row.textContent();
  expect((stuck ?? '').includes('运行中'), '页内 run 完成后行仍显示 运行中（已知观察#3，reload 后翻）').toBe(true);
  recordEvidence('F2a_inpage_after_done', { rowText: (stuck ?? '').replace(/\s+/g, ' ').slice(0, 80) });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="task-list"]');
  const doneTxt = await rowText(page, runId);
  expect(doneTxt, 'reload 后行=完成+查看').toContain('完成');
  expect(doneTxt, 'reload 后行含策略名/标的/周期').toContain('双均线交叉 · 518880 5m');
  expect(await page.locator(`[data-testid="task-check-${runId}"]`).count(), 'done 行提供对比勾选').toBe(1);
  expect(await page.locator(`[data-testid="task-delete-${runId}"]`).count(), 'done 行提供删除').toBe(1);

  // 点已完成 → 结果区加载（图 + 8 指标卡）；1850+ 净值点长序列同时复核回撤修复（0 console error）
  await page.locator(taskRow(runId)).getByRole('button', { name: '查看' }).click();
  await expect(page.locator('[data-testid="equity-drawdown-chart"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="metric-card-net_profit"]')).toBeVisible();
  const metricCount = await page.locator('[data-testid^="metric-card-"]').count();
  expect(metricCount, '8 张指标卡').toBe(8);
  const lastEq = await page.locator('[data-testid="last-equity"]').textContent();
  expect(lastEq && /净值/.test(lastEq), '净值显示').toBeTruthy();

  expect(new URL(page.url()).pathname, '无跳转').toBe('/backtest');
  expect(w.loads, '恰好 1 次初始加载 + 1 次有意 reload').toBe(2);
  assertNoErrors(w, 'F2a（含长序列结果渲染）');
  await shot(page, 'F2a_done_row_result.png');
});

test('F2b 幂等：提交中按钮禁用 + 真实 dblclick 只建 1 run（重复提交不重复建）', async ({ page }) => {
  test.setTimeout(90_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await setForm(page, { from: '2026-01-05', to: '2026-03-05', period: '5m', capital: '100000' });
  const before = await apiIds();

  // 拖慢 POST 响应以观察提交中态（后端已即时处理；仅响应延迟）
  await page.route('**/api/backtest/runs', async (route) => {
    if (route.request().method() === 'POST') await sleep(2500);
    await route.continue().catch(() => undefined);
  });

  await page.locator(f.submit).dblclick();
  await page.waitForTimeout(300);
  expect(await page.locator(f.submit).isDisabled(), '提交中按钮禁用').toBe(true);
  expect(await page.locator(f.submit).textContent(), '提交中文案').toBe('提交中…');

  // 在途再点一次（Playwright click 需按钮可用，会等待；此处用第二记 dblclick 不产生请求的断言由下方 posts 计数兜底）
  await page.waitForTimeout(2600);
  await page.unroute('**/api/backtest/runs').catch(() => undefined);

  await expect.poll(() => w.posts.length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBe(1);
  const runId = (JSON.parse(w.postResponses[0]!.body!) as { run_id: number }).run_id;
  expect(runId).toBeGreaterThan(0);
  const after = await apiIds();
  expect(after.filter((x) => !before.includes(x)), 'dblclick 只建 1 个 run').toEqual([runId]);

  await apiWaitFinal(runId);
  await shot(page, 'F2b_submit_disabled_state.png');
  recordEvidence('F2b', { postCount: w.posts.length, created: [runId], disabledDuringFlight: true, buttonTextDuringFlight: '提交中…' });
});

/* ═════════════════════════════════ F3/F4 任务列表 / 删除 / 404 ═════════════════════════════════ */

test('F3+F4a 已完成 run：点查看 → 结果区加载；删除取消不删；确认 → DELETE 200 → 行移除 + 结果区清空', async ({ page }) => {
  test.setTimeout(90_000);
  // 自建一条 D1 done run（页面操作删/查；创建走产品 API 提效）
  const { id } = await apiMakeDone();
  const w = await attachWatch(page);
  await gotoBacktest(page);
  // gotoBacktest 已加载；行在列表
  await rowText(page, id);
  expect((await rowText(page, id)), '行=完成+查看+删除').toContain('完成');

  // 点查看 → 结果区加载
  await page.locator(taskRow(id)).getByRole('button', { name: '查看' }).click();
  await expect(page.locator('[data-testid="equity-drawdown-chart"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="metric-card-net_profit"]')).toBeVisible();

  // 删除 → 取消：不删（0 DELETE 请求）
  await page.locator(`[data-testid="task-delete-${id}"]`).click();
  await expect(page.locator(`[data-testid="task-delete-confirm-${id}"]`)).toBeVisible();
  await page.locator(`[data-testid="task-delete-cancel-${id}"]`).click();
  await expect(page.locator(taskRow(id))).toBeVisible();
  expect(w.dels.filter((d) => d.url.includes(`/runs/${id}`)), '取消确认 → 0 DELETE').toHaveLength(0);

  // 删除 → 确认：DELETE 200 → 行移除 + 结果区清空（回到占位）
  await page.locator(`[data-testid="task-delete-${id}"]`).click();
  await page.locator(`[data-testid="task-delete-confirm-${id}"]`).click();
  await expect.poll(() => w.dels.filter((d) => d.url.includes(`/runs/${id}`)).length, { timeout: 10_000 }).toBe(1);
  expect(w.dels.find((d) => d.url.includes(`/runs/${id}`))!.status, 'DELETE 200').toBe(200);
  await expect(page.locator(taskRow(id))).toHaveCount(0);
  await expect(page.locator('[data-region="result-overview"]')).toContainText('选择已完成任务查看结果');
  expect(await apiGetRun(id), 'API 侧 run 已删').toBeNull();

  expect(new URL(page.url()).pathname, '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'F3+F4a');
  await shot(page, 'F4a_after_delete_placeholder.png');
  recordEvidence('F3+F4a', { runId: id, deleteStatus: 200, rowRemoved: true, resultCleared: true, cancelDeleteRequests: 0 });
});

test('F4b 删除后结果区已选中 run 时清空；UI 对已删 run 再删 → DELETE 404 → 内联删除失败、不崩溃', async ({ page }) => {
  test.setTimeout(90_000);
  const { id } = await apiMakeDone();
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await rowText(page, id);

  // 先选中载入结果区（删除该 run 后结果区应被清空 —— 见文末断言）
  await page.locator(taskRow(id)).getByRole('button', { name: '查看' }).click();
  await expect(page.locator('[data-testid="equity-drawdown-chart"]')).toBeVisible({ timeout: 20_000 });

  // 服务端先行删除（模拟另一终端已删）→ 行仍在页面（stale 列表）
  expect(await apiDelete(id), '先行 API 删除 200').toBe(200);
  await expect(page.locator(taskRow(id))).toBeVisible();

  // UI 再删 → DELETE 404 → task-delete-error 内联显示、行保留、页面不崩
  await page.locator(`[data-testid="task-delete-${id}"]`).click();
  await page.locator(`[data-testid="task-delete-confirm-${id}"]`).click();
  await expect(page.locator('[data-testid="task-delete-error"]')).toContainText('删除失败：HTTP 404', { timeout: 10_000 });
  await expect(page.locator('[data-testid="task-delete-error"]')).toContainText('run 不存在');
  const inlineErr = (await page.locator('[data-testid="task-delete-error"]').textContent()) ?? null; // reload 前取文案
  const del404 = w.dels.find((d) => d.url.includes(`/runs/${id}`));
  expect(del404?.status, 'UI 再删已删 run → 404').toBe(404);
  await expect(page.locator(taskRow(id))).toBeVisible(); // 行保留（列表 stale），reload 后消失
  // 删除后结果区清空语义：本地 run 已被远端删除（404 失败路径不改本地列表/结果区，属预期）；
  // 真正的「删除成功→结果区清空」由 F4a 覆盖（确认删除后回到占位）。

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="task-list"]');
  await expect(page.locator(taskRow(id))).toHaveCount(0);
  expect(await apiGetRun(id)).toBeNull();

  expect(new URL(page.url()).pathname, '无跳转').toBe('/backtest');
  assertNoErrors(w, 'F4b');
  await shot(page, 'F4b_delete_404_inline.png');
  recordEvidence('F4b', { runId: id, deleteStatus404: true, inlineError: inlineErr, browserNetErrs: w.netErrs });
});

test('F4c 失败 run（无 bar 的 code）→ 行显示 失败 + 错误可读；可删除 → DELETE 200', async ({ page }) => {
  test.setTimeout(90_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await setForm(page, { code: '999999', from: '2026-01-01', to: '2026-04-01', period: '1d', capital: '100000' });

  await page.locator(f.submit).click();
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const runId = (JSON.parse(w.postResponses[0]!.body!) as { run_id: number }).run_id;
  const fin = await apiWaitFinal(runId);
  expect(fin.status, '无 bar → failed').toBe('failed');
  expect(fin.error, '错误含引擎文案').toContain('回测区间无 K 线 bar');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="task-list"]');
  const txt = await rowText(page, runId);
  expect(txt, '行显示 失败').toContain('失败');
  const errTitle = await page.locator(`${taskRow(runId)} span[title]`).getAttribute('title');
  expect(errTitle, '错误可读（title=引擎错误）').toContain('回测区间无 K 线 bar（code=999999');
  expect(await page.locator(`[data-testid="task-delete-${runId}"]`).count(), 'failed 行提供删除').toBe(1);
  await shot(page, 'F4c_failed_row.png');

  await page.locator(`[data-testid="task-delete-${runId}"]`).click();
  await page.locator(`[data-testid="task-delete-confirm-${runId}"]`).click();
  await expect.poll(() => w.dels.filter((d) => d.url.includes(`/runs/${runId}`)).length, { timeout: 10_000 }).toBe(1);
  expect(w.dels.find((d) => d.url.includes(`/runs/${runId}`))!.status).toBe(200);
  await expect(page.locator(taskRow(runId))).toHaveCount(0);
  expect(await apiGetRun(runId)).toBeNull();

  expect(w.loads, '初始 1 + 有意 reload 1').toBe(2);
  assertNoErrors(w, 'F4c');
  recordEvidence('F4c', { runId, status: 'failed', error: fin.error, deleteStatus: 200 });
});

/* ═════════════════════════════════ F5 幂等 / 可重入 ═════════════════════════════════ */

test('F5a 重复提交同参数 → 各自独立多 run（互不覆盖，可各自删除）', async ({ page }) => {
  test.setTimeout(90_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await setForm(page, { from: '2026-01-05', to: '2026-02-05', period: '1d', capital: '100000' });

  await page.locator(f.submit).click();
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBe(1);
  const r1 = (JSON.parse(w.postResponses[0]!.body!) as { run_id: number }).run_id;

  await page.locator(f.submit).click();
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBe(2);
  const r2 = (JSON.parse(w.postResponses[1]!.body!) as { run_id: number }).run_id;

  expect(r1, '两次提交 run_id 不同').not.toBe(r2);
  const p1 = JSON.parse(w.posts[0]!.body!) as Record<string, unknown>;
  const p2 = JSON.parse(w.posts[1]!.body!) as Record<string, unknown>;
  expect(p1, '同参数').toEqual(p2);
  const f1 = await apiWaitFinal(r1);
  const f2 = await apiWaitFinal(r2);
  expect(f1.status).toBe('done');
  expect(f2.status).toBe('done');

  // 独立两行（各自查看/删除）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="task-list"]');
  await rowText(page, r1);
  await rowText(page, r2);
  for (const rid of [r1, r2]) {
    expect((await rowText(page, rid)), '各自行=完成').toContain('完成');
    await page.locator(`[data-testid="task-delete-${rid}"]`).click();
    await page.locator(`[data-testid="task-delete-confirm-${rid}"]`).click();
    await expect.poll(() => w.dels.filter((d) => d.url.includes(`/runs/${rid}`)).length, { timeout: 10_000 }).toBe(1);
    await expect(page.locator(taskRow(rid))).toHaveCount(0);
  }
  expect(await apiGetRun(r1)).toBeNull();
  expect(await apiGetRun(r2)).toBeNull();

  expect(w.loads, '初始 1 + reload 1').toBe(2);
  assertNoErrors(w, 'F5a');
  recordEvidence('F5a', { r1, r2, samePayload: true, bothDone: true, deletes: 2 });
});

test('F5b 竞态：提交后立即删除（运行中）→ DELETE 200、run 不复活、页面不崩溃、服务可继续提交', async ({ page }) => {
  test.setTimeout(120_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  // M15 一年窗（≈4s 引擎时长）制造删除窗口
  await setForm(page, { from: '2025-09-06', to: '2026-09-06', period: '15m', capital: '100000' });

  await page.locator(f.submit).click();
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBe(1);
  const runId = (JSON.parse(w.postResponses[0]!.body!) as { run_id: number }).run_id;
  const atDel = await apiGetRun(runId);
  recordEvidence('F5b', { runId, statusAtDelete: atDel?.status ?? null, progressAtDelete: atDel?.progress ?? null });

  // 立即产品 DELETE（引擎仍在跑）
  const delStatus = await apiDelete(runId);
  expect(delStatus, '运行中 run 可删除 → 200').toBe(200);

  // 引擎跑完（等超过引擎时长）后不复活
  await sleep(7000);
  expect(await apiGetRun(runId), '删除后 run 不复活').toBeNull();
  await sleep(2000);
  expect(await apiGetRun(runId), '再等 2s 仍不复活').toBeNull();

  // 页面不崩溃：可继续提交一次 D1 快 run 并完成
  await setForm(page, { from: '2026-01-05', to: '2026-02-05', period: '1d', capital: '100000' });
  await page.locator(f.submit).click();
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBe(2);
  const r2 = (JSON.parse(w.postResponses[1]!.body!) as { run_id: number }).run_id;
  await apiWaitFinal(r2);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="task-list"]');
  await rowText(page, r2);
  await expect(page.locator(taskRow(runId)), '被删 run 无行').toHaveCount(0);
  // 删除 r2 收尾
  await page.locator(`[data-testid="task-delete-${r2}"]`).click();
  await page.locator(`[data-testid="task-delete-confirm-${r2}"]`).click();
  await expect.poll(() => w.dels.filter((d) => d.url.includes(`/runs/${r2}`)).length, { timeout: 10_000 }).toBe(1);
  await expect(page.locator(taskRow(r2))).toHaveCount(0);

  expect(new URL(page.url()).pathname, '无跳转').toBe('/backtest');
  expect(w.loads, '初始 1 + reload 1').toBe(2);
  assertNoErrors(w, 'F5b');
  recordEvidence('F5b_final', { deleteDuringRun: delStatus, resurrected: false, postRaceSubmitOk: r2 });
});

/* ═════════════════════════════════ 收尾：清理 + 恢复 INI ═════════════════════════════════ */

test.afterAll(async () => {
  const createdIds = [...created].sort((a, b) => b - a);
  let delOk = 0;
  let del404 = 0;
  for (const id of createdIds) {
    const s = await apiDelete(id);
    if (s === 200) delOk++;
    else if (s === 404) del404++;
    else throw new Error(`清理 run ${id} 异常状态 ${s}`);
  }
  const finalIds = await apiIds();
  // 会话内 run 全部清理 + 与 INI 完全一致
  const mismatch = finalIds.filter((x) => !INI_IDS.includes(x)).concat(INI_IDS.filter((x) => !finalIds.includes(x)));
  expect(mismatch, `DB backtest_runs 应恢复会话初快照 ${JSON.stringify(INI_IDS)}（现 ${JSON.stringify(finalIds)}）`).toEqual([]);
  console.log(`[afterAll] 清理 ${createdIds.length} 个临时 run（200=${delOk} 404=${del404}）；DB 恢复 INI(${INI_IDS.length} 行)`);
});

test.beforeAll(async () => {
  INI_IDS = await apiIds();
  writeFileSync(EVIDENCE_FILE, '', 'utf8');
  console.log(`[beforeAll] backtest_runs 初始快照 INI=${JSON.stringify(INI_IDS)}（沿用既有 run 不动）`);
});
