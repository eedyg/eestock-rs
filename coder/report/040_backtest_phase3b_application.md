# 040 — Backtest Phase 3b：应用层 `BacktestService`（异步任务队列 + 真实进度上报）

> 本报告文件位置：`crates/../coder/report/040_backtest_phase3b_application.md`（即本文件，相对 `eestock-rs/` 为 `coder/report/040_backtest_phase3b_application.md`）。
> 权威依据：`design/08-backtest/01-engine-adr.md` §7；ADR-007（改 design 源→tangle 生成生成文件；新 crate 手写）。

## 1. What changed

**新增 crate `crates/application`**（手写，ADR-007 例外；workspace `crates/*` 自动纳入 membership，`Cargo.lock` 已更新）：
- `Cargo.toml`：`application` 包；依赖 `domain` + `backtest` + `tokio`/`chrono`/`serde`/`serde_json`/`anyhow`/`tracing`；dev-dep `async-trait`。
- `src/lib.rs`：模块声明（fee / params / service / types）。
- `src/types.rs`：`SubmitReq`（code/period/from/to/strategy_id/params或params_grid/fee/initial_capital）、`SubmitOutcome`（`Run(i64)` / `Group(String)`）。
- `src/params.rs`：网格展开 `"起:止:步长"` 笛卡尔积 + `serde_json` → `StrategyParams`。
- `src/fee.rs`：`{rate_pct,min_fee,slippage_bp}` → `FeeModel`（`stamp_duty_pct=0.05` ADR bt-1 常量）。
- `src/service.rs`：`BacktestService`（submit/list_runs/get_run/compare/strategies）+ `execute_run`/`run_one` + `parse_period`。
- `tests/service.rs`：mock 端口集成测试（10 条）。

**修改 backtest crate**（父级已批准的小改，纯逻辑无 IO）：
- `crates/backtest/src/engine.rs`：`run_with_progress(bars, strategy, progress)` 方法与 `run_with_progress` 自由函数；`run` 保持原签名改为委托无进度版本；每 bar 回调 `progress(i, n, bar.ts)`；新增可复现单测（调用次数/total/ts/末次索引；pct 单调）。
- `crates/backtest/src/lib.rs`：re-export `run_with_progress`。

**修改 domain 契约（方案 A，父级已批准）**：
- `design/02-domain/contracts.md` §4.3：`create_run(&mut self)` → `(&self)`（理由 + 审批注记）。
- `crates/domain/src/ports.rs`：由 `entangled tangle` 单向重生成（`create_run(&self)`）。
- `crates/storage/src/backtest.rs`：`PgBacktestStore::create_run` 签名同步改 `&self`。
- `crates/storage/tests/backtest.rs`：`let mut store` → `let store`（`create_run` 改 `&self` 后无需 mut；clippy 无告警）。

## 2. Architecture alignment

- `application` 层（BacktestService）位于 `backtest` crate 与 `domain` 端口之间，只依赖 `domain::ports`/`domain::types` + `backtest`；**不依赖 web/storage**（`backtest::BacktestResult` 为纯逻辑类型，进度经注入端口上报）。
- `backtest/src/engine.rs` 进度回调为同步 `FnMut(usize, usize, i64)`，**纯逻辑无 IO、无随机**（仍可复现单测）。异步 IO（WS + 落库）通过 `mpsc` 桥接到独立 `tokio` 报告任务，`run_one` 在引擎结束后 `await` 报告任务排空，确保进度/落库全部完成且确定可复现。
- `domain::Bar -> backtest::Bar` 映射在 application 层完成（`to_bt_bar`：ts 转 Unix 秒、volume 转 f64）。
- `create_run` 改 `&self`：与 ports 全文件其余端口一致，免去并发共享 store 的 `Arc<Mutex>` 包装。

## 3. Problem solved / feature added

- `submit(req)`：单 run 或参数网格展开 N 个子任务（共享 `group_id`），`BoundedSemaphore(max_concurrent=4)` 限并发，每子任务 spawn 后台执行。
- `run_backtest`（`execute_run`/`run_one`）：bar 读取 → domain→backtest 映射 → `create_strategy` → `Engine::run_with_progress`（进度回调 → mpsc → `BacktestProgressSink.send` + `BacktestRunStore.update_run_progress` 整数 pct 0-100、bar_ts=当前 bar 时间）→ 完成 `mark_done` / 失败 `mark_failed`。
- 查询：`list_runs`/`get_run`/`compare`（委托 store）；`strategies()` 返回 `builtin_strategy_catalog()`（UI 下拉）。
- submit 预校验（周期支持 + 策略 id 已知）防孤儿 failed 行。

