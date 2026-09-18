#!/usr/bin/env bash
# ADR-024 P1b ③：**指标重插件**规模曲线（改造前基线；用于量化「指标二次项系数」）。
# 用法：bash run_heavy.sh            # 全矩阵（写 raw_heavy_plugin.txt）
#       bash run_heavy.sh env        # 只打印环境元数据
# 纪律：单点单次 > TIMEOUT ⇒ timeout 终止，该点记 timeout（如实报告，不外推）。
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
bin="$repo/target/release/adr024_harness"
bars="$repo/tester/evidence/241_adr024_scale_curve/data/m1_200k.jsonl"
plugin="$root/fixtures/indicator_heavy.js"
TIMEOUT=900

env_meta() {
  echo "# ===== ADR-024 P1b ③：指标重插件曲线（run_heavy.sh） ====="
  echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# engine_commit : $(git -C "$repo" rev-parse HEAD)"
  echo "# binary        : $bin"
  echo "# binary_sha256 : $(sha256sum "$bin" | cut -d' ' -f1)"
  echo "# plugin        : $plugin (sha256=$(sha256sum "$plugin" | cut -d' ' -f1))"
  echo "# plugin_calls  : ctx.indicators.macd() + rsi(14) + atr(14) 每 bar 各一次（host 侧均从 bar 0 重算）"
  echo "# data          : $bars ($(wc -l < "$bars") bars, $(du -h "$bars" | cut -f1))"
  echo "# data_sha256   : $(sha256sum "$bars" | cut -d' ' -f1)"
  echo "# cpu           : $(nproc) cores; $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)"
  echo "# mem           : $(free -m | awk '/^Mem:/{print $2" MB total, "$7" MB available"}')"
  echo "# timeout       : per single run ${TIMEOUT}s (timeout -k 5)"
  echo "# measurement   : /usr/bin/time -v（外部墙钟/CPU/峰值 RSS）+ harness 内部墙钟 + 计数分配器"
  echo
}

run_point() { # <bars> <slots> <reps> <tag>
  local n=$1 slots=$2 reps=$3 tag=$4
  local rep
  for rep in $(seq 1 "$reps"); do
    echo "[CMD] /usr/bin/time -v timeout -k 5 ${TIMEOUT} $bin scale --bars-file $bars --limit $n --slots $slots --repeat 1 --tag $tag --plugin-file $plugin"
    /usr/bin/time -v timeout -k 5 "$TIMEOUT" "$bin" scale --bars-file "$bars" --limit "$n" \
        --slots "$slots" --repeat 1 --tag "$tag" --plugin-file "$plugin" --engine-commit "$(git -C "$repo" rev-parse HEAD)"
    echo "[EXIT] $?"
    echo
  done
}

if [ "${1:-}" = "env" ]; then env_meta; exit 0; fi
env_meta

echo "### —— 系列 C：指标重插件（macd+rsi+atr 每 bar 各一次）× slots=1 ——"
for n in 5000 20000 50000 200000; do
  run_point "$n" 1 3 "heavy_n${n}_s1"
done

echo "### —— 系列 D：指标重插件 × slots=3（量化 slots 线性放大；200k 只跑 1 次以控总时长）——"
for n in 20000 50000; do
  run_point "$n" 3 3 "heavy_n${n}_s3"
done
run_point 200000 3 1 "heavy_n200000_s3"

echo "### —— 结束（P2/P3 后复跑入口：同一脚本，输出另存 raw_heavy_plugin_post.txt）——"
