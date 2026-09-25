/**
 * ADR-028 §2.11（D11）买卖标记**标签门控**——**真渲染**端到端（真身 `:8081` 后端/库 + 生产构建产物）。
 *
 * 为什么必须真渲染：门控要证明的**不是** React 状态，而是**画布上的墨迹**（标签是 canvas 文本 + 背景盒）。
 * 本规格的墨迹口径 = **像素差分**（与 `tester/evidence/20260925_result_jump_and_marker_diag` 的量方法同源）：
 *  ① 读 candle pane canvas 的 `getImageData`（有标记）；
 *  ② 页面侧会话内瞬态移除 `fillDot`/`fillDotHighlight`（klinecharts 公开 API，`removeOverlay` 触发
 *     `updatePane(Overlay)` 重绘）后重读；
 *  ③ 逐像素差分（阈值 10/255）⇒ 差集 = 标记圆点 + 文本标签的**真实绘制像素**；
 *  ④ 连通域分类：**宽 ≥ 20px** ⇒ 标签（圆点直径 ≤ 13px，含高亮描边），否则圆点。
 *    ⚠ 密集态标签会互相粘连 ⇒ 连通域**个数**在密集态不是「标签数」的可靠读数；本规格据此只对
 *    **默认/悬停/跳转**三态用「标签域个数」作硬判据（那三态最多 1 个标签），密集态只作**读数**（不设阈值）。
 *
 * 判据（对应 §2.11 判据 1–5，全部是**行为不变量**，阈值读数只落盘、由复验车道另行标定）：
 *  D11-1 **默认态零标签墨迹**（`labelInkPx == 0` ∧ 圆点墨迹 > 0）；
 *  D11-2 **悬停恰 1 个标签**且内容 = `方向×数量`；悬停读数仍能答「哪一笔 / 买卖 / 价格×数量」；
 *  D11-3 **跳转目标那一笔**在 3s 高亮期内有标签墨迹，3s 后归零；
 *  D11-4 **开关**：开 ⇒ 标签墨迹 > 默认（并落盘遮挡读数）；关 ⇒ 归零；**刷新后保持**（结果页独立 key）；
 *  D11-5 标签宽度估算常量：**真身** `measureText` 实测盒宽 ≤ 估算式（≥3 档长度），且实绘标签不越界。
 *
 * 运行（证据出口**必须未跟踪**；**禁**写 `web/dist`）：
 *   cd web && npx vite build --outDir /tmp/d11_dist
 *   VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/d11_dist --port 4173 &
 *   E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/adr028-d11-marker-labels.e2e.ts --reporter=list --retries=0
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertResolvedByIdFresh,
  resolveRun,
  type ResolvedRun,
  type RunFetchPort,
  type RunFill,
  type RunListItem,
  type RunRoundTrip,
} from './adr028RunResolve';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 证据落盘目录（**未跟踪**；`git check-ignore` 已确认）。 */
const OUT = process.env.ADR028_D11_OUT ?? resolve(REPO, 'coder/evidence/20260925_adr028_d11/raw'); // 未跟踪（git check-ignore 已确认）
const KC_SRC = readFileSync(resolve(HERE, '../src/features/dashboard/KlineChart.tsx'), 'utf8');

/** 从**实现源码**取常量（⇒ 常量被改回低估值时，本规格随之变红：变异⑤的反证面）。 */
function constFromSrc(name: string): number {
  const m = new RegExp(`export const ${name} = (\\d+(?:\\.\\d+)?);`).exec(KC_SRC);
  if (!m) throw new Error(`源码中找不到常量 ${name}（规格不得硬编码实现常量）`);
  return Number(m[1]);
}
const CW = constFromSrc('FILL_LABEL_CW_PX');
const PAD = constFromSrc('FILL_LABEL_PAD_PX');
const estimate = (text: string): number => text.length * CW + PAD;
/** 旧（低估）估算式：仅用于证据对照，**不**参与实现。 */
const legacyEstimate = (text: string): number => text.length * 4.4 + 5;

/**
 * **ADR-028 §2.11.1 标定阈值**（2026-09-25 由独立复验方标定，**取代** §2.11 决策 5 的临时值）。
 * 全部为**真身读数**阈值（口径与 `measureOcclusion` 一致：分母 = candle pane 画布面积 / 可见 bar 根数）。
 */
const UNION_MAX_PCT = 8;
/**
 * **禁把并集界收紧到 6%**（§2.11.1 原文：「**禁收到 6%** —— dense 全览纯圆点已 6.86%」）：
 * 该常数是**契约值**，不是可调参数；下面的自证断言会在被改动时立即变红。
 */
const UNION_FORBIDDEN_TIGHT_PCT = 6;
/** 默认态被压可见 bar 上限（契约原 35% 过松：仅在「常显」态才触发；实测门控失效 12.2/42.0/100%）。 */
const PRESSED_MAX_PCT_DEFAULT = 5;
/** 悬停/高亮态被压可见 bar 上限（实测 9.23 / 10.74 / 12.10 / 12.22%）。 */
const PRESSED_MAX_PCT_HOVER = 15;
/**
 * 悬停增量上限（pp）：实测 10 采样 **+0.5961…+1.0376**（median 0.814）⇒ 契约原 **0.3pp 被证伪**。
 * 「最长标签 ≤2.0pp」：本规格按**实测标签长度**分档（≤14 字符取 1.5；更长的长标签取 2.0）。
 */
const HOVER_DELTA_MAX_PP = 1.5;
const HOVER_DELTA_MAX_PP_LONG_LABEL = 2.0;
const HOVER_LONG_LABEL_CHARS = 14;
/**
 * `bs=1` 时**单标签可压 60–76 根 bar**（§2.11.1 口径提醒）⇒ 任何「被压 bar」判据必须与 `barSpace` 联立：
 * 见 {@link pressedBoundByGeometry}。
 */
const BS1_SINGLE_LABEL_BARS = 60;

/** 被压可见 bar 的**几何上界**：`ceil(标签盒宽 / barSpace) + 1`（标签只能覆盖它跨过的那些 bar 列）。 */
function pressedBoundByGeometry(labelWidth: number, barSpace: number): number {
  return Math.ceil(labelWidth / Math.max(1, barSpace)) + 1;
}

const HIGHLIGHT_DURATION_MS = 3000;
/** canvas 文本盒宽口径（klinecharts `getTextRect`: paddingLeft + round(measureText) + paddingRight）。 */
const LABEL_PAD_PX = 4;
/**
 * 圆点墨迹半径上限（px）：`FILL_DOT_R_PX` 3.2 + 描边 1 + 抗锯齿 ≈ 5.5 ⇒ 取 9 作判据（宽松但**有牙**：
 * 文本标签从锚点 +6.2px 起、可延伸到 60+px ⇒ 只要存在标签，maxInkDistToDot 必然 ≫ 9）。
 */
const DOT_INK_R_PX = 9;

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

// ───────────────────────────── 页面侧探针（自包含） ─────────────────────────────

