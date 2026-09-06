import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { gotoPage } from './helpers/pages';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 看板批 1c — 选中/周期/指标切换后 reload 状态一致 + 重复操作幂等/竞态 + WS 实时不丢状态（真实浏览器 E2E 回归）。
 *
 * 本文件位置（self-location）：`web/e2e/dashboard-state-consistency.e2e.ts`
 *
 * 运行对象（真容器，本 spec 不做任何数据修改——收藏/MA 配置保持只读并在 afterAll 复核不变）：
 *   eestock-app 镜像 3dec9b69f005 / SPA index-B9RewKvL.js / http://127.0.0.1:8081（healthy）。
 *
 * 聚焦范围（单次回归只测这些）：
 *   C1  选中保持：默认选中=API 首行(518880)；选 159577 → 切 日/周/月/1m + 切 MA/MACD → 选中不丢；
 *       reload（URL 无 code）→ 选中回默认首只 + 周期/指标回默认。load 计数=2。
 *   C1b URL-code 契约探测：/?code=161226、/?code=159577（含 reload）应选中该 code（父口径，断言符合性）；
 *       实测 URL 不被读取 → 记录证据，本用例按契约断言（预期 FAIL 交架构师裁决，不改码）。
 *   C2  周期切换竞态：burst A（日→周→月→1m，中间周期 init 响应人为延迟 1.2s 制造乱序）+ burst B
 *       （1h→1h→日→日→周：同周期重复点幂等 + 自然时序）→ 无崩溃/0 pageerror/0 console.error；
 *       最终稳定 = 末次点击周期；迟到响应到达后 canvas 指纹不回退（无旧数据覆盖）；重复点同周期不重复拉 init。
 *   C3  指标开关幂等：MA on→off→on（指纹变化）；MACD/KDJ/BOLL 开/关/合开 pane 计数 10→14→18→22→…→10 精确演进无残留；
 *       与 MA 配置共存（MA(5,10,20) 文本 + GET config 不变）。
 *   C4  缩放/平移后 reload：滚轮 zoom + 拖拽 pan → followLatest=false（回到最新 enabled）→ reload →
 *       回默认（回到最新 disabled、15m init limit=34、canvas 有蜡烛、选中=默认首只）；reload 后 WS bar 注入仍生效。
 *   C5  WS 实时后状态：quote → 列表价格更新；bar → 实时标记 + canvas 变化；选中(159577)/周期(1m)/指标(MACD)
 *       全程不丢；断线 → 重连（conns≥2 + 订阅帧重发）→ 再注入仍生效。load 计数=1。
 *   全程：pageerror=0 / console.error=0 / 无跳转 / 无意外 reload。
 *
 * 断言口径：
 *   - 选中 = 行 data-selected=true（code=b 文本）+ /api/kline 请求 code 参数 双证；
 *   - 周期 = Toolbar aria-pressed + kline period/limit 参数；pane = klinecharts canvas 计数
 *     （单图恒式 4×pane+2：基准 candle+VOL+底轴=10 canvas；每开 1 个非 MA 指标 +4；MA 属 candle overlay 不加 pane）；
 *   - WS：Playwright routeWebSocket 全拦截作虚拟服务端（确定性注入，不依赖盘中推送）；quote 帧
 *     {type:'quote',code,last,changePct}、bar 帧 {type:'bar',code,period,bar:{ts,…}}（ts>末根 → append +
 *     [data-realtime-marker] .num 实时标记）；close() 触发断线 → 客户端指数退避重连 → route 对每次新连接重触发。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/dashboard_state_consistency）。
 */

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/dashboard_state_consistency';
mkdirSync(SHOT, { recursive: true });

const ENV_TAG = `eestock-app img 3dec9b69f005 · SPA index-B9RewKvL.js (批1c: state-consistency) · ${BASE}`;

const PERIOD_OF_BTN: Record<string, { key: string; limit: number }> = {
  日: { key: '1d', limit: 2 },
  周: { key: '1w', limit: 30 },
  月: { key: '1mo', limit: 24 },
  '1m': { key: '1m', limit: 482 },
  '15m': { key: '15m', limit: 34 },
  '1h': { key: '1h', limit: 10 },
};
const CANDLE_BASE_CANVAS = 10; // 单图：candle+VOL+底轴（MA 属 overlay 不增 pane）
const PER_INDICATOR_CANVAS = 4; // 每个非 MA 指标 pane +4 canvas
const MA_DEFAULT = [5, 10, 20];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── 通用 helpers（同批1a/1b 口径） ───────────────────────────── */

function watchErrors(page: Page): { perr: string[]; cerr: string[] } {
  const w = { perr: [] as string[], cerr: [] as string[] };
  page.on('pageerror', (e) => w.perr.push(String(e).slice(0, 500)));
  page.on('console', (m) => {
    if (m.type() === 'error') w.cerr.push(m.text().slice(0, 500));
  });
  return w;
}
function assertNoErrors(w: { perr: string[]; cerr: string[] }, ctx: string) {
  expect(w.perr, `${ctx}: pageerror 应为 0`).toEqual([]);
  expect(w.cerr, `${ctx}: console.error 应为 0`).toEqual([]);
}
function watchLoads(page: Page): { n: number; urls: string[] } {
  const w = { n: 0, urls: [] as string[] };
  page.on('load', () => {
    w.n++;
    w.urls.push(page.url());
  });
  return w;
}

