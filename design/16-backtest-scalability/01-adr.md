# ADR-024 — 回测区间护栏重构（去日历天数档）与引擎 O(n²)→O(n) 流式化

- 状态：**已裁决（2026-09）**。用户三轮确认：①「不要上限限额，指定哪个时间范围就按时间范围回测」；②「应该使用流式计算才对，为什么需要一次性把数据放内存」；③「全按推荐」（含本文档 Q1–Q14 全部裁决）。
- 关联：ADR-003（双真值层）、ADR-004（只写 1m、高周期派生）、ADR-007/018（literate programming + tangle 门禁）、ADR-019（费率档案）、**ADR-023（30m 周期档，本文档修订其在回测侧的排除注记）**；`design/08-backtest/01-engine-adr.md`、`design/12-strategy-system/{01-adr.md,04-strategy-programming-guide.md}`、`design/07-app-plane/{00-web-api.md,01-mcp.md}`、`design/04-storage/schema.md`、`design/06-web/01-dashboard.md`
- 上游输入：`design/00-vision.md`；用户诉求原文见 §1

---

## 1. 需求（用户原文口径）

| # | 诉求 | 性质 |
|---|---|---|
| 1 | 「我回测为什么需要限额，指定哪个时间范围就按照时间范围回测」「我希望不要上限限额」 | 产品口径变更 |
| 2 | 「超出数据可得范围，则重新根据数据真实的范围界定真实回测的范围」 | 产品口径定义 |
| 3 | 「试算也需要一起改」 | 口径一致性 |
| 4 | 「回测不能选择 30min 的周期」 | 能力补齐 |
| 5 | （追问后）「为什么需要一次性把数据放内存？应该使用流式计算」 | **架构缺陷定位**（用户判断正确，见 §2.2） |

---

## 2. 现状与证据

### 2.1 护栏现状（代码锚点，非推断）

| 事实 | 位置 |
|---|---|
| `D1_MAX_SPAN_DAYS = 366*5 = 1830`；`MINUTE_MAX_SPAN_DAYS = 93` | `crates/application/src/strategy.rs:59-60` |
| 唯一执行点（工作台）：`submit()` 入队前校验，超限 400「运行区间超限」 | `crates/application/src/workbench.rs:229-240` |
| 唯一执行点（试算）：`test_run()`，超限 400「试算区间超限」 | `crates/application/src/strategy.rs:671-690` |
| **无 env/config 开关**（常量，不可运维调参） | 全仓 grep `MINUTE_MAX_SPAN_DAYS` 仅 2 个 rs 文件 + 前端 mock |
| web 与 MCP **共用同一执行点**（无旁路） | `crates/web/src/workbench.rs:138-149`；`crates/mcp/src/tools.rs:1266,1374` |
| 周期白名单**硬编码 6 处**（DRY 违规） | `web/src/workbench.rs:148`、`mcp/src/tools.rs:338,367,1020`、`features/workbench/ConfigPanel.tsx:585`、`features/strategies/TestRunPanel.tsx:148`、`api/mock.ts:436-450` |
| `MAX_BARS = 200_000`，且在**读完 bar 之后**才判（浪费型校验） | `crates/application/src/workbench.rs:55, 326` |
| 文档固化该上限 4 处 | `07-app-plane/00-web-api.md:263`、`07-app-plane/01-mcp.md:713`、`08-backtest/01-engine-adr.md:38`、`12-strategy-system/01-adr.md:177` |

### 2.2 根因：引擎是 O(n²)，93 天是补偿性补丁（用户判断得到证实）

