# ADR-024 golden 基线（P1 冻结）— `tester/evidence/240_adr024_golden_baseline/`

> 本目录是 ADR-024（`design/16-backtest-scalability/01-adr.md`）D14 顺序纪律中 **① golden 基线冻结** 的
> 全部产物：输入 bar 序列固化 + 生产引擎全量输出固化 + **三层比对器** + **比对器敏感性反向证据**。
> 判据来源：`design/16-backtest-scalability/03-test-plan.md` §1（A/B/C 三层 + 反向证据硬要求）。
> 本目录文件自身路径：`tester/evidence/240_adr024_golden_baseline/README.md`。

> **P2b 增补（2026-09-18，tester）—— M30 两例补齐（11 → 13）**：ADR-024 P0 打通 M30 后，
> 本基线补齐 `m30_1slot` / `m30_3slots`（数据源 `kline_accurate_30m`，口径与既有 11 例一致）。
> **这两例是「P2 后基线」（`baseline_kind: "post_p2_regression"`），明确不得作为跨 P2 等价证据** ——
> 原因与替代覆盖见 §1.1。既有 11 例的 `payload_sha256` 本次**逐例未变**（仍为 pre-P2 冻结）。
> 验收证据：`tester/evidence/249_adr024_p2b_verify/B_0*.txt`；报告：`tester/report/adr024_p2b_and_m30_golden_verification.md` §B。

> **P1b 增补（2026-09-17，tester）**：本基线在 P1 冻结之上**新增** `expected.json.derived`
> （持仓台账派生序列，见 §3.1）与**新 B 层判据** `max(1e-12, 1e-9×|expected|)` + **B′ 逐字段枚举**（见 §3）。
> 既有 `result` 的 `payload_sha256` **逐例未变**（`242_adr024_baseline_extension/pre_ledger/payload_sha256_{before,after}.txt`）。
> 报告：`tester/report/adr024_p1b_baseline_extension.md`。

---

## 1. 用例矩阵（13 个）

| # | case_id | 周期 | bars | slots | warmup | stop | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | `m1_1slot` | M1 | 1500 | 1 | 0 | — | 矩阵 A |
| 2 | `m1_3slots` | M1 | 1500 | 3 | 0 | — | 矩阵 A |
| 3 | `m5_1slot` | M5 | 1200 | 1 | 0 | — | 矩阵 A |
| 4 | `m5_3slots` | M5 | 1200 | 3 | 0 | — | 矩阵 A |
| 5 | `m15_1slot` | M15 | 1000 | 1 | 0 | — | 矩阵 A |
| 6 | `m15_3slots` | M15 | 1000 | 3 | 0 | — | 矩阵 A |
| 7 | `h1_1slot` | H1 | 800 | 1 | 0 | — | 矩阵 A |
| 8 | `h1_3slots` | H1 | 800 | 3 | 0 | — | 矩阵 A |
| 9 | `d1_1slot` | D1 | 500 | 1 | 0 | — | 矩阵 A |
| 10 | `d1_3slots` | D1 | 500 | 3 | 0 | — | 矩阵 A |
| 11 | `m1_1slot_stop` | M1 | 3000 | 1 | **30** | **ATR(2.0) Intrabar** | contain 用例：真实订单 + 硬止损触发 + warmup 段 |
| 12 | `m30_1slot` | M30 | 1000 | 1 | 0 | — | 矩阵 A；**【P2 后基线】**见 §1.1 |
| 13 | `m30_3slots` | M30 | 1000 | 3 | 0 | — | 矩阵 A；**【P2 后基线】**见 §1.1 |

- 标的固定 `510880`；slots：`dual_ma{fast:5,slow:20,w:1.0}`；3 slots 追加
  `macd{fast:12,slow:26,signal:9,w:0.5}` + `kdj{n:9,k_period:3,d_period:3,w:1.5}`（覆盖加权聚合路径）。
