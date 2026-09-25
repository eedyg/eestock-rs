# ADR-027 交易明细分层显示（L1 回合 / L2 逐笔）与回合口径统一

- 状态：**已裁决（2026-09-20，Grill 十问闭合）**，待实现
- **批次**：与 **ADR-028 同批实现**（合并为「结果载荷 v2」不兼容批次，M1）—— 两者都改 result payload / curve kinds / migrations，而本 ADR D3 已授权清空历史 ⇒ 只有**一次**清空与一次不兼容发版机会（分开做 = 清两次数据、发两次不兼容版，且中间态无用户价值）。
- 取代/影响：ADR-026 D5（`TradeDetail.reason` 保留，语义扩展）；**修订** `TradeDetail` 字段语义（非新增：`pnl/commission/stamp_duty/gross_value` 由「端点口径」改为「全回合口径」）；**修订** `engine.rs::apply_sell` 部分卖出分支的台账行为；**修订** sim-live 结算的 `TradeDetail` 合成路径；不改 `/result`、`/bars`、`/curve` 的既有形状（`trades` 元素形状有新增字段 + 语义变更，见 §2.8）
- 触发事件：交易明细无法回答「这一笔交易是怎么形成的」——DCA 分批建仓/部分卖出在 `trades` 里不可见（`TradeDetail` 仅在完全平仓时合成）、K 线标记与 `trades` 两个口径被同一 Tab 掩盖（ADR-026 触发事件 `sr_1789738328788_000005` 的同源缺陷）；用户提出「第一层完整一次交易、第二层该交易的买入卖出细则」

## 1. 背景（已核实缺口，附代码级事实）

### 1.1 事实（代码级，可直接指行）

| # | 事实 | 位置 |
|---|---|---|
| F1 | `TradeDetail` **仅在完全平仓时合成**；部分卖出只按比例摊薄成本，其 proceeds 进 `cash` 但**不进任何 trade** | `crates/strategy-core/src/engine.rs:866`（`apply_sell`）、`:896-901`（摊薄分支） |
| F2 | L1 的金额字段只覆盖**末笔卖出**：`pnl = exec.proceeds − h.cost_basis`、`commission = h.buy_commission + exec.commission`、`gross_value = exec.trade_value` | `engine.rs:877-892` |
| F3 | 绩效吃 `trades[].pnl`：`win_rate`/`profit_factor`/`avg_hold_bars`/`trade_count` | `crates/backtest/src/metrics.rs:38+`（`net_profit` 来自 nav，正确） |
| F4 | 部分卖出**可达**：步骤 7 `delta = target − current_qty`，`delta < -EPS` 即挂 `SellQty{-delta}`（LumpSum 目标下调） | `engine.rs:782-810` |
| F5 | 单 bar 可含买+卖两笔（步骤 1 执行挂单 + 步骤 2 intrabar 止损）⇒ 存在 `open_bar == close_bar` 的**零长回合**；回合间严格有序（同 bar 不可能「平仓后再开仓」） | `engine.rs:507`、`:637-666` |
| F6 | `TradeDetail` 有**两个生产者**：回测引擎 与 sim-live FIFO 配对（后者一条 lot 匹配一条 L1，`stamp_duty` 恒 `0.0`、`reason` 恒 `None`、`bar_index` 由 `ts/bar_sec` 反算） | `engine.rs:866` vs `crates/application/src/simlive.rs:1860-1925` |
| F7 | sim-live 会话**多标的**（`sim_positions` PK `(session_id, code)`），而 `TradeDetail` **无 `code` 字段**；回测单标的（`SubmitRunReq.symbol`） | `migrations/0018_sim_session.sql`、`workbench.rs:175` |
| F8 | sim-live L1 仅 `stop_session` 时物化；`sim_trades` 已逐笔落库但**无 HTTP 路由暴露** ⇒ 运行中看不到成交明细 | `simlive.rs:805`、`crates/web/src/lib.rs:48-61` |
| F9 | 撮合点**丢弃费用事实**：`commission` 与 `stamp_duty` 都算出后被合并为单个 `fee` 写出 | `crates/simlive/src/fill.rs:104-108`、`sim_trades.fee` |
| F10 | `fee.buy` 最低佣金分支 `trade_value = budget − 5.0`（**先减后除**）⇒ 由 `qty × price` **复算不保证逐位相等** | `crates/backtest/src/fee.rs:90-98` |
| F11 | 前端只取 fills 首页（`SERIES_PAGE_SIZE=5000`）且**无续拉** ⇒ 成交 >5000 时 K 线标记静默不完整 | `web/src/features/workbench/useRunSeries.ts:176`、`KlineResultChart.tsx` |