## 4. Implementation approach

- **进度桥接**：引擎同步回调 `progress(i,total,ts)` → 计算 `pct=(i+1)*100/total`、`ts=from_timestamp(t,0)` → `mpsc::unbounded_channel` 发送 → 独立报告任务 `progress.send` + `store.update_run_progress`。引擎用 `spawn_blocking` 执行（避免阻塞异步 worker），`run_one` 在 `spawn_blocking` 结束后 `report_task.await` 排空，保证确定性。
- **网格展开**：`expand_grid(base, grid)` 对每个网格键 `"起:止:步长"` 解析（含止，浮点容差），任意多键取笛卡尔积，基础参数保留、网格键覆盖。
- **结果拆分**：`to_run_result` 把 `BacktestResult` 拆为 `RunResult` 三 jsonb 列（net_value=`{series, drawdown}` 保留回撤序列、trades、metrics）。
- **周期口径**：只支持 M1/M5/M15/D1（H1 reject）；域端口用 `domain::Period`，引擎用 `backtest::Period`。

## 5. Test coverage

- `backtest`：新增 engine progress 单测 2 条（每 bar 一次且 total/ts/末次索引正确；pct 单调 25/50/75/100）；既有 45 单测 + golden_sample 2 条保持绿。
- `application`：`fee` 3 条、`params` 6 条（范围解析/笛卡尔积/映射）；`tests/service.rs` 10 条（网格展开 N 子任务共享 group、单 run、坏周期/未知策略拒绝、成功 mark_done+每 bar 进度上报（7 条）单调至100、bar 读失败 mark_failed、未知策略 mark_failed、strategies=7、compare 只取存在 run、list 委托）。
- 全部 mock 端口，手工固定数据、显式参数，无 RNG/无时间依赖/无实时 DB，任意次运行一致。

## 6. Verification

- `cargo test -p backtest`：45 + 2 golden 全绿。
- `cargo test -p application`：20 全绿（10 lib + 10 integration）。
- `cargo build --workspace`：成功。
- `cargo clippy --workspace --all-targets`：无告警（含 application / storage / 全部 targets）。
- `cargo test --workspace --no-run`：所有测试目标可编译（DB 依赖的 storage/web 集成测试不运行）。
- `entangled tangle`：幂等（首跑重生成 `ports.rs`；再跑 `Nothing to be done.`）。
- 未 commit；未 `git add`（`git diff --cached` 为空，`no-staged-files` 满足）。

## 7. Residual risks

- **from/to/initial_capital 不落库**：`backtest_runs` 规划行无 from/to/initial_capital 列（Phase 3a 迁移 0011/端口契约未含，父级未批准扩列）。本实现由 submit 捕获进后台任务闭包完成回测，结果 `net_value_series` 自带 ts 可满足前端重新渲染；但**历史 run 无法仅凭存储重建精确区间/初始资金**（如需可作后续增列评审）。
- **每 bar 一次进度落库**：`update_run_progress` 每 bar 写一次（符合 ADR「真实进度」；WS/DB 每 bar）。对极小周期(1m)长区间可能产生较多 DB 写；如需性能可在 application 层做节流（当前未做，避免偏离「真实进度」契约）。
- **任务句柄未 JoinSet 聚合**：`submit` 用 `tokio::spawn` + semaphore 限并发；未对单组聚合（JoinSet）等待全部子任务。组完成后由 list/get/compare 查询获得；若前端需要「组全部完成再回执」需后续在 service 维护句柄集合（3c/前端阶段可评审）。
- **`mpsc::unbounded_channel` 内存**：引擎产出进度快于报告任务落库时，channel 可能积压（空间大）；当前用于进度上报是可接受量级，若极端场景可改有界/节流。
- **`spawn_blocking` 中引擎 panic**：`run_one` 已 `map_err` 捕获 `JoinError` 转 `mark_failed`；但引擎对合法输入不应 panic（单测锁定）。

## 8. Staged files

**本任务无 staged 文件**（`git diff --cached` 为空）。工作区变更见 `git status`：
- 新增：`crates/application/*`
- 修改：`Cargo.lock`、`crates/backtest/src/engine.rs`、`crates/backtest/src/lib.rs`、`crates/domain/src/ports.rs`、`crates/storage/src/backtest.rs`、`crates/storage/tests/backtest.rs`、`design/02-domain/contracts.md`
