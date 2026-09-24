/**
 * ADR-028 §2.8（**D8｜分隔条方向语义**）真渲染判据（D8-1..4）
 * —— **2026-09-24 按 §2.9（D9）三视图契约重锚**（ADR-023 §6.2；**按契约推导，禁按实现输出倒推**）。
 *
 * ## 事实源
 * `design/01-architecture/adr/ADR-028-…§2.7 第 3 项 / §2.8（D8）/ §2.9（D9）/ §4 第 11·12 条 / §5`
 * + `design/17-trade-detail-layering/08-plan-three-view-split.md`（判据 D9-1..13、§4 边界）。
 *
 * ## 重锚推导（旧契约 → 新契约，逐条）
 * | 旧（D7/D8 两视图） | 新（D9 三视图） | 依据 |
 * |---|---|---|
 * | 单一分隔条 `wb-pane-splitter`（**上栏下沿 = 下栏上沿**）：「上拖 ⇒ 下栏变高」 | 该物理位置 = **`wb-splitter-indicators-detail`**（明细视图上沿）⇒ 「上拖 ⇒ **上方视图（指标）变高**、明细变矮」；**并新增** `wb-splitter-kline-indicators`（K 线视图下沿）需同规则 | §2.9-1（两条分隔条）+ §2.9-8 + §4-12⑤ |
 * | 上方视图 = 单一「上栏 `wb-chart-pane`」 | 上方视图**按边界取**：K线↔指标 ⇒ 上方 = `wb-kline-view`；指标↔明细 ⇒ 上方 = `wb-indicator-view` | §2.9-1（结构硬约束） |
 *   （该映射在本规格内以 `VIEW_OF` + `VIEW_KEY` / `sidesOf()` 落地，并被「结构相邻」与「1:1 位移」判据**消费**）
 * | 比例观测 `data-pane-ratio` / 收起 `data-pane-collapsed` | `data-view-ratio-{kline,indicators,detail}` / `data-view-collapsed-{indicators,detail}` | §2.9-12（D9-12 观测性） |
 * | 夹取 = 「上栏保底 200px」+ 比例 [0.15,0.85] | 夹取 = **三视图可读下限**（K 线视图 299（1 副图）/329（2 副图）、指标 180、明细 95），**只对本边界的两个视图**生效，第三视图完全不动 | §2.9-7 + §4-12① |
 * | 卡片把手 = **K 线卡下沿把手**（`wb-card-resize-kline`）⇒ 下拖 = 变高 | **D9-5 删除 K 线卡把手** ⇒ 「两类把手符号相反」迁到**仍保留把手的四张曲线卡**（`wb-card-resize-{aggregate,slot,equity,position}`，D4.2 保留）；**方向语义本身不变**（把手下沿 ⇒ 下拖 = 变高），与分隔条（在上沿 ⇒ 上拖 = 上方视图变高）**符号相反** | §2.9-5（删卡片把手）+ §2.9-6（视图高度可调）+ §2.8（禁止互相套用） |
 * | 双击分隔条 ⇒ 复位 40% 视口高 | 双击分隔条 ⇒ 复位**该边界默认比例**（K线↔指标 ⇒ `kline/(kline+indicators)` = 0.55/0.84；指标↔明细 ⇒ 0.29/0.45） | §2.9-8 + D9-6⑥ |
 *
 * ## 为什么这条规格必须存在
 * 用户实测缺陷（2026-09-24）：拖「明细视图高度」时分隔条方向反了。**契约缺口**（原文只写「可拖拽」未写方向）
 * ⇒ 实现/规格/独立探针三方都认定同一个错方向。纪律（ADR-028 §5）：凡「交互量 → 几何量」的映射，
 * 必须把方向/符号/起点口径写进契约，并配「**方向反转即变红**」的判据。本规格每条方向判据的失败信息
 * 都直接点名「错方向实现此处为 ±N」。
 *
 * ## 运行（沙箱预览，**不碰线上 web/dist**；证据落**未跟踪**目录，AGENTS.md 2026-09-23 纪律）
 *   cd web && npx vite build --outDir /tmp/<build> --emptyOutDir
 *   VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/<build> --strictPort --port <free>
 *   E2E_BASE_URL=http://127.0.0.1:<free> npx playwright test e2e/adr028-d8-splitter-direction.e2e.ts --retries=0 --workers=1
 * 原始读数落盘：`ADR028_D8_OUT`（默认 = **未跟踪**的 `tester/evidence/20260924_d9_spec_reanchor/raw/d8`；
 * 亦可用 `E2E_EVIDENCE_DIR` 指定基目录）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/** 默认出口 = **规格相对**的未跟踪目录（**禁止**指向他批已跟踪目录）。 */
const OUT =
  process.env.ADR028_D8_OUT ??
  resolve(process.env.E2E_EVIDENCE_DIR ?? resolve(REPO, 'tester/evidence/20260924_d9_spec_reanchor/raw'), 'd8');
const RUN_ID = process.env.ADR028_D8_RUN ?? 'sr_1789832517800_000006';

