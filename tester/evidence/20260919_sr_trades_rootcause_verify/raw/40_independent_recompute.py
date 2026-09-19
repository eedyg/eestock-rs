#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立现金流重算（Tester 自写，未参考 coder/evidence 下任何上游脚本）。
输入（全部为本目录 raw 下 Tester 自己从库/私有读源拉取的原始输出）：
  20_d1_bars_union.psv   — 与 crates/storage/src/backtest.rs range_sql(D1) 同口径的 OHLC（accurate ∪ 兜底）
  10_fills_raw.json      — strategy_run_bars(kind='fills') 43 笔成交流水
  11_per_bar_raw.json    — strategy_run_bars(kind='per_bar') 423 根（仅用于定位 in-range 段与意图）
  12_net_value_raw.json  — 系统净值序列（仅用于对比，不参与重算）
  14_trades_raw.json     — 系统合成 TradeDetail（仅用于对比）
  15_metrics_raw.json    — 系统 metrics（仅用于对比）
  31_target_config.json  — run 配置（fee / initial_capital / policy / thresholds）

重算规则（完全按代码原文，不引用任何上游结论）：
  * 决策 bar i 的挂单在 bar i+1 的 open 成交（engine.rs 步骤 1）；
  * 买入成交额 = qty×price（price 已含滑点，由 fills 原样给出）；
    佣金 = max(成交额×rate_pct/100, min_fee)（fee.rs commission）；
    现金 -= 成交额 + 佣金（fee.rs BuyExecution.total_cost）；
  * 卖出：佣金同上，印花税 = 成交额×stamp_duty_pct/100，现金 += 成交额 − 佣金 − 印花税；
  * 逐 bar 收盘净值 = cash + qty×close（engine.rs 步骤 8）；
  * 期末强平（engine.rs finish）把最后一点净值改写为强平后现金；
  * TradeDetail 仅在「卖出量 >= 当前持仓」时合成（engine.rs apply_sell），
    open_price = 加权有效买价（value_basis/qty），commission = 买入佣金累计 + 本次卖出佣金，
    pnl = 卖出净得 − cost_basis，hold_bars = close_bar − open_bar。
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
def p(n): return os.path.join(HERE, n)

cfg = json.load(open(p('31_target_config.json')))
fee = cfg['fee']
RATE = fee['rate_pct'] / 100.0
MIN_FEE = fee['min_fee']
STAMP = fee['stamp_duty_pct'] / 100.0
INIT = cfg['initial_capital']
BUY_TH, SELL_TH = cfg['buy_threshold'], cfg['sell_threshold']

bars = []
for line in open(p('20_d1_bars_union.psv')):
    line = line.strip()
    if not line: continue
    ts, o, h, l, c, src = line.split('|')
    bars.append(dict(ts=int(ts), open=float(o), high=float(h), low=float(l), close=float(c), src=src))
per_bar = json.load(open(p('11_per_bar_raw.json')))
fills = json.load(open(p('10_fills_raw.json')))
sys_nav = json.load(open(p('12_net_value_raw.json')))
sys_trades = json.load(open(p('14_trades_raw.json')))
sys_metrics = json.load(open(p('15_metrics_raw.json')))

print('=' * 78)
print('CHK0 输入对齐')
print('=' * 78)
print(f'bars(重算取数) = {len(bars)}；per_bar = {len(per_bar)}')
print(f'bar ts 序列与 per_bar ts 完全一致 = {[b["ts"] for b in bars] == [b["ts"] for b in per_bar]}')
inrange = [i for i, b in enumerate(per_bar) if not b['warmup']]
print(f'in-range 下标 = [{inrange[0]}..{inrange[-1]}] 共 {len(inrange)} 根；warmup = {len(per_bar)-len(inrange)}')
# fills 的 ts 必须等于对应 bar_index 的 ts（证明 fill→bar 映射无需猜测）
mis = [(f['bar_index'], f['ts'], bars[f['bar_index']]['ts']) for f in fills if bars[f['bar_index']]['ts'] != f['ts']]
print(f'fills.ts == bars[bar_index].ts 的违例数 = {len(mis)}  {mis[:3]}')

print()
print('=' * 78)
print('CHK1 由 fills + 收盘价 + fee 契约重算现金流/持仓/TradeDetail')
print('=' * 78)
cash = INIT
qty = 0.0
cost_basis = 0.0       # 含买入佣金的累计成本
value_basis = 0.0      # 累计成交额（用于 open_price = value_basis/qty）
buy_comm = 0.0
entry_bar = None
entry_ts = None
my_trades = []
my_nav = []
fills_by_bar = {}
for f in fills:
    fills_by_bar.setdefault(f['bar_index'], []).append(f)
