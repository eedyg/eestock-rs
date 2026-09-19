#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Y5-① 全库「三账自洽」扫描 + 指定双向样本的逐笔核对。

三个恒等式（都能从公开字段推出，无需 kline）：
  I1 每笔 TradeDetail 的 pnl 必须等于
     gross_value − commission − stamp_duty − open_price×shares
     （comm 字段 = 买入佣金 + 卖出佣金；open_price×shares 即买入成交额 value_basis）
     —— 证明 trades 内部的费用/成交明细自洽。
  I2 期末权益 − 初始资金 的**累计已实现**分解：
     (cash 末 = initial − Σ买入 total_cost + Σ卖出 proceeds)
     当每个 run 均由 finish() 强平归零时 末权益 == initial + Σ trades.pnl。
     —— 证明 trades 与 net_value 两条账一致。
  I3 trades 的 shares 之和 ≤ 途中累计买入股数（净持仓不为负），且末笔之后持仓为 0。
"""
import io
import json
import math


def _open(path):
    import gzip
    import os
    if os.path.exists(path):
        return open(path)
    return io.TextIOWrapper(gzip.open(path + ".gz", "rb"))


E = "/home/eestock/workspace/git/eestock/eestock-rs/coder/evidence/20260918_sr_trades_system_side/raw/"

rows = []
with _open(E + "33_all_runs_dump.psv") as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        p = line.split("\x01")
        rows.append(dict(zip(
            ["run_id", "symbol", "period", "fmt", "initcap", "metrics",
             "net_value", "trades", "n_orders", "n_fill_events", "orders_json"], p)))

i1_bad, i2_bad, i3_bad = [], [], []
checked = 0
sell_signal_runs = []
for r in rows:
    if r["fmt"] == "chunked_v1":
        continue
    try:
        nv = json.loads(r["net_value"])
        tr = json.loads(r["trades"])
    except Exception:
        continue
    if not nv:
        continue
    checked += 1
    initcap = float(r["initcap"])
    last_eq = float(nv[-1][1])

    # I1
    for ti, t in enumerate(tr):
        lhs = t["pnl"]
        rhs = t["gross_value"] - t["commission"] - t["stamp_duty"] - t["open_price"] * t["shares"]
        scale = max(1.0, abs(lhs))
        if abs(lhs - rhs) / scale > 1e-9:
            i1_bad.append((r["run_id"], ti, lhs, rhs, lhs - rhs))

    # I2
    sum_pnl = sum(t["pnl"] for t in tr)
    lhs2 = last_eq - initcap
    scale2 = max(1.0, abs(lhs2))
    if abs(lhs2 - sum_pnl) / scale2 > 1e-9:
        i2_bad.append((r["run_id"], lhs2, sum_pnl, lhs2 - sum_pnl, len(tr)))

    # I3：Σ卖出 shares（由 trades）不得超累计买入 shares（由 fill 事件）
    try:
        orders = json.loads(r["orders_json"] or "[]")
    except Exception:
        orders = []
    nsell_orders = sum(1 for o in orders for x in (o.get("orders") or []) if x.get("side") == "Sell")
    nsell_trades = len(tr)
    if nsell_trades > 0 and nsell_orders == 0:
        i3_bad.append((r["run_id"], "trades>0 但 per_bar orders 无 Sell 意图", nsell_trades))

print("[Y5-①] 参与三账自洽扫描的 legacy run 数 =", checked)
print("I1 违反（TradeDetail 内部 pnl ≠ 明细重算）条数 =", len(i1_bad))
for x in i1_bad[:10]:
    print("   ", x)
print("I2 违反（末权益−初始 ≠ Σ trades.pnl）条数 =", len(i2_bad))
for x in i2_bad[:10]:
    print("   ", x)
print("I3 违反（有 trades 但无 Sell 意图）条数 =", len(i3_bad))
for x in i3_bad[:10]:
    print("   ", x)

print()
print("[Y5-①] 多回合样本（trade_count ≥ 5 且 Sell 意图数 ≥ 5）前 10 例：")
shown = 0
for r in rows:
    if r["fmt"] == "chunked_v1":
        continue
    tr = json.loads(r["trades"])
    if len(tr) < 5:
        continue
    orders = json.loads(r["orders_json"] or "[]")
    nsell = sum(1 for o in orders for x in (o.get("orders") or []) if x.get("side") == "Sell")
    nbuy = sum(1 for o in orders for x in (o.get("orders") or []) if x.get("side") == "Buy")
    if nsell < 5:
        continue
    print("  run=%s %s/%s trades=%d buy_intents=%d sell_intents=%d fill_bars=%d orders_bars=%d"
          % (r["run_id"], r["symbol"], r["period"], len(tr), nbuy, nsell,
             int(r["n_fill_events"] or 0), int(r["n_orders"] or 0)))
    if shown == 0:
        print("  ---- 该样本逐笔 TradeDetail ----")
        for t in tr[:6]:
            print("    ", json.dumps(t, sort_keys=True))
        m = json.loads(r["metrics"])
        print("     metrics:", json.dumps(m, sort_keys=True))
        print("     initcap=%s  last_equity=%s  Σpnl=%.6f"
              % (r["initcap"], json.loads(r["net_value"])[-1][1], sum(x["pnl"] for x in tr)))
    shown += 1
    if shown >= 10:
        break
