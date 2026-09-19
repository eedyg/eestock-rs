// Read-only E2E observation of the workbench UI for run sr_1789738328788_000005.
// Navigates the live app at 127.0.0.1:8081, selects the run, and records:
//   - "交易明细" tab (default) row count = data-testid wb-trade-row-*
//   - K-line fills note / marker count (fills source)
// No DB writes, no repo writes. Only browser navigation + DOM reads.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const apiCalls = [];
  page.on('request', (r) => { if (r.url().includes('/api/workbench/runs/')) apiCalls.push(r.url()); });

  await page.goto('http://127.0.0.1:8081/backtest-workbench', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);

  // find and click the run in the history list
  const target = 'sr_1789738328788_000005';
  const clicked = await page.evaluate((id) => {
    const els = Array.from(document.querySelectorAll('*'));
    const hit = els.find((e) => e.children.length === 0 && (e.textContent || '').trim() === id);
    if (!hit) return false;
    hit.closest('[data-testid],li,tr,div')?.click?.() || hit.click();
    return true;
  }, target);
  await page.waitForTimeout(2500);

  // widen: also try clicking the containing row via text search
  const foundRows = await page.locator(`text=${target}`).count();

  const defaultTab = await page.locator('[data-testid="wb-tab-trades"]').count();
  const tradeRows = await page.locator('[data-testid^="wb-trade-row-"]').count();
  const tradesTable = await page.locator('[data-testid="wb-trades-table"]').count();
  const tradesTableText = tradesTable ? (await page.locator('[data-testid="wb-trades-table"]').innerText()).slice(0, 400) : null;
  const fillsNote = await page.locator('[data-testid="wb-fills-note"]').count();
  const fillsNoteText = fillsNote ? await page.locator('[data-testid="wb-fills-note"]').innerText() : null;
  // K-line marker count: lightweight-charts renders canvas; count via the series data note + any marker DOM
  const klineCircles = await page.locator('[data-testid="wb-kline-chart"] circle').count();
  const html = await page.content();

  const out = {
    url: page.url(),
    runTextMatches: foundRows,
    clicked,
    defaultTradesTabPresent: defaultTab,
    tradesTablePresent: tradesTable,
    tradesTableText,
    tradeRowCount: tradeRows,
    fillsNotePresent: fillsNote,
    fillsNoteText,
    klineCircleMarkers: klineCircles,
    apiCalls,
    consoleErrors,
  };
  console.log(JSON.stringify(out, null, 2));
  // screenshot for the record
  await page.screenshot({ path: '20_workbench_e2e.png', fullPage: false });
  await browser.close();
})().catch((e) => { console.error('E2E ERROR:', e); process.exit(1); });
