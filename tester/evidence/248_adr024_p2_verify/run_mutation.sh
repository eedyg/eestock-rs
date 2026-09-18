#!/usr/bin/env bash
# ADR-024 P2 独立验收 ⑧（v2）：测试有效性抽查（人为扰动 ⇒ 必须变红；复原 ⇒ 必须回绿）。
#
# v1 的缺陷（已修）：复原用 `cp -p` 保留了旧 mtime ⇒ cargo 判定 "fresh" 不重编译 ⇒ 复原后仍跑**扰动版**二进制
#   （假红）。v2 改为 `cp` + `touch`，并**显式校验复跑输出含 "Compiling"**（证明真的重编译过）。
#
# 纪律：临时扰动，同块内复原；复原以 sha256 + `git diff`（worktree vs index）双证；不 git add / 不 commit。
set -uo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
bkp="tester/evidence/248_adr024_p2_verify/mutation_backup"
mkdir -p "$bkp"

F_IND="crates/backtest/src/indicators.rs"
F_ENG="crates/strategy-core/src/engine.rs"
F_HIS="crates/strategy-runtime/src/history.rs"

for f in "$F_IND" "$F_ENG" "$F_HIS"; do
  cp "$f" "$bkp/$(basename "$f").orig"
done

echo "# ===== 备份基线 sha256（本脚本开始时）====="
sha256sum "$F_IND" "$F_ENG" "$F_HIS"

restore_all() {
  # 关键：不用 -p，复原后 mtime=now ⇒ cargo 必然重编译
  cp "$bkp/indicators.rs.orig" "$F_IND" && touch "$F_IND"
  cp "$bkp/engine.rs.orig"     "$F_ENG" && touch "$F_ENG"
  cp "$bkp/history.rs.orig"    "$F_HIS" && touch "$F_HIS"
}

run_case() { # <id> <desc> <perturb-cmd> <file> <test-cmd...>
  local id="$1" desc="$2" patch="$3" file="$4"; shift 4
  echo
  echo "======================================================================"
  echo "## $id — $desc"
  echo "   文件: $file"
  echo "   扰动: $patch"
  echo "   判据测试: $*"
  echo "======================================================================"
  restore_all
  eval "$patch"
  touch "$file"
  echo "[扰动后 sha256] $(sha256sum "$file")"
  echo
  echo "\$ $*   （扰动后：期望 RED）"
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  printf '%s\n' "$out" | tail -30
  local ncomp_p; ncomp_p=$(printf '%s' "$out" | grep -c '^\s*Compiling ' || true)
  echo "[扰动后 EXIT=$rc（0=绿 / 非 0=红）]  [重编译=$ncomp_p 个 crate ⇒ $([ "$ncomp_p" -gt 0 ] && echo '跑的是扰动版' || echo '⚠ 未重编译，结果无效')]"
  echo
  restore_all
  echo "[复原后 sha256] $(sha256sum "$file")"
  git diff --name-only -- "$file" | sed 's/^/  worktree!=index: /'
  echo "\$ $*   （复原后：期望 GREEN）"
  out="$("$@" 2>&1)"; rc=$?
  printf '%s\n' "$out" | tail -20
  local ncomp; ncomp=$(printf '%s' "$out" | grep -c '^\s*Compiling ' || true)
  echo "[复原后 EXIT=$rc（0=绿）]  [重编译发生=$ncomp 个 crate ⇒ $([ "$ncomp" -gt 0 ] && echo '证据有效（跑的是复原版）' || echo '⚠ 未重编译，结果无效')]"
}

CARGO="cargo test --offline"

run_case "M1" "OnlineIndicators::RsiState 种子分母 period → period-1（错误递推）" \
  "sed -i 's|self.sum_gain / self.period as f64|self.sum_gain / (self.period as f64 - 1.0)|' $F_IND" \
  "$F_IND" \
  $CARGO -p backtest --lib online_rsi_matches_slice_view -- --nocapture

