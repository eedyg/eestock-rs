// =============================================================================
// T0 做T·主张段捕获 v4 —— 三入场机制（OR突破/回调/动量爆发）+ MA趋势/斜率过滤
//                        + ATR 跟踪止损 + 时间强制离场（日内不留隔夜仓）
// 假设：T+0 ETF 日内主张段可由「开盘区间突破 / 多头回踩延续 / 放量动量爆发」捕获；
// 趋势过滤（close>MA 且 MA 上行）保证只在多头环境做多；ATR 跟踪 + 收盘前强平控风险。
// 口径：单标的多头；bar.ts 为 Unix 秒（UTC 瞬时），内部换算 CST（UTC+8）时刻。
// =============================================================================
const PARAMS_SCHEMA = [
  { key: "entry_mode",     type: "int",   default: 0,   min: 0,   max: 2,    description: "入场机制：0=开盘区间突破；1=多头回踩 MA；2=放量动量爆发" },
  { key: "or_minutes",     type: "int",   default: 30,  min: 10,  max: 90,   description: "mode0 开盘区间构建分钟数（自 09:30 起）" },
  { key: "break_buf_bp",   type: "float", default: 0.0, min: 0.0, max: 30.0, description: "mode0 突破缓冲（bp，防毛刺假突破）" },
  { key: "pullback_n",     type: "int",   default: 20,  min: 5,   max: 96,   description: "mode1 回踩均线周期（bar 数）" },
  { key: "mom_n",          type: "int",   default: 6,   min: 3,   max: 48,   description: "mode2 动量回望 bar 数" },
  { key: "mom_pct",        type: "float", default: 0.5, min: 0.1, max: 5.0,  description: "mode2 区间涨幅阈值（%）" },
  { key: "vol_mult",       type: "float", default: 2.0, min: 1.0, max: 10.0, description: "mode2 放量倍数（对 vol_n 均量）" },
  { key: "vol_n",          type: "int",   default: 48,  min: 12,  max: 240,  description: "mode2 均量回望 bar 数" },
  { key: "use_ma_filter",  type: "int",   default: 1,   min: 0,   max: 1,    description: "趋势过滤：close > MA(ma_filter_n)（1 开 / 0 关）" },
  { key: "ma_filter_n",    type: "int",   default: 240, min: 10,  max: 480,  description: "趋势 MA 周期（bar；M5×240≈5 个交易日）" },
  { key: "use_ma_slope",   type: "int",   default: 1,   min: 0,   max: 1,    description: "MA 斜率过滤：MA 较 ma_slope_lag 根前上行（1 开 / 0 关）" },
  { key: "ma_slope_lag",   type: "int",   default: 24,  min: 6,   max: 240,  description: "MA 斜率回望 lag（bar；M5×24≈半交易日）" },
  { key: "entry_cutoff",   type: "int",   default: 810, min: 600, max: 880,  description: "新开仓截止（CST 分钟；810=13:30）" },
  { key: "force_exit",     type: "int",   default: 885, min: 840, max: 899,  description: "强制离场信号时刻（CST 分钟；885=14:45，次 bar 成交约 14:50）" },
  { key: "atr_n",          type: "int",   default: 14,  min: 5,   max: 60,   description: "ATR 周期（bar）" },
  { key: "atr_mult",       type: "float", default: 2.0, min: 0.5, max: 6.0,  description: "ATR 跟踪止损倍数" },
  { key: "use_or_low_stop", type: "int",  default: 1,   min: 0,   max: 1,    description: "跌破开盘区间低点离场开关（1 开 / 0 关）" }
];

// ── 模块级状态（全部入快照）──
let day = -1;                    // 当前 CST 交易日序号
let orHigh = null, orLow = null; // 开盘区间高/低
let orReady = false;             // 开盘区间构建完成标记
let peak = null;                 // 入场后最高价（跟踪止损基准）
let maHist = [];                 // MA 值滚动窗（斜率判定；长度 ≤ ma_slope_lag+1）
let pxHist = [];                 // 收盘价滚动窗（动量判定；长度 ≤ mom_n+1）
let volHist = [];                // 成交量滚动窗（放量判定；长度 ≤ vol_n）

function tmin(ts) { return Math.floor(((ts + 8 * 3600) % 86400) / 60); } // CST 分钟（09:30=570）
function tday(ts) { return Math.floor((ts + 8 * 3600) / 86400); }        // CST 日序号

