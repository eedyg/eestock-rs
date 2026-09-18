# ADR-024 P2 —— 引擎线性化（会话化 + 共享缓冲 + 指标增量）交付报告

- 本报告自身路径：**`coder/report/adr024_p2_engine_linearization.md`**
- 证据目录（全部原始输出）：`coder/evidence/adr024_p2/`
- 任务口径：`design/16-backtest-scalability/04-implementation-plan.md` §2「P2 — 引擎线性化」+ P2 范围裁定；
  判据：`03-test-plan.md` §1（A/B/C 三层 + B′ 逐字段枚举）、§2.2（渐近斜率 + 三指纹）、P2 清单；
  决策：`01-adr.md` D5/D6/D7/D14。
- 状态：**实现完成 + 自测全绿 + 已 `git add`（未 commit）**。权威规模曲线与独立复核待 tester 跑（见 §5）。

---

## 0. 一句话结论

| 项 | 改造前（HEAD+已 staged 的 P0） | 改造后（本批） |
|---|---|---|
| M1 × 200k bar、1 slot、`dual_ma` 墙钟 | 14.87–16.29 s（tester §2.5） | **0.618 s**（25.2×） |
| M1 × 200k bar、1 slot、`indicator_heavy`（macd+rsi+atr 每 bar） | 239.7 s（tester §2.6） | **0.725 s**（330.6×） |
| `alloc_bytes` 随 n 翻倍的比值（4 个 n 点，两插件） | **3.97 / 3.98 / 3.99**（二次） | **1.99 / 2.00 / 2.02**（线性） |
| 渐近局部 log-log 斜率（50k→200k，两插件） | 1.878–1.900 / ≈2.0 | **0.961（dual_ma）/ 1.005（heavy）** ⇒ ∈[0.9,1.1] |
| 引擎每 bar 分配字节（n=2000 → 4000，指标混合插件） | 56,915.9 → 112,913.8 B/bar（比 1.984） | **947.3 → 944.6 B/bar（比 0.997）** |
| golden 11 用例 A/B/C + B′ + 台账 | PASS（dev=0） | **PASS（dev=0，逐字节相同的报告）** |
| 调用方（application/web/sim-live）改动 | — | **零改动**（逐文件 sha256 未变；application 143 测试全绿） |

---

## 1. 改动文件清单（含分层归属）与红→绿原始输出

### 1.1 文件清单

| 文件 | 层 | 改动 | 为何属于该层 |
|---|---|---|---|
| `crates/backtest/src/indicators.rs` | backtest（纯逻辑，L1 共享件） | +769 / −0：新增 `OnlineIndicators`（增量状态 `ema/rsi/macd/kdj/atr` 同序递推 + `ma/boll` 窗口直算）+ 8 个等价性单测。**旧切片视图 `Indicators` 一行未删**（保留为口径参考与对照） | 指标口径是 `backtest` 的既有职责（strategy-core / strategy-runtime / simlive 共用），无 IO/无 DB；放在别处会制造反向依赖 |
| `crates/backtest/src/lib.rs` | backtest | +1 / −1：re-export `OnlineIndicators` | 与既有 `Indicators` 同源导出 |
| `crates/strategy-runtime/src/history.rs`（新） | strategy-runtime（插件 ABI 实现） | +195：`BarHistory`（增长式共享缓冲 + 指标访问器） | 共享缓冲是**插件 ABI 的实现细节**（D7），必须与 `BarCtx`/`QuickJsInstance` 同层；不得放到 strategy-core（那会把引擎内部结构暴露给 ABI） |
| `crates/strategy-runtime/src/types.rs` | strategy-runtime | +47 / −10：`BarCtx` 增**私有** `history: Option<Rc<BarHistory>>` + `with_history()` / `shared_history()` / `history()`；文档澄清 `bars` 语义 | ABI 宿主侧上下文；`BarCtx::new` 签名与 `pub` 字段**未变**（新增私有字段对外不可见 ⇒ 非破坏性） |
| `crates/strategy-runtime/src/quickjs.rs` | strategy-runtime | +34 / −26：`build_indicators` 由「每 bar `bars[..=index].to_vec()`」改为「共享 `Rc<BarHistory>` 句柄」 | 根因锚点 `quickjs.rs:380`（ADR §2.2 行 1） |
| `crates/strategy-runtime/src/lib.rs` | strategy-runtime | +2：`pub mod history; pub use history::BarHistory;` | 模块导出 |
| `crates/strategy-core/src/engine.rs` | strategy-core（策略内核） | +430 / −302：新增 `EnsembleSession`（`new/set_total_hint/bars_seen/push/push_batch/records/drain_records/finish` + 私有 `step`，逐字搬运原循环体）；三个批式入口改为薄封装 | D5 会话化属引擎层；持仓/Policy/Trailing/插件实例常驻是引擎状态机职责 |
| `crates/strategy-core/src/lib.rs` | strategy-core | +4 / −2：re-export `EnsembleSession` + 顶层管线文档补 P2 说明 | 导出与文档 |
| `crates/strategy-core/tests/session.rs`（新） | 测试 | +320：会话等价（A 层）、分块喂入（1/2/3/5000）、取消语义、warmup 绝对口径、边界、期末强平、共享缓冲当前 bar 索引 | — |
| `crates/strategy-core/tests/session_alloc.rs`（新） | 测试 | +145：引擎每 bar 分配字节不随 index 增长（计数分配器，独立测试二进制） | — |
| `crates/strategy-runtime/tests/shared_history.rs`（新） | 测试 | +348：缓冲前缀语义 / `ctx.bars` 视图 / 边界 / 共享 vs 兼容路径位级一致 / 指标 wiring | — |
| `crates/strategy-runtime/tests/shared_history_alloc.rs`（新） | 测试 | +160：共享路径 vs 兼容路径每 bar 分配（含量化对照 + 敏感性对照） | — |
| `crates/strategy-runtime/tests/online_indicators_fixture.rs`（新） | 测试 | +238：**真实 golden fixture 序列**上的增量 vs 切片位级等价 + B′ 枚举 + C 层 | 放本 crate 的原因：`backtest` 无 dev-deps（不新增依赖），本 crate 已有 `serde_json` 读 `bars.jsonl` |
| `coder/evidence/adr024_p2/**` | 证据 | 30 个文件：全部红/绿/反向证据/测量原始输出 + 测量脚本 | — |

