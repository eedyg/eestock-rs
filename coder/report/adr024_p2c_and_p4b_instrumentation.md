# ADR-024 P2c（生产构造点无前视自检）+ P4b（仪表阶段）—— coder 交付报告

- **本报告自身路径**：`coder/report/adr024_p2c_and_p4b_instrumentation.md`
- 角色：coder（TDD；**未 `git commit`，仅 `git add`**；未新建数据库）
- 冻结基线：HEAD `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f` + index 中的 P0/P2/P2b（staged）；
  本批改动 = 该基线上的工作区增量（`git diff` 对照 index）
- 证据目录：`coder/evidence/adr024_p2c_p4b/`（30 个原始输出 + `probe_p4b.sh`）
- 依据：`tester/report/adr024_p2b_and_m30_golden_verification.md` §0.2 **R1**；
  `design/16-backtest-scalability/01-adr.md` **D15**；`04-implementation-plan.md` §2 **P2c / P4b**

---

## 0. 判词（结论在最前）

| 任务 | 判词 | 关键证据 |
|---|---|---|
| **A. P2c —— 三个生产构造点的无前视自检** | **完成（红→绿齐备）** | 3 处 `debug_assert_eq!`（引擎会话 / 试算 / sim-live）；**3 组反向对照**逐个 panic（`left: 8 right: 1` / `left: 2 right: 1` ×2）并逐字节复原（sha256 相同）；`BarCtx::with_history` **未改**（P2 两个反向资产仍绿） |
| **B. P4b —— 仪表阶段（只加观测，不改行为）** | **完成（改动前基线数字已交付）** | 每 run 计数器 + 分段 span + 父 span + `trace_id` 贯穿；**7 条真路径 run** 基线表；`produced == writes == min(1001, bars)` 三重自洽；PG `Δn_tup_upd = 6,512` 与理论**精确闭合** |
| 非目标 | **全部未触碰** | 进度节流粒度 / 合并·降频写入 / `mark_succeeded` 前排水顺序 / 落库 schema / 结果 API / 区间护栏 / `design/16-*` / `docker-compose.yml` / sim-live 业务逻辑 —— 均无 diff（见 §C3、§B6） |

---

# A. 任务一：P2c 生产构造点无前视自检

## A1 改动（3 处，全部 `debug_assert` —— release 零成本）

| # | 构造点 | 文件:行 | 断言 |
|---|---|---|---|
| 1 | 引擎会话路径（`EnsembleSession::step` 步骤 3，`with_slice` 闭包内） | `crates/strategy-core/src/engine.rs:657-662` | `debug_assert_eq!(ctx_bars.len(), i + 1, "P2c 前视自检（引擎会话）…")` |
| 2 | 试算路径（`tryrun_bar_ctx`） | `crates/application/src/strategy.rs:864-869` | `debug_assert_eq!(ctx_bars.len(), index + 1, "P2c 前视自检（试算）…")` |
| 3 | sim-live（`PluginStrategyOrchestrator::evaluate` 的 `with_slice` 闭包内） | `crates/simlive/src/plugin_orchestrator.rs:278-283` | `debug_assert_eq!(ctx_bars.len(), idx + 1, "P2c 前视自检（sim-live）…")` |

三处形态统一（关键设计点）：

```rust
let ctx_bars: &[Bar] = bars;               //  送入 BarCtx 的那一个切片
debug_assert_eq!(ctx_bars.len(), index + 1, "P2c 前视自检（…）：ctx.bars 必须恰为 bars[0..=index]");
let ctx = BarCtx::new(index, bar.clone(), ctx_bars, position).with_history(shared.clone());
```

**为什么绑在 `ctx_bars` 这个局部变量上（而不是直接断言闭包参数 `bars`）**：断言必须绑在**实际流入
`BarCtx::new` 的表达式**上才具备可证伪性。若绑在 `bars`（闭包/入参）上，将来有人把入参换成「含未来的加长
切片」而 `bars` 仍是前缀时，断言**不会响**（可被绕过）。绑定到 `ctx_bars` 后，任何「把前缀切片退回全量 /
加长切片」的改动都在构造点立即 panic。

**未触碰**：`BarCtx::with_history` 本体（tester R1 明确禁止 —— 会破坏 P2 的两个反向测试资产）。
`crates/strategy-runtime/src/types.rs` 在本批**无 diff**。

