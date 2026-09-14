import json, re, sys
V=json.load(open('/home/eestock/workspace/git/eestock/eestock-rs/design/15-multi-period/contract-vectors.json'))
mock={}
for l in open('/tmp/d53_sb/probe/mock_actuals_final.jsonl'):
    if l.startswith('{'):
        r=json.loads(l); mock[r['name']]=r
rust={}
for l in open('/tmp/d53_sb/rust_probe/rust_actuals.txt'):
    if not l.startswith('VECTOR'): continue
    f=l.rstrip('\n').split('\t')
    name, status, line = f[1], int(f[2]), f[3]
    d={'status':status,'pane':f[4],'guard':f[6]}
    if status==200:
        m=re.match(r'enabled=(\w+) periods=(\S*) heights=(\S*) indicators=(\S*)$', line)
        heights = dict(kv.split('=') for kv in m.group(3).split(';')) if m.group(3) else {}
        d['norm']={'enabled':m.group(1)=='true','periods':m.group(2).split(',') if m.group(2) else [],
                   'heights':{k:int(v) for k,v in heights.items()},
                   'indicators':m.group(4).split(',') if m.group(4) else []}
    else:
        d['err']=line[len('err='):]
    rust[name]=d
def stable(x):
    def n(y):
        if isinstance(y,list): return [n(i) for i in y]
        if isinstance(y,dict): return {k:n(y[k]) for k in sorted(y)}
        return y
    return json.dumps(n(x), sort_keys=True)
bad=[];rows=[]
for v in V:
    nm=v['name']; e=v['expect']; r=rust[nm]; m=mock[nm]
    agree_status = int(r['status'])==int(m['mock'])
    rust_ok = int(r['status'])==int(e['status']); mock_ok = int(m['mock'])==int(e['status'])
    if int(e['status'])==200:
        want=stable(e['normalized'])
        norm_agree = ('norm' in r and stable(r['norm'])==want) and (m.get('mockNormalized') is not None and stable(m['mockNormalized'])==want)
    else:
        need=e['errorMustContain']
        norm_agree = (need in r.get('err','')) and (need in (m.get('mockError') or ''))
    ok = agree_status and rust_ok and mock_ok and norm_agree
    if not ok: bad.append(nm)
    rows.append((nm,int(e['status']),int(r['status']),int(m['mock']),norm_agree,'OK' if ok else 'MISMATCH'))
w=max(len(x[0]) for x in rows)
for nm,es,rs,ms,na,st in rows:
    print(f"{nm:<{w}}  expect={es} rust={rs} mock={ms} normalizeMatch={na}  {st}")
print(f"PARITY_SUMMARY vectors={len(rows)} mismatches={len(bad)} names={bad}")
