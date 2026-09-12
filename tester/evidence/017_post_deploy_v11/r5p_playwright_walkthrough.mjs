// 017 部署后验收 — 生产实例前端轻量实跑（真实浏览器 chromium，:8081）。
// 只观察/只断言；不改实现、不改前端、不重启服务。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:8081';
const OUT = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/017_post_deploy_v11/r5p';
const RUN_PRESET = process.env.RUN_PRESET;
const DISTINCT_PRESET = process.env.DISTINCT_PRESET;
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.mkdirSync(OUT, { recursive: true });

const R = { base: BASE, started_at: new Date().toISOString(), steps: [], consoles: [],
  pageerrors: [], requestfailed: [], api_responses: [], submit_response: null,
  run_readback: null, trial_echo: null, screenshots: [] };
const step = (name, ok, detail) => { R.steps.push({ step: name, ok, detail }); console.log(`${ok?'PASS':'FAIL'} ${name} :: ${JSON.stringify(detail)}`); };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('console', (m) => R.consoles.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => R.pageerrors.push(String(e)));
page.on('requestfailed', (r) => R.requestfailed.push({ url: r.url(), method: r.method(), failure: r.failure()?.errorText ?? null }));
page.on('response', async (resp) => {
  const url = resp.url(); if (!url.includes('/api/')) return;
  const rec = { method: resp.request().method(), url, status: resp.status() };
  R.api_responses.push(rec);
  if (rec.method === 'POST' && url.endsWith('/api/workbench/runs')) {
    try { R.submit_response = { status: resp.status(), body: await resp.json() }; }
    catch { R.submit_response = { status: resp.status(), body: null }; }
  }
});
const shot = async (n) => { const p = path.join(OUT, n); await page.screenshot({ path: p, fullPage: false }); R.screenshots.push(p); };

await page.goto(`${BASE}/backtest-workbench`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="wb-config"]', { timeout: 30000 });
await page.waitForFunction(() => (document.querySelector('[data-testid="wb-preset-select"]')?.options?.length ?? 0) > 1, { timeout: 30000 });
step('open-workbench', true, { url: page.url() });

// default form fee inputs must be numeric (not undefined/NaN/empty)
const dflt = { rate: await page.locator('[data-testid="wb-fee-rate"]').inputValue(),
  min: await page.locator('[data-testid="wb-fee-min"]').inputValue(),
  slippage: await page.locator('[data-testid="wb-fee-slippage"]').inputValue() };
const bad = (v) => v === '' || v === 'undefined' || v === 'NaN' || Number.isNaN(Number(v));
step('R5-1-default-fee-inputs-numeric', !Object.values(dflt).some(bad), dflt);
await shot('r5p_01_default.png');

// apply distinct preset -> inputs must equal preset config (proves populated from cfg.fee, not defaults)
await page.selectOption('[data-testid="wb-preset-select"]', DISTINCT_PRESET);
await page.waitForTimeout(800);
const applied = { rate: await page.locator('[data-testid="wb-fee-rate"]').inputValue(),
  min: await page.locator('[data-testid="wb-fee-min"]').inputValue(),
  slippage: await page.locator('[data-testid="wb-fee-slippage"]').inputValue() };
const expected = { rate: '0.011', min: '3.5', slippage: '7.25' };
await shot('r5p_02_preset_applied.png');
step('R5-1b-apply-preset-populates-fee-inputs', applied.rate === expected.rate && applied.min === expected.min && applied.slippage === expected.slippage, { applied, expected, form_defaults: dflt });

// back to flat (stamp=0) preset
await page.selectOption('[data-testid="wb-preset-select"]', RUN_PRESET);
await page.waitForTimeout(600);

// submit ETF run via UI
const slotCards = await page.locator('[data-testid^="slot-card-"]').count();
let slotAdded = false;
if (slotCards === 0) {
  const opts = await page.locator('[data-testid="wb-add-strategy"] option').count();
  if (opts > 1) { await page.selectOption('[data-testid="wb-add-strategy"]', { index: 1 }); await page.click('[data-testid="wb-add-btn"]'); slotAdded = true; await page.waitForTimeout(300); }
}
await page.fill('[data-testid="wb-name"]', 'tester017 r5 prod ui');
await page.selectOption('[data-testid="wb-symbol"]', '510050');
await page.selectOption('[data-testid="wb-period"]', 'D1');
await page.fill('[data-testid="wb-date-from"]', '2026-06-01');
await page.fill('[data-testid="wb-date-to"]', '2026-08-01');
await page.fill('[data-testid="wb-initial-capital"]', '100000');
await page.click('[data-testid="wb-submit"]');

