#!/usr/bin/env bash
# 独立核验 ADR-026 批 tangle 同步 —— 可复现命令清单（tester，只读/只验不改）
# 报告：tester/evidence/20260919_adr026_tangle_verify/README.md
# 原始输出：同目录 raw/
# 环境：Entangled 2.4.3 / git 2.43.0 / HEAD=e807385449a303a1090ac00a52c722b7b77e62ec
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
R=$PWD
O=$R/tester/evidence/20260919_adr026_tangle_verify/raw

# ---------------------------------------------------------------- 1) 门禁自跑
./scripts/check-tangle.sh; echo "EXIT=$?"                    # -> raw/01

# ------------------------------------------- 2) 4 个生成物字节三方全等
rm -rf /tmp/tv_staged /tmp/tv_frozen && mkdir -p /tmp/tv_staged /tmp/tv_frozen
for f in crates/web/src/lib.rs crates/mcp/src/rpc.rs crates/mcp/src/tools.rs \
         crates/mcp/tests/mcp_protocol.rs; do
  mkdir -p "/tmp/tv_staged/$(dirname "$f")"; git show ":$f" > "/tmp/tv_staged/$f"
done
tar xzf coder/backups/adr026_frozen_20260919T112937Z.tar.gz -C /tmp/tv_frozen   # 只解压到 /tmp
for f in crates/web/src/lib.rs crates/mcp/src/rpc.rs crates/mcp/src/tools.rs \
         crates/mcp/tests/mcp_protocol.rs; do
  sha256sum "$f" "/tmp/tv_staged/$f" "/tmp/tv_frozen/$f"
  cmp -s "$f" "/tmp/tv_staged/$f" && echo "cmp OK vs index   $f"
  cmp -s "$f" "/tmp/tv_frozen/$f"  && echo "cmp OK vs frozen  $f"
done                                                          # -> raw/02

# -------------------------------- 3) worktree 差分试验（证明判据有区分度）
rm -rf /tmp/tv_wt && git worktree add --detach /tmp/tv_wt HEAD
cp design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md /tmp/tv_wt/design/07-app-plane/
( cd /tmp/tv_wt && ./scripts/check-tangle.sh ); echo "EXIT=$?"          # 期望 ❌ -> raw/03
for f in crates/web/src/lib.rs crates/mcp/src/rpc.rs crates/mcp/src/tools.rs \
         crates/mcp/tests/mcp_protocol.rs; do cp "$f" "/tmp/tv_wt/$f"; done
( cd /tmp/tv_wt && ./scripts/check-tangle.sh ); echo "EXIT=$?"          # 期望 ✅ -> raw/04
git show HEAD:design/07-app-plane/00-web-api.md > /tmp/tv_wt/design/07-app-plane/00-web-api.md
git show HEAD:design/07-app-plane/01-mcp.md     > /tmp/tv_wt/design/07-app-plane/01-mcp.md
( cd /tmp/tv_wt && ./scripts/check-tangle.sh ); echo "EXIT=$?"          # 反向对照 ❌ -> raw/05
for f in crates/web/src/lib.rs crates/mcp/src/rpc.rs crates/mcp/src/tools.rs \
         crates/mcp/tests/mcp_protocol.rs; do git show "HEAD:$f" > "/tmp/tv_wt/$f"; done
( cd /tmp/tv_wt && ./scripts/check-tangle.sh ); echo "EXIT=$?"          # HEAD 基线 ✅ -> raw/05
git worktree remove /tmp/tv_wt

