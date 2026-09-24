/**
 * ADR-028 §2.7 第 3 项（**方向语义**，2026-09-24 补齐）—— 分隔条 / 卡片把手**拖拽方向**的真渲染判据（D8）。
 *
 * ## 为什么单独一条规格
 * 用户实测缺陷：拖「明细视图（下栏）高度」时分隔条**方向反了**——鼠标**向上**反而让下栏**变矮**。
 * 原实现 `useResultLayout.ts` 的 `mousemove` 写的是 `detailPx = startDetail + Δy`（符号反），
 * 且**同一条错方向被既有规格固化**（`adr028-d7-detail-split.e2e.ts` 旧断言「拖 +90 ⇒ 下栏变高」，
 * 而 `dy > 0` = 向下）。**契约缺口**：ADR §2.7-3 原文只写「可拖拽」，**从未写方向语义** ⇒ 实现与规格各自认定一个方向。
 *
 * ## 契约（唯一事实源 = `ADR-028 §2.7` 第 3 项，2026-09-24 补齐；本规格按契约推导，**不按实现倒推**）
 *  - 分隔条位于下栏**上沿** ⇒ **鼠标向上（Δy < 0）⇒ 下栏变高 / 上栏变矮**：`detailPx = startDetail − Δy`；
 *  - **鼠标向下（Δy > 0）⇒ 下栏变矮**；位移 **1:1**（受比例 [0.15,0.85] 与「上栏保底 200px」约束）；
 *  - **卡片把手方向相反**（把手在卡片**下沿** ⇒ `cardPx = startH + Δy`：**向下拖 ⇒ 卡片变高**）——
 *    两者符号不同是几何决定的，**禁止互相套用** ⇒ 本规格在同一文件内同时断言两者（防「修 A 破 B」）；
 *  - 双击分隔条 ⇒ 比例复位 **40%**。
 *
 * 运行（沙箱预览，**不碰线上 web/dist**）：
 *   cd web && E2E_BASE_URL=http://127.0.0.1:4177 timeout 900 \
 *     npx playwright test e2e/adr028-d8-splitter-direction.e2e.ts --reporter=list --retries=0 --workers=1
 * 原始读数落盘：`ADR028_D8_OUT`（默认 `coder/evidence/20260924_splitter_direction/raw/d8`，**未跟踪目录**）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = process.env.ADR028_D8_OUT ?? resolve(REPO, 'coder/evidence/20260924_splitter_direction/raw/d8');
const RUN_ID = process.env.ADR028_D8_RUN ?? 'sr_1789832517800_000006';

// 契约常量（本规格自持，**不 import 产品模块** ⇒ 避免「按实现倒推」）
const DEFAULT_DETAIL_RATIO = 0.4;
const DETAIL_RATIO_MIN = 0.15;
const DETAIL_RATIO_MAX = 0.85;
const TOL_PX = 2;
const TOL_RATIO = 0.02;
const DEFAULT_KLINE_CARD_PX = 520;
/** 用户实测缺陷的视口（弱档：下栏 40% = 320px，够 ±120 双向不触界）。 */
const WEAK_VIEWPORT = { width: 1280, height: 800 };
/** 卡片把手判据的视口（卡 520 + 拖 80 ⇒ 600 ≤ max=视口高−200）。 */
const CARD_VIEWPORT = { width: 1280, height: 900 };

function writeJson(name: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 1));
}

// ═══════════════════════ 页面侧探针（自包含；模块级常量必须内联） ═══════════════════════

function probeGeom() {
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const result = q('wb-result');
  return {
    viewportH: window.innerHeight,
    detail: rect(q('wb-detail-pane')),
    chart: rect(q('wb-chart-pane')),
    split: rect(q('wb-result-split')),
    splitter: rect(q('wb-pane-splitter')),
    splitterCursor: q('wb-pane-splitter') ? getComputedStyle(q('wb-pane-splitter') as Element).cursor : null,
    splitterRole: q('wb-pane-splitter')?.getAttribute('role') ?? null,
    ratio: result?.getAttribute('data-pane-ratio') ?? null,
    collapsed: result?.getAttribute('data-pane-collapsed') ?? null,
    card: rect(q('wb-kline-chart')),
    klineInner: rect(q('kline-chart')),
    cardHandle: rect(q('wb-card-resize-kline')),
    layoutStorage: (() => {
      try {
        return localStorage.getItem('eestock.result.layout.v1');
      } catch {
        return null;
      }
    })(),
    cardHeightStorage: (() => {
      try {
        return localStorage.getItem('eestock.result.cardHeights.v1');
      } catch {
        return null;
      }
    })(),
  };
}

const probe = (page: Page): Promise<ReturnType<typeof probeGeom>> =>
  page.evaluate(probeGeom) as unknown as Promise<ReturnType<typeof probeGeom>>;

