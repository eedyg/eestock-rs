import fs from 'node:fs';
const j=JSON.parse(fs.readFileSync('/tmp/livecheck-165/out/observe3.json','utf8'));
const wsEvents=j.wsEvents||[];
const closes=(j.wsEvents||[]).filter(e=>e.ev==='ws-close').map(e=>e.rel);
const creates=(j.wsEvents||[]).filter(e=>e.ev==='ws-create').map(e=>e.rel);
const fb=j.fallback;
const cls=fb.map(f=>{
  const nearClose=closes.filter(c=>f.rel>=c&&f.rel-c<=3000);
  const nearCreate=creates.filter(c=>Math.abs(f.rel-c)<=3000);
  return {rel:f.rel, comp:nearClose.length>0||nearCreate.length>0?'compensation':'timer', deltaFromClose:nearClose.length?closes.filter(c=>f.rel-c<=3000).map(c=>f.rel-c):[]};
});
console.log(JSON.stringify({wsFramesIn:j.wsFramesIn,wsOpens:j.wsOpens,wsCloses:j.wsCloses,creates,closes,fallbackRel:fb.map(f=>f.rel),classified:cls},null,1));
