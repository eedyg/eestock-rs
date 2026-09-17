#!/usr/bin/env bash
# testdb-init.sh — ADR-023 E6b：集成测试库的一键初始化（**幂等**）
#
# 目标：让「所有测试池读 EESTOCK_TEST_DATABASE_URL + 哨兵表断言」有可用的库。
#   • 建测试库（默认 `eestock_test`，可用环境变量覆盖库名/端口/账号）
#   • 按 `migrations/*.sql` 文件名顺序应用（`psql -v ON_ERROR_STOP=1 -f`，**不加 -1**：
#     每条迁移独立提交，便于中断后续跑）
#   • 建哨兵表 `_eestock_test_db`（约定值恒为 `test`，test-support 建池时校验）
#   • **只读基线播种**：从活库（默认 `eestock`）只读复制集成测试依赖的最小基线
#     （symbols / strategy / strategy_version / 518880+510050 的 M1），并刷新 D1 cagg。
#     理由：这些测试历史上直连被真实数据面填充过的 dev 库；本刀起测试只连测试库，
#     故测试库必须被供应到可用状态（ADR-023 E6b 父级裁决 A）。**对源库零写**。
#   • 打印可直接 `source`/`eval` 的一行：export EESTOCK_TEST_DATABASE_URL='...'
#
# 幂等：库/表/迁移记录/哨兵均先判存在；播种按「目标表非空即跳过」；重复运行 exit 0 且不报错。
# 迁移用账本表 `_eestock_test_migrations` 记录已应用文件 —— 迁移 DDL 本身大多不幂等
# （`CREATE MATERIALIZED VIEW` 等），故「已应用 = 跳过」。若目标库已存在完整 schema 但无账本
# （如历史手工建的库），则自动认领（backfill 账本）而不重复执行。
#
# 安全：本脚本**只写测试库**（库名拒绝 `eestock`）；对活库只读
#       （播种连接显式 `PGOPTIONS='-c default_transaction_read_only=on'`）。
#
# 用法：
#   scripts/testdb-init.sh            # 初始化并打印 export 行
#   eval "$(scripts/testdb-init.sh)"  # 直接导入环境
#   覆盖：EESTOCK_TEST_DB_NAME / EESTOCK_TEST_DB_PORT / EESTOCK_TEST_DB_HOST /
#         EESTOCK_TEST_DB_USER / EESTOCK_TEST_DB_PASSWORD / EESTOCK_LIVE_DB_NAME
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT=$PWD

DB_HOST="${EESTOCK_TEST_DB_HOST:-127.0.0.1}"
DB_PORT="${EESTOCK_TEST_DB_PORT:-5433}"
DB_USER="${EESTOCK_TEST_DB_USER:-eestock}"
DB_PASS="${EESTOCK_TEST_DB_PASSWORD:-eestock}"
DB_NAME="${EESTOCK_TEST_DB_NAME:-eestock_test}"

if [ "$DB_NAME" = "eestock" ]; then
    echo "[testdb-init] ❌ 拒绝在活库 \`eestock\` 上初始化（这是测试库脚本）。" >&2
    exit 2
fi

export PGPASSWORD="$DB_PASS"
ADMIN_URL="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/postgres"
TEST_URL="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# 日志一律走 stderr：stdout **只**留 export 行，使 `eval "$(scripts/testdb-init.sh)"` 可直接工作。
log() { echo "[testdb-init] $*" >&2; }

