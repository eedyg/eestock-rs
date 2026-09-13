import { computeDcapSeries } from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcap.ts';
import fs from 'fs';
const DIR='/tmp/lane049/evidence', BASE='http://127.0.0.1:8081';
const params=JSON.parse(await (await fetch(BASE+'/api/config/dcap')).text());
const R=JSON.parse(fs.readFileSync(`${DIR}/probe6-record.json`,'utf8'));
const SER=[['s',[255,150,0]],['m',[147,94,189]],['l',[22,119,255]]];
const near=(c,t,tol)=>Math.abs(c.r-t[0])+Math.abs(c.g-t[1])+Math.abs(c.b-t[2])<=tol;
const out={params,note:'brute-force visible-window search: window = loaded bars [i0, i0+L-1]; canonical color->series map s=#FF9600,m=#935EBD,l=#1677FF (klinecharts default line colors); LS fit of row = A + B*value over the 3 series x {min,max} = 6 constraints'};
for(const name of Object.keys(R).filter(k=>/^p6-s\d/.test(k))){
  const rec=R[name];
  const url=(rec.kline||[]).map(s=>s.replace(/^GET /,'')).filter(u=>u.includes('limit=182')).pop();
  const j=await (await fetch(BASE+url)).json();
  const series=computeDcapSeries(j.bars.map(b=>b.close),params);
  const nL=series.length;
  const scan=rec.scans[0]; const zero=scan.zeroRows[0];
  const per={};
  for(const [k,t] of SER){
    const cols=scan.colors.filter(c=>near(c,t,30));
    per[k]={minRow:Math.min(...cols.map(c=>c.minRow)),maxRow:Math.max(...cols.map(c=>c.maxRow))};
  }
  const eqsFor=(i0,L)=>{
    const eqs=[]; const sub=series.slice(i0,i0+L);
    for(const [k] of SER){
      const vs=sub.map(v=>v[k]).filter(v=>v!==null);
      if(vs.length<2) return null;
      eqs.push([1,Math.max(...vs),per[k].minRow],[1,Math.min(...vs),per[k].maxRow]);
    }
    return eqs;
  };
  const fit=(eqs)=>{
    let s1=eqs.length,sB=0,sBB=0,sY=0,sBY=0;
    for(const [,v,y] of eqs){sB+=v;sBB+=v*v;sY+=y;sBY+=v*y;}
    const det=s1*sBB-sB*sB; if(Math.abs(det)<1e-9) return null;
    const B=(s1*sBY-sB*sY)/det, A=(sY-B*sB)/s1;
    let mr=0; for(const [,v,y] of eqs) mr=Math.max(mr,Math.abs(A+B*v-y));
    return {A,B,mr};
  };
  const cands=[];
  for(let L=20;L<=nL;L++) for(let i0=0;i0+L<=nL;i0++){
    const eqs=eqsFor(i0,L); if(!eqs) continue;
    const f=fit(eqs); if(!f) continue;
    cands.push({i0,L,endsAt:i0+L,...f});
  }
  cands.sort((a,b)=>a.mr-b.mr);
  const best=cands[0];
  const s={url,nLoaded:nL,zeroRow:zero?zero.row:null,perPixelRows:per,
    best:{i0:best.i0,L:best.L,endsAt:best.endsAt,res:Math.round(best.mr*100)/100,y0:Math.round(best.A*100)/100,pxPerUnit:Math.round(best.B*100)/100},
    top10:cands.slice(0,10).map(c=>({i0:c.i0,L:c.L,res:Math.round(c.mr*100)/100,y0:Math.round(c.A*100)/100})),
    window_ends_at_last_loaded:cands.filter(c=>c.endsAt===nL).sort((a,b)=>a.mr-b.mr).slice(0,3).map(c=>({L:c.L,res:Math.round(c.mr*100)/100,y0:Math.round(c.A*100)/100})),
    res_histogram:{le_0_5:cands.filter(c=>c.mr<=0.5).length,le_1:cands.filter(c=>c.mr<=1).length,le_2:cands.filter(c=>c.mr<=2).length,total:cands.length}
  };
  if(zero){s.checks={y0_from_best_window:Math.round(best.A*100)/100,zero_row:zero.row,
    delta_px:Math.round((zero.row-best.A)*100)/100,delta_le_3px:Math.abs(zero.row-best.A)<=3,
    implied_value:Math.round(((zero.row-best.A)/best.B)*1e6)/1e6,res_px:Math.round(best.mr*100)/100};}
  out[name]=s;
}
fs.writeFileSync(`${DIR}/pass8.json`,JSON.stringify(out,null,1));
for(const [n,v] of Object.entries(out)){ if(n==='params'||n==='note') continue;
  console.log('\n===',n,'===');
  console.log(' nLoaded',v.nLoaded,'zeroRow',v.zeroRow,'perPixelRows',JSON.stringify(v.perPixelRows));
  console.log(' BEST window:',JSON.stringify(v.best));
  console.log(' top10:',JSON.stringify(v.top10));
  console.log(' windows ending at last loaded bar:',JSON.stringify(v.window_ends_at_last_loaded));
  console.log(' residual hist:',JSON.stringify(v.res_histogram));
  console.log(' checks:',JSON.stringify(v.checks));
}
