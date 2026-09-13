"""§3 对未来的统计效力（IC 类，不入策略）：Spearman IC、分位分组平均收益、命中率；
IS/OOS 分别给 IC / ICIR / t，并做多重比较惩罚（Bonferroni + BH-FDR）。

纪律：
  · 信号 = 产物字节 dcap 线（rquickjs 求值，见 dcap_ind_probe.rs）；
  · 未来收益 = close[t+h]/close[t] − 1（仅用于被解释端，不含任何策略成分：无阈值、无仓位、无费率）；
  · IS = 每标的前 70%（cut = int(T*0.7)），OOS = 后 30%；不做 OOS 参数反选；
  · 允许「证据不足」结论；全网格（63 组合 × 6 h × 3 时段）逐行落 CSV，不静默截断。

输出：sec3_ic_grid.csv、sec3_ic.md、sec3_quantile_groups.csv/md、sec3_cs_ic.csv
"""

import csv
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcap_lib as L  # noqa: E402

OUT = "/tmp/dcap_ind_out"
H_LIST = [1, 2, 4, 8, 16, 32]


def ic_one(panel, sig, h, mask):
    """单标的、单时段 IC：sig 与 h-bar 未来收益的 Spearman。"""
    ret = L.fwd_return(panel.closes, h)
    x = np.where(mask, sig, np.nan)
    rho, nn = L.safe_spearman_full(x, ret)
    return rho, nn


def per_etf_ics(panels, n, r, m, h, period):
    """返回 (ics, ns)：逐标的口径。period ∈ full/IS/OOS。"""
    ics, ns = [], []
    for p in panels:
        T = p.closes.size
        is_mask, oos_mask = L.t_split(T)
        mask = {"full": np.ones(T, bool), "IS": is_mask, "OOS": oos_mask}[period]
        rho, nn = ic_one(p, p.col(n, r, m), h, mask)
        ics.append(rho)
        ns.append(nn)
    return np.array(ics), np.array(ns)


def agg(ics, ns):
    """跨标的聚合：mean/std/ICIR/t(df=K−1)。"""
    ok = np.isfinite(ics) & (ns >= 100)
    v = ics[ok]
    K = v.size
    if K < 3:
        return dict(K=K, mean=np.nan, std=np.nan, icir=np.nan, t=np.nan, p=np.nan, pos=0, n_min=0)
    mean = float(v.mean())
    std = float(v.std(ddof=1))
    t = mean / std * np.sqrt(K) if std > 0 else np.nan
    p = L.t_two_sided_p(t, K - 1)
    return dict(K=K, mean=mean, std=std, icir=(mean / std if std > 0 else np.nan),
                t=t, p=p, pos=int((v > 0).sum()), n_min=int(ns[ok].min()),
                n_med=int(np.median(ns[ok])))


def pooled_ic(panels, n, r, m, h, period):
    xs, ys = [], []
    for p in panels:
        T = p.closes.size
        is_mask, oos_mask = L.t_split(T)
        mask = {"full": np.ones(T, bool), "IS": is_mask, "OOS": oos_mask}[period]
        ret = L.fwd_return(p.closes, h)
        sig = p.col(n, r, m)
        ok = mask & np.isfinite(sig) & np.isfinite(ret)
        xs.append(sig[ok])
        ys.append(ret[ok])
    x = np.concatenate(xs)
    y = np.concatenate(ys)
    return L.safe_spearman_full(x, y) + (x.size,)


def quantile_groups(panels, n, r, m, h, period, nq=5):
    """逐标的分位分组（组内等频）：返回每组的平均未来收益、命中率 P(ret>0)、样本数（跨标的中位数）。"""
    means = [[] for _ in range(nq)]
    hits = [[] for _ in range(nq)]
    sizes = [[] for _ in range(nq)]
    spreads = []
    for p in panels:
        T = p.closes.size
        is_mask, oos_mask = L.t_split(T)
        mask = {"full": np.ones(T, bool), "IS": is_mask, "OOS": oos_mask}[period]
        sig = p.col(n, r, m)
        ret = L.fwd_return(p.closes, h)
        ok = mask & np.isfinite(sig) & np.isfinite(ret)
        s, rr = sig[ok], ret[ok]
        if s.size < 200:
            continue
        q = np.quantile(s, np.linspace(0, 1, nq + 1))
        q[0], q[-1] = -np.inf, np.inf
        for g in range(nq):
            sel = (s > q[g]) & (s <= q[g + 1])
            if sel.sum() < 30:
                means[g].append(np.nan)
                hits[g].append(np.nan)
                sizes[g].append(int(sel.sum()))
                continue
            means[g].append(float(rr[sel].mean()))
            hits[g].append(float((rr[sel] > 0).mean()))
            sizes[g].append(int(sel.sum()))
        spreads.append(float(rr[s > q[-2]].mean() - rr[s <= q[1]].mean()))
    return ([float(np.nanmedian(x)) for x in means],
            [float(np.nanmedian(x)) for x in hits],
            [int(np.nanmedian(x)) for x in sizes],
            spreads)


