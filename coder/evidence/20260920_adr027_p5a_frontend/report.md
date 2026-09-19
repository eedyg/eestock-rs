# P5a 前台交付报告 —— 类型 v2 + L1/L2 表格与四枚按钮 + 懒加载 + 对账告警 + 取数完整性

**报告文件位置**：`coder/evidence/20260920_adr027_p5a_frontend/report.md`

**完成判词（前置）**：
**类型 v2 完成** ｜ **L1/L2 表格与四按钮 完成** ｜ **懒加载 完成** ｜ **对账告警 完成** ｜ **前端类型检查与单测 绿**
（`npx tsc -b` = 0 error；`npx vitest run` = **96 文件 / 929 用例全绿**；Rust 零改动）

---

## 0. 交付范围与本波纪律

- 车道：**前端（web/）**。**未改动任何 Rust 文件**（`git diff --cached --stat` 中 crates/migrations 条目为 P1a/P1b/P2/P3 其他车道的既有暂存内容，非本波产物）。
- 时间盒内优先级执行顺序（与派单一致）：① 类型 + mock → ② L1 表格与按钮 → ③ 懒加载 → ④ 对账告警 → ⑤ 取数完整性。

---

## 1. 逐项改动

### 1.1 类型 v2（`web/src/api/types.ts`，161 行级改动）

| 项 | 改动 |
|---|---|
| `Trade` → `RoundTrip` + `RoundTripFill` | **删除** `Trade`；新增 `RoundTrip`（02-spec §1.2 全字段：`rt_seq/code/status/open_ts/close_ts/open_bar/close_bar/shares/buy_count/sell_count/open_price/close_price/gross_value/commission/stamp_duty/pnl/hold_bars/reason/l2_count`，`close_ts/close_bar/close_price/pnl/hold_bars` 均可空语义）+ `RoundTripFill`（§1.1 `FillFact` 全字段）；新增 `RoundTripStatus = 'Open' \| 'Closed'` |
| 成交来源 | 新增 `FillReason = TradeReason \| 'Manual'`（§1.1 四值）；`WorkbenchRunFill.reason`、`RoundTrip.reason` 采用之 |
| `WorkbenchRunFill` 增字段 | `rt_seq` / `trade_value` / `commission` / `stamp_duty`（§5.4，**必填**，禁前端复算注已落类型注释） |
| `WorkbenchCurveResponse` 增字段 | `window_from_ts: number\|null` / `window_to_ts: number\|null` / `window_bars: number`；`kind` 由 `string` 收窄为 `CurveKind = 'per_bar'\|'net_value'\|'drawdown'\|'position'`；新增 `WorkbenchPositionPoint`（§4.1 点形状） |
| `WorkbenchRunResult.trades` | 类型由 `Trade[]` → `RoundTrip[]`（§5.1 v2 形状） |
| `WorkbenchRunAudit` 增字段 | `round_trips_closed` / `round_trips_open` / `rt_reconcile { checked, mismatched, tolerance }`（§5.5） |
| 新增端点 DTO | `WorkbenchRoundTripsResponse`（§5.2）、`WorkbenchRoundTripFillsResponse`（§5.3，`rt_seq` 回声 + `total/has_more/next_offset`） |
| `WorkbenchEngineEvent`（`fill` 分支） | 增 `rt_seq` / `trade_value` / `commission` / `stamp_duty`：per_bar 事件本就是引擎成交事实的投影（ADR-027 D4），legacy 内联路径由此与 `/fills` 同源同口径、无下游复算 |

