# 12-strategy-system / 01 — 统一策略系统（插件化）架构/ADR（预实施）

> 状态：**已批复**（2026-09-08 三轮 Grill 定稿；§13 增补与前文冲突时以 §13 为准）。
> 定位：eestock-rs **唯一策略驱动系统**，同一策略内核驱动 回测 / 模拟实盘 / 真实实盘（本期实盘仅架构预留）。
> 旧系统处置：golang 侧（pkg/strategy、realtime）为已淘汰历史项目，仅参考、无迁移；
> eestock-rs 内 `backtest` 内建 7 策略与 `simlive` 评分编排器在本系统验收后退役（先标 deprecated 后删除）。

---

## 1. 已确认决策（2026-09-08 与父级逐项拍板，不再开放）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 插件运行时 | **QuickJS（rquickjs）先行**，用户直接写 JS 文本、即存即跑；ABI 契约先行定义，WASM 作为未来第二运行时（可替换实现，非本期） |
| D2 | 评分/聚合语义 | 插件输出**连续分 0-100**；聚合 = **每策略权重可调的加权平均**（仅对覆盖该标的的策略，Σw·s/Σw；无覆盖取中立 50） |
| D3 | 实盘范围 | 本期**只做架构预留**：RiskGate + Executor Port 契约定义并落文档，不接真实券商、不实现 LiveService |
| D4 | 旧系统 | 仅 eestock-rs 为新家；golang 旧项目仅参考。Rust 侧内建策略/simlive 编排器待本系统验收后退役 |
| D5 | 标的范围 | 本期**单标的**回测/评估；多标的组合资金分配列为后续迭代 |
| D6 | 执行方式 | **ExecutionPolicy 抽象**，首期双模式：LumpSum（一次性全量）+ DCA（分批/定投式），运行级可配置 |
| D7 | 策略管理 | **专门策略编辑页**（编辑器+在线试算）；策略为一等资源（Registry，版本化+哈希寻址）；回测/模拟实盘/实盘**下拉选择**已发布策略 |
| D8 | 首期策略包 | 现有 7 款内建策略改写为 **JS 参考插件**（兼作用户模板与测试 fixture） |

## 2. 目标与非目标

**目标**：
- 插件化策略运行时（JS/QuickJS，沙箱、确定性、状态可序列化）+ Host ABI 契约
- Strategy Registry：CRUD / 版本化 / sha256 寻址 / 状态机（draft→published→archived）/ 权限分级（backtest_ok→sim_ok→live_approved）
- 回测工作台：多策略并行评分 → 加权聚合总分 → ExecutionPolicy 生成订单 → 绩效报告；Web 页面 + MCP 双通道
- 策略编辑页：Monaco 编辑器 + 参数 schema + 指标 API 文档侧栏 + 在线试算（选标的/区间即写即跑）
- 模拟实盘切换至 Registry 策略 + 插件运行时（替换 simlive 编排器内 create_strategy 来源）

**非目标（本期不做）**：真实券商接入与 LiveService 实现；WASM 运行时；多标的组合资金分配；智能寻优/调参器；策略市场/分享生态。

## 3. 架构分层（严格单向依赖，跨层仅经 Port）

