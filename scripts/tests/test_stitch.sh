#!/usr/bin/env bash
# test_stitch.sh — scripts/stitch.sh（ADR-018 D-F3-4 / O1 纪律）fixture 自测
#
# 断言：
#   T1 无参默认：有漂移（手改生成物）→ 沙箱 scoped 回写文档；生成物逐字节不变；门禁转绿
#   T2 显式 scoped：`stitch.sh <code-file>` 只回写该文件所属文档
#   T3 负样例：沙箱 round-trip 校验失败（文档声明了仓库中缺失的生成物）→ **拒绝回写**，
#              文档逐字节不变，退出码非 0
#   T4 无漂移：无参执行 → 提示无需回写，退出码 0，工作区不变
#   T5 --help：包含 O1 纪律两条出路 + 「禁止全局 stitch / --force」HAZARD 文案
#
# 用法：bash scripts/tests/test_stitch.sh
set -uo pipefail

cd "$(dirname "$0")/../.."
ROOT=$PWD
STITCH="${STITCH_UNDER_TEST:-$ROOT/scripts/stitch.sh}"
GATE="$ROOT/scripts/check-tangle.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

if ! command -v entangled >/dev/null 2>&1; then
    echo "SKIP: 未安装 entangled，无法运行 stitch 自测" >&2
    exit 0
fi
if [ ! -x "$STITCH" ]; then
    echo "  ❌ scripts/stitch.sh 不存在或不可执行（$STITCH）"
    exit 1
fi

make_fixture() { # $1=dir；doc 与 code 一致（A=1），无漂移
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

``` {.tsx file=web/src/layouts/Grid.tsx}
export const A = 1;
```
EOF
    cat >"$d/web/src/layouts/Grid.tsx" <<'EOF'
// ~/~ begin <<design/page.md#web/src/layouts/Grid.tsx>>[init]
export const A = 1;
// ~/~ end
EOF
    printf '.entangled/\n' >"$d/.gitignore"
    git -C "$d" init -q
    commit_all "$d" init
    (cd "$d" && entangled tangle >/dev/null 2>&1) || true
    commit_all "$d" tangle-db
}

commit_all() { git -C "$1" add -A && git -C "$1" -c user.email=t@t -c user.name=t commit -qm "$2" >/dev/null 2>&1 || true; }
hash_of() { sha256sum <"$1" | cut -d' ' -f1; }

# ------------------------------------------------------------------ T1 ------
echo "[T1] 无参默认：手改生成物 → 沙箱 scoped 回写文档，生成物零回退"
F="$TMP/t1"; make_fixture "$F"
# 模拟 4d55f17：手改生成物（块内追加实现），文档未动
python3 - "$F/web/src/layouts/Grid.tsx" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text()
p.write_text(t.replace("export const A = 1;", "export const A = 1;\nexport const B = 2;"))
PY
commit_all "$F" "hand-edit generated file"
code_before=$(hash_of "$F/web/src/layouts/Grid.tsx")
doc_before=$(hash_of "$F/design/page.md")
if (cd "$F" && bash "$GATE" >/dev/null 2>&1); then
    no "T1 前置: 门禁应报漂移，实际放行"
else
    ok "T1 前置: 门禁报漂移（红）"
fi
out_t1="$TMP/t1.out"; rc=0
(cd "$F" && bash "$STITCH") >"$out_t1" 2>&1 || rc=$?
[ "$rc" -eq 0 ] && ok "T1: stitch 退出码 0" || { no "T1: stitch rc=$rc"; sed -n 1,20p "$out_t1"; }
grep -q 'export const B = 2;' "$F/design/page.md" && ok "T1: 文档吸收了实现内容（B=2）" || no "T1: 文档未回写实现内容"
[ "$(hash_of "$F/web/src/layouts/Grid.tsx")" = "$code_before" ] && ok "T1: 生成物逐字节不变（零回退）" || no "T1: 生成物被改动"
[ "$(hash_of "$F/design/page.md")" != "$doc_before" ] && ok "T1: 文档已更新" || no "T1: 文档未更新"
if (cd "$F" && bash "$GATE" >/dev/null 2>&1); then ok "T1: 回写后门禁转绿"; else no "T1: 回写后门禁仍红"; fi
changed=$(cd "$F" && git status --porcelain | sed 's/^...//' | sort | tr '\n' ' ')
[ "$changed" = "design/page.md " ] && ok "T1: 仅文档被修改（$changed）" || no "T1: 意外改动范围：[$changed]"
if (cd "$F" && git status --porcelain --ignored | grep -qE '^\?\?' ); then
    no "T1: 残留未跟踪文件：$(cd "$F" && git status --porcelain | grep '^??' | head -3 | tr '\n' ' ')"
