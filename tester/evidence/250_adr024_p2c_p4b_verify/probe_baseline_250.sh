#!/usr/bin/env bash
# ADR-024 P4b 独立验收 ②：基线数字独立复现（tester 自写探针，协议 = skill eestock-db-migration-and-cagg-ops 的长窗口）
#   - 前置 idle guard：pg_stat_user_tables(strategy_run) 连续 3 次相同才开跑
#   - 后置 settle：每 5s 采样，连续 3 次相同才取终值（P1c 教训：短采样会继续涨）
#   - 判据：Δn_tup_upd == Σ(min(1001,bars)+2)
# 纪律：只写 run 行（前缀 T250-BASE-），末尾删除；不新建库、不改 schema。
set -uo pipefail
export TZ=UTC
PSQL() { docker exec -i eestock-timescaledb psql -U eestock -d eestock "$@"; }
snap() { PSQL -Atc "SELECT n_tup_upd||'|'||n_tup_ins||'|'||n_tup_del FROM pg_stat_user_tables WHERE relname='strategy_run'"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
API=http://127.0.0.1:18081
VER=sv_1789013713975_000001
PORT=18081

cat > /tmp/app_tester_instr_18081.toml <<EOF
database_url = "postgres://eestock:eestock@127.0.0.1:5433/eestock"
listen = "127.0.0.1:$PORT"
mcp_listen = "127.0.0.1:18082"
static_dir = "./web/dist"
health_window_secs = 3600
ws_poll_ms = 3000
alert_eval_ms = 3600000
EOF

settle() { # label -> echoes samples, prints final value to stdout only
  local label="$1" prev="" same=0 t=0 v
  while [ $t -lt 24 ]; do
    v=$(snap); t=$((t+1))
    if [ "$v" = "$prev" ]; then same=$((same+1)); else same=0; fi
    prev=$v
    echo "  ${label}[$(iso)] $v" >&2
    [ $same -ge 3 ] && break
    sleep 5
  done
  printf '%s' "$prev"
}

submit() { # tag symbol period from to  -> writes rid to /tmp/p4b_250_last_rid
  local tag="$1" symbol="$2" period="$3" from="$4" to="$5" resp rid
  local body
  body=$(cat <<JSON
{"name":"T250-BASE-$tag","symbol":"$symbol","period":"$period","from":"$from","to":"$to",
 "slots":[{"version_id":"$VER","params":{"fast":5.0,"slow":20.0},"weight":1.0}],
 "buy_threshold":60.0,"sell_threshold":40.0,"policy":{"LumpSum":{"position_pct":1.0}},"initial_capital":100000.0}
JSON
)
  resp=$(curl -s -m 60 -X POST "$API/api/workbench/runs" -H 'content-type: application/json' -d "$body" -w '\n[http=%{http_code} wall=%{time_total}s]')
  echo "[SUBMIT $tag] $(printf '%s' "$resp" | tail -1)" >&2
  rid=$(printf '%s' "$resp" | grep -o '"id":"sr_[^"]*"' | head -1 | sed 's/^"id":"//; s/"$//')
  [ -z "$rid" ] && { echo "[FATAL $tag] 无 run_id: $resp" >&2; return 1; }
  printf '%s' "$rid" > /tmp/p4b_250_last_rid
}

wait_one() { # rid tag
  local rid="$1" tag="$2" st="" i=0
  while :; do
    st=$(curl -s -m 10 "$API/api/workbench/runs/$rid" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    case "$st" in succeeded|failed|canceled) break;; esac
    i=$((i+1)); [ $i -gt 6000 ] && { echo "[FATAL $tag] 轮询超时" >&2; break; }
    sleep 0.02
  done
  echo "[TERM   $tag] status=$st rid=$rid" >&2
}

row() { PSQL -Atc "SELECT '${2}|row|'||s.id||'|'||s.period||'|'||s.symbol||'|'||s.status||
  '|progress='||s.progress||'|bars='||coalesce(jsonb_array_length(r.per_bar)::text,'NULL')||
  '|dur_s='||round(EXTRACT(EPOCH FROM (s.finished_at-s.started_at))::numeric,6)
  FROM strategy_run s LEFT JOIN strategy_run_result r ON r.run_id=s.id WHERE s.id='${1}'"; }

echo "# ===== ADR-024 P4b ② 基线独立复现（tester 自跑；长窗口 PG 协议）====="
echo "# date_utc : $(iso)"
echo "# binary   : /tmp/eestock-app-instr-250 sha256=$(sha256sum /tmp/eestock-app-instr-250 | cut -d' ' -f1)"
echo "# app 源码 : crates/application/src/workbench.rs sha256=$(sha256sum crates/application/src/workbench.rs | cut -d' ' -f1)（== index 交付态）"
echo "# config   : /tmp/app_tester_instr_18081.toml（listen 127.0.0.1:18081；DB=活库 eestock）"
echo "# 协议     : 前置 idle guard（连续 3 次相同）→ 3 档串行 → 后置 settle（连续 3 次相同）"
echo

pkill -f 'eestock-app-instr-250 --config /tmp/app_tester_instr_18081.toml' 2>/dev/null
sleep 0.3
/tmp/eestock-app-instr-250 --config /tmp/app_tester_instr_18081.toml > /tmp/app_tester_instr_18081.json.log 2>&1 &
APPPID=$!
echo "# app pid  : $APPPID"
for i in $(seq 1 150); do
  c=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$API/healthz" || true)
  [ "$c" = "200" ] && break; sleep 0.2
done
echo "# healthz  : $(curl -s -o /dev/null -m 2 -w '%{http_code}' "$API/healthz")"
echo

echo "### [0] 前置 idle guard（不提交 run）"
U0=$(settle IDLE)
echo "IDLE strategy_run(tup_upd|ins|del): $U0"
echo

echo "### [1] 三档串行真路径 run"
U1=$(snap)
do_run() {
  local tag="$1" symbol="$2" period="$3" from="$4" to="$5"
  submit "$tag" "$symbol" "$period" "$from" "$to"
  local rid; rid=$(cat /tmp/p4b_250_last_rid)
  wait_one "$rid" "$tag"
  row "$rid" "$tag"
}
do_run verify_small_d1_492   518880 D1 2025-09-01T00:00:00Z 2026-09-01T00:00:00Z
do_run verify_medium_m5_3500 159740 M5 2026-06-10T00:00:00Z 2026-09-10T00:00:00Z
do_run verify_large_m1_16155 518880 M1 2026-06-09T01:30:00Z 2026-09-09T07:00:00Z
echo

echo "### [2] 后置 settle"
U2=$(settle POST)
echo "PRE  strategy_run(tup_upd|ins|del): $U1"
echo "POST strategy_run(tup_upd|ins|del): $U2"

PRE_UPD=$(printf '%s' "$U1" | cut -d'|' -f1); POST_UPD=$(printf '%s' "$U2" | cut -d'|' -f1)
PRE_INS=$(printf '%s' "$U1" | cut -d'|' -f2); POST_INS=$(printf '%s' "$U2" | cut -d'|' -f2)
PRE_DEL=$(printf '%s' "$U1" | cut -d'|' -f3); POST_DEL=$(printf '%s' "$U2" | cut -d'|' -f3)
echo "Δn_tup_upd = $((POST_UPD-PRE_UPD))   Δn_tup_ins = $((POST_INS-PRE_INS))   Δn_tup_del = $((POST_DEL-PRE_DEL))"
EXPECT=2500   # (492+2) + (1001+2) + (1001+2)
echo "理论 Σ(min(1001,bars)+2) = $EXPECT  （492+2 / 1001+2 / 1001+2）"
echo

echo "### [3] 并发 4（M5 3500 ×4）—— 交叉核对 worker B4.3 吞吐/放大"
U3=$(snap)
TT0=$(date +%s.%N)
RIDS=()
for i in 1 2 3 4; do
  submit "conc4_$i" 159740 M5 2026-06-10T00:00:00Z 2026-09-10T00:00:00Z
  RIDS+=("$(cat /tmp/p4b_250_last_rid)")
done
for i in 0 1 2 3; do
  n=$((i+1)); wait_one "${RIDS[$i]}" "conc4_$n"
done
W1=$(date +%s.%N)
echo "[CONC4] wall_total=$(python3 -c "print(f'{$W1-$TT0:.3f}')")s  runs=4  throughput=$(python3 -c "print(f'{4/($W1-$TT0):.4f}')") run/s"
U4=$(settle POST2)
echo "PRE-C4  strategy_run: $U3"
echo "POST-C4 strategy_run: $U4"
PRE4=$(printf '%s' "$U3" | cut -d'|' -f1); POST4=$(printf '%s' "$U4" | cut -d'|' -f1)
echo "Δn_tup_upd(并发4) = $((POST4-PRE4))  理论 = $((1001+2))×4 = 4012"
echo

echo "### [4] 清理（按前缀删除）"
PSQL -c "DELETE FROM strategy_run WHERE name LIKE 'T250-BASE-%'"
echo "残留 T250-BASE-%: $(PSQL -Atc "SELECT count(*) FROM strategy_run WHERE name LIKE 'T250-BASE-%'")"
echo "孤儿结果行: $(PSQL -Atc "SELECT count(*) FROM strategy_run_result r LEFT JOIN strategy_run s ON s.id=r.run_id WHERE s.id IS NULL")"
echo "strategy_run 行数: $(PSQL -Atc 'SELECT count(*) FROM strategy_run') / result: $(PSQL -Atc 'SELECT count(*) FROM strategy_run_result')"
echo

echo "### [5] 停止实例"
kill $APPPID 2>/dev/null
sleep 0.6
echo "残进程: $(pgrep -f 'app_tester_instr_18081' | wc -l)  18081 http=$(curl -s -o /dev/null -m 2 -w '%{http_code}' $API/healthz || echo 000)"
echo "prod 8081 http=$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:8081/healthz || echo 000)  pid=4083225 alive=$(kill -0 4083225 2>/dev/null && echo yes || echo no)"
echo "### —— 结束 ——"
