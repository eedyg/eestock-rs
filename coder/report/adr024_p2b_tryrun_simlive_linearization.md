# ADR-024 P2b —— 试算 / sim-live 路径线性化（同源二次项收尾；P5 硬前置）交付报告

- **本报告自身路径**：`coder/report/adr024_p2b_tryrun_simlive_linearization.md`
- **证据目录（全部原始输出）**：`coder/evidence/adr024_p2b/`（27 个文件：红/绿/反向/前后对照/断言输出）
- 任务口径：`design/16-backtest-scalability/04-implementation-plan.md` §2「P2b」+ 附带项；
  `design/16-backtest-scalability/01-adr.md` **D7 修订**（残留调用点）；
  tester P2 验收 `tester/report/adr024_p2_verification.md` §9 **R2**（发现来源）/ **O1**（语义裁定）。
- 复用 P2 模式：`strategy-runtime::BarHistory` + `BarCtx::with_history`（见 `coder/report/adr024_p2_engine_linearization.md`）。
- 状态：**实现完成 + 自测全绿 + 已 `git add`（未 commit）**。

---

## 0. 一句话结论

| 项 | 改造前（HEAD + 已 staged 的 P0/P2；`M1` 口径） | 改造后（本批） |
|---|---|---|
| **试算路径**（`strategy.rs` pure_score）每 bar 分配 | n=2000 **50,522.8 B/bar** → n=4000 **98,518.0 B/bar**（比 **1.950**） | n=2000 **855.5** → n=4000 **850.4**（比 **0.994**） |
| **sim-live 路径**（`plugin_orchestrator`）每 bar 分配 | n=2000 **50,727.5 B/bar** → n=4000 **98,726.5 B/bar**（比 **1.946**） | n=2000 **1,060.2** → n=4000 **1,058.8**（比 **0.999**） |
| 墙钟（同核，debug 判据口径）n=2000 → 4000 | 试算 **544.9 → 2,094.9 ms**（比 3.845）/ sim-live **544.7 → 2,097.5 ms**（比 3.851） | 试算 **33.6 → 65.9 ms**（比 1.965）/ sim-live **34.0 → 67.5 ms**（比 1.986） |
| 「可读未来」面 | 试算路径 `ctx.bars` = **全量入参切片（含未来 bar）**；sim-live 已是前缀但每 bar 复制 | 两处 **`bars_len == index+1` 全行成立、`ahead_visible` 全 false、共享句柄跨 bar 恒等** |
| 行为 | — | **逐位不变**：定向等价测试（新路径 vs 改造前口径复刻）逐 bar `to_bits()` 相同；既有测试全绿 |
| 对外契约 | — | **零变更**：`test_run` / `feed_bar` 签名未动；JS `ctx` 暴露面未变（不注入 `bars`）；DB schema / 落库 / 结果 API / 区间护栏常量 / sim-live 业务逻辑 未动 |

n=4000 端到端墙钟：**试算 2,094.9 → 65.9 ms（31.8×）**、**sim-live 2,097.5 → 67.5 ms（31.1×）**；
每 bar 分配 **−98.3%（试算）/ −97.9%（sim-live）**，且**不再随 index 增长**。

---

## 1. 改动文件清单（含分层归属）与红→绿原始输出

### 1.1 文件清单