sum_buy_tv = sum_buy_comm = 0.0
sum_sell_tv = sum_sell_comm = sum_sell_stamp = 0.0
nav_pre_forceclose = None
for i, bar in enumerate(bars):
    for f in fills_by_bar.get(i, []):
        tv = f['qty'] * f['price']
        comm = max(tv * RATE, MIN_FEE)
        if f['side'] == 'Buy':
            cash -= tv + comm
            qty += f['qty']; cost_basis += tv + comm; value_basis += tv; buy_comm += comm
            sum_buy_tv += tv; sum_buy_comm += comm
            if entry_bar is None:
                entry_bar, entry_ts = i, bar['ts']
        else:
            if f.get('reason') == 'ForceClose':
                nav_pre_forceclose = cash + qty * bar['close']   # 强平前一刻（持仓按末 close 计价）
            cash += tv - comm - tv * STAMP
            sum_sell_tv += tv; sum_sell_comm += comm; sum_sell_stamp += tv * STAMP
            if f['qty'] >= qty - 1e-12:   # 清仓（engine.rs:846 qty >= h.qty）
                my_trades.append(dict(
                    open_ts=entry_ts, close_ts=bar['ts'], open_bar=entry_bar, close_bar=i,
                    open_price=value_basis / qty, close_price=f['price'], shares=qty,
                    gross_value=tv, commission=buy_comm + comm, stamp_duty=tv * STAMP,
                    pnl=(tv - comm - tv * STAMP) - cost_basis, hold_bars=i - entry_bar))
                qty = 0.0; cost_basis = value_basis = buy_comm = 0.0
                entry_bar = entry_ts = None
            else:
                ratio = f['qty'] / qty
                cost_basis *= 1 - ratio; value_basis *= 1 - ratio; buy_comm *= 1 - ratio
                qty -= f['qty']
    if i in inrange:
        my_nav.append((bar['ts'], cash + qty * bar['close']))
# finish()：最后一点净值改写为强平后现金（库内 fills 已含该笔 ForceClose ⇒ 此处 qty 应为 0）
if qty != 0.0:
    print(f'!! 重算结束时仍有持仓 {qty}（说明 fills 未含期末强平）')
if my_nav:
    my_nav[-1] = (my_nav[-1][0], cash)
print(f'Σ买入成交额 = {sum_buy_tv:.6f}  Σ买入佣金 = {sum_buy_comm:.6f}')
print(f'Σ卖出成交额 = {sum_sell_tv:.6f}  Σ卖出佣金 = {sum_sell_comm:.6f}  Σ印花税 = {sum_sell_stamp:.6f}')
print(f'期末现金（重算） = {cash:.12f}   系统 nav[-1] = {sys_nav[-1][1]:.12f}   差 = {cash - sys_nav[-1][1]:.3e}')
print(f'强平前按末 close 市值（重算）= {nav_pre_forceclose:.12f}  '
      f'强平后现金 = {cash:.12f}  强平代价 = {nav_pre_forceclose - cash:.12f}')
last_close = bars[-1]['close']
shares_fc = sys_trades[0]['shares']
print(f'  分解（用系统 trades[0].shares）：滑点 = {shares_fc*(last_close - last_close*(1-2/10000)):.9f} + '
      f'卖出佣金 = {max(shares_fc*last_close*(1-2/10000)*RATE, MIN_FEE):.9f} + 印花税 = {0.0:.9f}'
      f' = {shares_fc*(last_close - last_close*(1-2/10000)) + max(shares_fc*last_close*(1-2/10000)*RATE, MIN_FEE):.9f}')

print()
print('CHK1a 净值序列逐点对比')
diffs = [abs(a[1] - b[1]) for a, b in zip(my_nav, sys_nav)]
print(f'点数 重算={len(my_nav)} 系统={len(sys_nav)}；ts 全等={[a[0] for a in my_nav]==[b[0] for b in sys_nav]}')
print(f'逐点最大绝对差 = {max(diffs):.3e}   非零点数 = {sum(1 for d in diffs if d>1e-9)}')

print()
print('CHK1b TradeDetail 逐字段对比（我合成 vs 系统落库）')
keys = ['open_ts','close_ts','open_bar','close_bar','open_price','close_price','shares','gross_value',
        'commission','stamp_duty','pnl','hold_bars']
print(f'笔数 重算={len(my_trades)} 系统={len(sys_trades)}')
for k in keys:
    a, b = my_trades[0][k], sys_trades[0][k]
    d = abs(a - b) if isinstance(b, (int, float)) else (0.0 if a == b else 1.0)
    print(f'  {k:14s} 重算={a:<24} 系统={b:<24} Δ={d:.3e}')

print()
print('=' * 78)
print('CHK2 按 metrics.rs 文档口径逐字段重算 8 项指标（用我自己的 nav / trades）')
print('=' * 78)
BARS_PER_YEAR = 252.0  # types.rs Period::D1

