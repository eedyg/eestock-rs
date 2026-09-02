#!/usr/bin/env bash
# check-tangle.sh — 文学式一致性门禁（ADR-007）
# 语义：design/ 是事实源，src/migrations 由 entangled 单向生成。
# 重新 tangle 后若 git 出现 diff，说明生成物与文档脱节，拒绝提交。
#
# 用法：
#   手动：  ./scripts/check-tangle.sh
#   hook：  见 README「工程基建」一节（symlink 到 .git/hooks/pre-commit）
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v entangled >/dev/null 2>&1; then
    cat >&2 <<'EOF'
[check-tangle] ❌ 未找到 `entangled` 命令，无法执行 tangle 一致性检查。

本项目采用文学式编程（design/ → src 单向生成），跳过检查会破坏事实源纪律，
因此这里是硬失败而不是静默放行。请二选一：

  1) 安装 entangled（推荐 pipx）：
       pipx install entangled-cli
     或：
       pip install --user entangled-cli
  2) 确认本次改动与 design/ 无关后，临时绕过（不推荐）：
       git commit --no-verify
EOF
    exit 1
fi

echo "[check-tangle] entangled tangle ..."
entangled tangle

if git diff --quiet; then
    echo "[check-tangle] ✅ tangle 后无 diff，design 与生成物一致。"
else
    cat >&2 <<'EOF'
[check-tangle] ❌ tangle 产生了差异：生成物与 design/ 文档不一致。
请修改 design/ 下对应文档（而不是手改生成代码），再重新提交。
差异摘要：
EOF
    git diff --stat >&2
    exit 1
fi