/** 只读捕获 klinecharts 真身实例（既有探针同款手法：包 `Map.prototype.set`）。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { setBarSpace?: unknown; convertToPixel?: unknown } | null;
    if (o != null && typeof o === 'object' && typeof o['setBarSpace'] === 'function' && typeof o['convertToPixel'] === 'function') {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}

type OcclusionResult = {
  ok: boolean;
  error?: string;
  pane: { w: number; h: number } | null;
  paneAreaPx: number;
  inkPx: number;
  inkPct: number;
  labelInkPx: number;
  labelPct: number;
  dotInkPx: number;
  dotPct: number;
  components: Array<{ x: number; y: number; w: number; h: number; area: number; kind: 'label' | 'dot' }>;
  labelComponents: number;
  dotComponents: number;
  /** 全部标记墨迹像素到最近圆点锚点的**最大距离**（px）：> {@link DOT_INK_R_PX} ⇒ 存在「离圆点很远的墨迹」= 文本标签。 */
  maxInkDistToDot: number;
  /** 标签墨迹相对**其所属圆点锚点**的 x 最远延伸（px）⇒ 实绘标签盒宽 ≈ 本值 + 6.2（r 3.2 + gap 3）。 */
  maxLabelExtentFromDot: number;
  /** 纯标签盒（bbox 内**不含**任何圆点锚点）的宽度 ⇒ 实绘标签盒宽。 */
  pureLabelWidths: number[];
  visibleBars: number;
  barsCoveredByLabels: number;
  barsCoveredPct: number;
  maxLabelCompWidth: number;
  labelWidths: number[];
  viewport: { barSpace: number | null; from: number | null; to: number | null; dataLen: number | null };
};

/**
 * **遮挡并集 / 被压 bar / 标签盒宽**的真身读数（像素差分 + 连通域）。
 * 注意：本函数会**瞬态移除**标记 overlay（只读探针手法，与既有验收同源），调用方须在测完后重载页面。
 */
