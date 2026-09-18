#!/usr/bin/env bash
# ADR-024 P2（引擎线性化）coder 初筛测量脚本：改造**前/后**同参数复跑（非权威；权威曲线由 tester 跑）。
# 用法：bash run_preflight.sh <phase: pre|post>
# 输出：stderr 之外的全部 POINT 行 → coder/evidence/adr024_p2/<phase>_scale.txt
# 口径：与 tester 的 tester/evidence/241_adr024_scale_curve/run_scale.sh 同 harness 入口
#       （tester/harness/adr024_harness --scale），仅把 n 矩阵缩小到 coder 初筛量级。
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
phase="${1:?用法: run_preflight.sh <pre|post>}"
out="$root/${phase}_scale.txt"
export CARGO_TARGET_DIR="$repo/target"
bars="$repo/tester/evidence/241_adr024_scale_curve/data/m1_200k.jsonl"
heavy="$repo/tester/evidence/242_adr024_baseline_extension/fixtures/indicator_heavy.js"
ctrl="$repo/crates/strategy-core/tests/fixtures/constant_score.js"

{
  echo "# ===== ADR-024 P2 coder 初筛（phase=$phase）====="
  echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# engine_commit : $(git -C "$repo" rev-parse HEAD)"
  echo "# git_dirty     : $(git -C "$repo" status --porcelain | wc -l) 项未提交改动"
  echo "# bars          : $bars ($(wc -l < "$bars") bars)"
  echo "# cpu           : $(nproc) cores; $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)"
  echo "# cmd           : cargo run --offline --release -p adr024_harness (path deps = 当前工作树) -- scale ..."
  echo "# 注：POINT 行由 harness 计数分配器给 allocs/alloc_bytes（O(n²) 复制的直接指纹）。"
  echo
  echo "### 系列 1：dual_ma（生产参考插件）1 slot"
  for n in 2000 4000 8000 16000; do
    echo "[CMD] scale --limit $n --slots 1 --repeat 3"
    cargo run --offline --release --quiet --manifest-path "$repo/tester/harness/adr024_harness/Cargo.toml" -- \
      scale --bars-file "$bars" --limit "$n" --slots 1 --repeat 3 --tag "${phase}_dual_ma_n${n}_s1"
    echo "[EXIT] $?"
  done
  echo
  echo "### 系列 2：indicator_heavy（macd+rsi(14)+atr(14) 每 bar 各一次）1 slot"
  for n in 2000 4000 8000 16000; do
    echo "[CMD] scale --limit $n --slots 1 --repeat 3 --plugin-file indicator_heavy.js"
    cargo run --offline --release --quiet --manifest-path "$repo/tester/harness/adr024_harness/Cargo.toml" -- \
      scale --bars-file "$bars" --limit "$n" --slots 1 --repeat 3 --tag "${phase}_heavy_n${n}_s1" --plugin-file "$heavy"
    echo "[EXIT] $?"
  done
  echo
  echo "### 系列 3：slots 放大（8000 bar，3 slots，dual_ma / heavy）"
  cargo run --offline --release --quiet --manifest-path "$repo/tester/harness/adr024_harness/Cargo.toml" -- \
    scale --bars-file "$bars" --limit 8000 --slots 3 --repeat 3 --tag "${phase}_dual_ma_n8000_s3"
  echo "[EXIT] $?"
  cargo run --offline --release --quiet --manifest-path "$repo/tester/harness/adr024_harness/Cargo.toml" -- \
    scale --bars-file "$bars" --limit 8000 --slots 3 --repeat 3 --tag "${phase}_heavy_n8000_s3" --plugin-file "$heavy"
  echo "[EXIT] $?"
  echo
  echo "### 系列 4：隔离探针 constant_score（无指标调用；归因「每 bar 上下文构造 + 历史复制」）8000 bar 1 slot"
  cargo run --offline --release --quiet --manifest-path "$repo/tester/harness/adr024_harness/Cargo.toml" -- \
    scale --bars-file "$bars" --limit 8000 --slots 1 --repeat 3 --tag "${phase}_ctrl_n8000_s1" --plugin-file "$ctrl" --params score=42
  echo "[EXIT] $?"
} > "$out" 2>&1
echo "写入 $out"
