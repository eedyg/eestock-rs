import { expect, test, type Page } from '@playwright/test';
import { gotoPage } from './helpers/pages';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 看板批 1b — 收藏聚焦回归（星标置顶 / 取消收藏 / 拖拽重排 / reload 持久 / Q4 宫格不受影响）。
 *
 * 本文件位置（self-location）：`web/e2e/dashboard-favorites.e2e.ts`
 *
 * 运行对象（真容器，本 spec 不改任何产品代码；收藏增删全部走产品 API 且在 afterAll 恢复初始态）：
 *   eestock-app 镜像 3dec9b69f005 / SPA index-B9RewKvL.js / http://127.0.0.1:8081（healthy），
 *   含收藏功能 344753b（后端 favorite_symbols+API）+ 0be85f9（前端星标置顶/拖拽重排）。
 *
 * 聚焦范围（单次回归只测这些，不碰其它页面）：
 *   T1 星标置顶：点星（3 只非收藏）→ 立即进收藏区（实心★、favoriteSort 尾部追加、非收藏在下）；
 *      network POST /api/symbols/{code}/favorite ×3 = 200；重复星标幂等（重复 POST 200 无副作用）。
 *   T2 取消收藏：点收藏区 ★ → 移出收藏区回到下方（☆）+ DELETE 200；再点 ☆ 恢复收藏（POST 200）。
 *   T3 拖拽重排：drag handle 拖动 → 顺序变 + PUT /api/symbols/favorites/order body codes 与 DOM 一致
 *      + 200；乐观更新（无回滚 banner，正常路径失败回滚不触发）。
 *   T4 reload 持久：拖拽重排后 reload → 收藏区仍置顶、顺序不变；DB favorite_symbols 行序一致。
 *   T5 Q4 宫格/单图不受影响：2×2 宫格标的集合/顺序在收藏操作（星标/取消/拖拽）下不变；
 *      单图选股/切换（点列表行 + 点宫格格）正常；收藏区与 API 顺序一致。
 *   全程：pageerror=0 / console.error=0 / 无跳转 / 无意外 reload（load 计数逐用例断言）。
 *
 * 断言口径：
 *   - 收藏区顺序以 DOM（button[data-fav] 文档序）为准，与 GET /api/symbols 顺序 / PUT body codes /
 *     DB favorite_symbols(sort_order) 三方对齐；
 *   - 星标 class 以 span[data-star] 的 ★/☆ 文本 + aria-label（取消收藏 X / 收藏 X）为准；
 *   - 用例间状态隔离：每用例开头把收藏恢复到「初始快照 INI」（产品 API：DELETE 多余 + PUT 重排），
 *     afterAll 最终恢复 INI 并复核（对任意初始态都成立：INI 为空/非空均可跑）。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/dashboard_favorites）；
 *   DB 连接（行序证据，可选）：E2E_DB_HOST/PORT/USER/PASS/NAME，默认 127.0.0.1:5433 eestock/eestock/eestock；
 *   psql 不可用时 DB 断言降级为 API 佐证并在报告注明。
 */

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/dashboard_favorites';
mkdirSync(SHOT, { recursive: true });

const ENV_TAG = `eestock-app img 3dec9b69f005 · SPA index-B9RewKvL.js (344753b+0be85f9) · ${BASE}`;

/** 测试用收藏标的（选当前环境非收藏的连续三只；对 INI 任意为空/非空均适用） */
const C1 = '159577';
const C2 = '159638';
const C3 = '159740';
const FAV_PATH_RE = /\/api\/symbols\/(favorites\/order|[^/]+\/favorite)/;

/* ───────────────────────────── 产品 API（Node 侧） ───────────────────────────── */

