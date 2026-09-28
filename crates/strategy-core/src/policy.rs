//! ExecutionPolicy：信号 → 目标仓位幂等换算（ADR §13.1，D6）。
//! 订单 = 目标 − 当前，重复信号天然无副作用。
//!
//! LumpSum 冻结口径（ADR §13.1 P1a 评审 MAJOR-1 裁决）：股数目标在 Buy 信号建立时
//! （空仓或信号中断后首个 Buy）按 equity×position_pct/price 换算并**冻结**；Buy 持续期
//! 目标恒为冻结值（不因净值/费用漂移重算）；Hold → 目标 = 当前（解冻，无订单）；
//! Sell → 0（解冻）；信号中断后首个 Buy 重新快照。

use serde::{Deserialize, Serialize};

use crate::aggregate::{TradeSignal, DEFAULT_BUY_THRESHOLD, DEFAULT_SELL_THRESHOLD, NEUTRAL_SCORE};

/// DCA 分批金额模式。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum DcaMode {
    /// 等额分批：计划总额 / N。计划总额 = 买入信号重新出现时（新一轮建仓起点）的账户净值。
    Equal,
    /// 固定金额分批：每批 `amount` 元。
    FixedAmount,
}

// ---------------------------------------------------------------------------
// ADR-029（Step 1）：`exposure`（目标）× `ramp`（到达方式）× `guard`（硬边界）
// ---------------------------------------------------------------------------

/// 目标所属**档位**（由聚合分 + run 级阈值判定；ADR-029 D3 `score ≥ buy_threshold /
/// `score ≤ sell_threshold` / 其间为 Hold 带）。
///
/// 用途：① `ScoreMapped` 的中立带**保持上一目标股数**（R5）；② `sell_transition` 跳变披露（D7）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetBranch {
    Buy,
    Sell,
    Hold,
}

/// 卖出档策略（ADR-029 D3 `SellPolicy`，**Step 1 两支**）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum SellPolicy {
    /// `score ≤ sell_threshold` ⇒ 目标 0（清仓）。
    Flat,
    /// 对称降档：线性 `(score = 0 ⇒ 0) … (score = sell_threshold ⇒ at_threshold_pct)`（R6 钉死端点）。
    Scaled,
}

/// 目标维（ADR-029 D3）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum ExposureTarget {
    /// 常数目标（等价现行 `LumpSum` 的目标语义，R2：Buy ⇒ `pct`、`score ≤ sell_threshold` ⇒ 0）。
    Fixed {
        /// 目标仓位占净值比例，∈ (0, 1]。
        pct: f64,
    },
    /// 目标随分数连续变化（线性）：`score ≥ buy_threshold` 时
    /// `pct = at_threshold_pct + (score − buy_threshold)/(100 − buy_threshold) × (at_full_pct − at_threshold_pct)`。
    ScoreMapped {
        /// `score = buy_threshold` 时的目标比例。
        at_threshold_pct: f64,
        /// `score = 100` 时的目标比例（须 ≥ `at_threshold_pct`，且 ≤ `guard.max_pct`）。
        at_full_pct: f64,
        /// 卖出档降档方式。
        sell: SellPolicy,
    },
}

/// 信号中断语义（ADR-029 D12；**只存在于 [`RampSpec::RateCap`]**）。
///
/// **为何不在 `Immediate` 上增设该字段**（06-plan §2.1；架构侧更正见 **ADR-029 §8.3 R37**）：
/// `Immediate` **恒取 [`OnSignalBreak::Pause`]**，因为它**在结构上无法携带该开关**
/// （`Immediate` 无 Hold 带路径状态可暂停 ⇒ 旧 JSON 只能走缺省路径）。
/// 计划 §2.1 原文「`Immediate` 的 Hold 带行为与 `Continue` 在中立带**等价**」**已作废**：
/// `Continue` 按**当前净值/价格**折算**意图比例**（ratio 重算），`Pause` 在中立带冻结
/// **上一输出目标的绝对股数**（R5/E3 位级钉死）——两者**不等价**。为守住 E3/E13 与 E19④ 的
/// 兼容铁律，该开关**只存在于 `RateCap` 内**（判定见 [`RampSpec::on_signal_break`]）。
/// **兼容铁律**：缺省（旧 JSON 无该键）= [`OnSignalBreak::Pause`] = 现行语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OnSignalBreak {
    /// 缺省 = 现行：中立带输出**冻结在上一输出目标**（`ScoreMapped`：绝对股数，R5）。
    Pause,
    /// 中立带继续朝 `intent` 推进（`intent` 按当前净值/价格折算）。
    Continue,
}

/// 到达方式维（ADR-029 D4；Step 1 只做基元）。
///
/// **serde 形态（契约见计划 05 的 JSONC）：**
/// - `Immediate` ⇒ `{"Immediate": null}`（单位变体的外部标记 + `null` 载荷）；
/// - `RateCap` ⇒ `{"RateCap": {"pct_per_bar": 0.05}}`。
/// 反序列化**只接受该唯一形态**（不兼容 `"Immediate"` 字符串形态：契约唯一优先于宽容；
/// 该形态即 web `ExposureRamp` 与 MCP/HTTP 直通 JSON 的约定）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RampSpec {
    /// 当 bar 目标即全额（= 现 `LumpSum` 的路径）。
    Immediate,
    /// 每 bar **目标股数变化所折算的金额** ≤ `pct_per_bar × equity`（`equity` = 决策 bar 净值，R1 量纲钉死）。
    RateCap {
        /// 每 bar 目标变动占净值上限，必须 > 0。
        pct_per_bar: f64,
        /// **下行**每 bar 预算占净值比（ADR-029 D12；`None` ⇒ 对称 = `pct_per_bar`，与现行逐字节一致；
        /// `0` ⇒ 下行无预算 = 本 bar 目标直达 desired，**仍不得越过 desired**）。
        down_pct_per_bar: Option<f64>,
        /// 信号中断语义（ADR-029 D12；`None` ⇒ [`OnSignalBreak::Pause`] = 现行）。
        on_signal_break: Option<OnSignalBreak>,
    },
}

impl RampSpec {
    /// **有效信号中断语义**（D12）：缺省 `Pause`；`Immediate` 恒 `Pause`。
    ///
    /// `Immediate` 取 `Pause` 的理由 = **兼容铁律**（`Immediate` 无处安放该字段 ⇒ 旧 JSON 只能走缺省路径）：
    /// `Exposure{ScoreMapped}` 中立带在 `Immediate` 下保持**上一输出目标的绝对股数**（R5/E3 位级钉死），
    /// 与 `Continue` 的「按当前净值折算 ratio」不同 ⇒ 若按 `Continue` 处理将破坏 E3/E13 与旧 run 复现。
    pub fn on_signal_break(&self) -> OnSignalBreak {
        match self {
            // 兼容铁律：Immediate 只可能来自旧 JSON/旧 run ⇒ Pause（见上方文档）。
            RampSpec::Immediate => OnSignalBreak::Pause,
            RampSpec::RateCap { on_signal_break, .. } => {
                on_signal_break.unwrap_or(OnSignalBreak::Pause)
            }
        }
    }

    /// **有效下行速率预算占净值比**（D12/观测键口径）：
    /// `RateCap` ⇒ `down_pct_per_bar ?? pct_per_bar`（`0` = 下行不限速）；`Immediate` ⇒ `None`。
    pub fn down_pct_per_bar(&self) -> Option<f64> {
        match self {
            RampSpec::Immediate => None,
            RampSpec::RateCap { pct_per_bar, down_pct_per_bar, .. } => {
                Some(down_pct_per_bar.unwrap_or(*pct_per_bar))
            }
        }
    }
}

/// `RampSpec::RateCap` 的 JSON 载荷（`{"pct_per_bar": …}`）。
///
/// **旧形态逐字符不变**（06-plan §2.1 序列化纪律）：两个新字段 `default` + `skip_serializing_if`
/// ⇒ `{"RateCap":{"pct_per_bar":0.05}}` 的解析与产出与 Step 1 完全一致。
#[derive(serde::Serialize, serde::Deserialize)]
struct RateCapPayload {
    pct_per_bar: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    down_pct_per_bar: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    on_signal_break: Option<OnSignalBreak>,
}

impl Serialize for RampSpec {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            RampSpec::Immediate => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("Immediate", &Option::<()>::None)?;
                m.end()
            }
            RampSpec::RateCap { pct_per_bar, down_pct_per_bar, on_signal_break } => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry(
                    "RateCap",
                    &RateCapPayload {
                        pct_per_bar: *pct_per_bar,
                        down_pct_per_bar: *down_pct_per_bar,
                        on_signal_break: *on_signal_break,
                    },
                )?;
                m.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for RampSpec {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        /// 外部标记形态的原始解（单位变体载荷必须是 `null`）。
        #[derive(serde::Deserialize)]
        enum Raw {
            Immediate(Option<serde::de::IgnoredAny>),
            RateCap(RateCapPayload),
        }
        match Raw::deserialize(d)? {
            Raw::Immediate(_) => Ok(RampSpec::Immediate),
            Raw::RateCap(p) => Ok(RampSpec::RateCap {
                pct_per_bar: p.pct_per_bar,
                down_pct_per_bar: p.down_pct_per_bar,
                on_signal_break: p.on_signal_break,
            }),
        }
    }
}

/// 硬边界维（ADR-029 D5/D8）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GuardSpec {
    /// 目标比例**上界**（强制夹取；分数多高、策略怎么说都不得越过）。
    pub max_pct: f64,
    /// 目标比例**下界**（硬边界：对卖出支同样生效 ⇒ `min_pct > 0` 时目标不落于其下）。
    pub min_pct: f64,
    /// 死区：`|目标 − 当前暴露|` 折算金额 < `max(deadzone_pct × equity, deadzone_min_notional)` ⇒ 不下单。
    ///
    /// **量纲披露（ADR-029 §8.2，登记不改行为）**：死区是**意图 gap 门**，**不是订单规模下限**——
    /// 限速可把单笔订单切到死区之下（E12 有意钉死）；`deadzone_min_notional` 只抬高**门槛**。
    pub deadzone_pct: f64,
    /// 死区**金额门槛**（元，ADR-029 D14）：阈值 = `max(deadzone_pct × equity, deadzone_min_notional)`；
    /// 缺省 `None` ⇒ 纯比例口径（= 现行，**逐字节一致**）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadzone_min_notional: Option<f64>,
}

/// `Exposure` 运行态（ADR-029 D5/D6；每 run 一份，硬止损强平 ⇒ [`PolicyState::reset`]）。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ExposureState {
    /// 上一 bar 的**输出目标股数**（绝对量，R5：中立带保持用，不随净值/价格漂移重算）；
    /// 同时是 `RateCap` 的限速锚点。
    pub last_target_qty: Option<f64>,
    /// 上一 bar 的档位（`sell_transition` 披露用）。
    pub last_branch: Option<TargetBranch>,
    /// 本 bar 限速已用量（股数；`Immediate` 恒 0）。
    pub ramp_used_qty_this_bar: f64,
    /// **现金不可达上限**（ADR-029 D6-6 / R11 / E17）：买入被现金截断后一次性下调到的可达股数；
    /// **只降不升**；清仓（目标 0）或 `reset()` 后释放（镜像 `LumpSum` 的解冻口径）。
    pub affordable_cap_qty: Option<f64>,
    /// 上一**非 Hold** bar 声明的**意图占净值比**（ADR-029 D11/D12；`ScoreMapped` 中立带沿用它继续推进，
    /// 且**不因净值/价格漂移重算**该比例本身）。`None` ⇒ 尚无声明（首个评估 bar 即中立带）。
    /// `reset()`（硬止损强平）随 `exposure` 一并清零（E7 口径）。
    pub last_intent_pct: Option<f64>,
}

