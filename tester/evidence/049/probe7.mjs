import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.mjs';
import fs from 'fs';
const BASE='http://127.0.0.1:8081', OUT='/tmp/lane049/evidence';
const ZERO=[118,128,143];
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await b.newContext({viewport:{width:1400,height:900},deviceScaleFactor:1});
const page=await ctx.newPage();
const reqs=[]; page.on('request',r=>reqs.push(r.method()));
await page.goto(BASE+'/',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(6000);
await page.getByRole('button',{name:'DCAP',exact:true}).click();
await page.waitForTimeout(3500);
await page.mouse.move(5,5); await page.waitForTimeout(900);

const scanFn=({ZERO})=>{
  const near=(a,b2,c,t,tol)=>Math.abs(a-t[0])<=tol&&Math.abs(b2-t[1])<=tol&&Math.abs(c-t[2])<=tol;
  const root=document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
  const panes=[...root.children].filter(e=>e.getBoundingClientRect().height>30);
  const dcap=panes[panes.length-1].getBoundingClientRect();
  const el=[...root.querySelectorAll('canvas')].find(c=>{const r=c.getBoundingClientRect();return Math.abs(r.y-dcap.y)<3&&Math.abs(r.height-dcap.height)<3&&r.width>600;});
  const w=el.width,h=el.height;
  const img=el.getContext('2d').getImageData(0,0,w,h).data;
  const rows=new Map();
  for(let y=0;y<h;y++){let c=0;for(let x=0;x<w;x++){const i=(y*w+x)*4;if(img[i+3]>150&&near(img[i],img[i+1],img[i+2],ZERO,6))c++;}if(c>w*0.25)rows.set(y,c);}
  return {rect:{x:Math.round(dcap.x),y:Math.round(dcap.y),w:Math.round(dcap.width),h:Math.round(dcap.height)},canvas:{w,h},zeroRows:[...rows.entries()].sort((a,b3)=>b3[1]-a[1]).map(([y,n])=>({row:y,frac:Math.round(1000*n/w)/1000}))};
};
const scan=()=>page.evaluate(scanFn,{ZERO});
const base=await scan();
console.log('BEFORE injection:',JSON.stringify(base));
// inject a dashed #76808F line at a WRONG row (canvas row 18) on the DCAP pane content canvas
const inj=await page.evaluate(({target})=>{
  const root=document.querySelector('[data-region="main-chart"] div[style*="overflow: hidden"]');
  const panes=[...root.children].filter(e=>e.getBoundingClientRect().height>30);
  const dcap=panes[panes.length-1].getBoundingClientRect();
  const el=[...root.querySelectorAll('canvas')].find(c=>{const r=c.getBoundingClientRect();return Math.abs(r.y-dcap.y)<3&&Math.abs(r.height-dcap.height)<3&&r.width>600;});
  const ctx=el.getContext('2d');
  const row=18;
  ctx.save();ctx.strokeStyle='#76808F';ctx.lineWidth=1;ctx.setLineDash([4,4]);
  ctx.beginPath();ctx.moveTo(0,row+0.5);ctx.lineTo(el.width,row+0.5);ctx.stroke();ctx.restore();
  return {injectedRow:row, canvasH:el.height};
}, {target:'dcap'});
await page.waitForTimeout(400);
const after=await scan();
console.log('injected:',JSON.stringify(inj));
console.log('AFTER injection:',JSON.stringify(after));
await page.screenshot({path:`${OUT}/p7-issue2-red-control.png`});
fs.writeFileSync(`${OUT}/p7-issue2-red-control.json`,JSON.stringify({base,inj,after,nonGet:reqs.filter(m=>m!=='GET')},null,1));
await b.close();
console.log('nonGET requests during control:',reqs.filter(m=>m!=='GET').length);
