# ADR-024 P2c（无前视自检）+ P4b（仪表阶段）—— **tester 独立验收报告**

- **本报告自身路径**：`tester/report/adr024_p2c_p4b_verification.md`
- 角色：tester（**只验不改**：未改任何生产源码，未 `git add`/`commit`，未新建数据库）
- 被执行对象：`coder/report/adr024_p2c_and_p4b_instrumentation.md`（证据 `coder/evidence/adr024_p2c_p4b/`）
- 证据目录：`tester/evidence/250_adr024_p2c_p4b_verify/`（**31 个原始输出 + 2 个自写探针脚本 + index 交付态快照**）
- 冻结目标（**验收对象**）：`HEAD 18d1b9a` + **index 中的本批 5 文件**
  | 文件 | 交付态 sha256（index） |
  |---|---|
  | `crates/application/src/workbench.rs` | `0a5045ad1072dc0a…`（P4b） |
  | `crates/application/tests/workbench.rs` | `d76bf5ff3d729964…`（P4b 测试） |
  | `crates/application/src/strategy.rs` | `a0a279c4ac186395…`（P2c） |
  | `crates/strategy-core/src/engine.rs` | `9b334eb3478001d7…`（P2c） |
  | `crates/simlive/src/plugin_orchestrator.rs` | `d5ae4947225e05e2…`（P2c） |
  逐字节快照见 `17_delivered_index_snapshot.txt` 与 `delivered_index_state/`。

> ⚠ **必须先读的现场风险（影响"冻结"操作）**：验收期间**另一条车道（ADR-024 P4 / D8–D10 分块结果）正在同一 worktree 并发编辑**
> **同一个文件 `crates/application/src/workbench.rs`**（另有 `domain/ports.rs`、`storage/*`、`web/*`、新迁移 `0027`）。
> 14:19–14:23 之间该车道把主干改到**无法编译**（`missing field result_format` / 测试不可编译），
> 且 worktree 的 5 个目标文件中已有 2 个偏离 index。**因此本报告的两处判据分开写**：
> ① 对**交付态（index 快照）**的判定（本报告主体，结论适用于"冻结"）；
> ② 对**当前主干**的可编译性（§5.3，判为**非 P2c/P4b 责任**，但也意味着"主干现在不能合"）。

---

# 0. 判词（结论在最前）

## 0.1 六项逐条

| # | 任务 | 判词 | 关键原始证据 |
|---|---|---|---|
| **①** | **行为零变更**（最重要） | **PASS** | P4b 净 diff 的**全部非新增行只有 15 行**（1 处 `use` + 2 处 `spawn` 结构 + 2 处 `match` 结构改写，**无一条判定式/调用被删**）；`PROGRESS_THROTTLE_MILLI=1000.0` 判定式逐字相同；`unbounded_channel` 1→1；`sink.send`→`store.update_progress` 顺序与次数不变；`report_task.await`(L1043) **先于** `mark_succeeded`(L1083)；**客观等价**：pre-P4b 二进制 vs 仪表二进制在同一 3 组真实输入下，`strategy_run_result` 五 jsonb 列 **md5 全等 + metrics 全等**（`04_equivalence_prep4b_vs_instr.txt`） |
| **②** | **基线数字独立复现** | **PASS（与 worker 表逐格一致）** | 自跑仪表实例 + PG 长窗口协议：帧/落库 **492/492、1001/1001、1001/1001**；帧均延迟 **0.876 / 0.827 / 0.830 ms**（worker 0.910/0.852/0.835）；permit 占比 **1.59/97.21%(D1)、5.49/92.38%(M5)、18.86/74.98%(M1)**（worker 1.42/97.00、5.09/93.02、18.44/75.33）；**Δn_tup_upd 逐段精确闭合 2500 / 4012**（= worker 的 6512，独立复现）；并发 4 吞吐 **2.0168 run/s**（worker 2.0022） |
| **③** | **P2c 断言可证伪** | **PASS** | 三处**精确净 diff**（用 P2b 交付态 blob 反推）= 各只含断言 hunk；**R1/R2/R3 三次反向对照全部 panic**（`left: 8 right: 1` / `left: 2 right: 1` ×2）；复原后 **sha256 与交付态逐字节相同 + 全绿**；`BarCtx::with_history` 本体 0 diff、P2 两个反向资产 `shared_history.rs:199/271` 仍绿（7 passed） |
| **④** | **观测面自洽** | **PASS** | 自跑 7 run：`produced == writes == min(1001,bars)` **7/7 OK**；`trace_id` 每 run 唯一且贯穿、`p4b.segment` **49/49** 的父 span = 本 run 的 `workbench_run`（同 trace_id）；父 span 字段 `Empty→record` 补全；进程级累计 = 各 run 求和（6498/6498/7）；**JSON 日志可取得**（我自跑实例 stdout 落 `/tmp/app_tester_instr_18081.json.log`，副本见 `06_baseline_app_json_log.txt`） |
| **⑤** | **范围与回归** | **PASS（含 1 条环境性保留）** | P4b 触碰面 = **2 个文件**；红线未触碰逐条核（节流粒度/写入次数/排水顺序/落库 schema（`migrations/` 0 diff）/区间护栏常量逐字相同/sim-live 业务逻辑 4 文件 sha256 = HEAD/`design/16-*`、`docker-compose.yml` 非本批）；`cargo test -p application` **EXIT=0（150 passed）**；`--workspace --no-fail-fast` **653 passed / 137 failed / 2 ignored，EXIT=101 —— 137 个失败**全部（100%）**是 ADR-023 E6b 哨兵门禁（无测试库，tester 不得新建库，ADR-025 D3），非本批缺陷** |
| **⑥** | **并发稳定性** | **PASS** | workbench 测试二进制**并行复跑 5/5 全绿**；全 `-p application` 套件 `--test-threads=16` **3/3 全绿**；未复现 flaky |

