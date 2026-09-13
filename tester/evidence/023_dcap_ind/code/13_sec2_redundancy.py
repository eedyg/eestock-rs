"""§2 参数冗余量化：(n,r) → 等价 (n', r=1) 映射 + 秩相关矩阵 + 冗余/非冗余区划分。

方法（全部用**产物字节序列**，不重写 dcap 公式）：
  · 有效回看 EL(n,r) = Σ w_k (n−k) / Σ w_k（02-spec §1.3 定义，w_k = r^(k−1)）—— 解析权重诊断；
  · 解析映射 n'_EL = 2·EL + 1（因 EL(n',1) = (n'−1)/2）；
  · 经验映射 = r=1、m=3 的 n′ ∈ [2,250] 全扫序列中 Spearman 秩相关最大者（并给「方差匹配 n′」：|log std 比| 最小者）；
  · 形状残差 = 分位差（q∈{5,25,50,75,95}）绝对均值 / 被比较序列 IQR；
  · 比较窗口 t ≥ 300（覆盖全部 n′ 的 warmup 250+3−1=252），秩在窗内一次算好 ⇒ 相关矩阵 = 秩的 Pearson 矩阵乘法。

输出：sec2_equiv_map_<freq>.csv、sec2_rank_matrix_<freq>.csv、sec2_rank_matrix_grid63_<freq>.csv、sec2_equiv_<freq>.md
"""

import csv
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcap_lib as L  # noqa: E402

OUT = "/tmp/dcap_ind_out"
W0 = 300
QS = [0.05, 0.25, 0.50, 0.75, 0.95]
FINE_R = [0.90, 0.95, 1.02, 1.05, 1.10]


def rank_rows(arrays, t0):
    rows = []
    for v in arrays:
        w = np.asarray(v, float)[t0:]
        if w.size < 100 or not np.isfinite(w).all():
            continue
        rows.append(L.rankdata(w))
    return np.array(rows)


def corr_from_ranks(A, B):
    Az = (A - A.mean(axis=1, keepdims=True)) / A.std(axis=1, keepdims=True, ddof=1)
    Bz = (B - B.mean(axis=1, keepdims=True)) / B.std(axis=1, keepdims=True, ddof=1)
    return Az @ Bz.T / (A.shape[1] - 1)