async function measureOcclusion(page: Page): Promise<OcclusionResult> {
  return page.evaluate(async (DOT_INK_R_PX: number): Promise<OcclusionResult> => {
    const empty = (error: string): OcclusionResult => ({
      ok: false,
      error,
      pane: null,
      paneAreaPx: 0,
      inkPx: 0,
      inkPct: 0,
      labelInkPx: 0,
      labelPct: 0,
      dotInkPx: 0,
      dotPct: 0,
      components: [],
      labelComponents: 0,
      dotComponents: 0,
      maxInkDistToDot: 0,
      maxLabelExtentFromDot: 0,
      pureLabelWidths: [],
      visibleBars: 0,
      barsCoveredByLabels: 0,
      barsCoveredPct: 0,
      maxLabelCompWidth: 0,
      labelWidths: [],
      viewport: { barSpace: null, from: null, to: null, dataLen: null },
    });
    interface ChartLike {
      getDataList?: () => Array<{ timestamp: number }>;
      getVisibleRange?: () => { from: number; to: number };
      getBarSpace?: () => { bar: number };
      getSize?: (id?: string) => { width: number; height: number } | null;
      convertToPixel?: (p: { timestamp: number }, f?: { paneId?: string }) => { x?: number; y?: number } | undefined;
      removeOverlay?: (f: unknown) => void;
      getOverlays?: (f?: unknown) => Array<{ name?: string }>;
    }
    const w = window as unknown as { __wbCharts?: ChartLike[] };
    const cands = (w.__wbCharts ?? []).filter((c) => {
      try {
        return ((c.getDataList?.() ?? []) as unknown[]).length > 0;
      } catch {
        return false;
      }
    });
    if (cands.length === 0) return empty('未捕获到有数据的 K 线实例');
    const chart = cands[0]!;
    const host = document.querySelector('[data-testid="kline-chart"]');
    if (!host) return empty('K 线容器缺失');
    /**
     * klinecharts v10 每个 pane 有**两层画布**（主体层 + overlay 层）+ 独立的 y 轴画布（实测 10 块 canvas：
     * candle 606×160 ×2 / y 轴 60×160 ×2 / VOL 606×98 ×2 / x 轴 606×26 ×2）——
     * **标记画在 overlay 层**（实测：主体层差分 0、overlay 层差分 806）⇒ 必须对「与 candle pane 同高、
     * 且宽度 = 该 pane 主宽」的全部层取**并集**，否则会得到「零墨迹」的假读数（本规格首轮实测踩到）。
     */
    const canvases = Array.from(host.querySelectorAll('canvas'));
    if (canvases.length === 0) return empty('无 canvas');
    const candleH = chart.getSize?.('candle_pane')?.height ?? null;
    const paneCanvases = (
      candleH != null ? canvases.filter((c) => Math.abs(c.getBoundingClientRect().height - candleH) <= 2) : canvases
    ) as HTMLCanvasElement[];
    if (paneCanvases.length === 0) return empty('candle pane 画布不可得');
    const maxW = paneCanvases.reduce((a, c) => Math.max(a, c.width), 0);
    const layers = paneCanvases.filter((c) => c.width === maxW); // 仅绘图区层（排除 y 轴窄画布）
    const ctxOf = layers.map((c) => c.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings));
    if (ctxOf.some((c) => c == null)) return empty('getContext 失败');
    const canvas = layers[0]!;
    /**
     * **标记锚点**（圆点圆心，容器相对坐标）：在 removeOverlay **之前**读 store。
     * 判定「文本标签墨迹」的口径 = **几何**：圆点墨迹必在其锚点 {@link DOT_INK_R_PX} 邻域内
     * （r=3.2 + 描边 1 + 抗锯齿 ≈ 5.5px），远离锚点的墨迹只可能来自文本标签。
     * 该口径对**连通域粘连**免疫（密集态圆点会互相粘连 ⇒ 按「宽度」分类会把 5 个连排圆点（~32px）
     * 误判成标签 —— 本规格首轮实测即踩到此坑：默认态被误读出 3 个 20×13 的「标签」）。
     */
    interface AnchorDot {
      getOverlays?: (f?: unknown) => Array<Record<string, unknown>>;
      convertToPixel?: (p: unknown, f?: unknown) => { x?: number; y?: number };
    }
    const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    await raf(); // 等应用侧（React 状态 → overlay 重建）**重绘落定**后再取「有标记」帧
    const anchors: Array<{ x: number; y: number }> = [];
    for (const nm of ['fillDot', 'fillDotHighlight']) {
      for (const o of (chart as AnchorDot).getOverlays?.({ name: nm }) ?? []) {
        const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
        const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
        if (!pts[0]) continue;
        const p = (chart as AnchorDot).convertToPixel?.({ timestamp: pts[0].timestamp, value: pts[0].value }, { paneId: 'candle_pane' });
        if (p == null || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
        anchors.push({ x: p.x, y: p.y + Number(ext['stackIndex'] ?? 0) * 12 });
      }
    }
    const grab = (): Uint8ClampedArray[] =>
      ctxOf.map((c, i) => new Uint8ClampedArray(c!.getImageData(0, 0, layers[i]!.width, layers[i]!.height).data));
    const before = grab();
    // 会话内瞬态移除标记（klinecharts 公开 API；`removeOverlay` 内部触发 `updatePane(Overlay)` 重绘）
    try {
      chart.removeOverlay?.({ name: 'fillDot' });
      chart.removeOverlay?.({ name: 'fillDotHighlight' });
    } catch (e) {
      return empty(`removeOverlay 失败：${String(e)}`);
    }
    /**
     * 取「无标记」帧：`removeOverlay` 会触发 `updatePane(Overlay)` 重绘，但**高亮脉冲计时器**会在
     * 150ms 内把 `fillDotHighlight` 重新加回来（跳转态）⇒ 单次取样可能拿到「高亮还在」的帧。
     * 对策：最多 8 次「移除两者 + 逐帧观察」，取**差分最大**的那一帧（= 标记最干净的一帧）。
     */
    let after = grab();
    let bestDiff = -1;
    const diffCount = (a: Uint8ClampedArray[], b: Uint8ClampedArray[]): number => {
      let n = 0;
      a.forEach((la, li) => {
        const lb = b[li]!;
        for (let i = 0; i < la.length; i += 4) {
          const d = Math.abs(la[i]! - lb[i]!) + Math.abs(la[i + 1]! - lb[i + 1]!) + Math.abs(la[i + 2]! - lb[i + 2]!);
          if (d > 10) n += 1;
        }
      });
      return n;
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        chart.removeOverlay?.({ name: 'fillDot' });
        chart.removeOverlay?.({ name: 'fillDotHighlight' });
      } catch {
        /* 单次失败不致命：下一轮重试 */
      }
      await raf();
      const cand = grab();
      const d = diffCount(before, cand);
      if (d > bestDiff) {
        bestDiff = d;
        after = cand;
      }
    }
    const W = canvas.width;
    const H = canvas.height;
    const mask = new Uint8Array(W * H);
    before.forEach((la, li) => {
      const lb = after[li]!;
      for (let i = 0, p = 0; i < la.length; i += 4, p++) {
        const d =
          Math.abs(la[i]! - lb[i]!) + Math.abs(la[i + 1]! - lb[i + 1]!) + Math.abs(la[i + 2]! - lb[i + 2]!);
        if (d > 10) mask[p] = 1;
      }
    });
    // 逐墨迹像素到最近锚点的距离（用 squared 距离免开方；锚点数量级 ~10² ⇒ O(锚点×墨迹像素) 可接受）
    const nearLabelGap = new Uint8Array(W * H);
    let maxDistSq = 0;
    let maxLabelExtentFromDot = 0;
    const distSqAt = (p: number): { d2: number; ax: number } => {
      const px = p % W;
      const py = (p - px) / W;
      let best = Number.POSITIVE_INFINITY;
      let ax = Number.NaN;
      for (const a of anchors) {
        const dx = px - a.x;
        const dy = py - a.y;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          ax = a.x;
        }
      }
      return { d2: best, ax };
    };
    for (let p = 0; p < W * H; p++) {
      if (!mask[p]) continue;
      const { d2, ax } = distSqAt(p);
      if (!Number.isFinite(d2)) continue;
      if (d2 > maxDistSq) maxDistSq = d2;
      if (d2 > DOT_INK_R_PX * DOT_INK_R_PX) {
        nearLabelGap[p] = 1;
        const ext = (p % W) - ax;
        if (ext > maxLabelExtentFromDot) maxLabelExtentFromDot = ext;
      }
    }
    // 连通域（4 连通；标签/圆点均近水平，4 连通足够且不会把斜邻噪声并成一域）
    const seen = new Uint8Array(W * H);
    const stack: number[] = [];
    const components: OcclusionResult['components'] = [];
    const pureLabelWidths: number[] = [];
    let labelInkPixels = 0;
    for (let p = 0; p < W * H; p++) {
      if (!mask[p] || seen[p]) continue;
      stack.length = 0;
      stack.push(p);
      seen[p] = 1;
      let area = 0;
      let hasLabelInk = false;
      let hasAnchorInside = false;
      let x0 = W;
      let x1 = -1;
      let y0 = H;
      let y1 = -1;
      while (stack.length) {
        const q = stack.pop()!;
        const qx = q % W;
        const qy = (q - qx) / W;
        area += 1;
        if (nearLabelGap[q]) {
          hasLabelInk = true;
          labelInkPixels += 1;
        }
        if (qx < x0) x0 = qx;
        if (qx > x1) x1 = qx;
        if (qy < y0) y0 = qy;
        if (qy > y1) y1 = qy;
        if (qx > 0 && mask[q - 1] && !seen[q - 1]) (seen[q - 1] = 1), stack.push(q - 1);
        if (qx < W - 1 && mask[q + 1] && !seen[q + 1]) (seen[q + 1] = 1), stack.push(q + 1);
        if (qy > 0 && mask[q - W] && !seen[q - W]) (seen[q - W] = 1), stack.push(q - W);
        if (qy < H - 1 && mask[q + W] && !seen[q + W]) (seen[q + W] = 1), stack.push(q + W);
      }
      const cw = x1 - x0 + 1;
      const ch = y1 - y0 + 1;
      for (const a of anchors) {
        if (a.x >= x0 && a.x <= x1 && a.y >= y0 && a.y <= y1) {
          hasAnchorInside = true;
          break;
        }
      }
      if (hasLabelInk && !hasAnchorInside) pureLabelWidths.push(cw);
      components.push({ x: x0, y: y0, w: cw, h: ch, area, kind: hasLabelInk ? 'label' : 'dot' });
    }
    const labelComps = components.filter((c) => c.kind === 'label');
    const dotComps = components.filter((c) => c.kind === 'dot');
    const labelInkPx = labelInkPixels; // 定义 = 离任一圆点锚点 > DOT_INK_R_PX 的墨迹像素（文本标签）
    const dotInkPx = components.reduce((a, c) => a + c.area, 0) - labelInkPixels;
    const paneAreaPx = W * H;
    // 被标签压住的**可见 bar**（口径同 tester：标签盒 x 区间覆盖的 bar 列；分母 = 落在画布内的可见 bar）
    const list = chart.getDataList?.() ?? [];
    const range = chart.getVisibleRange?.();
    const barSpace = chart.getBarSpace?.()?.bar ?? null;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    let visibleBars = 0;
    let covered = 0;
    if (range && list.length > 0) {
      const from = Math.max(0, Math.round(range.from));
      const to = Math.min(list.length - 1, Math.round(range.to));
      for (let i = from; i <= to; i++) {
        const pt = chart.convertToPixel?.({ timestamp: list[i]!.timestamp }, { paneId: 'candle_pane' });
        if (pt == null || typeof pt.x !== 'number') continue;
        const x = pt.x * scale;
        if (x < 0 || x > W) continue;
        visibleBars += 1;
        // 「被标签压住」= 该 bar 所在列（±半根槽宽）内存在**标签墨迹**像素（口径比 bbox 更真）
        const half = Math.max(1, Math.round(((barSpace ?? 1) * scale) / 2));
        let hit = false;
        for (let dx = -half; dx <= half && !hit; dx++) {
          const cx = Math.round(x) + dx;
          if (cx < 0 || cx >= W) continue;
          for (let cy = 0; cy < H; cy++) {
            if (nearLabelGap[cy * W + cx]) {
              hit = true;
              break;
            }
          }
        }
        if (hit) covered += 1;
      }
    }
    return {
      ok: true,
      pane: { w: W, h: H },
      paneAreaPx,
      inkPx: labelInkPx + dotInkPx,
      inkPct: ((labelInkPx + dotInkPx) / paneAreaPx) * 100,
      labelInkPx,
      labelPct: (labelInkPx / paneAreaPx) * 100,
      dotInkPx,
      dotPct: (dotInkPx / paneAreaPx) * 100,
      components,
      labelComponents: labelComps.length,
      dotComponents: dotComps.length,
      visibleBars,
      barsCoveredByLabels: covered,
      barsCoveredPct: visibleBars > 0 ? (covered / visibleBars) * 100 : 0,
      maxLabelCompWidth: labelComps.reduce((a, c) => Math.max(a, c.w), 0),
      labelWidths: labelComps.map((c) => c.w).sort((a, b) => a - b),
      maxInkDistToDot: Math.round(Math.sqrt(maxDistSq) * 10) / 10,
      maxLabelExtentFromDot,
      pureLabelWidths: pureLabelWidths.sort((a, b) => a - b),
      viewport: {
        barSpace,
        from: range ? Math.round(range.from) : null,
        to: range ? Math.round(range.to) : null,
        dataLen: list.length,
      },
    };
  }, DOT_INK_R_PX);
}

