#!/usr/bin/env bash
# ADR-024 P1 规模曲线（**改造前基线**，HEAD=O(n²) 状态）：原始命令 + 完整输出。
# 用法：bash run_scale.sh            # 全矩阵（写入 raw_pre.txt）
#       bash run_scale.sh env        # 只打印环境元数据
# 纪律：单点单次 > 600s ⇒ timeout 终止，该点记 timeout（判据见 fit.md）。
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
bin="$repo/target/release/adr024_harness"
bars="$root/data/m1_200k.jsonl"
ctrl="$repo/crates/strategy-core/tests/fixtures/constant_score.js"
TIMEOUT=600

env_meta() {
  echo "# ===== ADR-024 P1 规模曲线：改造前基线（run_scale.sh） ====="
  echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# engine_commit : $(git -C "$repo" rev-parse HEAD)"
  echo "# binary        : $bin"
  echo "# binary_sha256 : $(sha256sum "$bin" | cut -d' ' -f1)"
  echo "# cargo_locked  : tester/harness/adr024_harness/Cargo.lock"
  echo "# data          : $bars ($(wc -l < "$bars") bars, $(du -h "$bars" | cut -f1))"
  echo "# data_sha256   : $(sha256sum "$bars" | cut -d' ' -f1)"
  echo "# cpu           : $(nproc) cores; $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)"
  echo "# mem           : $(free -m | awk '/^Mem:/{print $2" MB total, "$7" MB available"}')"
  echo "# timeout       : per single run ${TIMEOUT}s (timeout -k 5)"
  echo "# measurement   : /usr/bin/time -v (外部墙钟/CPU/峰值 RSS) + harness 内部墙钟 + 计数分配器 (allocs/bytes)"
  echo
}

run_point() { # <bars> <slots> <reps> <tag> [--params K=V] [--plugin-file F]
  local n=$1 slots=$2 reps=$3 tag=$4; shift 4
  local rep
  for rep in $(seq 1 "$reps"); do
    echo "[CMD] /usr/bin/time -v timeout -k 5 ${TIMEOUT} $bin scale --bars-file $bars --limit $n --slots $slots --repeat 1 --tag $tag $*"
    /usr/bin/time -v timeout -k 5 "$TIMEOUT" "$bin" scale --bars-file "$bars" --limit "$n" \
        --slots "$slots" --repeat 1 --tag "$tag" "$@"
    echo "[EXIT] $?"
    echo
  done
}

if [ "${1:-}" = "env" ]; then env_meta; exit 0; fi

env_meta

echo "### —— 系列 A：真实参考插件 dual_ma(fast=5,slow=20)（生产插件字节）——"
for n in 1000 5000 20000 50000 200000; do
  for s in 1 3; do
    run_point "$n" "$s" 3 "dual_ma_n${n}_s${s}"
  done
done

echo "### —— 系列 B：隔离探针 constant_score（无指标调用；把成本归因到「每 bar 上下文构造 + 历史复制」）——"
for n in 20000 200000; do
  run_point "$n" 1 3 "ctrl_n${n}_s1" --plugin-file "$ctrl" --params score=42
done

echo "### —— 结束：改造后（P2）复跑入口为同一脚本 + raw_post.txt（见 fit.md §复跑入口）——"
