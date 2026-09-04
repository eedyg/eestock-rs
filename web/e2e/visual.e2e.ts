import { expect, test } from '@playwright/test';
import { PAGES, gotoPage } from './helpers/pages';
import { shotOptions, type PageKey } from './helpers/masks';

/**
 * 视觉回归基线（design/06-web/09-frontend「视觉回归基线」）。
 *
 * ⚠️ 基线在**数据动态区是故意剔除**的：交易日价格/时间戳/图内数据坐标在持续变化，
 * 若锁死会造成分钟级噪声持续误报。因此本套基线只对**稳定结构**（导航/工具栏/
 * 页面布局/配色/data-region 区域框）做像素回归，而对易变**数据区**用 `mask` 屏蔽
 * （见 helpers/masks.ts 的 MASKS_BY_PAGE 与坐标说明）。
 *
 * 重基线：仅在**有意的 UI 变更**后人工执行 `npm run e2e:update`。盘中动态数据变化
 * 不属需要重基线的变更（被 mask 剔除，设计内豁免）。
 */

const keyOfPath: Record<string, PageKey> = {
  '/': 'dashboard',
  '/sources': 'sources',
  '/symbols': 'symbols',
  '/quality': 'quality',
  '/alerts': 'alerts',
};

// 页面①行情看板的 KlineChart 容器 `h-[125%]` 在 flex-1 父级下解析为 ~33M px（布局缺陷，
// 见 coder/report/014 产品缺陷），导致 document 滚动高度爆炸、fullPage 截图无法稳定取帧。
// 故行情页基线用**视口截图**（fullPage:false，锁定视口内稳定结构）；其余 4 页全尺寸。
const FULL_PAGE_BY_KEY: Record<PageKey, boolean> = {
  dashboard: false,
  sources: true,
  symbols: true,
  quality: true,
  alerts: true,
};

test.describe('视觉回归基线（mask 动态数据区，只锁稳定结构）', () => {
  for (const p of PAGES) {
    test(`视觉基线 ${p.label}（${p.path}）`, async ({ page }) => {
      await gotoPage(page, p.path);
      // 等数据区离开骨架态，再截图（基线以「已渲染稳定结构」为基准）
      await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 20_000 });
      const opts = shotOptions(page, keyOfPath[p.path]!);
      // 名称需带 .png：Playwright 由名称推导 {ext}（snapshotPathTemplate 依赖）
      await expect(page).toHaveScreenshot(`${keyOfPath[p.path]}-full.png`, {
        ...opts,
        fullPage: FULL_PAGE_BY_KEY[keyOfPath[p.path]!],
      });
    });
  }
});