## A2 红 → 绿（反向对照 ×3；每处独立、逐个复原）

方法：每次只做**一处**退化（前缀切片 → 含未来切片）→ 跑该 crate 测试 → 必须 panic → 复原 → 复绿；
三处复原后源码 sha256 与退化前**逐字节相同**。

| ID | 退化（临时改生产源码） | 触发测试 | 原始输出（贴） | 复原 |
|---|---|---|---|---|
| **R1** | `strategy.rs`：`let ctx_bars = &bars[..=index]` → `= bars` | `cargo test -p application --lib p2b_tests` | `panicked at crates/application/src/strategy.rs:865:5: assertion left == right failed: P2c 前视自检（试算）… left: 8 right: 1` | 复绿 + sha256 `a0a279c4…a468` 相同 |
| **R2** | `engine.rs`：`let ctx_bars = bars` → `ahead = bars.to_vec()+[当前 bar]`，`ctx_bars = &ahead` | `cargo test -p strategy-core --test session` | `panicked at crates/strategy-core/src/engine.rs:660:13: …（引擎会话）… left: 2 right: 1`（7/7 用例全红） | 复绿 + sha256 `9b334eb3…8d26` 相同 |
| **R3** | `plugin_orchestrator.rs`：同上（`ahead = bars+[latest_bar]`） | `cargo test -p simlive` | `panicked at crates/simlive/src/plugin_orchestrator.rs:281:17: …（sim-live）… left: 2 right: 1`（10/30 红） | 复绿 + sha256 `d5ae4947…e9b7` 相同 |

原始输出：`coder/evidence/adr024_p2c_p4b/05_*`（R1 panic）、`07_*`（R2 panic）、`09_*`（R3 panic）、
`06_/08_/10_*`（复原绿）、`04_hashes_before_reverse.txt`（退化前 sha256）。

**TDD 说明（如实）**：本项是**不变量守卫**，其正确性表现为「不成立时必须响」。因此「红」相位由**反向
退化对照**承担（我已对三处各做一次），而不是新增一条会在实现前失败的正面测试 —— 前缀性质在 P2/P2b 后
**已经成立**，任何「实现前必红」的正面断言都会是伪造的红。正面证据由既有资产覆盖：`strategy.rs::p2b_tests::
tryrun_bar_ctx_narrows_to_prefix_and_shares_history`（试算点）、`strategy-runtime/tests/shared_history.rs`
（引擎口径）、`crates/simlive/tests/tester_p2b_orchestrator_indep.rs::indep_orchestrator_ctx_prefix_and_position_fields`
（sim-live 点，tester 独立探针 `bars_len==index+1 / ahead_visible=false` 全行成立）。

---

# B. 任务二：P4b 仪表阶段（只加观测，不改行为）

## B0 观测面机制裁定（**请架构师复核这一条**）

派单要求：「沿用既有观测约定，不引新依赖；**若既有面无可用的 span 机制，停下 intercom 问我**，不要自选框架」。

我的判定与依据（**未停手，已实施**）：

1. 本仓的观测面 = `tracing`（`crates/{app,web,mcp,application,…}` 均已依赖 `tracing.workspace = true`）；
   `eestock-app` 的订阅者 = `tracing_subscriber::fmt().json()`（`crates/app/src/bin/eestock-app.rs:27`，
   **tangle 生成，本批未改**）。
2. `tracing` **内置 span API**（`info_span!` / `.instrument()`），属于**同一依赖内**的能力，**不引新依赖、
   不引框架**；span 在既有 JSON 输出中直接可见（`"span"` / `"spans"` 字段，原始输出见
   `22_p4b_app_json_log.txt` / `25_p4b_trace_drain_raw.txt`）。
3. 既有约定中**有** `trace_id` 概念（`domain::types::new_trace_id()`，collector/tushare 已在用），本批沿用同一
   生成器与字段名，并存到父 span 与每条事件上。
4. 本仓此前**无任何 span 使用**（本批开工前 `grep -rn "tracing::span\|instrument\|Span::" --include=*.rs crates/` **零命中**），
   因此「引入 span」在语义上是**新增观测形态**（尽管不新增依赖、不引框架）。

