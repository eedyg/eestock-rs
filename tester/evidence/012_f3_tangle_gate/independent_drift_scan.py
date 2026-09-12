#!/usr/bin/env python3
"""TESTER independent drift scanner (does not use scripts/check-tangle.sh at all).

Method: copy watch_list input tree + every declared target into a throwaway sandbox,
wipe the sandbox filedb, force-regenerate with `entangled tangle -f`, then byte-compare
every generated file against the source-of-truth tree it was derived from.

Usage: independent_drift_scan.py <repo-dir>
Prints: inputs=N generated_compared=N drift=N missing=N  + the file lists.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(sys.argv[1])


def watch_list(cfg):
    txt = open(cfg, encoding="utf-8").read()
    m = re.search(r"watch_list\s*=\s*\[(.*?)\]", txt, re.S)
    pats = [p.strip().strip('"').strip("'") for p in m.group(1).split(",")]
    return [p for p in pats if p]


def glob_to_re(g):
    out = ""
    i = 0
    while i < len(g):
        if g[i] == "*":
            if i + 1 < len(g) and g[i + 1] == "*":
                if i + 2 < len(g) and g[i + 2] == "/":
                    out += "(?:.*/)?"
                    i += 3
                    continue
                out += ".*"
                i += 2
                continue
            out += "[^/]*"
            i += 1
            continue
        out += re.escape(g[i])
        i += 1
    return re.compile("^" + out + "$")


def main():
    pats = watch_list(os.path.join(ROOT, "entangled.toml"))
    res = [glob_to_re(p) for p in pats]
    roots = sorted({p.split("*")[0].rstrip("/") for p in pats})

    def matches(rel):
        return any(r.match(rel) for r in res)

    inputs = []
    for rt in roots:
        base = os.path.join(ROOT, rt)
        for dp, _, fns in os.walk(base):
            for fn in fns:
                rel = os.path.relpath(os.path.join(dp, fn), ROOT)
                if matches(rel):
                    inputs.append(rel)

    targets = set()
    for rel in inputs:
        with open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace") as fh:
            for mm in re.finditer(r"file=([^\s}\"]+)", fh.read()):
                targets.add(mm.group(1))

    sbx = tempfile.mkdtemp(prefix="tester-drift.")
    try:
        shutil.copy2(os.path.join(ROOT, "entangled.toml"), os.path.join(sbx, "entangled.toml"))
        for rt in roots:
            shutil.copytree(os.path.join(ROOT, rt), os.path.join(sbx, rt))
        for t in sorted(targets):
            src = os.path.join(ROOT, t)
            if os.path.isfile(src):
                dst = os.path.join(sbx, t)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
        shutil.rmtree(os.path.join(sbx, ".entangled"), ignore_errors=True)
        p = subprocess.run(["entangled", "tangle", "-f"], cwd=sbx, capture_output=True, text=True)
        if p.returncode != 0 or "ERROR" in p.stdout + p.stderr:
            print("REGEN FAILED rc=%s" % p.returncode)
            print((p.stdout + p.stderr)[-2000:])
            return 2

        drift, missing, compared = [], [], 0
        for dp, dns, fns in os.walk(sbx):
            if ".entangled" in dns:
                dns.remove(".entangled")
            for fn in fns:
                rel = os.path.relpath(os.path.join(dp, fn), sbx)
                if matches(rel):
                    continue
                compared += 1
                real = os.path.join(ROOT, rel)
                if not os.path.isfile(real):
                    missing.append(rel)
                elif open(os.path.join(sbx, rel), "rb").read() != open(real, "rb").read():
                    drift.append(rel)
        print("roots=%s" % roots)
        print("inputs=%d generated_compared=%d drift=%d missing=%d" % (len(inputs), compared, len(drift), len(missing)))
        for d in sorted(drift):
            print("  DRIFT: %s" % d)
        for m in sorted(missing):
            print("  MISSING: %s" % m)
        return 0
    finally:
        shutil.rmtree(sbx, ignore_errors=True)


sys.exit(main())
