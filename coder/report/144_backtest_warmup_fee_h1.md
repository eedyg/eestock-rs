# 144 · 回测引擎与试算口径批（I-6 H1 / I-2 warmup / I-3 fee·policy·capital）

> 报告文件位置（self-reference）：`coder/report/144_backtest_warmup_fee_h1.md`
> 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`
> 日期：2026-09-12 ｜ 状态：**非 MCP 层已落地并测试全绿；MCP 层待架构师放行文档写入权**（见 §7）
> 决策依据：用户 2026-09-12「全按推荐进行」（D3/D6）+ 架构师裁决（I-2 方案 A / I-3 选 1 + 两条硬要求 / H1 归日线档）。
> 取证依据：`tester/report/001_i2_i3_mcp_platform_repro.md`（§1 I-2、§2 I-3）。

---

## 1. 变更清单（工作区改动，未 stage）

### I-6（D3）引擎支持 H1
| 文件 | 变更 |
|---|---|
| `crates/backtest/src/types.rs` | `backtest::Period` 增 `H1`；`bars_per_year` 增 `H1 => 252×4`；新增 `bars_per_year_known_factors` 单测 |
| `crates/application/src/bar_map.rs` | `parse_period` 增 `"H1"`（删「H1 拒绝」分支） |
| `crates/application/src/simlive.rs` | `bt_period_from_str` 增 `H1`；`bt_bar_seconds` 增 `H1 => 3600`（exhaustive match） |
| `crates/application/src/strategy.rs` | 试算区间档：`D1 | H1 => 5 年`（H1 归日线档，架构师批准） |
| `crates/application/src/workbench.rs` | 工作台区间档：`D1 | H1 => 5 年`（与试算同口径） |
| `crates/web/src/workbench.rs` | REST `/api/workbench/runs` period 白名单增 `H1` |
| `design/08-backtest/01-engine-adr.md` | §3 周期口径增 H1 + 理由 |
| `design/12-strategy-system/01-adr.md` | §13.5 区间上限标注 H1 |

### I-2（D6）warmup 语义显式化
| 文件 | 变更 |
|---|---|
| `crates/strategy-core/src/engine.rs` | `EnsembleConfig` 增 `warmup_bars: usize`；`BarRecord` 增 `warmup: bool`；循环对 `i < warmup` 隔离：仍逐 bar 评分，但不执行挂单/止损/Policy、不产订单、不计净值；`per_bar` 全量记录并标记 |
| `crates/application/src/bar_map.rs` | 新增 `warmup_lookback(period, warmup_bars)`（按周期时长×占空比估算前置取数窗口） |
| `crates/application/src/strategy.rs` | `TestRunRequest.warmup_bars`、`ScorePoint/SignalPoint.warmup`、`TestRunResponse.warmup_requested/warmup_effective`；`test_run` 单次拉取 `[warmup_start,to)` 后按 `from` 切分（截取最近 `warmup_bars` 根作预热）；`run_pure_score`/`run_sim_position` 透传 |
| `crates/application/src/workbench.rs` | `SubmitRunReq.warmup_bars`（默认 `DEFAULT_WARMUP_BARS=250`）；`submit` 前置拉取+切分并 `probe.warmup_bars=warmup_effective`；钉住 config 增 `warmup_requested/effective`；`bar_record_json` 增 `warmup` |
| `crates/application/src/simlive.rs` | sim-live 回测对比显式 `warmup_bars: 0`（与活会话「从会话起算」口径一致，避免改变既有对比语义） |
| `crates/web/src/strategies.rs` / `workbench.rs` | 试算/工作台 REST DTO 增可选 `warmup_bars`（缺省 250） |
| `design/12-strategy-system/01-adr.md` | §13.5.1 warmup 口径（方案 A 完整语义） |

### I-3（D6）试算参数组
| 文件 | 变更 |
|---|---|
| `crates/application/src/fee.rs` | 新增 `fee_model_to_json(&FeeModel)`（**生效** fee 回显，含 `stamp_duty_pct`） |
| `crates/application/src/strategy.rs` | `TestRunRequest` 增 `fee/policy/initial_capital`；`test_run` 经 `to_fee_model` + `ExecutionPolicy::from_value` + `validate` + capital 校验；`run_sim_position` 使用之；`TestRunResponse.fee` 回显生效 fee |
| `crates/application/src/workbench.rs` | 钉住 `config.fee` 改为**生效** fee（`fee_model_to_json`）；预设 config 支持可选 `warmup_bars` 且钉住生效 fee |
| `crates/web/src/strategies.rs` | 试算 REST DTO 增可选 `fee/policy/initial_capital`（缺省 ADR bt-1 / LumpSum 全仓 / 100000） |
| `design/08-backtest/01-engine-adr.md` §4 / `design/12-strategy-system/01-adr.md` §13.5.1 | 写明「缺省 0.05 为股票口径兼容值，ETF/LOF 须显式传 0」+ fee 回显要求（I-3 硬要求②） |

> `crates/mcp/src/tools.rs`（tangle 生成物）与 `design/07-app-plane/01-mcp.md` 的 MCP 侧改动**未做**（协议暂缓，见 §7）。

---

## 2. 架构对齐（分层）

- **backtest（Domain 纯逻辑）**：`Period::H1` 为领域枚举扩展，无 IO。
- **strategy-core（Domain 纯逻辑）**：`warmup_bars` 是引擎执行语义（执行层唯一规则：warmup 段不执行 Policy），符合 ADR §13.1「引擎只保留最笨的统一规则」。
- **application（应用层）**：period 解析、warmup 前置取数、fee/policy/capital 校验与映射（`to_fee_model` 既有落位），DI 端口不变。
- **web / mcp（Presentation）**：仅参数透传与缺省填充；MCP 侧待放行。
- **design/ 事实源**：08-backtest ADR、12-strategy-system ADR 同步（非 tangle 段，纯叙述）。

未新增依赖、未改端口、未改层边界。

---

## 3. 解决的问题

1. **I-6**：消除「`get_kline` 支持 1h 但回测/试算拒绝 H1」的双口径（数据层 `kline_accurate_1h` cagg 早已存在）。
2. **I-2**：修复「宿主只取 `[from,to)` bar、前 `window−1` 根恒 50/Hold 且计入 scores/signals」的静默预热失真（tester §1）。现前置历史预热 + 显式标记 + warmup 不计绩效，两种模式同口径。
3. **I-3**：修复「试算无 fee/投资模式/资本参数，硬编码 LumpSum+股票印花税」的绩效误导（tester §2）。现与工作台同源口径，并回显生效 fee。

---

## 4. 实现要点（批准架构内的取舍）

- **warmup 单次取数 + 按 `ts` 切分**：服务层只调用一次 `BacktestBarRead::bars([warmup_start,to))`，再按 `b.ts >= from` 切分（`warmup_effective = min(前置可得根数, requested)`）。避免两次查询、天然升序。
- **`warmup_lookback` 估算**：按周期 bar 秒数 × 占空比系数（日内 ×30、日线 ×3）向上取整，宁可多取（调用方只截取最近 `warmup_bars` 根）。理由：端口无「取 N 根」能力，只能用时间窗；上偏保守。
- **`bar_count` 语义**：= 处理总 bar 数（含前置 warmup）== `scores.len()`；区间样本数 = `bar_count − warmup_effective`。此口径写入结构体文档与 ADR。
- **silent shortfall 可见**：`warmup_effective < warmup_requested` 即历史不足（架构师硬要求 c）。
- **fee 回显**：`fee_model_to_json` 用于试算响应与工作台钉住 config，使「缺省 0.05 被应用到 ETF」在结果里可见（I-3 硬要求①）。
- **sim-live 对比 `warmup_bars:0`**：活会话评分从会话起算，对比回测保持同口径，不改既有行为。

---

## 5. 测试覆盖与证据

新增/更新测试（**原测试断言零删改**；唯一例外见 §6 说明）：

| 测试 | 位置 | 断言 |
|---|---|---|
| `bars_per_year_known_factors` | `backtest/src/types.rs` | M1/M5/M15/**H1**/D1 年化因子 |
| `warmup_prefix_scores_but_never_executes_or_counts_metrics` | `strategy-core/tests/engine.rs` | 前 3 根 warmup、仍评分、不产订单/不成交、nav/drawdown 仅 in-range、首成交在 in-range |
| `warmup_zero_is_legacy_behaviour` | 同上 | warmup=0 向后兼容 |
| `test_run_h1_period_supported` | `application/tests/strategy.rs` | H1 pure_score/sim_position 接受、区间档 |
| `test_run_warmup_prefix_marked` | 同上 | requested/effective、逐 bar warmup、成交不落 warmup |
| `test_run_warmup_reports_shortfall` | 同上 | effective < requested |
| `test_run_fee_echo_and_stamp_duty_effect` | 同上 | 缺省 0.05 回显；ETF 显式 0 → stamp_duty=0；非法 fee→400 |
| `test_run_policy_and_capital_effect` | 同上 | Dca vs LumpSum shares；capital 放大；非法 policy→400 |
| `submit_accepts_h1_and_rejects_unknown_period` | `application/tests/workbench.rs` | H1 接受、W1 拒绝 |
| `submit_warmup_marks_prefix_and_pins_effective_fee` | 同上 | config warmup_requested/effective、生效 fee、per_bar warmup、净值仅 in-range |
| （MCP 测试增补） | `design/07-app-plane/01-mcp.md` 测试 chunk | 待放行（§7 草案 §4） |

**命令与结果**（全部在工作区执行，未 stage）：
- `cargo test -p backtest -p strategy-core -p application` → **全绿**（backtest 21 / strategy-core 32+25+6+3 / application lib 11 + simlive 55 + strategy 38 + workbench 16）。
- `cargo test -p web --lib` → 43 passed。
- `cargo build -p application -p web -p backtest -p strategy-core` → 0 warning。
- MCP 侧未编译通过：`crates/mcp/src/tools.rs` 尚缺本批新字段初始化 + 存在 **A1 在制** 的 `KlineBarView` 编译错（非本批改动，A1 收口）。

---

## 6. I-2 对既有回测结果的可比性影响（重要）

- **所有经统一 ensemble 引擎（试算/工作台/sim-live 对比）的历史绩效数字，在本批后不可与旧数字逐位比较**：
  旧行为前 `window−1` 根恒中立且计入统计；新行为前置预热且 warmup 不计绩效 → 信号序列、成交明细、净值/回撤/8 项绩效均会变化。
- 影响幅度：与指标窗口/区间长度相关（tester §1.4–1.5：短窗口 21%–53%、D1 3 月 29%）；窗口越大/区间越短影响越大。
- 可比性边界：
  - 同批内 **新 vs 新** 可比（确定性、无 RNG）；
  - **新 vs 旧** 不可比；需要横向对照时用相同 `warmup_bars` 复跑双方，或显式传 `warmup_bars:0` 复现旧行为。
  - 产出已带 `warmup_requested/effective` + 逐 bar `warmup`，可自证口径。
- **纪律**：`tester/report/001` §2「平台回测绩效数字在 I-2/I-3 验收前冻结使用」——本批修复 + tester 独立验收后方可解冻。

---

## 7. MCP 层暂缓（协议）+ 交付草案

架构师裁决：A1 持 `design/07-app-plane/01-mcp.md` 写入权，串行化，**暂不放行**。
本批 MCP 侧待办已做成完整**可粘贴补丁草案**：`coder/report/144_mcp_patch_draft.md`
（含 `strategy_test_run` 增 `warmup_bars/fee/policy/capital` schema+handler、`bt_run_ensemble` 增
`warmup_bars` schema+handler、MCP 测试断言清单、放行后执行序）。

放行后：read-modify-write 应用草案 → `entangled tangle` → `cargo test -p mcp --lib` +
`cargo check --workspace --all-targets` → 确认保留 A1 的 list_symbols / get_kline / strategy_list 改动。

> **`check-tangle` 未运行**：`scripts/check-tangle.sh` 会执行 `entangled tangle` 全量再生
> `crates/mcp/src/tools.rs`，与 A1 的写入权冲突（且会重写其未完成改动）。按「不代改 A1 在制品」
> 处置，待放行且 A1 回报文档/tangle 到达编译可通过状态后统一执行。

---

## 8. 残留风险 / 边界

1. **MCP 层未收口**（阻塞于写入权）；`crates/mcp` 当前不可编译（本批字段 + A1 在制错）。
2. **前端**（`web/src/features/...`：TestRunPanel/ConfigPanel period 选项）未加 H1、未加 fee/policy/capital/warmup UI——**本轮范围限定引擎与接口**；前端接入另行排期（不影响接口正确性，UI 缺省走服务端默认值）。
3. **`warmup_lookback` 为估算窗口**：极端缺口/停牌可能使可得前置 < requested（由 `warmup_effective` 显式暴露，非静默）。
4. **`bar_count` 语义变更**（含 warmup）：已写入结构体文档 + ADR；调用方按 `warmup_effective` 拆分。
5. **I-3 按标的类型推断印花税**：架构师另立 D11（symbols/Registry 增 type），本批不做；现由显式 `stamp_duty_pct` 承担。
6. **`cargo fmt` 事故已修复**：本批过程中误对本仓（非 rustfmt 格式基线）运行 `cargo fmt` 产生大量无关格式改动，已用「HEAD 基线 + rustfmt 反向补丁」逐文件还原，最终 diff 仅含本批语义改动（见 §1 numstat）。

---

## 9. 文件位置自引用

本报告：`eestock-rs/coder/report/144_backtest_warmup_fee_h1.md`
MCP 草案：`eestock-rs/coder/report/144_mcp_patch_draft.md`

---

## 10. 追加：MCP 层统一收口（2026-09-12 10:33Z，架构师释放文档写入权后）

> 架构师裁决：A1 因上下文耗尽被中断，`design/07-app-plane/01-mcp.md` 写入权统一交给本 worker；
> 本段记录 MCP 层（A1 遗产 + A2 的 H1 + 本批 I-2/I-3）的收口结果。

### 10.1 应用草案（I-2/I-3）
`coder/report/144_mcp_patch_draft.md` 已全量应用（见 §10.3）：
- `strategy_test_run` inputSchema 增 `warmup_bars`(int,默认250) / `fee` / `policy` / `capital`；handler 解析并以缺省填 `TestRunRequest`（修复 A1 合并后编译错）。
- `bt_run_ensemble` inputSchema 增 `warmup_bars`；handler 透传 `SubmitRunReq.warmup_bars`。
- 常量 `DEFAULT_TEST_RUN_WARMUP_BARS=250` / `DEFAULT_TEST_RUN_CAPITAL=100000` / `default_test_run_fee`。
- 新增 MCP 契约测试：`strategy_test_run_fee_policy_capital_channel`、`bt_run_ensemble_schema_has_warmup_bars`。

### 10.2 补齐 A1 未竟项（判据：tangle 后 `cargo test -p mcp` 失败）
1. **get_kline schema 块**（文档 ~435-450）：补 `from`/`to` 属性；`limit` 描述「上限 1000」→「上限 10000（超上限 → 参数错误并提示分段取数）」，并更新工具描述。
2. **`MAX_LIMIT: i64 = 1000` → `10000`**。
3. **get_kline handler 落地 I-5/I-10 契约**：`parse_kline_bound`（ISO 日期 Asia/Shanghai 日界 / RFC3339 归一 UTC）；`from` 闭 / `to` 开（日期形式 to 含整日 → 次日 00:00 CST）；超上限 `-32602`（含「10000」「分段」提示，不静默封顶）；有 from 时多取一根判定「区间根数 > limit」→ 工具错误（不静默截断）；无 from/to 时保持旧 payload 形状（keys=bars/code/period，向后兼容）；边界回声 `from`/`to`（归一 UTC）。
4. **list_symbols**：schema（无 required）+ dispatch + handler（`symbols_with_latest` 同源；latest={ts,last,change_pct}；按 code 升序；注册表不可读 → isError fail-closed）。
5. **strategy_list `include_source`**：schema（boolean）+ handler（默认剔除 `version.code` 瘦身；true 全量；非 boolean → -32602）。
6. **strategy_test_run `symbol` 注册校验（I-9/D9）**：`ensure_registered` 前置（未注册/注册表不可读 → isError，含被拒 code 与「未注册」文案）。
7. **A1 的 `MockKline`/mocks 变更**（`with_bars`/`with_symbols`/`bars_override`/`symbols_override`）：A1 已写入文档，tangle 后保留（本 worker 未改语义）。

### 10.3 冲突点（请架构师裁决）
- **`list_symbols` 排序方向自相矛盾（A1 遗留）**：
  - 单测 `list_symbols_returns_registered_with_status_and_latest` 原断言 `syms[0]=="600000"`（即 [600000,518880]），但同函数注释写「按 code 升序」（升序应为 [518880,600000]）；
  - 端到端 `list_symbols_matches_real_symbols_registry` 用 `want.sort()`（升序）比对 handler 输出 → 要求升序；
  - web 契约（`crates/web/src/rest.rs:92`）注明 `symbols_with_latest 按 code 序`（升序）。
  - **处置**：以 web 同源「按 code 升序」为准实现（handler `syms.sort_by(code asc)`）；将单测两处断言改为升序对应位置（仅顺序修正，未改任何语义断言），并在测试内注明冲突来源。如架构师裁定应为降序，请指示（则需同步改端到端对比方向）。

### 10.4 tangle 保留 A1/A2 改动的证据
- `entangled tangle` 仅写 `crates/mcp/src/tools.rs`；**幂等**：`cp` 后再 tangle，`diff -q` 无差异（doc == 生成物）。
- A1 遗产仍在生成物：`list_symbols`（schema L100 / dispatch L480 / handler L703）、`include_source`（L267/L1056）、`ensure_registered` 用于 `strategy_test_run`（L1213）、`MAX_LIMIT=10000`（L35）、`parse_kline_bound`（L561）；`crates/mcp/src/mocks.rs` 的 `with_bars`/`with_symbols` 保留。
- A2（本批 H1）仍在生成物：`valid_bt_period` = `M1|M5|M15|H1|D1`（L1015）；`strategy_test_run`/`bt_run_ensemble` schema period enum 含 H1。
- A1 未竟的 get_kline schema 与 limit 描述已补齐（§10.2）。

### 10.5 验证（全绿）
- `cargo test -p mcp`：lib **61** + `mcp_protocol` **2** + `mcp_tools_db`(真实 TimescaleDB) **8** + `zz_tester_i1_acceptance` **1** —— 全绿。
- `cargo check --workspace --all-targets`：0 error / 0 warning。
- `cargo test -p backtest -p strategy-core -p application -p web --lib`：全绿（backtest 21 / strategy-core lib 32 + engine 25 + … / application lib 11 + simlive 55 + strategy 38 + workbench 16 / web lib 43）。
- `./scripts/check-tangle.sh`：因工作区存在未提交改动，`git diff --quiet` 必然非空（架构师已确认「报 diff 属预期」）；tangle 幂等性经上条独立验证。
- 未 git add/stage（架构师统一提交）。
