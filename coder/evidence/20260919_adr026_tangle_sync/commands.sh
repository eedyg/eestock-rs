#!/usr/bin/env bash
# ADR-026 tangle 同步（design ← 已验收实现）—— 复现命令清单
# 证据目录：coder/evidence/20260919_adr026_tangle_sync/
# 报告：coder/evidence/20260919_adr026_tangle_sync/README.md
#
# 硬纪律（本批遵守）：不改 crates/** 与 web/** 代码；禁 git add/commit/checkout/stash/reset；
#                     禁 entangled tangle --force；只改 design/07-app-plane/{00-web-api,01-mcp}.md。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
EV=coder/evidence/20260919_adr026_tangle_sync
mkdir -p "$EV/raw"

# ---------------------------------------------------------- 0) 备份事实源 ----
cp design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md /tmp/
sha256sum design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md \
    > "$EV/raw/00_pre_docs_sha256.txt"

# ------------------------------------------- 1) 基线：4 个生成物的暂存区字节 ----
for f in crates/web/src/lib.rs crates/mcp/src/rpc.rs crates/mcp/src/tools.rs \
         crates/mcp/tests/mcp_protocol.rs; do
    echo "== $f"
    echo -n "  staged(:)  "; git show ":$f" | sha256sum
    echo -n "  worktree   "; sha256sum < "$f"
    cp "$f" "/tmp/$(echo "$f" | tr '/' '_').baseline"     # 回滚用的字节基线
done > "$EV/raw/01_baseline_sha256.txt"

# ------------------------------------------------- 2) 本批代码 diff（事实输入）----
git diff HEAD -- crates/mcp/src/rpc.rs              > "$EV/raw/02_diff_rpc.txt"
git diff HEAD -- crates/mcp/src/tools.rs            > "$EV/raw/03_diff_tools.txt"
git diff HEAD -- crates/mcp/tests/mcp_protocol.rs crates/web/src/lib.rs \
    > "$EV/raw/04_diff_tests_weblib.txt"

# --------------------------------------------- 3) 映射语义：块内容 vs 生成物 ----
# 结论：generated file == begin 标记行 + 块内容(逐字节) + end 标记行
#       => 块内容 == 生成物 lines[1:-2]
diff <(sed -n '256,380p' design/07-app-plane/01-mcp.md) /dev/null || true
diff /tmp/blocks/crates_mcp_src_tools.rs.block crates/mcp/src/tools.rs \
    > "$EV/raw/05_diff_block_vs_file_tools.txt" || true

# --------------------------------------------------------- 4) 基线失败复现 ----
entangled tangle -s                                > "$EV/raw/06_dryrun_baseline_repo.txt" 2>&1 || true
./scripts/check-tangle.sh                          > "$EV/raw/07_gate_baseline_fail.txt" 2>&1 || true  # exit 1

# ------------------------------------------- 5) 全生成物快照（防误写代码）----
grep -rhoE 'file=[^ }"]+' design/ | sed 's/^file=//' | sort -u > /tmp/all_targets.txt
: > "$EV/raw/08_all_targets_sha256_pre_tangle.txt"
while IFS= read -r t; do
    [ -f "$t" ] || continue
    sha256sum "$t" >> "$EV/raw/08_all_targets_sha256_pre_tangle.txt"
done < /tmp/all_targets.txt
git status --porcelain | grep -v '^A '          > "$EV/raw/09_git_status_before.txt"

# ---------------------------------------- 6) 改文档（最小 hunk；仅块内新增）----
# /tmp/sync_docs.py 用 difflib 对 "块内容 vs 生成物 lines[1:-2]" 求最小 hunk，
# 只把新增/替换行写进文档的对应块；文档其余字节不动。幂等。
python3 /tmp/sync_docs.py . --apply                 > "$EV/raw/10_doc_edits.txt" 2>&1
sha256sum design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md \
    > "$EV/raw/11_post_docs_sha256.txt"

# ---------------------------------------- 7) 重新 tangle（仓库根，非 --force）----
entangled tangle                                   > "$EV/raw/12_entangled_tangle_repo.txt" 2>&1 || true
# 断言：4 个生成物逐字节 == 基线（若不符 -> cp /tmp 备份回滚 + BLOCKED）
for f in crates/web/src/lib.rs crates/mcp/src/rpc.rs crates/mcp/src/tools.rs \
         crates/mcp/tests/mcp_protocol.rs; do
    cmp "/tmp/$(echo "$f" | tr '/' '_').baseline" "$f"
done
# 断言：全部 148 个生成物零变化
while IFS= read -r t; do
    [ -f "$t" ] || continue
    sha256sum -c <(grep "  $t\$" "$EV/raw/08_all_targets_sha256_pre_tangle.txt") \
        || echo "CHANGED $t"
done < /tmp/all_targets.txt

# ------------------------------------------------------------ 8) 门禁复验 ----
./scripts/check-tangle.sh                          > "$EV/raw/13_gate_after_fix.txt" 2>&1   # 必须 exit 0 / ✅
entangled tangle                                   > "$EV/raw/14_entangled_tangle_repo_2nd.txt" 2>&1 || true
./scripts/check-tangle.sh                          > "$EV/raw/15_gate_rerun.txt" 2>&1       # 二次确认 ✅

# ---------------------------------------------- 9) 幂等证明（空 filedb 沙箱）----
# 与门禁同法：拷 design/ + 全部既有生成物，无 .entangled，跑非 --force entangled tangle 两次。
# run1: 148/148 目标逐字节等于仓库；run2: Nothing to be done（236/236 零变化）。
# 见 raw/24_sandbox_idempotence.txt

# ------------------------------------------------------------ 10) 范围核查 ----
git status --porcelain                             > "$EV/raw/16_git_status_after.txt"
git status --porcelain | grep -v '^A ' | sort      > /tmp/after_filtered.txt
cp "$EV/raw/09_git_status_before.txt" /tmp/before_filtered.txt
sort -o /tmp/before_filtered.txt /tmp/before_filtered.txt
diff /tmp/before_filtered.txt /tmp/after_filtered.txt > "$EV/raw/17_status_delta.txt" || true
git diff -- design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md \
    > "$EV/raw/18_doc_diff.patch"
git diff --stat -- design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md \
    > "$EV/raw/19_doc_diff_stat.txt"
git diff --unified=0 -- design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md \
    | grep -E '^\+\+\+|^@@'                        > "$EV/raw/20_doc_diff_hunks.txt"
git diff HEAD --stat -- crates/web/src/lib.rs crates/mcp/src/rpc.rs \
    crates/mcp/src/tools.rs crates/mcp/tests/mcp_protocol.rs > "$EV/raw/21_code_diff_stat.txt"
