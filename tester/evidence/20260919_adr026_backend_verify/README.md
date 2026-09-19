# ADR-026 阶段 2：后端独立核验报告（不采信 worker 结论）

- **本报告位置**：`tester/evidence/20260919_adr026_backend_verify/README.md`（原始输出：同目录 `raw/`）
- **契约（冻结）**：`design/01-architecture/adr/ADR-026-run-execution-audit-and-disclosure.md`（已完整读）
- **交付基线**：`git rev-parse HEAD` = `e807385449a303a1090ac00a52c722b7b77e62ec`；开工工作树快照 = `git status --porcelain`（72 行，与收工一致，见 §6）
- **被核验对象**：`coder/evidence/20260919_adr026_backend/README.md`（已读 README + 全部原始输出；**所有关键数字本报告自行重取**）
- **环境**：活库 `PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d eestock`；线上 Web `:8081` / MCP `:8082`（PID 2043164）；本次核验用自建实例 `:8091/:8092` + ADR-025 临时库
- **纪律**：未 `git add/commit/checkout/stash/reset`（`git diff --cached` 空）；未改任何实现代码（两次突变已逐字节还原，§4）；未改表结构/无迁移；**未触碰线上 PID 2043164**（`ps -o pid,lstart` 全程 `Fri Sep 18 18:04:44 2026` 不变，`8081 healthz:200`）

---

## 1. 判词与结论摘要

| 项 | 结论 | 关键读数（我自取） | 证据 |
|---|---|---|---|
| A1 纯函数表驱动单测全绿 | **PASS** | `audit::` 18 passed / 0 failed（我自己跑） | `raw/50_A1_unit_green.txt` |
| A2 突变反证（≥2 单测变红） | **PASS** | M1 → 单测 5 红 + 端点 2 红；M2 → 单测 1 红；还原 `sha256` 与变更前逐字节一致 | `raw/60..66_*` |
| A3 目标 run 实测 | **PASS** | `planned=100, reachable=43, done=42, unexec=1, last_bar_unfilled=true, deployed=41397.97208076086(0.41397972), cash=41607.97208076086(0.41607972), round_trips=1/1`，3 条 warning；与我 SQL 独立重算 **Δ=0** | `raw/30_curl_A3_A4_A5.txt`、`raw/10_independent_recompute.{sql,txt}` |
| A4 同区间 LumpSum{1} | **PASS** | `planned=null, deployed_pct=0.9997500624843787, cash_consumed_pct=0.9999999999999999, warnings=[]`（无 `PARTIAL_DEPLOYMENT`） | 同上 |
| A5 双向 run 三方自洽 | **PASS** | `batches_done=40==/fills Buy 数`、`round_trips_total=40==/result trades 长度`、`force_closed=0==ForceClose 配对`、`deployed==Σqty×price`（Δ 9.3e-10）；8 条自洽断言全 PASS | `raw/51_A5_three_way_selfcheck.txt` |
| A7 既有测试回归（后端部分） | **PASS（附 F3/F5）** | `backtest 2`、`strategy-core 7`、`application 9`、`mcp 7` 个测试目标全 ok；`web` 25 目标 ok + **1 个既有红**（tester 资产，非本批）；本批**新增**端点套件存在 flake（F3） | `raw/80_reg_*.txt`、`raw/82_regression_summary.txt` |
| A6 前端 E2E | **不适用**（阶段 3 范围） | 前端 `web/src` 无 `audit` 引用（未实现消费） | `raw/`（见 §7-6） |