else
    ok "T1: 无残留临时文件"
fi

# ------------------------------------------------------------------ T2 ------
echo "[T2] 显式 scoped：stitch.sh <code-file>"
F="$TMP/t2"; make_fixture "$F"
python3 - "$F/web/src/layouts/Grid.tsx" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text()
p.write_text(t.replace("export const A = 1;", "export const A = 1;\nexport const C = 3;"))
PY
commit_all "$F" "hand-edit"
rc=0; (cd "$F" && bash "$STITCH" web/src/layouts/Grid.tsx) >"$TMP/t2.out" 2>&1 || rc=$?
[ "$rc" -eq 0 ] && ok "T2: 退出码 0" || { no "T2: rc=$rc"; sed -n 1,15p "$TMP/t2.out"; }
grep -q 'export const C = 3;' "$F/design/page.md" && ok "T2: 文档吸收实现（C=3）" || no "T2: 文档未回写"

# ------------------------------------------------------------------ T3 ------
echo "[T3] 负样例：沙箱 round-trip 校验失败 → 拒绝回写"
F="$TMP/t3"; make_fixture "$F"
# 文档新增一个声明了生成物、但仓库中并不存在的块 → 校验必然失败
cat >>"$F/design/page.md" <<'EOF'

``` {.tsx file=web/src/layouts/Missing.tsx}
export const M = 1;
```
EOF
python3 - "$F/web/src/layouts/Grid.tsx" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text()
p.write_text(t.replace("export const A = 1;", "export const A = 1;\nexport const D = 4;"))
PY
commit_all "$F" "drift + doc declares missing target"
doc_before=$(hash_of "$F/design/page.md")
code_before=$(hash_of "$F/web/src/layouts/Grid.tsx")
rc=0; (cd "$F" && bash "$STITCH" web/src/layouts/Grid.tsx) >"$TMP/t3.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] && ok "T3: 退出码非 0（拒绝回写）" || no "T3: 期望拒绝，实际 rc=0"
[ "$(hash_of "$F/design/page.md")" = "$doc_before" ] && ok "T3: 文档逐字节不变" || no "T3: 文档被写入（校验未拦住）"
[ "$(hash_of "$F/web/src/layouts/Grid.tsx")" = "$code_before" ] && ok "T3: 生成物逐字节不变" || no "T3: 生成物被改动"
grep -qiE 'round-trip|校验|缺失|missing' "$TMP/t3.out" && ok "T3: 输出说明校验失败原因" || { no "T3: 输出缺少校验失败说明"; sed -n 1,15p "$TMP/t3.out"; }

# ------------------------------------------------------------------ T4 ------
echo "[T4] 无漂移：无参执行 → 提示无需回写"
F="$TMP/t4"; make_fixture "$F"
before=$(git -C "$F" status --porcelain; hash_of "$F/design/page.md"; hash_of "$F/web/src/layouts/Grid.tsx")
rc=0; (cd "$F" && bash "$STITCH") >"$TMP/t4.out" 2>&1 || rc=$?
after=$(git -C "$F" status --porcelain; hash_of "$F/design/page.md"; hash_of "$F/web/src/layouts/Grid.tsx")
[ "$rc" -eq 0 ] && ok "T4: 退出码 0" || { no "T4: rc=$rc"; sed -n 1,10p "$TMP/t4.out"; }
[ "$before" = "$after" ] && ok "T4: 工作区不变" || no "T4: 工作区被改动"

# ------------------------------------------------------------------ T5 ------
echo "[T5] --help：O1 纪律 + HAZARD 文案"
"$STITCH" --help >"$TMP/t5.out" 2>&1 || true
grep -q 'entangled tangle' "$TMP/t5.out" && ok "T5: 含「改文档 → entangled tangle」" || no "T5: 缺 tangle 出路"
grep -q 'scripts/stitch.sh\|stitch.sh' "$TMP/t5.out" && ok "T5: 含「改码 → stitch」" || no "T5: 缺 stitch 出路"
grep -qiE '禁止|破坏' "$TMP/t5.out" && ok "T5: 含全局 stitch / --force HAZARD 说明" || no "T5: 缺 HAZARD 说明"

echo
echo "===== test_stitch: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" -eq 0 ] || exit 1
