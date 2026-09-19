# sr_1789738328788_000005 —— 「交易明细只有 1 条」取证报告

- 取证时间：2026-09-18（本地 21:30–21:40 / UTC 13:32–13:40）
- 被测服务：`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（pid 2043164），同进程同时提供 Web 8081 + MCP 8082（见 `33_app_process.txt`）
- 数据库：TimescaleDB 127.0.0.1:5433 / eestock
- **本轮只读**：无 UPDATE/INSERT/DELETE/DDL；无代码改动；无 `git add/commit`（仅新增本证据目录）
- 本文件即报告本体：`coder/evidence/20260918_sr_trades_forensics/README.md`

---

## 0. 一句话根因

**不是 bug，也不是数据丢失**：`sr_1789738328788_000005` 跑的是 `dca_baseline`（定投对照组）+ `Dca(100 批)` 执行策略，整段回测**只建了一次仓、从未触发卖出信号**，引擎的 `TradeDetail` 口径是「**仅完全平仓时合成一笔完整交易**」（`crates/strategy-core/src/engine.rs:846-862`），因此 42 笔连续买入被合并为 1 个持仓台账、只在**期末强平**（`ForceClose`，`engine.rs:471-500`）那一刻合成了 **1 条** TradeDetail。

而同一次运行的**成交事实源 `/fills` 有 43 条**（42 Buy + 1 ForceClose Sell）—— 用户看到的「K 线上一堆 B/S 标记」与「交易明细 1 行」都是**真实的**，只是两个字段口径不同（`fills` = 逐笔成交；`trades` = 已平仓的完整回合）。

---

## 1. 完整因果链（用户看到什么 → 数据从哪来 → 为什么只有 1 条）

```
用户 → Web 「回测工作台」/backtest-workbench（ResultView，默认 Tab「交易明细」）
      → GET /api/workbench/runs/{id}/result            （crates/web/src/lib.rs:97 → crates/web/src/workbench.rs:428）
      → WorkbenchService::result_compat                 （crates/application/src/workbench.rs:1247）
      → strategy_run_result.trades （jsonb，chunked_v1 下**全量**回传，不截断/不分页）
      → engine EnsembleResult.trades: Vec<TradeDetail>  （crates/strategy-core/src/engine.rs:246）
      → 只有 apply_sell 的 `qty >= h.qty`（清仓）分支才 `trades.push(...)`（engine.rs:846-862）
      → 本次运行：42 笔 Buy（DCA 分 9 个定投窗口）+ 唯一 1 笔 Sell(ForceClose) ⇒ 1 条 TradeDetail
```

同页另一处取数走**另一条链路**（这也是用户困惑的来源）：

```
KlineResultChart（同页 K 线）→ GET /api/workbench/runs/{id}/fills
   → strategy_run_bars.kind='fills'（单块 seq=0）→ 43 笔 ⇒ K 线上 42 个 B + 1 个 S 标记
   （web/src/features/workbench/ResultView.tsx:167 调 KlineResultChart；KlineResultChart.tsx:10-45 buildMarkers）
