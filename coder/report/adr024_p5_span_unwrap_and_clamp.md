# ADR-024 P5 —— 去日历天数档 + 区间收缩 + 试算同口径 + 结构化错误 + 进度预扫描（coder 交付报告）

- **本报告文件位置**：`coder/report/adr024_p5_span_unwrap_and_clamp.md`
- 角色：coder（实现 + TDD + 证据）；验收由 tester 独立执行
- 阶段：ADR-024 **P5**（`design/16-backtest-scalability/04-implementation-plan.md` §2 P5）
- 状态：**实现完成、本批测试全绿、未 commit（仅 `git add`）**
- 说明：本轮 run 撞 30 分钟硬上限被中断，**只差写报告**；报告在此补齐。中断前所有验证均已落盘为 `coder/evidence/adr024_p5/01–12`。

---

## 0. 一句话结论

按架构师定值落地：**物理删除** `D1_MAX_SPAN_DAYS`/`MINUTE_MAX_SPAN_DAYS`/`MAX_BARS`；改以 `MAX_BARS_GUARD=2_000_000`（硬拒）+ `GUARD_CONFIRM_BARS=200_000`（`confirm:true` 放行）的资源护栏；区间按**服务口径并集**（accurate ∪ 兜底）收缩并在提交/执行两端回显；试算与工作台**同口径**（去档 + 同收缩 + 截断改**均匀抽样保首尾**）；400 改为**结构化错误**（`{error:{code,message,detail}}`）可被前端编程消费；进度 `count(*)` 预扫描 + 降级口径可见。前端最小配套（日期控件 min/max 联动、`clamped` 提示条、`resource_guard` 二次确认、结构化错误消费）齐备。

**唯一改判**：R10「取数 ~50 µs/bar ⇒ 全历史外推 ~40 s」被本批实证**推翻**——取数为**次线性**，满历史 M1（861,093 bar）取数仅 **3,500 ms（4.06 µs/bar）**，详见 §6。

---

## 1. 改动清单（分层）

> 差异基线 = 冻结 index（P0–P6 交付态）；下表为 P5 在**工作区**的增量（`git diff` 工作区 vs index）。
> 共 **29 个已跟踪文件 + 1 个新文件**（`crates/application/src/error.rs`），+1517 / −185。

### 1.1 domain（端口契约，加法）
| 文件 | 改动 |
|---|---|
| `crates/domain/src/ports.rs` | 新增 `AvailableRange { from, to }`（半开 `[from,to)`，`to = max_ts + 1s`）；`BacktestBarRead` 增 `available_range()` / `count_bars()`（**带默认实现**：由 `bars()` 派生——生产实现 storage 必须覆写，mock/既有实现零改动兼容）；`StrategyRunView` 增 `requested_from/to`、`clamped`、`clamp_reason`、`estimated_bars`、`bars_total`、`result_format`（P5 §3.1 回显） |

### 1.2 storage（基础设施实现）
| 文件 | 改动 |
|---|---|
| `crates/storage/src/backtest.rs` | 覆写 `available_range()`：**服务口径并集** min/max SQL（`union_avail_sql` = `accurate ∪ 兜底`，与 `period_range_sql`/`merged_sql` 逐层对应；M1 走 `kline_merged`）；覆写 `count_bars()`（`count(*)` 包 `period_range_sql`，同源口径） |
| `crates/storage/src/workbench.rs` | `run_from_tuple` 从 `config` 快照回读 `requested_*`/`clamped`/`clamp_reason`/`estimated_bars`（旧 run 缺字段 → 回退 effective/false；`bars_total`/`result_format` 恒 `None`，由 `/brief`/`/result` 提供） |