```
┌─ Presentation ──────────────────────────────────────────────────┐
│  web: 策略列表页 / 策略编辑页(+试算) / 回测工作台页 / sim-live 配置 │
│  mcp: strategy_* 工具族 + 回测/评分查询工具                       │
├─ Application ───────────────────────────────────────────────────┤
│  StrategyService（Registry CRUD/发布/试算编排）                   │
│  BacktestWorkbenchService（任务制/并发/进度WS/落库/对比）          │
│  SimLiveService（既有，策略来源切换到 Registry）                   │
│  ──（预留契约）LiveService × RiskGate × BrokerExecutor            │
├─ Domain（纯逻辑，无 IO，唯一策略内核）────────────────────────────┤
│  crates/strategy-runtime:  PluginRuntime trait + QuickJsRuntime   │
│      Host ABI 实现 / 沙箱限额 / 确定性守卫 / 状态快照              │
│  crates/backtest（扩展）:   Indicators / FeeModel / 组合 / 绩效    │
│  crates/strategy-core（新）: 聚合评分 / ExecutionPolicy /          │
│      EnsembleEngine（bar 循环：N插件评分→聚合→信号→订单）          │
├─ Infrastructure ────────────────────────────────────────────────┤
│  storage: strategies/strategy_versions 表、回测运行留痕（含插件哈希）│
│  BarSource: 历史(kline_accurate 优先) | 实时推送(sim-live)         │
│  Executor Port: SimulatedExecutor（本期）| BrokerExecutor（预留）  │
└─────────────────────────────────────────────────────────────────┘
```

**红线（不可协商）**：
- **插件只产评分，永不可见订单/账户/执行接口**；聚合分 →（实盘模式必经 RiskGate）→ Executor。RiskGate 是独立 domain 组件，插件无法绕过。
- Domain 层无 IO：BarSource/Executor/Registry 持久化均为 Port，由 application 注入。
- 三种执行模式共享同一条「评分→聚合→Policy」代码路径——回测验证过的策略组合行为与模拟/实盘一致，此一致性由架构保证而非测试保证。

## 4. 插件 ABI 与确定性契约

详见 `02-plugin-abi.md`（接口契约权威）。要点：

- **生命周期**：`init(params)` → 每 bar `on_bar(ctx) → 0-100 分` → 可选 `save()/load(state)` 状态快照。
- **Host 提供**：ctx = { bar(OHLCV/ts), indicators(MA/EMA/MACD/KDJ/BOLL/RSI/ATR，host 侧确定性计算，复用 backtest::Indicators), index, params }。
- **确定性守卫**（"相同插件+相同数据必复现"由机制保证，不靠自律）：
  1. 沙箱内 **禁用 Date/Math.random/IO**（不注入对应全局对象；如需随机由 host 注入种子化 RNG——本期不注入）；
  2. 每插件每 bar 调用有**燃料/超时 + 内存硬上限**；
  3. 插件状态仅经 `save()/load()` 序列化，host 持有快照（暂停/恢复/精确重放前提）；
  4. 发布版本 **sha256 寻址**；每次回测/会话落库记录 {strategy_id, version, sha256, params, 数据区间}——逐分不差重放。
- **异常隔离**：单插件 panic/超时/抛错 → 该插件该 bar 记中立分 50 + 错误事件落日志，引擎继续；连续错误超阈值 → 该插件熔断（本运行内停用）并显式告警。

## 5. Strategy Registry（数据模型与状态机）

```
strategy(id, name, description, created_by, created_at)
strategy_version(id, strategy_id, version 递增, code TEXT, params_schema JSONB,
                 sha256, status, approval_level, created_at, published_at)
  status:         draft → published → archived   （单向流转，published 不可变）
  approval_level: backtest_ok → sim_ok → live_approved（独立标记，升级需显式动作）
```

- **published 不可变**：编辑已发布版本 → 自动产生新 draft 版本；运行中的回测/会话**钉住 (strategy_id, version, sha256)**。
- **参数与代码分离**：插件内声明 `params_schema`（key/type/default/min/max/description），消费方 UI 按 schema 渲染参数表单 + 权重 + 标的映射；逻辑改动走代码，调优走参数。
- **catalog 接口**：`GET /api/strategies?level=backtest_ok` 为所有消费方下拉唯一数据源（沿用 builtin_strategy_catalog 模式，来源换 DB）；实盘场景过滤 `live_approved`。

## 6. 评分/聚合/执行管线（EnsembleEngine，单标的）