run_case "M1b" "同上扰动（RSI 递推）：真实 golden fixture 上增量 vs 切片位级等价" \
  "sed -i 's|self.sum_gain / self.period as f64|self.sum_gain / (self.period as f64 - 1.0)|' $F_IND" \
  "$F_IND" \
  $CARGO -p strategy-runtime --test online_indicators_fixture -- --nocapture

run_case "M2" "会话 push_batch 的 observer index 偏移 1（bars_seen-1 → bars_seen）" \
  "sed -i 's|let i = self.bars_seen - 1;|let i = self.bars_seen;|' $F_ENG" \
  "$F_ENG" \
  $CARGO -p strategy-core --test session session_observer_called_per_bar_and_break_is_immediate -- --nocapture

run_case "M3" "会话去掉共享缓冲注入（删除 .with_history(shared.clone())）⇒ 机制退回每 bar 复制" \
  "sed -i 's|\.with_history(shared\.clone())||' $F_ENG" \
  "$F_ENG" \
  $CARGO -p strategy-core --test session_alloc -- --nocapture

run_case "M3b" "同上去掉共享缓冲注入：语义级断言 session_shared_history_exposes_current_bar_to_plugin" \
  "sed -i 's|\.with_history(shared\.clone())||' $F_ENG" \
  "$F_ENG" \
  $CARGO -p strategy-core --test session session_shared_history_exposes_current_bar_to_plugin -- --nocapture

run_case "M4" "会话 warmup 判定 off-by-one（i < w → i + 1 < w）" \
  "sed -i 's|let is_warmup = i < self.cfg.warmup_bars;|let is_warmup = i + 1 < self.cfg.warmup_bars;|' $F_ENG" \
  "$F_ENG" \
  $CARGO -p strategy-core --test session session_warmup_marker_is_exact -- --nocapture

run_case "M5" "BarHistory::ma 窗口错位到前一根（index → index-1）" \
  "sed -i 's|online\.ma(bars, index, period)|online.ma(bars, index.saturating_sub(1), period)|' $F_HIS" \
  "$F_HIS" \
  $CARGO -p strategy-runtime --test shared_history -- --nocapture

run_case "M6" "OnlineIndicators::KdjState 平滑系数 1/k_period → 1/(k_period+1)" \
  "sed -i 's|self.mk \* self.k + (1.0 / self.k_period as f64) \* rsv|self.mk * self.k + (1.0 / (self.k_period as f64 + 1.0)) * rsv|' $F_IND" \
  "$F_IND" \
  $CARGO -p backtest --lib online_kdj_matches_slice_view -- --nocapture

run_case "M7" "OnlineIndicators::AtrState Wilder 递推 (period-1) → period" \
  "sed -i 's|self.atr \* (self.period as f64 - 1.0) + tr|self.atr * self.period as f64 + tr|' $F_IND" \
  "$F_IND" \
  $CARGO -p backtest --lib online_atr_matches_slice_view -- --nocapture

# ---------------------------------------------------------------------------
echo
echo "======================================================================"
echo "## 全部复原后的最终校验"
echo "======================================================================"
restore_all
sha256sum "$F_IND" "$F_ENG" "$F_HIS"
echo "\$ git diff --name-only -- <三个文件>（应为空）"
git diff --name-only -- "$F_IND" "$F_ENG" "$F_HIS"
echo "[最终 worktree-vs-index diff 行数=$(git diff --name-only -- "$F_IND" "$F_ENG" "$F_HIS" | wc -l)（0=逐字节一致）]"
echo
echo "\$ 最终全绿复跑（P2 三 crate 全测试）"
$CARGO -p backtest -p strategy-runtime -p strategy-core --no-fail-fast 2>&1 | grep -E "^test result|^error|Compiling" | tail -30
echo "[最终复跑 EXIT=${PIPESTATUS[0]}]"
