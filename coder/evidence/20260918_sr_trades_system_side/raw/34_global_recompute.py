#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Y5 全库自洽扫描：对全部 377 个 run，用「结果块」（net_value / trades / per_bar 事件）
独立重算 8 项指标，与 strategy_run_result.metrics 逐字段比对。
判定口径完全按 crates/backtest/src/metrics.rs（file:line 见 README）。

输入：33_all_runs_dump.psv（psql 以 U+0001 分隔导出，见 commands.sh）
输出：stdout
"""
import io
import json
import math
import sys

def _open(path):
    import gzip, os
    if os.path.exists(path):
        return open(path)
    return io.TextIOWrapper(gzip.open(path + ".gz", "rb"))

E = "/home/eestock/workspace/git/eestock/eestock-rs/coder/evidence/20260918_sr_trades_system_side/raw/"
BPY = {  # crates/backtest/src/types.rs:66-78
    "M1": 252.0 * 240.0, "M5": 252.0 * 48.0, "M15": 252.0 * 16.0,
    "M30": 252.0 * 8.0, "H1": 252.0 * 4.0, "D1": 252.0,
}


def maxdd(eq):
    peak, m = -math.inf, 0.0
    for e in eq:
        peak = max(peak, e)
        if peak > 0:
            m = max(m, (peak - e) / peak)
    return m


def sharpe(eq, bpy):
    r = [(eq[i + 1] - eq[i]) / eq[i] for i in range(len(eq) - 1)]
    if not r:
        return 0.0, 0.0, 0.0
    mr = sum(r) / len(r)
    if len(r) > 1:
        sd = math.sqrt(sum((x - mr) ** 2 for x in r) / (len(r) - 1))
    else:
        sd = 0.0
    return ((mr - 0.0) / sd * math.sqrt(bpy) if sd > 0 else 0.0), mr, sd


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

FIELD_ORDER = ["net_profit", "max_drawdown", "sharpe", "win_rate", "profit_factor",
               "annualized_return", "trade_count", "avg_hold_bars"]
worst = {k: (0.0, None) for k in FIELD_ORDER}
mismatch_rows = []
ledger_checks = []
two_way = []

for r in rows:
    rep = json.loads(r["metrics"])
    nv = json.loads(r["net_value"]) if r["net_value"] not in ("", r"\N", "null") else []
    if r["fmt"] == "chunked_v1" and not nv:
        continue          # 分块 run 的净值在 strategy_run_bars，本 dump 不含（3 个，单列处理）
    tr = json.loads(r["trades"]) if r["trades"] not in ("", r"\N", "null") else []
    if not nv:
        continue
    eq = [float(x[1]) for x in nv]
    initcap = float(r["initcap"])
    bpy = BPY[r["period"]]
    n = len(eq)
    wins = [t["pnl"] for t in tr if t["pnl"] > 0]
    losses = [-t["pnl"] for t in tr if t["pnl"] < 0]
    avg_p = sum(wins) / len(wins) if wins else 0.0
    avg_l = sum(losses) / len(losses) if losses else 0.0
    mine = {
        "net_profit": eq[-1] - initcap,
        "max_drawdown": maxdd(eq),
        "sharpe": sharpe(eq, bpy)[0],
        "win_rate": (len(wins) / len(tr)) if tr else 0.0,
        "profit_factor": (avg_p / avg_l if avg_l > 0 else (math.inf if avg_p > 0 else 0.0)),
        "annualized_return": (eq[-1] / initcap) ** (bpy / n) - 1.0 if n > 0 else 0.0,
        "trade_count": len(tr),
        "avg_hold_bars": (sum(t["hold_bars"] for t in tr) / len(tr)) if tr else 0.0,
    }
    for k in FIELD_ORDER:
        a, b = mine[k], rep[k]
        if k == "profit_factor" and (a == math.inf or b == math.inf):
            d = 0.0 if a == b else math.inf
        else:
            d = abs(a - b)
        if d > worst[k][0]:
            worst[k] = (d, r["run_id"])
        if d > 1e-6:
            mismatch_rows.append((r["run_id"], k, a, b, d))
    # 双向场景清单
    n_ord = int(r["n_orders"] or 0)
    if len(tr) > 1:
        two_way.append((r["run_id"], r["symbol"], r["period"], len(tr), n_ord,
                        int(r["n_fill_events"] or 0)))

print("=" * 100)
print("[Y5-③] 全库独立重算 vs metrics 逐字段最大绝对差（377 run，跳过 3 个 chunked 的净值不在 dump）")
print("%-20s %-24s %s" % ("field", "max |delta|", "worst run"))
for k in FIELD_ORDER:
    v, rid = worst[k]
    print("%-20s %-24.3e %s" % (k, v, rid))
print("超容差(>1e-6)不一致条数 =", len(mismatch_rows))
for m in mismatch_rows[:40]:
    print("   ", m)

print()
print("[Y5-①] 多回合（trade_count>1）run 数量 =", len(two_way))
print("前 20 例（run_id, symbol, period, trades, per_bar orders, per_bar fill events）：")
for t in two_way[:20]:
    print("   ", t)
