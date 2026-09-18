# ADR-024 P4 + P6 并批重验 —— tester 独立验收报告

- **本报告自身路径**：`tester/report/adr024_p4p6_combined_verification.md`
- 角色：tester（**只验不改生产代码**：未改实现/接口/架构，未 `git add`，未 `commit`；可写测试与证据）
- 被验交付：
  - `coder/report/adr024_p4_chunked_result_storage.md` + `coder/evidence/adr024_p4/`
  - `coder/report/adr024_p6_frontend_result_paths.md` + `coder/evidence/adr024_p6/`
- 契约出口：`design/16-backtest-scalability/02-spec.md` §1.2 / §2 / §3.2 / §5.2 / §5.3（**架构师已回填，位于工作区未 stage**）+ `01-adr.md` D8/D9/D10；`design/04-storage/schema.md` §4.3.18
- 验收时间：2026-09-18 15:16–15:27（+08:00）；基线 commit `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`
- 证据：`tester/evidence/252_adr024_p4p6_verify/`（30 文件，索引 `00_INDEX.md`，本报告逐项引用）
- 新增测试设计报告：`tester/design/294_adr024_p6_fills_verify_design.md`；执行报告：`tester/test/295_adr024_p4p6_execution.md`

---

# 0. 判词（结论在最前）

## 0.1 两项各自判词

| 项 | 判词 | 一句话依据 | 关键证据 |
|---|---|---|---|
| **① 迁移 0027（修正后）** | **PASS** | `schema.md §4.3.18` SQL 正文与 `migrations/0027` **逐字节相同（含 `'fills'`）**；`check-tangle` 绿；独立沙箱复算 sha 相同且篡改可判红；**活库未迁移** | 01–04 |
| **② `/fills` 语义** | **PASS** | 单块 `seq=0` / `total` / 分页 6 类边界 / 元素字段 == `EngineEvent::Fill` 投影 / 「无成交」与「未写」可区分 / `/curve`·`/bars` 对 `kind=fills` 均 400 并提示 `/fills`：**新增独立用例 4/4 绿** | 08 |
| **③ 为什么「不用 trades / 不抽样」** | **PASS（决定性实证）** | 构造含「部分买入（`position_pct=0.5`）+ 一次部分卖出（未清仓）」的 run：`/fills` = 3 笔（买 500 / 部分卖 125.06 / 期末强平 374.94），`trades` = **1 行**（shares 374.94）；部分卖出 bar(10) **不在** `trades.close_bar`。真实 7953 bar run：`fills=200` vs `trades=100` | 08、17 |
| **④ 写路径语义（回归）** | **PASS** | 分块先于 `mark_succeeded`（fills 块写失败 ⇒ `failed` + **无结果行**）；写失败⇒`failed`；取消⇒`canceled` 不落 succeeded；`seq` 单调、`ts_from/to` = 本块首末 bar ts：**写路径 6/6 绿** | 07、09 |
| **⑤ 前端契约消费（缺口闭合）** | **PASS** | 原 0 命中项（`has_more`…`result_format`）现全部非 0；单一取数入口 `useRunSeries.ts` + 4 类消费者；K线标记来自 `/fills`；事件日志走 `/bars` 分页 + 覆盖提示 + 区间跳读；长区间不静默截断且**反向对照必红**；legacy 零回归 | 10–14、28 |
| **⑥ 真渲染（P6 门禁）** | **PASS** | 临时库（含 0027）+ **第二 app 实例 :18083** + Playwright：**14/14 断言 PASS**；反向对照（掐断 `/fills`）⇒ 显式报错 | 15–19 |
| **⑦ 回归与范围** | **PASS** | 后端四 crate **64 suites / 498 passed / 0 failed**；`check --all-targets` 绿；`check-tangle` 绿；前端 **90 files / 864 tests** 绿 + `tsc -b` + 构建绿；范围分类无越界、`design/16/**` 属架构师；P4b 自洽测试绿 | 20–29 |
| 崩溃 / core | **无** | `ulimit -c 0`、无 core 文件、全部 suite `ok` | 26 |

**硬性未过项：0 项。** 非阻塞发现 4 条（F1–F4，见 §8），其中 **F2 是「冻结操作」层面的必做动作**（不是 P4/P6 违约）。

