import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 批 3b 深度回归 · 页面④ 数据质量 /quality（真实环境 e2e，纯只读）。
 *
 * 本文件位置（self-location）：`web/e2e/quality-deep.e2e.ts`
 * 设计稿：`tester/design/008_quality_deep_r3b_e2e_design.md`
 *
 * 运行对象（真容器，本 spec 不改产品代码/接口/DB schema/不写库）：
 *   eestock-app（healthy）/ SPA index-CTRGEV1F.js / http://127.0.0.1:8081（DB eestock-timescaledb:5433）
 *
 * 环境数据事实（运行期探测 2026-09-07 凌晨 CST）：kline_raw 1m 层仅覆盖 2026-08-21 ~ 2026-09-04
 * （accurate 层 2012~2026-09-04 全历史），故 raw 起点之前（如 2026-08-17..08-20）为无数据范围 → 各空态。
 * 后端日期跨度上限 62 天（>61 天 400「日期跨度上限 62 天」），spec 内 setRange 保证任意中间态窗口 ≤61 天。
 *
 * 聚焦（④质量）：
 *   Q1 分歧表默认范围加载：行字段=GET /api/quality/divergence 响应（时刻/raw收盘/accurate收盘/偏差%/raw来源
 *      逐格对账）、汇总行（比对 bar/一致率/最大偏差）、行数=响应 rows、|偏差| 降序；空态分支容忍。
 *   Q2 变更日期区间即重查：每次日期边界变更 → divergence/source-accuracy/gaps 三端点各重新 GET（URL 参数对账）；
 *      切无数据范围（raw 起点前）→ 分歧表「该范围无比对数据…」占位（divergence/accuracy 空、gap 仍列缺口日、
 *      sync 不受影响）。
 *   Q3 threshold：UI 汇总注解「（≤0.5% 计一致）」=API threshold_pct；偏差格着色（|dev|>t → text-up）数
 *      =summary.divergent_bars；API threshold_pct 参数可改（0.05/0.9 → divergent_bars 变化，回声透传）。
 *   Q4 overlay 视图：切换叠加图（客户端、零重查）→ svg 双线 line-raw/line-accurate 点数=升序 rows 数、图例、
 *      最大偏差标注；放大 ×2 → 点数≈ceil(n/2)；重置还原；空态（无数据范围）→「该范围无比对数据」无 svg。
 *   Q5 缺口报告：真实缺口日（09-01/09-02：缺 N bar / 应到 M + 分钟段起止/缺 bar 数/分类标签）与 API 对账；
 *      无缺口日窗口（09-03..09-04）→「该范围无缺口」（同屏分歧表仍有行）。
 *   Q6 source-accuracy 排行榜卡：卡数=API sources、逐卡 label/一致率/平均偏差/样本/最大偏差=组件口径格式化；
 *      无数据窗口 →「该窗口无比对样本」。
 *   Q7 tushare 同步状态：最近同步/覆盖只数/最近事件=API 格式化（checkpoints 契约字段 code/period/
 *      last_synced_date/updated_at）；quota_remaining=null → 剩余积分「—」；手动同步 disabled（wave-2 边界）。
 *   Q8/Q9/Q10 错误态：route abort 单端点（divergence/accuracy/gaps）→ 该区「加载失败：…」+「重试」，其余区正常
 *      不崩；unroute + 重试 → 该区恢复。全程 pageerror=0 / console.error=0（有意阻断的网络诊断单列 netErrs）。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/quality_deep_r3b）。
 * 运行：cd web && npx playwright test e2e/quality-deep.e2e.ts
 * 约束：不 commit；无 staged；只读（零 SQL 写）；证据落 E2E_SHOTS（仓库外）。
 */

test.describe.configure({ retries: 0 }); // 只读用例：失败即失败，不复跑（控制时长）

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/quality_deep_r3b';
mkdirSync(SHOT, { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));

/* ─────────────────────── 组件口径复算（镜像前端 format.ts / sourceMeta） ─────────────────────── */

function cstMdHm(iso: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
function ratePct(rate: number | null): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}
function devPct(dev: number | null): string {
  if (dev == null) return '—';
  const sign = dev > 0 ? '+' : dev < 0 ? '−' : '';
  return `${sign}${Math.abs(dev).toFixed(2)}%`;
}
const price3 = (n: number) => n.toFixed(3);
const SOURCE_LABEL: Record<string, string> = {
  tencent_ifzq: '腾讯ifzq', sina_jsonp: '新浪jsonp', tencent_qt: '腾讯qt', sina_hq: '新浪hq',
  ths_cs: '同花顺', push2delay: 'push2delay（东财系）', exchange: '交易所', tushare: 'tushare（历史层）',
};
const srcLabel = (id: string): string => SOURCE_LABEL[id] ?? id;
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/* ─────────────────────── 页面监看与请求账 ─────────────────────── */

