import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * 数据成功断言（堵弱断言漏洞，2026-09-04 走查修复）：
 * 每页关键区域断言「真实数据渲染」且「页面无错误横幅」。
 * 不沿用「仅骨架在/仅 data-region 齐」的弱断言：等骨架消失 + 无「加载失败」文案 + 关键数据指示器存在。
 *
 * 状态容忍：交易日价格/时间在变，不锁死具体数值；只断言「真实数据已渲染（非骨架/非错误）」。空态（如
 * quality 的「该范围无比对数据」、alerts 的「暂无告警」）属正常无数据态，不算错误，予以容忍。
 */

/** 骨架（animate-pulse）消失：页面从「加载中」进入稳定态（真实内容或空态占位） */
async function waitNoSkeleton(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 20_000 });
}

/** 无错误横幅/「加载失败」文案（任一区域加载失败即报错） */
async function expectNoErrorBanner(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByText(/加载失败/)).toHaveCount(0, { timeout: 15_000 });
}

test.describe('数据成功断言：真实数据渲染 + 无错误横幅', () => {
  test('①行情：标的列表渲染真实代码+最新价', async ({ page }) => {
    await gotoPage(page, '/');
    await waitNoSkeleton(page);
    await expectNoErrorBanner(page);
    const list = page.locator('[data-region="symbol-list"]');
    await expect(list).toBeVisible();
    // 至少一只标的（真实代码 + 价格数据非骨架）
    await expect(list.locator('.num').first()).toHaveText(/\d{6}/, { timeout: 15_000 });
  });

  test('②数据源：源卡 + 缺口摘要标的 + 告警预览计数', async ({ page }) => {
    await gotoPage(page, '/sources');
    await waitNoSkeleton(page);
    await expectNoErrorBanner(page);
    // 源健康卡片（每源一卡，data-source 锚点）
    await expect(page.locator('[data-region="source-cards"] [data-source]').first()).toBeVisible();
    // 缺口摘要标的选择器（复用 symbols 列表，真实数据）
    const sel = page.locator('[data-testid="gap-symbol-select"]');
    await expect(sel).toBeVisible();
    // 告警预览计数头部（最近 N 条告警，真实渲染而非骨架）
    const count = page.locator('[data-testid="alert-preview-count"]');
    await expect(count).toBeVisible();
    await expect(count).toHaveText(/最近\s*\d+\s*条告警/);
  });

  test('③标的：标的表渲染真实数据行', async ({ page }) => {
    await gotoPage(page, '/symbols');
    await waitNoSkeleton(page);
    await expectNoErrorBanner(page);
    // 标的表有数据行 或 未注册空态（非错误）
    const rows = page.locator('[data-region="symbol-table"] table tbody tr');
    const empty = page.locator('[data-region="symbol-table"]', { hasText: '未注册标的' });
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 15_000 });
  });

  test('④质量：分歧表（真实行或空态）且无错误横幅', async ({ page }) => {
    await gotoPage(page, '/quality');
    await waitNoSkeleton(page);
    await expectNoErrorBanner(page);
    // 分歧表：真实行 或 无比对数据空态（accurate 未同步属正常，非错误）
    const rows = page.locator('[data-testid="divergence-rows"]');
    const empty = page.locator('[data-region="divergence-table"]', {
      hasText: '该范围无比对数据',
    });
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 15_000 });
    // 图形：一致率卡有真实数据（accuracy-cards 至少一卡）
    await expect(page.locator('[data-region="accuracy-cards"]').first()).toBeVisible();
  });

  test('⑦告警：告警列表（真实行或暂无告警空态）且无错误横幅', async ({ page }) => {
    await gotoPage(page, '/alerts');
    await waitNoSkeleton(page);
    await expectNoErrorBanner(page);
    // AlertList 行容器（class 含 mb-1.5）
    const rows = page.locator('[data-region="alert-list"] [class*="mb-1.5"]');
    const empty = page.locator('[data-region="alert-list"]', { hasText: '暂无告警' });
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 15_000 });
  });
});
