#!/usr/bin/env python3
"""任务136 exp33 H-C 尺度混合（训练窗，本地引擎）。
两支路线：
  ① ensemble（平台原生加权聚合）：Donchian(20/15) + 长尺度 TSMOM 缩放版（lb120_r2 / lb250_r2），
     等权 60/40（上轮口径，≈OR）与 70/30（≈AND 入场）对照；
  ② 先后过滤（wave_mix 单插件）：短 Donchian20 突破 × 长尺度 z 门控（lb120/lb250，gate_z 0/0.5）。
对照：wave_mix use_gate=0（=纯 Donchian(20/15)，应复现 +6.4% 训练均值）。"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as h
import exp_lib as el

HERE = os.path.dirname(os.path.abspath(__file__))
DON = open(os.path.join(HERE, "strategies", "wave_donchian_final.js"), encoding="utf-8").read()
TSV = open(os.path.join(HERE, "strategies", "wave_tsmom_vol.js"), encoding="utf-8").read()
MIX = open(os.path.join(HERE, "strategies", "wave_mix.js"), encoding="utf-8").read()

def run_slots(tag, slots, buy=60, sell=40):
    anns, worst, worst_sym, total_tr = [], 1e9, None, 0
    per = {}
    for sym in h.UNIVERSE:
        m, _ = el.engine_run(slots, sym, tag=f"hc_{tag}", buy=buy, sell=sell)
        a = m["annualized_return"]
        anns.append(a); total_tr += m["trade_count"]
        if a < worst: worst, worst_sym = a, sym
        per[sym] = {"ann": round(a * 100, 2), "tr": m["trade_count"],
                    "mdd": round(m["max_drawdown"] * 100, 1)}
    mean = sum(anns) / len(anns)
    row = {"tag": tag, "buy": buy, "sell": sell, "mean_ann": round(mean * 100, 2),
           "worst_ann": round(worst * 100, 2), "worst_sym": worst_sym,
           "total_trades": total_tr, "per_symbol": per,
           "slots": [{"params": s.get("params"), "weight": s.get("weight")} for s in slots]}
    print(f"{tag} @{buy}/{sell}: mean={mean*100:+.2f}% worst={worst*100:+.2f}%({worst_sym}) "
          f"trades={total_tr}", flush=True)
    return row

results = []
don = {"code": DON, "params": {}, "weight": 1.0}
t120 = {"code": TSV, "params": {"lb": 120, "use_r2": 1, "r2_min": 0.5}, "weight": 1.0}
t250 = {"code": TSV, "params": {"lb": 250, "use_r2": 1}, "weight": 1.0}

print("== ① ensemble ==", flush=True)
results.append(run_slots("ens_don_t120r2", [don, t120]))
results.append(run_slots("ens_don_t250r2", [don, t250]))
results.append(run_slots("ens_don_t120r2_7030", [don, t120], buy=70, sell=30))
results.append(run_slots("ens_don_t250r2_7030", [don, t250], buy=70, sell=30))
results.append(run_slots("ens_don_t120t250", [don, t120, t250]))

print("== ② 先后过滤 wave_mix ==", flush=True)
def mix(tag, params):
    return run_slots(tag, [{"code": MIX, "params": params, "weight": 1.0}])
results.append(mix("mix_gate0", {"use_gate": 0}))          # 内部对照=纯Donchian(20/15)
results.append(mix("mix_lb250_z0", {"lb": 250, "gate_z": 0.0}))
results.append(mix("mix_lb250_z05", {"lb": 250, "gate_z": 0.5}))
results.append(mix("mix_lb120_z0", {"lb": 120, "gate_z": 0.0}))
results.append(mix("mix_lb120_z05", {"lb": 120, "gate_z": 0.5}))

json.dump(results, open(os.path.join(h.OUT, "hc_grid_summary.json"), "w"),
          ensure_ascii=False, indent=1)
print("done -> runs/hc_grid_summary.json", flush=True)