| 文件 | 层 | 改动 | 为何属于该层 |
|---|---|---|---|
| `crates/application/src/strategy.rs` | application（用例编排；试算入口 `StrategyService::test_run` 同层） | **+116 / −2**：新增私有 `tryrun_bar_ctx()`（收窄 `ctx.bars` 为前缀 + 注入共享句柄）；`run_pure_score` 持有 `Rc<BarHistory>` 并逐 bar `push`；新增 `#[cfg(test)] mod p2b_tests` 定向单测 | 试算逐 bar 评分循环是 **application 用例层**职责（引擎/ABI 均在依赖内层，反向改动会破坏分层）；`BarHistory`/`BarCtx` 是 `strategy-runtime` 的**已有**公开件，此处仅**使用**不修改 |
| `crates/simlive/src/plugin_orchestrator.rs` | sim-live（L1 纯逻辑编排器） | **+28 / −12**：私有字段 `bars: BTreeMap<String, Vec<Bar>>` → `BTreeMap<String, Rc<BarHistory>>`；`feed_bar` 改为向共享缓冲 `push`；`evaluate` 取句柄 + `with_slice` 构建前缀 ctx 并 `with_history` | 编排器持有该标的的**累计行情**（原为 `Vec<Bar>`）是其自有状态；缓冲句柄注入属"喂数据给插件"的实现细节，**不进** session/fill/account 业务逻辑 |
| `crates/application/tests/adr024_p2b_tryrun.rs`（新） | 测试 | +362：等价性（新旧路径逐 bar 位级）+ 分配量/墙钟（计数分配器，独立测试二进制） | — |
| `crates/simlive/tests/adr024_p2b_orchestrator.rs`（新） | 测试 | +326：`ctx.bars` 可见面探针（注入探针 `PluginRuntime`）+ 等价性 + 分配量/墙钟 | — |
| `coder/evidence/adr024_p2b/**` | 证据 | 27 个原始输出（红/绿/反向/前后对照/断言输出/门禁） | — |

**未改动（按要求）**：`design/16-backtest-scalability/**`（架构师所有）、`docker-compose.yml`、DB schema / `migrations/**`、
落库与结果 API（`storage/**`、`web/**`、`mcp/**`）、**区间护栏常量**（`D1_MAX_SPAN_DAYS` / `MINUTE_MAX_SPAN_DAYS` / `MAX_SCORE_POINTS` / `MAX_BARS` 一字未改）、
sim-live 业务逻辑（`session.rs` / `fill.rs` / `account.rs` / `strategy_orchestrator.rs` 未动）、
**`strategy-runtime` / `strategy-core` / `backtest`（P2 交付层）一行未改**（本批只**调用**其既有公开 API）。

### 1.2 试算路径 —— 红 → 绿

**红 1（行为断言：每 bar 分配随 index 增长）** `coder/evidence/adr024_p2b/02_red_tryrun.txt`：

```
$ cargo test -p application --test adr024_p2b_tryrun -- --nocapture --test-threads=1
P2b-tryrun alloc/bar（bytes）: n=2000 50474.7 → n=4000 98470.0 (ratio=1.951)
thread '...' panicked at crates/application/tests/adr024_p2b_tryrun.rs:352:5:
每 bar 分配字节不得随 index 增长：n=2000 50474.7 B/bar vs n=4000 98470.0 B/bar
（ratio=1.951；改造前每 bar 复制 bars[..=index] 使该比值 ≈2.0）
test result: FAILED. 1 passed; 1 failed
```

**红 2（附带项断言：前缀 / 共享句柄）** `coder/evidence/adr024_p2b/03_red_tryrun_prefix.txt`：

```
$ cargo test -p application --lib p2b
error[E0425]: cannot find function `tryrun_bar_ctx` in this scope       (×2)
error[E0433]: cannot find type `BarHistory` in this scope                (×2)
error: could not compile `application` (lib test) due to 4 previous errors
```

> 说明：红 2 是**编译期红**（被测构造点尚不存在）。为避免"仅编译期红"的说服力不足，另给了**行为级红**：
> ① 见上红 1（同一路径的真实分配量断言）；② 见 §5 反向证据 `10_`（把 helper 退回全量切片 ⇒ 前缀断言**运行期变红**）。

**绿** `coder/evidence/adr024_p2b/04_green_tryrun.txt` / `14_green_tryrun_wall.txt`：

