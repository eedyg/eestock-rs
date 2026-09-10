// =============================================================================
// 交付策略（ensemble 成员）主涨段捕获·时序动量(lb60) —— 冻结配置为默认。
// 原实验头部：wave_tsmom —— 组合③ 时序动量（TSMOM 日线转译，纯趋势符号）
// 信号：ret_lb = close/close[lb前] - 1（滚动窗口自持）
//   空仓：ret_lb > up_thr → 75；ret_lb < dn_thr → 30（熊市表达，供 ensemble 用）
//   持仓：ret_lb < exit_thr → 20（趋势符号翻负离场）；可选吊灯增强（use_chand）
// 注：TSMOM 文献的波动率目标仓位在平台 LumpSum 下不可表达，本插件只取趋势符号层。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "lb", type: "int", default: 60, min: 20, max: 250, description: "动量回看窗口" },
  { key: "up_thr", type: "float", default: 0.0, min: -0.1, max: 0.3, description: "入场收益阈值" },
  { key: "exit_thr", type: "float", default: 0.0, min: -0.2, max: 0.1, description: "离场收益阈值" },
  { key: "dn_thr", type: "float", default: -0.08, min: -0.5, max: 0, description: "看空表达阈值" },
  { key: "use_chand", type: "int", default: 0, min: 0, max: 1, description: "吊灯离场增强" },
  { key: "chand_n", type: "int", default: 22, min: 10, max: 60, description: "吊灯窗口" },
  { key: "chand_k", type: "float", default: 3.0, min: 1, max: 6, description: "吊灯 ATR 倍数" }
];

let C = [], H = [];
let chand = null;
const CAP = 300;

function maxOf(a) { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; }

function init(params) { C = []; H = []; chand = null; }

function on_bar(ctx) {
  const p = ctx.params, b = ctx.bar;
  let score = 50;
  const ret = C.length >= p.lb && C[C.length - p.lb] > 0
    ? b.close / C[C.length - p.lb] - 1 : null;
  const atrC = ctx.indicators.atr(p.chand_n);

  if (ctx.position === null) {
    chand = null;
    if (ret !== null) {
      if (ret > p.up_thr) score = 75;
      else if (ret < p.dn_thr) score = 30;
    }
  } else {
    if (ret !== null && ret < p.exit_thr) score = 20;
    else if (p.use_chand === 1 && H.length >= p.chand_n && atrC !== null) {
      const raw = Math.max(maxOf(H.slice(-p.chand_n)), b.high) - p.chand_k * atrC;
      chand = chand === null ? raw : Math.max(chand, raw);
      if (b.close < chand) score = 20;
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
