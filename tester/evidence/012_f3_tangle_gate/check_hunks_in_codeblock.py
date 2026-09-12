#!/usr/bin/env python3
"""Independent check (tester): every changed line of the given design docs must fall INSIDE a
fenced code block (L3), i.e. no prose/table/structure outside blocks may change.
Compares git HEAD version vs working-tree version. Prints per-file verdict."""
import subprocess
import sys
import difflib


def head_lines(path):
    out = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True, text=True, check=True)
    return out.stdout.splitlines()


def new_lines(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read().splitlines()


def fence_mask(lines):
    """Return list[bool] in_block per line; fence delimiters themselves -> False (boundary)."""
    mask = []
    in_block = False
    for ln in lines:
        stripped = ln.lstrip()
        is_fence = stripped.startswith("```") or stripped.startswith("~~~")
        if is_fence:
            mask.append(False)  # boundary line itself not considered 'inside'
            in_block = not in_block
        else:
            mask.append(in_block)
    return mask


def check(path):
    old, new = head_lines(path), new_lines(path)
    old_mask, new_mask = fence_mask(old), fence_mask(new)
    sm = difflib.SequenceMatcher(None, old, new, autojunk=False)
    bad = []
    changed = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        # deletions/replacements on old side
        for i in range(i1, i2):
            changed += 1
            if not old_mask[i]:
                bad.append(("OLD", i + 1, old[i]))
        # insertions/replacements on new side
        for j in range(j1, j2):
            changed += 1
            if not new_mask[j]:
                bad.append(("NEW", j + 1, new[j]))
    print(f"{path}: changed_lines={changed} outside_block={len(bad)}")
    for side, ln, text in bad:
        print(f"   !! OUTSIDE BLOCK {side}:{ln}: {text[:100]}")
    return len(bad) == 0


if __name__ == "__main__":
    ok = True
    for p in sys.argv[1:]:
        ok = check(p) and ok
    sys.exit(0 if ok else 1)
