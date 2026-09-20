/**
 * 本波（2026-09-20）**解冻修复**规格（worker 前端车道自有规格；不改 tester 的三个规格）。
 *
 * 覆盖：
 *  - F0 真身锚定：被 :8081 服务的 bundle 必须是**含本波修复**的构建（含新弹性布局类名、无被删除的承诺文案）；
 *  - F1（B1 阻断项）：任意 L2 跳转后，「全览 / 历史回退」按钮**可被真实点击** ——
 *        `elementFromPoint` 在多采样点命中按钮自身或其子元素 + `click()` 真实点击成功且不超时；
 *        同时断言 K 线容器**不溢出** `h-64` 卡片（旧实现溢出 27px ⇒ canvas 盖住窗口控制条）；
 *  - F2（R1 风险项）：run 末根 bar 的买卖标签**完整可见**（标签盒内 ink 列覆盖率 ≥ 0.6、ink 像素 ≥ 80）；
 *  - F3（R3 风险项）：**真渲染像素颜色**断言 —— 圆点中心像素色值 == 该标记 store 色值（买红 / 卖绿），
 *        并给出「止损橙」当下的不可测说明与复验口径。
 *
 * 运行（对 :8081 静态产物）：
 *   cd web && timeout 400 env E2E_BASE_URL=http://localhost:8081 \
 *     npx playwright test e2e/adr028-features-fix.e2e.ts --reporter=list --retries=0
 *
 * 产物：`ADR028FIX_OUT`（默认 `coder/evidence/20260920_adr028_features_fix/raw`）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028FIX_OUT ?? resolve(REPO, 'coder/evidence/20260920_adr028_features_fix/raw');

/** run A：rt_seq=1 的 44 笔，第 42/43 笔同 bar（bar_index=423、ts=1789660800；423 是该 run **末根** bar）。 */
const RUN_A = process.env.ADR028FIX_RUN_A ?? 'sr_1789865219068_000001';
const RT_A = Number(process.env.ADR028FIX_RT_A ?? '1');
const FILL_A = Number(process.env.ADR028FIX_FILL_A ?? '42');

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

type Marker = {
  key: string;
  color: string;
  text: string;
  label: string;
  stack: number;
  ts: number;
  price: number;
  x: number;
  y: number;
};

/** 真图表 store：逐条读 `fillDot`（常态标记）+ 其渲染位置（容器相对坐标，**含堆叠偏移**）。 */
async function markers(page: Page, paneWidthHint = 0): Promise<{ ok: boolean; pane: { w: number; h: number }; rows: Marker[] }> {
  return page.evaluate((hint) => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return { ok: false, pane: { w: hint, h: 0 }, rows: [] };
    const chart = cands[0]!;
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    const rows = all.map((o) => {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
        { paneId: 'candle_pane' },
      );
      const stack = Number(ext['stackIndex'] ?? 0);
      return {
        key: String(ext['fillKey'] ?? ''),
        color: String(ext['color'] ?? ''),
        text: String(ext['text'] ?? ''),
        label: String(ext['label'] ?? ''),
        stack,
        ts: Number(pts[0]!.timestamp),
        price: pts[0]!.value,
        x: Number(p.x ?? NaN),
        y: Number(p.y ?? NaN) + stack * 12,
      };
    });
    return { ok: true, pane: { w: hint, h: 0 }, rows } as unknown as { ok: boolean; pane: { w: number; h: number }; rows: Marker[] };
  }, paneWidthHint);
}

