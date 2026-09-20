/**
 * ADR-028 §2.4b（D4.1）**真渲染**端到端 —— 买卖点醒目化 + L2 跳转后的 focus / 精确到笔高亮 / 曲线竖线。
 *
 * 用户原话（需求事实源）：①「K 线上最好再标注一下买卖的点」；
 * ②「l2 点击跳转之后，可以 focus 到 k 线上，并且高亮一下对应的买卖标记」。
 *
 * **为什么必须真渲染**：高亮与醒目化都落在 klinecharts canvas / overlay 层，jsdom 无 canvas，
 * 单测只能断言**调用面**（`createOverlay` 的 extendData）。本规格在**真身**上断言：
 *  1. L2 `[跳转]` 后结果页**滚动到 K 线区域**（锚点在滚动容器可视区内）；
 *  2. **只高亮被点击的那一笔**：`kline-chart[data-highlight-key]` = `rt_seq:成交序号`（精确到笔），
 *     `data-highlight-active=true`；
 *  3. **3 秒后回常态**（`data-highlight-active=false`，无永久选中态）；
 *  4. 各**曲线视图**出现竖线标记（`wb-vline`，同一时点）。
 *
 * 运行（同 adr028-window-sync.e2e.ts：真身 = 生产构建产物 + :8081 后端/库）：
 *   npx vite build && VITE_PROXY_TARGET=http://localhost:8081 npx vite preview --port 4173 &
 *   E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/adr028-fill-focus-highlight.e2e.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT =
  process.env.ADR028_FEAT_E2E_OUT ?? resolve(REPO, 'coder/evidence/20260920_adr028_features/raw');

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

test('D4.1 真渲染：L2 跳转 ⇒ focus 滚动到 K 线 + 精确到笔高亮 + 3 秒回常态 + 曲线竖线', async ({
  page,
}) => {
  await openRunSettled(page, RUN_ID);

  // 数据侧锚点（目标笔的 ts / bar_index；用于与曲线竖线、探针交叉核对）
  const resp = await page.request.get(`/api/workbench/runs/${RUN_ID}/round-trips/${RT_SEQ}/fills?limit=200`);
  expect(resp.ok(), `/round-trips/${RT_SEQ}/fills`).toBeTruthy();
  const fillList = ((await resp.json()) as { fills?: Array<{ ts: number; bar_index: number }> }).fills ?? [];
  expect(fillList.length, `rt ${RT_SEQ} 的 L2 笔数`).toBeGreaterThan(FILL_IDX);
  const targetFill = fillList[FILL_IDX]!;
  const wantKey = `${RT_SEQ}:${FILL_IDX}`;

  // 展开 L2 并记录跳转前滚动状态（focus 判据的基线）
  await page.getByTestId(`wb-rt-detail-${RT_SEQ}`).click();
  const row = page.getByTestId(`wb-l2-row-${RT_SEQ}-${FILL_IDX}`);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const scrollBefore = await page
    .getByTestId('wb-result')
    .evaluate((e) => (e as HTMLElement).scrollTop);

  await page.getByTestId(`wb-l2-jump-${RT_SEQ}-${FILL_IDX}`).click();

  await expect(page.getByTestId('kline-chart')).toHaveAttribute('data-highlight-active', 'true');
  mkdirSync(OUT, { recursive: true });

  // ① focus：结果页滚动到 K 线区域（锚点落在滚动容器可视区内 + 滚动位置确实变化）
  await expect
    .poll(
      async () =>
        page.getByTestId('wb-kline-focus-anchor').evaluate((el) => {
          const box = el.getBoundingClientRect();
          const scroller = document.querySelector('[data-testid="wb-result"]')!;
          const sBox = scroller.getBoundingClientRect();
          return box.top >= sBox.top - 4 && box.top <= sBox.bottom - 20;
        }),
      { timeout: 5000, message: 'K 线锚点必须落在结果页可视区内（focus 滚动）' },
    )
    .toBe(true);
  const scrollAfter = await page
    .getByTestId('wb-result')
    .evaluate((e) => (e as HTMLElement).scrollTop);

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
    scroll_before: scrollBefore,
    scroll_after: scrollAfter,
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

  expect(scrollAfter, 'focus：滚动位置必须变化（跳转到 K 线区域）').not.toBe(scrollBefore);
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
