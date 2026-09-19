#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Y2/Y5 全库扫描：把「成交事件流水」按 reason 分类，与 trades 数对照，
量化「有多少个对外可见的『已实现回合』其实只是期末强平的账面合成」。

输入：42_all_runs_fill_events.psv（run_id \x01 fill_events \x01 per_bar_ts_signal）
"""
import io
import json
from collections import Counter

def _open(path):
    import gzip, os
    if os.path.exists(path):
        return open(path)
    return io.TextIOWrapper(gzip.open(path + ".gz", "rb"))

E = "/home/eestock/workspace/git/eestock/eestock-rs/coder/evidence/20260918_sr_trades_system_side/raw/"

R = {}
for line in open(E + "31_all_runs_metrics_flat.txt"):
    p = line.rstrip("\n").split("|")
    R[p[0]] = dict(fmt=p[1], trade_count=int(p[2]), np=float(p[3]),
                   symbol=p[6], period=p[7], initcap=p[8])

tot = Counter()
rows_out = []
for line in _open(E + "42_all_runs_fill_events.psv"):
    p = line.rstrip("\n").split("\x01")
    rid, fills, pbs = p[0], json.loads(p[1]), json.loads(p[2])
    c = Counter()
    for f in fills:
        c[(f["side"], f["reason"])] += 1
    info = R.get(rid, {})
    tc = info.get("trade_count", -1)
    # 期末强平笔数（每 run 至多 1）
    fc = c[("Sell", "ForceClose")]
    sell_policy = c[("Sell", "Policy")]
    sell_stop = c[("Sell", "StopTrigger")]
    buy = c[("Buy", "Policy")] + c[("Buy", "StopTrigger")]
    rows_out.append((rid, info.get("symbol"), info.get("period"), tc,
                     buy, sell_policy, sell_stop, fc, len(fills)))
    tot["runs"] += 1
    tot["runs_with_trades"] += 1 if tc > 0 else 0
    tot["buy"] += buy
    tot["sell_policy"] += sell_policy
    tot["sell_stop"] += sell_stop
    tot["forceclose"] += fc
    tot["trades"] += max(tc, 0)
    tot["intents_bars"] += len([1 for x in pbs if x.get("signal")])

print("=== Y2 全库 reason 分类（374 legacy run）===")
print("run 总数 = %d，其中有 trades 的 = %d" % (tot["runs"], tot["runs_with_trades"]))
print("Buy( Policy/StopTrigger ) 成交笔数 = %d" % tot["buy"])
print("Sell Policy 成交笔数 = %d" % tot["sell_policy"])
print("Sell StopTrigger 成交笔数 = %d" % tot["sell_stop"])
print("Sell ForceClose 成交笔数 = %d" % tot["forceclose"])
print("trades（TradeDetail）总数 = %d" % tot["trades"])
print("→ 强平占 TradeDetail 比例 = %.1f%%" % (100.0 * tot["forceclose"] / max(tot["trades"], 1)))
print()

only_fc = [r for r in rows_out if r[3] > 0 and r[5] == 0 and r[6] == 0 and r[7] > 0]
print("「trade_count>0 但全程无任何 Sell 意图成交（Policy/StopTrigger 皆 0）」的 run 数 =", len(only_fc))
print("这些 run 的 trade_count 全部来自期末强平；例（run, symbol, period, trade_count, buy, sell_policy, sell_stop, forceclose, fills）：")
for r in only_fc[:10]:
    print("   ", r)
print()

print("=== 期末强平存在性统计 ===")
print("有 ForceClose 的 run 数 =", sum(1 for r in rows_out if r[7] > 0))
print("无 ForceClose（期末空仓）的 run 数 =", sum(1 for r in rows_out if r[7] == 0))
print()
print("=== 意图数 vs 成交数（末 bar 挂单静默丢弃的可观测面）===")
mism = [r for r in rows_out if r[4] + r[5] + r[6] + r[7] != r[8]]
print("fill 笔数 = %d，buy+3 类 sell 分解和 = %d" % (tot["buy"] + tot["sell_policy"] + tot["sell_stop"] + tot["forceclose"],
                                                    tot["buy"] + tot["sell_policy"] + tot["sell_stop"] + tot["forceclose"]))
print("（该行恒等，仅作自检）")

# 意图 vs 成交：per_bar 的 order 意图条数 vs fill 笔数
tot_intents = 0
tot_fills2 = 0
diff_runs = []
for line in _open(E + "33_all_runs_dump.psv"):
    p = line.rstrip("\n").split("\x01")
    try:
        orders = json.loads(p[10] or "[]")
    except Exception:
        continue
    ni = sum(len(o.get("orders") or []) for o in orders)
    nf = int(p[9] or 0)
    tot_intents += ni
    tot_fills2 += nf
    if ni != nf:
        diff_runs.append((p[0], ni, nf, ni - nf))
print("全库 per_bar order 意图条数 = %d；有成交的 bar 数 = %d；差 = %d（= 末 bar 挂单丢弃 + 部分挂单未成交）"
      % (tot_intents, tot_fills2, tot_intents - tot_fills2))
print("意图条数 ≠ 成交 bar 数的 run 数 = %d / 377" % len(diff_runs))
for x in diff_runs[:15]:
    print("   ", x)
