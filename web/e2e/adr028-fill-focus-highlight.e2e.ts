/**
 * ADR-028 §2.4b（D4.1）**真渲染**端到端 —— 买卖点醒目化 + L2 跳转后的 focus / 精确到笔高亮 / 曲线竖线。
 *
 * 用户原话（需求事实源）：①「K 线上最好再标注一下买卖的点」；
 * ②「l2 点击跳转之后，可以 focus 到 k 线上，并且高亮一下对应的买卖标记」。
 *
 * **为什么必须真渲染**：高亮与醒目化都落在 klinecharts canvas / overlay 层，jsdom 无 canvas，
 * 单测只能断言**调用面**（`createOverlay` 的 extendData）。本规格在**真身**上断言：
 *  1. **focus**：L2 `[跳转]` 后 **K 线在上栏内可见**（见下「契约修订史」②：D9 后为**不变量**判据）；
 *  2. **只高亮被点击的那一笔**：`kline-chart[data-highlight-key]` = `rt_seq:成交序号`（精确到笔），
 *     `data-highlight-active=true`；
 *  3. **3 秒后回常态**（`data-highlight-active=false`，无永久选中态）；
 *  4. 各**曲线视图**出现竖线标记（`wb-vline`，同一时点）。
 *
 * **契约修订史（逐条给推导，非按实现倒推；依 ADR-023 §6.2）**
 *  ① 2026-09-23（§2.7 第 5 项，D7）：focus 滚动**作用域收敛到上栏容器**（页级 `scrollIntoView` 废弃）⇒
 *     前置从「结果页 `wb-result` 已滚动」改为「**上栏 `wb-kline-view` 已滚离 K 线**（`scrollTop > 200`）」，
 *     判据为跳转后上栏把 K 线带回可见（`scrollTop` 回落）。
 *  ② 2026-09-24（**§2.9-3 D9-4 + §2.9-10 D9-10**，D9 三视图拆分）：
 *     **K 线视图不再滚动**（`overflow:hidden`；`scrollHeight ≤ clientHeight`）⇒ ① 的前置
 *     「把 K 线滚出上栏可视区」**几何上不可满足** ⇒ 该前置与被其支撑的两条断言
 *     （`scrollTop` 必须变小 / 必须变化）在新口径下**无对应物**（已点名删除，见测试体内说明与执行报告）。
 *     focus 的等价判据 = **不变量**（D9-10）：K 线视图在视口内 ∧ 卡完整落在视图内 ∧ 锚点在视图视口内
 *     ∧ 整页不滚（`scrollY == 0`）∧ 明细视图 `scrollTop` 不变 ∧ 指标视图 `scrollTop` 不变（对齐 D7-4②）
 *     ∧ 三段视图分配不变（§4-12⑥）；另断言 focus 路径的可观测计数递增（`data-focus-scroll`）。
 *  ③ 高亮 / 3 秒回常态 / 曲线竖线（②③④ 项）**逐条保留**（D9 未改变其口径）。
 *
 * 运行（同 adr028-window-sync.e2e.ts：真身 = 生产构建产物 + :8081 后端/库；**证据出口须为未跟踪目录**）：
 *   npx vite build --outDir /tmp/<dir> && VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --outDir /tmp/<dir> &
 *   E2E_BASE_URL=http://localhost:<port> npx playwright test e2e/adr028-fill-focus-highlight.e2e.ts
 *   （默认出口 `coder/evidence/20260920_adr028_features/raw` **含 26 个已跟踪文件** ⇒ 禁止用默认值）
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT =
  process.env.ADR028_FEAT_E2E_OUT ??
  resolve(REPO, 'tester/evidence/20260924_d9_spec_tail/raw/fill_focus');

/** 目标 run（159776/D1；rt_seq=1 l2_count=16 ⇒ 可断言「精确到笔」）。 */
const RUN_ID = process.env.ADR028_FEAT_RUN ?? 'sr_1789832477006_000002';
/** 目标 L1 回合。 */
const RT_SEQ = Number(process.env.ADR028_FEAT_RT ?? '1');
/** 目标 L2 行（**必须 > 0**：第 2 笔 ⇒ 高亮键须为 `rt:1` 而非 `rt:0`）。 */
const FILL_IDX = Number(process.env.ADR028_FEAT_FILL ?? '1');
/** 高亮时长（与 `KlineChart.HIGHLIGHT_DURATION_MS` 同口径）。 */
const HIGHLIGHT_DURATION_MS = 3000;