/// 每 bar 观测（ADR-029 D7；随既有 `per_bar` 记录通道输出，**不新增事实表**）。
///
/// 口径：`target_pct` / `current_pct` 均以**同一分母**（决策 bar 收盘净值 `equity = cash + qty×close`）
/// 折算 ⇒ `current_pct` 与 [`crate::engine::PositionPoint::position_ratio`] 同点同值。
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct PolicyObservation {
    /// 本 bar **输出目标**占净值比（死区命中 ⇒ = `current_pct`）。
    pub target_pct: Option<f64>,
    /// 本 bar **意图**占净值比（ADR-029 D11；死区/限速**不**影响它）。
    ///
    /// 口径：Buy/Sell 档 = 本 bar 新声明的映射比例（**经 guard 夹取**，P1–P2）；
    /// Hold 档 = 沿用上一非 Hold bar 的声明比例；尚无声明 ⇒ 当前持仓占比。
    /// 比例本身无需换算 ⇒ `price/equity` 非法时仍可读（与 `target_pct` 的口径不同，见 06-plan §2.6）。
    #[serde(default)]
    pub intent_pct: Option<f64>,
    /// 本 bar **当前暴露**占净值比（决策 bar 收盘口径）。
    pub current_pct: Option<f64>,
    /// `RateCap` 的 `pct_per_bar`（非 RateCap ⇒ None，即无速率预算）。
    pub ramp_cap_pct_per_bar: Option<f64>,
    /// 本 bar **下行**速率预算占净值比（ADR-029 D12）：`RateCap` ⇒ `down_pct_per_bar ?? pct_per_bar`；
    /// `Immediate` / 预热 / 旧 run ⇒ `None`。`0` = 下行不限速（配置值原样披露）。
    #[serde(default)]
    pub down_ramp_cap_pct_per_bar: Option<f64>,
    /// 限速步骤（pipeline ⑤）确实压缩了本 bar 目标变动。
    pub rate_limited: bool,
    /// 死区步骤（pipeline ④）命中 ⇒ **本 bar 不产订单**（含中立带保持时 Δ=0 的情形）。
    pub deadzone_blocked: bool,
    /// guard 夹取步骤（pipeline ②）确实改动了映射所得比例。
    pub clamped_by_guard: bool,
    /// 本 bar **跨越卖出档边界**（进入或离开；ADR-029 D7/R6 的跳变披露）。
    pub sell_transition: bool,
    /// 本 bar 目标因**现金不可达**被**一次性下调**到实际可达上限（ADR-029 D6-6 / R11 / E17）。
    pub affordability_capped: bool,
}

/// 单 bar 求值结果（目标 + 观测）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PolicyOutcome {
    /// 目标仓位（股）。引擎订单 = 目标 − 当前。
    pub target_qty: f64,
    /// ADR-029 D7 观测（写 per_bar 记录）。
    pub observation: PolicyObservation,
}

/// 执行策略（ADR §13.1：目标仓位幂等换算）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum ExecutionPolicy {
    /// **ADR-029 Step 1 新增**：正交化三维 —— 目标（`exposure`）× 到达方式（`ramp`）× 硬边界（`guard`）。
    /// 目标按**聚合分**直接计算（`signal` 仅作 UI/披露，D6.6）；求值顺序为 D5 钉死的 pipeline。
    Exposure {
        target: ExposureTarget,
        ramp: RampSpec,
        guard: GuardSpec,
    },
    /// 一次性全量：Buy → 目标 = 净值 × position_pct；Sell → 目标 0。
    LumpSum {
        /// 目标仓位占净值比例，∈ (0, 1]。
        position_pct: f64,
    },
    /// 分批建仓（定投式）。Buy 信号**持续**期间每 `interval` bar 执行一批；
    /// 信号中断 → 剩余批次取消；Buy 信号重新出现 → 重新开始计数（重新规划总额/批次）；
    /// Sell 信号 → 一次性清仓（目标 0）。
    Dca {
        /// 总批次数 N（≥ 1）。
        tranches: usize,
        /// 分批金额模式。
        mode: DcaMode,
        /// FixedAmount 模式的每批金额（Equal 模式忽略）。
        amount: Option<f64>,
        /// 批间隔 k bar（**≥ 1**；省略 = 默认 1 = 每 bar 一批）。第 0 批在 Buy 信号出现当 bar 即触发，
        /// 之后每过 k bar 触发下一批。
        ///
        /// D6（2026-09-19）：字段可省略（serde default = 1，让文档 `interval?: k（默认 1）` 成真）；
        /// **显式 0 不再静默归一化**，由 [`ExecutionPolicy::validate`] fail loud。
        #[serde(default = "default_dca_interval")]
        interval: usize,
    },
}

impl ExecutionPolicy {
    /// 配置校验（引擎启动时调用；非法配置直接拒绝运行）。
    ///
    /// 覆盖 ADR-029 E11 中**不依赖 run 级阈值**的全部规则；依赖阈值的规则（`ScoreMapped`
    /// 的 `buy_threshold < 100 ∧ sell_threshold > 0`）见 [`ExecutionPolicy::validate_with_thresholds`]
    /// （由 `EnsembleConfig::validate` 在阈值可见处调用）。
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ExecutionPolicy::Exposure { target, ramp, guard } => {
                if !guard.min_pct.is_finite()
                    || !guard.max_pct.is_finite()
                    || !guard.deadzone_pct.is_finite()
                {
                    return Err(format!(
                        "Exposure.guard 必须为有限值，got min_pct={} max_pct={} deadzone_pct={}",
                        guard.min_pct, guard.max_pct, guard.deadzone_pct
                    ));
                }
                if guard.min_pct < 0.0 || guard.min_pct > guard.max_pct || guard.max_pct > 1.0 {
                    return Err(format!(
                        "Exposure.guard 必须满足 0 ≤ min_pct ≤ max_pct ≤ 1，got min_pct={} max_pct={}",
                        guard.min_pct, guard.max_pct
                    ));
                }
                if guard.deadzone_pct < 0.0 {
                    return Err(format!(
                        "Exposure.guard.deadzone_pct 必须 ≥ 0，got {}",
                        guard.deadzone_pct
                    ));
                }
                // ADR-029 D14（E23）：`deadzone_min_notional`（元）必须 ≥ 0 且有限（缺省 None = 比例口径）。
                if let Some(m) = guard.deadzone_min_notional {
                    if !m.is_finite() || m < 0.0 {
                        return Err(format!(
                            "Exposure.guard.deadzone_min_notional 必须为 ≥ 0 的有限值（单位：元），got {m}"
                        ));
                    }
                }
                match ramp {
                    RampSpec::Immediate => {}
                    RampSpec::RateCap { pct_per_bar, down_pct_per_bar, .. } => {
                        if !pct_per_bar.is_finite() || *pct_per_bar <= 0.0 {
                            return Err(format!(
                                "Exposure.ramp.RateCap.pct_per_bar 必须为正有限值，got {pct_per_bar}"
                            ));
                        }
                        // ADR-029 D12（E18）：`down_pct_per_bar` 必须 ≥ 0 且有限（0 = 下行不限速；缺省 = 对称）。
                        if let Some(d) = down_pct_per_bar {
                            if !d.is_finite() || *d < 0.0 {
                                return Err(format!(
                                    "Exposure.ramp.RateCap.down_pct_per_bar 必须为 ≥ 0 的有限值（0 = 下行不限速），got {d}"
                                ));
                            }
                        }
                    }
                }
                match target {
                    ExposureTarget::Fixed { pct } => {
                        if !pct.is_finite() || *pct <= 0.0 || *pct > 1.0 {
                            return Err(format!(
                                "Exposure.target.Fixed.pct 必须在 (0,1]，got {pct}"
                            ));
                        }
                    }
                    ExposureTarget::ScoreMapped { at_threshold_pct, at_full_pct, .. } => {
                        if !at_threshold_pct.is_finite() || !at_full_pct.is_finite() {
                            return Err(format!(
                                "Exposure.target.ScoreMapped 的 at_*_pct 必须为有限值，got {at_threshold_pct}/{at_full_pct}"
                            ));
                        }
                        if *at_threshold_pct < 0.0
                            || *at_threshold_pct > 1.0
                            || *at_full_pct < 0.0
                            || *at_full_pct > 1.0
                        {
                            return Err(format!(
                                "Exposure.target.ScoreMapped 的 at_*_pct 必须在 [0,1]，got at_threshold_pct={at_threshold_pct} at_full_pct={at_full_pct}"
                            ));
                        }
                        if *at_full_pct < *at_threshold_pct {
                            return Err(format!(
                                "Exposure.target.ScoreMapped 必须满足 at_full_pct ≥ at_threshold_pct，got {at_full_pct} < {at_threshold_pct}"
                            ));
                        }
                        if *at_full_pct > guard.max_pct {
                            return Err(format!(
                                "Exposure.target.ScoreMapped.at_full_pct 不得超过 guard.max_pct（D8：策略/分数无权覆盖 guard），got {at_full_pct} > {}",
                                guard.max_pct
                            ));
                        }
                    }
                }
                Ok(())
            }
            ExecutionPolicy::LumpSum { position_pct } => {
                if !position_pct.is_finite() || *position_pct <= 0.0 || *position_pct > 1.0 {
                    return Err(format!(
                        "LumpSum.position_pct 必须在 (0,1]，got {position_pct}"
                    ));
                }
                Ok(())
            }
            ExecutionPolicy::Dca {
                tranches,
                mode,
                amount,
                interval,
            } => {
                if *tranches == 0 {
                    return Err("Dca.tranches 必须 ≥ 1".to_string());
                }
                // D6（2026-09-19）：显式 `interval=0` = 非法配置，**fail loud**（不再静默当 1）；
                // 省略字段由 serde default 落为 1，故此处只见「调用方显式传了 0」。
                if *interval == 0 {
                    return Err(
                        "Dca.interval 必须 ≥ 1（省略即为默认 1）".to_string(),
                    );
                }
                if *mode == DcaMode::FixedAmount {
                    match amount {
                        Some(a) if a.is_finite() && *a > 0.0 => {}
                        _ => return Err("Dca FixedAmount 模式必须提供正有限 amount".to_string()),
                    }
                }
                Ok(())
            }
        }
    }

    /// 阈值相关校验（ADR-029 E11：`ScoreMapped` 需 `buy_threshold < 100 ∧ sell_threshold > 0`，
    /// 否则映射分母为 0 ⇒ 无定义）。
    ///
    /// **只约束 `ScoreMapped`**：`LumpSum`/`Dca`/`Fixed` 与阈值无关 ⇒ 不受影响
    /// （历史 run 的 `buy_threshold`/`sell_threshold` 任意取值均可复现，ADR-029 D2/D10）。
    pub fn validate_with_thresholds(
        &self,
        buy_threshold: f64,
        sell_threshold: f64,
    ) -> Result<(), String> {
        self.validate()?;
        if !matches!(
            self,
            ExecutionPolicy::Exposure { target: ExposureTarget::ScoreMapped { .. }, .. }
        ) {
            return Ok(());
        }
        if !buy_threshold.is_finite() || buy_threshold >= 100.0 {
            return Err(format!(
                "ScoreMapped 需要 buy_threshold < 100（映射分母 100−buy_threshold 须非零），got {buy_threshold}"
            ));
        }
        if !sell_threshold.is_finite() || sell_threshold <= 0.0 {
            return Err(format!(
                "ScoreMapped 需要 sell_threshold > 0（Scaled 降档分母须非零），got {sell_threshold}"
            ));
        }
        if buy_threshold <= sell_threshold {
            return Err(format!(
                "buy_threshold 必须严格大于 sell_threshold，got {buy_threshold} <= {sell_threshold}"
            ));
        }
        Ok(())
    }
}

