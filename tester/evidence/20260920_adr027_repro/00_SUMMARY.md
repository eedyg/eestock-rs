# ADR-027 复现测试（R1–R6）总判词与索引

**总判词（前置）**：R1 = 🔴 **红** ｜ R2 = 🔴 **红** ｜ R3 = 🔴 **红** ｜ R4 = 🔴 **红** ｜ R5 = 🔴 **红** ｜ R6 = 🔴 **红** ｜ 未做 = **无**
（六条全部先红取证完成；R3/R4 亦在**单元级**复现成功，未启服务、未接 DB）

- 批次目录：`tester/evidence/20260920_adr027_repro/`（本文件位置：`tester/evidence/20260920_adr027_repro/00_SUMMARY.md`）
- commit：`0fdd83e`（工作区另有本批次新增测试文件，未提交）｜时间（UTC）：2026-09-19T14:45Z
- 生产代码改动：**零**（`git status --short` 中 `crates/*/src/**` 匹配数 = 0）
- 契约事实源：`design/17-trade-detail-layering/02-spec.md`；判据：`.../03-test-plan.md` §1；裁决：`ADR-027`

## 1. 六条 R 一览

| R | 判词 | 一句话结论 | 证据文件 | 原始输出 |
|---|---|---|---|---|
| R1 | 🔴 红 | 部分卖出下 `TradeDetail.pnl = 4513.894` ≠ 回合真实已实现盈亏 `5338.716`（**Δ = −824.822**） | `R1_partial_sell_pnl.md` | `raw/r1_*.txt` |
| R2 | 🔴 红 | L1 三字段均非全回合加总：`gross_value` Δ=−5010.249、`commission` Δ=−6.044、`stamp_duty` Δ=−2.505 | `R2_l1_fields_not_whole_round_trip.md` | `raw/r2_*.txt` |
| R3 | 🔴 红 | sim-live 结算 `stamp_duty = 0`（应 5.9988）且印花税被并入 `commission`（应 10，实 15.9988） | `R3_simlive_stamp_duty_zero.md` | `raw/r3_*.txt` |
| R4 | 🔴 红 | sim-live `bar_index = 29806680 = ts/60`（`ts=1788400817`），真实 bar 序号应为 30 | `R4_simlive_bar_index_reverse_computed.md` | `raw/r4_*.txt` |
| R5 | 🔴 红 | 零长回合可构造（`open_bar == close_bar == 1`、2 笔同 bar）但归属契约 4 项缺口（无 `rt_seq`/`l2_count`） | `R5_zero_length_round_trip_attribution.md` | `raw/r5_*.txt` |
| R6 | 🔴 红 | 两源（`fills`/`per_bar.events`）同事实但 3 笔 × 4 字段 = **12 项全缺**（`rt_seq`/`trade_value`/`commission`/`stamp_duty`） | `R6_fill_sources_field_completeness.md` | `raw/r6_*.txt` |

## 2. 新增测试文件与可执行命令（全部只读调用生产代码）

```bash
# R1 / R2 / R5 / R6 —— crates/strategy-core/tests/adr027_repro.rs（本批次新增）
cargo test -p strategy-core --test adr027_repro
cargo test -p strategy-core --test adr027_repro -- --exact \
  r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl
cargo test -p strategy-core --test adr027_repro -- --exact \
  r2_l1_amount_fields_are_not_whole_round_trip_sums
cargo test -p strategy-core --test adr027_repro -- --exact \
  r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq
cargo test -p strategy-core --test adr027_repro -- --exact \
  r6_fill_fact_source_lacks_rt_seq_and_fee_triple

# R3 / R4 —— crates/application/tests/adr027_repro_simlive.rs（本批次新增，单元级 mock 端口，无服务/DB）
cargo test -p application --test adr027_repro_simlive
cargo test -p application --test adr027_repro_simlive -- --exact \
  r3_simlive_settlement_stamp_duty_is_not_zero
cargo test -p application --test adr027_repro_simlive -- --exact \
  r4_simlive_bar_index_is_not_reverse_computed_from_ts
```

**聚合结果**（逐字取自 `cargo test`）：

