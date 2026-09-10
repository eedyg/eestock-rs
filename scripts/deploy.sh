#!/usr/bin/env bash
# scripts/deploy.sh — eestock-rs 容器部署入口（TD-8）
#
# 背景：docker-compose 1.29.2（Python SDK）与 Docker Engine API ≥ 1.44 不兼容，
# 在容器 recreate 路径触发 `KeyError: 'ContainerConfig'`（compose/service.py:1579，
# 新 daemon 的 image inspect 不再返回 ContainerConfig 字段）。修复口径：统一走
# Compose V2（`docker compose` 插件）。V1 仅检测到时报错并给出安装指引，不再尝试运行。
#
# 用法：
#   scripts/deploy.sh [--dry-run] [--skip-build] [--no-smoke] [--force] [-- <compose up 额外参数>]
#   --force：跳过 8081/8082 端口占用保护（仅在已确认人工停机窗口后使用）
#
# 流程：前置检查（V2 + 端口冲突保护）→ config 静态验证 → build → up -d
#       → 等待 healthy → /healthz + /api/strategies 冒烟 → 失败时打印回滚指引。
#
# 安全约束（写死，勿放宽）：
#   - 宿主机 8081/8082 若被非容器进程占用（在线 host 二进制），默认中止部署，
#     由人决定停机窗口后用 --force 显式放行。
#   - 本脚本不做 down/rm，不回滚数据卷；回滚 = git checkout 旧版本 + 重跑本脚本。

set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
APP_HEALTH_URL="${APP_HEALTH_URL:-http://127.0.0.1:8081/healthz}"
APP_STRATEGIES_URL="${APP_STRATEGIES_URL:-http://127.0.0.1:8081/api/strategies}"
DATA_HEALTH_URL="${DATA_HEALTH_URL:-http://127.0.0.1:8080/healthz}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-180}"

DRY_RUN=0
SKIP_BUILD=0
NO_SMOKE=0
FORCE=0
EXTRA_UP_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-smoke) NO_SMOKE=1 ;;
    --force) FORCE=1 ;;
    --) shift; EXTRA_UP_ARGS+=("$@"); break ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '[deploy] %s\n' "$*"; }
die()  { printf '[deploy][ERROR] %s\n' "$*" >&2; exit 1; }

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ---- 1. Compose 版本前置检查：V2 必须可用；V1 一律拒绝并给安装指引 ----
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
  log "Compose V2: $(docker compose version --short 2>/dev/null || echo ok)"
elif command -v docker-compose >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[deploy][ERROR] 仅检测到 docker-compose V1（Python 版），它与当前 Docker Engine
（API >= 1.44）不兼容，up/recreate 会触发 `KeyError: 'ContainerConfig'`。
请安装 Compose V2 插件后重试：

  Ubuntu/Debian:  sudo apt-get install -y docker-compose-v2
  或官方源:       sudo apt-get install -y docker-compose-plugin

安装后用 `docker compose version` 验证，再重跑本脚本。
EOF
  exit 1
else
  die "未找到任何 docker compose。请安装 Compose V2：sudo apt-get install -y docker-compose-v2"
fi

# ---- 2. 端口冲突保护：8081/8082 被非容器进程占用时拒绝部署 ----
port_has_listener() {
  # 仅判断有无监听，不需进程权限（ss -p 的 pid 解析在非 root 下对异主进程静默失败）
  ss -tlnH "sport = :$1" 2>/dev/null | grep -q .
}

port_owner_pid() {
  ss -tlnp "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true
}

port_owner_is_container() {
  # 占用者 cmdline 含 docker-proxy / containerd 视为容器端口，否则视为 host 进程
  local pid="$1"
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qE 'docker-proxy|containerd'
}

if [[ "$FORCE" -ne 1 ]]; then
  for port in 8081 8082; do
    port_has_listener "$port" || continue   # 无人监听 → 安全
    pid=$(port_owner_pid "$port")
    if [[ -z "$pid" ]]; then
      die "端口 $port 有监听但无法解析占用进程（非 root 下 ss -p 对异主进程静默无 pid）。按「未知占用」中止，不得静默放行；确认占用者后用 --force 显式放行，或以有足够权限的用户重跑。"
    fi
    if ! port_owner_is_container "$pid"; then
      die "端口 $port 被非容器进程占用（pid=$pid，疑似在线 host 服务）。为保护在线服务已中止；确认停机窗口后用 --force 显式放行。"
    fi
  done
else
  log "--force：跳过 8081/8082 host 进程占用检查（请确认已有人工停机窗口）"
fi

# ---- 3. 静态验证 compose 配置 ----
run "${COMPOSE[@]}" -f "$COMPOSE_FILE" config --quiet
log "compose config 校验通过"

# ---- 4. 构建镜像（cargo release 构建耗时长，属预期） ----
if [[ "$SKIP_BUILD" -ne 1 ]]; then
  log "开始构建镜像（多阶段：frontend npm build + cargo build --release，可能数十分钟）"
  run "${COMPOSE[@]}" -f "$COMPOSE_FILE" build
else
  log "--skip-build：复用现有镜像"
fi

# ---- 5. 启动 / 收敛 ----
log "up -d：${EXTRA_UP_ARGS[*]:-（全量服务）}"
run "${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d "${EXTRA_UP_ARGS[@]}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run 完成（未执行任何变更）"
  exit 0
fi

# ---- 6. 等待容器 healthy ----
wait_healthy() {
  local name="$1" deadline=$((SECONDS + HEALTH_TIMEOUT_SECS)) status
  while (( SECONDS < deadline )); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)
    case "$status" in
      healthy) log "$name healthy"; return 0 ;;
      missing) ;; # 容器尚未创建或无 healthcheck，继续等
      *) : ;;
    esac
    sleep 3
  done
  return 1
}

FAILED=0
wait_healthy eestock-timescaledb || FAILED=1
wait_healthy eestock-data        || FAILED=1
wait_healthy eestock-app         || FAILED=1

# ---- 7. HTTP 冒烟 ----
if [[ "$NO_SMOKE" -ne 1 && "$FAILED" -eq 0 ]]; then
  for url in "$DATA_HEALTH_URL" "$APP_HEALTH_URL" "$APP_STRATEGIES_URL"; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)
    if [[ "$code" == "200" ]]; then
      log "冒烟 OK: $url -> 200"
    else
      log "冒烟 FAIL: $url -> $code"
      FAILED=1
    fi
  done
fi

if [[ "$FAILED" -ne 0 ]]; then
  cat >&2 <<'EOF'
[deploy][ERROR] 部署未通过健康检查 / 冒烟。排查与回滚指引：
  1. 看日志：docker compose logs --tail=200 app data
  2. 回滚 = 检出上一个可用版本后重跑本脚本：
       git checkout <last-good-commit> -- Cargo.toml Cargo.lock crates docker-compose.yml Dockerfile Dockerfile.app
       # 若新版新增过 crate 目录（旧版 workspace 无此成员），checkout 不会删除它，需显式清理残留：
       git clean -fd crates/    # 谨慎：会删除 crates/ 下全部未跟踪文件，执行前先 git status 确认
       scripts/deploy.sh --force
  3. 数据面卷 ./data/timescaledb 不受回滚影响（bind mount，脚本不做任何数据操作）。
  4. 如需整体停容器（人决定）：docker compose stop app（不会动数据面，除非显式指定）。
EOF
  exit 1
fi

log "部署完成：数据面 $DATA_HEALTH_URL，应用面 $APP_HEALTH_URL 均通过"