// ── 契约常量（本规格自持，**不 import 产品模块** ⇒ 避免「按实现倒推」）──
const TOL_PX = 2;
const TOL_RATIO = 0.02;
/** D9-7 三视图可读下限（1 副图档）。 */
const VIEW_MIN = { kline: 299, indicators: 180, detail: 95 } as const;
/** D9-7 默认三段比例。 */
const DEFAULT_RATIOS = { kline: 0.55, indicators: 0.29, detail: 0.16 } as const;
/** D9-7 可用高口径：`可用 = 视口高 − 132`。 */
const VIEW_AVAILABLE_CHROME_PX = 132;
/** D9-5：K 线视图内固定 chrome（`卡高 = 视图高 − 60`）。 */
const KLINE_VIEW_CHROME_PX = 60;
/**
 * 方向判据的**富余档**视口：`可用 = 1668`（> 大位移 240 在两条边界上都留有余量）。
 * 推导：K线↔指标 上拖 240 需 `指标 = 484 − 240 = 244 ≥ 180` ✓；
 * 指标↔明细 上拖 120 需 `明细 = 267 − 120 = 147 ≥ 95` ✓（240 组会触明细下限 ⇒ 单独作夹取判据）。
 */
const RICH_VIEWPORT = { width: 1280, height: 1800 };
/** 卡片把手判据视口（曲线卡把手在指标视图内；900 档下聚合分卡把手首屏可见）。 */
const CARD_VIEWPORT = { width: 1280, height: 900 };

/** 四条曲线卡（D4.2 保留把手的对象）。 */
const CURVE_CARDS = ['aggregate', 'slot', 'equity', 'position'] as const;

type Boundary = 'ki' | 'id';
const SPLITTER_ID: Record<Boundary, string> = {
  ki: 'wb-splitter-kline-indicators',
  id: 'wb-splitter-indicators-detail',
};
/** 边界 → 上方/下方视图的 testid（D9-1 结构）。 */
const VIEW_OF: Record<Boundary, { upper: string; lower: string }> = {
  ki: { upper: 'wb-kline-view', lower: 'wb-indicator-view' },
  id: { upper: 'wb-indicator-view', lower: 'wb-detail-view' },
};

/**
 * `VIEW_OF` 的**唯一消费点**（2026-09-24 修复死代码：此前 `VIEW_OF` 仅定义、从未被引用）。
 * 用途 = 把「边界 → 上方/下方视图」的 testid 单一事实源，落到**实测几何的读取键**上，
 * 供「1:1 位移」「结构相邻」判据使用 ⇒ 若有人改动视图 testid 而忘了改规格，
 * `sidesOf()` 会**立即抛错**（而非静默量错视图、把绿读成绿）。
 */
const VIEW_KEY: Record<string, 'kline' | 'indicators' | 'detail'> = {
  'wb-kline-view': 'kline',
  'wb-indicator-view': 'indicators',
  'wb-detail-view': 'detail',
};

/** 由 `VIEW_OF` 派生该边界两侧的**实测高读取键** + testid（未注册 ⇒ 抛错，禁静默）。 */
function sidesOf(which: Boundary) {
  const { upper, lower } = VIEW_OF[which];
  const upperKey = VIEW_KEY[upper];
  const lowerKey = VIEW_KEY[lower];
  if (upperKey == null || lowerKey == null) {
    throw new Error(
      `VIEW_OF[${which}] 的 testid（${upper} / ${lower}）未在 VIEW_KEY 内注册 ⇒ 结构与规格已漂移（D9-1）`,
    );
  }
  return { upperKey, lowerKey, upperTestId: upper, lowerTestId: lower };
}

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
  const spKI = q('wb-splitter-kline-indicators');
  const spID = q('wb-splitter-indicators-detail');
  const card = q('wb-kline-chart');
  /** 曲线卡几何（D8-3「两类把手符号相反」的载体；D4.2 保留）。 */
  const curveCards: Record<string, { h: number; handleH: number | null } | null> = {};
  for (const id of ['aggregate', 'slot', 'equity', 'position']) {
    const el = q(`wb-${id}-chart`);
    const hd = q(`wb-card-resize-${id}`);
    curveCards[id] = el ? { h: Math.round(el.getBoundingClientRect().height), handleH: hd ? Math.round(hd.getBoundingClientRect().height) : null } : null;
  }
  // **「采集未断言」审计（2026-09-24，本批）**：`viewportH` 属**披露用读数**（随 `writeJson` 落盘供
  //  交叉校验）；本规格的前置判据用契约常量 `RICH_VIEWPORT` ⇒ 不对该字段断言（明确登记，非假覆盖）。
  return {
    viewportH: window.innerHeight,
    /** 三段视图（D9-1：K 线视图 / 指标视图 / 明细视图）。 */
    views: {
      kline: rect(q('wb-kline-view')),
      indicators: rect(q('wb-indicator-view')),
      detail: rect(q('wb-detail-view')),
      detailPane: rect(q('wb-detail-pane')),
      split: rect(q('wb-result-split')),
    },
    splitters: {
      ki: spKI
        ? { rect: rect(spKI), cursor: getComputedStyle(spKI).cursor, role: spKI.getAttribute('role') }
        : null,
      id: spID
        ? { rect: rect(spID), cursor: getComputedStyle(spID).cursor, role: spID.getAttribute('role') }
        : null,
    },
    /** D9-12 观测性：三段比例 + 高度（实际像素比与请求比例均可读）。 */
    ratios: {
      kline: Number(result?.getAttribute('data-view-ratio-kline')),
      indicators: Number(result?.getAttribute('data-view-ratio-indicators')),
      detail: Number(result?.getAttribute('data-view-ratio-detail')),
    },
    heights: {
      kline: Number(result?.getAttribute('data-view-height-kline')),
      indicators: Number(result?.getAttribute('data-view-height-indicators')),
      detail: Number(result?.getAttribute('data-view-height-detail')),
    },
    available: Number(result?.getAttribute('data-view-available')),
    collapsed: {
      indicators: result?.getAttribute('data-view-collapsed-indicators') ?? null,
      detail: result?.getAttribute('data-view-collapsed-detail') ?? null,
    },
    klineCard: {
      rect: rect(card),
      viewHeightAttr: card?.getAttribute('data-kline-view-height') ?? null,
      /** D9-5：K 线卡下沿把手必须**不存在**。 */
      cardHandlePresent: !!q('wb-card-resize-kline'),
    },
    curveCards,
    pageScroll: {
      scrollY: Math.round(window.scrollY),
      docScrollH: document.scrollingElement?.scrollHeight ?? -1,
      innerH: window.innerHeight,
    },
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
  await expect(page.getByTestId('wb-kline-view')).toBeVisible();
  await expect(page.getByTestId('wb-detail-view')).toBeVisible();
  await expect(page.getByTestId('wb-splitter-indicators-detail')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="kline-chart"]');
    return !!el && el.getBoundingClientRect().height > 40;
  });
  await page.waitForTimeout(2500);
}

