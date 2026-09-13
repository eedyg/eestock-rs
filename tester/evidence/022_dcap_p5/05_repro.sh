#!/usr/bin/env bash
# P5 dcap 有效性验证 —— 完整复现脚本（不写主树、不起服务、不碰生产数据面写操作）
#
# 前置：/home/eestock/workspace/git/eestock/coder/ladder_strategy/report/sweep/data_cache/*.csv
#       （既有 7 ETF 日线数据快照，sha256 见 03_hashes_determinism.txt）
set -euo pipefail
WT=/tmp/dcap_p5_wt                     # 隔离 worktree（git worktree add --detach $WT 3f5425c）
DATA=/tmp/dcap_p5_data                 # 数据快照副本（只读）
OUT=/tmp/dcap_p5_out                   # 输出
export CARGO_TARGET_DIR=/tmp/dcap_p5_target    # 独立 target（与 P3 增量编译隔离）

mkdir -p "$DATA" "$OUT"
cp /home/eestock/workspace/git/eestock/coder/ladder_strategy/report/sweep/data_cache/*.csv "$DATA"/

CH=$(sha256sum "$WT/crates/strategy-core/reference-plugins/dcap.js" | cut -d' ' -f1)  # 60bc9b4…

cd "$WT"
# 0) harness 自检（数据装载/IS-OOS 切分/dcap 逆势语义/买入持有/参数归一化）
cargo run --release --example dcap_sweep -- --selftest
# 1) 主网格（9 组合 = r∈{1.00,1.05,1.20} × m∈{1,3,5}，n=(8,26,60)、smooth=1、th=0.01）双跑
cargo run --release --example dcap_sweep -- --data-dir "$DATA" --out "$OUT/grid_all_run1.csv" --code-hash "$CH"
cargo run --release --example dcap_sweep -- --data-dir "$DATA" --out "$OUT/grid_all_run2.csv" --code-hash "$CH"
diff -q "$OUT/grid_all_run1.csv" "$OUT/grid_all_run2.csv"      # 必须无差异（bitwise）
# 2) 扩展网格（27 组合 = 主网格 + r∈{0.90,0.95,1.02} + 5 组三线差异化 r）双跑
cargo run --release --example dcap_sweep -- --data-dir "$DATA" --out "$OUT/grid_ext_run1.csv" --code-hash "$CH" --grid extended
cargo run --release --example dcap_sweep -- --data-dir "$DATA" --out "$OUT/grid_ext_run2.csv" --code-hash "$CH" --grid extended
diff -q "$OUT/grid_ext_run1.csv" "$OUT/grid_ext_run2.csv"
# 3) 敏感性：OOS 无预热（warmup=0 对照行）
cargo run --release --example dcap_sweep -- --data-dir "$DATA" --out "$OUT/grid_all_nowarmup.csv" --code-hash "$CH" --warmup-mode with_sensitivity
cargo run --release --example dcap_sweep -- --data-dir "$DATA" --out "$OUT/grid_ext_nowarmup.csv" --code-hash "$CH" --grid extended --warmup-mode with_sensitivity
# 4) 分析（IS 中位数冻结 Top-3 → OOS 一次性裁决；全地貌；配对符号检验 + bootstrap CI）
python3 "$OUT/analyze.py" "$OUT/grid_all_run1.csv" --primary  > "$OUT/analysis_primary.txt"
python3 "$OUT/analyze.py" "$OUT/grid_ext_run1.csv"             > "$OUT/analysis_extended.txt"
python3 "$OUT/analyze.py" "$OUT/grid_all_nowarmup.csv" --primary > "$OUT/analysis_primary_nowarmup.txt"
python3 "$OUT/gen_tables.py" > "$OUT/report_tables.md"
# 5) 门禁（P5 未运行任何 tangle；此步只在干净 worktree 上确认基线绿）
"$WT/scripts/check-tangle.sh"
echo "[repro] done"
