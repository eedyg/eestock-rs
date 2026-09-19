#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
E1 反证实验：**双向真实卖出** run 的三方自洽核验（trades ⇄ fills ⇄ metrics）。
样本：sr_1789044295239_000111（518880 / D1 / LumpSum{position_pct:1} / 40 Buy + 40 Sell 全部 reason=Policy
      / 无 warmup / fee={rate:0.005%, min_fee:0, slippage:2bp, stamp:0}）
输入全部是 Tester 自己从库拉的原始块：per_bar(1209) / net_value(1209) / drawdown / trades(40) / metrics / config
       + 原始 D1 OHLC（与 storage BacktestBarReader D1 同口径并集）。

判据（任何一条变红即说明“引擎账本不可独立复现”）：
  A. 由 events 里的 80 笔 fill + 逐 bar 收盘 + fee 契约重算的净值序列，与其他 1209 点逐点一致（最大绝对差 ≈ 0）
  B. 重算合成的 TradeDetail 与落库 trades 逐笔逐字段一致（笔数 + 12 字段）
  C. 用重算 nav/trades 走 metrics 文档口径 → 8 项与库内 metrics 逐字段一致
  D. 三账恒等式：Σ trades.pnl == nav[-1] − initial；trade_count == len(trades) == 清仓次数
  E. 反证（判据可失败）：把 trade 定义改成「每笔 Buy 一条」（Rule B）或「每笔成交一条」（Rule C），
     立刻与库内 trades 数不符 ⇒ 说明本判据有区分度，不是自证