/// DCA 批间隔的 serde 缺省值 = 1（文档契约 `interval?: k（默认 1）` ⇒ 字段可省略且省略等价 1）。
/// 注意：**必须**用显式 default 函数而非裸 `#[serde(default)]`——后者对 `usize` 给 0，
/// 而 0 是非法值（会反过来触发 validate fail loud）。
const fn default_dca_interval() -> usize {
    1
}

/// 批间隔归一化（**纵深防御**，非「静默修正」）：
/// [`ExecutionPolicy::validate`] 已保证 `interval ≥ 1`（显式 0 → fail loud；省略 → serde default 1）。
/// 此处仅为「绕过 validate 直接进入目标换算」的调用方兜底，**不**再作为非法输入的合法化通道。
fn norm_interval(interval: usize) -> usize {
    interval.max(1)
}

/// Policy 运行态（每 run 一份；DCA 批次计数/计划基线 + LumpSum 冻结股数目标）。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PolicyState {
    pub(crate) dca: Option<DcaState>,
    /// LumpSum 冻结股数目标：Buy 信号建立时快照（ADR §13.1 MAJOR-1 裁决）；
    /// 信号中断（Hold/Sell）/ 硬止损强平（[`PolicyState::reset`]）后解冻。
    pub(crate) lump_frozen: Option<f64>,
    /// ADR-029 `Exposure` 路径状态（上一输出目标股数 / 档位 / 本 bar 限速用量）。
    pub(crate) exposure: Option<ExposureState>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DcaState {
    /// 本轮 Buy 信号持续的 bar 数（含当前 bar）。
    pub(crate) bars_in_run: usize,
    /// 已执行批次数。
    pub(crate) batches_done: usize,
    /// 本轮起点持仓（股）——目标仓位 = base_qty + 累计批次股数，保证幂等换算。
    pub(crate) base_qty: f64,
    /// 累计批次股数（按各批次决策 bar 的 close 换算）。
    pub(crate) accumulated_qty: f64,
    /// Equal 模式计划总额（本轮起点净值快照）。
    pub(crate) plan_total: f64,
}

