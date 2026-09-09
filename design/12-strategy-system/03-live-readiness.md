# 12-strategy-system / 03 — 实盘预留契约：RiskGate + Executor Port（P5，仅契约不实现）

> 状态：**已批复（契约定稿）**。本期（D3）**只做架构预留**：本文档定义接口契约与红线，
> 不接真实券商、不实现 LiveService/BrokerExecutor。未来实盘迭代以此文档为权威依据，
> 任何实现偏离本文档须先修订本文档并经父级批准。

---

## 1. 定位与红线

统一策略系统（01-adr.md）的三模式共享同一「评分→聚合→Policy」内核。实盘模式在内核
之后追加两道**不可绕过**的关卡：

```
聚合总分 → 信号 → ExecutionPolicy → 订单意图
                                      │
                                      ▼
                              【RiskGate】（domain，纯逻辑，插件不可见）
                                      │ 放行（或拒绝/裁剪 + 事件）
                                      ▼
                              【Executor Port】（domain 端口）
                                ├─ SimulatedExecutor（现有 sim-live 撮合适配）
                                └─ BrokerExecutor（未来：东财 CDP / 银河 QMT sidecar，09-trading）
```

**红线（不可协商，实现期逐条测试锁定）**：
1. 实盘路径上**不存在**绕过 RiskGate 的下单通道——包括人工下单（人工单同样过 Gate，
   仅部分规则对人工单放宽，见 §2.4）。
2. 插件（策略）在任何模式下都得不到 Executor 引用；RiskGate 对插件不可见。
3. RiskGate **fail-closed**：规则评估异常/数据缺失/时钟异常 → 一律拒绝并记事件，
   不得降级为放行。
4. 策略版本必须 `approval_level = live_approved` 才能进入实盘会话（Registry 权限三级
   的终级闸门；backtest_ok/sim_ok 策略在实盘 catalog 不可见）。
5. **增险/减险一级概念（oracle 挑战 HIGH-1 修订）**：Gate 的一切熔断类规则作用于
   「增险订单」（买入及任何增加敞口的方向）；**减险订单**（平掉现有持仓的卖出，
   多头语境下判定平凡：sell qty ≤ 当前持仓）与撤单**在任何熔断状态下永远放行**，
   对策略单/人工单一视同仁——kill switch 的语义是「停止风险累积」，不是「冻结账户」。
6. **交易时段感知归 Executor**（oracle 挑战）：集合竞价/非交易时段的拒单/挂单由
   Executor 承担，Gate 不设时段规则——职责边界在此划定。

## 2. RiskGate 契约

### 2.1 接口（domain 纯函数/纯组件，DI 时钟，无 IO）

```rust
/// 风险闸门 verdict（逐规则留痕，审计要求）。
enum GateVerdict {
    Allow,                          // 全部规则通过
    Reject { rule: &'static str, reason: String },  // 首条命中拒绝（fail-closed）
    Clamp { rule: &'static str, from: f64, to: f64 }, // 数量裁剪（如仓位上限）
}

trait RiskGate {
    /// 对 Policy 产出的订单意图逐条裁决。上下文含账户/持仓/当日统计（由 application 组装）。
    fn evaluate(&self, intent: &OrderIntent, ctx: &GateContext) -> GateVerdict;
}
```

### 2.2 规则集（首期契约；每条独立可测、可配置但**不可关闭**，只能调阈值）

| 规则 | 语义 | 默认阈值（实现期可调，须经父级批准） |
|---|---|---|
| R1 单标的上限 | 单标的市值 ≤ 净值 × pct | 30% |
| R2 总敞口上限 | 总持仓市值 ≤ 净值 × pct | 90% |
| R3 下单频率 | 每标的每分钟 ≤ N 笔 | 2 |
| R4 单日亏损熔断 | 当日已实现+浮动亏损 ≤ −净值 × pct → 当日拒买（只许卖） | 5% |
| R5 最大回撤熔断 | 净值自历史峰值回撤 ≥ pct → 停止一切买入并告警（人工复位） | 15% |
| R6 价格合理性 | 委托价偏离最新价 > pct → 拒绝（防乌龙指） | 5% |
| R7 Kill Switch | 人工开关（web/MCP）触发 → 拒绝一切**增险**新单（减险/撤单放行，红线 5） | — |
| R8 权限闸 | 订单来源策略版本非 live_approved → 拒绝 | — |

**市场硬约束类（oracle 挑战 HIGH-2 增补；阈值不可调，只随市场制度变）**：

| 规则 | 语义 |
|---|---|
| R9 T+1 | 当日买入不可当日卖出。**品种属性**（A 股股票/股票型 ETF T+1；债券/商品/跨境 ETF T+0），非全局开关 → `GateContext` 必须含品种元数据（见 §2.1 注） |
| R10 整手规范化 | 买入数量为 100 股（lot_size）整数倍：Gate 向下取整到手，不足一手 → Reject（卖出可零股） |
| R11 涨跌停可交易性 | 涨停拒买、跌停拒卖（流动性状态约束；与 R6 价格偏离防乌龙指正交） |
| R12 可用资金 | 可用资金 − 在途冻结 ≥ 委托金额（R1/R2 管净值敞口，本条管现金透支） |

> §2.1 契约修订（HIGH-2）：`GateContext` 增 **instrument 元数据**字段
> {type, t_plus, lot_size, price_limit_band}——此为签名级结构依赖，元数据载体先行、
> 各品种明细库内容可后置填充。

### 2.3 事件与审计
每次裁决（含 Allow）产事件：{trace_id, ts, intent 摘要, rule, verdict, ctx 摘要}，
落审计台账（RunLedger 同族，持久化）。R4/R5/R7 触发额外告警事件（对接 alert 体系）。

