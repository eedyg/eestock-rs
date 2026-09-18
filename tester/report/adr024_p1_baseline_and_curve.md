# ADR-024 阶段 P1 取证报告 — golden 基线冻结 + 规模曲线（改造前）

> 产出角色：**tester**（取证/复核；**未改任何生产代码、未 commit、未调试**）。
> 本文件路径：`tester/report/adr024_p1_baseline_and_curve.md`。
> 判据来源：`design/16-backtest-scalability/03-test-plan.md` §1 / §2；上游 `01-adr.md` §2.2 / §3 D1–D14；`04-implementation-plan.md` §2 P1。
> 执行记录：`tester/test/295_adr024_p1_evidence_execution.md`；证据：
> `tester/evidence/240_adr024_golden_baseline/`、`tester/evidence/241_adr024_scale_curve/`。
> engine_commit = `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`；执行窗口 UTC 2026-09-17T16:02Z–16:15Z。

---

## 0. 结论速览

| # | 目标 | 结论 | 支撑原始输出 |
|---|---|---|---|
| A | **golden 基线冻结** | **完成 11/13 用例**（M30 ×2 待补，因 `backtest::Period` 无 M30）。三层比对器可用：**11 例全 PASS，max_abs_dev = max_rel_dev = 0**；敏感性反向证据齐备（1e-6 级漂移可捕获、同输入不误报） | `evidence/240_.../compare_report.txt`、`sensitivity/*.txt`、`freeze.log` |
| B | **规模曲线（改造前）** | **完成 16 点 ×3 重复 = 48 次运行，0 超时**。**渐近 log-log 斜率 = 1.878 – 1.900 ⇒ 落在判据带 1.8–2.2（O(n²) 诊断成立）**；分配量与大 n 处**预测吻合到 4 位有效数字（比值 1.0001）** | `evidence/241_.../raw_pre.txt`（1320 行原始命令+输出）、`analysis.txt`、`fit.md` |
| B | **必答问题** | **93 天（15k bar M1）位于 5k–20k 两点之间：0.127 s（1 slot）/ 0.382 s（3 slots），5.41 GB 分配，峰值 RSS 23 MB**；它恰在二次项**膝点**（交叉点 `b/a ≈ 10.0–10.4k bar ≈ 2 个月 M1`，93 天处二次项占 59%）⇒ 支持「93 天是 Σi 经验拐点被误写成产品规则」。**真实约束是时间（CPU/内存带宽），不是内存**（峰值 RSS 与 n 近乎无关：290k×3 slots 也只有 115 MB） | 同上 |
| — | **与 ADR §2.2 量级核算对照** | **体积口径完全支持**（5.4 GB ✓ 5.41 GB；2.0 TB ✓ 2.0186 TB）；**时长口径不支持**（ADR「秒级/小时级/1620–1680 bars/s」在本轮引擎内核口径下实测为 0.13–105 s，**差 ~2 个数量级**）⇒ 见 §4，需架构师确认口径 | §4 |

---

## 1. 目标 A：golden 基线冻结（判据 03-test-plan §1）

### 1.1 交付物

```
tester/evidence/240_adr024_golden_baseline/
├── README.md                 # 用例矩阵 + 判据精确规则 + 复跑入口 + 限制
├── export_bars.sh            # 活库 → bars.jsonl（一次性固化，脚本内逐字记录 SQL）
├── freeze.sh / freeze.log    # 11 例冻结（含每例 [cmd] 与 [run] 摘要）
├── compare.sh                # 比对器入口（可直接执行；退出码 0=PASS 2=FAIL）
├── compare_report.txt        # 全 11 例 A/B/C 三层原始输出
├── sensitivity/{m15_3slots,m15_1slot,m1_1slot_stop}_selftest.txt
└── <case_id>/{case.json, bars.jsonl, expected.json}     # 11 例
```

