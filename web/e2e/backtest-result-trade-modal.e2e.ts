import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 回测⑤深度回归 · 批 2b —— 结果图 / 指标卡 / 交易明细弹窗 K 线（真实环境 e2e）。
 *
 * 本文件位置（self-location）：`web/e2e/backtest-result-trade-modal.e2e.ts`
 *
 * 运行对象（真容器，本 spec 只读：不创建 run、不改任何产品代码、无 DB 写入、afterAll 无清理项）：
 *   eestock-app / SPA index-CTRGEV1F.js / http://127.0.0.1:8081（healthy；DB eestock-timescaledb:5433）
 *
 * 数据夹具（既有已完成 run，由本仓库历次回归批创建并保留；id 在 /api/backtest/runs 中复核）：
 *   - run 34：518880 dual_ma D1 多年回测，net_value.series=1555 点（>980 长序列）、49 笔交易、
 *     avg_hold_bars=18.857…（小数长尾取整展示口径）—— 用于结果图/指标卡/长序列回撤着色回归。
 *   - run 33：同上策略 D1，98 点、3 笔、avg_hold_bars=19.0 —— 用于「.0 去尾」取整断言。
 *   - run 84：518880 kdj D1 一年，18 笔：
 *       · 首笔 trade open_ts=1758556800（hold 10）—— 弹窗 D1 缩放/平移拉新数据（分页）；
 *       · 第 3 笔 trade open_ts=1761062400（hold 1、开/平仓 ts 均为 D1 日界 16:00Z 非盘中）——
 *         跨周期切 1m/5m/15m 后 B/S On-Screen（G4 修复回归）；
 *       · 末笔 trade open_ts=1787241600（hold 5、贴近数据末端）—— 默认 D1 视图即见 B/S（同周期精确）。
 *
 * 聚焦范围（只测本批，不碰其它页面）：
 *   R1 结果图：长序列（>980 点）净值+回撤双图；底部时间 x 轴 ≥3 日期刻度（与 API 序列逐刻度一致）；
 *     回撤着色 rect 数与 API 回撤序列一致、全部 width>0（无负宽/无 console.error）；空态占位。
 *   R2 指标卡：8 项与 GET /api/backtest/runs/{id} metrics 逐值一致；平均持仓按口径取整
 *     （小数只留 1 位；.0 去尾），不显示引擎原始长小数。
 *   R3 交易明细弹窗：点交易行 → 弹窗不跳转/不重载；K 线复用看板（默认 run 周期、MA 默认开、VOL 恒开；
 *     周期 1m/5m/15m/日切换；MACD/KDJ/BOLL 指标开关即增删对应 pane）；开/平仓价线 + 区间高亮 + B/S 标记
 *     （同周期 On-Screen 且锚在真实蜡烛列）；切细周期（D1 run → 1m/5m/15m）B/S 仍 On-Screen；
 *     缩放/左平移触发 before 分页请求（before 严格单调前移、蜡烛左缘铺满无空档）；
 *     resize 拖右下角 → 弹窗尺寸 + K 线画布自适应重绘。
 *   全程：pageerror=0 / console.error=0 / 无跳转 / 无 reload（load 计数逐用例断言）。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/backtest_result_trade_modal_2b）。
 * 运行：cd web && npx playwright test e2e/backtest-result-trade-modal.e2e.ts
 * 约束：不 commit；无 staged 文件；证据截图+evidence.json 落 E2E_SHOTS（仓库外）。
 */

