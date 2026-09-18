# ADR-024 P6（`/fills` 有界精确源）+ P4 并批重验 —— 新增测试**设计报告**

- **本报告自身路径**：`tester/design/294_adr024_p6_fills_verify_design.md`
- 角色：tester（**只验不改生产代码**；本批**未** `git add` / `commit`）
- 判据来源：`design/16-backtest-scalability/02-spec.md` §1.2 / §2 / §3.2 / §5.2 / §5.3（架构师回填后的工作区版本）；
  `design/16-backtest-scalability/01-adr.md` D8/D9/D10；`design/04-storage/schema.md` §4.3.18；
  worker 交付 `coder/report/adr024_p6_frontend_result_paths.md`（自报口径需独立复核）
- 证据目录：`tester/evidence/252_adr024_p4p6_verify/`
- 被验交付态 sha256（与 worker 报告自报一致，见证据 26）：
  `crates/application/src/workbench.rs = 41ae267f…`、`web/src/features/workbench/useRunSeries.ts = 05be06ff…`

## 1. 测试策略（分层）

| 层 | 判据 | 手段 |
|---|---|---|
| 迁移 | `schema.md §4.3.18` == `migrations/0027`（逐字）；tangle 门禁；沙箱复算 sha | 三方 byte diff + 空 filedb 沙箱 `entangled tangle -f`（含篡改判红探针） |
| 活库未迁移 | `strategy_run_bars` 不存在、`result_format` 列不存在 | `information_schema` / `to_regclass` 直查 |
| 端口/存储 | `kind='fills'` 可写入、round-trip、kind 隔离 | 真实 `PgStrategyRunStore` + 临时库（复用既有 tester `tester_p4_store_indep`） |
| 写路径 | fills 块亦「先于 `mark_succeeded`」、写失败⇒`failed`、取消⇒`canceled`、seq 单调、`ts_from/to` | 真实 DB store **外包注入层**（`fail_at` / `fail_kind(ResultKind::Fills)` / `cancel_at`），除注入点外逐方法透传 |
| `/fills` wire | 单块 seq=0、`total` 正确、分页边界、元素字段 == `EngineEvent::Fill` 投影、`ts` 来自对应 bar | 真实 axum server + 真实临时库 + reqwest；与 `/bars?kind=per_bar` 交叉核对 |
| 「无成交」vs「未写」 | 恒写空块 ⇒ `recorded` 可判 | ① 真实 run（恒 Hold ⇒ 无成交）；② 手工 chunked run（无 fills 块）；③ 手工 legacy run（内联派生） |
| 反向防误用 | `/curve?kind=fills`、`/bars?kind=fills` ⇒ 400 + 提示 `/fills` | 真实 server；并对照 3 个合法 kind 均 200 |
| **决定性（不抽样/不用 trades）** | 含「部分买入（`position_pct<1`）+ 部分卖出（未清仓）」的 run：`/fills` 含之、`trades` 不含 | 构造确定性价格路径 + Buy→Hold→Buy 插件 ⇒ 重快照目标 < 当前持仓 ⇒ 部分卖出；两侧原始 JSON 并列 |
| 前端取数契约 | 单一入口、4 类消费者、缺口 grep 非 0、长区间不静默截断、legacy 零回归 | 缺口 grep + 全量 vitest + **反向变异**（忽略 `has_more`） |
| 真渲染 | 第二 app 实例（临时库 + 0027）+ Playwright | 断言 DOM + 网络命中；反向对照掐断 `/fills` |

## 2. 用例清单（should-when）

### 2.1 `crates/web/tests/tester_p6_fills_indep.rs`（**新增，4 例**）

| 用例 | 场景与断言要点 |
|---|---|
| `t_p6_fills_is_exact_source_and_trades_misses_partial_fills` | 30 bar、`LumpSum position_pct=0.5`、闭包 [100×6, 150,175,200, 200…] + 插件 Buy(0..5)/Hold(6..8)/Buy(≥9)。断言：fills **单块 seq=0**、`ts_from/ts_to` = 本 run 首/末 bar ts、`total` == DB payload 长度；`/fills` 字段 `{run_id,total,offset,limit,has_more,next_offset,recorded,fills}` 齐备且 `recorded=true`；每元素字段集合恰为 `{type,bar_index,ts,side,qty,price,reason}`，`ts` == 对应 bar ts（并与 `/bars?kind=per_bar[bar_index].ts` 相等）；**部分买入**（累计买入 ∈ (400,900) 股，远小于全仓 1000）；存在一笔 `reason=Policy`、`bar_index<n-1` 的**部分卖出**（未清仓）；`trades.len()==1 != fills.len()==3`、部分卖出 bar 不在 `trades.close_bar`、`trade.shares < 累计买入`；`per_bar[ps_bar].events` 含同一笔卖出（引擎事实源） |
| `t_p6_fills_paging_boundaries_and_clamps` | 12 bar、`Dca{tranches:3,Equal,interval:1}` ⇒ 3 笔加仓 + 1 笔期末强平 = 4 笔。断言：恰好一页（`limit=total`）、跨页（`offset=1&limit=2`）、差一笔（`limit=total-1` ⇒ `has_more=true`/`next_offset=total-1`）、超末尾（`offset=total`/`total+5` ⇒ 空页且 `has_more=false`）、`limit=1` 逐页拼接逐值 == 全量、`limit=0→1`、`limit=99999→20000`、`offset<0→0`、`bar_index` 单调不减且与 ts 对齐 |
| `t_p6_fills_recorded_vs_unrecorded_and_legacy_derived` | ① 恒 Hold 真实 run ⇒ `total=0` 且 `recorded=true`（DB 有 `payload='[]'` 的 fills 块）；② 手工 `chunked_v1` 行**无 fills 块** ⇒ `recorded=false`；③ 手工 `legacy_single` 行内联 per_bar 含 2 个 fill 事件 + 1 个 log ⇒ `recorded=true,total=2`（跳过非 fill、`ts` 取所属 per_bar 记录 ts、**零分块行**不回填）；④ 未知 run ⇒ 404 |
| `t_p6_fills_rejected_by_curve_and_bars_with_hint` | `/curve?kind=fills`、`/curve?kind=fills&k=10`、`/bars?kind=fills` ⇒ **400** 且 body 同时含 `fills` 与 `/fills`；对照 `net_value`/`drawdown`/`per_bar` 4 条路径 ⇒ 200 |

