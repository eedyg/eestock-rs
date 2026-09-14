/**
 * P5-A 布局/纵向溢出：真渲染几何取证 runner（T9 / 溢出面的**唯一**几何判据）。
 *
 * 本文件位置：`web/tester/p5-layout-harness/run.mjs`
 * 载入页面：`web/tester/p5-layout-harness/index.html`（先 `vite build` 到临时目录，再由本地随机端口静态服务）
 *
 * 运行（须在 `web/` 下）：
 *     cd web && node tester/p5-layout-harness/run.mjs
 *
 * 性质：**只读**。合成数据 + 本地静态服务 ⇒ 0 出网、**0 写请求**（不触碰线上 8081/8082，不重启 PID 3112540）。
 * 证据：`tester/evidence/276_p5_red/`（JSON + 页面截图 + stdout）。
 *
 * 红阶段语义：当前实现（卫星按普通流追加、无高度分配）**必然溢出** ⇒ 溢出判据 FAIL 即本 harness 的红证据。
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const HERE = path.join(WEB, 'tester', 'p5-layout-harness');
const require = createRequire(WEB + '/package.json');
const { chromium } = require('playwright');

const outDir = process.env.P5_HARNESS_OUT ?? '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/276_p5_red';
const dist = process.env.P5_HARNESS_DIST ?? '/tmp/p5-layout-dist';

// ── 1) 构建（真实产品组件 + 真实 Tailwind）────────────────────────────────────
fs.rmSync(dist, { recursive: true, force: true });
const build = spawnSync(path.join(WEB, 'node_modules/.bin/vite'), ['build', '--config', path.join(HERE, 'vite.config.mjs')], {
  cwd: WEB,
  encoding: 'utf8',
  env: { ...process.env, P5_HARNESS_DIST: dist },
});
if (build.status !== 0) {
  console.error(build.stdout ?? '');
  console.error(build.stderr ?? '');
  throw new Error(`harness 构建失败（exit ${build.status}）`);
}

// ── 2) 本地随机端口静态服务（仅本机；结束时关闭）─────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.join(dist, decodeURIComponent(u.pathname));
  if (u.pathname === '/') p = path.join(dist, 'index.html');
  fs.readFile(p, (e, b) => {
    if (e) {
      res.statusCode = 404;
      res.end('nf');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(p)] ?? 'application/octet-stream');
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

// ── 3) 渲染 + 几何取证 ────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const consoleMsgs = [];
const requests = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
page.on('request', (r) => requests.push(r.url()));

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => !!(window.__p5 && document.querySelector('[data-testid="kline-chart"]')), null, { timeout: 60_000 });
await page.waitForTimeout(2000);

const result = await page.evaluate(() => window.__p5.measure());
fs.mkdirSync(outDir, { recursive: true });
const shot = path.join(outDir, 'p5_layout_harness.png');
await page.screenshot({ path: shot, fullPage: true });
await browser.close();
server.close();

// ── 4) 判据 ──────────────────────────────────────────────────────────────────
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const paneDeclared = (result.panes ?? []).map((p) => Number(p.declared ?? (p.inlineHeight ?? '').replace('px', '')) || 0);
const paneRects = (result.panes ?? []).map((p) => p.rect?.height ?? 0);
const paneSum = sum(paneRects.length ? paneRects : paneDeclared);
const segs = (result.satellites ?? []).map((s) => s.rect?.height ?? 0);
const currentFlowSum = (result.base?.height ?? 0) + sum(segs);

const mainScroll = result.main?.scrollHeight ?? 0;
const mainClient = result.main?.clientHeight ?? 0;
const stackOk = !!result.stack;

const checks = [
  ['G1 栈契约存在（`[data-mp-stack]`；P5 高度分配面）', stackOk],
  ['G2 pane 契约存在（`[data-mp-pane]` 数 == 4：基准 + 3 卫星）', (result.panes ?? []).length === 4],
  [
    'G3 恰好填满：Σ 各 pane 高度 == 可用高度 600（±1px）',
    paneSum > 0 && Math.abs(paneSum - (result.available ?? 0)) <= 1,
  ],
  [
    'G4 **无纵向溢出**：主图区 scrollHeight <= clientHeight（现状实测 1140 > 600 = 540px 溢出）',
    mainScroll <= mainClient + 1,
  ],
  [
    'G5 栈自身无纵向溢出（scrollHeight <= clientHeight）',
    (result.stack?.scrollHeight ?? Number.POSITIVE_INFINITY) <= (result.stack?.clientHeight ?? 0) + 1,
  ],
  [
    'G6 各 pane 真实渲染高度 == 声明高度（±1px）且 > 0',
    (result.panes ?? []).length > 0 &&
      (result.panes ?? []).every((p) => p.rect && p.rect.height > 0),
  ],
  [
    'G7 我方分隔条存在且覆盖每个相邻 pane 对（4 pane ⇒ 3 条；`role=separator`）',
    (result.panes ?? []).length === 4 &&
      (result.separatorCount ?? 0) === 3 &&
      (result.separators ?? []).every((s) => s.role === 'separator'),
  ],
  ['G8 零写请求（持久化路径不被 harness 触发）', (result.writes ?? 0) === 0],
];

const nonFile = [...new Set(requests.filter((u) => !u.startsWith(url)))];
const evidence = {
  url,
  generatedAt: new Date().toISOString(),
  checks: checks.map(([name, ok]) => ({ name, ok })),
  measure: result,
  /** 现状（无 P5 契约）下的业务元素高度和 + 主图区滚动量 ⇒ 红阶段溢出量级取证。 */
  current: {
    flowSum: currentFlowSum,
    overflowPx: Math.max(0, mainScroll - mainClient),
    baseHeight: result.base?.height ?? null,
    satelliteHeights: segs,
  },
  console: consoleMsgs,
  networkNonLocal: nonFile,
  screenshot: shot,
};
fs.writeFileSync(path.join(outDir, 'p5_layout_harness.json'), JSON.stringify(evidence, null, 2));

console.log(`main clientHeight=${mainClient} scrollHeight=${mainScroll} ⇒ 溢出 ${evidence.current.overflowPx}px`);
console.log(`现状（基准 + 卫星）高度和 = ${currentFlowSum}（可用 ${result.available}）`);
console.log(`pane 数 = ${(result.panes ?? []).length}，分隔条数 = ${result.separatorCount ?? 0}，Σ pane = ${paneSum}`);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`pageerrors/console = ${consoleMsgs.length === 0 ? 'none' : JSON.stringify(consoleMsgs.slice(0, 5))}`);
console.log(`非本地端口请求 = ${nonFile.length}；写请求 = ${result.writes ?? 0}`);
console.log(`evidence = ${path.join(outDir, 'p5_layout_harness.json')}`);

const failed = checks.filter(([, ok]) => !ok);
process.exitCode = failed.length === 0 && nonFile.length === 0 ? 0 : 1;