# --------------------------------- 0) 源库可达性（**建库之前**的预检）----
# ADR-023 E6b 修正（F2）：早先 `require_live` 只在播种时惰性调用 ⇒ 源库不可达时脚本
# 虽然 exit 3，却**已经留下一个 schema-only 的新库**（脏库）。故把源可达性检查提到建库之前：
# 只要本次运行**需要新建**测试库，就先确认源库可达；不可达 ⇒ exit 3 且**不新建任何库**。
# 库已存在时不预检（保持「已供应好的库可离线幂等重跑」），播种路径仍会各自 `require_live`。
LIVE_DB_NAME="${EESTOCK_LIVE_DB_NAME:-eestock}"
LIVE_URL="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${LIVE_DB_NAME}"
live_checked=0
require_live() {
    [ "$live_checked" = "1" ] && return 0
    if ! psql "$LIVE_URL" -Atc "SELECT 1" >/dev/null 2>&1; then
        log "❌ 源库 \`${LIVE_DB_NAME}\` 不可达：无法播种测试基线（测试库必须可用，否则集成测试会以难解方式失败）。"
        log "   如源库不在默认位置，设 EESTOCK_TEST_DB_HOST/PORT/USER/PASSWORD 或 EESTOCK_LIVE_DB_NAME。"
        exit 3
    fi
    live_checked=1
}

# ---------------------------------------------------------------- 1) 建库 ----
if [ "$(psql "$ADMIN_URL" -Atc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" = "1" ]; then
    log "库 \`${DB_NAME}\` 已存在（跳过建库）"
else
    log "建库 \`${DB_NAME}\` ..."
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB_NAME}\"" >/dev/null
fi

# ------------------------------------------------- 2) 迁移账本 + 顺序应用 ----
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
    "CREATE TABLE IF NOT EXISTS _eestock_test_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null

