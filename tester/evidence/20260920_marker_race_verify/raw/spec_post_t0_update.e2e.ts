/**
 * ADR-028 §2.4b（D4.1）「买卖点醒目化 + L2 跳转 focus/精确到笔高亮/曲线竖线」——**tester 独立复验规格**（闸门 3）。
 *
 * 与实现方规格 `adr028-fill-focus-highlight.e2e.ts` 的区别（独立性）：
 *  1. **不引用实现方的截图/结论**：全部断言在自建视口/自建截图/自绘像素上重算；
 *  2. **像素级证据采用两个互相独立的口径**：
 *     ① 页面侧读 canvas `getImageData`（多 canvas 合成 → 白簇连通分量 + 标签 ink run）；
 *     ② `page.screenshot({clip})` 落盘 PNG，离线 PIL 复算（`raw/pixel_analyze.py`）。
 *  3. **判据比实现方更严**：focus 判据同时要求 K 线容器整体落在**视口**内（不只是滚动容器内）；
 *     高亮判据要求「白簇**恰 1 个**且质心落在被点那一笔的**堆叠位置**（±3px）」——
 *     按 bar 粗定位（M1 变异）或高亮 overlay 被静默丢弃（M2 变异）都会红；
 *  4. 三态提示用 `page.route` **注入数据面**（不改生产代码）构造 unmatched / unrecorded / loading。
 *  5. **2026-09-20（T4 flaky 取证后加固）**：`openRunSettled` 不再用 `waitForTimeout(2500)`「等落定」，改为
 *     **显式就绪判据**（图表 K 线 `dataList` 非空 + `data-marker-overlays` == 已加载成交笔数）；T4 另要求
 *     **写窗真身回执**（`wb-window-probe` rev 到位）后才读几何（见 `settleJump(page,{requireReceipt:true})`）。
 *     取证：`tester/evidence/20260920_t4_flaky_rootcause/report.md`。
 *
 * 真身：`:8081`（**主机进程** `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，`static_dir=./web/dist`，
 * 进程 PID 见 `tester/evidence/20260920_adr028_features_verify2/report.md` §1；`dist/index.html` 引用
 * `assets/index-BY728MHs.js`（sha256 见 T0 锚点常量，规格维护者 2026-09-20 复验时更新））。
 * 运行（对线上静态产物，**不起 vite preview**）：
 *   cd web && E2E_BASE_URL=http://localhost:8081 \
 *     npx playwright test e2e/adr028-features-verify.e2e.ts --reporter=list --retries=0
 * 变异反证（同一规格对变异构建必须红）：
 *   cd web && npx vite build --outDir dist-mut && VITE_PROXY_TARGET=http://localhost:8081 \
 *     npx vite preview --outDir dist-mut --port 4175 &
 *   E2E_BASE_URL=http://localhost:4175 npx playwright test e2e/adr028-features-verify.e2e.ts -g "mut" --retries=0
 * 产物：`ADR028V_OUT`（默认 tester/evidence/20260920_adr028_features_verify/raw）。
 */
import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028V_OUT ?? resolve(REPO, 'tester/evidence/20260920_adr028_features_verify/raw');

/** run A：rt_seq=1 的 44 笔中第 42/43 笔**同 bar**（bar_index=423，ts=1789660800）。 */
/** 本波真身 bundle 锚点（2026-09-20 复验解除冻结）：
 *  :8081 由 `static_dir=./web/dist` 静态托管 —— `index.html` 引用的 `assets/index-*.js` 必须与 `web/dist` 内
 *  同名文件**逐字节一致**，且 sha256 == 本常量。构建产物合法变更时，**须由规格维护者显式更新本常量**
 *  （不得放宽为「任意 bundle」或加 env 旁路）。 */
const EXPECT_BUNDLE_NAME = 'index-BZMgzJCS.js';
const EXPECT_BUNDLE_SHA256 = '56ef46526414735c93f58f159a2659f2a4cfc68d13f47244571d5154b53db13b';

const RUN_A = process.env.ADR028V_RUN_A ?? 'sr_1789865219068_000001';
const RT_A = Number(process.env.ADR028V_RT_A ?? '1');
const FILL_A = Number(process.env.ADR028V_FILL_A ?? '42');
const FILL_B = Number(process.env.ADR028V_FILL_B ?? '43');
/** 第三次跳转目标（ts 必须与 FILL_A 不同，用于「竖线随下一次跳转更新」）。 */
const FILL_C = Number(process.env.ADR028V_FILL_C ?? '41');
/** run B：目标笔居中（两侧都有 bar ⇒ 标签有右侧绘制空间）。 */
const RUN_B = process.env.ADR028V_RUN_B ?? 'sr_1789832477006_000002';
const RT_B = Number(process.env.ADR028V_RT_B ?? '1');
const FILL_B1 = Number(process.env.ADR028V_FILL_B1 ?? '1');

/** 高亮存活时长（与 `KlineChart.HIGHLIGHT_DURATION_MS` 同口径）。 */
const HL_MS = 3000;
/** 堆叠间距（与 `KlineChart.FILL_DOT_DY_PX` 同口径；判据处不直接引用实现方常量，独立取 12）。 */
const STACK_DY = 12;
/** 白簇最小计重（< 该值视为恒定背景噪声，实测为 y 轴小簇 size 4/1）。 */
const CLUSTER_MIN = 30;
/** 标签 ink run 阈值（校准口径见设计报告 §2/T2；真实构建实测 24）。 */
const INK_RUN_MIN = 15;

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

/** 页面上屏的图表真身状态（就绪判据读点）。 */
async function chartReadyState(page: Page): Promise<{ maxDataLen: number; markers: string; fillsNote: string }> {
  const dataLens = await page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    return (w.__wbCharts ?? []).map((c) => {
      try {
        return (((c['getDataList'] as () => unknown[])() ?? []) as unknown[]).length;
      } catch {
        return -1;
      }
    });
  });
  const markers = (await page.getByTestId('kline-chart').getAttribute('data-marker-overlays')) ?? '';
  const fillsNote = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  return { maxDataLen: dataLens.reduce((a, b) => Math.max(a, b), 0), markers, fillsNote };
}

/** 由 `wb-fills-note` 文案导出**期望已建标记数**（= 已加载成交笔数）。
 *  与 K 线标记的事实源同源：`成交合计 N 笔（精确源 /fills，已加载 L / 共 N）` ⇒ 期望 L（每笔一个 fillDot）。
 *  `加载中…` / `未记录…` ⇒ 期望 0（与 T6b/T6c 的显式判据同口径）。
 *  文案无法解析 ⇒ **显式抛错**（就绪判据失去依据时必须变红，禁止静默放宽）。 */
function expectedMarkerCount(fillsNote: string): number {
  if (fillsNote.includes('加载中')) return 0;
  if (fillsNote.includes('未记录')) return 0;
  const m = /已加载\s*(\d+)\s*\/\s*共\s*\d+/.exec(fillsNote);
  if (!m) throw new Error(`wb-fills-note 文案无法解析（就绪判据失效，须更新规格）：${fillsNote}`);
  return Number(m[1]);
}