interface ApiRow { code: string; favorite: boolean; favoriteSort: number | null }
async function apiSymbols(): Promise<ApiRow[]> {
  const d = (await (await fetch(BASE + '/api/symbols')).json()) as Array<Record<string, unknown>>;
  return d.map((s) => ({
    code: s.code as string,
    favorite: (s.favorite as boolean) ?? false,
    favoriteSort: (s.favorite_sort as number | null) ?? null,
  }));
}
/** 收藏 code 列表（按 favoriteSort 升序 = 后端 favorite 优先顺序） */
async function apiFavCodes(): Promise<string[]> {
  const all = await apiSymbols();
  return all
    .filter((s) => s.favorite)
    .sort((a, b) => (a.favoriteSort ?? 0) - (b.favoriteSort ?? 0))
    .map((s) => s.code);
}
async function apiStar(code: string): Promise<number> {
  const r = await fetch(`${BASE}/api/symbols/${encodeURIComponent(code)}/favorite`, { method: 'POST' });
  return r.status;
}
async function apiUnstar(code: string): Promise<number> {
  const r = await fetch(`${BASE}/api/symbols/${encodeURIComponent(code)}/favorite`, { method: 'DELETE' });
  return r.status;
}
async function apiReorder(codes: string[]): Promise<number> {
  const r = await fetch(`${BASE}/api/symbols/favorites/order`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
  return r.status;
}
/** 把收藏恢复到初始快照 iniCodes（幂等；多余 DELETE + 缺失补 star + PUT 归一排序） */
async function restoreTo(iniCodes: string[]): Promise<void> {
  const cur = await apiFavCodes();
  for (const c of cur) if (!iniCodes.includes(c)) expect(await apiUnstar(c), `恢复初始: 删除多余收藏 ${c}`).toBe(200);
  for (const c of iniCodes) if (!cur.includes(c)) expect(await apiStar(c), `恢复初始: 补回缺失收藏 ${c}`).toBe(200);
  const status = await apiReorder(iniCodes);
  expect(status, '恢复初始: PUT 重排 INI 顺序 200').toBe(200);
}

/** DB 行序证据（favorite_symbols order by sort_order）；psql 不可用 → null（降级 API 佐证） */
function dbFavRows(): Array<{ code: string; sort: number }> | null {
  try {
    const out = execSync(
      'psql -X -q -At -c "SELECT code, sort_order FROM favorite_symbols ORDER BY sort_order"',
      {
        env: {
          ...process.env,
          PGHOST: process.env.E2E_DB_HOST ?? '127.0.0.1',
          PGPORT: process.env.E2E_DB_PORT ?? '5433',
          PGUSER: process.env.E2E_DB_USER ?? 'eestock',
          PGPASSWORD: process.env.E2E_DB_PASS ?? 'eestock',
          PGDATABASE: process.env.E2E_DB_NAME ?? 'eestock',
        },
        encoding: 'utf8',
      },
    ).trim();
    if (!out) return [];
    return out.split('\n').map((l) => {
      const [code, sort] = l.split('|');
      return { code: code.trim(), sort: Number(sort.trim()) };
    });
  } catch {
    return null;
  }
}

/* ───────────────────────────── 通用 helpers ───────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** 收藏相关 network 记录（request body / response status） */
interface FavReq { method: string; url: string; body: string | null; phase: string }
interface FavRes { method: string; url: string; status: number; body: string | null; phase: string }
function watchFavNet(page: Page) {
  const reqs: FavReq[] = [];
  const resps: FavRes[] = [];
  let phase = '';
  const setPhase = (p: string) => { phase = p; };
  page.on('request', (r) => {
    if (!FAV_PATH_RE.test(r.url())) return;
    reqs.push({ method: r.method(), url: decodeURIComponent(r.url()).split('/api')[1] ?? r.url(), body: r.postData(), phase });
  });
  page.on('response', (r) => {
    if (!FAV_PATH_RE.test(r.url())) return;
    resps.push({
      method: r.request().method(),
      url: decodeURIComponent(r.url()).split('/api')[1] ?? r.url(),
      status: r.status(),
      body: r.request().postData(),
      phase,
    });
  });
  return { reqs, resps, setPhase };
}

/** 页面 load 计数（无跳转/无意外重载证据：expect(loads.length) == 期望值） */
function watchLoads(page: Page): { urls: string[] } {
  const w: { urls: string[] } = { urls: [] };
  page.on('load', () => w.urls.push(page.url()));
  return w;
}

/** 证据截图（带 env+time caption 水印） */
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
  await sleep(300);
  await page.screenshot({ path: `${SHOT}/${name}` });
  await page.evaluate(() => document.querySelectorAll('#ev-cap').forEach((e) => e.remove()));
}

/** 全部标的行（DOM 文档序；行=直接含 span[data-star] 的 button） */
function readRows(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .filter((b) => b.querySelector(':scope > span[data-star]'))
      .map((b) => {
        const star = b.querySelector(':scope > span[data-star]') as HTMLElement;
        return {
          code: star.dataset.star ?? '',
          fav: !!b.querySelector(':scope > span[data-handle]'),
          starLabel: star.getAttribute('aria-label') ?? '',
          starText: (star.textContent ?? '').trim(),
          selected: b.getAttribute('data-selected') === 'true',
        };
      }),
  );
}
const domFavCodes = async (page: Page) => (await readRows(page)).filter((r) => r.fav).map((r) => r.code);
const domAllCodes = async (page: Page) => (await readRows(page)).map((r) => r.code);
/** DOM 收藏区顺序 == 服务端顺序（favorite 升序 + 非收藏原序）一致性 */
async function expectListMatchesApi(page: Page, ctx: string) {
  const dom = await domAllCodes(page);
  const api = (await apiSymbols()).map((s) => s.code);
  expect(dom, `${ctx}: symbol-list DOM 顺序 == GET /api/symbols 顺序`).toEqual(api);
}
async function expectFavZoneTop(page: Page, ctx: string) {
  const rows = await readRows(page);
  const favN = rows.filter((r) => r.fav).length;
  if (favN > 0) {
    const firstNonFav = rows.findIndex((r) => !r.fav);
    expect(firstNonFav, `${ctx}: 非收藏全部在收藏区之下（firstNonFav=${firstNonFav}, favN=${favN}）`).toBe(favN);
  }
  await expectListMatchesApi(page, ctx);
}

