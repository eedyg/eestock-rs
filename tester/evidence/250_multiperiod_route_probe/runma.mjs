import { createRequire } from 'node:module'; import fs from 'node:fs'; import path from 'node:path';
const require=createRequire('/home/eestock/workspace/git/eestock/eestock-rs/web/package.json'); const {chromium}=require('playwright');
const here=path.dirname(new URL(import.meta.url).pathname);const b=await chromium.launch();const p=await b.newPage({viewport:{width:700,height:500}});
const m=[];p.on('pageerror',e=>m.push('err:'+e.message));p.on('console',x=>m.push(x.text()));
await p.goto('file://'+path.join(here,'ma.html'));await p.waitForFunction(()=>window.__DONE===true,null,{timeout:30000});
console.log(JSON.stringify({m,result:await p.evaluate(()=>window.__RESULT)},null,1));await b.close();