- 引擎参数（全部用例一致，除 stop/warmup）：`buy_threshold=60 / sell_threshold=40 /
  policy=LumpSum(position_pct=1.0) / initial_capital=100000 / FeeModel::default()`。
- **M30 用例（2026-09-18 补齐，P2b 验收任务 B）**：`m30_1slot` / `m30_3slots` 已落盘，
  数据源 `kline_accurate_30m`（活库 `eestock-timescaledb`，导出命令见 `freeze.log`／
  `249_adr024_p2b_verify/B_01_export_m30_bars.txt`），`baseline_kind = "post_p2_regression"`（见 §1.1）。
  本基线因此为 **13/13** 用例。
- 每个用例的实跑结果（冻结时输出）：**13 例 trades/events 均非空**（含 contain 用例
  `m1_1slot_stop`：87 笔交易、47 次 `StopTrigger` 成交、30 根 `warmup=true`；新增
  `m30_1slot`：26 笔交易 / 52 次成交；`m30_3slots`：80 笔交易 / 163 次成交）——见 `freeze.log`
  与 `249_adr024_p2b_verify/B_02_freeze_m30.txt`。

### 1.1 `baseline_kind`：pre-P2 冻结 vs **P2 后基线**（判读纪律，**硬约束**）

| case | `baseline_kind` | 冻结时源码状态 | 可作为「跨 P2 等价证据」？ |
|---|---|---|---|
| 既有 11 例 | （缺省，= pre-P2 冻结） | HEAD `18d1b9a`（**P0/P2/P2b 落地前**，2026-09-17T16:23:40Z） | **可以**（这正是 P2 gate 的判据来源） |
| `m30_1slot` / `m30_3slots` | `post_p2_regression` | HEAD `18d1b9a` **+ staged P0(M30 打通) / P2(引擎线性化) / P2b(试算+sim-live 线性化)**（2026-09-18T05:54:35Z） | **不可以** |

**为什么 M30 两例「不得作为跨 P2 等价证据」**（三条，缺一不可）：

1. **pre-P2 的 M30 不可捕获**：M30 档位是 **P0** 才打通的（`backtest::Period::M30` 变体与
   `application::bar_map::parse_period("M30")` 均随 P0 落地）。在 P2 改造前根本跑不出 M30 golden，
   故不存在「pre-P2 M30 期望值」这一物 —— 拿 post-P2 冻结的 M30 去「证明 P2 没改变 M30 行为」
   是**自证循环**（期望值与待验实现同源，同源全绿零信息）。
2. **引擎路径与周期无关**：P2 改的是「共享历史缓冲 + 逐 bar push + 前缀 ctx.bars」这一**与周期无关**的
   喂数据机制（`strategy-core::engine::step` 对任何 `Period` 同一路径）。跨 P2 等价因此由**5 个周期
   的既有 11 例**（M1/M5/M15/H1/D1 × 1slot/3slots + contain 例）覆盖；M30 的边际信息量仅在于
   「周期枚举新增一档不炸」。
3. **它覆盖的是另一件事**：M30 两例的正确用途是 **P0 之后（含 P2/P2b 之后）的回归守卫** ——
   冻结后任何改动（含 P5/后续批次）若改变 M30 的引擎行为/指标/年化口径，这两例必须变红
   （反向证据见 §6 第 6 条与 `249_.../B_04_reverse_m30_annualization.txt`）。

> 判读纪律：**看到 `baseline_kind == "post_p2_regression"` 的用例全绿，只能说「相对 P2 后状态未回归」，
> 不能反推「P2 未改变行为」。** 后者只能引用 §1 表 1–11（pre-P2 冻结）的比对结果。

## 2. 目录结构

