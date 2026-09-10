#!/usr/bin/env python3
"""阶段0：基线。8 标的 × {买入持有, dual_ma(seed), momentum(seed)} 全 5 年 D1。
买入持有策略（buy_hold.js）先经 REST 创建为 draft 版本。全部钉 run id。"""
import json, os, sys
import harness as h

SEED_DUAL_MA = "sv_1789013713975_000001"   # 双均线交叉 v1 published
SEED_MOMENTUM = "sv_1789013714002_000011"  # 动量突破 v1 published

def main():
    # 1) 买入持有基线策略（幂等：runs/ 下记录过则复用）
    idfile = os.path.join(h.OUT, "_ids.json")
    ids = json.load(open(idfile)) if os.path.exists(idfile) else {}
    if "buy_hold_version" not in ids:
        sid, vid = h.create_strategy("基线·买入持有(实验用)", "恒定 80 分，LumpSum 满仓后即买入持有；仅基线测量",
                                     h.load_code("buy_hold.js"))
        ids["buy_hold_version"] = vid
        ids["buy_hold_strategy"] = sid
        json.dump(ids, open(idfile, "w"), ensure_ascii=False, indent=1)
        print("created buy_hold:", sid, vid)
    bh = ids["buy_hold_version"]

    jobs = []
    for sym in h.UNIVERSE:
        jobs.append((f"base_hold_{sym}", sym, [{"version_id": bh, "weight": 1, "params": {}}]))
        jobs.append((f"base_dualma_{sym}", sym, [{"version_id": SEED_DUAL_MA, "weight": 1, "params": {}}]))
        jobs.append((f"base_momentum_{sym}", sym, [{"version_id": SEED_MOMENTUM, "weight": 1, "params": {}}]))

    # 幂等：已存在 run 快照则跳过
    todo = [(n, s, sl) for n, s, sl in jobs if not os.path.exists(os.path.join(h.OUT, n + ".json"))]
    print(f"{len(todo)} runs to submit (of {len(jobs)})")
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
            out["config"] = d.get("config")
        json.dump(out, open(os.path.join(h.OUT, n + ".json"), "w"), ensure_ascii=False, indent=1)
        m = out.get("metrics") or {}
        print(f"{n}: {out['status']} ann={m.get('annualized_return')} mdd={m.get('max_drawdown')} "
              f"trades={m.get('trade_count')} pf={m.get('profit_factor')}", flush=True)

if __name__ == "__main__":
    main()
