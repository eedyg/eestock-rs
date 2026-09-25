/**
 * ADR-028 D5「结果页图表卡上下缩放 + K 线副图可选」**探针取证**（tester 车道；本波 = 探针，不改生产代码）。
 *
 * ───────────────────────────── 本探针要回答的问题（对应裁定后的四条） ─────────────────────────────
 * 1. **副图指标选择入口**：结果页 K 线卡 DOM 里**是否已存在**指标勾选入口（button/`aria-pressed`/
 *    checkbox/select 等）？当前 K 线**副图**实际渲染的指标是什么（读 klinecharts 真身 `getIndicators()`，
 *    不靠截图猜）？
 * 2. **K 线副图拖拽是否已可用**：klinecharts 10.0.3 的 pane 分隔线是 **DOM 覆盖 div（canvas 命中测试）**
 *    —— `SeparatorWidget.createContainer()` 产出 `position:absolute; z-index:20; height:7px; cursor:ns-resize`
 *    的 div（`REAL_SEPARATOR_HEIGHT=7`），**不是** `klinecharts-separator` 属性节点（本包内无该串）。
 *    ⚠ 坑：**y 轴 widget 也用 `cursor: ns-resize`**（拖 Y 轴缩放），故选择器必须按「宽 > 100 且高 ≤ 10」筛。
 *    探针在**真渲染**下用真鼠标手势拖该 div，测 VOL 副图高度像素变化；若不变，给出限制原因
 *    （pane options / state / dragEnabled / 容器高度 / 命中落点）。
 * 3. **图表卡高度与容器结构**：K 线卡（源码 `h-64`）与四张曲线卡（源码 svg `h-40` / `h-36` / `h-52`）
 *    的**实测**像素高度；卡片自身/祖先是否存在固定高度或 `overflow` 约束会阻止「拖高」；
 *    表格类（逐bar评分 / 交易明细 / 事件日志）当前是否自适应滚动。
 * 4. **对齐回归基线**：改变 K 线卡高度（注入 inline height 使容器变高/变矮）+ 拖分隔线改变副图高度后，
 *    仍用 `adr028-axis-align-probe.e2e.ts` **v2 主口径**（同一根 bar 配对：曲线渲染顶点 ↔ K 线真身可见 bar
 *    的实测像素 x，Δraw 与归一化 Δ984 均 ≤ 2px）测「配对偏差是否仍 ≤2px」；并加两条同源判据：
 *    ① 各曲线视图**同一根 bar** 的渲染 userX 互差；② 各视图 plot 左右边界（userX 首末）。
 *
 * 探针纪律：页面侧**只读**（仅包 `Map.prototype.set` 捕获 klinecharts 实例以调其只读 getter/布局查询）；
 * 注入的样式只作用于**探针会话的 DOM**（inline style），**不落盘、不改源码**；每步结束后还原。
 *
 * ───────────────────────────── 2026-09-23 **重锚**（ADR-028 §2.6 D6 / §2.7 D7 之后；按契约推导）──────────────
 *  本规格的**硬判据**（跨视图同一根 bar 配对 max|Δ984| ≤ 2px、max|Δraw| ≤ 2px）**不变**；下列**取证字段口径**
 *  因契约变更而重锚（旧口径在新布局下是 no-op 或读数恒为 1，属「度量口径过期」而非缺陷）：
 *  1. `resetScroll()`：旧写 `wb-result.scrollTop` —— D7 后**页面级滚动被移除**，`wb-result` 不再是滚动容器
 *     ⇒ 该写入是 **no-op**（Playwright 点击 tab 引起的 scrollIntoView 不会被复位）。改写上栏 `wb-kline-view`
 *     （+ 下栏 `wb-detail-pane` + `window.scrollTo(0,0)`）。
 *  2. `indicatorEntries`（D5-P1）：D6-5 把指标勾选**收进浮层** ⇒ 收起态只命中 **1 枚**入口按钮
 *     （`wb-indicator-menu`）。重锚为「**先展开浮层（`wb-indicator-popover`）再扫**」，收起态与展开态**两态读数都落盘**。
 *  3. 卡片高度锚（旧依据 = 源码 `h-64` = 256px 固定）：D6-1 后卡高 = **inline 520px**（默认），`h-64` 不再是高度
 *     事实源 ⇒ 读数改记 `inlineHeight` + `className` + `h64Class` 布尔（**不作断言**，仅取证对照）。
 *  4. 滚动容器读数：`wb-result.overflowY` 之外，增记 `wb-kline-view` / `wb-detail-pane` 的
 *     `overflowY / clientHeight / scrollHeight`（D7-1 的双滚动容器事实源）。
 *
 * 真身（2026-09-23 实测）：主机 `:8081` 的静态根 `web/dist` 是 **D6/D7 之前**的构建 ⇒ 本探针须对
 * **沙箱构建**跑（`vite build --outDir /tmp/reanchor-dist` + `vite preview --port 4188`，`VITE_PROXY_TARGET=:8081`）。
 *
 * 运行（对已在跑的线上版本 8081，**不起 vite preview**）：
 *   cd web && E2E_BASE_URL=http://localhost:8081 \
 *     npx playwright test e2e/adr028-resize-probe.e2e.ts --reporter=list --retries=0 --workers=1
 * 产物落盘：`ADR028_RESIZE_OUT`（默认 `tester/evidence/20260920_result_resize_probe/raw`）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// ADR-028 §2.10.1 裁决 3（规格耐久）：e2e **禁硬编码 run id** ⇒ 目标 run 按谓词现场解析 + 反硬编码护栏。
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
const OUT = process.env.ADR028_RESIZE_OUT ?? resolve(REPO, 'tester/evidence/20260920_result_resize_probe/raw');
/**
 * 目标 run：**谓词解析**（`m5` = `period=M5 ∧ status=succeeded ∧ per_bar ≥ 1000`），**不硬编码**。
 *
 * 重锚依据（2026-09-25，本批项 4）：旧默认值 `sr_1789832517800_000006` 是**字面量**，而本机库已增长到
 * **93 个 run**（`GET /api/workbench/runs` 首屏只 50）⇒ 该 run 被新 run 顶出首屏后，规格以
 * 「运行 … 必须在历史列表内」的形式**假红**（实测：本批首跑即此形态）。ADR-028 §2.10.1 **裁决 3**
 * 明文要求「e2e 不得硬编码具体 run id，改为按谓词解析；解析失败须**显式红**而非静默换 run」。
 *
 * `ADR028_RESIZE_RUN` 仅作**本机调参**逃生门（指定即不解析）；判据不依赖它。
 */
const RUN_ID_ENV = process.env.ADR028_RESIZE_RUN ?? null;
/** 解析谓词（与 v2 对齐探针同源 = M5；`BAR_SECONDS=300` 与之配套）。 */
const RESOLVE_LABEL = 'm5' as const;
/** 解析结果（`resolveTargetRun` 首步写入；`env`/`openRunSettled`/`measureAlignment` 一律读它）。 */
let RUN_ID = RUN_ID_ENV ?? '';
const BAR_SECONDS = 300;
/** 曲线绘图区口径（与 v2 完全一致：normChart W=1000 / PAD=8 ⇒ plot 984）。 */
const CURVE_W = 1000;
const CURVE_PAD = 8;
const CURVE_PLOT_W = CURVE_W - 2 * CURVE_PAD;
/** 判据阈值（px）——与 v2 相同，**不放宽**。 */
const ALIGN_TOL_PX = 2;
/** 配对容差（秒）：真身 per_bar ts 与 K 线 bar ts 可差数秒（实测 ~4s）⇒ 最近邻吸附。 */
const PAIR_TOL_SEC = Math.max(60, Math.round(BAR_SECONDS / 2));
/** 高度注入档位（px）。 */
const KLINE_H_TALL = 480;
const KLINE_H_SHORT = 160;
const CURVE_CARD_H = 340;

// ═══════════════════════════ 页面侧探针（自包含，勿引用外部作用域） ═══════════════════════════

