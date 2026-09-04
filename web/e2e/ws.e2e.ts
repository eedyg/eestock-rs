import { expect, test } from '@playwright/test';
import { gotoPage } from './helpers/pages';

/**
 * WS 实时断言（design/06-web/09-frontend「用例分层：WS 实时断言」）。
 *
 * 背景：应用面 WS 推送源是 Poller 短周期（ws_poll_ms=3000）轮询库增量，只在
 * **数据前进**（新 bar  / quote 快照前进 / health last_event_ts 前进）时推帧。
 * 因此帧到达与否与市场状态强相关：盘中实时推送，非交易时段零增量则零帧。
 * （决策日志 D5：非交易时段零事件是既定行为。）
 *
 * 断言口径（**状态容忍**）：
 * 1. 确定性：页面连接 /ws 并发出 subscribe 帧（quote / health / bar）——证明
 *    前端订阅管线本身工作。
 * 2. 确定性：TopBar 的 WS 状态达到 open（不显示「WS 连接中/断开」pill）。
 * 3. 状态容忍：在 ≥3 个 poller 节拍窗口内若收到帧，逐一校验为合法类型
 *    （bar/quote/health/alert）；若因收盘/无增量收不到帧，记录诊断并通过
 *    （此为设计内豁免，见 coder/report/014 已知豁免）。
 */

function typeOf(s: string): string | null {
  try {
    const m = JSON.parse(s) as { type?: string };
    return m.type ?? null;
  } catch {
    return null;
  }
}

test.describe('WS 实时断言（连接+订阅确定性，帧接收状态容忍）', () => {
  test('页面连接 /ws 并订阅 quote/health/bar，收到帧则校验类型', async ({ page }) => {
    const sent: string[] = [];
    const received: string[] = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (f) => sent.push(String(f.payload)));
      ws.on('framereceived', (f) => received.push(String(f.payload)));
    });

    await gotoPage(page, '/');

    // ① 确定：客户端发出 subscribe 帧
    await expect.poll(() => sent.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const subscribeFrames = sent.filter((s) => s.includes('"subscribe"'));
    expect(subscribeFrames.length).toBeGreaterThan(0);
    const topics = subscribeFrames
      .map((s) => {
        try {
          return (JSON.parse(s) as { topic?: string }).topic;
        } catch {
          return null;
        }
      })
      .filter((t): t is string => typeof t === 'string');
    expect(topics).toContain('quote');
    expect(topics).toContain('health');
    expect(topics.some((t) => t === 'bar')).toBeTruthy();

    // ② 确定：TopBar WS 状态到 open（无连接/断开 pill）
    const wsPill = page.locator('header[data-region="topbar"]', { hasText: /WS 连接中|WS 断开/ });
    await expect(wsPill).toHaveCount(0, { timeout: 15_000 });

    // ③ 状态容忍：覆盖 ≥3 个 poller 节拍（3s×3=9s+余量），收帧则校验类型
    await page.waitForTimeout(10_000);
    const types = received.map(typeOf).filter((t): t is string => typeof t === 'string');
    if (types.length > 0) {
      for (const t of types) {
        expect(['bar', 'quote', 'health', 'alert']).toContain(t);
      }
    } else {
      // 收盘/无增量 → 无帧：不做断言（设计内豁免），打印诊断供报告引用
      console.warn(
        'WS: 观察窗口无帧（非交易时段/无增量）——连接+订阅已确定性验证；帧到达为状态容忍。',
      );
    }
  });
});
