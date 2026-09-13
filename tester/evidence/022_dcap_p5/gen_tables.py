#!/usr/bin/env python3
"""生成报告用 markdown 表格（从 grid CSV 派生，确定性）。"""
import csv
import statistics as st
from collections import defaultdict

SYMS = ["510050", "510880", "512800", "512480", "513050", "518880", "159985"]
PRIMARY = [f"r{r}|m{m}" for m in (1, 3, 5) for r in ("1.00", "1.05", "1.20")]


def load(p):
    with open(p, newline="") as f:
        return list(csv.DictReader(f))


def num(r, k):
    v = r[k]
    return None if v in ("NA", "", "inf", "-inf") else float(v)


def med(v):
    v = [x for x in v if x is not None]
    return st.median(v) if v else None


def pick(rows, seg, combo, sym):
    rs = [r for r in rows if r["segment"] == seg and r["combo_id"] == combo and r["code"] == sym]
    return rs[0]


def agg(rows, seg, combo, k):
    return med([num(pick(rows, seg, combo, s), k) for s in SYMS])


def pct(x, nd=1):
    return "NA" if x is None else f"{100*x:.{nd}f}%"


def f(x, nd=4):
    return "NA" if x is None else f"{x:.{nd}f}"


def mar(rows, seg, combo):
    return med([num(pick(rows, seg, combo, s), "mar") for s in SYMS])


out = []
prim = load("/tmp/dcap_p5_out/grid_all_run1.csv")
ext = load("/tmp/dcap_p5_out/grid_ext_run1.csv")
nowarm = load("/tmp/dcap_p5_out/grid_all_nowarmup.csv")

# ── 基准 ──
out.append("### A. 基准（7 标的中位数；同段、同费率、同 warmup；含费）\n")
out.append("| 基准 | IS 区间收益 | IS MAR | IS 最大回撤 | OOS 区间收益 | OOS 年化 | OOS MAR | OOS 最大回撤 |")
out.append("|---|---|---|---|---|---|---|---|")
for m in (1, 3, 5):
    c = f"BUYHOLD_m{m}"
    out.append(f"| 买入持有（LumpSum 1.0，预热 {60+m-1}） | {pct(agg(prim,'IS',c,'total_return'))} | "
               f"{f(mar(prim,'IS',c))} | {pct(agg(prim,'IS',c,'max_drawdown'))} | "
               f"{pct(agg(prim,'OOS',c,'total_return'))} | {pct(agg(prim,'OOS',c,'annualized'))} | "
               f"{f(mar(prim,'OOS',c))} | {pct(agg(prim,'OOS',c,'max_drawdown'))} |")
out.append(f"| 收盘比（无费，参考） | {pct(agg(prim,'IS','B2C_close_to_close','total_return'))} | — | — | "
           f"{pct(agg(prim,'OOS','B2C_close_to_close','total_return'))} | — | — | — |")

# ── IS 全地貌 ──
is_rank = sorted(PRIMARY, key=lambda c: mar(prim, "IS", c), reverse=True)
top = is_rank[:3]
out.append("\n### B. 主网格 IS 全地貌（9 组合，按 IS MAR 中位数降序；冻结依据）\n")
out.append("| 组合（r\\|m） | IS 区间收益 | IS 年化 | IS MAR | IS 回撤 | IS 胜率 | IS 交易数 | 正收益标的 | 相对买入持有 |")
out.append("|---|---|---|---|---|---|---|---|---|")
for c in is_rank:
    m = int(c.split("m")[1])
    c_e = c.replace("|", "\\|")
    out.append(f"| {c_e} | {pct(agg(prim,'IS',c,'total_return'))} | {pct(agg(prim,'IS',c,'annualized'))} | "
               f"{f(mar(prim,'IS',c))} | {pct(agg(prim,'IS',c,'max_drawdown'))} | {pct(agg(prim,'IS',c,'win_rate'))} | "
               f"{agg(prim,'IS',c,'trade_count'):.0f} | "
               f"{sum(1 for s in SYMS if num(pick(prim,'IS',c,s),'total_return')>0)}/7 | "
               f"{pct(agg(prim,'IS',c,'total_return')-agg(prim,'IS',f'BUYHOLD_m{m}','total_return'))} |")

# ── OOS 全地貌 ──
oos_rank = sorted(PRIMARY, key=lambda c: mar(prim, "OOS", c), reverse=True)
out.append("\n### C. 主网格 OOS 全地貌（9 组合，一次性裁决；★ = IS 冻结 Top-3）\n")
out.append("| 组合 | 冻结 | OOS 区间收益 | OOS 年化 | OOS MAR | OOS 回撤 | OOS 胜率 | OOS 交易数 | 正收益标的 | 相对买入持有 |")
out.append("|---|---|---|---|---|---|---|---|---|---|")
for c in oos_rank:
    m = int(c.split("m")[1])
    c_e = c.replace("|", "\\|")
    out.append(f"| {c_e} | {'★' if c in top else '—'} | {pct(agg(prim,'OOS',c,'total_return'))} | "
               f"{pct(agg(prim,'OOS',c,'annualized'))} | {f(mar(prim,'OOS',c))} | "
               f"{pct(agg(prim,'OOS',c,'max_drawdown'))} | {pct(agg(prim,'OOS',c,'win_rate'))} | "
               f"{agg(prim,'OOS',c,'trade_count'):.0f} | "
               f"{sum(1 for s in SYMS if num(pick(prim,'OOS',c,s),'total_return')>0)}/7 | "
               f"{pct(agg(prim,'OOS',c,'total_return')-agg(prim,'OOS',f'BUYHOLD_m{m}','total_return'))} |")

