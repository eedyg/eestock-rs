#!/usr/bin/env bash
# ADR-024 P1 规模曲线**附加点（超出任务矩阵，用于回答「93 天 / M1 5 年 对应曲线上哪个位置」）**：
#   15,000 bar ≈ M1 × 93 天（现护栏上限，ADR §2.2 口径）；290,000 bar ≈ M1 × 5 年（ADR §2.2 口径）。
# 输出追加到 raw_pre.txt（同一「改造前基线」批次的补充段）。
set -uo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$root/../../.." && pwd)"
bin="$repo/target/release/adr024_harness"
bars="$root/data/m1_200k.jsonl"
bars290="$root/data/m1_290k.jsonl"
TIMEOUT=600

echo
echo "# ===== 附加段（矩阵外）：93 天 / M1 5 年 等效 bar 数（run_scale_extra.sh） ====="
echo "# date_utc      : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# engine_commit : $(git -C "$repo" rev-parse HEAD)"
echo "# data(290k)    : $bars290 ($(wc -l < "$bars290") bars, $(du -h "$bars290" | cut -f1)) sha256=$(sha256sum "$bars290" | cut -d' ' -f1)"
echo "# 注：290k 与 200k 均为同一标的后缀（嵌套前缀关系：200k = 290k 的末 200k）"
echo

for n in 15000; do
  for s in 1 3; do
    for rep in 1 2 3; do
      echo "[CMD] /usr/bin/time -v timeout -k 5 ${TIMEOUT} $bin scale --bars-file $bars --limit $n --slots $s --repeat 1 --tag extra_93d_n${n}_s${s}"
      /usr/bin/time -v timeout -k 5 "$TIMEOUT" "$bin" scale --bars-file "$bars" --limit "$n" --slots "$s" --repeat 1 --tag "extra_93d_n${n}_s${s}"
      echo "[EXIT] $?"
      echo
    done
  done
done

for s in 1 3; do
  for rep in 1 2 3; do
    echo "[CMD] /usr/bin/time -v timeout -k 5 ${TIMEOUT} $bin scale --bars-file $bars290 --limit 290000 --slots $s --repeat 1 --tag extra_5y_n290000_s${s}"
    /usr/bin/time -v timeout -k 5 "$TIMEOUT" "$bin" scale --bars-file "$bars290" --limit 290000 --slots "$s" --repeat 1 --tag "extra_5y_n290000_s${s}"
    echo "[EXIT] $?"
    echo
  done
done
echo "### —— 附加段结束 ——"
