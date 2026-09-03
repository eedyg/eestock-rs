# eestock-rs

自托管 A 股（当前聚焦 ETF）行情数据与交易系统——Go 版 eestock 的全量 Rust 重写。
完整愿景、分层架构与全部决策见 `design/`（00-vision.md 为入口，ADR-001~014 为决策记录）。

## 文学式编程纪律（ADR-007，不可协商）

- `design/` 是**唯一事实源**；`crates/domain/src/*.rs`、`migrations/*.sql` 等由
  [entangled](https://entangled.github.io/) 从文档**单向**生成（`design → src`）。
- **改代码 = 改 design/ 文档**，然后 `entangled tangle`。禁止手改任何带
  `~/~ begin <<...>>` 标记的生成文件。
- 手写例外（不 tangle）：`entangled.toml`、`Cargo.toml` workspace 骨架、本 README、
  `docker-compose.yml`、`scripts/`、前端构建配置（package.json 等）。

### 安装 entangled

```bash
pipx install entangled-cli        # 推荐
# 或：pip install --user entangled-cli
entangled --version               # 本仓库验证版本：2.4.0
```

### 安装一致性门禁（pre-commit hook）

门禁逻辑：`entangled tangle && git diff --exit-code`——重新 tangle 后若 working tree
出现差异，说明生成物与 design/ 脱节，拒绝提交。`entangled` 未安装时 hook **硬失败**
并给出安装提示（不会静默放行）。

```bash
ln -sf ../../scripts/check-tangle.sh .git/hooks/pre-commit
```

> hook 位于 `.git/hooks/`，不入库，克隆后需重新执行上面一行。
> 手动自检：`./scripts/check-tangle.sh`

## 启动开发数据库（TimescaleDB）

```bash
docker compose up -d timescaledb        # 宿主机端口 5433（避开本机 5432）
docker compose ps                       # 等待 healthcheck = healthy
psql postgres://eestock:eestock@localhost:5433/eestock
```

- 数据卷：bind mount `./data/timescaledb`（用户裁决 2026-09-03，已入 .gitignore）。
- `migrations/*.sql` 挂载为 initdb 脚本，**仅首次初始化空卷时**自动执行；
  后续增量迁移走 sqlx migrate 运维流程；`data` 服务启动时做 schema 自检（storage::migrate_check）。

## 启动数据面全栈（Wave 0，ADR-017）

```bash
cp config/data.toml.example config/data.toml   # 首次；已入 .gitignore
export TUSHARE_TOKEN=...                        # secret 走 env，不落文件
docker compose up -d                            # timescaledb + data 一条命令
curl http://localhost:8080/healthz              # 数据面唯一端口（只读存活探测）
```

- `data` 服务：多阶段 Dockerfile 构建 `eestock-data`（采集/降级模式/缺口回填/tushare 日增量），
  `depends_on: timescaledb (healthy)`、`restart: unless-stopped`、启动 schema 自检、
  healthcheck 用二进制自带 `--self-check`（运行时镜像无 curl/wget）。
- 应用面 `eestock-app`（web/diagnose/MCP）为 Wave 1 边界，本仓暂不包含其 compose 服务。

## 常用命令

```bash
entangled tangle              # 从 design/ 重新生成代码
./scripts/check-tangle.sh     # tangle 一致性自检（同 pre-commit 门禁）
cargo check --workspace       # 全 workspace 编译检查
cargo test --workspace        # 测试（TDD：Red-Green-Refactor）
cargo clippy --workspace      # lint
docker compose up -d timescaledb
```

## 仓库布局

```
design/         # 事实源文档树（00-vision / 01-architecture+ADR / 02-domain / 04-storage / ...）
crates/         # domain collector storage providers tushare diagnose mcp web app
migrations/     # TimescaleDB DDL（tangle 生成）
scripts/        # 工程脚本（check-tangle.sh 等）
docker-compose.yml
```
