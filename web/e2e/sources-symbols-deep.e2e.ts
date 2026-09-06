import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupSymbol, psql } from './helpers/db';
import { gotoPage, region } from './helpers/pages';

/**
 * 批 3a 深度回归 · ②数据源(/sources) + ③标的(/symbols)（真实环境 e2e）。
 *
 * 本文件位置（self-location）：`web/e2e/sources-symbols-deep.e2e.ts`
 *
 * 运行对象（真容器，本 spec 不改产品代码/接口/DB schema；临时夹具全 SQL 台账 + afterAll 恢复会话初快照）：
 *   eestock-app（healthy）/ SPA index-CTRGEV1F.js / http://127.0.0.1:8081（DB eestock-timescaledb:5433）
 *
 * 聚焦范围：
 *   ② S1 空源态/无错误横幅；S2 每源健康卡（状态/成功率(1h)/P50/最近错误=API 快照口径）+ summary-bar 计数 +
 *      单标的近7日缺口摘要 + 最近N条告警预览；S3 点卡 detail-panel D1 占位且不发 4 个 detail 404 请求；
 *      S4 WS source_health 推送更新卡（注入 circuit_open 事件、无 reload 变熔断）→ 手动复位 202 →
 *      数据面 manual_reset 事件落库 → 卡摘熔断回轮转。
 *   ③ Y1 注册校验（6位/北交所450422/间隔下限，客户端拦截零请求）；Y2 注册名称可选(DB NULL)；
 *      Y3 重复注册 409 幂等；Y4 编辑（code 只读/间隔 300/补名）；Y5 with_stats 今日 bar=DB 当日 kline_raw 行数、
 *      D2 停用/无数据显示（①列表「无数据」）、收藏联动（收藏仅影响 ①分区/标的表行不增不减值不变、无星标列）；
 *      Y6 停用 → 行置灰 switch off → ①显示「已停用」。
 * 全程：无「加载失败」错误横幅；S3 零 detail 请求；S4 无 reload（load 计数=1）。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/sources_symbols_deep_r3a）。
 * 运行：cd web && npx playwright test e2e/sources-symbols-deep.e2e.ts
 * 约束：不 commit；无 staged；证据落 E2E_SHOTS（仓库外）；设计稿 tester/design/007_sources_symbols_deep_r3a_e2e_design.md。
 */

