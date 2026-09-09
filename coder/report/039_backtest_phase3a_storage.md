# 039 — Backtest Phase 3a：存储迁移 0011 + 域端口 + storage 实现

> 本报告文件位置：`eestock-rs/coder/report/039_backtest_phase3a_storage.md`
> 阶段：Wave 3 Phase 3a（数据/应用面）。权威：`design/08-backtest/01-engine-adr.md` §3/§7。
> 铁律：ADR-007（先改 design 文档块、再 `entangled tangle` 重生成，**严禁手改生成文件**）。未 commit，已 stage 检查为空。

## 1. 需求

`backtest` crate（纯逻辑引擎+7策略）已提交 97fe314。本阶段补齐数据/应用面：
- 迁移 0011：`backtest_runs` + `backtest_results`。
- 域端口：`BacktestBarRead` / `BacktestRunStore` / `BacktestProgressSink`。
- storage 实现：`BacktestBarRead`（统一读源 accurate 优先 + cagg 兜底）与 `BacktestRunStore`（PgPool CRUD）。
- WebState DI 为**可选**（service 3b 才接），本阶段**暂不加**（无应用层，避免空占位+破坏 AppState 全部构造点）。

## 2. 变更清单（tracked diff + 新增）

**Tracked 修改（352 insertions）**：
| 文件 | 层 | 说明 |
|---|---|---|
| `design/02-domain/contracts.md` | domain 设计源 | 新增回测端口块（§2.4 内 ports.rs 尾部）+ contracts_test 3 个新测试 |
| `crates/domain/src/ports.rs` | domain（tangle 生成） | 由 contracts.md 生成：RunStatus/NewRun/RunFilter/RunResult/RunView + 3 traits |
| `crates/domain/tests/contracts_test.rs` | domain（tangle） | 生成：run_status_str_and_parse / backtest_run_types_serde_roundtrip / run_filter_defaults |
| `design/04-storage/schema.md` | storage 设计源 | 新增 §4.3.5：迁移 0011 SQL 块 + backtest.rs 非 tangle 契约描述 |
| `migrations/0011_backtest.sql` | infra（tangle 生成） | 由 schema.md 生成：两张表 + 3 索引 |
| `design/04-storage/02-tushare-sync.md` | storage 设计源 | lib.rs 块新增 `pub mod backtest;` |
| `crates/storage/src/lib.rs` | storage（tangle） | 生成：注册 `pub mod backtest;` |
| `Cargo.toml` | workspace（手写例外） | sqlx 增开 `json` feature（jsonb 列支持） |
| `Cargo.lock` | lock | sqlx json feature 依赖解锁 |
| `crates/domain/Cargo.toml` | 手写 | serde_json 升为常规依赖（ports.rs 用 Value） |
| `crates/storage/Cargo.toml` | 手写 | serde_json 升为常规依赖（backtest.rs 用 Value） |

**新增（非 tangle 手写，已在 design 文档补契约描述）**：
| 文件 | 说明 |
|---|---|
| `crates/storage/src/backtest.rs` | 216 行：`BacktestBarReader` + `PgBacktestStore`（非 tangle；契约见 schema.md §4.3.5） |
| `crates/storage/tests/backtest.rs` | 131 行：集成测试（非 tangle） |
| `design/08-backtest/01-engine-adr.md` | ADR §2 端口名 `BarSourceRead` → `BacktestBarRead`（父级批复口径；该目录**本就未 git tracked**，预置） |

## 3. 架构对齐

- **域端口**（domain 层）：`BacktestBarRead`/`BacktestRunStore`/`BacktestProgressSink` 在 `domain::ports`。
  storage 实现 `BacktestBarRead`/`BacktestRunStore`；`BacktestProgressSink` 由 web/application 实现（本阶段不落 storage）。
- **Bar 类型归属**（父级批复）：端口用 `domain::Bar` + `domain::Period`（storage 直接产；application 层 3b 做
  `domain::Bar -> backtest::Bar` 映射）。**未引入跨层依赖**：storage 只依赖 domain；backtest crate 未改动。
