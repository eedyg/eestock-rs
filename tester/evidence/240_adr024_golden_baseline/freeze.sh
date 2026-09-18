#!/usr/bin/env bash
# ADR-024 P1：golden 基线冻结（跑生产引擎 → 落 expected.json）。
# 用法：bash freeze.sh            # 全量冻结（覆盖 expected.json）
#       bash freeze.sh <case_id>  # 只冻结单用例
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
har="$repo/tester/harness/adr024_harness"
export CARGO_TARGET_DIR="$repo/target"
commit="$(git -C "$repo" rev-parse HEAD)"
captured="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# engine_commit=$commit captured_at=$captured"
only="${1:-}"
for d in "$root"/*/; do
  [ -f "${d}case.json" ] || continue
  if [ -n "$only" ] && [ "$(basename "$d")" != "$only" ]; then continue; fi
  case_id="$(basename "$d")"
  # [tester 2026-09-18] M30 两例是 **P2 后基线**（pre-P2 的 M30 不可捕获）⇒ 落 baseline_kind 标注，
  # 使 expected.json 自带「不得作为跨 P2 等价证据」的口径（见 README §1.1）。
  extra=()
  if [ "$case_id" = "m30_1slot" ] || [ "$case_id" = "m30_3slots" ]; then
    extra=(--baseline-kind post_p2_regression \
           --source-state "HEAD=$commit + staged P0(M30)/P2(engine)/P2b(tryrun+simlive)")
  fi
  set -- cargo run --offline --release --quiet --manifest-path "$har/Cargo.toml" -- \
      run --case "$d" --out "${d}expected.json" --engine-commit "$commit" --captured-at "$captured" "${extra[@]}"
  printf '[cmd] %s\n' "$*"
  "$@"
done
