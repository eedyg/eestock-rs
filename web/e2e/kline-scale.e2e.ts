import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * K线图比例/稳定性缺陷修复回归（coder/report/018）。
 *
 * 背景：KlineChart 容器原为 `h-[125%]`，在 flex-1 父级下被解析为 ~2^25 px 高，
 * 导致 canvas 33M 高、K线巨比例只渲染左上小部分、document 滚动高度爆炸、
 * 浏览器卡顿后崩溃（详见 coder/report/014 §7.1 与 018 复现证据）。修复后容器
 * 改 `h-full` + 骨架 `min-h-0`，canvas 有界、比例正常。
 *
 * 旧 E2E 只做「单帧截图非空白」（canvas.e2e.ts），无法覆盖「运行期比例/稳定性」，
 * 故本 spec 补两类断言堵盲区：
 *  1) 比例断言：图表容器/ canvas 尺寸有界、整页滚动不爆炸、K线内容落在容器内合理占比；
 *  2) 稳定性断言：WS 实时注入（模拟真实推送频率）下持续运行 ≥60s，无崩溃、无 console
 *     错误、内存不无界增长、canvas 恒定有界。
 */

/** 在页面加载前注入 WS 拦截：捕获应用 /ws 订阅，并周期性注入 `{type:"bar"}` 帧模拟实时推送。 */
const WS_INJECT = `
(() => {
  const RealWS = window.WebSocket;
  window.__wsInject = { frameCount: 0, error: null, topics: [] };
  window.WebSocket = class extends RealWS {
    constructor(url, protocols) {
      super(url, protocols);
      this.__lastTs = Date.now();
      this.addEventListener('open', () => this.__start());
    }
    send(data) {
      try {
        const f = JSON.parse(data);
        if (f.type === 'subscribe') window.__wsInject.topics.push(f);
      } catch (_) {}
      return super.send(data);
    }
    __start() {
      // 等 feed 订阅建立后再注入（避免帧被丢弃）
      setTimeout(() => {
        this.__timer = setInterval(() => {
          try {
            const bar = window.__wsInject.topics.find((t) => t.topic === 'bar');
            if (!bar) return;
            this.__lastTs += 1000;
            const close = 1.7 + Math.random() * 0.12;
            const frame = {
              type: 'bar', code: bar.code, period: bar.period,
              bar: {
                ts: new Date(this.__lastTs).toISOString(),
                open: +(close - 0.004).toFixed(3),
                high: +(close + 0.006).toFixed(3),
                low: +(close - 0.008).toFixed(3),
                close: +close.toFixed(3),
                volume: Math.floor(Math.random() * 1200000),
                amount: Math.floor(Math.random() * 1200000),
              },
            };
            if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
            window.__wsInject.frameCount++;
          } catch (e) {
            window.__wsInject.error = String(e);
          }
        }, 500);
      }, 3000);
    }
  };
})();
`;

