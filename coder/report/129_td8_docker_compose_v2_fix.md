# TD-8 修复：docker-compose 部署链路（compose 1.29.2 vs 新 Docker API）

- 报告路径：`coder/report/129_td8_docker_compose_v2_fix.md`
- 日期：2026-09-10
- 执行：Coder Agent（TDD/取证优先，未中断任何在线服务）

## 1. 诊断证据（先取证，无猜测）

| 项 | 实测 |
|---|---|
| Docker Engine | 29.1.3，Server API **1.52**（MinAPI 1.44） |
| docker-compose（V1） | 1.29.2（Python 脚本，`/usr/bin/docker-compose`） |
| Compose V2 插件 | **初始未安装**（`docker compose` unknown command；cli-plugins 仅 docker-trust） |
| `docker-compose config` | **通过**（compose 文件字段无问题） |
| 错误复现（一次性项目 `/tmp/td8-repro`，hello-world，`up -d --force-recreate`） | 命中经典 Bug：`KeyError: 'ContainerConfig'`，栈顶 `compose/service.py:1579 get_container_data_volumes: container.image_config['ContainerConfig']` —— Docker API ≥ 1.44 的 image inspect 不再返回 `ContainerConfig` 字段，compose V1 的 docker-py 5.x 在 **recreate/收敛路径必炸**。这解释了「compose 部署全部失败」（eestock-app 已存在 → 任何 up 都走 recreate 对比路径）。 |

附注：V1 前台 `up` 还会在线程 `watch_events` 抛 `KeyError: 'id'`（同样源于新版 events 流格式漂移），但不致命；致命的是上面的 recreate 路径。

**结论**：不是 compose.yml 字段问题（config 静态验证通过），而是 V1 SDK 与新 daemon 的协议不兼容 → 走任务书 A/B 组合：安装 Compose V2（apt 候选 `docker-compose-v2 2.40.3+ds1` 存在，sudo 免密可用），并写正式部署脚本。

## 2. 修复内容与取舍

1. **安装 Compose V2**：`sudo apt-get install -y docker-compose-v2` → `Docker Compose version 2.40.3+ds1-0ubuntu1~24.04.1`。
   - 取舍：任务书 A 要求「v2 插件已可用」——初始不可用但 apt 源可直接安装（Ubuntu noble universe 官方包，纯增量 CLI 插件，零风险于在线服务），比 B 的「仅写安装文档」更能闭环验证。故实际执行 = 安装 v2（B 的安装步骤）+ 按 A 写 deploy.sh。
   - 注意：apt 安装时报了 4 个**与本次无关的既有错误**（`linux-headers/linux-image-7.0.0-28-generic` postinst exit 11，内核头包历史遗留问题），compose 插件本身安装成功并可用。此内核包问题残留，建议管理员另行处理。
2. **新增 `scripts/deploy.sh`**（正式部署入口，V2 优先、V1 拒绝）：
   - 前置检查：`docker compose version` 可用才继续；仅检测到 V1 时打印 ContainerConfig 兼容性说明 + 安装命令并 exit 1；
   - **端口冲突保护**：8081/8082 被非容器进程（host 二进制）占用时默认中止，须 `--force` 显式放行（保护在线服务的硬编码约束）；
   - 流程：`config --quiet` → `build` → `up -d` → 等待三容器 healthy（`docker inspect` 健康状态轮询）→ curl 冒烟 `8080/healthz`、`8081/healthz`、`8081/api/strategies` → 失败打印回滚指引（检出旧版本重跑；不做 down/rm、不碰数据卷）；
   - 支持 `--dry-run`（打印不执行）、`--skip-build`、`--no-smoke`、`--`（透传 compose up 参数）。
3. **修复镜像构建断裂（阻塞构建的真实 Bug）**：workspace 新增 `strategy-core`、`strategy-runtime` 两个 crate（12-strategy-system），但 Dockerfile/Dockerfile.app 的清单 COPY 与空 lib.rs 占位循环未同步 → `cargo fetch` 报 `failed to read crates/strategy-core/Cargo.toml`（实测复现，exit 101）。
   - 按 ADR-007 文学式纪律，**改 design 源**（`design/03-collector/02-data-plane.md`、`design/07-app-plane/00-web-api.md`），`entangled tangle` 重新生成 Dockerfile/Dockerfile.app（幂等性已验证：二次 tangle 无 diff）。
4. **修复迁移文件权限（阻塞全新 DB 初始化的潜伏 Bug）**：`migrations/0007–0020、0022–0024` 多为 `-rw-------`，timescaledb 容器内 postgres 用户读不到 → initdb 在 0007 即 `Permission denied` 中止。`chmod a+r migrations/*.sql` 统一到 `0644/0664`（git 不追踪读权限位，无 diff）。
5. **compose.yml 未改动**：无 `version:` 字段（V2 原生兼容），`depends_on.condition`/`shm_size` 均受 V2 支持，无需现代化改写。

## 3. 验证证据（全程未中断在线服务）

