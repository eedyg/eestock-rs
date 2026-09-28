import { expect, test, type Page } from '@playwright/test';
import { gotoPage } from './helpers/pages';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 看板批 1a — 周期深翻 / 分页批量 / MA 配置（真实浏览器 E2E 回归）。
 *
 * 本文件位置（self-location）：`web/e2e/dashboard-periods-ma.e2e.ts`
 *
 * 运行对象（真容器，本 spec 不做除 MA 配置恢复默认之外的任何数据修改）：
 *   eestock-app 镜像 3dec9b69f005 / SPA index-B9RewKvL.js / http://127.0.0.1:8081（healthy），
 *   含 b92fc88（feed.ts：分页批量 1d=250/1w=150/1mo=80/1m=500；周/月 cagg 全历史无 2024 过滤）。
 *
 * 聚焦范围（单次回归只测这些）：
 *   T1 周线深翻：连续左翻直至 earliest <2022-01-01（覆盖 ≥2022 且含 <2024 蜡烛），
 *      断言蜡烛 ts 有 <2024、无空档（周 Δ∈{7,…,21 天}）无重复；深翻 network limit=150（非 2）。
 *   T2 月线深翻：同上，forward limit=80；月 Δ∈[26,36] 天。
 *   T3 日线深翻：连续左翻 ≥2 个 forward 页，forward limit=250、响应满页、Δ≤11 天（无缺口）、无重复。
 *   T4 分钟 1m 深翻：forward limit=500（初始视口 482），无重复，canvas 随深翻推进。
 *   T5 MA 配置：[3,7,21] 保存 → 主图+宫格 MA 生效（canvas 指纹变化）+ PUT 200；
 *      切周期(日/周/月)后仍 [3,7,21]；reload 后仍 [3,7,21]（GET /api/config/ma 佐证 + 主图指纹变化）；
 *      非法输入(0/空/非整) → 前端提示 + 零 PUT + 配置不变；恢复默认 [5,10,20]。
 *   T1–T5 全程 pageerror=0 / console.error=0。
 *
 * 断言口径：
 *   - 蜡烛 ts/批量以 network 层 /api/kline 请求+响应体为准（= 实际送入 klinecharts 的数据）；
 *   - canvas 指纹（整图 dataURL diff）作 MA 生效与深翻推进的真实绘制佐证；
 *   - 异步（分页加载/保存）一律 waitFor/轮询后再断言，不硬 sleep 猜状态。
 *
 * ## 「分页批量」判据重锚（2026-09-25；定性 = 规格陈旧·数据域边界，非产品缺陷）
 *
 * **失败串（重锚前，真身复跑逐字）**：
 *   `每个 forward 请求 limit=80 且响应 80 根（非 2）: [{"limit":80,"n":39,"before":"2016-09-30T16:00:00Z"}]`
 * **读数（`:8081` 现场）**：518880 `period=1mo` 数据域**总 159 根**（2013-06-30…2026-08-31）；
 * 初始视口 120 根 ⇒ 更早仅剩 **39 根**；同游标 `limit=500` 直连 `/api/kline` 仍只回 39 且 `next_before=null`
 * ⇒ 短页是**数据域末端**（非服务端夹取）。故「每页恰 80 根」要求总根数 ≥ 120 + 80 = 200，
 * 而本周期数据域自 2026-09-23 的既有红起便只有 159 根 ⇒ **判据数学上不可满足**（既有红，非近期引入）。
 *
 * **旧值 → 新值（依据 = 上表读数）**：
 *   | 旧口径 | 新口径 | 为何不是削判据 |
 *   |---|---|---|
 *   | 每页 `limit == BATCH[period]` | **不变**（请求侧照旧逐个断言） | ——（未动） |
 *   | 每页 `n == BATCH[period]`（恒满页） | 满页 ⇒ `n == BATCH`；短页 ⇒ **现场举证**：同 `before` 游标抬高 limit 仍只回 `n` 且 `next_before=null` | 旧口径在域内不足一批时不可满足（假红）；新口径在**非边界页与旧口径逐字等价**，在边界页把「恰为域内剩余根数」钉死 ⇒ 对「有损分页/服务端少回」**更强**（旧的 80 在边界页无法表达） |
 *   | 附带「（非 2）」 | 移除该独立条款（由 `limit == BATCH` ∧ 短页举证两条更强条款覆盖） | 「2 根」缺陷在请求侧（limit≠80）或响应侧（举证回包 > n）必被上述两条之一捕获；保留它会令「数据域真的只剩 ≤2 根」成为假红 |
 * 现场真值由 `shortPageBoundaryProof()` 现场取（不硬编码任何根数）；逐页判定读数落 `forwardVerdicts` 入证据 JSON。
 * **非恒真**：把 1mo forward 响应在 route 层截成 2 根（= 旧缺陷形态）⇒ 短页举证失败 ⇒ 本判据必红（见报告 §项 2 非恒真证明）。
 *
 * 环境变量：E2E_BASE_URL（默认 http://localhost:8081）；E2E_SHOTS（证据目录，默认 /tmp/dashboard_periods_ma）。
 */

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
const SHOT = process.env.E2E_SHOTS ?? '/tmp/dashboard_periods_ma';
mkdirSync(SHOT, { recursive: true });

