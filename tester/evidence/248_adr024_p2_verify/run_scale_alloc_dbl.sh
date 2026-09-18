#!/usr/bin/env bash
# ADR-024 P2 独立验收 ②（补测）：alloc_bytes 线性判据需要**精确 n 翻倍**点。
# 矩阵点 (1000/5000/20000/50000/200000) 不含 2× 关系 ⇒ 单列一组 n ∈ {12500,25000,50000,100000,200000}。
# 覆盖 2 个插件 × 2 种 slot 数 × 3 次重复。
# 用法：bash run_scale_alloc_dbl.sh > 02c_scale_post_alloc_dbl.txt
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
bin="$repo/target/release/adr024_harness"
bars="$repo/tester/evidence/241_adr024_scale_curve/data/m1_200k.jsonl"
heavy="$repo/tester/evidence/242_adr024_baseline_extension/fixtures/indicator_heavy.js"
TIMEOUT=600

echo "# ===== ADR-024 P2 独立验收：alloc_bytes 线性判据（精确 n 翻倍点）====="
echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# engine_commit : $(git -C "$repo" rev-parse HEAD)"
echo "# binary_sha256 : $(sha256sum "$bin" | cut -d' ' -f1)"
echo "# data          : $bars sha256=$(sha256sum "$bars" | cut -d' ' -f1)"
echo "# heavy         : sha256=$(sha256sum "$heavy" | cut -d' ' -f1)"
echo

run_point() { # <n> <slots> <tag> [extra...]
  local n=$1 slots=$2 tag=$3; shift 3
  local rep
  for rep in 1 2 3; do
    echo "[CMD] /usr/bin/time -v timeout -k 5 ${TIMEOUT} $bin scale --bars-file $bars --limit $n --slots $slots --repeat 1 --tag $tag $*"
    /usr/bin/time -v timeout -k 5 "$TIMEOUT" "$bin" scale --bars-file "$bars" --limit "$n" \
        --slots "$slots" --repeat 1 --tag "$tag" "$@"
    echo "[EXIT] $?"
    echo
  done
}

for n in 12500 25000 50000 100000 200000; do
  for s in 1 3; do
    run_point "$n" "$s" "alloc_dbl_dual_n${n}_s${s}"
    run_point "$n" "$s" "alloc_dbl_heavy_n${n}_s${s}" --plugin-file "$heavy"
  done
done
echo "### —— 结束 ——"
