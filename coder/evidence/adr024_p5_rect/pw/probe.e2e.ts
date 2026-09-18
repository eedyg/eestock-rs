import { test, expect } from '@playwright/test';

test('probe: catalog 下拉从何而来', async ({ page }) => {
  const log: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/')) log.push(`RESP ${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => log.push(`FAIL ${r.url()} ${r.failure()?.errorText}`));
  page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') log.push(`CONSOLE ${m.text().slice(0,200)}`); });
  await page.goto('/backtest-workbench');
  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await page.waitForTimeout(5000);
  const sel = page.getByTestId('wb-add-strategy');
  console.log('SEL_DISABLED=', await sel.isDisabled());
  console.log('SEL_HTML=', (await sel.evaluate((el) => el.outerHTML)).slice(0, 500));
  console.log('OPTIONS=', await sel.locator('option').count());
  console.log('PANEL_TEXT=', (await page.getByTestId('wb-config').innerText()).slice(0, 400));
  console.log('CALLS=', JSON.stringify(log, null, 1));
});