| # | 锚点 | 事实 |
|---|---|---|
| 1 | `crates/strategy-runtime/src/quickjs.rs:380` | `let hist: Rc<Vec<Bar>> = Rc::new(bctx.bars[..=bctx.index].to_vec());` —— **每个 slot × 每根 bar 复制「从第 0 根到当前根」的整段历史**。调用链：`QuickJsInstance::on_bar`(:234) → `build_ctx_object`(:332) → `build_indicators`(:379) |
| 2 | 同上 `:378-379` 自注 | 「复制成本 **O(index)**；P1 引擎侧如需优化可改传共享历史缓冲，口径不变」—— 方向当时已写下，未实施 |
| 3 | `crates/strategy-runtime/src/types.rs:54,64` | 插件 ABI 契约明文：`ctx.bars` = **全量历史序列**（动它 = 破坏性 ABI 变更） |
| 4 | `crates/backtest/src/indicators.rs:40-48, 68-77, 79-…` | `Indicators` = 「整段切片 + index」视图；`ema`/`rsi`/`macd` 每次调用**从 bar 0 重算** → 第二个二次项（`ma` 为 O(period)，故便宜） |
| 5 | `crates/strategy-core/src/engine.rs:320-357` | 引擎契约 `run_ensemble_with_observer(cfg, bars: &[Bar]) -> EnsembleResult{ per_bar: Vec<BarRecord> }`，内部 `Vec::with_capacity(n)` —— **全量进、全量出** |
| 6 | `crates/domain/src/ports.rs:501-504` | 取数端口 `BacktestBarRead::bars() -> Vec<Bar>` —— 全量 |

**量级核算**（48 B/bar memcpy = `i64` + 5×`f64`）：

| 场景 | bars | slots | 复制总量 | 结论 |
|---|---|---|---|---|
| M15 × 259 天（用户被拒的那次） | 2,800 | 1 | ≈0.19 GB | 无关紧要（实测总时长 1.7 s 由插件调用主导） |
| M5 × 92 天（现网在跑） | 3,250 | 1 | ≈0.25 GB | 无关紧要 |
| **M1 × 93 天（现上限）** | 15,000 | 1 | **≈5.4 GB** | 秒级 memcpy ⇒ **93 天这个数字的真实来源** |
| M1 × 1 年 | 58,000 | 1 | ≈80 GB | 数十秒 |
| M1 × 5 年 | 290,000 | 1 | **≈2.0 TB** | 实测 **34.4 s**（1 slot）/ 104.6 s（3 slots）——见 §2.5（本 ADR 初稿写「小时级」是**错的**，已按实测更正） |
| D1 × 5 年 | 1,215 | 1 | ≈0.03 GB | 可忽略（**故「日线 5 年能过」不是巧合**） |

**结论：「分钟级 ≤ 3 个月」是 Σi 的经验拐点被误写成了产品规则。** 单纯提高 bar 数上限只会把二次项悬崖后移，不解决问题。

### 2.6 P1b 实测（②）：指标重插件与「每 run 固定开销」——**两条改变优先级的新事实**

> 证据：`tester/evidence/242_adr024_baseline_extension/raw_heavy_plugin.txt`（指标重插件曲线）、
> `tester/evidence/243_adr024_attribution/{raw_replica.txt,calibration/fit.txt}`（副本分解 + 374 条真 run 标定）。
> 真路径补充（架构师只读查询，2026-09-17）：`pg_stat_user_tables` 对 `strategy_run` 累计 **`n_tup_upd = 357,386`**，而状态迁移仅需 `~3×2,349 ≈ 7k` ⇒ **≈35 万次进度写入**；该表 `synchronous_commit=on` / `fsync=on` / `wal_sync_method=fdatasync`。

**事实 1：指标重插件存在第三个二次项，且比「历史复制」大 ~15×**

| n（1 slot，fixture `indicator_heavy.js`：每 bar 调 macd+rsi+atr） | 墙钟 | bars/s | 分配量 |
|---|---|---|---|
| 5,000 | 0.163 s | 30.5k | 0.70 GB |
| 20,000 | 2.424 s | 8.25k | 11.2 GB |
| 50,000 | 14.99 s | 3.34k | 70.0 GB |
| 200,000 | **239.7 s** | 835 | 1,120 GB |

- `t/n²` = **5.99e-9** vs `dual_ma` 3.90e-10 ⇒ **16.2×**；而分配量只多 **1.17×** ⇒ 多出的成本是**纯 CPU**（`Indicators::macd/rsi/atr` 每次调用从 bar 0 重算）。
- ⇒ **P2（消除历史复制）对指标密集插件只能消掉约 1/16 的二次项**。**P3（指标增量）是必需项，不是可选优化**（详见 D6 修订）。
- ⇒ 时长是**插件相关**的：改造前 M1×5 年至290k bar，轻插件 34–105 s，指标重插件外推 **≈500 s（~8 分钟）**。

