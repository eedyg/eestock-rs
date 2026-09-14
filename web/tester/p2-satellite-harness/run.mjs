/**
 * P2-A 卫星实例：真身 klinecharts 库事实取证 runner（T2 的「height:0 单独无效」事实回归 + G4 前置声明）。
 *
 * 本文件位置：`web/tester/p2-satellite-harness/run.mjs`
 * 载入页面：`web/tester/p2-satellite-harness/harness.html`（`file://` + 本地 UMD bundle）
 *
 * 运行（须在 `web/` 下，便于解析 playwright）：
 *     cd web && node tester/p2-satellite-harness/run.mjs
 *
 * 性质：**只读**。全程 `file://` + 合成数据 ⇒ **0 网络请求**（不触碰线上 8081/8082，不重启 PID 3112540）。
 * 证据：`tester/evidence/<NNN>_p2a_red/`（JSON + 页面截图）。
 *
 * 说明（诚实标注）：本 harness 取证的是**库级事实**（与产品实现无关），因此**当前即为绿**：
 *  - `setPaneOptions({height:0})` 单独使用**不会**把高度变 0（被静默忽略）⇒ 必须 `state:'minimize'`；
 *  - `state:'minimize'+minHeight:0` ⇒ candle pane rect 高 **0**、指标 pane 填满、缩放/滚动后仍成立；
 *  - `separator.size=0` ⇒ 零高 pane 的残留间隙 **0**；
 *  - 零高 pane 存在时 `getConvertPictureUrl()` **抛错** ⇒ G4 的像素证据必须用**页面截图**（禁用图表导出）。
 * 产品级「卫星实例真的这么折叠了吗」由 `web/src/features/dashboard/multiPeriodSatellite.test.tsx`（当前红）
 * 与阶段 3 的独立验收（页面截图 + 画布像素采样）承担。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');

const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = process.env.P2_HARNESS_OUT ?? here;
const url = 'file://' + path.join(here, 'harness.html');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 700 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
// 0 网络请求断言（除 file:// 主文档与本地 UMD，不应有任何请求）
const requests = [];
page.on('request', (r) => requests.push(r.url()));

await page.goto(url);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 60_000 });
const result = await page.evaluate(() => window.__RESULT);
const shot = path.join(outDir, 'p2_satellite_harness.png');
await page.screenshot({ path: shot, fullPage: true });
await browser.close();

const s = result.steps ?? {};
const checks = [
  ['L1 库事实：setPaneOptions({height:0}) 单独使用不会把高度变 0（被静默忽略）', s.S2_height0_alone?.heightUnchanged === true],
  ['L1b 库事实：height:0 后高度确实**不是** 0', s.S2_height0_alone?.heightIsZero === false],
  ['L2 state:minimize+minHeight:0 ⇒ candle pane rect 高度 = 0', s.S3_minimize?.candleHeightIsZero === true],
  ['L2b 指标 pane 填满实例容器', s.S3_minimize?.indFillsContainer === true],
  ['L3 separator.size=0 ⇒ 相邻 pane 间隙 = 0', s.S4_separator0?.gapPx === 0],
  ['L4 缩放/滚动后 candle pane 仍为 0 高', s.S5_zoom_scroll?.candleHeightStillZero === true],
  ['L4b 缩放/滚动后间隙仍为 0', s.S5_zoom_scroll?.gapStillZero === true],
  ['L5 零高 pane 下 getConvertPictureUrl() 抛错（⇒ G4 禁用图表导出）', s.S6_export_throws?.threw === true],
  ['L6 指标确实被绘制（画布 fillText 打点阳性对照）', s.S7_drawn_texts?.hasIndicatorLegend === true],
  ['L6b 0 参考线图例被绘制', s.S7_drawn_texts?.zeroLineLegend === true],
  ['L7 state:normal 可还原', s.S8_restore_normal?.restored === true],
];

const networkOnly = [...new Set(requests.filter((u) => !u.startsWith('file://')))];
const evidence = {
  url, version: result.version, ua: result.ua,
  errors: result.errors, console: consoleMsgs,
  networkNonFile: networkOnly,
  checks: checks.map(([name, ok]) => ({ name, ok })),
  steps: s,
  screenshot: shot,
};
fs.writeFileSync(path.join(outDir, 'p2_satellite_harness.json'), JSON.stringify(evidence, null, 2));

console.log(`klinecharts version = ${result.version}`);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`pageerrors/console = ${consoleMsgs.length === 0 ? 'none' : JSON.stringify(consoleMsgs)}`);
console.log(`non-file network requests = ${networkOnly.length}`);
console.log(`evidence = ${path.join(outDir, 'p2_satellite_harness.json')}`);
const failed = checks.filter(([, ok]) => !ok);
process.exitCode = failed.length === 0 && networkOnly.length === 0 ? 0 : 1;
