#!/usr/bin/env python3
"""ADR-024 P2 独立验收 ②：规模曲线分析（tester 自研，不复用 analyze.py）。

用法：python3 analyze_p2.py <raw1.txt> [raw2.txt ...]

与 tester/evidence/241_adr024_scale_curve/analyze.py 的关系：口径（POINT 行正则、三次重复取中位、
log-log 最小二乘、局部斜率、两模型拟合）**逐项对齐**，但：
  - 归组改为**按 tag 前缀**（harness 的 `plugin=` 字段不反映 `--plugin-file`，见 run_scale_post_heavy.sh 注）；
  - 新增**判据级 PASS/FAIL**（三指纹：t/n² 收敛、alloc 线性、局部斜率单调 + 渐近斜率 ∈ [0.9,1.1]）。
"""
import math
import re
import statistics as st
import sys

PAT = re.compile(
    r'^POINT tag=(\S+) plugin=(\S+) bars=(\d+) slots=(\d+) warmup=\d+ rep=(\d+) '
    r'wall_ms=(\d+) wall_s=([\d.]+) bars_per_s=([\d.]+) peak_rss_kb=(\d+) '
    r'allocs=(\d+) alloc_bytes=(\d+) deallocs=(\d+) reallocs=(\d+) trades=(\d+) per_bar=(\d+) load_ms=(\d+)'
)


def series_of(tag):
    if tag.startswith('alloc_dbl_dual_'):
        return 'dual_ma(翻倍点)'
    if tag.startswith('alloc_dbl_heavy_'):
        return 'indicator_heavy(翻倍点)'
    if tag.startswith('ctrl_'):
        return 'ctrl(constant_score)'
    if tag.startswith('heavy_extra_'):
        return 'indicator_heavy(附加点)'
    if tag.startswith('heavy_'):
        return 'indicator_heavy(矩阵)'
    if tag.startswith('extra_'):
        return 'dual_ma(附加点)'
    if tag.startswith('dual_ma_') or tag.startswith('pre_'):
        return 'dual_ma(矩阵)'
    return 'unknown(' + tag + ')'


pts = {}
timeouts = []
cur = None
for path in sys.argv[1:]:
    for line in open(path):
        l = line.strip()
        if l.startswith('[CMD]') and '--tag ' in l:
            cur = l.split('--tag ')[1].strip()
            continue
        if l.startswith('[EXIT] 124'):
            timeouts.append((path, cur))
            continue
        m = PAT.match(l)
        if m:
            g = m.groups()
            pts.setdefault((g[0], int(g[2]), int(g[3])), []).append(
                dict(bars=int(g[2]), slots=int(g[3]), wall=float(g[6]), rss=int(g[8]),
                     allocs=int(g[9]), bytes=int(g[10]), trades=int(g[13]), load=int(g[15])))

rows = []
for key in sorted(pts, key=lambda k: (series_of(k[0]), k[2], k[1])):
    tag, bars, slots = key
    rs = pts[key]
    ws = [r['wall'] for r in rs]
    rows.append(dict(tag=tag, series=series_of(tag), bars=bars, slots=slots, reps=ws,
                     med=st.median(ws), spread=(max(ws) - min(ws)) / max(st.median(ws), 1e-12),
                     alloc=st.median(r['bytes'] for r in rs), rss=st.median(r['rss'] for r in rs),
                     allocs=rs[0]['allocs'], trades=rs[0]['trades'], load=rs[0]['load']))

print('== ① 每点三次重复（中位 / 离散度 / 吞吐 / 分配）==')
hdr = f"{'series':<26}{'tag':<30}{'bars':>8}{'slots':>6}{'median_s':>10}{'spread':>8}{'bars/s':>10}{'alloc_MB':>11}{'rss_MB':>8}"
print(hdr)
for r in rows:
    print(f"{r['series']:<26}{r['tag']:<30}{r['bars']:>8}{r['slots']:>6}{r['med']:>10.4f}"
          f"{r['spread']*100:>7.1f}%{r['bars']/max(r['med'],1e-9):>10.0f}{r['alloc']/1e6:>11.2f}{r['rss']/1024:>8.1f}")
print()
print(f"timeout 点（[EXIT] 124）: {timeouts if timeouts else '无'}")


def fit(xs, ys):  # log-log 最小二乘
    n = len(xs)
    mx = sum(math.log(x) for x in xs) / n
    my = sum(math.log(y) for y in ys) / n
    num = sum((math.log(x) - mx) * (math.log(y) - my) for x, y in zip(xs, ys))
    den = sum((math.log(x) - mx) ** 2 for x in xs)
    s = num / den
    inter = my - s * mx
    resid = [math.log(y) - (inter + s * math.log(x)) for x, y in zip(xs, ys)]
    return s, math.sqrt(sum(r * r for r in resid) / n)


groups = {}
for r in rows:
    groups.setdefault((r['series'], r['slots']), []).append(r)

