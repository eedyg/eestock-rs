# ADR-028 回测结果可视化：持仓比率序列、结果页时间窗联动、L1/L2 跳转定位

- 状态：**已裁决（2026-09-20，Grill 补充四问 + 「全部按推荐」+ 按钮语义 ②）**，待实现
- **批次**：与 **ADR-027 同批实现**（合并为「结果载荷 v2」不兼容批次，M1）。理由：两者都改 result payload / curve kinds / migrations，而 ADR-027 D3 已授权清空历史 ⇒ 只有**一次**清空与一次不兼容发版机会。
- 取代/影响：**修订** `/curve` 契约（增时间窗参数，向后兼容）；**修订** `BarRecord`（增持仓快照）；新增可抽样曲线 kind；**不改** `/result`、`/bars`、`/fills` 的既有形状；**不破** ADR-020（回到最新语义）与 ADR-022（跨图同步原语）
- 触发需求（用户原话）：①「还需要一个视图来展示持仓比率，就像净值一样的图即可（详细来定）」；②「K 线图和 vol 图可以左右移动时间和缩放，但是其他视图，比如净值、聚合总分、各策略评分等没有随着 K 线展示的时间范围改变显示」；③「L2 层交易明细还需要一个按钮，点击之后回测结果所有视图都跳转到对应交易的时间段」；④（补问）「L2 交易明细应该是有两个显式按钮的，一个是显示明细，一个是跳转」+「现在 K 线和其他视图的时间轴同步的逻辑是什么样的？」

## 1. 背景（已核实事实）

| # | 事实 | 位置 |
|---|---|---|
| F12 | 跨图同步基础设施**已存在**（ADR-022 §2.3 `ChartSyncGroup`），核心算法即「leader 可见范围 → `[realFrom, realTo]` **时间窗** → 跟随者（`setBarSpace` + `scrollToTimestamp`）」；但**工作台结果页未挂 `ChartSyncContext.Provider`**（唯一挂载点 `MultiPeriodChartStack.tsx:337`）⇒ 结果页 K 线处于 **no-op 注册表**状态，无任何窗口广播 | `chartSyncContext.ts:75-78`、`design/15-multi-period/01-adr.md:61-70` |
| F13 | 其余三个视图是**手写 SVG**（`viewBox` + `preserveAspectRatio="none"`），**无窗口参数、无缩放/平移**；非 klinecharts 实例 ⇒ 不可用 `setBarSpace` 同步，**只能消费时间窗** | `AggregateScoreChart.tsx`、`SlotScoresChart.tsx`、`EquityDrawdownChart.tsx` |
| F14 | `/curve` 只接受 `kind` + `k`，**无时间窗参数**；数据**服务端抽样**（`downsampled`/`original_bars` 披露）；按 `is_sampleable()` 白名单**拒绝** fills | `workbench.rs:1225-1254`、`:1231-1236` |
| F15 | `BarRecord` 无持仓字段、`EnsembleResult` 无持仓序列 ⇒ **持仓比率在现有落库数据里不存在** | `engine.rs:249-263` |
| F16b | 引擎在**同一处**已同时持有 `cash` 与 `holding.qty × close`（净值序列的压入点）⇒ 持仓快照是**零成本可得的事实**，无需复算 | `engine.rs:819-824` |
| F17 | sim-live 已有 net_value 序列生成点；持仓**多标的**（`sim_positions` PK `(session_id, code)`） | `simlive.rs:807`、`migrations/0018_sim_session.sql` |
| F18 | `setBarSpace` 越界（超出 `barSpaceLimit`，默认 max=50）**静默 return，什么都不做** ⇒ 跳转到宽窗口会**静默失败** | `web/src/test/syncChartStub.ts:7`、`KlineChart.tsx:358`（`barSpaceLimit` 为可传入 prop） |
| F19 | 程序化滚动 + 回声抑制已有先例：`programmaticScroll` ref + `subscribeAction('onZoom'/'onScroll')` 排除程序化；ADR-022 §2.3 明文要求 `applying` 标志 + 单向广播 + 应用后忽略回传 | `KlineChart.tsx:353`、`:424-428`、`design/15-multi-period/01-adr.md:65` |
| F20 | 既有两个**极易混淆**的比率口径已存在：`deployed_pct`（敞口/初始资金）、`cash_consumed_pct`（资金占用/初始资金），均为**区间累计 vs 初始资金** | ADR-026 §2.1、`:2.4-2` |
| F21 | SVG 视图**没有时间轴**：`mapLine` 的 x 按**数组下标**计算（`x = i/(len-1)×width`），点的 `ts` 被完全忽略 ⇒ 只是“把全区间抽样点等距铺满自己的框” | `web/src/features/backtest/chartUtils.ts:9-22` |
| F22 | 现有同步原语（ADR-022 `ChartSyncGroup`）**只面向 klinecharts 实例**（靠 `getVisibleRange`/`setBarSpace`/`scrollToTimestamp`）；手写 SVG 视图**无对应能力**，只能消费**时间窗** | `design/15-multi-period/01-adr.md:61-70` |
| F23 | `mapLine` 调用点仅 3 处（全在 workbench） | `AggregateScoreChart.tsx:38`、`EquityDrawdownChart.tsx:41`、`ComparePanel.tsx:47` |

