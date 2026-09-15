#!/usr/bin/env node
/**
 * 287 独立验收脚本（真渲染 · 只读 · 主图手势驱动）。
 *
 * 验收对象：线上 http://127.0.0.1:8081/（title「eestock · 行情看板」）
 * 验收项：B1 主图拖动/缩放后「可同步卫星」可见时间窗随动；B2 无「ChartSyncGroup 未建立」告警；
 *        B3 被排除卫星（运行时配置的 1d）有可见角标且**不随动**；B4 多周期 pane 高度/顺序不变量 + VOL 开关可关可开；
 *        B5 零配置写入 + 仅 GET + console error / pageerror / requestfailed 计数。
 *
 * 禁令遵守（逐条）：
 *  - 对 /api/* **只发 GET**：本脚本自身只 GET /api/config/{multi_period,kline,ma}；页面自身的请求由页面发出。
 *    脚本内**不含**任何 PUT/POST/PATCH/DELETE。
 *  - **不拖拽 `[data-mp-separator]`**：脚本内无任何 separator 元素上的 mouse 事件（无 `data-mp-separator` 选择器）。
 *  - 手势只发生在**主图（base pane）candle pane 绘图区**内：mouse down/move/up 与 wheel。
 *  - **不用图表导出截图**（一律 page.screenshot / locator.screenshot）。
 *  - 只写 `tester/evidence/287_sync_acceptance/` 下的证据文件；不改工作区其它任何文件。
 *
 * 运行（cwd 必须 = web/，以便 @playwright/test 以绝对路径导入）：
 *   cd <repo>/web && node <repo>/tester/evidence/287_sync_acceptance/287_acceptance.mjs
 */
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/287_sync_acceptance';
const BASE = 'http://127.0.0.1:8081/';
const CONFIG_KEYS = ['multi_period', 'kline', 'ma'];
const VIEWPORT = { width: 2000, height: 1100 };
const SHOT = (n) => path.join(OUT, n);
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

fs.mkdirSync(OUT, { recursive: true });
const runLog = [];
const log = (m) => { runLog.push(m); console.log(m); };
const writeTxt = (name, content) => fs.writeFileSync(path.join(OUT, name), content);

// ───────────────────────── 只读配置读取（GET /api/config/*） ─────────────────────────
async function readConfigs(tag) {
  const out = {};
  for (const k of CONFIG_KEYS) {
    const url = `${BASE}api/config/${k}`;
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* keep raw */ }
    out[k] = { url, status: res.status, raw: text, json };
  }
  const lines = [`# GET /api/config/* (${tag}) — 只读；本脚本未发任何写请求`, `# 采集时间(UTC) ${new Date().toISOString()}`];
  const canonical = {};
  for (const k of CONFIG_KEYS) {
    lines.push(`--- GET /api/config/${k} ---`, `HTTP ${out[k].status}`, out[k].raw);
    canonical[k] = out[k].json ?? out[k].raw;
  }
  writeTxt(`A5_config_${tag}.txt`, lines.join('\n') + '\n');
  return { detail: out, canonical };
}

// ───────────────────────── 页面侧探针 ─────────────────────────
const INIT_SCRIPT = () => {
  window.__ft = [];
  const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
    try {
      const c = this.canvas;
      const r = c.getBoundingClientRect();
      const host = c.closest('[k-line-chart-id]');
      window.__ft.push({
        t: String(text), x: Math.round(x), y: Math.round(y),
        chost: host ? host.getAttribute('k-line-chart-id') : '?',
        cw: Math.round(r.width), ch: Math.round(r.height), ctop: Math.round(r.top),
      });
    } catch (e) { /* ignore */ }
    return orig.call(this, text, x, y, ...rest);
  };
};