# ------------------------------- 4) 幂等与副作用（仓库根 + 空 filedb 沙箱）
grep -rhoE 'file=[^ }"]+' design | sed 's/^file=//' | sort -u > /tmp/tv_targets_all.txt   # 156 raw
# （148 个真实存在 = 生成物全集）
entangled tangle; echo "EXIT=$?"     # 第 1 次（仓库根：因 .entangled/filedb.json 过期 break off）
entangled tangle; echo "EXIT=$?"     # 第 2 次：零改动 + git status/git diff --stat 不变 -> raw/07
rm -rf /tmp/tv_sbx && mkdir -p /tmp/tv_sbx && cp -a entangled.toml design /tmp/tv_sbx/
while read -r t; do case "$t" in /*|*..*|*'<'*) continue;; esac;
  [ -f "$t" ] && { mkdir -p "/tmp/tv_sbx/$(dirname "$t")"; cp -a "$t" "/tmp/tv_sbx/$t"; }; done < /tmp/tv_targets_all.txt
( cd /tmp/tv_sbx && entangled tangle ); echo "EXIT=$?"   # 空 filedb 第 1 次：生成 148/148 -> raw/08
( cd /tmp/tv_sbx && entangled tangle ); echo "EXIT=$?"   # 第 2 次：Nothing to be done，零改动

# ------------------------------------------------------------- 5) 越界审计
git diff --stat; git diff --name-status
git status --porcelain | grep -E '^( M|\?\?| D|MM|AM|DM|MD)' | grep -E '(crates|web)/'   # 期望空
ls -la --time-style=full-iso .git/index .git/ORIG_HEAD; git reflog -3; git stash list
while read -r h p; do [ -z "$p" ] && continue
  c=$(sha256sum "$p" | cut -d' ' -f1); [ "$c" = "$h" ] && echo "OK $p" || echo "DIFF $p"; done \
  < coder/backups/adr026_frozen_manifest_20260919T112937Z.txt                            # -> raw/09

# --------------------------------------------------- 6) 文档内容正确性抽查
# 块内容 vs 生成物正文（剥 begin/end 标记行）逐字节比对 4/4 相同
python3 - <<'PY'
import re,hashlib,pathlib
T={"crates/web/src/lib.rs","crates/mcp/src/rpc.rs","crates/mcp/src/tools.rs","crates/mcp/tests/mcp_protocol.rs"}
for d in ("design/07-app-plane/00-web-api.md","design/07-app-plane/01-mcp.md"):
    L=pathlib.Path(d).read_text().split("\n"); i=0
    while i<len(L):
        m=re.match(r'^```\s*\{\.(\S+)\s+file=([^ }\}]+)\s*\}',L[i])
        if m:
            j=i+1; b=[]
            while j<len(L) and not L[j].startswith("```"): b.append(L[j]); j+=1
            if m.group(2) in T:
                f=pathlib.Path(m.group(2)).read_text().split("\n")[1:-2]
                print(d,i+1,m.group(2),"IDENTICAL=",f==b,
                      hashlib.sha256(("\n".join(b)+"\n").encode()).hexdigest()[:12])
            i=j+1
        else: i+=1
PY
grep -n 'runs/{id}/audit' crates/web/src/lib.rs design/07-app-plane/00-web-api.md
grep -n 'pub async fn get_audit\|svc.run_audit' crates/web/src/workbench.rs
grep -n 'pub async fn run_audit' crates/application/src/workbench.rs
grep -n '"bt_get_run_audit"' crates/mcp/src/tools.rs crates/mcp/src/rpc.rs crates/mcp/tests/mcp_protocol.rs
grep -n 'PARTIAL_DEPLOYMENT_THRESHOLD\|WARN_PARTIAL_DEPLOYMENT\|WARN_DCA_PLAN_UNDERFILLED\|WARN_ORDERS_UNEXECUTED' \
  crates/application/src/audit.rs
grep -rn '34 个工具\|8 个 bt_' design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md   # 期望无 -> raw/11

# ------------------------------------------------------------ 7) 终态复核
./scripts/check-tangle.sh; echo "EXIT=$?"; sha256sum design/07-app-plane/00-web-api.md design/07-app-plane/01-mcp.md
git worktree list; git diff --stat; git reflog -1                                            # -> raw/12
