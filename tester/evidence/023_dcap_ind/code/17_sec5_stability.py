"""§5 稳定性：跳标的（7 ETF）IC 符号一致性、跳时间片一致性、跳周期（日线 vs 15m）一致性。

输入：run1（+run2 用于确定性核验）；产物字节 dcap 线。
输出：sec5_stability.md、sec5_slices.csv
"""

import csv
import os
import sys
from math import comb

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcap_lib as L  # noqa: E402

OUT = "/tmp/dcap_ind_out"
H_LIST = [1, 2, 4, 8, 16, 32]
NSLICE = 5


def cell_ics(panels, n, r, m, h, period):
    out = []
    for p in panels:
        T = p.closes.size
        is_mask, oos_mask = L.t_split(T)
        mask = {"full": np.ones(T, bool), "IS": is_mask, "OOS": oos_mask}[period]
        ret = L.fwd_return(p.closes, h)
        sig = p.col(n, r, m)
        rho, nn = L.safe_spearman_full(np.where(mask, sig, np.nan), ret)
        out.append((rho, nn))
    return out


def slice_ics(panels, n, r, m, h, nslice=NSLICE):
    """每个 (标的, 时间片) 一个 IC；时间片按有效 bar 等分。"""
    ests = []
    for p in panels:
        T = p.closes.size
        ret = L.fwd_return(p.closes, h)
        sig = p.col(n, r, m)
        bounds = np.linspace(0, T, nslice + 1).astype(int)
        for k in range(nslice):
            a, b = bounds[k], bounds[k + 1]
            rho, _ = L.safe_spearman_full(sig[a:b], ret[a:b])
            if np.isfinite(rho):
                ests.append(rho)
    return ests


