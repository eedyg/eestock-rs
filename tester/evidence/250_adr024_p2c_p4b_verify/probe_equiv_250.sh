#!/usr/bin/env bash
# ADR-024 P2c/P4b 独立验收 ①：仪表前后「结果不变」客观等价对照（tester 自写，不沿用 worker 脚本）
# 方法：同一输入分别提交给 ① pre-P4b 二进制（workbench.rs 临时回退到 HEAD 态后构建）
#       与 ② 仪表二进制（本批交付态），比较 strategy_run_result 五 jsonb 列 + progress 的摘要。
# 纪律：不改任何生产源码（临时回退的 workbench.rs 已在开跑前逐字节复原，见 03/04 证据）；
#       只写 run 行，末尾按前缀删除。
set -uo pipefail
export TZ=UTC
PSQL() { docker exec -i eestock-timescaledb psql -U eestock -d eestock "$@"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
VER=sv_1789013713975_000001
P_PRE=18091
P_INS=18092
API_PRE="http://127.0.0.1:$P_PRE"
API_INS="http://127.0.0.1:$P_INS"

cat > /tmp/app_tester_prep4b_18091.toml <<EOF
database_url = "postgres://eestock:eestock@127.0.0.1:5433/eestock"
listen = "127.0.0.1:$P_PRE"
mcp_listen = "127.0.0.1:18093"
static_dir = "./web/dist"
health_window_secs = 3600
ws_poll_ms = 3000
alert_eval_ms = 3600000
EOF
cat > /tmp/app_tester_instr_18092.toml <<EOF
database_url = "postgres://eestock:eestock@127.0.0.1:5433/eestock"
listen = "127.0.0.1:$P_INS"
mcp_listen = "127.0.0.1:18094"
static_dir = "./web/dist"
health_window_secs = 3600
ws_poll_ms = 3000
alert_eval_ms = 3600000
EOF

wait_health() { # port
  for i in $(seq 1 150); do
    c=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$1/healthz" || true)
    [ "$c" = "200" ] && return 0
    sleep 0.2
  done
  return 1
}

submit() { # api tag symbol period from to -> prints rid
  local api="$1" tag="$2" symbol="$3" period="$4" from="$5" to="$6" resp rid
  local body
  body=$(cat <<JSON
{"name":"T250-EQ-$tag","symbol":"$symbol","period":"$period","from":"$from","to":"$to",
 "slots":[{"version_id":"$VER","params":{"fast":5.0,"slow":20.0},"weight":1.0}],
 "buy_threshold":60.0,"sell_threshold":40.0,"policy":{"LumpSum":{"position_pct":1.0}},"initial_capital":100000.0}
JSON
)
  resp=$(curl -s -m 60 -X POST "$api/api/workbench/runs" -H 'content-type: application/json' -d "$body" -w '\n[http=%{http_code} wall=%{time_total}s]')
  echo "[SUBMIT $tag] $(printf '%s' "$resp" | tail -1)" >&2
  rid=$(printf '%s' "$resp" | grep -o '"id":"sr_[^"]*"' | head -1 | sed 's/^"id":"//; s/"$//')
  [ -z "$rid" ] && { echo "[FATAL $tag] 无 run_id: $resp" >&2; return 1; }
  printf '%s' "$rid" > "/tmp/p4b_eq_last_rid"
}

wait_one() { # api rid tag
  local api="$1" rid="$2" tag="$3" st="" i=0
  while :; do
    st=$(curl -s -m 10 "$api/api/workbench/runs/$rid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    case "$st" in succeeded|failed|canceled) break;; esac
    i=$((i+1)); [ $i -gt 6000 ] && { echo "[FATAL $tag] 轮询超时" >&2; break; }
    sleep 0.02
  done
  echo "[TERM   $tag] status=$st rid=$rid" >&2
}

fingerprint() { # rid -> 单行指纹
  PSQL -Atc "SELECT s.status||'|progress='||s.progress||
    '|perbar_n='||coalesce(jsonb_array_length(r.per_bar)::text,'NULL')||
    '|trades_n='||coalesce(jsonb_array_length(r.trades)::text,'NULL')||
    '|net_n='||coalesce(jsonb_array_length(r.net_value)::text,'NULL')||
    '|dd_n='||coalesce(jsonb_array_length(r.drawdown)::text,'NULL')||
    '|md5_per_bar='||md5(r.per_bar::text)||
    '|md5_trades='||md5(r.trades::text)||
    '|md5_net='||md5(r.net_value::text)||
    '|md5_dd='||md5(r.drawdown::text)||
    '|md5_metrics='||md5(r.metrics::text)||
    '|metrics='||r.metrics::text
    FROM strategy_run s LEFT JOIN strategy_run_result r ON r.run_id=s.id WHERE s.id='$1'"
}

echo "# ===== ADR-024 P2c/P4b ① 仪表前后结果等价：pre-P4b 二进制 vs 仪表二进制 ====="
echo "# date_utc : $(iso)"
echo "# pre-P4b binary : /tmp/eestock-app-prep4b-250  sha256=$(sha256sum /tmp/eestock-app-prep4b-250 | cut -d' ' -f1)"
echo "# instr  binary  : /tmp/eestock-app-instr-250   sha256=$(sha256sum /tmp/eestock-app-instr-250 | cut -d' ' -f1)"
echo "# pre-P4b 源码 = git show HEAD:crates/application/src/workbench.rs（sha256 $(sha256sum /tmp/workbench_rs_prep4b.rs | cut -d' ' -f1)）"
echo "# 仪表源码     = 本批交付态（sha256 $(sha256sum /tmp/workbench_rs_250_backup.rs | cut -d' ' -f1)）"
echo

pkill -f 'eestock-app --config /tmp/app_tester_prep4b_18091.toml' 2>/dev/null
pkill -f 'eestock-app --config /tmp/app_tester_instr_18092.toml' 2>/dev/null
sleep 0.5
echo "[BOOT] starting pre-P4b on $P_PRE ..."
/tmp/eestock-app-prep4b-250 --config /tmp/app_tester_prep4b_18091.toml > /tmp/app_tester_prep4b.json.log 2>&1 &
echo "[BOOT] starting instr  on $P_INS ..."
/tmp/eestock-app-instr-250   --config /tmp/app_tester_instr_18092.toml  > /tmp/app_tester_instr.json.log  2>&1 &
wait_health $P_PRE && echo "[BOOT] $P_PRE healthz=200" || echo "[BOOT] $P_PRE 健康检查失败"
wait_health $P_INS && echo "[BOOT] $P_INS healthz=200" || echo "[BOOT] $P_INS 健康检查失败"
echo

CASES=(
  "small_d1_492|518880|D1|2025-09-01T00:00:00Z|2026-09-01T00:00:00Z"
  "medium_m5_3500|159740|M5|2026-06-10T00:00:00Z|2026-09-10T00:00:00Z"
  "large_m1_16155|518880|M1|2026-06-09T01:30:00Z|2026-09-09T07:00:00Z"
)

for c in "${CASES[@]}"; do
  IFS='|' read -r tag sym per from to <<< "$c"
  echo "### CASE $tag ($sym $per $from ~ $to)"
  submit "$API_PRE" "prep4b-$tag" "$sym" "$per" "$from" "$to"
  RID_PRE=$(cat /tmp/p4b_eq_last_rid)
  submit "$API_INS" "instr-$tag"  "$sym" "$per" "$from" "$to"
  RID_INS=$(cat /tmp/p4b_eq_last_rid)
  wait_one "$API_PRE" "$RID_PRE" "prep4b-$tag"
  wait_one "$API_INS" "$RID_INS" "instr-$tag"
  echo "  rid_pre=$RID_PRE  rid_instr=$RID_INS"
  fp_pre=$(fingerprint "$RID_PRE")
  fp_ins=$(fingerprint "$RID_INS")
  echo "  FP_pre   : $fp_pre"
  echo "  FP_instr : $fp_ins"
  if [ "$fp_pre" = "$fp_ins" ]; then echo "  ==> 判定：EQ SAME（逐字节相同）"; else echo "  ==> 判定：DIFF"; fi
  echo
done

echo "### 清理（按前缀删除本次对照 run；级联删结果行）"
PSQL -c "DELETE FROM strategy_run WHERE name LIKE 'T250-EQ-%'"
echo "残留 T250-EQ-%: $(PSQL -Atc "SELECT count(*) FROM strategy_run WHERE name LIKE 'T250-EQ-%'")  结果孤儿: $(PSQL -Atc "SELECT count(*) FROM strategy_run_result r LEFT JOIN strategy_run s ON s.id=r.run_id WHERE s.id IS NULL")"
echo "strategy_run 行数回位: $(PSQL -Atc 'SELECT count(*) FROM strategy_run') / result: $(PSQL -Atc 'SELECT count(*) FROM strategy_run_result')"

pkill -f 'eestock-app --config /tmp/app_tester_prep4b_18091.toml' 2>/dev/null
pkill -f 'eestock-app --config /tmp/app_tester_instr_18092.toml' 2>/dev/null
sleep 0.5
echo "[STOP] 残进程: $(pgrep -fa 'app_tester_prep4b_18091|app_tester_instr_18092' | wc -l)"
echo "### —— 结束 ——"
