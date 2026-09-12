#!/usr/bin/env python3
"""统计 09_perf_min5_20runs.txt 的比值分布（余量 = 阈值 0.6 / 最坏比值）。"""
import re, statistics, sys
p = sys.argv[1] if len(sys.argv) > 1 else 'coder/evidence/151_debt_cleanup/09_perf_min5_20runs.txt'
txt = open(p, encoding='utf-8').read()
rows = re.findall(r'run (\d+): (PASS|FAIL) \| 目标 min5=(\d+)ms vs 修复前路径 min5=(\d+)ms（比值 ([0-9.]+)', txt)
ratios = [float(r[4]) for r in rows]
print(len(rows), 'runs; ratio min/max/mean =', min(ratios), max(ratios), statistics.mean(ratios))
print('margin =', 0.6 / max(ratios))
