#!/usr/bin/env python3
"""任务136 exp41 裁决汇总：3 条挑战路径 vs 已发布 Donchian(20/15)（任务134 fz_pathA_*）。
双维度：OOS 均值 + OOS 品种级最差标的；IS 同窗对照。输出 runs/verdict_table.json。"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as h

HERE = os.path.dirname(os.path.abspath(__file__))
PREV = os.path.join(HERE, "..", "wave_strategy", "runs")

def load_slices(path):
    out = json.load(open(path))
    nv, tr = out.get("net_value"), out.get("trades") or []
    ism = h.slice_metrics(nv, tr, 0, h.SPLIT_TS)
    oos = h.slice_metrics(nv, tr, h.SPLIT_TS, 10**12)
    return ism, oos

def summarize(prefix, runs_dir):
    rows = {}
    for sym in h.UNIVERSE:
        p = os.path.join(runs_dir, f"{prefix}_{sym}.json")
        ism, oos = load_slices(p)
        rid = json.load(open(p))["run_id"]
        rows[sym] = {
            "run_id": rid,
            "is_ann": (ism.get("annualized_return") or 0) * 100,
            "oos_ann": (oos.get("annualized_return") or 0) * 100,
            "oos_mdd": (oos.get("max_drawdown") or 0) * 100,
            "oos_tr": oos.get("trade_count") or 0,
            "is_tr": ism.get("trade_count") or 0,
        }
    is_mean = sum(r["is_ann"] for r in rows.values()) / 8
    oos_mean = sum(r["oos_ann"] for r in rows.values()) / 8
    oos_worst_sym = min(rows, key=lambda s: rows[s]["oos_ann"])
    mdd_mean = sum(r["oos_mdd"] for r in rows.values()) / 8
    return {"per_symbol": rows, "is_mean": round(is_mean, 2), "oos_mean": round(oos_mean, 2),
            "oos_worst_sym": oos_worst_sym, "oos_worst": round(rows[oos_worst_sym]["oos_ann"], 2),
            "oos_mdd_mean": round(mdd_mean, 2),
            "oos_trades_total": sum(r["oos_tr"] for r in rows.values())}

table = {
    "baseline_donchian2015": summarize("fz_pathA", PREV),
    "ha_struct60": summarize("fz2_ha", h.OUT),
    "hb_tsmom_vol120r2": summarize("fz2_hb", h.OUT),
    "hc_ensemble_don_t250r2": summarize("fz2_hc", h.OUT),
}
json.dump(table, open(os.path.join(h.OUT, "verdict_table.json"), "w"),
          ensure_ascii=False, indent=1)

hdr = f"{'路径':<28}{'IS均值':>8}{'OOS均值':>9}{'OOS最差':>16}{'OOS回撤均':>10}{'OOS笔数':>8}"
print(hdr)
for k, v in table.items():
    print(f"{k:<28}{v['is_mean']:>+7.2f}%{v['oos_mean']:>+8.2f}%"
          f"{v['oos_worst_sym']:>8}{v['oos_worst']:>+7.2f}%"
          f"{v['oos_mdd_mean']:>9.1f}%{v['oos_trades_total']:>8}")
print("\n逐标的 OOS 年化%：")
syms = list(h.UNIVERSE)
print("标的      " + "".join(f"{k[:24]:>26}" for k in table))
for s in syms:
    print(f"{s:<10}" + "".join(f"{table[k]['per_symbol'][s]['oos_ann']:>+25.1f}" for k in table))
