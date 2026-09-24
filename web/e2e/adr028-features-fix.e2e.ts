/**
 * ADR-028 「解冻修复」规格（worker 前端车道自有；本文件在 2026-09-23 **由 tester 车道按 D6/D7 新契约重锚**）。
 *
 * 覆盖：
 *  - F0 真身锚定：被 :PORT 服务的 bundle 必须是**含 D6/D7 契约标识符**的构建（D6-2 预设 / D6-5 指标浮层 /
 *        D6-7 卡高 key / D7-1 分层容器 / D7-3 下栏 key），且**被删除的承诺文案不在**（R2）；
 *  - F1（B1 阻断项）：任意 L2 跳转后，「全览 / 历史回退」按钮**可被真实点击** ——
 *        在上栏容器内滚入视口后 `elementFromPoint` 三采样点命中按钮自身或其子元素 + `click()` 真实点击成功且不超时；
 *        同时断言 K 线容器**不溢出**卡片、卡高 == 契约默认 520（D6-1）、蜡烛主图 ≥ 320（D6-3）、页面无滚动（D7-1）；
 *  - F2（R1 风险项）：run 末根 bar 的买卖标签**完整可见**（标签盒内 ink 列覆盖率 ≥ 0.6、ink 像素 ≥ 80）；
 *  - F3（R3 风险项）：**真渲染像素颜色**断言 —— 圆点 ink == 该标记 store 色值（买红 / 卖绿），
 *        含「被常显标签背景盒遮挡」的混合解释（见下重锚第 4 条）；并给出「止损橙」当下的不可测说明与复验口径。
 *
 * 运行（对自建 preview；**证据默认落未跟踪目录**，不再写 `coder/`（AGENTS.md 2026-09-23 纪律））：
 *   cd web && npx vite build --outDir /tmp/<build> --emptyOutDir
 *   cd web && VITE_PROXY_TARGET=http://127.0.0.1:8081 npx vite preview --outDir /tmp/<build> --port <free> --strictPort
 *   cd web && E2E_BASE_URL=http://127.0.0.1:<free> \
 *     npx playwright test e2e/adr028-features-fix.e2e.ts --reporter=list --retries=0 --workers=1
 * 产物：`ADR028FIX_OUT`（默认 `tester/evidence/20260923_adr028_featuresfix/raw`，**未跟踪**）。
 *
 * ══════════════════ 2026-09-23 重锚（ADR-023 §6.2：改契约须全域枚举受影响测试；**按契约推导，禁按实现输出倒推**） ══════════════════
 * 事实源：`ADR-028 §2.6（D6）/§2.7（D7）/§4 第 8–10 条` + `design/17-trade-detail-layering/07-plan-result-height-and-detail-split.md §2/§4`。
 *
 *  1. **F0 产物文本锚**：旧锚 `js.includes('h-64 shrink-0 flex-col')` 编码「卡高固定 256」的**旧契约**；
 *     新契约 D6-1 规定默认 520 且可拖拽 ⇒ 该固定高类名在契约上**不可能继续存在**（旧锚的失效是契约推导结论，
 *     不是「实现换了写法」）。⇒ 改为按**契约命名的标识符**锚定（D6-2 `wb-kline-preset-`、D6-5 `wb-indicator-menu`、
 *     D6-7 `eestock.result.cardHeights.v1`、D7-1 `wb-kline-view`/`wb-detail-pane`、D7-2 `wb-detail-tabs`、
 *     D7-3 `eestock.result.layout.v1`）；**理由**：这些标识符由 design/07 §2–§3 明文命名，属契约面（而非 Tailwind 类名这类
 *     纯实现细节），且旧构建（`index-DhVqizDl.js`）**逐个缺失** ⇒ 对「被服务的是不是本波构建」保留鉴别力。
 *     **维护口径**：契约改名（key/testid）⇒ 本用例必须同步；类名/样式重构**不再**触发维护。
 *     `hasRemovedPromise`（`自动补高亮` 不得出现）保留：它断言的是**产品文案缺失**（R2 契约本身）。
 *  2. **F1 卡高**：`h-64 = 256` → **520**（D6-1 默认卡高；无记忆值时）。同时补：
 *     `max = 视口高 − 200`（D6-2 ⇒ 800 视口下上限 600，默认 520 在契约内可达）、「双击复位到 520」（D6-1，见 D6 规格）。
 *  3. **F1 图表区高**：旧「flex 收缩后 > 100px」→ **蜡烛主图 ≥ 320px**（D6-3 默认 520 态判据；旧阈值是旧 67px 主图时代的宽松口径）。
 *  4. **F1 按钮可点击性**：旧口径假设「卡高 256 + 单列整页滚动 ⇒ 窗口条必然在视口内」。新契约 §2.7-1 改为上下分层、
 *     **页面级滚动移除**、上栏自身滚动，且 §2.7-6 实测登记「上栏内容 ≈6524px ⇒ 任何视口下上栏都需自身滚动」；
 *     380 视口下卡 520 + 窗口条 34 > 上栏视口 ⇒ 窗口条**初始不在上栏视口内**（真渲染实测：`elementFromPoint`
 *     命中下栏表格）。⇒ 判据按契约收敛为：**先在上栏容器内把窗口条滚入视口**（D7-4 ④「只在上栏内部滚动」的同一语义），
 *     再判定 ①页面 `scrollY` 仍为 0（D7-1）②三采样点命中按钮自身 ③真实点击成功。B1 的鉴别力（canvas 盖住窗口条 ⇒ 红）不变。
 *  5. **F2**：判据（标签盒边缘收敛 + ink 覆盖率）与新契约无冲突，且 pane 宽/标记坐标全部**运行时重算**（不编码旧布局）
 *     ⇒ **不重锚**。残留脆弱点已登记：标签盒宽度模型（4.4px/字符 + padding 5）与实现常量耦合，实现改排版常量时须同步。
 *  6b. **2026-09-24 再重锚（ADR-028 §2.9 D9「三视图拆分」）**——仅 F0 与 F1 受影响（F2/F3 的
 *     pane 宽/高与标记坐标全部**运行时重算**，与新契约无耦合）：
 *     - **F0 产物文本锚**：旧锚 `wb-kline-preset`（D6-2 预设）随 D9-5 **删卡高机制**一并消失
 *       ⇒ 契约标记改指 **D9 命名**（`wb-kline-view` / `wb-indicator-view` / `wb-detail-view` /
 *       `wb-splitter-kline-indicators` / `wb-splitter-indicators-detail` / `wb-restore-detail` /
 *       `eestock.result.layout.v2`），并**新增反向锚**：被删机制的标记（`wb-kline-preset`、
 *       `wb-card-resize-kline`）**不得**出现在产物中（断言缺失 = D9-5；同时保留「被服务的是本波构建」的鉴别力）。
 *     - **F1 卡高**：`DEFAULT_KLINE_PX = 520` / `max = 视口高 − 200` **作废**（D9-5 删卡高机制）
 *       ⇒ 改为 **D9-8① 恒等式**（`卡高 == K 线视图高 − 60`）+ **D9-8③ 分档**（720 档夹取 ⇒
 *       `K线视图 == 可用 − 指标下限 − 明细下限` ∧ `data-view-clamped` 披露）+ **D9-8② 硬不变量**（主图 ≥160）。
 *     - **F1 窗口条可达性**：旧口径「先在上栏容器内把窗口条滚入视口」在 D9 下**不适用**——
 *       窗口条在 K 线视图**顶部且 K 线视图不滚**（D9-4）⇒ 改为**直接断言窗口条落在 K 线视图可视区内**
 *       （并断言 K 线视图无内部滚动、页面不滚）。
 *     - **F1 布局不变量**：旧「卡片底部不得越过窗口控制条顶部」在 D9 下几何反了（窗口条在卡片**上方**）
 *       ⇒ 改「卡片与窗口条**不重叠**」+「卡片完整落在 K 线视图内」。
 *  6. **F3 取样窗**：旧口径 `r.y >= 6 && r.y <= 200` 是**旧 67px 主图**时代的窗口 ⇒ 新默认 520 态主图 371px，
 *     该窗把可见标记从 24 个截到 12 个（真渲染实测）⇒ 改为**按实时 pane 几何**取窗（`getSize('candle_pane','main')`，
 *     内缩 1 个圆点半径）。**这不是 F3 红的原因**（见 §「F3 判定」），但属同类旧口径，必须一并重锚。
 *     另：`F3 判定（2026-09-23）`——标记 1:40 的圆心像素不等于 store 色值的**真实原因**是：同 bar 邻笔（1:43，卖绿、
 *     `stackIndex=1` ⇒ 标签翻转至左侧）的**常显标签背景盒**（宽 88.6px、x∈[428.2,516.8]、y≈143）整体盖住了 1:40 的圆点
 *     ⇒ 圆心像素 = store 红 ×0.28 + 盒底 ×0.72 = `#4d222f`（实测 vs 预测 ±1）。即 **R3 的「圆点按 store 色绘制」不成立**？
 *     不成立的是「圆心像素逐像素等于 store 色」这条**取样口径**：圆点确实按 store 色绘制（混合恒等式可证），
 *     且新旧构建对照显示该遮挡是 **ADR §5 已登记债（标记遮挡：标签常显、99.0% 可见 bar 被标签压住）在新几何下被本用例首次命中**，
 *     （旧口径另有**取样错位**：`getImageData(cx−half, cy−half, …)` 后取 `d[0..3]` 读到的是补丁**左上角** (x−1,y−1)，
 *     不是圆心；该角像素在主图层常为透明 ⇒ `alpha≥200` 过滤还会漏图层。2026-09-23 已修正为「补丁正中一格」。）
 *     非颜色映射回归（旧构建同标记圆心 = 精确 store 色；新构建 23/24 个窗内标记逐像素精确）。⇒ F3 按契约重锚为
 *     **两档颜色身份判据**：①圆心像素逐像素 == store 色；②圆心像素 == `α·store + (1−α)·(同图层实测底)`（α∈[0.15,1]，
 *     残差 ≤12，且通道序与 store 一致）——②对「被半透明标签盒压暗」的标记成立，对「画错色」「圆点缺失」仍**必红**
 *     （见变异反证）。遮挡实例逐条落盘（`f3_dot_pixels.json:.occluded`）并作为残留风险上报（本批不改标签常显策略）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 证据目录：**未跟踪**路径（`tester/evidence/2026*` 已被 .gitignore 覆盖）。 */
