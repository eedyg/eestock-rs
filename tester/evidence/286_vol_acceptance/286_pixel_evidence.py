#!/usr/bin/env python3
"""286 像素级证据（无法人工肉眼时的客观渲染核验）。
对 Playwright 页面截图做像素统计：背景色占比 / ink 比例 / 两图逐像素差异。
用法：python3 286_pixel_evidence.py  → 输出 A9_pixel_evidence.txt
"""
import os
from collections import Counter
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))
lines = []
def say(s):
    lines.append(s); print(s)

def load(n):
    return Image.open(os.path.join(OUT, n)).convert('RGB')

def ink_ratio(img, box=None, tol=14):
    im = img.crop(box) if box else img
    px = list(im.getdata())
    bg = Counter(px).most_common(1)[0][0]
    ink = sum(1 for p in px if max(abs(p[i]-bg[i]) for i in range(3)) > tol)
    return ink / len(px), bg, len(px)

def diff_ratio(a, b, box=None):
    ia = a.crop(box) if box else a
    ib = b.crop(box) if box else b
    assert ia.size == ib.size, (ia.size, ib.size)
    pa, pb = list(ia.getdata()), list(ib.getdata())
    d = sum(1 for i in range(len(pa)) if max(abs(pa[i][j]-pb[i][j]) for j in range(3)) > 14)
    return d / len(pa)

say('# A9（附加）像素级渲染证据（页面截图，非图表导出）')
say('')
files = ['A1_fullpage_default_on.png', 'A2_baseline_full.png', 'A3_vol_off_full.png', 'A4_vol_on_again_full.png',
         'A2_baseline_base_pane.png', 'A3_vol_off_base_pane.png', 'A4_vol_on_again_base_pane.png',
         'A2_baseline_satellite_1h.png', 'A3_vol_off_satellite_1h.png', 'A4_vol_on_again_satellite_1h.png',
         'A2_baseline_satellite_1d.png', 'A3_vol_off_satellite_1d.png', 'A4_vol_on_again_satellite_1d.png']
imgs = {f: load(f) for f in files}
say('## 截图尺寸')
for f in files:
    say(f'  {f}: {imgs[f].size[0]}x{imgs[f].size[1]}')
say('')

say('## 基准 pane 截图（A2 基线：candle 0-236px / separator 237px / VOL 238-337px / x轴 338-363px）')
base2, base3, base4 = imgs['A2_baseline_base_pane.png'], imgs['A3_vol_off_base_pane.png'], imgs['A4_vol_on_again_base_pane.png']
h = base2.size[1]
say(f'  高度={h}')
for name, band in [('candle(0-236)', (0, 0, 1522, 237)), ('sep(237)', (0, 237, 1522, 238)), ('VOL(238-337)', (0, 238, 1522, 338)), ('xAxis(338-363)', (0, 338, 1522, 363))]:
    r2, bg2, _ = ink_ratio(base2, band)
    r3, _, _ = ink_ratio(base3, band)
    r4, _, _ = ink_ratio(base4, band)
    say(f'  {name}: ink 占比 A2={r2:.4f} A3={r3:.4f} A4={r4:.4f}  (A2背景色={bg2})')
say('')
say('## 基准 pane 逐像素差异（VOL 关/开 对基线）')
say(f'  A3 vs A2 全图差异像素占比 = {diff_ratio(base3, base2):.4f}')
say(f'  A4 vs A2 全图差异像素占比 = {diff_ratio(base4, base2):.4f}（0 ⇒ 逐像素一致）')
say(f'  A3 vs A2 仅 VOL 带(238-337) 差异占比 = {diff_ratio(base3, base2, (0, 238, 1522, 338)):.4f}')
say('')

say('## 卫星 1h / 1d 截图（VOL 只在指标 pane 内，pane 高 135px；关掉后该 pane 消失 ⇒ 指标区应变空白）')
for p in ['1h', '1d']:
    a2, a3, a4 = imgs[f'A2_baseline_satellite_{p}.png'], imgs[f'A3_vol_off_satellite_{p}.png'], imgs[f'A4_vol_on_again_satellite_{p}.png']
    r2, bg2, n = ink_ratio(a2)
    r3, _, _ = ink_ratio(a3)
    r4, _, _ = ink_ratio(a4)
    say(f'  {p}: size={a2.size[0]}x{a2.size[1]} ink A2={r2:.4f} A3={r3:.4f} A4={r4:.4f}')
    say(f'      A3 vs A2 差异占比={diff_ratio(a3, a2):.4f} ; A4 vs A2 差异占比={diff_ratio(a4, a2):.4f}（0 ⇒ 逐像素一致）')
say('')
say('## 整页截图指纹（逐像素一致则 md5 相同）')
import hashlib
for f in ['A1_fullpage_default_on.png', 'A2_baseline_full.png', 'A3_vol_off_full.png', 'A4_vol_on_again_full.png']:
    say(f'  {f}: md5={hashlib.md5(open(os.path.join(OUT,f),"rb").read()).hexdigest()}')

with open(os.path.join(OUT, 'A9_pixel_evidence.txt'), 'w') as fh:
    fh.write('\n'.join(lines) + '\n')
