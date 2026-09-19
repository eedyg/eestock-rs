import json,sys
D="tester/evidence/20260919_adr026_smoke_backtest/raw"
L=[]; bad=0
def chk(n,got,exp):
    global bad
    ok = got==exp
    if not ok: bad+=1
    L.append(f"{'PASS' if ok else 'FAIL'}  {n}: got={got!r} exp={exp!r}")
s1=open(f"{D}/s1_run_id.txt").read().strip()
s2=open(f"{D}/s2_run_id.txt").read().strip()

rest_brief=json.load(open(f"{D}/s2_04_rest_read_mcp_run.json"))
chk("REST can read MCP-submitted run id", rest_brief["id"], s2)
chk("MCP run status via REST", rest_brief["status"], "succeeded")

# --- artifact shape parity (S1 REST run vs S2 MCP run)
r1=json.load(open(f"{D}/s1_04_result.json")); r2=json.load(open(f"{D}/s2_06_rest_result_mcp_run.json"))
chk("result top-level key set identical", sorted(r1.keys()), sorted(r2.keys()))
chk("result_format identical", r1["result_format"], r2["result_format"])
chk("per_bar[0] key set identical", sorted(r1["per_bar"][0].keys()), sorted(r2["per_bar"][0].keys()))
chk("per_bar len identical", len(r1["per_bar"]), len(r2["per_bar"]))
chk("trades[0] key set identical", sorted(r1["trades"][0].keys()), sorted(r2["trades"][0].keys()))
chk("trade reason identical", r1["trades"][0]["reason"], r2["trades"][0]["reason"])
chk("metrics key set identical", sorted(r1["metrics"].keys()), sorted(r2["metrics"].keys()))
chk("summary key set identical", sorted(r1["summary"].keys()), sorted(r2["summary"].keys()))

# --- audit parity: MCP bt_get_run_audit(S1) vs REST /audit(S1)  field-by-field
a_rest=json.load(open(f"{D}/s1_07_audit.json"))
mcp=json.load(open(f"{D}/s2_03_mcp_audit_s1.json"))
chk("MCP bt_get_run_audit isError absent", mcp["result"].get("isError"), None)
a_mcp=json.loads(mcp["result"]["content"][0]["text"])
chk("audit field set identical (MCP vs REST)", sorted(a_mcp.keys()), sorted(a_rest.keys()))
diffs={k:(a_rest.get(k),a_mcp.get(k)) for k in set(a_rest)|set(a_mcp) if a_rest.get(k)!=a_mcp.get(k)}
chk("audit all fields equal (REST vs MCP)", diffs, {})
if diffs: L.append("      -> diff detail: "+json.dumps(diffs,ensure_ascii=False))
# audit parity for the MCP run too
a_rest2=json.load(open(f"{D}/s2_05_rest_audit_mcp_run.json"))
chk("MCP run audit field set identical", sorted(a_rest2.keys()), sorted(a_rest.keys()))
chk("MCP run audit batches_done", a_rest2["batches_done"], 3)
chk("MCP run deployed_notional", round(a_rest2["deployed_notional"],6), round(a_rest["deployed_notional"],6))
print("\n".join(L)); print(f"\nSUMMARY: {len(L)} checks, {bad} failed")
sys.exit(1 if bad else 0)
