/**
 * ADR-028 §2.7（**D7｜明细独立视图 + 跳转不动明细**）真渲染判据
 * —— **2026-09-24 按 §2.9（D9）三视图契约重锚**（ADR-023 §6.2；按契约推导，禁按实现输出倒推）。
 *
 * ## 事实源
 * `design/01-architecture/adr/ADR-028-…§2.7 / §2.8 / §2.9 / §4 第 9·11·12 条 / §5`
 * + `design/17-trade-detail-layering/08-plan-three-view-split.md`（判据 D9-1..13、§4 边界）。
 *
 * ## 重锚推导（旧契约 → 新契约，逐条）
 * | 旧（D7 两视图） | 新（D9 三视图） | 依据 |
 * |---|---|---|
 * | D7-1「上栏 `wb-chart-pane` 与下栏 `wb-detail-pane` 均为 `overflow:auto` 的**独立滚动容器**」 | **上栏拆为两个视图**：`wb-kline-view`（K 线视图）**不滚**（无内部滚动）、`wb-indicator-view`（指标视图，承载四张曲线卡）与明细视图**各自** `overflow:auto` | §2.9-3（滚动语义 D9-4）+ §2.9-1 |
 * | D7-3「下栏默认 **40% 视口高**」 | 明细默认 = **0.16 × 可用高**（`可用 = 视口 − 132`） | §2.9-7（三段比例默认 0.55/0.29/0.16；实测取 0.16 替代草案 0.20——后者在 720/800 档不可行） |
 * | D7-3「折叠入口在 tab 条内」 | 收起**状态与恢复条上移到视图级**（`ResultView` 持有/渲染）：入口带 `data-collapse-view="detail"`、视图容器带 `data-view-collapse-entry="detail"`、恢复条 `wb-restore-detail`（旧 `wb-detail-expand` 已改名） | §2.9-2（D9-3：指标/明细各自可收起、恢复条常驻带名可点）+ §3 改动清单（`DetailPane`：收起入口统一到视图级） |
 * | D7-3「比例 clamp [0.15,0.85] + 上栏保底 200px」 | 夹取 = **三视图可读下限**（K 线 299/329、指标 180、明细 95） | §2.9-7 + §4-12① |
 * | D7-3 注释「先上限 clamp 再下限 clamp」 | **更正**：拖拽路径上**不存在**比例上下限；旧 `DETAIL_RATIO_MAX = 0.85` 在拖拽路径从未生效，极端位移之所以停住，旧实现是「上栏保底 200px」、D9 是**三视图可读下限**（实测：极端**下拖**停在明细下限 95——2026-09-24 二次纠错后方向基准：边界下移 ⇒ 下方明细变矮） | 派工第 3 条「顺带修正那条不准确注释」+ §2.9-7 |
 * | D7-4④「K 线回到可见」**分档**（强档=整卡可见 / 弱档=卡顶对齐 + 主图 ≥80%，阈值实测 1065） | **分档取消**：K 线视图**常驻且不滚**（D9-2/D9-4）⇒ K 线卡**恒**完整落在 K 线视图内；等价判据 = ①K 线视图在视口内 ②卡完整落在 K 线视图内（恒等式保证）③主图 ≥160（D9-8②）④写窗真身回执 ok。强档的「与下栏并立」改为 D9 口径：`K线视图 = 0.55×可用 ∧ 主图 ≥320 ∧ 明细 = 0.16×可用` 并立 | §2.9-2/3/4（K 线常驻 + 不滚）+ §2.9-6③（分档）+ §4-12⑦ |
 * | D7-4①②③ 跳转纪律：`scrollY` 不变 / 下栏 `scrollTop` 不变 / 目标行仍可见 | **保留并加强**：`scrollY` 不变 / 明细视图 `scrollTop` 不变 / **指标视图 `scrollTop` 也不变** / 目标行仍在明细视图内 / 三段视图分配逐值不变 | §2.9-10（D9-10，对齐 D7-4②）+ §4-12⑥（切视图/收起/展开不得改变另一侧滚动位置） |
 * | D7-4④ 弱档「卡顶与上栏视口顶对齐」前置 | **删除**（不可满足）：K 线视图无内部滚动 ⇒ 无法把锚点滚出可视区；前置改为「明细视图与指标视图的 `scrollTop` 均 > 0」使「不变」判据有鉴别力 | D9-4（K 线视图不滚）+ 禁止「用不可满足的前提制造假绿」 |
 * | D7-5 高亮仍生效（`data-highlight-active` + 3s 回常态） | **不变**（逐条保留） | §2.7 第 4 项（D4.1 高亮）未被 D9 触及 |
 * | 证据出口 `coder/evidence/_d9_rerun/d7` | 改为**规格相对的未跟踪目录** | AGENTS.md 2026-09-23 纪律 + 派工第 7 条 |
 *
 * ## 运行（沙箱预览，**不碰线上 web/dist**）
 *   cd web && npx vite build --outDir /tmp/<build> --emptyOutDir
 *   VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/<build> --strictPort --port <free>
 *   E2E_BASE_URL=http://127.0.0.1:<free> npx playwright test e2e/adr028-d7-detail-split.e2e.ts --retries=0 --workers=1
 * 原始读数落盘：`ADR028_D7_OUT`（默认 = **未跟踪**的 `tester/evidence/20260924_d9_spec_reanchor/raw/d7`）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 默认出口 = **规格相对**的未跟踪目录（**禁止**指向他批已跟踪目录）。 */
const OUT =
  process.env.ADR028_D7_OUT ??
  resolve(process.env.E2E_EVIDENCE_DIR ?? resolve(REPO, 'tester/evidence/20260924_d9_spec_reanchor/raw'), 'd7');
