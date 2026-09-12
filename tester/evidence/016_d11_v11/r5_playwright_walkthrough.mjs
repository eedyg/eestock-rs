// 016 D11 v1.1 R-5 前端实跑走查（Playwright/chromium，真实浏览器 + 替代端口实例 :18081）。
// 只观察、只断言：不改前端、不改后端、不重启生产。用后由外层拆除替代实例。
//
// 运行: node tester/evidence/016_d11_v11/r5_playwright_walkthrough.mjs
// 产物: 同目录 r5/ 下 截图 + console/network 原始日志 + r5_result.json

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:18081';
const OUT = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/016_d11_v11/r5';
const RUN_CONFIG_PRESET_ID = 'sp_1789225140594_000002'; // 预设：由新 run config 建立（后端探针 http_09）
const DISTINCT_PRESET_ID = 'sp_1789225147731_000003'; // 预设：扁平 fee 取值与表单默认不同（0.011/3.5/7.25）
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

fs.mkdirSync(OUT, { recursive: true });

const R = {
  base: BASE,
  started_at: new Date().toISOString(),
  steps: [],
  consoles: [],
  pageerrors: [],
  requestfailed: [],
  api_responses: [],
  submit_response: null,
  run_readback: null,
  trial_echo: null,
  preset_from_run: null,
  ui_preset_save: null,
  screenshots: [],
};
const step = (name, ok, detail) => {
  R.steps.push({ step: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

page.on('console', (m) => R.consoles.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => R.pageerrors.push(String(e)));
page.on('requestfailed', (r) =>
  R.requestfailed.push({ url: r.url(), method: r.method(), failure: r.failure()?.errorText ?? null }),
);
page.on('response', async (resp) => {
  const url = resp.url();
  if (!url.includes('/api/')) return;
  const rec = { method: resp.request().method(), url, status: resp.status() };
  R.api_responses.push(rec);
  if (rec.method === 'POST' && url.endsWith('/api/workbench/runs')) {
    try {
      R.submit_response = { status: resp.status(), body: await resp.json() };
    } catch {
      R.submit_response = { status: resp.status(), body: null };
    }
  }
});

const shot = async (name) => {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p, fullPage: false });
  R.screenshots.push(p);
};

// ── 打开工作台 ──
await page.goto(`${BASE}/backtest-workbench`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="wb-config"]', { timeout: 30000 });
await page.waitForFunction(
  () => (document.querySelector('[data-testid="wb-preset-select"]')?.options?.length ?? 0) > 1,
  { timeout: 30000 },
);
step('open-workbench', true, { url: page.url() });

// ── ① 应用一个预设 → 费用输入框应显示数值 ──
const before = await page.locator('[data-testid="wb-fee-rate"]').inputValue();
await page.selectOption('[data-testid="wb-preset-select"]', RUN_CONFIG_PRESET_ID);
await page.waitForTimeout(700);
const feeVals = {
  rate: await page.locator('[data-testid="wb-fee-rate"]').inputValue(),
  min: await page.locator('[data-testid="wb-fee-min"]').inputValue(),
  slippage: await page.locator('[data-testid="wb-fee-slippage"]').inputValue(),
};
const feeBad = Object.values(feeVals).some(
  (v) => v === '' || v === 'undefined' || v === 'NaN' || Number.isNaN(Number(v)),
);
const presetMsg = (await page.locator('[data-testid="wb-preset-msg"]').count())
  ? await page.locator('[data-testid="wb-preset-msg"]').innerText()
  : null;
await shot('r5_01_preset_applied.png');
step('R5-1-apply-preset-fee-inputs-are-numbers', !feeBad, {
  before_default: before,
  after_apply: feeVals,
  preset_msg: presetMsg,
});

// ① 加强证据：应用**取值与表单默认不同**的预设（0.011/3.5/7.25）→ 输入框必须等于预设值
await page.selectOption('[data-testid="wb-preset-select"]', DISTINCT_PRESET_ID);
await page.waitForTimeout(700);
const feeVals2 = {
  rate: await page.locator('[data-testid="wb-fee-rate"]').inputValue(),
  min: await page.locator('[data-testid="wb-fee-min"]').inputValue(),
  slippage: await page.locator('[data-testid="wb-fee-slippage"]').inputValue(),
};
const expected2 = { rate: '0.011', min: '3.5', slippage: '7.25' };
const match2 = feeVals2.rate === expected2.rate && feeVals2.min === expected2.min && feeVals2.slippage === expected2.slippage;
await shot('r5_01b_preset_applied_distinct.png');
step('R5-1b-apply-preset-populates-inputs-from-config(not defaults)', match2, {
  applied: feeVals2, expected: expected2, form_defaults: ['0.025', '5', '2'],
});
// 回到 from-run 预设（后续 UI 保存路径沿用）
await page.selectOption('[data-testid="wb-preset-select"]', RUN_CONFIG_PRESET_ID);
await page.waitForTimeout(500);

// ── ② UI 提交一次 ETF 回测 ──
const slotCards = await page.locator('[data-testid^="slot-card-"]').count();
let slotAdded = false;
if (slotCards === 0) {
  const opts = await page.locator('[data-testid="wb-add-strategy"] option').count();
  if (opts > 1) {
    await page.selectOption('[data-testid="wb-add-strategy"]', { index: 1 });
    await page.click('[data-testid="wb-add-btn"]');
    slotAdded = true;
    await page.waitForTimeout(300);
  }
}
await page.fill('[data-testid="wb-name"]', 'tester016 r5 ui');
await page.selectOption('[data-testid="wb-symbol"]', '510050');
await page.selectOption('[data-testid="wb-period"]', 'D1');
await page.fill('[data-testid="wb-date-from"]', '2026-06-01');
await page.fill('[data-testid="wb-date-to"]', '2026-08-01');
await page.fill('[data-testid="wb-initial-capital"]', '100000');
await page.click('[data-testid="wb-submit"]');

// 等待 run 成功（轮询同源 REST，与前端同路径）
let polled = null;
for (let i = 0; i < 120; i++) {
  polled = await page.evaluate(async () => {
    const r = await fetch('/api/workbench/runs?limit=1');
    if (!r.ok) return { error: r.status };
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? { id: row.id, status: row.status, progress: row.progress, fee: row.config?.fee } : null;
  });
  const own = R.submit_response?.body?.id;
  if (own) {
    const mine = await page.evaluate(async (id) => {
      const r = await fetch(`/api/workbench/runs/${id}`);
      if (!r.ok) return { status: 'http_' + r.status };
      const b = await r.json();
      return { id: b.id, status: b.status, progress: b.progress, fee: b.config?.fee };
    }, own);
    if (['succeeded', 'failed', 'canceled'].includes(mine.status)) { polled = mine; break; }
  }
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(1200);
await shot('r5_02_run_submitted.png');
const resultViewVisible = (await page.locator('[data-testid="wb-result"]').count()) > 0;
step('R5-2-ui-submit-etf-run-succeeded', polled?.status === 'succeeded', {
  slot_added_via_ui: slotAdded,
  newest_run: polled,
  submit_http: R.submit_response ? { status: R.submit_response.status, fee: R.submit_response.body?.config?.fee, id: R.submit_response.body?.id } : null,
  result_view_visible: resultViewVisible,
});

// 读回该 run 的钉住 config.fee（真实浏览器同源 GET）
const runId = R.submit_response?.body?.id ?? polled?.id;
R.run_readback = await page.evaluate(async (id) => {
  const r = await fetch(`/api/workbench/runs/${id}`);
  const body = await r.json();
  return { status: r.status, run_status: body.status, fee: body.config?.fee, fee_keys: Object.keys(body.config?.fee ?? {}).sort() };
}, runId);
const rb = R.run_readback;
step('R5-2b-run-pinned-fee-flat-and-etf-stamp-zero', rb.status === 200
  && !rb.fee_keys.includes('effective') && !rb.fee_keys.includes('profile')
  && rb.fee?.stamp_duty_pct === 0, rb);

// ② 响应回显 effective（真实浏览器同源 POST 试算，与 MCP 同服务层解析点）
R.trial_echo = await page.evaluate(async () => {
  const r = await fetch('/api/strategies/test-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version_id: 'sv_1789013713975_000001', symbol: '510050', period: 'D1',
      from: '2026-06-01T00:00:00Z', to: '2026-08-01T00:00:00Z', mode: 'sim_position',
      fee: { rate_pct: 0.025, min_fee: 5, slippage_bp: 2 },
    }),
  });
  const body = await r.json();
  const trades = body.trades ?? [];
  return {
    status: r.status,
    effective: body.fee?.effective,
    symbol_type: body.fee?.symbol_type,
    not_modeled: body.fee?.profile?.not_modeled,
    trades: trades.length,
    stamp_sum: trades.reduce((a, t) => a + (t.stamp_duty ?? 0), 0),
  };
});
step('R5-2c-trial-echo-effective-stamp-zero-source-explicit',
  R.trial_echo.status === 200 && R.trial_echo.effective?.stamp_duty_pct === 0
  && R.trial_echo.effective?.source === 'explicit' && R.trial_echo.symbol_type === 'etf',
  R.trial_echo);