def cross_sectional(panels, n, r, m, h, period, min_valid=4):
    """面板横截面 IC：按日期对 ≥min_valid 个标的做横截面 Spearman，得到时间序列 + Newey-West t。"""
    dates = sorted(set(d for p in panels for d in p.dates))
    didx = {d: i for i, d in enumerate(dates)}
    T = len(dates)
    S = np.full((T, len(panels)), np.nan)
    R = np.full((T, len(panels)), np.nan)
    P = np.zeros((T, len(panels)), dtype=bool)  # 该标的在该日属于目标时段
    for j, p in enumerate(panels):
        Tp = p.closes.size
        is_mask, oos_mask = L.t_split(Tp)
        pmask = {"full": np.ones(Tp, bool), "IS": is_mask, "OOS": oos_mask}[period]
        ret = L.fwd_return(p.closes, h)
        sig = p.col(n, r, m)
        for i, d in enumerate(p.dates):
            t = didx[d]
            if not pmask[i]:
                continue
            P[t, j] = True
            if np.isfinite(sig[i]):
                S[t, j] = sig[i]
            if np.isfinite(ret[i]):
                R[t, j] = ret[i]
    ics = []
    for t in range(T):
        if P[t].sum() < min_valid:
            continue
        msk = np.isfinite(S[t]) & np.isfinite(R[t]) & P[t]
        if msk.sum() < min_valid:
            continue
        rho, _ = L.safe_spearman_full(S[t][msk], R[t][msk], min_n=4)
        if np.isfinite(rho):
            ics.append((t, rho))
    if len(ics) < 30:
        return float("nan"), float("nan"), len(ics), float("nan")
    ts = np.array([x[0] for x in ics])
    v = np.array([x[1] for x in ics])
    # Newey-West t（对均值回归 y = const，lag = max(h, 5)）
    X = np.ones((v.size, 1))
    lag = max(h, 5)
    y = v
    beta, resid, XtX_inv = L.ols(y, X)
    u = resid[:, None] * X
    Sb = u.T @ u
    for l in range(1, lag + 1):
        w = 1.0 - l / (lag + 1.0)
        G = u[l:].T @ u[:-l]
        Sb += w * (G + G.T)
    V = XtX_inv @ Sb @ XtX_inv
    se = float(np.sqrt(max(V[0, 0], 0.0)))
    t = float(beta[0] / se) if se > 0 else float("nan")
    return float(v.mean()), t, int(v.size), float((v > 0).mean())


def run_freq(freq, run="run1"):
    panels = L.load_all(freq, run)
    rows = []
    for (n, r, m) in L.cbars(freq):
        for h in H_LIST:
            for period in ["full", "IS", "OOS"]:
                ics, ns = per_etf_ics(panels, n, r, m, h, period)
                a = agg(ics, ns)
                pool, pool_n, _ = pooled_ic(panels, n, r, m, h, period)
                # 重叠窗口校正：h 根 bar 的前瞻收益相邻样本重叠 h−1 根 ⇒ n_eff ≈ n_bars/h；
                # 保守地把 IC 的 z 折为 IC·sqrt(n_eff)（单标的口径），供「证据是否够」判断。
                n_med = a.get("n_med", a["n_min"])
                neff = (n_med / h) if n_med else 0.0
                z_ov = (a["mean"] * np.sqrt(neff)) if np.isfinite(a["mean"]) and neff > 0 else float("nan")
                rows.append(dict(freq=freq, n=n, r=r, m=m, h=h, period=period,
                                 mean_ic=a["mean"], std_ic=a["std"], icir=a["icir"], t=a["t"], p=a["p"],
                                 K=a["K"], ic_pos=a["pos"], n_min=a["n_min"], n_med=a["n_med"],
                                 n_eff_overlap=neff, z_overlap=z_ov, p_overlap=L.norm_two_sided_p(z_ov),
                                 pooled_ic=pool, pooled_n=pool_n,
                                 ics=";".join(f"{v:.4f}" if np.isfinite(v) else "nan" for v in ics)))
    return panels, rows


