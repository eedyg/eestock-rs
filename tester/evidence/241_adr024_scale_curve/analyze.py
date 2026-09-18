#!/usr/bin/env python3
"""ADR-024 P1 规模曲线分析：从 raw_pre.txt 的 POINT 行提取每点三次重复 → 中位/斜率/模型分解。
用法：python3 analyze.py raw_pre.txt > analysis.txt"""
import re, sys, statistics as st, math

pat = re.compile(r'^POINT tag=(\S+) plugin=(\S+) bars=(\d+) slots=(\d+) warmup=\d+ rep=(\d+) '
                 r'wall_ms=(\d+) wall_s=([\d.]+) bars_per_s=([\d.]+) peak_rss_kb=(\d+) '
                 r'allocs=(\d+) alloc_bytes=(\d+) deallocs=(\d+) reallocs=(\d+) trades=(\d+) per_bar=(\d+) load_ms=(\d+)')

def series_of(tag):
    if tag.startswith('ctrl_'): return 'ctrl(constant_score)'
    if tag.startswith('extra_'): return 'dual_ma(附加点)'
    return 'dual_ma(矩阵)'

pts = {}
timeout_tags = []
cur_tag = None
for line in open(sys.argv[1]):
    l = line.strip()
    if l.startswith('[CMD]') and '--tag ' in l:
        cur_tag = l.split('--tag ')[1].strip()
    if l.startswith('[EXIT] 124'):
        timeout_tags.append(cur_tag)
    m = pat.match(l)
    if m:
        g = m.groups()
        key = (g[0], int(g[2]), int(g[3]))
        pts.setdefault(key, []).append(dict(plugin=g[1], bars=int(g[2]), slots=int(g[3]),
            wall_s=float(g[6]), rss=int(g[8]), allocs=int(g[9]), alloc_bytes=int(g[10]), trades=int(g[13])))

def med(xs): return st.median(xs)
rows = []
for key in sorted(pts, key=lambda k: (series_of(k[0]), k[2], k[1])):
    tag, bars, slots = key
    rs = pts[key]
    ws = [r['wall_s'] for r in rs]
    rows.append(dict(tag=tag, series=series_of(tag), bars=bars, slots=slots, plugin=rs[0]['plugin'],
                     med_wall=med(ws), reps=ws, spread=(max(ws)-min(ws))/med(ws),
                     med_alloc=med(r['alloc_bytes'] for r in rs), med_rss=med(r['rss'] for r in rs),
                     allocs=rs[0]['allocs'], trades=rs[0]['trades']))

print('== 每点三次重复值（中位 + 离散度）==')
print(f"{'series':<20}{'tag':<26}{'bars':>8}{'slots':>6}{'wall_s(3 reps)':>30}{'median':>9}{'spread':>8}{'bars/s':>10}{'alloc_GB':>10}{'rss_MB':>8}")
for r in rows:
    print(f"{r['series']:<20}{r['tag']:<26}{r['bars']:>8}{r['slots']:>6}{str([round(w,4) for w in r['reps']]):>30}"
          f"{r['med_wall']:>9.4f}{r['spread']*100:>7.1f}%{r['bars']/r['med_wall']:>10.0f}{r['med_alloc']/1e9:>10.2f}{r['med_rss']/1024:>8.1f}")
print()
print(f"timeout 点（[EXIT] 124）: {timeout_tags if timeout_tags else '无（全部点在 600s 时限内完成）'}")

def fit_loglog(xs, ys):
    n = len(xs); mx = sum(math.log(x) for x in xs)/n; my = sum(math.log(y) for y in ys)/n
    num = sum((math.log(x)-mx)*(math.log(y)-my) for x, y in zip(xs, ys))
    den = sum((math.log(x)-mx)**2 for x in xs)
    slope = num/den; inter = my - slope*mx
    resid = [math.log(y) - (inter + slope*math.log(x)) for x, y in zip(xs, ys)]
    return slope, inter, math.sqrt(sum(r*r for r in resid)/len(resid))

print()
print('== log-log 斜率（t ~ n^s）——全域拟合 vs 大 n 局部斜率 vs 渐近拟合 ==')
groups = {}
for r in rows:
    groups.setdefault((r['series'], r['slots']), []).append(r)
for (series, slots), rs in sorted(groups.items()):
    rs = sorted(rs, key=lambda r: r['bars'])
    xs = [r['bars'] for r in rs]; ys = [r['med_wall'] for r in rs]
    s_all, i_all, rms_all = fit_loglog(xs, ys)
    print(f"\n-- {series} slots={slots} --")
    print(f"   全域拟合（全部 {len(xs)} 点，n={xs[0]}..{xs[-1]}）: slope={s_all:.3f} rms_resid(log)={rms_all:.4f}")
    for a, b in zip(rs, rs[1:]):
        if a['bars'] == b['bars']: continue
        s = math.log(b['med_wall']/a['med_wall'])/math.log(b['bars']/a['bars'])
        print(f"   局部斜率 {a['bars']:>7} → {b['bars']:>7} : {s:.3f}  ({a['med_wall']:.4f}s → {b['med_wall']:.4f}s)")
    for label, sub in (('大 n 渐近拟合 (n>=20000)', [r for r in rs if r['bars'] >= 20000]),
                       ('大 n 渐近拟合 (n>=50000)', [r for r in rs if r['bars'] >= 50000])):
        if len(sub) < 2: continue
        s, i, rms = fit_loglog([r['bars'] for r in sub], [r['med_wall'] for r in sub])
        print(f"   {label}: n={len(sub)} slope={s:.3f} intercept={i:.4f} rms_resid(log)={rms:.4f}")
    # t/n² 归一化（二次项指纹：随 n 增大收敛到常数）
    print("   t/n² (s/bar²) 逐点: " + ", ".join(f"n={r['bars']}:{r['med_wall']/(r['bars']**2):.3e}" for r in rs))