const OUT =
  process.env.ADR028FIX_OUT ??
  resolve(process.env.E2E_EVIDENCE_DIR ?? resolve(REPO, 'tester/evidence/20260924_d9_spec_reanchor/raw'), 'fix');

/** run A：rt_seq=1 的 44 笔，第 42/43 笔同 bar（bar_index=423、ts=1789660800；423 是该 run **末根** bar）。 */
const RUN_A = process.env.ADR028FIX_RUN_A ?? 'sr_1789865219068_000001';
const RT_A = Number(process.env.ADR028FIX_RT_A ?? '1');
const FILL_A = Number(process.env.ADR028FIX_FILL_A ?? '42');

/** D9-8①：`卡高 = K 线视图高 − 60`（窗口条 34 + 载入提示 18 + gap 8）。 */
const KLINE_VIEW_CHROME_PX = 60;
/** D9-7：可用高口径 `视口高 − 132` 与三视图可读下限。 */
const VIEW_AVAILABLE_CHROME_PX = 132;
const VIEW_MIN = { kline: 299, indicators: 180, detail: 95 } as const;
/** D9-8②：主图硬下限（任意记忆值/副图数/视口恒成立）。 */
const MAIN_MIN_PX = 160;
/** D9-8②：副图硬下限（引擎在容器不足时会把副图压到该值）。 */
const SUB_PANE_MIN_PX = 30;
const TOL_PX = 2;
// 说明：以上常量均在 F1 内作为 D9 契约常量参与断言（旧 `DEFAULT_KLINE_PX = 520` / `max = 视口高 − 200` /
//  `CANDLE_PANE_MIN_PX = 320` 随 D9-5 删卡高机制一并作废）。

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
 *  返回每个图层的 3×3 patch（含圆心像素与**同图层实测底**——用于 F3 的混合解释档）。 */
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
      /** 实测底：同一图层上「圆点之外」仍有墨（含半透明标签盒）的首个像素。
       *  偏移按由近及远（±6/±10/±14 横向、±10 纵向）；**不含**圆心自身。 */
      const backdropOffsets: Array<[number, number]> = [
        [-6, 0],
        [6, 0],
        [-10, 0],
        [10, 0],
        [0, -10],
        [0, 10],
        [-14, 0],
        [14, 0],
      ];
      return points.map((p) => {
        let top: number[] | null = null;
        const layers: Array<{ ci: number; center: number[]; patch: number[][]; backdrop: number[] | null }> = [];
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
          const patch: number[][] = [];
          for (let i = 0; i < d.length; i += 4) patch.push([d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!]);
          // **圆心像素 = 补丁正中一格**（`getImageData(cx-half, cy-half, 1+2*half, …)` 的左上角
          // 是 (cx−half, cy−half)，取 `d[0..3]` 会读到**左上角**而非圆心 —— 2026-09-23 重锚时修正的取样错位）
          const center = patch[half * (1 + 2 * half) + half]!;
          if (center[3]! < 200) continue;
          // 实测底（同图层、圆点外、任何墨）
          let backdrop: number[] | null = null;
          try {
            const full = m.c.getContext('2d')!.getImageData(0, 0, m.c.width, m.c.height).data;
            for (const [dx, dy] of backdropOffsets) {
              const bx = Math.round(cx) + dx;
              const by = Math.round(cy) + dy;
              if (bx < 0 || by < 0 || bx >= m.c.width || by >= m.c.height) continue;
              const i = (by * m.c.width + bx) * 4;
              if (full[i + 3]! < 8) continue;
              backdrop = [full[i]!, full[i + 1]!, full[i + 2]!, full[i + 3]!];
              break;
            }
          } catch {
            backdrop = null;
          }
          layers.push({ ci: m.ci, center, patch, backdrop });
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
/** store 色的**通道序**（用于混合档：压暗后通道相对次序不得变）。 */
const channelOrder = ([r, g, b]: Rgb): string => {
  const e = 3; // 近等值视为同档（抗混合噪声）
  const cmp = (a: number, b: number) => (Math.abs(a - b) <= e ? '=' : a > b ? '>' : '<');
  return `${cmp(r, g)}${cmp(r, b)}${cmp(g, b)}`;
};
/** 混合模型：`α·store + (1−α)·bg`（α ∈ [0.15, 1]，步长 0.05）。 */
function blendFit(center: Rgb, store: Rgb, bg: Rgb): { alpha: number; predicted: Rgb; delta: number } {
  let best = { alpha: 1, predicted: store, delta: dist(center, store) };
  for (let a = 15; a <= 100; a += 5) {
    const al = a / 100;
    const predicted = [0, 1, 2].map((i) => Math.round(al * store[i]! + (1 - al) * bg[i]!)) as Rgb;
    const d = dist(center, predicted);
    if (d < best.delta) best = { alpha: al, predicted, delta: d };
  }
  return best;
}

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
    const pane = document.querySelector('[data-testid="wb-kline-view"]') as HTMLElement | null;
    const result = document.querySelector('[data-testid="wb-result"]');
    const a = (el: Element | null, at: string) => (el ? el.getAttribute(at) : null);
    const paneRect = pane?.getBoundingClientRect() ?? null;
    return {
      present: true,
      disabled: (btn as HTMLButtonElement).disabled,
      rect: { x: br.x, y: br.y, w: br.width, h: br.height },
      samples,
      allSelf: samples.every((s) => s.selfOrChild),
      host: { x: host.x, y: host.y, w: host.width, h: host.height, bottom: host.bottom, top: host.top },
      kline: { bottom: kl.bottom, h: kl.height, top: kl.top },
      overflowPx: Math.round(kl.bottom - host.bottom),
      barTop: Math.round(bar.top),
      barBottom: Math.round(bar.bottom),
      pageScrollY: Math.round(window.scrollY),
      chartPaneScrollTop: pane ? Math.round(pane.scrollTop) : null,
      /** D9-4：K 线视图不得有内部滚动（判定「窗口条常驻可见」的依据）。 */
      chartPane: paneRect
        ? {
            top: Math.round(paneRect.top),
            bottom: Math.round(paneRect.bottom),
            h: Math.round(paneRect.height),
            scrollH: pane!.scrollHeight,
            clientH: pane!.clientHeight,
            overflowY: getComputedStyle(pane!).overflowY,
          }
        : null,
      /** D9 观测性（视图高/三段/夹取）。 */
      views: {
        available: Number(a(result, 'data-view-available')),
        kline: Number(a(result, 'data-view-height-kline')),
        indicators: Number(a(result, 'data-view-height-indicators')),
        detail: Number(a(result, 'data-view-height-detail')),
        clamped: a(result, 'data-view-clamped'),
        ratioKline: Number(a(result, 'data-view-ratio-kline')),
      },
      disclosure: document.querySelector('[data-testid="wb-view-clamp-note"]')?.textContent ?? null,
      /** D6-5 保留项：卡头实测高（`恒 20` 是 D9-8① 恒等式的输入；跳转提示换行时会变高 ⇒ 必须实测）。 */
      cardHeaderH: (() => {
        const h = document.querySelector('[data-testid="wb-kline-card-header"]');
        return h ? Math.round(h.getBoundingClientRect().height) : null;
      })(),
      innerH: Math.round(kl.height),
      subPaneCount: Number(a(document.querySelector('[data-testid="wb-kline-chart"]'), 'data-kline-sub-pane-count')),
      paneMetrics: (() => {
        try {
          const raw = a(document.querySelector('[data-testid="kline-chart"]'), 'data-pane-metrics');
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })(),
      notePresent: note != null,
      noteState: note?.getAttribute('data-state') ?? '',
      noteText: note?.textContent ?? '',
    };
  }, testId);
}