```
$ cargo test -p application --test adr024_p2b_tryrun -- --nocapture --test-threads=1
running 2 tests
test tryrun_per_bar_allocation_does_not_grow_with_index ... P2b-tryrun alloc/bar（bytes）: n=2000 855.5 → n=4000 850.4 (ratio=0.994)
P2b-tryrun wall（ms）: n=2000 33.6 → n=4000 65.9 (ratio=1.965)
ok
test tryrun_pure_score_bitwise_equal_to_compat_path ... ok
test result: ok. 2 passed; 0 failed

$ cargo test -p application --lib p2b -- --nocapture      # 23_assert_bars_len_prefix_tryrun.txt
test strategy::p2b_tests::tryrun_bar_ctx_narrows_to_prefix_and_shares_history ... ok
test result: ok. 1 passed; 0 failed
```

### 1.3 sim-live 路径 —— 红 → 绿

**红 1（行为断言：共享句柄未注入 = 兼容路径）** + **红 2（分配量）** `coder/evidence/adr024_p2b/01_red_simlive.txt`：

```
$ cargo test -p simlive --test adr024_p2b_orchestrator -- --nocapture --test-threads=1
test orchestrator_ctx_bars_is_prefix_shared_and_has_no_future ...
bar 0: 必须注入共享历史缓冲句柄（兼容路径每 bar 复制 bars[..=index]）   FAILED
test orchestrator_per_bar_allocation_does_not_grow_with_index ...
P2b-simlive alloc/bar（bytes）: n=2000 50727.4 → n=4000 98726.4 (ratio=1.946)   FAILED
test orchestrator_scores_bitwise_equal_to_compat_path ... ok
test result: FAILED. 1 passed; 2 failed
```

**绿** `coder/evidence/adr024_p2b/05_green_simlive.txt` / `24_assert_bars_len_prefix_simlive.txt`：

```
$ cargo test -p simlive --test adr024_p2b_orchestrator -- --nocapture --test-threads=1
test orchestrator_ctx_bars_is_prefix_shared_and_has_no_future ... [P2b/sim-live] ctx.bars 可见面探针：rows=20 违例=0
  idx=0 bars_len=1 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true history_ptr=0x710f040018d0
  idx=1 bars_len=2 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true history_ptr=0x710f040018d0
  idx=2 bars_len=3 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true history_ptr=0x710f040018d0
  共享句柄身份跨 bar 恒等 = true
ok
test orchestrator_per_bar_allocation_does_not_grow_with_index ... P2b-simlive alloc/bar（bytes）: n=2000 1060.2 → n=4000 1058.8 (ratio=0.999)
P2b-simlive wall（ms）: n=2000 35.2 → n=4000 67.4 (ratio=1.914)
ok
test orchestrator_scores_bitwise_equal_to_compat_path ... ok
test result: ok. 3 passed; 0 failed
```

---

## 2. 等价性证据（**逐位不变**）

### 2.1 判据（两处路径各一条定向测试）

| 路径 | 测试（文件） | 判据 |
|---|---|---|
| 试算 | `tryrun_pure_score_bitwise_equal_to_compat_path`（`crates/application/tests/adr024_p2b_tryrun.rs`） | 新路径 = **真实公开入口** `StrategyService::test_run{PureScore}`；参照 = **改造前口径复刻**（同一限额、同一 bar 序列、`BarCtx::new(i, bar, &bars, None)` 每 bar 传全量切片的兼容路径）。逐 bar `score.to_bits()` 相等 + `ts` 相等 |
| sim-live | `orchestrator_scores_bitwise_equal_to_compat_path`（`crates/simlive/tests/adr024_p2b_orchestrator.rs`） | 新路径 = 真实 `PluginStrategyOrchestrator::with_quickjs` + `feed_bar`；参照 = 改造前口径复刻（累计 `Vec<Bar>` + 每 bar `BarCtx::new(idx, bar, &accumulated, None)`）。逐 bar `score.to_bits()` 相等 |

