#!/usr/bin/env python3
"""P1-C 独立 T6 请求脚本（Tester 自建；只打临时实例 127.0.0.1:18099）。"""
import json, urllib.request, urllib.error

BASE = "http://127.0.0.1:18099"
PATH = "/api/config/multi_period"
res = []

def call(method, body=None):
    req = urllib.request.Request(BASE + PATH, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def case(name, method, body, expect_status, expect_field=None):
    st, txt = call(method, body)
    ok = st == expect_status and (expect_field is None or expect_field in txt)
    res.append({"case": name, "method": method, "body": body, "status": st,
                "expect": expect_status, "expect_field": expect_field,
                "field_present": (expect_field in txt) if expect_field else None,
                "ok": ok, "resp": txt[:400]})
    return st, txt

LEGAL = {"enabled": False, "periods": ["1m", "5m", "15m"],
         "heights": {"1m": 420, "5m": 180, "15m": 180}, "indicators": ["dcap"]}

def vary(**kw):
    d = json.loads(json.dumps(LEGAL)); d.update(kw); return d

# 0) 基线 GET（无键 ⇒ 默认，200）
case("GET 无键 ⇒ 200 默认", "GET", None, 200)
res[-1]["resp_default_enabled_false"] = '"enabled"' in res[-1]["resp"] and "false" in res[-1]["resp"]

# 1) periods[0] = 1mo ⇒ 400
case("S2-1 基准=1mo", "PUT", vary(periods=["1mo", "5m"], heights={"1mo": 420, "5m": 180}), 400, "periods")
# 2) 卫星 = 1mo ⇒ 400
case("S2-1 卫星=1mo", "PUT", vary(periods=["1m", "1mo"], heights={"1m": 420, "1mo": 180}), 400, "periods")
# 3) 卫星 < 基准 ⇒ 400
case("S2-2 卫星<基准(15m→5m)", "PUT", vary(periods=["15m", "5m"], heights={"15m": 420, "5m": 180}), 400, "periods")
# 3b) 含 1w 且基准 < 1d ⇒ 400
case("S2-3 含1w但基准=1h", "PUT", vary(periods=["1h", "1w"], heights={"1h": 420, "1w": 180}), 400, "periods")
# 3c) 含 1w 基准=1d ⇒ 合法（正向对照）
case("S2-3 正向 基准=1d+1w", "PUT", vary(periods=["1d", "1w"], heights={"1d": 420, "1w": 180}), 200)
# 4) 周期数 > 4 ⇒ 400
case("S2-4 周期数5>4", "PUT", vary(periods=["1m", "5m", "15m", "1h", "1d"],
                                  heights={"1m": 420, "5m": 180, "15m": 180, "1h": 180, "1d": 180}), 400)
# 5a) heights 键不一致 ⇒ 400
case("S2-5 heights键缺项", "PUT", vary(heights={"1m": 420, "5m": 180}), 400)
case("S2-5 heights键多项", "PUT", vary(heights={"1m": 420, "5m": 180, "15m": 180, "1d": 100}), 400)
# 5b) heights 越界 ⇒ 400
case("S2-5 height=79", "PUT", vary(heights={"1m": 79, "5m": 180, "15m": 180}), 400)
case("S2-5 height=1201", "PUT", vary(heights={"1m": 420, "5m": 1201, "15m": 180}), 400)
# 5c) 边界内合法：80 / 1200 ⇒ 200
case("S2-5 边界 80/1200 合法", "PUT", vary(heights={"1m": 80, "5m": 180, "15m": 1200}), 200)
# 6) indicators 不支持项 ⇒ 400
case("S2-6 indicators=macd", "PUT", vary(indicators=["macd"]), 400, "indicators")
# 6b) §7.4 pane 预算经 HTTP 不可达（v1 指标集仅 dcap）⇒ 400 但被拒字段是 indicators
case("S7.4 11×dcap 经 HTTP 被 indicators 拒", "PUT", vary(indicators=["dcap"] * 11), 400, "indicators")
# 7) 周期重复 ⇒ 400
case("S2-7 周期重复", "PUT", vary(periods=["1m", "5m", "1m"], heights={"1m": 420, "5m": 180}), 400)
# 8) 负例不落库：当前 GET 必须仍为默认
st, txt = call("GET")
after_neg = {"enabled" in txt and '"enabled":false' in txt.replace(" ", "")}
res.append({"case": "负例后 GET 仍默认（未落库）", "status": st, "resp": txt[:300], "ok": st == 200 and after_neg is True})
# 9) 合法 PUT ⇒ 200 且读回一致
LEGAL4 = {"enabled": False, "periods": ["1m", "5m", "15m", "1h"],
          "heights": {"1m": 420, "5m": 180, "15m": 180, "1h": 180}, "indicators": ["dcap"]}
st, txt = call("PUT", LEGAL4)
back = json.loads(call("GET")[1])
res.append({"case": "边界：v1 最大合法形态（4 周期）PUT", "status": st, "ok": st == 200,
            "resp": txt[:200], "readback_identical": back.get("periods") == LEGAL4["periods"] and back.get("heights") == LEGAL4["heights"]})
# 10) 去重语义（indicators 重复）
case("S2-6 indicators 重复（去重 or 400）", "PUT", vary(indicators=["dcap", "dcap"]), 200)
# 11) enabled=true 且未选周期不成合法？(periods 单基准)
case("enabled=true 单基准 合法", "PUT", vary(enabled=True, periods=["1m"], heights={"1m": 420}), 200)

print(json.dumps(res, ensure_ascii=False, indent=1))
print("TOTAL", len(res), "FAILED", sum(1 for r in res if not r["ok"]))
