#!/usr/bin/env bash
# test_adr023_e6b_testdb_gate.sh — ADR-023 E6b 门禁测试（TDD 红阶段，**新编写**）
#
# 目标契约（判据 R3）：
#   scripts/testdb-init.sh 存在、可执行；在一次性隔离库上跑两次均 exit 0（幂等，第二次不报错）；
#   打印 export 行；按其 export 行设环境变量后，写测试可跑。
#
# 安全：脚本**只允许**指向 `eestock*_test` / `*_iso` 形态的一次性库名；显式拒绝 `eestock` 活库；
#       活库 eestock 零写、不重启/不杀在线 app。
set -uo pipefail

cd "$(dirname "$0")/../.."
INIT="scripts/testdb-init.sh"
DBNAME="${EESTOCK_TEST_DB_NAME:-adr023_e6b_gate_iso}"
PASS=0; FAIL=0
ok()   { echo "  ok   $*"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $*"; FAIL=$((FAIL+1)); }
note() { echo "  ---- $*"; }

echo "== R3: $INIT 存在 / 可执行 / 幂等 / export 行 =="

if [[ ! -e "$INIT" ]]; then
  bad "R3-1 $INIT 不存在（红：缺幂等初始化入口）"
  echo "VERDICT: RED (R3-1)  PASS=$PASS FAIL=$FAIL"
  exit 1
fi
ok "R3-1 $INIT 存在"

if [[ ! -x "$INIT" ]]; then bad "R3-2 $INIT 不可执行"; else ok "R3-2 $INIT 可执行"; fi

if [[ "$DBNAME" == "eestock" ]]; then
  bad "harness 自检：拒绝在活库上运行（DBNAME=$DBNAME）"; exit 2
fi

run_once() { # $1 = label
  local out rc
  out=$(EESTOCK_TEST_DB_NAME="$DBNAME" bash "$INIT" 2>&1); rc=$?
  echo "$out" >"/tmp/adr023_e6b_init_run_$1.log"
  note "run[$1] exit=$rc"
  printf '%s\n' "$out" | sed -n '1,12p' | sed 's/^/       /'
  return $rc
}

run_once 1 && ok "R3-3 首次运行 exit 0" || bad "R3-3 首次运行非 0（见 /tmp/adr023_e6b_init_run_1.log）"

if run_once 2; then ok "R3-4 二次运行 exit 0（幂等）"; else bad "R3-4 二次运行非 0（非幂等，见 /tmp/adr023_e6b_init_run_2.log）"; fi

EXPORT_LINE=$(grep -h -m1 '^export EESTOCK_TEST_DATABASE_URL=' /tmp/adr023_e6b_init_run_1.log || true)
if [[ -n "$EXPORT_LINE" ]]; then
  ok "R3-5 打印 export 行：$EXPORT_LINE"
  # 按其 export 行设置环境变量后，跑一个**只写自有夹具**的 storage 写测试
  eval "$EXPORT_LINE"
  if [[ "${EESTOCK_TEST_DATABASE_URL:-}" == *"/eestock" ]]; then
    bad "harness 自检：export 行指向活库，拒绝执行"; exit 2
  fi
  if DATABASE_URL="$EESTOCK_TEST_DATABASE_URL" EESTOCK_TEST_DATABASE_URL="$EESTOCK_TEST_DATABASE_URL" \
       cargo test -p storage --test raw_writer >/tmp/adr023_e6b_init_smoke.log 2>&1; then
    ok "R3-6 按 export 行设置后写测试通过（raw_writer）"
  else
    bad "R3-6 按 export 行设置后写测试失败（见 /tmp/adr023_e6b_init_smoke.log）"
  fi
  # 哨兵表存在性（R2 的实物面）
  if command -v psql >/dev/null && PGPASSWORD=eestock psql "$EESTOCK_TEST_DATABASE_URL" -Atc \
       "select value from _eestock_test_db" 2>/dev/null | grep -q '^test$'; then
    ok "R3-7 哨兵表 _eestock_test_db 值 = test"
  else
    bad "R3-7 哨兵表缺失或值非 test"
  fi
else
  bad "R3-5 未打印 \`export EESTOCK_TEST_DATABASE_URL=...\` 行（无法一键导出）"
fi

echo "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]] && { echo "VERDICT: GREEN"; exit 0; } || { echo "VERDICT: RED"; exit 1; }
