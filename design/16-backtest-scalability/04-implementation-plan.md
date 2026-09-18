# 04-implementation-plan — 里程碑、派发与门禁（ADR-024）

> 角色纪律：**架构师（我）**只出规格与评审、**不写代码/测试/不做调试**；实现走 coder 子代理（TDD），取证与独立复核走 tester 子代理，缺陷定位走 debugger（须先有复现测试/证据）。
> 顺序纪律见 `01-adr.md` D14：**任何阶段不得跳序摘护栏**。

---

## 1. 里程碑总览

| 阶段 | 内容 | 负责 | 依赖 | 回滚点 | 建议时间盒 |
|---|---|---|---|---|---|
| **P0** | M30 打通 + 周期白名单单一事实源 | coder → tester | 无（数据已就绪） | 独立小改动，`git revert` 即可 | 0.5–1 天 |
| **P1** | golden 基线冻结 + 规模曲线取证 | tester | P0（M30 用例需在基线内） | 只产出证据，无生产改动 | 1 天 |
| **P1b** | 基线补完（持仓派生序列 + 容差裁定 + 逐字段枚举）+ 指标重插件曲线 + 耗时口径分解 + 预估算子标定 | tester | P1；M30 用例待 P0 | 只产出证据，无生产改动 | 1 天 |
| **P2** | **引擎线性化**：会话化 + 共享缓冲 **+ 指标增量**（P2/P3 **同批交付、同一 gate**） ✅ **已冻结（2026-09-18）** | coder → tester | P1/P1b（golden + 曲线） | 引擎契约切换点，`git revert` | 3–4 天 |
| **P2b** | **试算 / sim-live 路径线性化**（同源二次项收尾）：`application/src/strategy.rs:894` 试算逐 bar 评分循环、`simlive/src/plugin_orchestrator.rs:242` sim-live bars 视图 —— 两者仍走兼容路径、每 bar 复制 `bars[..=index]`（tester R2 发现）。修法同 P2：各持 `Rc<BarHistory>`。**P5 的前置**（D11 要求试算放开前先线性化） ✅ **已冻结（2026-09-18）** | coder → tester | P2 | 各调用点独立可回退 | 0.5–1 天 |
| **P2c（微批）** | **生产构造点的无前视自检**（tester P2b 验收 R1 裁定）：在三个生产构造点（引擎会话、`tryrun_bar_ctx`、sim-live `evaluate`）分别加 `debug_assert!(bars.len() == index+1)`；**不得**加在 `BarCtx::with_history` 本体（那会破坏 P2 的两个反向测试资产 `shared_history.rs:199/271`） | coder → tester | P2b | 单行、可回退 | 0.2 天 |
| **P3** | ~~指标增量（同序递推）~~ **已并入 P2**（P1b 实测：指标二次项是复制项的 16.2× ⇒ 只做 P2 等于只做 1/16，不可拆） | — | — | — | — |
| **P4b** | **每 run 固定开销治理**（先仪表后优化）：真路径计数器/span → 定位 → 方案 → 前后对比 | coder → tester | 任意（与 P2 同触 `workbench.rs` ⇒ **排 P2 之后**） | 仅观测+进度写入路径，可单独回退 | 1–2 天 |
| **P4** | 分块落库 + 双读 + `/brief /bars /curve` ✅ **已冻结（2026-09-18，条件式）** | coder → tester | P2；P4b（结果写入路径避免冲突） | 双读保证向后兼容；新表可留 | 2 天 |
| **\u26d4 上线硬门槛** | **`0027` + P4 不得单独上线**：P4 将新 run 改为 `chunked_v1`，而前端对 `has_more`/`next_offset`/`/bars`/`/curve`/`result_format` **零消费**（tester 证据 `251/13_frontend_gap.txt`）⇒ 单独上线会「净值/回撤图静默空 + 逐 bar 表只显示前 5000 根」。⇒ **部署批次 = 迁移 0027 + P4 + P6（至少 P6 的取数路径改造）** | tester P4 验收 §前端缺口确认 | — | — | — |
| **P5** | 区间收缩 + 摘护栏 + 试算放开 + 结构化错误 | coder → tester | **P2（含指标）+ P4 + P4b**（硬依赖） | **安全态**：护栏仍在 → 可停在 P4 | 2 天 |
| **收尾小批（待排）** | 四条 LOW/MEDIUM 残余：**N1-r**（12 条 web 早退 400 无 `detail.period`）· **N2-r**（mock 的**工作台提交**路径未镜像 P5）· **⑤ dev-only**（`WorkbenchStore.dispose()` 单向 `disposed=true` ⇒ vite dev + StrictMode 恒卡下拉；**生产不可达**）· **P4b-r 取消路径终态进度未落库**（架构师口径裁决：**接受为已知例外，不阻塞本批** —— 依据：取消瞬间 WS 未帧已送达用户且 `status=canceled` 才是权威字段；**修法（推荐）＝在 `mark_canceled` 之前冲刷最终进度**，**不**放宽 `store.update_progress` 的 `status='running'` 守卫）。另登债务：`strategy-core::validate` 只产 `String` ⇒ 现以 `classify_config_error()` 稳定消息前缀归类（单点 + 被 HTTP 用例钉住） | coder → tester | P5 / P4b | 各自独立 | 0.5–1 天 |
| **P6** | 前端（周期 30m、曲线抽样取数、分页明细、收缩提示、预估确认） ✅ **已冻结（2026-09-18）**——含架构师裁决新增的 **`/fills` 有界精确源**（K 线标记）+ 单一取数入口 + 事件日志分页 | coder → tester（真渲染） | P4/P5 | 前端可与后端版本解耦（兼容旧 `/result`） | 2–3 天 |
| **P7** | 文档/ADR 修订收口 | coder（机械执行）→ 我评审 | 各自对应阶段 | 无 | 0.5 天 |

