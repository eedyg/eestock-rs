# ADR-027 / ADR-028（结果载荷 v2 批次）独立验收报告（闸门 3 · tester）

**R 段 通过 ｜ U 段 通过 ｜ 反假绿专项 通过（0 处削弱；附 2 处「未挣得 / 假覆盖」发现）｜ C 段 通过（限服务层载体；HTTP 级 DB 门禁未覆盖）｜ F 段 通过 ｜ S 段 通过 ｜ E 段 INCONCLUSIVE（阻塞：`strategy_run_bars.kind` CHECK 约束缺 `position` ⇒ 新回测 run 全部落库失败）**

- 本文件位置：`tester/evidence/20260920_adr027_accept/report.md`
- 批次根目录：`tester/evidence/20260920_adr027_accept/`（`raw/` + `raw/e2e/` 为逐段原始输出）
- 契约事实源：`design/17-trade-detail-layering/02-spec.md`；判据：`.../03-test-plan.md`（R/U/C/S/F/E）
- 我自己的验证时间：2026-09-19 15:27Z – 15:36Z（本地 23:27 – 23:36）；commit `0fdd83e`（工作区含未提交实现，均为 coder 车道）
- **纪律**：未修改任何生产代码（`crates/**.rs` 在 23:27 后仅新增 tester 自有测试文件 `crates/application/tests/adr027_contract_vectors_parity.rs`）；未分析失败、未尝试修复。
- 树静止：入场前 90 秒内有 coder P4 车道对 `crates/mcp/src/tools.rs` 的写入（见 §0.2）；此后至验收结束**无** cargo/npm/vite 活跃进程，且入场后生产源**零写入**（`find crates web/src -name '*.rs' -newermt 23:27` 仅命中我新增的测试文件）。§0.2 给出前后哈希差集 = 仅我新增的两份文件。

---

## 0. 环境与静止性核对（原始证据）

### 0.1 进程与端口
```
ps aux | grep -E "cargo|rustc|npm|vite|vitest|tsc"  → 无 cargo/rustc/vitest/tsc 活跃（仅 pi-intercom broker 等无关 node）
ss -ltnp → 8081 eestock-app(pid 1781236，本报告 §5 由我以新二进制重启)；5433 docker timescaledb
```
原始输出：`raw/00_tree_hash_start.txt`（起始哈希）、`raw/99_tree_hash_end.txt`（结束哈希）。

### 0.2 树静止判定（诚实标注）
- 起始哈希（`crates` + `web/src` + `migrations` + `design` 全量文件 sha256 汇总）：`19031b9b43a0d63332218690487f62ce90692dfb8cfcee4bc8003b4559c1bb1c`
- 结束哈希：`2d00f7d126a7d514ba43f2d3368cfc72066ac0080442109e429d07ab2e15b5fb`
- **差异归因（全部为我方新增，非生产改动）**：
  `?? crates/application/tests/adr027_contract_vectors_parity.rs`、`?? design/17-trade-detail-layering/contract-vectors.json`
  （`git status --short` 其余条目均为 coder 车道已 staged 的改动）
- 入场前 60 秒窗口内确有 1 次 coder 写入（`coder/evidence/.../p4_mcp/report.md` 与 `crates/mcp/src/tools.rs`，时间戳早于 23:27:38）。**因此 R/U/C/F 段的绿结论以「我重跑时刻的树」为准**；若父级要求「零写入窗口」，请以本报告时间戳重跑同一组命令复现（命令全量给出）。

---

## 1. R 段（复现 → 绿）：通过

