#!/usr/bin/env bash
# test_check_tangle.sh — check-tangle.sh（ADR-018 门禁硬化）fixture 自测
#
# 覆盖 ADR-018 决议：
#   D-F3-1 fail-loud：冲突/未托管/漂移任一即硬失败，且给出两条可操作出路
#   D-F3-2 可复现：干净副本（无 .entangled）与真实仓库（有 .entangled）行为都正确
#   D-F3-5 常驻自测：构造以下状态，断言门禁退出码 + 提示文案
#     ① clean-db        干净 + 有 DB                 → 通过
#     ② clean-no-db     干净 + 无 DB（CI 新克隆一致提交）→ 通过
#     ③ silent-drift    假绿原例：有 DB、只手改生成物（文档未动）→ 失败（旧门禁在此假绿）
#     ④ conflict        有 DB、文档与生成物同时被改（tangle 报 conflicts）→ 失败
#     ⑤ empty-db-drift  无 DB 且有漂移（CI 干净副本场景）→ 失败
#   每个失败态还断言：门禁**不得修改工作区**（生成物逐字节不变）——ADR-018 硬约束。
#
# 用法：bash scripts/tests/test_check_tangle.sh
set -uo pipefail

cd "$(dirname "$0")/../.."
GATE="${GATE_UNDER_TEST:-$PWD/scripts/check-tangle.sh}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

if ! command -v entangled >/dev/null 2>&1; then
    echo "SKIP: 未安装 entangled，无法运行门禁自测（CI 需 pipx install entangled-cli）" >&2
    exit 0
fi

# ---------------------------------------------------------------- fixture ----
# 最小可用 entangled 工程：design/page.md 定义 web/src/layouts/Grid.tsx
make_fixture() {
    local d="$1"
    rm -rf "$d"
    mkdir -p "$d/design" "$d/web/src/layouts"
    cat >"$d/entangled.toml" <<'EOF'
version = "2.0"
watch_list = ["design/**/*.md"]

[[languages]]
name = "TSX"
identifiers = ["tsx", "ts", "typescript"]
comment = { open = "//" }
EOF
    cat >"$d/design/page.md" <<'EOF'
# fixture page

L3 骨架代码块（由 entangled tangle 生成 web/src/layouts/Grid.tsx）：

``` {.tsx file=web/src/layouts/Grid.tsx}
export const A = 1;
```
EOF
    printf '.entangled/\n' >"$d/.gitignore"   # 与真实仓库一致：filedb 不入库
    write_code "$d" 1
    git -C "$d" init -q
    commit_all "$d" init
}

write_code() { # $1=dir $2=A 值（代码侧内容，含 tangle 注释标记）
    cat >"$1/web/src/layouts/Grid.tsx" <<EOF
// ~/~ begin <<design/page.md#web/src/layouts/Grid.tsx>>[init]
export const A = $2;
// ~/~ end
EOF
}

commit_all() { git -C "$1" add -A && git -C "$1" -c user.email=t@t -c user.name=t commit -qm "$2" >/dev/null 2>&1 || true; }

# 真实门禁：在 fixture 内执行（门禁自身 cd 到 git toplevel）
run_gate() { # $1=dir $2=outfile ; 输出退出码
    (cd "$1" && bash "$GATE") >"$2" 2>&1
}

# 工作区指纹（tracked + untracked 内容，排除 .git）：用于断言门禁零副作用
fingerprint() {
    (cd "$1" && find . -path ./.git -prune -o -type f -print | sort | while read -r f; do
        printf '%s ' "$f"; sha256sum <"$f" | cut -c1-16
    done)
}

check_pass() { # $1=名字 $2=dir
    local name="$1" dir="$2" out="$TMP/$1.out" rc=0
    run_gate "$dir" "$out" || rc=$?
    if [ "$rc" -eq 0 ]; then ok "$name: 退出码 0（放行）"; else no "$name: 期望放行，实际 rc=$rc"; fi
    if grep -q '✅' "$out"; then ok "$name: 输出含 ✅ 通过标记"; else no "$name: 输出缺 ✅ 标记"; fi
}

check_fail() { # $1=名字 $2=dir $3=期望在输出中出现的路径
    local name="$1" dir="$2" needle="$3" out="$TMP/$1.out" rc=0
    local before after
    before=$(fingerprint "$dir")
    run_gate "$dir" "$out" || rc=$?
    after=$(fingerprint "$dir")
    if [ "$rc" -ne 0 ]; then ok "$name: 退出码非 0（硬失败）"; else no "$name: 期望硬失败，实际 rc=0（假绿）"; fi
    if grep -q '❌' "$out"; then ok "$name: 输出含 ❌ 失败标记"; else no "$name: 输出缺 ❌ 标记"; fi
    if grep -q "$needle" "$out"; then ok "$name: 指出漂移文件 $needle"; else no "$name: 未指出漂移文件 $needle"; fi
    if grep -q 'scripts/stitch.sh' "$out"; then ok "$name: 提示「改码 → scripts/stitch.sh」出路"; else no "$name: 缺 stitch 出路提示"; fi
    if grep -q 'entangled tangle' "$out"; then ok "$name: 提示「改文档 → entangled tangle」出路"; else no "$name: 缺 tangle 出路提示"; fi
    if [ "$before" = "$after" ]; then ok "$name: 门禁未修改工作区（逐字节一致）"; else
        no "$name: 门禁改动了工作区"
        diff <(echo "$before") <(echo "$after") | head -10
    fi
}

echo "[1/8] clean-db：干净 + 有 DB"
F="$TMP/clean_db"; make_fixture "$F"
(cd "$F" && entangled tangle >/dev/null 2>&1)
[ -f "$F/.entangled/filedb.json" ] && ok "fixture: 已生成 .entangled（有 DB 态）" || no "fixture: 未生成 .entangled"
check_pass clean-db "$F"

