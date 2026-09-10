#!/usr/bin/env bash
# test_deploy_port_guard.sh — deploy.sh 端口冲突保护的静态+功能测试（TD-8 MINOR-1/NIT-2）
#
# 通过 PATH 注入 fake `ss` / `docker`，在无 Docker、无真实端口占用的环境下推演：
#   1. 无人监听            → 放行（dry-run 走完全流程）
#   2. 有监听但 pid 解析不到（非 root 对异主进程）→ 按「未知占用」中止（不得静默放行）
#   3. 监听者为 host 进程   → 中止
#   4. 监听者为容器（docker-proxy cmdline）→ 放行
#   5. --force              → 跳过检查放行
# 另含静态断言：用法注释包含 --force。
set -uo pipefail

cd "$(dirname "$0")/../.."
DEPLOY="scripts/deploy.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kill "$SPAWNED_PID" 2>/dev/null || true' EXIT
PASS=0; FAIL=0

# ---- fake docker：compose version 成功，其余子命令静默成功（dry-run 下不会真正调用） ----
cat >"$TMP/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/docker"

# ---- fake ss：按 FAKE_SS_MODE 输出 ----
cat >"$TMP/ss" <<'EOF'
#!/usr/bin/env bash
# 解析 -tlnH / -tlnp 与端口
mode="H"; port=""
for a in "$@"; do
  case "$a" in
    -tlnp) mode="p" ;;
    *": "*) : ;;
    sport*) port="${a##*:}" ;;
  esac
done
line="LISTEN 0 128 0.0.0.0:${port} 0.0.0.0:*"
case "${FAKE_SS_MODE:-none}" in
  none) exit 0 ;;
  listen_nopid)
    # 非 root 场景：-p 也拿不到异主进程的 users 字段（静默无 pid）
    [[ "$mode" == "p" ]] && echo "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process"
    echo "$line" ;;
  host_proc|container)
    [[ "$mode" == "p" ]] && echo "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process"
    if [[ "$mode" == "p" ]]; then
      echo "$line users:((\"proc\",pid=${FAKE_SS_PID},fd=11))"
    else
      echo "$line"
    fi ;;
esac
exit 0
EOF
chmod +x "$TMP/ss"

run_deploy() {
  env PATH="$TMP:$PATH" "$@" bash "$DEPLOY" --dry-run --skip-build >"$TMP/out.log" 2>&1
}

check() { # <name> <expected_rc> <expected_substr_or_empty>
  local name="$1" want_rc="$2" want_msg="$3"
  if [[ "$LAST_RC" -ne "$want_rc" ]]; then
    echo "[FAIL] $name: 期望退出码 $want_rc，实际 $LAST_RC"; sed 's/^/       /' "$TMP/out.log" | tail -5
    FAIL=$((FAIL+1)); return
  fi
  if [[ -n "$want_msg" ]] && ! grep -qF "$want_msg" "$TMP/out.log"; then
    echo "[FAIL] $name: 输出缺少「$want_msg」"; sed 's/^/       /' "$TMP/out.log" | tail -5
    FAIL=$((FAIL+1)); return
  fi
  echo "[PASS] $name"; PASS=$((PASS+1))
}

# 用例 1：无人监听 → 放行
run_deploy FAKE_SS_MODE=none; LAST_RC=$?
check "无人监听放行" 0 "dry-run 完成"

# 用例 2：有监听但 pid 解析不到（非 root 权限洞）→ 按未知占用中止
run_deploy FAKE_SS_MODE=listen_nopid; LAST_RC=$?
check "监听但 pid 不可解析→中止" 1 "未知占用"

# 用例 3：监听者为 host 进程（pid=1，cmdline=/sbin/init）→ 中止
run_deploy FAKE_SS_MODE=host_proc FAKE_SS_PID=1; LAST_RC=$?
check "host 进程占用→中止" 1 "非容器进程占用"

# 用例 4：监听者为容器（真实起 argv0=docker-proxy 的进程，/proc 可查）→ 放行
bash -c 'exec -a docker-proxy sleep 60' &
SPAWNED_PID=$!
run_deploy FAKE_SS_MODE=container FAKE_SS_PID=$SPAWNED_PID; LAST_RC=$?
check "容器端口放行" 0 "dry-run 完成"
kill "$SPAWNED_PID" 2>/dev/null; wait "$SPAWNED_PID" 2>/dev/null; SPAWNED_PID=""

# 用例 5：--force 跳过检查
env PATH="$TMP:$PATH" FAKE_SS_MODE=host_proc FAKE_SS_PID=1 bash "$DEPLOY" --dry-run --skip-build --force >"$TMP/out.log" 2>&1
LAST_RC=$?
check "--force 跳过检查" 0 "跳过 8081/8082 host 进程占用检查"

# 静态断言：用法注释含 --force
if grep -qE '^#   scripts/deploy\.sh \[--dry-run\] \[--skip-build\] \[--no-smoke\] \[--force\]' "$DEPLOY"; then
  echo "[PASS] 用法注释含 --force"; PASS=$((PASS+1))
else
  echo "[FAIL] 用法注释缺少 --force"; FAIL=$((FAIL+1))
fi

echo "---- $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
