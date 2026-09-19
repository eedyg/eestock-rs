#!/usr/bin/env python3
"""S2② 每窗 batch_amount 精确反算：
每个 Buy-run 首根决策 bar 的 Policy 挂单 qty（= batch_amount/决策close）× 决策 close = batch_amount，
再 ×tranches 得 implied plan_total（Equal 口径）。
输入：raw/28_per_bar_pretty.json（决策序列与挂单）+ raw/27_kline_api_518880_1d.json（close）。"""
import json, calendar, time, statistics
from datetime import datetime, timezone
D = "coder/evidence/20260918_sr_trades_strategy_side/raw"
pb = json.load(open(f"{D}/28_per_bar_pretty.json"))
api = json.load(open(f"{D}/27_kline_api_518880_1d.json"))
def ep(s): return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
K = {ep(b["ts"]): b for b in api["bars"]}
print("窗口起点 idx → 该窗首笔 Policy 挂单 qty × 决策 close = batch_amount（Equal: plan_total/tranches）")
print(f"{'idx':>4} {'date':<12} {'order_qty':>14} {'dec_close':>9} {'batch_amt':>10} {'implied_plan_total':>20}")
for i in range(250, 423):
    e = pb[i]
    if i > 250 and pb[i - 1]["signal"] == "Buy":
        continue
    if e["signal"] != "Buy":
        continue
    o = [x for x in e["orders"] if x.get("reason") == "Policy"]
    if not o:
        continue
    q = o[0]["qty"]; c = K[e["ts"]]["close"]
    print(f"{i:>4} {datetime.fromtimestamp(e['ts'], timezone.utc).strftime('%Y-%m-%d'):<12} "
          f"{q:>14.6f} {c:>9.4f} {q * c:>10.4f} {q * c * 100:>20.2f}")
print()
print("首窗逐批（窗 1 的 plan_total 必为 100000 = 全现金 ⇒ batch 必为 1000.000）：")
for i in range(260, 266):
    e = pb[i]; o = [x for x in e["orders"] if x.get("reason") == "Policy"]; c = K[e["ts"]]["close"]
    print(f"  idx {i} close {c:.4f} order_qty {o[0]['qty']:.6f} → batch {o[0]['qty'] * c:.4f}" if o
          else f"  idx {i} close {c:.4f} (无挂单: signal={e['signal']})")