```
240_adr024_golden_baseline/
├── README.md                      # 本文件
├── export_bars.sh                 # 输入导出脚本（活库 → bars.jsonl，一次性固化）
├── freeze.sh                      # 基线冻结脚本（跑生产引擎 → expected.json）
├── freeze.log                     # 冻结原始输出（含每例 [cmd] 与 [run] 摘要）
├── compare.sh                     # 比对器入口（可直接执行）
├── compare_report.txt             # 全 13 例比对原始输出（A/B/C 三层）
├── sensitivity/                   # 比对器敏感性反向证据（selftest 原始输出）
│   ├── m15_1slot_selftest.txt
│   ├── m15_3slots_selftest.txt
│   ├── m1_1slot_stop_selftest.txt
│   ├── m30_1slot_selftest.txt      # P2b 验收补做（13 例口径）
│   └── m30_3slots_selftest.txt     # P2b 验收补做（13 例口径）
└── <case_id>/
    ├── case.json                  # 输入配置（策略/参数/权重/阈值/policy/stop/warmup/fee）
    ├── bars.jsonl                 # 输入 bar 序列（完整、固化；ts 严格升序）
    └── expected.json              # 输出全量 + engine_commit + captured_at + 两个 sha256
```

### `expected.json` 字段

| 字段 | 含义 |
|---|---|
| `case_id` / `schema_version` | 用例 id / 基线格式版本（1） |
| `engine_commit` | 冻结时 `git rev-parse HEAD` |
| `captured_at` | 冻结时刻（UTC RFC3339） |
| `bars_count` / `bars_sha256` | 输入 bar 条数 / `bars.jsonl` 原始字节 sha256（输入漂移守卫） |
| `config` | `case.json` 原文（复现前提全量钉住） |
| `payload_sha256` | `result` 规范化 JSON 字节 sha256（整包完整性快检） |
| `engine_run_wall_ms` | 冻结时引擎墙钟（仅参考，非判据） |
| `result` | `{per_bar, trades, net_value, drawdown, metrics}` **全量输出** |

`result` 的 JSON 形态**逐字段复刻生产 wire 形态**（`crates/application/src/workbench.rs::bar_record_json`
+ `to_run_result`），即基线冻结的就是线上 payload：`per_bar[i] ∈ {ts,warmup,scores[{slot_idx,score[,error]}],
aggregate,signal,orders[{side,qty,reason}],events[plugin_error|circuit_breaker|plugin_log|fill]}`。

### 输入来源口径（可复现，固化后不依赖 DB）

| 周期 | 视图 | 说明 |
|---|---|---|
| M1 | `kline_merged` | 与生产 `storage::backtest::M1_RANGE_SQL` 同源 |
| M5/M15/H1/D1 | `kline_accurate_{5m,15m,1h,1d}` | **accurate cagg 单层**（生产另有 `UNION ALL` 底层兜底反连接；基线只固化**输入**，故读源差异不影响等价性判定） |

- 取数方式：`ORDER BY ts DESC LIMIT n` 后升序输出（同一标的的**最近 n 根**，各周期窗口互不重叠）；
  `export_bars.sh` 逐字记录命令。导出后 `bars.jsonl` 自带 `bars_sha256`，任何数据漂移即可见。
- 活库：`docker exec eestock-timescaledb psql -U eestock -d eestock`（TimescaleDB 2.29.2-pg16）。

## 3. 比对器（A/B/C 三层）

入口：`bash compare.sh`（= `cargo run --release --manifest-path ../../harness/adr024_harness/Cargo.toml
-- compare --baseline <本目录>`）。**逐用例重跑生产引擎**（`strategy-core::run_ensemble_with_quickjs`，
真实 QuickJS 插件字节）后与 `expected.json` 对比；退出码 `0=PASS / 2=FAIL`。

