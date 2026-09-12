#!/usr/bin/env bash
# check-tangle.sh — 文学式一致性门禁（ADR-007 单向工作流 + ADR-018 门禁硬化）
#
# 语义：design/ 是事实源，src/migrations/web 生成物由 entangled 单向生成（改码必改文档）。
#
# 判据（ADR-018 D-F3-1，架构师 2026-09-12 修正版）：
#   ① ② 冲突/未托管：`entangled tangle -s`（dry-run，**永不写盘**；在沙箱内以空 DB 跑）
#        输出含 `not managed by Entangled`（= 磁盘生成物 ≠ 文档重新生成结果）/
#        `conflicts found` / `ERROR` / `changed outside the control of Entangled`
#        （后两者在本沙箱配置下基本不会出现，保留为防御性匹配）→ 硬失败
#   ④ 漂移（**权威判据**）：把 watch_list 输入 + 目标文件副本拷进**临时沙箱**，
#        在沙箱内（空 filedb）`entangled tangle -f` 无条件重新生成，再与真实仓库逐字节比对；
#        任一生成物缺失/内容不一致 → 硬失败并列出漂移文件
#
# 关键性质（ADR-018 §2 决议 + 架构师裁决）：
#   - **门禁不修改真实工作区**（pre-commit 场景下静默回退生成物是不可接受的失败模式）：
#     全部 tangle 都在沙箱里跑，`--force` 只允许出现在隔离副本中（D-F3-6）。
#   - **可复现且无假阳性**（D-F3-2）：判据不依赖 `.entangled/`（filedb 未版本化、回写后即过期）：
#     干净副本（CI 新克隆）、本地仓库（DB 新/旧）结果一致，权威判据是
#     "文档重新生成的字节 vs 仓库字节"。
#   - 旧实现（`entangled tangle && git diff --quiet`）在"有 DB + 只手改生成物"时假绿：
#     DB 记的是"上次写入内容 digest"，文档侧未变则 entangled 直接判定 unchanged，
#     根本不看磁盘上的生成物（entangled 2.4 io/filedb.py:check）。
#
# 用法：
#   手动：  ./scripts/check-tangle.sh
#   hook：  见 README「工程基建」（symlink 到 .git/hooks/pre-commit）
#   回写：  改码后运行 ./scripts/stitch.sh（沙箱 scoped stitch 回写文档）
set -euo pipefail
shopt -s globstar

cd "$(git rev-parse --show-toplevel)"
ROOT=$PWD

# shellcheck source=scripts/lib/entangled_patterns.sh
# 注意：本脚本会被 symlink 到 .git/hooks/pre-commit 运行（ADR-007 安装方式），
# 因此必须解析**真实路径**（readlink -f）后才能找到 scripts/lib/。
_self="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1 && readlink -f "$_self" >/dev/null 2>&1; then
    _self=$(readlink -f "$_self")
fi
SELF_DIR=$(cd "$(dirname "$_self")" && pwd)
if [ ! -f "$SELF_DIR/lib/entangled_patterns.sh" ]; then
    echo "[check-tangle] ❌ 缺少 scripts/lib/entangled_patterns.sh（门禁依赖，无法继续）。" >&2
    exit 1
fi
# shellcheck source=scripts/lib/entangled_patterns.sh
source "$SELF_DIR/lib/entangled_patterns.sh"

die() {
    echo "[check-tangle] ❌ $1" >&2
    shift || true
    [ "$#" -gt 0 ] && printf '%s\n' "$@" >&2
    cat >&2 <<'EOF'

可操作下一步（二选一，勿用 --force 变绿）：
  • 改动在 design/ 文档侧（文档已改、生成物未重新生成）→ 运行： entangled tangle
  • 改动在代码侧（手改了生成物、文档未同步）        → 运行： ./scripts/stitch.sh
    （scripts/stitch.sh = 沙箱 scoped 回写 + round-trip 校验；校验不通过拒绝回写）
禁止：`entangled tangle --force` —— 它会用文档旧内容覆盖实现，等于回退已验收成果
（ADR-018 D-F3-6）；分不清方向时，先看下面列出的文件属于哪一侧。
EOF
    exit 1
}

# ------------------------------------------------------------ 0) 依赖检查 ----
if ! command -v entangled >/dev/null 2>&1; then
    cat >&2 <<'EOF'
[check-tangle] ❌ 未找到 `entangled` 命令，无法执行 tangle 一致性检查。

本项目采用文学式编程（design/ → 生成物单向 tangle），跳过检查会破坏事实源纪律，
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

# --------------------------------------------------- 1) 解析 watch_list ----
if [ ! -f entangled.toml ]; then
    die "未找到 entangled.toml（无法确定 design/ 事实源范围）。"
fi

patterns=()
while IFS= read -r p; do
    [ -n "$p" ] && patterns+=("$p")
