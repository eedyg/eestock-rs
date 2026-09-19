import json, sys
D = "tester/evidence/20260919_adr026_smoke_backtest/raw"
audit = json.load(open(f"{D}/s1_07_audit.json"))
fills = json.load(open(f"{D}/s1_04_fills.json"))
res   = json.load(open(f"{D}/s1_04_result.json"))
bars  = json.load(open(f"{D}/s1_04_bars_per_bar.json"))
brief = json.load(open(f"{D}/s1_02_final_brief.json"))

L = []
def chk(name, got, exp, ok=None):
    if ok is None: ok = (got == exp)
    L.append(f"{'PASS' if ok else 'FAIL'}  {name}: got={got!r} exp={exp!r}")
    return ok

# --- status / progress / error
chk("status", brief["status"], "succeeded")
chk("progress", brief["progress"], 1.0)
chk("error", brief["error"], None)

# --- result_format / per_bar totals
chk("result_format", res["result_format"], "chunked_v1")
pb = res["per_bar"]
warm = sum(1 for b in pb if b.get("warmup") is True)
inr  = sum(1 for b in pb if b.get("warmup") is not True)
chk("per_bar total (result page)", len(pb), 493)
chk("per_bar warmup", warm, 250)
chk("per_bar in-range", inr, 243)
chk("warmup+in-range == total", warm + inr, len(pb))
chk("has_more", res["has_more"], False)
chk("next_offset", res["next_offset"], None)
chk("estimated_bars(brief) == in-range", brief["estimated_bars"], inr)

# --- /bars per_bar consistency
bpb = bars.get("per_bar") or bars.get("bars") or []
chk("/bars per_bar len", len(bpb), len(pb))
chk("/bars has_more", bars.get("has_more"), False)
chk("/bars next_offset", bars.get("next_offset"), None)

# --- fills vs audit
buy = [f for f in fills["fills"] if f["side"] == "Buy"]
sell= [f for f in fills["fills"] if f["side"] == "Sell"]
chk("audit.batches_done == #Buy fills", audit["batches_done"], len(buy))
notional = sum(f["qty"] * f["price"] for f in buy)
delta = abs(notional - audit["deployed_notional"])
chk("deployed_notional == Sum(Buy qty*price)", round(audit["deployed_notional"],9), round(notional,9), delta < 1e-6)
L.append(f"      -> deployed_notional={audit['deployed_notional']:.9f} recomputed={notional:.9f} abs_delta={delta:.3e} rel_delta={delta/notional:.3e}")
chk("fills.total == len(fills)", fills["total"], len(fills["fills"]))

# --- trades vs audit
tr = res["trades"]
chk("audit.round_trips_total == len(trades)", audit["round_trips_total"], len(tr))
fc_events = sum(1 for b in pb for e in (b.get("events") or []) if e.get("reason") == "ForceClose")
chk("audit.round_trips_force_closed == #ForceClose events(per_bar)", audit["round_trips_force_closed"], fc_events)
fc_fills = sum(1 for f in fills["fills"] if f.get("reason") == "ForceClose")
chk("round_trips_force_closed == #ForceClose fills", audit["round_trips_force_closed"], fc_fills)

# --- ADR-026 reason field on trades + cross-check with fills
chk("trades[0].reason present", "reason" in tr[0], True)
chk("trades[0].reason value", tr[0]["reason"], "ForceClose")
chk("reason matches sell fill close_bar", tr[0]["close_bar"], sell[0]["bar_index"])
chk("reason matches sell fill price", round(tr[0]["close_price"],6), round(sell[0]["price"],6))

# --- S6 negative control: PARTIAL_DEPLOYMENT not falsely raised
codes = [w["code"] for w in audit["warnings"]]
chk("deployed_pct >= 0.99", audit["deployed_pct"] >= 0.99, True)
chk("PARTIAL_DEPLOYMENT absent (pct>=0.99)", "PARTIAL_DEPLOYMENT" in codes, False)
chk("DCA_PLAN_UNDERFILLED absent (batches==tranches)", "DCA_PLAN_UNDERFILLED" in codes, False)
chk("planned_tranches", audit["planned_tranches"], 3)

print("\n".join(L))
bad = [x for x in L if x.startswith("FAIL")]
print(f"\nSUMMARY: {len(L)} assertions, {len(bad)} failed")
sys.exit(1 if bad else 0)