两处都用**全指标插件**（每 bar 调 `ma(20)/ema(20)/rsi(14)/macd/kdj/boll(20,2)/atr(14)` + 数据不足返回 50 的预热段），
覆盖增量状态（`OnlineIndicators`）与 `from_bars`→`push` 两条语义等价链；**非恒定**序列（LCG 驱动）保证取值有鉴别力。

输出（`04_green_tryrun.txt` / `05_green_simlive.txt`）：两测 `ok`（400 bar × 7 指标逐位相等，无容差）。

### 2.2 既有测试全绿（回归）

| 命令 | 结果 | 证据 |
|---|---|---|
| `cargo test -p application --no-fail-fast` | **146 passed / 0 failed**（改造前 143 ⇒ +3 = 本批新增 2 集成 + 1 单测） | `18_green_application_all_final.txt` |
| `cargo test -p simlive --no-fail-fast` | **43 passed / 0 failed**（改造前 40 ⇒ +3 集成） | `21_green_simlive_all_final.txt` |
| `cargo test -p backtest -p strategy-runtime -p strategy-core --no-fail-fast` | **全 test target ok / 0 failed**（P2 层未受影响） | `27_green_p2_layer_crates.txt` |
| `cargo check --workspace --all-targets` | 0 error / 0 warning | `19_workspace_check_all_targets.txt` |
| `cargo clippy -p simlive -p application --all-targets` | 本批新增代码 **0 warning**；仅剩 1 条**改造前既有**告警（`strategy.rs:1025` `fee.clone()` on `Copy`，已核对 index 版第 1002 行同款） | `20_clippy.txt` |
| `bash scripts/check-tangle.sh` | `✅ design 与生成物一致`（本批未触碰 design） | `25_tangle_check.txt` |

> `application` 的 146 项含 `test_run` 双模式全部既有用例（`test_run_pure_score_inline_code`、
> `test_run_pure_score_defaults_fill_and_neutral_on_error`（含 G5 熔断 10 次 + 后续 `score=None`）、
> `test_run_interval_limits`、`test_run_sim_position_produces_signals_and_trade` 等）⇒ **试算对外契约与错误语义未漂移**。

### 2.3 既有调用方（sim-live 上层）零改动

`crates/application/src/simlive_orch.rs`（编排器 worker 承载，`spawn_orchestrator*`）**未改一行**，
其单测与 `application/tests/simlive.rs`（55 项）全绿（`18_green_application_all_final.txt`）——
`PluginStrategyOrchestrator` 的公开签名（`new` / `with_quickjs` / `feed_bar` / `take_events` / `latest_evaluation` / `configs` …）**零变更**。

---

## 3. 分配量 / 墙钟前后对照（这两条路径）

计数分配器口径（`#[global_allocator]` 包装 `System`，累计 `alloc+realloc` 字节；两个测试二进制内各测**互斥串行**，
测量窗口内含 `spawn_blocking` 评分线程 ⇒ 计数完整）；夹具构造在窗口外。n 为同一次运行的 bar 数（**M1 口径**，纯内核算力口径，**不得**与生产端到端口径互比）。

| 路径 | n | 改造前 alloc/bar（B） | 改造后 alloc/bar（B） | 改造前墙钟（ms） | 改造后墙钟（ms） |
|---|---|---|---|---|---|
| 试算 `pure_score` | 2,000 | 50,522.8 | **855.5** | 544.9 | **33.6** |
| 试算 `pure_score` | 4,000 | 98,518.0 | **850.4** | 2,094.9 | **65.9** |
| sim-live `feed_bar` | 2,000 | 50,727.5 | **1,060.2** | 544.7 | **35.2** |
| sim-live `feed_bar` | 4,000 | 98,726.5 | **1,058.8** | 2,097.5 | **67.4** |

| 比值（n 翻倍） | 试算 pre | 试算 post | sim-live pre | sim-live post |
|---|---|---|---|---|
| alloc/bar（4,000 ÷ 2,000） | **1.950**（二次） | **0.994**（常数） | **1.946**（二次） | **0.999**（常数） |
| 墙钟 | **3.845** | **1.965** | **3.851** | **1.914 / 1.986**（两次运行） |

