#!/usr/bin/env bash
# ADR-024 P2 独立验收 ②：`indicator_heavy` 规模矩阵（改造后）。
# 与 tester/evidence/241_adr024_scale_curve/run_scale.sh 同 harness 入口、同 n 矩阵、同重复数，
# 唯一差别 = 插件换成 tester 冻结的 indicator_heavy.js（macd + rsi(14) + atr(14) 每 bar 各一次）。
# 用法：bash run_scale_post_heavy.sh > 02b_scale_post_heavy_raw.txt
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
bin="$repo/target/release/adr024_harness"
bars="$repo/tester/evidence/241_adr024_scale_curve/data/m1_200k.jsonl"
bars290="$repo/tester/evidence/241_adr024_scale_curve/data/m1_290k.jsonl"
heavy="$repo/tester/evidence/242_adr024_baseline_extension/fixtures/indicator_heavy.js"
TIMEOUT=600

echo "# ===== ADR-024 P2 独立验收：indicator_heavy 规模矩阵（改造后）====="
echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# engine_commit : $(git -C "$repo" rev-parse HEAD)"
echo "# binary        : $bin"
echo "# binary_sha256 : $(sha256sum "$bin" | cut -d' ' -f1)"
echo "# plugin_file   : $heavy (sha256=$(sha256sum "$heavy" | cut -d' ' -f1))"
echo "# data          : $bars ($(wc -l < "$bars") bars) sha256=$(sha256sum "$bars" | cut -d' ' -f1)"
echo "# data290       : $bars290 ($(wc -l < "$bars290") bars) sha256=$(sha256sum "$bars290" | cut -d' ' -f1)"
echo "# cpu           : $(nproc) cores; $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)"
echo "# measurement   : /usr/bin/time -v (外部墙钟/峰值 RSS) + harness 计数分配器 (allocs/bytes)"
echo "# 注：POINT 行的 plugin= 字段由 harness 的 --plugin 默认值给出（不反映 --plugin-file），
#     故本次按 tag 前缀 heavy_ 归组（与分析脚本 analyze_p2.py 一致）。"
echo

run_point() { # <barsfile> <n> <slots> <reps> <tag> [extra...]
  local bf=$1 n=$2 slots=$3 reps=$4 tag=$5; shift 5
  local rep
  for rep in $(seq 1 "$reps"); do
    echo "[CMD] /usr/bin/time -v timeout -k 5 ${TIMEOUT} $bin scale --bars-file $bf --limit $n --slots $slots --repeat 1 --tag $tag $*"
    /usr/bin/time -v timeout -k 5 "$TIMEOUT" "$bin" scale --bars-file "$bf" --limit "$n" \
        --slots "$slots" --repeat 1 --tag "$tag" "$@"
    echo "[EXIT] $?"
    echo
  done
}

echo "### —— 系列 B：indicator_heavy（macd+rsi(14)+atr(14) 每 bar 各一次）——"
for n in 1000 5000 20000 50000 200000; do
  for s in 1 3; do
    run_point "$bars" "$n" "$s" 3 "heavy_n${n}_s${s}" --plugin-file "$heavy"
  done
done

echo "### —— 附加段：93 天 (15,000 bar) / M1 5 年 (290,000 bar) ——"
for s in 1 3; do
  run_point "$bars" 15000 "$s" 3 "heavy_extra_93d_n15000_s${s}" --plugin-file "$heavy"
done
for s in 1 3; do
  run_point "$bars290" 290000 "$s" 3 "heavy_extra_5y_n290000_s${s}" --plugin-file "$heavy"
done
echo "### —— 结束 ——"
