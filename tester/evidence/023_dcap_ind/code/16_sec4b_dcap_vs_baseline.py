"""§4b dcap 自身相对经典基线的偏 IC（回答「dcap 有没有独立于 BIAS/ROC 的信息」）。

对每个 (n, h, period) 以及每条 dcap 线（r=1 / 0.5 / 1.2）：
  · A = dcap(n,r,m=3)；基线与 §4 相同：BIAS(n) = close/SMA(n)−1、ROC(h) = close[t]/close[t−h]−1（+ 对 r≠1 再加 dcap(r=1)）；
  · 正交化后与未来收益求 Spearman（偏 IC），并给多元回归的 NW t。
输出：sec4b_dcap_vs_baseline.csv、sec4b_dcap_vs_baseline.md
"""

import csv
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcap_lib as L  # noqa: E402
from sec4_incremental import zscore  # noqa: E402

OUT = "/tmp/dcap_ind_out"
H_LIST = [1, 2, 4, 8, 16, 32]


def cell(panels, n, r, h, period, use_r1_baseline):
    per = []
    for p in panels:
        T = p.closes.size
        is_mask, oos_mask = L.t_split(T)
        pmask = {"full": np.ones(T, bool), "IS": is_mask, "OOS": oos_mask}[period]
        ret = L.fwd_return(p.closes, h)
        A = zscore(p.col(n, r, 3.0))
        cols = [np.ones(T), zscore(p.closes / L.sma(p.closes, int(n)) - 1.0), zscore(L.roc(p.closes, h))]
        if use_r1_baseline:
            cols.append(zscore(p.col(n, 1.0, 3.0)))
        X = np.column_stack(cols)
        ok = pmask & np.isfinite(ret) & np.isfinite(A) & np.all(np.isfinite(X), axis=1)
        if ok.sum() < 200:
            continue
        y, a, Xb = ret[ok], A[ok], X[ok]
        beta, _, _ = L.ols(a, Xb)
        res = a - Xb @ beta
        rho, _ = L.safe_spearman_full(res, y)
        beta_f, t_f, _ = L.newey_west_t(y, np.column_stack([Xb, a]), max(h - 1, 1))
        per.append((rho, float(t_f[-1])))
    if not per:
        return None
    rhos = np.array([x[0] for x in per], float)
    ts = np.array([x[1] for x in per], float)
    ok = np.isfinite(rhos)
    return dict(K=int(ok.sum()), med=float(np.median(rhos[ok])), mean=float(rhos[ok].mean()),
                t_cross=(float(rhos[ok].mean() / rhos[ok].std(ddof=1) * np.sqrt(ok.sum()))
                         if ok.sum() > 1 and rhos[ok].std(ddof=1) > 0 else np.nan),
                p=L.t_two_sided_p(float(rhos[ok].mean() / rhos[ok].std(ddof=1) * np.sqrt(ok.sum())),
                                  max(int(ok.sum()) - 1, 1)) if ok.sum() > 1 and rhos[ok].std(ddof=1) > 0 else np.nan,
                med_t=float(np.median(ts[np.isfinite(ts)])),
                n_pos=int((rhos[ok] > 0).sum()))


def main():
    panels = L.load_all("d1", "run1")
    rows = []
    for n in [8.0, 26.0, 60.0]:
        for r in [1.0, 0.5, 1.2]:
            for h in H_LIST:
                for period in ["full", "IS", "OOS"]:
                    a = cell(panels, n, r, h, period, use_r1_baseline=(r != 1.0))
                    if a is None:
                        continue
                    rows.append(dict(n=n, r=r, h=h, period=period, baseline="BIAS+ROC" if r == 1.0 else "BIAS+ROC+dcap(r=1)", **a))
    with open(f"{OUT}/sec4b_dcap_vs_baseline.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for x in rows:
            w.writerow(x)

    lines = ["### §4b.1 dcap 正交化后的偏 IC（d1；n=26）\n"]
    hdr = ["时段", "h", "基线", "中位偏 IC", "跨 ETF t", "p", "同号标的", "中位 NW t"]
    rws = []
    for period in ["IS", "OOS"]:
        for h in H_LIST:
            for r in [1.0, 0.5, 1.2]:
                x = next(t for t in rows if t["n"] == 26.0 and t["r"] == r and t["h"] == h and t["period"] == period)
                rws.append([period, h, x["baseline"], L.fmt(x["med"], 4), L.fmt(x["t_cross"], 2),
                            f"{x['p']:.4f}" if np.isfinite(x["p"]) else "n/a",
                            f"{x['n_pos']}/{x['K']}", L.fmt(x["med_t"], 2)])
    lines.append(L.table(rws, hdr) + "\n")
    lines.append("### §4b.2 全网格（n × r × h × 时段）偏 IC 中位数\n")
    rws = []
    for x in rows:
        if x["period"] == "full":
            continue
        rws.append([f"{x['n']:g}", f"{x['r']:g}", x["h"], x["period"], L.fmt(x["med"], 4),
                    L.fmt(x["t_cross"], 2), f"{x['n_pos']}/{x['K']}"])
    lines.append(L.table(rws, ["n", "r", "h", "时段", "中位偏 IC", "跨 ETF t", "同号"]) + "\n")
    with open(f"{OUT}/sec4b_dcap_vs_baseline.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote sec4b ({len(rows)} rows)")
    sub = [x for x in rows if x["period"] == "OOS"]
    print("OOS 中位偏 IC 中位数:", float(np.nanmedian([x["med"] for x in sub])))
    print("OOS |偏 IC| 最大:", max(sub, key=lambda x: abs(x["med"])))


if __name__ == "__main__":
    main()