- 每 bar 分配字节降幅：试算 **−98.3%**（50,522.8 → 855.5 B/bar）、sim-live **−97.9%**（50,727.5 → 1,060.2 B/bar）；
- 关键判据是**比值**（不随 index 增长），而非绝对字节（绝对量含 QuickJS `ctx` 对象等常数项）。
- 改造前数据来源：**把两处目标代码临时退回改造前调用形态**（`BarCtx::new(..., bars, None)` 全量切片 + 不注入共享句柄）
  后重跑同一判据 —— `16_pre_state_tryrun_full.txt` / `17_pre_state_simlive_full.txt`；改造后数据：`14_` / `24_`。
- 顺带一致：P2 引擎路径（`session_alloc`）为 947.3 → 944.6 B/bar（比 0.997），本批两条路径落到 **850–1,060 B/bar** 同量级，
  说明同源二次项（历史复制 + 指标 O(index) 回放）在这两条路径上同样被消除。

---

## 4. 「可读未来」面消除的证据（`bars_len == index+1`）

### 4.1 目标路径的 `ctx.bars` 取值点（改造后均为前缀切片）

```
application/src/strategy.rs:861   BarCtx::new(index, bar.clone(), &bars[..=index], None).with_history(hist.clone())
simlive/src/plugin_orchestrator.rs:277   BarCtx::new(idx, latest_bar.clone(), bars, snapshot).with_history(history.clone())
                                         （`bars` = 共享缓冲的 `with_slice` 只读切片，长度天然 = idx+1）
```
（`coder/evidence/adr024_p2b/26_git_diff_targets.txt`）

### 4.2 断言输出（两处路径各一条探针/断言）

**sim-live（真实编排器 + 注入探针 `PluginRuntime`，全字段逐 bar 断言）** `24_assert_bars_len_prefix_simlive.txt`：

```
[P2b/sim-live] ctx.bars 可见面探针：rows=20 违例=0
  idx=0 bars_len=1 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true history_ptr=0x710f040018d0
  idx=1 bars_len=2 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true history_ptr=0x710f040018d0
  idx=2 bars_len=3 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true history_ptr=0x710f040018d0
  共享句柄身份跨 bar 恒等 = true
```
断言：`bars_len == index+1`（全 20 行）、`cur_eq_ctx_bar`（全 true，`bars[index] == ctx.bar`）、
`ahead_visible = bars.len() > index+1`（**全 false**）、`shared_handle`（全 true）、`history_ptr` 跨 bar **恒等**（同一缓冲复用 ⇒ 零复制）。

**试算（`tryrun_bar_ctx` 构造点，每 bar 一行）** `23_assert_bars_len_prefix_tryrun.txt`：

```
[P2b/tryrun] ctx.bars 可见面（n=8）：
  idx=0 bars_len=1 cur_eq_ctx_bar=true shared_handle=true
  ... （idx=7 bars_len=8 cur_eq_ctx_bar=true shared_handle=true）
test strategy::p2b_tests::tryrun_bar_ctx_narrows_to_prefix_and_shares_history ... ok
```
该断言的输入**故意是"全量 bars（含未来 bar）"** ⇒ 断言检验的正是"helper 把入参收窄为前缀"，**不是恒真**（见 §5 `10_`）。

### 4.3 「无 `index` 之外访问」的全仓枚举

`coder/evidence/adr024_p2b/22_no_future_surface.txt`：

