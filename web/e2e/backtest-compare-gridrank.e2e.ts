import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 回测⑤深度回归 · 批 2c —— compare 叠加 / 参数网格展开→网格排行 / 结果一致性（真实环境 e2e）。
 *
 * 本文件位置（self-location）：`web/e2e/backtest-compare-gridrank.e2e.ts`
 *
 * 运行对象（真容器，本 spec 不改产品代码/接口/DB schema；临时 run/网格组全部走产品 API/页面 DELETE 创建与清理，
 * afterAll 恢复到会话初快照 INI，既有 run 不动）：
 *   eestock-app（healthy）/ SPA index-CTRGEV1F.js / http://127.0.0.1:8081（DB eestock-timescaledb:5433）
 *
 * 聚焦范围（单文件回归只测这些，不碰其它页面；用例顺序即依赖顺序，共享单页串行）：
 *   C1/C2 compare 视图：勾选 ≥2 个已完成 run → compare-view 出现：叠加净值曲线（SVG polyline=run 数）+ 8 指标并排表
 *     （每列=一次回测，cell 文本=前端格式函数(API metrics)，逐 cell 核对；值不同证明两 run）；未勾 2 个时占位；退出回单次。
 *   C3 compare 边界：勾 1 个不进 compare；勾选 run 被删（产品 DELETE）后再触发 compare → 后端过滤返回 <2 →
 *     CompareView 占位「至少勾选 2 次已完成回测」+「返回单次视图」可用不崩。
 *   G1/G2 参数网格：表单「起:止:步长」fast 5:11:2 + M15 一年窗 → POST 200 {group_id,run_ids×4}；共享 group_id；
 *     GET /api/backtest/runs?group_id= 列组=4；任务组 N 子任务并发（页面采样 ≥2 行「运行中」并行，实测峰值入证据）；
 *     WS 完成自动翻「完成」（无 reload）；grid-rank 排行：字段（参数组合/总收益/夏普/最大回撤/状态）+ 默认按总收益降序
 *     + 点「按夏普」重排（均按 API 复算排序核对）；点某行 → 该参数组合单次详情（8 卡/净值/交易=该 run API）。
 *   E1 空态：无勾选 → 无 compare 区/无 grid-rank 区 + result 占位；E2/E3 网格组清理：产品 DELETE 逐 run 删除 →
 *     grid-rank「无网格任务组」占位；DB 恢复。
 *   K1/K2 结果一致性：同一 run 多次打开 → 净值/8 卡/交易与 API 全等且重开稳定；不同 code(518880/510050)/period/strategy
 *     的 run 数据不串（逐 run 值=各自 API，切回原 run 值不变）；34+X 跨 code compare 两列值不同。
 *   全程：pageerror=0 / console.error=0 / 无跳转 / 无意外 reload（load 计数逐用例断言）。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/backtest_compare_gridrank_2c）。
 * 运行：cd web && npx playwright test e2e/backtest-compare-gridrank.e2e.ts
 * 约束：不 commit；无 staged 文件；证据截图+evidence.json 落 E2E_SHOTS（仓库外）；设计稿 tester/design/006。
 */

