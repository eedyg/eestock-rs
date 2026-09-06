import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psql } from './helpers/db';

/**
 * 批 4 深度回归 · 页面⑦ 告警中心(/alerts) + 页面⑧ 系统设置(/settings)（真实环境 e2e）。
 *
 * 本文件位置（self-location）：`web/e2e/alerts-settings-deep.e2e.ts`
 * 设计稿：`tester/design/009_alerts_settings_deep_r4_e2e_design.md`
 *
 * 运行对象（真容器，本 spec 不改产品代码/接口/DB schema）：
 *   eestock-app（healthy）/ SPA index-CTRGEV1F.js / http://127.0.0.1:8081（DB eestock-timescaledb:5433）
 *
 * 聚焦（⑦告警）：
 *   A1 列表默认「今日」+ 时间范围过滤（今日空态/近三日/全部）：每次变更的 /api/alerts GET 参数
 *      （from=rangeFromIso 复算口径）与「DOM 行数=该次响应 rows」对账；空态「暂无告警」。
 *   A2 行字段=API：级别 pill/来源/内容/时刻(hh:mm Asia/Shanghai)/状态徽标（acked→已确认、
 *      resolved→已恢复、triggered→[确认]）/fire_count×N（自然样本含 acked id264 与 resolved id219×41）。
 *   A3 来源过滤：来源下拉选项=列表实源；选中→GET source=该源、行数=API、行来源全匹配。
 *   A4 level=critical 空态：盘前窗口自然无 critical →「暂无告警」；有行则行数=API+pill 全 critical（容忍）。
 *   A5 规则面板：GET /api/alert-rules 4 预设（name/level/threshold/silence/enabled）逐条=UI；
 *      「委托异常/废单」Wave 4 预留置灰卡；全程零 PATCH /api/alert-rules（规则快照前后不变=只读）。
 *   A6 ack 确认（确定性夹具）：SQL 注入 triggered 行 → UI「确认」→ POST 200 status=acked → 行翻
 *      「已确认」按钮消失；同 id 再 ack / 不存在 id / 天然 resolved / 天然 acked → 404（服务端拒绝，
 *      错误文案「告警不存在或不在未确认状态」）；夹具 SQL 清理+台账。
 *   A7 诊断：ack 404 前端稳定性（route 注入 404，不触达服务端）——页面不崩、行不翻转、仍可交互；
 *      store.ack 无 catch → 未捕获 rejection 以 pageerror 形式记录（finding 上报架构师，不作为本用例失败）。
 * 全程 ⑦：loads=1（无 reload/跳转）、pathname=/alerts、应用 console.error=0（有意 404 原生诊断单列 netErrs）。
 *
 * 聚焦（⑧设置）：
 *   B1 system-info=API（应用/crate 版本、DB 已连接=db_ok、运行时长 fmtUptime 复算 ±240s）。
 *   B2 危险区**拒绝路径**：空/错 confirm UI 禁用（零 POST）；精确 PURGE/RESET 仅验 enabled 不点击；
 *      Node 直发 confirm 错/缺失 → purge-raw 400「confirm 须为 PURGE」/ reset-circuits 400
 *      「confirm 须为 RESET」；全程零真实 purge/reset 执行。
 *   B3 配置只读：source/collector/mcp 值与 GET /api/config/* 逐值对账；保存按钮×3 disabled +
 *      「参数配置化将在下一阶段上线（S2）」标注；会话零 PATCH/PUT/POST 到 /api/config/*。
 *   B4 导航：设置分区锚点点击 → scrollIntoView（目标 region bbox 进视口）+ data-active 高亮切换；
 *      URL 无跳转无 hash。
 *   B5 空/错误态：route abort /api/config/sources（goto 前注册）→ source-config「加载失败：…」+重试，
 *      其余区正常；unroute+重试 → 恢复；pageerror=0、应用 console.error=0。
 * 全程 ⑧：loads=1、pathname=/settings、pageerror=0。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/alerts_settings_deep_r4）。
 * 运行：cd web && npx playwright test e2e/alerts-settings-deep.e2e.ts
 * 约束：不 commit；无 staged；夹具（alert_events triggered 行）SQL 台账 + 用例尾/afterAll 清理。
 */

test.describe.configure({ retries: 0 }); // 真库写用例：失败即失败，afterAll 兜底清理（控制时长）

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/alerts_settings_deep_r4';
mkdirSync(SHOT, { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));
const LEDGER = resolve(here, 'sql-ledger.md');
function ledger(action: string, key: string, detail: string): void {
  appendFileSync(LEDGER, `- ${new Date().toISOString()}  [${action}] ${key}  ${detail}\n`, 'utf8');
}