impl PolicyState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 外部中断复位（ADR §13.1 MAJOR-2 裁决）：硬止损强平 = 外部中断——
    /// DCA 批次/基线与 LumpSum 冻结快照全部清零（与 Trailing 峰值 reset 对齐），
    /// 强平后首个 Buy 重新计数批次 / 重新快照，禁止以陈旧状态一次性重建仓。
    ///
    /// ADR-029 E7：`Exposure` 路径状态（上一目标/档位/限速用量）**同口径全清** ⇒
    /// 强平后限速锚点回落到实际暴露，而非续用强平前的旧目标。
    pub fn reset(&mut self) {
        self.dca = None;
        self.lump_frozen = None;
        self.exposure = None;
    }

    /// 成交 affordability 钳制（引擎在 Policy 买入成交后调用）：买入被现金上限截断时
    /// （如 position_pct=1.0 佣金使实得股数 < 冻结目标），冻结目标下调至实际持仓，
    /// 避免对不可达缺口每 bar 重复挂微单。只降不升；非 LumpSum 冻结态为 no-op。
    ///
    pub(crate) fn clamp_lump_frozen(&mut self, realized_qty: f64) {
        if let Some(f) = &mut self.lump_frozen {
            if realized_qty < *f {
                *f = realized_qty;
            }
        }
    }

    /// **现金不可达下调**（ADR-029 D6-6 / R11 / E17）：引擎在**买入被现金上限截断**后调用
    /// （`need > cash` 或买入后现金归零）——把 `ScoreMapped` 的目标上限一次性下调到实际可达股数，
    /// 使后续 bar 的目标 = 可达上限（订单增量 0）而不对不可达缺口每 bar 重复挂微单。
    ///
    /// - **只降不升**：更高的实得不得上调上限；
    /// - 仅作用于 `Exposure` 运行态（`Fixed`/`LumpSum` 的等价机制是 [`PolicyState::clamp_lump_frozen`]
    ///   的冻结目标下调 ⇒ 不重复叠加）；
    /// - 释放：清仓（目标 0）或 [`PolicyState::reset`]。
    pub(crate) fn clamp_exposure_affordable(&mut self, realized_qty: f64) {
        let st = self.exposure.get_or_insert_with(ExposureState::default);
        st.affordable_cap_qty = Some(match st.affordable_cap_qty {
            Some(c) => c.min(realized_qty),
            None => realized_qty,
        });
    }

    /// 信号 → 目标仓位（股）。幂等：重复信号产生相同目标 → 订单增量为 0。
    ///
    /// - `equity`：决策 bar 收盘净值（现金 + 持仓×close）；
    /// - `price`：决策 bar 收盘价（目标仓位换算基准价；实际成交在次 bar open，口径差异见 crate 文档）；
    /// - `current_qty`：当前实际持仓（股）。
    ///
    /// **ADR-029 备注**：本入口**不含聚合分**，`Exposure` 目标无法计算 ⇒ 等价于
    /// `score = 50`（中立）+ 默认阈值 60/40 ⇒ 落在中立带 ⇒ **保持上一目标**。
    /// `Exposure` 只能经 [`PolicyState::target_qty_with_score`] 使用（供后人避坑）。
    pub fn target_qty(
        &mut self,
        policy: &ExecutionPolicy,
        signal: super::TradeSignal,
        equity: f64,
        price: f64,
        current_qty: f64,
    ) -> f64 {
        let out = self.target_qty_with_score(
            policy,
            signal,
            NEUTRAL_SCORE,
            DEFAULT_BUY_THRESHOLD,
            DEFAULT_SELL_THRESHOLD,
            equity,
            price,
            current_qty,
        );
        out.target_qty
    }

    /// 信号 + **聚合分** → 目标仓位（股）+ 每 bar 观测（ADR-029 D3/D5/D7）。
    ///
    /// - `score`：聚合分（仅 `Exposure` 使用；**旧变体忽略该参数**，行为不变，D2/D10）；
    /// - `buy_threshold`/`sell_threshold`：run 级阈值（`ScoreMapped` 的映射端点与分档依据；
    ///   旧变体忽略）；
    /// - pipeline 顺序（ADR-029 D5 → Step 1.5 **保序扩展**为 P1–P8，**顺序即契约**）：
    ///   P1 分→**意图比例**（分数先夹 [0,100]）→ P2 `guard` 夹取 → P3 换算**意图股数**
    ///   → P4 路径推进（`desired`）→ P5 affordability（仅 `ScoreMapped`）→ P6 死区
    ///   （阈值 = `max(deadzone_pct × equity, deadzone_min_notional)`；
    ///   `desired == 0 ∧ current_qty > 0` **豁免**）
    ///   → P7 限速（非对称：上行 `pct_per_bar`、下行 `down_pct_per_bar`）
    ///   → P8 输出目标（死区命中 ⇒ 当前持仓 = 零订单）。
    ///   引擎按下单（目标 − 当前）挂单、再记录观测。
    pub fn target_qty_with_score(
        &mut self,
        policy: &ExecutionPolicy,
        signal: super::TradeSignal,
        score: f64,
        buy_threshold: f64,
        sell_threshold: f64,
        equity: f64,
        price: f64,
        current_qty: f64,
    ) -> PolicyOutcome {
        match policy {
            ExecutionPolicy::Exposure { target, ramp, guard } => self.exposure_outcome(
                target,
                ramp,
                guard,
                score,
                buy_threshold,
                sell_threshold,
                equity,
                price,
                current_qty,
            ),
            ExecutionPolicy::LumpSum { position_pct } => {
                let qty = self.lump_target(*position_pct, signal, equity, price, current_qty);
                PolicyOutcome {
                    target_qty: qty,
                    observation: legacy_observation(qty, equity, price, current_qty),
                }
            }
            ExecutionPolicy::Dca {
                tranches,
                mode,
                amount,
                interval,
            } => {
                let qty = self.dca_target(
                    *tranches,
                    *mode,
                    *amount,
                    *interval,
                    signal,
                    equity,
                    price,
                    current_qty,
                );
                PolicyOutcome {
                    target_qty: qty,
                    observation: legacy_observation(qty, equity, price, current_qty),
                }
            }
        }
    }

    /// `Exposure` 求值（ADR-029 D3–D5 pipeline 唯一实现）。
    #[allow(clippy::too_many_arguments)]
    fn exposure_outcome(
        &mut self,
        target: &ExposureTarget,
        ramp: &RampSpec,
        guard: &GuardSpec,
        score: f64,
        buy_threshold: f64,
        sell_threshold: f64,
        equity: f64,
        price: f64,
        current_qty: f64,
    ) -> PolicyOutcome {
        // 分数先夹 [0,100]；非有限（缺失/aggregate 非有限）⇒ 中立 50（G5 口径）⇒ 中立带不动目标。
        let s = if score.is_finite() { score.clamp(0.0, 100.0) } else { NEUTRAL_SCORE };
        // 档位：与 `classify` 同端点（buy 含等号、sell 含等号）。
        let branch = if s >= buy_threshold {
            TargetBranch::Buy
        } else if s <= sell_threshold {
            TargetBranch::Sell
        } else {
            TargetBranch::Hold
        };
        let prev_branch = self.exposure.and_then(|st| st.last_branch);
        // 跳变披露（R6/D7）：**跨越卖出档边界**（进或出）的 bar。
        let sell_transition = prev_branch
            .is_some_and(|p| (p == TargetBranch::Sell) != (branch == TargetBranch::Sell));

        // 信号中断语义（ADR-029 D12）：缺省 `Pause`；`Immediate` 恒 `Pause`（兼容铁律，见
        // `RampSpec::on_signal_break` 的文档）。
        let on_break = ramp.on_signal_break();
        // 上一**非 Hold** bar 声明的意图比例（D11：中立带沿用它，不因净值/价格漂移重算该比例本身）。
        let prev_intent_pct = self.exposure.and_then(|st| st.last_intent_pct);
        // 可换算性（P3 防御面）：与现行**同一**判据（不得放宽/收紧）。
        let convertible = price > 0.0 && price.is_finite() && equity.is_finite();

        // ── P1 分数 → 意图比例；P2 guard 夹取；P3 换算意图股数（06-plan §2.2–2.3） ──
        let mut clamped_by_guard = false;
        // 清仓意图（映射比例 ≤ 0）⇒ 释放现金不可达上限（ADR-029 D6-6：清仓结束持有周期，
        // 现金回笼 ⇒ 下一周期按目标重新建仓；镜像 LumpSum 的 Sell/Hold 解冻口径）。
        let mut liquidation_intent = false;
        // 本 bar **新声明**的意图比例（`Hold` 档 ⇒ `None`：沿用上一非 Hold bar，不覆写）。
        let mut declared_intent_pct: Option<f64> = None;
        // 意图股数（P3）与意图占净值比（观测键 D11）。
        let (intent_qty, intent_pct_obs): (f64, Option<f64>) = match target {
            ExposureTarget::Fixed { pct } => {
                // R2：`Fixed` 等价现行 LumpSum 的目标语义（含冻结/解冻/`Hold ⇒ 目标 = 当前`）；
                // guard 先夹比例再换算。
                //
                // 注（与 LumpSum 的**唯一**可观测差异，且仅在中立带 + 限速同现时）：
                // `Hold` 分支的期望值 = 当前持仓，随后 P7 会把它相对**上一输出目标**限速推进
                // ⇒ 若期间发生过部分成交（当前 ≠ 上一目标），本 bar 可能产生一笔朝当前持仓收敛的小单。
                // `Immediate` 路径无 P7 ⇒ 与 LumpSum 逐位等价（E13）；死区（P6）亦会先行吸收小差。
                //
                // `Continue`（仅 `RateCap` 可达）下 `Hold` **不解冻**（保留冻结目标继续推进，§2.4）。
                let eff = clamp_pct(*pct, guard);
                clamped_by_guard = eff.to_bits() != pct.to_bits();
                let qty = if branch == TargetBranch::Hold
                    && on_break == OnSignalBreak::Continue
                {
                    self.lump_frozen.unwrap_or(current_qty)
                } else {
                    self.lump_target(eff, branch_signal(branch), equity, price, current_qty)
                };
                (qty, pct_of_nav(qty, equity, price))
            }
            ExposureTarget::ScoreMapped {
                at_threshold_pct,
                at_full_pct,
                sell,
            } => {
                // P1：Buy/Sell 档 = 本 bar **新声明**（端点钉死 / Scaled 线性）；
                //     Hold 档 = 沿用上一非 Hold bar 的声明比例（无声明 ⇒ 当前持仓占比 = 零订单）。
                let raw_pct = match branch {
                    TargetBranch::Buy => Some(
                        // 端点钉死：score=buy_threshold ⇒ at_threshold_pct；score=100 ⇒ at_full_pct。
                        at_threshold_pct
                            + (s - buy_threshold) / (100.0 - buy_threshold)
                                * (at_full_pct - at_threshold_pct),
                    ),
                    TargetBranch::Sell => Some(match sell {
                        // Flat：清仓。
                        SellPolicy::Flat => 0.0,
                        // Scaled（R6）：线性 (score=0 ⇒ 0) … (score=sell_threshold ⇒ at_threshold_pct)。
                        SellPolicy::Scaled => at_threshold_pct * s / sell_threshold,
                    }),
                    TargetBranch::Hold => None,
                };
                let intent_pct = match raw_pct {
                    Some(raw) => {
                        // P2：guard 夹取（`min_pct` 只约束持有态；清仓意图可达，R9/E15）。
                        let eff = clamp_pct(raw, guard);
                        clamped_by_guard = eff.to_bits() != raw.to_bits();
                        liquidation_intent = raw <= 0.0;
                        declared_intent_pct = Some(eff);
                        Some(eff)
                    }
                    None => prev_intent_pct.or_else(|| pct_of_nav(current_qty, equity, price)),
                };
                // P3：换算意图股数（price/equity 非法 ⇒ = 当前持仓，防御面不造数）。
                let qty = match intent_pct {
                    Some(r) if convertible => r * equity / price,
                    _ => current_qty,
                };
                (qty, intent_pct)
            }
        };

        // ── P4 路径推进（§2.4）：`anchor` = 上一输出目标股数（首 bar = 当前持仓） ──
        // Buy/Sell（有新声明）⇒ desired = 意图股数；Hold + `Pause` ⇒ `ScoreMapped` 冻结绝对股数（R5）、
        // `Fixed` 现行解冻口径（= 当前持仓）；Hold + `Continue` ⇒ 继续朝意图推进。
        let anchor = self
            .exposure
            .and_then(|st| st.last_target_qty)
            .unwrap_or(current_qty);
        let mut desired_qty = match (branch, target, on_break) {
            (TargetBranch::Hold, ExposureTarget::ScoreMapped { .. }, OnSignalBreak::Pause) => anchor,
            _ => intent_qty,
        };

        // ── P5 现金不可达上限（ADR-029 D6-6 / R11 / E17）：目标**只可下调**到可达上限 ──
        // 仅约束 `ScoreMapped`：`Fixed` 的等价机制是 `lump_frozen` 冻结目标下调（`clamp_lump_frozen`）。
        let mut affordability_capped = false;
        if matches!(target, ExposureTarget::ScoreMapped { .. }) {
            if let Some(cap) = self.exposure.and_then(|st| st.affordable_cap_qty) {
                if cap < desired_qty {
                    desired_qty = cap;
                    affordability_capped = true;
                }
            }
        }

        // ── P6 死区（§2.5）：|目标 − 当前| 折算金额 < max(deadzone_pct × equity, deadzone_min_notional) ⇒ 无订单 ──
        // 缺省 `None` ⇒ 纯比例口径（**逐字节**等价现行：不引入 `max(…, 0)`）。
        let deadzone_amount = guard.deadzone_pct * equity;
        let deadzone_threshold = match guard.deadzone_min_notional {
            Some(m) => deadzone_amount.max(m),
            None => deadzone_amount,
        };
        // ★ 清仓豁免（D13/E20；**2026-09-29 E25 收口**）：仅当 **`desired == 0.0` ∧ `current_qty > 0.0`**
        // ——即**正在朝清仓推进且仍有残仓**——死区**不适用**（不置 deadzone_blocked）。
        // 理由：死区是「反对噪声」，而清仓是**明确意图**；被吃掉的尾段会让「可清零」结构性不成立（F3/000023）。
        // **为何要加 `current_qty > 0.0`**：已空仓且锚点 = 0 的中立带 bar（`desired = 锚点 = 0`）**本无单可下**
        // ⇒ 若一并判成「豁免」，则 `deadzone_blocked` 会由旧 run 的 `true` 翻为 `false`（仅观测位/审计计数变、
        // 成交不变）⇒ 破坏历史 run 的**观测级**复现（独立复验实测：000023 104/178 bar、000025 10/178 bar）。
        // 故该情形**保留旧观测**（`|desired − current| = 0 < 死区` ⇒ 命中），语义与收口前逐字节一致。
        // 量纲披露（§8.2）：死区是**意图 gap 门**而非订单规模下限 ⇒ 限速仍可把单笔订单切到死区之下（E12）。
        let liquidation_with_residual = desired_qty == 0.0 && current_qty > 0.0;
        let deadzone_hit = !liquidation_with_residual
            && price > 0.0
            && price.is_finite()
            && equity.is_finite()
            && (desired_qty - current_qty).abs() * price < deadzone_threshold;

        // ── P7 限速（§2.4）：**非对称** —— 上行预算 = `pct_per_bar`；下行预算 = `down_pct_per_bar ?? pct_per_bar`
        //     （`0` ⇒ 下行无预算 = 本 bar 直达 desired，**仍不得越过 desired**）。金额口径 = `pct × equity / price`。
        //     `price/equity` 非法 ⇒ 双向预算 0（防御面：无价不挪动，与现行同一退化口径）。
        let (ramp_cap_pct_per_bar, down_ramp_cap_pct_per_bar, rate_limited, ramped_qty) = match ramp {
            RampSpec::Immediate => (None, None, false, desired_qty),
            RampSpec::RateCap { pct_per_bar, .. } => {
                let down_pct = ramp.down_pct_per_bar().unwrap_or(*pct_per_bar);
                let (up_cap_qty, down_cap_qty) = if convertible {
                    (
                        pct_per_bar * equity / price,
                        if down_pct == 0.0 {
                            // 下行**无预算**：不是「无约束的任意目标」，而是「本 bar 可走到 desired」
                            // ⇒ 用 `-inf` 作下界，`clamp` 保证**不越过 desired**。
                            f64::INFINITY
                        } else {
                            down_pct * equity / price
                        },
                    )
                } else {
                    (0.0, 0.0)
                };
                let diff = desired_qty - anchor;
                let step = diff.clamp(-down_cap_qty, up_cap_qty);
                (
                    Some(*pct_per_bar),
                    Some(down_pct),
                    step != diff,
                    anchor + step,
                )
            }
        };

        // ── P6 ⇒ P8：死区命中则不产订单（输出目标 = 当前持仓，订单增量 0）；否则输出限速后目标 ──
        // 上限对**输出目标**同样生效（D6-1：ramp 只决定靠近速率，不得越过上限）：限速锚点可能高于
        // 现金不可达上限（上一次声明目标）⇒ 若不夹取，会连续若干 bar 声明不可达目标（微单）。
        let output_qty = if affordability_capped {
            ramped_qty.min(desired_qty)
        } else {
            ramped_qty
        };
        let target_qty = if deadzone_hit { current_qty } else { output_qty };

        // ── P8 记录观测 ──
        let st = self.exposure.get_or_insert_with(ExposureState::default);
        if liquidation_intent {
            // 清仓 ⇒ 释放上限（仅清仓意图；部分降档不清，以守**只降不升**）
            st.affordable_cap_qty = None;
        }
        st.last_target_qty = Some(target_qty);
        st.last_branch = Some(branch);
        // D11：仅**新声明**写入（Hold 沿用不覆写 ⇒ 中立带不会「自我续期」漂移意图）。
        if let Some(r) = declared_intent_pct {
            st.last_intent_pct = Some(r);
        }
        st.ramp_used_qty_this_bar = if matches!(ramp, RampSpec::Immediate) {
            0.0
        } else {
            (ramped_qty - anchor).abs()
        };
        let observation = PolicyObservation {
            target_pct: pct_of_nav(target_qty, equity, price),
            intent_pct: intent_pct_obs,
            current_pct: pct_of_nav(current_qty, equity, price),
            ramp_cap_pct_per_bar,
            down_ramp_cap_pct_per_bar,
            rate_limited,
            deadzone_blocked: deadzone_hit,
            clamped_by_guard,
            sell_transition,
            affordability_capped,
        };
        PolicyOutcome { target_qty, observation }
    }

    /// LumpSum / `Exposure{Fixed}` **同源**目标口径（冻结快照/解冻/目标=当前）。
    fn lump_target(
        &mut self,
        position_pct: f64,
        signal: super::TradeSignal,
        equity: f64,
        price: f64,
        current_qty: f64,
    ) -> f64 {
        match signal {
            // 冻结口径（ADR §13.1 MAJOR-1 裁决）：Buy 信号建立时快照并冻结；
            // Buy 持续期目标恒为冻结值（不因净值/费用漂移重算，重复信号订单增量为 0）。
            TradeSignal::Buy => {
                if self.lump_frozen.is_none() {
                    self.lump_frozen = Some(equity * position_pct / price);
                }
                self.lump_frozen.expect("lump target just frozen")
            }
            // Sell → 目标 0 并解冻。
            TradeSignal::Sell => {
                self.lump_frozen = None;
                0.0
            }
            // Hold → 目标 = 当前（无订单）并解冻；次个 Buy 重新快照。
            TradeSignal::Hold => {
                self.lump_frozen = None;
                current_qty
            }
        }
    }

    /// DCA 求值（AD 语义逐字节不变）。
    #[allow(clippy::too_many_arguments)]
    fn dca_target(
        &mut self,
        tranches: usize,
        mode: DcaMode,
        amount: Option<f64>,
        interval: usize,
        signal: super::TradeSignal,
        equity: f64,
        price: f64,
        current_qty: f64,
    ) -> f64 {
        match signal {
            TradeSignal::Buy => {
                let k = norm_interval(interval);
                if self.dca.is_none() {
                    self.dca = Some(DcaState {
                        bars_in_run: 0,
                        batches_done: 0,
                        base_qty: current_qty,
                        accumulated_qty: 0.0,
                        plan_total: equity,
                    });
                }
                let st = self.dca.as_mut().expect("dca state just initialized");
                // allow：usize::is_multiple_of 稳定于 rust 1.87，超出 workspace MSRV 1.85。
                #[allow(clippy::manual_is_multiple_of)]
                if st.bars_in_run % k == 0 && st.batches_done < tranches {
                    let batch_amount = match mode {
                        DcaMode::Equal => st.plan_total / tranches as f64,
                        DcaMode::FixedAmount => amount.expect("validated"),
                    };
                    st.accumulated_qty += batch_amount / price;
                    st.batches_done += 1;
                }
                st.bars_in_run += 1;
                st.base_qty + st.accumulated_qty
            }
            TradeSignal::Hold => {
                self.dca = None;
                current_qty
            }
            TradeSignal::Sell => {
                self.dca = None;
                0.0
            }
        }
    }
}