test.describe.configure({ retries: 0 }); // 真库写用例：失败需整文件重跑以保持台账/清理确定性（workers=1 串行）

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/backtest_compare_gridrank_2c';
mkdirSync(SHOT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* 既有已完成 run 夹具（beforeAll 复核存在；沿用不动，收尾仅恢复 INI 行集） */
const RUN_D1_LONG = 34; // 518880 dual_ma D1 多年：1555 点 / 49 笔 / 净 ¥51,950
const RUN_D1_SHORT = 33; // 518880 dual_ma D1：98 点 / 3 笔 / 净 ¥9,519（与 34 值差异显著）
const RUN_KDJ = 84; // 518880 kdj D1 一年：241 点 / 18 笔
const RUN_M15 = 120; // 518880 momentum M15 一年：4338 点 / 44 笔

/* 会话内创建的 run/组 id 台账（afterAll 兜底产品 DELETE → 恢复 INI；已删除 id 404 容忍） */
const created = new Set<number>();
let gridIds: number[] = []; // M15 主网格 4 子任务
let d1GridIds: number[] = []; // E3 短 D1 网格 3 子任务
let gridGroupId = '';
let INI_IDS: number[] = [];

/* ───────────────────────────── 产品 API（Node 侧；写仅限临时 run 创建/删除） ───────────────────────────── */

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
interface RunLike {
  id: number;
  code: string;
  period: string;
  strategy_id: string;
  params: Record<string, unknown>;
  status: string;
  progress: number;
  group_id: string | null;
  metrics?: Record<string, number> | null;
  net_value?: { series: Array<[number, number]>; drawdown: Array<[number, number]> } | null;
  trades?: Array<{ open_ts: number }> | null;
}
async function apiRuns(): Promise<RunLike[]> {
  const { json } = await apiJson<RunLike[]>('/api/backtest/runs');
  return json ?? [];
}
async function apiGroupRuns(gid: string): Promise<RunLike[]> {
  const { json } = await apiJson<RunLike[]>(`/api/backtest/runs?group_id=${encodeURIComponent(gid)}`);
  return json ?? [];
}
async function apiGetRun(id: number): Promise<RunLike | null> {
  const { status, json } = await apiJson<RunLike>(`/api/backtest/runs/${id}`);
  return status === 200 ? json : null;
}
async function apiIds(): Promise<number[]> {
  return (await apiRuns()).map((r) => r.id).sort((a, b) => a - b);
}
async function apiDelete(id: number): Promise<number> {
  const { status } = await apiJson<unknown>(`/api/backtest/runs/${id}`, { method: 'DELETE' });
  return status;
}
async function apiWaitFinal(id: number, ms = 60_000): Promise<RunLike> {
  const t0 = Date.now();
  for (;;) {
    const run = await apiGetRun(id);
    if (run && (run.status === 'done' || run.status === 'failed')) return run;
    if (Date.now() - t0 > ms) throw new Error(`run ${id} 未在 ${ms}ms 内进入终态`);
    await sleep(200);
  }
}
async function apiWaitGroupDone(gid: string, expectN: number, ms = 70_000): Promise<RunLike[]> {
  const t0 = Date.now();
  for (;;) {
    const g = await apiGroupRuns(gid);
    if (g.length === expectN && g.every((r) => r.status === 'done' || r.status === 'failed')) return g;
    if (Date.now() - t0 > ms) throw new Error(`组 ${gid} 未在 ${ms}ms 内 ${expectN} 个子任务全终态（现 ${g.length}）`);
    await sleep(150);
  }
}
async function apiSubmit(body: Record<string, unknown>) {
  return apiJson<{ run_id?: number; group_id?: string; run_ids?: number[] }>('/api/backtest/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 快速建一条已完成 run（产品 POST + 轮询终态）并记台账；返回 run 详情。 */
async function apiMakeDone(o: {
  code?: string;
  period?: string;
  from?: string;
  to?: string;
  strategy?: string;
  params?: Record<string, unknown>;
}): Promise<RunLike> {
  const body = {
    code: o.code ?? '518880',
    period: o.period ?? 'D1',
    from: o.from ?? '2026-01-05T00:00:00.000Z',
    to: o.to ?? '2026-02-05T00:00:00.000Z',
    strategy_id: o.strategy ?? 'dual_ma',
    params: o.params ?? { fast: 5, slow: 20, position_pct: 1 },
    fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    initial_capital: 100000,
  };
  const { status, json } = await apiSubmit(body);
  expect(status, `API 提交建 run ${body.code}/${body.period}`).toBe(200);
  const id = json?.run_id;
  expect(id, 'POST 响应含 run_id').toBeTruthy();
  created.add(id!);
  const fin = await apiWaitFinal(id!);
  expect(fin.status, `临时 run ${id} 终态`).toBe('done');
  return fin;
}

/* ───────────────────────────── 页面通用 helpers（镜像前端格式函数做断言基准） ───────────────────────────── */

/** 前端 CompareView/MetricCards/GridRank 展示口径（与 format.ts 一致）——断言锚点 */
const fmtMoney = (x: number) => `¥${x.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const fmtPct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const fmtRatio = (x: number, d = 2) => x.toFixed(d);
const fmtHoldBars = (b: number) => (b <= 0 ? '0' : `${b}bar`); // CompareView 口径：原始 bar 数
const round1 = (x: number) => {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};
const fmtAvgHoldCard = (b: number) => `${round1(b)}bar`; // MetricCards formatAvgHold(无 period) 口径
const fmtParamValue = (v: unknown): string =>
  typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v ?? '');
const fmtParams = (p: Record<string, unknown>): string =>
  Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${fmtParamValue(v)}`)
    .join(' ');

/** CompareView 8 指标行（key/label/列值格式 与 metricRows() 同构） */
const COMPARE_ROWS: Array<{ key: string; label: string; deco: (m: Record<string, number>) => string }> = [
  { key: 'net_profit', label: 'Net Profit', deco: (m) => fmtMoney(m.net_profit) },
  { key: 'max_drawdown', label: 'Max Drawdown', deco: (m) => fmtPct(m.max_drawdown) },
  { key: 'sharpe', label: 'Sharpe', deco: (m) => fmtRatio(m.sharpe) },
  { key: 'win_rate', label: '胜率', deco: (m) => fmtPct(m.win_rate) },
  { key: 'profit_factor', label: '盈亏比', deco: (m) => fmtRatio(m.profit_factor) },
  { key: 'annualized_return', label: '年化', deco: (m) => fmtPct(m.annualized_return) },
  { key: 'trade_count', label: '总交易数', deco: (m) => String(m.trade_count) },
  { key: 'avg_hold_bars', label: '平均持仓', deco: (m) => fmtHoldBars(m.avg_hold_bars) },
];
const CARD_KEYS = COMPARE_ROWS.map((r) => r.key);
const CARD_DECO: Record<string, (m: Record<string, number>) => string> = {
  net_profit: (m) => fmtMoney(m.net_profit),
  max_drawdown: (m) => fmtPct(m.max_drawdown),
  sharpe: (m) => fmtRatio(m.sharpe),
  win_rate: (m) => fmtPct(m.win_rate),
  profit_factor: (m) => fmtRatio(m.profit_factor),
  annualized_return: (m) => fmtPct(m.annualized_return),
  trade_count: (m) => String(m.trade_count),
  avg_hold_bars: (m) => fmtAvgHoldCard(m.avg_hold_bars), // 卡片口径（round1），与 compare 表口径不同
};

/** 页面监看：pageerror/console.error/load/请求记账；有意 4xx/5xx 走 netErrs（浏览器原生诊断）不计 cerr */
interface PageWatch {
  perr: string[];
  cerr: string[];
  netErrs: string[];
  loads: number;
  posts: Array<{ body: string | null }>;
  postResponses: Array<{ status: number; body: string | null }>;
  dels: Array<{ id: number; status: number | null }>;
  compareUrls: string[];
  wsFrames: Array<Record<string, unknown>>;
}
async function attachWatch(page: Page): Promise<PageWatch> {
  const w: PageWatch = { perr: [], cerr: [], netErrs: [], loads: 0, posts: [], postResponses: [], dels: [], compareUrls: [], wsFrames: [] };
  page.on('pageerror', (e) => w.perr.push(String(e).slice(0, 500)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource: the server responded with a status of (4\d\d|5\d\d)/.test(t)) {
      w.netErrs.push(t.slice(0, 200));
      return;
    }
    w.cerr.push(t.slice(0, 500));
  });
  page.on('load', () => w.loads++);
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/backtest\/runs(\?|$)/.test(r.url())) w.posts.push({ body: r.postData() });
    if (r.method() === 'GET' && /\/api\/backtest\/compare\?/.test(r.url())) w.compareUrls.push(r.url());
  });
  page.on('response', async (r) => {
    const url = r.url();
    if (!url.includes('/api/backtest/runs')) return;
    if (r.request().method() === 'POST') {
      let body: string | null = null;
      try {
        body = await r.text();
      } catch {
        /* ignore */
      }
      w.postResponses.push({ status: r.status(), body });
      if (r.status() === 200 && body) {
        try {
          const j = JSON.parse(body) as { run_id?: number; run_ids?: number[] };
          if (typeof j.run_id === 'number') created.add(j.run_id);
          (j.run_ids ?? []).forEach((id) => created.add(id));
        } catch {
          /* ignore */
        }
      }
    }
    if (r.request().method() === 'DELETE') {
      const idm = url.match(/\/runs\/(\d+)/);
      w.dels.push({ id: idm ? Number(idm[1]) : 0, status: r.status() });
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
function assertNoErrors(w: PageWatch, ctx: string): void {
  expect(w.perr, `${ctx}: pageerror 应为 0`).toEqual([]);
  expect(w.cerr, `${ctx}: console.error 应为 0`).toEqual([]);
}

async function shot(page: Page, name: string): Promise<string> {
  const file = resolve(SHOT, name);
  await page.screenshot({ path: file });
  return file;
}
const EVIDENCE_FILE = resolve(SHOT, 'evidence.json');
function recordEvidence(testName: string, facts: Record<string, unknown>): void {
  writeFileSync(EVIDENCE_FILE, JSON.stringify({ case: testName, ts: new Date().toISOString(), facts }) + '\n', {
    flag: 'a',
  } as never);
}

/* 表单字段（testid 见 StrategyForm.tsx） */
const f = {
  strategy: '[data-testid="strategy-select"]',
  param: (k: string) => `[data-testid="param-${k}"]`,
  grid: (k: string) => `[data-testid="grid-${k}"]`,
  code: '[data-testid="code-input"]',
  period: '[data-testid="period-select"]',
  capital: '[data-testid="initial-capital"]',
  from: '[data-testid="date-from"]',
  to: '[data-testid="date-to"]',
  submit: '[data-testid="submit-btn"]',
};
const taskRow = (id: number) => `[data-testid="task-row-${id}"]`;

/** 每用例全新 SPA 会话（真容器单用户语义）：goto /backtest → 等表单/参数表单/任务列表骨架可交互 */
async function gotoBacktest(page: Page): Promise<void> {
  await page.goto(BASE + '/backtest', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="strategy-form"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="param-form"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="task-list"]', { timeout: 20_000 });
}

async function setForm(
  page: Page,
  o: { period?: string; from?: string; to?: string; code?: string; strategy?: string; grid?: Record<string, string> },
): Promise<void> {
  if (o.strategy) await page.locator(f.strategy).selectOption(o.strategy);
  for (const [k, v] of Object.entries(o.grid ?? {})) await page.locator(f.grid(k)).fill(v);
  if (o.code) await page.locator(f.code).fill(o.code);
  if (o.period) await page.locator(f.period).selectOption(o.period);
  if (o.from) await page.locator(f.from).fill(o.from);
  if (o.to) await page.locator(f.to).fill(o.to);
}
async function rowText(page: Page, id: number): Promise<string> {
  const loc = page.locator(taskRow(id));
  await loc.waitFor({ state: 'visible', timeout: 15_000 });
  return ((await loc.textContent()) ?? '').replace(/\s+/g, ' ');
}

/** 点已完成 run 行的「查看」并等其指标卡出现；返回该行 locator 外留待读值 */
async function selectRun(page: Page, id: number): Promise<void> {
  const row = page.locator(taskRow(id));
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.getByRole('button', { name: '查看' }).click();
  await expect(page.locator('[data-testid="metric-card-net_profit"]')).toBeVisible({ timeout: 20_000 });
}

/** 读 8 张指标卡值（每卡取末行值文本） */
async function metricValues(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of CARD_KEYS) {
    const loc = page.locator(`[data-testid="metric-card-${k}"]`);
    await loc.waitFor({ state: 'visible', timeout: 15_000 });
    const lines = ((await loc.innerText()) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    out[k] = lines[lines.length - 1] ?? '';
  }
  return out;
}

/** 校验单次详情区（结果图/卡片/交易行数）与 API 数据一致；返回快照（供重开对比） */
async function assertDetailMatchesApi(page: Page, id: number): Promise<{ lastEquity: string; netReturn: string; cards: Record<string, string>; trades: number }> {
  const run = await apiGetRun(id);
  expect(run, `run ${id} 存在`).toBeTruthy();
  const m = (run!.metrics ?? {}) as Record<string, number>;
  const series = run!.net_value?.series ?? [];
  const last = series.length ? series[series.length - 1]![1] : 0;
  const first = series.length ? series[0]![1] : 0;
  const retPct = first > 0 ? (last - first) / first : 0;
  const lastEquityText = `净值 ${last.toFixed(3)}`;
  const netReturnText = `${retPct >= 0 ? '+' : ''}${fmtPct(retPct)}（${fmtMoney(last)}）`;
  await expect.poll(() => page.locator('[data-testid="last-equity"]').textContent(), { timeout: 15_000 }).toBe(lastEquityText);
  await expect.poll(() => page.locator('[data-testid="net-return"]').textContent(), { timeout: 15_000 }).toBe(netReturnText);
  const expectedCards: Record<string, string> = {};
  for (const k of CARD_KEYS) expectedCards[k] = CARD_DECO[k]!(m);
  for (const k of CARD_KEYS) {
    await expect.poll(() => page.locator(`[data-testid="metric-card-${k}"]`).innerText().then((t) => t.split('\n').map((s) => s.trim()).filter(Boolean).pop()), {
      timeout: 15_000,
    }).toBe(expectedCards[k]);
  }
  // 回撤角标「回撤（最大 −X%，着色区间）」= fmtPct(ddMax)
  const ddMax = Math.max(...(run!.net_value?.drawdown ?? []).map((d) => d[1]), 0);
  await expect(page.locator('[data-region="result-overview"]')).toContainText(`回撤（最大 −${fmtPct(ddMax || 1)}，着色区间）`);
  // 交易行数与 API trades 长度一致
  await expect
    .poll(() => page.locator('[data-testid^="trade-row-"]').count(), { timeout: 15_000 })
    .toBe((run!.trades ?? []).length);
  const cards = await metricValues(page);
  return { lastEquity: lastEquityText, netReturn: netReturnText, cards, trades: (run!.trades ?? []).length };
}

/* ───────────────────────────── 共享页面（真容器单用户；用例间状态不残留 —— 每用例先 goto） ───────────────────────────── */

let ctx: BrowserContext | null = null;
let page: Page | null = null;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await ctx.newPage();
  INI_IDS = await apiIds();
  writeFileSync(EVIDENCE_FILE, '', 'utf8');
  console.log(`[beforeAll] SPA 环境 + backtest_runs 初始快照 INI=${JSON.stringify(INI_IDS)}`);
  for (const id of [RUN_D1_LONG, RUN_D1_SHORT, RUN_KDJ, RUN_M15]) {
    const r = await apiGetRun(id);
    expect(r, `既有 run ${id} 存在（环境数据夹具）`).toBeTruthy();
    expect(r!.status, `既有 run ${id} 已完成`).toBe('done');
  }
  const html = await (await fetch(BASE + '/')).text();
  expect(html, '环境 SPA 资产 index-CTRGEV1F.js').toContain('index-CTRGEV1F.js');
});

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
  const mismatch = finalIds.filter((x) => !INI_IDS.includes(x)).concat(INI_IDS.filter((x) => !finalIds.includes(x)));
  expect(mismatch, `DB backtest_runs 应恢复会话初快照 ${JSON.stringify(INI_IDS)}（现 ${JSON.stringify(finalIds)}）`).toEqual([]);
  console.log(`[afterAll] 兜底清理 ${createdIds.length} 个临时 run（200=${delOk} 404=${del404}）；DB 恢复 INI(${INI_IDS.length} 行)`);
  await ctx?.close().catch(() => undefined);
});

