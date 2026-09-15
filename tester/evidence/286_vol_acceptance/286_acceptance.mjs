#!/usr/bin/env node
/**
 * 286 独立验收脚本（真渲染 + 只读）。
 *
 * 验收对象：线上 http://127.0.0.1:8081/（title「eestock · 行情看板」，bundle /assets/index-dH4SuwMy.js）
 * 被验口径：VOL 成交量副图 ⇒ 可关闭的普通指标开关（默认开、会话态；关掉 ⇒ 主图 + 全部多周期卫星
 *          都不再有 VOL 副图；切换 VOL 不得重建/重置其它 pane）。
 *
 * 禁令遵守：
 *  - 对 /api/* **只发 GET**（本脚本内除 GET 外不发任何请求；页面自身的配置读也是 GET）。
 *  - 不点「周期选择」入口的确定按钮（会写配置）。
 *  - 不用图表导出截图（零高 candle pane 会让 getConvertPictureUrl 抛错）——一律 page.screenshot。
 *  - 本脚本只写 tester/evidence/286_vol_acceptance/ 下的证据文件；不写任何工作区其它文件。
 *
 * 运行（必须 cwd = web/，以便 @playwright/test 解析）：
 *   cd <repo>/web && node <repo>/tester/evidence/286_vol_acceptance/286_acceptance.mjs
 *
 * 说明：`@playwright/test` 用**绝对路径**导入，避免脚本位于 tester/ 下时裸包名解析失败。
 */
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/@playwright/test/index.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/286_vol_acceptance';
const BASE = 'http://127.0.0.1:8081/';
const CONFIG_KEYS = ['multi_period', 'kline', 'ma'];
const SHOT = (n) => path.join(OUT, n);

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
    let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
    out[k] = { url, status: res.status, raw: text, json };
  }
  const lines = [`# GET /api/config/* (${tag}) — 只读，无任何写请求`];
  let canonical = {};
  for (const k of CONFIG_KEYS) {
    lines.push(`--- GET /api/config/${k} ---`, `HTTP ${out[k].status}`, out[k].raw);
    canonical[k] = out[k].json ?? out[k].raw;
  }
  writeTxt(`A6_config_${tag}.txt`, lines.join('\n') + '\n');
  return { detail: out, canonical };
}

function dbUpdatedAt() {
  try {
    const sql = `select key, updated_at, value from app_config order by key;`;
    return execSync(
      `PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -At -F '|' -c ${JSON.stringify(sql)}`,
      { encoding: 'utf8' },
    ).trim();
  } catch (e) { return `PSQL_ERROR: ${e.message}`; }
}

// ───────────────────────── 页面侧探针（fillText 图例捕获 / DOM 快照 / chart 实例扫描） ─────────────────────────
const INIT_SCRIPT = () => {
  window.__ft = [];
  const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
    try {
      const c = this.canvas;
      const host = c.closest('[k-line-chart-id]');
      const paneDiv = c.closest('div[style*="position: absolute"]');
      const paneHost = paneDiv ? paneDiv.parentElement : null;
      const paneIdx = paneHost && paneHost.parentElement
        ? Array.from(paneHost.parentElement.children).indexOf(paneHost)
        : -1;
      window.__ft.push({
        text: String(text),
        chart: host ? host.getAttribute('k-line-chart-id') : '?',
        paneIdx,
        paneHeight: paneHost ? paneHost.style.height : '?',
      });
    } catch (e) { /* ignore */ }
    return orig.call(this, text, x, y, ...rest);
  };
};

