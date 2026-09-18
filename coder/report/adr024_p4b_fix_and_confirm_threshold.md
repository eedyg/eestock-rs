# ADR-024 P4b 修复（进度落库时间窗节流）+ confirm 阈值 200000→500000 —— coder 交付报告

- **本报告自身路径**：`coder/report/adr024_p4b_fix_and_confirm_threshold.md`
- 角色：coder（TDD；**未 `git commit`，仅 `git add`**；临时库跑完即 `DROP … WITH (FORCE)`）
- 冻结基线：HEAD `18d1b9a` + index 中的 ADR-024 P0–P6 全部（staged）；本批改动 = 该 index 之上的工作区增量
- 证据目录：`coder/evidence/adr024_p4b_fix/`（18 个原始输出 + `probe_p4bfix.sh` + `extract_summary.py`）
- 依据：
  - `design/16-backtest-scalability/01-adr.md` **D15**（含①「先仪表后优化」已完成的改动前基线）
  - 改动前真路径基线：`coder/evidence/adr024_p2c_p4b/`（注意：派单写的 `coder/evidence/adr024_p4b/` 目录**不存在**，
    实际基线目录名是 `adr024_p2c_p4b`；本批另在临时库上**重跑了 before/after 两轮**，见 §1.3）
  - 契约向量：`design/16-backtest-scalability/contract-vectors.json::span_limit_semantics.resource_guard`
    （架构师已改：`max_bars_guard: 2000000` / `confirm_bars: 500000`）

---

## 0. 判词（结论在最前）

| 任务 | 判词 | 关键证据 |
|---|---|---|
| **任务一：P4b 进度落库时间窗节流（≥250ms）+ 终态必写** | **完成（红→绿→反向齐备；真路径 3 档对照）** | 帧数**不变**（733/1001/1001）；落库 **733→2 / 1001→2 / 1001→3（−99.7%）**；落库总耗时 **−99.6%**；`permit` 持有 **642.8→31.0 / 910.3→119.8 / 1035.4→393.2 ms**；落库占 permit **97.1%→8.7% / 93.8%→2.2% / 79.8%→1.0%** |
| **任务二：confirm 阈值 200000→500000（硬上界 2_000_000 不变）** | **完成（向量绑定断言红→绿→反向齐备）** | 新断言 `resource_guard_contract_vectors.rs` 3 例：绑定前 2 红 → 改常量后 3 绿；反向改回 200000 复红 |
| 非目标 | **全部未触碰** | 引擎/指标、区域收缩、结构化错误语义、结果分块与端点、`design/16-backtest-scalability/**`、`docker-compose.yml` —— 均无本批 diff；**无 `git commit`** |
| 临时库纪律 | **遵守** | `EESTOCK_TEST_DB_NAME=tmp_p4bfix_1789724479 scripts/testdb-init.sh` → 跑 → `DROP … WITH (FORCE)` → 回读 `eestock,postgres`（§1.8） |

---

# 任务一：P4b 修复 —— 进度写库**时间窗节流**

## 1.1 改动清单（只 1 个生产文件 + 1 个测试文件）

| 层 | 文件 | 改动 |
|---|---|---|
| application | `crates/application/src/workbench.rs` | 新增常量 `PROGRESS_DB_MIN_INTERVAL = 250ms`；report 任务（consumer）改为**时间窗节流**；新增终态补写；新增计数器 `progress_db_throttled` 与 helper `p4b_write_progress`；模块/字段文档同步 |
| application（测试） | `crates/application/tests/workbench.rs` | mock `MockRunStore` 增 `progress_calls`（记录**每次** `update_progress` 调用）+ `fail_on_append`（注入分块写失败）；新增 3 条节流/终态测试 + 辅助函数；`p4b_run_summary_counters_are_self_consistent` 的帧数断言按**新契约**更新（见 §1.6） |

**核心 diff（语义）**：

