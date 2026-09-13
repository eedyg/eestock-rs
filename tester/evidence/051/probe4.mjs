/**
 * 诊断车道（tester 阶段 1）probe4 —— 备选修法取证：改 warmup 时能否「只重载数据、不重建图」？
 * 在真实渲染页面上：拖高 VOL → 记录高度/视口/barSpace → 调 chart.resetData()（内部 = DataLoader init 重载）
 * → 再记录。用于回答「路径 B（整图 remount）是否必须」以及「resetData 是否保布局、是否扰视口」。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/x.js');
const { chromium } = require('@playwright/test');
const BASE = process.env.BASE ?? 'http://127.0.0.1:18085';
const out = { base: BASE, checks: [] };
const check = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d });

const PROBE = () => {
  const cs = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  const c = cs[cs.length - 1];
  const panes = c.getPaneOptions().map((p) => { let dom = null; try { const r = c.getDom(p.id).getBoundingClientRect(); dom = +r.height.toFixed(1); } catch {} return { id: p.id, optH: p.height, domH: dom, ind: c.getIndicators({ paneId: p.id }).map((i) => i.name).join('+') }; });
  let vr = null; try { vr = c.getVisibleRange(); } catch { vr = null; }
  let bs = null; try { bs = c.getBarSpace(); } catch { bs = null; }
  let off = null; try { off = c.getOffsetRightDistance(); } catch { off = null; }
  return { inits: window.__KC_INITS__, dataLen: (c.getDataList?.() ?? []).length, panes, vr, bs, off, ids: c.getPaneOptions().map((p) => p.id) };
};
const byInd = (s) => Object.fromEntries(s.panes.filter((p) => p.ind !== '').map((p) => [p.ind, { domH: p.domH, optH: p.optH }]));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let klineGets = 0;
await page.route('**/*', async (route, req) => {
  if (req.method() === 'GET') { if (req.url().includes('/api/kline')) klineGets++; await route.continue(); return; }
  await route.abort();
});
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="kline-chart"]', { timeout: 40000 });
await page.waitForTimeout(4000);
await page.getByRole('button', { name: 'DCAP', exact: true }).click();
await page.waitForTimeout(2000);
const handle = await page.evaluate(() => {
  const kcRoot = document.querySelector('[data-testid="kline-chart"]').firstElementChild;
  const seps = Array.from(kcRoot.children).filter((el) => el.firstElementChild && el.firstElementChild.style.cursor === 'ns-resize');
  const r = seps[0].firstElementChild.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x, handle.y - 150, { steps: 12 }); await page.mouse.up();
await page.waitForTimeout(700);
const s1 = await page.evaluate(PROBE);
out.before = { byInd: byInd(s1), inits: s1.inits, dataLen: s1.dataLen, vr: s1.vr, bs: s1.bs, off: s1.off };
const klineBefore = klineGets;
await page.evaluate(() => {
  const cs = (window.__CHARTS__ ?? []).filter((c) => { try { return (c.getPaneOptions() ?? []).length > 0; } catch { return false; } });
  cs[cs.length - 1].resetData();
  return true;
});
await page.waitForTimeout(2500);
const s2 = await page.evaluate(PROBE);
out.after = { byInd: byInd(s2), inits: s2.inits, dataLen: s2.dataLen, vr: s2.vr, bs: s2.bs, off: s2.off, klineGetsDelta: klineGets - klineBefore };
out.pageErrors = [];
check('R1 resetData 未重建 chart（init 次数不变、pane id 集合不变）', s1.inits === s2.inits && JSON.stringify(s1.ids) === JSON.stringify(s2.ids), { inits: [s1.inits, s2.inits], ids: [s1.ids, s2.ids] });
check('R2 resetData 重载了数据（/api/kline 重新取数）', klineGets - klineBefore >= 1, klineGets - klineBefore);
check('R3 resetData 后 pane 渲染高度不变（布局保留）', JSON.stringify(byInd(s1)) === JSON.stringify(byInd(s2)), { before: byInd(s1), after: byInd(s2) });
check('R4 视口/barSpace 记录（供 ADR-020 副作用评估，不判定）', true, { vrBefore: s1.vr, vrAfter: s2.vr, bsBefore: s1.bs, bsAfter: s2.bs, offBefore: s1.off, offAfter: s2.off });
fs.writeFileSync('/tmp/diag51/probe4.json', JSON.stringify(out, null, 1));
for (const c of out.checks) console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}`, JSON.stringify(c.detail).slice(0, 300));
await browser.close();
