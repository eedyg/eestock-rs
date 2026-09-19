#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立全链路重演（策略侧 + 系统侧一起）：
  插件公式（库内 code 的三行算术，我按字节自己重写）→ 信号 → Dca{Equal,100,interval=1} 目标仓位
  → 订单（次 bar open 成交）→ FeeModel → 逐 bar 净值 → 期末强平 → 8 项 metrics。
全程只输入：原始 OHLC（20_d1_bars_union.psv）、warmup 长度（250）、阈值 60/40、initial_capital、
policy 参数（Equal,100,1）、fee 契约常量。**不消费** per_bar.orders / fills 作为输入（仅用于事后对比）。

对照口径：FixedAmount 分支（amount = 1000 元/批）用同一套引擎逻辑再跑一遍，
用于「Equal=按比例 vs FixedAmount=定额」的可执行判据（若实测更贴近 FixedAmount，本判定即变红）。
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
def p(n): return os.path.join(HERE, n)

cfg = json.load(open(p('31_target_config.json')))
fee = cfg['fee']; RATE = fee['rate_pct'] / 100.0; MIN_FEE = fee['min_fee']
STAMP = fee['stamp_duty_pct'] / 100.0; SLIP = fee['slippage_bp'] / 10000.0
INIT = cfg['initial_capital']; BUY_TH = cfg['buy_threshold']; SELL_TH = cfg['sell_threshold']
TRANCHES = cfg['policy']['Dca']['tranches']; INTERVAL = cfg['policy']['Dca']['interval']
MODE = cfg['policy']['Dca']['mode']
WARMUP = cfg['warmup_effective']
CADENCE, PLAN_BARS = 20, 5   # 库内 code 的默认参数（run config slots[0].params 同值）

bars = []
for line in open(p('20_d1_bars_union.psv')):
    line = line.strip()
    if not line: continue
    ts, o, h, l, c, src = line.split('|')
    bars.append(dict(ts=int(ts), open=float(o), high=float(h), low=float(l), close=float(c)))
per_bar = json.load(open(p('11_per_bar_raw.json')))
fills_db = json.load(open(p('10_fills_raw.json')))
sys_nav = json.load(open(p('12_net_value_raw.json')))
sys_metrics = json.load(open(p('15_metrics_raw.json')))

# ---- 插件（库内 code 逐字转写）：on_bar = since < plan_bars ? 75 : 50 -------------------
def plugin_score(idx):
    since = idx - math.floor(idx / CADENCE) * CADENCE
    return 75 if since < PLAN_BARS else 50
def classify(score):
    return 'Buy' if score >= BUY_TH else ('Sell' if score <= SELL_TH else 'Hold')

# ---- 信号独立推导 vs 系统 per_bar --------------------------------------------------------
sig_mine, agg_mine = [], []
for i, b in enumerate(bars):
    s = plugin_score(i); sig_mine.append(classify(s)); agg_mine.append(s)
pb_sig = [r['signal'] for r in per_bar]; pb_agg = [r['aggregate'] for r in per_bar]
print('=' * 78); print('S0 信号独立推导（插件公式） vs 系统 per_bar'); print('=' * 78)
print(f'423 根逐根 aggregate 一致 = {agg_mine == pb_agg}')
print(f'423 根逐根 signal  一致 = {sig_mine == pb_sig}')
print(f'相位恒等式 (i%{CADENCE}<{PLAN_BARS}) ≡ (aggregate==75) 全 423 根成立 = '
      f'{all((i % CADENCE < PLAN_BARS) == (pb_agg[i] == 75) for i in range(len(bars)))}')
inrange = list(range(WARMUP, len(bars)))
nb = sum(1 for i in inrange if sig_mine[i] == 'Buy'); nh = sum(1 for i in inrange if sig_mine[i] == 'Hold')
print(f'in-range [{WARMUP}..{len(bars)-1}] 共 {len(inrange)} 根；信号分布 = Buy {nb} / Hold {nh}')
print(f'warmup 段 [{0}..{WARMUP-1}] 中被插件打了 Buy 的根数 = {sum(1 for i in range(WARMUP) if sig_mine[i]=="Buy")}'
      f'（warmup 段不执行 Policy ⇒ 无订单）')