const SNAPSHOT_FN = () => {
  const charts = {};
  document.querySelectorAll('[k-line-chart-id]').forEach((host) => {
    const id = host.getAttribute('k-line-chart-id');
    const inner = host.firstElementChild;
    const kids = Array.from(inner.children);
    const panes = [], seps = [], axes = [];
    for (const k of kids) {
      const c = k.firstElementChild;
      if (k.style.backgroundColor) { seps.push({ h: k.style.height }); continue; }
      const cur = c ? c.style.cursor : '';
      if (cur === 'ew-resize') axes.push({ h: k.style.height }); else panes.push({ h: k.style.height });
    }
    charts[id] = {
      hostMark: host.getAttribute('data-accept-mark'),
      paneCount: panes.length,
      panes: panes.map((p) => p.h),
      sepCount: seps.length,
      seps: seps.map((s) => s.h),
      axis: axes.map((a) => a.h),
      hostRectH: Math.round(host.getBoundingClientRect().height),
      hostRectW: Math.round(host.getBoundingClientRect().width),
      domId: host.parentElement ? host.parentElement.getAttribute('data-testid') : null,
    };
  });
  const mpPanes = [];
  document.querySelectorAll('[data-mp-pane]').forEach((el) => {
    mpPanes.push({
      period: el.getAttribute('data-mp-pane'),
      role: el.getAttribute('data-mp-pane-role'),
      attrHeight: el.getAttribute('data-mp-pane-height'),
      inlineHeight: el.style.height,
      rectHeight: Math.round(el.getBoundingClientRect().height),
      childIndex: Array.from(el.parentElement.children).indexOf(el),
    });
  });
  const mpSeps = [];
  document.querySelectorAll('[data-mp-separator]').forEach((el) => {
    mpSeps.push({
      key: el.getAttribute('data-mp-separator'),
      sepHeightAttr: el.getAttribute('data-mp-sep-height'),
      rectHeight: Math.round(el.getBoundingClientRect().height),
      rectTop: Math.round(el.getBoundingClientRect().top),
    });
  });
  const sats = [];
  document.querySelectorAll('[data-mp-satellite]').forEach((el) => {
    sats.push({
      period: el.getAttribute('data-mp-satellite'),
      inlineHeight: el.style.height,
      rectHeight: Math.round(el.getBoundingClientRect().height),
      basePeriod: el.getAttribute('data-mp-base-period'),
      basePeriodSource: el.getAttribute('data-mp-base-period-source'),
      chartHostIds: Array.from(el.querySelectorAll('[k-line-chart-id]')).map((c) => c.getAttribute('k-line-chart-id')),
    });
  });
  const stack = document.querySelector('[data-mp-stack]');
  const btns = Array.from(document.querySelectorAll('button'));
  const volBtn = btns.find((b) => (b.textContent || '').trim() === 'VOL');
  const toolbarBtns = Array.from(document.querySelectorAll('[data-region="toolbar"] button'))
    .map((b) => ({ text: (b.textContent || '').trim(), ariaPressed: b.getAttribute('aria-pressed'), ariaLabel: b.getAttribute('aria-label') }));
  return {
    charts,
    chartIds: Object.keys(charts),
    mpPanes,
    mpSeps,
    sats,
    stack: stack
      ? {
          layout: stack.getAttribute('data-mp-stack-layout'),
          scrollable: stack.getAttribute('data-mp-stack-scrollable'),
          clientHeight: stack.clientHeight,
          childCount: stack.children.length,
          children: Array.from(stack.children).map((c) => ({
            tag: c.tagName.toLowerCase(),
            mpPane: c.getAttribute('data-mp-pane'),
            mpSep: c.getAttribute('data-mp-separator'),
            inlineHeight: c.style.height,
          })),
        }
      : null,
    volButton: volBtn
      ? {
          outerHTML: volBtn.outerHTML,
          text: volBtn.textContent.trim(),
          ariaPressed: volBtn.getAttribute('aria-pressed'),
          className: volBtn.className,
          visible: volBtn.offsetParent !== null,
        }
      : null,
    toolbarBtns,
  };
};

const LEGEND_FN = () => {
  const out = {};
  for (const r of window.__ft) {
    const key = `${r.chart}|pane#${r.paneIdx}|${r.paneHeight}`;
    (out[key] = out[key] || new Set()).add(r.text);
  }
  const res = {};
  for (const k of Object.keys(out)) res[k] = [...out[k]];
  return res;
};

const CHART_INSTANCE_FN = () => {
  const res = [];
  document.querySelectorAll('[data-testid="kline-chart"]').forEach((el) => {
    const hostId = el.getAttribute('k-line-chart-id');
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!fk) { res.push({ hostId, found: false }); return; }
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
    if (!chart) { res.push({ hostId, found: false }); return; }
    let panes = null;
    try { panes = chart.getPaneOptions(); } catch (e) { panes = `ERR:${e.message}`; }
    res.push({
      hostId,
      found: true,
      acceptMark: chart.__acceptMark ?? null,
      indicators: chart.getIndicators().map((i) => ({ name: i.name, paneId: i.paneId, calcParams: i.calcParams })),
      paneOptions: Array.isArray(panes)
        ? panes.map((p) => ({ id: p.id, height: p.height, minHeight: p.minHeight, state: p.state, order: p.order }))
        : panes,
    });
  });
  return res;
};

const MARK_FN = (tag) => {
  const out = { hosts: [], charts: [] };
  document.querySelectorAll('[data-testid="kline-chart"]').forEach((el, i) => {
    const mark = `${tag}-h${i}`;
    el.setAttribute('data-accept-mark', mark);
    out.hosts.push({ hostId: el.getAttribute('k-line-chart-id'), mark });
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!fk) return;
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
    if (chart) { chart.__acceptMark = `${tag}-c${i}`; out.charts.push({ hostId: el.getAttribute('k-line-chart-id'), mark: chart.__acceptMark }); }
  });
  return out;
};

