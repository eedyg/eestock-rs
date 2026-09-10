#!/usr/bin/env python3
"""阶段2·冻结验证：两条决赛路径（冻结配置）× 8 标的 × 全 5 年窗（workbench 钉 run id），
随后按 SPLIT_TS 切片样本内/外指标。冻结后每配置每标的仅跑一次。
用法：python3 exp20_freeze.py"""
import json, os
import harness as h

IDS_FILE = os.path.join(h.OUT, "_ids.json")

DELIVERABLES = [
    ("主涨段捕获·Donchian(20/15)", "路径A 单插件交付：纯 Donchian 突破 20 日高点入场 / LLV(15) 离场（过滤开关缺省关）。任务134 冻结配置。", "wave_donchian_final.js", "donchian"),
    ("主涨段捕获·时序动量(lb60)", "路径B ensemble 成员：60 日收益符号趋势跟随。任务134 冻结配置。", "wave_tsmom60_final.js", "tsmom60"),
    ("主涨段捕获·时序动量(lb250)", "路径B ensemble 成员：250 日收益符号（长趋势/危机alpha层）。任务134 冻结配置。", "wave_tsmom250_final.js", "tsmom250"),
    ("主涨段捕获·中枢突破", "路径B ensemble 成员：缠论中枢放量突破即入（entry_mode=1）。任务134 冻结配置。", "wave_retest_final.js", "retest"),
]

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

def main():
    ids = ensure_published()
    vA = ids["donchian"]["version_id"]
    vC1 = ids["tsmom60"]["version_id"]
    vC250 = ids["tsmom250"]["version_id"]
    vD1 = ids["retest"]["version_id"]
    slotsA = [{"version_id": vA, "weight": 1, "params": {}}]
    slotsB = [{"version_id": v, "weight": 1, "params": {}} for v in (vA, vC1, vC250, vD1)]

    jobs = []
    for sym in h.UNIVERSE:
        jobs.append((f"fz_pathA_{sym}", sym, slotsA))
        jobs.append((f"fz_pathB_{sym}", sym, slotsB))
    todo = [(n, s, sl) for n, s, sl in jobs if not os.path.exists(os.path.join(h.OUT, n + ".json"))]
    print(f"{len(todo)} frozen runs to submit")
    rids = {}
    for n, s, sl in todo:
        rids[n] = h.submit_run(n, s, "D1", h.FULL_FROM, h.FULL_TO, sl)
        print("submitted", n, rids[n], flush=True)
    for n, s, sl in todo:
        d = h.wait_run(rids[n])
        out = {"run_id": rids[n], "status": d.get("status"), "error": d.get("error")}
        if d.get("status") == "succeeded":
            st, res = h.req("GET", f"/api/workbench/runs/{rids[n]}/result")
            out["metrics"] = res.get("metrics")
            out["trades"] = res.get("trades")
            out["net_value"] = res.get("net_value")
            out["config"] = d.get("config")
        json.dump(out, open(os.path.join(h.OUT, n + ".json"), "w"), ensure_ascii=False, indent=1)
        m = out.get("metrics") or {}
        print(f"{n}: {out['status']} ann={m.get('annualized_return')} mdd={m.get('max_drawdown')} "
              f"tr={m.get('trade_count')} pf={m.get('profit_factor')}", flush=True)

if __name__ == "__main__":
    main()
