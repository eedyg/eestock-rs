//! ExecutionPolicy：信号 → 目标仓位幂等换算（ADR §13.1，D6）。
//! 订单 = 目标 − 当前，重复信号天然无副作用。
//!
//! LumpSum 冻结口径（ADR §13.1 P1a 评审 MAJOR-1 裁决）：股数目标在 Buy 信号建立时
//! （空仓或信号中断后首个 Buy）按 equity×position_pct/price 换算并**冻结**；Buy 持续期
//! 目标恒为冻结值（不因净值/费用漂移重算）；Hold → 目标 = 当前（解冻，无订单）；
//! Sell → 0（解冻）；信号中断后首个 Buy 重新快照。

use serde::{Deserialize, Serialize};

use crate::aggregate::TradeSignal;

/// DCA 分批金额模式。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum DcaMode {
    /// 等额分批：计划总额 / N。计划总额 = 买入信号重新出现时（新一轮建仓起点）的账户净值。
    Equal,
    /// 固定金额分批：每批 `amount` 元。
    FixedAmount,
}

/// 执行策略（ADR §13.1：目标仓位幂等换算）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum ExecutionPolicy {
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
        /// 批间隔 k bar（默认 1 = 每 bar 一批）。第 0 批在 Buy 信号出现当 bar 即触发，
        /// 之后每过 k bar 触发下一批。
        interval: usize,
    },
}

impl ExecutionPolicy {
    /// 配置校验（引擎启动时调用；非法配置直接拒绝运行）。
    pub fn validate(&self) -> Result<(), String> {
        match self {
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
                interval: _,
            } => {
                if *tranches == 0 {
                    return Err("Dca.tranches 必须 ≥ 1".to_string());
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
}

/// 批间隔归一化：interval=0 视为默认 1（任务书「interval: k（默认 1）」）。
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
    pub fn reset(&mut self) {
        self.dca = None;
        self.lump_frozen = None;
    }

    /// 成交 affordability 钳制（引擎在 Policy 买入成交后调用）：买入被现金上限截断时
    /// （如 position_pct=1.0 佣金使实得股数 < 冻结目标），冻结目标下调至实际持仓，
    /// 避免对不可达缺口每 bar 重复挂微单。只降不升；非 LumpSum 冻结态为 no-op。
    pub(crate) fn clamp_lump_frozen(&mut self, realized_qty: f64) {
        if let Some(f) = &mut self.lump_frozen {
            if realized_qty < *f {
                *f = realized_qty;
            }
        }
    }

    /// 信号 → 目标仓位（股）。幂等：重复信号产生相同目标 → 订单增量为 0。
    ///
    /// - `equity`：决策 bar 收盘净值（现金 + 持仓×close）；
    /// - `price`：决策 bar 收盘价（目标仓位换算基准价；实际成交在次 bar open，口径差异见 crate 文档）；
    /// - `current_qty`：当前实际持仓（股）。
    pub fn target_qty(
        &mut self,
        policy: &ExecutionPolicy,
        signal: super::TradeSignal,
        equity: f64,
        price: f64,
        current_qty: f64,
    ) -> f64 {
        match policy {
            ExecutionPolicy::LumpSum { position_pct } => match signal {
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
            },
            ExecutionPolicy::Dca {
                tranches,
                mode,
                amount,
                interval,
            } => match signal {
                TradeSignal::Buy => {
                    let k = norm_interval(*interval);
                    // Buy 信号重新出现（或首次出现）→ 重新开始计数：
                    // 批次计数清零、计划总额按本轮起点净值重新快照、基线 = 当前持仓。
                    // （任务书口径注释：「信号中断 → 剩余批次取消；Buy 信号重新出现 → 重新开始计数」。）
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
                    // 每 k bar 触发一批（run 内第 0 批当 bar 即触发），批次数不超过 N。
                    // allow：usize::is_multiple_of 稳定于 rust 1.87，超出 workspace MSRV 1.85。
                    #[allow(clippy::manual_is_multiple_of)]
                    if st.bars_in_run % k == 0 && st.batches_done < *tranches {
                        let batch_amount = match mode {
                            DcaMode::Equal => st.plan_total / *tranches as f64,
                            DcaMode::FixedAmount => amount.expect("validated"),
                        };
                        st.accumulated_qty += batch_amount / price;
                        st.batches_done += 1;
                    }
                    st.bars_in_run += 1;
                    st.base_qty + st.accumulated_qty
                }
                // 信号中断（Hold）→ 剩余批次取消（状态清除）；目标 = 当前（无订单）。
                TradeSignal::Hold => {
                    self.dca = None;
                    current_qty
                }
                // Sell → 一次性清仓（目标 0），状态复位。
                TradeSignal::Sell => {
                    self.dca = None;
                    0.0
                }
            },
        }
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
        assert!(
            ExecutionPolicy::Dca {
                tranches: 2,
                mode: DcaMode::FixedAmount,
                amount: Some(100.0),
                interval: 0
            }
            .validate()
            .is_ok(),
            "interval=0 按默认 1 处理"
        );
    }
}