test.describe('K线图 比例/稳定性缺陷修复回归（coder/report/018）', () => {
  test('比例断言：图表容器/canvas 有界、整页滚动不爆炸、K线内容在容器内合理占比', async ({ page }) => {
    await gotoPage(page, '/');
    const chart = page.locator('[data-testid="kline-chart"]');
    await expect(chart).toBeVisible();
    await expect(chart.locator('canvas').first()).toBeVisible();
    // 等 klinecharts 完成初绘（真实 bar 渲染）
    await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(5000);

    const m = await page.evaluate(() => {
      const chartEl = document.querySelector('[data-testid="kline-chart"]');
      if (!chartEl) return null;
      const box = chartEl.getBoundingClientRect();
      const canvases = Array.from(chartEl.querySelectorAll('canvas'));
      const heights = canvases.map((c) => c.height).filter((h) => h > 0);
      const widths = canvases.map((c) => c.width).filter((w) => w > 0);
      // 主图（首个大 canvas）
      const main = canvases.find((c) => c.width > 200);
      let distinct = 0;
      let candle = { firstX: -1, lastX: -1, span: 0, plotW: 0, leftBlankPct: -1, fillPct: -1 };
      if (main) {
        try {
          const ctx = main.getContext('2d');
          const img = ctx.getImageData(0, 0, main.width, main.height).data;
          const set = new Set();
          // 横向铺满检测：只扫绘图区（剔除顶部图例 y<15%、底部轴 y>82%、右侧 y轴 x>88%），
          // 找蜡烛/均线内容（亮度 >90，避开网格/背景）的左右边界，断言无左侧死区且横向铺满
          const y0 = Math.floor(main.height * 0.15);
          const y1 = Math.floor(main.height * 0.82);
          const xMax = Math.floor(main.width * 0.88);
          let firstX = -1, lastX = -1;
          for (let y = 0; y < main.height; y += 6) {
            for (let x = 0; x < main.width; x += 6) {
              const i = (y * main.width + x) * 4;
              const r = img[i], g = img[i + 1], b = img[i + 2];
              set.add(`${r},${g},${b}`);
            }
          }
          for (let x = 0; x < xMax; x++) {
            let has = false;
            for (let y = y0; y < y1; y += 2) {
              const i = (y * main.width + x) * 4;
              const r = img[i], g = img[i + 1], b = img[i + 2];
              if (r > 90 || g > 90 || b > 90) {
                has = true;
                break;
              }
            }
            if (has) {
              if (firstX < 0) firstX = x;
              lastX = x;
            }
          }
          distinct = set.size;
          candle = {
            firstX,
            lastX,
            span: firstX >= 0 && lastX >= 0 ? lastX - firstX : 0,
            plotW: xMax,
            leftBlankPct: firstX >= 0 ? (firstX / xMax) * 100 : -1,
            fillPct: firstX >= 0 && lastX >= firstX ? ((lastX - firstX) / xMax) * 100 : -1,
          };
        } catch (e) {
          distinct = -1;
        }
      }
      return { chartW: box.width, chartH: box.height, docScrollH: document.documentElement.scrollHeight, maxCanvasH: heights.length ? Math.max(...heights) : 0, maxCanvasW: widths.length ? Math.max(...widths) : 0, distinct, candle, viewportH: window.innerHeight };
    });
    expect(m).not.toBeNull();

    // ① 容器有界：高度在视口内合理范围（修复前 ~33M px）
    expect(m!.chartH).toBeLessThan(m!.viewportH + 1); // 不超出视口
    expect(m!.chartH).toBeGreaterThan(200); // 也不是坍缩成 0
    // ② 整页滚动不爆炸（修复前 scrollHeight≈33M）
    expect(m!.docScrollH).toBeLessThan(2000);
    // ③ canvas 有界且与容器同量级（修复前 3.3k 万 px 高）
    expect(m!.maxCanvasH).toBeLessThan(m!.viewportH + 1);
    expect(m!.maxCanvasH).toBeGreaterThan(100);
    expect(m!.maxCanvasW).toBeLessThan(1200);
    // ④ K线内容落在容器内（非空白，多色）
    expect(m!.distinct).toBeGreaterThan(10);
    // ⑤ 横向铺满：蜡烛从左边缘开始（无左侧死区，修复前 ~48% 空白），且覆盖主绘图区 ≥80%
    expect(m!.candle.firstX).toBeGreaterThanOrEqual(0);
    expect(m!.candle.leftBlankPct).toBeLessThan(20);
    expect(m!.candle.fillPct).toBeGreaterThanOrEqual(80);
  });

  test('稳定性断言：WS 实时注入下持续 ≥60s 无崩溃/无 console 错误/canvas 恒定有界', async ({ page }) => {
    test.setTimeout(130_000);
    // 注入 WS 拦截 + 实时帧模拟（真实推送频率 ~2 帧/秒）
    await page.addInitScript(WS_INJECT);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await gotoPage(page, '/');
    const chart = page.locator('[data-testid="kline-chart"]');
    await expect(chart).toBeVisible();
    await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(4000);

    const RUN_MS = 60_000;
    const samples: Array<{ t: number; jsHeap: number; chartH: number; docH: number; canvasH: number; frameCount: number; markerSeen: boolean }> = [];
    let markerSeen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < RUN_MS) {
      await page.waitForTimeout(5000);
      const s = await page.evaluate(() => {
        const chartEl = document.querySelector('[data-testid="kline-chart"]');
        const box = chartEl?.getBoundingClientRect();
        const canvasH = Math.max(0, ...Array.from(chartEl?.querySelectorAll('canvas') ?? []).map((c) => c.height));
        return {
          jsHeap: performance.memory ? performance.memory.usedJSHeapSize : -1,
          chartH: box ? box.height : -1,
          docH: document.documentElement.scrollHeight,
          canvasH,
          frameCount: (window as any).__wsInject?.frameCount ?? -1,
          markerSeen: !!document.querySelector('[data-realtime-marker]'),
        };
      });
      if (s.markerSeen) markerSeen = true;
      samples.push({ t: ((Date.now() - t0) / 1000) | 0, ...s });
    }

    // 实时帧确实注入了（若后端当期无真实推送，注入兜底验证实时路径稳定性）
    const last = samples[samples.length - 1]!;
    expect(last.frameCount).toBeGreaterThan(0);
    // 实时进行中 bar 标记（虚线 + 闪烁）在实时推送下出现过（补定稿）
    expect(markerSeen).toBe(true);
    // 无崩溃：pageerror / console error 均抛错即失败
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    // canvas / 滚动高度全程有界（未回到 33M 巨高）
    for (const s of samples) {
      expect(s.canvasH).toBeLessThan(2000);
      expect(s.docH).toBeLessThan(2000);
      expect(s.chartH).toBeLessThan(2000);
    }
    // 内存不无界增长：任一采样不超阈值（修复前 33M canvas 会撑爆内存）
    if (samples.every((s) => s.jsHeap >= 0)) {
      const maxHeap = Math.max(...samples.map((s) => s.jsHeap));
      expect(maxHeap).toBeLessThan(350 * 1024 * 1024);
    }
  });
});
