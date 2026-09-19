#!/usr/bin/env python3
"""Independent re-computation of TradeDetail count from raw fills.

Rule taken verbatim from implementation (crates/strategy-core/src/engine.rs:846-862):
    if qty >= h.qty { push TradeDetail(...); holding = None } else { partial -> no trade }

This script does NOT import any repo code. It reads only the raw fills payload
dumped from the DB and applies the rule, then compares against the DB trades row.
"""
import json
import sys

fills = json.load(open("03_fills_payload_raw.json"))
db_trades_raw = sys.argv[1] if len(sys.argv) > 1 else "05_db_trades_raw.json"
db_trades = json.load(open(db_trades_raw))
db_len = len(db_trades)

holding_qty = 0.0
holding_entry_ts = None
holding_entry_bar = None
synthed = []
n_buy = 0
n_sell = 0
partial_sells = 0
full_sells = 0

for f in fills:
    side = f["side"]
    if side == "Buy":
        n_buy += 1
        if holding_qty == 0.0:
            holding_entry_ts = f["ts"]
            holding_entry_bar = f["bar_index"]
        holding_qty += f["qty"]
    elif side == "Sell":
        n_sell += 1
        if holding_qty <= 0.0:
            print(f"WARN sell with no holding at bar {f['bar_index']}")
            continue
        if f["qty"] >= holding_qty:
            full_sells += 1
            synthed.append({
                "open_ts": holding_entry_ts,
                "close_ts": f["ts"],
                "open_bar": holding_entry_bar,
                "close_bar": f["bar_index"],
                "shares": holding_qty,
                "hold_bars": f["bar_index"] - holding_entry_bar,
            })
            holding_qty = 0.0
            holding_entry_ts = None
            holding_entry_bar = None
        else:
            partial_sells += 1
            holding_qty -= f["qty"]

print(f"fills={len(fills)} buy={n_buy} sell={n_sell}")
print(f"full_close_sells={full_sells} partial_sells={partial_sells}")
print(f"RECOMPUTED trade count (engine rule) = {len(synthed)}")
print(f"DB trades length                     = {db_len}")
print(f"COUNT MATCH = {len(synthed) == db_len}")

# field-level comparison for the synthesized rounds vs DB round(s)
print("\n--- field diff ---")
ok = True
if len(synthed) == db_len:
    for i, (s, d) in enumerate(zip(synthed, db_trades)):
        for k, v in s.items():
            dv = d.get(k)
            same = (dv == v)
            if not same:
                ok = False
            print(f"  trade[{i}].{k}: recomputed={v!r} db={dv!r} match={same}")
    # holdings residual after all fills (should be 0)
    print(f"  residual holding qty (should be 0): {holding_qty}")
else:
    ok = False
    print("  count mismatch -> field diff skipped")
print(f"FIELD MATCH = {ok}")