// ───────────────────────── 工具 ─────────────────────────
const VOL_LEGEND_RE = /^VOL\(/;      // klinecharts 指标图例行（name(calcParams)）
const VOL_LABEL_RE = /^VOLUME:/;     // VOL 副图图例的量标签

function volLegendPanes(legends) {
  const hits = {};
  for (const [k, texts] of Object.entries(legends)) {
    const lt = texts.filter((t) => VOL_LEGEND_RE.test(t));
    const lb = texts.filter((t) => VOL_LABEL_RE.test(t));
    if (lt.length || lb.length) hits[k] = { legendLine: lt, label: lb };
  }
  return hits;
}
function legendLinesOnly(texts) {
  // 只保留「指标图例」形态的文本（排除纯数字/坐标轴刻度），用于报告「图例原文」
  return texts.filter((t) => !/^[-\d.,%MKB]+$/.test(t) && t.trim() !== '');
}

// ───────────────────────── 主流程 ─────────────────────────
const results = { startedAt: new Date().toISOString(), items: {} };

const cfgStart = await readConfigs('start');
log(`[A6] 验收窗口开始：GET /api/config/* 已读取（multi_period=${cfgStart.detail.multi_period.raw}）`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});
const page = await context.newPage();
await page.addInitScript(INIT_SCRIPT);

const consoleMsgs = [];
const pageErrors = [];
const failedRequests = [];
const apiResponses = [];
page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text(), loc: m.location() }));
page.on('pageerror', (e) => pageErrors.push({ message: e.message, stack: (e.stack || '').split('\n').slice(0, 6).join('\n') }));
page.on('requestfailed', (r) => failedRequests.push({ method: r.method(), url: r.url(), failure: r.failure()?.errorText }));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/')) apiResponses.push(`${r.request().method()} ${r.status()} ${u}`);
});

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
// 等待三图就位（基准 + 2 卫星）与 VOL 开关出现
await page.waitForSelector('[data-mp-stack]', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('[k-line-chart-id]').length >= 3, null, { timeout: 30000 });
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'VOL'),
  null, { timeout: 30000 },
);
await page.waitForTimeout(3000);

const servedHtml = await (await fetch(BASE)).text();
const bundleMatch = servedHtml.match(/\/assets\/index-[\w-]+\.js/);
log(`[pre] 线上 index.html bundle = ${bundleMatch ? bundleMatch[0] : 'NOT FOUND'}`);

/** 强制全部实例重绘：直接调用引擎自身的 `chart.resize()`（只读式重排/重绘，不改指标、不改 pane 高度、
 *  不写配置）。理由：本页布局 min-width=1280 且内容宽 > 视口宽 ⇒ 改视口宽度不会改变容器宽度、
 *  ResizeObserver 不触发 ⇒ 仅靠视口抖动拿不到基线图例（实测 A2 图例为空）。 */
