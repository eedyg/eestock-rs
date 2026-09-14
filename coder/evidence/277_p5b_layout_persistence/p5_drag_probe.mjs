/** P5 真渲染拖拽往返探针（临时脚本；不改 tester 的 harness 文件；0 出网/0 写请求）。 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const HERE = path.join(WEB, 'tester', 'p5-layout-harness');
const require = createRequire(WEB + '/package.json');
const { chromium } = require('playwright');
const dist = '/tmp/p5-probe-dist';

fs.rmSync(dist, { recursive: true, force: true });
const build = spawnSync(path.join(WEB, 'node_modules/.bin/vite'), ['build', '--config', path.join(HERE, 'vite.config.mjs')], {
  cwd: WEB, encoding: 'utf8', env: { ...process.env, P5_HARNESS_DIST: dist },
});
if (build.status !== 0) { console.error(build.stderr); throw new Error('build failed'); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.join(dist, decodeURIComponent(u.pathname));
  if (u.pathname === '/') p = path.join(dist, 'index.html');
  fs.readFile(p, (e, b) => { if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', MIME[path.extname(p)] ?? 'application/octet-stream'); res.end(b); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const requests = [];
page.on('request', (r) => requests.push(r.url()));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => !!(window.__p5 && document.querySelector('[data-mp-stack]')), null, { timeout: 60_000 });
await page.waitForTimeout(1500);

const read = () => page.evaluate(() => {
  const panes = {};
  for (const el of document.querySelectorAll('[data-mp-pane]')) {
    panes[el.getAttribute('data-mp-pane')] = +el.getBoundingClientRect().height.toFixed(2);
  }
  const main = document.querySelector('#main');
  const base = document.querySelector('[data-testid="kline-chart"]');
  return {
    panes,
    sum: +Object.values(panes).reduce((a, b) => a + b, 0).toFixed(2),
    overflow: main.scrollHeight - main.clientHeight,
    baseRect: +base.getBoundingClientRect().height.toFixed(2),
    writes: window.__writes.length,
  };
});

/** 真实鼠标拖拽（分隔条命中带中心 → 目标 y）。 */
async function drag(key, dy) {
  const box = await page.locator(`[data-mp-separator="${key}"]`).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2; // 净高 0 ⇒ 命中带中心即分隔线
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(450); // ≥ 防抖窗（300ms）
}

const h0 = await read();
await drag('15m|1h', 20);
const h1 = await read();
await drag('15m|1h', -20);
const h2 = await read();
await drag('1h|5m', 15); // 卫星↔卫星（不涉基准）
const h3 = await read();

const nonLocal = [...new Set(requests.filter((u) => !u.startsWith(url)))];
console.log(JSON.stringify({ h0, h1, h2, h3, nonLocal, url }, null, 2));
console.log(`[probe] 基准|1h 拖 +20：15m ${h0.panes['15m']}→${h1.panes['15m']}，1h ${h0.panes['1h']}→${h1.panes['1h']}，Σ=${h1.sum}，溢出=${h1.overflow}`);
console.log(`[probe] 往返（再 −20）：15m=${h2.panes['15m']}，1h=${h2.panes['1h']}（应回到初值），Σ=${h2.sum}`);
console.log(`[probe] 1h|5m 拖 +15：1h ${h2.panes['1h']}→${h3.panes['1h']}，5m ${h2.panes['5m']}→${h3.panes['5m']}，Σ=${h3.sum}`);
console.log(`[probe] 基准图真实高 = pane 15m 高（${h3.baseRect} vs ${h3.panes['15m']}）；写请求 = ${h3.writes}；非本地请求 = ${nonLocal.length}`);
await browser.close();
server.close();