**未过项：无**（0 项 FAIL）。**非阻塞残留 5 条**见 §0.3。

## 0.2 「P2c / P4b 仪表可否冻结？」——明确结论

> ### **可以冻结。**
>
> **P2c：可以冻结。** 三处 `debug_assert` 均为**纯断言**（净 diff 仅断言 hunk，见 §3.1），
> 三处反向对照均**可被弄红**且**逐字节复原**（§3.2），`BarCtx::with_history` 本体与 P2 反向资产**未受影响**（§3.3）。
> release 侧由 `debug_assert` 语义保证零成本（worker `30_release_check.txt` 通过；本报告 §3.4 如实标注未独立复跑 release）。
>
> **P4b 仪表：可以冻结。** ① 行为零变更（15 行非新增行全量枚举 + 三组真实输入结果逐字节等价，§1）；
> ② 基线数字独立复现且与 worker 表逐格一致（§2）；④ 观测面自洽（§4）；⑤ 范围未越界 + 应用层测试 EXIT=0（§5）；
> ⑥ 稳定（§6）。P4b 交付的**是"改动前基线"，不是优化**，因此"能否冻结"只取决于"是否只加观测"——证据成立。
>
> **冻结操作建议（重要）**：本批与并发车道**共触 `workbench.rs`**，且当前 worktree 的该文件**已偏离交付态**（§5.3）。
> 请**先冻结 index 快照**（`git commit` 或用 `delivered_index_state/*` 备份），
> 再让 P4 车道在其之上继续；否则 P4b 的 335 行观测代码有被覆盖/合并丢失的风险
> （当前快照核对：并发版本的 worktree 文件**仍然保留全部 P4b 结构**，见 §5.3）。

## 0.3 未过项 / 残留（**均非阻塞**）

| ID | 类别 | 内容 | 阻塞冻结？ | 建议 |
|---|---|---|---|---|
| **R1** | 环境/协作 | **主干（worktree）当前不可编译**：并发车道（P4 分块结果）在 14:19–14:23 的中间态（`domain::ports::StrategyRunResult.result_format` / `ResultChunk` 已加、`application` 未跟上）。**与 P2c/P4b 无关**——本批 5 文件的 diff 不含这些符号（§5.3） | **否**（交付态 index 快照编译/测试全绿） | 冻结 P2c/P4b 后由 P4 车道自行收敛；本报告 ⑤/⑥/③-R1 的判据在 **index 快照的隔离树**取得 |
| **R2** | 待架构师裁定（worker §B0 自陈） | P4b 用了 `tracing` 内置 **span**（`info_span!`/`.instrument()`）——同一依赖、零新依赖、既有 JSON subscriber 可输出，但属"本仓此前无 span 使用"的新形态 | **否** | 若判定"须先问再动"，回滚面 = span 相关行（计数器/基线数字不受影响，见 §4.5） |
| **R3** | 口径（D15 字段名） | D15 ① 列 `progress_frames_{produced,sent}`，本批只落 `produced`（论证 `sent ≡ produced`） | **否** | **我的独立证据支持该论证**：两段 PG 闭合 **2500** 与 **4012** 与其理论值**逐段精确相等**（无丢帧 ⇒ "已发"无处可丢）；如需字段逐字对齐另立小批 |
| **R4** | 观测清晰度 | `p4b.submit` 事件**不在**父 span 上下文（`spans=[]`）——因 `run_span` 未 `enter`；同一条 `trace_id` 仍在字段里 | 否 | 可（非必须）在 submit 事件上加 `run_span.in_scope(...)` |
| **R5** | 代码风格 | 交付态 `workbench.rs:1129` 一行两条语句（`let produced = …;    let writes = …;`），未过 `rustfmt` | 否 | 冻结时顺手 `cargo fmt` |

---

# 1. ① 行为零变更（最重要）

## 1.1 逐条核对（判定式 / 调用顺序 / 调用次数）

原始输出：`tester/evidence/250_adr024_p2c_p4b_verify/02_behavior_order_counts.txt`、`29_behavior_change_surface.txt`。

| 核对项 | HEAD（pre-P4b） | 交付态 | 判定 |
|---|---|---|---|
| `PROGRESS_THROTTLE_MILLI` 定义 | `const …: f64 = 1000.0;` | `const …: f64 = 1000.0;` | **逐字相同** |
| 节流判定式 | `let milli = (progress * PROGRESS_THROTTLE_MILLI) as i64; if milli != last_milli \|\| i + 1 == total {` | 同一行内加了一行 `engine_p4b.frames_produced.fetch_add(1, …);`，**判定式未变** | **不变** |
| `unbounded_channel` 调用次数 | 1 | 1 | **不变** |
| `sink.send` → `store.update_progress` | 收帧循环内，**send 先、update 后**各 1 次 | **同序、同次数**（各自加了 `Instant` 前后包夹与一个 `fetch_add`） | **不变** |
| `mark_started` 调用点 | 1（`match store.mark_started(...)`） | 1（`let claimed = store.mark_started(...).instrument(..).await; match claimed`） | **不变**（仅包了 span） |
| `mark_succeeded` 调用点 | 1 | 1（同上形态） | **不变** |
| **`report_task.await` 早于 `mark_succeeded`** | L827 < L834 | **L1043 < L1083** | **不变** |
| 结果构造路径 | `to_run_result` / `PerBarRecords` / `bar_record_json` 函数体 | 函数体 sha256 **三者全等** | **未触碰** |
| `execute_run` 参数 | 8 | 10（新增私有 `trace_id`/`p4b`） | 私有函数，调用点仅 1 处 |