applied_count=$(psql "$TEST_URL" -Atc "SELECT count(*) FROM _eestock_test_migrations")
if [ "$applied_count" = "0" ] && \
   [ "$(psql "$TEST_URL" -Atc "SELECT to_regclass('public.kline_raw') IS NOT NULL")" = "t" ]; then
    # 已存在完整 schema 但无账本（历史手工建的库）：认领，避免重复执行非幂等 DDL
    log "检测到既有 schema 且账本为空 ⇒ 认领全部迁移文件（不重复执行）"
    for f in migrations/*.sql; do
        psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
            "INSERT INTO _eestock_test_migrations(filename) VALUES ('$(basename "$f")') ON CONFLICT DO NOTHING" >/dev/null
    done
fi

for f in migrations/*.sql; do
    name=$(basename "$f")
    if [ "$(psql "$TEST_URL" -Atc "SELECT 1 FROM _eestock_test_migrations WHERE filename='${name}'")" = "1" ]; then
        continue
    fi
    log "应用迁移 ${name} ..."
    # 注意：不用 `-1`（单事务）—— 与既有运维口径一致，逐条独立提交。
    psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
    psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
        "INSERT INTO _eestock_test_migrations(filename) VALUES ('${name}') ON CONFLICT DO NOTHING" >/dev/null
done
log "迁移应用完成（账本 $(psql "$TEST_URL" -Atc 'SELECT count(*) FROM _eestock_test_migrations') 条）"

# ------------------------------------------------------------ 3) 哨兵表 ----
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
    "CREATE TABLE IF NOT EXISTS _eestock_test_db (value text NOT NULL)" >/dev/null
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO _eestock_test_db(value) SELECT 'test' WHERE NOT EXISTS (SELECT 1 FROM _eestock_test_db)" >/dev/null
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
    "UPDATE _eestock_test_db SET value = 'test' WHERE value IS DISTINCT FROM 'test'" >/dev/null
log "哨兵表 \`_eestock_test_db\` 就绪（value=test）"

# ------------------------------------------- 4) 只读基线播种（源=活库）----
# 由 8 例失败的真实前提反推的最小基线（详见 README「跑集成测试的前置步骤」）：
#   symbols         —— 44 只注册标的 + type（0025 回填 / fee_profile / mcp list_symbols）
#   strategy+version—— published 策略（mcp strategy_list 真实 Registry 体量）
#   kline_accurate  —— 518880 与 510050 的 M1（1m 性能门禁需 ≥500 根；D1 cagg 由其派生）
# 对源库**只读**：PGOPTIONS 强制只读事务；源不可达则响亮失败（拒绝产出空测试库）。
# （`require_live` / `LIVE_*` 定义在 0) 段，建库前即可用。）
seed_copy() { # $1=目标表 $2=源库 SELECT $3=目标表列清单 $4=目标非空判定 SQL
    local tbl="$1" sel="$2" cols="$3" probe="$4" n
    n=$(psql "$TEST_URL" -Atc "$probe")
    if [ "$n" != "0" ]; then
        log "跳过播种 ${tbl}（目标已有 ${n} 行）"
        return 0
    fi
    require_live
    log "播种 ${tbl}（源 ${LIVE_DB_NAME}，只读）..."
    PGOPTIONS='-c default_transaction_read_only=on' \
        psql "$LIVE_URL" -v ON_ERROR_STOP=1 -c "\\copy (${sel}) TO STDOUT WITH (FORMAT csv)" \
        | psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c "\\copy ${tbl} (${cols}) FROM STDIN WITH (FORMAT csv)" >&2
    log "  ${tbl} 播种完成：目标现有 $(psql "$TEST_URL" -Atc "SELECT count(*) FROM ${tbl}") 行"
}

seed_copy symbols \
    "SELECT code,name,interval_secs,settlement,enabled,created_at,type FROM symbols ORDER BY code" \
    "code,name,interval_secs,settlement,enabled,created_at,type" \
    "SELECT count(*) FROM symbols"
seed_copy strategy \
    "SELECT id,name,description,kind,created_by,created_at,updated_at FROM strategy" \
    "id,name,description,kind,created_by,created_at,updated_at" \
    "SELECT count(*) FROM strategy"
seed_copy strategy_version \
    "SELECT id,strategy_id,version,code,params_schema,sha256,status,approval_level,created_at,published_at FROM strategy_version" \
    "id,strategy_id,version,code,params_schema,sha256,status,approval_level,created_at,published_at" \
    "SELECT count(*) FROM strategy_version"

# kline_accurate（M1）单独处理：需在播种后刷新 D1 cagg（全量无窗口 ⇒ 不涉桶边界对齐）。
if [ "$(psql "$TEST_URL" -Atc "SELECT count(*) FROM kline_accurate WHERE period='M1' AND code IN ('518880','510050')")" != "0" ]; then
    log "跳过播种 kline_accurate（目标已有 518880/510050 的 M1）"
else
    require_live
    log "播种 kline_accurate（518880 + 510050 的 M1；源 ${LIVE_DB_NAME}，只读）..."
    PGOPTIONS='-c default_transaction_read_only=on' \
        psql "$LIVE_URL" -v ON_ERROR_STOP=1 -c \
        "\\copy (SELECT code,ts,period,open,high,low,close,volume,amount,source,synced_at FROM kline_accurate WHERE period='M1' AND code IN ('518880','510050')) TO STDOUT WITH (FORMAT csv)" \
        | psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
            "\\copy kline_accurate (code,ts,period,open,high,low,close,volume,amount,source,synced_at) FROM STDIN WITH (FORMAT csv)" >&2
    log "  kline_accurate 播种完成：目标现有 $(psql "$TEST_URL" -Atc "SELECT count(*) FROM kline_accurate") 行"
    # 全量刷新（NULL,NULL）⇒ 无窗口参数，天然不触及「刷新窗口须按 CST 桶边界对齐」的硬规则。
    log "刷新 kline_accurate_1d（全量，无窗口）..."
    psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -c \
        "CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL)" >&2
    log "  kline_accurate_1d 现有 $(psql "$TEST_URL" -Atc "SELECT count(*) FROM kline_accurate_1d") 行"
fi

# --------------------------------------------------------- 5) 打印 export ----
# 唯一 stdout 输出：可直接 `eval "$(scripts/testdb-init.sh)"` 或 `source <(...)`。
echo "export EESTOCK_TEST_DATABASE_URL='${TEST_URL}'"
