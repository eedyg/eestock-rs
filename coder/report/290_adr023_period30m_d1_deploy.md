# 290 — ADR-023 D1 上线实施（30m 数据 + 主图周期）部署报告

- **本文件位置（绝对路径）**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/290_adr023_period30m_d1_deploy.md`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`
- 上游实现报告：`coder/report/289_adr023_period30m_d1_impl.md`（R6 遗留项 = 本次 S1 修复对象）
- 逐步证据（命令原文 + exit code + 原始输出）：`/tmp/adr023-deploy-20260916-230726/EVIDENCE.md`
- 仓库 @ 起始 commit：`3094018f352dae25752340d78b5e108c284aeecc`（HEAD 至终未变；无 staged、无 commit、无 stash）
- 结论：**VERDICT: PASS**（S0–S7 全绿，未触发回滚）

## 1. 改了什么（本次部署对源码/文档的净改动）

本任务为**上线实施**，不是功能开发。对工作区的净改动只有 **2 个文档的散文**（S1）：

| # | 文件 | 位置 | 改动 | 行数 |
|---|---|---|---|---|
| 1 | `design/04-storage/02-tushare-sync.md` | §2 工作流注记 | 「之后的迁移一律走 sqlx migrate」→ 与实现一致的运维口径（活库无 `_sqlx_migrations` 台账；app 启动只做 schema 自检；现网增量迁移只能 `psql -v ON_ERROR_STOP=1 -f` 手工应用，不加 `--single-transaction`） | +5 / −2（相对 ADR-023 实现期既有改动之上） |
| 2 | `design/04-storage/03-raw-writer.md` | §3 标题 + 背景约束段 | 「sqlx migrate 自检的落地口径」→「app 启动 schema 自检的落地口径」；删去「0007+ 迁移的台账化接入随首个增量迁移一并设计」过期前瞻，改为运维口径 | +3 / −2 |

其余 21 个 tracked 文件的 `M` 状态均为 **ADR-023 实现期（289 报告）既有改动**，本任务未触碰。
新增未跟踪文件 = 本报告 + S1 未引入其他文件。**未改任何 file= 代码块**，未改 ADR-017 / wave-0.md。

### 未做的（禁令遵守）
- 未 `git add` / `git commit` / `git stash`（任务明令禁止 → 保持 **无 staged**）。
- 未用 `entangled tangle --force`；未做全局 `entangled stitch`。
- 未改 `.gitignore`；未动其他项目容器；除迁移 0026 外未改任何数据；未改本改动集之外源码。

## 2. 架构对齐（各改动所属层）

| 改动 | 层 | 归属理由 |
|---|---|---|
| `design/04-storage/02-tushare-sync.md` §2 注记 | 文档事实源层（`design/04-storage`）→ 描述 storage 迁移/运维口径 | 该文档 tangle 生成 `migrations/0005_*.sql` 与 storage/tushare 准确层；散文描述的是迁移工作流 |
| `design/04-storage/03-raw-writer.md` §3 | 文档事实源层 → 描述 app 面启动自检（ADR-017） | 该文档 tangle 生成 `crates/storage/src/migrate_check.rs`（启动 schema 自检） |
| 迁移 `migrations/0026_period_30m.sql`（在线应用，未改文件） | 存储层（TimescaleDB cagg/策略） | ADR-023 §2.4 |
| 二进制 `target/debug/eestock-app`（重建/部署） | 应用面 | ADR-023 §4.1 顺序：先落迁移再重启 app |

## 3. 解决的问题 / 交付的特性

把已通过实现评审与独立验收的 ADR-023（第 8 档 **30m**）**落到在线库并上线新二进制**，端到端可用：
- 在线库新增 `kline_accurate_30m` 连续聚合（全历史，口径 = M1 本地衍生），intraday accurate cagg 刷新窗口根治为统一 `3 days`；
- 补齐 `kline_accurate_5m` 自 2026-09-07 以来的历史缺口；
- 新二进制启动自检含 `kline_accurate_30m`，`GET /api/kline?...&period=30m` 端到端返回 30m K 线；
- 顺带修复实现报告遗留的 **R6**（文档仍写「之后的迁移一律走 sqlx migrate」的旧口径）。

## 4. 实施方法与关键决策（在既定架构内）

