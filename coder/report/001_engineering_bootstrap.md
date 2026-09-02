# Coder 报告 001：eestock-rs 工程基建

> 报告位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/001_engineering_bootstrap.md`
> 状态：除「domain tangled 代码 3 处编译错误待父级裁决」外全部完成；**未 commit、未 stage**，变更全部在 working tree。

## 1. 变更文件清单（全部新增，working tree untracked）

| 文件 | 说明 |
|---|---|
| `entangled.toml` | entangled 2.x 配置；`watch_list=["design/**/*.md"]`；注册 SQL 语言（内置表无 sql，缺它会静默跳过 migrations 生成） |
| `scripts/check-tangle.sh` | 一致性门禁：`entangled tangle && git diff --exit-code`；entangled 缺失时硬失败+安装提示 |
| `.git/hooks/pre-commit` | symlink → `../../scripts/check-tangle.sh`（不入库，安装方法已写入 README） |
| `Cargo.toml`（根） | workspace：resolver=2，members=crates/*，[workspace.dependencies] 统一清单 |
| `crates/domain/{Cargo.toml,src/lib.rs}` | domain 包 + 模块声明（types/provider/selector/ports/merge，均为 tangle 产物） |
| `crates/{collector,storage,providers,tushare,diagnose,mcp,web}/{Cargo.toml,src/lib.rs}` | 空壳 lib crate（doc 注释占位） |
| `crates/app/{Cargo.toml,src/main.rs}` | 二进制 `eestock`，main 仅打印 bootstrap 占位 |
| `crates/domain/src/{types,provider,selector,ports,merge}.rs` | **tangle 生成**（design/02-domain/contracts.md） |
| `migrations/{0001_init,0002_caggs,0003_compression,0004_metrics}.sql` | **tangle 生成**（design/04-storage/schema.md） |
| `docker-compose.yml` | timescaledb:latest-pg16（5433→5432、命名卷 eestock-timescale-data、pg_isready 健康检查、migrations 挂 initdb）+ app 占位（profiles=["app"]） |
| `rust-toolchain.toml` | channel=stable + rustfmt/clippy |
| `.gitignore` | target/、node_modules/、.env*、.entangled/ 等 |
| `README.md` | 项目简介/文学式纪律/hook 安装/compose 启动/常用命令 |
| `Cargo.lock` | cargo check 生成 |

## 2. entangled 版本与安装方式

- 版本：**Entangled 2.4.0**，位于 `/home/eestock/.local/bin/entangled`（pip 用户级安装，`entangled-cli` 包，Python 3.12 site-packages）。
- 关键配置发现：2.4.0 内置语言表**不含 SQL**，必须在 `entangled.toml` 用 `[[languages]]` 注册，否则 sql 代码块被警告跳过、不生成文件（已在配置中修复并注释说明）。
- tangle 实跑输出：9 个目标文件全部 `create` 成功，二次运行 `Nothing to be done`（幂等）。

## 3. ⚠️ domain tangled 代码编译结果：3 个错误（未修复，按约束交父级裁决）

`cargo check --workspace`：**8 个空壳 crate 全部通过**；`domain` 失败（3 errors）。错误根源均在 design 文档代码，我未做任何修改：

1. **`crates/domain/src/ports.rs:29` — E0584**：`HealthMonitor` trait 最后一行是 `/// 熔断口径：...` 文档注释，其后无任何 item →「doc comment doesn't document anything」。
   源：`design/02-domain/contracts.md` §2.4。候选修法：`///` 改 `//`，或把该注释移到 `healthy_minute_sources` 之上。
