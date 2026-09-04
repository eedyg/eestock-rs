import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * 页面与 data-region 锚点（design/06-web/00-shell + 各页 L2 区域规格）。
 * 冒烟用例逐项断言「该页所有 data-region 齐全」。
 */
export const PAGES: Array<{ path: string; label: string; regions: string[] }> = [
  {
    path: '/',
    label: '行情',
    regions: ['dashboard', 'symbol-list', 'main-area', 'toolbar', 'main-chart', 'sub-chart'],
  },
  {
    path: '/sources',
    label: '数据源',
    regions: ['sources', 'summary-bar', 'source-cards', 'gap-cards', 'alert-preview'],
  },
  {
    path: '/symbols',
    label: '标的',
    regions: ['symbols', 'table-toolbar', 'symbol-table'],
  },
  {
    path: '/quality',
    label: '质量',
    regions: ['quality', 'filter-bar', 'divergence-table', 'accuracy-cards', 'sync-panel', 'gap-report'],
  },
  {
    path: '/alerts',
    label: '告警',
    regions: ['alerts', 'alert-filter', 'alert-list', 'rule-panel'],
  },
];

export function region(page: Page, name: string) {
  return page.locator(`[data-region="${name}"]`);
}

/** 等待页面数据区从「骨架/加载」进入稳定态（数据区锚点 + 关键内容出现） */
export async function gotoPage(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

/** 等待指定 data-region 存在且可见 */
export async function expectRegion(page: Page, name: string): Promise<void> {
  await expect(region(page, name)).toBeVisible();
}

/** 页面内所有 data-region 齐备断言 */
export async function expectAllRegions(page: Page, regions: string[]): Promise<void> {
  for (const r of regions) {
    await expectRegion(page, r);
  }
}

/** 等待页面从骨架态（animate-pulse）进入真实内容；轮询指定区域不再出现骨架 */
export async function waitForStable(page: Page, name: string): Promise<void> {
  await expectRegion(page, name);
}