### 2.4 人工单
人工单过同一 Gate，但 R3/R8 不适用（人工不受策略频率与策略权限约束）；
R7 语义对两来源一致——**减险永远放行**（红线 5），不存在人工特权通道。

### 2.5 后置备案（oracle 挑战 LOW，契约点名存在、实盘迭代再定）
- **R13 候选·撤单率**：信号高频翻转导致的大量撤单触及交易所程序化交易监管关注
  （报告义务/撤单率约束），实盘迭代增加撤单率告警/降速规则。
- **R6 stale 价口径**：低流动性 ETF 最新价可能严重滞后，R6 应注明「最新价超过 N 分钟
  未更新时改用昨收/参考基准」，口径实盘迭代定。

## 3. Executor Port 契约

```rust
#[async_trait]
trait Executor {
    /// 幂等：intent_id 去重（重复提交返回原单，不重复下单）。
    async fn place_order(&self, order: NewOrder) -> Result<OrderAck, ExecutorError>;
    async fn cancel_order(&self, order_id: &str) -> Result<(), ExecutorError>;
    async fn query_account(&self) -> Result<AccountView, ExecutorError>;
    async fn query_positions(&self) -> Result<Vec<PositionView>, ExecutorError>;
}
```

- `NewOrder`：{intent_id（调用方生成，幂等键）, code, side, price_type(limit|market), price?, qty, source(strategy|manual), trace_id}。
- 订单状态机：pending → partial → filled | canceled | rejected；**状态单调迁移，禁止回退**。
- **幂等实现落点（oracle 挑战 MED-1 修订）**：真实券商通道（东财 CDP/QMT）不接受客户端
  幂等键，「重复提交返回原单」由 **Executor 内部 intent→券商单号映射台账**兑现；
  结果不确定（超时）时不盲重试——先查台账/券商在途单后决。
- **成交回报通道（MED-1）**：Port 必须提供 `fill_events()` 事件流（或显式声明轮询口径，
  实现期选型）；异步回报可乱序/重复，Executor 负责**归一化**（事件幂等应用 + 状态单调）。
- **有效期与撤单语义（MED-1）**：所有订单为当日有效（day order），不支持 GTC；
  撤已成交单 → 明确错误码（`AlreadyFilled`）。
- `SimulatedExecutor`：现有 sim-live FillEngine 的适配器（本期已存在的事实实现，
  P5 不改动它；契约对齐在实盘迭代做）。
- `BrokerExecutor`：未来实现。候选通道（09-trading 既定）：东财 CDP（chromiumoxide）/
  银河 QMT（xtquant Python sidecar）。**实盘迭代立项前不得开工。**

## 4. LiveService 骨架职责（未来实现，本文档仅定职责边界）

1. 行情 bar 驱动 → 插件编排（**复用 P4a actor 承载模型**：每会话 worker 线程，契约同 P4a 裁决）。
2. 聚合 → Policy → 订单意图 → **必经 RiskGate** → Executor。
3. 审计台账：每 bar {各策略分, 聚合分, 信号, Gate 逐规则 verdict, 订单, 成交} 全量落库
   （比 sim-live 更严：Allow 也要留痕）。
4. 会话启动校验：全部策略版本 live_approved + 钉住快照（同 Registry 口径）。
5. 恢复（oracle 挑战 HIGH-3 修订，三段强制序列）：
   **(a) 重启即进入 halted 态**（等效 R7：增险全禁，减险放行）→
   **(b) 强制对账**（Broker 持仓/在途订单 vs 台账逐标的一致才放行；任何分叉 → 保持
   halted + 人工解决，fail-closed）→ **(c) 人工确认后复位**。
   明示：**止损为软件侧执行，进程停机期间持仓无保护**——这是 halted-by-default 的理由。

## 5. 可观测性要求（实现期验收项）

- 全链路 trace_id：bar 驱动 → 评分 → 聚合 → Gate → 下单 → 成交，单 trace 贯穿。
- Metrics：gate 拒绝率（按 rule 分桶）、下单延迟、成交率、熔断触发计数。
- Logs： Gate verdict 全量结构化日志；R4/R5/R7 触发即 ERROR 级 + 告警。
- Traces：插件评分 span、Gate 评估 span、Executor 调用 span 独立可观测。

## 6. 实盘迭代的开工条件（本契约的启用门槛）

1. 本契约经父级再次确认未过时；
2. BrokerExecutor 通道选型立项（09-trading spike 结论复核）；
3. RiskGate 规则（含 R9-R12 市场硬约束）TDD 全绿（含 fail-closed 反例：时钟回拨/数据缺失/异常注入）；
4. 审计台账与回放能力验收（任意历史 bar 区间可完整重放决策链，**且回放决策与当时实际成交记录对账一致**）；
5. **浸泡期演练**（oracle 挑战 MED-2）：SimulatedExecutor 走完整 Gate 链路端到端纸面运行
   ≥ 10 个交易日无 P0 缺陷——TDD 绿不等于链路行为正确；
6. **对账演练**（MED-2）：人为制造「进程崩溃 + 在途订单 + 券商侧已成交」场景，验证 §4.5
   恢复三段式真实有效（实盘最常杀人的场景，不能只靠代码评审）；
7. **绝对资金封顶**（MED-2）：首期试点部署级配置绝对金额硬顶（如 ≤ 10 万，独立于 R1/R2
   相对比例）——把「策略 bug × 市场极端」的最大损失钉死在可承受范围；
8. 父级书面批准接真实券商。