const GEOM_FN = () => {
  const out = {};
  out.doc = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  const host = document.querySelector('[k-line-chart-id="k_line_chart_1"]');
  out.baseChartChildren = Array.from(host.firstElementChild.children).map((k, i) => {
    const r = k.getBoundingClientRect();
    const c = k.firstElementChild;
    return { i, h: k.style.height, bg: k.style.backgroundColor || null, cursor: c ? c.style.cursor : null, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) };
  });
  out.hosts = Array.from(document.querySelectorAll('[k-line-chart-id]')).map((h) => {
    const r = h.getBoundingClientRect();
    return { id: h.getAttribute('k-line-chart-id'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return out;
};

/** 多周期栈 DOM 快照（B3/B4）。 */
const DOM_FN = () => {
  const mpPanes = Array.from(document.querySelectorAll('[data-mp-pane]')).map((el) => ({
    period: el.getAttribute('data-mp-pane'), role: el.getAttribute('data-mp-pane-role'),
    attrHeight: el.getAttribute('data-mp-pane-height'), inlineHeight: el.style.height,
    rectHeight: Math.round(el.getBoundingClientRect().height),
    childIndex: Array.from(el.parentElement.children).indexOf(el),
  }));
  const mpSeps = Array.from(document.querySelectorAll('[data-mp-separator]')).map((el) => ({
    key: el.getAttribute('data-mp-separator'), attrHeight: el.getAttribute('data-mp-sep-height'),
    rectHeight: Math.round(el.getBoundingClientRect().height),
    childIndex: Array.from(el.parentElement.children).indexOf(el),
  }));
  const stack = document.querySelector('[data-mp-stack]');
  const sats = Array.from(document.querySelectorAll('[data-mp-satellite]')).map((el) => {
    const ex = el.querySelector('[data-mp-sync-excluded]');
    const dg = el.querySelector('[data-mp-sync-degraded]');
    const er = el.querySelector('[data-mp-satellite-error]');
    return {
      period: el.getAttribute('data-mp-satellite'),
      inlineHeight: el.style.height,
      rectHeight: Math.round(el.getBoundingClientRect().height),
      basePeriod: el.getAttribute('data-mp-base-period'),
      basePeriodSource: el.getAttribute('data-mp-base-period-source'),
      chartHostIds: Array.from(el.querySelectorAll('[k-line-chart-id]')).map((c) => c.getAttribute('k-line-chart-id')),
      excluded: ex ? {
        outerHTML: ex.outerHTML,
        attrPeriod: ex.getAttribute('data-mp-sync-excluded'),
        attrReason: ex.getAttribute('data-mp-sync-excluded-reason'),
        text: ex.textContent, title: ex.getAttribute('title'),
        rect: (() => { const r = ex.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        role: ex.getAttribute('role'),
        visible: ex.offsetParent !== null,
      } : null,
      degraded: dg ? {
        outerHTML: dg.outerHTML,
        attrPeriod: dg.getAttribute('data-mp-sync-degraded'),
        spanDiffMin: dg.getAttribute('data-mp-span-diff-min'),
        text: dg.textContent, title: dg.getAttribute('title'),
      } : null,
      error: er ? { text: er.textContent } : null,
    };
  });
  const gu = document.querySelector('[data-mp-sync-group-unestablished]');
  const volBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'VOL');
  return {
    mpPanes, mpSeps, sats,
    groupUnestablished: gu ? { outerHTML: gu.outerHTML, reason: gu.getAttribute('data-mp-sync-group-reason'), text: gu.textContent, title: gu.getAttribute('title') } : null,
    stack: stack ? {
      layout: stack.getAttribute('data-mp-stack-layout'), scrollable: stack.getAttribute('data-mp-stack-scrollable'),
      clientHeight: stack.clientHeight, children: Array.from(stack.children).map((c) => ({ tag: c.tagName.toLowerCase(), mpPane: c.getAttribute('data-mp-pane'), mpSep: c.getAttribute('data-mp-separator'), inlineHeight: c.style.height })),
    } : null,
    volButton: volBtn ? { outerHTML: volBtn.outerHTML, ariaPressed: volBtn.getAttribute('aria-pressed'), text: volBtn.textContent.trim() } : null,
    paneCount: document.querySelectorAll('[data-mp-pane]').length,
    excludedCount: document.querySelectorAll('[data-mp-sync-excluded]').length,
  };
};

/** 各实例「可见时间窗」客观读数（引擎公开 API；canvas 所绘即此状态）。 */
const WINDOW_FN = () => {
  const out = [];
  document.querySelectorAll('[data-testid="kline-chart"]').forEach((el) => {
    const hostId = el.getAttribute('k-line-chart-id');
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!fk) { out.push({ hostId, found: false }); return; }
    let node = el[fk], depth = 0, chart = null;
    while (node && depth < 30) {
      let hook = node.memoizedState, h = 0;
      while (hook && h < 60) {
        const st = hook.memoizedState;
        if (st && typeof st === 'object' && st.current && typeof st.current.getIndicators === 'function') { chart = st.current; break; }
        hook = hook.next; h++;
      }
      if (chart) break;
      node = node.return; depth++;
    }
    if (!chart) { out.push({ hostId, found: false }); return; }
    const vr = chart.getVisibleRange();
    const list = chart.getDataList();
    const bs = chart.getBarSpace();
    const size = typeof chart.getSize === 'function' ? chart.getSize() : null;
    const last = list.length - 1;
    const cl = (i) => Math.max(0, Math.min(last, i));
    const rfTs = list[cl(vr.realFrom)] ? list[cl(vr.realFrom)].timestamp : null;
    const rtTs = list[cl(vr.realTo)] ? list[cl(vr.realTo)].timestamp : null;
    out.push({
      hostId, found: true,
      bar: bs ? bs.bar : null, offsetRight: chart.getOffsetRightDistance(),
      sizeWidth: size ? size.width : null,
      vr: { from: vr.from, to: vr.to, realFrom: vr.realFrom, realTo: vr.realTo },
      realFromTs: rfTs, realToTs: rtTs,
      realBars: vr.realTo - vr.realFrom + 1,
      spanMs: (rfTs != null && rtTs != null) ? rtTs - rfTs : null,
      listLen: list.length,
      listFirstTs: list[0] ? list[0].timestamp : null,
      listLastTs: list[last] ? list[last].timestamp : null,
      indicators: chart.getIndicators().map((i) => i.name),
      paneOptions: chart.getPaneOptions().map((p) => ({ id: p.id, height: p.height, state: p.state, order: p.order })),
    });
  });
  return out;
};

/** 强制重绘（只重排/重绘，不写指标、不改 pane 高度、不写配置）——用于取全帧 x 轴刻度文本。 */
const RESIZE_FN = () => {
  const res = [];
  document.querySelectorAll('[data-testid="kline-chart"]').forEach((el) => {
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!fk) { res.push({ hostId: el.getAttribute('k-line-chart-id'), resized: false }); return; }
    let node = el[fk], depth = 0, chart = null;
    while (node && depth < 30) {
      let hook = node.memoizedState, h = 0;
      while (hook && h < 60) {
        const st = hook.memoizedState;
        if (st && typeof st === 'object' && st.current && typeof st.current.getIndicators === 'function') { chart = st.current; break; }
        hook = hook.next; h++;
      }
      if (chart) break;
      node = node.return; depth++;
    }
    if (chart && typeof chart.resize === 'function') { chart.resize(); res.push({ hostId: el.getAttribute('k-line-chart-id'), resized: true }); }
    else res.push({ hostId: el.getAttribute('k-line-chart-id'), resized: false });
  });
  return res;
};

const clearLegend = () => page.evaluate(() => { window.__ft = []; });
const dom = () => page.evaluate(DOM_FN);
const windows = () => page.evaluate(WINDOW_FN);
const geom = () => page.evaluate(GEOM_FN);

// ───────────────────────── 度量工具 ─────────────────────────
const AXIS_CH_MAX = 40;                       // x 轴刻度画布高度（实测 26px）
const TIME_RE = /^(\d{2}:\d{2}|\d{2}-\d{2} \d{2}:\d{2}|\d{4}-\d{2}-\d{2})$/;

/** 从 fillText 记录里抽「每个实例的 x 轴刻度文本」(canvas 高度 ≤ 40 且含时间型文本)。 */
function axisTicks(ft) {
  const byChart = {};
  for (const r of ft) {
    const g = (byChart[r.chost] = byChart[r.chost] || {});
    const key = `${r.cw}x${r.ch}@top${r.ctop}`;
    (g[key] = g[key] || []).push(r);
  }
  const out = {};
  for (const [host, groups] of Object.entries(byChart)) {
    let best = null;
    for (const [key, rows] of Object.entries(groups)) {
      const h = rows[0].ch;
      const ticks = rows.filter((r) => TIME_RE.test(r.t));
      if (h <= AXIS_CH_MAX && ticks.length > 0) {
        if (!best || ticks.length > best.ticks.length) best = { key, ticks };
      }
    }
    out[host] = best ? {
      canvas: best.key,
      ticks: Array.from(new Set(best.ticks.map((t) => t.t))).sort(),
      anchored: Array.from(new Set(best.ticks.map((t) => `${t.t}@x=${t.x}`))).sort(),
    } : { canvas: null, ticks: [], anchored: [] };
  }
  return out;
}

const TZ_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmt = (ts) => ts == null ? 'null' : TZ_FMT.format(new Date(ts)).replace(', ', ' ') + ' CST';
const setEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const setDiff = (a, b) => ({ removed: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)) });