**关键依赖**：`P5 摘护栏 ⇐ P2（含指标增量）+ **P2b** + P4 + P4b`（否则用户吃到**无解释的长时等待**；实测轻插件 34–105 s、指标重插件 ~8 分钟量级，详见 `01-adr.md` §2.5/§2.6）。P6 可并行启动（后端契约 P4 已定）。

> **P2b 立项依据（tester P2 验收 R2）**：P2 只修了引擎路径；**试算与 sim-live 仍存在同源二次项**（逐 bar 复制 `bars[..=index]`）。D11 要求“试算放开”前先线性化 ⇒ 这两处必须在 P5 之前修完，否则试算长区间仍会是 O(n²)。架构师裁定：**P2b 优先于 P4b**（它是 P5 硬依赖，而 P4b 是体验优化）。
>
> **P2b 附带项（架构师）**：把上述两个调用点也改为各持 `Rc<BarHistory>` ⇒ 连同 P2 一起把「宿主侧可读未来」面彻底消除（D7 修订里的遗留项）。

> **P2 范围裁定（架构师 2026-09-18，纳入派单）**：P2 **保留「先全量读 bar、再分块喂会话」的批式入口**，**不引入真流式取数端口**（`bars_page`/`available_range`）——理由：① 全量 bar 内存很小（290k×48 B ≈ 14 MB，非瓶颈）；② 真流式读与区间收缩（D2/D3）耦合，合并进 P4/P5 风险更低；③ P2 的收益（消除 O(n²)）不依赖流式读。`02-spec.md` §1.1 的端口契约保留不动，仅延后实现。

> **P1b 后里程碑变更**（已回填 `01-adr.md` §2.6 / D6 / D15）：① **P3 并入 P2**（指标二次项 = 复制项 16.2×，拆开做等于只做 1/16）；② **新增 P4b**（每 run 固定开销：千根 bar 的 run 引擎 6 ms vs 端到端 854 ms，≈140×；真路径已确认 `strategy_run` 累计 357,386 次 UPDATE）；③ D1 预估算子改为「bar 数 + 耗时区间」。

---

## 2. 阶段细则