**事实 2：存在与 bars 无关的「每 run 固定开销」**（374 条真 run）

- `dur ~ bars`：**R² = 0.0007**（几乎无相关）；median dur **0.854 s**（bars 中位 999，跨度 29–3,250）。
- 分周期：M15 `c0=1.48 s` 且斜率≈0；M5 `c0=0.90 s` 且斜率≈0；D1 却呈 `1492 µs/bar`（R²=0.62）——**样本被并发/批量污染**（D1 那批是 170 个 run 的批量提交，4 并发）。
- 副本分解（**上界，非生产定论**）：n=3,250 时 引擎 15 ms / jsonb 全链 24 ms / **进度写库 3,279 ms（1001 帧，均 3.3 ms/次）**；n=1,402 时进度项 2,996 ms。
- **真路径实测（P1c，2026-09-17）：我的「背压/合并/丢弃」推断被推翻**。受控单次 run（M5 3,500 bar）长窗口测量（前置 90 s idle guard + 后置 240 s×120 采样零漂移）：**Δn_tup_upd = 1003**，与理论 `min(1001,bars)+2` **精确闭合** ⇒ **1001 帧全部写库**；结构侧确认 `tokio::sync::mpsc::unbounded_channel`（无容量上限、无 `try_send`、无 drop 分支）。
- **正确机制（单变量收敛）**：**不变量 = 帧数 1003（封顶 1001）；变量 = 每帧写库延迟**。
  - 历史 374 条无并发 run：`dur / 帧数` 中位 **0.862 ms/帧** ⇒ median dur 0.854 s 由此而来（不是「被丢弃削短的上界」）；
  - 本轮主机 I/O 较慢：2.45–3.45 ms/帧 ⇒ 同规模 `dur` = 2.59 s；
  - `dur ~ 帧数`（无并发子集）**R² = 0.9053**（vs 上轮 `dur ~ bars` R² = 0.0007）；
  - 真路径规模对照（bars 492 / 3,500 / 16,155）：`dur` = 1.305 / 2.592 / **2.578 s** —— **bars ×32.8 而 dur ×0.98**（16,155 bar 的 run 共 2.578 s，其中引擎仅 ~0.13 s ⇒ **~95% 墙钟花在 1001 次进度写库上**）。
- **累计计数修正（我的估法错误）**：先前 `357,386 ÷ 2,349 插入 ≈ 150/run` 是**错的分母**；正确闭合 = **374 条存活 succeeded 贡献 346,441（96.9%），≈926/run**。
- **间接效应（新增待查项）**：`dur` 包含进度排水 ⇒ 若 `execute_run` 在进度写完后才返回，则**并发 permit 被进度写库占用**（`MAX_CONCURRENT=4` 下吞吐被卡在 ~1.5 run/s）—— 既能解释 sim-live 批量 170 run 的漫长，也解释了 ⑤ 的并发混杂。列为 P4b 子项（先行仪表，不得推断）。
- **测量学教训（已入库）**：PG15+ 表级统计由后端周期性 flush（实测迟到 +13/+22/+64/+79）⇒ 任何「增量计数」实验必须用**长窗口协议**（前置 idle guard + 后置采样零漂移）；`settle 4×0.5 s` 不够。
- **已确认的异常（不是推测）**：`n_tup_upd = 357,386` vs 状态迁移所需 ~7k ⇒ 约 35 万次进度写入，且每次走 fsync（`synchronous_commit=on`）。