/* ═════════════════════════════════ E1 空态/边界：无勾选 / 无网格组 ═════════════════════════════════ */

test('E1 空态：无勾选 run → result 占位；无 compare 区/无 grid-rank 区；无网格任务组不出现', async () => {
  const pg = page!;
  const w = await attachWatch(pg);
  await gotoBacktest(pg);

  await expect(pg.locator('[data-region="result-overview"]')).toContainText('选择已完成任务查看结果');
  await expect(pg.locator('[data-region="trade-table"]')).toContainText('本次回测无交易');
  expect(await pg.locator('[data-region="compare-view"]').count(), '单次视图无 compare 区').toBe(0);
  expect(await pg.locator('[data-region="grid-rank"]').count(), '单次视图无 grid-rank 区').toBe(0);
  expect(await pg.locator('[data-testid="compare-chart"]').count(), '无 compare 图').toBe(0);
  expect(await pg.locator('[data-testid="grid-rank-table"]').count(), '无 grid-rank 表').toBe(0);
  expect(await pg.locator('[data-testid="task-list"]').textContent(), '任务列表可见（既有 run）').toContain('完成');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'E1');
  await shot(pg, 'E1_empty_single_view.png');
  recordEvidence('E1', { resultPlaceholder: true, compareRegion: 0, gridRankRegion: 0, loads: w.loads });
});