**根因表述**：这不是"缺一个功能"，而是**两条通道能力不一致** —— K 线有「窗口」维度，其余视图**连窗口概念都没有**；持仓比率则是 ADR-027 D4 原则（「上游知道就写下来」）的第二个受害者。

## 2. 决策

### 2.1 D1｜持仓比率 = 引擎逐 bar 写下的**事实**（新可抽样曲线 kind）

- `BarRecord` 增持仓快照：`qty` / `position_value`（= `qty × bar.close`）/ `cash`（引擎在该点已同时持有两者，F16b）。
- 新增 `ResultKind::Position`，与 `net_value` 同级：**允许抽样，但必须披露**（`downsampled`/`original_bars`，沿用 ADR-024 D10）。不得混入 `fills` 的「禁止抽样」白名单语义。
- sim-live 侧在既有 net_value 生成点（`simlive.rs:807`）同步产出；**多标的聚合口径**：`position_value = Σ_code(qty × latest)`、`cash = 会话现金`、`nav = cash + position_value`。

**口径（冻结，禁止裸用"持仓比率"）**：

| 量 | 定义 | 分母/口径 |
|---|---|---|
| `position_value` | 持仓**市值**（bar close / latest 计价） | 时点值 |
| `nav` | `cash + position_value` | 与既有 net_value 逐点一致 |
| `position_ratio` | `position_value / nav`（`nav ≤ 0` ⇒ `0`） | **时点市值 / 时点净值** |
| `cash_ratio` | `1 − position_ratio`（并列披露，免用户自算） | 同上 |

**口径消歧（强制，固化 F20 的教训）**：`position_ratio`（**时点市值/时点净值**）与 ADR-026 的 `deployed_pct`（**区间累计敞口/初始资金**）、`cash_consumed_pct`（**区间累计资金占用/初始资金**）是**三个不同物**，必须在接口字段名、UI 标签、文档中**分别命名、分别注明分母**。特别是未满仓 run：`position_ratio` 是曲线，`deployed_pct` 是单值，二者**不得互相解释**。

### 2.2 D2｜结果页时间窗 = **页面级多源共享状态**