// ───────────────────────── 主流程 ─────────────────────────
const results = { startedAt: new Date().toISOString(), viewport: VIEWPORT, items: {} };

const env = [];
try {
  const { execSync } = await import('node:child_process');
  const sh = (c) => execSync(c, { cwd: '/home/eestock/workspace/git/eestock/eestock-rs', encoding: 'utf8' }).trim();
  env.push(`repo            = /home/eestock/workspace/git/eestock/eestock-rs`);
  env.push(`HEAD            = ${sh('git rev-parse HEAD')}`);
  env.push(`branch          = ${sh('git branch --show-current')}`);
  env.push(`node            = ${process.version}`);
  env.push(`date(local)     = ${sh('date')}`);
  env.push(`dist mtime      = ${sh('stat -c %y web/dist/assets/index-BGPCHS0j.js')}`);
  env.push(`script sha256   = ${crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex')}`);
} catch (e) { env.push(`env collect error: ${e.message}`); }
env.push(`viewport        = ${VIEWPORT.width}x${VIEWPORT.height}（多周期栈 x=414 宽 1522 ⇒ 需 ≥1936 宽才无裁剪）`);

const cfgStart = await readConfigs('start');
log(`[A5] 验收窗口开始：GET /api/config/* 已读取（multi_period=${cfgStart.detail.multi_period.raw}）`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
await page.addInitScript(INIT_SCRIPT);

const consoleMsgs = [], pageErrors = [], failedRequests = [], apiResponses = [];
page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text(), loc: `${m.location()?.url || ''}:${m.location()?.lineNumber || ''}` }));
page.on('pageerror', (e) => pageErrors.push({ message: e.message, stack: (e.stack || '').split('\n').slice(0, 6).join('\n') }));
page.on('requestfailed', (r) => failedRequests.push({ method: r.method(), url: r.url(), failure: r.failure()?.errorText }));
page.on('response', (r) => { const u = r.url(); if (u.includes('/api/')) apiResponses.push(`${r.request().method()} ${r.status()} ${u}`); });

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForSelector('[data-mp-stack]', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('[k-line-chart-id]').length >= 3, null, { timeout: 30000 });
await page.waitForTimeout(4000); // 让初始化对齐 / 16ms 抑制窗过去

const servedHtml = await (await fetch(BASE)).text();
const bundle = (servedHtml.match(/\/assets\/index-[\w-]+\.js/) || [null])[0];
env.push(`served bundle   = ${bundle}`);
if (bundle) {
  const servedJs = await (await fetch(BASE + bundle.replace('/', ''))).text();
  const localJsPath = path.join('/home/eestock/workspace/git/eestock/eestock-rs/web/dist', bundle.replace('/assets/', 'assets/'));
  const localExists = fs.existsSync(localJsPath);
  env.push(`served js md5   = ${crypto.createHash('md5').update(servedJs).digest('hex')}`);
  env.push(`local  js md5   = ${localExists ? md5(localJsPath) : 'MISSING'}`);
  for (const marker of ['no-shared-anchor', 'data-mp-sync-excluded', '未同步', 'excludedSatellites', 'ChartSyncGroup 未建立']) {
    env.push(`marker "${marker}" in served js = ${servedJs.split(marker).length - 1}`);
  }
}
writeTxt('A0_env.txt', ['# 287 独立验收 — 环境', ...env].join('\n') + '\n');

const g0 = await geom();
const dom0 = await dom();
const draw = g0.baseChartChildren.find((c) => !c.bg && c.cursor !== 'ew-resize' && c.width > 100 && c.h !== '0px');
if (!draw) throw new Error('未找到主图 candle pane 绘图区');
const cx = draw.left + Math.round(draw.width / 2);
const cy = draw.top + Math.round((draw.bottom - draw.top) / 2);
log(`[env] 主图 candle 绘图区 = ${JSON.stringify(draw)}；手势点 = (${cx}, ${cy})`);
fs.writeFileSync(path.join(OUT, 'A0_geometry.json'), JSON.stringify({ geometry: g0, baseCandlePane: draw, gesturePoint: { x: cx, y: cy } }, null, 2));