### 1.2 判据（口径层面，非 bug 判定）

- **「Σ L2 == L1」在当前 L1 定义下不可能成立**：L1 的 `gross_value/commission(卖侧)/stamp_duty` 只覆盖末笔卖出（F2），部分卖出的已实现盈亏不在任何 trade 内（F1）。⇒ 这是**口径缺陷**，不是可修可留的实现细节。
- **两侧 L1 粒度不同**（F6 + 1.1/F7）：同一段成交序列，回测算 1 笔、sim-live 算 N 笔，而两者都进同一个 `backtest::compute_metrics`（`simlive.rs:806`）⇒ `trade_count`/`win_rate` 跨侧不可比，L3「回测对比」失去意义。
- **未取证项（禁止在本 ADR 内当结论使用）**：F1+F2+F4 组合下「存在部分卖出时，`TradeDetail.pnl` 不等于该回合真实已实现盈亏（示例：成本 100/卖 50 得 60/清 50 得 55 ⇒ 真实 +15，现口径 +5）」属**代码路径推断**，**必须由 tester 先产出复现测试**方可作为实现依据（见 §5 与 `03-test-plan.md`）。本 ADR 的决策**不依赖**该推断成立：无论它成立与否，D1 的口径变更都必须做。

## 2. 决策

### 2.1 术语与层级定义（唯一口径）

- **L2 行** = **一笔成交**（ledger 事实源中的一行）：`side/qty/price/trade_value/commission/stamp_duty/reason`。
- **L1 行（回合 Round Trip）** = 持仓 `0→>0`（开仓成交）起、至 `→0`（清仓成交）止的**连续成交区间**；其金额字段 = 该区间内**所有 L2 行的加总**。
- **FIFO/lot 匹配**降级为**成本与费用归属算法**（实现细节），**不再**充当展示层结构。

### 2.2 D1｜L1 = 全回合口径（**修订既有字段语义**）

`pnl` = 该回合真实已实现盈亏（= Σ 卖出净得 − Σ 买入总成本，含部分卖出的已实现部分）；`gross_value` = Σ 卖出成交额；`commission` = Σ 买入佣金 + Σ 卖出佣金；`stamp_duty` = Σ 卖出印花税。⇒ `apply_sell` 的部分卖出分支必须进账本（不再「只摊薄、无记录」）。

### 2.3 D2｜Scope = 全域统一

回测工作台 + 在线试算 `test_run` + sim-live（结算与运行态）共用**同一回合定义**、**同一聚合实现**、**同一测试向量**。理由：三者已共用同一 `FeeModel` 与同一 8 项绩效实现，口径分叉即刻产生不可比。

### 2.4 D3｜历史数据清空（不承担兼容负担）

回测 `strategy_run`（级联 `strategy_run_result`、`strategy_run_bars`）与 sim-live 历史会话整体清空。**执行前置（用户确认 2026-09-20）**：先 `pg_dump` 归档到文件，再 `TRUNCATE`；**保表结构与迁移链**，禁止 DROP 表（迁移由 `design/04-storage/schema.md` 经 entangled tangle 生成，禁手改产物）。**未获确认前不得执行任何删除动作。**

### 2.5 D4｜费用 = 上游事实源分列（禁止下游复算）

- 回测：`EngineEvent::Fill` 与 fills 块 JSON 补 `trade_value`/`commission`/`stamp_duty`。
- sim-live：`Fill`/`SimTrade`/`sim_trades` 把合并的 `fee` **拆回** `commission` + `stamp_duty`（F9：撮合点本就算出两者，只是被丢弃）；`simlive.rs:1914` 的硬编码 `stamp_duty: 0.0` 必须修。
- **否掉「下游复算」**：F10 证明最低佣金分支不可逆 ⇒ 复算将成为第二事实源（同物异值）。`config.fee` 已按生效值落库（`workbench.rs:684`），故复算在数据上**可行**——被否掉的理由是它破坏单一事实源，不是缺数据。

### 2.6 D5｜L1 粒度 = 整仓回合（统一到回测语义）

sim-live 也按「持仓 `0→>0` 起、`→0` 止」划回合；FIFO lot 匹配下沉为费用/成本归属。`trade_count` 保持「**已清仓回合数**」语义（ADR-026 D5「不改 trade_count 语义」继续有效）。

