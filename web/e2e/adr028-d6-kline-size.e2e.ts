/**
 * ADR-028 §2.6（**D6｜K 线尺寸与主视图优先分配**）真渲染判据
 * —— **2026-09-24 按 §2.9（D9）三视图契约重锚**（本文件不再是「卡高规格」）。
 *
 * ## 契约（唯一事实源；本规格按契约推导，**不按实现输出倒推**，依 ADR-023 §6.2）
 * `design/01-architecture/adr/ADR-028-…§2.6 / §2.8 / §2.9 / §4 第 8·11·12 条 / §5`
 * + `design/17-trade-detail-layering/08-plan-three-view-split.md`（判据 **D9-1..13**、§3 改动清单、§4 边界）。
 *
 * ## 重锚推导（旧契约 → 新契约，逐条；**D6 的卡片语义被 D9 的视图语义取代**）
 * | 旧（D6） | 新（D9） | 依据 |
 * |---|---|---|
 * | D6-1 无记忆值时卡高 == **520** | **删除**：卡片 `h-full` ⇒ `卡高 = K 线视图高 − 60`（恒等式） | §2.9-5（Q1=B）+ §2.9-6 恒等式 |
 * | D6-2 预设 S/M/L ⇒ 260/420/560 | **删除**：断言**不存在**；可调性转移到「K线↔指标」分隔条 | §2.9-5（删 D6 第 2 项）+ D9-5/D9-6 |
 * | D6-3 默认 520 态 主图 ≥320 ∧ 副图 ≤120 ∧ 卡头 ≤48 | **保留副图/卡头**；主图改按 **D9-8③ 分档**（几何可行 ⇒ ≥320；不可行 ⇒ K 线视图 == 可用 − 180 − 95 且披露） | §2.9-6③（分档）+ §4-12② |
 * | D6-4 拖卡到有效下限 ⇒ 卡高 ≥200 ∧ 主图 ≥160 ∧ 副图 ≥30；引擎分隔条越界 clamp | **卡高路径删除** ⇒ 改「拖 K线↔指标 向下越界 ⇒ K 线视图停可读下限 299（1 副图）+ 主图 ≥160 + 副图 ≥30」；**引擎 pane 分隔条路径保留**（卡高不变 ∧ 主图 ≥160） | §2.9-5/6/7 + §5「D6 第 3/4 项保留，约束对象改为 K 线视图高」 |
 * | D6-5 卡下沿把手命中带 ≥12px + 悬停可见 | **规则转移**到分隔条（把手已删）：分隔条命中带 ≥12px + 悬停计算样式变化且非全透明 + `cursor: ns-resize` | §2.9-5（第 5 项规则转移）+ §2.8 |
 * | D6-6 拖卡 +N ⇒ 卡高/内层双变化；刷新保持；双击标题复位 520 | **改**：拖 K线↔指标 上拖 +N ⇒ K 线视图 / 卡高 / 内层**三者同步 +N**（1:1）；下拖 ⇒ −N；双击**分隔条**复位默认比例 0.55；刷新后比例保持 | §2.9-6/8（D9-6⑥）+ §2.8 |
 * | D6-7 高度写 `eestock.result.cardHeights.v1` | **改**：比例写 `eestock.result.layout.v2`；旧卡高键**只读迁移、逐字节不变**；看板 key 逐字节不变 | §2.9-11（D9-11） |
 * | （新增）守恒 | 任意调整后 `三段高之和 == 可用高`（±2px）；`可用高 = 视口高 − 132` | §2.9-6④ + §2.9-7 |
 *
 * **D6-5「悬停可见」的落地位置（2026-09-24 独立复验指出「头注释声明已转移、正文 0 条断言」后修复）**：
 * 本规格 t1 断言 **两条**分隔条的默认态 `alpha == 0` ∧ 悬停计算样式**变化** ∧ 悬停 `alpha > 0` ∧ 移出回落，
 * 与上表「悬停计算样式变化且非全透明」逐字对应（旧版正文缺此 3 句 ⇒ 自证不符，已恢复）。
 *
 * 真身读数一律取 **klinecharts 实例**（`getSize(paneId)`/`getPaneOptions()`，经 `Map.prototype.set` 捕获），
 * 页面 `data-*`（`data-pane-metrics` / `data-kline-view-height` / `data-view-*`）仅作交叉校验。
 *
 * ## 运行（沙箱预览，**不碰线上 web/dist**；证据落**未跟踪**目录，AGENTS.md 2026-09-23 纪律）
 *   cd web && npx vite build --outDir /tmp/<build> --emptyOutDir
 *   VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/<build> --strictPort --port <free>
 *   E2E_BASE_URL=http://127.0.0.1:<free> npx playwright test e2e/adr028-d6-kline-size.e2e.ts --retries=0 --workers=1
 * 原始读数落盘：`ADR028_D6_OUT`（默认 = **未跟踪**的 `tester/evidence/20260924_d9_spec_reanchor/raw/d6`；
 * 亦可用 `E2E_EVIDENCE_DIR` 指定基目录）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 默认出口 = **规格相对**的未跟踪目录（`tester/evidence/` 已 .gitignore；**禁止**指向他批已跟踪目录）。 */
const OUT =
  process.env.ADR028_D6_OUT ??
  resolve(process.env.E2E_EVIDENCE_DIR ?? resolve(REPO, 'tester/evidence/20260924_d9_spec_reanchor/raw'), 'd6');
const RUN_ID = process.env.ADR028_D6_RUN ?? 'sr_1789832517800_000006';