// ═══════════════════════ 驱动 ═══════════════════════

async function openRun(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-detail-pane')).toBeVisible();
  await expect(page.getByTestId('wb-pane-splitter')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    return !!el && el.getBoundingClientRect().height > 40;
  });
  await page.waitForTimeout(2500);
}

/**
 * 拖分隔条：`dy < 0` = 鼠标**向上**，`dy > 0` = 鼠标**向下**（与 `useResultLayout` 的 Δy 同号）。
 * 指针终点**夹在视口内**（越出视口的合成鼠标事件不可靠 ⇒ 会静默「什么都没发生」）。
 */
async function dragSplitterBy(page: Page, dy: number): Promise<void> {
  const box = await page.getByTestId('wb-pane-splitter').boundingBox();
  expect(box, '分隔条必须可命中').not.toBeNull();
  const vp = page.viewportSize() ?? WEAK_VIEWPORT;
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / 6);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** 拖卡片把手：`dy > 0` = 鼠标**向下**（把手在卡片下沿 ⇒ 契约：向下 = 卡片变高）。 */
async function dragCardHandleBy(page: Page, dy: number): Promise<void> {
  const handle = page.getByTestId('wb-card-resize-kline');
  const box = await handle.boundingBox();
  expect(box, '卡片把手必须可命中（boundingBox 非空）').not.toBeNull();
  const vp = page.viewportSize() ?? CARD_VIEWPORT;
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / 6);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** 双击分隔条 ⇒ 复位 40%（契约 §2.7-3）。 */
async function resetSplitRatio(page: Page): Promise<void> {
  await page.getByTestId('wb-pane-splitter').dblclick();
  await page.waitForTimeout(300);
}

/** 把手可达性前置（与 D6-5 同法）：收起下栏 ⇒ 上栏占满、整卡可见 ⇒ 卡片把手可命中。 */
async function collapseDetail(page: Page): Promise<void> {
  const btn = page.getByTestId('wb-detail-collapse');
  expect(await btn.count(), '折叠入口必须存在').toBeGreaterThan(0);
  await btn.click();
  await page.waitForTimeout(300);
}

async function expandDetail(page: Page): Promise<void> {
  const btn = page.getByTestId('wb-detail-expand');
  expect(await btn.count(), '展开入口必须存在').toBeGreaterThan(0);
  await btn.click();
  await page.waitForTimeout(300);
}

// ═══════════════════════ 判据 ═══════════════════════

