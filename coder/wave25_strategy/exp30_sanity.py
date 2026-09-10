#!/usr/bin/env python3
"""任务136 exp30 阶段0：工程口径再校验 + 上轮基线复现。
(1) 本地引擎跑冻结交付配置 Donchian(20/15) 全窗×510050，与上轮平台冻结 run 逐位比对；
(2) 训练窗复现上轮 eng_b15_X3（brk20/exit15 纯突破）逐标的数值；
(3) 对照件：裸 Donchian brk60/brk120（无结构前提，H-A 关键对照臂）。
全部结果落 runs/ 钉住。"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as h
import exp_lib as el

DON = el.os.path.join(os.path.dirname(os.path.abspath(__file__)), "strategies", "wave_donchian_final.js")
CODE = open(DON, encoding="utf-8").read()

def slot(params, weight=1.0):
    return {"code": CODE, "params": params, "weight": weight}

print("== (1) 引擎 vs 平台：冻结配置 Donchian(20/15) 全窗 510050 ==", flush=True)
m, res = el.engine_run([slot({})], "510050", frm=h.FULL_FROM, to=h.FULL_TO,
                       tag="sanity_fzA", keep_nav=True)
# 上轮平台冻结 run（路径A×510050）
prev = json.load(open(os.path.join("..", "wave_strategy", "runs", "fz_pathA_510050.json")))
pm = prev["metrics"]
keys = ["net_profit", "annualized_return", "max_drawdown", "trade_count", "win_rate"]
diffs = {k: (m.get(k), pm.get(k), abs((m.get(k) or 0) - (pm.get(k) or 0))) for k in keys}
print(json.dumps(diffs, indent=1, default=str), flush=True)
ok = all(d[2] < 1e-6 if isinstance(d[0], float) else d[0] == d[1] for d in diffs.values())
print("BITWISE_MATCH:", ok, flush=True)

print("== (2) 训练窗复现上轮 X3（brk20/exit15）8 标的 ==", flush=True)
for sym in h.UNIVERSE:
    m, _ = el.engine_run([slot({})], sym, tag="s30_x3")
    prevf = os.path.join("..", "wave_strategy", "runs", f"eng_b15_X3_exit15_{sym}.json")
    if os.path.exists(prevf):
        p = json.load(open(prevf))["metrics"]
        print(f"{sym}: now ann={m['annualized_return']*100:.2f}% tr={m['trade_count']} | "
              f"prev ann={p['annualized_return']*100:.2f}% tr={p['trade_count']}", flush=True)

print("== (3) 对照臂：裸 Donchian brk60 / brk120（无结构前提）训练窗 ==", flush=True)
for brk in (60, 120):
    anns = []
    for sym in h.UNIVERSE:
        m, _ = el.engine_run([slot({"brk_n": brk})], sym, tag=f"s30_d{brk}")
        anns.append(m["annualized_return"])
        print(f"  brk{brk} {sym}: {el.fmt(m)}", flush=True)
    print(f"brk{brk} 训练均值: {sum(anns)/len(anns)*100:.2f}% 最差: {min(anns)*100:.2f}%", flush=True)
