"""车道 A —— 报告关键断言的自审（独立代码路径回算，不复用 dcap_lib 的矩阵/秩实现）。

用法：/usr/bin/python3.12 11_audit_report.py [证据目录]
输出：每条断言 PASS/FAIL + 回算值；退出码非 0 表示至少一条 FAIL。
"""

import hashlib
import json
import math
import os
import re
import sys

import numpy as np

OUT = "/tmp/dcap_ind_out"
ETFS = ["510050", "510880", "512800", "512480", "513050", "518880", "159985"]
fails = []
notes = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {detail}")
    if not ok:
        fails.append(name)


# ── 独立实现：秩（sorted + tie 平均）、Spearman、Pearson ─────────────────────
def rank_simple(x):
    x = np.asarray(x, float)
    order = sorted(range(x.size), key=lambda i: x[i])
    r = [0.0] * x.size
    i = 0
    while i < x.size:
        j = i
        while j + 1 < x.size and x[order[j + 1]] == x[order[i]]:
            j += 1
        avg = (i + 1 + j + 1) / 2.0
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return np.array(r)


def spearman_simple(x, y):
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    x, y = x[m], y[m]
    if x.size < 10:
        return float("nan"), int(x.size)
    rx, ry = rank_simple(x), rank_simple(y)
    rx -= rx.mean()
    ry -= ry.mean()
    d = math.sqrt(float((rx * rx).sum()) * float((ry * ry).sum()))
    return (float((rx * ry).sum()) / d if d else float("nan")), int(x.size)


def load(etf, freq, run="run1"):
    d = os.path.join(OUT, run)
    meta = json.load(open(os.path.join(d, f"meta_{etf}_{freq}.json")))
    X = np.fromfile(os.path.join(d, f"{etf}_{freq}_dcap.f64bin"), dtype="<f8").reshape(meta["rows"], meta["cols"])
    closes = []
    with open(os.path.join(d, f"{etf}_{freq}_bars.csv")) as fh:
        next(fh)
        for line in fh:
            if line.strip():
                closes.append(float(line.split(",")[1]))
    return meta, X, np.array(closes)


# ── A1 T1 冻结值（从 harness 自检输出解析 hex 位串后位级比对）────────────────
def a1():
    p = os.path.join(OUT, "selftest.txt")
    txt = open(p).read()
    def grab(tag):
        m = re.search(rf"{tag}.*hex=([0-9a-f]{{16}})", txt)
        return int(m.group(1), 16) if m else None
    b1 = grab("r=1.0  product")
    b12 = grab("r=1.2  product")
    f1 = int.from_bytes(np.float64(0.0018518518518517713).tobytes(), "little")
    f12 = int.from_bytes(np.float64(0.0045787545787547845).tobytes(), "little")
    v1 = np.frombuffer(b1.to_bytes(8, "little"), dtype="<f8")[0]
    v12 = np.frombuffer(b12.to_bytes(8, "little"), dtype="<f8")[0]
    check("A1a T1 r=1 位级一致", b1 == f1, f"product=0x{b1:016x} frozen=0x{f1:016x} Δ={abs(v1-0.0018518518518517713):.3e}")
    check("A1b T1 r=1.2 位级一致", b12 == f12, f"product=0x{b12:016x} frozen=0x{f12:016x} Δ={abs(v12-0.0045787545787547845):.3e}")
    check("A1c T1 容差 1e-12", abs(v1 - 0.0018518518518517713) <= 1e-12 and abs(v12 - 0.0045787545787547845) <= 1e-12)


# ── A2 数据快照 ─────────────────────────────────────────────────────────────
def a2():
    rows = []
    for e in ETFS:
        meta, X, closes = load(e, "d1")
        cfg = next(c for c in meta["grid"] if c["id"] == "n8_r1_m3")
        col = X[:, meta["grid"].index(cfg)]
        # smooth=1, m=3, n=8 ⇒ 首值索引 = n + m - 2 = 9
        first = int(np.argmax(np.isfinite(col)))
        rows.append((e, meta["bars"], first))
        check(f"A2 {e} 首值位置 = n+m−2 = 9", first == 9, f"bars={meta['bars']} first={first} closes={closes.size}")
    notes.append("数据行数：" + "; ".join(f"{e}:{b}" for e, b, _ in rows))


# ── A3 振幅随 r 单调压缩（独立重算，直方图口径）────────────────────────────
def a3():
    for e in ["510050", "159985"]:
        meta, X, _ = load(e, "d1")
        for n in (8.0, 26.0, 60.0):
            stds = []
            for r in (0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0):
                cid = f"n{int(n)}_r{int(r) if r == int(r) else r}_m3"
                col = X[:, meta["grid"].index(next(c for c in meta["grid"] if c["id"] == cid))]
                v = col[np.isfinite(col)]
                stds.append(float(v.std(ddof=1)))
            check(f"A3 {e} n={n:g} std 随 r 严格递减", all(stds[i + 1] < stds[i] for i in range(len(stds) - 1)),
                  " > ".join(f"{s:.5f}" for s in stds))


