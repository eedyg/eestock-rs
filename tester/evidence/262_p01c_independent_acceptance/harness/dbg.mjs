import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.js';
const { chromium } = pw;
const H='/tmp/p01c/harness';
const bars=[]; { let p=100; for(let i=0;i<160;i++){const o=p;p=p+Math.sin(i/7)*1.6+Math.cos(i/3)*0.8;bars.push({timestamp:Date.UTC(2026,0,1)+i*86400000,open:o,high:Math.max(o,p)+0.9,low:Math.min(o,p)-0.9,close:p,volume:1000+(i%13)*50});}}
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1200,height:900}});
await p.setContent('<html><body style="margin:0;background:#101418"><div id="root"></div></body></html>');
for (const f of ['klinecharts.js','overlayEntry.js','dcap.js']) await p.addScriptTag({path:`${H}/${f}`});
await p.evaluate(`window.__bars=${JSON.stringify(bars)}`);
const out=await p.evaluate(`(async()=>{
 const el=document.createElement('div'); el.style.cssText='width:900px;height:420px'; document.getElementById('root').appendChild(el);
 const chart=klinecharts.init(el);
 chart.setDataLoader({getBars:(p)=>p.callback(window.__bars,false)});
 chart.setSymbol({ticker:'T',pricePrecision:3,volumePrecision:0});
 chart.setPeriod({span:1,type:'day'});
 await new Promise(r=>setTimeout(r,350));
 klinecharts.registerIndicator(DcapMod.DCAP_INDICATOR_TEMPLATE);
 chart.createIndicator({name:'DCAP',paneId:'dcap_pane',calcParams:DcapMod.dcapCalcParams(DcapMod.DEFAULT_DCAP_PARAMS)},true);
 await new Promise(r=>setTimeout(r,400));
 const panes=[...el.children].map(d=>({cls:d.className, id:d.id||null, h:d.style.height||null, canvases:d.querySelectorAll('canvas').length}));
 const cs=[...el.querySelectorAll('canvas')].map((c,i)=>{
   const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; const m=new Map();
   for(let k=0;k<d.length;k+=4){const key=(d[k]<<16)|(d[k+1]<<8)|d[k+2]; m.set(key,(m.get(key)||0)+1);}
   const top=[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>['#'+k.toString(16).padStart(6,'0'),v]);
   return {i,px:c.width+'x'+c.height,top};
 });
 const inds=chart.getIndicators({});
 return {panes, canvases:cs, inds: inds.map(i=>({name:i.name,paneId:i.paneId,precision:i.precision,figures:i.figures.map(f=>({key:f.key,style:f.style||null,color:f.color||null}))}))};
})()`);
console.log(JSON.stringify(out,null,1));
await b.close();
