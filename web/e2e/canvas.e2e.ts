import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * canvas 像素断言（design/06-web/09-frontend「用例分层：canvas 像素断言」）。
 *
 * klinecharts 真实渲染到 canvas；jsdom/Vitest 桩无法证明。本用例直接读取
 * 主图 canvas 的 `toDataURL`/getImageData，抽样验证**非空白**（多个非背景色），
 * 证明 klinecharts 在真实浏览器真实画了 K 线，而非 jsdom 桩或空白容器。
 *
 * 状态容忍：只断言「有像素内容」，不锁死颜色/数值。
 */
test.describe('canvas 渲染断言（klinecharts 真实绘制）', () => {
  test('主图 canvas 渲染非空白', async ({ page }) => {
    await gotoPage(page, '/');
    const chart = page.locator('[data-testid="kline-chart"]');
    await expect(chart).toBeVisible();
    await expect(chart.locator('canvas').first()).toBeVisible();

    // 采样 canvas 像素：统计非「背景主色」像素占比；空白图（单色）占比≈0。
    // 看板 KlineChart 容器存在 `h-[125%]` 布局缺陷（见 coder/report/014），canvas 高
    // 可能被解析为异常大；故 getImageData 只采样**有界顶部区域**（min(h, 900) 行），
    // 避免对大尺寸 canvas 全量读取；klinecharts 内容绘于顶部区域。
    const res = await page.evaluate(() => {
      const canvases = Array.from(
        document.querySelectorAll<HTMLCanvasElement>('[data-testid="kline-chart"] canvas'),
      );
      const out: Array<{ w: number; h: number; distinct: number; dataLen: number }> = [];
      for (const c of canvases) {
        if (c.width === 0 || c.height === 0) {
          out.push({ w: c.width, h: c.height, distinct: 0, dataLen: 0 });
          continue;
        }
        const ctx = c.getContext('2d');
        if (!ctx) continue;
        const { width, height } = c;
        try {
          const sampleH = Math.min(height, 900);
          const img = ctx.getImageData(0, 0, width, sampleH).data;
          const colors = new Set<string>();
          for (let y = 0; y < sampleH; y += 8) {
            for (let x = 0; x < width; x += 8) {
              const i = (y * width + x) * 4;
              const k = `${img[i]},${img[i + 1]},${img[i + 2]},${img[i + 3]}`;
              colors.add(k);
            }
          }
          const dataLen = c.toDataURL('image/png').length;
          out.push({ w: width, h: sampleH, distinct: colors.size, dataLen });
        } catch {
          // 超大 canvas 读取失败：用 toDataURL 长度作为内容证据
          const dataLen = c.toDataURL('image/png').length;
          out.push({ w: width, h: height, distinct: 0, dataLen });
        }
      }
      return out;
    });

    const nonBlank = res.some(
      (r) => (r.w > 0 && r.h > 0 && r.distinct > 1 && r.dataLen > 500) || r.dataLen > 5_000,
    );
    expect(nonBlank).toBeTruthy();
  });
});
