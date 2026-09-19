#!/usr/bin/env python3
"""Independent cross-run re-computation of the engine's TradeDetail rule.

For every run in the DB:
  fills = (chunked) strategy_run_bars.kind='fills' payload
        = (legacy)  strategy_run_result.per_bar[*].events[*] where type=='fill'
  Apply engine rule verbatim: Sell with qty >= holding.qty -> trade, holding=0; else partial (no trade).
Compare recomputed trade count against strategy_run_result.trades length.
Also count partial sells to identify positive-control runs (partial exit => trades < fills).

Read-only: SELECT only.
"""
import json
import subprocess
import sys

PSQL = ["psql", "-h", "127.0.0.1", "-p", "5433", "-U", "eestock", "-d", "eestock", "-Atc"]
ENV = {"PGPASSWORD": "eestock", "PATH": "/usr/bin:/bin:/usr/local/bin"}


def q(sql):
    p = subprocess.run(PSQL + [sql], capture_output=True, text=True, env=ENV)
    if p.returncode != 0:
        raise RuntimeError(p.stderr)
    return p.stdout.strip()


runs = json.loads(q("""
SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]')::text FROM (
  SELECT r.id, r.symbol, r.period, rr.result_format,
         rr.trades::text AS trades_json
  FROM strategy_run r JOIN strategy_run_result rr ON rr.run_id = r.id
  ORDER BY r.created_at
) t;
"""))

results = []
for r in runs:
    rid = r["id"]
    fmt = r["result_format"]
    if fmt == "chunked_v1":
        raw = q(f"SELECT payload::text FROM strategy_run_bars WHERE run_id='{rid}' AND kind='fills' LIMIT 1;")
        fills = json.loads(raw) if raw else []
    else:
        raw = q(f"SELECT (per_bar->0)::text FROM strategy_run_result WHERE run_id='{rid}';")
        # per_bar is full array in legacy; fetch it whole
        raw = q(f"SELECT per_bar::text FROM strategy_run_result WHERE run_id='{rid}';")
        per_bar = json.loads(raw) if raw else []
        fills = []
        for bar in per_bar:
            for ev in (bar.get("events") or []):
                if ev.get("type") == "fill":
                    fills.append({"side": ev.get("side"), "qty": ev.get("qty"),
                                  "bar_index": ev.get("bar_index"), "ts": bar.get("ts"),
                                  "reason": ev.get("reason")})
    trades = json.loads(r["trades_json"])

    holding = 0.0
    entry_bar = None
    n_trades = 0
    partial = 0
    full = 0
    for f in fills:
        if f["side"] == "Buy":
            if holding == 0.0:
                entry_bar = f.get("bar_index")
            holding += f["qty"]
        else:
            if holding <= 0:
                continue
            if f["qty"] >= holding:
                full += 1
                n_trades += 1
                holding = 0.0
                entry_bar = None
            else:
                partial += 1
                holding -= f["qty"]
    results.append({
        "id": rid, "symbol": r["symbol"], "period": r["period"], "fmt": fmt,
        "fills_n": len(fills), "buy": sum(1 for x in fills if x["side"] == "Buy"),
        "sell": sum(1 for x in fills if x["side"] != "Buy"),
        "partial_sells": partial, "full_sells": full,
        "recomputed_trades": n_trades, "db_trades": len(trades),
        "match": n_trades == len(trades),
        "residual_holding": holding,
    })

out = results
json.dump(out, open("14_crossrun_recompute.json", "w"), ensure_ascii=False, indent=1)
mismatch = [x for x in out if not x["match"]]
partial_runs = [x for x in out if x["partial_sells"] > 0]
print(f"runs scanned                 = {len(out)}")
print(f"recompute == db trades       = {sum(1 for x in out if x['match'])}/{len(out)}")
print(f"MISMATCH runs                = {len(mismatch)}")
for x in mismatch[:20]:
    print("   ", x)
print(f"runs with partial sells      = {len(partial_runs)}")
for x in partial_runs[:20]:
    print("   ", x)
# a run where trades < fills (positive control for 'not every fill is a trade')
diff = [x for x in out if x["db_trades"] != x["fills_n"]]
print(f"runs where trades_n != fills_n = {len(diff)}")
for x in sorted(diff, key=lambda z: -(z["fills_n"] - z["db_trades"]))[:10]:
    print("   ", x["id"], "fills=", x["fills_n"], "trades=", x["db_trades"], "partial=", x["partial_sells"], x["fmt"])
json.dump(diff, open("15_crossrun_trades_ne_fills.json", "w"), ensure_ascii=False, indent=1)
