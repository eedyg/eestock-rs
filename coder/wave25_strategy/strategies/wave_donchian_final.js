// =============================================================================
// 交付策略 主涨段捕获·Donchian(20/15) —— 冻结验证配置为默认值（任务134 阶段2 冻结）。
// 冻结口径：纯突破（过滤开关缺省全关——训练窗消融显示过滤降交易数且不改善期望）；
// 离场 LLV(15)（「让利润奔跑」胜出面，见 coder/wave_strategy 实验日志 H7）。
// 原实验头部：组合① Donchian 突破 × 量能 × Regime（趋势/ADX）
// 入场（空仓）：close > HHV(brk_n)[不含当前] ∧ 量比≥vol_mult ∧ close>MA(regime_ma)
//   ∧ MA20>MA60（use_regime）∧ ADX(adx_n)>adx_min（use_adx）→ 85
// 离场（持仓）exit_mode：0=close<LLV(exit_n)[不含当前]；1=吊灯(chand_n,k×ATR)棘轮；
//   2=close<MA(exit_ma)；3=close<MA20 且反抽确认（简化：连续2根收MA20下）
// 消融开关：use_vol/use_regime/use_adx（0/1）。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "brk_n", type: "int", default: 20, min: 5, max: 120, description: "突破窗口（Donchian 高点）" },
  { key: "exit_n", type: "int", default: 15, min: 3, max: 60, description: "离场窗口（Donchian 低点）" },
  { key: "vol_n", type: "int", default: 20, min: 5, max: 60, description: "均量窗口" },
  { key: "vol_mult", type: "float", default: 1.3, min: 0.5, max: 5, description: "量比阈值" },
  { key: "regime_ma", type: "int", default: 60, min: 20, max: 250, description: "Regime 均线" },
  { key: "adx_n", type: "int", default: 14, min: 5, max: 30, description: "ADX 周期" },
  { key: "adx_min", type: "float", default: 20, min: 10, max: 40, description: "ADX 阈值" },
  { key: "use_vol", type: "int", default: 0, min: 0, max: 1, description: "量能过滤开关" },
  { key: "use_regime", type: "int", default: 0, min: 0, max: 1, description: "Regime 过滤开关" },
  { key: "use_adx", type: "int", default: 0, min: 0, max: 1, description: "ADX 过滤开关" },
  { key: "exit_mode", type: "int", default: 0, min: 0, max: 3, description: "0=LLV 1=吊灯 2=均线 3=MA20确认" },
  { key: "chand_n", type: "int", default: 22, min: 10, max: 60, description: "吊灯窗口" },
  { key: "chand_k", type: "float", default: 3.0, min: 1, max: 6, description: "吊灯 ATR 倍数" },
  { key: "exit_ma", type: "int", default: 20, min: 5, max: 120, description: "exit_mode=2 均线" }
];

let H = [], L = [], C = [], V = [];
let adxSt = null;
let chand = null;       // 吊灯止损棘轮（持仓期间只升不降；空仓置 null）
let belowCnt = 0;       // exit_mode=3 连续收于 MA20 下计数
const CAP = 300;

function adxInit(n) { adxSt = { n, i: 0, pH: null, pL: null, pC: null, tr: 0, dmp: 0, dmm: 0, adx: null, dxAcc: 0, dxN: 0 }; }

