// =============================================================================
// 实验插件 wave_squeeze —— 组合② 平台挤压突破（Wyckoff 因果律 / TTM Squeeze 简化）
// 平台定义：过去 plat_n 根（不含当前）振幅 (maxH-minL)/MA60 ≤ amp_max。
// 入场（空仓）：close > 平台高点×brk_buf ∧ 量比≥vol_mult ∧ MA20>MA60 → 85；
//   平台低点记为硬止损参考。
// 离场（持仓）：close < 平台低点 → 15（结构证伪）；close < MA20 → 25。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "plat_n", type: "int", default: 15, min: 5, max: 60, description: "平台窗口（根）" },
  { key: "amp_max", type: "float", default: 0.10, min: 0.02, max: 0.3, description: "平台振幅上限/MA60" },
  { key: "brk_buf", type: "float", default: 1.01, min: 1.0, max: 1.05, description: "突破缓冲" },
  { key: "vol_n", type: "int", default: 20, min: 5, max: 60, description: "均量窗口" },
  { key: "vol_mult", type: "float", default: 1.5, min: 0.5, max: 5, description: "量比阈值" },
  { key: "use_regime", type: "int", default: 1, min: 0, max: 1, description: "MA20>MA60 过滤开关" }
];

let H = [], L = [], V = [];
let platStop = null; // 被突破平台的下沿（持仓期间结构止损）
const CAP = 120;

function maxOf(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }
function minOf(a) { let m = Infinity; for (const x of a) if (x < m) m = x; return m; }
function avgOf(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : null; }

function init(params) { H = []; L = []; V = []; platStop = null; }

function on_bar(ctx) {
  const p = ctx.params, b = ctx.bar;
  const ma20 = ctx.indicators.ma(20);
  const ma60 = ctx.indicators.ma(60);
  let score = 50;

  let platHi = null, platLo = null, isPlat = false;
  if (H.length >= p.plat_n && ma60 !== null && ma60 > 0) {
    const hw = H.slice(-p.plat_n), lw = L.slice(-p.plat_n);
    platHi = maxOf(hw); platLo = minOf(lw);
    isPlat = (platHi - platLo) / ma60 <= p.amp_max;
  }
  const vAvg = V.length >= p.vol_n ? avgOf(V.slice(-p.vol_n)) : null;

  if (ctx.position === null) {
    platStop = null;
    if (isPlat && b.close > platHi * p.brk_buf
        && vAvg !== null && vAvg > 0 && b.volume / vAvg >= p.vol_mult
        && (p.use_regime === 0 || (ma20 !== null && ma60 !== null && ma20 > ma60))) {
      score = 85;
      platStop = platLo; // 次 bar 才成交，但状态先行记录（持仓期使用）
    }
  } else {
    if (platStop !== null && b.close < platStop) score = 15;
    else if (ma20 !== null && b.close < ma20) score = 25;
    // 持仓中平台状态继续刷新（新高平台不降级 stop：棘轮只升不降）
    if (isPlat && platStop !== null) platStop = Math.max(platStop, platLo);
  }

  H.push(b.high); L.push(b.low); V.push(b.volume);
  if (H.length > CAP) { H.shift(); L.shift(); V.shift(); }
  return score;
}

function save() { return { H, L, V, platStop }; }
function load(s) {
  H = s.H || []; L = s.L || []; V = s.V || [];
  platStop = (s.platStop === undefined) ? null : s.platStop;
}