/** K 线容器与内部 canvas 的几何（pane 宽高用于「完全在画布内」过滤与边缘收敛判据）。 */
async function paneGeom(page: Page) {
  return page.evaluate(() => {
    const kl = document.querySelector('[data-testid="kline-chart"]')!;
    const r = kl.getBoundingClientRect();
    const canvases = Array.from(kl.querySelectorAll('canvas')).map((c) => {
      const cr = c.getBoundingClientRect();
      return { ox: Math.round(cr.x - r.x), oy: Math.round(cr.y - r.y), w: c.width, h: c.height };
    });
    // 绘图区（candle pane main）几何：**实现方标签收敛判据用的是同一量**（overlay `p.bounding.width`）
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    let pane: { width: number; height: number; left: number; right: number } | null = null;
    try {
      const p = (cands[0]!['getSize'] as (a?: string, b?: string) => { width: number; height: number; left: number; right: number } | null)(
        'candle_pane',
        'main',
      );
      if (p) pane = { width: p.width, height: p.height, left: p.left, right: p.right };
    } catch {
      pane = null;
    }
    return { w: Math.round(r.width), h: Math.round(r.height), canvases, pane };
  });
}

/** 采样点像素：**逐图层**读回（canvas DOM 顺序自下而上；`reverse` 后第一个 = 最上层），
 *  返回每个图层的 3×3 patch。图层叠放/覆盖不影响「某图层确实在该位置按该色值画了标记」这一事实。 */
async function samplePixels(page: Page, pts: Array<{ x: number; y: number }>, half = 1) {
  return page.evaluate(
    ({ points, half }) => {
      const kl = document.querySelector('[data-testid="kline-chart"]')!;
      const kr = kl.getBoundingClientRect();
      const cs = Array.from(kl.querySelectorAll('canvas'));
      const meta = cs.map((c, ci) => {
        const cr = c.getBoundingClientRect();
        return { c, ci, ox: Math.round(cr.x - kr.x), oy: Math.round(cr.y - kr.y) };
      });
      return points.map((p) => {
        let top: number[] | null = null;
        const layers: Array<{ ci: number; center: number[]; patch: number[][] }> = [];
        for (const m of meta) {
          const cx = p.x - m.ox;
          const cy = p.y - m.oy;
          if (cx < half || cy < half || cx + half >= m.c.width || cy + half >= m.c.height) continue;
          let d: Uint8ClampedArray;
          try {
            d = m.c.getContext('2d')!.getImageData(cx - half, cy - half, 1 + 2 * half, 1 + 2 * half).data;
          } catch {
            continue;
          }
          const center = [d[0]!, d[1]!, d[2]!, d[3]!];
          if (center[3]! < 200) continue;
          const patch: number[][] = [];
          for (let i = 0; i < d.length; i += 4) patch.push([d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!]);
          layers.push({ ci: m.ci, center, patch });
          if (top == null) top = center;
        }
        return { x: p.x, y: p.y, top, layers };
      });
    },
    { points: pts, half },
  );
}

type Rgb = [number, number, number];
const hexToRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const dist = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const isRedInk = ([r, g, b]: Rgb) => r > 80 && r - g > 40 && r - b > 25;
const isGreenInk = ([r, g, b]: Rgb) => g > 80 && g - r > 40 && g - b > 25;

/** 标签 ink：在 `[x0,x1]×[y0,y1]` 带内按颜色谓词统计「含墨列」的最长连续列数（= 标签可读宽度）。 */
async function inkRun(
  page: Page,
  box: { x0: number; x1: number; y0: number; y1: number },
  kind: 'red' | 'green',
): Promise<{ maxRun: number; total: number; x0: number; x1: number }> {
  return page.evaluate(
    ({ b, kind }) => {
      const kl = document.querySelector('[data-testid="kline-chart"]')!;
      const kr = kl.getBoundingClientRect();
      const cs = Array.from(kl.querySelectorAll('canvas'));
      const cols = new Set<number>();
      let total = 0;
      const ok = (r: number, g: number, bl: number) =>
        kind === 'red' ? r > 80 && r - g > 40 && r - bl > 25 : g > 80 && g - r > 40 && g - bl > 25;
      for (const c of cs) {
        const cr = c.getBoundingClientRect();
        const ox = Math.round(cr.x - kr.x);
        const oy = Math.round(cr.y - kr.y);
        let data: Uint8ClampedArray;
        try {
          data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        } catch {
          continue;
        }
        for (let x = Math.max(0, b.x0 - ox); x < Math.min(c.width, b.x1 - ox); x++) {
          for (let y = Math.max(0, b.y0 - oy); y < Math.min(c.height, b.y1 - oy); y++) {
            const i = (y * c.width + x) * 4;
            if (data[i + 3]! < 200) continue;
            if (ok(data[i]!, data[i + 1]!, data[i + 2]!)) {
              cols.add(x + ox);
              total += 1;
            }
          }
        }
      }
      let best = 0;
      let cur = 0;
      for (let x = b.x0; x <= b.x1; x++) {
        if (cols.has(x)) {
          cur += 1;
          if (cur > best) best = cur;
        } else {
          cur = 0;
        }
      }
      const xs = Array.from(cols).sort((p, q) => p - q);
      return { maxRun: best, total, x0: xs[0] ?? -1, x1: xs[xs.length - 1] ?? -1 };
    },
    { b: box, kind },
  );
}