⇒ 我认为触发条件（「既有面无可用的 span 机制」）**不成立**，故按最小方案实施：既有 `tracing` + 既有
`trace_id` 字段，**零新依赖**。若架构师认为此判定有误（即要求先问再动），B2 的 span 部分应回滚为
「扁平事件 + `trace_id` 字段」（计数器与基线数字不受影响）——**请裁**（列 §B8 未决项 ①）。

## B1 改动清单（1 个文件：`crates/application/src/workbench.rs`）

| 层 | 改动 | 位置 |
|---|---|---|
| application | per-run 计数结构 + 进程级累计 + µs/ms 小工具（纯观测） | `workbench.rs:804-881`（`P4bRunCounters` `:822` / `P4bGlobalCounters` `:838` / `P4B_GLOBAL` `:862` / `p4b_add_us` `:865` / `p4b_ms` `:872` / `p4b_share_pct` `:877`） |
| application | `submit()`：生成 `trace_id`、建父 span `workbench_run`、取数段子 span、`p4b.submit` 事件、spawn 任务 `.instrument(run_span)`、permit 排队计时 | `workbench.rs:303-312, 322-349, 368-370, 417-427, 437-452` |
| application | `execute_run()`：新增参数 `trace_id` / `p4b`；各段子 span + 计时；帧产生计数；进度落库计数与计时；per-run 汇总事件 | `workbench.rs:893-1172`（汇总事件 `:1141`） |
| application（测试） | P4b 自洽性测试 + 捕获型 Subscriber（仅用 `tracing`，无新依赖） | `crates/application/tests/workbench.rs:993-1294`（本批新增段；测试函数 `p4b_run_summary_counters_are_self_consistent` 在 `:1147`，捕获层 `:1049-1145`） |

**行为零变更**清单（逐条核对）：
- 进度节流判定式、`PROGRESS_THROTTLE_MILLI`、`unbounded_channel`、WS `sink.send` 与 `store.update_progress`
  的**调用顺序与次数**完全不变（只在同一位置加计数/计时）；
- `report_task.await`（排水）**仍在 `mark_succeeded` 之前**（派单硬约束）——顺序未动，仅加了计时；
- 无 schema/API/端口/接口变更（观测只落日志；`execute_run` 是私有函数，新增两个私有参数）；
- 无 `git commit`。

## B2 观测字段清单（名称 / 口径 / 落点）

### B2.1 计数器（per run + 进程级累计）

| 字段 | 口径（定义、单位） | 落点（测量点） |
|---|---|---|
| `progress_frames_produced` | 引擎 observer 内**入队帧数**（与 `tx.send` **同一判定分支**） | `workbench.rs:1017`（spawn_blocking 闭包） |
| `progress_db_writes` | `store.update_progress` **实际调用次数**（= 收帧侧写出次数） | `workbench.rs:966-968`（report 任务） |
| `progress_db_write_ms` | 上述调用**累计耗时**（含 await 往返 + PG fsync） | `workbench.rs:966-967`（`Instant` 前后包夹） |
| `progress_ws_send_ms` | `sink.send`（WS 推送）累计耗时（同段对照） | `workbench.rs:962-964` |
| `progress_frame_avg_ms` | `progress_db_write_ms / progress_db_writes`（**帧均延迟**） | `workbench.rs:1132`（汇总事件推导值） |
| `global_runs_total` / `global_frames_total` / `global_db_writes_total` / `global_db_write_ms_total` / `global_permit_hold_ms_total` | **进程级**累计（`P4B_GLOBAL`，`Relaxed` 原子；随每条汇总事件一并输出） | `workbench.rs:862, 1133-1140` |

> **D15 命名映射（诚实说明）**：D15 ① 原文列举 `progress_frames_{produced,sent}`。本批**不单列 `sent`**：
> 通道为 `tokio::sync::mpsc::unbounded_channel`（无容量上限、无 `try_send`、无 drop 分支），
> 且 P1c 实测 `Δn_tup_upd` 与 `min(1001,bars)+2` **精确闭合** ⇒ `sent ≡ produced`；
> 「收帧并落库」的同义量就是 `progress_db_writes`。本批实测再次闭合（§B6）。若要求逐字对齐 D15 字段名，
> 可另立小批加收帧侧计数（列 §B8 未决项 ②）。

### B2.2 分段耗时（permit 持有分解 + 取数）