```rust
// 常量（workbench.rs:81）
const PROGRESS_DB_MIN_INTERVAL: Duration = Duration::from_millis(250);

// report 任务（consumer 侧）—— 帧粒度不变，只降落库频率：
RunMsg::Progress(progress, ts) => {
    let _ = sink.send(&id2, progress, Some(ts)).await;        // WS 每帧仍推（不变）
    let due = last_db_write.is_none_or(|t0| t0.elapsed() >= PROGRESS_DB_MIN_INTERVAL);
    if due || progress >= 1.0 {                               // ① 时间窗到期 或 ② 完成帧（==1.0）
        p4b_write_progress(&store2, &id2, progress, &report_p4b).await;
        last_db_write = Some(Instant::now());
        pending = None;
    } else {
        report_p4b.db_throttled.fetch_add(1, Ordering::Relaxed);
        pending = Some(progress);                             // 暂存最近一帧（终态补写用）
    }
}
// while let Some(msg) = rx.recv().await { … } 结束后（通道关闭 = 引擎结束）：
if let Some(progress) = pending {                             // ③ 终态必写：补写末帧
    p4b_write_progress(&store2, &id2, progress, &report_p4b).await;
}
```

## 1.2 设计要点 & **未改清单**（逐条核对派单硬约束）

| 约束 | 落实 |
|---|---|
| **WS 帧粒度不变**（仍按 `PROGRESS_THROTTLE_MILLI = 1000.0` 产生帧） | observer 判定式与 `tx.send` 分支**零改动**；`sink.send` 仍在每帧调用（测试断言 `ws_frames == frames`：3000 bar ⇒ 1001==1001） |
| **只把落库降频**（≥250ms/次） | report 任务内 `store.update_progress` 从「逐帧」变「时间窗到期才写」 |
| **终态必写**（完成/失败/取消各落一次最终进度） | 完成帧 `progress>=1.0` **无条件写**；取消/中途失败的末帧 <1.0 由**通道关闭补写**收口；三条路径写调用均发生（测试 §1.4） |
| **不得改** `mark_succeeded` 前的排水顺序 | `report_task.await` 仍在 outcome `match` **之前**（仅在其内部新增补写；顺序不变） |
| **不得改** `unbounded_channel` 语义 | `tokio::sync::mpsc::unbounded_channel` 未动（无容量/`try_send`/drop 分支） |
| **不得改** 取消的**每 bar 检查** | observer 顶部 `flag2.load → LoopControl::Break` 未动 |
| **不得改** 结果分块写入顺序与语义 | `RunMsg::Chunk` 分支逻辑未动（仅位置不变地重排了相邻代码）；分块仍先于 `mark_succeeded` |
| 计数器：帧数/落库次数/落库耗时/permit 占比 | `progress_frames_produced` / `progress_db_writes` / `progress_db_write_ms` / `permit_hold_ms` + `progress_db_share_pct` 均可读；**新增** `progress_db_throttled`（收帧时被时间窗跳过的帧数） |

> 语义边界（诚实披露）：`store.update_progress` 的 `status='running'` 守卫未改（派单未授权且非本批范围）。
> 因此「终态必写」的落实是**写调用不被时间窗吞掉**：
> - 成功/失败路径：排水（`report_task.await`）**先于** `mark_succeeded`/`mark_failed` ⇒ 补写在 `running` 态落库；
> - 取消路径：若由**引擎自身 Break** 收口（`execute_run` 的 `mark_canceled` 在排水之后）⇒ 补写落库（真路径实测见 §1.4）；
>   若**外部 `cancel()` 请求**先赢下状态迁移（`mark_canceled` 即时置 canceled）⇒ 补写命中既有 `running` 守卫成为 no-op
>   （此时 DB `progress` 停在取消前最后一次节流写）。这是**既有守卫**行为，不是节流引入的吞帧；详见 §未决项①。

## 1.3 硬证据 ①：真路径 before / after 对照（3 档规模，串行）

- **方法**：同机、同夹具（`dual_ma fast=5 slow=20`，`warmup_bars=250`）、同临时库 `tmp_p4bfix_1789724479`、串行提交；
  `before` = 未节流二进制（index 源码），`after` = 本批源码二进制；两二进制均在**本轮**从对应对源码 `cargo build -p app` 产出
  （`/tmp/eestock-app-before` vs `/tmp/eestock-app-after`，`cmp` 确认不同）。