// ── 契约常量（ADR-028 §2.9；本规格自持，**不 import 产品模块**，避免「按实现倒推」）──
/** D9-7/D9-8 口径：可用高 = 视口高 − 132。 */
const VIEW_AVAILABLE_CHROME_PX = 132;
/** D9-7 三视图可读下限（1 副图 / 2 副图）。 */
const VIEW_MIN = { klineOneSub: 299, klineTwoSub: 329, indicators: 180, detail: 95 } as const;
/** D9-8① 恒等式项：K 线视图内的固定 chrome（窗口条 34 + 载入提示 18 + gap 8）。 */
const KLINE_VIEW_CHROME_PX = 60;
/** D9-8① 恒等式项：卡高 → 内层（卡头 20 + 边框 2）。 */
const KLINE_CARD_BORDER_HEADER_PX = 22;
/** D9-8① 恒等式项：x 轴 26 + 每个副图的 1px 分隔。 */
const X_AXIS_PX = 26;
const PANE_SEPARATOR_PX = 1;
/** D9-8② 硬不变量。 */
const MAIN_MIN_PX = 160;
const SUB_PANE_MIN_PX = 30;
const SUB_PANE_TOTAL_MAX_PX = 120;
/** D9-8③ 分档：几何可行支的主图下限。 */
const MAIN_PREFERRED_MIN_PX = 320;
/** D9-8③ 分档阈值：`529`（= 320 + 209，1 副图时 K 线视图 → 主图 ≥320 所需的最小视图高）
 *  + `指标下限 180 + 明细下限 95`。可用高 ≥ 该值 ⇒ 断言主图 ≥320；否则走「K 线优先吃满 + 披露」支。 */
const AVAILABLE_FEASIBLE_PX = 529 + VIEW_MIN.indicators + VIEW_MIN.detail;
/** D9-5：卡头（D6-5 保留项）上限。 */
const HEADER_MAX_PX = 48;
/** D6-5 规则转移（§2.9-5）：分隔条**可命中带**下限。 */
const SPLITTER_MIN_HIT_PX = 12;
/** D6-5 规则转移的载体：**两条**分隔条（`useResultLayout.splitterProps` 同源 ⇒ 悬停类必须同效）。 */
const SPLITTER_IDS = ['wb-splitter-kline-indicators', 'wb-splitter-indicators-detail'] as const;
/** D9-7 默认三段比例。 */
const DEFAULT_RATIOS = { kline: 0.55, indicators: 0.29, detail: 0.16 } as const;
const TOL_PX = 2;

// ── 键（D9-11）──
const LAYOUT_V2_KEY = 'eestock.result.layout.v2';
const CARD_HEIGHT_KEY = 'eestock.result.cardHeights.v1';
const LEGACY_KEY = 'eestock.wb.result.chartConfig.v1';
const DASHBOARD_KEY = 'eestock.dashboard.layout.v1';

function writeJson(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

// ═══════════════════════ 页面侧探针（自包含） ═══════════════════════

/** klinecharts 实例捕获（沿用既有约定）。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { pitch?: unknown; setBarSpace?: unknown; convertToPixel?: unknown } | null;
    if (
      o != null &&
      typeof o === 'object' &&
      typeof o['setBarSpace'] === 'function' &&
      typeof o['convertToPixel'] === 'function'
    ) {
      w.__wbCharts!.push(value);
    }
    return orig.call(this, key, value);
  };
}

/** 一次读全：三视图几何 + 真身 pane 尺寸/选项 + 卡高机制残留 + 分隔条 + localStorage。 */
function probeDom() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const scroll = (el: Element | null) =>
    el == null
      ? null
      : {
          scrollH: (el as HTMLElement).scrollHeight,
          clientH: (el as HTMLElement).clientHeight,
          scrollTop: Math.round((el as HTMLElement).scrollTop),
          overflowY: getComputedStyle(el).overflowY,
        };
  interface ChartLike {
    getDataList?: () => Array<{ timestamp: number }>;
    getSize?: (paneId?: string, position?: string) => { width?: number; height?: number } | null;
    getPaneOptions?: (id?: string) => unknown;
  }
  const card = q('wb-kline-chart');
  const klineInner = q('kline-chart');
  const header = card?.querySelector('[data-testid="wb-kline-card-header"]') as HTMLElement | null;
  // 真身：选「容器宽度与 kline 内层最接近 且 getDataList 非空」的实例
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const target = klineInner ? klineInner.getBoundingClientRect().width : 0;
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
      ? withData.reduce((a, b) => (Math.abs(a.width - target) <= Math.abs(b.width - target) ? a : b))
      : null;
  let paneOpts: Array<{ id: string; height: number; minHeight: number }> = [];
  const paneSizes: Record<string, number | null> = {};
  if (chosen) {
    try {
      const raw = chosen.c.getPaneOptions?.();
      const arr = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      paneOpts = arr.map((p) => ({
        id: String(p['id']),
        height: Number(p['height']),
        minHeight: Number(p['minHeight']),
      }));
    } catch {
      /* ignore */
    }
    for (const p of paneOpts) {
      try {
        paneSizes[p.id] = chosen.c.getSize?.(p.id)?.height ?? null;
      } catch {
        paneSizes[p.id] = null;
      }
    }
  }
  const subPaneIds = paneOpts.map((p) => p.id).filter((id) => id !== 'candle_pane' && id !== 'x_axis_pane');
  const subSizes = subPaneIds.map((id) => paneSizes[id]);
  const subTotal =
    subSizes.length > 0 && subSizes.every((v) => typeof v === 'number')
      ? subSizes.reduce<number>((a, b) => a + (b as number), 0)
      : null;
  // （2026-09-24 死代码清理：此处原有 `const result = q('wb-result')` 从未被引用 ⇒ 删除）
  const raw = (id: string, attr: string) => q(id)?.getAttribute(attr) ?? null;
  let paneMetrics: unknown = null;
  try {
    const s = raw('kline-chart', 'data-pane-metrics');
    paneMetrics = s ? JSON.parse(s) : null;
  } catch {
    paneMetrics = null;
  }
  // 本函数会被序列化到页面上下文执行 ⇒ **常量必须内联**（不得引用模块作用域变量）。
  let ls: Record<string, string | null> = {};
  try {
    ls = {
      'eestock.result.layout.v2': localStorage.getItem('eestock.result.layout.v2'),
      'eestock.result.cardHeights.v1': localStorage.getItem('eestock.result.cardHeights.v1'),
      'eestock.wb.result.chartConfig.v1': localStorage.getItem('eestock.wb.result.chartConfig.v1'),
      'eestock.dashboard.layout.v1': localStorage.getItem('eestock.dashboard.layout.v1'),
    };
  } catch {
    /* ignore */
  }
  const splitterKI = q('wb-splitter-kline-indicators');
  // **「采集未断言」审计（2026-09-24，本批）**：以下读数中 `klineViewScroll` / `pageScroll` / `panes` /
  //  `xAxisH` 属**披露用读数**（随 `writeJson` 落盘供交叉校验；其对应判据在 `adr028-d7/d9-*.e2e.ts` 内），
  //  **本规格不对其断言** ⇒ 明确登记为披露项，不计为「假覆盖」。
  //  其余字段均有本规格内的消费点；`splitterKI.bg` 的消费点 = t1 的 D6-5 悬停判据（默认态 alpha == 0）。
  return {
    viewportH: window.innerHeight,
    view: {
      kline: rect(q('wb-kline-view')),
      indicators: rect(q('wb-indicator-view')),
      detail: rect(q('wb-detail-view')),
      split: rect(q('wb-result-split')),
    },
    attrs: {
      ratioKline: raw('wb-result', 'data-view-ratio-kline'),
      ratioIndicators: raw('wb-result', 'data-view-ratio-indicators'),
      ratioDetail: raw('wb-result', 'data-view-ratio-detail'),
      heightKline: raw('wb-result', 'data-view-height-kline'),
      heightIndicators: raw('wb-result', 'data-view-height-indicators'),
      heightDetail: raw('wb-result', 'data-view-height-detail'),
      available: raw('wb-result', 'data-view-available'),
      clamped: raw('wb-result', 'data-view-clamped'),
      compressed: raw('wb-result', 'data-view-compressed'),
      subPaneCount: raw('wb-result', 'data-kline-sub-pane-count'),
      cardViewHeight: raw('wb-kline-chart', 'data-kline-view-height'),
    },
    disclosure: q('wb-view-clamp-note')?.textContent ?? null,
    card: {
      rect: rect(card),
      inlineHeight: card?.style.height || null,
      attrHeaderPx: header ? Math.round(header.getBoundingClientRect().height) : null,
    },
    klineInner: rect(klineInner),
    headerH: header ? header.getBoundingClientRect().height : null,
    splitterKI: splitterKI
      ? {
          rect: rect(splitterKI),
          cursor: getComputedStyle(splitterKI).cursor,
          role: splitterKI.getAttribute('role'),
          // **消费点 = t1 的 D6-5 悬停判据**（默认态必须 alpha == 0）⇒ 非「采集未断言」的死采集。
          bg: getComputedStyle(splitterKI).backgroundColor,
        }
      : null,
    /** D9-5：卡高机制（S/M/L 预设 + 卡下沿把手）必须**不存在**。 */
    legacyCardHeight: {
      presets: (['s', 'm', 'l'] as const).map((k) => !!q(`wb-kline-preset-${k}`)),
      cardHandle: !!q('wb-card-resize-kline'),
    },
    /** D9-4：K 线视图不得有内部滚动（可调性作用域判别力所在）。 */
    klineViewScroll: scroll(q('wb-kline-view')),
    pageScroll: {
      scrollY: Math.round(window.scrollY),
      docScrollH: document.scrollingElement?.scrollHeight ?? -1,
      innerH: window.innerHeight,
    },
    panes: paneOpts,
    paneSizes,
    subPaneIds,
    subTotal,
    candleH: paneSizes['candle_pane'] ?? null,
    xAxisH: paneSizes['x_axis_pane'] ?? null,
    paneMetrics,
    storage: ls,
  };
}