### P0 — M30 打通 + DRY 收敛 ✅ **已冻结（2026-09-18）**
- 交付：staged 55 项（源码/测试/我的设计产物 `design/16-backtest-scalability/**`）；功能判词 PASS（tester `adr024_p0_m30_verification.md`）+ 两轮整改（D1 交付完整、D2/整改#2 恒真断言）+ 冻结前定向复验 PASS（`adr024_p0_freeze_verification.md`，含**干净检出模拟**：纯 index 导出树内 Rust 15/15 + 前端 22/22 全绿，反向对照移走契约向量 ⇒ Rust 101 / 前端 1）。
- **未 commit**（等用户批提交切分）；运行态：P0 二进制已上线 8081/8082（回滚件已留，来源=HEAD+P0 staged diff，非 HEAD）。
**改动清单**（`01-adr.md` §2.4 的 6 处缺口）：
1. `crates/backtest/src/types.rs`：`Period::M30` 变体 + `bars_per_year()` = 252×8 = 2016
2. `crates/application/src/bar_map.rs`：`parse_period` 增 `"M30"`；新增 `supported_backtest_periods() -> &'static [&'static str]`（**唯一事实源**）
3. `crates/web/src/workbench.rs:148`：删硬编码 `matches!`，改调 `parse_period`
4. `crates/mcp/src/tools.rs:1020` + `:338,367`：由 `supported_backtest_periods()` 生成 enum/校验
5. 前端：`workbench/ConfigPanel.tsx`、`strategies/TestRunPanel.tsx` 增 `M30` 选项；`api/mock.ts` / `features/backtest/format.ts` periodLabel / `KlineResultChart.periodCodeToPeriod` 补 `30m`
6. 新增 `contract-vectors.json`（本目录）+ 防漂移断言测试（`03-test-plan.md` §3 P5 最后一条）

**Gate**：三处 gate 全绿 + M30 真跑出结果（非仅校验通过）+ 防漂移断言（故意改一处 ⇒ 必须红）。

### P1 — 基线与曲线（tester 独立完成）✅ **已完成（2026-09-17）**
- **产出**：`tester/evidence/240_adr024_golden_baseline/`（11/13 用例，M30×2 待 P0；A/B/C 三层 11 例全 PASS，max_dev=0；敏感性反向证据齐备）、`tester/evidence/241_adr024_scale_curve/`（16 点×3 重复=48 次运行，0 超时）、`tester/test/295_..._execution.md`、`tester/report/adr024_p1_baseline_and_curve.md`
- **结论**：渐近斜率 **1.878–1.900** ⇒ O(n²) 诊断成立；M1×5 年实测 **34.4 s / 104.6 s**（非「小时级」，**ADR 初稿时长估计已更正**）；峰值 RSS 与 n 无关 ⇒ 真实约束是**时间**；分配量与预测式吻合到 **1.0001**
- **架构裁决（已回填 `01-adr.md` §2.5 / D1 / §5、`03-test-plan.md` §1.1/§1.3/§2）**：① 时长错误已更正（**我的估算失误，已记录**）；② B 层绝对下限 1e-9 → **1e-12**；③ 判据改为**渐近斜率 + 三指纹**（全域单幂律降为信息项）；④ 吞吐口径二者不可互比，D1 预估算**必须**用生产端到端口径标定

### P1b — 取证补完（tester）✅ **已完成（2026-09-17）**
> 产物：`tester/evidence/242_adr024_baseline_extension/`（① 持仓派生序列 11/11 位级 + 自证；② 容差 1e-12 + 逐字段枚举；③ 指标重插件曲线）、`tester/evidence/243_adr024_attribution/`（④ 副本分解；⑤ 374 条真 run 标定）、`tester/test/296_..._execution.md`、`tester/report/adr024_p1b_baseline_extension.md`。
> **架构裁决**：① ② 达标；**③ 改变了优先级**（指标二次项 = 复制项 16.2× ⇒ P3 并入 P2）；**④ 只能当上界**（副本无背压）；**⑤ 有混杂**（并发/批量）+ **真路径已确认 357,386 次 UPDATE 异常** ⇒ 新增 P4b，**禁止凭推断优化**。
1. **【P2 前硬依赖】持仓台账派生序列**（`03-test-plan.md` §1.3）：由 orders/trades 确定性推导逐 bar `{ts,qty,avg_cost,cash}`，纳入 A 层 bitwise；**基线只能在改造前捕获，不得推迟**。
2. **【P2 前硬依赖】B 层裁定落地**：容差 `max(1e-12, 1e-9×|expected|)`；比对器新增**逐字段枚举**（dev>0 全部列出），并重跑 11 例确认仍全 PASS。
3. **指标重插件曲线**（`03-test-plan.md` §2.1 插件维度 (c)）：每 bar 调 `macd`/`rsi`/`atr` 的 fixture 插件 × n 矩阵 ⇒ 量化指标二次项系数，**决定 P3（指标增量）的必要性与优先级**。
4. **耗时口径分解取证**（**判别性实验**，非直接改代码）：构造「生产路径副本」harness（引擎 + per_bar jsonb 序列化 + 按 `PROGRESS_THROTTLE_MILLI` 同频写 `strategy_run.progress` + 更重插件），看能否重现 ~1,600 bars/s；**无论成立与否都要报告**，并标注为「副本归因」；真路径确认留到 P4 分段 span。**纪律**：未取证不得动 进度节流/落库策略（当前为假设）。
5. **预估算子标定**：以既往 production run 的 `bars_total`/`slots` × `finished_at-started_at` 回归出端到端系数（供 D1 过渡期用）；P2 后重标定。
6. **M30 用例 ×2**：P0 落地后补（`m30_1slot` / `m30_3slots`）并重跑比对器。
- 产物：`tester/evidence/242_adr024_baseline_extension/`、`tester/evidence/243_adr024_attribution/`，报告 `tester/report/adr024_p1b_*.md`

