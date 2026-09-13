/**
 * 诊断 问题① 驱动 v2：真实骨架（DashboardGrid tangle 产物）+ 真实 KlineChart + 真实 klinecharts 10.0.3。
 * 用法：node run2.mjs <variant> [cssPath]
 *   variant: dcap | nodcap
 * 注入线上 8081 当前构建 CSS（默认 /tmp/live.css）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB = '/home/eestock/workspace/git/eestock/eestock-rs/web';
const variant = process.argv[2] ?? 'dcap';
const cssPath = process.argv[3] ?? '/tmp/live.css';
const out = `/tmp/dcap_sep01/bundle2-${variant}.js`;

execFileSync(
  resolve(WEB, 'node_modules/.bin/esbuild'),
  [
    '/tmp/dcap_sep01/entry2.tsx',
    '--bundle',
    '--format=iife',
    '--target=chrome120',
    '--jsx=automatic',
    '--log-level=warning',
    '--alias:klinecharts=/tmp/dcap_sep01/kc-spy.ts',
    `--alias:@=${WEB}/src`,
    '--define:process.env.NODE_ENV="development"',
    `--outfile=${out}`,
  ],
  { cwd: '/tmp/dcap_sep01', stdio: 'inherit' },
);

const bundle = readFileSync(out, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const { chromium } = await import(pathToFileURL(resolve(WEB, 'node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.setContent('<!doctype html><html lang="zh-CN" class="dark"><head></head><body style="margin:0"></body></html>');
await page.addStyleTag({ content: css });
await page.addInitScript((v) => {
  window.__VARIANT__ = v;
}, variant);
await page.addScriptTag({ content: bundle });
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 30000 });

const steps = [];
const snap = async (label) => {
  await page.waitForTimeout(300);
  steps.push(await page.evaluate((l) => window.__ctl.snap(l), label));
};
const setInd = (n, o) => page.evaluate(([a, b]) => window.__ctl.setIndicator(a, b), [n, o]);

// 'never' 变体：DCAP **从不开启/从不注册**（最小差异对照）；切换 MA 以驱动同样的 syncIndicators 路径
const toggled = variant === 'never' ? 'ma' : 'dcap';

await snap('default(MA on, VOL on, DCAP off)');
await setInd(toggled, true);
await snap(`${toggled}_on#1`);
await setInd(toggled, false);
await snap(`${toggled}_off#1`);
await setInd(toggled, true);
await snap(`${toggled}_on#2`);
await setInd(toggled, false);
await snap(`${toggled}_off#2`);
await setInd(toggled, true);
await snap(`${toggled}_on#3(连切3次)`);
const volId = await page.evaluate(() => window.__ctl.setVolHeight(240));
await snap(`vol240_${toggled}_on`);
await setInd(toggled, false);
await snap(`vol240_${toggled}_off`);
await setInd(toggled, true);
await snap(`vol240_${toggled}_on#2`);
const volId2 = await page.evaluate(() => window.__ctl.setVolHeight(400));
await snap(`vol400_${toggled}_on`);
await setInd('ma', false);
await snap('vol400_ma_off');
await setInd('ma', true);
await snap('vol400_ma_on');

const calls = await page.evaluate(() => window.__CALLS__ ?? []);
await page.screenshot({ path: `/tmp/dcap_sep01/shot2-${variant}.png` });
const res = { variant, cssPath, volId, volId2, steps, calls, browserLogs: logs };
writeFileSync(`/tmp/dcap_sep01/out2-${variant}.json`, JSON.stringify(res, null, 2));
console.log(`wrote /tmp/dcap_sep01/out2-${variant}.json  (steps=${steps.length})`);
await browser.close();