| 字段 | 口径 | permit 内？ | 落点 |
|---|---|---|---|
| `fetch_ms` | submit 阶段一次 `BacktestBarRead::bars()` 墙钟（**含**行数校验前） | ❌（submit 在 permit 外） | `workbench.rs:322-349` |
| `permit_wait_ms` | submit → `Semaphore::acquire()` 返回的**排队等待** | ❌ | `workbench.rs:442-446` |
| `permit_hold_ms` | `execute_run` 墙钟（permit 获取成功后立即进入；返回后 permit 随即 drop） | ✅（总持有） | `workbench.rs:894, 1116-1120` |
| `mark_started_ms` | `mark_started`（queued→running 认领） | ✅ | `workbench.rs:909-919` |
| `engine_ms` | `spawn_blocking(run_ensemble_with_quickjs_observed)` 的 await 墙钟 | ✅ | `workbench.rs:1001-1031` |
| `progress_drain_total_ms` | report 任务**自存活周期**（spawn → 排空）；与 `engine_ms` **并行** | ✅（重叠） | `workbench.rs:955-956, 1035` |
| `progress_drain_tail_ms` | 引擎结束 → report 任务排空的**不重叠等待** | ✅（不重叠） | `workbench.rs:1040-1050` |
| `result_serialize_ms` | `to_run_result`（五 jsonb 序列化） | ✅ | `workbench.rs:1066-1077` |
| `result_write_ms` | `mark_succeeded`（结果落库事务） | ✅ | `workbench.rs:1079-1092` |
| `engine_share_pct` / `progress_db_share_pct` / `progress_tail_share_pct` / `result_write_share_pct` / `result_serialize_share_pct` / `mark_started_share_pct` | 各段 **/ `permit_hold_ms`** 占比（%） | — | 汇总事件推导值 |

**判读约束（已在源码注释与报告双写）**：`progress_db_*` 段与 `engine_ms` **可重叠**（observer 只入队、
不等待）；只有 `progress_drain_tail_ms` 是**不重叠**的等待。**不得把各段直接相加当作 permit 持有**；
permit 持有是各段的上界。

### B2.3 span / trace（每 run 一段父 span，各段为子 span）

| span 名 | 字段 | 落点 |
|---|---|---|
| `workbench_run`（**父**，每 run 一段） | `trace_id`（submit 时生成）、`symbol`、`period`、`run_id`（`Empty`→`record`）、`bars_total`（`Empty`→`record`） | `workbench.rs:304-312, 369-370, 417` |
| `p4b.segment{segment="fetch"}` | `trace_id` | `workbench.rs:322-327`（显式 `parent: &run_span`，因创建早于 `run_id`） |
| `p4b.segment{segment="mark_started"｜"engine"｜"progress_drain"｜"progress_drain_tail"｜"result_serialize"｜"result_write"}` | `run_id` | `workbench.rs:909/955/1001/1040/1066/1079` |

**事件（JSON 日志，`target=application::workbench`）**：`p4b.submit`（submit 侧，run_id/trace_id/bars_total/
`submit_fetch_ms`）、`p4b.segment`（每段一条，带该段 `elapsed_us`；`progress_drain` 那条**带实际落库次数与
落库耗时**）、`p4b.run_summary`（每 run 一条汇总，含全部字段与进程级累计）。

**trace 链路（真路径原始输出，run `sr_1789711873646_000001`，`trace_id=8d8a2163f8acdbbb56949aebb6909688`）**：

```
06:11:13.646  spans=[workbench_run.fetch]              p4b.segment  elapsed_us=49076
06:11:13.647  spans=[]                                 p4b.submit   bars_total=3500 submit_fetch_ms=49.076
06:11:13.649  spans=[workbench_run.mark_started]       p4b.segment  elapsed_us=1162
06:11:13.696  spans=[workbench_run.engine]             p4b.segment  elapsed_us=46657 bars_total=3500
06:11:14.505  spans=[workbench_run.progress_drain]     p4b.segment  progress_db_writes=1001 progress_db_write_ms=852.828 progress_ws_send_ms=0.385
06:11:14.505  spans=[workbench_run.progress_drain_tail]p4b.segment  elapsed_us=809176
06:11:14.523  spans=[workbench_run.result_serialize]   p4b.segment  elapsed_us=18240
06:11:14.560  spans=[workbench_run.result_write]       p4b.segment  elapsed_us=36928
06:11:14.565  spans=[workbench_run]                    p4b.run_summary outcome=succeeded bars_total=3500 …
```

