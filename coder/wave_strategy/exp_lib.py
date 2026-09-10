#!/usr/bin/env python3
"""阶段1迭代库：日线数据缓存（只读 SQL 侦察，口径已与平台 D1 bar 对齐验证）+
test-run 交易回放 → 本地指标（ann/mdd/pf/win/sharpe/trades/avg_hold）。
注意：test-run 为固定费口径（含 0.05% 印花税），仅用于训练窗内排序；终选配置一律走 workbench 钉 run id。"""
import json, math, os, subprocess
import harness as h

BAR_CACHE = {}
ENGINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mini_engine.js")

def engine_run(slots, symbol, frm=h.TRAIN_FROM, to=h.TRAIN_TO, buy=60, sell=40,
               fee=None, tag="", keep_nav=False):
    """本地迷你引擎（已与 workbench 逐位校验一致）。slots: [{code, params, weight}]。
    结果落 runs/eng_{tag}_{symbol}.json（fee 正确口径，可用作排序与终选候选筛选）。"""
    bars = daily_bars(symbol, frm, to)
    job = {"bars": bars, "slots": slots, "buy_threshold": buy, "sell_threshold": sell,
           "fee": fee or h.ETF_FEE, "initial_capital": 100000, "keep_nav": keep_nav}
    jp = os.path.join(h.OUT, f"_job_{tag}_{symbol}.json")
    json.dump(job, open(jp, "w"))
    out = subprocess.run(["node", ENGINE, jp], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"engine {tag} {symbol}: {out.stderr[:500]}")
    res = json.loads(out.stdout)
    json.dump({"tag": tag, "symbol": symbol,
               "slots": [{"params": s.get("params"), "weight": s.get("weight"),
                          "code_sha1": __import__("hashlib").sha1(s["code"].encode()).hexdigest()[:10]} for s in slots],
               "metrics": res["metrics"], "trades": res["trades"]},
              open(os.path.join(h.OUT, f"eng_{tag}_{symbol}.json"), "w"), ensure_ascii=False, indent=1)
    return res["metrics"], res

def hold_baseline(symbol, frm=h.TRAIN_FROM, to=h.TRAIN_TO):
    """买入持有本地基线（无费 close-to-close）。"""
    bars = daily_bars(symbol, frm, to)
    r = bars[-1]["close"] / bars[0]["close"] - 1
    ann = (1 + r) ** (252 / len(bars)) - 1
    peak, mdd = 0.0, 0.0
    for b in bars:
        peak = max(peak, b["close"])
        mdd = max(mdd, 1 - b["close"] / peak)
    return {"annualized_return": ann, "max_drawdown": mdd}

def daily_bars(symbol, frm=h.FULL_FROM, to=h.FULL_TO):
    """与平台 D1 bar 对齐的日线（510050 已逐日比对 1209/1209 一致）。
    缓存为全窗文件 bars_{symbol}.json，按 [frm,to) 切片返回。"""
    key = (symbol, frm, to)
    if key in BAR_CACHE:
        return BAR_CACHE[key]
    cache = os.path.join(h.OUT, f"bars_{symbol}.json")
    if os.path.exists(cache):
        full = json.load(open(cache))
    else:
        full = _fetch_bars(symbol)
        json.dump(full, open(cache, "w"))
    import datetime
    def epoch(s):
        return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    f0, f1 = epoch(frm), epoch(to)
    bars = [b for b in full if f0 <= b["ts"] < f1]
    BAR_CACHE[key] = bars
    return bars

def _fetch_bars(symbol, frm=h.FULL_FROM, to=h.FULL_TO):
    q = f"""
COPY (
WITH d AS (
  SELECT (ts + interval '8 hours')::date AS day,
         (array_agg(open ORDER BY ts))[1] AS o,
         max(high) AS hi, min(low) AS lo,
         (array_agg(close ORDER BY ts DESC))[1] AS c,
         sum(volume) AS v
  FROM kline_accurate
  WHERE code='{symbol}' AND ts >= '{frm}'::timestamptz
                        AND ts <  '{to}'::timestamptz
  GROUP BY 1)
SELECT extract(epoch FROM day::timestamp - interval '8 hours')::bigint, o, hi, lo, c, v
FROM d
WHERE day::timestamp - interval '8 hours' >= '{frm}'::timestamptz
  AND day::timestamp - interval '8 hours' <  '{to}'::timestamptz
ORDER BY 1) TO STDOUT WITH CSV;
"""
    env = {"PGPASSWORD": "eestock", "PATH": "/usr/bin:/bin"}
    out = subprocess.run(["psql", "-h", "127.0.0.1", "-p", "5433", "-U", "eestock", "-d", "eestock", "-c", q],
                         env=env, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr)
    bars = []
    for line in out.stdout.strip().splitlines():
        ts, o, hi, lo, c, v = line.split(",")
        bars.append({"ts": int(ts), "open": float(o), "high": float(hi),
                     "low": float(lo), "close": float(c), "volume": float(v)})
    return bars

