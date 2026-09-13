#!/usr/bin/env python3
"""P5 报告自审：把报告中的关键断言逐条回算（PASS/FAIL），防止转写错误。

用法：python3 audit_report.py
"""
import csv
import math
import statistics as st
import sys

SYMS = ["510050", "510880", "512800", "512480", "513050", "518880", "159985"]
PRIMARY = [f"r{r}|m{m}" for m in (1, 3, 5) for r in ("1.00", "1.05", "1.20")]
FAILS = []


def load(p):
    return list(csv.DictReader(open(p, newline="")))


def num(r, k):
    v = r[k]
    return None if v in ("NA", "", "inf", "-inf") else float(v)


def med(rows, seg, combo, k):
    return st.median([num([r for r in rows if r["segment"] == seg and r["combo_id"] == combo and r["code"] == s][0], k)
                      for s in SYMS])


def check(name, got, want, tol=1e-6):
    ok = abs(got - want) <= tol
    print(f"{'PASS' if ok else 'FAIL'} {name}: got={got:.6f} want={want:.6f}")
    if not ok:
        FAILS.append(name)


def binom_two_sided(k, n):
    probs = [math.comb(n, i) * 0.5 ** n for i in range(n + 1)]
    return min(1.0, sum(p for p in probs if p <= probs[k] + 1e-15))


prim = load("grid_all_run1.csv")
ext = load("grid_ext_run1.csv")
nowarm = load("grid_ext_nowarmup.csv")

# 1) 冻结 Top-3
is_rank = sorted(PRIMARY, key=lambda c: med(prim, "IS", c, "mar"), reverse=True)
print(f"IS MAR 排序 = {is_rank}")
top = is_rank[:3]
ok = top == ["r1.00|m1", "r1.05|m1", "r1.20|m1"]
print(f"{'PASS' if ok else 'FAIL'} 冻结 Top-3 = {top}")
FAILS += [] if ok else ["冻结 Top-3"]

# 2) 冻结组合 OOS 中位收益/MAR
for c, want_ret, want_mar in [("r1.00|m1", 0.1171, 0.2242), ("r1.05|m1", 0.1090, 0.1819), ("r1.20|m1", 0.0870, 0.2482)]:
    check(f"{c} OOS 收益", med(prim, "OOS", c, "total_return"), want_ret, 5e-5)
    check(f"{c} OOS MAR", med(prim, "OOS", c, "mar"), want_mar, 5e-5)

# 3) 买入持有 OOS
check("BUYHOLD OOS 收益", med(prim, "OOS", "BUYHOLD_m3", "total_return"), 0.1410, 5e-5)
check("BUYHOLD OOS 回撤", med(prim, "OOS", "BUYHOLD_m3", "max_drawdown"), 0.3052, 5e-5)
check("BUYHOLD OOS MAR", med(prim, "OOS", "BUYHOLD_m3", "mar"), 0.2135, 5e-5)
check("LumpSum 全仓=恒 Buy 插件（交易数）", med(prim, "OOS", "BUYHOLD_m3", "trade_count"), 1.0)

# 4) 全地貌 OOS 最优 = r1.00|m5，IS 排名第 6
oos_rank = sorted(PRIMARY, key=lambda c: med(prim, "OOS", c, "mar"), reverse=True)
ok = oos_rank[0] == "r1.00|m5" and is_rank.index("r1.00|m5") == 5
print(f"{'PASS' if ok else 'FAIL'} OOS 最优={oos_rank[0]}（IS 排名第 {is_rank.index('r1.00|m5')+1}/9）")
FAILS += [] if ok else ["OOS 最优"]
check("r1.00|m5 OOS 收益", med(prim, "OOS", "r1.00|m5", "total_return"), 0.2319, 5e-5)
check("r1.00|m5 OOS MAR", med(prim, "OOS", "r1.00|m5", "mar"), 0.3712, 5e-5)

# 5) Spearman ρ（主网格 9）
xs = [med(prim, "IS", c, "mar") for c in PRIMARY]
ys = [med(prim, "OOS", c, "mar") for c in PRIMARY]


def rank(v):
    s = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    for pos, i in enumerate(s):
        r[i] = pos + 1
    return r


rx, ry = rank(xs), rank(ys)
n = len(xs)
mx, my = sum(rx) / n, sum(ry) / n
num_ = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
den = math.sqrt(sum((rx[i] - mx) ** 2 for i in range(n)) * sum((ry[i] - my) ** 2 for i in range(n)))
check("IS×OOS MAR Spearman ρ（主网格）", num_ / den, 0.0, 1e-9)

