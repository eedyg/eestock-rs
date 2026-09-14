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
 const id=chart.createIndicator({name:'DCAP',paneId:'dcap_pane',calcParams:DcapMod.dcapCalcParams(DcapMod.DEFAULT_DCAP_PARAMS)},true);
 await new Promise(r=>setTimeout(r,400));
 const c=[...el.querySelectorAll('canvas')].find(x=>x.width>400&&x.height<200);
 const W=c.width,Hh=c.height,d=c.getContext('2d').getImageData(0,0,W,Hh).data;
 const at=(x,y)=>{const i=(y*W+x)*4;return [d[i],d[i+1],d[i+2]];};
 const isGrey=(x,y)=>{const [R,G,B]=at(x,y);return Math.abs(R-0x76)<22&&Math.abs(G-0x80)<22&&Math.abs(B-0x8F)<22;};
 const isOrange=(x,y)=>{const [R,G,B]=at(x,y);return Math.abs(R-0xFF)<40&&Math.abs(G-0x96)<40&&B<90;};
 // grey row profile
 let bestRow=null,bestN=0; const greyRows=[];
 for(let y=0;y<Hh;y++){let n=0,xs=[];for(let x=0;x<W;x++){if(isGrey(x,y)){n++;xs.push(x);}} if(n>5) greyRows.push({y,n,minX:xs[0],maxX:xs[xs.length-1]}); if(n>bestN){bestN=n;bestRow=y;}}
 // orange column profile (data line)
 let firstOrangeX=null,lastOrangeX=null,orangeTotal=0;
 for(let x=0;x<W;x++){let n=0;for(let y=35;y<Hh;y++){if(isOrange(x,y))n++;} if(n>0){orangeTotal+=n; if(firstOrangeX===null)firstOrangeX=x; lastOrangeX=x;}}
 return {dcapId:id, canvas:{W,Hh},
   greyRowsTop: greyRows.slice(0,6), greyRowCount:greyRows.length, bestRow, bestRowCoverage: bestN+'/'+W,
   orange:{firstOrangeX,lastOrangeX,orangeTotal},
   brokenLineExpectedFirstX: null, legendRowOrange: (()=>{let n=0;for(let y=0;y<35;y++)for(let x=0;x<W;x++)if(isOrange(x,y))n++;return n;})() };
})()`);
console.log(JSON.stringify(out,null,1));
await b.close();