test.describe.configure({ retries: 0 }); // 只读真环境回归：失败需原样复跑复核（不隐藏偶发）

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/backtest_result_trade_modal_2b';
mkdirSync(SHOT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* 本批数据夹具（环境里须存在的既有已完成 run；见头部注释） */
const LONG_RUN = 34; // D1 dual_ma 多年：1555 点长序列 / 49 笔
const AVG_INT_RUN = 33; // avg_hold_bars=19.0（.0 去尾）
const MODAL_D1_RUN = 84; // kdj D1 一年：含 日界 hold1 交易（G4 复现）与 末端 hold5 交易
const MODAL_HOLD10_OPEN_TS = 1_758_556_800; // run84 首笔 hold10 → D1 缩放/平移/分页
const MODAL_DAYBOUND_OPEN_TS = 1_761_062_400; // run84 日界 hold1 → 跨周期 B/S On-Screen
const MODAL_TAIL_OPEN_TS = 1_787_241_600; // run84 末端 hold5 → 默认 D1 视图 B/S 精确

/* ───────────────────────────── 产品 API（Node 侧，只读） ───────────────────────────── */

async function apiJson<T>(path: string): Promise<{ status: number; json: T | null }> {
  const r = await fetch(BASE + path);
  let json: T | null = null;
  try {
    json = (await r.json()) as T;
  } catch {
    /* ignore */
  }
  return { status: r.status, json };
}
async function apiRuns(): Promise<Array<{ id: number; code: string; period: string; status: string; strategy_id: string }>> {
  const { json } = await apiJson<Array<{ id: number; code: string; period: string; status: string; strategy_id: string }>>('/api/backtest/runs');
  return json ?? [];
}
async function apiRunDetail(id: number): Promise<Record<string, unknown> | null> {
  const { status, json } = await apiJson<Record<string, unknown>>(`/api/backtest/runs/${id}`);
  return status === 200 ? json : null;
}
interface NetValue { series: Array<[number, number]>; drawdown: Array<[number, number]> }
interface TradeLike { open_ts: number; close_ts: number; open_price: number; close_price: number; shares: number; pnl: number; hold_bars: number; gross_value: number; commission: number; stamp_duty: number }
interface MetricsLike { net_profit: number; max_drawdown: number; sharpe: number; win_rate: number; profit_factor: number; annualized_return: number; trade_count: number; avg_hold_bars: number }

/* ───────────────────────────── 页面通用 helpers ───────────────────────────── */

interface PageWatch {
  perr: string[];
  cerr: string[];
  netErrs: string[];
  loads: number;
}
async function attachWatch(page: Page): Promise<PageWatch> {
  const w: PageWatch = { perr: [], cerr: [], netErrs: [], loads: 0 };
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
  writeFileSync(
    EVIDENCE_FILE,
    JSON.stringify({ case: testName, ts: new Date().toISOString(), facts }) + '\n',
    { flag: 'a' } as never,
  );
}

const taskRow = (id: number) => `[data-testid="task-row-${id}"]`;

/** 注入 canvas fillText 探针：记录 K 线 overlay 文本（B/S）绘制坐标（仅测试进程内，不改产品代码）。 */
const INSTRUMENT_KC_TEXTS = () => {
  const rec: Array<{ t: string; x: number; y: number; w: number; h: number }> = (window as unknown as { __kcTexts: Array<{ t: string; x: number; y: number; w: number; h: number }> }).__kcTexts = [];
  const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, ...rest: unknown[]) {
    try {
      rec.push({ t: String(text), x, y, w: this.canvas ? this.canvas.width : -1, h: this.canvas ? this.canvas.height : -1 });
      if (rec.length > 8000) rec.splice(0, rec.length - 8000);
    } catch {
      /* ignore */
    }
    return orig.call(this, text, x, y, ...(rest as [number, number]));
  };
};
// 每个测试页加载前注入（纯测试探针）
test.beforeEach(async ({ page }) => {
  await page.addInitScript(INSTRUMENT_KC_TEXTS);
});
async function gotoBacktest(page: Page): Promise<void> {
  await page.goto(BASE + '/backtest', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="strategy-form"]', { timeout: 25_000 });
  await page.waitForSelector('[data-testid="param-form"]', { timeout: 25_000 });
}
/** 打开 run 结果（点该行「查看」→ 等净值图 + 指标卡）。 */
async function openRunResult(page: Page, id: number): Promise<void> {
  await page.locator(taskRow(id)).waitFor({ state: 'visible', timeout: 25_000 });
  await page.locator(taskRow(id)).getByRole('button', { name: '查看' }).click();
  await page.waitForSelector('[data-testid="equity-drawdown-chart"]', { timeout: 25_000 });
  await page.waitForSelector('[data-testid^="metric-card-"]', { timeout: 25_000 });
}
/** 打开 run 结果并点某笔交易 → 交易明细弹窗（等 K 线首帧 + 静置）。 */
async function openModalForTrade(page: Page, runId: number, openTs: number): Promise<void> {
  await openRunResult(page, runId);
  const row = page.locator(`[data-testid="trade-row-${openTs}"]`);
  await row.waitFor({ state: 'visible', timeout: 25_000 });
  await row.click();
  await page.waitForSelector('[data-testid="trade-detail-modal"]', { timeout: 15_000 });
  const kc = page.locator('[data-testid="trade-detail-modal"] [data-testid="kline-chart"]');
  await kc.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(2_200); // K 线取数 + overlay B/S 创建静置
}

/* ───────────── K 线画布读取（只在弹窗内；按形状识别 candle/vol/indicator pane） ───────────── */

interface CanvasClassified {
  /** candle base 画布（含蜡烛红/绿列） */
  candle: { w: number; h: number; candleCols: number[]; maxGap: number; minX: number; maxX: number };
  /** candle overlay 画布（价线/B/S/区间高亮） */
  overlay: { w: number; h: number; red: number; green: number; sky: number; amber: number; band: number; redCols: number[]; greenCols: number[] };
  /** 各宽画布高度集合（识别 VOL/指标 pane 数量） */
  wideHeights: number[];
  canvasCount: number;
  dialog: { w: string; h: string };
  kline: { w: number; h: number };
  bs: { B: { t: string; x: number; y: number; w: number; h: number } | null; S: { t: string; x: number; y: number; w: number; h: number } | null };
}
async function readChartState(page: Page): Promise<CanvasClassified> {
  return page.evaluate(() => {
    const cs = [...document.querySelectorAll('[data-testid="trade-detail-modal"] canvas')];
    const geos = cs.map((c) => ({ el: c as HTMLCanvasElement, w: c.width, h: c.height }));
    const maxH = Math.max(...geos.map((g) => g.w > 200 ? g.h : 0));
    const wide = geos.filter((g) => g.w > 200);
    const heights = [...new Set(wide.map((g) => g.h))].sort((a, b) => b - a);
    const candlePair = wide.filter((g) => g.h === maxH);
    // classify: 含大量蜡烛红/绿列为 base，另一个为 overlay
    const classify = (g: { el: HTMLCanvasElement; w: number; h: number }) => {
      const ctx = g.el.getContext('2d')!;
      const d = ctx.getImageData(0, 0, g.w, g.h).data;
      const candleCols = new Set<number>();
      let red = 0, green = 0, sky = 0, amber = 0, band = 0;
      const redCols = new Set<number>(); const greenCols = new Set<number>();
      for (let x = 0; x < g.w; x++) {
        for (let y = 0; y < g.h; y++) {
          const i = (y * g.w + x) * 4;
          const r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3];
          if (a === 255 && r === 255 && gg === 92 && b === 108) { red++; redCols.add(x); }
          else if (a === 255 && r === 0 && gg === 224 && b === 164) { green++; greenCols.add(x); }
          else if (a === 255 && r === 56 && gg === 189 && b === 248) sky++;
          else if (a === 255 && r === 245 && gg === 158 && b === 11) amber++;
          else if (a > 0 && a < 130 && b >= 120 && b > r * 1.8 && gg >= 100) band++;
          // 蜡烛列含 红涨/绿跌/平盘灰（noChange #8b93b0：末根 0 成交 bar 可能以灰渲染）
          if (
            (r === 255 && gg === 92 && b === 108) ||
            (r === 0 && gg === 224 && b === 164) ||
            (r === 139 && gg === 147 && b === 176)
          ) candleCols.add(x);
        }
      }
      return { candleCols, red, green, sky, amber, band, redCols, greenCols };
    };
    const cc = candlePair.map(classify);
    const baseIdx = cc[0].candleCols.size >= cc[1].candleCols.size ? 0 : 1;
    const ovIdx = baseIdx === 0 ? 1 : 0;
    const base = cc[baseIdx]!;
    const ov = cc[ovIdx]!;
    const cols = [...base.candleCols].sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < cols.length; i++) maxGap = Math.max(maxGap, cols[i] - cols[i - 1]);
    // 最新 B/S 文本绘制记录
    const rec = (window as unknown as { __kcTexts?: Array<{ t: string; x: number; y: number; w: number; h: number }> }).__kcTexts ?? [];
    const last: Record<string, { t: string; x: number; y: number; w: number; h: number }> = {};
    for (const e of rec) if (e.t === 'B' || e.t === 'S') last[e.t] = e;
    const dlg = document.querySelector('[data-testid="trade-detail-dialog"]') as HTMLElement | null;
    const kcEl = document.querySelector('[data-testid="trade-detail-modal"] [data-testid="kline-chart"]') as HTMLElement | null;
    return {
      candle: {
        w: candlePair[0]!.w, h: maxH,
        candleCols: cols, maxGap,
        minX: cols.length ? cols[0]! : -1,
        maxX: cols.length ? cols[cols.length - 1]! : -1,
      },
      overlay: {
        w: ov ? candlePair[ovIdx]!.w : 0, h: maxH,
        red: ov ? ov.red : 0, green: ov ? ov.green : 0,
        sky: ov ? ov.sky : 0, amber: ov ? ov.amber : 0, band: ov ? ov.band : 0,
        redCols: ov ? [...ov.redCols].sort((x, y) => x - y) : [],
        greenCols: ov ? [...ov.greenCols].sort((x, y) => x - y) : [],
      },
      wideHeights: heights,
      canvasCount: cs.length,
      dialog: dlg ? { w: dlg.style.width, h: dlg.style.height } : { w: '', h: '' },
      kline: kcEl ? { w: Math.round(kcEl.getBoundingClientRect().width), h: Math.round(kcEl.getBoundingClientRect().height) } : { w: 0, h: 0 },
      bs: { B: last['B'] ?? null, S: last['S'] ?? null },
    };
  });
}
/** 把鼠标移出图区（避免十字线污染像素/文本采样）后读取画布状态。 */
async function readChartStateAway(page: Page): Promise<CanvasClassified> {
  await page.mouse.move(6, 260);
  await page.waitForTimeout(150);
  return readChartState(page);
}