const FORCE_RESIZE_FN = () => {
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
async function forceRedraw() {
  const r = await page.evaluate(FORCE_RESIZE_FN);
  await page.waitForTimeout(1200);
  const again = await page.evaluate(async () => {
    // 二次重绘：确保所有 pane 的图例在本次窗口内被绘制
    document.querySelectorAll('[data-testid="kline-chart"]').forEach((el) => {
      const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (!fk) return;
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
      if (chart && typeof chart.resize === 'function') chart.resize();
    });
    return true;
  });
  await page.waitForTimeout(600);
  return { first: r, second: again };
}
const clearLegend = () => page.evaluate(() => { window.__ft = []; });
const snap = () => page.evaluate(SNAPSHOT_FN);
const legends = () => page.evaluate(LEGEND_FN);
const instances = () => page.evaluate(CHART_INSTANCE_FN);

async function capture(tag, shotNames = {}) {
  const redraw = await forceRedraw();
  const s = await snap();
  const l = await legends();
  const inst = await instances();
  if (shotNames.full) await page.screenshot({ path: SHOT(shotNames.full) });
  if (shotNames.toolbar) await page.locator('[data-region="toolbar"]').screenshot({ path: SHOT(shotNames.toolbar) }).catch(() => {});
  if (shotNames.base) await page.locator('[data-mp-pane][data-mp-pane-role="base"]').screenshot({ path: SHOT(shotNames.base) }).catch(() => {});
  return { tag, at: new Date().toISOString(), redraw, snapshot: s, legends: l, instances: inst };
}

// ── A1 ────────────────────────────────────────────────────────────────────────
const a1Snap = await snap();
const toolbarButtons = a1Snap.toolbarBtns;
const indicatorRow = toolbarButtons.filter((b) => ['MA', 'VOL', 'MACD', 'KDJ', 'BOLL', 'DCAP'].includes(b.text));
await page.locator('[data-region="toolbar"]').screenshot({ path: SHOT('A1_toolbar_vol_default_on.png') }).catch(() => {});
await page.screenshot({ path: SHOT('A1_fullpage_default_on.png') });
const a1Pass = !!a1Snap.volButton && a1Snap.volButton.ariaPressed === 'true';
results.items.A1 = { pass: a1Pass, volButton: a1Snap.volButton, indicatorRow };
writeTxt('A1_toolbar_vol_switch.txt', [
  '# A1 工具栏 VOL 开关（默认开）DOM 契约',
  `抓取时间：${new Date().toISOString()}`,
  '',
  '## VOL 开关 outerHTML（原文）',
  a1Snap.volButton ? a1Snap.volButton.outerHTML : 'NOT FOUND',
  '',
  '## 属性',
  `text            = ${a1Snap.volButton?.text}`,
  `aria-pressed    = ${a1Snap.volButton?.ariaPressed}`,
  `visible         = ${a1Snap.volButton?.visible}`,
  `className       = ${a1Snap.volButton?.className}`,
  '',
  '## 指标开关行（顺序 + 各自 aria-pressed，证明 VOL 与 MA/MACD/KDJ/BOLL/DCAP 并列）',
  ...indicatorRow.map((b) => `  ${b.text.padEnd(6)} aria-pressed=${b.ariaPressed}`),
  '',
  '## 截图',
  '  A1_toolbar_vol_default_on.png（工具栏区域）',
  '  A1_fullpage_default_on.png（整页）',
].join('\n') + '\n');
log(`[A1] ${a1Pass ? 'PASS' : 'FAIL'} VOL 开关 aria-pressed=${a1Snap.volButton?.ariaPressed}`);

// ── A2 基线取证 ───────────────────────────────────────────────────────────────
await clearLegend();
const a2 = await capture('A2', { full: 'A2_baseline_full.png', base: 'A2_baseline_base_pane.png' });
const satPeriods = a2.snapshot.sats.map((s) => s.period);
for (const p of satPeriods) {
  await page.locator(`[data-mp-satellite="${p}"]`).screenshot({ path: SHOT(`A2_baseline_satellite_${p}.png`) }).catch(() => {});
}
const baseChartId = a2.snapshot.mpPanes.find((p) => p.role === 'base')?.period;
const a2VolHits = volLegendPanes(a2.legends);
results.items.A2 = {
  satellitePeriods: satPeriods,
  basePeriodFromStackPane: baseChartId,
  snapshot: a2.snapshot,
  volLegendPanes: a2VolHits,
  legends: a2.legends,
  instances: a2.instances,
};
const legendReport = (l) => Object.entries(l).map(([k, v]) => `  ${k}: ${JSON.stringify(legendLinesOnly(v))}`).join('\n');
writeTxt('A2_baseline.txt', [
  '# A2 基线取证（VOL 默认开）',
  `抓取时间：${a2.at}`,
  '',
  `## 多周期配置（运行时 GET /api/config/multi_period）`,
  cfgStart.detail.multi_period.raw,
  `⇒ 基准 pane = ${baseChartId}；卫星 = ${satPeriods.join(', ')}`,
  '',
  '## [data-mp-pane] inline 高度（多周期栈）',
  ...a2.snapshot.mpPanes.map((p) => `  ${p.period}  role=${p.role}  attr=${p.attrHeight}  inline=${p.inlineHeight}  rect=${p.rectHeight}  childIndex=${p.childIndex}`),
  '',
  '## [data-mp-separator]（栈级分隔条）',
  ...a2.snapshot.mpSeps.map((s) => `  ${s.key}  data-mp-sep-height=${s.sepHeightAttr}  rect=${s.rectHeight}`),
  '',
  '## 每个 klinecharts 实例（DOM）：pane 内联高度 / separator 数 / x 轴',
  ...Object.entries(a2.snapshot.charts).map(([id, c]) =>
    `  ${id}: panes=${JSON.stringify(c.panes)} sepCount=${c.sepCount} seps=${JSON.stringify(c.seps)} xAxis=${JSON.stringify(c.axis)} hostRect=${c.hostRectW}x${c.hostRectH}`),
  '',
  '## 每个 pane 的图例原文（canvas fillText 捕获，排除纯数字刻度）',
  legendReport(a2.legends),
  '',
  '## 引擎侧指标（chart.getIndicators()，通过 React fiber 取实例）',
  JSON.stringify(a2.instances, null, 1),
  '',
  `## 含 VOL 图例行的 pane：${JSON.stringify(a2VolHits)}`,
  '',
  '## 截图',
  '  A2_baseline_full.png（整页）',
  '  A2_baseline_base_pane.png（基准 pane 5m）',
  ...satPeriods.map((p) => `  A2_baseline_satellite_${p}.png（卫星 ${p}）`),
].join('\n') + '\n');
log(`[A2] 基线：基准=${baseChartId} 卫星=[${satPeriods.join(',')}]；含 VOL 图例的 pane=${Object.keys(a2VolHits).join(' | ')}`);

// ── A3 关闭 VOL ───────────────────────────────────────────────────────────────
const markBefore = await page.evaluate(MARK_FN, 'A3');
await clearLegend();
await page.getByRole('button', { name: 'VOL', exact: true }).click();
await page.waitForTimeout(1500);
const a3 = await capture('A3', { full: 'A3_vol_off_full.png', base: 'A3_vol_off_base_pane.png' });
for (const p of satPeriods) {
  await page.locator(`[data-mp-satellite="${p}"]`).screenshot({ path: SHOT(`A3_vol_off_satellite_${p}.png`) }).catch(() => {});
}
const a3VolHits = volLegendPanes(a3.legends);
const a3VolBtn = a3.snapshot.volButton;
const a3Pass = a3VolBtn?.ariaPressed === 'false' && Object.keys(a3VolHits).length === 0;
results.items.A3 = { pass: a3Pass, volButton: a3VolBtn, volLegendPanes: a3VolHits, snapshot: a3.snapshot, legends: a3.legends };
writeTxt('A3_vol_off.txt', [
  '# A3 点击 VOL 关闭 ⇒ 主图 + 全部卫星 pane 内 VOL 图例消失',
  `抓取时间：${a3.at}`,
  '',
  `## 开关态：aria-pressed=${a3VolBtn?.ariaPressed}（点击前 = true）`,
  `## outerHTML：${a3VolBtn?.outerHTML}`,
  '',
  '## 关闭前（A2 基线）含 VOL 图例的 pane',
  JSON.stringify(a2VolHits),
  '',
  '## 关闭后含 VOL 图例的 pane（必须为空）',
  JSON.stringify(a3VolHits),
  '',
  '## 关闭后每个 pane 的图例原文',
  legendReport(a3.legends),
  '',
  '## 关闭前后 separator 数 / pane 数对比（klinecharts DOM）',
  ...Object.keys(a2.snapshot.charts).map((id) => {
    const b = a2.snapshot.charts[id], a = a3.snapshot.charts[id] || {};
    return `  ${id}: 前 panes=${JSON.stringify(b.panes)} sep=${b.sepCount}/${JSON.stringify(b.seps)}  ⇒  后 panes=${JSON.stringify(a.panes)} sep=${a.sepCount}/${JSON.stringify(a.seps)}`;
  }),
  '',
  '## 关闭后 [data-mp-pane] inline 高度（应与基线一致）',
  ...a3.snapshot.mpPanes.map((p) => `  ${p.period} role=${p.role} attr=${p.attrHeight} inline=${p.inlineHeight} rect=${p.rectHeight}`),
  '',
  '## chart 实例身份（mark 打点证明未重建）',
  `  打点（点击前）：${JSON.stringify(markBefore)}`,
  `  点击后实例：${JSON.stringify(a3.instances.map((i) => ({ hostId: i.hostId, acceptMark: i.acceptMark, indicators: i.indicators.map((x) => x.name) })))}`,
  '',
  '## 截图',
  '  A3_vol_off_full.png（整页）',
  '  A3_vol_off_base_pane.png（基准 pane）',
  ...satPeriods.map((p) => `  A3_vol_off_satellite_${p}.png（卫星 ${p}）`),
].join('\n') + '\n');
log(`[A3] ${a3Pass ? 'PASS' : 'FAIL'} aria-pressed=${a3VolBtn?.ariaPressed}；含 VOL 图例的 pane（关闭后）=${Object.keys(a3VolHits).join(' | ') || '(空)'}`);

// ── A4 再打开 + 多周期布局逐值对比 ────────────────────────────────────────────
await clearLegend();
await page.getByRole('button', { name: 'VOL', exact: true }).click();
await page.waitForTimeout(1500);
const a4 = await capture('A4', { full: 'A4_vol_on_again_full.png', base: 'A4_vol_on_again_base_pane.png' });
for (const p of satPeriods) {
  await page.locator(`[data-mp-satellite="${p}"]`).screenshot({ path: SHOT(`A4_vol_on_again_satellite_${p}.png`) }).catch(() => {});
}
const a4VolHits = volLegendPanes(a4.legends);
const mpInline = (s) => s.snapshot.mpPanes.map((p) => `${p.period}=${p.inlineHeight}`).join(',');
const mpAttr = (s) => s.snapshot.mpPanes.map((p) => `${p.period}=${p.attrHeight}`).join(',');
const mpOrder = (s) => s.snapshot.mpPanes.map((p) => `${p.period}@${p.childIndex}`).join(',');
const mpSepKeys = (s) => s.snapshot.mpSeps.map((x) => x.key).join(',');
const layoutStable =
  mpInline(a2) === mpInline(a4) && mpAttr(a2) === mpAttr(a4) && mpOrder(a2) === mpOrder(a4) &&
  mpSepKeys(a2) === mpSepKeys(a4) && satPeriods.join(',') === a4.snapshot.sats.map((s) => s.period).join(',');
const a4VolRestored = Object.keys(a4VolHits).length >= 1;
// 像素高度变化（基准 pane 内：candle pane vs VOL pane）
const paneHeightsOf = (s, id) => (s.snapshot.charts[id] ? s.snapshot.charts[id].panes.slice() : null);
const baseChartKey = a2.snapshot.chartIds[0];
const heightsDetail = {
  chartId: baseChartKey,
  withVolOn: paneHeightsOf(a2, baseChartKey),
  withVolOff: paneHeightsOf(a3, baseChartKey),
  withVolOnAgain: paneHeightsOf(a4, baseChartKey),
};
const zeroHeightAnomaly = a4.snapshot.mpPanes.filter((p) => p.role === 'base' && p.rectHeight <= 0);
const satZero = a4.snapshot.sats.filter((s) => s.rectHeight <= 0);
results.items.A4 = {
  pass: layoutStable && a4VolRestored,
  layoutStable,
  volRestored: a4VolRestored,
  mpInlineBaseline: mpInline(a2), mpInlineAfter: mpInline(a4),
  mpAttrBaseline: mpAttr(a2), mpAttrAfter: mpAttr(a4),
  mpOrderBaseline: mpOrder(a2), mpOrderAfter: mpOrder(a4),
  mpSepKeysBaseline: mpSepKeys(a2), mpSepKeysAfter: mpSepKeys(a4),
  heightsDetail,
  volLegendPanes: a4VolHits,
  zeroHeightAnomaly: [...zeroHeightAnomaly, ...satZero],
};
writeTxt('A4_vol_on_again_layout.txt', [
  '# A4 再点开 VOL ⇒ 恢复；多周期栈 pane 高度逐值对比',
  `抓取时间：${a4.at}`,
  '',
  '## 多周期栈 [data-mp-pane] inline 高度 逐值对比（A2 基线 vs A4 再打开）',
  `  基线：${mpInline(a2)}`,
  `  再开：${mpInline(a4)}`,
  `  ⇒ ${mpInline(a2) === mpInline(a4) ? '逐值一致（PASS）' : '不一致（FAIL）'}`,
  '',
  '## [data-mp-pane] 声明属性 data-mp-pane-height 对比',
  `  基线：${mpAttr(a2)}`,
  `  再开：${mpAttr(a4)}`,
  `  ⇒ ${mpAttr(a2) === mpAttr(a4) ? '逐值一致（PASS）' : '不一致（FAIL）'}`,
  '',
  '## pane 顺序（childIndex）对比',
  `  基线：${mpOrder(a2)}`,
  `  再开：${mpOrder(a4)}`,
  `  ⇒ ${mpOrder(a2) === mpOrder(a4) ? '一致（PASS）' : '不一致（FAIL）'}`,
  '',
  '## 栈级分隔条 key 对比',
  `  基线：${mpSepKeys(a2)}`,
  `  再开：${mpSepKeys(a4)}`,
  `  ⇒ ${mpSepKeys(a2) === mpSepKeys(a4) ? '一致（PASS）' : '不一致（FAIL）'}`,
  '',
  '## 单图内 candle pane 与 VOL pane 的像素高度变化（引擎重分配，非缺陷）',
  `  实例 ${heightsDetail.chartId}`,
  `  VOL 开（A2 基线）      : panes = ${JSON.stringify(heightsDetail.withVolOn)}（[candle, VOL]）`,
  `  VOL 关（A3）           : panes = ${JSON.stringify(heightsDetail.withVolOff)}（[candle]；原 VOL 空间归还 candle）`,
  `  VOL 再开（A4）         : panes = ${JSON.stringify(heightsDetail.withVolOnAgain)}`,
  '',
  '## 各实例 pane 数 / separator 数（A2 / A3 / A4）',
  ...Object.keys(a2.snapshot.charts).map((id) => {
    const b = a2.snapshot.charts[id], o = a3.snapshot.charts[id] || {}, n = a4.snapshot.charts[id] || {};
    return `  ${id}: A2 paneCount=${b.paneCount} sep=${b.sepCount} | A3 paneCount=${o.paneCount} sep=${o.sepCount} | A4 paneCount=${n.paneCount} sep=${n.sepCount}`;
  }),
  '',
  '## 0 高 / 重叠 / 残留分隔条 / pane 数异常 检查（A4 态原始观测）',
  `  基准 pane 与卫星 rect<=0 的元素：${JSON.stringify([...zeroHeightAnomaly, ...satZero])}`,
  `  卫星 candle pane 内联高度（设计为 0，minimize；非异常）：${JSON.stringify(a4.snapshot.charts[a2.snapshot.chartIds[1]]?.panes)} / ${JSON.stringify(a4.snapshot.charts[a2.snapshot.chartIds[2]]?.panes)}`,
  `  栈级分隔条：${JSON.stringify(a4.snapshot.mpSeps)}`,
  `  klinecharts separator 元素：${JSON.stringify(Object.fromEntries(Object.entries(a4.snapshot.charts).map(([id, c]) => [id, { sepCount: c.sepCount, seps: c.seps }])))}`,
  '',
  '## 再开后的 VOL 图例（应恢复）',
  JSON.stringify(a4VolHits),
  '',
  '## 截图',
  '  A4_vol_on_again_full.png',
  '  A4_vol_on_again_base_pane.png',
  ...satPeriods.map((p) => `  A4_vol_on_again_satellite_${p}.png`),
].join('\n') + '\n');
log(`[A4] ${results.items.A4.pass ? 'PASS' : 'FAIL'} layoutStable=${layoutStable} volRestored=${a4VolRestored}；candle/VOL pane 高度：${JSON.stringify(heightsDetail.withVolOn)} → ${JSON.stringify(heightsDetail.withVolOff)} → ${JSON.stringify(heightsDetail.withVolOnAgain)}`);

// ── A7 纯前端回归（内存态切换） ───────────────────────────────────────────────
// A7a：先把 VOL 关掉，再切「分时」→ 切回「K线」，验证会话态保持 + 无报错
await page.getByRole('button', { name: 'VOL', exact: true }).click();
await page.waitForTimeout(800);
const volStateBeforeTab = (await snap()).volButton?.ariaPressed;
await page.getByRole('button', { name: '分时', exact: true }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: SHOT('A7a_timeshare.png') });
const timeshareChartCount = await page.evaluate(() => document.querySelectorAll('[k-line-chart-id]').length);
await page.getByRole('button', { name: 'K线', exact: true }).click();
await page.waitForTimeout(3500);
await forceRedraw();
const afterTab = await snap();
await page.screenshot({ path: SHOT('A7a_back_to_kline.png') });
const a7aPass = volStateBeforeTab === 'false' && afterTab.volButton?.ariaPressed === 'false';
log(`[A7a] VOL 关态切换前=${volStateBeforeTab} 切回后=${afterTab.volButton?.ariaPressed}（分时态 kline 实例数=${timeshareChartCount}）`);

