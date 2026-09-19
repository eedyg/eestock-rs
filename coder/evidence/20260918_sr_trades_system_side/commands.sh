#!/usr/bin/env bash
# 复现命令清单 —— sr_1789738328788_000005「回测系统侧」只读取证
# 目录：coder/evidence/20260918_sr_trades_system_side/
# 纪律：无 UPDATE/INSERT/DELETE/DDL；无仓库代码改动；无 git add/commit。
set -u
cd "$(dirname "$0")/../../.."          # → eestock-rs/
E=coder/evidence/20260918_sr_trades_system_side/raw
PSQL="psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -At"
export PGPASSWORD=eestock
RUN=sr_1789738328788_000005

# ── 0. 基本信息 ────────────────────────────────────────────────────────────────
$PSQL -c "select id,symbol,period,from_ts,to_ts,status,config from strategy_run where id='$RUN'" > $E/01_run_meta.txt
$PSQL -c "select jsonb_pretty(metrics) from strategy_run_result where run_id='$RUN'" > $E/02_metrics_raw.json
$PSQL -c "select kind,count(*),min(seq),max(seq) from strategy_run_bars where run_id='$RUN' group by kind order by kind" > $E/03_bars_by_kind.txt
$PSQL -c "select payload from strategy_run_bars where run_id='$RUN' and kind='fills' order by seq"       > $E/04_fills_payload.json
$PSQL -c "select payload from strategy_run_bars where run_id='$RUN' and kind='per_bar'"                 > $E/05_per_bar_payload.json
$PSQL -c "select payload from strategy_run_bars where run_id='$RUN' and kind='net_value'"               > $E/06_net_value_payload.json
$PSQL -c "select payload from strategy_run_bars where run_id='$RUN' and kind='drawdown'"                > $E/07_drawdown_payload.json
$PSQL -c "select jsonb_pretty(trades) from strategy_run_result where run_id='$RUN'"                     > $E/08_trades_raw.json

# ── 1. 原始 K 线（与 storage/src/backtest.rs range_sql() 同口径：accurate ∪ 兜底）──
$PSQL -F'|' -c "
SELECT ts, extract(epoch from ts)::bigint, open, high, low, close, volume, amount, src FROM (
  SELECT ts, open, high, low, close, volume::bigint AS volume, amount, 'accurate'::text AS src
    FROM kline_accurate_1d WHERE code='518880'
  UNION ALL
  SELECT f.ts, f.open, f.high, f.low, f.close, f.volume::bigint, f.amount, 'fallback'
    FROM kline_1d f WHERE f.code='518880'
      AND NOT EXISTS (SELECT 1 FROM kline_accurate_1d a WHERE a.ts=f.ts)
) m ORDER BY ts" > $E/10_d1_all_bars.txt

# ── 2. Y1 独立重算（现金流账 + 8 项绩效逐字段对比）────────────────────────────
python3 $E/20_recompute.py > $E/21_recompute_output.txt

# ── 3. Y2 期末强平：旧内建回测引擎（P4b 退役前）对照 ─────────────────────────
git show b4f09a2^:crates/backtest/src/engine.rs | cat -n | sed -n '1,20p;55,75p;150,175p' \
  > $E/22_old_backtest_engine_forceclose.txt

# ── 4. Y3/Y4 可观测性 grep ───────────────────────────────────────────────────
grep -rniE "dropped|unfilled|unexecuted|discarded|pending" crates/ --include=*.rs > $E/23_dropped_pending_grep.txt
grep -rn "DcaState\|plan_total\|batches_done" crates/ web/ --include=*.rs --include=*.ts --include=*.tsx >> $E/24_dcastate_observability.txt
grep -rn "policy_state\|PolicyState" crates/ web/ --include=*.rs --include=*.ts --include=*.tsx > $E/25_planstate_exposure.txt

# ── 5. Y5 全库扫描 ───────────────────────────────────────────────────────────
$PSQL -c "select count(*) runs, count(*) filter (where status='succeeded') ok from strategy_run" > $E/30_run_inventory.txt
$PSQL -F'|' -c "select r.run_id, r.result_format, r.metrics->>'trade_count', r.metrics->>'net_profit',
  jsonb_array_length(case when jsonb_typeof(r.net_value)='array' then r.net_value else '[]'::jsonb end),
  jsonb_array_length(case when jsonb_typeof(r.trades)='array' then r.trades else '[]'::jsonb end),
  run.symbol, run.period, run.config->>'initial_capital'
  from strategy_run_result r join strategy_run run on run.id=r.run_id order by 1" > $E/31_all_runs_metrics_flat.txt
# 33/42 为 psql -F$'\x01' 导出的全库 dump（导出后 gzip；脚本能读 .psv 或 .psv.gz）：
#   $PSQL -F$'\x01' -c "select r.run_id, run.symbol, run.period, r.result_format,
#     (run.config->>'initial_capital'), r.metrics::text,
#     case when jsonb_typeof(r.net_value)='array' then r.net_value::text else '[]' end,
#     case when jsonb_typeof(r.trades)='array' then r.trades::text else '[]' end,
#     (select count(*) from jsonb_array_elements(r.per_bar) e where e->'orders' <> '[]'::jsonb),
#     (select count(*) from jsonb_array_elements(r.per_bar) e where e->'events' @> '[{\"type\":\"fill\"}]'),
#     (select coalesce(jsonb_agg(jsonb_build_object('ts',e->>'ts','orders',e->'orders')),'[]'::jsonb)::text
#        from jsonb_array_elements(r.per_bar) e where e->'orders' <> '[]'::jsonb)
#     from strategy_run_result r join strategy_run run on run.id=r.run_id order by r.run_id" \
#     | gzip -9 > $E/33_all_runs_dump.psv.gz
python3 $E/34_global_recompute.py > $E/35_global_recompute_output.txt
python3 $E/40_ledger_invariants.py > $E/41_ledger_invariants_output.txt
python3 $E/43_reason_scan.py         > $E/44_reason_scan_output.txt

# ── 6. Y6 资本效率口径量化 ───────────────────────────────────────────────────
python3 $E/60_capital_caliber.py > $E/61_capital_caliber_output.txt

# ── 7. API 对外面（只读 GET）────────────────────────────────────────────────
curl -s "http://127.0.0.1:8081/api/workbench/runs/$RUN/brief"                      > $E/50_api_surface.txt
curl -s "http://127.0.0.1:8081/api/workbench/runs/$RUN/fills?offset=0&limit=100"  >> $E/50_api_surface.txt
curl -s "http://127.0.0.1:8081/api/workbench/runs/$RUN/result"                    >> $E/50_api_surface.txt
curl -s "http://127.0.0.1:8081/api/workbench/runs/$RUN/bars?offset=420&limit=3"    > $E/63_api_last_bar_orders.txt
curl -s "http://127.0.0.1:8081/api/workbench/runs/$RUN/fills?offset=41&limit=3"   >> $E/63_api_last_bar_orders.txt
