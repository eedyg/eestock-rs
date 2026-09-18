#!/usr/bin/env bash
# ADR-024 P4b 修复（进度落库时间窗节流 ≥250ms）—— tester 独立真路径前后对照探针。
# 用法：probe_255.sh <api_base> <app_json_log> <out_file> <tag_prefix>
# 三档规模与 worker 同区间（便于逐格对照）：D1 483 / M1 3615 / M1 16147（喂入含 250 预热）。
set -uo pipefail
export TZ=UTC
API="$1"; LOG="$2"; OUT="$3"; TAGP="$4"
DB="$P4BVIV_DB"
VER=sv_1789013713975_000001
PSQL() { PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d "$DB" -Atc "$1"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

submit() { # tag symbol period from to
  local tag="$1" symbol="$2" period="$3" from="$4" to="$5"
  local body resp rid
  body=$(cat <<JSON
{"name":"${TAGP}-$tag","symbol":"$symbol","period":"$period","from":"$from","to":"$to",
 "slots":[{"version_id":"$VER","params":{"fast":5.0,"slow":20.0},"weight":1.0}],
 "buy_threshold":60.0,"sell_threshold":40.0,"policy":{"LumpSum":{"position_pct":1.0}},
 "initial_capital":100000.0,"warmup_bars":250}
JSON
)
  resp=$(curl -s -m 120 -X POST "$API/api/workbench/runs" -H 'content-type: application/json' -d "$body" -w '\n[http=%{http_code} wall=%{time_total}s]')
  echo "[SUBMIT $tag] $(printf '%s' "$resp" | tail -1)"
  rid=$(printf '%s' "$resp" | grep -o '"id":"sr_[^"]*"' | head -1 | sed 's/^"id":"//; s/"$//')
  if [ -z "$rid" ]; then echo "[FATAL $tag] 无 run_id: $resp"; return 1; fi
  printf '%s' "$rid" > /tmp/p4bviv_last_rid
  echo "$rid"
}

wait_one() { # tag rid
  local tag="$1" rid="$2" st i=0
  while :; do
    st=$(curl -s -m 10 "$API/api/workbench/runs/$rid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    case "$st" in succeeded|failed|canceled) break;; esac
    i=$((i+1)); [ $i -gt 12000 ] && { echo "[FATAL $tag] 轮询超时"; break; }
    sleep 0.02
  done
  for i in $(seq 1 1200); do
    if grep "p4b.run_summary" "$LOG" 2>/dev/null | grep -q "\"run_id\":\"$rid\""; then break; fi
    sleep 0.05
  done
  echo "[TERM $tag] status=$st rid=$rid"
  PSQL "SELECT '${tag}|row|'||id||'|'||period||'|'||symbol||'|'||status||'|progress='||progress||'|dur_s='||round(EXTRACT(EPOCH FROM (finished_at-started_at))::numeric,6)||'|bars_rows='||coalesce((SELECT jsonb_array_length(r.per_bar)::text FROM strategy_run_result r WHERE r.run_id=s.id),'NULL') FROM strategy_run s WHERE s.id='${rid}'"
}

echo "# ===== P4b 修复 tester 独立探针（真实 run；临时库 ${DB}）====="
echo "# date_utc : $(iso)"
echo "# api      : $API"
echo "# app log  : $LOG"
echo "# tag_prefix: $TAGP"
echo
echo "### 串行三档 run"
R1=$(submit small_d1_483   518880 D1 2024-08-01T00:00:00Z 2026-08-01T00:00:00Z | tail -1)
wait_one small_d1_483 "$R1"
R2=$(submit medium_m1_3615 518880 M1 2026-04-01T00:00:00Z 2026-04-23T00:00:00Z | tail -1)
wait_one medium_m1_3615 "$R2"
R3=$(submit large_m1_16147 518880 M1 2026-03-02T00:00:00Z 2026-06-09T00:00:00Z | tail -1)
wait_one large_m1_16147 "$R3"
echo
echo "### p4b.run_summary 提取（每 run 一行）"
python3 - "$LOG" "$OUT" "$TAGP" <<'PY'
import json, sys
log, out, tagp = sys.argv[1], sys.argv[2], sys.argv[3]
HDR = ["run_id","bars_total","progress_frames_produced","progress_db_writes","progress_db_throttled",
       "progress_db_write_ms","progress_db_share_pct","permit_hold_ms","permit_wait_ms",
       "progress_drain_total_ms","progress_drain_tail_ms","engine_ms","engine_share_pct",
       "result_serialize_ms","result_write_ms","outcome"]
rows=[]
with open(log, errors='replace') as f:
    for line in f:
        line=line.strip()
        if not line.startswith('{'): continue
        try: o=json.loads(line)
        except Exception: continue
        fl=o.get('fields',{})
        if fl.get('message')=='p4b.run_summary' and str(fl.get('run_id','')).startswith('sr_'):
            # 仅取本批（按 name 前缀过滤不可行，改用「本进程日志」= 已按 log 文件隔离）
            rows.append(fl)
with open(out,'a') as fo:
    fo.write("# tag_prefix=%s  rows=%d\n" % (tagp, len(rows)))
    fo.write("\t".join(HDR)+"\n")
    for fl in rows:
        fo.write("\t".join(str(fl.get(k,'')) for k in HDR)+"\n")
print(open(out).read())
PY
echo "### —— 结束 ——"