const RUN_ID = process.env.ADR028_D7_RUN ?? 'sr_1789832517800_000006';

// ── 契约常量（D9；本规格自持，不 import 产品模块）──
const TOL_PX = 2;
const VIEW_AVAILABLE_CHROME_PX = 132;
const VIEW_MIN = { kline: 299, indicators: 180, detail: 95 } as const;
const DEFAULT_RATIOS = { kline: 0.55, indicators: 0.29, detail: 0.16 } as const;
const KLINE_VIEW_CHROME_PX = 60;
const MAIN_MIN_PX = 160;
const SUB_PANE_MIN_PX = 30;
/** 弱档视口（e2e 默认 device 级别；720 档为**不可行压缩支**）。 */
const WEAK_VIEWPORT = { width: 1280, height: 800 };
/** 富余档视口（几何可行支：可用 1268 ≥ 828 ⇒ 主图 ≥320 可断言）。 */
const RICH_VIEWPORT = { width: 1280, height: 1400 };

/** klinecharts 实例捕获（读真身 candle pane 高）。 */
function installChartCapture(): void {
  const w = window as unknown as { __wbCharts?: unknown[] };
  w.__wbCharts = [];
  const orig = Map.prototype.set;
  Map.prototype.set = function patched(key: unknown, value: unknown) {
    const o = value as { setBarSpace?: unknown; convertToPixel?: unknown } | null;
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

function writeJson(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

// ═══════════════════════ 页面侧探针（自包含；模块级常量必须内联） ═══════════════════════

function probeLayout() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
    };
  };
  const info = (el: HTMLElement | null) =>
    el == null
      ? null
      : {
          rect: rect(el),
          overflowY: getComputedStyle(el).overflowY,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
  const result = q('wb-result');
  const klineView = q('wb-kline-view');
  const indicatorView = q('wb-indicator-view');
  const detailPane = q('wb-detail-pane');
  const klineCard = q('wb-kline-chart');
  const klineInner = q('kline-chart');
  const spKI = q('wb-splitter-kline-indicators');
  const spID = q('wb-splitter-indicators-detail');
  let layoutStorage: string | null = null;
  try {
    layoutStorage = localStorage.getItem('eestock.result.layout.v2');
  } catch {
    /* ignore */
  }
  // 真身 pane 尺寸（主图高；D9-8② 硬不变量）
  interface ChartLike {
    getSize?: (paneId?: string, position?: string) => { height?: number } | null;
    getDataList?: () => unknown[];
  }
  const w = window as unknown as { __wbCharts?: ChartLike[] };
  const cands = (w.__wbCharts ?? []).filter((c) => {
    try {
      return (c.getDataList?.() ?? []).length > 0;
    } catch {
      return false;
    }
  });
  let candleH: number | null = null;
  try {
    candleH = cands[0]?.getSize?.('candle_pane', 'main')?.height ?? null;
  } catch {
    candleH = null;
  }
  const tabButtons = Array.from(document.querySelectorAll('[data-testid^="wb-tab-"]')).map((el) => ({
    testid: el.getAttribute('data-testid'),
    label: (el.textContent ?? '').trim(),
    selected: el.getAttribute('aria-selected') ?? '',
  }));
  const dataAttr = (id: string, attr: string) => q(id)?.getAttribute(attr) ?? null;
  return {
    viewportH: window.innerHeight,
    scrollY: window.scrollY,
    docScrollHeight: document.scrollingElement?.scrollHeight ?? null,
    docClientHeight: document.scrollingElement?.clientHeight ?? null,
    result: info(result),
    klineView: info(klineView),
    indicatorView: info(indicatorView),
    detailPane: info(detailPane),
    split: rect(q('wb-result-split')),
    splitterKI: spKI ? { rect: rect(spKI), role: spKI.getAttribute('role') } : null,
    splitterID: spID ? { rect: rect(spID), role: spID.getAttribute('role') } : null,
    klineCard: rect(klineCard),
    klineInner: rect(klineInner),
    candleH,
    /** D6-5 保留项：卡头实测高（跳转高亮提示常驻卡头 ⇒ 会由 20 涨到 38，须实测）。 */
    headerH: (() => {
      const h = klineCard?.querySelector('[data-testid="wb-kline-card-header"]');
      return h ? Math.round(h.getBoundingClientRect().height) : null;
    })(),
    /** D9-8① 真身 pane 读数（主图 / 副图 / Σ副图）。 */
    paneMetrics: (() => {
      try {
        const raw = klineInner?.getAttribute('data-pane-metrics');
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    })(),
    /** D9-2/D9-3：K 线视图内**不得**有收起入口；指标/明细各有；恢复条为视图级。 */
    collapse: {
      insideKlineView: klineView ? klineView.querySelectorAll('[data-collapse-view]').length : -1,
      detailEntry: !!q('wb-detail-collapse'),
      detailEntryMark: dataAttr('wb-detail-collapse', 'data-collapse-view'),
      detailPaneMark: dataAttr('wb-detail-pane', 'data-view-collapse-entry'),
      indicatorEntry: !!q('wb-indicator-collapse'),
      restoreDetail: !!q('wb-restore-detail'),
      restoreIndicator: !!q('wb-restore-indicators'),
      /** 恢复条是否被渲染在**明细容器内**（D9-3：恢复条由视图级渲染 ⇒ 收起后容器不存在 ⇒ false）。 */
      restoreInDetailPane: (() => {
        const r = q('wb-restore-detail');
        if (!r) return null;
        const d = q('wb-detail-pane');
        return d ? d.contains(r) : false;
      })(),
    },
    collapsed: {
      indicators: dataAttr('wb-result', 'data-view-collapsed-indicators'),
      detail: dataAttr('wb-result', 'data-view-collapsed-detail'),
    },
    ratios: {
      kline: Number(dataAttr('wb-result', 'data-view-ratio-kline')),
      indicators: Number(dataAttr('wb-result', 'data-view-ratio-indicators')),
      detail: Number(dataAttr('wb-result', 'data-view-ratio-detail')),
    },
    viewHeights: {
      kline: Number(dataAttr('wb-result', 'data-view-height-kline')),
      indicators: Number(dataAttr('wb-result', 'data-view-height-indicators')),
      detail: Number(dataAttr('wb-result', 'data-view-height-detail')),
    },
    available: Number(dataAttr('wb-result', 'data-view-available')),
    focusScrollRev: dataAttr('wb-kline-view', 'data-focus-scroll'),
    windowProbeOk: dataAttr('wb-window-probe', 'data-ok'),
    layoutStorage,
    tabButtons,
    blocks: {
      roundTrips: (() => {
        const el = q('wb-round-trips-table');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inKline: klineView?.contains(el) ?? false } : null;
      })(),
      perBar: (() => {
        const el = q('wb-perbar-table');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inKline: klineView?.contains(el) ?? false } : null;
      })(),
      eventLog: (() => {
        const el = q('wb-event-log');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inKline: klineView?.contains(el) ?? false } : null;
      })(),
      metrics: (() => {
        const el = q('wb-metrics-table');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inKline: klineView?.contains(el) ?? false } : null;
      })(),
      audit: (() => {
        const el = q('wb-audit-summary');
        return el ? { inDetail: detailPane?.contains(el) ?? false, inKline: klineView?.contains(el) ?? false } : null;
      })(),
    },
    highlight: {
      note: (() => {
        const el = q('wb-jump-highlight-note');
        return el ? { state: el.getAttribute('data-state'), text: (el.textContent ?? '').trim() } : null;
      })(),
      chartAttr: q('kline-chart')?.getAttribute('data-highlight-active') ?? null,
    },
  };
}