const ENV_TAG = `eestock-app img 3dec9b69f005 · SPA index-B9RewKvL.js (b92fc88) · ${BASE}`;

/** 分页批量 / 初始视口 pageSize（feed.ts PAGINATION_BATCH / paginationBatchForPeriod；ADR-020 口径）
 *  - BATCH：深翻每页批量（loadBefore），与视口解耦，维持 PAGINATION_BATCH 不变；
 *  - INIT_PAGE：初始视口 = 配置的 K 线根数（默认 120，主图+宫格统一、与周期无关）—— 全周期同值。 */
const BATCH: Record<string, number> = { '1w': 150, '1mo': 80, '1d': 250, '1m': 500 };
const INIT_PAGE: Record<string, number> = { '1w': 120, '1mo': 120, '1d': 120, '1m': 120 };
const BTN: Record<string, string> = { '1w': '周', '1mo': '月', '1d': '日', '1m': '1m' };

/* ───────────────────────────── 通用 helpers ───────────────────────────── */

interface ErrWatch {
  perr: string[];
  cerr: string[];
}
/** 采集 pageerror / console.error */
function watchErrors(page: Page): ErrWatch {
  const w: ErrWatch = { perr: [], cerr: [] };
  page.on('pageerror', (e) => w.perr.push(String(e).slice(0, 500)));
  page.on('console', (m) => {
    if (m.type() === 'error') w.cerr.push(m.text().slice(0, 500));
  });
  return w;
}
function assertNoErrors(w: ErrWatch, ctx: string) {
  expect(w.perr, `${ctx}: pageerror 应为 0`).toEqual([]);
  expect(w.cerr, `${ctx}: console.error 应为 0`).toEqual([]);
}

/** 证据截图（带 env+time caption 水印） */
async function addTag(page: Page, label: string) {
  await page.evaluate(
    ({ envTag, label }) => {
      document.querySelectorAll('#ev-cap').forEach((e) => e.remove());
      const d = document.createElement('div');
      d.id = 'ev-cap';
      d.style.cssText =
        'position:fixed;top:6px;right:6px;z-index:999999;background:rgba(0,0,0,.72);color:#fff;font:11px/1.5 monospace;padding:4px 8px;border-radius:6px;pointer-events:none;white-space:pre;text-align:right;max-width:520px';
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
  await page.waitForTimeout(220);
  await page.screenshot({ path: `${SHOT}/${name}` });
  await page.evaluate(() => document.querySelectorAll('#ev-cap').forEach((e) => e.remove()));
}
function saveJson(name: string, obj: unknown) {
  writeFileSync(`${SHOT}/${name}`, JSON.stringify(obj, null, 1));
}

function bt(page: Page, name: string) {
  return page.locator('[data-region="toolbar"]').getByRole('button', { name, exact: true });
}
function maBtn(page: Page) {
  return page.locator('[data-region="toolbar"]').getByRole('button', { name: 'MA 配置' });
}

/** 等主图稳定：chart canvas 可见 + 骨架消失 */
async function waitChart(page: Page, timeout = 30_000) {
  const chart = page.locator('[data-testid="kline-chart"]');
  await expect(chart).toBeVisible({ timeout });
  await expect(chart.locator('canvas').first()).toBeVisible({ timeout });
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout });
  await page.waitForTimeout(1200);
}

/** 等宫格 2×2：4 格 canvas 就绪 */
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

/** kline 请求/响应收集（url 参数 + 响应 bar ts） */
interface KPage {
  url: string;
  period: string;
  limit: number;
  before: string | null;
  bars: Array<{ ts: string }>;
}
function watchKline(page: Page): KPage[] {
  const pages: KPage[] = [];
  page.on('response', async (r) => {
    const u = decodeURIComponent(r.url());
    if (!u.includes('/api/kline')) return;
    try {
      const url = new URL(u);
      const period = url.searchParams.get('period') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 0);
      const before = url.searchParams.get('before');
      const j = (await r.json()) as { bars?: Array<{ ts: string }> };
      pages.push({ url: url.pathname + url.search, period, limit, before, bars: j.bars ?? [] });
    } catch {
      /* 忽略非 JSON/中断响应 */
    }
  });
  return pages;
}