### 1.3 application（应用层）
| 文件 | 改动 |
|---|---|
| `crates/application/src/error.rs` | **新增**：`StructuredError{code,message,detail}` + `MAX_BARS_GUARD`/`GUARD_CONFIRM_BARS` + `estimate_secs()`（**含每 run 固定成本项**）+ `guard_bars()` + `range_empty_error()` |
| `crates/application/src/lib.rs` | 注册 `pub mod error;` |
| `crates/application/src/workbench.rs` | **删除** `MAX_BARS`/`D1_MAX_SPAN_DAYS`/`MINUTE_MAX_SPAN_DAYS` 引用与日历档校验；`submit()` 改为：可得区间收缩 → `count(*)` 预扫描 → 资源护栏 → 读 bar → **执行时以真实首末 bar 为最终收缩**；`SubmitRunReq.confirm`；config 钉住 `requested_*`/`clamped`/`clamp_reason`/`estimated_bars`/`progress_prescan`；`from_ts/to_ts` 存 **effective**；`build_brief` 回读真值；新增 `available_range()` 只读方法（供新端点）；re-export 护栏/估算/错误 helper |
| `crates/application/src/strategy.rs` | **删除** `D1_MAX_SPAN_DAYS`/`MINUTE_MAX_SPAN_DAYS`；`test_run()` 同口径（并集收缩 + 预扫描 + 护栏 + 执行时收缩）；评分/信号**截断改均匀抽样（保首尾）**（`sample_mask`，去 `truncated.scores` 丢尾语义）；`TestRunRequest.confirm`；响应增 `downsampled`/`original_points`/`requested_*`/`effective_*`/`clamped`/`clamp_reason`/`estimated_bars` |
| `crates/application/src/simlive.rs` | sim-live「回测一下」内部调用补 `confirm:false`（短区间，不带二次确认） |

### 1.4 web（表现层）
| 文件 | 改动 |
|---|---|
| `crates/web/src/workbench.rs` | `map_svc_err` 增 `StructuredError` → `{"error":{code,message,detail}}`；`WorkbenchSubmitReq.confirm`（`#[serde(default)]`）；**新端点** `GET /api/workbench/available_range?symbol=&period=`（`available_range` handler + `AvailableRangeQuery` DTO） |
| `crates/web/src/strategies.rs` | `map_svc_err` 增 `StructuredError` 分支；`TestRunReq.confirm` |
| `crates/web/src/lib.rs` | 路由注册 `.route("/api/workbench/available_range", get(workbench::available_range))`（**tangle 生成物**，已同步文档，见 §5.4/§8） |

### 1.5 MCP
| 文件 | 改动 |
|---|---|
| `crates/mcp/src/tools.rs` | `strategy_test_run`/`bt_run_ensemble` 增可选 `confirm`（boolean）+ 描述去「日历档上限」表述（改「按可得范围自动收缩」/「均匀抽样」）；解析 `confirm` 透传；测试 mock 覆写 `available_range`（宽区间） |

### 1.6 测试
| 文件 | 改动 |
|---|---|
| `crates/application/tests/workbench.rs` | 旧 `submit_rejects_span_limits_400` → **反转**为 `submit_accepts_long_spans_no_calendar_cap`（M15×259d/M1×1y/M30×2y 必须 201）；旧 `>20 万 bar → 400` → `range_empty` 结构化；`p4_brief_fields` 更新为 P5 真值；新增 P5 组（收缩边界/护栏/预扫描降级/结构化形状/估算固定项/brief 回显，共 7 例） |
| `crates/application/tests/strategy.rs` | 旧 `test_run_interval_limits` → 反转 + 新增 uniform sampling / range_empty 结构化；`test_req` 补 `confirm` |
| `crates/application/tests/simlive.rs` | `MockCompareBars` 覆写 `available_range`（mock 以 `from` 相对生成 bar，默认派生的 min/max 落在 `MIN_UTC`） |
| `crates/application/tests/adr024_p2b_tryrun.rs` | `confirm:false`（编译） |
| `crates/storage/tests/backtest.rs` | 新增 live-DB **并集口径**用例（构造「accurate 滞后、兜底有数据」）+ `None` 用例 + **R10 取数标度量化** |
| `crates/web/tests/api_workbench.rs` | 旧「M1×94 天 → 400」→ 201 + `clamped` 回显；`p4_result` 请求右端对齐可得边界；新增 `p5_available_range_endpoint_and_structured_errors` |
| `crates/mcp/tests/d11_fee_profile_e2e.rs` | `confirm:false`（编译） |