# ── A4 等价映射：独立用「序数秩」（argsort 序位，不做 tie 平均）复算相关谱 ─────
def a4():
    import csv
    table = {f"{x['kind']}|{float(x['n']):g}|{float(x['r']):g}": x
             for x in csv.DictReader(open(f"{OUT}/sec2_equiv_map_d1.csv"))}
    W0 = 300
    for (n, r) in [(8.0, 1.2), (26.0, 1.2), (60.0, 1.2), (26.0, 0.5), (8.0, 1.5)]:
        key = f"primary|{n:g}|{r:g}"
        rep_arg = int(table[key]["nprime_argmax"])
        rep_rho = float(table[key]["rho_max"])
        prof = []
        for e in ETFS:
            meta, X, _ = load(e, "d1")
            cid = f"n{n:g}_r{r:g}_m3".replace("n8_r", "n8_r").replace("n26_r", "n26_r").replace("n60_r", "n60_r")
            cid = cid.replace(".0_r", "_r").replace("_m3", "_m3")
            cid = cid.replace("n8.0", "n8").replace("n26.0", "n26").replace("n60.0", "n60")
            cid = cid.replace("r1.2", "r1.2").replace("r0.5", "r0.5").replace("r1.5", "r1.5")
            a = X[W0:, meta["grid"].index(next(c for c in meta["grid"] if c["id"] == cid))]
            nmeta, NX, _ = load(e, "d1ns")
            ra = np.argsort(np.argsort(a)).astype(float)
            prof_e = []
            for col in NX[W0:, :].T:
                rb = np.argsort(np.argsort(col)).astype(float)
                ra_c, rb_c = ra - ra.mean(), rb - rb.mean()
                d = math.sqrt((ra_c ** 2).sum() * (rb_c ** 2).sum())
                prof_e.append(float((ra_c * rb_c).sum() / d) if d else np.nan)
            prof.append(prof_e)
        prof = np.array(prof)
        mean_prof = np.nanmean(prof, axis=0)
        nprimes = [int(float(c["n"])) for c in nmeta["grid"]]
        arg = nprimes[int(np.nanargmax(mean_prof))]
        rho = float(np.nanmax(mean_prof))
        check(f"A4 n={n:g} r={r:g} 等价 n′ 复算", arg == rep_arg and abs(rho - rep_rho) < 5e-3,
              f"报告 n′={rep_arg} ρ={rep_rho:.4f} | 复算（序数秩）n′={arg} ρ={rho:.4f}")


# ── A5 最强 IC 单元：逐标的独立复算 ─────────────────────────────────────────
def a5():
    import csv
    rows = [x for x in csv.DictReader(open(f"{OUT}/sec3_ic_grid.csv"))
            if x["freq"] == "d1" and x["n"] == "60.0" and x["r"] == "1.0" and x["m"] == "3.0"
            and x["h"] == "32" and x["period"] == "OOS"][0]
    rep = [float(v) for v in rows["ics"].split(";")]
    got = []
    for e in ETFS:
        meta, X, closes = load(e, "d1")
        cid = "n60_r1_m3"
        sig = X[:, meta["grid"].index(next(c for c in meta["grid"] if c["id"] == cid))]
        T = closes.size
        cut = int(T * 0.7)
        ret = np.full(T, np.nan)
        ret[: T - 32] = closes[32:] / closes[: T - 32] - 1.0
        m = np.zeros(T, bool)
        m[cut:] = True
        rho, _ = spearman_simple(sig[m], ret[m])
        got.append(rho)
    maxd = max(abs(a - b) for a, b in zip(rep, got))
    ok = maxd <= 5.1e-5  # CSV 里逐标的 IC 以 4 位小数落盘，容差取半 ulp 量级
    check("A5 n=60 r=1 m=3 h=32 OOS 逐标的 IC 复算一致", ok,
          f"max|Δ|={maxd:.2e}；报告=" + ",".join(f"{v:.4f}" for v in rep) + " | 复算=" + ",".join(f"{v:.4f}" for v in got))
    mean = float(np.mean(got))
    check("A5b 均值 IC 与报告一致", abs(mean - float(rows["mean_ic"])) < 1e-9,
          f"报告={float(rows['mean_ic']):.6f} 复算={mean:.6f}")


# ── A6 多重比较：BH 无显著 ─────────────────────────────────────────────────
def a6():
    import csv
    ps = []
    for x in csv.DictReader(open(f"{OUT}/sec3_ic_grid.csv")):
        if x["freq"] != "d1":
            continue
        ps.append(float(x["p"]) if x["p"] not in ("", "nan") else np.nan)
    ps = np.array(ps)
    ok = np.isfinite(ps)
    p = np.sort(ps[ok])
    m = p.size
    rej = np.flatnonzero(p <= 0.05 * (np.arange(1, m + 1) / m))
    check("A6 BH-FDR(q=0.05) 在 d1 家族内无显著项", rej.size == 0,
          f"m={m} 最小 p={p[0]:.5f} 阈值@排名1={0.05/m:.3e}")


