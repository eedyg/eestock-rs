#!/usr/bin/env node
/**
 * ADR-023 D2 上线后真渲染独立验收（只验不改）。
 * 被验对象：线上 http://127.0.0.1:8081/（只读客户端）。
 * 输出：OUT/*.json + OUT/shot_*.png + OUT/run.log
 */
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/tmp/adr023-d2-verify-live-20260917-000127';
const BASE = 'http://127.0.0.1:8081/';
const VIEWPORT = { width: 2000, height: 1100 };
const log = [];
const L = (m) => { log.push(m); console.log(m); };
const wj = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + '\n');

// ── 网络审计 ──────────────────────────────────────────────────────────────
const requests = [];   // {method,url,postData}
const responses = [];  // {method,url,status}

// ── 页面侧探针 ────────────────────────────────────────────────────────────

/** ChartSyncGroup 实例（React fiber 反射；只读，绝不写）。 */
const FIND_GROUP_FN = () => {
  const el = document.querySelector('[data-mp-stack]');
  if (!el) return { found: false, reason: 'no [data-mp-stack]' };
  const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  if (!fk) return { found: false, reason: 'no reactFiber key' };
  let node = el[fk], depth = 0;
  while (node && depth < 30) {
    let hook = node.memoizedState, h = 0;
    while (hook && h < 400) {
      const st = hook.memoizedState;
      try {
        if (
          st && typeof st === 'object' && st.current && typeof st.current === 'object' &&
          st.current.stats && typeof st.current.stats === 'object' &&
          st.current.stats.densityByFollower && typeof st.current.stats.densityByFollower === 'object'
        ) {
          const s = st.current.stats;
          return {
            found: true, depth, hookIndex: h,
            stats: {
              groupEstablished: s.groupEstablished,
              groupReason: s.groupReason ?? null,
              syncableFollowerCount: s.syncableFollowerCount,
              excludedSatellites: (s.excludedSatellites || []).map((e) => ({ period: e.period, reason: e.reason })),
              degraded: s.degraded,
              degradedPeriod: s.degradedPeriod ?? null,
              lastSpanDiffMinutes: s.lastSpanDiffMinutes,
              lastUnalignedReason: s.lastUnalignedReason ?? null,
              spanResidualBars: s.spanResidualBars ?? null,
              edgeResidualBars: s.edgeResidualBars ?? null,
              barSpaceAdjust: s.barSpaceAdjust ?? null,
              applied: s.applied, suppressed: s.suppressed,
              densityByFollower: Object.fromEntries(
                Object.entries(s.densityByFollower).map(([k, v]) => [k, { ratio: v.ratio, source: v.source }]),
              ),
            },
          };
        }
      } catch (e) { /* ignore */ }
      hook = hook.next; h++;
    }
    node = node.return; depth++;
  }
  return { found: false, reason: 'no ChartSyncGroup ref in ancestor fibers' };
};

/** 各实例可见窗读数（287 口径：getVisibleRange→getDataList 索引定位）。 */
const WINDOW_FN = () => {
  const out = [];
  document.querySelectorAll('[data-testid="kline-chart"]').forEach((el) => {
    const pane = el.closest('[data-mp-pane]');
    const role = pane ? pane.getAttribute('data-mp-pane-role') : null;
    const period = pane ? pane.getAttribute('data-mp-pane') : (el.closest('[data-mp-satellite]')?.getAttribute('data-mp-satellite') || null);
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!fk) { out.push({ role, period, found: false }); return; }
    let node = el[fk], depth = 0, chart = null;
    while (node && depth < 30) {
      let hook = node.memoizedState, h = 0;
      while (hook && h < 80) {
        const st = hook.memoizedState;
        if (st && typeof st === 'object' && st.current && typeof st.current.getIndicators === 'function') { chart = st.current; break; }
        hook = hook.next; h++;
      }
      if (chart) break;
      node = node.return; depth++;
    }
    if (!chart) { out.push({ role, period, found: false }); return; }
    const vr = chart.getVisibleRange();
    const list = chart.getDataList();
    const bs = chart.getBarSpace();
    const size = typeof chart.getSize === 'function' ? chart.getSize() : null;
    const last = list.length - 1;
    const cl = (i) => Math.max(0, Math.min(last, i));
    const rfTs = list[cl(vr.realFrom)] ? list[cl(vr.realFrom)].timestamp : null;
    const rtTs = list[cl(vr.realTo)] ? list[cl(vr.realTo)].timestamp : null;
    out.push({
      role, period, found: true, bar: bs ? bs.bar : null, offsetRight: chart.getOffsetRightDistance(),
      sizeWidth: size ? size.width : null,
      realFrom: vr.realFrom, realTo: vr.realTo,
      realFromTs: rfTs, realToTs: rtTs,
      realBars: vr.realTo - vr.realFrom + 1,
      spanMs: (rfTs != null && rtTs != null) ? rtTs - rfTs : null,
      listLen: list.length,
    });
  });
  return out;
};