### 1.7 前端
| 文件 | 改动 |
|---|---|
| `web/src/api/types.ts` | `ApiError` 增 `code`/`detail`（`ApiErrorDetail`）；`WorkbenchRunView` 增 P5 字段（可选，容差消费）；`WorkbenchSubmitReq.confirm`；新增 `WorkbenchAvailableRange`；`StrategyTestRunResp` 增抽样/收缩字段 |
| `web/src/api/client.ts` | `request()` 解析**结构化错误** → `ApiError.code/detail`；新增 `getWorkbenchAvailableRange()` |
| `web/src/api/mock.ts` | run 视图补 P5 字段；`mockBriefOf` 用真值；新增 `getWorkbenchAvailableRange` mock |
| `web/src/features/workbench/store.ts` | `clampNotice`（`clamped:true` 提示条）+ `guardPrompt`（`resource_guard` 二次确认）+ `confirmGuard()`/`dismissGuard()` |
| `web/src/features/workbench/ConfigPanel.tsx` | 日期控件 `min/max` 随「标的+周期」联动（`useEffect` → `loadAvailableRange`）+ 可用区间文案 + 收缩提示条 + 护栏二次确认 UI |
| `web/src/features/workbench/WorkbenchPage.tsx` | 装配新 props |
| 测试 | `ConfigPanel.test.tsx`（min/max 联动 / 提示条 / 二次确认）、`client.test.ts`（结构化错误 + 新端点）、`mock.test.ts`（available_range / 回显字段） |

### 1.8 文档（tangle 回写；代码侧 → 文档）
| 文件 | 改动 |
|---|---|
| `design/02-domain/contracts.md` | 回写 `ports.rs` 端口增项（+54） |
| `design/07-app-plane/00-web-api.md` | 回写新路由 + 表格（端点行 / `POST /runs` 语义 / `/brief` 说明） |
| `design/07-app-plane/01-mcp.md` | 回写 MCP schema 增 `confirm` / 描述变更（+42） |

> 由 `./scripts/stitch.sh` 沙箱 scoped 回写 + round-trip 校验（**未动任何实现侧生成物**）；`check-tangle` 复验通过（证据 12）。

---

## 2. 逐项红→绿（原始输出见 `coder/evidence/adr024_p5/`）

> 纪律说明：本轮为**测试先行 + 反向扰动双证据**。凡"红"以「故意破坏实现 ⇒ 用例必红」的反向扰动原样留档（比单纯编译红更强）；"绿"为恢复后的通过输出。全部原始输出落盘，本报告直接引用。

| # | 条目 | 红（反向扰动） | 绿 | 证据文件 |
|---|---|---|---|---|
| 1 | **可得区间服务口径并集**（D3） | accurate-only ⇒ `to=02:00:01Z ≠ 02:30:01Z` FAIL | union 恢复 ⇒ 3/3 PASS | `01_…accurate_only_red.txt` / `02_green_union_restored.txt` |
| 2 | **去日历天数档**（M15×259d/M1×1y/M30×2y 必须 201） | 重新引入 93 天档 ⇒ FAIL（`反向扰动：区间超限`） | 恢复 ⇒ 40/40 workbench PASS | `05_reverse_span_cap_red.txt` / `04_application_p5_green.txt` |
| 3 | **资源护栏**（≥20 万需 confirm；>200 万硬拒） | 禁用 `guard_bars`（恒 `None`）⇒ `unwrap_err` on `Ok` FAIL | 恢复 ⇒ `p5_resource_guard_confirm_and_hard_reject` ok | `06_reverse_guard_disabled_red.txt` / `04_…green.txt` |
| 4 | **区间收缩**（左/右/两端/恰端点/无交集） | 关闭收缩（eff=requested）⇒ `clamped=true` 断言 FAIL | 恢复 ⇒ `p5_clamp_left_right_both_and_exact` ok | `07_reverse_clamp_disabled_red.txt` / `04_…green.txt` |
| 5 | **试算同口径 + 均匀抽样** | —（断言由旧「丢尾/400」**反转**而来；见 §2.1） | strategy 15/15 PASS（含 `test_run_pure_score_uniform_sampling`：50,050 bar → 50,000 点、首尾保留、`truncated.scores=false`） | `04_application_p5_green.txt` |
| 6 | **结构化错误可编程消费** | — | `p5_structured_error_shape_json` + web 端 `p5_available_range_endpoint_and_structured_errors`（400 body `error.code=range_empty` + `detail.available_from`） | `04_…green.txt`（应用）/ 见 §5.2（web） |
| 7 | **进度预扫描 + 降级可见** | — | `p5_prescan_degraded_path_visible`（count 失败 ⇒ `estimated_bars=null` + `config.progress_prescan="ts_norm"`；成功 ⇒ `"count"` + 精确值） | `04_…green.txt` |