/** 打开工作台 + 选中 run + 等初始装载落定（结果页可见、窗口事实源来自 kline、成交明细到位）。
 *
 *  **2026-09-20（T4 flaky 取证）**：本条原先以 `waitForTimeout(2500)`「等落定」——固定 sleep 不能保证任何
 *  前置条件成立（数据慢于 2.5s ⇒ 断言跑在未就绪状态上；数据快于 2.5s ⇒ 白白等待）。现改为**显式就绪判据**：
 *  ① 图表 K 线数据到位（`dataList` 非空 ⇒ 窗口事实源/几何定位可用）；
 *  ② 成交明细到位且**每笔成交一个 `fillDot`**（`data-marker-overlays` == 已加载成交数，读页面自身上屏口径）。
 *  就绪判据超时 ⇒ 显式红（附实际/期望计数），不再随机停在后续断言上。
 *  取证与残留在产品侧的竞态见 `tester/evidence/20260920_t4_flaky_rootcause/report.md`。 */
async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const sel = page.getByTestId(`wb-run-select-${runId}`);
  await expect(sel, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await sel.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  // ① 图表 K 线数据就绪（窗口事实源来自 kline；dataList 为空则「定位/画标记」无从谈起）
  await expect
    .poll(async () => (await chartReadyState(page)).maxDataLen, {
      timeout: 15_000,
      intervals: [100],
      message: '图表 K 线数据必须到位（真图表实例 dataList 非空）',
    })
    .toBeGreaterThan(0);
  // ② 成交明细就绪 + 每笔成交一个标记（读页面上屏计数，与 T1/T4 判据同源）
  await expect
    .poll(
      async () => {
        const { markers, fillsNote } = await chartReadyState(page);
        const want = expectedMarkerCount(fillsNote);
        return markers === String(want) ? 'OK' : `MISMATCH data-marker-overlays=${markers} want=${want} note=${fillsNote}`;
      },
      {
        timeout: 15_000,
        intervals: [100],
        message: '成交明细到位后每笔成交必须已建成 fillDot 标记（data-marker-overlays == 已加载成交笔数）',
      },
    )
    .toBe('OK');
}

/** 真图表 store：`fillDot`（常态标记）/`fillDotHighlight`（跳转高亮）逐条读回。 */
type StoreDump = {
  ok: boolean;
  names: string[];
  fillDot: Array<{ key: string; stack: number; label: string; color: string; ts: number; price: number; zLevel: number }>;
  highlight: Array<{ key: string; stack: number; label: string; color: string; ts: number; price: number; zLevel: number; pulse: number }>;
};

async function storeDump(page: Page): Promise<StoreDump> {
  return page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return { ok: false, names: [], fillDot: [], highlight: [] } as unknown as never;
    const chart = cands[0]!;
    const all = (chart['getOverlays'] as () => Array<Record<string, unknown>>)();
    const pick = (o: Record<string, unknown>) => {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp?: number; value?: number }>;
      return {
        key: String(ext['fillKey'] ?? ''),
        stack: Number(ext['stackIndex'] ?? 0),
        label: String(ext['label'] ?? ''),
        color: String(ext['color'] ?? ''),
        pulse: Number(ext['pulse'] ?? 0),
        zLevel: Number(o['zLevel'] ?? 0),
        ts: Number(pts[0]?.timestamp ?? 0),
        price: Number(pts[0]?.value ?? 0),
      };
    };
    return {
      ok: true,
      names: all.map((o) => String(o['name'])),
      fillDot: all.filter((o) => o['name'] === 'fillDot').map(pick),
      highlight: all.filter((o) => o['name'] === 'fillDotHighlight').map(pick),
    } as unknown as never;
  }) as Promise<StoreDump>;
}


/** 几何（**键方案无关**）：按 (ts, price) 定位目标笔的渲染位置——供变异态（键被粗化）下仍能测到位置。 */
async function geomByFill(
  page: Page,
  targets: Array<{ ts: number; price: number }>,
): Promise<Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; fillKey: string }>> {
  return page.evaluate((want) => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return {};
    const chart = cands[0]!;
    const out: Record<string, unknown> = {};
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    for (const o of all) {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const hit = want.find((t) => Math.abs(pts[0]!.timestamp - t.ts * 1000) < 1000 && Math.abs(pts[0]!.value - t.price) < 1e-9);
      if (!hit) continue;
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
        { paneId: 'candle_pane' },
      );
      const stack = Number(ext['stackIndex'] ?? 0);
      out[`${hit.ts}:${hit.price}`] = {
        x: Number(p.x ?? NaN),
        yRaw: Number(p.y ?? NaN),
        y: Number(p.y ?? NaN) + stack * 12,
        stack,
        label: String(ext['label'] ?? ''),
        color: String(ext['color'] ?? ''),
        fillKey: String(ext['fillKey'] ?? ''),
      };
    }
    return out as never;
  }, targets) as Promise<Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; fillKey: string }>>;
}

/** 几何：目标 `fillKey` 的**渲染位置**（kline 容器相对坐标，**含堆叠偏移**）与锚点价/ts。 */
type Geom = Record<string, { x: number; yRaw: number; y: number; stack: number; label: string; color: string; ts: number; price: number }>;
async function geomOf(page: Page, keys: string[]): Promise<Geom> {
  return page.evaluate((want) => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return {};
    const chart = cands[0]!;
    const out: Record<string, unknown> = {};
    const all = (chart['getOverlays'] as (f?: unknown) => Array<Record<string, unknown>>)({ name: 'fillDot' });
    for (const o of all) {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const key = String(ext['fillKey'] ?? '');
      if (!want.includes(key)) continue;
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const p = (chart['convertToPixel'] as (a: unknown, b: unknown) => { x?: number; y?: number })(
        { timestamp: pts[0]!.timestamp, value: pts[0]!.value },
        { paneId: 'candle_pane' },
      );
      const stack = Number(ext['stackIndex'] ?? 0);
      out[key] = {
        x: Number(p.x ?? NaN),
        yRaw: Number(p.y ?? NaN),
        y: Number(p.y ?? NaN) + stack * 12,
        stack,
        label: String(ext['label'] ?? ''),
        color: String(ext['color'] ?? ''),
        ts: Number(pts[0]!.timestamp),
        price: pts[0]!.value,
      };
    }
    return out as never;
  }, keys) as Promise<Geom>;
}

type Cluster = { size: number; cx: number; cy: number; x0: number; x1: number; y0: number; y1: number };
type WhiteScan = { pane: { w: number; h: number }; canvases: number; whiteTotal: number; clusters: Cluster[]; readErrors: string[] };

/** 页面侧读全部 canvas → 合成「近白像素」位图 → 连通分量（4 邻接）。 */
async function scanWhite(page: Page): Promise<WhiteScan> {
  return page.evaluate(() => {
    const kl = document.querySelector('[data-testid="kline-chart"]')!;
    const kr = kl.getBoundingClientRect();
    const W = Math.round(kr.width);
    const H = Math.round(kr.height);
    const grid = new Uint8Array(W * H);
    const cs = Array.from(kl.querySelectorAll('canvas'));
    const readErrors: string[] = [];
    let count = 0;
    for (const c of cs) {
      const cr = c.getBoundingClientRect();
      const ox = Math.round(cr.x - kr.x);
      const oy = Math.round(cr.y - kr.y);
      let data: Uint8ClampedArray;
      try {
        data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      } catch (e) {
        readErrors.push(String(e));
        continue;
      }
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (data[i + 3]! < 200) continue;
          if (data[i]! >= 240 && data[i + 1]! >= 240 && data[i + 2]! >= 240) {
            const gx = x + ox;
            const gy = y + oy;
            if (gx >= 0 && gx < W && gy >= 0 && gy < H && grid[gy * W + gx] === 0) {
              grid[gy * W + gx] = 1;
              count += 1;
            }
          }
        }
      }
    }
    const seen = new Uint8Array(W * H);
    const clusters: Cluster[] = [];
    for (let i = 0; i < W * H; i++) {
      if (grid[i] !== 1 || seen[i] === 1) continue;
      const stack = [i];
      seen[i] = 1;
      let n = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % W;
        const py = (p - px) / W;
        n += 1; sx += px; sy += py;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (grid[q] === 1 && seen[q] === 0) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      clusters.push({ size: n, cx: sx / n, cy: sy / n, x0, x1, y0, y1 });
    }
    clusters.sort((a, b) => b.size - a.size);
    return { pane: { w: W, h: H }, canvases: cs.length, whiteTotal: count, clusters: clusters.slice(0, 8), readErrors };
  });
}

