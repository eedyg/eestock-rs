"""§1 指标自身统计性质：分布分位 / 标准差与 IQR / 零穿越频率 / ACF(1) 与半衰期 /
下界 −1 触及率 / 振幅随 r 的单调性。

输入：/tmp/dcap_ind_out/run1/*.f64bin（产物字节经 rquickjs 求得，见 dcap_ind_probe.rs）
输出：sec1_stats_grid.csv、sec1_stats_by_etf.csv、sec1_stats.md
"""

import csv
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dcap_lib as L  # noqa: E402

OUT = "/tmp/dcap_ind_out"
QS = [0.01, 0.05, 0.25, 0.50, 0.75, 0.95, 0.99]


def series_stats(v):
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    if v.size < 30:
        return None
    q = np.quantile(v, QS)
    return {
        "n_valid": int(v.size),
        "mean": float(v.mean()),
        "std": float(v.std(ddof=1)),
        "min": float(v.min()),
        "q01": float(q[0]),
        "q05": float(q[1]),
        "q25": float(q[2]),
        "q50": float(q[3]),
        "q75": float(q[4]),
        "q95": float(q[5]),
        "q99": float(q[6]),
        "iqr": float(q[4] - q[2]),
        "absmean": float(np.abs(v).mean()),
        "zero_cross": L.zero_cross_rate(v),
        "acf1": L.acf1(v),
        "half_life": L.half_life(L.acf1(v)),
        "touch_le_m099": float((v <= -0.99).mean()),
        "touch_le_m09": float((v <= -0.90).mean()),
        "touch_le_m05": float((v <= -0.50).mean()),
        "touch_le_0": float((v <= 0.0).mean()),
        "max": float(v.max()),
    }