interface QualityReq {
  path: string; from: string | null; to: string | null; code: string | null;
}
interface Watch {
  perr: string[];
  cerr: string[];    // 应用 console.error（有意阻断的网络诊断除外）
  netErrs: string[]; // 浏览器原生网络诊断（Failed to load resource…）
  loads: number;
  qualityReqs: QualityReq[];
}
function watchPage(page: Page): Watch {
  const w: Watch = { perr: [], cerr: [], netErrs: [], loads: 0, qualityReqs: [] };
  page.on('pageerror', (e) => w.perr.push(String(e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) w.netErrs.push(m.text().slice(0, 300));
    else w.cerr.push(m.text().slice(0, 300));
  });
  page.on('load', () => {
    w.loads += 1;
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!/\/api\/quality\/(divergence|source-accuracy|gaps)/.test(u)) return;
    const p = new URL(u).searchParams;
    w.qualityReqs.push({ path: new URL(u).pathname, from: p.get('from'), to: p.get('to'), code: p.get('code') });
  });
  return w;
}
async function assertClean(w: Watch, ctx: string): Promise<void> {
  expect(w.perr, `${ctx}: pageerror 应为 0`).toEqual([]);
  expect(w.cerr, `${ctx}: console.error 应为 0`).toEqual([]);
}

async function apiJson<T>(path: string): Promise<{ status: number; json: T | null }> {
  const r = await fetch(BASE + path);
  let json: T | null = null;
  try {
    json = (await r.json()) as T;
  } catch {
    /* 非 JSON 忽略 */
  }
  return { status: r.status, json };
}

/* ─────────────────────── 页面定位与稳定等待 ─────────────────────── */

const region = (page: Page, name: string) => page.locator(`[data-region="${name}"]`);
const divergenceSummary = (page: Page) => region(page, 'divergence-table').locator('[data-testid="divergence-summary"]');
const divergenceEmpty = (page: Page) => region(page, 'divergence-table').getByText(/该范围无比对数据/);

async function gotoQuality(page: Page): Promise<void> {
  await page.goto('/quality', { waitUntil: 'domcontentloaded' });
  await expect(region(page, 'quality')).toBeVisible({ timeout: 20_000 });
}

async function currentRange(page: Page): Promise<{ from: string; to: string }> {
  return {
    from: await page.locator('input[aria-label="开始日期"]').inputValue(),
    to: await page.locator('input[aria-label="结束日期"]').inputValue(),
  };
}
const codeOf = (page: Page) => page.locator('select[aria-label="标的"]').inputValue();

/** divergence 区进入终态（汇总行 OR 空态占位 OR 错误条；骨架消失） */
async function waitSettled(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="divergence-skeleton"]')).toHaveCount(0, { timeout: 25_000 });
  const ok = await Promise.race([
    divergenceSummary(page).waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
    divergenceEmpty(page).waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
    region(page, 'divergence-table').getByText(/^加载失败/).waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
  ]);
  expect(ok, 'divergence 区应达终态（汇总/空态/错误）').toBeTruthy();
}

/** 单边界日期变更：等待以此 (from,to,code) 为参数的 divergence GET 响应落回并稳定（避免并发链乱序） */
async function setOneDate(page: Page, field: 'from' | 'to', value: string): Promise<void> {
  const cur = await currentRange(page);
  const target = field === 'from' ? { from: value, to: cur.to } : { from: cur.from, to: value };
  const code = await codeOf(page);
  const respP = page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      /\/api\/quality\/divergence/.test(r.url()) &&
      (() => {
        const p = new URL(r.url()).searchParams;
        return p.get('from') === target.from && p.get('to') === target.to && p.get('code') === code;
      })(),
    { timeout: 25_000 },
  );
  await page.locator(`input[aria-label="${field === 'from' ? '开始日期' : '结束日期'}"]`).fill(value);
  await respP;
  await waitSettled(page);
}

/**
 * 日期区间变更。任意中间态窗口必须 ≤61 天（后端上限「日期跨度上限 62 天」）且 from≤to：
 * 目标 from 后移 → 先改 to；目标 from 前移 → 先改 from。本批所有窗口跨步均 ≤61 天，单跳可达。
 */
async function setRange(page: Page, from: string, to: string): Promise<void> {
  const cur = await currentRange(page);
  if (from === cur.from && to === cur.to) return;
  if (from >= cur.from) {
    if (to !== cur.to) await setOneDate(page, 'to', to);
    if (from !== cur.from) await setOneDate(page, 'from', from);
  } else {
    if (from !== cur.from) await setOneDate(page, 'from', from);
    if (to !== cur.to) await setOneDate(page, 'to', to);
  }
}