/** 标签 ink：在给定 band 内，统计「含墨列」的最长连续列数（墨 = 与该标记同色的红字像素）。 */
type Ink = { maxRun: number; cols: Array<[number, number]>; total: number };
async function inkRun(page: Page, box: { x0: number; x1: number; y0: number; y1: number }): Promise<Ink> {
  return page.evaluate((b) => {
    const kl = document.querySelector('[data-testid="kline-chart"]')!;
    const kr = kl.getBoundingClientRect();
    const W = Math.round(kr.width);
    const cs = Array.from(kl.querySelectorAll('canvas'));
    const cols = new Map<number, number>();
    let total = 0;
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
          const r = data[i]!, g = data[i + 1]!, bl = data[i + 2]!;
          if (data[i + 3]! < 200) continue;
          if (r > 80 && r - g > 40 && r - bl > 25 && !(r >= 240 && g >= 240 && bl >= 240)) {
            const gx = x + ox;
            cols.set(gx, (cols.get(gx) ?? 0) + 1);
            total += 1;
          }
        }
      }
    }
    let best = 0;
    let cur = 0;
    const arr: Array<[number, number]> = [];
    for (let x = b.x0; x < b.x1; x++) {
      const n = cols.get(x) ?? 0;
      arr.push([x, n]);
      if (n >= 1) {
        cur += 1;
        if (cur > best) best = cur;
      } else {
        cur = 0;
      }
    }
    void W;
    return { maxRun: best, cols: arr.filter(([, n]) => n > 0), total };
  }, box);
}

/** 结果页滚动容器与 K 线几何（focus 判据用）。 */
async function rects(page: Page) {
  return page.evaluate(() => {
    const g = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollTop: (document.querySelector('[data-testid="wb-result"]') as HTMLElement | null)?.scrollTop ?? -1,
      result: g('[data-testid="wb-result"]'),
      anchor: g('[data-testid="wb-kline-focus-anchor"]'),
      host: g('[data-testid="wb-kline-chart"]'),
    };
  });
}

/** 跳转后等「平滑滚动落定 + 高亮生效」（高亮只活 3s ⇒ 判据用 scrollTop 连续两次采样不变，最快 ~1.2s）。
 *
 *  `requireReceipt`（默认 false）：额外要求**写窗真身回执**到位（`wb-window-probe` 的
 *  `data-ok=true` 且 `data-rev == data-cmd-rev`，即最近一次命令已被 K 线实例读回确认）。
 *  几何/像素判据（T4）用它把「跳转是否真的落到图上」变成显式前置条件——F18「静默吞掉写窗」不再能用
 *  「滚动到了」蒙混（回执口径见 ADR-028 §3.4）。 */
async function settleJump(
  page: Page,
  opts: { maxMs?: number; requireReceipt?: boolean } = {},
): Promise<{ waitedMs: number }> {
  const maxMs = opts.maxMs ?? 3000;
  const t0 = Date.now();
  let prev = Number.NaN;
  await expect
    .poll(
      async () => {
        const r = await rects(page);
        const active = await page.getByTestId('kline-chart').getAttribute('data-highlight-active');
        if (active !== 'true' || !r.host) return false;
        const inViewport = r.host.y >= 0 && r.host.y + r.host.h <= r.viewport.h + 1;
        const stable = Number.isFinite(prev) && Math.abs(r.scrollTop - prev) <= 1;
        prev = r.scrollTop;
        if (!inViewport || !stable) return false;
        if (!opts.requireReceipt) return true;
        const p = await page.getByTestId('wb-window-probe').evaluate((e) => ({
          ok: e.getAttribute('data-ok'),
          rev: e.getAttribute('data-rev'),
          cmd: e.getAttribute('data-cmd-rev'),
        }));
        return p.ok === 'true' && p.rev !== '' && p.rev === p.cmd;
      },
      {
        timeout: maxMs,
        intervals: [120],
        message: opts.requireReceipt
          ? '滚动须落定（scrollTop 稳定）+ K 线整体在视口内 + 高亮生效 + 写窗真身回执 rev 到位'
          : '滚动须落定（scrollTop 稳定）且 K 线整体在视口内、高亮生效',
      },
    )
    .toBe(true);
  return { waitedMs: Date.now() - t0 };
}

/** K 线裁切截图（每次重测几何，视口内钳位）。 */
async function shotKline(page: Page, name: string) {
  const r = await rects(page);
  const vp = r.viewport;
  const x = Math.max(0, Math.round(r.host!.x));
  const y = Math.max(0, Math.round(r.host!.y));
  const width = Math.max(1, Math.min(Math.round(r.host!.w), vp.w - x));
  const height = Math.max(1, Math.min(Math.round(r.host!.h), vp.h - y));
  await page.screenshot({ path: resolve(OUT, name), clip: { x, y, width, height } });
  return { name, clip: { x, y, width, height } };
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(PAGE_CAPTURE);
});

// ───────────────────────────────── T0 真身锚定 ─────────────────────────────────
test('T0 真身锚定：被服务的 bundle == 实现方 bundle（sha256）', async ({ page }) => {
  const html = await (await page.request.get('/')).text();
  const m = /src="(\/assets\/index-[^"]+\.js)"/.exec(html);
  expect(m, 'index.html 必须引用打包产物').toBeTruthy();
  const url = m![1]!;
  const body = await (await page.request.get(url)).body();
  const served = createHash('sha256').update(body).digest('hex');
  const localPath = resolve(REPO, 'web/dist', url.replace(/^\//, ''));
  const local = readFileSync(localPath);
  const localHtml = readFileSync(resolve(REPO, 'web/dist/index.html'), 'utf8');
  const localRef = /src="(\/assets\/index-[^"]+\.js)"/.exec(localHtml)?.[1] ?? null;
  writeJson('t0_bundle', {
    url,
    servedSha256: served,
    localPath,
    localSha256: createHash('sha256').update(local).digest('hex'),
    bytes: body.length,
    localRef,
    expectName: EXPECT_BUNDLE_NAME,
    expectSha256: EXPECT_BUNDLE_SHA256,
  });
  expect(url, '被服务 bundle 名 == 本波实测产物名').toContain(EXPECT_BUNDLE_NAME);
  expect(localRef, 'web/dist/index.html 引用同一 bundle').toBe(url);
  expect(served, '被服务 bundle 必须与 web/dist 内文件逐字节一致').toBe(createHash('sha256').update(local).digest('hex'));
  expect(served, '本波真身 bundle sha256 锚点（产物变更须显式更新规格常量）').toBe(EXPECT_BUNDLE_SHA256);
});