## 0.2 「P4 重验 / P6 能否一并冻结？」

> ### **可以一并冻结（P4 重验 PASS + P6 PASS）。**
>
> - P4 的重验面（迁移 0027 修正版、`/fills` 未破坏既有 4 端点语义、写路径与读路径双读、P4b 仪表在位）全部复跑绿；
>   P4 验收时唯一的**硬门槛**（前端零消费 ⇒ 0027 不得单独上线）**已被 P6 闭合**（§5）。
> - P6 的全部交付面（`/fills` 有界精确源、`result_format` 双读、单一取数入口、K线标记源、事件日志分页、长区间提示、legacy 零回归）
>   经**独立用例 + 反向对照 + 真渲染**三重取证成立。
>
> **冻结时必须同时做的一件事（F2）**：架构师的 P6 契约回填（`02-spec.md` 的 `kind` 含 `'fills'`、`ResultKind::Fills`、§3.2 `/fills` 行、`04-implementation-plan.md` 的「上线硬门槛」）
> **目前只存在于工作区、尚未 stage**（`git diff --cached` 的 02-spec **不含 `fills`**）。若按“冻结 index 快照”的既有纪律原样冻结，
> 会把一份**不含 fills 契约**的 spec 冻进去。⇒ 冻结动作请把 `design/16-backtest-scalability/**` 的工作区版本一并 stage。

## 0.3 「是否具备上线条件（迁移 0027 + P4 + P6）？」

> ### **具备（条件式）。** 前置均已满足：
> ① 迁移 0027 逐字对齐且可复算（§1）；② 前端缺口已闭合、长区间不再静默截断、买卖标记为精确源（§5）；
> ③ 真渲染 14/14 PASS（§6）；④ 四 crate + 前端全量回归 0 失败（§7）；⑤ 活库仍未迁移、临时库已销毁、无残留（§7.5）。
>
> **上线批次与顺序（硬约束，沿用 ADR-023 §4.1 同型口径）**：
> 1. **先应用 `migrations/0027_strategy_run_result_chunks.sql`**（`psql -v ON_ERROR_STOP=1 -f`，记录应用证据）；
> 2. **再重启/部署 app**（`migrate_check::EXPECTED_RELATIONS` 含 `strategy_run_bars`，缺关系会拒绝启动）；
> 3. **同批部署 P6 前端静态产物**（`web/dist`）——P4 与 P6 必须同批，否则新 run 变 `chunked_v1` 会「净值/回撤图静默空 + 逐bar表只显示前 5000 根」。
>
> **带 3 条附带项上线**（均非阻塞）：F1 `/fills` 响应为 spec 的**超集**（待架构师回填 02-spec 或裁定收敛）；F3 `recorded=false` 仅对「P6 之前的 chunked run」可达（**现网不可能存在**，因活库无 `result_format` 列）；F4 `/curve` 仍服务端全量物化后抽样（P4 §7.3 已知，后续专项）。

---

# 1. ① 迁移 0027（修正后）

## 1.1 三方逐字一致（含 `'fills'`）

原始输出：`01_migration_0027_bytes.txt`、`04_three_way_fills.txt`。

```
schema.md §4.3.18 块（去 tangle 标记）：20 行  sha256 f76f8b6e71661b28e6c42da6d6c13daa482de21737382dcf4a1a5883088e2f6a
migrations/0027（去 tangle 标记）    ：20 行  sha256 f76f8b6e71661b28e6c42da6d6c13daa482de21737382dcf4a1a5883088e2f6a
diff → 空（DIFF_EMPTY_OK）；grep -c fills = 2
```

> 说明（精度要求）：`migrations/0027` 磁盘形态比文档块多 2 行 entangled 标记
> （首行 `-- ~/~ begin <<design/04-storage/schema.md#…>>[init]`、末行 `-- ~/~ end`），
> 这是 tangle 生成物固有包裹；**SQL 正文逐字节相同**。核 `kind` CHECK 一行：
> `kind     text        NOT NULL CHECK (kind IN ('per_bar','net_value','drawdown','fills'))`（三处一致）。