- 用例矩阵：`{M1,M5,M15,H1,D1} × {1 slot, 3 slots}`（10 例）+ **contain 用例 `m1_1slot_stop`**
  （M1×3000 bar，`warmup_bars=30` + **Intrabar ATR(2.0) 硬止损**；实测 87 笔交易、**47 次 StopTrigger 成交**、
  30 根 `warmup=true` ⇒ trades/events 非空路径已覆盖）。
- **11 例全部 trades/events 非空**（`freeze.log` 逐例 `[run]` 行）。
- 每例固化：**输入** `bars.jsonl`（含 `bars_sha256`）+ **输出全量** `expected.json`
  （`per_bar/trades/net_value/drawdown/metrics` + `engine_commit` + `captured_at` + `payload_sha256`），
  输出 JSON **逐字段复刻生产 wire 形态**（`application::workbench::bar_record_json`）。
- 数据来源：活库真实数据（`510880`；M1 ← `kline_merged`；M5/M15/H1/D1 ← `kline_accurate_*` cagg 单层，
  口径差异见 README §2）。**固化后 harness 不依赖 DB**（已实测：比对与曲线运行无 psql 调用）。

### 1.2 比对器（A/B/C 三层，精确规则见 README §3）

| 层 | 实现 | 11 例实测 |
|---|---|---|
| A bitwise | 整数字段（ts/bar_index/slot_idx/counts/各数组长度）逐位 + 非数值字段（warmup/signal/side/reason/错因串/结构键集/数组长度）严格相等 | PASS（0 处不等） |
| B 容差 | 浮点字段 `abs ≤ 1e-9 或 rel ≤ 1e-9`；逐例输出 **max_abs_dev / max_rel_dev** + 字段路径 | PASS（**max = 0.0**） |
| C 规模依赖 | 11 例 (bars, max_abs_dev) 的 log-log 回归；最大例非零偏差且斜率 ≥0.5 ⇒ FAIL | PASS（全 0 ⇒ 斜率 n/a） |

比较规模：11 例共 ~100k 个字段（`A_ck+B_ck`）。

### 1.3 敏感性反向证据（硬要求）

`compare.sh --selftest <case>` 对 3 个用例各跑 5 个探针，全部**符合预期**（`sensitivity/*.txt`）：

| 探针 | `m15_3slots` | `m15_1slot` | `m1_1slot_stop` |
|---|---|---|---|
| 控制组（同输入重跑） | PASS | PASS | PASS |
| 权重 ×(1+1e-6) | **FAIL**（A 7 / B 1157 条） | PASS（**数学无操作，见下**） | PASS（同上） |
| 中段（持仓中）close ×1.001 | **FAIL** | **FAIL** | **FAIL** |
| 末根 close ×1.001 | **FAIL** | **FAIL** | **FAIL** |
| 中段 close ×(1+1e-6) | **FAIL**（rel 7.0e-5） | **FAIL**（rel 2.2e-4） | **FAIL**（rel 2.2e-3） |

> **重要细节（已实测备案）**：**单 slot** 下 `aggregate = (w·s)/w ≡ s`，权重被数学约掉
> ⇒ 「权重 +1e-6」在单 slot 用例里是**无操作输入**，比对器给 PASS **是正确的**。故权重探针的硬断言
> 落在 **3 slots** 用例；单 slot 用例由 close 探针（含 1e-6 量级）承担 —— 该 1e-6 级微扰**被捕获**，
> 证明 B 层 ≤1e-9 判据足够紧。**结论：比对器可信（能捕获 1e-6 级漂移，且不误报）。**

### 1.4 目标 A 的限制（不能当作已闭环的地方）

1. **M30 × {1,3 slots} 两用例缺失**（P0 前置未落地）⇒ 现状 **11/13**。P2/P3 若要判「周期维度全覆盖」，
   必须先由 P0 补齐后再冻结。
2. **持仓台账无独立输出**：引擎内部 `Holding` 不落 wire payload，「持仓台账」只能间接由
   `trades`（open/close ts、bar_index、qty、pnl）+ `per_bar.events[fill]` 观察（A/B 层均比，但无逐 bar 持仓序列）。
