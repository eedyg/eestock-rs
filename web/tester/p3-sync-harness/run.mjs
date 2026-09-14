/**
 * P3-A 跨图同步：真身 klinecharts 库事实/几何取证 runner（T3 / T4 / T8bis 的判据锚定回归）。
 *
 * 本文件位置：`web/tester/p3-sync-harness/run.mjs`
 * 载入页面：`web/tester/p3-sync-harness/harness.html`（`file://` + 本地 UMD bundle）
 *
 * 运行（须在 `web/` 下，便于解析 playwright）：
 *     cd web && node tester/p3-sync-harness/run.mjs
 *
 * 性质：**只读**。全程 `file://` + 合成数据 ⇒ **0 网络请求**（不触碰线上 8081/8082，不重启 PID 3112540）。
 * 证据：`tester/evidence/272_p3_red/`（JSON + 页面截图）。
 *
 * 诚实标注（同 P2-A 的 `p2-satellite-harness`）：本 harness 取证的是**库级几何/事件事实**，
 * 因此**当前即为绿**；产品级 `ChartSyncGroup` 的行为断言由
 * `web/src/features/dashboard/{chartSyncGroup,chartSyncDensity,multiPeriodSyncBadge}.test.*`（当前红）承担，
 * 产品级真实渲染驱动留待 P3-C 独立验收（Vite + 产品组件）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');

const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = process.env.P3_HARNESS_OUT ?? '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/272_p3_red';
const url = 'file://' + path.join(here, 'harness.html');
const kcPkg = JSON.parse(
  fs.readFileSync(path.join(here, '..', '..', 'node_modules', 'klinecharts', 'package.json'), 'utf8'),
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
const requests = [];
page.on('request', (r) => requests.push(r.url()));

await page.goto(url);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 120_000 });
const result = await page.evaluate(() => window.__RESULT);
fs.mkdirSync(outDir, { recursive: true });
const shot = path.join(outDir, 'p3_sync_harness.png');
await page.screenshot({ path: shot, fullPage: true });
await browser.close();

const s = result.steps ?? {};
const WEEK = 7 * 86400000;
const checks = [
  ['F1 库事实：scrollToTimestamp(ts) 把该 ts 的 bar 对齐到右缘（±8 根内，实测偏 2 根）', s.F1_scroll_to_timestamp_right_edge?.rightEdgeWithin8Bars === true],
  ['F2 库事实：交互处理器内再**写**图表 API ⇒ 同步嵌套事件（重入存在）', (s.F2_reentrancy?.nestedEvents ?? 0) >= 1],
  ['F3 密度比镜像：20/20 轮跨度差 ≤1 根高周期 bar', s.F3_mirror_20_rounds?.roundsWithinOneWeek?.density === 20],
  ['F3 镜像无漂移：卫星 barSpace 20 轮恒为同一值（请求值）', (s.F3_mirror_20_rounds?.densitySatBSDistinct?.length ?? 0) === 1],
  ['F3 跨周期卫星可见 bar ≥2', (s.F3_mirror_20_rounds?.densitySatBarsMin ?? 0) >= 2],
  ['F3 反向证据：名义比 7 ⇒ 20 轮跨度差**均** >1 根周 bar（判别力成立）', s.F3_mirror_20_rounds?.roundsWithinOneWeek?.nominal === 0],
  ['F3 反向证据：名义比 7 的跨度差最小量级 ≥1 根周 bar', (s.F3_mirror_20_rounds?.minNominalSpanDiffMs ?? 0) >= WEEK],
  ['F4 库事实：基准（默认 max=50）请求 350/5000 被静默吞掉 ⇒ 读回仍 50', s.F4_bar_space_limits?.baseReq350 === 50 && s.F4_bar_space_limits?.baseReq5000 === 50],
  ['F4 库事实：卫星放宽到 350 后 350 生效（仅卫星）', s.F4_bar_space_limits?.satReq350 === 350],
  ['F5 降级：barSpace=floor(W/2) ⇒ 视口可读且可见 bar ≥2', s.F5_nan_and_degrade?.degradedVisibleAtLeast2 === true],
  ['F5 记录（非门禁）：本配置下未复现 NaN（P0.3 §6-I3a 在 1m↔1d/1w 复现）', s.F5_nan_and_degrade?.nanOnsetAt === null],
  ['F6 密度估计器：正常窗可算（≈5）', s.F6_density_estimator_failure?.normal?.ok === true],
  ['F6 密度估计器：无重叠 ⇒ 失效（需静态回退）', s.F6_density_estimator_failure?.disjoint?.ok === false],
  ['F6 密度估计器：窗内 ≤1 根 ⇒ 失效（需静态回退）', s.F6_density_estimator_failure?.tooSparseWindow?.ok === false],
  [
    'F7 库事实：`scrollToTimestamp` 落点距右缘固定 ≥2 根，且 `setOffsetRightDistance(0)` **无法消除**（P3-C PROBE 同源）',
    s.F7_scroll_to_timestamp_gap?.gapUnremovableByZeroRightOffset === true,
  ],
  [
    'F7 对照：同 `scrollToDataIndex` 两同构实例范围**精确相等**（缺口不在该原语上（PROBE 实测 [241,302]==[241,302]））',
    s.F7_scroll_to_timestamp_gap?.sameIndexScrollRangeEqual === true,
  ],
];

const nonFile = [...new Set(requests.filter((u) => !u.startsWith('file://')))];
const evidence = {
  url, version: kcPkg.version, errors: result.errors,
  console: consoleMsgs, networkNonFile: nonFile,
  checks: checks.map(([name, ok]) => ({ name, ok })),
  steps: s,
  screenshot: shot,
  generatedAt: new Date().toISOString(),
  weekMs: WEEK,
};
fs.writeFileSync(path.join(outDir, 'p3_sync_harness.json'), JSON.stringify(evidence, null, 2));

console.log(`klinecharts version = ${kcPkg.version} (indicators=${result.supportedIndicators})`);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`pageerrors/console = ${consoleMsgs.length === 0 ? 'none' : JSON.stringify(consoleMsgs)}`);
console.log(`non-file network requests = ${nonFile.length}`);
console.log(`evidence = ${path.join(outDir, 'p3_sync_harness.json')}`);
const failed = checks.filter(([, ok]) => !ok);
process.exitCode = failed.length === 0 && nonFile.length === 0 ? 0 : 1;
