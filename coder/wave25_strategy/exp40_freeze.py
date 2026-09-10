#!/usr/bin/env python3
"""任务136 阶段2·冻结验证：3 条挑战路径 × 8 标的 × 全 5 年窗（平台 workbench 钉 run id），
按 SPLIT_TS 切片 IS/OOS。冻结后每配置每标的仅跑一次。
决赛路径（训练窗选拔，均值主维度）：
  H-A 结构前提：wave_struct range60/amp0.25/dry1.0/brkvol1.3/突破即入/LLV15（训练均值 +3.37%）
  H-B 完整TSMOM：wave_tsmom_vol lb120 + 波动率缩放 + R²≥0.5（训练均值 +3.49%）
  H-C 尺度混合：Donchian(20/15) + tsmom_vol lb250+R² 等权 60/40（训练均值 +3.85%）
基线 Donchian(20/15) 复用任务134 冻结 run（fz_pathA_*，同窗同宇宙同费率），不重跑。
用法：python3 exp40_freeze.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as h

IDS_FILE = os.path.join(h.OUT, "_ids.json")
DON_VID = "sv_1789046242243_000120"  # 任务134 交付版本（published）

DELIVERABLES = [
    ("主涨段检验·结构前提(区间60)", "任务136 H-A 检验件：60~120日盘整区间+量能枯竭+整区间带量突破（Wyckoff/缠论形式化）。非交付策略。", "wave_struct.js", "struct"),
    ("主涨段检验·TSMOM波动率缩放", "任务136 H-B 检验件：TSMOM 信号强度×target_vol/realized_vol（z=mom/(σ√lb)）+可选R²过滤。非交付策略。", "wave_tsmom_vol.js", "tsmom_vol"),
]

FROZEN = {
    "ha": {"struct_params": {"range_n": 60, "amp_max": 0.25, "dry_coef": 1.0}},
    "hb": {"tsv_params": {"lb": 120, "use_scale": 1, "use_r2": 1, "r2_min": 0.5}},
    "hc": {"don_params": {}, "tsv_params": {"lb": 250, "use_scale": 1, "use_r2": 1, "r2_min": 0.3}},
}

def ensure_published():
    ids = json.load(open(IDS_FILE)) if os.path.exists(IDS_FILE) else {}
    for name, desc, fname, key in DELIVERABLES:
        if key in ids:
            continue
        sid, vid = h.create_strategy(name, desc, h.load_code(fname))
        h.publish(vid)
        ids[key] = {"strategy_id": sid, "version_id": vid}
        print("published", name, sid, vid, flush=True)
    json.dump(ids, open(IDS_FILE, "w"), ensure_ascii=False, indent=1)
    return ids

def slice_and_print(name, out):
    nv, tr = out.get("net_value"), out.get("trades") or []
    if not nv:
        return None
    ism = h.slice_metrics(nv, tr, 0, h.SPLIT_TS)
    oos = h.slice_metrics(nv, tr, h.SPLIT_TS, 10**12)
    out["is_metrics"] = ism
    out["oos_metrics"] = oos
    def f(m):
        return (f"ann={((m.get('annualized_return') or 0)*100):+.1f}% "
                f"mdd={((m.get('max_drawdown') or 0)*100):.0f}% tr={m.get('trade_count')}")
    print(f"  {name}: IS {f(ism)} | OOS {f(oos)}", flush=True)
    return {"is": ism, "oos": oos}

def main():
    ids = ensure_published()
    vS = ids["struct"]["version_id"]
    vT = ids["tsmom_vol"]["version_id"]
    paths = {
        "ha": [{"version_id": vS, "weight": 1, "params": FROZEN["ha"]["struct_params"]}],
        "hb": [{"version_id": vT, "weight": 1, "params": FROZEN["hb"]["tsv_params"]}],
        "hc": [{"version_id": DON_VID, "weight": 1, "params": FROZEN["hc"]["don_params"]},
               {"version_id": vT, "weight": 1, "params": FROZEN["hc"]["tsv_params"]}],
    }
    jobs = []
    for path, slots in paths.items():
        for sym in h.UNIVERSE:
            jobs.append((f"fz2_{path}_{sym}", sym, slots))
    todo = [(n, s, sl) for n, s, sl in jobs
            if not os.path.exists(os.path.join(h.OUT, n + ".json"))]
    print(f"{len(todo)} frozen runs to submit", flush=True)
    rids = {}
    for n, s, sl in todo:
        rids[n] = h.submit_run(n, s, "D1", h.FULL_FROM, h.FULL_TO, sl)
        print("submitted", n, rids[n], flush=True)
    summary = {}
    for n, s, sl in todo:
        d = h.wait_run(rids[n])
        out = {"run_id": rids[n], "status": d.get("status"), "error": d.get("error")}
        if d.get("status") == "succeeded":
            st, res = h.req("GET", f"/api/workbench/runs/{rids[n]}/result")
            out["metrics"] = res.get("metrics")
            out["trades"] = res.get("trades")
            out["net_value"] = res.get("net_value")
            out["config"] = d.get("config")
            r = slice_and_print(n, out)
            if r:
                summary[n] = r
        json.dump(out, open(os.path.join(h.OUT, n + ".json"), "w"),
                  ensure_ascii=False, indent=1)
    # 汇总（含已存在文件）
    for n, s, sl in jobs:
        if n in summary:
            continue
        p = os.path.join(h.OUT, n + ".json")
        out = json.load(open(p))
        if out.get("status") == "succeeded" and out.get("net_value"):
            r = slice_and_print(n, out)
            if r:
                summary[n] = r
            json.dump(out, open(p, "w"), ensure_ascii=False, indent=1)
    json.dump(summary, open(os.path.join(h.OUT, "fz2_summary.json"), "w"),
              ensure_ascii=False, indent=1)
    print("done -> runs/fz2_summary.json", flush=True)

if __name__ == "__main__":
    main()