**未改动**（按要求）：`design/16-backtest-scalability/**`（架构师所有）、`design/12-strategy-system/02-plugin-abi.md`（JS `ctx` 暴露面未变 ⇒ 无需改）、插件 ABI 语义、`sim-live` 业务逻辑、落库/结果 API、区间护栏、`strategy_run` schema、`docker-compose.yml`、`crates/application/**`、`crates/web/**`（§4 有零改动证明）。

### 1.2 (B) 指标增量 —— 红→绿

**红**（`crates/backtest/src/indicators.rs` 追加 8 个测试后，`OnlineIndicators` 不存在）：

```
$ cargo test -p backtest --lib            # coder/evidence/adr024_p2/01_red_online_indicators.txt
error[E0433]: cannot find type `OnlineIndicators` in this scope
error: could not compile `backtest` (lib test) due to 9 previous errors
```

**绿**（`coder/evidence/adr024_p2/02_green_online_indicators.txt`）：

```
$ cargo test -p backtest --lib
test result: ok. 31 passed; 0 failed; 0 ignored
test indicators::tests::online_ma_matches_slice_view ... ok
test indicators::tests::online_ema_matches_slice_view ... ok
test indicators::tests::online_rsi_matches_slice_view ... ok
test indicators::tests::online_macd_matches_slice_view ... ok
test indicators::tests::online_kdj_matches_slice_view ... ok
test indicators::tests::online_boll_matches_slice_view ... ok
test indicators::tests::online_atr_matches_slice_view ... ok
test indicators::tests::online_handles_non_monotone_requests ... ok
test indicators::tests::online_out_of_range_index_is_none ... ok
```

覆盖：`i ∈ {period-1, period, 2×period, n-1}` + **全序列扫描**（600 根 × 每指标多组参数），
并以 `f64::to_bits()` 断言**位级相等**（强于 B 层容差）。

**真实 fixture 序列等价 + B′/C 层**（`coder/evidence/adr024_p2/12_green_indicator_fixture.txt`）：

```
$ cargo test -p strategy-runtime --test online_indicators_fixture -- --nocapture
[case] m1_1slot:  bars=1500 叶节点比较=22500 max_abs_dev=0.000e0 max_rel_dev=0.000e0
[case] m5_3slots: bars=1200 叶节点比较=18000 max_abs_dev=0.000e0 max_rel_dev=0.000e0
[case] h1_1slot:  bars=800  叶节点比较=12000 max_abs_dev=0.000e0 max_rel_dev=0.000e0
[汇总] cases=3 全局 max_abs_dev=0.000e0 全局 max_rel_dev=0.000e0 dev>0 条目=0
test result: ok. 1 passed; 0 failed
```

