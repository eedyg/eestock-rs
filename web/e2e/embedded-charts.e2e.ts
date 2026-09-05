import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gotoPage } from './helpers/pages';
import { psql } from './helpers/db';

/**
 * 内嵌图表深度细化验收（宫格内嵌 K线缩略图 + 单图内嵌组件）—— 只测不改。
 *
 * 覆盖（对应任务 ①-⑥）：
 *  T1 宫格 2×2：每格 code 顺序=前4、格内 K线(REST 15m limit=120) 与 DB 权威重算逐 bar 对账、多格不串
 *  T2 宫格 2×3：6 格 code=前6、每格 K线 DB 对账（同 T1 算法全量）
 *  T3 环形图/窄格布局与溢出（canvas 有界 / 行高分布度量 / 页面溢出 / 反复切换不失控）
 *  R1 宫格行高均分（2×2/2×3 行等高 ratio<1.3、无 0 高 canvas、页面不纵向溢出）强断言
 *  T4 生命周期：单图→2×2→2×3→单图 ×3：canvas 归位、WS bar 订阅无净残留、无崩溃
 *  T5 grid 模式切周期 15m→1m：各格重初始化 + network period=1m&limit=120
 *  T6 宫格表头 D2 一致性（route 拦截 /api/symbols：前4含 disabled+latest:null / enabled+latest:null）
 *  R2 格表头 D2 一致性（停用→已停用、启用无数据→无数据，不伪造 0.00%）强断言
 *  T7 单图内嵌组件回归（网格交互后）：主图+volume+MA/MACD/KDJ/BOLL；分时今日线/均价线+WS 注入推进 + 1m 当日 DB 对账
 *  T8 WS 隔离：单图实时→格内无实时 bar 视觉追加→格表头 quote 注入更新→回单图实时恢复
 *
 * 已知环境条件（非断言目标，如实记录）：
 *  - EV-1：eestock-timescaledb /dev/shm=64MB → 并发 1m 深查可能间歇 500（"No space left on device"），
 *    属基础设施非前端缺陷；T5 内置 1 次自然重试并计数取证；T1/T2 只取 200 响应对账并记录 500。
 *  - EV-2：整站壳层 min-w-[1280px]+nav 使 docScrollW=1488（>1280，所有页一致，report 015 截图同宽），
 *    非宫格引入；T3 用「相对单图基线不超量」判定宫格自身溢出。
 *
 * R1/R2 修复强断言：修复前应 RED（2×2 ratio≈3.47、2×3 末行 0 高、格表头 +0.00%）；
 * 修复后 GREEN。验收结论见 web/tester/test/013_embedded_charts_deployed.md。
 */

const EVID = '/tmp/embedded_evidence';
mkdirSync(EVID, { recursive: true });

// ── 基建：WS 注入 + 出站帧采集 ─────────────────────────────────────────────
const WS_HARNESS = `
(() => {
  const Real = window.WebSocket;
  window.__sock = null;
  window.__sent = [];
  window.__push = (o) => { try { if (window.__sock && window.__sock.readyState === 1) window.__sock.onmessage({ data: JSON.stringify(o) }); } catch (e) {} };
  window.WebSocket = class extends Real {
    constructor(...a) { super(...a); window.__sock = this; }
    send(d) { try { window.__sent.push(String(d)); } catch (e) {} return super.send(d); }
  };
})();
`;

function bt(page: Page, name: string) {
  return page.locator('[data-region="toolbar"]').getByRole('button', { name, exact: true });
}