- **三档**：`518880 D1 2024-08-01→2026-08-01`；`518880 M1 2026-04-01→2026-04-23`；`518880 M1 2026-03-02→2026-06-09`。
  （表内 `bars` = 引擎实际喂入数 = 区间 bar + 250 根预热：483+250=733 / 3615+250=3865 / 16147+250=16397。）
- 原始输出：`coder/evidence/adr024_p4b_fix/{10_before_probe_console.txt, 11_before_summary_table.txt,
  12_after_probe_console.txt, 13_after_summary_table.txt, 17_before_after_table.txt}`

| 阶段 | bars | **帧数** | **落库次数** | 落库总耗时 ms | permit 持有 ms | 落库占 permit | 端到端 dur*s* | 引擎 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **before**（逐帧落库） | 733 | 733 | 733 | 624.132 | 642.757 | 97.1% | 0.640918 | 14.279 |
| **before** | 3865 | 1001 | 1001 | 853.790 | 910.276 | 93.79% | 0.906628 | 70.410 |
| **before** | 16397 | 1001 | 1001 | 825.748 | 1035.404 | 79.75% | 1.025988 | 298.639 |
| **after**（≥250ms 节流） | 733 | **733** | **2** | **2.685** | **30.967** | **8.67%** | **0.028636** | 14.202 |
| **after** | 3865 | **1001** | **2** | **2.625** | **119.768** | **2.19%** | **0.116901** | 70.362 |
| **after** | 16397 | **1001** | **3** | **3.730** | **393.244** | **0.95%** | **0.384372** | 284.291 |

**降幅**（`17_before_after_table.txt`）：

```
bars=733:   writes 733→2  (-99.7%)  db_ms 624.1→2.7  (-99.6%)  hold_ms 642.8→31.0   (-95.2%)  frames 733→733
bars=3865:  writes 1001→2 (-99.8%)  db_ms 853.8→2.6  (-99.7%)  hold_ms 910.3→119.8  (-86.8%)  frames 1001→1001
bars=16397: writes 1001→3 (-99.7%)  db_ms 825.7→3.7  (-99.5%)  hold_ms 1035.4→393.2 (-62.0%)  frames 1001→1001
```

**读判**：
- **帧数逐档不变**（733/1001/1001）⇒ WS 帧粒度与 UI 流畅性未受影响（帧数封顶 1001 与 bars 无关的既有事实保留）。
- **落库次数下降 ≈ 99.7%**，落库总耗时下降 ≈ 99.6%；端到端 `dur` 从「≈帧数×每帧写库」变为「引擎 + 分块序列化主导」。
- 16397 档 `hold_ms` 仍 393 ms（引擎 284 ms + 分块序列化/写出 + 排水）——**落库已不再是主导项**（0.95%）。

## 1.4 硬证据 ②：终态必写（完成 / 失败 / 取消 三条路径）

测试载体：`crates/application/tests/workbench.rs`（mock store 逐调用记录 `update_progress`）。
原始输出：`18_terminal_write_three_paths.txt`（`--nocapture`）：

```
[D15-throttle]            bars=3000 frames=1001 writes=2   throttled=999 ws_frames=1001 db_ms=0.004 hold_ms=56.45 last_update_progress=Some(1.0)
[D15-terminal/failed]     status=Failed frames=1001 writes=2   throttled=999              last_update_progress=Some(1.0)
[D15-terminal/cancel]     status=Canceled frames=313 writes=3   throttled=311 sink_last_frame=0.312 last_update_progress=Some(0.312)
```

| 路径 | 手段 | 断言 | 结果 |
|---|---|---|---|
| **完成** | 3,000 bar 正常运行至 `succeeded` | 末次 `update_progress` == **1.0**（完成帧无条件写） | ✅ `Some(1.0)` |
| **失败** | 注入 `append_result_chunk` 失败（`fail_on_append`；D8 分块写失败） | run 落 `failed` 且末次 `update_progress` == **1.0** | ✅ `status=Failed`，`Some(1.0)` |
| **取消** | 50,000 bar 跑到进度 ≥0.2 时 `svc.cancel()`（协作式 Break） | **WS 末帧（0.312）== 末次 `update_progress`（0.312）**；即「被节流暂存的末帧经排水补写入库」 | ✅ `Some(last_frame)` |

