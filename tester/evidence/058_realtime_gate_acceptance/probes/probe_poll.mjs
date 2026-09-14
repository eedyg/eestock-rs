/**
 * 阶段 3 独立验收探针 2/2（tester 自建）—— 每分钟兜底 + 幂等合并 + 视口不动 + 「有新数据」提示 + 合并/限流计数。
 *
 * 真实 WS / 真实 HTTP（临时后端 18211，只读 DB）；虚拟时钟（Playwright page.clock pauseAt）驱动分钟节拍。
 * ONLY=P1P4|P2|P3|P5|N 可只跑单个场景（反向证据用）。
 */
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18211';
const GT = process.env.GT ?? BASE;
const H = (p) => `${BASE}/__h/index.html${p}`;
const TRADING = new Date('2026-09-14T02:00:00Z');
const OFFHOURS = new Date('2026-09-12T02:00:00Z');
const ONLY = process.env.ONLY ?? '';
const out = { base: BASE, t0: new Date().toISOString(), only: ONLY, checks: [], scenarios: {} };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name} :: ${JSON.stringify(detail)?.slice(0, 340)}`);
};

async function newPage(browser, { url, clock, hidden = false }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const rec = { klineReqs: [], conns: 0, pageErrors: [] };
  page.on('websocket', () => { rec.conns += 1; });
  page.on('request', (r) => {
    if (r.url().includes('/api/kline')) rec.klineReqs.push({ at: Date.now(), url: r.url().replace(BASE, '') });
  });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e).slice(0, 200)));
  if (hidden) await page.addInitScript(() => Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }));
  if (clock) { await page.clock.install({ time: clock }); await page.clock.pauseAt(clock); }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page, rec };
}
const waitReady = (page) => page.waitForFunction(() => window.__H__?.dataLen() > 0 && window.__H__.status() === 'open', null, { timeout: 20000 });
const st = (page) => page.evaluate(() => {
  const h = window.__H__;
  const c = window.__ACC__?.charts?.at(-1);
  let vr = null, dl = 0, px = null;
  try { vr = c.getVisibleRange(); } catch { vr = null; }
  try { dl = (c.getDataList() ?? []).length; } catch { dl = 0; }
  try { px = c.convertToPixel({ timestamp: Date.parse(h.bars().at(-1).ts) }, { paneId: 'candle_pane' })?.x ?? null; } catch { px = null; }
  return { dataLen: h.dataLen(), status: h.status(), stats: h.stats(), rtCount: h.rtCount(), lastClose: h.bars().at(-1)?.close ?? null, lastTs: h.bars().at(-1)?.ts ?? null, chartLen: dl, vr, lastBarPx: px, follow: h.follow() };
});
const hintCount = (page) => page.locator('[data-testid="kline-new-data-hint"]').count();
const injectBar = (page, ts, close) => page.evaluate(({ ts, close }) => {
  const h = window.__H__;
  return h.inject({ type: 'bar', code: h.code, period: h.period, bar: { ts, open: close, high: close, low: close, close, volume: 1, amount: 1 } });
}, { ts, close });

const browser = await chromium.launch();

// ══════ P1 / P4：分钟兜底节拍 + 幂等合并（交易时段） ══════
async function runP1P4() {
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: TRADING });
  await waitReady(page);
  await page.waitForTimeout(2500);
  const base = rec.klineReqs.length;
  const s0 = await st(page);
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(1200);
  const after1 = rec.klineReqs.slice(base);
  const s1 = await st(page);
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(1200);
  const after2 = rec.klineReqs.slice(base);
  const s2 = await st(page);
  const reqs = after2.map((r) => r.url);
  const onlyLatest = reqs.every((u) => u.includes('limit=5') && !u.includes('before'));
  out.scenarios.P1 = { initialReq: rec.klineReqs[0]?.url, minute1: after1.map((r) => r.url), minute2: reqs, statsBefore: s0.stats, statsAfter1Min: s1.stats, statsAfter2Min: s2.stats, dataLen: s2.dataLen };
  check('P1 每分钟恰 1 次兜底请求（虚拟 2 分钟 ⇒ 2 次 limit=5、无 before）', after1.length === 1 && after2.length === 2 && onlyLatest, out.scenarios.P1);
  check('P1 stats 前进：lastPollOkAt 每次成功兜底后更新、pollFailures=0', s1.stats.lastPollOkAt > (s0.stats.lastPollOkAt ?? 0) && s2.stats.lastPollOkAt > s1.stats.lastPollOkAt && s2.stats.pollFailures === 0, { s0: s0.stats, s1: s1.stats, s2: s2.stats });

  const sA = await st(page);
  const pollOk = await page.evaluate(() => window.__H__.pollNow());
  await page.waitForTimeout(800);
  const sB = await st(page);
  check('P4 真实 HTTP 兜底重复取回同一根：长度不变、不重发（幂等 ignore）',
    pollOk === true && sB.dataLen === sA.dataLen && sB.rtCount === sA.rtCount, { pollOk, lenBefore: sA.dataLen, lenAfter: sB.dataLen, rtBefore: sA.rtCount, rtAfter: sB.rtCount });
  const last = await page.evaluate(() => window.__H__.lastBar());
  await page.evaluate((b) => window.__H__.inject({ type: 'bar', code: window.__H__.code, period: window.__H__.period, bar: b }), last);
  await page.waitForTimeout(600);
  const sC = await st(page);
  check('P4 同 ts 且 OHLCV 完全一致（WS 重复帧）：不写、不 emit（长度+rtCount 均不变）',
    sC.dataLen === sA.dataLen && sC.rtCount === sA.rtCount, { len: sC.dataLen, rt: sC.rtCount });
  const changed = { ...last, close: (last.close ?? 1) + 0.012 };
  await page.evaluate((b) => window.__H__.inject({ type: 'bar', code: window.__H__.code, period: window.__H__.period, bar: b }), changed);
  await page.waitForTimeout(600);
  const sD = await st(page);
  check('P4 同 ts 值变：原地覆盖（长度不变、rtCount +1、末根 close 更新）',
    sD.dataLen === sA.dataLen && sD.rtCount === sA.rtCount + 1 && sD.lastClose === changed.close, { len: sD.dataLen, rt: sD.rtCount, close: sD.lastClose, want: changed.close });
  const laterTs = new Date(Date.parse(last.ts) + 15 * 60 * 1000).toISOString();
  await injectBar(page, laterTs, changed.close + 0.02);
  await page.waitForTimeout(600);
  const sE = await st(page);
  check('P4 更晚 ts：append（长度 +1、rtCount +1、末根 ts = 注入 ts）',
    sE.dataLen === sD.dataLen + 1 && sE.rtCount === sD.rtCount + 1 && sE.lastTs === laterTs, { len: sE.dataLen, rt: sE.rtCount, lastTs: sE.lastTs });
  check('P1/P4 无页面异常（虚拟时钟推进 >15s 触发看门狗重连属预期，不计入失败）', rec.pageErrors.length === 0, { conns: rec.conns, errs: rec.pageErrors });
  await page.context().close();
}

// ══════ P2：document.hidden ⇒ 0 HTTP ══════
async function runP2() {
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: TRADING, hidden: true });
  await waitReady(page);
  await page.waitForTimeout(1500);
  const base = rec.klineReqs.length;
  await page.clock.fastForward(120_000);
  await page.waitForTimeout(1200);
  out.scenarios.P2 = { visibilityState: await page.evaluate(() => document.visibilityState), initial: rec.klineReqs.slice(0, base).map((r) => r.url), after2Min: rec.klineReqs.slice(base).map((r) => r.url), stats: (await st(page)).stats };
  check('P2 document.hidden：虚拟 2 分钟 0 次兜底 HTTP（初始加载 limit=120 除外）', rec.klineReqs.slice(base).length === 0, out.scenarios.P2);
  await page.context().close();
}

// ══════ P3：非交易时段 ⇒ 0 HTTP ══════
async function runP3() {
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: OFFHOURS });
  await waitReady(page);
  await page.waitForTimeout(1500);
  const base = rec.klineReqs.length;
  await page.clock.fastForward(120_000);
  await page.waitForTimeout(1200);
  out.scenarios.P3 = { after2Min: rec.klineReqs.slice(base).map((r) => r.url), conns: rec.conns, stats: (await st(page)).stats };
  check('P3 非交易时段（周六）：虚拟 2 分钟 0 次兜底 HTTP、且无重连（无补偿）', rec.klineReqs.slice(base).length === 0 && rec.conns === 1, out.scenarios.P3);
  await page.context().close();
}

// ══════ P5：宫格合并/限流计数（真实 HTTP） ══════
async function runP5() {
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: TRADING });
  await waitReady(page);
  await page.waitForTimeout(1500);
  const base = rec.klineReqs.length;
  const r1 = await page.evaluate(() => window.__H__.multiPoll());
  await page.waitForTimeout(1200);
  const samePair = rec.klineReqs.slice(base);
  const base2 = rec.klineReqs.length;
  const r2 = await page.evaluate(() => window.__H__.multiPollDistinct());
  await page.waitForTimeout(2000);
  const distinct = rec.klineReqs.slice(base2);
  out.scenarios.P5 = {
    samePairFeeds3: samePair.map((r) => r.url), samePairCount: samePair.length, results1: r1,
    distinctFeeds6: distinct.map((r) => r.url), distinctCount: distinct.length, results2: r2,
  };
  const pair518880 = samePair.filter((r) => r.url.includes('code=518880'));
  check('P5 同一 (code,period) 3 图并发兜底 ⇒ 合并为 1 次 HTTP（3 图 1 请求；6 图共 4 请求 ≠ 6）',
    pair518880.length === 1 && samePair.length === 4 && r1.every(Boolean), { reqs: samePair.map((r) => r.url), count: samePair.length, results: r1 });
  check('P5 6 个不同标的并发兜底 ⇒ 6 次 HTTP（各自 1 次、无重复），全部成功',
    distinct.length === 6 && new Set(distinct.map((r) => r.url)).size === 6 && r2.every(Boolean), distinct.map((r) => r.url));
  await page.context().close();
}

// ══════ N1 / N2：「有新数据」提示与视口 ══════
async function runN() {
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: TRADING });
  await waitReady(page);
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__H__.setFollow(false));
  // 用户等价操作：把视口平移到较早区段（远离最新）⇒ 新 bar 落屏外（诊断 R2 场景）
  await page.evaluate(() => window.__ACC__.charts.at(-1).scrollToDataIndex(30));
  await page.waitForTimeout(900);
  const n0 = await st(page);
  const W = await page.evaluate(() => document.querySelector('[data-testid="kline-chart"]').clientWidth);
  await injectBar(page, new Date(Date.parse(n0.lastTs) + 15 * 60 * 1000).toISOString(), (n0.lastClose ?? 1) + 0.05);
  await page.waitForTimeout(1000);
  const n1 = await st(page);
  const hint1 = await hintCount(page);
  out.scenarios.N1 = { containerWidth: W, follow: n1.follow, vrBefore: n0.vr, vrAfter: n1.vr, lastBarPxBefore: n0.lastBarPx, lastBarPxAfter: n1.lastBarPx, chartLen: [n0.chartLen, n1.chartLen], hint: hint1, rtCount: [n0.rtCount, n1.rtCount], dataLen: [n0.dataLen, n1.dataLen] };
  check('N1 非跟随态 + 新 bar 到屏外（像素 x > 容器宽）：出现「有新数据」提示',
    hint1 === 1 && n1.follow === false && n1.lastBarPx > W, out.scenarios.N1);
  check('N1 提示出现时视口坐标前后不变（from/to/realFrom/realTo 相同）',
    JSON.stringify(n0.vr) === JSON.stringify(n1.vr), { before: n0.vr, after: n1.vr });
  await page.locator('[data-testid="kline-new-data-hint"]').click();
  await page.waitForTimeout(1000);
  const n2 = await st(page);
  const hint2 = await hintCount(page);
  out.scenarios.N1.click = { vrAfterClick: n2.vr, hintAfterClick: hint2, chartLen: n2.chartLen, lastBarPxAfterClick: n2.lastBarPx };
  check('N1 点击提示后：提示消失且视口跳到最新（可见区间右端 = 最后一根）',
    hint2 === 0 && !!n2.vr && n2.vr.to >= n2.chartLen - 2, out.scenarios.N1.click);
  await page.evaluate(() => window.__H__.setFollow(true));
  await page.waitForTimeout(1200);
  const m0 = await st(page);
  await injectBar(page, new Date(Date.parse(m0.lastTs) + 15 * 60 * 1000).toISOString(), (m0.lastClose ?? 1) + 0.03);
  await page.waitForTimeout(1000);
  const m1 = await st(page);
  const hintFollow = await hintCount(page);
  out.scenarios.N2 = { follow: m1.follow, vrBefore: m0.vr, vrAfter: m1.vr, chartLenAfter: m1.chartLen, hint: hintFollow, rtCount: [m0.rtCount, m1.rtCount] };
  check('N2 followLatest 态：无提示且视口跟随最右（可见区间右端 ≥ 最后一根）',
    hintFollow === 0 && m1.follow === true && m1.rtCount === m0.rtCount + 1 && !!m1.vr && m1.vr.to >= m1.chartLen - 2, out.scenarios.N2);
  check('N1/N2 无重连（阈内未静默超时）、无页面异常', rec.conns === 1 && rec.pageErrors.length === 0, { conns: rec.conns, errs: rec.pageErrors });
  await page.context().close();
}

const runners = { P1P4: runP1P4, P2: runP2, P3: runP3, P5: runP5, N: runN };
for (const [k, fn] of Object.entries(runners)) {
  if (!ONLY || ONLY === k) await fn();
}
await browser.close();
const fs = await import('node:fs');
fs.writeFileSync(`/tmp/acc_rec/ev/probe_poll${ONLY ? '_' + ONLY : ''}.json`, JSON.stringify(out, null, 1));
const failed = out.checks.filter((c) => !c.ok);
console.log(`\nchecks: ${out.checks.length - failed.length}/${out.checks.length} passed; failed=${failed.map((f) => f.name).join(' | ') || 'none'}`);