**"唯一可能改行为的表面"全量枚举**（净 diff 中所有 `-` 行，共 15 行）：

```
 1 -use std::sync::atomic::{AtomicBool, Ordering};              # 改为 {AtomicBool, AtomicU64, Ordering}
 2 -        tokio::spawn(async move {                            ┐
 3 -            let _permit = semaphore.acquire().await...;      │ spawn 结构改写：外层 .instrument(run_span2)
 4-7 -            execute_run(run_store, progress, …).await;     │ + 新增 permit_wait 计时（参数表 +2）
 8 -        });                                                  ┘
 9 -    match store.mark_started(&run_id, clock.now()).await {    # 拆为 let claimed = …; match claimed
10 -    let report_task = tokio::spawn(async move {               ┐
11 -        while let Some((progress, ts)) = rx.recv().await {    │ 收帧循环体等价重写（原顺序/次数不变）
12 -            let _ = sink.send(&id2, progress, Some(ts)).await; │
13 -            let _ = store2.update_progress(&id2, progress)…;   │
14 -    });                                                        ┘
15 -            match store.mark_succeeded(&run_id, &result, …) {  # 拆为 let written = …; match written
```

⇒ **没有删除任何判定式、没有改变任何调用顺序/次数**；改写均为"取值→match"或"包 span/计时"的同义变换。

## 1.2 客观等价证据（**同一输入：仪表前 vs 仪表后，结果不变**）

**判据选择**：不满足于"只读 diff"，故构造 **pre-P4b 二进制**（把 `workbench.rs` 临时回退到 `HEAD` 版后 `cargo build`，
其余源码与交付态完全一致）与**仪表二进制**（交付态）对照同一输入。回退文件已**逐字节复原**（sha256 相同、`git diff` 空）。

```text
pre-P4b 源码 = git show HEAD:crates/application/src/workbench.rs  sha256 f97f26d6b97b9770…（回退后复原=0a5045ad1072dc0a…）
pre-P4b binary sha256 47d4d1765941a749…（不含 'p4b.run_summary' 字样：0 命中）
仪表   binary sha256 e738fc71293821c1…（=  worker 14:09 构建物；我复原后重建**逐字节相同** ⇒ 构建可复现）
```

三组真实输入（D1/492 bars、M5/3500、M1/16155；同 `dual_ma` 插件、同区间、同参数），逐列对照：

| case | 状态 | per_bar | trades | net_value | drawdown | metrics | 5 列 `md5` |
|---|---|---|---|---|---|---|---|
| small_d1_492 | succeeded / succeeded | 492 / 492 | 6 / 6 | 242 / 242 | 242 / 242 | **JSON 全等** | **全等** |
| medium_m5_3500 | succeeded / succeeded | 3500 / 3500 | 105 / 105 | 3250 / 3250 | 3250 / 3250 | **JSON 全等** | **全等** |
| large_m1_16155 | succeeded / succeeded | 16155 / 16155 | 480 / 480 | 15905 / 15905 | 15905 / 15905 | **JSON 全等** | **全等** |

（`04_equivalence_prep4b_vs_instr.txt`：`md5_per_bar / md5_trades / md5_net / md5_dd / md5_metrics` 五列逐例相同 +
`metrics` 原文相同 ⇒ 结果**逐字节不变**。等价对照产生的 6 条 run **已按前缀删除**，残留 0、孤儿 0。）

---

# 2. ② 基线数字独立复现（PG 长窗口协议）

**协议**（自写 `probe_baseline_250.sh`，非沿用 worker 脚本）：前置 **idle guard**（`pg_stat_user_tables(strategy_run)`
连续 3 次相同）→ 三档串行 → 后置 **settle**（每 5 s 采样，连续 3 次相同才取终值）→ 按前缀删除。

```text
[0] IDLE guard:  376235|2371|1998 → → → 376235|2371|1998（连续 4 次相同）
[1] verify_small_d1_492   | sr_1789712380517_000000 | D1 518880 | succeeded | progress=1 | bars=492  | dur_s=0.437422
    verify_medium_m5_3500 | sr_1789712381060_000001 | M5 159740 | succeeded | progress=1 | bars=3500 | dur_s=0.853156
    verify_large_m1_16155 | sr_1789712382656_000002 | M1 518880 | succeeded | progress=1 | bars=16155| dur_s=0.924582
[2] POST settle: 376235|2371|1998 → 378735|2374|1998
    Δn_tup_upd = 2500   Δn_tup_ins = 3   Δn_tup_del = 0
    理论 Σ(min(1001,bars)+2) = 2500  （494 + 1003 + 1003）            ⇒ 精确闭合 ✓
[3] 并发 4×M5 3500：wall_total=1.983s throughput=2.0168 run/s
    Δn_tup_upd = 4012  理论 = 1003×4                                 ⇒ 精确闭合 ✓
[4] 清理 DELETE 7；残留 0/孤儿 0；strategy_run 回到 374 | 374
```

