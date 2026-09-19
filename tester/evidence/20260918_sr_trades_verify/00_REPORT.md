# 独立核验：sr_1789738328788_000005「交易明细只有 1 条」
# 核验人：Tester Agent（独立于 coder worker 的 20260918_sr_trades_forensics）
# 时间：2026-09-18 13:39–13:48 UTC
# 方式：只读（SELECT / curl / 浏览器导航）；无 UPDATE/INSERT/DELETE/DDL；无 git add/commit；未改实现代码
# 本文件位置：tester/evidence/20260918_sr_trades_verify/00_REPORT.md

## 0. 一句话判定
**PASS（上游根因结论成立）**：`trades`=1 是**数据事实**，源自引擎契约「`TradeDetail` 仅在完全平仓
（`qty >= holding.qty`）时合成一笔完整回合」，不是数据丢失、不是读侧截断、不是写库失败。
用户困惑成立的部分是 **UI 表达（展示缺陷）**：默认 Tab「交易明细」绑定 `result.trades`（回合口径），
未在同一表格处给出「逐笔成交 43 笔」的口径标注/入口 —— 同页 K 线脚注其实已显示
「成交 43 笔（精确源 /fills）」，两处口径并存但缺少互链。

---

## 1. 核验项 → 证据映射（上游 vs 我的独立原始输出）

| # | 核验项 | 上游值 | 我的独立实测值 | 证据文件 | 判定 |
|---|--------|--------|----------------|----------|------|
| 1 | run 存在 + 元信息 | symbol=518880 period=D1 status=succeeded policy=Dca(100) | 同（逐字段一致，含 config fee/clamp） | `01_verify_sql_shape.txt` | PASS 一致 |
| 2 | result_format | chunked_v1 | chunked_v1 | `02_verify_result_shape.txt` | PASS 一致 |
| 3 | strategy_run_result.trades 长度 | 1 | 1（pg_column_size=364） | `01_verify_sql_shape.txt` Q4 / `05_db_trades_raw.json` | PASS 一致 |
| 4 | per_bar/net_value/drawdown 占位 | 0/0/0（真数据在 chunked 表） | 0/0/0 | `02_verify_result_shape.txt` | PASS 一致 |
| 5 | 各 kind 行数与元素数 | fills=1块/43；per_bar=1块/423；net_value=173；drawdown=173 | 完全一致 | `01_verify_sql_shape.txt` Q3 | PASS 一致 |
| 6 | fills 组成 | 42 Buy + 1 Sell(ForceClose) | 42 Buy + 1 Sell(ForceClose, bar 422, qty=ΣBuy) | `03_fills_payload_raw.json` / `06_recompute_output.txt` | PASS 一致 |
| 7 | 实现清仓条件 | engine.rs:846 `if qty >= h.qty` | 原文核实一致（846-871，见 §2） | `28_engine_excerpt.txt` | PASS 一致 |
| 8 | 按规则独立重算笔数 | 1 | 1（且字段逐项 match） | `06_recompute_output.txt` | PASS 一致 |
| 9 | 全库 377 run 交叉重算 | 上游未做（仅本 run） | 377/377 完全一致 | `17_crossrun_recompute_output.txt` / `14_crossrun_recompute.json` | PASS（新增更强证据） |
| 10 | /result 实测 trades | 1 | 1（HTTP 200） | `09_resp_result.json` / `12_curl_log.txt` | PASS 一致 |
| 11 | /fills 实测 | total=43 recorded=true | total=43 recorded=true has_more=false | `10_resp_fills.json` | PASS 一致 |
| 12 | 「交易明细」绑定字段 | ResultView.tsx TradesTable ← result.trades | 一致；E2E 实测该 Tab 渲染 1 行 | `07_label_grep_交易明细.txt` / `22_e2e_probe_output.txt` | PASS 一致 |
| 13 | MAX_TRADES 截断 | 仅在 strategy.rs test_run，本路径不适用 | 核实：全仓 MAX_TRADES 只 3 处，均在 strategy.rs；workbench 路径无截断 | `29_max_trades_audit.txt` | PASS 一致 |
| 14 | fills 块「未写」vs「无成交」 | 本 run recorded=true | 实测 recorded=true；且 18 个 0-trade run 的 fills 亦为 0（非块缺失） | `10_resp_fills.json` / `17_crossrun_recompute_output.txt` | PASS 一致 |
| 15 | 上游是否越界（改仓库/库） | 自称只读 | git：除预先存在的 ADR-023（mtime 09-17）外无改动；无新 run；无 tp6f/tp4w 残留；commands.sh 全为 SELECT/curl | `30_upstream_overreach_audit.txt` | PASS 未见越界 |

