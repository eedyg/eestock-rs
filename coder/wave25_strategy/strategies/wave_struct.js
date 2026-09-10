// =============================================================================
// 任务136 H-A 实验插件 wave_struct —— 结构前提版主涨段（Wyckoff 吸筹/缠论中枢 形式化）
// 与上轮 wave_retest（box_n≤60 简化实现）的区别：本插件以 range_n∈{60,120} 长尺度
// 盘整区间为主体，量能枯竭与带量突破为可消融组件，直接检验「结构前提是否有增量」。
//
// 入场（空仓，须同时满足）：
//   (a) 盘整区间：过去 range_n 根（不含当前）振幅 (RH-RL)/avgC ≤ amp_max
//       （RH=maxH, RL=minL, avgC=区间均收）；
//   (b) 量能枯竭（use_dry=1）：区间后半均量 < 前半均量 × dry_coef；
//   (c) 带量突破整个区间高点：close > RH × brk_buf，
//       且（use_brkvol=1）volume / MA(vol,vol_n) ≥ brk_vol；
//   (d) entry_mode=0 突破即入（85）；entry_mode=1 回踩确认：
//       突破后 ARMED（最多 wait_n 根），low ∈ (zg, zg×retest_band] 且 close>前收 → 85；
//       close < zg 证伪回 IDLE。
// 离场（持仓）exit_mode：0=close < LLV(exit_n)[不含当前]；1=吊灯(chand_n, k×ATR)棘轮。
// 消融开关：use_dry / use_brkvol；无结构前提对照由 wave_donchian_final brk60/120 承担。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "range_n", type: "int", default: 60, min: 40, max: 250, description: "盘整区间窗口（根）" },
  { key: "amp_max", type: "float", default: 0.20, min: 0.05, max: 0.5, description: "区间振幅上限 (RH-RL)/avgC" },
  { key: "dry_coef", type: "float", default: 0.85, min: 0.3, max: 1.5, description: "后半/前半均量系数上限" },
  { key: "use_dry", type: "int", default: 1, min: 0, max: 1, description: "量能枯竭开关" },
  { key: "brk_vol", type: "float", default: 1.3, min: 0.5, max: 5, description: "突破量比阈值" },
  { key: "use_brkvol", type: "int", default: 1, min: 0, max: 1, description: "突破放量开关" },
  { key: "brk_buf", type: "float", default: 1.0, min: 1.0, max: 1.05, description: "突破缓冲 close>RH×buf" },
  { key: "vol_n", type: "int", default: 20, min: 5, max: 60, description: "量比均量窗口" },
  { key: "entry_mode", type: "int", default: 0, min: 0, max: 1, description: "0=突破即入 1=回踩确认" },
  { key: "wait_n", type: "int", default: 10, min: 3, max: 30, description: "突破后等待回踩根数" },
  { key: "retest_band", type: "float", default: 1.03, min: 1.0, max: 1.1, description: "回踩触及带 low≤zg×band" },
  { key: "exit_mode", type: "int", default: 0, min: 0, max: 1, description: "0=LLV 1=吊灯" },
  { key: "exit_n", type: "int", default: 15, min: 3, max: 60, description: "LLV 离场窗口" },
  { key: "chand_n", type: "int", default: 22, min: 10, max: 60, description: "吊灯窗口" },
  { key: "chand_k", type: "float", default: 3.0, min: 1, max: 6, description: "吊灯 ATR 倍数" }
];

let H = [], L = [], C = [], V = [];
let phase = "IDLE";   // IDLE | ARMED（entry_mode=1）
let zg = null;
let armedAge = 0;
let chand = null;
const CAP = 400;

function maxOf(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }
function minOf(a) { let m = Infinity; for (const x of a) if (x < m) m = x; return m; }
function avgOf(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : null; }

function init(params) {
  H = []; L = []; C = []; V = [];
  phase = "IDLE"; zg = null; armedAge = 0; chand = null;
}

function on_bar(ctx) {
  const p = ctx.params, b = ctx.bar;
  let score = 50;

  // 结构判定（窗口不含当前 bar）
  let RH = null, RL = null, ampOk = false, dryOk = true, structOk = false;
  if (H.length >= p.range_n) {
    const hw = H.slice(-p.range_n), lw = L.slice(-p.range_n),
          cw = C.slice(-p.range_n), vw = V.slice(-p.range_n);
    RH = maxOf(hw); RL = minOf(lw);
    const avgC = avgOf(cw);
    ampOk = avgC !== null && avgC > 0 && (RH - RL) / avgC <= p.amp_max;
    if (p.use_dry === 1) {
      const half = Math.floor(p.range_n / 2);
      const v1 = avgOf(vw.slice(0, half)), v2 = avgOf(vw.slice(half));
      dryOk = v1 !== null && v1 > 0 && v2 !== null && v2 < v1 * p.dry_coef;
    }
    structOk = ampOk && dryOk;
  }
  const vAvg = V.length >= p.vol_n ? avgOf(V.slice(-p.vol_n)) : null;
  const prevC = C.length >= 1 ? C[C.length - 1] : null;
  const ll = L.length >= p.exit_n ? minOf(L.slice(-p.exit_n)) : null;
  const hhC = H.length >= p.chand_n ? maxOf(H.slice(-p.chand_n)) : null;
  const atrC = ctx.indicators.atr(p.chand_n);

  if (ctx.position === null) {
    chand = null;
    if (phase === "IDLE") {
      if (structOk && b.close > RH * p.brk_buf) {
        const volOk = p.use_brkvol === 0
          || (vAvg !== null && vAvg > 0 && b.volume / vAvg >= p.brk_vol);
        if (volOk) {
          if (p.entry_mode === 0) score = 85;
          else { phase = "ARMED"; zg = RH; armedAge = 0; }
        }
      }
    } else { // ARMED：等待回踩区间上沿不破
      armedAge++;
      if (b.close < zg) { phase = "IDLE"; zg = null; }
      else if (b.low > zg && b.low <= zg * p.retest_band
               && prevC !== null && b.close > prevC) {
        score = 85; phase = "IDLE"; zg = null;
      } else if (armedAge >= p.wait_n) { phase = "IDLE"; zg = null; }
    }
  } else {
    if (p.exit_mode === 0 && ll !== null && b.close < ll) score = 20;
    else if (p.exit_mode === 1 && hhC !== null && atrC !== null) {
      const raw = Math.max(hhC, b.high) - p.chand_k * atrC;
      chand = chand === null ? raw : Math.max(chand, raw);
      if (b.close < chand) score = 20;
    }
  }

  H.push(b.high); L.push(b.low); C.push(b.close); V.push(b.volume);
  if (H.length > CAP) { H.shift(); L.shift(); C.shift(); V.shift(); }
  return score;
}

function save() { return { H, L, C, V, phase, zg, armedAge, chand }; }
function load(s) {
  H = s.H || []; L = s.L || []; C = s.C || []; V = s.V || [];
  phase = s.phase || "IDLE"; armedAge = s.armedAge || 0;
  zg = (s.zg === undefined) ? null : s.zg;
  chand = (s.chand === undefined) ? null : s.chand;
}