### 2.7 D6｜归属键 = 引擎在成交时刻打 `rt_seq`（**禁止窗口推断**）

- 引擎在成交瞬间即知语义：买入时 `holding.is_none()` ⇒ 开新回合；卖出时 `qty >= h.qty` ⇒ 终结回合。**谁在事件发生时知道语义，谁就把语义写进数据。**
- `rt_seq` 为**整数序号**（per `(run|session, code)` 单调递增），L1 与每一笔 L2 携带同一 `rt_seq`。**不用 UUID**（不可排序、不便审计对比）。
- **否掉 `[open_bar, close_bar]` 窗口 join**：它依赖 F5 中**未被文档化、未被测试锁定**的不变式（含零长回合），任何引擎演进都会**静默错配**；对 sim-live 多标的还须叠加 `code` 分组。
- sim-live 侧 `FillEngine`/`SimAccount` 同步打戳。

### 2.8 D7｜L1 = ledger 的**派生视图**

`aggregate_round_trips(ledger, fee_cfg) -> Vec<RoundTrip>` 为**唯一聚合实现**（C2/DRY），两处生产者都调用它；回测侧可在 run 结束时物化并跑一致性自检，避免读时重复计算大 ledger。

- 未平仓回合以 `status = Open` 进**同一列表**（`Open`/`Closed`）；回测恒 `Closed`（保留期末强平）。
- **8 项绩效仍只吃 `Closed`**（口径不变）。
- **sim-live 不引入期末强平**（若引入即为「伪造成交」，违反 ledger 事实源纪律）；`Open` 态是对账恒等式适用边界的**显式表示**：回测侧 Σ L2 == 全部 fills 无条件成立；sim-live 侧未平仓成交不属于任何 L1，UI 必须单列披露。
- sim-live **新增运行中 L1/L2 读路由**（`sim_trades` 已逐笔落库，当前无路由暴露，F8）。

### 2.9 D8｜L2 取数 = 懒加载

L1 列表行携带摘要元数据（`rt_seq`/`l2_count`/买笔数/卖笔数/费用合计）；展开某条 L1 才按 `rt_seq` 拉该回合成交的分页切片。**否掉**全量内嵌（与「`/fills` 为禁止抽样的有界事实源」冲突）与固定 K 行截断（粒度级披露成本高于收益）。

### 2.10 D9｜L2 列集 = 双口径 + 累计列（**消歧强制**）

`avg_price_excl_fee`（= `value_basis/qty`，与 L1 `open_price` 同口径）与 `avg_cost_incl_fee`（= `cost_basis/qty`，**对账口径**）**并存，且必须带限定词**；裸用「均价」视为违约。累计列 `cum_commission`/`cum_stamp_duty`/`cum_realized_pnl` 常显，**末行累计 == 该回合 L1 对应字段** ⇒ 对账逐行可验。

**Q9b（架构默认采纳，非用户明示）**：**不引入**「成本对手方 / lot 归属」列——sim 侧有 FIFO lot 语义、回测侧无（加权平均）；要该列即须在回测引入 FIFO 重算 = 第二事实源。FIFO 归属规则写入文档即可。

### 2.11 D10｜UI 交互形态

交易明细**默认只渲染 L1 列表**；点击某条 L1 在其下方展开**缩进子列表**显示该回合 L2（懒加载，走 D8）；再次点击收起。允许多条同时展开；展开状态在会话内保留；窄屏横向滚动而不砍列。

**对账不一致的失败态（强制）**：若 `Σ L2 ≠ L1`（`recorded=false`、字段缺失、接口版本不一致、将来引擎偏差），展开区顶部**必须**出现醒目告警行（含 Δ 值）并**冻结展示两侧数值**，**不得**静默按 L1 渲染。对账校验是 D1 恒等式的守卫，列为验收项。

### 2.12 D11｜取数完整性统一契约（纳入本次范围）

任何暴露给 UI 的数据源**必须自述完整性**：`total` + `recorded` + `has_more`/`next_offset`（或显式 `truncated`），**UI 不得静默展示不完整数据**。F11（K 线标记只取 5000 首页、无续拉）纳入本次整改。

### 2.13 统一后必须补齐的字段缺口

`TradeDetail.code`（sim 多标的必需；回测填 run 的 symbol）、`reason` 的 sim 侧对应物（现恒 `None`）、`status`（`Open`/`Closed`）、**真实 `bar_index`**（禁 `ts/bar_sec` 反算）、L1 摘要元数据（`l2_count`/买卖笔数/费用合计）。