/** 各数据区进入已渲染终态（骨架无文字；等区内有正文） */
async function waitAccuracy(page: Page): Promise<void> {
  await expect
    .poll(async () => (await region(page, 'accuracy-cards').innerText().catch(() => '')).trim().length > 0, {
      timeout: 25_000,
      message: 'accuracy-cards 应进入终态',
    })
    .toBeTruthy();
}
async function waitGap(page: Page): Promise<void> {
  await expect
    .poll(async () => (await region(page, 'gap-report').innerText().catch(() => '')).trim().length > 0, {
      timeout: 25_000,
      message: 'gap-report 应进入终态',
    })
    .toBeTruthy();
}

/** accuracy-cards 有内容（卡数据/空态/错误条皆可；避免严格模式多元素） */
async function accuracyHasContent(page: Page): Promise<void> {
  await waitAccuracy(page);
  await expect
    .poll(async () => {
      const t = norm(await region(page, 'accuracy-cards').innerText().catch(() => ''));
      return t.includes('一致率') || t.includes('该窗口无比对样本') || t.includes('加载失败');
    }, { timeout: 20_000, message: 'accuracy-cards 应加载出内容或空态/错误态' })
    .toBeTruthy();
}

async function waitSync(page: Page): Promise<void> {
  await expect
    .poll(async () => (await region(page, 'sync-panel').innerText().catch(() => '')).includes('剩余积分'), {
      timeout: 25_000,
      message: 'sync-panel 应进入终态',
    })
    .toBeTruthy();
}

/* ─────────────────────── 证据 ─────────────────────── */