### P2 — **引擎线性化**（会话化 + 共享缓冲 **+ 指标增量**，同批同一 gate）
- `strategy-core`：`EnsembleSession`（`push(bar) -> Vec<BarRecord>`），持仓/Policy/Trailing/插件实例常驻；保留批式入口作薄封装（供既有单测与 sim-live 短区间复用）
- `strategy-runtime`：`quickjs.rs:380` 的整段复制 → 单一增长式共享缓冲（`Rc<RefCell<Vec<Bar>>>` 或等价），`ctx.bars` 语义不变（**零 ABI 变更**）
- `backtest/src/indicators.rs`：**`ema/rsi/macd/atr` 改同序递推状态**（P1b 实测：不做的诐只消掉 1/16 的二次项）；`ma` 允许滑动和（B 层容差 + 报告最大偏差）
- `domain`：`BacktestBarRead::bars_page` + `available_range` 端口（`02-spec.md` §1.1）
- **Gate（三层同时过）**：① golden 11 例 A/B/C + B′（台账位级含 `derived`）+ 分块喂入等价 + 取消仍每 bar 生效；② **指标等价报告**（含 `ma` 偏差实值 + 「偏差不随 n 增长」）；③ **改造后曲线用两个插件各跑一次**（`dual_ma` 与 `indicator_heavy`），**两者渐近斜率均 ∈ [0.9, 1.1] 且 `alloc_bytes` 塌缩为 O(n)** —— 只看 `dual_ma` 会**误判已线性化**（D6 教训）。

### P4b — 每 run 固定开销治理（**机制已定位，仍先仪表后优化**）
> **分两阶段派单（架构师 2026-09-18）**：**① 仪表阶段**（计数器 + span + 改动前基线数字）**已派单**；
> **② 修复阶段必须等用户确认**（D15 ③ 的候选方案会改进度写入频率/语义，属产品可感变更）。
- **背景（真路径实测，P1c）**：每 run 固定 **1003 次 `UPDATE strategy_run`**（1001 进度帧 + 2 状态迁移），帧数**封顶 1001、与 bars 无关**；端到端时长 ≈ `1003 × 每帧写库延迟`（0.86 ms 历史中位 → 3.45 ms 本轮 I/O）。
- **推翻项**：架构师先前推断的「背压/合并/丢弃」**不成立**（`unbounded_channel` + Δ 精确闭合 1003）⇒ **不要**按“丢帧”方向设计。
- **① 仪表（先做，拿到改动前基线）**：计数器 `progress_frames_{produced,sent}`、`progress_db_writes`、`progress_db_write_ms`；**permit 持有时间分解**（取数/引擎/序列化/落库/进度排水）；配 Trace span。
- **② 基线数字**（仪表发布后立即跑一次，作为前后对比基准）：每 run 帧数、写库总耗时、帧均延迟、**permit 持有占比**、单位时间 run 吞吐。
- **③ 候选方案（须用户确认）**：时间窗口节流（如 ≥250 ms/次）替 0.1% 粒度；合并写入/批量提交；**WS 帧保留、DB 持久化降频**；缩小 `mark_succeeded` 前的排水等待。
- **④ 前后对比证据** + 用**并发度作协变量**重做标定。
- **Gate**：仪表先落地并给出「改动前的基线数字」（否则优化无法证明收益）；优化后给前后对比；**不得改进度语义而不告知前端**（WS 实时性与 DB 频率分离是允许的，但必须写进 `02-spec.md`）。