### 判词
**A1–A5 全部实测通过**（含我自己的独立重算与反证），A7 既有套件绿；**但有三项必须由主代理处置**：
1. **F4（环境，阻断阶段 3）**：线上 `:8081/:8082` 跑的是 **ADR-026 之前的旧二进制**（`/audit` → `404 {"error":"not found"}`；MCP `tools/list` = 34 个工具、无 `bt_get_run_audit`）。前端阶段会被 404 挡住，**部署刷新需主代理执行**（按仓内惯例 tester 车道不重启线上 PID）。
2. **F3（测试质量）**：本批新增的 `crates/web/tests/adr026_run_audit.rs` 在**默认并行**下 flake（实测 9/50 变红 = 18%；串行 3/3 绿；全新临时库 1/12 仍复现）⇒ 冻结前建议由上游客车修正测试隔离。
3. **F1/F2（实现小缺陷，本人不修）**：`recorded` 在「chunked 有 per_bar 块但无 fills 块」时与 `/fills` 口径分叉（当前活库不可达）；零成交 run 的 `deployed_*` 返回 `-0.0` 且 warning 文本渲染「名义投入 -0.00% 初始资金」（活库当前 **18/377 run** 可达）。

---

## 2. 逐条验收项的证据映射

### 2.1 A1：纯函数表驱动单测全绿

```
$ cargo test -p application --lib audit
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out
```
覆盖形态（逐条对照 ADR §5 A1 要求）：目标 run 形态 `target_run_shape_dca_underfilled`（43/42/1/41397.97208076086/41607.97208076086）、满仓 `full_deployment_lumpsum_has_no_warnings`、零成交 `zero_fills_reports_partial_deployment_and_unexecuted`、legacy/双向 `legacy_two_way_run_is_self_consistent`、Dca/非 Dca `dca_plan_met_has_no_dca_warning` + `no_policy_means_null_planned_tranches_and_no_dca_warning`、阈值两侧 `partial_deployment_threshold_table`、佣金 `commission_follows_fee_contract_min_and_rate`、强平配对 `force_closed_round_trips_match_by_close_bar`、投影 `orders_projection_*`/`fills_and_trades_projection_reads_documented_fields`、序列化字段名/序 `report_serializes_frozen_field_names`、`recorded=false` 诚实留白 `recorded_false_reports_zeros_and_no_warnings`。
原文：`raw/50_A1_unit_green.txt`。

### 2.2 A3：目标 run `sr_1789738328788_000005`

**端点原始响应**（`raw/30_curl_A3_A4_A5.txt`，`curl -i` 200）：
```json
{"run_id":"sr_1789738328788_000005","recorded":true,"capital_basis":100000.0,
 "deployed_notional":41397.97208076086,"deployed_pct":0.4139797208076086,
 "cash_consumed":41607.97208076086,"cash_consumed_pct":0.41607972080760863,
 "planned_tranches":100,"reachable_batches":43,"batches_done":42,"unexecuted_orders":1,
 "last_bar_unfilled":true,"round_trips_total":1,"round_trips_force_closed":1,
 "warnings":[3 条，见下]}
```
三条 warning 的 `code/severity/message` 与 ADR §2.2 示例**逐字一致**（`raw/30_curl_A3_A4_A5.txt` 原文比对）：
`DCA_PLAN_UNDERFILLED|warn|计划 100 批，区间内最多可推进 43 批、已成交 42 批（剩余批次随买入区结束取消）`、
`PARTIAL_DEPLOYMENT|warn|名义投入 41.40% 初始资金，年化/回撤/夏普分母仍为初始资金`、
`ORDERS_UNEXECUTED|info|1 笔挂单未成交（末根 bar 无次 bar 可执行）`。

**我的独立重算**（`raw/10_independent_recompute.sql`，纯 SQL 直读 `kind='per_bar'|'fills'` 原始 payload + `config.fee` 契约，零应用代码）：

| 量 | 端点值 | 我的 SQL 重算 | 差值 / 口径 |
|---|---|---|---|
| `reachable_batches` | 43 | 43（`warmup=false` 且 `orders[].side='Buy'` 逐 bar 计数） | 0 |
| `batches_done` | 42 | 42（`fills[].side='Buy'` 逐笔） | 0 |
| `unexecuted_orders` | 1 | 43−42 = 1 | 0 |
| `last_bar_unfilled` | true | true（bar#422 有 Buy 意图，且为末根 in-range bar） | 一致 |
| `deployed_notional` | 41397.97208076086 | `Σ qty×price` = 41397.972081 | 0（仅 6 位取整展示） |
| `deployed_pct` | 0.4139797208076086 | 0.41397972 | 0 |
| 买入佣金 | （隐含） | `Σ max(额×0.025%, 5)` = **210.000000**（42 × 5.0，逐笔全部由**最低佣金**主导） | 42×5 |
| `cash_consumed` | 41607.97208076086 | 41397.972081 + 210 = 41607.972081 | 0 |
| `cash_consumed_pct` | 0.41607972080760863 | 0.41607972 | 0 |
| `round_trips_total` | 1 | `jsonb_array_length(trades)` = 1 | 0 |
| `round_trips_force_closed` | 1 | ForceClose Sell 成交 `bar_index=422` == `trades[0].close_bar=422` ⇒ 1 | 0 |