```
$ grep -rn --include=*.rs --exclude-dir=target,node_modules,.git,data \
    -E 'bars\[[^]]*(index|idx)[^]]*\+|bars\.last\(\)|bars\[bars\.len\(\)' crates/
crates/tushare/src/bin/tushare_sync.rs:133:  ...bars.last()...        # 数据面（与插件 ctx 无关）
crates/storage/{src/reader.rs:246,tests/kline_reader.rs:792}: bars.last()  # 数据面
crates/application/tests/adr024_p2b_tryrun.rs:277: bars[bars.len()-1].ts    # 本批测试夹具

$ grep -rn --include=*.rs --exclude-dir=target,node_modules,.git,data -E 'ctx\.bars\.(get|iter|len|first|last)' crates/
crates/application/src/strategy.rs:1146:                ctx.bars.len(),        # ← 本批新增断言自身
crates/simlive/tests/adr024_p2b_orchestrator.rs:159-161: ...             # ← 本批新增探针自身
```
⇒ 目标路径下**除断言/探针外，仓内 0 处读取 `ctx.bars` 的 `index` 之外元素**；配合 §4.2 的 `ahead_visible=false`，
连同 P2 的引擎路径（tester §③-C 已独立实测），**宿主侧「可读未来」面在三条路径上均已消除**（D7 修订的遗留项收口）。

> 语义裁定对齐：本批采用 tester O1 / 架构师 D7 修订的裁定——宿主侧 `ctx.bars` = `bars[0..=index]`（前缀）。
> **JS 可观察 ABI 零变更**（`build_ctx_object` 不注入 `bars`），故 `design/12-strategy-system/02-plugin-abi.md` 无需改（与 P2 结论一致）。

---

## 5. 反向证据（人为退化 ⇒ 新断言必须变红 ⇒ 复原 ⇒ 绿）

| # | 人为退化（临时改生产代码，取证后已逐字复原） | 应变红的断言 | 实测 |
|---|---|---|---|
| R1 | sim-live：删 `.with_history(history.clone())`（退回"每 bar 复制 `bars[..=index]`"兼容路径） | 探针 `shared_handle` + 分配量比值 | **FAILED**：`bar 0: 必须注入共享历史缓冲句柄…`；alloc `50,727.5 → 98,726.5`（ratio **1.946**）（`08_reverse_simlive_no_history.txt`） |
| R2 | 试算：`tryrun_bar_ctx` 把 `&bars[..=index]` 退回 `bars`（**让 `ctx.bars` 暴露未来 bar** = 改造前口径） | 前缀断言 `ctx.bars.len() == index+1` | **FAILED**：`bar 0: 宿主侧 ctx.bars 必须恰为 bars[..=index]（P2b：无可读未来）  left: 8  right: 1`（`10_reverse_tryrun_expose_future.txt`） |
| R3 | 试算：删 `tryrun_bar_ctx` 的 `.with_history(...)`（退回兼容复制） | 前缀断言 + 分配量比值 | **FAILED**：`bar 0: 必须注入共享历史缓冲句柄…`（`11_`）；alloc `50,522.8 → 98,518.0`（ratio **1.950**）（`12_`） |

复原后复跑全绿：`09_restore_simlive_green.txt`（lib 40 + 集成 3，0 failed）、
`13_restore_tryrun_green.txt`（单测 1 + 集成 2，0 failed）；且 `diff` 复原文件与退化前副本**逐字节相同**（`RESTORE-EXACT`）。
等价性测试（§2.1）在退化态下**仍为绿**（它是对外行为守卫，不是机制判据）——这正说明三条判据分工不重叠：
**机制项由分配量/句柄断言把关，语义项由等价性测试把关**（与 tester R1 的建议一致）。

---

## 6. `git diff` 证明未触碰非目标文件

```
$ git diff --numstat -- crates/application/src/strategy.rs crates/simlive/src/plugin_orchestrator.rs
116  2   crates/application/src/strategy.rs
28   12  crates/simlive/src/plugin_orchestrator.rs
```
完整 diff 见 `coder/evidence/adr024_p2b/26_git_diff_targets.txt`。

