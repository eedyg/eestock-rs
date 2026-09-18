#!/usr/bin/env bash
# ADR-024 P1c ① 追加实验：pg 统计 flush 滞后特征化 + 「长窗口」精确计数
#
# 动机（v2 实测）：Δ 与理论帧数不符且各 run 之间存在 +22/+64/+79 的「尾数后到」⇒
# 表级统计由**该后端**按最小间隔才 flush 一次（PG15+ pgstat 的 rate limit）。
# 因此必须：① 先确定 lag 上界；② 用「长窗口」（窗口内统计已完全沉降）取精确差分。
set -uo pipefail
export TZ=UTC
API=http://127.0.0.1:8081
PSQL() { docker exec -i eestock-timescaledb psql -U eestock -d eestock "$@"; }
snap() { PSQL -Atc "SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname='strategy_run'"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

echo "# ===== 统计 flush 滞后特征化（长窗口）====="
echo "# date_utc : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "## 阶段 0：闲置 guard 90s（每 2s 采样；确认无 pending 残留）"
base=$(snap); echo "t=+000s value=$base (Δ0)"
for i in $(seq 1 45); do
  sleep 2; v=$(snap); echo "t=+$(printf '%03d' $((i*2)))s value=$v (Δ$((v-base)))"
done
pre=$v; pre_t=$(iso)
echo "[PRE] $pre_t n_tup_upd=$pre"
echo
echo "## 阶段 1：提交单次受控 run（M5 3250+250=3500 bar）"
resp=$(curl -s -m 20 -X POST "$API/api/workbench/runs" -H 'content-type: application/json' -d '{"name":"ADR024-P1c-lagprobe","symbol":"159740","period":"M5","from":"2026-06-10T00:00:00Z","to":"2026-09-10T00:00:00Z","slots":[{"version_id":"sv_1789013713975_000001","params":{"fast":5.0,"slow":20.0},"weight":1.0}],"buy_threshold":60.0,"sell_threshold":40.0,"policy":{"LumpSum":{"position_pct":1.0}},"initial_capital":100000.0}' -w '\n[http=%{http_code}]')
run_id=$(printf '%s' "$resp" | grep -o '"id":"sr_[^"]*"' | head -n1 | sed 's/^"id":"//; s/"$//')
echo "[RESP] $(printf '%s' "$resp" | tail -1) run_id=$run_id"
i=0
while :; do
  st=$(curl -s -m 10 "$API/api/workbench/runs/$run_id" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  if [ "$st" = "succeeded" ] || [ "$st" = "failed" ] || [ "$st" = "canceled" ]; then break; fi
  i=$((i+1)); [ $i -gt 6000 ] && break; sleep 0.05
done
term_t=$(iso); echo "[TERM] $term_t status=$st"
PSQL -Atc "SELECT 'row|'||id||'|'||period||'|'||symbol||'|started='||started_at::text||'|finished='||finished_at::text FROM strategy_run WHERE id='$run_id'"
PSQL -Atc "SELECT 'bars|'||jsonb_array_length(r.per_bar)||'|dur_s='||round(EXTRACT(EPOCH FROM (s.finished_at-s.started_at))::numeric,6) FROM strategy_run s JOIN strategy_run_result r ON r.run_id=s.id WHERE s.id='$run_id'"
echo
echo "## 阶段 2：终态后每 2s 采样 240s（找 flush 滞后上界）"
t0=$(date +%s)
for i in $(seq 1 120); do
  sleep 2; v=$(snap); now=$(date +%s)
  echo "t=+$(printf '%03d' $((now-t0)))s value=$v (Δpre=$((v-pre))  自上一采样Δ=?)"
done
post=$v; post_t=$(iso)
echo "[POST] $post_t n_tup_upd=$post  Δ(pre→post)=$((post-pre))"
PSQL -Atc "SELECT 'concurrency|overlapping_other_runs='||count(*) FROM strategy_run WHERE id<>'$run_id' AND started_at < '$post_t'::timestamptz AND (finished_at IS NULL OR finished_at > '$pre_t'::timestamptz)"
echo "### end"