/** 主图 canvas 内容指纹（全部 canvas dataURL 并集） */
async function chartHashAll(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-testid="kline-chart"] canvas'))
      .map((c) => c.toDataURL())
      .join('|'),
  );
}
/** 宫格单元 canvas 指纹（每格首个 canvas） */
async function gridHash(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-region="grid-view"] [data-grid-cell] canvas'))
      .map((c) => c.toDataURL())
      .join('|'),
  );
}
/** 稳定指纹：连续两次采样一致才返回 */
async function stableHash(fn: () => Promise<string>, tries = 12): Promise<string> {
  let prev = '';
  for (let i = 0; i < tries; i++) {
    const h = await fn();
    if (prev && h === prev) return h;
    prev = h;
    await new Promise((r) => setTimeout(r, 500));
  }
  return prev;
}

/** 主图蜡烛像素计数（红涨 #ff5c6c / 绿跌 #00e0a4，抽样）——记录为证据，不硬卡阈值 */
async function candleColors(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    const cs = Array.from(el?.querySelectorAll('canvas') ?? []);
    if (cs.length === 0) return null;
    const main = cs
      .filter((c) => c.width > 200 && c.height > 100)
      .sort((a, b) => b.height - a.height)[0];
    if (!main) return null;
    const ctx = main.getContext('2d');
    if (!ctx) return null;
    let up = 0, down = 0;
    try {
      const img = ctx.getImageData(0, 0, main.width, Math.min(main.height, 900)).data;
      const near = (p: number[], c: number[]) => p.every((v, i) => Math.abs(v - c[i]) < 45);
      const y0 = Math.floor(main.height * 0.15), y1 = Math.floor(main.height * 0.78);
      for (let y = y0; y < y1; y += 2)
        for (let x = 0; x < main.width; x += 2) {
          const i = (y * main.width + x) * 4;
          const p = [img[i], img[i + 1], img[i + 2]];
          if (near(p, [255, 92, 108])) up++;
          else if (near(p, [0, 224, 164])) down++;
        }
    } catch (e) {
      return { up: -2, down: -2, w: main.width, h: Math.min(main.height, 900), err: String(e) };
    }
    return { up, down, w: main.width, h: Math.min(main.height, 900) };
  });
}

/** 整幅向右拖拽一次（查看更早历史 → DataLoader forward → 深翻分页） */
async function dragOlder(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const steps = 44;
  const dx = Math.max(10, Math.round((box.width * 0.8) / steps));
  const y = box.y + box.height * 0.4;
  const x0 = box.x + box.width * 0.08;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + dx * i, y, { steps: 2 });
  await page.mouse.up();
}

/** 周期连续性判定规则（容忍真实数据合法缺口，拒绝「空洞/重复/乱序」） */
function weeklyDeltaOk(dd: number) {
  return dd % 7 === 0 && dd >= 7 && dd <= 21;
}
function monthlyDeltaOk(dd: number) {
  return dd >= 26 && dd <= 36;
}
function dailyDeltaOk(dd: number) {
  return dd >= 1 && dd <= 11;
}
type DeltaRule = (dd: number) => boolean;

/** 当前选中标的（主图 code；用于分页判据的**现场数据域举证**）。 */
async function selectedSymbolCode(page: Page): Promise<string> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-region="symbol-list"] button[data-selected="true"]');
    return row?.querySelector('b')?.textContent?.trim() ?? '';
  });
}

/**
 * **分页短页的数据域末端举证**（真值取自后端，不硬编码任何根数）。
 *
 * 口径：同一 `before` 游标下索取「明显多于本页」的根数 —— 若仍只回同数且 `next_before=null`，
 * 则数据域内确实仅剩这些根 ⇒ 短页是**数据域边界**（非有损分页、非服务端夹取）；
 * 反之（回包更多）⇒ 本页确实丢了数据 ⇒ 判据红。
 */
async function shortPageBoundaryProof(
  code: string,
  period: string,
  before: string,
  pageN: number,
  batch: number,
): Promise<{ probeLimit: number; n: number; nextBefore: string | null; onlyPageN: boolean }> {
  // 举证口径：至少索取「本页根数 + 1」并且**不小于该周期批量** ⇒ 回包不多于本页即证明域内确无更早数据。
  const probeLimit = Math.max(pageN + 1, batch);
  const r = await fetch(
    `${BASE}/api/kline?code=${code}&period=${period}&before=${encodeURIComponent(before)}&limit=${probeLimit}`,
  );
  const j = (await r.json()) as { bars?: unknown[]; next_before?: string | null };
  const n = (j.bars ?? []).length;
  const nextBefore = j.next_before ?? null;
  return { probeLimit, n, nextBefore, onlyPageN: n === pageN && nextBefore === null };
}