### 2.2 `crates/web/tests/tester_p4_writepath_indep.rs`（tester 既有 4 例 + **本批新增 2 例**）

| 用例 | 断言要点 |
|---|---|
| `t_p6_fills_chunk_write_failure_marks_failed_and_precedes_success` | `InjectStore.fail_kind(Fills)`：fills 块写失败 ⇒ run `failed`、error 含「结果分块落库失败」、**无 `strategy_run_result` 行**（= fills 写**先于** `mark_succeeded`）、`result_chunk_count(Fills)=0` 而 per_bar 块已写出 |
| `t_p6_fills_chunk_single_block_and_result_row_coexist` | 11000 根成功路径：fills 恒单块 `seq=0`、`ts_from/ts_to` = 首/末 bar ts、payload 非空（买入 + 期末强平） |

### 2.3 真渲染 harness `web/tester/p4p6-render/run.mjs`（14 项断言）

真实 chunked run（518880 M1，7953 bar，200 fills / 100 trades，`chunk_count=2`）：
结果页标题、聚合/净值曲线「共 7953 bar」抽样标注、K 线成交笔数来自 `/fills`（`成交 200 笔（精确源 /fills）`）、
逐bar表首屏 5000 + `has_more` 覆盖提示（`未加载 2953 根`）→ 点「加载更多」拉满 7953 提示消失、
事件日志覆盖标注、无 console 错误、网络面真实命中 `/curve`×3、`/bars?kind=per_bar`×2、`/fills`×1。
反向对照（`NEG=abort-fills`）：掐断 `/fills` ⇒ 出现 `wb-fills-error`（`成交明细加载失败：Failed to fetch`）且成功文案消失。

## 3. 夹具 / mock 策略

- **真实 DB**：`test_support::test_pool()`（`EESTOCK_TEST_DATABASE_URL` → `tmp_p4p6_20260918151821`，哨兵断言）。
- **造数两种**：① 真实写路径（submit → 引擎 → 分块落库）；② 手工 SQL 造 `strategy_run(_result/_bars)`（构造 legacy / 无 fills 块的 chunked）。
- **确定性注入**：`InjectStore` 外包真实 `PgStrategyRunStore`，`fail_at` / `fail_kind` / `cancel_at` 三个注入点，其余逐方法透传（走生产同路径）。
- **价格路径确定**：`seed_symbol_and_prices` 直接 `unnest(float8[]) WITH ORDINALITY` 造 M1 OHLCV（open=close，high/low ±1），无随机。
- **真渲染**：第二 app 实例（`--config /tmp/app_p4p6.toml`，`listen=127.0.0.1:18083`，`static_dir=web/dist`）+ Playwright chromium。
- **隔离**：每个用例独立 symbol（`tp6f/tp4a/tp6a` 前缀 + pid），避免同 binary 并行互删。

## 4. 边界与异常用例覆盖

- 分页：0 / 恰好一页 / 跨页 / 差一笔 / 超末尾 / 负 offset / 0 与超上限 limit。
- 「无成交」（`recorded=true,total=0`）与「未写」（`recorded=false`）必须可区分。
- legacy 双读：内联派生、过滤非 fill 事件、不回填。
- 反向：`/curve?kind=fills`、`/bars?kind=fills` 400；掐断 `/fills` ⇒ UI 显式报错。
- 写路径异常：fills 块写失败 / 分块写失败 / 取消竞态 / 协作式取消。
- 前端反向：忽略 `has_more`/`next_offset` ⇒ 长区间断言必红（逐字节还原）。

## 5. 覆盖目标

- 后端新增独立用例 **6**（4 `/fills` + 2 写路径），加上 tester 既有 P4 独立用例 14，合计 20；
  后端四 crate 全量 **64 suites / 498 passed / 0 failed**（证据 20/21）。
- 前端全量 **90 files / 864 tests**（不减少；P6 净 +14）。
- 契约出口字段：`has_more`/`next_offset`/`downsampled`/`original_bars`/`result_format`/`bars_total`/`chunk_count`/`recorded`
  与 URL `runs/…/{brief,bars,curve,fills}` 命中数**全部非 0**（证据 10）。