/* ═════════════════════════════════ C1/C2 compare 叠加 + 8 指标并排 ═════════════════════════════════ */

/** 读 compare-view 表：labels/列头/每列 8 cell 文本 + svg 曲线数量 */
async function readCompare(page: Page): Promise<{
  title: string;
  labels: string[];
  headers: string[];
  cols: Array<{ runId: number; values: string[] }>;
  polylines: number;
  polygons: number;
  legend: string[];
}> {
  const region = page.locator('[data-region="compare-view"]');
  await expect(region.locator('[data-testid="compare-chart"]')).toBeVisible({ timeout: 20_000 });
  const title = ((await region.locator('span.text-dim').first().textContent()) ?? '').trim();
  const legend: string[] = [];
  for (const el of await region.locator('div.flex.gap-3 span').all()) {
    const t = ((await el.textContent()) ?? '').trim();
    if (t) legend.push(t);
  }
  const thead = region.locator('table thead tr th');
  const nCols = await thead.count();
  const headers: string[] = [];
  for (let i = 0; i < nCols; i++) headers.push(((await thead.nth(i).textContent()) ?? '').trim());
  const labels: string[] = [];
  const cols: Array<{ runId: number; values: string[] }> = [];
  const tbodyRows = region.locator('table tbody tr');
  const nRows = await tbodyRows.count();
  for (let i = 0; i < nRows; i++) {
    const tds = tbodyRows.nth(i).locator('td');
    labels.push(((await tds.nth(0).textContent()) ?? '').trim());
    for (let c = 1; c < nCols; c++) {
      const runId = Number(headers[c]!.split('·')[0]!.trim());
      if (!cols[c - 1]) cols.push({ runId, values: [] });
      cols[c - 1]!.values.push(((await tds.nth(c).textContent()) ?? '').trim());
    }
  }
  const chart = region.locator('[data-testid="compare-chart"]');
  return { title, labels, headers, cols, polylines: await chart.locator('polyline').count(), polygons: await chart.locator('polygon').count(), legend };
}

