#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Y6 资本效率口径量化：年化 / 回撤 / 夏普 的分母到底是「初始资金」还是「实际投入资本」。
输入同 20_recompute.py；额外用 kline_d1 算同区间买入持有基准。
"""
import json
import math

E = "/home/eestock/workspace/git/eestock/eestock-rs/coder/evidence/20260918_sr_trades_system_side/raw/"
INITIAL = 100000.0
BPY = 252.0
COMM = 0.00025
MINC = 5.0
SLIP = 0.0002


def feebuy(budget, px):
    eff = px * (1 + SLIP)
    sh = budget / (eff * (1 + COMM))
    tv = sh * eff
    c = max(tv * COMM, MINC)
    if c <= MINC:
        v = max(budget - MINC, 0.0)
        sh = v / eff if eff > 0 else 0.0
        return sh, v, MINC if v > 0 else 0.0
    return sh, tv, c


def feesell(sh, px):
    eff = px * (1 - SLIP)
    tv = sh * eff
    c = max(tv * COMM, MINC)
    return tv, c, tv - c


per = json.load(open(E + "05_per_bar_payload.json"))
fills = json.load(open(E + "04_fills_payload.json"))
nv = json.load(open(E + "06_net_value_payload.json"))
metrics = json.load(open(E + "02_metrics_raw.json"))
kl = {}
for line in open(E + "10_d1_all_bars.txt"):
    p = line.strip().split("|")
    if len(p) > 5:
        kl[int(p[1])] = (float(p[2]), float(p[5]))

eq = [x[1] for x in nv]
n = len(eq)
final = eq[-1]
np_ = final - INITIAL

buy_cost = sum(f["qty"] * f["price"] for f in fills if f["side"] == "Buy")
buy_comm = sum(max(f["qty"] * f["price"] * COMM, MINC) for f in fills if f["side"] == "Buy")
deployed_incl = buy_cost + buy_comm
deployed_excl = buy_cost

print("=" * 96)
print("Y6-a 投入/未投入拆分")
print("  initial_capital                 = %.2f" % INITIAL)
print("  Σ买入成交额（不含佣金）           = %.6f  (%.4f%% of initial)" % (deployed_excl, deployed_excl / INITIAL * 100))
print("  Σ买入总成本（含佣金，= 实际动用现金）= %.6f  (%.4f%% of initial)" % (deployed_incl, deployed_incl / INITIAL * 100))
print("  未投入现金（期末现金里从未动用的部分占初始）  = %.4f%%" % (100 - deployed_incl / INITIAL * 100))
print("  Σ买入佣金 = %.6f（42 笔 × 5.0 最低佣金 = 210.0 ⇒ 最低佣金全额支配）" % buy_comm)
print()
print("Y6-b 收益率分母对比（同一绝对亏损 -2933.647914）")
print("  分母 = initial 100000（系统口径）: %.6f%%" % (np_ / INITIAL * 100))
print("  分母 = 实际投入 %.2f          : %.6f%%" % (deployed_incl, np_ / deployed_incl * 100))
print("  倍率 = %.3fx" % (INITIAL / deployed_incl))

ann_init = (final / INITIAL) ** (BPY / n) - 1
ann_dep = (final / INITIAL) ** (BPY / n) - 1  # 系统口径
ann_dep2 = ((deployed_incl + np_) / deployed_incl) ** (BPY / n) - 1
print("  年化(系统, 分母 initial)  = %.6f%%   ← metrics.annualized_return" % (ann_init * 100))
print("  年化(分母 实际投入)       = %.6f%%" % (ann_dep2 * 100))
print("  差 = %.6f 个百分点" % ((ann_dep2 - ann_init) * 100))
print("  校验: metrics.annualized_return = %.12f  (重算 %.12f, 差 %.3e)"
      % (metrics["annualized_return"], ann_init, metrics["annualized_return"] - ann_init))

print()
print("Y6-c 最大回撤的分母")
peak, peak_i, trough, trough_i, maxdd = -math.inf, None, None, None, 0.0
cur_peak, cur_pi = -math.inf, 0
for i, e in enumerate(eq):
    if e > cur_peak:
        cur_peak, cur_pi = e, i
    dd = (cur_peak - e) / cur_peak
    if dd > maxdd:
        maxdd, peak, peak_i, trough, trough_i = dd, cur_peak, cur_pi, e, i
print("  峰值净值 = %.6f (nav[%d])  谷值净值 = %.6f (nav[%d])" % (peak, peak_i, trough, trough_i))
print("  绝对回撤额 = %.6f 元" % (peak - trough))
print("  max_drawdown = (peak-trough)/peak = %.12f  ← metrics.max_drawdown=%.12f" % (maxdd, metrics["max_drawdown"]))
print("  分母 = 全组合净值峰值 = %.4f（100%% 资金基准，含 58%% 从未投资的现金）" % peak)
pos_val_at_peak = None
print("  若以「届时已投入资本」为分母：谷值日已投入 ≈ %.0f 元 ⇒ 相对回撤 ≈ %.4f%%"
      % (deployed_incl, (peak - trough) / deployed_incl * 100))
print("  ⇒ 回撤同样按全资本口径，对 41.6%% 仓位的策略把风险摊薄了约 %.2fx"
      % (INITIAL / deployed_incl))

print()
print("Y6-d 夏普的采样口径")
rets = [(eq[i + 1] - eq[i]) / eq[i] for i in range(n - 1)]
zeros = [i for i, r in enumerate(rets) if r == 0.0]
print("  nav 点数 n = %d，period_returns 数 = %d" % (n, len(rets)))
print("  零收益 bar 数 = %d（下标 %s…）：建仓前（nav[0..10]）现金空转" % (len(zeros), zeros[:12]))
print("  rf = 0（metrics.rs:69 硬编码 -0.0；ADR §6 rf=0）")
print("  ddof = 1（样本标准差，metrics.rs:63）")

# 只取首笔成交之后的收益序列（剔除建仓前空转段）
first_fill = min(f["bar_index"] for f in fills) - 250
eq2 = eq[first_fill - 1:]
r2 = [(eq2[i + 1] - eq2[i]) / eq2[i] for i in range(len(eq2) - 1)]
m2 = sum(r2) / len(r2)
s2 = math.sqrt(sum((x - m2) ** 2 for x in r2) / (len(r2) - 1))
print("  夏普(全 172 个收益, 系统)          = %.6f" % metrics["sharpe"])
print("  夏普(剔除建仓前 %d 个 bar, %d 个收益) = %.6f" % (first_fill - 1, len(r2), m2 / s2 * math.sqrt(BPY)))

# 投入比例放大到 100%（把每笔买入股数按 100000/deployed 放大，现金相应减少）
scale = INITIAL / deployed_incl
cash = INITIAL
qty = 0.0
eq3_removed = None
# 直接构造：等比放大买入预算到用满 100k 后重放
cash = INITIAL
qty = 0.0
eq4 = []
fi = {}
for f in fills:
    fi.setdefault(f["bar_index"], []).append(f)
for i, b in enumerate(per):
    if b["warmup"]:
        continue
    cl = kl[b["ts"]][1]
    for f in fi.get(i, []):
        if f["side"] == "Buy":
            budget = f["qty"] * f["price"] * scale
            sh, tv, c = feebuy(budget, kl[b["ts"]][0])
            cash -= tv + c
            qty += sh
        else:
            tv, c, net = feesell(qty, cl)
            cash += net
            qty = 0.0
    eq4.append(cash + qty * cl)
np4 = eq4[-1] - INITIAL
r4 = [(eq4[i + 1] - eq4[i]) / eq4[i] for i in range(len(eq4) - 1)]
m4 = sum(r4) / len(r4)
s4 = math.sqrt(sum((x - m4) ** 2 for x in r4) / (len(r4) - 1))
pk4, mdd4 = -math.inf, 0.0
for e in eq4:
    pk4 = max(pk4, e)
    mdd4 = max(mdd4, (pk4 - e) / pk4)
print()
print("Y6-e 满仓化对照（把 42 笔买入预算按 %.4fx 放大到用满 100k，其它不变）" % scale)
print("  期末净值 = %.4f（净利 %.4f, %.4f%%）；系统口径 vs 满仓：%.4f%% vs %.4f%%"
      % (eq4[-1], np4, np4 / INITIAL * 100, np_ / INITIAL * 100, np4 / INITIAL * 100))
print("  max_drawdown = %.6f（系统 %.6f）" % (mdd4, metrics["max_drawdown"]))
print("  sharpe       = %.6f（系统 %.6f）" % (m4 / s4 * math.sqrt(BPY), metrics["sharpe"]))

print()
print("Y6-f 同区间买入持有基准（100k 在首根 in-range bar 以 open 全额买入，期末 close 卖出）")
first = next(b for b in per if not b["warmup"])
op = kl[first["ts"]][0]
sh, tv, c = feebuy(INITIAL, op)
lastcl = kl[per[-1]["ts"]][1]
tv2, c2, net = feesell(sh, lastcl)
bh_final = INITIAL - tv - c + net
bh_np = bh_final - INITIAL
print("  首 bar open = %.4f  末 bar close = %.4f  （标的自身 %.2f%%）"
      % (op, lastcl, (lastcl / op - 1) * 100))
print("  买入持有：期末权益 = %.4f  净利 = %.4f（%.4f%%）"
      % (bh_final, bh_np, bh_np / INITIAL * 100))
print("  定投 run：期末权益 = %.4f  净利 = %.4f（%.4f%%）"
      % (final, np_, np_ / INITIAL * 100))
print("  ⇒ 定投少亏 %.4f 元（%.4f%% of initial），主要来自只投了 %.2f%% 的资金"
      % (bh_np - np_, (bh_np - np_) / INITIAL * 100, deployed_incl / INITIAL * 100))
