#!/usr/bin/env bash
# ADR-023 E6a 红阶段：R3 + R4(b) —— 隔离库语义实验（绝不写活库 eestock）
# 用法：bash r3_r4b_isolated_db.sh
# 产物：本目录 runs/ 下逐条命令输出 + RESULT.txt
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=/home/eestock/workspace/git/eestock/eestock-rs
ADMIN_URL="postgres://eestock:eestock@127.0.0.1:5433/postgres"
LIVE_URL="postgres://eestock:eestock@127.0.0.1:5433/eestock"
DB="adr023_orphan_red_$(date -u +%H%M%S)"
DB_URL="postgres://eestock:eestock@127.0.0.1:5433/$DB"
SQL="$DIR/orphan_detection.sql"
RUNS="$DIR/runs"
mkdir -p "$RUNS"

fail=0
step() { echo "--- $1"; }

step "0. 建隔离库 $DB"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB" 2>&1 | tee "$RUNS/00_create_db.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "CREATE DATABASE 失败 ⇒ INCONCLUSIVE"; exit 2; }

step "1. 按序应用 migrations/0001..最新（psql -f，逐文件、ON_ERROR_STOP，非单事务）"
: > "$RUNS/01_migrate.log"
for f in $(ls "$REPO"/migrations/*.sql | sort); do
  echo "== psql -f $(basename "$f")" >> "$RUNS/01_migrate.log"
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$f" >> "$RUNS/01_migrate.log" 2>&1 || {
    echo "MIGRATION FAILED: $f" | tee -a "$RUNS/01_migrate.log"; fail=1; }
done
echo "migrate exit=$fail（0=全部成功）" | tee -a "$RUNS/01_migrate.log"
psql "$DB_URL" -Atc "select count(*) from timescaledb_information.continuous_aggregates" \
  2>&1 | tee "$RUNS/01b_cagg_count.log"

# 窗口：5m 桶 [01:30,01:35) 与 [01:35,01:40)，UTC 2026-09-03
W_FROM="2026-09-03 01:00:00+00"; W_TO="2026-09-03 02:00:00+00"

ins() { # ins <code> <ts>
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) VALUES ('$1', '$2', 'M1', 3, 3, 3, 3, 100, 100.0, 'tushare') ON CONFLICT (code, ts, period) DO NOTHING"
}
del() { psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "DELETE FROM kline_accurate WHERE code = '$1'"; }
refresh() { psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "CALL refresh_continuous_aggregate('$1', '$W_FROM', '$W_TO')"; }
count() { psql "$DB_URL" -At -f "$SQL" | awk -F'|' '{s+=$2} END {print s+0}'; }
per_table() { psql "$DB_URL" -At -f "$SQL"; }

step "2. R3-1：插 2 行孤儿 fixture（998801/998802，period=M1，两个 5m 桶）→ refresh kline_accurate_5m → 同一份检测 SQL 计数"
ins 998801 "2026-09-03 01:30:00+00"
ins 998802 "2026-09-03 01:35:00+00"
refresh kline_accurate_5m
R3_BEFORE="$(count)"
per_table | tee "$RUNS/02_r3_before_refresh_detect.log"
echo "R3-1 rows=$R3_BEFORE" | tee -a "$RUNS/02_r3_before_refresh_detect.log"
[ "$R3_BEFORE" = "2" ] || fail=1

step "3. R3-2：删掉这 2 行 → refresh 同一窗口 → 计数必须 0"
for c in 998801 998802; do del $c; done
refresh kline_accurate_5m
R3_AFTER="$(count)"
per_table | tee "$RUNS/03_r3_after_delete_and_refresh.log"
echo "R3-2 rows=$R3_AFTER" | tee -a "$RUNS/03_r3_after_delete_and_refresh.log"
[ "$R3_AFTER" = "0" ] || fail=1

step "4. R4(b)-A：插入 → refresh → 删除 → 不再 refresh ⇒ 孤儿残留（证明「只删不重算」留毒）"
ins 998811 "2026-09-03 01:30:00+00"
ins 998812 "2026-09-03 01:35:00+00"
refresh kline_accurate_5m
COUNT_MID="$(count)"
del 998811; del 998812
R4A="$(count)"
per_table | tee "$RUNS/04_r4b_A_no_refresh_after_delete.log"
echo "R4(b)-A: after_insert_refresh=$COUNT_MID  after_delete_no_refresh=$R4A（期望 2）" \
  | tee -a "$RUNS/04_r4b_A_no_refresh_after_delete.log"
[ "$R4A" = "2" ] || fail=1

step "5. R4(b)-B：插入 → refresh → 删除 → 再 refresh 同窗口 ⇒ 0（证明修法有效）"
ins 998821 "2026-09-03 01:30:00+00"
ins 998822 "2026-09-03 01:35:00+00"
refresh kline_accurate_5m
COUNT_MID2="$(count)"
del 998821; del 998822
refresh kline_accurate_5m
R4B="$(count)"
per_table | tee "$RUNS/05_r4b_B_refresh_after_delete.log"
echo "R4(b)-B: after_insert_refresh=$COUNT_MID2  after_delete_and_refresh=$R4B（期望 0）" \
  | tee -a "$RUNS/05_r4b_B_refresh_after_delete.log"
[ "$R4B" = "0" ] || fail=1

step "6. 收尾：活库 eestock 孤儿数（只读，必须仍为 0）+ DROP DATABASE + 无残留证明"
psql "$LIVE_URL" -At -f "$SQL" | tee "$RUNS/06_live_readonly.log"
echo "live_total=$(psql "$LIVE_URL" -At -f "$SQL" | awk -F'|' '{s+=$2} END {print s+0}')" | tee -a "$RUNS/06_live_readonly.log"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE $DB WITH (FORCE)" 2>&1 | tee "$RUNS/07_drop_db.log"
RESID="$(psql "$ADMIN_URL" -Atc "select count(*) from pg_database where datname like 'adr023_orphan_red%'")"
echo "residual_databases=$RESID（期望 0）" | tee "$RUNS/08_residue.log"
echo "residual_tables_in_live=$(psql "$LIVE_URL" -Atc "select count(*) from pg_tables where tablename like '%9988%'")" | tee -a "$RUNS/08_residue.log"

echo "SEMANTIC_EXPERIMENT_EXIT=$fail（0=全部期望达成）" | tee "$DIR/RESULT.txt"
exit $fail