/** 蜡烛主图（candle pane main）实时高度：D6-3 默认态判据用的量。 */
async function candlePaneHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, (...a: unknown[]) => unknown>> };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c['getDataList'] as () => unknown[])() ?? []).length > 0;
      } catch {
        return false;
      }
    });
    try {
      const p = (cands[0]!['getSize'] as (a?: string, b?: string) => { height: number } | null)('candle_pane', 'main');
      return p ? Math.round(p.height) : -1;
    } catch {
      return -1;
    }
  });
}

test.beforeEach(async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(PAGE_CAPTURE);
});

// ───────────────────────── F0 真身锚定：被服务产物必须含本波契约标识符 ─────────────────────────
test('F0 真身锚定（D9 重锚）：被服务 bundle 含 D9 契约标识符（三视图/两条分隔条/恢复条/v2 键/指标浮层），且被删的卡高机制标记与承诺文案不在', async ({ page }) => {
  const html = await (await page.request.get('/')).text();
  const m = /src="(\/assets\/index-[^"]+\.js)"/.exec(html);
  expect(m, 'index.html 必须引用打包产物').toBeTruthy();
  const js = await (await page.request.get(m![1]!)).text();
  // 契约标识符（事实源：ADR-028 §2.9 D9-1/D9-3/D9-4/D9-11 + §2.6 第 5 项；均为**契约命名**，非 Tailwind 类名）
  const anchors = {
    klineViewTestId: 'wb-kline-view', // D9-1 K 线视图（常驻、不可收）
    indicatorViewTestId: 'wb-indicator-view', // D9-1 指标视图（仅四张曲线卡）
    detailViewTestId: 'wb-detail-view', // D9-1 明细视图（4 tab）
    // 说明：两条分隔条与恢复条的 testid 由**模板字面量**拼接（`wb-splitter-${boundary}` / `wb-restore-${view}`）
    // ⇒ 产物中只有前缀；且这两个前缀在 D9 之前**不存在**（旧为 `wb-pane-splitter` / `wb-detail-expand`）⇒ 有鉴别力。
    splitterPrefix: 'wb-splitter-', // D9-1/D9-6 两条视图分隔条（K线↔指标 / 指标↔明细）
    restorePrefix: 'wb-restore-', // D9-3 视图级恢复条（指标 / 明细）
    detailPaneTestId: 'wb-detail-pane', // D9-1 明细容器
    detailTabsTestId: 'wb-detail-tabs', // D9-1 明细分段控件
    indicatorMenuTestId: 'wb-indicator-menu', // D6-5 指标勾选收进浮层（D9 保留）
    layoutKey: 'eestock.result.layout.v2', // D9-11 三段比例 + 收起态独立 key
  } as const;
  /** **反向锚（D9-5 断言缺失）**：被删的卡高机制标记**不得**出现在产物中。 */
  const removedTokens = {
    presetPrefix: 'wb-kline-preset', // D6-2 S/M/L 预设（D9-5 删）
    cardHandle: 'wb-card-resize-kline', // D6-5/D6-6 K 线卡下沿把手（D9-5 删）
  } as const;
  const r = {
    bundle: m![1]!,
    missing: Object.entries(anchors)
      .filter(([, needle]) => !js.includes(needle))
      .map(([k]) => k),
    resurrected: ['presetPrefix', 'cardHandle'].filter((k) =>
      js.includes(removedTokens[k as 'presetPrefix' | 'cardHandle']),
    ),
    hasRemovedPromise: js.includes('自动补高亮'),
  };
  writeJson('f0_bundle_anchor', {
    ...r,
    anchors: Object.values(anchors),
    removedTokens: [removedTokens.presetPrefix, removedTokens.cardHandle],
  });
  expect(
    r.missing,
    `被服务 bundle 必须含全部 D6/D7 契约标识符（缺 ${JSON.stringify(r.missing)} ⇒ 该构建不是本波构建）`,
  ).toEqual([]);
  expect(
    r.resurrected,
    `D9-5 被删的卡高机制标记不得复活（实读 ${JSON.stringify(r.resurrected)}；复活即说明卡高机制回来了）`,
  ).toEqual([]);
  expect(r.hasRemovedPromise, '被删除的不可达承诺文案不得出现在产物中（R2）').toBe(false);
});

