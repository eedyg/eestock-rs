/**
 * ADR-028 §2.4b（D4.1）**复验二轮（解除冻结）**——R1 / R2 / R3 独立复验规格（tester 车道）。
 *
 * 与修复方规格 `adr028-features-fix.e2e.ts` 的独立性：
 *  1. **不引用修复方的读数/截图为判据**：全部在自建视口、自建合成位图上重算；
 *  2. 像素读法**不同**：修复方逐 canvas 图层 `getImageData`；本规格先把同容器内各 canvas **按 DOM
 *     偏移/缩放合成**成「屏幕真实可见」的位图再读数，另落盘 PNG 供离线 PIL 复算交叉核对；
 *  3. **R1 的完整性判据不依赖修复方的字宽常量**：
 *     - 用 init script **记录渲染器自己的 `ctx.font` / `ctx.textAlign` / `fillText` 锚点**（测试侧仪表，
 *       不改生产代码）⇒ 期望文本宽度 = 页面内 `ctx.measureText(标签, 渲染器真实 font)`；
 *     - 测定带由「渲染器锚点 + measureText 宽」导出（不引用 `FILL_LABEL_CW_PX` 等常量），
 *       判据 = 实测 ink 跨度 / 期望宽度 + 列覆盖率 ⇒ 被裁掉的标签必然不达标；
 *  4. **R2** 同时给**源码侧**（Node 读 `.tsx`：去注释后检查 UI 文本 / 联合类型 / 分支守卫）与
 *     **产物侧**（被服务 bundle 文本搜索，且要求对照串必须命中，证明检索路径有效）证据；
 *     并复跑「loading 期 L2 是否可达」验证「删分支」的依据；
 *  5. **R3** 用合成位图逐圆点读**圆心 + 3×3 邻域**，按**四档**（圆心精确 / 圆心近邻 / 3×3 主导色 /
 *     与已知覆盖层的混合复原）判定像素与「成交侧别 ⇒ 颜色」映射（映射同时用 `/fills` 事实源交叉）；
 *     止损橙按**全库 `reason=StopTrigger` 计数**判定「可测 / 不可测」。
 *
 * 真身：`:8081`（**主机进程** `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，`static_dir=./web/dist`）。
 * 运行（不起 vite preview；对线上静态产物）：
 *   cd web && E2E_BASE_URL=http://localhost:8081 \
 *     npx playwright test e2e/adr028-features-verify2.e2e.ts --workers=1 --retries=0 --reporter=list
 * 变异反证（本规格对变异构建必须红）：
 *   cd web && npx vite build --outDir dist-mut && VITE_PROXY_TARGET=http://localhost:8081 \
 *     npx vite preview --outDir dist-mut --port 4175 &
 *   E2E_BASE_URL=http://localhost:4175 npx playwright test e2e/adr028-features-verify2.e2e.ts -g "@mut" --retries=0
 * 产物：`ADR028V2_OUT`（默认 tester/evidence/20260920_adr028_features_verify2/raw）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028V2_OUT ?? resolve(REPO, 'tester/evidence/20260920_adr028_features_verify2/raw');

/** run A：rt_seq=1 的 44 笔；**末根 bar**（bar_index=423，ts=1789660800）含 2 笔（下标 42=Buy / 43=Sell）。 */
const RUN_A = process.env.ADR028V2_RUN_A ?? 'sr_1789865219068_000001';
const RT_A = Number(process.env.ADR028V2_RT_A ?? '1');
/** 0-based 成交下标（与 L2 行号、fillKey 同名口径一致：key = `${rt}:${idx}`）。 */
const IDX_LAST_BUY = Number(process.env.ADR028V2_IDX_LAST_BUY ?? '42');
const IDX_LAST_SELL = Number(process.env.ADR028V2_IDX_LAST_SELL ?? '43');
/** run B：目标笔居中（两侧都有 bar ⇒ 标签有右侧绘制空间）——R1 的**对照样本**。 */
const RUN_B = process.env.ADR028V2_RUN_B ?? 'sr_1789832477006_000002';
const RT_B = Number(process.env.ADR028V2_RT_B ?? '1');
const IDX_B = Number(process.env.ADR028V2_IDX_B ?? '1');
/** 高亮存活时长（与实现 `KlineChart.HIGHLIGHT_DURATION_MS` 同口径；仅用于「等高亮散去再测像素」）。 */
const HL_MS = 3000;
/** 成交侧别 ⇒ 颜色（口径：`reason==='StopTrigger'` ⇒ 橙；否则 Buy ⇒ 红 / Sell ⇒ 绿）。 */
const COLOR_BUY = '#ff5c6c';
const COLOR_SELL = '#00e0a4';
const COLOR_STOP = '#fb923c';
/** 已知「可能覆盖圆点」的层色（取自实现模板，用于混合复原判定）：标签底色 / 面板底色 / 高亮白描边。 */
const COVER_COLORS: Array<[number, number, number]> = [
  [9, 13, 24],
  [11, 15, 26],
  [255, 255, 255],
];

/**
 * 测试侧仪表（**不改生产代码**）：① 捕获真图表实例；② 记录渲染器自己的 `font` / `textAlign` /
 * `fillText` 锚点（按文本去重，后写覆盖）——供 R1 用「渲染器真实字体」度量期望文本宽度。
 */