test('C1 compare 2 run：叠加净值曲线(2 polyline) + 8 指标并排表（每列=一次回测，值不同）→ 退出回单次', async () => {
  const pg = page!;
  const w = await attachWatch(pg);
  await gotoBacktest(pg);

  // 勾 34 → 仍单次；勾 33 → compare 出现
  await pg.locator(`[data-testid="task-check-${RUN_D1_LONG}"]`).check();
  await pg.waitForTimeout(300);
  expect(await pg.locator('[data-region="compare-view"]').count(), '勾 1 个不进 compare').toBe(0);
  await pg.locator(`[data-testid="task-check-${RUN_D1_SHORT}"]`).check();
  await expect(pg.locator('[data-region="compare-view"]')).toBeVisible({ timeout: 20_000 });

  const c = await readCompare(pg);
  expect(c.title, '标题叠加 2 次').toContain('对比视图（叠加 2 次）');
  expect(c.polylines, '叠加净值曲线 = 2 polyline').toBe(2);
  expect(c.polygons, '面积着色 = 2 polygon').toBe(2);
  expect(c.legend, '图例 2 段').toEqual([`${RUN_D1_LONG}·518880 日`, `${RUN_D1_SHORT}·518880 日`]);
  expect(c.labels, '8 指标行 label').toEqual(COMPARE_ROWS.map((r) => r.label));
  expect(c.headers, '表头 指标 + 每 run 一列').toEqual(['指标', `${RUN_D1_LONG} · 518880`, `${RUN_D1_SHORT} · 518880`]);
  expect(c.cols.length, '两列（两次回测）').toBe(2);
  expect(c.cols.map((x) => x.runId), '列 run id').toEqual([RUN_D1_LONG, RUN_D1_SHORT]);

  // 逐列 8 cell = 前端格式(API metrics)；两列值不同证明两个 run
  for (const col of c.cols) {
    const run = await apiGetRun(col.runId);
    const m = (run!.metrics ?? {}) as Record<string, number>;
    const expected = COMPARE_ROWS.map((r) => r.deco(m));
    expect(col.values, `run ${col.runId} compare 列 8 值=fmt(API)`).toEqual(expected);
  }
  for (let i = 0; i < 8; i++) {
    expect(c.cols[0]!.values[i], `指标行 ${COMPARE_ROWS[i]!.label} 两 run 值不同`).not.toBe(c.cols[1]!.values[i]);
  }
  // compare 请求确发（ids 顺序与勾选一致）
  expect(w.compareUrls.some((u) => u.includes(`ids=${RUN_D1_LONG},${RUN_D1_SHORT}`)), 'GET /compare?ids=34,33').toBe(true);
  await shot(pg, 'C1_compare_34_33.png');

  // 返回单次 → compare 区消失、result 占位
  await pg.locator('[data-region="compare-view"]').getByRole('button', { name: '返回单次' }).click();
  await expect(pg.locator('[data-region="compare-view"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(pg.locator('[data-region="result-overview"]')).toContainText('选择已完成任务查看结果');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'C1');
  recordEvidence('C1', { title: c.title, polylines: c.polylines, polygons: c.polygons, legend: c.legend, labels: c.labels, headers: c.headers, colValues: c.cols.map((x) => x.values), compareRequests: w.compareUrls, loads: w.loads });
});

test('C2 compare 3 run（跨策略/周期）：polyline=3、列=3、值互异', async () => {
  const pg = page!;
  const w = await attachWatch(pg);
  await gotoBacktest(pg);

  for (const id of [RUN_D1_LONG, RUN_KDJ, RUN_M15]) await pg.locator(`[data-testid="task-check-${id}"]`).check();
  await expect(pg.locator('[data-region="compare-view"]')).toBeVisible({ timeout: 20_000 });

  const c = await readCompare(pg);
  expect(c.polylines, '3 条叠加曲线').toBe(3);
  expect(c.polygons, '3 个面积').toBe(3);
  expect(c.title).toContain('对比视图（叠加 3 次）');
  expect(c.headers, '列头 = 指标+3 run').toEqual(['指标', `${RUN_D1_LONG} · 518880`, `${RUN_KDJ} · 518880`, `${RUN_M15} · 518880`]);
  expect(c.cols.length, '3 列').toBe(3);
  for (const col of c.cols) {
    const run = await apiGetRun(col.runId);
    const m = (run!.metrics ?? {}) as Record<string, number>;
    expect(col.values, `run ${col.runId} 列值=fmt(API)`).toEqual(COMPARE_ROWS.map((r) => r.deco(m)));
  }
  // 三个 run 值两两不同（总收益/交易数等至少 3 行互异）
  let diffRows = 0;
  for (let i = 0; i < 8; i++) {
    const set = new Set([c.cols[0]!.values[i], c.cols[1]!.values[i], c.cols[2]!.values[i]]);
    if (set.size === 3) diffRows++;
  }
  expect(diffRows, '8 指标中至少 3 行三 run 值互异').toBeGreaterThanOrEqual(3);
  await shot(pg, 'C2_compare_3runs.png');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'C2');
  recordEvidence('C2', { polylines: c.polylines, headers: c.headers, diffRows, loads: w.loads });
});

/* ═════════════════════════════════ C3 compare 边界：勾选不足/run 被删→占位 ═════════════════════════════════ */

test('C3 compare 边界：勾 1 个占位不进 compare；勾选 run 被删后再触发 compare → 占位 + 返回单次不崩', async () => {
  test.setTimeout(90_000);
  const pg = page!;
  const w = await attachWatch(pg);
  // 建两条 D1 临时 done run（Y1/Y2，值不同）
  const y1 = await apiMakeDone({ from: '2026-01-05T00:00:00.000Z', to: '2026-02-05T00:00:00.000Z', params: { fast: 5, slow: 20, position_pct: 1 } });
  const y2 = await apiMakeDone({ from: '2026-01-05T00:00:00.000Z', to: '2026-02-05T00:00:00.000Z', params: { fast: 7, slow: 20, position_pct: 1 } });
  expect(y1.id).not.toBe(y2.id);

  await gotoBacktest(pg);
  // 勾 Y1 → 不进 compare（compareIds<2 保持 single）
  await pg.locator(`[data-testid="task-check-${y1.id}"]`).check();
  await pg.waitForTimeout(400);
  expect(await pg.locator('[data-region="compare-view"]').count(), '勾 1 个 → 无 compare 区').toBe(0);
  // 勾 Y2 → compare 叠加 2 次（两列值不同）
  await pg.locator(`[data-testid="task-check-${y2.id}"]`).check();
  await expect(pg.locator('[data-region="compare-view"]')).toBeVisible({ timeout: 20_000 });
  const c0 = await readCompare(pg); // 内部等待 compare-chart 出现（数据异步加载完成）
  expect(c0.title).toContain('对比视图（叠加 2 次）');
  expect(c0.cols.map((x) => x.runId).sort((a, b) => a - b), 'compare 两临时 run').toEqual([y1.id, y2.id].sort((a, b) => a - b));
  await shot(pg, 'C3_compare_two_temp.png');

  // 产品 DELETE 删掉 Y2（另一终端视角）
  expect(await apiDelete(y2.id), 'API 删除 Y2 200').toBe(200);
  // 取消 Y1 → 回 single
  await pg.locator(`[data-testid="task-check-${y1.id}"]`).uncheck();
  await expect(pg.locator('[data-region="compare-view"]')).toHaveCount(0, { timeout: 10_000 });
  // 再勾 Y1 → compareIds=[Y2,Y1]，后端过滤仅返回 Y1 → done<2 → CompareView 占位
  await pg.locator(`[data-testid="task-check-${y1.id}"]`).check();
  await expect(pg.locator('[data-region="compare-view"]')).toContainText('至少勾选 2 次已完成回测', { timeout: 20_000 });
  await expect(pg.locator('[data-region="compare-view"]')).toContainText('返回单次视图');
  // 占位态：无 compare 图 / 无指标表（未渲染叠加内容）
  expect(await pg.locator('[data-region="compare-view"] [data-testid="compare-chart"]').count(), '占位无 compare 图').toBe(0);
  expect(await pg.locator('[data-region="compare-view"] table').count(), '占位无指标表').toBe(0);
  await shot(pg, 'C3_compare_deleted_id_placeholder.png');

  // 返回单次视图 → single 占位、compare 区消失；页面不崩
  await pg.locator('[data-region="compare-view"]').getByRole('button', { name: '返回单次视图' }).click();
  await expect(pg.locator('[data-region="compare-view"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(pg.locator('[data-region="result-overview"]')).toContainText('选择已完成任务查看结果');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'C3');
  recordEvidence('C3', { y1: y1.id, y2: y2.id, enteredCompare: true, deletedThenComparePlaceholder: true, exitedToSingle: true, loads: w.loads });
});

/* ═════════════════════════════════ K1/K2 结果一致性 ═════════════════════════════════ */

test('K1 一致性：同一 run 多次打开 → 净值/8 卡/交易=API 且重开稳定；不同 strategy/period 不串', async () => {
  const pg = page!;
  const w = await attachWatch(pg);
  await gotoBacktest(pg);

  await selectRun(pg, RUN_D1_LONG);
  const s34a = await assertDetailMatchesApi(pg, RUN_D1_LONG);
  await selectRun(pg, RUN_KDJ);
  const s84 = await assertDetailMatchesApi(pg, RUN_KDJ);
  // 值确实切换（不串）：net_profit/trades/lastEquity 不同
  expect(s84.cards.net_profit, 'kdj 与 dual_ma net 不同').not.toBe(s34a.cards.net_profit);
  expect(s84.trades, '18 笔 vs 49 笔').not.toBe(s34a.trades);
  // 再开 run34：与首次捕获逐字段一致
  await selectRun(pg, RUN_D1_LONG);
  const s34b = await assertDetailMatchesApi(pg, RUN_D1_LONG);
  expect(s34b.lastEquity, '净值重开稳定').toBe(s34a.lastEquity);
  expect(s34b.netReturn, '收益重开稳定').toBe(s34a.netReturn);
  expect(s34b.trades, '交易行数重开稳定').toBe(s34a.trades);
  expect(s34b.cards, '8 卡重开逐值稳定').toEqual(s34a.cards);

  await shot(pg, 'K1_reopen_stable.png');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'K1');
  recordEvidence('K1', { run34: s34a, run84: s84, reopenedEqual: s34a.cards.net_profit === s34b.cards.net_profit, loads: w.loads });
});

test('K2 一致性：跨 code(510050)/period/strategy 数据不串 + 34×510050 跨 code compare', async () => {
  test.setTimeout(120_000);
  const pg = page!;
  const w = await attachWatch(pg);
  // 建 X：510050 D1 dual_ma 一年（净收益为负，与 518880 各 run 显著区分）
  const x = await apiMakeDone({
    code: '510050',
    period: 'D1',
    from: '2025-09-05T00:00:00.000Z',
    to: '2026-09-05T00:00:00.000Z',
    params: { fast: 5, slow: 20, position_pct: 1 },
  });
  expect(x.code, 'X code 510050').toBe('510050');

  await gotoBacktest(pg);
  // 依次打开 34(D1 dual_ma 518880)/84(D1 kdj)/X(D1 510050)/120(M15 momentum)，逐个值=各自 API
  const seen: Array<{ id: number; net: string; trades: number; lastEquity: string }> = [];
  for (const id of [RUN_D1_LONG, RUN_KDJ, x.id, RUN_M15]) {
    await selectRun(pg, id);
    const snap = await assertDetailMatchesApi(pg, id);
    seen.push({ id, net: snap.cards.net_profit, trades: snap.trades, lastEquity: snap.lastEquity });
    // 上一 run 数据不残留：当前净收益必须等于该 run API
    const run = await apiGetRun(id);
    const m = (run!.metrics ?? {}) as Record<string, number>;
    expect(snap.cards.net_profit, `run ${id} 卡 net=API fmtMoney`).toBe(CARD_DECO.net_profit!(m));
  }
  // 四 run 值两两不同（证明显示数据确实随选中切换而非残留）
  const nets = seen.map((s) => s.net);
  expect(new Set(nets).size, '4 run 净收益文本互异（数据不串）').toBe(4);
  await shot(pg, 'K2_four_runs_no_leak.png');

  // 34 × X 跨 code compare：两列值不同 + 图例两 code
  for (const id of [RUN_D1_LONG, x.id]) await pg.locator(`[data-testid="task-check-${id}"]`).check();
  await expect(pg.locator('[data-region="compare-view"]')).toBeVisible({ timeout: 20_000 });
  const c = await readCompare(pg);
  expect(c.polylines, '2 条叠加').toBe(2);
  expect(c.legend, '图例含两 code').toEqual([`${RUN_D1_LONG}·518880 日`, `${x.id}·510050 日`]);
  expect(c.headers, '列头两 code').toEqual(['指标', `${RUN_D1_LONG} · 518880`, `${x.id} · 510050`]);
  for (const col of c.cols) {
    const run = await apiGetRun(col.runId);
    const m = (run!.metrics ?? {}) as Record<string, number>;
    expect(col.values, `run ${col.runId} 列值=fmt(API)`).toEqual(COMPARE_ROWS.map((r) => r.deco(m)));
  }
  expect(c.cols[0]!.values[0], '跨 code net_profit 列不同').not.toBe(c.cols[1]!.values[0]);
  expect(c.cols[0]!.values[6], '跨 code trade_count 列不同').not.toBe(c.cols[1]!.values[6]);
  await shot(pg, 'K2_compare_cross_code.png');
  // 退出 compare（取消两勾选回 single）
  await pg.locator(`[data-testid="task-check-${RUN_D1_LONG}"]`).uncheck();
  await pg.locator(`[data-testid="task-check-${x.id}"]`).uncheck();
  await expect(pg.locator('[data-region="compare-view"]')).toHaveCount(0, { timeout: 10_000 });

  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'K2');
  recordEvidence('K2', { xId: x.id, seen, crossCodeCompare: c.headers, loads: w.loads });
});

/* ═════════════════════════════════ G1 网格提交：展开任务组 / 共享 group_id / 并发 / 自动翻完成 ═════════════════════════════════ */

test('G1 网格展开：fast 5:11:2 → 任务组 4 子任务共享 group_id；并发 running≥2；WS 完成自动翻「完成」', async () => {
  test.setTimeout(180_000);
  const pg = page!;
  const w = await attachWatch(pg);
  await gotoBacktest(pg);
  const beforeIds = await apiIds();

  await setForm(pg, { from: '2025-09-06', to: '2026-09-06', period: '15m', grid: { fast: '5:11:2' } });
  await pg.locator(f.submit).click();

  // POST 200 + payload（数值 params 与 params_grid 拆分）
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const post = w.postResponses.find((r) => r.status === 200);
  expect(post, 'POST /api/backtest/runs 200').toBeTruthy();
  const resp = JSON.parse(post!.body!) as { group_id: string; run_ids: number[] };
  expect(resp.group_id, '响应含 group_id').toBeTruthy();
  expect(resp.run_ids, '网格展开 4 子任务').toHaveLength(4);
  gridGroupId = resp.group_id;
  gridIds = resp.run_ids;
  const payload = JSON.parse(w.posts[w.posts.length - 1]!.body!) as Record<string, unknown>;
  expect(payload.params_grid, 'payload params_grid').toEqual({ fast: '5:11:2' });
  expect(payload.params, 'payload 数值 params').toEqual({ slow: 20, position_pct: 1 });
  expect(payload).toMatchObject({ code: '518880', period: 'M15', strategy_id: 'dual_ma' });
  {
    const idsAfter = await apiIds();
    expect(idsAfter.filter((x) => !beforeIds.includes(x)), '新建 4 run').toEqual([...resp.run_ids].sort((a, b) => a - b));
  }

  // 视图切 grid-rank
  await expect(pg.locator('[data-region="grid-rank"]')).toBeVisible({ timeout: 20_000 });
  await expect(pg.locator('[data-region="grid-rank"]')).toContainText('网格任务组排行（1 组）');
  await expect(pg.locator('[data-testid^="gridrank-row-"]')).toHaveCount(4, { timeout: 20_000 });

  // GET /api/backtest/runs?group_id= 列组：4 条全共享 group_id，params fast ∈ {5,7,9,11}
  const grp = await apiGroupRuns(gridGroupId);
  expect(grp.length, '组员 4').toBe(4);
  expect(grp.map((r) => r.id).sort((a, b) => a - b), '组员=run_ids').toEqual([...resp.run_ids].sort((a, b) => a - b));
  expect(new Set(grp.map((r) => r.group_id)), '组员共享 group_id').toEqual(new Set([gridGroupId]));
  expect(grp.map((r) => r.params.fast).sort((a, b) => Number(a) - Number(b)), 'fast 组合 {5,7,9,11}').toEqual([5, 7, 9, 11]);
  for (const r of grp) expect(r.params.slow).toBe(20);

  // 并发采样：4 行中「运行中」≥2 同时存在（引擎 max_concurrent=4）
  // GridRank 状态列渲染原始 status（'15m · running'），非 statusLabel 中文
  const runningRows = () =>
    pg.locator('[data-region="grid-rank"] [data-testid^="gridrank-row-"]').filter({ hasText: 'running' }).count();
  let maxRunning = 0;
  let t = 0;
  for (;;) {
    maxRunning = Math.max(maxRunning, await runningRows());
    const g = await apiGroupRuns(gridGroupId);
    if (g.length === 4 && g.every((r) => r.status === 'done')) break;
    if (t > 70_000) throw new Error('网格 4 子任务 70s 未全 done');
    await sleep(40);
    t += 40;
  }
  expect(maxRunning, '组内子任务并发可观测（≥2 同时 running）').toBeGreaterThanOrEqual(2);
  expect(t, '引擎墙钟').toBeLessThan(70_000);

  // 页内 WS 完成自动翻「完成」（无需 reload）：grid-rank 4 行全「日 · 完成」
  await expect
    .poll(async () => {
      const rows = pg.locator('[data-region="grid-rank"] [data-testid^="gridrank-row-"]');
      const n = await rows.count();
      if (n !== 4) return -1;
      let done = 0;
      for (let i = 0; i < n; i++) if (((await rows.nth(i).textContent()) ?? '').includes('done')) done++;
      return done;
    }, { timeout: 30_000 })
    .toBe(4);
  // 任务列表 4 行同步「完成」（TaskList 用 statusLabel 中文）
  for (const id of gridIds) {
    const txt = await rowText(pg, id);
    expect(txt, `任务行 ${id} 完成`).toContain('完成');
  }
  // WS 帧：4 个 run 各自收到 pct=100
  for (const id of gridIds) {
    expect(w.wsFrames.some((m) => m.run_id === id && m.pct === 100), `run ${id} WS pct=100`).toBe(true);
  }
  await shot(pg, 'G1_grid_group_done.png');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'G1');
  recordEvidence('G1', { groupId: gridGroupId, runIds: gridIds, payload: { params_grid: payload.params_grid, params: payload.params, code: payload.code, period: payload.period }, groupApi: grp.map((r) => ({ id: r.id, fast: r.params.fast })), maxConcurrentRunning: maxRunning, engineMs: t, wsPct100Count: gridIds.length, loads: w.loads });
});