```

> 即：**同一屏** K 线画了 43 个成交标记，而「交易明细」Tab 只有 1 行。

---

## 2. 逐条证据（原始命令 + 原始输出；输出落文件，文件名与 taskbook 条目对应）

### 2.1 记录存在性与元信息（`01_run_meta.txt`、`02_run_prefix_fuzzy.txt`）

```bash
PGPASSWORD=eestock psql -h 127.0.0.1 -p 5433 -U eestock -d eestock -x -c "SELECT id,name,symbol,period,from_ts,to_ts,status,progress,error,created_at,started_at,finished_at,config FROM strategy_run WHERE id='sr_1789738328788_000005';"
```
```
id          | sr_1789738328788_000005
name        |                       (空)
symbol      | 518880
period      | D1
from_ts     | 2026-01-04 16:00:00+00
to_ts       | 2026-09-16 16:00:01+00
status      | succeeded
progress    | 1
error       |                       (空)
created_at  | 2026-09-18 13:32:08.788482+00
started_at  | 2026-09-18 13:32:08.789892+00
finished_at | 2026-09-18 13:32:08.808101+00
config      | {"fee":{...},"policy":{"Dca":{"mode":"Equal","amount":null,"interval":1,"tranches":100}},
              "slots":[{"params":{"cadence":20.0,"plan_bars":5.0},"sha256":"5d7f83df…","weight":1.0,
                        "version":1,"archived":false,"version_id":"sv_1789211089727_000010",
                        "strategy_id":"st_1789211089727_000009"}],
              "buy_threshold":60.0,"sell_threshold":40.0,"initial_capital":100000.0,
              "clamped":true,"clamp_reason":"data_range",
              "requested_from":"2026-01-01T00:00:00+00:00","requested_to":"2026-09-18T00:00:00+00:00",
              "estimated_bars":173,"warmup_requested":250,"warmup_effective":250,
              "progress_prescan":"count"}
```
（同前缀模糊查只有这 1 条，排除 id 歧义。）

**来源判定**：`sr_` 前缀由 `application/workbench.rs:692 id: new_id("sr", now)` 生成（`crates/application/src/strategy.rs:80-83` id 规则），即**回测工作台 run**。三条入口都会产生 `sr_`：
1. Web `POST /api/workbench/runs`（`crates/web/src/lib.rs:94`）
2. MCP `bt_run_ensemble`（`crates/mcp/src/tools.rs:361`）
3. sim-live「回测一下」`sim_run_backtest_compare`（**强制 LumpSum 全仓**，见 `tools.rs:249-250`）

本 run 的 `policy = Dca{tranches:100,interval:1}` ⇒ **排除 (3)**（sim 对比口径是 LumpSum）。
(1)/(2) 之间由日志判别：应用日志里 `mcp sse session opened/closed` 全部集中在 12:18–12:48，**13:31 与 13:32 两次 run 提交前后没有任何 MCP SSE 会话**（`25_mcp_sessions.txt`、`25_app_log_full.log` 第 100–119 行之后直接是 13:31 的 p4b.submit）⇒ 判为**经 Web 8081 提交**（回测工作台页）。
`strategy_preset` 无任何预设（`22_presets.txt`：0 rows）⇒ 不是从预设一键跑出来的。

### 2.2 result_format 与各结果块行数（`03_result_shape.txt`、`04_bars_by_kind.txt`、`05_bars_payload_shape.txt`）

```bash
$PSQL -c "SELECT run_id,result_format,jsonb_typeof(per_bar) pb_type,jsonb_array_length(per_bar) pb_len,jsonb_typeof(trades) tr_type,CASE WHEN jsonb_typeof(trades)='array' THEN jsonb_array_length(trades) END tr_len,jsonb_array_length(net_value) nv_len,jsonb_array_length(drawdown) dd_len,metrics FROM strategy_run_result WHERE run_id='sr_1789738328788_000005';"
```
```
run_id                  | result_format | pb_type | pb_len | tr_type | tr_len | nv_len | dd_len | metrics
sr_1789738328788_000005 | chunked_v1    | array   | 0      | array   | 1      | 0      | 0      | {"sharpe":-0.8029,"win_rate":0.0,"net_profit":-2933.6479,"trade_count":1,"max_drawdown":0.05261,"avg_hold_bars":161.0,"profit_factor":0.0,"annualized_return":-0.04245}
```
> ⚠ 陷阱：chunked_v1 下 `strategy_run_result.per_bar/net_value/drawdown` 是**占位空数组**，真数据在 `strategy_run_bars`（`workbench.rs:1908` 注释：“分块已落库；strategy_run_result 仅写 trades/metrics + 占位”）。

```bash
$PSQL -c "SELECT kind,count(*) n,min(seq),max(seq),min(ts_from),max(ts_to) FROM strategy_run_bars WHERE run_id='sr_1789738328788_000005' GROUP BY kind ORDER BY kind;"
```
```
 kind      | n | min_seq | max_seq |        min_ts         |        max_ts