/** 目标元素相对**指定滚动容器**是否在其视口内（含 1px 容差）。 */
function scopedVisibility(arg: { rowTestId: string; paneTestId: string }) {
  const row = document.querySelector(`[data-testid="${arg.rowTestId}"]`) as HTMLElement | null;
  const pane = document.querySelector(`[data-testid="${arg.paneTestId}"]`) as HTMLElement | null;
  if (!row || !pane) return { found: !!row, pane: !!pane, visible: false, rowTop: null, paneTop: null, paneBottom: null };
  const r = row.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  return {
    found: true,
    pane: true,
    visible: r.top >= p.top - 1 && r.bottom <= p.bottom + 1,
    rowTop: Math.round(r.top),
    rowBottom: Math.round(r.bottom),
    paneTop: Math.round(p.top),
    paneBottom: Math.round(p.bottom),
  };
}

// ═══════════════════════ 驱动 ═══════════════════════

async function openRun(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.addInitScript(installChartCapture);
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-detail-pane')).toBeVisible();
  await expect(page.getByTestId('wb-kline-view')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    return !!el && el.getBoundingClientRect().height > 40;
  });
  await page.waitForTimeout(2500);
}

async function reselect(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.getByTestId(`wb-run-select-${runId}`).click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await page.waitForTimeout(1800);
}

/**
 * 拖**指标↔明细**分隔条：`dy < 0` = 鼠标**向上** ⇒ 边界上移。
 * **方向语义（§2.8 二次纠错）：上移 ⇒ 下方视图（明细）变高、上方视图（指标）变矮。**
 * 指针终点**夹在视口内**。
 */
