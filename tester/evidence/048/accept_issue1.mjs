/**
 * 验收（tester 阶段 3）问题① 独立断言 —— 真实 app（临时实例 18081）+ 真实 klinecharts 10.0.3 渲染。
 * 自建断言（不复用修复车道脚本结论）：锚点无边框 / 全宽水平线只来自 klinecharts 分隔元素 /
 * 分隔线数 = 内容 pane 数 − 1 / pane 列表(id,height,indicator 数) / 拖高 VOL 后线随 pane 移动 /
 * DCAP 关闭态仍有 candle↔VOL 边界。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18081';
const OUT = process.env.OUT ?? '/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/048';
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

const PROBE = () => {
  const charts = window.__CHARTS__ ?? [];
  const live = charts.filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = live[live.length - 1];
  const main = document.querySelector('[data-region="main-chart"]');
  const anchor = document.querySelector('[data-region="sub-chart"]');
  const mr = main.getBoundingClientRect();
  const rel = (el) => { const r = el.getBoundingClientRect(); return { top: +(r.top - mr.top).toFixed(2), h: +r.height.toFixed(2), w: +r.width.toFixed(2) }; };
  const isSep = (el) => { const w = el.firstElementChild; return !!w && w.style && w.style.cursor === 'ns-resize'; };
  const kc = document.querySelector('[k-line-chart-id]')?.firstElementChild;

  const panes = c.getPaneOptions();
  const inds = c.getIndicators().map((i) => ({ name: i.name, paneId: i.paneId, yAxisId: i.yAxisId, precision: i.precision, figKeys: (i.figures ?? []).map((f) => f.key) }));
  const paneInfo = panes.map((p) => {
    let dom = null;
    try { const d = c.getDom(p.id); const r = d.getBoundingClientRect(); dom = { topInMain: +(r.top - mr.top).toFixed(2), h: +r.height.toFixed(2) }; } catch { dom = null; }
    return { id: p.id, height: p.height, indicatorCount: inds.filter((i) => i.paneId === p.id).length, indicators: inds.filter((i) => i.paneId === p.id).map((i) => i.name), dom };
  });

  const separators = [];
  for (const el of Array.from(kc.children)) { if (isSep(el)) separators.push({ ...rel(el), bg: getComputedStyle(el).backgroundColor }); }

  const stray = [];
  for (const el of Array.from(main.querySelectorAll('*'))) {
    if (isSep(el)) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const bt = parseFloat(cs.borderTopWidth || '0'); const bb = parseFloat(cs.borderBottomWidth || '0');
    const opaque = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    const hline = (bt > 0 && cs.borderTopStyle !== 'none' && r.width >= 0.9 * mr.width) || (bb > 0 && cs.borderBottomStyle !== 'none' && r.width >= 0.9 * mr.width);
    const thinOpaque = r.height <= 3 && opaque;
    if (!hline && !thinOpaque) continue;
    const region = el.dataset.region;
    stray.push({ tag: el.tagName + (region ? `[data-region=${region}]` : ''), kind: bt > 0 ? `border-top ${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` : bb > 0 ? `border-bottom ${cs.borderBottomWidth}` : `bg ${cs.backgroundColor}`, ...rel(el) });
  }
  const acs = getComputedStyle(anchor);
  const ar = anchor.getBoundingClientRect();
  return {
    main: { h: +mr.height.toFixed(2), w: +mr.width.toFixed(2) },
    anchor: { classes: anchor.className, topInMain: +(ar.top - mr.top).toFixed(2), h: +ar.height.toFixed(2), w: +ar.width.toFixed(2), borderTopWidth: acs.borderTopWidth, borderTopStyle: acs.borderTopStyle, borderTopColor: acs.borderTopColor, background: acs.backgroundColor },
    paneInfo, separators, stray, contentPaneCount: panes.filter((p) => p.id !== 'x_axis_pane').length, totalPaneCount: panes.length,
  };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const nonGet = [];
await page.route('**/*', async (route, req) => {
  if (req.method() !== 'GET') { nonGet.push(`${req.method()} ${req.url()}`); await route.abort(); return; }
  await route.continue();
});
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 30000 });
await page.waitForTimeout(2500);