**架构裁决**：
1. **不改** 进度节流/写入策略 —— 但**理由已更新**：假设已收敛为**单变量（每帧写库延迟 × 1001 帧）**，P4b 必须先上仪表拿到「改动前基线」（帧数/写库耗时/是否持 permit），再改、再给前后对比。
2. **新增 D15：每 run 固定开销治理（先仪表、后优化）** —— 它将在 P2/P3 把引擎拉成线性后**成为短区间的主要成本**（千根 bar 的 run：引擎 6–15 ms vs 端到端 854–2,600 ms）。
3. **D1 预估算子形态改定**：因 R²=0.0007 且混入并发/批量效应，**过渡期不得给单一伪精确耗时数字**（见 D1 修订）。



> 口径声明：下表全部为**引擎内核口径**（`run_ensemble_with_quickjs` + 冻结输入，不含 jsonb 落库/进度帧/`spawn_blocking`/更重插件）。

| 项 | ADR 初稿（预测） | **实测** | 判定 |
|---|---|---|---|
| M1×93 天 分配量 | ≈5.4 GB | **5.41 GB** | ✅ 吻合 |
| M1×5 年 分配量 | ≈2.0 TB | **2.0186 TB** | ✅ 吻合到 **1.0001**（逐点；预测式 `slots×48B×Σ(i+1)`） |
| M1×5 年 时长 | 「小时级」 | **34.44 s / 104.60 s（3 slots）** | ❌ **初稿高估约 2 个量级**（实测复制带宽 ≈65 GB/s ⇒ 2 TB 仅需 ~31 s） |
| 渐近 log-log 斜率（n≥20k） | 期望 ≈2 | **1.878 – 1.900** | ✅ O(n²) 诊断成立 |
| 二次项占比 @93 天 | — | **59.2%**；交叉点 `b/a ≈ 10.0–10.4k bar ≈ 2 个月 M1` | ✅ 支持「93 天=膝点被写成产品规则」 |
| 峰值 RSS | （初稿只提「分配器抖动」） | **与 n 近乎无关**（290k×3 slots 仅 115 MB） | ✅ 复制是瞬时分配/释放，不驻留 |
| 隔离探针（`constant_score`，零指标调用） | — | 与 `dual_ma` **差 3%**（200k：15.11 vs 15.58 s） | ✅ **成本源是每 bar 上下文构造 + 历史复制，不是插件指标计算** |
| 模型分解 | — | `t = a·n² + b·n`：a=3.70e-10 s/bar²、b=3.83e-6 s/bar、**R²=0.999998**；3 slots = 3.03×a | ✅ 与「每 slot × 每 bar 复制整段历史」逐字吻合（`alloc ≈ 21.1 次/bar/slot`） |

**由此产生的两条决策修正**：
1. **D1 的「预估耗时」必须用生产端到端口径标定**，不得用本表（引擎内核）数值 —— 二者差 ~2 个量级（见 §2.3 注）。
2. **D14 顺序纪律保留，但 R2 的严重度下调**：改造前摘护栏的后果是「分钟级等待且无解释」，**不是**「小时级假卡死」（原叙事基于被推翻的时长估计）。纪律保留的理由从「防灾难」变为「防困惑 + 防低效」。

**判据之外的独立指纹（比斜率更强）**：`t/n²` 随 n 单调收敛到常数、`alloc_bytes` 与预测式吻合到 4 位有效数字、两点/三点局部斜率单调升向 1.9。这三个指纹在 P2 后的判定中必须一并复验（`alloc_bytes` 应塌缩为线性）。

### 2.3 实测基线（活库 `eestock-data` 127.0.0.1:5433 + 现网 run，2026-09）

| 量 | 实测值 | 来源 |
|---|---|---|
| `per_bar` jsonb 体积 | M5 3,250 bar = 40,835 B（**12.6 B/bar**）；D1 1,209 bar = 40,903 B（33.8 B/bar） | `pg_column_size(strategy_run_result.per_bar)`，15 条样本 |
| 引擎吞吐（QuickJS，1 slot） | M15 1,620–1,680 bars/s；D1 ~1,000 bars/s（含 ~0.3 s 实例化）。**口径 = 生产端到端**（含 per_bar jsonb 落库 + WS 进度帧 + `spawn_blocking` + 更重插件）；与 §2.5 的「引擎内核口径」**不可互比**（实测差 ~150×：内核每 bar 固定成本 b≈3.8 µs/bar） | `finished_at - started_at` ÷ `jsonb_array_length(per_bar)`；口径差异待分段取证（见 04-plan P1b） |
| M15 × 259 天推算 | ≈2,800 bar ⇒ 约 5 s（3 slots），jsonb ≈35 KB | 上两行推算 |
| M30 数据就绪度 | `kline_accurate_30m` **678,210 行，2012-01-04 ~ 2026-09-16** | 活库 count/min/max |