### 2.1 旧断言反转明细（反假绿条款 #4：不得简单删除）
| 旧断言 | 位置 | 处理 |
|---|---|---|
| `D1 超 5 年 → 400` / `M1 超 3 个月 → 400`（工作台） | `application/tests/workbench.rs::submit_rejects_span_limits_400` | **改写**为 `submit_accepts_long_spans_no_calendar_cap`（M15×259d / M1×1y / M30×2y ⇒ `201 Queued`；`from>=to` 仍 400） |
| `D1/H1 超 5 年 → 400`（试算） | `application/tests/strategy.rs::test_run_interval_limits` / `test_run_h1_period_supported` | **改写**为「必须可试算 + 回显 `clamped`/`effective`/`estimated_bars`」 |
| `空 bar → 字符串 400「无 K 线数据」` | `application/tests/strategy.rs::test_run_version_source_and_bad_inputs` | **改写**为结构化 `range_empty` |
| `>20 万 bar → 400`（工作台） | `application/tests/workbench.rs::submit_rejects_empty_or_oversize_bars_400` | **删除**该断言，替换为「无数据 ⇒ `range_empty`」；`>20 万` 由 P5 护栏用例（预扫描计数）覆盖 |
| `M1×94 天 → 400`（web） | `web/tests/api_workbench.rs::submit_validation_error_matrix` | **改写**为 `201` + `clamped=true` + `clamp_reason="data_range"` + `to_ts`/`requested_to` 回显 |
| `clamped=false / estimated_bars=null`（P4 占位真值） | `application/tests/workbench.rs::p4_brief_fields`、`web/tests/{api_workbench,tester_p4_endpoints_indep}.rs` | **更新**为 P5 真值（`clamped` 由请求与可得边界决定；`estimated_bars = count(*)`） |

---

## 3. 反向证据（四组，原始输出）

1. **并集口径**（`01`）：把 `union_avail_sql` 改回 **accurate 单层** ⇒
   `available_range` 的 `to` 落到 accurate 的 `2026-08-03T02:00:01Z`，而正确值（含兜底）是 `02:30:01Z` ⇒ **FAIL**。恢复 union ⇒ PASS（`02`）。证明「只查 accurate 会切掉兜底可服务的新数据」。
2. **span cap**（`05`）：重新引入 93 天档 ⇒ `submit_accepts_long_spans_no_calendar_cap` **FAIL**（`M15×259 天必须可提交…: 反向扰动：区间超限`）。
3. **guard disabled**（`06`）：令 `guard_bars` 恒 `None` ⇒ `p5_resource_guard_confirm_and_hard_reject` 在 `unwrap_err()` 处 **FAIL**（拿到 `Ok(StrategyRunView)`，其 `config.estimated_bars=200000`）。
4. **clamp disabled**（`07`）：令 `eff_from/eff_to = requested`（不收缩）⇒ `p5_clamp_left_right_both_and_exact` **FAIL**（`clamped=true` 断言未成立）。

---

## 4. 前端配套证据

