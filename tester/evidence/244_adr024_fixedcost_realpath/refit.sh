#!/usr/bin/env bash
# ADR-024 P1c ③ —— ⑤ 重拟合（排除并发混杂）：只读 SQL 导出 + 纯本地拟合。
# 不改任何探测脚本；数据源 = 活库 374 条 succeeded run（与 243_.../calibration/runs_prod.csv 同口径 + concurrent 列）。
set -uo pipefail
docker exec -i eestock-timescaledb psql -U eestock -d eestock -Atc "\copy (WITH r AS (SELECT s.id, s.period, s.symbol, s.started_at, s.finished_at, jsonb_array_length(res.per_bar) AS bars, jsonb_array_length(s.config->'slots') AS slots, EXTRACT(EPOCH FROM (s.finished_at - s.started_at)) AS dur_s FROM strategy_run s JOIN strategy_run_result res ON res.run_id = s.id WHERE s.status='succeeded' AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL) SELECT a.id, a.period, a.symbol, a.bars, a.slots, a.dur_s, (SELECT count(*) FROM r b WHERE b.id <> a.id AND b.started_at < a.finished_at AND b.finished_at > a.started_at) AS concurrent, a.started_at FROM r a ORDER BY a.started_at) TO STDOUT WITH CSV HEADER" > runs_p1c.csv
echo "[csv] rows=$(wc -l < runs_p1c.csv)"