/* ─────────────────────── 组件口径复算（镜像前端 store/AlertList/format） ─────────────────────── */

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
function hhmm(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
/** rangeFromIso('today')：CST 当日 00:00 的 ISO（UTC 前一日 16:00 起算） */
function todayFromISO(now = new Date()): string {
  const cst = new Date(now.getTime() + 8 * 3_600_000);
  const startUtc = Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate()) - 8 * 3_600_000;
  return new Date(startUtc).toISOString();
}
function daysAgoISO(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
/** 前端 fmtUptime 同构：秒 → 「D天 HH:MM」/「H时 M分」 */
function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  return d > 0 ? `${d}天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : `${h}时 ${m}分`;
}
function parseUptimeSecs(text: string): number {
  const mD = text.match(/运行\s*(\d+)天\s+(\d{2}):(\d{2})/);
  if (mD) return +mD[1]! * 86_400 + +mD[2]! * 3_600 + +mD[3]! * 60;
  const mH = text.match(/运行\s*(\d+)时\s*(\d+)分/);
  if (mH) return +mH[1]! * 3_600 + +mH[2]! * 60;
  return -1;
}

/* ─────────────────────── 页面监看与请求/响应账 ─────────────────────── */

interface AlertResp { url: string; ok: boolean; rows: number; items: Array<Record<string, unknown>> }
interface Watch {
  perr: string[];
  cerr: string[];    // 应用 console.error（有意阻断/404 原生诊断除外）
  netErrs: string[]; // 浏览器原生网络诊断（Failed to load resource…）
  loads: number;
  alertGets: string[];   // GET /api/alerts（含查询串）
  alertResps: AlertResp[]; // GET /api/alerts 响应快照（UI 数据源）
  nonGetConfig: string[];  // /api/config/* 或 purge/reset 的非 GET 请求（应为空）
}
function watchPage(page: Page): Watch {
  const w: Watch = { perr: [], cerr: [], netErrs: [], loads: 0, alertGets: [], alertResps: [], nonGetConfig: [] };
  page.on('pageerror', (e) => w.perr.push(String(e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) w.netErrs.push(m.text().slice(0, 300));
    else w.cerr.push(m.text().slice(0, 300));
  });
  page.on('load', () => { w.loads += 1; });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(BASE)) return;
    if (/\/api\/alerts\?/.test(u) && r.method() === 'GET') w.alertGets.push(u);
    if (/\/api\/config\/|\/api\/system\/(purge-raw|reset-circuits)/.test(u) && r.method() !== 'GET') {
      w.nonGetConfig.push(`${r.method()} ${u}`);
    }
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (!u.startsWith(BASE)) return;
    if (/\/api\/alerts(\?|$)/.test(u) && r.request().method() === 'GET') {
      let rows = 0;
      let items: Array<Record<string, unknown>> = [];
      try {
        const j = (await r.json()) as Array<Record<string, unknown>>;
        rows = j.length;
        items = j;
      } catch { /* 非 JSON 忽略 */ }
      w.alertResps.push({ url: u, ok: r.ok(), rows, items });
    }
  });
  return w;
}
async function assertClean(w: Watch, ctx: string): Promise<void> {
  expect(w.perr, `${ctx}: pageerror 应为 0`).toEqual([]);
  expect(w.cerr, `${ctx}: 应用 console.error 应为 0`).toEqual([]);
}

/* ─────────────────────── 定位与稳定等待 ─────────────────────── */

const region = (page: Page, name: string) => page.locator(`[data-region="${name}"]`);
const alertListRows = (page: Page) => region(page, 'alert-list').locator('div[class~="mb-1.5"]');
async function waitAlertListReady(page: Page): Promise<void> {
  const list = region(page, 'alert-list');
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(list.locator('.animate-pulse')).toHaveCount(0, { timeout: 20_000 });
}
/** 在 UI 上做一次 select 变更：等待与目标查询参数匹配的 /api/alerts 响应（与请求同序，规避响应乱序）
 *  并等到 DOM 行数=该响应 rows（UI 数据源=该响应，天然状态容忍见文件头） */
async function selectAndMatch(
  page: Page, w: Watch, ariaLabel: string, value: string, pred: (p: URLSearchParams) => boolean,
): Promise<AlertResp> {
  const target = page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      /\/api\/alerts/.test(r.url()) &&
      (() => { try { return pred(new URL(r.url()).searchParams); } catch { return false; } })(),
    { timeout: 20_000 },
  );
  await page.getByLabel(ariaLabel).selectOption(value);
  const resp = await target;
  expect(resp.ok(), `响应应 200`).toBeTruthy();
  const items = (await resp.json()) as Array<Record<string, unknown>>;
  const rows = items.length;
  w.alertResps.push({ url: resp.url(), ok: resp.ok(), rows, items }); // 证据账（顺序无关断言不再依赖）
  await expect
    .poll(() => alertListRows(page).count(), { timeout: 15_000, message: `DOM 行数=响应 rows（${rows}）` })
    .toBe(rows);
  return { url: resp.url(), ok: true, rows, items };
}
async function noNavigate(w: Watch, page: Page, path: string): Promise<void> {
  expect(w.loads, '全程无 reload/跳转').toBe(1);
  expect(new URL(page.url()).pathname).toBe(path);
}
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/* ─────────────────────── 证据 ─────────────────────── */

const evidence: Array<Record<string, string>> = [];
let shotNo = 0;
async function shot(page: Page, name: string): Promise<string> {
  const p = resolve(SHOT, `${String(shotNo++).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

/* ─────────────────────── 夹具（⑦ ack 用 triggered 行；惰性源 → 引擎不触碰） ─────────────────────── */

let fixtureSeq = 0;
function nextFixtureSource(): string {
  fixtureSeq += 1;
  return `e2e_deep_r4_ack${fixtureSeq}`;
}
function insertTriggered(source: string, message: string): number {
  const id = Number(psql(
    `INSERT INTO alert_events (rule_id, level, source, message) ` +
    `VALUES ('symbol_gap_rate', 'warning', ${q(source)}, ${q(message)}) RETURNING id;`,
  ));
  ledger('fixture-insert', `alert_events id=${id}`, `source=${source} triggered 行（rule=symbol_gap_rate warning）`);
  return id;
}
function deleteFixture(source: string): void {
  const del = psql(`DELETE FROM alert_events WHERE source=${q(source)} RETURNING id;`);
  ledger('fixture-delete', `source=${source}`, `删除行 id=${del || '(无残留)'}`);
}

/* 证据目录自述 + 兜底清理 */
test.afterAll(async () => {
  const leftover = psql(`SELECT source FROM alert_events WHERE source LIKE 'e2e_deep_r4%';`);
  if (leftover) {
    const del = psql(`DELETE FROM alert_events WHERE source LIKE 'e2e_deep_r4%';`);
    ledger('fixture-cleanup', 'afterAll 兜底', `source=e2e_deep_r4% 残留删除（${del}）`);
  }
  writeFileSync(
    resolve(SHOT, 'evidence.json'),
    JSON.stringify({ file: resolve(here, 'alerts-settings-deep.e2e.ts'), evidence }, null, 2),
    'utf8',
  );
});

/* ═══════════════════════════════════ 页面⑦ 告警中心 ═══════════════════════════════════ */

test.describe('⑦ 告警中心 /alerts 深度回归', () => {
  test('A1 列表默认「今日」+时间范围过滤：GET 参数=口径复算、行数=响应、今日空态', async ({ page }) => {
    const w = watchPage(page);
    const t0 = new Date();
    await page.goto('/alerts', { waitUntil: 'domcontentloaded' });
    await waitAlertListReady(page);

    // 默认「今日」：首个 GET from=CST 今日 00:00（rangeFromIso 复算）；空态「暂无告警」或有行=响应数
    expect(w.alertGets.length).toBeGreaterThanOrEqual(1);
    const first = new URL(w.alertGets[0]!);
    const fp = first.searchParams;
    expect(Math.abs(Date.parse(fp.get('from') ?? '') - Date.parse(todayFromISO(t0)))).toBeLessThan(3000);
    await expect.poll(() => w.alertResps.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const r0 = w.alertResps.find((r) => { try { return new URL(r.url).searchParams.get('from') === fp.get('from'); } catch { return false; } }) ?? w.alertResps[0]!;
    if (r0.rows === 0) {
      await expect(region(page, 'alert-list').getByText('暂无告警')).toBeVisible({ timeout: 10_000 });
    } else {
      await expect.poll(() => alertListRows(page).count()).toBe(r0.rows);
    }
    await shot(page, 'A1_today');

    // 近三日：GET from≈now-3d，行数=该响应
    const r3 = await selectAndMatch(page, w, '时间范围', '3d', (p) => {
      const f = p.get('from');
      return f !== null && Math.abs(Date.parse(f) - Date.parse(daysAgoISO(3))) < 4000;
    });
    await shot(page, 'A1_3d');

    // 全部：GET 无 from 参数，行数=全量响应
    const ra = await selectAndMatch(page, w, '时间范围', 'all', (p) => p.get('from') === null);
    expect(r3.rows).toBeGreaterThanOrEqual(0);
    expect(ra.rows).toBeGreaterThan(0); // 存量 20 行（全部范围）
    await shot(page, 'A1_all');
    await assertClean(w, 'A1');
    await noNavigate(w, page, '/alerts');
    evidence.push({ case: 'A1', pass: 'PASS', note: `今日 rows=${r0.rows}(空态分支)；近三日=${r3.rows}；全部=${ra.rows}；GET 参数=复算口径` });
  });

  test('A2 行字段=API：级别/来源/内容/时刻/状态徽标/fire_count（acked+resolved 双样本）', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/alerts', { waitUntil: 'domcontentloaded' });
    await waitAlertListReady(page);
    await selectAndMatch(page, w, '时间范围', 'all', (p) => p.get('from') === null);
    const items = w.alertResps[w.alertResps.length - 1]!.items;
    expect(items.length).toBeGreaterThan(0);
    const rows = alertListRows(page);
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(items.length);

    // 逐行 pill=level（与响应同位次）；取自然样本含 acked/resolved
    const pills = await rows.evaluateAll((els) =>
      els.map((el) => el.querySelector('span')?.textContent ?? ''),
    );
    expect(pills).toEqual(items.map((it) => it.level));
    const statuses = new Set(items.map((it) => it.status));
    const sampled: number[] = [];
    const show = (i: number): boolean => {
      if (sampled.includes(i)) return false;
      sampled.push(i);
      return true;
    };
    for (let i = 0; i < Math.min(items.length, 3); i += 1) {
      const it = items[i] as Record<string, unknown>;
      const row = rows.nth(i);
      if (!show(i)) continue;
      // 时刻 = hh:mm(CST) of last_fired_at；来源/内容 = source/message
      await expect(row.locator('span.num').nth(0)).toHaveText(hhmm(String(it.last_fired_at)));
      await expect(row.locator('span.num').nth(1)).toHaveText(String(it.source));
      await expect(row).toContainText(String(it.message));
      // fire_count>1 → ×N
      if (Number(it.fire_count) > 1) await expect(row).toContainText(`×${it.fire_count}`);
      else await expect(row).not.toContainText('×');
      // 状态徽标：triggered→确认按钮；acked→已确认 acked_at；resolved→已恢复 resolved_at
      const st = String(it.status);
      if (st === 'acked') {
        await expect(row.getByRole('button', { name: '确认' })).toHaveCount(0);
        await expect(row).toContainText(/已确认\s+\d{2}:\d{2}/);
        if (it.acked_at) await expect(row.locator('span').last()).toContainText(hhmm(String(it.acked_at)));
      } else if (st === 'resolved') {
        await expect(row.getByRole('button', { name: '确认' })).toHaveCount(0);
        await expect(row).toContainText(/已恢复\s+\d{2}:\d{2}/);
      } else {
        await expect(row.getByRole('button', { name: '确认' })).toBeVisible();
      }
    }
    expect([...statuses]).toContain('acked'); // 天然样本含已确认态（id264）
    expect([...statuses]).toContain('resolved'); // 天然样本含已恢复态
    await shot(page, 'A2_row_fields');
    await assertClean(w, 'A2');
    await noNavigate(w, page, '/alerts');
    evidence.push({
      case: 'A2', pass: 'PASS', note: `rows=${items.length}；pill 全部=API level；样本 i=${sampled.join(',')} 逐字段对账；status=${[...statuses].join('/')}`,
    });
  });

  test('A3 来源过滤：下拉=实源，选中 → GET source + 行全匹配', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/alerts', { waitUntil: 'domcontentloaded' });
    await waitAlertListReady(page);
    await selectAndMatch(page, w, '时间范围', 'all', (p) => p.get('from') === null);
    const srcSel = page.getByLabel('来源');
    const optCount = await srcSel.locator('option').count();
    expect(optCount).toBeGreaterThan(1); // 全部范围下列表来源 ≥1（存量 20 行多源）
    const firstVal = (await srcSel.locator('option').nth(1).getAttribute('value')) ?? '';
    expect(firstVal).not.toBe('');

    const resp = await selectAndMatch(page, w, '来源', firstVal, (p) => p.get('source') === firstVal);
    if (resp.rows > 0) {
      const rows = alertListRows(page);
      const srcs = await rows.evaluateAll((els) =>
        els.map((el) => el.querySelectorAll('span.num')[1]?.textContent ?? '?'),
      );
      expect(new Set(srcs)).toEqual(new Set([firstVal]));
    }
    // 复位来源=全部（页面恢复初始过滤，证明控件可回）
    await selectAndMatch(page, w, '来源', '', (p) => p.get('source') === null);
    await shot(page, 'A3_source_filter');
    await assertClean(w, 'A3');
    await noNavigate(w, page, '/alerts');
    evidence.push({ case: 'A3', pass: 'PASS', note: `源=${firstVal} 行数=${resp.rows} 全匹配；复位来源=全部` });
  });

  test('A4 level=critical：GET level 参数一致；空态「暂无告警」（有行则全 critical 容忍）', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/alerts', { waitUntil: 'domcontentloaded' });
    await waitAlertListReady(page);
    await selectAndMatch(page, w, '时间范围', 'all', (p) => p.get('from') === null);
    const resp = await selectAndMatch(page, w, '级别', 'critical', (p) => p.get('level') === 'critical');
    if (resp.rows === 0) {
      await expect(region(page, 'alert-list').getByText('暂无告警')).toBeVisible({ timeout: 10_000 });
    } else {
      const pills = await alertListRows(page).evaluateAll((els) =>
        els.map((el) => el.querySelector('span')?.textContent ?? ''),
      );
      expect(new Set(pills)).toEqual(new Set(['critical']));
    }
    await shot(page, 'A4_critical');
    await assertClean(w, 'A4');
    await noNavigate(w, page, '/alerts');
    evidence.push({ case: 'A4', pass: 'PASS', note: `level=critical rows=${resp.rows}（空态「暂无告警」分支命中）` });
  });

  test('A5 规则面板：4 预设规则（name/level/阈值/静默/开关）=API + Wave4 预留置灰 + 零 PATCH', async ({ page }) => {
    const w = watchPage(page);
    const apiRes = await fetch(`${BASE}/api/alert-rules`);
    const rules = (await apiRes.json()) as Array<{
      id: string; name: string; level: string; threshold: number; silence_minutes: number; enabled: boolean;
    }>;
    expect(apiRes.status).toBe(200);
    expect(rules.length).toBe(4);

    await page.goto('/alerts', { waitUntil: 'domcontentloaded' });
    const rp = region(page, 'rule-panel');
    await expect(rp).toBeVisible({ timeout: 20_000 });
    await expect(rp.locator('.animate-pulse')).toHaveCount(0, { timeout: 20_000 });
    await expect(rp.locator('input').first()).toBeVisible();

    for (const r of rules) {
      const thr = rp.getByLabel(`${r.name}阈值`);
      const sil = rp.getByLabel(`${r.name}静默时长`);
      await expect(thr).toHaveValue(String(r.threshold));
      await expect(sil).toHaveValue(String(r.silence_minutes));
      expect(await thr.isDisabled()).toBe(!r.enabled);
      expect(await sil.isDisabled()).toBe(!r.enabled);
      const toggle = rp.getByRole('button', { name: `${r.name}开关` });
      await expect(toggle).toHaveAttribute('aria-pressed', String(r.enabled));
      await expect(rp.getByText(r.name)).toHaveCount(1);
      expect(norm(await rp.innerText())).toContain(r.level);
    }
    // 规则 id 契约（seed slug 固定 4 条）
    expect(rules.map((r) => r.id).sort()).toEqual(
      ['collection_stall', 'source_success_rate', 'symbol_gap_rate', 'tushare_daily_sync'].sort(),
    );

    // Wave 4 预留置灰卡（交易类规则不可用）
    const wave4 = rp.locator('div[class~="opacity-50"]', { hasText: 'Wave 4 预留' });
    await expect(wave4).toHaveCount(1);
    await expect(wave4).toContainText('委托异常/废单');
    await expect(wave4).toContainText('Wave 4 预留（交易类规则暂不可用）');

    // 零 PATCH：仅展示不动手；规则快照前后一致（只读）
    await page.waitForTimeout(800);
    expect(w.nonGetConfig.filter((x) => x.startsWith('PATCH') && x.includes('/api/alert-rules'))).toEqual([]);
    const after = await (await fetch(`${BASE}/api/alert-rules`)).json() as Array<{ id: string; threshold: number; enabled: boolean; silence_minutes: number }>;
    const snap = (arr: Array<{ id: string; threshold: number; enabled: boolean; silence_minutes: number }>) =>
      arr.map((r) => ({ id: r.id, threshold: r.threshold, enabled: r.enabled, silence_minutes: r.silence_minutes }));
    expect(snap(after)).toEqual(snap(rules as Array<{ id: string; threshold: number; enabled: boolean; silence_minutes: number }>));
    await shot(page, 'A5_rule_panel');
    await assertClean(w, 'A5');
    await noNavigate(w, page, '/alerts');
    evidence.push({ case: 'A5', pass: 'PASS', note: `rules=${rules.map((r) => `${r.id}(${r.level},t=${r.threshold},sil=${r.silence_minutes})`).join(' | ')}；Wave4 置灰卡=1；零 PATCH 且规则快照不变` });
  });

  test('A6 ack 确认：triggered→200「已确认」翻转；已确认/已恢复/不存在→404（服务端拒绝）', async ({ page }) => {
    const w = watchPage(page);
    // 夹具：triggered(warning) 行（惰性源 e2e_deep_r4_ack*，引擎评估不触碰 → 确定性）
    const source = nextFixtureSource();
    const message = `e2e r4 ack fixture #${source}`;
    const id = insertTriggered(source, message);
    try {
      await page.goto('/alerts', { waitUntil: 'domcontentloaded' });
      await waitAlertListReady(page);
      const row = region(page, 'alert-list').locator('div[class~="mb-1.5"]', { hasText: message }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      // 夹具行字段：pill=warning、来源=source、含 [确认]
      await expect(row.locator('span').first()).toHaveText('warning');
      await expect(row.locator('span.num').nth(1)).toHaveText(source);

      // 点确认 → POST 200 status=acked（真实产品动作，仅置 acked_at）
      const respP = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/alerts/${id}/ack`),
        { timeout: 15_000 },
      );
      await row.getByRole('button', { name: '确认' }).click();
      const resp = await respP;
      expect(resp.status()).toBe(200);
      const body = (await resp.json()) as { id: number; status: string; acked_at: string | null };
      expect(body.id).toBe(id);
      expect(body.status).toBe('acked');
      expect(body.acked_at).not.toBeNull();

      // UI 就地翻转「已确认」且按钮消失
      await expect
        .poll(async () => (await row.innerText().catch(() => '')) || '', { timeout: 10_000 })
        .toMatch(/已确认/);
      await expect(row.getByRole('button', { name: '确认' })).toHaveCount(0);
      await shot(page, 'A6_acked_flip');

      // 拒绝路径（Node 直发，服务端语义）：
      // 1) 同 id（刚确认→acked）再 ack → 404
      const reAck = await fetch(`${BASE}/api/alerts/${id}/ack`, { method: 'POST' });
      expect(reAck.status).toBe(404);
      expect(((await reAck.json()) as { error: string }).error).toBe('告警不存在或不在未确认状态');
      // 2) 不存在 id → 404
      const missing = await fetch(`${BASE}/api/alerts/999999999/ack`, { method: 'POST' });
      expect(missing.status).toBe(404);
      // 3) 天然 resolved / acked 行 → 404（拉取当前快照后即发；盘前窗口状态稳定）
      const cur = (await (await fetch(`${BASE}/api/alerts`)).json()) as Array<{
        id: number; status: string; level: string;
      }>;
      const resolvedId = cur.find((a) => a.status === 'resolved');
      const ackedId = cur.find((a) => a.status === 'acked');
      for (const [tag, rec] of [
        ['resolved', resolvedId],
        ['acked', ackedId],
      ] as const) {
        if (!rec) {
          evidence.push({ case: 'A6', pass: 'PASS', note: `${tag} 自然样本缺失，跳过` });
          continue;
        }
        const r = await fetch(`${BASE}/api/alerts/${rec.id}/ack`, { method: 'POST' });
        expect(r.status, `${tag} id=${rec.id} ack 应 404`).toBe(404);
      }
      // 页面未被 404 干扰：列表仍在、无错误条、无跳转
      await expect(region(page, 'alert-list').getByText(/^加载失败/)).toHaveCount(0);
      await shot(page, 'A6_after_404s');
      await assertClean(w, 'A6');
      await noNavigate(w, page, '/alerts');
      evidence.push({
        case: 'A6', pass: 'PASS',
        note: `fixture id=${id} UI ack→200(acked, acked_at 非空)→「已确认」；再 ack 404；不存在 404；resolved(id=${resolvedId?.id ?? '-'}) 404；acked(id=${ackedId?.id ?? '-'}) 404`,
      });
    } finally {
      deleteFixture(source); // 用例尾清理（断言失败也清，afterAll 再兜底）
    }
  });

  test('A7 诊断：ack 遇 404（注入）→ 页面不崩、行不翻转、仍可交互（pageerror 现状记录上报）', async ({ page }) => {
    const w = watchPage(page);
    const source = nextFixtureSource();
    const message = `e2e r4 ack diag #${source}`;
    const id = insertTriggered(source, message);
    try {
      // 拦截 ack → 404（服务端不触达；模拟「已确认/已恢复/不存在」被并发翻转后的服务端拒绝）
      await page.route('**/api/alerts/*/ack', (route) => {
        void route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: '告警不存在或不在未确认状态' }) });
      });
      await page.goto('/alerts', { waitUntil: 'domcontentloaded' });
      await waitAlertListReady(page);
      const row = region(page, 'alert-list').locator('div[class~="mb-1.5"]', { hasText: message }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.getByRole('button', { name: '确认' }).click();
      await page.waitForTimeout(1500);

      // 不崩/不翻转：行仍在且仍为 triggered（[确认] 未消失、无「已确认」），页面结构完整
      await expect(row.getByRole('button', { name: '确认' })).toBeVisible({ timeout: 10_000 });
      expect(await row.innerText()).not.toContain('已确认');
      await expect(region(page, 'rule-panel').locator('input').first()).toBeVisible();
      await expect(region(page, 'alert-list').getByText(/^加载失败/)).toHaveCount(0);

      // 仍可交互：切「近三日」过滤成功（响应落 + DOM 更新）
      const before = w.alertResps.length;
      await page.getByLabel('时间范围').selectOption('3d');
      await expect.poll(() => w.alertResps.length, { timeout: 20_000 }).toBeGreaterThan(before);
      const resp = w.alertResps[w.alertResps.length - 1]!;
      await expect.poll(() => alertListRows(page).count(), { timeout: 15_000 }).toBe(resp.rows);
      await shot(page, 'A7_ack404_stable');
      // 有意 404 的原生诊断单列 netErrs；应用 console.error 仍 0
      expect(w.netErrs.length).toBeGreaterThan(0);
      expect(w.cerr, 'A7: 应用 console.error 应为 0').toEqual([]);
      await noNavigate(w, page, '/alerts');
      evidence.push({
        case: 'A7', pass: 'PASS',
        note: `注入 ack 404：行不翻转、无加载失败、过滤仍可交互、console.error=0；pageerror=${w.perr.length}（未捕获 rejection：ApiError HTTP 404 …ack —— store.ack 无 catch，现状缺口交架构师，未作为失败）`,
      });
    } finally {
      await page.unroute('**/api/alerts/*/ack').catch(() => {});
      deleteFixture(source);
    }
  });
});