async function reselect(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.getByTestId(`wb-run-select-${runId}`).click();
  await expect(page.getByTestId('wb-kline-view')).toBeVisible();
  await page.waitForTimeout(1800);
}

/**
 * 拖某条**视图分隔条**：`dy < 0` = 鼠标**向上**（契约 §2.8/§2.9-8：上移 ⇒ **上方**视图变高）。
 * 指针终点**夹在视口内**（越出视口的合成鼠标事件不可靠 ⇒ 会静默「什么都没发生」）。
 */
async function dragSplitterBy(page: Page, which: Boundary, dy: number, steps = 10): Promise<void> {
  const box = await page.getByTestId(SPLITTER_ID[which]).boundingBox();
  expect(box, `分隔条 ${SPLITTER_ID[which]} 必须可命中`).not.toBeNull();
  const vp = page.viewportSize() ?? RICH_VIEWPORT;
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/**
 * 双击分隔条 ⇒ **复位该边界**默认股比（§2.8 原文「双击分隔条 ⇒ 复位**该边界**默认比例」；§2.9-8 同）。
 * 语义要点：只重分配**该边界两侧**的两个视图，第三个视图**完全不动**（本规格对此有断言）。
 */
async function resetBoundary(page: Page, which: Boundary): Promise<void> {
  await page.getByTestId(SPLITTER_ID[which]).dblclick();
  await page.waitForTimeout(250);
}

/** 真·默认态（清 v2 比例键 + 刷新 + 重选 run）⇒ 用于每个「需要从默认态起算 1:1」的相位。 */
async function resetToDefault(page: Page): Promise<void> {
  await page.evaluate(() => {
    try {
      localStorage.removeItem('eestock.result.layout.v2');
    } catch {
      /* ignore */
    }
  });
  await page.reload();
  await reselect(page);
}

/**
 * 拖**曲线卡**把手：`dy > 0` = 鼠标**向下**（把手在卡片**下沿** ⇒ 契约 §2.7-3/§2.8：向下 = 卡片变高）。
 * D9-5 删除 K 线卡把手后，本规格用**仍保留把手的四张曲线卡**（D4.2）继续验证
 * 「两类把手符号相反」这一 D8 契约（**禁止互相套用**）。
 */
async function dragCurveHandleBy(page: Page, cardId: string, dy: number, steps = 10): Promise<void> {
  const handle = page.getByTestId(`wb-card-resize-${cardId}`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  expect(box, `曲线卡把手 wb-card-resize-${cardId} 必须可命中（boundingBox 非空）`).not.toBeNull();
  const vp = page.viewportSize() ?? CARD_VIEWPORT;
  const x = box!.x + box!.width / 2;
  const y0 = box!.y + box!.height / 2;
  const yEnd = Math.max(4, Math.min(vp.height - 4, y0 + dy));
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y0 + ((yEnd - y0) * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

// ═══════════════════════ 判据 ═══════════════════════

/**
 * 富余档几何事实（1280×1800，实测并落盘）：
 * `可用 = 1668`；默认三段 `917 / 484 / 267`；`wb-splitter-kline-indicators` 中心 y ≈ 1007、
 * `wb-splitter-indicators-detail` 中心 y ≈ 1511 —— **指针终点必须落在视口内**（合成鼠标事件出视口不可靠），
 * 故「向下大位移」判据一律先复位到默认（此时边界位于视口中部、下移余量 789 / 285px），
 * 避免把「指针被视口底边夹住」误读成「未位移」。
 */
test.describe('D8-1/D8-2/D8-4 方向语义：K线↔指标 边界（1280×1800 富余档）', () => {
  test.use({ viewport: RICH_VIEWPORT });

  test('上拖 N ⇒ 上方（K 线）视图变高 N、指标变矮 N（1:1）；下拖反向；越界停 K 线可读下限；双击复位', async ({
    page,
  }) => {
    await openRun(page);
    const base = await probe(page);
    writeJson('d8_t1_base', base);
    // 边界 → 上方/下方视图（`VIEW_OF` 的消费点；未注册 ⇒ 此处抛错）
    const { upperKey, lowerKey, upperTestId, lowerTestId } = sidesOf('ki');

    // 前置坐标契约：分隔条存在、role=separator、cursor=ns-resize；可用高口径 = 视口 − 132
    expect(base.splitters.ki, 'K线↔指标 分隔条必须存在（D9-1）').not.toBeNull();
    expect(base.splitters.ki!.role, '分隔条必须声明 role=separator').toBe('separator');
    expect(base.splitters.ki!.cursor, '分隔条光标必须是 ns-resize（纵向）').toBe('ns-resize');
    expect(base.splitters.ki!.rect!.w, '分隔条必须够长可拖（w>100）').toBeGreaterThan(100);
    expect(
      base.available,
      `前置：可用高 = 视口 − ${VIEW_AVAILABLE_CHROME_PX}（期望 ${RICH_VIEWPORT.height - VIEW_AVAILABLE_CHROME_PX}，实读 ${base.available}）`,
    ).toBe(RICH_VIEWPORT.height - VIEW_AVAILABLE_CHROME_PX);
    expect(base.ratios.kline, '前置：默认 K 线比例 0.55').toBeCloseTo(DEFAULT_RATIOS.kline, 2);
    expect(base.ratios.indicators, '前置：默认指标比例 0.29').toBeCloseTo(DEFAULT_RATIOS.indicators, 2);
    expect(base.ratios.detail, '前置：默认明细比例 0.16').toBeCloseTo(DEFAULT_RATIOS.detail, 2);
    const roomDown = RICH_VIEWPORT.height - 4 - (base.splitters.ki!.rect!.y + base.splitters.ki!.rect!.h / 2);
    expect(roomDown, '前置：K线↔指标 边界的下移余量必须 > 240（否则大位移判据会退化为常量）').toBeGreaterThan(240);
    // D9-5：K 线卡下沿把手必须不存在（「两类把手」的另一类已迁到曲线卡，见 D8-3）
    expect(base.klineCard.cardHandlePresent, 'D9-5：K 线卡下沿把手必须不存在').toBe(false);

    // 结构前置（ADR §2.8：「分隔条位于其**上方视图的下沿 / 下方视图的上沿**」）——
    // 由 VIEW_OF 派生的 testid 定位（禁硬编码），间隙取契约容差带 0–12px（实测 4px = split 的 gap-1）。
    const upperRect = base.views[upperKey];
    const lowerRect = base.views[lowerKey];
    expect(upperRect, `D9-1 结构：上方视图 ${upperTestId} 必须存在（VIEW_OF 派生）`).not.toBeNull();
    expect(lowerRect, `D9-1 结构：下方视图 ${lowerTestId} 必须存在（VIEW_OF 派生）`).not.toBeNull();
    const gapAbove = base.splitters.ki!.rect!.y - (upperRect!.y + upperRect!.h);
    const gapBelow = lowerRect!.y - (base.splitters.ki!.rect!.y + base.splitters.ki!.rect!.h);
    expect(gapAbove, `D8 结构前置：分隔条必须在上方视图 ${upperTestId} 之下（间隙 ${gapAbove}px，容差 0–12）`).toBeGreaterThanOrEqual(0);
    expect(gapAbove, `D8 结构前置：分隔条与上方视图 ${upperTestId} 之间不得有超过 12px 的空隙（实读 ${gapAbove}）`).toBeLessThanOrEqual(12);
    expect(gapBelow, `D8 结构前置：分隔条必须在下方视图 ${lowerTestId} 之上（间隙 ${gapBelow}px，容差 0–12）`).toBeGreaterThanOrEqual(0);
    expect(gapBelow, `D8 结构前置：分隔条与下方视图 ${lowerTestId} 之间不得有超过 12px 的空隙（实读 ${gapBelow}）`).toBeLessThanOrEqual(12);

    // ── D8-1（上拖 120）：上方视图 +120（1:1）、指标 −120、明细**完全不动** ──
    const b1 = await probe(page);
    await dragSplitterBy(page, 'ki', -120);
    const a1 = await probe(page);
    const dUpper = a1.views[upperKey]!.h - b1.views[upperKey]!.h;
    const dLower = a1.views[lowerKey]!.h - b1.views[lowerKey]!.h;
    writeJson('d8_t1_drag_up120', { b1, a1, dUpper, dLower });
    expect(
      dUpper,
      `D8-1 上移 120 ⇒ 上方视图（K 线）变高 ≈+120（实读 Δ${dUpper}；**错方向实现此处为 −120**）`,
    ).toBeGreaterThanOrEqual(120 - TOL_PX);
    expect(Math.abs(dUpper - 120), `D8-1 位移 1:1（实读 Δ${dUpper}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(dLower + 120), `D8-1 下方视图反向 1:1（实读 Δ${dLower}）`).toBeLessThanOrEqual(TOL_PX);
    // 第三个视图（**非本边界两侧**）⇒ 保持**显式点名**，不接受 VIEW_OF 派生
    expect(a1.views.detail!.h, 'D8-1 另一条边界不受影响（明细视图完全不动）').toBe(b1.views.detail!.h);
    expect(a1.ratios.kline, 'D8-1 比例必须随之上调').toBeGreaterThan(b1.ratios.kline);
    expect(
      Math.abs(a1.views[upperKey]!.h + a1.views[lowerKey]!.h + a1.views.detail!.h - a1.available),
      'D9-6④ 守恒：调整后三段之和 == 可用高（±2px）',
    ).toBeLessThanOrEqual(TOL_PX);
    expect(
      Math.abs(a1.klineCard.rect!.h - (a1.views[upperKey]!.h - KLINE_VIEW_CHROME_PX)),
      'D9-8① 卡高 == K 线视图高 − 60（拖后仍成立）',
    ).toBeLessThanOrEqual(TOL_PX);

    // ── N ∈ {40, 240} 复测（每组前回默认态） ──
    await resetToDefault(page);
    const b3 = await probe(page);
    await dragSplitterBy(page, 'ki', -40);
    const a3 = await probe(page);
    expect(Math.abs(a3.views[upperKey]!.h - b3.views[upperKey]!.h - 40), 'D8-1② 上移 40 ⇒ 1:1').toBeLessThanOrEqual(TOL_PX);
    await resetToDefault(page);
    const b4 = await probe(page);
    await dragSplitterBy(page, 'ki', -240);
    const a4 = await probe(page);
    writeJson('d8_t1_drag_up_40_240', { b3, a3, b4, a4 });
    expect(
      Math.abs(a4.views[upperKey]!.h - b4.views[upperKey]!.h - 240),
      `D8-1③ 上移 240 ⇒ 1:1（余量充裕档，实读 Δ${a4.views[upperKey]!.h - b4.views[upperKey]!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(a4.views[lowerKey]!.h - b4.views[lowerKey]!.h + 240)).toBeLessThanOrEqual(TOL_PX);
    expect(a4.views.detail!.h).toBe(b4.views.detail!.h);

    // ── D8-2（自默认 下拖 120）⇒ 上方视图变矮、指标变高（1:1） ──
    await resetToDefault(page);
    const b2 = await probe(page);
    await dragSplitterBy(page, 'ki', 120);
    const a2 = await probe(page);
    const dUpper2 = a2.views[upperKey]!.h - b2.views[upperKey]!.h;
    const dLower2 = a2.views[lowerKey]!.h - b2.views[lowerKey]!.h;
    writeJson('d8_t1_drag_down120', { b2, a2, dUpper2, dLower2 });
    expect(
      dUpper2,
      `D8-2 下移 120 ⇒ 上方视图变矮 ≈−120（实读 Δ${dUpper2}；**错方向实现此处为 +120**）`,
    ).toBeLessThanOrEqual(-120 + TOL_PX);
    expect(Math.abs(dUpper2 + 120), `D8-2 位移 1:1（实读 Δ${dUpper2}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(dLower2 - 120), `D8-2 下方视图反向 1:1（实读 Δ${dLower2}）`).toBeLessThanOrEqual(TOL_PX);
    expect(a2.ratios.kline, 'D8-2 比例必须随之下调').toBeLessThan(b2.ratios.kline);

    // ── 越界（自默认 下拖 4000；实测位移被视口底边夹住但足以越界）⇒ K 线视图停在**可读下限 299**（D9-7） ──
    await resetToDefault(page);
    const b5 = await probe(page);
    await dragSplitterBy(page, 'ki', 4000);
    const a5 = await probe(page);
    writeJson('d8_t1_lower_clamp', { b5, a5, roomDown });
    expect(
      a5.views[upperKey]!.h,
      `D9-7 越界下拖 ⇒ K 线视图停在可读下限 ${VIEW_MIN.kline}（实读 ${a5.views[upperKey]!.h}）`,
    ).toBe(VIEW_MIN.kline);
    expect(a5.views[lowerKey]!.h, `D9-7 指标视图不得低于可读下限 ${VIEW_MIN.indicators}`).toBeGreaterThanOrEqual(
      VIEW_MIN.indicators,
    );
    expect(a5.views.detail!.h, 'D9-7 另一条边界不受影响（明细不动）').toBe(b5.views.detail!.h);
    expect(
      Math.abs(a5.views[upperKey]!.h + a5.views[lowerKey]!.h + a5.views.detail!.h - a5.available),
      'D9-6④ 夹取后守恒仍成立',
    ).toBeLessThanOrEqual(TOL_PX);
    expect(a5.pageScroll.scrollY, 'D8：任何拖拽都不得带动页面滚动（D9-4 整页不滚）').toBe(0);

    // ── D8-4：双击 ⇒ 复位**该边界**默认股比（K线 : 指标 = 0.55 : 0.29）；第三个视图（明细）**完全不动** ──
    await resetBoundary(page, 'ki');
    const reset = await probe(page);
    const share = reset.views[upperKey]!.h / (reset.views[upperKey]!.h + reset.views[lowerKey]!.h);
    writeJson('d8_t1_dblclick_reset', { a5, reset, base, share });
    expect(
      share,
      `D8-4 双击 K线↔指标 ⇒ 该边界股比复位 ${(DEFAULT_RATIOS.kline / (DEFAULT_RATIOS.kline + DEFAULT_RATIOS.indicators)).toFixed(4)}（实读 ${share.toFixed(4)}）`,
    ).toBeCloseTo(DEFAULT_RATIOS.kline / (DEFAULT_RATIOS.kline + DEFAULT_RATIOS.indicators), 2);
    expect(reset.views.detail!.h, 'D8-4 双击 K线↔指标 不得改变第三个视图（明细视图）').toBe(a5.views.detail!.h);
    // 该边界两侧之和守恒
    expect(
      Math.abs(
        reset.views[upperKey]!.h + reset.views[lowerKey]!.h - (a5.views[upperKey]!.h + a5.views[lowerKey]!.h),
      ),
      'D8-4 复位只重分配该边界两侧（两侧之和守恒）',
    ).toBeLessThanOrEqual(TOL_PX);
    // 明细本就处于默认 ⇒ 三视图逐 px 回到默认态（对照组）
    expect(
      Math.abs(reset.views[upperKey]!.h - base.views[upperKey]!.h),
      `D8-4 复位后视图高回到默认（期望 ${base.views[upperKey]!.h}±${TOL_PX}，实读 ${reset.views[upperKey]!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(reset.ratios.kline, 'D8-4 复位后 K 线比例 = 默认 0.55（明细未偏离默认时）').toBeCloseTo(
      DEFAULT_RATIOS.kline,
      2,
    );
  });

  test('D9-12 观测性：请求比例与实际像素比都可读（避免 D7 口径混淆重演）', async ({ page }) => {
    await openRun(page);
    const b = await probe(page);
    await dragSplitterBy(page, 'ki', -300);
    const a = await probe(page);
    writeJson('d8_t1_ratio_observability', { b, a });
    for (const [k, v] of Object.entries(a.heights)) {
      expect(Number.isFinite(v), `D9-12 data-view-height-${k} 必须可读`).toBe(true);
      expect(v, `D9-12 data-view-height-${k} 必须为正`).toBeGreaterThan(0);
    }
    expect(Number.isFinite(a.ratios.kline) && Number.isFinite(a.ratios.detail), 'D9-12 三段比例必须可读').toBe(true);
    const actual = a.views.kline!.h / (a.views.kline!.h + a.views.indicators!.h + a.views.detail!.h);
    expect(
      Math.abs(actual - a.ratios.kline),
      `D9-12 实际像素比（${actual.toFixed(3)}）必须与请求比例（${a.ratios.kline}）一致（±${TOL_RATIO}）`,
    ).toBeLessThanOrEqual(TOL_RATIO);
  });
});

test.describe('D8-1/D8-2/D8-4 方向语义：指标↔明细 边界（1280×1800 富余档）', () => {
  test.use({ viewport: RICH_VIEWPORT });

  test('上拖 ⇒ 指标变高 / 明细变矮；下拖反向；越界停明细可读下限 95；双击复位', async ({ page }) => {
    await openRun(page);
    const base = await probe(page);
    const { upperKey, lowerKey, upperTestId, lowerTestId } = sidesOf('id');
    expect(base.splitters.id, '指标↔明细 分隔条必须存在（D9-1）').not.toBeNull();
    expect(base.splitters.id!.role).toBe('separator');
    expect(base.splitters.id!.cursor).toBe('ns-resize');
    const roomDown = RICH_VIEWPORT.height - 4 - (base.splitters.id!.rect!.y + base.splitters.id!.rect!.h / 2);
    expect(roomDown, '前置：指标↔明细 边界的下移余量必须 > 240（否则大位移判据会退化为常量）').toBeGreaterThan(240);

    // 结构前置（载体 = 指标↔明细 边界；testid 由 VIEW_OF 派生，禁硬编码）
    const upperRect = base.views[upperKey];
    const lowerRect = base.views[lowerKey];
    expect(upperRect, `D9-1 结构：上方视图 ${upperTestId} 必须存在（VIEW_OF 派生）`).not.toBeNull();
    expect(lowerRect, `D9-1 结构：下方视图 ${lowerTestId} 必须存在（VIEW_OF 派生）`).not.toBeNull();
    const gapAbove = base.splitters.id!.rect!.y - (upperRect!.y + upperRect!.h);
    const gapBelow = lowerRect!.y - (base.splitters.id!.rect!.y + base.splitters.id!.rect!.h);
    expect(gapAbove, `D8 结构前置：分隔条必须在 ${upperTestId} 之下（间隙 ${gapAbove}px，容差 0–12）`).toBeGreaterThanOrEqual(0);
    expect(gapAbove, `D8 结构前置：${upperTestId} 与分隔条之间不得有超过 12px 空隙（实读 ${gapAbove}）`).toBeLessThanOrEqual(12);
    expect(gapBelow, `D8 结构前置：分隔条必须在 ${lowerTestId} 之上（间隙 ${gapBelow}px，容差 0–12）`).toBeGreaterThanOrEqual(0);
    expect(gapBelow, `D8 结构前置：分隔条与 ${lowerTestId} 之间不得有超过 12px 空隙（实读 ${gapBelow}）`).toBeLessThanOrEqual(12);

    // ── 上拖 120 ⇒ 指标 +120（上方视图）、明细 −120；K 线**完全不动** ──
    const b1 = await probe(page);
    await dragSplitterBy(page, 'id', -120);
    const a1 = await probe(page);
    const dUpper = a1.views[upperKey]!.h - b1.views[upperKey]!.h;
    const dLower = a1.views[lowerKey]!.h - b1.views[lowerKey]!.h;
    writeJson('d8_t2_drag_up120', { b1, a1, dUpper, dLower });
    expect(
      dUpper,
      `D8-1 上移 120 ⇒ 上方视图（指标）变高 ≈+120（实读 Δ${dUpper}；**错方向实现此处为 −120**）`,
    ).toBeGreaterThanOrEqual(120 - TOL_PX);
    expect(Math.abs(dUpper - 120), `D8-1 位移 1:1（实读 Δ${dUpper}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(dLower + 120), `D8-1 明细视图反向 1:1（实读 Δ${dLower}）`).toBeLessThanOrEqual(TOL_PX);
    // 第三个视图（**非本边界两侧**）⇒ 保持显式点名
    expect(a1.views.kline!.h, 'D8-1 另一条边界不受影响（K 线视图完全不动）').toBe(b1.views.kline!.h);
    expect(
      Math.abs(a1.views.kline!.h + a1.views[upperKey]!.h + a1.views[lowerKey]!.h - a1.available),
      'D9-6④ 守恒',
    ).toBeLessThanOrEqual(TOL_PX);

    // ── D8-4（自默认）：双击 ⇒ 三视图逐 px 回到默认态 ──
    await resetBoundary(page, 'id');
    const resetFromUp = await probe(page);
    writeJson('d8_t2_dblclick_after_up', { a1, resetFromUp, base });
    expect(
      Math.abs(resetFromUp.views[lowerKey]!.h - base.views[lowerKey]!.h),
      `D8-4 双击 指标↔明细 ⇒ 明细视图高回到默认（期望 ${base.views[lowerKey]!.h}±${TOL_PX}，实读 ${resetFromUp.views[lowerKey]!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(resetFromUp.views[upperKey]!.h - base.views[upperKey]!.h)).toBeLessThanOrEqual(TOL_PX);
    expect(resetFromUp.ratios.indicators, `D8-4 复位后指标比例 = 默认 ${DEFAULT_RATIOS.indicators}`).toBeCloseTo(
      DEFAULT_RATIOS.indicators,
      2,
    );
    expect(resetFromUp.views.kline!.h, 'D8-4 双击 指标↔明细 不得改变 K 线视图').toBe(a1.views.kline!.h);

    // ── 下拖 120（自默认）⇒ 反向 1:1 ──
    const b2 = await probe(page);
    await dragSplitterBy(page, 'id', 120);
    const a2 = await probe(page);
    const dUpper2 = a2.views[upperKey]!.h - b2.views[upperKey]!.h;
    const dLower2 = a2.views[lowerKey]!.h - b2.views[lowerKey]!.h;
    writeJson('d8_t2_drag_down120', { b2, a2, dUpper2, dLower2 });
    expect(
      dUpper2,
      `D8-2 下移 120 ⇒ 上方视图变矮 ≈−120（实读 Δ${dUpper2}；**错方向实现此处为 +120**）`,
    ).toBeLessThanOrEqual(-120 + TOL_PX);
    expect(Math.abs(dUpper2 + 120), `D8-2 位移 1:1（实读 Δ${dUpper2}）`).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(dLower2 - 120), `D8-2 明细视图反向 1:1（实读 Δ${dLower2}）`).toBeLessThanOrEqual(TOL_PX);
    expect(a2.views.kline!.h).toBe(b2.views.kline!.h);

    // ── 下拖 240（自默认；余量实测 > 240）⇒ 1:1 ──
    await resetBoundary(page, 'id');
    const b2b = await probe(page);
    await dragSplitterBy(page, 'id', 240);
    const a2b = await probe(page);
    writeJson('d8_t2_drag_down240', { b2b, a2b });
    expect(
      Math.abs(a2b.views[upperKey]!.h - b2b.views[upperKey]!.h + 240),
      `D8-2② 下移 240 ⇒ 1:1（实读 Δ${a2b.views[upperKey]!.h - b2b.views[upperKey]!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(Math.abs(a2b.views[lowerKey]!.h - b2b.views[lowerKey]!.h - 240)).toBeLessThanOrEqual(TOL_PX);
    expect(a2b.views.kline!.h).toBe(b2b.views.kline!.h);

    // ── 上拖 240（越界）⇒ 明细停在可读下限 95，差额由指标吸收 ──
    await resetBoundary(page, 'id');
    const b3 = await probe(page);
    await dragSplitterBy(page, 'id', -240);
    const a3 = await probe(page);
    const clip = Math.max(0, VIEW_MIN.detail - (b3.views[lowerKey]!.h - 240));
    writeJson('d8_t2_drag_up240_clip', { b3, a3, clip });
    expect(a3.views[lowerKey]!.h, `D9-7 越界上拖 ⇒ 明细视图停在可读下限 ${VIEW_MIN.detail}`).toBe(VIEW_MIN.detail);
    expect(
      Math.abs(a3.views[upperKey]!.h - (b3.views[upperKey]!.h + 240 - clip)),
      `D8-1 指标吸收被夹取的 ${clip}px（实读 ${a3.views[upperKey]!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(a3.views.kline!.h, 'D8 另一条边界不受影响（K 线仍不动）').toBe(b3.views.kline!.h);
    expect(
      Math.abs(a3.views.kline!.h + a3.views[upperKey]!.h + a3.views[lowerKey]!.h - a3.available),
      'D9-6④ 夹取后守恒仍成立',
    ).toBeLessThanOrEqual(TOL_PX);

    // ── 越界（自默认 上拖 4000）⇒ 明细仍不得被压到 0；超额位移由同侧（指标）吸收 ──
    await resetBoundary(page, 'id');
    const b4 = await probe(page);
    await dragSplitterBy(page, 'id', -4000);
    const a4 = await probe(page);
    writeJson('d8_t2_upper_limit', { b4, a4 });
    expect(a4.views[lowerKey]!.h, `D9-7 极端上拖 ⇒ 明细停在可读下限（实读 ${a4.views[lowerKey]!.h}）`).toBe(VIEW_MIN.detail);
    expect(a4.views[upperKey]!.h, `D9-7 指标视图 ≥ ${VIEW_MIN.indicators}`).toBeGreaterThanOrEqual(VIEW_MIN.indicators);
    expect(a4.views.kline!.h, 'D9-7 另一条边界仍不受影响').toBe(b4.views.kline!.h);
    expect(
      Math.abs(a4.views.kline!.h + a4.views[upperKey]!.h + a4.views[lowerKey]!.h - a4.available),
      'D9-6④ 极端位移后守恒仍成立',
    ).toBeLessThanOrEqual(TOL_PX);

    // ── D8-4：双击 ⇒ 复位**该边界**默认股比（指标 : 明细 = 0.29 : 0.16） ──
    await resetBoundary(page, 'id');
    const reset = await probe(page);
    const share = reset.views[upperKey]!.h / (reset.views[upperKey]!.h + reset.views[lowerKey]!.h);
    writeJson('d8_t2_dblclick_reset', { a4, reset, base, share });
    expect(
      share,
      `D8-4 双击 指标↔明细 ⇒ 该边界股比复位 ${(DEFAULT_RATIOS.indicators / (DEFAULT_RATIOS.indicators + DEFAULT_RATIOS.detail)).toFixed(4)}（实读 ${share.toFixed(4)}）`,
    ).toBeCloseTo(DEFAULT_RATIOS.indicators / (DEFAULT_RATIOS.indicators + DEFAULT_RATIOS.detail), 2);
    expect(reset.views.kline!.h, 'D8-4 双击 指标↔明细 不得改变第三个视图（K 线视图）').toBe(a4.views.kline!.h);
    expect(
      Math.abs(reset.views[lowerKey]!.h - base.views[lowerKey]!.h),
      `D8-4 复位后明细视图高回到默认（期望 ${base.views[lowerKey]!.h}±${TOL_PX}，实读 ${reset.views[lowerKey]!.h}）`,
    ).toBeLessThanOrEqual(TOL_PX);
    expect(reset.ratios.indicators, 'D8-4 复位后指标比例 = 默认 0.29（K 线未偏离默认时）').toBeCloseTo(
      DEFAULT_RATIOS.indicators,
      2,
    );
  });
});

test.describe('D8-3 两类把手符号相反（曲线卡把手下拖 = 变高 vs 分隔条上拖 = 上方视图变高）', () => {
  test.use({ viewport: RICH_VIEWPORT });

  test('四张曲线卡把手下拖 +40 ⇒ 卡变高（D4.2 保留）；同页分隔条上拖 ⇒ 上方视图变高（反向并存）', async ({
    page,
  }) => {
    await openRun(page);
    const base = await probe(page);
    writeJson('d8_t3_base', base);
    // D9-5：K 线卡把手已删 ⇒ 「两类把手」= 曲线卡把手（下沿）+ 视图分隔条（上沿/下沿）
    expect(base.klineCard.cardHandlePresent, 'D9-5：K 线卡下沿把手必须不存在（本判据的迁移前提）').toBe(false);

    // ── D8-3①：四张曲线卡把手**向下 +40** ⇒ 卡片**变高**（把手下沿 ⇒ 符号为正） ──
    const results: Record<string, { before: number; after: number; delta: number }> = {};
    for (const id of CURVE_CARDS) {
      const before = await probe(page);
      expect(before.curveCards[id], `曲线卡 wb-${id}-chart 必须存在`).not.toBeNull();
      expect(before.curveCards[id]!.handleH, `曲线卡 ${id} 必须有下沿把手（D4.2 保留）`).not.toBeNull();
      await dragCurveHandleBy(page, id, 40);
      const after = await probe(page);
      const delta = after.curveCards[id]!.h - before.curveCards[id]!.h;
      results[id] = { before: before.curveCards[id]!.h, after: after.curveCards[id]!.h, delta };
      expect(
        delta,
        `D8-3 [${id}] 曲线卡把手**向下** 40 ⇒ 卡片**变高** ≈+40（实读 Δ${delta}；**若与分隔条套用同一符号此处为 −40**）`,
      ).toBeGreaterThanOrEqual(40 - TOL_PX);
      expect(Math.abs(delta - 40), `D8-3 [${id}] 位移 1:1（实读 Δ${delta}）`).toBeLessThanOrEqual(TOL_PX);
      // 卡片拖高**不得**改变三段视图分配（视图高度与卡片高度是两套机制，D9-5/D4.2 并存）
      expect(after.views.kline!.h, `D8-3 [${id}] 曲线卡拖高不得改变 K 线视图高`).toBe(before.views.kline!.h);
      expect(after.views.detail!.h, `D8-3 [${id}] 曲线卡拖高不得改变明细视图高`).toBe(before.views.detail!.h);
    }
    writeJson('d8_t3_curve_handle_down', results);

    // ── D8-3②：反向复核（把手上拖 −40 ⇒ 卡变矮） ──
    const upBefore = await probe(page);
    await dragCurveHandleBy(page, 'aggregate', -40);
    const upAfter = await probe(page);
    const dUp = upAfter.curveCards['aggregate']!.h - upBefore.curveCards['aggregate']!.h;
    writeJson('d8_t3_curve_handle_up', { upBefore, upAfter, dUp });
    expect(dUp, `D8-3 把手向上 40 ⇒ 卡片变矮 ≈−40（实读 Δ${dUp}）`).toBeLessThanOrEqual(-40 + TOL_PX);
    expect(Math.abs(dUp + 40), `D8-3 位移 1:1（实读 Δ${dUp}）`).toBeLessThanOrEqual(TOL_PX);

    // ── D8-3③：同页交叉：分隔条**向上** ⇒ 上方视图变高（与曲线卡把手的「向下=变高」符号**相反**） ──
    const splitBase = await probe(page);
    await dragSplitterBy(page, 'ki', -60);
    const splitUp = await probe(page);
    const dViewUp = splitUp.views.kline!.h - splitBase.views.kline!.h;
    writeJson('d8_t3_splitter_cross', { splitBase, splitUp, dViewUp, curveDelta: results['aggregate']!.delta });
    expect(
      dViewUp,
      `D8-3 同页交叉：分隔条向上 60 ⇒ K 线视图变高 ≈+60（实读 Δ${dViewUp}）——与曲线卡把手方向**相反**`,
    ).toBeGreaterThanOrEqual(60 - TOL_PX);
    expect(Math.abs(dViewUp - 60)).toBeLessThanOrEqual(TOL_PX);
    // 两类把手的符号差是几何决定的：同一手势方向（向上）在 **分隔条** = 上方视图**变高**，
    // 在 **曲线卡把手** = 卡片**变矮**（D8-3② 的 dUp < 0）⇒ 若把两者符号互相套用，本用例必红。
    expect(
      Math.sign(dUp),
      `D8-3 符号相反判据：向上手势在卡把手上 Δ=${dUp}（须为负），在分隔条上 Δ=${dViewUp}（须为正）`,
    ).toBe(-1);
    expect(Math.sign(dViewUp)).toBe(1);
  });
});