3. **NaN/±Inf 不可区分**：JSON 无法表达非有限浮点（序列化为 `null`）⇒ `null==null` 判等；本基线 11 例
   `metrics` 均为有限值（已核）。
4. B 层加了 **1e-9 绝对下限**（消除「期望值≈0/denormal」的相对误差假 FAIL，例 `drawdown` ~1e-310）；
   比 03-test-plan 字面略宽，**如需严格纯相对判据请架构师在 P2 gate 前确认**。

---

## 2. 目标 B：规模曲线（改造前，判据 03-test-plan §2）

### 2.1 原始输出

- **`tester/evidence/241_adr024_scale_curve/raw_pre.txt`**（1320 行）：环境元数据 + 每条 `/usr/bin/time -v`
  原始命令 + **完整输出**（墙钟/CPU/峰值 RSS/页大小/退出码）+ harness `POINT` 行（内部墙钟、bars/s、
  分配次数/字节、VmHWM、trades、per_bar）。`[EXIT] 0` × 48，**`[EXIT] 124`（timeout）0 个**。
- `analysis.txt`（`python3 analyze.py raw_pre.txt`）：每点三次重复 → 中位/离散度、局部与渐近斜率、
  两模型拟合、分配量对照；`fit.md`：人读结论页。

### 2.2 矩阵与测量（每点 3 次取中位）

| bars | slots=1 中位 wall_s | slots=3 中位 wall_s | alloc (1 slot) | alloc (3 slots) | 峰值 RSS |
|---|---|---|---|---|---|
| 1,000（冷启动敏感点，±25% 粒度） | 0.0040 | 0.0120 | 0.02 GB | 0.07 GB | 22.6 MB |
| 5,000 | 0.0240 | 0.0700 | 0.60 GB | 1.81 GB | 22.8 MB |
| 20,000 | 0.2070 | 0.6220 | 9.61 GB | 28.83 GB | 23.6 MB |
| 50,000 | 1.1270 | 3.3990 | 60.04 GB | 180.09 GB | 24.9 MB |
| 200,000 | 15.5840 | **47.2150** | 960.14 GB | 2,880.34 GB | 60.1 / 86.6 MB |
| *附加* 15,000（≈M1×93 天） | 0.1270 | 0.3820 | 5.41 GB | 16.23 GB | 23.3 MB |
| *附加* 290,000（≈M1×5 年） | 34.4370 | 104.5980 | 2,018.61 GB | 6,055.70 GB | 85.5 / 115.0 MB |

- **隔离探针**（`constant_score`，`on_bar` 恒返回常数、无任何指标调用）：20k = 0.190 s / 200k = 15.108 s
  —— 与真实插件 `dual_ma` 同点（0.207 / 15.584 s）**仅差 3%** ⇒ 成本来自**每 bar 的上下文构造 + 历史复制**，
  与插件指标计算无关（ADR §2.2 锚点 1 的定位被独立证实）。

### 2.3 斜率判据

| 拟合 | 1 slot | 3 slots |
|---|---|---|
| **全域**（1k…200k 单幂律） | 1.568 | 1.572 — *低于判据带，原因见下* |
| 局部 20k→50k | 1.849 | 1.853 |
| 局部 50k→200k | 1.895 | 1.898 |
| **渐近**（n≥20k，3 点） | **1.878**（rms 0.0117） | **1.882**（rms 0.0115） |
| **渐近**（n≥50k，2 点） | **1.895** | **1.898** |
| 渐近（15k→290k，附加点） | 1.892 | 1.895 |
| **渐近（隔离探针 ctrl，20k→200k）** | **1.900** | — |

- **判据回答**：改造前**渐近斜率 1.878–1.900 ∈ [1.8, 2.2] ⇒ 支持 ADR §2.2「引擎 O(n²)」诊断**。
- **全域拟合 1.57 的偏离已量化、非噪声**：小 n 段斜率 ≈1.10（线性项主导），随 n 单调升到 1.85–1.90；
  单一幂律跨 200× n 区间不成立。**建议判据以「渐近斜率」表达**（否则判据本身与数据生成过程不符）。
