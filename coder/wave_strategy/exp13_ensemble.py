#!/usr/bin/env python3
"""阶段1·路径B ensemble 网格（训练窗，本地引擎，成员参数=消融优胜冻结）。"""
import exp_lib as L, harness as h

C = {n: h.load_code(n + ".js") for n in ["wave_donchian", "wave_squeeze", "wave_tsmom", "wave_retest"]}
A4 = {"code": C["wave_donchian"], "params": {"use_vol":0,"use_regime":0,"use_adx":0}}
C1 = {"code": C["wave_tsmom"], "params": {"lb":60}}
D1 = {"code": C["wave_retest"], "params": {"entry_mode":1}}
B3 = {"code": C["wave_squeeze"], "params": {"use_regime":0}}

def sl(member, w): return {"code": member["code"], "params": member["params"], "weight": w}

COMBOS = {
    "E1_A4+C1":      ([sl(A4,1), sl(C1,1)], 60, 40),
    "E2_A4+C1+D1":   ([sl(A4,1), sl(C1,1), sl(D1,1)], 60, 40),
    "E3_all4":       ([sl(A4,1), sl(C1,1), sl(D1,1), sl(B3,1)], 60, 40),
    "E4_A4x2":       ([sl(A4,2), sl(C1,1), sl(D1,1)], 60, 40),
    "E5_C1+D1":      ([sl(C1,1), sl(D1,1)], 60, 40),
    "E6_A4+D1":      ([sl(A4,1), sl(D1,1)], 60, 40),
    "E8_C1x2":       ([sl(A4,1), sl(C1,2), sl(D1,1)], 60, 40),
    "E9_thr55":      ([sl(A4,1), sl(C1,1), sl(D1,1)], 55, 40),
    "E10_thr65":     ([sl(A4,1), sl(C1,1), sl(D1,1)], 65, 40),
    "E11_thr60_45":  ([sl(A4,1), sl(C1,1), sl(D1,1)], 60, 45),
}

def main():
    print(f"{'combo':<16}{'sym':<8}{'ann%':>7}{'mdd%':>7}{'tr':>4}{'win%':>6}{'pf':>6}{'shp':>6}")
    for name, (slots, bt, st_) in COMBOS.items():
        anns = []
        for sym in h.UNIVERSE:
            m, _ = L.engine_run(slots, sym, buy=bt, sell=st_, tag=f"b13_{name}")
            a = (m.get("annualized_return") or 0) * 100
            anns.append(a)
            print(f"{name:<16}{sym:<8}{a:>7.1f}{(m.get('max_drawdown') or 0)*100:>7.1f}"
                  f"{m.get('trade_count') or 0:>4}{(m.get('win_rate') or 0)*100:>6.0f}"
                  f"{(m.get('profit_factor') or 0):>6.2f}{(m.get('sharpe') or 0):>6.2f}", flush=True)
        print(f"{name:<16}{'MEAN':<8}{sum(anns)/len(anns):>7.1f}\n", flush=True)

if __name__ == "__main__":
    main()
