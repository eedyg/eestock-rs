import json,sys
D="tester/evidence/20260919_adr026_smoke_backtest/raw"
L=[];bad=0
def chk(n,ok,detail=""):
    global bad
    if not ok: bad+=1
    L.append(f"{'PASS' if ok else 'FAIL'}  {n} {detail}")
    return ok
full=json.load(open(f"{D}/s1_07_audit.json")); fills=json.load(open(f"{D}/s1_04_fills.json"))
part=json.load(open(f"{D}/s6_partial_run_audit.json"))
buy=[f for f in fills["fills"] if f["side"]=="Buy"]
recomp=sum(f["qty"]*f["price"] for f in buy)

# --- A. mutation: deliberately wrong expected value MUST go red (proves assertion is not vacuous)
wrong = recomp + 1.0
ok = abs(full["deployed_notional"]-wrong) < 1e-6
chk("A/mutation deployed_notional==recomp+1.0 (expect assertion RED, i.e. ok=False)", ok is False,
    f"| got_match={ok} (False=assertion went red as required)  real={full['deployed_notional']:.6f} mutated_exp={wrong:.6f} delta={abs(full['deployed_notional']-wrong):.3f}")

# --- B. true assertion still green (same machinery)
ok = abs(full["deployed_notional"]-recomp) < 1e-6
chk("B/true deployed_notional==recomp (expect GREEN)", ok, f"| delta={abs(full['deployed_notional']-recomp):.3e}")

# --- C. PARTIAL_DEPLOYMENT discrimination: full-deployment run must NOT warn, partial run MUST warn
codes_full=[w["code"] for w in full["warnings"]]; codes_part=[w["code"] for w in part["warnings"]]
chk("C1/full run deployed_pct>=0.99", full["deployed_pct"]>=0.99, f"| pct={full['deployed_pct']:.6f}")
chk("C2/full run NO PARTIAL_DEPLOYMENT", "PARTIAL_DEPLOYMENT" not in codes_full, f"| codes={codes_full}")
chk("C3/partial run deployed_pct<0.99", part["deployed_pct"]<0.99, f"| pct={part['deployed_pct']:.6f}")
chk("C4/partial run HAS PARTIAL_DEPLOYMENT", "PARTIAL_DEPLOYMENT" in codes_part, f"| codes={codes_part}")
chk("C5/warning discriminates on the same field (not constant)", ("PARTIAL_DEPLOYMENT" in codes_part) != ("PARTIAL_DEPLOYMENT" in codes_full))

# --- D. DCA_PLAN_UNDERFILLED discrimination
chk("D1/full run batches_done==planned_tranches (3/3) -> NO warn",
    full["batches_done"]==full["planned_tranches"] and "DCA_PLAN_UNDERFILLED" not in codes_full)
chk("D2/partial run batches_done(42)<planned_tranches(100) -> HAS warn",
    part["batches_done"]<part["planned_tranches"] and "DCA_PLAN_UNDERFILLED" in codes_part)
print("\n".join(L))
print(f"\nSUMMARY: {len(L)} checks, {bad} failed (A is expected to be recorded as PASS because it asserts the assertion went red)")
sys.exit(1 if bad else 0)