function writeJson(name: string, data: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

async function readAttrs(page: Page, testId: string): Promise<Record<string, string>> {
  return page.getByTestId(testId).evaluate((e) =>
    Object.fromEntries(Array.from(e.attributes).map((x) => [x.name, x.value])),
  );
}

/** 打开工作台、选中 run、等 K 线**初始装载落定**（与 window-sync 同口径，避免与初次 fit 抢时序）。 */
async function openRunSettled(page: Page, runId: string): Promise<void> {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('wb-run-list')).toBeVisible();
  const select = page.getByTestId(`wb-run-select-${runId}`);
  await expect(select, `运行 ${runId} 必须在历史列表内`).toBeVisible();
  await select.click();
  await expect(page.getByTestId('wb-result')).toBeVisible();
  await expect(page.getByTestId('wb-window-bar')).toBeVisible();
  await expect(page.getByTestId('wb-fills-note')).toBeVisible();
  await expect(page.getByTestId('wb-window-state')).toHaveAttribute('data-source', 'kline');
  await page.waitForTimeout(2500);
}

/** K 线区域裁切截图：**每次重新测量**几何（跳转的平滑滚动尚未落定时旧框会失效 ⇒ 空裁切报错），
 *  并把裁切钳到视口内（越界部分直接丢弃）。 */
async function shotKlineClip(page: Page, name: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId('wb-kline-chart').boundingBox();
  expect(box, 'K 线容器必须有几何框').toBeTruthy();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const x = Math.max(0, Math.round(box!.x));
  const y = Math.max(0, Math.round(box!.y));
  const width = Math.max(1, Math.min(Math.round(box!.width), vp.width - x));
  const height = Math.max(1, Math.min(Math.round(box!.height), vp.height - y));
  const clip = { x, y, width, height };
  await page.screenshot({ path: resolve(OUT, name), clip });
  return clip;
}