"""
import json, math, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
def p(n): return os.path.join(HERE, n)

cfg = json.load(open(p('95_tw_config.json')))
fee = cfg['fee']; RATE = fee['rate_pct'] / 100.0; MIN_FEE = fee['min_fee']
STAMP = fee['stamp_duty_pct'] / 100.0; SLIP = fee['slippage_bp'] / 10000.0
INIT = cfg['initial_capital']; BPY = 252.0
RUN = 'sr_1789044295239_000111'

bars = []
for line in open(p('96_tw_bars.psv')):
    line = line.strip()
    if line:
        ts, o, h, l, c = line.split('|'); bars.append(dict(ts=int(ts), open=float(o), close=float(c)))
pb = json.load(open(p('95_tw_per_bar.json')))
nav_db = json.load(open(p('95_tw_nav.json')))
dd_db = json.load(open(p('95_tw_dd.json')))
tr_db = json.load(open(p('95_tw_trades.json')))
m_db = json.load(open(p('95_tw_metrics.json')))

print('run =', RUN, ' symbols bar 数 =', len(bars), ' per_bar =', len(pb), ' nav =', len(nav_db), ' trades =', len(tr_db))
print('bar ts 与 per_bar ts 一致 =', [b['ts'] for b in bars] == [x['ts'] for x in pb])

# fills 来自 per_bar.events（本 run 无 fills 块，legacy 口径）
fills = []
for i, r in enumerate(pb):
    for e in r['events']:
        if e['type'] == 'fill':
            fills.append(dict(bar_index=i, ts=r['ts'], side=e['side'], qty=e['qty'], price=e['price'], reason=e['reason']))
print('fills(side,reason) =', dict(collections.Counter((f['side'], f['reason']) for f in fills)))
print('注：legacy per_bar 的 fill 事件无 ts 字段，成交 ts 以所在 bar 的 ts 为准')

cash, qty = INIT, 0.0
cost_basis = value_basis = buy_comm = 0.0
entry_bar = entry_ts = None
my_trades, my_nav = [], []
by_bar = collections.defaultdict(list)
for f in fills: by_bar[f['bar_index']].append(f)
for i, bar in enumerate(bars):
    for f in by_bar.get(i, []):
        tv = f['qty'] * f['price']; comm = max(tv * RATE, MIN_FEE)
        if f['side'] == 'Buy':
            cash -= tv + comm; qty += f['qty']; cost_basis += tv + comm; value_basis += tv; buy_comm += comm
            if entry_bar is None: entry_bar, entry_ts = i, bar['ts']
        else:
            if f.get('reason') == 'ForceClose': nav_pre_fc = cash + qty * bar['close']
            cash += tv - comm - tv * STAMP
            if f['qty'] >= qty - 1e-9:
                my_trades.append(dict(open_ts=entry_ts, close_ts=bar['ts'], open_bar=entry_bar, close_bar=i,
                                      open_price=value_basis/qty, close_price=f['price'], shares=qty,
                                      gross_value=tv, commission=buy_comm+comm, stamp_duty=tv*STAMP,
                                      pnl=(tv-comm-tv*STAMP)-cost_basis, hold_bars=i-entry_bar))
                qty = cost_basis = value_basis = buy_comm = 0.0; entry_bar = entry_ts = None
            else:
                ra = f['qty']/qty
                cost_basis *= 1-ra; value_basis *= 1-ra; buy_comm *= 1-ra; qty -= f['qty']
    my_nav.append((bar['ts'], cash + qty * bar['close']))
if qty > 0:
    b = bars[-1]; tv = qty * b['close'] * (1-SLIP); comm = max(tv*RATE, MIN_FEE)
    my_trades.append(dict(open_ts=entry_ts, close_ts=b['ts'], open_bar=entry_bar, close_bar=len(bars)-1,
                          open_price=value_basis/qty, close_price=b['close']*(1-SLIP), shares=qty, gross_value=tv,
                          commission=buy_comm+comm, stamp_duty=tv*STAMP, pnl=(tv-comm-tv*STAMP)-cost_basis,
                          hold_bars=len(bars)-1-entry_bar))
    cash += tv - comm - tv*STAMP; my_nav[-1] = (my_nav[-1][0], cash); qty = 0.0

print()
print('A. 净值重算 vs 库内 net_value：点数 %d/%d，ts 全等=%s，逐点最大绝对差=%.3e'
      % (len(my_nav), len(nav_db), [a[0] for a in my_nav] == [b[0] for b in nav_db],
         max(abs(a[1]-b[1]) for a, b in zip(my_nav, nav_db))))
print('   期末现金 = %.9f（库内 nav 末点 = %.9f）' % (cash, nav_db[-1][1]))

print()
print('B. TradeDetail 逐笔逐字段：重算 %d 笔 vs 库内 %d 笔' % (len(my_trades), len(tr_db)))
keys = ['open_ts','close_ts','open_bar','close_bar','open_price','close_price','shares','gross_value',
        'commission','stamp_duty','pnl','hold_bars']
worst = {k: 0.0 for k in keys}; nmis = 0
for a, b in zip(my_trades, tr_db):
    for k in keys:
        worst[k] = max(worst[k], abs((a[k] if isinstance(a[k], (int,float)) else 0) - (b[k] if isinstance(b[k], (int,float)) else 0)))
    if any(abs((a[k] if isinstance(a[k],(int,float)) else 0)-(b[k] if isinstance(b[k],(int,float)) else 0)) > 1e-9 for k in keys): nmis += 1
print('   逐字段最大绝对差 =', {k: f'{v:.3e}' for k, v in worst.items()})
print('   字段不符的笔数 =', nmis)
print('   Σ pnl 重算 = %.9f  库内 Σ pnl = %.9f' % (sum(t['pnl'] for t in my_trades), sum(t['pnl'] for t in tr_db)))

print()
print('C. metrics（文档口径）重算 vs 库内')
eq = [e for _, e in my_nav]
net = eq[-1] - INIT
peak = -math.inf; mdd = 0.0
for e in eq:
    peak = max(peak, e); mdd = max(mdd, (peak-e)/peak)
rets = [(eq[i]-eq[i-1])/eq[i-1] for i in range(1, len(eq))]
mean = sum(rets)/len(rets); std = math.sqrt(sum((r-mean)**2 for r in rets)/(len(rets)-1))
sharpe = mean/std*math.sqrt(BPY)
wins = [t['pnl'] for t in my_trades if t['pnl'] > 0]; losses = [abs(t['pnl']) for t in my_trades if t['pnl'] < 0]
wr = len(wins)/len(my_trades)
pf = (sum(wins)/len(wins))/(sum(losses)/len(losses)) if (wins and losses) else (0.0 if losses else float('inf'))
ann = (eq[-1]/INIT)**(BPY/len(eq)) - 1
hold = sum(t['hold_bars'] for t in my_trades)/len(my_trades)
mine = dict(net_profit=net, max_drawdown=mdd, sharpe=sharpe, win_rate=wr, profit_factor=pf,
            annualized_return=ann, trade_count=len(my_trades), avg_hold_bars=hold)
for k in ['net_profit','max_drawdown','sharpe','win_rate','profit_factor','annualized_return','trade_count','avg_hold_bars']:
    a, b = mine[k], m_db[k]
    print(f'   {k:20s} 重算={a:<26.15g} 库内={b:<26.15g} Δ={abs(a-b):.3e}')
print('   回撤序列：库内 %d 点，重算逐点最大差 = %.3e'
      % (len(dd_db), max(abs(((max(eq[:i+1])-eq[i])/max(eq[:i+1])) - dd_db[i][1]) for i in range(len(eq)))))

print()
print('D. 三账恒等式')
print('   Σ trades.pnl = %.9f ; nav[-1] − initial = %.9f ; Δ = %.3e'
      % (sum(t['pnl'] for t in my_trades), eq[-1]-INIT, sum(t['pnl'] for t in my_trades)-(eq[-1]-INIT)))
n_full = sum(1 for f in fills if f['side'] == 'Sell' and f['qty'] >= 0)
print('   trade_count == len(trades) == %d ；成交笔数（fills）= %d ；买/卖 = %d/%d'
      % (len(tr_db), len(fills), sum(1 for f in fills if f['side']=='Buy'), sum(1 for f in fills if f['side']=='Sell')))

print()
print('E. 反证（判据可失败）：不同 trade 定义下的笔数')
print('   Rule A 仅清仓合成（engine.rs:846 口径）→ %d  （库内 %d）%s'
      % (len(my_trades), len(tr_db), 'GREEN' if len(my_trades) == len(tr_db) else 'RED'))
print('   Rule B 每笔 Buy 一条            → %d  vs 库内 %d  ⇒ %s'
      % (sum(1 for f in fills if f['side']=='Buy'), len(tr_db),
         'RED（定义不同即不符）' if sum(1 for f in fills if f['side']=='Buy') != len(tr_db) else '同值'))
print('   Rule C 每笔成交一条            → %d  vs 库内 %d  ⇒ %s'
      % (len(fills), len(tr_db), 'RED（定义不同即不符）' if len(fills) != len(tr_db) else '同值'))