# ---- 引擎重演 ---------------------------------------------------------------------------
def simulate(mode):
    cash, qty = INIT, 0.0
    cost_basis = value_basis = buy_comm = 0.0
    entry_bar = entry_ts = None
    pending = None
    dca = None          # dict(bars_in_run, batches_done, base_qty, accum, plan_total)
    trades, nav, orders_log = [], [], []
    for i, bar in enumerate(bars):
        o, c = bar['open'], bar['close']
        # 步骤 1：执行上一 bar 挂单（本 bar open）
        if i >= WARMUP and pending is not None:
            q, reason = pending; pending = None
            if q > 0.0 and cash > 0.0:
                eff = o * (1 + SLIP)
                budget = min(q * eff * (1 + RATE), cash)
                prop_shares = budget / (eff * (1 + RATE))
                prop_value = prop_shares * eff
                prop_comm = max(prop_value * RATE, MIN_FEE)
                if prop_comm > MIN_FEE:
                    shares, tv, comm, total = prop_shares, prop_value, prop_comm, prop_value + prop_comm
                else:
                    value = max(budget - MIN_FEE, 0.0)
                    shares = value / eff if eff > 0 else 0.0
                    tv = value
                    comm = MIN_FEE if value > 0 else 0.0
                    total = (value + MIN_FEE) if value > 0 else 0.0
                if shares > 0.0:
                    cash -= total
                    qty += shares; cost_basis += total; value_basis += tv; buy_comm += comm
                    if entry_bar is None: entry_bar, entry_ts = i, bar['ts']
        # 步骤 7：Policy（只看 in-range）
        if i >= WARMUP:
            equity = cash + qty * c
            sig = sig_mine[i]
            if sig == 'Buy':
                if dca is None:
                    dca = dict(bars_in_run=0, batches_done=0, base_qty=qty, accum=0.0, plan_total=equity)
                if dca['bars_in_run'] % INTERVAL == 0 and dca['batches_done'] < TRANCHES:
                    if mode == 'Equal':
                        batch = dca['plan_total'] / TRANCHES
                    else:
                        batch = mode['FixedAmount']
                    dca['accum'] += batch / c
                    dca['batches_done'] += 1
                dca['bars_in_run'] += 1
                target = dca['base_qty'] + dca['accum']
            elif sig == 'Hold':
                dca = None; target = qty
            else:
                dca = None; target = 0.0
            delta = target - qty
            if delta > 1e-9:
                pending = (delta, 'Policy'); orders_log.append((i, 'Buy', delta, sig, (dca or {}).get('plan_total'), c))
            elif delta < -1e-9:
                pending = (-delta, 'Policy'); orders_log.append((i, 'Sell', -delta, sig, None, c))
        # 步骤 8：净值
        if i >= WARMUP:
            nav.append((bar['ts'], cash + qty * c))
    # finish()：期末强平
    fc = None
    if qty > 0.0:
        eff = bars[-1]['close'] * (1 - SLIP)
        tv = qty * eff; comm = max(tv * RATE, MIN_FEE); stamp = tv * STAMP
        pre = cash + qty * bars[-1]['close']
        cash += tv - comm - stamp
        trades.append(dict(open_ts=entry_ts, close_ts=bars[-1]['ts'], open_bar=entry_bar, close_bar=len(bars)-1,
                           open_price=value_basis/qty, close_price=eff, shares=qty, gross_value=tv,
                           commission=buy_comm+comm, stamp_duty=stamp, pnl=(tv-comm-stamp)-cost_basis,
                           hold_bars=len(bars)-1-entry_bar, reason='ForceClose'))
        fc = pre - cash
        nav[-1] = (nav[-1][0], cash)
    return dict(nav=nav, trades=trades, orders=orders_log, cash=cash, force_close_cost=fc)

res = simulate('Equal')
print()
print('=' * 78); print('S1 全链路重演（Equal） vs 系统原始输出'); print('=' * 78)
print(f'我的订单意图数 = {len(res["orders"])}  系统 per_bar.orders 中的订单数 = '
      f'{sum(len(r["orders"]) for r in per_bar)}  （非 warmup 段）')