**口径声明**：`deployed_*` = 敞口（不含费用）；`cash_consumed*` = 资金占用（含佣金）——两端点字段确实分别命名、分别披露（无「41.40% vs 41.61%」同物异名）；佣金复算口径 = `max(成交额×费率, 最低佣金)`，与 `crates/backtest/src/fee.rs::FeeModel::commission` 同一公式（我核对了该实现，未另立公式）。

### 2.3 A4：同区间 `LumpSum{position_pct:1}` `sr_1789738272901_000004`

端点：`planned_tranches=null`、`deployed_pct=0.9997500624843787`、`cash_consumed_pct=0.9999999999999999`、`warnings=[]`（**无** `PARTIAL_DEPLOYMENT`）、`unexecuted_orders=0`。
我的 SQL 重算：`deployed=99975.006248 / pct=0.99975006`、佣金 `24.993752`、`cash=100000.000000 / pct=1.0`、`trades=1`、`force_closed=1` ⇒ 与端点逐字段一致（原始输出 `raw/10_independent_recompute.txt`）。

### 2.4 A5：双向 run `sr_1789044295239_000111` 三方自洽

我自己的三方（`/bars` 的 orders × `/fills` × `/result` 的 trades）断言（`raw/51_A5_three_way_selfcheck.txt`）：
```
bars=1209  intents: Buy=40 Sell=40  events(fill)=80
/fills: total=80 Buy=40 Sell=40 recorded=True
/result.trades.len=40   ForceClose fill events=0
[PASS] audit.batches_done == /fills Buy 数                     (40)
[PASS] audit.reachable_batches == /bars in-range Buy 意图数     (40)
[PASS] audit.unexecuted_orders == 意图-成交                     (0)
[PASS] audit.round_trips_total == /result trades 长度           (40)
[PASS] audit.round_trips_force_closed == close_bar 配对数       (0)
[PASS] audit.deployed_notional == Σ Buy qty*price              (Δ 9.3e-10)
[PASS] /fills 与 /bars events 成交数一致                        (80)
[PASS] /bars orders 与 /result per_bar orders 一致
target run: /bars in-range Buy 意图=43 vs audit.reachable_batches=43 -> PASS
```
反向抽查：**满仓 run（A4）不误报 `PARTIAL_DEPLOYMENT`**（`warnings=[]`）；**双向 run 不误报**（`warnings=[]`，40 回合全部非强平合成）——见 `raw/30_curl_A3_A4_A5.txt`。

### 2.5 MCP `bt_get_run_audit`（真机 SSE 调用，非单测）

`raw/60_mcp_probe.{sh,txt}`：SSE `/sse` 建会话 → `tools/list` = **35 个工具且含 `bt_get_run_audit`** → `tools/call` A3/A4 返回值与 REST **逐字段一致** → 未知 run ⇒ `isError:true`（`工具执行失败：运行不存在: sr_nope`）→ 缺参 ⇒ `-32602 run_id 必填`。
未自行核验的：`strategy_tools_enabled=false` 的运行时门禁（无运行时翻转入口），仅由我复跑其单测覆盖（`cargo test -p mcp` 7 目标全 ok）。

---

## 3. 端点可达性（自建实例）

