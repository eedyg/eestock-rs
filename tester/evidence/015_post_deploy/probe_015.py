#!/usr/bin/env python3
"""015 部署后验收探针（只读；对运行中的生产 MCP :8082 发 JSON-RPC over SSE）。

用法:
  python3 probe_015.py <spec.json> <outdir>

spec.json 形如:
  [{"file":"01_tools_list.json","method":"tools/list","params":{}},
   {"file":"02_x.json","method":"tools/call","params":{"name":"get_kline","arguments":{...}}}]

每个条目: 打开独立 SSE 会话 → POST /messages → 取首帧 → 原样写入 <outdir>/<file>
同时写 <outdir>/_probe_015_raw.log 记录 HTTP 状态/耗时/会话 id。
"""
import json
import os
import sys
import threading
import time
import urllib.request

BASE = "http://127.0.0.1:8082"
TIMEOUT = 30.0


def one_call(method, params, log):
    resp = urllib.request.urlopen(BASE + "/sse", timeout=TIMEOUT)
    endpoint = None
    frames = []
    done = threading.Event()

    def reader():
        nonlocal endpoint
        try:
            _read_loop()
        except Exception:
            pass

    def _read_loop():
        nonlocal endpoint
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("data: "):
                data = line[len("data: "):]
                if endpoint is None and data.startswith("/messages?sessionId="):
                    endpoint = data
                    done.set()
                    continue
                frames.append(data)
            if line.startswith(":ka"):
                log.append("# keepalive")

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    done.wait(timeout=TIMEOUT)
    if not endpoint:
        try:
            resp.close()
        except Exception:
            pass
        raise RuntimeError("no endpoint frame")
    sid = endpoint.split("sessionId=", 1)[1]
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(BASE + endpoint, data=body,
                                 headers={"content-type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        status = r.status
    deadline = time.time() + TIMEOUT
    while not frames and time.time() < deadline:
        time.sleep(0.05)
    dt = int((time.time() - t0) * 1000)
    try:
        resp.close()
    except Exception:
        pass
    log.append(f"# {method} {json.dumps(params, ensure_ascii=False)[:200]} -> POST {status} {dt}ms session={sid[:8]}")
    return frames[0] if frames else "<no frame>"


def main():
    spec = json.load(open(sys.argv[1]))
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    log = []
    for item in spec:
        method = item["method"]
        params = item.get("params", {})
        try:
            frame = one_call(method, params, log)
        except Exception as e:  # 探针自身异常也如实记录
            frame = f"<PROBE ERROR: {e}>"
            log.append(f"# ERROR {method}: {e}")
        path = os.path.join(outdir, item["file"])
        with open(path, "w") as f:
            f.write(frame + "\n")
        print(f"[saved] {item['file']} ({len(frame)} bytes) {frame[:120]!r}")
    with open(os.path.join(outdir, "_probe_015_raw.log"), "a") as f:
        f.write("\n".join(log) + "\n")


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
