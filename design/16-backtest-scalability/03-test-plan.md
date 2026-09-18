# 03-test-plan — TDD 规格与取证要求（ADR-024）

> 纪律（不可协商）：**先红后绿**（每个行为先有失败测试/失败取证，再写实现）；**证据优先**（代码阅读不算证据，须给工具原始输出）；**反假绿**（单测通过 ≠ 验收；长区间/等价性/真渲染须有实测输出）。
> 编号约定：`tester/test/` 从 **295** 起顺延；`tester/evidence/24x_*/` 存原始输出。

---

## 1. 等价性判据（P2/P3 的验收 gate，**返工风险最高项**）

引擎 O(n²) → O(n) 与指标增量化的**唯一判定标准**如下，禁止用「看起来一样」验收。

### 1.1 分层判据

| 层 | 判据 | 说明 |
|---|---|---|
| **A. bitwise 硬项** | 必须**逐字节相等** | `BarRecord.ts` / `warmup` 标记 / `signal` / `orders` / `events` / `trades`（含 open_ts/close_ts/price/qty/fee/bar_index）/ **持仓台账派生序列**（见 §1.3）/ `per_bar` 条数 / `net_value`、`drawdown` 的 ts 序列 |
| **B. 容差项** | **`|Δ| ≤ max(1e-12, 1e-9 × |expected|)`**（**2026-09 P1 裁决：绝对下限 1e-9（tester 实现值）收紧为 1e-12**；原字面仅相对 1e-9 对 `expected==0` 无定义，故必须有绝对项） | 指标值（ma/ema/macd/kdj/boll/rsi/atr）、各 slot 评分、聚合分、8 项绩效指标 |
| **B′. 报告硬要求** | P2/P3 的 gate 报告必须**逐字段列出所有 dev > 0 的条目**（`field, expected, actual, abs, rel`），**禁止只给全局 max 的聚合通过** | 否则偏差被聚合值掩盖，C 层斜率检验会因样本被压扁而失效 |
| **C. 禁止项** | 偏差**不得随 n 增长** | 若 max_dev 随 bar 数上升 ⇒ 判 **FAIL**（那是实现错误，不是浮点误差） |

### 1.2 golden 基线机制（P1 冻结，P2/P3 比对）

1. 选 **12 个代表性用例**：`{M1, M5, M15, M30, H1, D1} × {1 slot, 3 slots}`，覆盖 1 slot 与多 slot 的聚合路径。
2. 每用例 dump **输入** `bars.jsonl`（完整 bar 序列，用于隔绝数据漂移）+ **输出全量**（per_bar/net_value/drawdown/metrics/trades）。
3. 存放：`tester/evidence/240_adr024_golden_baseline/<case_id>/{bars.jsonl, expected.json}`（`expected.json` 含 `engine_commit` 与 `captured_at`）。
4. 比对器：`tester/evidence/240_adr024_golden_baseline/compare.mjs`（或 Rust 测试 harness）→ 输出 A/B/C 三层结果表 + 最大偏差 + 偏差-规模回归斜率。
5. **红色证据**：改造前先证明该 `compare.mjs` 对「人为扰动」敏感（例：把某策略权重 +1e-6 ⇒ 必须 FAIL）——**没有这条反向证据，比对器本身不可信**。

> 说明：`ma` 的滑动窗口求和改变求和顺序 ⇒ B 层容差；EMA/RSI 按同序递推 ⇒ 应落在 A 层（bit 级）。若实现选择非同序递推，须在 P3 报告中显式说明并给出 B 层最大偏差。

### 1.3 持仓台账可比序列（P1 发现的基线缺口，**必须在 P2 之前补进基线**）

- 现状：A 层只能比 `signal`/`orders`/`events`，**无独立的逐 bar 持仓序列**可比 ⇒ P2 若破坏持仓/摊薄逻辑，可能漏检。
- 裁决：新增**派生序列**（**不是**新增引擎状态）：由 `orders` + `trades` 按确定性规则逐 bar 累积出 `{ts, qty, avg_cost, cash}`，纳入 **A 层 bitwise 比较**。推导规则须写入 README 并以「重建后能逐笔回放 trades」自证。
- **时序硬约束**：golden 基线**只能在改造前捕获** ⇒ 本项属于 **P1b（先于 P2）**，不得推迟到 P2 之后。

---

## 2. 规模曲线取证（P1，tester 独立产出；D1 护栏定值的唯一依据）

### 2.1 矩阵与测量

