#!/usr/bin/env bash
# ADR-024 P1c ① — 每 run 进度 UPDATE 次数的真路径直接测量（**免改生产代码**，v2：带统计沉降等待）
#
# 关键修正（v1 教训）：PG15+ 的 per-table 统计由**该后端**每 ~1s 才 flush 一次
# （v1 实测：run 终态后 10s 内 n_tup_upd 仍 +72）。因此每次取快照前必须等计数**稳定**，
# 否则会把上一次 run 的尾数计入本次（v1 的 Δ 因此失真）。
#
# 测量：Δn_tup_upd(strategy_run) 覆盖 [pre, post] 窗口；窗口内并发度由
#       strategy_run.started_at/finished_at 交集判定（并记录 inflight 前置检查）。
set -uo pipefail
export TZ=UTC
API=http://127.0.0.1:8081
PSQL() { docker exec -i eestock-timescaledb psql -U eestock -d eestock "$@"; }
snap() { PSQL -Atc "SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='strategy_run'"; }
ins()  { PSQL -Atc "SELECT n_tup_ins FROM pg_stat_user_tables WHERE relname='strategy_run'"; }
dbsnap() { PSQL -Atc "SELECT tup_updated||'|'||xact_commit FROM pg_stat_database WHERE datname='eestock'"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

# settle: 等 n_tup_upd 连续 4 次采样（间隔 0.5s）不变；最多 40s。
settle() {
  local last=-1 same=0 v t=0
  while [ $t -lt 80 ]; do
    v=$(snap); t=$((t+1))
    if [ "$v" = "$last" ]; then same=$((same+1)); else same=0; fi
    last=$v
    [ $same -ge 4 ] && { echo "$v"; return 0; }
    sleep 0.5
  done
  echo "$v"
}

echo "# ===== ADR-024 P1c ① 真路径每 run UPDATE 计数 ===== (v2 settle)"
echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# engine_commit : $(git -C ../../.. rev-parse HEAD)"
echo "# app binary    : $(ls -l /proc/$(pgrep -f 'eestock-app --config /tmp/app_dev_8081.toml' | head -1)/exe 2>/dev/null | sed 's/.*-> //')"
echo "# app pid       : $(pgrep -f 'eestock-app --config /tmp/app_dev_8081.toml' | head -1)  cmdline=$(tr '\0' ' ' < /proc/$(pgrep -f 'eestock-app --config /tmp/app_dev_8081.toml' | head -1)/cmdline)"
echo "# db            : postgres://eestock@127.0.0.1:5433/eestock (app config /tmp/app_dev_8081.toml)"
echo "# API           : $API (现网 REST = 生产真路径)"
echo

probe() { # $1=tag $2=symbol $3=period $4=from $5=to
  local tag="$1" symbol="$2" period="$3" from="$4" to="$5"
  local inflight pre_u pre_i pre_db pre_t
  pre_u=$(settle); pre_i=$(ins)
  inflight=$(PSQL -Atc "SELECT count(*) FROM strategy_run WHERE status IN ('queued','running');")
  pre_db=$(dbsnap); pre_t="$(iso)"
  local body
  body=$(cat <<JSON
{"name":"ADR024-P1c-probe-$tag","symbol":"$symbol","period":"$period","from":"$from","to":"$to",
 "slots":[{"version_id":"sv_1789013713975_000001","params":{"fast":5.0,"slow":20.0},"weight":1.0}],
 "buy_threshold":60.0,"sell_threshold":40.0,"policy":{"LumpSum":{"position_pct":1.0}},"initial_capital":100000.0}
JSON
)
  local submit_resp run_id
  submit_resp=$(curl -s -m 20 -X POST "$API/api/workbench/runs" -H 'content-type: application/json' -d "$body" -w '\n[http=%{http_code} wall=%{time_total}s]')
  echo "[SUBMIT $tag] pre_t=$pre_t pre_tup_upd=$pre_u pre_tup_ins=$pre_i pre_db(tup_updated|xact_commit)=$pre_db inflight_before=$inflight"
  echo "[RESPID $tag] $(printf '%s' "$submit_resp" | grep -o '"id":"sr_[^"]*"' | head -1)  $(printf '%s' "$submit_resp" | tail -1)"
  run_id=$(printf '%s' "$submit_resp" | grep -o '"id":"sr_[^"]*"' | head -n1 | sed 's/^"id":"//; s/"$//')
  if [ -z "$run_id" ]; then echo "[FATAL  $tag] 未能解析 run_id"; return 1; fi
  echo "[RUNID  $tag] $run_id"

  local st="" i=0
  while :; do
    st=$(curl -s -m 10 "$API/api/workbench/runs/$run_id" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
    if [ "$st" = "succeeded" ] || [ "$st" = "failed" ] || [ "$st" = "canceled" ]; then break; fi
    i=$((i+1)); [ $i -gt 6000 ] && { echo "[FATAL  $tag] 轮询超时"; break; }
    sleep 0.05
  done
  local term_t; term_t="$(iso)"
  local post_u; post_u=$(settle)
  local post_i post_db post_t
  post_i=$(ins); post_db=$(dbsnap); post_t="$(iso)"
  echo "[TERM   $tag] status=$st term_t=$term_t post_t=$post_t"
  echo "[DELTA  $tag] tup_upd: $pre_u -> $post_u  Δ_upd=$((post_u-pre_u))   tup_ins: $pre_i -> $post_i (Δ=$((post_i-pre_i)))"
  echo "[DELTA  $tag] db: $pre_db -> $post_db"
  PSQL -Atc "SELECT '$tag|row|'||id||'|'||period||'|'||symbol||'|'||status||'|progress='||progress||'|started='||coalesce(started_at::text,'-')||'|finished='||coalesce(finished_at::text,'-') FROM strategy_run WHERE id='$run_id'"
  PSQL -Atc "SELECT '$tag|bars|id='||s.id||'|bars_per_bar='||coalesce(jsonb_array_length(r.per_bar)::text,'NULL')||'|trades='||coalesce(jsonb_array_length(r.trades)::text,'NULL')||'|dur_s='||round(EXTRACT(EPOCH FROM (s.finished_at-s.started_at))::numeric,6)||'|per_bar_bytes='||coalesce(pg_column_size(r.per_bar)::text,'NULL') FROM strategy_run s LEFT JOIN strategy_run_result r ON r.run_id=s.id WHERE s.id='$run_id'"
  PSQL -Atc "SELECT '$tag|concurrency|window=['||'$pre_t'||','||'$post_t'||']|overlapping_other_runs='||count(*) FROM strategy_run WHERE id<>'$run_id' AND started_at < '$post_t'::timestamptz AND (finished_at IS NULL OR finished_at > '$pre_t'::timestamptz)"
  echo "[TAG   $tag] done"; echo
}

echo "### —— 前置：闲置漂移对照（不提交任何 run）——"
A=$(snap); A2=$(dbsnap); sleep 15; B=$(snap); B2=$(dbsnap)
echo "IDLE before=$A after=$B Δ=$((B-A))  db before=$A2 after=$B2"
echo

# T1 小档：D1 242 根 in-range + 250 warmup = 492 bar（帧数应 = bars = 492）
probe t1_small_d1_492   518880 D1 2025-09-01T00:00:00Z 2026-09-01T00:00:00Z
# T4 小档 2：M5 400 + 250 = 650 bar（再验「帧数 = bars」线性区）
probe t4_small2_m5_650  159740 M5 2026-08-27T00:00:00Z 2026-09-08T00:00:00Z
# T2 中档：M5 3250 + 250 = 3500 bar（>1000 ⇒ 帧数应饱和 = 1001）
probe t2_medium_m5_3500 159740 M5 2026-06-10T00:00:00Z 2026-09-10T00:00:00Z
# T3 大档：M1 15905 + 250 = 16155 bar（>1000 ⇒ 帧数应饱和 = 1001；n 增 4.6× 而帧数不变）
probe t3_large_m1_16155 518880 M1 2026-06-09T01:30:00Z 2026-09-09T07:00:00Z

echo "### —— 后置：闲置漂移对照 ——"
A=$(snap); sleep 15; B=$(snap)
echo "IDLE2 before=$A after=$B Δ=$((B-A))"
PSQL -Atc "SELECT 'TOTAL n_tup_upd='||n_tup_upd||' n_tup_ins='||n_tup_ins||' n_tup_del='||n_tup_del FROM pg_stat_user_tables WHERE relname='strategy_run'"
echo "### —— 结束 ——"