### 2.14 D12｜L2 成本归属派生列（移动加权平均，**修订 D9/Q9b**；2026-09-25 架构侧裁定）

- **触发**：用户 2026-09-25 明确要求（原话）：「交易明细 l2 中，累计盈亏的计算不太正确，另外还需要引入一个新的列“持仓成本”，还有卖出的话，需要新的列来表示卖出部分的盈亏（相对这部分卖出的盈利百分比和绝对值）。」决策权 = 用户「全权交给架构侧决策」（同日）。
- **问题定性（不是算错，是列名与口径不匹配）**：D9 的 `cum_realized_pnl` 实为**净现金流差**（买 `−(trade_value+commission)`、卖 `+(trade_value−commission−stamp_duty)`），**无成本归属** ⇒ 部分卖出 / 未平仓时该列显示的是「净投入」而非「盈亏」（买入后大额负数、卖出后回正、**不含未卖部分浮盈浮亏**）。
- **修订 Q9b（显式登记，不得静默推翻）**：Q9b 原裁定「**不引入**成本对手方 / lot 归属列」（理由：回测侧无 FIFO（加权平均），要该列即须在回测引入 FIFO 重算 = 第二事实源）。用户诉求**覆盖**「不引入」的结论；**Q9b 的担忧被显式消解**：本裁定 ① **不引入 FIFO、不引入 lot 归属**；② 口径 = **与回测侧一致的移动加权平均**；③ 实现为 L2 事实的**纯函数派生、display-only**（**不得**回灌绩效 / 对账 / 审计，也**不得**被任何计算消费）；④ 与 L1 由 **I5** 约束（见 `02-spec.md` §2 判据表：I5/I6 为 D12 新增，编号避开既有 I1–I4）。
- **新增/变更列**：
  1. 「**持仓成本**」= 该笔成交**后**持仓的**含费**移动加权单位成本（无持仓 ⇒ `—`）；
  2. 「**本笔卖出盈亏**」= 绝对值 `卖出净收入 − q_s × unit_cost(卖出前)`，百分比 `= 绝对值 / 被消耗成本`（仅卖出行，格式 `+123.45 (+2.31%)`；买出行 `—`）；
  3. 「**累计已实现盈亏**」= 已实现逐笔累加（**买出行不得再显示负值**）；
  4. 原「累计盈亏」**改名**「累计净现金流」（算法一字不改，保留与 L1 的对账可见性）。
- **递推定义（含费口径，以 L2 事实字段为准，禁复算）**：买入 `qty += q`、`cost_total += trade_value + commission`、`unit_cost = cost_total / qty`；卖出 `consumed = q_s × unit_cost`（**unit_cost 不因部分卖出而改变**）、`qty −= q_s`、`cost_total −= consumed`；卖出净收入 `= trade_value − commission − stamp_duty`。
- **为什么不是 FIFO**：① FIFO 使持仓成本在部分卖出时**跳到较晚批次成本**（用户会看到“莫名跳变”）；② FIFO 需回测侧 lot 重算 ⇒ 正是 Q9b 所忌的**第二事实源**；③ 移动加权平均在部分卖出后**持仓成本不变**，是 A 股券商「持仓成本价」通行口径，且与回测侧加权平均语义同源。
- **恒等式**：**I2**（`Σ(L2 事实字段) == L1`）输入不变（本批不改事实字段）；**I5**（新增，见 `02-spec.md` §2）：`status='Closed'` 且**全平**的回合 ⇒ **末笔「累计已实现盈亏」== L1 `pnl`**（容差 = 既有 `rt_reconcile.tolerance` 相对口径；不成立必须显式解释，**禁**放宽容差）；**I6**（新增；2026-09-26 由独立复验**更正字面口径**）：① 首笔卖出前的所有买入行 `cum_realized_pnl === 0`；② 买入**不改变**累计值（买入行值 == 其前一笔卖出行值）⇒ 首笔卖出后的买入行**可正可负**（原「不得为负」已作废，活库 6 条为负、94 条为正）。
- **硬约束**：单一实现（`web/src/features/workbench/roundTripAccum.ts` 纯函数，L2 表共用）；**禁改** `crates/backtest/src/round_trip.rs`、`FillFact`、`/fills` 形状、audit 对账输入、`reconcileRoundTrip` 输入；**字段名必须消歧**（`cum_realized_pnl` 与净现金流语义冲突 ⇒ 净现金流另名，或新名给已实现）；**判据须有鉴别力**（「部分卖出后持仓成本不变」可区分 FIFO 与均价）。
- **产出物**：`design/17-trade-detail-layering/09-plan-result-axis-readout-and-l2-cost-attribution.md` §4；实现 = `roundTripAccum.ts` + `RoundTripsTable.tsx`；测试 = `roundTripAccum.test.ts`（扩展）+ 新 e2e `adr027-d12-l2-cost-attribution.e2e.ts`。

