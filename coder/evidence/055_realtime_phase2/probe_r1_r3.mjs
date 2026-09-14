/**
 * 阶段 2 真浏览器自测探针（只读；临时实例）。
 * 验证（诊断 055 R1/R3）：
 *  1. 初始加载：GET /api/kline（15m，limit=120，无 before）；
 *  2. **WS 半开自愈**：入站帧被丢弃（模拟半开：readyState 仍 OPEN、无 onclose）≥15s
 *     ⇒ 客户端主动 close + 既有退避重连（新 socket open + 重发 subscribe 帧）；
 *  3. **重连后 HTTP 增量补偿**：重连成功后出现一次 limit=5、无 before 的最新窗口拉取；
 *  4. **每分钟兜底**：页面停留 ≥70s 时出现 limit=5、无 before 的拉取（60s 节奏）；
 *  5. **稳态不空转**：末段观察窗内 WS 重连次数为 0（阈值已按实测节奏校准）；
 *  6. 全程无 console error / pageerror。
 *
 * 用法：node <此文件> <baseUrl> [steadyWindowSeconds]
 */
import { createRequire } from 'node:module';
// 依赖按仓库 web/ 解析（探针脚本放在 coder/evidence 下，不引入新依赖）
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/');
const { chromium } = require('@playwright/test');

const BASE = process.argv[2] ?? 'http://127.0.0.1:18111';
const STEADY_WINDOW_S = Number(process.argv[3] ?? 60);

const HARNESS = `
(() => {
  const Real = window.WebSocket;
  window.__wsLog = [];
  window.__sent = [];
  window.__dropInbound = false;
  window.__sock = null;
  const log = (ev) => { try { window.__wsLog.push({ t: Math.round(performance.now()), ev }); } catch (e) {} };
  const desc = Object.getOwnPropertyDescriptor(Real.prototype, 'onmessage');
  window.WebSocket = class extends Real {
    constructor(...a) {
      super(...a);
      window.__sock = this;
      window.__sent = [];
      window.__sockN = (window.__sockN || 0) + 1;
      log('open-socket#' + window.__sockN);
      this.__raw = null;
    }
    send(d) { try { window.__sent.push(String(d)); } catch (e) {} return super.send(d); }
    close() { log('close-called'); return super.close(); }
    get onmessage() { return this.__raw; }
    set onmessage(h) {
      this.__raw = h;
      const wrapped = (ev) => {
        if (window.__dropInbound) return; // 半开模拟：吞掉全部入站帧
        if (typeof h === 'function') h.call(this, ev);
      };
      if (desc && desc.set) desc.set.call(this, wrapped); else this.addEventListener('message', wrapped);
    }
  };
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Shanghai' });
  const kreq = [];
  const t0 = Date.now();
  page.on('request', (r) => {
    const u = decodeURIComponent(r.url());
    if (u.includes('/api/kline')) kreq.push({ at: Date.now() - t0, url: u.replace(/^https?:\/\/[^/]+/, '') });
  });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.addInitScript(HARNESS);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="kline-chart"] canvas', { timeout: 30_000 });
  await page.waitForFunction(() => (window.__sent || []).some((f) => f.includes('"subscribe"')), { timeout: 20_000 });
  await sleep(2_000);

  const socketsAtStart = await page.evaluate(() => window.__sockN || 0);

  // ── 半开窗口：丢弃全部入站帧（服务端仍在推，客户端看不到）
  await page.evaluate(() => { window.__dropInbound = true; });
  const dropAt = Date.now() - t0;
  await sleep(20_000); // 覆盖看门狗阈值 15s + 退避 1s
  await page.evaluate(() => { window.__dropInbound = false; });

  // 稳态观察窗（先等到 t=120s，再观察 STEADY_WINDOW_S 秒）
  const STEADY_FROM_S = 120;
  const elapsed = Date.now() - t0;
  if (elapsed < STEADY_FROM_S * 1_000) await sleep(STEADY_FROM_S * 1_000 - elapsed);
  const steadyStartS = Date.now() - t0;
  await sleep(STEADY_WINDOW_S * 1_000);
  const steadyEnd = Date.now() - t0;

  const final = await page.evaluate(() => ({ log: window.__wsLog, sockN: window.__sockN || 0 }));

  const reconnectEvents = final.log.filter((e) => e.ev.startsWith('open-socket#'));
  const steadyReconnects = reconnectEvents.filter((e) => e.t > steadyStartS).length;
  const comp = kreq.filter((k) => k.at > dropAt && k.at < dropAt + 21_000 && k.url.includes('limit=5'));
  const poll = kreq.filter((k) => k.at >= 55_000 && k.at <= 75_000 && k.url.includes('limit=5'));

  const result = {
    base: BASE,
    initialLoad: kreq.filter((k) => k.at < 5_000),
    dropWindow: { from: dropAt, to: dropAt + 20_000 },
    socketsAtStart,
    socketsTotal: final.sockN,
    wsTimeline: final.log,
    compensationRequestsInHalfOpenWindow: comp,
    minuteFallbackRequests_55to75s: poll,
    steadyWindow: { fromS: Math.round(steadyStartS), toS: Math.round(steadyEnd), seconds: STEADY_WINDOW_S, reconnects: steadyReconnects },
    allKlineRequests: kreq,
    consoleErrors: errs,
    verdict: {
      watchdogReconnected: final.sockN > socketsAtStart,
      compensationOnce: comp.length === 1,
      minuteFallback: poll.length >= 1,
      noChurnInSteadyWindow: steadyReconnects === 0,
      clean: errs.length === 0,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((e) => { console.error('PROBE_FAILED', e); process.exit(1); });
