#!/usr/bin/env python3
"""阶段1·第一批：4 个候选插件 × 8 标的 × 训练窗（默认参数）冒烟+基准表。
用法：python3 exp10_first_batch.py"""
import exp_lib as L, harness as h

PLUGINS = ["wave_donchian", "wave_squeeze", "wave_tsmom", "wave_retest", "wave_fused"]

def main():
    codes = {n: h.load_code(n + ".js") for n in PLUGINS}
    # 先单标的冒烟（查插件错误事件）
    for n in PLUGINS:
        m, d = L.eval_strategy(codes[n], {}, "510050", h.TRAIN_FROM, h.TRAIN_TO, tag=f"smoke_{n}")
        errs = [e for e in (d.get("events") or []) if "error" in str(e).lower()]
        print(f"smoke {n}: bars={d.get('bar_count')} trades={m.get('trade_count')} errors={len(errs)}")
        if errs: print("  ", errs[:3])
    print()
    header = f"{'plugin':<16}" + "".join(f"{s:>10}" for s in h.UNIVERSE) + "   (训练窗年化%)"
    print(header)
    for n in PLUGINS:
        row = f"{n:<16}"
        for sym in h.UNIVERSE:
            m, _ = L.eval_strategy(codes[n], {}, sym, h.TRAIN_FROM, h.TRAIN_TO, tag=f"b1_{n}", )
            a = m.get("annualized_return")
            row += f"{(a*100 if a is not None else float('nan')):>9.1f} "
        print(row, flush=True)
    print()
    # 详细表：交易数与盈亏比
    for n in PLUGINS:
        print(f"--- {n} ---")
        for sym in h.UNIVERSE:
            m, _ = L.eval_strategy(codes[n], {}, sym, h.TRAIN_FROM, h.TRAIN_TO, tag=f"b1_{n}")
            print(f"  {sym} {h.UNIVERSE[sym]:<24} {L.fmt(m)}", flush=True)

if __name__ == "__main__":
    main()
