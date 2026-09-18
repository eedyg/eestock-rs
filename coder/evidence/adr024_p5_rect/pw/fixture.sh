#!/usr/bin/env bash
# ADR-024 P5 整改 N4 解锁夹具（**临时库内**最小夹具；不碰生产目录/接口）：
#   若 catalog（GET /api/strategies）为空 ⇒ 经真 REST 门禁创建并**发布**一条策略，
#   使工作台「添加策略」下拉有条目（否则无法添加 slot ⇒ 无法在 UI 提交，真渲染受阻）。
# 幂等：已有条目则 no-op（打印计数）。参数：$1 = 实例 base URL。
set -euo pipefail
BASE="${1:-http://127.0.0.1:18099}"
N=$(curl -s "$BASE/api/strategies" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
echo "[fixture] catalog 现有条目 = $N"
if [ "$N" -gt 0 ]; then echo "[fixture] 无需夹具（已有 published 版本）"; exit 0; fi
NAME="P5R 夹具策略 $(date +%s)"
CREATED=$(curl -s -X POST "$BASE/api/strategies" -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"code\":\"function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }\"}")
VID=$(echo "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"]["id"])')
echo "[fixture] 创建 draft version = $VID；发布（走真门禁）…"
curl -s -X POST "$BASE/api/strategies/versions/$VID/publish" -o /tmp/p5rect_publish.json -w "[fixture] publish http=%{http_code}\n"
echo "[fixture] catalog 现 = $(curl -s "$BASE/api/strategies" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