- 新增 `ResultWindowState { from_ts, to_ts, span_bars, source, rev }`，**页面级**持有（不是 ChartSyncGroup 内部私有态，因该组只同步 klinecharts 实例，F12）。
- **三个窗口来源**：① K 线交互（pan/zoom，leader 语义）；② **L1/L2 跳转**（程序化写入）；③ 「全览/重置」与「窗口历史回退」。
- **回声抑制**：程序化写窗后 K 线派发的 `onZoom`/`onScroll` **必须**被抑制（复用 F19 的 `programmaticScroll` 模式 + ADR-022 §2.3 的 `applying` 标志），并以 `rev` 单调序号防乱序覆盖。
- **窗口消费方**：K 线（`setBarSpace` + `scrollToTimestamp`；**必须**放宽该实例 `barSpaceLimit` 或改用 `scrollToDataIndex`，且**断言跳转成功**——F18 的静默失败零容忍）；SVG 曲线视图（按窗口取数）；持仓比率视图。

### 2.2b D2.1｜视图时间轴重建（Grill 补问二新增，**必须**）

现状是**三套互不认识的时间轴**（K 线视口 / 三条曲线的“下标轴” / 各自的取数范围），故“按窗口取数”**不足以**实现联动。必须同时建立三件事：

1. **ts→x 映射必须存在**：**新增** `mapLineByTs(pts, domainFrom, domainTo, …)`（**不改** `mapLine`，因它有 3 个既有调用点，F23）；`domain*` 为 ts。
2. **x 定义域必须是共享窗口** `[window_from_ts, window_to_ts]`，**禁止**用数据自身的 min/max——否则窗口内数据稀疏时仍会铺满整框（视觉对齐、语义不对齐）。
3. **对齐基准必须显式**：以「K 线可见 bar 的 ts 区间」为基准；“跟随”必须定义为**同一 ts 集合**（而非仅范围相同），允许 ≤1 根 bar 的量化误差（同 ADR-022 §2.3）。

### 2.3 D3｜`/curve` 增时间窗参数（保真优先）

- 增 `from_ts`/`to_ts`（缺省 = 全区间 ⇒ **向后兼容**）；窗口内**重新采样** `k`；响应回显 `window_from_ts`/`window_to_ts`/`window_bars` + 既有 `downsampled`/`original_bars`。
- **节流**：窗口请求 ~200ms 节流，**以最后一次为准**（`rev` 丢弃在飞旧响应）。
- **禁止**用已取点前端裁剪替代（放大后点变稀 = 静默有损）；**禁止**窗口加载期间用旧数据静默顶替（F14/D11）。

### 2.4 D4｜L1/L2 的显式按钮与跳转定位（按钮语义 = 方案②）

**按钮布置（两层各两枚，取消隐式“点击整行展开”——架构默认，可否决）**：

| 层 | 按钮 | 语义 |
|---|---|---|
| **L1 行** | `[明细]` | 展开/收起该回合的 **L2 子列表**（懒加载，D8；按钮自带展开态 aria-expanded） |
| **L1 行** | `[跳转]` | 窗口 = 该回合 `[open_bar, close_bar]`（± 少量 buffer） |
| **L2 行** | `[明细]` | 展开该笔成交的**完整字段详情**（行内放不下的：`trade_value/commission/stamp_duty` 拆分、成交后双口径均价、`cum_*` 累计、sim 侧 lot 归属） |
| **L2 行** | `[跳转]` | 窗口 = 该笔成交 bar 为**中心**、默认 **120 根**（可配） |

- **取消隐式行点击**：不再用“点击整行”展开（避免与文本选中/复制冲突，且显式按钮可测、可禁、可加 tooltip）。
- **窗口历史栈** + 常驻「全览」按钮（多次跳转后可回退）。
- **sim-live 跨标的**：若目标成交属**另一标的**，跳转**切换 K 线标的并显式提示已切换**（禁止静默无效）。
- **跳转可达性**：L1/L2 跳转前必须验证目标 bar 落在已加载 K 线区间内；超出则先按区间取数再定位，**不得**静默失败（与 F18 同类纪律）。

### 2.5 D5｜取数完整性契约适用于窗口路径

