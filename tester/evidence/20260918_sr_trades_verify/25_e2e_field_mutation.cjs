// Executed frontend field-mutation experiment (read-only; NO repo/DB writes).
// Baseline page shows 1 row in the "交易明细" tab while the same page reports
// "成交 43 笔（精确源 /fills）". We intercept GET .../result and replace
// `trades` with 43 synthesized entries to prove the row count is bound to that
// field (observable difference = 1 vs 43).
const { chromium } = require('playwright');

const RUN = 'sr_1789738328788_000005';

async function openAndCount(page) {
  await page.goto('http://127.0.0.1:8081/backtest-workbench', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.evaluate((id) => {
    const els = Array.from(document.querySelectorAll('*'));
    const hit = els.find((e) => e.children.length === 0 && (e.textContent || '').trim() === id);
    (hit && (hit.closest('[data-testid],li,tr,div') || hit).click());
  }, RUN);
  await page.waitForTimeout(2500);
  return await page.locator('[data-testid^="wb-trade-row-"]').count();
}

(async () => {
  const browser = await chromium.launch();

  // ---- baseline ----
  const p1 = await browser.newPage();
  const baseline = await openAndCount(p1);
  const note1 = await p1.locator('[data-testid="wb-fills-note"]').innerText().catch(() => null);
  await p1.close();

  // ---- mutation: swap trades <- 43 synthesized rows ----
  const p2 = await browser.newPage();
  await p2.route('**/api/workbench/runs/*/result*', async (route) => {
    const resp = await route.fetch();
    const j = await resp.json();
    const synth = [];
    for (let i = 0; i < 43; i++) {
      synth.push({
        open_ts: 1768838400 + i * 86400, close_ts: 1789574400 + i,
        open_price: 9.0, close_price: 9.1, shares: 1, pnl: 1, hold_bars: 1,
        open_bar: 1, close_bar: 2, commission: 0, stamp_duty: 0,
        gross_value: 1,
      });
    }
    j.trades = synth;
    await route.fulfill({ response: resp, json: j, headers: { ...resp.headers(), 'content-type': 'application/json' } });
  });
  const mutated = await openAndCount(p2);
  await p2.close();

  await browser.close();
  console.log(JSON.stringify({
    baselineTradeRows: baseline,
    fillsNote: note1,
    mutatedTradeRowsWhenTradesReplacedWith43: mutated,
    observableDifference: mutated - baseline,
  }, null, 2));
})().catch((e) => { console.error('E2E ERROR:', e); process.exit(1); });