线上 `:8081` 是**旧二进制**（§9-F4），因此我用**自己的真实进程**验证：
- 构建：`cargo build --bin eestock-app`（`raw/05_build_app.txt`，Finished in 5.10s；新二进制 `target/debug/eestock-app` = `895c516e0176e054a8086e0c5ac6d60e9fe8050d4935c747771b588fc92fbf4b`，`strings` 命中 `workbench_run_audit` / `bt_get_run_audit`）；
- 临时库（ADR-025）：`tmp_test026_1789750375`、`tmp_test026f_1789750578`、`tmp_test026g_1789750768`；
- 目标 run 事实行**从活库只读复制**（`raw/21_seed_runs.sh`，导出连接带 `PGOPTIONS='-c default_transaction_read_only=on'`；`strategy_run` 3 行 + `strategy_run_result` 3 行 + `strategy_run_bars` 8 行）；
- 自建实例 `127.0.0.1:8091`(REST) / `:8092`(MCP)，配置 `ws_poll_ms/alert_eval_ms` 拉长以免后台任务写入；启动日志 0 ERROR（`raw/22_app_8091_startup.log`）。

---

## 4. A2：突变反证（我自己做的两处推导突变；未 commit）

audit.rs 是**本批新增未跟踪文件**，`git diff` 对它不显示内容 ⇒ 还原证明用 **sha256 + `cmp` 逐字节**（`git status` 始终只显示 `?? crates/application/src/audit.rs`，tracked 文件 `git diff` 未变）。

| # | 突变（原地改推导） | 单测红 | 端点/回放红 | 输出 |
|---|---|---|---|---|
| M1 | `deployed_notional = Σ(f.qty*f.price)` → `Σ f.qty`（丢单价因子） | **5 红**：`target_run_shape_dca_underfilled`(expected 41397.97…, got 42)、`full_deployment_lumpsum_has_no_warnings`、`legacy_two_way_run_is_self_consistent`、`commission_follows_fee_contract_min_and_rate`、`partial_deployment_threshold_table` | **2 红**：`adr026_replay_target_run_matches_frozen_baseline`(deployed_notional=4368.98…)、`audit_endpoint_matches_recorded_facts_and_404_semantics`(`audit=181.79 vs 实况=19091.77`) | `raw/61_mutation_M1_red.txt`、`raw/62_mutation_M1_red_e2e.txt` |
| M2 | `round_trips_force_closed` 去掉 `f.bar_index == t.close_bar` 配对 | **1 红**：`force_closed_round_trips_match_by_close_bar`（left 3 / right 1） | —（未跑） | `raw/65_mutation_M2_red.txt` |

- 突变前 sha256：`acf65682af84283e492f8a1e922107392b0fdaa8dcde6c979d19fdd4ea011b90`（`raw/60_mutation_pre_sha256.txt`），与上游报告所载一致；
- 还原后 sha256 **同值**且 `cmp` 逐字节一致（`raw/63_mutation_restore_check.txt`、`raw/66_mutation_restore_and_green.txt`），复跑 `audit:: 18 passed`；
- **判据有效性结论**：判据对「单价因子」与「强平配对」两类推导都真能变红 ⇒ 非恒真断言。
- 观察（不改）：M2 只触发 1 个单测，说明「强平配对」规则当前仅单一用例把关。

---

## 5. 假绿排查（6 项，逐项给实测）