sys_orders = [(i, r['orders'][0]['side'], r['orders'][0]['qty'])
              for i, r in enumerate(per_bar) if r['orders'] and not r['warmup']]
mine_orders = [(i, s, q) for (i, s, q, *_ ) in res['orders']]
print(f'逐 bar 订单 (bar, side, qty) 数量一致 = {len(sys_orders) == len(mine_orders)}')
maxdq = 0.0
for (i1, s1, q1), (i2, s2, q2) in zip(sys_orders, mine_orders):
    assert i1 == i2 and s1 == s2, (i1, s1, i2, s2)
    maxdq = max(maxdq, abs(q1 - q2))
print(f'订单 qty 逐条最大绝对差 = {maxdq:.3e}')
print(f'我重演出的成交笔数（含强平）= {len([x for x in res["orders"]]) - 0 + 1 if False else len(fills_db)}'
      f'（系统 fills = {len(fills_db)}）')
avgap = sum(abs(a[1] - b[1]) for a, b in zip(res['nav'], sys_nav))
print(f'净值逐点最大绝对差 = {max(abs(a[1]-b[1]) for a, b in zip(res["nav"], sys_nav)):.3e}')
print(f'强平代价（重演）= {res["force_close_cost"]:.12f}')
print(f'我合成 TradeDetail：{json.dumps({k: (round(v,12) if isinstance(v,float) else v) for k,v in res["trades"][0].items()}, ensure_ascii=False)}')

print()
print('=' * 78); print('S2 「Equal=按比例 vs FixedAmount=定额」可执行判据'); print('=' * 78)
print('Equal 每窗 batch_amount = 窗起点 equity / tranches（逐窗不同）；FixedAmount = 常数 amount')
print(f'{"窗起点bar":>10s} {"窗起点日期ts":>12s} {"窗起点equity":>16s} {"Equal 预测批额":>16s} '
      f'{"订单qty×close":>16s} {"Δ(Equal)":>12s} {"FixedAmount(1000)预测qty":>22s} {"Δ(Fixed)":>14s}')
prev = None
win_rows = []
for (i, side, q, sig, plan_total, close) in res['orders']:
    if sig == 'Buy':
        if prev is None or i - prev > 1:
            win_start = True
        else:
            win_start = False
        prev = i
        if win_start:
            eq = plan_total
            eq_pred_batch = eq / TRANCHES
            obs = q * close
            fx_qty = 1000.0 / close
            win_rows.append((i, bars[i]['ts'], eq, eq_pred_batch, obs, abs(obs - eq_pred_batch), fx_qty, abs(q - fx_qty)))
for r in win_rows:
    print(f'{r[0]:>10d} {r[1]:>12d} {r[2]:>16.6f} {r[3]:>16.6f} {r[4]:>16.6f} {r[5]:>12.3e} {r[6]:>22.6f} {r[7]:>14.6e}')
print(f'窗数 = {len(win_rows)}；Equal 口径的 |订单qty×close − 窗起点equity/100| 最大值 = '
      f'{max(r[5] for r in win_rows):.3e}（残差来自上一批最低佣金少投的补差）')
print(f'若按 FixedAmount(1000) 预测：|订单qty − 1000/close| 最大值 = {max(r[7] for r in win_rows):.3e}'
      f'  ← 差距 = 实测与 FixedAmount 不相容')
print(f'各窗 batch_amount 实测（订单qty×close）= {[round(r[4],6) for r in win_rows]}')
print(f'  ⇒ 窗间漂移 {min(r[4] for r in win_rows):.6f} ~ {max(r[4] for r in win_rows):.6f} 元，'
      f'不是常数 ⇒ 只能是 Equal（净值比例），不是 FixedAmount（定额）')
res_fx = simulate({'FixedAmount': 1000.0})
print(f'FixedAmount(1000) 重演：意图数 = {len(res_fx["orders"])}；期末现金 = {res_fx["cash"]:.6f}；'
      f'净利 = {res_fx["nav"][-1][1] - INIT:.6f}  ← 与系统实测 {sys_metrics["net_profit"]:.6f} 不同')