let polled = null;
for (let i = 0; i < 120; i++) {
  const own = R.submit_response?.body?.id;
  if (own) {
    const mine = await page.evaluate(async (id) => { const r = await fetch(`/api/workbench/runs/${id}`); if (!r.ok) return { status: 'http_'+r.status }; const b = await r.json(); return { id: b.id, status: b.status, progress: b.progress, fee: b.config?.fee }; }, own);
    polled = mine;
    if (['succeeded','failed','canceled'].includes(mine.status)) break;
  }
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(1200);
await shot('r5p_03_run_submitted.png');
const resultViewVisible = (await page.locator('[data-testid="wb-result"]').count()) > 0;
step('R5-2-ui-submit-etf-run-succeeded', polled?.status === 'succeeded', { slot_added_via_ui: slotAdded, newest_run: polled, submit_http: R.submit_response ? { status: R.submit_response.status, id: R.submit_response.body?.id, fee: R.submit_response.body?.config?.fee } : null, result_view_visible: resultViewVisible });

const runId = R.submit_response?.body?.id ?? polled?.id;
R.run_readback = await page.evaluate(async (id) => { const r = await fetch(`/api/workbench/runs/${id}`); const b = await r.json(); return { status: r.status, run_status: b.status, fee: b.config?.fee, fee_keys: Object.keys(b.config?.fee ?? {}).sort() }; }, runId);
const rb = R.run_readback;
step('R5-2b-run-pinned-fee-flat-stamp-zero', rb.status === 200 && !rb.fee_keys.includes('effective') && !rb.fee_keys.includes('profile') && rb.fee?.stamp_duty_pct === 0, rb);

// same-origin trial echo (effective) — mirrors MCP解析点
R.trial_echo = await page.evaluate(async () => {
  const r = await fetch('/api/strategies/test-run', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version_id: 'sv_1789013713975_000001', symbol: '510050', period: 'D1', from: '2026-06-01T00:00:00Z', to: '2026-08-01T00:00:00Z', mode: 'sim_position', fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 } }) });
  const b = await r.json(); const t = b.trades ?? [];
  return { status: r.status, effective: b.fee?.effective, symbol_type: b.fee?.symbol_type, not_modeled: b.fee?.profile?.not_modeled, trades: t.length, stamp_sum: t.reduce((a, x) => a + (x.stamp_duty ?? 0), 0) };
});
step('R5-2c-trial-echo-effective-stamp-zero-source-explicit', R.trial_echo.status === 200 && R.trial_echo.effective?.stamp_duty_pct === 0 && R.trial_echo.effective?.source === 'explicit' && R.trial_echo.symbol_type === 'etf', R.trial_echo);

await page.waitForTimeout(800);
await shot('r5p_04_final.png');
const consoleErrors = R.consoles.filter((c) => c.type === 'error');
step('R5-4-no-console-error-no-uncaught-exception', consoleErrors.length === 0 && R.pageerrors.length === 0 && R.requestfailed.length === 0, { console_errors: consoleErrors, pageerrors: R.pageerrors, requestfailed: R.requestfailed });

R.finished_at = new Date().toISOString(); R.console_error_count = consoleErrors.length;
fs.writeFileSync(path.join(OUT, 'r5p_result.json'), JSON.stringify(R, null, 1));
fs.writeFileSync(path.join(OUT, 'r5p_console.log'), R.consoles.map((c) => `[${c.type}] ${c.text}`).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'r5p_network_api.log'), R.api_responses.map((x) => `${x.status} ${x.method} ${x.url}`).join('\n') + '\n');
await browser.close();
const failed = R.steps.filter((s) => !s.ok);
console.log(`\n== R5p: ${R.steps.length - failed.length}/${R.steps.length} checks passed ==`);
if (failed.length) console.log('FAILED:', failed.map((f) => f.step).join(', '));
process.exit(failed.length ? 1 : 0);
