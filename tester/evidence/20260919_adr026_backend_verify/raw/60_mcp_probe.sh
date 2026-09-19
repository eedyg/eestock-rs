#!/usr/bin/env bash
# MCP bt_get_run_audit 真调用（SSE transport，针对本测试实例 8092）
set -uo pipefail
M=http://127.0.0.1:8092
SSE=/tmp/adr026_mcp_sse.log; : > $SSE
curl -N -s -m 25 "$M/sse" > $SSE &
CURLPID=$!
for i in $(seq 1 50); do grep -q '^event: endpoint' $SSE 2>/dev/null && break; sleep 0.2; done
SID=$(grep -m1 '^data: /messages?sessionId=' $SSE | sed 's/.*sessionId=//')
echo "## SSE endpoint 首帧 / sessionId=$SID"
head -3 $SSE
post() { curl -s -o /dev/null -w "POST %{http_code}\n" -H 'content-type: application/json' -X POST "$M/messages?sessionId=$SID" -d "$1"; }
post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"tester","version":"1"}}}'
post '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo "## tools/list 名单含 bt_get_run_audit?"
post '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
echo "## tools/call 目标 run（A3）"
post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bt_get_run_audit","arguments":{"run_id":"sr_1789738328788_000005"}}}'
echo "## tools/call 满仓 run（A4）"
post '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"bt_get_run_audit","arguments":{"run_id":"sr_1789738272901_000004"}}}'
echo "## tools/call 未知 run（期望 isError）"
post '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"bt_get_run_audit","arguments":{"run_id":"sr_nope"}}}'
echo "## tools/call 缺参（期望 -32602）"
post '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"bt_get_run_audit","arguments":{}}}'
sleep 2
kill $CURLPID 2>/dev/null
echo "## SSE 帧（原始）"
cat $SSE
