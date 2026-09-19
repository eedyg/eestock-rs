#!/usr/bin/env bash
# ADR-027 §2.4 D3 — P0 归档恢复校验（隔离临时库）
# 严格边界：本脚本唯一的删除动作 = DROP DATABASE tmp_p0_<ts>。
#           绝不执行 TRUNCATE / DELETE / DROP TABLE。
# 临时库生命周期 = 本脚本单段流程：CREATE → pg_restore → 逐表 count 比对 → 立即 DROP（trap 兜底）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PGPASSWORD="${PGPASSWORD:-eestock}"
DB_HOST="127.0.0.1"
DB_PORT="5433"
DB_USER="eestock"
SRC_DB="eestock"
ADMIN_DB="postgres"

DUMP="$HERE/$(cat "$HERE/.dump_name")"
MANIFEST="$HERE/manifest.tsv"
OUT="$HERE/restore_verify.log"

TMP_TS="$(date -u +%Y%m%dT%H%M%SZ | tr 'A-Z' 'a-z')"
TMP_DB="tmp_p0_${TMP_TS}"          # 命名契约：tmp_p0_ + 时间戳
ADMIN_URL="postgres://${DB_USER}:${DB_PASS:-eestock}@${DB_HOST}:${DB_PORT}/${ADMIN_DB}"
TMP_URL="postgres://${DB_USER}:${DB_PASS:-eestock}@${DB_HOST}:${DB_PORT}/${TMP_DB}"

TABLES=(strategy_run strategy_run_result strategy_run_bars simsession simsession_result simsession_state sim_trades sim_positions)

log() { echo "$*" | tee -a "$OUT"; }

# ---- 兜底：无论如何退出，都立即 DROP 本流程创建的临时库（绝不留残留）----
created=0
cleanup() {
    rc=$?
    trap - EXIT
    if [ "$created" = "1" ]; then
        log "[cleanup] DROP DATABASE ${TMP_DB} (exit_rc=${rc})"
        psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"${TMP_DB}\" WITH (FORCE);" \
            >>"$OUT" 2>&1 || log "[cleanup] ⚠ DROP 失败，需人工介入"
    fi
    exit $rc
}
trap cleanup EXIT

: > "$OUT"
log "=== ADR-027 P0 归档恢复校验 $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
log "dump=$DUMP"
log "tmp_db=$TMP_DB"

# ---- 1) 建临时库（同段流程入口）----
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${TMP_DB}\";" >>"$OUT" 2>&1
created=1
log "[1] CREATE DATABASE ${TMP_DB} OK"

# ---- 2) 恢复 dump（--no-owner 保持数据面可比；schema/表/数据全量）----
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$TMP_DB" \
    --no-owner --no-privileges --exit-on-error "$DUMP" >>"$OUT" 2>&1
log "[2] pg_restore OK"

# ---- 3) 逐表 count 与 manifest 比对 ----
log "[3] 逐表 count 比对 (manifest vs restored):"
fail=0
while IFS=$'\t' read -r tbl expect; do
    case "$tbl" in ''|\#*) continue ;; esac
    got=$(psql "$TMP_URL" -Atc "SELECT count(*) FROM public.\"${tbl}\";")
    if [ "$got" = "$expect" ]; then
        log "  PASS  ${tbl}: manifest=${expect} restored=${got}"
    else
        log "  FAIL  ${tbl}: manifest=${expect} restored=${got}"
        fail=1
    fi
done < "$MANIFEST"

if [ "$fail" = "0" ]; then
    log "[3] 结果: ALL TABLES MATCH (8/8)"
else
    log "[3] 结果: MISMATCH DETECTED"
fi

# ---- 4) 立即 DROP 临时库（不留到最后）----
log "[4] 立即 DROP DATABASE ${TMP_DB}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"${TMP_DB}\" WITH (FORCE);" >>"$OUT" 2>&1
created=0
log "[4] DROP DATABASE ${TMP_DB} OK"

# ---- 5) 残留证明：psql -l 不含 tmp_p0 ----
log "[5] psql -l 中 tmp_p0 匹配行（应为空）:"
leftover=$(psql "$ADMIN_URL" -Atc "SELECT datname FROM pg_database WHERE datname LIKE 'tmp_p0_%';")
if [ -z "$leftover" ]; then
    log "  NONE — 无 tmp_p0 残留"
else
    log "  LEFTOVER: $leftover"
fi

log "=== 比对结论: $([ "$fail" = 0 ] && echo PASS || echo FAIL) ==="
exit "$fail"
