#!/usr/bin/env python3
"""T+0 ETF 做T 策略研发实验 harness（仅经平台 REST，不改系统源码）。
用法见文件尾 main。所有提交/结果落 coder/t0_strategy/runs/ 便于复现（run id 钉住）。"""
import json, os, sys, time, urllib.request, urllib.error

BASE = os.environ.get("EESTOCK_API", "http://127.0.0.1:8081")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")
os.makedirs(OUT, exist_ok=True)

ETF_FEE = {"rate_pct": 0.005, "min_fee": 0.0, "slippage_bp": 2.0, "stamp_duty_pct": 0.0}

def req(method, path, body=None, timeout=120):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "null")

def submit_run(name, symbol, period, frm, to, version_id, params=None,
               buy_threshold=60, sell_threshold=40, stop=None, fee=None, weight=1):
    body = {
        "name": name, "symbol": symbol, "period": period, "from": frm, "to": to,
        "slots": [{"version_id": version_id, "weight": weight, "params": params or {}}],
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

def wait_run(run_id, poll=3, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, d = req("GET", f"/api/workbench/runs/{run_id}")
        if st == 200 and d.get("status") in ("succeeded", "failed", "canceled"):
            return d
        time.sleep(poll)
    raise TimeoutError(run_id)

def run_and_collect(name, **kw):
    rid = submit_run(name, **kw)
    d = wait_run(rid)
    out = {"run_id": rid, "status": d.get("status"), "error": d.get("error")}
    if d.get("status") == "succeeded":
        st, res = req("GET", f"/api/workbench/runs/{rid}/result")
        out["metrics"] = res.get("metrics")
        out["trades"] = res.get("trades")
        out["config"] = d.get("config")
    path = os.path.join(OUT, f"{name}.json")
    # 结果文件不含 per_bar（体积大），需要时可按 run_id 拉取
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    m = out.get("metrics") or {}
    print(f"{name}: {out['status']} rid={rid} ann={m.get('annualized_return')} "
          f"mdd={m.get('max_drawdown')} trades={m.get('trade_count')} win={m.get('win_rate')} "
          f"pf={m.get('profit_factor')} sharpe={m.get('sharpe')}")
    return out

def test_run(code, params, symbol, period, frm, to, mode="sim_position", tag=""):
    body = {"code": code, "params": params, "symbol": symbol, "period": period,
            "from": frm, "to": to, "mode": mode}
    st, d = req("POST", "/api/strategies/test-run", body, timeout=300)
    if st != 200:
        raise RuntimeError(f"test_run {tag} failed {st}: {str(d)[:300]}")
    path = os.path.join(OUT, f"testrun_{tag}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    return d

def create_strategy(name, description, code):
    st, d = req("POST", "/api/strategies", {"name": name, "description": description, "code": code})
    if st != 201:
        raise RuntimeError(f"create failed {st}: {d}")
    return d["strategy"]["id"], d["version"]["id"]

def new_draft_version(strategy_id, from_version_id):
    st, d = req("POST", f"/api/strategies/{strategy_id}/versions", {"from_version_id": from_version_id})
    if st != 201:
        raise RuntimeError(f"new draft failed {st}: {d}")
    return d["id"]

def update_version_code(version_id, code):
    for method, path, body in [
        ("PATCH", f"/api/strategies/versions/{version_id}", {"code": code}),
        ("PUT", f"/api/strategies/versions/{version_id}", {"code": code}),
    ]:
        st, d = req(method, path, body)
        if st in (200, 201):
            return d
    raise RuntimeError(f"update code failed {st}: {d}")

def publish(version_id):
    st, d = req("POST", f"/api/strategies/versions/{version_id}/publish")
    if st not in (200, 201):
        raise RuntimeError(f"publish failed {st}: {d}")
    return d

if __name__ == "__main__":
    print("harness module; import from experiment scripts")