⇒ **同一条 `trace_id` 贯穿 workbench 提交 → 引擎 → 进度落库 → 结果落库**；且 span 上下文在既有 JSON
subscriber 的 `"spans"` 数组里可见（文件 `25_p4b_trace_drain_raw.txt` 另存原始 JSON 行）。

## B3 TDD（红 → 绿）

新增测试：`crates/application/tests/workbench.rs::p4b_run_summary_counters_are_self_consistent`
（+ 捕获型 `Subscriber`，**只用 `tracing` 既有依赖**，不引 `tracing-subscriber`）。

断言 4 组：① `p4b.submit` 事件与父 span `workbench_run` 的 `trace_id` 一致、父 span 的 `run_id`/`bars_total`
由 `span.record` 补全；② `produced == writes == min(1001, bars) == 300`；③ 全部分段字段可解析且
`permit_hold_ms ≥ engine_ms`；④ 各段子 span 的**父 span 就是本 run 的 `workbench_run`**（含 submit 侧 `fetch`），
且汇总事件落在父 span 上下文内。

```
# RED（实现前）—— coder/evidence/adr024_p2c_p4b/11_red_p4b_test.txt
test p4b_run_summary_counters_are_self_consistent ... FAILED
thread 'p4b_run_summary_counters_are_self_consistent' panicked at crates/application/tests/workbench.rs:1159:10:
缺提交侧事件 p4b.submit（P4b 未落地）

# GREEN（实现后）—— 12_green_p4b_test.txt
test p4b_run_summary_counters_are_self_consistent ... ok
```

**并发下的测试工程坑（已修，记入证据 15/16/17）**：`tracing::subscriber::set_default` 是**线程本地**的，
但 tracing 的 callsite interest 缓存是**进程级**的 —— 同二进制内其他测试线程先用到同一 callsite 会把
「无订阅者 ⇒ never」写进缓存，导致本线程 `set_default` **一个事件都收不到**（`--test-threads=1` 绿、
并行红）。修法：测试内**一次性 `set_global_default`**（`OnceLock`）+ `rebuild_interest_cache()`，并按
`run_id`/`trace_id` 过滤（各测试 run 互不干扰）；span 名栈改为 `thread_local!`（共享栈会串父 span）。
稳定性：workbench 测试并行连跑 3 次全绿（`18_p4b_stability.txt`）。

## B4 **改动前基线数字表（核心交付）** —— 真路径 7 条 run

**口径声明**：
① 「改动前」= **仪表已落地、优化未做**（D15 ② 的原意：优化前基准）；
② 环境：本机 `./target/debug/eestock-app --config /tmp/app_p4b_18081.toml`（**P4b 仪表二进制**，
占位端口 18081/18082）→ 活库 `eestock@127.0.0.1:5433`（与现网 8081 同库同表）；
③ 插件 = 已发布版 `sv_1789013713975_000001`（`dual_ma`，params `fast=5, slow=20`），与 P1c 同款；
④ 原始输出：`21_p4b_realpath_probe.txt`（提交/终态/DB 行）+ `23_p4b_summary_table.txt`（从 JSON 日志解析）。

### B4.1 单 run（串行；permit 有效并发度 = 1）

| run | bars | **帧数** produced | **落库次数** writes | **落库总耗时** ms | **帧均延迟** ms | permit 持有 ms | 引擎 ms | 排水 tail ms | 序列化 ms | 结果写 ms | 取数（permit 外）ms | 端到端 dur_s（DB 口径） |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D1 492 | 492 | **492** | **492** | **447.54** | **0.910** | 461.39 | 6.55 | 442.78 | 2.37 | 7.15 | 36.25 | 0.454 |
| M5 3500 | 3500 | **1001** | **1001** | **852.83** | **0.852** | 916.82 | 46.66 | 809.18 | 18.24 | 36.93 | 49.08 | 0.876 |
| M1 16155 | 16155 | **1001** | **1001** | **835.71** | **0.835** | 1109.38 | 204.57 | 634.24 | 85.21 | 163.66 | 809.68 | 0.926 |

### B4.2 permit 持有各段占比（同一三档）

