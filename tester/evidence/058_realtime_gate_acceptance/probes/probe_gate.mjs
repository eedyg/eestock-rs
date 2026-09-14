/**
 * 阶段 3 独立验收探针 1/2（tester 自建）—— 门控阈值行为 + 入站帧复位（真实 WS / 真实 HTTP / 临时后端）。
 *
 * 被测：仓库工作树的真实模块（WsClient / KlineDataFeed / KlineChart），页面由临时后端（18211）同源提供，
 * HTTP 与 WS 都打向该真实后端（只读 DB）。时钟用 Playwright page.clock 控制（门控输入），
 * 网络与 WebSocket 全程真实。
 *
 * 场景：
 *  [T1] 交易时段（桩到周一 10:00）静默 ⇒ >15s 触发 close + 重连 + 状态离开 open + 重连后重订阅
 *  [T2] 重连后一次 HTTP 增量补偿（limit=5、无 before）⇒ 断口（人为截掉的 3 根）被补齐、无空洞/无重复
 *  [T3] 非交易时段（桩到周六 10:00）静默 ⇒ 15s 内不重连、不空转（300s 才自愈；1 小时重连次数 ≤ 预期）
 *  [T4] 任一入站帧（health / quote / bar）复位静默计时 ⇒ 阈值内注入帧不重连
 *  [A]  真实看板页面（非底座）：同一结论端到端复现（WS 连接时间线 + 顶栏 pill + 重订阅 + 补偿 HTTP）
 */
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18211';
const GT = process.env.GT ?? BASE;
const H = (p) => `${BASE}/__h/index.html${p}`;
const TRADING = new Date('2026-09-14T02:00:00Z'); // 周一 10:00 北京 ⇒ trading
const OFFHOURS = new Date('2026-09-12T02:00:00Z'); // 周六 10:00 北京 ⇒ closed
const M = (s) => Math.round(s * 1000);