---

## 2. 关键实现原文（file:line，逐字）

`crates/strategy-core/src/engine.rs:835-872`：
```
835: /// 卖出台账处理：部分卖出按比例摊薄成本；清仓合成完整 [`TradeDetail`] 并重置 Trailing。
836: fn apply_sell(
...
845:     let Some(h) = holding.as_mut() else { return };
846:     if qty >= h.qty {
847:         // 清仓 → 合成一笔完整交易（open_price = 加权有效买价，成本含买入佣金）。
848:         trades.push(TradeDetail {
...
862:         *holding = None;
863:         trailing.reset();
864:     } else {
865:         // 部分卖出（LumpSum 目标下调）：成本/佣金按比例摊薄。
...
870:         h.qty -= qty;
871:     }
872: }
```
- 期末强平：`engine.rs:471 finish()` → `apply_sell(..., h.qty, bar.ts, n-1, OrderReason::ForceClose)`。
- 买入并入同一 holding（不产出 trade）：`engine.rs:537-580`（`Some(h) => h.qty += …`）。
- `pub trades: Vec<TradeDetail>`：`engine.rs:246`。

## 3. 独立重算（本 run）
以 `kind='fills'` 原始 43 笔为输入，按上面规则（Buy 累加 holding；Sell 且 `qty>=holding` 才计数并清仓）
纯 Python 重算（`04_recompute_trades.py`，不 import 仓库代码）：
```
fills=43 buy=42 sell=1 ; full_close_sells=1 partial_sells=0
RECOMPUTED trade count = 1 ; DB trades length = 1 ; COUNT MATCH = True
open_ts/close_ts/open_bar/close_bar/shares/hold_bars 全部 match=True
```
→ 「1 条」是 42 笔加仓被合并进 1 个持仓、期末一次性强平后合成的**唯一完整回合**。

## 4. 反证 / 突变实验（硬要求）

### 4.1 正向对照（会变红的可执行判据）：规则突变
脚本 `23_mutation_recompute.py`（只读），对全库 377 个 run 用三种规则重算并与库内 trades 长度比对：
```
Rule A close-only（引擎口径）: 377/377 GREEN   fail sample = []
Rule B each-Buy（每笔买入=一条）: 226/377 RED   fail sample 非空（如 30 vs db 27）
Rule C each-fill（每笔成交=一条）: 18/377 RED   fail sample 非空（如 212 vs db 106）
target run: fills=43 db=1 ; Rule A→1 GREEN ; Rule B→42 RED ; Rule C→43 RED
```
→ 该判据**可失败**：若库内 trades 不是「清仓口径」，Rule A 会立刻 RED。实测 Rule A 全绿，
证明结论不是自证；Rule B/C 红证明判据有区分度。

### 4.2 正向对照：trades 会少于 fills（非本 run）
全库 359/377 个 run 满足 `trades_n != fills_n`（如 `sr_1789040196234_000000`：fills=212 vs trades=106）。
即「成交多于回合」是常态；本 run 43 vs 1 只是该常态的极端（单边单调加仓 + 期末一刀清仓）。

### 4.3 前端绑定错字段的可观测差异（实测）
`25_e2e_field_mutation.cjs`（Playwright，只读导航 + 响应拦截替换，**不改仓库/库**）：
```
baselineTradeRows（真实页面「交易明细」）        = 1
fillsNote（同页 K 线脚注）                        = "成交 43 笔（精确源 /fills）"
mutatedTradeRowsWhenTradesReplacedWith43          = 43
observableDifference                              = 42
```
→ 该 Tab 的行数**确实**由 `result.trades` 驱动；若改为 `fills`，同屏由 1 行变 43 行，差异可观测。
故「1 行」是绑定回合口径的真实展示，而非渲染去重/过滤 bug（`TradesTable` 无 filter/dedup）。

### 4.4 未能执行的反证 + 残留不确定性
- **部分卖出分支未能用真实数据触发**：全库 377 run 中 `partial_sells = 0`（`17_*`）。
  目标 run 亦无部分卖出（43 笔中唯一 Sell 即期末全平）。因此「部分卖出不进 trades」这一**分句**
  在本 run 的结论中**不被使用**（目标 run 走的是「多笔买入合并」+「一次全平」两个分支，
  两者均已由真实数据覆盖）。该分句的既有独立凭证是 `crates/web/tests/tester_p6_fills_indep.rs:255`
  （`t_p6_fills_is_exact_source_and_trades_misses_partial_fills`），但**本轮未运行**：
  该集成测试写库（自建 run 后清理），需 `EESTOCK_TEST_DATABASE_URL` 指向测试库；
  当前服务器只有 `eestock` 活库、无 `eestock_test` 库，初始化测试库属 DDL（被本轮纪律禁止）。
  ⇒ 残留不确定性：**部分卖出场景**未经本轮端到端实测；对本 run 结论无影响。