const evidence: Array<Record<string, string>> = [];
let shotNo = 0;
async function shot(page: Page, name: string): Promise<string> {
  const p = resolve(SHOT, `${String(shotNo++).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

/* 固定历史窗口（数据面已收口，任意日重跑稳定） */
const W_REAL = { from: '2026-09-03', to: '2026-09-04' };  // divergence 有行 / gaps 无缺口日
const W_GAP = { from: '2026-09-01', to: '2026-09-04' };   // gaps 2 个缺口日（09-01/09-02）
const W_EMPTY = { from: '2026-08-17', to: '2026-08-20' }; // raw 层起点(08-21)前 → divergence/accuracy 空

/* ─────────────────────────────── Q1 分歧表默认加载 ─────────────────────────────── */

test('Q1 分歧表默认范围加载：行字段=API、汇总统计、|偏差|降序（空态分支容忍）', async ({ page }) => {
  const w = watchPage(page);
  const respP = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/api\/quality\/divergence/.test(r.url()),
    { timeout: 25_000 },
  );
  await gotoQuality(page);
  const resp = await respP;
  const data = (await resp.json()) as {
    code: string; from: string; to: string; threshold_pct: number;
    summary: { compared_bars: number; divergent_bars: number; divergence_rate: number | null; consistency_rate: number | null; max_deviation_pct: number | null };
    rows: Array<{ ts: string; raw_close: number; accurate_close: number; deviation_pct: number; raw_source: string | null }>;
  };
  await waitSettled(page);

  // 请求参数 = 过滤条当前态（code/from/to）
  const code = await codeOf(page);
  const rg = await currentRange(page);
  const rp = new URL(resp.request().url()).searchParams;
  expect(rp.get('code')).toBe(code);
  expect(rp.get('from')).toBe(rg.from);
  expect(rp.get('to')).toBe(rg.to);

  const div = region(page, 'divergence-table');
  const table = div.locator('[data-testid="divergence-rows"]');
  if (data.rows.length === 0) {
    // 空态分支：占位文案 + 无行 + summary 空统计
    await expect(divergenceEmpty(page)).toBeVisible();
    await expect(table.locator('tr')).toHaveCount(0);
    expect(data.summary.compared_bars).toBe(0);
    expect(data.summary.consistency_rate).toBeNull();
    evidence.push({ case: 'Q1', pass: 'PASS', note: `空态分支：rows=0（${code} ${rg.from}..${rg.to}）` });
  } else {
    // 行数=API rows；首行逐格字段=格式化复算（时刻/raw收盘/accurate收盘/偏差%/来源标签）
    await expect(table.locator('tr')).toHaveCount(data.rows.length);
    const r0 = data.rows[0]!;
    const row0 = table.locator('tr').first();
    await expect(row0.locator('td').nth(0)).toHaveText(cstMdHm(r0.ts));
    await expect(row0.locator('td').nth(1)).toHaveText(price3(r0.raw_close));
    await expect(row0.locator('td').nth(2)).toHaveText(price3(r0.accurate_close));
    await expect(row0.locator('td').nth(3)).toHaveText(devPct(r0.deviation_pct));
    await expect(row0.locator('td').nth(4)).toHaveText(r0.raw_source ? srcLabel(r0.raw_source) : '—');
    // 汇总行统计（比对 bar / 一致率(≤threshold 计一致) / 最大偏差）；分歧率+一致率≈1
    const summaryTxt = norm(await divergenceSummary(page).innerText());
    expect(summaryTxt).toContain(`比对 ${data.summary.compared_bars} bar`);
    expect(summaryTxt).toContain(`（≤${data.threshold_pct}% 计一致）`);
    if (data.summary.consistency_rate != null) expect(summaryTxt).toContain(ratePct(data.summary.consistency_rate));
    if (data.summary.max_deviation_pct != null) expect(summaryTxt).toContain(devPct(data.summary.max_deviation_pct));
    if (data.summary.divergence_rate != null && data.summary.consistency_rate != null) {
      expect(Math.abs(data.summary.divergence_rate + data.summary.consistency_rate - 1)).toBeLessThan(1e-9);
    }
    // |偏差| 降序（首 20 行非增）
    for (let i = 1; i < Math.min(data.rows.length, 20); i += 1) {
      expect(Math.abs(data.rows[i]!.deviation_pct)).toBeLessThanOrEqual(Math.abs(data.rows[i - 1]!.deviation_pct) + 1e-12);
    }
    // 着色=threshold 口径：|dev|>t → text-up；分歧行数=summary.divergent_bars
    await expect(table.locator('td.text-up')).toHaveCount(data.summary.divergent_bars);
    const cls0 = await row0.locator('td').nth(3).getAttribute('class');
    if (Math.abs(r0.deviation_pct) > data.threshold_pct) expect(cls0).toContain('text-up');
    else expect(cls0).toContain('text-down');
    expect(summaryTxt).not.toContain('加载失败');
    evidence.push({
      case: 'Q1', pass: 'PASS',
      note: `code=${code} ${rg.from}..${rg.to} rows=${data.rows.length} compared=${data.summary.compared_bars} ` +
        `divergent=${data.summary.divergent_bars} consistency=${ratePct(data.summary.consistency_rate)} maxDev=${devPct(data.summary.max_deviation_pct)}`,
    });
  }
  expect(w.loads).toBe(1); // 无 reload/跳转
  expect(new URL(page.url()).pathname).toBe('/quality');
  await assertClean(w, 'Q1');
  await shot(page, 'Q1_divergence_default');
});

/* ─────────────────────────────── Q2 日期重查 + 空态 ─────────────────────────────── */

test('Q2 日期区间变更即重查（三端点 GET 参数对账）→ 无数据范围空态各区域', async ({ page }) => {
  const w = watchPage(page);
  await gotoQuality(page);
  await waitSettled(page);
  const code = await codeOf(page);
  const before = w.qualityReqs.length;

  await setRange(page, W_EMPTY.from, W_EMPTY.to);

  // 网络证据：变更后 divergence/source-accuracy/gaps 各 ≥1 次携带新 from/to 的 GET
  const afterReqs = w.qualityReqs.slice(before);
  for (const p of ['/api/quality/divergence', '/api/quality/source-accuracy', '/api/quality/gaps']) {
    expect(
      afterReqs.some((q) => q.path === p && q.from === W_EMPTY.from && q.to === W_EMPTY.to && (p === '/api/quality/source-accuracy' || q.code === code)),
      `日期重查应重新 GET ${p}（from=${W_EMPTY.from} to=${W_EMPTY.to}）`,
    ).toBeTruthy();
  }
  await waitAccuracy(page);
  await waitGap(page);

  // 无数据范围（raw 起点前）：分歧表占位 + accuracy 无样本；gap-report 仍列缺口日（raw 缺失→系统缺口）；sync 不受范围影响
  await expect(divergenceEmpty(page)).toBeVisible();
  await expect(region(page, 'accuracy-cards').getByText('该窗口无比对样本')).toBeVisible();
  const gapTxt = norm(await region(page, 'gap-report').innerText());
  expect(gapTxt).toContain('08-17缺 241 bar / 应到 241');
  expect(gapTxt).toContain('系统缺口');
  const syncTxt = norm(await region(page, 'sync-panel').innerText());
  expect(syncTxt).toContain('剩余积分');
  await expect(region(page, 'divergence-table').getByText(/加载失败/)).toHaveCount(0);
  expect(w.loads).toBe(1); // 无 reload/跳转
  expect(new URL(page.url()).pathname).toBe('/quality');
  await assertClean(w, 'Q2');
  await shot(page, 'Q2_empty_range');
  evidence.push({ case: 'Q2', pass: 'PASS', note: `重查 GET 三端点各≥1（${W_EMPTY.from}..${W_EMPTY.to}）；空态文案命中` });
});

/* ─────────────────────────────── Q3 threshold 口径 ─────────────────────────────── */

test('Q3 threshold：默认 0.5 注解/着色=API；threshold_pct 参数可改', async ({ page }) => {
  const w = watchPage(page);
  const respP = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/api\/quality\/divergence/.test(r.url()),
    { timeout: 25_000 },
  );
  await gotoQuality(page);
  const resp = await respP;
  const data = (await resp.json()) as {
    code: string; from: string; to: string; threshold_pct: number;
    summary: { divergent_bars: number; consistency_rate: number | null };
    rows: Array<{ deviation_pct: number }>;
  };
  await waitSettled(page);
  const summaryTxt = norm(await divergenceSummary(page).innerText());
  expect(data.threshold_pct).toBe(0.5); // 缺省由后端兜底 0.5（QUALITY_DEFAULTS.consistencyThresholdPct）
  expect(summaryTxt).toContain('（≤0.5% 计一致）');

  const table = region(page, 'divergence-table').locator('[data-testid="divergence-rows"]');
  const n = await table.locator('tr').count();
  if (n > 0) {
    // 分歧行（td.text-up）数 = summary.divergent_bars
    await expect(table.locator('td.text-up')).toHaveCount(data.summary.divergent_bars);
    // 逐行着色=threshold 判定（首/中/尾采样）
    const rows = table.locator('tr');
    const sample = [...new Set([0, 1, 2, Math.floor(n / 2), n - 1])];
    for (const i of sample) {
      const cls = await rows.nth(i).locator('td').nth(3).getAttribute('class');
      const dev = data.rows[i]!.deviation_pct;
      if (Math.abs(dev) > data.threshold_pct) expect(cls, `row${i} 应为分歧色 text-up`).toContain('text-up');
      else expect(cls, `row${i} 应为一致色 text-down`).toContain('text-down');
    }
  }

  // API threshold_pct 可改（回声透传 + 统计重算）：0.05 → 更多分歧；0.9 → 零分歧且一致率更高
  const q = `code=${data.code}&from=${data.from}&to=${data.to}`;
  const d05 = await apiJson<{ threshold_pct: number; summary: { divergent_bars: number; consistency_rate: number | null } }>(
    `/api/quality/divergence?${q}&threshold_pct=0.05`,
  );
  const d09 = await apiJson<{ threshold_pct: number; summary: { divergent_bars: number; consistency_rate: number | null } }>(
    `/api/quality/divergence?${q}&threshold_pct=0.9`,
  );
  expect(d05.json?.threshold_pct).toBe(0.05);
  expect(d09.json?.threshold_pct).toBe(0.9);
  expect((d05.json?.summary.divergent_bars ?? 0)).toBeGreaterThanOrEqual(data.summary.divergent_bars);
  expect((d09.json?.summary.divergent_bars ?? 0)).toBeLessThanOrEqual(data.summary.divergent_bars);
  expect((d05.json?.summary.divergent_bars ?? 0)).toBeGreaterThan((d09.json?.summary.divergent_bars ?? 0));
  expect((d05.json?.summary.consistency_rate ?? 0)).toBeLessThanOrEqual((d09.json?.summary.consistency_rate ?? 1));
  await expect(region(page, 'divergence-table').getByText(/加载失败/)).toHaveCount(0);
  await assertClean(w, 'Q3');
  await shot(page, 'Q3_threshold');
  evidence.push({
    case: 'Q3', pass: 'PASS',
    note: `默认 t=0.5（divergent=${data.summary.divergent_bars}）；t=0.05→${d05.json?.summary.divergent_bars ?? '-'}；t=0.9→${d09.json?.summary.divergent_bars ?? '-'}`,
  });
});

/* ─────────────────────────────── Q4 overlay 双线 ─────────────────────────────── */

test('Q4 overlay：raw vs accurate 双线叠加（真实窗口）+ 缩放 ×2/重置 + 空态（无数据范围）', async ({ page }) => {
  const w = watchPage(page);
  await gotoQuality(page);
  await waitSettled(page);
  await setRange(page, W_REAL.from, W_REAL.to); // 固定真实窗口（收盘后静态）
  const code = await codeOf(page);
  const rowsApi = await apiJson<{ rows: Array<{ ts: string; deviation_pct: number }> }>(
    `/api/quality/divergence?code=${code}&from=${W_REAL.from}&to=${W_REAL.to}`,
  );
  const rows = rowsApi.json?.rows ?? [];
  expect(rows.length).toBeGreaterThan(0); // 固定窗口必有比对行（accurate 已同步，09-03/04 有行）

  const divGetsBefore = w.qualityReqs.filter((q) => q.path.endsWith('/divergence')).length;
  // 视图切换（客户端状态，不触发重查）
  await page.getByRole('button', { name: '叠加图' }).click();
  const svg = page.locator('[data-testid="overlay-chart-svg"]');
  await expect(svg).toBeVisible();
  await expect(page.locator('[data-testid="line-raw"]')).toBeVisible();
  await expect(page.locator('[data-testid="line-accurate"]')).toBeVisible();
  const pts = async () => {
    const raw = await page.locator('[data-testid="line-raw"]').getAttribute('points');
    const acc = await page.locator('[data-testid="line-accurate"]').getAttribute('points');
    return { raw: raw?.trim().split(/\s+/).length ?? 0, acc: acc?.trim().split(/\s+/).length ?? 0 };
  };
  const p0 = await pts();
  expect(p0.raw).toBe(rows.length); // 双线点数 = 升序 rows 数
  expect(p0.acc).toBe(rows.length);
  // 图例 + 最大偏差标注（=API 首行：|偏差| 最大）
  const ovTxt = norm(await region(page, 'overlay-chart').innerText());
  expect(ovTxt).toContain('raw 收盘');
  expect(ovTxt).toContain('accurate 收盘');
  const maxRow = rows.reduce((best, r) => (Math.abs(r.deviation_pct) > Math.abs(best.deviation_pct) ? r : best), rows[0]!);
  expect(ovTxt).toContain(`最大偏差 ${cstMdHm(maxRow.ts)} ${devPct(maxRow.deviation_pct)}`);
  // 视图切换零重查
  expect(w.qualityReqs.filter((q) => q.path.endsWith('/divergence')).length).toBe(divGetsBefore);

  // 放大 → ×2，点数=ceil(n/2)（窗口化以最大偏差点为中心）；重置还原
  await page.getByRole('button', { name: '放大' }).click();
  await expect(page.getByText('×2')).toBeVisible();
  const p2 = await pts();
  expect(p2.raw).toBe(Math.ceil(rows.length / 2));
  expect(p2.acc).toBe(Math.ceil(rows.length / 2));
  await page.getByRole('button', { name: '重置缩放' }).click();
  const p1 = await pts();
  expect(p1.raw).toBe(rows.length);
  await expect(page.getByText('×2')).toHaveCount(0);

  // 回表视图 → 无数据范围 → 空态（overlay 无 svg、文案占位）
  await page.getByRole('button', { name: '分歧表' }).click();
  await setRange(page, W_EMPTY.from, W_EMPTY.to);
  await page.getByRole('button', { name: '叠加图' }).click();
  await expect(region(page, 'overlay-chart').getByText('该范围无比对数据')).toBeVisible({ timeout: 10_000 });
  expect(await page.locator('[data-testid="overlay-chart-svg"]').count()).toBe(0);
  expect(w.loads).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/quality');
  await assertClean(w, 'Q4');
  await shot(page, 'Q4_overlay_real');
  await shot(page, 'Q4_overlay_empty');
  evidence.push({ case: 'Q4', pass: 'PASS', note: `双线点数=${rows.length}；×2→${Math.ceil(rows.length / 2)}；空态无 svg；视图切换零重查` });
});

/* ─────────────────────────────── Q5 缺口报告 ─────────────────────────────── */

test('Q5 缺口报告：缺口日/段=API（分类标签）+ 无缺口日窗口「该范围无缺口」', async ({ page }) => {
  const w = watchPage(page);
  await gotoQuality(page);
  await waitSettled(page);
  const code = await codeOf(page);
  // 真实缺口日窗口 09-01..09-04（09-01 全缺 / 09-02 缺 174）
  await setRange(page, W_GAP.from, W_GAP.to);
  await waitGap(page);
  const gapJson = await apiJson<{
    days: Array<{
      date: string; expected_bars: number; missing_bars: number;
      segments: Array<{ start: string; end: string; count: number; class: string }>;
    }>;
  }>(`/api/quality/gaps?code=${code}&from=${W_GAP.from}&to=${W_GAP.to}`);
  const days = gapJson.json?.days ?? [];
  expect(days.length).toBeGreaterThan(0);
  const gapTxt = norm(await region(page, 'gap-report').innerText());
  const CLASS_LABEL: Record<string, string> = { source_fault: '源故障', upstream_no_data: '上游无数据', system_gap: '系统缺口' };
  for (const d of days.slice(0, 2)) {
    expect(gapTxt).toContain(`${d.date.slice(5)}缺 ${d.missing_bars} bar / 应到 ${d.expected_bars}`);
    for (const s of d.segments) {
      expect(gapTxt).toContain(`缺 ${s.start}-${s.end}（${s.count} bar）`);
      expect(gapTxt).toContain(CLASS_LABEL[s.class] ?? s.class);
    }
  }

  // 无缺口日窗口 09-03..09-04：gap「该范围无缺口」，同屏 divergence 仍有行（两态并存）
  await setRange(page, W_REAL.from, W_REAL.to);
  await waitGap(page);
  await expect(region(page, 'gap-report').getByText('该范围无缺口')).toBeVisible();
  await expect(divergenceSummary(page)).toBeVisible();
  expect(await page.locator('[data-testid="divergence-rows"] tr').count()).toBeGreaterThan(0);
  await expect(region(page, 'gap-report').getByText(/加载失败/)).toHaveCount(0);
  expect(w.loads).toBe(1);
  await assertClean(w, 'Q5');
  await shot(page, 'Q5_gap_days');
  await shot(page, 'Q5_gap_none');
  evidence.push({
    case: 'Q5', pass: 'PASS',
    note: `缺口日=${days.map((d) => `${d.date.slice(5)}(缺${d.missing_bars})`).join(',')}；无缺口窗口 09-03..09-04「该范围无缺口」且分歧行>0`,
  });
});

/* ─────────────────────────────── Q6 source-accuracy ─────────────────────────────── */

test('Q6 source-accuracy 排行榜卡逐字段=API + 无数据窗口「该窗口无比对样本」', async ({ page }) => {
  const w = watchPage(page);
  await gotoQuality(page);
  await waitSettled(page);
  const rg = await currentRange(page);
  await waitAccuracy(page);
  const accJson = await apiJson<{
    sources: Array<{ source: string; samples: number; consistency_rate: number | null; avg_deviation_pct: number | null; max_deviation_pct: number | null }>;
  }>(`/api/quality/source-accuracy?from=${rg.from}&to=${rg.to}`);
  const sources = accJson.json?.sources ?? [];
  const acc = region(page, 'accuracy-cards');
  if (sources.length === 0) {
    await expect(acc.getByText('该窗口无比对样本')).toBeVisible();
  } else {
    await expect(acc.locator('div.rounded-xl')).toHaveCount(sources.length);
    const txt = norm(await acc.innerText());
    for (const s of sources) {
      expect(txt, `card for ${s.source}`).toContain(srcLabel(s.source));
      expect(txt).toContain(`一致率 ${ratePct(s.consistency_rate)}`);
      expect(txt).toContain(`平均偏差 ${devPct(s.avg_deviation_pct)}`);
      expect(txt).toContain(`样本 ${s.samples} bar`);
      expect(txt).toContain(`最大偏差 ${devPct(s.max_deviation_pct)}`);
    }
  }
  await expect(acc.getByText(/加载失败/)).toHaveCount(0);

  // 无数据窗口（raw 起点前）→ 该窗口无比对样本
  await setRange(page, W_EMPTY.from, W_EMPTY.to);
  await waitAccuracy(page);
  await expect(acc.getByText('该窗口无比对样本')).toBeVisible();
  expect(w.loads).toBe(1);
  await assertClean(w, 'Q6');
  await shot(page, 'Q6_accuracy');
  evidence.push({ case: 'Q6', pass: 'PASS', note: `sources=${sources.length} 逐卡=API；无数据窗口文案命中` });
});

/* ─────────────────────────────── Q7 tushare 同步状态 ─────────────────────────────── */

test('Q7 tushare 同步状态：最近同步/覆盖/最近事件=API；quota null→「—」；checkpoints 契约', async ({ page }) => {
  const w = watchPage(page);
  await gotoQuality(page);
  await waitSettled(page);
  await waitSync(page);
  const st = await apiJson<{
    checkpoints: Array<{ code: string; period: string; last_synced_date: string; updated_at: string }>;
    covered_codes: number;
    last_updated_at: string | null;
    last_event: { ts: string; ok: boolean; err_kind: string | null } | null;
    quota_remaining: number | null;
  }>('/api/tushare/status');
  const s = st.json;
  expect(s).not.toBeNull();
  const syncTxt = norm(await region(page, 'sync-panel').innerText());
  const neverSynced = s!.checkpoints.length === 0 && s!.last_updated_at == null;
  if (neverSynced) {
    await expect(region(page, 'sync-panel').getByText(/从未同步/)).toBeVisible();
  } else {
    if (s!.last_updated_at == null) expect(syncTxt).toContain('最近同步 —');
    else expect(syncTxt).toContain(`最近同步 ${cstMdHm(s!.last_updated_at)}`);
    expect(syncTxt).toContain(`覆盖 ${s!.covered_codes} 只`);
    if (s!.last_event) {
      if (s!.last_event.ok) expect(syncTxt).toContain(`成功 ${cstMdHm(s!.last_event.ts)}`);
      else expect(syncTxt).toContain(`失败 ${cstMdHm(s!.last_event.ts)}（${s!.last_event.err_kind ?? 'unknown'}）`);
    } else {
      expect(syncTxt).toContain('最近事件 —');
    }
  }
  // quota_remaining 恒 null → 剩余积分「—」（07-app-plane §1.1：积分余额未入库）
  expect(s!.quota_remaining).toBeNull();
  expect(syncTxt).toContain('剩余积分 —（quota 硬约束；积分余额未入库）');
  // checkpoints 契约字段 + 覆盖数=唯一 code 数
  const cps = s!.checkpoints;
  expect(cps.length).toBeGreaterThan(0);
  for (const c of cps) {
    expect(Object.keys(c).sort()).toEqual(['code', 'last_synced_date', 'period', 'updated_at']);
    expect(typeof c.code).toBe('string');
    expect(typeof c.period).toBe('string');
    expect(typeof c.last_synced_date).toBe('string');
    expect(typeof c.updated_at).toBe('string');
  }
  expect(new Set(cps.map((c) => c.code)).size).toBe(s!.covered_codes);
  // 手动同步按钮置灰（wave-2.md 边界）+ 引导文案
  const syncBtn = region(page, 'sync-panel').getByRole('button', { name: '手动同步' });
  await expect(syncBtn).toBeDisabled();
  await expect(syncBtn).toHaveAttribute('title', '下阶段开放');
  expect(syncTxt).toContain('手动补拉 accurate 下阶段开放（wave-2.md 边界）');
  await expect(region(page, 'sync-panel').getByText(/加载失败/)).toHaveCount(0);
  expect(w.loads).toBe(1);
  await assertClean(w, 'Q7');
  await shot(page, 'Q7_sync');
  evidence.push({
    case: 'Q7', pass: 'PASS',
    note: `covered=${s!.covered_codes} checkpoints=${cps.length} last=${s!.last_updated_at} quota=null→「—」`,
  });
});

/* ─────────────────────────────── Q8-Q10 错误态（route abort） ─────────────────────────────── */

interface ErrCase {
  no: string;
  endpoint: string;
  urlPat: string;
  regionName: string;
  otherOk(page: Page): Promise<void>;
  recovered(page: Page): Promise<void>;
}

const ERR_CASES: ErrCase[] = [
  {
    no: 'Q8', endpoint: 'divergence', urlPat: '**/api/quality/divergence*',
    regionName: 'divergence-table',
    otherOk: async (page: Page) => {
      await accuracyHasContent(page);
      await waitSync(page);
      await waitGap(page);
      const gapTxt = norm(await region(page, 'gap-report').innerText());
      expect(gapTxt.length).toBeGreaterThan(0);
      expect(gapTxt).not.toContain('加载失败');
    },
    recovered: async (page: Page) => {
      await waitSettled(page);
      await expect(divergenceSummary(page).or(divergenceEmpty(page))).toBeVisible();
    },
  },
  {
    no: 'Q9', endpoint: 'source-accuracy', urlPat: '**/api/quality/source-accuracy*',
    regionName: 'accuracy-cards',
    otherOk: async (page: Page) => {
      await waitSettled(page);
      await waitSync(page);
      await waitGap(page);
      const gapTxt = norm(await region(page, 'gap-report').innerText());
      expect(gapTxt).not.toContain('加载失败');
    },
    recovered: async (page: Page) => {
      await accuracyHasContent(page);
    },
  },
  {
    no: 'Q10', endpoint: 'gaps', urlPat: '**/api/quality/gaps*',
    regionName: 'gap-report',
    otherOk: async (page: Page) => {
      await waitSettled(page);
      await accuracyHasContent(page);
      await waitSync(page);
    },
    recovered: async (page: Page) => {
      await waitGap(page);
      const gapTxt = norm(await region(page, 'gap-report').innerText());
      expect(gapTxt).toMatch(/缺 |该范围无缺口/);
    },
  },
];

for (const c of ERR_CASES) {
  test(`${c.no} 错误态：阻断 /api/quality/${c.endpoint} → 该区错误+重试（其余区正常不崩）`, async ({ page }) => {
    const w = watchPage(page);
    await page.route(c.urlPat, (route) => route.abort());
    await gotoQuality(page);
    const r = region(page, c.regionName);
    await expect(r.getByText(/^加载失败：/)).toBeVisible({ timeout: 25_000 });
    await expect(r.getByRole('button', { name: '重试' })).toBeVisible();
    // 其余区域独立正常（错误不扩散、不崩溃）
    await c.otherOk(page);
    expect(w.perr).toEqual([]);
    await shot(page, `${c.no}_error`);
    // 解除阻断 → 点重试 → 该区恢复
    await page.unroute(c.urlPat);
    await r.getByRole('button', { name: '重试' }).click();
    await c.recovered(page);
    await expect(r.getByText(/^加载失败：/)).toHaveCount(0, { timeout: 15_000 });
    expect(w.loads).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/quality');
    // 有意阻断产生浏览器原生网络诊断（netErrs 单列）；应用 console.error 仍为 0
    expect(w.netErrs.length).toBeGreaterThan(0);
    expect(w.cerr, `${c.no}: 应用 console.error 应为 0`).toEqual([]);
    await shot(page, `${c.no}_recovered`);
    evidence.push({ case: c.no, pass: 'PASS', note: `${c.endpoint} 阻断→错误条+重试；unroute 后重试恢复；netErrs=${w.netErrs.length}` });
  });
}

/* 收尾：证据 JSON（自述位置） */
test.afterAll(async () => {
  writeFileSync(
    resolve(SHOT, 'evidence.json'),
    JSON.stringify({ file: resolve(here, 'quality-deep.e2e.ts'), evidence }, null, 2),
    'utf8',
  );
});