| 验证 | 命令 / 证据 | 结果 |
|---|---|---|
| V2 config 静态校验 | `docker compose config --quiet` | ✅ 通过（services: timescaledb/data/app） |
| 镜像构建 | `docker compose build app` → `eestock-rs-app:latest`（注意 V2 镜像名为**连字符**，旧 V1 镜像 `eestock-rs_app` 保留未动） | ✅ 成功；cargo fetch+release 构建约 7 分钟（cargo build 层 417.5s） |
| 替代端口冒烟 | 隔离链路：全新 timescaledb 冒烟容器（15433，tmp 数据卷，24 个 migrations 全量落库零错误）+ 新 app 容器映射 `127.0.0.1:18083/18084` | ✅ `GET /healthz` → **200**；`GET /api/strategies` → **200**（返回真实 seed 策略数据）；容器内 `eestock-app --self-check` exit **0** |
| 冒烟拆除 | `docker rm -f td8-smoke-app td8-smoke-db` + 网络/卷清理 | ✅ 无残留（`docker ps -a --filter name=td8` 空） |
| 在线服务零影响 | 巡检：`ss -tln` 8081/8082/18081/18082 host 进程仍在监听；`eestock-timescaledb`/`eestock-data` Up 5 days (healthy)；停止的 `eestock-app` 容器 Exited 原样保留 | ✅ 全程未碰 |
| deploy.sh | `bash -n` 语法检查 ✅；`--dry-run`（无 force）正确拦截 8081 占用 exit 1 ✅；`--dry-run --force` 全流程打印 exit 0 ✅ | ✅ |
| tangle 一致性 | 二次 `entangled tangle` 无 diff | ✅ |

## 4. 切换回容器部署操作手册（何时切回由人决定）

**前提判断（人决定）**：当前 8081/8082 由 host 二进制在线服务，切回容器部署意味着**先有停机窗口**。

1. 确认要切换：`sudo systemctl stop <host eestock-app 服务>`（或人工 kill 8081/8082 的 host 进程）；数据面 `eestock-data`/`eestock-timescaledb` 容器在线，无需动。
2. 应用迁移差额：在线 DB 是 5 天前初始化的，**缺 0011–0024**（自检报缺失 backtest_* 正是此因——新镜像自检台账已不含 0024 DROP 的表，但 0011–0023 的表仍需补齐）：
   `docker exec -i eestock-timescaledb psql -U eestock -d eestock < migrations/00XX.sql`（按序执行缺失的迁移）。
3. `scripts/deploy.sh`（host 进程已停，端口空闲，无需 --force）。
4. 脚本自动：build → up -d → 等 healthy → 冒烟 200。失败按脚本打印的指引回滚。
5. **回滚**：`docker compose stop app`；`git checkout <last-good>` 后重跑 deploy.sh；或重启 host 二进制恢复原部署。数据卷 `./data/timescaledb` 全程不受影响。

**注意点**：
- V2 首次 `up` 会以新镜像 `eestock-rs-app` **重建** `eestock-app` 容器（旧容器是 V1 镜像 `eestock-rs_app` 起的）——这正是 V1 会炸 ContainerConfig 的路径，V2 下已验证 recreate 正常工作。
- 旧镜像 `eestock-rs_app`/`eestock-rs_data`（下划线命名）已无人使用，可择机 `docker rmi` 清理（本次未删，留作回滚兜底）。

## 5. 变更文件

- `scripts/deploy.sh`（新增，+155 行）
- `Dockerfile` / `Dockerfile.app`（tangle 重新生成：+2 crate 清单 COPY + 循环列表 + 注释计数 10/13→15）
- `design/03-collector/02-data-plane.md` / `design/07-app-plane/00-web-api.md`（Dockerfile 块的事实源修改）
- `migrations/*.sql` 权限位 0600→0644（无 git diff）

## 6. 测试 / TDD 说明

本次为部署链路修复（shell + Dockerfile），TDD 适配为「失败证据先行」：
- Red：一次性 hello-world 项目复现 `ContainerConfig` KeyError；真实 `docker compose build app` 复现 cargo fetch 失败；冒烟 DB 复现迁移 Permission denied。
- Green：安装 V2 / 修 Dockerfile 事实源 / chmod，全部转为通过（证据见 §3）。
- 未新增 Rust 测试（无 Rust 代码改动）。

## 7. 残留风险

1. 在线 DB 缺 0011–0024 迁移（见 §4 第 2 步），切回容器前必须补齐，否则新镜像自检拒绝启动——这属于既有数据欠账，本次按「不碰数据面」约束未动。
2. host 8081/8082 二进制与容器版 app 并存期间，`scripts/deploy.sh` 默认中止（保护设计）；只有 `--force` 才会继续，且端口仍会被 host 进程占住导致容器绑定失败——**正确顺序是先停 host 再 deploy**。
3. apt 报出的 `linux-image/headers-7.0.0-28-generic` postinst 失败为系统既有问题，与本次改动无关，未处理。
4. MCP 端口 8082 无 `/healthz` 路由（404 属正常），deploy.sh 未对其做 HTTP 冒烟，仅依赖容器 healthcheck（`--self-check` 覆盖 8081）。