| 层 | 判定规则（精确实现） | 结果 |
|---|---|---|
| **A. bitwise 硬项** | JSON **整数字段**（`ts`/`bar_index`/`slot_idx`/`trade_count`/各数组长度）逐位相等；**非数值字段**（`warmup` 布尔、`signal`/`side`/`reason`/错因字符串、结构键集、数组长度）严格相等 | 任一不等 ⇒ FAIL |
| **B. 容差项** | **浮点字段**（`aggregate`、各 slot `score`、`net_value`/`drawdown` 数值、`orders[].qty`、`trades[].{qty,price,fee,pnl,shares,…}`、8 项 `metrics`）满足 `abs_dev ≤ 1e-9` **或** `rel_dev ≤ 1e-9`；逐用例输出 **max_abs_dev / max_rel_dev** 及其字段路径 | 任一超限 ⇒ FAIL |
| **C. 禁止项** | 偏差**不得随 n 增长**：对全部用例的 (bars, max_abs_dev) 做 log-log 回归，**若最大用例仍有非零偏差且斜率 ≥ 0.5 ⇒ FAIL**（报告斜率与全部点） | 斜率 ≥0.5 且非零 ⇒ FAIL |

**判据落点的两处显式说明**（避免歧义，均为可复核的确定规则）：

1. **浮点 vs 整数分类**：按 JSON 数值的 `is_i64/is_u64` 与 `is_f64` 区分，即「`ts`/索引/计数 = A 层」、
   「金额/价格/评分/指标 = B 层」。理由：`orders/events/trades` 的**结构**（条数、方向、缘由、bar_index、
   时间戳）是口径契约，必须逐位一致；而其**浮点载荷**（qty/price）在 P3 指标增量化下属于 03-test-plan
   B 类漂移项，若一并按 A 层逐位判定会把合法浮点漂移误报为 FAIL。
2. **绝对下限 1e-9**：B 层判定为 `abs_dev ≤ 1e-9 || rel_dev ≤ 1e-9`。理由：净值 ~1e5、回撤 ~1e-2、
   评分 ∈[0,100]；对「期望值近似 0/denormal」的字段（例 `drawdown` 极小值 ~1e-310）纯相对误差会被
   无意义放大（`1e-310 vs 0` 相对误差 = 1.0），绝对下限 1e-9 消除了这类假 FAIL，且远小于本案任何有意义的漂移。
3. `net_value`/`drawdown` 的 **ts 序列**（`[i][0]`）与**条数**属 A 层；其数值（`[i][1]`）属 B 层——
   与 03-test-plan §1.1「A 层含 net_value/drawdown 的 ts 序列」逐字对齐。

## 4. 敏感性反向证据（硬要求：没有这条，比对器本身不可信）

入口：`bash compare.sh --selftest <case_id>`（原始输出见 `sensitivity/*.txt`）。每个 case 记录：

| 探针 | 期望 | `m15_3slots` 实测 | `m15_1slot` 实测 | `m1_1slot_stop` 实测 |
|---|---|---|---|---|
| [0] 控制组（同输入重跑） | PASS | PASS（max_abs_dev=0） | PASS（0） | PASS（0） |
| [1] `slot0.weight ×(1+1e-6)` | 多 slot ⇒ FAIL / 单 slot ⇒ **PASS（数学无操作）** | **FAIL**（A 7 / B 1157） | PASS（预期，见注） | PASS（预期，见注） |
| [close] 中段（持仓中）`close ×1.001` | FAIL | **FAIL** | **FAIL** | **FAIL** |
| [close] 末根 `close ×1.001` | FAIL | **FAIL** | **FAIL** | **FAIL** |
| [close] 中段 `close ×(1+1e-6)` | FAIL | **FAIL**（B 3，max_rel_dev=7.0e-5） | **FAIL**（B 3，2.2e-4） | **FAIL**（B 3，2.2e-3） |

> **注（重要且已实测）**：**单 slot** 时 `aggregate = (w·s)/w ≡ s`，权重被约掉 —— 「权重 +1e-6」在单 slot
> 下是**数学上的无操作输入**，比对器给 PASS 是正确行为（不是敏感性缺陷）。故权重探针的**硬断言**落在
> 3 slots 用例（`m15_3slots`/`m1_3slots` …）。同理可推：`m1_1slot_stop` 等单 slot 用例的扰动硬断言
> 由 close 探针承担（三种幅度/位置均被捕获，含 **1e-6 量级**的浮点微扰 —— 证明 B 层 ≤1e-9 判据**足够紧**）。

