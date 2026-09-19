#!/usr/bin/env python3
"""D6 live verification — A/B/C run reconciliation (read-only).

Compares three live workbench runs submitted with identical parameters except policy.Dca.interval:
  A = interval omitted           (expect == B, and semantics == interval 1)
  B = interval explicitly 1
  C = interval explicitly 5      (negative control: must DIFFER, else the fixture is not discriminative)

Assertions printed: audit keys reachable_batches / batches_done / deployed_notional (plus pct/cash),
fills (list of per-fill records) field-wise equal, and result.trades field-wise equal.
"""
import json
import sys

RAW = "tester/evidence/20260919_d6_live_verify/raw"
RUNS = {
    "A_omitted": ("OM", "sr_1789807182072_000017"),
    "B_interval1": ("I1", "sr_1789807182146_000018"),
    "C_interval5": ("I5", "sr_1789807182207_000019"),
}


def load(sfx, run_id):
    p = f"{RAW}/41_E_{sfx}_{run_id}"
    return {
        "audit": json.load(open(f"{p}_audit.json")),
        "fills": json.load(open(f"{p}_fills.json"))["fills"],
        "trades": json.load(open(f"{p}_result.json"))["trades"],
    }


def main():
    d = {k: load(*v) for k, v in RUNS.items()}
    a, b, c = d["A_omitted"], d["B_interval1"], d["C_interval5"]

    keys = ["reachable_batches", "batches_done", "deployed_notional", "deployed_pct",
            "cash_consumed", "planned_tranches", "unexecuted_orders", "last_bar_unfilled"]
    ok = True
    for k in keys:
        same = a["audit"][k] == b["audit"][k]
        ok &= same
        print(f"A vs B  {k}: {a['audit'][k]!r} == {b['audit'][k]!r} -> {same}")
    print("A vs B  fills field-wise equal:", a["fills"] == b["fills"])
    print("A vs B  trades field-wise equal:", a["trades"] == b["trades"])
    print("A vs B  audit differing keys:",
          {k for k in set(a["audit"]) | set(b["audit"]) if a["audit"].get(k) != b["audit"].get(k)})
    ok &= a["fills"] == b["fills"] and a["trades"] == b["trades"]

    print("--- negative control (fixture discriminative?) ---")
    print("A vs C  batches_done:", a["audit"]["batches_done"], "vs", c["audit"]["batches_done"],
          "-> differ:", a["audit"]["batches_done"] != c["audit"]["batches_done"])
    print("A vs C  deployed_notional:", a["audit"]["deployed_notional"], "vs", c["audit"]["deployed_notional"])
    print("A vs C  fills differ:", a["fills"] != c["fills"])
    print("fill bar_index A:", [f["bar_index"] for f in a["fills"]])
    print("fill bar_index C:", [f["bar_index"] for f in c["fills"]])
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
