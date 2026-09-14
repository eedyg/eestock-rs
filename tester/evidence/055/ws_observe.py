"""只读诊断：连临时实例（18099）观察 bar 推送契约（端点/消息类型/频率/payload）。"""
import asyncio, json, sys, time
import websockets

URL = "ws://127.0.0.1:18099/ws"
CODE = sys.argv[1] if len(sys.argv) > 1 else "513310"
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 210.0
PERIODS = ["1m", "5m", "15m", "1h", "1d"]


async def main():
    t0 = time.time()
    print(f"# connect {URL} code={CODE} dur={DUR}s t0={time.strftime('%H:%M:%S')}", flush=True)
    async with websockets.connect(URL) as ws:
        for p in PERIODS:
            frame = {"type": "subscribe", "topic": "bar", "code": CODE, "period": p}
            await ws.send(json.dumps(frame))
            print(f"[{time.time()-t0:7.2f}] SENT {json.dumps(frame)}", flush=True)
        await ws.send(json.dumps({"type": "subscribe", "topic": "quote", "code": CODE}))
        print(f"[{time.time()-t0:7.2f}] SENT quote subscribe", flush=True)
        while time.time() - t0 < DUR:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.5, DUR - (time.time() - t0)))
            except asyncio.TimeoutError:
                break
            el = time.time() - t0
            try:
                m = json.loads(raw)
                t = m.get("type")
                if t == "bar":
                    bar = m.get("bar") or {}
                    print(f"[{el:7.2f}] BAR   code={m.get('code')} period={m.get('period')} "
                          f"bar.ts={bar.get('ts')} o={bar.get('open')} h={bar.get('high')} l={bar.get('low')} "
                          f"c={bar.get('close')} v={bar.get('volume')} src={bar.get('source')}", flush=True)
                elif t == "quote":
                    print(f"[{el:7.2f}] QUOTE code={m.get('code')} ts={m.get('ts')} last={m.get('last')} "
                          f"changePct={m.get('changePct')}", flush=True)
                else:
                    print(f"[{el:7.2f}] {t.upper()} {json.dumps(m)[:200]}", flush=True)
            except Exception as e:  # noqa
                print(f"[{el:7.2f}] RAW {raw[:200]} ({e})", flush=True)
    print(f"# done t1={time.strftime('%H:%M:%S')} elapsed={time.time()-t0:.1f}s", flush=True)


asyncio.run(main())