**P2b 验收补做的两例（2026-09-18）** —— 结果**必须分开读**：

| 探针 | 期望 | `m30_1slot` 实测 | `m30_3slots` 实测 |
|---|---|---|---|
| [0] 控制组（同输入重跑） | PASS | PASS（0） | PASS（0） |
| [1] `slot0.weight ×(1+1e-6)` | 多 slot ⇒ FAIL / 单 slot ⇒ PASS（无操作） | PASS（预期，单 slot） | **FAIL**（A 8 / B 1860） |
| [close] 中段（持仓中）`close ×1.001` | FAIL | **PASS（未捕获）** ← 见下注 | **FAIL** |
| [close] 末根 `close ×1.001` | FAIL | **PASS（未捕获）** ← 见下注 | **FAIL** |
| [close] 中段 `close ×(1+1e-6)` | FAIL | **PASS（未捕获）** ← 见下注 | **FAIL** |
| [L1] `derived.ledger[last].cash` ≈1 ulp | FAIL | **FAIL**（1/4000 叶节点） | **FAIL**（1/4000） |
| [L2] `+0.0 vs -0.0` / `1.0 vs 1.0` | FAIL / PASS | FAIL / PASS | FAIL / PASS |
| [L3] 自证 `pnl ×(1+1e-6)` | FAIL | **FAIL**（B 1） | **FAIL**（B 1） |
| [L0] 自证控制组 | PASS | PASS | PASS |
| **selftest VERDICT** | — | **FAIL**（探针点无判别力） | **PASS** |

> **注（`m30_1slot` selftest FAIL 的成因，已定位，非比对器缺陷）**：selftest 的 `[close]` 探针点由
> 「首笔 trade 的 `open_bar+1`（该笔 hold>1 时）」决定，否则回退到 `bars.len()/2`；末根探针固定为
> `len-1`。`m30_1slot` 的首笔 trade 是 **1 根持仓**（`open_bar=50, close_bar=51`）⇒ 回退到 500；
> 而该例在 **bar 500 与 bar 999 均为空仓**（持仓区间经 trades 还原：bar 500 ∉ 任一 [open,close]，
> 末笔交易 924..947）⇒ 对空仓 bar 改 close **不改变任何订单/净值/指标输出**（score 变化不足以翻转
> 阈值），故三点均「未捕获」。这不是比对器不敏感，而是**该例的这两个探针点恰为空仓**。
> 该例的敏感性与非空跑由两条独立的、**探针点有效**的反向证据承担（见 §6 第 6–7 条）：
> ① 年化因子 `bars_per_year` 252×8→252×4 ⇒ `metrics` **变红**（退出码 2）；
> ② 把**持仓区间内**的 bar 860 `close ×1.001` 放进临时 case 跑官方比对器 ⇒ **变红**
> （`net_value[860]` rel=1.0e-3、`metrics.sharpe` rel=4.3e-4、`derived.position[860].unrealized_pnl`
> 位级不等；控制组原例仍 PASS）。判读纪律：**该 selftest 的 FAIL 不得被读成「比对器不可信」，
> 也不得被读成「M30 基线有问题」**；`m30_1slot` 的其余 5 条探针（[0]/[1]/L1/L2/L3/L0）全部符合预期。

结论：比对器**能捕获** 1e-6 量级的浮点漂移与结构漂移，且对同输入**不误报** ⇒ 比对器可信（4 例中 3 例
全部探针符合预期；`m30_1slot` 的 3 条 close 探针因**该例探针点为空仓**而未捕获，成因与替代证据见上注）。

## 5. 复跑入口（逐字可执行）