每 bar：
1. N 个插件实例各自 `on_bar(ctx)` → 连续分 0-100（越界 clamp）；
2. 聚合 = Σ(weight_i × score_i)/Σ(weight_i)（仅覆盖该标的的策略；无覆盖取 50）；
3. 信号判定：聚合 ≥ buy_threshold（默认 60，可配）→ buy；≤ sell_threshold（默认 40）→ sell；否则 hold；
4. **ExecutionPolicy** 将信号转为订单（本期双模式）：
   - `LumpSum{position_pct}`：buy → 下一 bar open 按资金比例全量买入；sell → 全部清仓（沿用现有引擎成交假设：close 判定、次 bar open 成交、slippage_bp + FeeModel）；
   - `Dca{tranches: N, mode: equal|fixed_amount, amount?, interval?: k（默认 1）}`：buy 信号持续期间分 N 批建仓（每 k bar 一批；Equal 计划总额 = 本轮 Buy 起点净值快照；信号中断 → 剩余批次取消，Buy 重现重新计数）；**sell 信号 → 一次性清仓**（目标 0；P1a 裁决覆盖本节旧文「对称分批减仓」，与 Grill Q3 推荐一致）；
5. 期末强制平仓 + 绩效指标（复用 backtest::metrics 8 项）。

**记录输出**：每 bar 落 {各策略分, 聚合分, 信号, 订单} 序列——页面评分曲线/总分曲线/交易标记的数据源，也是确定性验收的 diff 对象。

## 7. 首期参考策略插件包（D8）

7 款内建策略逐款改写为 JS 插件（语义对齐现有 Rust 实现与文档口径）：dual_ma / ma_rsi / macd / boll / kdj / momentum / atr_channel。另加测试 fixture 插件（非用户可见模板区）：
- `constant_score`（恒分）、`stateful_counter`（状态 save/load round-trip 验证）、`thrower`（异常隔离验证）、`infinite_loop`（超时熔断验证）、`boundary_clamp`（越界 clamp 验证）。

7 款参考插件验收标准：与对应 Rust 实现在同一 golden bar fixture 上信号序列一致（迁移等价性测试），验收后 Rust 内建策略标 deprecated。

## 8. 通道接口清单

**MCP（crates/mcp 扩展，命名沿用现有约定，工具描述标注适用场景）**：
| 工具 | 说明 |
|---|---|
| `strategy_list` / `strategy_get` / `strategy_versions` | Registry 查询（下拉同源） |
| `strategy_create` / `strategy_update` / `strategy_publish` / `strategy_archive` | Registry 管理（agent 可建/改/发策略） |
| `strategy_test_run` | 在线试算（单标的区间，返回评分序列+信号） |
| `bt_run_ensemble` / `bt_get_run` / `bt_list_runs` / `bt_compare_runs` | 回测工作台任务（异步，进度经 WS；MCP 侧轮询） |

> P3c 实施定稿（2026-09-09，父级批准）：`strategy_versions` 并入 `strategy_get`（详情+版本列表合一）；bt_* 增补 `bt_get_run_result` / `bt_cancel_run` / `bt_list_presets` / `bt_apply_preset`（最终矩阵 strategy_*×7 + bt_*×8，权威 schema 以 design/07-app-plane/01-mcp.md 为准）。

**Web 页面**：策略列表 / 策略编辑器（Monaco + 参数表单 + 试算面板）/ 回测工作台（策略多选下拉+权重+阈值+ExecutionPolicy 配置 → 运行 → 每策略评分曲线/总分曲线/净值/回撤/交易明细/绩效，多任务 compare）。sim-live 配置页策略来源切换为 Registry catalog。

## 9. TDD 规格（Red-Green-Refactor 强制）

- **契约测试套件**（任何 PluginRuntime 实现必须通过）：确定性（同 fixture 跑两次分数序列逐点相等）、状态 round-trip、超时熔断、内存上限、异常隔离、clamp。
- **迁移等价性测试**：7 参考插件 vs Rust 内建实现，golden bars 信号序列一致。
- **聚合/Policy/引擎**：手工构造固定 bar 序列 + 显式参数，无 RNG/无时间依赖，可完全复现（沿用现有策略测试纪律）。
- Bug 修复必须先有复现测试；测试为可执行规格，非实现镜像。

