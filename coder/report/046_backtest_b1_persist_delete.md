# 046 — 回测后端增强 B1：初始金额/区间持久化 + 删除

> 本报告文件位置：`eestock-rs/coder/report/046_backtest_b1_persist_delete.md`
> 阶段：Wave 3 Phase 3b（B1）。权威：`design/08-backtest/01-engine-adr.md` §3/§7。
> 铁律：ADR-007（凡 tangle 生成文件先改 design 源再 `entangled tangle`；新 hand-written 手写并注明）。未 commit，`git diff --cached` 为空。

## 1. What changed（tracked diff + 新文件）

**Tangle 生成（改 design 源 → tangle 重生成）**：
| 文件 | 层 | 说明 |
|---|---|---|
| `design/04-storage/schema.md` | storage 设计源 | §4.3.5 增迁移 0012 SQL 块 + PgBacktestStore 契约描述更新（delete_run、三列落库） |
| `migrations/0012_backtest_run_extend.sql` | infra（tangle 生成，新） | `backtest_runs` 增 `initial_capital float8 NOT NULL DEFAULT 100000` / `date_from timestamptz NOT NULL` / `date_to timestamptz NOT NULL`；既有行用 created_at 回填后 SET NOT NULL |
| `design/02-domain/contracts.md` | domain 设计源 | `NewRun`/`RunView` 增 `initial_capital/date_from/date_to`；`BacktestRunStore` 增 `delete_run(id)->Result<bool>`；contracts_test 用例同步 |
| `crates/domain/src/ports.rs` | domain（tangle 生成） | 上述端口类型/方法 |
| `crates/domain/tests/contracts_test.rs` | domain（tangle） | NewRun/RunView serde roundtrip 含新字段 |
| `design/07-app-plane/00-web-api.md` | web 设计源 | §1.5 增 `DELETE /api/backtest/runs/{id}` 端点 + 字段口径；lib.rs 路由加 `.delete(...)`；dto.rs `BacktestRunDto` 增 3 字段 + 测试 |
| `crates/web/src/lib.rs` | web（tangle 生成） | 路由 `.route("/api/backtest/runs/{id}", get(backtest::get_run).delete(backtest::delete_run))` |
| `crates/web/src/dto.rs` | web（tangle 生成） | `BacktestRunDto` 增 `initial_capital/date_from/date_to` + From 映射 + 测试断言 |

**Hand-written（ADR-007 例外，已补契约描述）**：
| 文件 | 层 | 说明 |
|---|---|---|
| `crates/storage/src/backtest.rs` | storage（手写） | `create_run` 落 initial_capital/date_from/date_to；`row_to_run_view` 增 3 字段；增 `delete_run`（`DELETE ... WHERE id` + FK 级联） |
| `crates/application/src/service.rs` | application（手写） | `submit` 构造 `NewRun` 带 initial_capital/date_from/date_to；增 `delete_run(id)->Result<bool>` 委托 store |
| `crates/web/src/backtest.rs` | web（手写） | 增 `delete_run` handler（200 deleted / 404 not found） |
| `crates/storage/tests/backtest.rs` | storage 测试（手写） | new_run() 补字段；lifecycle 断言三列落库；增 `run_store_delete_run_cascades_results` |
| `crates/application/tests/service.rs` | application 测试（手写） | 3 处 NewRun 构造补字段；MockStore 增 `delete_run`；submit 单 run 断言三列落库；增 `delete_run_delegates_to_store` |
| `crates/web/tests/api_backtest.rs` | web 测试（手写） | submit 断言 DTO 三字段；增 `delete_run_returns_200_deleted_or_404` |

## 2. Architecture alignment

- **迁移 0012**（infra DDL）：`backtest_runs` 增列，属应用面自有表扩展（与 0011 同口径，不违 ADR-017）。
- **域端口**（domain）：`NewRun`/`RunView` 增加持久化字段、`BacktestRunStore::delete_run`。storage 实现该端口；application 只依赖端口。
- **application**：`submit` 把 `req.from/req.to/initial_capital` 落入 `NewRun`（`date_to = to`，排除端点）；`delete_run` 纯委托 store。
- **web**（Presentation）：`DELETE` handler 调 `BacktestService::delete_run`，映射 200/404；`BacktestRunDto` 暴露三字段。只依赖 application + domain 端口。

## 3. Problem solved / feature added

① **初始资金 & 区间持久化**：`SubmitReq.initial_capital`（默认 100_000）与 `from/to`（回测区间 `[from, to)`）此前仅运行时闭包使用，`backtest_runs` 无对应列。B1 增加 `initial_capital/date_from/date_to` 列，`submit` 落库，`RunView`/`BacktestRunDto` 暴露，前端可展示区间与初始资金。
② **回测结果删除**：新增 `DELETE /api/backtest/runs/{id}`，删 run 时 `backtest_results` 由 FK ON DELETE CASCADE 级联删除；200=deleted，404=not found。