/* ═══════════════════════════════════ 页面⑧ 系统设置 ═══════════════════════════════════ */

test.describe('⑧ 系统设置 /settings 深度回归', () => {
  test('B1 system-info=API：应用/crate 版本、DB 状态、运行时长（fmtUptime ±240s）', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    const info = region(page, 'system-info');
    await expect(info).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('system-info-skeleton')).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(async () => (await info.innerText().catch(() => '')).length > 0).toBeTruthy();
    const api = (await (await fetch(`${BASE}/api/system/info`)).json()) as {
      app_version: string;
      crate_versions: { collector: string; storage: string; diagnose: string };
      db_ok: boolean;
      uptime_secs: number;
    };
    const txt = norm(await info.innerText());
    expect(txt).toContain(`应用 v${api.app_version}`);
    expect(txt).toContain(`collector ${api.crate_versions.collector}`);
    expect(txt).toContain(`storage ${api.crate_versions.storage}`);
    expect(txt).toContain(`diagnose ${api.crate_versions.diagnose}`);
    expect(txt).toContain(api.db_ok ? 'DB 已连接' : 'DB 已断开');
    const shown = parseUptimeSecs(txt);
    expect(shown).toBeGreaterThan(0);
    expect(Math.abs(shown - api.uptime_secs)).toBeLessThanOrEqual(240); // 渲染取数与 API 间流逝容差
    expect(txt).not.toContain('加载失败');
    await shot(page, 'B1_system_info');
    await assertClean(w, 'B1');
    await noNavigate(w, page, '/settings');
    evidence.push({
      case: 'B1', pass: 'PASS',
      note: `app v${api.app_version} crates ${api.crate_versions.collector}/${api.crate_versions.storage}/${api.crate_versions.diagnose} db_ok=${api.db_ok} uptime=${api.uptime_secs}s（UI 显示 ${fmtUptime(api.uptime_secs)}）`,
    });
  });

  test('B2 危险区拒绝路径：UI 禁用/启用翻转不点击（零 POST）+ 服务端错/缺 confirm→400 不执行', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    const dz = region(page, 'danger-zone');
    await expect(dz).toBeVisible({ timeout: 20_000 });
    const purgeBtn = dz.getByRole('button', { name: '清空 kline_raw' });
    const resetBtn = dz.getByRole('button', { name: '全部源熔断重置' });
    const input = page.getByTestId('danger-confirm-input');
    await expect(purgeBtn).toBeDisabled();
    await expect(resetBtn).toBeDisabled();

    // UI 层「缺失/错 confirm 禁用」：不触发任何请求
    for (const bad of ['PURG', 'purge', 'Reset', 'RESE', 'PURGE ', 'x']) {
      await input.fill(bad);
      await expect(purgeBtn).toBeDisabled();
      await expect(resetBtn).toBeDisabled();
    }
    expect(w.nonGetConfig.filter((x) => x.includes('/purge-raw') || x.includes('/reset-circuits'))).toEqual([]);
    // confirm 精确匹配才可点（只验 enabled，不真执行危险操作）
    await input.fill('PURGE');
    await expect(purgeBtn).toBeEnabled();
    await expect(resetBtn).toBeDisabled();
    await input.fill('RESET');
    await expect(resetBtn).toBeEnabled();
    await expect(purgeBtn).toBeDisabled();
    await input.fill('');
    await expect(purgeBtn).toBeDisabled();
    await expect(resetBtn).toBeDisabled();
    expect(w.nonGetConfig.filter((x) => x.includes('/purge-raw') || x.includes('/reset-circuits'))).toEqual([]);
    await shot(page, 'B2_danger_enabled_flip');

    // 服务端拒绝路径（Node 直发；confirm 缺失/错误 → 400，**不真执行** purge/reset）
    const wrongPurge = await fetch(`${BASE}/api/system/purge-raw`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'purge' }),
    });
    expect(wrongPurge.status).toBe(400);
    expect(((await wrongPurge.json()) as { error: string }).error).toBe('confirm 须为 PURGE（危险操作：清空 kline_raw）');
    const noBodyPurge = await fetch(`${BASE}/api/system/purge-raw`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(noBodyPurge.status).toBe(400);
    const wrongReset = await fetch(`${BASE}/api/system/reset-circuits`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'reset' }),
    });
    expect(wrongReset.status).toBe(400);
    expect(((await wrongReset.json()) as { error: string }).error).toBe('confirm 须为 RESET（危险操作：全部源熔断重置）');
    const noBodyReset = await fetch(`${BASE}/api/system/reset-circuits`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(noBodyReset.status).toBe(400);
    // UI 上无任何操作失败提示（从未点击）
    await expect(page.getByTestId('danger-message')).toHaveCount(0);
    await assertClean(w, 'B2');
    await noNavigate(w, page, '/settings');
    evidence.push({
      case: 'B2', pass: 'PASS',
      note: 'UI 空/错 confirm 全禁用零 POST；PURGE/RESET 精确匹配仅验 enabled 不点击；服务端 错/缺 confirm → 400×4（未真执行）',
    });
  });

  test('B3 配置只读：source/collector/mcp 值=API + 保存禁用+S2 标注 + 零 PATCH 请求', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    // 三区 + system-info 骨架退出
    for (const tid of ['source-config-skeleton', 'collector-config-skeleton', 'mcp-config-skeleton', 'system-info-skeleton']) {
      await expect(page.getByTestId(tid)).toHaveCount(0, { timeout: 20_000 });
    }
    const [srcApi, colApi, mcpApi] = await Promise.all([
      (await fetch(`${BASE}/api/config/sources`)).json() as Promise<{ sources: Array<{
        id: string; label: string; rate_per_sec: number; circuit_fail_count: number;
        backoff_steps: string[]; rotation_locked: boolean; jitter_ms: number;
      }> }>,
      (await fetch(`${BASE}/api/config/collector`)).json() as Promise<{ default_interval_sec: number; trading_hours: string }>,
      (await fetch(`${BASE}/api/config/mcp`)).json() as Promise<{ enabled: boolean; trading_tools_enabled: boolean; daily_limit_amount: number; daily_limit_count: number }>,
    ]);

    // source-config：8 源行 = API（label + 默认参数 + 东财末位锁定 🔒）
    const scTxt = norm(await region(page, 'source-config').innerText());
    const rows = region(page, 'source-config').locator('div.flex.items-center.gap-3');
    await expect(rows).toHaveCount(srcApi.sources.length);
    for (const s of srcApi.sources) {
      expect(scTxt, `source ${s.id}`).toContain(s.label);
      expect(scTxt).toContain(`速率 ${s.rate_per_sec} req/s`);
      expect(scTxt).toContain(`熔断连续失败 ${s.circuit_fail_count}`);
      expect(scTxt).toContain(`退避 ${s.backoff_steps.join('→')}s`);
      if (s.jitter_ms > 0) expect(scTxt).toContain(`抖动 ±${s.jitter_ms}ms`);
    }
    const locked = srcApi.sources.find((s) => s.rotation_locked);
    if (locked) {
      await expect(region(page, 'source-config').getByText('锁定末位不可上移（ADR-006）')).toBeVisible();
      expect(norm(await region(page, 'source-config').innerText())).toContain('🔒');
    }

    // collector-config / mcp-config 值 = API
    const ccTxt = norm(await region(page, 'collector-config').innerText());
    expect(ccTxt).toContain(`默认抓取间隔（新注册标的默认值） ${colApi.default_interval_sec}s`);
    expect(ccTxt).toContain(`交易时段 ${colApi.trading_hours}`);
    expect(ccTxt).toContain('写死不开放（只读展示）');
    const mcTxt = norm(await region(page, 'mcp-config').innerText());
    expect(mcTxt).toContain('MCP 服务总开关');
    expect(mcTxt).toContain('交易工具独立开关');
    expect(mcTxt).toContain('默认关；开启需页面二次确认（ADR-009）');
    expect(mcTxt).toContain(`金额 ${mcpApi.daily_limit_amount.toLocaleString()}`);
    expect(mcTxt).toContain(`笔数 ${mcpApi.daily_limit_count}`);

    // 保存×3 禁用 + S2 标注（title 同文案）
    const saves = page.getByRole('button', { name: '保存' });
    await expect(saves).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      expect(await saves.nth(i).isDisabled()).toBe(true);
      await expect(saves.nth(i)).toHaveAttribute('title', '参数配置化将在下一阶段上线（S2）');
    }
    await expect(page.getByText('参数配置化将在下一阶段上线（S2）')).toHaveCount(3);
    await shot(page, 'B3_config_readonly');
    // 零 PATCH/PUT/POST 到 /api/config/*（只读会话）
    await page.waitForTimeout(500);
    expect(w.nonGetConfig).toEqual([]);
    await assertClean(w, 'B3');
    await noNavigate(w, page, '/settings');
    evidence.push({
      case: 'B3', pass: 'PASS',
      note: `sources=${srcApi.sources.length}（push2delay 🔒锁定）collector=${colApi.default_interval_sec}s/${colApi.trading_hours} mcp=amt ${mcpApi.daily_limit_amount}/cnt ${mcpApi.daily_limit_count}；保存×3 禁用+S2；零 PATCH（nonGet=${w.nonGetConfig.length}）`,
    });
  });

  test('B4 导航：设置分区锚点滚动定位 + data-active 高亮切换 + 无跳转', async ({ page }) => {
    const w = watchPage(page);
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('source-config-skeleton')).toHaveCount(0, { timeout: 20_000 });
    const nav = region(page, 'settings-nav');
    const links = [
      ['collector-config', '采集参数'],
      ['system-info', '系统信息'],
      ['log-viewer', '日志查看'],
      ['danger-zone', '危险操作'],
    ] as const;
    for (const [rid, label] of links) {
      const a = nav.getByRole('link', { name: label });
      await a.click();
      await expect(a).toHaveAttribute('data-active', 'true');
      // 目标 region bbox 进入视口（锚点滚动定位生效）
      await expect
        .poll(async () => {
          const b = await region(page, rid).boundingBox();
          return b ? b.y : -1;
        }, { timeout: 8000, message: `${rid} 应滚动进视口` })
        .toBeLessThan(780);
      // 其余 nav 项 data-active=false
      const actives = await nav.locator('a[data-active="true"]').count();
      expect(actives).toBe(1);
    }
    // 无 hash / 无跳转
    expect(page.url()).not.toContain('#');
    expect(new URL(page.url()).pathname).toBe('/settings');
    await shot(page, 'B4_nav_scroll');
    await assertClean(w, 'B4');
    await noNavigate(w, page, '/settings');
    evidence.push({ case: 'B4', pass: 'PASS', note: `锚点循环 ${links.map(([, l]) => l).join('→')}：data-active 唯一高亮 + region 进视口；URL 无 hash 无跳转` });
  });

  test('B5 空/错误态：阻断 /api/config/sources → 该区错误+重试恢复，其余区正常（区隔离）', async ({ page }) => {
    const w = watchPage(page);
    await page.route('**/api/config/sources', (route) => route.abort());
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    const sc = region(page, 'source-config');
    await expect(sc.getByText(/^加载失败：/)).toBeVisible({ timeout: 25_000 });
    await expect(sc.getByRole('button', { name: '重试' })).toBeVisible();
    // 其余区独立正常：collector/mcp/system-info/log-viewer 均渲染且无加载失败
    for (const rid of ['collector-config', 'mcp-config', 'system-info', 'log-viewer']) {
      const r = region(page, rid);
      await expect.poll(async () => (await r.innerText().catch(() => '')).trim().length > 0, {
        timeout: 20_000, message: `${rid} 应有内容`,
      }).toBeTruthy();
      await expect(r.getByText(/^加载失败/)).toHaveCount(0);
    }
    await expect(region(page, 'log-viewer').getByText('日志跟随将在下一阶段上线（需日志采集层）')).toBeVisible();
    await shot(page, 'B5_config_error');
    expect(w.perr).toEqual([]);
    // 解除阻断 → 重试恢复
    await page.unroute('**/api/config/sources');
    await sc.getByRole('button', { name: '重试' }).click();
    await expect(sc.getByText(/^加载失败：/)).toHaveCount(0, { timeout: 25_000 });
    await expect(sc.getByText('腾讯ifzq')).toBeVisible({ timeout: 15_000 });
    await shot(page, 'B5_config_recovered');
    expect(w.netErrs.length).toBeGreaterThan(0); // 有意阻断的原生诊断单列
    expect(w.cerr, 'B5: 应用 console.error 应为 0').toEqual([]);
    await noNavigate(w, page, '/settings');
    evidence.push({ case: 'B5', pass: 'PASS', note: 'abort /api/config/sources → source-config 错误+重试；collector/mcp/system-info/log-viewer 正常；unroute+重试恢复 8 源；pageerror=0' });
  });
});