/** 只读捕获 klinecharts 真身实例（与 v2 同法）。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { scrollToDataIndex?: unknown; setBarSpace?: unknown; convertToPixel?: unknown } | null;
    if (
      o != null &&
      typeof o === 'object' &&
      typeof o['scrollToDataIndex'] === 'function' &&
      typeof o['setBarSpace'] === 'function' &&
      typeof o['convertToPixel'] === 'function'
    ) {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}

/** K 线真身读回：可见 bar 的**实测像素 x**（绝对屏幕坐标）+ 数据端点 + barSpace（与 v2 同法）。 */
function probeKline() {
  interface ChartLike {
    getDataList?: () => Array<{ timestamp: number }>;
    getVisibleRange?: () => { from: number; to: number };
    getBarSpace?: () => { bar: number };
    getSize?: () => { width: number } | null;
    convertToPixel?: (p: { timestamp: number }, f?: { paneId?: string }) => { x?: number } | undefined;
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const chartDiv = document.querySelector('[data-testid="kline-chart"]');
  const host = document.querySelector('[data-testid="wb-kline-chart"]');
  const rectOf = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const container = rectOf(chartDiv ?? host);
  const cands = (w.__wbCharts ?? []).map((chart) => {
    let n = -1;
    let width = -1;
    try {
      n = (chart.getDataList?.() ?? []).length;
      width = chart.getSize?.()?.width ?? -1;
    } catch {
      /* ignore */
    }
    return { chart, n, width };
  });
  const withData = cands.filter((c) => c.n > 0);
  const chosen =
    withData.length > 0
      ? withData.reduce((a, b) =>
          Math.abs(a.width - (container?.width ?? 0)) <= Math.abs(b.width - (container?.width ?? 0)) ? a : b,
        )
      : null;
  if (!chosen || !container) {
    return {
      ok: false,
      error: 'K 线实例/容器不可测',
      container,
      chartCount: cands.length,
      ts: [] as number[],
      xRaw: [] as number[],
      xAbs: [] as number[],
      visibleCount: 0,
      barSpace: null as number | null,
      fromIdx: -1,
      toIdx: -1,
      dataLen: -1,
      spacingDistinct: [] as number[],
    };
  }
  const chart = chosen.chart;
  const list = chart.getDataList!();
  const range = chart.getVisibleRange!();
  const barSpace = chart.getBarSpace?.()?.bar ?? null;
  const last = list.length - 1;
  const fromIdx = Math.max(0, Math.min(last, Math.round(range.from)));
  const toIdx = Math.max(fromIdx, Math.min(last, Math.round(range.to)));
  const ts: number[] = [];
  const xRaw: number[] = [];
  const xAbs: number[] = [];
  for (let i = fromIdx; i <= toIdx; i++) {
    const ms = list[i]!.timestamp;
    let px: number | null = null;
    try {
      const p = chart.convertToPixel!({ timestamp: ms }, { paneId: 'candle_pane' });
      px = typeof p?.x === 'number' ? p.x : null;
    } catch {
      px = null;
    }
    ts.push(Math.floor(ms / 1000));
    xRaw.push(px ?? Number.NaN);
    xAbs.push(px == null ? Number.NaN : px + container.left);
  }
  const diffs: number[] = [];
  for (let i = 1; i < xRaw.length; i++) {
    const d = xRaw[i]! - xRaw[i - 1]!;
    if (Number.isFinite(d)) diffs.push(Math.round(d * 1000) / 1000);
  }
  return {
    ok: true,
    error: '',
    chartCount: cands.length,
    container,
    dataLen: list.length,
    ts,
    xRaw,
    xAbs,
    fromIdx,
    toIdx,
    barSpace,
    spacingDistinct: Array.from(new Set(diffs)),
    visibleCount: ts.length,
  };
}

/** 曲线视图几何读回：`<polyline>` 渲染顶点（user units + 屏幕 px）+ svg rect/viewBox + CTM 诊断。
 *  **单参数**（`page.evaluate(fn, arg)` 只支持一个参数）。 */
function probeChartCurve(arg: { testid: string; polyTestId: string | null }) {
  const testId = arg.testid;
  const polyTestId = arg.polyTestId;
  const host = document.querySelector(`[data-testid="${testId}"]`);
  if (!host) return { present: false, polys: [] as Array<Record<string, unknown>> };
  const svg = host.querySelector('svg') as SVGSVGElement | null;
  const r = host.getBoundingClientRect();
  const svgRect = svg ? svg.getBoundingClientRect() : null;
  const inline = (host as HTMLElement).style;
  const base: Record<string, unknown> = {
    present: true,
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    inlineHeight: inline.height || null,
    className: (host as HTMLElement).className,
    xMode: host.getAttribute('data-x-mode'),
    xDomain: host.getAttribute('data-x-domain'),
    svg: svg && svgRect
      ? {
          rect: { left: svgRect.left, top: svgRect.top, width: svgRect.width, height: svgRect.height },
          viewBox: svg.getAttribute('viewBox'),
          className: svg.getAttribute('class'),
          preserveAspectRatio: svg.getAttribute('preserveAspectRatio'),
        }
      : null,
    polys: [] as Array<Record<string, unknown>>,
  };
  if (!svg) return base;
  const ctm = svg.getScreenCTM();
  base['ctm'] = ctm ? { a: ctm.a, d: ctm.d, e: ctm.e, f: ctm.f } : null;
  const pt = svg.createSVGPoint();
  const toScreenX = (x: number): number | null => {
    if (!ctm) return null;
    pt.x = x;
    pt.y = 0;
    return pt.matrixTransform(ctm).x;
  };
  const pick = polyTestId
    ? Array.from(svg.querySelectorAll(`polyline[data-testid="${polyTestId}"]`))
    : Array.from(svg.querySelectorAll('polyline'));
  base['polys'] = pick.map((p) => {
    const attr = p.getAttribute('points') ?? '';
    const userX = attr
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => Number(tok.split(',')[0]))
      .filter((v) => Number.isFinite(v));
    const screenX = userX.map((x) => toScreenX(x));
    const mid = Math.floor(screenX.length / 2);
    return {
      testid: p.getAttribute('data-testid'),
      n: userX.length,
      userX,
      screenX,
      firstUserX: userX[0] ?? null,
      lastUserX: userX[userX.length - 1] ?? null,
      screenHead: screenX.slice(0, 3),
      screenMid: screenX.slice(mid, mid + 2),
      screenTail: screenX.slice(-3),
    };
  });
  return base;
}

/** 结果页 DOM 结构读回（指标入口扫描 + 图表卡/表格容器几何 + 祖先约束链）。 */
function probeResultDom() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const rectOf = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const root = q('wb-result');

  // ── ① 交互控件普查（指标入口）──
  const controls: Array<Record<string, unknown>> = [];
  if (root) {
    for (const el of Array.from(root.querySelectorAll('button, [role="button"], input, select, [aria-pressed]'))) {
      const html = el as HTMLElement;
      controls.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        testid: el.getAttribute('data-testid'),
        ariaPressed: el.getAttribute('aria-pressed'),
        ariaLabel: el.getAttribute('aria-label'),
        role: el.getAttribute('role'),
        text: (html.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      });
    }
  }
  const indicatorish = controls.filter((c) =>
    /\bVOL\b|MACD|KDJ|BOLL|DCAP|指标|副图/i.test(
      `${String(c['testid'])} ${String(c['text'])} ${String(c['ariaLabel'])}`,
    ),
  );
  const maish = controls.filter((c) => /\bMA\b|均线/.test(`${String(c['text'])} ${String(c['ariaLabel'])}`));

  // ── ② 图表卡几何 + 祖先约束链 ──
  const cards: Record<string, unknown> = {};
  for (const id of ['wb-kline-chart', 'wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart']) {
    const el = q(id);
    if (!el) {
      cards[id] = { present: false };
      continue;
    }
    const cs = getComputedStyle(el);
    const chain: Array<Record<string, unknown>> = [];
    let cur: Element | null = el;
    for (let i = 0; i < 6 && cur; i++) {
      const c = getComputedStyle(cur);
      chain.push({
        tag: cur.tagName.toLowerCase(),
        testid: cur.getAttribute('data-testid'),
        className: String((cur as HTMLElement).className ?? '').slice(0, 120),
        rect: rectOf(cur),
        display: c.display,
        flexGrow: c.flexGrow,
        flexShrink: c.flexShrink,
        flexBasis: c.flexBasis,
        height: c.height,
        minHeight: c.minHeight,
        maxHeight: c.maxHeight,
        overflowY: c.overflowY,
      });
      cur = cur.parentElement;
    }
    const svg = el.querySelector('svg');
    cards[id] = {
      present: true,
      rect: rectOf(el),
      inline: (el as HTMLElement).style.cssText,
      className: (el as HTMLElement).className,
      computedHeight: cs.height,
      computedFlexShrink: cs.flexShrink,
      position: cs.position,
      overflowY: cs.overflowY,
      svg: svg
        ? { rect: rectOf(svg), className: svg.getAttribute('class'), viewBox: svg.getAttribute('viewBox') }
        : null,
      chain,
    };
  }

  // ── ③ 结果页滚动容器（面板级滚动 vs 卡片内滚动）──
  const resultScroll = root
    ? {
        rect: rectOf(root),
        clientHeight: (root as HTMLElement).clientHeight,
        scrollHeight: (root as HTMLElement).scrollHeight,
        overflowY: getComputedStyle(root).overflowY,
      }
    : null;

  // ── ④ 滚动容器（**2026-09-23 重锚**：D7 后 = 上栏 `wb-kline-view` 与下栏 `wb-detail-pane`；
  //      `wb-result` 不再是滚动容器——页面级滚动已移除（§2.7 第 1 项），保留读数作对照）──
  const scrollBox = (id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return null;
    return {
      rect: rectOf(el),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
    };
  };
  // ── ⑤ 卡片高度锚（旧依据 = 源码 `h-64`；D6-1 后 = inline 520px，`h-64` 不再是高度事实源）──
  const cardEl = q('wb-kline-chart') as HTMLElement | null;
  const cardHeightAnchor = cardEl
    ? {
        inlineHeight: cardEl.style.height,
        className: String(cardEl.className).slice(0, 140),
        h64Class: /(^|\s)h-64(\s|$)/.test(String(cardEl.className)),
        dataCardHeaderHeight: cardEl.getAttribute('data-card-header-height'),
        dataKlinePaneHeight: cardEl.getAttribute('data-kline-pane-height'),
      }
    : null;
  return {
    controls,
    indicatorish,
    maish,
    cards,
    resultScroll,
    chartPane: scrollBox('wb-kline-view'),
    detailPane: scrollBox('wb-detail-pane'),
    cardHeightAnchor,
    pageScroll: {
      scrollY: window.scrollY,
      scrollingElementScrollHeight: document.scrollingElement?.scrollHeight ?? null,
      innerHeight: window.innerHeight,
    },
  };
}

/** 表格类锚点读回：锚点几何 + **祖先链**（每级 overflow / client / scroll）+ 后代可滚容器。
 *  `arg.anchors` = data-testid 列表。 */