# ── A7 下界 −1 触及率 ─────────────────────────────────────────────────────
def a7():
    worst = 0.0
    where = ""
    touch99 = 0
    touch05 = 0
    tot = 0
    for e in ETFS:
        for freq in ("d1", "m15"):
            meta, X, _ = load(e, freq)
            for j, c in enumerate(meta["grid"]):
                v = X[:, j]
                v = v[np.isfinite(v)]
                if v.size == 0:
                    continue
                if v.min() < worst:
                    worst = float(v.min())
                    where = f"{e}/{freq}/{c['id']}"
                touch99 += int((v <= -0.99).sum())
                touch05 += int((v <= -0.5).sum())
                tot += v.size
    check("A7a 全网格最小值 ≥ −1（数学下界）", worst >= -1.0, f"min={worst:.6f} @ {where}")
    check("A7b P(v ≤ −0.99) = 0（下界 −1 触及率 0）", touch99 == 0, f"命中 {touch99}/{tot}")
    check("A7c P(v ≤ −0.5) 极小（非 0，报告须如实列出）", 0 < touch05 / tot < 1e-3,
          f"{touch05}/{tot} = {100*touch05/tot:.4f}%")


# ── A8 确定性（run1 vs run2 全量 sha256）───────────────────────────────────
def a8():
    bad = []
    n = 0
    for freq in ("d1", "d1ns", "d1fine", "m15", "m15fine"):
        for e in ETFS:
            f = f"{e}_{freq}_dcap.f64bin"
            p1, p2 = os.path.join(OUT, "run1", f), os.path.join(OUT, "run2", f)
            if not (os.path.exists(p1) and os.path.exists(p2)):
                bad.append(f + "(missing)")
                continue
            h1 = hashlib.sha256(open(p1, "rb").read()).hexdigest()
            h2 = hashlib.sha256(open(p2, "rb").read()).hexdigest()
            if h1 != h2:
                bad.append(f)
            n += 1
    check("A8 双跑 sha256 全一致", not bad, f"比对 {n} 对，不一致 {bad}")


# ── A9 零穿越 / ACF(1) 复算（n=26, r=1, m=1）───────────────────────────────
def a9():
    import csv
    rep = [x for x in csv.DictReader(open(f"{OUT}/sec1_stats_by_etf_d1.csv"))
           if x["n"] == "26.0" and x["r"] == "1.0" and x["m"] == "1.0"]
    vals = []
    zcs = []
    for e in ETFS:
        meta, X, _ = load(e, "d1")
        col = X[:, meta["grid"].index(next(c for c in meta["grid"] if c["id"] == "n26_r1_m1"))]
        v = col[np.isfinite(col)]
        s = np.sign(v)
        s = s[s != 0]
        zcs.append(float((s[1:] != s[:-1]).sum()) / (s.size - 1))
        a, b = v[:-1], v[1:]
        a = a - a.mean()
        b = b - b.mean()
        vals.append(float((a * b).sum() / math.sqrt((a * a).sum() * (b * b).sum())))
    rep_zc = float(np.median([float(x["zero_cross"]) for x in rep]))
    rep_ac = float(np.median([float(x["acf1"]) for x in rep]))
    check("A9 零穿越中位数复算一致", abs(rep_zc - float(np.median(zcs))) < 1e-9,
          f"报告={rep_zc:.6f} 复算={float(np.median(zcs)):.6f}")
    check("A9b ACF(1) 中位数复算一致", abs(rep_ac - float(np.median(vals))) < 1e-9,
          f"报告={rep_ac:.6f} 复算={float(np.median(vals)):.6f}")


# ── A10 分位分组：OOS h=32 G1 收益 > G5（n=26,r=1,m=3）──────────────────────
def a10():
    sp = []
    for e in ETFS:
        meta, X, closes = load(e, "d1")
        sig = X[:, meta["grid"].index(next(c for c in meta["grid"] if c["id"] == "n26_r1_m3"))]
        T = closes.size
        cut = int(T * 0.7)
        ret = np.full(T, np.nan)
        ret[: T - 32] = closes[32:] / closes[: T - 32] - 1.0
        m = np.zeros(T, bool)
        m[cut:] = True
        ok = m & np.isfinite(sig) & np.isfinite(ret)
        s, rr = sig[ok], ret[ok]
        q = np.quantile(s, [0, 0.2, 0.4, 0.6, 0.8, 1.0])
        q[0], q[-1] = -np.inf, np.inf
        g1 = rr[(s > q[0]) & (s <= q[1])].mean()
        g5 = rr[(s > q[4]) & (s <= q[5])].mean()
        sp.append(g1 - g5)
    check("A10 OOS h=32 G1−G5 多标为正（低 dcap → 高未来收益）", sum(1 for v in sp if v > 0) >= 5,
          f"{sum(1 for v in sp if v > 0)}/7 为正；中位 {np.median(sp)*100:+.3f}%")


def main():
    for fn in (a1, a2, a3, a5, a6, a7, a8, a9, a10):
        fn()
    print()
    print("=" * 70)
    if fails:
        print(f"AUDIT: FAIL ({len(fails)} 条)：{fails}")
    else:
        print("AUDIT: ALL PASS")
    for n in notes:
        print("NOTE:", n)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
