#!/usr/bin/env python3
"""S6-a 相位证据：证明 ctx.index 含 warmup 段，且买入窗相位 = 250 % 20。
输入：raw/28_per_bar_pretty.json（per_bar 全量）。"""
import json
from collections import Counter
D = "coder/evidence/20260918_sr_trades_strategy_side/raw"
pb = json.load(open(f"{D}/28_per_bar_pretty.json"))
sc = [e["aggregate"] for e in pb]
print("per_bar 长度:", len(pb), " 分数分布:", dict(Counter(sc)))
print("前 30 根 aggregate:", sc[:30])
print("idx%20<5 与 aggregate==75 完全等价？", all((i % 20 < 5) == (sc[i] == 75) for i in range(len(pb))))
print()
print("warmup 段 (idx 0..249) 分数分布:", dict(Counter(sc[:250])))
print("in-range 段 (idx 250..422) 分数分布:", dict(Counter(sc[250:])))
print("in-range 首根 idx=250 aggregate=", sc[250], "（=窗内相对相位 10）")
print("warmup 段内已有 Buy 分 75 的 bar 数:", sum(1 for i in range(250) if sc[i] == 75),
      " → 证明 ctx.index 含 warmup（否则相位于 250 重置、idx250 必为 75）")
print()
warm = [i for i in range(len(pb)) if pb[i]["warmup"]]
print("warmup 标记 bar 数:", len(warm), " idx 范围", warm[0], "..", warm[-1])
print("warmup 段内是否存在 orders/events:", any(pb[i]["orders"] or pb[i]["events"] for i in warm))