/** 等标的表现就绪（骨架消失 + 行出现 + 稳定） */
async function waitSymbols(page: Page, timeout = 30_000) {
  await expect(page.locator('[data-testid="symbol-list-skeleton"]')).toHaveCount(0, { timeout });
  await expect
    .poll(async () => (await readRows(page)).length, { timeout })
    .toBeGreaterThan(0);
  await page.waitForTimeout(700);
}

async function waitFavCount(page: Page, n: number, timeout = 15_000) {
  await expect.poll(async () => (await domFavCodes(page)).length, { timeout }).toBe(n);
}

/** 单图主图稳定（canvas 可见） */
async function waitChart(page: Page, timeout = 30_000) {
  const chart = page.locator('[data-testid="kline-chart"]');
  await expect(chart).toBeVisible({ timeout });
  await expect(chart.locator('canvas').first()).toBeVisible({ timeout });
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout });
}

/** 宫格 2×2/2×3 就绪：n 格 + 每格首个 canvas 有宽 */
async function waitGrid(page: Page, n: number, timeout = 30_000) {
  const cells = page.locator('[data-region="grid-view"] [data-grid-cell]');
  await expect(cells).toHaveCount(n, { timeout });
  for (let i = 0; i < n; i++) {
    const cv = cells.nth(i).locator('canvas').first();
    await expect(cv).toBeVisible({ timeout });
    await expect
      .poll(() => cv.evaluate((c: HTMLCanvasElement) => c.width), { timeout })
      .toBeGreaterThan(50);
  }
}
const gridCellCodes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-region="grid-view"] [data-grid-cell]'))
      .map((c) => c.querySelector('b')?.textContent?.trim() ?? ''),
  );

/** 拖拽排序期望值（与 SymbolList.handleDrop 同算法：先摘 source 再插入 target 原索引） */
function expectedAfterDrag(order: string[], src: string, dst: string): string[] {
  const next = [...order];
  const from = next.indexOf(src);
  const to = next.indexOf(dst);
  next.splice(from, 1);
  next.splice(to, 0, src);
  return next;
}

/** 把 {code} 拖到 {dstCode} 行（drag handle ⠿ → 目标行）；返回 PUT 响应 */
async function dragFav(page: Page, code: string, dstCode: string) {
  const src = page.locator(`[data-region="symbol-list"] span[data-handle="${code}"]`).first();
  const dst = page
    .locator(`[data-region="symbol-list"] button[data-fav="true"]:has(span[data-star="${dstCode}"])`)
    .first();
  await src.scrollIntoViewIfNeeded();
  await dst.scrollIntoViewIfNeeded();
  const putP = page
    .waitForResponse(
      (r) => r.url().includes('/api/symbols/favorites/order') && r.request().method() === 'PUT',
      { timeout: 15_000 },
    )
    .catch(() => null);
  await src.dragTo(dst);
  return putP;
}

/** 证据 JSON */
function saveJson(name: string, obj: unknown) {
  writeFileSync(`${SHOT}/${name}`, JSON.stringify(obj, null, 1));
}

/* ───────────────────── 全局：初始快照 / 恢复 ───────────────────── */

let INI: string[] = [];
test.beforeAll(async () => {
  // 快照真实初始收藏态（不预清空）；用例自行 restoreTo(INI)
  INI = await apiFavCodes();
  // 预先恢复一次，排除历史残留（若存在非 INI 收藏或排序漂移）
  await restoreTo(INI);
});
test.afterAll(async () => {
  await restoreTo(INI);
  const now = await apiFavCodes();
  expect(now, `afterAll: 收藏已恢复初始态 ${INI.join(',')}（现=${now.join(',')}）`).toEqual(INI);
  const db = dbFavRows();
  if (db) {
    expect(
      db.map((r) => r.code),
      `afterAll: DB favorite_symbols 行序 == INI（${JSON.stringify(db)}）`,
    ).toEqual(INI);
  }
  saveJson('summary.json', { ini: INI, dbAfterAll: db, ts: new Date().toISOString() });
});

