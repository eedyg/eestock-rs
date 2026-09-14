import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT='/tmp/livecheck-165/out'; fs.mkdirSync(OUT,{recursive:true});
const DUR=150000;
const reqs=[],nonGet=[],blocked=[];
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1400,height:900}});
const p=await ctx.newPage();
p.on('request',r=>{const e={method:r.method(),url:r.url(),t:Date.now()};reqs.push(e);if(r.method()!=='GET')nonGet.push(e);});
await p.route('**/api/**',async r=>{if(r.request().method()!=='GET'){blocked.push(r.request().method()+' '+r.request().url());return r.abort();}return r.continue();});
await p.goto('http://127.0.0.1:8081/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>document.querySelector('[data-viewport-fit]')!==null,null,{timeout:25000}).catch(()=>{});
const t0=Date.now();
const charts=await p.evaluate(()=>({
  chartEls:document.querySelectorAll('[data-testid="kline-chart"]').length,
  viewportFitEls:[...document.querySelectorAll('[data-viewport-fit]')].map(e=>e.getAttribute('data-viewport-fit')),
  canvasCount:document.querySelectorAll('canvas').length,
}));
const mark=reqs.length;
await p.waitForTimeout(DUR);
const win=reqs.slice(mark);
const q=u=>{try{const x=new URL(u);return Object.fromEntries(x.searchParams);}catch{return{};}};
const fb=win.filter(r=>r.method==='GET'&&r.url.includes('/api/kline')&&!r.url.includes('before=')&&q(r.url).limit==='5').map(r=>({t:r.t,rel:r.t-t0,code:q(r.url).code,period:q(r.url).period}));
const out={shanghai:new Date(t0+8*3600*1000).toISOString().replace('T',' ').slice(0,19)+' +08',durationSec:DUR/1000,visibilityState:await p.evaluate(()=>document.visibilityState),charts,nonGetTotal:nonGet.length,blockedWrites:blocked,fallbackCount:fb.length,fallback:fb.map(x=>({rel:x.rel,iso:new Date(x.t).toISOString(),code:x.code,period:x.period})),fallbackRawTs:fb.map(x=>x.t),methodsSeen:[...new Set(reqs.map(r=>r.method))]};
fs.writeFileSync(OUT+'/observe2.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,1));
await b.close();
