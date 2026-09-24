# ADR-029｜执行策略正交化：`exposure`（目标）× `ramp`（到达方式）× `guard`（硬边界）

> **状态**：**已裁决**（2026-09-24，用户批准架构侧推荐）。**Step 1 本批实施**；Step 2/3 登记待批。
> **背景取证**：`crates/strategy-core/src/policy.rs`（现行 `LumpSum{position_pct}` / `Dca{tranches,interval,mode,amount}`）、
> `crates/strategy-core/src/aggregate.rs:106`（`classify`：分数→三元信号）、`crates/application/src/audit.rs`（`planned_tranches` 与三条告警）、
> 真实 run 取证：`sr_1790169818677_000006`（Equal/100 批：每批恒 1000 元 = `plan_total/tranches`）、`sr_1790247371321_000015`（`interval=2,tranches=5` 因信号翻转**只执行第 0 批**）。

---

## 1. 问题（现行契约的失效模式）

| # | 问题 | 证据 |
|---|---|---|
| P1 | **分数强度被丢弃**：连续 0-100 只经 `classify` 变 Buy/Sell/Hold ⇒ 51 分与 100 分订单相同；仓位量只由 run 级 policy 单值决定 | `aggregate.rs:106` |
| P2 | **仓位意图无法按策略区分**：`policy` 是 run 级一份；多策略组合里"A 想 30%、B 想 60%"不可表达 | `strategy_run.config.policy` 单对象 |
| P3 | **"分批"是 policy 属性而非交易意图**：`Dca` 的路径绑在"Buy 信号是否持续"上 ⇒ 信号翻转即撤销剩余批次 | `sr_1790247371321_000015`：34 个 burst 各 1 批 |
| P4 | **策略输出与 run 级阈值耦合**：模板必须"为 60/40 调分"（`趋势+止损模板` 持仓给 0 分；两态门控/定投模板靠 `ctx.position===null`、`bars_since_entry` 编码仓位意图） | 模板源码注释 |
| P5 | **试算 ≠ 回测**：纯评分试算 `ctx.position` 恒 `null` ⇒ position-aware 策略两模式分数不同 | `types.rs:74`、`quickjs.rs:462` |

根因：**目标（想持多少）与路径（多快到）被压在同一个枚举里，且"意愿强度"不进仓位**。

---

## 2. 决策

### D1（正交化；术语收敛）
`policy` 拆为三个**独立维度**：**`exposure`（目标）**、**`ramp`（到达方式）**、**`guard`（硬边界）**。
**术语表（禁止重载）**：新增字段只用这三个词；**不再引入 `plan`**（"策略声明的分批意图"这一旧提案概念由 `ramp` 取代）。既有字段保留原名但须在文档注明归属：`plan_bars`（**策略**参数的买入区窗口，与 ramp 无关）、`plan_total`（**policy 内部**：本轮起点净值快照）、`planned_tranches`（**审计**：本次路径的计划批次数）。

### D2（Step 1 范围：纯增量，历史 run 可复现）
新增变体 **`ExecutionPolicy::Exposure`**；**`LumpSum`/`Dca` 逐字节不变**（继续被解析与执行 ⇒ 历史 run 快照无需 `schema_version` 即可复现）。**因此本批不需要 schema_version 字段**；版本字段留待 Step 2（若届时**改写**旧变体语义再引入）。