```bash
# 0) 环境：repo 根 = /home/eestock/workspace/git/eestock/eestock-rs
cd /home/eestock/workspace/git/eestock/eestock-rs

# 1) （可选）重新导出输入（会覆盖 bars.jsonl；活库需在跑）
bash tester/evidence/240_adr024_golden_baseline/export_bars.sh m1_1slot kline_merged 510880 1500
# M30 两例（P2b 验收任务 B 补做；数据源 kline_accurate_30m）：
bash tester/evidence/240_adr024_golden_baseline/export_bars.sh m30_1slot kline_accurate_30m 510880 1000
bash tester/evidence/240_adr024_golden_baseline/export_bars.sh m30_3slots kline_accurate_30m 510880 1000

# 2) 重新冻结基线（会覆盖 expected.json；记录 engine_commit/captured_at）
bash tester/evidence/240_adr024_golden_baseline/freeze.sh            # 全量
bash tester/evidence/240_adr024_golden_baseline/freeze.sh m15_1slot  # 单例
bash tester/evidence/240_adr024_golden_baseline/freeze.sh m30_1slot  # 单例（自动带 --baseline-kind post_p2_regression）
# 注意：**不要**在本批之后无差别 `freeze.sh` 全量 —— 那会用当前（post-P2）源码覆盖
# 既有 11 例的 pre-P2 期望值，从而**毁掉跨 P2 等价证据**（§1.1）。

# 3) 比对（P2/P3 的 gate 命令；退出码 0=PASS 2=FAIL）
bash tester/evidence/240_adr024_golden_baseline/compare.sh
bash tester/evidence/240_adr024_golden_baseline/compare.sh m15_3slots   # 单例
bash tester/evidence/240_adr024_golden_baseline/compare.sh m30_1slot     # 单例（13 例之一）
bash tester/evidence/240_adr024_golden_baseline/compare.sh --selftest m15_3slots
bash tester/evidence/240_adr024_golden_baseline/compare.sh --selftest m30_1slot
```

- 比对器实现：`tester/harness/adr024_harness/`（独立 workspace，仅 path 依赖仓内 crate，
  **不改仓库根 `Cargo.toml`**；`CARGO_TARGET_DIR` 指向仓库 `target/` 复用编译缓存）。
- 离线可跑：`--offline`（依赖已在本地 registry 缓存）。

## 6. 已知限制 / 残余风险

1. ~~**M30 用例缺失**（见 §1）：P0 落地后必须补齐。~~ **已补齐（2026-09-18，P2b 验收任务 B）**：
   `m30_1slot` / `m30_3slots` 落盘并纳入比对（13 例）。注意其 `baseline_kind = post_p2_regression`
   —— 只作**回归守卫**，**不得**当跨 P2 等价证据（§1.1）。
2. **持仓台账无独立输出**：`Holding`（引擎内部结构）不落 wire payload，故 03-test-plan §1.1 列出的
   「持仓台账」只能**间接**由 `trades`（open/close ts、bar_index、qty、pnl）+ `per_bar.events[fill]` 观察。
   本基线对这两者均做 A/B 层比对，但**不存在**独立的「每 bar 持仓快照」序列可比 —— 列为覆盖缺口。
3. **NaN/±Inf 不可区分**：JSON 无法表达非有限浮点（serde_json 序列化为 `null`），故 `null==null` 被判等。
   本基线 13 例的 `metrics` 均为有限值（已核）；若某用例出现 `sharpe=Infinity` 等退化值，需另行记录。
4. **只覆盖单标的**：13 例全部为单标的单次运行；多标的/多 run 并发路径（`strategy_run` 落库、双读）
   不在本基线范围（属 P4 契约测试）。
5. **绝对下限 1e-9**（§3 说明 2）是比 03-test-plan 字面更宽的一档（但只对「期望值 ≈0」生效）；
   若架构师要求严格纯相对判据，需在 P2 gate 前书面确认。