```text
# strategy-core/tests/adr027_repro.rs
test result: FAILED. 0 passed; 4 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

# application/tests/adr027_repro_simlive.rs
test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

**崩溃 / core dump**：无（6 个用例均为断言失败 panic，退出码非 0，无 SIGSEGV/SIGABRT，无 core 文件）。
**skip / ignored**：0。

## 3. 汇总的量化事实（供实现阶段对表）

| 量 | 现观测（红） | 契约期望（02-spec） | 出处 |
|---|---|---|---|
| 部分卖出回合 `pnl` | 4513.894182770709 | 5338.715921666619 | R1 |
| 同回合 `gross_value` | 50396.27175022916 | 55406.520749979165 | R2 |
| 同回合 `commission` | 24.057348458338538 | 30.101567937557288 | R2 |
| 同回合 `stamp_duty` | 25.19813587511458 | 27.703260374989583 | R2 |
| sim-live `stamp_duty`（卖 11997.6） | 0.0 | 5.9988 | R3 |
| sim-live `commission`（全回合） | 15.9988 | 10.0 | R3 |
| sim-live `bar_index`（M1, ts=1788400817） | 29806680 | 30（会话内序号） | R4 |
| 成交事件字段数 | 5（`bar_index/side/qty/price/reason`） | 9（+`rt_seq`/`trade_value`/`commission`/`stamp_duty`） | R6 |

## 4. 本轮**未**覆盖（诚实边界）

1. **C 段契约测试**（`/result` v2、`/round-trips`、`/round-trips/{rt_seq}/fills` 404、`/curve?kind=position`、`/audit` 增量、MCP 形状）——未做，需 HTTP/MCP 层与 DB/落库夹具；
2. **S 段跨侧共享向量**（`contract-vectors.json`，回测聚合 vs sim-live 聚合逐位一致）——未做；本轮只各自取证单侧缺陷；
3. **U 段单元测试**（聚合纯函数表驱动、`rt_seq` 分配、I3/I4 恒等式、绩效口径基线锁定）——未做（新契约类型 `RoundTrip`/`FillFact` 尚不存在，U 段需实现后才有被测对象）；
4. **F/E 段前端与真渲染**——未做；
5. **R3/R4 的「多标的」「部分平仓」「策略驱动下单（经编排器 worker）」形态**——未构造（确定性优先）；
6. **R6 未构造出「复算与原值逐位不等」的正例**（F10 的最低佣金不可逆性在本构造中未被触达）——见 `R6_*.md` §5。

## 5. 关键构造限制（对所有 R 通用，务必带入实现阶段）

1. **字面构造 `买100股@10 / 部分卖50股@12 / 清50股@11` 经公开引擎 API 不可达**（实测推论）：
   `FeeModel::buy` 收**预算**而非股数；默认最低佣金下，100 股@10 的买入预算由用户不可控；
   且「精确 100 股买入（需 `pct≈1`、现金被吃光）」与「部分卖出（需 `pct<1` 且重快照价更高）」在本政策类下**互斥**。
   ⇒ R1/R2 用**同形态、不同量级**的序列（买 5000 / 部分卖 417.604… / 清 4582.396…），判决量（Δ 的符号与数值）
   与股数无关；ADR-027 F4 的「部分卖出可达路径」已在测试内以 Buy→Hold→Buy→Sell 脚本落地并断言守卫。
2. **R5/R6 的字段存在性判据用运行时 `Debug` 呈现**（`strategy-core` 无 `serde_json` 依赖，`Cargo.toml` 无 dev-dependencies）：
   编译期引用不存在的字段是**编译错误**、不是可判红的断言 ⇒ 残余风险 = 手写 `Debug` 伪造字段可骗过断言（概率极低，已披露）。
3. **R4 的「真实 bar 序号」基准尚未冻结**（会话内 0-based 是本测试选择的候选实现）：
   该用例同时断言「不得等于 `ts/bar_sec` 的反算商」——此项**不依赖基准选择**；若架构裁决改基准，只需调整「== 30」一项。

## 6. 纪律

- 未修改任何生产代码；未尝试修复失败；未做永久性插桩；未新增 fixture 或依赖。
- 失败分析/归因与修复方案交父级（Architecture Lead）。本批次只提供判词 + 原始输出 + 边界声明。