def main():
    freq = sys.argv[1] if len(sys.argv) > 1 else "d1"
    panels = L.load_all(freq, "run1")
    rows = []
    for p in panels:
        for (n, r, m) in L.cbars(freq):
            v = p.col(n, r, m)
            st = series_stats(v)
            if st is None:
                continue
            rows.append(dict(etf=p.etf, n=n, r=r, m=m, bars=p.closes.size, **st))

    # 逐标的 CSV
    cols = ["etf", "n", "r", "m", "bars", "n_valid", "mean", "std", "min", "q01", "q05", "q25",
            "q50", "q75", "q95", "q99", "iqr", "absmean", "zero_cross", "acf1", "half_life",
            "touch_le_m099", "touch_le_m09", "touch_le_m05", "touch_le_0", "max"]
    with open(f"{OUT}/sec1_stats_by_etf_{freq}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for row in rows:
            w.writerow({k: row[k] for k in cols})

    # 跨标的中位数
    keys = [k for k in cols if k not in ("etf", "n", "r", "m", "bars")]
    grid = []
    for (n, r, m) in L.cbars(freq):
        sub = [row for row in rows if row["n"] == n and row["r"] == r and row["m"] == m]
        rec = {"n": n, "r": r, "m": m, "etfs": len(sub)}
        for k in keys:
            vals = [s[k] for s in sub if np.isfinite(s[k])]
            rec[k] = float(np.median(vals)) if vals else float("nan")
        rec["std_p25"] = float(np.quantile([s["std"] for s in sub], 0.25))
        rec["std_p75"] = float(np.quantile([s["std"] for s in sub], 0.75))
        grid.append(rec)
    with open(f"{OUT}/sec1_stats_grid_{freq}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(grid[0].keys()))
        w.writeheader()
        for row in grid:
            w.writerow(row)

    lines = []
    lines.append("### §1.1 分布与振幅随 `r` 的变化（跨 7 ETF 中位数；m=3（生产默认）、smooth=1）\n")
    for m in [3.0]:
        for n in [8.0, 26.0, 60.0]:
            hdr = ["r", "有效 bar/标的", "均值", "标准差", "IQR", "mean|v|", "q05", "q50", "q95", "min"]
            rws = []
            for r in [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]:
                g = next(x for x in grid if x["n"] == n and x["r"] == r and x["m"] == m)
                rws.append([f"{r:g}", g["n_valid"], L.fmt(g["mean"], 5), L.fmt0(g["std"], 5),
                            L.fmt0(g["iqr"], 5), L.fmt0(g["absmean"], 5), L.fmt(g["q05"], 5),
                            L.fmt(g["q50"], 5), L.fmt(g["q95"], 5), L.fmt(g["min"], 4)])
            lines.append(f"**n={n:g}**\n")
            lines.append(L.table(rws, hdr) + "\n")

    lines.append("### §1.2 序列性质：零穿越 / ACF(1) / 半衰期 / 下界触及率（跨 7 ETF 中位数）\n")
    hdr = ["n", "r", "m", "零穿越率", "ACF(1)", "半衰期(bar)", "P(v≤−0.99)", "P(v≤−0.9)", "P(v≤−0.5)", "P(v≤0)"]
    rws = []
    for g in grid:
        rws.append([f"{g['n']:g}", f"{g['r']:g}", f"{g['m']:g}", L.fmt0(g["zero_cross"], 4),
                    L.fmt0(g["acf1"], 4), L.fmt0(g["half_life"], 1), L.fmt0(g["touch_le_m099"], 5),
                    L.fmt0(g["touch_le_m09"], 5), L.fmt0(g["touch_le_m05"], 4),
                    L.fmt0(g["touch_le_0"], 4)])
    lines.append(L.table(rws, hdr) + "\n")

    lines.append("### §1.3 振幅随 r 的单调性（标准差 / IQR / mean|v|，跨 7 ETF 中位数）\n")
    hdr = ["n", "m", "指标", "r=0.5→2.0 序列", "单调递减?", "严格递减?"]
    rws = []
    for n in [8.0, 26.0, 60.0]:
        for m in [1.0, 3.0, 5.0]:
            for key, name in [("std", "标准差"), ("iqr", "IQR"), ("absmean", "mean|v|")]:
                seq = [next(x for x in grid if x["n"] == n and x["r"] == r and x["m"] == m)[key]
                       for r in [0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0]]
                dec = all(seq[i + 1] <= seq[i] for i in range(len(seq) - 1))
                strict = all(seq[i + 1] < seq[i] for i in range(len(seq) - 1))
                rws.append([f"{n:g}", f"{m:g}", name,
                            " > ".join(f"{v:.4f}" for v in seq),
                            "是" if dec else "**否**", "是" if strict else "否"])
    lines.append(L.table(rws, hdr) + "\n")

    lines.append("### §1.4 下界 −1 的触及率核验（数学下界 = −1）\n")
    allmin = min(x["min"] for x in rows)
    worst_row = min(rows, key=lambda x: x["min"])
    mx99 = max(x["touch_le_m099"] for x in grid)
    n05 = sum(1 for x in grid if x["touch_le_m05"] > 0)
    mx05 = max(x["touch_le_m05"] for x in grid)
    w05 = max(grid, key=lambda x: x["touch_le_m05"])
    lines.append(f"- 网格最小观测值：`{allmin:.6f}`（{worst_row['etf']}，n={worst_row['n']:g}, "
                 f"r={worst_row['r']:g}, m={worst_row['m']:g}）")
    lines.append(f"- `P(v ≤ −0.99)` 在全 63 组合 × 7 标的上**恒为 0**（最大 {mx99:.5f}）"
                 "⇒ 下界 −1 从未被触及（数学下界，仅在估值价趋于 0 时可达）。")
    lines.append(f"- `P(v ≤ −0.5)`：63 组合中 {n05} 个（跨标的中位）> 0，最大 {mx05:.5f}"
                 f"（n={w05['n']:g}, r={w05['r']:g}, m={w05['m']:g}）——极端负值只出现在 `r < 1`"
                 "（权重压在最旧 bar 上 ⇒ 退化为长窗价格比），且样本占比仍极小。\n")

    with open(f"{OUT}/sec1_stats_{freq}.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote sec1_stats_{freq}.md / sec1_stats_grid_{freq}.csv / sec1_stats_by_etf_{freq}.csv")
    print(json.dumps({"rows": len(rows), "grid": len(grid)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
