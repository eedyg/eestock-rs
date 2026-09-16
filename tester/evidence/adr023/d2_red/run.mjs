import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.mjs';

const DIR = process.argv[2];
const MIME = {'.html':'text/html','.js':'text/javascript','.json':'application/json'};
const server = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://x');
  const f = path.join(DIR, path.normalize(u.pathname).replace(/^\//,''));
  fs.readFile(f,(e,d)=>{ if(e){res.writeHead(404);res.end('nf');return;} res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); res.end(d); });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await chromium.launch({args:['--no-sandbox']});
const combos = [['5m','30m'],['30m','1h']];
const all = {};
for (const [b,s] of combos){
  const page = await browser.newPage({viewport:{width:1100,height:900}});
  const external = []; const errs=[];
  page.on('request', r=>{ const u=r.url(); if(!u.startsWith(`http://127.0.0.1:${port}`)) external.push(r.method()+' '+u); });
  page.on('pageerror', e=>errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/probe.html?base=${b}&sat=${s}`,{waitUntil:'load'});
  await page.waitForFunction('window.__probeDone === true', null, {timeout:60000});
  const r = await page.evaluate('window.__probeResult || {error: window.__probeError}');
  r.pageErrors = errs; r.externalRequests = external;
  all[`${b}:${s}`] = r;
  await page.screenshot({path: `${DIR}/shot_${b}_${s}.png`});
  await page.close();
}
await browser.close(); server.close();
fs.writeFileSync(`${DIR}/probe_result_b.json`, JSON.stringify(all,null,1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(all).map(([k,v])=>[k,{meta:v.meta,panes:v.panes,pageErrors:v.pageErrors,externalRequests:v.externalRequests,kStats:Object.fromEntries(Object.entries(v.kStats||{}).map(([kk,vv])=>[kk,{K:vv.K,validCount:vv.validCount,min:vv.min,max:vv.max,median:vv.median,mean:vv.mean}]))}])),null,1));