async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${runId}`);
  await expect(sel, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  await page.waitForTimeout(2500);
}

async function gotoL2Jump(page: Page): Promise<void> {
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await expect
    .poll(async () => page.getByTestId('kline-chart').getAttribute('data-highlight-active'), { timeout: 8000 })
    .toBe('true');
  await page.waitForTimeout(400);
}

/** 按钮可点击性探针：几何 + 3 个采样点的 `elementFromPoint` 命中判定。 */
async function hitProbe(page: Page, testId: string) {
  return page.evaluate((id) => {
    const btn = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!btn) return { present: false };
    const br = btn.getBoundingClientRect();
    const samples = [0.5, 0.15, 0.85].map((f) => {
      const px = Math.round(br.x + br.width / 2);
      const py = Math.round(br.y + br.height * f);
      const at = document.elementFromPoint(px, py);
      return {
        f,
        px,
        py,
        tag: at ? at.tagName.toLowerCase() : null,
        testid: at instanceof Element ? (at.closest('[data-testid]')?.getAttribute('data-testid') ?? '') : '',
        selfOrChild: at === btn || btn.contains(at),
      };
    });
    const host = document.querySelector('[data-testid="wb-kline-chart"]')!.getBoundingClientRect();
    const kl = document.querySelector('[data-testid="kline-chart"]')!.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="wb-window-bar"]')!.getBoundingClientRect();
    const note = document.querySelector('[data-testid="wb-jump-highlight-note"]') as HTMLElement | null;
    return {
      present: true,
      disabled: (btn as HTMLButtonElement).disabled,
      rect: { x: br.x, y: br.y, w: br.width, h: br.height },
      samples,
      allSelf: samples.every((s) => s.selfOrChild),
      host: { x: host.x, y: host.y, w: host.width, h: host.height, bottom: host.bottom },
      kline: { bottom: kl.bottom, h: kl.height },
      overflowPx: Math.round(kl.bottom - host.bottom),
      barTop: Math.round(bar.top),
      notePresent: note != null,
      noteState: note?.getAttribute('data-state') ?? '',
      noteText: note?.textContent ?? '',
    };
  }, testId);
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(PAGE_CAPTURE);
});

// ───────────────────────── F0 真身锚定：被服务产物必须含本波修复 ─────────────────────────
test('F0 真身锚定：:8081 服务的 bundle 含本波修复（弹性布局类名在、被删除的承诺文案不在）', async ({ page }) => {
  const html = await (await page.request.get('/')).text();
  const m = /src="(\/assets\/index-[^"]+\.js)"/.exec(html);
  expect(m, 'index.html 必须引用打包产物').toBeTruthy();
  const js = await (await page.request.get(m![1]!)).text();
  const r = {
    bundle: m![1]!,
    hasFlexCard: js.includes('h-64 shrink-0 flex-col'),
    hasFlexChartArea: js.includes('min-h-0 flex-1'),
    hasRemovedPromise: js.includes('自动补高亮'),
  };
  writeJson('f0_bundle_anchor', r);
  expect(r.hasFlexCard, 'K 线卡片必须是 flex-col（B1 修复）').toBe(true);
  expect(r.hasFlexChartArea, '图表区必须是 flex-1 min-h-0（B1 修复）').toBe(true);
  expect(r.hasRemovedPromise, '被删除的不可达承诺文案不得出现在产物中（R2）').toBe(false);
});

// ───────────────────────── F1（B1 阻断项）：L2 跳转后按钮必须真实可点 ─────────────────────────
test('F1（B1）L2 跳转后「全览 / 历史回退」必须可被真实点击且 K 线容器不溢出卡片', async ({ page }) => {
  await openRunSettled(page, RUN_A);
  const before = { reset: await hitProbe(page, 'wb-window-reset'), back: await hitProbe(page, 'wb-window-back') };
  await gotoL2Jump(page);
  const reset = await hitProbe(page, 'wb-window-reset');
  const back = await hitProbe(page, 'wb-window-back');

  // 真实点击（playwright 会做 actionability 检查：命中点被 canvas 遮挡 ⇒ 重试至超时 ⇒ 红）
  let resetClickOk = false;
  let resetClickError = '';
  try {
    await page.getByTestId('wb-window-reset').click({ timeout: 3000 });
    resetClickOk = true;
  } catch (e) {
    resetClickError = String(e).slice(0, 300);
  }
  const afterReset = await hitProbe(page, 'wb-window-reset');
  let backClickOk: boolean | null = null;
  let backClickError = '';
  if (back.present && !back.disabled) {
    try {
      await page.getByTestId('wb-window-back').click({ timeout: 3000 });
      backClickOk = true;
    } catch (e) {
      backClickOk = false;
      backClickError = String(e).slice(0, 300);
    }
  }
  writeJson('f1_clickability', {
    before,
    afterJump: { reset, back },
    resetClickOk,
    resetClickError,
    afterReset,
    backClickOk,
    backClickError,
  });

  // 前提：B1 的触发条件必须真的出现（否则本用例无区分力）
  expect(reset.notePresent, 'L2 跳转后必须出现高亮提示（头部增高 ⇒ B1 触发条件）').toBe(true);
  expect(reset.noteText).toContain('已高亮目标成交');
  expect(before.reset.overflowPx, '跳转前不应溢出（对照）').toBeLessThanOrEqual(1);

  // ① K 线容器不得溢出 h-64 卡片（旧实现 +27px，canvas 盖住窗口控制条）
  expect(reset.overflowPx, `K 线容器不得溢出卡片（实测 ${reset.overflowPx}px）`).toBeLessThanOrEqual(1);
  expect(back.overflowPx).toBeLessThanOrEqual(1);
  expect(Math.round(reset.host.h), '卡片高度必须仍为 h-64 = 256（不得挤压其它区域）').toBe(256);
  expect(reset.host.bottom, '卡片底部不得越过窗口控制条顶部').toBeLessThanOrEqual(reset.barTop + 1);
  expect(reset.kline.h, '图表区必须仍有可用高度（flex 收缩后 > 100px）').toBeGreaterThan(100);

  // ② 采样点命中：按钮中心 / 15% / 85% 三处都必须命中按钮自身或其子元素
  for (const [name, p] of [
    ['全览', reset],
    ['回退', back],
  ] as const) {
    for (const s of p.samples) {
      expect(s.selfOrChild, `${name} 按钮采样点 f=${s.f} 命中 ${s.tag}[${s.testid}]，必须命中按钮自身/子元素`).toBe(true);
    }
  }

  // ③ 真实点击成功且不超时
  expect(resetClickError).toBe('');
  expect(resetClickOk, '「全览」必须能被真实点击（不得超时）').toBe(true);
  expect(afterReset.notePresent, '「全览」点击生效：高亮提示必须被清除').toBe(false);
  if (backClickOk != null) {
    expect(backClickError).toBe('');
    expect(backClickOk, '「历史回退」必须能被真实点击（不得超时）').toBe(true);
  }
});

// ───────────────── F2（R1 风险项）：末根 bar 标签完整可见 ─────────────────
/** 标签盒（**独立于实现的重算**，口径与 tester T2 一致：9px 文本 4.4px/字符 + padding 5）：
 *  右侧放得下 ⇒ 标签在圆点右侧（左对齐）；否则**边缘收敛**到圆点左侧（右对齐）。 */
function labelBox(x: number, text: string, paneW: number): { side: 'right' | 'left'; x0: number; x1: number; w: number } {
  const W = text.length * 4.4 + 5;
  const rightX = x + 3.2 + 3;
  const leftX = x - 3.2 - 3;
  if (rightX + W <= paneW - 1) return { side: 'right', x0: rightX, x1: rightX + W, w: W };
  if (leftX - W >= 1) return { side: 'left', x0: leftX - W, x1: leftX, w: W };
  const clampX = Math.max(1, paneW - 1 - W);
  return { side: 'left', x0: clampX, x1: clampX + W, w: W };
}

test('F2（R1）run 末根 bar 的买卖标签必须完整可见（边缘收敛）', async ({ page }) => {
  await openRunSettled(page, RUN_A);
  // R1 的触发条件：L2 跳转把窗口居中到目标笔 ⇒ **run 末根 bar 被推到 pane 右缘**
  await gotoL2Jump(page);
  await expect.poll(async () => page.getByTestId('wb-window-probe').getAttribute('data-ok'), { timeout: 8000 }).toBe('true');
  await page.waitForTimeout(3600); // 高亮 3s 回常态（避免白描边环干扰像素测量）
  const geom = await paneGeom(page);
  const paneW = geom.pane?.width ?? geom.w;
  const { rows } = await markers(page, Math.round(paneW));
  expect(rows.length, '标记数必须 > 0').toBeGreaterThan(0);
  const maxTs = Math.max(...rows.map((r) => r.ts));
  const lastBar = rows.filter((r) => r.ts === maxTs);
  expect(lastBar.length, '末根 bar 必须至少有一笔（R1 的目标样本）').toBeGreaterThan(0);

  const measure = async (m: Marker) => {
    const kind: 'red' | 'green' = m.color === '#00e0a4' ? 'green' : 'red';
    const box = labelBox(m.x, m.label, paneW);
    const ink = await inkRun(
      page,
      { x0: Math.floor(box.x0), x1: Math.ceil(box.x1), y0: Math.max(0, Math.round(m.y) - 5), y1: Math.round(m.y) + 5 },
      kind,
    );
    const cover = box.w > 0 && ink.x0 >= 0 ? (ink.x1 - ink.x0 + 1) / box.w : 0;
    return {
      key: m.key,
      label: m.label,
      x: Math.round(m.x),
      y: Math.round(m.y),
      kind,
      side: box.side,
      box: { x0: Math.round(box.x0), x1: Math.round(box.x1), w: Math.round(box.w) },
      ink,
      cover,
    };
  };

  const last = [] as Array<Awaited<ReturnType<typeof measure>>>;
  for (const m of lastBar) last.push(await measure(m));

  // 对照分布：中部标记（标签在右侧）的 ink 覆盖率——证明本口径有区分力（不是恒绿）
  const mid = rows.filter((r) => r.x <= paneW - 140 && r.ts !== maxTs);
  const midCov: number[] = [];
  const midInk: number[] = [];
  for (const m of mid) {
    const r = await measure(m);
    midCov.push(r.cover);
    midInk.push(r.ink.total);
  }
  midCov.sort((a, b) => a - b);
  midInk.sort((a, b) => a - b);
  const midCovMedian = midCov.length ? midCov[Math.floor(midCov.length / 2)]! : 0;
  writeJson('f2_last_bar_label', {
    paneW,
    paneContainerW: geom.w,
    pane: geom.pane,
    maxTs,
    last,
    midCount: midCov.length,
    midCovMedian,
    midCov,
    midInk,
  });

  for (const r of last) {
    expect(r.side, `末根 bar 标记 ${r.key} 必须触发边缘收敛（翻转对齐）`).toBe('left');
    expect(
      r.box.x1,
      `末根 bar 标记 ${r.key} 的标签必须完全落在 pane 内（x1=${r.box.x1} ≤ ${Math.floor(paneW - 1)}）`,
    ).toBeLessThanOrEqual(Math.floor(paneW - 1));
    expect(
      r.cover,
      `末根 bar 标记 ${r.key}（${r.label}）标签 ink 列覆盖率须 ≥ 0.6（完整可见；实测 ${r.cover.toFixed(3)}，ink=${r.ink.total}）`,
    ).toBeGreaterThanOrEqual(0.6);
    // ink 像素阈值取 80：实测绿标签（更细的字形覆盖率）=116、红标签=255；而**旧实现**（标签被推到 pane 外）
    // 在翻转盒内实测 ~0-50（仅剩蜡烛/MA 噪声）⇒ 阈值对「修复前/后」有区分力。
    expect(r.ink.total, `末根 bar 标记 ${r.key} 标签 ink 像素数须 ≥ 80（实测 ${r.ink.total}）`).toBeGreaterThanOrEqual(80);
  }
  expect(
    midCovMedian,
    `对照：中部标记标签 ink 列覆盖率中位数须 ≥ 0.6（口径有区分力；实测 ${midCovMedian.toFixed(3)}）`,
  ).toBeGreaterThanOrEqual(0.6);
});

// ───────────────── F3（R3 风险项）：圆点像素颜色身份 ─────────────────
test('F3（R3）真渲染圆点像素色值必须等于标记 store 色值（买红 / 卖绿）', async ({ page }) => {
  await openRunSettled(page, RUN_A);
  const geom = await paneGeom(page);
  const paneW = geom.pane?.width ?? geom.w;
  const { rows } = await markers(page, Math.round(paneW));
  const inPane = rows.filter((r) => r.x >= 2 && r.x <= paneW - 2 && r.y >= 6 && r.y <= 200);
  expect(inPane.length, '完全落在画布内的标记必须 > 0').toBeGreaterThan(0);
  const samples = await samplePixels(
    page,
    inPane.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) })),
    1,
  );
  const recs = inPane.map((m, i) => {
    const s = samples[i]!;
    const want = hexToRgb(m.color);
    // 逐图层判定（canvas 叠放顺序不影响「某图层确实在该位置画了该色值」这件事）：
    //  - `bestMatch`：9 像素 3×3 邻域内匹配 store 色值的**最大**像素数（取最佳图层）；
    //  - `centerExact`：圆心像素本身是否等于 store 色值（指标线/MA 恰好压在圆心上时会为 false ⇒ 见 aggregate 判据）。
    const perLayer = s.layers.map((l) => ({
      ci: l.ci,
      center: [l.center[0], l.center[1], l.center[2]] as Rgb,
      centerDelta: dist([l.center[0]!, l.center[1]!, l.center[2]!] as Rgb, want),
      match: l.patch.filter(([r, g, b, a]) => a! >= 200 && dist([r!, g!, b!] as Rgb, want) <= 10).length,
      total: l.patch.length,
    }));
    const best = perLayer.reduce<null | (typeof perLayer)[number]>((acc, c) => (acc == null || c.match > acc.match ? c : acc), null);
    const exact = perLayer.find((l) => l.centerDelta <= 10) ?? null;
    return {
      key: m.key,
      color: m.color,
      label: m.label,
      x: Math.round(m.x),
      y: Math.round(m.y),
      layers: s.layers.length,
      firstOpaque: s.top ? [s.top[0], s.top[1], s.top[2]] : null,
      centerExact: exact != null,
      hitLayer: (exact ?? best)?.ci ?? null,
      hitCenter: (exact ?? best)?.center ?? null,
      hitDelta: (exact ?? best)?.centerDelta ?? null,
      bestMatch: best?.match ?? 0,
      bestTotal: best?.total ?? 0,
      bestCenter: best?.center ?? null,
    };
  });
  const buys = recs.filter((r) => r.color === '#ff5c6c');
  const sells = recs.filter((r) => r.color === '#00e0a4');
  writeJson('f3_dot_pixels', {
    paneW,
    paneContainerW: geom.w,
    pane: geom.pane,
    count: recs.length,
    buys: buys.length,
    sells: sells.length,
    recs,
  });

  expect(buys.length, '必须至少采样到一笔买入标记（否则用例空绿）').toBeGreaterThan(0);
  expect(sells.length, '必须至少采样到一笔卖出标记（ForceClose；否则「卖绿」不可证）').toBeGreaterThan(0);
  // 逐标记像素判据（**两档**，对指标线压在圆心上的情形有容差但仍有牙）：
  //  档 1：圆心像素**逐像素等于** store 色值（Δmax ≤ 10）；
  //  档 2：圆心像素属该标记的**色相族**（买 r 主导 / 卖 g 主导；抗混合/抗锯齿）。
  // 任一档成立即通过；两档都不成立 ⇒ 该位置没有按该色值画过东西 ⇒ 红。
  const byKey = new Map(recs.map((r) => [r.key, r]));
  for (const r of recs) {
    const probe = r.hitCenter as Rgb | null;
    const hueOk = probe != null && (r.color === '#00e0a4' ? isGreenInk(probe) : isRedInk(probe));
    expect(
      r.centerExact || hueOk,
      `标记 ${r.key}（store 色 ${r.color}）：圆心像素既不等于该色值也不属其色相族（实测 ${JSON.stringify(probe)}）；` +
        `全部读数落盘 f3_dot_pixels.json`,
    ).toBe(true);
  }
  const exactCount = recs.filter((r) => r.centerExact).length;
  const outliers = recs.filter((r) => !r.centerExact).map((r) => r.key);
  expect(
    exactCount / recs.length,
    `圆心像素**逐像素相等**于 store 色值的标记占比须 ≥ 0.75（实测 ${exactCount}/${recs.length}；逐像素偏离者=${JSON.stringify(outliers)}，` +
      `偏离原因 = 指标线/MA 压在圆心上造成的混合色，已逐条落盘）`,
  ).toBeGreaterThanOrEqual(0.75);
  // 色相身份逐条（买红 / 卖绿）：档 1 成立的标记必须逐条为对应色相
  for (const b of buys) if (b.centerExact) expect(isRedInk(b.hitCenter as Rgb), `买入圆点须为红相 ${JSON.stringify(b.hitCenter)}`).toBe(true);
  for (const s of sells) if (s.centerExact) expect(isGreenInk(s.hitCenter as Rgb), `卖出圆点须为绿相 ${JSON.stringify(s.hitCenter)}`).toBe(true);
  expect(buys.filter((b) => byKey.get(b.key)!.centerExact).length, '买入标记逐像素样本数须 ≥ 1').toBeGreaterThan(0);
  expect(sells.filter((s) => byKey.get(s.key)!.centerExact).length, '卖出标记逐像素样本数须 ≥ 1').toBeGreaterThan(0);

  // 止损橙（#fb923c）当下不可测：现网 run 的 /fills 无 `reason=StopTrigger`（只有 Policy/ForceClose）
  // ⇒ 无橙色圆点可渲染。颜色身份由「store 侧映射单测（adr028LayoutFix.test.ts R3）」+「本用例证明
  // 「渲染 ink == store 色值」」两段合成；若未来出现 StopTrigger 数据，复验口径 = 同法采样该标记圆心，
  // 色值须落于 #fb923c ± 10。
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/fills?limit=5000`);
  const fillsJson = (await fillsResp.json()) as { fills?: Array<{ reason?: string }> };
  const reasons: Record<string, number> = {};
  for (const f of fillsJson.fills ?? []) reasons[f.reason ?? '?'] = (reasons[f.reason ?? '?'] ?? 0) + 1;
  writeJson('f3_stop_reasons', { run: RUN_A, reasons });
  expect(reasons['StopTrigger'] ?? 0, '本 run 无 StopTrigger ⇒ 止损橙圆点无样本（已在报告中披露）').toBe(0);
});
