#!/usr/bin/env bash
# 取证命令清单（只读；本文件仅记录"实际执行过"的命令，供复现）
# 目录：coder/evidence/20260918_sr_trades_forensics/
# 纪律：无 UPDATE/INSERT/DELETE/DDL；无 git add/commit；除本目录外不改仓库文件。
set -x
cd /home/eestock/workspace/git/eestock/eestock-rs
E=coder/evidence/20260918_sr_trades_forensics
RUN=sr_1789738328788_000005
PSQL="PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d eestock"

# 0) 真实表名/列名
$PSQL -c '\d strategy_run*'                                     > $E/00_schema_strategy_run.txt

# 1) 记录存在性与元信息
$PSQL -x -c "SELECT id,name,symbol,period,from_ts,to_ts,status,progress,error,created_at,started_at,finished_at,config FROM strategy_run WHERE id='$RUN';"  > $E/01_run_meta.txt
$PSQL -c "SELECT id,name,symbol,period,status,created_at,finished_at FROM strategy_run WHERE id LIKE 'sr_1789738328788%' ORDER BY id;"                 > $E/02_run_prefix_fuzzy.txt

# 2) result_format + 各块行数
$PSQL -c "SELECT run_id,result_format,jsonb_typeof(per_bar) pb_type,jsonb_array_length(per_bar) pb_len,jsonb_typeof(trades) tr_type,CASE WHEN jsonb_typeof(trades)='array' THEN jsonb_array_length(trades) END tr_len,jsonb_typeof(net_value) nv_type,jsonb_array_length(net_value) nv_len,jsonb_array_length(drawdown) dd_len,metrics FROM strategy_run_result WHERE run_id='$RUN';" > $E/03_result_shape.txt
$PSQL -c "SELECT kind,count(*) n,min(seq) min_seq,max(seq) max_seq,min(ts_from) min_ts,max(ts_to) max_ts FROM strategy_run_bars WHERE run_id='$RUN' GROUP BY kind ORDER BY kind;" > $E/04_bars_by_kind.txt
$PSQL -c "SELECT run_id,kind,seq,ts_from,ts_to,jsonb_typeof(payload) ptype,pg_column_size(payload) bytes,CASE WHEN jsonb_typeof(payload)='array' THEN jsonb_array_length(payload) END alen,left(payload::text,400) preview FROM strategy_run_bars WHERE run_id='$RUN' ORDER BY kind,seq;" > $E/05_bars_payload_shape.txt

# 3) 原始 payload（fills / trades / per_bar）
$PSQL -t -A -c "SELECT payload::text FROM strategy_run_bars WHERE run_id='$RUN' AND kind='fills';"    > $E/06_fills_payload_raw.json
$PSQL -t -A -c "SELECT trades::text  FROM strategy_run_result WHERE run_id='$RUN';"                   > $E/10_trades_raw.json
$PSQL -t -A -c "SELECT payload::text FROM strategy_run_bars WHERE run_id='$RUN' AND kind='per_bar';"  > $E/27_per_bar_payload_raw.json

# 4) 同标的历史 run 对照
$PSQL -c "SELECT r.id,r.symbol,r.period,r.status,r.created_at,r.finished_at,(r.config->>'policy') policy,(r.config->>'buy_threshold') bt,(r.config->>'sell_threshold') st,x.result_format,CASE WHEN jsonb_typeof(x.trades)='array' THEN jsonb_array_length(x.trades) END trades_n FROM strategy_run r LEFT JOIN strategy_run_result x ON x.run_id=r.id WHERE r.symbol='518880' ORDER BY r.created_at DESC LIMIT 15;" > $E/12_same_symbol_runs.txt
$PSQL -t -A -c "SELECT jsonb_pretty(to_jsonb(v)) FROM strategy_version v WHERE v.id='sv_1789211089727_000010';" > $E/21_strategy_version.txt
$PSQL -x -c "SELECT id,name,created_at,config FROM strategy_preset ORDER BY created_at DESC LIMIT 5;" > $E/22_presets.txt

# 5) 真打 8081（web/API 双链路并排）
B=http://127.0.0.1:8081
curl -sS -o $E/13_resp_runs_sr_1789738328788_000005.json                                -w 'HTTP %{http_code}\n' "$B/api/workbench/runs/$RUN"
curl -sS -o $E/13_resp_runs_sr_1789738328788_000005_result.json                         -w 'HTTP %{http_code}\n' "$B/api/workbench/runs/$RUN/result"
curl -sS -o $E/13_resp_runs_sr_1789738328788_000005_brief.json                          -w 'HTTP %{http_code}\n' "$B/api/workbench/runs/$RUN/brief"
curl -sS -o $E/13_resp_runs_sr_1789738328788_000005_curve.json                          -w 'HTTP %{http_code}\n' "$B/api/workbench/runs/$RUN/curve"
curl -sS -o $E/13_resp_runs_sr_1789738328788_000005_fills_offset_0_limit_100.json       -w 'HTTP %{http_code}\n' "$B/api/workbench/runs/$RUN/fills?offset=0&limit=100"
curl -sS -o $E/13_resp_runs_sr_1789738328788_000005_bars_kind_per_bar_offset_0_limit_2.json -w 'HTTP %{http_code}\n' "$B/api/workbench/runs/$RUN/bars?kind=per_bar&offset=0&limit=2"

# 6) 归因实验：按实现口径重算 trade，并与落库值逐字段比对
python3 $E/18_pairing_experiment.py

# 7) 服务进程/端口/日志
ss -tlnp | grep -E '8081|8082'
tr '\0' ' ' < /proc/2043164/cmdline
grep -n 'sr_1789738328788_000005' logs/app_dev_8081_redeploy_20260918_180445.log
grep -n 'mcp sse' logs/app_dev_8081_redeploy_20260918_180445.log
