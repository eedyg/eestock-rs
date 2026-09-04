import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * 功能流（design/06-web/09-frontend「用例分层：功能流」）：页面① 行情看板。
 * ①选股 / 切周期 / 切分时 / 宫格切换 / 缩放→回到最新。
 *
 * 断言状态容忍：只断言「交互生效、视图切换成功、状态翻转」，不锁死数值。
 */

const bt = (page: import('@playwright/test').Page, name: string) =>
  page.locator('[data-region="toolbar"]').getByRole('button', { name, exact: true });

test.describe('页面① 行情看板功能流', () => {
  test('选股 + 切周期 + 切分时/回K线 + 宫格切换 + 缩放→回到最新', async ({ page }) => {
    await gotoPage(page, '/');

    // 等待标的表现（ready 态）—— 列表按钮出现
    const listButtons = page.locator('[data-region="symbol-list"] button');
    await expect(listButtons.first()).toBeVisible();
    const firstCode = (await listButtons.first().locator('b').first().innerText()).trim();

    // ① 选股：点击第二个标的，验证选中高亮（data-selected=true）
    await listButtons.nth(1).click();
    await expect(page.locator('[data-region="symbol-list"] button[data-selected="true"]')).toHaveCount(1);
    const selectedCode = (
      await page.locator('[data-region="symbol-list"] button[data-selected="true"] b').first().innerText()
    ).trim();
    expect(selectedCode.length).toBeGreaterThan(0);

    // ② 切周期：默认 15m → 5m；aria-pressed 跟随
    expect(await bt(page, '15m').getAttribute('aria-pressed')).toBe('true');
    await bt(page, '5m').click();
    await expect(bt(page, '5m')).toHaveAttribute('aria-pressed', 'true');

    // ③ 切分时 → 回 K线
    await bt(page, '分时').click();
    await expect(bt(page, '分时')).toHaveAttribute('aria-pressed', 'true');
    await bt(page, 'K线').click();
    await expect(bt(page, 'K线')).toHaveAttribute('aria-pressed', 'true');

    // ④ 宫格切换：单图 → 2×2 → 2×3 → 单图
    await bt(page, '2×2').click();
    await expect(page.locator('[data-region="grid-view"]')).toBeVisible();
    await bt(page, '2×3').click();
    await expect(page.locator('[data-region="grid-view"]')).toBeVisible();
    await bt(page, '单图').click();
    await expect(page.locator('[data-region="main-chart"]')).toBeVisible();

    // 回到最新按钮初始为禁用（followLatest=true）
    const backBtn = page.locator('[data-region="toolbar"]').getByRole('button', { name: '回到最新' });
    await expect(backBtn).toBeDisabled();

    // ⑤ 缩放→回到最新：对图表滚轮触发 onScroll/onZoom → followLatest=false → 按钮可用
    const chart = page.locator('[data-testid="kline-chart"]');
    await chart.hover();
    await page.mouse.wheel(0, 300);
    // 若滚轮被识别为人工平移/缩放，按钮应解除禁用
    try {
      await expect(backBtn).toBeEnabled({ timeout: 3000 });
    } catch {
      // 某些版本滚轮未触发 onScroll；改用 Ctrl+滚轮强制 zoom 动作
      await chart.hover();
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -300);
      await page.keyboard.up('Control');
      await expect(backBtn).toBeEnabled({ timeout: 3000 });
    }
    // 点击回到最新 → 恢复禁用
    await backBtn.click();
    await expect(backBtn).toBeDisabled();
  });
});