print()
print('== 两模型拟合：t = a·n² + b·n（标准化 x=n/n_ref + 一维网格搜索 r=A/B，避免法方程病态）')
print('   对比基线模型 t = c·n；R² 用线性空间 SSE ==')
def fit_two_term(sub):
    n_ref = max(r['bars'] for r in sub)
    xs = [r['bars']/n_ref for r in sub]; ys = [r['med_wall'] for r in sub]
    best = None
    for k in range(0, 4001):
        r = 10**(-2 + 5*k/4000)           # r = A/B ∈ [1e-2, 1e3]
        us = [x*x + x/r for x in xs]
        A = sum(y*u for y, u in zip(ys, us))/sum(u*u for u in us)
        sse = sum((y - A*u)**2 for y, u in zip(ys, us))
        if best is None or sse < best[0]:
            best = (sse, r, A)
    sse, r, A = best
    ybar = sum(ys)/len(ys); sst = sum((y-ybar)**2 for y in ys)
    a = A/n_ref**2; b = (A/r)/n_ref
    return a, b, 1-sse/sst, n_ref, sst

for (series, slots), rs in sorted(groups.items()):
    sub = [r for r in rs if r['bars'] >= 5000]
    if len(sub) < 3: continue
    a, b, r2, n_ref, sst = fit_two_term(sub)
    xs = [r['bars'] for r in sub]; ys = [r['med_wall'] for r in sub]
    c = sum(y*x for x, y in zip(xs, ys))/sum(x*x for x in xs)
    sse1 = sum((y - c*x)**2 for x, y in zip(xs, ys))
    print(f"\n-- {series} slots={slots} （拟合点 n={xs}）--")
    print(f"   模型 t=a·n²+b·n : a={a:.4e} s/bar², b={b:.4e} s/bar, R²={r2:.6f}")
    print(f"   模型 t=c·n      : c={c:.4e} s/bar,                R²={1-sse1/sst:.6f}")
    for n in (1000, 5000, 15000, 20000, 50000, 200000, 290000):
        t2 = a*n*n; t1 = b*n
        print(f"   n={n:>7}: n²项={t2:>8.4f}s ({t2/(t2+t1)*100:5.1f}%) / n项={t1:>7.4f}s ({t1/(t2+t1)*100:4.1f}%) 合计≈{t2+t1:>9.4f}s")
    print(f"   渐近等效复制带宽 = 24 B/bar² ÷ a = {24/a/1e9:.1f} GB/s（复制量 48B×n²/2 = 24n² 字节）")

print()
print('== 分配量 vs ADR §2.2 预测（Σ(i+1)×48 B × slots）==')
for r in sorted(rows, key=lambda r: (r['slots'], r['bars'])):
    n = r['bars']; pred = r['slots']*48*n*(n+1)/2
    print(f"{r['series']:<20} n={n:>7} slots={r['slots']} 实测alloc={r['med_alloc']/1e9:>10.2f} GB "
          f"预测={pred/1e9:>10.2f} GB 比值={r['med_alloc']/pred:.4f} alloc_count={r['allocs']} ({r['allocs']/n:.1f}/bar)")

print()
print('== ADR §2.2 量级核算实测对照（本轮实测，中位）==')
def lookup(name):
    for r in rows:
        if r['tag'] == name: return r
    return None
for tag, label, n_pred_gb, adr in [
    ('extra_93d_n15000_s1', 'M1×93 天（=15,000 bar，现护栏上限）', 48*15000*15001/2/1e9, '≈5.4 GB'),
    ('extra_93d_n15000_s3', 'M1×93 天 × 3 slots', 3*48*15000*15001/2/1e9, '—'),
    ('extra_5y_n290000_s1', 'M1×5 年（=290,000 bar）', 48*290000*290001/2/1e9, '≈2.0 TB'),
    ('extra_5y_n290000_s3', 'M1×5 年 × 3 slots', 3*48*290000*290001/2/1e9, '—'),
    ('dual_ma_n200000_s1', 'M1 200,000 bar（矩阵上界）', 48*200000*200001/2/1e9, '—'),
]:
    r = lookup(tag)
    if r:
        print(f"{label:<34} 实测墙钟={r['med_wall']:>8.4f}s  峰值RSS={r['med_rss']/1024:>6.1f} MB  "
              f"实测alloc={r['med_alloc']/1e9:>8.2f} GB  ADR预测={adr}")