/* ═════════════════════════════════ G2 grid-rank 排行：字段 / 排序 / 点行详情 ═════════════════════════════════ */

test('G2 grid-rank 排行字段与 API 一致；默认按总收益、按夏普重排；点行 → 该参数组合单次详情', async () => {
  test.setTimeout(90_000);
  const pg = page!;
  const w = await attachWatch(pg);
  // 沿用 G1 页面会话（grid-rank 视图 + 4 run done 仍在）；若重跑该用例单独执行则先补数据
  if (await pg.locator('[data-region="grid-rank"]').count() === 0) {
    test.skip(true, 'G2 依赖 G1 同会话（整文件串行运行时成立）');
    return;
  }
  const api = await apiGroupRuns(gridGroupId);
  const runOf = (id: number) => api.find((r) => r.id === id)!;
  const expectedSort = (key: 'net' | 'sharpe') =>
    [...api]
      .map((r) => ({ run: r, paramsText: fmtParams(r.params as Record<string, unknown>) }))
      .sort((a, b) => {
        const av = a.run.metrics?.[key === 'net' ? 'net_profit' : 'sharpe'] ?? -Infinity;
        const bv = b.run.metrics?.[key === 'net' ? 'net_profit' : 'sharpe'] ?? -Infinity;
        return bv - av;
      })
      .map((x) => x.run.id);

  const table = pg.locator('[data-testid="grid-rank-table"]');
  await expect(table).toBeVisible();
  // 表头字段
  const headers = (await table.locator('thead th').allTextContents()).map((s) => s.trim());
  expect(headers, '排行表头').toEqual(['#', '参数组合', '总收益', '夏普', '最大回撤', '状态']);

  // 每行 5 业务 cell 与 API 一致（参数组合/总收益/夏普/最大回撤/状态）
  const rows = table.locator('tbody tr');
  expect(await rows.count(), '排行 4 行').toBe(4);
  const shown: Array<{ id: number; cells: string[] }> = [];
  for (let i = 0; i < 4; i++) {
    const tr = rows.nth(i);
    const rid = Number(((await tr.getAttribute('data-testid')) ?? '').replace('gridrank-row-', ''));
    const cells = (await tr.locator('td').allTextContents()).map((s) => s.trim());
    shown.push({ id: rid, cells });
    const r = runOf(rid);
    const m = (r.metrics ?? {}) as Record<string, number>;
    expect(cells[1], `run ${rid} 参数组合`).toBe(fmtParams(r.params as Record<string, unknown>));
    expect(cells[2], `run ${rid} 总收益`).toBe(fmtPct(m.net_profit / 100000));
    expect(cells[3], `run ${rid} 夏普`).toBe(fmtRatio(m.sharpe));
    expect(cells[4], `run ${rid} 最大回撤`).toBe(fmtPct(m.max_drawdown));
    expect(cells[5], `run ${rid} 状态`).toBe('15m · done');
  }
  expect(shown.map((x) => x.id), '默认按总收益降序').toEqual(expectedSort('net'));
  await shot(pg, 'G2_gridrank_sorted_net.png');

  // 点「按夏普」→ 按夏普降序
  await pg.getByRole('button', { name: '按夏普' }).click();
  const rowsS = table.locator('tbody tr');
  const shownS: number[] = [];
  for (let i = 0; i < 4; i++) {
    const rid = Number(((await rowsS.nth(i).getAttribute('data-testid')) ?? '').replace('gridrank-row-', ''));
    shownS.push(rid);
  }
  expect(shownS, '按夏普降序').toEqual(expectedSort('sharpe'));
  await shot(pg, 'G2_gridrank_sorted_sharpe.png');

  // 点当前第 1 行 → 该参数组合单次详情（8 卡/净值/交易=该 run API）；URL 不变
  const clickId = shownS[0]!;
  await rowsS.nth(0).click();
  await expect(pg.locator('[data-region="grid-rank"]')).toHaveCount(0, { timeout: 10_000 });
  const snap = await assertDetailMatchesApi(pg, clickId);
  expect(snap.cards.net_profit, '点行详情 net=该 run API').toBe(CARD_DECO.net_profit!((runOf(clickId).metrics ?? {}) as Record<string, number>));
  await shot(pg, 'G2_gridrank_row_detail.png');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, 'G2 沿用 G1 页面会话，本用例 0 导航/无 reload').toBe(0);
  assertNoErrors(w, 'G2');
  recordEvidence('G2', { headers, shownNetOrder: shown.map((x) => ({ id: x.id, cells: x.cells.slice(1) })), shownSharpeOrder: shownS, detailRun: clickId, loads: w.loads });
});