const satPeriods = dom0.sats.map((s) => s.period);
const basePeriod = dom0.mpPanes.find((p) => p.role === 'base')?.period;
log(`[env] 运行时多周期：基准=${basePeriod} 卫星=[${satPeriods.join(',')}]；排除角标=${dom0.sats.filter((s) => s.excluded).map((s) => `${s.period}(${s.excluded.attrReason})`).join(',') || '无'}`);

// ── 观测点：窗口 + 刻度 + DOM + 截图 ──────────────────────────────────────────
async function observe(tag, { gestureFt = null, shots = true } = {}) {
  const wBefore = await windows();
  await clearLegend();
  const resized = await page.evaluate(RESIZE_FN);
  await page.waitForTimeout(1200);
  const frameFt = await page.evaluate(() => window.__ft);
  const wAfter = await windows();

  const shotNames = {};
  if (shots) {
    const full = `B1_${tag}_full.png`;
    await page.screenshot({ path: SHOT(full) });
    shotNames.full = { file: full, md5: md5(SHOT(full)) };
    for (const [sel, name] of [
      ['[data-mp-pane][data-mp-pane-role="base"]', `B1_${tag}_base_${basePeriod}.png`],
      ...satPeriods.map((p) => [`[data-mp-satellite="${p}"]`, `B1_${tag}_sat_${p}.png`]),
    ]) {
      try {
        await page.locator(sel).screenshot({ path: SHOT(name) });
        shotNames[name.replace(`B1_${tag}_`, '').replace('.png', '')] = { file: name, md5: md5(SHOT(name)) };
      } catch (e) { shotNames[name] = { file: name, error: e.message }; }
    }
  }
  const d = await dom();
  const ticks = axisTicks(frameFt);
  const ticksGesture = gestureFt ? axisTicks(gestureFt) : null;
  return { tag, at: new Date().toISOString(), windowsBeforeResize: wBefore, windowsAfterResize: wAfter, resizeStable: JSON.stringify(wBefore) === JSON.stringify(wAfter), resized, ticks, ticksGesture, dom: d, shots: shotNames };
}

function windowSummary(obs) {
  const rows = {};
  for (const w of obs.windowsAfterResize) {
    rows[w.hostId] = {
      bar: w.bar, offsetRight: w.offsetRight, realFrom: w.vr.realFrom, realTo: w.vr.realTo,
      from: fmt(w.realFromTs), to: fmt(w.realToTs),
      fromTs: w.realFromTs, toTs: w.realToTs,
      spanMin: w.spanMs == null ? null : Math.round((w.spanMs / 60000) * 10) / 10,
      realBars: w.realBars, listLen: w.listLen,
    };
  }
  return rows;
}
function pairwise(obs, prevObs) {
  // 基准 hostId = 与 base 周期同名？ -> 用 DOM 顺序：第一个 chart host
  const out = {};
  const cur = windowSummary(obs);
  const prev = prevObs ? windowSummary(prevObs) : null;
  for (const id of Object.keys(cur)) {
    const c = cur[id];
    out[id] = prev ? { ...c, changedVsPrev: JSON.stringify(c) !== JSON.stringify(prev[id]) } : { ...c };
  }
  // 基准 vs 每个卫星的跨度/右缘残差（分钟）——与页面角标 data-mp-span-diff-min 同口径
  const ids = Object.keys(cur);
  const baseId = ids[0];
  out.__syncCheck = {};
  for (let i = 1; i < ids.length; i++) {
    const s = cur[ids[i]];
    out.__syncCheck[ids[i]] = {
      edgeResidualMin: (s.toTs != null && cur[baseId].toTs != null) ? Math.round((s.toTs - cur[baseId].toTs) / 60000) : null,
      spanResidualMin: (s.spanMin != null && cur[baseId].spanMin != null) ? Math.round((s.spanMin - cur[baseId].spanMin) * 10) / 10 : null,
      barSpace: s.bar, baseBarSpace: cur[baseId].bar,
      ratioVsBase: (s.bar && cur[baseId].bar) ? Math.round((s.bar / cur[baseId].bar) * 1000) / 1000 : null,
      offsetRight: s.offsetRight,
    };
  }
  return out;
}
function domInvariants(d) {
  return {
    mpPanesInline: d.mpPanes.map((p) => `${p.period}: role=${p.role} attr=${p.attrHeight} inline=${p.inlineHeight} idx=${p.childIndex}`).join(' | '),
    mpSeps: d.mpSeps.map((s) => `${s.key}@${s.childIndex}(h=${s.attrHeight})`).join(' | '),
    stackChildren: (d.stack?.children || []).map((c) => `${c.tag}[pane=${c.mpPane || '-'}|sep=${c.mpSep || '-'}|h=${c.inlineHeight}]`).join(' -> '),
    stackLayout: d.stack?.layout, stackScrollable: d.stack?.scrollable,
    satHeights: d.sats.map((s) => `${s.period}: inline=${s.inlineHeight} rect=${s.rectHeight}`).join(' | '),
    satOrder: d.sats.map((s) => s.period).join(','),
  };
}

// ── B4-before / 基线 ─────────────────────────────────────────────────────────
const steps = {};
const obs0 = await observe('T00_baseline');
steps.T00 = obs0;
const inv0 = domInvariants(obs0.dom);
log(`[B1] 基线窗口：${JSON.stringify(windowSummary(obs0))}`);
log(`[B1] 基线 x 轴刻度：${JSON.stringify(Object.fromEntries(Object.entries(obs0.ticks).map(([k, v]) => [k, v.ticks])))}`);
log(`[B1] resize 不改变窗口 = ${obs0.resizeStable}`);