| run | 引擎 | 进度落库（累计，与引擎段重叠） | 排水 tail（不重叠） | 结果落库 | 结果序列化 | mark_started |
|---|---|---|---|---|---|---|
| D1 492 | **1.42%** | **97.00%** | **95.97%** | 1.55% | 0.51% | 0.37% |
| M5 3500 | **5.09%** | **93.02%** | **88.26%** | 4.03% | 1.99% | 0.13% |
| M1 16155 | **18.44%** | **75.33%** | **57.17%** | 14.75% | 7.68% | 0.11% |

### B4.3 并发 4（`MAX_CONCURRENT` 缺省 4）+ **单位时间 run 吞吐**

| 项 | 实测 |
|---|---|
| 4 × M5 3500 并发提交 → 全部终态 | **wall_total = 1.998 s** ⇒ **吞吐 = 2.0022 run/s** |
| 单 run 吞吐（1/端到端 dur） | D1 492：**2.20 run/s**；M5 3500：**1.14 run/s**；M1 16155：**1.08 run/s** |
| 并发下 per-run | 落库 1671.0–1714.5 ms；**帧均延迟 1.669–1.713 ms**（单 run 0.835–0.910 ms ⇒ **≈2.0× 放大**）；permit 持有 1737.4–1799.8 ms；引擎 43.7–45.8 ms；排水 tail 1629.5–1673.2 ms；dur_s 1.696–1.737 |

⇒ 与 D15「进度写库占用 permit、压低吞吐」的**方向**一致，但**量级需修正**：并发 4 时吞吐仍 **2.0 run/s**，
permit 持有被 I/O 争用放大 ~2×（每帧 0.85 → 1.7 ms），**不是**「被卡在 ~1.5 run/s 的上限」的硬顶。
（本机当前 I/O 比 P1c 那轮更快：每帧 0.84–0.91 ms vs P1c 的 2.45–3.45 ms；同规模 dur 0.88 s vs 2.59 s。）

## B5 自洽性与交叉验证（原始输出）

1. **同一次 run 内 `produced == writes == min(1001, bars)`**：7/7 run 全部成立（`23_p4b_summary_table.txt` 的
   自洽性检查段；如 `bars=3500 expected_frames=1001 produced=1001 writes=1001 -> OK`）。
2. **进程级累计自洽**：最后一条汇总 `global_runs_total=7, global_frames_total=6498, global_db_writes_total=6498`
   （`Σ frames = 492 + 1001×6 = 6498` ✅）`global_db_write_ms_total=8929.60`、`global_permit_hold_ms_total=9564.86`。
3. **与 PG 表级计数闭合**：受控 7 条 run 前后 `pg_stat_user_tables.strategy_run.n_tup_upd`
   `364,723 → 371,235` ⇒ **Δ = 6,512**；理论 `Σ(min(1001,bars) + 2 状态迁移)` `= 494 + 1003 + 1003 + 4×1003 = 6,512`
   ⇒ **精确闭合**（`n_tup_ins` +7 = 7 条 run；`n_tup_del` +7 = 清理 7 条）。
4. **沉降协议提醒（P1c 教训复现）**：短采样会在 run 结束后**继续涨**（`369,729` → 10 s 后 `371,235`）
   ⇒ 本批采用「每 5 s 采样至连续 3 次相同」后才取终值（`21_*` §[3]）。
5. **单元级自洽（mock 路径）**：`cargo test -p application --test workbench p4b_ -- --nocapture` 的原始输出
   显示 `progress_frames_produced=300 == progress_db_writes=300`、`trace_id` 全链一致、分段 span 齐全
   （`13_p4b_capture_raw.txt`）。

## B6 副作用与清理（诚实报告）

| 项 | 结果 |
|---|---|
| 受控 run 行数据 | 7 条（`name LIKE 'ADR024-P4b-base-%'`）**已删净**：`DELETE 7`、残留 0、结果表残留 0、全表恢复 `374 \| 374`（`24_p4b_cleanup.txt`） |
| **不可回滚**：`pg_stat_user_tables.strategy_run` 累计 | `n_tup_upd 364,723 → 371,235`（**+6,512**）、`n_tup_ins 2,358 → 2,365`（+7）、`n_tup_del 1,985 → 1,992`（+7）。**后续引用该累计值须扣除 +6,512 / +7 / +7**（P1c 已有同类先例 +6,655） |
| 告警引擎 | 18081 实例启动时会**立即执行一次**告警评估（app bin 的 `AlertEvaluator` 无开关，config 已把间隔设为 3600 s）。观测窗口内 `alert_events` 变化：`446→447` 条、`fire_count 604→605`、`last_fired 06:11:42` —— 该时刻与本实例的 tick 不符（本实例 06:09:30 启动、下一 tick 07:09:30），**归因 prod 8081 的 60 s 节拍**；本实例 startup tick 的**精确影响未隔离**（未发现额外写入，如实报告） |
| 实例与端口 | 18081/18082 仪表实例**已停止**（`26_p4b_instance_stopped.txt`：无残留进程、18081 http=000）；**prod 8081 未受影响**（http=200，全程未重启/未替换其二进制） |
| 数据库 | 未新建数据库、未改 schema、未加列（观测只落日志） |