- 上游命名的历史对照「position_pct=0.5 + 部分卖出 ⇒ fills 3 vs trades 1」在本库中**查无此 run**；
  库内 `position_pct=0.5/0.3` 的两个 run（`sr_1789212590258_000051`/`sr_1789212545195_000050`）
  实际是 2 笔成交（1 B + 1 全平 S）⇒ 1 条 trades，**不含部分卖出**。上游 README 该示例取自
  design 文档历史叙述，非本库实测；此为上游一处**引用未标注来源**，但**不影响其根因结论**。

## 5. 上游越界审计
- 仓库：`git status` 仅 1 个 tracked 改动 `design/01-architecture/adr/ADR-023-...md`，
  mtime 2026-09-17 13:34+0800（早于上游取证窗口 09-18 21:32–21:40+0800），**非上游所为**。
  上游仅新增 `coder/evidence/20260918_sr_trades_forensics/`（untracked）。
- 库：目标 run 创建于 13:32:08 UTC（早于上游证据文件 13:34–13:38 UTC）；窗口内**无新 run**；
  无 `tp6f_/tp4w_/tp4_` 测试残留；`commands.sh` 命令全为 SELECT + curl + 只读 python。
  ⇒ 未见上游写库/改仓库（无法从外部证明历史上绝无 UPDATE，但无任何可观测写入痕迹）。
- 未混淆「未写 fills 块」与「无成交」：上游正确强调 `recorded=true`；我的实测亦为 true。
- 未漏 MAX_TRADES：上游结论正确（仅 strategy.rs:1255 test_run 路径），我独立复核一致。

## 6. 三个必答问题的回答
1. **上游根因结论是否成立？** 成立（PASS）。核心事实（trades 清仓合成口径、43 fills、42B+1S、
   期末强平、读侧一致、无截断）我逐项独立复现一致；并额外用全库 377 run 交叉重算加固。
2. **「1 条交易记录」是数据事实还是展示缺陷？** 首先是**数据事实**（引擎契约下的正确结果，
   API/DB 皆 1，无丢失）；同时存在**展示/UX 缺陷**（不是数据或引擎 bug）：默认 Tab「交易明细」
   展示回合口径却不加口径标注，而同页已加载的 43 笔逐笔成交仅出现在 K 线脚注，二者无互链，
   用户无法从「交易明细 1 行」推断出「逐笔成交 43 笔」。
3. **若为展示缺陷，最小修复面（仅描述，不实施）？**
   - 最小面（纯前端，1 文件）：`web/src/features/workbench/ResultView.tsx` 的「交易明细」Tab——
     在表头/标题加口径标注（如「已平仓回合 1 / 逐笔成交 43」）并复用 `useRunSeries` 已加载的
     `series.fills` 提供「逐笔成交」视图或跳转；不改接口契约。
   - 不建议：改 `TradeDetail` 语义为逐笔配对（会改写 metrics.trade_count/win_rate/avg_hold_bars，
     破坏历史可比性）；新增 `/roundtrips` 端点属契约扩张，非最小。

## 7. 证据文件清单（本目录）
`00_REPORT.md`(本文件), `01_verify_sql_shape.txt`, `02_verify_result_shape.txt`,
`03_fills_payload_raw.json`, `04_recompute_trades.py`, `05_db_trades_raw.json`,
`06_recompute_output.txt`, `07_label_grep_交易明细.txt`, `08_label_grep_成交明细.txt`,
`09_resp_result.json`, `10_resp_fills.json`, `11_resp_brief.json`, `12_curl_log.txt`,
`13_all_runs_trades_vs_fills.txt`, `14_crossrun_recompute.json`, `15_crossrun_trades_ne_fills.json`,
`16_crossrun_recompute.py`, `17_crossrun_recompute_output.txt`, `18_pct05_fills.txt`,
`19_pct05_trades.txt`, `20_workbench_e2e.png`, `21_e2e_workbench_probe.cjs`,
`22_e2e_probe_output.txt`, `23_mutation_recompute.py`, `24_mutation_recompute_output.txt`,
`25_e2e_field_mutation.cjs`, `26_e2e_field_mutation_output.txt`,
`28_engine_excerpt.txt`, `29_max_trades_audit.txt`, `30_upstream_overreach_audit.txt`