> 读法说明：上表是**本批净改动**（`git diff` = worktree vs index；P0 的改动开工前已在 index 中）。
> 若看 `git diff --cached`（index vs HEAD），`crates/application/src/strategy.rs` 为 **122 / 6** = P0（**6 / 4**，M30/白名单，非本批）
> ＋ 本批（**116 / 2**）；`crates/simlive/src/plugin_orchestrator.rs` 本批前无 staged 改动（28 / 12 = 本批）。

`git status --short`（worktree vs index）中，本批**仅**新增/修改下列条目（其余均为**开工前既存**的 staged/unstaged/untracked 项：

```
MM crates/application/src/strategy.rs                    ← 本批（MM：index 为 P0 既有 staged + 本批 unstaged）
 M crates/simlive/src/plugin_orchestrator.rs             ← 本批
?? crates/application/tests/adr024_p2b_tryrun.rs         ← 本批
?? crates/simlive/tests/adr024_p2b_orchestrator.rs       ← 本批
?? coder/evidence/adr024_p2b/**                          ← 本批
?? coder/report/adr024_p2b_tryrun_simlive_linearization.md ← 本批
```
开工前既存、本批**未触碰**：`design/01-architecture/adr/ADR-023-*.md`、`design/99-decisions-log.md`、`docker-compose.yml`
（三者开工前即为 unstaged modified，见本报告 §7 备案；**未 `git add`**）。

`git add` 只加了本批 5 组路径（2 源文件 + 2 测试 + 证据 + 报告），**未 commit**。

---

## 7. 未决项与残余风险

### 7.1 范围裁定与升级点（**请架构师知悉，均无阻塞**）
1. **`evaluate` 的 `with_slice` 包裹**：sim-live 旧状态是 `Vec<Bar>`（既是"切片来源"又是"累计行情"）。
   若保留 `Vec<Bar>` 再并列加 `Rc<BarHistory>`，会**双份**累计行情（n×48 B ×2，sim-live 会话长期驻留 ⇒ 内存回退），
   故按 D7「各持 `Rc<BarHistory>`」改为**单一事实源**：`bars: BTreeMap<String, Rc<BarHistory>>`，
   切片需求走已公开的 `BarHistory::with_slice`（**只读借用**）。这是**私有字段 + 私有方法体**改动，
   未改任何公开签名/业务逻辑；包住 `on_bar` 的借用形态**与 P2 引擎会话路径完全一致**
   （`engine.rs:656` 亦是在 `shared.with_slice(|bars| …)` 内调用 `on_bar`）⇒ 无新增约束语义。
2. **试算侧新增私有 helper `tryrun_bar_ctx`**：仅为让"前缀 + 共享句柄"这一附带项**可断言**
   （否则该属性只能靠代码走查）。它是 `run_pure_score` 的唯一 ctx 构造点（单点可回归）。
3. **未改 `strategy-runtime`**：曾考虑在 `with_history` 内加 `debug_assert!(self.bars.len() == self.index+1)`
   以全局强制"无可读未来"，但 P2 的两个既有测试（`shared_history.rs:199/271`）与 tester 探针 `D1b`
   **刻意**构造"全量切片 + 共享句柄"用于反向对照 ⇒ 会破坏既有测试/复核资产。故**未加**，本批改用
   **调用点收窄 + 定向断言**达成同等效果（若架构师要求全局强制，请裁决后另立小批）。

