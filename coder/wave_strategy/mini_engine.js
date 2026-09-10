#!/usr/bin/env node
// 任务134 本地迷你引擎：1:1 复刻 strategy-core 执行语义（决策 bar close 评分 → 次 bar open 成交），
// 用于带持仓反馈的多插件 ensemble 快速实验。口径来源（注释行号为 crates 源码）：
//   - 聚合=加权平均、classify ≥buy/≤sell（aggregate.rs）
//   - LumpSum 冻结目标：Buy 建立时 equity×pct/close 快照冻结，Hold 解冻，Sell→0（policy.rs）
//   - fee：买=价×(1+slip)，卖=价×(1−slip)，佣金 max(额×率,最低)，印花税仅卖（fee.rs）
//   - 期末最后 close 强平（engine.rs）；nav[i]=cash+qty×close[i]
//   - 指标口径复刻 indicators.rs（MA/EMA/RSI/MACD/KDJ/BOLL/ATR Wilder）
// 输入：node mini_engine.js job.json → stdout {metrics, trades, nav?}
// job: {bars:[{ts,open,high,low,close,volume}], slots:[{code,params,weight}],
//       buy_threshold, sell_threshold, fee:{rate_pct,min_fee,slippage_bp,stamp_duty_pct},
//       initial_capital, keep_nav}
"use strict";
const fs = require("fs");
const vm = require("vm");

const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bars = job.bars;
const N = bars.length;
const BUY_THR = job.buy_threshold ?? 60, SELL_THR = job.sell_threshold ?? 40;
const FEE = job.fee, CAP0 = job.initial_capital ?? 100000;

// ── 指标（口径复刻 crates/backtest/src/indicators.rs）──
function makeIndicators(index) {
  const closes = bars, i = index;
  return {
    ma(p) {
      if (p === 0 || i + 1 < p) return null;
      let s = 0;
      for (let k = i + 1 - p; k <= i; k++) s += closes[k].close;
      return s / p;
    },
    ema(p) {
      if (p === 0 || N === 0) return null;
      const k = 2 / (p + 1);
      let e = closes[0].close;
      for (let j = 1; j <= i; j++) e = closes[j].close * k + e * (1 - k);
      return e;
    },
    rsi(p) { // Wilder；首值 index==p（前 p 个涨跌幅均值作种子）
      if (p === 0 || i < p) return null;
      let g = 0, l = 0;
      for (let j = 1; j <= p; j++) {
        const d = closes[j].close - closes[j - 1].close;
        if (d > 0) g += d; else l -= d;
      }
      let ag = g / p, al = l / p;
      for (let j = p + 1; j <= i; j++) {
        const d = closes[j].close - closes[j - 1].close;
        ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
        al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
      }
      if (al === 0) return 100;
      return 100 - 100 / (1 + ag / al);
    },
    macd() {
      const ef = this.ema(12), es = this.ema(26);
      if (ef === null || es === null) return null;
      // DEA = EMA9 of DIF（DIF[0] 种子）；DIF[0] 需要 EMA 自 0 起——从头算 DIF 序列
      let efj = closes[0].close, esj = closes[0].close, dea = 0;
      const kf = 2 / 13, ks = 2 / 27, kd = 2 / 10;
      let dif0 = null;
      for (let j = 1; j <= i; j++) {
        efj = closes[j].close * kf + efj * (1 - kf);
        esj = closes[j].close * ks + esj * (1 - ks);
        const dif = efj - esj;
        if (dif0 === null) { dif0 = dif; dea = dif; } else dea = dif * kd + dea * (1 - kd);
      }
      const dif = ef - es;
      if (i === 0) dea = dif;
      return { dif, dea, macd: dif - dea };
    },
    kdj() {
      const n = 9;
      if (i + 1 < n) return null;
      let K = 50, D = 50;
      for (let j = n - 1; j <= i; j++) {
        let hh = -Infinity, ll = Infinity;
        for (let k = j - n + 1; k <= j; k++) { hh = Math.max(hh, closes[k].high); ll = Math.min(ll, closes[k].low); }
        const rsv = hh > ll ? (closes[j].close - ll) / (hh - ll) * 100 : 50;
        K = (2 / 3) * K + (1 / 3) * rsv;
        D = (2 / 3) * D + (1 / 3) * K;
      }
      return { k: K, d: D, j: 3 * K - 2 * D };
    },
    boll(p, mult) {
      const mid = this.ma(p);
      if (mid === null) return null;
      let s = 0;
      for (let k = i + 1 - p; k <= i; k++) s += (closes[k].close - mid) ** 2;
      const sd = Math.sqrt(s / p); // ddof=0
      return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
    },
    atr(p) {
      if (p === 0 || i + 1 < p) return null;
      const tr = (j) => j === 0 ? closes[0].high - closes[0].low
        : Math.max(closes[j].high - closes[j].low,
                   Math.abs(closes[j].high - closes[j - 1].close),
                   Math.abs(closes[j].low - closes[j - 1].close));
      let a = 0;
      for (let j = 0; j < p; j++) a += tr(j);
      a /= p;
      for (let j = p; j <= i; j++) a = (a * (p - 1) + tr(j)) / p;
      return a;
    }
  };
}