-----------+---+---------+---------+-----------------------+-----------------------
 drawdown  | 1 |    0    |    0    | 2026-01-04 16:00:00+00| 2026-09-16 16:00:00+00
 fills     | 1 |    0    |    0    | 2024-12-22 16:00:00+00| 2026-09-16 16:00:00+00
 net_value | 1 |    0    |    0    | 2026-01-04 16:00:00+00| 2026-09-16 16:00:00+00
 per_bar   | 1 |    0    |    0    | 2024-12-22 16:00:00+00| 2026-09-16 16:00:00+00
```
块内元素数（`05_bars_payload_shape.txt`）：`per_bar=423`、`fills=43`、`net_value=173`、`drawdown=173`。四个 kind **都有块**（`chunk_writes:4`，见应用日志 `p4b.segment progress_drain`）。

### 2.3 两条链路真实产物并排（真打 8081；`13_curl_log.txt` + `13_resp_*.json`）

服务在跑（`ss -tlnp`：8081/8082 均 `eestock-app` pid 2043164）。原始命令：

```bash
B=http://127.0.0.1:8081; RUN=sr_1789738328788_000005
curl -sS -o .../result  -w 'HTTP %{http_code}' "$B/api/workbench/runs/$RUN/result"
curl -sS -o .../fills?offset=0&limit=100 -w 'HTTP %{http_code}' "$B/api/workbench/runs/$RUN/fills?offset=0&limit=100"
curl -sS -o .../curve -w 'HTTP %{http_code}' "$B/api/workbench/runs/$RUN/curve"
curl -sS -o .../bars?kind=per_bar&offset=0&limit=2 -w 'HTTP %{http_code}' "$B/api/workbench/runs/$RUN/bars?kind=per_bar&offset=0&limit=2"
```
全部 `HTTP 200`（`13_curl_log.txt`）。关键字面量：

| 端点 | 关键字段 | 值 |
|---|---|---|
| `GET …/result` | `result_format` | `chunked_v1` |
| | `trades` | **长度 1**（见 `14_result_api_analysis.txt`） |
| | `per_bar` | 长度 423（首页）、`has_more=false` |
| | `metrics.trade_count` | 1 |
| `GET …/fills?offset=0&limit=100` | `total` | **43** |
| | `recorded` | **true** |
| | `has_more` / `next_offset` | false / null |
| | `fills[]` | 42 Buy + 1 Sell(`ForceClose`)（`15_fills_api_analysis.txt`） |
| `GET …/curve?kind=net_value` | `points / original_bars / downsampled / k` | 173 / 173 / false / 2000 |
| `GET …/bars?kind=per_bar&offset=0&limit=2` | `total / has_more / next_offset` | 423 / true / 2 |

`/fills` 与库内 `fills` payload **逐元素完全相同**（`26_api_vs_db_consistency.txt`：`identical (order+values): True`）；`/result.trades` 与库内 `trades` 完全相同（`True`）。⇒ 读侧没有丢数据、没有二次截断/去重。

### 2.4 归因实验：按实现规则自行配对（`18_pairing_experiment.py`、`19_pairing_output.txt`）

用 `/fills` 原始 43 笔成交 + 该 run 的 fee 契约（`rate_pct=0.025, min_fee=5.0, slippage_bp=2.0, stamp_duty_pct=0`，`crates/backtest/src/fee.rs:39-113`）复算引擎口径：

```
open_ts  1768838400   close_ts 1789574400   open_bar 261  close_bar 422   hold_bars 161
open_price 9.47542039259697    close_price 8.8542288
shares 4368.985265614662       gross_value 38683.99516558099
commission 219.67099879139525  stamp_duty 0.0        pnl -2933.647913971261
```
与落库 TradeDetail **逐字段 diff = 0**（含浮点 0.00e+00）。⇒ 落库那 1 条不是"半截数据"，而是 42 笔买入的**加权汇总**（`open_price = value_basis/qty`，`shares = Σ买入量`，`pnl = 卖出净得 − 累计成本`）。

反事实计数（同一份 fills）：
- 若按「逐笔买入各自成一个回合」：**42 笔**
- 若按「平仓事件」计数：**1 笔**
- 引擎实际口径（清仓合成）：**1 笔** ← 与库内/接口一致

### 2.5 仓位轨迹与「为什么从不卖出」（`07_fills_summary.txt`、`28_per_bar_fill_events.txt`、`29_orders_and_signals.txt`）

```
fills 43 笔：Buy 42 / Sell 1；ΣBuy_qty = ΣSell_qty = 4368.985265614662（净 0，收盘空仓）
per_bar 423 根（warmup 250 + in-range 173），Fill 事件 43 笔：
  by reason: Policy×42, ForceClose×1
  by side  : Buy×42, Sell×1