// A7b：切 2×2 宫格 → 切回 单图
await page.getByRole('button', { name: '2×2', exact: true }).click();
await page.waitForTimeout(3500);
await page.screenshot({ path: SHOT('A7b_grid2x2.png') });
const gridInfo = await page.evaluate(() => ({
  gridCharts: document.querySelectorAll('[k-line-chart-id]').length,
  mpStack: !!document.querySelector('[data-mp-stack]'),
  multiPeriodButton: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '多周期'),
  volButton: Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'VOL'),
}));
await page.getByRole('button', { name: '单图', exact: true }).click();
await page.waitForTimeout(3500);
const afterGrid = await capture('A7b', { full: 'A7b_back_to_single.png' });
const a7bPass =
  volStateBeforeTab === 'false' &&
  afterGrid.snapshot.volButton?.ariaPressed === 'false' &&
  afterGrid.snapshot.sats.map((s) => s.period).join(',') === satPeriods.join(',');
results.items.A7 = {
  pass: a7aPass && a7bPass,
  a7aPass, a7bPass,
  volStateBeforeTab,
  volAfterTab: afterTab.volButton?.ariaPressed,
  volAfterGrid: afterGrid.snapshot.volButton?.ariaPressed,
  gridInfo,
  afterGridSats: afterGrid.snapshot.sats.map((s) => s.period),
  afterGridMpInline: mpInline(afterGrid),
};
writeTxt('A7_frontend_regression.txt', [
  '# A7 纯前端回归（无配置写）：分时↔K线、宫格↔单图',
  `抓取时间：${new Date().toISOString()}`,
  '',
  '## A7a 分时 tab 往返',
  `  切走前 VOL aria-pressed = ${volStateBeforeTab}（人工置为关态，用于检查会话态是否保持）`,
  `  分时态 kline 实例数 = ${timeshareChartCount}`,
  `  切回 K线后 VOL aria-pressed = ${afterTab.volButton?.ariaPressed}`,
  `  ⇒ ${a7aPass ? 'PASS（状态保持）' : 'FAIL'}`,
  '  截图：A7a_timeshare.png / A7a_back_to_kline.png',
  '',
  '## A7b 宫格 2×2 往返',
  `  宫格态：kline 实例数=${gridInfo.gridCharts}  [data-mp-stack] 存在=${gridInfo.mpStack}  「多周期」按钮存在=${gridInfo.multiPeriodButton}  VOL 按钮存在=${gridInfo.volButton}`,
  `  切回单图：卫星=${JSON.stringify(afterGrid.snapshot.sats.map((s) => s.period))}  VOL aria-pressed=${afterGrid.snapshot.volButton?.ariaPressed}`,
  `  切回单图 [data-mp-pane] inline：${mpInline(afterGrid)}`,
  `  ⇒ ${a7bPass ? 'PASS' : 'FAIL'}`,
  '  截图：A7b_grid2x2.png / A7b_back_to_single.png',
].join('\n') + '\n');
log(`[A7] ${results.items.A7.pass ? 'PASS' : 'FAIL'} a7a=${a7aPass} a7b=${a7bPass}`);