// ── 费用（复刻 fee.rs）──
const slip = FEE.slippage_bp / 10000, cf = FEE.rate_pct / 100, sf = (FEE.stamp_duty_pct ?? 0.05) / 100;
const minFee = FEE.min_fee ?? 0;
function feeBuy(budget, raw) {
  const eff = raw * (1 + slip);
  let shares = budget / (eff * (1 + cf));
  let value = shares * eff;
  let comm = Math.max(value * cf, minFee);
  if (!(comm > minFee)) { // 最低佣金主导分支
    value = Math.max(budget - minFee, 0);
    shares = eff > 0 ? value / eff : 0;
    comm = value > 0 ? minFee : 0;
  }
  return { shares, value, comm, eff };
}
function feeSell(qty, raw) {
  const eff = raw * (1 - slip);
  const value = qty * eff;
  const comm = Math.max(value * cf, minFee);
  const stamp = value * sf;
  return { value, comm, stamp, proceeds: value - comm - stamp, eff };
}

// ── 插件实例化（独立 vm 上下文）──
function instantiate(slot) {
  const ctx = vm.createContext({});
  vm.runInContext(slot.code + `
this.__hooks = {
  init: (typeof init !== "undefined") ? init : null,
  on_bar: (typeof on_bar !== "undefined") ? on_bar : null,
  save: (typeof save !== "undefined") ? save : null,
  load: (typeof load !== "undefined") ? load : null,
  __schema: (typeof PARAMS_SCHEMA !== "undefined") ? PARAMS_SCHEMA : []
};`, ctx);
  const hooks = ctx.__hooks;
  if (!hooks.on_bar) throw new Error("plugin missing on_bar");
  const params = {};
  for (const d of hooks.__schema) params[d.key] = d.default;
  Object.assign(params, slot.params || {});
  if (hooks.init) vm.runInContext(`init(${JSON.stringify(params)})`, ctx);
  return {
    weight: slot.weight,
    on_bar(c) { ctx.__c = c; return vm.runInContext(`on_bar(__c)`, ctx); },
    params
  };
}

const slots = job.slots.map(instantiate);

// ── 引擎主循环（复刻 engine.rs）──
let cash = CAP0, holding = null; // {qty, costBasis, valueBasis, entryTs, entryBar}
let pending = null;              // {side, qty}
let lumpFrozen = null;
const trades = [], nav = [];
const BARS_PER_YEAR = 252;