持仓 >0 的 bar 数 = 161（bar 261 … bar 421），bar≤260 与 bar 422 均为 0
signal==Buy 的 bar：0-4,20-24,…,240-244,260-264,280-284,300-304,320-324,340-344,360-364,380-384,400-404,420-422
signal==Sell 的 bar：**（空）**
Buy 挂单决策 bar（43 条，全部 Buy）：260-264,280-284,…,400-404,420,421,422
```
- 标的策略 = `dca_baseline`（`sv_1789211089727_000010`，sha256 `5d7f83df…`，published，`21_strategy_version.txt` 有完整源码）：`on_bar` 在 `idx % cadence < plan_bars` 时返回 75（≥ buy_threshold 60 ⇒ Buy），否则 50（在 40/60 之间 ⇒ Hold）。**该策略源码里根本不存在返回 ≤ sell_threshold(40) 的分支**。
- 执行策略 `Dca`（`crates/strategy-core/src/policy.rs:165-201`；枚举定义 `:33-40`，校验 `:58-71`）：Buy 窗口内每 bar 打一批（`interval=1`），批额 `equity/tranches = 100000/100 = 1000`；Hold 即 `self.dca=None`（剩余批次取消）。
  9 个 Buy 窗口（8 个完整 5-bar 窗 + 末窗受区间结束只剩 3 bar）= **43 条 Buy 挂单意图**；
  成交 **42 笔**：差异的 1 条是**最后一根 bar（bar 422）挂的单没有「下一 bar」可成交**（引擎 `Pending` 在 `finish()` 里不做成交处理，`engine.rs:471-500` 只强平持仓），并非现金不足（现金余额充足，累计花费 ≈4.2 万 / 初始 10 万）。与 fills 完全对上（`29_orders_and_signals.txt`）。
- 唯一卖出 = `EnsembleEngine::finish()` 的期末强平（`engine.rs:471-500`，`reason: OrderReason::ForceClose`），时间戳与最后一笔买入同为 bar 422。

**结论**：本 run 的仓位是"一条单调加仓曲线 + 期末一刀清仓"，因此"完整回合"天然只有 1 个。

### 2.6 判据来自实现（file:line 原文）

| 环节 | 位置 | 原文/要点 |
|---|---|---|
| TradeDetail 只在清仓合成 | `crates/strategy-core/src/engine.rs:846-862` | `if qty >= h.qty { /* 清仓 → 合成一笔完整交易 */ trades.push(TradeDetail{…}); *holding=None; trailing.reset(); } else { /* 部分卖出按比例摊薄 */ }` |
| 买入并入同一 Holding（不产生 trade） | `engine.rs:537-580`（`Pending::BuyDelta` 分支；`match &mut self.holding`@:547） | `Some(h) => { h.qty += …; h.cost_basis += …; }` / `None => { self.holding = Some(Holding{… entry_ts: bar.ts, entry_bar: i}) }` |
| 期末强平 | `engine.rs:471-500` | `let exec = fee.sell(h.qty, bar.close); … apply_sell(&mut self.holding, &mut self.trades, …, OrderReason::ForceClose)` |
| 结果结构 | `engine.rs:246` | `pub trades: Vec<TradeDetail>` |
| 类型定义 | `crates/backtest/src/types.rs:100-122` | `/// 一笔完整交易（开→平）的明细。 TradeDetail{open_ts,…,hold_bars}` |
| `/result` 路由 → handler | `crates/web/src/lib.rs:97` → `crates/web/src/workbench.rs:428 get_result` → `crates/web/src/workbench.rs:430 svc.result_compat(&id, BARS_LIMIT_DEFAULT)` | chunked 分支 `trades: res.trades.clone()`（`crates/application/src/workbench.rs:1265`） |
| `/fills` 路由 → handler | `crates/web/src/lib.rs:101` → `crates/web/src/workbench.rs:544 get_fills` → `crates/application/src/workbench.rs:950 result_fills` | 文档即契约：`947-949 “硬约束：不得用 /curve … 或 trades（仅完全平仓时合成 ⇒ 部分买入/加仓与部分卖出不进 trades）代替本端点”` |
| fills 块写入 | `crates/application/src/workbench.rs:2069-2082 fills_chunk`（fn 定义@:2071）+ `:1770` 注释 | “**无成交也写空数组块** ⇒ 读侧『有块 = 已记录』可判定” |
| MCP 对应工具 | `crates/mcp/src/tools.rs:401 bt_get_run_result` → `:1430 wb.result_compat(run_id, limit)` | 与 web `/result` 同源同字段（**返回的 trades 同样是 1 条**）；MCP 侧**没有** fills 工具（`rpc.rs:119` 工具名单：`bt_run_ensemble/bt_get_run/bt_get_run_result/bt_list_runs/bt_cancel_run/bt_compare_runs/bt_list_presets/bt_apply_preset`） |