- 二次项指纹：`t/n²` 随 n 单调收敛（1 slot：4.00e-9 → 3.90e-10 → 4.10e-10 @290k）。

### 2.4 模型分解（判据的量化形式）：`t = a·n² + b·n`

| 系列 | a (s/bar²) | b (s/bar) | R² | `t=c·n` 的 R² |
|---|---|---|---|---|
| dual_ma, 1 slot | **3.7045e-10** | **3.8327e-06** | **0.999998** | 0.9479 |
| dual_ma, 3 slots | **1.1242e-09** | **1.1237e-05** | **0.999998** | 0.9478 |

- **slots 维度线性**：(a,b)₃ = **3.03×/2.93×** (a,b)₁ ⇒ 每 slot 一份同样的复制与上下文（与 ADR §2.2 锚点 1 一致）。
- 二次项占比：1k 8.8% → 5k 32.6% → **15k（93 天）59.2%** → 20k 65.9% → 50k 82.9% → **200k 95.1%** → 290k 96.6%。
- **线性/二次交叉点 `n* = b/a ≈ 10,350 bar`（1 slot）/ 9,996 bar（3 slots）≈ 2 个月 M1**。
- 渐近等效复制带宽 ≈ **64.8 GB/s**（1 slot）/ 21.3 GB/s（3 slots）⇒ 二次项是**内存带宽/页回收**问题，不是 CPU 算力。

---

## 3. 必答问题：93 天在曲线上对应哪个位置？约束是时间还是内存？

1. **位置**：15,000 bar（≈ M1×93 天：240 bar/交易日 × 63 交易日）落在 **5k（0.024 s）与 20k（0.207 s）之间**：
   实测 **0.127 s / 5.41 GB / 23.3 MB RSS**（1 slot）、**0.382 s / 16.23 GB / 23.4 MB**（3 slots）。
2. **它恰在「膝点」**：二次项/线性项交叉在 ≈10.0–10.4k bar（≈2 个月 M1）；93 天处二次项已占 **59%**。
   ⇒ **定性支持 ADR §2.2「93 天是 Σi 经验拐点被误写成产品规则」**（拐点为真，代码层面被固化成日历天数档）。
3. **真实约束 = 时间，不是内存**：
   - 93 天单跑 0.13–0.38 s，两类资源都不是瓶颈；
   - 约束在**斜率**：n 翻倍 ⇒ 时间 ×≈3.7（2²），内存几乎不变；
   - 峰值 RSS 与 n **近乎无关**（22 MB → 115 MB，跨 290× 的 n）：复制是瞬时分配/释放，不驻留。
   - 现护栏真正拦的是**二次项随区间的增长速度**；但**在今日机器上它并非「防卡死」护栏**
     （M1×5 年 1 slot 仅 **34 s**、3 slots **105 s**）—— 详见 §4 的口径差异。

---

## 4. 与 ADR §2.2 量级核算的实测对照

### 4.1 体积（复制量）口径：**完全支持**

| 场景 | ADR 预测 | 实测分配字节 | 比值 | 实测墙钟 | 峰值 RSS |
|---|---|---|---|---|---|
| M1 × 93 天（15,000 bar，1 slot） | ≈5.4 GB | **5.41 GB** | 1.002 | 0.127 s | 23.3 MB |
| M1 × 93 天 × 3 slots | — | 16.23 GB | =3× | 0.382 s | 23.4 MB |
| M1 × 5 年（290,000 bar，1 slot） | **≈2.0 TB** | **2,018.61 GB（2.0186 TB）** | **1.0001** | 34.44 s | 85.5 MB |
| M1 × 5 年 × 3 slots | — | 6,055.70 GB | =3× | 104.60 s | 115.0 MB |
| M1 × 200k（矩阵上界，1 slot） | — | 960.14 GB | — | 15.58 s | 60.1 MB |

