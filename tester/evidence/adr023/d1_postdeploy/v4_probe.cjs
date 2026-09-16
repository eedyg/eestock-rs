// ADR-023 D1 post-deploy acceptance: READ-ONLY browser probe against live instance :8081
// No writes: no PUT/POST/DELETE/PATCH is issued by this script. Only navigation + GET + WS subscribe.
const { chromium } = require('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright');
const fs = require('fs');

const OUT = '/tmp/adr023-postdeploy-20260916T151312Z';
const BASE = 'http://127.0.0.1:8081';
const PERIOD_LABELS = ['1m', '5m', '15m', '30m', '1h', '日', '周', '月'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const result = { base: BASE, startedAt: new Date().toISOString() };
  const requests = [];
  const responses = [];
  const consoleMsgs = [];
  const pageErrors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), rt: r.resourceType() }));
  page.on('response', (r) => responses.push({ status: r.status(), url: r.url(), method: r.request().method() }));
  page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 500) }));
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 1000)));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // wait for the toolbar period buttons to exist
  await page.waitForFunction(
    (labels) => labels.every((l) => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === l)),
    PERIOD_LABELS,
    { timeout: 30000 }
  );
  await sleep(3000); // let initial kline load + first render settle

  // (a) toolbar: 8 档 + 严格 DOM 顺序
  result.toolbar = await page.evaluate((labels) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const idx = labels.map((l) => btns.findIndex((b) => (b.textContent || '').trim() === l));
    const seq = btns.map((b) => (b.textContent || '').trim());
    return {
      total_buttons: btns.length,
      label_indices: idx,
      contiguous: idx.every((v, i) => i === 0 || (v === idx[i - 1] + 1)) && idx[0] >= 0,
      ordered_first_8: seq.slice(idx[0], idx[0] + 8),
      button_texts_all: seq,
    };
  }, PERIOD_LABELS);
  await page.screenshot({ path: OUT + '/v4_a_default_15m.png', fullPage: false });

  const defaultPeriod = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('aria-pressed') === 'true');
    return b ? (b.textContent || '').trim() : null;
  });
  result.default_period_pressed = defaultPeriod;

  // (b) click 30m -> kline request period=30m & 200
  const beforeClick = requests.length;
  await page.getByRole('button', { name: '30m', exact: true }).first().click();
  await page.waitForResponse(
    (r) => r.url().includes('/api/kline') && r.url().includes('period=30m'),
    { timeout: 20000 }
  ).catch(() => null);
  await sleep(2500);
  result.click_30m = {
    new_requests: requests.slice(beforeClick),
    new_responses: responses.filter((r) => r.url.includes('/api/kline')),
  };
  const k30 = responses.filter((r) => r.url.includes('/api/kline') && r.url.includes('period=30m'));
  result.kline_30m_responses = k30;

  // (c)(d) real render: canvas pixels + data-viewport-fit
  await page.waitForTimeout(1500);
  result.render = await page.evaluate(() => {
    const fitEl = document.querySelector('[data-viewport-fit]');
    const fitRaw = fitEl ? fitEl.getAttribute('data-viewport-fit') : null;
    let fit = null;
    try { fit = fitRaw ? JSON.parse(fitRaw) : null; } catch (e) { fit = { parse_error: String(e), raw: fitRaw }; }
    const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => {
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    });
    // pick largest canvas (main chart)
    const main = Array.from(document.querySelectorAll('canvas')).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    let pix = null;
    if (main) {
      const ctx = main.getContext('2d', { willReadFrequently: true });
      const w = main.width, h = main.height;
      const img = ctx.getImageData(0, 0, w, h).data;
      const cols = new Array(w).fill(0);
      let nonBg = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
          const isBg = a === 0 || (r > 235 && g > 235 && b > 235) || (r < 25 && g < 25 && b < 25);
          const isCandle = (r > 140 && g < 110 && b < 110) || (g > 110 && r < 110 && b < 130);
          if (isCandle) { cols[x]++; }
          if (!isBg) nonBg++;
        }
      }
      let firstCol = -1, lastCol = -1, candleCols = 0;
      for (let x = 0; x < w; x++) { if (cols[x] > 0) { if (firstCol < 0) firstCol = x; lastCol = x; candleCols++; } }
      pix = { width: w, height: h, nonBgPixels: nonBg, candleColumns: candleCols, firstCandleCol: firstCol, lastCandleCol: lastCol,
              leftBlankRatio: firstCol >= 0 ? firstCol / w : null, rightBlankRatio: lastCol >= 0 ? (w - 1 - lastCol) / w : null };
    }
    return { fit_raw: fitRaw, fit, canvases, pixels: pix, window: { w: window.innerWidth, h: window.innerHeight } };
  });

  // fallback: count bars in the last 30m kline payload
  result.last30m = await page.evaluate(async () => {
    const r = await fetch('/api/kline?code=510050&period=30m');
    const j = await r.json();
    return { status: r.status, period: j.period, bars: j.bars ? j.bars.length : null, first: j.bars ? j.bars[0].ts : null, last: j.bars ? j.bars[j.bars.length - 1].ts : null, next_before: j.next_before };
  });

  await page.screenshot({ path: OUT + '/v4_b_30m_main.png', fullPage: false });
  const chartEl = await page.$('canvas');
  if (chartEl) await chartEl.screenshot({ path: OUT + '/v4_b_30m_canvas.png' }).catch(() => {});

  // (f) multi-period picker must NOT offer 30m
  let picker = { opened: false };
  try {
    const opener = page.locator('[data-testid="mp-periods-open"]').first();
    if (await opener.count()) {
      await opener.click();
      await page.waitForSelector('[data-testid="mp-picker"]', { timeout: 8000 });
      picker = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="mp-picker"]');
        const groups = Array.from(root.querySelectorAll('[role="group"]')).map((g) => ({
          label: g.getAttribute('aria-label'),
          buttons: Array.from(g.querySelectorAll('button')).map((b) => (b.textContent || '').trim()),
        }));
        return { opened: true, groups, text: root.innerText.slice(0, 600) };
      });
      await page.screenshot({ path: OUT + '/v4_c_multi_period_picker.png', fullPage: false });
      await page.keyboard.press('Escape');
    }
  } catch (e) {
    picker = { opened: false, error: String(e).slice(0, 300) };
  }
  result.picker = picker;

  // (e) console errors
  result.console = {
    total: consoleMsgs.length,
    errors: consoleMsgs.filter((m) => m.type === 'error'),
    warnings: consoleMsgs.filter((m) => m.type === 'warning').slice(0, 20),
  };
  result.page_errors = pageErrors;

  // (g) WS read-only subscription for bar/period=30m
  result.ws = await page.evaluate(async () => {
    const frames = [];
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const sock = new WebSocket(url);
    const sent = [];
    const openClose = { opened: false, closed: false, error: null };
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 9000);
      sock.onopen = () => {
        openClose.opened = true;
        sock.send(JSON.stringify({ type: 'subscribe', topic: 'bar', code: '510050', period: '30m' }));
        sent.push({ type: 'subscribe', topic: 'bar', code: '510050', period: '30m' });
        setTimeout(() => { try { sock.close(); } catch (e) {} }, 7000);
      };
      sock.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch (err) { frames.push({ raw: String(e.data).slice(0, 200) }); } };
      sock.onerror = () => { openClose.error = 'ws error event'; };
      sock.onclose = () => { openClose.closed = true; clearTimeout(t); resolve(); };
    });
    return { url, sent, openClose, frame_count: frames.length, frames: frames.slice(0, 12) };
  });

  result.finishedAt = new Date().toISOString();
  result.all_requests = requests;
  result.method_histogram = requests.reduce((a, r) => { a[r.method] = (a[r.method] || 0) + 1; return a; }, {});
  result.ws_requests = requests.filter((r) => r.url.startsWith('ws'));

  fs.writeFileSync(OUT + '/v4_probe_result.json', JSON.stringify(result, null, 2));

  console.log(JSON.stringify({
    toolbar: result.toolbar,
    default_period_pressed: result.default_period_pressed,
    kline_30m_responses: result.kline_30m_responses,
    render_fit: result.render.fit,
    render_pixels: result.render.pixels,
    canvases: result.render.canvases,
    last30m: result.last30m,
    picker: result.picker,
    console_errors: result.console.errors,
    console_warning_count: result.console.warnings.length,
    page_errors: result.page_errors,
    ws: { sent: result.ws.sent, openClose: result.ws.openClose, frame_count: result.ws.frame_count, frames: result.ws.frames.slice(0, 6) },
    method_histogram: result.method_histogram,
    write_requests: result.all_requests.filter((r) => ['POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method)),
  }, null, 2));

  await browser.close();
})().catch((e) => { console.error('PROBE_FAILED', e); process.exit(2); });