### 2.7 前端哪一处显示「交易明细」（`30_frontend_label_grep.txt`）

全仓 grep 中文标签后**唯一**的中文 UI 标签「交易明细」：

| file:line | 绑定字段 | 说明 |
|---|---|---|
| `web/src/features/workbench/ResultView.tsx:16` | `label:'交易明细'`（Tab key=`trades`） | Tab 默认选中：`ResultView.tsx:120 useState<TabKey>('trades')` |
| `web/src/features/workbench/ResultView.tsx:57-88` | **`result.trades`**（`TradesTable`，`data-testid="wb-trades-table"`，`result.trades.map`@:77） | 用户看到的 1 行就是这里 |

其它中文命中都不是这个 Tab：

| file:line | 绑定字段 | 是否命中本场景 |
|---|---|---|
| `web/src/features/workbench/KlineResultChart.tsx:80/83/91` | `series.fills`（`/fills`） | 同页 K 线标记「成交明细」文案；显示 43 个 B/S |
| `web/src/features/strategies/TestRunPanel.tsx:127` | `result.truncated.trades` 文案「成交明细」 | 只在**截断提示**里出现；表格本体（:256-282）绑定试算响应 `result.trades` |
| `web/src/api/types.ts:419 / 794 / 1114 / 1126`、`client.ts:275`、`mock.ts:697` | 注释/类型 | 非 UI 文案 |

**判别依据（非猜测）**：
1. `/backtest-workbench` 是唯一会为 `sr_*` 记录渲染「交易明细」Tab 的页面（`web/src/App.tsx:33`；`RunList.tsx:156`「暂无运行记录」= 用户口中的「回测记录」列表）。
2. 策略试算页 `/strategies`（`TestRunPanel`）走 `POST /api/strategies/test-run`（`crates/web/src/lib.rs:80`），**不落库、不产生 run id**（`crates/application/src/strategy.rs` 全文无 `run_store/create_run`）⇒ 用户既然报出 `sr_…` id，就一定不是试算面板。
3. sim-live 的历史对比只回显 `run_ids=…` 文本（`web/src/features/simlive/panels.tsx:517/536`），无「交易明细」表；且其 run 恒为 LumpSum（与本 run 的 Dca 不符）。
⇒ 用户命中的页面 = **`/backtest-workbench` 的 run 详情（ResultView）× 默认 Tab「交易明细」**，字段 = `result.trades`。

