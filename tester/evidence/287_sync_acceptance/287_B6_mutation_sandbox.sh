#!/usr/bin/env bash
# 287 B6 变异反证（沙箱）——可复现脚本（**只在 /tmp 副本里做，绝不碰工作区**）
#
# 目标：把 isSyncCombinationAllowed 恢复成「只认实测表」（变异回旧行为），
#       在副本里跑 syncCoverage.test.ts ⇒ **必须变红**。
#
# 运行：bash 287_B6_mutation_sandbox.sh
set -euo pipefail

REPO=/home/eestock/workspace/git/eestock/eestock-rs
SB=/tmp/287_sandbox
OUT=$REPO/tester/evidence/287_sync_acceptance

echo "== [0] 建沙箱（真实拷贝 node_modules ⇒ 与工作区零共享写入） =="
rm -rf "$SB"; mkdir -p "$SB"
rsync -a --exclude node_modules --exclude dist --exclude 'e2e/artifacts' "$REPO/web/" "$SB/web/"
cp -a "$REPO/web/node_modules" "$SB/web/node_modules"
sha256sum "$SB/web/src/features/dashboard/chartSyncGroup.ts" "$SB/web/src/features/dashboard/syncCoverage.test.ts"

echo "== [1] 基线（未变异）应全绿 =="
( cd "$SB/web" && ./node_modules/.bin/vitest run src/features/dashboard/syncCoverage.test.ts ) \
  > "$SB/B6_baseline_green.txt" 2>&1 || true
grep -E "Test Files|Tests " "$SB/B6_baseline_green.txt"

echo "== [2] 可选：用当前源码在沙箱构建，与线上 bundle 比对（证明线上=当前源码） =="
( cd "$SB/web" && VITE_API_MOCK=0 ./node_modules/.bin/vite build ) > "$SB/B6_build_from_current_source.txt" 2>&1 || true
md5sum "$SB/web/dist/assets/index-"*.js

echo "== [3] 变异：守门恢复旧行为（只认实测表，取消同锚点合成放行） =="
cp "$SB/web/src/features/dashboard/chartSyncGroup.ts" "$SB/chartSyncGroup.ts.orig"
python3 - <<'PY'
p='/tmp/287_sandbox/web/src/features/dashboard/chartSyncGroup.ts'
s=open(p).read()
old = "  if (composeDensity(basePeriod, satellitePeriod) !== null) return null; // 同锚点合成可用（287 口径 A）\n"
assert old in s, 'target line not found'
new = "  // 变异（287 B6 反证）：恢复旧行为 —— 守门只认实测表，取消「同锚点合成」放行。\n"
open(p,'w').write(s.replace(old, new))
print('mutated')
PY
diff -u "$SB/chartSyncGroup.ts.orig" "$SB/web/src/features/dashboard/chartSyncGroup.ts" > "$SB/B6_mutation.diff" || true
cat "$SB/B6_mutation.diff"

echo "== [4] 变异后必须变红 =="
set +e
( cd "$SB/web" && ./node_modules/.bin/vitest run src/features/dashboard/syncCoverage.test.ts ) \
  > "$SB/B6_mutation_red.txt" 2>&1
RC=$?
set -e
echo "exit code = $RC (1 = 红)"
grep -E "Test Files|Tests " "$SB/B6_mutation_red.txt"
grep -E "^\s*(×|✗) " "$SB/B6_mutation_red.txt"

echo "== [5] 归档证据（沙箱路径 $SB） =="
cp "$SB/B6_baseline_green.txt" "$OUT/B6_sandbox_baseline_green.txt"
cp "$SB/B6_mutation.diff" "$OUT/B6_mutation.diff"
cp "$SB/B6_mutation_red.txt" "$OUT/B6_sandbox_mutation_red.txt"
cp "$SB/B6_build_from_current_source.txt" "$OUT/B6_build_from_current_source.txt"
cp "$SB/chartSyncGroup.ts.orig" "$OUT/B6_sandbox_original_chartSyncGroup.ts.txt"
cp "$SB/web/src/features/dashboard/chartSyncGroup.ts" "$OUT/B6_sandbox_mutated_chartSyncGroup.ts.txt"
echo "DONE"
