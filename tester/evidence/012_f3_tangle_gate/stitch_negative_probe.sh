#!/usr/bin/env bash
# TESTER independent negative sample for scripts/stitch.sh:
#   round-trip check must FAIL and stitch must REFUSE to write back.
# Construction (independent of scripts/tests/test_stitch.sh T3):
#   repo generated file Grid.tsx has NO tangle markers and contains an extra
#   hand-added line -> doc cannot regenerate it -> round-trip mismatch -> refuse.
set -uo pipefail
STITCH="${1:?stitch path}"
F=/tmp/f3_accept/stitch_neg
rm -rf "$F"; mkdir -p "$F/design" "$F/web/src/layouts"
cat >"$F/entangled.toml" <<'EOF'
version = "2.0"
watch_list = ["design/**/*.md"]

[[languages]]
name = "TSX"
identifiers = ["tsx", "ts", "typescript"]
comment = { open = "//" }
EOF
cat >"$F/design/page.md" <<'EOF'
# fixture page

``` {.tsx file=web/src/layouts/Grid.tsx}
export const A = 1;
```
EOF
# hand-written file WITHOUT tangle markers + extra line => not reproducible from doc
printf 'export const A = 1;\nexport const EXTRA = 7;\n' >"$F/web/src/layouts/Grid.tsx"
printf '.entangled/\n' >"$F/.gitignore"
git -C "$F" init -q
git -C "$F" add -A
git -C "$F" -c user.email=t@t -c user.name=t commit -qm init
doc_before=$(sha256sum <"$F/design/page.md")
code_before=$(sha256sum <"$F/web/src/layouts/Grid.tsx")
echo "=== fixture: doc declares Grid.tsx; repo file is marker-less + has EXTRA line ==="
echo "=== run: bash stitch.sh  (default scoped) ==="
out="$F/../stitch_neg.out"
(cd "$F" && bash "$STITCH") >"$out" 2>&1; rc=$?
echo "STITCH_RC=$rc"
cat "$out"
doc_after=$(sha256sum <"$F/design/page.md")
code_after=$(sha256sum <"$F/web/src/layouts/Grid.tsx")
echo "--- doc  unchanged: $([ "$doc_before" = "$doc_after" ] && echo YES || echo NO)"
echo "--- code unchanged: $([ "$code_before" = "$code_after" ] && echo YES || echo NO)"
echo "--- git status:"; git -C "$F" status --porcelain
