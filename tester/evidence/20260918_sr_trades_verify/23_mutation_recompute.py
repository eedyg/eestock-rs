#!/usr/bin/env python3
"""Mutation / falsifiability check for the close-only TradeDetail rule.

Executable criterion (would go RED if the conclusion were wrong):
    For every run, independently recompute trade count from fills under the
    close-only rule and require equality with the DB trades length.

We additionally run DELIBERATELY WRONG rules to prove the criterion is
discriminating (a check that can never fail would be worthless):
    Rule B: every Buy opens its own trade (each fill = roundtrip) -> 42 for target
    Rule C: every fill is a trade -> 43 for target

Read-only (SELECT only).
"""
import json
import subprocess

PSQL = ["psql", "-h", "127.0.0.1", "-p", "5433", "-U", "eestock", "-d", "eestock", "-Atc"]
ENV = {"PGPASSWORD": "eestock", "PATH": "/usr/bin:/bin:/usr/local/bin"}


def q(sql):
    p = subprocess.run(PSQL + [sql], capture_output=True, text=True, env=ENV)
    if p.returncode != 0:
        raise RuntimeError(p.stderr)
    return p.stdout.strip()


def count_close_only(fills):
    holding = 0.0
    n = 0
    for f in fills:
        if f["side"] == "Buy":
            holding += f["qty"]
        else:
            if holding > 0 and f["qty"] >= holding:
                n += 1
                holding = 0.0
            elif holding > 0:
                holding -= f["qty"]
    return n


def count_each_buy(fills):
    return sum(1 for f in fills if f["side"] == "Buy")


def count_each_fill(fills):
    return len(fills)


runs = json.loads(q("""
SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]')::text FROM (
  SELECT r.id, rr.result_format, rr.trades::text AS trades_json
  FROM strategy_run r JOIN strategy_run_result rr ON rr.run_id = r.id
) t;
"""))

resA = resB = resC = 0
failsA, failsB, failsC = [], [], []
for r in runs:
    rid = r["id"]
    if r["result_format"] == "chunked_v1":
        raw = q(f"SELECT payload::text FROM strategy_run_bars WHERE run_id='{rid}' AND kind='fills' LIMIT 1;")
        fills = json.loads(raw) if raw else []
    else:
        raw = q(f"SELECT per_bar::text FROM strategy_run_result WHERE run_id='{rid}';")
        per_bar = json.loads(raw) if raw else []
        fills = []
        for bar in per_bar:
            for ev in (bar.get("events") or []):
                if ev.get("type") == "fill":
                    fills.append({"side": ev.get("side"), "qty": ev.get("qty")})
    db = len(json.loads(r["trades_json"]))
    a, b, c = count_close_only(fills), count_each_buy(fills), count_each_fill(fills)
    if a == db:
        resA += 1
    else:
        failsA.append((rid, a, db))
    if b == db:
        resB += 1
    else:
        failsB.append((rid, b, db))
    if c == db:
        resC += 1
    else:
        failsC.append((rid, c, db))

print(f"runs = {len(runs)}")
print(f"Rule A close-only  (engine) : match {resA}/{len(runs)}  -> {'GREEN' if resA == len(runs) else 'RED'}")
print(f"  fail sample: {failsA[:5]}")
print(f"Rule B each-Buy             : match {resB}/{len(runs)}  -> {'GREEN' if resB == len(runs) else 'RED'}")
print(f"  fail sample: {failsB[:5]}")
print(f"Rule C each-fill            : match {resC}/{len(runs)}  -> {'GREEN' if resC == len(runs) else 'RED'}")
print(f"  fail sample: {failsC[:5]}")

# explicit target-run red demonstration
rid = "sr_1789738328788_000005"
raw = q(f"SELECT payload::text FROM strategy_run_bars WHERE run_id='{rid}' AND kind='fills' LIMIT 1;")
fills = json.loads(raw)
db = len(json.loads(q(f"SELECT trades::text FROM strategy_run_result WHERE run_id='{rid}';")))
print(f"\ntarget run {rid}: fills={len(fills)} db_trades={db}")
print(f"  Rule A close-only -> {count_close_only(fills)}  {'GREEN (==db)' if count_close_only(fills)==db else 'RED'}")
print(f"  Rule B each-Buy   -> {count_each_buy(fills)}  {'GREEN' if count_each_buy(fills)==db else 'RED (would flag a bug)'}")
print(f"  Rule C each-fill  -> {count_each_fill(fills)}  {'GREEN' if count_each_fill(fills)==db else 'RED (would flag a bug)'}")
