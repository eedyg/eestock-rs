/**
 * **临时取证探针**（tester 车道；不属于冻结规格，取证后删除）。用途：定位
 * `adr028-features-verify.e2e.ts::T4` 的偶发红（4.1s 提前失败于「跳转后目标笔几何必须可测」）。
 *
 * 做法：复刻 T4 的前置流程（开结果页 → 展开 L2 → 跳到第 42 笔），在**点击前**注入页面侧采样器，
 * 以 ~50ms 周期记录 12s 的图表真身状态：
 *   - `__wbCharts` 候选数 / 每候选 `getDataList().length`（图表数据是否就绪）
 *   - `getOverlays()` 全量名单 + `fillDot` 条数（marker 是否已建）
 *   - geomByFill 同口径的「目标笔 (ts,price) 是否可定位」
 *   - `data-marker-overlays` / `data-highlight-*` / `wb-window-probe`（写窗回执）
 * 另记录 `/api/kline` 与 `/fills` 的网络到达时刻，用于把「提前失败」与「数据就绪时刻」对齐。
 *
 * 运行：
 *   cd web && E2E_BASE_URL=http://localhost:8081 ADR028PROBE_OUT=<abs dir> \
 *     npx playwright test e2e/adr028-t4-flaky-probe.e2e.ts --workers=1 --retries=0 --reporter=list
 * 注入复现：
 *   ADR028PROBE_DELAY_KLINE_MS=8000   # 延迟图表 K 线取数（模拟「跳转发生在数据未就绪时」）
 *   ADR028PROBE_DELAY_FILLS_MS=8000   # 延迟成交明细（模拟「fills 落后于图表数据」）
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.env.ADR028PROBE_OUT ?? '/tmp/adr028_t4_probe';
const RUN_A = process.env.ADR028PROBE_RUN_A ?? 'sr_1789865219068_000001';
const RT_A = Number(process.env.ADR028PROBE_RT_A ?? '1');
const FILL_A = Number(process.env.ADR028PROBE_FILL_A ?? '42');
const DELAY_KLINE_MS = Number(process.env.ADR028PROBE_DELAY_KLINE_MS ?? '0');
const DELAY_FILLS_MS = Number(process.env.ADR028PROBE_DELAY_FILLS_MS ?? '0');
const SAMPLE_MS = Number(process.env.ADR028PROBE_SAMPLE_MS ?? '12000');
const ORDER_N = Number(process.env.ADR028PROBE_ORDER_N ?? '0');

const PAGE_CAPTURE = `
  (() => {
    const w = window;
    w.__wbCharts = [];
    const orig = Map.prototype.set;
    Map.prototype.set = function (k, v) {
      try {
        if (v && typeof v === 'object' && typeof v.convertToPixel === 'function' && typeof v.getDataList === 'function') {
          w.__wbCharts.push(v);
        }
      } catch {}
      return orig.call(this, k, v);
    };
  })();
`;

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

async function readAttrs(page: Page, testId: string): Promise<Record<string, string>> {
  return page.getByTestId(testId).evaluate((e) =>
    Object.fromEntries(Array.from(e.attributes).map((a) => [a.name, a.value])),
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(PAGE_CAPTURE);
});

test('PROBE T4 前置就绪时序：图表数据 / marker overlay / 目标笔可定位 / 写窗回执', async ({ page }) => {
  const net: Array<{ url: string; at: number; status: number }> = [];
  const t0 = Date.now();
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/kline') || u.includes('/fills') || u.includes('/bars') || u.includes('/round-trips')) {
      net.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), at: Date.now() - t0, status: r.status() });
    }
  });

  if (DELAY_KLINE_MS > 0 || DELAY_FILLS_MS > 0) {
    await page.route('**/api/kline*', async (route) => {
      if (DELAY_KLINE_MS > 0) await new Promise((r) => setTimeout(r, DELAY_KLINE_MS));
      await route.continue();
    });
    await page.route('**/fills*', async (route) => {
      if (DELAY_FILLS_MS > 0) await new Promise((r) => setTimeout(r, DELAY_FILLS_MS));
      await route.continue();
    });
  }

  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const fA = fills[FILL_A]!;

  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${RUN_A}`);
  await expect(sel).toBeVisible();
  const tSelect = Date.now() - t0;
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  const tResult = Date.now() - t0;
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  const tWindowBar = Date.now() - t0;

  // ── 页面侧采样器（点击前启动；与冻结规格 T4 相同的定位口径）──
  await page.evaluate(
    (arg) => {
      const w = window as unknown as {
        __t4probe?: Array<Record<string, unknown>>;
        __t4stop?: () => void;
        __t4iv?: number;
      };
      const target = arg.target;
      const samples: Array<Record<string, unknown>> = [];
      w.__t4probe = samples;
      const startedAt = Date.now();
      const geomProbe = () => {
        const cands = (w as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> }).__wbCharts ?? [];
        const withData: Array<Record<string, (...a: unknown[]) => unknown>> = [];
        for (const c of cands) {
          try {
            if (((c['getDataList'] as () => unknown[])() ?? []).length > 0) withData.push(c);
          } catch {
            /* 忽略 */
          }
        }
        w.__t4candInfo = cands.map((c) => {
          try {
            return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length;
          } catch {
            return -1;
          }
        });
        if (withData.length === 0) return { cands: cands.length, dataLens: w.__t4candInfo, ok: false };
        const chart = withData[0]!;
        let overlays: Array<Record<string, unknown>> = [];
        try {
          overlays = (chart['getOverlays'] as () => Array<Record<string, unknown>>)() ?? [];
        } catch {
          /* 忽略 */
        }
        const byName: Record<string, number> = {};
        for (const o of overlays) byName[String(o['name'])] = (byName[String(o['name'])] ?? 0) + 1;
        const dots = overlays.filter((o) => o['name'] === 'fillDot');
        let matched = false;
        let matchedKey = '';
        for (const o of dots) {
          const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
          const pts = (o['points'] ?? []) as Array<{ timestamp?: number; value?: number }>;
          const p0 = pts[0];
          if (!p0) continue;
          if (Math.abs(Number(p0.timestamp) - target.ts * 1000) < 1000 && Math.abs(Number(p0.value) - target.price) < 1e-9) {
            matched = true;
            matchedKey = String(ext['fillKey'] ?? '');
          }
        }
        return {
          cands: cands.length,
          dataLens: w.__t4candInfo,
          ok: true,
          dataLen: ((chart['getDataList'] as () => unknown[])() as unknown[]).length,
          byName,
          dots: dots.length,
          matched,
          matchedKey,
        };
      };
      w.__t4stop = () => {
        if (w.__t4iv != null) clearInterval(w.__t4iv);
      };
      w.__t4iv = setInterval(() => {
        const kl = document.querySelector('[data-testid="kline-chart"]');
        const probe = document.querySelector('[data-testid="wb-window-probe"]');
        const attrs = (el: Element | null) =>
          el ? Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value])) : null;
        samples.push({
          t: Date.now() - startedAt,
          geom: geomProbe(),
          klAttrs: attrs(kl),
          probeAttrs: probe
            ? {
                ok: probe.getAttribute('data-ok'),
                rev: probe.getAttribute('data-rev'),
                err: probe.getAttribute('data-error'),
                fromIdx: probe.getAttribute('data-from-idx'),
                toIdx: probe.getAttribute('data-to-idx'),
              }
            : null,
        });
      }, 50);
    },
    { target: { ts: Number(fA['ts']), price: Number(fA['price']) } },
  );

  // L2 展开 + 跳转（与冻结规格同序）
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  const tL2 = Date.now() - t0;
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  const tClick = Date.now() - t0;
  // 采样器跑 SAMPLE_MS ms（足够覆盖「高亮 3s + 之后」与「数据迟到」两种情况）
  await page.waitForTimeout(SAMPLE_MS);
  const samples = (await page.evaluate(() => {
    const w = window as unknown as { __t4probe?: Array<Record<string, unknown>>; __t4stop?: () => void };
    w.__t4stop?.();
    return w.__t4probe ?? [];
  })) as Array<Record<string, unknown>>;

  // 压缩：只保留「状态变化」的样本 + 每秒一个心跳样本
  const key = (s: Record<string, unknown>) => JSON.stringify([s['geom'], s['klAttrs'], s['probeAttrs']]);
  const compact: Array<Record<string, unknown>> = [];
  let lastKey = '';
  let lastT = -1e9;
  for (const s of samples) {
    const k = key(s);
    const t = Number(s['t']);
    if (k !== lastKey || t - lastT >= 1000) {
      compact.push(s);
      lastKey = k;
      lastT = t;
    }
  }

  const out = {
    env: { baseURL: process.env.E2E_BASE_URL, delayKlineMs: DELAY_KLINE_MS, delayFillsMs: DELAY_FILLS_MS },
    run: RUN_A,
    rt: RT_A,
    fillA: FILL_A,
    target: { ts: Number(fA['ts']), price: Number(fA['price']) },
    phaseMs: { tSelect, tResult, tWindowBar, tL2, tClick, total: Date.now() - t0 },
    net,
    samples: samples.length,
    compact,
  };
  writeJson('t4_timeline', out);

  // 只做「信息性」断言，避免探针自身红绿掩盖事实
  expect(samples.length).toBeGreaterThan(0);
});

/** 订单/取数**到达次序**统计（不改页面行为）：每次迭代 = 一次全新装载 + 选中 run，
 *  记录 `/api/kline`（图表 K 线）与 run 级 `/fills`（marker 事实源）的响应到达时刻相对「选中 run」的偏移，
 *  以及落定后 `data-marker-overlays`（marker 是否真的建起来）。用于量化「谁先到」的余量。 */
test('PROBE 自然次序统计：/api/kline 与 /fills 到达差 vs marker 建成数', async ({ page }) => {
  test.skip(ORDER_N <= 0, 'ADR028PROBE_ORDER_N 未设置');
  await page.addInitScript(PAGE_CAPTURE);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ORDER_N; i += 1) {
    const events: Array<{ kind: string; at: number }> = [];
    const rec = (r: { url: () => string }) => {
      const u = r.url();
      const kind = u.includes('/api/kline') ? 'kline' : /\/fills\?limit=5000/.test(u) ? 'fills' : null;
      if (kind) events.push({ kind, at: Date.now() });
    };
    page.on('response', rec);
    await page.goto('/backtest-workbench');
    await expect(page.getByTestId('wb-run-list')).toBeVisible();
    const sel = page.getByTestId(`wb-run-select-${RUN_A}`);
    await expect(sel).toBeVisible();
    await sel.click();
    const tSel = Date.now();
    await expect(page.getByTestId('wb-fills-note')).toBeVisible();
    await page.waitForTimeout(3000);
    const attrs = await readAttrs(page, 'kline-chart');
    const store = await page.evaluate(() => {
      const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
      const cands = (w.__wbCharts ?? []).filter((c) => {
        try {
          return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length > 0;
        } catch {
          return false;
        }
      });
      if (cands.length === 0) return { ok: false, names: [] as string[] };
      const all = (cands[0]!['getOverlays'] as () => Array<Record<string, unknown>>)() ?? [];
      return { ok: true, names: all.map((o) => String(o['name'])) };
    });
    page.off('response', rec);
    const at = (k: string) => events.filter((e) => e.kind === k).map((e) => e.at - tSel);
    const kl = at('kline');
    const fl = at('fills');
    rows.push({
      i: i + 1,
      klineAtMs: kl,
      fillsAtMs: fl,
      deltaKlineMinusFillsMs: kl[0] != null && fl[0] != null ? kl[0] - fl[0] : null,
      markerOverlays: attrs['data-marker-overlays'],
      storeFillDot: store.names.filter((n) => n === 'fillDot').length,
    });
  }
  writeJson('order_stats', rows);
  expect(rows.length).toBe(ORDER_N);
});

/** **T4 仿跑（fresh context 每次）**：完全复刻冻结规格 T4 的时序（含 `openRunSettled` 的 2500ms
 *  固定等待 + L2 展开 250ms + 跳转），在**geom 读取那一刻**记录图表真身状态：
 *  候选图实例数 / dataList 长度 / `fillDot` 条数 / 目标笔 (ts,price) 是否可定位 / `data-marker-overlays`。
 *  目的：在自然条件下统计「geom 不可测」的发生率与对应的状态画像（不注入任何延迟）。 */
test('PROBE T4 仿跑 xN：geom 时刻状态画像与自然发生率', async ({ browser }) => {
  test.setTimeout(600_000);
  const outDir = OUT;
  const runs = Number(process.env.ADR028PROBE_MIMIC_N ?? '10');
  const rows: Array<Record<string, unknown>> = [];
  const fillsResp = await fetch(`http://localhost:8081/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const fA = fills[FILL_A]!;
  const fB = fills[Number(process.env.ADR028PROBE_FILL_B ?? '43')]!;

  for (let i = 0; i < runs; i += 1) {
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081', locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript(PAGE_CAPTURE);
    const net: Array<{ kind: string; at: number }> = [];
    const t0 = Date.now();
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('/api/kline')) net.push({ kind: 'kline', at: Date.now() - t0 });
      if (/\/fills\?limit=5000/.test(u)) net.push({ kind: 'fills', at: Date.now() - t0 });
    });
    await page.goto('/backtest-workbench');
    await expect(page.getByTestId('wb-run-list')).toBeVisible();
    await page.getByTestId(`wb-run-select-${RUN_A}`).click();
    await expect(page.getByTestId('wb-fills-note')).toBeVisible();
    await expect(page.getByTestId('wb-window-bar')).toBeVisible();
    await page.waitForTimeout(2500);
    await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
    const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
    await expect(row).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
    // settleJump 等价（高亮生效 + 滚动落定 + K 线整体在视口内）
    await expect
      .poll(async () => page.getByTestId('kline-chart').getAttribute('data-highlight-active'), {
        timeout: 3000,
        intervals: [120],
      })
      .toBe('true');
    await page.waitForTimeout(300);
    // ── geom 时刻画像（与冻结规格 geomByFill 同口径）──
    const snap = await page.evaluate(
      (arg) => {
        const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
        const candsAll = w.__wbCharts ?? [];
        const cands = candsAll.filter((c) => {
          try {
            return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length > 0;
          } catch {
            return false;
          }
        });
        const out: Record<string, unknown> = { candsAll: candsAll.length, cands: cands.length, dataLens: candsAll.map((c) => { try { return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length; } catch { return -1; } }) };
        if (cands.length === 0) return { ...out, dots: 0, matchedA: false, matchedB: false, names: [] as string[] };
        const chart = cands[0]!;
        const all = (chart['getOverlays'] as () => Array<Record<string, unknown>>)() ?? [];
        const byName: Record<string, number> = {};
        for (const o of all) byName[String(o['name'])] = (byName[String(o['name'])] ?? 0) + 1;
        const hit = (t: { ts: number; price: number }) =>
          all.some((o) => {
            if (o['name'] !== 'fillDot') return false;
            const pts = (o['points'] ?? []) as Array<{ timestamp?: number; value?: number }>;
            const p0 = pts[0];
            return !!p0 && Math.abs(Number(p0.timestamp) - t.ts * 1000) < 1000 && Math.abs(Number(p0.value) - t.price) < 1e-9;
          });
        const kl = document.querySelector('[data-testid="kline-chart"]');
        const probe = document.querySelector('[data-testid="wb-window-probe"]');
        return {
          ...out,
          dots: byName['fillDot'] ?? 0,
          names: Object.keys(byName),
          byName,
          matchedA: hit(arg.a),
          matchedB: hit(arg.b),
          markerOverlays: kl?.getAttribute('data-marker-overlays'),
          windowProbeOk: probe?.getAttribute('data-ok'),
          windowProbeErr: probe?.getAttribute('data-error'),
        };
      },
      { a: { ts: Number(fA['ts']), price: Number(fA['price']) }, b: { ts: Number(fB['ts']), price: Number(fB['price']) } },
    );
    const geomOk = snap['matchedA'] === true && snap['matchedB'] === true;
    const kAt = net.filter((n) => n.kind === 'kline').map((n) => n.at);
    const fAt = net.filter((n) => n.kind === 'fills').map((n) => n.at);
    rows.push({
      i: i + 1,
      totalMs: Date.now() - t0,
      klineRequests: kAt.length,
      fillsRequests: fAt.length,
      klineAtMs: kAt,
      fillsAtMs: fAt,
      deltaKlineMinusFillsMs: kAt[0] != null && fAt[0] != null ? kAt[0] - fAt[0] : null,
      geomOk,
      ...snap,
    });
    await ctx.close();
    if (!geomOk) writeJson(`mimic_fail_${i + 1}`, rows[rows.length - 1]!);
  }
  writeJson('mimic_stats', rows);
  mkdirSync(outDir, { recursive: true });
  // 判词：只报数，不因产品竞态让探针自身红（事实优先）
  expect(rows.length).toBe(runs);
});