/** 断言 B/S 均 On-Screen（文本 x∈[0,宽]、overlay 单列红/绿与文本对齐）。 */
function expectBsOnScreen(s: CanvasClassified, ctx: string): void {
  const { B, S } = s.bs;
  expect(B, `${ctx}: B 文本已绘制`).not.toBeNull();
  expect(S, `${ctx}: S 文本已绘制`).not.toBeNull();
  const W = Math.max(B!.w, s.candle.w);
  expect(B!.x, `${ctx}: B x 在视口内`).toBeGreaterThanOrEqual(0);
  expect(B!.x, `${ctx}: B x < 画布宽`).toBeLessThan(W);
  expect(S!.x, `${ctx}: S x 在视口内`).toBeGreaterThanOrEqual(0);
  expect(S!.x, `${ctx}: S x < 画布宽`).toBeLessThan(W);
  expect(B!.x, `${ctx}: B 在 S 左侧`).toBeLessThan(S!.x);
  expect(s.overlay.red, `${ctx}: overlay 有 B 红列像素`).toBeGreaterThan(0);
  expect(s.overlay.green, `${ctx}: overlay 有 S 绿列像素`).toBeGreaterThan(0);
  expect(s.overlay.redCols.length, `${ctx}: B 红列为单列簇`).toBe(1);
  expect(s.overlay.greenCols.length, `${ctx}: S 绿列为单列簇`).toBe(1);
  expect(Math.abs(s.overlay.redCols[0]! - B!.x), `${ctx}: 红列与 B 文本对齐(±8)`).toBeLessThanOrEqual(8);
  expect(Math.abs(s.overlay.greenCols[0]! - S!.x), `${ctx}: 绿列与 S 文本对齐(±8)`).toBeLessThanOrEqual(8);
  // 标记列上存在真实蜡烛（同周期精确锚 bar）：以 overlay 红/绿线列（=bar 锚点）比对
  const hasCandle = (col: number) => s.candle.candleCols.some((c) => Math.abs(c - col) <= 3);
  expect(hasCandle(s.overlay.redCols[0]!), `${ctx}: B 锚在真实蜡烛列`).toBe(true);
  expect(hasCandle(s.overlay.greenCols[0]!), `${ctx}: S 锚在真实蜡烛列`).toBe(true);
}

/* ═════════════════════════════════ R1 结果图（长序列） ═════════════════════════════════ */

test('R1a 空态占位：未选任务 → 结果区/交易区占位文案，无跳转/无错误', async ({ page }) => {
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await expect(page.locator('[data-region="result-overview"]')).toContainText('选择已完成任务查看结果');
  await expect(page.locator('[data-region="trade-table"]')).toContainText('本次回测无交易');
  expect(new URL(page.url()).pathname, 'URL 恒 /backtest').toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R1a');
  await shot(page, 'R1a_placeholder.png');
  recordEvidence('R1a', { resultPlaceholder: true, tradePlaceholder: true, loads: w.loads });
});