test('D4.1 真渲染（D9 重锚：focus = 不变量）：L2 跳转 ⇒ K 线常驻可见 + 跳转纪律（页面/明细/指标均不动）+ 精确到笔高亮 + 3 秒回常态 + 曲线竖线', async ({
  page,
}) => {
  await openRunSettled(page, RUN_ID);

  /** D9-10 判据读数：页面滚动 + 两个**实际可滚**视图（明细 `wb-detail-pane` / 指标 `wb-indicator-view`）
   *  + focus 可观测计数 + 三段视图分配（`data-view-height-*`）。 */
  const readJumpState = () =>
    page.evaluate(() => {
      const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
      const r = q('wb-result');
      return {
        scrollY: window.scrollY,
        docScrollH: document.scrollingElement?.scrollHeight ?? -1,
        innerH: window.innerHeight,
        detailPaneTop: (q('wb-detail-pane') as HTMLElement | null)?.scrollTop ?? -1,
        indicatorTop: (q('wb-indicator-view') as HTMLElement | null)?.scrollTop ?? -1,
        focusRev: Number(q('wb-kline-view')?.getAttribute('data-focus-scroll') ?? '0'),
        viewHeights: [
          r?.getAttribute('data-view-height-kline'),
          r?.getAttribute('data-view-height-indicators'),
          r?.getAttribute('data-view-height-detail'),
        ].join('/'),
      };
    });

  // 数据侧锚点（目标笔的 ts / bar_index；用于与曲线竖线、探针交叉核对）
  const resp = await page.request.get(`/api/workbench/runs/${RUN_ID}/round-trips/${RT_SEQ}/fills?limit=200`);
  expect(resp.ok(), `/round-trips/${RT_SEQ}/fills`).toBeTruthy();
  const fillList = ((await resp.json()) as { fills?: Array<{ ts: number; bar_index: number }> }).fills ?? [];
  expect(fillList.length, `rt ${RT_SEQ} 的 L2 笔数`).toBeGreaterThan(FILL_IDX);
  const targetFill = fillList[FILL_IDX]!;
  const wantKey = `${RT_SEQ}:${FILL_IDX}`;

  // 前置①（**D9-4**）：K 线视图**不是**滚动容器（旧「上栏才是滚动容器」口径已废止，见文件头修订史 ②）
  const kvGeom = await page.getByTestId('wb-kline-view').evaluate((e) => ({
    overflowY: getComputedStyle(e).overflowY,
    scrollHeight: e.scrollHeight,
    clientHeight: e.clientHeight,
  }));
  expect(kvGeom.overflowY, 'D9-4 K 线视图必须 overflow:hidden（不滚动）').toBe('hidden');
  expect(kvGeom.scrollHeight, 'D9-4 K 线视图无内部滚动（scrollHeight ≤ clientHeight）').toBeLessThanOrEqual(
    kvGeom.clientHeight,
  );

  // 展开 L2，并把目标行在**明细视图内**摆到容器中部
  //  （`jump.click()` 的自动滚入会污染「明细 scrollTop 不变」基线 ⇒ 先就位、后读基线）
  await page.getByTestId(`wb-rt-detail-${RT_SEQ}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_SEQ}-${FILL_IDX}`);
  await expect(row).toBeVisible();
  await page.evaluate(
    (rowId) => {
      const pane = document.querySelector('[data-testid="wb-detail-pane"]');
      const el = document.querySelector(`[data-testid="${rowId}"]`);
      if (pane && el) {
        const pr = pane.getBoundingClientRect();
        const rr = el.getBoundingClientRect();
        pane.scrollTop = pane.scrollTop + (rr.top - pr.top) - Math.max(0, (pane.clientHeight - rr.height) / 2);
      }
      // 前置②：把**指标视图**滚离顶端（使「指标 scrollTop 不变」有鉴别力）
      const iv = document.querySelector('[data-testid="wb-indicator-view"]');
      if (iv) iv.scrollTop = 200;
    },
    `wb-l2-row-${RT_SEQ}-${FILL_IDX}`,
  );
  const jump = page.getByTestId(`wb-l2-jump-${RT_SEQ}-${FILL_IDX}`);
  await jump.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const before = await readJumpState();
  expect(before.detailPaneTop, '前置①：明细视图必须已滚动（否则「不变」判据无鉴别力）').toBeGreaterThan(0);
  expect(before.indicatorTop, '前置②：指标视图必须已滚动（否则「不变」判据无鉴别力）').toBeGreaterThan(0);
  expect(before.scrollY, '前置③：页面必须未滚动（整页不滚，D9-4）').toBe(0);

  await jump.click();
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-highlight-active', 'true');
  mkdirSync(OUT, { recursive: true });
  const after = await readJumpState();

  // ① focus（**D9-10 重锚**）：K 线在上栏内可见 —— 锚点在 K 线视图视口内 ∧ 视图在视口内 ∧ 卡完整落在视图内
  await expect
    .poll(
      async () =>
        page.getByTestId('wb-kline-focus-anchor').evaluate((el) => {
          const box = el.getBoundingClientRect();
          const scroller = document.querySelector('[data-testid="wb-kline-view"]')!;
          const sBox = scroller.getBoundingClientRect();
          return box.top >= sBox.top - 4 && box.top <= sBox.bottom - 20;
        }),
      { timeout: 5000, message: 'K 线锚点必须落在 **K 线视图**可视区内（D9-10「K 线在上栏内回到可见」）' },
    )
    .toBe(true);
  const kb = await page.getByTestId('wb-kline-view').boundingBox();
  const cardBox = await page.getByTestId('wb-kline-chart').boundingBox();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  expect(kb, 'K 线视图必须有几何框').toBeTruthy();
  expect(cardBox, 'K 线卡必须有几何框').toBeTruthy();
  expect(kb!.y, `D9-4 K 线视图必须在视口内（实读 y=${kb!.y}）`).toBeGreaterThanOrEqual(0);
  expect(kb!.y + kb!.height, `D9-4 K 线视图底边必须在视口内（${kb!.y + kb!.height} / 视口 ${vp.height}）`).toBeLessThanOrEqual(
    vp.height,
  );
  expect(cardBox!.y, 'D9-2 K 线卡顶不得越出 K 线视图顶（K 线常驻可见）').toBeGreaterThanOrEqual(kb!.y - 2);
  expect(
    cardBox!.y + cardBox!.height,
    'D9-2/D9-4 K 线卡底不得越出 K 线视图底（视图不滚 ⇒ 卡恒完整可见）',
  ).toBeLessThanOrEqual(kb!.y + kb!.height + 2);
  // focus 路径**执行过**（§2.7-5 作用域收敛后的可观测计数；K 线视图不滚 ⇒ 该计数是「focus 未静默失效」的唯一证据）
  expect(
    after.focusRev,
    `focus 路径必须执行过（data-focus-scroll ${before.focusRev} → ${after.focusRev}）`,
  ).toBeGreaterThan(before.focusRev);
  // ②③④ D9-10 纪律 + §4-12⑥：页面不滚 / 明细 scrollTop 不变 / 指标视图 scrollTop 不变 / 三段分配不变
  expect(after.scrollY, 'D9-4/D9-10 跳转后页面不得滚动（scrollY 必须 0）').toBe(0);
  expect(after.scrollY, 'D9-10 跳转前后页面滚动位置不变').toBe(before.scrollY);
  expect(after.detailPaneTop, 'D9-10 跳转不得改变明细视图 scrollTop（B1-1 完全不动）').toBe(before.detailPaneTop);
  expect(after.indicatorTop, 'D9-10 跳转不得改变指标视图 scrollTop（对齐 D7-4②）').toBe(before.indicatorTop);
  expect(after.viewHeights, 'D9-10 跳转不得改变三段视图高度分配（§4-12⑥）').toBe(before.viewHeights);

  // **被点名删除的旧断言**（D9 下无对应物，不静默删）：
  //  · `scrollBefore > 200`（上栏滚离 K 线）—— K 线视图不滚（D9-4）⇒ 几何不可满足；
  //  · `scrollAfter < scrollBefore` / `scrollAfter != scrollBefore`（focus 的滚动动作）—— 同上；
  //    其语义（「K 线回到可见」）已由上面 ① 的不变量断言承接，且判据仍有鉴别力（卡越界 / 视图越界 / 页面被滚必红）。

  // **像素证据**（高亮只活 3 秒，须在窗口内抢拍）：K 线区域裁切 × 两个脉冲相位。
  // 脉冲 = 定时器驱动 overlay 重绘（半径/描边变化）⇒ 两相位像素差必须落在 K 线框内，
  // 这是「高亮真的画在 canvas 上」的硬证据（DOM 属性只证明状态机，不证明渲染）。
  const clip = await shotKlineClip(page, 'd41_kline_phase_a.png');
  const pulseA = await readAttrs(page, 'kline-chart');
  await page.waitForTimeout(170);
  await shotKlineClip(page, 'd41_kline_phase_b.png');
  const pulseB = await readAttrs(page, 'kline-chart');

  // ② 高亮：**只高亮被点击的那一笔**（判别键 = rt_seq:成交序号）
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-highlight-key', wantKey);
  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-highlight-active', 'true');
  const noteAttrs = await readAttrs(page, 'wb-jump-highlight-note');

  // ③ 曲线竖线：各曲线视图同一时点（ts 一致）
  const vlines = page.locator('[data-testid="wb-vline"]');
  await expect.poll(() => vlines.count(), { timeout: 5000 }).toBeGreaterThan(0);
  const vlineAttrs = await vlines.evaluateAll((els) =>
    els.map((e) => ({ view: e.getAttribute('data-view'), ts: e.getAttribute('data-vline-ts') })),
  );
  const vlineTs = new Set(vlineAttrs.map((v) => v.ts));

  const shotHighlight = resolve(OUT, 'd41_highlight_on.png');
  await page.screenshot({ path: shotHighlight });

  // 探针（窗口落点）与 K 线真身观测
  const probe = await readAttrs(page, 'wb-window-probe');
  const klineAttrs = { ...(await readAttrs(page, 'kline-chart')), ...(await readAttrs(page, 'wb-kline-focus-anchor')) };

  // ④ 3 秒后回常态（无永久选中态）
  await page.waitForTimeout(HIGHLIGHT_DURATION_MS + 700);
  const afterAttrs = await readAttrs(page, 'kline-chart');
  const shotAfter = resolve(OUT, 'd41_highlight_after_3s.png');
  await page.screenshot({ path: shotAfter });
  await shotKlineClip(page, 'd41_kline_after_3s.png');

  writeJson('d41_focus_highlight', {
    run_id: RUN_ID,
    rt_seq: RT_SEQ,
    fill_idx: FILL_IDX,
    target_fill: targetFill,
    want_key: wantKey,
    // D9 重锚：旧 `scroll_before/scroll_after`（上栏滚动位）无对应物（K 线视图不滚，D9-4）⇒ 换为 D9-10 读数
    jump_state_before: before,
    jump_state_after: after,
    kline_view_geom: kvGeom,
    kline_view_box: kb,
    kline_card_box: cardBox,
    viewport: { width: vp.width, height: vp.height },
    note_attrs: noteAttrs,
    vlines: vlineAttrs,
    vline_ts_unique: [...vlineTs],
    probe,
    kline_attrs: klineAttrs,
    kline_after_3s: afterAttrs,
    kline_clip: clip,
    pulse_at_phase_a: pulseA['data-highlight-pulse'],
    pulse_at_phase_b: pulseB['data-highlight-pulse'],
    screenshots: {
      highlight_on: shotHighlight,
      after_3s: shotAfter,
      kline_phase_a: resolve(OUT, 'd41_kline_phase_a.png'),
      kline_phase_b: resolve(OUT, 'd41_kline_phase_b.png'),
      kline_after_3s: resolve(OUT, 'd41_kline_after_3s.png'),
    },
  });

  // （旧断言「focus ⇒ 上栏滚动位置必须变化」已按 D9-4 删除：K 线视图不滚 ⇒ 无「滚动到 K 线」动作；
  //   见文件头修订史 ② 与测试体内的点名说明。D9-10 的四条不变量断言已在其前逐条执行。）
  expect(Number(pulseA['data-highlight-pulse']), '相位 A 必须处于高亮脉冲中').toBeGreaterThan(0);
  expect(Number(pulseB['data-highlight-pulse']), '相位 B 必须处于高亮脉冲中').toBeGreaterThan(0);
  expect(pulseA['data-highlight-pulse']).not.toBe(pulseB['data-highlight-pulse']);
  expect(noteAttrs['data-state'], '高亮提示状态').toBe('ok');
  expect(vlineAttrs.length, '各曲线视图都应有竖线标记').toBeGreaterThanOrEqual(4);
  expect(vlineTs.size, '竖线标记时点必须唯一（同一时点）').toBe(1);
  expect([...vlineTs][0]).not.toBe('');
  expect(Number([...vlineTs][0])).toBeGreaterThan(0);
  expect(afterAttrs['data-highlight-active'], '3 秒后必须回常态').toBe('false');
  expect(afterAttrs['data-highlight-key'], '键仍指向目标笔（仅高亮态结束，不得残留选中态）').toBe(wantKey);
});