interface PanOutcome {
  period: string;
  dragsUsed: number;
  reached: boolean;
  earliestTs: string | null;
  unionCount: number;
  dups: number;
  initialPages: Array<{ limit: number; n: number }>;
  forwardPages: Array<{ limit: number; n: number; before: string | null }>;
  /** 逐页判定读数（重锚后判据的完整依据：批量、满页/短页、短页的域末端举证）。 */
  forwardVerdicts: Array<{ limit: number; n: number; before: string | null; ok: boolean; why: string }>;
  allForwardFull: boolean;
  allForwardBatch: boolean;
  badDeltas: number[];
  deltaMax: number;
  year2022_2023: boolean;
  colors: { up: number; down: number; w: number; h: number } | null;
  cap1: string;
  capTail: string;
}

/**
 * 深翻主循环：切周期 → 反复整幅拖拽（forward 翻页）直到满足停止条件。
 * stopBefore：earliest ts < stopBefore（ISO）即停；minForward：forward 页数下限。
 * deltaRule：跨页连续性规则（对 union 全部相邻 delta 校验），违规记入 badDeltas。
 */
async function deepPan(
  page: Page,
  period: string,
  opts: {
    stopBefore?: string;
    minForward?: number;
    maxDrags?: number;
    settleMs?: number;
    tailDrags?: number;
    deltaRule?: DeltaRule;
  } = {},
): Promise<PanOutcome> {
  const stopBefore = opts.stopBefore ?? '';
  const minForward = opts.minForward ?? 0;
  const maxDrags = opts.maxDrags ?? 45;
  const settleMs = opts.settleMs ?? 380;
  const tailDrags = opts.tailDrags ?? 2;
  const kpages = watchKline(page);
  const chart = page.locator('[data-testid="kline-chart"]');
  const box = (await chart.boundingBox())!;
  const cap = async () => chartHashAll(page);

  await bt(page, BTN[period]!).click();
  await expect(bt(page, BTN[period]!)).toHaveAttribute('aria-pressed', 'true');
  // 等本周期初始页（before=null）返回
  await expect
    .poll(() => kpages.some((p) => p.period === period && !p.before), { timeout: 20_000 })
    .toBeTruthy();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(900);

  const union = () =>
    kpages
      .filter((p) => p.period === period)
      .flatMap((p) => p.bars.map((b) => b.ts))
      .sort();

  let earliest: string | null = null;
  let dragsUsed = 0;
  let cap1 = '';
  for (let d = 0; d < maxDrags; d++) {
    await dragOlder(page, box);
    dragsUsed++;
    await page.waitForTimeout(settleMs);
    const ts = union();
    if (ts.length) earliest = ts[0]!;
    const fwd = kpages.filter((p) => p.period === period && p.before);
    if (!cap1 && fwd.length >= 1) {
      await page.waitForTimeout(600);
      cap1 = await cap();
    }
    if (earliest && stopBefore && earliest < stopBefore) break;
    if (earliest && minForward > 0 && fwd.length >= minForward) break;
  }
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
  // 触底后再拖 tailDrags 程，把视口带到更老区（佐证 canvas 随数据推进）
  for (let i = 0; i < tailDrags; i++) {
    await dragOlder(page, box);
    await page.waitForTimeout(500);
  }
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
  let capTail = await cap();
  if (cap1 && capTail === cap1) {
    for (let i = 0; i < 3; i++) {
      await dragOlder(page, box);
      await page.waitForTimeout(400);
    }
    await page.mouse.move(1, 1);
    await page.waitForTimeout(500);
    capTail = await cap();
  }

  const ts = union();
  const dups = ts.length - new Set(ts).size;
  const initialPages = kpages
    .filter((p) => p.period === period && !p.before)
    .map((p) => ({ limit: p.limit, n: p.bars.length }));
  const forwardPages = kpages
    .filter((p) => p.period === period && p.before)
    .map((p) => ({ limit: p.limit, n: p.bars.length, before: p.before }));
  const allForwardFull = forwardPages.length > 0 && forwardPages.every((p) => p.n === p.limit);
  /**
   * forward 页**逐页判定**（数据域边界感知；重锚依据见文件头 §重锚）：
   *  ① 请求批量必须 == `BATCH[period]` —— 旧缺陷「每页只要 2 根」在请求侧即暴露；
   *  ② 满页（n == 批量）直接成立；
   *  ③ 短页必须**现场举证**为数据域末端（同一 `before` 游标抬高 limit 仍只回同数且 `next_before=null`）。
   * 旧口径「每页恒 80 根」在数据域总根数 < 初始视口 + 批量时**数学上不可满足**（见文件头 §重锚）。
   */
  const codeSel = await selectedSymbolCode(page);
  const forwardVerdicts: Array<{ limit: number; n: number; before: string | null; ok: boolean; why: string }> = [];
  for (const p of forwardPages) {
    let ok = true;
    let why = `满页：n == 批量 ${p.limit}`;
    if (p.limit !== BATCH[period]) {
      ok = false;
      why = `请求批量 ${p.limit} ≠ ${BATCH[period]}（分页批量失效）`;
    } else if (p.n !== p.limit) {
      const proof = p.before ? await shortPageBoundaryProof(codeSel, period, p.before, p.n, BATCH[period]) : null;
      ok = !!proof?.onlyPageN;
      why = !proof
        ? `短页 n=${p.n} < ${p.limit} 但无 before 游标 ⇒ 无法举证域末端`
        : proof.onlyPageN
          ? `短页 n=${p.n} < ${p.limit} 已举证为**数据域末端**（同游标 limit=${proof.probeLimit} 仍只回 ${proof.n} 且 next_before=null）`
          : `短页 n=${p.n} < ${p.limit} **未**举证为域末端：同游标 limit=${proof.probeLimit} 回 ${proof.n} 根（next_before=${String(
              proof.nextBefore,
            )}）⇒ 域内仍有更早数据却未取回（有损分页）`;
    }
    forwardVerdicts.push({ limit: p.limit, n: p.n, before: p.before, ok, why });
  }
  const allForwardBatch = forwardPages.length > 0 && forwardVerdicts.every((v) => v.ok);
  const badDeltas: number[] = [];
  let deltaMax = 0;
  for (let i = 1; i < ts.length; i++) {
    const dd = (Date.parse(ts[i]!) - Date.parse(ts[i - 1]!)) / 86400000;
    if (dd > deltaMax) deltaMax = dd;
    if (opts.deltaRule && !opts.deltaRule(dd)) badDeltas.push(dd);
  }
  const year2022_2023 = ts.some((t) => {
    const v = Date.parse(t);
    return v >= Date.parse('2022-01-01T00:00:00Z') && v < Date.parse('2024-01-01T00:00:00Z');
  });
  const colors = await candleColors(page);
  const capTag =
    period === '1w' ? '周线' : period === '1mo' ? '月线' : period === '1d' ? '日线' : '分钟1m';
  await shot(page, `deep_${period}_tail.png`, `${capTag}深翻 earliest=${earliest} · pages=${forwardPages.length} · drags=${dragsUsed}`);
  return {
    period,
    dragsUsed,
    reached: !!earliest && !!stopBefore ? earliest < stopBefore : forwardPages.length >= minForward,
    earliestTs: earliest,
    unionCount: ts.length,
    dups,
    initialPages,
    forwardPages,
    forwardVerdicts,
    allForwardFull,
    allForwardBatch,
    badDeltas,
    deltaMax,
    year2022_2023,
    colors,
    cap1,
    capTail,
  };
}

