import { expect, test } from '@playwright/test';
import { gotoPage, region } from './helpers/pages';

/**
 * 策略管理主流程（12-strategy-system / P2b）：列表 → 编辑器 → 试算。
 * 断言状态容忍（真容器上策略集随播种/历史操作变化）：只锁「页面起来、骨架锚点齐、主流程可点通」，
 * 不锁策略数量/版本号等动态数据。
 */

test.describe('策略管理主流程（列表 → 编辑 → 试算）', () => {
  test('列表页 /strategies 加载且过滤栏/表格锚点齐', async ({ page }) => {
    await gotoPage(page, '/strategies');
    await expect(region(page, 'strategies')).toBeVisible();
    await expect(region(page, 'strategy-filter')).toBeVisible();
    // 表格或空态/错误态其一出现（数据态容忍）
    await expect(
      page.getByTestId('strategy-table').or(page.getByTestId('strategy-list-empty')).or(page.getByTestId('strategy-list-error')),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('create-strategy-btn')).toBeVisible();
    // at-least 语义文案注明
    await expect(page.getByTestId('filter-approval-note')).toContainText('at-least');
  });

  test('新建策略（空白）→ 进入编辑器 → 骨架齐备', async ({ page }) => {
    await gotoPage(page, '/strategies');
    await page.getByTestId('create-strategy-btn').click();
    await page.getByTestId('create-name').fill(`e2e策略${Date.now() % 100000}`);
    await page.getByTestId('create-submit').click();
    // 创建后跳转编辑器
    await page.waitForURL(/\/strategies\/[^/]+\/edit$/, { timeout: 15_000 });
    await expect(region(page, 'strategy-editor')).toBeVisible();
    await expect(page.getByTestId('version-select')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('status-badge')).toContainText('草稿');
    // 右侧 Tab 栏：试算/参数/文档/Diff
    for (const t of ['tab-test', 'tab-params', 'tab-doc', 'tab-diff']) {
      await expect(page.getByTestId(t)).toBeVisible();
    }
  });

  test('编辑器试算面板：填表单运行 → 结果区出现（评分曲线或错误提示，容忍数据面状态）', async ({ page }) => {
    await gotoPage(page, '/strategies');
    // 进入第一个策略的编辑器（无策略则先建一个）
    const editLink = page.getByTestId('edit-link').first();
    if (await editLink.count().then((n) => n === 0)) {
      await page.getByTestId('create-strategy-btn').click();
      await page.getByTestId('create-name').fill(`e2e试算${Date.now() % 100000}`);
      await page.getByTestId('create-submit').click();
      await page.waitForURL(/\/strategies\/[^/]+\/edit$/, { timeout: 15_000 });
    } else {
      await editLink.click();
      await page.waitForURL(/\/strategies\/[^/]+\/edit$/, { timeout: 15_000 });
    }
    await expect(page.getByTestId('tab-test')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('tab-test').click();
    await expect(page.getByTestId('testrun-panel')).toBeVisible();
    await page.getByTestId('tr-symbol').fill('518880');
    await page.getByTestId('tr-run').click();
    // 结果区或错误提示其一出现（真容器依赖 kline 数据面，容忍 400 区间/无数据）
    await expect(
      page.getByTestId('tr-result').or(page.getByTestId('tr-run-error')).or(page.getByTestId('tr-form-error')),
    ).toBeVisible({ timeout: 30_000 });
  });
});