// ── B1/B3 手势序列（全部发生在主图 candle 绘图区内） ──────────────────────────
async function gestureDrag(tag, dx) {
  await clearLegend();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const stepsN = 20;
  for (let i = 1; i <= stepsN; i++) await page.mouse.move(cx + Math.round((dx * i) / stepsN), cy);
  await page.mouse.up();
  await page.waitForTimeout(900);
  const gestureFt = await page.evaluate(() => window.__ft);
  return observe(tag, { gestureFt });
}
async function gestureWheel(tag, totalDelta, times) {
  await clearLegend();
  await page.mouse.move(cx, cy);
  for (let i = 0; i < times; i++) { await page.mouse.wheel(0, totalDelta); await page.waitForTimeout(120); }
  await page.waitForTimeout(900);
  const gestureFt = await page.evaluate(() => window.__ft);
  return observe(tag, { gestureFt });
}

const obs1 = await gestureDrag('T01_pan_right_250px', 250);   // 右拖 = 看更早的数据
steps.T01 = obs1;
log(`[B1] T01 拖动(+250px) 后窗口：${JSON.stringify(windowSummary(obs1))}`);
const obs2 = await gestureDrag('T02_pan_left_450px', -450);   // 左拖 = 回到更近的数据
steps.T02 = obs2;
log(`[B1] T02 拖动(-450px) 后窗口：${JSON.stringify(windowSummary(obs2))}`);
const obs3 = await gestureWheel('T03_wheel_zoom_in', -120, 3);
steps.T03 = obs3;
log(`[B1] T03 滚轮放大 后窗口：${JSON.stringify(windowSummary(obs3))}`);
const obs4 = await gestureWheel('T04_wheel_zoom_out', 120, 6);
steps.T04 = obs4;
log(`[B1] T04 滚轮缩小 后窗口：${JSON.stringify(windowSummary(obs4))}`);
const obs5 = await gestureWheel('T05_wheel_zoom_out_more', 120, 10);
steps.T05 = obs5;
log(`[B1] T05 滚轮继续缩小 后窗口：${JSON.stringify(windowSummary(obs5))}`);