def metrics(nav, trades, initial, bars_per_year, annualized_n_points=True, ddof=1,
            deployed_denominator=None, count_mode='closes'):
    eq = [e for _, e in nav]
    final = eq[-1] if eq else initial
    net = final - initial
    peak = -math.inf; mdd = 0.0
    for e in eq:
        peak = max(peak, e)
        if peak > 0: mdd = max(mdd, (peak - e) / peak)
    rets = [(eq[i] - eq[i-1]) / eq[i-1] for i in range(1, len(eq))]
    mean = sum(rets) / len(rets) if rets else 0.0
    if len(rets) > 1:
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - ddof)
        std = math.sqrt(var)
    else:
        std = 0.0
    sharpe = (mean / std * math.sqrt(bars_per_year)) if std > 0 else 0.0
    wins = [t['pnl'] for t in trades if t['pnl'] > 0]
    losses = [abs(t['pnl']) for t in trades if t['pnl'] < 0]
    win_rate = len(wins) / len(trades) if trades else 0.0
    ap = sum(wins) / len(wins) if wins else 0.0
    al = sum(losses) / len(losses) if losses else 0.0
    pf = (ap / al) if al > 0 else (math.inf if ap > 0 else 0.0)
    den = initial if deployed_denominator is None else deployed_denominator
    n_ann = len(eq) if annualized_n_points else max(len(eq) - 1, 1)
    ann = (final / den) ** (bars_per_year / n_ann) - 1.0
    if count_mode == 'closes': tc = len(trades)
    elif count_mode == 'fills': tc = 43
    hold = sum(t['hold_bars'] for t in trades) / len(trades) if trades else 0.0
    return dict(net_profit=net, max_drawdown=mdd, sharpe=sharpe, win_rate=win_rate,
                profit_factor=pf, annualized_return=ann, trade_count=tc, avg_hold_bars=hold)

mine = metrics(my_nav, my_trades, INIT, BARS_PER_YEAR)
print(f'{"field":20s} {"Tester 重算":>26s} {"系统 metrics":>26s} {"Δ":>12s}')
for k in ['net_profit','max_drawdown','sharpe','win_rate','profit_factor','annualized_return','trade_count','avg_hold_bars']:
    a, b = mine[k], sys_metrics[k]
    d = abs(a - b) if b is not None else float('nan')
    print(f'{k:20s} {a:>26.15g} {b:>26.15g} {d:>12.3e}')

print()
print('CHK2a 中间量（供交叉核对）')
eq = [e for _, e in my_nav]
rets = [(eq[i]-eq[i-1])/eq[i-1] for i in range(1, len(eq))]
mean = sum(rets)/len(rets); var = sum((r-mean)**2 for r in rets)/(len(rets)-1)
print(f'nav 点数 n = {len(eq)}；returns = {len(rets)}；零收益 bar = {sum(1 for r in rets if r==0.0)}')
print(f'mean_period_return = {mean:.15e}；std(ddof=1) = {math.sqrt(var):.15e}；sqrt(252) = {math.sqrt(252):.12f}')
print(f'首次成交 bar = {fills[0]["bar_index"]}；峰值 nav = {max(eq):.9f}（idx {eq.index(max(eq))}）；'
      f'谷值 nav = {min(eq):.9f}（idx {eq.index(min(eq))}）')

print()
print('=' * 78)
print('CHK3 口径变异（证明我的判据有区分度：口径一改，数字立刻变红）')
print('=' * 78)
sum_buy_total = sum_buy_tv + sum_buy_comm
v = {}
v['V0 文档/实现口径（initial 为分母、n=nav 点数、ddof=1、平仓计数）'] = mine
v['V1 分母换成实际投入资本（收益率 = 净利/投入，再年化）'] = dict(
    metrics(my_nav, my_trades, INIT, BARS_PER_YEAR, deployed_denominator=INIT),
    annualized_return=(1 + mine['net_profit'] / sum_buy_total) ** (BARS_PER_YEAR / len(my_nav)) - 1)
v['V2 年化用 returns 数（n-1）'] = metrics(my_nav, my_trades, INIT, BARS_PER_YEAR, annualized_n_points=False)
v['V3 夏普 ddof=0'] = metrics(my_nav, my_trades, INIT, BARS_PER_YEAR, ddof=0)
v['V4 trade_count = 成交笔数（43）'] = metrics(my_nav, my_trades, INIT, BARS_PER_YEAR, count_mode='fills')
for name, m in v.items():
    print(f'{name}')
    print(f'    net_profit={m["net_profit"]:.9f}  annualized={m["annualized_return"]:.9f}  '
          f'sharpe={m["sharpe"]:.9f}  max_dd={m["max_drawdown"]:.9f}  trade_count={m["trade_count"]}')
print(f'实际投入资本（Σ成交额+Σ买入佣金）= {sum_buy_total:.6f} 占 initial 的 '
      f'{sum_buy_total/INIT*100:.4f}%')
print(f'  毛额分母视角收益率 = {mine["net_profit"]/sum_buy_tv*100:.6f}%  vs 系统口径 '
      f'{mine["net_profit"]/INIT*100:.6f}%  比值 = {(mine["net_profit"]/sum_buy_tv)/(mine["net_profit"]/INIT):.4f}x')