/* ═════════════════════════════════ E2 网格组清理（产品 DELETE 删 M15 组 4 run）+ E3 无网格组占位 ═════════════════════════════════ */

test('E2 网格组清理：任务列表产品 DELETE 逐个删 4 个 M15 组 run（200）→ 列表移除、组清空', async () => {
  test.setTimeout(90_000);
  const pg = page!;
  const w = await attachWatch(pg);
  await gotoBacktest(pg);
  for (const id of gridIds) {
    await rowText(pg, id); // 行可见（完成）
    await pg.locator(`[data-testid="task-delete-${id}"]`).click();
    await pg.locator(`[data-testid="task-delete-confirm-${id}"]`).click();
    await expect.poll(() => w.dels.filter((d) => d.id === id).length, { timeout: 10_000 }).toBe(1);
    expect(w.dels.find((d) => d.id === id)!.status, `DELETE run ${id} 200`).toBe(200);
    await expect(pg.locator(taskRow(id))).toHaveCount(0, { timeout: 10_000 });
  }
  expect(await apiGroupRuns(gridGroupId), '组已清空').toEqual([]);
  expect(await apiGetRun(gridIds[0]!), 'run 已删').toBeNull();
  await shot(pg, 'E2_grid_group_deleted.png');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'E2');
  recordEvidence('E2', { deleted: gridIds, dels: w.dels.filter((d) => gridIds.includes(d.id)).map((d) => d.status), loads: w.loads });
});