// ── A6 收尾：配置二次读取 + console/network ──────────────────────────────────
const cfgEnd = await readConfigs('end');
const sameConfig = JSON.stringify(cfgStart.canonical) === JSON.stringify(cfgEnd.canonical);
const dbRow = dbUpdatedAt();
const errMsgs = consoleMsgs.filter((m) => m.type === 'error' || m.type === 'warning');
results.items.A6 = {
  pass: sameConfig,
  sameConfig,
  startCanonical: cfgStart.canonical,
  endCanonical: cfgEnd.canonical,
  dbRow,
  pageErrors,
  consoleErrorsWarnings: errMsgs,
  failedRequests,
  apiResponses,
  writtenRequestsByTest: '本脚本只发 GET（node fetch + 页面自身初始化）；未发任何 PUT/POST/PATCH/DELETE',
};
writeTxt('A6_zero_write.txt', [
  '# A6 零配置写入证据',
  '',
  `## 验收窗口：${results.startedAt} → ${new Date().toISOString()}`,
  '',
  '## 开始读取（A6_config_start.txt）',
  ...CONFIG_KEYS.map((k) => `  GET /api/config/${k} ⇒ ${cfgStart.detail[k].raw}`),
  '',
  '## 结束读取（A6_config_end.txt）',
  ...CONFIG_KEYS.map((k) => `  GET /api/config/${k} ⇒ ${cfgEnd.detail[k].raw}`),
  '',
  `## 逐字段对比 ⇒ ${sameConfig ? '两次完全相同（PASS：验收过程零写入）' : '存在差异（见下）'}`,
  '',
  '## app_config 表 updated_at（只读 SELECT，交叉核对部署窗口）',
  '```',
  'key|updated_at|value',
  dbRow,
  '```',
  `  部署窗口（eestock-app 进程启动）= Tue Sep 15 22:27:42 2026 +0800；dist 产物 mtime = 2026-09-15 22:27 +0800`,
  `  本脚本启动时间 = ${results.startedAt}（UTC，= +0800 减 8h）`,
  '',
  '## 失败请求 / 页面异常',
  `  pageerror：${JSON.stringify(pageErrors)}`,
  `  requestfailed：${JSON.stringify(failedRequests)}`,
  '',
  '## console error/warning',
  ...(errMsgs.length ? errMsgs.map((m) => `  [${m.type}] ${m.text} (${m.loc?.url || ''}:${m.loc?.lineNumber || ''})`) : ['  (无)']),
  '',
  '## 本次页面会话内所有 /api/ 请求（方法+状态）',
  ...Array.from(new Set(apiResponses)).map((r) => `  ${r}`),
].join('\n') + '\n');