async function dragSplitter(page: Page, dy: number, steps = 8): Promise<void> {
  const box = await page.getByTestId('wb-splitter-indicators-detail').boundingBox();
  expect(box, '分隔条必须可命中').not.toBeNull();
  const vp = page.viewportSize() ?? WEAK_VIEWPORT;
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** 展开 L2 并让目标行就位（跳转判据的前置条件）。 */
async function prepareL2(page: Page, rtSeq = 1): Promise<void> {
  await page.getByTestId(`wb-rt-detail-${rtSeq}`).click();
  await expect(page.getByTestId(`wb-l2-row-${rtSeq}-0`)).toBeVisible();
  await page.waitForTimeout(300);
}

/**
 * D7-4′ 公共判据（跳转纪律；L1/L2 各一次）。
 *
 * **前置（重锚）**：明细视图与**指标视图**都必须处于非零 `scrollTop`（「不变」判据的鉴别力来源）；
 * 旧前置「把 K 线锚点滚出上栏可视区」在 D9 下**不可满足**（K 线视图不滚，D9-4）⇒ 已删除。
 */
async function runJumpChecks(
  page: Page,
  args: { jumpTestId: string; rowTestId: string; tier: 'weak' | 'rich'; level: 'l1' | 'l2'; tag: string },
) {
  // 前置①：把目标行在**明细视图内**摆到容器中部（明细视图高仅 ≈95–203px ⇒ 用 center 才稳）
  await page.evaluate((rowId) => {
    const pane = document.querySelector('[data-testid="wb-detail-pane"]') as HTMLElement | null;
    const row = document.querySelector(`[data-testid="${rowId}"]`) as HTMLElement | null;
    if (!pane || !row) return;
    const pr = pane.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    // 相对容器中部的偏移；clamp 到 [0, maxScrollTop]（浏览器会在赋值时自动 clamp）
    pane.scrollTop = pane.scrollTop + (rr.top - pr.top) - Math.max(0, (pane.clientHeight - rr.height) / 2);
  }, args.rowTestId);
  // 前置②：把**指标视图**滚离顶端（使「指标 scrollTop 不变」有鉴别力）
  await page.evaluate(() => {
    const iv = document.querySelector('[data-testid="wb-indicator-view"]') as HTMLElement | null;
    if (iv) iv.scrollTop = 200;
  });
  await page.waitForTimeout(300);

  const jump = page.getByTestId(args.jumpTestId);
  await jump.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const before = await page.evaluate(probeLayout);
  expect(before.detailPane!.scrollTop, '前置①：明细视图必须已滚动（否则「不变」无鉴别力）').toBeGreaterThan(0);
  expect(before.indicatorView!.scrollTop, '前置②：指标视图必须已滚动（否则「不变」无鉴别力）').toBeGreaterThan(0);
  const rowBefore = await page.evaluate(scopedVisibility, { rowTestId: args.rowTestId, paneTestId: 'wb-detail-pane' });
  expect(rowBefore.visible, `前置③：${args.rowTestId} 必须原本就在明细视图视口内`).toBe(true);

  await jump.click();
  // 等落定：写窗真身回执 ok（ADR-028 §3.4）
  await expect
    .poll(async () => (await page.evaluate(probeLayout)).windowProbeOk, { timeout: 10000, intervals: [150] })
    .toBe('true');
  // **L2 才有逐笔高亮**（ADR-028 §5 实施期裁定 ④：L1 是区间跳转、无单笔目标 ⇒ 不设逐笔高亮）
  if (args.level === 'l2') {
    await expect
      .poll(async () => (await page.evaluate(probeLayout)).highlight.chartAttr, { timeout: 8000, intervals: [120] })
      .toBe('true');
  }
  await page.waitForTimeout(300);
  const after = await page.evaluate(probeLayout);
  const rowAfter = await page.evaluate(scopedVisibility, { rowTestId: args.rowTestId, paneTestId: 'wb-detail-pane' });
  writeJson(`d7_${args.tag}`, { tier: args.tier, before, after, rowBefore, rowAfter });

  // ── ①②③ D7-4′：跳转纪律 ──
  expect(after.scrollY, 'D7-4① 跳转后 window.scrollY 不变（页面级滚动已移除）').toBe(before.scrollY);
  expect(after.scrollY, 'D9-4 页面 scrollY 必须为 0').toBe(0);
  expect(after.detailPane!.scrollTop, 'D7-4② 跳转后明细视图 scrollTop 不变（B1-1 完全不动）').toBe(
    before.detailPane!.scrollTop,
  );
  expect(after.indicatorView!.scrollTop, 'D9-10 跳转后**指标视图** scrollTop 也不变（对齐 D7-4②）').toBe(
    before.indicatorView!.scrollTop,
  );
  expect(rowAfter.visible, 'D7-4③ 跳转后目标行仍在明细视图视口内').toBe(true);
  // ── ④ D7-4④（D9 重锚）：K 线「回到可见」= K 线视图在视口内 ∧ 卡完整落在 K 线视图内 ∧ 主图 ≥160 ──
  const kv = after.klineView!.rect!;
  expect(kv.y, `D9-4 K 线视图必须在视口内（实读 y=${kv.y}）`).toBeGreaterThanOrEqual(0);
  expect(kv.bottom, `D9-4 K 线视图底边必须在视口内（实读 bottom=${kv.bottom} / 视口 ${after.viewportH}）`).toBeLessThanOrEqual(
    after.viewportH,
  );
  const card = after.klineCard!;
  expect(card.y, 'D9-2/D9-4 K 线卡顶不得越出 K 线视图顶（K 线常驻可见）').toBeGreaterThanOrEqual(kv.y - TOL_PX);
  expect(card.bottom, 'D9-2/D9-4 K 线卡底不得越出 K 线视图底（K 线视图不滚 ⇒ 卡恒完整可见）').toBeLessThanOrEqual(
    kv.bottom + TOL_PX,
  );
  expect(
    Math.abs(card.h - (kv.h - KLINE_VIEW_CHROME_PX)),
    `D9-8① 卡高 == K 线视图高 − 60（实读 卡 ${card.h} / 视图 ${kv.h}）`,
  ).toBeLessThanOrEqual(TOL_PX);
  // D9-8② 硬不变量（**与 D9-8① 恒等式联立**）：容器的**可达上限** = `内层 − 26 − 1×n − 30×n`（副图已压到下限）。
  //  实测登记：跳转高亮提示**常驻卡头**（恒 20 → 38）⇒ 内层 −18 ⇒ 窄档（如 720）可达上限会 <160；
  //  判据取 `主图 ≥ min(160, 可达上限)`，并显式限定「让位量 ≤ 卡头超出量」（禁静默丢弃）。
  const pmJ = after.paneMetrics as
    | { candlePx: number | null; subPanes: Array<{ px: number | null }>; subPaneTotalPx: number | null }
    | null;
  const nSubJ = pmJ?.subPanes.length ?? 0;
  const innerJ = after.klineInner?.h ?? 0;
  const attainableJ = innerJ - 26 - 1 * nSubJ - SUB_PANE_MIN_PX * nSubJ;
  const shortfallJ = Math.max(0, MAIN_MIN_PX - (pmJ?.candlePx ?? 0));
  writeJson(`d7_${args.tag}_main_pane`, {
    candlePx: pmJ?.candlePx ?? null,
    innerH: innerJ,
    nSub: nSubJ,
    attainable: attainableJ,
    headerH: after.headerH,
    shortfall: shortfallJ,
  });
  expect(
    pmJ?.candlePx ?? 0,
    `D9-8② 跳转后主图 ≥ min(${MAIN_MIN_PX}, 可达上限 ${attainableJ})（实测 ${pmJ?.candlePx ?? 'n/a'}；卡头 ${after.headerH}）`,
  ).toBeGreaterThanOrEqual(Math.min(MAIN_MIN_PX, attainableJ) - 2);
  expect(
    shortfallJ,
    `D9-8② 主图让位量不得超过卡头超出量（卡头 ${after.headerH}；实读让位 ${shortfallJ}px）`,
  ).toBeLessThanOrEqual(Math.max(0, (after.headerH ?? 20) - 20));
  if (pmJ?.candlePx != null && pmJ.subPaneTotalPx != null) {
    for (const sp of pmJ.subPanes) {
      expect(sp.px ?? 0, `D9-8② 副图 ≥ ${SUB_PANE_MIN_PX}`).toBeGreaterThanOrEqual(SUB_PANE_MIN_PX);
    }
  }
  expect(after.windowProbeOk, 'ADR-028 §3.4 写窗真身回执必须 ok（跳转真的落到图上）').toBe('true');
  // ── ⑤ 跳转不得改变三段视图分配（D9-6④ 守恒 + 收起/展开纪律）──
  expect(after.viewHeights, 'D9-10 跳转不得改变三段视图高度分配').toEqual(before.viewHeights);
  expect(
    Math.abs(after.viewHeights.kline + after.viewHeights.indicators + after.viewHeights.detail - after.available),
    'D9-6④ 守恒：三段之和 == 可用高（±2px）',
  ).toBeLessThanOrEqual(TOL_PX);

  // ── 富余档：D9 口径的「强档」并立（K 线 = 0.55×可用 ∧ 主图 ≥320 ∧ 明细 = 0.16×可用）──
  if (args.tier === 'rich') {
    const avail = after.available;
    expect(avail, '前置：富余档可用高').toBe(RICH_VIEWPORT.height - VIEW_AVAILABLE_CHROME_PX);
    expect(
      Math.abs(after.viewHeights.kline - DEFAULT_RATIOS.kline * avail),
      `富余档：K 线视图 = 0.55×可用高（期望 ${(DEFAULT_RATIOS.kline * avail).toFixed(0)}，实读 ${after.viewHeights.kline}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(
      Math.abs(after.viewHeights.detail - DEFAULT_RATIOS.detail * avail),
      `富余档：明细视图 = 0.16×可用高（期望 ${(DEFAULT_RATIOS.detail * avail).toFixed(0)}，实读 ${after.viewHeights.detail}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(after.candleH ?? 0, 'D9-8③ 几何可行支：主图 ≥320').toBeGreaterThanOrEqual(320);
  }
  return { before, after };
}

// ═══════════════════════ 判据 ═══════════════════════

test.describe('D7-1′/D7-3′（1280×800）：滚动语义 / 明细默认比例 / 拖拽夹取 / 视图级收起与记忆', () => {
  test.use({ viewport: WEAK_VIEWPORT });

  test('三视图滚动语义（K 线不滚 + 指标/明细各自滚 + 整页不滚）；明细默认 0.16×可用；拖拽夹取；视图级收起 + 恢复条 + 记忆', async ({
    page,
  }) => {
    await openRun(page);
    const p0 = await page.evaluate(probeLayout);
    writeJson('d7_t1_default', p0);

    // ── D7-1′（D9-4）：滚动语义 ──
    expect(p0.klineView, 'K 线视图 wb-kline-view 必须存在（D9-1）').not.toBeNull();
    expect(p0.indicatorView, '指标视图 wb-indicator-view 必须存在（D9-1）').not.toBeNull();
    expect(p0.detailPane, '明细视图 wb-detail-pane 必须存在（D9-1）').not.toBeNull();
    expect(
      p0.klineView!.scrollHeight,
      `D9-4 K 线视图不得有内部滚动（scrollHeight ${p0.klineView!.scrollHeight} ≤ clientHeight ${p0.klineView!.clientHeight} + 1）`,
    ).toBeLessThanOrEqual(p0.klineView!.clientHeight + 1);
    expect(p0.klineView!.overflowY, 'D9-4 K 线视图不得是 overflow:auto 容器').not.toBe('auto');
    expect(p0.indicatorView!.overflowY, `D9-4 指标视图必须自身滚动（computed ${p0.indicatorView!.overflowY}）`).toBe('auto');
    expect(p0.detailPane!.overflowY, `D9-4 明细视图必须自身滚动（computed ${p0.detailPane!.overflowY}）`).toBe('auto');
    expect(
      p0.indicatorView!.scrollHeight,
      'D9-4 指标视图内容必须高于容器（四张曲线卡 ⇒ 否则「各自滚动」无从谈起）',
    ).toBeGreaterThan(p0.indicatorView!.clientHeight + 1);
    expect(p0.result!.overflowY, 'D7-1 页面级 wb-result 不得再是滚动容器').not.toBe('auto');
    expect(
      p0.docScrollHeight!,
      `D7-1 页面不得滚动（scrollHeight ${p0.docScrollHeight} ≤ innerHeight ${p0.viewportH}）`,
    ).toBeLessThanOrEqual(p0.viewportH + 1);
    expect(p0.scrollY, 'D7-1 页面 scrollY = 0').toBe(0);
    // 互不影响（D9-4）：滚指标 ⇒ 明细 scrollTop 不变
    await page.getByTestId('wb-indicator-view').hover();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    const s1 = await page.evaluate(probeLayout);
    expect(s1.indicatorView!.scrollTop, '指标视图必须真的滚了（否则判据无鉴别力）').toBeGreaterThan(0);
    expect(s1.detailPane!.scrollTop, 'D9-4 指标滚动不得影响明细').toBe(0);
    writeJson('d7_t1_scroll_isolated', s1);

    // ── D7-3′（D9-7）：明细默认 = 0.16 × 可用高（可用 = 视口 − 132），不再是 40% 视口高 ──
    const avail = p0.available;
    expect(avail, `D9-7 可用高 = 视口 − ${VIEW_AVAILABLE_CHROME_PX}`).toBe(p0.viewportH - VIEW_AVAILABLE_CHROME_PX);
    const expectedDetail = Math.round(DEFAULT_RATIOS.detail * avail);
    expect(
      p0.detailPane!.rect!.h,
      `D9-7 明细默认 = 0.16×可用高（期望 ${expectedDetail}±${TOL_PX}，实读 ${p0.detailPane!.rect!.h}）`,
    ).toBeGreaterThanOrEqual(expectedDetail - TOL_PX);
    expect(p0.detailPane!.rect!.h).toBeLessThanOrEqual(expectedDetail + TOL_PX);
    expect(
      Math.abs(p0.viewHeights.kline + p0.viewHeights.indicators + p0.viewHeights.detail - avail),
      'D9-6④ 守恒',
    ).toBeLessThanOrEqual(TOL_PX);
    expect(p0.splitterID!.role, 'D7-3 分隔条必须可拖拽（role=separator）').toBe('separator');
    expect(p0.splitterKI!.role, 'D9-1 另一条分隔条也必须存在').toBe('separator');

    // ── 拖拽（方向语义见 `adr028-d8-splitter-direction.e2e.ts`；此处验证「夹取 + 无关视图不动」）──
    // **800 档几何事实（契约推导 + 实测）**：`可用 = 668`，默认三段 367/194/107；
    // 「指标↔明细」边界两侧余量合计仅 `(194−180) + (107−95) = 26px` ⇒ 大幅拖拽**必然**立即触及可读下限。
    // 故本档只断言「夹取落在可读下限」与「第三视图不动」；1:1 位移量纲判据在富余档（1400）测。
    // **注释更正（派工第 3 条）**：拖拽路径上**没有比例上下限**——旧实现 `DETAIL_RATIO_MAX = 0.85`
    // 在拖拽路径从未生效（旧注释「先上限 clamp 再下限 clamp」不成立）；旧实际边界是「上栏保底 200px」，
    // D9 后由**三视图可读下限**（K 线 299 / 指标 180 / 明细 95）决定。
    // **下拖 4000**（§2.8：边界下移 ⇒ 下方明细变矮）⇒ 明细停在可读下限 95
    await dragSplitter(page, 4000);
    const lowClamp = await page.evaluate(probeLayout);
    writeJson('d7_t1_low_clamp', { before: p0, lowClamp });
    expect(
      lowClamp.viewHeights.detail,
      `D9-7 极端下拖 ⇒ 明细停在**可读下限 ${VIEW_MIN.detail}**（实读 ${lowClamp.viewHeights.detail}）`,
    ).toBe(VIEW_MIN.detail);
    expect(lowClamp.viewHeights.indicators, `D9-7 指标视图 ≥ ${VIEW_MIN.indicators}`).toBeGreaterThanOrEqual(
      VIEW_MIN.indicators,
    );
    expect(lowClamp.viewHeights.kline, 'D9-7 K 线视图不受该边界影响').toBe(p0.viewHeights.kline);
    expect(
      Math.abs(Number(lowClamp.ratios.detail) - VIEW_MIN.detail / lowClamp.available),
      'D9-12 夹取后比例与实际像素一致',
    ).toBeLessThanOrEqual(0.02);
    // **上拖 4000**（§2.8：边界上移 ⇒ 上方指标变矮）⇒ 指标停在可读下限 180
    await dragSplitter(page, -4000);
    const lowClamp2 = await page.evaluate(probeLayout);
    writeJson('d7_t1_low_clamp_down', lowClamp2);
    expect(
      lowClamp2.viewHeights.indicators,
      `D9-7 极端上拖 ⇒ 指标停在**可读下限 ${VIEW_MIN.indicators}**（实读 ${lowClamp2.viewHeights.indicators}）`,
    ).toBe(VIEW_MIN.indicators);
    expect(lowClamp2.viewHeights.detail, `D9-7 明细视图 ≥ ${VIEW_MIN.detail}`).toBeGreaterThanOrEqual(VIEW_MIN.detail);
    expect(lowClamp2.viewHeights.kline, 'D9-7 K 线视图仍不受该边界影响').toBe(p0.viewHeights.kline);
    expect(
      Math.abs(lowClamp2.viewHeights.kline + lowClamp2.viewHeights.indicators + lowClamp2.viewHeights.detail - avail),
      'D9-6④ 夹取后守恒仍成立',
    ).toBeLessThanOrEqual(TOL_PX);

    // ── D9-3（D7-3 收起入口重锚）：视图级收起 + 恢复条常驻带名可点 + 键盘可达 + 比例记忆 ──
    expect(p0.collapse.insideKlineView, 'D9-2 K 线视图内不得有 [data-collapse-view]（常驻不可收）').toBe(0);
    expect(p0.collapse.detailEntryMark, 'D9-3 明细收起入口必须标记**视图级**语义').toBe('detail');
    expect(p0.collapse.detailPaneMark, 'D9-3 明细视图容器必须标记视图级收起入口').toBe('detail');
    const ratioBeforeCollapse = Number(lowClamp2.ratios.detail);
    await page.getByTestId('wb-detail-collapse').click();
    await page.waitForTimeout(250);
    const collapsed = await page.evaluate(probeLayout);
    writeJson('d7_t1_collapsed', collapsed);
    expect(collapsed.collapsed.detail, 'D9-3 收起态必须可观测（data-view-collapsed-detail=true）').toBe('true');
    expect(collapsed.detailPane, 'D9-3 收起后明细视图不占位').toBeNull();
    expect(
      Math.abs(collapsed.viewHeights.kline + collapsed.viewHeights.indicators - collapsed.available),
      'D9-3 收起后其余两视图分享全部可用高（无孤立空隙）',
    ).toBeLessThanOrEqual(TOL_PX);
    expect(collapsed.viewHeights.kline, 'D9-3 收起后 K 线视图按原比例分享（变高）').toBeGreaterThan(lowClamp2.viewHeights.kline);
    const expand = page.getByTestId('wb-restore-detail');
    await expect(expand, 'D9-3 收起后必须保留**常驻可见**恢复条（视图级渲染，旧 wb-detail-expand 已改名）').toBeVisible();
    expect(collapsed.collapse.restoreInDetailPane, 'D9-3 恢复条不得渲染在明细容器内（容器已卸载）').toBe(false);
    expect((await expand.getAttribute('aria-label')) ?? '', 'D9-3 恢复条必须带视图名').toContain('明细');
    await expand.focus();
    await expect(expand, 'D9-3 恢复条必须键盘可达').toBeFocused();
    await expand.click();
    await page.waitForTimeout(250);
    const expanded = await page.evaluate(probeLayout);
    writeJson('d7_t1_restored', expanded);
    expect(Number(expanded.ratios.detail), 'D9-3 展开后比例记忆恢复').toBeCloseTo(ratioBeforeCollapse, 2);
    expect(expanded.viewHeights.detail, 'D9-3 展开后明细视图高逐 px 复原').toBe(lowClamp2.viewHeights.detail);

    // 刷新 ⇒ 比例保持（新键 v2）
    const keptRatio = Number(expanded.ratios.detail);
    await page.reload();
    await reselect(page);
    const afterReload = await page.evaluate(probeLayout);
    writeJson('d7_t1_after_reload', { keptRatio, afterReload });
    expect(Number(afterReload.ratios.detail), 'D9-11 刷新后比例保持').toBeCloseTo(keptRatio, 2);
    expect(afterReload.layoutStorage, `D9-11 比例必须落在 eestock.result.layout.v2`).toBeTruthy();
  });

  test('D7-2′：四块都在**明细视图**内；默认 tab = 回合与逐笔；切 tab 不改三段视图状态', async ({ page }) => {
    await openRun(page);
    const p0 = await page.evaluate(probeLayout);
    writeJson('d7_t2_blocks', p0);

    expect(p0.tabButtons.length, 'wb-detail-tabs 必须有多枚 tab').toBeGreaterThanOrEqual(4);
    const selected = p0.tabButtons.filter((t) => t.selected === 'true');
    expect(selected.length, 'D7-2 默认恰一个 tab 选中').toBe(1);
    expect(selected[0]!.testid, 'D7-2 默认 tab = 回合与逐笔（wb-tab-trades）').toBe('wb-tab-trades');

    expect(p0.blocks.roundTrips, 'D7-2 L1 回合表必须存在').not.toBeNull();
    expect(p0.blocks.roundTrips!.inDetail, 'D7-2 L1 回合表必须在**明细视图**内').toBe(true);
    expect(p0.blocks.roundTrips!.inKline, 'D7-2 L1 回合表不得在 K 线视图内').toBe(false);
    expect(p0.blocks.audit?.inDetail, 'D7-2 审计摘要必须在明细视图内').toBe(true);

    const upperBefore = { card: p0.klineCard, heights: p0.viewHeights };
    for (const key of ['perbar', 'events', 'metrics'] as const) {
      await page.getByTestId(`wb-tab-${key}`).click();
      await page.waitForTimeout(400);
      const p = await page.evaluate(probeLayout);
      if (key === 'perbar') {
        expect(p.blocks.perBar, 'D7-2 逐 bar 明细必须存在').not.toBeNull();
        expect(p.blocks.perBar!.inDetail, 'D7-2 逐 bar 明细必须在**明细视图**内').toBe(true);
        expect(p.blocks.perBar!.inKline, 'D7-2 逐 bar 明细不得在 K 线视图内').toBe(false);
      }
      if (key === 'events') {
        expect(p.blocks.eventLog, 'D7-2 事件日志必须存在').not.toBeNull();
        expect(p.blocks.eventLog!.inDetail, 'D7-2 事件日志必须在**明细视图**内').toBe(true);
        expect(p.blocks.eventLog!.inKline, 'D7-2 事件日志不得在 K 线视图内').toBe(false);
      }
      if (key === 'metrics') {
        expect(p.blocks.metrics, '既有 8 项绩效不得丢失（禁静默有损）').not.toBeNull();
        expect(p.blocks.metrics!.inDetail, '8 项绩效必须在**明细视图**内').toBe(true);
      }
      expect(p.klineCard!.h, 'D7-2 切 tab 不得改变 K 线卡高').toBe(upperBefore.card!.h);
      expect(p.viewHeights, 'D7-2 切 tab 不得改变三段视图高度分配').toEqual(upperBefore.heights);
    }

    await page.getByTestId('wb-tab-trades').click();
    await page.waitForTimeout(400);
    const back = await page.evaluate(probeLayout);
    expect(back.blocks.roundTrips!.inDetail, 'D7-2 回到默认 tab 后 L1 仍在明细视图内').toBe(true);

    await prepareL2(page);
    const l2InDetail = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="wb-l2-row-1-0"]');
      const pane = document.querySelector('[data-testid="wb-detail-pane"]');
      return !!row && !!pane && pane.contains(row);
    });
    expect(l2InDetail, 'D7-2 L2 逐笔明细必须在**明细视图**内').toBe(true);
  });

  test('D7-4′/D7-5′（1280×800）：L1/L2 跳转不动明细与指标视图；K 线常驻可见；高亮仍生效且 3s 回常态', async ({
    page,
  }) => {
    await openRun(page);
    await prepareL2(page);

    const l2 = await runJumpChecks(page, {
      jumpTestId: 'wb-l2-jump-1-0',
      rowTestId: 'wb-l2-row-1-0',
      tier: 'weak',
      level: 'l2',
      tag: 't3_l2_jump',
    });
    // D7-5 高亮仍生效（不得因三视图拆分丢失）
    expect(l2.after.highlight.note?.state, 'D7-5 高亮状态必须 ok').toBe('ok');
    expect(l2.after.highlight.chartAttr, 'D7-5 K 线实例必须处于高亮激活态').toBe('true');

    await runJumpChecks(page, {
      jumpTestId: 'wb-rt-jump-1',
      rowTestId: 'wb-rt-row-1',
      tier: 'weak',
      level: 'l1',
      tag: 't3_l1_jump',
    });

    // D7-5 高亮 3s 回常态
    await expect
      .poll(async () => (await page.evaluate(probeLayout)).highlight.chartAttr, { timeout: 6000, intervals: [500] })
      .toBe('false');
  });
});