| 能力 | 证据 |
|---|---|
| 日期控件 `min/max` 随「标的+周期」联动 + 可用区间文案 | `08` → `ConfigPanel.test.tsx`：`loadAvailableRange` 注入 `2012-01-04 ~ 2026-09-16` ⇒ 两个 date input 的 `min/max` 断言成立 + `wb-available-range` 文案含两端 |
| `clamped:true` ⇒ 显著提示条（不弹确认框） | `08` → `wb-clamp-notice` 可见，文案含「收缩」与 effective 端 |
| `resource_guard` ⇒ 二次确认（展示预估 bar 数/耗时） | `08` → `wb-guard-prompt` 显示 `290000 根 / 约 182.3 秒`，确认/取消回调各 1 次 |
| 结构化错误可**编程**消费 | `08` → `client.test.ts`：`{error:{code,message,detail}}` ⇒ `ApiError.code='resource_guard'`、`detail.requested_bars=290000`、`detail.confirmable=true` |
| 新端点契约 | `08` → `client.test.ts` `GET /api/workbench/available_range?symbol=&period=` |
| mock 契约 | `08` → `mock.test.ts`：`getWorkbenchAvailableRange` 已注册/未注册/非法 period；submit 回显 `requested_from`/`estimated_bars`/`result_format` |
| 类型与构建 | `08` `npx tsc -b` exit=0；`09` `npm run build`（vite）成功；全量前端 `vitest run` 90 files / **872 tests passed** |

web 端结构化错误 + 新端点的**活库**证据：`web/tests/api_workbench.rs::p5_available_range_endpoint_and_structured_errors`（真起 axum + 真库；`/available_range` 200 + RFC3339，`W1` → 400，无交集 → 400 body `error.code=range_empty` + `detail.available_from`）。

---

## 5. 门禁与全量摘要

- `10_backend_full_summary.txt`：domain / application / storage / web / mcp 全量测试摘要（**全绿**，唯一并发的 `orphan_detect_endpoint_red` FAILED 为环境性 flake，见 `11`）。
- `11_orphan_flake_note.txt`：该 flake = 跨测试文件（`api_rest` 并行竞态）在 `kline_5m` 兜底 cagg 留孤儿行，**与 P5 无关**；清理残留后按「api_rest → orphan」重跑全绿。
- `12_tangle_check.txt`：`./scripts/check-tangle.sh` ⇒ ✅（沙箱重新生成 + 逐字节比对通过）。
- `cargo check --workspace --all-targets` exit=0；`cargo clippy`（domain/storage/application/web/mcp）无新增 error（仅既有 tester 文件 unused 警告与历史 doc 风格警告）。

---

## 6. R10 量化（**改判：取数不是瓶颈**）

证据 `03_r10_fetch_scaling.txt`（`storage::BacktestBarReader::bars`，testdb 播种 `510050` M1 = 861,093 行；**debug** 口径）：

| 请求窗口 n（分钟） | 实取 bar | 墙钟 ms | µs/bar | bars/s |
|---|---|---|---|---|
| 1,000 | 241 | 132.2 | 548.6 | 1,823 |
| 5,000 | 964 | 53.8 | 55.8 | 17,915 |
| 20,000 | 2,410 | 57.8 | 24.0 | 41,703 |
| 100,000 | 12,050 | 83.3 | 6.9 | 144,667 |
| 500,000 | 56,153 | 222.5 | 3.96 | 252,358 |
| **全历史** | **861,093** | **3,500.0** | **4.06** | 246,027 |

**结论（推翻旧措辞）**：
- P4b 仪表里「M1 16k ≈ 809 ms ⇒ ~50 µs/bar」是**短窗口**值：该处由**固定开销**（建连/计划/首行）主导，而非真实每 bar 成本。标度是**次线性**（µs/bar 随 n 单调下降并收敛）。
- **全历史 M1（86 万 bar）取数仅 3.5 s（debug）**；release 更快。⇒ 架构师在 `04-implementation-plan.md` R10 中的「全历史外推 ~40 s」**被实证推翻**。
- **R10 降级为「非瓶颈、仅记录」**：取数**不构成** P5 后长区间的新瓶颈；无需为此另立优化专项。（`/curve` 服务端全量物化问题 R9 仍独立成立，不在本批范围。）

