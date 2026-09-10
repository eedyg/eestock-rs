// =============================================================================
// 实验插件 wave_fused —— 路径A 单插件多信号打分融合（条件部分满足给部分分）
// 记分（空仓，基础 50）：
//   趋势族：MA20>MA60>MA120 且 MA60 上行（slope_n 回看） +trend_pts
//           仅 MA20>MA60                                      +trend_pts/2
//   动量族：close > HHV(brk_n)[不含当前]                       +brk_pts
//   量能族：量比 ≥ vol_mult                                    +vol_pts
//   结构族：多头排列中 low 回踩 MA20±pb_tol 且收回其上          +pb_pts
// 持仓：默认 hold_mid（>40 不卖）；破位扣分：
//   close < MA(exit_ma) → exit_score；MA20<MA60（趋势破坏）→ broken_score
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "brk_n", type: "int", default: 60, min: 10, max: 120, description: "突破窗口" },
  { key: "slope_n", type: "int", default: 10, min: 3, max: 30, description: "MA60 斜率回看" },
  { key: "vol_n", type: "int", default: 20, min: 5, max: 60, description: "均量窗口" },
  { key: "vol_mult", type: "float", default: 1.5, min: 0.5, max: 5, description: "量比阈值" },
  { key: "pb_tol", type: "float", default: 0.02, min: 0, max: 0.1, description: "回踩容忍" },
  { key: "trend_pts", type: "int", default: 20, min: 0, max: 40, description: "趋势分" },
  { key: "brk_pts", type: "int", default: 20, min: 0, max: 40, description: "突破分" },
  { key: "vol_pts", type: "int", default: 10, min: 0, max: 30, description: "量能分" },
  { key: "pb_pts", type: "int", default: 15, min: 0, max: 30, description: "回踩分" },
  { key: "exit_ma", type: "int", default: 20, min: 5, max: 120, description: "离场均线" },
  { key: "exit_score", type: "int", default: 30, min: 0, max: 50, description: "破位分" },
  { key: "broken_score", type: "int", default: 20, min: 0, max: 50, description: "趋势破坏分" },
  { key: "hold_mid", type: "int", default: 55, min: 41, max: 59, description: "持仓中位分" }
];

let H = [], V = [], M60 = [];
const CAP = 200;

function maxOf(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }
function avgOf(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : null; }

function init(params) { H = []; V = []; M60 = []; }

function on_bar(ctx) {
  const p = ctx.params, b = ctx.bar;
  const ma20 = ctx.indicators.ma(20);
  const ma60 = ctx.indicators.ma(60);
  const ma120 = ctx.indicators.ma(120);
  const maX = ctx.indicators.ma(p.exit_ma);

  const hh = H.length >= p.brk_n ? maxOf(H.slice(-p.brk_n)) : null;
  const vAvg = V.length >= p.vol_n ? avgOf(V.slice(-p.vol_n)) : null;
  const slopeUp = M60.length > p.slope_n && ma60 !== null
    ? ma60 > M60[M60.length - p.slope_n] : false;

  let score;
  if (ctx.position === null) {
    score = 50;
    if (ma20 !== null && ma60 !== null && ma20 > ma60) {
      const full = ma120 !== null && ma60 > ma120 && slopeUp;
      score += full ? p.trend_pts : p.trend_pts / 2;
    }
    if (hh !== null && b.close > hh) score += p.brk_pts;
    if (vAvg !== null && vAvg > 0 && b.volume / vAvg >= p.vol_mult) score += p.vol_pts;
    if (ma20 !== null && ma60 !== null && ma20 > ma60
        && b.low <= ma20 * (1 + p.pb_tol) && b.close > ma20) score += p.pb_pts;
    if (score > 100) score = 100;
    if (ma20 !== null && ma60 !== null && ma20 < ma60) score = 30; // 空头排列不建仓
  } else {
    score = p.hold_mid;
    if (maX !== null && b.close < maX) score = p.exit_score;
    if (ma20 !== null && ma60 !== null && ma20 < ma60) score = p.broken_score;
  }

  H.push(b.high); V.push(b.volume);
  M60.push(ma60 === null ? 0 : ma60);
  if (H.length > CAP) { H.shift(); V.shift(); M60.shift(); }
  return score;
}

function save() { return { H, V, M60 }; }
function load(s) { H = s.H || []; V = s.V || []; M60 = s.M60 || []; }