/** 错误三分类：crash=pageerror（致命）；api=资源 500/4xx（EV-1 类，取证不致命）；other=其他 console error（致命） */
function watchErrors(page: Page) {
  const errs: { crash: string[]; api: string[]; other: string[] } = { crash: [], api: [], other: [] };
  page.on('pageerror', (e) => errs.crash.push('PAGEERR:' + String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text().slice(0, 300);
    (t.includes('Failed to load resource') ? errs.api : errs.other).push(t);
  });
  return errs;
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${EVID}/${name}.png` });
}

async function waitSock(page: Page) {
  await page.waitForFunction(() => !!(window as any).__sock, undefined, { timeout: 20_000 });
  await page.waitForFunction(() => (window as any).__sock?.readyState === 1, undefined, { timeout: 20_000 });
}

async function push(page: Page, obj: unknown) {
  await page.evaluate((o) => (window as any).__push(o), obj);
}

/** 符号列表当前可见顺序（= state.symbols 顺序，无搜索时） */
async function symbolOrder(page: Page, n: number): Promise<string[]> {
  const rows = await page.locator('[data-region="symbol-list"] button').allInnerTexts();
  return rows.slice(0, n).map((t) => t.split('\n')[0]!.trim());
}

// ── K线 network 采集（url + 响应体 + 状态）────────────────────────────────
interface KlineHit {
  url: string;
  status: number;
  bars: Array<Record<string, unknown>>;
}
function watchKlineResponses(page: Page) {
  const hits: KlineHit[] = [];
  page.on('response', async (r) => {
    const u = decodeURIComponent(r.url());
    if (!u.includes('/api/kline')) return;
    let bars: Array<Record<string, unknown>> = [];
    try {
      const j = (await r.json()) as { bars?: Array<Record<string, unknown>> };
      bars = j.bars ?? [];
    } catch {
      /* ignore body parse */
    }
    hits.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), status: r.status(), bars });
  });
  return hits;
}
function hitKey(u: string): { code: string; period: string; limit: number; before: boolean } {
  const p = new URL('http://x' + u).searchParams;
  return {
    code: p.get('code') ?? '',
    period: p.get('period') ?? '',
    limit: Number(p.get('limit') ?? 0),
    before: p.has('before'),
  };
}

// ── DB 权威重算（与 app 读源同公式：kline_accurate M1 → 15m 桶 first/max/min/last/sum）──
function normTs(t: string): string {
  return t.replace(' ', 'T').replace('+00', 'Z');
}
type Row = [string, number, number, number, number, number, number];
function db15m(code: string, limit = 120): Row[] {
  const sql = `SELECT ts, open, high, low, close, volume::bigint, amount FROM (
    SELECT time_bucket('15 minutes', ts) AS ts, first(open, ts) AS open, max(high) AS high,
           min(low) AS low, last(close, ts) AS close, sum(volume) AS volume, sum(amount) AS amount
    FROM kline_accurate
    WHERE code='${code}' AND period='M1' AND ts >= '2024-01-01 00:00:00+00'
    GROUP BY time_bucket('15 minutes', ts) ORDER BY ts DESC LIMIT ${limit}
  ) x ORDER BY ts ASC;`;
  return psql(sql)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ts, open, high, low, close, volume, amount] = line.split('|');
      return [normTs(ts!), Number(open), Number(high), Number(low), Number(close), Number(volume), Number(amount)];
    });
}
/** DB M1 某一 CST 交易日的 1m bars（与 app 1m 读源 kline_merged 的 accurate 分支同源） */
function db1mDay(code: string, dayStartZ: string, dayEndZ: string): Row[] {
  const sql = `SELECT ts, open, high, low, close, volume::bigint, amount FROM kline_accurate
    WHERE code='${code}' AND period='M1' AND ts >= '${dayStartZ}' AND ts < '${dayEndZ}' ORDER BY ts ASC;`;
  return psql(sql)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ts, open, high, low, close, volume, amount] = line.split('|');
      return [normTs(ts!), Number(open), Number(high), Number(low), Number(close), Number(volume), Number(amount)];
    });
}
function restToRows(bars: Array<Record<string, unknown>>): Row[] {
  return bars.map((b) => [
    String(b.ts), Number(b.open), Number(b.high), Number(b.low), Number(b.close), Number(b.volume), Number(b.amount),
  ]);
}
function compareRows(rest: Row[], db: Row[]) {
  const mism: string[] = [];
  if (rest.length !== db.length) mism.push(`count rest=${rest.length} db=${db.length}`);
  const n = Math.min(rest.length, db.length);
  for (let i = 0; i < n; i++) {
    const a = rest[i]!;
    const b = db[i]!;
    if (a[0] !== b[0]) { mism.push(`row${i} ts rest=${a[0]} db=${b[0]}`); break; }
    const fields = ['open', 'high', 'low', 'close', 'volume', 'amount'];
    for (let f = 1; f <= 6; f++) {
      const tol = f === 5 ? 0 : 1e-6;
      if (Math.abs(a[f]! - b[f]!) > tol) { mism.push(`row${i} ${fields[f - 1]} rest=${a[f]} db=${b[f]}`); break; }
    }
  }
  const asc = rest.every((r, i) => i === 0 || rest[i - 1]![0]! < r[0]!);
  return {
    restCount: rest.length, dbCount: db.length,
    firstTs: rest[0]?.[0] ?? null, lastTs: rest.at(-1)?.[0] ?? null,
    asc, mismatches: mism.slice(0, 8), mismatchCount: mism.length,
  };
}

/** 网格几何/画布快照（code 取格内 <b> 首元素，避免 textContent 无换行歧义） */
function gridSnapshot(page: Page) {
  return page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('[data-grid-cell]'));
    const out = cells.map((c) => {
      const r = c.getBoundingClientRect();
      const cs = Array.from(c.querySelectorAll('canvas'));
      const main = cs.find((x) => x.width > 300 && x.height > 40) ?? null;
      return {
        code: (c.querySelector('b')?.textContent ?? '').trim(),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        canvasCount: cs.length,
        canvases: cs.map((x) => `${x.width}x${x.height}`),
        main: main ? `${main.width}x${main.height}` : null,
        mainH: main ? main.height : 0,
        mainW: main ? main.width : 0,
      };
    });
    const gv = document.querySelector('[data-region="grid-view"]');
    const gr = gv?.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      cells: out,
      grid: gr ? { x: Math.round(gr.x), y: Math.round(gr.y), w: Math.round(gr.width), h: Math.round(gr.height) } : null,
      scroll: { W: doc.scrollWidth, H: doc.scrollHeight, winW: window.innerWidth, winH: window.innerHeight },
    };
  });
}

/** 格内主画布点亮像素数（数据渲染存在性；稠密采样） */
function litPixels(page: Page) {
  return page.evaluate(() => {
    const out: Array<{ code: string; lit: number; main: string | null }> = [];
    for (const c of document.querySelectorAll('[data-grid-cell]')) {
      const main = Array.from(c.querySelectorAll('canvas')).find((x) => x.width > 300 && x.height > 20);
      let lit = 0;
      if (main) {
        try {
          const img = (main as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, main.width, main.height).data;
          for (let i = 0; i < img.length; i += 200) {
            if (img[i]! > 80 || img[i + 1]! > 80 || img[i + 2]! > 80) lit++;
          }
        } catch {
          /* cross-origin taint 兜底 */
        }
      }
      out.push({ code: (c.querySelector('b')?.textContent ?? '').trim(), lit, main: main ? `${main.width}x${main.height}` : null });
    }
    return out;
  });
}

async function enterGrid(page: Page, mode: '2×2' | '2×3', waitMs = 4500) {
  await bt(page, mode).click();
  await expect(bt(page, mode)).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(waitMs);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(WS_HARNESS);
});

// ═════════════════════════ ① 宫格每格数据正确性 ═════════════════════════
test('T1 宫格 2×2：每格 code=前4（顺序一致）+ 格内 K线(15m×120) 与 DB 权威逐 bar 一致 + 多格不串', async ({ page }) => {
  test.setTimeout(180_000);
  const errs = watchErrors(page);
  const hits = watchKlineResponses(page);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-region="symbol-list"] button', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const expected = await symbolOrder(page, 4);
  expect(expected.length).toBe(4);
  await enterGrid(page, '2×2', 4500);

  const cellCodes = (await gridSnapshot(page)).cells.map((c) => c.code);
  expect(cellCodes, '格序=前4').toEqual(expected);

  const okHits = hits.filter((h) => {
    const k = hitKey(h.url);
    return k.period === '15m' && k.limit === 120 && !k.before;
  });
  const cellsHits = okHits.filter((h) => h.status === 200);
  const hitCodes = [...new Set(cellsHits.map((h) => hitKey(h.url).code))];
  const fiveHundreds = okHits.filter((h) => h.status >= 500).map((h) => h.url);
  for (const code of expected) {
    expect(hitCodes, `格 code=${code} 应有 200 的 15m limit=120 响应`).toContain(code);
  }

  const reports: Record<string, unknown> = {};
  for (const code of expected) {
    const db = db15m(code, 120);
    const rest = restToRows(cellsHits.find((h) => hitKey(h.url).code === code)!.bars);
    const cmp = compareRows(rest, db);
    reports[code] = cmp;
    expect(cmp.mismatchCount, `code=${code} 与 DB 权威重算逐 bar 差异数`).toBe(0);
    expect(cmp.restCount, `code=${code} bar 数=120`).toBe(120);
    expect(cmp.dbCount, `code=${code} DB bar 数=120`).toBe(120);
    expect(cmp.asc, `code=${code} 升序`).toBe(true);
  }
  for (let i = 0; i < expected.length; i++) {
    for (let j = i + 1; j < expected.length; j++) {
      const a = cellsHits.find((h) => hitKey(h.url).code === expected[i])!.bars[0] as Record<string, unknown>;
      const b = cellsHits.find((h) => hitKey(h.url).code === expected[j])!.bars[0] as Record<string, unknown>;
      const same = String(a.ts) === String(b.ts) && Number(a.close) === Number(b.close);
      expect(same, `格${expected[i]} 与 格${expected[j]} 数据不得串`).toBe(false);
    }
  }
  writeFileSync(
    `${EVID}/t1_grid2x2_db_reconcile.json`,
    JSON.stringify({ expected, fiveHundreds, reports }, null, 1),
  );
  await shot(page, 'T1_grid2x2_db_reconcile');
  expect(errs.crash).toEqual([]);
  expect(errs.other).toEqual([]);
});

test('T2 宫格 2×3：6 格 code=前6 + 每格 K线(15m×120) DB 对账', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = watchErrors(page);
  const hits = watchKlineResponses(page);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-region="symbol-list"] button', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const expected = await symbolOrder(page, 6);
  expect(expected.length).toBe(6);
  await enterGrid(page, '2×3', 5000);

  const cellCodes = (await gridSnapshot(page)).cells.map((c) => c.code);
  expect(cellCodes.length).toBe(6);
  expect(cellCodes, '格序=前6').toEqual(expected);

  const okHits = hits.filter((h) => {
    const k = hitKey(h.url);
    return k.period === '15m' && k.limit === 120 && !k.before;
  });
  const cellsHits = okHits.filter((h) => h.status === 200);
  const fiveHundreds = okHits.filter((h) => h.status >= 500).map((h) => h.url);
  const reports: Record<string, unknown> = {};
  for (const code of expected) {
    const hit = cellsHits.find((h) => hitKey(h.url).code === code);
    expect(hit, `code=${code} 应有 200 响应`).toBeTruthy();
    const db = db15m(code, 120);
    const cmp = compareRows(restToRows(hit!.bars), db);
    reports[code] = cmp;
    expect(cmp.mismatchCount, `code=${code}`).toBe(0);
    expect(cmp.asc, `code=${code} 升序`).toBe(true);
  }
  const lit = await litPixels(page);
  for (const l of lit) expect(l.lit, `code=${l.code} 应有绘制内容`).toBeGreaterThan(8);
  writeFileSync(`${EVID}/t2_grid2x3_reconcile.json`, JSON.stringify({ expected, fiveHundreds, reports, lit }, null, 1));
  await shot(page, 'T2_grid2x3_data');
  expect(errs.crash).toEqual([]);
  expect(errs.other).toEqual([]);
});

// ═════════════════════════ ② 环形图/窄格布局与溢出 ═════════════════════════
test('T3 宫格布局与溢出：canvas 有界、页面无超出单图基线、反复切换不失控', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = watchErrors(page);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-testid="kline-chart"] canvas', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  const singleBase = await page.evaluate(() => document.documentElement.scrollWidth);

  for (const mode of ['2×2', '2×3'] as const) {
    await bt(page, mode).click();
    await page.waitForTimeout(4800);
    const snap = await gridSnapshot(page);
    expect(snap.cells.length, `${mode} 格数`).toBe(mode === '2×2' ? 4 : 6);
    for (const c of snap.cells) {
      expect(c.canvasCount, `${c.code} 每格 6 canvas（klinecharts 结构）`).toBe(6);
      for (const cv of c.canvases!) {
        const [, h] = cv.split('x').map(Number);
        expect(h!, `${c.code} canvas 高有界（无 33M 级爆炸）`).toBeLessThan(2000);
      }
      expect(c.w!, `${c.code} 格宽≤网格容器`).toBeLessThanOrEqual(snap.grid!.w);
    }
    expect(snap.scroll!.W, `${mode} doc scrollWidth ≤ 单图基线（无宫格额外横向溢出）`).toBeLessThanOrEqual(singleBase + 1);
    await shot(page, `T3_bounds_${mode}`);
  }
  await bt(page, '单图').click();
  await page.waitForTimeout(2000);
  for (let i = 0; i < 3; i++) {
    await bt(page, '2×2').click();
    await page.waitForTimeout(2500);
    await bt(page, '单图').click();
    await page.waitForTimeout(2500);
  }
  const after = await page.evaluate(() => ({
    canvasCount: document.querySelectorAll('canvas').length,
    cells: document.querySelectorAll('[data-grid-cell]').length,
    scrollH: document.documentElement.scrollHeight,
  }));
  expect(after.canvasCount, '回单图 canvas 归位=10（无实例累积）').toBe(10);
  expect(after.cells).toBe(0);
  expect(after.scrollH).toBeLessThan(2000);
  await shot(page, 'T3_after_cycles_single');
  expect(errs.crash).toEqual([]);
  expect(errs.other).toEqual([]);
});

/** 行分组工具：按 y 聚类（行距>30 视为新行），返回每行最高格高 */
function rowHeightsOf(cells: Array<{ y: number; h: number }>): number[] {
  const ys = [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b);
  const rows: number[] = [];
  for (const y of ys) {
    if (rows.length === 0 || y - ys[rows.length - 1]! > 30) {
      const hs = cells.filter((c) => Math.abs(c.y - y) < 30).map((c) => c.h);
      rows.push(Math.max(...hs));
    }
  }
  return rows.length ? rows : cells.map((c) => c.h);
}

test('R1 宫格行高均分（2×2 两行 ratio<1.3 / 2×3 三行 ratio<1.3 / 无 0 高 canvas / 页面不纵向溢出）', async ({ page }) => {
  test.setTimeout(180_000);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-region="symbol-list"] button', { timeout: 30_000 });
  await page.waitForTimeout(1500);

  await enterGrid(page, '2×2', 4500);
  const g22 = await gridSnapshot(page);
  const rows22 = rowHeightsOf(g22.cells);
  const ratio22 = rows22.length > 1 ? Math.max(...rows22) / Math.min(...rows22) : 1;
  const zero22 = g22.cells.filter((c) => c.mainH === 0 || c.h <= 60);

  await bt(page, '2×3').click(); // E11 顺序（2×2 直接进 2×3，首4格 DOM 保留）
  await page.waitForTimeout(4500);
  const g23 = await gridSnapshot(page);
  const rows23 = rowHeightsOf(g23.cells);
  const ratio23 = rows23.length > 1 ? Math.max(...rows23) / Math.min(...rows23) : 1;
  const bottomZero = g23.cells.filter((c) => c.mainH === 0 || c.h <= 60);
  const docOverflow = g23.scroll!.H > g23.scroll!.winH + 60; // 余量：nav/壳层高度

  writeFileSync(
    `${EVID}/r1_grid_row_geometry.json`,
    JSON.stringify({
      rows22, ratio22, zero22: zero22.map((c) => c.code),
      rows23, ratio23, bottomZeroCells: bottomZero.map((c) => c.code), docOverflow,
      g22: g22.cells.map((c) => ({ code: c.code, h: c.h, main: c.main })),
      g23: g23.cells.map((c) => ({ code: c.code, h: c.h, main: c.main, y: c.y })),
      grid23: g23.grid, scroll: g23.scroll,
    }, null, 1),
  );
  await shot(page, 'R1_grid_2x2_even');
  await shot(page, 'R1_grid_2x3_even');

  // R1 强断言：行高等分（ratio<1.3）、无 0 高 canvas、页面不纵向溢出
  expect(ratio22, '(R1) 2×2 两行等高 ratio<1.3').toBeLessThan(1.3);
  expect(zero22, '(R1) 2×2 无 0 高 canvas/矮格').toEqual([]);
  expect(ratio23, '(R1) 2×3 三行等高 ratio<1.3').toBeLessThan(1.3);
  expect(bottomZero, '(R1) 2×3 末行不坍缩（无 0 高 canvas）').toEqual([]);
  expect(docOverflow, '(R1) 页面不纵向溢出').toBe(false);
});

// ═════════════════════════ ③ 生命周期 / 泄漏 ═════════════════════════
test('T4 生命周期：单图→2×2→2×3→单图 ×3 循环：canvas 归位、WS bar 订阅无净残留、无崩溃', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = watchErrors(page);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-testid="kline-chart"] canvas', { timeout: 30_000 });
  await waitSock(page);
  await page.waitForTimeout(2000);

  const barBalance = async () =>
    page.evaluate(() => {
      const balance = new Map<string, number>();
      for (const raw of (window as any).__sent as string[]) {
        let f: Record<string, string>;
        try { f = JSON.parse(raw); } catch { continue; }
        if (f.type !== 'subscribe' && f.type !== 'unsubscribe') continue;
        if (f.topic !== 'bar') continue;
        const key = `bar:${f.code ?? ''}:${f.period ?? ''}`;
        balance.set(key, (balance.get(key) ?? 0) + (f.type === 'subscribe' ? 1 : -1));
      }
      return [...balance.entries()];
    });

  const cycles: Record<string, unknown>[] = [];
  for (let i = 0; i < 3; i++) {
    await bt(page, '2×2').click();
    await page.waitForTimeout(3200);
    const g = await page.evaluate(() => document.querySelectorAll('[data-grid-cell] canvas').length);
    await bt(page, '2×3').click();
    await page.waitForTimeout(3600);
    const g6 = await page.evaluate(() => document.querySelectorAll('[data-grid-cell] canvas').length);
    await bt(page, '单图').click();
    await page.waitForTimeout(2600);
    const single = await page.evaluate(() => ({
      cvs: document.querySelectorAll('canvas').length,
      cells: document.querySelectorAll('[data-grid-cell]').length,
    }));
    cycles.push({ i, grid2x2Canvases: g, grid2x3Canvases: g6, single });
    expect(g, `cycle${i} 2×2 canvas=24`).toBe(24);
    expect(g6, `cycle${i} 2×3 canvas=36`).toBe(36);
    expect(single.cvs, `cycle${i} 回单图 canvas=10（无实例残留）`).toBe(10);
    expect(single.cells).toBe(0);
  }
  const balance = await barBalance();
  const net = balance.filter(([, n]) => (n as number) > 0);
  writeFileSync(`${EVID}/t4_cycles.json`, JSON.stringify({ cycles, balance, net }, null, 1));
  console.log('T4 bar-topic balance:', JSON.stringify(balance));
  expect(net.length, '回单图后残留活跃 bar 订阅≤1（仅单图 feed；格内 feed 应随 dispose 释放）').toBeLessThanOrEqual(1);
  const heap = await page.evaluate(() =>
    (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1);
  expect(heap).toBeGreaterThan(0);
  expect(heap).toBeLessThan(500 * 1024 * 1024);
  await shot(page, 'T4_after_3_cycles');
  expect(errs.crash).toEqual([]);
  expect(errs.other).toEqual([]);
});

// ═════════════════════════ ③ 切周期在 grid 模式 ═════════════════════════
test('T5 grid 模式切周期 15m→1m：各格重初始化（network period=1m&limit=120 + 画布重绘）', async ({ page }) => {
  test.setTimeout(180_000);
  const errs = watchErrors(page);
  const hits = watchKlineResponses(page);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-region="symbol-list"] button', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await enterGrid(page, '2×3', 5000);
  const codes = (await gridSnapshot(page)).cells.map((c) => c.code);
  expect(codes.length).toBe(6);

  await bt(page, '1m').click();
  await expect(bt(page, '1m')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(4500);

  let oneMHits = hits.filter((h) => {
    const k = hitKey(h.url);
    return k.period === '1m' && k.limit === 120 && !k.before;
  });
  const had500 = hits.some((h) => h.status >= 500);
  // EV-1（DB shm 间歇 500）自然重试一次后复核
  if (new Set(oneMHits.map((h) => hitKey(h.url).code)).size < 6 || had500) {
    await bt(page, '15m').click();
    await page.waitForTimeout(3000);
    await bt(page, '1m').click();
    await page.waitForTimeout(4500);
    oneMHits = hits.filter((h) => {
      const k = hitKey(h.url);
      return k.period === '1m' && k.limit === 120 && !k.before;
    });
  }
  const oneMCodes = [...new Set(oneMHits.map((h) => hitKey(h.url).code))];
  for (const code of codes) {
    expect(oneMCodes, `code=${code} 应有 period=1m&limit=120 请求`).toContain(code);
  }
  const lit = await litPixels(page);
  for (const l of lit) expect(l.lit, `code=${l.code} 1m 格应有绘制`).toBeGreaterThan(2);
  const allFiveHundreds = hits.filter((h) => h.status >= 500).map((h) => h.url);
  writeFileSync(
    `${EVID}/t5_period_switch_1m.json`,
    JSON.stringify({ oneMCodes, oneMUrls: oneMHits.map((h) => h.url), fiveHundreds: allFiveHundreds, lit }, null, 1),
  );
  await shot(page, 'T5_grid_period_1m');
  expect(errs.crash).toEqual([]);
  expect(errs.other).toEqual([]);
});

// ═════════════════════════ ④ 宫格表头 D2 一致性 ═════════════════════════
test('T6 宫格 no-data 格空态与表头对照（route 注入 disabled/无数据 于前4）', async ({ page }) => {
  test.setTimeout(120_000);
  const errs = watchErrors(page);
  const hits = watchKlineResponses(page);
  const real = (await (await page.request.get('http://127.0.0.1:8081/api/symbols')).json()) as Array<Record<string, unknown>>;
  const fake: Array<Record<string, unknown>> = [
    { code: 'TEST_OFF', name: '停用验证标的', interval_secs: 60, settlement: 'T1', enabled: false, latest: null },
    { code: 'TEST_NODATA', name: '无数据验证标的', interval_secs: 60, settlement: 'T1', enabled: true, latest: null },
    ...real.slice(0, 4),
  ];
  await page.route('**/api/symbols', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }),
  );
  await gotoPage(page, '/');
  await page.waitForSelector('[data-region="symbol-list"] button', { timeout: 30_000 });
  await page.waitForTimeout(1200);

  // SymbolList 口径（D2 已修复层）
  const listRows = await page.locator('[data-region="symbol-list"] button').allInnerTexts();
  const offRow = listRows.find((t) => t.startsWith('TEST_OFF')) ?? '';
  const noDataRow = listRows.find((t) => t.startsWith('TEST_NODATA')) ?? '';
  expect(offRow, 'SymbolList 停用行').toContain('已停用');
  expect(noDataRow, 'SymbolList 无数据行').toContain('无数据');
  expect(offRow).not.toContain('0.00');
  expect(noDataRow).not.toContain('0.00');

  // 切 2×2 → 前4格 = TEST_OFF / TEST_NODATA / 真实×2
  await enterGrid(page, '2×2', 4500);
  const snap = await gridSnapshot(page);
  expect(snap.cells.map((c) => c.code).slice(0, 2)).toEqual(['TEST_OFF', 'TEST_NODATA']);
  for (const c of snap.cells) {
    expect(c.canvasCount, `code=${c.code} 结构 6 canvas`).toBe(6);
    for (const cv of c.canvases!) {
      const [, h] = cv.split('x').map(Number);
      expect(h!, `code=${c.code} canvas 有界`).toBeLessThan(2000);
    }
  }
  expect(errs.crash, 'no-data 格不得崩溃').toEqual([]);
  // R2：格表头与 SymbolList 同口径（停用→已停用、启用无数据→无数据，不伪造 0.00%）
  const cellTexts = await page.locator('[data-grid-cell]').allInnerTexts();
  const offHdr = cellTexts[0]!.replace(/\n/g, '|');
  const noDataHdr = cellTexts[1]!.replace(/\n/g, '|');
  expect(offHdr, '停用格表头应显示「已停用」').toContain('已停用');
  expect(noDataHdr, '无数据格表头应显示「无数据」').toContain('无数据');
  expect(offHdr, '停用格表头不得伪造 0.00%').not.toMatch(/[+-]0\.00%/);
  expect(noDataHdr, '无数据格表头不得伪造 0.00%').not.toMatch(/[+-]0\.00%/);
  // no-data 格 kline 请求走真实后端 → 200 空（无该 code 数据）
  const testHits = hits.filter((h) => hitKey(h.url).code.startsWith('TEST'));
  writeFileSync(
    `${EVID}/t6_nodata_cells.json`,
    JSON.stringify({ snap: snap.cells, testKlineHits: testHits.map((h) => ({ url: h.url, status: h.status, bars: h.bars.length })) }, null, 1),
  );
  await shot(page, 'T6_nodata_cells_no_crash');
  expect(errs.other).toEqual([]);
});

test('R2 格表头 D2 一致性：停用/无数据格表头「已停用/无数据」，与 SymbolList 同口径不伪造 0.00%', async ({ page }) => {
  test.setTimeout(120_000);
  const real = (await (await page.request.get('http://127.0.0.1:8081/api/symbols')).json()) as Array<Record<string, unknown>>;
  const fake: Array<Record<string, unknown>> = [
    { code: 'TEST_OFF', name: '停用验证标的', interval_secs: 60, settlement: 'T1', enabled: false, latest: null },
    { code: 'TEST_NODATA', name: '无数据验证标的', interval_secs: 60, settlement: 'T1', enabled: true, latest: null },
    ...real.slice(0, 4),
  ];
  await page.route('**/api/symbols', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }),
  );
  await gotoPage(page, '/');
  await page.waitForSelector('[data-region="symbol-list"] button', { timeout: 30_000 });
  await page.waitForTimeout(1200);
  await enterGrid(page, '2×2', 4500);
  const texts = await page.locator('[data-grid-cell]').allInnerTexts();
  const hdr0 = texts[0]!.replace(/\n/g, '|');
  const hdr1 = texts[1]!.replace(/\n/g, '|');
  // R2 强断言：停用/无数据格表头与 SymbolList 同口径，不伪造 0.00%
  const gridShowsOff = hdr0.includes('TEST_OFF') && hdr0.includes('已停用') && !/[+-]0\.00%/.test(hdr0);
  const gridShowsNoData = hdr1.includes('TEST_NODATA') && hdr1.includes('无数据') && !/[+-]0\.00%/.test(hdr1);
  writeFileSync(
    `${EVID}/t6defect_grid_header_d2.json`,
    JSON.stringify({
      symbolList: { off: '已停用', nodata: '无数据' },
      gridHeaderOff: hdr0, gridHeaderNoData: hdr1,
      gridShowsOff, gridShowsNoData,
      d2Spec: '格表头应与 SymbolList 同口径：停用→已停用、启用无数据→无数据，不得伪造 0.00%',
    }, null, 1),
  );
  await shot(page, 'R2_grid_header_d2');
  expect(gridShowsOff, '(R2) 停用格表头显示「已停用」且不含 0.00%').toBe(true);
  expect(gridShowsNoData, '(R2) 无数据格表头显示「无数据」且不含 0.00%').toBe(true);
});

// ═════════════════════════ ⑤ 单图内嵌组件回归 ═════════════════════════
test('T7 单图回归（网格交互后）：VOL/MA 指标 pane + 分时线/均价线 + WS 注入推进 + 1m 当日 DB 对账', async ({ page }) => {
  test.setTimeout(220_000);
  const errs = watchErrors(page);
  const hits = watchKlineResponses(page);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-testid="kline-chart"] canvas', { timeout: 30_000 });
  await waitSock(page);
  await page.waitForTimeout(2000);
  const code = (await symbolOrder(page, 1))[0]!;

  // 网格交互一轮后回单图
  await bt(page, '2×2').click();
  await page.waitForTimeout(3000);
  await bt(page, '2×3').click();
  await page.waitForTimeout(3000);
  await bt(page, '单图').click();
  await page.waitForTimeout(2500);

  const baseSnap = async () =>
    page.evaluate(() => {
      const cs = Array.from(document.querySelectorAll('[data-testid="kline-chart"] canvas'));
      return { total: cs.length, maxH: Math.max(...cs.map((c) => c.height)) };
    });
  expect((await baseSnap()).total, '主图+VOL 副图+时间轴 canvas=10').toBe(10);
  for (const [label, total] of [['MACD', 14], ['KDJ', 18], ['BOLL', 22]] as const) {
    await bt(page, label).click();
    await page.waitForTimeout(1100);
    const s = await baseSnap();
    expect(s.total, `${label} pane 出现`).toBe(total);
    expect(s.maxH, 'canvas 有界').toBeLessThan(2000);
  }
  await shot(page, 'T7_indicators_after_grid');
  for (const label of ['BOLL', 'KDJ', 'MACD'] as const) {
    await bt(page, label).click();
    await page.waitForTimeout(700);
  }
  expect((await baseSnap()).total).toBe(10);

  // ── 分时 ──
  await bt(page, '分时').click();
  await page.waitForTimeout(3200);
  const t0 = await page.evaluate(() => ({
    svg: !!document.querySelector('[data-region="main-chart"] svg'),
    text: (document.querySelector('[data-region="main-chart"]')?.textContent ?? '').slice(0, 60),
  }));

  // 分时 1m 数据源（limit=482）与 DB 当日对账：当日=最近有数据 CST 日（本周五，休市日今日 0 bar 已在 t0 留证）
  const ts1mHit = hits.filter((h) => {
    const k = hitKey(h.url);
    return k.period === '1m' && k.limit === 482 && !k.before;
  });
  let dayReconcile: Record<string, unknown> | null = null;
  if (ts1mHit.length > 0) {
    const restBars = ts1mHit.at(-1)!.bars;
    if (restBars.length > 0) {
      const lastTs = String(restBars.at(-1)!.ts);
      const lastCst = new Date(Date.parse(lastTs) + 8 * 3600_000);
      const y = lastCst.getUTCFullYear();
      const m = String(lastCst.getUTCMonth() + 1).padStart(2, '0');
      const d = String(lastCst.getUTCDate()).padStart(2, '0');
      const dayStartZ = new Date(Date.UTC(y, Number(m) - 1, Number(d)) - 8 * 3600_000).toISOString().slice(0, 19) + 'Z';
      const dayEndZ = new Date(Date.UTC(y, Number(m) - 1, Number(d)) + 16 * 3600_000).toISOString().slice(0, 19) + 'Z';
      const dbDay = db1mDay(code, dayStartZ, dayEndZ);
      const restDay = restBars.filter((b) => String(b.ts) >= dayStartZ && String(b.ts) < dayEndZ);
      const cmp = compareRows(restToRows(restDay), dbDay);
      dayReconcile = { cstDay: `${y}-${m}-${d}`, dayStartZ, dayEndZ, cmp };
      expect(cmp.mismatchCount, '分时 1m 数据源与 DB 当日 M1 对账').toBe(0);
      expect(cmp.asc).toBe(true);
    }
  }

  // WS 注入 12 根今日 1m bar（确定性序列）推进分时线/均价线
  const bars: Array<{ ts: string; close: number; amount: number; volume: number }> = [];
  const now = Date.now();
  const basePrice = 1.7;
  let cumAmt = 0;
  let cumVol = 0;
  for (let i = 0; i < 12; i++) {
    const ts = new Date(now - (11 - i) * 60_000).toISOString();
    const close = basePrice + i * 0.002;
    const volume = 1000 + i * 100;
    const amount = close * volume;
    cumAmt += amount;
    cumVol += volume;
    bars.push({ ts, close, amount, volume });
    await push(page, { type: 'bar', code, period: '1m', bar: { ts, open: close, high: close + 0.001, low: close - 0.001, close, volume, amount } });
  }
  await page.waitForTimeout(2200);
  const t1 = await page.evaluate(() => {
    const svg = document.querySelector('[data-region="main-chart"] svg');
    if (!svg) return { svg: false, text: document.querySelector('[data-region="main-chart"]')?.textContent ?? '' };
    const polys = Array.from(svg.querySelectorAll('polyline'));
    return {
      svg: true,
      polys: polys.length,
      pts: polys.map((p) => p.getAttribute('points')?.trim().split(/\s+/).length ?? 0),
      texts: Array.from(svg.querySelectorAll('text')).map((t) => t.textContent ?? ''),
    };
  });
  const expPrice = bars.at(-1)!.close.toFixed(3);
  const expAvg = (cumAmt / cumVol).toFixed(3);
  writeFileSync(
    `${EVID}/t7_timeshare.json`,
    JSON.stringify({ t0, dayReconcile, t1, expPrice, expAvg, injected: bars.length }, null, 1),
  );
  await shot(page, 'T7_timeshare_after_grid');
  expect(t1.svg, '注入盘中后分时 svg 出现').toBe(true);
  expect(t1.polys, '价格线+均价线').toBe(2);
  expect(t1.pts[0], '价格线点数=12（无缺口）').toBe(12);
  expect(t1.pts[1], '均价线点数=12').toBe(12);
  expect(t1.texts.join('|'), '最新价').toContain(expPrice);
  expect(t1.texts.join('|'), '均价').toContain(expAvg);
  await bt(page, 'K线').click();
  await expect(page.locator('[data-testid="kline-chart"] canvas').first()).toBeVisible();
  expect(errs.crash).toEqual([]);
  expect(errs.other).toEqual([]);
});

// ═════════════════════════ ⑥ WS 隔离 ═════════════════════════
test('T8 WS 隔离：单图实时→格内无实时 bar 视觉追加→格表头 quote 更新→回单图实时恢复', async ({ page }) => {
  test.setTimeout(160_000);
  const errs = watchErrors(page);
  await gotoPage(page, '/');
  await page.waitForSelector('[data-testid="kline-chart"] canvas', { timeout: 30_000 });
  await waitSock(page);
  await page.waitForTimeout(2000);
  const code = (await symbolOrder(page, 1))[0]!;
  const marker = page.locator('[data-realtime-marker]');

  // 1) 单图实时有效
  await push(page, { type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T07:15:00Z', open: 9.1, high: 9.2, low: 9.0, close: 9.15, volume: 100, amount: 100 } });
  await expect(marker).toContainText('9.15', { timeout: 6000 });

  // 2) 格内：同 code 更晚 bar 帧 → 无 marker、画布不变（设计无实时视觉追加）
  await bt(page, '2×2').click();
  await page.waitForTimeout(4200);
  const cellHash = async (i: number) =>
    page.locator('[data-grid-cell]').nth(i).evaluate((el) => {
      const m = Array.from(el.querySelectorAll('canvas')).find((x) => x.width > 300 && x.height > 40);
      return m ? m.toDataURL() : 'none';
    });
  const h0 = await cellHash(0);
  await push(page, { type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T07:30:00Z', open: 9.2, high: 9.3, low: 9.0, close: 9.25, volume: 200, amount: 200 } });
  await push(page, { type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T07:45:00Z', open: 9.2, high: 9.3, low: 9.0, close: 9.28, volume: 200, amount: 200 } });
  await page.waitForTimeout(1800);
  expect(await page.locator('[data-grid-cell] [data-realtime-marker]').count(), '格内不得出现实时 marker').toBe(0);
  const h1 = await cellHash(0);
  expect(h1, '格内画布不得因 bar 帧重绘/追加').toBe(h0);

  // 3) 格表头 quote 注入（服务端 snake_case change_pct 形状）→ 表头更新
  const code1 = (await gridSnapshot(page)).cells[1]!.code;
  await push(page, { type: 'quote', code: code1, ts: new Date().toISOString(), last: 1.234, change_pct: -5.55 });
  await page.waitForTimeout(1200);
  const hdr = await page.locator('[data-grid-cell]').nth(1).innerText();
  expect(hdr).toContain('-5.55');

  // 4) 回单图：实时恢复
  await bt(page, '单图').click();
  await page.waitForTimeout(3000);
  await push(page, { type: 'bar', code, period: '15m', bar: { ts: '2026-09-04T08:00:00Z', open: 9.2, high: 9.4, low: 9.0, close: 9.31, volume: 300, amount: 300 } });
  await expect(marker).toContainText('9.31', { timeout: 6000 });
  await shot(page, 'T8_ws_isolation_resume');
  expect(errs.crash).toEqual([]);
  expect(errs.other).toEqual([]);
});
