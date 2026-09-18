import { test, expect } from '@playwright/test';

/**
 * ADR-024 P5 整改 **N4 真渲染**（解锁后）：
 * 真浏览器 + 真二实例（临时库）+ **生产构建 SPA**（app 托管 ./web/dist，非 vite dev）。
 *
 * 解锁结论（见报告 N4）：vite dev 下 `StrictMode` 的 mount→unmount→mount 会 dispose 掉
 * memo 化的 `WorkbenchStore`，而 `dispose()` 单向置 `disposed=true` ⇒ 之后所有 patch 被丢弃
 * ⇒ catalog 恒 `加载中…`（实测：网络 200 但下拉仍空，阻塞 UI 提交）。故真渲染改走生产构建
 * （无 StrictMode 双调用），并配 `fixture.sh` 保证 catalog 有条目（临时库最小夹具）。
 *
 * 覆盖（按 `03-test-plan.md` §5 #2「禁止以 jsdom 替代前端验收」）：
 * ① 日期控件 min/max + 可用区间文案随标的/周期联动；
 * ② **结构化错误按 `code` 渲染**（`range_empty` → 「该标的该周期无数据（可用区间：…）」）；
 * ③ `clamped` 提示条；
 * ④ `resource_guard` 二次确认 → 确认后重提 → 201 + 提示条。
 */
test('P5 真渲染：可用区间联动 + 结构化错误按 code + clamped 提示条 + resource_guard 二次确认', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[N4] pageerror:', e.message));

  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();

  // ① 下拉必须加载完成（catalog 条目 > 1 = 占位 + 真实版本）
  const addSel = page.getByTestId('wb-add-strategy');
  await expect.poll(async () => addSel.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
  console.log('[N4] 策略下拉 option 数 =', await addSel.locator('option').count());

  // ① 标的 + 周期 ⇒ 日期控件 min/max + 可用区间文案
  await page.getByTestId('wb-symbol').selectOption('518880');
  await page.getByTestId('wb-period').selectOption('M1');
  await expect(page.getByTestId('wb-date-from')).toHaveAttribute('min', '2013-07-29');
  const availText = await page.getByTestId('wb-available-range').innerText();
  console.log('[N4] 可用区间文案 =', availText);
  expect(availText).toContain('可用区间');
  await page.screenshot({ path: 'pw-artifacts/01-available-range.png' });

  // slot（真实 published 版本）
  await addSel.selectOption({ index: 1 });
  await page.getByTestId('wb-add-btn').click();
  await expect(page.locator('[data-testid^="slot-card-"]').first()).toBeVisible();

  // ② 结构化错误**按 code 渲染**：区间早于数据起点 ⇒ range_empty（code → 中文提示）
  await page.getByTestId('wb-date-from').fill('2010-01-01');
  await page.getByTestId('wb-date-to').fill('2010-02-01');
  await page.getByTestId('wb-submit').click();
  const errBox = page.getByTestId('wb-submit-error');
  await expect(errBox).toBeVisible({ timeout: 30_000 });
  const errText = await errBox.innerText();
  console.log('[N4] range_empty 渲染文案 =', errText);
  expect(errText, 'code=range_empty ⇒ 前端码映射文案').toContain('无数据');
  expect(errText, 'code 映射须回显可用区间').toContain('可用区间');
  await page.screenshot({ path: 'pw-artifacts/02-range-empty-by-code.png' });

  // ③ clamped 提示条（左端早于可得区间、右端短 ⇒ 不触护栏）
  await page.getByTestId('wb-date-from').fill('2013-01-01');
  await page.getByTestId('wb-date-to').fill('2013-08-05');
  await page.getByTestId('wb-submit').click();
  const clamp = page.getByTestId('wb-clamp-notice');
  await expect(clamp).toBeVisible({ timeout: 60_000 });
  const clampText = await clamp.innerText();
  console.log('[N4] clamped 提示条 =', clampText);
  expect(clampText).toContain('收缩');
  await page.screenshot({ path: 'pw-artifacts/03-clamp-notice.png' });

  // ④ 资源护栏二次确认：全历史 M1（≈77 万 bar ≥ 20 万阈值）
  await page.getByTestId('wb-date-from').fill('2013-01-04');
  await page.getByTestId('wb-date-to').fill('2026-09-17');
  await page.getByTestId('wb-submit').click();
  const prompt = page.getByTestId('wb-guard-prompt');
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  const promptText = await prompt.innerText();
  console.log('[N4] resource_guard 二次确认 =', promptText);
  expect(promptText).toContain('预估');
  await page.screenshot({ path: 'pw-artifacts/04-guard-prompt.png' });

  // 确认 → 带 confirm=true 重提 ⇒ 201 + clamped 提示条（不弹确认框）
  await page.getByTestId('wb-guard-confirm').click();
  await expect(prompt).toBeHidden({ timeout: 180_000 });
  // 提示条必须**刷新为新 run 的收缩范围**（不得停留在上一步的陈旧文案：`clampText`）
  await expect
    .poll(async () => (await clamp.innerText()) !== clampText, { timeout: 180_000 })
    .toBe(true);
  const clampText2 = await clamp.innerText();
  expect(clampText2, '新 run 的收缩范围（≈2026-09-16）').toMatch(/2026-09-\d\d/);
  console.log('[N4] 确认后 clamped 提示条 =', clampText2);
  expect(clampText2).toContain('收缩');
  // 新 run 已入库并出现在运行历史（201 的 UI 副作用）
  const runRow = page.locator('[data-testid^="wb-run-row-"]').first();
  await expect(runRow).toBeVisible({ timeout: 60_000 });
  console.log('[N4] 新 run 行 =', (await runRow.innerText()).replace(/\n/g, ' | '));
  await page.screenshot({ path: 'pw-artifacts/05-guard-confirmed-clamp.png' });
});
