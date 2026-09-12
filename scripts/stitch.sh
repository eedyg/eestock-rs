#!/usr/bin/env bash
# stitch.sh — 改码后把实现回写进 design/ 文档（ADR-007 单向工作流 · ADR-018 D-F3-4/D-F3-6）
#
# O1 纪律（ADR-018 §3.1）——每类改动只走一条路，两条都不能省：
#   • 改 design/ 文档（事实源）        → entangled tangle        （文档 → 生成物）
#   • 改代码（生成物，如 web/src/*.tsx）→ ./scripts/stitch.sh     （代码 → 文档 回写）
#   提交前用 ./scripts/check-tangle.sh 复验（pre-commit hook 同款判据）。
#
# HAZARD（实测，勿踩）：
#   • **禁止在仓库根直接跑全局 `entangled stitch`**：design/07-app-plane/{00-web-api,01-mcp}.md
#     的代码块内嵌 `// ~/~ begin` 遗留标记，全局 stitch 会把它们改写成自引用
#     （`<<crates/mcp/src/tools.rs>>`，-3583 行），随后 `entangled tangle` 直接死于
#     `ERROR Cyclic reference`。本脚本只在**临时沙箱**里把 watch_list scope 到候选文档，
#     绝不对仓库做全局 stitch。
#   • **禁止 `entangled tangle --force` 让门禁变绿**：它会用文档旧内容覆盖实现 = 回退成果
#     （ADR-018 D-F3-6）。`--force` 只在本脚本的隔离沙箱内使用（取证/回写需要的唯一位置）。
#   • 块内嵌 `~/~ begin` 的文档（当前仅上述两份）会被自动跳过并告警：它们属文档卫生遗留
#     （F3-f 后续项），stitch 会破坏其内容。
#
# 用法：
#   ./scripts/stitch.sh                    # 默认 scoped：只回写「检测到漂移」的生成物所属文档
#   ./scripts/stitch.sh <code-file> [...]  # 显式 scoped：回写声明了这些生成物的文档
#   ./scripts/stitch.sh --all              # 所有含代码块的文档（仍作沙箱 scope + 校验）
#   ./scripts/stitch.sh --help
#
# 流程（每一步都不碰仓库，直到校验通过）：
#   ① 选候选文档（默认=漂移文件所属文档）→ 跳过"块内嵌标记"文档
#   ② 沙箱 A：scope 到候选文档，`entangled stitch -f` 折叠实现
#   ③ 沙箱 B（全新）：用回写后的文档做 round-trip 校验（清空 DB → `tangle -f` →
#      所有生成物必须与仓库逐字节一致）；**校验不通过则拒绝回写**
#   ④ 仅把内容确有变化的文档拷回仓库，打印 diff 摘要与下一步；生成物一律不动
set -euo pipefail
shopt -s globstar

cd "$(git rev-parse --show-toplevel)"
ROOT=$PWD

# shellcheck source=scripts/lib/entangled_patterns.sh
_self="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1 && readlink -f "$_self" >/dev/null 2>&1; then
    _self=$(readlink -f "$_self")
fi
SELF_DIR=$(cd "$(dirname "$_self")" && pwd)
if [ ! -f "$SELF_DIR/lib/entangled_patterns.sh" ]; then
    echo "[stitch] ❌ 缺少 scripts/lib/entangled_patterns.sh（依赖文件）。" >&2
    exit 1
fi
source "$SELF_DIR/lib/entangled_patterns.sh"