# ── 衰减 ──
out.append("\n### D. IS → OOS 衰减（主网格，中位数差）\n")
out.append("| 组合 | IS MAR | OOS MAR | ΔMAR | IS 收益 | OOS 收益 | Δ收益 |")
out.append("|---|---|---|---|---|---|---|")
for c in is_rank:
    c_e = c.replace("|", "\\|")
    out.append(f"| {c_e} | {f(mar(prim,'IS',c))} | {f(mar(prim,'OOS',c))} | {f(mar(prim,'OOS',c)-mar(prim,'IS',c))} | "
               f"{pct(agg(prim,'IS',c,'total_return'))} | {pct(agg(prim,'OOS',c,'total_return'))} | "
               f"{pct(agg(prim,'OOS',c,'total_return')-agg(prim,'IS',c,'total_return'))} |")

# ── r 增量（扩展网格）──
cfg_ids = []
for c in [r["combo_id"] for r in ext if r["kind"] == "dcap"]:
    if c not in cfg_ids:
        cfg_ids.append(c)
base_cfgs = sorted({c.split("|")[0] for c in cfg_ids} - {"r1.00"})
out.append("\n### E. r 增量（扩展网格；每格 = 同 m 同标的与 `r1.00|m{m}` 配对，21 配对；"
           "Δ = 组合 − r=1）\n")
out.append("| r 配置 | IS Δ中位 | IS 胜/负 | OOS Δ中位 | OOS 胜/负 | OOS 95% CI（配对 bootstrap） | OOS sign-test p |")
out.append("|---|---|---|---|---|---|---|")
import math

def binom(k, n):
    probs = [math.comb(n, i) * 0.5 ** n for i in range(n + 1)]
    return min(1.0, sum(p for p in probs if p <= probs[k] + 1e-15))

import random
def ci(d, iters=20000, seed=20260913):
    rng = random.Random(seed)
    n = len(d)
    ms = sorted(st.median([d[rng.randrange(n)] for _ in range(n)]) for _ in range(iters))
    return ms[int(0.025*iters)], ms[int(0.975*iters)]

for cfg in sorted(base_cfgs):
    cells = []
    for seg in ("IS", "OOS"):
        d = []
        for m in (1, 3, 5):
            for s in SYMS:
                d.append(num(pick(ext, seg, f"{cfg}|m{m}", s), "total_return")
                         - num(pick(ext, seg, f"r1.00|m{m}", s), "total_return"))
        cells.append(d)
    di, do = cells
    wi = sum(1 for x in di if x > 0); ni = sum(1 for x in di if x < 0)
    wo = sum(1 for x in do if x > 0); no_ = sum(1 for x in do if x < 0)
    lo, hi = ci(do)
    out.append(f"| {cfg} | {pct(med(di))} | {wi}/{ni} | {pct(med(do))} | {wo}/{no_} | "
               f"[{pct(lo)}, {pct(hi)}] | {binom(wo, wo+no_):.3f} |")
out.append("\n> 注：α=0.05 单次检验；10 个 r 配置并行比较 ⇒ Bonferroni 阈值 α=0.005。"
           "上表无一达到 0.005，且 OOS 正号仅出现在 r<1（下偏权）。")

# ── 逐标的 OOS ──
out.append("\n### F. 逐标的 OOS 区间收益（主网格 9 组合 + 买入持有；★ = 冻结 Top-3）\n")
out.append("| 标的 | " + " | ".join(("★" if c in top else "") + c.replace("|", "\\|") for c in PRIMARY) + " | 买入持有 |")
out.append("|---" * (len(PRIMARY) + 2) + "|")
for s in SYMS:
    out.append(f"| {s} | " + " | ".join(pct(num(pick(prim,'OOS',c,s),'total_return'),1) for c in PRIMARY)
               + f" | {pct(num(pick(prim,'OOS','BUYHOLD_m3',s),'total_return'),1)} |")

out.append("\n### G. 逐标的 OOS 最大回撤（主网格 9 组合 + 买入持有）\n")
out.append("| 标的 | " + " | ".join(c.replace("|", "\\|") for c in PRIMARY) + " | 买入持有 |")
out.append("|---" * (len(PRIMARY) + 2) + "|")
for s in SYMS:
    out.append(f"| {s} | " + " | ".join(pct(num(pick(prim,'OOS',c,s),'max_drawdown'),1) for c in PRIMARY)
               + f" | {pct(num(pick(prim,'OOS','BUYHOLD_m3',s),'max_drawdown'),1)} |")

# ── 无预热敏感性 ──
out.append("\n### H. 敏感性：OOS 预热口径（生产 warmup vs warmup=0；主网格）\n")
out.append("| 组合 | OOS 收益（预热） | OOS 收益（无预热） | OOS 交易数（预热/无预热） |")
out.append("|---|---|---|---|")
for c in oos_rank:
    a = agg(prim, "OOS", c, "total_return")
    b = med([num(pick(nowarm, "OOS_nowarmup", c, s), "total_return") for s in SYMS])
    ta = agg(prim, "OOS", c, "trade_count"); tb = med([num(pick(nowarm, "OOS_nowarmup", c, s), "trade_count") for s in SYMS])
    c_e = c.replace("|", "\\|")
    out.append(f"| {c_e} | {pct(a)} | {pct(b)} | {ta:.0f} / {tb:.0f} |")
out.append("\n（预热口径对结论的影响：见正文 §8「敏感性」；r 维度方向结论不随预热口径改变）")

open("/tmp/dcap_p5_out/report_tables.md", "w").write("\n".join(out) + "\n")
print("\n".join(out))