## 10. 可观测性

- tracing span 贯穿 run_id（回测任务/试算/会话），插件调用延迟/错误计数为独立 metric；
- 每 run 结构化事件流（信号/订单/成交/插件异常/熔断）落库，Trace ID 传播至 storage；
- 插件错误事件含 {strategy_id, version, sha256, bar_index, error}，禁止静默吞错。

## 11. 实施分期（每期独立可验收）

| 期 | 内容 | 验收 |
|---|---|---|
| P0 | strategy-runtime crate（ABI+QuickJS+沙箱+确定性守卫）+ 契约测试套件 + fixture 插件 | 契约测试全绿；确定性双跑 diff 为空 |
| P1 | strategy-core（聚合+ExecutionPolicy+EnsembleEngine）复用 backtest 指标/费用/绩效 | 聚合/Policy/引擎单测 + 7 参考插件迁移等价性测试绿 |
| P2 | Registry（storage+StrategyService+REST）+ 策略列表/编辑页（含试算） | 发布不可变/版本钉住/权限过滤端到端 |
| P3 | 回测工作台（BacktestWorkbenchService 任务制+WS 进度+页面）+ MCP 工具族 | 页面跑通多策略聚合回测；MCP tools/list 全量 |
| P4 | sim-live 切换 Registry 策略源 + 插件运行时；旧编排器/内建策略 deprecated | sim-live 会话用插件策略跑通；回测对比功能不失效 |
| P5 | RiskGate + Executor Port 契约文档化（实盘预留，不实现） | 契约评审通过 |

## 13. Grill 定稿增补（2026-09-08 三轮，全部父级拍板）

### 13.1 职责分层修正案（D9）——决策层/执行层分离
插件从「纯评分器」升级为「环境感知的决策者」，但**评分仍是唯一输出**：
- **插件（决策层）**：ctx 增强为只读全景（+ `ctx.position`，见 02-ABI §2.5）。策略的两态门控/状态机/定投节奏全部编码在「何时给多少分」里——引擎**不固定任何门控行为**。
- **引擎（执行层）**：只保留最笨的统一规则：总分 ≥ buy阈 → 按 Policy 买；≤ sell阈 → 卖。**Policy 将信号换算为目标仓位，订单 = 目标 − 当前（幂等）**——重复信号天然无副作用。
- **LumpSum 冻结口径（P1a 评审 MAJOR-1 裁决）**：LumpSum 的股数目标在 **Buy 信号建立时**按当时净值×position_pct 换算并**冻结**，Buy 持续期不重算（费用折损导致的市值漂移不再触发微卖出）；信号中断（Hold/Sell）后解冻，次个 Buy 重新快照。
- **止损×Policy 交互（P1a 评审 MAJOR-2 裁决）**：硬止损强平 = **外部中断**——触发即平仓的同时**重置 PolicyState**（DCA 批次/基线清零，与 Trailing 峰值 reset 对齐）；次个 Buy 信号重新计数，禁止以陈旧批次状态一次性重建仓。
- **Intrabar ATR 口径（P1a 评审 MINOR-1 裁决）**：Intrabar 触发的 ATR 止损线用**截至上一 bar** 的数据计算（当 bar close 在 bar 内尚不可知，避免前视）；CloseBasis 路径用含当前 bar 数据（收盘后判定，无前视）。
- **gap-through 成交口径（P1a 评审 MINOR-2 备案）**：开盘跳空破止损线时仍按止损价×(1−滑点)成交（ADR §13.3 字面口径），为**有意接受的乐观偏差**，crate 文档注明。
- 语义后果（文档注明，非 bug）：position-aware 插件在「纯试算（无持仓）」与「组合回测（有持仓）」中分数可能不同。