### 2.4 M30 门禁缺口（数据层早已就绪）

**已就绪（无需改动）**：`domain::types::Period::M30`；cagg `kline_accurate_30m` + `FALLBACK_30M`（15m rollup）(`storage/src/reader.rs:116`)；回测读源 `period_range_sql` M30 分支(`storage/src/backtest.rs:92`)；forming 桶 `"30 minutes"`(`reader.rs:131`)；`period_str`(`accurate.rs:15`)；`warmup_lookback` 1800 s(`bar_map.rs:43`)；看板多周期选择器。

**缺（门禁）**：`backtest::Period` 无 `M30` 变体(`backtest/src/types.rs:47`)；`application::bar_map::parse_period` 拒绝 M30(`:14-23`)；web 硬编码白名单(`web/src/workbench.rs:148`)；MCP schema/enum(`mcp/src/tools.rs:338,367,1020`)；前端 2 个 select；mock/format 映射。

> ADR-023 当年**明确**只做「数据层 + 看板/多周期」，回测档位被排除 —— 该排除注记由本 ADR 修订（见 04-implementation-plan P7）。

---

## 3. 决策

### D1 护栏语义：删除一切日历天数档
- `MINUTE_MAX_SPAN_DAYS` / `D1_MAX_SPAN_DAYS` **删除**（不是调值）。
- 最终态：**不按日历天数拒绝任何区间**。
- 保留**一条**由实测资源推导的极宽物理护栏（内存/预估时长），超限行为 = **二次确认放行**（不是硬拒）。
- **过渡期（引擎改造前）**：现有硬 400 立即改为「预估 bar 数 / 预估耗时 + 二次确认」，不阻提交。
  - **预估耗时的口径硬约束**（P1/P1b 实测教训）：必须包含**每 run 固定成本项**，且**不得**给单一伪精确数字（374 条真 run 的 `dur~bars` R²=0.0007，且样本混入并发/批量效应）。
    **过渡期口径**：显示①**精确 bar 数**（`count(*)` 预扫描）+ ②**耗时区间**（下界 = 引擎内核曲线（`.01-adr.md` §2.5），上界 = 下界 + 固定成本估计），并显式标注「估算值」；确认阈值用 **bar 数**（简单可解释），不用秒数。
    标定必须在 **P4b（固定开销治理）之后重做**，且须把**并发度**作为协变量排除混杂。

### D2 区间语义：按数据真实范围收缩
- `effective = [from, to) ∩ 可得区间`；响应回显 `requested_from/to` + `effective_from/to` + `clamped:true`。
- **中间缺口不截断**（按真实 K 线推进，沿用 `design/08-backtest/01-engine-adr.md` §3「不强制交易日历，回测天然含缺口」），只夹两端。
- warmup 取数窗同按可得数据夹取（`warmup_effective` 已有回显，silent shortfall 继续可见）。
- **空交集**（该标的该周期完全无数据）→ **400 + 回显可用区间**，禁止产出 0 笔「成功」run（静默失败）。

### D3 可得区间判定口径：**服务口径并集**（关键）
- 判定源 = `max(ts)`/`min(ts)` 取 **accurate ∪ 兜底**（与 `merged_sql` 服务口径一致），**不得**用 accurate 单层 —— accurate cagg 已知滞后（ADR-023 §2.4 实测：`kline_accurate_5m` 曾整周 0 行、长期靠兜底在服务），按单层判定会**切掉兜底本可服务的最新数据**，用户会误以为「数据只到上周」。
- **提交时**：轻量 min/max 查询（走 `(code, period, ts)` 索引）+ TTL 60 s 缓存 → 给用户即时反馈。
- **执行时**：以**真实取到的首末 bar** 为准做最终收缩并回显；两者不一致**以执行时为准**（不出现「提交说可行、执行说无数据」）。