/// guard 夹取（pipeline ②）：`0 ≤ min_pct ≤ max_pct ≤ 1` 由 [`ExecutionPolicy::validate`] 保证。
///
/// **`min_pct` 只约束持有态目标**（ADR-029 D5 / R9 / E15）：映射给出的**清仓意图（比例 ≤ 0）**
/// 必须可达 ⇒ 0 不被下界抬升（否则“永不空仓”，与清仓/硬止损语义冲突）；`max_pct` 始终生效。
fn clamp_pct(pct: f64, guard: &GuardSpec) -> f64 {
    if !pct.is_finite() {
        return pct;
    }
    let capped = pct.min(guard.max_pct);
    if pct <= 0.0 {
        capped
    } else {
        capped.max(guard.min_pct)
    }
}

/// 决策 bar 净值口径的比例（`equity`/`price` 非法 ⇒ None，不造数）。
fn pct_of_nav(qty: f64, equity: f64, price: f64) -> Option<f64> {
    if equity > 0.0 && equity.is_finite() && price.is_finite() {
        Some(qty * price / equity)
    } else {
        None
    }
}

/// 档位 → 信号（`Fixed` 复用 LumpSum 目标语义时使用；两者端点同构 ⇒ 等价）。
fn branch_signal(branch: TargetBranch) -> TradeSignal {
    match branch {
        TargetBranch::Buy => TradeSignal::Buy,
        TargetBranch::Sell => TradeSignal::Sell,
        TargetBranch::Hold => TradeSignal::Hold,
    }
}

