# 111 — P1a strategy-core：聚合评分 + ExecutionPolicy + 硬止损 + G5 熔断 + EnsembleEngine

> 报告自身位置：`coder/report/111_strategy_core_p1a.md`
> 权威依据：`design/12-strategy-system/01-adr.md`（§6/§9/§13.1/§13.3/§13.4/§14）、
> `design/12-strategy-system/02-plugin-abi.md`（§2.5/§3 G5 归属/§4）；未修改 design/。

## 变更文件清单（全部新增，零修改既有 crate）

| 文件 | 行数(约) | 说明 |
|---|---|---|
| `crates/strategy-core/Cargo.toml` | 20 | 新 crate；依赖仅 `strategy-runtime`/`backtest`(path) + `serde`/`serde_json`(workspace)，**零新外部依赖** |
| `crates/strategy-core/src/lib.rs` | 55 | crate 级中文文档：管线图 / 口径红线 / 关键口径决策（引用 ADR/ABI 章节号） |
| `crates/strategy-core/src/aggregate.rs` | 130 | StrategySlot（weight>0 校验）+ 加权聚合 Σ(w·s)/Σw（无覆盖→中立 50）+ 阈值判定（60/40 恰值含等号） |
| `crates/strategy-core/src/policy.rs` | 290 | ExecutionPolicy（LumpSum/Dca）+ PolicyState（DCA 批次状态机）+ validate() |
| `crates/strategy-core/src/stop.rs` | 200 | StopConfig{kind,value,trigger} + 三种止损线 + TrailingState 峰值状态机 |
| `crates/strategy-core/src/engine.rs` | 480 | EnsembleEngine 全管线 + G5 熔断 + BarRecord/EngineEvent/EnsembleResult |
| `crates/strategy-core/tests/engine.rs` | 560 | 13 个集成测试（端到端/确定性双跑/熔断/止损/费用对齐） |
| `crates/strategy-core/tests/fixtures/*.js` | 5 个 | constant_score / position_gate / scripted_index / flaky / infinite_loop |

## 架构对齐（ADR §3 分层）

全部落在 **Domain 层**：纯逻辑、无 IO/DB/网络/系统时钟；不依赖 web/storage/application/mcp。
插件永远接触不到订单/账户写接口——引擎只消费评分（红线保持）。复用 `backtest::FeeModel`
（佣金+最低费用+印花税+滑点）、`Indicators::atr(14)`、`compute_metrics`/`compute_drawdown`，
费用/绩效口径与内建回测逐点一致（有对照测试锁定）。

## 关键口径决策（含理由）

1. **DCA Sell = 一次性清仓**：ADR §6 步骤 4 原文「sell 信号对称分批减仓」，任务书明确改为
   「Sell → 一次性清仓（目标 0）」。遵循任务书（与 §13 增补「冲突时以 §13 为准」精神一致），
   crate 文档注明。
2. **DCA 中断语义**：Hold/Sell 中断 → 剩余批次取消（状态清除）；Buy 重新出现 → **重新开始计数**：
   批次清零、Equal 计划总额按新起点净值重新快照、目标基线 = 当前持仓（累加式，保证幂等换算）。
3. **Equal 计划总额** = 本轮 Buy 起点 bar 的净值快照（ADR 只说「计划总额/N」未定义计划总额；
   选起点净值快照而非每 bar 动态净值——否则批次金额随价格波动漂移，破坏「分 N 批等额」语义）。
4. **Trailing 基准**：持仓期最高**收盘价**，且**不含当前 bar**（当前 bar 创新高时其 close 在 bar 末
   才并入峰值）——避免「新高 bar 因自身峰值立即触线」的自指问题。Intrabar 用 low 触线、
   CloseBasis 用 close 触线，线 = 峰值×(1−v)。
5. **ATR 周期 14**：任务书指定；Wilder 平滑复用 backtest::Indicators::atr(14)；数据不足（None）
   该 bar 不触发。线 = avg_cost − v×ATR。
6. **avg_cost 摊薄口径**：总成本（**含买入佣金**）/ 持仓股数；部分卖出按比例摊薄成本/佣金基线；
   Trailing 峰值在清仓时 reset、建仓时以首笔成交价初始化。
7. **Intrabar 成交价** = 止损线 ×(1−slippage)，当 bar 成交（fee.sell(line) 天然含滑点）——
   「close 判定次 bar open 成交」的唯一例外，代码注释注明；CloseBasis 收盘判定 → 次 bar open 成交。
