#!/usr/bin/env bash
# Tester 本轮全部只读命令（可复跑）。禁止：任何 INSERT/UPDATE/DELETE/DDL、任何 git add/commit、任何仓库源码改动。
# 复核者注意：探针工程在 /tmp（不在仓库内）；其源码已存档在 raw/44_*_Cargo.toml.txt / raw/46_* / raw/48_*。
set -u
RAW="$(cd "$(dirname "$0")" && pwd)"
cd "$RAW/../.."        # eestock-rs
export PGPASSWORD=eestock
PSQL="psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -X -A -F| -t"

echo "== 0) 元信息 =="
date -Is
git status --porcelain | head -50
git diff --stat

echo "== 1) 目标 run 元信息 / 结果形状 =="
$PSQL -c "select * from strategy_run where id='sr_1789738328788_000005'" -x
$PSQL -c "select run_id, result_format, metrics from strategy_run_result where run_id='sr_1789738328788_000005'"
$PSQL -c "select kind, count(*), sum(jsonb_array_length(payload)) from strategy_run_bars where run_id='sr_1789738328788_000005' group by kind order by kind"

echo "== 2) 原始块导出（raw/10..15） =="
$PSQL -c "select payload::text from strategy_run_bars where run_id='sr_1789738328788_000005' and kind='fills'"      > raw/10_fills_raw.json
$PSQL -c "select payload::text from strategy_run_bars where run_id='sr_1789738328788_000005' and kind='per_bar'"    > raw/11_per_bar_raw.json
$PSQL -c "select payload::text from strategy_run_bars where run_id='sr_1789738328788_000005' and kind='net_value'"  > raw/12_net_value_raw.json
$PSQL -c "select payload::text from strategy_run_bars where run_id='sr_1789738328788_000005' and kind='drawdown'"   > raw/13_drawdown_raw.json
$PSQL -c "select trades::text  from strategy_run_result where run_id='sr_1789738328788_000005'"                     > raw/14_trades_raw.json
$PSQL -c "select metrics::text from strategy_run_result where run_id='sr_1789738328788_000005'"                     > raw/15_metrics_raw.json
$PSQL -c "select config::text  from strategy_run where id='sr_1789738328788_000005'"                                > raw/31_target_config.json

echo "== 3) 原始 D1 K 线（与 crates/storage/src/backtest.rs range_sql(D1) 同口径：accurate ∪ 兜底） =="
# 见 raw/20_d1_bars_union.psv（[1734883200, 1789574401) 半开区间，423 根）
$PSQL -c "select extract(epoch from ts)::bigint, open, high, low, close, coalesce(source,'NULL') from (
  select ts, open, high, low, close, 'tushare'::text source from kline_accurate_1d
   where code='518880' and ts >= to_timestamp(1734883200) and ts < to_timestamp(1789574401)
  union all
  select f.ts, f.open, f.high, f.low, f.close, null::text from kline_1d f
   where f.code='518880' and f.ts >= to_timestamp(1734883200) and f.ts < to_timestamp(1789574401)
     and not exists (select 1 from kline_accurate_1d a where a.code=f.code and a.ts=f.ts)
) m order by ts" > raw/20_d1_bars_union.psv
$PSQL -c "select min(ts), max(ts), now() from (select ts from kline_accurate_1d where code='518880'
          union all select ts from kline_1d where code='518880') u" > raw/21_d1_available_range.txt

echo "== 4) 插件源码 / 值域穷举（raw/50..52） =="
$PSQL -c "select code from strategy_version where id='sv_1789211089727_000010'" > raw/50_sv_code.exact.txt
node raw/51_value_domain_enum.js | tee raw/52_value_domain_enum_out.txt

echo "== 5) 独立重算（Python，不引用上游脚本） =="
python3 raw/40_independent_recompute.py    | tee raw/41_independent_recompute_output.txt
python3 raw/60_independent_policy_ressim.py| tee raw/61_independent_policy_ressim_out.txt
python3 - <<'PY' | tee raw/63_intent_windows.txt
import json,collections
pb=json.load(open('raw/11_per_bar_raw.json')); fills=json.load(open('raw/10_fills_raw.json'))
ob=[(i,) for i,r in enumerate(pb) if r['orders'] and not r['warmup']]
print('决策 bar 总数 =',len(ob))
PY

echo "== 6) 全库扫描（raw/71 旧口径、raw/73 修正口径） =="
$PSQL -f raw/70_global_scan.sql     > raw/71_global_scan.out
$PSQL -f raw/72_global_scan_v2.sql  > raw/73_global_scan_v2.out

echo "== 7) API 面（只读 GET） =="
R=sr_1789738328788_000005
curl -s "http://127.0.0.1:8081/api/workbench/runs/$R/brief"                  > raw/81_api_brief.json
curl -s "http://127.0.0.1:8081/api/workbench/runs/$R/fills?offset=0&limit=100" > raw/82_api_fills.json
curl -s "http://127.0.0.1:8081/api/workbench/runs/$R/curve"                  > raw/83_api_curve.json
curl -s "http://127.0.0.1:8081/api/workbench/runs/$R/result"                 > raw/84_api_result.json

echo "== 8) 双向 run 三方自洽（raw/95..98） =="
# 见 raw/95_*（同一 SQL 口径导出该 run 的 config/per_bar/nav/dd/trades/metrics）与 raw/96_tw_bars.psv
python3 raw/97_twoway_three_way_check.py | tee raw/98_twoway_three_way_check_out.txt

echo "== 9) 越界审计（raw/99_*） =="
git status --porcelain; git diff --stat; git diff --cached --stat
$PSQL -c "select 'strategy_run' t, max(xmin::text::bigint) from strategy_run
  union all select 'strategy_run_result', max(xmin::text::bigint) from strategy_run_result
  union all select 'strategy_run_bars',  max(xmin::text::bigint) from strategy_run_bars"
ps -eo pid,lstart,etime,cmd | grep eestock-app | grep -v grep
ls -la logs/app_dev_8081_redeploy_20260918_180445.log

echo "== 10) Rust 探针（/tmp，不在仓库内） =="
echo "  /tmp/srprobe  : 直接调用 backtest::compute_metrics（对照算例/库内 nav+trades/突变）"
echo "  /tmp/srprobe2 : mock 引擎最小示例（末 bar 丢弃 / 静默跳过 / 双向）+ p5_real（真实插件+真实 bar 全链路重跑）"
echo "  复建： mkdir -p /tmp/srprobe/src /tmp/srprobe2/src/bin && cp raw/44_*_Cargo.toml.txt /tmp/srprobe/Cargo.toml ..."
echo "  运行： cd /tmp/srprobe && cargo run --offline -q"
echo "        cd /tmp/srprobe2 && cargo run --offline -q --bin srprobe2|tee raw/47_engine_probe_out.txt"
echo "        cd /tmp/srprobe2 && cargo run --offline -q --bin p5_real |tee raw/49_engine_real_plugin_probe_out.txt"