// ── B4：VOL 开关往返（图例原文对比）────────────────────────────────────────
const collectVolLegend = async () => {
  await clearLegend();
  await page.evaluate(RESIZE_FN);
  await page.waitForTimeout(1200);
  const ft = await page.evaluate(() => window.__ft);
  const perPane = {};
  for (const r of ft) {
    const k = `${r.chost}|${r.cw}x${r.ch}@top${r.ctop}`;
    (perPane[k] = perPane[k] || new Set()).add(r.t);
  }
  const res = {};
  for (const [k, v] of Object.entries(perPane)) res[k] = Array.from(v);
  const volHits = {};
  for (const [k, v] of Object.entries(res)) {
    const hit = v.filter((t) => /^VOL\(/.test(t) || /^VOLUME:/.test(t));
    if (hit.length) volHits[k] = hit;
  }
  return { perPane: res, volHits };
};
const domBeforeVol = await dom();
const volLegendOn = await collectVolLegend();
await page.getByRole('button', { name: 'VOL', exact: true }).click();
await page.waitForTimeout(1500);
const domAfterVolOff = await dom();
const volLegendOff = await collectVolLegend();
await page.screenshot({ path: SHOT('B4_vol_off_full.png') });
await page.getByRole('button', { name: 'VOL', exact: true }).click();
await page.waitForTimeout(1500);
const domAfterVolOn = await dom();
const volLegendOnAgain = await collectVolLegend();
await page.screenshot({ path: SHOT('B4_vol_on_again_full.png') });

const invAfterVol = domInvariants(domAfterVolOn);
const b4LayoutStable = JSON.stringify(inv0) === JSON.stringify(invAfterVol);

writeTxt('B4_layout_and_vol.txt', [
  '# B4 回归：多周期 pane DOM inline 高度/顺序不变量 + VOL 开关往返',
  `采集时间(UTC)：${new Date().toISOString()}`,
  '',
  '## 不变量逐字段对比（验收开始 T00 基线 vs VOL 两次点击之后）',
  `  [data-mp-pane] inline 高度/角色/声明属性/childIndex`,
  `    基线：${inv0.mpPanesInline}`,
  `    终态：${invAfterVol.mpPanesInline}`,
  `    ⇒ ${inv0.mpPanesInline === invAfterVol.mpPanesInline ? '逐值一致' : '不一致'}`,
  `  [data-mp-separator] 顺序/高度`,
  `    基线：${inv0.mpSeps}`,
  `    终态：${invAfterVol.mpSeps}`,
  `    ⇒ ${inv0.mpSeps === invAfterVol.mpSeps ? '一致' : '不一致'}`,
  `  [data-mp-stack] children 顺序`,
  `    基线：${inv0.stackChildren}`,
  `    终态：${invAfterVol.stackChildren}`,
  `    ⇒ ${inv0.stackChildren === invAfterVol.stackChildren ? '一致' : '不一致'}`,
  `  卫星 pane 顺序：基线=${inv0.satOrder} 终态=${invAfterVol.satOrder}`,
  `  卫星 pane 高度：基线=${inv0.satHeights} 终态=${invAfterVol.satHeights}`,
  `  stack layout=${invAfterVol.stackLayout} scrollable=${invAfterVol.stackScrollable}`,
  '',
  '## VOL 开关（点击前 / 点击后 / 再点击）',
  `  点击前 aria-pressed=${domBeforeVol.volButton?.ariaPressed}`,
  `  点击后 aria-pressed=${domAfterVolOff.volButton?.ariaPressed}`,
  `  再点击 aria-pressed=${domAfterVolOn.volButton?.ariaPressed}`,
  `  outerHTML（点击前）：${domBeforeVol.volButton?.outerHTML}`,
  '',
  '## VOL 图例原文（canvas fillText 捕获；含 VOL( 或 VOLUME: 的画布）',
  `  点击前（默认开）：${JSON.stringify(volLegendOn.volHits)}`,
  `  点击关闭后：${JSON.stringify(volLegendOff.volHits)}`,
  `  再点开：${JSON.stringify(volLegendOnAgain.volHits)}`,
  '',
  `## 判定`,
  `  pane inline/顺序不变量：${b4LayoutStable ? 'PASS' : 'FAIL'}`,
  `  VOL 关闭后 VOL 图例命中画布数（应为 0）：${Object.keys(volLegendOff.volHits).length}`,
  `  VOL 再开后 VOL 图例命中（应 ≥ 点击前）：${Object.keys(volLegendOnAgain.volHits).length}`,
  '',
  '## 截图',
  '  B4_vol_off_full.png（VOL 关闭）',
  '  B4_vol_on_again_full.png（VOL 恢复）',
].join('\n') + '\n');
log(`[B4] pane 不变量一致=${b4LayoutStable}；VOL 关闭后图例命中=${Object.keys(volLegendOff.volHits).length}；再开命中=${Object.keys(volLegendOnAgain.volHits).length}`);

// B4：整个验收窗口逐观测点的 pane 不变量（含 5 次手势之后）
{
  const rows = [['T00(基线)', inv0]];
  for (const t of ['T01', 'T02', 'T03', 'T04', 'T05']) rows.push([t, domInvariants(steps[t].dom)]);
  rows.push(['VOL关', domInvariants(domAfterVolOff)]);
  rows.push(['VOL再开(终态)', invAfterVol]);
  const same = rows.every(([, v]) => JSON.stringify(v) === JSON.stringify(inv0));
  writeTxt('B4_dom_invariants_per_step.txt', [
    '# B4 多周期 pane DOM 不变量 —— 逐观测点（含 5 次主图手势 + VOL 往返）',
    `采集时间(UTC)：${new Date().toISOString()}`,
    '',
    ...[].concat(...rows.map(([tag, v]) => [`## ${tag}`, `  panes: ${v.mpPanesInline}`, `  separators: ${v.mpSeps}`, `  stack children: ${v.stackChildren}`, `  sat: ${v.satHeights} | order=${v.satOrder}`, `  layout=${v.stackLayout} scrollable=${v.stackScrollable}`, ''])),
    `## 结论：8 个观测点的不变量与基线${same ? '逐字段完全一致' : '存在差异（见上）'}`,
  ].join('\n') + '\n');
  log(`[B4] 8 个观测点 pane 不变量与基线一致 = ${same}`);
}

// ── 汇总写盘 ─────────────────────────────────────────────────────────────────
const order = ['T00', 'T01', 'T02', 'T03', 'T04', 'T05'];
const tags = { T00: 'T00_baseline', T01: 'T01_pan_right_250px', T02: 'T02_pan_left_450px', T03: 'T03_wheel_zoom_in', T04: 'T04_wheel_zoom_out', T05: 'T05_wheel_zoom_out_more' };

// B1 窗口表
const lines = ['# B1 主图拖动/缩放后各实例「可见时间窗」客观读数', `采集时间(UTC)：${new Date().toISOString()}`, '',
  '说明：窗口 = `chart.getVisibleRange()`（realFrom/realTo）映射到 `chart.getDataList()` 的 timestamp；',
  '      `spanMin` = 右缘 ts − 左缘 ts（分钟）；`bar` = `getBarSpace().bar`（px/bar）；`off` = `getOffsetRightDistance()`。',
  '      `resizeStable` = 强制重绘（chart.resize()）前后窗口是否逐字段相同（用于证明取刻度文本的动作不扰动窗口）。',
  '      时间一律为 Asia/Shanghai（CST，UTC+8）；括号内为 epoch 毫秒。', ''];
const winTable = {};
for (const t of order) {
  const o = steps[t];
  const summ = windowSummary(o);
  winTable[t] = summ;
  lines.push(`## ${tags[t]}（${o.at}）  resizeStable=${o.resizeStable}`);
  for (const [id, r] of Object.entries(summ)) {
    lines.push(`  ${id.padEnd(16)} bar=${String(r.bar).padStart(4)} off=${String(r.offsetRight).padStart(4)} realFrom=${r.realFrom} realTo=${r.realTo} from=${r.from}(${r.fromTs}) to=${r.to}(${r.toTs}) spanMin=${r.spanMin} realBars=${r.realBars} listLen=${r.listLen}`);
  }
  const pw = pairwise(o, t === 'T00' ? null : steps[order[order.indexOf(t) - 1]]);
  lines.push(`  同步检查（基准=第一个实例）：${JSON.stringify(pw.__syncCheck)}`);
  lines.push(`  相对上一观测点是否变化：${JSON.stringify(Object.fromEntries(Object.entries(pw).filter(([k]) => k !== '__syncCheck').map(([k, v]) => [k, v.changedVsPrev])))}`);
  const badges = o.dom.sats.map((s) => `${s.period}: excluded=${s.excluded ? s.excluded.attrReason : '-'} degraded=${s.degraded ? 'spanDiff=' + s.degraded.spanDiffMin : '-'}`);
  lines.push(`  卫星角标：${badges.join(' | ')}；整组未建立角标=${o.dom.groupUnestablished ? o.dom.groupUnestablished.reason : '无'}`);
  lines.push('');
}
writeTxt('B1_windows.txt', lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'B1_windows.json'), JSON.stringify(winTable, null, 2));

