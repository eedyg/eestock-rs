// ADR-023 D1 probe 2: multi-period picker must NOT offer 30m (real render, read-only)
const { chromium } = require('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright');
const fs = require('fs');
const OUT = '/tmp/adr023-postdeploy-20260916T151312Z';
const BASE = 'http://127.0.0.1:8081';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const res = { startedAt: new Date().toISOString() };
  const requests = [];
  const consoleMsgs = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300) }));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  // try to open multi-period picker directly
  let opened = false;
  const openerSel = '[data-testid="mp-periods-open"]';
  if (await page.locator(openerSel).count()) {
    await page.locator(openerSel).first().click();
    opened = true;
  } else {
    // click "多周期" toolbar button first (grid mode switch), then the picker opener
    const mp = page.getByRole('button', { name: '多周期', exact: true }).first();
    if (await mp.count()) {
      await mp.click();
      await sleep(2500);
      if (await page.locator(openerSel).count()) { await page.locator(openerSel).first().click(); opened = true; }
    }
  }
  await sleep(1500);
  res.opener_found = opened;
  res.picker_present = await page.locator('[data-testid="mp-picker"]').count();
  if (res.picker_present) {
    res.picker = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="mp-picker"]');
      return {
        groups: Array.from(root.querySelectorAll('[role="group"]')).map((g) => ({
          label: g.getAttribute('aria-label'),
          buttons: Array.from(g.querySelectorAll('button')).map((b) => (b.textContent || '').trim()),
        })),
        innerText: root.innerText.slice(0, 800),
      };
    });
    await page.screenshot({ path: OUT + '/v4_c_multi_period_picker.png' });
  } else {
    res.body_dump = await page.evaluate(() => document.body.innerText.slice(0, 500));
    await page.screenshot({ path: OUT + '/v4_c_picker_not_found.png' });
  }
  res.console_errors = consoleMsgs.filter((m) => m.type === 'error');
  res.method_histogram = requests.reduce((a, r) => { a[r.method] = (a[r.method] || 0) + 1; return a; }, {});
  res.write_requests = requests.filter((r) => ['POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method));
  res.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT + '/v4_probe2_result.json', JSON.stringify({ ...res, requests }, null, 2));
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
})().catch((e) => { console.error('PROBE2_FAILED', e); process.exit(2); });