def eval_trades(trades, bars, initial=100000.0):
    """按成交回放净值（开盘价成交于 open_bar，平仓于 close_bar），输出与平台同语义指标。"""
    if not bars:
        return {}
    closes = [b["close"] for b in bars]
    n = len(bars)
    nav = [initial] * n
    cash, shares = initial, 0.0
    # 事件回放：同一 bar 先卖后买；费用（往返佣金+印花税）在平仓事件一次性扣除。
    events = []
    for t in trades:
        events.append((t["open_bar"], 1, t))
        events.append((t["close_bar"], 0, t))
    events.sort(key=lambda e: (e[0], e[1]))
    ei = 0
    for i in range(n):
        while ei < len(events) and events[ei][0] == i:
            _, kind, t = events[ei]
            if kind == 1:
                shares = t["shares"]
                cash -= shares * t["open_price"]
            else:
                cash += shares * t["close_price"] - t.get("commission", 0) - t.get("stamp_duty", 0)
                shares = 0.0
            ei += 1
        nav[i] = cash + shares * closes[i]
    years = (bars[-1]["ts"] - bars[0]["ts"]) / (365.25 * 86400)
    total = nav[-1] / initial - 1
    ann = (1 + total) ** (1 / years) - 1 if years > 0 else None
    peak, mdd = nav[0], 0.0
    rets = []
    for i in range(1, n):
        peak = max(peak, nav[i])
        if nav[i] > 0:
            mdd = max(mdd, 1 - nav[i] / peak)  # 标准口径 (peak-nav)/peak，与平台一致
        if nav[i - 1] > 0:
            rets.append(nav[i] / nav[i - 1] - 1)
    pnls = [t["pnl"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    # 平台 profit_factor 口径 = 平均盈利/平均亏损（盈亏比），经 base_dualma_510050 逐笔核对。
    pf = None
    if wins and losses:
        pf = (sum(wins) / len(wins)) / (-sum(losses) / len(losses))
    elif wins:
        pf = float("inf")
    mean = sum(rets) / len(rets) if rets else 0
    sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / len(rets)) if rets else 0
    return {
        "total_return": total, "annualized_return": ann, "max_drawdown": mdd,
        "trade_count": len(trades),
        "win_rate": len(wins) / len(pnls) if pnls else None,
        "profit_factor": pf,
        "sharpe": mean / sd * math.sqrt(252) if sd > 0 else None,
        "avg_hold_bars": sum(t["hold_bars"] for t in trades) / len(trades) if trades else None,
    }

def eval_strategy(code, params, symbol, frm, to, tag=""):
    """test-run（sim_position）+ 本地指标。返回 (metrics, raw)。"""
    st, d = h.req("POST", "/api/strategies/test-run", {
        "code": code, "params": params, "symbol": symbol, "period": "D1",
        "from": frm, "to": to, "mode": "sim_position"})
    if st != 200:
        raise RuntimeError(f"test_run {tag} {symbol} failed {st}: {str(d)[:300]}")
    bars = daily_bars(symbol, frm, to)
    if len(bars) != d.get("bar_count"):
        raise RuntimeError(f"bar 数不一致 {tag} {symbol}: local={len(bars)} run={d.get('bar_count')}")
    m = eval_trades(d.get("trades") or [], bars)
    path = os.path.join(h.OUT, f"tr_{tag}_{symbol}.json")
    json.dump({"tag": tag, "symbol": symbol, "params": params, "metrics": m,
               "trades": d.get("trades"), "events": (d.get("events") or [])[:20]},
              open(path, "w"), ensure_ascii=False, indent=1)
    return m, d

def fmt(m):
    if not m:
        return "no-data"
    def p(x, pct=True):
        return "n/a" if x is None else (f"{x*100:.1f}%" if pct else f"{x:.2f}")
    return (f"ann={p(m.get('annualized_return'))} mdd={p(m.get('max_drawdown'))} "
            f"tr={m.get('trade_count')} win={p(m.get('win_rate'))} "
            f"pf={p(m.get('profit_factor'), False)} shp={p(m.get('sharpe'), False)} "
            f"hold={p(m.get('avg_hold_bars'), False)}")