### D3（`exposure`：目标维）
```
Exposure { target: ExposureTarget, ramp: RampSpec, guard: GuardSpec }

ExposureTarget =
  Fixed { pct }                                  // 常数目标（= 现 LumpSum 的目标语义）
| ScoreMapped { at_threshold_pct, at_full_pct,   // 目标随分数连续变化（线性）
               sell: SellPolicy }                // SellPolicy = Flat | Scaled

SellPolicy = Flat                                 // score ≤ sell_threshold ⇒ 目标 0（清仓）
           | Scaled                               // 对称降档（按同一斜率映射到 [0, at_threshold_pct)）
```
- **映射口径（钉死）**：`score ≥ buy_threshold` 时 `pct = at_threshold_pct + (score−buy_threshold)/(100−buy_threshold) × (at_full_pct−at_threshold_pct)`；`score ≤ sell_threshold` 时按 `SellPolicy`；其间（Hold 带）⇒ **保持上一目标**（不因穿越中立区而抖动）。
- **单调 + 端点**：映射单调不减；`score=buy_threshold ⇒ at_threshold_pct`、`score=100 ⇒ at_full_pct`；越界分数先夹到 `[0,100]`。
- **接口影响（内部）**：`PolicyState::target_qty` 需接收**聚合分**（现签名只有 `signal`）⇒ 增加 `score: f64` 参数（或新增 `target_qty_with_score`）；**旧变体忽略该参数**，行为不变。

### D4（`ramp`：到达方式维；Step 1 只做基元）
```
RampSpec = Immediate                              // 当 bar 目标即全额（= 现 LumpSum 的路径）
         | RateCap { pct_per_bar }                // 每 bar 目标变动上限（速率限制）
```
- **`RateCap` 是路径基元**：对**移动目标**天然成立（目标每 bar 变，路径只限制"每 bar 最多走多少"）。
- **延后到 Step 2**：`Tranches{count, interval, size:{equal|fixed_amount}, on_signal_break}`（"静态目标 + 批次"的糖）、`fixed_amount`、`on_signal_break`。理由：`tranches` 与移动目标**语义冲突**（批次栅格对动态目标无定义）⇒ 必须与"进入路径时快照目标"的规则一起设计。

### D5（`guard`：硬边界维）
```
GuardSpec { max_pct, min_pct, deadzone_pct }
```
- **`max_pct` 强制夹取**：分数多高、策略怎么说，**目标不得超过 `max_pct`**（安全不变式）。
- **`deadzone_pct`**：`|目标 − 当前暴露| < deadzone_pct` ⇒ **不下单**（防抖前置条件；连续仓位的新失效模式是"分数抖动 → 订单抖动 → 费用流失"）。

### D6（语义钉死；本批必须实现并测）
1. **目标永远是上限**：`ramp` 只决定靠近速率，**不得越过 `target`**。
2. **目标按决策 bar 净值重算**：`目标股数 = pct × equity / price`（`equity`/`price` 口径沿用现行：决策 bar 收盘估值，**次 bar open 成交**）。
3. **单调推进**：已完成步不得回退（速率受限亦不得反向抖动）；`Hold` 带内保持上一目标。
4. **强平/硬止损 = 外部中断**：路径作废并 `PolicyState::reset()`（沿用 ADR-028 §13.1 MAJOR-2 裁决）。
5. **warmup 段不执行 Policy**（沿用）。
6. **聚合层本批不变**（仍为加权平均 → `classify`）；`Exposure` 模式从**聚合分**直接算目标，`signal` 仅作 UI/披露记录。

### D7（观测与审计）
- 每 bar 落：`{target_pct, current_pct, ramp_cap_pct_per_bar, deadzone_blocked, clamped_by_guard}`；随既有 `per_bar` 记录通道输出（不新增事实表）。
- 审计新增：**"意图（target_pct）vs 实际暴露"差值** + **抖动指标**（评估段下单次数 / 费用占净值比）；形态沿用 `WARN_DCA_PLAN_UNDERFILLED`。
- UI：结果页需能显示目标暴露曲线（或至少在审计/配置处披露映射端点），并标注"总分曲线是诊断量，不等于仓位"。

### D8（安全）
- 策略与分数**不得突破** `guard.max_pct`；`guard` 由 run 级配置给出，**策略无权覆盖**。
- sim-live 的 `RiskGate` 作用在目标之后（gate 裁剪必须**可观测**）——**本批只登记接口点，不改 gate**。