const out = { base: BASE, t0: new Date().toISOString(), checks: [], scenarios: {}, wsEvents: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name} :: ${JSON.stringify(detail)?.slice(0, 300)}`);
};

async function newPage(browser, { url, clock, hidpi = false }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const rec = { url, conns: [], frames: [], sent: [], klineReqs: [], pageErrors: [] };
  page.on('websocket', (ws) => {
    const e = { at: Date.now(), url: ws.url(), n: rec.conns.length + 1, recv: 0, sent: 0 };
    rec.conns.push(e);
    ws.on('framereceived', (f) => {
      e.recv += 1;
      try {
        const o = JSON.parse(f.payload.toString());
        rec.frames.push({ conn: e.n, at: Date.now(), type: o.type, code: o.code ?? null, barTs: o.bar?.ts ?? null });
      } catch {
        rec.frames.push({ conn: e.n, at: Date.now(), type: 'non-json' });
      }
    });
    ws.on('framesent', (f) => {
      e.sent += 1;
      rec.sent.push({ conn: e.n, at: Date.now(), frame: f.payload.toString().slice(0, 120) });
    });
  });
  page.on('request', (r) => {
    if (r.url().includes('/api/kline')) rec.klineReqs.push({ at: Date.now(), method: r.method(), url: r.url().replace(BASE, '') });
  });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e).slice(0, 200)));
  if (hidpi) await page.addInitScript(() => Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }));
  if (clock) {
    await page.clock.install({ time: clock });
    await page.clock.pauseAt(clock); // 冻结：真实等待不推进虚拟时钟，fastForward 精确推进
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page, rec };
}

const harnessState = (page) =>
  page.evaluate(() => {
    const h = window.__H__;
    const charts = window.__ACC__?.charts ?? [];
    const c = charts[charts.length - 1];
    let dl = [];
    try { dl = (c?.getDataList?.() ?? []).map((b) => b.timestamp); } catch { dl = []; }
    return { status: h.status(), conns: h.conns(), dataLen: h.dataLen(), dataList: h.dataList(), chartTs: dl, stats: h.stats(), timeline: h.timeline() };
  });

/** 等到状态机空闲（WS 事件落定） */
const settle = (page, ms = 400) => page.waitForTimeout(ms);

// ══════════════════════ T1 + T2（底座页，真实后端） ══════════════════════
const browser = await chromium.launch();
{
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: TRADING });
  await page.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0 && window.__H__.status() === 'open', null, { timeout: 20000 });
  await settle(page, 3000); // 等初始 burst（真实 WS 入站）到达
  const s0 = await harnessState(page);
  const t0 = Date.now();
  const lastFrameAt = rec.frames.at(-1)?.at ?? null;
  out.scenarios.T1 = { phase: 'initial', realT: t0, wsConns: rec.conns.length, frames: rec.frames.length, sent: rec.sent.length, lastFrameAgoMs: lastFrameAt ? t0 - lastFrameAt : null, status: s0.status, dataLen: s0.dataLen, stats: s0.stats, connTimeline: rec.conns.map((c) => ({ n: c.n, recv: c.recv, sent: c.sent })) };
  check('T1 初始：单真实 WS 连接 + 状态 open（订阅帧已发出；通道静默 = 真实半开场景）', rec.conns.length === 1 && s0.status === 'open' && rec.sent.some((x) => x.frame.includes('subscribe')), out.scenarios.T1);

  // 14s：尚未到阈值
  await page.clock.fastForward(M(14));
  await settle(page, 400);
  const s14 = await harnessState(page);
  check('T1 交易时段静默 14s：不得重连（阈值 15s）', rec.conns.length === 1 && s14.status === 'open', { conns: rec.conns.length, status: s14.status });

  // 16s：越过 15s ⇒ 必须 close（状态离开 open）
  await page.clock.fastForward(M(2));
  await settle(page, 600);
  const s16 = await harnessState(page);
  check('T1 交易时段静默 >15s：状态离开 open（看门狗主动 close）', s16.status !== 'open', { status: s16.status, timeline: s16.timeline });
  check('T1 越过阈值时尚未重连（退避 1s 未到）', rec.conns.length === 1, { conns: rec.conns.length });

  // 1s 后重连
  await page.clock.fastForward(M(1));
  await settle(page, 2500);
  const sRe = await harnessState(page);
  const reSub = rec.sent.filter((x) => x.conn === 2 && x.frame.includes('subscribe'));
  check('T1 退避 1s 后自动重连（第 2 条真实 WS 连接，状态回 open）', rec.conns.length === 2 && sRe.status === 'open', { conns: rec.conns.length, status: sRe.status, connTimeline: rec.conns.map((c) => ({ n: c.n, recv: c.recv, sent: c.sent })) });
  check('T1 重连后重发全部订阅帧（bar 订阅在列）', reSub.some((x) => x.frame.includes('bar') && x.frame.includes('518880')), { conn2Sent: rec.sent.filter((x) => x.conn === 2).map((x) => x.frame) });
  out.scenarios.T1.afterReconnect = { status: sRe.status, conns: rec.conns.length, sentConn2: rec.sent.filter((x) => x.conn === 2).map((x) => x.frame), timeline: sRe.timeline };
  const t1End = Date.now();
  out.scenarios.T1.realElapsedMs = { toFirstClose: t1End - t0, note: '真实等待仅 ~1.5s；阈值推进由 page.clock.fastForward 驱动' };

  // ── T2：断口补齐（人为截掉最新 3 根 + 一次完整看门狗重连周期）
  const L0 = sRe.dataList;
  await page.evaluate(() => window.__H__.truncateLast(3));
  const afterTrunc = await harnessState(page);
  const reqBefore = rec.klineReqs.length;
  const framesBefore = rec.frames.length;
  await page.clock.fastForward(M(15)); // 静默阈值（前一次重连的 burst 已复位；推进 15s 触发）
  await settle(page, 600);
  const sClosed = await harnessState(page);
  await page.clock.fastForward(M(1)); // 退避
  await settle(page, 2500); // 真实重连 + 补偿 HTTP
  const sFill = await harnessState(page);
  const newReqs = rec.klineReqs.slice(reqBefore);
  const comp = newReqs.filter((r) => r.url.includes('limit=5') && !r.url.includes('before'));
  const num = (a) => a.map((t) => Date.parse(t));
  const nFill = num(sFill.dataList);
  const uniq = new Set(sFill.dataList).size === sFill.dataList.length;
  const sorted = nFill.every((t, i, a) => i === 0 || t > a[i - 1]);
  const superset = L0.every((t) => sFill.dataList.includes(t));
  const exactRestore = JSON.stringify(sFill.dataList) === JSON.stringify(L0);
  const gt = await (await fetch(`${GT}/api/kline?code=518880&period=15m&limit=5`)).json();
  const gtLast = Date.parse(gt.bars.at(-1).ts);
  out.scenarios.T2 = {
    L0Len: L0.length, afterTruncLen: afterTrunc.dataLen, afterFillLen: sFill.dataLen,
    closedStatus: sClosed.status, fillStatus: sFill.status,
    compensationRequests: comp, allKlineReqsInWindow: newReqs.map((r) => r.url),
    framesInWindow: rec.frames.length - framesBefore,
    exactRestoreOfL0: exactRestore, unique: uniq, strictlyIncreasing: sorted, restoresAllL0Ts: superset,
    gtLastTs: new Date(gtLast).toISOString(), feedLastTs: new Date(sFill.dataList.at(-1)).toISOString(),
    stats: sFill.stats, conns: rec.conns.length,
  };
  check('T2 看门狗 → 主动 close → 退避重连 → 重连成功后 1 次 HTTP 增量补偿（limit=5、无 before）',
    sClosed.status !== 'open' && comp.length === 1, out.scenarios.T2);
  check('T2 断口补齐：数据面完全还原为断口前（无空洞/无重复/严格递增；丢掉 3 根由补偿补回）',
    superset && exactRestore && sFill.dataLen === L0.length && uniq && sorted, { L0: L0.length, after: sFill.dataLen, truncLen: afterTrunc.dataLen, exactRestore, uniq, sorted });
  check('T2 兜底窗口对齐真实后端最新 bar（末根 ts = 后端最新）', Date.parse(sFill.dataList.at(-1)) === gtLast, { feedLast: new Date(sFill.dataList.at(-1)).toISOString(), gtLast: new Date(gtLast).toISOString() });
  check('T2 无页面异常', rec.pageErrors.length === 0, rec.pageErrors);
  out.wsEvents.push({ page: 'harness-T1T2', conns: rec.conns.map((c) => ({ n: c.n, at: new Date(c.at).toISOString(), recv: c.recv, sent: c.sent })) });
  await page.context().close();
}

// ══════════════════════ T4：入站帧复位（三类帧各一轮） ══════════════════════
{
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: TRADING });
  await page.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0 && window.__H__.status() === 'open', null, { timeout: 20000 });
  await settle(page, 2500);
  const rounds = [];
  const injectFrame = (kind) =>
    page.evaluate((k) => {
      const h = window.__H__;
      const last = h.bars().at(-1);
      if (k === 'health') return h.inject({ type: 'health', status: 'ok', ts: new Date().toISOString() });
      if (k === 'quote') return h.inject({ type: 'quote', code: h.code, last: last?.close ?? 1, changePct: 0.01, ts: new Date().toISOString() });
      return h.inject({ type: 'bar', code: h.code, period: h.period, bar: { ...last, close: (last?.close ?? 1) + 0.001 } }); // bar：同 ts 覆盖（不改数据面长度）
    }, kind);
  for (const kind of ['health', 'quote', 'bar']) {
    const c0 = rec.conns.length;
    await page.clock.fastForward(M(13)); // 阈值内（13s < 15s）
    const injected = await injectFrame(kind);
    const d0 = await harnessState(page);
    await page.clock.fastForward(M(14)); // 距注入 14s：若未复位，则距上次真实 burst 已 27s ⇒ 必已 close
    await settle(page, 400);
    const d1 = await harnessState(page);
    await page.clock.fastForward(M(2)); // 距注入 16s > 15s ⇒ 必 close
    await settle(page, 600);
    const d2 = await harnessState(page);
    rounds.push({ kind, injected, connsBefore: c0, afterInject: { status: d0.status, conns: rec.conns.length }, after14s: { status: d1.status, conns: rec.conns.length }, after16s: { status: d2.status, conns: rec.conns.length } });
    await page.clock.fastForward(M(1));
    await settle(page, 2000); // 重连回 open，进入下一轮
    if (kind !== 'bar') await page.waitForFunction(() => window.__H__.status() === 'open', null, { timeout: 15000 });
  }
  out.scenarios.T4 = rounds;
  check('T4 health 帧复位静默计时（13s 注入 ⇒ 27s 不 close；注入后 15s 才 close）',
    rounds[0].injected === true && rounds[0].after14s.status === 'open' && rounds[0].after16s.status !== 'open', rounds[0]);
  check('T4 quote 帧复位静默计时', rounds[1].after14s.status === 'open' && rounds[1].after16s.status !== 'open', rounds[1]);
  check('T4 bar 帧复位静默计时', rounds[2].after14s.status === 'open' && rounds[2].after16s.status !== 'open', rounds[2]);
  out.wsEvents.push({ page: 'harness-T4', conns: rec.conns.map((c) => ({ n: c.n, at: new Date(c.at).toISOString(), recv: c.recv })) });
  await page.context().close();
}

// ══════════════════════ T3：非交易时段（周六）不空转 ══════════════════════
{
  const { page, rec } = await newPage(browser, { url: H('?code=518880&period=15m'), clock: OFFHOURS });
  await page.waitForFunction(() => window.__H__ && window.__H__.dataLen() > 0 && window.__H__.status() === 'open', null, { timeout: 20000 });
  await settle(page, 2500);
  const steps = [];
  const step = async (sec, label) => {
    await page.clock.fastForward(M(sec));
    await settle(page, 350);
    const s = await harnessState(page);
    steps.push({ label, simulatedSecTotal: steps.reduce((a, b) => a + b.sec, 0) + sec, sec, conns: rec.conns.length, status: s.status });
  };
  await step(15, '15s');
  const noSpin15 = rec.conns.length === 1;
  check('T3 非交易时段静默 15s：**不得**重连（门控 300s，15s 口径不适用）', noSpin15, steps.at(-1));
  await step(60, '+60s');
  await step(223, '累计 298s');
  check('T3 非交易时段静默 298s：仍不得重连', rec.conns.length === 1 && steps.at(-1).status === 'open', steps.at(-1));
  await step(2, '累计 300s');
  await settle(page, 700);
  const sAt300 = await harnessState(page);
  check('T3 累计 ~300s 才自愈（证明阈值确为 300s 而非 15s）', sAt300.status !== 'open', { status: sAt300.status, timeline: sAt300.timeline });
  await page.clock.fastForward(M(1));
  await settle(page, 2000);
  check('T3 300s 后重连成功（第 2 条连接）', rec.conns.length === 2, { conns: rec.conns.length });
  // 1 小时空转率：以 300s 步推进
  const c1 = rec.conns.length;
  for (let i = 0; i < 12; i += 1) {
    await page.clock.fastForward(M(300));
    await settle(page, 250);
    await page.clock.fastForward(M(1));
    await settle(page, 900);
  }
  const c2 = rec.conns.length;
  out.scenarios.T3 = { steps, connsAfterHourSim: c2, connsAddedInHour: c2 - c1, maxExpected: 12 + 2, totalKlineReqs: rec.klineReqs.map((r) => r.url), statuses: (await harnessState(page)).timeline };
  check('T3 非交易时段空转受限：模拟 1 小时新增重连 ≤ 12+2（≈1 次/5 分钟，无 15s 空转）', c2 - c1 <= 14, { added: c2 - c1 });
  const comp5 = rec.klineReqs.filter((r) => r.url.includes('limit=5'));
  const reconnects = rec.conns.length - 1;
  check('T3 非交易时段：无「分钟兜底」HTTP（0 次）；出现的 limit=5 请求全部 = 重连补偿，次数恰等于重连次数',
    comp5.length === reconnects, { limit5Count: comp5.length, reconnects, note: '口径 4：重连成功后一次 HTTP 增量补偿（非分钟兜底）' });
  out.scenarios.T3.limit5Reqs = comp5;
  await page.context().close();
}

// ══════════════════════ A：真实看板页面（非底座）端到端 ══════════════════════
{
  const { page, rec } = await newPage(browser, { url: `${BASE}/?code=518880`, clock: TRADING });
  await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 45000 });
  await page.waitForFunction(() => (window.__ACC__?.charts ?? []).some((c) => (c.getDataList?.() ?? []).length > 0), null, { timeout: 30000 });
  await settle(page, 4000);
  const first = { conns: rec.conns.length, frames: rec.frames.length, lastFrameAt: rec.frames.at(-1)?.at ?? null };
  const reqBefore = rec.klineReqs.length;
  await page.clock.fastForward(M(14));
  await settle(page, 400);
  const pillAt14 = await page.locator('text=WS 断开，重连中…').count();
  check('A 真实看板：初始单真实 WS 连接（订阅帧已发出）', first.conns === 1, first);
  check('A 真实看板：静默 14s 内不重连、顶栏 pill 不出现断开态', rec.conns.length === 1 && pillAt14 === 0, { conns: rec.conns.length, pillAt14 });
  await page.clock.fastForward(M(2));
  await settle(page, 500);
  const pillAfter = await page.locator('text=WS 断开，重连中…').count();
  check('A 真实看板：静默 >15s ⇒ 顶栏出现「WS 断开，重连中…」（状态离开 open，不谎报）', pillAfter === 1, { pillAfter, timelineMs: Date.now() });
  await page.clock.fastForward(M(1));
  await settle(page, 3000);
  const newReqs = rec.klineReqs.slice(reqBefore);
  const comp = newReqs.filter((r) => r.url.includes('limit=5') && !r.url.includes('before'));
  const reSub = rec.sent.filter((x) => x.conn === 2 && x.frame.includes('subscribe'));
  const ts = await page.evaluate(() => (window.__ACC__.charts.at(-1).getDataList() ?? []).map((b) => b.timestamp));
  const sortedTs = ts.every((t, i, a) => i === 0 || t > a[i - 1]);
  const gt = await (await fetch(`${GT}/api/kline?code=518880&period=15m&limit=5`)).json();
  out.scenarios.A = {
    first, conns: rec.conns.map((c) => ({ n: c.n, at: new Date(c.at).toISOString(), recv: c.recv, sent: c.sent })),
    reSubConn2: reSub.map((x) => x.frame), compensation: comp, allNewKlineReqs: newReqs.map((r) => r.url),
    chartDataLen: ts.length, strictlyIncreasing: sortedTs, uniq: new Set(ts).size === ts.length,
    chartLastTs: new Date(ts.at(-1)).toISOString(), gtLastTs: gt.bars.at(-1).ts,
    pageErrors: rec.pageErrors,
  };
  check('A 真实看板：看门狗重连后自动重订阅 + 1 次 HTTP 增量补偿（limit=5、无 before）', rec.conns.length === 2 && reSub.length >= 1 && comp.length === 1, out.scenarios.A);
  check('A 真实看板：数据面无重复、严格递增，末根与后端最新一致', new Set(ts).size === ts.length && sortedTs && ts.at(-1) === Date.parse(gt.bars.at(-1).ts), { len: ts.length, sortedTs, chartLast: new Date(ts.at(-1)).toISOString(), gtLast: gt.bars.at(-1).ts });
  check('A 真实看板：无页面异常', rec.pageErrors.length === 0, rec.pageErrors);
  out.wsEvents.push({ page: 'app', conns: rec.conns.map((c) => ({ n: c.n, at: new Date(c.at).toISOString(), recv: c.recv, sent: c.sent })) });
  await page.context().close();
}

await browser.close();
const fs = await import('node:fs');
fs.writeFileSync('/tmp/acc_rec/ev/probe_gate.json', JSON.stringify(out, null, 1));
const failed = out.checks.filter((c) => !c.ok);
console.log(`\nchecks: ${out.checks.length - failed.length}/${out.checks.length} passed; failed=${failed.map((f) => f.name).join(' | ') || 'none'}`);
process.exit(0);