def main():
    freqs = sys.argv[1:] or ["d1", "m15"]
    all_rows = []
    for freq in freqs:
        panels, rows = run_freq(freq)
        all_rows.extend(rows)
        if freq == "d1":
            d1_panels = panels

    # ── 多重比较惩罚（家族 = 每个 freq 的全部 63×6×3 检验）──────────────────
    for freq in freqs:
        fam = [x for x in all_rows if x["freq"] == freq]
        p = np.array([x["p"] for x in fam], float)
        rej, thr, _ = L.bh_fdr(p, 0.05)
        N = len(fam)
        bonf = 0.05 / N
        for x, rj in zip(fam, rej):
            x["fdr_rej"] = bool(rj)
            x["bonf_alpha"] = bonf
            x["bonf_rej"] = bool(np.isfinite(x["p"]) and x["p"] <= bonf)

    cols = ["freq", "n", "r", "m", "h", "period", "mean_ic", "std_ic", "icir", "t", "p", "K",
            "ic_pos", "n_min", "n_med", "n_eff_overlap", "z_overlap", "p_overlap",
            "pooled_ic", "pooled_n", "bonf_alpha", "bonf_rej", "fdr_rej", "ics"]
    with open(f"{OUT}/sec3_ic_grid.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for x in all_rows:
            w.writerow({k: x.get(k) for k in cols})

    # ── 报告表 ─────────────────────────────────────────────────────────────
    lines = []
    lines.append("### §3.1 IC 家族规模与多重比较门槛\n")
    for freq in freqs:
        fam = [x for x in all_rows if x["freq"] == freq]
        n_tests = len(fam)
        sig_bonf = sum(1 for x in fam if x["bonf_rej"])
        sig_fdr = sum(1 for x in fam if x["fdr_rej"])
        lines.append(f"- **{freq}**：检验数 {n_tests}；Bonferroni α = 0.05/{n_tests} = {0.05/n_tests:.2e}"
                     f"（≈ t 临界 {L.t_crit_abs(0.05/n_tests, 6):.2f}，df=6）；"
                     f"Bonferroni 显著 {sig_bonf} 个；BH-FDR(q=0.05) 显著 {sig_fdr} 个。")
    lines.append("")

    lines.append("### §3.2 主口径 IC 摘要（m=3 生产默认；跨 7 ETF 等权）\n")
    for freq in freqs:
        lines.append(f"**{freq}**\n")
        for period in ["IS", "OOS"]:
            hdr = ["h"] + [f"r={r:g}" for r in [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]]
            for n in [8.0, 26.0, 60.0]:
                rws = []
                for h in H_LIST:
                    row = [h]
                    for r in [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]:
                        x = next(t for t in all_rows if t["freq"] == freq and t["n"] == n and t["r"] == r
                                 and t["m"] == 3.0 and t["h"] == h and t["period"] == period)
                        mark = "**" if x["bonf_rej"] else ("*" if x["fdr_rej"] else "")
                        row.append(f"{mark}{x['mean_ic']:+.4f}{mark}" if np.isfinite(x["mean_ic"]) else "n/a")
                    rws.append(row)
                lines.append(f"*n={n:g}，{period} 平均 IC（* = FDR 显著，\\*\\* = Bonferroni 显著）*\n")
                lines.append(L.table(rws, hdr) + "\n")

    lines.append("### §3.3 ICIR / t 摘要（n=26，m=3）\n")
    hdr = ["period", "h", "r", "平均 IC", "ICIR", "t(df=6)", "p", "IC>0 标的数", "Bonferroni", "FDR"]
    rws = []
    for freq in ["d1"]:
        for period in ["IS", "OOS"]:
            for h in H_LIST:
                for r in [0.5, 0.85, 1.0, 1.2, 1.5, 2.0]:
                    x = next(t for t in all_rows if t["freq"] == freq and t["n"] == 26.0 and t["r"] == r
                             and t["m"] == 3.0 and t["h"] == h and t["period"] == period)
                    rws.append([period, h, f"{r:g}", L.fmt(x["mean_ic"], 4), L.fmt0(x["icir"], 3),
                                L.fmt0(x["t"], 2), f"{x['p']:.4f}" if np.isfinite(x["p"]) else "n/a",
                                f"{x['ic_pos']}/{x['K']}",
                                "是" if x["bonf_rej"] else "否", "是" if x["fdr_rej"] else "否"])
    lines.append(L.table(rws, hdr) + "\n")

    lines_36 = []
    lines_36.append("### §3.6 最强单元的重叠窗口校正（h>1 时相邻前瞻收益重叠 h−1 根 ⇒ n_eff ≈ n_bars/h）\n")
    hdr = ["freq", "n", "r", "m", "h", "时段", "平均 IC", "跨 ETF t", "p(原始)", "n_eff", "z(重叠校正)", "p(重叠校正)"]
    rws = []
    top = sorted([x for x in all_rows if x["period"] == "OOS" and np.isfinite(x["mean_ic"])],
                 key=lambda x: -abs(x["mean_ic"]))[:10]
    for x in top:
        rws.append([x["freq"], f"{x['n']:g}", f"{x['r']:g}", f"{x['m']:g}", x["h"], x["period"],
                    L.fmt(x["mean_ic"], 4), L.fmt0(x["t"], 2), f"{x['p']:.4f}",
                    f"{x['n_eff_overlap']:.0f}", L.fmt0(x["z_overlap"], 2),
                    f"{x['p_overlap']:.4f}" if np.isfinite(x["p_overlap"]) else "n/a"])
    lines_36.append(L.table(rws, hdr) + "\n")
    lines_36.append("> 注：`z(重叠校正)` 只做「单标的口径」保守折算（n_eff ≈ n_bars/h），"
                 "不含跨标的重复计数；跨 ETF t 与面板横截面 NW t 见 §3.3 / §3.5。三者都不支持"
                 "「该 IC 在多重比较与重叠校正后仍显著」的结论（见 §0 结论与 §3.1）。\n")

    rows_36_placeholder = None
    # ── 分位分组 ───────────────────────────────────────────────────────────
    qrows = []
    lines.append("### §3.4 分位分组平均未来收益 / 命中率（n=26，m=3，5 分组等频；跨 7 ETF 中位数）\n")
    for freq in ["d1"]:
        for period in ["full", "IS", "OOS"]:
            for h in [1, 8, 32]:
                for r in [1.0, 0.5, 1.5]:
                    means, hits, sizes, spreads = quantile_groups(d1_panels, 26.0, r, 3.0, h, period)
                    qrows.append(dict(freq=freq, period=period, h=h, r=r,
                                      means=";".join(f"{v:.5f}" for v in means),
                                      hits=";".join(f"{v:.4f}" for v in hits),
                                      sizes=";".join(str(v) for v in sizes),
                                      spread=float(np.nanmedian(spreads)) if spreads else np.nan,
                                      spread_pos=int(sum(1 for v in spreads if np.isfinite(v) and v > 0)),
                                      K=len(spreads)))
                    lines.append(f"- **{freq} {period} h={h} r={r:g}**：G1→G5 平均收益 "
                                 + " / ".join(f"{v*100:+.3f}%" for v in means)
                                 + "；命中率 " + " / ".join(f"{v:.3f}" for v in hits)
                                 + f"；G5−G1 中位 {np.nanmedian(spreads)*100:+.3f}%"
                                 + f"（{sum(1 for v in spreads if np.isfinite(v) and v>0)}/{len(spreads)} 标的为正）")
    lines.append("")
    with open(f"{OUT}/sec3_quantile_groups.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(qrows[0].keys()))
        w.writeheader()
        for x in qrows:
            w.writerow(x)

    # ── 横截面 IC ──────────────────────────────────────────────────────────
    lines.append("### §3.5 面板横截面 IC（按日期对 ≥4 个在时段内的标的做横截面 Spearman；NW t，lag=max(h,5)）\n")
    hdr = ["period", "h", "n", "r", "横截面 IC 均值", "NW t", "有效日数", "横截面 IC>0 日占比"]
    rws = []
    for period in ["full", "IS", "OOS"]:
        for h in H_LIST:
            for (n, r) in [(8.0, 1.0), (26.0, 1.0), (26.0, 0.5), (26.0, 1.5), (60.0, 1.0)]:
                m_, t_, cnt, posfrac = cross_sectional(d1_panels, n, r, 3.0, h, period, 4)
                rws.append([period, h, f"{n:g}", f"{r:g}", L.fmt(m_, 4), L.fmt0(t_, 2), cnt,
                            L.fmt0(posfrac, 3)])
    lines.append(L.table(rws, hdr) + "\n")

    lines.extend(lines_36)
    with open(f"{OUT}/sec3_ic.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print("wrote sec3_ic.md / sec3_ic_grid.csv / sec3_quantile_groups.csv")
    fam = [x for x in all_rows if x["freq"] == freqs[0]]
    print(f"{freqs[0]} tests={len(fam)} bonf_sig={sum(1 for x in fam if x['bonf_rej'])} fdr_sig={sum(1 for x in fam if x['fdr_rej'])}")
    best = sorted([x for x in fam if np.isfinite(x["mean_ic"])], key=lambda x: -abs(x["mean_ic"]))[:10]
    for b in best:
        print(f"  |IC| top: n={b['n']:g} r={b['r']:g} m={b['m']:g} h={b['h']} {b['period']} "
              f"IC={b['mean_ic']:+.4f} t={b['t']:+.2f} p={b['p']:.4f} bonf={b['bonf_rej']} fdr={b['fdr_rej']}")


if __name__ == "__main__":
    main()