## 3. 影响与代价（须在实现前披露）

1. **绩效口径变更**：D1 生效后 `win_rate`/`profit_factor`/`avg_hold_bars` 的取值会变（`net_profit`/`max_drawdown`/`sharpe` 来自 nav，不受影响）。凡引用旧结论者须重跑比对；这也是 D3 清空历史的前提。
2. **跨侧可比性重置**：sim-live 的 `trade_count` 语义由「lot 匹配数」变为「已清仓回合数」⇒ 既有会话结论不可比（D3 同步清空）。
3. **ABI/jsonb 变更**：`EngineEvent::Fill`、fills 块 JSON、`TradeDetail`（新增字段 + 语义变更）、`sim_trades`（费用拆列）；无历史兼容负担（D3）。
4. **观测性**：`rt_seq` 落地后，审计三方自洽从「总数级」升级为**逐回合级**（见 §4）。
5. **文档责任**：`design/07-app-plane/00-web-api.md`、`01-mcp.md`、`design/08-backtest/01-engine-adr.md`、`design/11-sim-live/01-adr.md`、`design/12-strategy-system/01-adr.md`（§13.4/§13.5）、`web/src/api/types.ts` 的口径注需同步修订；schema 变更走 `design/04-storage/schema.md` tangle。

## 4. 验收口径

1. **逐回合三方自洽**：`distinct(rt_seq) == trades.len() == audit.round_trips_total`；且以 `reason=ForceClose` 终结的回合数 == `audit.round_trips_force_closed`。
2. **对账恒等式**：回测侧 `Σ(L2) == L1`（字段级，含费用）；sim-live 侧对**已清仓回合**同样成立，未平仓成交有独立披露位且不计入绩效。
3. **零长回合**（F5）正确归属：`open_bar == close_bar` 的回合，其 L1 的 `l2_count == 2`。
4. **复现测试先行**：`03-test-plan.md` 中的复现用例必须先红后绿（TDD 纪律），无失败测试不得改引擎。
5. **两侧一致性**：共享测试向量下，回测与 sim-live 对同一成交序列产出**逐字段相同**的 L1/L2。

## 5. 明确不做（登记技术债）

- 不引入「成本对手方 / lot 归属」列（§2.10 Q9b）。
- 不对 sim-live 引入期末强平（§2.8）。
- 不做历史数据回填/迁移读双写（D3 选择清空而非兼容）。
- 不改 `net_profit`/`max_drawdown`/`sharpe` 的算法（源自 nav）。

## 6. 关联与产出物

- **关联**：**ADR-028**（同批次：持仓比率序列、结果页时间窗联动、L1/L2 跳转定位；本 ADR 是其契约前提）、ADR-024 P6（`/fills` 为成交事实源）、ADR-026 D5（`TradeDetail.reason`；本 ADR 在此之上扩展字段与语义）、ADR-019（fee 契约）、ADR-025（测试载体治理）、ADR-007/018（文学式单一源 + tangle 门禁）、ADR-003/004（双真值层/派生）。
- **Grill 记录**：十问闭合（Q1 ④三者都要 → D1/D9；Q2 ②全回合口径；Q3 ②全域统一；Q4 ①上游事实源分列；Q5 ①整仓回合；Q6 ①引擎打 `rt_seq`；Q7 ①L1 派生视图 + `Open` 态；Q8 ①懒加载；Q9 ①双口径 + 累计列；Q10 ①对账不一致显式告警）+ P1/P2 确认。
- **产出物（分阶段）**：
  - 第一批（本次）：本 ADR + `design/99-decisions-log.md` 条目。
  - 第二批（待本 ADR 评审通过）：`design/17-trade-detail-layering/02-spec.md`（接口契约）、`03-test-plan.md`（TDD 规格 + 复现测试清单）、`04-implementation-plan.md`（含迁移与清空方案）。
  - 实现：由 coder/tester 子代理按 TDD 执行；本文档为**实现契约唯一出口**，实现与本文不一致 = 违约。