print()
print('== ② 渐近斜率（t ~ n^s）与三指纹 ==')
verdicts = {}
for (series, slots), rs in sorted(groups.items()):
    rs = sorted(rs, key=lambda r: r['bars'])
    xs = [r['bars'] for r in rs]
    ys = [r['med'] for r in rs]
    print(f"\n---- {series} slots={slots}  （n={xs[0]}..{xs[-1]}，{len(xs)} 点）----")
    if len(xs) >= 2:
        s_all, rms = fit(xs, ys)
        print(f"   全域 log-log 拟合: slope={s_all:.3f} rms_resid(log)={rms:.4f}")
    print("   局部逐段斜率（相邻点）:")
    for a, b in zip(rs, rs[1:]):
        if a['bars'] == b['bars']:
            continue
        s = math.log(b['med'] / a['med']) / math.log(b['bars'] / a['bars'])
        print(f"     {a['bars']:>7} -> {b['bars']:>7}: slope={s:>6.3f}  ({a['med']:.4f}s -> {b['med']:.4f}s)")

    # 指纹 1：t/n² —— 二次 ⇒ 收敛到非零常数；线性 ⇒ ∝1/n（相邻两点比值 ≈ n 比）
    print("   [指纹1] t/n² (s/bar²) 逐点: " + ", ".join(
        f"n={r['bars']}:{r['med']/(r['bars']**2):.4e}" for r in rs))
    big = [r for r in rs if r['bars'] >= 20000]
    if len(big) >= 2:
        vals = [r['med'] / (r['bars'] ** 2) for r in big]
        decay_ratio = vals[0] / vals[-1]
        size_ratio = big[-1]['bars'] / big[0]['bars']
        f1 = decay_ratio > 1.5 * math.sqrt(size_ratio)  # 衰减显著快于常数
        print(f"   [指纹1] t/n² 衰减：n={big[0]['bars']}→{big[-1]['bars']} 时 "
              f"{vals[0]:.4e}→{vals[-1]:.4e}（衰减 {decay_ratio:.2f}×，n 比 {size_ratio:.1f}×）"
              f" ⇒ {'已塌缩（无二次项平台）PASS' if f1 else 'FAIL（疑似非零二次项）'}")
    else:
        f1 = None

    # 指纹 2：alloc_bytes 随 n 翻倍
    print("   [指纹2] alloc_bytes 逐点: " + ", ".join(
        f"n={r['bars']}:{r['alloc']/1e6:.2f}MB" for r in rs))
    byn = {r['bars']: r for r in rs}
    ratios = []
    for n in sorted(byn):
        if 2 * n in byn and n > 0:
            rr = byn[2 * n]['alloc'] / byn[n]['alloc']
            ratios.append((n, 2 * n, rr))
            print(f"   [指纹2] alloc 比 n={n}→{2*n}: {byn[n]['alloc']/1e6:.2f}MB → "
                  f"{byn[2*n]['alloc']/1e6:.2f}MB = {rr:.3f}")
    f2 = all(1.7 <= rr <= 2.3 for _, _, rr in ratios) if ratios else None

    # 指纹 3：局部斜率单调（随 n 增大不上升；容许 0.05 抖动）
    #   仅取**两端点 n≥20000** 的段（小 n 段 wall_ms 为整数毫秒量化，噪声可达 ±20%，无鉴别力；
    #   该量化对 pre/post 两侧同等存在，故 pre/post 对照不受影响）。
    sl = []
    for a, b in zip(rs, rs[1:]):
        if a['bars'] == b['bars']:
            continue
        sl.append((a['bars'], b['bars'],
                   math.log(b['med'] / a['med']) / math.log(b['bars'] / a['bars'])))
    sl_big = [t for t in sl if t[0] >= 20000]
    f3 = None
    if len(sl_big) >= 2:
        f3 = True
        for (n1, n2, s1), (n3, n4, s2) in zip(sl_big, sl_big[1:]):
            if n2 != n3:
                continue
            if s2 > s1 + 0.05:
                f3 = False
                print(f"   [指纹3] 局部斜率上升：{n2}->{n4} 段 {s2:.3f} > 前段 {s1:.3f}+0.05 ⇒ FAIL")
        if f3:
            print("   [指纹3] 渐近段局部斜率逐段不上升（无上升趋势）PASS")
    else:
        print("   [指纹3] 渐近段不足 2 段（锚点/补测组）⇒ N/A")

    # 判据：渐近斜率 ∈ [0.9,1.1]
    sub20 = [r for r in rs if r['bars'] >= 20000]
    if len(sub20) >= 2:
        s20 = fit([r['bars'] for r in sub20], [r['med'] for r in sub20])[0]
        label = f"n>=20000 渐近拟合（{len(sub20)} 点）"
    elif len(rs) >= 2:
        s20 = fit([r['bars'] for r in rs[-2:]], [r['med'] for r in rs[-2:]])[0]
        label = f"锚点组（仅 {rs[-2]['bars']}/{rs[-1]['bars']} 两点，整体斜率）"
    else:
        s20, label = None, "点数不足"
    sub50 = [r for r in rs if r['bars'] >= 50000]
    s50 = fit([r['bars'] for r in sub50], [r['med'] for r in sub50])[0] if len(sub50) >= 2 else None
    # 噪声带：用 3 次重复各自的独立估计（每点第 k 次）重算渐近斜率，给出上下界。
    nrep = min(len(r['reps']) for r in rs)
    if len(sub20) >= 2 and nrep >= 2:
        est = []
        for k in range(nrep):
            est.append(fit([r['bars'] for r in sub20], [r['reps'][k] for r in sub20])[0])
        print(f"   [噪声带] 渐近斜率 per-rep 独立估计 = {[round(e,3) for e in est]} "
              f"（min={min(est):.3f} / max={max(est):.3f}）")

    print(f"   [判据] {label} 斜率={s20 if s20 is None else round(s20,3)}  "
          f"n>=50000 斜率={s50 if s50 is None else round(s50,3)}")
    ok20 = s20 is not None and 0.9 <= s20 <= 1.1
    print(f"   [判据] 斜率 ∈ [0.9,1.1] : {'PASS' if ok20 else 'FAIL'}")
    verdicts[(series, slots)] = dict(f1=f1, f2=f2, f3=f3, s20=s20, ok20=ok20)