> **测量学硬约束（P1c 教训，后续所有计数类实验适用）**：PG15+ 表级统计由**该后端周期性 flush**（实测迟到 +13/+22/+64/+79）⇒ 任何「增量计数」实验必须用**长窗口协议**（前置 idle guard + 后置多次采样至零漂移）；`settle 4×0.5 s` 不够。
> **引用注意**：P1c 实测已把 `pg_stat_user_tables.strategy_run.n_tup_upd` 从 **357,386 抬到 364,041**（+6,655 = 8 条受控 run；行数据已删除并恢复 374 条，见 `244_.../cleanup.txt`）⇒ **后续引用累计值须扣 +6,655**。

### P3 — 已并入 P2（P1b 实测：指标二次项 = 复制项的 **16.2×**）

### P4 — 分块落库 + 双读 + API
- `design/04-storage/schema.md` 写 tangle 块 → `migrations/0027_strategy_run_result_chunks.sql`（`02-spec.md` §2）
- `crates/storage`：`append_result_chunk` / `result_chunks` / `result_chunks_in_range` / `result_chunk_count`；`mark_succeeded` 写 `result_format='chunked_v1'`
- `migrate_check.rs`：`EXPECTED_RELATIONS` 增 `strategy_run_bars`（**先迁移后重启**）
- `crates/web`：`/brief` `/bars` `/curve` + `/result` 兼容分支；`compare` 抽样
- **Gate**：跨 chunk 查询/边界/双读一致性/取消守卫/自检拒绝启动 全绿；tangle 无 diff（ADR-018）

### P5 — 区间语义 + 摘护栏 + 试算
- `WorkbenchService::submit`：删天数额 → 区间收缩（D2/D3）→ 资源护栏（D1，值取自 P1 曲线）
- `StrategyService::test_run`：同口径；截断改均匀抽样 + 标记
- `crates/application/src/strategy.rs:59-60`：**删除** `D1_MAX_SPAN_DAYS` / `MINUTE_MAX_SPAN_DAYS`；`workbench.rs:55` 的 `MAX_BARS` 按 P1 曲线定值（或删除）
- 结构化错误（`02-spec.md` §3.1.1）+ 进度 count 预扫描（D12）
- 前端过渡期二次确认（可与 P6 合并）
- **Gate**：`03-test-plan.md` §3 P5 全部；**活库** accurate-滞后场景反向证据

### P6 — 前端
- 取数路径改造（图表 `/curve`、明细 `/bars`、K 线不变）+ 收缩提示条 + 日期控件联动 + `downsampled` 标注（既有「抽样 N 点」模式）
- **Gate**：真渲染验收（Playwright；含 M30 端到端）

### P7 — 文档收口（本 ADR 的对外声明必须与实际一致）
| 文件 | 修订 |
|---|---|
| `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` | 修订「回测 gate 仍拒绝 30m」排除注记 → 指向 ADR-024 |
| `design/08-backtest/01-engine-adr.md:38` | 周期集合增 M30；上限表述改为「按可得区间收缩」 |
| `design/12-strategy-system/01-adr.md:177` | 试算区间上限表述；**§13.4 全量落库口径 → 分块 + 显式抽样**（D10） |
| `design/07-app-plane/00-web-api.md:263` | 周期集合 + 上限表述 + 新增端点/错误结构 |
| `design/07-app-plane/01-mcp.md:713` | MCP 工具描述与参数 |
| `design/04-storage/schema.md` | 分块表 + `result_format` 列说明；`strategy_run.period` 注释补 M30 |
| `design/99-decisions-log.md` | 追加 ADR-024 条目 |

---

## 3. 观测面要求（D13 之外的硬性要求）

| 类型 | 内容 |
|---|---|
| **Metrics** | `run_estimated_bars`、`run_actual_bars`、`run_duration_secs`、`run_peak_rss_bytes`（若可得）、`result_chunk_count`、`clamp_events_total{reason=data_range}`、`resource_guard_events_total`、`result_payload_bytes{kind}` |
| **Logs** | 结构化：`run_id` + `trace_id` 贯穿 submit → 引擎 chunk → storage 写入 → 结果读取；收缩/护栏/降级（进度退化）必须落日志且可检索 |
| **Traces** | 每 chunk 一个 span（bar 数、耗时、写入字节）；结果读取按端点分 span |
| 硬要求 | 每模块 ≥2 项（本批涉及 application/storage/web 至少各满足）；**Trace ID 必须跨进程/跨层传播**（postgres 写入的 span 也要带） |