/* ─────────────────────── 全局状态快照 / MA 默认还原 ─────────────────────── */

async function getMa(): Promise<number[]> {
  const d = (await (await fetch(BASE + '/api/config/ma')).json()) as { windows: number[] };
  return d.windows;
}
async function putMa(windows: number[]): Promise<number> {
  const r = await fetch(BASE + '/api/config/ma', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ windows }),
  });
  return r.status;
}
const MA_DEFAULT = [5, 10, 20];

test.beforeEach(async () => {
  // 批 1a 只允许触碰 MA 配置；每个用例前确保默认 [5,10,20]（用例自身也会恢复默认）
  const ma = await getMa();
  if (JSON.stringify(ma) !== JSON.stringify(MA_DEFAULT)) {
    await putMa(MA_DEFAULT);
  }
});
test.afterAll(async () => {
  await putMa(MA_DEFAULT);
  const ma = await getMa();
  expect(ma, 'MA 配置已恢复默认 [5,10,20]').toEqual(MA_DEFAULT);
});

/* ───────────────────────────── 用例 ───────────────────────────── */

test('T1 周线：深翻至覆盖 2022-2023（<2024）+ 分页批量 limit=150/无空档/无重复', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = watchErrors(page);
  await gotoPage(page, '/');
  await waitChart(page);

  const out = await deepPan(page, '1w', {
    stopBefore: '2022-01-01T00:00:00Z',
    maxDrags: 40,
    deltaRule: weeklyDeltaOk,
  });
  // 初始视口 30（周），非 2
  expect(out.initialPages[0]?.limit, '周线初始视口 limit=120（ADR-020 默认根数）').toBe(INIT_PAGE['1w']);
  // 深翻翻页批量 150/页且满页（非「一次 2 根」）
  expect(out.forwardPages.length, '至少 1 个 forward 批页').toBeGreaterThanOrEqual(1);
  expect(out.allForwardBatch, `每个 forward 请求 limit=150（满页须恰 150 根；短页须举证为数据域末端）: ${JSON.stringify(out.forwardVerdicts)}`).toBeTruthy();
  expect(out.reached, `深翻可达 ${out.earliestTs}（earliest < 2022-01-01）`).toBeTruthy();
  expect(Date.parse(out.earliestTs!), 'earliest ts < 2024-01-01').toBeLessThan(Date.parse('2024-01-01T00:00:00Z'));
  expect(out.year2022_2023, 'union 含 2022/2023 蜡烛（<2024 目标区在档）').toBeTruthy();
  expect(out.dups, '跨页去重：无重复 ts').toBe(0);
  expect(out.unionCount, 'union 数量足够（30+150+…）').toBeGreaterThanOrEqual(150);
  expect(out.dragsUsed, '触底所需拖拽在预算内（批量生效）').toBeLessThan(40);
  expect(out.capTail, 'canvas 视口已随深翻推进（像素佐证）').not.toBe(out.cap1);
  expect(out.badDeltas, `周线连续性：delta∈{7,14,…,≤21 天}，违规=${JSON.stringify(out.badDeltas)}`).toEqual([]);
  assertNoErrors(errs, 'T1 周线深翻全程');
  saveJson('T1_weekly.json', out);
});