### 2.8 其它「只有一条」假设逐一排查

| 假设 | 结论 | 判据（命令/文件行） |
|---|---|---|
| `MAX_TRADES=5000` 截断 | **不成立（且不适用于本路径）** | `crates/application/src/strategy.rs:61 pub const MAX_TRADES: usize = 5_000;` 只作用于**策略试算** `test_run`（`:1255 let trades = if result.trades.len() > MAX_TRADES`，置 `truncated.trades=true`）。工作台 chunked 路径无任何 trades 截断：`crates/application/src/workbench.rs:1849`（`RunTail{trades: to_value(&res.trades)}`）与 `:1908` 注释 与 `result_compat` 直接 `res.trades.clone()`（`:1265`）。且 `tr_len=1 ≪ 5000`；本 run 不是试算（无 run 落库路径）。 |
| 结果块未写 / 落库失败 | **不成立** | `04_bars_by_kind.txt` 四 kind 各 1 块；应用日志 `progress_drain`: `chunk_writes:4, chunk_write_ms:8.456`，`result_write` 1.755ms，`p4b.run_summary.outcome=succeeded`；`strategy_run.status=succeeded,error=null`（`01/23/25`）。若块写失败，代码会 `mark_failed`（`crates/application/src/workbench.rs:1900-1904`，`mark_failed("结果分块落库失败…")`@:1902）并把 outcome 记 `failed_chunk_write`。 |
| 分页 limit 默认值吞数据 | **不成立** | `/fills` 默认 5000/上限 20000（`design/07-app-plane/00-web-api.md:300`），本次显式 `limit=100` 且 `total=43 < 100`，`has_more=false,next_offset=null`（`15_fills_api_analysis.txt`）。`/result` 的 trades 不走分页（只有 per_bar 分页），本次 `per_bar` 首页 423 根 + `has_more=false`。 |
| 前端渲染过滤/去重 | **不成立** | `TradesTable` 无 filter/dedup，直接 `result.trades.map`（`ResultView.tsx:77`）；`trades` 无 key 冲突（单元素）。契约要求前端**不得**用 trades 代 fills，反之亦然（`useRunSeries.ts:15-24`）。 |
| 区间内成交本就极少 | **不成立** | 区间内 43 笔成交（42 Buy + 1 Sell），并非「无成交」。 |
| fills 块缺失（`recorded=false`）与「无成交」混淆 | **不适用** | `/fills` 返回 `recorded=true,total=43`。区分规则：`application/workbench.rs:938-943`（`blocks==0 ⇒ recorded=false`）。 |
| 是不是 sim-live 结算结果 | **不成立** | `policy=Dca` 与 `sim_run_backtest_compare` 的 LumpSum 口径不符（`mcp/src/tools.rs:249`）；`sim_positions/sim_trades` 属另一命名空间（`s_` 会话，`crates/application/src/simlive.rs:1860 sim_trades_to_trade_details` 的 FIFO 配对口径与 backtest 不同）。 |
| 是不是「读侧 bug / 服务未运行时伪造」 | **不成立** | 服务在跑（`33_app_process.txt`），六条 curl 全 200；API 与库内数据逐元素一致（`26_api_vs_db_consistency.txt`）。 |

---

## 3. 可证伪判据（什么观测会推翻本结论）

1. **若** `strategy_run_bars.kind='fills'` 的 43 笔里存在**早于期末强平、且数量小于当时持仓**的 Sell（即真正发生部分卖出），而 `trades` 仍只有 1 条 ⇒ 才是"漏记回合"。
   - 实测反证：`07_fills_summary.txt` 只有 1 笔 Sell（index 42），qty=4368.985266 = ΣBuy_qty（净仓归零），`reason=ForceClose`，`bar_index=422` = 末根。