/** DOM：picker 两步骤选项 + 卫星角标 + 组未建立角标。 */
const DOM_FN = () => {
  const picker = document.querySelector('[data-testid="mp-picker"]');
  const step1 = picker ? Array.from(picker.querySelectorAll('[data-mp-base-period]')).map((b) => ({
    period: b.getAttribute('data-mp-base-period'), pressed: b.getAttribute('aria-pressed'), text: b.textContent.trim(), disabled: b.disabled,
  })) : null;
  const step2 = picker ? Array.from(picker.querySelectorAll('[data-mp-indicator-period]')).map((b) => {
    const reason = picker.querySelector(`[data-mp-indicator-reason="${b.getAttribute('data-mp-indicator-period')}"]`);
    return {
      period: b.getAttribute('data-mp-indicator-period'), pressed: b.getAttribute('aria-pressed'),
      text: b.textContent.trim(), disabled: b.disabled,
      reason: reason ? reason.textContent.trim() : null,
    };
  }) : null;
  const sats = Array.from(document.querySelectorAll('[data-mp-satellite]')).map((el) => {
    const ex = el.querySelector('[data-mp-sync-excluded]');
    const dg = el.querySelector('[data-mp-sync-degraded]');
    const er = el.querySelector('[data-mp-satellite-error]');
    return {
      period: el.getAttribute('data-mp-satellite'),
      basePeriod: el.getAttribute('data-mp-base-period'),
      basePeriodSource: el.getAttribute('data-mp-base-period-source'),
      inlineHeight: el.style.height,
      excluded: ex ? { attrPeriod: ex.getAttribute('data-mp-sync-excluded'), reason: ex.getAttribute('data-mp-sync-excluded-reason'), text: ex.textContent.trim(), title: ex.getAttribute('title'), visible: ex.offsetParent !== null, outerHTML: ex.outerHTML } : null,
      degraded: dg ? { attrPeriod: dg.getAttribute('data-mp-sync-degraded'), spanDiffMin: dg.getAttribute('data-mp-span-diff-min'), text: dg.textContent.trim(), title: dg.getAttribute('title'), visible: dg.offsetParent !== null, outerHTML: dg.outerHTML } : null,
      error: er ? { text: er.textContent.trim() } : null,
    };
  });
  const gu = document.querySelector('[data-mp-sync-group-unestablished]');
  return {
    pickerOpen: !!picker,
    pickerHint: picker ? (picker.querySelector('[data-mp-picker-hint]') ? picker.querySelector('[data-mp-picker-hint]').textContent.trim() : null) : null,
    pickerError: picker ? (picker.querySelector('[data-testid="mp-picker-error"]') ? picker.querySelector('[data-testid="mp-picker-error"]').textContent.trim() : null) : null,
    step1, step2, sats,
    panes: Array.from(document.querySelectorAll('[data-mp-pane]')).map((el) => ({ period: el.getAttribute('data-mp-pane'), role: el.getAttribute('data-mp-pane-role'), inlineHeight: el.style.height })),
    chartCount: document.querySelectorAll('[data-testid="kline-chart"]').length,
    groupUnestablished: gu ? { reason: gu.getAttribute('data-mp-sync-group-reason'), text: gu.textContent.trim(), title: gu.getAttribute('title') } : null,
    toolbarPeriods: Array.from(document.querySelectorAll('button')).filter((b) => ['1m','5m','15m','30m','1h','日','周'].includes((b.textContent || '').trim())).map((b) => ({ text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') })),
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const consoleAll = [];
  const pageErrors = [];
  page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), postData: r.postData() }));
  page.on('response', async (r) => { responses.push({ method: r.request().method(), url: r.url(), status: r.status() }); });
  page.on('console', (m) => { consoleAll.push({ type: m.type(), text: m.text() }); if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const result = { steps: {} };

  L(`[env] viewport=${VIEWPORT.width}x${VIEWPORT.height} headless=true`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="kline-chart"]').length >= 1, null, { timeout: 30000 });
  await sleep(3500);

  // 初始 GET 配置
  const cfg0 = await page.evaluate(async () => {
    const r = await fetch('/api/config/multi_period'); return { status: r.status, body: await r.text() };
  });
  result.steps.t0_config_get = cfg0;
  L(`[T0] GET /api/config/multi_period = HTTP ${cfg0.status} ${cfg0.body}`);

  result.steps.initial_dom = await page.evaluate(DOM_FN);
  await page.screenshot({ path: path.join(OUT, 'shot_00_initial.png') });

  // ── 确保多周期开启（产品自身 PUT；状态感知：已开启则不点，避免误关） ──
  const curCfg = JSON.parse(cfg0.body);
  if (!curCfg.enabled) {
    const toggle = page.getByRole('button', { name: '多周期', exact: true });
    const beforePutReq = requests.length;
    const put1 = page.waitForResponse((r) => r.url().includes('/api/config/multi_period') && r.request().method() === 'PUT', { timeout: 15000 }).catch(() => null);
    await toggle.click();
    const put1resp = await put1;
    await sleep(1200);
    const put1req = requests.slice(beforePutReq).filter((r) => r.method === 'PUT');
    result.steps.toggle_put = { action: 'enable', request: put1req, response: put1resp ? { status: put1resp.status(), body: await put1resp.text().catch(() => null) } : null };
    L(`[toggle 多周期 ON] PUT req=${JSON.stringify(put1req)} resp=${put1resp ? put1resp.status() : 'none'}`);
  } else {
    result.steps.toggle_put = { action: 'skipped (already enabled)' };
    L('[toggle 多周期] 已开启 ⇒ 跳过（不点击，避免误关）');
  }
  await page.screenshot({ path: path.join(OUT, 'shot_01_enabled.png') });

  // picker 入口出现
  await page.waitForSelector('[data-testid="mp-periods-open"]', { timeout: 10000 });
  const reqsBeforeOpen = requests.length;
  await page.click('[data-testid="mp-periods-open"]');
  await page.waitForSelector('[data-testid="mp-picker"]', { timeout: 10000 });
  await sleep(600);
  const openReqs = requests.slice(reqsBeforeOpen);
  result.steps.picker_open_requests = openReqs;
  L(`[picker open] 触发请求 = ${JSON.stringify(openReqs)} （预期：无 PUT）`);

  // ── B1：picker 两步骤可达性 ──
  const b1 = {};
  // 步骤 1 固定全集
  const domB1 = await page.evaluate(DOM_FN);
  b1.step1 = domB1.step1;
  // 步骤 2：分别以 1m / 15m / 30m / 1h / 1d 为基准枚举（真渲染）
  b1.step2ByBase = {};
  for (const baseP of ['1m', '15m', '30m', '1h', '1d']) {
    await page.click(`[data-mp-base-period="${baseP}"]`);
    await sleep(450);
    const d = await page.evaluate(DOM_FN);
    b1.step2ByBase[baseP] = { step2: d.step2, hint: d.pickerHint };
  }
  // 恢复 base=1m
  await page.click('[data-mp-base-period="1m"]');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'shot_B1_picker.png') });
  result.steps.B1 = b1;
  L(`[B1] step1 = ${b1.step1.map((x) => x.period).join(',')}`);
  for (const [b, v] of Object.entries(b1.step2ByBase)) L(`[B1] base=${b} step2 = ${v.step2.map((x) => x.period).join(',')}`);

  // ── 组合执行 helper ──
  async function setCombo(base, sats, tag) {
    // 确保 picker 打开
    if (!(await page.$('[data-testid="mp-picker"]'))) {
      await page.click('[data-testid="mp-periods-open"]');
      await page.waitForSelector('[data-testid="mp-picker"]', { timeout: 10000 });
      await sleep(400);
    }
    await page.click(`[data-mp-base-period="${base}"]`);
    await sleep(500);
    // 当前 pressed 集合
    const cur = (await page.evaluate(DOM_FN)).step2.filter((x) => x.pressed === 'true').map((x) => x.period);
    // 先取消不在 sats 的
    for (const p of cur) {
      if (!sats.includes(p)) { await page.click(`[data-mp-indicator-period="${p}"]`); await sleep(250); }
    }
    for (const s of sats) {
      const pressed = await page.getAttribute(`[data-mp-indicator-period="${s}"]`, 'aria-pressed');
      if (pressed !== 'true') { await page.click(`[data-mp-indicator-period="${s}"]`); await sleep(250); }
    }
    const after = (await page.evaluate(DOM_FN)).step2.filter((x) => x.pressed === 'true').map((x) => x.period).sort();
    if (JSON.stringify(after.slice().sort()) !== JSON.stringify(sats.slice().sort())) {
      throw new Error(`[${tag}] selection mismatch: want ${sats} got ${after}`);
    }
    const before = requests.length;
    const putP = page.waitForResponse((r) => r.url().includes('/api/config/multi_period') && r.request().method() === 'PUT', { timeout: 15000 }).catch(() => null);
    await page.click('[data-testid="mp-picker-confirm"]');
    const putR = await putP;
    await sleep(1600);
    const putReqs = requests.slice(before).filter((r) => r.method === 'PUT');
    const respBody = putR ? await putR.text().catch(() => null) : null;
    return { base, sats, putRequests: putReqs, putStatus: putR ? putR.status() : null, putRespBody: respBody };
  }

  async function wheelBase(times = 4, deltaY = -120) {
    const box = await page.locator('[data-mp-pane-role="base"] [data-testid="kline-chart"]').first().boundingBox();
    if (!box) return null;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < times; i++) { await page.mouse.wheel(0, deltaY); await sleep(220); }
    return { cx, cy };
  }

  // ── B2：可同步性（15m↔30m，1m↔30m） ──
  const b2 = {};
  for (const [k, base, sats] of [['combo_15m_30m', '15m', ['30m']], ['combo_1m_30m', '1m', ['30m']]]) {
    const put = await setCombo(base, sats, k);
    L(`[B2 ${k}] PUT → ${put.putStatus} body=${put.putRespBody}`);
    // 等卫星渲染
    await page.waitForFunction((n) => document.querySelectorAll('[data-mp-satellite]').length === n, sats.length, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="kline-chart"]').length >= n, 1 + sats.length, { timeout: 15000 }).catch(() => {});
    await sleep(2500);
    const before = await page.evaluate(WINDOW_FN);
    const gest = await wheelBase(4, -120);
    await sleep(1800);
    const after = await page.evaluate(WINDOW_FN);
    const grp = await page.evaluate(FIND_GROUP_FN);
    const dom = await page.evaluate(DOM_FN);
    b2[k] = { put, gesture: gest, windowsBefore: before, windowsAfter: after, group: grp, dom };
    await page.screenshot({ path: path.join(OUT, `shot_B2_${k}.png`) });
    L(`[B2 ${k}] group=${JSON.stringify(grp.found ? grp.stats : grp)}`);
  }
  result.steps.B2 = b2;

  // ── B3：诚实降级 ──
  const b3 = {};
  // 3a: 30m 基准 + 1d 卫星（可达）
  {
    const put = await setCombo('30m', ['1d'], 'b3a_30m_1d');
    await page.waitForFunction(() => document.querySelectorAll('[data-mp-satellite]').length === 1, null, { timeout: 15000 }).catch(() => {});
    await sleep(2500);
    const dom = await page.evaluate(DOM_FN);
    const grp = await page.evaluate(FIND_GROUP_FN);
    b3.a_30m_1d = { put, dom, group: grp };
    await page.screenshot({ path: path.join(OUT, 'shot_B3a_30m_1d.png') });
    L(`[B3a 30m+1d] sat=${JSON.stringify(dom.sats.map((s) => ({ period: s.period, excluded: s.excluded && s.excluded.reason, degraded: s.degraded && s.degraded.text })))}`);
    L(`[B3a 30m+1d] group=${JSON.stringify(grp.found ? grp.stats : grp)}`);
  }
  // 3b: 尝试 30m 基准 + 1w 卫星（预期 picker 禁用并给原因）
  {
    await page.click('[data-testid="mp-periods-open"]');
    await page.waitForSelector('[data-testid="mp-picker"]', { timeout: 10000 });
    await sleep(400);
    await page.click('[data-mp-base-period="30m"]');
    await sleep(500);
    const dom = await page.evaluate(DOM_FN);
    b3.b_30m_1w_picker = { step2: dom.step2, hint: dom.pickerHint };
    await page.screenshot({ path: path.join(OUT, 'shot_B3b_30m_1w_picker.png') });
    L(`[B3b 30m base step2] ${JSON.stringify(dom.step2)}`);
  }
  // 3c: 尝试 1h 基准 + 30m 卫星（预期 picker 候选不含 30m）
  {
    await page.click('[data-mp-base-period="1h"]');
    await sleep(500);
    const dom = await page.evaluate(DOM_FN);
    b3.c_1h_base_step2 = { step2: dom.step2, hint: dom.pickerHint };
    await page.screenshot({ path: path.join(OUT, 'shot_B3c_1h_base_picker.png') });
    L(`[B3c 1h base step2] ${JSON.stringify(dom.step2)}`);
  }
  // 关闭 picker（取消，不写）
  {
    const cancelBtn = page.locator('[data-testid="mp-picker"] button', { hasText: '取消' }).first();
    if (await cancelBtn.count()) await cancelBtn.click();
    else await page.click('[data-testid="mp-periods-open"]');
    await sleep(400);
  }
  // 3d: 可达的跨族 1h 基准 + 1d 卫星（旁证跨族由 no-shared-anchor 判定，非静默）
  {
    const put = await setCombo('1h', ['1d'], 'b3d_1h_1d');
    await page.waitForFunction(() => document.querySelectorAll('[data-mp-satellite]').length === 1, null, { timeout: 15000 }).catch(() => {});
    await sleep(2500);
    const dom = await page.evaluate(DOM_FN);
    const grp = await page.evaluate(FIND_GROUP_FN);
    b3.d_1h_1d = { put, dom, group: grp };
    await page.screenshot({ path: path.join(OUT, 'shot_B3d_1h_1d.png') });
    L(`[B3d 1h+1d] sat=${JSON.stringify(dom.sats.map((s) => ({ period: s.period, excluded: s.excluded && s.excluded.reason })))}`);
  }
  result.steps.B3 = b3;

  // ── B4：30m 配对 drift（复现 15m↔30m；索引定位 + 有界闭环 + 基准冻结） ──
  {
    const put = await setCombo('15m', ['30m'], 'b4_15m_30m');
    await page.waitForFunction(() => document.querySelectorAll('[data-mp-satellite]').length === 1, null, { timeout: 15000 }).catch(() => {});
    await sleep(2500);
    const pre = await page.evaluate(WINDOW_FN);
    const gest = await wheelBase(5, -120);
    await sleep(500);
    const justAfter = await page.evaluate(WINDOW_FN);
    await sleep(2500);
    const settled = await page.evaluate(WINDOW_FN);
    const grp = await page.evaluate(FIND_GROUP_FN);
    const dom = await page.evaluate(DOM_FN);
    // 平移到更早（drag）
    const box = await page.locator('[data-mp-pane-role="base"] [data-testid="kline-chart"]').first().boundingBox();
    let dragInfo = null;
    if (box) {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy); await page.mouse.down();
      for (let i = 1; i <= 15; i++) { await page.mouse.move(cx + (250 * i) / 15, cy); await sleep(30); }
      await page.mouse.up(); await sleep(2500);
      dragInfo = { cx, cy, dx: 250 };
    }
    const afterDrag = await page.evaluate(WINDOW_FN);
    const grp2 = await page.evaluate(FIND_GROUP_FN);
    const dom2 = await page.evaluate(DOM_FN);
    result.steps.B4 = { put, gesture: gest, pre, justAfter, settled, afterDrag, groupAfterZoom: grp, groupAfterDrag: grp2, domAfterZoom: dom, domAfterDrag: dom2, dragInfo };
    await page.screenshot({ path: path.join(OUT, 'shot_B4_15m_30m.png') });
    L(`[B4] settled windows=${JSON.stringify(settled)}`);
    L(`[B4] afterDrag windows=${JSON.stringify(afterDrag)}`);
    L(`[B4] groupAfterDrag=${JSON.stringify(grp2.found ? grp2.stats : grp2)}`);
  }

  // 最终配置 GET
  const cfg1 = await page.evaluate(async () => {
    const r = await fetch('/api/config/multi_period'); return { status: r.status, body: await r.text() };
  });
  result.steps.t1_config_get = cfg1;
  result.steps.final_dom = await page.evaluate(DOM_FN);
  await page.screenshot({ path: path.join(OUT, 'shot_final.png'), fullPage: false });

  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  result.consoleAll = consoleAll;
  result.requests = requests;
  result.responses = responses;

  // 请求方法汇总
  const byMethod = {};
  for (const r of requests) byMethod[r.method] = (byMethod[r.method] || 0) + 1;
  result.methodSummary = byMethod;
  const writes = requests.filter((r) => ['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method));
  result.writeRequests = writes;
  L(`[B5] methods=${JSON.stringify(byMethod)} writes=${JSON.stringify(writes)}`);
  L(`[B5] consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`);

  wj('result.json', result);
  fs.writeFileSync(path.join(OUT, 'run.log'), log.join('\n') + '\n');
  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); fs.writeFileSync(path.join(OUT, 'run.log'), log.join('\n') + '\nFATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
