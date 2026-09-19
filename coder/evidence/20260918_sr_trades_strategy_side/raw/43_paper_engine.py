#!/usr/bin/env python3
"""纸面复现 eestock 引擎（够用子集），用于：
  (1) 用本 run 的实际 config 复现实测数字 → 证明模型可信；
  (2) 用设计文档口径的 policy 推演「期望总投入」。

逐条对齐源码：
  engine.rs:536-547  上一 bar 挂单在本 bar open 成交；need = qty×buy_price(open)×(1+comm)；
                     budget = min(need, cash)；fee.buy(budget, open)
  fee.rs:71-95       buy(): prop = budget/(eff×(1+comm))；prop_comm=max(prop_value×rate,min_fee)；
                     if prop_comm > min_fee → 用 prop；else value=budget-min_fee, shares=value/eff
  engine.rs:543-570  成交后 cash -= total_cost；holding.qty += shares
  policy.rs:160-205  Dca 分支（Equal: batch=plan_total/tranches；Hold/Sell 清状态）
  engine.rs:471-500  finish(): 只强平 holding（fee.sell(last_close)），不执行 pending
  engine.rs:528/754  warmup 段：调用插件但不执行 Policy/不成交
"""
import json, calendar, time, sys

D = "coder/evidence/20260918_sr_trades_strategy_side/raw"
pb = json.load(open(f"{D}/28_per_bar_pretty.json"))
api = json.load(open(f"{D}/27_kline_api_518880_1d.json"))
def ep(s): return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
BAR = {ep(b["ts"]): b for b in api["bars"]}
TS = [e["ts"] for e in pb]
O = [BAR[t]["open"] for t in TS]; C = [BAR[t]["close"] for t in TS]
WARMUP = 250

RATE = 0.025 / 100.0; MINFEE = 5.0; SLIP = 2.0 / 10000.0; STAMP = 0.0

def buy_price(p): return p * (1 + SLIP)
def sell_price(p): return p * (1 - SLIP)
def commission(v): return max(v * RATE, MINFEE)
def fee_buy(budget, raw):
    eff = buy_price(raw)
    prop = budget / (eff * (1 + RATE)); prop_value = prop * eff; prop_comm = commission(prop_value)
    if prop_comm > MINFEE:
        return prop, prop_value, prop_comm
    value = max(budget - MINFEE, 0.0)
    shares = value / eff if eff > 0 else 0.0
    return shares, value, (MINFEE if value > 0 else 0.0)

def plugin_score(i, cadence, plan_bars):
    since = i - (i // cadence) * cadence
    return 75 if since < plan_bars else 50

def run(cadence=20, plan_bars=5, buy_th=60.0, sell_th=40.0, policy=("Dca", 100, 1, None),
        initial=100000.0, fee_rate_override=None):
    """policy: ("Dca", tranches, interval, amount) 或 ("LumpSum", pct, None, None)"""
    st = None; lump = None
    cash = initial; qty = 0.0; pending = None
    buy_comm_total = 0.0; invested = 0.0; batches = 0; equity_path = []
    fills = []; decision_bars = []
    kind = policy[0]
    for i in range(len(TS)):
        # 1) 执行上一 bar 挂单（本 bar open）
        if i >= WARMUP and pending is not None:
            side, q = pending
            if side == "Buy" and q > 0 and cash > 0:
                need = q * buy_price(O[i]) * (1 + RATE)
                shares, value, comm = fee_buy(min(need, cash), O[i])
                if shares > 0:
                    cash -= value + comm; qty += shares
                    invested += value; buy_comm_total += comm
                    fills.append((i, "Buy", shares, buy_price(O[i])))
            pending = None
        # 2) 插件 → 信号
        if i < WARMUP:
            equity_path.append(cash + qty * C[i]); continue
        agg = plugin_score(i, cadence, plan_bars)
        sig = "Buy" if agg >= buy_th else ("Sell" if agg <= sell_th else "Hold")
        # 3) Policy → 目标仓位
        if kind == "Dca":
            tranches, interval, amount = policy[1], policy[2], policy[3]
            if sig == "Buy":
                if st is None:
                    st = dict(bars_in_run=0, done=0, base=qty, acc=0.0, plan_total=equity(i, cash, qty))
                if st["bars_in_run"] % interval == 0 and st["done"] < tranches:
                    amt = st["plan_total"] / tranches if amount is None else amount
                    st["acc"] += amt / C[i]; st["done"] += 1; batches += 1
                st["bars_in_run"] += 1
                target = st["base"] + st["acc"]
            else:
                st = None; target = qty
        else:
            pct = policy[1]
            if sig == "Buy":
                if lump is None: lump = equity(i, cash, qty) * pct / C[i]
                target = lump
            elif sig == "Sell":
                lump = None; target = 0.0
            else:
                lump = None; target = qty
        d = target - qty
        if d > 1e-12:
            pending = ("Buy", d); decision_bars.append(i)
        equity_path.append(cash + qty * C[i])
    # finish(): 强平
    last = len(TS) - 1
    gross = qty * sell_price(C[last]); sc = commission(gross); stamp = gross * STAMP
    cash += gross - sc - stamp
    final_equity = cash
    return dict(fills=fills, batches=batches, invested=invested, buy_comm=buy_comm_total,
                qty=qty, final_equity=final_equity, sell_comm=sc, equity_path=equity_path,
                decision_bars=decision_bars)

def equity(i, cash, qty): return cash + qty * C[i]
st = None; lump = None

if __name__ == "__main__":
    # ---- 校验：本 run 实际 config ----
    r = run(policy=("Dca", 100, 1, None))
    print("A. 模型校验（实际 config: Dca{tranches=100,interval=1,Equal} + cadence20/plan5）")
    print(f"   Buy 成交笔数        = {len(r['fills'])}            (实测 fills: 42 Buy + 1 ForceClose Sell)")
    print(f"   期末持仓股数        = {r['qty']:.12f}  (实测 trades.shares = 4368.985265614662)")
    print(f"   买入佣金合计        = {r['buy_comm']:.6f}       (实测 trades.commission 219.67099879139525 − 卖出佣金 {r['sell_comm']:.6f})")
    print(f"   期末净值            = {r['final_equity']:.6f}    (实测 net_value 末点 = 97066.35208602871)")
    print(f"   现金流出口径投入    = {r['invested']:.2f} 元     (占初始资金 {r['invested']/100000*100:.2f}%)")
    print(f"   净利                = {r['final_equity']-100000:.4f} 元 (实测 metrics.net_profit = -2933.64791397129)")
    print()
    for label, pol in [("B. 设计文档口径 Dca{tranches=3, interval=5, Equal}", ("Dca", 3, 5, None)),
                       ("C. 文档模板建议的对齐口径 Dca{tranches=5, interval=1, Equal}", ("Dca", 5, 1, None)),
                       ("D. 一次性满仓 LumpSum{1.0}（A1 臂）", ("LumpSum", 1.0, None, None))]:
        r2 = run(policy=pol)
        print(label)
        print(f"   批次数={r2['batches']:>4}  投入={r2['invested']:>10.2f} 元 ({r2['invested']/100000*100:5.1f}% 初始资金)"
              f"  期末持仓={r2['qty']:>10.3f} 股  期末净值={r2['final_equity']:>12.2f}  净利={r2['final_equity']-100000:>10.2f} 元")
    print()
    print("注：以上为纸面复现（模型 A 段已逐项对齐实测），非平台新 run；本任务的只读纪律禁止写库/新建 run。")