（fixture = `tester/evidence/240_adr024_golden_baseline/<case>/bars.jsonl`，只读引用，测试在文件缺失时打印 skip 而非硬依赖。）

### 1.3 (A) 共享缓冲 —— 红→绿

**红**（`coder/evidence/adr024_p2/05_red_shared_history.txt`）：

```
$ cargo test -p strategy-runtime --test shared_history --test shared_history_alloc
error[E0432]: unresolved import `strategy_runtime::BarHistory`
error[E0599]: no method named `with_history` found for struct `BarCtx<'a>` in the current scope   (×3)
error[E0599]: no method named `shared_history` found for struct `BarCtx<'a>` in the current scope (×1)
error: could not compile `strategy-runtime` (test "shared_history") due to 6 previous errors
error: could not compile `strategy-runtime` (test "shared_history_alloc") due to 2 previous errors
```

**绿**（`coder/evidence/adr024_p2/06_green_shared_history.txt`）：

```
test result: ok. 7 passed; 0 failed        # shared_history.rs
P2-shared-buffer alloc/bar（bytes）: 共享句柄 n=2000 575.2 → n=4000 575.6 (ratio=1.001)；
                                     兼容路径（改造前口径）n=2000 50242.6 → n=4000 98243.3 (ratio=1.955)
P2-shared-buffer alloc/bar（次数）: 共享句柄 17.99 → 18.00 (ratio=1.000)；兼容路径 24.99 → 25.00 (ratio=1.000)
test result: ok. 1 passed; 0 failed        # shared_history_alloc.rs
```

（「兼容路径」= `BarCtx::new`（试算/sim-live/单测）仍按 `bars[..=index]` 建一次性缓冲 ⇒ **保留改造前行为**，
同一条断言在其上必须变红 ⇒ 本测量有鉴别力；见 §4 反向证据 13c。）

### 1.4 (C) 引擎会话化 —— 红→绿

**红**（`coder/evidence/adr024_p2/04_red_session_equiv.txt`）：

```
$ cargo test -p strategy-core --test session
error[E0432]: unresolved import `strategy_core::EnsembleSession`
   |  ^^^^^^^^^^^^^^^ no `EnsembleSession` in the root