// ───────────────────────────────── T1 醒目化结构（store） ─────────────────────────────────
test('T1 醒目化：真图表 store 中每笔成交一个 fillDot（含价格×股数标签/堆叠序），同 bar 多笔可分辨，且无连线类 overlay', async ({ page }) => {
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const fA = fills[FILL_A]!;
  const fB = fills[FILL_B]!;
  expect(fA['bar_index'], '第 42/43 笔必须同 bar（同 bar 多笔场景）').toBe(fB['bar_index']);
  expect(fA['ts']).toBe(fB['ts']);

  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);

  const store = await storeDump(page);
  const geom = await geomOf(page, [`${RT_A}:${FILL_A}`, `${RT_A}:${FILL_B}`]);
  const attrs = await readAttrs(page, 'kline-chart');
  const gA = geom[`${RT_A}:${FILL_A}`]!;
  const gB = geom[`${RT_A}:${FILL_B}`]!;

  const expectLabelA = `B ${Number(fA['price']).toFixed(3)}×${Number(fA['qty']).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
  const expectLabelB = `S ${Number(fB['price']).toFixed(3)}×${Number(fB['qty']).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;

  writeJson('t1_marker_store', { store, geom, attrs, expectLabelA, expectLabelB, fA, fB });

  expect(store.ok, '必须捕获到真图表实例并读到 overlay store').toBe(true);
  expect(store.fillDot.length, 'fillDot overlay 数 == /fills 笔数（每笔一个标记）').toBe(fills.length);
  expect(store.names.filter((n) => n !== 'fillDot' && n !== 'fillDotHighlight'), '除标记/高亮外不得有其它 overlay（禁连线/区间覆盖）').toEqual([]);
  expect(attrs['data-marker-overlays']).toBe(String(fills.length));

  expect(gA.label, '第 42 笔标签 == 价格×股数（fmtNum 口径）').toBe(expectLabelA);
  expect(gB.label, '第 43 笔标签 == 价格×股数（fmtNum 口径）').toBe(expectLabelB);
  expect(gA.label).not.toBe(gB.label);
  expect(gA.color).toBe('#ff5c6c');
  expect(gB.color).toBe('#00e0a4');
  expect(gA.stack, '同 bar 第 1 笔堆叠序').toBe(0);
  expect(gB.stack, '同 bar 第 2 笔堆叠序').toBe(1);
  expect(gA.ts, '两点必须锚同一 bar').toBe(gB.ts);
  expect(Math.abs(gA.yRaw - gB.yRaw), '两点锚点价不同（y 原始位置可相同）').toBeLessThanOrEqual(2);
  // 堆叠间距 12px 为标称值；两笔锚点价不同 ⇒ 各自 yRaw 可差 ±1px，故判据取 12±2。
  expect(Math.abs(gB.y - gA.y), `同 bar 两笔渲染 y 差 ≈ 堆叠间距 ${STACK_DY}px（> 圆点直径 6.4 ⇒ 不遮盖）`).toBeGreaterThanOrEqual(STACK_DY - 2);
  expect(Math.abs(gB.y - gA.y)).toBeLessThanOrEqual(STACK_DY + 2);
});

