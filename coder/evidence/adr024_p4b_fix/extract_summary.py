#!/usr/bin/env python3
"""从 eestock-app JSON 日志提取 p4b.run_summary → 制表（D15 前后对照）。"""
import json, sys

log = sys.argv[1]
only = sys.argv[2:] if len(sys.argv) > 2 else None
HDR = ["run_id", "bars_total", "progress_frames_produced", "progress_db_writes",
       "progress_db_throttled", "progress_db_write_ms", "progress_db_share_pct",
       "permit_hold_ms", "progress_drain_tail_ms", "engine_ms", "outcome"]
rows = []
with open(log, errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        fl = o.get("fields", {})
        if fl.get("message") == "p4b.run_summary":
            rows.append(fl)

w = {k: max(len(k), 3) for k in HDR}
for r in rows:
    for k in HDR:
        w[k] = max(w[k], len(str(r.get(k, ""))))
print("\t".join(k.ljust(w[k]) for k in HDR))
for r in rows:
    print("\t".join(str(r.get(k, "")).ljust(w[k]) for k in HDR))
print(f"# rows={len(rows)}")
