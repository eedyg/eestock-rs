#!/usr/bin/env python3
"""ADR-028 D4.1 复验二轮 —— R3 圆点颜色身份的**离线**像素复算（独立于页面侧合成读法）。

输入：`raw/v3_dot_pixels.json`（页面侧读数：每个圆点的 store 色值 / 圆心 / 3×3）+ `raw/v3_dot_pixels.png`
（K 线容器截图，坐标 0,0 == 容器左上角）。
输出：`raw/pixel_dots_offline.json`（离线读数 + 与页面侧的一致性 + 四档判定）。

判据口径与页面侧一致（同一套「覆盖层混合复原」规则），但**读图路径完全独立**（PNG 解码 + 逐像素），
用于交叉核对「页面侧合成位图读数」不是读数伪影。
"""
import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
COVER_COLORS = [(9, 13, 24), (11, 15, 26), (255, 255, 255)]


def parse_hex(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def max_abs_diff(a, b):
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))


def blend_attribution(px, expect):
    best = {"ok": False, "alpha": None, "cover": None, "residual": None}
    best_res = 1e9
    for c in COVER_COLORS:
        for step in range(5, 96):
            a = step / 100.0
            pred = (a * c[0] + (1 - a) * expect[0], a * c[1] + (1 - a) * expect[1], a * c[2] + (1 - a) * expect[2])
            res = max_abs_diff(px, pred)
            if res < best_res:
                best_res = res
                best = {"ok": res <= 12, "alpha": round(a, 2), "cover": list(c), "residual": round(res, 1)}
    return best


def main():
    with open(os.path.join(HERE, 'v3_dot_pixels.json'), encoding='utf-8') as fh:
        data = json.load(fh)
    img = Image.open(os.path.join(HERE, 'v3_dot_pixels.png')).convert('RGB')
    pane = data['pane']
    ox, oy = pane['ox'], pane['oy']

    rows = []
    for rec in data['records']:
        expect = parse_hex(rec['expectColor'])
        x = int(round(rec['dot']['x'] + ox))
        y = int(round(rec['dot']['y'] + oy))
        center = img.getpixel((x, y))
        n3 = [[list(img.getpixel((x + dx, y + dy))) for dx in (-1, 0, 1)] for dy in (-1, 0, 1)]
        flat = [tuple(v) for row in n3 for v in row]
        tally = {}
        for c in flat:
            if c[0] >= 240 and c[1] >= 240 and c[2] >= 240:
                continue
            tally[c] = tally.get(c, 0) + 1
        dominant = max(tally.items(), key=lambda kv: kv[1])[0] if tally else None
        d_expect_center = max_abs_diff(center, expect)
        d_store_center = max_abs_diff(center, parse_hex(rec['storeColor']))
        d_store_dom = max_abs_diff(dominant, parse_hex(rec['storeColor'])) if dominant else 9999
        blend = blend_attribution(center, expect)
        if d_expect_center <= 10:
            tier = 'exact'
        elif d_expect_center <= 25:
            tier = 'near'
        elif d_store_center <= 10:
            tier = 'store-exact'
        elif d_store_dom <= 25:
            tier = 'dominant'
        elif blend['ok']:
            tier = 'blend'
        else:
            tier = 'FAIL'
        page_center = list(rec['centerPixel'][:3])
        rows.append({
            'key': rec['key'],
            'expectColor': rec['expectColor'],
            'storeColor': rec['storeColor'],
            'xy': [x, y],
            'offlineCenter': list(center),
            'pageCenter': page_center,
            'pageVsOfflineMaxDiff': max_abs_diff(center, page_center),
            'offlineDominant': list(dominant) if dominant else None,
            'dExpectCenter': d_expect_center,
            'dStoreCenter': d_store_center,
            'dStoreDominant': d_store_dom,
            'blend': blend,
            'tier': tier,
        })

    exact = sum(1 for r in rows if r['tier'] == 'exact')
    fail = [r for r in rows if r['tier'] == 'FAIL']
    max_diff = max(r['pageVsOfflineMaxDiff'] for r in rows)
    agree = sum(1 for r in rows if r['pageVsOfflineMaxDiff'] <= 2)

    out = {
        'source': 'v3_dot_pixels.png + v3_dot_pixels.json',
        'imageSize': list(img.size),
        'pane': pane,
        'sampled': len(rows),
        'tiers': {
            'exact': exact,
            'near': sum(1 for r in rows if r['tier'] == 'near'),
            'storeExact': sum(1 for r in rows if r['tier'] == 'store-exact'),
            'dominant': sum(1 for r in rows if r['tier'] == 'dominant'),
            'blend': sum(1 for r in rows if r['tier'] == 'blend'),
            'fail': len(fail),
        },
        'exactRatio': exact / len(rows) if rows else 0,
        'pageVsOfflineAgreeWithin2': agree,
        'pageVsOfflineMaxDiff': max_diff,
        'failKeys': [r['key'] for r in fail],
        'rows': rows,
    }
    with open(os.path.join(HERE, 'pixel_dots_offline.json'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != 'rows'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
