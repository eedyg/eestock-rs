// =============================================================================
// 任务136 H-B 实验插件 wave_tsmom_vol —— 完整版 TSMOM（时序动量 × 波动率缩放）
// 上轮 wave_tsmom 只测裸符号（ret_lb 符号→固定分数档），缺 TSMOM 文献核心组件
// 「信号强度 × target_vol/realized_vol」。本插件补齐：
//   z = ret_lb / (σ_daily × √lb)  —— 即 mom / realized_vol（target_vol 为常数吸收进 z_scale）
//   σ_daily = 最近 vol_n 根日收益标准差（ddof=0）
// 评分（use_scale=1，连续强度）：
//   score = clamp(50 + z_scale × z, 0, 100)（默认阈 60/40 → z>+0.5 买 / z<−0.5 卖）；
//   持仓中 z < exit_z → 硬离场 20（趋势强度衰竭，默认 exit_z=0 即符号翻负）。
// 对照（use_scale=0，裸符号，复刻上轮 wave_tsmom 语义）：
//   空仓 ret>up_thr→75 / ret<dn_thr→30；持仓 ret<exit_thr→20。
// R² 趋势质量过滤（use_r2=1，简报组合④思想）：lb 窗内 ln(close) 对 t 的 OLS 拟合
//   优度 R² ≥ r2_min 才允许入场（持仓不加过滤，避免离场抖动）。
// 可选吊灯增强 use_chand（与上轮保持一致的离场对照件）。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "lb", type: "int", default: 120, min: 20, max: 250, description: "动量回看窗口" },
  { key: "vol_n", type: "int", default: 60, min: 20, max: 120, description: "已实现波动率窗口" },
  { key: "z_scale", type: "float", default: 20, min: 5, max: 60, description: "score=50+z_scale×z" },
  { key: "exit_z", type: "float", default: 0.0, min: -2, max: 1, description: "持仓硬离场 z 阈值" },
  { key: "use_scale", type: "int", default: 1, min: 0, max: 1, description: "1=波动率缩放 0=裸符号对照" },
  { key: "up_thr", type: "float", default: 0.0, min: -0.1, max: 0.3, description: "裸模式入场收益阈值" },
  { key: "exit_thr", type: "float", default: 0.0, min: -0.2, max: 0.1, description: "裸模式离场收益阈值" },
  { key: "dn_thr", type: "float", default: -0.08, min: -0.5, max: 0, description: "裸模式看空表达阈值" },
  { key: "use_r2", type: "int", default: 0, min: 0, max: 1, description: "R² 趋势质量过滤开关" },
  { key: "r2_min", type: "float", default: 0.3, min: 0.05, max: 0.9, description: "R² 入场下限" },
  { key: "use_chand", type: "int", default: 0, min: 0, max: 1, description: "吊灯离场增强" },
  { key: "chand_n", type: "int", default: 22, min: 10, max: 60, description: "吊灯窗口" },
  { key: "chand_k", type: "float", default: 3.0, min: 1, max: 6, description: "吊灯 ATR 倍数" }
];

let C = [], H = [];
let chand = null;
const CAP = 400;

function maxOf(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }

// lb 窗 ln(close)~t OLS 的 R²（拟合优度）
function r2Of(closes) {
  const n = closes.length;
  if (n < 10) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const y = Math.log(closes[i]);
    sx += i; sy += y; sxx += i * i; sxy += i * y; syy += y * y;
  }
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  if (vx <= 0 || vy <= 0) return 0;
  return (cov * cov) / (vx * vy);
}

function init(params) { C = []; H = []; chand = null; }

function on_bar(ctx) {
  const p = ctx.params, b = ctx.bar;
  let score = 50;

  const ret = C.length >= p.lb && C[C.length - p.lb] > 0
    ? b.close / C[C.length - p.lb] - 1 : null;
  // 已实现波动率（最近 vol_n 根日收益 std，ddof=0）
  let z = null;
  if (ret !== null && C.length >= p.vol_n) {
    const w = C.slice(-p.vol_n).concat([b.close]);
    const rs = [];
    for (let i = 1; i < w.length; i++) if (w[i - 1] > 0) rs.push(w[i] / w[i - 1] - 1);
    if (rs.length >= 10) {
      const m = rs.reduce((a, r) => a + r, 0) / rs.length;
      const sd = Math.sqrt(rs.reduce((a, r) => a + (r - m) * (r - m), 0) / rs.length);
      if (sd > 0) z = ret / (sd * Math.sqrt(p.lb));
    }
  }
  const r2 = (p.use_r2 === 1 && C.length >= p.lb)
    ? r2Of(C.slice(-p.lb).concat([b.close])) : null;
  const atrC = ctx.indicators.atr(p.chand_n);

  if (ctx.position === null) {
    chand = null;
    if (p.use_scale === 1) {
      if (z !== null) {
        let s = 50 + p.z_scale * z;
        if (p.use_r2 === 1 && s >= 60 && (r2 === null || r2 < p.r2_min)) s = 50;
        score = Math.min(100, Math.max(0, s));
      }
    } else if (ret !== null) {
      let enter = ret > p.up_thr;
      if (enter && p.use_r2 === 1 && (r2 === null || r2 < p.r2_min)) enter = false;
      if (enter) score = 75;
      else if (ret < p.dn_thr) score = 30;
    }
  } else {
    let exit = false;
    if (p.use_scale === 1) {
      if (z !== null && z < p.exit_z) exit = true;
    } else if (ret !== null && ret < p.exit_thr) exit = true;
    if (!exit && p.use_chand === 1 && H.length >= p.chand_n && atrC !== null) {
      const raw = Math.max(maxOf(H.slice(-p.chand_n)), b.high) - p.chand_k * atrC;
      chand = chand === null ? raw : Math.max(chand, raw);
      if (b.close < chand) exit = true;
    }
    if (exit) score = 20;
    else if (p.use_scale === 1 && z !== null) {
      // 持仓中仍输出连续强度分（供 ensemble 聚合），但不低于 45 避免误触卖阈
      score = Math.min(100, Math.max(45, 50 + p.z_scale * z));
    }
  }

  C.push(b.close); H.push(b.high);
  if (C.length > CAP) { C.shift(); H.shift(); }
  return score;
}

function save() { return { C, H, chand }; }
function load(s) {
  C = s.C || []; H = s.H || [];
  chand = (s.chand === undefined) ? null : s.chand;
}