// ---------- 默认态（DCAP 关）----------
const s0 = await page.evaluate(PROBE);
check('①-1 sub-chart 锚点 computed borderTopWidth == 0px', s0.anchor.borderTopWidth === '0px', s0.anchor);
check('①-2 锚点确实存在（region 契约）且宽度 = 主图区宽', s0.anchor.w > 0.9 * s0.main.w, s0.anchor);
check('①-3 默认态分隔线数 == 内容 pane 数 − 1', s0.separators.length === s0.contentPaneCount - 1, { seps: s0.separators.length, content: s0.contentPaneCount, total: s0.totalPaneCount });
check('①-4 主图区内无「非 klinecharts」全宽水平线（默认态）', s0.stray.length === 0, s0.stray);
check('①-5 默认态 pane：candle_pane(MA) + VOL + x_axis', s0.paneInfo.length === 3 && s0.paneInfo[0].id === 'candle_pane' && s0.paneInfo[1].indicators[0] === 'VOL' && s0.paneInfo[2].id === 'x_axis_pane', s0.paneInfo);
// DCAP 关闭态 candle↔VOL 可见边界：唯一分隔线恰位于 candle pane 底 与 VOL pane 顶
{
  const candle = s0.paneInfo[0].dom; const vol = s0.paneInfo[1].dom; const sep = s0.separators[0];
  const ok = !!sep && Math.abs(sep.top - (candle.topInMain + candle.h)) <= 2 && Math.abs((sep.top + sep.h) - vol.topInMain) <= 2;
  check('①-6 DCAP 关态：candle↔VOL 存在可见边界（分隔线落在两 pane 交界）', ok, { candle, vol, sep });
}
await page.screenshot({ path: `${OUT}/issue1-default.png` });

// ---------- 拖高 VOL（第一条分隔线向上 120px）----------
const before = s0.separators[0];
const handle = await page.evaluate(() => {
  const kc = document.querySelector('[k-line-chart-id]')?.firstElementChild;
  const sep = Array.from(kc.children).find((el) => el.firstElementChild && el.firstElementChild.style.cursor === 'ns-resize');
  const w = sep?.firstElementChild; const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(handle.x, handle.y);
await page.mouse.down();
await page.mouse.move(handle.x, handle.y - 120, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);
const s1 = await page.evaluate(PROBE);
check('①-7 拖高 VOL 后分隔线数仍 == 内容 pane 数 − 1', s1.separators.length === s1.contentPaneCount - 1, { seps: s1.separators.length, content: s1.contentPaneCount });
check('①-8 分隔线随 pane 边界上移（top 显著变小）', s1.separators[0].top < before.top - 50, { before: before.top, after: s1.separators.map((x) => x.top) });
check('①-9 拖高后无「不随 pane 移动」的横线（stray 仍为空）', s1.stray.length === 0, s1.stray);
check('①-10 拖高后锚点仍未画线', s1.anchor.borderTopWidth === '0px', s1.anchor);
{
  const candle = s1.paneInfo[0].dom; const vol = s1.paneInfo[1].dom; const sep = s1.separators[0];
  const ok = !!sep && Math.abs(sep.top - (candle.topInMain + candle.h)) <= 2 && Math.abs((sep.top + sep.h) - vol.topInMain) <= 2;
  check('①-11 拖高后候选边界仍与实测 pane 交界一致（line 属于边界，不是僵线）', ok, { candle, vol, sep });
}
await page.screenshot({ path: `${OUT}/issue1-after-drag.png` });

// ---------- DCAP 开 / 关 ----------
const dcap = page.getByRole('button', { name: 'DCAP', exact: true });
await dcap.click();
await page.waitForTimeout(1600);
const s2 = await page.evaluate(PROBE);
check('①-12 DCAP 开后内容 pane 3 ⇒ 分隔线 2', s2.contentPaneCount === 3 && s2.separators.length === 2, { seps: s2.separators, panes: s2.paneInfo });
check('①-13 DCAP 开后无残留横线', s2.stray.length === 0, s2.stray);
await page.screenshot({ path: `${OUT}/issue1-dcap-on.png` });
await dcap.click();
await page.waitForTimeout(1600);
const s3 = await page.evaluate(PROBE);
check('①-14 DCAP 关后回到内容 pane 2 ⇒ 分隔线 1，无空 pane', s3.contentPaneCount === 2 && s3.separators.length === 1 && s3.paneInfo.every((p) => p.indicatorCount > 0 || p.id === 'x_axis_pane'), { seps: s3.separators, panes: s3.paneInfo });
check('①-15 DCAP 关后仍无残留横线', s3.stray.length === 0, s3.stray);
check('①-16 全程只发 GET（未改线上状态）', nonGet.length === 0, nonGet);

// ---------- 反向证据：运行期注入同位置 border-top（等价「恢复 border-t」，仅临时实例，不动仓库）----------
await page.addStyleTag({ content: '[data-region="sub-chart"]{border-top-width:1px !important;border-top-style:solid !important;border-top-color:#e5e7eb !important}' });
await page.waitForTimeout(300);
const sRev = await page.evaluate(PROBE);
const negAnchorRed = sRev.anchor.borderTopWidth !== '0px';
const negStrayRed = sRev.stray.length > 0;
check('①-REV(负向) 注入同位置 border-top 后锚点 borderTopWidth 断言变红', negAnchorRed, sRev.anchor);
check('①-REV(负向) 注入后 stray 横线断言变红', negStrayRed, sRev.stray);
await page.screenshot({ path: `${OUT}/issue1-reverse-injected.png` });

fs.writeFileSync(`${OUT}/issue1-results.json`, JSON.stringify({ base: BASE, results, nonGet, states: { s0, s1, s2, s3, sRev } }, null, 2));
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\nissue①: ${results.length - failed.length}/${results.length} passed; failed=${failed.length}`);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
