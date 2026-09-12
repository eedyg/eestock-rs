#!/usr/bin/env python3
"""017 helper: JSON-RPC over SSE against MCP base (default 127.0.0.1:8082)."""
import json, os, threading, time, urllib.request

BASE = os.environ.get("MCP_BASE", "http://127.0.0.1:8082")
TIMEOUT = 90.0

def call(method, params, idv=1):
    resp = urllib.request.urlopen(BASE + "/sse", timeout=TIMEOUT)
    st = {"endpoint": None, "frames": []}
    done = threading.Event()
    def rd():
        try:
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("data: "):
                    data = line[6:]
                    if st["endpoint"] is None and data.startswith("/messages?sessionId="):
                        st["endpoint"] = data; done.set(); continue
                    st["frames"].append(data)
        except Exception:
            pass
    threading.Thread(target=rd, daemon=True).start()
    if not done.wait(TIMEOUT):
        raise RuntimeError("no endpoint")
    body = json.dumps({"jsonrpc":"2.0","id":idv,"method":method,"params":params}).encode()
    req = urllib.request.Request(BASE + st["endpoint"], data=body, headers={"content-type":"application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        post_status = r.status
    deadline = time.time() + TIMEOUT
    while not st["frames"] and time.time() < deadline:
        time.sleep(0.05)
    try: resp.close()
    except Exception: pass
    frame = st["frames"][0] if st["frames"] else "<no frame>"
    return post_status, frame

def call_tool(name, arguments):
    s, frame = call("tools/call", {"name": name, "arguments": arguments})
    d = json.loads(frame)
    r = d.get("result", {})
    iserr = bool(r.get("isError"))
    txt = (r.get("content") or [{}])[0].get("text", "")
    return {"post_status": s, "isError": iserr, "text": txt, "raw": d}

if __name__ == "__main__":
    import sys
    name = sys.argv[1]; args = json.loads(sys.argv[2])
    out = call_tool(name, args)
    print(json.dumps(out, ensure_ascii=False, indent=1))
