import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json');
const { chromium } = require('playwright');
const HERE='/tmp/mp_p03/tester/evidence/260_p03_barspace_anchor';
const KC='/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/klinecharts/dist/umd/klinecharts.min.js';
const PORT=19700+(process.pid%200);
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://x');
 if(u.pathname.startsWith('/api/')){ if(req.method!=='GET'){res.writeHead(405);res.end('ro');return;}
  const pr=http.request('http://127.0.0.1:8081'+req.url,{method:'GET'},b=>{res.writeHead(b.statusCode,{'content-type':'application/json'});b.pipe(res);});pr.on('error',e=>{res.writeHead(502);res.end(String(e));});pr.end();return;}
 const f=u.pathname==='/klinecharts.js'?KC:path.join(HERE,u.pathname==='/'?'mp03.html':u.pathname.slice(1));
 try{res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':'text/html'});res.end(fs.readFileSync(f));}catch{res.writeHead(404);res.end('nf');}});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await chromium.launch(); const page=await browser.newPage({viewport:{width:1120,height:1150}});
const msgs=[]; page.on('pageerror',e=>msgs.push('pageerror '+e.message)); page.on('request',r=>{if(r.method()!=='GET')msgs.push('NON-GET '+r.url());});
await page.goto(`http://127.0.0.1:${PORT}/mp03.html`); await page.waitForFunction(()=>window.__ready===true);
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const res = { steps: [] };
  await window.__dInit('1d','1w',400);
  res.D = (await window.__dRatio(8)).D;
  const snap = () => { const r = window.__dRead(); return { baseBs: r.base.barSpace, satBs: r.sat.barSpace, baseOffset: r.base.offsetRight, satOffset: r.sat.offsetRight, baseSpanMin: r.base.spanMin, satSpanMin: r.sat.spanMin, satIdxSpan: r.sat.idxSpan }; };
  const D = res.D;
  // 1) baseline sync
  const s1 = await window.__dRound(8, D, true); res.steps.push({ name: 'baseline sync (baseBs 8, D-mul, mirror)', satBs: s1.satBsActual, errInSatBars: s1.errInSatBars, snap: snap() });
  // 2) user zooms the SATELLITE itself (barSpace 350), then re-sync must restore
  const { sat, base } = window.__dCharts();
  sat.setBarSpace(350); await sleep(60);
  const z = snap();
  const s2 = await window.__dRound(8, D, true);
  res.steps.push({ name: 'satellite self-zoom to 350 then re-sync', satBsAfterSelfZoom: z.satBs, satBsAfterResync: s2.satBsActual, errInSatBars: s2.errInSatBars, snap: snap() });
  // 3) user zooms the BASE (barSpace 20) -> satellite must follow
  const s3 = await window.__dRound(20, D, true);
  res.steps.push({ name: 'base zoom to 20 -> satellite follow', satBs: s3.satBsActual, expect: 20*D, errInSatBars: s3.errInSatBars, snap: snap() });
  // 4) user scrolls the SATELLITE away, then re-sync
  sat.scrollToTimestamp(sat.getDataList()[200].timestamp); await sleep(60);
  const sc = snap();
  const s4 = await window.__dRound(20, D, true);
  res.steps.push({ name: 'satellite scrolled away then re-sync', satIdxSpanAfterScroll: sc.satIdxSpan, errInSatBars: s4.errInSatBars, snap: snap() });
  // 5) base scroll (interaction) then re-apply sync x5 -> barSpace idempotent, no drift
  const trail = [];
  for (let i = 0; i < 5; i++) { base.scrollToTimestamp(window.__dCharts().bL[600 + i * 10].timestamp); await sleep(30); const r = await window.__dRound(20, D, true); trail.push({ i, satBs: r.satBsActual, errInSatBars: r.errInSatBars, satIdxSpan: r.sat.idxSpan }); }
  res.steps.push({ name: '5x scroll(base)+resync', trail });
  // 6) limit isolation with real data: base default 50 must keep clamping while satellite max=400 allows
  const b2 = base.setBarSpace(60); await sleep(40); const afterBase60 = base.getBarSpace().bar;
  sat.setBarSpace(350); await sleep(40); const afterSat350 = sat.getBarSpace().bar;
  const afterBase350 = (base.setBarSpace(350), await sleep(40), base.getBarSpace().bar);
  res.steps.push({ name: 'limit isolation (real data)', base_req60: afterBase60, sat_req350: afterSat350, base_req350: afterBase350 });
  return res;
});
await page.screenshot({ path: path.join(HERE,'shot_zoom_stability.png') });
fs.writeFileSync(path.join(HERE,'p03_zoom_result.json'), JSON.stringify({ out, console: msgs }, null, 2));
console.log(JSON.stringify(out, null, 1)); console.log('ERR', msgs.filter(m=>m.includes('pageerror')));
await browser.close(); server.close();