// ───────────────────────────────── T2 标签像素（ink run，[@mut]） ─────────────────────────────────
test('T2 醒目化像素 [@mut]：价格×股数标签确实被绘制到 canvas（标签区红墨连续列 run ≥ 阈值）', async ({ page }) => {
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_B}/round-trips/${RT_B}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const f = fills[FILL_B1]!;

  await openRunSettled(page, RUN_B);
  await page.getByTestId(`wb-rt-detail-${RT_B}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_B}-${FILL_B1}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_B}-${FILL_B1}`).click();
  await settleJump(page);

  const key = `${RT_B}:${FILL_B1}`;
  const geom = await geomOf(page, [key]);
  const g = geom[key]!;
  expect(Number.isFinite(g.x), '目标笔几何必须可测').toBe(true);

  // 标签区判据（**覆盖率口径**，对带偏移不敏感）：
  //   labelSpan = 目标笔右侧 [x+12, x+12+LW]（LW = 4.4px/字符 + 6，9px 字号的经验字宽）；
  //   量 = 该 span 内「有红墨的列数 / LW」与红墨总量。
  //   实测（同一视口、同一 run/笔）：真实构建 覆盖率 0.84 / 红墨 234；变异构建（移除 label）0.28 / 46。
  const expectedLabel = `B ${Number(f['price']).toFixed(3)}×${Number(f['qty']).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
  const LW = Math.round(4.4 * expectedLabel.length + 6);
  const labelSpan = { x0: Math.round(g.x + 12), x1: Math.round(g.x + 12 + LW), y0: Math.round(g.y - 5), y1: Math.round(g.y + 6) };
  const ink = await inkRun(page, labelSpan);
  const coverage = ink.cols.length / LW;
  const inkLeftCtrl = await inkRun(page, { x0: Math.round(g.x - 12 - LW), x1: Math.round(g.x - 12), y0: labelSpan.y0, y1: labelSpan.y1 });
  const shots = { on: await shotKline(page, 't2_label_on.png') };
  const attrs = await readAttrs(page, 'kline-chart');
  writeJson('t2_label_ink', { key, geom: g, labelSpan, LW, coverage, ink, inkLeftCtrl, attrs, shots, expectLabel: expectedLabel });

  // ① 像素口径（**独立于 store**：即使 store 里写了 label，也要求真的画到 canvas 上）
  expect(coverage, `标签文本覆盖率 = 有墨列数/LW ≥ 0.6（真实构建实测 0.84；移除 label 实测 0.28）`).toBeGreaterThanOrEqual(0.6);
  expect(ink.total, '标签 span 内红墨像素 ≥ 120（真实构建实测 234；移除 label 实测 46）').toBeGreaterThanOrEqual(120);
  expect(ink.total, '标签 span 红墨必须显著多于左侧同形对照区（无标签）').toBeGreaterThan(inkLeftCtrl.total);
  // ② store 口径（标签文本内容 == 价格×股数，fmtNum 口径）
  expect(g.label, '标签文本（store）').toBe(expectedLabel);
});

// ───────────────────────────────── T3 focus 滚动 ─────────────────────────────────
test('T3 focus：L2 [跳转] 后结果页滚动到 K 线区域（滚动容器 + 视口双重判据）', async ({ page }) => {
  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const before = await rects(page);
  const shotBefore = await page.screenshot({ path: resolve(OUT, 't3_before_jump.png') }).then(() => 't3_before_jump.png');

  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  const settle = await settleJump(page);
  const after = await rects(page);
  const shotAfter = await page.screenshot({ path: resolve(OUT, 't3_after_jump.png') }).then(() => 't3_after_jump.png');
  writeJson('t3_focus_scroll', { before, after, settle, shotBefore, shotAfter });

  const beforeVisible = before.anchor!.y >= before.result!.y - 2 && before.anchor!.y <= before.result!.y + before.result!.h - 20;
  expect(beforeVisible, '跳转前锚点应在滚动容器可视区之外（否则该用例无区分力）').toBe(false);
  expect(after.scrollTop, 'focus：滚动位置必须变化').not.toBe(before.scrollTop);
  expect(after.anchor!.y).toBeGreaterThanOrEqual(after.result!.y - 2);
  expect(after.anchor!.y, '锚点须落在滚动容器可视区内').toBeLessThanOrEqual(after.result!.y + after.result!.h - 20);
  expect(after.host!.y, 'K 线容器须整体落在视口内（比「滚动容器内」更严）').toBeGreaterThanOrEqual(0);
  expect(after.host!.y + after.host!.h).toBeLessThanOrEqual(after.viewport.h + 1);
  expect(settle.waitedMs, '滚动落定耗时（观测）').toBeGreaterThan(0);
});

// ───────────────────────────────── T4 精确到笔高亮 + 3 秒回常态（[@mut]） ─────────────────────────────────
test('T4 只高亮被点击那一笔 [@mut]：白描边簇恰 1 个且质心落在该笔堆叠位置；3 秒后回落为 0', async ({ page }) => {
  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const keyA = `${RT_A}:${FILL_A}`;
  const keyB = `${RT_A}:${FILL_B}`;
  const rowA = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(rowA).toBeVisible();
  // `scrollIntoViewIfNeeded`（默认 behavior:'auto' ⇒ 瞬时）返回即已就位；本条原先再 `waitForTimeout(250)`
  // 属无判据依据的固定等待（跳转前无任何断言依赖滚动位置）⇒ 删除（禁止用 sleep 充当时序护栏）。
  await rowA.scrollIntoViewIfNeeded();

  const gtFills = ((await (await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`)).json()) as {
    fills: Array<{ ts: number; price: number }>;
  }).fills;
  const fA = gtFills[FILL_A]!;
  const fB = gtFills[FILL_B]!;

  // ── 点击第 42 笔 ──
  const tClick = Date.now();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  const settle = await settleJump(page, { requireReceipt: true });
  // 几何必须在**跳转后**读（跳转前窗口为全览 174 根，目标 bar 的 x 完全不同；跳转后窗口收敛到目标），
  // 且按 (ts, price) 定位（**键方案无关**）⇒ 变异把键粗化后仍能测到目标位置。
  const geomCells = await geomByFill(page, [{ ts: fA.ts, price: fA.price }, { ts: fB.ts, price: fB.price }]);
  const gA = geomCells[`${fA.ts}:${fA.price}`];
  const gB = geomCells[`${fB.ts}:${fB.price}`];
  // 失败时留痕（几何步的任何残留异常都自带状态画像，不再只剩一句「不可测」）
  writeJson('t4_geom_state', {
    geomKeys: Object.keys(geomCells),
    geomCells,
    chartState: await chartReadyState(page),
    windowProbe: await readAttrs(page, 'wb-window-probe'),
  });
  expect(gA != null && gB != null, '跳转后目标笔几何必须可测（按 ts+价格定位）').toBe(true);
  const attrsOn = await readAttrs(page, 'kline-chart');
  const noteOn = await readAttrs(page, 'wb-jump-highlight-note');
  const storeOn = await storeDump(page);
  const scanOn = await scanWhite(page);
  const shotOn = await shotKline(page, 't4_kline_hl42_a.png');
  await page.waitForTimeout(170);
  const attrsP2 = await readAttrs(page, 'kline-chart');
  const scanP2 = await scanWhite(page);
  const shotP2 = await shotKline(page, 't4_kline_hl42_b.png');
  await page.screenshot({ path: resolve(OUT, 't4_page_hl42.png') });

  // 页面侧时间序列（150ms 采样 ~4.2s）：脉冲期白像素 → 3 秒后回落。
  // 采样窗 = 覆盖两枚叠点的紧邻区域（子矩形 getImageData，避免整幅拷贝）。
  const sampleBox = {
    x0: Math.round(Math.min(gA.x, gB.x) - 24),
    x1: Math.round(Math.max(gA.x, gB.x) + 24),
    y0: Math.round(Math.min(gA.y, gB.y) - 24),
    y1: Math.round(Math.max(gA.y, gB.y) + 24),
  };
  const series = await page.evaluate(
    async (arg) => {
      const b = arg.box;
      const out: Array<{ t: number; sinceClick: number; pulse: string | null; active: string | null; white: number }> = [];
      const t0 = Date.now();
      const kl = document.querySelector('[data-testid="kline-chart"]')!;
      const kr = kl.getBoundingClientRect();
      const cs = Array.from(kl.querySelectorAll('canvas'));
      while (Date.now() - t0 < 4200) {
        let white = 0;
        for (const c of cs) {
          const cr = c.getBoundingClientRect();
          const ox = Math.round(cr.x - kr.x);
          const oy = Math.round(cr.y - kr.y);
          const x = Math.max(0, b.x0 - ox);
          const y = Math.max(0, b.y0 - oy);
          const w = Math.min(c.width, b.x1 - ox) - x;
          const h = Math.min(c.height, b.y1 - oy) - y;
          if (w <= 0 || h <= 0) continue;
          const data = c.getContext('2d')!.getImageData(x, y, w, h).data;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3]! < 200) continue;
            if (data[i]! >= 240 && data[i + 1]! >= 240 && data[i + 2]! >= 240) white += 1;
          }
        }
        out.push({
          t: Date.now() - t0,
          sinceClick: Date.now() - arg.tClick,
          pulse: document.querySelector('[data-testid="kline-chart"]')!.getAttribute('data-highlight-pulse'),
          active: document.querySelector('[data-testid="kline-chart"]')!.getAttribute('data-highlight-active'),
          white,
        });
        await new Promise((r) => setTimeout(r, 150));
      }
      return out;
    },
    { box: sampleBox, tClick },
  );

  // ── 3 秒后（跳转后 ≥3.6s） ──
  expect(Date.now() - tClick, '采样窗口已越过高亮时长（时序证据）').toBeGreaterThan(HL_MS);
  const attrsAfter = await readAttrs(page, 'kline-chart');
  const storeAfter = await storeDump(page);
  const scanAfter = await scanWhite(page);
  const shotAfter = await shotKline(page, 't4_kline_after3s.png');
  await page.screenshot({ path: resolve(OUT, 't4_page_after3s.png') });

  // ── 再点第 43 笔（同 bar 另一笔） ──
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_B}`).click();
  const settleB = await settleJump(page);
  const attrsOnB = await readAttrs(page, 'kline-chart');
  const storeOnB = await storeDump(page);
  const scanOnB = await scanWhite(page);
  const shotOnB = await shotKline(page, 't4_kline_hl43.png');
  await page.waitForTimeout(HL_MS + 800);
  const scanAfterB = await scanWhite(page);
  const attrsAfterB = await readAttrs(page, 'kline-chart');

  writeJson('t4_highlight_pixels', {
    run: RUN_A, rt: RT_A, fillA: FILL_A, fillB: FILL_B,
    geom: { gA, gB, geomCells },
    settle, settleB,
    attrsOn, noteOn, storeOn, scanOn, shotOn,
    attrsP2, scanP2, shotP2,
    series,
    attrsAfter, storeAfter, scanAfter, shotAfter,
    attrsOnB, storeOnB, scanOnB, shotOnB, attrsAfterB, scanAfterB,
  });

  const bigOn = scanOn.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigP2 = scanP2.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigAfter = scanAfter.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigOnB = scanOnB.clusters.filter((c) => c.size >= CLUSTER_MIN);
  const bigAfterB = scanAfterB.clusters.filter((c) => c.size >= CLUSTER_MIN);

  // ① 高亮存在 + 只高亮被点那一笔
  expect(attrsOn['data-highlight-key'], '高亮键必须精确到笔').toBe(keyA);
  expect(attrsOn['data-highlight-active']).toBe('true');
  expect(noteOn['data-state'], '高亮提示状态').toBe('ok');
  expect(storeOn.highlight.length, '真图表 store 中高亮 overlay 恰 1 条（只高亮被点那一笔）').toBe(1);
  expect(storeOn.highlight[0]!.key).toBe(keyA);
  expect(storeOn.highlight[0]!.stack, '高亮必须复用该笔堆叠序').toBe(gA.stack);
  expect(storeOn.highlight[0]!.label).toBe(gA.label);
  expect(bigOn.length, 'K 线区白描边簇恰 1 个（同 bar 另一笔不得同时高亮）').toBe(1);
  // x 容差 6px：目标 bar 为 run 末根时圆环被 candle pane 右边界裁掉右侧（质心左偏 ~4px，见离线 PNG 复算）
  expect(Math.abs(bigOn[0]!.cx - gA.x), '白簇质心 x == 该笔渲染位置（±6，末根 bar 受 pane 边界裁切）').toBeLessThanOrEqual(6);
  expect(Math.abs(bigOn[0]!.cy - gA.y), '白簇质心 y == 该笔渲染位置（含堆叠偏移，±3）').toBeLessThanOrEqual(3);
  expect(bigOn[0]!.y1 - bigOn[0]!.y0, '白簇高度 ≤ 24px（单枚圆环；两枚粘连会显著变高）').toBeLessThanOrEqual(24);
  expect(scanOn.canvases, '已扫描 canvas 数').toBeGreaterThan(1);
  expect(scanOn.readErrors, 'canvas 像素可读（无跨域污染）').toEqual([]);

  // ② 脉冲（定时器驱动重绘）：相位递增 + 白像素量随相位变化
  expect(Number(attrsP2['data-highlight-pulse']), '相位 B 必须 > 相位 A').toBeGreaterThan(Number(attrsOn['data-highlight-pulse']));
  expect(bigP2.length).toBe(1);
  const pulseSizes = new Set([bigOn[0]!.size, bigP2[0]!.size]);
  const seriesSizes = new Set(series.filter((s) => s.white > CLUSTER_MIN).map((s) => s.white));
  expect(seriesSizes.size, '脉冲期白像素量随时间变化（放大+描边脉冲）').toBeGreaterThan(1);
  writeJson('t4_pulse_stats', { pulseSizes: [...pulseSizes], seriesWhiteDistinct: seriesSizes.size });

  // ③ 3 秒后回常态（无永久选中态、无残留高亮 overlay）
  expect(attrsAfter['data-highlight-active'], '3 秒后必须回常态').toBe('false');
  expect(attrsAfter['data-highlight-pulse']).toBe('0');
  expect(storeAfter.highlight.length, '3 秒后高亮 overlay 必须清空').toBe(0);
  expect(bigAfter.length, '3 秒后白簇必须归零（描边消失）').toBe(0);
  expect(attrsAfter['data-highlight-key'], '键仍指向目标笔（仅高亮态结束；不得残留选中态样式）').toBe(keyA);
  const firstOff = series.find((s) => s.active === 'false');
  expect(firstOff, '时间序列必须出现回常态样本').toBeTruthy();
  expect(firstOff!.sinceClick, '回落时刻 ≈ 高亮时长 3s（自点击起算）').toBeGreaterThanOrEqual(2900);
  expect(firstOff!.sinceClick, '回落时刻不得显著超过 3s').toBeLessThanOrEqual(3600);
  expect(series.filter((s) => s.active === 'true').length, '时间序列必须覆盖脉冲期（若样本起步晚于 3s 则该断言会红，属时序护栏）').toBeGreaterThan(0);
  expect(series.filter((s) => s.active === 'false' && s.white > CLUSTER_MIN).length, '回常态后序列样本白像素必须为 0').toBe(0);

  // ④ 同 bar 另一笔：仍恰 1 个白簇，且质心下移一个堆叠间距（互斥 + 精确到笔）
  expect(attrsOnB['data-highlight-key']).toBe(keyB);
  expect(storeOnB.highlight.length, '点第 43 笔后高亮 overlay 仍恰 1 条').toBe(1);
  expect(storeOnB.highlight[0]!.key).toBe(keyB);
  expect(storeOnB.highlight[0]!.stack).toBe(gB.stack);
  expect(bigOnB.length, '同 bar 另一笔：白簇仍恰 1 个（不是两笔同时高亮）').toBe(1);
  expect(Math.abs(bigOnB[0]!.cx - gB.x)).toBeLessThanOrEqual(6);
  expect(Math.abs(bigOnB[0]!.cy - gB.y), '白簇质心 y == 第 43 笔渲染位置').toBeLessThanOrEqual(3);
  expect(Math.abs(bigOnB[0]!.cy - bigOn[0]!.cy), '两次点击的白簇质心差 ≈ 堆叠间距 12px（两笔像素上可分辨/互斥）').toBeGreaterThanOrEqual(9);
  expect(Math.abs(bigOnB[0]!.cy - bigOn[0]!.cy)).toBeLessThanOrEqual(15);
  expect(bigAfterB.length, '第 43 笔高亮 3 秒后同样归零').toBe(0);
  expect(attrsAfterB['data-highlight-active']).toBe('false');

  // ⑤ 白簇离线复算（截图 → PIL）由 raw/pixel_analyze.py 独立重算，见执行报告
  expect(shotOn.clip.width).toBeGreaterThan(100);
});

// ───────────────────────────────── T5 曲线竖线 ─────────────────────────────────
test('T5 曲线竖线：四视图同一时点画竖线，跨 3 秒保留、下一次跳转更新、全览清除', async ({ page }) => {
  const fillsResp = await page.request.get(`/api/workbench/runs/${RUN_A}/round-trips/${RT_A}/fills?limit=500`);
  const fills = ((await fillsResp.json()) as { fills: Array<Record<string, number | string>> }).fills;
  const tsA = Number(fills[FILL_A]!['ts']);
  const tsC = Number(fills[FILL_C]!['ts']);
  expect(tsA).not.toBe(tsC);

  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const before = await page.locator('[data-testid="wb-vline"]').count();

  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);
  const read = async () =>
    page.locator('[data-testid="wb-vline"]').evaluateAll((els) =>
      els.map((e) => ({ view: e.getAttribute('data-view'), ts: e.getAttribute('data-vline-ts') })),
    );
  const vOn = await read();
  await page.waitForTimeout(HL_MS + 900);
  const vAfter3s = await read();

  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_C}`).click();
  await settleJump(page);
  const vSecond = await read();

  // 「全览」的手势点击在 L2 跳转后会被 K 线画布溢出遮挡（见 T7 红），此处用 DOM click 事件驱动状态机，
  // 并记录当前遮挡事实（elementFromPoint）。
  const obstruction = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="wb-window-reset"]')!;
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { elementAtCenter: el ? el.tagName.toLowerCase() : null, blocked: el !== btn && !btn.contains(el) };
  });
  await page.getByTestId('wb-window-reset').dispatchEvent('click');
  await page.waitForTimeout(400);
  const vReset = await read();
  const attrsReset = await readAttrs(page, 'kline-chart');
  writeJson('t5_vlines', { tsA, tsC, before, vOn, vAfter3s, vSecond, vReset, attrsReset, obstruction });

  expect(before, '跳转前不应有竖线').toBe(0);
  expect(vOn.length, '四曲线视图各一条竖线').toBeGreaterThanOrEqual(4);
  expect(new Set(vOn.map((v) => v.ts)).size, '竖线时点必须唯一（同一时点）').toBe(1);
  expect(Number(vOn[0]!.ts), '竖线时点 == 目标笔成交 ts').toBe(tsA);
  expect(vAfter3s.length, '高亮回常态后竖线仍保留（保留到下一次跳转或全览）').toBe(vOn.length);
  expect(vSecond.length).toBeGreaterThanOrEqual(4);
  expect(new Set(vSecond.map((v) => v.ts)).size, '第二次跳转后时点仍唯一').toBe(1);
  expect(Number(vSecond[0]!.ts), '竖线随下一次跳转更新为新目标 ts').toBe(tsC);
  expect(vReset.length, '全览必须清除竖线').toBe(0);
  expect(attrsReset['data-highlight-key'], '全览必须清除高亮键').toBe('');
  expect(attrsReset['data-highlight-active']).toBe('false');
});

