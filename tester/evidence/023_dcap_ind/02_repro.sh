#!/usr/bin/env bash
# 车道 A（dcap 指标本身验证）—— 完整复现脚本。
# 纪律：隔离 worktree（不写主树代码/文档/生成物）、独立 target、只读数据、不起服务、不写生产数据面。
#
# 前置：
#   · 主仓 HEAD = 3f5425c（dcap P0–P2 已入库）
#   · 日线数据快照 = /home/eestock/workspace/git/eestock/coder/ladder_strategy/report/sweep/data_cache/*.csv
#   · 15m 数据 = 生产库 kline_accurate_15m（**只读 SELECT**，见 §数据快照）
set -euo pipefail
WT=/tmp/dcap_ind_wt                 # git worktree add --detach $WT 3f5425c
BIN=/tmp/dcap_ind_target/release/examples/dcap_ind_probe
DATA=/tmp/dcap_ind_data
OUT=/tmp/dcap_ind_out
export CARGO_TARGET_DIR=/tmp/dcap_ind_target

mkdir -p "$DATA" "$OUT"/run1 "$OUT"/run2 "$OUT"/py
cp /home/eestock/workspace/git/eestock/coder/ladder_strategy/report/sweep/data_cache/*.csv "$DATA"/

# ── 1) 15m 数据落盘（只读）────────────────────────────────────────────────
if [ ! -f "$DATA/m15_510050.csv" ]; then
  for c in 510050 510880 512800 512480 513050 518880 159985; do
    (echo "ts,close"; PGOPTIONS="-c extra_float_digits=3" psql \
      "postgres://eestock:eestock@127.0.0.1:5433/eestock" -At -F, -c \
      "select to_char(ts,'YYYY-MM-DD HH24:MI:SS'), close::text from kline_accurate_15m where code='$c' order by ts") \
      > "$DATA/m15_$c.csv"
  done
fi

# ── 2) harness 编译 + 自检（T1 位级守卫 / 归一化 / 数据不足边界 / 确定性）──
cp crates/strategy-runtime/examples/dcap_ind_probe.rs "$WT/crates/strategy-runtime/examples/" 2>/dev/null || true
( cd "$WT" && cargo build --release -p strategy-runtime --example dcap_ind_probe )
"$BIN" --selftest | tee "$OUT/selftest.txt"

# ── 3) 取数（全部经 rquickjs 求值产物 dcap.js；method=front|roll，见 harness 头注）──
#    3a) 日线主网格（front：computeDcapSeries s 线）+ 双跑
for r in run1 run2; do for e in 510050 510880 512800 512480 513050 518880 159985; do
  "$BIN" --bars "$DATA/$e.csv" --etf "$e" --freq d1 --out "$OUT/$r" --method front
done; done
#    3b) r=1 的 n′ ∈ [2,250] 全扫（front@run1 + roll@run2，兼作跨方法位级一致性证据）
for e in 510050 510880 512800 512480 513050 518880 159985; do
  "$BIN" --bars "$DATA/$e.csv" --etf "$e" --freq d1ns --out "$OUT/run1" --grid nsweep --method front
  "$BIN" --bars "$DATA/$e.csv" --etf "$e" --freq d1ns --out "$OUT/run2" --grid nsweep --method roll
done
#    3c) 近 1 的细网格（r ∈ 0.90/0.95/1.02/1.05/1.10）
for r in run1 run2; do for e in 510050 510880 512800 512480 513050 518880 159985; do
  "$BIN" --bars "$DATA/$e.csv" --etf "$e" --freq d1fine --out "$OUT/$r" --grid fine --method roll
done; done
#    3d) 15m 主网格 + 细网格 + n′ 全扫（roll；长序列避免 O(T²) 前缀拷贝）
for r in run1 run2; do for e in 510050 510880 512800 512480 513050 518880 159985; do
  "$BIN" --bars "$DATA/m15_$e.csv" --etf "$e" --freq m15 --out "$OUT/$r" --method roll
  "$BIN" --bars "$DATA/m15_$e.csv" --etf "$e" --freq m15fine --out "$OUT/$r" --grid fine --method roll
done; done
for e in 510050 510880 512800 512480 513050 518880 159985; do
  "$BIN" --bars "$DATA/m15_$e.csv" --etf "$e" --freq m15ns --out "$OUT/run1" --grid nsweep --method roll
done
#    3e) 跨方法位级一致性（front vs roll，日线全 63 配置 × 7 ETF）
for e in 510050 510880 512800 512480 513050 518880 159985; do
  "$BIN" --bars "$DATA/$e.csv" --etf "$e" --out "$OUT/run1" --crosscheck
done

# ── 4) 分析与自审 ─────────────────────────────────────────────────────────
cd "$OUT/py"
/usr/bin/python3.12 verify_determinism.py            | tee "$OUT/determinism.txt"
/usr/bin/python3.12 sec1_stats.py d1  ; /usr/bin/python3.12 sec1_stats.py m15
/usr/bin/python3.12 sec2_redundancy.py d1 ; /usr/bin/python3.12 sec2_redundancy.py m15
/usr/bin/python3.12 sec3_ic.py d1 m15
/usr/bin/python3.12 sec4_incremental.py
/usr/bin/python3.12 sec4b_dcap_vs_baseline.py
/usr/bin/python3.12 sec5_stability.py d1 m15
/usr/bin/python3.12 11_audit_report.py               | tee "$OUT/audit_report.txt"
echo "[repro] done"