/// 旧变体（`LumpSum`/`Dca`）的观测：无 guard/死区/限速语义（恒 false），但目标/当前占比可读
/// （供审计披露复用；**不影响任何目标换算与订单**）。
fn legacy_observation(qty: f64, equity: f64, price: f64, current_qty: f64) -> PolicyObservation {
    PolicyObservation {
        target_pct: pct_of_nav(qty, equity, price),
        current_pct: pct_of_nav(current_qty, equity, price),
        ..PolicyObservation::default()
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::aggregate::TradeSignal;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "expected {b}, got {a}");
    }

    // ---- LumpSum（ADR §13.1 幂等换算）----

    #[test]
    fn lump_sum_buy_target_is_pct_of_equity() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::LumpSum { position_pct: 0.8 };
        // 净值 100_000 × 0.8 / 价 10 = 8000 股
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0),
            8_000.0,
        );
    }

    #[test]
    fn lump_sum_repeated_buy_is_idempotent() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::LumpSum { position_pct: 1.0 };
        let t1 = st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0);
        // 重复 Buy 信号（仓位已到 10_000，净值不变）：目标不变 → 订单 = 目标 − 当前 = 0
        let t2 = st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 10_000.0);
        close(t1, t2);
        close(t2 - 10_000.0, 0.0);
    }

    #[test]
    fn lump_sum_sell_target_zero_hold_keeps_current() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::LumpSum { position_pct: 1.0 };
        close(
            st.target_qty(&p, TradeSignal::Sell, 100_000.0, 10.0, 5_000.0),
            0.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Hold, 100_000.0, 10.0, 5_000.0),
            5_000.0,
        );
    }

    // ---- DCA Equal 批次序列（interval=1）----

    #[test]
    fn dca_equal_batches_split_plan_total() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::Dca {
            tranches: 3,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        };
        // 起点净值 90_000 → 每批 30_000，价 10 → 每批 3000 股
        close(
            st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 0.0),
            3_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 3_000.0),
            6_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 6_000.0),
            9_000.0,
        );
        // 批次用尽后继续 Buy：目标不变（幂等）
        close(
            st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 9_000.0),
            9_000.0,
        );
    }

    #[test]
    fn dca_equal_plan_total_snapshotted_at_run_start() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        };
        // 计划总额 = 起点净值 80_000，每批 40_000；第二 bar 净值变了也不改计划
        close(
            st.target_qty(&p, TradeSignal::Buy, 80_000.0, 10.0, 0.0),
            4_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 95_000.0, 10.0, 4_000.0),
            8_000.0,
        );
    }

    // ---- DCA 中断取消 / 重启重新计数（任务书口径）----

    #[test]
    fn dca_hold_interrupts_and_cancels_remaining_batches() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::Dca {
            tranches: 3,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        };
        close(
            st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 0.0),
            3_000.0,
        );
        // Hold 中断：目标 = 当前（无订单），剩余批次取消
        close(
            st.target_qty(&p, TradeSignal::Hold, 91_000.0, 10.0, 3_000.0),
            3_000.0,
        );
        // Buy 重新出现 → 重新开始计数：新一轮第 1 批（以当前持仓为基线累加）
        // 新起点净值 91_000 → 每批 30_333.33 → 价 10 → 3033.33 股；目标 = 3000 + 3033.33
        let t = st.target_qty(&p, TradeSignal::Buy, 91_000.0, 10.0, 3_000.0);
        close(t, 3_000.0 + 91_000.0 / 3.0 / 10.0);
    }

    #[test]
    fn dca_sell_liquidates_all_and_resets() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::Dca {
            tranches: 3,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        };
        st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 0.0);
        // Sell → 一次性清仓（目标 0），状态复位
        close(
            st.target_qty(&p, TradeSignal::Sell, 90_000.0, 10.0, 3_000.0),
            0.0,
        );
        // Sell 后 Buy → 全新一轮（base 0）
        close(
            st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 0.0),
            3_000.0,
        );
    }

    // ---- DCA interval ----

    #[test]
    fn dca_interval_fires_every_k_bars() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::Equal,
            amount: None,
            interval: 2,
        };
        // bar0（run 内第 0 bar）→ 第 1 批；bar1 不触发；bar2 → 第 2 批
        close(
            st.target_qty(&p, TradeSignal::Buy, 60_000.0, 10.0, 0.0),
            3_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 60_000.0, 10.0, 3_000.0),
            3_000.0,
        ); // 无新批
        close(
            st.target_qty(&p, TradeSignal::Buy, 60_000.0, 10.0, 3_000.0),
            6_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 60_000.0, 10.0, 6_000.0),
            6_000.0,
        );
    }

    // ---- DCA FixedAmount ----

    #[test]
    fn dca_fixed_amount_batches() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::FixedAmount,
            amount: Some(5_000.0),
            interval: 1,
        };
        // 每批固定 5_000 元，价 10 → 500 股
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0),
            500.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 500.0),
            1_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 1_000.0),
            1_000.0,
        );
    }

    // ---- LumpSum 冻结口径（ADR §13.1 MAJOR-1 裁决）----

    #[test]
    fn lump_sum_buy_freezes_target_against_equity_drift() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::LumpSum { position_pct: 0.8 };
        // Buy 信号建立：冻结 100_000×0.8/10 = 8000 股
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0),
            8_000.0,
        );
        // Buy 持续期：净值/费用漂移不得重算——目标恒为冻结值
        close(
            st.target_qty(&p, TradeSignal::Buy, 95_000.0, 10.0, 8_000.0),
            8_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Buy, 120_000.0, 12.0, 8_000.0),
            8_000.0,
        );
    }

    #[test]
    fn lump_sum_hold_unfreezes_and_next_buy_resnapshots() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::LumpSum { position_pct: 0.8 };
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0),
            8_000.0,
        );
        // Hold 中断 → 解冻，目标 = 当前（无订单）
        close(
            st.target_qty(&p, TradeSignal::Hold, 95_000.0, 10.0, 8_000.0),
            8_000.0,
        );
        // 中断后首个 Buy → 按新净值重新快照（90_000×0.8/10 = 7200，非旧冻结值 8000）
        close(
            st.target_qty(&p, TradeSignal::Buy, 90_000.0, 10.0, 8_000.0),
            7_200.0,
        );
    }

    #[test]
    fn lump_sum_sell_unfreezes() {
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::LumpSum { position_pct: 0.8 };
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0),
            8_000.0,
        );
        close(
            st.target_qty(&p, TradeSignal::Sell, 90_000.0, 10.0, 8_000.0),
            0.0,
        );
        // Sell 后首个 Buy → 新快照 50_000×0.8/10 = 4000
        close(
            st.target_qty(&p, TradeSignal::Buy, 50_000.0, 10.0, 0.0),
            4_000.0,
        );
    }

    #[test]
    fn policy_state_reset_clears_lump_freeze_and_dca() {
        // MAJOR-2：硬止损强平 = 外部中断 → PolicyState 复位。
        let mut st = PolicyState::new();
        let lump = ExecutionPolicy::LumpSum { position_pct: 0.8 };
        st.target_qty(&lump, TradeSignal::Buy, 100_000.0, 10.0, 0.0);
        st.reset();
        // 复位后 Buy → 重新快照（非旧冻结值）
        close(
            st.target_qty(&lump, TradeSignal::Buy, 60_000.0, 10.0, 0.0),
            4_800.0,
        );

        let mut st = PolicyState::new();
        let dca = ExecutionPolicy::Dca {
            tranches: 4,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1,
        };
        st.target_qty(&dca, TradeSignal::Buy, 100_000.0, 10.0, 0.0);
        st.target_qty(&dca, TradeSignal::Buy, 100_000.0, 10.0, 2_500.0);
        st.reset();
        // 复位后 Buy → 全新一轮第 1 批（60_000/4/10 = 1500），而非续用旧批次
        close(
            st.target_qty(&dca, TradeSignal::Buy, 60_000.0, 10.0, 0.0),
            1_500.0,
        );
    }

    #[test]
    fn clamp_lump_frozen_caps_unreachable_target() {
        // 成交被现金上限截断（pct=1.0 时佣金使实得股数 < 冻结目标）→ 冻结目标下调至实得，
        // 避免对不可达缺口每 bar 重复挂微单。
        let mut st = PolicyState::new();
        let p = ExecutionPolicy::LumpSum { position_pct: 1.0 };
        close(
            st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0),
            10_000.0,
        );
        st.clamp_lump_frozen(9_995.5);
        close(
            st.target_qty(&p, TradeSignal::Buy, 99_955.0, 10.0, 9_995.5),
            9_995.5,
        );
        // 钳制只降不升：更高实得不得上调冻结目标
        st.clamp_lump_frozen(12_000.0);
        close(
            st.target_qty(&p, TradeSignal::Buy, 99_955.0, 10.0, 9_995.5),
            9_995.5,
        );
    }

    // ---- 配置校验 ----

    #[test]
    fn policy_validation() {
        assert!(ExecutionPolicy::LumpSum { position_pct: 0.0 }
            .validate()
            .is_err());
        assert!(ExecutionPolicy::LumpSum { position_pct: 1.5 }
            .validate()
            .is_err());
        assert!(ExecutionPolicy::LumpSum { position_pct: 0.5 }
            .validate()
            .is_ok());
        assert!(ExecutionPolicy::Dca {
            tranches: 0,
            mode: DcaMode::Equal,
            amount: None,
            interval: 1
        }
        .validate()
        .is_err());
        // FixedAmount 缺 amount → 非法
        assert!(ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::FixedAmount,
            amount: None,
            interval: 1
        }
        .validate()
        .is_err());
        // D6（2026-09-19 契约变更，fail loud）：旧断言把 `interval=0` 编码为「按默认 1 处理」
        // —— 那正是本单要修的静默归一化缺陷。断言按**新契约**翻转（拒绝 0），
        // 明细见 `dca_interval_zero_is_rejected_loudly`。
        let err = ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::FixedAmount,
            amount: Some(100.0),
            interval: 0,
        }
        .validate()
        .expect_err("interval=0 必须拒绝（不再静默归一化为 1）");
        assert!(err.contains("Dca.interval"), "错误须指明字段：{err}");
    }

    // ---- D6：Dca.interval 语义与校验 ----
    // 契约：① 显式 0 → fail loud（复用 policy 校验错误码体系）；② 省略 → 默认 1（让文档成真）；
    //       ③ interval ≥ 1 的行为与数值一律不变。

    /// 契约①：显式 `interval=0` 必须 fail loud，错误须点名字段 + 下限 + 「省略即默认 1」。
    #[test]
    fn dca_interval_zero_is_rejected_loudly() {
        let err = ExecutionPolicy::Dca {
            tranches: 2,
            mode: DcaMode::Equal,
            amount: None,
            interval: 0,
        }
        .validate()
        .expect_err("interval=0 必须被拒绝（D6：静默归一化 → fail loud）");
        assert!(err.contains("Dca.interval"), "错误须指明字段名：{err}");
        assert!(err.contains("≥ 1"), "错误须含下限语义：{err}");
        assert!(err.contains("默认 1"), "错误须点明「省略即为默认 1」：{err}");
        // 校验与 mode 无关：FixedAmount 分支同样拒绝。
        assert!(
            ExecutionPolicy::Dca {
                tranches: 2,
                mode: DcaMode::FixedAmount,
                amount: Some(100.0),
                interval: 0,
            }
            .validate()
            .is_err(),
            "FixedAmount 模式 interval=0 同样须拒绝"
        );
    }

    /// 契约③：`interval ∈ {1,5,20}` 在固定 20 根连续 Buy bar 上的**批次数与股数**逐一不变。
    ///
    /// 期望值 = 既有触发逻辑 `bars_in_run % k == 0`（run 内第 0 bar 触发）的闭式解：
    /// k=1 → 每 bar 一批 = 20；k=5 → bar 0/5/10/15 = 4；k=20 → bar 0 = 1。
    #[test]
    fn dca_interval_batch_counts_unchanged_for_1_5_20() {
        for (k, expected) in [(1usize, 20usize), (5, 4), (20, 1)] {
            let mut st = PolicyState::new();
            let p = ExecutionPolicy::Dca {
                tranches: 1_000_000,
                mode: DcaMode::FixedAmount,
                amount: Some(1_000.0),
                interval: k,
            };
            for _ in 0..20 {
                st.target_qty(&p, TradeSignal::Buy, 100_000.0, 10.0, 0.0);
            }
            let dca = st.dca.expect("Buy 后必有 DCA 运行态");
            assert_eq!(
                dca.batches_done, expected,
                "interval={k}：20 根 Buy bar 上的批次数不得改变"
            );
            // 数值级：每批 1_000 元 / 价 10 = 100 股 ⇒ 累计股数 = 批次数 × 100。
            close(dca.accumulated_qty, expected as f64 * 100.0);
        }
    }

    /// 契约③：`interval ≥ 1` 的 validate 通过性不变（显式 1/5/20 一律合法）。
    #[test]
    fn dca_interval_positive_still_valid() {
        for k in [1usize, 5, 20] {
            assert!(
                ExecutionPolicy::Dca {
                    tranches: 2,
                    mode: DcaMode::Equal,
                    amount: None,
                    interval: k,
                }
                .validate()
                .is_ok(),
                "interval={k} 须仍然合法"
            );
        }
    }

    // =====================================================================
    // ADR-029 Step 1：`exposure × ramp × guard` 判据矩阵（E1–E7、E9、E11–E13）
    // =====================================================================

    const BUY_T: f64 = 60.0;
    const SELL_T: f64 = 40.0;

    /// 固定阈值求值（门槛 60/40 = 引擎默认）：返回（目标股数，观测）。
    fn eval(
        st: &mut PolicyState,
        p: &ExecutionPolicy,
        score: f64,
        equity: f64,
        price: f64,
        current_qty: f64,
    ) -> (f64, PolicyObservation) {
        let signal = crate::aggregate::classify(score, BUY_T, SELL_T);
        let out = st.target_qty_with_score(
            p, signal, score, BUY_T, SELL_T, equity, price, current_qty,
        );
        (out.target_qty, out.observation)
    }

    fn guard(max_pct: f64, min_pct: f64, deadzone_pct: f64) -> GuardSpec {
        GuardSpec { max_pct, min_pct, deadzone_pct, deadzone_min_notional: None }
    }

    fn mapped(at_threshold_pct: f64, at_full_pct: f64, sell: SellPolicy) -> ExposureTarget {
        ExposureTarget::ScoreMapped { at_threshold_pct, at_full_pct, sell }
    }

    fn exposure(target: ExposureTarget, ramp: RampSpec, guard: GuardSpec) -> ExecutionPolicy {
        ExecutionPolicy::Exposure { target, ramp, guard }
    }

    /// 观测中的目标 pct（以决策 bar 净值/价格反算）。
    fn pct_of(qty: f64, equity: f64, price: f64) -> f64 {
        qty * price / equity
    }

    // ---- E1：ScoreMapped 单调不减 + 端点精确 + 分数先夹 [0,100] ----

    #[test]
    fn e1_score_mapped_endpoints_monotone_and_score_clamped() {
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.005),
        );
        // 端点精确：score = buy_threshold ⇒ at_threshold_pct（0.2 × 100_000 / 10 = 2000 股）
        let (q60, o60) = eval(&mut PolicyState::new(), &p, 60.0, 100_000.0, 10.0, 0.0);
        close(q60, 2_000.0);
        close(o60.target_pct.expect("观测带 target_pct"), 0.2);
        // 端点精确：score = 100 ⇒ at_full_pct（0.8 ⇒ 8000 股）
        let (q100, o100) = eval(&mut PolicyState::new(), &p, 100.0, 100_000.0, 10.0, 0.0);
        close(q100, 8_000.0);
        close(o100.target_pct.expect("观测带 target_pct"), 0.8);
        // 区间内线性：score = 80 ⇒ 0.2 + (20/40)×0.6 = 0.5 ⇒ 5000 股
        let (q80, _) = eval(&mut PolicyState::new(), &p, 80.0, 100_000.0, 10.0, 0.0);
        close(q80, 5_000.0);
        // 单调不减（60..=100 逐分）
        let mut prev = f64::NEG_INFINITY;
        for s in 60..=100 {
            let (q, _) = eval(&mut PolicyState::new(), &p, s as f64, 100_000.0, 10.0, 0.0);
            assert!(q >= prev, "score={s}：映射须单调不减（{q} < {prev}）");
            prev = q;
        }
        // 越界分数**先夹 [0,100]**：150 ⇒ 与 100 同值
        let (q150, _) = eval(&mut PolicyState::new(), &p, 150.0, 100_000.0, 10.0, 0.0);
        close(q150, 8_000.0);
        // 非有限分 ⇒ 中立 50（Hold 带）⇒ 不动目标（首 bar 无上一目标 ⇒ = 当前）
        let (qnan, onan) = eval(&mut PolicyState::new(), &p, f64::NAN, 100_000.0, 10.0, 1_234.0);
        close(qnan, 1_234.0);
        assert!(onan.target_pct.is_some(), "观测仍须可读（非有限分记中立）");
    }

    // ---- E2：SellPolicy 两支 ----

    #[test]
    fn e2_sell_policy_flat_liquidates_and_scaled_downgrades() {
        // Flat：score ≤ sell_threshold ⇒ 目标 0（清仓）
        let flat = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.0),
        );
        let (q, _) = eval(&mut PolicyState::new(), &flat, SELL_T, 100_000.0, 10.0, 3_000.0);
        close(q, 0.0);
        // Flat 在卖出档内一律 0（含 0 分）
        for s in [0.0, 10.0, 39.9, 40.0] {
            let (q, o) = eval(&mut PolicyState::new(), &flat, s, 100_000.0, 10.0, 3_000.0);
            close(q, 0.0);
            close(o.target_pct.expect("观测"), 0.0);
        }
        // Scaled：线性 (score=0 ⇒ 0) … (score=sell_threshold ⇒ at_threshold_pct)
        let scaled = exposure(
            mapped(0.2, 0.8, SellPolicy::Scaled),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.0),
        );
        let (q0, _) = eval(&mut PolicyState::new(), &scaled, 0.0, 100_000.0, 10.0, 3_000.0);
        close(q0, 0.0);
        let (q20, _) = eval(&mut PolicyState::new(), &scaled, 20.0, 100_000.0, 10.0, 3_000.0);
        close(q20, 1_000.0); // 0.1 × 100_000 / 10
        let (q40, _) = eval(&mut PolicyState::new(), &scaled, SELL_T, 100_000.0, 10.0, 3_000.0);
        close(q40, 2_000.0); // 0.2 = at_threshold_pct
        // 卖出档内单调不减
        let mut prev = f64::NEG_INFINITY;
        for s in 0..=40 {
            let (q, _) = eval(&mut PolicyState::new(), &scaled, s as f64, 100_000.0, 10.0, 3_000.0);
            assert!(q >= prev, "score={s}：Scaled 须单调不减");
            prev = q;
        }
        // 卖出↔买入 边界跳变披露（sell_transition = 跨越卖出档边界，进或出）
        let mut st = PolicyState::new();
        let (_, o_enter) = eval(&mut st, &flat, 50.0, 100_000.0, 10.0, 0.0); // Hold 档
        assert!(!o_enter.sell_transition, "首 bar（无上一档位）不记跳变");
        let (_, o_sell) = eval(&mut st, &flat, 30.0, 100_000.0, 10.0, 0.0); // 进入卖出档
        assert!(o_sell.sell_transition, "跨入卖出档须披露");
        let (_, o_stay) = eval(&mut st, &flat, 20.0, 100_000.0, 10.0, 0.0); // 档内
        assert!(!o_stay.sell_transition, "卖出档内不重复披露");
        let (_, o_exit) = eval(&mut st, &flat, 90.0, 100_000.0, 10.0, 0.0); // 离开卖出档
        assert!(o_exit.sell_transition, "离开卖出档（买入档跳变）须披露");
    }

    // ---- E3：中立带保持上一目标（绝对股数，不随净值/价格漂移重算） ----

    #[test]
    fn e3_hold_band_keeps_previous_target_qty_absolute() {
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.005),
        );
        let mut st = PolicyState::new();
        let (t1, _) = eval(&mut st, &p, 80.0, 100_000.0, 10.0, 0.0);
        close(t1, 5_000.0);
        // 中立带 + 净值/价格漂移：目标保持**绝对股数** 5000（重算值 0.5×120_000/15 = 4000 ≠ 5000）
        let (t2, o2) = eval(&mut st, &p, 50.0, 120_000.0, 15.0, 5_000.0);
        assert_eq!(t2.to_bits(), 5_000.0f64.to_bits(), "中立带须保持上一目标股数（位级）");
        assert!(o2.deadzone_blocked, "Δ=0 ⇒ 死区（零订单）");
        // 连续 4 根中立带 bar（净值/价格持续漂移）：目标恒定、零订单
        let drift = [
            (130_000.0, 16.0),
            (90_000.0, 9.0),
            (150_000.0, 18.0),
            (110_000.0, 13.0),
        ];
        for (i, (equity, price)) in drift.iter().enumerate() {
            let (t, o) = eval(&mut st, &p, 55.0, *equity, *price, 5_000.0);
            assert_eq!(
                t.to_bits(),
                5_000.0f64.to_bits(),
                "中立带第 {i} 根：目标须保持绝对股数，不得随漂移重算"
            );
            assert!(o.deadzone_blocked && t - 5_000.0 == 0.0, "零订单");
        }
    }

    // ---- E4：guard.max_pct 强制夹取（策略/分数无权覆盖） ----

    #[test]
    fn e4_guard_clamps_target_and_flags() {
        // 分数要求满仓（at_full_pct = 1.0）但 max_pct = 0.9 ⇒ 目标 ≤ 0.9
        let p = exposure(
            mapped(0.2, 1.0, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, 0.0, 0.0),
        );
        let (q, o) = eval(&mut PolicyState::new(), &p, 100.0, 100_000.0, 10.0, 0.0);
        close(q, 9_000.0);
        close(o.target_pct.expect("观测"), 0.9);
        assert!(o.clamped_by_guard, "夹取须置 clamped_by_guard");
        // 未触发夹取 ⇒ flag=false
        let p2 = exposure(
            mapped(0.2, 0.5, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, 0.0, 0.0),
        );
        let (_, o2) = eval(&mut PolicyState::new(), &p2, 100.0, 100_000.0, 10.0, 0.0);
        assert!(!o2.clamped_by_guard);
        close(o2.target_pct.expect("观测"), 0.5);
        // Fixed 同样受夹取（策略无权覆盖 guard）
        let pf = exposure(
            ExposureTarget::Fixed { pct: 0.95 },
            RampSpec::Immediate,
            guard(0.9, 0.0, 0.0),
        );
        let (qf, of) = eval(&mut PolicyState::new(), &pf, 80.0, 100_000.0, 10.0, 0.0);
        close(qf, 9_000.0);
        assert!(of.clamped_by_guard);
        // min_pct 为**持有态**硬下界（R9/E15：不清仓；清仓可达性见 `e15_*`）：
        // at_threshold_pct = 0.05 < min_pct = 0.1 ⇒ 持有态目标被抬到 0.10 并披露
        let p3 = exposure(
            mapped(0.05, 0.06, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, 0.1, 0.0),
        );
        let (q3, o3) = eval(&mut PolicyState::new(), &p3, 80.0, 100_000.0, 10.0, 0.0);
        close(q3, 1_000.0); // 0.10 × 100_000 / 10
        assert!(o3.clamped_by_guard, "min_pct 抬升持有态目标亦须披露");
    }

    // ---- E5：deadzone_pct 死区（逐 bar 零订单） ----

    #[test]
    fn e5_deadzone_blocks_orders_inside_band() {
        // deadzone 5% 净值 = 5000 元；价 10 ⇒ 阈值 500 股
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.05),
        );
        let mut st = PolicyState::new();
        let (t1, _) = eval(&mut st, &p, 80.0, 100_000.0, 10.0, 0.0);
        close(t1, 5_000.0);
        // score=82 ⇒ 映射目标 5300；|Δ|×price = 3000 < 5000 ⇒ 死区 ⇒ 输出目标 = 当前（零订单）
        let (t2, o2) = eval(&mut st, &p, 82.0, 100_000.0, 10.0, 5_000.0);
        close(t2, 5_000.0);
        assert!(o2.deadzone_blocked);
        close(o2.target_pct.expect("观测"), 0.5);
        // 死区内连续 5 bar：逐 bar 零订单（目标 = 当前持仓）
        for s in [81.0, 82.5, 79.0, 80.0, 78.0] {
            let (t, o) = eval(&mut st, &p, s, 100_000.0, 10.0, 5_000.0);
            assert_eq!(t.to_bits(), 5_000.0f64.to_bits(), "死区内目标须 = 当前持仓（零订单）");
            assert!(o.deadzone_blocked, "score={s} 应在死区内");
        }
        // 超出死区 ⇒ 下单（目标 = 映射值）
        let (t3, o3) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 5_000.0);
        close(t3, 8_000.0);
        assert!(!o3.deadzone_blocked);
        // 边界：|Δ| 恰等于死区 ⇒ **不**算命中（严格小于）
        let pb = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.03),
        );
        let mut stb = PolicyState::new();
        eval(&mut stb, &pb, 80.0, 100_000.0, 10.0, 0.0);
        let (tb, ob) = eval(&mut stb, &pb, 82.0, 100_000.0, 10.0, 5_000.0); // |Δ|×price = 3000 = 0.03×100_000
        close(tb, 5_300.0);
        assert!(!ob.deadzone_blocked, "恰等死区不算命中（< 为严格）");
    }

    // ---- E6：RateCap 速率上限（含跳变极端；不得越过 target） ----

    #[test]
    fn e6_rate_cap_limits_per_bar_movement_and_never_overshoots() {
        // pct_per_bar 0.05 × 净值 100_000 / 价 10 = 500 股/bar
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::RateCap { pct_per_bar: 0.05, down_pct_per_bar: None, on_signal_break: None },
            guard(1.0, 0.0, 0.0),
        );
        let mut st = PolicyState::new();
        let mut prev = 0.0f64;
        let mut cur = 0.0f64;
        // 大幅跳变：score 0 → 100（映射目标 8000）⇒ 逐 bar 最多 +500，且不得越过 8000
        for bar in 0..20 {
            let (t, o) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, cur);
            assert!(t <= 8_000.0 + 1e-9, "bar {bar}：目标不得越过 target（{t}）");
            assert!(t >= prev - 1e-9, "bar {bar}：单向推进不得反向（{t} < {prev}）");
            let delta_value = (t - prev).abs() * 10.0;
            assert!(delta_value <= 0.05 * 100_000.0 + 1e-6, "bar {bar}：相邻目标变动折算金额超限");
            assert_eq!(o.ramp_cap_pct_per_bar, Some(0.05));
            assert!(o.rate_limited == (t < 8_000.0 - 1e-9), "受限标记须与实际一致");
            prev = t;
            cur = t; // 假定成交到位（引擎下 bar open 成交）
        }
        close(prev, 8_000.0); // 16 bar 后到达目标
        // 极端跳变：净值翻倍 + 价格不变 ⇒ 映射目标 16000，cap 变 1000 股/bar
        let (t, _) = eval(&mut st, &p, 100.0, 200_000.0, 10.0, 8_000.0);
        close(t, 9_000.0);
        assert!(t <= 16_000.0);
        // 反向同样受限（不得跳变）：目标跌回 0（score=0）⇒ 每 bar 最多 -500
        let mut prev = t;
        let mut cur = t;
        for bar in 0..40 {
            let (t, o) = eval(&mut st, &p, 0.0, 200_000.0, 10.0, cur);
            assert!(t >= -1e-9, "反向不得越过 0");
            let delta_value = (t - prev).abs() * 10.0;
            assert!(delta_value <= 0.05 * 200_000.0 + 1e-6, "反向 bar {bar} 超限：{delta_value}");
            assert!(o.rate_limited || t == 0.0);
            prev = t;
            cur = t;
        }
        close(prev, 0.0);
    }

    // ---- E7：强平/硬止损 = 外部中断 ⇒ 路径状态全清 ----

    #[test]
    fn e7_reset_clears_exposure_path_state() {
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::RateCap { pct_per_bar: 0.05, down_pct_per_bar: None, on_signal_break: None },
            guard(1.0, 0.0, 0.0),
        );
        let mut st = PolicyState::new();
        // 推进 4 步（目标 2000 股），但只成交 1000（模拟被夹/部分成交）
        let mut last = 0.0;
        for _ in 0..4 {
            let (t, _) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, last);
            last = t;
        }
        close(last, 2_000.0);
        // 硬止损强平（引擎外部中断）⇒ reset
        st.reset();
        // 复位后路径锚点 = 当前暴露（500 股），从当前暴露重新逐 bar 推进（而非续用旧目标 2000）
        let (t, o) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 500.0);
        close(t, 1_000.0);
        assert!(o.rate_limited, "复位后须从实际暴露重新限速推进");
        assert!(st.exposure.is_some(), "求值后重建运行态");
        // 现有 legacy 复位口径不变（lump 冻结 / DCA 批次同时清除）
        assert!(st.lump_frozen.is_none() && st.dca.is_none());
    }

    // ---- E12：求值 pipeline 顺序（映射→guard→换算→死区→限速→下单→观测） ----

    #[test]
    fn e12_pipeline_order_is_deadzone_then_rate_cap() {
        // 构造**能区分两种顺序**的用例：
        //   契约序（死区在限速之前）：③ 目标 8000 vs 当前 0 ⇒ |Δ|×price 远超死区 ⇒ 不拦；
        //     ⑤ 限速把输出压到 100 股 ⇒ **有订单**。
        //   反序（限速在前、死区在后）：先压到 100 股，再判 |100−0|×price = 1000 < 死区 2000 ⇒ 拦死 ⇒ **零订单**。
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::RateCap { pct_per_bar: 0.01, down_pct_per_bar: None, on_signal_break: None }, // cap = 100 股/bar
            guard(1.0, 0.0, 0.02),                   // 死区 = 2000 元 = 200 股 @10
        );
        let (t, o) = eval(&mut PolicyState::new(), &p, 100.0, 100_000.0, 10.0, 0.0);
        close(t, 100.0);
        assert!(!o.deadzone_blocked, "死区按**③ 未限速目标**判定 ⇒ 不得拦");
        assert!(o.rate_limited, "限速在死区之后 ⇒ 本 bar 受限");
        // 观测字段形状（E10）：ramp_cap 与 pct 口径
        assert_eq!(o.ramp_cap_pct_per_bar, Some(0.01));
        close(o.target_pct.expect("观测"), 0.01);
        close(o.current_pct.expect("观测"), 0.0);
        // guard 夹取在换算之前：max_pct 先夹再换股数
        let p2 = exposure(
            mapped(0.2, 1.0, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, 0.0, 0.0),
        );
        let (t2, o2) = eval(&mut PolicyState::new(), &p2, 100.0, 100_000.0, 10.0, 0.0);
        close(t2, 9_000.0); // = 0.9 × 100_000 / 10（先夹 pct 再换算）
        assert!(o2.clamped_by_guard);
    }

    // ---- E13：`Fixed` 与 `LumpSum` 同输入等价（策略层） ----

    #[test]
    fn e13_fixed_matches_lump_sum_targets_bitwise() {
        let lump = ExecutionPolicy::LumpSum { position_pct: 0.5 };
        let fixed = exposure(
            ExposureTarget::Fixed { pct: 0.5 },
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.0),
        );
        let mut a = PolicyState::new();
        let mut b = PolicyState::new();
        // （score, equity, price, current）：含 Buy 建立/持续、Hold 解冻、Sell 清仓、再见 Buy 重快照
        let seq: &[(f64, f64, f64, f64)] = &[
            (80.0, 100_000.0, 10.0, 0.0),
            (80.0, 95_000.0, 9.5, 5_000.0),
            (50.0, 95_000.0, 9.5, 5_000.0),
            (80.0, 90_000.0, 9.0, 5_000.0),
            (30.0, 88_000.0, 8.8, 5_000.0),
            (85.0, 85_000.0, 8.5, 0.0),
            (80.0, 120_000.0, 12.0, 5_000.0),
        ];
        for (i, (score, equity, price, current)) in seq.iter().enumerate() {
            let (ta, _) = eval(&mut a, &lump, *score, *equity, *price, *current);
            let (tb, _) = eval(&mut b, &fixed, *score, *equity, *price, *current);
            assert_eq!(
                ta.to_bits(),
                tb.to_bits(),
                "第 {i} bar：Fixed 与 LumpSum 目标须逐位相等（{ta} vs {tb}）"
            );
        }
    }

    // ---- E9：防抖（分数抖动序列 ⇒ 下单次数/费用上限；阈值标定见测试注释） ----

    #[test]
    fn e9_score_jitter_does_not_churn() {
        // 标定（先标定后写死）：at_full − at_threshold = 0.01 ⇒ ±5 分 ⇒ 目标 pct 抖动 ±0.00125；
        // 死区 0.005 × 净值 100_000 = 500 元 = 50 股 @10 ⇒ 抖动折算 125 元 < 500 元 ⇒ 全被死区吸收。
        // 实测（见证据）：20 根抖动 bar 上仅第 0 根建仓 1 单，费用 5.09 元 ⇒ 费用占净值 5.09e-5。
        let p = exposure(
            mapped(0.2, 0.21, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.005),
        );
        let jitter = [75.0, 80.0, 75.0, 70.0, 75.0, 80.0, 75.0, 70.0, 75.0, 80.0,
                      75.0, 70.0, 75.0, 80.0, 75.0, 70.0, 75.0, 80.0, 75.0, 70.0];
        let fee = backtest::FeeModel {
            commission_rate_pct: 0.025,
            min_commission: 5.0,
            stamp_duty_pct: 0.0,
            slippage_bp: 2.0,
        };
        let mut st = PolicyState::new();
        let mut cur = 0.0f64;
        let mut orders = 0usize;
        let mut fees = 0.0f64;
        for (i, s) in jitter.iter().enumerate() {
            let (t, _) = eval(&mut st, &p, *s, 100_000.0, 10.0, cur);
            let delta = t - cur;
            if delta.abs() > 1e-9 {
                orders += 1;
                // 成交额口径：目标差额 × 价（买入含佣金；卖出另计印花税）
                if delta > 0.0 {
                    let exec = fee.buy(delta * 10.0, 10.0);
                    fees += exec.commission;
                } else {
                    let exec = fee.sell(-delta, 10.0);
                    fees += exec.commission + exec.stamp_duty;
                }
            }
            let _ = i;
            cur = t;
        }
        // 标定读数（先标定后写死）：实测值打印入测试输出（证据落盘见交付报告）
        eprintln!(
            "[E9 标定·policy] orders={orders} fees={fees:.4} fee_pct={:.6}%",
            fees / 100_000.0 * 100.0
        );
        // 标定上限（含 1 单余量）：抖动不得产生“每 bar 微单”
        assert!(orders <= 2, "20 根 ±5 分抖动 bar 上订单数须 ≤ 2，实际 {orders}");
        assert!(
            fees / 100_000.0 <= 1e-3,
            "费用占净值比须 ≤ 0.1%，实际 {}",
            fees / 100_000.0
        );
    }

    // ---- E11：校验 fail loud（含 ScoreMapped 的分母/边界规则） ----

    #[test]
    fn e11_validate_exposure_fails_loud() {
        let ok = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::RateCap { pct_per_bar: 0.05, down_pct_per_bar: None, on_signal_break: None },
            guard(0.9, 0.0, 0.005),
        );
        ok.validate().expect("合法 Exposure 须通过");
        ok.validate_with_thresholds(60.0, 40.0)
            .expect("合法阈值须通过");

        // `at_full_pct ≥ at_threshold_pct`
        assert!(exposure(
            mapped(0.8, 0.2, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.0)
        )
        .validate()
        .is_err());
        // `at_full_pct ≤ max_pct`
        assert!(exposure(
            mapped(0.2, 0.95, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, 0.0, 0.0)
        )
        .validate()
        .is_err());
        // `0 ≤ min_pct ≤ max_pct ≤ 1`
        assert!(exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, 0.95, 0.0)
        )
        .validate()
        .is_err());
        assert!(exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.5, 0.0, 0.0)
        )
        .validate()
        .is_err());
        assert!(exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, -0.1, 0.0)
        )
        .validate()
        .is_err());
        // `deadzone_pct ≥ 0`
        assert!(exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(0.9, 0.0, -0.01)
        )
        .validate()
        .is_err());
        // `pct_per_bar > 0`
        for bad in [0.0, -0.05, f64::NAN, f64::INFINITY] {
            assert!(exposure(
                mapped(0.2, 0.8, SellPolicy::Flat),
                RampSpec::RateCap { pct_per_bar: bad, down_pct_per_bar: None, on_signal_break: None },
                guard(0.9, 0.0, 0.0)
            )
            .validate()
            .is_err(), "pct_per_bar = {bad} 须拒绝");
        }
        // `at_threshold_pct` 自身范围与有限性
        assert!(exposure(
            mapped(-0.1, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.0)
        )
        .validate()
        .is_err());
        assert!(exposure(
            mapped(0.2, 1.5, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.0)
        )
        .validate()
        .is_err());
        // Fixed pct ∈ (0,1]
        for bad in [0.0, -0.2, 1.2, f64::NAN] {
            assert!(exposure(
                ExposureTarget::Fixed { pct: bad },
                RampSpec::Immediate,
                guard(1.0, 0.0, 0.0)
            )
            .validate()
            .is_err(), "Fixed pct = {bad} 须拒绝");
        }
        // ScoreMapped 分母：`buy_threshold < 100 ∧ sell_threshold > 0`
        let err = ok
            .validate_with_thresholds(100.0, 40.0)
            .expect_err("buy_threshold = 100 时 ScoreMapped 映射无定义");
        assert!(err.contains("buy_threshold"), "错误须指明字段：{err}");
        let err = ok
            .validate_with_thresholds(60.0, 0.0)
            .expect_err("sell_threshold = 0 ⇒ Scaled 分母为 0");
        assert!(err.contains("sell_threshold"), "错误须指明字段：{err}");
        // 阈值规则只约束 `ScoreMapped`：旧变体与 Fixed 不受影响（历史 run 可复现）
        for legacy in [
            ExecutionPolicy::LumpSum { position_pct: 0.5 },
            ExecutionPolicy::Dca {
                tranches: 2,
                mode: DcaMode::Equal,
                amount: None,
                interval: 1,
            },
            exposure(
                ExposureTarget::Fixed { pct: 0.5 },
                RampSpec::Immediate,
                guard(1.0, 0.0, 0.0),
            ),
        ] {
            legacy
                .validate_with_thresholds(100.0, 0.0)
                .expect("非 ScoreMapped 不受阈值校验约束");
        }
    }

    // ---- E15（R9）：`min_pct` **不得阻塞清仓**（只约束持有态目标） ----

    #[test]
    fn e15_min_pct_does_not_block_liquidation() {
        // guard.min_pct = 0.3（非零下限）；卖出支目标 0 必须可达
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.3, 0.0),
        );
        // Flat：卖区（score ≤ sell_threshold）⇒ 目标 0，不得被抬到 min_pct
        for s in [0.0, 20.0, 40.0] {
            let (q, o) = eval(&mut PolicyState::new(), &p, s, 100_000.0, 10.0, 3_000.0);
            assert_eq!(q.to_bits(), 0.0f64.to_bits(), "score={s}：清仓目标须为 0（可空仓）");
            assert!(!o.clamped_by_guard, "清仓不受下界夹取 ⇒ 不得置夹取标记");
            close(o.target_pct.expect("观测"), 0.0);
        }
        // Scaled：score = 0 ⇒ 同样可达 0；中间正比例值属**持有态** ⇒ 仍受下界约束
        let ps = exposure(
            mapped(0.2, 0.8, SellPolicy::Scaled),
            RampSpec::Immediate,
            guard(1.0, 0.3, 0.0),
        );
        let (q0, o0) = eval(&mut PolicyState::new(), &ps, 0.0, 100_000.0, 10.0, 3_000.0);
        assert_eq!(q0.to_bits(), 0.0f64.to_bits(), "Scaled(score=0) ⇒ 0 可达");
        assert!(!o0.clamped_by_guard);
        let (q20, o20) = eval(&mut PolicyState::new(), &ps, 20.0, 100_000.0, 10.0, 3_000.0);
        close(q20, 3_000.0); // 映射 0.10 < min_pct 0.30 ⇒ 抬到 0.30 ⇒ 0.30 × 100_000 / 10
        assert!(o20.clamped_by_guard, "持有态小值仍受下界约束并披露");
        // 清仓后中立带不得“复活”下界：保持 0（上一目标 = 0）
        let mut st = PolicyState::new();
        eval(&mut st, &p, 0.0, 100_000.0, 10.0, 3_000.0); // 清仓
        let (qh, oh) = eval(&mut st, &p, 50.0, 100_000.0, 10.0, 0.0); // 中立带
        assert_eq!(qh.to_bits(), 0.0f64.to_bits(), "中立带保持 0（不得被 min_pct 复活）");
        assert!(!oh.clamped_by_guard);
    }

    // ---- E17（R11）：现金不可达 ⇒ 一次性下调到可达上限（只降不升 + 披露） ----

    #[test]
    fn e17_affordability_cap_lowers_once_discloses_and_releases_on_liquidation() {
        // 目标 = 100% 净值（100_000/10 = 10_000 股）；guard 无死区（隔离 affordability 机制）
        let p = exposure(
            mapped(1.0, 1.0, SellPolicy::Flat),
            RampSpec::Immediate,
            guard(1.0, 0.0, 0.0),
        );
        let mut st = PolicyState::new();
        // bar0：空仓 ⇒ 目标 10_000 股（未受限）
        let (t0, o0) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 0.0);
        close(t0, 10_000.0);
        assert!(!o0.affordability_capped, "未截断 ⇒ 不得置下调标记");
        // 引擎回报：买入被现金上限截断（need > cash）⇒ 实得 9995.5 股 ⇒ 一次性下调上限
        st.clamp_exposure_affordable(9_995.5);
        // bar1：映射目标 10_000 > 上限 ⇒ 目标 = 上限 = 当前持仓 ⇒ **零订单**（无每 bar 微单）
        let (t1, o1) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 9_995.5);
        assert_eq!(t1.to_bits(), 9_995.5f64.to_bits(), "目标须下调到可达上限");
        assert!(o1.affordability_capped, "下调须披露");
        assert_eq!(t1 - 9_995.5, 0.0, "目标 = 当前 ⇒ 订单增量 0（禁止微单）");
        // bar2/bar3：逐 bar 零订单（持续受上限约束）
        for _ in 0..2 {
            let (t, o) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 9_995.5);
            assert_eq!(t.to_bits(), 9_995.5f64.to_bits());
            assert!(o.affordability_capped);
        }
        // 只降不升：更高的“实得”不得上调上限
        st.clamp_exposure_affordable(9_999.0);
        let (t_up, o_up) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 9_995.5);
        assert_eq!(t_up.to_bits(), 9_995.5f64.to_bits(), "上限只降不升");
        assert!(o_up.affordability_capped);
        // 清仓（卖区 ⇒ 目标 0）**不受上限阻塞**，且上限随清仓释放（现金回笼 ⇒ 下一周期可重新建仓）
        let (t_sell, o_sell) = eval(&mut st, &p, 0.0, 100_000.0, 10.0, 9_995.5);
        assert_eq!(t_sell.to_bits(), 0.0f64.to_bits(), "清仓不得被 affordability 上限阻塞");
        assert!(!o_sell.affordability_capped);
        let (t_re, o_re) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 0.0);
        close(t_re, 10_000.0);
        assert!(!o_re.affordability_capped, "清仓后上限已释放 ⇒ 新周期按目标建仓");
        // 外部中断（reset）同样释放
        st.clamp_exposure_affordable(9_995.5);
        st.reset();
        let (t_r, o_r) = eval(&mut st, &p, 100.0, 100_000.0, 10.0, 0.0);
        close(t_r, 10_000.0);
        assert!(!o_r.affordability_capped);
    }

    // ---- 黄金序列：分数序列 ⇒ 目标序列（回归用） ----

    #[test]
    fn golden_score_sequence_to_target_sequence() {
        // 配置：ScoreMapped(0.2, 0.8, Flat) × RateCap(0.05) × guard(max 1.0, min 0, deadzone 0.005)
        // 净值 100_000 / 价 10 ⇒ cap = 500 股/bar；死区 = 500 元 = 50 股。
        let p = exposure(
            mapped(0.2, 0.8, SellPolicy::Flat),
            RampSpec::RateCap { pct_per_bar: 0.05, down_pct_per_bar: None, on_signal_break: None },
            guard(1.0, 0.0, 0.005),
        );
        let scores = [30.0, 40.0, 55.0, 70.0, 100.0, 100.0, 100.0, 45.0, 0.0];
        let expected = [0.0, 0.0, 0.0, 500.0, 1_000.0, 1_500.0, 2_000.0, 2_000.0, 1_500.0];
        let mut st = PolicyState::new();
        let mut cur = 0.0f64;
        for (i, s) in scores.iter().enumerate() {
            let (t, o) = eval(&mut st, &p, *s, 100_000.0, 10.0, cur);
            assert!(
                (t - expected[i]).abs() < 1e-9,
                "第 {i} bar（score={s}）：目标序列偏离黄金值（{t} vs {}）观测={o:?}",
                expected[i]
            );
            cur = t;
        }
    }
}