// ───────────────────────────────── T6 三态显式提示 ─────────────────────────────────
test('T6a 三态提示 unmatched：目标笔不在 K 线标记集合内（序号跨源错配）⇒ 显式提示、不静默', async ({ page }) => {
  await page.route('**/api/workbench/runs/*/fills*', async (route) => {
    const resp = await route.fetch();
    const body = (await resp.json()) as { fills?: Array<Record<string, unknown>> };
    for (const f of body.fills ?? []) f['rt_seq'] = Number(f['rt_seq']) + 1000;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await page.waitForTimeout(1200);

  const note = page.getByTestId('wb-jump-highlight-note');
  await expect(note, '未命中必须显式提示（不得静默）').toBeVisible();
  const attrs = await readAttrs(page, 'wb-jump-highlight-note');
  const text = (await note.textContent()) ?? '';
  const attrsOnK = await readAttrs(page, 'kline-chart');
  const store = await storeDump(page);
  const scan = await scanWhite(page);
  const probe = await readAttrs(page, 'wb-window-probe');
  writeJson('t6a_unmatched', { attrs, text, attrsOnK, markers: store.fillDot.length, highlight: store.highlight.length, bigClusters: scan.clusters.filter((c) => c.size >= CLUSTER_MIN).length, probe });

  expect(attrs['data-state'], '状态必须为 unmatched').toBe('unmatched');
  expect(text.length, '提示文案非空（显式）').toBeGreaterThan(10);
  expect(text, '文案须指明目标键与「只跳窗口、无高亮」').toContain(`${RT_A}:${FILL_A}`);
  expect(store.fillDot.length, '标记仍在（只是键不匹配）').toBeGreaterThan(0);
  expect(store.highlight.length, '未命中 ⇒ 不得画高亮').toBe(0);
  expect(attrsOnK['data-highlight-active']).toBe('false');
  expect(probe['data-ok'], '窗口跳转仍须执行（提示的是「仅无高亮」）').toBe('true');
});

test('T6b 三态提示 unrecorded：recorded=false（未写成交明细）⇒ 显式提示、不静默', async ({ page }) => {
  await page.route('**/api/workbench/runs/*/fills*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ run_id: RUN_A, total: 0, recorded: false, offset: 0, limit: 500, has_more: false, next_offset: null, fills: [] }),
    });
  });
  await openRunSettled(page, RUN_A);
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row, 'L2 行来自 /round-trips 端点，不受 run 级 /fills 注入影响').toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await page.waitForTimeout(1200);

  const note = page.getByTestId('wb-jump-highlight-note');
  await expect(note).toBeVisible();
  const attrs = await readAttrs(page, 'wb-jump-highlight-note');
  const text = (await note.textContent()) ?? '';
  const fillsNote = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  const store = await storeDump(page);
  const probe = await readAttrs(page, 'wb-window-probe');
  writeJson('t6b_unrecorded', { attrs, text, fillsNote, markers: store.fillDot.length, highlight: store.highlight.length, probe });

  expect(attrs['data-state'], '状态必须为 unrecorded').toBe('unrecorded');
  expect(text, '文案须显式说明 recorded=false 且窗口跳转仍执行').toContain('recorded=false');
  expect(fillsNote.length).toBeGreaterThan(0);
  expect(store.highlight.length).toBe(0);
  expect(probe['data-ok']).toBe('true');
});

