/**
 * 线上实例 8081 只读取证（tester 诊断 问题①）。
 * - 只发 GET（非 GET 请求一律 abort，绝不改动线上状态；不 kill/不重启）。
 * - 目的：在真实产品页面上定位「K线 与 VOL 之间多出的那条分割线」，给出 DOM/几何证据 + 截图。
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const { chromium } = await import(pathToFileURL(resolve(WEB, 'node_modules/playwright/index.mjs')).href);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const requests = [];
await page.route('**/*', async (route, req) => {
  const m = req.method();
  requests.push(`${m} ${req.url()}`);
  if (m !== 'GET') {
    await route.abort();
    return;
  }
  await route.continue();
});
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto('http://localhost:8081/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-region="main-chart"] canvas', { timeout: 30000 });
await page.waitForTimeout(2500);

const probe = async (label) =>
  page.evaluate((l) => {
    const main = document.querySelector('[data-region="main-chart"]');
    const sub = document.querySelector('[data-region="sub-chart"]');
    const host = document.querySelector('[k-line-chart-id]');
    const kc = host?.firstElementChild ?? null;
    const mrect = main.getBoundingClientRect();
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { topInMain: +(r.top - mrect.top).toFixed(2), h: +r.height.toFixed(2), w: +r.width.toFixed(2) };
    };
    // ① 骨架 sub-chart 锚点的 border-t
    const cs = sub ? getComputedStyle(sub) : null;
    const subInfo = sub
      ? {
          ...rel(sub),
          borderTopWidth: cs.borderTopWidth,
          borderTopColor: cs.borderTopColor,
          borderTopStyle: cs.borderTopStyle,
          bottomOffsetFromMainBottom: +(mrect.bottom - sub.getBoundingClientRect().bottom).toFixed(2),
        }
      : null;
    // ② klinecharts 内部分割元素（SeparatorWidget: cursor ns-resize）
    const seps = [];
    if (kc) {
      for (const el of Array.from(kc.children)) {
        const widget = el.firstElementChild;
        if (widget && widget.style && widget.style.cursor === 'ns-resize') {
          seps.push({ ...rel(el), bg: getComputedStyle(el).backgroundColor, inlineBg: el.style.backgroundColor });
        }
      }
    }
    // ③ main-chart 区域内所有「1px 水平线」候选（border-top 或细背景条）
    const lines = [];
    if (main) {
      for (const el of Array.from(main.querySelectorAll('*'))) {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const bw = parseFloat(s.borderTopWidth || '0');
        const isSep = !!el.firstElementChild && el.firstElementChild.style && el.firstElementChild.style.cursor === 'ns-resize';
        const thinBg = r.height <= 3 && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
        if (isSep || (bw > 0 && s.borderTopStyle !== 'none' && r.width > 100) || thinBg) {
          lines.push({
            tag: el.tagName + (el.dataset?.region ? `[data-region=${el.dataset.region}]` : '') + (isSep ? '[klinecharts-separator]' : ''),
            kind: isSep ? 'klinecharts-separator' : bw > 0 ? `border-top ${s.borderTopWidth} ${s.borderTopColor}` : `bg ${s.backgroundColor}`,
            ...rel(el),
          });
        }
      }
    }
    return {
      label: l,
      mainChart: { h: +mrect.height.toFixed(2), w: +mrect.width.toFixed(2), top: +mrect.top.toFixed(2) },
      subChartAnchor: subInfo,
      klinechartsHostChildren: host ? host.children.length : null,
      klinechartsSeparators: seps,
      separatorCount: seps.length,
      domSeparatorCount: seps.length,
      horizontalLineCandidates: lines,
      outerHTML: main ? main.outerHTML.slice(0, 4000) : null,
    };
  }, label);

const snaps = [];
snaps.push(await probe('live:initial'));

// 交互：把 klinecharts 的 VOL pane 往上拉（模拟用户拖拽分割线）——纯前端，无服务端状态
const dragged = await page.evaluate(() => {
  const host = document.querySelector('[k-line-chart-id]');
  const kc = host?.firstElementChild;
  if (!kc) return 'no-kc';
  const seps = Array.from(kc.children).filter(
    (el) => el.firstElementChild && el.firstElementChild.style && el.firstElementChild.style.cursor === 'ns-resize',
  );
  if (seps.length === 0) return 'no-sep';
  // 第一条分割线 = candle|VOL 边界；其 widget 7px 高，位于分割元素内 top:-3px
  const w = seps[0].firstElementChild;
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, sepCount: seps.length };
});
if (typeof dragged === 'object') {
  await page.mouse.move(dragged.x, dragged.y);
  await page.mouse.down();
  await page.mouse.move(dragged.x, dragged.y - 120, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
}
snaps.push(await probe('live:after-drag-vol-up'));
await page.screenshot({ path: '/tmp/dcap_sep01/live-8081-dashboard.png' });

// 再点 DCAP 开关（纯前端 React 状态，无服务端写入）→ 观察线数变化
const toggled = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => (x.textContent || '').trim() === 'DCAP');
  if (!b) return 'no-dcap-btn';
  const before = b.getAttribute('aria-pressed');
  b.click();
  return { before, label: b.textContent };
});
await page.waitForTimeout(900);
snaps.push(await probe('live:after-dcap-toggle'));
await page.screenshot({ path: '/tmp/dcap_sep01/live-8081-dashboard-dcap.png' });

const out = { url: 'http://localhost:8081/', dragged, toggled, snaps, requestMethods: [...new Set(requests.map((r) => r.split(' ')[0]))], sampleRequests: requests.slice(0, 25) };
writeFileSync('/tmp/dcap_sep01/live-8081-probe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
