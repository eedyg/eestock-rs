import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, gotoPage } from './helpers/pages';

/**
 * 截图走查产物（design/06-web/09-frontend「截图走查门槛」）。
 *
 * 全量跑后把 5 页全尺寸截图输出到 `design/06-web/preview/real-<page>.png` ，
 * 供用户过目——替代静态样机评审（用户点头页面才交付）。
 *
 * 与视觉回归基线（visual.e2e.ts）的区别：本文件输出**真实数据、无 mask** 的
 * 全尺寸成品截图，作为人工走查产物，不做像素断言（始终通过）。
 */

const PREVIEW_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../design/06-web/preview');

const keyOfPath: Record<string, string> = {
  '/': 'dashboard',
  '/sources': 'sources',
  '/symbols': 'symbols',
  '/quality': 'quality',
  '/alerts': 'alerts',
};

// 页面①看板 KlineChart 容器 `h-[125%]` 布局缺陷致 scroll 高度爆炸（42MB canvas），
// fullPage 截图无法达到稳定取帧（见 coder/report/014）；走查产物对看板用视口截图。
const FULL_PAGE_BY_KEY: Record<string, boolean> = {
  dashboard: false,
  sources: true,
  symbols: true,
  quality: true,
  alerts: true,
};

test.describe('截图走查产物 → design/06-web/preview/real-<page>.png', () => {
  for (const p of PAGES) {
    test(`走查截图 ${p.label}（${p.path}）`, async ({ page }) => {
      await gotoPage(page, p.path);
      // 等数据加载（骨架消失）再截图，产物为真实内容
      await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 20_000 });
      mkdirSync(PREVIEW_DIR, { recursive: true });
      const file = resolve(PREVIEW_DIR, `real-${keyOfPath[p.path]}.png`);
      await page.screenshot({ path: file, fullPage: FULL_PAGE_BY_KEY[keyOfPath[p.path]!] });
      // 产物存在即通过
      const { stat } = await import('node:fs/promises');
      const st = await stat(file);
      expect(st.size).toBeGreaterThan(0);
    });
  }
});