## B7 验证汇总（命令 + 结果）

| 命令 | 结果 | 证据 |
|---|---|---|
| `cargo test -p strategy-core` | 33+25+6+7+1+3 passed / 0 failed（1 ignored 既有） | `01_*`, `29_*` |
| `cargo test -p simlive` | 40 + 3 + 3 passed / 0 failed | `02_*`, `29_*` |
| `cargo test -p application` | 27+2+6+55+39+3+**18** passed / 0 failed | `19_*`, `29_*` |
| `cargo test -p strategy-runtime` | 全绿（P2 两个反向资产未受影响） | `29_*` |
| `cargo check --workspace --all-targets` | 无 error / 无 unused warning | `27_*` |
| `cargo check --release -p application -p strategy-core -p simlive` | 通过（P2c 断言 release 编译掉） | `30_*` |
| `cargo clippy -p application -p strategy-core -p simlive --all-targets` | 仅 1 条**既有** warning（`FeeModel` clone，非本批） | `20_*` |
| `bash scripts/check-tangle.sh` | ✅ design 与生成物一致（tangle 门禁未破） | `28_*` |
| 真路径基线 | 7 条 run（表见 §B4），PG 闭合 Δ=6,512 | `21_*`, `22_*`, `23_*`, `24_*`, `25_*` |

## B8 未决项（请架构师/用户裁定）

1. **span 机制是否需先问**（§B0）：本批按「`tracing` 内置 span = 既有面」实施，零新依赖、零换框架。
   若判定应「先问再动」，回滚范围 = 各 `info_span!`/`.instrument()`（计数器与基线数字不受影响）。
2. **D15 字段名逐字对齐**：`progress_frames_sent` 本批以「≡ `produced`」论证省略；如需独立收帧侧计数，
   另立小批（3 行改动）。
3. **`fetch` 段语义**：取数在 **submit 阶段（permit 之外）**，本批按实报告为 `fetch_ms` 并标注；
   若期望「permit 持有分解」含取数，需要**行为改动**（把取数移入任务内）—— 属修复阶段，须用户确认。
4. **时间口径**：本机当前每帧写库 0.84–0.91 ms（快于 P1c 的 2.45–3.45 ms），故「改动前基线」的绝对
   时长与 P1c 不同；**帧数与写库次数恒定（1001/1003）**与机器无关，可作为前后对比的稳定锚点。
5. **pg_stat 累计污染**：+6,512 upd / +7 ins / +7 del（§B6）—— 后续任何引用须扣除。
6. **工具故障（如实）**：GitNexus MCP/CLI 本次不可用（`LadybugDB unavailable … Database file version: 43,
   Current build storage version: 40`），故 **AGENTS.md 要求的图分析（impact/detect_changes）无法执行**；
   影响面以文本搜索替代（§C2），未按图分析口径声明风险等级。

---

# C. 架构对齐 / 影响面

## C1 层归属

| 改动 | 层 | 为什么属于该层 |
|---|---|---|
| 3 处 P2c `debug_assert` | engine 会话路径 = `strategy-core`（Domain 纯逻辑）；试算构造点 = `application`；sim-live = `simlive`（纯逻辑） | 断言必须落在**该路径自己的构造点**（就近守卫），不上升为跨层契约；不改 `strategy-runtime`（runtime = ABI/运行时，`with_history` 本体按 R1 禁改） |
| P4b 计数器 / 分段计时 / span / trace_id | `application`（`workbench.rs`） | 进度帧产生、permit 持有、落库调用、结果序列化都在 application 的 run 任务内；`domain` 端口与 `storage` 实现**未动**（观测只落既有 tracing 面，不进 DB schema/端口） |
| P4b 测试（捕获型 Subscriber） | `application` 集成测试 | 只使用 `application` 既有依赖（`tracing`），无新依赖、无新 crate |

