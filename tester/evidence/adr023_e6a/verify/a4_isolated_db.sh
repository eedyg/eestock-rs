#!/usr/bin/env bash
# A4 检测有效性（隔离库，绝不在活库）：新建一次性库 → migrations 0001..0026 → 2 行孤儿 → refresh → 检测=2
#                                            → 删行 + 同窗 refresh → 检测=0 → DROP DATABASE + 无残留证明
set -uo pipefail
REPO=/home/eestock/workspace/git/eestock/eestock-rs
D=/tmp/adr023-e6a-verify-20260917-013013
DB=eestock_e6a_verify_20260917
export PGPASSWORD=eestock
ADMIN="psql -h 127.0.0.1 -p 5433 -U eestock -d postgres -v ON_ERROR_STOP=1"
DBQ="psql -h 127.0.0.1 -p 5433 -U eestock -d $DB -v ON_ERROR_STOP=1"
W_FROM="2026-09-03 01:00:00+00"; W_TO="2026-09-03 02:00:00+00"
DETECT_SQL="
select 'kline_accurate_5m', count(*) from kline_accurate_5m where code not in (select code from symbols)
union all select 'kline_accurate_15m', count(*) from kline_accurate_15m where code not in (select code from symbols)
union all select 'kline_accurate_30m', count(*) from kline_accurate_30m where code not in (select code from symbols)
union all select 'kline_accurate_1h', count(*) from kline_accurate_1h where code not in (select code from symbols)
union all select 'kline_accurate_1d', count(*) from kline_accurate_1d where code not in (select code from symbols)
union all select 'kline_accurate_1w', count(*) from kline_accurate_1w where code not in (select code from symbols)
union all select 'kline_accurate_1mo', count(*) from kline_accurate_1mo where code not in (select code from symbols)
union all select 'kline_5m', count(*) from kline_5m where code not in (select code from symbols)
union all select 'kline_15m', count(*) from kline_15m where code not in (select code from symbols)
union all select 'kline_1d', count(*) from kline_1d where code not in (select code from symbols)
order by 1"
detect() { $DBQ -Atc "$DETECT_SQL"; }

echo "### STEP 0: pre-state (read-only): residual isolated DBs from prior runs"
$ADMIN -Atc "select datname from pg_database where datname like 'eestock_e6a%'"

echo "### STEP 1: CREATE DATABASE $DB"
$ADMIN -c "CREATE DATABASE $DB" 2>&1; echo "create_exit=$?"

echo "### STEP 2: apply migrations 0001..0026 in order (psql -f, ON_ERROR_STOP=1, NOT single-transaction)"
for f in $(ls $REPO/migrations/0*.sql | sort); do
  out=$(psql -h 127.0.0.1 -p 5433 -U eestock -d $DB -v ON_ERROR_STOP=1 -q -f "$f" 2>&1); ec=$?
  echo "$(basename $f) exit=$ec"
  if [ $ec -ne 0 ]; then echo "$out"; echo "MIGRATION_FAILED"; echo "A4_ABORT"; exit 3; fi
done
echo "migrate_all_exit=0"

echo "### STEP 3: cagg inventory in isolated DB (expect 10)"
$DBQ -Atc "select view_name from timescaledb_information.continuous_aggregates order by 1"

echo "### STEP 4: baseline orphan detection on isolated DB (expect all 0)"
detect

echo "### STEP 5: insert 2 orphan fixture rows (period='M1', code 998801/998802 NOT in symbols)"
$DBQ -Atc "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) VALUES ('998801','2026-09-03 01:30:00+00','M1',3,3,3,3,100,100.0,'tushare')" && echo "ins1_exit=$?"
$DBQ -Atc "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) VALUES ('998802','2026-09-03 01:35:00+00','M1',6.66,6.66,6.66,6.66,777,777.0,'tushare')" && echo "ins2_exit=$?"
$DBQ -Atc "select 'source_rows=' || count(*) from kline_accurate where code in ('998801','998802')"
$DBQ -Atc "select 'symbols_rows_for_stub=' || count(*) from symbols where code in ('998801','998802')"

echo "### STEP 6: refresh kline_accurate_5m [$W_FROM, $W_TO) => materialize"
$DBQ -Atc "CALL refresh_continuous_aggregate('kline_accurate_5m','$W_FROM','$W_TO')" && echo "refresh1_exit=$?"
$DBQ -Atc "select 'materialized_rows=' || count(*) from kline_accurate_5m where code in ('998801','998802')"

echo "### STEP 7: detection after refresh (expect kline_accurate_5m = 2, total 2)"
detect

echo "### STEP 8: delete 2 rows + refresh SAME window (expect 0)"
$DBQ -Atc "DELETE FROM kline_accurate WHERE code in ('998801','998802')" && echo "delete_exit=$?"
$DBQ -Atc "CALL refresh_continuous_aggregate('kline_accurate_5m','$W_FROM','$W_TO')" && echo "refresh2_exit=$?"
detect

echo "### STEP 9: DROP DATABASE (WITH FORCE) + residual proof"
$ADMIN -c "DROP DATABASE $DB WITH (FORCE)" 2>&1; echo "drop_exit=$?"
echo "residual_db_count=$($ADMIN -Atc "select count(*) from pg_database where datname like 'eestock_e6a%'")"
echo "live_db_still_exists=$($ADMIN -Atc "select count(*) from pg_database where datname='eestock'")"
echo "A4_SCRIPT_END_EXIT=0"
