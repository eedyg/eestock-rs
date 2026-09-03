# Coder 报告 003：Wave 0 — 完备产品级数据获取（数据面）

> **报告位置**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/003_wave0_data_plane.md`
> 状态：全部范围完成；**只 stage 不 commit**（父级裁决确认）；建议按下文 §8 切分 commit。

## 0. TL;DR

- 全 workspace **79 测试全绿**（基线 12 → 79，净增 67），`cargo clippy --workspace --all-targets` **0 警告**（含既有 unused import 清理）
- `./scripts/check-tangle.sh` 通过；`docker build` 成功；`docker-compose up -d data` 冒烟：**容器 healthy、/healthz 200、/admin 404、44/44 标的当日 240 分钟全量回填零缺口、双源事件落库、当班轮换生效**
- 架构偏差：**零**（三处规格/证据冲突全部走 supervisor 裁决，见 §6）

## 1. 变更文件（全部已 stage；92 files, +7728/−55）

| 层 | 文件 | 说明 |
|---|---|---|
| design（事实源） | `design/02-domain/contracts.md` | SourceId `*Approx` 变体 + as_str/is_approx/approx/base；920 北交所前缀修正；ErrKind/HealthEvent/EventSink/RawBarReader/Clock/SystemClock/new_trace_id；tz 模块；§2.7 契约测试 |
| | `design/03-collector/00-design.md` | §9 collector 全量实现（clock/calendar/circuit/executor/gapfill/standby/scheduler/service）+ §9.10 测试 |
| | `design/03-collector/01-providers-spec.md` | §3 Exchange 深交所端点勘误（裁决）；§6 providers 全量实现 + golden/行为测试 |
| | `design/03-collector/02-data-plane.md`（新） | app crate（config/healthz/eestock-data）+ Dockerfile + 测试 |
| | `design/04-storage/02-tushare-sync.md` | source_str 收敛到 domain；lib.rs 增模块；§6 tushare 日增量任务 |
| | `design/04-storage/03-raw-writer.md`（新） | KlineWriter/EventSink/migrate_check/SymbolRegistry/RawBarReader + 集成测试 |
| | `design/99-decisions-log.md` | 勘误记录 4 条（裁决要求） |
| crates | domain / providers / collector / storage / tushare / app | 全部由 design tangle 生成（lib.rs 声明等手写例外除外） |
| golden | `crates/providers/testdata/` | 11 个 golden（qt/hq 为旧仓真实原文复制；ifzq/sina 取 028 报告真实样本；thscs/push2delay/exchange 按 verify 脚本锁定结构重建，数值取冒烟 CSV；**每文件头部注明出处**）+ smoke CSV×7 辅助 |
| 工程 | `Cargo.toml`(workspace) / 各 crate Cargo.toml / `entangled.toml` / `.dockerignore` / `docker-compose.yml` / `config/data.toml.example` / `README.md` / `Dockerfile`（tangle） | encoding_rs+toml 批准引入；tracing-subscriber 加 json feature；compose `app` 占位替换为 `data` 服务 |

## 2. 测试覆盖摘要（79 = 67 新增 + 12 既有）

| crate | 测试数 | 内容 |
|---|---|---|
| domain | 12 | 市场前缀（含 920 实锤 bug）、serde 往返、SourceId/approx 口径、selector（当班链首/轮转/熔断剔除/空池）、DutyRoster（确定性/交替/窗长 20-40）、merge（准确优先/补缺/仅准确保留/排序）、ProviderError 分类、ErrKind 表、Trace ID 格式 |
| providers | 14 | golden 解析 ×10（字段序陷阱/单位换算/GBK/JSONP 剥离/fltt=2 强转/停牌 "-" /NoData 形态）+ 行为 ×4（Referer 必带/备域兜底/双败传播首错/限频门）；全 mock 不触网 |
| storage | 10（含既有 2） | 首写胜出断言行数、`*_approx` 落库、空批、事件往返（na/circuit_open）、verify_schema 通过与缺失检测、symbols upsert/热生效、existing_ts CST 日界 |
| collector | 22 | 日历（240 分钟/午休边界/周末）、熔断状态机全路径（3 败→Open→60s→HalfOpen→闭合；冷却 ×2 封顶 30min；RL 5s→10s→30s 不进熔断；手动复位）、执行器（首源成功不转移/NoData 记 NA 不转移/RL 转移不熔断/全链失败 code 级事件+同 Trace ID/熔断源剔除）、缺口计算（午休不误判/未来分钟不算/非当日空）、回填只写缺失 ts、降级合成（OHLC≈价/量差分/`*_approx`）、Tier2 退避不轰击、乱序池承接、调度相位对齐+抖动+fetch_limit |
| tushare | 18（含既有 10） | 日增量：15:30 CST 触发点计算（当日/次日/跨周末）、退避 ×2 封顶、checkpoint 增量、重试至成功、重试耗尽跳过续跑、RateLimited 整轮中止、已最新零调用 |
| app | 3 | TOML 解析+默认值+env 覆盖（secret 口径）、healthz 200/404、self_check 宕机 false |

集成测试（storage×10）需 TimescaleDB :5433；其余全部 mock provider + fake clock，不触网。

## 3. 验收清单对照（wave-0.md）

| 验收项 | 状态 | 证据 |
|---|---|---|
| `entangled tangle && git diff --exit-code` 通过 | ✅ | `./scripts/check-tangle.sh` ✅（stage 后复跑亦过） |
| domain/providers/storage/collector 单测全绿（不触网） | ✅ | 79/79，详见 §2 |
| `docker compose up -d` 起全栈，/healthz 可达，采集自启 | ✅ | `docker-compose up -d data` → 双容器 healthy；`curl /healthz` → `{"status":"ok"}`；日志显示启动即回填 + 周期采集 |
| 实盘 1 交易日缺口率 <1% | ⏳ 架构师安排 | 范围外（实盘验证）；冒烟时刻 44×240 全量无缺口（DB 实测 10560 行） |
| 杀源演练（腾讯→新浪转移、双杀→降级 `*_approx`、恢复回切） | ⏳ 架构师安排 | 范围外；对应行为已由 executor/circuit/standby 单测锁定 |
| tushare 日增量 fake clock 单测 + 真实收盘后增量 | 单测 ✅ / 实盘 ⏳ | daily_sync.rs 8 测试；真实触发待 15:30（容器内任务已在跑） |

补充：`docker compose build data` 等价验证 = `docker build -t eestock-data:wave0 .` 成功（本机无 compose v2 插件，用 docker-compose 1.29.2 + docker 29.1）。

## 4. 架构偏差说明（应为零 → 实为零）

- domain 零基础设施依赖（仅 chrono/serde/rand 等既有）；providers/storage/tushare 实现 domain trait；collector 只依赖 domain；app 单向装配；无跨层直达。
- Clock trait 放 domain::ports（collector 与 tushare 跨层共用，避免 infra→app 反向依赖）——经分析属端口定义，非边界破坏。
- 数据面唯一端口 /healthz:8080，手写 ~40 行 TCP HTTP，**不引 axum**（ADR-017 最小攻击面）；/admin → 404 实测。
- `SourceId` 增 `*Approx` 变体、ports 增 EventSink/RawBarReader/Clock：均为**加法扩展**（spec 明确要求 `source=*_approx` 与事件落库），无既有契约修改/破坏。

## 5. 规格冲突与裁决记录（全部走 supervisor，无自行决定）

1. 依赖批准：encoding_rs + toml 批准；uuid 不引（Trace ID = rand 32hex，已在 domain 文档注明口径）。
2. golden 口径：out/ 只有汇总 CSV 无原始响应 → 批准方案 A（真实原文 + 028 锁定结构重建，逐文件注明出处）。
3. Exchange 深交所端点：spec ShowReport 无实盘样本 → 裁决改 getTimeData（028 实证），spec 已勘误 + decisions-log 记录。
4. 提交纪律：只 stage 不 commit（角色规则优先），本报告给出建议 commit 切分（§8）。

## 6. TDD 过程证据（Red→Green 实锤）

- domain：先 tangle 契约测试 → 编译失败（Red）→ 实现补齐 → **market 前缀测试实锤 920 北交所 spec bug**（修 design 后绿）。
- providers：golden 计数先按截断样本估 3 行，实测原文 4 行（Red→修）；ifzq 2 号位"收非高"由 golden 断言锁定。
- storage：并行测试 code 冲突（RowNotFound Red）→ 按 code 隔离。
- collector：backfill duty 随机性致 mock 落空（Red）→ 双源均给全量；fetch_limit 计数断言先错 1（Red→修口径注释）。
- app：TUSHARE_TOKEN 真实 env 泄漏 + current_thread runtime 阻塞饿死 server 任务（双双 Red）→ env 暂存恢复 + spawn_blocking。

## 7. 已知口径说明（非偏差，供 reviewer 知悉）

- **scheduler 非交易时段静默跳过**：§2 原文"记 NA 不记失败"若按字面每分钟×44 标的刷 NA 事件将淹没 source_health_events（≈50M 行/月）；落地为静默跳过，NA 事件由源端 NoData 响应承载（与 §7 事件模型/028 口径一致）。已在 design §9.9 模块头注明。
- **migrate 自检口径**：0001–0006 由 initdb 落库无 `_sqlx_migrations` 台账，启动自检落地为关键关系+hypertable 存在性校验（缺失即拒启）；0007+ 台账化随首个增量迁移设计（Wave 1）。已在 03-raw-writer.md §3 注明。
- `HealthEvent.trace_id` 不落表（schema 无此列），贯穿 tracing JSON 日志（实盘日志已验证 trace_id 字段）。
- 既有未跟踪文件 `backup_symbols.sql`、`logs/*`（父级运维产物）未纳入 stage。

## 8. 建议 commit 切分（conventional commits）

1. `feat(domain): SourceId *Approx 变体 + ErrKind/EventSink/Clock/tz 端口扩展 + 920 北交所前缀修正 + 契约测试`
2. `feat(providers): Tier1（TencentIfzq/SinaJsonp）+ Tier2 快照池五源 golden 驱动实现`
3. `feat(storage): KlineWriter 首写胜出 + PgEventSink + schema 启动自检 + SymbolRegistry/RawBarReader`
4. `feat(collector): Scheduler/FetchExecutor/CircuitRegistry/GapBackfiller/StandbyReserve 全量 + fake clock 单测`
5. `feat(tushare): 日增量定时任务（15:30 CST，退避重试 3 次，事件落库）`
6. `feat(app): eestock-data 数据面进程 + TOML 配置 + JSON 日志 + /healthz`
7. `feat(deploy): 多阶段 Dockerfile + compose data 服务 + 配置模板`

## 9. 当前运行态（reviewer 注意）

`eestock-data` 容器**正在运行**（`docker-compose up -d data` 后未停，生产形态验证）：交易日盘中持续采集 44 标的，tushare 日增量已排程当日 15:30 CST。如需停止：`docker-compose stop data`（timescaledb 保持）。
