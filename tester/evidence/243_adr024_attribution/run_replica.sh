#!/usr/bin/env bash
# ADR-024 P1b ④：生产路径副本（测试库；绝不写生产库）。
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
bin="$repo/target/release/adr024_replica"
bars="$repo/tester/evidence/241_adr024_scale_curve/data/m1_200k.jsonl"
heavy="$repo/tester/evidence/242_adr024_baseline_extension/fixtures/indicator_heavy.js"
export EESTOCK_TEST_DATABASE_URL="${EESTOCK_TEST_DATABASE_URL:-postgres://eestock:eestock@127.0.0.1:5433/eestock_test}"
echo "# ===== ADR-024 P1b ④ 生产路径副本耗时分解 ====="
echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# engine_commit : $(git -C "$repo" rev-parse HEAD)"
echo "# binary_sha256 : $(sha256sum "$bin" | cut -d' ' -f1)"
echo "# db_url        : $EESTOCK_TEST_DATABASE_URL （测试库；run_id 前缀 sr_adr024p1b_）"
echo "# cpu           : $(nproc) cores; $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)"
echo "# mem           : $(free -m | awk '/^Mem:/{print $2" MB total, "$7" MB available"}')"
echo
run() { echo "[CMD] $bin $*"; "$bin" "$@"; echo "[EXIT] $?"; echo; }
echo "### —— A: 逐项开关（n=3250 ≈ 现网 M5 run 规模；dual_ma；slots=1）——"
for st in engine observer jsonb_value jsonb_text jsonb_db progress_db full; do
  run --bars-file "$bars" --limit 3250 --slots 1 --stage "$st" --tag rep3250-dual_ma-$st
done
echo "### —— B: 生产端规模 n=1402（≈现网 M15 run 规模）full 与 engine 对照 ——"
run --bars-file "$bars" --limit 1402 --slots 1 --stage engine --tag rep1402-dual_ma-engine
run --bars-file "$bars" --limit 1402 --slots 1 --stage full   --tag rep1402-dual_ma-full
echo "### —— C: 更重插件（指标重插件）full 与 engine 对照（n=3250 / 20000）——"
run --bars-file "$bars" --limit 3250  --slots 1 --stage engine --tag rep3250-heavy-engine --plugin-file "$heavy"
run --bars-file "$bars" --limit 3250  --slots 1 --stage full   --tag rep3250-heavy-full   --plugin-file "$heavy"
run --bars-file "$bars" --limit 20000 --slots 1 --stage engine --tag rep20000-heavy-engine --plugin-file "$heavy"
run --bars-file "$bars" --limit 20000 --slots 1 --stage full   --tag rep20000-heavy-full   --plugin-file "$heavy"
echo "### —— 结束；测试库专用行清理 SQL ——"
echo "# DELETE FROM strategy_run WHERE id LIKE 'sr_adr024p1b_%';  -- strategy_run_result 级联删除"
