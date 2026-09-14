/**
 * P3-D-3 独立验收：真身 klinecharts 10.0.3 + 生产 `ChartSyncGroup`（esbuild 转译自仓库源码）真渲染驱动。
 * 运行：node /tmp/p3d3/run.mjs  （证据输出到 P3D3_OUT，默认 /tmp/p3d3/out）
 * 只读：file:// + 合成数据 ⇒ 0 网络请求；不触碰线上端口/进程。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');
const LAUNCH = { args: ['--allow-file-access-from-files'] };

const here = process.env.P3D3_H1 ?? '/tmp/p3d3/h1';
const outDir = process.env.P3D3_OUT ?? '/tmp/p3d3/out';
fs.mkdirSync(outDir, { recursive: true });
const url = 'file://' + path.join(here, 'harness.html');

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
const requests = [];
page.on('request', (r) => requests.push(r.url()));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 180000 });
const result = await page.evaluate(() => window.__RESULT);
const shot = path.join(outDir, 'p3d3_harness.png');
await page.screenshot({ path: shot, fullPage: true });
await browser.close();

const s = result.scenarios;
const A2 = s.A2_cross_period ?? {};
const A3 = s.A3_degrade_1m1h ?? {};
const checks = [
  ['PROBE 库事实：同索引定位两图范围精确相等 / scrollToTimestamp 落点仍偏 2 根',
    s.PROBE?.sameIndexEqual === true && s.PROBE?.edgeGapBars === 2],
  ['A1 1m↔1m 20 轮 maxDrift ≤1 根（期望 0）', (s.A1_same_period_20rounds?.maxDrift ?? 99) <= 1],
  ['A1 无回声（echoEvents=0）且抑制生效（suppressed>0）',
    s.A1_same_period_20rounds?.stats?.echoEvents === 0 && (s.A1_same_period_20rounds?.stats?.suppressed ?? 0) > 0],
  ['A2 1m↔5m：跨度差 ≤1 根且右端差 ≤1 根高周期 bar、卫星 ≥2 根', A2['1m↔5m']?.pass === true],
  ['A2 1m↔15m：同判据', A2['1m↔15m']?.pass === true],
  ['A2 1d↔1w：同判据', A2['1d↔1w']?.pass === true],
  ['A3 降级路径（1m↔1h）：degraded/degradedPeriod + 卫星 ≥2 根 + 右端差 ≤1 根 + 可达下界已记录 + 角标(store)可读',
    A3.degradedCase?.pass === true],
  ['A3 降级路径：跨度差**不适用** ≤1 根（记录实测下界 >1 根）',
    (A3.degradedCase?.stats?.spanResidualBars ?? 0) > 1],
  ['A3 缩小基准 ⇒ 回到成功路径判据（degraded=false、跨度/右端差 ≤1 根、unaligned=0）',
    A3.shrink?.pass === true],
  ['A4 基准冻结：卫星作 leader ⇒ 基准 barSpace/可见范围/右偏移逐项不变且基准 0 次 barSpace 写入',
    s.A4_base_freeze?.pass === true],
  ['A4 对照：naive 路径会把基准写成 50（实测对照值）', s.A4_base_freeze?.naiveWouldWriteBaseBS === 50],
  ['A5 可观测：被跳过的 follower 计数 + 原因可读（不再静默）+ 残差/微调字段可读',
    s.A5_observability?.pass === true],
  ['A6 有界性：迭代 ≤3（字面量）且 barSpace 单步幅度 ≤50%', s.A6_bounded?.pass === true],
];

const nonFile = [...new Set(requests.filter((u) => !u.startsWith('file://')))];
const evidence = { url, version: result.version, errors: result.errors, console: consoleMsgs, networkNonFile: nonFile,
  checks: checks.map(([name, ok]) => ({ name, ok })), scenarios: s, screenshot: shot, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, 'p3d3_harness.json'), JSON.stringify(evidence, null, 2));

console.log(`klinecharts version = ${result.version}`);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`errors = ${JSON.stringify(result.errors)}`);
console.log(`pageerrors/console = ${consoleMsgs.length === 0 ? 'none' : JSON.stringify(consoleMsgs)}`);
console.log(`non-file network requests = ${nonFile.length}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`SUMMARY: ${checks.length - failed.length} PASS / ${failed.length} FAIL`);
console.log(`evidence = ${path.join(outDir, 'p3d3_harness.json')}`);
process.exitCode = failed.length === 0 && nonFile.length === 0 && result.errors.length === 0 ? 0 : 1;
