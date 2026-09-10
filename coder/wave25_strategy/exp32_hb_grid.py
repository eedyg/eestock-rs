#!/usr/bin/env python3
"""任务136 exp32 H-B 完整版 TSMOM 网格（训练窗，本地引擎）。
对照：use_scale=0 裸符号（复刻上轮 wave_tsmom 语义）vs use_scale=1 波动率缩放；
lb{120,250} × use_scale{0,1} × use_r2{0,1}；z_scale{15,20,30} 敏感度；exit_z{0,-0.5}。
汇总：8 标的等权均值 + 最差标的 + 总笔数。"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as h
import exp_lib as el

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = open(os.path.join(HERE, "strategies", "wave_tsmom_vol.js"), encoding="utf-8").read()

def run_cfg(tag, params):
    anns, worst, worst_sym, total_tr = [], 1e9, None, 0
    per = {}
    for sym in h.UNIVERSE:
        m, _ = el.engine_run([{"code": CODE, "params": params, "weight": 1.0}],
                             sym, tag=f"hb_{tag}")
        a = m["annualized_return"]
        anns.append(a); total_tr += m["trade_count"]
        if a < worst: worst, worst_sym = a, sym
        per[sym] = {"ann": round(a * 100, 2), "tr": m["trade_count"],
                    "mdd": round(m["max_drawdown"] * 100, 1)}
    mean = sum(anns) / len(anns)
    row = {"tag": tag, "params": params, "mean_ann": round(mean * 100, 2),
           "worst_ann": round(worst * 100, 2), "worst_sym": worst_sym,
           "total_trades": total_tr, "per_symbol": per}
    print(f"{tag}: mean={mean*100:+.2f}% worst={worst*100:+.2f}%({worst_sym}) "
          f"trades={total_tr}", flush=True)
    return row

results = []
print("== 主对照：裸符号 vs 波动率缩放 × lb ==", flush=True)
for lb in (120, 250):
    results.append(run_cfg(f"lb{lb}_bare", {"lb": lb, "use_scale": 0}))
    results.append(run_cfg(f"lb{lb}_vol", {"lb": lb, "use_scale": 1}))
    results.append(run_cfg(f"lb{lb}_vol_r2", {"lb": lb, "use_scale": 1, "use_r2": 1}))
    results.append(run_cfg(f"lb{lb}_bare_r2", {"lb": lb, "use_scale": 0, "use_r2": 1}))

print("== z_scale / exit_z 敏感度（lb120/lb250 缩放版） ==", flush=True)
for lb in (120, 250):
    for zs in (15, 30):
        results.append(run_cfg(f"lb{lb}_zs{zs}", {"lb": lb, "z_scale": zs}))
    results.append(run_cfg(f"lb{lb}_ez05", {"lb": lb, "exit_z": -0.5}))
    results.append(run_cfg(f"lb{lb}_r2_05", {"lb": lb, "use_r2": 1, "r2_min": 0.5}))

json.dump(results, open(os.path.join(h.OUT, "hb_grid_summary.json"), "w"),
          ensure_ascii=False, indent=1)
print("done -> runs/hb_grid_summary.json", flush=True)
