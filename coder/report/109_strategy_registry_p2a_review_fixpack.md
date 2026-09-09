# 109 — P2a 修复包：Registry 后端评审 findings（2 MAJOR + 4 MINOR + NIT 并案）

- 报告位置：`coder/report/109_strategy_registry_p2a_review_fixpack.md`
- 分支/基线：master（P2a 已验收 7/7 PASS 的工作树上叠加）；状态：**已 git add，未 commit**。

## finding → 修复 → 测试证据对应表

| Finding | 修复（文件/位置） | 测试证据 |
|---|---|---|
| **MAJOR-1** async 阻塞：async fn 内裸跑同步 QuickJS 段 | `crates/application/src/strategy.rs`：新增 `blocking()`（`tokio::task::spawn_blocking` + JoinError→anyhow，与 `service.rs:242` 回测引擎同模式）；`publish_smoke`（publish / test_run inline / test_run version 兜底 3 处）、`extract_schema`（create_strategy / create_draft_from / update_draft / seed 4 处）、`run_pure_score` / `run_sim_position`（test_run 引擎段）全部包入；QuickJS 非 Send 实例均在闭包内创建/drop | 回归：`cargo test -p application --test strategy` 25/25 绿（test_run/publish 端到端用例原样通过） |
| **MAJOR-2** publish TOCTOU | `design/02-domain/contracts.md` + tangle → `crates/domain/src/ports.rs`：`mark_published` 增加 `expected_code` 参数，契约改为 `WHERE id=$1 AND status='draft' AND code=$expected_code`；`crates/storage/src/strategy.rs` SQL 落地；`application/strategy.rs::publish` 传入冒烟过的 `v.code` 原文，0 行命中 → `StrategyInvalidTransition`（web 既有映射 → **409**）；seed 路径传 `plugin.code` | 新增应用层用例 `publish_conflict_when_code_changed_concurrently`（mock 竞态注入钩子：落库前并发改 code → 409，版本保持 draft 且 code 为并发新值）、`publish_conflict_when_status_changed_concurrently`（并发抢先发布 → 409）；存储层 `mark_published_requires_draft_and_expected_code`（错 code→None 且保持 draft / 对 code→命中 / 已 published→None） |
| **MINOR-1** trigger 状态机补强（含 **NIT-3** 并案） | 改 design 源 `design/04-storage/schema.md` §4.3.13 + `entangled tangle` → `migrations/0022_strategy_registry.sql`：① published 行 status 变更目标仅允许 `archived`；② `archived` 终态禁止任何 status 变更（同值 no-op 放行）；③ published 行冻结字段补 `strategy_id`/`published_at`；已 `CREATE OR REPLACE FUNCTION` 应用到 :5433 开发库 | 新增存储集成 `trigger_status_machine_and_published_frozen_fields`：published→draft 拒 / published→archived 放行 / archived→draft、archived→published 拒 / strategy_id、published_at 改写拒 / archived→archived no-op 放行 |
| **MINOR-2** migrate_check 登记 | 改 design 源 `design/04-storage/03-raw-writer.md` + 重 tangle → `crates/storage/src/migrate_check.rs`：`EXPECTED_RELATIONS` 补 `"strategy", "strategy_version"` | 存储集成 `raw_writer.rs` 内 `verify_schema` 用例（0001-0022 已落库）随 `cargo test -p storage` 绿 |
| **MINOR-3** mock 保真 | `crates/application/tests/strategy.rs` MockStore.catalog：先按 level 集合（at-least）过滤版本行、再取每策略最新 published（对齐 SQL `WHERE approval_level = ANY + DISTINCT ON`）；SQL 本身语义已正确，补形态锁定 | 新增应用层 `catalog_filters_level_set_before_latest_published` 与存储层同名用例：v1 published(sim_ok) → v2 published(backtest_ok)，查 level=sim_ok 返回 **v1** 条目；无过滤返回 v2 |
| **NIT-1** update_draft 推进 updated_at | `crates/storage/src/strategy.rs::update_draft`：命中时同事务 `UPDATE strategy SET updated_at = now()`（与 create_version 对齐）；MockStore 同步对齐（bump_seq 使 FixedClock 下推进可观测） | 新增应用层 `update_draft_advances_strategy_updated_at`、存储层同名用例（sleep 20ms 后断言 after > before） |
| **NIT-2** | 已含于 MAJOR-2（`WHERE status='draft'`） | 同 MAJOR-2 status 漂移用例 |

## 架构对齐

- domain（`ports.rs`，tangle 自 contracts.md）：仅按父级已采纳裁决扩展 `mark_published` 端口签名（+`expected_code`），未动其他端口/边界。
- storage（`strategy.rs` 手写、`migrate_check.rs`/`0022.sql` tangle 生成物改 design 源再 tangle）：SQL 原子条件与 trigger 双保险，属 Infrastructure 层职责。
- application（`strategy.rs` 手写）：`blocking()` 复用 crate 内既有 spawn_blocking 模式；409 语义复用既有 `StrategyInvalidTransition`→web 409 映射，web 层零改动。
- 红线遵守：未改 12-strategy-system 两份文档；未动 strategy-runtime/core/backtest/simlive；无新依赖（tokio "full" 已在 workspace）。

## 验证记录

- Red：先写测试——`mark_published` 签名变更导致编译错（E0050/E0061，签名 red）；竞态用例对旧 mock 语义可复现失败（首次运行 `publish_conflict_when_code_changed_concurrently` 因注入点设计在旧语义下 Ok → 红，修正为落库前注入后转绿）。
- Green：`cargo test -p storage -p application -p web -p domain`（`--no-fail-fast`）全绿，唯一失败 `alert_store::list_events_filters`（pre-existing 环境性：共享开发库 alert_events 窗口计数脏数据，本修复包不涉及任何 alert 文件，任务书允许）。
- Clippy：`cargo clippy -p storage -p application -p web -p domain --all-targets`——新增/变更代码 0 warning（修复了自身引入的 1 个 `unnecessary_map_or`）；残余 warning 均在未触碰的 `simlive.rs`/`reader.rs`（pre-existing）。
- Tangle：`entangled tangle` 二次运行 0 文件改写（无 diff，幂等）。
- DB：更新后的 guard 函数已 `psql -f migrations/0022_strategy_registry.sql` 应用（`CREATE OR REPLACE FUNCTION` 成功，既有 trigger 按名引用即生效，`\sf` 已核验新逻辑在库）。

## 变更文件（已 git add，未 commit）

- `design/02-domain/contracts.md`、`design/04-storage/schema.md`、`design/04-storage/03-raw-writer.md`（design 源）
- `crates/domain/src/ports.rs`、`crates/storage/src/migrate_check.rs`、`migrations/0022_strategy_registry.sql`（tangle 生成物）
- `crates/storage/src/strategy.rs`、`crates/application/src/strategy.rs`（手写实现）
- `crates/storage/tests/strategy_store.rs`（+4 用例）、`crates/application/tests/strategy.rs`（mock 对齐 + 5 用例）

## 残余风险

- `alert_store::list_events_filters` 环境性失败照旧（任务书允许；与本次变更无交集）。
- trigger 状态机补强依赖迁移重放：新环境跑全量 migrations 自然生效；既有环境需重放 0022（`CREATE OR REPLACE FUNCTION` 幂等）。