usage() {
    cat <<'EOF'
stitch.sh — 改码后把实现回写进 design/ 文档（沙箱 scoped + round-trip 校验）

用法：
  ./scripts/stitch.sh                    默认 scoped：只回写「检测到漂移」的生成物所属文档
  ./scripts/stitch.sh <code-file> [...]  显式 scoped：回写声明了这些生成物的文档
  ./scripts/stitch.sh --all              所有含代码块的文档
  ./scripts/stitch.sh --help

O1 纪律（ADR-018 §3.1）——改完代码**必须**回写文档：
  • 改 design/ 文档（事实源）          → entangled tangle       （文档 → 生成物）
  • 改代码（生成物，如 web/src/*.tsx） → ./scripts/stitch.sh    （代码 → 文档）
  提交前：./scripts/check-tangle.sh 复验（pre-commit hook 同款判据）。

禁止（HAZARD，实测）：
  • 禁止在仓库根跑全局 `entangled stitch`：会把 design/07-app-plane/{00-web-api,01-mcp}.md
    的代码块改写成自引用（-3583 行），随后 tangle 死于 Cyclic reference。
    本脚本只在临时沙箱里 scope 到候选文档。
  • 禁止 `entangled tangle --force` 变绿：会用文档旧内容覆盖实现（回退成果，D-F3-6）；
    --force 只在沙箱内使用（隔离副本）。
EOF
}

info() { echo "[stitch] $*"; }
die() {
    echo "[stitch] ❌ $1" >&2
    shift || true
    [ "$#" -gt 0 ] && printf '%s\n' "$@" >&2
    exit 1
}

# ---------------------------------------------------------------- 参数解析 ----
want_all=0
args=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --all) want_all=1 ;;
        -*) die "未知参数：$1（见 --help）" ;;
        *) args+=("$1") ;;
    esac
    shift
done

if ! command -v entangled >/dev/null 2>&1; then
    die "未找到 entangled（pipx install entangled-cli）。"
fi
[ -f entangled.toml ] || die "未找到 entangled.toml。"

# ------------------------------------------------- watch_list / 输入集解析 ----
patterns=()
while IFS= read -r p; do
    [ -n "$p" ] && patterns+=("$p")
done < <(sed -n 's/^[[:space:]]*watch_list[[:space:]]*=[[:space:]]*\[\(.*\)\].*/\1/p' entangled.toml |
    tr ',' '\n' | tr -d '"' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')
[ "${#patterns[@]}" -gt 0 ] || die "entangled.toml 的 watch_list 为空或无法解析。"

roots=()
for p in "${patterns[@]}"; do
    case "$p" in /* | *..*) die "watch_list 模式 \`$p\` 含绝对路径或 \`..\`，拒绝处理。" ;; esac
    r="${p%%\**}"
    r="${r%/}"
    [ -n "$r" ] && [ "$r" != "." ] || die "watch_list 模式 \`$p\` 的根为仓库根，无法沙箱化。"
    roots+=("$r")
done

input_files() { # 所有 watch_list 命中的输入文件（仓库相对路径）
    local f p
    while IFS= read -r f; do
        for p in "${patterns[@]}"; do
            if path_matches "$f" "$p"; then echo "$f"; break; fi
        done
    done < <(for r in "${roots[@]}"; do find "$r" -type f 2>/dev/null; done | sort -u)
}

targets_of() { # $1=文档 → 该文档声明的生成物路径
    grep -oE 'file=[^ }"]+' "$1" 2>/dev/null | sed 's/^file=//' | sort -u || true
}

is_input_doc() { # $1=路径 → 是否命中 watch_list（即设计文档）
    local x="$1" p
    for p in "${patterns[@]}"; do path_matches "$x" "$p" && return 0; done
    return 1
}

docs_declaring() { # $1=生成物路径 → 声明它的文档（仓库相对路径）
    local tgt="$1"
    while IFS= read -r d; do
        grep -qE "file=${tgt}[ }]" "$d" 2>/dev/null && echo "$d"
    done < <(input_files)
}

copy_inputs_into() { # $1=沙箱目录
    local sbx="$1" r
    cp -a entangled.toml "$sbx/entangled.toml"
    for r in "${roots[@]}"; do
        [ -e "$ROOT/$r" ] || die "watch_list 根 \`$r\` 不存在。"
        mkdir -p "$sbx/$(dirname "$r")"
        cp -a "$ROOT/$r" "$sbx/$r"
    done
}

copy_targets_into() { # $1=沙箱目录 $2...=生成物路径
    local sbx="$1"
    shift
    local tgt
    for tgt in "$@"; do
        [ -n "$tgt" ] || continue
        case "$tgt" in /* | *..*) continue ;; esac
        [ -f "$ROOT/$tgt" ] || continue
        mkdir -p "$sbx/$(dirname "$tgt")"
        cp -a "$ROOT/$tgt" "$sbx/$tgt"
    done
}

new_sandbox() {
    local d
    d=$(mktemp -d "${TMPDIR:-/tmp}/stitch.XXXXXX")
    echo "$d"
}

SBX_A=""; SBX_B=""
cleanup() {
    [ -n "$SBX_A" ] && rm -rf "$SBX_A"
    [ -n "$SBX_B" ] && rm -rf "$SBX_B"
    return 0
}
trap cleanup EXIT

# ---------------------------------------------------------- ① 选候选文档 ----
declare -a cands=()
in_cands() {
    local x="$1" c
    for c in "${cands[@]}"; do [ "$c" = "$x" ] && return 0; done
    return 1
}

if [ "${#args[@]}" -gt 0 ]; then
    for a in "${args[@]}"; do
        a="${a#./}"
        if [ -f "$a" ] && is_input_doc "$a"; then
            in_cands "$a" || cands+=("$a") # 直接给了文档路径
        else
            [ -f "$a" ] || die "参数 \`$a\` 既不是设计文档也不是已存在的生成物文件。"
            while IFS= read -r d; do in_cands "$d" || cands+=("$d"); done < <(docs_declaring "$a")
        fi
    done
    [ "${#cands[@]}" -gt 0 ] || die "没有文档声明这些生成物（无法回写）；确认路径，或先跑 entangled tangle。"
    info "显式 scoped：候选文档 ${cands[*]}"
elif [ "$want_all" -eq 1 ]; then
    info "⚠️  --all：全局 `entangled stitch` 已证实是破坏性操作（见 --help HAZARD）；"
    info "   本脚本仍只在沙箱内 scope 到候选文档执行，并跳过块内嵌标记的文档。"
    while IFS= read -r d; do
        [ -n "$(targets_of "$d")" ] && cands+=("$d")
    done < <(input_files)
else
    info "⚠️  无参数默认 scoped 回写（不做全局 stitch —— 全局 stitch 已证破坏性，见 --help HAZARD）。"
    info "   正在用沙箱重新生成比对检测漂移 ..."
    SBX_B=$(new_sandbox)
    copy_inputs_into "$SBX_B"
    declare -a all_tgts=()
    while IFS= read -r d; do
        while IFS= read -r t; do all_tgts+=("$t"); done < <(targets_of "$d")
    done < <(input_files)
    copy_targets_into "$SBX_B" "${all_tgts[@]:-}"
    (cd "$SBX_B" && entangled tangle -f >/dev/null 2>&1) || die "沙箱重新生成失败（无法检测漂移）。"
    drifted=()
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        case "$rel" in .entangled/*) continue ;; esac
        skip=0
        for p in "${patterns[@]}"; do path_matches "$rel" "$p" && { skip=1; break; }; done
        [ "$skip" -eq 1 ] && continue
        [ -f "$ROOT/$rel" ] || { info "⚠️  文档声明的生成物在仓库中缺失：$rel（先跑 entangled tangle）"; continue; }
        cmp -s "$SBX_B/$rel" "$ROOT/$rel" || drifted+=("$rel")
    done < <(cd "$SBX_B" && find . -type f | sed 's|^\./||' | sort)
    rm -rf "$SBX_B"; SBX_B=""
    if [ "${#drifted[@]}" -eq 0 ]; then
        info "✅ 未检测到漂移：文档与生成物一致，无需回写。"
        exit 0
    fi
    info "检测到 ${#drifted[@]} 个漂移生成物：${drifted[*]}"
    for t in "${drifted[@]}"; do
        while IFS= read -r d; do in_cands "$d" || cands+=("$d"); done < <(docs_declaring "$t")
    done
    [ "${#cands[@]}" -gt 0 ] || die "漂移文件没有对应文档（无块可回写）；若属于文档侧改动请跑 entangled tangle。"
fi

# --------------------------------------------- ② 跳过"块内嵌标记"遗留文档 ----
# 这些文档的代码块里嵌着 `// ~/~ begin` 标记（历史 stitch 遗留），stitch 会把块改写成
# 自引用 → 破坏内容并使 tangle 死于循环引用（F3-f 后续项）。此处硬跳过（不改它们）。
declare -a skipped=() kept=()
for d in "${cands[@]}"; do
    if grep -q '~/~ begin' "$d"; then skipped+=("$d"); else kept+=("$d"); fi
done
cands=("${kept[@]}")
if [ "${#skipped[@]}" -gt 0 ]; then
    info "⚠️  跳过块内嵌 \`~/~ begin\` 遗留标记的文档（stitch 会破坏其内容，见 F3-f）：${skipped[*]}"
fi
[ "${#cands[@]}" -gt 0 ] || die "候选文档全部被跳过（遗留标记）；请人工同步（见 ADR-018 F3-f）。"

# ------------------------------------------------------- ③ 沙箱 A：scoped stitch ----
SBX_A=$(new_sandbox)
copy_inputs_into "$SBX_A"
declare -a a_tgts=()
for d in "${cands[@]}"; do
    while IFS= read -r t; do a_tgts+=("$t"); done < <(targets_of "$d")
done
copy_targets_into "$SBX_A" "${a_tgts[@]:-}"

restricted=""
for d in "${cands[@]}"; do restricted+="\"$d\", "; done
restricted="${restricted%, }"
if ! grep -q '^[[:space:]]*watch_list' "$SBX_A/entangled.toml"; then
    die "无法在沙箱内改写 watch_list（配置格式不支持）。"
fi
sed -i "s|^[[:space:]]*watch_list[[:space:]]*=.*$|watch_list = [${restricted}]|" "$SBX_A/entangled.toml"

stitch_out=$(cd "$SBX_A" && entangled stitch -f 2>&1 || true)
if printf '%s\n' "$stitch_out" | grep -qE 'ERROR|Traceback'; then
    die "沙箱内 stitch 失败：" "$(printf '%s\n' "$stitch_out" | grep -E 'ERROR|Error|error|Traceback' | head -5)"
fi

# --------------------------------------------------- ④ 沙箱 B：round-trip 校验 ----
info "round-trip 校验中（全新沙箱：回写后的文档能否重新生成出仓库中的生成物）..."
SBX_B=$(new_sandbox)
copy_inputs_into "$SBX_B"
for d in "${cands[@]}"; do cp -a "$SBX_A/$d" "$SBX_B/$d"; done
declare -a all_tgts=()
while IFS= read -r d; do
    while IFS= read -r t; do all_tgts+=("$t"); done < <(targets_of "$d")
done < <(input_files)
copy_targets_into "$SBX_B" "${all_tgts[@]:-}"
rm -rf "$SBX_B/.entangled" # 空 DB + -f = 对所有目标无条件重新生成（DB 无关）
regen_out=$(cd "$SBX_B" && entangled tangle -f 2>&1 || true)
if printf '%s\n' "$regen_out" | grep -qE 'ERROR|Traceback'; then
    die "round-trip 校验失败：沙箱重新生成报错，回写会使 tangle 失稳；**已拒绝回写**。" \
        "$(printf '%s\n' "$regen_out" | grep -E 'ERROR|Error|error|Traceback' | head -5)"
fi
bad=()
while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in .entangled/*) continue ;; esac
    skip=0
    for p in "${patterns[@]}"; do path_matches "$rel" "$p" && { skip=1; break; }; done
    [ "$skip" -eq 1 ] && continue
    if [ ! -f "$ROOT/$rel" ]; then bad+=("缺失: $rel"); elif ! cmp -s "$SBX_B/$rel" "$ROOT/$rel"; then bad+=("不一致: $rel"); fi
done < <(cd "$SBX_B" && find . -type f | sed 's|^\./||' | sort)
if [ "${#bad[@]}" -gt 0 ]; then
    die "round-trip 校验失败：回写后的文档无法重新生成出仓库中的生成物；**已拒绝回写**（仓库未被修改）。" \
        "$(printf '  - %s\n' "${bad[@]:0:10}")" \
        "下一步：若属于文档侧改动 → 运行 entangled tangle；若是文档块与生成物本就不同步 → 先人工对齐（见 ADR-018 F3-f）。"
fi

# --------------------------------------------------------------- ⑤ 回写文档 ----
declare -a changed=()
for d in "${cands[@]}"; do
    cmp -s "$SBX_A/$d" "$ROOT/$d" || changed+=("$d")
done
if [ "${#changed[@]}" -eq 0 ]; then
    info "✅ 文档已与实现一致，无需回写（校验通过）。"
    exit 0
fi

for d in "${changed[@]}"; do cp -a "$SBX_A/$d" "$ROOT/$d"; done

info "✅ 已回写 ${#changed[@]} 份文档（沙箱 stitch + round-trip 校验通过）："
printf '  - %s\n' "${changed[@]}"
git --no-pager diff --stat -- "${changed[@]}" | sed 's/^/  /'
info "实现侧生成物一个字节都没动（零回退）。"
info "下一步：./scripts/check-tangle.sh 复验 → git add → 提交（改动含文档 + 生成物两侧）。"