error: could not compile `strategy-core` (test "session") due to 1 previous error
```

**绿**（`coder/evidence/adr024_p2/07_green_session_equiv.txt`）：

```
$ cargo test -p strategy-core --test session
test session_push_matches_batch_entry_bitwise ... ok
test session_observer_called_per_bar_and_break_is_immediate ... ok
test session_chunked_feed_matches_single_feed ... ok
test session_handles_empty_single_and_warmup_overflow ... ok
test session_finish_force_closes_open_position ... ok
test session_shared_history_exposes_current_bar_to_plugin ... ok
test session_warmup_marker_is_exact ... ok
test result: ok. 7 passed; 0 failed
```

其中 `session_push_matches_batch_entry_bitwise` 用 `assert_eq!(got, expected)` 逐字段比较
`EnsembleResult`（per_bar/trades/net_value/drawdown/metrics）⇒ **A 层**。
`session_chunked_feed_matches_single_feed` 用 chunk ∈ {1, 2, 3, 5000（>总量）} 喂入（137 根，非整除）逐字段相等。

### 1.5 分配量断言（P2 清单「分配量不再随 index 线性增长」）—— 真断言级红→绿

**红**（改造前，`coder/evidence/adr024_p2/03_red_engine_alloc_flatness.txt`）：

```
$ cargo test -p strategy-core --test session_alloc -- --nocapture
P2-alloc: per_bar_bytes n=2000: 56915.9  n=4000: 112913.8  ratio=1.984
P2-alloc: per_bar_allocs n=2000: 23.24 n=4000: 23.23 ratio=0.999
thread 'engine_per_bar_allocation_does_not_grow_with_index' panicked at ...:
每 bar 分配字节不得随 index 增长：n=2000 56915.9 B/bar vs n=4000 112913.8 B/bar（ratio=1.984，改造前 O(index) 复制使该比值 ≈2.0）
test result: FAILED. 0 passed; 1 failed
```

**绿**（改造后，`coder/evidence/adr024_p2/08_green_engine_alloc.txt`）：

```
P2-alloc: per_bar_bytes n=2000: 947.3  n=4000: 944.6  ratio=0.997
P2-alloc: per_bar_allocs n=2000: 20.25 n=4000: 20.23 ratio=0.999
test engine_per_bar_allocation_does_not_grow_with_index ... ok
test result: ok. 1 passed; 0 failed
```

⇒ **量化前后**：每 bar 分配 **56,915.9 B/bar → 947.3 B/bar（−98.3%）**，且不再随 index 增长（比 1.984 → 0.997）。

### 1.6 取消语义（P2 清单「仍每 bar 生效」）

既有 `crates/strategy-core/tests/observer.rs`（6 测试）**未改一行**且全绿（`coder/evidence/adr024_p2/14_green_all_p2_crates.txt`）；
新增会话侧同型断言 `session_observer_called_per_bar_and_break_is_immediate`：
observer 调用序列必须恰为 `(0..=7, total)`（第 8 次回调后立即停止），Break ⇒ `EnsembleError::Canceled`（不产出结果）。
批式入口 `run_ensemble_with_quickjs_observed`（`application/src/workbench.rs:821`）签名与语义未变。

---

## 2. 性能自测（**非权威**，仅供架构师初筛；权威曲线由 tester 跑）

入口：与 tester 同 harness（`tester/harness/adr024_harness -- scale`，path 依赖 ⇒ 跑的就是当前工作树的生产引擎）。
脚本：`coder/evidence/adr024_p2/run_preflight.sh <pre|post>`；原始输出 `pre_scale.txt` / `post_scale.txt` / `11_post_large_n.txt`；
汇总 `17_prepost_table.txt`。

### 2.1 小 n 矩阵（每点 3 次取中位）

| series | n | slots | pre 墙钟 s | post 墙钟 s | 加速 | pre alloc_bytes | post alloc_bytes | 比 |
|---|---|---|---|---|---|---|---|---|
| dual_ma | 2,000 | 1 | 0.008 | 0.007 | 1.1× | 97,454,537 | 1,526,202 | 64× |
| dual_ma | 4,000 | 1 | 0.019 | 0.013 | 1.5× | 386,906,889 | 3,047,162 | 127× |
| dual_ma | 8,000 | 1 | 0.044 | 0.026 | 1.7× | 1,541,810,953 | 6,088,442 | 253× |
| dual_ma | 16,000 | 1 | 0.139 | 0.053 | 2.6× | 6,155,746,505 | 12,298,426 | 501× |
| dual_ma | 8,000 | 3 | 0.132 | 0.077 | 1.7× | 4,621,891,819 | 13,151,214 | 351× |
| indicator_heavy | 2,000 | 1 | 0.032 | 0.007 | 4.6× | 113,414,977 | 1,478,575 | 77× |
| indicator_heavy | 4,000 | 1 | 0.107 | 0.014 | 7.6× | 450,821,697 | 2,945,903 | 153× |
| indicator_heavy | 8,000 | 1 | 0.401 | 0.028 | 14.3× | 1,797,637,889 | 5,883,311 | 306× |
| indicator_heavy | 16,000 | 1 | 1.559 | 0.057 | 27.4× | 7,179,262,081 | 11,749,935 | 611× |
| indicator_heavy | 8,000 | 3 | 1.200 | 0.085 | 14.1× | 5,389,777,747 | 12,939,349 | 417× |
| constant_score（隔离探针） | 8,000 | 1 | 0.040 | 0.021 | 1.9× | 1,541,572,151 | 5,847,438 | 264× |

### 2.2 大 n 点（post 实测；pre 引用 tester 冻结实测）

| 点 | pre 墙钟 | post 墙钟 | 加速 | pre alloc_bytes | post alloc_bytes | post 峰值 RSS |
|---|---|---|---|---|---|---|
| dual_ma n=50,000 s1 | 1.127 s | **0.163 s** | 6.9× | 60,036,500,041 | 39,594,554 | 25.0 MB |
| dual_ma n=200,000 s1 | 15.584 s | **0.618 s** | 25.2× | 960,142,197,641 | 154,566,522 | 75.5 MB |
| heavy n=50,000 s1 | 14.99 s | **0.180 s** | 83.3× | （未记，见 §2.6） | 38,088,623 | 25.1 MB |
| heavy n=200,000 s1 | 239.7 s | **0.725 s** | 330.6× | （§2.6 记 1,120 GB） | 152,350,959 | 66.0 MB |

### 2.3 「二次项消失」三指纹（coder 初筛版）

1. **渐近局部斜率**（50k→200k）：`dual_ma` **0.961**、`indicator_heavy` **1.005** ⇒ 均 ∈ [0.9, 1.1]（改造前 1.878–1.900 / ≈2.0）。
2. **`alloc_bytes` 两点比**（n 翻倍）：
   - pre：`dual_ma` 3.97 / 3.98 / 3.99，`heavy` 3.97 / 3.99 / 3.99 ⇒ 二次；
   - post：`dual_ma` 2.00 / 2.00 / 2.02，`heavy` 1.99 / 2.00 / 2.00 ⇒ **线性**。
3. **峰值 RSS**：小 n 与改造前一致（22.7–23.4 MB）；200k 由 60–61 MB 升到 66–75.5 MB（**+5～15 MB**，
   与 ADR D7 明示的「内存代价 = n × 48 B ≈ 9.6 MB/200k」一致，属预期而非回退）。

---

## 3. 等价性自测报告（A/B/C 三层）

### 3.1 golden 11 用例（A/B/C + B′ + 持仓台账）

```
$ CARGO_TARGET_DIR=$PWD/target cargo run --offline --release --quiet \
    --manifest-path tester/harness/adr024_harness/Cargo.toml -- \
    compare --baseline tester/evidence/240_adr024_golden_baseline \
    --out coder/evidence/adr024_p2/10_golden_post.txt
