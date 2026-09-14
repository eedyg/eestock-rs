import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.js';
const { chromium } = pw;
import fs from 'node:fs';
const H = '/tmp/p01c/harness';

const bars = [];
{
  let p = 100;
  for (let i = 0; i < 160; i++) {
    const o = p;
    p = p + Math.sin(i / 7) * 1.6 + Math.cos(i / 3) * 0.8;
    bars.push({ timestamp: Date.UTC(2026,0,1)+i*86400000, open:o, high:Math.max(o,p)+0.9, low:Math.min(o,p)-0.9, close:p, volume: 1000+(i%13)*50 });
  }
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.setContent('<!doctype html><html><body style="margin:0;background:#101418"><div id="root"></div></body></html>');
await page.addScriptTag({ path: `${H}/klinecharts.js` });
await page.evaluate(`window.__bars = ${JSON.stringify(bars)}`);
const out = await page.evaluate(`(async () => {
  const el = document.createElement('div');
  el.style.cssText = 'width:900px;height:420px';
  document.getElementById('root').appendChild(el);
  const chart = klinecharts.init(el);
  chart.setDataLoader({ getBars: (p) => { p.callback(window.__bars, false); } });
  chart.setSymbol({ ticker: 'TEST', pricePrecision: 3, volumePrecision: 0 });
  chart.setPeriod({ span: 1, type: 'day' });
  await new Promise(r => setTimeout(r, 300));
  chart.setBarSpace(4);
  await new Promise(r => setTimeout(r, 300));
  const r = { dataListLen: chart.getDataList().length, canvases: [] };
  for (const c of el.querySelectorAll('canvas')) {
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    const map = new Map();
    for (let i=0;i<d.length;i+=4) { const k=((d[i]<<16)|(d[i+1]<<8)|d[i+2]); map.set(k,(map.get(k)||0)+1); }
    const top = [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>[(('#'+k.toString(16).padStart(6,'0'))),v]);
    r.canvases.push({ px: c.width+'x'+c.height, top });
  }
  // create MA with explicit red styles
  chart.createIndicator({ name:'MA', calcParams:[5,10,20], paneId:'candle_pane', styles:{ lines:[{color:'#FF2D2D'},{color:'#FF2D2D'},{color:'#FF2D2D'}] } }, true);
  await new Promise(r => setTimeout(r, 300));
  r.afterMA = chart.getIndicators({ paneId:'candle_pane' }).map(i => ({ name:i.name, precision:i.precision, figures:i.figures.map(f=>f.key), stylesKeys:Object.keys(i.styles||{}), lineStyles: JSON.stringify(((i.styles||{}).lines||[]).slice(0,3)) }));
  for (const c of el.querySelectorAll('canvas')) {
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let red=0; for (let i=0;i<d.length;i+=4) if (d[i]>140&&d[i+1]<100&&d[i+2]<100) red++;
    r['red_'+(c.width+'x'+c.height+'_'+[...el.querySelectorAll('canvas')].indexOf(c))] = red;
  }
  return r;
})()`);
console.log(JSON.stringify(out, null, 1));
await browser.close();
