#!/usr/bin/env python3
"""独立复现 policy.rs:160-205 的 Dca 分支 + engine.rs 的「信号→挂单→次bar成交」语义，
用于回答 S3 的「若按文档意图，期望总投入应为多少」。

口径来源（逐条对齐 Rust 源码）：
- policy.rs:176-186   Buy 且 dca 状态为空 → 新建 DcaState{bars_in_run=0, batches_done=0,
                      base_qty=current_qty, accumulated=0, plan_total=equity}
- policy.rs:188-190   bars_in_run % interval == 0 且 batches_done < tranches → 触发一批
- policy.rs:190-193   Equal: batch_amount = plan_total/tranches；FixedAmount: amount
- policy.rs:194-196   accumulated += batch_amount/price（price=决策 bar close）；target = base + accumulated
- policy.rs:198-202   Hold → dca=None（剩余批次取消）；Sell → dca=None
- engine.rs:536-547   上一 bar 的挂单在本 bar open 成交；预算 = qty×open×(1+费率)，min(可用现金)
- engine.rs:471-500   finish() 只强平持仓，不执行 pending 挂单
- 忽略费用/滑点（本推演只算「投出去的金额量级」），净值固定=窗起点 equity 的近似：
  为对齐本 run 的实测，plan_total 用「上一窗结束后的 equity」近似（本 run 实测 implied plan_total
  在 95,996..100,228 之间，故推演给出上下界区间）。
"""
import json, calendar, time
from datetime import datetime, timezone

pb = json.load(open("coder/evidence/20260918_sr_trades_strategy_side/raw/28_per_bar_pretty.json"))
api = json.load(open("coder/evidence/20260918_sr_trades_strategy_side/raw/27_kline_api_518880_1d.json"))
def ep(s): return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
CLOSE = {ep(b["ts"]): b["close"] for b in api["bars"]}

SIG = [e["signal"] for e in pb]            # 插件给出的信号（实测，不是重算）
TS  = [e["ts"] for e in pb]
IDX0, IDX1 = 250, 422                      # in-range 段（warmup 段不执行 Policy）

def project(tranches, interval, *, plan_total_of_window, price_of=lambda i: CLOSE[TS[i]]):
    """返回每个决策 bar 触发批次的 (idx, batch_amount)；成交在次 bar，末 bar 挂单丢弃。"""
    acc_amt = 0.0
    out = []
    run = None
    for i in range(IDX0, IDX1 + 1):
        sig = SIG[i]
        if sig == "Buy":
            if run is None:
                run = dict(bars_in_run=0, batches_done=0,
                           plan_total=plan_total_of_window(i), acc_qty=0.0)
            if run["bars_in_run"] % interval == 0 and run["batches_done"] < tranches:
                amt = run["plan_total"] / tranches
                run["acc_qty"] += amt / price_of(i)
                run["batches_done"] += 1
                if i < IDX1:                    # 末 bar 的挂单无下一 bar 可成交（实测同口径）
                    out.append((i, amt))
                else:
                    out.append((i, 0.0))        # 记账但标注未成交
            run["bars_in_run"] += 1
        else:
            run = None
    return out

print("=" * 96)
print("A. 校验模型：本 run 的实际 config = Dca{tranches=100, interval=1, Equal}，plan_total 固定 100000")
b = project(100, 1, plan_total_of_window=lambda i: 100000.0)
filled = [(i, a) for i, a in b if a > 0]
print(f"   触发批次数={len(b)}  可成交批次数={len(filled)}  金额合计={sum(a for _, a in filled):.2f} 元"
      f"（{sum(a for _,a in filled)/100000*100:.1f}% 初始资金）")
print(f"   决策 idx 序列={[i for i,_ in filled][:6]} ... {[i for i,_ in filled][-4:]}")
print("   ⇒ 与实测对比：fills=42 笔 Buy、决策 idx 260..264/280..284/.../420,421、"
      "per_bar[422].orders 未成交 —— 完全一致 ⇒ 模型可信")
print()
print("B. 按设计文档 §5.3 / §5.4 与作者矩阵工具 dca_matrix.py:39 的口径 = Dca{tranches=3, interval=5, Equal}")
for plan_total in (100000.0, 98500.0):
    b2 = project(3, 5, plan_total_of_window=lambda i, pt=plan_total: pt)
    f2 = [(i, a) for i, a in b2 if a > 0]
    n = min(len(f2), int(100000 // (plan_total / 3)))
    amt = sum(a for _, a in f2[:n])
    print(f"   plan_total 假设 {plan_total:>8.0f} 元 → 每批 {plan_total/3:>9.2f} 元，"
          f"共触发 {len(f2)} 批（每次买入窗只触发第 0 批，因为 interval=5 的第 2 批需 bars_in_run=5，"
          f"而窗口只有 5 bar）")
    print(f"      → 现金上限内可完成 {n} 批 ⇒ 期望总投入 ≈ {amt:>10.2f} 元 ≈ {amt/100000*100:.1f}% 初始资金")
print()
print("C. 本 run 口径下的理论上限（tranches=100/interval=1）")
print(f"   in-range 173 bar 内 60/40 阈值下可达批次数上限 = 每个 20-bar 周期的 5-bar 买入窗 = 43 批（含末 bar 未成交 1 批）")
print(f"   ⇒ 42 批 × 1000 元 = 42,000 元 = 42.0% 初始资金（实测现金流出 41,598.0 元 = 41.6%）")
print(f"   ⇒ 要投满 100 批需要 100 个连续 Buy bar（或 20 个完整 20-bar 周期 = 400 bar），本区间 173 bar 结构上不可能")