2. **`crates/domain/src/ports.rs:30` — 解析错误**：`unexpected end of input`（由 1 连带，闭合 `}` 被吞）。修 1 即愈。
3. **`crates/domain/src/merge.rs:14` — E0277**：`sort_by_key(|b| (b.code.clone(), b.ts))` 要求 `(Code, DateTime<Utc>): Ord`，但 `Code`（§2.1）只 derive 了 `PartialEq/Eq/Hash`，未 derive `PartialOrd/Ord`。
   源：`design/02-domain/contracts.md` §2.1 + §2.5。候选修法：给 `Code` 补 `PartialOrd, Ord` derive（String 天然 Ord，无语义变化）；或 merge.rs 改用 `sort_by` 显式比较 `code.0`。

**请父级裁决修文档方向后，我改 design/ 并重新 tangle 验证。**

## 4. 门禁 hook 验证证据

- 安装：`.git/hooks/pre-commit -> ../../scripts/check-tangle.sh`（symlink）。
- 正常路径：`./scripts/check-tangle.sh` → `entangled tangle`（Nothing to be done）→ `git diff` 无差异 → `✅` exit 0。
- 缺失路径：`env PATH=/usr/bin:/bin ./scripts/check-tangle.sh` → 打印安装指引（pipx/pip）+ `--no-verify` 提示，**exit 1 硬失败**，非静默放行。
- 收尾复验：`entangled tangle && git diff --exit-code` → GATE-PASS。

## 5. docker-compose 验证

本机无 compose v2 插件，用 `docker-compose 1.29.2 config --quiet` 校验通过（v1.28+ 支持 profiles；depends_on condition 亦兼容）。端口 5433、命名卷 `eestock-timescale-data`、健康检查 pg_isready、migrations 只读挂载 initdb。

## 6. 验证命令汇总

| 命令 | 结果 |
|---|---|
| `entangled tangle`（首次） | 9 文件生成成功 |
| `entangled tangle && git diff --exit-code` | 通过 |
| `cargo check -p collector -p storage -p providers -p tushare -p diagnose -p mcp -p web -p app` | 通过 |
| `cargo check --workspace` | ~~失败：domain 3 errors（见 §3）~~ → 裁决修复后**全部通过**（见 §9） |
| `docker-compose config --quiet` | 通过 |
| `env PATH=/usr/bin:/bin ./scripts/check-tangle.sh` | exit 1 + 友好提示（符合设计） |

## 7. 网络/依赖说明

crates.io sparse index 与 static.crates.io 可达（本机已实拉 sqlx 0.8/axum 0.8 等并编译），未使用离线策略。workspace.dependencies 未超出父级给定清单（tokio full / axum / sqlx[runtime-tokio,tls-rustls,postgres,chrono,migrate] / serde / serde_json / chrono / async-trait / thiserror / anyhow / tracing / tracing-subscriber / rand）。

## 9. 追加（父级裁决执行记录）

父级裁决（3 处全选候选A），已执行并复验：

- `design/02-domain/contracts.md` §2.4：`/// 熔断口径：...` → `// 熔断口径：...`（说明性注记非文档注释）
- `design/02-domain/contracts.md` §2.1：`Code` derive 补 `PartialOrd, Ord`
- `entangled tangle` 重新生成 types.rs/ports.rs；`cargo check --workspace` **全部通过**（含 domain）
- design diff 仅上述 2 行（已用 `git diff` 核实）；模拟真实提交（`git add -A` 后跑 hook）：`entangled tangle` → Nothing to be done → `git diff` 无差异 → ✅ exit 0；随后 `git reset` 恢复未暂存状态
- 注：门禁语义核实——hook 在「design 有未暂存修改」时也会拦下（`git diff` 对 worktree vs index），符合预期工作流（design 与再生成物一并 stage 提交）

## 8. 残留风险

- ~~domain 编译失败未决~~ → 已按父级裁决修复并复验通过（见 §9），不再有编译阻塞。
- `docker compose`（v2 插件）未安装，仅 v1 可校验语法；`docker compose up` 未实跑（避免拉镜像/起容器越权）。
- hook 不入库，克隆后需按 README 手动安装（已在 README 加粗说明）。