逐点对照（实测 vs `slots×48B×Σ(i+1)`）在 n=200k/290k 处**吻合到 4 位有效数字（1.0001）**，
`alloc_count = 21.1/bar`（1 slot）/ 57.1/bar（3 slots），差值恰为 18/slot/bar（其中 1 次即
`quickjs.rs:380` 的整段复制，17 次为每 bar 的 QuickJS 上下文对象）。

> **⇒ 「每 slot × 每 bar 复制整段历史（48 B/bar）」的根因诊断在体积维度被实测**逐位**证实。**

### 4.2 时长口径：**不支持**（需架构师确认口径后再用于 D1 定值）

| 断言 | ADR | 本轮实测（引擎内核口径） |
|---|---|---|
| M1×93 天 | 「秒级」 | **0.127 s**（1 slot）/ 0.382 s（3 slots） |
| M1×5 年 | 「**小时级**；且分配器抖动」 | **34.44 s**（1 slot）/ 104.60 s（3 slots） |
| 引擎吞吐 | M15 **1,620–1,680 bars/s**；D1 ~1,000 bars/s | 每 bar 固定成本 **b ≈ 3.8 µs/bar**（≈260k bars/s 上界）；大 n 段 12.8k bars/s（200k，1 slot） |

- 复制带宽实测 ≈ **65 GB/s**（§2.4）⇒ 2 TB 复制本身只需 ~31 s，与「小时级」差 ~2 个数量级。
- **不解释为「ADR 算错」**：ADR §2.3 的吞吐来自生产 run 的 `finished_at − started_at`，其中含
  **per_bar 全量 jsonb 落库、WS 进度帧、`spawn_blocking` 调度、以及更重的插件（macd/kdj 类）**；
  本轮是**纯引擎 + 冻结输入**。二者**不可直接互比**（本报告全部数字应标注为「引擎内核口径」）。
  **此归因属推断，tester 不下根因结论，需架构师确认**（重要：它直接影响 D1「过渡期二次确认」的论据与
  R2「先摘护栏 ⇒ 小时级假卡死」的风险等级 —— 按本轮实测，M1 5 年在本机是 **34 s / 105 s**，不是小时级）。
- 另：ADR §2.2 表内「M1×1 年 ≈80 GB / 数十秒」「D1×5 年 ≈0.03 GB」等量级**未被本轮直接测**（本轮有
  93 天、5 年两个锚点 + 200k 点，量级关系与之自洽）。

---

## 5. 未完成 / 超时 / 外推（逐条标注）

| 项 | 状态 | 说明 |
|---|---|---|
| 矩阵 5×2 点 × 3 重复 | ✅ 完成（30 次运行） | 无 timeout |
| 附加点 15k/290k × 2 slots × 3 重复 | ✅ 完成（12 次运行） | 标注为**矩阵外附加点**（用于回答 93 天/5 年问题） |
| **超时点** | **0 个** | `grep '[EXIT] 124' raw_pre.txt` 无命中；故本轮**无需**外推 |
| **改造后曲线（`raw_post.txt`）** | ⛔ 本阶段不做 | P2 完成后补；判据：渐近斜率 ∈ [0.9, 1.1] 且 `alloc_bytes` 塌缩为 O(n)。复跑入口见 §7 |
| **M30 用例 ×2** | ⛔ 待 P0 | `backtest::Period` 无 M30 变体（当前 HEAD） |
| 外推（若 P2 后需 n>290k 预测） | 提供拟合式，**标注为外推、非实测** | `t₁slot(n) ≈ 3.7045e-10·n² + 3.8327e-06·n`（R²=0.999998）；`t₃slots(n) ≈ 1.1242e-09·n² + 1.1237e-05·n` |
| 数据拼接 | 未使用 | `510880` 单标的 M1 有 861,093 根，200k/290k 均为**连续后缀**，ts 严格升序（harness 内置升序断言） |

---

## 6. 发现的异常与残余风险