**真路径取消交叉验证**（`14_realpath_cancel_terminal_progress.txt`，临时库 + after 二进制）：
- 取消（引擎 Break 收口）run：`status=canceled`，**DB `progress=0.40903823870220163`** = 末次补写帧；
  `frames=410 / writes=2 / throttled=409`（首帧 + 补写末帧）。⇒ **末帧（<1.0）确实落库**。
- 同批另一次外部 `cancel()` 赢下状态迁移的 run：`status=canceled`，DB `progress=6.09867e-05`（首帧），
  `frames=382 / writes=2 / throttled=381`。⇒ 补写调用发生，但被既有 `status='running'` 守卫丢弃（**非节流吞帧**）。

## 1.5 硬证据 ③：反向证据

| # | 反向操作（临时改生产源码） | 期望 | 原始输出 | 复原 |
|---|---|---|---|---|
| R1 | **关闭时间窗节流**（`let due = true;`，退回逐帧落库） | 三条「落库次数下降」断言**必红** | `08_reverse_throttle_off_red.txt`：`writes=1001 produced=1001`（×2）+ `writes=201 produced=201`，**0 passed; 3 failed** | 已复原（工作区无 `REVERSE-EVIDENCE` 标记） |
| R2 | **去掉终态补写**（节流保留，删 flush 块） | 取消路径末帧被吞 ⇒ 断言必红；成功/失败仍绿 | `09_reverse_no_flush_red.txt`：`sink 末帧=0.316 但 update_progress 末次=Some(0.301)`，**仅 cancel 例红（1 failed; 2 passed）** | 已复原 |

R1 证明「落库次数下降」断言对节流**敏感**；R2 证明「终态必写」断言对补写**敏感**（且是**判别性**的：只有取消路径变红）。

## 1.6 既有回归

- `cargo test -p application` **全绿**：`15_application_full_suite_final.txt`
  （`unittests 28 + adr024_p2b_tryrun 2 + backtest_periods_ssot 6 + resource_guard_contract_vectors 3 +
  simlive 55 + strategy 41 + tester_p2b_tryrun_indep 3 + workbench 43`，**0 failed**）
- **`p4b_run_summary_counters_are_self_consistent` 通过**（`06_green_self_consistency.txt`）：
  其 **② 断言的契约按本批方案显式更新** —— 旧契约 `produced == writes`（逐帧落库的事实）在节流方案下**不成立**，
  改为 `1 ≤ writes ≤ produced`；新方案的判别性断言由新增的
  `p4b_progress_db_time_window_throttle_reduces_writes`（含反向 R1/R2）承担。
  （说明：这是**派单认可的契约变更**，不是「改测试迁就实现」——旧断言描述的是被本次方案取代的旧行为。）
- 该 run（300 bar）实测 `frames=300 writes=2 throttled=298`，`progress_db_write_ms=0.009`（mock 库）。

## 1.7 未受影响的既有语义（本批 diff 核对）

- observer 的帧判定、`send` 分支、取消每 bar 检查：**无 diff**；
- `mark_succeeded` 前排水顺序、`unbounded_channel`：**无 diff**；
- 结果分块（`RunMsg::Chunk` 分支）行为：**无 diff**（仅代码位移）。

## 1.8 临时库纪律（原始输出 `16_tmpdb_teardown.txt`）

```
# db: tmp_p4bfix_1789724479
DROP: DROP DATABASE
ok
库清单: eestock,postgres
```

`scripts/testdb-init.sh` 播种日志（只读源 `eestock`）：symbols 44 / strategy 23 / strategy_version 24 /
`kline_accurate`(518880+510050 M1) 1,631,570 / `kline_accurate_1d` 6,770。全程对活库 `eestock` 只读。