test.describe('D7-4′（1280×1400 富余档）：跳转纪律 + D9 口径的「强档并立」', () => {
  test.use({ viewport: RICH_VIEWPORT });

  test('富余档：K 线 = 0.55×可用 ∧ 主图 ≥320 ∧ 明细 = 0.16×可用 并立；L2/L1 跳转纪律同弱档', async ({ page }) => {
    await openRun(page);
    const p0 = await page.evaluate(probeLayout);
    writeJson('d7_t4_default_rich', p0);
    const avail = p0.available;
    expect(avail, `富余档可用高 = 视口 − ${VIEW_AVAILABLE_CHROME_PX}`).toBe(RICH_VIEWPORT.height - VIEW_AVAILABLE_CHROME_PX);
    expect(
      Math.abs(p0.viewHeights.kline - DEFAULT_RATIOS.kline * avail),
      `强档并立①：K 线视图 = 0.55×可用高（实读 ${p0.viewHeights.kline}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(
      Math.abs(p0.viewHeights.detail - DEFAULT_RATIOS.detail * avail),
      `强档并立②：明细视图 = 0.16×可用高（实读 ${p0.viewHeights.detail}）`,
    ).toBeLessThanOrEqual(TOL_PX + 1);
    expect(p0.candleH ?? 0, '强档并立③：D9-8③ 几何可行支 ⇒ 主图 ≥320').toBeGreaterThanOrEqual(320);
    expect(p0.klineCard!.bottom, '强档并立④：K 线卡完整落在 K 线视图内').toBeLessThanOrEqual(p0.klineView!.rect!.bottom + TOL_PX);

    // ── 富余档补：指标↔明细 的 1:1 位移量纲与两个方向的夹取（800 档余量仅 26px，无法测量纲） ──
    const b1 = await page.evaluate(probeLayout);
    await dragSplitter(page, -60);
    const a1 = await page.evaluate(probeLayout);
    writeJson('d7_t4_drag_up60', { b1, a1 });
    expect(
      Math.abs(a1.viewHeights.detail - b1.viewHeights.detail - 60),
      `D8 上拖 60 ⇒ 明细（下方视图）**变高** 60（1:1；实读 Δ${a1.viewHeights.detail - b1.viewHeights.detail}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(a1.viewHeights.indicators - b1.viewHeights.indicators + 60)).toBeLessThanOrEqual(TOL_PX);
    expect(a1.viewHeights.kline, '另一条边界不受影响').toBe(b1.viewHeights.kline);
    await page.getByTestId('wb-splitter-indicators-detail').dblclick();
    await page.waitForTimeout(250);
    const b2 = await page.evaluate(probeLayout);
    await dragSplitter(page, 60);
    const a2 = await page.evaluate(probeLayout);
    writeJson('d7_t4_drag_down60', { b2, a2 });
    expect(
      Math.abs(a2.viewHeights.detail - b2.viewHeights.detail + 60),
      `D8 下拖 60 ⇒ 明细（下方视图）**变矮** 60（1:1；实读 Δ${a2.viewHeights.detail - b2.viewHeights.detail}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(a2.viewHeights.indicators - b2.viewHeights.indicators - 60)).toBeLessThanOrEqual(TOL_PX);
    await page.getByTestId('wb-splitter-indicators-detail').dblclick();
    await page.waitForTimeout(250);

    await prepareL2(page);
    await runJumpChecks(page, {
      jumpTestId: 'wb-l2-jump-1-0',
      rowTestId: 'wb-l2-row-1-0',
      tier: 'rich',
      level: 'l2',
      tag: 't4_l2_jump_rich',
    });
    await runJumpChecks(page, {
      jumpTestId: 'wb-rt-jump-1',
      rowTestId: 'wb-rt-row-1',
      tier: 'rich',
      level: 'l1',
      tag: 't4_l1_jump_rich',
    });
  });
});
