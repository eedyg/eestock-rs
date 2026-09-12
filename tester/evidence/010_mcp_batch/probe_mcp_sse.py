#!/usr/bin/env python3
"""Tester 010 证据脚本：对运行中的 MCP SSE 端点发 JSON-RPC（只读）。
用法: python3 probe_mcp_sse.py http://127.0.0.1:8082 <method> <params-json> [timeout]
"""
import json
import sys
import threading
import time
import urllib.request

base = sys.argv[1].rstrip("/")
method = sys.argv[2]
params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
timeout = float(sys.argv[4]) if len(sys.argv) > 4 else 15.0

resp = urllib.request.urlopen(base + "/sse", timeout=timeout)
print(f"# SSE status={resp.status} content-type={resp.headers.get('content-type')}")

endpoint = None
frames = []
done = threading.Event()


def reader():
    global endpoint
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
            print("# keepalive frame")


t = threading.Thread(target=reader, daemon=True)
t.start()
done.wait(timeout=timeout)
assert endpoint, "未收到 endpoint 帧"
print(f"# endpoint={endpoint}")

body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
req = urllib.request.Request(base + endpoint, data=body,
                             headers={"content-type": "application/json"})
with urllib.request.urlopen(req, timeout=timeout) as r:
    print(f"# POST /messages status={r.status}")

deadline = time.time() + timeout
while not frames and time.time() < deadline:
    time.sleep(0.05)

print("RAW=" + (frames[0] if frames else "<no frame>"))
try:
    resp.close()
except Exception:
    pass