---

# 任务二：confirm 阈值 200000 → 500000

## 2.1 常量 diff（`crates/application/src/error.rs`）

```diff
 /// 硬上界（**无 confirm 放行**）：预估/实际 bar 数 > 此值 ⇒ 400 `resource_guard`。
+///
+/// 2026-09-18 修订：保持 `2_000_000` 不变（M1 全历史≈86 万 bar ⇒ 合法请求永不触发）。
 pub const MAX_BARS_GUARD: usize = 2_000_000;
 /// 二次确认阈值：预估/实际 bar 数 ≥ 此值 ⇒ 400 `resource_guard` 带 `detail`；客户端 `confirm=true` 重提 ⇒ 放行。
-pub const GUARD_CONFIRM_BARS: usize = 200_000;
+///
+/// 2026-09-18 用户「按推荐」修订：由 `200_000` 提到 **`500_000`（≈M1 五年）** ——
+/// 低于此值的合法区间一次提交即过（不再被二次确认打断）；硬上界 [`MAX_BARS_GUARD`] 不变。
+/// 两常量与 `design/16-backtest-scalability/contract-vectors.json`
+/// `span_limit_semantics.resource_guard.{max_bars_guard, confirm_bars}` **绑定**
+/// （防漂移断言：`crates/application/tests/resource_guard_contract_vectors.rs`）。
+pub const GUARD_CONFIRM_BARS: usize = 500_000;
```

同步：`guard_bars()` 的 `detail` 口径加注释（`limit_bars = MAX_BARS_GUARD`；`confirm_bars = GUARD_CONFIRM_BARS`；
`requested_bars`；`confirmable`）；`workbench.rs` 模块文档的旧「>20 万拒绝」更正为
「≥ 500_000 需二次确认、> 2_000_000 硬拒」。

## 2.2 防漂移向量绑定断言（新增 `crates/application/tests/resource_guard_contract_vectors.rs`）

3 条断言（**均从 `contract-vectors.json` 推导期望值**，向量改 ⇒ 必红）：

1. `MAX_BARS_GUARD` == 向量 `resource_guard.max_bars_guard`；
2. `GUARD_CONFIRM_BARS` == 向量 `resource_guard.confirm_bars`；
3. 运行期阈值与向量一致：`confirm_bars-1` 放行、`confirm_bars` 需确认（`detail.confirm_bars/limit_bars/confirmable` 回显）、
   `confirm=true` 放行、`max_bars_guard+1` 硬拒（`confirmable=false`）。

| 相位 | 输出 | 结果 |
|---|---|---|
| **红**（绑定测试先行，常量仍 200_000） | `01_red_confirm_bars_binding.txt`：`GUARD_CONFIRM_BARS(200000) != …(500000)` | **1 passed; 2 failed** |
| **绿**（常量改 500_000） | `02_green_confirm_bars_binding.txt` | **3 passed; 0 failed** |

## 2.3 反向证据（常量改回 200000）

`03_reverse_confirm_bars_red.txt`：把 `GUARD_CONFIRM_BARS` 临时改回 `200_000` ⇒ 绑定断言**复红**：

```
assertion `left == right` failed: GUARD_CONFIRM_BARS(200000) != contract-vectors.json `…confirm_bars`(500000)
  left: 200000   right: 500000
confirm_bars - 1 = 499999 必须放行（无护栏）
test result: FAILED. 1 passed; 2 failed
```

已复原（`error.rs` 现为 `500_000`）。

## 2.4 tester 断言点清单（**未改**，交 tester 复验轮按新契约重钉）

> 派单点名 `crates/web/tests/tester_p5_indep.rs`；复扫发现**另一个 tester 资产也会变红**（`tester_p5rect_verify.rs`），一并列出。
> 均为 tester 自有、未入 index 的资产，本批**未触碰**。

### A. `crates/web/tests/tester_p5_indep.rs`（硬断言 `200_000`）