---

## 7. 未决项与残余风险

| # | 项 | 说明 / 处置 |
|---|---|---|
| U1 | **`bars_total`/`result_format` 不在 run 行** | `StrategyRunView` 已含两字段但 run 行恒 `None`（`strategy_run` 轻量 SELECT 不联结果）；值经 `/brief`/`/result` 提供（P4 既定）。spec §3.1 的 201 示例把二者列在响应内，实现为 201(=queued) 时 `None`——**建议 tester/架构师确认该偏差可接受**（结果相关字段走 `/brief`）。 |
| U2 | **执行时收缩仅在"被夹端"生效** | 为避免「请求 from 未对齐 bar」造成无意义紧缩，仅当提交时该端 `clamped` 才按真实首末 bar 再收窄（D3 意图 = 修正陈旧 cache / 边界缺数据）。非夹端仍以请求为准（引擎天然从首个 `ts≥from` 的 bar 起）。如需「effective 永远 = 真实首末 bar」，请裁决。 |
| U3 | **`available_range` 边界 +1s 语义** | `to = max_ts + 1s`（半开，保证末 bar 落在 `[from,to)`）。回显 `effective_to` 在右夹时会是 `max_ts+1s`（秒级偏移）。若要求回显「末 bar 日期（含）」，需改契约。 |
| U4 | **预估算子为过渡估值** | `estimate_secs = 0.85s + bars × 6.25e-4`（含固定项、端到端口径；常量注释已标明）。按 D1/D15 须在 **P4b 修复后重标定**。 |
| U5 | **tester 文件机械改动（未 add）** | 因接口加了必填字段 `confirm` / P5 语义变更，对 tester 的**未跟踪**文件做了最小机械修订（编译/断言）：`crates/application/tests/tester_p2b_tryrun_indep.rs`、`crates/web/tests/tester_p4_writepath_indep.rs`、`crates/web/tests/tester_p4_endpoints_indep.rs`。**未加入 index**（保持 tester lane 洁净），仅在工作区可编译；请 tester 复核。 |
| R1 | **api_workbench 请求右端对齐** | P4 测试原以 `to = base+n 分钟` 请求（末 bar 在 `n−1` 分钟）⇒ P5 下合法地 `clamped`；已把请求右端对齐可得边界以保持其余断言语义。tester 独立验收时请注意该口径。 |
| R2 | **orphan 跨测试 flake** | 见 §5/`11`：非 P5 引入；建议后续在 `api_rest` 的 `clean_kline` 对兜底 cagg 窗口补 refresh（独立小改）。 |

**明确未做（非目标，硬）**：未改引擎/`strategy-runtime`/指标；未改进度写库策略；未改 P4 分块与端点语义；未改 `design/16-backtest-scalability/**`；未部署、未新建长期库、未 `git commit`。

---

## 8. 交付与复核指引

- **审阅面**：`crates/application/src/{error.rs(new),strategy.rs,workbench.rs,lib.rs,simlive.rs}`、`crates/domain/src/ports.rs`、`crates/storage/src/{backtest.rs,workbench.rs}`、`crates/web/src/{lib.rs,workbench.rs,strategies.rs}`、`crates/mcp/src/tools.rs`、`web/src/**`、上述测试文件、三份回写文档。
- **证据**：`coder/evidence/adr024_p5/01–12`。
- **集成测试前置**（本批用临时库）：`EESTOCK_TEST_DB_NAME=tmp_p5_<ts> scripts/testdb-init.sh` → `export EESTOCK_TEST_DATABASE_URL=...` → 跑测 → `DROP DATABASE tmp_p5_<ts> WITH (FORCE)`（本轮已 teardown 前留档；tester 请自建临时库）。
- **tangle**：改动同时含文档 + 生成物两侧（`design/02-domain/contracts.md`、`design/07-app-plane/{00-web-api,01-mcp}.md` 与对应 `crates/**`），提交须一并纳入。