function probeTableAnchors(arg: { anchors: string[] }) {
  const out: Record<string, unknown> = {};
  for (const id of arg.anchors) {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) {
      out[id] = { present: false };
      continue;
    }
    const r = el.getBoundingClientRect();
    const chain: Array<Record<string, unknown>> = [];
    let cur: Element | null = el;
    for (let i = 0; i < 7 && cur; i++) {
      const c = getComputedStyle(cur);
      const he = cur as HTMLElement;
      chain.push({
        tag: cur.tagName.toLowerCase(),
        testid: cur.getAttribute('data-testid'),
        className: String(he.className ?? '').slice(0, 90),
        height: c.height,
        maxHeight: c.maxHeight,
        overflowY: c.overflowY,
        clientHeight: he.clientHeight,
        scrollHeight: he.scrollHeight,
      });
      cur = cur.parentElement;
    }
    const scrollables: Array<Record<string, unknown>> = [];
    for (const s of Array.from(el.querySelectorAll('*'))) {
      const c = getComputedStyle(s);
      if (c.overflowY === 'auto' || c.overflowY === 'scroll') {
        scrollables.push({
          testid: s.getAttribute('data-testid'),
          className: String((s as HTMLElement).className ?? '').slice(0, 70),
          clientHeight: (s as HTMLElement).clientHeight,
          scrollHeight: (s as HTMLElement).scrollHeight,
          maxHeight: c.maxHeight,
        });
      }
    }
    const trs = Array.from(el.querySelectorAll('tbody > tr'));
    out[id] = {
      present: true,
      rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      tbodyTrCount: trs.length,
      eventRowCount: el.querySelectorAll('[data-testid="wb-event-row"]').length,
      testidElementCount: el.querySelectorAll('tbody tr, [data-testid^="wb-event-row"], [data-testid^="wb-rt-"]').length,
      firstRowHeights: trs.slice(0, 3).map((t) => Math.round(t.getBoundingClientRect().height)),
      chain,
      scrollables,
    };
  }
  return out;
}

/** klinecharts 真身布局读回：pane 列表（id/height/minHeight/dragEnabled/state）+ 指标列表 + 尺寸 + separator 样式。 */
function probeChartLayout() {
  interface ChartLike {
    getDataList?: () => unknown[];
    getSize?: () => { width: number; height: number } | null;
    getPaneOptions?: () => Array<Record<string, unknown>>;
    getIndicators?: () => Array<Record<string, unknown>>;
    getStyles?: () => Record<string, unknown>;
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const chartDiv = document.querySelector('[data-testid="kline-chart"]');
  const container = chartDiv?.getBoundingClientRect() ?? null;
  const cands = (w.__wbCharts ?? []).map((c) => {
    let n = -1;
    let width = -1;
    try {
      n = (c.getDataList?.() ?? []).length;
      width = c.getSize?.()?.width ?? -1;
    } catch {
      /* ignore */
    }
    return { c, n, width };
  });
  const withData = cands.filter((x) => x.n > 0);
  const chosen =
    withData.length > 0
      ? withData.reduce((a, b) =>
          Math.abs(a.width - (container?.width ?? 0)) <= Math.abs(b.width - (container?.width ?? 0)) ? a : b,
        )
      : null;
  if (!chosen) return { ok: false, error: '未捕获到有数据的 K 线实例', chartCount: cands.length };
  const chart = chosen.c;
  let panes: Array<Record<string, unknown>> = [];
  let indicators: Array<Record<string, unknown>> = [];
  let sizes: { width: number; height: number } | null = null;
  try {
    panes = chart.getPaneOptions?.() ?? [];
  } catch {
    /* ignore */
  }
  try {
    indicators = (chart.getIndicators?.() ?? []).map((i) => ({
      id: i['id'],
      name: i['name'],
      shortName: i['shortName'],
      paneId: i['paneId'],
      yAxisId: i['yAxisId'],
      precision: i['precision'],
    }));
  } catch {
    /* ignore */
  }
  try {
    sizes = chart.getSize?.() ?? null;
  } catch {
    /* ignore */
  }
  let separatorStyle: unknown = null;
  try {
    const s = chart.getStyles?.() ?? {};
    separatorStyle = (s as { separator?: unknown }).separator ?? null;
  } catch {
    /* ignore */
  }
  return { ok: true, chartWidth: chosen.width, dataLen: chosen.n, panes, indicators, sizes, separatorStyle };
}

/** K 线容器 DOM 结构读回：pane 层（有 canvas 的子元素）分类 + 水平分隔线命中 div。
 *  ⚠ 真身层级：`init(dom)` 给宿主 div 打 `k-line-chart-id`，其下还有一层 `chartContainer`
 *  （inline `position:relative;width:100%;height:100%`），**pane 是 chartContainer 的直接子元素**。 */
function probeKlineDom() {
  const root = document.querySelector('[data-testid="kline-chart"]') as HTMLElement | null;
  if (!root) return { present: false };
  const rr = root.getBoundingClientRect();
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  // 下钻：找到「直接子元素里含 canvas 者 ≥ 2」的那一层（pane 层）
  let host: HTMLElement = root;
  for (let depth = 0; depth < 3; depth++) {
    const kids = Array.from(host.children);
    const kidsWithCanvas = kids.filter((k) => k.querySelectorAll('canvas').length > 0);
    const kidsNoCanvas = kids.filter((k) => k.querySelectorAll('canvas').length === 0);
    // pane 层 = 「≥2 个含 canvas 的 pane + ≥1 条无 canvas 的分隔条」的那一层
    if (kidsWithCanvas.length >= 2 && kidsNoCanvas.length >= 1) break;
    const next = kidsWithCanvas.find((k) => k.querySelectorAll('canvas').length > 0) as HTMLElement | undefined;
    if (!next || kids.length === 0) break;
    host = next;
  }
  const children = Array.from(host.children).map((el, i) => {
    const he = el as HTMLElement;
    const cs = getComputedStyle(he);
    const canvasCount = el.querySelectorAll('canvas').length;
    return {
      index: i,
      kind: canvasCount > 0 ? 'pane' : 'separator-bar',
      rect: rectOf(el),
      inlineStyle: he.style.cssText.slice(0, 200),
      cursor: cs.cursor,
      background: cs.backgroundColor,
      position: cs.position,
      height: cs.height,
      overflow: cs.overflow,
      canvasCount,
    };
  });
  // 命中 div：inline cursor: ns-resize 且宽 > 100（**水平**分隔线；窄的 ns-resize 是 Y 轴缩放 widget）
  const hts: Array<Record<string, unknown>> = [];
  const yAxisWidgets: Array<Record<string, unknown>> = [];
  for (const el of Array.from(root.querySelectorAll('div'))) {
    const he = el as HTMLElement;
    if (he.style.cursor !== 'ns-resize') continue;
    const rr2 = rectOf(he);
    const rec = {
      rect: rr2,
      inlineStyle: he.style.cssText.slice(0, 200),
      zIndex: getComputedStyle(he).zIndex,
      position: getComputedStyle(he).position,
      background: getComputedStyle(he).backgroundColor,
      childCount: he.children.length,
      canvasCount: he.querySelectorAll('canvas').length,
    };
    if (rr2.width > 100 && rr2.height <= 10) hts.push(rec);
    else yAxisWidgets.push(rec);
  }
  return {
    present: true,
    kLineChartId: root.getAttribute('k-line-chart-id'),
    rect: rectOf(root),
    panesHostClass: host.className,
    panesHostRect: rectOf(host),
    className: root.className,
    children,
    horizontalSeparatorHitTargets: hts,
    nsResizeNonSeparatorWidgets: yAxisWidgets,
    rootRect: rr,
  };
}

/** 当前几何（pane 层矩形 + 水平分隔线命中 div）——拖拽前后对照的**像素证据**。 */
function probeKlineGeometry() {
  const root = document.querySelector('[data-testid="kline-chart"]') as HTMLElement | null;
  if (!root) return null;
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  // 下钻到 pane 层（同 probeKlineDom 的口径）
  let host: HTMLElement = root;
  for (let depth = 0; depth < 3; depth++) {
    const kids = Array.from(host.children);
    const kidsWithCanvas = kids.filter((k) => k.querySelectorAll('canvas').length > 0);
    const kidsNoCanvas = kids.filter((k) => k.querySelectorAll('canvas').length === 0);
    // pane 层 = 「≥2 个含 canvas 的 pane + ≥1 条无 canvas 的分隔条」的那一层
    if (kidsWithCanvas.length >= 2 && kidsNoCanvas.length >= 1) break;
    const next = kidsWithCanvas.find((k) => k.querySelectorAll('canvas').length > 0) as HTMLElement | undefined;
    if (!next || kids.length === 0) break;
    host = next;
  }
  const panes: Array<Record<string, unknown>> = [];
  const bars: Array<Record<string, unknown>> = [];
  for (const el of Array.from(host.children)) {
    const canvasCount = el.querySelectorAll('canvas').length;
    if (canvasCount > 0) panes.push({ rect: rectOf(el), canvasCount });
    else bars.push({ rect: rectOf(el), canvasCount });
  }
  const seps = Array.from(root.querySelectorAll('div'))
    .filter((d) => {
      const he = d as HTMLElement;
      return he.style.cursor === 'ns-resize' && he.getBoundingClientRect().width > 100;
    })
    .map((el) => ({ rect: rectOf(el), background: getComputedStyle(el).backgroundColor }));
  return { root: rectOf(root), panes, separatorBars: bars, separators: seps };
}

/** 找出水平分隔线命中 div 的中心点（供真鼠标拖拽）。 */
function probeSeparatorHitPoint() {
  const root = document.querySelector('[data-testid="kline-chart"]') as HTMLElement | null;
  if (!root) return null;
  const cands = Array.from(root.querySelectorAll('div')).filter((d) => {
    const he = d as HTMLElement;
    const r = he.getBoundingClientRect();
    return he.style.cursor === 'ns-resize' && r.width > 100 && r.height <= 10;
  });
  if (cands.length === 0) return null;
  const el = cands[0] as HTMLElement;
  const r = el.getBoundingClientRect();
  return {
    count: cands.length,
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    background: getComputedStyle(el).backgroundColor,
  };
}

// ═══════════════════════════════════ 页面动作与编排 ═══════════════════════════════════

/** `page.request` → {@link RunFetchPort}（只读；解析谓词唯一取数面）。 */
function runPort(page: Page): RunFetchPort {
  return {
    listRuns: async () => {
      const resp = await page.request.get('/api/workbench/runs?limit=500');
      expect(resp.ok(), 'GET /api/workbench/runs').toBeTruthy();
      return (await resp.json()) as RunListItem[];
    },
    totalBars: async (id) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/bars?kind=per_bar&offset=0&limit=1`);
      expect(resp.ok(), `GET /bars per_bar ${id}`).toBeTruthy();
      const total = ((await resp.json()) as { total?: number }).total;
      expect(typeof total, `/bars per_bar ${id} 必须回 total`).toBe('number');
      return total!;
    },
    roundTrips: async (id) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/round-trips?limit=5000`);
      expect(resp.ok(), `GET /round-trips ${id}`).toBeTruthy();
      return ((await resp.json()) as { round_trips?: RunRoundTrip[] }).round_trips ?? [];
    },
    fills: async (id, rtSeq) => {
      const resp = await page.request.get(`/api/workbench/runs/${id}/round-trips/${rtSeq}/fills?limit=200`);
      expect(resp.ok(), `GET /fills ${id}#${rtSeq}`).toBeTruthy();
      return ((await resp.json()) as { fills?: RunFill[] }).fills ?? [];
    },
  };
}