# 6) 配对符号检验（扩展网格，21 配对，vs 同 m 的 r1.00）
def pooled(rows, seg, cfg, field):
    d = []
    for m in (1, 3, 5):
        for s in SYMS:
            a = [r for r in rows if r["segment"] == seg and r["combo_id"] == f"{cfg}|m{m}" and r["code"] == s][0]
            b = [r for r in rows if r["segment"] == seg and r["combo_id"] == f"r1.00|m{m}" and r["code"] == s][0]
            d.append(num(a, field) - num(b, field))
    w = sum(1 for x in d if x > 0)
    l = sum(1 for x in d if x < 0)
    return st.median(d), w, l, binom_two_sided(w, w + l)


for seg, cfg, want in [("IS", "r1.05", (-0.0748, 4, 17, 0.007)), ("IS", "r1.20", (-0.0864, 5, 16, 0.027)),
                       ("OOS", "r0.90", (0.0351, 15, 6, 0.078)), ("OOS", "r0.95", (0.0219, 15, 6, 0.078)),
                       ("OOS", "r1.05", (-0.0044, 9, 12, 0.664)), ("OOS", "r1.20", (-0.0604, 7, 14, 0.189))]:
    got = pooled(ext, seg, cfg, "total_return")
    check(f"{seg} {cfg} 收益 Δ中位", got[0], want[0], 5e-5)
    ok = (got[1], got[2]) == (want[1], want[2])
    print(f"{'PASS' if ok else 'FAIL'} {seg} {cfg} 胜/负 got={got[1]}/{got[2]} want={want[1]}/{want[2]}")
    FAILS += [] if ok else [f"{seg} {cfg} 胜/负"]
    check(f"{seg} {cfg} sign-test p", got[3], want[3], 2e-3)

# 7) MAR 口径：r0.95 IS 打平、r<1 OOS 正号
for seg, cfg, want in [("IS", "r0.95", (0.0017, 11, 10)), ("OOS", "r0.90", (0.0991, 15, 6)), ("OOS", "r0.95", (0.0588, 15, 6))]:
    got = pooled(ext, seg, cfg, "mar")
    check(f"{seg} {cfg} MAR Δ中位", got[0], want[0], 5e-5)
    ok = (got[1], got[2]) == (want[1], want[2])
    print(f"{'PASS' if ok else 'FAIL'} {seg} {cfg} MAR 胜/负 got={got[1]}/{got[2]} want={want[1]}/{want[2]}")
    FAILS += [] if ok else [f"{seg} {cfg} MAR 胜/负"]

# 8) 无预热敏感性：r0.90 OOS 配对 +5.4%、16/5、p=0.027；变化范围 −5.2 ~ +5.0 pt
got = pooled(nowarm, "OOS_nowarmup", "r0.90", "total_return")
check("OOS_nowarmup r0.90 Δ中位", got[0], 0.0542, 5e-5)
ok = (got[1], got[2]) == (16, 5)
print(f"{'PASS' if ok else 'FAIL'} OOS_nowarmup r0.90 胜/负 got={got[1]}/{got[2]} want=16/5")
FAILS += [] if ok else ["OOS_nowarmup r0.90 胜/负"]
combos = sorted({r["combo_id"] for r in ext if r["kind"] == "dcap"})
ds = [med(nowarm, "OOS_nowarmup", c, "total_return") - med(ext, "OOS", c, "total_return") for c in combos]
check("预热口径差异下限(pt/100)", min(ds), -0.0515, 5e-4)
check("预热口径差异上限(pt/100)", max(ds), 0.0502, 5e-4)

# 9) 双跑确定性
import hashlib


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


for a, b in [("grid_all_run1.csv", "grid_all_run2.csv"), ("grid_ext_run1.csv", "grid_ext_run2.csv")]:
    ok = sha(a) == sha(b)
    print(f"{'PASS' if ok else 'FAIL'} 双跑 sha256 {a} == {b} ({sha(a)[:16]}…)")
    FAILS += [] if ok else [f"双跑 {a}"]

# 10) 数据完整性：无插件错误、行数正确
errs = {r["plugin_errors"] for r in prim} | {r["plugin_errors"] for r in ext}
ok = errs == {"0"}
print(f"{'PASS' if ok else 'FAIL'} plugin_errors 全为 0（无 G5 熔断）got={sorted(errs)}")
FAILS += [] if ok else ["plugin_errors"]
print(f"\n=== 自审结果：{'ALL PASS' if not FAILS else 'FAILURES: ' + ', '.join(FAILS)} ===")
sys.exit(1 if FAILS else 0)
