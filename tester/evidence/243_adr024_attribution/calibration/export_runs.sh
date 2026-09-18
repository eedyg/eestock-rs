#!/usr/bin/env bash
# ADR-024 P1b ⑤：既往 production run 的端到端耗时标定样本导出（**只读**）。
# 数据源：活库 eestock（strategy_run + strategy_run_result）；只跑 SELECT，不写任何表。
# 用法：bash export_runs.sh            # 写 runs_prod.csv + runs_prod.sql.txt
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
psql() { docker exec -i eestock-timescaledb psql -U eestock -d eestock "$@"; }

{
  echo "# ===== ADR-024 P1b ⑤ 标定样本导出（只读） ====="
  echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# engine_commit : $(git -C "$root/../../.." rev-parse HEAD)"
  echo "# 口径          : bars_total = jsonb_array_length(strategy_run_result.per_bar)（主口径）；
  echo "#                 bars_est_ts = (to_ts - from_ts)/周期秒（辅助口径，见分析脚本）；
  echo "#                 slots = jsonb_array_length(config->'slots')；
  echo "#                 dur_s = EXTRACT(EPOCH FROM (finished_at - started_at))"
  echo "# 过滤：status='succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL"
  echo
  echo "# ---- SQL ----"
  cat <<'SQL'
\copy (SELECT id, symbol, period, jsonb_array_length(r.per_bar) AS bars, jsonb_array_length(s.config->'slots') AS slots, jsonb_array_length(r.per_bar) * jsonb_array_length(s.config->'slots') AS bar_slots, EXTRACT(EPOCH FROM (s.finished_at - s.started_at)) AS dur_s, EXTRACT(EPOCH FROM (s.to_ts - s.from_ts)) AS span_s, jsonb_array_length(r.trades) AS trades, jsonb_array_length(r.net_value) AS nav, jsonb_array_length(r.drawdown) AS dd, left(s.config->'slots'->0->>'strategy_id', 40) AS strategy_id FROM strategy_run s JOIN strategy_run_result r ON r.run_id = s.id WHERE s.status = 'succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL ORDER BY s.created_at) TO STDOUT WITH CSV HEADER
SQL
  echo
  echo "# ---- 原始输出（CSV） ----"
  psql -c "\copy (SELECT id, symbol, period, jsonb_array_length(r.per_bar) AS bars, jsonb_array_length(s.config->'slots') AS slots, jsonb_array_length(r.per_bar) * jsonb_array_length(s.config->'slots') AS bar_slots, EXTRACT(EPOCH FROM (s.finished_at - s.started_at)) AS dur_s, EXTRACT(EPOCH FROM (s.to_ts - s.from_ts)) AS span_s, jsonb_array_length(r.trades) AS trades, jsonb_array_length(r.net_value) AS nav, jsonb_array_length(r.drawdown) AS dd, left(s.config->'slots'->0->>'strategy_id', 40) AS strategy_id FROM strategy_run s JOIN strategy_run_result r ON r.run_id = s.id WHERE s.status = 'succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL ORDER BY s.created_at) TO STDOUT WITH CSV HEADER"
  echo
  echo "# ---- 周期分布 ----"
  psql -c "SELECT period, count(*), min(jsonb_array_length(r.per_bar)) AS min_bars, max(jsonb_array_length(r.per_bar)) AS max_bars, round(avg(EXTRACT(EPOCH FROM (finished_at-started_at)))::numeric,3) AS avg_dur_s FROM strategy_run s JOIN strategy_run_result r ON r.run_id=s.id WHERE status='succeeded' GROUP BY period ORDER BY period;"
} 2>&1 | tee "$root/runs_prod.sql.txt"
psql -Atc "\copy (SELECT id, symbol, period, jsonb_array_length(r.per_bar) AS bars, jsonb_array_length(s.config->'slots') AS slots, jsonb_array_length(r.per_bar) * jsonb_array_length(s.config->'slots') AS bar_slots, EXTRACT(EPOCH FROM (s.finished_at - s.started_at)) AS dur_s, EXTRACT(EPOCH FROM (s.to_ts - s.from_ts)) AS span_s, jsonb_array_length(r.trades) AS trades, jsonb_array_length(r.net_value) AS nav, jsonb_array_length(r.drawdown) AS dd, left(s.config->'slots'->0->>'strategy_id', 40) AS strategy_id FROM strategy_run s JOIN strategy_run_result r ON r.run_id = s.id WHERE s.status = 'succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL ORDER BY s.created_at) TO STDOUT WITH CSV HEADER" > "$root/runs_prod.csv"
echo "[csv] $root/runs_prod.csv rows=$(wc -l < "$root/runs_prod.csv")"