test.describe('D8-1/D8-2/D8-4：分隔条方向语义（用户实测缺陷视口 1280×800）', () => {
  test.use({ viewport: WEAK_VIEWPORT });

  test('向上拖 ⇒ 下栏变高（+120±2、上栏 −120±2）；向下拖 ⇒ 下栏变矮；双击复位 40%', async ({ page }) => {
    await openRun(page);
    await resetSplitRatio(page);
    const base = await probe(page);
    writeJson('d8_t1_base', base);

    // 前置坐标契约：默认下栏 = 40% 视口高（否则「±2px」无从判定）
    expect(base.splitter?.w, '分隔条必须存在且可拖拽（role=separator）').toBeGreaterThan(100);
    expect(base.splitterRole).toBe('separator');
    expect(base.splitterCursor, '分隔条光标必须是 ns-resize').toBe('ns-resize');
    const expectDefault = Math.round(base.viewportH * DEFAULT_DETAIL_RATIO);
    expect(
      Math.abs((base.detail?.h ?? -1) - expectDefault),
      `前置：下栏默认 40% 视口高（期望 ${expectDefault}±${TOL_PX}，实读 ${base.detail?.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Number(base.ratio), '前置：data-pane-ratio ≈ 0.40').toBeCloseTo(DEFAULT_DETAIL_RATIO, 2);

    // ── D8-1：向上（Δy = −120）⇒ 下栏 **变高** 120、上栏 **变矮** 120 ──
    await dragSplitterBy(page, -120);
    const up = await probe(page);
    const dDetailUp = (up.detail?.h ?? 0) - (base.detail?.h ?? 0);
    const dChartUp = (up.chart?.h ?? 0) - (base.chart?.h ?? 0);
    writeJson('d8_t1_drag_up', { base, up, dDetailUp, dChartUp });
    expect(
      dDetailUp,
      `D8-1 上移 120 ⇒ 下栏变高 ≈+120（实读 Δ${dDetailUp}；**错方向实现此处为 −120**）`,
    ).toBeGreaterThanOrEqual(120 - TOL_PX);
    expect(Math.abs(dDetailUp - 120), `D8-1 位移 1:1（实读 Δ${dDetailUp}）`).toBeLessThanOrEqual(TOL_PX);
    expect(dChartUp, `D8-1 上栏相应变矮 ≈−120（实读 Δ${dChartUp}）`).toBeLessThanOrEqual(-120 + TOL_PX);
    expect(Number(up.ratio), 'D8-1 比例必须随之上调').toBeGreaterThan(Number(base.ratio));

    // ── D8-2①：自 440 向下拖 +240（大位移 1:1 复核）⇒ 下栏 440 → 200 ──
    // 说明：**不**在 440 之上再向上拖 180——`可用高 708 − 上栏保底 200 = 508` 会把上移位移夹住
    // （契约 §2.7-3：位移 1:1 **受** [0.15,0.85] 与上栏保底 200px 约束）⇒ 大位移放到**下方向**验（440→200，两侧远离夹取边界）。
    const down240Base = await probe(page);
    await dragSplitterBy(page, 240);
    const down240 = await probe(page);
    const dDetailDown240 = (down240.detail?.h ?? 0) - (down240Base.detail?.h ?? 0);
    const dChartDown240 = (down240.chart?.h ?? 0) - (down240Base.chart?.h ?? 0);
    writeJson('d8_t1_drag_down240', { down240Base, down240, dDetailDown240, dChartDown240 });
    expect(
      Math.abs(dDetailDown240 + 240),
      `D8-2① 下移 240 ⇒ 1:1（实读 Δ${dDetailDown240}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(dChartDown240 - 240), `D8-2① 上栏 1:1 反向（实读 Δ${dChartDown240}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Number(down240.ratio), 'D8-2① 比例必须随之下调').toBeLessThan(Number(down240Base.ratio));

    // ── D8-4：双击分隔条 ⇒ 复位 40%（前置：下栏确实已偏离默认）──
    await resetSplitRatio(page);
    const reset = await probe(page);
    writeJson('d8_t1_dblclick_reset', { down240, reset });
    expect(Number(reset.ratio), `D8-4 双击分隔条 ⇒ 比例回 40%（实读 ${reset.ratio}）`).toBeCloseTo(
      DEFAULT_DETAIL_RATIO,
      2,
    );
    expect(
      Math.abs((reset.detail?.h ?? -1) - Math.round(reset.viewportH * DEFAULT_DETAIL_RATIO)),
      `D8-4 双击后下栏高回 ${Math.round(reset.viewportH * DEFAULT_DETAIL_RATIO)}±${TOL_PX}（实读 ${reset.detail?.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);

    // ── D8-2②：自默认（40%）向下（Δy = +120）⇒ 下栏 **变矮** 120、上栏 **变高** 120 ──
    const downBase = await probe(page);
    await dragSplitterBy(page, 120);
    const down = await probe(page);
    const dDetailDown = (down.detail?.h ?? 0) - (downBase.detail?.h ?? 0);
    const dChartDown = (down.chart?.h ?? 0) - (downBase.chart?.h ?? 0);
    writeJson('d8_t1_drag_down', { downBase, down, dDetailDown, dChartDown });
    expect(
      dDetailDown,
      `D8-2② 下移 120 ⇒ 下栏变矮 ≈−120（实读 Δ${dDetailDown}；**错方向实现此处为 +120**）`,
    ).toBeLessThanOrEqual(-120 + TOL_PX);
    expect(Math.abs(dDetailDown + 120), `D8-2② 位移 1:1（实读 Δ${dDetailDown}）`).toBeLessThanOrEqual(TOL_PX);
    expect(dChartDown, `D8-2② 上栏相应变高 ≈+120（实读 Δ${dChartDown}）`).toBeGreaterThanOrEqual(120 - TOL_PX);
    expect(Number(down.ratio), 'D8-2② 比例必须随之下调').toBeLessThan(Number(downBase.ratio));

    // 夹取边界仍成立（不得把任一侧压到 0）
    expect(Number(down.ratio), `D8-2② 比例下限 ${DETAIL_RATIO_MIN}`).toBeGreaterThanOrEqual(DETAIL_RATIO_MIN);
    expect(Number(down.ratio)).toBeLessThanOrEqual(DETAIL_RATIO_MAX);

    // ── D8-1②：自 200 向上拖 −180 ⇒ +180（1:1 复核；380 远离两侧夹取边界）──
    const up180Base = await probe(page);
    await dragSplitterBy(page, -180);
    const up180 = await probe(page);
    const dDetail180 = (up180.detail?.h ?? 0) - (up180Base.detail?.h ?? 0);
    writeJson('d8_t1_drag_up180', { up180Base, up180, dDetail180 });
    expect(Math.abs(dDetail180 - 180), `D8-1② 上移 180 ⇒ 1:1（实读 Δ${dDetail180}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Number(up180.ratio), 'D8-1② 比例必须随之上调').toBeGreaterThan(Number(up180Base.ratio));

    // ── 边界：向上拖越界 ⇒ 位移被**上栏保底 200px** 夹住（不是把上栏压没）──
    await dragSplitterBy(page, -4000);
    const capped = await probe(page);
    const cap = Math.max(0, (capped.split?.h ?? 0) - 200);
    writeJson('d8_t1_upper_cap', { up180, capped, cap });
    expect(Math.abs((capped.detail?.h ?? -1) - cap), `越界上移必须停在上栏保底 200px（期望 ${cap}，实读 ${capped.detail?.h}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Number(capped.ratio), `比例上限 ${DETAIL_RATIO_MAX}`).toBeLessThanOrEqual(DETAIL_RATIO_MAX);
  });
});

test.describe('D8-3：卡片把手方向相反（下沿把手 ⇒ 向下拖 = 卡片变高），同规格防「修 A 破 B」', () => {
  test.use({ viewport: CARD_VIEWPORT });

  test('卡片把手向下 +80 ⇒ 卡片变高；向上 −80 ⇒ 变矮；同页分隔条向上 ⇒ 下栏变高（反向并存）', async ({ page }) => {
    await openRun(page);
    // 卡片把手可达性前置：收起下栏 ⇒ 上栏占满、整卡可见
    await collapseDetail(page);
    await page.getByTestId('wb-card-title-kline').dblclick();
    await page.waitForTimeout(300);
    const cardBase = await probe(page);
    writeJson('d8_t2_card_base', cardBase);
    expect(cardBase.card?.h, `前置：K 线卡默认 ${DEFAULT_KLINE_CARD_PX}px`).toBe(DEFAULT_KLINE_CARD_PX);
    expect(cardBase.collapsed, '前置：收起下栏后 data-pane-collapsed=true').toBe('true');

    // ── D8-3①：把手（卡片**下沿**）向下 +80 ⇒ 卡片 **变高**（契约 §2.7-3 反向语义）──
    await dragCardHandleBy(page, 80);
    const cardDown = await probe(page);
    const dCardDown = (cardDown.card?.h ?? 0) - (cardBase.card?.h ?? 0);
    const dInnerDown = (cardDown.klineInner?.h ?? 0) - (cardBase.klineInner?.h ?? 0);
    writeJson('d8_t2_card_down', { cardBase, cardDown, dCardDown, dInnerDown });
    expect(
      dCardDown,
      `D8-3 卡片把手向下 80 ⇒ 卡片变高 ≈+80（实读 Δ${dCardDown}；**若与分隔条套用同一符号此处为 −80**）`,
    ).toBeGreaterThanOrEqual(80 - TOL_PX);
    expect(Math.abs(dCardDown - 80), `D8-3 位移 1:1（实读 Δ${dCardDown}）`).toBeLessThanOrEqual(TOL_PX);
    expect(dInnerDown, `D8-3 klinecharts 容器高同步变化（实读 Δ${dInnerDown}）`).toBeGreaterThanOrEqual(80 - TOL_PX);
    expect(dCardDown, 'D8-3 与分隔条对照：同一手势方向（向下）在卡片上 = 变高').toBeGreaterThan(0);

    // ── D8-3②：反向复核：把手向上 −80 ⇒ 卡片回到默认 ──
    await dragCardHandleBy(page, -80);
    const cardUp = await probe(page);
    const dCardUp = (cardUp.card?.h ?? 0) - (cardDown.card?.h ?? 0);
    writeJson('d8_t2_card_up', { cardDown, cardUp, dCardUp });
    expect(dCardUp, `D8-3 把手向上 80 ⇒ 卡片变矮 ≈−80（实读 Δ${dCardUp}）`).toBeLessThanOrEqual(-80 + TOL_PX);
    expect(Math.abs(dCardUp + 80), `D8-3 位移 1:1（实读 Δ${dCardUp}）`).toBeLessThanOrEqual(TOL_PX);

    // ── 同页交叉：展开下栏后，分隔条**向上** ⇒ 下栏变高（与卡片把手的「向下=变高」相反，禁止互相套用）──
    await expandDetail(page);
    await resetSplitRatio(page);
    const splitBase = await probe(page);
    await dragSplitterBy(page, -120);
    const splitUp = await probe(page);
    const dDetailUp = (splitUp.detail?.h ?? 0) - (splitBase.detail?.h ?? 0);
    writeJson('d8_t2_splitter_after_card', { splitBase, splitUp, dDetailUp, cardUp });
    expect(
      dDetailUp,
      `D8-3 同页交叉：分隔条向上 ⇒ 下栏变高 ≈+120（实读 Δ${dDetailUp}）——与卡片把手方向**相反**`,
    ).toBeGreaterThanOrEqual(120 - TOL_PX);
    expect(Math.abs(dDetailUp - 120)).toBeLessThanOrEqual(TOL_PX);
  });
});