## 4. Implementation approach（关键决策，父级已授权按 ADR 口径实现并注明）

- **`date_to` 存排除端点**：`SubmitReq.to` 为开区间端点 `[from, to)`，`NewRun.date_to = to`。前端展示 `from ~ to-1` 或 `from~to` 由前端处理，后端存原始 `to`（设计注记）。
- **迁移 0012 先加可空再 SET NOT NULL**：父级列定义为 `date_from/date_to timestamptz NOT NULL`（无 DEFAULT）。因既有测试库已有 14 行，直接 `ADD COLUMN ... NOT NULL` 会失败；实现改为「加可空 → 用 created_at 回填 → SET NOT NULL」，最终 schema 与父级口径一致（NOT NULL + initial_capital DEFAULT 100000）。此为对字面 ALTER 的最小合理适配，已在 schema.md 注明。
- **`RunRow` 由 16 元组改手动 `sqlx::Row` 按列索引提取**：新增 3 列后共 19 列，超出 sqlx 16 元组 `FromRow` 上限（且不引入 sqlx derive feature）。手写实现，列索引与 `RUNS_SELECT` 严格对应，增列需同步。
- **删除级联**：`delete_run` 单条 `DELETE FROM backtest_runs WHERE id=$1`；`backtest_results` 由 0011 建表时的 FK `ON DELETE CASCADE` 处理，无需额外 SQL。

## 5. Test coverage

- 域（contracts_test）：`backtest_run_types_serde_roundtrip` 含新字段往返。
- storage（tests/backtest.rs）：`run_store_lifecycle` 断言 `initial_capital=100000`、`date_from=base()`、`date_to=base()+1h` 落库；新增 `run_store_delete_run_cascades_results`（delete→true、get_run None、FK 级联删 results、delete 不存在→false）。
- application（tests/service.rs）：`submit_single_run_returns_run_id_and_no_group` 断言 NewRun 落库三字段；新增 `delete_run_delegates_to_store`（存在→true、不存在→false、委托两次）。
- web（tests/api_backtest.rs）：`submit_enqueue_then_list_get_compare` 断言 DTO `initial_capital=100000`、`date_from=2026-01-01T00:00:00Z`、`date_to=2026-12-31T00:00:00Z`；新增 `delete_run_returns_200_deleted_or_404`。
- dto（web）：`backtest_dto_json_shapes` 断言初始资金/date_from/date_to 序列化输出。

## 6. Verification

- `entangled tangle`：首跑生成（migration 0012 / ports.rs / contracts_test.rs / lib.rs / dto.rs）；再跑 `Nothing to be done.`（幂等）。
- `cargo check --workspace`：通过。
- `cargo test --workspace`：**exit 0**，全部 suite 绿（含 domain 16、application 11、storage backtest 3、web api_backtest 6）。
- `cargo clippy --workspace --all-targets`：exit 0，无 warning。
- 迁移 0012 已 `psql -f` apply 至 :5433 测试库：`ALTER TABLE` / `UPDATE 14` / `ALTER TABLE`×2；`information_schema` 确认三列 NOT NULL。
- 未 `git add`，`git diff --cached` 为空（`no-staged-files` 满足）。

## 7. Residual risks

1. **旧行（pre-0012）区间无法精确重建**：迁移回填把 `date_from=date_to=created_at`；历史 run 的精确区间/初始资金在 Phase 3b 前未存储（对应 040 报告残留风险 #1）。新 run 正确落库。
2. **`RunRow` 手动列索引脆弱**：增/改 `RUNS_SELECT` 列顺序需同步 `row_to_run_view` 索引（已注释）；未来若列多到难以维护可改 sqlx struct `FromRow`（需开 `derive` feature，本期未引入避免依赖变更）。
3. **删除与后台任务竞态**：若删除时后台回测任务仍在跑，其后续 `update_run_progress`/`mark_done` 影响 0 行或 `mark_done` 插结果触发 FK 冲突（记录 error，无脏数据）。可接受，未额外加锁。
4. **前端展示未动**：B1 为后端增强；`from~to`/`to-1` 展示由前端（3c/4 阶段）处理。
5. **0012 非 docker-entrypoint-initdb.d 自带**：fresh 容器按序跑 0011→0012 时表为空，无回填实体；已 apply 到运行库（与 0011 同口径注意）。

## 8. Staged files

**无 staged 文件**（`git diff --cached` 空）。工作区变更：13 个 tracked 文件 `M` + 新文件 `migrations/0012_backtest_run_extend.sql`（`??`）。未 commit。
