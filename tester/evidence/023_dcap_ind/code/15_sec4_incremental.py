"""§4 增量信息：以 r=1（DCAP）、BIAS(n)、ROC(h) 为基线，检验 dcap（尤其 r≠1）正交化后是否仍有显著偏 IC。

方法（每 ETF、每时段）：
  ① 标准化信号（z-score，单位方差）；
  ② 正交化：A_⊥ = A − P_X A，X = [1, BIAS(n), ROC(h), dcap(n,r=1,m=3)]；
  ③ 偏 IC = Spearman(A_⊥, fwd_ret_h)；偏相关 = Pearson(A_⊥, fwd_ret_h)；
  ④ 多元回归 fwd_ret_h ~ [1, BIAS, ROC, dcap_r1, A]，系数 = A 的「每 1σ 的收益增量」，
     Newey-West(Bartlett, lag = max(h−1, 1)) 稳健 t；
  ⑤ 跨 7 ETF 聚合（中位偏 IC / 跨标的中位 NW t / |t|>2 且同号标的数）；
  ⑥ 家族内 BH-FDR(q=0.05) 与 Bonferroni 惩罚（家族 = 每 freq 全部 (n,r,h,period)）。

工具：BIAS / ROC 由 closes 现算（**基线指标**，非 dcap；dcap 值一律来自产物字节）。
输出：sec4_incremental.csv、sec4_incremental.md
"""

import csv
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcap_lib as L  # noqa: E402

OUT = "/tmp/dcap_ind_out"
H_LIST = [1, 2, 4, 8, 16, 32]
R_LIST = [0.5, 0.7, 0.85, 1.2, 1.5, 2.0]
N_LIST = [8.0, 26.0, 60.0]


def zscore(v):
    v = np.asarray(v, float)
    m = np.isfinite(v)
    out = np.full(v.size, np.nan)
    if m.sum() > 2 and v[m].std(ddof=1) > 0:
        out[m] = (v[m] - v[m].mean()) / v[m].std(ddof=1)
    return out


def analyze_cell(panels, n, r, h, period, m=3.0):
    """返回逐标的明细 + 聚合结果。"""
    per = []
    for p in panels:
        T = p.closes.size
        is_mask, oos_mask = L.t_split(T)
        pmask = {"full": np.ones(T, bool), "IS": is_mask, "OOS": oos_mask}[period]
        ret = L.fwd_return(p.closes, h)
        A = zscore(p.col(n, r, m))
        B0 = zscore(p.col(n, 1.0, m))
        bias = zscore(p.closes / L.sma(p.closes, int(n)) - 1.0)
        roc_h = zscore(L.roc(p.closes, h))
        ok = pmask & np.isfinite(ret) & np.isfinite(A) & np.isfinite(B0) & np.isfinite(bias) & np.isfinite(roc_h)
        if ok.sum() < 200:
            continue
        y = ret[ok]
        a = A[ok]
        Xb = np.column_stack([np.ones(ok.sum()), bias[ok], roc_h[ok], B0[ok]])
        beta, resid, _ = L.ols(a, Xb)
        a_perp = a - Xb @ beta
        Xf = np.column_stack([Xb, a])
        beta_f, t_f, _ = L.newey_west_t(y, Xf, max(h - 1, 1))
        pr, _ = L.safe_spearman_full(a_perp, y)
        pp = L.pearson(a_perp, y)
        rho_raw, _ = L.safe_spearman_full(a, y)
        per.append(dict(etf=p.etf, n_valid=int(ok.sum()), ic_raw=rho_raw, partial_ic=pr,
                        partial_pearson=pp, coef=float(beta_f[-1]), t=float(t_f[-1])))
    if not per:
        return None, []
    pis = np.array([x["partial_ic"] for x in per], float)
    ts = np.array([x["t"] for x in per], float)
    pis_ok = pis[np.isfinite(pis)]
    ts_ok = ts[np.isfinite(ts)]
    agg = dict(
        K=len(per),
        med_partial_ic=float(np.median(pis_ok)) if pis_ok.size else np.nan,
        mean_partial_ic=float(pis_ok.mean()) if pis_ok.size else np.nan,
        std_partial_ic=float(pis_ok.std(ddof=1)) if pis_ok.size > 1 else np.nan,
        t_partial=(float(pis_ok.mean() / pis_ok.std(ddof=1) * np.sqrt(pis_ok.size))
                   if pis_ok.size > 1 and pis_ok.std(ddof=1) > 0 else np.nan),
        med_t=float(np.median(ts_ok)) if ts_ok.size else np.nan,
        n_pos_sig=int(sum(1 for x in per if np.isfinite(x["t"]) and x["t"] > 2)),
        n_neg_sig=int(sum(1 for x in per if np.isfinite(x["t"]) and x["t"] < -2)),
        coef_pos=int(sum(1 for x in per if x["coef"] > 0)),
    )
    agg["p_partial"] = L.t_two_sided_p(agg["t_partial"], max(agg["K"] - 1, 1))
    return agg, per