## 2.1 与 worker 基线表**逐格对照**（`07_baseline_table_parsed.txt` vs worker §B4.1/§B4.2）

| 格 | worker | tester 实测 | 判定 |
|---|---|---|---|
| D1 492 帧数 / 落库次数 | 492 / 492 | **492 / 492** | **一致** |
| D1 落库总耗时 ms | 447.54 | 431.20 | 一致（-3.6%，同量级） |
| D1 **帧均延迟** ms | **0.910** | **0.876** | **一致** |
| D1 permit 持有 / 引擎 / 排水 tail / 序列化 / 结果写 / 取数 ms | 461.39 / 6.55 / 442.78 / 2.37 / 7.15 / 36.25 | 443.58 / 7.06 / 426.13 / 2.38 / 5.70 / **7.26** | 一致（取数更快：I/O 波动） |
| D1 占比：引擎 / 进度落库 / 排水 tail | 1.42% / **97.00%** / 95.97% | **1.59% / 97.21% / 96.06%** | **一致（结论未变）** |
| D1 占比：结果写 / 序列化 / mark_started | 1.55% / 0.51% / 0.37% | 1.28% / 0.54% / 0.32% | 一致 |
| M5 3500 帧 / 落库 | 1001 / 1001 | **1001 / 1001** | **一致** |
| M5 帧均延迟 | 0.852 | **0.827** | 一致 |
| M5 permit / 引擎 / tail / 序列化 / 结果写 / 取数 | 916.82 / 46.66 / 809.18 / 18.24 / 36.93 / 49.08 | 895.80 / 49.14 / 781.80 / 20.60 / 38.36 / 49.85 | 一致 |
| M5 占比：引擎 / 落库 / tail | 5.09% / 93.02% / 88.26% | **5.49% / 92.38% / 87.27%** | 一致 |
| M1 16155 帧 / 落库 | 1001 / 1001 | **1001 / 1001** | **一致** |
| M1 帧均延迟 | 0.835 | **0.830** | 一致 |
| M1 permit / 引擎 / tail / 序列化 / 结果写 / 取数 | 1109.38 / 204.57 / 634.24 / 85.21 / 163.66 / **809.68** | 1108.30 / 208.98 / 625.44 / 88.20 / 163.69 / **653.50** | 一致（取数 -19%） |
| M1 占比：引擎 / 落库 / tail | 18.44% / 75.33% / 57.17% | **18.86% / 74.98% / 56.43%** | 一致 |
| 并发 4：wall / 吞吐 | 1.998 s / 2.0022 run/s | **1.983 s / 2.0168 run/s** | **一致** |
| 并发 4：帧均延迟 / permit 持有 | 1.669–1.713 ms / 1737.4–1799.8 | **1.659–1.709 ms** / 1728.7–1776.5 | **一致（≈2.0× 放大复现）** |
| 进程级累计（7 run） | runs 7 / frames 6498 / writes 6498 | **7 / 6498 / 6498** | **一致** |
| **PG 闭合（7 run 同规模）** | Δ = **6512** | **2500（3 run）+ 4012（4 run）= 6512** | **一致（独立复现同一数字）** |

**不一致项**：无实质不一致。全部绝对时长差异 ≤ 4%（M1 取数 19%）属 I/O 波动；
**帧数 / 落库次数 / 自洽性 / 占比结论 / 吞吐** 五项机器无关量**逐格一致**。

## 2.2 PG 引用计数扣减（§9 收尾）

```text
开工基线（00_baseline_state.txt） : 371235 | 2365 | 1992
段A ①等价对照 6 run(pre3+仪表3)   : 371235 → 376235  Δupd = 5000   （理论 2×2500 ✓）
段B ②三档串行 3 run              : 376235 → 378735  Δupd = 2500   ✓
段C ②并发 4×M5                   : 378735 → 382747  Δupd = 4012   ✓
收尾                              : 382747 | 2378 | 2005
⇒ 本车增量：+11,512 upd / +13 ins / +13 del（后续任何引用须扣除；前序先例 P1c +6,655、P4b-worker +6,512）
残留：T250-% 0 行；孤儿结果行 0；strategy_run 374 | 374（回到开工值）
```

---

# 3. ③ P2c 断言可证伪

## 3.1 三处断言的**精确净 diff**（隔离方法：用"P2b 交付态"blob 反推）

方法（自创）：tester P2b 验收（`tester/evidence/249_adr024_p2b_verify/00_baseline_hashes.txt`）记录的三文件 sha256
= **P2b 交付态（pre-P2c）**；这些 blob 仍在 git 对象库中（未被 gc），可按 sha256 取回 ⇒ `diff` 即 **P2c 净改动**。

```text
[A] strategy.rs            : blob d89e9e21 (sha256 6d31ad10…) → 13 行 diff，仅断言 hunk
[B] engine.rs              : blob 8b80d899 (sha256 dfa827a9…) → 13 行 diff，仅断言 hunk
[C] plugin_orchestrator.rs : blob 981b035b (sha256 b901affe…) → 12 行 diff，仅断言 hunk
```