const probe = (page: Page): Promise<ReturnType<typeof probeDom>> =>
  page.evaluate(probeDom) as unknown as Promise<ReturnType<typeof probeDom>>;

/** 分隔条命中带扫描：在分隔条的竖向范围内逐像素 `elementFromPoint`，判定归属（D6-5 规则转移）。 */
function splitterBandScan() {
  const sp = document.querySelector('[data-testid="wb-splitter-kline-indicators"]') as HTMLElement | null;
  if (!sp) return { ok: false, bandPx: 0, rows: [] as Array<{ dy: number; owner: string | null }> };
  const r = sp.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const rows: Array<{ dy: number; owner: string | null }> = [];
  let band = 0;
  let maxBand = 0;
  for (let y = Math.round(r.top - 6); y <= Math.round(r.bottom + 6); y++) {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const owner = el?.closest('[data-testid^="wb-splitter-"]')?.getAttribute('data-testid') ?? null;
    rows.push({ dy: y - Math.round(r.top), owner });
    if (owner === 'wb-splitter-kline-indicators') {
      band += 1;
      maxBand = Math.max(maxBand, band);
    } else {
      band = 0;
    }
  }
  return { ok: true, bandPx: maxBand, rows };
}

/** 引擎 pane 分隔条（DOM：宽度≈卡宽、高≈4–12、cursor=ns-resize 的层）。 */
function findPaneSeparator() {
  const klineInner = document.querySelector('[data-testid="kline-chart"]');
  const host = (klineInner?.querySelector('div') as HTMLElement | null) ?? (klineInner as HTMLElement | null);
  if (!host) return null;
  const all = Array.from(host.querySelectorAll('div')) as HTMLElement[];
  const cands = all
    .map((el) => ({ el, r: el.getBoundingClientRect(), cursor: getComputedStyle(el).cursor }))
    .filter((x) => x.cursor === 'ns-resize' && x.r.height >= 4 && x.r.height <= 12 && x.r.width > 100);
  if (cands.length === 0) return null;
  const { r } = cands[0]!;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
}

// ═══════════════════════ 驱动 ═══════════════════════

async function openRun(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-kline-view')).toBeVisible();
  await expect(page.getByTestId('wb-kline-chart')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    return !!el && el.getBoundingClientRect().height > 40;
  });
  await page.waitForTimeout(2500); // K 线/曲线取数（既定约定，非断言）
}

async function reselect(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.getByTestId(`wb-run-select-${runId}`).click();
  await expect(page.getByTestId('wb-kline-chart')).toBeVisible();
  await page.waitForTimeout(1800);
}

/**
 * 拖分隔条：`dy < 0` = 鼠标**向上**（契约 §2.8/§2.9-8：上移 ⇒ **上方**视图变高）。
 * 指针终点**夹在视口内**（越出视口的合成鼠标事件不可靠 ⇒ 会静默「什么都没发生」）。
 */
