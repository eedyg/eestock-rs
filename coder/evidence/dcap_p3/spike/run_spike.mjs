/**
 * T8 spike 驱动（Playwright + esbuild；coder 取证用，位于 coder/evidence/dcap_p3/spike/）。
 * 用法：node coder/evidence/dcap_p3/spike/run_spike.mjs
 * 产物：coder/evidence/dcap_p3/t8_*.png + t8_probe_results.json + 控制台输出
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const outDir = resolve(here, '..');
// playwright 从 web/node_modules 解析（本 spike 脚本不在 web 包内）
const { chromium } = await import(
  pathToFileURL(resolve(repo, 'web/node_modules/playwright/index.mjs')).href,
);

// 1) esbuild 打包（把仓库真实的 dcapIndicator.ts / dcap.ts 编进单文件 IIFE）
const bundle = resolve(here, 'bundle.js');
execFileSync(
  resolve(repo, 'web/node_modules/.bin/esbuild'),
  [
    resolve(here, 'spike.ts'),
    '--bundle',
    '--format=iife',
    '--target=chrome120',
    '--log-level=warning',
    `--outfile=${bundle}`,
  ],
  { cwd: repo, env: { ...process.env, NODE_PATH: resolve(repo, 'web/node_modules') }, stdio: 'inherit' },
);

// 2) 浏览器：真实 canvas 渲染 + 截图
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`pageerror: ${e.message}`));

await page.goto(`file://${here}/index.html`);
await page.waitForFunction(() => window.__DCAP_SPIKE__?.ready === true, null, { timeout: 30_000 });

const shots = [
  ['chartA', 't8_1_precision_0.004578_p4_vs_p5.png'],
  ['chartB', 't8_1b_precision_0.0048_p4_vs_p5.png'],
  ['chartD', 't8_2_3_insufficient_break_and_3figures.png'],
  ['chartC', 't8_4_decimal_fold_0.00048.png'],
];
mkdirSync(outDir, { recursive: true });
for (const [id, file] of shots) {
  await page.locator(`#${id}`).screenshot({ path: resolve(outDir, file) });
}
await page.screenshot({ path: resolve(outDir, 't8_0_full_page.png'), fullPage: true });

const data = await page.evaluate(() => window.__DCAP_SPIKE__);

// ── T8 五项断言（渲染文本取自真实 canvas fillText 捕获）──
const charts = data.charts;
const textsOf = (k, f) => charts[k].renderedTexts[f];
const checks = [];
const check = (id, desc, ok, detail) => checks.push({ id, desc, ok, detail });

const aTexts = [...textsOf('A_004578', 'valueLike'), ...textsOf('A_004578', 'legendLike')];
const bTexts = [...textsOf('B_00048', 'valueLike'), ...textsOf('B_00048', 'legendLike')];
check(
  'T8-1a',
  'precision 5 下 0.0045787545787547845 渲染可见第 5 位（0.00458）；不设 precision（默认 4）丢第 5 位（0.0046）',
  aTexts.includes('0.00458') && aTexts.includes('0.0046'),
  `A 区渲染文本含 0.00458=${aTexts.includes('0.00458')} / 0.0046=${aTexts.includes('0.0046')}；精确值=${data.rawValues.A_last_s}`,
);
check(
  'T8-1b',
  'precision 5 下 0.0048 渲染为 0.00480；默认 4 位渲染为 0.0048',
  bTexts.includes('0.00480') && bTexts.includes('0.0048'),
  `B 区渲染文本含 0.00480=${bTexts.includes('0.00480')} / 0.0048=${bTexts.includes('0.0048')}；精确值=${data.rawValues.B_last_s}`,
);
check(
  'T8-1c',
  '实例化精度：显式 precision:5 的 DCAP=5；不设 precision 的 DCAP4 落到 klinecharts 默认 4',
  charts.A_004578.indicators[0].precision === 5 &&
    charts.A_004578.indicators[1].precision === 4 &&
    data.templates.DCAP.precision === 5 &&
    data.templates.DCAP4.precision === null,
  `实例 DCAP=${charts.A_004578.indicators[0].precision} / DCAP4=${charts.A_004578.indicators[1].precision}；模板 precision：DCAP=${data.templates.DCAP.precision} / DCAP4=${String(data.templates.DCAP4.precision)}（不设）`,
);

const deg = data.degraded;
check(
  'T8-2a',
  '任何异常均不抛出（1 根数据 / 恶意 getter / 空 / 非数组 / 缺参数）',
  Object.values(deg).every((v) => v.threw === false),
  `threw=${JSON.stringify(Object.fromEntries(Object.entries(deg).map(([k, v]) => [k, v.threw])))}`,
);
check(
  'T8-2b',
  '数据不足 → null 断线（1 根数据三线均 null；恶意 getter 降级全 null）',
  JSON.stringify(deg.insufficient_1bar.result) === JSON.stringify([{ s: null, m: null, l: null }]) &&
    JSON.stringify(deg.hostileGetter.result) === JSON.stringify([{ s: null, m: null, l: null }, { s: null, m: null, l: null }]),
  `1bar=${JSON.stringify(deg.insufficient_1bar.result)} hostile=${JSON.stringify(deg.hostileGetter.result)}`,
);

const dInd = charts.D_break_3figures.indicators[0];
check(
  'T8-3a',
  '三 figure（s/m/l）+ 独立副图 pane（paneId ≠ candle_pane）',
  JSON.stringify(dInd.figures) === JSON.stringify(['s', 'm', 'l']) && !String(dInd.paneId).includes('candle'),
  `figures=${JSON.stringify(dInd.figures)} paneId=${dInd.paneId}`,
);
check(
  'T8-3b',
  '断线首值位置 = n_i + m − 1（s=9 / m=27 / l=61，0-based）',
  dInd.firstNonNull.s === 9 && dInd.firstNonNull.m === 27 && dInd.firstNonNull.l === 61,
  `firstNonNull=${JSON.stringify(dInd.firstNonNull)}`,
);
const aPanes = charts.A_004578.indicators;
check(
  'T8-3c',
  '两张副图 pane 与 Y 轴彼此独立（paneId/yAxisId 均不同）',
  aPanes[0].paneId !== aPanes[1].paneId && aPanes[0].yAxisId !== aPanes[1].yAxisId,
  `paneId=${aPanes.map((i) => i.paneId).join(',')} yAxisId=${aPanes.map((i) => i.yAxisId).join(',')}`,
);

const cTexts = charts.C_fold.renderedTexts.all;
const folded = cTexts.filter((t) => /^\d+\.0\{\d+\}\d+$/.test(t));
check(
  'T8-4',
  'decimalFold threshold=3：0.00048 → 0.0{3}48（0.0048 不折叠）；渲染轴上可见折叠形态',
  data.rawValues.fold_00048_t3 === '0.0{3}48' && data.rawValues.fold_0_0048_t3 === '0.0048' && folded.length > 0,
  `formatFoldDecimal(0.00048,3)=${data.rawValues.fold_00048_t3}；(0.0048,3)=${data.rawValues.fold_0_0048_t3}；C 区折叠刻度=${JSON.stringify(folded)}`,
);

const perf = data.perf.max_nl_m60;
check(
  'T8-5',
  '600 根 + n_l=250 + m=60：单次 computeDcapSeries < 16ms',
  perf.median < 16 && perf.max < 16,
  `min=${perf.min.toFixed(3)}ms median=${perf.median.toFixed(3)}ms max=${perf.max.toFixed(3)}ms（${perf.iters} 次；预算 16ms）`,
);

const failed = checks.filter((c) => !c.ok);
const report = [
  'T8 渲染 spike 断言（真实 klinecharts 10.0.3 + 真实 dcapIndicator.ts/dcap.ts）',
  ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.desc}\n      → ${c.detail}`),
  `\n合计 ${checks.length} 项：PASS ${checks.length - failed.length} / FAIL ${failed.length}`,
];
writeFileSync(resolve(outDir, 't8_assertions.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
writeFileSync(
  resolve(outDir, 't8_probe_results.json'),
  JSON.stringify({ ...data, browserConsole: consoleMsgs, probeShots: shots.map(([, f]) => f) }, null, 2),
);
await browser.close();
console.log('probe ready:', data.ready, '| drawnTexts:', data.drawnTextCount, '| console:', consoleMsgs.length);
