# eestock-rs

自托管 A 股（当前聚焦 ETF）行情数据与交易系统——Go 版 eestock 的全量 Rust 重写。
完整愿景、分层架构与全部决策见 `design/`（00-vision.md 为入口，ADR-001~014 为决策记录）。

## 文学式编程纪律（ADR-007，不可协商）

- `design/` 是**唯一事实源**；`crates/domain/src/*.rs`、`migrations/*.sql` 等由
  [entangled](https://entangled.github.io/) 从文档**单向**生成（`design → src`）。
- **改哪一侧就从哪一侧出发**：改 `design/` 文档 → `entangled tangle`；改代码/生成物 →
  `./scripts/stitch.sh` 把实现回写文档（ADR-018 O1 纪律，详见下文「O1 纪律」）。
  手改了生成物却不回写文档 = 漂移，门禁会拦。
- 手写例外（不 tangle）：`entangled.toml`、`Cargo.toml` workspace 骨架、本 README、
  `docker-compose.yml`、`scripts/`、前端构建配置（package.json 等）。

### 安装 entangled

```bash
pipx install entangled-cli        # 推荐
# 或：pip install --user entangled-cli
entangled --version               # 本仓库验证版本：2.4.0
```

### 安装一致性门禁（pre-commit hook）

门禁逻辑（ADR-018 D-F3-1 硬化版，`scripts/check-tangle.sh`）：

1. `entangled tangle -s`（dry-run，**永不写盘**）输出含 `conflicts found` / `ERROR` /
   `not managed by Entangled` / `changed outside the control of Entangled` → 硬失败；
2. **漂移判据（权威）**：把 `watch_list` 输入 + 目标文件副本拷进临时沙箱（**不拷 `.entangled`**），
   在沙箱内 `entangled tangle -f` 重新生成，再与真实仓库**逐字节比对**；
   任一生成物缺失 / 内容不一致 → 硬失败并列出漂移文件、打印两条出路（改文档 → tangle /
   改码 → stitch）。

关键性质：**门禁不修改真实工作区**（全部 tangle 都在沙箱里跑，`--force` 只允许出现在隔离副本）；
**与 `.entangled/` 本地状态无关**（干净副本 / CI 新克隆同样正确；缓存过期也不会误报）。
注意：沙箱内故意**不拷 filedb**——filedb 记的是"上次写入内容 digest"，回写后就是过期值，
带上它会把"内容一致、仅缓存旧"的仓库误判为失败。

> 旧实现 `entangled tangle && git diff --quiet` 会**假绿**：entangled 的 filedb 记录的是
> “上次写入内容 digest”，文档侧未变时它直接判定 target unchanged，**根本不看磁盘生成物**——
> 手改生成物（如 `4d55f17`）后 `tangle` 打印 `Nothing to be done.`，`git diff` 自然为空。
> 遇冲突时 `entangled tangle` 还会打印 `ERROR conflicts found, breaking off` 却**退出码 0**，
> 且不写任何文件（ADR-018 §1）。

```bash
ln -sf ../../scripts/check-tangle.sh .git/hooks/pre-commit
```

> hook 位于 `.git/hooks/`，不入库，克隆后需重新执行上面一行。
> 手动自检：`./scripts/check-tangle.sh`
> 门禁自测（三态 fixture，可复跑）：`bash scripts/tests/test_check_tangle.sh`

### O1 纪律：改码后必须回写文档（ADR-018 §3.1）

每类改动只走一条路，两条都不能省——**改文档不回 tangle = 生成物过期；改代码不回写文档 = 漂移**：

| 改动位置 | 动作 |
|---|---|
| `design/` 文档（事实源） | `entangled tangle`（文档 → 生成物） |
| 代码 / 生成物（如 `web/src/layouts/*.tsx`） | `./scripts/stitch.sh`（代码 → 文档，沙箱 scoped 回写） |

```bash
./scripts/stitch.sh                     # 默认 scoped：只回写「检测到漂移」的生成物所属文档
./scripts/stitch.sh web/src/layouts/X.tsx   # 显式 scoped
./scripts/stitch.sh --help              # O1 纪律 + HAZARD 说明
bash scripts/tests/test_stitch.sh       # 回写入口自测（含「校验失败拒绝回写」负样例）
```

`scripts/stitch.sh` 的保证：① 只在**临时沙箱**里 stitch（`--force` 仅沙箱内使用）；② 回写前做
**round-trip 校验**（用回写后的文档重新生成，必须与仓库生成物逐字节一致），**校验不通过拒绝回写**；
③ 实现侧生成物一个字节都不动（零回退）。

**HAZARD（实测）**：
- **禁止在仓库根跑全局 `entangled stitch`**：`design/07-app-plane/{00-web-api,01-mcp}.md` 的代码块内
  嵌着 `// ~/~ begin` 遗留标记，全局 stitch 会把它们改写成自引用（`<<crates/mcp/src/tools.rs>>`，
  -3579 行），随后 `entangled tangle` 直接死于 `ERROR Cyclic reference`（F3-f 待办）。
- **禁止 `entangled tangle --force` 让门禁变绿**：它会用文档旧内容覆盖实现 = 回退已验收成果（D-F3-6）。
- `.entangled/filedb.json` 是**未版本化的本地缓存**；若 `entangled tangle` 报
  `changed outside the control of Entangled`（缓存过期，例如刚回写过文档），用 `entangled reset`
  重建缓存（只动 `.entangled/`，不改任何文件）；门禁本身不依赖它。

## 启动开发数据库（TimescaleDB）

```bash
docker compose up -d timescaledb        # 宿主机端口 5433（避开本机 5432）
docker compose ps                       # 等待 healthcheck = healthy
psql postgres://eestock:eestock@localhost:5433/eestock
```

- 数据卷：bind mount `./data/timescaledb`（用户裁决 2026-09-03，已入 .gitignore）。
- `migrations/*.sql` 挂载为 initdb 脚本，**仅首次初始化空卷时**自动执行；
  现网增量迁移只能**手工**应用：`psql -v ON_ERROR_STOP=1 -f migrations/00XX.sql`（对 127.0.0.1:5433）。
  活库无 `_sqlx_migrations` 表（本项目未使用 sqlx migrate 运维流程）；`data` 服务启动时只做 schema 自检
  （`storage::migrate_check`，校验 `EXPECTED_RELATIONS` 是否齐全，**不执行迁移**）——故新增关系须**先落迁移、再重启 app**。

## 跑集成测试的前置步骤（ADR-023 E6b）

集成测试**不再**连共享 dev 库（活库 `eestock`），只连专用测试库。前置三步：

```bash
scripts/testdb-init.sh        # ① 幂等建测试库 + 按序应用 migrations/*.sql + 建哨兵表（默认库名 eestock_test）
eval "$(scripts/testdb-init.sh)"   # ② 导出 EESTOCK_TEST_DATABASE_URL（stdout 只有这一行 export）
cargo test --workspace --tests     # ③ 跑集成测试
```

- 覆盖库名/端口/账号：`EESTOCK_TEST_DB_NAME`（默认 `eestock_test`）、`EESTOCK_TEST_DB_PORT`（默认 `5433`）、
  `EESTOCK_TEST_DB_HOST` / `EESTOCK_TEST_DB_USER` / `EESTOCK_TEST_DB_PASSWORD`。脚本拒绝在活库 `eestock` 上操作。
- **未设 `EESTOCK_TEST_DATABASE_URL` 时集成测试会「响亮失败」（panic 并点名该变量）——这是刻意设计**，
  不是环境配置疏漏：历史上测试直连共享 dev 库，桩数据经 cagg 物化后残留进生产数据
  （ADR-023 §6.1 第 8 条 / §6.3 第 12 条）。禁止任何「兜底默认回退活库」的写法。
- 建池后还会断言哨兵表 `_eestock_test_db`（值恒为 `test`）；把变量误指向活库会被哨兵拦下（panic）。
- 统一入口在 **dev-only crate `crates/test-support`**（各 crate 以 `[dev-dependencies]` 引用；
  不进运行时依赖图、不进 Dockerfile 镜像）。
- 清理测试库：`dropdb -h 127.0.0.1 -p 5433 -U eestock <库名>`（测试库可保留，随时可重建）。

### 播种契约（测试库 = 活库的**只读快照**，只播最小基线）

`scripts/testdb-init.sh` 的播种只覆盖集成测试真正依赖的**最小基线**：**只播 4 张表**
（活库 `public` 共 **37** 张关系 = 26 表 + 11 视图；测试库**不是**活库克隆）：

| 表 | 实测行数 | 反推的用例 |
|---|---|---|
| `symbols` | 44 | fee_profile_store / symbol_type_fee_migration / mcp list_symbols |
| `strategy` | 23 | mcp `strategy_list`（真实 published Registry 体量） |
| `strategy_version` | 24 | 同上 |
| `kline_accurate` | **1,631,088** | 仅 `518880` / `510050` 的 **M1**（1m 性能门禁需 ≥500 根） |
| `kline_accurate_1d`（由上述 M1 全量 `refresh_continuous_aggregate(NULL,NULL)` **派生**，非直采） | 6,768 | d11_fee_profile_e2e（D1 区间） |

（活库 `kline_accurate` 全量 16,344,861 行、`kline_raw` 114,841 行 —— **均不播**；上表行数为本次实测值。）

- 播种**从活库只读快照**：源连接强制 `PGOPTIONS='-c default_transaction_read_only=on'`，对源库**零写**。
- **目标表非空即跳过**（幂等：不会覆盖/重复已供应好的测试库）。
- **源库不可达** ⇒ `exit 3` 且**不留任何新库**（源可达性检查在建库**之前**，避免留下 schema-only 脏库）。
- **活库演进后需重新供应**：测试库是**快照**，不自动跟随活库；活库结构或数据变化后
  `dropdb … <库名>` + 重跑本脚本 = 重新播种。

### 活库孤儿守卫的归属变更（M3 登记）

原「orphan / live_snapshot」类用例查的是**活库**；ADR-023 E6b 起它们只查**测试库**（测试不碰生产），
故 **活库孤儿守卫已从「测试套件」迁移为「运维检查」**：

- 判据 = 部署后对**在线实例**调 `GET /api/quality/orphans`，响应应为 `rows: 0`（`by_table` 逐表全 0）。
- 当前状态：该端点**尚未部署**（线上仍 404，见 ADR-023 R-4）⇒ 该守卫目前**无人自动执行**；
  需运维在部署后手工执行并登记结果。
- 不得把孤儿用例改回查活库（那会重新违反「测试不碰生产」）。

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

## 启动应用面（Wave 1 Phase A，ADR-017）

```bash
cp config/app.toml.example config/app.toml   # 首次；已入 .gitignore
docker compose up -d                          # timescaledb + data + app 三容器
curl http://localhost:8081/healthz            # 应用面存活探测
curl "http://localhost:8081/api/symbols"      # REST：标列表+latest 快照
curl "http://localhost:8081/api/kline?code=518880&period=15m&limit=240"
curl "http://localhost:8081/api/sources/health"   # 源健康（成功率分母排除 na，03 §7）
```

- `app` 服务：`Dockerfile.app` 构建 `eestock-app`（web REST/WS + diagnose 读库 + SPA 托管），
  与数据面零 API 直连、只读库耦合，**不依赖 data 服务**（故障隔离）；宿主端口 8081（数据面 8080 不动）。
- REST/WS/SPA 契约见 `design/07-app-plane/00-web-api.md`；WS `/ws` 订阅分发
  `{type:"bar"|"quote"|"health"}`，断线退避重连由客户端。
- SPA：`web/dist` 为 Phase A 占位页；Phase B 前端构建产物同路径覆盖（镜像内 /app/dist）。
- 本地直跑调试：`cargo run -p app --bin eestock-app -- --config config/app.toml`
  （本地开发时 config 中 `static_dir = "./web/dist"`）。

## 常用命令

```bash
entangled tangle              # 从 design/ 重新生成代码（改文档后走这条）
./scripts/stitch.sh           # 改码后回写文档（沙箱 scoped + round-trip 校验，ADR-018 O1）
./scripts/check-tangle.sh     # tangle 一致性自检（同 pre-commit 门禁，ADR-018 硬化版）
bash scripts/tests/test_check_tangle.sh   # 门禁三态 fixture 自测
bash scripts/tests/test_stitch.sh         # stitch 入口自测（含拒绘回写负样例）
cargo check --workspace       # 全 workspace 编译检查
cargo test --workspace        # 测试（TDD：Red-Green-Refactor）
cargo clippy --workspace      # lint
docker compose up -d timescaledb
```

## 仓库布局

```
design/         # 事实源文档树（00-vision / 01-architecture+ADR / 02-domain / ... / 07-app-plane / ...）
crates/         # domain collector storage providers tushare diagnose mcp web app
migrations/     # TimescaleDB DDL（tangle 生成）
scripts/        # 工程脚本（check-tangle.sh 门禁 / stitch.sh 回写 / tests/ 自测 / lib/）
docker-compose.yml  Dockerfile（数据面，tangle）  Dockerfile.app（应用面，tangle）
```
