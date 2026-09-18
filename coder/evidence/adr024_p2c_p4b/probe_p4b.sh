#!/usr/bin/env bash
# ADR-024 P4b 仪表阶段 —— 真路径「改动前基线」测量（受控 run；行数据末尾删除）
# 落点：coder/evidence/adr024_p2c_p4b/probe_p4b.sh
# app：本机 127.0.0.1:18081（P4b 仪表二进制，config /tmp/app_p4b_18081.toml；DB = 活库 eestock）
# 说明：run 行数据在末尾统一删除（name LIKE 'ADR024-P4b-base-%'）；pg_stat 累计计数器不可回滚（如实报告）。
set -uo pipefail
export TZ=UTC
API=http://127.0.0.1:18081
PSQL() { docker exec -i eestock-timescaledb psql -U eestock -d eestock "$@"; }
snap_upd() { PSQL -Atc "SELECT n_tup_upd||'|'||n_tup_ins||'|'||n_tup_del FROM pg_stat_user_tables WHERE relname='strategy_run'"; }
snap_alert() { PSQL -Atc "SELECT count(*)||'|'||count(*) FILTER (WHERE status='triggered')||'|'||coalesce(sum(fire_count),0)||'|'||coalesce(max(last_fired_at)::text,'-') FROM alert_events"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
VER=sv_1789013713975_000001

submit() { # tag symbol period from to  -> 打印提交输出，rid 写 /tmp/p4b_last_rid
  local tag="$1" symbol="$2" period="$3" from="$4" to="$5"
  local body resp rid
  body=$(cat <<JSON
{"name":"ADR024-P4b-base-$tag","symbol":"$symbol","period":"$period","from":"$from","to":"$to",
 "slots":[{"version_id":"$VER","params":{"fast":5.0,"slow":20.0},"weight":1.0}],
 "buy_threshold":60.0,"sell_threshold":40.0,"policy":{"LumpSum":{"position_pct":1.0}},"initial_capital":100000.0}
JSON
)
  resp=$(curl -s -m 30 -X POST "$API/api/workbench/runs" -H 'content-type: application/json' -d "$body" -w '\n[http=%{http_code} wall=%{time_total}s]')
  echo "[SUBMIT $tag] $(printf '%s' "$resp" | tail -1)"
  rid=$(printf '%s' "$resp" | grep -o '"id":"sr_[^"]*"' | head -1 | sed 's/^"id":"//; s/"$//')
  if [ -z "$rid" ]; then echo "[FATAL $tag] 无 run_id: $resp"; return 1; fi
  echo "[RUNID  $tag] $rid"
  printf '%s' "$rid" > /tmp/p4b_last_rid
}

wait_one() { # rid tag t_submit
  local rid="$1" tag="$2" t0="$3" st="" i=0 t1
  while :; do
    st=$(curl -s -m 10 "$API/api/workbench/runs/$rid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    case "$st" in succeeded|failed|canceled) break;; esac
    i=$((i+1)); [ $i -gt 4000 ] && { echo "[FATAL $tag] 轮询超时"; break; }
    sleep 0.02
  done
  t1=$(iso)
  echo "[TERM   $tag] status=$st t_submit=$t0 t_terminal=$t1"
  PSQL -Atc "SELECT '${tag}|row|'||id||'|'||period||'|'||symbol||'|'||status||'|progress='||progress||'|bars='||coalesce(jsonb_array_length(r.per_bar)::text,'NULL')||'|dur_s='||round(EXTRACT(EPOCH FROM (s.finished_at-s.started_at))::numeric,6)||'|started='||coalesce(s.started_at::text,'-')||'|finished='||coalesce(s.finished_at::text,'-') FROM strategy_run s LEFT JOIN strategy_run_result r ON r.run_id=s.id WHERE s.id='${rid}'"
}

do_run() { # tag symbol period from to [--no-wait]
  local tag="$1" symbol="$2" period="$3" from="$4" to="$5" nowait="${6:-}"
  local t0
  t0=$(iso)
  submit "$tag" "$symbol" "$period" "$from" "$to"
  if [ -z "$nowait" ]; then wait_one "$(cat /tmp/p4b_last_rid)" "$tag" "$t0"; fi
}

echo "# ===== ADR-024 P4b 仪表阶段：真路径基线（app=18081 仪表二进制；DB=活库 eestock）====="
echo "# date_utc : $(iso)"
echo "# commit   : $(git rev-parse HEAD) (+ staged)"
APPPID=$(pgrep -f 'eestock-app --config /tmp/app_p4b_18081.toml' | head -1)
echo "# app pid  : $APPPID"
echo "# engine   : $(ls -l /proc/$APPPID/exe 2>/dev/null | sed 's/.*-> //')"
echo

echo "### [0] 前置闲置对照（不提交 run；观察 prod 告警节拍 70s 与表级统计漂移）"
U0=$(snap_upd); A0=$(snap_alert)
sleep 70
U1=$(snap_upd); A1=$(snap_alert)
echo "IDLE strategy_run(tup_upd|ins|del): $U0 -> $U1"
echo "IDLE alert_events(count|open|sum_fire_count|max_last_fired): $A0 -> $A1"
echo

echo "### [1] 真路径单次 run ×3（小/中/大 三档，串行）"
do_run t1_small_d1_492   518880 D1 2025-09-01T00:00:00Z 2026-09-01T00:00:00Z
do_run t2_medium_m5_3500 159740 M5 2026-06-10T00:00:00Z 2026-09-10T00:00:00Z
do_run t3_large_m1_16155 518880 M1 2026-06-09T01:30:00Z 2026-09-09T07:00:00Z
echo

echo "### [2] 并发吞吐探针：4 条 M5 中档并发提交（MAX_CONCURRENT=4）"
TT0=$(iso); W0=$(date +%s.%N)
RIDS=()
for i in 1 2 3 4; do
  do_run "c4_$i" 159740 M5 2026-06-10T00:00:00Z 2026-09-10T00:00:00Z --no-wait
  RIDS+=("$(cat /tmp/p4b_last_rid)")
done
for i in 0 1 2 3; do
  n=$((i+1))
  wait_one "${RIDS[$i]}" "c4_$n" "$TT0"
done
W1=$(date +%s.%N)
echo "[CONC4] wall_total=$(python3 -c "print(f'{$W1-$W0:.3f}')")s  runs=4  throughput=$(python3 -c "print(f'{4/($W1-$W0):.4f}')") run/s"
echo

echo "### [3] 后置：表级统计沉降（每 5s 采样，连续 3 次相同即停；上限 120s）"
U2=$(snap_upd); A2=$(snap_alert)
prev=""; same=0; t=0
while [ $t -lt 24 ]; do
  v=$(snap_upd); t=$((t+1))
  if [ "$v" = "$prev" ]; then same=$((same+1)); else same=0; fi
  prev=$v
  echo "  settle[$(iso)] $v"
  [ $same -ge 3 ] && break
  sleep 5
done
U3=$(snap_upd); A3=$(snap_alert)
echo "POST strategy_run(tup_upd|ins|del): $U2 -> $U3"
echo "POST alert_events(count|open|sum_fire_count|max_last_fired): $A2 -> $A3"
echo "### —— 结束 ——"
