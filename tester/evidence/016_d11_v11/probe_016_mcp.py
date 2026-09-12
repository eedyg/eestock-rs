#!/usr/bin/env python3
"""016 D11 v1.1 复验探针：对**替代端口**实例的 MCP :18082 发 JSON-RPC over SSE。

用法:
  python3 probe_016_mcp.py <spec.json> <outdir>

spec.json: [{"file":"01_tools_list.json","method":"tools/list","params":{}}, ...]
每个条目：独立 SSE 会话 → POST /messages → 取首帧 → 原样写 <outdir>/<file>。
原始 HTTP 状态/耗时/session 写入 <outdir>/_probe_016_raw.log。
"""
import json
import os
import sys
import threading
import time
import urllib.request

BASE = os.environ.get("MCP_BASE", "http://127.0.0.1:18082")
TIMEOUT = 60.0


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
    log.append(f"# {method} {json.dumps(params, ensure_ascii=False)[:400]} -> POST {status} {dt}ms session={sid[:8]}")
    return frames[0] if frames else "<no frame>"


def main():
    spec_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    spec = json.load(open(spec_path))
    log = []
    for item in spec:
        frame = one_call(item["method"], item.get("params", {}), log)
        path = os.path.join(outdir, item["file"])
        with open(path, "w") as f:
            f.write(frame + "\n")
        print(f"[probe] {item['file']} <- {len(frame)} bytes")
    with open(os.path.join(outdir, "_probe_016_raw.log"), "a") as f:
        f.write("\n".join(log) + "\n")


if __name__ == "__main__":
    main()
