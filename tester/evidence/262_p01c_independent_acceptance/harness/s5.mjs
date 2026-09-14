// S5 regression, real render: MA on candle pane + DCAP on dedicated sub pane.
import pw from '/home/eestock/workspace/git/eestock/eestock-rs/web/node_modules/playwright/index.js';
const { chromium } = pw;
import fs from 'node:fs';
const H = '/tmp/p01c/harness';
const OUT = '/tmp/p01c/evidence';

const bars = [];
{
  let p = 100;
  for (let i = 0; i < 160; i++) {
    const o = p;
    p = p + Math.sin(i / 7) * 1.6 + Math.cos(i / 3) * 0.8;
    bars.push({ timestamp: Date.UTC(2026,0,1)+i*86400000, open:o, high:Math.max(o,p)+0.9, low:Math.min(o,p)-0.9, close:p, volume: 1000+(i%13)*50 });
  }
}
const RED = '#FF2D2D';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.setContent('<!doctype html><html><body style="margin:0;background:#101418"><div id="root"></div></body></html>');
await page.addScriptTag({ path: `${H}/klinecharts.js` });
await page.addScriptTag({ path: `${H}/overlayEntry.js` });
await page.addScriptTag({ path: `${H}/dcap.js` });
await page.evaluate(`window.__bars = ${JSON.stringify(bars)}; window.__warn=[]; (function(){for(const k of ['warn','error','log']) {const o=console[k].bind(console); console[k]=(...a)=>{window.__warn.push(k+': '+a.map(String).join(' ')); o(...a);} }})();`);
const out = await page.evaluate(`(async () => {
  const el = document.createElement('div');
  el.style.cssText = 'width:900px;height:420px'; document.getElementById('root').appendChild(el);
  const chart = klinecharts.init(el);
  chart.setDataLoader({ getBars: (p) => { p.callback(window.__bars, false); } });
  chart.setSymbol({ ticker: 'TEST', pricePrecision: 3, volumePrecision: 0 });
  chart.setPeriod({ span: 1, type: 'day' });
  await new Promise(r => setTimeout(r, 350));
  klinecharts.registerIndicator(DcapMod.DCAP_INDICATOR_TEMPLATE);
  const supported = klinecharts.getSupportedIndicators().includes('DCAP');
  OverlayEntry.addOverlayIndicator(chart, { name:'MA', calcParams:[5,10,20], paneId:'candle_pane', styles:{ lines:[{color:'${RED}'},{color:'${RED}'},{color:'${RED}'}] } }, 'MA');
  await new Promise(r => setTimeout(r, 300));
  const pixMain = (() => {
    const c = el.querySelectorAll('canvas')[0];
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let red=0,green=0,white=0;
    for (let i=0;i<d.length;i+=4){ if (d[i]>230&&d[i+1]<80&&d[i+2]<80) red++; if (Math.abs(d[i]-0x2d)<25&&Math.abs(d[i+1]-0xc0)<25&&Math.abs(d[i+2]-0x8e)<25) green++; if (d[i]>230&&d[i+1]>230&&d[i+2]>230) white++; }
    return { px:c.width+'x'+c.height, maRed:red, candleGreen:green, textPixels:white };
  })();
  const idDcap = chart.createIndicator({ name:'DCAP', calcParams: DcapMod.dcapCalcParams(DcapMod.DEFAULT_DCAP_PARAMS), paneId:'dcap_pane' }, true);
  await new Promise(r => setTimeout(r, 400));
  const inds = chart.getIndicators({ name:'DCAP' });
  const canvases = [...el.querySelectorAll('canvas')].map((c,i) => {
    const ctx = c.getContext('2d'); const d = ctx.getImageData(0,0,c.width,c.height).data;
    const cnt = (tr,tg,tb,tol) => { let n=0; for(let i=0;i<d.length;i+=4){ if (Math.abs(d[i]-tr)<=tol&&Math.abs(d[i+1]-tg)<=tol&&Math.abs(d[i+2]-tb)<=tol) n++; } return n; };
    return { i, px: c.width+'x'+c.height,
      orange: cnt(0xFF,0x96,0x00,26), purple: cnt(0x93,0x5E,0xBD,26), blue: cnt(0x16,0x77,0xFF,30),
      zeroGrey: cnt(0x76,0x80,0x8F,12) };
  });
  return {
    dcapSupported: supported,
    dcapReturnedId: idDcap,
    dcapNonNull: inds.length > 0,
    dcapPrecision: inds[0] ? inds[0].precision : null,
    dcapFigureKeys: inds[0] ? inds[0].figures.map(f=>f.key) : null,
    dcapFigureZeroStyles: inds[0] ? inds[0].figures.filter(f=>f.key==='zero').map(f=>({style:f.style,color:f.color})) : null,
    dcapPaneId: inds[0] ? inds[0].paneId : null,
    candlePaneNames: chart.getIndicators({ paneId:'candle_pane' }).map(i=>i.name),
    pixMain, canvasCount: el.querySelectorAll('canvas').length, canvases,
    warnings: window.__warn.slice(),
  };
})()`);
await page.screenshot({ path: `${OUT}/s5b_regression_ma_dcap_real.png` });
fs.writeFileSync(`${OUT}/s5_results.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