| 维度 | 取值 |
|---|---|
| bars | 1k / 5k / 20k / 50k / 200k |
| slots | 1 / 3 |
| 重复 | 每点 3 次取中位（排除冷启动；首点单列标注） |
| 测量 | 墙钟；**峰值 RSS**（`/usr/bin/time -v` 或进程 RSS 采样）；**分配次数**（若可得）；bars/s |
| 重复与离散度 | 每点 3 次取中位；**spread = (max−min)/median** 必须报告；**spread > 5% 的点加测到 5 次**（P1 实测 200k/290k 的 1 slot 点 spread 达 9%） |
| 插件维度 | (a) `dual_ma`（生产参考插件）；(b) `constant_score` 隔离探针（已做）；**(c) 指标重插件（每 bar 调 `macd`/`rsi`/`atr` 各一次）—— P3 前的必测项**，用于量化指标二次项系数、决定 P3 的必要性与优先级（P1 已知限制 §8.1） |
| 基线 | **改造前**（当前 commit，直接调引擎/旁路 web 护栏）+ **改造后** |

### 2.2 判据（拟合 log-log 斜率）

```
主判据（渐近段，n ≥ 20k）：
  改造前：斜率 ≈ 2（可接受区间 1.8–2.2）   ← 证明 §2.2 的 O(n²) 根因诊断
  改造后：斜率 ≈ 1（可接受区间 0.9–1.1）   ← 证明改造生效
信息项（不作判据）：全域单幂律（1k…200k）—— P1 实测 1.568，低于 1.8 带；
  tester 指出「全域单幂律」与数据生成过程（a·n²+b·n）不符，属**判据定义错误**，
  已于 2026-09 P1 裁决改为「渐近斜率 + 独立指纹」：全域值仅作信息项。
独立指纹（三项须一并复验，比斜率更强）：
  ① t/n² 随 n 单调收敛到常数
  ② alloc_bytes 与 ≤ slots×48B×Σ(i+1) 对照（改造前 1.0001；改造后应塌缩为 O(n)）
  ③ 局部斜率单调升向 1.9（改造前）
200k × 3 slots：改造后墙钟与峰值 RSS 必须落在实测阈值内（作为 D1 极宽护栏定值输入）
```

### 2.3 产物（缺一即不合格）
- `tester/evidence/241_adr024_scale_curve/raw_pre.txt` / `raw_post.txt`（**原始命令与完整输出**，不得只给结论）
- `fit.md`：拟合式、斜率、置信/残差、每点三个重复值
- 结论段必须回答：**「93 天这个上限在实测曲线上对应哪个位置，其真实约束是时间还是内存」**

---

### 2.4 P1b 新增要求（架构裁决后）

**① 改造后曲线必须**双插件**各跑一次**（`dual_ma` + `indicator_heavy`）：两者渐近斜率均 ∈ [0.9, 1.1] 才算线性化。
> 理由（实测）：`indicator_heavy` 的 `t/n²` = **5.99e-9**，是 `dual_ma`（3.90e-10）的 **16.2×**，而分配量只多 1.17× ⇒ 多出的是**纯 CPU**（`macd/rsi/atr` 每次从 bar 0 重算）。**只看 `dual_ma` 会误判“已线性化”**（P2 单独只消 1/16 的二次项）。
> 时长预期（改造前，1 slot）：5k=0.163 s / 20k=2.424 s / 50k=14.99 s / 200k=**239.7 s**；⇒ M1×5 年至 290k bar 轻插件 34–105 s、重插件外推 ~500 s。

**② 每 run 固定开销取证（P4b，先仪表后优化）**
- 已知真路径异常（已确认，非推测）：`pg_stat_user_tables.strategy_run.n_tup_upd = 357,386` vs 状态迁移所需 ~7k ⇒ **约 35 万次进度写入**；该表 `synchronous_commit=on`。
- 已知真路径标定：374 条 succeeded run，**`dur ~ bars` R² = 0.0007**，median dur **0.854 s**。
- **副本（`243_.../raw_replica.txt`）只能当上界**：n=3,250 时进度写库 3,279 ms（1001 帧，均 3.3 ms/次）；但生产 median 仅 0.854 s ⇒ **必需存在背压/合并/丢弃**，否则时长应 ≥3 s。
- **下轮取证要求**：① 真路径计数器 `progress_frames_{produced,sent,dropped_by_backpressure}` / `progress_db_writes` / `progress_db_write_ms` + 每 run 分段 span（取数/引擎/序列化/落库/进度排水）；② ⑤ 重拟合必须**把并发度作为协变量**（D1 那批 170 run / 4 并发污染了样本，表现为 `1492 µs/bar` 而 M15/M5 斜率为负）。
- **纪律**：仪表未落地前，**禁止**凭推断改节流或写入策略（当前只能断言「异常存在」）。



