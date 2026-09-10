#!/usr/bin/env python3
"""任务136 exp31 H-A 结构前提网格（训练窗，本地引擎）。
主网格：range_n{60,120} × amp{0.15,0.20,0.25}，默认 dry0.85/brkvol1.3/突破即入/LLV15；
随后对最优配置做消融：use_dry=0、use_brkvol=0、entry_mode=1(回踩)、exit_mode=1(吊灯)、
dry_coef{0.7,1.0}、brk_vol{1.0,1.5}。
对照臂（裸 brk60/120 无结构前提）已在 exp30 落盘。
汇总指标：8 标的等权均值年化 + 最差标的年化 + 总笔数。"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as h
import exp_lib as el

HERE = os.path.dirname(os.path.abspath(__file__))
CODE = open(os.path.join(HERE, "strategies", "wave_struct.js"), encoding="utf-8").read()

def run_cfg(tag, params):
    anns, worst, worst_sym, total_tr = [], 1e9, None, 0
    per = {}
    for sym in h.UNIVERSE:
        m, _ = el.engine_run([{"code": CODE, "params": params, "weight": 1.0}],
                             sym, tag=f"ha_{tag}")
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
print("== 主网格 ==", flush=True)
for rn in (60, 120):
    for amp in (0.15, 0.20, 0.25):
        results.append(run_cfg(f"r{rn}a{int(amp*100)}",
                               {"range_n": rn, "amp_max": amp}))

best = max(results, key=lambda r: (r["mean_ann"], r["worst_ann"]))
bp = dict(best["params"])
print(f"最优主网格: {best['tag']} {bp}", flush=True)

print("== 消融（基于最优） ==", flush=True)
abl = [
    ("nodry",    {"use_dry": 0}),
    ("nobrkvol", {"use_brkvol": 0}),
    ("nostruct", {"use_dry": 0, "use_brkvol": 0, "amp_max": 0.5}),
    ("retest",   {"entry_mode": 1}),
    ("chand",    {"exit_mode": 1}),
    ("dry070",   {"dry_coef": 0.7}),
    ("dry100",   {"dry_coef": 1.0}),
    ("bv100",    {"brk_vol": 1.0}),
    ("bv150",    {"brk_vol": 1.5}),
    ("amp10",    {"amp_max": 0.10}),
]
for name, over in abl:
    p = dict(bp); p.update(over)
    results.append(run_cfg(f"{best['tag']}_{name}", p))

json.dump(results, open(os.path.join(h.OUT, "ha_grid_summary.json"), "w"),
          ensure_ascii=False, indent=1)
print("done -> runs/ha_grid_summary.json", flush=True)