每处净改动**只含 4 件东西**：①注释 ②`let ctx_bars = <送入 BarCtx 的那一个切片>` ③`debug_assert_eq!(ctx_bars.len(), index+1, "P2c …")`
④把 `BarCtx::new(..., bars, ...)` 的实参换成 `ctx_bars`。**无其他任何行**（`15_p2c_isolated_net_diff.txt`）。
断言绑在**局部变量 `ctx_bars`**（而非闭包入参）上：任何"退回全量切片"的改动都在构造点立即 panic。

## 3.2 反向对照 ×3（各自独立退化 → panic → 复原）

| ID | 构造点 | 退化（临时改生产源码） | 触发测试 | 原始 panic | 复原 |
|---|---|---|---|---|---|
| **R1** | 试算 `tryrun_bar_ctx` | `&bars[..=index]` → `bars`（全量） | `cargo test -p application --lib p2b_tests` | `panicked at strategy.rs:865:5: assertion left == right failed: P2c 前视自检（试算）… left: 8 right: 1`（EXIT=101） | sha256 `a0a279c4…` **逐字节相同**；复绿 1 passed EXIT=0 |
| **R2** | 引擎会话 `EnsembleSession::step` | 追加当前 bar 构造加长切片 `bars+[bar]` | `cargo test -p strategy-core --test session` | `panicked at engine.rs:661:13: …（引擎会话）… left: 2 right: 1` —— **7/7 用例全红**（EXIT=101） | sha256 `9b334eb3…` **逐字节相同**；复绿 **7 passed** EXIT=0 |
| **R3** | sim-live `evaluate` | 同上（共享缓冲前缀外追加 `latest_bar`） | `cargo test -p simlive` | `panicked at plugin_orchestrator.rs:282:17: …（sim-live）… left: 2 right: 1` —— **30 passed / 10 failed**（EXIT=101） | sha256 `d5ae4947…` **逐字节相同**；复绿 40+3+3 EXIT=0 |

> **如实说明**：R2/R3 的"加长"只能靠**复制当前 bar**（流式引擎在构造点**拿不到真正未来 bar**）——
> 这是该位置唯一能造出 `len > index+1` 的方式；它足以触发 `len == index+1` 这个被断言的不变量。
> R1 的反向与 worker 同形（`&bars[..=index]` → `bars`），是其位置唯一的"退回全量"写法。

## 3.3 `BarCtx::with_history` 本体未被改 + P2 反向资产仍绿

```text
crates/strategy-runtime/src/types.rs  with_history 函数体 sha256: index=95ecc9602d6ab0e4  worktree=95ecc9602d6ab0e4  SAME
crates/strategy-runtime/ 本批（P2c/P4b）diff: 空
git diff HEAD --name-only -- crates/strategy-runtime/ : 空（worktree vs index 亦空）
P2 两个反向资产（shared_history.rs:199/271 用「全量 &bars + with_history」）:
  cargo test -p strategy-runtime --test shared_history → ok. 7 passed; 0 failed; EXIT=0
```

## 3.4 release 侧（如实标注强度）

`debug_assert!` 由 Rust 语义保证在 release 编译掉；worker 证据 `30_release_check.txt` 为 `cargo check --release`
通过。**我未独立复跑 release 下的反向对照**（时间盒取舍）⇒ 该点作为"语义保证 + worker 证据"，未升格为本报告的独立证据。

---

# 4. ④ 观测面自洽

## 4.1 `produced == writes == min(1001, bars)`（自跑证据）

```text
sr_1789712380517_000000 bars=492    expected=492  produced=492  writes=492  -> OK
sr_1789712381060_000001 bars=3500   expected=1001 produced=1001 writes=1001 -> OK
sr_1789712382656_000002 bars=16155  expected=1001 produced=1001 writes=1001 -> OK
sr_1789712399075_000003 … sr_1789712399225_000006（并发 4）全部 1001/1001 -> OK
（7/7 OK；Σframes 6498 = Σwrites 6498 = global_frames_total/global_db_writes_total）
```

## 4.2 span 父子关系 + `trace_id` 一致性

```text
run=sr_1789712381060_000001  trace_id=92062b7378476947040e6793d53732e5
  06:19:41.059804Z  spans=[workbench_run, p4b.segment{fetch}]                p4b.segment
  06:19:41.061462Z  spans=[]                                                 p4b.submit
  06:19:41.062785Z  spans=[workbench_run, p4b.segment{mark_started}]         p4b.segment
  06:19:41.112044Z  spans=[workbench_run, p4b.segment{engine}]               p4b.segment
  06:19:41.893825Z  spans=[workbench_run, p4b.segment{progress_drain}]       p4b.segment（含 progress_db_writes=1001）
  06:19:41.893996Z  spans=[workbench_run, p4b.segment{progress_drain_tail}]  p4b.segment
  06:19:41.914729Z  spans=[workbench_run, p4b.segment{result_serialize}]     p4b.segment
  06:19:41.953242Z  spans=[workbench_run, p4b.segment{result_write}]         p4b.segment
  06:19:41.957502Z  spans=[workbench_run]                                    p4b.run_summary

判定①：7 run 各自 trace_id 唯一、run 内单一 trace_id 贯穿 submit→落库段
判定②：segment 事件 49/49 的 spans[0] == 本 run 的 workbench_run（同 run_id/trace_id），无非法父关系
判定③：父 span 字段 Empty→record：fetch 段快照 run_id/bars_total 为 None（记录早于 run_id），
        run_summary 处快照已补全（symbol/period/run_id/bars_total 全非空）——语义正确
判定④：进程级累计 = 求和（runs 7 = 7；frames 6498 = 6498；writes 6498 = 6498）
```