**验收**：长区间运行时能从观测面回答「现在跑到哪、为什么慢、有没有降级」——不接受只能看进度条百分比。

---

## 3.5 派单与并发纪律（架构师 2026-09-18，事故后追加）

| # | 规则 | 来源 |
|---|---|---|
| 1 | **冻结批未 commit 前，不得在同一 worktree 并发开 mutation 车道**；后续 mutation 车道一律 `worktree:true` 隔离（或先 commit）。 | P2c/P4b 验收时暴露：P4 车道并发改同一 `workbench.rs`，主干一度不可编译、工作区文件偏离交付态（靠 index 快照兜住） |
| 2 | 冻结以 **index 快照**为准（`git write-tree` + tarball + 交付态 sha256），非工作区；冻结时**必须核验 index 不含其它车道半成品**（三个内容级检查：端口/端点签名、迁移号、schema 关键字）。 | 同上（`coder/backups/adr024_frozen_index.md`） |
| 3 | 需 DB 的集成测试：用 `EESTOCK_TEST_DB_NAME=tmp_<lane>_<ts> scripts/testdb-init.sh` 建临时库 → 跑 → `DROP DATABASE … WITH (FORCE)` → **回读库清单只剩 `{eestock, postgres}`**，贴 teardown 证据。 | ADR-025 D3 + P2c/P4b 验收的 137 个“环境性失败”（全部为 E6b 哨兵门禁无库所致） |
| 4 | mutation 子代理**禁止 `git add -A`/`git add .`**，只 add 自己改动的路径。 | 同上（防污染冻结批） |

---

| ID | 风险 | 触发信号 | 缓解 | 责任人 |
|---|---|---|---|---|
| R1 | 等价性漂移（改造改变数值） | golden B 层 max_dev 超限或随 n 增长 | 先红后绿 + tester 独立复核 + 禁止合并 | coder/tester |
| R2 | 先摘护栏导致长时等待无解释 | P5 早于 P2/P3 落地 | 顺序纪律（D14）+ 评审卡点。**严重度按实测下调**（34–105 s 而非小时级）⇒ 后果是困惑+低效，不是灾难 | 架构师（我） |
| R3 | 迁移与启动顺序 | app 启动自检失败 | 先迁移后重启（既有惯例）+ 证据留档 | coder |
| R4 | 可得区间缓存陈旧 | 用户看到过期可用区间 | TTL 60 s + 执行时以真实首末 bar 为准 | coder |
| R5 | 分块读边界错误 | 跨 chunk 查询缺根/重根 | 契约写明 + 边界测试矩阵 | coder/tester |
| R6 | 前端长区间内存爆 | 结果页卡死/白屏 | 曲线走 `/curve`、明细走 `/bars`；真渲染验收 | coder/tester |
| R7 | 白名单漂移复发 | 后端集合 ≠ 前端集合 | 防漂移断言测试（单点） | coder |
| R8 | 磁盘增长 | 水位监控告警 | 手动删除端点 + 水位监控（量级：单 run 4–6 MB） | coder |
| R9 | **`/curve` 服务端先全量物化再抽样**（tester `252` F4）：大 run 的服务器内存/耗时未优化 | 观测到 `/curve` 耗时随 run 大小线性增长时 | 归入 **P4c/后续专项**（分块级采样或流式抽样） | coder |
| R10 | ~~取数耗时可疑~~ **已由实测推翻（2026-09-18，P5）**：取数随 n **次线性** —— n=5k→56 µs/bar、20k→24、100k→6.9、500k→3.96、**满历史 861,093 bar → 3,500 ms（4.06 µs/bar）** ⇒ **取数不是瓶颈**（全历史 M1 仅 3.5 s）。架构师此前从 debug 口径 809 ms/16k 外推的「~40 s」**被实证推翻**，本项**关闭**（仅留记录） | P5 实测 `coder/evidence/adr024_p5/03_r10_fetch_scaling.txt` | 无（已关闭） | — |

---

## 5. 需用户后续确认的（不在本批范围）
1. 试算是否转异步（D11，视实测）。
2. `MAX_BARS`/资源护栏**最终定值**（视 P1 曲线；架构师给建议值，用户点头）。
3. sim-live 加 M30 的独立小批排期。
4. 有界窗口 ABI（后续债，需另立 ADR）。