test('T6c 三态提示 loading：成交明细未到位期间必须显式披露；并核验「跳转高亮 loading 分支」在 UI 上是否可达', async ({ page }) => {
  // 先取真实载荷（APIRequestContext 不经 page.route），再注册「延迟 14s 放行」拦截。
  const realFills = await (await page.request.get(`/api/workbench/runs/${RUN_A}/fills?limit=5000`)).json();
  const hitUrls: string[] = [];
  await page.route('**/api/workbench/runs/*/fills*', async (route) => {
    hitUrls.push(route.request().url());
    await new Promise((r) => setTimeout(r, 14000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(realFills) });
  });
  await openRunSettled(page, RUN_A);

  // ── 未到位期间：显式披露 + 无标记 + L2 表是否可用（可达性判据） ──
  const fillsNoteDuring = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  const markersDuring = await page.getByTestId('kline-chart').getAttribute('data-marker-overlays');
  let l2ReachableDuring = false;
  try {
    await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).waitFor({ state: 'visible', timeout: 2500 });
    l2ReachableDuring = true;
  } catch {
    l2ReachableDuring = false;
  }
  const shotLoading = await page.screenshot({ path: resolve(OUT, 't6c_loading_phase.png') }).then(() => 't6c_loading_phase.png');

  // ── 放行后：标记到位 + 正常跳转高亮应恢复可用 ──
  await expect
    .poll(async () => page.getByTestId('kline-chart').getAttribute('data-marker-overlays'), { timeout: 30000 })
    .toBe(String((realFills as { fills?: unknown[] }).fills?.length ?? 44));
  const fillsNoteAfter = (await page.getByTestId('wb-fills-note').textContent()) ?? '';
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);
  const noteAfter = await readAttrs(page, 'wb-jump-highlight-note');
  const attrsAfter = await readAttrs(page, 'kline-chart');
  const scanAfter = await scanWhite(page);
  writeJson('t6c_loading', {
    hitUrls,
    fillsNoteDuring,
    markersDuring,
    l2ReachableDuring,
    shotLoading,
    fillsNoteAfter,
    noteAfter,
    attrsAfter,
    bigClustersAfter: scanAfter.clusters.filter((c) => c.size >= CLUSTER_MIN).length,
  });

  expect(hitUrls.length, '注入拦截必须命中（否则本用例无区分力）').toBeGreaterThan(0);
  expect(fillsNoteDuring, '未到位期间必须显式披露加载中（不得静默）').toContain('加载中');
  expect(markersDuring, '未到位期间标记数必须为 0').toBe('0');
  expect(fillsNoteAfter, '放行后必须显式披露成交总量').toContain('成交合计');
  expect(noteAfter['data-state'], '放行后跳转高亮恢复正常').toBe('ok');
  expect(attrsAfter['data-highlight-active']).toBe('true');
  expect(scanAfter.clusters.filter((c) => c.size >= CLUSTER_MIN).length, '放行后高亮白簇恰 1 个').toBe(1);
});