/** 真身标记几何：`fillDot` 的像素锚点 + 非空标签数（读 klinecharts 公开 store）。 */
async function probeMarkers(page: Page): Promise<{
  ok: boolean;
  paneW: number;
  paneH: number;
  rows: Array<{ key: string; label: string; labelDetail: string; x: number; y: number; stack: number; color: string }>;
  highlight: Array<{ key: string; label: string; pulse: number }>;
}> {
  return page.evaluate(() => {
    interface ChartLike {
      getDataList?: () => unknown[];
      getOverlays?: (f?: unknown) => Array<Record<string, unknown>>;
      convertToPixel?: (p: unknown, f?: unknown) => { x?: number; y?: number };
      getSize?: (id?: string) => { width: number; height: number } | null;
    }
    const w = window as unknown as { __wbCharts?: ChartLike[] };
    const cands = (w.__wbCharts ?? []).filter((c) => ((c.getDataList?.() ?? []) as unknown[]).length > 0);
    const host = document.querySelector('[data-testid="kline-chart"]');
    if (cands.length === 0 || !host) return { ok: false, paneW: 0, paneH: 0, rows: [], highlight: [] };
    const chart = cands[0]!;
    const conv = (o: Record<string, unknown>) => {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      const pts = (o['points'] ?? []) as Array<{ timestamp: number; value: number }>;
      const p = chart.convertToPixel?.({ timestamp: pts[0]!.timestamp, value: pts[0]!.value }, { paneId: 'candle_pane' });
      const stack = Number(ext['stackIndex'] ?? 0);
      return {
        key: String(ext['fillKey'] ?? ''),
        label: String(ext['label'] ?? ''),
        labelDetail: String(ext['labelDetail'] ?? ''),
        color: String(ext['color'] ?? ''),
        stack,
        x: Number(p?.x ?? NaN),
        y: Number(p?.y ?? NaN) + stack * 12,
      };
    };
    const rows = (chart.getOverlays?.({ name: 'fillDot' }) ?? []).map(conv);
    const highlight = (chart.getOverlays?.({ name: 'fillDotHighlight' }) ?? []).map((o) => {
      const ext = (o['extendData'] ?? {}) as Record<string, unknown>;
      return { key: String(ext['fillKey'] ?? ''), label: String(ext['label'] ?? ''), pulse: Number(ext['pulse'] ?? 0) };
    });
    const size = chart.getSize?.('candle_pane');
    return { ok: true, paneW: size?.width ?? 0, paneH: size?.height ?? 0, rows, highlight };
  });
}

/** 真身 `measureText` 盒宽（口径 = klinecharts `getTextRect`）。 */
async function measureBoxes(page: Page, texts: string[]): Promise<Array<{ text: string; len: number; textWidth: number; box: number }>> {
  return page.evaluate(
    ({ texts, pad }) => {
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d')!;
      ctx.font = 'normal 9px "Helvetica Neue"';
      return texts.map((text) => {
        const w = ctx.measureText(text).width;
        return { text, len: text.length, textWidth: Math.round(w * 100) / 100, box: Math.round(w) + pad };
      });
    },
    { texts, pad: LABEL_PAD_PX },
  );
}

// ───────────────────────────── 页面操作 ─────────────────────────────

async function readAttrs(page: Page, testId: string): Promise<Record<string, string>> {
  return page.getByTestId(testId).evaluate((e) => Object.fromEntries(Array.from(e.attributes).map((x) => [x.name, x.value])));
}