const PAGE_CAPTURE = `
  (() => {
    const w = window;
    w.__wbCharts = [];
    w.__wbTexts = {};
    const orig = Map.prototype.set;
    Map.prototype.set = function (k, v) {
      try {
        if (v && typeof v === 'object' && typeof v.convertToPixel === 'function' && typeof v.getDataList === 'function') {
          w.__wbCharts.push(v);
        }
      } catch {}
      return orig.call(this, k, v);
    };
    try {
      const proto = CanvasRenderingContext2D.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'font');
      if (d && d.get && d.set) {
        Object.defineProperty(proto, 'font', {
          configurable: true,
          get() { return d.get.call(this); },
          set(v) { try { this.__wbFont = v; } catch {} return d.set.call(this, v); },
        });
      }
      const ft = proto.fillText;
      proto.fillText = function (text, x, y) {
        try {
          const t = String(text);
          if (t.length > 0 && t.length <= 64) {
            const m = w.__wbTexts;
            m[t] = { text: t, font: this.__wbFont || '', align: this.textAlign, x: x, y: y, n: (m[t] ? m[t].n : 0) + 1 };
          }
        } catch {}
        return ft.apply(this, arguments);
      };
    } catch {}
  })();
`;

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
}
/**
 * 「与已知覆盖层的线性混合复原」：给定观测像素与期望色，若存在 α∈(0,1) 与覆盖色 C 使
 * `px ≈ α·C + (1-α)·期望色`（残差 ≤ 12），则判该像素 = 期望色的**被覆盖**形态。
 * 反假绿：把期望色换成异色族（如绿↔红）时该判定必然不成立。
 */
function blendAttribution(
  px: ArrayLike<number>,
  expectRgb: [number, number, number],
): { ok: boolean; alpha?: number; cover?: [number, number, number]; residual?: number } {
  let best: { ok: boolean; alpha?: number; cover?: [number, number, number]; residual?: number } = { ok: false };
  let bestRes = Infinity;
  for (const c of COVER_COLORS) {
    for (let a = 0.05; a <= 0.95; a += 0.01) {
      const pred = [a * c[0] + (1 - a) * expectRgb[0], a * c[1] + (1 - a) * expectRgb[1], a * c[2] + (1 - a) * expectRgb[2]];
      const res = maxAbsDiff(px, pred);
      if (res < bestRes) {
        bestRes = res;
        best = { ok: res <= 12, alpha: Number(a.toFixed(2)), cover: c, residual: Number(res.toFixed(1)) };
      }
    }
  }
  return best;
}

/** 打开工作台 + 选中 run + 等初始装载落定。 */
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