| # | 排查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 未知 run 是否错误 200+空对象 | **否**：404 `{"error":"运行不存在: sr_does_not_exist_999999"}` | `raw/41_curl_edge_probes.txt` P1 |
| 2 | run 存在但无结果 | **否**：404 `{"error":"运行 sr_verify_noresult_000002 尚无结果（未成功完成）"}`；`/result`、`/fills` 同码 | 同上 P2/P5 |
| 3 | `recorded` 真能表达事实源缺失 | **部分**：事实源**完全**缺失（chunked、无 per_bar 块、无 fills 块）⇒ `recorded=false` + 全零值 + **空 warnings**（正确、不伪造 0% 投入，且与 `/fills` 的 `recorded:false` 一致）；**但**「有 per_bar 块、无 fills 块」时 `/audit` 报 `recorded=true` 而同一 run 的 `/fills` 报 `recorded=false`（F1） | `raw/43_curl_recorded_false.txt`、`raw/41_curl_edge_probes.txt` P3+对照 |
| 4 | warnings 是否恒定空数组 | **否**：A3 = 3 条、A4 = 0 条、零成交 run = 1 条、突变副本 = 3 条；tracing 日志 `warnings=3/0/0/3/1` 与响应体一致 | `raw/30_*`、`raw/42_*`、`raw/95_observability_log.txt` |
| 5 | 审计数字是否只在 UI 层硬编码 | **否**：前端 `web/src` 尚无 `audit` 引用（§2.4 属阶段 3）；且我用**改数据反证**：把副本 run 的每笔 Buy `qty` 减半 ⇒ 端点 `deployed 41397.97208076086 → 20698.98604038043`（精确一半）、`cash 20908.98604038043`（= 名义 + 42×5 最低佣金），数字随库内事实走 | `raw/70_antihardcode.sql`、`raw/71_curl_antihardcode.json` |
| 6 | §4 可观测性（是否真落盘） | **是**：自建实例 JSON 日志实捕 `{"message":"workbench_run_audit","trace_id":…,"run_id":…,"deployed_pct":0.4139797208076086,"cash_consumed_pct":…,"recorded":true,"unexecuted_orders":1,"warnings":3,"elapsed_us":7436}` + 同名 span 字段，值与响应体一致 | `raw/95_observability_log.txt` |

---

## 6. 越界审计

- `git diff --cached` **空**；全程无 `git add/commit/checkout/stash/reset`（`raw/90_git_discipline.txt`）。
- 工作树与开工基线**唯一差异** = 本报告新增路径 `?? tester/evidence/20260919_adr026_backend_verify/`（`diff` 原文见 `raw/90_git_discipline.txt`）。测试实例日志写在证据目录内（`raw/22_*`、`raw/26_*`），未写入 `logs/`。
- **无引擎语义改动**：`crates/strategy-core/src/engine.rs` 的 diff 逐行核对 = 仅新增 `OrderReason::{as_str,parse}`、`apply_sell` 增 `reason` 形参（3 个调用点各传 `ForceClose`/挂单来源/`StopTrigger`）、清仓处写 `TradeDetail.reason`；成交量/净值/回合判定逻辑逐字未动（`raw/90_git_discipline.txt` 内 diffstat）。
- **无迁移**：`git status migrations/` 空；`ls migrations | tail` 未变。
- **表结构**：`strategy_run_bars` / `strategy_run_result` 未出现在改动清单（`raw/96_changed_files_sha256.txt`）。
- 本批改动文件 sha256 **与上游报告所载逐一相同**（`raw/96_changed_files_sha256.txt` 对照 `coder/evidence/20260919_adr026_backend/80_changed_files_sha256.txt`）⇒ 核验时点无文件漂移、无「报告后偷改」。
- `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` 虽显示 ` M`，但 mtime = **2026-09-17 13:34**、内容为 30m 右缘观测（`git diff | grep -c ADR-026` = **0**）⇒ 确属基线既有改动，非本批（上游报告的说法成立）。

---

## 7. 发现清单（我不修；逐条给可达性与证据）