1. **【决策相关】ADR §2.3 的吞吐/时长数字在本轮回测口径下无法复现**（§4.2）⇒ D1 过渡期「预估耗时 +
   二次确认」的阈值、R2 的严重度、以及「93 天/5 年是资源护栏」的叙事，建议以**本轮曲线**为定值输入；
   若以 ADR §2.3 数字定值会高估约 2 个数量级。**需架构师裁决口径**（本报告不代替裁决）。
2. **单 slot 权重探针是数学无操作**（§1.3）——后续任何人做「权重扰动」敏感性测试时都会踩；已写入 README。
3. **B 层判据的绝对下限 1e-9**（§1.4 第 4 条）：比 03-test-plan 字面宽一档，建议 P2 gate 前书面确认。
4. **M30 用例缺失**（§1.4 第 1 条）：P2/P3 的周期维度覆盖不完整。
5. **持仓台账无独立可比序列**（§1.4 第 2 条）。
6. **数据小坑（既有，非本轮引入）**：`kline_accurate_{5m,15m,1h}` 的**最后一根是薄桶**
   （`open=high=low=close`、volume 骤降，例 ts=1789542000 = `3.367×4, vol=179500`）—— 已按原样固化并备案。
7. **同机负载导致的测量抖动**：200k/290k 的 1 slot 点 3 次重复 spread 达 **9%**（3 slots 0.4–2.6%）；
   已用 3 次中位缓解，绝对值仍有 ±10% 环境偏差。测量期间 swap 7/7 GB 已满、RAM available ~12.6 GB
   （**未触发 OOM**，峰值 RSS 最高 115 MB）。
8. **计时粒度**：1k 点（4 ms，整数毫秒）相对误差 ±25%，已标注为冷启动敏感点、不参与渐近判据。
9. **slots=3 用同一插件**：只量 slots 线性放大；`macd/kdj`（插件内自持 O(index) 重算）的额外二次项未纳入矩阵
   ⇒ 若需要「最坏情况」曲线需补组合点（P2 后可选）。
10. **仓库工作区既有改动（非本任务产生，供 reviewer 排除干扰）**：
    `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` 在本任务开始前即为 modified（本次未触碰）。

---

## 7. 复跑入口（逐字可执行）

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs

# ── 构建 harness（独立 workspace，仅 path 依赖仓内 crate；不改仓库根 Cargo.toml）──
CARGO_TARGET_DIR=$PWD/target cargo build --offline --release \
  --manifest-path tester/harness/adr024_harness/Cargo.toml

# ── A) golden：冻结（11 例；写 expected.json，含 engine_commit/captured_at）──
bash tester/evidence/240_adr024_golden_baseline/freeze.sh
# ── A) golden：比对（P2/P3 gate；退出码 0=PASS 2=FAIL）──
bash tester/evidence/240_adr024_golden_baseline/compare.sh
# ── A) 敏感性反向证据 ──
bash tester/evidence/240_adr024_golden_baseline/compare.sh --selftest m15_3slots
# ── A) 输入重导（可选；活库需在跑）──
bash tester/evidence/240_adr024_golden_baseline/export_bars.sh m1_1slot kline_merged 510880 1500

# ── B) 规模曲线：改造前已跑完（raw_pre.txt）；改造后重跑写 raw_post.txt ──
bash tester/evidence/241_adr024_scale_curve/run_scale.sh       > tester/evidence/241_adr024_scale_curve/raw_post.txt 2>&1
bash tester/evidence/241_adr024_scale_curve/run_scale_extra.sh >> tester/evidence/241_adr024_scale_curve/raw_post.txt 2>&1
# ── B) 分析（每点三次重复 / 局部+渐近斜率 / 两模型分解 / 分配量对照）──
cd tester/evidence/241_adr024_scale_curve
python3 analyze.py raw_post.txt > analysis_post.txt   # 改造前：analyze.py raw_pre.txt > analysis.txt
```

P2 后判据：**渐近 log-log 斜率 ∈ [0.9, 1.1]**；`alloc_bytes` 与 n 呈**线性**（不再 n²）；
峰值 RSS 会**上升**到 n×48 B（290k ≈ 14 MB/run，D7 已接受的代价）。