ADR-027 D11 的完整性契约（`total`/`recorded`/`has_more`/显式截断/窗口回显）同样约束本 ADR 的全部窗口取数路径。

## 3. 影响与代价

1. **result payload 变宽**：每 bar 增 3 个数字（`qty`/`position_value`/`cash`）；可抽样（`/curve`），不属事实源，故不受「禁止抽样」约束。
2. **`/curve` 契约变更**（向后兼容：缺省全区间）；前端新增共享窗口状态 + 节流层 + 历史栈。
3. **不得破坏 ADR-020**：`barSpaceLimit` 放宽只作用于**结果页 K 线实例**；「回到最新」语义与实时跟随逻辑不受影响（结果页 `followLatest=false`）。
4. **观测性**：窗口联动需可观测——窗口来源、`rev`、采样口径、跳转成功/失败断言须可查（否则"点了没反应"无法定位）。

## 4. 验收口径

1. **窗口一致性**：K 线可见 bar 的 ts 集合 == 各曲线视图收到的 `[window_from_ts, window_to_ts]` 覆盖集合（允许 ≤1 根 bar 量化误差，同 ADR-022 §2.3）；**且各视图的 x 轴定义域 == 共享窗口**（禁止用数据 min/max 自带定义域）。
2. **跳转确定性**：L2 定位后窗口中心 bar == 该成交 `bar_index`；L1 定位后窗口 == 回合区间；**且 `setBarSpace` 未被静默吞掉**（断言）；目标 bar 未加载时先取数再定位，无静默失败。
3. **持仓比率恒等式**（逐点）：`position_value + cash == nav`，且 `position_ratio × nav == position_value`（容差显式声明）。
4. **节流后最终一致**：连续 pan/zoom 结束后，最终窗口与最后一次请求一致（无乱序覆盖）。
5. **口径不混用**：`position_ratio` 与 `deployed_pct`/`cash_consumed_pct` 在同屏出现时，三者标签各含分母说明。
6. **多标的**：sim-live 跨标的跳转切主图并出现显式提示。
7. **按钮可测**：L1/L2 四枚按钮均有稳定 testid 与 `aria-expanded` 状态断言；取消隐式行点击后，点击行内文本不得触发展开/跳转。

## 5. 明确不做（登记技术债）

- **不做双向自动联动**：SVG 视图不反向驱动 K 线（除 D4 的**程序化**跳转外）；避免回声循环与语义混乱。
- **不做本地聚合**（ADR-022 已有禁令）。
- **不新增"成本口径"持仓比率**（只做市值口径；若要成本口径须另立 ADR 并命名 `position_cost_ratio`）。

## 6. 关联与产出物

- **关联**：**ADR-027**（同批次；L1/L2 定义、ledger 派生视图、D11 完整性契约）、**ADR-022**（跨图同步原语 / leader-follower / 时间跨度误差 ≤1 根 bar）、ADR-024 P6 + D10（`/curve` 显式抽样披露）、ADR-026（口径消歧先例 `deployed_*`/`cash_consumed_*`）、ADR-020（回到最新 / barSpace 语义）、ADR-007/018（tangle 门禁）。
- **裁决记录**：Q11→D1、Q12→D3、M1→合并批次、Q13→D4（③ 分按钮）、Q14→D4（L1 也给 / 历史栈 + 全览 / 跨标的切图并提示）、**Q15→D4（按钮语义方案②：两层各两枚按钮 + 取消隐式行点击）**、**补问二→D2.1（视图时间轴重建：新增 `mapLineByTs` + 共享窗口定义域 + 显式对齐基准）**。
- **产出物（分阶段）**：本 ADR + `design/99-decisions-log.md` 条目；第二批（与 ADR-027 合并）= `design/17-trade-detail-layering/02-spec.md`（含本 ADR 的契约增量）、`03-test-plan.md`、`04-implementation-plan.md`。
