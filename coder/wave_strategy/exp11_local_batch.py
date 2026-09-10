#!/usr/bin/env python3
"""阶段1·第二批（本地引擎 fee 正确口径）：5 插件默认参数 × 8 标的训练窗。"""
import exp_lib as L, harness as h

PLUGINS = ["wave_donchian", "wave_squeeze", "wave_tsmom", "wave_retest", "wave_fused"]
CODES = {n: h.load_code(n + ".js") for n in PLUGINS}

def main():
    print("训练窗买入持有基线：")
    base = {}
    for sym in h.UNIVERSE:
        b = L.hold_baseline(sym)
        base[sym] = b
        print(f"  {sym} {h.UNIVERSE[sym]:<22} ann={b['annualized_return']*100:6.1f}% mdd={b['max_drawdown']*100:5.1f}%")
    print()
    for n in PLUGINS:
        print(f"--- {n}（默认参数, 本地引擎 ETF 费）---")
        for sym in h.UNIVERSE:
            m, _ = L.engine_run([{"code": CODES[n], "params": {}, "weight": 1}], sym, tag=f"b2_{n}")
            bh = base[sym]["annualized_return"] * 100
            print(f"  {sym} {L.fmt(m)}   [hold {bh:+.1f}%]", flush=True)
        print()

if __name__ == "__main__":
    main()