def main():
    freq = sys.argv[1] if len(sys.argv) > 1 else "d1"
    ns_freq = {"d1": "d1ns", "m15": "m15ns"}[freq]
    fine_freq = {"d1": "d1fine", "m15": "m15fine"}[freq]

    base = L.load_all(freq, "run1")
    fine = L.load_all(fine_freq, "run1")
    nsp = L.load_all(ns_freq, "run1")

    primary = [(n, r, 3.0) for (n, r, m) in L.cbars(freq) if m == 3.0]
    fine_cfgs = [(float(c["n"]), float(c["r"]), float(c["m"])) for c in fine[0].cfgs]
    targets = [("primary", n, r, m) for (n, r, m) in primary] + [("fine", n, r, m) for (n, r, m) in fine_cfgs]

    nprimes = [int(float(c["n"])) for c in nsp[0].cfgs]
    n_arr = np.array(nprimes, float)

    # ── 每 ETF：目标秩矩阵、n′ 秩矩阵 → 相关矩阵；Fisher-z 平均 ──────────────
    Zs, Zns, Zg = [], [], []
    for i, e in enumerate(L.ETFS):
        tr = rank_rows([base[i].col(n, r, m) for (_, n, r, m) in
                        [(t, n, r, m) for (t, n, r, m) in targets if t == "primary"]]
                       + [fine[i].col(n, r, m) for (t, n, r, m) in targets if t == "fine"], W0)
        nr = rank_rows([nsp[i].X[:, j] for j in range(len(nprimes))], W0)
        Zs.append(np.arctanh(np.clip(corr_from_ranks(tr, nr), -0.999999, 0.999999)))
        Zns.append(np.arctanh(np.clip(corr_from_ranks(nr, nr), -0.999999, 0.999999)))
        all63 = [base[i].col(n, r, m) for (n, r, m) in L.cbars(freq)]
        g = rank_rows(all63, W0)
        Zg.append(np.arctanh(np.clip(corr_from_ranks(g, g), -0.999999, 0.999999)))
    Cf = np.tanh(np.nanmean(np.array(Zs), axis=0))          # (targets × n')
    Cn = np.tanh(np.nanmean(np.array(Zns), axis=0))         # (n' × n')
    Cg = np.tanh(np.nanmean(np.array(Zg), axis=0))          # (63 × 63) 主网格
    win = rank_rows([base[0].col(8.0, 1.0, 3.0)], W0).shape[1]

    # ── 等价映射行 ─────────────────────────────────────────────────────────
    rows = []
    for ti, (kind, n, r, m) in enumerate(targets):
        el = L.effective_lookback(n, r)
        n_el_val = 2.0 * el + 1.0
        jmax = int(np.nanargmax(Cf[ti]))
        j_el = int(np.nanargmin(np.abs(n_arr - n_el_val)))
        # 方差匹配
        std_ratio = []
        for j in range(len(nprimes)):
            rr = []
            for i in range(len(L.ETFS)):
                a = base[i].col(n, r, m) if kind == "primary" else fine[i].col(n, r, m)
                a = a[W0:]
                b = nsp[i].X[W0:, j]
                if a.size > 100 and np.isfinite(b).all() and b.std(ddof=1) > 0:
                    rr.append(a.std(ddof=1) / b.std(ddof=1))
            std_ratio.append(float(np.median(rr)) if rr else np.nan)
        j_std = int(np.nanargmin([abs(np.log(v)) if v and np.isfinite(v) and v > 0 else np.inf for v in std_ratio]))
        # 形状残差（分位差 / IQR）
        dq = []
        for i in range(len(L.ETFS)):
            a = (base[i].col(n, r, m) if kind == "primary" else fine[i].col(n, r, m))[W0:]
            b = nsp[i].X[W0:, j_el]
            qa = np.quantile(a, QS)
            qb = np.quantile(b, QS)
            iqr = qa[3] - qa[1]
            if iqr > 0:
                dq.append(float(np.abs(qa - qb).mean() / iqr))
        resid = float(np.median(dq)) if dq else float("nan")
        rho_max = float(Cf[ti, jmax])
        rho_el = float(Cf[ti, j_el])
        ci99 = n_arr[Cf[ti] >= 0.99]
        ci95 = n_arr[Cf[ti] >= 0.95]
        boundary = nprimes[jmax] in (2, 250)
        if boundary:
            verdict = "边界（n′ 扫描外推）"
        elif rho_max >= 0.99 and resid <= 0.05:
            verdict = "冗余（r=1 的 n′ 可复现）"
        elif rho_max >= 0.95:
            verdict = "部分冗余"
        else:
            verdict = "**不可由 n 复现**"
        rows.append(dict(kind=kind, n=n, r=r, m=m, EL=el, n_EL=n_el_val,
                         nprime_argmax=nprimes[jmax], rho_max=rho_max,
                         nprime_EL=nprimes[j_el], rho_at_nEL=rho_el,
                         nprime_stdmatch=nprimes[j_std], std_ratio=std_ratio[j_std],
                         quantile_resid=resid,
                         rho099_lo=(int(ci99.min()) if ci99.size else ""),
                         rho099_hi=(int(ci99.max()) if ci99.size else ""),
                         n_rho099=int(ci99.size), n_rho095=int(ci95.size), verdict=verdict))

    with open(f"{OUT}/sec2_equiv_map_{freq}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for x in rows:
            w.writerow(x)

    with open(f"{OUT}/sec2_rank_matrix_{freq}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["kind", "n", "r", "m"] + nprimes)
        for ti, (kind, n, r, m) in enumerate(targets):
            w.writerow([kind, n, r, m] + [round(float(v), 6) for v in Cf[ti]])
    with open(f"{OUT}/sec2_rank_matrix_nprime_{freq}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["nprime"] + nprimes)
        for a, npv in enumerate(nprimes):
            w.writerow([npv] + [round(float(v), 6) for v in Cn[a]])
    cfg63 = [f"n{L.fmt_num(n)}_r{L.fmt_num(r)}_m{L.fmt_num(m)}" for (n, r, m) in L.cbars(freq)]
    with open(f"{OUT}/sec2_rank_matrix_grid63_{freq}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["cfg"] + cfg63)
        for a, cid in enumerate(cfg63):
            w.writerow([cid] + [round(float(v), 6) for v in Cg[a]])

    # ── 报告 ───────────────────────────────────────────────────────────────
    lines = [f"*(freq = `{freq}`；窗口 t ≥ {W0}，窗内有效 bar ≈ {win}；相关 = 跨 7 ETF 的 Fisher-z 平均 Spearman)*\n"]
    lines.append("### §2.1 有效回看与解析等价比对（02-spec §1.3 表的独立复算）\n")
    hdr = ["n", "r=1.0", "r=1.1", "r=1.2", "r=1.5", "r=2.0"]
    rws = [[f"{n:g}"] + [f"{L.effective_lookback(n, r):.2f}" for r in [1.0, 1.1, 1.2, 1.5, 2.0]]
           for n in [8.0, 26.0, 60.0]]
    lines.append(L.table(rws, hdr) + "\n")
    lines.append("> 与 `02-spec.md` §1.3 表逐格一致 ⇒ 有效回看口径正确，可据此做等价比对。\n")

    lines.append("### §2.2 等价 (n,r) 映射表（m=3；`primary` = 主网格 7 档 r，`fine` = 近 1 细网格 5 档 r）\n")
    hdr = ["组", "n", "r", "EL(n,r)", "解析 n′=2EL+1", "经验 n′(argmax ρ)", "ρ_max",
           "ρ(在解析 n′)", "方差匹配 n′", "分位残差/IQR", "ρ≥0.99 的 n′ 区间", "判定"]
    rws = []
    for x in rows:
        rws.append([x["kind"], f"{x['n']:g}", f"{x['r']:g}", f"{x['EL']:.3f}", f"{x['n_EL']:.2f}",
                    x["nprime_argmax"], f"{x['rho_max']:.4f}", f"{x['rho_at_nEL']:.4f}",
                    x["nprime_stdmatch"], f"{x['quantile_resid']:.3f}",
                    (f"{x['rho099_lo']}..{x['rho099_hi']}" if x["n_rho099"] else "-"), x["verdict"]])
    lines.append(L.table(rws, hdr) + "\n")

    lines.append("### §2.3 秩相关分块（m=3 主网格；每格 = 跨 7 ETF Fisher-z 平均 Spearman）\n")
    idx = {f"n{n:g}_r{r:g}_m3": a for a, (n, r, m) in enumerate(L.cbars(freq)) if m == 3.0}
    for n in [8.0, 26.0, 60.0]:
        rs = [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]
        sub = [idx[f"n{n:g}_r{r:g}_m3"] for r in rs]
        lines.append(f"**n={n:g}：行=列=r**\n")
        lines.append(L.table([[f"{rs[a]:g}"] + [f"{Cg[sub[a], sub[b]]:.4f}" for b in range(len(sub))] for a in range(len(sub))],
                             [""] + [f"r={v:g}" for v in rs]) + "\n")
    for r in [0.5, 1.0, 1.5]:
        ns_ = [8.0, 26.0, 60.0]
        sub = [idx[f"n{n:g}_r{r:g}_m3"] for n in ns_]
        lines.append(f"**r={r:g}：行=列=n**\n")
        lines.append(L.table([[f"n={ns_[a]:g}"] + [f"{Cg[sub[a], sub[b]]:.4f}" for b in range(len(sub))] for a in range(len(sub))],
                             [""] + [f"n={v:g}" for v in ns_]) + "\n")
    lines.append("**r=1 的 n′ 之间的秩相关（n′ ∈ {8,26,60}，m=3）**\n")
    subn = [nprimes.index(int(n)) for n in [8, 26, 60]]
    lines.append(L.table([[f"n′={nprimes[subn[a]]}"] + [f"{Cn[subn[a], subn[b]]:.4f}" for b in range(3)] for a in range(3)],
                         ["", "n′=8", "n′=26", "n′=60"]) + "\n")

    n_red = sum(1 for x in rows if x["verdict"].startswith("冗余"))
    n_part = sum(1 for x in rows if x["verdict"] == "部分冗余")
    n_irr = sum(1 for x in rows if "不可由" in x["verdict"])
    n_bnd = sum(1 for x in rows if "边界" in x["verdict"])
    lines.append("### §2.4 冗余 / 非冗余区划分（判定规则在计算前写死）\n")
    lines.append("规则：`ρ_max ≥ 0.99 且 分位残差/IQR ≤ 0.05` ⇒ **冗余**；`0.95 ≤ ρ_max < 0.99` ⇒ 部分冗余；"
                 "`ρ_max < 0.95` ⇒ **不可由 n 复现**；argmax 落在 n′ 扫描边界 ⇒ 标「边界」。\n")
    lines.append(L.table([[x["kind"], f"{x['n']:g}", f"{x['r']:g}", f"{x['rho_max']:.4f}",
                           f"{x['quantile_resid']:.3f}", x["verdict"]] for x in rows],
                         ["组", "n", "r", "ρ_max", "分位残差", "判定"]))
    lines.append(f"\n统计：冗余 {n_red} / 部分冗余 {n_part} / 不可复现 {n_irr} / 边界 {n_bnd}（共 {len(rows)} 单元）\n")

    with open(f"{OUT}/sec2_equiv_{freq}.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote sec2_equiv_{freq}.md (+3 CSV)；win={win}")
    print(f"redundant={n_red} partial={n_part} irreproducible={n_irr} boundary={n_bnd}")


if __name__ == "__main__":
    main()
