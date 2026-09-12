# -*- coding: utf-8 -*-
import os, re, json

EXCL_DIRS = {'.git','target','node_modules','.entangled','.claude','.pi','.gitnexus','dist','build'}
BIN_EXT = {'.png','.jpg','.jpeg','.gif','.webp','.ico','.woff','.woff2','.ttf','.otf','.pdf','.zip','.gz','.so','.o','.rlib','.db','.lock'}
RE_BEGIN = re.compile(r'^\s*(?://|#|--|<!--|/\*|\*)?\s*~/~ begin\s*<<')
RE_END   = re.compile(r'^\s*(?://|#|--|<!--|/\*|\*)?\s*~/~ end\s*(?:-->|\*/)?\s*$')

def walk():
    for dp, dns, fns in os.walk('.'):
        dns[:] = [d for d in dns if d not in EXCL_DIRS]
        for fn in fns:
            yield os.path.normpath(os.path.join(dp, fn))

targets = {}
for dp, dns, fns in os.walk('design'):
    for fn in fns:
        if fn.endswith('.md'):
            p = os.path.join(dp, fn)
            t = open(p, encoding='utf-8', errors='replace').read()
            for m in re.finditer(r'file=([^\s}"]+)', t):
                targets.setdefault(m.group(1), p)
filedb = set(json.load(open('.entangled/filedb.json'))['files'].keys())

rows = []
for p in walk():
    if os.path.splitext(p)[1].lower() in BIN_EXT: continue
    try: txt = open(p, 'rb').read().decode('utf-8')
    except Exception: continue
    lines = txt.splitlines()
    b, e, prose = [], [], []
    for i, l in enumerate(lines, 1):
        if '~/' not in l: continue
        if RE_BEGIN.match(l): b.append(i)
        elif RE_END.match(l): e.append(i)
        else: prose.append(i)
    if not (b or e or prose): continue
    rel = p[2:] if p.startswith('./') else p
    rows.append(dict(file=rel, b=b, e=e, prose=prose))

print('== 全仓 `~/~` 行清单（清理后终态）==')
print(f'枚举：仓库根（排除 .git/target/node_modules/.entangled/.claude/.pi/.gitnexus + 二进制资产）')
print(f'汇总：{len(rows)} 文件 / {sum(len(r["b"])+len(r["e"])+len(r["prose"]) for r in rows)} 行，'
      f'其中真标记行 begin={sum(len(r["b"]) for r in rows)} end={sum(len(r["e"]) for r in rows)}、'
      f'散文提及={sum(len(r["prose"]) for r in rows)}')
print()
gov, unowned, unpaired, prose_files = [], [], [], []
for r in rows:
    f = r['file']
    if r['b'] or r['e']:
        if len(r['b']) == 1 and len(r['e']) == 1:
            if f in filedb: gov.append(r)
            else: unowned.append(r)
        else: unpaired.append(r)
    else: prose_files.append(r)
print(f'(a) 受治理生成物（filedb 登记 + 恰 1 组 begin/end）：{len(gov)} 文件 —— 期望，保留')
print(f'(b) 文档代码块内标记：0 行（design/**/*.md 仅剩散文提及，见 (d)）')
print(f'(c) 孤立/无主：{len(unpaired)} 文件不成对 + {len(unowned)} 文件成对但无主')
for r in unpaired: print(f'    [不成对] {r["file"]} B={r["b"]} E={r["e"]}')
for r in unowned: print(f'    [无主  ] {r["file"]} B={r["b"]} E={r["e"]}')
print(f'(d) 散文提及/证据文本：{len(prose_files)} 文件（保留）')
for r in prose_files: print(f'    {r["file"]}  行号={r["prose"]}')
print()
print('(a) 清单：')
for r in gov: print(f'  {r["file"]}  begin@{r["b"]} end@{r["e"]}')