### D4 取数：keyset 游标分页
- 端口新增按游标取数（`after_ts + limit`，**禁 OFFSET**，避免深分页退化）；chunk = 5,000 根。
- 内存占用 = chunk + 指标窗口，与区间总长**无关**。

### D5 引擎：会话化（`EnsembleSession`）
- 从「批式函数」→ 会话式：`push(bar) -> Vec<BarRecord>`；持仓 / Policy / Trailing / 插件实例常驻（现状本就是 per-bar 状态机，改动集中在把「入参切片」换成「喂入」）。
- 协作式取消保持**每 bar 检查**（成本可忽略），不退化为 chunk 边界。

### D6 指标：增量状态（**P1b 实测后由「优化」升级为「必需」**）
- `backtest::Indicators` 由「全量切片 + index」→ 增量/在线状态，每 bar O(window)。
- **必要性证据**（ADR §2.6 事实 1）：指标重插件（每 bar 调 macd/rsi/atr）的二次项系数是「历史复制」项的 **16.2×**，而分配量只多 1.17× ⇒ 纯 CPU ⇒ **只做 P2 对指标密集插件几乎无感（只消 1/16）**。
- ⇒ **P2 与 P3 同批交付、同一 gate**（合并为「引擎线性化」），不得只做 P2 就宣告长区间已解。
- **同序递推优先**：EMA / RSI(Wilder) 按与原实现**相同的累加顺序**逐步推进 ⇒ 与原值 **bit 级一致**。
- 无法同序的（`ma` 滑动窗口求和改变求和顺序）⇒ 记为**已知偏差项**，纳入容差 + 必须报告最大偏差（判据见 03-test-plan §1）。
- **禁止**「偏差随 bar 数增长」（那是实现错误，不是浮点误差）。

### D7 插件 ABI：兼容层，不做有界窗口
- 保留 `ctx.bars` = 全量历史**语义**，实现改**单一增长式共享缓冲**（消灭 `quickjs.rs:380` 的整段复制）。
- **不做**有界窗口 ABI 版本化（零插件受影响；列为后续债）。
- 内存代价 = n × 48 B（M1 5 年 ≈14 MB/run，可接受）。

> **D7 修订（2026-09-18，P2 验收后架构师裁定）——宿主侧 `BarCtx.bars` 语义收窄为前缀**：
> P2 会话路径下，宿主侧 Rust `BarCtx.bars` 由「调用方入参切片（含未来 bar）」收窄为 **`bars[0..=index]`**。
> - **JS 可观察 ABI 零变更**（`ctx` 从不注入 `bars`，仅 `ctx.bar`/`ctx.indicators.*`/`ctx.position`/`ctx.log`）；
> - 该收窄**移除了一个潜在前视面**（安全方向）；tester 独立实测：真实引擎路径下 `bars_len == index+1` **全行成立**、`ahead_visible` **全 false**，且仓内**无任何实现读取 `index` 之外的 bar**；
> - **遗留（转入 R2/P2b）**：兼容路径的两个生产调用点仍传全量切片（`crates/application/src/strategy.rs:907` 试算、`crates/simlive/src/plugin_orchestrator.rs:264`），即「可读未来」能力在上述两处**仍存在但未被使用** ⇒ 随 **P2b** 一并改为各持 `Rc<BarHistory>`；
> - 文档对齐：`types.rs` 注释已由 P2 澄清；本 ADR 在此记录裁定；`design/12-strategy-system/02-plugin-abi.md` 描述的是 **JS `ctx` 暴露面**（未变，无需改）。

### D8 落库：结果统一分块 + 旧 run 双读不回填
- 新表 `strategy_run_bars(run_id, kind, seq, ts_from, ts_to, payload)`，`kind ∈ {per_bar, net_value, drawdown}`，**边跑边写**（chunk 边界 = 5,000 根）。
- `strategy_run_result` 保留 `trades` / `metrics`（有界）+ 新增判别列 `result_format ∈ {legacy_single, chunked_v1}`（迁移 0027）。
  - **判别列是硬要求**：禁止用「空 `[]`」表达「数据在别处」——那会造成静默读空。