// ───────────────────────── T7 回归：控制条可点击性（K 线画布溢出遮挡） ─────────────────────────
/**
 * **B1 复验口径（2026-09-20 复验解除冻结）**——比修复前版本更严：
 *  1. 触发条件必须**真实复现**：L2 跳转后高亮提示（长句，与图例同行 ⇒ 头部可能换行增高）必须存在；
 *  2. **两个按钮各取 3 个采样点**（中心 / 15% 高 / 85% 高）做 `elementFromPoint`，3/3 必须命中
 *     **按钮自身或其后代**（`selfOrChild`，不依赖具体标签名）；
 *  3. 两个按钮必须能被**真实 `click({timeout:3000})`** 点中且不超时——Playwright 自带命中测试，
 *     被 canvas 遮挡时会抛 `element intercepts pointer events` / TimeoutError；
 *     点击「全览」必须**真的生效**（高亮提示被清除）——证伪「点到了但没触发 handler」；
 *  4. 布局不变量：K 线容器不得溢出卡片、卡片底部不得越过控制条顶部、收缩后图表区仍须有可用高度。
 */
test('T7 回归 [@mut]：L2 跳转后「全览/回退」必须仍可点击（3 采样点自命中 + 真实 click 不超时）', async ({ page }) => {
  await openRunSettled(page, RUN_A);
  const beforeNote = await page.getByTestId('wb-jump-highlight-note').count();
  await page.getByTestId(`wb-rt-detail-${RT_A}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_A}-${FILL_A}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.getByTestId(`wb-l2-jump-${RT_A}-${FILL_A}`).click();
  await settleJump(page);

  /** 采样点分数（中心 / 15% / 85%）。 */
  const FRACS = [0.5, 0.15, 0.85];

  const probe = () =>
    page.evaluate((fracs: number[]) => {
      const sample = (id: string) => {
        const btn = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        if (!btn) return { present: false as const };
        const br = btn.getBoundingClientRect();
        const samples = fracs.map((f) => {
          const px = Math.round(br.x + br.width / 2);
          const py = Math.round(br.y + br.height * f);
          const at = document.elementFromPoint(px, py) as HTMLElement | null;
          const owner = at?.closest('[data-testid]') as HTMLElement | null;
          return {
            f,
            px,
            py,
            tag: at ? at.tagName.toLowerCase() : null,
            testid: owner?.getAttribute('data-testid') ?? null,
            selfOrChild: at != null && (at === btn || btn.contains(at)),
          };
        });
        return {
          present: true as const,
          disabled: btn.hasAttribute('disabled'),
          rect: { x: br.x, y: br.y, w: br.width, h: br.height },
          samples,
          allSelf: samples.every((sp) => sp.selfOrChild),
        };
      };
      const host = document.querySelector('[data-testid="wb-kline-chart"]')!.getBoundingClientRect();
      const kl = document.querySelector('[data-testid="kline-chart"]')!.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="wb-window-bar"]')!.getBoundingClientRect();
      const note = document.querySelector('[data-testid="wb-jump-highlight-note"]') as HTMLElement | null;
      const st = document.querySelector('[data-testid="wb-window-state"]')!;
      return {
        reset: sample('wb-window-reset'),
        back: sample('wb-window-back'),
        klineOverflowPx: Math.round(kl.bottom - host.bottom),
        hostBottom: Math.round(host.bottom),
        barTop: Math.round(bar.top),
        chartAreaH: Math.round(kl.height),
        notePresent: note != null,
        noteState: note?.getAttribute('data-state') ?? '',
        noteText: note?.textContent?.slice(0, 80) ?? '',
        windowSource: st.getAttribute('data-source'),
        windowRev: st.getAttribute('data-rev'),
      };
    }, FRACS);

  const afterJump = await probe();
  await page.screenshot({ path: resolve(OUT, 't7_after_l2_jump.png') });

  // ── 真实点击 ①：「全览」（必须在**高亮提示仍在**时点，否则遮挡条件不成立） ──
  const guardNote = await page.getByTestId('wb-jump-highlight-note').count();
  let resetClickOk = false;
  let resetClickError = '';
  try {
    await page.getByTestId('wb-window-reset').click({ timeout: 3000 });
    resetClickOk = true;
  } catch (e) {
    resetClickError = String(e).slice(0, 400);
  }
  await page.waitForTimeout(700);
  const afterReset = await probe();

  // ── 真实点击 ②：「回退」（real click 前核验 enabled） ──
  let backClickOk = false;
  let backClickError = '';
  const backBefore = afterReset.back;
  if (backBefore.present && !backBefore.disabled) {
    try {
      await page.getByTestId('wb-window-back').click({ timeout: 3000 });
      backClickOk = true;
    } catch (e) {
      backClickError = String(e).slice(0, 400);
    }
  } else {
    backClickError = '「回退」在真实点击前不可用（disabled 或缺失）';
  }
  await page.waitForTimeout(700);
  const afterBack = await probe();

  writeJson('t7_bar_clickability', {
    beforeNote,
    afterJump,
    guardNote,
    resetClickOk,
    resetClickError,
    afterReset,
    backBefore,
    backClickOk,
    backClickError,
    afterBack,
  });

  // ── 判据：触发条件 ──
  expect(afterJump.notePresent, 'L2 跳转必须显示高亮提示（B1 遮挡条件须真实复现）').toBe(true);
  expect(afterJump.noteState, '提示态必须为 ok').toBe('ok');
  expect(afterJump.noteText, '提示文案必须为高亮成功长句').toContain('已高亮目标成交');
  expect(guardNote, '真实 click「全览」前提示必须仍在（保证遮挡条件成立）').toBe(1);

  // ── 判据：3 采样点自命中 ──
  expect(afterJump.reset.present && afterJump.back.present, '两个控制按钮必须存在').toBe(true);
  expect(afterJump.reset.samples.length, '「全览」采样点数必须 ≥ 3').toBe(3);
  expect(afterJump.back.samples.length, '「回退」采样点数必须 ≥ 3').toBe(3);
  expect(
    afterJump.reset.allSelf,
    `「全览」3 个采样点必须命中按钮自身或其子元素：${JSON.stringify(afterJump.reset.samples)}`,
  ).toBe(true);
  expect(
    afterJump.back.allSelf,
    `「回退」3 个采样点必须命中按钮自身或其子元素：${JSON.stringify(afterJump.back.samples)}`,
  ).toBe(true);

  // ── 判据：布局不变量 ──
  expect(afterJump.klineOverflowPx, 'K 线容器不得溢出卡片（溢出即盖住下方控制条）').toBeLessThanOrEqual(1);
  expect(afterJump.hostBottom, 'K 线卡片底部不得越过控制条顶部').toBeLessThanOrEqual(afterJump.barTop + 1);
  expect(afterJump.chartAreaH, '图表区收缩后仍须有可用高度').toBeGreaterThan(100);

  // ── 判据：真实 click ──
  expect(resetClickOk, `「全览」真实 click 必须成功（不得被 canvas 拦截）：${resetClickError}`).toBe(true);
  expect(backClickOk, `「回退」真实 click 必须成功（不得被 canvas 拦截）：${backClickError}`).toBe(true);
  expect(afterReset.notePresent, '点「全览」后高亮提示必须被清除（证明点击真的触发了 handler）').toBe(false);
  expect(afterReset.reset.allSelf, '点「全览」后按钮仍须自命中').toBe(true);
});