## C2 影响面（blast radius；文本搜索替代 —— GitNexus 不可用，见 §B8-6）

| 被改符号 | 生产调用点（搜索所得） | 风险 | 说明 |
|---|---|---|---|
| `EnsembleSession::step`（内联在 `push`/`push_batch`） | `run_ensemble*` 薄封装 → application workbench 任务、sim-live 回测对比、MCP `bt_*` | **LOW** | 加的是 debug-only 断言；release 零成本；测试（strategy-core 75 项）全绿 |
| `tryrun_bar_ctx` | **1** 处生产调用（`run_pure_score`）+ 3 处本文件单测 | **LOW** | 同上前提；试算全量测试绿（application 39 项 + tester 独立 3 项） |
| `simlive::PluginStrategyOrchestrator::evaluate` | **1** 处生产调用（`feed_bar`）→ `process_bar`（sim-live feed / REST / MCP） | **LOW** | 断言在 `with_slice` 闭包内；simlive 46 项测试绿 |
| `WorkbenchService::submit` | `web/src/workbench.rs:205`（REST）、MCP `bt_*`（同服务实例） | **LOW** | 仅加观测（span/事件/计时）；返回值与落库语义未变；17 项 workbench 测试绿 |
| `execute_run`（私有） | **1** 处（`submit` 的 spawn） | **LOW** | 私有函数新增两个私有参数；无外部调用面 |

> AGENTS.md 要求「HIGH/CRITICAL 风险须告警」：本次**无** HIGH/CRITICAL（无接口/契约/层边界变更）。

## C3 未触碰（红线逐条自查）

`design/16-backtest-scalability/**`、`docker-compose.yml`、落库 schema/migrations、结果 API、
`D1_MAX_SPAN_DAYS`/`MINUTE_MAX_SPAN_DAYS`/`MAX_BARS` 护栏、进度节流粒度、写入合并/降频、
`mark_succeeded` 前排水顺序、sim-live 业务逻辑 —— **均无 diff**（`git diff --name-only` 仅 5 个源文件 +
1 个测试文件属于本批；工作区中 `design/**`、`docker-compose.yml` 的改动为**他人既有未暂存改动**，
本批未触碰、未 `git add`）。未 `git commit`。

---

# D. 交付物 / 暂存清单

**已 `git add`（未 commit）**：

```
crates/strategy-core/src/engine.rs               （P2c 引擎会话断言）          9 +/1 -
crates/application/src/strategy.rs               （P2c 试算断言）             10 +/1 -
crates/application/src/workbench.rs              （P4b 仪表）                335 +/15 -
crates/application/tests/workbench.rs            （P4b TDD 测试 + 捕获 Subscriber） 304 +/0 -
crates/simlive/src/plugin_orchestrator.rs        （P2c sim-live 断言）         9 +/1 -
coder/evidence/adr024_p2c_p4b/**                 （30 个原始输出 + probe 脚本）
coder/report/adr024_p2c_and_p4b_instrumentation.md（本报告）
```

**证据索引（`coder/evidence/adr024_p2c_p4b/`）**：

| 文件 | 内容 |
|---|---|
| `01–03` | P2c 改动后三 crate 全绿 |
| `04` | 反向对照前源码 sha256（复原基准） |
| `05/07/09` | R1/R2/R3 panic 原始输出（红） |
| `06/08/10` | 复原后复绿 |
| `11/12` | P4b 测试红 → 绿 |
| `13` | P4b 捕获原始输出（事件/span/字段） |
| `14/19/29` | application / 四 crate 全量测试 |
| `15/16/17/18` | 并发测试踩坑与稳定性（3 连绿） |
| `20/27/28/30` | clippy / workspace check / tangle / release check |
| `21` | **真路径基线探针原始输出**（提交/终态/DB 行/沉降） |
| `22` | 仪表 app 的 JSON 日志全量拷贝 |
| `23` | 从日志解析的 **基线数字表 + 自洽性检查 + 占比** |
| `24` | 受控 run 清理 + pg_stat 污染如实记录 |
| `25` | trace 链原始 JSON（spans 数组证明 trace_id 贯穿至落库段） |
| `26` | 仪表实例停止 + prod 8081 未受影响 |
| `probe_p4b.sh` | 可复现探针脚本 |