6. **M30 两例的「非空跑」反向证据**（P2b 验收硬要求，`249_adr024_p2b_verify/B_04_reverse_m30_annualization.txt`）：
   人为把 `Period::M30` 的年化因子 `bars_per_year` 从 `252×8` 改成 `252×4` ⇒ `m30_1slot` / `m30_3slots`
   的 `compare.sh` **必须变红**（实测：`metrics.annualized_return` rel=5.06e-1 / 4.78e-1、
   `metrics.sharpe` rel=2.93e-1，退出码 2），而同批控制组 `m15_1slot`（非 M30）**仍 PASS** ⇒
   该扰动只命中 M30 档 ⇒ 两例确实在跑 M30 口径（不是空跑/不是 M15 冒充）。
   另一条独立反向证据（`249_adr024_p2b_verify/B_06_reverse_m30_price_probe.txt`）：把 **持仓区间内**
   的 bar 860 `close ×1.001` 放进临时 case（expected 用冻结基线原文）跑官方 `compare.sh` ⇒
   `m30_1slot_probe` **FAIL（退出码 2）**，控制组原例 **PASS**；偏差落点
   `result.net_value[860][1]`（rel=1.0e-3）、`result.metrics.sharpe`（rel=4.3e-4）、
   `derived.position[860].unrealized_pnl`（位级不等）⇒ 该例对真实价格路径扰动敏感（非空跑）。
   `B_04`/`B_06` 同时记录了**逐字节复原**（sha256 相同 + `git diff` 为空）、临时用例目录删除与复原后复绿。
7. **`m30_1slot` 的标准 selftest 探针点为空仓**（§4 注）：其 `[close]` 三点探针未捕获扰动、
   selftest 判 FAIL。成因是该例首笔 trade 仅 1 根持仓（回退探针点 = bar 500）且 bar 500/999 均空仓。
   **不修改 selftest 逻辑**（与其它 3 例口径一致），改由 §6 第 6 条的两条有效探针承担敏感性证明。
8. **harness 的 M30 支持**：`tester/harness/adr024_harness` 的 `CaseFile::period()` 原先**无 M30 分支**
   （P1 冻结时尚无该档）；本次补 `"M30" => Ok(Period::M30)`（tester 资产，非生产代码）。
   未补之前以 M30 用例跑比对会直接报 `未知周期 M30`（即新增两例确实被 harness 读取，而非被静默跳过）。


---

## 3.1 持仓台账派生序列（P1b 新增；`expected.json.derived`）

> 判据来源：`design/16-backtest-scalability/03-test-plan.md` §1.3（P1 发现的基线缺口，P1b 补齐）。
> 实现：`tester/harness/adr024_harness/src/main.rs::derive_ledger`（tester 资产，非生产代码）。
> 目的：把引擎内部 `Holding`/`cash` 记账暴露成**逐 bar 可比序列**，并自证「由成交能回放 trades」。

### 结构

| 字段 | 内容 | 比较层 |
|---|---|---|
| `derived.ledger[i]` | `{ts, qty, avg_cost, cash}`（逐 bar 末快照；`avg_cost = cost_basis/qty`，空仓 = `0.0`） | **A 层位级** |
| `derived.position[i]` | 插件可见 `ctx.position` 镜像 `{qty, avg_cost, entry_ts, bars_since_entry, unrealized_pnl}`；空仓 = `null` | **A 层位级** |
| `derived.trades_replay[]` | 由台账合成的 `TradeDetail`（同 `result.trades` 形状） | **A 层位级** |
| `derived.stats` | `fills/buy_fills/sell_fills/force_close_fills/min_commission_dominated_buys/replayed_trades/final_qty_bits` | 不比较（取证元数据） |

**位级**（`compare_bitwise`）= 数值按 `f64::to_bits()` 逐位相等（±0.0 可区分）、字符串/布尔/null 严格相等。

### 推导规则（确定性；由 payload `per_bar[].events[type=='fill']` + case 配置驱动）