### P2/P3 引擎（coder 写测试，tester 独立复核）——P3 已并入 P2
- [ ] 会话化后：分块喂入（chunk 边界 1/2/5000/非整除）与一次性喂入**输出等价**（A 层）
- [ ] 指标增量：每个指标在 `i ∈ {period-1, period, 2*period, n-1}` 处与旧实现等价（B 层 + 报告）
- [ ] 共享缓冲：`ctx.bars` 语义不变（插件按 `bars[0]`/`bars[i]` 取值仍正确）
- [ ] 取消：仍**每 bar** 生效（不得退化为 chunk 边界）；取消后不落 succeeded
- [ ] golden 12 用例全绿（A/B/C 三层）

### P4 存储/API
- [ ] 分块写入：跨 chunk 区间查询返回正确（含「部分 chunk 外沿」，调用方按 ts 过滤）
- [ ] `offset/limit` 边界：0、恰好一整块、跨块、超末尾
- [ ] `result_format` 判别：`legacy_single` 走旧路径逐值一致（双读）；`chunked_v1` 走分块；**空 payload 不得被当作无数据**
- [ ] `mark_succeeded` 守卫：取消后（status≠running）分块已写但 run 不落 succeeded
- [ ] `migrate_check` 自检：缺 `strategy_run_bars` 时拒绝启动（先迁移后重启）

### P5 区间语义 / 护栏
- [ ] 收缩：左超 / 右超 / 两端超 / 恰好等于端点 / 无交集 → 400 `range_empty` + 回显可用区间
- [ ] **可得区间并集口径**：构造「accurate 滞后而兜底有数据」场景（例：`kline_accurate_30m` 最新 ts 落后于 raw/rollup）⇒ `available_range` 必须取到兜底的最新 ts（**反向证据**：若改回 accurate 单层，该用例必须 FAIL）
- [ ] 无日历天数档：M15 × 259 天、M1 × 1 年、M30 × 2 年 必须可提交（旧断言 `259 天 → 400` 全部删除/反转）
- [ ] `resource_guard`：超阈值 → 400 带 `detail`（结构化字段可编程消费）+ `confirm` 语义放行
- [ ] 试算：同口径（去档）+ 截断均匀抽样（首尾保留 + `downsampled`/`original_points`）
- [ ] 进度：count 预扫描生效；扫描失败时退化路径可见（响应/日志标明实际使用的口径）

### P5 M30（三处 gate 一次到底）
- [ ] `bar_map::parse_period("M30")` ok；`backtest::Period::M30.bars_per_year() == 2016`
- [ ] `POST /api/workbench/runs` period=M30 → 201（且真能跑出结果，非仅校验通过）
- [ ] MCP `bt_run_ensemble` / `strategy_test_run` period=M30 → 接受
- [ ] 前端下拉含 30m 且提交成功（真渲染）
- [ ] **防漂移断言**：后端 `supported_backtest_periods()` == MCP schema enum == 前端常量 == `contract-vectors.json.backtest_periods`（逐字相等，一处改动必引起该测试红）

### P6 前端
- [ ] 图表走 `/curve`：点数 ≤ k 且**首尾保留**；`downsampled` 标注可见
- [ ] 逐 bar 表走 `/bars` 分页（大区间不一次性拉全量：断言请求数/分页参数）
- [ ] 日期控件 min/max 随周期/标的联动；收缩提示条在 `clamped:true` 时可见
- [ ] `resource_guard` 二次确认流程（过渡期）
- [ ] 真渲染（Playwright）：M30 选择 → 提交 → 结果页出图（**jsdom 桩不算**）

---

## 4. 门禁产物格式（每阶段提交时必须齐备）

| 产物 | 格式 | 谁产 |
|---|---|---|
| 失败测试原始输出（红） | 命令 + 完整输出（含 exit code） | coder |
| 通过输出（绿） | 同上 | coder |
| 反向证据（假绿排除） | 至少一条「故意破坏 ⇒ 必须 FAIL」的记录 | tester |
| 独立复核结论 | 与 coder 结论一致/不一致 + 差异证据 | tester（**不得复用 coder 的断言作为唯一依据**） |
| 契约/规模/真渲染原始输出 | 落 `tester/evidence/24x_*/` | tester |

---

## 5. 反假绿条款（硬性）

1. 禁止以「单测全绿」作为长区间能力已可用的证据 —— 必须给规模曲线（§2）。
2. 禁止以「jsdom/桩」作为前端验收（必须有真渲染）。
3. 禁止以「代码已改」作为等价性证据 —— 必须过 golden 比对（§1）并附最大偏差。
4. 禁止删除或弱化既有断言而不给出**替代断言**（例：删掉 `259 天 → 400` 必须补 `259 天 → 201`）。
5. 禁止把「可得区间收缩」的验证只做在 mock 层 —— 必须有活库场景（§3 P5 的 accurate 滞后用例）。
6. 迁移与 cagg 门禁按既有惯例给活库证据（`psql` 原始输出）。