/** L2 跳转（行号 = 0-based 成交下标）+ 等窗口生效。 */
async function jumpL2(page: Page, rt: number, idx: number): Promise<void> {
  await page.getByTestId(`wb-rt-detail-${rt}`).click();
  const row = page.getByTestId(`wb-l2-row-${rt}-${idx}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.getByTestId(`wb-l2-jump-${rt}-${idx}`).click();
  await expect
    .poll(async () => page.getByTestId('kline-chart').getAttribute('data-highlight-key'), { timeout: 8000 })
    .toBe(`${rt}:${idx}`);
  await page.waitForTimeout(700);
}

type CanvasMeta = { ox: number; oy: number; cw: number; ch: number; dw: number; dh: number };
type DotDump = {
  ok: boolean;
  canvases: CanvasMeta[];
  host: { w: number; h: number };
  dots: Array<{ key: string; stack: number; color: string; label: string; ts: number; price: number; x: number; y: number }>;
};

/** 真图表 store：所有 `fillDot` 的 (key/stack/color/label/ts/price) + 渲染像素坐标 + canvas 几何。 */
async function dotsDump(page: Page): Promise<DotDump> {
  return page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return { ok: false } as unknown as never;
    const chart = cands[0]!;
    const kl = document.querySelector('[data-testid="kline-chart"]')!;
    const kr = kl.getBoundingClientRect();
    const canvases = Array.from(kl.querySelectorAll('canvas')).map((c) => {
      const cr = c.getBoundingClientRect();
      return {
        ox: Math.round(cr.x - kr.x),
        oy: Math.round(cr.y - kr.y),
        cw: c.width,
        ch: c.height,
        dw: Math.round(cr.width),
        dh: Math.round(cr.height),
      };
    });
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    const dots = all.map((o) => {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
        { paneId: 'candle_pane' },
      );
      const stack = Number(ext['stackIndex'] ?? 0);
      return {
        key: String(ext['fillKey'] ?? ''),
        stack,
        color: String(ext['color'] ?? ''),
        label: String(ext['label'] ?? ''),
        ts: Number(pts[0]!.timestamp),
        price: Number(pts[0]!.value),
        x: Number(p.x ?? NaN),
        y: Number(p.y ?? NaN) + stack * 12,
      };
    });
    return { ok: true, canvases, host: { w: Math.round(kr.width), h: Math.round(kr.height) }, dots } as unknown as never;
  }) as Promise<DotDump>;
}

type InkBox = { x0: number; x1: number; y0: number; y1: number; hex: string };
type ReadPoint = { id: string; x: number; y: number };
type AnalyzeReq = {
  ink?: InkBox[] | null;
  readPoints?: ReadPoint[] | null;
  measureTexts?: Array<{ id: string; text: string; size: number; font: string }> | null;
};
type InkRes = {
  total: number;
  xMin: number;
  xMax: number;
  span: number;
  colsWithInk: number;
  coverage: number;
  maxRun: number;
  cols: Array<[number, number]>;
};
type AnalyzeRes = {
  ok: boolean;
  err?: string;
  host: { w: number; h: number };
  canvases: CanvasMeta[];
  inks: InkRes[] | null;
  points: Array<{
    id: string;
    x: number;
    y: number;
    center: [number, number, number, number] | null;
    n3: Array<[number, number, number, number]>;
    dominant: [number, number, number, number] | null;
  }> | null;
  measures: Array<{ id: string; text: string; width: number; font: string }> | null;
};

/** 合成位图读法（见文件头）。 */
async function analyze(page: Page, req: AnalyzeReq): Promise<AnalyzeRes> {
  return page.evaluate((r) => {
    const kl = document.querySelector('[data-testid="kline-chart"]')!;
    const kr = kl.getBoundingClientRect();
    const W = Math.round(kr.width);
    const H = Math.round(kr.height);
    const canvases = Array.from(kl.querySelectorAll('canvas'));
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const octx = off.getContext('2d')!;
    const cmeta: Array<{ ox: number; oy: number; cw: number; ch: number; dw: number; dh: number }> = [];
    for (const c of canvases) {
      const cr = c.getBoundingClientRect();
      const ox = Math.round(cr.x - kr.x);
      const oy = Math.round(cr.y - kr.y);
      cmeta.push({ ox, oy, cw: c.width, ch: c.height, dw: Math.round(cr.width), dh: Math.round(cr.height) });
      try {
        octx.drawImage(c, ox, oy, Math.round(cr.width), Math.round(cr.height));
      } catch {
        /* 单层失败不阻断（读数会显式偏小，不静默放大） */
      }
    }
    let img: ImageData;
    try {
      img = octx.getImageData(0, 0, W, H);
    } catch (e) {
      return { ok: false, err: String(e), host: { w: W, h: H }, canvases: cmeta } as unknown as never;
    }
    const px = (x: number, y: number): [number, number, number, number] | null => {
      if (x < 0 || y < 0 || x >= W || y >= H) return null;
      const i = (y * W + x) * 4;
      return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
    };

    let inks: AnalyzeRes['inks'] = null;
    if (r.ink) {
      inks = r.ink.map((b) => {
        const hex = b.hex.replace('#', '');
        const er = parseInt(hex.slice(0, 2), 16);
        const eg = parseInt(hex.slice(2, 4), 16);
        const eb = parseInt(hex.slice(4, 6), 16);
        const redish = er > eg;
        const match = (c: [number, number, number, number]): boolean => {
          const [R, G, B] = c;
          return redish ? R > 80 && R - G > 30 && R - B > 20 : G > 80 && G - R > 30 && G - B > 15;
        };
        const cols = new Map<number, number>();
        let total = 0;
        const x0 = Math.max(0, b.x0);
        const x1 = Math.min(W, b.x1);
        for (let x = x0; x < x1; x++) {
          for (let y = Math.max(0, b.y0); y < Math.min(H, b.y1); y++) {
            const c = px(x, y);
            if (c && c[3] >= 200 && match(c)) {
              cols.set(x, (cols.get(x) ?? 0) + 1);
              total += 1;
            }
          }
        }
        const xs = Array.from(cols.keys()).sort((a, b2) => a - b2);
        const span = xs.length ? xs[xs.length - 1]! - xs[0]! + 1 : 0;
        let best = 0;
        let cur = 0;
        for (let x = x0; x < x1; x++) {
          if ((cols.get(x) ?? 0) >= 1) {
            cur += 1;
            if (cur > best) best = cur;
          } else {
            cur = 0;
          }
        }
        return {
          total,
          xMin: xs.length ? xs[0]! : -1,
          xMax: xs.length ? xs[xs.length - 1]! : -1,
          span,
          colsWithInk: xs.length,
          coverage: span ? xs.length / span : 0,
          maxRun: best,
          cols: Array.from(cols.entries()),
        };
      });
    }

    let points: AnalyzeRes['points'] = null;
    if (r.readPoints) {
      points = r.readPoints.map((pt) => {
        const cx = Math.round(pt.x);
        const cy = Math.round(pt.y);
        const n3: Array<[number, number, number, number]> = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const c = px(cx + dx, cy + dy);
            n3.push(c ?? [0, 0, 0, 0]);
          }
        }
        const tally = new Map<string, { c: [number, number, number, number]; n: number }>();
        for (const c of n3) {
          if (c[3] < 200) continue;
          if (c[0] >= 240 && c[1] >= 240 && c[2] >= 240) continue;
          const k = `${c[0]},${c[1]},${c[2]}`;
          const e = tally.get(k);
          if (e) e.n += 1;
          else tally.set(k, { c, n: 1 });
        }
        let dominant: [number, number, number, number] | null = null;
        let bestN = 0;
        for (const v of tally.values()) {
          if (v.n > bestN) {
            bestN = v.n;
            dominant = v.c;
          }
        }
        return { id: pt.id, x: cx, y: cy, center: px(cx, cy), n3, dominant };
      });
    }

    const mctx = document.createElement('canvas').getContext('2d')!;
    const measures = (r.measureTexts ?? []).map((m) => {
      mctx.font = m.font;
      return { id: m.id, text: m.text, width: mctx.measureText(m.text).width, font: mctx.font };
    });

    return { ok: true, host: { w: W, h: H }, canvases: cmeta, inks, points, measures } as unknown as never;
  }, req) as Promise<AnalyzeRes>;
}

/** 渲染器自己画的文本记录（测试侧仪表）。 */
type TextRec = { text: string; font: string; align: string; x: number; y: number; n: number };
async function textRec(page: Page, text: string): Promise<TextRec | null> {
  return page.evaluate((t) => {
    const m = (window as unknown as { __wbTexts?: Record<string, TextRec> }).__wbTexts ?? {};
    return (m[t] ?? null) as never;
  }, text) as Promise<TextRec | null>;
}
async function clearTextRecs(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __wbTexts?: Record<string, unknown> }).__wbTexts = {};
  });
}

/** K 线容器截图（元素裁剪；图片坐标 0,0 == 容器左上角）。 */
async function shotKline(page: Page, name: string): Promise<{ clip: { x: number; y: number; width: number; height: number } }> {
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="kline-chart"]')!;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, vw: window.innerWidth, vh: window.innerHeight };
  });
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const width = Math.max(1, Math.min(Math.round(r.w), r.vw - x));
  const height = Math.max(1, Math.min(Math.round(r.h), r.vh - y));
  await page.screenshot({ path: resolve(OUT, name), clip: { x, y, width, height } });
  return { clip: { x, y, width, height } };
}

/** 点所属 pane（含该点的 canvas；按宽度排除 y 轴条带）。 */
function paneOf(dump: DotDump, d: { x: number; y: number }): CanvasMeta {
  const hit = dump.canvases.find((c) => c.cw > 100 && d.x >= c.ox && d.x < c.ox + c.cw && d.y >= c.oy && d.y < c.oy + c.ch);
  return hit ?? dump.canvases[0]!;
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(PAGE_CAPTURE);
});

// ───────────────────────── V1（R1）末根 bar 标签完整性 ─────────────────────────
test('V1 R1 [@mut] 末根 bar 标签不裁剪：ink 跨度 ≈ 渲染器实测文本宽度，且完整落在 pane 内', async ({ page }) => {
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const fBuy = fills[IDX_LAST_BUY]!;
  const fSell = fills[IDX_LAST_SELL]!;
  expect(fBuy['bar_index'], '目标两笔必须同在**末根** bar').toBe(fSell['bar_index']);
  expect(Number(fBuy['bar_index']), '目标 bar 必须为该 run 末根（右侧无绘制空间）').toBe(
    Math.max(...fills.map((f) => Number(f['bar_index']))),
  );

  await openRunSettled(page, RUN_A);
  await clearTextRecs(page);
  await jumpL2(page, RT_A, IDX_LAST_BUY);
  await page.waitForTimeout(HL_MS + 700); // 等白描边脉冲散去，避免白环污染 ink

  const dump = await dotsDump(page);
  expect(dump.ok, '必须捕获真图表实例').toBe(true);
  const buy = dump.dots.find((d) => d.key === `${RT_A}:${IDX_LAST_BUY}`)!;
  const sell = dump.dots.find((d) => d.key === `${RT_A}:${IDX_LAST_SELL}`)!;
  expect(buy, `末根 bar Buy 标记（key ${RT_A}:${IDX_LAST_BUY}）必须存在`).toBeTruthy();
  expect(sell, `末根 bar Sell 标记（key ${RT_A}:${IDX_LAST_SELL}）必须存在`).toBeTruthy();
  expect(buy.color).toBe(COLOR_BUY);
  expect(sell.color).toBe(COLOR_SELL);

  // 渲染器自报的标签绘制记录（font / textAlign / 锚点）
  const recBuy = await textRec(page, buy.label);
  const recSell = await textRec(page, sell.label);
  expect(recBuy, `渲染器必须真的 fillText 过标签 ${JSON.stringify(buy.label)}`).toBeTruthy();
  expect(recSell, `渲染器必须真的 fillText 过标签 ${JSON.stringify(sell.label)}`).toBeTruthy();

  // 期望文本宽度 = 用渲染器真实 font 度量（不引用实现常量）
  const p1 = await analyze(page, {
    measureTexts: [
      { id: 'buy', text: buy.label, size: 9, font: recBuy!.font },
      { id: 'sell', text: sell.label, size: 9, font: recSell!.font },
    ],
  });
  const expBuyW = p1.measures![0]!.width;
  const expSellW = p1.measures![1]!.width;
  expect(expBuyW, '期望文本宽度必须可测且非退化').toBeGreaterThan(20);
  expect(expSellW, '期望文本宽度必须可测且非退化').toBeGreaterThan(20);

  /**
   * 测定带 = **渲染器自报锚点** + `measureText` 宽（紧贴文本，不漏计相邻圆点/蜡烛），再夹到该 pane 内。
   * 口径说明（仪表可得性）：klinecharts 会把 figure 的 `align` **归一化**后绘制——`/v1` 实测
   * `ctx.textAlign` 恒为 `'left'`，右对齐由「锚点前移一个文本宽度」实现 ⇒ 判据一律用**有效锚点**，
   * 不使用 `ctx.textAlign` 作左/右依据（避免把库的归一化当成实现的方向）。
   */
  const boxFromRec = (rec: TextRec, w: number, color: string, pane: CanvasMeta): InkBox => ({
    x0: Math.max(pane.ox, Math.floor(rec.x) - 1),
    x1: Math.min(pane.ox + pane.cw, Math.ceil(rec.x + w) + 1),
    y0: Math.max(pane.oy, Math.floor(rec.y) - 2),
    y1: Math.min(pane.oy + pane.ch, Math.ceil(rec.y) + 11),
    hex: color,
  });
  const paneBuy = paneOf(dump, buy);
  const paneSell = paneOf(dump, sell);
  const boxBuy = boxFromRec(recBuy!, expBuyW, buy.color, paneBuy);
  const boxSell = boxFromRec(recSell!, expSellW, sell.color, paneSell);
  const p2 = await analyze(page, { ink: [boxBuy, boxSell] });
  const inkBuy = p2.inks![0]!;
  const inkSell = p2.inks![1]!;
  const ratioBuy = inkBuy.span / expBuyW;
  const ratioSell = inkSell.span / expSellW;
  const shot = await shotKline(page, 'v1_last_bar_labels.png');

  // 对照样本（run B 中部 bar：标签画在圆点**右侧**）
  await openRunSettled(page, RUN_B);
  await clearTextRecs(page);
  await jumpL2(page, RT_B, IDX_B);
  await page.waitForTimeout(HL_MS + 700);
  const dumpB = await dotsDump(page);
  const mid = dumpB.dots.find((d) => d.key === `${RT_B}:${IDX_B}`)!;
  const recMid = await textRec(page, mid.label);
  expect(recMid, '对照标签必须被 fillText 过').toBeTruthy();
  const p3 = await analyze(page, { measureTexts: [{ id: 'mid', text: mid.label, size: 9, font: recMid!.font }] });
  const expMidW = p3.measures![0]!.width;
  const paneMid = paneOf(dumpB, mid);
  const boxMid = boxFromRec(recMid!, expMidW, mid.color, paneMid);
  const p4 = await analyze(page, { ink: [boxMid] });
  const inkMid = p4.inks![0]!;
  const ratioMid = inkMid.span / expMidW;

  writeJson('v1_last_bar_label', {
    runA: RUN_A,
    canvases: dump.canvases,
    rects: {
      buy: { key: buy.key, label: buy.label, dot: { x: buy.x, y: buy.y }, pane: paneBuy, rec: recBuy, expWidth: expBuyW, box: boxBuy, ink: inkBuy, ratio: ratioBuy },
      sell: { key: sell.key, label: sell.label, dot: { x: sell.x, y: sell.y }, pane: paneSell, rec: recSell, expWidth: expSellW, box: boxSell, ink: inkSell, ratio: ratioSell },
    },
    controlMid: { run: RUN_B, key: mid.key, label: mid.label, dot: { x: mid.x, y: mid.y }, pane: paneMid, rec: recMid, expWidth: expMidW, box: boxMid, ink: inkMid, ratio: ratioMid },
    shot,
  });

  // ── 判据（Buy：末根 bar，必须翻转/收敛到圆点左侧且完整可读）──
  expect(buy.x, '末根 bar 圆点 x 必须贴近 pane 右缘（本用例才有区分力）').toBeGreaterThan(paneBuy.cw - 25);
  expect(Math.abs(recBuy!.y - buy.y), '标签锚点 y 必须落在圆点附近（≤6px；库按基线换算）').toBeLessThanOrEqual(6);
  // 几何：标签整盒必须落在 pane 内 —— 若仍按旧「恒在右侧」绘制则整盒越出右缘（本判据必红）
  expect(recBuy!.x, '标签左缘必须落在 pane 内').toBeGreaterThanOrEqual(1);
  expect(recBuy!.x + expBuyW, '标签右缘必须落在 pane 内（≤ pane 右缘 -1）').toBeLessThanOrEqual(paneBuy.ox + paneBuy.cw - 1);
  // 方向：有效锚点 + 文本宽 ⇒ 文本右缘必须紧贴圆点左侧（翻转语义；klinecharts 归一化 align，故用有效锚点）
  expect(recBuy!.x + expBuyW, '标签文本右缘必须在圆点左侧（翻转）').toBeLessThan(buy.x);
  expect(
    buy.x - (recBuy!.x + expBuyW),
    `翻转后文本右缘与圆点的间距必须紧凑（≤10px；实测 ${(buy.x - (recBuy!.x + expBuyW)).toFixed(1)}px）`,
  ).toBeLessThanOrEqual(10);
  // 完整性：像素 ink 必须铺满期望文本宽度
  expect(inkBuy.total, 'Buy 标签 ink 必须存在（旧实现右侧绘制 ⇒ 几乎全被裁掉）').toBeGreaterThan(60);
  expect(
    ratioBuy,
    `Buy 标签 ink 跨度 / 渲染器实测文本宽度 必须 ≥ 0.85（实测 ${ratioBuy.toFixed(3)}；期望宽 ${expBuyW.toFixed(1)}px，ink 跨度 ${inkBuy.span}px，墨量 ${inkBuy.total}px）`,
  ).toBeGreaterThanOrEqual(0.85);
  expect(ratioBuy, 'ink 跨度不得明显超出文本宽度（防跨元素误计）').toBeLessThanOrEqual(1.3);
  expect(inkBuy.coverage, `标签墨列覆盖率必须 ≥ 0.5（实测 ${inkBuy.coverage.toFixed(3)}）`).toBeGreaterThanOrEqual(0.5);
  expect(inkBuy.xMax, 'Buy 标签 ink 右缘不得侵入圆点区域（全在圆点左侧）').toBeLessThan(Math.round(buy.x));

  // ── 判据（Sell：同 bar 第二笔）──
  expect(recSell!.x, 'Sell 标签左缘必须落在 pane 内').toBeGreaterThanOrEqual(1);
  expect(recSell!.x + expSellW, 'Sell 标签右缘必须落在 pane 内').toBeLessThanOrEqual(paneSell.ox + paneSell.cw - 1);
  expect(recSell!.x + expSellW, 'Sell 标签文本右缘必须在圆点左侧（翻转）').toBeLessThan(sell.x);
  expect(sell.x - (recSell!.x + expSellW), '翻转后间距必须紧凑（≤10px）').toBeLessThanOrEqual(10);
  expect(inkSell.total, 'Sell 标签 ink 必须存在').toBeGreaterThan(60);
  expect(ratioSell, `Sell 标签 ink 跨度 / 渲染器实测文本宽度 必须 ≥ 0.85（实测 ${ratioSell.toFixed(3)}）`).toBeGreaterThanOrEqual(0.85);
  expect(ratioSell).toBeLessThanOrEqual(1.3);
  expect(inkSell.coverage, `Sell 标签墨列覆盖率必须 ≥ 0.5（实测 ${inkSell.coverage.toFixed(3)}）`).toBeGreaterThanOrEqual(0.5);
  expect(inkSell.xMax, 'Sell 标签 ink 右缘不得侵入圆点区域').toBeLessThan(Math.round(sell.x));

  // ── 判据（对照：中部 bar 仍为右侧绘制 = 既有行为不变，且同指标达标 ⇒ 阈值可达）──
  expect(recMid!.x, '对照（中部 bar）标签锚点必须在圆点右侧（未翻转）').toBeGreaterThan(mid.x);
  expect(recMid!.x - mid.x, '对照标签与圆点间距必须紧凑（≤10px）').toBeLessThanOrEqual(10);
  expect(ratioMid, `对照同指标必须 ≥ 0.85（实测 ${ratioMid.toFixed(3)}）`).toBeGreaterThanOrEqual(0.85);
  expect(inkMid.coverage, `对照墨列覆盖率必须 ≥ 0.5（实测 ${inkMid.coverage.toFixed(3)}）`).toBeGreaterThanOrEqual(0.5);
  expect(mid.x, '对照圆点必须离 pane 右缘足够远').toBeLessThan(paneMid.cw - 40);
});

// ───────────────────────── V2（R2）不可达分支与承诺文案的处置 ─────────────────────────
test('V2 R2 处置确认：源码(去注释) + 产物两侧均无「loading」高亮态与「自动补齐」承诺；loading 期 L2 不可达', async ({ page }) => {
  const srcPath = resolve(REPO, 'web/src/features/workbench/KlineResultChart.tsx');
  const src = readFileSync(srcPath, 'utf8');
  /** 去掉注释后再查（本波实现刻意在注释里**引用**旧文案说明删除理由 ⇒ 注释不算 UI 文案）。 */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
  const literals = (code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []).join('\n');
  const unionLine = /const highlightState:\s*([^=]+)=/.exec(code)?.[1] ?? '';
  const srcChecks = {
    srcPath,
    unionLine: unionLine.trim(),
    hasLoadingInUnion: /'loading'/.test(unionLine),
    hasAutoFillPromiseInCode: code.includes('自动补齐'),
    hasReadyPhraseInCode: code.includes('标记就绪后'),
    hasAutoFillPromiseInLiterals: literals.includes('自动补齐'),
    hasReadyPhraseInLiterals: literals.includes('标记就绪后'),
    hasLoadingNoteInLiterals: literals.includes('标记不可得'),
    hasLoadingGuard: /fills\.loading\s*&&\s*fills\.rows\.length\s*===\s*0/.test(code),
    keepStates: ['ok', 'unrecorded', 'unmatched'].map((s) => ({ s, present: code.includes(`'${s}'`) })),
    commentOnlyMentions: (src.match(/(^|\s)\*?[^\n]*自动补齐[^\n]*/g) ?? []).length,
  };

  const html = await (await page.request.get('/')).text();
  const url = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)![1]!;
  const bundle = await (await page.request.get(url)).text();
  const artChecks = {
    url,
    bytes: bundle.length,
    hasAutoFillPromise: bundle.includes('自动补齐'),
    hasReadyPhrase: bundle.includes('标记就绪后'),
    hasLoadingNote: bundle.includes('标记不可得'),
    controlUnmatched: bundle.includes('未在 K 线标记中找到目标成交'),
    controlUnrecorded: bundle.includes('该运行未记录成交明细'),
    controlOkNote: bundle.includes('已高亮目标成交'),
  };

  await openRunSettled(page, RUN_A);
  await jumpL2(page, RT_A, IDX_LAST_BUY);
  const noteCount = await page.getByTestId('wb-jump-highlight-note').count();
  const noteState = noteCount > 0 ? await page.getByTestId('wb-jump-highlight-note').getAttribute('data-state') : '';
  const noteText = noteCount > 0 ? ((await page.getByTestId('wb-jump-highlight-note').textContent()) ?? '') : '';

  // 可达性复核：成交明细未到位期间，L2（高亮的唯一触发面）是否可达？
  const realFills = await (await page.request.get(`/api/workbench/runs/${RUN_A}/fills?limit=5000`)).json();
  await page.route('**/api/workbench/runs/*/fills*', async (route) => {
    await new Promise((r) => setTimeout(r, 12000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(realFills) });
  });
  await openRunSettled(page, RUN_A);
  const during = {
    fillsNote: (await page.getByTestId('wb-fills-note').textContent()) ?? '',
    markers: await page.getByTestId('kline-chart').getAttribute('data-marker-overlays'),
    noteCount: await page.getByTestId('wb-jump-highlight-note').count(),
    l2RowCount: await page.getByTestId(`wb-l2-row-${RT_A}-${IDX_LAST_BUY}`).count(),
  };

  writeJson('v2_r2_disposition', { srcChecks, artChecks, runtime: { noteCount, noteState, noteText }, during });

  // ── 源码侧（去注释）──
  expect(srcChecks.hasLoadingInUnion, '`highlightState` 联合类型不得再含 `loading`').toBe(false);
  expect(srcChecks.hasAutoFillPromiseInLiterals, '源码字符串字面量不得再含「自动补齐」承诺文案').toBe(false);
  expect(srcChecks.hasReadyPhraseInLiterals, '源码字符串字面量不得再含「标记就绪后」承诺文案').toBe(false);
  expect(srcChecks.hasLoadingNoteInLiterals, '源码字符串字面量不得再含「标记不可得」承诺文案').toBe(false);
  expect(srcChecks.hasLoadingGuard, '源码不得再含 `fills.loading && rows===0` 的 loading 分支').toBe(false);
  expect(
    srcChecks.keepStates.every((s) => s.present),
    '可达三态（ok/unrecorded/unmatched）必须保留',
  ).toBe(true);

  // ── 产物侧 ──
  expect(artChecks.hasAutoFillPromise, '被服务 bundle 不得含「自动补齐」承诺文案').toBe(false);
  expect(artChecks.hasReadyPhrase, '被服务 bundle 不得含「标记就绪后」承诺文案').toBe(false);
  expect(artChecks.hasLoadingNote, '被服务 bundle 不得含「标记不可得」承诺文案').toBe(false);
  expect(
    artChecks.controlUnmatched && artChecks.controlUnrecorded && artChecks.controlOkNote,
    '对照串必须命中（证明检索路径有效，缺席断言才不是恒真）',
  ).toBe(true);

  // ── 运行期 ──
  expect(noteCount, 'ok 态高亮提示必须存在').toBe(1);
  expect(noteState, 'ok 态 data-state').toBe('ok');
  expect(noteText, 'ok 态文案不得含承诺语句').not.toContain('自动补齐');
  expect(during.fillsNote, 'loading 期必须显式披露「加载中」（保留的真披露）').toContain('加载中');
  expect(during.markers, 'loading 期标记数为 0').toBe('0');
  expect(during.l2RowCount, 'loading 期 L2 行不可达 ⇒ 无法设置 highlight ⇒ loading 分支 UI 不可达').toBe(0);
  expect(during.noteCount, 'loading 期不存在高亮提示（分支不可达的直接证据）').toBe(0);
});

// ───────────────────────── V3（R3）圆点颜色身份 ─────────────────────────
test('V3 R3 圆点颜色身份：合成位图逐圆点读圆心/3×3，与 /fills 侧别⇒颜色映射交叉；止损橙按数据事实判可测性', async ({ page }) => {
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fillsAll = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const expectColorOf = (i: number): string => {
    const f = fillsAll[i]!;
    if (String(f['reason']) === 'StopTrigger') return COLOR_STOP;
    return String(f['side']) === 'Buy' ? COLOR_BUY : COLOR_SELL;
  };

  await openRunSettled(page, RUN_A);
  await jumpL2(page, RT_A, IDX_LAST_BUY);
  await page.waitForTimeout(HL_MS + 700); // 常态圆点（无白环）下读色

  const dump = await dotsDump(page);
  expect(dump.ok, '必须捕获真图表实例').toBe(true);
  const pane = paneOf(dump, { x: 0, y: 0 });
  const inPane = dump.dots.filter((d) => d.x >= 3 && d.x <= pane.cw - 3 && d.y >= 3 && d.y <= pane.ch - 3);

  const res = await analyze(page, { readPoints: inPane.map((d) => ({ id: d.key, x: d.x, y: d.y })) });
  const shot = await shotKline(page, 'v3_dot_pixels.png');

  const records = inPane.map((d, i) => {
    const p = res.points![i]!;
    const idx = Number(d.key.split(':')[1] ?? '-1');
    const expectHex = idx >= 0 && idx < fillsAll.length ? expectColorOf(idx) : '';
    const expectRgb = expectHex ? parseHex(expectHex) : ([0, 0, 0] as [number, number, number]);
    const st = parseHex(d.color);
    const c = p.center ?? ([0, 0, 0, 0] as [number, number, number, number]);
    const dExpectCenter = p.center ? maxAbsDiff(c, expectRgb) : 9999;
    const dStoreCenter = maxAbsDiff(c, st);
    const dStoreDominant = p.dominant ? maxAbsDiff(p.dominant!, st) : 9999;
    const blend = p.center ? blendAttribution(c, expectRgb) : { ok: false };
    const tier = dExpectCenter <= 10
      ? 'exact'
      : dExpectCenter <= 25
        ? 'near'
        : dStoreCenter <= 10
          ? 'store-exact'
          : dStoreDominant <= 25
            ? 'dominant'
            : blend.ok
              ? 'blend'
              : 'FAIL';
    return {
      key: d.key,
      idx,
      stack: d.stack,
      label: d.label,
      storeColor: d.color,
      expectColor: expectHex,
      sideFromApi: String(fillsAll[idx]?.['side'] ?? ''),
      reasonFromApi: String(fillsAll[idx]?.['reason'] ?? ''),
      dot: { x: d.x, y: d.y },
      centerPixel: c,
      dominantPixel: p.dominant,
      neon3: p.n3,
      dExpectCenter,
      dStoreCenter,
      dStoreDominant,
      blend,
      tier,
      storeMatchesApiSide: expectHex !== '' && d.color.toLowerCase() === expectHex.toLowerCase(),
    };
  });

  const exact = records.filter((r) => r.tier === 'exact').length;
  const passTier = records.filter((r) => r.tier !== 'FAIL').length;
  const sideMatch = records.filter((r) => r.storeMatchesApiSide).length;
  const buyN = records.filter((r) => r.expectColor === COLOR_BUY).length;
  const sellN = records.filter((r) => r.expectColor === COLOR_SELL).length;

  const src = readFileSync(resolve(REPO, 'web/src/features/workbench/KlineResultChart.tsx'), 'utf8');
  const srcMapping = {
    buy: src.includes("const COLOR_BUY = '#ff5c6c'"),
    sell: src.includes("const COLOR_SELL = '#00e0a4'"),
    stop: src.includes("const COLOR_STOP = '#fb923c'"),
    stopBranch: /stop\s*\?\s*COLOR_STOP/.test(src),
  };

  // 全库 StopTrigger 计数（决定「止损橙」可测性）
  const runs = (await (await page.request.get('/api/workbench/runs')).json()) as Array<{ id: string }>;
  const reasons: Record<string, number> = {};
  let fillsSeen = 0;
  const perRun: Array<{ run: string; fills: number; reasons: Record<string, number> }> = [];
  for (const r of runs.slice(0, 12)) {
    const j = (await (await page.request.get(`/api/workbench/runs/${r.id}/fills?limit=5000`)).json()) as {
      fills?: Array<{ reason?: string }>;
    };
    const rr: Record<string, number> = {};
    for (const f of j.fills ?? []) {
      const k = String(f.reason ?? '(null)');
      rr[k] = (rr[k] ?? 0) + 1;
      reasons[k] = (reasons[k] ?? 0) + 1;
      fillsSeen += 1;
    }
    perRun.push({ run: r.id, fills: (j.fills ?? []).length, reasons: rr });
  }
  const stopDots = records.filter((r) => r.expectColor === COLOR_STOP);

  writeJson('v3_dot_pixels', {
    run: RUN_A,
    pane,
    canvases: dump.canvases,
    sampled: inPane.length,
    totalDots: dump.dots.length,
    tiers: {
      exact,
      near: records.filter((r) => r.tier === 'near').length,
      storeExact: records.filter((r) => r.tier === 'store-exact').length,
      dominant: records.filter((r) => r.tier === 'dominant').length,
      blend: records.filter((r) => r.tier === 'blend').length,
      fail: records.filter((r) => r.tier === 'FAIL').length,
    },
    exactRatio: inPane.length ? exact / inPane.length : 0,
    passTier,
    sideMatch,
    buyN,
    sellN,
    stopDots: stopDots.length,
    records,
    srcMapping,
    stopTrigger: { fillsSeen, reasons, perRun, stopTriggerCount: reasons['StopTrigger'] ?? 0 },
    shot,
  });

  // ── 判据 ──
  expect(inPane.length, '落在画布内的圆点样本数必须足够（≥ 10）').toBeGreaterThanOrEqual(10);
  expect(buyN, '买入样本 ≥ 5（防空绿）').toBeGreaterThanOrEqual(5);
  expect(sellN, '卖出样本 ≥ 1（防单侧假绿）').toBeGreaterThanOrEqual(1);
  expect(
    sideMatch,
    `store 色值必须与 /fills 事实源推导的侧别颜色逐条一致（实测 ${sideMatch}/${inPane.length}）`,
  ).toBe(inPane.length);
  expect(exact, `圆心像素逐像素等于侧别颜色（Δ=0）的条数必须 ≥ 0.75·样本（实测 ${exact}/${inPane.length}）`).toBeGreaterThanOrEqual(
    Math.ceil(0.75 * inPane.length),
  );
  expect(
    passTier,
    `每个圆点必须落在 exact/near/store-exact/dominant/blend 之一（FAIL=${records
      .filter((r) => r.tier === 'FAIL')
      .map((r) => `${r.key}:${r.centerPixel.join(',')}`)
      .join(' ')}）`,
  ).toBe(inPane.length);
  expect(
    srcMapping.buy && srcMapping.sell && srcMapping.stop && srcMapping.stopBranch,
    '源码色值映射必须齐备（含 StopTrigger ⇒ 橙）',
  ).toBe(true);
  // 止损橙：有样本 ⇒ 必须逐条达标；无样本 ⇒ 记录不可测（判据不因数据缺席而假绿，由报告的「未做项」登记）
  if (stopDots.length > 0) {
    expect(stopDots.every((r) => r.tier !== 'FAIL'), '止损橙圆点必须逐条达标').toBe(true);
    expect(stopDots.every((r) => r.storeColor === COLOR_STOP), '止损橙 store 色值').toBe(true);
  }
});
