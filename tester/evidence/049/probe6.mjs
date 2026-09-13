import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.mjs';
import fs from 'fs';
const BASE='http://127.0.0.1:8081', OUT='/tmp/lane049/evidence';
const ZERO=[118,128,143];
const log=[];const reqs=[];let page;const R={};
const note=s=>{log.push(s);console.log('[*]',s);};
const MEAS=({canvasKey,ZERO,LEG_X,LEG_Y})=>{
  const near=(a,b,c,t,tol)=>Math.abs(a-t[0])<=tol&&Math.abs(b-t[1])<=tol&&Math.abs(c-t[2])<=tol;
  const root=document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
  const el=[...root.querySelectorAll('canvas')][canvasKey.i];
  const cr=el.getBoundingClientRect();const w=el.width,h=el.height;
  const img=el.getContext('2d').getImageData(0,0,w,h).data;
  const inLegend=(x,y)=>x<LEG_X&&y<LEG_Y;
  const map=new Map();
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4;if(img[i+3]<150)continue;
    if(inLegend(x,y))continue;
    const key=(img[i]<<16)|(img[i+1]<<8)|img[i+2];
    let rec=map.get(key);if(!rec){rec={hex:'#'+[img[i],img[i+1],img[i+2]].map(v=>v.toString(16).padStart(2,'0')).join(''),r:img[i],g:img[i+1],b:img[i+2],n:0,minRow:y,maxRow:y,minX:999,maxX:0,minRowXMin:x,minRowXMax:x,maxRowXMin:x,maxRowXMax:x};map.set(key,rec);}
    rec.n++; if(x<rec.minX)rec.minX=x; if(x>rec.maxX)rec.maxX=x;
    if(y<rec.minRow){rec.minRow=y;rec.minRowXMin=x;rec.minRowXMax=x;} else if(y===rec.minRow){rec.minRowXMin=Math.min(rec.minRowXMin,x);rec.minRowXMax=Math.max(rec.minRowXMax,x);}
    if(y>rec.maxRow){rec.maxRow=y;rec.maxRowXMin=x;rec.maxRowXMax=x;} else if(y===rec.maxRow){rec.maxRowXMin=Math.min(rec.maxRowXMin,x);rec.maxRowXMax=Math.max(rec.maxRowXMax,x);}
  }
  // legend bbox: rows in top band with many colored pixels
  let legendBottom=0,legendRight=0;
  for(let y=0;y<60;y++){let c=0,lastX=0;for(let x=0;x<w;x++){const i=(y*w+x)*4;if(img[i+3]>150&&x<LEG_X){c++;lastX=x;}}
    if(c>=8){legendBottom=y;legendRight=Math.max(legendRight,lastX);}}
  const zeroRow=new Map();
  for(let y=0;y<h;y++){let c=0;for(let x=0;x<w;x++){const i=(y*w+x)*4;if(img[i+3]>150&&near(img[i],img[i+1],img[i+2],ZERO,6))c++;}if(c>w*0.25)zeroRow.set(y,c);}
  const zRows=[...zeroRow.entries()].sort((a,b)=>b[1]-a[1]).map(([y,n])=>({row:y,n,frac:Math.round(1000*n/w)/1000}));
  let zSpan=null;
  if(zRows.length){const yc=zRows[0].row;let mn=999,mx=0;for(let x=0;x<w;x++){const i=(yc*w+x)*4;if(img[i+3]>150&&near(img[i],img[i+1],img[i+2],ZERO,6)){if(x<mn)mn=x;if(x>mx)mx=x;}}zSpan=[mn,mx];}
  return {rect:{x:Math.round(cr.x),y:Math.round(cr.y),w:Math.round(cr.width),h:Math.round(cr.height)},w,h,legendBottom,legendRight,zeroRows:zRows,zeroSpanX:zSpan,
    colors:[...map.values()].sort((a,b)=>b.n-a.n).slice(0,20).map(c=>({hex:c.hex,r:c.r,g:c.g,b:c.b,n:c.n,minRow:c.minRow,maxRow:c.maxRow,minRowX:[c.minRowXMin,c.minRowXMax],maxRowX:[c.maxRowXMin,c.maxRowXMax],minX:c.minX,maxX:c.maxX}))};
};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await browser.newContext({viewport:{width:1400,height:900},deviceScaleFactor:1});
page=await ctx.newPage();
page.on('request',r=>reqs.push({m:r.method(),u:r.url()}));
async function shape(name,setup){
  await page.goto(BASE+'/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(5500);
  const before=reqs.length; if(setup) await setup();
  await page.getByRole('button',{name:'DCAP',exact:true}).click();await page.waitForTimeout(3500);
  await page.mouse.move(5,5);await page.waitForTimeout(900);
  const idx=await page.evaluate(()=>{const root=document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
    return [...root.querySelectorAll('canvas')].map((c,i)=>{const r=c.getBoundingClientRect();return {i,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};});});
  const panes=await page.evaluate(()=>{const root=document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
    return [...root.children].map(e=>{const r=e.getBoundingClientRect();return {y:Math.round(r.y),h:Math.round(r.height)};});});
  const content=panes.filter(p=>p.h>30);
  const dp=content[content.length-1];
  const keys=idx.filter(c=>Math.abs(c.y-dp.y)<3&&Math.abs(c.h-dp.h)<3&&c.w>600);
  const scans=[];
  for(const k of keys) scans.push(await page.evaluate(MEAS,{canvasKey:k,ZERO,LEG_X:760,LEG_Y:60}));
  R[name]={panes:content,dcapPane:dp,scans,keys,kline:reqs.slice(before).filter(r=>r.u.includes('/api/kline')).map(r=>r.m+' '+r.u.replace(BASE,''))};
  note(`${name} zeroRows=${JSON.stringify(scans.map(s=>s.zeroRows))} zeroSpanX=${JSON.stringify(scans.map(s=>s.zeroSpanX))} legendBottom=${JSON.stringify(scans.map(s=>s.legendBottom))}`);
  note(`  colors=${JSON.stringify(scans[0].colors.slice(0,10).map(c=>[c.hex,c.n,c.minRow,c.maxRow,c.minRowXs,c.maxRowXs]))}`);
  await page.screenshot({path:`${OUT}/${name}.png`});
}
await shape('p6-s1-15m-518880');
await shape('p6-s2-1m-518880',async()=>{await page.getByRole('button',{name:'1m',exact:true}).click();await page.waitForTimeout(2500);});
await shape('p6-s3-day-518880',async()=>{await page.getByRole('button',{name:'日',exact:true}).click();await page.waitForTimeout(2500);});
await shape('p6-s4-15m-161226',async()=>{await page.getByText('161226',{exact:true}).click();await page.waitForTimeout(2500);});
const nonGet=reqs.filter(r=>r.m!=='GET');
R.requests={total:reqs.length,nonGet:nonGet.map(r=>r.m+' '+r.u)};
fs.writeFileSync(`${OUT}/probe6-record.json`,JSON.stringify(R,null,1));
fs.writeFileSync(`${OUT}/probe6-log.txt`,log.join('\n'));
await browser.close();console.log('DONE nonGET='+nonGet.length);
