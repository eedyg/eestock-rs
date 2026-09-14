(function(){
  const kc=window.klinecharts, R={logs:[],errors:[]};
  const raf=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const NOW=Date.parse('2026-09-14T07:00:00Z'),N=600,bars=[];let px=8.9;
  for(let i=0;i<N;i++){const ts=NOW-(N-1-i)*60000;px+=(Math.sin(i/11)+Math.cos(i/23))*0.0015;const o=px,c=px+Math.sin(i/7)*0.001;bars.push({timestamp:ts,open:+o.toFixed(4),high:+(Math.max(o,c)+8e-4).toFixed(4),low:+(Math.min(o,c)-8e-4).toFixed(4),close:+c.toFixed(4),volume:1000+(i%37)*100});}
  const ext5=(function(){const ts=[],values=[],bm=300000;let s=Math.floor(bars[0].timestamp/bm)*bm;while(s+bm<=bars[N-1].timestamp+60000){ts.push(s);values.push(+(Math.sin(s/3000000)*2+3).toFixed(4));s+=bm;}return{ts,values};})();
  // template: external series via extendData; line color forced to a unique pure color
  kc.registerIndicator({name:'EXT_A',figures:[{key:'v',title:'vA: ',type:'line',styles:()=>({color:'#ff0000',size:2})}],precision:5,
    calc(dataList,ind){const ext=ind.extendData;if(!ext||!ext.ts)return dataList.map(()=>({v:null}));const m=new Map();for(let i=0;i<ext.ts.length;i++)m.set(ext.ts[i],ext.values[i]);return dataList.map(d=>({v:m.has(d.timestamp)?m.get(d.timestamp):null}));}});
  const chart=kc.init('chart',{styles:'dark'});window.__CHART=chart;
  chart.setSymbol({ticker:'518880',pricePrecision:4,volumePrecision:0});chart.setPeriod({span:1,type:'minute'});
  chart.setDataLoader({getBars:({callback})=>callback(bars,false),subscribe:()=>{},unsubscribe:()=>{}});
  chart.createIndicator({name:'EXT_A',extendData:ext5},true);
  chart.createIndicator('VOL',true);
  (async()=>{try{
    await sleep(500);await raf();
    const all=chart.getIndicators();R.logs.push(['indicatorsRaw',all.map(i=>({name:i.name,paneId:i.paneId,yAxisId:i.yAxisId,resultLen:i.result&&i.result.length}))]);const ind=all.find(i=>i.name==='EXT_A');const PID=ind.paneId,PIDV=all.find(i=>i.name==='VOL').paneId;
    R.logs.push(['paneIds',{PID,PIDV}]);
    // heights: default, then set, then zoom/scroll
    R.logs.push(['heights.default',chart.getPaneOptions().map(p=>[p.id.slice(-12),p.height,chart.getSize(p.id,'root').height])]);
    chart.setPaneOptions({id:PID,height:333});await raf();
    R.logs.push(['heights.afterSet333',chart.getPaneOptions().map(p=>[p.id.slice(-12),p.height,chart.getSize(p.id,'root').height])]);
    chart.zoomAtTimestamp(0.6,bars[N-60].timestamp);chart.scrollByDistance(150);await raf();
    R.logs.push(['heights.afterZoomScroll',chart.getPaneOptions().map(p=>[p.id.slice(-12),p.height,chart.getSize(p.id,'root').height])]);
    R.logs.push(['visRangeAfterZoomScroll',chart.getVisibleRange()]);
    // pixel: find first non-null external value in visible range; sample canvas near expected coordinate
    const cv=chart.getDom(PID,'root').querySelector('canvas');
    R.logs.push(['canvas',{w:cv&&cv.width,h:cv&&cv.height}]);
    const ctx=cv.getContext('2d');
    const vr=chart.getVisibleRange();
    let probe=null;
    for(let idx=Math.max(0,vr.from);idx<Math.min(N,vr.to);idx++){
      const v=ind.result[idx]&&ind.result[idx].v;if(v==null)continue;
      const c=chart.convertToPixel({timestamp:bars[idx].timestamp,value:v},{paneId:PID});
      if(!c||c.x==null||c.x<2)continue;
      let hits=0,samples=[];
      for(let dx=-4;dx<=4;dx++)for(let dy=-4;dy<=4;dy++){const p=ctx.getImageData(Math.round(c.x)+dx,Math.round(c.y)+dy,1,1).data;if(p[0]>150&&p[1]<80&&p[2]<80){hits++;samples.push([dx,dy,p[0],p[1],p[2]]);}}
      probe={idx,ts:bars[idx].timestamp,value:v,coord:{x:Math.round(c.x),y:Math.round(c.y)},redHits:hits,sample:samples.slice(0,3)};
      break;
    }
    R.logs.push(['pixel.redLineHit',probe]);
    // count total pure-red pixels in this pane canvas (line should produce a few hundred)
    const d=ctx.getImageData(0,0,cv.width,cv.height).data;let red=0;
    for(let i=0;i<d.length;i+=4)if(d[i]>150&&d[i+1]<80&&d[i+2]<80)red++;
    R.logs.push(['paneRedPixelCount',red]);
    R.logs.push(['paneNonBgCount',(()=>{let n=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>0&&(d[i]>25||d[i+1]>25||d[i+2]>25))n++;return n;})()]);
    // x-sync: for 5 timestamps in visible range, x pixel identical for candle vs indicator pane
    const xs=[];
    for(let k=0;k<5;k++){const idx=Math.max(0,vr.from)+Math.round((vr.to-vr.from)*(k+0.5)/5);const ts=bars[Math.min(N-1,idx)].timestamp;
      const a=chart.convertToPixel({timestamp:ts,value:8.9},{paneId:'candle_pane'});const b=chart.convertToPixel({timestamp:ts,value:3},{paneId:PID});
      xs.push({idx,xCandle:a&&a.x,xPane:b&&b.x,same:(a&&b)?Math.abs(a.x-b.x)<1e-9:null});}
    R.logs.push(['xSync',xs]);
  }catch(e){R.errors.push([String(e),e.stack]);}window.__RESULT=R;window.__DONE=true;})();
})();
