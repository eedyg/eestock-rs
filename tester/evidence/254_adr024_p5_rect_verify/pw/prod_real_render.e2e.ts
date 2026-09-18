import { test, expect } from '@playwright/test';

/**
 * tester·**N4 真渲染**（独立复跑，不采信 worker 转录）—— 生产构建 SPA + 真二实例 + 临时库。
 *
 * 四项必查（按 03-test-plan §5 #2「禁止以 jsdom 替代前端验收」）：
 * ① 策略下拉**非空**（catalog 真加载）；
 * ② `range_empty` **按 code 渲染**（并旁证 API 原始 body 的 `error.code`）；
 * ③ `clamped` 提示条；
 * ④ `resource_guard` 二次确认 → 确认后 **201 + 新 run 入历史**。
 */
test('N4① 策略下拉非空（catalog 真加载）', async ({ page }) => {
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  const addSel = page.getByTestId('wb-add-strategy');
  await expect.poll(async () => addSel.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
  const n = await addSel.locator('option').count();
  console.log(`[N4①] 策略下拉 option 数 = ${n}`);
  console.log(`[N4①] 第 1 项文案 = ${await addSel.locator('option').first().innerText()}`);
  await page.screenshot({ path: 'artifacts/01-catalog-dropdown.png' });
});

test('N4② range_empty 按 code 渲染', async ({ page }) => {
  const apiBodies: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/workbench/runs') && r.request().method() === 'POST') {
      try {
        apiBodies.push(JSON.stringify(await r.json()));
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto('/backtest-workbench');
  const addSel = page.getByTestId('wb-add-strategy');
  await expect.poll(async () => addSel.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
  await page.getByTestId('wb-symbol').selectOption('518880');
  await page.getByTestId('wb-period').selectOption('D1');
  await addSel.selectOption({ index: 1 });
  await page.getByTestId('wb-add-btn').click();
  await expect(page.locator('[data-testid^="slot-card-"]').first()).toBeVisible();

  // 2010 年：早于 518880 D1 可得区间（2013-07-29）⇒ 无交集 ⇒ range_empty
  await page.getByTestId('wb-date-from').fill('2010-01-01');
  await page.getByTestId('wb-date-to').fill('2010-02-01');
  await page.getByTestId('wb-submit').click();
  const errBox = page.getByTestId('wb-submit-error');
  await expect(errBox).toBeVisible({ timeout: 30_000 });
  const text = await errBox.innerText();
  console.log(`[N4②] 渲染文案 = ${text.replace(/\n/g, ' ')}`);
  console.log(`[N4②] 原始 400 body = ${apiBodies.join(' | ').slice(0, 400)}`);
  expect(text).toContain('无数据'); // code=range_empty 的中文分支
  expect(text).toContain('可用区间'); // detail 回显被消费
  expect(apiBodies.join('')).toContain('"range_empty"'); // 旁证：码来自后端
  await page.screenshot({ path: 'artifacts/02-range-empty-by-code.png' });
});

test('N4③ clamped 提示条', async ({ page }) => {
  await page.goto('/backtest-workbench');
  const addSel = page.getByTestId('wb-add-strategy');
  await expect.poll(async () => addSel.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
  await page.getByTestId('wb-symbol').selectOption('518880');
  await page.getByTestId('wb-period').selectOption('D1');
  await addSel.selectOption({ index: 1 });
  await page.getByTestId('wb-add-btn').click();
  await expect(page.locator('[data-testid^="slot-card-"]').first()).toBeVisible();

  // 起点早于可得区间（2013-07-29），终点短 ⇒ 收缩但不触护栏
  await page.getByTestId('wb-date-from').fill('2013-01-01');
  await page.getByTestId('wb-date-to').fill('2013-08-05');
  await page.getByTestId('wb-submit').click();
  const clamp = page.getByTestId('wb-clamp-notice');
  await expect(clamp).toBeVisible({ timeout: 60_000 });
  console.log(`[N4③] 提示条文案 = ${await clamp.innerText()}`);
  expect(await clamp.innerText()).toContain('已按实际数据范围收缩');
  await page.screenshot({ path: 'artifacts/03-clamp-notice.png' });
});

test('N4④ resource_guard 二次确认 → 确认后 201 + 新 run 入历史', async ({ page }) => {
  await page.goto('/backtest-workbench');
  const addSel = page.getByTestId('wb-add-strategy');
  await expect.poll(async () => addSel.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
  await page.getByTestId('wb-symbol').selectOption('518880');
  await page.getByTestId('wb-period').selectOption('M1');
  await addSel.selectOption({ index: 1 });
  await page.getByTestId('wb-add-btn').click();
  await expect(page.locator('[data-testid^="slot-card-"]').first()).toBeVisible();

  const rowsBefore = await page.locator('[data-testid^="wb-run-row-"]').count();
  console.log(`[N4④] 确认前 run 行数 = ${rowsBefore}`);

  // 全历史 M1（≥ 200k bar ⇒ 二次确认阈值）
  await page.getByTestId('wb-date-from').fill('2013-07-29');
  await page.getByTestId('wb-date-to').fill('2026-09-17');
  await page.getByTestId('wb-submit').click();
  const guard = page.getByTestId('wb-guard-prompt');
  await expect(guard).toBeVisible({ timeout: 120_000 });
  console.log(`[N4④] 二次确认文案 = ${(await guard.innerText()).replace(/\n/g, ' ')}`);
  await page.screenshot({ path: 'artifacts/04-guard-prompt.png' });

  await page.getByTestId('wb-guard-confirm').click();
  // 确认后：确认框隐藏 + 新 run 出现在历史（201 受理）
  await expect(guard).toBeHidden({ timeout: 60_000 });
  await expect
    .poll(async () => page.locator('[data-testid^="wb-run-row-"]').count(), { timeout: 120_000 })
    .toBeGreaterThan(rowsBefore);
  console.log(`[N4④] 确认后 run 行数 = ${await page.locator('[data-testid^="wb-run-row-"]').count()}`);
  await expect(page.getByTestId('wb-submit-error')).toBeHidden();
  await page.screenshot({ path: 'artifacts/05-guard-confirmed.png' });
});
