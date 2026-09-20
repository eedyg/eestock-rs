#!/usr/bin/env python3
"""ADR-028 D4.1 独立复验 —— **离线像素复算**（与页面侧 canvas 读像素互为独立口径）。

输入（同目录）：`t4_kline_*.png`（K 线区域裁切截图，clip 原点见 t4_highlight_pixels.json 的 clip）、
`t2_label_on.png`、`t7_after_l2_jump.png`。
输出：`pixel_analysis.json`（白描边簇 + 标签 ink run + 与页面侧读数的对照）。

口径：
* 白簇 = 三通道 ≥ 240 的像素（高亮描边 `borderColor:'#ffffff'`），4 邻接连通分量，`size ≥ 30` 计重
  （实测恒定背景噪声为 size 4 / 1 的两枚小簇，位于右侧 y 轴区域）。
* 标签 ink = `r>80 && r−g>40 && r−b>25`（买卖标记红/同色文本）；标签区 = 白簇质心 y ±5 行、
  x 从质心 +2 起 98 列；判据 = 「含墨列」的最长连续列数（9px 文本为水平连续字形条带）。
"""
import glob
import json
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CLUSTER_MIN = 30
INK_NEIGH = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def white_clusters(path, thr=240):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    grid = [[False] * w for _ in range(h)]
    total = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r >= thr and g >= thr and b >= thr:
                grid[y][x] = True
                total += 1
    seen = [[False] * w for _ in range(h)]
    out = []
    for y in range(h):
        for x in range(w):
            if not grid[y][x] or seen[y][x]:
                continue
            stack = [(x, y)]
            seen[y][x] = True
            n = 0
            sx = sy = 0
            x0, x1, y0, y1 = 10**9, -1, 10**9, -1
            while stack:
                cx, cy = stack.pop()
                n += 1
                sx += cx
                sy += cy
                x0 = min(x0, cx)
                x1 = max(x1, cx)
                y0 = min(y0, cy)
                y1 = max(y1, cy)
                for dx, dy in INK_NEIGH:
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and grid[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            out.append({"size": n, "cx": round(sx / n, 2), "cy": round(sy / n, 2), "x0": x0, "x1": x1, "y0": y0, "y1": y1})
    out.sort(key=lambda c: -c["size"])
    return {"file": os.path.basename(path), "size": [w, h], "white_total": total, "clusters_all": out,
            "clusters_big": [c for c in out if c["size"] >= CLUSTER_MIN]}


def ink_run(path, x0, x1, y0, y1):
    im = Image.open(path).convert("RGB")
    px = im.load()
    counts = {}
    total = 0
    for x in range(max(0, x0), min(im.size[0], x1)):
        n = 0
        for y in range(max(0, y0), min(im.size[1], y1)):
            r, g, b = px[x, y]
            if r > 80 and r - g > 40 and r - b > 25 and not (r >= 240 and g >= 240 and b >= 240):
                n += 1
        counts[x] = n
        total += n
    best = cur = 0
    for x in range(max(0, x0), min(im.size[0], x1)):
        if counts[x] >= 1:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return {"box": {"x0": x0, "x1": x1, "y0": y0, "y1": y1}, "max_run": best, "ink_total": total,
            "cols_with_ink": sum(1 for v in counts.values() if v >= 1)}


def main():
    res = {"clusters": {}, "ink": {}, "cross_check": {}}
    for f in sorted(glob.glob(os.path.join(HERE, "t*_kline_*.png"))) + [os.path.join(HERE, "t2_label_on.png"), os.path.join(HERE, "t7_after_l2_jump.png")]:
        if os.path.exists(f):
            res["clusters"][os.path.basename(f)] = white_clusters(f)

    # 标签 ink：以**白簇质心**（= 高亮圆环中心 = 该笔圆点位置）为基准定义带（不依赖几何换算）
    for name in ("t2_label_on.png", "t4_kline_hl42_a.png"):
        p = os.path.join(HERE, name)
        if not os.path.exists(p):
            continue
        cl = res["clusters"][name]["clusters_big"]
        if len(cl) != 1:
            res["ink"][name] = {"skipped": f"白簇数 != 1（{len(cl)}）"}
            continue
        cx, cy = int(round(cl[0]["cx"])), int(round(cl[0]["cy"]))
        res["ink"][name] = ink_run(p, cx + 2, cx + 100, cy - 5, cy + 6)
        res["ink"][name]["control_below"] = ink_run(p, cx + 2, cx + 100, cy + 16, cy + 27)
        res["ink"][name]["anchor"] = {"cx": cx, "cy": cy}

    # 与页面侧读数交叉核对
    t4 = os.path.join(HERE, "t4_highlight_pixels.json")
    if os.path.exists(t4):
        page = json.load(open(t4))
        for shot, key in (("t4_kline_hl42_a.png", "scanOn"), ("t4_kline_hl42_b.png", "scanP2"),
                          ("t4_kline_after3s.png", "scanAfter"), ("t4_kline_hl43.png", "scanOnB")):
            if shot in res["clusters"]:
                mine = res["clusters"][shot]["clusters_big"]
                theirs = [c for c in page[key]["clusters"] if c["size"] >= CLUSTER_MIN]
                res["cross_check"][shot] = {
                    "offline_big": len(mine), "page_big": len(theirs),
                    "offline_size": [c["size"] for c in mine], "page_size": [c["size"] for c in theirs],
                    "offline_centroid": [[c["cx"], c["cy"]] for c in mine],
                    "page_centroid": [[round(c["cx"], 2), round(c["cy"], 2)] for c in theirs],
                    "shape_match": len(mine) == len(theirs) and all(
                        abs(a["size"] - b["size"]) <= max(3, 0.05 * a["size"]) for a, b in zip(mine, sorted(theirs, key=lambda c: -c["size"]))
                    ),
                }
    t2 = os.path.join(HERE, "t2_label_ink.json")
    if os.path.exists(t2) and "t2_label_on.png" in res.get("ink", {}):
        res["cross_check"]["t2_ink_page_vs_offline"] = {
            "page_maxRun": json.load(open(t2))["ink"]["maxRun"],
            "offline_max_run": res["ink"]["t2_label_on.png"].get("max_run"),
        }
    out = os.path.join(HERE, "pixel_analysis.json")
    json.dump(res, open(out, "w"), ensure_ascii=False, indent=1)
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
