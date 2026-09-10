#!/usr/bin/env python3
"""任务134 主涨段捕获策略（D1 多信号组合×多标的）研发实验 harness（仅经平台 REST，不改系统源码）。
改编自 coder/t0_strategy/harness.py；所有提交/结果落 coder/wave_strategy/runs/（run id 钉住复现）。"""
import json, os, sys, time, urllib.request, urllib.error

BASE = os.environ.get("EESTOCK_API", "http://127.0.0.1:8081")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")
os.makedirs(OUT, exist_ok=True)

# 全部标的均为 ETF：无印花税；佣金万0.5、无最低、滑点 2bp（与 133 口径一致）。
ETF_FEE = {"rate_pct": 0.005, "min_fee": 0.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0}

# 5 年窗口（日线回测上限）：2021-09-10 ~ 2026-09-10
FULL_FROM, FULL_TO = "2021-09-10T00:00:00Z", "2026-09-10T00:00:00Z"
# 时间切分：前 3.5 年调参，后 1.5 年冻结验证
TRAIN_FROM, TRAIN_TO = "2021-09-10T00:00:00Z", "2025-03-10T00:00:00Z"
OOS_FROM, OOS_TO = "2025-03-10T00:00:00Z", "2026-09-10T00:00:00Z"
SPLIT_TS = 1741536000  # 首个样本外 bar ts = 2025-03-10 00:00+08（平台 D1 bar ts 口径）

UNIVERSE = {
    "510050": "上证50ETF(宽基低波,T1)",
    "588000": "科创50ETF(宽基高波,T1)",
    "512480": "半导体ETF(行业高波,T1)",
    "515070": "人工智能ETF(行业高波,T1)",
    "512690": "酒ETF(行业消费,T1)",
    "518880": "黄金ETF(商品,T0)",
    "159985": "豆粕ETF(商品期货,T0)",
    "513050": "中概互联ETF(QDII高波,T0)",
}

def req(method, path, body=None, timeout=300):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "null")

def submit_run(name, symbol, period, frm, to, slots,
               buy_threshold=60, sell_threshold=40, stop=None, fee=None):
    body = {
        "name": name, "symbol": symbol, "period": period, "from": frm, "to": to,
        "slots": slots,
        "buy_threshold": buy_threshold, "sell_threshold": sell_threshold,
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "fee": fee or ETF_FEE,
    }
    if stop:
        body["stop"] = stop
    st, d = req("POST", "/api/workbench/runs", body)
    if st != 201:
        raise RuntimeError(f"submit {name} failed {st}: {d}")
    return d["id"]

def wait_run(run_id, poll=3, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, d = req("GET", f"/api/workbench/runs/{run_id}")
        if st == 200 and d.get("status") in ("succeeded", "failed", "canceled"):
            return d
        time.sleep(poll)
    raise TimeoutError(run_id)

def slice_metrics(net_value, trades, ts_from, ts_to):
    """从 net_value [[ts,nav],...] 与 trades 切片计算子区间指标（全窗 run 的样本内/外拆分）。
    trades 字段口径（平台实测）: open_ts/close_ts/pnl。"""
    import math
    navs = [(t, n) for t, n in net_value if ts_from <= t < ts_to]
    out = {"bars": len(navs)}
    if len(navs) < 2:
        return out
    t0, n0 = navs[0]
    t1, n1 = navs[-1]
    years = (t1 - t0) / (365.25 * 86400)
    out["total_return"] = n1 / n0 - 1
    out["annualized_return"] = (n1 / n0) ** (1 / years) - 1 if years > 0 else None
    peak, mdd = n0, 0.0
    rets = []
    prev = n0
    for _, n in navs[1:]:
        peak = max(peak, n)
        mdd = max(mdd, 1 - n / peak if n > 0 else 0)  # 标准口径 (peak-nav)/peak
        if prev > 0:
            rets.append(n / prev - 1)
        prev = n
    out["max_drawdown"] = mdd
    if rets:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / len(rets)
        sd = math.sqrt(var)
        if sd > 0:
            out["sharpe"] = mean / sd * math.sqrt(252)
    # trades 切片（按平仓时间）
    tr = [t for t in trades if ts_from <= (t.get("close_ts") or 0) < ts_to]
    out["trade_count"] = len(tr)
    if tr:
        pnls = [t.get("pnl", t.get("profit", 0)) for t in tr]
        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p < 0]
        out["win_rate"] = len(wins) / len(pnls)
        gp, gl = sum(wins), -sum(losses)
        out["profit_factor"] = gp / gl if gl > 0 else (float("inf") if gp > 0 else None)
    return out

def run_and_collect(name, keep_per_bar=False, **kw):
    rid = submit_run(name, **kw)
    d = wait_run(rid)
    out = {"run_id": rid, "status": d.get("status"), "error": d.get("error")}
    if d.get("status") == "succeeded":
        st, res = req("GET", f"/api/workbench/runs/{rid}/result")
        out["metrics"] = res.get("metrics")
        out["trades"] = res.get("trades")
        out["config"] = d.get("config")
        if keep_per_bar:
            out["net_value"] = res.get("net_value")
            out["drawdown"] = res.get("drawdown")
    path = os.path.join(OUT, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    m = out.get("metrics") or {}
    print(f"{name}: {out['status']} rid={rid} ann={m.get('annualized_return')} "
          f"mdd={m.get('max_drawdown')} trades={m.get('trade_count')} win={m.get('win_rate')} "
          f"pf={m.get('profit_factor')} sharpe={m.get('sharpe')}", flush=True)
    return out

def create_strategy(name, description, code):
    st, d = req("POST", "/api/strategies", {"name": name, "description": description, "code": code})
    if st != 201:
        raise RuntimeError(f"create failed {st}: {d}")
    return d["strategy"]["id"], d["version"]["id"]

def publish(version_id):
    st, d = req("POST", f"/api/strategies/versions/{version_id}/publish")
    if st not in (200, 201):
        raise RuntimeError(f"publish failed {st}: {d}")
    return d

def load_code(fname):
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "strategies", fname)
    with open(p, encoding="utf-8") as f:
        return f.read()

if __name__ == "__main__":
    print("harness module; import from experiment scripts")
