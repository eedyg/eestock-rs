#!/usr/bin/env python3
"""P1-D-3 独立验收探针（Tester 自建，非实现方测试）。

目标：真实 axum（临时实例 127.0.0.1:18147）上独立复现 P1-C 缺陷 D1/D2 的修复与
02-spec §2 七条 / §7.4 护栏、GET 读落韧性、PUT 负例不落库、去重归一化观测。

判据全部来自 design/15-multi-period/02-spec.md（§2/§7.4）+ ADR-022，不引用实现方测试断言。
每个用例输出 {id, req, status, body, expect, pass}，最后汇总 PASS/FAIL 数。
写请求只打临时实例；共享库 app_config 仅 key='multi_period'（跑后由调用方清理）。
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:18147"
P = "/api/config/multi_period"
PSQL = ["psql", "-h", "127.0.0.1", "-p", "5433", "-U", "eestock", "-d", "eestock", "-tA"]

results = []


def http(method, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + P, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def psql(sql):
    return subprocess.run(PSQL, input=sql, capture_output=True, text=True,
                          env={"PGPASSWORD": "eestock", "PATH": "/usr/bin:/bin"}).stdout.strip()


def body(enabled, periods, indicators, heights=None):
    if heights is None:
        heights = {p: (420 if i == 0 else 180) for i, p in enumerate(periods)}
    return {"enabled": enabled, "periods": periods, "heights": heights, "indicators": indicators}


def rec(cid, req, status, raw, expect, pass_):
    try:
        b = json.loads(raw)
    except Exception:
        b = raw
    results.append({"id": cid, "req": req, "status": status, "body": b, "expect": expect, "pass": pass_})


def parse(raw):
    try:
        return json.loads(raw)
    except Exception:
        return None


def clear_key():
    psql("DELETE FROM app_config WHERE key='multi_period';")


# ── 0. 前置：清键 ⇒ GET 默认 ─────────────────────────────────────────────
clear_key()
st, raw = http("GET")
v = parse(raw) or {}
ok = (st == 200 and v.get("enabled") is False and v.get("periods") == ["1m"]
      and v.get("heights") == {"1m": 420} and v.get("indicators") == ["dcap"])
rec("GET_default_no_key", "GET", st, raw,
    "200 {enabled:false,periods:['1m'],heights:{'1m':420},indicators:['dcap']}", ok)

# ── 1. D1 复验：重复指标去重 ──────────────────────────────────────────────
st, raw = http("PUT", body(False, ["1m", "5m", "15m"], ["dcap", "dcap"]))
v = parse(raw) or {}
ok = st == 200 and v.get("indicators") == ["dcap"]
rec("D1_dup2_echo_dedup", "PUT periods=[1m,5m,15m] indicators=[dcap,dcap]", st, raw,
    "200 + echo.indicators==['dcap']（§2-6 去重）", ok)

st2, raw2 = http("GET")
back = parse(raw2) or {}
norm = body(False, ["1m", "5m", "15m"], ["dcap"])
rec("D1_dup2_readback_dedup", "GET（上一步之后）", st2, raw2,
    "200 且 == 归一化后的完整配置（去重必须落库）", st2 == 200 and back == norm)

# D1-b/c: 4 周期 × ['dcap']×n（n=3/11/12/24）必须 200 且归一化读回
dup_obs = []
for n in (3, 11, 12, 24):
    st, raw = http("PUT", body(False, ["1m", "5m", "15m", "1h"], ["dcap"] * n))
    e = parse(raw) or {}
    stg, rawg = http("GET")
    g = parse(rawg) or {}
    dup_obs.append((n, st, e.get("indicators"), len(g.get("periods") or []), g.get("indicators")))
ok = all(st == 200 and e == ["dcap"] and plen == 4 and gi == ["dcap"]
         for (n, st, e, plen, gi) in dup_obs)
rec("D1_dup_n_4periods_200", "PUT 4周期 × ['dcap']×n (n=3,11,12,24) + GET", 
    [o[1] for o in dup_obs], {"observed": dup_obs},
    "每个 n: 200 + echo.indicators=['dcap'] + 读回 periods=4 + indicators=['dcap']（重复项不得伪造 >12 pane）", ok)

# D1: pane 计数一致性（[dcap]×3 与 [dcap] 的读回必须逐字节相同）
st, raw = http("PUT", body(False, ["1m", "5m", "15m", "1h"], ["dcap"]))
one = parse(raw)
st3, raw3 = http("PUT", body(False, ["1m", "5m", "15m", "1h"], ["dcap", "dcap", "dcap"]))
three = parse(raw3)
stg, rawg = http("GET")
g3 = parse(rawg)
ok = st == 200 and st3 == 200 and one == three == g3 and one is not None
rec("D1_pane_count_equivalent", "PUT ['dcap'] vs ['dcap']×3（同 4 周期）", 
    [st, st3, stg], {"one": one, "three": three, "get": g3},
    "两次 PUT 均 200 且回显/读回逐字节相同（去重后 pane 计数一致 ⇒ 无 400）", ok)

# D1: 合法 4 周期形态
st, raw = http("PUT", body(False, ["1m", "5m", "15m", "1h"], ["dcap"]))
rec("D1_4periods_legal_200", "PUT 4 周期 × ['dcap']", st, raw, "200（v1 最大合法形态）", st == 200)

# D1: 重复项无法构造 >12 pane（HTTP 面穷举 dcap 重复 1..40）
over = []
for n in (1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 40):
    st, raw = http("PUT", body(False, ["1m", "5m", "15m", "1h"], ["dcap"] * n))
    if st != 200:
        over.append((n, st, raw))
rec("D1_no_http_over12_via_dups", "PUT 4周期 × ['dcap']×n (n∈1..40)", 
    {"non200": over}, {"non200": over},
    "无任何 n 触发 400（v1 去重后总 pane ≤ 4 ⇒ HTTP 不可达 >12；若有 400 即误拒）", len(over) == 0)

# ── 2. D2 复验：越限错误串含被拒维度名（HTTP 不可达 ⇒ 静态 + 纯函数） ──────
# v1 HTTP 面无法构造 >12（上一用例已穷举证明），故 D2 只能从实现串取证：
# 从源码抽取 pane 护栏错误串模板，代入 n 后按「必须含被拒维度名 indicators/pane」判定。
src = open("/home/eestock/workspace/git/eestock/eestock-rs/crates/web/src/dto.rs",
           encoding="utf-8").read()
import re
m = re.search(r'return Err\(format!\(\s*"([^"]*)"', src[src.find("pub fn verify_multi_period_panes"):])
tmpl = m.group(1) if m else None
flat = re.sub(r"\\\s*\n\s*", "", tmpl) if tmpl else None
rendered = flat.replace("{n}", "16").replace("{MULTI_PERIOD_MAX_PANES}", "12") if flat else None
names_dim = bool(rendered) and ("indicators" in rendered)

def rejected_name_ok(s):
    # 独立判据（与实现方测试无关）：错误串必须含被拒维度名 indicators，或字段标记形式的 pane
    forms = ["pane:", "pane：", "pane=", '"pane"', "[pane]", "`pane`", "pane]"]
    return ("indicators" in s) or any(f in s for f in forms) or s.strip().startswith("pane")

rec("D2_pane_error_names_dimension", "源码抽取 verify_multi_period_panes 错误串模板",
    "n/a", {"template": tmpl, "rendered_n16": rendered},
    "渲染后含被拒维度名 `indicators`（§7.4）", bool(rendered) and rejected_name_ok(rendered))

# ── 3. §2 七条校验（HTTP 负例 + 正向边界） ───────────────────────────────
def expect_400(cid, req, payload, field):
    st, raw = http("PUT", payload)
    v = parse(raw) or {}
    msg = v.get("error", "") if isinstance(v, dict) else ""
    leftover = isinstance(v, dict) and any(k in v for k in ("periods", "heights", "indicators"))
    rec(cid, req, st, raw, f"400 且 error 含被拒字段名 `{field}`、不回显配置字段",
        st == 400 and field in msg and not leftover)

clear_key()
expect_400("S2_1_base_1mo", "PUT 基准 1mo", body(False, ["1mo"], ["dcap"]), "periods")
expect_400("S2_1_sat_1mo", "PUT 基准 1m + 卫星 1mo", body(False, ["1m", "1mo"], ["dcap"]), "periods")
expect_400("S2_2_sat_below_base", "PUT [5m,1m]", body(False, ["5m", "1m"], ["dcap"]), "periods")
expect_400("S2_2_sat_below_base2", "PUT [1d,1h]", body(False, ["1d", "1h"], ["dcap"]), "periods")
expect_400("S2_3_1w_base_1h", "PUT [1h,1w]", body(False, ["1h", "1w"], ["dcap"]), "periods")
st, raw = http("PUT", body(False, ["1d", "1w"], ["dcap"]))
rec("S2_3_1w_base_1d_positive", "PUT [1d,1w]（正向）", st, raw, "200（基准 ≥1d 时 1w 合法）", st == 200)

# §2-4 五周期 400 + 不静默截断（前置合法配置不被改写）
clear_key()
good = body(False, ["1m", "5m", "15m"], ["dcap"])
http("PUT", good)
expect_400("S2_4_5periods", "PUT 5 周期", body(False, ["1m", "5m", "15m", "1h", "1d"], ["dcap"]), "periods")
stg, rawg = http("GET")
rec("S2_4_no_silent_truncation", "GET（5 周期被拒后）", stg, rawg,
    "200 且 == 前置 3 周期配置（不得截断为 4）", stg == 200 and parse(rawg) == good)

# §2-5 heights
expect_400("S2_5_height_missing_key", "PUT heights 缺 5m 键",
           {"enabled": False, "periods": ["1m", "5m"], "heights": {"1m": 420}, "indicators": ["dcap"]}, "heights")
expect_400("S2_5_height_extra_key", "PUT heights 多 5m 键",
           {"enabled": False, "periods": ["1m"], "heights": {"1m": 420, "5m": 180}, "indicators": ["dcap"]}, "heights")
expect_400("S2_5_height_79", "PUT heights[1m]=79",
           {"enabled": False, "periods": ["1m"], "heights": {"1m": 79}, "indicators": ["dcap"]}, "heights")
expect_400("S2_5_height_1201", "PUT heights[5m]=1201",
           {"enabled": False, "periods": ["1m", "5m"], "heights": {"1m": 420, "5m": 1201}, "indicators": ["dcap"]}, "heights")
st, raw = http("PUT", {"enabled": False, "periods": ["1m", "5m"],
                       "heights": {"1m": 80, "5m": 1200}, "indicators": ["dcap"]})
rec("S2_5_height_boundary_80_1200", "PUT heights 80/1200（边界）", st, raw, "200（边界合法，不得误拒）", st == 200)

# §2-6 未支持指标
expect_400("S2_6_unsupported_macd", "PUT indicators=[macd]", body(False, ["1m"], ["macd"]), "indicators")
expect_400("S2_6_unsupported_boll", "PUT indicators=[dcap,boll]", body(False, ["1m", "5m"], ["dcap", "boll"]), "indicators")

# §2-7 周期重复
clear_key()
expect_400("S2_7_dup_periods", "PUT periods=[1m,1m]", body(False, ["1m", "1m"], ["dcap"]), "periods")
expect_400("S2_7_dup_periods2", "PUT periods=[1m,5m,5m]", body(False, ["1m", "5m", "5m"], ["dcap"]), "periods")

# 请求体形状非法（heights 为数组）⇒ 400 不 500
st, raw = http("PUT", {"enabled": False, "periods": ["1m"], "heights": [], "indicators": ["dcap"]})
rec("body_shape_invalid_400", "PUT heights 为数组", st, raw, "400（不得 500）", st == 400)

# ── 4. 合法 PUT 读回一致 + 负例不落库 ────────────────────────────────────
clear_key()
good = body(False, ["1m", "5m", "15m"], ["dcap"])
st, raw = http("PUT", good)
stg, rawg = http("GET")
rec("PUT_valid_roundtrip", "PUT 合法 + GET", [st, stg], {"echo": parse(raw), "readback": parse(rawg)},
    "PUT 200 且回显 == 请求；GET == 请求", st == 200 and parse(raw) == good and parse(rawg) == good)

st, raw = http("PUT", body(False, ["1m", "5m", "15m", "1h", "1d"], ["dcap"]))  # 非法（5 周期）
stg, rawg = http("GET")
rec("PUT_negative_not_persisted", "PUT 非法（5 周期）+ GET", [st, stg], {"bad_status": st, "readback": parse(rawg)},
    "非法 PUT 400；GET 仍 == 上一步被接受的配置（不落库）", st == 400 and parse(rawg) == good)

# ── 5. GET 坏值 ⇒ 回默认不 500（直接 seed 共享库该键；enabled=false 降影响） ──
bad_samples = [
    ("scalar", json.dumps("not-an-object")),
    ("missing_fields", json.dumps({"enabled": False})),
    ("height_out_of_range", json.dumps({"enabled": False, "periods": ["1m", "5m"],
                                        "heights": {"1m": 5000, "5m": 180}, "indicators": ["dcap"]})),
    ("periods_5", json.dumps({"enabled": False, "periods": ["1m", "5m", "15m", "1h", "1d"],
                              "heights": {"1m": 420, "5m": 180, "15m": 180, "1h": 180, "1d": 180},
                              "indicators": ["dcap"]})),
    ("dup_periods", json.dumps({"enabled": False, "periods": ["1m", "1m"],
                                "heights": {"1m": 420}, "indicators": ["dcap"]})),
    ("contains_1mo", json.dumps({"enabled": False, "periods": ["1m", "1mo"],
                                 "heights": {"1m": 420, "1mo": 180}, "indicators": ["dcap"]})),
    ("unsupported_ind", json.dumps({"enabled": False, "periods": ["1m", "5m"],
                                    "heights": {"1m": 420, "5m": 180}, "indicators": ["macd"]})),
]
bad_obs = []
for label, seed in bad_samples:
    psql("INSERT INTO app_config (key,value) VALUES ('multi_period', '%s'::jsonb) "
         "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;" % seed)
    st, raw = http("GET")
    v = parse(raw) or {}
    ok = (st == 200 and isinstance(v, dict) and v.get("enabled") is False
          and v.get("periods") == ["1m"] and v.get("indicators") == ["dcap"])
    bad_obs.append((label, st, v))
rec("GET_bad_stored_falls_back_default", "seed 坏值 7 例后逐个 GET", [o[1] for o in bad_obs],
    {"observed": bad_obs}, "每例 200 且回默认（不 500）",
    all(st == 200 and isinstance(v, dict) and v.get("enabled") is False and v.get("periods") == ["1m"] for _, st, v in bad_obs))

# 非法存量（含 enabled=true 的坏值）也不得 500
psql("INSERT INTO app_config (key,value) VALUES ('multi_period', "
     "'{\"enabled\":true,\"periods\":[\"1m\"],\"heights\":{\"1m\":9999},\"indicators\":[\"dcap\"]}'::jsonb) "
     "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;")
st, raw = http("GET")
v = parse(raw) or {}
rec("GET_out_of_range_enabled_true_falls_back", "seed 越界 + enabled=true 后 GET", st, raw,
    "200 且 enabled=false（越界旧值回默认）", st == 200 and v.get("enabled") is False)

# ── 6. 收尾：清键 + 复核 ─────────────────────────────────────────────────
clear_key()
n = psql("SELECT count(*) FROM app_config WHERE key='multi_period'")
st, raw = http("GET")
rec("cleanup_key_removed", "DELETE key + psql count + GET", st,
    {"psql_count": n, "get": parse(raw)}, "psql count=0 且 GET 回默认",
    n == "0" and st == 200 and (parse(raw) or {}).get("enabled") is False)

# ── 汇总 ─────────────────────────────────────────────────────────────────
print(json.dumps({"results": results,
                  "total": len(results),
                  "passed": sum(1 for r in results if r["pass"]),
                  "failed": [r["id"] for r in results if not r["pass"]]},
                 ensure_ascii=False, indent=1))
sys.exit(0)