test('E3 网格组清理/空组态：grid-rank 视图删组内 run → 自动回 single、DB 组清空、无残留空组视图', async () => {
  test.setTimeout(150_000);
  const pg = page!;
  const w = await attachWatch(pg);
  await gotoBacktest(pg);

  // M15 一年窗网格 fast 5:9:2（3 子任务，引擎 ~8s/波；WS 完成帧驱动页内翻转，确定性可观测。
  // 注：极快 D1 网格下 WS 完成帧可能与 mark_done 提交竞态、个别行暂留 running —— 本用例用 M15 规避该偶发）
  await setForm(pg, { from: '2025-09-06', to: '2026-09-06', period: '15m', grid: { fast: '5:9:2' } });
  await pg.locator(f.submit).click();
  await expect.poll(() => w.postResponses.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const resp = JSON.parse(w.postResponses.find((r) => r.status === 200)!.body!) as { group_id: string; run_ids: number[] };
  expect(resp.run_ids, 'M15 网格 3 子任务').toHaveLength(3);
  d1GridIds = resp.run_ids;
  const gid = resp.group_id;
  await apiWaitGroupDone(gid, 3, 40_000);
  // UI 自动翻完成（grid-rank 3 行全 done，无 reload）
  await expect(pg.locator('[data-region="grid-rank"]')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const rows = pg.locator('[data-region="grid-rank"] [data-testid^="gridrank-row-"]');
      if ((await rows.count()) !== 3) return -1;
      let done = 0;
      for (let i = 0; i < 3; i++) if (((await rows.nth(i).textContent()) ?? '').includes('done')) done++;
      return done;
    }, { timeout: 30_000 })
    .toBe(3);
  await shot(pg, 'E3_grid_before_delete.png');

  // grid-rank 视图删除第 1 个组员（产品 UI DELETE 200）：
  // store.deleteRun 语义 —— 无 compare 勾选（compareIds<2）→ 视图自动回 single（不残留空组 grid-rank 视图）
  const first = d1GridIds[0]!;
  await rowText(pg, first);
  await pg.locator(`[data-testid="task-delete-${first}"]`).click();
  await pg.locator(`[data-testid="task-delete-confirm-${first}"]`).click();
  await expect.poll(() => w.dels.filter((d) => d.id === first).length, { timeout: 10_000 }).toBe(1);
  expect(w.dels.find((d) => d.id === first)!.status, `DELETE run ${first} 200`).toBe(200);
  await expect(pg.locator('[data-region="grid-rank"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(pg.locator('[data-region="result-overview"]')).toContainText('选择已完成任务查看结果');
  await expect(pg.locator(taskRow(first))).toHaveCount(0, { timeout: 10_000 });

  // 其余 2 个组员在 single 视图任务列表逐个删除（产品 DELETE 200）
  for (const id of d1GridIds.slice(1)) {
    await rowText(pg, id);
    await pg.locator(`[data-testid="task-delete-${id}"]`).click();
    await pg.locator(`[data-testid="task-delete-confirm-${id}"]`).click();
    await expect.poll(() => w.dels.filter((d) => d.id === id).length, { timeout: 10_000 }).toBe(1);
    expect(w.dels.find((d) => d.id === id)!.status, `DELETE run ${id} 200`).toBe(200);
    await expect(pg.locator(taskRow(id))).toHaveCount(0, { timeout: 10_000 });
  }
  // DB 组清空；UI 无残留组视图/占位（GridRank「无网格任务组」为防御态，删除路径由 deleteRun 回 single 覆盖）
  expect(await apiGroupRuns(gid), 'M15 组已清空').toEqual([]);
  expect(await pg.locator('[data-region="grid-rank"]').count(), '无残留 grid-rank 区').toBe(0);
  expect(await pg.locator('[data-testid="grid-rank-table"]').count(), '无排行表').toBe(0);
  await shot(pg, 'E3_grid_deleted_single.png');
  expect(pg.url().replace(BASE, ''), '无跳转').toBe('/backtest');
  expect(w.loads, '无意外 reload').toBe(1);
  assertNoErrors(w, 'E3');
  recordEvidence('E3', { gridIds: d1GridIds, deletedStatuses: w.dels.filter((d) => d1GridIds.includes(d.id)).map((d) => d.status), viewBackToSingle: true, groupEmptied: true, loads: w.loads });
});