test('R1b 长序列结果图：净值+回撤 SVG、时间 x 轴 ≥3 日期刻度且与 API 序列一致、回撤着色无负宽', async ({ page }) => {
  const w = await attachWatch(page);
  const runs = await apiRuns();
  const run = runs.find((r) => r.id === LONG_RUN && r.status === 'done');
  expect(run, `夹具 run ${LONG_RUN}（done 长序列 D1）须存在`).toBeTruthy();
  const detail = (await apiRunDetail(LONG_RUN)) as Record<string, unknown> & { net_value?: NetValue; metrics?: MetricsLike };
  const nv = detail?.net_value;
  const series = nv?.series ?? [];
  const dd = nv?.drawdown ?? [];
  expect(series.length, `run ${LONG_RUN} 序列须 >980 点`).toBeGreaterThan(980);

  await gotoBacktest(page);
  await openRunResult(page, LONG_RUN);

  // 净值+回撤双图
  await expect(page.locator('[data-testid="equity-drawdown-chart"]')).toBeVisible();
  // 底部时间 x 轴：预期刻度 = evenTickIndices(5) 采样 + UTC fmtAxis（<31 天日粒度，否则月粒度）
  const firstTs = series[0]![0]; const lastTs = series[series.length - 1]![0];
  const spanDays = (lastTs - firstTs) / 86_400;
  const includeDay = Number.isFinite(spanDays) && spanDays > 0 && spanDays < 31;
  const evenIdx = (n: number) => {
    if (n <= 1) return [0];
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push(Math.round((i * (n - 1)) / 4));
    return [...new Set(out)];
  };
  const fmtAxis = (ts: number) => {
    const d = new Date(ts * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    const ymd = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    return includeDay ? ymd : ymd.slice(0, 7);
  };
  const expectedTicks = evenIdx(series.length).map((i) => fmtAxis(series[i]![0]));
  const tickTexts = await page.locator('[data-testid="chart-x-axis"] span').allTextContents();
  expect(tickTexts.length, 'x 轴 ≥3 个日期刻度').toBeGreaterThanOrEqual(3);
  expect(tickTexts, 'x 轴刻度与 API 序列采样一致').toEqual(expectedTicks);

  // 回撤着色 rect：数量与 API 回撤正值序列一致；width 恒正（长序列 >980 时 step<1 → 钳到 0.5，无负宽）
  const ddPos = dd.filter((d) => d[1] > 0).length;
  const rectInfo = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="equity-drawdown-chart"]')!;
    const rects = [...svg.querySelectorAll('rect')].filter((r) => r.getAttribute('fill') === '#ff5c6c');
    let badW = 0, badX = 0;
    for (const r of rects) {
      const wNum = parseFloat(r.getAttribute('width') ?? 'NaN');
      const xNum = parseFloat(r.getAttribute('x') ?? 'NaN');
      if (!(wNum > 0)) badW++;
      if (!Number.isFinite(xNum) || xNum < 0) badX++;
    }
    return { count: rects.length, badW, badX, width0: rects.filter((r) => r.getAttribute('width') === '0.5').length };
  });
  expect(ddPos, 'API 回撤正值样本存在').toBeGreaterThan(0);
  expect(rectInfo.count, '着色 rect 数 == API 回撤正值数').toBe(ddPos);
  expect(rectInfo.badW, '回撤 rect 无负宽/非正宽').toBe(0);
  expect(rectInfo.badX, '回撤 rect x 合法非负').toBe(0);
  expect(rectInfo.width0, '长序列 rect 宽度钳到 0.5').toBe(ddPos);

  // 净值/收益角标与 API 一致
  const equities = series.map((s) => s[1]);
  const lastEquity = equities[equities.length - 1]!;
  const initial = equities[0]!;
  const ret = (lastEquity - initial) / initial;
  const ddMax = Math.max(...dd.map((d) => d[1]), 0);
  const fmtPct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
  const money = (x: number) => '¥' + x.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  await expect(page.locator('[data-testid="last-equity"]')).toHaveText(`净值 ${lastEquity.toFixed(3)}`);
  const expectedRet = `${ret >= 0 ? '+' : ''}${fmtPct(ret)}（${money(lastEquity)}）`;
  await expect(page.locator('[data-testid="net-return"]')).toHaveText(expectedRet);
  await expect(page.locator('[data-region="result-overview"]')).toContainText(`回撤（最大 −${fmtPct(ddMax)}`);

  expect(new URL(page.url()).pathname).toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R1b');
  const svgShot = await shot(page, 'R1b_long_series_chart.png');
  recordEvidence('R1b', { series: series.length, ddRect: rectInfo.count, ticks: tickTexts, badW: rectInfo.badW, badX: rectInfo.badX, lastEquity: lastEquity.toFixed(3), netReturn: expectedRet, screenshot: svgShot });
});

/* ═════════════════════════════════ R2 指标卡（8 项 vs API） ═════════════════════════════════ */