**JSON 日志取得方式**：我自启仪表实例时把 stdout 重定向到 `/tmp/app_tester_instr_18081.json.log`
（`tracing_subscriber::fmt().json()`），副本落在 `06_baseline_app_json_log.txt`（40,770 B / 69 事件）。
**无"拿不到日志"的替代证据需求**。

## 4.3 单元级（mock 路径）观测面

`cargo test -p application --test workbench p4b -- --nocapture`（隔离树，交付态）：
事件 9 条 / span 8 个；`p4b.submit`(spans=[]) → 7 个 segment → `run_summary`；
`progress_frames_produced=300 == progress_db_writes=300 == bars`；`trace_id` 全链一致（`25_p4b_unit_capture.txt`）。
与 worker `13_p4b_capture_raw.txt` 形态一致。

## 4.4 判读约束复核（worker 自陈，我复核成立）

`progress_drain_*` 与 `engine_ms` **可重叠**（observer 只入队不等待），只有 `progress_drain_tail_ms` 是不重叠等待
⇒ **不得把各段相加当 permit 持有**。实测佐证：D1 492 的 `hold=443.58` 而 `engine+drain_total=7.06+433.31=440.37 < hold`（两段重叠、不可相加）；
M1 16155 的 `engine+drain_total=208.98+834.59=1043.57 < hold=1108.30`（差 64.7 ms = 序列化+结果写+mark_started，仍被 hold 覆盖）。
（worker 的源码注释与报告均已写此约束，我未发现被误用：报告 §B4.2 输出的是**占比（各段/hold）**而非求和。）

## 4.5 观测面自陈的"新增形态"（→ §0.3 R2）

本批**零新依赖**（`tracing` 本已为 application 依赖；`Cargo.toml`/`Cargo.lock` 无 diff），
span 在既有 JSON subscriber 的 `"span"/"spans"` 字段可见。是否"须先问再动"属架构师裁定项（worker §B0 已自陈）。

---

# 5. ⑤ 范围与回归

## 5.1 `git diff HEAD --stat` 分类

| 归属 | 文件 | 判据 |
|---|---|---|
| **P2c（本批）** | `strategy-core/src/engine.rs`、`application/src/strategy.rs`、`simlive/src/plugin_orchestrator.rs` | 净 diff 仅断言（§3.1） |
| **P4b（本批）** | `application/src/workbench.rs`、`application/tests/workbench.rs` | 二者**不在** tester 249（P2b 验收当日）的存量清单里 ⇒ 其全部 HEAD-diff 只能来自本批（`grep -c 'application/src/workbench.rs\|application/tests/workbench.rs' 249/A5_01_git_diff_stat.txt` = **0**） |
| P0/P2/P2b（前序批次，已 staged） | `bar_map.rs`、`strategy-runtime/*`、`backtest/*`、`mcp/*`、`web/*`、`design/**`、前端 TS | 见前序验收报告 |
| **并发车道 P4（非本批，在飞）** | `domain/src/ports.rs`、`storage/src/{workbench,migrate_check}.rs`、`web/src/{lib,workbench}.rs`、`migrations/0027_*.sql`（14:19:51 新建）、`design/04-storage/*`、`design/02-domain/contracts.md` | 内容含 `ResultChunk/ResultKind/result_format/downsampled/RESULT_CHUNK_BARS` 等 D8–D10 符号；mtime ≥ 14:19 |

## 5.2 红线未触碰逐条

| 红线 | 证据 | 判定 |
|---|---|---|
| 进度节流粒度 | `PROGRESS_THROTTLE_MILLI = 1000.0`（HEAD/WORK 逐字相同）；判定式未改（§1.1） | **未触碰** |
| 写入合并/降频 | 收帧循环仍"每帧 1 次 `update_progress`"；PG 逐段闭合 2500/4012（§2.2） | **未触碰** |
| `mark_succeeded` 前排水顺序 | `report_task.await` L1043 < `mark_succeeded` L1083（§1.1） | **未触碰** |
| 落库 schema | `migrations/` HEAD-diff **0 文件**（`0027_strategy_run_result_chunks.sql` 由 P4 车道 14:19:51 新建，属 P4）；`crates/storage/*` 的两处 diff 分属 P0（`backtest.rs` 注释）与并发 P4（`workbench.rs`/`migrate_check.rs`），**均非本批** | **未触碰** |
| 结果 API | 本批净 diff 中**新增 `pub` 行数 = 0**（脚本核对：新增项仅 2 个私有 struct + 3 个私有 fn）；**未改任何公开 DTO**（`CompareItem`/`SubmitRunReq`/`RunBrief` 等改动均属 P4 车道；P4b 只增私有 struct/函数 `execute_run` 私有参数） | **未触碰** |
| 区间护栏 | `MAX_BARS=200_000`、`MAX_SCORE_POINTS=50_000`、`MAX_EVENTS=1_000`、`MAX_TRADES=5_000`、`D1_MAX_SPAN_DAYS=366*5`、`MINUTE_MAX_SPAN_DAYS=93` —— HEAD vs WORK **逐字相同** | **未触碰** |
| `design/16-*` | `04-implementation-plan.md` 的 worktree 改动（14:00:13）内容为**架构师派单留痕**（标记 P2b 已冻结、新增 P2c 行、P4b 两阶段说明），非 P4b 实现产物；其余 `01-adr/02-spec/03-test-plan` mtime 均早于本批 | **实现未触碰**（文档由架构师改） |
| `docker-compose.yml` | mtime 12:16:18 < 本批窗口；改动属 ADR-025 D1（`max_worker_processes`），非本批 | **未触碰** |
| sim-live 业务逻辑 | `session.rs`/`fill.rs`/`account.rs`/`strategy_orchestrator.rs` sha256 HEAD == WORK（`3dd90806…`/`acdf7332…`/`0091627e…`/`896be560…`） | **未触碰** |
| 新依赖 | `Cargo.toml`/`Cargo.lock` 无 diff | **零新依赖** |

