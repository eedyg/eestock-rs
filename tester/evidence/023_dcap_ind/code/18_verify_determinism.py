"""确定性核验：run1 vs run2 的产物二进制逐字节 sha256 必须一致（双跑纪律）。"""
import hashlib, json, os, sys
OUT = "/tmp/dcap_ind_out"
ETFS = ["510050","510880","512800","512480","513050","518880","159985"]
def sha(p):
    h = hashlib.sha256()
    with open(p,'rb') as fh:
        for b in iter(lambda: fh.read(1<<20), b''):
            h.update(b)
    return h.hexdigest()
bad = 0; lines = []
for freq in ["d1","d1ns","m15"]:
    for e in ETFS:
        f = f"{e}_{freq}_dcap.f64bin"
        p1, p2 = os.path.join(OUT,"run1",f), os.path.join(OUT,"run2",f)
        if not (os.path.exists(p1) and os.path.exists(p2)):
            lines.append(f"MISSING {f} (run1={os.path.exists(p1)} run2={os.path.exists(p2)})")
            bad += 1
            continue
        a, b = sha(p1), sha(p2)
        # meta 里的 plugin sha 也核对
        m = json.load(open(os.path.join(OUT,"run1",f"meta_{e}_{freq}.json")))
        ok = a == b
        bad += 0 if ok else 1
        lines.append(f"{'OK ' if ok else 'DIFF'} {f} bars={m['bars']} cfg={m['configs']} sha={a[:16]} plugin={m['plugin_sha256'][:16]}")
print("\n".join(lines))
print("DETERMINISM:", "ALL PASS" if bad==0 else f"FAIL ({bad})")
sys.exit(0 if bad==0 else 1)