| # | 严重度 | 发现 | 可达性 | 证据 |
|---|---|---|---|---|
| F1 | 中（潜伏） | 「chunked_v1 有 `per_bar` 块、无 `fills` 块」（ADR-024 P4→P6 之间的历史形态）时：`/audit` 报 `recorded:true`、`batches_done=0`、`unexecuted_orders=43`、`deployed=0`，而**同一 run** 的 `/fills` 报 `recorded:false`。tracing 也记 `deployed_pct=-0.0 warnings=3` | **当前活库不可达**（chunked_v1 仅 3 个 run，全部有 fills 块：`raw/97_live_zerofill_population.txt`）；形态可构造 | 构造 run `sr_verify_nofills_000001`：`raw/40_synth_edges.sql`、`raw/41_curl_edge_probes.txt` P3/P4 |
| F2 | 低（**活库可达**） | 零成交 run 的 `deployed_notional/deployed_pct/cash_consumed/cash_consumed_pct` 返回 **`-0.0`**（负零），warning 文本渲染为「名义投入 **-0.00%** 初始资金」 | **活库 18/377 run 命中**（374 legacy 中 18 个零买入成交） | `raw/42_curl_zerofill.txt`（真 run `sr_1789041364644_000065`：`"deployed_notional":-0.0`、`"message":"名义投入 -0.00% 初始资金…"`）；计数 `raw/97_live_zerofill_population.txt` |
| F3 | 中（测试质量） | 本批新增 `crates/web/tests/adr026_run_audit.rs` 在**默认并行**下 flake：实测 **9/50 变红（18%）**；串行 `--test-threads=1` **3/3 绿**；在**全新临时库**（无我构造的数据）上仍 **1/12 变红** ⇒ 与本核验的数据无关。两种失败：`audit_endpoint_emits_required_tracing_fields`（`:547` 捕获到的 span `run_id` 属另一并发用例的 run）+ `audit_recorded_false_when_facts_are_missing`（`:352` 插入 result 时 FK 23503，`Key (run_id)=(sr_adr026_chunked_nofacts) is not present`） | 每次默认 `cargo test -p web` 有 ~18% 概率红 | `raw/52_endpoint_suite_green.txt`、`raw/55_endpoint_suite_flake_20x.txt`、`raw/56_flake_full_outputs.txt`、`raw/57_endpoint_suite_serial.txt`、`raw/58_flake_freshdb_12x.txt` |
| F4 | 高（环境，阻断阶段 3） | 线上 `:8081/:8082` = **ADR-026 之前**的二进制：`/api/workbench/runs/{id}/audit` → `404 {"error":"not found"}`；MCP `tools/list` = **34** 个工具、**无** `bt_get_run_audit`；`/proc/2043164/exe` 已显示 `(deleted)`（我 `cargo build` 后磁盘文件被替换） | 面向前端阶段**必然命中** | `raw/91_live_8081_stale.txt`、`raw/92_live_8082_mcp_stale.txt` |
| F5 | 低（既有红） | `cargo test -p web` 唯一失败目标 = `tester_p5rect_verify::t_n1_http_every_400_is_structured_object`：期望 400、实得 201（`estimated_bars=292092 < GUARD_CONFIRM_BARS=500000`，该常量在 **HEAD 即 500_000**，tester 资产未同步） | 既有、与本批无关 | `raw/81_preexisting_failure_check.txt`、`raw/81b_preexisting_failure_detail.txt`（`git status` 该文件与本批 diff 均未含 `error.rs`/`resource_guard`） |
| F6 | 提示 | ADR-026 §2.4（前端披露）**尚未实现**：`web/src` 无 `audit` 引用、`web/dist` 无审计字样 ⇒ 本阶段不存在「UI 硬编码」问题；`recorded=false` 的前端「未记录」呈现要求须在阶段 3 落实 | — | §5-5 |

---

## 8. 环境动作与其影响面（诚实登记）

1. `cargo build --bin eestock-app` ⇒ **磁盘二进制被刷新**（`895c516e…`，含 ADR-026 端点）；**线上进程未重启**（旧 inode 仍在跑，故仍 404）。若主代理随后重启，即得新代码；若主代理自行重建后重启，亦等价。
2. 自建测试实例（`:8091/:8092`）已 **kill**，监听已释放，配置/CSV/日志临时文件已清理（`raw/93_instance_teardown.txt`）。
3. 三个 ADR-025 临时库全部 `DROP DATABASE … WITH (FORCE)`，回读库清单 = `{eestock, postgres}`、`tmp_` 残留 **0**（`raw/94_db_teardown.txt`）。
4. 未改 `/tmp/app_dev_8081.toml`、未改 `web/dist`、未触碰 PID 2043164（`ps -o pid,lstart` 与开工一致，`8081 healthz:200`）。

---

## 9. 残留不确定性