- **S0 冻结**：抓回滚件必须早于 S2 覆盖二进制——从 `/proc/1342449/exe` 复制到证据目录并记 sha256（`dab4504c…`）。
- **S1 只改散文**：编辑位置严格避开 ` ```{.sql file=…} ` / ` ```{.rust file=…} ` 代码块；改后 `entangled tangle` 输出 `Nothing to be done.`，20 个生成物 sha256 前后**逐字节一致**，`./scripts/check-tangle.sh` exit 0。
- **S2 按既有运维口径构建**：`cargo build --bin eestock-app`（debug），不用 deploy.sh；新二进制 sha256 `9a0586ff…`（尺寸 207066920，+1056B）。
- **S3 无显式事务**：`psql -v ON_ERROR_STOP=1 -f migrations/0026_period_30m.sql`（**不加 -1**），因建 cagg 视图与 refresh 不可置入显式事务块；`\timing on` 逐条计时。
- **S5 启动方式**：沿用既有运维口径（历史 `logs/app_dev_8081_redeploy_*.log` 与上一轮部署 shell 1342395 均为 `setsid nohup … < /dev/null`，日志落 `logs/app_dev_8081_redeploy_<ts>.log`），以保持会话无关的稳定脱离。已在证据中说明与任务字面命令的差异。
- **S7 不 staging**：任务禁令明确禁止 `git add`，故保持无 staged 提交面（与通用 coder 规则的差异由任务明文覆盖）。

## 5. 测试 / 校验覆盖

本任务为部署，无新增单元测试；以**在线只读断言 + 端到端冒烟**作为验收证据（tester 红测试与实现单测已在 289 阶段完成）：

- 门禁：`entangled tangle` = Nothing to be done.；`./scripts/check-tangle.sh` exit 0（改动前后各一次）。
- 落库后只读断言（S4 a–e）：cagg=10 含 30m；四策略 start_offset=3 days 且 end/schedule 保持；30m max(ts)=2026-09-16 07:00+00 且逐日非 0；5m 09-08..09-16 逐日非 0（基线为 0）；1h 无缺口。
- 端到端冒烟（S6）：`/healthz` 200；`/api/symbols` =44；`period=30m` → 200 且 120 bars、ts 严格单调、period="30m"；`period=30x` → 400 且错误含全部 8 档；启动日志 ERROR=0；8081/8082 属新 PID。

## 6. 验证方法（如何确认改动生效）

- DB 侧：迁移唯一一次应用 exit 0，总耗时 `real 0m40.350s`；三条 refresh 单独耗时 30m=1026.422ms / 5m=1145.264ms / 15m=495.487ms。**未在生产库重跑 0026**。
- app 侧：新旧 PID 对照 1342449 → 68833；新旧二进制 sha256 对照 `dab4504c…` → `9a0586ff…`；新进程 `/proc/68833/exe` 指向真实路径（非 deleted），启动日志 `schema self-check ok`。
- 前端：入口 bundle `index-CB06bOVO.js` sha256 `f8df4bb1…` 前后逐字节不变，磁盘与服务端一致（本任务不构建前端）。
- 副作用：`git status --porcelain -uno` = 23 行（与 S0 基线一致）；HEAD 未变；无 staged；`.gitignore` 未改；容器未重启；其他项目未动。

## 7. 残留风险与未决项

| # | 风险 / 未决 | 处置 / 说明 |
|---|---|---|
| D-R1 | 迁移仅在生产库**应用一次**，未在活库重跑验证幂等 | 幂等已由探测库 + 验收阶段证明；本轮按任务要求只做只读断言，未重跑 |
| D-R2 | 1h 策略改为 3 days 但**未**做全量刷（迁移设计明确不含） | 1h 无已知缺口，落库后逐日计数非 0；如后续发现缺口需单独全量刷 |
| D-R3 | 30m 建立时自动全量刷占 37.6s（16.3M M1 行 × 44 codes 全历史） | 已实测记录；非增量操作，仅首次建视图发生 |
| D-R4 | 旧进程 1342449 在重启前处于「exe deleted」态（因 S2 覆盖同路径二进制） | 回滚件已从 `/proc/<pid>/exe` 早于覆盖抓出并留证，可回滚 |
| D-R5 | 文档散文仍可能有其他过期口径（本轮只授权修 R6 两处） | 建议后续 sweep；未在本改动集内扩大范围 |
| D-R6 | 上一轮部署残留 shell 1342395（其子进程已被 kill） | 非本改动集产物；未主动清理（避免越权），仅记录 |
| D-R7 | 证据目录保留在 `/tmp/adr023-deploy-20260916-230726/` | 按任务要求保留供取证；含回滚二进制（207MB） |

## 8. 交付清单

- 源码/文档净改动：`design/04-storage/02-tushare-sync.md`、`design/04-storage/03-raw-writer.md`（散文）
- 在线状态：迁移 0026 已应用；新二进制（PID 68833）已上线；30m 端到端可用
- 证据：`/tmp/adr023-deploy-20260916-230726/EVIDENCE.md`（+ 原始输出文件、`eestock-app.rollback`）
- **无 staged 变更**（任务禁止 `git add`）
