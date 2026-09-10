// =============================================================================
// 任务136 H-C 实验插件 wave_mix —— 尺度混合（先后过滤式）
// 短尺度 Donchian 突破入场 + 长尺度 TSMOM（波动率缩放 z）门控：
//   空仓：close > HHV(brk_n)[不含当前] 且（use_gate=1）z_lb > gate_z → 85
//   持仓：close < LLV(exit_n)[不含当前] → 20
// use_gate=0 即退化为上轮交付 Donchian(20/15)（本插件内部对照）。
// ensemble 式混合由平台多 slot 聚合承担（不走本插件）。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "brk_n", type: "int", default: 20, min: 5, max: 120, description: "短尺度突破窗口" },
  { key: "exit_n", type: "int", default: 15, min: 3, max: 60, description: "LLV 离场窗口" },
  { key: "lb", type: "int", default: 250, min: 60, max: 250, description: "长尺度动量窗口" },
  { key: "vol_n", type: "int", default: 60, min: 20, max: 120, description: "已实现波动率窗口" },
  { key: "gate_z", type: "float", default: 0.0, min: -1, max: 2, description: "长尺度门控 z 阈值" },
  { key: "use_gate", type: "int", default: 1, min: 0, max: 1, description: "门控开关(0=纯短突破)" }
];

let H = [], L = [], C = [];
const CAP = 400;

function maxOf(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }
function minOf(a) { let m = Infinity; for (const x of a) if (x < m) m = x; return m; }

function init(params) { H = []; L = []; C = []; }

function on_bar(ctx) {
  const p = ctx.params, b = ctx.bar;
  let score = 50;

  const hh = H.length >= p.brk_n ? maxOf(H.slice(-p.brk_n)) : null;
  const ll = L.length >= p.exit_n ? minOf(L.slice(-p.exit_n)) : null;
  let z = null;
  if (C.length >= Math.max(p.lb, p.vol_n) && C[C.length - p.lb] > 0) {
    const ret = b.close / C[C.length - p.lb] - 1;
    const w = C.slice(-p.vol_n).concat([b.close]);
    const rs = [];
    for (let i = 1; i < w.length; i++) if (w[i - 1] > 0) rs.push(w[i] / w[i - 1] - 1);
    if (rs.length >= 10) {
      const m = rs.reduce((a, r) => a + r, 0) / rs.length;
      const sd = Math.sqrt(rs.reduce((a, r) => a + (r - m) * (r - m), 0) / rs.length);
      if (sd > 0) z = ret / (sd * Math.sqrt(p.lb));
    }
  }

  if (ctx.position === null) {
    if (hh !== null && b.close > hh) {
      const gateOk = p.use_gate === 0 || (z !== null && z > p.gate_z);
      if (gateOk) score = 85;
    }
  } else {
    if (ll !== null && b.close < ll) score = 20;
  }

  H.push(b.high); L.push(b.low); C.push(b.close);
  if (H.length > CAP) { H.shift(); L.shift(); C.shift(); }
  return score;
}

function save() { return { H, L, C }; }
function load(s) { H = s.H || []; L = s.L || []; C = s.C || []; }
