// S5b: DCAP sub-pane real-render detail — 0 line (dashed, horizontal) + broken line (leftmost nulls).
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.js';
const { chromium } = pw;
import fs from 'node:fs';
const H = '/tmp/p01c/harness';
const bars = [];
{ let p = 100; for (let i=0;i<160;i++){ const o=p; p=p+Math.sin(i/7)*1.6+Math.cos(i/3)*0.8; bars.push({timestamp:Date.UTC(2026,0,1)+i*86400000,open:o,high:Math.max(o,p)+0.9,low:Math.min(o,p)-0.9,close:p,volume:1000+(i%13)*50}); } }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.setContent('<!doctype html><html><body style="margin:0;background:#101418"><div id="root"></div></body></html>');
await page.addScriptTag({ path: `${H}/klinecharts.js` });
await page.addScriptTag({ path: `${H}/overlayEntry.js` });
await page.addScriptTag({ path: `${H}/dcap.js` });
await page.evaluate(`window.__bars=${JSON.stringify(bars)}`);
const out = await page.evaluate(`(async () => {
  const el=document.createElement('div'); el.style.cssText='width:900px;height:420px'; document.getElementById('root').appendChild(el);
  const chart=klinecharts.init(el);
  chart.setDataLoader({ getBars:(p)=>p.callback(window.__bars,false) });
  chart.setSymbol({ticker:'TEST',pricePrecision:3,volumePrecision:0});
  chart.setPeriod({span:1,type:'day'});
  await new Promise(r=>setTimeout(r,350));
  klinecharts.registerIndicator(DcapMod.DCAP_INDICATOR_TEMPLATE);
  const MAGENTA='#FF00FF';
  const id=chart.createIndicator({ name:'DCAP', paneId:'dcap_pane',
    calcParams: DcapMod.dcapCalcParams(DcapMod.DEFAULT_DCAP_PARAMS),
    styles:{ lines:[{color:'#FF9600'},{color:'#935EBD'},{color:'#1677FF'},{color:MAGENTA, style:'dashed', dashedValue:[4,4], size:1}] } }, true);
  await new Promise(r=>setTimeout(r,400));
  const ind=chart.getIndicators({name:'DCAP'})[0];
  // find the DCAP pane canvas (full-width, short height)
  const list=[...el.querySelectorAll('canvas')];
  const c=list.find(x=>x.width>400 && x.height<200);
  const ctx=c.getContext('2d'); const W=c.width,Hh=c.height; const d=ctx.getImageData(0,0,W,Hh).data;
  const isMag=(i)=>{const R=d[i],G=d[i+1],B=d[i+2];return R>180&&G<90&&B>180;};
  const rows=[]; let magTotal=0;
  for(let y=0;y<Hh;y++){ let n=0; for(let x=0;x<W;x++){ const i=(y*W+x)*4; if(isMag(i)){n++;magTotal++;} } if(n>0) rows.push({y,n}); }
  // broken line: leftmost column with any data-line colour (orange)
  let firstDataX=null;
  const isOrange=(i)=>{const R=d[i],G=d[i+1],B=d[i+2];return Math.abs(R-0xFF)<=30&&Math.abs(G-0x96)<=30&&B<80;};
  for(let x=0;x<W;x++){ let n=0; for(let y=0;y<Hh;y++){ const i=(y*W+x)*4; if(isOrange(i)) n++; } if(n>0){ firstDataX=x; break; } }
  return { dcapId:id, precision: ind.precision, paneId: ind.paneId, figures: ind.figures.map(f=>f.key),
    canvas:{w:W,h:Hh}, magentaTotal:magTotal, magentaRows:rows.slice(0,5), magentaRowCount:rows.length,
    maxRowMagenta: rows.length?Math.max(...rows.map(r=>r.n)):0, firstDataLineColumnX:firstDataX };
})()`);
await page.screenshot({ path: '/tmp/p01c/evidence/s5b_dcap_zero_broken.png' });
fs.writeFileSync('/tmp/p01c/evidence/s5b_results.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
