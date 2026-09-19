import json, urllib.request
BASE="http://127.0.0.1:8081/api/workbench/runs/"
def get(p):
    with urllib.request.urlopen(BASE+p) as r: return json.loads(r.read())
run="sr_1789832517800_000006"
full=get(run+"/curve?kind=position&k=2000")
ts=[p["ts"] for p in full["points"]]
print("FULL position: n=%d downsampled=%s original_bars=%d k=%d window_from=%s window_to=%s window_bars=%s"%(len(ts),full["downsampled"],full["original_bars"],full["k"],full["window_from_ts"],full["window_to_ts"],full["window_bars"]))
w0,w1=ts[700],ts[899]
cases=[("mid200_k8",w0,w1,8),("mid200_k2000",w0,w1,2000),("mid200_k1",w0,w1,1),("fullrange_k8",ts[0],ts[-1],8),
       ("subbar_off",w0+60,w1,8),("empty_window",ts[-1]+86400,ts[-1]+172800,8),("one_bar",ts[5],ts[5],8),("rev_window",w1,w0,8)]
out=[]
for name,f,t,k in cases:
    d=get(f"{run}/curve?kind=position&from_ts={f}&to_ts={t}&k={k}")
    pts=d["points"]; tss=[p["ts"] for p in pts]
    inrange=all(f<=x<=t for x in tss)
    raw_in_window=len([x for x in ts if f<=x<=t])
    out.append(dict(case=name,req=(f,t,k),points=len(pts),downsampled=d["downsampled"],original_bars=d["original_bars"],k_resp=d["k"],
                    window_from_ts=d["window_from_ts"],window_to_ts=d["window_to_ts"],window_bars=d["window_bars"],
                    raw_bars_in_window=raw_in_window,echo_ok=(d["window_from_ts"]==f and d["window_to_ts"]==t and d["window_bars"]==raw_in_window),
                    all_in_window=inrange,first_ts=tss[0] if tss else None,last_ts=tss[-1] if tss else None,ts_minus_req=(tss[0]-f if tss else None)))
    print(json.dumps(out[-1],ensure_ascii=False))
# cross-kind window consistency
for kind in ["position","net_value","drawdown","per_bar"]:
    d=get(f"{run}/curve?kind={kind}&from_ts={w0}&to_ts={w1}&k=2000")
    tss=[p["ts"] for p in d["points"]]
    print("kind=%s n=%d window_echo=(%s,%s) window_bars=%s first=%s last=%s"%(kind,len(tss),d["window_from_ts"],d["window_to_ts"],d["window_bars"],tss[0] if tss else None,tss[-1] if tss else None))
json.dump(out,open("tester/evidence/20260920_adr027_accept_e/raw/11_window_cases.json","w"),ensure_ascii=False,indent=1)
