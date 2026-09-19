#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Y1 独立重算：完全脱离 engine.rs，用「原始 K 线 + 成交流水 + 费用公式」重建现金流账，
再按 backtest/src/metrics.rs 的公开口径（以 file:line 记录）重算 8 项绩效，
与 strategy_run_result.metrics 逐字段对比。

输入（全部来自库内只读导出）：
  04_fills_payload.json     strategy_run_bars.kind='fills'    （43 笔）
  05_per_bar_payload.json   strategy_run_bars.kind='per_bar'  （423 根，含 warmup 标记）
  06_net_value_payload.json strategy_run_bars.kind='net_value'（173 点）
  07_drawdown_payload.json  strategy_run_bars.kind='drawdown' （173 点）
  02_metrics_raw.json       strategy_run_result.metrics
  10_d1_all_bars.txt        kline_accurate_1d ∪ kline_1d（OHLC 原始来源；与 storage/src/backtest.rs
                            range_sql() 同口径，即引擎真正喂入的 bar）

输出：stdout（同时被 21_recompute_output.txt 保存）
"""
import json
import math
import sys

E = "/home/eestock/workspace/git/eestock/eestock-rs/coder/evidence/20260918_sr_trades_system_side/raw/"

INITIAL = 100000.0
COMMISSION_RATE_PCT = 0.025      # run config fee.rate_pct
MIN_COMMISSION = 5.0             # run config fee.min_fee
STAMP_DUTY_PCT = 0.0             # run config fee.stamp_duty_pct
SLIPPAGE_BP = 2.0                # run config fee.slippage_bp
BARS_PER_YEAR = 252.0            # backtest/src/types.rs:76  Period::D1 => 252.0

# ── 原始费用公式（独立于 Rust 实现，按 design ADR §4 文字口径手写）─────────────
def buy_effective(px):     return px * (1.0 + SLIPPAGE_BP / 10000.0)
def sell_effective(px):    return px * (1.0 - SLIPPAGE_BP / 10000.0)
def commission(tv):        return max(tv * (COMMISSION_RATE_PCT / 100.0), MIN_COMMISSION)
def stamp(tv):             return tv * (STAMP_DUTY_PCT / 100.0)

# ── 载入 ────────────────────────────────────────────────────────────────────
per_bar = json.load(open(E + "05_per_bar_payload.json"))
fills = json.load(open(E + "04_fills_payload.json"))
net_value = json.load(open(E + "06_net_value_payload.json"))
dd_reported = json.load(open(E + "07_drawdown_payload.json"))
reported = json.load(open(E + "02_metrics_raw.json"))
trades_reported = json.load(open(E + "08_trades_raw.json"))

# 原始 K 线（ts -> (open, close)）
kl = {}
for line in open(E + "10_d1_all_bars.txt"):
    line = line.strip()
    if not line:
        continue
    p = line.split("|")
    kl[int(p[1])] = (float(p[2]), float(p[5]))   # ts, open, close

bar_ts = [b["ts"] for b in per_bar]
WARMUP = 250
ts2idx = {t: i for i, t in enumerate(bar_ts)}

# ── 检查 1：per_bar 的 ts 序列是否就是原始 K 线序列（证明喂入数据可独立取到）──
missing = [t for t in bar_ts if t not in kl]
print("[CHK-A] per_bar ts 未在 kline_accurate_1d∪kline_1d 中找到的根数 =", len(missing))
print("[CHK-A] bar 序列首/末 =", bar_ts[0], bar_ts[-1],
      " 原始表内该区间根数 =",
      sum(1 for t in kl if bar_ts[0] <= t <= bar_ts[-1]))

# ── 检查 2：fill.price 是否 = bar.open*(1±slippage)（证明成交价口径）──────────
bad_open, bad_close = [], []
for f in fills:
    op, cl = kl[bar_ts[f["bar_index"]]]
    if f["side"] == "Buy":
        if abs(buy_effective(op) - f["price"]) > 1e-9:
            bad_open.append((f["bar_index"], op, f["price"], buy_effective(op)))
    else:
        if abs(sell_effective(cl) - f["price"]) > 1e-9:
            bad_close.append((f["bar_index"], cl, f["price"], sell_effective(cl)))
print("[CHK-B1] 42 Buy: fill.price != bar.open*(1+2bp) count =", len(bad_open), bad_open[:3])
print("[CHK-B2] 1 ForceClose Sell: fill.price != bar.close*(1-2bp) count =",
      len(bad_close), bad_close[:3],
      " (bar422 open=%.6f close=%.6f => 走 close 而非 open)"
      % (kl[bar_ts[422]][0], kl[bar_ts[422]][1]))

# ── 独立现金流账 ────────────────────────────────────────────────────────────
# 逐 bar 走：本 bar 若有成交（引擎在 bar.open 成交）→ 先记账；再按本 bar close 计净值。
fills_by_bar = {}
for f in fills:
    fills_by_bar.setdefault(f["bar_index"], []).append(f)

cash = INITIAL
qty = 0.0
cost_basis = 0.0          # Σ 买入 total_cost（含买入佣金）
value_basis = 0.0         # Σ 买入成交额（不含佣金）
buy_commission_sum = 0.0
entry_bar = None
entry_ts = None
my_trades = []
my_nav = []
fill_ledger = []

for i, t in enumerate(bar_ts):
    if i < WARMUP:
        assert i not in fills_by_bar, "warmup 段不应有成交"
        continue
    open_px, close_px = kl[t]
    for f in fills_by_bar.get(i, []):
        tv = f["qty"] * f["price"]
        c = commission(tv)
        if f["side"] == "Buy":
            total_cost = tv + c
            cash -= total_cost
            if qty == 0.0:
                entry_bar, entry_ts = i, t
            qty += f["qty"]
            cost_basis += total_cost
            value_basis += tv
            buy_commission_sum += c
            fill_ledger.append(dict(bar=i, side="Buy", qty=f["qty"], px=f["price"],
                                    tv=tv, comm=c, cost=total_cost, cash=cash, pos=qty))
        else:  # Sell
            st = stamp(tv)
            proceeds = tv - c - st
            cash += proceeds
            if f["qty"] >= qty - 1e-9:      # 清仓 → 合成一笔 TradeDetail
                my_trades.append(dict(
                    open_ts=entry_ts, close_ts=t, open_bar=entry_bar, close_bar=i,
                    open_price=value_basis / qty, close_price=f["price"], shares=qty,
                    gross_value=tv, commission=buy_commission_sum + c, stamp_duty=st,
                    pnl=proceeds - cost_basis, hold_bars=i - entry_bar, reason=f["reason"]))
                qty = 0.0
                cost_basis = 0.0
                value_basis = 0.0
                buy_commission_sum = 0.0
                entry_bar = entry_ts = None
            else:                            # 部分卖出按比例摊薄
                r = f["qty"] / qty
                cost_basis *= 1 - r
                value_basis *= 1 - r
                buy_commission_sum *= 1 - r
                qty -= f["qty"]
            fill_ledger.append(dict(bar=i, side="Sell", qty=f["qty"], px=f["price"],
                                    tv=tv, comm=c, stamp=st, proceeds=proceeds,
                                    cash=cash, pos=qty))
    my_nav.append((t, cash + qty * close_px))

# 期末强平（引擎 finish() engine.rs:478 用最后 bar close 卖出）
if qty > 0:
    close_px = kl[bar_ts[-1]][1]
    px = sell_effective(close_px)
    tv = qty * px
    c = commission(tv)
    st = stamp(tv)
    proceeds = tv - c - st
    cash += proceeds
    my_trades.append(dict(open_ts=entry_ts, close_ts=bar_ts[-1], open_bar=entry_bar,
                          close_bar=len(bar_ts) - 1, open_price=value_basis / qty,
                          close_price=px, shares=qty, gross_value=tv,
                          commission=buy_commission_sum + c, stamp_duty=st,
                          pnl=proceeds - cost_basis, hold_bars=len(bar_ts) - 1 - entry_bar,
                          reason="ForceClose"))
    qty = 0.0
    my_nav[-1] = (bar_ts[-1], cash)

print("\n[LEDGER] 买入笔数 =", sum(1 for x in fill_ledger if x["side"] == "Buy"),
      " 卖出笔数 =", sum(1 for x in fill_ledger if x["side"] == "Sell"))
print("[LEDGER] Σ买入成交额 = %.6f  Σ买入佣金 = %.6f  期末现金 = %.6f"
      % (sum(x["tv"] for x in fill_ledger if x["side"] == "Buy"),
         sum(x["comm"] for x in fill_ledger if x["side"] == "Buy"), cash))
print("[LEDGER] 重算期末权益 = %.12f  系统 net_value[-1] = %.12f  差 = %.3e"
      % (cash, net_value[-1][1], cash - net_value[-1][1]))

# ── 检查 3：逐 bar 净值序列对比（173 点全量）─────────────────────────────────
maxdiff = 0.0
worst = None
for k in range(len(net_value)):
    d = abs(my_nav[k][1] - net_value[k][1])
    if d > maxdiff:
        maxdiff, worst = d, (k, my_nav[k], net_value[k])
print("[CHK-C] 173 点净值逐点最大绝对差 = %.3e  最差点 = %s" % (maxdiff, worst))
print("[CHK-C] 我的净值序列点数 =", len(my_nav), " 系统 =", len(net_value))

# ── 按 backtest/src/metrics.rs 口径重算 8 项 ────────────────────────────────
equity = [e for _, e in my_nav]
n = len(equity)
final_equity = equity[-1]
net_profit = final_equity - INITIAL                                   # metrics.rs:44

peak = -math.inf
maxdd = 0.0                                                          # metrics.rs:142-152
for e in equity:
    peak = max(peak, e)
    if peak > 0:
        maxdd = max(maxdd, (peak - e) / peak)

rets = [(equity[i + 1] - equity[i]) / equity[i] for i in range(n - 1)]  # metrics.rs:52-55
mean_r = sum(rets) / len(rets) if rets else 0.0                       # metrics.rs:56-60
if len(rets) > 1:                                                     # metrics.rs:61-67 ddof=1
    var = sum((r - mean_r) ** 2 for r in rets) / (len(rets) - 1)
    std_r = math.sqrt(var)
else:
    std_r = 0.0
sharpe = (mean_r - 0.0) / std_r * math.sqrt(BARS_PER_YEAR) if std_r > 0 else 0.0  # metrics.rs:68-72

closed = my_trades
wins = [t["pnl"] for t in closed if t["pnl"] > 0]                      # metrics.rs:75
losses = [abs(t["pnl"]) for t in closed if t["pnl"] < 0]               # metrics.rs:76-80
win_rate = len(wins) / len(closed) if closed else 0.0                  # metrics.rs:81-85
avg_p = sum(wins) / len(wins) if wins else 0.0
avg_l = sum(losses) / len(losses) if losses else 0.0
pf = avg_p / avg_l if avg_l > 0 else (math.inf if avg_p > 0 else 0.0)  # metrics.rs:96-102
ann = (final_equity / INITIAL) ** (BARS_PER_YEAR / n) - 1.0 if n > 0 else 0.0  # metrics.rs:104-108
trade_count = len(closed)
avg_hold = sum(t["hold_bars"] for t in closed) / len(closed) if closed else 0.0

mine = dict(net_profit=net_profit, max_drawdown=maxdd, sharpe=sharpe,
            win_rate=win_rate, profit_factor=pf, annualized_return=ann,
            trade_count=trade_count, avg_hold_bars=avg_hold)

order = ["net_profit", "max_drawdown", "sharpe", "win_rate", "profit_factor",
         "annualized_return", "trade_count", "avg_hold_bars"]
print("\n=== Y1 字段级差值表（独立重算 vs strategy_run_result.metrics）===")
print("%-20s %-26s %-26s %-12s %s" % ("field", "independent_recompute", "system_metrics", "delta", "verdict"))
for k in order:
    a, b = mine[k], reported[k]
    d = a - b
    ok = "IDENTICAL" if abs(d) <= 1e-9 else ("CLOSE" if abs(d) <= 1e-6 else "*** MISMATCH ***")
    print("%-20s %-26.12f %-26.12f %-12.3e %s" % (k, a, b, d, ok))

print("\n=== 中间量（供口径讨论）===")
print("nav 点数 n =", n, " returns 数 =", len(rets))
print("mean_period_return = %.12e  std_period_return(ddof=1) = %.12e" % (mean_r, std_r))
print("非零收益 bars =", sum(1 for r in rets if r != 0.0), " 零收益 bars =", sum(1 for r in rets if r == 0.0))
print("期末权益 = %.6f  初始 = %.1f  净利 = %.6f" % (final_equity, INITIAL, net_profit))
print("买入总额(成交额) = %.6f  买入佣金合计 = %.6f"
      % (sum(x["tv"] for x in fill_ledger if x["side"] == "Buy"),
         sum(x["comm"] for x in fill_ledger if x["side"] == "Buy")))
print("期末强平：成交额/佣金/印花/净得 见下")
print(json.dumps([x for x in fill_ledger if x["side"] == "Sell"], ensure_ascii=False))

print("\n=== 我的 TradeDetail（1 笔）vs 系统 trades ===")
for t in my_trades:
    print(json.dumps(t, ensure_ascii=False, indent=1))
print("系统 trades =", json.dumps(trades_reported, ensure_ascii=False))

print("\n=== 回撤序列对比 ===")
mydd = []
pk = -math.inf
for _, e in my_nav:
    pk = max(pk, e)
    mydd.append((pk - e) / pk if e > 0 else 0.0)
print("max |my_dd - reported_dd| =", max(abs(mydd[i] - dd_reported[i][1]) for i in range(len(mydd))))

# ── 口径变体（用于判断「数值算错」还是「定义如此但口径对外不成立」）─────────
print("\n=== 口径变体（系统口径 vs 若干替代口径）===")
# V1: sharpe 只用「有仓位」的 bar（剔除建仓前的平坦现金段）
first_fill_idx = min(f["bar_index"] for f in fills) - WARMUP
e2 = equity[first_fill_idx - 1:]          # 从首次成交前一 bar 起算
r2 = [(e2[i + 1] - e2[i]) / e2[i] for i in range(len(e2) - 1)]
m2 = sum(r2) / len(r2)
s2 = math.sqrt(sum((x - m2) ** 2 for x in r2) / (len(r2) - 1))
print("V1 sharpe(仅持仓段, 起始 index=%d, %d 点) = %.6f  (系统全段 = %.6f)"
      % (first_fill_idx - 1, len(e2), m2 / s2 * math.sqrt(BARS_PER_YEAR), sharpe))
# V2: 年化用实际投入资本（Σ买入 total_cost）做基准
invested = sum(x["cost"] for x in fill_ledger if x["side"] == "Buy")
print("V2 累计投入本金(含买入佣金) = %.6f (%.2f%% of initial)" % (invested, invested / INITIAL * 100))
print("   net_profit/initial      = %.6f%%" % (net_profit / INITIAL * 100))
print("   net_profit/invested     = %.6f%%" % (net_profit / invested * 100))
print("   annualized(基准 initial, 系统口径) = %.6f%%" % (ann * 100))
ann_inv = (1 + net_profit / invested) ** (BARS_PER_YEAR / n) - 1
print("   annualized(基准 invested, n=%d)     = %.6f%%" % (n, ann_inv * 100))
# V3: 年化分母用 returns 数（n-1）而非 nav 点数（n）
ann_n1 = (final_equity / INITIAL) ** (BARS_PER_YEAR / (n - 1)) - 1
print("V3 annualized(n-1=%d) = %.12f  vs 系统(n=%d) = %.12f  差 = %.3e"
      % (n - 1, ann_n1, n, ann, ann_n1 - ann))
# V4: 若不做期末强平（保持持仓按末 close 市值，即「未实现」口径）
last_close = kl[bar_ts[-1]][1]
tv_fc = my_trades[-1]["gross_value"]
proceeds_fc = tv_fc - commission(tv_fc) - stamp(tv_fc)
cash_before_fc = cash - proceeds_fc
mark_to_market = cash_before_fc + my_trades[-1]["shares"] * last_close
unreal_pnl = mark_to_market - INITIAL
print("\n[V4] 若不做期末强平（持仓按末 close=%.4f 市值标记）:" % last_close)
print("     期末权益(含未实现) = %.12f  净利(含未实现) = %.6f (%.6f%%)"
      % (mark_to_market, unreal_pnl, unreal_pnl / INITIAL * 100))
print("     系统强平后期末权益 = %.12f  净利(已实现)   = %.6f (%.6f%%)"
      % (net_value[-1][1], net_profit, net_profit / INITIAL * 100))
print("     强平成本(卖出佣金+滑点) = %.6f   → 让净利少 %.6f"
      % (net_profit - unreal_pnl, unreal_pnl - net_profit))
print("     两种口径下 trade_count: 强平=%d / 不强平=%d" % (len(my_trades), 0))
print("[V5] 若把期末强平从 TradeDetail 剔除: trade_count=0, win_rate=0.0/profit_factor=0.0/"
      "avg_hold_bars=0.0 全部退化（metrics.rs:81-85,96-102,111-115），净利仍 -2933.65（净值口径不变）")