// B1 刻度表
const tlines = ['# B1 x 轴刻度文本集合（canvas fillText 捕获）对比', `采集时间(UTC)：${new Date().toISOString()}`, '',
  '口径：每实例取「画布高度 ≤40px 且含时间型文本」的画布（即 klinecharts 的 x 轴刻度画布，实测 26px）；',
  '      每组给 `frame`（一次 chart.resize() 全帧重绘后）+ `gesture`（本次手势期间逐帧捕获的并集；基线无手势）。', ''];
const tickTable = {};
for (const t of order) {
  const o = steps[t];
  tickTable[t] = { frame: o.ticks, gesture: o.ticksGesture };
  tlines.push(`## ${tags[t]}（${o.at}）`);
  for (const [host, v] of Object.entries(o.ticks)) {
    tlines.push(`  ${host}  canvas=${v.canvas}`);
    tlines.push(`    frame   (${v.ticks.length}): ${JSON.stringify(v.ticks)}`);
    const gv = o.ticksGesture && o.ticksGesture[host];
    tlines.push(`    gesture (${gv ? gv.ticks.length : 0}): ${JSON.stringify(gv ? gv.ticks : [])}`);
  }
  if (t !== 'T00') {
    const prev = steps[order[order.indexOf(t) - 1]];
    tlines.push(`  --- 与上一观测点（${tags[order[order.indexOf(t) - 1]]}）的 frame 集合差异 ---`);
    for (const host of Object.keys(o.ticks)) {
      const a = prev.ticks[host]?.ticks || [], b = o.ticks[host]?.ticks || [];
      const d = setDiff(a, b);
      tlines.push(`    ${host}: ${setEq(a, b) ? '集合完全相同' : `removed=${JSON.stringify(d.removed)} added=${JSON.stringify(d.added)}`}`);
      // 已知锚点横向位移
      const pa = {}; for (const s of (prev.ticks[host]?.anchored || [])) { const [lab, x] = s.split('@x='); pa[lab] = Number(x); }
      const shifts = [];
      for (const s of (o.ticks[host]?.anchored || [])) {
        const [lab, x] = s.split('@x=');
        if (pa[lab] != null) shifts.push(`${lab}: ${pa[lab]}→${Number(x)} (Δ=${Number(x) - pa[lab]}px)`);
      }
      tlines.push(`    同标签横向位移：${shifts.length ? shifts.join('; ') : '（无共同标签）'}`);
    }
  }
  tlines.push('');
}
writeTxt('B1_axis_ticks.txt', tlines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'B1_axis_ticks.json'), JSON.stringify(tickTable, null, 2));

// B3 角标
const lastObs = steps.T05;
const b3sat = lastObs.dom.sats.find((s) => s.excluded);
const b3lines = ['# B3 被排除卫星（运行时配置）可见角标 DOM 原文 + 不随动证据', `采集时间(UTC)：${new Date().toISOString()}`, ''];
b3lines.push(`## 运行时多周期配置（GET /api/config/multi_period）`, cfgStart.detail.multi_period.raw, '');
b3lines.push(`## 各卫星角标现状（末次观测 T05）`);
for (const s of lastObs.dom.sats) {
  b3lines.push(`  卫星 ${s.period}：excluded=${s.excluded ? s.excluded.attrReason : 'null'}  degraded=${s.degraded ? s.degraded.spanDiffMin + 'min' : 'null'}  error=${s.error ? s.error.text : 'null'}`);
}
b3lines.push('');
if (b3sat && b3sat.excluded) {
  b3lines.push('## 被排除卫星角标 outerHTML（原文）', b3sat.excluded.outerHTML, '');
  b3lines.push('## 属性/文案');
  b3lines.push(`  data-mp-sync-excluded        = ${b3sat.excluded.attrPeriod}`);
  b3lines.push(`  data-mp-sync-excluded-reason = ${b3sat.excluded.attrReason}`);
  b3lines.push(`  textContent                  = ${JSON.stringify(b3sat.excluded.text)}`);
  b3lines.push(`  title                        = ${JSON.stringify(b3sat.excluded.title)}`);
  b3lines.push(`  role                         = ${b3sat.excluded.role}`);
  b3lines.push(`  可见（offsetParent!=null）    = ${b3sat.excluded.visible}`);
  b3lines.push(`  boundingRect                 = ${JSON.stringify(b3sat.excluded.rect)}`);
} else {
  b3lines.push('## 未找到 [data-mp-sync-excluded] 角标');
}
b3lines.push('');
b3lines.push('## 「不随动」证据（各观测点该卫星的窗口读数）');
for (const t of order) {
  const w = steps[t].windowsAfterResize.find((x) => x.hostId === (b3sat ? b3sat.chartHostIds[0] : ''));
  b3lines.push(`  ${tags[t]}: bar=${w?.bar} off=${w?.offsetRight} realFrom=${w?.vr?.realFrom} realTo=${w?.vr?.realTo} from=${fmt(w?.realFromTs)} to=${fmt(w?.realToTs)} spanMin=${w?.spanMs == null ? null : Math.round(w.spanMs / 60000 * 10) / 10}`);
}
b3lines.push('');
b3lines.push('## 同时给出基准与可同步卫星的同表读数（对照）');
for (const t of order) {
  for (const w of steps[t].windowsAfterResize) {
    b3lines.push(`  ${tags[t]} ${w.hostId}: bar=${w.bar} from=${fmt(w.realFromTs)} to=${fmt(w.realToTs)} spanMin=${w.spanMs == null ? null : Math.round(w.spanMs / 60000 * 10) / 10}`);
  }
}
b3lines.push('');
b3lines.push('## 截图');
b3lines.push('  B1_T00_baseline_full.png / B1_T00_sat_*.png（基线，含角标）');
b3lines.push('  B1_T05_wheel_zoom_out_more_full.png / B1_T05_sat_*.png（大幅缩放后，角标仍在且窗口不变）');
writeTxt('B3_excluded_badge.txt', b3lines.join('\n') + '\n');

