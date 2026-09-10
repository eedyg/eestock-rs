#!/usr/bin/env python3
"""阶段1·消融网格（训练窗，本地引擎）。每个组合独立命名，结果全落 runs/eng_a12_*。
用法：python3 exp12_ablations.py [donchian|retest|squeeze|tsmom] （缺省全跑）"""
import sys, itertools
import exp_lib as L, harness as h

CODES = {n: h.load_code(n + ".js") for n in
         ["wave_donchian", "wave_squeeze", "wave_tsmom", "wave_retest", "wave_fused"]}

GRIDS = {
    # H2: Donchian 过滤消融 × 离场方式
    "donchian": [
        ("A4_pure20_10",      {"use_vol":0,"use_regime":0,"use_adx":0}),
        ("A1_noAdx",          {"use_adx":0}),
        ("A2_noVol",          {"use_vol":0}),
        ("A3_noRegime",       {"use_regime":0}),
        ("A5_turtle55_20",    {"use_vol":0,"use_regime":0,"use_adx":0,"brk_n":55,"exit_n":20}),
        ("A6_chand",          {"exit_mode":1}),
        ("A7_ma20exit",       {"exit_mode":2,"exit_ma":20}),
        ("A8_pure_chand",     {"use_vol":0,"use_regime":0,"use_adx":0,"exit_mode":1}),
        ("A9_vol_regime",     {"use_adx":0,"exit_mode":1}),
    ],
    # H5: 回踩确认 vs 突破即入（⑤核心论断）× 箱体参数
    "retest": [
        ("D0_retest",         {}),
        ("D1_breakout_only",  {"entry_mode":1}),
        ("D2_bigbox",         {"box_n":30,"box_amp":0.25,"wait_n":15}),
        ("D3_tightbox",       {"box_n":12,"box_amp":0.12,"wait_n":8}),
        ("D5_novol",          {"brk_vol":0.5}),
    ],
    # H3: 平台挤压参数
    "squeeze": [
        ("B0_default",        {}),
        ("B1_wide",           {"amp_max":0.15}),
        ("B2_long",           {"plat_n":30,"amp_max":0.15}),
        ("B3_noRegime",       {"use_regime":0}),
        ("B4_lovol",          {"vol_mult":1.2}),
    ],
    # H4: TSMOM 窗口 × 离场缓冲 × 吊灯
    "tsmom": [
        ("C0_lb120",          {}),
        ("C1_lb60",           {"lb":60}),
        ("C2_lb250",          {"lb":250}),
        ("C3_chand",          {"use_chand":1}),
        ("C4_exitbuf",        {"exit_thr":-0.05}),
        ("C5_upbuf",          {"up_thr":0.05,"exit_thr":-0.02}),
        ("C6_lb60_chand",     {"lb":60,"use_chand":1}),
    ],
}

def main():
    which = sys.argv[1:] or list(GRIDS)
    for g in which:
        plugin = f"wave_{g}"
        print(f"===== {plugin} 消融 =====")
        print(f"{'config':<20}{'sym':<8}{'ann%':>7}{'mdd%':>7}{'tr':>4}{'win%':>6}{'pf':>6}{'hold':>6}")
        for name, params in GRIDS[g]:
            anns = []
            for sym in h.UNIVERSE:
                m, _ = L.engine_run([{"code": CODES[plugin], "params": params, "weight": 1}],
                                    sym, tag=f"a12_{name}")
                a = (m.get("annualized_return") or 0) * 100
                anns.append(a)
                print(f"{name:<20}{sym:<8}{a:>7.1f}{(m.get('max_drawdown') or 0)*100:>7.1f}"
                      f"{m.get('trade_count') or 0:>4}{(m.get('win_rate') or 0)*100:>6.0f}"
                      f"{(m.get('profit_factor') or 0):>6.2f}{(m.get('avg_hold_bars') or 0):>6.1f}", flush=True)
            print(f"{name:<20}{'MEAN':<8}{sum(anns)/len(anns):>7.1f}")
        print()

if __name__ == "__main__":
    main()
