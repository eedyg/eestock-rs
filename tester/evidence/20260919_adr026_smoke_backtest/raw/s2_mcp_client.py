import json,sys,threading,urllib.request,time
BASE="http://127.0.0.1:8082"
class MCP:
    def __init__(self):
        self.r=urllib.request.urlopen(BASE+"/sse",timeout=20)
        line=self.r.readline().decode().strip(); data=self.r.readline().decode().strip()
        self.endpoint=BASE+data.split("data:")[1].strip() if "data:" in data else None
        self.q=[]; self.ev=threading.Event()
        self.buf=b""
        self.t=threading.Thread(target=self._read,daemon=True); self.t.start()
        self.id=0
    def _read(self):
        try:
            while True:
                b=self.r.readline()
                if not b: break
                self.buf+=b
                if self.buf.endswith(b"\n\n"):
                    self.q.append(self.buf.decode()); self.buf=b""; self.ev.set()
        except Exception: pass
    def post(self,obj):
        req=urllib.request.Request(self.endpoint,data=json.dumps(obj).encode(),headers={"Content-Type":"application/json"})
        try:
            r=urllib.request.urlopen(req,timeout=20); return r.status
        except urllib.error.HTTPError as e: return e.code
    def call(self,method,params=None,wait=True):
        self.id+=1; mid=self.id
        self.post({"jsonrpc":"2.0","id":mid,"method":method,"params":params or {}})
        if method.startswith("notifications"): return None
        t0=time.time()
        while time.time()-t0<20:
            for m in list(self.q):
                if f'"id": {mid}' in m or f'"id":{mid}' in m:
                    self.q.remove(m)
                    d=[l for l in m.split("\n") if l.startswith("data:")]
                    return json.loads(d[0][5:].strip())
            time.sleep(0.05)
        return {"error":"timeout"}
def main():
    m=MCP()
    init=m.call("initialize",{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}})
    print("INIT",json.dumps(init)[:200])
    m.post({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})
    tl=m.call("tools/list",{})
    tools=tl["result"]["tools"]
    open("tester/evidence/20260919_adr026_smoke_backtest/raw/s2_00_mcp_tools_list.json","w").write(json.dumps(tools,ensure_ascii=False,indent=1))
    names=[t["name"] for t in tools]
    print("TOOLS",len(names),"HAS_AUDIT","bt_get_run_audit" in names)
    if len(sys.argv)>1 and sys.argv[1]=="schema":
        for t in tools:
            if t["name"]=="bt_run_ensemble":
                print("SCHEMA",json.dumps(t,ensure_ascii=False,indent=1))
    # audit parity for S1 run
    s1=open("tester/evidence/20260919_adr026_smoke_backtest/raw/s1_run_id.txt").read().strip()
    a=m.call("tools/call",{"name":"bt_get_run_audit","arguments":{"run_id":s1}})
    open("tester/evidence/20260919_adr026_smoke_backtest/raw/s2_03_mcp_audit_s1.json","w").write(json.dumps(a,ensure_ascii=False,indent=1))
    print("MCP_AUDIT_s1",json.dumps(a,ensure_ascii=False)[:400])
main()