## 5.3 回归（**exit code**）

主 worktree 当前**不可编译**（并发车道 R1，见 §0.3）。故我把 **index 交付态**导出为隔离树
（`git checkout-index -a --prefix=/tmp/tree250/`，5 个目标文件 sha256 与 index 逐字节相同），
补齐 2 个 untracked 只读 tester 资产（`240_golden_baseline`、tester 独立探针测试）后运行：

| 命令（隔离树 = index 交付态） | 结果 | 退出码 |
|---|---|---|
| `cargo test -p application` | **27 + 2 + 6 + 55 + 39 + 3 + 18 = 150 passed / 0 failed**（与 worker 表**逐段相同**） | **0** |
| `cargo test -p strategy-core` | 33+25(1 ignored)+6+7+1+3 passed / 0 failed | **0** |
| `cargo test -p simlive` | 40+3+3 / 0 failed | **0** |
| `cargo test -p strategy-runtime` | 17+13+6+5+3+1+7+1（+1 ignored）/ 0 failed | **0** |
| `cargo test -p backtest` | 31 / 0 failed | **0** |
| `cargo test --workspace --no-fail-fast` | **653 passed / 137 failed / 2 ignored** | **101** |

**137 个失败的逐块归因（脚本分类，`28_isolated_workspace_tests_final.txt`）**：

```text
失败块: 哨兵门禁=137 其他=0
（全部含 `EESTOCK_TEST_DATABASE_URL` 未设置 / 连接失败 / 哨兵表 的 ADR-023 E6b 刻意响亮失败）
实例：thread '…' panicked at crates/test-support/src/lib.rs:32:14:
      集成测试拒绝运行：环境变量 `EESTOCK_TEST_DATABASE_URL` 未设置（或为空）。
```

环境事实：本机 PG 只有 `eestock`（**无 `eestock_test`**）；任务纪律与 ADR-025 D3 禁止我新建库
⇒ 该 137 项**在本车道无法执行**（非缺陷）。**去掉门禁后非门禁失败数 = 0。**

**主干可编译性（如实报告）**：

```text
$ cargo test -p application --no-run     （主 worktree，含并发车道在飞改动）
error[E0063]: missing field `result_format` in initializer of `StrategyRunResult`
   --> crates/application/src/workbench.rs:1196:5
error[E0046]: not all trait items implemented … missing `append_result_chunk`, `result_chunks`, …
EXIT=101
归属证据：这些符号（ResultChunk/ResultKind/result_format/RESULT_FORMAT_*）出现在
  domain/ports.rs(14:20:05)/storage/workbench.rs(14:20:32)/migrations/0027(14:19:51)/web/workbench.rs(14:23:20)
  —— 均晚于本批窗口（14:00–14:13），且不在本批 5 文件净 diff 中。
并发版本是否仍保留 P4b：worktree workbench.rs 的 P4b 结构计数与交付态**逐键相同**
  （p4b.run_summary 1/1、P4bRunCounters 3/3、P4B_GLOBAL 6/6、p4b.segment 14/14、workbench_run 2/2、p4b.submit 1/1）
  ⇒ P4b 未被覆盖，但**同一文件双车道编辑**风险确凿（§0.2 冻结建议）。
```

## 5.4 tangle / clippy（引用 worker 证据 + 我未复跑）

`cargo check --workspace --all-targets`、`clippy`（仅 1 条既有 `FeeModel` clone warning）、
`bash scripts/check-tangle.sh` ✅ 均有 worker 原始输出（`27/20/28`）。**我未独立复跑**（主 worktree 不可编译，
隔离树缺 tangle 生成的 docs 依赖链）；本项按"未独立复核"标注，不升格为 P2c/P4b 的阻塞项。

---

# 6. ⑥ 并发稳定性

```text
# 隔离树 index 交付态；EESTOCK_TEST_DATABASE_URL 未设
--- cargo test -p application --test workbench ×5（默认 test-threads）---
run#1..#5: test result: ok. 18 passed; 0 failed  EXIT=0    （5/5 全绿）
--- cargo test -p application -- --test-threads=16 ×3 ---
run#1..#3: 27/2/6/55/39/18 全 ok   EXIT=0                  （3/3 全绿）
```

worker 自报的"线程本地 `set_default` + 进程级 callsite interest 缓存"坑，其交付态测试内已用
`OnceLock + set_global_default + callsite::rebuild_interest_cache()` + `thread_local!` span 栈修掉
（交付态文件 L1043/L1128/L1133–1136）。**我未复现 flaky**（8 次运行 0 失败）。

---

# 7. 纪律与副作用（诚实报告）