### 13.2 官方策略模板（D10）
编辑器新建策略时可选模板，承载通用行为模式（模板即参考插件，fixture 化管理）：
`纯评分模板` / `两态门控模板` / `定投模板` / `趋势+止损模板`。

### 13.3 止损三层（D11）
| 层 | 机制 | 性质 |
|---|---|---|
| 策略层（软止损） | 模板内按 `ctx.position.avg_cost` 输出 0 分拖低总分 | 可定制、可被他策略对冲 |
| Policy 层（硬止损） | Run 级 `stop:{type:fixed_pct\|trailing\|atr, value, trigger:intrabar\|close}`，**触发即绕过评分直接平仓** | 不依赖策略自觉；trigger 默认 intrabar（low/high 穿越按止损价±滑点成交，为「close 判定次 bar open 成交」的唯一例外场景） |
| RiskGate 层 | 账户级限额/回撤（P5 预留，实盘必经） | 插件不可见不可绕过 |

### 13.4 数据粒度（D12）
每 bar 的各策略分+聚合分**全量落库**；UI 渲染端抽样（1m 长区间几十万点由前端降采样，后端不做有损预处理）。

### 13.5 Web 交互定稿（D13）
- 编辑器：**CodeMirror 6**（非 Monaco；包体积理由见 Grill Q5）+ 指标 API 文档侧栏 + 版本 diff 视图。
- 试算**双模式**：纯评分模式（position 恒 null，看原始反应）/ 模拟持仓模式（单策略 ensemble，自身分数走默认 60/40 阈值+LumpSum 模拟成交，position 有真实值，可调 DCA/止损/门控模板）。同步执行 + 区间上限（日线≤5年 / 1m≤3个月）。
- 工作台结果页：K线+买卖标记(含硬止损触发点) / 总分曲线(60/40阈值线+三区着色) / 各策略评分曲线(图例开关,默认前3) / 净值+回撤 / Tab(交易明细|8项绩效|逐bar评分表|事件日志) / 多任务 compare(净值叠加+绩效并排)。K线叠加策略指标线为 P3 可选裁剪项。
- 版本管理：编辑已发布版本**自动落新 draft**（防呆）；回滚=从旧版本建 draft；版本列表带 diff 视图。
- **组合预设（Combo Preset）**：命名保存 {策略集+权重/参数, 阈值, Policy, 止损}，工作台与 sim-live 共用下拉——保证回测↔模拟实盘对比时配置一致。P3 末可裁剪项。

### 13.6 sim-live 切源口径（D14）
**保留骨架换内核**：会话/账户/撮合/UI 配置流/会话记录/回测对比全部不动；编排器内 `create_strategy` 替换为 Registry 已发布策略 + QuickJS 实例（每策略×标的一实例），评分/聚合语义不变，沿用 3 策略×30 股上限。

### 13.7 MCP transport（D15）
新工具族（strategy_*/bt_*）落在**现有 SSE server**；Streamable HTTP 迁移维持独立 backlog 项，不与本次交付耦合。

### 13.8 并存期（D16）
新工作台为独立新页面/新 API 族（`/strategies`、`/backtest-workbench`）；现有回测页与内建策略原样可用至 P4 验收，之后旧页入口隐藏、Rust 内建策略与 simlive 编排器标 deprecated 后删除——全程无回测功能真空期。

## 14. 风险登记

| 风险 | 缓解 |
|---|---|
| QuickJS 与 Rust 集成复杂度（rquickjs 生命周期/异步） | P0 先行 spike 锁定；运行时包在 trait 后，可替换 |
| 性能（N插件×K bar JS 调用开销） | 基准测试锁定（目标：单标的 5 年日线 3 插件 < 2s）；插件实例复用，bar 内插件间并行（无依赖） |
| 用户脚本质量参差 | fixture 模板起步 + 试算闭环 + 熔断隔离；编辑器 lint/校验 |
| 语义漂移（JS 插件 vs 原 Rust 策略） | 迁移等价性测试守门；口径差异逐款在插件注释注明 |
