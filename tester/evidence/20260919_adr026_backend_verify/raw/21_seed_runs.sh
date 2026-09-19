#!/usr/bin/env bash
# Tester ADR-026 阶段2：把 3 个目标 run 的**事实行**从活库只读复制到 ADR-025 临时库。
# 对源库零写（显式 default_transaction_read_only=on）。用法：TDB=<临时库名> bash 21_seed_runs.sh
set -euo pipefail
TDB="${TDB:?临时库名}"
D=/tmp/adr026_verify_seed
mkdir -p "$D"
export PGPASSWORD=eestock
RUNS="'sr_1789738328788_000005','sr_1789738272901_000004','sr_1789044295239_000111'"

live_psql() { PGOPTIONS='-c default_transaction_read_only=on' psql -h 127.0.0.1 -p 5433 -U eestock -d eestock "$@"; }
tdb_psql()  { psql -h 127.0.0.1 -p 5433 -U eestock -d "$TDB" "$@"; }

echo "## 源库（活库，只读）逐表导出原文"
live_psql -c "\copy (SELECT id,name,symbol,period,from_ts,to_ts,config,status,progress,error,created_at,started_at,finished_at FROM strategy_run WHERE id IN ($RUNS) ORDER BY id) TO '$D/strategy_run.csv' WITH (FORMAT csv)"
live_psql -c "\copy (SELECT run_id,per_bar,trades,net_value,drawdown,metrics,result_format FROM strategy_run_result WHERE run_id IN ($RUNS) ORDER BY run_id) TO '$D/strategy_run_result.csv' WITH (FORMAT csv)"
live_psql -c "\copy (SELECT run_id,kind,seq,ts_from,ts_to,payload FROM strategy_run_bars WHERE run_id IN ($RUNS) ORDER BY run_id,kind,seq) TO '$D/strategy_run_bars.csv' WITH (FORMAT csv)"

echo "## 行数"
wc -l "$D"/strategy_run.csv "$D"/strategy_run_result.csv "$D"/strategy_run_bars.csv

echo "## 目标库（临时库）导入"
tdb_psql -c "\copy strategy_run(id,name,symbol,period,from_ts,to_ts,config,status,progress,error,created_at,started_at,finished_at) FROM '$D/strategy_run.csv' WITH (FORMAT csv)"
tdb_psql -c "\copy strategy_run_result(run_id,per_bar,trades,net_value,drawdown,metrics,result_format) FROM '$D/strategy_run_result.csv' WITH (FORMAT csv)"
tdb_psql -c "\copy strategy_run_bars(run_id,kind,seq,ts_from,ts_to,payload) FROM '$D/strategy_run_bars.csv' WITH (FORMAT csv)"

echo "## 目标库回读"
tdb_psql -c "select r.id, r.status, r.config->>'initial_capital' ic, s.result_format, jsonb_array_length(s.trades) trades, (select count(*) from strategy_run_bars b where b.run_id=r.id) bar_rows from strategy_run r join strategy_run_result s on s.run_id=r.id order by r.id;"