test('T2 月线：深翻至覆盖 2022-2023（<2024）+ 分页批量 limit=80/无空档/无重复', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = watchErrors(page);
  await gotoPage(page, '/');
  await waitChart(page);

  const out = await deepPan(page, '1mo', {
    stopBefore: '2022-01-01T00:00:00Z',
    maxDrags: 40,
    deltaRule: monthlyDeltaOk,
  });
  expect(out.initialPages[0]?.limit, '月线初始视口 limit=120（ADR-020 默认根数）').toBe(INIT_PAGE['1mo']);
  expect(out.forwardPages.length, '至少 1 个 forward 批页').toBeGreaterThanOrEqual(1);
  expect(out.allForwardBatch, `每个 forward 请求 limit=80（满页须恰 80 根；短页须举证为数据域末端）: ${JSON.stringify(out.forwardVerdicts)}`).toBeTruthy();
  expect(out.reached, `深翻可达 ${out.earliestTs}（earliest < 2022-01-01）`).toBeTruthy();
  expect(Date.parse(out.earliestTs!), 'earliest ts < 2024-01-01').toBeLessThan(Date.parse('2024-01-01T00:00:00Z'));
  expect(out.year2022_2023, 'union 含 2022/2023 蜡烛（<2024 目标区在档）').toBeTruthy();
  expect(out.dups, '跨页去重：无重复 ts').toBe(0);
  expect(out.unionCount, 'union 数量足够（24+80+…）').toBeGreaterThanOrEqual(100);
  expect(out.dragsUsed, '触底所需拖拽在预算内').toBeLessThan(40);
  expect(out.capTail, 'canvas 视口已随深翻推进（像素佐证）').not.toBe(out.cap1);
  expect(out.badDeltas, `月线连续性：delta∈自然月跨度[26,36] 天，违规=${JSON.stringify(out.badDeltas)}`).toEqual([]);
  assertNoErrors(errs, 'T2 月线深翻全程');
  saveJson('T2_monthly.json', out);
});

test('T3 日线：连续左翻 ≥2 批页 + 分页批量 limit=250/无缺口/无重复', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = watchErrors(page);
  await gotoPage(page, '/');
  await waitChart(page);

  const out = await deepPan(page, '1d', {
    minForward: 2,
    maxDrags: 45,
    settleMs: 380,
    deltaRule: dailyDeltaOk,
  });
  // 初始视口=2 根（定稿 1d 设计），深翻翻页批量 250/页且满页
  expect(out.initialPages[0]?.limit, '日线初始视口 limit=120（ADR-020 默认根数；旧 2 交易日已废除）').toBe(INIT_PAGE['1d']);
  expect(out.forwardPages.length, '日线至少 2 个 forward 批页').toBeGreaterThanOrEqual(2);
  expect(out.allForwardBatch, `每个 forward 请求 limit=250（满页须恰 250 根；短页须举证为数据域末端）: ${JSON.stringify(out.forwardVerdicts)}`).toBeTruthy();
  expect(out.dups, '跨页去重：无重复 ts').toBe(0);
  expect(out.unionCount, '批量拉取量足够（>500 根日线）').toBeGreaterThanOrEqual(500);
  expect(Date.parse(out.earliestTs!), '深翻覆盖早于 2025（earliest=' + out.earliestTs + '）').toBeLessThan(Date.parse('2025-01-01T00:00:00Z'));
  expect(out.dragsUsed, '批量生效下拖拽预算充足').toBeLessThan(45);
  expect(out.capTail, 'canvas 视口已随深翻推进（像素佐证）').not.toBe(out.cap1);
  expect(out.badDeltas, `日线连续（周末/长假合法缺口 ≤11 天），违规=${JSON.stringify(out.badDeltas)}`).toEqual([]);
  assertNoErrors(errs, 'T3 日线深翻全程');
  saveJson('T3_daily.json', out);
});