def main():
    rows = []
    detail = []
    for freq in ["d1"]:
        panels = L.load_all(freq, "run1")
        for n in N_LIST:
            for r in R_LIST:
                for h in H_LIST:
                    for period in ["full", "IS", "OOS"]:
                        agg, per = analyze_cell(panels, n, r, h, period)
                        if agg is None:
                            continue
                        rows.append(dict(freq=freq, n=n, r=r, h=h, period=period, **agg))
                        for x in per:
                            detail.append(dict(freq=freq, n=n, r=r, h=h, period=period, **x))

    # 多重比较
    p = np.array([x["p_partial"] for x in rows], float)
    rej, thr, _ = L.bh_fdr(p, 0.05)
    N = len(rows)
    for x, rj in zip(rows, rej):
        x["bonf_alpha"] = 0.05 / N
        x["bonf_rej"] = bool(np.isfinite(x["p_partial"]) and x["p_partial"] <= 0.05 / N)
        x["fdr_rej"] = bool(rj)

    with open(f"{OUT}/sec4_incremental.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for x in rows:
            w.writerow(x)
    with open(f"{OUT}/sec4_incremental_detail.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(detail[0].keys()))
        w.writeheader()
        for x in detail:
            w.writerow(x)

    lines = []
    lines.append(f"### §4.1 家族规模与门槛\n")
    lines.append(f"- 家族 = d1 的 n(3) × r≠1(6) × h(6) × 时段(3) = **{N}** 个检验；"
                 f"Bonferroni α = {0.05/N:.2e}（≈ |t| ≥ {L.t_crit_abs(0.05/N, 6):.2f}，df=6）；"
                 f"BH-FDR(q=0.05) 显著 {sum(1 for x in rows if x['fdr_rej'])} 个，"
                 f"Bonferroni 显著 {sum(1 for x in rows if x['bonf_rej'])} 个。\n")
    lines.append("### §4.2 r≠1 的正交化偏 IC（n=26，跨 7 ETF）\n")
    for period in ["IS", "OOS"]:
        hdr = ["h"] + [f"r={r:g}" for r in R_LIST]
        rws = []
        for h in H_LIST:
            row = [h]
            for r in R_LIST:
                x = next(t for t in rows if t["n"] == 26.0 and t["r"] == r and t["h"] == h and t["period"] == period)
                mark = "**" if x["bonf_rej"] else ("*" if x["fdr_rej"] else "")
                row.append(f"{mark}{x['med_partial_ic']:+.4f}{mark}" if np.isfinite(x["med_partial_ic"]) else "n/a")
            rws.append(row)
        lines.append(f"*{period}：中位偏 IC（对 BIAS(26)+ROC(h)+dcap(r=1) 正交化后；* = FDR，\\*\\* = Bonferroni）*\n")
        lines.append(L.table(rws, hdr) + "\n")
    lines.append("### §4.3 多元回归中 dcap(r≠1) 的增量系数与 NW t（n=26）\n")
    hdr = ["period", "h", "r", "中位系数(每 1σ)", "中位 NW t", "跨 ETF t(偏 IC)", "p", "同号显著标的", "FDR", "Bonferroni"]
    rws = []
    for period in ["IS", "OOS"]:
        for h in H_LIST:
            for r in [0.5, 1.2, 2.0]:
                x = next(t for t in rows if t["n"] == 26.0 and t["r"] == r and t["h"] == h and t["period"] == period)
                rws.append([period, h, f"{r:g}", L.fmt(x["coef_pos"] and 0 or 0, 4) if False else "—",
                            L.fmt0(x["med_t"], 2), L.fmt(x["t_partial"], 2),
                            f"{x['p_partial']:.4f}" if np.isfinite(x["p_partial"]) else "n/a",
                            f"+{x['n_pos_sig']}/-{x['n_neg_sig']}",
                            "是" if x["fdr_rej"] else "否", "是" if x["bonf_rej"] else "否"])
    lines.append(L.table(rws, hdr) + "\n")
    lines.append("### §4.4 全部 (n,r,h,period) 单元的偏 IC 符号分布（全披露）\n")
    hdr = ["n", "r", "h", "时段", "中位偏 IC", "偏 IC>0 标的", "中位 NW t", "FDR", "Bonferroni"]
    rws = []
    for x in rows:
        if x["period"] == "full":
            continue
        rws.append([f"{x['n']:g}", f"{x['r']:g}", x["h"], x["period"], L.fmt(x["med_partial_ic"], 4),
                    f"{x['coef_pos']}/{x['K']}", L.fmt0(x["med_t"], 2),
                    "是" if x["fdr_rej"] else "否", "是" if x["bonf_rej"] else "否"])
    lines.append(L.table(rws, hdr) + "\n")

    with open(f"{OUT}/sec4_incremental.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote sec4_incremental.md/csv/detail (tests={N})")
    sig = [x for x in rows if x["fdr_rej"]]
    print("FDR sig cells:")
    for x in sorted(sig, key=lambda z: -abs(z["med_partial_ic"]))[:15]:
        print(f"  n={x['n']:g} r={x['r']:g} h={x['h']} {x['period']} med_partial_ic={x['med_partial_ic']:+.4f} "
              f"med_t={x['med_t']:+.2f} t_cross={x['t_partial']:+.2f} p={x['p_partial']:.4f}")
    print("median med_partial_ic over all cells:", float(np.nanmedian([x["med_partial_ic"] for x in rows])))
    print("cells with |med_partial_ic|>=0.01:", int(sum(1 for x in rows if abs(x["med_partial_ic"]) >= 0.01)))


if __name__ == "__main__":
    main()