| 项 | 结果 |
|---|---|
| 生产源码 | **未留任何改动**：`strategy.rs`/`engine.rs`/`plugin_orchestrator.rs`/`tests/workbench.rs` worktree sha256 与 index 一致（`tests/workbench.rs` 现被**并发车道**改动，非我）；`workbench.rs` 的 worktree 偏离来自 P4 车道 |
| 临时改动 | 仅 ③ 反向对照的 4 处临时退化（3 处已复原为交付态，逐字节相同）+ ① 的 1 次临时回退（已复原）；全部有 sha256 前后对照 |
| git | **未 `git add`/`commit`**（HEAD 仍 `18d1b9a`） |
| 数据库 | 未新建库、未改 schema、未加列；只写 `strategy_run` run 行（前缀 `T250-`/`T250-EQ-`）并在收尾删除（残留 0、孤儿 0） |
| PG 累计污染 | `+11,512 upd / +13 ins / +13 del`（不可回滚，须扣除，§2.2） |
| `alert_events` | 我两个仪表实例启动各执行一次告警评估（`alert_eval_ms=3600000`）：观测窗口内 446→448 条、fire_count 605→607，`max_last_fired=06:21:42` **晚于我两个实例的停止时刻（06:20:30）** ⇒ 归因 **prod 8081 的 60 s 节拍**；未发现我实例产生的额外写入（**精确隔离未做**，如实标注，与 worker §B6 同类） |
| 端口/进程 | 我启的 4 个实例（18081/18091/18092 + 等价对照对）**全部停止**；端口已释放；**prod 8081 全程未重启未替换**（`/proc/4083225/exe` sha256 与开工相同 `f4d07dcc…`，healthz=200） |
| 隔离树 | `/tmp/tree250`（index 导出，130 MB）；未写入主 target 之外的任何仓库路径；`CARGO_TARGET_DIR` 复用主 target（只增编译产物） |

---

# 8. 结论（一句话版）

> **P2c 与 P4b（仪表阶段）均 PASS，可以冻结。**
> P4b **只加观测**（15 行非新增行全量枚举 + 三组真实输入结果逐字节等价）；
> 基线数字在**独立进程、独立探针、独立 PG 长窗口协议**下与 worker 表**逐格一致**
> （帧/落库 492/492、1001/1001、1001/1001；帧均 0.876/0.827/0.830 ms；占比结论未变；Δupd 逐段精确闭合 2500/4012 = 6512）；
> P2c 三处断言**精确净 diff + 三次反向对照 panic + 逐字节复原**，`with_history` 本体未动、P2 反向资产仍绿；
> 观测面自洽（produced==writes==min(1001,bars)、trace_id 贯穿、父子 span 49/49 合法）；
> 应用层测试 `EXIT=0`，稳定性 8/8 全绿。
> **唯一的操作性警告**：并发车道（P4）正在改同一个 `workbench.rs` 且已使主干不可编译
> —— **请先冻结 index 快照再让 P4 继续**；11,512 次 `n_tup_upd` 累计污染须在后续引用中扣除。

---

## 附：证据索引（`tester/evidence/250_adr024_p2c_p4b_verify/`）

| 文件 | 内容 |
|---|---|
| `00_baseline_state.txt` | 开工基线（HEAD/index 哈希、pg_stat、端口、二进制） |
| `01_p4b_workbench_diff.txt` | **P4b 净 diff（478 行，06:19Z 抓取，worktree==index）** |
| `02_behavior_order_counts.txt` | ① 判定式/顺序/次数逐条对照 |
| `03_eq_binary_{instr,prep4b}_sha.txt` | 等价对照两二进制 sha256（pre-P4b 无 P4b 字样） |
| `04_equivalence_prep4b_vs_instr.txt` | ① 三组输入 × 5 列 md5 全等 |
| `05_baseline_reproduction_raw.txt` | ② 长窗口协议原始输出（idle/settle/Δ） |
| `06_baseline_app_json_log.txt`、`07_baseline_table_parsed.txt` | ② 我自跑实例 JSON 日志 + 解析表 |
| `08_/08b_observation_*` | ④ trace 链 + 父子 span + 父 span 字段补全 |
| `09_/22_/23_`（R1）、`10_/11_`（R2）、`12_/13_`（R3） | ③ 反向 panic + 复原复绿 |
| `14_p2c_with_history_untouched.txt` | ③ `with_history` 本体未改 + P2 反向资产仍绿 |
| `15_p2c_isolated_net_diff.txt` | ③ 三处断言精确净 diff（blob 反推） |
| `16_scope_and_regression_scope.txt` | ⑤ 分类 + 红线逐条 |
| `17_/delivered_index_state/` | 交付态逐字节快照 + 一致性校验 |
| `19_concurrent_lane_evidence.txt` | 并发车道（P4）干扰面证据与归属 |
| `20_nonblocked_crate_tests.txt`、`21_/27_`、`26_/28_` | ⑤ 各 crate / application / workspace 测试与退出码 |
| `24_concurrency_stability.txt` | ⑥ 8 次并行复跑 |
| `25_p4b_unit_capture.txt` | ④ mock 路径捕获（300/300、trace_id 全链） |
| `29_behavior_change_surface.txt` | ① 非新增行全量枚举 + 排水顺序行号 |
| `30_final_accounting_and_hygiene.txt` | 收尾核算 + 现场复原 + 纪律自查 |
| `probe_baseline_250.sh`、`probe_equiv_250.sh` | 我自写探针（可复跑） |