8. **G5 归属**：熔断计数/停用在引擎层（ABI §3 G5 归属澄清）。错误事件直接携带
   `PluginError::OnBar`（自含 sha256/bar_index），测试断言 `root_cause()` 归类为 Timeout。
   熔断后该 slot 从聚合权重中剔除（「无覆盖」处理），per_bar.scores 不再出现。
9. **实例化失败** → 直接 `Err`（配置级错误，非 per-bar 异常，不走 G5 中立分兜底）——ABI 未明示，
   按「试算/运行启动即失败应当显式报错、禁止静默吞错（ADR §10）」处理。
10. **bar 内顺序**：挂单成交(open) → Intrabar 止损 → 评分 → CloseBasis 止损判定 → Policy 挂单。
    止损平仓后信号仍 Buy 会重新建仓（止损只负责「触发即平仓」，不抑制后续信号）——测试锁定并注释。

## 测试矩阵（TDD：每模块先 Red 后 Green）

单测 25（lib）+ 集成 13（tests/engine.rs）+ 性能冒烟 1（#[ignore]）：

- 聚合：加权均值 / 单 slot / 空→中立 50 / 60 恰值 Buy、40 恰值 Sell / 自定义阈值 / 权重校验；
- Policy：LumpSum 目标=净值×pct/价、重复 Buy 幂等、Sell→0、Hold→保持；DCA Equal 批次拆分、
  计划总额起点快照、Hold 中断取消 + Buy 重启重新计数、Sell 清仓复位、interval=2 隔 bar 触发、
  FixedAmount 固定额、validate() 非法配置拒绝；
- 止损：三种线计算 / Intrabar low 严格小于 / CloseBasis close 严格小于 / 成交价=线×(1−滑点) /
  Trailing 峰值状态机 / trigger 默认 Intrabar；引擎级：FixedPct×Intrabar（当 bar 成交）、
  FixedPct×CloseBasis（次 bar open）、Trailing×Intrabar（峰值 12 回撤）、Atr×CloseBasis（ATR(14) 线，
  测试内用 Indicators 独立复算）；
- G5：infinite_loop 连续 10 次超时 → 熔断停用 + 告警事件 + 引擎跑完 12 bar + 熔断后无覆盖中立 50；
  flaky 间歇错误 → 计数成功即清零不熔断 + 3 个错误事件落流（不静默吞错）；
- 引擎端到端：真实 QuickJsRuntime + fixture 插件；费用口径与 backtest::run 对照组**逐点一致**
  （净值序列/开平价/pnl/净利润）；确定性双跑 per_bar/净值/交易/绩效逐点相等；position_gate
  验证 ABI §2.5 持仓快照注入（空仓↔持仓驱动买卖闭环）；期末强平；实例化失败报错。

## 验证（命令与结果）

- `cargo test -p strategy-core` → **25 + 13 全绿**（1 ignored）；
- `cargo test -p strategy-core --test engine -- --ignored` → 性能冒烟通过；
- `cargo clippy -p strategy-core --all-targets` → **0 warning**（`manual_is_multiple_of` 一处
  按 MSRV 1.85 理由局部 allow，注释注明）；
- `cargo build --workspace` → **0 error**；
- `cargo test -p strategy-runtime` → 27 全绿（P0 无回归）。

## 性能数字（ADR §14：单标的 5 年日线 ×3 插件 < 2s）

**实测 86.1ms**（1260 bar × 3 插件实例，含 QuickJS 实例化 + 全程评分/聚合/Policy/强平），
约为目标的 1/23，达标。

## ABI 歧义与处理

| 歧义 | 处理 |
|---|---|
| ADR §6「sell 对称分批」 vs 任务书「一次性清仓」 | 从任务书，crate 文档注明覆盖 |
| Equal 模式「计划总额」未定义 | = 本轮起点净值快照（理由见上） |
| Trailing「最高收盘价」是否含当前 bar | 不含（bar 末并入），避免自指 |
| 实例化失败是否走 G5 | 否，直接 Err（配置级错误） |
| EnsembleConfig 含 runtime_limits 但 run_ensemble 接受外部 rt | 字段供 `run_ensemble_with_quickjs` 便捷入口构造 QuickJsRuntime 使用 |

## 遗留风险

- 止损平仓后同 bar 信号仍 Buy 会次 bar 重新建仓（语义已在测试/注释锁定；如需「止损后冷却期」
  属新需求，未在本期范围）。
- LumpSum 目标仓位以决策 bar close 换算、次 bar open 成交，价格漂移时实际仓位略偏离目标
  （与 backtest 引擎同口径，预算封顶现金不透支）。
- 绩效冒烟为单线程顺序评分；ADR §14 提到 bar 内插件间并行——当前 86ms 远超达标线，未做并行。