## 1.2 tangle 门禁 + 沙箱复算 + 判别力

原始输出：`02_tangle_and_live_db.txt`、`03_sandbox_regen.txt`。

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。  exit=0

独立沙箱（空 filedb + entangled tangle -f，仅拷 design/ + entangled.toml）：
  复算产物 sha256 2b3aee666518e8f8eaa6acfebced550834c28f9dbf4db223dce99de305cde080
  仓库产物 sha256 2b3aee666518e8f8eaa6acfebced550834c28f9dbf4db223dce99de305cde080  ⇒ SANDBOX_REGEN_BYTE_IDENTICAL
判别力反向对照（沙箱内把 schema.md 的 ('…,'fills') 改回三值再复算）：
  20592214e04353fd2fb8e4fed1ffc7b1c7e64ffb456d61ed9b6215ff8c090c23  ⇒ TAMPER_DETECTED_OK
```

## 1.3 活库仍未迁移（硬约束）

```
活库 eestock：to_regclass('public.strategy_run_bars') = <table absent>
            information_schema 中 strategy_run_result.result_format 列数 = 0
库清单（非 template）：eestock / postgres
```

---

# 2. ② `/fills` 语义（本次核心）

新增独立验收（tester 自写、**不复用** worker 断言）：`crates/web/tests/tester_p6_fills_indep.rs`（4 例，真实 axum server + 真实临时库）。
原始输出：`08_fills_indep_run1.txt`（`test result: ok. 4 passed; 0 failed`，EXIT=0）。

| 判据 | 实测 | 结论 |
|---|---|---|
| **单块 `seq=0`** | DB：`SELECT seq,ts_from,ts_to FROM strategy_run_bars WHERE kind='fills'` ⇒ 恰好 **1 行，seq=0**；`ts_from`==首根 bar ts、`ts_to`==末根 bar ts | PASS |
| **`total` 正确** | `/fills.total` == DB `jsonb_array_length(payload)` == `fills.len()` | PASS |
| **分页边界（0 / 恰好一块 / 跨页 / 超末尾）** | `limit=total`（恰好一页，`has_more=false`）/ `offset=1&limit=2`（跨页，`next_offset=3`）/ `limit=total-1`（`has_more=true`，`next_offset=total-1`）/ `offset=total` 与 `total+5`（空页、`has_more=false`、`next_offset=null`）/ `limit=1` 逐页拼接**逐值 == 全量** / `limit=0→1`、`limit=99999→20000`、`offset=-3→0` | PASS |
| **「无成交」vs「未写」可区分**（按 worker 声明方案：**恒写块**） | ① 恒 Hold 真实 run ⇒ `recorded=true, total=0`，且 DB 有 `payload='[]'::jsonb` 的 fills 块（**判据：有块 = 已记录**，`total=0` = 无成交）；② 手工 `chunked_v1` 行**无 fills 块** ⇒ `recorded=false, total=0` = **未写**；`assert_ne!(recorded)` 成立 | PASS |
| **元素字段 == `EngineEvent::Fill`** | 每元素对象键集合**恰为** `{type,bar_index,ts,side,qty,price,reason}`（7 键，无多余）；`type=="fill"`；`side ∈ {Buy,Sell}`；`qty/price>0`；`reason` 非空；`ts` == 对应 bar ts（`ts[bar_index]`，并与 `/bars?kind=per_bar[bar_index].ts` **逐一相等**） | PASS |
| **legacy 双读派生** | 手工 `legacy_single` 行内联 per_bar（2 个 fill + 1 个 log） ⇒ `recorded=true,total=2`（跳过非 fill）、`ts` 取所属 per_bar 记录 ts、`strategy_run_bars` **零行**（不回填） | PASS |
| **反向防误用** | `/curve?kind=fills`、`/curve?kind=fills&k=10`、`/bars?kind=fills` 均 **400**，body `{"error":"kind 须为 per_bar/net_value/drawdown（fills 请用专用端点 /fills）"}`（同时含 `fills` 与 `/fills`）；对照 4 条合法 kind 路径均 200 | PASS |
| 未成功 run / 未知 run | 未知 run ⇒ 404；`result_fills` 先 `get_run` 再要求结果行 | PASS |

---

# 3. ③ 【决定性】为什么「不用 trades / 不抽样」有实证

## 3.1 构造（含「部分买入 + 部分卖出」的真实 run）

夹具（确定性，无随机）：M1 价格路径 `[100×6, 150,175,200, 200…]`（30 根）+ 判别插件
`bar 0..=5 Buy(80) → bar 6..=8 Hold(50，解冻) → bar ≥9 Buy(80)` + `LumpSum position_pct=0.5`。
bar 9 的 Buy 在**更高净值**上重新快照 ⇒ 目标 374.94 < 当前 500 ⇒ 引擎发出**一笔 Policy 的部分卖出**（未清仓）。

## 3.2 两侧原始输出（`08_fills_indep_run1.txt`）

```
[probe] /fills total=3 records=[
  { "bar_index": 1,  "price": 100.02, "qty": 500.0,           "reason": "Policy",     "side": "Buy",  "ts": 1788917460, "type": "fill" },
  { "bar_index": 10, "price": 199.96, "qty": 125.05625624999999, "reason": "Policy",  "side": "Sell", "ts": 1788918000, "type": "fill" },
  { "bar_index": 29, "price": 199.96, "qty": 374.94374375,    "reason": "ForceClose", "side": "Sell", "ts": 1788919140, "type": "fill" }
]
[probe] /result trades n=1 [
  { "open_bar": 1, "close_bar": 29, "open_price": 100.02, "close_price": 199.96,
    "shares": 374.94374375, "hold_bars": 28, "pnl": 37406.271968812354, ... }
]
```

## 3.3 断言与结论

| 断言 | 实测 | 结论 |
|---|---|---|
| ① 部分买入（`position_pct<1`）在 `/fills` | 买入累计 **500 股**（全仓 @100 应为 1000） | 成立 |
| ② 一次部分卖出（未清仓）在 `/fills` | bar **10**（< n-1=29，非期末强平）、`reason=Policy`、`qty=125.06 < 累计买入 500` | 成立 |
| `trades` **不含**该部分卖出 | `trades.len()=1 != fills.len()=3`；`close_bar` 无 10；唯一 trade 的 `shares=374.94 < 累计买入 500`（只记「剩余仓位」的完整往返） | 成立 |
| 该部分卖出是**引擎事实**（非读侧伪造） | `per_bar[10].events` 含同一笔 `fill/Sell/qty=125.05625624999999` | 成立 |

> **结论**：`/fills` 是**有界精确源**（单块、20000 上限、分页），而 `trades`（`TradeDetail` 仅在**完全平仓**时合成）
> 会**系统性漏掉**部分买入/加仓（DCA、`position_pct<1`）与部分卖出 ⇒ 用 `trades` 当 K 线买卖标记源会**漏标记**（误导）。
> **真实 app 实例上的同型证据**（7953 bar run）：`fills: total=200` vs `result.trades_n=100`（证据 `17_render_seed.txt`）。

---

# 4. ④ 写路径语义（回归）

原始输出：`09_writepath.txt`（6 passed / 0 failed）、`07_existing_tester_writepath.txt`。
`InjectStore`（外包真实 `PgStrategyRunStore`，逐方法透传）三个注入点：`fail_at` / `fail_kind(Fills)` / `cancel_at`。

| 判据 | 实测 | 结论 |
|---|---|---|
| **分块先于 `mark_succeeded`（含 fills）** | `fail_kind(Fills)`：`status=failed`、`error="结果分块落库失败: [tester 注入] kind=Fills 的 append_result_chunk 强制失败"`、**`get_result` 为 Err（无结果行）**、`result_chunk_count(Fills)=0` 而 per_bar 块已写出 3 块 | PASS |
| 写失败 ⇒ `failed` | `fail_at=1`：`failed`/per_bar chunks=0；`fail_at=2`：`failed`/chunks=1；均**不落 succeeded**、无结果行 | PASS |
| 取消 ⇒ `canceled`（不落 succeeded） | `cancel_at=1`（分块已写后 DB 侧落 canceled）：`status=canceled`、无结果行、已写分块保留；协作式取消：`canceled`，不落 succeeded | PASS |
| `seq` 单调、`ts_from/to` 正确 | 成功路径 per_bar 3 块 seq=[0,1,2]、`ts_from/ts_to` 与喂入 bar 首末逐值对齐；**fills 单块 seq=0、`ts_from`=首根 bar ts、`ts_to`=末根 bar ts、payload 非空** | PASS |

---

# 5. ⑤ 前端契约消费（缺口是否闭合）

## 5.1 缺口 grep 重跑（P4 报告里命中 0 的项）

原始输出：`10_frontend_gap_grep.txt`（命令：`grep -rn --include='*.ts' --include='*.tsx' <k> src/`）。

```
has_more=34   next_offset=30   downsampled=37   original_bars=22
result_format=18   bars_total=4   chunk_count=2   recorded=20
URL: runs/${=7   /brief=7   /bars=27   /curve=27   /fills=20
api/client.ts 真实端点（节选）：
  539  getWorkbenchResult  → /result
  541  getWorkbenchBrief   → /brief
  551  getWorkbenchBars    → /bars（offset/limit 或 from/to）
  558  getWorkbenchCurve   → /curve（downsampled/original_bars 必带）
  567  getWorkbenchFills   → /fills
```

> **对照 P4 验收证据 `251/13_frontend_gap.txt` 的 0 命中**：全部条目现均**非 0** ⇒ **P4 的硬门槛「前端零消费」已闭合**。

## 5.2 单一取数入口 + 4 类消费者（文件与调用点）

原始输出：`11_single_fetch_entry.txt`。

- **入口**：`web/src/features/workbench/useRunSeries.ts`（`export function useRunSeries` L137；chunked 分支 L175–179 并行取 `/bars`+`/fills`+3×`/curve`；`loadMore` L233 消费 `next_offset`；`jumpToRange` L256 走 `from&to`）。
- **唯一调用点**：`ResultView.tsx:123 const series = useRunSeries({ api, run, result })`；**非测试代码**中只有 `ResultView.tsx` 取值使用该 hook（`PerBarTable.tsx:4`/`KlineResultChart.tsx:8` 仅 `import type` 取类型；其余命中均为 `*.test.ts(x)`）。
- **4 类消费者**（全部从 `series` 取数）：
  1. 曲线：`AggregateScoreChart`（`ResultView.tsx:189-191`）、`SlotScoresChart`（195-197）、`EquityDrawdownChart`（201-204，含 `sampling` 标注）；
  2. 明细表：`PerBarTable`（226-231，`bars={series.bars}` + `onLoadMore` + `onJumpRange` + `onResetRange`）;
  3. K线标记：`KlineResultChart`（167，`fills={series.fills}`）；
  4. 事件日志：`EventLog`（235-241，`perBar={series.bars.rows}` + `total` + `hasMore` + `onLoadMore`）。
- **无第二处结果端点直调**：`getWorkbench{Result,Bars,Curve,Fills,Brief}` 的非测试调用点 = `api/client.ts`（定义）+ `useRunSeries.ts`（唯一取数）+ `store.ts:269`（`loadResult`：取 `/result` 兼容载荷，符合 P6 §2 取数路径对照）。

## 5.3 K 线买卖标记来自 `/fills`（不是 `result.per_bar`、不是 `trades`）

`KlineResultChart.tsx`：L21 `export function buildMarkers(fills: WorkbenchRunFill[])`；L69 `useMemo(() => buildMarkers(fills.rows), [fills.rows])`；
L79-91 显式标注「成交 N 笔（精确源 /fills…）」，`recorded=false` 时显式提示（`wb-fills-note`）。
文件头注释 L17-19 明确「不用抽样 per_bar、不用 `trades`（会漏标记）」。
**真渲染实测**（§6）：`成交 200 笔（精确源 /fills）`，且网络面确实命中 `/fills`（1 次），未命中任何 `trades` 端点。

## 5.4 事件日志走 `/bars` 分页 + 覆盖提示 + 区间跳读（不抽样）

`EventLog.tsx`：L69 `共 N 条 · 覆盖 已加载 {perBar.length} / 共 {total} 根 bar` + L71 `range ? （区间读 from ~ to）`；
L72-84 `hasMore` ⇒ 「加载更多」（`data-testid="wb-event-log-load-more"` L79）（`onLoadMore`，即 `series.loadMore` ⇒ `/bars` 分页，**不抽样**）。

## 5.5 长区间不得静默截断 + **反向对照**

- 正向（真渲染，§6）：7953 根 chunked ⇒ 首屏 `已加载 5000 / 共 7953`、`未加载 2953 根` + 加载入口；点一次拉满 7953 后提示消失。
- jsdom 正向（全量 vitest 绿）：`ResultView.test.tsx` 「P6-关键：长区间（12000 根 chunked）不得静默截断」。
- **反向对照（必红）**：`useRunSeries.ts` 的 chunked 首页改成 `hasMore:false` / `nextOffset:null`（= 忽略 `has_more`）⇒ 同一用例 **1 failed**
  （`Unable to find an element by: [data-testid="wb-perbar-more-note"]`）；**逐字节还原**（`sha256sum -c` OK，`05be06ff…`）后复跑 **1 passed**。原始输出：`14_frontend_reverse_hasmore.txt`。

## 5.6 `legacy_single` 零回归

- `useRunSeries.ts` L119 `legacySeries(result)`：legacy 走**内联列同步派生、零网络**；`fills` 由内联 `fill` 事件派生（L130 `fillsFromPerBar`）。
- 用例在跑：`ResultView.test.tsx`「legacy_single 路径零回归：从 /result 内联列同步派生，且不请求 /curve」、
  `useRunSeries.test.ts`「legacy 零网络同步派生」；前端全量 864 例绿（`12`/`28`）。

---

# 6. ⑥ 真渲染（P6 门禁）

## 6.1 环境（未做生产写入）

- 临时库 `tmp_p4p6_20260918151821`（27 条迁移，含 0027；`kind` CHECK 实测含 `'fills'`）；
- 第二 app 实例：`./target/debug/eestock-app --config /tmp/app_p4p6.toml`，`listen=127.0.0.1:18083`、`mcp_listen=127.0.0.1:18084`、`static_dir=<repo>/web/dist`；
  启动日志 `schema self-check ok`（`EXPECTED_RELATIONS` 含 `strategy_run_bars` 通过）；`/healthz` = `{"status":"ok"}`。
- 真实 run：518880 M1 `2026-08-01 → 2026-09-17` ⇒ **7953 bar**、`result_format=chunked_v1`、`chunk_count=2`、`fills.total=200`、`trades=100`、`curve original_bars=7953 downsampled=true`（证据 `17`）。

## 6.2 Playwright 断言（14/14 PASS，`RENDER_PASS`）

原始输出：`18_render_playwright.txt`、`18_render_summary.json`、截图 `18_render_workbench_result.png`。

```
[render] PASS 结果页标题可见
[render] PASS 总分曲线标注「共 N bar」            （共 7953 bar）
[render] PASS 净值曲线标注「共 N bar」
[render] PASS 服务端抽样标注可读
[render] PASS K线成交笔数来自 /fills（精确源）      （成交 200 笔（精确源 /fills））
[render] PASS 长区间出现 has_more 覆盖提示          （还有更多：已加载 5000 / 共 7953 根（未加载 2953 根））
[render] PASS 提示含未加载根数
[render] PASS 首屏只渲染 5000 行（未静默全量）
[render] PASS 加载更多后拉满 7953 且提示消失
[render] PASS 事件日志覆盖范围显式标注              （共 200 条 · 覆盖 已加载 7953 / 共 7953 根 bar）
[render] 网络命中 {"curve":3,"bars":2,"fills":1,"result":1}
[render] PASS 页面真实调用 /curve
[render] PASS 页面真实调用 /bars?kind=per_bar
[render] PASS 页面真实调用 /fills
[render] PASS 无 console 错误
RENDER_PASS
```

**真渲染反向对照**（`19_render_neg_abort_fills.txt`）：`page.route('**/fills*', abort)` ⇒
出现 `wb-fills-error`=`成交明细加载失败：Failed to fetch`，且成功文案「成交 200 笔」消失 ⇒ 断言**非空转**。

## 6.3 未做（如实标注）

未跑生产容器上的 `web/e2e/*.e2e.ts` 全量视觉回归（需生产 app 容器 + 真库）；本次真渲染只覆盖**工作台结果页**（长区间/抽样标注/标记来自 fills），未覆盖周期选择器等其他页面。**残留风险**：`/fills` 在真实网络异常下的降级仅以「显式报错」呈现（已验证），未验证重试按钮行为（P6 未实现重试，属已知范围）。

---

# 7. ⑦ 回归与范围

原始输出：`20`–`29`。

## 7.1 后端

```
$ cargo test -p storage -p application -p web -p mcp          （临时库）
  suites=64  passed=498  failed=0  ignored=0   FAILED 行 0 条  panic 0 条   EXIT=0
$ cargo check --workspace --all-targets                        EXIT=0
$ ./scripts/check-tangle.sh                                    green EXIT=0
$ cargo test -p application --test workbench p4b_run_summary_counters_are_self_consistent
  test p4b_run_summary_counters_are_self_consistent ... ok     （P4b 仪表在位）
```

P4b 仪表符号复核（`29_p4b_instrumentation.txt`）：`P4B_GLOBAL`(L1426)、`P4bRunCounters`(L1384)、`P4bGlobalCounters`(L1405)、
`p4b.run_summary`(L1845)、`permit_hold_us`(L1392)、`p4b.segment`(L495/516)、`progress_frames_produced`(L1789)、`chunk_writes`(L1546) 全在位。

## 7.2 前端

```
$ npx vitest run      → Test Files 90 passed (90) / Tests 864 passed (864)   EXIT=0
$ npx tsc -b          → EXIT=0
$ npx vite build      → ✓ built in 1.93s                                     EXIT=0
```

用例数不减：P4 基线 89 files/850 → 现 **90 files/864**（净 +14，与 worker 自报一致）。

## 7.3 范围分类（`git diff --cached --name-only`，217 条）

| 类别 | 数量 | 说明 |
|---|---|---|
| P4+P6 共有路径 | 11 | `crates/{application,domain,storage,web}/*`、`design/{02-domain,04-storage,07-app-plane}/**`、`migrations/0027` |
| 仅 P4 自述路径 | 6 | `mcp/src/tools.rs`、`storage/src/{workbench,migrate_check}.rs`、`application/tests/simlive.rs`、`design/04-storage/03-raw-writer.md`、`design/07-app-plane/01-mcp.md` |
| 仅 P6 自述路径 | 16 | `web/src/api/*`、`web/src/features/workbench/{useRunSeries,ResultView,PerBarTable,EventLog,KlineResultChart,AggregateScoreChart,SlotScoresChart,EquityDrawdownChart,ComparePanel}*` |
| `design/16-backtest-scalability/**` | 5 | **架构师所有**（见 7.4） |
| 其它车道/历史批 | 32 | `bar_map`/`simlive`/`strategy`/`backtest`/`strategy-core`/`strategy-runtime`/`web/features/{backtest,strategies}` 等（P0/P2/P2b/P2c/30m 车道） |
| coder 证据/报告 | 147 | `coder/**` |

## 7.4 `design/16-backtest-scalability/**` 的归属（**非 worker 改动**）

原始输出：`25_design16_attribution.txt`。

- worker 自述路径中**没有任何** `design/16-backtest-scalability/**`（P4 §6 / P6 §0.1 均声明只读该目录）。
- 工作区 vs index 的差异（**未 stage**）恰好就是架构师的 P6 回填，且**全是契约文本**：
  - `02-spec.md`：`ResultKind { …, Fills }`、0027 `kind` CHECK 加 `'fills'`、§3.2 新增 `/fills` 行（**+3/-2**，`git diff --numstat`）；
  - `04-implementation-plan.md`：P4「✅ 已冻结」+ **「🚫 上线硬门槛：0027 + P4 不得单独上线」** + P2b/P2c 冻结标记（**+16/-3**）。
- 时间线吻合：`04-implementation-plan.md` mtime 14:53、`02-spec.md` mtime **14:57**，早于 P6 worker 报告 mtime **15:15**；
  P4 worker 报告 mtime 14:35。⇒ 与「架构师在 P4 验收后回填契约、worker 随后实现」的叙述一致。
- **⚠ 冻结注意**：`git status` 为 `AM`（index 有、工作区再改）⇒ `git diff --cached` 的 `02-spec` **grep fills = 0**，
  即**当前 index 快照不含 fills 契约**（= 0.2 节 F2）。

## 7.5 纪律与收尾

```
第二 app 实例（:18083）：已停（curl 探测 port 18083 down）
活库 eestock：strategy_run_bars = <table absent>；result_format 列 = 0；今日新增 strategy_run = 0
DROP DATABASE "tmp_p4p6_20260918151821" WITH (FORCE);   → DROP DATABASE
库清单回读（非 template）：eestock / postgres           残留计数 = 0
生产源码未被 tester 改动：useRunSeries.ts=05be06ff…（与 worker 自报还原态一致）、
                        application/src/workbench.rs=41ae267f…、ports.rs=535c9e72…
core dump：ulimit -c 0，无 core 文件
```

> 说明：本轮所有「真实 run」都写入**临时库**（第二实例），活库**零写**；临时库已 `DROP … WITH (FORCE)` 并回读为 0。
> 另：环境里另有一个**既存**的 dev app 实例（`--config /tmp/app_dev_8081.toml`，端口 8081）**未被本轮触碰**。

---

# 8. 未过项 / 非阻塞发现（4 条）

| ID | 类别 | 内容 | 阻塞冻结？ | 阻塞上线？ | 建议 |
|---|---|---|---|---|---|
| **F1** | 契约文档口径 | `/fills` 响应是 **02-spec §3.2 的超集**：实现回 `{run_id,total,offset,limit,has_more,next_offset,recorded,fills}`，而 spec 该行文字只写「响应含 `total`」（worker §1.4 已请裁定）。字段为**纯加法**，旧消费方忽略无碍；P6 前端显式消费 `recorded`（「无成交 vs 未写」的判据） | 否 | 否 | 架构师二选一：① 回填 02-spec §3.2 补 `has_more/next_offset/recorded`（推荐，因 `recorded` 承载语义）；② 裁定收敛为 4 字段（则前端改由 `offset+limit vs total` 自算，**并需重跑 P6 验收**） |
| **F2** | 冻结操作 | 架构师 P6 契约回填（`kind` 含 `'fills'`、`ResultKind::Fills`、§3.2 `/fills` 行、上线硬门槛）**只在工作区、未 stage**；`git diff --cached` 的 02-spec 不含 `fills` | **否（但冻结时会冻错内容）** | 否 | 冻结/提交时把 `design/16-backtest-scalability/{02-spec,04-implementation-plan}.md` 的工作区版本**一并 stage**（否则 index 快照 = 无 fills 契约） |
| **F3** | 残留语义 | `recorded=false`（P6 之前的 chunked run 无 fills 块）仅对**回滚/历史**场景可达：活库当前无 `result_format` 列 ⇒ 现网不存在任何 chunked run；P6 上线后所有新 run 恒写 fills 块 | 否 | 否 | 前端已显式提示（不静默少标记）；如需回填另立专项（读 per_bar 重建 fills 块） |
| **F4** | 性能/实现 | `/curve` 仍**服务端全量物化后抽样**（P4 §7.3 已知）；P6 前端按「有界响应」消费。大 run 的服务端内存/耗时为后续专项 | 否 | 否 | 归 P4b/后续专项（分块级采样/流式抽样） |

**崩溃 / core dump：无。**

---

# 9. 结论（复述）

1. **P4 重验：PASS**（迁移 0027 修正版逐字对齐且可复算；`/fills` 未破坏既有端点/写路径/双读；P4b 仪表在位；四 crate 回归 0 失败）。
2. **P6：PASS**（`/fills` 语义与「不用 trades/不抽样」有决定性实证；前端缺口闭合、单一取数入口、长区间反向必红、legacy 零回归；真渲染 14/14）。
3. **可一并冻结：可以**（需同时完成 F2 的 stage 动作；F1 待架构师裁定，不阻塞）。
4. **具备上线条件（迁移 0027 + P4 + P6）：具备（条件式）**——先落 0027、再重启 app、**同批部署 P6 前端**；附带 F1/F3/F4 三条非阻塞项。
