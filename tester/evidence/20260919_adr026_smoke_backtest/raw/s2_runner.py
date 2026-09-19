import json,sys,time,urllib.request
sys.path.insert(0,"/tmp")
from mcp import MCP
D="tester/evidence/20260919_adr026_smoke_backtest/raw"
args={"name":"smoke_adr026_S2_MCP_518880_D1_2025","symbol":"518880","period":"D1",
 "from":"2025-01-01T00:00:00Z","to":"2025-12-31T00:00:00Z",
 "slots":[{"strategy_id":"st_1789211089727_000009","version_id":"sv_1789211089727_000010","params":{"cadence":20,"plan_bars":5},"weight":1.0}],
 "buy_threshold":60.0,"sell_threshold":40.0,
 "policy":{"Dca":{"tranches":3,"interval":5,"mode":"Equal"}},"initial_capital":100000.0}
open(f"{D}/s2_01_mcp_submit_args.json","w").write(json.dumps(args,ensure_ascii=False,indent=1))
m=MCP(); m.call("initialize",{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}})
m.post({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})
r=m.call("tools/call",{"name":"bt_run_ensemble","arguments":args})
open(f"{D}/s2_02_mcp_submit_resp.json","w").write(json.dumps(r,ensure_ascii=False,indent=1))
print("SUBMIT isError=",r.get("result",{}).get("isError"))
txt=r["result"]["content"][0]["text"]
print("SUBMIT text:",txt[:700])
rid=json.loads(txt)["run_id"] if txt.strip().startswith("{") else None
print("RUN_ID=",rid)
open(f"{D}/s2_run_id.txt","w").write(rid or "")
for i in range(30):
    g=m.call("tools/call",{"name":"bt_get_run","arguments":{"run_id":rid}})
    t=g["result"]["content"][0]["text"]
    try: d=json.loads(t)
    except: print("POLL raw",t[:200]); break
    print("poll",i,"status",d.get("status"),"progress",d.get("progress"),"error",d.get("error"))
    if d.get("status") in ("succeeded","failed","canceled"): break
    time.sleep(1)
open(f"{D}/s2_02_mcp_final_brief.json","w").write(json.dumps(g,ensure_ascii=False,indent=1))