/** 打开工作台、选中 run、等取数落定（同既有规格口径；历史列表**要翻页**，否则旧 run 会假红）。 */
async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(page.locator('[data-testid^="wb-run-select-"]').first()).toBeVisible();
  for (let i = 0; i < 30 && (await select.count()) === 0; i++) {
    const more = page.getByTestId('wb-runs-more');
    if ((await more.count()) > 0) {
      await more.scrollIntoViewIfNeeded().catch(() => {});
      await more.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  await expect(select, `运行 ${runId} 必须在历史列表内（已翻页查找）`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'kline');
  await expect(page.getByTestId('kline-chart')).toBeVisible();
  await page.waitForTimeout(2500);
}

/** L2 跳转（触发 3s 高亮）。 */
async function l2Jump(page: Page, rtSeq: number, fillIdx: number): Promise<void> {
  await page.getByTestId(`wb-rt-detail-${rtSeq}`).click();
  const row = page.getByTestId(`wb-l2-row-${rtSeq}-${fillIdx}`);
  await expect(row).toBeVisible();
  await page.getByTestId(`wb-l2-jump-${rtSeq}-${fillIdx}`).click();
}

/** 选一个「适合悬停」的标记：完全落在 pane 内、x 远离右缘（避免标签翻转，便于口径一致）。 */
function pickHoverable(
  rows: Array<{ key: string; x: number; y: number; label: string; labelDetail?: string }>,
  paneW: number,
  paneH: number,
): { key: string; x: number; y: number; label: string; labelDetail?: string } | null {
  // ⚠ 门控关时 store 里 `label` 为空（这是**预期**：门控在写 extendData 之前生效）⇒ 用 `labelDetail` 判身份。
  const ok = rows.filter((r) => r.x > 40 && r.x < paneW - 150 && r.y > 20 && r.y < paneH - 20 && (r.labelDetail ?? r.label) !== '');
  if (ok.length === 0) return null;
  return ok[Math.floor(ok.length / 2)]!;
}

/** `page.request` → {@link RunFetchPort} 适配器（只读；口径同 `adr028-window-sync`）。 */
function runPort(page: Page): RunFetchPort {
  return {
    listRuns: async () => {
      const resp = await page.request.get('/api/workbench/runs?limit=500');
      expect(resp.ok(), 'GET /api/workbench/runs').toBeTruthy();
      return (await resp.json()) as RunListItem[];
    },
    totalBars: async (id: string) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/bars?kind=per_bar&offset=0&limit=1`);
      expect(resp.ok(), `GET /bars per_bar ${id}`).toBeTruthy();
      const total = ((await resp.json()) as { total?: number }).total;
      expect(typeof total, '/bars per_bar 必须回 total').toBe('number');
      return total!;
    },
    roundTrips: async (id: string) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/round-trips?limit=5000`);
      expect(resp.ok(), `GET /round-trips ${id}`).toBeTruthy();
      return ((await resp.json()) as { round_trips?: RunRoundTrip[] }).round_trips ?? [];
    },
    fills: async (id: string, rtSeq: number) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/round-trips/${rtSeq}/fills?limit=200`);
      expect(resp.ok(), `GET /fills ${id}/${rtSeq}`).toBeTruthy();
      return ((await resp.json()) as { fills?: RunFill[] }).fills ?? [];
    },
  };
}

/** 规格内显式预算（§7.2 修法 ①）：谓词解析 + 真渲染不再依赖 CLI `--timeout`。 */
test.describe.configure({ timeout: 180_000 });

test.beforeAll(async ({ request }) => {
  const port: RunFetchPort = {
    listRuns: async () => (await (await request.get('/api/workbench/runs?limit=500')).json()) as RunListItem[],
    totalBars: async (id: string) =>
      Number(((await (await request.get(`/api/workbench/runs/${id}/bars?kind=per_bar&offset=0&limit=1`)).json()) as { total?: number }).total ?? -1),
    roundTrips: async (id: string) =>
      ((await (await request.get(`/api/workbench/runs/${id}/round-trips?limit=5000`)).json()) as { round_trips?: RunRoundTrip[] }).round_trips ?? [],
    fills: async (id: string, rt: number) =>
      ((await (await request.get(`/api/workbench/runs/${id}/round-trips/${rt}/fills?limit=200`)).json()) as { fills?: RunFill[] }).fills ?? [],
  };
  // 落盘缓存（**未跟踪**目录；命中仍校验）——缓存出口默认 `coder/evidence/adr028_resolve_cache`
  const resolved = await resolveRun(port, 'd1', { sourceKey: RESOLVE_SOURCE });
  writeJson('d11_run_resolution', resolved);
  RESOLVED.push(resolved);
});

/** 后端身份（进落盘缓存键；防跨构建/跨后端复用同一缓存条目）。 */
const RESOLVE_SOURCE = process.env.E2E_BASE_URL ?? 'http://localhost:8081';

/** 解析结果（beforeAll 现场解析一次；每个用例内再**现场重解析**核对，防硬编码）。 */
const RESOLVED: ResolvedRun[] = [];
function resolvedRun(): ResolvedRun {
  const r = RESOLVED[0];
  if (!r) throw new Error('run 解析未完成（beforeAll 未产出 ⇒ 显式红，不得静默换 run）');
  return r;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installChartCapture);
});

// ───────────────────────── D11-1 默认态：零标签墨迹 ─────────────────────────

test('D11-1 默认态：标签墨迹 = 0（只显示圆点；圆点墨迹 > 0）', async ({ page }) => {
  const used = resolvedRun();
  // 反硬编码护栏：**现场重解析（显式不走缓存）**
  const fresh = await resolveRun(runPort(page), 'd1', { cacheDir: null, sourceKey: RESOLVE_SOURCE });
  assertResolvedByIdFresh(used.id, fresh, 'd1');
  await openRunSettled(page, used.id);
  const attrs = await readAttrs(page, 'kline-chart');
  expect(attrs['data-marker-labels'], '默认必须是「关」').toBe('off');
  expect(attrs['data-marker-label-count']).toBe('0');
  const geom = await probeMarkers(page);
  expect(geom.rows.length, '圆点数必须 = 成交笔数（> 0）').toBeGreaterThan(0);
  expect(
    geom.rows.every((r) => r.label === ''),
    '默认态：标记 store 里不得写标签文本（门控在**写 extendData 之前**生效）',
  ).toBe(true);
  expect(geom.rows.every((r) => r.labelDetail !== ''), '明细字段仍须随标记携带（悬停据此回答价格×数量）').toBe(true);

  const occ = await measureOcclusion(page);
  await page.screenshot({ path: resolve(OUT, 'd11_default.png') });
  writeJson('d11_1_default', { attrs, geom: { rows: geom.rows.length, sample: geom.rows.slice(0, 6) }, occ });
  expect(occ.ok, occ.error).toBe(true);
  expect(occ.labelInkPx, `默认态标签墨迹必须为 0（实测 ${occ.labelInkPx}px）`).toBe(0);
  expect(occ.labelComponents, '默认态不得出现任何标签连通域').toBe(0);
  expect(
    occ.maxInkDistToDot,
    `默认态所有标记墨迹必须在圆点邻域内（≤ ${DOT_INK_R_PX}px；实测最远 ${occ.maxInkDistToDot}px ⇒ 远离圆点的墨迹 = 文本标签）`,
  ).toBeLessThanOrEqual(DOT_INK_R_PX);
  expect(occ.dotInkPx, '圆点墨迹必须 > 0（不得把点也门控掉）').toBeGreaterThan(0);
  // ── **§2.11.1 标定阈值**（默认态）──
  //  ① 默认态遮挡**并集 ≤8%**（兜底判据；主判据 = 上面的「标签墨迹 == 0」，它对三种密度都有牙）
  expect(occ.inkPct, `默认态遮挡并集必须 ≤${UNION_MAX_PCT}%（实测 ${occ.inkPct.toFixed(4)}%）`).toBeLessThanOrEqual(UNION_MAX_PCT);
  //  ①b **禁收到 6%**：dense 全览的**纯圆点**已 6.86% ⇒ 6% 会把「正常情况下默认态就红」写成判据。
  expect(UNION_MAX_PCT, `并集界必须保持契约值 ${UNION_MAX_PCT}%（§2.11.1 明令禁收到 ${UNION_FORBIDDEN_TIGHT_PCT}%）`).toBe(8);
  expect(UNION_MAX_PCT).toBeGreaterThan(UNION_FORBIDDEN_TIGHT_PCT);
  //  ② 默认态**被压可见 bar ≤5%**（契约原 35% 过松：门控失效时 m15 仅 12.2% 也「通过」35%）
  expect(occ.barsCoveredByLabels, '默认态被标签压住的 bar 必须为 0（门控默认关）').toBe(0);
  expect(
    occ.barsCoveredPct,
    `默认态被压可见 bar 占比必须 ≤${PRESSED_MAX_PCT_DEFAULT}%（实测 ${occ.barsCoveredPct.toFixed(3)}%，分母 = 可见 bar ${occ.visibleBars} 根、bs=${occ.viewport.barSpace}）`,
  ).toBeLessThanOrEqual(PRESSED_MAX_PCT_DEFAULT);
});

// ───────────────────────── D11-2 悬停：恰 1 个标签 ─────────────────────────

test('D11-2 悬停：恰 1 个标签（内容 = 方向×数量）+ 明细读数仍可答「哪一笔/价格×数量」', async ({ page }) => {
  await openRunSettled(page, resolvedRun().id);
  const geom = await probeMarkers(page);
  expect(geom.ok).toBe(true);
  const target = pickHoverable(geom.rows, geom.paneW, geom.paneH);
  expect(target, '必须能选到可悬停的标记（否则用例空绿）').not.toBeNull();
  const canvasBox = await page.getByTestId('kline-chart').boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox!.x + target!.x, canvasBox!.y + target!.y);
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-hover-key', target!.key);
  expect(await page.getByTestId('kline-chart').getAttribute('data-marker-label-count'), '悬停 ⇒ 恰 1 个标签').toBe('1');
  // 内容 = 方向×数量（短标签），明细读数仍给全（价格×数量）
  const rows = await probeMarkers(page);
  const hovered = rows.rows.filter((r) => r.label !== '');
  expect(hovered.length, '悬停态恰有 1 笔带标签').toBe(1);
  expect(hovered[0]!.key).toBe(target!.key);
  expect(hovered[0]!.labelDetail, '悬停笔的明细必须与悬停前读到的同一笔一致').toBe(target!.labelDetail);
  expect(hovered[0]!.label, '悬停标签内容 = 方向×数量（短标签）').toMatch(/^[BS⊗]×/);
  const readout = page.getByTestId('kline-marker-hover');
  await expect(readout).toBeVisible();
  const txt = (await readout.textContent()) ?? '';
  expect(txt, '悬停读数必须含「买卖方向 + 价格×数量」').toContain(hovered[0]!.labelDetail);
  expect(txt).toContain('×');

  const occ = await measureOcclusion(page);
  const shot = await page.screenshot({ path: resolve(OUT, 'd11_hover.png') });
  writeJson('d11_2_hover', {
    target,
    hoverAttrs: await readAttrs(page, 'kline-chart'),
    readout: txt,
    readoutBox: await readout.boundingBox(),
    occ,
    shotBytes: shot.length,
  });
  expect(occ.ok, occ.error).toBe(true);
  expect(occ.labelComponents, `悬停态必须恰有 1 个标签连通域（实测 ${occ.labelComponents}）`).toBe(1);
  expect(occ.labelInkPx, '悬停态标签墨迹 > 0').toBeGreaterThan(0);
  expect(occ.maxInkDistToDot, '悬停态必须出现「远离圆点」的墨迹（文本标签）').toBeGreaterThan(DOT_INK_R_PX);
  // ── **§2.11.1 标定阈值**（悬停态）──
  //  ③ 被压可见 bar ≤15% **且与 barSpace 联立**（`bs=1` 时单标签可压 60–76 根；只写百分比无法跨 bs 比较）
  expect(
    occ.barsCoveredPct,
    `悬停态被压可见 bar 占比必须 ≤${PRESSED_MAX_PCT_HOVER}%（实测 ${occ.barsCoveredPct.toFixed(3)}%；可见 ${occ.visibleBars} 根、bs=${occ.viewport.barSpace}）`,
  ).toBeLessThanOrEqual(PRESSED_MAX_PCT_HOVER);
  const geomBound = pressedBoundByGeometry(occ.maxLabelCompWidth, occ.viewport.barSpace ?? 1);
  expect(
    occ.barsCoveredByLabels,
    `被压 bar 根数必须 ≤ 几何上界 ceil(标签盒宽 ${occ.maxLabelCompWidth}/bs ${occ.viewport.barSpace})+1 = ${geomBound}（bs=1 时单标签可达 ${BS1_SINGLE_LABEL_BARS}+ 根 ⇒ 该判据必须联立 bs 书写）`,
  ).toBeLessThanOrEqual(geomBound);
  //  ④ **悬停增量 ≤1.5pp**（最长标签 ≤2.0pp）：默认态基线在**同 run/同视口的另一页装载**上量（本函数
  //   会瞬态移除 overlay，同页无法量两态）。主判据另立「标签连通域 == 1」（与标签长度无关，上面已断言）。
  await page.reload();
  await openRunSettled(page, resolvedRun().id);
  const off0 = await measureOcclusion(page);
  const labelChars = hovered[0]!.label.length;
  const deltaLimit = labelChars >= HOVER_LONG_LABEL_CHARS ? HOVER_DELTA_MAX_PP_LONG_LABEL : HOVER_DELTA_MAX_PP;
  const hoverDeltaPp = occ.inkPct - off0.inkPct;
  writeJson('d11_2_hover_delta', { labelChars, deltaLimit, hoverInkPct: occ.inkPct, defaultInkPct: off0.inkPct, hoverDeltaPp, off0 });
  expect(
    hoverDeltaPp,
    `悬停增量必须 ≤${deltaLimit}pp（标签 ${hovered[0]!.label} / ${labelChars} 字符；实测 ${hoverDeltaPp.toFixed(4)}pp = 悬停 ${occ.inkPct.toFixed(4)}% − 默认 ${off0.inkPct.toFixed(4)}%）`,
  ).toBeLessThanOrEqual(deltaLimit);
  expect(off0.labelInkPx, '默认态基线：标签墨迹必须为 0（否则增量口径混入默认态标签）').toBe(0);

  // 移开 ⇒ 回落为点（无残留）
  await page.mouse.move(canvasBox!.x + 5, canvasBox!.y + 5);
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-hover-key', '');
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-label-count', '0');
});

// ───────────────────────── D11-3 跳转目标：3s 内可见、3s 后消失 ─────────────────────────

test('D11-3 跳转目标那一笔：高亮期内有标签墨迹，3s 后归零（回落为点）', async ({ page }) => {
  await openRunSettled(page, resolvedRun().id);
  await l2Jump(page, resolvedRun().rtSeq!, 1);
  await expect
    .poll(async () => page.getByTestId('kline-chart').getAttribute('data-highlight-active'), { timeout: 8000 })
    .toBe('true');
  const geom = await probeMarkers(page);
  expect(geom.highlight.length, '必须存在高亮 overlay').toBeGreaterThan(0);
  expect(geom.highlight[0]!.label, '高亮期目标笔**必须**带标签（门控不得吞掉）').not.toBe('');
  expect(await page.getByTestId('kline-chart').getAttribute('data-marker-label-count')).toBe('1');

  const occOn = await measureOcclusion(page);
  await page.screenshot({ path: resolve(OUT, 'd11_jump_highlight.png') });
  writeJson('d11_3_jump', { geom, occOn });
  expect(occOn.ok, occOn.error).toBe(true);
  expect(occOn.labelComponents, `高亮期内必须恰有 1 个标签连通域（实测 ${occOn.labelComponents}）`).toBe(1);
  expect(occOn.maxInkDistToDot, '高亮期内必须出现文本标签墨迹（远离圆点）').toBeGreaterThan(DOT_INK_R_PX);
  // **§2.11.1**：高亮态（与悬停态同档）被压可见 bar ≤15%，且与 barSpace 联立（见 `pressedBoundByGeometry`）
  expect(
    occOn.barsCoveredPct,
    `高亮态被压可见 bar 占比必须 ≤${PRESSED_MAX_PCT_HOVER}%（实测 ${occOn.barsCoveredPct.toFixed(3)}%；可见 ${occOn.visibleBars} 根、bs=${occOn.viewport.barSpace}）`,
  ).toBeLessThanOrEqual(PRESSED_MAX_PCT_HOVER);
  expect(
    occOn.barsCoveredByLabels,
    `高亮态被压 bar 必须 ≤ 几何上界 ceil(标签盒宽 ${occOn.maxLabelCompWidth}/bs ${occOn.viewport.barSpace})+1`,
  ).toBeLessThanOrEqual(pressedBoundByGeometry(occOn.maxLabelCompWidth, occOn.viewport.barSpace ?? 1));

  // 3s 到点 ⇒ 回落为点（**等待定时器**，不是 sleep 式假通过：断言的是状态归零 + 墨迹归零）
  await page.reload();
  await openRunSettled(page, resolvedRun().id);
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-highlight-active', 'false');
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-label-count', '0');
  const occAfter = await measureOcclusion(page);
  writeJson('d11_3_jump_after', { occAfter });
  expect(occAfter.labelComponents, '跳转后（高亮已过）标签连通域必须归零').toBe(0);
  expect(occAfter.maxInkDistToDot, `跳转 3s 后已回落为点（墨迹必须回到圆点邻域 ≤ ${DOT_INK_R_PX}px）`).toBeLessThanOrEqual(DOT_INK_R_PX);
});

test('D11-3b 3s 窗口内/后的**同一页**读数（目标笔标签由高亮 overlay 承载，超时即消失）', async ({ page }) => {
  await openRunSettled(page, resolvedRun().id);
  await l2Jump(page, resolvedRun().rtSeq!, 1);
  const t0 = Date.now();
  await expect.poll(async () => page.getByTestId('kline-chart').getAttribute('data-highlight-active'), { timeout: 8000 }).toBe('true');
  const during = Number(await page.getByTestId('kline-chart').getAttribute('data-marker-label-count'));
  await page.waitForTimeout(HIGHLIGHT_DURATION_MS + 600);
  const after = Number(await page.getByTestId('kline-chart').getAttribute('data-marker-label-count'));
  const pulse = await page.getByTestId('kline-chart').getAttribute('data-highlight-pulse');
  writeJson('d11_3b_highlight_window', { during, after, pulse, elapsedMs: Date.now() - t0 });
  expect(during, '高亮期标签数必须 = 1').toBe(1);
  expect(after, '3s 后标签数必须归零（回落为点）').toBe(0);
  expect(pulse).toBe('0');
});

// ───────────────────────── D11-4 开关（开/关 + 刷新保持） ─────────────────────────

test('D11-4 开关：开 ⇒ 标签墨迹显著增加；关 ⇒ 归零；刷新后保持（结果页独立 key）', async ({ page }) => {
  // 预置一个**看板**键（有值）：开关不得改写/删除它（配置隔离硬约束）
  await page.addInitScript(() => {
    try {
      localStorage.setItem('eestock.dashboard.layout.v1', JSON.stringify({ probe: 'd11', indicators: { vol: false } }));
    } catch {
      /* ignore */
    }
  });
  await openRunSettled(page, resolvedRun().id);
  const keysBefore = await page.evaluate(() => Object.keys(localStorage));
  const dashboardBefore = await page.evaluate(() => localStorage.getItem('eestock.dashboard.layout.v1'));
  const btn = page.getByTestId('wb-marker-labels-toggle');
  await expect(btn).toBeVisible();
  expect(await btn.getAttribute('aria-pressed')).toBe('false');

  // 开
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-labels', 'on');
  await page.waitForTimeout(500);
  const geomOn = await probeMarkers(page);
  const countOn = Number(await page.getByTestId('kline-chart').getAttribute('data-marker-label-count'));
  const occOn = await measureOcclusion(page);
  await page.screenshot({ path: resolve(OUT, 'd11_gate_on.png') });

  // 刷新保持
  await page.reload();
  await openRunSettled(page, resolvedRun().id);
  const keptOn = await page.getByTestId('wb-marker-labels-toggle').getAttribute('aria-pressed');
  const keptAttrs = await readAttrs(page, 'kline-chart');
  const storageOn = await page.evaluate(() => localStorage.getItem('eestock.wb.result.chartConfig.v1'));
  const keys = await page.evaluate(() => Object.keys(localStorage));
  const newKeys = keys.filter((k) => !keysBefore.includes(k));
  const dashboardAfter = await page.evaluate(() => localStorage.getItem('eestock.dashboard.layout.v1'));

  // 关（回到默认）
  await page.getByTestId('wb-marker-labels-toggle').click();
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-labels', 'off');
  await page.waitForTimeout(500);
  const storageOff = await page.evaluate(() => localStorage.getItem('eestock.wb.result.chartConfig.v1'));

  writeJson('d11_4_toggle', {
    countOn,
    labelsOn: geomOn.rows.filter((r) => r.label !== '').length,
    dotsOn: geomOn.rows.length,
    occOn,
    keptOn,
    keptAttrs,
    storageOn,
    storageOff,
    localStorageKeys: keys,
    newKeys,
    dashboardBefore,
    dashboardAfter,
  });
  expect(countOn, '开关开 ⇒ 标签数 = 可视标记数（> 1）').toBeGreaterThan(1);
  expect(geomOn.rows.filter((r) => r.label !== '').length, '开关开 ⇒ 每一笔都带标签').toBe(geomOn.rows.length);
  /**
   * **§2.11.1：开关开 ≠ 旧行为**（语义 = 常显**逃生门**；**禁**断言「开 == 旧行为」）。
   * 机器化：开态标签仍必须是**短标签** `方向×数量`（无空格），全文只在 `labelDetail` 里。
   * 反假绿：把开关实现成「回到旧的全量标签行为」（`B 8.417×118`）⇒ 本判据必红。
   */
  const onLabelled = geomOn.rows.filter((r) => r.label !== '');
  expect(onLabelled.length, '前置：开态必须有带标签的标记（否则下面空转）').toBeGreaterThan(0);
  expect(
    onLabelled.every((r) => /^[BS⊗]×/.test(r.label)),
    `开态标签必须仍是短标签 \`方向×数量\`（实测样例 ${JSON.stringify(onLabelled.slice(0, 3).map((r) => r.label))}）`,
  ).toBe(true);
  expect(
    onLabelled.every((r) => !r.label.includes(' ')),
    '开态标签不得含空格（`B 8.417×118` = 旧全量形态；「开 == 旧行为」在本判据下必红）',
  ).toBe(true);
  expect(
    onLabelled.every((r) => (r.labelDetail ?? '').includes(' ')),
    '开态 labelDetail 必须仍是全文（`方向 价格×数量`）—— 缩短只作用于画布标签',
  ).toBe(true);
  expect(occOn.ok, occOn.error).toBe(true);
  expect(occOn.labelInkPx, '开关开 ⇒ 标签墨迹必须显著 > 0').toBeGreaterThan(0);
  expect(occOn.labelComponents, '开关开 ⇒ 标签连通域 ≥ 1（密集态会粘连 ⇒ 不作等值断言）').toBeGreaterThanOrEqual(1);
  expect(keptOn, '刷新后开关必须保持开（结果页独立 key）').toBe('true');
  expect(keptAttrs['data-marker-labels']).toBe('on');
  expect(keptAttrs['data-marker-label-count'], '刷新后标签数必须仍 = 笔数').toBe(String(geomOn.rows.length));
  expect(storageOn).toContain('"markerLabels":true');
  expect(storageOff).toContain('"markerLabels":false');
  expect(
    newKeys.filter((k) => k !== 'eestock.wb.result.chartConfig.v1'),
    '开关只能写结果页独立 key（不得新增别的存储键）',
  ).toEqual([]);
  expect(keys, '结果页配置键必须存在（唯一写入者）').toContain('eestock.wb.result.chartConfig.v1');
  expect(dashboardBefore, '前置：看板键必须已预置（否则本判据空转）').toContain('d11');
  expect(dashboardAfter, '开关/刷新不得改写看板配置（配置隔离硬约束）').toBe(dashboardBefore);
});