function adxUpdate(high, low, close) {
  const s = adxSt, n = s.n;
  if (s.pC === null) { s.pH = high; s.pL = low; s.pC = close; s.i = 1; return null; }
  const up = high - s.pH, dn = s.pL - low;
  const dmp = (up > dn && up > 0) ? up : 0;
  const dmm = (dn > up && dn > 0) ? dn : 0;
  const tr = Math.max(high - low, Math.abs(high - s.pC), Math.abs(low - s.pC));
  let out = null;
  if (s.i < n) {
    s.tr += tr; s.dmp += dmp; s.dmm += dmm; s.i++;
  } else {
    s.tr = s.tr - s.tr / n + tr;
    s.dmp = s.dmp - s.dmp / n + dmp;
    s.dmm = s.dmm - s.dmm / n + dmm;
    const dip = s.tr > 0 ? 100 * s.dmp / s.tr : 0;
    const dim = s.tr > 0 ? 100 * s.dmm / s.tr : 0;
    const dx = (dip + dim) > 0 ? 100 * Math.abs(dip - dim) / (dip + dim) : 0;
    if (s.adx === null) {
      s.dxAcc += dx; s.dxN++;
      if (s.dxN === n) s.adx = s.dxAcc / n;
    } else {
      s.adx = (s.adx * (n - 1) + dx) / n;
    }
    out = s.adx;
  }
  s.pH = high; s.pL = low; s.pC = close;
  return out;
}

function maxOf(arr) { let m = -Infinity; for (const x of arr) if (x > m) m = x; return m; }
function minOf(arr) { let m = Infinity; for (const x of arr) if (x < m) m = x; return m; }
function avgOf(arr) { let s = 0; for (const x of arr) s += x; return arr.length ? s / arr.length : null; }

function init(params) {
  H = []; L = []; C = []; V = [];
  chand = null; belowCnt = 0;
  adxInit(params.adx_n);
}

function on_bar(ctx) {
  const p = ctx.params;
  const b = ctx.bar;
  const adx = adxUpdate(b.high, b.low, b.close);

  // 判定用窗口：不含当前 bar（避免自破位）
  const hh = H.length >= p.brk_n ? maxOf(H.slice(-p.brk_n)) : null;
  const ll = L.length >= p.exit_n ? minOf(L.slice(-p.exit_n)) : null;
  const hhC = H.length >= p.chand_n ? maxOf(H.slice(-p.chand_n)) : null;
  const vAvg = V.length >= p.vol_n ? avgOf(V.slice(-p.vol_n)) : null;
  const ma20 = ctx.indicators.ma(20);
  const ma60 = ctx.indicators.ma(60);
  const maR = ctx.indicators.ma(p.regime_ma);
  const maX = ctx.indicators.ma(p.exit_ma);
  const atrC = ctx.indicators.atr(p.chand_n);

  let score = 50;

  if (ctx.position === null) {
    chand = null; belowCnt = 0;
    let ok = hh !== null && b.close > hh;
    if (ok && p.use_vol === 1) ok = vAvg !== null && vAvg > 0 && b.volume / vAvg >= p.vol_mult;
    if (ok && p.use_regime === 1) ok = maR !== null && ma20 !== null && ma60 !== null
      && b.close > maR && ma20 > ma60;
    if (ok && p.use_adx === 1) ok = adx !== null && adx >= p.adx_min;
    if (ok) score = 85;
  } else {
    // 离场逻辑
    if (p.exit_mode === 0 && ll !== null && b.close < ll) score = 20;
    else if (p.exit_mode === 1 && hhC !== null && atrC !== null) {
      const raw = Math.max(hhC, b.high) - p.chand_k * atrC;
      chand = chand === null ? raw : Math.max(chand, raw);
      if (b.close < chand) score = 20;
    } else if (p.exit_mode === 2 && maX !== null && b.close < maX) score = 20;
    else if (p.exit_mode === 3 && ma20 !== null) {
      belowCnt = b.close < ma20 ? belowCnt + 1 : 0;
      if (belowCnt >= 2) score = 20;
    }
  }

  // 判定后推窗
  H.push(b.high); L.push(b.low); C.push(b.close); V.push(b.volume);
  if (H.length > CAP) { H.shift(); L.shift(); C.shift(); V.shift(); }
  return score;
}

function save() { return { H, L, C, V, adxSt, chand, belowCnt }; }
function load(s) {
  H = s.H || []; L = s.L || []; C = s.C || []; V = s.V || [];
  chand = (s.chand === undefined) ? null : s.chand;
  belowCnt = s.belowCnt || 0;
  if (s.adxSt) adxSt = s.adxSt;
}