/**
 * 解析目标 run（谓词 `m5`）+ **反硬编码护栏**（`ADR028_RESIZE_RUN` 指定时跳过解析）。
 * 解析失败 ⇒ 抛错（显式红）；禁静默换用别的 run / 禁跳过（ADR-028 §2.10.1 裁决 3）。
 */
async function resolveTargetRun(page: Page): Promise<ResolvedRun | null> {
  if (RUN_ID_ENV) return null;
  const sourceKey = process.env.E2E_BASE_URL ?? 'http://localhost:8081';
  const run = await resolveRun(runPort(page), RESOLVE_LABEL, { sourceKey });
  // 护栏走**现场重解析**（不走缓存）：规格实际使用的 id 必须 == 现场谓词命中的最新 run
  const fresh = await resolveRun(runPort(page), RESOLVE_LABEL, { cacheDir: null, sourceKey });
  assertResolvedByIdFresh(run.id, fresh, RESOLVE_LABEL);
  RUN_ID = run.id;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, 'run_resolution.json'),
    JSON.stringify({ id: run.id, predicate: run.predicate, totalBars: run.totalBars, evidence: run.evidence }, null, 2),
    'utf8',
  );
  return run;
}

/** D10 视口锁定的**真身读数**：barSpace / chartWidth（拟合公式输入）/ 宿主锁定痕迹。 */
async function readLockTruth(page: Page): Promise<{
  barSpace: number | null;
  chartWidth: number | null;
  locked: string | null;
}> {
  return page.evaluate(() => {
    interface ChartLike {
      getDataList?: () => unknown[];
      getBarSpace?: () => { bar: number };
      getSize?: () => { width: number } | null;
    }
    const w = window as unknown as { __wbCharts?: ChartLike[] };
    const chosen = (w.__wbCharts ?? [])
      .map((c) => ({ c, n: (c.getDataList?.() ?? []).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)[0];
    return {
      barSpace: chosen?.c.getBarSpace?.()?.bar ?? null,
      chartWidth: chosen?.c.getSize?.()?.width ?? null,
      locked:
        (document.querySelector('[data-testid="kline-chart"]') as HTMLElement | null)?.getAttribute(
          'data-viewport-lock',
        ) ?? null,
    };
  });
}

async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  // 历史列表**分页**（库增长会把目标 run 顶出首屏：实测 93 个 run / 首屏 50）⇒ 翻页查找，
  // 否则「运行不在历史列表内」是对 DB 内容漂移的**假红**（2026-09-25 本批实测形态）。
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
  await page.waitForTimeout(3000);
}

/** 等曲线渲染顶点数连续两次读值稳定（避免在重绘中间测）。 */
async function waitCurvesSettled(page: Page): Promise<void> {
  let prev = '';
  for (let i = 0; i < 40; i++) {
    const cur = await page.evaluate(() => {
      const n = (id: string) => {
        const svg = document.querySelector(`[data-testid="${id}"] svg`);
        if (!svg) return -1;
        const polys = Array.from(svg.querySelectorAll('polyline'));
        const first = polys[0]?.getAttribute('points') ?? '';
        return `${polys.length}:${first.trim() ? first.trim().split(/\s+/).length : 0}`;
      };
      return ['wb-aggregate-chart', 'wb-slot-chart', 'wb-equity-chart', 'wb-position-chart']
        .map((id) => `${id}=${n(id)}`)
        .join('|');
    });
    if (i > 1 && cur === prev) return;
    prev = cur;
    await page.waitForTimeout(200);
  }
}

async function readWindowAttrs(page: Page): Promise<{
  source: string | null;
  fromTs: string | null;
  toTs: string | null;
  spanBars: string | null;
  aggregateDomain: string | null;
  note: string | null;
  degraded: string | null;
  unmatched: string | null;
}> {
  return page.evaluate(() => {
    const st = document.querySelector('[data-testid="wb-window-state"]');
    const txt = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
    const agg = document.querySelector('[data-testid="wb-aggregate-chart"]');
    return {
      source: st?.getAttribute('data-source') ?? null,
      fromTs: st?.getAttribute('data-from-ts') ?? null,
      toTs: st?.getAttribute('data-to-ts') ?? null,
      spanBars: st?.getAttribute('data-span-bars') ?? null,
      aggregateDomain: agg?.getAttribute('data-x-domain') ?? null,
      note: txt('wb-window-load-note'),
      degraded: txt('wb-axis-degraded'),
      unmatched: txt('wb-curve-unmatched'),
    };
  });
}

async function fetchCurveTs(
  page: Page,
  runId: string,
  kind: string,
  fromTs: number | null,
  toTs: number | null,
): Promise<{ ok: boolean; status: number; ts: number[]; downsampled: boolean | null; originalBars: number | null }> {
  const q = new URLSearchParams({ kind, k: '2000' });
  if (fromTs != null && toTs != null) {
    q.set('from_ts', String(fromTs));
    q.set('to_ts', String(toTs));
  }
  const resp = await page.request.get(`/api/workbench/runs/${runId}/curve?${q.toString()}`);
  if (!resp.ok()) return { ok: false, status: resp.status(), ts: [], downsampled: null, originalBars: null };
  const j = (await resp.json()) as {
    points?: Array<{ ts?: number } | [number, number]>;
    downsampled?: boolean;
    original_bars?: number;
  };
  // ⚠ 两种形状：per_bar/position ⇒ `{ts,...}`；net_value/drawdown ⇒ `[ts, value]`
  const ts = (j.points ?? [])
    .map((p) => (Array.isArray(p) ? Number(p[0]) : Number(p?.ts)))
    .filter((v) => Number.isFinite(v));
  return {
    ok: true,
    status: 200,
    ts,
    downsampled: j.downsampled ?? null,
    originalBars: j.original_bars ?? null,
  };
}

// ───────────────────────── 测量与判据（主口径 = v2 的「同一根 bar 配对」） ─────────────────────────

interface CurveView {
  testid: string;
  apiKind: string;
  polyTestId: string | null;
}

const VIEWS: CurveView[] = [
  { testid: 'wb-aggregate-chart', apiKind: 'per_bar', polyTestId: null },
  { testid: 'wb-slot-chart', apiKind: 'per_bar', polyTestId: null },
  { testid: 'wb-equity-chart', apiKind: 'net_value', polyTestId: 'equity-line' },
  { testid: 'wb-position-chart', apiKind: 'position', polyTestId: 'position-line' },
];

/** 主口径配对（**与 v2 逐行同法**）：曲线渲染顶点 → K 线可见 bar（ts 最近邻 + 容差 + 单调一对一）。 */
function pairByNearestBar(klineTs: number[], dataTs: number[], tol: number) {
  const pairs: Array<{ i: number; j: number; ts: number; dTs: number }> = [];
  let j = 0;
  let prevJ = -1;
  let duplicate = 0;
  let outOfTol = 0;
  for (let i = 0; i < dataTs.length; i++) {
    const t = dataTs[i]!;
    while (j + 1 < klineTs.length && Math.abs(klineTs[j + 1]! - t) <= Math.abs(klineTs[j]! - t)) j += 1;
    if (j < prevJ) {
      outOfTol += 1;
      continue;
    }
    if (Math.abs(klineTs[j]! - t) > tol) {
      outOfTol += 1;
      continue;
    }
    if (j === prevJ) duplicate += 1;
    pairs.push({ i, j, ts: t, dTs: t - klineTs[j]! });
    prevJ = j;
  }
  return { pairs, duplicate, outOfTol };
}

const round2 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/** 单态测量：K 线真身 + 四张曲线视图配对偏差 + 跨视图同 bar userX 一致性 + 卡片几何/表格结构。 */
async function measureAlignment(page: Page, label: string, runId: string) {
  const attrs = await readWindowAttrs(page);
  const windowed = attrs.source != null && attrs.source !== 'full';
  const from = windowed && attrs.fromTs ? Number(attrs.fromTs) : null;
  const to = windowed && attrs.toTs ? Number(attrs.toTs) : null;
  const kline = await page.evaluate(probeKline);
  const dom = await page.evaluate(probeResultDom);
  const layout = await page.evaluate(probeChartLayout);
  const klineDom = await page.evaluate(probeKlineDom);

  const perView: Array<Record<string, unknown>> = [];
  const geomsCache: Array<Array<number>> = [];
  for (const v of VIEWS) {
    const api = await fetchCurveTs(page, runId, v.apiKind, from, to);
    const geom = await page.evaluate(probeChartCurve, { testid: v.testid, polyTestId: v.polyTestId });
    const poly = (geom['polys'] as Array<Record<string, unknown>> | undefined)?.[0] as
      | { n: number; userX: number[]; screenX: Array<number | null>; firstUserX: number | null; lastUserX: number | null; screenHead: Array<number | null>; screenMid: Array<number | null>; screenTail: Array<number | null> }
      | undefined;
    const n = poly?.n ?? 0;
    const userX = poly?.userX ?? [];
    const screenX = poly?.screenX ?? [];
    geomsCache.push(userX);

    let maxAbsRaw: number | null = null;
    let maxAbs984: number | null = null;
    let pairs = 0;
    let dup = 0;
    let oot = 0;
    let spanK: number | null = null;
    let spanC: number | null = null;
    let offsetMedianRaw: number | null = null;
    let maxAbsCenteredRaw: number | null = null;
    if (kline.ok && n > 0) {
      const pairing = pairByNearestBar(kline.ts, api.ts, PAIR_TOL_SEC);
      dup = pairing.duplicate;
      oot = pairing.outOfTol;
      const rows: Array<{ j: number; xK: number; xC: number }> = [];
      for (const p of pairing.pairs) {
        const xC = screenX[p.i];
        const xK = kline.xAbs[p.j];
        if (xC == null || !Number.isFinite(xC) || !Number.isFinite(xK)) continue;
        rows.push({ j: p.j, xK, xC });
      }
      pairs = rows.length;
      for (const r of rows) {
        const d = Math.abs(r.xK - r.xC);
        maxAbsRaw = maxAbsRaw == null ? d : Math.max(maxAbsRaw, d);
      }
      // 去常数偏移残差（诊断：CSS zoom 下 rect 被缩放而 convertToPixel 未缩放 ⇒ 出现**常数**偏移）
      if (rows.length > 0) {
        const ds = rows.map((r) => r.xK - r.xC).sort((a, b) => a - b);
        const mid = ds[Math.floor(ds.length / 2)]!;
        offsetMedianRaw = mid;
        maxAbsCenteredRaw = Math.max(...ds.map((d) => Math.abs(d - mid)));
      }
      if (rows.length > 1) {
        const kA = rows[0]!.xK;
        const kB = rows[rows.length - 1]!.xK;
        const cA = rows[0]!.xC;
        const cB = rows[rows.length - 1]!.xC;
        spanK = kB - kA;
        spanC = cB - cA;
        if (spanK !== 0 && spanC !== 0) {
          for (const r of rows) {
            const d984 = Math.abs(((r.xK - kA) / spanK - (r.xC - cA) / spanC) * CURVE_PLOT_W);
            maxAbs984 = maxAbs984 == null ? d984 : Math.max(maxAbs984, d984);
          }
        }
      }
    }
    perView.push({
      testid: v.testid,
      apiKind: v.apiKind,
      apiOk: api.ok,
      apiStatus: api.status,
      apiPoints: api.ts.length,
      downsampled: api.downsampled,
      polyCount: (geom['polys'] as unknown[] | undefined)?.length ?? 0,
      vertices: n,
      pairs,
      duplicateBars: dup,
      outOfTolerance: oot,
      maxAbsRawPx: maxAbsRaw == null ? null : round2(maxAbsRaw),
      maxAbs984Px: maxAbs984 == null ? null : round2(maxAbs984),
      offsetMedianRawPx: offsetMedianRaw == null ? null : round2(offsetMedianRaw),
      maxAbsCenteredRawPx: maxAbsCenteredRaw == null ? null : round2(maxAbsCenteredRaw),
      /** 尺度校正后的屏幕像素残差 = Δ984 × spanK / 984（锚点首末线性映射后的残差；对「两坐标系尺度差」免疫）。 */
      maxAbsAnchoredRawPx:
        maxAbs984 == null || spanK == null || spanK === 0 ? null : round2((maxAbs984 * spanK) / CURVE_PLOT_W),
      spanK: spanK == null ? null : round2(spanK),
      spanC: spanC == null ? null : round2(spanC),
      firstUserX: poly?.firstUserX ?? null,
      lastUserX: poly?.lastUserX ?? null,
      screenHead: poly?.screenHead ?? null,
      screenMid: poly?.screenMid ?? null,
      screenTail: poly?.screenTail ?? null,
      ctm: geom['ctm'] ?? null,
      cardRect: geom['rect'] ?? null,
      svgRect: (geom['svg'] as { rect?: unknown } | null)?.rect ?? null,
      xMode: geom['xMode'] ?? null,
      xDomain: geom['xDomain'] ?? null,
      ok: maxAbsRaw != null && maxAbsRaw <= ALIGN_TOL_PX && maxAbs984 != null && maxAbs984 <= ALIGN_TOL_PX,
    });
  }

  // 跨视图同 bar 一致性：各视图 polyline[0] 的渲染 userX 逐点互差（仅顶点数全等时可比）
  let crossMaxUserX: number | null = null;
  let crossNote = '';
  const counts = geomsCache.map((g) => g.length);
  if (counts.every((c) => c === counts[0]! && c > 0)) {
    for (let i = 0; i < geomsCache[0]!.length; i++) {
      for (let k = 1; k < geomsCache.length; k++) {
        const d = Math.abs(geomsCache[k]![i]! - geomsCache[0]![i]!);
        crossMaxUserX = crossMaxUserX == null ? d : Math.max(crossMaxUserX, d);
      }
    }
  } else {
    crossNote = `各视图顶点数不同（${VIEWS.map((v, i) => `${v.testid}:${counts[i]}`).join(' ')}）⇒ 不做逐点互差`;
  }

  return {
    label,
    window: attrs,
    kline: {
      ok: kline.ok,
      error: kline.error,
      visibleCount: kline.visibleCount,
      dataLen: kline.dataLen,
      fromIdx: kline.fromIdx,
      toIdx: kline.toIdx,
      barSpace: kline.barSpace,
      container: kline.container,
      spacingDistinct: kline.spacingDistinct.slice(0, 8),
    },
    views: perView,
    crossViewMaxUserX: crossMaxUserX == null ? null : round2(crossMaxUserX),
    crossViewNote: crossNote,
    edges: perView.map((p) => ({ id: p['testid'], first: p['firstUserX'], last: p['lastUserX'] })),
    paneOptions: layout['panes'] ?? null,
    indicators: layout['indicators'] ?? null,
    klineDomChildren: klineDom['children'] ?? null,
    horizontalSeparators: klineDom['horizontalSeparatorHitTargets'] ?? null,
    cards: dom['cards'],
    resultScroll: dom['resultScroll'],
  };
}

/** 真鼠标手势拖拽 K 线卡内**水平**分隔线（candle ↔ VOL）。 */
async function dragSeparator(page: Page, dy: number): Promise<Record<string, unknown>> {
  const hit = await page.evaluate(probeSeparatorHitPoint);
  if (!hit) return { attempted: false, reason: '未找到水平分隔线命中 div（inline cursor:ns-resize 且宽>100 高≤10）' };
  const x = hit['x'] as number;
  const y0 = hit['y'] as number;
  const out: Record<string, unknown> = {
    attempted: true,
    x,
    y0,
    dy,
    hitRect: hit['rect'],
    backgroundBefore: hit['background'],
    hitTargetCount: hit['count'],
  };
  const before = await page.evaluate(probeKlineGeometry);
  out['geometryBefore'] = before;
  await page.mouse.move(x, y0);
  await page.waitForTimeout(250);
  out['hover'] = await page.evaluate(
    ({ xx, yy }: { xx: number; yy: number }) => {
      const el = document.elementFromPoint(xx, yy) as HTMLElement | null;
      const sepEl = Array.from(document.querySelectorAll('div')).find((d) => {
        const he = d as HTMLElement;
        const r = he.getBoundingClientRect();
        return he.style.cursor === 'ns-resize' && r.width > 100 && r.height <= 10;
      }) as HTMLElement | undefined;
      return {
        hitTag: el?.tagName ?? null,
        hitCursor: el ? getComputedStyle(el).cursor : null,
        hitIsSeparator: el === sepEl,
        sepBackground: sepEl ? getComputedStyle(sepEl).backgroundColor : null,
      };
    },
    { xx: x, yy: y0 },
  );
  await page.mouse.down();
  await page.waitForTimeout(120);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, Math.round(y0 + (dy * i) / steps));
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(800);
  out['geometryAfter'] = await page.evaluate(probeKlineGeometry);
  out['layoutAfter'] = await page.evaluate(probeChartLayout);
  return out;
}