print()
print('== ③ 两模型拟合 t = a·n² + b·n vs t = c·n（n>=5000 点）==')


def fit_two(sub):
    n_ref = max(r['bars'] for r in sub)
    xs = [r['bars'] / n_ref for r in sub]
    ys = [r['med'] for r in sub]
    best = None
    for k in range(0, 4001):
        r = 10 ** (-2 + 5 * k / 4000)
        us = [x * x + x / r for x in xs]
        A = sum(y * u for y, u in zip(ys, us)) / sum(u * u for u in us)
        sse = sum((y - A * u) ** 2 for y, u in zip(ys, us))
        if best is None or sse < best[0]:
            best = (sse, r, A)
    sse, r, A = best
    ybar = sum(ys) / len(ys)
    sst = sum((y - ybar) ** 2 for y in ys)
    return A / n_ref ** 2, (A / r) / n_ref, 1 - sse / sst, sst


for (series, slots), rs in sorted(groups.items()):
    sub = [r for r in rs if r['bars'] >= 5000]
    if len(sub) < 3:
        continue
    a, b, r2, sst = fit_two(sub)
    xs = [r['bars'] for r in sub]
    ys = [r['med'] for r in sub]
    c = sum(y * x for x, y in zip(xs, ys)) / sum(x * x for x in xs)
    sse1 = sum((y - c * x) ** 2 for x, y in zip(xs, ys))
    print(f"   -- {series} slots={slots} 点 n={xs} --")
    print(f"      t=a·n²+b·n : a={a:.4e} s/bar²  b={b:.4e} s/bar  R²={r2:.6f}")
    print(f"      t=c·n      : c={c:.4e} s/bar                 R²={1-sse1/sst:.6f}")
    for n in sorted({1000, 5000, 15000, 20000, 50000, 200000, 290000}):
        t2 = a * n * n
        t1 = b * n
        if t2 + t1 > 0:
            print(f"      n={n:>7}: n²项={t2:>8.4f}s ({t2/(t2+t1)*100:5.1f}%) / n项={t1:>8.4f}s ({t1/(t2+t1)*100:5.1f}%)")

print()
print('== ④ 三指纹总判定 ==')
CRITERION = {('dual_ma(矩阵)', 1), ('dual_ma(矩阵)', 3),
             ('indicator_heavy(矩阵)', 1), ('indicator_heavy(矩阵)', 3)}
allok = True
for k, v in sorted(verdicts.items()):
    crit = k in CRITERION
    f2 = v['f2']
    f2src = '本组'
    if f2 is None and k[0].endswith('(矩阵)'):
        alt = verdicts.get((k[0].replace('(矩阵)', '(翻倍点)'), k[1]))
        if alt is not None:
            f2 = alt['f2']
            f2src = '翻倍点组'
    tag = f"{k[0]} slots={k[1]}"
    print(f"   {tag:<44} 指纹1(t/n²塌缩)={v['f1']}  指纹2(alloc线性)={f2}({f2src})  "
          f"指纹3(斜率不上升)={v['f3']}  渐近斜率∈[0.9,1.1]={v['ok20']}"
          f"  {'← 判据组' if crit else '(参考组，不计入总判定)'}")
    if crit and (v['ok20'] is not True or v['f1'] is not True or f2 is not True or v['f3'] is not True):
        allok = False
        print(f"      ^^^ 判据组未过：ok20={v['ok20']} f1={v['f1']} f2={f2} f3={v['f3']}")
print()
print(f"== 总判定（仅判据组：dual_ma / indicator_heavy × slots 1,3）: {'PASS' if allok else 'FAIL'} ==")
