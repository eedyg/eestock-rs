//! # strategy-core —— 统一策略内核（12-strategy-system P1a，手写，非 tangle）。
//!
//! ## 定位与管线（ADR `design/12-strategy-system/01-adr.md` §6 / §13.1）
//!
//! 每 bar 管线（[`engine::EnsembleEngine`]，单标的，D5）：
//!
//! ```text
//!  ┌─ 1. 执行上一 bar 挂单（close 判定 → 次 bar open 成交，复用 backtest 口径）
//!  ├─ 2. Intrabar 硬止损检查（ADR §13.3 第二层；唯一当 bar 成交例外场景）
//!  ├─ 3. 构建 BarCtx（含 PositionSnapshot 只读持仓全景，ABI §2.5）
//!  ├─ 4. 各 slot 插件 on_bar → 0-100 分（错误走 G5：中立分 50 + 错误事件 + 连续 10 次熔断）
//!  ├─ 5. 聚合 = Σ(w·s)/Σw（仅覆盖 slot；无覆盖 → 中立 50，ADR D2）
//!  ├─ 6. 信号判定：≥ buy_threshold(默认60) → Buy；≤ sell_threshold(默认40) → Sell；否则 Hold
//!  ├─ 7. CloseBasis 硬止损检查（收盘判定 → 次 bar open 成交）
//!  ├─ 8. ExecutionPolicy 信号 → 目标仓位（幂等）→ 订单 = 目标 − 当前（ADR §13.1）
//!  └─ 9. 记录净值 / per_bar 全量数据（ADR §13.4 全量落库的数据源）
//! ```
//!
//! ## 口径红线
//!
//! - **插件只产评分**：插件永远接触不到订单/账户写接口（ADR §3 红线）；引擎只消费分数。
//! - **纯逻辑**：无 IO / 无 DB / 无网络 / 无系统时钟；成交口径（滑点/FeeModel/绩效 8 项）
//!   全部复用 `backtest`，保证与内建回测费用口径一致。
//! - **熔断在引擎层**：G5 连续错误计数与停用是引擎职责（ABI §3 G5 归属澄清），
//!   runtime 只负责把错误以 `PluginError::OnBar`（自含 sha256 + bar_index）上报。
//!
//! ## 关键口径决策（任务书拍板，与 ADR §6 前文冲突时以本口径为准）
//!
//! - **DCA Sell 语义**：Sell 信号 → **一次性清仓**（目标 0），不做对称分批减仓
//!   （ADR §6 步骤 4 的「对称分批」被任务书口径覆盖）。
//! - **DCA 中断/重启**：Buy 信号中断（Hold/Sell）→ 剩余批次取消；Buy 重新出现 →
//!   重新开始计数——批次清零、Equal 计划总额按新起点净值重新快照、基线 = 当前持仓。
//! - **Equal 计划总额**：= 本轮 Buy 信号起点 bar 的账户净值快照（ADR 未定义，任务书
//!   「计划总额/N」的具体化）。
//! - **Trailing 峰值基准**：持仓期最高**收盘价**（不含当前 bar——当前 bar 若创新高，
//!   其 close 于 bar 末才并入峰值，避免自指立即触线）。
//! - **ATR 周期**：固定 ATR(14)（Wilder 平滑，复用 `backtest::Indicators`，任务书指定）；
//!   数据不足（None）→ 该 bar 不触发。
//! - **摊薄成本价**：avg_cost = 总成本（含买入佣金）/ 持仓股数；部分卖出按比例摊薄。
//! - **重复信号幂等**：订单 = 目标 − 当前（ADR §13.1）；DCA 批次用尽后继续 Buy 不产生额外订单。
//! - **LumpSum 冻结口径**（ADR §13.1 P1a 评审 MAJOR-1 裁决）：股数目标在 Buy 信号建立时
//!   （空仓或信号中断后首个 Buy）按 equity×position_pct/price 换算并**冻结**；Buy 持续期
//!   目标恒为冻结值（费用折损导致的市值漂移不再触发微卖出）；信号中断（Hold/Sell）后解冻，
//!   次个 Buy 重新快照。买入被现金上限截断时冻结目标下调至实际持仓（affordability 钳制，
//!   避免对不可达缺口重复挂微单）。
//! - **止损强平重置 PolicyState**（ADR §13.1 MAJOR-2 裁决）：硬止损强平 = 外部中断——
//!   触发即平仓的同时重置 DCA 批次/基线与 LumpSum 冻结快照（与 Trailing 峰值 reset 对齐）；
//!   强平后首个 Buy 重新计数批次，禁止以陈旧批次状态一次性重建仓。
//! - **ATR 前视口径**（ADR §13.1 MINOR-1 裁决）：Intrabar 触发的 ATR(14) 线用**截至上一 bar**
//!   数据计算（当 bar close 在 bar 内尚不可知）；CloseBasis 路径用含当前 bar 数据。
//! - **gap-through 乐观偏差备案**（ADR §13.1 MINOR-2 备案）：开盘/盘中跳空直接穿越止损线时，
//!   Intrabar 仍按止损价×(1−滑点)成交（ADR §13.3 字面口径），而非更保守的跳空价——
//!   为有意接受的乐观偏差，回测结果在极端跳空场景略偏乐观。
//! - **实例化失败**：属配置级错误，直接 `Err` 返回（非 per-bar 异常，不走 G5 中立分兜底）。

pub mod aggregate;
pub mod engine;
pub mod policy;
pub mod reference;
pub mod stop;

pub use aggregate::{
    aggregate, classify, StrategySlot, TradeSignal, DEFAULT_BUY_THRESHOLD, DEFAULT_SELL_THRESHOLD,
    NEUTRAL_SCORE,
};
pub use engine::{
    run_ensemble, BarRecord, EngineEvent, EnsembleConfig, EnsembleResult, OrderIntent, OrderReason,
    OrderSide, SlotScore, SlotScoreOutcome, CIRCUIT_BREAKER_THRESHOLD,
};
pub use policy::{DcaMode, ExecutionPolicy, PolicyState};
pub use stop::{StopConfig, StopKind, StopTrigger, TrailingState};