- **storage 实现**（infra 层）：`backtest.rs` 复用 KlineReader 统一读源口径（accurate 优先 + cagg 兜底）。
- **迁移**（infra DDL）：表属**应用面自有**（与 circuit_reset_requests/alert_events 同口径，数据面/引擎不回写，不违 ADR-017）。

## 4. 实现要点

- **迁移 0011**：`backtest_runs(id, code, period, strategy_id, params_json, fee_json, status CHECK(pending/running/done/failed), progress 0-100, current_ts, created_at, finished_at, error, group_id)`
  + `backtest_results(run_id PK→backtest_runs ON DELETE CASCADE, net_value_json, trades_json, metrics_json)` + 3 索引。
- **BacktestBarRead**：`bars(code, &Period, from, to)` 读 `[from,to)` 升序。M1 走 `kline_merged`；5m/15m/1h/1d 走
  accurate/cagg + 底层兜底反连接剔重（复用 reader.rs 同语义）。兜底 cagg 行 source=NULL → `SourceId::parse().unwrap_or(Tushare)` 占位（backtest 不消费 source）。
- **BacktestRunStore**：`create_run`(pending+return id) / `update_run_progress`(progress/current_ts + pending→running) /
  `mark_done`(事务内置 done + upsert result 3 列) / `mark_failed` / `list_runs`(status/group filter) / `get_run`(联表)。
- **ProgressSink**：仅定义端口（domain），web/application 实现。
- **`serde_json::Value` jsonb 绑定**：需 sqlx `json` feature（workspace 依赖增开；非新外部 crate，serde_json 已在树内）。

## 5. 测试覆盖

- domain（contracts_test）：`run_status_str_and_parse`、`backtest_run_types_serde_roundtrip`、`run_filter_defaults`（新增 3 用例）。
- storage（tests/backtest.rs）：`bar_read_m1_accurate_first_in_range`（M1 accurate 优先 + [from,to) 升序边界）、`run_store_lifecycle`（create→progress→done+failed 状态机）。
- 既有 storage/domain/backtest 测试全部保持通过。

## 6. 验证

- `entangled tangle`：`Nothing to be done`（幂等，diff stat 前后一致）。
- `cargo check --workspace`：通过。
- `cargo test -p backtest`：43 + 2 passed。
- `cargo test -p domain`：16 passed（含新增 3）。
- `cargo test -p storage`：全部 passed（含新增 2）。
- `cargo test --workspace`：**exit 0**（全部 suite 绿）。
- `cargo clippy -p domain -p storage --tests`：exit 0，无 warning。
- 迁移 0011 已 `psql -f` apply 到 :5433 测试库（`SELECT to_regclass` 确认两表存在）。

## 7. 残留风险

1. **AppState DI 未接**：本阶段无 application 层 BacktestService，故 `AppState` 未加 backtest 字段（web/WS 端点 3b 才接）。前端暂不可调用回测。
2. **schema 自检（EXPECTED_RELATIONS）未同步 backtest 表**：避免「未 apply 0011 时应用启动即失败」。若部署时先升 binary 后升 DB，建议补入 `migrate_check`。
3. **兜底 cagg source 占位**（NULL→Tushare）：仅影响被丢弃的 source 字段，backtest 引擎不消费。若未来分析需要，需另定下游。
4. **`mark_done` 签名细化**：父级批复字面为 `result_json: Value`，但 `backtest_results` 是 3 列（net_value/trades/metrics），故实现用 `&RunResult`（domain 类型）以正确映射。此为对批复的**最小合理细化**，可在评审时否决。
5. **design/08-backtest/ 目录在 git 中未 tracked（预置）**：ADR 改名变更在该未跟踪目录内，待该目录首次 commit 时一并入库。
6. **0011 非 docker-entrypoint-initdb.d 自带**：新容器需重建 volume 或手动 `psql -f`（本次已对运行库 apply）。

## 8. 暂存检查

未 `git add`，`git diff --cached --name-only` 为空（不 commit）。新增文件（backtest.rs / backtest 测试 / 0011 SQL / design/08-backtest）为 `??`，tracked 改动为 `M`（未暂存）。