/** 复位结果页滚动（Playwright 点击 tab 会 scrollIntoView ⇒ 图表卡可能滚出视口，影响拖拽与截图）。
 *
 *  **2026-09-23 重锚**：D7 后**滚动容器 = 上栏 `wb-kline-view`**（页面级滚动已移除，§2.7 第 1 项）——
 *  旧写法只写 `wb-result.scrollTop`，在新契约下是 **no-op**（`wb-result` 的 clientHeight == scrollHeight）。
 *  本函数改为复位上栏 + 下栏 + 窗口三者（`wb-result` 保留兼容写入，代价为零）。 */
async function resetScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const id of ['wb-kline-view', 'wb-detail-pane', 'wb-result']) {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      if (el) el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
}

async function shoot(page: Page, label: string): Promise<string> {
  mkdirSync(OUT, { recursive: true });
  const file = `state_${label}.png`;
  await page.screenshot({ path: resolve(OUT, file) });
  return file;
}

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

// ═══════════════════════════════════════════════ 用例 ═══════════════════════════════════════════════

test.describe.configure({ mode: 'serial' });

test('P1..P4 结果页图表卡缩放探针：指标入口 / 副图拖拽 / 卡片高度结构 / 拖高后对齐 ≤2px', async ({ page }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(installChartCapture);

  /** 目标 run 解析（谓词 `m5`；`ADR028_RESIZE_RUN` 指定时跳过）——必须在任何读数之前完成。 */
  const resolvedRun = await resolveTargetRun(page);

  const env = {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081',
    runId: RUN_ID,
    runResolution: resolvedRun
      ? { id: resolvedRun.id, predicate: resolvedRun.predicate, totalBars: resolvedRun.totalBars, evidence: resolvedRun.evidence }
      : { source: 'env ADR028_RESIZE_RUN（本机调参逃生门）', id: RUN_ID },
    viewport: page.viewportSize(),
    barSeconds: BAR_SECONDS,
    alignTolPx: ALIGN_TOL_PX,
    curvePlotW: CURVE_PLOT_W,
    heights: { klineTall: KLINE_H_TALL, klineShort: KLINE_H_SHORT, curveCard: CURVE_CARD_H },
    startedAt: new Date().toISOString(),
    metricVersion: 'v1: v2 same-bar pairing (Δraw px + Δ984 normalized) + cross-view userX + plot edges',
  };

  await openRunSettled(page, RUN_ID);
  await waitCurvesSettled(page);
  await resetScroll(page);

  // ─────────── P0（**2026-09-25 重锚补钉**）：ResizeObserver 活性基线（**任何写窗之前**）───────────
  // P5 的核心判据是「锁定期间容器尺寸变化**不得**重拟合」。若本页 resize 本来就不改 barSpace，
  // 该判据会**恒真**。故在未锁定态先证「宽变 ⇒ barSpace 真的变」（有鉴别力的活性基线）。
  const p0Liveness = await (async () => {
    const vp0 = page.viewportSize();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(900);
    const narrow = await readLockTruth(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(1600);
    const wide = await readLockTruth(page);
    if (vp0) {
      await page.setViewportSize(vp0);
      await page.waitForTimeout(900);
    }
    const out = { atEntry: { locked: narrow.locked }, narrow, wide, restoredViewport: vp0 };
    writeJson('p0_resize_liveness', { ...out, env });
    expect(
      wide.barSpace,
      `P0 活性基线：未锁定态视口宽变（chartWidth ${String(narrow.chartWidth)} → ${String(wide.chartWidth)}）必须真的改写真身 barSpace`,
    ).not.toBe(narrow.barSpace);
    return out;
  })();

  // ─────────────────────── P1：副图指标入口 + 当前副图指标 ───────────────────────
  const domBase = await page.evaluate(probeResultDom);
  const layoutBase = await page.evaluate(probeChartLayout);
  const klineDomBase = await page.evaluate(probeKlineDom);

  // ── P1 附加（**2026-09-23 重锚**，D6-5）：指标勾选已**收进浮层** ⇒ 收起态只命中 1 枚入口按钮
  //    （`wb-indicator-menu`）。重锚口径 = **先展开浮层再扫**（收起/展开两态读数都落盘），
  //    否则「指标入口」读数恒为 1（旧口径过期，不是缺陷）。扫完复位（不影响后续布局读数）。 */
  const indicatorEntryProbe = await (async () => {
    const menu = page.getByTestId('wb-indicator-menu');
    const menuEntryCount = await menu.count();
    let expandedOpen = false;
    let expandedDom: Record<string, unknown> | null = null;
    if (menuEntryCount > 0) {
      await menu.click();
      await page.waitForTimeout(300);
      expandedOpen = (await page.getByTestId('wb-indicator-popover').count()) > 0;
      expandedDom = (await page.evaluate(probeResultDom)) as Record<string, unknown>;
      await menu.click();
      await page.waitForTimeout(200);
    }
    return {
      menuEntryCount,
      menuAriaExpandedAfterOpen: menuEntryCount > 0 ? await menu.getAttribute('aria-expanded') : null,
      expandedOpen,
      collapsedCount: (domBase['indicatorish'] as unknown[]).length,
      expandedCount: ((expandedDom?.['indicatorish'] as unknown[]) ?? []).length,
      expandedEntries: (expandedDom?.['indicatorish'] as unknown[]) ?? [],
      expandedMaEntries: (expandedDom?.['maish'] as unknown[]) ?? [],
      expandedFabToggleCount: ((expandedDom?.['controls'] as unknown[]) ?? []).filter((c) =>
        /fab-toggle|vol-toggle|indicator/i.test(String((c as Record<string, unknown>)['testid'] ?? '')),
      ),
    };
  })();

  const p1 = {
    controlsTotal: (domBase['controls'] as unknown[]).length,
    controls: domBase['controls'],
    indicatorEntries: domBase['indicatorish'],
    maEntries: domBase['maish'],
    paneInventory: layoutBase['panes'] ?? null,
    indicators: layoutBase['indicators'] ?? null,
    chartSizes: layoutBase['sizes'] ?? null,
    separatorStyle: layoutBase['separatorStyle'] ?? null,
    klineDomChildren: klineDomBase['children'],
    horizontalSeparatorHitTargets: klineDomBase['horizontalSeparatorHitTargets'],
    nsResizeNonSeparatorWidgets: klineDomBase['nsResizeNonSeparatorWidgets'],
    klineChartId: klineDomBase['kLineChartId'],
    indicatorEntryProbe,
    chartPane: domBase['chartPane'],
    detailPane: domBase['detailPane'],
    resultScrollLegacy: domBase['resultScroll'],
    cardHeightAnchor: domBase['cardHeightAnchor'],
    pageScroll: domBase['pageScroll'],
  };
  writeJson('p1_indicator_entry', { ...p1, env });
  await shoot(page, 'p1_base');

  // ─────────────────────── P3：图表卡高度与容器结构 + 表格自适应 ───────────────────────
  // 表格三处锚点（默认 Tab = 交易明细 ⇒ 先测它，再逐 Tab 切换测）
  const tables: Record<string, unknown> = {};
  await resetScroll(page);
  tables['trades(tab default)'] = await page.evaluate(probeTableAnchors, { anchors: ['wb-round-trips-table', 'wb-rt-coverage'] });
  await page.getByTestId('wb-tab-perbar').click();
  await page.waitForTimeout(900);
  tables['perbar(tab)'] = await page.evaluate(probeTableAnchors, { anchors: ['wb-perbar-table', 'wb-perbar-coverage'] });
  await shoot(page, 'p3_tab_perbar');
  await page.getByTestId('wb-tab-events').click();
  await page.waitForTimeout(900);
  tables['events(tab)'] = await page.evaluate(probeTableAnchors, { anchors: ['wb-event-log', 'wb-event-log-coverage'] });
  await shoot(page, 'p3_tab_events');
  await page.getByTestId('wb-tab-metrics').click();
  await page.waitForTimeout(700);
  tables['metrics(tab)'] = await page.evaluate(probeTableAnchors, { anchors: ['wb-metrics-table'] });
  await page.getByTestId('wb-tab-trades').click();
  await page.waitForTimeout(900);
  await resetScroll(page);

  const p3Base = {
    cards: domBase['cards'],
    resultScroll: domBase['resultScroll'],
    chartPane: domBase['chartPane'],
    detailPane: domBase['detailPane'],
    cardHeightAnchor: domBase['cardHeightAnchor'],
    tables,
    afterTabReturn: await page.evaluate(probeResultDom),
  };
  writeJson('p3_card_structure', { ...p3Base, env });

  // 曲线卡「拖高」注入实验：inline height + flex-shrink:0（否则 flex 收缩会把高度吞掉）
  const curveCardInjection = await (async () => {
    const read = (id: string) =>
      page.evaluate((tid: string) => {
        const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null;
        const svg = el?.querySelector('svg') as SVGSVGElement | null;
        if (!el) return null;
        const er = el.getBoundingClientRect();
        const sr = svg?.getBoundingClientRect() ?? null;
        const cs = getComputedStyle(el);
        return {
          cardHeight: Math.round(er.height),
          cardFlexShrink: cs.flexShrink,
          svgHeight: sr ? Math.round(sr.height) : null,
          svgClass: svg?.getAttribute('class') ?? null,
          svgViewBox: svg?.getAttribute('viewBox') ?? null,
        };
      }, id);
    const before = await read('wb-aggregate-chart');
    const beforeNoShrink = await (async () => {
      // 仅关掉 flex 收缩（不改高度）：验证「高度是否被 flex 收缩吞掉」
      await page.evaluate((id: string) => {
        const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        if (el) el.style.flexShrink = '0';
      }, 'wb-aggregate-chart');
      await page.waitForTimeout(500);
      return read('wb-aggregate-chart');
    })();
    const injected = await (async () => {
      await page.evaluate(
        ({ id, h }: { id: string; h: number }) => {
          const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
          if (el) el.style.height = `${h}px`;
        },
        { id: 'wb-aggregate-chart', h: CURVE_CARD_H },
      );
      await page.waitForTimeout(700);
      return read('wb-aggregate-chart');
    })();
    await page.evaluate((id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      if (el) {
        el.style.height = '';
        el.style.flexShrink = '';
      }
    }, 'wb-aggregate-chart');
    await page.waitForTimeout(500);
    const restored = await read('wb-aggregate-chart');
    return {
      injectedHeight: CURVE_CARD_H,
      before,
      beforeNoShrink,
      injected,
      restored,
      svgFollowsCard: injected?.svgHeight !== before?.svgHeight,
      cardFollowsInjection: injected?.cardHeight === CURVE_CARD_H,
    };
  })();
  writeJson('p3_curve_card_injection', { curveCardInjection, env });
  await shoot(page, 'p3_curve_card_injection');

  // K 线卡「拖高」注入实验（卡片自带 shrink-0 ⇒ 应可直接变高）
  const klineCardInjection = await (async () => {
    const read = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="wb-kline-chart"]') as HTMLElement | null;
        const inner = document.querySelector('[data-testid="kline-chart"]') as HTMLElement | null;
        if (!el) return null;
        return {
          cardHeight: Math.round(el.getBoundingClientRect().height),
          innerHeight: inner ? Math.round(inner.getBoundingClientRect().height) : null,
        };
      });
    const before = await read();
    await page.evaluate((h: number) => {
      const el = document.querySelector('[data-testid="wb-kline-chart"]') as HTMLElement | null;
      if (el) el.style.height = `${h}px`;
    }, KLINE_H_TALL);
    await page.waitForTimeout(900);
    const tall = await read();
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="wb-kline-chart"]') as HTMLElement | null;
      if (el) el.style.height = '';
    });
    await page.waitForTimeout(700);
    return { injectedHeight: KLINE_H_TALL, before, tall, restored: await read() };
  })();
  writeJson('p3_kline_card_injection', { klineCardInjection, env });

  // ─────────────────────── P2：K 线副图（VOL）拖拽是否已可用 ───────────────────────
  const paneHeights = (l: Record<string, unknown>) =>
    (l['panes'] as Array<{ id: string; height: number; minHeight: number; dragEnabled: boolean; state: string }> | undefined)?.map(
      (p) => ({ id: p.id, height: p.height, minHeight: p.minHeight, dragEnabled: p.dragEnabled, state: p.state }),
    ) ?? null;
  const domPanes = (g: unknown) =>
    ((g as { panes?: Array<{ rect: { top: number; height: number } }> } | null)?.panes ?? []).map((p) => p.rect);

  await resetScroll(page);
  const paneRectsAtTop = await page.evaluate(probeKlineGeometry);
  writeJson('p2_reset_check', { paneRectsAtTop, env });
  const beforeDragLayout = await page.evaluate(probeChartLayout) as Record<string, unknown>;
  const dragShrink = await dragSeparator(page, -40); // 向上拖 = 缩小 VOL、放大 candle
  const afterShrinkLayout = await page.evaluate(probeChartLayout) as Record<string, unknown>;
  const dragGrow = await dragSeparator(page, +40); // 向下拖 = 缩小 VOL、放大 candle
  const afterGrowLayout = await page.evaluate(probeChartLayout) as Record<string, unknown>;
  await shoot(page, 'p2_separator_drag');

  // 极限档：把分隔线拖到顶端（candle 压到 minHeight=30）⇒ 固定 256px 卡片下 VOL 的最大高度
  const dragMax = await dragSeparator(page, -200);
  const afterMaxLayout = await page.evaluate(probeChartLayout) as Record<string, unknown>;
  await shoot(page, 'p2_separator_drag_max_vol');

  // 窗口切换（全览）后：拖拽结果是否保留（图表实例不重建 ⇒ pane options 应保留）
  await page.getByTestId('wb-window-reset').click();
  await page.waitForTimeout(2000);
  const afterResetLayout = await page.evaluate(probeChartLayout) as Record<string, unknown>;
  await page.getByTestId('wb-window-back').click();
  await page.waitForTimeout(1500);
  const afterBackLayout = await page.evaluate(probeChartLayout) as Record<string, unknown>;

  const p2 = {
    dragEnabledFlag: paneHeights(beforeDragLayout),
    separatorStyle: beforeDragLayout['separatorStyle'],
    domPanesBefore: domPanes(dragShrink['geometryBefore']),
    domPanesAfterShrink: domPanes(dragShrink['geometryAfter']),
    domPanesAfterGrow: domPanes(dragGrow['geometryAfter']),
    domPanesAfterMaxVol: domPanes(dragMax['geometryAfter']),
    paneOptionsBefore: paneHeights(beforeDragLayout),
    paneOptionsAfterShrink: paneHeights(afterShrinkLayout),
    paneOptionsAfterGrow: paneHeights(afterGrowLayout),
    paneOptionsAfterMaxVol: paneHeights(afterMaxLayout),
    paneOptionsAfterWindowReset: paneHeights(afterResetLayout),
    paneOptionsAfterWindowBack: paneHeights(afterBackLayout),
    dragShrink,
    dragGrow,
    dragMax,
  };
  writeJson('p2_separator_drag', { ...p2, env });

  // 复原：把副图与 candle 拉回初始声明高度（100/100），避免影响后续对齐测量的口径
  await page.evaluate(() => {
    const w = window as unknown as { __wbCharts?: Array<Record<string, unknown>> };
    const chart = (w.__wbCharts ?? []).find(
      (c) => ((c['getDataList'] as (() => unknown[]) | undefined)?.() ?? []).length > 0,
    ) as
      | {
          getPaneOptions?: () => Array<{ id: string }>;
          setPaneOptions?: (o: { id: string; height: number }) => void;
        }
      | undefined;
    chart?.getPaneOptions?.().forEach((p) => {
      if (p.id !== 'x_axis_pane') chart?.setPaneOptions?.({ id: p.id, height: 100 });
    });
  });
  await page.waitForTimeout(900);

  // ─────────────────────── P4：对齐回归基线（高度改变前后） ───────────────────────
  const states: Array<Record<string, unknown>> = [];
  const record = async (label: string) => {
    await resetScroll(page);
    await waitCurvesSettled(page);
    const st = await measureAlignment(page, label, RUN_ID);
    st['screenshot'] = await shoot(page, `p4_${label}`);
    states.push(st);
    writeJson(`p4_state_${label}`, { ...st, env });
    return st;
  };

  await record('base');

  await page.evaluate((h: number) => {
    const el = document.querySelector('[data-testid="wb-kline-chart"]') as HTMLElement | null;
    if (el) el.style.height = `${h}px`;
  }, KLINE_H_TALL);
  await page.waitForTimeout(900);
  await record('klineTall');

  await page.evaluate((h: number) => {
    const el = document.querySelector('[data-testid="wb-kline-chart"]') as HTMLElement | null;
    if (el) el.style.height = `${h}px`;
  }, KLINE_H_SHORT);
  await page.waitForTimeout(900);
  await record('klineShort');

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="wb-kline-chart"]') as HTMLElement | null;
    if (el) el.style.height = '';
  });
  await page.waitForTimeout(900);
  await record('restored');

  await dragSeparator(page, -60);
  await record('volShrunk');

  // 视图级缩放（浏览器 zoom=0.8）：整页缩放后各图仍必须同 bar 对齐
  await page.evaluate(() => {
    document.documentElement.style.zoom = '0.8';
  });
  await page.waitForTimeout(1400);
  await record('zoom80');
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  await page.waitForTimeout(900);
  await record('zoomRestored');

  writeJson('p4_alignment_states', { env, labels: states.map((s) => s['label']), states });

  const compact = states.map((s) => ({
    label: s['label'],
    klineVisibleBars: (s['kline'] as { visibleCount: number }).visibleCount,
    klineBarSpace: (s['kline'] as { barSpace: number | null }).barSpace,
    klineCardHeight: (s['cards'] as Record<string, { rect?: { height: number } }>)['wb-kline-chart']?.rect?.height,
    views: (s['views'] as Array<Record<string, unknown>>).map((v) => ({
      id: v['testid'],
      vertices: v['vertices'],
      apiPoints: v['apiPoints'],
      pairs: v['pairs'],
      maxAbsRaw: v['maxAbsRawPx'],
      maxAbs984: v['maxAbs984Px'],
      maxAbsCenteredRaw: v['maxAbsCenteredRawPx'],
      maxAbsAnchoredRaw: v['maxAbsAnchoredRawPx'],
      offsetMedianRaw: v['offsetMedianRawPx'],
      spanC: v['spanC'],
      ok: v['ok'],
    })),
    crossViewMaxUserX: s['crossViewMaxUserX'],
    crossViewNote: s['crossViewNote'],
    edges: s['edges'],
  }));
  writeJson('p4_alignment_summary', compact);

  // ─────────────────────── 判据（硬断言仅 2 条；其余为取证数据） ───────────────────────
  for (const s of states) {
    const label = String(s['label']);
    const views = s['views'] as Array<Record<string, unknown>>;
    const zoomedState = label.startsWith('zoom80');
    for (const v of views) {
      expect(
        v['maxAbs984Px'],
        `${label}/${String(v['testid'])}：同一根 bar 配对 max|Δ984| 必须可算（pairs=${String(v['pairs'])}，spanC=${String(v['spanC'])}，K 线可见=${String((s['kline'] as { visibleCount: number }).visibleCount)}）`,
      ).not.toBeNull();
      expect(
        Number(v['maxAbs984Px']),
        `${label}/${String(v['testid'])}：同一根 bar 配对 max|Δ984| 必须 ≤ ${ALIGN_TOL_PX}px（尺度不变口径）`,
      ).toBeLessThanOrEqual(ALIGN_TOL_PX);
      if (!zoomedState) {
        expect(
          Number(v['maxAbsRawPx']),
          `${label}/${String(v['testid'])}：max|Δraw| 必须 ≤ ${ALIGN_TOL_PX}px（真身屏幕像素）`,
        ).toBeLessThanOrEqual(ALIGN_TOL_PX);
      } else {
        // CSS zoom 下 `getBoundingClientRect()`（被 zoom 缩放）与 `convertToPixel`/`getScreenCTM()`
        // （未缩放）**混用两个坐标系** ⇒ 绝对 Δraw 不可比（实测 offset≈93px）。
        // 该态判据 = 「锚点首末线性映射后的残差」≤2px（即 Δ984 × spanK/984，对尺度差免疫）；
        // 绝对值一并落盘披露（offsetMedianRawPx / maxAbsCenteredRawPx）。
        expect(
          Number(v['maxAbsAnchoredRawPx']),
          `${label}/${String(v['testid'])}：CSS zoom 态尺度校正残差必须 ≤ ${ALIGN_TOL_PX}px（绝对 Δraw=${String(v['maxAbsRawPx'])}px 属坐标系混合，offset=${String(v['offsetMedianRawPx'])}px）`,
        ).toBeLessThanOrEqual(ALIGN_TOL_PX);
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // P5（**2026-09-25 重锚补钉**，ADR-028 §2.10 D10 决策 1）：「视口锁定期间**不得**重拟合」契约。
  //   本规格的主题恰是**容器尺寸变化**（卡高注入 / 视口宽高 / CSS zoom），而 D10 定位的缺陷机制就是
  //   「程序化写窗后 16ms 内被 `ResizeObserver → fitBarSpaceToViewport(chart, el, 120)` 重拟合」⇒
  //   在此把该语义钉住：①程序化写窗（L1 跳转）成功 ⇒ 宿主留痕 `data-viewport-lock=1`；
  //   ②此后**视口宽高变化**（ResizeObserver 的唯一输入）**不得**改写真身 barSpace；
  //   ③鉴别力自证：未锁定时应拟合值 `round(chartWidth/120)` 必须 ≠ 锁定值（否则本判据恒真 ⇒ 直接红）；
  //   ④解锁路径（「全览」）⇒ 锁定痕迹必须消失，且此后视口再变必须**真的**重拟合（证 RO 路径是活的，
  //     不是「因为 resize 无效所以看起来没被改写」）。
  //   （互补规格：`adr028-window-sync.e2e.ts` D10L_lock 覆盖活体探针一致性 + 手势解锁；本处不重复。）
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  const p5: Record<string, unknown> = {};
  {
    // ⓪ 活性基线见 **P0**（任何写窗之前实测「宽变 ⇒ barSpace 变」⇒ ② 的「未被改写」有鉴别力）。
    //    本段起于 P4 之后：P2 已点过「窗口复位/回退」（程序化写窗 ⇒ 视口已被锁定），故此处**不**要求未锁。
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(800);

    // ① 程序化写窗（L1 跳转）成功 ⇒ 视口锁定（ADR-028 §2.10 决策 1）
    const jump = page.getByTestId('wb-rt-jump-1');
    await expect(jump, 'P5 前提：目标 run 必须有第 1 回合的跳转按钮（程序化写窗入口）').toBeVisible();
    await jump.click();
    await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'jump');
    await expect(page.getByTestId('wb-window-probe')).toHaveAttribute('data-applied-ok', 'true');
    await page.waitForTimeout(800);
    const lockedWide = await readLockTruth(page);
    expect(lockedWide.locked, '程序化写窗成功后必须锁定视口（留痕 data-viewport-lock=1）').toBe('1');
    expect(lockedWide.barSpace, 'P5 前提：锁定态必须有 barSpace 读数').not.toBeNull();

    // ② **核心判据**：锁定期间容器尺寸变化（1600×900 → 1280×800）**不得**重拟合 barSpace
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(1600); // RO + rAF + 引擎重排（未锁定时实测 16ms 即被改写）
    const lockedNarrow = await readLockTruth(page);
    const refitWouldBe = lockedNarrow.chartWidth != null ? Math.round(lockedNarrow.chartWidth / 120) : null;
    // 鉴别力自证：未锁定时应拟合值必须 ≠ 锁定值（否则「未被改写」恒真 ⇒ 直接红）
    expect(
      refitWouldBe,
      `P5 鉴别力自证：未锁定应拟合值 round(${String(lockedNarrow.chartWidth)}/120)=${String(refitWouldBe)} 必须 ≠ 锁定值 ${String(lockedWide.barSpace)}`,
    ).not.toBe(lockedWide.barSpace);
    expect(lockedNarrow.locked, '锁定期间视口尺寸变化不得解锁').toBe('1');
    expect(
      lockedNarrow.barSpace,
      `锁定期间容器尺寸变化（chartWidth ${String(lockedWide.chartWidth)} → ${String(lockedNarrow.chartWidth)}）**不得**重拟合 barSpace（D10 决策 1）`,
    ).toBe(lockedWide.barSpace);

    // ③ 显式解锁路径 = **真实手势**（ADR-028 §2.10 决策 1）；解锁后窗口可再变（禁「锁死」）。
    //    注：「全览」**不解锁**（实测 + 实现注释「跳转/全览必须留在原地」⇒ 全览也是程序化写窗 ⇒ 重新锁定）；
    //    该措辞差（§2.10 决策 1 原文把「全览」列为解锁动作）**只登记不断言**，避免用未裁定口径自造判据。
    const box = await page.locator('[data-testid="kline-chart"]').first().boundingBox();
    const cx = Math.min(Math.max((box?.x ?? 0) + (box?.width ?? 600) / 2, 1), 1200);
    const cy = Math.min(Math.max((box?.y ?? 0) + (box?.height ?? 200) / 2, 1), 780);
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(800);
    const afterGesture = await readLockTruth(page);

    Object.assign(p5, {
      livenessBaseline: p0Liveness,
      lockedWide,
      lockedNarrow,
      refitWouldBe,
      afterGesture,
    });
    writeJson('p5_viewport_lock', { ...p5, env });

    expect(afterGesture.locked, '真实手势 ⇒ 锁定必须解除（ADR-028 §2.10 决策 1 显式解锁路径）').toBeNull();
    expect(afterGesture.barSpace, '手势后窗口可再变（禁「锁死」）').not.toBe(lockedWide.barSpace);
  }

  const sink = {
    env,
    finishedAt: new Date().toISOString(),
    p1: {
      controlsTotal: p1.controlsTotal,
      indicatorEntries: p1.indicatorEntries,
      indicatorEntryProbe,
      chartPane: domBase['chartPane'],
      detailPane: domBase['detailPane'],
      cardHeightAnchor: domBase['cardHeightAnchor'],
      indicators: p1.indicators,
      paneInventory: p1.paneInventory,
      horizontalSeparatorHitTargets: p1.horizontalSeparatorHitTargets,
    },
    p2: {
      dragEnabledFlag: p2.dragEnabledFlag,
      paneOptionsBefore: p2.paneOptionsBefore,
      paneOptionsAfterShrink: p2.paneOptionsAfterShrink,
      paneOptionsAfterGrow: p2.paneOptionsAfterGrow,
      paneOptionsAfterMaxVol: p2.paneOptionsAfterMaxVol,
      paneOptionsAfterWindowReset: p2.paneOptionsAfterWindowReset,
      paneOptionsAfterWindowBack: p2.paneOptionsAfterWindowBack,
      domPanesBefore: p2.domPanesBefore,
      domPanesAfterShrink: p2.domPanesAfterShrink,
      domPanesAfterGrow: p2.domPanesAfterGrow,
      domPanesAfterMaxVol: p2.domPanesAfterMaxVol,
    },
    p3: { curveCardInjection, klineCardInjection, resultScroll: p3Base.resultScroll },
    p5: { viewportLock: p5, runResolution: (env as { runResolution?: unknown }).runResolution },
  };
  writeJson('summary', sink);
  // eslint-disable-next-line no-console
  console.log(
    '[resize-probe] ' +
      JSON.stringify({
        indicatorEntries: p1.indicatorEntries,
        indicatorEntriesCollapsed: indicatorEntryProbe.collapsedCount,
        indicatorEntriesExpanded: indicatorEntryProbe.expandedCount,
        chartPaneOverflowY: (domBase['chartPane'] as { overflowY?: string } | null)?.overflowY ?? null,
        indicators: p1.indicators,
        dragBefore: p2.domPanesBefore,
        dragAfterShrink: p2.domPanesAfterShrink,
        dragAfterGrow: p2.domPanesAfterGrow,
        curveSvgFollows: curveCardInjection.svgFollowsCard,
      }),
  );
});