// ── ③ 用该 run 的 config 新建预设（前端路径；真实浏览器同源 POST） ──
R.preset_from_run = await page.evaluate(async (id) => {
  const run = await (await fetch(`/api/workbench/runs/${id}`)).json();
  const r = await fetch('/api/workbench/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `r5-pw-fromrun-${Date.now()}`, config: run.config }),
  });
  const body = await r.json();
  return { status: r.status, id: body.id ?? null, fee: body.config?.fee ?? null, error: body.error ?? null };
}, runId);
step('R5-3a-preset-from-run-config-http-2xx-not-400',
  R.preset_from_run.status >= 200 && R.preset_from_run.status < 300, R.preset_from_run);

// ③ UI 路径：清空预设选择 → 填名字 → 点「保存」（新建预设）
await page.selectOption('[data-testid="wb-preset-select"]', '');
await page.fill('[data-testid="wb-preset-name"]', `r5-ui-preset-${TS}`);
await page.click('[data-testid="wb-preset-save"]');
let presetUiMsg = null;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(300);
  if ((await page.locator('[data-testid="wb-preset-msg"]').count()) > 0) {
    presetUiMsg = await page.locator('[data-testid="wb-preset-msg"]').innerText();
    if (presetUiMsg && /保存|失败/.test(presetUiMsg)) break;
  }
}
await shot('r5_03_ui_preset_saved.png');
R.ui_preset_save = { msg: presetUiMsg };
step('R5-3b-ui-save-preset-message', /已保存预设/.test(presetUiMsg ?? ''), R.ui_preset_save);

