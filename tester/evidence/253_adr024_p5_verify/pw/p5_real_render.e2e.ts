import { test, expect } from '@playwright/test';

/** ADR-024 P5 真渲染（tester 独立验收）：真实浏览器 + 真实第二实例（临时库）+ vite dev（proxy /api）。 */
test('P5 真渲染：available_range 联动 min/max + clamped 提示条 + resource_guard 二次确认', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('response', (r) => { if (r.url().includes('/api/workbench/available_range')) apiCalls.push(r.url()); });

  const apiLog: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/strategies')) apiLog.push(`${r.status()} ${r.url()} ${(await r.text()).slice(0, 120)}`);
  });
  page.on('console', (m) => { if (m.type() === 'error') apiLog.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => apiLog.push(`pageerror: ${e.message}`));
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();

  // 标的 + 周期切换 ⇒ 日期控件 min/max 随 available_range 联动
  await page.getByTestId('wb-symbol').selectOption('518880');
  await page.getByTestId('wb-period').selectOption('M1');
  await expect(page.getByTestId('wb-date-from')).toHaveAttribute('min', '2013-07-29');
  await expect(page.getByTestId('wb-date-from')).toHaveAttribute('max', '2026-09-17');
  await expect(page.getByTestId('wb-available-range')).toContainText('2013-07-29');
  console.log('[真渲染] available_range 请求=', JSON.stringify(apiCalls));
  console.log('[真渲染] 可用区间文案=', await page.getByTestId('wb-available-range').innerText());
  await page.screenshot({ path: 'pw-artifacts/01-available-range.png', fullPage: false });

  // 切周期（M15）应重新拉取（联动）
  const n0 = apiCalls.length;
  await page.getByTestId('wb-period').selectOption('M15');
  await expect.poll(() => apiCalls.length).toBeGreaterThan(n0);
  console.log('[真渲染] 切 M15 后 available_range 文案=', await page.getByTestId('wb-available-range').innerText());

  // 回 M1，加一个 slot（真库 published 策略）
  await page.getByTestId('wb-period').selectOption('M1');
  const addSel = page.getByTestId('wb-add-strategy');
  console.log('[真渲染] /api/strategies 响应=', JSON.stringify(apiLog).slice(0, 300));
  console.log('[真渲染] select outerHTML=', (await addSel.evaluate((el) => el.outerHTML)).slice(0, 400));
  console.log('[真渲染] catalogError/页首文案=', (await page.getByTestId('wb-config').innerText()).slice(0, 300));
  await expect.poll(async () => addSel.locator('option').count(), { timeout: 20_000 }).toBeGreaterThan(1);
  const opts = await addSel.locator('option').count();
  console.log('[真渲染] 策略下拉 option 数=', opts);
  await addSel.selectOption({ index: 1 });
  await expect(page.getByTestId('wb-add-btn')).toBeEnabled();
  await page.getByTestId('wb-add-btn').click();
  await expect(page.locator('[data-testid^="slot-card-"]').first()).toBeVisible();

  // 左端早于可得区间 ⇒ 提交后应 clamped（旧日历档已删，不按天数拒绝）
  await page.getByTestId('wb-date-from').fill('2013-01-04');
  await page.getByTestId('wb-date-to').fill('2026-09-17');
  await page.getByTestId('wb-submit').click();

  // 全历史 M1（77 万 bar）⇒ 资源护栏二次确认（过渡期流程）
  await expect(page.getByTestId('wb-guard-prompt')).toBeVisible({ timeout: 30_000 });
  console.log('[真渲染] guard prompt=', await page.getByTestId('wb-guard-prompt').innerText());
  await page.screenshot({ path: 'pw-artifacts/02-guard-prompt.png' });
  await page.getByTestId('wb-guard-confirm').click();

  // 确认后重提 ⇒ 201 + clamped=true ⇒ 显著提示条（不弹确认框）
  await expect(page.getByTestId('wb-clamp-notice')).toBeVisible({ timeout: 30_000 });
  console.log('[真渲染] clamp notice=', await page.getByTestId('wb-clamp-notice').innerText());
  await page.screenshot({ path: 'pw-artifacts/03-clamp-notice.png' });
  await expect(page.getByTestId('wb-clamp-notice')).toContainText('收缩');
});