**API 客户端**（`web/src/api/client.ts`）：新增 `getWorkbenchRoundTrips(id, {offset,limit})` 与 `getWorkbenchRoundTripFills(id, rtSeq, {offset,limit})`；`WorkbenchCurveQuery` 类型抽出（`kind`/`k`/**可选** `from_ts`/`to_ts` 透传 = P5b 窗口插座，缺省不传 ⇒ 全区间向后兼容）。

### 1.2 mock 契约 v2（`web/src/api/mock.ts`，344 行级改动）

- **事实源改造**：`mockWorkbenchResult` 在成交时刻同时写 ① **L2 事实账本**（`fills`：`rt_seq` + 费用三件套 + `bar_index` + `ts`）② per_bar `fill` 事件 ③ **持仓序列** `position`（§4.1，`position_value + cash == nav`）。撮合点按 ADR-027 D6 分配 `rt_seq`（买入且无持仓 ⇒ 新序号；清仓 ⇒ 终结）。
- **L1 由账本派生**：新增 `aggregateRoundTrips(fills)`（镜像后端唯一实现 `backtest::aggregate_round_trips`，02-spec §2 口径；**同序累加** ⇒ `Σ(L2) == L1` 浮点逐位成立）。`/result.trades` 即该派生结果。
- 新端点：`/round-trips`（缺省页大 `ROUND_TRIPS_PAGE_DEFAULT = 200`，`recorded/has_more/next_offset` 齐备）、`/round-trips/{rt_seq}/fills`（**未知 rt_seq ⇒ 404**，禁空数组冒充）；`/fills` 元素增 `rt_seq` + 费用三件套（由账本投影，不再从 per_bar 复算）。
- `/audit` 增 `round_trips_closed/open` 与 `rt_reconcile`（mock 的 L1 由账本派生 ⇒ `mismatched` 恒空；不一致场景由测试注入以验证 UI 必告警）。
- `/curve`：`window_from_ts/window_to_ts/window_bars` 回显（缺省 = null / 全区间）；`kind=position` 返回持仓序列；`from_ts/to_ts` 给定时窗口内**重新采样**（mock 侧契约镜像；窗口状态机仍属 P5b）。
- 旧 v1 形状已同步清理（`Trade` 引用、`fillsOf` 仍导出但已透传四字段；种子 legacy run 仍保留「历史 run 无 `reason`」语义 ⇒ 来源列显「未记录」）。

### 1.3 交易明细 Tab：L1 一层 + 四枚按钮（新文件 `web/src/features/workbench/RoundTripsTable.tsx`，442 行）

- **默认只渲染 L1 一层**；L1 行两枚按钮：`[明细]`（`data-testid="wb-rt-detail-{rt_seq}"`，自带 `aria-expanded` + `aria-controls`）/ `[跳转]`（`wb-rt-jump-{rt_seq}`）；L2 行两枚：`wb-l2-detail-{rt_seq}-{i}`（同带 `aria-expanded`）/ `wb-l2-jump-{rt_seq}-{i}`。
- **取消隐式整行点击**：`<tr>` 无 `onClick`，展开/跳转仅由显式按钮触发（含用例断言「点击行内文本不展开」）。
- L1 摘要列：`成交 {l2_count} 笔（买 {buy_count} / 卖 {sell_count}）`（D8 懒加载摘要）；状态列区分 `Closed`/`Open`；`close_*`/`pnl` 为空时显 `—`（不造 0）。
- **跳转本波只做事件派发**：`ResultView` 新增可选 `onJump?: (target: JumpTarget) => void`（`{level:'L1', rt_seq, code, open_bar, close_bar}` / `{level:'L2', rt_seq, code, bar_index}`）；**未触碰 K 线实例**。
- 窄屏横向滚动（`overflow-auto`）、允许多条同时展开、展开态会话内保留（组件 state）。

### 1.4 懒加载（`web/src/features/workbench/useRunSeries.ts`，212 行级改动）

- 取数**单一入口**不变（仍是 `useRunSeries`）：新增 `roundTrips`（L1 列表）、`l2: Record<rt_seq, RunL2State>`、`ensureL2(rtSeq)`、`loadMoreRoundTrips()`。
- `ensureL2` **只**在 `[明细]` 展开时调用；已取过的回合（同 run）复用缓存 ⇒ 收起再展开**不重复请求**。**展开前零 L2 请求**（F2 正向断言 `l2Spy` 未被调用）。
- L2 按 `{offset, limit}`（`L2_PAGE_SIZE = 500`）**续拉至 `has_more=false`**；`L2_MAX_PAGES = 40` 护栏超限 ⇒ `truncated=true` 显式披露（绝不静默截断）。
- 失败 ⇒ 显式错误态 + 可重试（失败不写缓存）。
- legacy（`legacy_single`）run 保持既有零回归：L1 仍直接取 `/result.trades` 内联列（零网络），L2 同样懒加载。

### 1.5 L2 明细字段详情 + 双口径 + 累计列（新文件 `roundTripAccum.ts` + RoundTripsTable 内 `L2Fields`）

- L2 行常显：`bar/时间/方向/股数/价格/trade_value/commission/stamp_duty/累计佣金/累计印花税/累计盈亏/来源 + [明细][跳转]`。
- 末行带 `data-last-row="true"`（累计 == L1 的锚点）。
- L2 `[明细]` 展开该笔完整字段：`rt_seq/code/bar_index/ts/side/qty/price/trade_value/commission/stamp_duty/reason` + **双口径均价**（`avg_price_excl_fee（不含费，= 累计成交额/累计股数）`、`avg_cost_incl_fee（含费，对账口径）`，**标签必带限定词**）+ `cum_commission/cum_stamp_duty/cum_realized_pnl`。
- 口径公式（`roundTripAccum.ts` 文件头冻结；按侧累计、逐笔同序、**无 FIFO/lot 归属**）：
  - `avg_price_excl_fee` = 该侧 `Σ trade_value / Σ qty`（与 L1 `open_price`/`close_price` 同口径）；
  - `avg_cost_incl_fee`：买入侧 `Σ(trade_value+commission)/Σqty`；卖出侧 `Σ(trade_value−commission−stamp_duty)/Σqty`；
  - `cum_commission` / `cum_stamp_duty` = 该回合逐笔顺序累加；
  - `cum_realized_pnl` = 现金流差逐笔累计（买 `−(v+c)`、卖 `+(v−c−s)`）⇒ **末行 == L1 `pnl`**。

### 1.6 对账告警（ADR-027 D10 强制失败态）

- 展开区**顶部**（L2 表之前）渲染 `role="alert" data-testid="wb-rt-reconcile-{rt_seq}"`，条件 = `reconcileRoundTrip(...).ok === false`（逐字段超容差）**或** 后端 `/audit.rt_reconcile.mismatched` 命中该 `rt_seq`。
- 告警内容：逐字段 `key：L1 {x} ｜ 累计 {y} ｜ Δ {|y−x|}`（Δ 必须显式）；audit 命中时追加 `audit rt_reconcile.mismatched 报该回合不一致（rt_seq N）`。
- **冻结两侧数值**：不修改、不替换任何一侧（L1 行仍渲染接口原值，L2 累计行仍渲染累加值），**不按 L1 静默渲染**。末行与 L1 字符串相等由同一格式化器（`fmtNum`）保证可断言。
- 容差 = `/audit.rt_reconcile.tolerance`（audit 未落地时回退 1e-6），相对口径 `tol × max(1, |L1|)`；`pnl` 对 `Open` 回合为 null ⇒ 不参与判定。

### 1.7 取数完整性（ADR-027 D11）

- `useRunSeries` 的 `/fills`（K 线买卖标记唯一事实源）由「只取 5000 首页」改为 **`fetchAllFills` 分页拉全**（首页保持既有调用形状 `{limit: 5000}`，后续页按 `next_offset` 续拉；`FILLS_MAX_PAGES = 40` 护栏 ⇒ `truncated` 显式披露）。
- `KlineResultChart` 披露改为常显：`成交合计 {total} 笔（精确源 /fills，已加载 {rows.length} / 共 {total}）`，触达护栏时追加「标记不全」。
- `RunFillsState` 新增 `complete` / `truncated`；`RunRoundTripsState` 亦按完整性契约提供 `total/recorded/has_more/next_offset` 并在 UI 显式披露「已加载 N / 共 M 条回合」+ `wb-rt-load-more` 消费入口。
- L2 覆盖披露：`wb-l2-coverage-{rt_seq}` = `L2 已加载 N / 共 M 笔`。

---

## 2. 测试与证据

### 2.1 新增用例

| 文件 | 用例 |
|---|---|
| `web/src/features/workbench/roundTripLayers.test.tsx`（**新增，414 行，6 例**） | **F1** 默认一层 + 展开/收起 + `aria-expanded` + 取消隐式行点击 + 两枚 L1 按钮事件派发；**F2** 展开前零 L2 请求 / 按 `rt_seq` 请求 / `next_offset` 续拉 / 收起再展开复用；**F3** L2 `[明细]` 双口径均价 + 费用三件套 + `cum_*`；**F5** `cum_*` 末行 == L1 逐字段（**字符串相等**）+ 干净回合无告警；**F4** 累加不一致告警（含 Δ 与两侧冻结）/ audit `mismatched` 非空同样告警；**F12** 成交 > 首页 ⇒ 分页拉全 + 披露总量/已加载量 |
| `web/src/features/workbench/roundTripAccum.test.ts`（**新增，5 例**） | 纯函数层锁定：逐笔双口径公式、`cum_*` 与 L1 同值、注入偏差 ⇒ 逐字段 Δ 与 `mismatched`、拉取不全 ⇒ `l2_count` 告警、audit 命中 ⇒ 结论为不一致（即便两侧数值相等）、格式化精度 |
| `web/src/api/mock.test.ts`（**+1 例**） | mock 契约：`/round-trips` 摘要与分页、`/round-trips/{rt_seq}/fills` 归属与 **未知 rt_seq 404**、**I2 恒等式**（Σ(L2) 逐字段 == L1，浮点逐位）、`/fills` 新四字段、`/audit` 增量、`/curve` 窗口回显 + `kind=position` 恒等式（`position_value+cash==nav`） |

### 2.2 既有用例更新（禁「假绿」）

- `ResultView.test.tsx`：`Trade` → `RoundTrip`（含 `rt_seq/status/buy_count/sell_count/l2_count`）；`AUDIT_BASELINE` 补 `round_trips_closed/open` 与 `rt_reconcile`；表 testid `wb-trades-table` → `wb-round-trips-table`；来源列 `wb-trade-source-N` → `wb-rt-source-{rt_seq}`；`/fills` 覆盖披露文案改为新格式（并升级为断言总量/已加载量）。
- `client.test.ts`：`getRunAudit` fixture 补三新字段；新增 URL 形状断言（`/round-trips`、`/round-trips/3/fills?offset&limit`、`/curve?kind=position&k&from_ts&to_ts`）。

### 2.3 e2e 载体的选择器同步（04-implementation-plan §4 风险项：防「假绿」）

`web/e2e/adr026-audit.e2e.ts`（ADR-026 审计披露的既有真渲染载体）引用了旧表 testid，已随本波机械同步
（**仅选择器改名，无断言弱化**）：`wb-trades-table` → `wb-round-trips-table`、`wb-trade-source-N` → `wb-rt-source-{rt_seq}`、
`wb-trade-row-N` → `wb-rt-row-{rt_seq}`（共 6 处）。该套件断言表头含「来源」在新表中仍成立（新表保留来源列）。
**本波未运行 playwright**（需真实后端 + 浏览器，属 P6/E 段）；此处只保证载体不因改名而失效。

### 2.4 命令与原始输出（证据落盘同目录）

```
cd web && npx tsc -b                       # 0 error
cd web && npx vitest run                   # 96 files / 929 tests passed
```
| 证据文件 | 内容 |
|---|---|
| `10_red_p5a.txt` | TDD 红判词记录（实现前：`Test Files 1 failed (1) / Tests 6 failed (6)`） |
| `20_green_tsc.txt` | `npx tsc -b` 原始输出（空 = 0 error，exit=0） |
| `21_green_vitest_p5a.txt` | 定向 6 文件（P5a 主载体 + 受影响既有测试）：`6 passed / 142 passed`，exit=0 |
| `22_green_vitest_all.txt` | 全量 `npx vitest run`：`96 passed / 929 passed`，exit=0 |

**TDD 声明（诚实披露）**：`roundTripLayers.test.tsx` 为**先红后绿**（红判词见 `10_red_p5a.txt`，同会话实现前实测）。`roundTripAccum.test.ts` 与 `mock.test.ts` 的新增用例为**实现后补写的契约/回归测试**（首次运行即绿），非「先红」——其价值是锁定公式与 mock 契约，不构成引擎/契约变更的红证据。

---

## 3. 未做项（明确留给 P5b）与插座清单

**未做**（按派单边界，本波零实现）：
1. 窗口状态机 `ResultWindowState {from_ts,to_ts,span_bars,source,rev}`（页面级持有）、~200ms 节流、`rev` 丢旧、程序化写窗回声抑制；
2. `mapLineByTs`（`mapLine` 未动）；
3. 结果页 K 线 `onVisibleRangeChange` 回调与 `barSpaceLimit` 放宽（**未修改 `features/dashboard/KlineChart.tsx`**，避免动看板/宫格侧契约）；
4. 持仓比率视图（`/curve?kind=position` 的渲染；本波只落类型 + mock 契约）；
5. L1/L2 跳转的窗口写入与「跳转可达性校验（目标 bar 未加载先取数）」（F9/E1/E2）；
6. `sim-live` 运行中 L1/L2 读路由的 UI 接入、跨标的跳转提示（F11）。

**已预留插座**：
- `ResultView.onJump?(target: JumpTarget)` —— L1/L2 跳转唯一出口（已带 `rt_seq/code/open_bar/close_bar/bar_index`），P5b 直接接窗口状态机；
- `JumpTarget` 类型（`RoundTripsTable.tsx` 导出）；
- `client.getWorkbenchCurve({kind,k,from_ts?,to_ts?})` + `CurveKind` 含 `position`（窗口取数插座）；
- `WorkbenchCurveResponse.window_from_ts/window_to_ts/window_bars` 与 `WorkbenchPositionPoint`；
- 稳定 testid 全集：`wb-rt-row-{seq}` / `wb-rt-detail-{seq}`（`aria-expanded`）/ `wb-rt-jump-{seq}` / `wb-rt-l2-{seq}` / `wb-l2-row-{seq}-{i}`（`data-last-row`）/ `wb-l2-detail-{seq}-{i}`（`aria-expanded`）/ `wb-l2-jump-{seq}-{i}` / `wb-l2-fields-{seq}-{i}` / `wb-rt-reconcile-{seq}` / `wb-fills-note` / `wb-rt-coverage` / `wb-rt-load-more`。

---

## 4. 架构对齐与需评审点（**请架构师裁决**）

1. **分层对齐**：类型/取数/渲染三层未越界 —— `api/types.ts`（契约）→ `api/mock.ts`（契约 mock）→ `features/workbench/useRunSeries.ts`（**唯一取数入口**，未散落第二处）→ `RoundTripsTable.tsx`（纯展示）→ `roundTripAccum.ts`（纯函数口径）。取数入口的唯一性沿用 ADR-024 P6 硬约束。
2. **⚠ 需裁决（唯一新增解释项）**：ADR-027 D9 要求 L2 显示 `avg_price_excl_fee` / `avg_cost_incl_fee` / `cum_*`，但**02-spec §1.1 的 `FillFact` 与 §7 的前端类型契约都没有这些字段**。本波按「不新增后端字段、不在前端复算费用」的原则，把它们实现为**前端按 L2 事实行的逐笔累计派生**（公式见 §1.5，全量按 `rt_seq` 拉全后计算）。若 P3 后端实际新增了成本/累计字段（或 ADR-027 要求服务端出），**P5b 必须改为读服务端值**，届时本文件的公式与 `roundTripAccum.ts` 需同步删除/改写（当前实现不引入第二事实源：只对引擎事实做累加，未复算 `trade_value/commission/stamp_duty`）。
3. **L1 取数双路径**：新 run（`chunked_v1`）走 `/round-trips` 分页；旧 run（`legacy_single`）沿用 `/result.trades` 内联（零网络、零回归）。ADR-027 D3 清空历史后 legacy 路径实际不可达（保留为 P6 零回归护栏）。
4. **未触碰**任何核心接口/事件契约/层边界；未引入新依赖；未触碰 Rust；未 commit（仅 `git add`）。

---

## 5. 残留风险

1. **L2 拉全的内存/流量上限**：护栏 `L2_MAX_PAGES=40 × 500 = 20k 笔/回合`；超限时 `truncated=true` 会在对账里以 `l2_count` 字段触发告警（会与真实「对账不一致」共用一个告警框，文案已区分「触达拉取护栏」）。若真实 run 存在 > 20k 笔单回合，需 P5b 调整为分页展示 + 服务端累计值。
2. **`avg_cost_incl_fee` 卖出侧语义**是本波的解释（卖出净收入/股数）；若架构师裁定为「成本口径」，需按裁定改写并新增 ADR 注（ADR-028 §5 已禁「成本口径持仓比率」，但未禁此处）。
3. **`/curve` 窗口过滤已在 mock 实现**（P5b 的窗口状态机调用即可），但真实后端 P3 若字段/语义不同，需以真实响应为准（本波前端只透传，不改语义）。
4. `WorkbenchEngineEvent.fill` 增四字段属**前端类型增字段**（引擎事件本就应携带事实），后端 `bar_record_json` 若不含这些字段，legacy 内联路径的 `fillsFromPerBar` 会得到 `undefined` ⇒ 需 P3 对齐（新 run 走 `/fills`，不受影响）。