- 旧 run **双读路径，不回填**：旧数据体量小（现网最大 40 KB），回填无收益却需动生产库；审计要求旧 run 可读 ⇒ **不废弃**。

### D9 结果读取：summary / bars(分页|区间) / curve(显式抽样)
- `GET /result` 保留（兼容）：`legacy_single` 全量返回；`chunked_v1` 返回 `summary` + 首页 bars + `has_more:true` + `next_offset`（**显式**，不静默截断）。
- 新增分页/区间与抽样读法（详见 `02-spec.md` §3），`compare` 只返回抽样后的净值曲线（避免 N × 全量净值）。

### D10 ADR §13.4 口径修订
- 原文「后端不做有损预处理」精确化为：**「后端不做隐式、未标注的有损」**。
- 显式抽样（`sample=k`）允许，但响应**必须**带 `downsampled:true` + `original_bars`。
- 动机：长区间下浏览器需先收下全量（29 万点 × 多 slot + 净值 + 回撤 ≈ 数十 MB）再抽样，内存与传输均不可行。

### D11 试算：同口径去档；截断语义修正；同步先行
- 试算一起去日历天数档 + 同一收缩语义。
- **截断语义修正**：现为「丢尾部」（`MAX_SCORE_POINTS=50_000` 等），长区间会让曲线**只画前半段**（形状骗人：后半段不是没信号，是没返回）→ 改为**均匀抽样（保首尾）+ `downsampled:true` + `original_points:n`**。
- **顺序**：必须在引擎改造**之后**才放开（同步路径）。放开后若实测长区间同步不可接受 → 另立「试算转异步（返回 id + 进度 + 取消）」专项（**破坏性 wire 变更，需重新确认**）。

### D12 进度语义
- 提交时 `count(*)` 预扫描（走索引）得精确 total → 进度条诚实。
- 扫描失败/超时 → 退化为按 ts 归一化 `(cur_ts-from)/(to-from)`（**已知**非交易时段会长时间不动）。
- 取消：保持每 bar 生效。

### D13 M30 进回测/试算/MCP + 周期白名单单一事实源
- `backtest::Period` 增 `M30`；`bars_per_year` 按**名义** 252×8 = 2016。
  - 知情项：ADR-023 实测 M30 为 **10 桶/日**（含会话末薄桶），名义 vs 实测差异是**既有债**（M15 = 252×16 亦同），本次不动以免跨周期不可比。
- `application::bar_map::parse_period` 增 `"M30"`；web/MCP/前端**不得**再各自硬编码白名单 → 收敛为单一事实源（application 导出 `supported_backtest_periods()`），前端镜像 + **防漂移断言测试**（防「可选却被 400 拒」，用户踩的正是此类事故）。
- sim-live 加 M30 作为**独立小批**（不与本批混）。

### D15 每 run 固定开销治理（**已定位为单变量；仍遵守「先仪表、后优化」**）
- **现状（真路径实测）**：每 run 固定 **1003 次 `UPDATE strategy_run`**（1001 进度帧 + 2 状态迁移），帧数**封顶 1001、与 bars 无关**；端到端时长 ≈ `1003 × 每帧写库延迟`（实测 0.86 ms（历史中位）→ 3.45 ms（本轮 I/O））。
  实例：16,155 bar（≈M1 93 天）的 run 共 2.578 s，其中引擎 ~0.13 s ⇒ **~95% 墙钟花在进度写库**。
- **副作用待查**：进度排水在 `dur` 内且持并发 permit（`MAX_CONCURRENT=4`）⇒ 吞吐上限被压低。
- **纪律（硬）**：**先仪表、后优化**（假设已收窄，不需要再做探测式实验）：
  ① 先加计数器与 span：`progress_frames_{produced,sent}`、`progress_db_writes`、`progress_db_write_ms`、**permit 持有时间分解**（取数/引擎/序列化/落库/进度排水）；
  ② 拿「改动前基线」；
  ③ 候选方案（需用户确认）：**时间窗口节流（如 ≥250 ms/次）替 0.1% 粒度** / 合并写入（批量提交）/ **WS 帧保留、DB 持久化降频** / 缩小 `mark_succeeded` 前的排水等待；
  ④ 前后对比证据 + 用协变量重做标定。
