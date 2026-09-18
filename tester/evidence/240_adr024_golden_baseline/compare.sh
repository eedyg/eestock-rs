#!/usr/bin/env bash
# ADR-024 P1：golden 基线比对器入口（A/B/C 三层）。
# 用法：
#   bash compare.sh                      # 全 13 用例比对（重跑引擎 vs expected.json）
# 用例集合 = 基线目录下「含 case.json + expected.json 的子目录」自动枚举（无需登记表）
# ⇒ 2026-09-18 新增的 m30_1slot / m30_3slots 自动纳入（13 例）。
# 判读纪律：`expected.json.baseline_kind == "post_p2_regression"` 的用例（= M30 两例）
# 只作「相对 P2 后状态未回归」的守卫，**不得**作为跨 P2 等价证据 —— 见 README §1.1。
#   bash compare.sh <case_id>            # 单用例
#   bash compare.sh --selftest <case_id> # 比对器敏感性反向证据（控制组 + 人为扰动）
# 退出码：0=PASS，2=FAIL（比对器判 FAIL 或 selftest 敏感性不足）。
# 注：m30_1slot 的 selftest 判 FAIL 属**该例探针点为空仓**（成因与替代证据见 README §4 注 / §6 第 6–7 条），
#     与「比对器不可信」无关；13 例的 compare 判据为 0 dev / 全 PASS。
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
har="$repo/tester/harness/adr024_harness"
export CARGO_TARGET_DIR="$repo/target"

if [ "${1:-}" = "--selftest" ]; then
  case_id="${2:-m15_1slot}"
  set -- cargo run --offline --release --quiet --manifest-path "$har/Cargo.toml" -- \
      selftest --baseline "$root" --case "$case_id" --out "$root/sensitivity/${case_id}_selftest.txt"
else
  case_id="${1:-}"
  if [ -n "$case_id" ]; then
    set -- cargo run --offline --release --quiet --manifest-path "$har/Cargo.toml" -- \
        compare --baseline "$root" --case "$case_id"
  else
    set -- cargo run --offline --release --quiet --manifest-path "$har/Cargo.toml" -- \
        compare --baseline "$root" --out "$root/compare_report.txt"
  fi
fi
printf '[cmd] %s\n' "$*"
"$@"
code=$?
echo "[exit] $code"
exit $code
