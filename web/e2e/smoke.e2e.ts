import { expect, test } from '@playwright/test';
import { PAGES, expectAllRegions, gotoPage } from './helpers/pages';

/**
 * 冒烟层（design/06-web/09-frontend「用例分层：全页冒烟」）：
 * ① / ② / ③ / ④ / ⑦ 五页全加载 + 各页 data-region 齐 + 未知路由 404（SPA 回退）
 * + 深链直达。
 *
 * 断言状态容忍：只测「页面起来了、区域齐了、路由对了」，不锁动态数值。
 */

test.describe('冒烟：五页全加载 + data-region 齐全', () => {
  for (const p of PAGES) {
    test(`页面 ${p.label}（${p.path}）加载且 data-region 齐`, async ({ page }) => {
      await gotoPage(page, p.path);
      await expectAllRegions(page, p.regions);
      // 面包屑/标题在（顶栏存在即骨架起来了）
      await expect(page.locator('[data-region="topbar"]')).toBeVisible();
    });
  }
});

test.describe('冒烟：未知路由 SPA 回退', () => {
  test('访问不存在路由回落到首页 /', async ({ page }) => {
    await page.goto('/no-such-route', { waitUntil: 'domcontentloaded' });
    // 前端 catch-all（App.tsx `*` → Navigate to "/"）兜底到行情看板
    await page.waitForURL(/\/$/);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-region="dashboard"]')).toBeVisible();
  });

  test('访问置灰项路由（无路由）回落首页', async ({ page }) => {
    await page.goto('/backtest', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/$/);
    await expect(page.locator('[data-region="dashboard"]')).toBeVisible();
    // 置灰导航不可点击（disabled nav 项无 <a> 链接）
    const link = page.locator('nav li', { hasText: '⑥ 交易面板' }).locator('a');
    await expect(link).toHaveCount(0);
  });
});

test.describe('冒烟：深链直达（直接刷新/新开直达子路由）', () => {
  for (const p of PAGES.slice(1)) {
    test(`深链直达 ${p.label}（${p.path}）`, async ({ page }) => {
      await gotoPage(page, p.path);
      await expectAllRegions(page, p.regions);
      await expect(page).toHaveURL(new RegExp(`${p.path}$`));
    });
  }
});