async function dragSplitter(page: Page, dy: number): Promise<void> {
  const box = await page.getByTestId('wb-splitter-kline-indicators').boundingBox();
  expect(box, '分隔条必须可命中（boundingBox 非空）').not.toBeNull();
  const vp = page.viewportSize() ?? { width: 1280, height: 900 };
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

// （2026-09-24 死代码清理：此处原有 `openIndicatorMenu` 辅助函数在本规格内**从未被调用**
//  —— 它是 `adr028-d5-resize-indicators.e2e.ts` 同名函数的复制残留；勾选指标属 D5 规格的判据载体。）

/**
 * 计算样式的**透明度**解析（真渲染通道；覆盖 `rgba()` / `rgb()` / `color(srgb … / a)` / `transparent`）。
 * 无法解析 ⇒ 返回 `NaN`（判据会因此变红，而不是静默通过）。
 */
function alphaOf(computedColor: string): number {
  const s = computedColor.trim();
  if (s === 'transparent') return 0;
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[,\s/]+/).filter((x) => x.length > 0);
    if (parts.length >= 4) return Number(parts[3]);
    return parts.length === 3 ? 1 : Number.NaN;
  }
  const c = /^color\(([^)]*)\)$/.exec(s);
  if (c) {
    const seg = c[1]!.split('/');
    if (seg.length >= 2) return Number(seg[1]!.trim());
    return seg.length === 1 ? 1 : Number.NaN;
  }
  return Number.NaN;
}

/** 读某元素**当前**计算 `background-color`（`getComputedStyle`，真渲染）。 */
function readBg(page: Page, testid: string): Promise<string | null> {
  return page.evaluate((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return el ? getComputedStyle(el).backgroundColor : null;
  }, testid);
}

/**
 * D6-5 规则转移（ADR-028 §2.9-5 第 5 项 + §2.8）的**悬停可见性**取材：
 * 默认态（指针移开）→ 悬停 → 移开，三个相位各读一次计算样式。
 * 判据在调用方（默认 alpha == 0 ∧ 悬停与默认**不同** ∧ 悬停 alpha > 0 ∧ 移出回落默认），
 * **不得**写成「恒真」（三项都由调用方断言，缺一即非鉴别判据）。
 */
async function splitterHoverReading(page: Page, testid: string) {
  await page.mouse.move(2, 2); // 指针离开分隔条 ⇒ 默认态
  await page.waitForTimeout(80);
  const before = await readBg(page, testid);
  const el = page.getByTestId(testid);
  await expect(el, `D6-5 规则转移：分隔条 ${testid} 必须存在（悬停判据前置）`).toBeVisible();
  await el.hover();
  await page.waitForTimeout(80);
  const after = await readBg(page, testid);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(80);
  const restored = await readBg(page, testid);
  return {
    testid,
    before,
    after,
    restored,
    alphaBefore: before == null ? Number.NaN : alphaOf(before),
    alphaAfter: after == null ? Number.NaN : alphaOf(after),
  };
}

// 视口口径：D9 默认比例下 `可用高 = 视口高 − 132`；要同时验证「上拖 +N 有余量」「越界夹取」与
// 「引擎分隔条 clamp」，取 1280×900（可用 768；默认三段 422/223/123，均高于可读下限 299/180/95）。
test.use({ viewport: { width: 1280, height: 900 } });

