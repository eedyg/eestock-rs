#!/usr/bin/env node
/**
 * 286 补充验收（会话态）：VOL 开关「默认开 · 会话态 · 不落服务端配置 · 刷新回默认开」。
 * 只读：只发 GET（页面自身初始化 + 本脚本的 GET 读配置）；点击 VOL 仅改前端内存态。
 * 运行：cd <repo>/web && node <repo>/tester/evidence/286_vol_acceptance/286_supplementary_session_state.mjs
 */
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';

const OUT = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/286_vol_acceptance';
const BASE = 'http://127.0.0.1:8081/';
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

const volState = (page) => page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === 'VOL');
  return b ? b.getAttribute('aria-pressed') : null;
});

const cfg = async () => (await (await fetch(`${BASE}api/config/multi_period`, { method: 'GET' })).text());
const cfgBefore = await cfg();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const writes = [];
const apis = [];
page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`); });
page.on('response', (r) => { if (r.url().includes('/api/')) apis.push(`${r.request().method()} ${r.status()} ${r.url()}`); });

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'VOL'), null, { timeout: 30000 });
await page.waitForTimeout(2500);

say('# A8（附加）会话态：默认开 · 点击关 · 刷新回默认开 · 零配置写');
say('');
say(`## 首次加载后 VOL aria-pressed = ${await volState(page)}（期望 true = 默认开）`);
const initial = await volState(page);

await page.getByRole('button', { name: 'VOL', exact: true }).click();
await page.waitForTimeout(1200);
const afterClick = await volState(page);
say(`## 点击 VOL 后 aria-pressed = ${afterClick}（期望 false）`);
await page.screenshot({ path: `${OUT}/A8_vol_off_before_reload.png` });

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'VOL'), null, { timeout: 30000 });
await page.waitForTimeout(2500);
const afterReload = await volState(page);
say(`## 刷新页面后 aria-pressed = ${afterReload}（期望 true = 刷新回默认开，证明不落服务端配置）`);
await page.screenshot({ path: `${OUT}/A8_after_reload_default_on.png` });

const cfgAfter = await cfg();
say('');
say('## 非 GET 的 /api/ 请求（必须为空）');
say(writes.length ? writes.map((w) => `  ${w}`).join('\n') : '  (无)');
say('');
say('## GET /api/config/multi_period 对比（脚本前 / 脚本后）');
say(`  前：${cfgBefore}`);
say(`  后：${cfgAfter}`);
say(`  ⇒ ${cfgBefore === cfgAfter ? '逐字段相同（零写入）' : '存在差异'}`);
say('');
say('## 会话内所有 /api/ 请求（去重）');
say(...Array.from(new Set(apis)).map((a) => `  ${a}`));
say('');
say(`## 结论：默认开=${initial === 'true'}  点击关=${afterClick === 'false'}  刷新回默认开=${afterReload === 'true'}  非 GET 请求数=${writes.length}`);

fs.writeFileSync(`${OUT}/A8_session_state.txt`, lines.join('\n') + '\n');
await browser.close();
