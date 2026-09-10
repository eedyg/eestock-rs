# 130 — TD-8 收尾包：5 项 reviewer findings 小修

- 任务来源：TD-8 review findings（MINOR-1/2/3 + NIT-1/2 + 复核项），全部采纳
- 本报告位置：`coder/report/130_td8_wrap_up_5_fixes.md`

## What changed

| 文件 | 变更 | 归属项 |
|---|---|---|
| `scripts/deploy.sh` | +29/-17：端口保护权限洞修复、回滚指引补 Cargo.toml/Cargo.lock + crate 残留清理、用法注释补 --force | MINOR-1 / MINOR-2 / NIT-2 |
| `scripts/tests/test_deploy_port_guard.sh` | 新增（6 用例 bash 功能+静态测试，PATH 注入 fake ss/docker） | MINOR-1 / NIT-2 测试 |
| `design/03-collector/02-data-plane.md` | :309/:324 「15 个 crate」→「12 个」；:315 「10 个空 src/lib.rs」→「12 个」 | MINOR-3 / NIT-1 |
| `design/07-app-plane/00-web-api.md` | :4704 「10 个 crate 清单」→「15 个」；:4706 「10 个空 src/lib.rs」→「15 个」 | MINOR-3 / NIT-1 |
| `Dockerfile` | entangled tangle 重新生成，仅注释「15→12」一行 diff | MINOR-3 生成物 |
| `migrations/0021_app_config.sql` | chmod 664→644（复核发现权限出格，收编为 644） | 复核项 |

## Architecture alignment

- `scripts/deploy.sh` 为手写部署脚本（非 design tangle 生成物，已 grep 确认无 `file=scripts/deploy.sh`），基础设施层，直接修改合规。
- Dockerfile/Dockerfile.app 是 design 生成物：本次只改 design 源（data-plane.md §5、web-api.md §6 部署节），再 `entangled tangle` 单向生成，符合 ADR-007 文学式纪律（check-tangle.sh 语义）。
- 未改任何 Rust crate、接口、事件契约、compose 配置。

## 各项修复 → 证据

### MINOR-1 端口保护权限洞（deploy.sh 原 84-93 行）

**问题**：旧实现 `ss -tlnp ... | grep pid=`，pid 为空时一律 `return 0`（安全放行）。但非 root 用户执行 `ss -p` 对**异主进程**静默拿不到 pid 字段——此时「有监听但解析不到 pid」与「无人监听」无法区分，权限洞导致静默放行。

**修复**：拆成三步——
1. `port_has_listener`：`ss -tlnH "sport = :$port"`（无 `-p`，不需任何进程权限）判断有无监听；无监听 → 放行。
2. 有监听 → `port_owner_pid` 解析 pid；**解析不到 → die「未知占用」中止**（不再静默放行），提示 --force 或提权重跑。
3. pid 可得 → 读 `/proc/$pid/cmdline` 判 docker-proxy/containerd；读不到或不匹配 → die（维持原安全语义）。

**证据**（功能测试，PATH 注入 fake ss 模拟四种场景，见 `scripts/tests/test_deploy_port_guard.sh`）：

```
[PASS] 无人监听放行            （mode=none → dry-run 走完全流程 exit 0）
[PASS] 监听但 pid 不可解析→中止 （mode=listen_nopid → exit 1，输出含「未知占用」；Red 阶段旧代码 exit 0 复现漏洞）
[PASS] host 进程占用→中止      （pid=1 /sbin/init → exit 1 含「非容器进程占用」）
[PASS] 容器端口放行            （真实起 argv0=docker-proxy 进程，/proc 可读 → exit 0）
[PASS] --force 跳过检查
[PASS] 用法注释含 --force
---- 6 passed, 0 failed
```

非 root 场景推演（复核证据）：当前环境 uid=1001，`ss -tlnp "sport = :8081"` 对本用户进程可解析 pid=1243676（eestock-app host 进程）→ 新逻辑走分支 3 正确中止；对 root/异主进程监听者（如 docker-proxy 以 root 运行且未开 `--userland-proxy=false` 之外的权限），`-p` 输出无 users 字段 → 走分支 2 按未知占用中止。两条路径均不放行。

### MINOR-2 回滚指引（deploy.sh 失败 heredoc）

- `git checkout <last-good-commit> --` 路径补 `Cargo.toml Cargo.lock`（workspace 成员/依赖锁定文件，新版若增删 crate，仅回滚 crates/ 会导致 workspace 解析不一致）。
- 补 crate 目录残留清理说明：`git checkout -- crates` 不删除新版新增的 crate 目录，需 `git clean -fd crates/`（附谨慎提示：先 `git status` 确认未跟踪文件）。

### MINOR-3 + NIT-1 crate 计数注释

事实：workspace 共 15 crate；数据面 Dockerfile COPY 12 个（不含 application/backtest/simlive），应用面 Dockerfile.app COPY 15 个。修正：
- data-plane.md :309 散文 15→12、:315 「补 10 个空 src/lib.rs」→12、:324 Dockerfile 注释 15→12；
- web-api.md :4704 「10 个 crate 清单」→15、:4706 「补 10 个空」→15（:4732 Dockerfile.app 注释原本即为 15，无需改）。

**证据**：`entangled tangle` 后 `git diff Dockerfile` 仅注释一行 `15→12`；Dockerfile.app 无 diff；`git add` 后 `entangled tangle && git diff --quiet` 通过（design 与生成物一致）。

### NIT-2 用法注释补 --force

头部用法行改为 `scripts/deploy.sh [--dry-run] [--skip-build] [--no-smoke] [--force] [-- ...]` 并加一行 --force 语义说明。静态断言已入测试用例 6。

### 复核：migrations/*.sql 权限

`stat -c '%a %n' migrations/*.sql`：发现 `0021_app_config.sql` 为 **664**（出格，git index 为 100644），已 chmod 644。修复后 25 个文件全部 644（无 640），无 0600 残留——0600 修复已生效验证通过。

## Test coverage

- 新增 `scripts/tests/test_deploy_port_guard.sh`（6 用例，见上）。TDD：先写测试确认 2 项 Red（权限洞静默放行、用法注释缺 --force），再实现转 Green，全量 6/6 通过。

## Verification

```
bash -n scripts/deploy.sh                       → OK
bash scripts/tests/test_deploy_port_guard.sh    → 6 passed, 0 failed
entangled tangle && git diff --quiet            → OK（git add 后无 diff）
docker compose config --quiet                   → exit 0
curl http://127.0.0.1:8081/healthz              → 200（在线服务未触碰，仅只读探测）
```

## Residual risks

- 测试用 fake ss/docker 注入，未覆盖真实 docker-proxy 以 root 运行且 ss -p 完全无输出的组合内核/发行版差异；但分支 2（未知占用中止）对该类场景兜底，方向是安全的。
- `Dockerfile.app` 在本任务前已处于 staged modified 状态（上一任务 TD-8 产物），本次未改动它。