test.describe('ADR-028 D6 → D9 重锚（真渲染）', () => {
  test('D9-5/D9-8①②（重锚自 D6-1/D6-3/D6-5）：卡高机制必须不存在；默认态恒等式 + 硬不变量 + 卡头 ≤48px', async ({
    page,
  }) => {
    await page.addInitScript(installChartCapture);
    await openRun(page);

    const g = await probe(page);
    writeJson('d6_t1_default_identity', g);
    expect(g.card.rect, 'K 线卡必须存在').not.toBeNull();

    // ── D9-5（重锚自 D6-1/D6-2/D6-5）：卡高机制（S/M/L 预设 + 卡下沿把手 + inline 卡高）必须**不存在** ──
    expect(g.legacyCardHeight.presets, 'D9-5：S/M/L 预设必须不存在（D6 第 2 项被取代）').toEqual([false, false, false]);
    expect(g.legacyCardHeight.cardHandle, 'D9-5：K 线卡下沿把手必须不存在（D6 第 5 项规则转移到分隔条）').toBe(false);
    expect(g.card.inlineHeight ?? '', 'D9-5：卡片不得再持有 inline 卡高（h-full 随视图）').toBe('');
    // 可调性真的「转移」了：分隔条存在、role=separator、命中带 ≥12px、光标 ns-resize（D6-5 规则）
    expect(g.splitterKI, 'D9-6：K线↔指标 分隔条必须存在').not.toBeNull();
    expect(g.splitterKI!.role, 'D9-6：分隔条必须声明 role=separator').toBe('separator');
    expect(g.splitterKI!.cursor, 'D6-5 规则转移：分隔条光标须 ns-resize（纵向）').toBe('ns-resize');
    const band = await page.evaluate(splitterBandScan);
    expect(band.ok, '分隔条必须存在（命中带扫描前置）').toBe(true);
    expect(
      band.bandPx,
      `D6-5 规则转移：分隔条连续可命中带须 ≥${SPLITTER_MIN_HIT_PX}px（逐像素扫描，实读 ${band.bandPx}px）`,
    ).toBeGreaterThanOrEqual(SPLITTER_MIN_HIT_PX);

    // ── D6-5 第 3 分句「悬停必须有可见高亮」（§2.6-6 原文 ⇒ §2.9-5 规则转移到**分隔条**）──
    //  契约推导（**非**按实现倒推）：默认态 `bg-transparent` ⇒ 计算 `background-color` **全透明（alpha == 0）**；
    //  悬停 ⇒ 计算样式**必须变化**且**非全透明（alpha > 0）**；指针移出 ⇒ 回落默认态。
    //  可鉴别性：三条同时断言 ⇒ 「悬停无规则产出（旧写法 `hover:bg-acc1/40`）」时**必红**
    //  （实测变异证据见 `tester/evidence/20260924_d9_spec_gap/REPORT.md` §3）。
    //  载体：两条分隔条同源（`splitterProps`）⇒ 两条都断言（避免「一条绿掩一条红」）。
    expect(
      alphaOf(g.splitterKI!.bg),
      `D6-5 转移：默认态必须**全透明**（否则「悬停发生变化」不具鉴别力；实读 ${g.splitterKI!.bg}）`,
    ).toBe(0);
    const hoverReadings: Record<string, Awaited<ReturnType<typeof splitterHoverReading>>> = {};
    for (const id of SPLITTER_IDS) {
      const h = await splitterHoverReading(page, id);
      hoverReadings[id] = h;
      expect(h.alphaBefore, `D6-5 转移：${id} 默认态 alpha 必须 == 0（实读 ${h.before}）`).toBe(0);
      expect(h.after, `D6-5 转移：${id} 悬停前后 background-color **必须变化**（默认 ${h.before}）`).not.toBe(h.before);
      expect(h.alphaAfter, `D6-5 转移：${id} 悬停必须**非全透明**（实读 ${h.after}）`).toBeGreaterThan(0);
      expect(h.restored, `D6-5 转移：${id} 指针移出后必须回落默认态（实读 ${h.restored}）`).toBe(h.before);
    }
    writeJson('d6_t1_splitter_hover', { defaultFromProbe: g.splitterKI!.bg, readings: hoverReadings });

    // ── D9-8① 恒等式（±2px；真身 pane 读数 + DOM 实测） ──
    const viewPx = g.view.kline!.h;
    const cardH = g.card.rect!.h;
    const innerH = g.klineInner!.h;
    expect(
      Math.abs(cardH - (viewPx - KLINE_VIEW_CHROME_PX)),
      `D9-8① 卡高 == K 线视图高 − 60（卡高 ${cardH} / 视图高 ${viewPx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(innerH - (cardH - KLINE_CARD_BORDER_HEADER_PX)),
      `D9-8① 内层 == 卡高 − 22（内层 ${innerH} / 卡高 ${cardH}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    // 可观测口径一致性：卡片上报的视图高 == 外层 section 实测高
    expect(
      Math.abs(Number(g.attrs.cardViewHeight) - viewPx),
      `D9-12 观测性：data-kline-view-height == K 线视图实测高（${g.attrs.cardViewHeight} vs ${viewPx}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(g.candleH, 'D9-8① 主图（candle pane）高必须可读（真身 getSize）').not.toBeNull();
    const subCount = g.subPaneIds.length;
    expect(
      Math.abs(g.candleH! - (innerH - X_AXIS_PX - PANE_SEPARATOR_PX * subCount - (g.subTotal ?? 0))),
      `D9-8① 主图 == 内层 − 26 − 1×副图数 − Σ副图（主图 ${g.candleH} / 内层 ${innerH} / Σ副图 ${g.subTotal}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    // 观测性交叉校验（页面侧 data-pane-metrics 与真身读数同源）
    const pm = g.paneMetrics as { candlePx: number | null; subPaneTotalPx: number | null } | null;
    if (pm?.candlePx != null) {
      expect(Math.abs(pm.candlePx - g.candleH!), 'D9-12：data-pane-metrics 与真身读数必须一致').toBeLessThanOrEqual(TOL_PX);
    }

    // ── D9-8② 硬不变量（任意记忆值/副图数/视口恒成立） ──
    expect(g.candleH!, `D9-8② 主图 ≥ ${MAIN_MIN_PX}（硬下限）`).toBeGreaterThanOrEqual(MAIN_MIN_PX);
    for (const id of g.subPaneIds) {
      expect(g.paneSizes[id] ?? 0, `D9-8② 每个副图 ≥ ${SUB_PANE_MIN_PX}（${id}）`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
    }
    expect(g.subTotal ?? 0, `D9-8② 默认 regime 副图合计 ≤ ${SUB_PANE_TOTAL_MAX_PX}`).toBeLessThanOrEqual(
      SUB_PANE_TOTAL_MAX_PX,
    );
    // 卡头 ≤48（D6-3 保留项）
    expect(g.headerH, 'D6-3 保留：卡头高必须可读').not.toBeNull();
    expect(g.headerH!, `D6-3 保留：卡头 ≤ ${HEADER_MAX_PX}px（实读 ${g.headerH}）`).toBeLessThanOrEqual(HEADER_MAX_PX);

    // ── D9-8③ 分档（本档 900 ⇒ 可用 768 < 可行性阈值 ⇒ 走「不可行支」） ──
    const avail = Number(g.attrs.available);
    expect(avail, `D9-7：可用高 = 视口 − 132（${g.viewportH} ⇒ ${g.viewportH - VIEW_AVAILABLE_CHROME_PX}）`).toBe(
      g.viewportH - VIEW_AVAILABLE_CHROME_PX,
    );
    expect(Number(g.attrs.ratioKline), 'D9-7：默认三段比例 K 线 0.55').toBeCloseTo(DEFAULT_RATIOS.kline, 2);
    expect(Number(g.attrs.ratioIndicators)).toBeCloseTo(DEFAULT_RATIOS.indicators, 2);
    expect(Number(g.attrs.ratioDetail)).toBeCloseTo(DEFAULT_RATIOS.detail, 2);
    // D9-6④ 守恒：三段之和 == 可用高（±2）
    expect(
      Math.abs(g.view.kline!.h + g.view.indicators!.h + g.view.detail!.h - avail),
      `D9-6④ 守恒：三段之和 == 可用高（实读 ${g.view.kline!.h + g.view.indicators!.h + g.view.detail!.h} vs ${avail}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    if (avail >= AVAILABLE_FEASIBLE_PX) {
      // 几何可行支：主图 ≥320
      expect(g.candleH!, `D9-8③ 几何可行支（可用 ${avail} ≥ ${AVAILABLE_FEASIBLE_PX}）⇒ 主图 ≥ ${MAIN_PREFERRED_MIN_PX}`).toBeGreaterThanOrEqual(
        MAIN_PREFERRED_MIN_PX,
      );
    } else {
      // 不可行支：K 线视图**优先吃满**（夹取生效时 == 可用 − 指标下限 − 明细下限）∧ 显式披露
      expect(g.view.kline!.h, `D9-7：K 线视图 ≥ 可读下限 ${VIEW_MIN.klineOneSub}`).toBeGreaterThanOrEqual(
        VIEW_MIN.klineOneSub,
      );
      if (g.attrs.clamped === 'true') {
        expect(
          Math.abs(g.view.kline!.h - (avail - VIEW_MIN.indicators - VIEW_MIN.detail)),
          `D9-8③ 不可行支：夹取生效时 K 线视图 == 可用 − 指标下限 − 明细下限（实读 ${g.view.kline!.h}）`,
        ).toBeLessThanOrEqual(TOL_PX);
        expect(g.disclosure, 'D9-8③ 夹取必须**显式披露**（禁静默）').toBeTruthy();
      } else {
        expect(g.disclosure ?? '', 'D9-8③ 未夹取时不得有披露（禁误报）').toBe('');
      }
    }
  });

  test.describe('D9-6 可调性（重锚自 D6-6；1280×1400 富余档，位移有余量）', () => {
    test.use({ viewport: { width: 1280, height: 1400 } });

    test('上拖 N ⇒ K 线视图/卡高/内层同步 +N（1:1）；下拖 ⇒ −N；越界停指标可读下限；双击复位默认比例', async ({
      page,
    }) => {
      await page.addInitScript(installChartCapture);
      await openRun(page);
      const base = await probe(page);
      expect(base.attrs.clamped, '前置：1400 档默认比例不触发夹取（否则位移被下限吞掉）').toBe('false');
      expect(Number(base.attrs.available), '前置：可用高 = 视口 − 132').toBe(1400 - VIEW_AVAILABLE_CHROME_PX);

      // ── 上拖 120（1:1）──
      await dragSplitter(page, -120);
      const up = await probe(page);
      const dView = up.view.kline!.h - base.view.kline!.h;
      const dCard = up.card.rect!.h - base.card.rect!.h;
      const dInner = up.klineInner!.h - base.klineInner!.h;
      const dIndicator = up.view.indicators!.h - base.view.indicators!.h;
      writeJson('d6_t2_drag_up120', { base, up, dView, dCard, dInner, dIndicator });
      expect(
        dView,
        `D9-6⑤ 上拖 120 ⇒ K 线视图变高 ≈+120（实读 ${dView}；**错方向实现此处为 −120**）`,
      ).toBeGreaterThanOrEqual(120 - TOL_PX);
      expect(Math.abs(dView - 120), `D9-6⑤ 位移 1:1（实读 ${dView}）`).toBeLessThanOrEqual(TOL_PX);
      expect(Math.abs(dCard - dView), `D9-5/D9-8① 卡高必须随视图 1:1（视图 ${dView} / 卡 ${dCard}）`).toBeLessThanOrEqual(
        TOL_PX,
      );
      expect(Math.abs(dInner - dView), `D9-8① 内层必须随视图 1:1（视图 ${dView} / 内层 ${dInner}）`).toBeLessThanOrEqual(
        TOL_PX,
      );
      expect(Math.abs(dIndicator + 120), `D9-6① 指标反向补偿 1:1（实读 ${dIndicator}）`).toBeLessThanOrEqual(TOL_PX);
      expect(up.view.detail!.h, 'D9-6① 另一条边界不受影响（明细不动）').toBe(base.view.detail!.h);
      expect(
        Math.abs(up.view.kline!.h + up.view.indicators!.h + up.view.detail!.h - Number(up.attrs.available)),
        'D9-6④ 守恒：三段之和 == 可用高（±2px）',
      ).toBeLessThanOrEqual(TOL_PX);
      expect(up.candleH!, `D9-8② 拖后主图仍 ≥ ${MAIN_MIN_PX}`).toBeGreaterThanOrEqual(MAIN_MIN_PX);
      // 恒等式在拖后仍成立（卡高随视图 ⇒ 主图随之变化）
      expect(
        Math.abs(up.card.rect!.h - (up.view.kline!.h - KLINE_VIEW_CHROME_PX)),
        'D9-8① 拖后恒等式仍成立',
      ).toBeLessThanOrEqual(TOL_PX);

      // ── 下拖 120 ⇒ 变矮（方向反证） ──
      const b2 = await probe(page);
      await dragSplitter(page, 120);
      const down = await probe(page);
      const dView2 = down.view.kline!.h - b2.view.kline!.h;
      writeJson('d6_t2_drag_down120', { b2, down, dView2 });
      expect(dView2, `D9-6⑤ 下拖 ⇒ 上方视图变矮（实读 ${dView2}）`).toBeLessThanOrEqual(-(120 - TOL_PX));
      expect(Number(down.attrs.ratioKline), 'D9-6⑤ 比例必须随之下调').toBeLessThan(Number(b2.attrs.ratioKline));

      // ── 双击分隔条 ⇒ 复位默认比例（D9-6⑥） ──
      await page.getByTestId('wb-splitter-kline-indicators').dblclick();
      await page.waitForTimeout(250);
      const reset = await probe(page);
      writeJson('d6_t2_dblclick_reset', { reset, base });
      expect(Number(reset.attrs.ratioKline), `D9-6⑥ 双击 ⇒ 复位默认比例 ${DEFAULT_RATIOS.kline}`).toBeCloseTo(
        DEFAULT_RATIOS.kline,
        2,
      );
      expect(
        Math.abs(reset.view.kline!.h - base.view.kline!.h),
        '复位后 K 线视图高与初始读数一致（±2px）',
      ).toBeLessThanOrEqual(TOL_PX);

      // ── 上拖 N=40（小位移 1:1 复核）──
      const b3 = await probe(page);
      await dragSplitter(page, -40);
      const a3 = await probe(page);
      expect(Math.abs(a3.view.kline!.h - b3.view.kline!.h - 40), '上拖 40 ⇒ +40（1:1）').toBeLessThanOrEqual(TOL_PX);
      await page.getByTestId('wb-splitter-kline-indicators').dblclick();
      await page.waitForTimeout(200);

      // ── 上拖 240（越界）⇒ 位移在**指标视图可读下限 180** 处停止，差额回吐 K 线 ──
      const b4 = await probe(page);
      const avail = Number(b4.attrs.available);
      await dragSplitter(page, -240);
      const a4 = await probe(page);
      writeJson('d6_t2_drag_up240_clip', { b4, a4, avail });
      expect(a4.view.indicators!.h, 'D9-7 越界上拖 ⇒ 指标视图停在可读下限 180').toBe(VIEW_MIN.indicators);
      expect(
        Math.abs(a4.view.kline!.h - (avail - VIEW_MIN.indicators - a4.view.detail!.h)),
        `D9-6/K线优先：越界后 K 线视图 == 可用 − 指标下限 − 明细（实读 ${a4.view.kline!.h}）`,
      ).toBeLessThanOrEqual(TOL_PX);
      expect(a4.view.kline!.h - b4.view.kline!.h, '即便越界，K 线仍必须变高（方向正确）').toBeGreaterThan(0);
      expect(a4.view.detail!.h, '明细不受该边界影响').toBe(b4.view.detail!.h);
      expect(a4.candleH!, `D9-8② 越界后主图仍 ≥ ${MAIN_MIN_PX}`).toBeGreaterThanOrEqual(MAIN_MIN_PX);
      await page.getByTestId('wb-splitter-kline-indicators').dblclick();
      await page.waitForTimeout(200);

      // ── 持久化：刷新后比例保持（D9-11 新键） ──
      await dragSplitter(page, -160);
      const kept = await probe(page);
      const keptRatio = Number(kept.attrs.ratioKline);
      await page.reload();
      await reselect(page);
      const afterReload = await probe(page);
      writeJson('d6_t2_after_reload', { keptRatio, keptView: kept.view.kline!.h, afterReload });
      expect(Number(afterReload.attrs.ratioKline), 'D9-11 刷新后比例保持（新键）').toBeCloseTo(keptRatio, 2);
      expect(
        Math.abs(afterReload.view.kline!.h - kept.view.kline!.h),
        `D9-11 刷新后 K 线视图高保持（期望 ${kept.view.kline!.h}，实读 ${afterReload.view.kline!.h}）`,
      ).toBeLessThanOrEqual(TOL_PX);
      expect(
        JSON.parse(afterReload.storage[LAYOUT_V2_KEY] ?? '{}'),
        `D9-11 比例必须落在 ${LAYOUT_V2_KEY}`,
      ).toMatchObject({ ratios: { kline: expect.any(Number), indicators: expect.any(Number), detail: expect.any(Number) } });
    });
  });

  test('D9-7/D9-8②（重锚自 D6-4）：越界下拖 ⇒ K 线视图停可读下限 299；引擎 pane 分隔条越界 ⇒ 卡高不变 ∧ 主图 ≥160', async ({
    page,
  }) => {
    await page.addInitScript(installChartCapture);
    await openRun(page);

    // ① 视图分隔条路径（取代已删除的「卡片拖到有效下限」）：向下越界 ⇒ K 线视图停可读下限
    const p0 = await probe(page);
    const subCount = p0.subPaneIds.length;
    const klineMin = subCount >= 2 ? VIEW_MIN.klineTwoSub : VIEW_MIN.klineOneSub;
    await dragSplitter(page, 4000);
    const clamped = await probe(page);
    writeJson('d6_t3_view_splitter_clamp', { p0, subCount, klineMin, clamped });
    expect(
      clamped.view.kline!.h,
      `D9-7 越界下拖必须停在 K 线视图可读下限 ${klineMin}（实读 ${clamped.view.kline!.h}）`,
    ).toBe(klineMin);
    expect(clamped.view.indicators!.h, `D9-7 指标视图 ≥ 可读下限 ${VIEW_MIN.indicators}`).toBeGreaterThanOrEqual(
      VIEW_MIN.indicators,
    );
    expect(
      Math.abs(clamped.view.kline!.h + clamped.view.indicators!.h + clamped.view.detail!.h - Number(clamped.attrs.available)),
      'D9-6④ 夹取后守恒仍成立',
    ).toBeLessThanOrEqual(TOL_PX);
    expect(clamped.candleH!, `D9-8② 夹取后主图硬下限 ≥ ${MAIN_MIN_PX}（实读 ${clamped.candleH}）`).toBeGreaterThanOrEqual(
      MAIN_MIN_PX,
    );
    for (const id of clamped.subPaneIds) {
      expect(clamped.paneSizes[id] ?? 0, `D9-8② 夹取后副图 ≥ ${SUB_PANE_MIN_PX}（${id}）`).toBeGreaterThanOrEqual(
        SUB_PANE_MIN_PX,
      );
    }

    // ② 引擎 pane 分隔条路径（D6-4 的**保留**项，约束对象改为 K 线视图高）：越界上拖 ⇒ 主图 clamp 到硬下限，
    //    但**不改变卡高**（只在固定视图高内重分配主图/副图）。
    await page.getByTestId('wb-splitter-kline-indicators').dblclick();
    await page.waitForTimeout(300);
    const sep = await page.evaluate(findPaneSeparator);
    expect(sep, '引擎 pane 分隔条必须存在（cursor=ns-resize 的窄条）').not.toBeNull();
    const beforeSep = await probe(page);
    const cardHBefore = beforeSep.card.rect!.h;
    await page.mouse.move(sep!.x, sep!.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(sep!.x, Math.max(4, sep!.y - (300 * i) / 8));
    await page.mouse.move(sep!.x, 4);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const afterSep = await probe(page);
    writeJson('d6_t3_engine_separator_clamp', { sep, beforeSep, afterSep });
    expect(
      afterSep.card.rect!.h,
      `D6-4 保留：引擎分隔条不得改变卡高（${cardHBefore} → ${afterSep.card.rect!.h}；§2.6-7：只在固定视图高内重分配）`,
    ).toBe(cardHBefore);
    expect(
      afterSep.candleH!,
      `D6-4 保留：引擎分隔条越界 ⇒ clamp 到主图硬下限（实读 ${afterSep.candleH}）`,
    ).toBeGreaterThanOrEqual(MAIN_MIN_PX);
    for (const id of afterSep.subPaneIds) {
      expect(afterSep.paneSizes[id] ?? 0, `D9-8② 引擎分隔条越界后副图仍 ≥ ${SUB_PANE_MIN_PX}（${id}）`).toBeGreaterThanOrEqual(
        SUB_PANE_MIN_PX,
      );
    }
  });

  test('D9-11（重锚自 D6-7）：比例写结果页 v2 独立键；旧卡高键与看板键逐字节不变', async ({ page }) => {
    await page.addInitScript(installChartCapture);
    await openRun(page);

    // 预置旧 key（模拟历史记忆：旧卡高 333 + 旧结果页配置）与看板 key（哨兵）
    await page.evaluate(
      ([legacy, cardKey, dash]) => {
        localStorage.setItem(
          legacy!,
          JSON.stringify({
            indicators: { ma: true, vol: true, macd: false, kdj: false, boll: false, dcap: false },
            cardHeights: { kline: 333, aggregate: null, slot: null, equity: null, position: null },
          }),
        );
        localStorage.setItem(cardKey!, JSON.stringify({ kline: 333 }));
        localStorage.setItem(dash!, JSON.stringify({ sentinel: 'dashboard' }));
      },
      [LEGACY_KEY, CARD_HEIGHT_KEY, DASHBOARD_KEY],
    );
    await page.reload();
    await reselect(page);

    const before = await probe(page);
    await dragSplitter(page, -140);
    const after = await probe(page);
    writeJson('d6_t4_storage_isolation', { before, after });

    // ① 新键（v2）必须真有该比例；旧键**逐字节不变**（只读迁移）
    const v2 = JSON.parse(after.storage[LAYOUT_V2_KEY] ?? '{}') as { ratios?: Record<string, number> };
    expect(v2.ratios, `D9-11 比例必须落在 ${LAYOUT_V2_KEY}`).toBeTruthy();
    expect(Number(after.attrs.ratioKline), 'D9-11 data-view-ratio-kline 必须与落盘一致').toBeCloseTo(v2.ratios!.kline!, 2);
    expect(
      after.storage[CARD_HEIGHT_KEY],
      `D9-11 旧卡高键 ${CARD_HEIGHT_KEY} 必须**逐字节不变**（只读迁移）`,
    ).toBe(JSON.stringify({ kline: 333 }));
    expect(after.storage[DASHBOARD_KEY], 'D9-11 看板 key 不得被结果页触碰').toBe(JSON.stringify({ sentinel: 'dashboard' }));
    const legacyObj = JSON.parse(after.storage[LEGACY_KEY] ?? '{}') as { cardHeights?: Record<string, unknown> };
    expect(legacyObj.cardHeights?.['kline'], 'D9-11 旧结果页 key 不得被改写（迁移为只读）').toBe(333);
    // ② 旧卡高 333 只作一次性只读迁移源 ⇒ K 线视图 ≥ 有效下限（D9-13 同一纪律）
    expect(
      before.view.kline!.h,
      `D9-13 记忆值恢复后必须按**实测有效下限**再夹取（≥ ${VIEW_MIN.klineOneSub}）`,
    ).toBeGreaterThanOrEqual(VIEW_MIN.klineOneSub);
    expect(before.candleH!, 'D9-8② 迁移后主图 ≥160').toBeGreaterThanOrEqual(MAIN_MIN_PX);
    // ③ 卡高机制残留（记忆语义）不得复活
    expect(after.legacyCardHeight.cardHandle, 'D9-5 旧卡高记忆不得复活卡下沿把手').toBe(false);
    expect(after.card.inlineHeight ?? '', 'D9-5 卡片不得持有 inline 卡高').toBe('');
  });

  test('D9-8③ 分档补证：720 档 K 线优先吃满 + 披露；1400 档 主图 ≥320', async ({ page }) => {
    await page.addInitScript(installChartCapture);

    // ① 720 档（可用 588 < 可行性阈值 ⇒ 默认比例触发夹取、K 线优先吃满、必须披露）
    await page.setViewportSize({ width: 1280, height: 720 });
    await openRun(page);
    const g720 = await probe(page);
    writeJson('d6_t5_w720', g720);
    const avail720 = Number(g720.attrs.available);
    expect(avail720).toBe(720 - VIEW_AVAILABLE_CHROME_PX);
    expect(g720.attrs.clamped, 'D9-8③ 720 档默认比例必须触发夹取标记').toBe('true');
    expect(g720.disclosure, 'D9-8③ 夹取必须显式披露').toBeTruthy();
    expect(
      Math.abs(g720.view.kline!.h - (avail720 - VIEW_MIN.indicators - VIEW_MIN.detail)),
      `D9-8③ 不可行支：K 线优先吃满 == 可用 − 指标下限 − 明细下限（实读 ${g720.view.kline!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(g720.candleH!, `D9-8② 720 档主图仍 ≥ ${MAIN_MIN_PX}`).toBeGreaterThanOrEqual(MAIN_MIN_PX);

    // ② 1400 档（可用 1268 ≥ 可行性阈值 ⇒ 断言主图 ≥320）
    await page.setViewportSize({ width: 1280, height: 1400 });
    await openRun(page);
    const g1400 = await probe(page);
    writeJson('d6_t5_w1400', g1400);
    const avail1400 = Number(g1400.attrs.available);
    expect(avail1400).toBe(1400 - VIEW_AVAILABLE_CHROME_PX);
    expect(avail1400, `前置：1400 档可用高必须 ≥ 可行性阈值 ${AVAILABLE_FEASIBLE_PX}`).toBeGreaterThanOrEqual(
      AVAILABLE_FEASIBLE_PX,
    );
    expect(g1400.attrs.clamped, '1400 档默认比例不得触发夹取').toBe('false');
    expect(
      g1400.candleH!,
      `D9-8③ 几何可行支 ⇒ 主图 ≥ ${MAIN_PREFERRED_MIN_PX}（实读 ${g1400.candleH}）`,
    ).toBeGreaterThanOrEqual(MAIN_PREFERRED_MIN_PX);
    // 恒等式在异档同样成立
    expect(
      Math.abs(g1400.card.rect!.h - (g1400.view.kline!.h - KLINE_VIEW_CHROME_PX)),
      'D9-8① 恒等式在 1400 档成立',
    ).toBeLessThanOrEqual(TOL_PX);
  });
});
