#!/usr/bin/env bash
# ADR-024 D15 任务一 —— 真路径「进度落库时间窗节流」改动前后对照探针（串行三档规模）。
# 用法：probe_p4bfix.sh <api_base> <app_log> <out_file>
# 前提：临时测试库 + eestock-app（DATABASE_URL 指向临时库）；三档 = D1 483 / M1 3615 / M1 16147。
set -uo pipefail
export TZ=UTC
API="$1"; LOG="$2"; OUT="$3"
VER=sv_1789013713975_000001
PSQL() { PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d "$P4BFIX_DB" -Atc "$1"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

submit() { # tag symbol period from to
  local tag="$1" symbol="$2" period="$3" from="$4" to="$5"
  local body resp rid
  body=$(cat <<JSON
{"name":"ADR024-P4bfix-$tag","symbol":"$symbol","period":"$period","from":"$from","to":"$to",
 "slots":[{"version_id":"$VER","params":{"fast":5.0,"slow":20.0},"weight":1.0}],
 "buy_threshold":60.0,"sell_threshold":40.0,"policy":{"LumpSum":{"position_pct":1.0}},
 "initial_capital":100000.0,"warmup_bars":250}
JSON
)
  resp=$(curl -s -m 60 -X POST "$API/api/workbench/runs" -H 'content-type: application/json' -d "$body" -w '\n[http=%{http_code} wall=%{time_total}s]')
  echo "[SUBMIT $tag] $(printf '%s' "$resp" | tail -1)"
  rid=$(printf '%s' "$resp" | grep -o '"id":"sr_[^"]*"' | head -1 | sed 's/^"id":"//; s/"$//')
  if [ -z "$rid" ]; then echo "[FATAL $tag] 无 run_id: $resp"; return 1; fi
  printf '%s' "$rid" > /tmp/p4bfix_last_rid
}

wait_one() { # tag t0
  local tag="$1" t0="$2" rid st i=0 t1
  rid=$(cat /tmp/p4bfix_last_rid)
  while :; do
    st=$(curl -s -m 10 "$API/api/workbench/runs/$rid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    case "$st" in succeeded|failed|canceled) break;; esac
    i=$((i+1)); [ $i -gt 6000 ] && { echo "[FATAL $tag] 轮询超时"; break; }
    sleep 0.02
  done
  t1=$(iso)
  # 等 p4b.run_summary 落日志（终态与汇总事件之间有一瞬）
  for i in $(seq 1 600); do
    if grep "p4b.run_summary" "$LOG" 2>/dev/null | grep -q "\"run_id\":\"$rid\""; then break; fi
    sleep 0.05
  done
  echo "[TERM $tag] status=$st t_submit=$t0 t_terminal=$t1 rid=$rid"
  # 行数据（DB 侧核对）
  PSQL "SELECT '${tag}|row|'||id||'|'||period||'|'||symbol||'|'||status||'|progress='||progress||'|bars='||coalesce(jsonb_array_length(r.per_bar)::text,'NULL')||'|dur_s='||round(EXTRACT(EPOCH FROM (s.finished_at-s.started_at))::numeric,6) FROM strategy_run s LEFT JOIN strategy_run_result r ON r.run_id=s.id WHERE s.id='${rid}'"
}

do_run() { do_run_tag="$1"; submit "$1" "$2" "$3" "$4" "$5"; wait_one "$1" "$(iso)"; }

echo "# ===== ADR-024 D15 任务一：时间窗节流前后对照（真路径；临时库 ${P4BFIX_DB}）====="
echo "# date_utc : $(iso)"
echo "# app      : $API"
echo "# app log  : $LOG"
echo
echo "### 串行三档 run"
do_run small_d1_483   518880 D1 2024-08-01T00:00:00Z 2026-08-01T00:00:00Z
do_run medium_m1_3615 518880 M1 2026-04-01T00:00:00Z 2026-04-23T00:00:00Z
do_run large_m1_16147 518880 M1 2026-03-02T00:00:00Z 2026-06-09T00:00:00Z
echo
echo "### 提取 p4b.run_summary（每 run 一行）"
python3 - "$LOG" "$OUT" <<'PY'
import json, sys
log, out = sys.argv[1], sys.argv[2]
rows=[]
with open(log, errors='replace') as f:
    for line in f:
        line=line.strip()
        if not line.startswith('{'): continue
        try: o=json.loads(line)
        except Exception: continue
        fl=o.get('fields',{})
        if fl.get('message')=='p4b.run_summary':
            rows.append(fl)
hdr=("run_id","bars_total","progress_frames_produced","progress_db_writes","progress_db_throttled","progress_db_write_ms","progress_db_share_pct","permit_hold_ms","progress_drain_tail_ms","engine_ms","outcome")
lines=["\t".join(hdr)]
for fl in rows:
    lines.append("\t".join(str(fl.get(k,'')) for k in hdr))
txt="\n".join(lines)+"\n"
open(out,'a').write(txt)
print(txt)
PY
echo "### —— 结束 ——"
