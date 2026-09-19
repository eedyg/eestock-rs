import json, urllib.request, sys, math
BASE="http://127.0.0.1:8081/api/workbench/runs/"
def get(path):
    with urllib.request.urlopen(BASE+path) as r: return json.loads(r.read())
def getall(run, ep, extra=""):
    out=[]; off=0
    while True:
        d=get(f"{run}/{ep}?offset={off}&limit=20000{extra}")
        key="round_trips" if ep=="round-trips" else "fills"
        out+=d[key]
        if not d.get("has_more"): return d, out
        off=d["next_offset"]
def TOL(a,b):
    return abs(a-b)<=1e-6*max(1.0,abs(a))
def close(a,b,t=1e-9): return abs(a-b)<=t*max(1.0,abs(a),abs(b))
res={"runs":{}}
runs=json.load(open(sys.argv[1]))
for run in runs:
    rec={"run":run,"i1_mismatch":[],"i3":None,"i4":None,"position":[],"checks":0}
    runinfo=get(run)
    ic=runinfo["config"]["initial_capital"]
    rtd, rts = getall(run,"round-trips")
    fd, fills = getall(run,"fills")
    audit=get(run+"/audit")
    result=get(run+"/result?offset=0&limit=20000")
    trades=result["trades"]
    byrt={}
    for f in fills: byrt.setdefault(f["rt_seq"],[]).append(f)
    inv={}
    for t in rts:
        rtf=byrt.get(t["rt_seq"],[])
        buys=[f for f in rtf if f["side"]=="Buy"]; sells=[f for f in rtf if f["side"]=="Sell"]
        exp={
         "l2_count":len(rtf),"buy_count":len(buys),"sell_count":len(sells),
         "gross_value":sum(f["trade_value"] for f in sells),
         "commission":sum(f["commission"] for f in rtf),
         "stamp_duty":sum(f["stamp_duty"] for f in sells),
         "shares":sum(f["qty"] for f in buys),
         "open_price": (sum(f["trade_value"] for f in buys)/sum(f["qty"] for f in buys)) if buys else None,
         "close_price": (sum(f["trade_value"] for f in sells)/sum(f["qty"] for f in sells)) if sells else None,
         "open_bar": min((f["bar_index"] for f in buys), default=None),
         "open_ts": min((f["ts"] for f in rtf), default=None),
         "close_bar": (max(f["bar_index"] for f in sells) if sells else None),
         "close_ts": (max(f["ts"] for f in sells) if sells else None),
        }
        exp["hold_bars"] = (exp["close_bar"]-exp["open_bar"]) if (sells and exp["open_bar"] is not None) else None
        invested=sum(f["trade_value"]+f["commission"] for f in buys)
        proceeds=sum(f["trade_value"]-f["commission"]-f["stamp_duty"] for f in sells)
        exp["pnl"]= (proceeds-invested) if (sells and t["status"]=="Closed") else None
        exp["reason"]= sells[-1]["reason"] if sells else None
        rec["checks"]+=1
        for k,v in exp.items():
            av=t.get(k)
            if isinstance(v,float) or isinstance(av,float):
                if v is None or av is None:
                    if v!=av: rec["i1_mismatch"].append([t["rt_seq"],k,av,v])
                elif not close(av,v): rec["i1_mismatch"].append([t["rt_seq"],k,av,v])
            elif av!=v: rec["i1_mismatch"].append([t["rt_seq"],k,av,v])
        # status / pnl None rules
        if t["status"]=="Open" and t["pnl"] is not None: rec["i1_mismatch"].append([t["rt_seq"],"open_pnl_not_null",t["pnl"],None])
        # fill-level invariants
        for f in rtf:
            if not close(f["trade_value"], f["qty"]*f["price"]): rec["i1_mismatch"].append([t["rt_seq"],"trade_value!=qty*price",f["trade_value"],f["qty"]*f["price"]])
            if f["side"]=="Buy" and f["stamp_duty"]!=0.0: rec["i1_mismatch"].append([t["rt_seq"],"buy_stamp_duty!=0",f["stamp_duty"],0.0])
            if f["ts"]%1!=0: rec["i1_mismatch"].append([t["rt_seq"],"ts not int",f["ts"],None])
    inv["round_trips"]=len(rts); inv["realized_pnl_sum"]=sum(t["pnl"] for t in rts if t["status"]=="Closed" and t["pnl"] is not None)
    closed_pnl=sum(t["pnl"] for t in rts if t["status"]=="Closed" and t["pnl"] is not None)
    open_leg=0.0
    for t in rts:
        if t["status"]!="Open": continue
        rtf=byrt.get(t["rt_seq"],[])
        buys=[f for f in rtf if f["side"]=="Buy"]; sells=[f for f in rtf if f["side"]=="Sell"]
        invested=sum(f["trade_value"]+f["commission"] for f in buys)
        gross=sum(f["trade_value"] for f in sells)
        poslast=(sum(buys_qty for buys_qty in [sum(f["qty"] for f in buys)-sum(f["qty"] for f in sells)]))
        open_leg += gross - invested + 0.0
    posr=get(run+"/curve?kind=position&k=2000")
    pts=posr["points"]
    nav_last=pts[-1]["nav"] if pts else None
    lhs=nav_last; rhs=ic+closed_pnl+open_leg
    rec["i3"]={"nav_last":lhs,"rhs":rhs,"delta":None if lhs is None else lhs-rhs,"tolerance":1e-6*max(1,abs(lhs)) if lhs is not None else None,
               "pass": (lhs is not None and TOL(lhs,rhs))}
    # position series self-consistency
    posbad=[]
    for p in pts:
        if not close(p["position_value"]+p["cash"], p["nav"]): posbad.append(["pv+cash!=nav",p])
        if p["nav"]>0:
            if not close(p["position_ratio"], p["position_value"]/p["nav"]): posbad.append(["ratio!=pv/nav",p])
        else:
            if p["position_ratio"]!=0.0: posbad.append(["nav<=0 ratio!=0",p])
        if p["nav"] != p["cash"]+p["position_value"]: posbad.append(["nav!=cash+pv",p])
    ts=[p["ts"] for p in pts]
    if ts!=sorted(ts): posbad.append(["ts not monotonic",None])
    rec["position"]={"points":len(pts),"bad":posbad[:5],"bad_count":len(posbad),"monotonic":ts==sorted(ts)}
    # I4
    distinct=sorted(byrt.keys())
    force_closed_fills=len({f["rt_seq"] for f in fills if f["reason"]=="ForceClose"})
    rec["i4"]={"distinct_rt_seq":len(distinct),"distinct_list":distinct if len(distinct)<=60 else distinct[:20]+["..."]+distinct[-5:],
               "trades_len":len(trades),"audit_total":audit["round_trips_total"],
               "closed":audit["round_trips_closed"],"open":audit["round_trips_open"],
               "force_closed":audit["round_trips_force_closed"],"force_closed_reasons":force_closed_fills,
               "closed_rt_in_list":sum(1 for t in rts if t["status"]=="Closed"),
               "open_rt_in_list":sum(1 for t in rts if t["status"]=="Open"),
               "pass": len(distinct)==len(trades)==audit["round_trips_total"] and audit["round_trips_total"]==len(rts)
                       and audit["round_trips_force_closed"]==force_closed_fills
                       and audit["round_trips_closed"]==sum(1 for t in rts if t["status"]=="Closed")
                       and audit["round_trips_open"]==sum(1 for t in rts if t["status"]=="Open")}
    rec["rt_reconcile"]=audit["rt_reconcile"]
    rec["rt_envelope"]={"total":rtd["total"],"recorded":rtd.get("recorded"),"has_more":rtd.get("has_more"),"next_offset":rtd.get("next_offset"),"count":len(rts)}
    rec["fills_envelope"]={"total":fd["total"],"recorded":fd.get("recorded"),"count":len(fills)}
    res["runs"][run]=rec
print(json.dumps(res,ensure_ascii=False,indent=1))
