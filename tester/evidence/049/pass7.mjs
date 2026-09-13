import { computeDcapSeries } from '/home/eestock/workspace/git/eestock/eestock-rs/web/src/features/indicators/dcap.ts';
import fs from 'fs';
const DIR='/tmp/lane049/evidence', BASE='http://127.0.0.1:8081';
const params=JSON.parse(await (await fetch(BASE+'/api/config/dcap')).text());
const R=JSON.parse(fs.readFileSync(`${DIR}/probe6-record.json`,'utf8'));
const SER=[['s',[255,150,0]],['m',[147,94,189]],['l',[22,119,255]]];
const near=(c,t,tol)=>Math.abs(c.r-t[0])+Math.abs(c.g-t[1])+Math.abs(c.b-t[2])<=tol;
const out={params,shapes:{}};
for(const name of Object.keys(R).filter(k=>/^p6-s\d/.test(k))){
  const rec=R[name];
  const url=(rec.kline||[]).map(s=>s.replace(/^GET /,'')).filter(u=>u.includes('limit=182')).pop();
  const j=await (await fetch(BASE+url)).json();
  const series=computeDcapSeries(j.bars.map(b=>b.close),params);
  const nL=series.length;
  const scan=rec.scans[0]; const zero=scan.zeroRows[0];
  // cluster per series color (excl legend) : legend already excluded in probe
  const per={};
  for(const [k,t] of SER){
    const cols=scan.colors.filter(c=>near(c,t,30));
    if(!cols.length){per[k]=null;continue;}
    per[k]={minRow:Math.min(...cols.map(c=>c.minRow)),maxRow:Math.max(...cols.map(c=>c.maxRow)),
      minRowX:cols.filter(c=>c.minRow===Math.min(...cols.map(v=>v.minRow))).map(c=>c.minRowX),
      maxRowX:cols.filter(c=>c.maxRow===Math.max(...cols.map(v=>v.maxRow))).map(c=>c.maxRowX), n:cols.reduce((a,c)=>a+c.n,0)};
  }
  const fitFor=N=>{
    const sub=series.slice(nL-N);
    const st={};
    for(const k of ['s','m','l']){const vs=sub.map(v=>v[k]).filter(v=>v!==null); if(!vs.length) return null; st[k]=[Math.min(...vs),Math.max(...vs)];}
    const eqs=[];
    for(const [k] of SER){eqs.push([1,st[k][1],per[k].minRow]);eqs.push([1,st[k][0],per[k].maxRow]);}
    let s1=6,sB=0,sBB=0,sY=0,sBY=0;
    for(const [,v,y] of eqs){sB+=v;sBB+=v*v;sY+=y;sBY+=v*y;}
    const det=s1*sBB-sB*sB; if(Math.abs(det)<1e-9) return null;
    const B=(s1*sBY-sB*sY)/det, A=(sY-B*sB)/s1;
    let mr=0,per_res={};
    for(const [k] of SER){const ymax=per[k].minRow,ymin=per[k].maxRow;
      const r1=Math.abs(A+B*st[k][1]-ymax), r2=Math.abs(A+B*st[k][0]-ymin); mr=Math.max(mr,r1,r2); per_res[k]=Math.round(Math.max(r1,r2)*100)/100;}
    return {N,A,B,maxRes:mr,per_res,st};
  };
  const Ns=[...Array(nL-19).keys()].map(i=>i+20);
  const all=Ns.map(fitFor).filter(Boolean).sort((a,b)=>a.maxRes-b.maxRes);
  const pinned={};
  for(const N of [70,75,76,80,90,100,105,106,107,110,113,120,130,150,182]){const f=fitFor(N); if(f) pinned[N]={y0:Math.round(f.A*100)/100,res:Math.round(f.maxRes*100)/100,per:f.per_res};}
  const b=all[0];
  const s={url,per,legendBottom:scan.legendBottom,zeroLine:zero,zeroSpanX:scan.zeroSpanX,
    panes:rec.panes.map(p=>p.h),
    globalBest:{N:b.N,y0:Math.round(b.A*100)/100,pxPerUnit:Math.round(b.B*100)/100,res:Math.round(b.maxRes*100)/100,per_res:b.per_res},
    bestResValue:Math.round(b.maxRes*100)/100,
    ties:all.filter(f=>Math.abs(f.maxRes-b.maxRes)<1e-9).map(f=>f.N),
    N_with_res_le_2_5:all.filter(f=>f.maxRes<=2.5).map(f=>f.N),
    pinnedN:pinned};
  if(zero){s.checks={zero_row:zero.row,y0_delta_px:Math.round((zero.row-b.A)*100)/100,
    delta_le_3px:Math.abs(zero.row-b.A)<=3,
    implied_value:Math.round(((zero.row-b.A)/b.B)*1e6)/1e6,
    calibration_res_px:Math.round(b.maxRes*100)/100, zero_span_frac:Math.round(1000*((scan.zeroSpanX?scan.zeroSpanX[1]-scan.zeroSpanX[0]:0)/scan.w))/1000};}
  out.shapes[name]=s;
}
fs.writeFileSync(`${DIR}/pass7.json`,JSON.stringify(out,null,1));
for(const [n,v] of Object.entries(out.shapes)){
  console.log('\n===',n,'===');
  console.log(' per-series pixel rows:',JSON.stringify(v.per));
  console.log(' zero row',v.zeroLine&&v.zeroLine.row,'spanX',JSON.stringify(v.zeroSpanX));
  console.log(' globalBest:',JSON.stringify(v.globalBest),'ties:',JSON.stringify(v.ties));
  console.log(' res<=2.5px at N:',JSON.stringify(v.N_with_res_le_2_5));
  console.log(' pinned:',Object.entries(v.pinnedN).map(([N,o])=>`${N}:y0=${o.y0},res=${o.res}`).join(' | '));
  console.log(' checks:',JSON.stringify(v.checks));
}