function on_bar(ctx) {
  const t = tmin(ctx.bar.ts);
  const d = tday(ctx.bar.ts);
  if (d !== day) { day = d; orHigh = null; orLow = null; orReady = false; peak = null; }

  const pos = ctx.position;
  // 时间止损优先于一切（含区间构建期，防隔夜遗留仓）
  if (pos !== null && t >= ctx.params.force_exit) return 10;

  // 开盘区间构建窗口：只积累高低点，不交易
  if (!orReady && t < 570 + ctx.params.or_minutes) {
    orHigh = orHigh === null ? ctx.bar.high : Math.max(orHigh, ctx.bar.high);
    orLow  = orLow  === null ? ctx.bar.low  : Math.min(orLow,  ctx.bar.low);
    pushHist(ctx);
    return 50;
  }
  orReady = true;
  if (orHigh === null) { pushHist(ctx); return 50; } // 当天无区间数据（防御）

  // 趋势过滤（各入场机制共用）：close > MA 且（可选）MA 上行
  let trendOk = true;
  if (ctx.params.use_ma_filter === 1 || ctx.params.use_ma_slope === 1) {
    const maF = ctx.indicators.ma(ctx.params.ma_filter_n);
    if (maF === null) { trendOk = false; }
    else {
      maHist.push(maF);
      if (maHist.length > ctx.params.ma_slope_lag + 1) maHist.shift();
      if (ctx.params.use_ma_filter === 1 && ctx.bar.close <= maF) trendOk = false;
      if (ctx.params.use_ma_slope === 1) {
        if (maHist.length <= ctx.params.ma_slope_lag) trendOk = false;
        else if (maF <= maHist[0]) trendOk = false;
      }
    }
  }

  if (pos === null) {
    if (t >= ctx.params.entry_cutoff) { pushHist(ctx); return 50; }
    if (!trendOk) { pushHist(ctx); return 50; }
    let score = 50;
    if (ctx.params.entry_mode === 1) {
      // 回调入场：多头趋势中本 bar 回踩 MA(pullback_n)（low 触线）且收回其上 → 主张段延续
      const maP = ctx.indicators.ma(ctx.params.pullback_n);
      if (maP !== null && ctx.bar.low <= maP && ctx.bar.close > maP) { peak = ctx.bar.high; score = 80; }
    } else if (ctx.params.entry_mode === 2) {
      // 动量爆发：mom_n 根涨幅 ≥ mom_pct% 且本 bar 量能 ≥ vol_mult × vol_n 均量 → 主张段启动
      const n = ctx.params.mom_n;
      if (pxHist.length > n && volHist.length >= ctx.params.vol_n) {
        const base = pxHist[pxHist.length - 1 - n]; // n 根前收盘（不含当前 bar）
        const chg = base > 0 ? (ctx.bar.close / base - 1) * 100 : 0;
        let vsum = 0; for (let i = 0; i < volHist.length; i++) vsum += volHist[i];
        const vavg = vsum / volHist.length;
        if (chg >= ctx.params.mom_pct && vavg > 0 && ctx.bar.volume >= ctx.params.vol_mult * vavg) {
          peak = ctx.bar.high; score = 80;
        }
      }
    } else {
      // 开盘区间突破：close 上破 OR 高点 + 缓冲 → 做多主张段
      const buf = orHigh * ctx.params.break_buf_bp / 10000;
      if (ctx.bar.close > orHigh + buf) { peak = ctx.bar.high; score = 80; }
    }
    pushHist(ctx);
    return score;
  }

  // 持仓中：维护跟踪峰值，三类离场（时间离场已在顶部处理）
  peak = peak === null ? ctx.bar.high : Math.max(peak, ctx.bar.high);
  if (ctx.params.use_or_low_stop === 1 && orLow !== null && ctx.bar.close < orLow) { pushHist(ctx); return 10; } // 区间失败
  const atr = ctx.indicators.atr(ctx.params.atr_n);
  if (atr !== null && ctx.bar.close < peak - ctx.params.atr_mult * atr) { pushHist(ctx); return 10; }           // ATR 跟踪止损
  pushHist(ctx);
  return 50;
}

// 统一尾段推窗：判定一律用「不含当前 bar」的历史，随后把当前 bar 推入
function pushHist(ctx) {
  pxHist.push(ctx.bar.close);
  if (pxHist.length > ctx.params.mom_n + 1) pxHist.shift();
  volHist.push(ctx.bar.volume);
  if (volHist.length > ctx.params.vol_n) volHist.shift();
}

function save() {
  return { day: day, orHigh: orHigh, orLow: orLow, orReady: orReady, peak: peak,
           maHist: maHist, pxHist: pxHist, volHist: volHist };
}
function load(s) {
  day = (s && s.day != null) ? s.day : -1;
  orHigh = (s && s.orHigh != null) ? s.orHigh : null;
  orLow  = (s && s.orLow  != null) ? s.orLow  : null;
  orReady = !!(s && s.orReady);
  peak = (s && s.peak != null) ? s.peak : null;
  maHist = (s && Array.isArray(s.maHist)) ? s.maHist : [];
  pxHist = (s && Array.isArray(s.pxHist)) ? s.pxHist : [];
  volHist = (s && Array.isArray(s.volHist)) ? s.volHist : [];
}