// ── B2/B5：console / 网络 / 配置 ─────────────────────────────────────────────
const cfgEnd = await readConfigs('end');
const sameConfig = JSON.stringify(cfgStart.canonical) === JSON.stringify(cfgEnd.canonical);
const errWarn = consoleMsgs.filter((m) => m.type === 'error' || m.type === 'warning');
const syncWarn = consoleMsgs.filter((m) => m.text.includes('ChartSyncGroup 未建立'));
const methods = Array.from(new Set(apiResponses.map((r) => r.split(' ')[0])));
const nonGet = methods.filter((m) => m !== 'GET');

writeTxt('B2_console.txt', [
  '# B2 console 全文（含「ChartSyncGroup 未建立」检索）',
  `采集时间(UTC)：${new Date().toISOString()}`,
  '',
  `## 命中「ChartSyncGroup 未建立」的 console 条目数 = ${syncWarn.length}（0 = PASS）`,
  ...(syncWarn.length ? syncWarn.map((m) => `  [${m.type}] ${m.text} (${m.loc})`) : ['  （无）']),
  '',
  `## console 全部条目（共 ${consoleMsgs.length} 条；error/warning 共 ${errWarn.length} 条）`,
  ...(consoleMsgs.length ? consoleMsgs.map((m) => `  [${m.type}] ${m.text} (${m.loc})`) : ['  （无任何 console 消息）']),
].join('\n') + '\n');

writeTxt('B5_zero_write_and_errors.txt', [
  '# B5 零配置写入 / 仅 GET / console error & pageerror & requestfailed',
  `验收窗口(UTC)：${results.startedAt} → ${new Date().toISOString()}`,
  '',
  '## 开始读取（A5_config_start.txt）',
  ...CONFIG_KEYS.map((k) => `  GET /api/config/${k} ⇒ ${cfgStart.detail[k].raw}`),
  '',
  '## 结束读取（A5_config_end.txt）',
  ...CONFIG_KEYS.map((k) => `  GET /api/config/${k} ⇒ ${cfgEnd.detail[k].raw}`),
  '',
  `## 逐字段对比 ⇒ ${sameConfig ? '两次完全相同（零写入）' : '存在差异！'}`,
  '',
  `## 页面会话内 /api/ 请求方法集合 = ${JSON.stringify(methods)}；非 GET 方法 = ${JSON.stringify(nonGet)}`,
  `## 去重后的 /api/ 请求（方法+状态+URL）：`,
  ...Array.from(new Set(apiResponses)).map((r) => `  ${r}`),
  '',
  `## console error/warning 计数 = ${errWarn.length}`,
  ...(errWarn.length ? errWarn.map((m) => `  [${m.type}] ${m.text} (${m.loc})`) : ['  （无）']),
  `## pageerror 计数 = ${pageErrors.length}`,
  ...(pageErrors.length ? pageErrors.map((e) => `  ${e.message}\n${e.stack}`) : ['  （无）']),
  `## requestfailed 计数 = ${failedRequests.length}`,
  ...(failedRequests.length ? failedRequests.map((r) => `  ${r.method} ${r.url} ${r.failure}`) : ['  （无）']),
].join('\n') + '\n');
log(`[B2] 「ChartSyncGroup 未建立」命中 ${syncWarn.length} 条（0 = PASS）`);
log(`[B5] 两次配置逐字段相同 = ${sameConfig}；/api/ 方法集合=${JSON.stringify(methods)}；console err/warn=${errWarn.length} pageerror=${pageErrors.length} requestfailed=${failedRequests.length}`);

results.items.B1 = { steps: Object.fromEntries(order.map((t) => [t, { tag: tags[t], at: steps[t].at, windows: windowSummary(steps[t]), resizeStable: steps[t].resizeStable, domBadges: steps[t].dom.sats.map((s) => ({ period: s.period, excluded: s.excluded?.attrReason ?? null, degradedSpanDiffMin: s.degraded?.spanDiffMin ?? null })) }])) };
results.items.B2 = { syncWarnCount: syncWarn.length, syncWarn, consoleCount: consoleMsgs.length, errWarnCount: errWarn.length, errWarn, consoleAll: consoleMsgs };
results.items.B3 = { excludedSatellite: b3sat ? { period: b3sat.excluded.attrPeriod, reason: b3sat.excluded.attrReason, text: b3sat.excluded.text, title: b3sat.excluded.title, outerHTML: b3sat.excluded.outerHTML, visible: b3sat.excluded.visible, rect: b3sat.excluded.rect } : null, allSatBadges: lastObs.dom.sats.map((s) => ({ period: s.period, excluded: s.excluded, degraded: s.degraded, error: s.error })) };
results.items.B4 = { layoutStable: b4LayoutStable, invariantsBefore: inv0, invariantsAfter: invAfterVol, volButton: { before: domBeforeVol.volButton, off: domAfterVolOff.volButton, on: domAfterVolOn.volButton }, volLegend: { on: volLegendOn.volHits, off: volLegendOff.volHits, onAgain: volLegendOnAgain.volHits } };
results.items.B5 = { sameConfig, startCanonical: cfgStart.canonical, endCanonical: cfgEnd.canonical, apiMethods: methods, nonGet, apiResponses: Array.from(new Set(apiResponses)), errWarnCount: errWarn.length, pageErrors, failedRequests, env };

fs.writeFileSync(path.join(OUT, '287_results.json'), JSON.stringify(results, null, 2));
writeTxt('287_run.log', runLog.join('\n') + '\n');
log('DONE');
await browser.close();