| 行 | 断言/文案 | 新契约应改为 |
|---|---|---|
| L349 | `assert_eq!(application::error::GUARD_CONFIRM_BARS, 200_000);` | `500_000` |
| L508 | 文档串「≥200,000 ⇒ 400 `resource_guard`」 | ≥500,000 |
| L526-528 | 注释 + `mk(199_999)…expect("199_999 < 200_000 ⇒ 放行")` | 边界改 `mk(499_999)` |
| L532-533 | `mk(200_000)…expect("≥200_000 且无 confirm ⇒ 必须 400")` | `mk(500_000)` |
| L538 | `assert_eq!(s.detail["confirm_bars"], json!(200_000i64))` | `500_000` |
| L539 | `assert_eq!(s.detail["requested_bars"], json!(200_000i64))` | `500_000` |
| L547-548 | `mk(200_000)` + `confirm=true ⇒ 放行` | 边界改 `mk(500_000)` |
| L626 | HTTP：`v["error"]["detail"]["confirm_bars"] == 200_000` | `500_000` |
| L627 | HTTP：`requested_bars >= 200_000`（请求=518880 全历史≈77 万 ⇒ 仍触发） | `>= 500_000`（或保留 200_000 亦可过） |
| L581 | `estimate_secs(200_000) > estimate_secs(1_000)` | 符号式，**不变** |

### B. `crates/web/tests/tester_p5rect_verify.rs`（**偏移触发的静默变更**）

| 行 | 内容 | 影响 |
|---|---|---|
| L406-408 | `("runs/resource_guard(confirm=false)", … "518880" "M1" "2021-01-01"→"2026-01-01" …)`，期望码 `resource_guard` | 该区间 M1≈**29 万 bar**：旧口径（≥20 万）触发；新口径（≥50 万）**不再触发** ⇒ 该表项期望落空（应为 `201`/放行）。tester 需改用 ≥50 万 bar 的区间（如全历史）或改期望。 |
| L483-485 | 同上，`test-run` 路径 | 同上 |
| L556-584 | `confirm=true` ⇒ 提交 201 / 试算 200 | 仍成立（放行），但语义变为「本就无需确认」 |

### C. 前端 mock（dev-only，**无红测试**，列为未决项②）

- `web/src/api/mock.ts:469-470` 仍 `MOCK_MAX_BARS_GUARD=2_000_000` / `MOCK_GUARD_CONFIRM_BARS=200_000`；
  其注释自称「改名/改值必须同步本处」。但 `web/src/api/{mock.test.ts,tester_p5rect_mock_n2.test.ts}` 的
  `SpanSemantics` 类型**未绑定** `confirm_bars`/`max_bars_guard` ⇒ 不产生红。派单限定只改 `crates/application/src/{error.rs,workbench.rs}`，
  故**未改**前端，交由前端 owner/架构师裁定（见未决项②）。

---

## 3. 回归与影响分析

- `cargo test -p application`：**全绿**（§1.6，`15_application_full_suite_final.txt`）。
- **GitNexus 影响分析不可用**：CLI 报 `LadybugDB unavailable … Database file version: 43, Current build storage version: 40`
  （索引 DB 版本不一致，非本批可修复）。按 AGENTS.md「`UNKNOWN` 不是 all-clear」条款，改用**文本清点**：

| 符号 | 直接调用点（文本清点） | 风险 |
|---|---|---|
| `application::error::guard_bars` | `workbench.rs:546,636`（submit 校验）、`strategy.rs:797,856`（试算校验） | 4 点**全部以常量符号**取值 ⇒ 阈值语义随契约一致变更；无旁路 |
| `GUARD_CONFIRM_BARS` / `MAX_BARS_GUARD` | 生产：`error.rs`、`workbench.rs`（re-export）、`strategy.rs`（文档）；测试：`workbench.rs`、`resource_guard_contract_vectors.rs` | 应用层内自洽；跨层硬编码仅 tester 资产（§2.4） |
| `execute_run`（私有） | 仅 `workbench.rs:732`（submit 的 spawn） | 私有函数，改动不外溢 |
| `WorkbenchService::submit`/`test_run` 的进度路径 | 仅经 `execute_run` 的 report 任务 | 行为变更仅「落库频率」+「终态补写」 |