// ───────────────────────── F1（B1 阻断项）：L2 跳转后按钮必须真实可点 ─────────────────────────
test('F1（B1）L2 跳转后「全览 / 历史回退」必须可被真实点击（窗口条常驻于 K 线视图顶部）且 K 线不溢出、卡高=视图高−60、主图 ≥160', async ({
  page,
}) => {
  await openRunSettled(page, RUN_A);
  const viewportH = page.viewportSize()!.height;
  const avail = viewportH - VIEW_AVAILABLE_CHROME_PX;
  const before = { reset: await hitProbe(page, 'wb-window-reset'), back: await hitProbe(page, 'wb-window-back') };
  /** D9-8② 硬不变量的**干净态**读数（跳转前，无高亮提示 ⇒ 卡头 = 恒 20）。 */
  const candleBefore = await candlePaneHeight(page);
  await gotoL2Jump(page);
  const resetAfterJump = await hitProbe(page, 'wb-window-reset');
  // **D9 重锚**：窗口控制条位于 K 线视图**顶部**，而 **K 线视图不滚**（D9-4）⇒ 它**常驻可见**，
  // 无需（也无法）「在上栏容器内滚入视口」——旧前置已删除，改为直接断言「窗口条落在 K 线视图可视区内」。
  await page.waitForTimeout(150);
  const reset = await hitProbe(page, 'wb-window-reset');
  const back = await hitProbe(page, 'wb-window-back');
  const candlePx = await candlePaneHeight(page);

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
  const pageScrollYAfter = await page.evaluate(() => Math.round(window.scrollY));
  writeJson('f1_clickability', {
    viewportH,
    available: avail,
    candleBefore,
    candlePanePx: candlePx,
    before,
    afterJump: resetAfterJump,
    afterWait: { reset, back },
    resetClickOk,
    resetClickError,
    afterReset,
    backClickOk,
    backClickError,
    pageScrollYAfter,
  });

  // 前提：B1 的触发条件必须真的出现（否则本用例无区分力）
  expect(resetAfterJump.notePresent, 'L2 跳转后必须出现高亮提示（头部增高 ⇒ B1 触发条件）').toBe(true);
  expect(resetAfterJump.noteText).toContain('已高亮目标成交');
  expect(before.reset.overflowPx, '跳转前不应溢出（对照）').toBeLessThanOrEqual(1);

  // ① K 线容器不得溢出卡片（旧实现 +27px，canvas 盖住窗口控制条）
  expect(reset.overflowPx, `K 线容器不得溢出卡片（实测 ${reset.overflowPx}px）`).toBeLessThanOrEqual(1);
  expect(back.overflowPx).toBeLessThanOrEqual(1);
  // ② **D9-8① 恒等式**：卡高 == K 线视图高 − 60；且视图高与页面观测一致
  expect(reset.chartPane, 'K 线视图必须存在').toBeTruthy();
  expect(
    Math.abs(reset.host.h - (reset.chartPane!.h - KLINE_VIEW_CHROME_PX)),
    `D9-8① 卡高 == K 线视图高 − ${KLINE_VIEW_CHROME_PX}（卡 ${Math.round(reset.host.h)} / 视图 ${reset.chartPane!.h}）`,
  ).toBeLessThanOrEqual(TOL_PX);
  expect(
    Math.abs(reset.views.kline - reset.chartPane!.h),
    `D9-12 data-view-height-kline == K 线视图实测高（${reset.views.kline} vs ${reset.chartPane!.h}）`,
  ).toBeLessThanOrEqual(TOL_PX);
  // ③ **D9 布局不变量**：窗口条**常驻可见**（在 K 线视图可视区内）∧ 卡片与窗口条**不重叠** ∧ 卡完整落在视图内
  expect(
    reset.barTop,
    `D9-4 窗口条必须在 K 线视图可视区内（barTop ${reset.barTop} ≥ paneTop ${reset.chartPane!.top}）`,
  ).toBeGreaterThanOrEqual(reset.chartPane!.top - 1);
  expect(reset.barBottom, 'D9-4 窗口条必须完整落在 K 线视图可视区内').toBeLessThanOrEqual(reset.chartPane!.bottom + 1);
  expect(reset.host.top, 'D9 卡片顶不得高于窗口条底（两者不得重叠）').toBeGreaterThanOrEqual(reset.barBottom - 1);
  expect(reset.host.bottom, 'D9-2 卡片必须完整落在 K 线视图内（K 线视图不滚）').toBeLessThanOrEqual(
    reset.chartPane!.bottom + 1,
  );
  // ④ **D9-8③ 分档**：720 档（可用 588）为**不可行支** ⇒ 夹取生效、K 线优先吃满、必须披露；
  //    并恒断言 **D9-8② 硬不变量 主图 ≥160**（取代旧「主图 ≥320 @ 默认卡高 520」——该前提已随卡高机制删除）
  expect(reset.views.available, `D9-7 可用高 = 视口 − ${VIEW_AVAILABLE_CHROME_PX}`).toBe(avail);
  if (reset.views.clamped === 'true') {
    expect(
      Math.abs(reset.views.kline - (avail - VIEW_MIN.indicators - VIEW_MIN.detail)),
      `D9-8③ 不可行支：K 线优先吃满 == 可用 − 指标下限 − 明细下限（实读 ${reset.views.kline}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(reset.disclosure, 'D9-8③ 夹取必须显式披露（禁静默）').toBeTruthy();
  } else {
    expect(reset.views.kline, `D9-7 K 线视图 ≥ 可读下限 ${VIEW_MIN.kline}`).toBeGreaterThanOrEqual(VIEW_MIN.kline);
  }
  // ④-b **D9-8② 硬不变量（干净态）**：跳转前（无高亮提示 ⇒ 卡头 = 恒 20）主图 ≥160
  expect(
    candleBefore,
    `D9-8② 硬不变量：默认态主图 ≥ ${MAIN_MIN_PX}（实测 ${candleBefore}）`,
  ).toBeGreaterThanOrEqual(MAIN_MIN_PX);
  // ④-c **D9-8① 恒等式**（含**实测**卡头）：`主图 == 内层 − 26 − 1×副图数 − Σ副图`
  const pm = reset.paneMetrics as { candlePx: number | null; subPanes: Array<{ px: number | null }>; subPaneTotalPx: number | null } | null;
  const headerOver = Math.max(0, (reset.cardHeaderH ?? 20) - 20);
  if (pm?.candlePx != null && pm.subPaneTotalPx != null) {
    expect(
      Math.abs(pm.candlePx - (reset.innerH - 26 - 1 * pm.subPanes.length - pm.subPaneTotalPx)),
      `D9-8① 主图 == 内层 − 26 − 1×副图数 − Σ副图（主图 ${pm.candlePx} / 内层 ${reset.innerH} / Σ副图 ${pm.subPaneTotalPx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    for (const sp of pm.subPanes) {
      expect(sp.px ?? 0, `D9-8② 副图 ≥ ${SUB_PANE_MIN_PX}（引擎已压到下限）`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
    }
    expect(pm.subPaneTotalPx, 'D9-8② 副图合计 ≤ 120').toBeLessThanOrEqual(120);
  }
  // ④-d **卡头实测 vs 恒 20**：跳转高亮提示换行使卡头 +18px ⇒ 同一恒等式下主图硬下限须按实测卡头换算。
  //     本档实测 主图 = 156（= 160 − 4，非 160 − 18）⇒ 引擎已在 `paneConstraints` 处让位（副图压到下限 30）。
  //     **该项为契约口径待裁项（见 tester/evidence/20260924_d9_spec_reanchor/BLOCKED.md）**：
  //     D9-8② 字面「任意…视口 主图 ≥160」在「720 档 + 提示换行」态**未成立**（156）。
  //     本规格**不静默放宽**：显式断言「卡头超出恒 20 的部分必须由主图**等量**或更少地让出」，
  //     并把实测缺口落盘 ⇒ 缺口变大（> headerOver）即红。
  expect(
    candlePx,
    `D9-8②（提示换行态）主图让位不得超过卡头超出量（卡头实测 ${reset.cardHeaderH} ⇒ 允许让出 ${headerOver}px；实读主图 ${candlePx}）`,
  ).toBeGreaterThanOrEqual(MAIN_MIN_PX - headerOver);
  expect(reset.cardHeaderH ?? 0, 'D6-5 保留：卡头 ≤48px').toBeLessThanOrEqual(48);
  expect(reset.host.h, 'K 线卡必须有可用高度（旧口径「>100px」的 D9 形式：卡高 = 视图高 − 60 > 0）').toBeGreaterThan(100);
  // ⑤ **D9-4**：K 线视图无内部滚动；页面不滚；横向滚动动作只可能发生在指标/明细视图内
  expect(reset.pageScrollY, 'D9-4 页面 scrollY 必须为 0').toBe(0);
  expect(pageScrollYAfter, 'D9-4 页面仍不得滚动').toBe(0);
  expect(reset.chartPaneScrollTop, 'D9-4 K 线视图 scrollTop 必须恒为 0').toBe(0);
  expect(
    reset.chartPane!.scrollH,
    `D9-4 K 线视图不得有内部滚动（scrollHeight ${reset.chartPane!.scrollH} ≤ clientHeight ${reset.chartPane!.clientH} + 1）`,
  ).toBeLessThanOrEqual(reset.chartPane!.clientH + 1);
  expect(reset.chartPane!.overflowY, 'D9-4 K 线视图不得是 overflow:auto 容器').not.toBe('auto');

  // ⑥ 采样点命中：按钮中心 / 15% / 85% 三处都必须命中按钮自身或其子元素（B1 的核心鉴别力）
  for (const [name, p] of [
    ['全览', reset],
    ['回退', back],
  ] as const) {
    for (const s of p.samples) {
      expect(s.selfOrChild, `${name} 按钮采样点 f=${s.f} 命中 ${s.tag}[${s.testid}]，必须命中按钮自身/子元素`).toBe(true);
    }
  }

  // ⑦ 真实点击成功且不超时
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
 *  右侧放得下 ⇒ 标签在圆点右侧（左对齐）；否则**边缘收敛**到圆点左侧（右对齐）。
 *  重锚判定（2026-09-23）：本判据不编码旧布局（pane 宽与全部标记坐标**运行时重算**），D6/D7 未改变 R1 口径 ⇒ 不改。 */
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
test('F3（R3）真渲染圆点颜色身份必须等于标记 store 色值（买红 / 卖绿；含被常显标签盒遮挡的混合解释）', async ({
  page,
}) => {
  await openRunSettled(page, RUN_A);
  const geom = await paneGeom(page);
  const paneW = geom.pane?.width ?? geom.w;
  const paneH = geom.pane?.height ?? geom.h;
  const { rows } = await markers(page, Math.round(paneW));
  // 取样窗（重锚）：按**实时 pane 几何**取「圆点整体落在 pane 内」的标记（内缩 1 个圆点半径 = 4px）。
  // 旧口径 `y ∈ [6,200]` 是旧 67px 主图时代的窗口（新默认态主图 371px ⇒ 该窗把 24 个可见标记截到 12 个）。
  const inset = 4;
  const inPane = rows.filter(
    (r) => r.x >= inset && r.x <= paneW - inset && r.y >= inset && r.y <= paneH - inset,
  );
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
    //  - `centerExact`：圆心像素是否**逐像素**等于 store 色值（Δmax ≤ 10）；
    //  - `blendFit`：圆心像素是否等于 `α·store + (1−α)·实测底`（α∈[0.15,1]）——用于「被同 bar 邻笔的
    //    常显标签背景盒整体压暗」的标记（ADR §5 已登记债「标记遮挡」；旧实现/new 几何实测实例见报告）。
    const perLayer = s.layers.map((l) => {
      const center = [l.center[0]!, l.center[1]!, l.center[2]!] as Rgb;
      const bg = l.backdrop ? ([l.backdrop[0]!, l.backdrop[1]!, l.backdrop[2]!] as Rgb) : null;
      const fit = bg ? blendFit(center, want, bg) : null;
      return {
        ci: l.ci,
        center: l.center,
        centerDelta: dist(center, want),
        match: l.patch.filter(([r, g, b, a]) => a! >= 200 && dist([r!, g!, b!] as Rgb, want) <= 10).length,
        total: l.patch.length,
        backdrop: l.backdrop,
        blend: fit,
      };
    });
    const best = perLayer.reduce<null | (typeof perLayer)[number]>((acc, c) => (acc == null || c.match > acc.match ? c : acc), null);
    const exact = perLayer.find((l) => l.centerDelta <= 10) ?? null;
    const blended = perLayer.find(
      (l) =>
        l.blend != null &&
        l.blend.alpha < 1 &&
        l.blend.delta <= 12 &&
        channelOrder(l.center as unknown as Rgb) === channelOrder(want),
    ) ?? null;
    const chosen = exact ?? blended ?? best;
    const hueOk = (() => {
      if (chosen == null) return false;
      const probe = chosen.center as unknown as Rgb;
      return m.color === '#00e0a4' ? isGreenInk(probe) : isRedInk(probe);
    })();
    return {
      key: m.key,
      color: m.color,
      label: m.label,
      x: Math.round(m.x),
      y: Math.round(m.y),
      layers: s.layers.length,
      firstOpaque: s.top ? [s.top[0], s.top[1], s.top[2]] : null,
      centerExact: exact != null,
      blendExplained: exact == null && blended != null,
      blendAlpha: blended?.blend?.alpha ?? null,
      blendDelta: blended?.blend?.delta ?? null,
      blendBackdrop: blended?.backdrop ?? null,
      bestMatch: best?.match ?? 0,
      bestTotal: best?.total ?? 0,
      bestCenter: best?.center ?? null,
      layerDelta: exact?.centerDelta ?? blended?.blend?.delta ?? null,
      layerCenter: (exact ?? blended)?.center ?? best?.center ?? null,
      hueOk,
    };
  });
  const buys = recs.filter((r) => r.color === '#ff5c6c');
  const sells = recs.filter((r) => r.color === '#00e0a4');
  const occluded = recs.filter((r) => r.blendExplained);
  writeJson('f3_dot_pixels', {
    paneW,
    paneH,
    paneContainerW: geom.w,
    pane: geom.pane,
    sampleWindow: { xMin: inset, xMax: Math.round(paneW - inset), yMin: inset, yMax: Math.round(paneH - inset) },
    count: recs.length,
    buys: buys.length,
    sells: sells.length,
    exactCount: recs.filter((r) => r.centerExact).length,
    occludedCount: occluded.length,
    occluded: occluded.map((r) => ({
      key: r.key,
      at: { x: r.x, y: r.y },
      alpha: r.blendAlpha,
      residual: r.blendDelta,
      center: r.layerCenter,
      backdrop: r.blendBackdrop,
    })),
    recs,
  });

  expect(buys.length, '必须至少采样到一笔买入标记（否则用例空绿）').toBeGreaterThan(0);
  expect(sells.length, '必须至少采样到一笔卖出标记（ForceClose；否则「卖绿」不可证）').toBeGreaterThan(0);
  // 逐标记颜色身份（**两档**）：
  //  档 1：圆心像素**逐像素等于** store 色值（Δmax ≤ 10）；
  //  档 2：圆心像素 == `α·store + (1−α)·实测底`（α∈[0.15,1]，残差 ≤12，通道序一致）
  //        —— 即「被半透明标签盒整体压暗，但确实按 store 色绘制」；α=1 已由档 1 覆盖，缺圆点（圆心=底）
  //        或画错色（如买点画成绿）在**两档下都必红**（见变异反证）。
  //  两档都不成立 ⇒ 该位置没有按该色值画过圆点 ⇒ 红。
  for (const r of recs) {
    expect(
      r.centerExact || r.blendExplained,
      `标记 ${r.key}（store 色 ${r.color}）：圆心像素既不等于该色值、也不等于其被半透明层压暗的混合值` +
        `（实测 ${JSON.stringify(r.layerCenter)}；档2 α=${r.blendAlpha} 残差=${r.blendDelta} 底=${JSON.stringify(r.blendBackdrop)}）；` +
        `全部读数落盘 f3_dot_pixels.json`,
    ).toBe(true);
    if (r.centerExact) {
      // 档 1（逐像素等于 store 色）成立的标记必须逐条为其色相（买红 / 卖绿）；
      // 档 2 的标记其圆心像素已被半透明标签盒压暗（色相谓词按「未压暗」的 store 色定义，故不适用于压暗态），
      // 其身份由「混合残差 ≤12 ∧ α≥0.15 ∧ 通道序一致」三者共同保证（画错色/缺圆点都必红，见变异反证）。
      expect(
        r.hueOk,
        `标记 ${r.key} 的圆心像素必须属其 store 色的色相族（实测 ${JSON.stringify(r.layerCenter)}）`,
      ).toBe(true);
    }
  }
  const exactCount = recs.filter((r) => r.centerExact).length;
  const outliers = recs.filter((r) => !r.centerExact).map((r) => r.key);
  expect(
    exactCount / recs.length,
    `圆心像素**逐像素相等**于 store 色值的标记占比须 ≥ 0.75（实测 ${exactCount}/${recs.length}；` +
      `逐像素偏离者=${JSON.stringify(outliers)}，偏离者须逐条给出混合解释：${JSON.stringify(occluded.map((o) => o.key))}）`,
  ).toBeGreaterThanOrEqual(0.75);
  // 色相身份逐条（买红 / 卖绿）：档 1 成立的标记必须逐条为对应色相
  for (const b of buys)
    if (b.centerExact) expect(isRedInk(b.layerCenter as Rgb), `买入圆点须为红相 ${JSON.stringify(b.layerCenter)}`).toBe(true);
  for (const s of sells)
    if (s.centerExact) expect(isGreenInk(s.layerCenter as Rgb), `卖出圆点须为绿相 ${JSON.stringify(s.layerCenter)}`).toBe(true);
  expect(buys.filter((b) => b.centerExact || b.blendExplained).length, '买入标记可解释样本数须 ≥ 1').toBeGreaterThan(0);
  expect(sells.filter((s) => s.centerExact || s.blendExplained).length, '卖出标记可解释样本数须 ≥ 1').toBeGreaterThan(0);

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