### 1.1 我自己重跑的绿证据（命令 + 原始输出）
```
$ cargo test -p strategy-core --test adr027_repro
running 4 tests
test r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq ... ok
test r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl ... ok
test r2_l1_amount_fields_are_not_whole_round_trip_sums ... ok
test r6_fill_fact_source_lacks_rt_seq_and_fee_triple ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

$ cargo test -p application --test adr027_repro_simlive
test r4_simlive_bar_index_is_not_reverse_computed_from_ts ... ok
test r3_simlive_settlement_stamp_duty_is_not_zero ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
原始输出：本轮运行未单独落盘 R 的 `tee`（已在 `raw/01_core_backtest.txt` 与 `raw/02_app_simlive_storage.txt` 内逐字包含上述 6 行 `test result`）。红证据：`tester/evidence/20260920_adr027_repro/00_SUMMARY.md` + `raw/r1..r6_*.txt`。

### 1.2 先红后绿链条核对（逐条，含「红判据是否被偷改」）
逐条把**红期原始 panic 文本**与**当前测试源码**对齐（红文本来自 `tester/evidence/20260920_adr027_repro/raw/*.txt`）：

| R | 红期判据（panic 原文摘要） | 当前测试 | 判词 |
|---|---|---|---|
| R1 | `TradeDetail.pnl ... 期望 5338.715921666619，实际 4513.894182770709（Δ=-824.8217…，容差 0.000000001）` | `assert_close(t.pnl.expect(...), realized_true, 1e-9, …)` —— 容差 **1e-9 未变**、真值口径未变；`Option` 解包为 fail-loud | ✅ 未削弱（`p1b` 适配清单 #2 属机械适配） |
| R2 | `实得 3 项不符: gross_value Δ=-5010.248…` | 三项 Δ 收集 + `> 1e-9` 判据 + 新增 `FeeModel` 复算 oracle（仅作测试 oracle） | ✅ 未削弱（反而加料） |
| R3 | `实得 3 项不符: stamp_duty 必须 > 0 / == 5.9988 / commission == 10` | 三项判据**逐字保留**（含 `1e-9`），另加 1 条「撮合点事实已存在」前置守卫；文件在红后被编辑（panic 行号 277→241），差异为**新增前置**（增强） | ✅ 未削弱 |
| R4 | `实得 4 项不符: open_bar/close_bar 各 == 30 且各 ≠ ts/bar_sec 反算商` | 四项判据**逐字保留**，另加 `assert_ne!(open_ts % bar_sec, 0)` 前置（消除「巧合等价」） | ✅ 未削弱 |
| R5 | `实得 4 项缺口: 缺 l2_count / 缺 rt_seq …` | 判据保留（Debug 字段存在性 + 零长回合守卫）；仅 `close_bar/hold_bars` 包 `Some(..)` | ✅ 未削弱（但见 §3 假覆盖项 A） |
| R6 | `实得 12 项缺口: 第 0 笔（bar1 Buy）缺 rt_seq …` | 判据保留（4 字段 × 逐笔 Debug 存在性） | ✅ 未削弱（但见 §3 假覆盖项 B） |

**R 段判据成立性边界（诚实披露）**：
1. R1 的真值用 `nav[-1] − initial_capital`（回测期末空仓等价于「Σ sell proceeds − Σ buy total_cost」）。这与 test-plan 的字面公式**同义但非同式**；该替换在**红期即已存在**（红 panic 文本即为该真值），非本轮适配引入。它是真交叉校验：聚合侧读 `FillFact` 事实，nav 侧读引擎现金账 —— 两条独立代码路径。
2. R5/R6 的字段存在性判据基于运行时 `Debug` 字符串（`strategy-core` 无 serde dev-dep），红期已披露该残余风险（`00_SUMMARY.md` §5.2）。**这不是本轮引入的削弱**，但属假覆盖风险（见 §3）。

---

## 2. U 段（I1/I3/I4 + 持仓序列恒等式）：通过

```
$ cargo test -p strategy-core --test p1b_ledger          # raw/20_p1b_ledger_u.txt
running 9 tests
test p1b_i1_l1_amounts_equal_per_fill_sums ... ok
test p1b_i3_nav_identity_holds_on_partial_sell_run ... ok
test p1b_i3_nav_identity_holds_on_force_close_run ... ok
test p1b_u6_i4_distinct_rt_seq_equals_round_trip_count ... ok
test p1b_u7_position_series_is_synchronous_with_nav_and_self_consistent ... ok
test p1b_force_close_terminates_last_round_trip ... ok
test p1b_rt_seq_attribution_is_consistent_between_events_and_round_trips ... ok
test p1b_fill_events_carry_exec_fee_values ... ok
test p1b_trade_code_is_run_symbol ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

| 任务要求的 U 关键项 | 载体（测试） | 我重跑结论 |
|---|---|---|
| **I3 恒等式** `nav[-1] == initial + Σ_closed pnl (+ Σ_open 项)` | `p1b_i3_nav_identity_holds_on_partial_sell_run`（部分卖出场景）、`p1b_i3_nav_identity_holds_on_force_close_run`（期末强平场景）；回测侧全 `Closed` ⇒ `Σ_open` 项为空，Open 项由 sim-live 侧承担（`adr027_p2_open_round_trip_excluded_from_metrics`：Open 回合 `pnl == None` 且不进绩效） | ✅ 通过（相对容差由 `assert_rel` 显式承担） |
| **I4 自洽**：`distinct(rt_seq) == len(trades)`；`ForceClose` 终结数 == audit 字段 | 前者：`p1b_u6_i4_distinct_rt_seq_equals_round_trip_count`（另断言 rt_seq 从 1 连续、Σ l2_count == 笔数、每笔可归属）。后者：`crates/web/tests/adr026_run_audit.rs:309` 断言 `audit.round_trips_force_closed == 与 ForceClose 成交配对回合数` | ✅ 前半由我重跑证实；**后半该 web 测试为 DB 门禁测试（我无法执行，见 §6）**，仅以「P4 交付前既有测试」间接成立 ⇒ **不完全取证**（诚实边界） |
| **持仓序列恒等式**：`position_value + cash == nav` 逐点、`position_ratio == position_value/nav` | 引擎侧 `p1b_u7_position_series_...`（逐点 + `nav ≤ 0 ⇒ 0` + 「持仓期必须存在 ratio > 0 的点」反假覆盖 + 末点空仓）；读侧 `workbench.rs::c5_curve_position_kind_and_time_window` 对 `/curve?kind=position` 逐点同判据（`1e-6·max(1,|nav|)` / `1e-12`） | ✅ 通过（两侧都重跑绿） |
| I1/I2 字段级对账 | `p1b_i1_l1_amounts_equal_per_fill_sums`（Σ L2 == L1）；`c7_audit_increments_and_per_round_trip_reconcile`（`rt_reconcile.checked == L1 回合数`、正常 run `mismatched == []`）+ **篡改一笔 L2 佣金 ⇒ 必须标出该 rt_seq** 的反例 | ✅ 通过（含反例，非「没报错即通过」） |

---

## 3. 反假绿专项（**逐条核对 coder 报告列出的每一处测试适配**）

### 3.1 适配清单核对结果：**0 处削弱**

| 车道 | 报告列出的适配 | 我的核对方式与结论 |
|---|---|---|
| **P1b（自称 34 处）** | `report.md` §3 表 12 行（= 34 处），类别：`EngineEvent::Fill` 模式补 `..`（2 处）、`Option` 解包/包裹（`pnl`/`close_bar`/`hold_bars`/`close_price`，约 20 处）、`EnsembleConfig` 必填字段 `symbol`（7 处）、新测试自纠 2 处 | 逐类抽查源码：`adr027_repro.rs:189`（`.expect` 后仍 1e-9 值断言）、`adr027_repro.rs:287-289`（`Some(1)`/`Some(0)` 数值未变）、`engine.rs:336-346` 与 `:474-483`（`.expect` 后 `close(…, line×(1−slippage))` 值断言完整保留）、`engine.rs:218`（`(1, Some(2))` 数值未变）。**无**放宽等于、**无**删除断言、**无**改阈值、**无**失败路径改跳过。→ ✅ 未削弱 |
| **P2** | 报告 §4 表：`SimOrder`/`SimTrade` 构造适配、`plugin_orchestrator_tests.rs` 构造、`storage/tests/sim_store.rs` 构造+读回断言、`application/tests/simlive.rs` `fill.fee()` 适配 | `git diff` 逐行核对 `simlive.rs`：`close(fill.fee, 5.0)` → `close(fill.fee(), 5.0)` **并且新增** `close(fill.commission, 5.0)` + `close(fill.stamp_duty, 0.0)` ⇒ **增强**；其余为构造字段补齐。→ ✅ 未削弱 |
| **P3** | 报告 §6「既有测试的受控修改」1 条 + §7 残余风险 5 条 | ① `application/src/audit.rs::report_serializes_frozen_field_names`：由「14 字段**精确**键集」改为「17 字段**精确**键集」，且**仍**断言 `keys == frozen`（集合相等）、`len == frozen.len()`（不得多出）、序列化文本**声明序 = 契约序**、首字段 = `recorded`。**这是 3 字段契约演进（02-spec §5.5 批准），强度提升而非削弱**。② 被改写的 v1 兼容用例 `trade_detail_json_reads_legacy_without_reason_field` → `trade_detail_json_v2_shape_is_locked_and_v1_shape_is_rejected`：仍保留「历史 JSON 可读」的覆盖面，并**新增**「Open 回合 `Option` 字段必须 `Null`（禁造数）」与「**v1 形状（缺 rt_seq）必须被拒绝**且错误指向 `rt_seq`」——比原用例更强。→ ✅ 未削弱（**无** `serde(default)` 兼容回退） |
| **P5a** | 报告 §「仅选择器改名，无断言弱化」：`wb-trades-table`→`wb-round-trips-table`、`wb-trade-source-N`→`wb-rt-source-{rt_seq}` 等 | `git diff web/src/features/workbench/ResultView.test.tsx` 逐个 `-/+` 对比：仅 testid 重命名 + `RoundTrip` 必填字段补齐 + 新增 `rt_seq/code/status/buy_count/sell_count/l2_count`；`fills` 提示文案断言由 `成交 N 笔` 改为 `成交合计 N 笔（…已加载 N / 共 N）` —— **断言的数量仍在（且双处）**，属 D11 完整性披露的契约演进。→ ✅ 未削弱 |
| **P5b** | 报告 §（窗口车道）：`roundTripAccum`/`resultWindow`/`klineWindowOps` 等新增测试文件 | 新增为主（`A`）；对既有前端测试的改动仅限 `chartUtils.test.ts`（+69 行，`mapLine` 回归断言保留并**加强**）与 `api/{client,mock}.test.ts`（新增形状断言）。全局扫描**无新增** `it.skip/describe.skip/test.skip/.only`。→ ✅ 未削弱 |

### 3.2 全仓 skip/ignore 扫描（防「把失败路径改成跳过」）
```
grep -rn "it.skip|describe.skip|test.skip|\.only(" web/src --include=*.test.ts*   → 0 命中
grep -rn "#\[ignore\]" crates --include=*.rs                                     → 2 命中
  crates/strategy-core/tests/engine.rs:740  （既有性能冒烟，ADR §14，注释说明「运行时硬断言达标线」）
  crates/storage/tests/kline_reader.rs:274-275（注释中「不得恢复静默 return」的纪律文字，非 ignore 属性）
```
→ 本轮**未新增**任何 skip/ignore/only；跳过项 0（除上述既有 1 处性能冒烟）。

### 3.3 反假绿专项中发现的**非削弱**项（2 处，需父级/闸门 2 裁决）

**A（假覆盖 · R6）**：`crates/strategy-core/tests/adr027_repro.rs` 的「两源逐笔一致性」断言是
```rust
let events_side: Vec<FillFactNow> = f.clone();
assert_eq!(events_side, f, "两源（per_bar.events / fills 事实源）逐笔同 tuple");
```
即**自比较**（值与自身 clone 相等），覆盖面 = 0。该断言在**红期即存在**（红输出只命中字段缺口那一条），故不属本轮「适配削弱」，但它把「两源一致性」这一判据伪装成已覆盖 —— 建议闸门 2 要求改为真正从 `per_bar[i].events` 反解重建后比较（**我不改**）。

**B（未挣得的绿 · C 段既有契约测试）**：`crates/web/tests/adr026_run_audit.rs:220-232`
`AUDIT_KEYS: [&str; 15]` + `assert_eq!(obj.len(), AUDIT_KEYS.len(), "audit 不得多出字段")`。
ADR-027 §5.5 使 `/audit` 增 3 键（`round_trips_closed`/`round_trips_open`/`rt_reconcile`）⇒ 该断言在**提供测试库后必然失败**。P3 报告 §6 声称「其余既有测试（含 `adr026_run_audit.rs` 依赖的字段）未改，逐条绿」，但该文件属 `EESTOCK_TEST_DATABASE_URL` 门禁测试，在本环境**根本无法运行**（§6）⇒ 该「逐条绿」**未被挣得**，且静态阅读即为**待红**。此为**契约冻结集未同步**（既有测试 vs spec 增量），按 03-test-plan §7.4 精神应在本批次内一并整改（**我不改**）。

---

## 4. C 段（契约形状抽样，可用测试载体）：通过（限服务层）

### 4.1 我重跑的逐用例（`raw/21_c_section_individual.txt`，逐个 `--exact`）
```
test c2_round_trips_paging_and_summary ... ok
test c3_l2_slice_ownership_and_unknown_rt_seq_404 ... ok
test c4_fills_filter_and_element_increment ... ok
test c5_curve_position_kind_and_time_window ... ok
test c6_curve_rejects_fills_kind ... ok
test c7_audit_increments_and_per_round_trip_reconcile ... ok
test c8_completeness_on_all_list_endpoints ... ok
（每个均 `test result: ok. 1 passed; 0 failed; …; 52 filtered out`）
$ cargo test -p application -p simlive -p storage --no-fail-fast   # raw/02_app_simlive_storage.txt
  application lib 47 ✅ / d6 3 ✅ / resource_guard_contract_vectors 3 ✅ / simlive tests 57 ✅ / strategy 41 ✅ /
  workbench 53 ✅ / simlive lib 41 ✅ / adr024_p2b* 3+3 ✅ ...
$ cargo test -p mcp   # raw/22_mcp.txt
  mcp lib 68 ✅ / adr024_period_ssot_drift 5 ✅ / mcp_protocol 2 ✅（DB 门禁用例见 §6）
```

### 4.2 逐项判据核对（判据 → 断言 → 判定）
| 判据 | 断言（抽样） | 判定 |
|---|---|---|
| `/round-trips` 分页与摘要 | `total/has_more/next_offset` 逐页拼接 == 全量且顺序一致；`l2_count == 该回合 fills 数`；`buy_count/sell_count` 与切片逐笔一致；越界 ⇒ 空页非错误 | ✅ 通过（强断言，含分页不丢不重） |
| L2 切片未知 `rt_seq` ⇒ 404 | `result_round_trip_fills(id, rt+1000)` 必返 `WorkbenchNotFound`（**禁止空数组冒充**）；`full.rt_seq`/`run_id` 回显；L2 元素 `code`/三件套非 null | ✅ 通过（服务层错误类型锚定；HTTP 路由由 §5 探针另行证明已接线：`rt_seq=abc` ⇒ 400，未知 run ⇒ 404 `运行不存在`） |
| `/fills` 过滤与新增字段 | 未过滤 `round_trip == null`；元素 `rt_seq/trade_value/commission/stamp_duty` 非 null；过滤集合 == 该回合切片 | ✅ 通过 |
| `/curve` 窗口回显 + `kind=position` | 无窗口 ⇒ `window_from_ts/to_ts == null`、`window_bars == original_bars`（向后兼容）；窗口 `[ts1,ts3]` ⇒ `window_bars == 3`、`points.len() == 3`、`original_bars` 仍为全序列；空窗口 ⇒ `window_bars == 0`（**不静默回全量**）；`k=2` 窗口内重采样 ⇒ `downsampled=true`；position 逐点 6 字段 + I6 恒等式 + 与 net_value 同 ts 同 nav | ✅ 通过 |
| `/audit` 增量 | `round_trips_closed == L1 total`、`round_trips_open == 0`、`closed+open == total`、`rt_reconcile.checked == total`、`mismatched == []`、`tolerance == RT_RECONCILE_TOLERANCE`；**篡改一笔 L2 佣金 ⇒ `mismatched == [该 rt_seq]`** | ✅ 通过（含反例） |
| 所有列表端点完整性字段 | `c8_completeness_on_all_list_endpoints` 对 `total/has_more/next_offset`（或 `truncated`）逐端点断言 | ✅ 通过 |
| `/curve` 拒 `kind=fills` | 无窗口与窗口路径均 `WorkbenchValidation(code='kind_invalid')` | ✅ 通过 |
| spec §5.4 偏差：`/fills?round_trip=` 未知回合 | 返回空页而非 404（P3 已申报，符合 §5.4 既有分页契约） | ⚠ 契约歧义，交父级裁决（非失败） |

**C 段残余风险**：`/round-trips` 与 `/round-trips/{rt_seq}/fills` 的**HTTP 级**端到端断言缺失（P3 §7.1 自陈），我只证到「路由已接线 + 服务层判据」；真库 HTTP 端到端见 §6/E 段。

---

## 5. F 段（前端）：通过

```
$ web/$ ./node_modules/.bin/tsc -b          → 退出码 0，无输出（raw/10_tsc.txt）
$ web/$ ./node_modules/.bin/vitest run      → Test Files 99 passed (99) | Tests 961 passed (961) | 无 skip
                                              （raw/11_vitest_all.txt）
```

| 重点项 | 证据 | 判定 |
|---|---|---|
| **F4 对账不一致必须显式告警、不得静默按 L1 渲染** | `roundTripLayers.test.tsx`「F4：累加 != L1 ⇒ 告警行含 Δ 且冻结展示两侧数值；audit mismatched 非空同样告警」：断言告警 `role="alert"`、含 `对账不一致`/字段名/`L1 99.00`/`累计 15.25`/`Δ 83.75`，且 L1 行**仍显示 L1 原值**（冻结、未被改写）；`roundTripAccum.test.ts` 三条：一致⇒ok、拉取不全⇒`l2_count` 告警、audit `mismatched` 命中⇒即使本页相加一致也告警（D10） | ✅ 通过（双侧冻结 + Δ 值 + 反例） |
| **F6 `mapLineByTs` 定义域 == 共享窗口** | `chartUtils.test.ts`：「窗口 [0,1000] 而数据只在 [400,600] ⇒ 点落在 40%/60% 处，**不得端点对齐**」、端点/中点线性、定义域退化 ⇒ `x=pad` 不除零、`mapLine` 回归（3 个既有调用点语义不变，含「换 ts 不变 / mapLineByTs 随 ts 变」的区分断言） | ✅ 通过 |
| **F8 不传 `onVisibleRangeChange` 的既有调用方行为逐字节不变** | `KlineChartVisibleRange.test.tsx`：「F8-回归：**不传** ⇒ `__listenerCount('onVisibleRangeChange') == 0`，`onZoom/onScroll` 各 == 1（订阅面不变），且 `__log` 无任何 `scrollToDataIndex`（写操作不变）」+「不传 `windowCommand` ⇒ 一条写语句都不执行」；源码侧 `KlineChart.tsx` Effect V 以 `hasVisibleRangeCb` 早退、Effect K 以 `!cmd` 早退 | ✅ 通过 |
| **F9 `setBarSpace` 越界必须被断言捕获，禁静默失败** | `resultWindow.test.ts`：「**越界静默失败必须被捕获并显式报错**（max=50 场景）」：`ok == false`、`error` 含 `静默吞掉`、`requested_bar_space == 104`、且断言引擎**确实没动**（`getBarSpace().bar == before`）；`KlineChartVisibleRange.test.tsx` 同样从组件层断言 `onWindowApplied.ok == false` + 显式报错；数据未加载/未布局亦显式失败 | ✅ 通过（构造越界 + 断言捕获 + 显式上报，零静默） |
| 其余 F1/F2/F3/F5/F7/F10/F11/F12 | `roundTripLayers.test.tsx`（F1 展开行数 == `l2_count`、`aria-expanded`；F2 展开前无 L2 请求；F3 三件套/双口径/cum 可见；F5 末行累计 == L1；F12 > 首页分页拉全 + 显式披露）、`resultWindowSync.test.tsx`（F7 节流/rev 丢旧/回声抑制、F9 跳转）、`PositionRatioChart`/`useResultWindow` 用例 | ✅ 通过 |

**F 段残余风险**：F8 的「逐字节不变」以「订阅面 + 写语句日志」为代理指标（`__listenerCount`/`__log`），非渲染 DOM 快照逐字节 diff；这是既有桩约定（`createSyncChartStub` 忠实模型），未发现反例。

---

## 6. S 段（跨侧共享向量）：通过

**产物**：`design/17-trade-detail-layering/contract-vectors.json`（sha256 `3800a67019898c6f7265610bcc7db3687935e9f46282ee9dae572cd0930eae74`）
- 7 组向量（≥6）：`V1_single_open_close`、`V2_multi_batch_add`、`V3_partial_sell`、`V4_dca_multi_batch`(6 批)、`V5_zero_length_round_trip`（`open_bar == close_bar == 4`）、`V6_open_round_trip_unclosed`（`status=Open`、`pnl=null`）、`V7_close_then_reopen_two_round_trips`（rt_seq 1→2）
- 每组含：输入 `FillFact`（含事实三件套，**不由费率复算**）、`expected_fill_rt_seq`（逐笔）、`expected_round_trips`（逐字段）、`expected_l2`（逐笔）
- **期望值来源 = 独立 oracle**：`tester/evidence/20260920_adr027_accept/gen_contract_vectors.py`（Python，按 02-spec §2 公式的 op 顺序计算，**不读 Rust 实现**）

**可执行判据与原始输出**：
```
$ cargo test -p application --test adr027_contract_vectors_parity      # raw/30_s_contract_vectors_parity.txt
running 2 tests
test adr027_contract_vectors_sim_live_l2_matches_vector ... ok
test adr027_contract_vectors_cross_side_parity ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
测试断言（4 条，全部硬断言）：
1. **回测侧**（`backtest::assign_rt_seq` + `aggregate_round_trips`，即 strategy-core 引擎所用同一对函数）逐笔 `rt_seq` == 向量期望；回合逐字段 == 向量期望（`serde_json::Value` 数值**逐位** `==`）；
2. **sim-live 侧**（`SimLiveService::round_trips` 真实读路径：mock `SimSessionStore` → `sim_trades` 行 → `sim_trade_from_row` → `FillFact`（`bar_index` 由 `session_bar_index` 相对会话起点折算）→ 唯一聚合实现）同样逐字段 == 向量期望；
3. **两侧序列化 JSON 字符串逐字节相等**（最强一致性判据）；
4. sim-live `round_trip_fills` 的 L2 元素逐字段 == `expected_l2`，且**未知 rt_seq ⇒ `None`**（禁空数组冒充）。

**反假绿（我自己的测试也做突变验证）**：把 `V1` 期望 `pnl` 由 `188.79999999999995` 改为 `188.79999999999998`（1e-17 级微扰）后重跑：
```
test adr027_contract_vectors_cross_side_parity ... FAILED
[V1_single_open_close] 回测侧回合#0 字段 `pnl` 不一致（须逐位相等）：实际 188.79999999999995，期望 188.79999999999998
```
⇒ 判据确实锚定浮点逐位，非「近似随便过」。（突变后已还原文件；sha256 见上。）

**S 段残余风险**：回测侧的「引擎在线打号」路径（`engine.rs` 内部调用 `assign_rt_seq`/`aggregate_round_trips`）与向量测试调用的**是同一对函数**，故本段证明的是「聚合层跨侧逐位一致 + sim-live 端到端重建一致」；「引擎在线打号 == 聚合打号」由 P1b `pending/ledger` 单测与本轮 R/U 绿覆盖，非 S 段直接覆盖。

---

## 7. E 段（端到端真渲染/真库）：**INCONCLUSIVE**（阻塞，未声称通过）

### 7.1 已执行的前置与命令
```bash
# 1) 构建（目标二进制已是最新，构建零编译）
$ cargo build -p app --bin eestock-app        → Finished `dev` profile … in 0.07s   （raw/40_e_build.txt）
# 2) 按既有做法重启 8081（原进程：./target/debug/eestock-app --config /tmp/app_dev_8081.toml，已运行 5h12m 的 ADR-027 前二进制）
$ kill 1326638 && nohup ./target/debug/eestock-app --config /tmp/app_dev_8081.toml > /tmp/eestock-app-8081-accept.log 2>&1 &
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/healthz → 200
# 3) 旧服务（ADR-027 前）反证：/audit 无新三字段；/round-trips → 404 {"error":"not found"}
# 4) 新服务：/audit 已含 round_trips_closed/open + rt_reconcile（tolerance 1e-6）→ 增量已生效
$ curl -s … /runs/sr_1789826383501_000000/audit | python3 -m json.tool     （raw/e2e/03_audit_legacy.json）
# 5) 真实回测 run #1（D1 159776，Dca，warmup 250）与 #2（M5 518880，LumpSum）
$ curl -s -X POST -H 'content-type: application/json' -d @/tmp/adr027_e_run.json … /api/workbench/runs
```

> ⚠ **对在线开发环境的影响（须知）**：磁盘上的 `target/debug/eestock-app`（23:26 由 coder 车道构建）已是 ADR-027 构建，
> 因此**当前 8081 上任何新回测 run 都会失败**；「回退」不等于「重启旧进程」——需先补迁移，
> 或由父级裁定 `git stash/checkout` 掉本波实现后再重启。数据面（8080）与 MCP（8082）未受影响。

### 7.2 阻塞结论（两次独立 run 同一失败）
```
run sr_1789831866857_000000 → status=failed
  error: 结果分块落库失败: error returned from database: new row for relation "strategy_run_bars"
         violates check constraint "strategy_run_bars_kind_check"
run sr_1789831880929_000001 → status=failed   （同一错误）
```
原始输出：`raw/e2e/01_run.json`、`raw/e2e/02_run2.json`

**根因（仅观测，不做修复）**：
```
$ psql … -c '\d strategy_run_bars'
Check constraints:
    "strategy_run_bars_kind_check" CHECK (kind = ANY (ARRAY['per_bar','net_value','drawdown','fills']))
$ grep -rn 'kind.*CHECK' migrations/*.sql
migrations/0027_strategy_run_result_chunks.sql:13:  kind text NOT NULL CHECK (kind IN ('per_bar','net_value','drawdown','fills'))
（migrations/ 最新为 0028_sim_trades_fee_split.sql —— **仅**加 sim_trades.commission/stamp_duty，未涉及 kind）
```
⇒ 02-spec §4.1 新增 `ResultKind::Position` 分块落库，但 **02-spec §8「无需其它 DDL」与事实不符**：`strategy_run_bars.kind` 有枚举型 CHECK 约束，缺 `position` 成员且**无迁移补齐**。
**影响面升级（不止新功能缺失）**：P3 使**所有**分块化 run 都在 `net_value` 同级写 `position` 块（`c5c_position_chunk_written_alongside_net_value` 断言同块数）⇒ **当前工作树上的任何新回测 run 都会在结果落库阶段失败**，属**既有功能回归**（本波前所有 run 均成功；见旧服务上 `sr_1789826383501_000000` succeeded）。

### 7.3 E 段已完成/未完成清单
| 项 | 状态 |
|---|---|
| 重新构建 + 重启 8081 | ✅ 已做（新二进制） |
| 真实 run 提交 | ✅ 已做（2 次，均 `failed`） |
| `/audit` 的 `rt_reconcile` 端到端 | ⚠ 仅证到「字段已序列化」；因无成功 run，`checked=0`（旧 run 无 `rt_seq` 事实，属诚实留白），**未取得 `checked>0` 且 `mismatched=[]` 的端到端证据** |
| `/round-trips`、L2 切片、`/fills?round_trip=`、`/curve?kind=position`+窗口、I1/I2 逐回合字段级对账 | ❌ **未执行**（无成功 run 可读）；仅证到路由已接线：`/round-trips/abc/fills` ⇒ 400（路径参数已挂）、未知 run ⇒ 404 `运行不存在`、无结果 run ⇒ 404 `尚无结果（未成功完成）`（`raw/e2e/07_route_probe.txt`） |
| sim-live 真渲染 | ❌ 未执行（无会话数据、无成功 run 对齐） |

### 7.4 恢复端到端所需的前置步骤（可直接执行，供 worker 车道）
1. 修订 02-spec §8 与 `design/04-storage/schema.md`：新增迁移（如 `0029_strategy_run_bars_kind_position.sql`）替换/扩展 `strategy_run_bars_kind_check` 使其含 `'position'`（**必须经 schema.md tangle 生成，禁手改 migrations/**），并在 `strategy_run_bars` 上重跑 schema 自检。
2. `psql -v ON_ERROR_STOP=1 -f migrations/0029_*.sql`（真实库 `postgres://eestock:eestock@127.0.0.1:5433/eestock`）。
3. 重启 8081 后重跑 §7.1 的第 5 步；随后依次执行：
   `/round-trips?offset=0&limit=2`、`/round-trips/{rt}/fills?limit=1`、`/round-trips/999999/fills`（期望 404）、`/fills?round_trip={rt}`、`/curve?kind=position&from_ts=…&to_ts=…`、`/audit`（期望 `checked == total`、`mismatched == []`），并用 §6 的 I1/I2 口径逐回合对账。
4. 若要恢复既有 DB 门禁测试（`crates/web/tests/adr026_run_audit.rs` 等）：`scripts/testdb-init.sh` + `export EESTOCK_TEST_DATABASE_URL=…`（**同时**须先处置 §3.3-B 的冻结键集）。

**E 段判词：INCONCLUSIVE（阻塞原因：缺 `kind='position'` 的 DB 迁移，导致新 run 无法落库；禁声称通过）。**

---

## 8. 冻结/放行建议（判词摘要，供父级与闸门 1/2）

| 段 | 判词 | 依据 |
|---|---|---|
| R | 通过 | 红证据在位且判据文本/容差与当前测试逐字一致；6 个用例由我重跑转绿 |
| U | 通过 | I1/I3/U7/I4(前半) 重跑绿；I4 后半的 web 端断言属 DB 门禁（未取证，已在 §2 标注） |
| 反假绿 | **通过（0 处削弱）** | 34+ 处适配逐条核对：无放宽容差、无删断言、无改阈值、无失败路径跳过；2 处「未挣得/假覆盖」另列（§3.3 A/B） |
| C | 通过（限服务层） | c2–c8 逐用例绿 + 全 app/simlive/mcp 绿；HTTP 级断言与 DB 门禁测试未覆盖 |
| F | 通过 | `tsc -b` 退出码 0；`vitest run` 99 文件 / 961 用例全绿；F4/F6/F8/F9 判据均含反例或回归断言 |
| S | 通过 | 7 组向量 + 跨侧逐位一致 + 逐字节相等；突变验证证明判据非空洞 |
| E | **INCONCLUSIVE** | §7.2 阻塞（缺迁移）且**新 run 全失败 = 既有功能回归** |

**必须交回 worker 车道处置（我不修）**：
1. **BLOCKER（E/C-端到端）**：`strategy_run_bars.kind` CHECK 缺 `position` ⇒ 新回测 run 全部 `failed`；需 spec §8 + schema.md + 迁移（§7.4）。
2. **待裁决（契约）**：§3.3-B `crates/web/tests/adr026_run_audit.rs::AUDIT_KEYS` 冻结集未随 `/audit` 增量更新（提供测试库后必红）；P3 报告「其余既有测试逐条绿」未被挣得。
3. **待裁决（假覆盖）**：§3.3-A R6 自比较断言（覆盖面 0）。
4. **契约歧义（P3 已申报）**：`/curve` 响应新增 `recorded`（02-spec §4.2 信封未列）；`/fills?round_trip=` 未知回合返回空页而非 404。
5. `/round-trips` 系列缺 HTTP 级断言（P3 §7.1 自陈）。

---

## 9. 原始输出索引（`tester/evidence/20260920_adr027_accept/`）

| 文件 | 内容 |
|---|---|
| `raw/00_tree_hash_start.txt` / `raw/99_tree_hash_end.txt` | 树哈希（静止性核对） |
| `raw/01_core_backtest.txt` | `cargo test -p strategy-core -p backtest` 全量（含 R1/R2/R5/R6 转绿 4 行） |
| `raw/02_app_simlive_storage.txt` | `cargo test -p application -p simlive -p storage` 全量（含 R3/R4 转绿；storage DB 门禁失败明细） |
| `raw/20_p1b_ledger_u.txt` | U 段 9 用例（I1/I3/I4/U7） |
| `raw/21_c_section_individual.txt` | C 段 c2–c8 逐用例 `--exact` |
| `raw/22_mcp.txt` | `cargo test -p mcp`（lib/protocol 绿；DB 门禁失败） |
| `raw/30_s_contract_vectors_parity.txt` | S 段跨侧一致性 2 用例绿 |
| `raw/40_e_build.txt` | E 段构建 |
| `raw/10_tsc.txt` / `raw/11_vitest_all.txt` | F 段 `tsc -b` / `vitest run` |
| `raw/e2e/01_run.json`、`02_run2.json` | 两次真实 run 的 `failed` + 约束违规错误 |
| `raw/e2e/03_audit_legacy.json` | 新服务 `/audit` 增量字段 |
| `raw/e2e/04_round_trips_probe.txt` | legacy run `/round-trips` ⇒ 500 `internal error`（服务日志亦落 `raw/e2e/06_server_log_tail.txt`：`trades 形状非法…missing field rt_seq`，符合 D3「无 v1 兼容」，但以 500 暴露而非显式 4xx/错误码 —— 一并交裁决） |
| `raw/e2e/05_db_constraint.txt` | `\d strategy_run_bars` 约束定义 + migrations 命中 |
| `raw/e2e/07_route_probe.txt` | 新路由接线探针（400/404 形状） |
| `gen_contract_vectors.py` | S 段向量的独立 oracle 生成器（可重跑复现 `contract-vectors.json`） |

## 10. 纪律声明
- 未修改任何生产代码、接口、迁移或架构；未新增永久插桩；未尝试修复任何失败（含 §7.2 BLOCKER，仅出判词与证据）。
- 我新增的唯一代码文件是 tester 自有测试 `crates/application/tests/adr027_contract_vectors_parity.rs`（S 段判据载体，无生产改动）。
- 我对 8081 服务的重启是本任务明确授权的动作；原进程为 ADR-027 前的构建，重启命令与日志见 §7.1。