- 未新增依赖、未改端口/接口/schema/迁移；`design/16-backtest-scalability/**` 与 `docker-compose.yml`
  的工作区改动属架构师（本批未 add、未改）。

## 4. 未决项（交架构师/后续轮）

1. **取消路径的「最终进度落库」与既有状态守卫的张力**（§1.2 注）：外部 `cancel()` 先赢下 `mark_canceled` 时，
   排水补写命中 `store.update_progress` 的 `status='running'` 守卫成为 no-op（DB `progress` 停在取消前最后一次节流写）。
   本批**未**改该守卫（派单未授权、且非节流问题）。若要求「取消 run 的 DB `progress` 必须等于取消瞬间的最终帧」，
   需架构裁决：① 允许 `mark_canceled`/`mark_failed` 同事务写入当时进度；或 ② 取消改为「只置内存标记，DB 迁移交给引擎排水后」；
   或 ③ 接受现状（写调用不被节流吞掉，守卫语义保持）。
2. **前端 mock 镜像漂移**：`web/src/api/mock.ts` 仍 `200_000`（无红测试绑定）。是否同步为 `500_000`，或给 mock 也加
   `confirm_bars` 向量绑定断言，请架构师裁定（前端属本批非目标）。
3. **`crates/web/tests/tester_p5rect_verify.rs` 的区间期望**（§2.4-B）需 tester 复验轮按新契约重钉。
4. **`RUN_FIXED_SECS = 0.85`** 的预估算子固定项：基于「1003 次写库」的旧事实；节流后每 run 固定写库降至个位数，
   ADR D1 要求「P4b 之后重做标定」——本批未改（属后续轮）。

---

## 5. 证据文件清单（`coder/evidence/adr024_p4b_fix/`）

| 文件 | 内容 |
|---|---|
| `01_red_confirm_bars_binding.txt` / `02_green_confirm_bars_binding.txt` / `03_reverse_confirm_bars_red.txt` | 任务二 向量绑定 红 / 绿 / 反向红 |
| `04_red_throttle_tests.txt` / `05_green_throttle_tests.txt` | 任务一 节流测试 红 / 绿 |
| `06_green_self_consistency.txt` | `p4b_run_summary_counters_are_self_consistent` 绿（新契约） |
| `07_application_full_suite.txt` / `15_application_full_suite_final.txt` | `cargo test -p application` 全绿（终稿） |
| `08_reverse_throttle_off_red.txt` / `09_reverse_no_flush_red.txt` | 反向证据（关节流 / 去补写） |
| `10_before_probe_console.txt` / `11_before_summary_table.txt` | 真路径 before（未节流二进制） |
| `12_after_probe_console.txt` / `13_after_summary_table.txt` | 真路径 after（本批二进制） |
| `14_realpath_cancel_terminal_progress.txt` | 真路径取消：末帧落库验证 |
| `16_tmpdb_teardown.txt` | 临时库 teardown（库清单 `eestock,postgres`） |
| `17_before_after_table.txt` | 前后对照汇总表（程序生成） |
| `18_terminal_write_three_paths.txt` | 终态必写三路径（`--nocapture`） |
| `probe_p4bfix.sh` / `extract_summary.py` / `before_raw.txt` / `after_raw.txt` | 探针脚本与原始汇总 |

---

## 6. 交付物与暂存（仅 `git add`，无 `git commit`）

暂存文件（其余 index 内容为本仓既有 ADR-024 工作，未由本轮改动）：

```
crates/application/src/error.rs
crates/application/src/workbench.rs
crates/application/tests/workbench.rs
crates/application/tests/resource_guard_contract_vectors.rs
coder/report/adr024_p4b_fix_and_confirm_threshold.md
coder/evidence/adr024_p4b_fix/*
```

**未 add / 未改**：`design/16-backtest-scalability/**`（架构师）、`docker-compose.yml`、
`crates/web/tests/tester_*.rs`（tester）、`web/src/api/mock.ts`（前端）、任何结果分块/端点/schema 文件。