- **依赖**：P5（摘护栏）的预估算子定值须在 P4b 之后重做。

### D14 顺序纪律（不可违反）
```
① golden 基线冻结 → ② tester 规模曲线取证 → ③ 引擎会话化 + 共享缓冲
→ ④ 指标增量 → ⑤ 分块落库 + 双读 + API → ⑥ 摘护栏 + 试算放开 → ⑦ 前端
```
**任何阶段不得跳序摘护栏**（先摘护栏 = 用户吃到**无解释的长时等待**，实测轻插件 34–105 s、指标重插件 ~8 分钟量级；D14 保留的理由是「防困惑 + 防低效」而非「防灾难」，见 §2.5/§2.6）。每阶段独立可回滚；P5 之前护栏仍在 ⇒ 可随时停在安全态。

---

## 4. 后果

### 4.1 正面
- 无日历天数档：用户「指定哪个范围就回测哪个范围」直接成立。
- 长区间从**不可行**变**可行**：M1 5 年由小时级（≈2 TB memcpy + 分配抖动）降至**分钟级**（O(n) 插件调用为主）。
- 内存 = chunk + 窗口 + 分块写出，与区间长度解耦；`MAX_BARS` 类补偿性护栏可删除。
- M30 可用；周期白名单单一事实源；超限从「看不懂的 400」变「可解释 + 可放行」。

### 4.2 成本 / 负面
- 引擎契约（`&[Bar] -> EnsembleResult`）与取数端口（`bars() -> Vec<Bar>`）变更 ⇒ 影响 4 个调用方：试算、工作台、sim-live「回测一下」对比、MCP。
- 迁移 0027 + 双读路径（读侧分支）+ `migrate_check` 自检同步。
- 前端取数路径改造（图表走抽样、明细走分页、K 线仍按区间）。
- 测试面：所有 span 相关断言重写（含前端 mock）。

### 4.3 风险与缓解
| 风险 | 缓解 |
|---|---|
| 改造引入口径漂移 | golden 基线 + 分层等价判据（bitwise 硬项 / ≤1e-9 漂移项）+ tester 独立复核（03-test-plan §1） |
| 长区间同步试算挂请求 | D11 顺序（先引擎后放开）+ 实测后决定是否转异步 |
| 磁盘增长 | 观测水位 + 手动删除端点；量级：M1 5 年单 run ≈4–6 MB，千次 ≈数 GB（不紧急） |
| 可得区间缓存陈旧 | TTL 60 s + **执行时以真实首末 bar 为准**（缓存只用于即时反馈） |
| 分块读边界（跨 chunk 区间查询） | 契约写明「返回可能含部分 chunk，调用方在 chunk 内精确过滤」+ 契约测试覆盖 |

---

## 5. 后续债（不在本 ADR 范围）
1. 有界窗口 `ctx.bars` ABI 版本化（真正 O(1) 插件内存）。
2. 试算转异步任务。
3. 名义 vs 实测年化口径统一（影响 M15/H1/M30 全部）。
4. 分块表保留策略（TTL/归档）。
5. `strategy_run.period` 列注释（迁移 0023 仍写 `M1/M5/M15/D1`）。
6. `MAX_BARS` 的最终去留（D1 的极宽物理护栏定值需 ② 的实测曲线支撑）。
7. **进度更新的端到端开销待取证**（P1 发现）：`PROGRESS_THROTTLE_MILLI = 1000`（千分之一）在短 run 上约等于**每 1.4 根 bar 一次 `UPDATE strategy_run SET progress`**，可能是「生产端到端 1,620 bars/s vs 内核 ~260k bars/s」的主因之一 —— **属假设，未取证不得动手优化**（见 04-plan P1b 的判别性实验 + P4 分段 span 复测）。