2. **若** `per_bar` 里出现 `signal==Sell` 或 `orders[].side==Sell` 的 bar（早于 422）⇒ 应有 ≥2 条 TradeDetail。
   - 实测反证：`29_orders_and_signals.txt`：`signal==Sell bars: []`；43 条 order 全 Buy。
3. **若** 用 `/fills` 按引擎规则（清仓才合成）复算得到 ≠ 1 条，或复算结果与落库 TradeDetail 字段不一致 ⇒ 读侧/写侧存在转换 bug。
   - 实测反证：`19_pairing_output.txt` 全字段 diff=0。
4. **若** 该 run 换成 `LumpSum{position_pct:0.5}` 或带「部分卖出」的价格路径后 `trades` 仍为 1 且 `fills` 多笔 ⇒ 违反 ADR（对照测试 `crates/web/tests/tester_p6_fills_indep.rs:313-341` 已断言 `trades 条数必须 != fills 条数`，该测试是"部分卖出不进 trades"的正向凭证）。
5. **若** `/result` 返回的 `trades` 长度 > 库内 `jsonb_array_length(trades)`，或 `/fills` 的 `total` > 实际返回条数 ⇒ 才是读侧截断/分页 bug。

---

## 4. 判为 bug 还是符合既有契约

**符合既有契约（非 bug）。** 契约原文：

- `crates/domain/src/ports.rs:959-977`
  > `/// ADR-024 P6：新增 Fills —— 成交明细的有界精确源（单块 seq=0）。`
  > `/// fills 是事实源（成交明细）：不得进入抽样/区间/分页曲线路径（ADR-024 P6 硬约束）。`
  > `:961-962 /// ① 抽样曲线会丢真实成交；② trades 仅在完全平仓时合成（apply_sell 的 qty >= holding.qty）⇒ 部分买入/加仓（DCA、position_pct < 1）与部分卖出不进 trades。`
- `crates/strategy-core/src/engine.rs:835`
  > `/// 卖出台账处理：部分卖出按比例摊薄成本；清仓合成完整 TradeDetail 并重置 Trailing。`
- `crates/application/src/workbench.rs:946-949`（`/fills` handler 文档）
  > `/// 硬约束：不得用 /curve（抽样丢真实成交）或 trades（仅完全平仓时合成 ⇒ 部分买入/加仓与部分卖出不进 trades）代替本端点。`
- `design/02-domain/contracts.md:1244`、`design/04-storage/schema.md:1240`、`design/07-app-plane/00-web-api.md:300`、`design/16-backtest-scalability/02-spec.md:166`（同口径，且给出历史实证：**"含 position_pct=0.5 + 部分卖出的 run ⇒ fills 3 笔 vs trades 1 行；7953 bar 真实 run ⇒ fills 200 vs trades 100"**）
- `web/src/features/workbench/useRunSeries.ts:15-24`：前端硬约束"K 线买卖标记**不用** trades"。

因此本次是**口径差异被用户当成数据缺失**，属**产品/UI 表达问题（可称为 UX 缺陷），不是数据或引擎 bug**。

---

## 5. 若要做修复（**本轮不实施，仅方案与影响面**）

架构级候选（需父级裁决，本轮不落地）：
1. **前端在「交易明细」Tab 增加口径说明 + 成交明细入口**（最小改动，非架构变更）：在 `ResultView.tsx:16` 的 Tab 旁标注"已平仓回合（N）/ 逐笔成交（M，见 /fills）"，或在 Tab 内加一行"逐笔成交 M 笔 → "链接/展开 `series.fills`。
   - 影响面：纯前端 1 文件 + 测试；不动接口契约。
