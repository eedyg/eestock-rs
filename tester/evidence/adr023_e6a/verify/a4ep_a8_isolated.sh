#!/usr/bin/env bash
# A4(端点同一份 SQL) + A8(哨兵有效性) —— 隔离库：2 行孤儿物化后，端点/端口链路必须报 2（R1 断言 0 ⇒ 变红）
set -uo pipefail
REPO=/home/eestock/workspace/git/eestock/eestock-rs
D=/tmp/adr023-e6a-verify-20260917-013013
DB=eestock_e6a_verify_ep_20260917
export PGPASSWORD=eestock
ADMIN="psql -h 127.0.0.1 -p 5433 -U eestock -d postgres -v ON_ERROR_STOP=1"
DBQ="psql -h 127.0.0.1 -p 5433 -U eestock -d $DB -v ON_ERROR_STOP=1"
W_FROM="2026-09-03 01:00:00+00"; W_TO="2026-09-03 02:00:00+00"

echo "### STEP 1: extract the SINGLE source of truth ORPHAN_ROWS_SQL straight out of crates/storage/src/reader.rs"
awk '/^pub const ORPHAN_ROWS_SQL: &str = r#"/{f=1;next} f&&/^"#;/{exit} f{print}' \
  $REPO/crates/storage/src/reader.rs > $D/orphan_rows_sql_extracted.sql
wc -l $D/orphan_rows_sql_extracted.sql
head -3 $D/orphan_rows_sql_extracted.sql
echo "--- explicit window variant (uncovered-window sentinel probe, A8): only 5m branch over a window that will NOT be refreshed"
cat > $D/a8_probe_uncovered.sql <<'EOF'
SELECT 'kline_accurate_5m' AS table_name, count(*) AS orphan_rows FROM kline_accurate_5m
  WHERE code NOT IN (SELECT code FROM symbols)
EOF

echo "### STEP 2: CREATE DATABASE $DB + migrations 0001..0026"
$ADMIN -c "CREATE DATABASE $DB" 2>&1
for f in $(ls $REPO/migrations/0*.sql | sort); do
  psql -h 127.0.0.1 -p 5433 -U eestock -d $DB -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1 || { echo "MIGRATION_FAILED $f"; echo "A4EP_ABORT"; exit 3; }
done
echo "migrate_all=OK caggs=$($DBQ -Atc 'select count(*) from timescaledb_information.continuous_aggregates')"

echo "### STEP 3: insert 2 orphan rows + materialize (refresh)"
$DBQ -Atc "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) VALUES ('998901','2026-09-03 01:30:00+00','M1',3,3,3,3,100,100.0,'tushare')" >/dev/null
$DBQ -Atc "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) VALUES ('998902','2026-09-03 01:35:00+00','M1',6.66,6.66,6.66,6.66,777,777.0,'tushare')" >/dev/null
$DBQ -Atc "CALL refresh_continuous_aggregate('kline_accurate_5m','$W_FROM','$W_TO')" >/dev/null
echo "materialized_rows=$($DBQ -Atc "select count(*) from kline_accurate_5m where code in ('998901','998902')")"

echo "### STEP 4: run the ACTUAL production SQL constant (extracted verbatim) on the isolated DB"
$DBQ -Atc -f $D/orphan_rows_sql_extracted.sql
echo "--- total = $($DBQ -Atf $D/orphan_rows_sql_extracted.sql | awk -F'|' '{s+=$2} END {print s+0}')"

echo "### STEP 5: A8/A4 — endpoint (real port chain) on isolated DB with orphans: R1 must go RED (left 2 / right 0)"
cd $REPO
DATABASE_URL="postgres://eestock:eestock@127.0.0.1:5433/$DB" \
  cargo test -p web --test orphan_detect_endpoint_red r1_orphan_endpoint_exists_and_reports_zero_on_clean_db -- --nocapture 2>&1 | tail -25
echo "r1_with_orphans_shell_exit=${PIPESTATUS[0]}"

echo "### STEP 5b: A4 — same payload as SQL constant: r2_sql_result_equals_endpoint_payload must PASS on isolated DB (endpoint == single SQL source)"
DATABASE_URL="postgres://eestock:eestock@127.0.0.1:5433/$DB" \
  cargo test -p web --test orphan_detect_sql_constant_red 2>&1 | tail -8

echo "### STEP 6: A8 — construct an UNCOVERED-window orphan probe (5m branch only) after delete+refresh of a DIFFERENT window"
$DBQ -Atc "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) VALUES ('998911','2026-09-04 05:00:00+00','M1',1,1,1,1,10,10.0,'tushare')" >/dev/null
$DBQ -Atc "CALL refresh_continuous_aggregate('kline_accurate_5m','2026-09-04 05:00:00+00','2026-09-04 05:05:00+00')" >/dev/null
$DBQ -Atc "DELETE FROM kline_accurate WHERE code='998911'" >/dev/null
echo "--- after delete WITHOUT refresh of that window: probe (uncovered orphan) =>"
$DBQ -Atf $D/a8_probe_uncovered.sql
echo "--- now refresh that window (the clean() pattern) =>"
$DBQ -Atc "CALL refresh_continuous_aggregate('kline_accurate_5m','2026-09-04 05:00:00+00','2026-09-04 05:05:00+00')" >/dev/null
$DBQ -Atf $D/a8_probe_uncovered.sql

echo "### STEP 7: cleanup + residual proof"
$ADMIN -c "DROP DATABASE $DB WITH (FORCE)" 2>&1
echo "residual_db_count=$($ADMIN -Atc "select count(*) from pg_database where datname like 'eestock_e6a%'")"
echo "live_db_exists=$($ADMIN -Atc "select count(*) from pg_database where datname='eestock'")"
echo "A4EP_SCRIPT_END"