def main():
    freqs = sys.argv[1:] or ["d1", "m15"]
    lines = []
    slice_rows = []
    sec3 = list(csv.DictReader(open(f"{OUT}/sec3_ic_grid.csv", encoding="utf-8")))
    for x in sec3:
        for k in ("n", "r", "m", "h"):
            x[k] = float(x[k])
        for k in ("mean_ic", "t", "p", "pooled_ic", "icir"):
            x[k] = float(x[k]) if x[k] not in ("", "nan") else float("nan")
        x["ic_pos"] = int(x["ic_pos"])
        x["K"] = int(x["K"])
        x["ics_list"] = [float(v) for v in x["ics"].split(";") if v != "nan"]

    # ── 5.1 跨标的符号一致性 ────────────────────────────────────────────────
    lines.append("### §5.1 跳标的（7 ETF）IC 符号一致性\n")
    for freq in freqs:
        for period in ["IS", "OOS"]:
            sub = [x for x in sec3 if x["freq"] == freq and x["period"] == period]
            tot = len(sub)
            unan = [x for x in sub if x["ic_pos"] == x["K"]]
            agree6 = [x for x in sub if max(x["ic_pos"], x["K"] - x["ic_pos"]) == 6]
            agree5 = [x for x in sub if max(x["ic_pos"], x["K"] - x["ic_pos"]) == 5]
            lines.append(f"- **{freq} / {period}**（{tot} 个单元 = 63 组合 × 6 h）："
                         f"7/7 同号 {len(unan)}（{100*len(unan)/tot:.1f}%），6/7 同号 {len(agree6)}"
                         f"（{100*len(agree6)/tot:.1f}%），5/7 同号 {len(agree5)}（{100*len(agree5)/tot:.1f}%）"
                         f"；独立同分布零假设下 P(7/7 同号)= 2·(1/2)^7 = {200*0.5**7:.2f}%"
                         f"（**注**：7 只 ETF 同受市场因子驱动，该零假设仅为口头参照，不可当检验用）")
    unan_d1 = [x for x in sec3 if x["freq"] == "d1" and x["period"] == "OOS" and x["ic_pos"] == x["K"]]
    lines.append(f"\n- OOS 上 7/7 同号且 |平均 IC| ≥ 0.02 的单元（d1）：")
    strong = [x for x in unan_d1 if abs(x["mean_ic"]) >= 0.02]
    lines.append(f"  **{len(strong)}** 个 —— " + ("；".join(
        f"n={x['n']:g},r={x['r']:g},m={x['m']:g},h={x['h']}(IC={x['mean_ic']:+.3f})" for x in strong) or "无"))
    lines.append("")

    # ── 5.2 跨时间片一致性 ─────────────────────────────────────────────────
    lines.append("### §5.2 跳时间片一致性（每标的切 5 个等长片；估计数 = 7 标的 × 5 片 = 35）\n")
    panels = L.load_all("d1", "run1")
    hdr = ["n", "r"] + [f"h={h}" for h in H_LIST]
    for n in [8.0, 26.0, 60.0]:
        rws = []
        for r in [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]:
            row = [f"{n:g}", f"{r:g}"]
            for h in H_LIST:
                ests = slice_ics(panels, n, r, 3.0, h)
                frac_pos = float(np.mean([e > 0 for e in ests])) if ests else float("nan")
                agree = max(frac_pos, 1 - frac_pos)
                row.append(f"{agree:.2f}")
                slice_rows.append(dict(n=n, r=r, m=3.0, h=h, n_est=len(ests),
                                       frac_pos=frac_pos, agreement=agree,
                                       mean_ic=float(np.mean(ests)) if ests else float("nan")))
            rws.append(row)
        lines.append(f"*n={n:g}：时间片符号一致度（max(正号占比, 负号占比)；0.50 = 完全无一致性）*\n")
        lines.append(L.table(rws, hdr) + "\n")
    with open(f"{OUT}/sec5_slices.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(slice_rows[0].keys()))
        w.writeheader()
        for x in slice_rows:
            w.writerow(x)
    agree_all = [x["agreement"] for x in slice_rows]
    lines.append(f"- 全 63 单元 × 6 h 的时间片一致度：中位 {np.median(agree_all):.3f}，"
                 f"P25 {np.quantile(agree_all,0.25):.3f}，P75 {np.quantile(agree_all,0.75):.3f}；"
                 f"≥0.8 的单元 {sum(1 for a in agree_all if a >= 0.8)}/{len(agree_all)}；"
                 f"纯噪声预期中位 ≈ 0.5 + O(1/√35) ≈ 0.58。\n")

    if "m15" not in freqs:
        with open(f"{OUT}/sec5_stability.md", "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n\n*(5.3 跨周期一致性未覆盖：本次运行未包含 m15)*\n")
        print("wrote sec5_stability.md (no m15)")
        return

    # ── 5.3 跨周期一致性（日线 vs 15m）─────────────────────────────────────
    lines.append("### §5.3 跳周期一致性（日线 d1 vs 15m；同 (n,r,m=3,h,时段) 的 IC 符号）\n")
    hdr = ["时段", "n", "r", "h", "d1 IC", "15m IC", "同号?"]
    rws = []
    agree = tot = 0
    for period in ["IS", "OOS"]:
        for n in [8.0, 26.0, 60.0]:
            for r in [0.5, 0.85, 1.0, 1.2, 1.5, 2.0]:
                for h in H_LIST:
                    a = next(x for x in sec3 if x["freq"] == "d1" and x["n"] == n and x["r"] == r
                             and x["m"] == 3.0 and x["h"] == h and x["period"] == period)
                    b = next(x for x in sec3 if x["freq"] == "m15" and x["n"] == n and x["r"] == r
                             and x["m"] == 3.0 and x["h"] == h and x["period"] == period)
                    same = (np.sign(a["mean_ic"]) == np.sign(b["mean_ic"]))
                    tot += 1
                    agree += int(same)
                    if h in (1, 8, 32):
                        rws.append([period, f"{n:g}", f"{r:g}", h, L.fmt(a["mean_ic"], 4),
                                    L.fmt(b["mean_ic"], 4), "是" if same else "**否**"])
    lines.append(f"- 同号率：**{agree}/{tot} = {100*agree/tot:.1f}%**（独立零假设 50%）\n")
    lines.append(L.table(rws, hdr) + "\n")

    with open(f"{OUT}/sec5_stability.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print("wrote sec5_stability.md / sec5_slices.csv")
    print(f"cross-period sign agreement {agree}/{tot}")
    print(f"slice agreement median {np.median(agree_all):.3f}, >=0.8 count {sum(1 for a in agree_all if a>=0.8)}/{len(agree_all)}")


if __name__ == "__main__":
    main()