for (let i = 0; i < N; i++) {
  const bar = bars[i];
  // 1) 执行上一 bar 挂单（次 bar open 成交）
  if (pending) {
    if (pending.side === "buy") {
      const aff = feeBuy(cash, bar.open);
      const qty = Math.min(pending.qty, aff.shares);
      if (qty > 1e-12) {
        const eff = bar.open * (1 + slip);
        const value = qty * eff;
        const comm = Math.max(value * cf, minFee);
        cash -= value + comm;
        if (!holding) holding = { qty: 0, costBasis: 0, valueBasis: 0, entryTs: bar.ts, entryBar: i };
        holding.qty += qty;
        holding.costBasis += value + comm;
        holding.valueBasis += value;
        if (lumpFrozen !== null && holding.qty < lumpFrozen) lumpFrozen = holding.qty; // clamp
      }
    } else {
      if (holding) {
        const q = Math.min(pending.qty, holding.qty);
        if (q > 1e-12) {
          const ex = feeSell(q, bar.open);
          cash += ex.proceeds;
          recordSell(q, bar.ts, i, ex);
        }
      }
    }
    pending = null;
  }
  // 2) ctx.position 快照
  const pos = holding ? {
    qty: holding.qty, avg_cost: holding.costBasis / holding.qty,
    entry_ts: holding.entryTs, bars_since_entry: i - holding.entryBar,
    unrealized_pnl: holding.qty * bar.close - holding.costBasis
  } : null;
  // 3) 评分
  const ctxObj = {
    index: i, params: null, bar,
    indicators: makeIndicators(i),
    position: pos, log: () => {}
  };
  let wsum = 0, wssum = 0;
  for (const s of slots) {
    ctxObj.params = s.params;
    let sc = 50;
    try {
      const r = s.on_bar(ctxObj);
      if (typeof r === "number" && isFinite(r)) sc = Math.min(100, Math.max(0, r));
    } catch (e) { sc = 50; }
    wsum += s.weight; wssum += s.weight * sc;
  }
  const agg = wsum > 0 ? wssum / wsum : 50;
  const signal = agg >= BUY_THR ? "buy" : (agg <= SELL_THR ? "sell" : "hold");
  // 4) LumpSum 目标（冻结口径）
  const curQty = holding ? holding.qty : 0;
  const equity = cash + curQty * bar.close;
  let target;
  if (signal === "buy") {
    if (lumpFrozen === null) lumpFrozen = equity * 1.0 / bar.close;
    target = lumpFrozen;
  } else if (signal === "sell") { lumpFrozen = null; target = 0; }
  else { lumpFrozen = null; target = curQty; }
  const delta = target - curQty;
  if (delta > 1e-9) pending = { side: "buy", qty: delta };
  else if (delta < -1e-9) pending = { side: "sell", qty: -delta };
  // 5) nav
  nav.push([bar.ts, cash + (holding ? holding.qty : 0) * bar.close]);
}

function recordSell(q, ts, i, ex) {
  if (q >= holding.qty - 1e-12) {
    trades.push({
      open_ts: holding.entryTs, close_ts: ts, open_bar: holding.entryBar, close_bar: i,
      open_price: holding.valueBasis / holding.qty, close_price: ex.eff,
      shares: holding.qty, gross_value: ex.value,
      commission: (holding.costBasis - holding.valueBasis) + ex.comm,
      stamp_duty: ex.stamp, pnl: ex.proceeds - holding.costBasis,
      hold_bars: i - holding.entryBar
    });
    holding = null;
  } else {
    const frac = q / holding.qty;
    holding.costBasis *= (1 - frac);
    holding.valueBasis *= (1 - frac);
    holding.qty -= q;
  }
}

// 期末强平（最后 close）
if (holding) {
  const ex = feeSell(holding.qty, bars[N - 1].close);
  cash += ex.proceeds;
  recordSell(holding.qty, bars[N - 1].ts, N - 1, ex);
  nav[N - 1][1] = cash;
}

// ── 指标（复刻 metrics.rs）──
const eq = nav.map(x => x[1]);
const finalEq = eq[eq.length - 1];
let peak = -Infinity, mdd = 0;
for (const e of eq) { peak = Math.max(peak, e); if (peak > 0) mdd = Math.max(mdd, (peak - e) / peak); }
const rets = [];
for (let i = 1; i < eq.length; i++) rets.push((eq[i] - eq[i - 1]) / eq[i - 1]);
const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
const avgW = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
const avgL = losses.length ? -losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
const metrics = {
  net_profit: finalEq - CAP0,
  max_drawdown: mdd,
  sharpe: sd > 0 ? mean / sd * Math.sqrt(BARS_PER_YEAR) : 0,
  win_rate: trades.length ? wins.length / trades.length : 0,
  profit_factor: avgL > 0 ? avgW / avgL : (avgW > 0 ? Infinity : 0),
  annualized_return: eq.length > 0 && CAP0 > 0 ? Math.pow(finalEq / CAP0, BARS_PER_YEAR / eq.length) - 1 : 0,
  trade_count: trades.length,
  avg_hold_bars: trades.length ? trades.reduce((a, t) => a + t.hold_bars, 0) / trades.length : 0
};

const out = { metrics, trades };
if (job.keep_nav) out.net_value = nav;
console.log(JSON.stringify(out));