test('R2a 8 项指标卡与 API 逐值一致（含平均持仓取整 18.857…→18.9bar）', async ({ page }) => {
  const w = await attachWatch(page);
  const detail = (await apiRunDetail(LONG_RUN)) as Record<string, unknown> & { metrics?: MetricsLike };
  const m = detail?.metrics;
  expect(m, 'run 34 metrics 存在').toBeTruthy();

  await gotoBacktest(page);
  await openRunResult(page, LONG_RUN);

  // 8 卡齐全且 label 正确
  const labels: Array<[string, string]> = [
    ['net_profit', 'Net Profit'],
    ['max_drawdown', 'Max Drawdown'],
    ['sharpe', 'Sharpe'],
    ['win_rate', '胜率'],
    ['profit_factor', '盈亏比'],
    ['annualized_return', '年化'],
    ['trade_count', '总交易数'],
    ['avg_hold_bars', '平均持仓'],
  ];
  for (const [key, label] of labels) {
    const card = page.locator(`[data-testid="metric-card-${key}"]`);
    await expect(card, `${key} 卡可见`).toBeVisible();
    await expect(card.locator('div').first(), `${key} label`).toHaveText(label);
  }
  // 数值与 API 逐值一致（格式化口径复刻 src/features/backtest/format.ts，浏览器内 Intl 与产品同源）
  const expected = await page.evaluate((mm) => {
    const pct = (x: number, digits = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(digits)}%`);
    const money = (x: number) => `¥${x.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
    const ratio = (x: number) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2));
    const avg = (x: number) => {
      if (x == null || Number.isNaN(x)) return '—';
      if (x <= 0) return '0';
      const s = x.toFixed(1);
      return `${s.endsWith('.0') ? s.slice(0, -2) : s}bar`;
    };
    return {
      net_profit: money(mm.net_profit),
      max_drawdown: pct(mm.max_drawdown),
      sharpe: ratio(mm.sharpe),
      win_rate: pct(mm.win_rate),
      profit_factor: ratio(mm.profit_factor),
      annualized_return: pct(mm.annualized_return),
      trade_count: String(mm.trade_count),
      avg_hold_bars: avg(mm.avg_hold_bars),
    };
  }, m as MetricsLike);
  for (const key of labels.map(([k]) => k)) {
    const val = await page.locator(`[data-testid="metric-card-${key}"] .num`).textContent();
    expect(val, `${key} 值 == API`).toBe(expected[key as keyof typeof expected]);
  }
  // 平均持仓口径：显示取整值而非引擎原始长小数（18.857142857142858）
  const avgText = await page.locator('[data-testid="metric-card-avg_hold_bars"] .num').textContent();
  expect(avgText, 'avg_hold 取整到 1 位小数（18.9bar）').toBe('18.9bar');
  expect(m!.avg_hold_bars % 1 !== 0, 'API 原始 avg_hold_bars 带小数长尾（前置条件）').toBe(true);

  expect(new URL(page.url()).pathname).toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R2a');
  const s = await shot(page, 'R2a_metric_cards.png');
  recordEvidence('R2a', { api: m, displayedAvg: avgText, screenshot: s });
});

test('R2b 平均持仓 .0 去尾：avg_hold_bars=19.0 → 显示 19bar（非 19.0bar）', async ({ page }) => {
  const w = await attachWatch(page);
  const detail = (await apiRunDetail(AVG_INT_RUN)) as Record<string, unknown> & { metrics?: MetricsLike };
  const m = detail?.metrics;
  expect(m, `run ${AVG_INT_RUN} metrics 存在`).toBeTruthy();
  expect(m!.avg_hold_bars, `run ${AVG_INT_RUN} avg_hold_bars=19（前置条件）`).toBe(19);

  await gotoBacktest(page);
  await openRunResult(page, AVG_INT_RUN);
  const avgText = (await page.locator('[data-testid="metric-card-avg_hold_bars"] .num').textContent()) ?? '';
  expect(avgText, '.0 去尾 → 19bar').toBe('19bar');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R2b');
  recordEvidence('R2b', { apiAvgHoldBars: m!.avg_hold_bars, displayedAvg: avgText });
});

/* ═══════════════════════════ R3 交易明细弹窗（K 线 / B/S / 缩放平移 / resize） ═══════════════════════════ */

test('R3a 弹窗打开：不跳转/不重载、字段与 API 一致、默认周期=run 周期、MA 开、K 线+VOL 渲染', async ({ page }) => {
  test.setTimeout(90_000);
  const w = await attachWatch(page);
  const detail = (await apiRunDetail(MODAL_D1_RUN)) as Record<string, unknown> & { code?: string; period?: string; trades?: TradeLike[] };
  const trade = detail?.trades?.find((t) => t.open_ts === MODAL_DAYBOUND_OPEN_TS);
  expect(trade, `run ${MODAL_D1_RUN} 含日界交易 ${MODAL_DAYBOUND_OPEN_TS}`).toBeTruthy();

  await gotoBacktest(page);
  await openModalForTrade(page, MODAL_D1_RUN, MODAL_DAYBOUND_OPEN_TS);

  const modal = page.locator('[data-testid="trade-detail-modal"]');
  await expect(modal.locator('[data-testid="trade-detail-dialog"] h3')).toHaveText('交易明细');
  // 默认周期 = run 周期 D1（日按钮 pressed）+ MA 默认开
  const pressed = async () => {
    const btns = modal.locator('button[aria-pressed]');
    const map: Record<string, boolean> = {};
    for (let i = 0; i < (await btns.count()); i++) {
      const b = btns.nth(i);
      map[(await b.textContent())?.trim() ?? ''] = (await b.getAttribute('aria-pressed')) === 'true';
    }
    return map;
  };
  expect(await pressed(), '默认周期=日 + MA 开 + 其它指标关').toMatchObject({ '1m': false, '5m': false, '15m': false, 日: true, MA: true, MACD: false, KDJ: false, BOLL: false });

  // 字段 vs API（格式口径：fmtTs=+8 固定、价格 toFixed(3)、数量 zh-CN、盈亏、持仓 Nbar、费用）
  const pctVal = trade!.pnl / (trade!.gross_value - trade!.pnl) || 0;
  const fieldExpected = await page.evaluate(
    ([t, pct]) => {
      const ts = (x: number) => {
        const d = new Date(x * 1000 + 8 * 3_600_000);
        const p = (n: number, l = 2) => String(n).padStart(l, '0');
        return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
      };
      return {
        openTs: ts(t.open_ts), closeTs: ts(t.close_ts),
        openPrice: t.open_price.toFixed(3), closePrice: t.close_price.toFixed(3),
        shares: t.shares.toLocaleString('zh-CN'),
        pnl: `${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`,
        pct: `（${(pct * 100).toFixed(1)}%）`,
        hold: `${t.hold_bars}bar`,
        fee: `佣金 ${t.commission.toFixed(2)} · 印花税 ${t.stamp_duty.toFixed(2)}`,
      };
    },
    [trade as TradeLike, pctVal] as const,
  );
  await expect(modal.locator('[data-testid="td-code"]')).toHaveText(detail!.code!);
  await expect(modal.locator('[data-testid="td-direction"]')).toHaveText('买入');
  await expect(modal.locator('[data-testid="td-open-ts"]')).toHaveText(fieldExpected.openTs);
  await expect(modal.locator('[data-testid="td-close-ts"]')).toHaveText(fieldExpected.closeTs);
  await expect(modal.locator('[data-testid="td-open-price"]')).toHaveText(fieldExpected.openPrice);
  await expect(modal.locator('[data-testid="td-close-price"]')).toHaveText(fieldExpected.closePrice);
  await expect(modal.locator('[data-testid="td-shares"]')).toHaveText(fieldExpected.shares);
  await expect(modal.locator('[data-testid="td-pnl"]')).toHaveText(fieldExpected.pnl);
  await expect(modal.locator('[data-testid="td-pct"]')).toHaveText(fieldExpected.pct);
  await expect(modal.locator('[data-testid="td-hold"]')).toHaveText(fieldExpected.hold);
  if (trade!.commission > 0 || trade!.stamp_duty > 0) {
    await expect(modal.locator('[data-testid="td-fee"]')).toHaveText(fieldExpected.fee);
  }

  // K 线已渲染：candle base 有蜡烛列、VOL pane（宽画布高度含 ~100px 层）、无 console error
  const st = await readChartState(page);
  expect(st.candle.candleCols.length, 'K 线画布有蜡烛列').toBeGreaterThan(10);
  expect(st.wideHeights.some((h) => h > 60 && h < 200), 'VOL 副图 pane 存在').toBe(true);
  expect(st.canvasCount, '画布分层齐全').toBeGreaterThanOrEqual(10);

  // 不跳转/不重载
  expect(new URL(page.url()).pathname, 'URL 恒 /backtest').toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R3a');
  const pressedState = await pressed();

  // 关闭按钮关闭、可再开
  await modal.locator('[data-testid="trade-detail-close"]').click();
  await expect(modal).toHaveCount(0);
  expect(new URL(page.url()).pathname, '关闭后 URL 仍 /backtest').toBe('/backtest');
  expect(w.loads, '关闭后仍无 reload').toBe(1);
  const s = await shot(page, 'R3a_modal_fields_kline.png');
  recordEvidence('R3a', { pressed: pressedState, fieldExpected, canvasCount: st.canvasCount, candleCols: st.candle.candleCols.length, wideHeights: st.wideHeights, screenshot: s });
});

