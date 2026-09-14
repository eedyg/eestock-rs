import { chromium } from 'playwright';
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1400,height:900}});
await p.route('**/api/**',r=>r.request().method()!=='GET'?r.abort():r.continue());
await p.goto('http://127.0.0.1:8081/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(6000);
const d=await p.evaluate(()=>({
  klineChartEls:document.querySelectorAll('[data-testid="kline-chart"]').length,
  dataViewportFit:document.querySelectorAll('[data-viewport-fit]').length,
  gridCells:document.querySelectorAll('[data-grid-cell]').length,
  gridRegion:!!document.querySelector('[data-region="grid-view"]'),
  mainChartRegion:!!document.querySelector('[data-region="main-chart"]'),
  canvasCount:document.querySelectorAll('canvas').length,
  testids:[...new Set([...document.querySelectorAll('[data-testid]')].map(e=>e.getAttribute('data-testid')))],
  regions:[...new Set([...document.querySelectorAll('[data-region]')].map(e=>e.getAttribute('data-region')))],
}));
console.log(JSON.stringify(d,null,1));await b.close();
