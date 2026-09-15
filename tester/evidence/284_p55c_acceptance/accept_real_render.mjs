/**
 * P5.5-C 独立验收 —— 真渲染（Chromium + 临时 vite dev server @5391，代理 GET 到线上后端**只读**）
 * 线上写请求（PUT /api/config/multi_period）在**浏览器侧本地兑现**（page.route fulfill）⇒ 不触碰线上配置。
 * 本文件为临时夹具（跑完删除）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('@playwright/test');

const BASE = process.env.P55C_BASE ?? 'http://127.0.0.1:5391';
const OUT = process.env.P55C_OUT ?? '/tmp/p55c_evidence';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const pageErrors = [];
const consoleErrors = [];
const puts = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
};

// 浏览器侧"服务端"（本地兑现）：GET 返回当前配置；PUT 校验后回显或按注入开关返回 400。
let localCfg = { enabled: true, periods: ['1m', '5m'], heights: { '1m': 420, '5m': 180 }, indicators: ['dcap'] };
let rejectNextPut = false;

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.route('**/api/config/multi_period', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 200, json: localCfg });
    const body = JSON.parse(req.postData() ?? '{}');
    puts.push(body);
    if (rejectNextPut) {
      rejectNextPut = false;
      return route.fulfill({ status: 400, json: { error: 'HTTP 400: injected server rejection（验收注入）' } });
    }
    // 最小服务端校验（与真后端同口径的子集）：periods ≤4 / 卫星 ≥ 基准 / heights 键一致
    const rank = ['1m', '5m', '15m', '1h', '1d', '1w'].indexOf(body.periods?.[0] ?? '');
    const bad =
      !body.periods || body.periods.length === 0 || body.periods.length > 4 || rank < 0 ||
      body.periods.slice(1).some((p) => ['1m', '5m', '15m', '1h', '1d', '1w'].indexOf(p) < rank) ||
      Object.keys(body.heights ?? {}).length !== body.periods.length;
    if (bad) return route.fulfill({ status: 400, json: { error: 'HTTP 400: injected validation failure' } });
    localCfg = body;
    return route.fulfill({ status: 200, json: body });
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-region="symbol-list"] button', { timeout: 30000 });
  await page.waitForTimeout(3000);

  // R0 前置
  const canvas0 = await page.locator('canvas').count();
  record('R0.基础渲染', canvas0 > 0, `canvas=${canvas0}；pageerror=${pageErrors.length}`);

  // R1 初始配置 enabled=true(1m,5m) ⇒ 选择器入口可用；基准 1m ≠ 工具栏 15m ⇒ 覆盖徽标可见
  const openBtn = page.locator('[data-testid="mp-periods-open"]');
  const sats0 = await page.locator('[data-mp-satellite]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mp-satellite')));
  record(
    'R1.入口与前置覆盖态',
    (await openBtn.count()) === 1 && JSON.stringify(sats0) === JSON.stringify(['5m']) && (await page.locator('[data-mp-base-override]').count()) === 1,
    `入口=${await openBtn.count()}；卫星=${JSON.stringify(sats0)}；覆盖徽标=${await page.locator('[data-mp-base-override]').count()}`,
  );

  // R2 步骤 1 全集（无 1mo）
  await openBtn.click();
  await page.waitForSelector('[data-testid="mp-picker"]');
  const baseButtons = await page.locator('[data-testid="mp-picker"] [data-mp-base-period]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mp-base-period')));
  record('R2.步骤1全集', JSON.stringify(baseButtons) === JSON.stringify(['1m', '5m', '15m', '1h', '1d', '1w']), `step1=${JSON.stringify(baseButtons)}`);

  // R3 base=1m ⇒ 候选 ≥1m（无 1mo），1w 出现但禁用 + 原因
  await page.click('[data-mp-base-period="1m"]');
  await page.waitForTimeout(250);
  const cand1m = await page.locator('[data-testid="mp-picker"] [data-mp-indicator-period]').evaluateAll((els) =>
    els.map((e) => ({ p: e.getAttribute('data-mp-indicator-period'), disabled: e.disabled })),
  );
  const reason1m = ((await page.locator('[data-mp-indicator-reason="1w"]').textContent()) ?? '').trim();
  record(
    'R3.base=1m候选收窄',
    JSON.stringify(cand1m.map((c) => c.p)) === JSON.stringify(['1m', '5m', '15m', '1h', '1d', '1w']) &&
      cand1m.find((c) => c.p === '1w').disabled === true &&
      reason1m !== '' &&
      !cand1m.some((c) => c.p === '1mo'),
    `候选=${JSON.stringify(cand1m)}；1w 原因="${reason1m}"`,
  );
  await page.screenshot({ path: `${OUT}/R3_base1m.png` });

  // R4 base=1d ⇒ 候选 = {1d,1w} 且 1w 可选
  await page.click('[data-mp-base-period="1d"]');
  await page.waitForTimeout(250);
  const cand1d = await page.locator('[data-testid="mp-picker"] [data-mp-indicator-period]').evaluateAll((els) =>
    els.map((e) => ({ p: e.getAttribute('data-mp-indicator-period'), disabled: e.disabled })),
  );
  record(
    'R4.base=1d出现1w',
    JSON.stringify(cand1d) === JSON.stringify([{ p: '1d', disabled: false }, { p: '1w', disabled: false }]),
    `候选=${JSON.stringify(cand1d)}`,
  );
  await page.screenshot({ path: `${OUT}/R4_base1d.png` });

  // R5 回 1m，选满 3 ⇒ 第 4 个禁用 + 原因
  await page.click('[data-mp-base-period="1m"]');
  await page.waitForTimeout(200);
  for (const p of ['5m', '15m', '1h']) {
    await page.click(`[data-mp-indicator-period="${p}"]`);
    await page.waitForTimeout(120);
  }
  const d4 = await page.locator('[data-mp-indicator-period="1d"]').isDisabled();
  const reason4 = ((await page.locator('[data-mp-indicator-reason="1d"]').textContent()) ?? '').trim();
  const hint = ((await page.locator('[data-mp-picker-hint]').textContent()) ?? '').trim();
  record('R5.上限3第4禁用', d4 === true && reason4 !== '', `第4禁用=${d4}；原因="${reason4}"；提示="${hint}"`);
  await page.screenshot({ path: `${OUT}/R5_three_selected.png` });

  // R6 提交 ⇒ periods[0]=1m=state.period、覆盖徽标消失、卫星 5m/15m/1h、请求往返可见
  const putsBefore = puts.length;
  await page.click('[data-testid="mp-picker-confirm"]');
  await page.waitForTimeout(2500);
  const sats = await page.locator('[data-mp-satellite]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mp-satellite')));
  const basePane = await page.locator('[data-mp-pane-role="base"]').first().getAttribute('data-mp-pane');
  const override = await page.locator('[data-mp-base-override]').count();
  const sent = puts.slice(putsBefore).at(-1);
  const toolbarPeriod = await page
    .locator('[data-region="toolbar"] button[aria-pressed="true"]')
    .evaluateAll((els) => els.map((e) => e.textContent.trim()));
  const periodBtnPressed = await page.locator('[data-region="toolbar"] button[aria-pressed="true"]').allTextContents();
  record(
    'R6.提交一致性与往返',
    JSON.stringify(sats) === JSON.stringify(['5m', '15m', '1h']) &&
      basePane === '1m' &&
      override === 0 &&
      JSON.stringify(sent?.periods) === JSON.stringify(['1m', '5m', '15m', '1h']) &&
      periodBtnPressed.includes('1m'),
    `卫星=${JSON.stringify(sats)}；基准pane=${basePane}；覆盖徽标=${override}；PUT body=${JSON.stringify(sent)}；工具栏选中=${JSON.stringify(toolbarPeriod)}`,
  );

  // R7 布局：pane 高度和 == 可用、无溢出、卫星内 DCAP canvas
  const geom = await page.evaluate(() => {
    const stack = document.querySelector('[data-mp-stack]');
    const panes = Array.from(document.querySelectorAll('[data-mp-pane]'));
    const sat = document.querySelector('[data-mp-satellite]');
    const canvas = Array.from(document.querySelectorAll('[data-mp-satellite] canvas'));
    return {
      stackScrollable: stack?.getAttribute('data-mp-stack-scrollable') ?? null,
      stackOverflow: stack ? stack.scrollHeight - stack.clientHeight : null,
      paneSum: panes.reduce((a, e) => a + Number(e.getAttribute('data-mp-pane-height') || 0), 0),
      paneCount: panes.length,
      satCanvas: sat ? sat.querySelectorAll('canvas').length : 0,
      allSatCanvas: canvas.length,
      docOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  record(
    'R7.布局与DCAP渲染',
    geom.paneCount === 4 && geom.paneSum > 0 && geom.stackOverflow === 0 && geom.satCanvas > 0 && geom.docOverflow <= 2,
    JSON.stringify(geom),
  );
  await page.screenshot({ path: `${OUT}/R7_after_confirm.png` });

  // R8 关闭 ⇒ 零残留
  await page.getByRole('button', { name: '多周期', exact: true }).click();
  await page.waitForTimeout(1800);
  const satsAfter = await page.locator('[data-mp-satellite]').count();
  const panesAfter = await page.locator('[data-mp-pane]').count();
  const stackAfter = await page.locator('[data-mp-stack]').count();
  const offBody = puts.at(-1);
  record(
    'R8.关闭零残留',
    satsAfter === 0 && panesAfter === 0 && stackAfter === 0 && offBody.enabled === false,
    `卫星=${satsAfter}；pane=${panesAfter}；stack=${stackAfter}；PUT body=${JSON.stringify(offBody)}`,
  );
  await page.screenshot({ path: `${OUT}/R8_off.png` });

  // R9 宫格 ⇒ 多周期区域隐藏
  await page.getByRole('button', { name: '2×2' }).click();
  await page.waitForTimeout(900);
  const mpVisible = await page.locator('[data-region="toolbar"] button:has-text("多周期")').count();
  record('R9.宫格隐藏多周期', mpVisible === 0, `宫格下「多周期」按钮数=${mpVisible}`);

  // R10 重新启用（回到单图） + 注入服务端 400：绕过前端校验的提交必须可见报错 + 回滚
  await page.getByRole('button', { name: '单图' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '多周期', exact: true }).click();
  await page.waitForTimeout(1200);
  const reEnableBody = puts.at(-1);
  const satsRe = await page.locator('[data-mp-satellite]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mp-satellite')));
  await page.locator('[data-testid="mp-periods-open"]').click();
  await page.waitForSelector('[data-testid="mp-picker"]');
  await page.click('[data-mp-base-period="15m"]');
  await page.waitForTimeout(150);
  await page.click('[data-mp-indicator-period="1h"]');
  rejectNextPut = true;
  await page.click('[data-testid="mp-picker-confirm"]');
  await page.waitForTimeout(1500);
  const errText = ((await page.locator('[data-testid="mp-picker-error"]').textContent()) ?? '').trim();
  const satsAfterFail = await page.locator('[data-mp-satellite]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mp-satellite')));
  const basePaneAfterFail = await page.locator('[data-mp-pane-role="base"]').first().getAttribute('data-mp-pane');
  const pickerStillOpen = await page.locator('[data-testid="mp-picker"]').count();
  const putBodiesTail = puts.slice(-1)[0];
  record(
    'R10.失败注入回滚+可见报错',
    errText.includes('400') && JSON.stringify(satsAfterFail) === JSON.stringify(satsRe) && basePaneAfterFail === reEnableBody.periods[0] && pickerStillOpen === 1,
    `报错="${errText}"；失败后卫星=${JSON.stringify(satsAfterFail)}（提交前=${JSON.stringify(satsRe)}）；基准pane=${basePaneAfterFail}；选择器仍开=${pickerStillOpen}；注入 PUT body=${JSON.stringify(putBodiesTail)}`,
  );
  await page.screenshot({ path: `${OUT}/R10_put_fail.png` });

  record('R11.无 page error', pageErrors.length === 0, `pageerrors=${JSON.stringify(pageErrors.slice(0, 3))}`);

  await browser.close();
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, results, pageErrors, consoleErrors: consoleErrors.slice(0, 20), puts }, null, 2));
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed; failed=${JSON.stringify(failed)}`);
  process.exitCode = failed.length ? 1 : 0;
};

run().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exitCode = 2;
});