const httpMethods = Array.from(new Set(apiResponses.map((r) => r.split(' ')[0])));
const nonGet = httpMethods.filter((m) => m !== 'GET');
log(`[A6] 两次配置读取 ${sameConfig ? 'PASS（逐字段相同）' : 'FAIL（有差异）'}；页面 /api/ 方法集合=${JSON.stringify(httpMethods)}；pageerror=${pageErrors.length} requestfailed=${failedRequests.length} console err/warn=${errMsgs.length}`);

await browser.close();

results.summary = {
  A1: results.items.A1.pass,
  A2: `基线已取证（基准=${baseChartId}，卫星=[${satPeriods.join(',')}]，含 VOL 图例 pane=${Object.keys(a2VolHits).length}）`,
  A3: results.items.A3.pass,
  A4: results.items.A4.pass,
  A6: results.items.A6.pass,
  A7: results.items.A7.pass,
  nonGetApiMethods: nonGet,
  servedBundle: bundleMatch ? bundleMatch[0] : null,
};
fs.writeFileSync(path.join(OUT, '286_results.json'), JSON.stringify(results, null, 2));
writeTxt('286_run.log', runLog.join('\n') + '\n');
console.log('\n===== SUMMARY =====');
console.log(JSON.stringify(results.summary, null, 2));