done < <(sed -n 's/^[[:space:]]*watch_list[[:space:]]*=[[:space:]]*\[\(.*\)\].*/\1/p' entangled.toml |
    tr ',' '\n' | tr -d '"' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')

if [ "${#patterns[@]}" -eq 0 ]; then
    die "entangled.toml 的 watch_list 为空或无法解析（门禁无法确定事实源范围）。"
fi

# 每个 pattern 的根目录（pattern 首个 '*' 之前的部分），用于建沙箱
roots=()
for p in "${patterns[@]}"; do
    case "$p" in
        /*|*..*)
            die "watch_list 模式 \`$p\` 含绝对路径或 \`..\`，门禁拒绝沙箱化。" ;;
    esac
    r="${p%%\**}"
    r="${r%/}"
    if [ -z "$r" ] || [ "$r" = "." ]; then
        die "watch_list 模式 \`$p\` 的根为仓库根，门禁无法沙箱化（请把事实源收进子目录）。"
    fi
    roots+=("$r")
done

# ------------------------------------------------------------ 2) 建沙箱 ----
SBX=$(mktemp -d "${TMPDIR:-/tmp}/check-tangle.XXXXXX")
trap 'rm -rf "$SBX"' EXIT

cp -a entangled.toml "$SBX/entangled.toml"
for r in "${roots[@]}"; do
    [ -e "$ROOT/$r" ] || die "watch_list 根 \`$r\` 在仓库中不存在。"
    mkdir -p "$SBX/$(dirname "$r")"
    cp -a "$ROOT/$r" "$SBX/$r"
done
# 沙箱**不**拷 `.entangled`（filedb）——故意：
#   • filedb 记的是"上次写入内容 digest"，回写/重生成后它就是过期的；带着它跑 dry-run 会产生
#     假冲突（`changed outside the control of Entangled`），把"内容其实一致、只是本地缓存旧"
#     的仓库误判为失败（实测：`scripts/stitch.sh` 回写文档后即会踩到）。
#   • 空 DB 下 dry-run 的 `not managed by Entangled` = 磁盘生成物与文档重新生成结果不一致，
#     正好就是漂移语义；且与本地状态无关 → CI/新克隆行为一致（D-F3-2）。

# 目标文件副本：沙箱内 dry-run 的冲突检测需要"磁盘上的生成物"与仓库一致
while IFS= read -r tgt; do
    [ -n "$tgt" ] || continue
    case "$tgt" in
        /*|*..*) continue ;;
    esac
    [ -f "$ROOT/$tgt" ] || continue
    mkdir -p "$SBX/$(dirname "$tgt")"
    cp -a "$ROOT/$tgt" "$SBX/$tgt"
done < <(for r in "${roots[@]}"; do grep -rhoE 'file=[^ }"]+' "$ROOT/$r" 2>/dev/null || true; done |
    sed 's/^file=//' | sort -u)

# ------------------------------------------------- 3) ①② dry-run 冲突/未托管 ----
# 注意：rich 日志会按终端宽度**折行**（例：`WARNING \`long/path\` not managed by\n Entangled`），
# 因此先把换行拉平再匹配，命中后再按日志级别重新分行用于展示。
dry_out=$(cd "$SBX" && entangled tangle -s 2>&1 | tr '\n' ' ' | tr -s ' ' || true)
dry_hits=$(printf '%s\n' "$dry_out" |
    sed -E 's/ (WARNING|ERROR) /\n\1 /g' |
    grep -E 'conflicts found|ERROR|not managed by Entangled|changed outside the control of Entangled' || true)
if [ -n "$dry_hits" ]; then
    die "entangled dry-run 报告冲突/未托管（生成物与 design/ 文档失同步）：" \
        "$dry_hits"
fi

# --------------------------------------------- 4) ④ 沙箱重新生成（权威判据）----
# 必须清掉沙箱里的 filedb：DB 记的是"上次写入内容 digest"，带着它跑 tangle 会重复
# `-s` 的判定（文档侧未变 → unchanged → 不重新生成），从而漏掉"只手改生成物"的漂移。
# 空 DB + `-f` = 对每个目标无条件重新生成（force 只出现在这个隔离沙箱内，见 D-F3-6）。
rm -rf "$SBX/.entangled"
regen_out=$(cd "$SBX" && entangled tangle -f 2>&1 | tr '\n' ' ' | tr -s ' ' || true)
if printf '%s\n' "$regen_out" | grep -qE 'ERROR|Traceback'; then
    die "沙箱内重新生成失败，无法验证一致性（design/ 文档本身可能有循环引用等缺陷）：" \
        "$(printf '%s\n' "$regen_out" | sed -E 's/ (WARNING|ERROR) /\n\1 /g' | grep -E 'ERROR|Error|error|Traceback' | head -5)"
fi

# ------------------------------------------------------- 5) 逐字节比对 ----
drift=(); missing=()
while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in .entangled/*) continue ;; esac
    skip=0
    for p in "${patterns[@]}"; do
        if path_matches "$rel" "$p"; then
            skip=1
            break
        fi
    done
    [ "$skip" -eq 1 ] && continue
    if [ ! -f "$ROOT/$rel" ]; then
        missing+=("$rel")
    elif ! cmp -s "$SBX/$rel" "$ROOT/$rel"; then
        drift+=("$rel")
    fi
done < <(cd "$SBX" && find . -type f | sed 's|^\./||' | sort)

if [ "${#drift[@]}" -gt 0 ] || [ "${#missing[@]}" -gt 0 ]; then
    detail=()
    [ "${#drift[@]}" -gt 0 ] && detail+=("生成物与 design/ 文档不一致（沙箱重新生成对比）：" "$(printf '  - %s\n' "${drift[@]}")")
    [ "${#missing[@]}" -gt 0 ] && detail+=("design/ 文档声明但仓库中缺失的生成物：" "$(printf '  - %s\n' "${missing[@]}")")
    die "${#drift[@]} 个漂移 + ${#missing[@]} 个缺失。" "${detail[@]}"
fi

echo "[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。"