2. **新增 run 级回合口径 `/roundtrips`（或 `/trades` 端点）**：把 `fills` 逐笔按 FIFO 配对（参照 `crates/application/src/simlive.rs:1860 sim_trades_to_trade_details`）暴露"逐笔回合"，与引擎 `TradeDetail`（清仓合成）并存。
   - 影响面：`domain/ports.rs` 结果枚举（若落库）、`application/workbench.rs`、`web/src/lib.rs` 路由、MCP 工具面、`design/07-app-plane/00-web-api.md`、ADR-024 修订；**属接口/契约扩张**。
3. **把 `TradeDetail` 语义改为 FIFO 逐笔配对**：**不建议**——会改变 `metrics.trade_count / win_rate / avg_hold_bars / profit_factor` 全部历史口径（`crates/backtest/src/metrics.rs:36-…`），破坏跨 run 可比性，且与 ADR 原文冲突。

---

## 6. 证据文件索引

| 文件 | 内容 |
|---|---|
| `commands.sh` | 本轮执行的**全部**只读命令（可复现清单） |
| `00_schema_strategy_run.txt` | `\d strategy_run*` 真实表/列/约束/索引 |
| `01_run_meta.txt` / `02_run_prefix_fuzzy.txt` | run 元信息 + 前缀模糊查 |
| `03_result_shape.txt` | result_format / 各列 jsonb 长度 / metrics |
| `04_bars_by_kind.txt` / `05_bars_payload_shape.txt` | 分块表按 kind 计数与 payload 形状 |
| `06_fills_payload_raw.json` | `kind='fills'` 原始 payload（43 笔） |
| `07_fills_summary.txt` | 逐笔明细 + side 汇总 + Σqty 平衡 |
| `08_result_row_raw.json`（空）/ `10_trades_raw.json` / `11_trades_pretty.json` | trades 原始与美化（08 为失败尝试，见 §6 备注） |
| `09_trades_content.txt` | trades 内容 + 各序列长度 |
| `12_same_symbol_runs.txt` | 518880 历史 15 条 run 对照（result_format/trades_n） |
| `13_curl_log.txt`、`13_resp_*.json` | 8081 六条真实 HTTP 调用与响应原文 |
| `14_result_api_analysis.txt` / `15_fills_api_analysis.txt` | `/result`、`/fills` 关键字段解析 |
| `16_brief.json` / `17_run_meta_api.json` | `/brief`、`/runs/{id}` 响应原文 |
| `18_pairing_experiment.py` / `19_pairing_output.txt` | 归因实验脚本与输出（复算 vs 落库逐字段 diff） |
| `20_strategy_meta.txt`（查询列名失败）/ `21_strategy_version.txt` | 策略版本（dca_baseline 源码） |
| `22_presets.txt` | 预设表（0 行 ⇒ 非预设触发） |
| `23_applog_runid.txt`、`25_app_log_full.log`、`25_mcp_sessions.txt` | 应用日志（p4b.submit/engine/chunk_writes/run_summary；MCP SSE 会话时点） |
| `24_applog_context.txt` | 提交前后上下文日志 |
| `26_api_vs_db_consistency.txt` | API vs DB 逐元素一致性 |
| `27_per_bar_payload_raw.json` / `28_per_bar_fill_events.txt` | per_bar 原始 + 事件/持仓轨迹统计 |
| `29_orders_and_signals.txt` | 挂单决策 bar、signal==Buy/Sell bar 列表 |
| `30_frontend_label_grep.txt` | 中文标签全仓 grep（交易明细/成交明细/交易记录） |
| `31_curve_summary.txt` | `/curve` 根数/抽样标注 |
| `32_trade_dates.txt` | 开/平仓时间 UTC 与 CN 对照 |
| `33_app_process.txt` | 8081/8082 监听与进程 cmdline |

备注：`08_*`/`09_*`/`20_*` 三个文件是**首次尝试时列名写错**（`strategy_run_result.payload` / `strategy.level` 不存在）产生的失败输出，已原样保留以维持"命令+输出"可追溯；正确查询见 `10/11/21`。