/** 证据截图（env+time 水印） */
async function addTag(page: Page, label: string) {
  await page.evaluate(
    ({ envTag, label }) => {
      document.querySelectorAll('#ev-cap').forEach((e) => e.remove());
      const d = document.createElement('div');
      d.id = 'ev-cap';
      d.style.cssText =
        'position:fixed;top:6px;right:6px;z-index:999999;background:rgba(0,0,0,.72);color:#fff;font:11px/1.5 monospace;padding:4px 8px;border-radius:6px;pointer-events:none;white-space:pre;text-align:right;max-width:560px';
      const t = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      d.textContent = `${envTag}\n${label} · ${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
      document.body.appendChild(d);
    },
    { envTag: ENV_TAG, label },
  );
}
async function shot(page: Page, name: string, label: string) {
  await addTag(page, label);
  await page.waitForTimeout(260);
  await page.screenshot({ path: `${SHOT}/${name}` });
  await page.evaluate(() => document.querySelectorAll('#ev-cap').forEach((e) => e.remove()));
}
function saveJson(name: string, obj: unknown) {
  writeFileSync(`${SHOT}/${name}`, JSON.stringify(obj, null, 1));
}

function toolbarBtn(page: Page, name: string) {
  return page.locator('[data-region="toolbar"]').getByRole('button', { name, exact: true });
}
function chart(page: Page) {
  return page.locator('[data-testid="kline-chart"]');
}
function backLatest(page: Page) {
  return toolbarBtn(page, '回到最新');
}
function selectedCode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-region="symbol-list"] button[data-selected="true"]');
    return row?.querySelector('b')?.textContent?.trim() ?? null;
  });
}
function rowOf(page: Page, code: string) {
  return page
    .locator('[data-region="symbol-list"] button[data-selected]')
    .filter({ has: page.locator('b', { hasText: code }) })
    .first();
}
function rowPrices(page: Page, code: string) {
  return rowOf(page, code).locator('span.shrink-0 span.num');
}

/** 等主图稳定：chart canvas 可见 + 骨架消失 + 缓冲 */
async function waitChart(page: Page, timeout = 30_000) {
  const c = chart(page);
  await expect(c).toBeVisible({ timeout });
  await expect(c.locator('canvas').first()).toBeVisible({ timeout });
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1000);
}

/** kline 请求时间线（request 事件打点 + response 回填） */
interface KReq {
  at: number;
  code: string;
  period: string;
  limit: number;
  before: string | null;
  resp: number | null;
  bars: number;
}
function watchKline(page: Page): KReq[] {
  const list: KReq[] = [];
  const mark = (ev: 'req' | 'resp', urlStr: string, status?: number, bars?: number) => {
    try {
      const u = decodeURIComponent(urlStr);
      if (!u.includes('/api/kline')) return;
      const url = new URL(u);
      const code = url.searchParams.get('code') ?? '';
      const period = url.searchParams.get('period') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 0);
      const before = url.searchParams.get('before');
      const findOpen = () =>
        list.find((r) => r.resp === null && r.code === code && r.period === period && r.limit === limit && r.before === before);
      if (ev === 'req') {
        if (!findOpen()) list.push({ at: Date.now(), code, period, limit, before, resp: null, bars: 0 });
      } else {
        const rec = findOpen();
        if (rec) {
          rec.resp = status ?? 0;
          rec.bars = bars ?? 0;
        }
      }
    } catch {
      /* 忽略 */
    }
  };
  page.on('request', (r) => {
    if (r.url().includes('/api/kline')) mark('req', r.url());
  });
  page.on('response', async (r) => {
    if (!r.url().includes('/api/kline')) return;
    let bars = 0;
    try {
      const j = (await r.json()) as { bars?: unknown[] };
      bars = j.bars?.length ?? 0;
    } catch {
      /* 忽略 */
    }
    mark('resp', r.url(), r.status(), bars);
  });
  return list;
}
const initsOf = (k: KReq[], code: string, period: string, minAt = 0) =>
  k.filter((x) => x.code === code && x.period === period && !x.before && x.at >= minAt);

/** 主图 canvas 内容指纹 */
async function chartFingerprint(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-testid="kline-chart"] canvas'))
      .map((c) => c.toDataURL())
      .join('|'),
  );
}
async function stableFingerprint(page: Page, tries = 10): Promise<string> {
  let prev = '';
  for (let i = 0; i < tries; i++) {
    const h = await chartFingerprint(page);
    if (prev && h === prev) return h;
    prev = h;
    await sleep(400);
  }
  return prev;
}
async function chartCanvasCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-testid="kline-chart"] canvas').length);
}
async function expectCanvasCount(page: Page, expected: number, ctx: string, timeout = 15_000) {
  await expect.poll(() => chartCanvasCount(page), { timeout }).toBe(expected);
}

/** 蜡烛像素计数（红涨 #ff5c6c / 绿跌 #00e0a4 主题，抽样主 canvas；>0 证明蜡烛已绘制） */
async function candlePixels(page: Page): Promise<{ up: number; down: number }> {
  return page.evaluate(() => {
    const cs = Array.from(
      document.querySelectorAll<HTMLCanvasElement>('[data-testid="kline-chart"] canvas'),
    );
    const main = cs
      .filter((c) => c.width > 200 && c.height > 100)
      .sort((a, b) => b.height - a.height)[0];
    if (!main) return { up: -1, down: -1 };
    const ctx = main.getContext('2d');
    if (!ctx) return { up: -2, down: -2 };
    let up = 0;
    let down = 0;
    try {
      const img = ctx.getImageData(0, 0, main.width, Math.min(main.height, 700)).data;
      const near = (p: number[], c: number[]) => p.every((v, i) => Math.abs(v - c[i]) < 45);
      for (let y = Math.floor(main.height * 0.2); y < Math.floor(main.height * 0.85); y += 2)
        for (let x = 0; x < main.width; x += 2) {
          const i = (y * main.width + x) * 4;
          const p = [img[i], img[i + 1], img[i + 2]];
          if (near(p, [255, 92, 108])) up++;
          else if (near(p, [0, 224, 164])) down++;
        }
    } catch {
      return { up: -3, down: -3 };
    }
    return { up, down };
  });
}

/* ───────────────────────────── 产品 API（Node 侧，只读） ───────────────────────────── */

interface ApiSym { code: string; favorite: boolean; favoriteSort: number | null }
async function apiSymbols(): Promise<ApiSym[]> {
  const d = (await (await fetch(BASE + '/api/symbols')).json()) as Array<Record<string, unknown>>;
  return d.map((s) => ({
    code: s.code as string,
    favorite: (s.favorite as boolean) ?? false,
    favoriteSort: (s.favorite_sort as number | null) ?? null,
  }));
}
async function apiFavCodes(): Promise<string[]> {
  const all = await apiSymbols();
  return all
    .filter((s) => s.favorite)
    .sort((a, b) => (a.favoriteSort ?? 0) - (b.favoriteSort ?? 0))
    .map((s) => s.code);
}
async function apiFirstCode(): Promise<string> {
  const all = await apiSymbols();
  return all[0]!.code;
}
async function apiMa(): Promise<number[]> {
  const d = (await (await fetch(BASE + '/api/config/ma')).json()) as { windows: number[] };
  return d.windows;
}
async function apiLastBar(code: string, period: string): Promise<{ ts: string; close: number }> {
  const d = (await (await fetch(`${BASE}/api/kline?code=${code}&period=${period}&limit=1`)).json()) as {
    bars: Array<{ ts: string; close: number }>;
  };
  return d.bars[0]!;
}
const STEP_MS: Record<string, number> = {
  '1m': 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000,
  '1mo': 31 * 86_400_000,
};

/* ───────────────────────────── WS 虚拟服务端（routeWebSocket 全拦截） ───────────────────────────── */

interface WsHandle {
  conns: number;
  frames: string[];
  latest: WebSocketRoute | null;
  send(obj: unknown): void;
  closeServer(): Promise<void>;
}
async function installVirtualWs(page: Page): Promise<WsHandle> {
  const h: WsHandle = {
    conns: 0,
    frames: [],
    latest: null,
    send(obj) {
      if (h.latest) h.latest.send(JSON.stringify(obj));
    },
    async closeServer() {
      if (h.latest) await h.latest.close();
    },
  };
  // 必须 await：路由注册异步完成；未就绪前页面的 WS 连接会直通真实后端（帧不被捕获）
  await page.routeWebSocket('**/ws', (ws) => {
    h.conns++;
    h.latest = ws;
    ws.onMessage((m) => h.frames.push(String(m)));
    ws.onClose(() => {
      /* 页面主动断开 */
    });
  });
  return h;
}
function hasBarSub(h: WsHandle, code: string, period: string): boolean {
  return h.frames.some(
    (f) =>
      f.includes('"topic":"bar"') && f.includes(`"code":"${code}"`) && f.includes(`"period":"${period}"`),
  );
}

/* ───────────────────────────── 环境快照 / afterAll 复核 ───────────────────────────── */

const env = { favIni: [] as string[], maIni: [5, 10, 20] };
test.beforeAll(async () => {
  env.favIni = await apiFavCodes();
  env.maIni = await apiMa();
  expect(env.maIni, '前置：MA 配置默认 [5,10,20]').toEqual(MA_DEFAULT);
});
test.afterAll(async () => {
  // 只读复核：收藏与 MA 配置在本批运行前后必须一致（本批零写入）
  const favNow = await apiFavCodes();
  const maNow = await apiMa();
  expect(favNow, '收藏列表与运行前一致（未触碰）').toEqual(env.favIni);
  expect(maNow, 'MA 配置仍 [5,10,20]（未触碰）').toEqual(MA_DEFAULT);
});

/* ═══════════════════════════ C1 选中保持 + reload 回默认 ═══════════════════════════ */

test('C1 选中保持：切周期/切指标选中不丢；reload(无URL code)回默认首只+周期/指标回默认', async ({ page }) => {
  test.setTimeout(150_000);
  const errs = watchErrors(page);
  const loads = watchLoads(page);
  const kpages = watchKline(page);
  const first = await apiFirstCode();
  const TARGET = '159577';
  expect(first, '环境预置：API 首行存在').toBeTruthy();

  await gotoPage(page, '/');
  await waitChart(page);
  const r = rowOf(page, TARGET);
  expect(await r.count(), '标的 159577 在列表').toBe(1);
  expect(await selectedCode(page), '默认选中=API 首行').toBe(first);
  expect(await toolbarBtn(page, '15m').getAttribute('aria-pressed'), '默认周期 15m').toBe('true');

  // 选 159577
  await r.click();
  await expect
    .poll(() => kpages.some((x) => x.code === TARGET && x.period === '15m' && !x.before), { timeout: 20_000 })
    .toBeTruthy();
  expect(await selectedCode(page), '选中 159577').toBe(TARGET);
  await shot(page, 'C1_0_selected159577.png', '选中 159577（URL 无 code）');

  // 切周期 日→周→月→1m：选中不丢 + kline code 参数跟随
  for (const btn of ['日', '周', '月', '1m']) {
    const { key } = PERIOD_OF_BTN[btn]!;
    await toolbarBtn(page, btn).click();
    await expect(toolbarBtn(page, btn), `周期 ${btn} aria-pressed=true`).toHaveAttribute('aria-pressed', 'true', { timeout: 25_000 });
    await expect
      .poll(() => kpages.some((x) => x.code === TARGET && x.period === key && !x.before), { timeout: 20_000 })
      .toBeTruthy();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(900);
    expect(await selectedCode(page), `切 ${btn} 后选中仍 159577`).toBe(TARGET);
  }
  await shot(page, 'C1_1_after_period_cycle.png', '日→周→月→1m 后选中仍 159577（1m）');

  // 切指标 MA off→on / MACD on→off：选中不丢
  for (const name of ['MA', 'MACD']) {
    const before = await toolbarBtn(page, name).getAttribute('aria-pressed');
    await toolbarBtn(page, name).click();
    await sleep(500);
    expect(await selectedCode(page), `切指标 ${name} 后选中仍 159577`).toBe(TARGET);
    expect(
      await toolbarBtn(page, name).getAttribute('aria-pressed'),
      `指标 ${name} 状态翻转`,
    ).not.toBe(before);
    await toolbarBtn(page, name).click();
    await sleep(500);
    expect(await toolbarBtn(page, name).getAttribute('aria-pressed'), `指标 ${name} 复位`).toBe(before);
    expect(await selectedCode(page), `指标 ${name} 复位后选中仍 159577`).toBe(TARGET);
  }
  await shot(page, 'C1_2_after_indicator_toggle.png', 'MA/MACD 开关后选中仍 159577');

  // reload（URL 无 code）→ 回默认首只 + 15m + MA 默认
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitChart(page);
  expect(await selectedCode(page), 'reload 后选中回默认首只（URL 无 code）').toBe(first);
  expect(await rowOf(page, TARGET).getAttribute('data-selected'), '159577 行不再选中').toBe('false');
  expect(await toolbarBtn(page, '15m').getAttribute('aria-pressed'), 'reload 后周期回 15m').toBe('true');
  expect(await toolbarBtn(page, 'MA').getAttribute('aria-pressed'), 'reload 后 MA 默认开').toBe('true');
  expect(await toolbarBtn(page, 'MACD').getAttribute('aria-pressed'), 'reload 后 MACD 默认关').toBe('false');
  expect(await backLatest(page).isDisabled(), 'reload 后回到最新=disabled（视口最新）').toBeTruthy();
  await expect
    .poll(() => kpages.some((x) => x.code === first && x.period === '15m' && !x.before), { timeout: 20_000 })
    .toBeTruthy();
  expect(loads.n, 'load 计数=2（初始+本次 reload，无意外重载/跳转）').toBe(2);
  expect(page.url().split('?')[0], '仍停留在 /').toBe(BASE + '/');
  await shot(page, 'C1_3_after_reload_default.png', 'reload 后选中回默认首只 ' + first + ' · 15m · MA 默认');

  assertNoErrors(errs, 'C1 全程');
  saveJson('C1.json', {
    target: TARGET,
    first,
    loads: loads.urls,
    selectionAfterReload: await selectedCode(page),
    periodPressedAfterReload: await toolbarBtn(page, '15m').getAttribute('aria-pressed'),
    klineInitSeen: kpages.filter((x) => !x.before).map((x) => ({ code: x.code, period: x.period, limit: x.limit })),
  });
});

test('C1b URL-code 契约探测：/?code= 应选中该只（父口径断言，实测记录证据）', async ({ page }) => {
  test.setTimeout(90_000);
  const errs = watchErrors(page);
  const first = await apiFirstCode();
  const probes: Array<{ url: string; code: string }> = [
    { url: '/?code=161226', code: '161226' },
    { url: '/?code=159577', code: '159577' },
  ];
  const snapshots: Array<{ step: string; url: string; selected: string | null; expect: string }> = [];
  // 先收集全部探测证据（初始 + reload × 2 code），再统一断言（任一不符 → 本用例 FAIL → 证据已齐交架构师）
  for (const p of probes) {
    await gotoPage(page, p.url);
    await waitChart(page);
    const s1 = { step: p.code + '-init', url: page.url(), selected: await selectedCode(page), expect: p.code };
    snapshots.push(s1);
    await shot(page, `C1b_${p.code}_init.png`, `URL-code ${p.url} · selected=${s1.selected}（契约期望 ${p.code}）`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitChart(page);
    const s2 = { step: p.code + '-reload', url: page.url(), selected: await selectedCode(page), expect: p.code };
    snapshots.push(s2);
    await shot(page, `C1b_${p.code}_reload.png`, `URL-code reload ${p.url} · selected=${s2.selected}（契约期望 ${p.code}）`);
  }
  assertNoErrors(errs, 'C1b 全程');
  saveJson('C1b.json', { first, snapshots });
  for (const s of snapshots) {
    // 契约断言：URL 带 code → 应选中该只（部署行为不符 → FAIL，最小复现=goto 该 URL 即选中默认首只，不改码）
    expect(s.selected, `${s.url}（${s.step}）应选中 URL 指定 code=${s.expect}`).toBe(s.expect);
  }
});

/* ═══════════════════════════ C2 周期切换竞态 ═══════════════════════════ */

test('C2 周期连点竞态：乱序迟到响应不回退 + 同周期重复点击幂等 + 无崩溃', async ({ page }) => {
  test.setTimeout(200_000);
  const errs = watchErrors(page);
  const loads = watchLoads(page);
  const ws = await installVirtualWs(page);
  const kpages = watchKline(page);
  const first = await apiFirstCode();

  // 人为延迟 burst 中间周期 init 响应（乱序竞态放大）；delaySet 随 burst 切换
  let delaySet: Record<string, number> = {};
  await page.route('**/api/kline*', async (route) => {
    const u = decodeURIComponent(route.request().url());
    const url = new URL(u);
    const period = url.searchParams.get('period') ?? '';
    const isInit = !url.searchParams.get('before');
    const delay = isInit ? (delaySet[period] ?? 0) : 0;
    if (delay > 0) await sleep(delay);
    await route.continue();
  });

  await gotoPage(page, '/');
  await waitChart(page);
  expect(await selectedCode(page), '竞态全程默认选中').toBe(first);

  /** burst 执行 + 最终稳定断言：早帧 vs 迟到响应到达后的晚帧必须一致（旧数据不覆盖新周期） */
  const burst = async (
    label: string,
    clicks: string[],
    final: string,
    delayPeriods: string[],
  ): Promise<{ start: number; end: number; early: string; late: string }> => {
    const start = Date.now();
    delaySet = Object.fromEntries(delayPeriods.map((k) => [k, 3000])); // 迟到窗口 ≫ 末周期落定+早采样窗口
    for (const btn of clicks) {
      await toolbarBtn(page, btn).evaluate((el) => (el as HTMLButtonElement).click());
      await sleep(45);
    }
    // 等末周期 init 响应已回（minAt=start 保证是本次 burst 的新请求）
    const fk = PERIOD_OF_BTN[final]!.key;
    await expect(toolbarBtn(page, final), `[${label}] ${final} aria-pressed=true`).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await expect
      .poll(
        () => kpages.some((x) => x.code === first && x.period === fk && !x.before && x.at >= start && x.resp !== null),
        { timeout: 25_000 },
      )
      .toBeTruthy();
    await page.mouse.move(1, 1);
    await sleep(700);
    const early = await stableFingerprint(page, 3);
    // 等被延迟的中间周期 init 响应全部到达（乱序迟到窗口关闭）
    if (delayPeriods.length > 0) {
      await expect
        .poll(
          () =>
            delayPeriods.every((p) =>
              kpages.some((x) => x.code === first && x.period === p && !x.before && x.at >= start && x.resp !== null),
            ),
          { timeout: 20_000 },
        )
        .toBeTruthy();
    }
    await sleep(800);
    const late = await stableFingerprint(page, 4);
    expect(late, `[${label}] 迟到/乱序响应到达后 canvas 不回退（无旧数据覆盖新周期）`).toBe(early);
    expect(
      await toolbarBtn(page, final).getAttribute('aria-pressed'),
      `[${label}] 最终稳定周期=末次点击 ${final}`,
    ).toBe('true');
    delaySet = {};
    const sig = (h: string) => `${h.length}:${h.slice(0, 80)}`;
    return { start, end: Date.now(), earlySig: sig(early), lateSig: sig(late), fpStable: early === late };
  };

  // burst A：日→周→月→1m，中间周期 init 响应延迟 1.2s（乱序窗口在末周期落定之后才到达）
  const a = await burst('A', ['日', '周', '月', '1m'], '1m', ['1d', '1w', '1mo']);
  await shot(page, 'C2_A_final_1m.png', 'burst A 后稳定 1m（迟到 日/周/月 init 响应已到、画面未回退）');

  // burst B：同周期重复点击（幂等）+ 自然时序（无延迟），末次 周
  const b = await burst('B', ['1h', '1h', '日', '日', '周'], '周', []);
  await shot(page, 'C2_B_final_1w.png', 'burst B（含同周期重复点）后稳定 周');

  // 幂等：burst 窗口内每周期 init 恰好 1 次（重复点同周期不重复拉 init）
  const windowA = kpages.filter((x) => x.at >= a.start && x.at < b.start);
  const windowB = kpages.filter((x) => x.at >= b.start);
  for (const p of ['1d', '1w', '1mo', '1m']) {
    expect(windowA.filter((x) => x.period === p && !x.before).length, `burst A 窗口内 ${p} init 恰 1 次`).toBe(1);
  }
  for (const p of ['1h', '1d', '1w']) {
    expect(windowB.filter((x) => x.period === p && !x.before).length, `burst B 窗口内 ${p} init 恰 1 次（重复点幂等）`).toBe(1);
  }
  expect(loads.n, '竞态全程无 reload/跳转（load=1）').toBe(1);
  assertNoErrors(errs, 'C2 全程（含两 burst 竞态窗口）');
  saveJson('C2.json', {
    first,
    burstA: { ...a, clicked: ['日', '周', '月', '1m'] },
    burstB: { ...b, clicked: ['1h', '1h', '日', '日', '周'] },
    timelineInits: kpages.filter((x) => !x.before).map((r) => ({ period: r.period, limit: r.limit, resp: r.resp, bars: r.bars })),
    timeline: kpages.map((r) => ({ at: r.at, code: r.code, period: r.period, limit: r.limit, before: r.before, resp: r.resp, bars: r.bars })),
    wsConns: ws.conns,
  });
});

/* ═══════════════════════════ C3 指标开关幂等 ═══════════════════════════ */

test('C3 指标开关幂等：MA on/off/on 指纹；MACD/KDJ/BOLL pane 计数精确演进无残留；MA 配置不受扰', async ({ page }) => {
  test.setTimeout(150_000);
  const errs = watchErrors(page);
  const ws = await installVirtualWs(page);
  await gotoPage(page, '/');
  await waitChart(page);

  // 基线：MA on 单图 pane=10 canvas
  await expectCanvasCount(page, CANDLE_BASE_CANVAS, 'C3 基线 canvas=10');
  const fpBase = await stableFingerprint(page);

  // MA on→off→on：pane 不变、指纹变（主图 MA 线随开关绘制/移除）
  await toolbarBtn(page, 'MA').click();
  await expectCanvasCount(page, CANDLE_BASE_CANVAS, 'MA off 后 pane 不变=10');
  expect(await toolbarBtn(page, 'MA').getAttribute('aria-pressed'), 'MA off').toBe('false');
  const fpMaOff = await stableFingerprint(page);
  expect(fpMaOff, 'MA off 指纹≠on（主图线移除）').not.toBe(fpBase);
  await toolbarBtn(page, 'MA').click();
  await expectCanvasCount(page, CANDLE_BASE_CANVAS, 'MA on 复位 pane=10');
  expect(await toolbarBtn(page, 'MA').getAttribute('aria-pressed'), 'MA on 复位').toBe('true');
  const fpMaOn = await stableFingerprint(page);
  expect(fpMaOn, 'MA on 指纹≠off（主图线恢复）').not.toBe(fpMaOff);

  // 逐个开：MACD(14) → KDJ(18) → BOLL(22)
  for (const [name, expected] of [
    ['MACD', CANDLE_BASE_CANVAS + PER_INDICATOR_CANVAS],
    ['KDJ', CANDLE_BASE_CANVAS + PER_INDICATOR_CANVAS * 2],
    ['BOLL', CANDLE_BASE_CANVAS + PER_INDICATOR_CANVAS * 3],
  ] as const) {
    await toolbarBtn(page, name).click();
    await expectCanvasCount(page, expected, `开 ${name} 后 canvas=${expected}`);
    expect(await toolbarBtn(page, name).getAttribute('aria-pressed'), `${name} on`).toBe('true');
  }
  await shot(page, 'C3_all_on.png', 'MA+MACD+KDJ+BOLL 全开 canvas=22');

  // 反向逐个关：MACD(18) → KDJ(14) → BOLL(10) 无残留
  for (const [name, expected] of [
    ['MACD', CANDLE_BASE_CANVAS + PER_INDICATOR_CANVAS * 2],
    ['KDJ', CANDLE_BASE_CANVAS + PER_INDICATOR_CANVAS],
    ['BOLL', CANDLE_BASE_CANVAS],
  ] as const) {
    await toolbarBtn(page, name).click();
    await expectCanvasCount(page, expected, `关 ${name} 后 canvas=${expected}（无残留 pane）`);
    expect(await toolbarBtn(page, name).getAttribute('aria-pressed'), `${name} off`).toBe('false');
  }

  // 快速连切后终态：MACD/KDJ/BOLL off + MA on → canvas=10（无 pane 残留）
  for (const name of ['MACD', 'KDJ', 'BOLL', 'MACD', 'KDJ', 'BOLL']) {
    await toolbarBtn(page, name).evaluate((el) => (el as HTMLButtonElement).click());
    await sleep(40);
  }
  await expectCanvasCount(page, CANDLE_BASE_CANVAS, '快速连切终态 canvas=10');
  expect(await toolbarBtn(page, 'MA').getAttribute('aria-pressed'), '终态 MA on').toBe('true');
  expect(await toolbarBtn(page, 'MACD').getAttribute('aria-pressed'), '终态 MACD off').toBe('false');
  expect(await toolbarBtn(page, 'KDJ').getAttribute('aria-pressed'), '终态 KDJ off').toBe('false');
  expect(await toolbarBtn(page, 'BOLL').getAttribute('aria-pressed'), '终态 BOLL off').toBe('false');
  expect(await stableFingerprint(page), '快速连切后画面仍在绘制（非空 canvas）').toBeTruthy();
  await shot(page, 'C3_final_reset.png', '指标快速连切后终态：MA on + 其余 off · canvas=10');

  // 与 MA 配置共存：Toolbar 文本 + GET config 不变
  const cfg = await apiMa();
  expect(cfg, 'GET /api/config/ma 仍 [5,10,20]').toEqual(MA_DEFAULT);
  const maCfg = toolbarBtn(page, 'MA 配置'); // aria-label=MA 配置（内容 MA(5,10,20)▾）
  expect(await maCfg.count(), 'MA(5,10,20) 配置按钮仍在').toBe(1);
  expect(await maCfg.textContent(), '配置按钮文本显示 MA(5,10,20)').toContain('MA(5,10,20)');
  expect(page.url().split('?')[0], 'C3 无跳转').toBe(BASE + '/');
  assertNoErrors(errs, 'C3 全程');
  saveJson('C3.json', {
    baseline: CANDLE_BASE_CANVAS,
    perIndicator: PER_INDICATOR_CANVAS,
    finalCanvas: await chartCanvasCount(page),
    maConfig: cfg,
    wsConns: ws.conns,
  });
});

/* ═══════════════════════════ C4 缩放/平移 → reload 回默认 ═══════════════════════════ */

test('C4 手动缩放/平移后 reload：视口/选中/周期/指标回默认；reload 后 WS bar 仍生效', async ({ page }) => {
  test.setTimeout(150_000);
  const errs = watchErrors(page);
  const loads = watchLoads(page);
  const ws = await installVirtualWs(page);
  const kpages = watchKline(page);
  const first = await apiFirstCode();

  await gotoPage(page, '/');
  await waitChart(page);
  const box = (await chart(page).boundingBox())!;
  expect(await backLatest(page).isDisabled(), '初始回到最新 disabled（followLatest=true）').toBeTruthy();

  // 手动缩放：滚轮 zoom → canvas 变化 + followLatest=false（回到最新 enabled）
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
  const fpBefore = await stableFingerprint(page, 4);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -280);
  await sleep(900);
  const fpZoom = await stableFingerprint(page, 4);
  expect(fpZoom, '滚轮 zoom 改变主图（指纹变化）').not.toBe(fpBefore);
  expect(await backLatest(page).isDisabled(), 'zoom 后回到最新 enabled（followLatest=false）').toBeFalsy();

  // 手动平移：整幅拖拽看更早 → 仍 followLatest=false
  const steps = 26;
  const dx = Math.round((box.width * 0.5) / steps);
  const y = box.y + box.height * 0.4;
  await page.mouse.move(box.x + box.width * 0.15, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(box.x + box.width * 0.15 + dx * i, y, { steps: 2 });
  await page.mouse.up();
  await page.mouse.move(1, 1);
  await sleep(1000);
  expect(await backLatest(page).isDisabled(), '拖拽平移后回到最新仍 enabled').toBeFalsy();
  await shot(page, 'C4_0_manual_zoom_pan.png', '手动 zoom+pan 后（回到最新 enabled=followLatest false）');

  // 点「回到最新」：视口回最新且按钮回 disabled（功能回路）
  await backLatest(page).click();
  await sleep(900);
  expect(await backLatest(page).isDisabled(), '点回到最新后回 disabled').toBeTruthy();
  await shot(page, 'C4_1_back_to_latest.png', '点回到最新：视口回最新（按钮 disabled）');

  // 再拖一次（人为离开最新）→ reload
  await page.mouse.move(box.x + box.width * 0.15, y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(box.x + box.width * 0.15 + dx * i, y, { steps: 2 });
  await page.mouse.up();
  await page.mouse.move(1, 1);
  await sleep(800);
  expect(await backLatest(page).isDisabled(), 'reload 前 followLatest=false').toBeFalsy();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitChart(page);
  // reload 后视口/状态回默认
  expect(await backLatest(page).isDisabled(), 'reload 后回到最新 disabled（视口回默认/最新）').toBeTruthy();
  expect(await selectedCode(page), 'reload 后选中=默认首只').toBe(first);
  expect(await toolbarBtn(page, '15m').getAttribute('aria-pressed'), 'reload 后周期=15m 默认').toBe('true');
  expect(await toolbarBtn(page, 'MA').getAttribute('aria-pressed'), 'reload 后 MA 默认 on').toBe('true');
  expect(await toolbarBtn(page, 'MACD').getAttribute('aria-pressed'), 'reload 后 MACD 默认 off').toBe('false');
  const px = await candlePixels(page);
  expect(px.up + px.down, `reload 后蜡烛已绘制（up=${px.up} down=${px.down}）`).toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        kpages.some((x) => x.code === first && x.period === '15m' && !x.before && x.limit === PERIOD_OF_BTN['15m']!.limit),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  // reload 后 WS 推进仍正常：注入 bar(15m) → 实时标记 + canvas 变化
  await expect.poll(() => ws.conns >= 2, { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => hasBarSub(ws, first, '15m'), { timeout: 15_000 }).toBeTruthy();
  const lastBar = await apiLastBar(first, '15m');
  const barTs = new Date(Date.parse(lastBar.ts) + STEP_MS['15m']!).toISOString();
  const close = +(lastBar.close + 0.01).toFixed(3);
  const capBefore = await chartFingerprint(page);
  ws.send({
    type: 'bar',
    code: first,
    period: '15m',
    bar: { ts: barTs, open: lastBar.close, high: +(lastBar.close + 0.02).toFixed(3), low: +(lastBar.close - 0.02).toFixed(3), close, volume: 999999, amount: 9e6 },
  });
  await expect(page.locator('[data-realtime-marker] .num'), 'reload 后 WS bar → 实时标记出现').toBeVisible({ timeout: 15_000 });
  expect((await page.locator('[data-realtime-marker] .num').textContent())!.trim(), '标记价格=注入 close').toBe(close.toFixed(3));
  await expect.poll(async () => (await chartFingerprint(page)) !== capBefore, { timeout: 15_000 }).toBeTruthy();
  expect(await selectedCode(page), 'WS 注入后选中仍默认首只').toBe(first);
  expect(loads.n, 'load 计数=2（初始+reload，无额外重载）').toBe(2);
  await shot(page, 'C4_2_after_reload_ws.png', 'reload 后 WS bar 注入生效（标记 ' + close.toFixed(3) + '）');

  assertNoErrors(errs, 'C4 全程');
  saveJson('C4.json', {
    first,
    zoomChanged: fpZoom !== fpBefore,
    px,
    loads: loads.urls,
    wsConns: ws.conns,
    lastBar,
    injectedTs: barTs,
    marker: await page.locator('[data-realtime-marker] .num').textContent(),
  });
});

/* ═══════════════════════════ C5 WS 实时后状态保持 + 断线重连 ═══════════════════════════ */

test('C5 WS quote/bar 注入后 选中/周期/指标不丢；断线重连后再注入仍生效', async ({ page }) => {
  test.setTimeout(180_000);
  const errs = watchErrors(page);
  const loads = watchLoads(page);
  const ws = await installVirtualWs(page);
  const kpages = watchKline(page);
  const TARGET = '159577';

  await gotoPage(page, '/');
  await waitChart(page);
  // 设定用户状态：选中 159577 + 周期 1m + MACD on
  await rowOf(page, TARGET).click();
  await toolbarBtn(page, '1m').click();
  await toolbarBtn(page, 'MACD').click();
  await expect(toolbarBtn(page, '1m'), '1m aria-pressed=true').toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await expect
    .poll(() => kpages.some((x) => x.code === TARGET && x.period === '1m' && !x.before), { timeout: 20_000 })
    .toBeTruthy();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1100);
  await expectCanvasCount(page, CANDLE_BASE_CANVAS + PER_INDICATOR_CANVAS, 'C5 MACD on canvas=14');
  expect(await selectedCode(page), 'C5 初始选中 159577').toBe(TARGET);
  await expect.poll(() => hasBarSub(ws, TARGET, '1m'), { timeout: 15_000 }).toBeTruthy();

  const stateSnap = async (): Promise<Record<string, unknown>> => ({
    selected: await selectedCode(page),
    period1mPressed: await toolbarBtn(page, '1m').getAttribute('aria-pressed'),
    macdPressed: await toolbarBtn(page, 'MACD').getAttribute('aria-pressed'),
    backLatestDisabled: await backLatest(page).isDisabled(),
    url: page.url(),
  });

  // 注入 quote → 列表行价格更新（仅 159577 行）
  const beforePrice = (await rowPrices(page, TARGET).nth(0).textContent())!.trim();
  const base = parseFloat(beforePrice);
  const q1 = { last: +(base + 0.111).toFixed(3), pct: 1.23 };
  ws.send({ type: 'quote', code: TARGET, last: q1.last, changePct: q1.pct });
  await expect
    .poll(async () => (await rowPrices(page, TARGET).nth(0).textContent())!.trim(), { timeout: 10_000 })
    .toBe(q1.last.toFixed(3));
  expect((await rowPrices(page, TARGET).nth(1).textContent())!.trim(), 'quote 后涨跌幅文本').toBe(`+${q1.pct.toFixed(2)}%`);
  expect(await stateSnap(), 'quote 后 选中/周期/指标不丢').toEqual({
    selected: TARGET,
    period1mPressed: 'true',
    macdPressed: 'true',
    backLatestDisabled: true,
    url: BASE + '/',
  });

  // 注入 bar（1m, ts>末根）→ 实时标记 + canvas 变化 + 状态不丢
  const lastBar = await apiLastBar(TARGET, '1m');
  const barTs1 = new Date(Date.parse(lastBar.ts) + STEP_MS['1m']!).toISOString();
  const c1 = 1.234;
  const capBefore = await chartFingerprint(page);
  ws.send({
    type: 'bar',
    code: TARGET,
    period: '1m',
    bar: { ts: barTs1, open: 1.2, high: 1.25, low: 1.19, close: c1, volume: 88888, amount: 8.8e4 },
  });
  await expect(page.locator('[data-realtime-marker] .num'), 'bar 注入 → 实时标记出现').toBeVisible({ timeout: 15_000 });
  expect((await page.locator('[data-realtime-marker] .num').textContent())!.trim(), '标记价格=注入 close').toBe(c1.toFixed(3));
  await expect.poll(async () => (await chartFingerprint(page)) !== capBefore, { timeout: 15_000 }).toBeTruthy();
  expect(await stateSnap(), 'bar 后 选中/周期/指标不丢').toEqual({
    selected: TARGET,
    period1mPressed: 'true',
    macdPressed: 'true',
    backLatestDisabled: true,
    url: BASE + '/',
  });
  await shot(page, 'C5_1_ws_injected.png', `WS quote(${q1.last.toFixed(3)})+bar(${c1.toFixed(3)}) 注入后：选中 159577 · 1m · MACD`);

  // 断线（服务端 close）→ 自动重连 → 订阅帧重发
  await ws.closeServer();
  await expect.poll(() => ws.conns >= 2, { timeout: 12_000 }).toBeTruthy();
  await expect.poll(() => hasBarSub(ws, TARGET, '1m'), { timeout: 15_000 }).toBeTruthy();

  // 重连后再次注入 quote + bar → 仍生效 + 状态不丢
  const q2 = { last: +(base + 0.333).toFixed(3), pct: -0.87 };
  ws.send({ type: 'quote', code: TARGET, last: q2.last, changePct: q2.pct });
  await expect
    .poll(async () => (await rowPrices(page, TARGET).nth(0).textContent())!.trim(), { timeout: 10_000 })
    .toBe(q2.last.toFixed(3));
  expect((await rowPrices(page, TARGET).nth(1).textContent())!.trim(), '重连后 quote 涨跌幅').toBe(`-${Math.abs(q2.pct).toFixed(2)}%`);
  const c2 = 1.567;
  const barTs2 = new Date(Date.parse(barTs1) + STEP_MS['1m']!).toISOString();
  const cap2Before = await chartFingerprint(page);
  ws.send({
    type: 'bar',
    code: TARGET,
    period: '1m',
    bar: { ts: barTs2, open: c1, high: +(c2 + 0.01).toFixed(3), low: c1, close: c2, volume: 66666, amount: 6.6e4 },
  });
  await expect
    .poll(async () => (await page.locator('[data-realtime-marker] .num').textContent())!.trim(), { timeout: 15_000 })
    .toBe(c2.toFixed(3));
  await expect.poll(async () => (await chartFingerprint(page)) !== cap2Before, { timeout: 15_000 }).toBeTruthy();
  expect(await stateSnap(), '重连注入后 选中/周期/指标仍不丢').toEqual({
    selected: TARGET,
    period1mPressed: 'true',
    macdPressed: 'true',
    backLatestDisabled: true,
    url: BASE + '/',
  });
  await shot(page, 'C5_2_reconnect_injected.png', `断线重连后 quote(${q2.last.toFixed(3)})+bar(${c2.toFixed(3)}) 仍生效`);

  expect(loads.n, 'C5 全程 load=1（无 reload/跳转）').toBe(1);
  assertNoErrors(errs, 'C5 全程');
  saveJson('C5.json', {
    target: TARGET,
    q1,
    q2,
    c1,
    c2,
    barTs1,
    barTs2,
    beforePrice,
    wsConns: ws.conns,
    wsFrames: ws.frames,
    finalState: await stateSnap(),
  });
});