test('T4 分钟 1m：分页批量 limit=500（非 2）/无重复/深翻推进', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = watchErrors(page);
  await gotoPage(page, '/');
  await waitChart(page);

  const out = await deepPan(page, '1m', { minForward: 2, maxDrags: 30, settleMs: 320, tailDrags: 3 });
  // 初始视口=482（2 交易日分钟数），forward 批量=500 且满页
  expect(out.initialPages[0]?.limit, '1m 初始视口 limit=120（ADR-020 默认根数；旧 482 已废除）').toBe(INIT_PAGE['1m']);
  expect(out.forwardPages.length, '1m 至少 2 个 forward 批页').toBeGreaterThanOrEqual(2);
  expect(out.allForwardBatch, `每个 forward 请求 limit=500（满页须恰 500 根；短页须举证为数据域末端）: ${JSON.stringify(out.forwardVerdicts)}`).toBeTruthy();
  expect(out.dups, '跨页去重：无重复 ts').toBe(0);
  expect(out.capTail, '1m canvas 视口已随深翻推进（像素佐证）').not.toBe(out.cap1);
  expect(out.dragsUsed, '深翻预算内').toBeLessThan(30);
  assertNoErrors(errs, 'T4 1m 深翻全程');
  saveJson('T4_min1.json', out);
});

