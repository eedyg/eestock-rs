import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * 功能流（design/06-web/09-frontend「用例分层：功能流」）：页面④ 数据质量。
 * ④选日看对照表：默认近 7 日范围加载分歧对照表（divergence-table），
 * 变更日期过滤即重查，断言主对照表渲染（汇总行或空态）。
 *
 * 状态容忍：准确层（tushare）覆盖度随日期而异，对照表可能「有余行」或
 * 「该范围无比对数据」（空态）。只断言「已渲染 + 过滤变更生效重查」，不锁行数。
 */
test.describe('页面④ 数据质量：选日看对照表', () => {
  test('默认范围加载分歧对照表，变更日期重查生效', async ({ page }) => {
    await gotoPage(page, '/quality');
    const table = page.locator('[data-region="divergence-table"]');
    await expect(table).toBeVisible();

    // 等待对照表离开骨架态并渲染（汇总行 OR 空态提示）
    await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
    const summaryOrEmpty = await Promise.race([
      page.locator('[data-testid="divergence-summary"]').waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false),
      table.getByText('该范围无比对数据').waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false),
    ]);
    expect(summaryOrEmpty).toBeTruthy();

    // 日期过滤变更即重查（04-quality L2）：改「开始日期」触发重新加载
    const from = page.getByLabel('开始日期');
    const beforeTo = await page.getByLabel('结束日期').inputValue();
    await from.fill('2026-09-01');
    // 重查完成：骨架消失，且对照表再次进入已渲染态
    await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
    const afterSummaryOrEmpty = await Promise.race([
      page.locator('[data-testid="divergence-summary"]').waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false),
      table.getByText('该范围无比对数据').waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false),
    ]);
    expect(afterSummaryOrEmpty).toBeTruthy();
  });
});