test.describe('看板收藏聚焦回归（批1b）', () => {
  test.beforeEach(async () => {
    // 用例隔离：恢复初始收藏态
    await restoreTo(INI);
  });

  /* ───────────────────────────── T1 星标置顶 ───────────────────────────── */

  test('T1 星标置顶：点星立即进收藏区（实心★/尾部追加）+ POST 200 + 重复星标幂等', async ({ page }) => {
    test.setTimeout(180_000);
    const errs = watchErrors(page);
    const net = watchFavNet(page);
    const loads = watchLoads(page);
    await gotoPage(page, '/');
    await waitSymbols(page);
    net.setPhase('baseline');
    expect(await domFavCodes(page), '初始收藏区 == INI').toEqual(INI);
    await expectFavZoneTop(page, 'T1 基线');
    const before = await domFavCodes(page);
    await shot(page, 'T1_0_ini.png', `T1 初始：收藏区 [${INI.join(',')}]（非收藏在下）`);

    // 逐只点星（☆ → ★）：立即进入收藏区尾部（favoriteSort=max+1），POST 200
    const stars: string[] = [C1, C2, C3];
    for (const [i, code] of stars.entries()) {
      net.setPhase(`star-${code}`);
      const postP = page
        .waitForResponse(
          (r) => r.url().endsWith(`/api/symbols/${code}/favorite`) && r.request().method() === 'POST',
          { timeout: 10_000 },
        )
        .catch(() => null);
      const star = page.locator(`[data-region="symbol-list"] span[data-star="${code}"]`).first();
      await star.scrollIntoViewIfNeeded();
      await star.click();
      // 乐观生效：立即变实心★ + 取消收藏 label + 行进收藏区（等其变为 fav 行）
      await expect
        .poll(async () => (await readRows(page)).find((r) => r.code === code)?.fav, { timeout: 10_000 })
        .toBe(true);
      const res = await postP;
      expect(res?.status(), `POST /api/symbols/${code}/favorite 200`).toBe(200);
      await page.waitForTimeout(400);
      const favs = await domFavCodes(page);
      expect(favs, `点星 ${code} 后收藏区 = INI+[已点星]`).toEqual([...before, ...stars.slice(0, i + 1)]);
    }

    // 收藏区行细查：★ 实心 + 取消收藏 label + data-fav + handle；非收藏区在下方 ☆
    const rows = await readRows(page);
    const favN = rows.filter((r) => r.fav).length;
    for (const code of stars) {
      const r = rows.find((x) => x.code === code)!;
      expect(r.fav, `${code} 在收藏区`).toBe(true);
      expect(r.starText, `${code} 实心★`).toBe('★');
      expect(r.starLabel, `${code} aria=取消收藏`).toBe(`取消收藏 ${code}`);
    }
    for (const code of [C1, C2, C3]) {
      expect(
        await page.locator(`[data-region="symbol-list"] button[data-fav="true"] span[data-handle="${code}"]`).count(),
        `${code} 收藏行有 drag handle`,
      ).toBe(1);
    }
    expect(rows[0]!.fav && rows[favN - 1]!.fav, '收藏区整段置顶').toBe(true);
    expect(rows[favN]!.fav, '收藏区之后第一行即非收藏').toBe(false);
    expect(
      await page.locator('[data-region="symbol-list"]', { hasText: '★ 已收藏' }).count(),
      '「★ 已收藏」分组头存在',
    ).toBe(1);
    await expectFavZoneTop(page, 'T1 星标后');
    await shot(page, 'T1_1_starred.png', `T1 三只已收藏置顶：[${(await domFavCodes(page)).join(',')}]`);

    // network：恰好 3 个 POST 全 200；无 DELETE/PUT；无 4xx/5xx
    const posts = net.resps.filter((r) => r.method === 'POST');
    expect(posts.map((p) => p.status), 'T1 POST ×3 全 200').toEqual([200, 200, 200]);
    expect(net.resps.filter((r) => r.method === 'DELETE' || r.url.includes('/favorites/order')), 'T1 无 DELETE/PUT').toEqual([]);
    expect(net.resps.every((r) => r.status >= 200 && r.status < 400), 'T1 无 4xx/5xx').toBe(true);

    // 幂等：额外重复 POST 同一只 → 200 且无副作用（DB 单行、favoriteSort 不变、UI 不变）
    net.setPhase('idempotent');
    const C1SortBefore = (await apiSymbols()).find((s) => s.code === C1)?.favoriteSort ?? -1;
    expect(await apiStar(C1), '幂等重复 POST ×1 200').toBe(200);
    expect(await apiStar(C1), '幂等重复 POST ×2 200').toBe(200);
    await page.waitForTimeout(500);
    const C1SortAfter = (await apiSymbols()).find((s) => s.code === C1)?.favoriteSort ?? -2;
    expect(C1SortAfter, '重复星标不改 favoriteSort').toBe(C1SortBefore);
    expect((await domFavCodes(page)).filter((c) => c === C1).length, 'UI 收藏区仍只有一行 C1').toBe(1);
    const db = dbFavRows();
    if (db) {
      expect(db.filter((r) => r.code === C1).length, `DB favorite_symbols C1 仅 1 行（${JSON.stringify(db)}）`).toBe(1);
    }

    // 无回滚 banner / 无错误 / 无跳转无重载
    expect(await page.getByText('已回滚').count(), 'T1 无回滚 banner').toBe(0);
    expect(await page.getByText('未生效').count(), 'T1 无收藏失败提示').toBe(0);
    assertNoErrors(errs, 'T1 全程');
    expect(loads.urls.length, 'T1 无跳转/无意外 reload（load 仅初始 1 次）').toBe(1);
    expect(page.url(), 'T1 URL 仍为看板首页').toBe(BASE + '/');
    saveJson('T1_star.json', {
      ini: INI,
      starred: stars,
      favAfter: await domFavCodes(page),
      posts: net.resps.filter((r) => r.method === 'POST').map((r) => ({ method: r.method, url: r.url, status: r.status, phase: r.phase })),
      idempotent: { C1SortBefore, C1SortAfter },
      db: db,
      loads: loads.urls.length,
      perr: errs.perr.length,
      cerr: errs.cerr.length,
    });
  });

  /* ───────────────────────────── T2 取消收藏 ───────────────────────────── */

  test('T2 取消收藏：点收藏区★ → 移出回到下方(☆) + DELETE 200 + 再点☆恢复收藏(POST 200)', async ({ page }) => {
    test.setTimeout(180_000);
    const errs = watchErrors(page);
    const net = watchFavNet(page);
    const loads = watchLoads(page);
    // 预置：INI + C1（产品 API 收藏，页面 reload 呈现）
    expect(await apiStar(C1), '预置 C1 收藏 200').toBe(200);
    await gotoPage(page, '/');
    await waitSymbols(page);
    await waitFavCount(page, INI.length + 1);
    expect(await domFavCodes(page), '预置后收藏区 = INI+[C1]').toEqual([...INI, C1]);
    await shot(page, 'T2_0_pre.png', `T2 预置：INI+[${C1}] 收藏置顶`);

    // 取消收藏：点收藏区 C1 的实心★ → 移出收藏区（☆，回到非收藏下方）
    net.setPhase('unstar');
    const delP = page
      .waitForResponse(
        (r) => r.url().endsWith(`/api/symbols/${C1}/favorite`) && r.request().method() === 'DELETE',
        { timeout: 10_000 },
      )
      .catch(() => null);
    await page.locator(`[data-region="symbol-list"] span[data-star="${C1}"]`).first().click();
    await expect
      .poll(async () => (await readRows(page)).find((r) => r.code === C1)?.starLabel, { timeout: 10_000 })
      .toBe(`收藏 ${C1}`);
    const delRes = await delP;
    expect(delRes?.status(), 'DELETE /api/symbols/C1/favorite 200').toBe(200);
    await page.waitForTimeout(400);
    let favs = await domFavCodes(page);
    expect(favs, '取消收藏后收藏区 == INI').toEqual(INI);
    const rowC1 = (await readRows(page)).find((r) => r.code === C1)!;
    expect(rowC1.fav, 'C1 已不在收藏区').toBe(false);
    expect(rowC1.starText, 'C1 恢复空心☆').toBe('☆');
    const rowsAll = await readRows(page);
    const favN = rowsAll.filter((r) => r.fav).length;
    expect(rowsAll.findIndex((r) => r.code === C1), 'C1 行回到非收藏区（收藏区之下第一段）').toBeGreaterThanOrEqual(favN);
    expect((await apiSymbols()).find((s) => s.code === C1)?.favorite, 'API favorite=false').toBe(false);
    await shot(page, 'T2_1_unstarred.png', 'T2 取消收藏：C1 移出收藏区（☆ 回下方）');

    // 再收藏：点 ☆ → 恢复（尾部追加 sort=max+1），POST 200
    net.setPhase('restar');
    const postP = page
      .waitForResponse(
        (r) => r.url().endsWith(`/api/symbols/${C1}/favorite`) && r.request().method() === 'POST',
        { timeout: 10_000 },
      )
      .catch(() => null);
    await page.locator(`[data-region="symbol-list"] span[data-star="${C1}"]`).first().click();
    await expect
      .poll(async () => (await readRows(page)).find((r) => r.code === C1)?.fav, { timeout: 10_000 })
      .toBe(true);
    const postRes = await postP;
    expect(postRes?.status(), '再收藏 POST /api/symbols/C1/favorite 200').toBe(200);
    await page.waitForTimeout(400);
    favs = await domFavCodes(page);
    expect(favs, '再收藏后收藏区 = INI+[C1]（尾部）').toEqual([...INI, C1]);

    // 其它收藏未受影响（顺序/数量）
    expect(favs.slice(0, INI.length), 'INI 收藏顺序未变').toEqual(INI);
    expect(net.resps.filter((r) => r.method === 'DELETE').length, '恰好 1 次 DELETE').toBe(1);
    expect(net.resps.filter((r) => r.method === 'POST').length, '恰好 1 次 POST（再收藏）').toBe(1);
    expect(net.resps.every((r) => r.status === 200), 'T2 全部网络 200').toBe(true);
    expect(await page.getByText('已回滚').count(), 'T2 无回滚 banner').toBe(0);
    await expectFavZoneTop(page, 'T2 结束');
    await shot(page, 'T2_2_restarred.png', `T2 再收藏恢复：收藏区 [${favs.join(',')}]`);
    assertNoErrors(errs, 'T2 全程');
    expect(loads.urls.length, 'T2 无跳转/无意外 reload').toBe(1);
    saveJson('T2_unstar.json', {
      ini: INI,
      net: net.resps.map((r) => ({ method: r.method, url: r.url, status: r.status, phase: r.phase })),
      favFinal: favs,
      loads: loads.urls.length,
      perr: errs.perr.length,
      cerr: errs.cerr.length,
    });
  });

  /* ───────────────────────────── T3 拖拽重排 ───────────────────────────── */

  test('T3 拖拽重排：drag handle → 顺序变 + PUT body codes==DOM + 200 + 乐观更新无回滚', async ({ page }) => {
    test.setTimeout(180_000);
    const errs = watchErrors(page);
    const net = watchFavNet(page);
    const loads = watchLoads(page);
    // 预置 INI+C1,C2,C3（尾部 7,8,9）
    for (const c of [C1, C2, C3]) expect(await apiStar(c), `预置 star ${c} 200`).toBe(200);
    await gotoPage(page, '/');
    await waitSymbols(page);
    await waitFavCount(page, INI.length + 3);
    const before = await domFavCodes(page);
    expect(before, '预置顺序 INI+[C1,C2,C3]').toEqual([...INI, C1, C2, C3]);
    await expectFavZoneTop(page, 'T3 预置');
    await shot(page, 'T3_0_before.png', `T3 拖拽前：[${before.join(',')}]`);

    // 拖 C3 到 C2 行上 → 期望 [.., C1, C3, C2]
    const expected = expectedAfterDrag(before, C3, C2);
    net.setPhase('drag');
    const putRes = await dragFav(page, C3, C2);
    await page.waitForTimeout(700);
    const after = await domFavCodes(page);
    expect(after, `拖拽后收藏区顺序 == 期望 ${expected.join(',')}`).toEqual(expected);
    expect(putRes?.status(), 'PUT /api/symbols/favorites/order 200').toBe(200);
    const putRec = net.resps.find((r) => r.method === 'PUT' && r.url.includes('/favorites/order'));
    const bodyCodes = putRec?.body ? (JSON.parse(putRec.body) as { codes: string[] }).codes : null;
    expect(bodyCodes, 'PUT body codes 与拖拽后 DOM 收藏区一致').toEqual(after);
    // 服务端落库顺序一致
    expect(await apiFavCodes(), 'API 收藏顺序 == DOM').toEqual(after);
    const db = dbFavRows();
    if (db) expect(db.map((r) => r.code), `DB favorite_symbols 行序 == DOM（${JSON.stringify(db)}）`).toEqual(after);
    expect(net.resps.filter((r) => r.method === 'PUT').length, '恰好 1 次 PUT').toBe(1);
    expect(await page.getByText('已回滚').count(), 'T3 无失败回滚 banner（乐观更新成功路径）').toBe(0);
    await expectFavZoneTop(page, 'T3 拖拽后');
    await shot(page, 'T3_1_after.png', `T3 拖拽后：[${after.join(',')}]（PUT codes 一致）`);
    assertNoErrors(errs, 'T3 全程');
    expect(loads.urls.length, 'T3 无跳转/无意外 reload').toBe(1);
    saveJson('T3_drag.json', {
      ini: INI,
      before,
      after,
      expected,
      put: { status: putRes?.status, bodyCodes },
      db,
      loads: loads.urls.length,
      perr: errs.perr.length,
      cerr: errs.cerr.length,
    });
  });

  /* ───────────────────────────── T4 reload 持久 ───────────────────────────── */

  test('T4 持久：reload 后收藏区仍置顶、顺序不变 + DB favorite_symbols 行序一致', async ({ page }) => {
    test.setTimeout(180_000);
    const errs = watchErrors(page);
    const net = watchFavNet(page);
    const loads = watchLoads(page);
    // 预置 INI+C1,C2,C3 → UI 拖拽 C3→C2（与服务端一致的持久态）→ reload 复核
    for (const c of [C1, C2, C3]) expect(await apiStar(c), `预置 star ${c} 200`).toBe(200);
    await gotoPage(page, '/');
    await waitSymbols(page);
    await waitFavCount(page, INI.length + 3);
    const before = await domFavCodes(page);
    const expected = expectedAfterDrag(before, C3, C2);
    const putRes = await dragFav(page, C3, C2);
    await page.waitForTimeout(700);
    expect(await domFavCodes(page), '拖拽生效').toEqual(expected);
    expect(putRes?.status(), 'PUT 200').toBe(200);
    await shot(page, 'T4_0_pre_reload.png', `T4 reload 前：[${expected.join(',')}]`);

    // reload：收藏仍置顶、顺序不变
    const preApi = await apiFavCodes();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitSymbols(page);
    await waitFavCount(page, INI.length + 3);
    const post = await domFavCodes(page);
    expect(post, 'reload 后收藏区顺序不变').toEqual(preApi);
    expect(post, 'reload 后 == reload 前').toEqual(expected);
    const rows = await readRows(page);
    const favN = rows.filter((r) => r.fav).length;
    expect(rows.findIndex((r) => !r.fav), 'reload 后非收藏仍在收藏区之下').toBe(favN);
    await expectListMatchesApi(page, 'T4 reload 后');
    // DB 行序
    const db = dbFavRows();
    if (db) {
      expect(db.map((r) => r.code), `DB favorite_symbols 行序 == DOM（${JSON.stringify(db)}）`).toEqual(post);
      const idx = new Map(db.map((r, i) => [r.code, i]));
      expect(post.map((c) => idx.get(c)), 'DB sort_order 与展示顺序一一对应').toEqual(post.map((_, i) => i));
    }
    // 每只 ★ 状态与 API 一致
    const apiRows = await apiSymbols();
    for (const code of post) {
      expect((await readRows(page)).find((r) => r.code === code)?.starText, `reload 后 ${code} 实心★`).toBe('★');
    }
    expect(apiRows.filter((s) => s.favorite).length, 'API favorite 数一致').toBe(post.length);
    await shot(page, 'T4_1_after_reload.png', `T4 reload 后仍置顶：[${post.join(',')}]`);
    expect(net.resps.filter((r) => r.method === 'PUT').length, 'T4 reload 阶段无多余 PUT').toBe(1);
    assertNoErrors(errs, 'T4 全程');
    expect(loads.urls.length, 'T4 load 计数 = 2（初始 + 1 次 reload，无意外重载）').toBe(2);
    saveJson('T4_persist.json', {
      ini: INI,
      before,
      afterReload: post,
      db,
      put: { status: putRes?.status },
      loads: loads.urls.length,
      perr: errs.perr.length,
      cerr: errs.cerr.length,
    });
  });

  /* ───────────────────────────── T5 Q4 宫格/单图 ───────────────────────────── */

  test('T5 Q4：星标/取消/拖拽不改变 2×2 宫格集合与顺序；单图选股与切换正常', async ({ page }) => {
    test.setTimeout(240_000);
    const errs = watchErrors(page);
    const net = watchFavNet(page);
    const loads = watchLoads(page);
    const klineReqs: Array<{ code: string; status: number }> = [];
    page.on('response', (r) => {
      if (!r.url().includes('/api/kline')) return;
      const code = new URL(r.url()).searchParams.get('code');
      if (code) klineReqs.push({ code, status: r.status() });
    });
    const toolbar = () => page.locator('[data-region="toolbar"]');

    await gotoPage(page, '/');
    await waitSymbols(page);
    await waitFavCount(page, INI.length);
    expect(await domFavCodes(page), '基线收藏区 == INI').toEqual(INI);
    await shot(page, 'T5_0_baseline.png', 'T5 基线：单图 + INI 收藏区');

    // 2×2 宫格基线
    await toolbar().getByRole('button', { name: '2×2', exact: true }).click();
    await waitGrid(page, 4);
    const grid0 = await gridCellCodes(page);
    expect(grid0.length, '2×2 宫格 4 格').toBe(4);
    await expect
      .poll(() => page.locator('[data-region="grid-view"] canvas').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await shot(page, 'T5_1_grid_base.png', `T5 宫格基线：${grid0.join(',')}`);

    // 宫格展示集合==服务端前 4（state.symbols.slice，与收藏分区无关）
    const apiFirst4 = (await apiSymbols()).slice(0, 4).map((s) => s.code);
    expect(grid0, '宫格集合/顺序 == GET /api/symbols 前 4（收藏优先序由服务端排，展示用 store 顺序）').toEqual(apiFirst4);

    // 星标 C1/C2（宫格开着）→ 宫格不变
    for (const code of [C1, C2]) {
      const postP = page
        .waitForResponse(
          (r) => r.url().endsWith(`/api/symbols/${code}/favorite`) && r.request().method() === 'POST',
          { timeout: 10_000 },
        )
        .catch(() => null);
      await page.locator(`[data-region="symbol-list"] span[data-star="${code}"]`).first().click();
      await expect
        .poll(async () => (await readRows(page)).find((r) => r.code === code)?.fav, { timeout: 10_000 })
        .toBe(true);
      expect((await postP)?.status(), `T5 星标 ${code} POST 200`).toBe(200);
      await page.waitForTimeout(400);
    }
    await waitFavCount(page, INI.length + 2);
    expect(await gridCellCodes(page), '星标后宫格集合/顺序不变').toEqual(grid0);
    await shot(page, 'T5_2_grid_after_star.png', 'T5 星标×2 后宫格不变');

    // 拖拽 C2 → C1（宫格开着）→ 宫格不变 + PUT 200
    const favsNow = await domFavCodes(page);
    const expectedDrag = expectedAfterDrag(favsNow, C2, C1);
    const putRes = await dragFav(page, C2, C1);
    await page.waitForTimeout(600);
    expect(await domFavCodes(page), 'T5 拖拽排序生效').toEqual(expectedDrag);
    expect(putRes?.status(), 'T5 PUT 200').toBe(200);
    expect(await gridCellCodes(page), '拖拽后宫格集合/顺序不变').toEqual(grid0);
    await shot(page, 'T5_3_grid_after_drag.png', 'T5 拖拽排序后宫格不变');

    // 取消收藏「宫格第 1 格标的」（INI[0]）→ 宫格不变；再收藏恢复 → 宫格不变
    const cell0 = grid0[0]!;
    net.setPhase('cell0-unstar');
    const delP = page
      .waitForResponse(
        (r) => r.url().endsWith(`/api/symbols/${cell0}/favorite`) && r.request().method() === 'DELETE',
        { timeout: 10_000 },
      )
      .catch(() => null);
    await page.locator(`[data-region="symbol-list"] span[data-star="${cell0}"]`).first().click();
    await expect
      .poll(async () => (await readRows(page)).find((r) => r.code === cell0)?.starLabel, { timeout: 10_000 })
      .toBe(`收藏 ${cell0}`);
    expect((await delP)?.status(), `T5 取消收藏 ${cell0} DELETE 200`).toBe(200);
    await page.waitForTimeout(500);
    expect(await gridCellCodes(page), '取消收藏（含宫格第1格标的）后宫格不变').toEqual(grid0);
    net.setPhase('cell0-restar');
    const reP = page
      .waitForResponse(
        (r) => r.url().endsWith(`/api/symbols/${cell0}/favorite`) && r.request().method() === 'POST',
        { timeout: 10_000 },
      )
      .catch(() => null);
    await page.locator(`[data-region="symbol-list"] span[data-star="${cell0}"]`).first().click();
    await expect
      .poll(async () => (await readRows(page)).find((r) => r.code === cell0)?.fav, { timeout: 10_000 })
      .toBe(true);
    expect((await reP)?.status(), `T5 再收藏 ${cell0} POST 200`).toBe(200);
    await page.waitForTimeout(500);
    expect(await gridCellCodes(page), '再收藏后宫格集合/顺序不变').toEqual(grid0);
    await shot(page, 'T5_4_grid_cell0_toggle.png', 'T5 取消/恢复宫格第1格标的后宫格不变');

    // 单图选股/切换：列表点非收藏行 → 主图跟随；再点收藏行 → 切换正常
    const k0 = klineReqs.length;
    await toolbar().getByRole('button', { name: '单图', exact: true }).click();
    await waitChart(page);
    // 选非收藏行（收藏区之下的第一只）
    const rows = await readRows(page);
    const favN = rows.filter((r) => r.fav).length;
    const nonFav = rows.slice(favN).find((r) => !r.fav);
    expect(nonFav, '存在非收藏行').toBeTruthy();
    await page
      .locator(`[data-region="symbol-list"] button:has(span[data-star="${nonFav!.code}"]):not([data-fav="true"])`)
      .first()
      .click();
    await expect
      .poll(async () => (await readRows(page)).find((r) => r.selected)?.code, { timeout: 10_000 })
      .toBe(nonFav!.code);
    await expect
      .poll(() => klineReqs.slice(k0).some((r) => r.code === nonFav!.code && r.status === 200), { timeout: 15_000 })
      .toBe(true);
    await page.waitForTimeout(900);
    const k1 = klineReqs.length;
    // 选收藏行（收藏区第一只）
    const favFirst = rows.find((r) => r.fav)!.code;
    await page
      .locator(`[data-region="symbol-list"] button[data-fav="true"]:has(span[data-star="${favFirst}"])`)
      .first()
      .click();
    await expect
      .poll(async () => (await readRows(page)).find((r) => r.selected)?.code, { timeout: 10_000 })
      .toBe(favFirst);
    await expect
      .poll(() => klineReqs.slice(k1).some((r) => r.code === favFirst && r.status === 200), { timeout: 15_000 })
      .toBe(true);
    await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible();
    await shot(page, 'T5_5_single.png', `T5 单图选股 ${favFirst} 正常（主图渲染）`);

    // 宫格点格 → 回单图并切到该格标的
    await toolbar().getByRole('button', { name: '2×2', exact: true }).click();
    await waitGrid(page, 4);
    const pick = grid0[2]!;
    const k2 = klineReqs.length;
    await page.locator('[data-region="grid-view"] [data-grid-cell]').nth(2).locator('b').first().click();
    await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await readRows(page)).find((r) => r.selected)?.code, { timeout: 10_000 })
      .toBe(pick);
    await expect
      .poll(() => klineReqs.slice(k2).some((r) => r.code === pick && r.status === 200), { timeout: 15_000 })
      .toBe(true);

    // 收藏区与 API 一致（此时为点格后的单图视图）
    await expectFavZoneTop(page, 'T5 结束');

    // 再次回到 2×2：宫格集合/顺序与全程收集的 grid0 完全一致（点格切换标的也不影响宫格序）
    await toolbar().getByRole('button', { name: '2×2', exact: true }).click();
    await waitGrid(page, 4);
    const gridFinal = await gridCellCodes(page);
    expect(gridFinal, '宫格集合/顺序全程不变（含点格切标的后）').toEqual(grid0);

    const db = dbFavRows();
    expect(await page.getByText('已回滚').count(), 'T5 无回滚 banner').toBe(0);
    assertNoErrors(errs, 'T5 全程');
    expect(loads.urls.length, 'T5 无跳转/无意外 reload').toBe(1);
    await shot(page, 'T5_6_final.png', `T5 收尾：收藏区置顶有序 + 宫格=[${gridFinal.join(',')}] 不变`);
    saveJson('T5_grid_single.json', {
      ini: INI,
      grid0,
      apiFirst4,
      gridFinal,
      put: { status: putRes?.status },
      klineCodes: [...new Set(klineReqs.map((r) => r.code))],
      db,
      loads: loads.urls.length,
      perr: errs.perr.length,
      cerr: errs.cerr.length,
    });
  });
});
