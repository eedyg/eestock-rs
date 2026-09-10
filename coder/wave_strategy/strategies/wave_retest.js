// =============================================================================
// 实验插件 wave_retest —— 组合⑤ 缠论三买 / Wyckoff LPS：中枢突破 + 回踩不破确认
// 中枢（箱体）定义：过去 box_n 根（不含当前）振幅 (ZG-ZD)/MA60 ≤ box_amp，ZG=maxH, ZD=minL。
// 状态机：IDLE →（放量收破 ZG×brk_buf）→ ARMED（记录 ZG，最多等 wait_n 根）
//   ARMED：low > ZG（回踩不入中枢）且 close > 前收（动能重启）→ 85 入场；
//          close < ZG → 证伪回 IDLE；等满 wait_n 根未回踩 → 回 IDLE。
// 入场模式 entry_mode：0=仅回踩确认；1=突破即入（对照档，验证回踩的增量价值）。
// 离场（持仓）：close < ZG_held（跌回中枢）→ 15；close < MA20 → 25。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "box_n", type: "int", default: 18, min: 8, max: 60, description: "中枢窗口（根）" },
  { key: "box_amp", type: "float", default: 0.20, min: 0.05, max: 0.5, description: "中枢振幅上限/MA60" },
  { key: "brk_buf", type: "float", default: 1.01, min: 1.0, max: 1.05, description: "突破缓冲" },
  { key: "brk_vol", type: "float", default: 1.3, min: 0.5, max: 5, description: "突破量比" },
  { key: "vol_n", type: "int", default: 20, min: 5, max: 60, description: "均量窗口" },
  { key: "wait_n", type: "int", default: 10, min: 3, max: 30, description: "突破后等待回踩根数" },
  { key: "entry_mode", type: "int", default: 0, min: 0, max: 1, description: "0=回踩确认 1=突破即入" }
];

let H = [], L = [], C = [], V = [];
let phase = "IDLE";   // IDLE | ARMED
let zg = null;        // 中枢上沿（突破后锁定）
let armedAge = 0;
let zgHeld = null;    // 持仓期间的中枢上沿（离场基准）
const CAP = 120;

function maxOf(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }
function minOf(a) { let m = Infinity; for (const x of a) if (x < m) m = x; return m; }
function avgOf(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : null; }

function init(params) { H = []; L = []; C = []; V = []; phase = "IDLE"; zg = null; armedAge = 0; zgHeld = null; }

function on_bar(ctx) {
  const p = ctx.params, b = ctx.bar;
  const ma20 = ctx.indicators.ma(20);
  const ma60 = ctx.indicators.ma(60);
  let score = 50;

  let boxZG = null, boxZD = null, isBox = false;
  if (H.length >= p.box_n && ma60 !== null && ma60 > 0) {
    boxZG = maxOf(H.slice(-p.box_n)); boxZD = minOf(L.slice(-p.box_n));
    isBox = (boxZG - boxZD) / ma60 <= p.box_amp;
  }
  const vAvg = V.length >= p.vol_n ? avgOf(V.slice(-p.vol_n)) : null;
  const prevC = C.length >= 1 ? C[C.length - 1] : null;

  if (ctx.position === null) {
    zgHeld = null;
    if (phase === "IDLE") {
      if (isBox && b.close > boxZG * p.brk_buf
          && vAvg !== null && vAvg > 0 && b.volume / vAvg >= p.brk_vol) {
        if (p.entry_mode === 1) { score = 85; zgHeld = boxZG; }
        else { phase = "ARMED"; zg = boxZG; armedAge = 0; }
      }
    } else { // ARMED
      armedAge++;
      if (b.close < zg) { phase = "IDLE"; zg = null; }       // 跌回中枢：证伪
      else if (b.low > zg && prevC !== null && b.close > prevC) {
        score = 85; zgHeld = zg; phase = "IDLE"; zg = null;  // 回踩不破+动能重启
      } else if (armedAge >= p.wait_n) { phase = "IDLE"; zg = null; }
    }
  } else {
    if (zgHeld !== null && b.close < zgHeld) score = 15;     // 跌回中枢：结构证伪
    else if (ma20 !== null && b.close < ma20) score = 25;
  }

  H.push(b.high); L.push(b.low); C.push(b.close); V.push(b.volume);
  if (H.length > CAP) { H.shift(); L.shift(); C.shift(); V.shift(); }
  return score;
}

function save() { return { H, L, C, V, phase, zg, armedAge, zgHeld }; }
function load(s) {
  H = s.H || []; L = s.L || []; C = s.C || []; V = s.V || [];
  phase = s.phase || "IDLE"; armedAge = s.armedAge || 0;
  zg = (s.zg === undefined) ? null : s.zg;
  zgHeld = (s.zgHeld === undefined) ? null : s.zgHeld;
}