test('T5 MA 配置：[3,7,21] 主图+宫格生效/切周期保持/reload 持久/非法零 PUT/恢复默认', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = watchErrors(page);
  const putReqs: Array<{ status: number; body: string }> = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/config/ma') && r.method() === 'PUT') {
      putReqs.push({ status: 0, body: r.postData() ?? '' });
    }
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/config/ma') && r.request().method() === 'PUT') {
      const latest = putReqs.find((p) => p.status === 0);
      if (latest) latest.status = r.status();
    }
  });
  const putOkCount = () => putReqs.filter((p) => p.status !== 0).length;
  const openEditor = async () => {
    await maBtn(page).click();
    await expect(page.locator('[data-ma-editor]')).toBeVisible();
  };
  const closeEditor = async () => {
    await page.locator('[data-ma-editor]').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('[data-ma-editor]')).toHaveCount(0);
  };
  const fillWin = async (wins: Array<number | string>) => {
    for (let i = 0; i < 3; i++) {
      await page.locator(`input[data-ma-input="${i}"]`).fill(String(wins[i] ?? ''));
    }
  };
  const saveEditor = async () => {
    await page.locator('[data-ma-editor]').getByRole('button', { name: '保存', exact: true }).click();
  };

  await gotoPage(page, '/');
  await waitChart(page);
  expect(await getMa(), '初始 MA=[5,10,20]').toEqual([5, 10, 20]);
  await expect(maBtn(page)).toContainText('MA(5,10,20)');
  // 主图 MA(5,10,20) 基线（单图 15m 默认）
  const hashMain520 = await stableHash(() => chartHashAll(page));
  await shot(page, 'ma_0_main520.png', '基线：单图 MA(5,10,20)');

  // 宫格基线 → 宫格内保存 [3,7,21] → 宫格 MA 热更新 + PUT 200
  await bt(page, '2×2').click();
  await waitGrid(page, 4);
  const hashGrid520 = await stableHash(() => gridHash(page));
  await openEditor();
  await fillWin([3, 7, 21]);
  const putDone = page.waitForResponse(
    (r) => r.url().includes('/api/config/ma') && r.request().method() === 'PUT',
    { timeout: 10_000 },
  );
  await saveEditor();
  const putRes = await putDone;
  expect(putRes.status(), 'PUT /api/config/ma 200').toBe(200);
  expect(JSON.parse(putRes.request().postData() ?? '{}').windows, 'PUT body windows=[3,7,21]').toEqual([3, 7, 21]);
  await expect(maBtn(page)).toContainText('MA(3,7,21)', { timeout: 10_000 });
  await expect.poll(() => putOkCount(), { timeout: 10_000 }).toBe(1);
  const hashGrid321 = await stableHash(() => gridHash(page));
  expect(hashGrid321, '宫格缩略 K线 MA 随 [3,7,21] 重绘（指纹变化）').not.toBe(hashGrid520);
  await shot(page, 'ma_1_grid321.png', '2×2 宫格保存 [3,7,21]：PUT 200 + 宫格 MA 指纹变化');

  // 回单图：主图 MA 生效
  await bt(page, '单图').click();
  await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible({ timeout: 20_000 });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1500);
  const hashMain321 = await stableHash(() => chartHashAll(page));
  expect(hashMain321, '主图 MA 随 [3,7,21] 重绘').not.toBe(hashMain520);
  await shot(page, 'ma_2_main321.png', '单图 MA(3,7,21)（vs MA(5,10,20) 指纹变化）');

  // 切周期(日/周/月)后 MA 窗口仍 [3,7,21]
  for (const [p, name] of [
    ['1d', '日'],
    ['1w', '周'],
    ['1mo', '月'],
  ] as const) {
    await bt(page, name).click();
    await expect(bt(page, name)).toHaveAttribute('aria-pressed', 'true');
    await expect(maBtn(page)).toContainText('MA(3,7,21)');
    await page.waitForTimeout(1200);
  }
  await shot(page, 'ma_3_after_period_switch.png', '切日/周/月后 Toolbar 仍 MA(3,7,21)');

  // reload 持久：GET config=[3,7,21] + 主图 MA 指纹变化（vs MA520 基线）
  await page.reload();
  await waitChart(page);
  await expect(maBtn(page)).toContainText('MA(3,7,21)');
  expect(await getMa(), 'reload 后 GET /api/config/ma=[3,7,21]').toEqual([3, 7, 21]);
  const hashMainReload = await stableHash(() => chartHashAll(page));
  expect(hashMainReload, 'reload 后主图仍以 [3,7,21] 绘制（vs MA(5,10,20) 基线）').not.toBe(hashMain520);
  await shot(page, 'ma_4_reload_persist.png', 'reload 后 MA(3,7,21) 持久（GET config + 主图指纹）');

  // 非法输入：0/空/非整 → 前端提示 + 零 PUT + 配置不变
  const putBeforeInvalid = putOkCount();
  for (const bad of [
    ['0', '0', '0'],
    ['', '', ''],
    ['3.5', '7.5', '2.5'],
    ['abc', 'x', ''],
  ] as const) {
    await openEditor();
    await fillWin(bad as unknown as string[]);
    await saveEditor();
    await expect(page.locator('[data-ma-editor]')).toBeVisible();
    await expect(page.locator('[data-ma-editor]')).toContainText('请输入 1-3 条 1-500 的整数窗口');
    expect(putOkCount(), `非法输入 ${bad.join('/')} 期间零 PUT`).toBe(putBeforeInvalid);
    expect(await getMa(), '非法输入后配置不变 [3,7,21]').toEqual([3, 7, 21]);
    await closeEditor();
  }
  await expect(maBtn(page)).toContainText('MA(3,7,21)');
  await shot(page, 'ma_5_invalid.png', '非法 MA 输入：前端提示、编辑器不关、零 PUT、配置不变');

  // 恢复默认 [5,10,20]
  await openEditor();
  await fillWin([5, 10, 20]);
  const putRestore = page.waitForResponse(
    (r) => r.url().includes('/api/config/ma') && r.request().method() === 'PUT',
    { timeout: 10_000 },
  );
  await saveEditor();
  const resRestore = await putRestore;
  expect(resRestore.status(), '恢复 PUT 200').toBe(200);
  expect(JSON.parse(resRestore.request().postData() ?? '{}').windows, '恢复 PUT body [5,10,20]').toEqual([5, 10, 20]);
  await expect(maBtn(page)).toContainText('MA(5,10,20)', { timeout: 10_000 });
  await expect.poll(async () => getMa(), { timeout: 10_000 }).toEqual([5, 10, 20]);
  await shot(page, 'ma_6_restored_default.png', '恢复默认 MA(5,10,20)');

  assertNoErrors(errs, 'T5 MA 配置全程');
  saveJson('T5_ma.json', {
    putBodies: putReqs.map((p) => ({ status: p.status, body: p.body })),
    gridDiff: hashGrid321 !== hashGrid520,
    mainDiff: hashMain321 !== hashMain520,
    reloadDiff: hashMainReload !== hashMain520,
  });
});
