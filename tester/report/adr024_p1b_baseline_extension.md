# ADR-024 阶段 P1b 取证报告 — 基线补完（持仓台账 + 容差裁定）+ 指标重插件曲线 + 耗时口径分解 + 预估算子标定

> 产出角色：**tester**（只产出证据与测试资产；**未改任何生产代码、未 commit、未调试**）。
> 本文件路径：`tester/report/adr024_p1b_baseline_extension.md`。
> 判据来源：`design/16-backtest-scalability/03-test-plan.md` §1.1/§1.3/§2.2、`01-adr.md` §2.5/D1/§5 第 7 条、`04-implementation-plan.md` §2 P1b。
> engine_commit = `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（工作区 HEAD；本任务期间**未**产生任何生产代码改动）。
> 执行窗口（UTC）：2026-09-17T16:23Z – 16:48Z。**本 run 被架构师提示的进程硬上限截断**：③ 矩阵按 steer 收窄、④ 只跑核心档位、⑤ 只做标定回归；未跑完的部分逐条标注（见 §7）。

---

## 0. 判词速览

| # | 项 | 判词 | 关键数字 | 原始输出 |
|---|---|---|---|---|
| **⑥** | **M30 用例 ×2** | **`BLOCKED: 待 P0`** | `crates/backtest/src/types.rs::Period` 无 `M30` 变体（grep 无命中）；未改生产代码绕过 | §6 |
| ① | 持仓台账派生序列（**P2 前硬依赖**） | **完成**（11/11 例；改造前冻结） | A 层位级 96,648 叶节点全等；自证 replay↔trades **dev>0 = 0**；`result` payload_sha256 逐例未变 | `242_.../compare_p1b_report.txt`、`freeze_p1b.log`、`pre_ledger/` |
| ② | B 层容差 `max(1e-12, 1e-9×|expected|)` + 逐字段枚举（**P2 前硬依赖**） | **完成** | 11 例仍全 PASS；`dev>0` 条目 **0**；**收紧引入的新 FAIL = 0** | 同上 + `242_.../tolprobe.txt` |
| ③ | 指标重插件曲线 ⇒ P3 必要性 | **量级结论成立**（矩阵收窄） | 相对 `dual_ma` 倍率 6.8×(5k)→**15.36×(200k)**；`t/n²`→**5.99e-9**=dual_ma 的 **16.2×** ⇒ 存在**第三个二次项**，系数 ≈15× 复制项 | `242_.../raw_heavy_plugin.txt` |
| ④ | 耗时口径分解（生产路径副本） | **完成核心判别（副本）** | n=3250：引擎 **15 ms** / jsonb 全链 **24 ms** / 进度写库 **3,279 ms**（1001 帧）⇒ full 副本 **979 bars/s**（生产同规模实测 1,131–2,809 bars/s 同量级） | `243_.../raw_replica.txt` |
| ⑤ | 预估算子标定 | **完成（负结果，重要）** | N=374：`dur ~ bars` **R²=0.0007**（≈无相关）；改用「进度帧数」R²=0.277，分档中位吻合 | `243_.../calibration/runs_prod.csv`、`fit.txt` |

**最重要的三条新结论（决策相关）**：

1. **「生产 ~1,600 bars/s」不是引擎吞吐，而是「每次 run 固定 ~1,001 次进度 UPDATE」的产物。** 副本判别性实验：把进度写库这一项单独打开，n=3250 的端到端从 0.015 s 变成 3.32 s（bars/s 213,316 → 979）；其它所有成分（引擎 + per_bar jsonb 值化/文本化/落库）合计只有 39 ms。n=1402 时 full 副本 466 bars/s、进度项 2.99 s —— **bars/s 与 n 近似反比 ⇒ 固定成本**。
2. **生产端到端时长与 bars 几乎不相关**（374 条真 run，R²=0.0007，中位 0.854 s 而 bars 中位 999、跨度 29–3250）。⇒ **D1 的「预估耗时」不能用 `µs/bar` 形式的线性算子在过渡期给用户 100× 乐观估计**；它必须包含「每 run 固定成本」项，或先把进度写库修掉再标定（P4/P5）。
3. **指标二次项比「历史复制」二次项大 ~15×**（`a_heavy=5.99e-9` vs `a_dual_ma=3.70e-10`）⇒ **P2 只消掉 1/16 的二次项**；对使用 `macd/rsi/atr/ema` 的插件（生产库中存在此类已发布版本）**P3 是必需项，不是可选优化**。

---

## 1. ① 持仓台账派生序列（P2 前硬依赖）——完成

### 1.1 交付物与规则

- 派生实现：`tester/harness/adr024_harness/src/main.rs::derive_ledger`（tester 资产，非生产代码）；
  规则全文写入 `tester/evidence/240_adr024_golden_baseline/README.md` §3.1。
- 产出结构（冻结进**已存在**的 11 个用例 `expected.json` 的**新增字段** `derived`）：
  `derived.ledger[i] = {ts, qty, avg_cost, cash}`（逐 bar，**A 层位级**）、
  `derived.position[i] = ctx.position 镜像 {qty, avg_cost, entry_ts, bars_since_entry, unrealized_pnl}`（空仓 = `null`，**A 层位级**）、
  `derived.trades_replay[]`（由台账合成的 TradeDetail，**A 层位级**）、`derived.stats`（fills 计数等）。
- 规则来源：**逐字复刻** `strategy-core::engine::run_ensemble_with_observer` 的 `Holding`/`cash` 口径
  （Buy：`tv=qty×price`、`comm=max(min_commission, tv×frac)`、`cash-=tv+comm`、`cost_basis+=tv+comm`、`value_basis+=tv`；
  Sell：`proceeds=tv−comm−stamp`、`cash+=proceeds`；全平 → 合成 TradeDetail 并清仓；部分平 → 按 `ratio=qty/holding.qty` 摊薄）。

### 1.2 自证（能否回放 trades）——**位级完全一致**

11/11 例：`fills` 逐笔回放出的 trades 与 payload `result.trades` **逐字段位级相等**（`dev>0` 条目 **0**）。

```
[ledger] d1_1slot       fills=28  replayed_trades=14  payload_trades=14  final_qty_bits=0 self_proof=PASS (A-FAIL 0 / B-FAIL 0 / dev>0 0)
[ledger] m1_1slot_stop  fills=174 replayed_trades=87  payload_trades=87  final_qty_bits=0 self_proof=PASS (A-FAIL 0 / B-FAIL 0 / dev>0 0)
[ledger] m5_3slots      fills=198 replayed_trades=99  payload_trades=99  final_qty_bits=0 self_proof=PASS (A-FAIL 0 / B-FAIL 0 / dev>0 0)
[ledger] m15_3slots     fills=169 replayed_trades=84  payload_trades=84  final_qty_bits=0 self_proof=PASS (A-FAIL 0 / B-FAIL 0 / dev>0 0)
```
（全 11 例见 `242_.../freeze_p1b.log`；`final_qty_bits=0` ⇒ 期末台账已清仓，与「期末强制平仓」口径一致。）

### 1.3 未扰动既有基线（可复核）

`result` payload 的 sha256 **逐例与 P1 冻结值完全相同**（下表 `payload_unchanged=True`），
即本次只在 `expected.json` **新增** `derived`/`derived_sha256`/`derived_notes`，**未触碰**任何既有期望值：

```
d1_1slot 014d6b24...ee95 payload_unchanged=True derived=True ledger_len=500
m1_1slot bd8e6820...4297 payload_unchanged=True derived=True ledger_len=1500
m1_1slot_stop 8d9f334e...5084 payload_unchanged=True derived=True ledger_len=3000
m5_3slots 7083b9b2...c7b9 payload_unchanged=True derived=True ledger_len=1200   （全 11 例见 pre_ledger/payload_sha256_after.txt）
```

### 1.4 比对器新增的**位级**语义 + 反向证据（防止「比对器自己不可信」）

- A 层位级比较 `compare_bitwise`：数值一律按 `f64::to_bits()` 相等（±0.0 可区分），字符串/布尔/null 严格相等。
- 新增 selftest 探针（3 例各跑，全 PASS，原始输出 `240_.../sensitivity/*_selftest.txt`）：
  - `[L0]` 自证控制组（同源未扰动）→ PASS（不误报）；
  - `[L1]` `expected.derived.ledger[last].cash ×(1+1e-15)`（≈**1 ulp**）→ **bitwise FAIL（1/4000 叶节点不等，rel=1.1e-15）**；
  - `[L2]` 合成对 `+0.0 vs -0.0` → FAIL，`1.0 vs 1.0` → PASS（位级语义生效）；
  - `[L3]` 自证 + `pnl ×(1+1e-6)` → FAIL（B 层捕获）。

### 1.5 判别力的诚实标注（重要）

`events[fill].price` 是**含滑点的成交价**（引擎的 `effective_price`），故 `tv=qty×price` 与引擎内部 `trade_value` 同源反解。
因此本派生序列**不是独立观测**，它的判别力在于两点，必须按此理解：
1. 它是 **payload→台账** 的确定性还原，能把「引擎内部记账（成本基/摊薄/佣金）」暴露成可比序列；
2. 关键能力在**自证**：若 P2/P3 之后 `fills` 未变而 `trades`（pnl/open_price/commission）变了，
   则「由 fills 重建的 trades」与 payload `trades` 会不一致 ⇒ **A/B 层 FAIL**。这条路径是**真正新增**的覆盖。

---

## 2. ② B 层容差裁定落地 + 逐字段枚举（P2 前硬依赖）——完成

### 2.1 判据实现（唯一事实源）

```rust
// tester/harness/adr024_harness/src/main.rs
const ABS_FLOOR: f64 = 1e-12;   // 架构裁决：P1 的 1e-9 绝对下限收紧为 1e-12
const REL_TOL:   f64 = 1e-9;
fn tol_threshold(expected: f64) -> f64 { ABS_FLOOR.max(REL_TOL * expected.abs()) }   // = max(1e-12, 1e-9×|expected|)
fn tol_pass(e: f64, a: f64) -> bool { dev_pair(e,a).0 <= tol_threshold(e) }          // 字面实现，无旁路
```
边界探针原始输出（`242_.../tolprobe.txt`，`adr024_harness tolprobe`）摘录：

```
expected=0：abs 1e-13 < 1e-12 下限 → PASS           | 新 PASS  旧 PASS
expected=0：abs 恰为下限 1e-12 → PASS（≤）          | 新 PASS  旧 PASS
expected=0：abs 刚过下限 → FAIL                     | 新 FAIL  旧 PASS  ⇒ 收紧生效
expected=0：abs 1e-9 → FAIL                         | 新 FAIL  旧 PASS  ⇒ 收紧生效
denormal 期望值 1e-310 vs 0 → PASS（绝对下限消除假 FAIL）
```

### 2.2 逐字段枚举（B′）：禁止只给全局 max

比对器现在输出 `dev>0` 的**每一条**：`field, expected, actual, abs, rel, verdict, old_verdict`
（`old_verdict` = 按旧判据 1e-9 的判定 ⇒ 谁是被收紧新判掉的）。当前 11 例全部为 0 条：

```
# [B′] 逐字段枚举：所有 dev>0 条目（field, expected, actual, abs, rel）（合计 0 条）
[B′-dev] d1_1slot: 无 dev>0 条目（逐位相等）     …（11 例全同）
# 容差收紧对照（1e-9 → 1e-12 绝对下限）：按新判据 FAIL 而按旧判据 PASS 的条目数 = 0
```

### 2.3 重跑 11 例结论（`242_.../compare_p1b_report.txt`，退出码 0）

```
A/B 层：11 用例，失败 0 用例
全局 max_abs_dev = 0.000000e0   全局 max_rel_dev = 0.000000e0
持仓台账：bitwise FAIL 0 用例 / 自证 FAIL 0 用例 / 自证 dev>0 条目 0
== VERDICT: PASS ==
```
⇒ **收紧到 1e-12 后无额外 FAIL**（dev 全 0，故结论对收紧不敏感；收紧的意义在 P2/P3 引入浮点漂移时生效）。

---

## 3. ③ 指标重插件曲线（P3 必要性的决策依据）

**矩阵按架构师 steer 收窄**：5k / 20k / 50k / 200k × **1 slot** × 3 重复（200k 第 3 次重复被主动终止让路 ④⑤）；
**3 slots 与全矩阵主动放弃**。fixture：`242_.../fixtures/indicator_heavy.js`（sha256 `42340576f460…fdcc`，
每 bar `macd()`+`rsi(14)`+`atr(14)` 各一次；host 侧每个指标从 bar 0 重算 ⇒ 各引入一个二次项）。

| n | heavy 中位 (3 次重复) | `dual_ma`（P1 同机同 commit） | **倍率** | heavy `t/n²` |
|---|---|---|---|---|
| 5,000 | 0.164 s（0.163/0.166/0.164） | 0.0240 s | **6.8×** | 6.56e-9 |
| 20,000 | 2.425 s（2.424/2.425/2.433） | 0.2070 s | **11.7×** | 6.06e-9 |
| 50,000 | 14.993 s（14.985/14.993/15.010） | 1.1270 s | **13.3×** | 6.00e-9 |
| 200,000 | 239.52 s（239.680/239.363 —— 第 3 次被终止） | 15.5840 s | **15.36×** | **5.99e-9** |

### 3.1 必答问题：指标二次项系数相对「每 bar 上下文构造 + 历史复制」项占多大？

- `t/n²` 随 n **单调收敛到 5.99e-9 s/bar²**；`dual_ma` 的 P1 实测 `a_copy = 3.7045e-10 s/bar²`（该系数已被 P1 三重指纹锚定为「每 slot 每 bar 复制整段历史 48 B/bar」，分配量与预测式吻合 1.0001）。
- ⇒ **`a_indicator / a_copy = (5.99e-9 − 0.37e-9) / 0.37e-9 ≈ 15.2`**，即
  **指标重插件的二次项系数是「上下文构造 + 历史复制」项的 ~15 倍**（合计为 16.2×）。
- 逐点占比（用两系数拆解）：n=50k 时「指标重算」占二次项的 94%，n=200k 时占 94%；「复制」只剩 6%。
- **局部斜率 ≈1.96–2.00（未 >2.2）**：按 steer 给的简化判据，斜率不是本项的判别器 ——
  因为被比较的 `dual_ma` 本身已是二次（复制项），再叠加一个二次项**不改变渐近斜率**，
  只有 `t/n²` 的**收敛值/倍率**能分辨（这正是 P1 裁决里「三指纹比斜率强」的又一实例）。

### 3.2 P3 建议（我出建议，架构师决定）

| 结论 | 依据 |
|---|---|
| **P3 该做，且不能降优先级到「P2 之后再议」** | P2 只移除复制项（a=0.37e-9），对指标重插件在 200k 点只把 239.5 s 降到 ~225.6 s（-5.8%）；**留下的二次项是 a_ind≈5.6e-9**，比被移除的项大 15× |
| **对「轻插件」（`ma` 系，O(period)）P3 无所谓** | 生产占比最大的 `dual_ma`/模板系只调 `ma`（O(period)）⇒ P2 后近似线性；生产库 24 个已发布版本里 12 个用 `ctx.indicators`，其中 **4 个用重指标**（`macd`/`rsi`/`atr`：MACD 金叉、均线+RSI 过滤、ATR 通道突破、定投·定期不定额） |
| **量级** | 200k bar（≈ M1×3.5 年）单 slot：heavy 239.5 s ⇒ **P2 alone ≈226 s（仍不可用）**；P3 到位后应落到 O(n) 量级（判据：`t/n²` 单调下降 ⇒ 不再是常数） |

---

## 4. ④ 耗时口径分解（判别性实验，**副本归因**）

### 4.1 副本构造（**必须标注为副本**）

`tester/harness/adr024_replica/`（tester 资产）：**逐字复刻** `application::workbench::execute_run` 的执行结构 ——
`tokio` 多线程运行时 → `spawn_blocking` 跑 `run_ensemble_with_quickjs_observed` →
observer 内 `progress=(i+1)/total` + `PROGRESS_THROTTLE_MILLI=1000` 节流 → 无界 `mpsc` →
异步报告任务跑**同一 SQL** `UPDATE strategy_run SET progress=$2 WHERE id=$1 AND status='running'` →
结束后按 `mark_succeeded` 同 SQL/同事务写 `strategy_run_result`（per_bar jsonb）。
- 数据只写**测试库** `eestock_test`（run_id 前缀 `sr_adr024p1b_`），**绝不写生产库**（代码内有 `eestock_test` 断言，非测试库直接拒绝运行）。
- 与真路径的**已知差异**（诚实标注）：① WS sink 未复制（成本取决于在线客户端数）；② 真路径外层还有 web/axum 与配置装载；③ 真路径由生产库 `eestock` 承载。⇒ 结论定性为「**副本归因**」，真路径确认留 P4 分段 span。

### 4.2 逐项开关结果（n=3250 ≈ 现网 M5 run 规模；`dual_ma`；1 slot）

| 档位 | 端到端 | bars/s | 引擎 | 进度帧 | 进度写库合计 | jsonb 值化 | jsonb 文本 | jsonb 落库 |
|---|---|---|---|---|---|---|---|---|
| `engine`（引擎 only） | **0.015 s** | 213,316 | 15 ms | — | — | — | — | — |
| `observer`（+节流发帧，无 DB） | 0.017 s | 194,472 | 17 ms | 1001 | — | — | — | — |
| `jsonb_value` | 0.025 s | 131,820 | 16 ms | — | — | 7.2 ms | — | — |
| `jsonb_text` | 0.023 s | 138,479 | 16 ms | — | — | 6.0 ms | 0.7 ms | — |
| `jsonb_db`（+结果落库） | 0.040 s | 81,337 | 15 ms | — | — | 5.9 ms | 0.7 ms | 17.0 ms |
| `progress_db`（**只加进度写库**） | **3.320 s** | **979** | 15 ms | 1001 | **3,293.6 ms**（avg 3.29 ms/帧，min 1.73，max 29.7） | — | — | — |
| `full`（= 生产路径副本） | **3.320 s** | **979** | 15 ms | 1001 | 3,293.6 ms | 6.3 ms | 0.7 ms | 17.1 ms |
| n=1402 `engine`（M15 规模） | 0.006 s | 235,030 | 6 ms | — | — | — | — | — |
| n=1402 `full` | **3.009 s** | **466** | 6 ms | 1001 | 2,995.9 ms | 2.6 ms | 0.3 ms | 8.9 ms |
| n=3250 heavy `engine` | 0.074 s | 43,908 | 74 ms | — | — | — | — | — |
| n=3250 heavy `full` | 3.119 s | 1,042 | 75 ms | 1001 | 3,092.9 ms | 5.7 ms | 0.6 ms | 17.8 ms |
| n=20000 heavy `engine` | 2.433 s | 8,221 | 2433 ms | — | — | — | — | — |
| n=20000 heavy `full` | 3.136 s | 6,377 | 2436 ms | 1001 | 2,985.5 ms | 40.1 ms | 3.7 ms | 93.2 ms |

### 4.3 量化归因（★ 必答）

- n=3250、`dual_ma`：**进度写库 3,294 ms 占总 3,320 ms 的 99.2%**；引擎 15 ms（0.45%）；
  jsonb 全链（值化+文本+落库）24 ms（0.72%）。
- **换个插件的结论不变**：n=3250 heavy 时引擎从 15→74 ms（5×），总时长几乎不变（3.32→3.12 s）⇒ 瓶颈与插件重量无关。
- **`bars/s` 是 n 的反比函数而不是吞吐**：n=1402 → 466 bars/s，n=3250 → 979 bars/s，n=20000 → 6,377 bars/s；
  分母里那个**与 n 无关的 ~3 s 固定项**才是主项。
- **生产端对照（同一批数据，§5）**：生产同规模 run（M15 936–1402 bar / M5 1150–3250 bar）实测 0.83–0.86 s ⇒ 生产每帧成本 ≈ **0.83–0.86 ms**，
  而本副本测得 **3.29 ms/帧**（min 1.73）。⇒ **副本在绝对量级上高估了进度写库成本 ~4×**（原因未定，见 §7 残余风险），
  但**结构/次序结论稳健**：把副本的进度项按生产量级折算（3.29→0.85 ms/帧 ⇒ ~0.85 s）即可**逐位复现生产实测时长**，
  而**非进度项（引擎 15 ms + jsonb 24 ms = 39 ms）只占生产总时长的 4.7%**，且与插件重量、n 都不敏感 ⇒
  **「~1,600 bars/s」不能被归因于引擎、jsonb 落库或插件计算**。
- **结论（无论成立与否都报告）**：**副本归因成立且方向明确 —— 生产端到端吞吐的主因是「每次 run 固定 ~1,001 次进度 UPDATE」（`PROGRESS_THROTTLE_MILLI=1000` 的 0.1% 粒度 ⇒ 帧数 ≈ min(1001, n)，与 n 无关）**。
  这与 `01-adr.md` §5 第 7 条列出的**假设**一致，且此处给出了**量化佐证 + 帧数不变式证据**。
  **纪律遵守**：本项未修改进度节流/落库策略（属假设已取证，动代码仍应停留在 P4/P5，并先在真路径上用分段 span 复核）。
  副本未能解释的残余：每帧绝对成本 4×（见 §7-R2）。

---

## 5. ⑤ 预估算子标定（D1 过渡期用；P2 后必须重标定）

- 样本：**N=374** 条 `strategy_run`（`status='succeeded'` 且 `started_at/finished_at` 非空），bars=`jsonb_array_length(per_bar)`
  （跨度 29–3250，中位 999），slots ∈ {1,2,4}，周期 ∈ {D1,H1,M15,M5}，dur = `finished_at−started_at`（中位 0.854 s，max 2.151 s）。
  原始 CSV：`243_.../calibration/runs_prod.csv`；拟合输出：`243_.../calibration/fit.txt`（只读查询，未写任何表）。

| 模型 | 结果 |
|---|---|
| `dur = c0 + c1×bars` | c0=**1.0205 s**，c1=**16.58 µs/bar**，**R²=0.0007**，rmse=0.449 s |
| `dur = c0 + c1×(bars×slots)` | c0=0.954 s，c1=58.57 µs/(bar·slot)，R²=0.0209 |
| `dur = c0 + c1×min(1001,bars)`（判别性） | c1=**1.226 ms/帧**，R²=**0.2773**（对照 0.0007） |
| 分周期（`bars` 线性） | D1 R²=0.62（bars 29–1249）/ H1 R²=0.76 / M15 R²=0.07 / M5 R²=0.03 |

**分档中位核对（决定性的现场证据）**：

| 档 | N | bars 中位 | 预测 1.226 ms×min(1001,bars) | 实测 dur 中位 |
|---|---|---|---|---|
| bars≤120 | 6 | 74 | 90 ms | **74.5 ms** |
| 500<bars≤800 | 24 | 598 | 733 ms | **549 ms** |
| 900<bars≤1001 | 157 | 999 | 1225 ms | **855 ms** |
| bars>1001 | 174 | 1330 | 1227 ms | **866 ms** |

- **必答结论**：**`µs/bar` 形式的端到端算子在过渡期不可用**（R²≈0.0007；生产时长与 bars 近乎无关）。
  可用的形式必须含「**每 run 固定项**」：`dur ≈ 0.85 s（≈ 帧数 × 0.9 ms）+ 引擎/落库项`，
  其中帧数 = `min(1001, bars)`（0.1% 节流）。**这与 ④ 的副本结论方向一致**（两条独立证据互相印证）。
- **异常点说明**：① `bars=1209` 的 D1 簇 dur≈2.0–2.15 s（残差 +1.0 s）—— 该簇是同一批 4-slot/1-slot 重跑，且 bars 最大；
  ② `bars=29–43` 的小 run dur=0.026–0.045 s（残差 −1.0 s）—— 帧数仅 ~29–43，**正是「帧数模型」的强力佐证**（线性模型在此完全失效）；
  ③ 全样本 `|残差|>3σ` 点数 **0/374**（分布重尾但无离群到不可解释者）；④ 样本跨两个执行批次与 4 种插件，未按插件分层 ⇒ R² 偏低有已知混淆因素（见 §7-R3）。
- **标注**：本算子**只适用于过渡期（P2 前）**；P2/P3 改变引擎与进度/落库路径后 **必须重标定**（新算子应在 P4 分段 span 实测后重做）。

---

## 6. ⑥ M30 用例 ×2 —— `BLOCKED: 待 P0`（未绕过）

检查（原始输出见 §9 复跑入口第 6 条）：
```
grep -n "M30" crates/backtest/src/types.rs        → 无命中（Period = {M1,M5,M15,H1,D1}）
grep -rn  "M30" crates/backtest/                  → 无命中
grep -rn  "M30" crates/application/src/bar_map.rs → bar_map.rs:43: domain::types::Period::M30 => 1_800,   （仅 warmup_lookback）
```
⇒ `m30_1slot` / `m30_3slots` **未创建**，基线仍为 **11/13**。**未改任何生产代码绕过**（`Period` 的变体属 P0 范围）。

---

## 7. 未完成 / 残余风险 / 与既有文档的不一致

### 7.1 未完成（本轮被硬上限截断；逐条标注）

| 项 | 状态 | 说明 |
|---|---|---|
| ③ 3 slots 与 200k×3 slots 点 | **未跑** | 按架构师 steer 主动放弃；`run_heavy.sh` 对应段落保留（可直接续跑） |
| ③ 200k 第 3 次重复 | **被主动终止** | 已有 2 次重复（239.680 / 239.363 s，离散度 0.13%），结论不受影响；`raw_heavy_plugin.txt` 末尾无对应 `[EXIT]`（已在此标注，文件未被修改） |
| ④ 副本：3 slots 档、290k 档、WS sink 档、真路径分段 span | **未跑** | 核心判别（逐项开关 × 2 规模 × 2 插件重量）已完成；剩项留续跑 |
| ⑤ 按插件分层 / 按执行批次分层的回归 | **未做** | 全样本单一回归已给出「负结果」；分层可提高 R²（见 R3） |
| ⑥ M30 ×2 | **BLOCKED** | 待 P0（见 §6） |

### 7.2 与既有文档的不一致处（如实报告）

1. **`01-adr.md` §2.3 / D1 的「引擎吞吐 1,620–1,680 bars/s」**：本报告证明该量**不是引擎吞吐**，
   而是「固定 ~1,001 次进度写库 / run」的副产物；用它做容量判断或护栏定值会系统性误判（§4/§5）。
   **建议**（架构师决定）：把 §2.3 该行的「口径 = 生产端到端」补注为「**含每 run ~1,001 次进度写库的固定成本；bars/s 与 n 近反比，非吞吐**」。
2. **`01-adr.md` §5 第 7 条的假设**：本轮给出量化佐证（副本 + 现场回归双证据）⇒ 该条可从「假设，未取证不得动手」升级为「**已取证（副本归因）**，真路径留 P4 span 复核」。
3. **`03-test-plan.md` §1.1 的 B 层字面**已按 2026-09 裁决更新为 `max(1e-12, 1e-9×|expected|)`；本比对器实现与该裁决**逐字一致**（旧的 1e-9 绝对下限已废弃，仅保留为对照报告字段）。P1 报告 §1.4 第 4 条标注的「比字面宽一档」**已闭环**。
4. **P1 报告 §1.4 第 2 条「持仓台账无独立输出」**：本轮**已闭环**（新增 `derived` 三条位级序列 + 自证）。
5. **`04-implementation-plan.md` P1b 第 1/2 条**：已完成；第 3 条**部分完成**（1 slot 全覆盖，3 slots 未跑）；第 4 条**部分完成**（副本核心档位完成，真路径 span 留 P4）；第 5 条完成（负结果）；第 6 条 BLOCKED。

### 7.3 残余风险

| ID | 风险 | 证据/影响 | 建议 |
|---|---|---|---|
| R1 | **比对的判别力边界**：持仓台账由 fills 反解 ⇒ 若 P2 同时改变 fills 与内部记账**且自洽**，本序列捕捉不到 | §1.5 已显式标注 | P2 gate 仍须以 `trades`/`events`/`signal` 的 A 层位级为**主**判据；台账为**一致性**判据 |
| R2 | **副本与真路径的绝对量级差**：副本 3.29 ms/帧 vs 生产隐含 0.83–0.86 ms/帧（4×）未解释 | 可能是连接池/commit 参数/库不同（`eestock_test` vs `eestock`）/批次差异 | P4 在真路径加分段 span 复核；在解释清 4× 前，**不得**据副本数值直接定护栏或做「进度节流」优化 |
| R3 | ⑤ 的 R² 偏低（0.277）：样本跨插件/批次未分层 | 分档中位吻合但散度大（rmse 382 ms） | 续跑：按插件/批次/时段分层，或只用同一批 run（如 2026-09-13 的 M15 簇）标定 |
| R4 | ③ 只测 1 slot 与「macd+rsi+atr」组合 | 单指标组合（如只 macd）的实际系数可能不同 | 若 P3 排期需精确系数，补 1 组（可按需） |
| R5 | `expected.json` 的体积增长（+`derived`） | **实测**：11 例 `expected.json` 合计 9.98 MB，其中 `derived` 约 2.22 MB（**+22.2%**），目录合计 11 MB；比对器 11 例仍 ~0.2 s | 体积影响可忽略（远小于 P1 预估的「+60 MB」担忧）；若未来用例数大增可再评估 |
| R6 | harness 标签瑕疵：`scale` 的 POINT 行 `plugin=` 对 `--plugin-file` 仍打印默认 `dual_ma` | 仅标签，插件文件路径/sha256 已记录在 `raw_heavy_plugin.txt` 头部 | 是否修 harness 由架构师定（本轮**未**改，以免与 raw 文件里的 binary_sha256 失配） |

---

## 8. 交付物清单（本任务全部新增/修改文件——**均为 tester 资产，无生产代码**）

```
tester/harness/adr024_harness/src/main.rs         （改：+派生台账、+位级比较、+新容差、+B′ 枚举、+tolprobe、+台账 selftest 探针）
tester/harness/adr024_replica/{Cargo.toml,src/main.rs}  （新：④ 生产路径副本 harness；独立 workspace）
tester/evidence/240_adr024_golden_baseline/
    README.md                （改：补 §3.1 台账推导规则全文 + §3 新容差/B′ + §4 台账探针 + 复跑入口）
    <11 cases>/expected.json （改：**新增** derived/derived_sha256/derived_notes；result 未动）
    compare_report.txt       （改：本次重跑输出）
    sensitivity/*_selftest.txt（改：含 L0–L3 台账探针）
tester/evidence/242_adr024_baseline_extension/
    STATUS.md  compare_p1b_report.txt  freeze_p1b.log  tolprobe.txt  run_heavy.sh  raw_heavy_plugin.txt
    fixtures/indicator_heavy.js   pre_ledger/payload_sha256_{before,after}.txt
tester/evidence/243_adr024_attribution/
    run_replica.sh  raw_replica.txt
    calibration/{export_runs.sh, runs_prod.csv, runs_prod.sql.txt, fit.txt}
tester/test/296_adr024_p1b_execution.md            （执行记录）
tester/report/adr024_p1b_baseline_extension.md     （本文件）
```

## 9. 复跑入口（逐字可执行）

```bash
cd /home/eestock/workspace/git/eestock/eestock-rs

# 0) 构建 tester harness（两个独立 workspace，均只 path 依赖仓内 crate，不改仓库根 Cargo.toml）
CARGO_TARGET_DIR=$PWD/target cargo build --offline --release --manifest-path tester/harness/adr024_harness/Cargo.toml
CARGO_TARGET_DIR=$PWD/target cargo build --offline --release --manifest-path tester/harness/adr024_replica/Cargo.toml

# 1) ① 台账派生序列：重新冻结（11 例 → expected.json 的 derived；会打印 [ledger] 自证行）
bash tester/evidence/240_adr024_golden_baseline/freeze.sh 2>&1 | tee tester/evidence/242_adr024_baseline_extension/freeze_p1b.log

# 2) ①② 比对（A/B/C + B′ 逐字段枚举 + 台账位级 + 自证；退出码 0=PASS 2=FAIL）
bash tester/evidence/240_adr024_golden_baseline/compare.sh 2>&1 | tee tester/evidence/242_adr024_baseline_extension/compare_p1b_report.txt

# 3) ② 容差边界探针
./target/release/adr024_harness tolprobe | tee tester/evidence/242_adr024_baseline_extension/tolprobe.txt

# 4) ① 台账/自证反向证据（L0–L3；写 sensitivity/<case>_selftest.txt）
for c in m15_3slots m15_1slot m1_1slot_stop; do bash tester/evidence/240_adr024_golden_baseline/compare.sh --selftest $c; done

# 5) ③ 指标重插件曲线（写 raw_heavy_plugin.txt；3 slots 段为续跑补项）
bash tester/evidence/242_adr024_baseline_extension/run_heavy.sh > tester/evidence/242_adr024_baseline_extension/raw_heavy_plugin.txt 2>&1

# 6) ⑥ 前置检查（M30 是否已由 P0 落地）：有输出即 P0 已落地，可补 m30_{1,3}slots 用例并重跑比对器
grep -n "M30" crates/backtest/src/types.rs

# 7) ④ 生产路径副本（**只写测试库**；run_id 前缀 sr_adr024p1b_）
EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/eestock_test' \
  bash tester/evidence/243_adr024_attribution/run_replica.sh > tester/evidence/243_adr024_attribution/raw_replica.txt 2>&1
# 清理副本写入的测试库行（级联删 result）：
#   docker exec eestock-timescaledb psql -U eestock -d eestock_test -c "DELETE FROM strategy_run WHERE id LIKE 'sr_adr024p1b_%';"

# 8) ⑤ 标定样本导出（只读）+ 回归（脚本内联在报告中；或用 fit.txt 的口径复算）
bash tester/evidence/243_adr024_attribution/calibration/export_runs.sh
```

**P2/P3 之后的 gate 命令不变**：第 2 条（比对器）即 P2/P3 的等价性 gate；判据为
① A 层位级（含 `derived`）全等 + 台账自证全等；② B 层 `|Δ| ≤ max(1e-12, 1e-9×|expected|)` 且 **B′ 逐字段枚举**给出全部 `dev>0`；③ C 层偏差不随 n 增长。