test('R3b 同周期精确：D1 默认视图（末端交易）B/S 可见、锚真实蜡烛列、价线+区间高亮', async ({ page }) => {
  test.setTimeout(90_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await openModalForTrade(page, MODAL_D1_RUN, MODAL_TAIL_OPEN_TS);

  // 默认 D1 视图即见（该交易贴近数据末端 → 交易区间在初始视口内）
  let st = await readChartStateAway(page);
  expect(st.bs.B, 'B 文本已绘制').not.toBeNull();
  expect(st.bs.S, 'S 文本已绘制').not.toBeNull();
  expectBsOnScreen(st, 'R3b D1 默认');
  // 价线（开 sky / 平 amber）+ 区间高亮带（半透明天蓝像素）
  expect(st.overlay.sky, '开仓价线渲染').toBeGreaterThan(0);
  expect(st.overlay.amber, '平仓价线渲染').toBeGreaterThan(0);
  expect(st.overlay.band, '开平仓区间高亮带渲染').toBeGreaterThan(2_000);

  expect(new URL(page.url()).pathname, 'URL 恒 /backtest').toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R3b');
  const s = await shot(page, 'R3b_d1_same_cycle_bs.png');
  recordEvidence('R3b', { bs: st.bs, overlay: st.overlay, candleCols: st.candle.candleCols.length, screenshot: s });
});

test('R3c 周期切换：D1 run 弹窗内切 1m/5m/15m/日 → B/S 重定位 On-Screen（G4 回归）', async ({ page }) => {
  test.setTimeout(180_000);
  const w = await attachWatch(page);
  const modalKlineReqs: Array<{ period: string | null; before: string | null; limit: string | null }> = [];
  const reqUrls = new Set<string>();
  page.on('request', (r) => {
    if (r.url().includes('/api/kline')) {
      const u = new URL(r.url());
      const rec = { period: u.searchParams.get('period'), before: u.searchParams.get('before'), limit: u.searchParams.get('limit') };
      modalKlineReqs.push(rec);
      reqUrls.add(r.url());
    }
  });
  await gotoBacktest(page);
  await openModalForTrade(page, MODAL_D1_RUN, MODAL_DAYBOUND_OPEN_TS);

  const modal = page.locator('[data-testid="trade-detail-modal"]');
  const periodReq = (period: string) =>
    page.waitForResponse(
      (r) => r.url().includes('/api/kline') && new URL(r.url()).searchParams.get('period') === period,
      { timeout: 20_000 },
    );
  const switchPeriod = async (period: string, label: string) => {
    const pr = periodReq(period);
    await modal.getByRole('button', { name: label, exact: true }).click();
    await pr;
    await page.waitForTimeout(1_800); // 蜡烛 + overlay 重绘静置
  };
  // 切细于 run 周期：1m（日界 ts 非盘中 → snap 吸附/钳位 On-Screen，G4 修复回归）
  await switchPeriod('1m', '1m');
  let st = await readChartStateAway(page);
  expectBsOnScreen(st, 'R3c 1m');
  await shot(page, 'R3c_1m_bs_onscreen.png');
  // 5m
  await switchPeriod('5m', '5m');
  st = await readChartStateAway(page);
  expectBsOnScreen(st, 'R3c 5m');
  await shot(page, 'R3c_5m_bs_onscreen.png');
  // 15m
  await switchPeriod('15m', '15m');
  st = await readChartStateAway(page);
  expectBsOnScreen(st, 'R3c 15m');
  await shot(page, 'R3c_15m_bs_onscreen.png');
  // 回日（同 run 周期）
  await switchPeriod('1d', '日');
  st = await readChartStateAway(page);
  // 回到 D1：标记重定位回 D1 列（日界交易位于窗口中段 → 默认视口右锚定，标记可在屏外，
  // 属 004/005 已记录的初始视图口径；此处只断言重绘无残留与周期请求正确）
  expect(st.bs.B && st.bs.S, '回日周期 B/S 重绘').toBeTruthy();

  // 请求证据：每个切换周期各发起 feed 请求且参数正确
  const periods = modalKlineReqs.map((r) => r.period);
  for (const p of ['1d', '1m', '5m', '15m']) {
    expect(periods, `feed 请求含周期 ${p}`).toContain(p);
  }
  const first1m = modalKlineReqs.find((r) => r.period === '1m');
  expect(first1m?.limit, '1m feed 按区间 span+2×buffer 请求').not.toBeNull();
  expect(modalKlineReqs.filter((r) => r.period === '1d' && r.limit === '64').length, 'D1 feed limit=64').toBeGreaterThanOrEqual(1);

  expect(new URL(page.url()).pathname, 'URL 恒 /backtest').toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R3c');
  const s = await shot(page, 'R3c_back_1d.png');
  recordEvidence('R3c', { requests: modalKlineReqs.length, periods, bsAfterBackTo1d: st.bs, screenshot: s });
});

test('R3d 指标开关：MA/MACD/KDJ/BOLL 切换增删 pane（画布数 +4/−4）且 aria-pressed 同步', async ({ page }) => {
  test.setTimeout(120_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await openModalForTrade(page, MODAL_D1_RUN, MODAL_DAYBOUND_OPEN_TS);
  const modal = page.locator('[data-testid="trade-detail-modal"]');
  const btn = (name: string) => modal.getByRole('button', { name, exact: true });
  const countCanvas = async () =>
    page.evaluate(() => document.querySelectorAll('[data-testid="trade-detail-modal"] canvas').length);
  const pressed = async (name: string) => (await btn(name).getAttribute('aria-pressed')) === 'true';

  const baseCount = await countCanvas();
  // 逐个开启：MACD/KDJ/BOLL 各 +4 画布（新 pane：base+overlay+2×y 轴）
  for (const name of ['MACD', 'KDJ', 'BOLL'] as const) {
    const before = await countCanvas();
    await btn(name).click();
    await page.waitForTimeout(900);
    expect(await pressed(name), `${name} aria-pressed=true`).toBe(true);
    expect(await countCanvas(), `${name} 开 → +4 画布`).toBe(before + 4);
  }
  // 关闭 MACD → −4
  await btn('MACD').click();
  await page.waitForTimeout(900);
  expect(await pressed('MACD'), 'MACD aria-pressed=false').toBe(false);
  expect(await countCanvas(), 'MACD 关 → −4 画布').toBe(baseCount + 8);
  // MA 默认开：关 MA 不增删 pane（主图画线，画布数不变）
  expect(await pressed('MA'), 'MA 默认开').toBe(true);
  const beforeMa = await countCanvas();
  await btn('MA').click();
  await page.waitForTimeout(600);
  expect(await pressed('MA'), 'MA off').toBe(false);
  expect(await countCanvas(), 'MA 关不增删 pane').toBe(beforeMa);
  await btn('MA').click();
  await page.waitForTimeout(600);
  expect(await pressed('MA'), 'MA 回开').toBe(true);
  // 关掉全部指标 → 回 baseCount（BOLL/KDJ 关闭）
  await btn('BOLL').click();
  await btn('KDJ').click();
  await page.waitForTimeout(900);
  expect(await countCanvas(), '指标全部关 → 画布数回初始').toBe(baseCount);

  // 开启 MACD 状态下切周期：pane 重建仍保留（画布数保持 MACD on 状态）
  await btn('MACD').click();
  await page.waitForTimeout(700);
  const macdOnCount = await countCanvas();
  const pr1m = page.waitForResponse((r) => r.url().includes('/api/kline') && new URL(r.url()).searchParams.get('period') === '1m', { timeout: 20_000 });
  await modal.getByRole('button', { name: '1m', exact: true }).click();
  await pr1m;
  await page.waitForTimeout(1_800);
  expect(await pressed('MACD'), '切周期后 MACD 保留').toBe(true);
  expect(await countCanvas(), '切周期后 MACD pane 重建').toBe(macdOnCount);

  expect(new URL(page.url()).pathname, 'URL 恒 /backtest').toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R3d');
  const s = await shot(page, 'R3d_indicators.png');
  recordEvidence('R3d', { baseCanvas: baseCount, macdOnCount, screenshot: s });
});

test('R3e resize：拖右下角 → 弹窗宽高变化、K 线画布自适应重绘（宽随容器增/缩）', async ({ page }) => {
  test.setTimeout(120_000);
  const w = await attachWatch(page);
  await gotoBacktest(page);
  await openModalForTrade(page, MODAL_D1_RUN, MODAL_TAIL_OPEN_TS);

  const snap = async () => {
    const st = await readChartStateAway(page);
    return {
      dialogW: st.dialog.w, dialogH: st.dialog.h,
      klineW: st.kline.w, klineH: st.kline.h,
      candleW: st.candle.w,
      candleCols: st.candle.candleCols.length,
      canvasCount: st.canvasCount,
    };
  };
  const before = await snap();
  const rz = page.locator('[data-testid="trade-detail-resize"]');
  const rzBox = await rz.boundingBox();
  expect(rzBox, 'resize 手柄可见').not.toBeNull();
  // 拖大：右下角 (+150,+110)
  await page.mouse.move(rzBox!.x + rzBox!.width - 8, rzBox!.y + rzBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rzBox!.x + rzBox!.width + 150, rzBox!.y + rzBox!.height / 2 + 110, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1_200);
  const afterBig = await snap();
  expect(parseInt(afterBig.dialogW, 10), '弹窗加宽').toBeGreaterThan(parseInt(before.dialogW, 10) + 120);
  expect(parseInt(afterBig.dialogH, 10), '弹窗加高').toBeGreaterThan(parseInt(before.dialogH, 10) + 80);
  expect(afterBig.klineW, 'K 线容器加宽').toBeGreaterThan(before.klineW + 100);
  expect(afterBig.candleW, 'K 线画布宽自适应重绘（> 初始 +100）').toBeGreaterThan(before.candleW + 100);
  expect(afterBig.candleCols, '重绘后仍有蜡烛').toBeGreaterThan(10);
  await shot(page, 'R3e_resize_bigger.png');
  // 拖小：缩回
  const rzBox2 = (await rz.boundingBox())!;
  await page.mouse.move(rzBox2.x + rzBox2.width - 8, rzBox2.y + rzBox2.height / 2);
  await page.mouse.down();
  await page.mouse.move(rzBox2.x + rzBox2.width - 200, rzBox2.y + rzBox2.height / 2 - 80, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1_200);
  const afterSmall = await snap();
  expect(parseInt(afterSmall.dialogW, 10), '弹窗缩回').toBeLessThan(parseInt(afterBig.dialogW, 10));
  expect(afterSmall.candleW, '画布宽随容器缩回').toBeLessThan(afterBig.candleW);

  // resize 后 B/S 仍可见（末端交易默认视图）
  const st = await readChartStateAway(page);
  expectBsOnScreen(st, 'R3e resize 后');
  expect(new URL(page.url()).pathname, 'URL 恒 /backtest').toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R3e');
  const s = await shot(page, 'R3e_resize_smaller.png');
  recordEvidence('R3e', { before, afterBig, afterSmall, screenshot: s });
});

test('R3f 缩放/左平移拉新数据：zoom-out 与左平移各自触发 before 分页（严格单调前移）、蜡烛左缘铺满无空档', async ({ page }) => {
  test.setTimeout(180_000);
  const w = await attachWatch(page);
  const klineReqs: Array<{ period: string | null; before: string | null; limit: string | null }> = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/kline')) {
      const u = new URL(r.url());
      klineReqs.push({ period: u.searchParams.get('period'), before: u.searchParams.get('before'), limit: u.searchParams.get('limit') });
    }
  });
  await gotoBacktest(page);
  // run84 首笔 hold10：D1 feed 窗口 开仓±30bar，左侧仍有大量更早历史（hasMore=true）→ 可拉分页
  await openModalForTrade(page, MODAL_D1_RUN, MODAL_HOLD10_OPEN_TS);
  const kc = page.locator('[data-testid="trade-detail-modal"] [data-testid="kline-chart"]');
  const box = await kc.boundingBox();
  expect(box, 'K 线容器可见').not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const pageCount = () => klineReqs.filter((r) => r.limit === '2' && r.period === '1d').length;

  // 1) 缩放（zoom-out）：视口左缘越过已加载数据 → before 分页（D1 每页 limit=2）
  await page.mouse.move(cx, cy);
  const zoomBase = pageCount();
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(220);
    if (pageCount() - zoomBase >= 8) break;
  }
  await page.waitForTimeout(800);
  const zoomPages = pageCount() - zoomBase;
  expect(zoomPages, 'zoom-out 触发 before 分页请求 ≥3').toBeGreaterThanOrEqual(3);

  // 2) 左平移（拖拽内容右移看更早数据）：继续触发分页
  const panBase = pageCount();
  for (let i = 0; i < 16; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 300, cy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    if (pageCount() - panBase >= 8) break;
  }
  await page.waitForTimeout(1_200);
  const panPages = pageCount() - panBase;
  expect(panPages, '左平移触发 before 分页请求 ≥3').toBeGreaterThanOrEqual(3);
  expect(zoomPages + panPages, '缩放+平移合计分页请求 ≥6').toBeGreaterThanOrEqual(6);

  // 3) 分页正确性：before 严格单调前移（无重复游标）；全程仅 D1 feed
  const pageReqs = klineReqs.filter((r) => r.limit === '2' && r.period === '1d');
  for (let i = 1; i < pageReqs.length; i++) {
    const prev = Date.parse(pageReqs[i - 1]!.before ?? '');
    const cur = Date.parse(pageReqs[i]!.before ?? '');
    expect(cur < prev, `分页 before 严格单调前移（req ${i}）`).toBe(true);
  }
  expect(klineReqs.every((r) => r.period === '1d'), '全程仅 D1 feed').toBe(true);

  // 4) 无空档：拉新数据后蜡烛左缘铺到 x≈0（更早数据已入画），内部最大空隙有界、蜡烛充足
  const st = await readChartStateAway(page);
  expect(st.candle.minX, '分页后蜡烛左缘铺到视口左（≤40px）').toBeLessThanOrEqual(40);
  expect(st.candle.candleCols.length, '分页后蜡烛列充足').toBeGreaterThan(60);
  expect(st.candle.maxGap, '蜡烛列内部无大空档（≤40px）').toBeLessThanOrEqual(40);

  expect(new URL(page.url()).pathname, 'URL 恒 /backtest').toBe('/backtest');
  expect(w.loads, '无 reload').toBe(1);
  assertNoErrors(w, 'R3f');
  const s = await shot(page, 'R3f_pan_loaded.png');
  recordEvidence('R3f', {
    zoomPages, panPages, totalPages: pageReqs.length,
    firstBefore: pageReqs[0]?.before, lastBefore: pageReqs[pageReqs.length - 1]?.before,
    minX: st.candle.minX, maxGap: st.candle.maxGap, candleCols: st.candle.candleCols.length,
    screenshot: s,
  });
});
