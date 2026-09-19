import json
fills = json.load(open('06_fills_payload_raw.json'))
trades = json.load(open('10_trades_raw.json'))

RATE = 0.025/100.0     # commission_rate_pct
MINC = 5.0
STAMP = 0.0/100.0

def comm(v): return max(v*RATE, MINC)

qty=v_basis=cost=buys_comm=0.0
entry_ts=None; entry_bar=None
sell=None
for f in fills:
    if f['side']=='Buy':
        v = f['qty']*f['price']
        v_basis += v; cost += v + comm(v); buys_comm += comm(v); qty += f['qty']
        if entry_ts is None: entry_ts, entry_bar = f['ts'], f['bar_index']
    else:
        tv = f['qty']*f['price']
        c = comm(tv); s = tv*STAMP
        sell = dict(trade_value=tv, commission=c, stamp=s, proceeds=tv-c-s,
                    ts=f['ts'], bar=f['bar_index'], qty=f['qty'], price=f['price'])
        qty -= f['qty']

print("=== 按实现规则（engine.rs apply_sell：仅 qty>=holding.qty 的清仓才 push TradeDetail）重建 ===")
recon = dict(
    open_ts=entry_ts, close_ts=sell['ts'], open_bar=entry_bar, close_bar=sell['bar'],
    open_price=v_basis/(v_basis and sum(f['qty'] for f in fills if f['side']=='Buy')),
    close_price=sell['price'], shares=sum(f['qty'] for f in fills if f['side']=='Buy'),
    gross_value=sell['trade_value'], commission=buys_comm+sell['commission'],
    stamp_duty=sell['stamp'], pnl=sell['proceeds']-cost,
    hold_bars=sell['bar']-entry_bar)
print(json.dumps(recon, indent=1))
print("=== DB/API 实际 TradeDetail ===")
print(json.dumps(trades[0], indent=1))
keys=['open_ts','close_ts','open_bar','close_bar','close_price','shares','gross_value','commission','stamp_duty','pnl','hold_bars']
for k in keys:
    d=abs(recon[k]-trades[0][k]) if isinstance(recon[k],float) else int(recon[k]!=trades[0][k])
    print(f"  {k:12s} recon={recon[k]!r:24} db={trades[0][k]!r:24} diff={d}")
print("  open_price   recon=%.12f db=%.12f diff=%.2e"%(recon['open_price'],trades[0]['open_price'],abs(recon['open_price']-trades[0]['open_price'])))

print()
print("=== 反事实：若按「每笔买入 vs 分摊卖出」FIFO 逐笔配对，会有多少笔 round-trip？ ===")
buy_n = sum(1 for f in fills if f['side']=='Buy')
sell_n = sum(1 for f in fills if f['side']=='Sell')
print(f"  fills: Buy={buy_n} Sell={sell_n}; 若逐笔买/卖配对 → {buy_n} 笔（每笔买入各自成一笔 round-trip）")
print(f"  若按「平仓事件」计数 → {sell_n} 笔")
print(f"  实现口径（清仓合成） → {len(trades)} 笔")
