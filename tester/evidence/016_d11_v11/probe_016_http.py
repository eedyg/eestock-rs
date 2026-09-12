#!/usr/bin/env python3
"""016 D11 v1.1 复验探针：对**替代端口**实例的 Web API :18081 发 HTTP 请求。

每个条目原样记录：请求方法/路径/body、HTTP 状态、响应体（JSON 格式化）、耗时。
用法: python3 probe_016_http.py <spec.json> <outdir>
spec: [{"file":"x.json","method":"POST","path":"/api/...","body":{...},"note":"..."}]
追加写到 <outdir>/_probe_016_http_raw.log。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("HTTP_BASE", "http://127.0.0.1:18081")


def one(item):
    method = item.get("method", "GET")
    path = item["path"]
    data = None if item.get("body") is None else json.dumps(item["body"]).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    dt = int((time.time() - t0) * 1000)
    text = raw.decode("utf-8", "replace")
    try:
        body = json.loads(text)
    except Exception:
        body = {"_non_json": text[:2000]}
    return method, path, status, dt, body


def main():
    spec_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    spec = json.load(open(spec_path))
    lines = []
    for item in spec:
        method, path, status, dt, body = one(item)
        out = {"request": {"method": method, "path": path, "body": item.get("body")},
               "note": item.get("note", ""), "http_status": status, "ms": dt, "response": body}
        with open(os.path.join(outdir, item["file"]), "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        lines.append(f"[{method} {path}] {status} {dt}ms {item.get('note','')}")
        print(f"{item['file']}: {status} {dt}ms {item.get('note','')}")
    with open(os.path.join(outdir, "_probe_016_http_raw.log"), "a") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
