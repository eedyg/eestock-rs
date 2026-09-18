import csv, statistics as st
import numpy as np
rows=[r for r in csv.DictReader(open('runs_p1c.csv'))]
for r in rows:
    r['bars']=int(r['bars']); r['slots']=int(r['slots']); r['dur']=float(r['dur_s']); r['conc']=int(r['concurrent'])
hist=[r for r in rows if r['started_at'] < '2026-09-14']   # 只取 374 条历史 run（排除本轮 P1c 自建 run）
p1c =[r for r in rows if r['started_at'] >= '2026-09-14']
def frames(r): return min(1001, r['bars'])
def frames2(r): return min(1001, r['bars'])+2
def fit(rs, X, names):
    A=np.column_stack([np.ones(len(rs))]+[np.array([f(r) for r in rs],float) for f in X])
    y=np.array([r['dur'] for r in rs],float)
    c,*_=np.linalg.lstsq(A,y,rcond=None)
    yh=A@c; ss=((y-yh)**2).sum(); tot=((y-y.mean())**2).sum()
    r2=1-ss/tot; rmse=(ss/len(rs))**.5
    return c,r2,rmse
def show(tag,rs,X,names):
    c,r2,rmse=fit(rs,X,names); n=len(rs)
    eq=" + ".join([f"{c[0]:.4f}"]+[f"{v:.6g}*{nm}" for v,nm in zip(c[1:],names)])
    print(f"{tag:<52} N={n:3d}  dur = {eq}   R2={r2:.4f} rmse={rmse:.4f}s")
    return c,r2,rmse
print("== 样本 ==")
print(f"历史 succeeded run: N={len(hist)}  bars=[{min(r['bars'] for r in hist)}..{max(r['bars'] for r in hist)}] median={st.median(r['bars'] for r in hist)}")
print(f"  dur: median={st.median(r['dur'] for r in hist):.3f}s mean={st.mean(r['dur'] for r in hist):.3f}s")
print(f"  concurrent 分布: " + str({k:sum(1 for r in hist if r['conc']==k) for k in sorted({r['conc'] for r in hist})}))
print(f"本轮 P1c 自建 run: N={len(p1c)}（不参与历史拟合）")
clean=[r for r in hist if r['conc']==0]; dirty=[r for r in hist if r['conc']>0]
print(f"  同刻无并发(concurrent=0) N={len(clean)}  有并发 N={len(dirty)}")
print()
print("== 上轮 fit.txt 基线（全样本）复现/对照 ==")
show("A  dur ~ bars (全样本, 上轮口径)",hist,[lambda r:r['bars']],['bars'])
show("B  dur ~ bars*slots (全样本, 上轮口径)",hist,[lambda r:r['bars']*r['slots']],['bars*slots'])
print()
print("== ③ 新模型：每 run 固定成本（帧数）===")
show("C  dur ~ min(1001,bars)      (全样本)",hist,[frames],['frames'])
show("D  dur ~ min(1001,bars)+2    (全样本)",hist,[frames2],['frames+2'])
show("C' dur ~ min(1001,bars)      (无并发子集)",clean,[frames],['frames'])
show("D' dur ~ min(1001,bars)+2    (无并发子集)",clean,[frames2],['frames+2'])
print()
print("== ③ 协变量：并发度 / slots ==")
show("E  dur ~ frames2 + concurrent        (全样本)",hist,[frames2,lambda r:r['conc']],['frames+2','concurrent'])
show("E' dur ~ frames2 + concurrent + slots(全样本)",hist,[frames2,lambda r:r['conc'],lambda r:r['slots']],['frames+2','concurrent','slots'])
show("F  dur ~ bars + concurrent           (全样本)",hist,[lambda r:r['bars'],lambda r:r['conc']],['bars','concurrent'])
print()
print("== ③ 分周期（无并发子集 vs 全样本）==")
for p in ['D1','H1','M15','M5']:
    sub=[r for r in hist if r['period']==p]; subc=[r for r in clean if r['period']==p]
    if not sub: continue
    c1,r21,_=fit(sub,[lambda r:r['bars']],['bars']) if len(sub)>2 else ([0,0],float('nan'),0)
    if len(subc)>2:
        c2,r22,_=fit(subc,[lambda r:r['bars']],['bars'])
        s2=f"clean N={len(subc):3d} c0={c2[0]:+.4f}s c1={c2[1]*1e6:8.1f}us/bar R2={r22:.4f}"
    else:
        s2=f"clean N={len(subc):3d} (样本不足)"
    print(f"  {p:<4} all N={len(sub):3d} c0={c1[0]:+.4f}s c1={c1[1]*1e6:8.1f}us/bar R2={r21:.4f} | {s2}")
print()
print("== ③ 无并发子集：分档 dur vs 帧数预测（c1 由 D' 给出）==")
c,r2,_=fit(clean,[frames2],['frames+2']); c1=c[1]
for lo,hi in [(0,600),(601,1001),(1002,1001)]:
    sub=[r for r in clean if lo<=min(1001,r['bars'])+2<=hi]
    if sub:
        pred=st.median([c1*frames2(r)+c[0] for r in sub])
        print(f"  帧数[{lo},{hi}] N={len(sub):3d} 中位 dur={st.median(r['dur'] for r in sub):.3f}s 预测={pred:.3f}s")
print()
print("== 每帧成本 c1 汇总（dur / (min(1001,bars)+2)）==")
ratios=[r['dur']/frames2(r) for r in hist]
print(f"  全样本 N={len(hist)} 中位={st.median(ratios)*1000:.3f} ms/帧  均值={st.mean(ratios)*1000:.3f} ms/帧  p10={np.percentile(ratios,10)*1000:.3f} p90={np.percentile(ratios,90)*1000:.3f} ms/帧")
rc=[r['dur']/frames2(r) for r in clean]
print(f"  无并发 N={len(clean)} 中位={st.median(rc)*1000:.3f} ms/帧")
print()
print("== 本轮 P1c 真路径自建 run（长窗口协议实测 Δ）==")
for r in p1c:
    print(f"  {r['id']} {r['period']:<3} bars={r['bars']:>6} dur={r['dur']:.3f}s 帧数={frames2(r):>4} dur/帧={r['dur']/frames2(r)*1000:.2f} ms  concurrent={r['conc']}")
