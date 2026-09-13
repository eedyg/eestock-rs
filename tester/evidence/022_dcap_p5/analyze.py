#!/usr/bin/env python3
"""P5 dcap SWEEP 分析器（SWEEP v1.0 §3 纪律）。

- 选优只在 IS（前 70%）：MAR 中位数（7 标的中位数）主排序；冻结 Top-3（规则在看 OOS 之前定死）。
- OOS 一次性裁决；全地貌披露（所有组合，不只报 Top）。
- 统计诚实性：配对符号检验（精确 binomial）+ 配对 bootstrap 中位数 CI；不把中位数差异当显著性。
- 主网格 = 三线同值 r（冻结网格）；扩展网格 = 细分 r + 三线差异化 r（探索性，不参与冻结/改选）。

用法：python3 analyze.py <grid_all.csv> [--primary]
"""
import argparse
import csv
import math
import random
import statistics as st
from collections import defaultdict

SYMS = ["510050", "510880", "512800", "512480", "513050", "518880", "159985"]
M = ["total_return", "annualized", "max_drawdown", "mar", "win_rate", "trade_count", "sharpe"]
PRIMARY = [f"r{r}|m{m}" for m in (1, 3, 5) for r in ("1.00", "1.05", "1.20")]


def load(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def num(r, k):
    v = r[k]
    if v in ("NA", "", "inf", "-inf"):
        return None
    return float(v)


def med(v):
    v = [x for x in v if x is not None]
    return st.median(v) if v else None


def q1(v):
    v = sorted(x for x in v if x is not None)
    return v[len(v) // 4] if v else None


def q3(v):
    v = sorted(x for x in v if x is not None)
    return v[(3 * len(v)) // 4] if v else None


def fmt(x, nd=4):
    if x is None:
        return "NA"
    return f"{x:.{nd}f}" if isinstance(x, float) else str(x)


def stats(rows, segment, combo):
    per = {}
    for s in SYMS:
        rs = [r for r in rows if r["segment"] == segment and r["combo_id"] == combo and r["code"] == s]
        assert len(rs) == 1, f"{combo}/{segment}/{s}: {len(rs)} 行"
        per[s] = rs[0]
    res = {"combo": combo}
    for k in M:
        vals = {s: num(per[s], k) for s in SYMS}
        res[k] = med(list(vals.values()))
        res[k + "_q1"] = q1(list(vals.values()))
        res[k + "_q3"] = q3(list(vals.values()))
        res["per_" + k] = vals
    res["n_pos"] = sum(1 for s in SYMS if (num(per[s], "total_return") or 0) > 0)
    return res


def binom_two_sided(k, n):
    if n == 0:
        return 1.0
    probs = [math.comb(n, i) * 0.5 ** n for i in range(n + 1)]
    pk = probs[k]
    return min(1.0, sum(p for p in probs if p <= pk + 1e-15))


def boot_median_ci(diffs, iters=20000, seed=20260913):
    """配对 bootstrap：对差值样本重抽样，返回 95% 中位数 CI（确定性种子）。"""
    rng = random.Random(seed)
    n = len(diffs)
    ms = []
    for _ in range(iters):
        ms.append(st.median([diffs[rng.randrange(n)] for _ in range(n)]))
    ms.sort()
    return ms[int(0.025 * iters)], ms[int(0.975 * iters)]


def spearman(xs, ys):
    def rank(v):
        s = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(s):
            j = i
            while j + 1 < len(s) and v[s[j + 1]] == v[s[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1
            for t in range(i, j + 1):
                r[s[t]] = avg
            i = j + 1
        return r
    rx, ry = rank(xs), rank(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    a = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    b = math.sqrt(sum((rx[i] - mx) ** 2 for i in range(n)) * sum((ry[i] - my) ** 2 for i in range(n)))
    return a / b if b > 0 else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--primary", action="store_true", help="只分析主网格 9 组合")
    a = ap.parse_args()
    rows = load(a.csv)
    combos = sorted({r["combo_id"] for r in rows if r["kind"] == "dcap"})
    if a.primary:
        combos = [c for c in combos if c in PRIMARY]
    m_of = {c: int(c.split("|m")[1]) for c in combos}
    bh_table = {m: stats(rows, "OOS", f"BUYHOLD_m{m}") for m in (1, 3, 5)}
    bh_is = {m: stats(rows, "IS", f"BUYHOLD_m{m}") for m in (1, 3, 5)}
    b2c_oos = stats(rows, "OOS", "B2C_close_to_close")
    b2c_is = stats(rows, "IS", "B2C_close_to_close")

    ISt = {c: stats(rows, "IS", c) for c in combos}
    OOSt = {c: stats(rows, "OOS", c) for c in combos}

    print("=" * 104)
    print(f"P5 dcap 有效性 SWEEP — csv={a.csv}；组合数={len(combos)}；标的={len(SYMS)}")
    print("=" * 104)

    print("\n[1] 基准（7 标的中位数，同段同费率，含费）")
    for m in (1, 3, 5):
        print(f"  BUYHOLD_m{m}: IS ret {fmt(bh_is[m]['total_return'])} MAR {fmt(bh_is[m]['mar'])} | "
              f"OOS ret {fmt(bh_table[m]['total_return'])} MAR {fmt(bh_table[m]['mar'])} "
              f"mdd {fmt(bh_table[m]['max_drawdown'])}")
    print(f"  B2C（无费收盘比）: IS 中位 {fmt(b2c_is['total_return'])} | OOS 中位 {fmt(b2c_oos['total_return'])}")
    print("  逐标的 OOS 买入持有: " + "  ".join(f"{s}={fmt(bh_table[3]['per_total_return'][s],3)}" for s in SYMS))

    # ── IS 全地貌（冻结依据）──
    rank_metric = "mar"
    is_rank = sorted(combos, key=lambda c: ISt[c][rank_metric] or -9e9, reverse=True)
    print(f"\n[2] IS 全地貌（{len(combos)} 组合，按 IS MAR 中位数降序）")
    print(f"  {'combo':26}{'IS_MAR':>9}{'IS_ret':>9}{'IS_ann':>9}{'IS_mdd':>9}{'win':>7}{'trades':>8}{'n>0':>5}{'vsBH':>10}")
    for c in is_rank:
        m = m_of[c]
        print(f"  {c:26}{fmt(ISt[c][rank_metric]):>9}{fmt(ISt[c]['total_return']):>9}{fmt(ISt[c]['annualized']):>9}"
              f"{fmt(ISt[c]['max_drawdown']):>9}{fmt(ISt[c]['win_rate']):>7}{fmt(ISt[c]['trade_count'],1):>8}"
              f"{ISt[c]['n_pos']:>5}{fmt(ISt[c]['total_return'] - bh_is[m]['total_return']):>10}")

    top = [c for c in is_rank if c in PRIMARY][:3]
    print(f"\n[3] 冻结规则（OOS 前定死）：主网格 IS MAR 中位数降序 Top-3 = {top}")

    print("\n[4] OOS 一次性裁决（全地貌，不只报 Top；vsBH = 同 warmup 买入持有对齐）")
    oos_rank = sorted(combos, key=lambda c: OOSt[c][rank_metric] or -9e9, reverse=True)
    print(f"  {'combo':26}{'IS_MAR':>9}{'OOS_MAR':>9}{'OOS_ret':>9}{'(Q1..Q3)':>21}{'OOS_ann':>9}{'OOS_mdd':>9}"
          f"{'win':>7}{'OOS_tc':>8}{'n>0':>5}{'vsBH':>9}")
    out_rows = []
    for c in oos_rank:
        m = m_of[c]
        o = OOSt[c]
        ex = o["total_return"] - bh_table[m]["total_return"]
        tag = "*" if c in top else ""
        print(f"  {c:26}{fmt(ISt[c][rank_metric]):>9}{fmt(o[rank_metric]):>9}{fmt(o['total_return']):>9}"
              f"{('(' + fmt(o['total_return_q1'],3) + '..' + fmt(o['total_return_q3'],3) + ')').rjust(21)}"
              f"{fmt(o['annualized']):>9}{fmt(o['max_drawdown']):>9}{fmt(o['win_rate']):>7}"
              f"{fmt(o['trade_count'],1):>8}{o['n_pos']:>5}{fmt(ex):>9}{tag}")
        out_rows.append({
            "combo": c, "frozen_top3": c in top, "m": m,
            "is_mar_med": ISt[c][rank_metric], "is_ret_med": ISt[c]["total_return"],
            "is_ann_med": ISt[c]["annualized"], "is_mdd_med": ISt[c]["max_drawdown"],
            "is_win_med": ISt[c]["win_rate"], "is_trades_med": ISt[c]["trade_count"], "is_n_pos": ISt[c]["n_pos"],
            "oos_mar_med": o[rank_metric], "oos_ret_med": o["total_return"], "oos_ret_q1": o["total_return_q1"],
            "oos_ret_q3": o["total_return_q3"], "oos_ann_med": o["annualized"], "oos_mdd_med": o["max_drawdown"],
            "oos_win_med": o["win_rate"], "oos_trades_med": o["trade_count"], "oos_n_pos": o["n_pos"],
            "oos_mar_delta": (o[rank_metric] - ISt[c][rank_metric]) if ISt[c][rank_metric] is not None else None,
            "oos_ret_delta": o["total_return"] - ISt[c]["total_return"],
            "bh_ret_med": bh_table[m]["total_return"], "vs_buyhold_med": ex,
        })
    with open("/tmp/dcap_p5_out/summary_by_combo.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
        w.writeheader()
        w.writerows(out_rows)

    print("\n[5] IS→OOS 衰减（中位数差；负 = OOS 更差）")
    for c in is_rank:
        dec = None if ISt[c][rank_metric] is None or OOSt[c][rank_metric] is None else OOSt[c][rank_metric] - ISt[c][rank_metric]
        print(f"  {c:26} MAR {fmt(ISt[c][rank_metric])} → {fmt(OOSt[c][rank_metric])} (Δ {fmt(dec)})  "
              f"ret {fmt(ISt[c]['total_return'])} → {fmt(OOSt[c]['total_return'])} "
              f"(Δ {fmt(OOSt[c]['total_return'] - ISt[c]['total_return'])})")
    xs = [ISt[c][rank_metric] for c in combos]
    ys = [OOSt[c][rank_metric] for c in combos]
    print(f"  IS×OOS MAR 中位数 Spearman ρ = {fmt(spearman(xs, ys),3)}（{len(combos)} 组合；"
          f"ρ≈0 或负 ⇒ IS 排序不可外推）")

    # ── r 维度（核心问题）──
    print("\n[6] 核心问题：r ≠ 1 是否带来 r = 1 之外的增量（同 m 同标的配对）")
    pooled = defaultdict(list)
    for seg, tab in (("IS", ISt), ("OOS", OOSt)):
        print(f"  -- {seg} --")
        for m in (1, 3, 5):
            base = f"r1.00|m{m}"
            line = f"    m={m}: r=1.00 {fmt(tab[base]['total_return'])} | "
            for c in [x for x in combos if m_of[x] == m and x != base]:
                d = [tab[c]["per_total_return"][s] - tab[base]["per_total_return"][s] for s in SYMS]
                wins = sum(1 for x in d if x > 0)
                neg = sum(1 for x in d if x < 0)
                line += f"{c.split('|')[0]} {fmt(tab[c]['total_return'])} ({wins}胜/{neg}负) | "
                pooled[(seg, c.split("|")[0])] += d
            print(line.rstrip(" |"))
        print("    合并 3 个 m（21 配对）:")
        for k in sorted({x.split("|")[0] for x in combos} - {"r1.00"}):
            d = pooled[(seg, k)]
            wins = sum(1 for x in d if x > 0)
            neg = sum(1 for x in d if x < 0)
            lo, hi = boot_median_ci(d)
            print(f"      {k:28} Δ中位 {fmt(med(d))}  [{fmt(lo)},{fmt(hi)}]  {wins}胜/{neg}负  "
                  f"sign-test p={fmt(binom_two_sided(wins, wins + neg),3)}")

    print("\n[7] m 维度边际（同 r 配置）")
    for base_r in sorted({x.split("|")[0] for x in combos}):
        line = f"  {base_r:28}: "
        for m in (1, 3, 5):
            c = f"{base_r}|m{m}"
            line += f"m={m} IS {fmt(ISt[c]['total_return'])}/OOS {fmt(OOSt[c]['total_return'])} "
            line += f"(tc {fmt(OOSt[c]['trade_count'],0)}) | "
        print(line.rstrip(" |"))

    # ── 逐标的 OOS ──
    show = list(dict.fromkeys(top + [oos_rank[0], "r1.00|m5"]))
    print(f"\n[8] 逐标的 OOS total_return（冻结 Top-3 + OOS 最优 {oos_rank[0]} + r1.00|m5 + 买入持有）")
    print("  " + "symbol".ljust(9) + "".join(c.ljust(14) for c in show) + "BUYHOLD")
    for s in SYMS:
        line = "  " + s.ljust(9)
        for c in show:
            line += fmt(OOSt[c]["per_total_return"][s], 3).ljust(14)
        line += fmt(bh_table[m_of[show[-1]]]["per_total_return"][s], 3)
        print(line)

    # ── 无预热敏感性 ──
    nw = [r for r in rows if r["segment"] == "OOS_nowarmup"]
    if nw:
        nws = {c: stats(rows, "OOS_nowarmup", c) for c in combos}
        print("\n[9] 敏感性：OOS 无预热（同 bars，warmup=0；插件数据不足自然中立 50 → 期初不交易）")
        print(f"  {'combo':26}{'OOS_ret(预热)':>15}{'OOS_ret(无预热)':>16}{'OOS_tc(预热)':>13}{'OOS_tc(无预热)':>15}")
        for c in oos_rank:
            print(f"  {c:26}{fmt(OOSt[c]['total_return']):>15}{fmt(nws[c]['total_return']):>16}"
                  f"{fmt(OOSt[c]['trade_count'],1):>13}{fmt(nws[c]['trade_count'],1):>15}")

    print("\n[out] /tmp/dcap_p5_out/summary_by_combo.csv")


if __name__ == "__main__":
    main()