```
cash = initial_capital;  holding = None;  in_position = false
逐 bar i（0..n）: 按 per_bar[i].events 的**出现顺序**处理每个 type=="fill" 的事件:
  Buy : tv = qty × price                       # price = 含滑点 effective_price
        comm = (tv × commission_frac).max(min_commission)   # tv == 0 → 0
        total_cost = tv + comm;  cash -= total_cost
        空仓 → 建仓: qty=qty; cost_basis=total_cost; value_basis=tv; buy_commission=comm;
                     entry_ts = per_bar[i].ts; entry_bar = i; in_position = true
        持仓 → qty += qty; cost_basis += total_cost; value_basis += tv; buy_commission += comm
  Sell: tv = qty × price
        comm = (tv × commission_frac).max(min_commission);  stamp = tv × stamp_frac
        proceeds = tv − comm − stamp;  cash += proceeds
        qty ≥ holding.qty → 合成 TradeDetail 并清仓:
            {open_ts: entry_ts, close_ts: per_bar[i].ts, open_bar: entry_bar, close_bar: i,
             open_price: value_basis/qty, close_price: price, shares: qty, gross_value: tv,
             commission: buy_commission + comm, stamp_duty: stamp, pnl: proceeds − cost_basis,
             hold_bars: i − entry_bar}   → qty/cost_basis/value_basis/buy_commission = 0
        否则 → ratio = qty/holding.qty; cost_basis/value_basis/buy_commission ×= (1−ratio); qty −= qty
每 bar 末: ledger[i] = {ts, qty, avg_cost, cash}; position[i] = 空仓 ? null : {…}
```

与 `crates/strategy-core/src/engine.rs::run_ensemble_with_observer` 的 `Holding`/`apply_sell` 口径**逐字一致**；
`price` 是含滑点成交价，故 `tv = qty × price` 即引擎的 `trade_value`（佣金按 `max(min_commission, tv×frac)` 反解，与 `fee.buy` 两个分支等价）。

### 自证（硬要求：必须能回放 trades）

`tester/harness` 在 `run`（冻结）与 `compare`（比对）两个路径都执行：把 `derived.trades_replay` 与 payload `result.trades`
按主比对器口径（整数 A 层 / 浮点 B 层）比较，并要求 **A-FAIL = 0 且 B-FAIL = 0**。
实测 13/13 例：**位级完全一致（`dev>0` 条目 = 0）**，见 `compare_report.txt` 的 `[台账]` 段与 `freeze.log` 的 `[ledger]` 行。

### 判别力边界（诚实标注）

派生序列**不是独立观测**（价格取自 `events[fill].price`）。真正新增的覆盖是：
- 把「引擎内部记账（成本基/摊薄/佣金）」变成可比序列；
- **自证路径**：若 `fills` 不变而 `trades` 变了 ⇒ replay 与 payload 不一致 ⇒ FAIL。

反向证据（`sensitivity/*_selftest.txt` 的 `[L0]–[L3]`）：自证控制组 PASS；`ledger[last].cash ×(1+1e-15)`（≈1 ulp）位级 FAIL；
合成对 `+0.0 vs −0.0` FAIL 而 `1.0 vs 1.0` PASS；自证 + `pnl ×(1+1e-6)` FAIL。

---

## 3.2 P1b 的 B 层判据与逐字段枚举（取代 P1 的 1e-9 绝对下限）

- **判据（唯一事实源，2026-09 架构裁决）**：`PASS ⇔ |Δ| ≤ max(1e-12, 1e-9 × |expected|)`；
  绝对下限由 P1 实现的 `1e-9` **收紧为 `1e-12`**（理由：`expected==0` 时纯相对判据无定义，必须保留绝对项；1e-12 对本案任何有意义的漂移仍足够紧）。
- **B′ 报告硬要求**：比对器**逐条枚举所有 `dev>0`** 的条目（`field, expected, actual, abs, rel, verdict, old_verdict`），
  **禁止只给全局 max**；`old_verdict` = 按旧判据（`abs≤1e-9 || rel≤1e-9`）的判定，用于回答「收紧是否引入额外 FAIL」。截断上限 200,000 条并显式标注。
- 旧实现（`abs ≤ 1e-9 || rel ≤ 1e-9`）**仅保留为对照**，不再参与判定。