### D9（Step 2/3 登记，不在本批）
- **Step 2**：`ramp=Tranches` + 静态目标快照 + `on_signal_break`；**目标层聚合**（per-slot `policy`，`target = clamp(Σwᵢ·targetᵢ, guard)`，总分曲线降为诊断量）；若届时改写 `Dca` 语义，**必须引入 `schema_version` 并以"旧 run 重跑逐字节一致"为回归门禁**。
- **Step 3**：策略**可选**声明意图 `{score, target_pct?, ramp?}`（ABI 演进；`guard` 仍强制夹取）。用户已允许放弃既有策略，故 ABI 演进不受"旧策略兼容"约束；但仍须保留 `{LumpSum,Dca}` 的**历史 run 可解释性**。

### D10（legacy 纪律）
`{LumpSum, Dca}` 保留为**只读解释器**（不删、不改语义）；策略族本身可标 deprecated 并按 ADR-012 波形删除——**"放弃策略" ≠ "放弃历史 run 的可复现性"**。

---

## 3. 影响与代价
1. **crates/strategy-core**：`policy.rs`（新变体 + 校验 + `target_qty` 增 `score` 参数）、`engine.rs`（传聚合分 + 观测字段）。
2. **crates/application**：`audit.rs`（意图 vs 实际 + 抖动指标）。
3. **web**：`api/types.ts`（policy 联合类型）、`ConfigPanel.tsx`（新模式的字段与校验提示）、结果页/审计披露。
4. **规格**：policy 单测矩阵（exposure 目标 × ramp 模式 × guard）、真渲染（配置 + 披露）、**旧变体逐字节复现对照**。
5. **不新增事实表/迁移**；MCP/HTTP 的 policy 直通 JSON 自动支持新变体（服务端 serde 校验）。

## 4. 验收口径
1. `ScoreMapped`：映射单调不减、端点精确（阈值 ⇒ `at_threshold_pct`，100 ⇒ `at_full_pct`）、分数先夹 `[0,100]`；`SellPolicy` 两支各有用例。
2. `guard.max_pct`：构造"分数要求 100% 暴露"⇒ 实际目标 ≤ `max_pct`（并置 `clamped_by_guard`）。
3. `deadzone_pct`：`|Δ目标| < deadzone` ⇒ **零订单**（逐 bar 断言）。
4. `RateCap`：任意相邻 bar 的目标变动 ≤ `pct_per_bar × equity`（含大幅跳变的极端用例）；**不得越过 target**。
5. **强平 reset**：硬止损后 DCA/冻结/路径状态全清（与现行裁决一致）。
6. **旧变体复现**：`LumpSum`/`Dca` 在同一输入下与本 ADR 之前**逐字节一致**（含记录 A/B 两个真实 run 的成交序列对照）。
7. **防抖**：构造分数抖动序列 ⇒ 下单次数/费用占净值比 ≤ 判据上限（阈值由标定给出）。
8. **观测/审计**：`target_pct/current_pct/deadzone_blocked/clamped_by_guard` 逐 bar 可读；审计出现"意图 vs 实际"差值。

## 5. 明确不做（本批登记）
目标层聚合与 per-slot policy（Step 2）｜`Tranches`/`fixed_amount`/`on_signal_break`（Step 2）｜策略声明意图（Step 3）｜`schema_version`（Step 2 若改写旧语义时再引入）｜`RiskGate` 接口改造｜试算"模拟持仓默认化"（P5，独立小批）。

## 6. 关联与产出物
- **关联**：ADR-028 §13.1（LumpSum 冻结 / 强平 reset 裁决）、ADR-026（审计与披露口径）、ADR-024 D10（禁静默有损）、ADR-012（交付波形）、`design/12-strategy-system/{01-adr,02-plugin-abi,04-strategy-programming-guide}.md`。
- **产出物**：本 ADR + `design/12-strategy-system/05-plan-exposure-ramp-step1.md`（实施计划与判据）+ `design/99-decisions-log.md` 条目。