### 7.2 残余风险
| ID | 风险 | 现状 | 缓解 |
|---|---|---|---|
| P2b-R1 | 插件在 `on_bar` 内**写**共享缓冲（`bctx.history().push(...)`）⇒ `RefCell` 借用冲突（panic） | 仓内 0 处此类实现（grep 已枚举）；JS 侧不可达（`ctx` 不注入 `bars`） | 与 P2 引擎路径**同风险同口径**（引擎会话同样在整个 `on_bar` 期间持只读借用）；JavaScipt ABI 无 `push` 面；`BarHistory::with_slice` rustdoc 已写明"不得在闭包内 push" |
| P2b-R2 | 内存：共享缓冲随 bar 数线性增长（n×48 B/run） | 试算与 sim-live 均**新增**该常驻缓冲；但**同时消除**了每 bar 的 O(index) 瞬时复制（峰值分配大幅下降） | 与 D7 明示代价一致（P2 已接受：M1 5 年 ≈14 MB）；sim-live 旧代码本就常驻全部累计 bar（同量级），**净内存不变**；试算为单次请求生命周期 |
| P2b-R3 | debug 断言（`with_history` 内 `history.len() == index+1` / 当前 bar 一致）在 **release 关闭** | 结构上由 `hist.push(bar.clone())` 每 bar 恰一次保证；`cargo test`（debug）全程激活 | 已随 PR 交付断言；如需 release 强制，需代价（O(1) 长度检查可用 `assert!`，请架构师裁决是否接受 release 开销） |
| P2b-R4 | 我的性能数字是**内核算力口径**（不含 jsonb 落库/进度帧/spawn_blocking 之外的生产 IO），n 只到 4,000 | 与 ADR §2.5/§2.6 教训一致，**不得**与生产端到端吞吐互比 | 权威规模曲线由 tester 按 `03-test-plan.md` §2 用 harness 覆核（本批范围外） |
| P2b-R5 | 本批 v1 的等价性测试规模为 400 bar（两处），未覆盖 warmup 段标记的位级比对 | `warmup_effective` 逻辑本批未改（试算 `run_pure_score` 只改了 ctx 构造 + push），既有 `test_run` 用例含 warmup 语义 | 若架构师要求，可在同一测试加 `warmup_bars>0` 的 `warmup` 标记逐 bar 比对（增量很小） |

### 7.3 备案（非本批引入、未处理）
- `design/01-architecture/adr/ADR-023-period-set-extension-30m.md`、`design/99-decisions-log.md`、`docker-compose.yml`
  在本批**开工前**即为 unstaged modified；按纪律**未纳入本批 `git add`**（tester P2 §10-T4 同类备案）。
- **GitNexus 不可用（原始输出已留档）**：`node .gitnexus/run.cjs impact "run_pure_score" --direction upstream --repo .`
  返回 `LadybugDB unavailable … Database file version: 43, Current build storage version: 40` 且 `risk: UNKNOWN`；
  `detect-changes --scope all` 亦以同错退出（`coder/evidence/adr024_p2b/28_gitnexus_unavailable.txt`）。
  按 AGENTS.md「`UNKNOWN` 不等于安全」的要求，**未把空调用方集当清白证据**；本批改动的**上游调用方枚举**改用文本级枚举 +
  全 workspace `cargo check --all-targets`：
  `tryrun_bar_ctx`（新私有，单调用点）→ `run_pure_score` → `StrategyService::test_run` → `web`/`mcp` 经既有公开签名（未变）；
  `PluginStrategyOrchestrator.bars`（私有字段）→ 仅本文件 `feed_bar`/`evaluate`；上层 `simlive_orch.rs` 未改且测试全绿。

---

## 8. 交付状态

- 已 `git add`（**未 commit**）：
  - 源码：`crates/application/src/strategy.rs`、`crates/simlive/src/plugin_orchestrator.rs`
  - 测试：`crates/application/tests/adr024_p2b_tryrun.rs`、`crates/simlive/tests/adr024_p2b_orchestrator.rs`
  - 证据：`coder/evidence/adr024_p2b/**`（27 个文件）
  - 报告：`coder/report/adr024_p2b_tryrun_simlive_linearization.md`（本文件）
- 净改动：2 个源文件 **+144 / −14**；2 个测试文件 **+688**。
- 未触碰：`design/16-backtest-scalability/**`、`docker-compose.yml`、`strategy-runtime` / `strategy-core` / `backtest`、
  `storage` / `web` / `mcp`、DB schema / `migrations/**`、区间护栏常量、sim-live 业务逻辑。
