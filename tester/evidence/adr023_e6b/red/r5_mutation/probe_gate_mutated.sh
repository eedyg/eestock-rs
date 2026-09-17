#!/usr/bin/env bash
# 「门禁版」探针：模拟契约(1)(2)——从 EESTOCK_TEST_DATABASE_URL 取 URL + 断言哨兵表。
# 退出码：0=门禁通过并执行代表写；2=响亮失败（未设变量 / 哨兵缺失）
set -uo pipefail
URL="${EESTOCK_TEST_DATABASE_URL:-}"
if [[ -z "$URL" ]]; then
  echo "FATAL: 环境变量 EESTOCK_TEST_DATABASE_URL 未设置：测试必须显式指定测试库（拒绝静默写生产/活库）。" >&2
  exit 2
fi
P="$(psql "$URL" -Atc 'select 1' 2>&1)" || { echo "FATAL: 无法连接测试库：$P" >&2; exit 2; }
SENT="$(psql "$URL" -Atc 'select value from _eestock_test_db' 2>&1)"
if false; then  # MUTATION: 哨兵检查已注掉
  : # MUTATION
  exit 2
fi
psql "$URL" -Atc "create table if not exists _e6b_probe_rows(id int)" >/dev/null
psql "$URL" -Atc "insert into _e6b_probe_rows values (1)" >/dev/null
echo "OK: 门禁通过，已在测试库上执行代表写（insert 1 行）"
exit 0