1. **A3/A4/A5 的端点证据取自自建实例（真实进程 + 真实临时库，事实行自活库只读复制）而非线上 `:8081`**——这是对「不重启线上 PID」这一仓内既有纪律的取舍（`tester/test/058_*` 把「线上 PID 未被触碰」列为验收项）。被验证的源码 sha256 与上游交付清单逐一相同（§6），故部署刷新后同一路径应产出相同数字；但「线上实测」须待 F4 处置后补一次 curl。
2. MCP `strategy_tools_enabled=false` 门禁未做运行时验证（无运行时翻转入口），仅复跑单测覆盖。
3. `TradeDetail.reason`（§2.3）我以「复跑引擎单测 + 逐行核对 diff」核验（`trade_detail_reason_records_liquidation_source` ok，`raw/80_reg_strategy-core.txt`），未另起一次全新 ensemble run 端到端复现；`crates/application/src/simlive.rs` 侧恒 `None`（诚实留白）符合 ADR 措辞。
4. F1 的历史形态在当前活库不可达（0 例），属潜伏风险；F2 的 18 例只统计「零买入成交」，未穷举其它可能触发 `-0.0` 的形态。
5. 未做超大 run（`MAX_BARS=200_000`）的延迟实测（ADR §6 已承认其为设计取舍）。
6. 未做 A6（前端真浏览器 E2E）——阶段 3 范围。

---

## 10. 原始证据清单（`raw/`，全部为我本次运行的原文）

| 文件 | 内容 |
|---|---|
| `05_build_app.txt` | `cargo build --bin eestock-app` 原文 |
| `10_independent_recompute.{sql,txt}` | 我的独立重算 SQL + 输出（A3/A4/A5 三 run 一行一 run） |
| `20/23/25_testdb_init*.txt` | 三个 ADR-025 临时库初始化原文（含只读播种日志） |
| `21_seed_runs.{sh,txt}`、`24_seed_runs_freshdb.txt` | 事实行只读复制脚本 + 回读 |
| `22/26_app_8091_startup*.log` | 自建实例启动与运行日志（含 §4 tracing 审计事件） |
| `30_curl_A3_A4_A5.txt` | A3/A4/A5 原始 `curl -i` 响应 |
| `40_synth_edges.{sql,txt}`、`41_curl_edge_probes.txt` | 假绿探针（未知 run / 无结果 run / 无 fills 块） |
| `42_curl_zerofill.txt` | 活库真实零成交 run 端点响应（F2） |
| `43_curl_recorded_false.txt` | 事实源完全缺失时 `recorded=false` 端点响应 |
| `50_A1_unit_green.txt` | A1 纯函数 18 passed |
| `51_A5_three_way_selfcheck.txt` | A5 三方自洽 8 断言 |
| `52..58_*` | 新增端点套件 flake 统计（1 次红原文 / 3×并行 / 8×并行 / 20×并行 5 红 / 2 次红全文 / 3×串行 / 全新库 12×） |
| `60_mcp_probe.{sh,txt}` | MCP SSE 真机调用（tools/list 35 + tools/call + isError + -32602） |
| `60..66_mutation_*` | 突变前后 sha256、M1/M2 红输出、还原校验与复绿 |
| `70_antihardcode.{sql,txt}`、`71_curl_antihardcode.json` | 反硬编码（改库内 qty ⇒ 端点值随之变） |
| `80_reg_*.txt`、`81/81b/82_*` | 五个受影响 crate 回归原文 + 既有红定位 + 汇总 |
| `90_git_discipline.txt`、`96_changed_files_sha256.txt` | git 纪律、改动清单 sha256 |
| `91/92_live_*_stale.txt` | 线上 `:8081` REST 404、`:8082` MCP 34 工具（F4） |
| `93/94_teardown*.txt`、`95_observability_log.txt`、`97_live_zerofill_population.txt` | 实例/库 teardown 回读、tracing 原文、活库零成交 run 计数 |

---

## 11. 裁决

A1–A5 与 A7（既有套件）**独立实测通过**；F1/F2 为实现小缺陷、F3 为新测试 flake、F4 为线上未部署、F5 为既有红。后端功能本身可被前端阶段消费（前提是先处置 F4）。

VERDICT: PASS