// ── ④ console error / 未捕获异常 ──
await page.waitForTimeout(800);
await shot('r5_04_final.png');
const consoleErrors = R.consoles.filter((c) => c.type === 'error');
step('R5-4-no-console-error-no-uncaught-exception',
  consoleErrors.length === 0 && R.pageerrors.length === 0 && R.requestfailed.length === 0,
  { console_errors: consoleErrors, pageerrors: R.pageerrors, requestfailed: R.requestfailed });

R.finished_at = new Date().toISOString();
R.console_error_count = consoleErrors.length;
fs.writeFileSync(path.join(OUT, 'r5_result.json'), JSON.stringify(R, null, 1));
fs.writeFileSync(path.join(OUT, 'r5_console.log'), R.consoles.map((c) => `[${c.type}] ${c.text}`).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'r5_network_api.log'),
  R.api_responses.map((x) => `${x.status} ${x.method} ${x.url}`).join('\n') + '\n');

await browser.close();
const failed = R.steps.filter((s) => !s.ok);
console.log(`\n== R5 walkthrough: ${R.steps.length - failed.length}/${R.steps.length} checks passed ==`);
if (failed.length) console.log('FAILED CHECKS:', failed.map((f) => f.step).join(', '));
process.exit(failed.length ? 1 : 0);