...
m1_1slot_stop               3000   19324   13030      0.000e0      0.000e0       0      20020      PASS  A/B PASS
m1_3slots                   1500   14334   10790      0.000e0      0.000e0       0      12036      PASS  A/B PASS
A/B 层：11 用例，失败 0 用例
全局 max_abs_dev = 0.000000e0 ； 全局 max_rel_dev = 0.000000e0
C 层偏差-规模 log-log 斜率 = n/a（全部 dev==0，无规模依赖）→ PASS
持仓台账：bitwise FAIL 0 用例 / 自证 FAIL 0 用例 / 自证 dev>0 条目 0
== VERDICT: PASS ==
```

- **B′ 层**：11 例均「无 dev>0 条目（逐位相等）」⇒ 无被聚合值掩盖的偏差。
- 改造前后**同一比对器同一参数**的报告逐字节相同（sha256 `5c181bf2…`，见 `19_golden_pre_vs_post_same.txt`）。
- **注意（时间序）**：`m1_1slot_stop`（3000 bar、warmup=30、ATR(2.0) Intrabar 含真实止损成交）
  覆盖了**引擎自用 ATR(14) 止损线**（改用增量状态）与 warmup 段，19,324 个 A 层检查 + 20,020 个台账检查位级 PASS。

### 3.2 每个指标的偏差（abs/rel）——**逐项零偏差**

| 指标 | 用例/规模 | 比较叶节点数 | max abs dev | max rel dev | 层 |
|---|---|---|---|---|---|
| `ma(5)/ma(20)` | golden 3 例（1500/1200/800 bar 全下标） | 10,500 | 0.0 | 0.0 | **A（位级）** |
| `ema(12)/ema(26)` | 同上 | 10,500 | 0.0 | 0.0 | **A** |
| `rsi(6)/rsi(14)` | 同上 | 10,500 | 0.0 | 0.0 | **A** |
| `macd(12,26,9).{dif,dea,hist}` | 同上 | 15,750 | 0.0 | 0.0 | **A** |
| `kdj(9,3,3).{k,j}` | 同上 | 10,500 | 0.0 | 0.0 | **A** |
| `boll(20,2.0).{mid,upper}` | 同上 | 10,500 | 0.0 | 0.0 | **A** |
| `atr(2)/atr(14)` | 同上 | 10,500 | 0.0 | 0.0 | **A** |

**`ma` 偏差实值与「是否随 n 增长」**：`ma` **未采用滑动和（running sum）**，仍按窗口直接求和
（`Indicators::ma` 本就是 O(period) 窗口和）⇒ **abs = rel = 0（位级一致），且不随 n 增长**。
因此「`ma` 允许 B 层容差」这一许可在本实现中**未被使用**——理由：running sum 会改变求和顺序，
其误差在长序列上随 n 累积（O(n·eps·Σ)），正是 `03-test-plan.md` §1.1 **C 层禁止项**（偏差随 n 增长）
最典型的触发方式；用 O(window) 直算既满足「每 bar 取值 O(window) 而非 O(index)」的性能目标，
又把 `ma`/`boll` 保持在 A 层。**若架构师要求 running sum，我会先回报再改**（它是 B 层 + 需附 n-增长
实测的取舍）。

### 3.3 引擎会话化等价（A 层）

- 会话 `push` 逐 bar vs 既有批式入口：`EnsembleResult` 逐字段相等（3 slot：dual_ma + macd + kdj，w=1.0/0.5/1.5，
  ATR Intrabar 止损 + warmup=30，600 根真实量级序列）。
- 分块喂入（1/2/3/5000）vs 一次性：逐字段相等（137 根，非整除）。
- 边界：0 根、1 根、warmup ≥ 总根数、期末强平 —— 逐字段相等 + 绝对口径断言（warmup 标记根数 = min(warmup, n)、
  warmup 段不产订单、净值序列仅含 in-range）。
- `ctx.bars` 前缀语义与共享缓冲注入：插件返回 `ctx.indicators.ma(1)` ⇒ 逐 bar 位级等于**当前 bar 收盘价**
  （若缓冲错位/丢当前 bar 必然变红）。

### 3.4 反向证据（人为破坏 ⇒ 必须变红；原始输出在 `coder/evidence/adr024_p2/13*_reverse_*.txt`）

| # | 人为破坏 | 必须变红的断言 | 实测 |
|---|---|---|---|
| 13a | `RsiState` 递推分母 `period` → `period-1` | `online_rsi_matches_slice_view` + golden fixture 等价测试 | `FAILED`：`rsi(3) @i=6: 位级不一致 got=66.233766233766 want=77.73019271948596` |
| 13b | `BarCtx::history()` 共享句柄只到 `index-1` | `shared_history_scores_bitwise_equal_to_compat_path` | `FAILED`：`bar 19: 共享缓冲路径 50.0 与兼容路径 68.51890308337977 位级不一致` |
| 13c | `EnsembleSession::step` 去掉 `.with_history(...)`（退回每 bar 复制） | `session_alloc::engine_per_bar_allocation_does_not_grow_with_index` | `FAILED`：`ratio=1.948`（947 B/bar 路径失效 ⇒ 立即回到 ≈2.0 增长） |
| 13d | 会话 `is_warmup = i < warmup_bars` → `<=`（off-by-one） | `session_warmup_marker_is_exact` + 既有 12 个引擎测试 | `FAILED`（新增绝对口径断言捕获；既有 `tests/engine.rs` 12 处亦红） |
| 13e | `BarHistory::ma` 窗口错位到前一根 | `bar_history_indicators_match_slice_view` + `session_shared_history_exposes_current_bar_to_plugin` | `FAILED`：`bar 1: ma(1) 必须等于当前 bar 收盘价` |

每次破坏后均已**复原并复跑全绿**（同一证据文件内含恢复后的 green 行）。

### 3.5 其它门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 受影响 crate 全测试 | `cargo test -p backtest -p strategy-runtime -p strategy-core --no-fail-fast` | **18 个 test target 全 ok，0 failed**（`14_green_all_p2_crates.txt`） |
| 全 workspace 编译（含 application/web/mcp/simlive/app 及其测试） | `cargo check --workspace --all-targets` | 0 error / 0 warning |
| 调用方测试 | `cargo test -p application --no-fail-fast` | **143 passed / 0 failed**（`15_green_application_tests.txt`） |
| clippy（受影响 crate，含 `--all-targets`） | `cargo clippy -p backtest -p strategy-runtime -p strategy-core --all-targets` | 新增代码 **0 warning**；仅剩 4 条**改造前既有**告警（`dcap_plugin_init.rs` ×3、`dcap_plugin_replay.rs` ×1） |
| tangle 门禁（ADR-007/018） | `bash scripts/check-tangle.sh` | `✅ design 与生成物一致`（`16_tangle_check.txt`） |

---

## 4. 既有调用方零改动的证明

1. **逐文件 sha256 对照**（本批开始/结束各取一次 `crates/application/**` + `crates/web/**` 的全部 `.rs/.ts/.tsx`）：

```
$ diff coder/evidence/adr024_p2/application_web_hashes_before.txt ..._after.txt   # 空 ⇒ 逐字节未变
ZERO-DIFF: crates/application/** 与 crates/web/** 逐文件 sha256 未变（本批 P2 未触碰调用方）
```
（`18_application_web_unchanged.txt`）

> 说明：`git status` 中 `crates/application/src/{bar_map,simlive,strategy}.rs` 等显示为 `M`（staged）是
> **P0（M30/白名单单一事实源）** 的既有 staged 改动，与本批无关；本批对这些文件**无任何新增改动**（哈希证明）。

2. **UI 签名零变更**：`run_ensemble` / `run_ensemble_with_observer` / `run_ensemble_with_quickjs_observed`
   签名与文档契约未改（内部改薄封装），`BarCtx::new` 签名未改（只新增了可选注入器）。
3. **行为零变更的经验证据**：`cargo test -p application` 143 全绿（含 `run_success_end_to_end`、
   `submit_warmup_marks_prefix_and_pins_effective_fee`、`cancel_running_run_cooperative_break`、
   `compare_returns_side_by_side_net_value_and_metrics` 等真实路径）。
4. **影响面（上游调用方枚举）**：GitNexus 图谱本次不可用（见 §5.4），改用文本级枚举 + 全 workspace 编译：

| 被改符号 | 生产调用方 | 处理 |
|---|---|---|
| `build_indicators`（strategy-runtime 内部） | 仅 `build_ctx_object` | 内部替换，无外部签名 |
| `BarCtx::new`（+私有字段） | `application/src/strategy.rs:907`（试算单插件分）、`simlive/src/plugin_orchestrator.rs:264` | **签名未变**，两处走兼容路径（行为与改造前一致） |
| `run_ensemble_with_observer` / `run_ensemble` / `run_ensemble_with_quickjs_observed` | `application/src/workbench.rs:821`、`application/src/strategy.rs:1007`、各测试 | **签名/语义未变** |
| `Indicators`（旧切片视图） | 保留未删；生产路径仅测试与断言使用 | 作为等价性参考与对照保留（D6 要求） |

---

## 5. 未决项与残余风险

### 5.1 待 tester 跑的权威项（本报告不含）
1. **规模曲线**（`03-test-plan.md` §2.2/§2.4）：改造后 `dual_ma` 与 `indicator_heavy` **两者**渐近斜率均 ∈ [0.9,1.1]、
   `alloc_bytes` 塌缩为 O(n)、200k×3 slots 的墙钟与峰值 RSS 落在阈值内（**我的初筛只到 200k×1 slot**，
   3 slots 只测到 8k；请以 tester 全矩阵为准）。
2. **golden 12 用例**：当前基线仅 11/13（缺 `m30_1slot`/`m30_3slots`，P0 已落地 M30 ⇒ 请补齐后复跑 P2 gate）。
3. **独立复核**：tester 不得复用我的断言作为唯一依据（§3 的 A/B/C 判据与反向证据需独立重跑）。

### 5.2 范围外但已识别的同类二次项（**建议排期，本次按 P2 范围裁定不动**）
1. `crates/application/src/strategy.rs:907`（试算单插件逐 bar 评分循环）与
   `crates/simlive/src/plugin_orchestrator.rs:264`（sim-live 累计 bars 视图）**仍走兼容路径**，
   即仍每 bar 复制 `bars[..=index]`（O(n²)）。两者都不在 P2 三模块范围内，且任务书要求「不得顺手重构无关代码 /
   不得改 sim-live 业务逻辑」⇒ 未动。**修法很小**（各持一个 `Rc<BarHistory>` 并 `push` + `BarCtx::with_history`），
   但属接口/调用方改动 ⇒ 需架构师批准后再做（建议并入 P4 或独立小批）。
2. 插件若以**大量不同周期参数**反复调用指标（如每 bar `ema(random)`），每个新 `(指标,参数)` 首次调用仍需
   O(index) 回放一次。上界 = 不同参数组合数；与改造前同阶，且 JS 沙箱有 64 MB 内存上限。未加限额（避免引入
   未批准的策略），仅备案。

### 5.3 行为语义澄清（**请架构师确认表述，无代码争议**）
- 会话路径下 `BarCtx.bars` 的长度由「调用方传入切片长度（= n，含未来 bar）」变为 **`index + 1`**（截至当前 bar）。
  依据：`types.rs` 原契约写「全量历史序列（**至少到 index**）」；ADR D7 明确要求「保留 `ctx.bars` = 全量历史语义，
  实现改单一增长式共享缓冲」。
- **JS 侧可观察行为不变**（已核对）：`build_ctx_object` 只注入 `index/params/bar/indicators/position/log`，
  **不注入 `bars`**；`design/12-strategy-system/02-plugin-abi.md` 的 ctx 契约亦无 `bars` 字段 ⇒ **零 ABI 变更**。
  宿主侧 Rust `PluginInstance` 实现看到的是前缀切片（无前视，更安全）；仓内无任何实现读取 `index` 之外的 bar
  （已 grep 确认）。
- 需要架构师决定的是**文档措辞**：`01-adr.md` §2.2 行 3 与 D7 用「全量历史」描述 `ctx.bars`。
  我按「0..=index 的全量历史」实现并在 `types.rs` 澄清；若架构师希望保留「含未来 bar 的入参切片」字面语义，
  请回话（那会牺牲共享缓冲的零复制收益）。

### 5.4 工具/取证层面的备案
1. **GitNexus 不可用（留存原始错误）**：`node .gitnexus/run.cjs impact ...` / `detect-changes` 均返回
   `LadybugDB unavailable ... Database file version: 43, Current build storage version: 40`。
   按 AGENTS.md 要求，影响分析改用「文本级调用方枚举（原始输出 `20_impact_manual.txt`）+ 全 workspace
   `cargo check --all-targets` + `cargo test -p application`」作为替代证据。**未执行 `analyze` 重建索引**
   （可能与其他会话/进程并发冲突，且非本任务必需）。
2. **误触 tester 只读资产（如实披露）**：我在改造前按 README 惯例执行了一次
   `bash tester/evidence/240_adr024_golden_baseline/compare.sh`（无参数），该脚本会把报告写到
   `tester/evidence/240_adr024_golden_baseline/compare_report.txt`（**未跟踪文件**），即**改写了它的 mtime**。
   - 该文件内容**不含时间戳**（生成器为纯比对输出）；我保存的改造前副本、改造后重跑输出、以及该文件三者
     sha256 **完全相同**（`5c181bf276a72f93a8e8473e76f0675f63d0e90ad2989a4f33c57bcfec845da2`）；
   - 且与 tester 自己冻结的 P1b 版本 `tester/evidence/242_adr024_baseline_extension/compare_p1b_report.txt`
     的用例行**逐行一致** ⇒ 未丢失任何信息。
   - 之后改造后的比对**改为显式 `--out coder/evidence/adr024_p2/10_golden_post.txt`**，未再写入 tester 目录。
3. **新增/复用依赖**：**未新增任何依赖**（backtest 仍无 dev-deps；读 golden JSONL 的测试放在已有的
   `strategy-runtime` 内复用其 `serde_json`）。构建清单（`Cargo.toml`/`Cargo.lock`）**零改动**。
4. **`push()` 的返回值是内部记录的克隆**（便利 API，~150 B/bar 瞬时分配）；高频/批式路径用 `push_batch`（零复制）。
   已写入 rustdoc。若架构师倾向 `-> &BarRecord` 或改为不可失败返回，请指示。
5. `records()` / `drain_records()` 已备好但**生产未使用**（P4 分块落库将用）；`set_total_hint` 会按 n 预留
   `per_bar`/`nav`，与改造前 `Vec::with_capacity(n)` 等价。

### 5.5 已知的验收边界（诚实标注）
- 我的性能数据是**引擎内核口径**（不含 jsonb 落库/进度帧/spawn_blocking）⇒ 不得与生产端到端吞吐互比
  （ADR §2.5/§2.6 的教训）。
- 3 slots 只测到 8k bar（200k×3 slots 留给 tester；其墙钟 ≈ slots 线性放大已由 8k 点证实：0.077 → 0.085 s）。
- 峰值 RSS 现在**随 n 增长**（n×48 B 缓冲）：200k 由 60–61 MB → 66–75.5 MB。ADR D7 已接受该代价，但
  「200k×3 slots 峰值 RSS 阈值」需 tester 用权威曲线确认。

---

## 6. 交付状态

- 已 `git add`（**未 commit**）：
  - 源码：`crates/backtest/src/{indicators.rs,lib.rs}`、`crates/strategy-runtime/src/{history.rs,types.rs,quickjs.rs,lib.rs}`、`crates/strategy-core/src/{engine.rs,lib.rs}`
  - 测试：`crates/strategy-core/tests/{session.rs,session_alloc.rs}`、`crates/strategy-runtime/tests/{shared_history.rs,shared_history_alloc.rs,online_indicators_fixture.rs}`
  - 证据：`coder/evidence/adr024_p2/**`（30 个文件：红/绿/反向证据/测量原始输出 + 测量脚本）
- 净改动：13 个源码/测试文件，**+2,677 / −317**（不含证据目录）。
- 未触碰：`design/**`、`docker-compose.yml`、`crates/application/**`、`crates/web/**`、`crates/mcp/**`、`crates/storage/**`、`crates/domain/**`。