echo "[2/8] clean-no-db：干净 + 无 DB（CI 新克隆一致提交）"
F="$TMP/clean_nodb"; make_fixture "$F"; rm -rf "$F/.entangled"
check_pass clean-no-db "$F"

echo "[3/8] silent-drift：有 DB、只手改生成物（文档未动）——假绿原例"
F="$TMP/silent"; make_fixture "$F"
(cd "$F" && entangled tangle >/dev/null 2>&1)
printf 'export const B = 2;\n' >>"$F/web/src/layouts/Grid.tsx"   # 手改生成物（模拟 4d55f17）
commit_all "$F" "hand-edit generated file"
check_fail silent-drift "$F" "web/src/layouts/Grid.tsx"

echo "[4/8] conflict：文档与生成物同时被改（tangle 报 conflicts found）"
F="$TMP/conflict"; make_fixture "$F"
(cd "$F" && entangled tangle >/dev/null 2>&1)
printf 'export const B = 2;\n' >>"$F/web/src/layouts/Grid.tsx"                    # 手改生成物
sed -i 's/export const A = 1;/export const A = 99;/' "$F/design/page.md"          # 文档也改（目标内容变化）
commit_all "$F" "doc + code both changed"
check_fail conflict "$F" "web/src/layouts/Grid.tsx"

echo "[5/8] empty-db-drift：无 DB + 漂移（CI 干净副本）"
F="$TMP/empty"; make_fixture "$F"
(cd "$F" && entangled tangle >/dev/null 2>&1)
printf 'export const B = 2;\n' >>"$F/web/src/layouts/Grid.tsx"
commit_all "$F" "hand-edit generated file"
rm -rf "$F/.entangled"                                                            # 干净副本：无本地状态
check_fail empty-db-drift "$F" "web/src/layouts/Grid.tsx"

echo "[6/8] doc-side-drift：文档已改、生成物未重新 tangle（生成物禁止被门禁覆盖）"
F="$TMP/docside"; make_fixture "$F"
(cd "$F" && entangled tangle >/dev/null 2>&1)
sed -i 's/export const A = 1;/export const A = 42;/' "$F/design/page.md"   # 只改文档侧
commit_all "$F" "doc changed, not re-tangled"
check_fail doc-side-drift "$F" "web/src/layouts/Grid.tsx"

echo "[7/8] stale-db：文档与生成物一致、但本地 filedb 缓存过期（刚用 stitch 回写过）→ 必须放行"
F="$TMP/stale"; make_fixture "$F"
(cd "$F" && entangled tangle >/dev/null 2>&1)                       # DB 记录 A=1
sed -i 's/export const A = 1;/export const A = 42;/' "$F/design/page.md"   # 文档侧改成 42
write_code "$F" 42                                                  # 生成物也 42（两侧一致！）
commit_all "$F" "consistent, but local filedb cache is stale"
check_pass stale-db "$F"

echo "[8/8] hook-symlink：pre-commit 安装方式（symlink 到 .git/hooks）必须能找到 scripts/lib/"
F="$TMP/hook"; make_fixture "$F"
ln -sf "$GATE" "$F/.git/hooks/pre-commit"          # 复刻 README 的安装方式
hook_out="$TMP/hook.out"; rc=0
(cd "$F" && bash .git/hooks/pre-commit) >"$hook_out" 2>&1 || rc=$?
[ "$rc" -eq 0 ] && ok "hook-symlink: 干净态经 symlink 调用放行" || { no "hook-symlink: rc=$rc"; head -5 "$hook_out"; }
if grep -qi 'No such file or directory\|entangled_patterns\|缺少' "$hook_out"; then
    no "hook-symlink: 依赖解析失败（$(grep -i 'No such file\|entangled_patterns\|缺少' "$hook_out" | head -2 | tr '\n' ' ')）"
else
    ok "hook-symlink: scripts/lib 依赖解析正常（symlink 场景）"
fi
# 经 symlink 调用在漂移态也必须红
printf 'export const B = 2;\n' >>"$F/web/src/layouts/Grid.tsx"
rc=0; (cd "$F" && bash .git/hooks/pre-commit) >"$hook_out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] && ok "hook-symlink: 漂移态经 symlink 调用硬失败" || no "hook-symlink: 漂移态经 symlink 调用假绿"

echo "[extra] 可复跑：clean-db 连续两次同结果"
F="$TMP/clean_db"
if (cd "$F" && bash "$GATE" >/dev/null 2>&1) && (cd "$F" && bash "$GATE" >/dev/null 2>&1); then
    ok "可复跑: 两次均放行"
else
    no "可复跑: 第二次结果不同"
fi

echo "[extra] watch_list 通配符匹配（** 需匹配零个目录：design/00-vision.md 直接位于 design/ 下）"
# shellcheck source=scripts/lib/entangled_patterns.sh
source "$PWD/scripts/lib/entangled_patterns.sh"
if path_matches "design/00-vision.md" 'design/**/*.md'; then ok "glob: design/**/*.md 命中 design/00-vision.md（零目录）"; else no "glob: 零目录未命中（会误判顶层文档为生成物）"; fi
if path_matches "design/06-web/01-dashboard.md" 'design/**/*.md'; then ok "glob: design/**/*.md 命中 design/06-web/01-dashboard.md"; else no "glob: 深层文档未命中"; fi
if path_matches "design/06-web/preview/01-dashboard.html" 'design/**/*.md'; then no "glob: 生成物 .html 被误判为输入"; else ok "glob: .html 生成物不匹配 *.md"; fi

echo
echo "===== test_check_tangle: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" -eq 0 ] || exit 1