test.describe.configure({ retries: 0 }); // 真库写用例：失败整文件重跑以保持清理确定性（workers=1 串行）

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/sources_symbols_deep_r3a';
mkdirSync(SHOT, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* self-location / 台账 */
const here = dirname(fileURLToPath(import.meta.url));
const LEDGER = resolve(here, 'sql-ledger.md');
function ledger(action: string, code: string, detail: string): void {
  appendFileSync(LEDGER, `- ${new Date().toISOString()}  [${action}] ${code}  ${detail}\n`, 'utf8');
}

/* 夹具常量 */
const TMP = '563000'; // 真实 SH 段、库内不存在、不与既有 44 只冲突
const MARK = 'e2e_r3a_probe'; // source_health_events.code 打标列（真实事件该列为空/真实 code）
const FIX_SOURCES = ['tencent_ifzq', 'sina_jsonp', 'tushare'];
const ROLE: Record<string, '1m' | 'snapshot'> = {
  tencent_ifzq: '1m', sina_jsonp: '1m', tencent_qt: 'snapshot', sina_hq: 'snapshot',
  ths_cs: 'snapshot', push2delay: 'snapshot', exchange: 'snapshot', tushare: 'snapshot',
};
const roleOf = (id: string): '1m' | 'snapshot' => ROLE[id] ?? 'snapshot';
const LABEL: Record<string, string> = {
  tencent_ifzq: '腾讯ifzq', sina_jsonp: '新浪jsonp', tencent_qt: '腾讯qt', sina_hq: '新浪hq',
  ths_cs: '同花顺', push2delay: 'push2delay（东财系）', exchange: '交易所', tushare: 'tushare（历史层）',
};
const labelOf = (id: string): string => LABEL[id] ?? id;

/* 会话初快照（afterAll 恢复断言基准） */
let sessionStartIso = '';
let sessionStartTsQ = '';
let healthAtStart: string[] = [];
let alertMaxId = 0;
let alertCountAtStart = 0;
let symCountAtStart = 0;
let favCountAtStart = 0;

/* 证据 */
const evidence: Array<Record<string, string>> = [];
let shotNo = 0;
async function shot(page: Page, name: string): Promise<string> {
  const p = resolve(SHOT, `${String(shotNo++).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

/* ─────────────────────────── 工具 ─────────────────────────── */

async function apiJson<T>(path: string, init?: RequestInit): Promise<{ status: number; json: T | null }> {
  const r = await fetch(BASE + path, init);
  let json: T | null = null;
  try {
    json = (await r.json()) as T;
  } catch {
    /* 非 JSON 忽略 */
  }
  return { status: r.status, json };
}

function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 源健康事件夹具注入（ok=true 行，code 打标；ts 回退 backMin~now-25s 等距，保证 1h 窗内 + 告警 10min 窗密度） */
function injectOkEvents(source: string, n: number, latBase: number, stepSec: number): void {
  psql(
    `INSERT INTO source_health_events (ts, source, ok, latency_ms, err_kind, code)
     SELECT now() - interval '30 seconds' - ((${n} - 1 - gs) * interval '${stepSec} seconds'), ${q(source)}, true,
            ${latBase} + (gs % 40) * 3, NULL, ${q(MARK)}
     FROM generate_series(0, ${n - 1}) AS gs;`,
  );
  ledger('fixture-inject', `source=${source}`, `ok rows x${n}（ts 回退 ~${Math.round((n * stepSec) / 60)}min，code=${MARK}）`);
}

function injectCircuitOpen(source: string): void {
  psql(
    `INSERT INTO source_health_events (ts, source, ok, latency_ms, err_kind, code)
     SELECT now() - interval '1 second', ${q(source)}, false, NULL, 'circuit_open', ${q(MARK)};`,
  );
  ledger('fixture-inject', `source=${source}`, `circuit_open 迁移事件（code=${MARK}）`);
}

/** 与页面②组件同口径的期望文本复算（镜像 SourceCards/SourcesSummaryBar/sourceMeta） */
function statusTextOf(h: { status: string; circuit_state: string }): string {
  if (h.circuit_state === 'open') return '熔断';
  if (h.status === 'degraded') return '降级';
  return '健康';
}
function rateTextOf(rate: number | null | undefined): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}
function expectedCardParts(h: {
  source: string; status: string; circuit_state: string; success_rate: number | null;
  p50_ms: number | null; last_error: { err_kind: string | null } | null;
}): string[] {
  return [
    labelOf(h.source),
    h.circuit_state === 'open' ? '熔断中' : roleOf(h.source) === '1m' ? '1m全速' : '快照心跳',
    `${statusTextOf(h)} · 成功率 ${rateTextOf(h.success_rate)}（1h）`,
    h.last_error ? '最近错误：' : '最近错误：无',
  ];
}
function summaryParts(health: Array<{ source: string; status: string; circuit_state: string }>): string[] {
  const m1 = health.filter((s) => roleOf(s.source) === '1m');
  const snap = health.filter((s) => roleOf(s.source) !== '1m');
  const m1Avail = m1.filter((s) => s.status !== 'circuit_open').length;
  const snapOk = snap.filter((s) => s.status === 'healthy').length;
  const open = m1.filter((s) => s.circuit_state === 'open').length;
  const light = m1.length === 0 || open === 0 ? '系统正常' : open === m1.length ? '全部1m源熔断' : '任一1m源熔断';
  return [`1m源 ${m1Avail}/${m1.length}`, `快照池 ${snapOk}/${snap.length}`, light];
}

/** CST 日历日 YYYY-MM-DD（与 store.cstDateStr 同口径） */
function cstDateStr(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
function gapRange(now: Date): { from: string; to: string } {
  const from = new Date(now.getTime() - 6 * 86_400_000);
  return { from: cstDateStr(from), to: cstDateStr(now) };
}

async function noErrorBanner(page: Page): Promise<void> {
  await expect(page.getByText(/加载失败/)).toHaveCount(0, { timeout: 10_000 });
}

/** CST 当日 [start,end) 的 UTC 即时串（kline today 口径与后端 domain::tz 对齐；直接字面比较，避免 PG date AT TIME ZONE 语义坑） */
function cstTodayBounds(): { start: string; end: string } {
  const cst = cstDateStr(new Date());
  const start = new Date(Date.parse(`${cst}T00:00:00+08:00`));
  const end = new Date(start.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}
/** 兜底夹具：worker 重启/单跑时若临时标的缺失则经产品 API 注册（幂等，409 容忍） */
async function ensureSymbol(code: string, name: string, intervalSec: number): Promise<void> {
  const n = Number(psql(`SELECT count(*) FROM symbols WHERE code=${q(code)};`));
  if (n > 0) return;
  await fetch(`${BASE}/api/symbols`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, interval_secs: intervalSec, settlement: 'T1', enabled: true }),
  });
  ledger('fixture-register', code, 'ensureSymbol 兜底注册');
}

function todayRawCount(code: string): number {
  const b = cstTodayBounds();
  return Number(
    psql(
      `SELECT count(*) FROM kline_raw WHERE code=${q(code)} AND ts >= ${q(b.start)} AND ts < ${q(b.end)};`,
    ),
  );
}

/* ─────────────────────────── ② 数据源 ─────────────────────────── */

test.describe('② 数据源 /sources 深度回归', () => {
  test('S1 空源态/无错误横幅（按会话初 API 分支）', async ({ page }) => {
    await gotoPage(page, '/sources');
    const cards = region(page, 'source-cards');
    await expect(cards).toBeVisible();
    const h = await apiJson<{ sources: unknown[] }>('/api/sources/health');
    if (h.json && h.json.sources.length === 0) {
      await expect(cards.getByText('无数据源配置')).toBeVisible({ timeout: 15_000 });
      const bar = region(page, 'summary-bar');
      await expect(bar).toContainText('1m源');
      await expect(bar).toContainText('0/0');
    } else {
      // 有真实源（如盘中）：卡数 = API 源数，无错误
      const n = h.json?.sources.length ?? 0;
      await expect(cards.locator('[data-source]').first()).toBeVisible({ timeout: 15_000 });
      await expect(cards.locator('[data-source]')).toHaveCount(n);
    }
    await noErrorBanner(page);
    evidence.push({ case: 'S1', pass: 'PASS', note: `sources=${h.json?.sources.length}` });
    await shot(page, 'S1_empty_or_cards');
  });

  test('S2 源卡健康+汇总计数+缺口摘要+告警预览（=API 快照口径）', async ({ page }) => {
    // fixture：三源 ok 事件批（独占 1h 窗；盘中与真实事件共存亦可）
    injectOkEvents('tencent_ifzq', 60, 120, 8);
    injectOkEvents('sina_jsonp', 60, 80, 8);
    injectOkEvents('tushare', 20, 900, 25);

    await gotoPage(page, '/sources');
    const h = await apiJson<{
      sources: Array<{
        source: string; status: string; circuit_state: string; success_rate: number | null;
        p50_ms: number | null; last_error: { err_kind: string | null } | null;
      }>;
    }>('/api/sources/health');
    const sources = h.json?.sources ?? [];
    expect(sources.length).toBeGreaterThan(0);

    // 每源一卡 + 状态灯语义
    for (const s of sources) {
      const card = region(page, 'source-cards').locator(`[data-source="${s.source}"]`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      for (const part of expectedCardParts(s)) {
        await expect(card).toContainText(part);
      }
      // P50 数值或 —
      const p50re = s.p50_ms == null ? /P50\s+—/ : /P50\s+\d+ms/;
      await expect(card).toContainText(p50re);
    }
    // summary-bar 与 API 复算一致
    const bar = region(page, 'summary-bar');
    for (const part of summaryParts(sources)) {
      await expect(bar).toContainText(part);
    }

    // 缺口摘要：默认标的（API 首位）近 7 CST 日
    const syms = await apiJson<Array<{ code: string }>>('/api/symbols');
    const code = syms.json?.[0]?.code ?? '518880';
    const rg = gapRange(new Date());
    const gaps = await apiJson<{
      days: Array<{ date: string; missing_bars: number; expected_bars: number }>;
    }>(`/api/quality/gaps?code=${code}&from=${rg.from}&to=${rg.to}`);
    const gapRegion = region(page, 'gap-cards');
    await expect(gapRegion.getByText('缺口摘要 · 标的')).toBeVisible();
    const opts = gapRegion.locator('[data-testid="gap-symbol-select"] option');
    await expect(opts.first()).toHaveText(new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), {
      timeout: 15_000,
    });
    expect(await opts.count()).toBeGreaterThan(0);
    const days = gaps.json?.days ?? [];
    if (days.length > 0) {
      const d = days[0];
      await expect(gapRegion).toContainText(d.date.slice(5), { timeout: 15_000 });
      await expect(gapRegion).toContainText(`缺 ${d.missing_bars} bar / 应到 ${d.expected_bars}`);
    } else {
      await expect(gapRegion.getByText('该范围无缺口')).toBeVisible({ timeout: 15_000 });
    }

    // 告警预览计数 = API 长度（最近 N 条）
    const alerts = await apiJson<unknown[]>('/api/alerts?limit=10');
    const nAlerts = alerts.json?.length ?? 0;
    const pv = region(page, 'alert-preview');
    if (nAlerts > 0) {
      await expect(pv.locator('[data-testid="alert-preview-count"]')).toHaveText(
        `最近 ${nAlerts} 条告警`,
        { timeout: 15_000 },
      );
    } else {
      await expect(pv.getByText('暂无告警')).toBeVisible({ timeout: 15_000 });
    }
    await noErrorBanner(page);
    evidence.push({ case: 'S2', pass: 'PASS', note: `sources=${sources.length} gapsDays=${days.length} alerts=${nAlerts}` });
    await shot(page, 'S2_source_cards');
  });

  test('S3 detail-panel D1 占位：无 4 个 404 请求', async ({ page }) => {
    // 自足基底（单跑/全量均可）
    injectOkEvents('tencent_ifzq', 60, 120, 8);
    injectOkEvents('sina_jsonp', 60, 80, 8);
    injectOkEvents('tushare', 20, 900, 25);
    await gotoPage(page, '/sources');
    const tencent = region(page, 'source-cards').locator('[data-source="tencent_ifzq"]');
    await expect(tencent).toBeVisible({ timeout: 15_000 });

    let detailReqs = 0;
    const watch = (u: string): void => {
      if (/\/api\/sources\/[^/]+\/(metrics|events|divergence|rate-limits)/.test(u)) detailReqs += 1;
    };
    page.on('request', (r) => watch(r.url()));

    await tencent.click();
    const panel = region(page, 'detail-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(/详情数据将在后续版本提供/)).toBeVisible();
    await noErrorBanner(page);
    await sleep(800); // 给足任何（不应存在的）惰性请求机会
    expect(detailReqs).toBe(0);

    // 再点同一卡 → 折叠
    await tencent.click();
    await expect(region(page, 'detail-panel')).toHaveCount(0, { timeout: 10_000 });
    evidence.push({ case: 'S3', pass: 'PASS', note: `detail 404 请求=${detailReqs}` });
    await shot(page, 'S3_detail_placeholder');
  });

  test('S4 WS 推送熔断 → 手动复位 202 → 数据面消费 → 回轮转', async ({ page }) => {
    // 自足基底：先注入健康事件批（单跑/全量均可），再开页等卡片健康
    injectOkEvents('tencent_ifzq', 60, 120, 8);
    injectOkEvents('sina_jsonp', 60, 80, 8);
    injectOkEvents('tushare', 20, 900, 25);
    await gotoPage(page, '/sources');
    const cards = region(page, 'source-cards');
    const tc = cards.locator('[data-source="tencent_ifzq"]');
    await expect(tc).toBeVisible({ timeout: 15_000 });
    await expect(tc).toContainText('健康', { timeout: 15_000 });
    const h0 = await apiJson<{ sources: Array<{ circuit_state: string }> }>('/api/sources/health');
    const t0 = h0.json?.sources.find((s) => (s as { source: string }).source === 'tencent_ifzq');
    expect((t0 as { circuit_state: string } | undefined)?.circuit_state).not.toBe('open');

    let loads = 0;
    let healthGets = 0;
    page.on('load', () => {
      loads += 1;
    });
    page.on('request', (r) => {
      if (r.url().endsWith('/api/sources/health')) healthGets += 1;
    });

    // 注入新一批 ok 行（保 10min 告警窗密度）+ circuit_open（窗口内最新迁移）
    injectOkEvents('tencent_ifzq', 60, 120, 8);
    injectOkEvents('sina_jsonp', 60, 80, 8);
    injectCircuitOpen('tencent_ifzq');
    ledger('fixture-inject', 'tencent_ifzq', 'S4 前置：ok 批 + circuit_open 注入');

    // WS/轮询推送 → REST 重拉（先证重拉发生）→ 卡片熔断 + 手动复位按钮出现（无 reload）
    const afterInj = healthGets;
    await expect
      .poll(() => healthGets, { timeout: 20_000, intervals: [1_000] })
      .toBeGreaterThan(afterInj); // WS source_health → store.refreshHealth 的 GET 佐证
    await expect(tc).toContainText('熔断', { timeout: 30_000 });
    await expect(tc).toContainText('最近错误：无'); // 迁移事件不占 last_error 位
    const resetBtn = tc.getByRole('button', { name: /手动复位/ });
    await expect(resetBtn).toBeVisible();
    const bar = region(page, 'summary-bar');
    await expect(bar).toContainText('任一1m源熔断', { timeout: 20_000 });
    expect(loads).toBe(0); // WS 刷新不产生页面导航
    const before = await shot(page, 'S4_circuit_open_before_reset');

    // 手动复位：POST 202 {status:accepted}
    const respP = page.waitForResponse(
      (r) => r.url().endsWith('/api/sources/tencent_ifzq/reset') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await resetBtn.click();
    const resp = await respP;
    expect(resp.status()).toBe(202);
    const body = (await resp.json()) as { status?: string };
    expect(body.status).toBe('accepted');

    // 数据面 ≤5s 消费 → manual_reset 事件落库
    await expect
      .poll(
        () =>
          Number(
            psql(
              `SELECT count(*) FROM source_health_events WHERE source='tencent_ifzq' AND err_kind='manual_reset' AND ts >= ${q(sessionStartIso)};`,
            ),
          ),
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBeGreaterThan(0);

    // UI 摘除熔断（复位后回轮转；status 以 API 快照为准，可能为健康或降级）
    await expect(tc).not.toContainText('熔断', { timeout: 30_000 });
    await expect(tc.getByRole('button', { name: /手动复位/ })).toHaveCount(0);
    const h1 = await apiJson<{ sources: Array<{ source: string; circuit_state: string; status: string }> }>(
      '/api/sources/health',
    );
    const t1 = h1.json?.sources.find((s) => s.source === 'tencent_ifzq');
    expect(t1?.circuit_state).toBe('closed');
    await noErrorBanner(page);
    expect(loads).toBe(0);

    evidence.push({
      case: 'S4', pass: 'PASS',
      note: `POST 202; manual_reset 事件落库; circuit_state=${t1?.circuit_state} status=${t1?.status}; loads=${loads}`,
    });
    await shot(page, 'S4_after_reset_healthy');
    void before;
  });
});

/* ─────────────────────────── ③ 标的 ─────────────────────────── */

test.describe('③ 标的 /symbols 深度回归', () => {
  test('Y1 注册校验门禁（6位/北交所/间隔下限，零 POST）', async ({ page }) => {
    await gotoPage(page, '/symbols');
    const table = region(page, 'symbol-table');
    await expect(table).toBeVisible();

    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/symbols')) posts += 1;
    });

    await page.getByRole('button', { name: /注册标的/ }).first().click();
    const dialog = page.locator('[data-region="form-dialog"]');
    await expect(dialog).toBeVisible();

    const code = dialog.getByPlaceholder('600519');
    const save = dialog.getByRole('button', { name: '保存' });

    await code.fill('12345');
    await save.click();
    await expect(dialog.getByText('code 须为 6 位数字')).toBeVisible();

    await code.fill('450422');
    await save.click();
    await expect(dialog.getByText('北交所标的（4/8/920 前缀）暂不支持')).toBeVisible();

    await code.fill(TMP); // 合法 code，隔离间隔错误
    const interval = dialog.locator('input[type="number"]');
    await interval.fill('10');
    await save.click();
    await expect(dialog.getByText('抓取间隔下限 60 秒')).toBeVisible();

    expect(posts).toBe(0); // 客户端校验拦截，无写请求
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    evidence.push({ case: 'Y1', pass: 'PASS', note: '3 项校验文案命中，POST=0' });
    await shot(page, 'Y1_validation');
  });

  test('Y2 注册（名称可选 → DB NULL → 表格「—」）', async ({ page }) => {
    await page.on('dialog', (d) => d.accept());
    await gotoPage(page, '/symbols');
    const table = region(page, 'symbol-table');
    await expect(table).toBeVisible();

    await page.getByRole('button', { name: /注册标的/ }).first().click();
    const dialog = page.locator('[data-region="form-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('600519').fill(TMP);
    // 名称留空（名称可选）
    await dialog.getByRole('button', { name: '保存' }).click();

    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    const row = table.locator('tbody tr', { hasText: TMP });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('60s');
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(row).toContainText('—'); // 名称/今日bar/最新bar 均空
    expect(psql(`SELECT name IS NULL FROM symbols WHERE code=${q(TMP)};`)).toBe('t');
    expect(Number(psql(`SELECT count(*) FROM symbols;`))).toBe(symCountAtStart + 1);
    evidence.push({ case: 'Y2', pass: 'PASS', note: '注册成功，名称 NULL' });
    await shot(page, 'Y2_registered');
  });

  test('Y3 重复注册 409 幂等', async ({ page }) => {
    await page.on('dialog', (d) => d.accept());
    await gotoPage(page, '/symbols');
    const table = region(page, 'symbol-table');
    await expect(table).toBeVisible();

    await page.getByRole('button', { name: /注册标的/ }).first().click();
    const dialog = page.locator('[data-region="form-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('600519').fill(TMP);
    await dialog.getByRole('button', { name: '保存' }).click();

    // 409 错误内联展示、弹窗保持打开
    await expect(dialog.getByText(/code 已注册（编辑用 PATCH）/)).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeVisible();
    await expect(table.locator('tbody tr', { hasText: TMP })).toHaveCount(1);
    await dialog.getByRole('button', { name: '取消' }).click();
    evidence.push({ case: 'Y3', pass: 'PASS', note: '409 文案命中，弹窗不关，表内仍 1 行' });
  });

  test('Y4 编辑（code 只读 / 间隔 300 / 补名）', async ({ page }) => {
    await gotoPage(page, '/symbols');
    const table = region(page, 'symbol-table');
    const row = table.locator('tbody tr', { hasText: TMP });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: '编辑' }).click();
    const dialog = page.locator('[data-region="form-dialog"]');
    await expect(dialog).toBeVisible();
    const code = dialog.getByPlaceholder('600519');
    await expect(code).toHaveAttribute('readonly', ''); // 编辑态 code 只读
    await dialog.locator('input[type="number"]').fill('300');
    await dialog.getByPlaceholder('留空可后续编辑补录').fill('E2E回归临时ETF');
    await dialog.getByRole('button', { name: '保存' }).click();

    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(row).toContainText('300s');
    await expect(row).toContainText('E2E回归临时ETF');
    expect(psql(`SELECT interval_secs FROM symbols WHERE code=${q(TMP)};`)).toBe('300');
    expect(psql(`SELECT name FROM symbols WHERE code=${q(TMP)};`)).toBe('E2E回归临时ETF');
    evidence.push({ case: 'Y4', pass: 'PASS', note: 'interval=300 name 已补' });
    await shot(page, 'Y4_edited');
  });

  test('Y5 with_stats=DB 今日行数 + D2 无数据 + 收藏联动', async ({ page }) => {
    await page.on('dialog', (d) => d.accept());
    await ensureSymbol(TMP, 'E2E回归临时ETF', 300); // 兜底：重启/单跑断链自愈
    const list = () => region(page, 'symbol-list');

    // (a) ①列表：注册后 enabled 且无数据 → 「无数据」（D2 不伪造 0.000）
    await gotoPage(page, '/');
    const dashRow = list().locator('button', { hasText: TMP });
    await expect(dashRow).toBeVisible({ timeout: 20_000 });
    await expect(dashRow.getByText('无数据')).toBeVisible();

    // (b) 收藏联动：收藏 → 进 ★已收藏分区（data-fav=true）；仅 favorite_symbols +1
    const star = list().locator(`[data-star="${TMP}"]`);
    await star.click();
    await expect(list().locator('button[data-fav="true"]', { hasText: TMP })).toBeVisible({
      timeout: 15_000,
    });
    expect(Number(psql(`SELECT count(*) FROM favorite_symbols;`))).toBe(favCountAtStart + 1);
    const favSort = Number(psql(`SELECT sort_order FROM favorite_symbols WHERE code=${q(TMP)};`));
    expect(favSort).toBeGreaterThan(0);

    // (c) 标的表：无星标列、行不增不减、值不变（行仍 1、45 行总数、字段未变）
    const adm = await apiJson<Array<{ code: string }>>('/api/symbols?with_stats=1');
    expect(adm.json?.length).toBe(symCountAtStart + 1);
    await gotoPage(page, '/symbols');
    const table = region(page, 'symbol-table');
    const tmpRow = table.locator('tbody tr', { hasText: TMP });
    await expect(tmpRow).toHaveCount(1, { timeout: 15_000 });
    await expect(tmpRow).toContainText('E2E回归临时ETF');
    await expect(tmpRow).toContainText('300s');
    await expect(tmpRow).toContainText('563000');
    expect(psql(`SELECT enabled FROM symbols WHERE code=${q(TMP)};`)).toBe('t');
    // 表头无收藏列
    await expect(table.locator('thead').getByText(/收藏|星标/)).toHaveCount(0);

    // (d) with_stats：注入 5 条今日 kline_raw（钳在 CST 当日 00:00:30 之后）→ 今日列 = DB 当日行数（控制 518880 同口径）
    const b = cstTodayBounds();
    psql(
      `INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source)
       SELECT ${q(TMP)}, GREATEST(now() - (gs * interval '20 seconds') - interval '30 seconds',
                                  ${q(b.start)}::timestamptz + interval '30 seconds'),
              9.0 + gs * 0.001, 9.0 + gs * 0.002, 9.0, 9.0 + gs * 0.001, 1000, 9000.0, 'e2e_probe'
       FROM generate_series(1, 5) AS gs;`,
    );
    ledger('fixture-inject', TMP, '5 条今日 kline_raw（with_stats 对账）');
    await page.reload();
    const rowA = table.locator('tbody tr', { hasText: TMP });
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowA.locator('td').nth(4)).toHaveText('5', { timeout: 15_000 });
    const dbCnt = todayRawCount(TMP);
    expect(dbCnt).toBe(5);
    // 控制标的：UI 单元格 = DB 当日行数（0 → 「—」）
    const ctl = table.locator('tbody tr', { hasText: '518880' });
    const ctlDb = todayRawCount('518880');
    await expect(ctl.locator('td').nth(4)).toHaveText(ctlDb === 0 ? '—' : String(ctlDb), {
      timeout: 15_000,
    });
    evidence.push({
      case: 'Y5', pass: 'PASS',
      note: `收藏联动 OK（fav 7 行）；with_stats 今日=${dbCnt} 控制 518880 DB=${ctlDb} 单元格=DB`,
    });
    await shot(page, 'Y5_stats_favorites');
  });

  test('Y6 停用 → 行置灰 → ①列表「已停用」（D2）', async ({ page }) => {
    await page.on('dialog', (d) => d.accept());
    await ensureSymbol(TMP, 'E2E回归临时ETF', 300); // 兜底：重启/单跑断链自愈
    await gotoPage(page, '/symbols');
    const table = region(page, 'symbol-table');
    const row = table.locator('tbody tr', { hasText: TMP });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: '停用' }).click();
    await expect(row).toHaveClass(/opacity-45/, { timeout: 15_000 });
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(row.getByRole('button', { name: '启用' })).toBeVisible();
    expect(psql(`SELECT enabled FROM symbols WHERE code=${q(TMP)};`)).toBe('f');

    // ①列表该行显示「已停用」
    await gotoPage(page, '/');
    const dashRow = region(page, 'symbol-list').locator('button', { hasText: TMP });
    await expect(dashRow).toBeVisible({ timeout: 20_000 });
    await expect(dashRow.getByText('已停用')).toBeVisible();
    evidence.push({ case: 'Y6', pass: 'PASS', note: '行置灰/switch off/①已停用' });
    await shot(page, 'Y6_disabled');
  });
});

/* ─────────────────────────── 收尾清理（afterAll 兜底） ─────────────────────────── */

test.afterAll(async () => {
  // 1) 临时标的 + 其数据（favorite_symbols FK 级联）；2) 源事件夹具；3) 会话内告警
  try {
    const led = cleanupSymbol(TMP); // symbols/kline_raw/source_health_events/alert_events by code
    ledger('cleanup', TMP, `cleanupSymbol → after=${JSON.parse(led.after).symbols === 0 ? '0' : led.after}`);
  } catch (e) {
    ledger('cleanup-error', TMP, String(e));
  }
  psql(`DELETE FROM favorite_symbols WHERE code=${q(TMP)};`);
  psql(
    `DELETE FROM source_health_events WHERE code=${q(MARK)};` +
      `DELETE FROM source_health_events WHERE ts >= ${q(sessionStartIso)} AND source IN (${FIX_SOURCES.map(q).join(',')}) AND err_kind='manual_reset' AND code IS NULL;`,
  );
  psql(`DELETE FROM alert_events WHERE id > ${alertMaxId};`);
  ledger('cleanup', 'fixture', `source_health_events(code=${MARK})+会话内 manual_reset 清理；alert_events id>${alertMaxId} 清理`);

  // 恢复断言
  expect(Number(psql(`SELECT count(*) FROM symbols;`))).toBe(symCountAtStart);
  expect(Number(psql(`SELECT count(*) FROM favorite_symbols;`))).toBe(favCountAtStart);
  expect(Number(psql(`SELECT count(*) FROM alert_events;`))).toBe(alertCountAtStart);
  expect(Number(psql(`SELECT count(*) FROM source_health_events WHERE code=${q(MARK)};`))).toBe(0);
  let hNow = await apiJson<{ sources: unknown[] }>('/api/sources/health');
  let got = (hNow.json?.sources ?? []).map((s) => (s as { source: string }).source).sort();
  for (let i = 0; i < 3 && JSON.stringify(got) !== JSON.stringify(healthAtStart); i += 1) {
    await sleep(1_500);
    hNow = await apiJson<{ sources: unknown[] }>('/api/sources/health');
    got = (hNow.json?.sources ?? []).map((s) => (s as { source: string }).source).sort();
  }
  expect(got).toEqual(healthAtStart);

  writeFileSync(
    resolve(SHOT, 'evidence.json'),
    JSON.stringify({ file: resolve(here, 'sources-symbols-deep.e2e.ts'), evidence }, null, 2),
    'utf8',
  );
});

/* 会话初基线（首个用例前；早于一切注入） */
test.beforeAll(async () => {
  sessionStartIso = new Date().toISOString();
  sessionStartTsQ = sessionStartIso;
  cleanupSymbol(TMP); // 兜底：会话前无残留
  const h = await apiJson<{ sources: Array<{ source: string }> }>('/api/sources/health');
  healthAtStart = (h.json?.sources ?? []).map((s) => s.source).sort();
  alertMaxId = Number(psql('SELECT COALESCE(max(id),0) FROM alert_events;'));
  alertCountAtStart = Number(psql('SELECT count(*) FROM alert_events;'));
  symCountAtStart = Number(psql('SELECT count(*) FROM symbols;'));
  favCountAtStart = Number(psql('SELECT count(*) FROM favorite_symbols;'));
});