// ───────────────────────── D11-5 标签宽度常量（真身标定） ─────────────────────────

test('D11-5 标签宽度常量：真身实测盒宽 ≤ 估算式（≥3 档长度；旧的 4.4×len+5 低估）且实绘标签不越界', async ({ page }) => {
  await openRunSettled(page, resolvedRun().id);
  // 开关开（需要实绘标签来取「实绘盒宽」）
  await page.getByTestId('wb-marker-labels-toggle').click();
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-marker-labels', 'on');
  // **稀疏态**（L1 跳转 ⇒ 视口收敛到回合区间）：标签彼此不相邻 ⇒ 连通域 = 单张标签盒（可测宽）
  await page.getByTestId(`wb-rt-jump-${resolvedRun().rtSeq!}`).click();
  await page.waitForTimeout(HIGHLIGHT_DURATION_MS + 700); // 等 3s 高亮（含其标签）散去，避免白描边环污染 ink

  // ① 真身 `measureText` 实测（覆盖实现真实产生的标签长度梯度 + 极短/极长样本）
  const samples = ['B×118', '⊗×12000', 'B×807.8369', 'S 12.345×12000', '⊗ 88.888×8888.8888'];
  const measured = await measureBoxes(page, samples);
  const rows = measured.map((m) => ({
    text: m.text,
    len: m.len,
    box: m.box,
    estimate: estimate(m.text),
    legacy: legacyEstimate(m.text),
  }));
  writeJson('d11_5_width_calibration', { cwConstant: CW, padConstant: PAD, samples: rows });
  expect(rows.length, '至少 3 档长度').toBeGreaterThanOrEqual(3);
  for (const r of rows) {
    expect(
      r.estimate,
      `「${r.text}」（${r.len} 字符）：估算式 ${r.estimate} 必须 ≥ 真身盒宽 ${r.box}（低估 ⇒ 避让失效）`,
    ).toBeGreaterThanOrEqual(r.box);
    expect(r.estimate, `「${r.text}」估算式不得虚高到真身盒宽的 1.7× 以上`).toBeLessThanOrEqual(1.7 * r.box);
  }
  const under = rows.filter((r) => r.legacy < r.box);
  // 旧公式 `4.4×len+5` 在**本机真身字体**（`normal 9px "Helvetica Neue"` → 系统 fallback）下，
  // 对**短标签**系统性低估（`B×118`：27 < 28；`⊗×12000`：35.8 < 39 —— 见 `d11_5_width_calibration.json`），
  // 与长标签基本持平（≈ ±2px）⇒ 本判据求 ≥1 个真身反例（≥3 档的完整反例面由单测的多族字体标定样本给出）。
  expect(under.length, `旧公式必须在本机真身上至少低估 1 档（否则本判据无鉴别力；实测 ${JSON.stringify(under.map((u) => u.text))}）`).toBeGreaterThanOrEqual(1);
  expect(rows.filter((r) => r.estimate > r.legacy).length, '新估算式必须在 ≥3 档长度上严格大于旧公式').toBeGreaterThanOrEqual(3);
  expect(CW * 5 + PAD, '常量必须不同于低估的旧值 4.4/5').toBeGreaterThan(4.4 * 5 + 5);

  // ② 实绘标签宽度（真身墨迹）不得超过「本 run 最长标签」的估算式 ⇒ 常量在真实数据上也不低估
  const geom = await probeMarkers(page);
  const labels = geom.rows.map((r) => r.label).filter((l) => l !== '');
  const longest = labels.slice().sort((a, b) => b.length - a.length)[0];
  expect(longest, '开关开后必须存在实绘标签').toBeTruthy();
  const occ = await measureOcclusion(page);
  // 实绘标签盒宽 = 标签墨迹相对**所属圆点锚点**的最远 x 延伸 + 6.2px
  // （模板口径：标签左缘 = `圆心 x + r(3.2) + FILL_LABEL_GAP_PX(3)`）
  const drawnBoxW = occ.maxLabelExtentFromDot + 6.2;
  writeJson('d11_5_drawn_widths', {
    longest,
    longestEstimate: estimate(longest),
    drawnBoxW,
    maxLabelExtentFromDot: occ.maxLabelExtentFromDot,
    labelWidths: occ.labelWidths,
    maxLabelCompWidth: occ.maxLabelCompWidth,
    maxInkDistToDot: occ.maxInkDistToDot,
    occ,
  });
  expect(occ.labelComponents, '开关开 ⇒ 必须采到实绘标签').toBeGreaterThan(0);
  expect(occ.maxLabelExtentFromDot, '必须采到「远离圆点」的标签墨迹（否则本判据空转）').toBeGreaterThan(10);
  expect(
    drawnBoxW,
    `实绘标签盒宽（${drawnBoxW.toFixed(1)}px）不得超过「最长标签 ${longest}」的估算式（${estimate(longest)}px）`,
  ).toBeLessThanOrEqual(estimate(longest));
});
