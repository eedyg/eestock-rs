//! ADR-027（交易明细分层 L1 回合 / L2 逐笔）：回合聚合的**全系统唯一实现**。
//!
//! 分层定位（ADR-027 D7）：本文件是 L1「回合」的**派生视图**，事实源是 L2 逐笔成交事实
//! [`FillFact`]。全系统（回测引擎、sim-live 结算与运行中读、审计端点）**必须**调用
//! [`aggregate_round_trips`]，禁止第二处实现（DRY 硬约束）。
//!
//! 口径（02-spec §2，全回合口径；数学定义已冻结）：
//! - `gross_value`  = Σ_sell `trade_value`
//! - `commission`   = Σ_buy commission + Σ_sell commission
//! - `stamp_duty`   = Σ_sell `stamp_duty`
//! - `invested`     = Σ_buy (`trade_value` + `commission`)
//! - `proceeds`     = Σ_sell (`trade_value` − `commission` − `stamp_duty`)
//! - `pnl`          = `proceeds` − `invested`（**整回合现金流差**，无成本分摊/FIFO 归属）
//! - `shares`       = Σ_buy qty ; `hold_bars` = `close_bar` − `open_bar`
//!
//! 硬约束：
//! 1. 费用三件套（`trade_value`/`commission`/`stamp_duty`）**只**取自传入的 [`FillFact`] 事实值；
//!    本模块**禁止**用 `(side, qty, price)` + 费率复算（`fee.rs` 最低佣金分支先减后除不可逆，
//!    ADR-027 §1 F10）。
//! 2. `Open` 回合**禁止**产出 `pnl`（`None`），未实现部分由持仓视图承担（02-spec §2）。
//! 3. 纯函数：无 IO、无全局状态、无时钟（KISS + 可测试性）。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::types::TradeDetail;

/// 订单/成交方向。
///
/// ADR-027 P1a 裁决（2026-09-20）：`OrderSide` **唯一定义**迁至 `backtest`（ABI 最低层，
/// strategy-core 经 `pub use` 再导出，消费方路径零改动）；序列化形状逐字节不变（外部标记
/// `"Buy"`/`"Sell"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    Buy,
    Sell,
}

/// 一笔成交的**来源**（ADR-027 Q1 补充裁决：`backtest` 侧四值定义）。
///
/// `OrderReason`（`strategy-core`，三值）经 `From` 映射为 `Policy`/`StopTrigger`/`ForceClose`；
/// sim-live 手动/外部来源映射为 [`FillReason::Manual`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FillReason {
    /// Policy 目标仓位换算产生。
    Policy,
    /// 硬止损触发。
    StopTrigger,
    /// 期末强制平仓。
    ForceClose,
    /// 人工/外部来源（sim-live 手动下单等）。
    Manual,
}

impl FillReason {
    /// 稳定字符串形态（唯一映射源，与 serde 外部标记形态一致）。
    pub fn as_str(&self) -> &'static str {
        match self {
            FillReason::Policy => "Policy",
            FillReason::StopTrigger => "StopTrigger",
            FillReason::ForceClose => "ForceClose",
            FillReason::Manual => "Manual",
        }
    }

    /// [`FillReason::as_str`] 的逆映射（`None` = 未知字符串）。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "Policy" => Some(FillReason::Policy),
            "StopTrigger" => Some(FillReason::StopTrigger),
            "ForceClose" => Some(FillReason::ForceClose),
            "Manual" => Some(FillReason::Manual),
            _ => None,
        }
    }
}

/// 回合状态（ADR-027 D7）：回测侧恒 `Closed`（期末强平终结最后一个回合）；
/// sim-live 未平仓回合为 `Open`（**禁止**伪造成交）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoundTripStatus {
    Open,
    Closed,
}

impl RoundTripStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RoundTripStatus::Open => "Open",
            RoundTripStatus::Closed => "Closed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "Open" => Some(RoundTripStatus::Open),
            "Closed" => Some(RoundTripStatus::Closed),
            _ => None,
        }
    }
}

/// 一笔成交（L2 的**唯一事实源**；02-spec §1.1）。
///
/// 引擎在成交时刻产出，逐笔携带全部金额与归属；费用三件套必须由撮合点写入（ADR-027 D4）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FillFact {
    /// 回合序号（ADR-027 D6，由 [`assign_rt_seq`] 唯一分配）：开仓成交 = 新 seq；
    /// 加仓/减仓/清仓 = 当前 seq。
    pub rt_seq: u32,
    /// 标的代码（sim-live 多标的必需；回测填 run 的 symbol）。
    pub code: String,
    /// **真实 bar 序号**（禁 ts/bar_sec 反算）。
    pub bar_index: usize,
    pub ts: i64,
    pub side: OrderSide,
    pub qty: f64,
    /// 成交有效价（含滑点）。
    pub price: f64,
    /// = `qty × price`（由撮合点写入的事实值）。
    pub trade_value: f64,
    /// 本笔佣金（含最低佣金）。
    pub commission: f64,
    /// 本笔印花税（买入恒 0）。
    pub stamp_duty: f64,
    pub reason: FillReason,
}

/// `rt_seq` 分配（ADR-027 D6）：**唯一实现**，引擎在线分配与 sim-live 回放分配都必须调用。
///
/// 规则（per `(run|session, code)`，从 1 单调递增）：
/// 1. 买入且当前无持仓 ⇒ **新回合**（`rt_seq + 1`）；
/// 2. 持仓中的任何买入/卖出 ⇒ **当前回合**；
/// 3. 卖出使持仓归零 ⇒ 终结当前回合（下一笔买入开新回合）。
///
/// 边界：无持仓的孤儿卖出（回测/sim-live 正常路径不可达）赋 `rt_seq = 0`（显式「无回合归属」，
/// 由聚合侧呈现为 `Open` 且 `pnl = None`，**禁止**造数）。
/// 持仓归零判定容差（与引擎 `apply_sell` 同口径：价格/数量为 f64 累加，需容忍尾差）。
const RT_SEQ_EPS: f64 = 1e-9;

/// `rt_seq` 分配状态（ADR-027 D6 规则的**单一体**）。
///
/// 批式入口 [`assign_rt_seq`] 与引擎**在线分配**（每笔成交即时打号）共用本结构
/// ⇒ 规则只有一份实现，不存在「两套序号逻辑」（DRY 硬约束）。
/// 状态 = per `code` 的当前持仓量与当前回合序号；分配只依赖**前缀**（后续成交不改变
/// 已分配的值 ⇒ 在线分配与事后批式分配结果逐笔相同）。
#[derive(Debug, Clone, Default)]
pub struct RtSeqAssigner {
    pos: HashMap<String, f64>,
    seq: HashMap<String, u32>,
}

impl RtSeqAssigner {
    /// 空状态（每 `code` 的首个新回合从 1 起计）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 就地为**一笔**成交分配 `rt_seq`（D6：买入且无持仓 ⇒ 新回合；持仓中的任何成交 ⇒ 当前回合；
    /// 卖出使持仓归零 ⇒ 终结，下一笔买入开新回合）。
    ///
    /// 无持仓时的孤儿卖出无处可归 ⇒ `rt_seq = 0`（显式「无回合归属」，由聚合侧呈现为 `Open`
    /// 且 `pnl = None`，**禁止**造数）。
    pub fn assign(&mut self, f: &mut FillFact) {
        let p = self.pos.entry(f.code.clone()).or_insert(0.0);
        let s = self.seq.entry(f.code.clone()).or_insert(0);
        match f.side {
            OrderSide::Buy => {
                // 无持仓 ⇒ 开新回合（`rt_seq` 从 1 开始）。
                if *p <= RT_SEQ_EPS {
                    *s += 1;
                }
                *p += f.qty;
            }
            OrderSide::Sell => {
                *p = (*p - f.qty).max(0.0);
            }
        }
        // 无持仓时的成交：买入已开新序号（仍归属新回合）；孤儿卖出无处可归 ⇒ 0。
        f.rt_seq = if *s == 0 { 0 } else { *s };
    }
}

/// 批式分配：等价于对每笔依次调用 [`RtSeqAssigner::assign`]（同一规则单一体）。
pub fn assign_rt_seq(fills: &mut [FillFact]) {
    let mut assigner = RtSeqAssigner::new();
    for f in fills.iter_mut() {
        assigner.assign(f);
    }
}

/// 逐笔成交事实 → 回合列表（**全系统唯一**的回合聚合实现，ADR-027 D7）。
///
/// 输入要求：`fills` 按 `(code, 到达顺序)` 有序（回测天然有序；sim-live 按 `sim_trades.id` 升序）。
/// 输入**必须**已由 [`assign_rt_seq`] 打好 `rt_seq`（本函数**不**重编号，只按 `(code, rt_seq)` 分组求和）。
///
/// 输出顺序：按每个 `code` 首个成交在输入中的位置升序；`code` 内部按 `rt_seq` 升序。
pub fn aggregate_round_trips(fills: &[FillFact]) -> Vec<TradeDetail> {
    /// 回合「已清仓」判定容差（Σbuy qty == Σsell qty）。
    const EPS: f64 = 1e-9;

    // 累加器：**只**对传入事实值做加总，从不用 (side, qty, price) + 费率复算。
    struct Acc {
        rt_seq: u32,
        code: String,
        l2_count: usize,
        buy_count: usize,
        sell_count: usize,
        buy_qty: f64,
        sell_qty: f64,
        buy_value: f64,
        buy_commission: f64,
        sell_value: f64,
        sell_commission: f64,
        sell_stamp: f64,
        open_ts: i64,
        open_bar: usize,
        last_ts: i64,
        last_bar: usize,
        last_reason: FillReason,
    }

    let mut code_order: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut index: HashMap<(String, u32), usize> = HashMap::new();
    let mut accs: Vec<Acc> = Vec::new();

    for f in fills {
        if seen.insert(f.code.clone()) {
            code_order.push(f.code.clone());
        }
        let slot = *index.entry((f.code.clone(), f.rt_seq)).or_insert_with(|| {
            let i = accs.len();
            accs.push(Acc {
                rt_seq: f.rt_seq,
                code: f.code.clone(),
                l2_count: 0,
                buy_count: 0,
                sell_count: 0,
                buy_qty: 0.0,
                sell_qty: 0.0,
                buy_value: 0.0,
                buy_commission: 0.0,
                sell_value: 0.0,
                sell_commission: 0.0,
                sell_stamp: 0.0,
                open_ts: f.ts,
                open_bar: f.bar_index,
                last_ts: f.ts,
                last_bar: f.bar_index,
                last_reason: f.reason,
            });
            i
        });
        let a = &mut accs[slot];
        a.l2_count += 1;
        a.last_ts = f.ts;
        a.last_bar = f.bar_index;
        a.last_reason = f.reason;
        match f.side {
            OrderSide::Buy => {
                a.buy_count += 1;
                a.buy_qty += f.qty;
                a.buy_value += f.trade_value;
                a.buy_commission += f.commission;
            }
            OrderSide::Sell => {
                a.sell_count += 1;
                a.sell_qty += f.qty;
                a.sell_value += f.trade_value;
                a.sell_commission += f.commission;
                a.sell_stamp += f.stamp_duty;
            }
        }
    }

    // 输出顺序：`code` 首现升序；`code` 内 `rt_seq` 升序（ADR-027 P1a 裁决）。
    let mut out: Vec<TradeDetail> = Vec::with_capacity(accs.len());
    for code in &code_order {
        let mut group: Vec<&Acc> = accs.iter().filter(|a| &a.code == code).collect();
        group.sort_by_key(|a| a.rt_seq);
        for a in group {
            let closed = a.sell_qty > EPS && (a.buy_qty - a.sell_qty).abs() <= EPS;
            let invested = a.buy_value + a.buy_commission;
            let proceeds = a.sell_value - a.sell_commission - a.sell_stamp;
            out.push(TradeDetail {
                rt_seq: a.rt_seq,
                code: a.code.clone(),
                status: if closed {
                    RoundTripStatus::Closed
                } else {
                    RoundTripStatus::Open
                },
                open_ts: a.open_ts,
                close_ts: if closed { Some(a.last_ts) } else { None },
                open_bar: a.open_bar,
                close_bar: if closed { Some(a.last_bar) } else { None },
                open_price: if a.buy_qty > EPS {
                    a.buy_value / a.buy_qty
                } else {
                    0.0
                },
                close_price: if a.sell_qty > EPS {
                    Some(a.sell_value / a.sell_qty)
                } else {
                    None
                },
                shares: a.buy_qty,
                gross_value: a.sell_value,
                commission: a.buy_commission + a.sell_commission,
                stamp_duty: a.sell_stamp,
                // Open 回合**禁止**产出 pnl（未实现部分由持仓视图承担）。
                pnl: if closed {
                    Some(proceeds - invested)
                } else {
                    None
                },
                hold_bars: if closed {
                    Some(a.last_bar.saturating_sub(a.open_bar))
                } else {
                    None
                },
                reason: if closed {
                    Some(a.last_reason.as_str().to_string())
                } else {
                    None
                },
                l2_count: a.l2_count,
                buy_count: a.buy_count,
                sell_count: a.sell_count,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fee::FeeModel;

    const EPS: f64 = 1e-9;

    fn close(a: f64, b: f64, what: &str) {
        assert!((a - b).abs() < 1e-9, "{what}: expected {b}, got {a}");
    }

    /// 造一笔成交事实（`trade_value = qty × price`；费用三件套由调用方显式给出）。
    #[allow(clippy::too_many_arguments)]
    fn fill(
        code: &str,
        rt_seq: u32,
        bar: usize,
        ts: i64,
        side: OrderSide,
        qty: f64,
        price: f64,
        commission: f64,
        stamp_duty: f64,
        reason: FillReason,
    ) -> FillFact {
        FillFact {
            rt_seq,
            code: code.to_string(),
            bar_index: bar,
            ts,
            side,
            qty,
            price,
            trade_value: qty * price,
            commission,
            stamp_duty,
            reason,
        }
    }

    /// 买入（测试缺省：`reason = Policy`、无印花税）。
    fn b(code: &str, seq: u32, bar: usize, ts: i64, qty: f64, price: f64, commission: f64) -> FillFact {
        fill(code, seq, bar, ts, OrderSide::Buy, qty, price, commission, 0.0, FillReason::Policy)
    }

    /// 卖出（测试缺省：`reason = Policy`）。
    fn s(
        code: &str,
        seq: u32,
        bar: usize,
        ts: i64,
        qty: f64,
        price: f64,
        commission: f64,
        stamp_duty: f64,
    ) -> FillFact {
        fill(code, seq, bar, ts, OrderSide::Sell, qty, price, commission, stamp_duty, FillReason::Policy)
    }

    // ───────────────────────── U1：聚合纯函数表驱动（逐字段手算期望） ─────────────────────────

    struct Exp {
        rt_seq: u32,
        code: &'static str,
        status: RoundTripStatus,
        open_ts: i64,
        close_ts: Option<i64>,
        open_bar: usize,
        close_bar: Option<usize>,
        open_price: f64,
        close_price: Option<f64>,
        shares: f64,
        gross_value: f64,
        commission: f64,
        stamp_duty: f64,
        pnl: Option<f64>,
        hold_bars: Option<usize>,
        reason: Option<&'static str>,
        l2_count: usize,
        buy_count: usize,
        sell_count: usize,
    }

    fn check(case_name: &str, fills: &[FillFact], e: &Exp) {
        let rts = aggregate_round_trips(fills);
        assert_eq!(rts.len(), 1, "{case_name}：应聚合为 1 个回合");
        let t = &rts[0];
        assert_eq!(t.rt_seq, e.rt_seq, "{case_name}: rt_seq");
        assert_eq!(t.code, e.code, "{case_name}: code");
        assert_eq!(t.status, e.status, "{case_name}: status");
        assert_eq!(t.open_ts, e.open_ts, "{case_name}: open_ts");
        assert_eq!(t.close_ts, e.close_ts, "{case_name}: close_ts");
        assert_eq!(t.open_bar, e.open_bar, "{case_name}: open_bar");
        assert_eq!(t.close_bar, e.close_bar, "{case_name}: close_bar");
        close(t.open_price, e.open_price, &format!("{case_name}: open_price"));
        assert_eq!(t.close_price, e.close_price, "{case_name}: close_price");
        close(t.shares, e.shares, &format!("{case_name}: shares"));
        close(t.gross_value, e.gross_value, &format!("{case_name}: gross_value"));
        close(t.commission, e.commission, &format!("{case_name}: commission"));
        close(t.stamp_duty, e.stamp_duty, &format!("{case_name}: stamp_duty"));
        match (t.pnl, e.pnl) {
            (Some(a), Some(b)) => close(a, b, &format!("{case_name}: pnl")),
            (None, None) => {}
            other => panic!("{case_name}: pnl 形态不符，got {other:?}"),
        }
        assert_eq!(t.hold_bars, e.hold_bars, "{case_name}: hold_bars");
        assert_eq!(t.reason.as_deref(), e.reason, "{case_name}: reason");
        assert_eq!(t.l2_count, e.l2_count, "{case_name}: l2_count");
        assert_eq!(t.buy_count, e.buy_count, "{case_name}: buy_count");
        assert_eq!(t.sell_count, e.sell_count, "{case_name}: sell_count");
    }

    /// 表驱动：单笔开平 / 多批加仓 / 部分卖出 / 多批 DCA / 零长回合 / 期末强平。
    #[test]
    fn u1_table_driven_round_trip_fields() {
        let code = "600000.SH";

        // (a) 单笔开平：买 100@10（佣 5）→ 卖 100@11（佣 5、印花 0.55）
        let case_a = vec![
            b(code, 1, 0, 1_000, 100.0, 10.0, 5.0),
            s(code, 1, 2, 1_200, 100.0, 11.0, 5.0, 0.55),
        ];
        let exp_a = Exp {
            rt_seq: 1,
            code,
            status: RoundTripStatus::Closed,
            open_ts: 1_000,
            close_ts: Some(1_200),
            open_bar: 0,
            close_bar: Some(2),
            open_price: 10.0,
            close_price: Some(11.0),
            shares: 100.0,
            gross_value: 1_100.0,
            commission: 10.0,
            stamp_duty: 0.55,
            // proceeds 1094.45 − invested 1005.0
            pnl: Some(89.45),
            hold_bars: Some(2),
            reason: Some("Policy"),
            l2_count: 2,
            buy_count: 1,
            sell_count: 1,
        };

        // (b) 多批加仓：买 100@10 + 买 100@12 → 卖 200@11
        let case_b = vec![
            b(code, 1, 0, 1_000, 100.0, 10.0, 5.0),
            b(code, 1, 1, 1_060, 100.0, 12.0, 5.0),
            s(code, 1, 3, 1_180, 200.0, 11.0, 5.0, 1.1),
        ];
        let exp_b = Exp {
            rt_seq: 1,
            code,
            status: RoundTripStatus::Closed,
            open_ts: 1_000,
            close_ts: Some(1_180),
            open_bar: 0,
            close_bar: Some(3),
            // (1000 + 1200) / 200
            open_price: 11.0,
            close_price: Some(11.0),
            shares: 200.0,
            gross_value: 2_200.0,
            commission: 15.0,
            stamp_duty: 1.1,
            // invested 2210.0 ; proceeds 2200 − 5 − 1.1 = 2193.9
            pnl: Some(-16.1),
            hold_bars: Some(3),
            reason: Some("Policy"),
            l2_count: 3,
            buy_count: 2,
            sell_count: 1,
        };

        // (c) 部分卖出：买 100@10 → 卖 50@12 → 卖 50@11（全部进同一回合，含已实现部分）
        let case_c = vec![
            b(code, 1, 0, 1_000, 100.0, 10.0, 5.0),
            s(code, 1, 1, 1_060, 50.0, 12.0, 5.0, 0.3),
            s(code, 1, 2, 1_120, 50.0, 11.0, 5.0, 0.275),
        ];
        let exp_c = Exp {
            rt_seq: 1,
            code,
            status: RoundTripStatus::Closed,
            open_ts: 1_000,
            close_ts: Some(1_120),
            open_bar: 0,
            close_bar: Some(2),
            open_price: 10.0,
            // (600 + 550) / 100
            close_price: Some(11.5),
            shares: 100.0,
            gross_value: 1_150.0,
            commission: 15.0,
            stamp_duty: 0.575,
            // proceeds = 594.7 + 544.725 = 1139.425 ; invested = 1005.0
            pnl: Some(134.425),
            hold_bars: Some(2),
            reason: Some("Policy"),
            l2_count: 3,
            buy_count: 1,
            sell_count: 2,
        };

        // (d) 多批 DCA：100 笔买入 + 100 笔卖出（同价）⇒ 期望值由测试侧独立算术给出
        let dca_prices: Vec<f64> = (0..100).map(|i| 10.0 + i as f64 * 0.01).collect();
        let mut case_d: Vec<FillFact> = Vec::new();
        for (i, p) in dca_prices.iter().enumerate() {
            case_d.push(b(code, 1, i, 1_000 + i as i64 * 60, 10.0, *p, 5.0));
        }
        for (i, p) in dca_prices.iter().enumerate() {
            let bar = 100 + i;
            let tv = 10.0 * *p;
            case_d.push(s(code, 1, bar, 1_000 + bar as i64 * 60, 10.0, *p, 5.0, tv * 0.0005));
        }
        let buy_value: f64 = dca_prices.iter().map(|p| 10.0 * *p).sum();
        let sell_value: f64 = dca_prices.iter().map(|p| 10.0 * *p).sum();
        let stamp: f64 = dca_prices.iter().map(|p| 10.0 * *p * 0.0005).sum();
        let exp_d = Exp {
            rt_seq: 1,
            code,
            status: RoundTripStatus::Closed,
            open_ts: 1_000,
            close_ts: Some(1_000 + 199 * 60),
            open_bar: 0,
            close_bar: Some(199),
            open_price: buy_value / 1_000.0,
            close_price: Some(sell_value / 1_000.0),
            shares: 1_000.0,
            gross_value: sell_value,
            commission: 200.0 * 5.0,
            stamp_duty: stamp,
            pnl: Some((sell_value - 100.0 * 5.0 - stamp) - (buy_value + 100.0 * 5.0)),
            hold_bars: Some(199),
            reason: Some("Policy"),
            l2_count: 200,
            buy_count: 100,
            sell_count: 100,
        };

        // (e) 零长回合（F5）：同一 bar 内买 + 卖 ⇒ hold_bars = 0
        let case_e = vec![
            b(code, 1, 5, 1_050, 100.0, 10.0, 5.0),
            s(code, 1, 5, 1_050, 100.0, 10.5, 5.0, 0.525),
        ];
        let exp_e = Exp {
            rt_seq: 1,
            code,
            status: RoundTripStatus::Closed,
            open_ts: 1_050,
            close_ts: Some(1_050),
            open_bar: 5,
            close_bar: Some(5),
            open_price: 10.0,
            close_price: Some(10.5),
            shares: 100.0,
            gross_value: 1_050.0,
            commission: 10.0,
            stamp_duty: 0.525,
            pnl: Some((1_050.0 - 5.0 - 0.525) - (1_000.0 + 5.0)),
            hold_bars: Some(0),
            reason: Some("Policy"),
            l2_count: 2,
            buy_count: 1,
            sell_count: 1,
        };

        // (f) 期末强平：末笔卖出来源 = ForceClose
        let mut case_f = case_a.clone();
        case_f[1].reason = FillReason::ForceClose;
        let exp_f = Exp {
            reason: Some("ForceClose"),
            ..exp_a
        };

        check("U1(a) 单笔开平", &case_a, &exp_a);
        check("U1(b) 多批加仓", &case_b, &exp_b);
        check("U1(c) 部分卖出", &case_c, &exp_c);
        check("U1(d) DCA 100 批", &case_d, &exp_d);
        check("U1(e) 零长回合", &case_e, &exp_e);
        check("U1(f) 期末强平", &case_f, &exp_f);
    }

    /// U3（并入 U1 表）：`Open` 回合 ⇒ `pnl = None`、`hold_bars = None`、`close_* = None`、
    /// `close_price = None`（无卖出）、`reason = None`（禁止造数）。
    #[test]
    fn u1_open_round_has_no_pnl() {
        let code = "600000.SH";
        let fills = vec![
            b(code, 1, 3, 1_180, 100.0, 10.0, 5.0),
            s(code, 1, 4, 1_240, 40.0, 11.0, 5.0, 0.22),
        ];
        let rts = aggregate_round_trips(&fills);
        assert_eq!(rts.len(), 1);
        let t = &rts[0];
        assert_eq!(t.status, RoundTripStatus::Open, "部分卖出未清仓 ⇒ Open");
        assert_eq!(t.pnl, None, "Open 回合禁止产出 pnl");
        assert_eq!(t.hold_bars, None, "Open 回合禁止产出 hold_bars");
        assert_eq!(t.close_ts, None);
        assert_eq!(t.close_bar, None);
        assert_eq!(t.reason, None, "Open 回合 reason 必须为 None");
        // 部分卖出 ⇒ 有卖出价（加权卖出有效价）
        assert_eq!(t.close_price, Some(11.0));
        // 仍披露事实值：gross/commission/stamp/shares
        assert_eq!(t.gross_value, 440.0);
        assert_eq!(t.commission, 10.0);
        assert_eq!(t.stamp_duty, 0.22);
        assert_eq!(t.shares, 100.0, "shares = Σ 买入 qty");
        assert_eq!(t.l2_count, 2);
    }

    /// Open 且**完全无卖出** ⇒ `close_price = None`（禁止造 0）。
    #[test]
    fn u1_open_round_without_sell_has_null_close_price() {
        let fills = vec![b("600000.SH", 1, 0, 1_000, 100.0, 10.0, 5.0)];
        let rts = aggregate_round_trips(&fills);
        assert_eq!(rts[0].close_price, None);
        assert_eq!(rts[0].status, RoundTripStatus::Open);
        assert_eq!(rts[0].pnl, None);
    }

    // ───────────────────── U2：`rt_seq` 分配（开新/同序号/终结/再开 +1） ─────────────────────

    /// U2：开仓新序号、加仓同序号、部分卖出同序号、清仓终结、再开仓 +1。
    #[test]
    fn u2_assign_rt_seq_open_add_close_reopen() {
        let code = "600000.SH";
        let mut fills = vec![
            b(code, 0, 0, 1_000, 100.0, 10.0, 5.0), // 开新回合 → 1
            b(code, 0, 1, 1_060, 50.0, 10.5, 5.0),  // 加仓 → 1
            s(code, 0, 2, 1_120, 60.0, 11.0, 5.0, 0.33), // 部分卖出 → 1
            s(code, 0, 3, 1_180, 90.0, 11.2, 5.0, 0.5),  // 清仓终结 → 1
            b(code, 0, 4, 1_240, 100.0, 12.0, 5.0), // 再开仓 → 2
            s(code, 0, 5, 1_300, 100.0, 12.5, 5.0, 0.625), // 清仓 → 2
        ];
        assign_rt_seq(&mut fills);
        let seqs: Vec<u32> = fills.iter().map(|f| f.rt_seq).collect();
        assert_eq!(seqs, vec![1, 1, 1, 1, 2, 2]);
    }

    /// U2：零长回合（同 bar 买+卖）归属同一 `rt_seq`。
    #[test]
    fn u2_assign_rt_seq_zero_length_round_same_bar() {
        let code = "600000.SH";
        let mut fills = vec![
            b(code, 0, 5, 1_050, 100.0, 10.0, 5.0),
            s(code, 0, 5, 1_050, 100.0, 10.0, 5.0, 0.5),
            b(code, 0, 6, 1_110, 100.0, 10.0, 5.0),
        ];
        assign_rt_seq(&mut fills);
        assert_eq!(fills.iter().map(|f| f.rt_seq).collect::<Vec<_>>(), vec![1, 1, 2]);
    }

    /// U2：`rt_seq` per `code` 独立计数（多标的：B 的首笔开仓 = 1，与 A 的进度无关）。
    #[test]
    fn u2_assign_rt_seq_is_per_code() {
        let mut fills = vec![
            b("A", 0, 0, 1_000, 100.0, 10.0, 5.0),
            s("A", 0, 1, 1_060, 100.0, 11.0, 5.0, 0.55),
            b("A", 0, 2, 1_120, 100.0, 10.0, 5.0), // A 第 2 回合
            b("B", 0, 0, 1_000, 10.0, 20.0, 5.0),  // B 第 1 回合（独立）
            s("B", 0, 1, 1_060, 10.0, 21.0, 5.0, 0.105),
            b("A", 0, 3, 1_180, 100.0, 10.5, 5.0), // A 仍持仓 ⇒ 加仓，归当前回合 2
        ];
        assign_rt_seq(&mut fills);
        let seqs: Vec<(&str, u32)> = fills.iter().map(|f| (f.code.as_str(), f.rt_seq)).collect();
        assert_eq!(
            seqs,
            vec![("A", 1), ("A", 1), ("A", 2), ("B", 1), ("B", 1), ("A", 2)]
        );
    }

    /// U2 边界：无持仓的孤儿卖出 ⇒ `rt_seq = 0`（显式「无回合归属」，禁造数）。
    #[test]
    fn u2_assign_rt_seq_orphan_sell_is_zero() {
        let mut fills = vec![s("A", 9, 0, 1_000, 10.0, 10.0, 5.0, 0.05)];
        assign_rt_seq(&mut fills);
        assert_eq!(fills[0].rt_seq, 0, "孤儿卖出无回合归属 ⇒ 0");
    }

    /// U2/P1b：**在线（增量）分配 == 批式分配**（`RtSeqAssigner::assign` 逐笔 vs `assign_rt_seq` 全量）
    /// —— D6 规则只有一份实现，引擎在线分配与事后批式分配必须逐笔同值（DRY 守卫）。
    #[test]
    fn u2_incremental_assign_matches_batch_assign() {
        let code = "600000.SH";
        let make = || {
            vec![
                b(code, 0, 0, 1_000, 100.0, 10.0, 5.0),
                s(code, 0, 0, 1_000, 100.0, 9.5, 5.0, 0.475), // 零长回合
                b(code, 0, 1, 1_060, 100.0, 10.0, 5.0),      // 第 2 回合
                b(code, 0, 2, 1_120, 30.0, 10.2, 5.0),       // 加仓
                s(code, 0, 3, 1_180, 60.0, 11.0, 5.0, 0.33), // 部分卖出
                b("B", 0, 3, 1_180, 10.0, 20.0, 5.0),        // 另一标的第 1 回合
                s(code, 0, 4, 1_240, 70.0, 11.5, 5.0, 0.4),  // 清仓
                s(code, 0, 5, 1_300, 10.0, 12.0, 5.0, 0.06), // 孤儿卖出 ⇒ 0
            ]
        };

        let mut incremental = make();
        let mut assigner = RtSeqAssigner::new();
        for f in incremental.iter_mut() {
            assigner.assign(f);
        }

        let mut batch = make();
        assign_rt_seq(&mut batch);

        let got: Vec<(String, u32)> = incremental
            .iter()
            .map(|f| (f.code.clone(), f.rt_seq))
            .collect();
        let exp: Vec<(String, u32)> = batch.iter().map(|f| (f.code.clone(), f.rt_seq)).collect();
        assert_eq!(got, exp, "在线分配与批式分配必须逐笔同值（唯一规则）");
        assert_eq!(
            got,
            vec![
                (code.to_string(), 1),
                (code.to_string(), 1),
                (code.to_string(), 2),
                (code.to_string(), 2),
                (code.to_string(), 2),
                ("B".to_string(), 1),
                (code.to_string(), 2),
                // 清仓后的孤儿卖出：该 code 已开过回合（`seq != 0`）⇒ 仍归当前回合 2，
                // 「rt_seq = 0」只适用于**该 code 从未开仓**的卖出（见 u2_assign_rt_seq_orphan_sell_is_zero）。
                (code.to_string(), 2),
            ]
        );
    }

    // ───────────────── U4：费用三件套来源（逐位相等，禁止费率复算） ─────────────────

    /// U4：`FillFact` 三件套 == `FeeModel::buy/sell` 返回值（含最低佣金分支），且聚合**逐位**透传
    /// （`==`，非容差）。
    #[test]
    fn u4_fee_triple_is_bit_identical_to_fee_model_output() {
        let fee = FeeModel::default();
        // 1000 元预算 → 最低佣金分支（fee.rs 先减后除）：trade_value = 995.0, commission = 5.0
        let be = fee.buy(1_000.0, 10.0);
        let se = fee.sell(be.shares, 12.0);

        let facts = vec![
            FillFact {
                rt_seq: 1,
                code: "600000.SH".into(),
                bar_index: 0,
                ts: 1_000,
                side: OrderSide::Buy,
                qty: be.shares,
                price: be.effective_price,
                trade_value: be.trade_value,
                commission: be.commission,
                stamp_duty: 0.0,
                reason: FillReason::Policy,
            },
            FillFact {
                rt_seq: 1,
                code: "600000.SH".into(),
                bar_index: 1,
                ts: 1_060,
                side: OrderSide::Sell,
                qty: be.shares,
                price: se.effective_price,
                trade_value: se.trade_value,
                commission: se.commission,
                stamp_duty: se.stamp_duty,
                reason: FillReason::Policy,
            },
        ];

        // 事实值与引擎实算逐位相等（最低佣金分支不可逆 ⇒ 复算不保证）
        assert_eq!(facts[0].trade_value.to_bits(), be.trade_value.to_bits());
        assert_eq!(facts[0].commission.to_bits(), be.commission.to_bits());
        assert_eq!(facts[1].trade_value.to_bits(), se.trade_value.to_bits());
        assert_eq!(facts[1].commission.to_bits(), se.commission.to_bits());
        assert_eq!(facts[1].stamp_duty.to_bits(), se.stamp_duty.to_bits());
        assert_eq!(facts[0].trade_value, 995.0, "最低佣金分支：trade_value = 预算 − 5.0");

        let rt = &aggregate_round_trips(&facts)[0];
        // 逐位相等（`==`）：聚合只用传入事实值求和，不做任何费率复算
        assert_eq!(rt.gross_value, se.trade_value);
        assert_eq!(rt.commission, be.commission + se.commission);
        assert_eq!(rt.stamp_duty, se.stamp_duty);
        // pnl 同口径手算
        let invested = be.trade_value + be.commission;
        let proceeds = se.trade_value - se.commission - se.stamp_duty;
        assert_eq!(rt.pnl, Some(proceeds - invested));
    }

    /// U4（反向守卫）：传入与费率复算**不同**的费用事实值 ⇒ 聚合一字不改地透传。
    #[test]
    fn u4_aggregate_passes_through_facts_without_recompute() {
        let code = "600000.SH";
        let facts = vec![
            b(code, 1, 0, 1_000, 100.0, 10.0, 7.77),
            s(code, 1, 1, 1_060, 100.0, 10.0, 3.33, 1.23),
        ];
        let rt = &aggregate_round_trips(&facts)[0];
        assert_eq!(rt.commission, 7.77 + 3.33);
        assert_eq!(rt.stamp_duty, 1.23);
        assert_eq!(rt.gross_value, 1_000.0);
        assert_eq!(rt.pnl, Some((1_000.0 - 3.33 - 1.23) - (1_000.0 + 7.77)));
    }

    // ───────────────────────── U6：`distinct(rt_seq) == len(round_trips)` ─────────────────────────

    /// U6（I4 自洽）：`distinct(rt_seq) == trades.len()`，逐回合分组正确。
    #[test]
    fn u6_distinct_rt_seq_equals_round_trip_count() {
        let code = "600000.SH";
        let fills = vec![
            b(code, 1, 0, 1_000, 100.0, 10.0, 5.0),
            s(code, 1, 1, 1_060, 100.0, 11.0, 5.0, 0.55),
            b(code, 2, 2, 1_120, 100.0, 10.0, 5.0),
            b(code, 3, 3, 1_180, 100.0, 11.0, 5.0),
            s(code, 3, 4, 1_240, 100.0, 12.0, 5.0, 0.6),
        ];
        let rts = aggregate_round_trips(&fills);
        let mut distinct: Vec<u32> = rts.iter().map(|t| t.rt_seq).collect();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(distinct.len(), rts.len(), "distinct(rt_seq) 必须 == round_trips.len()");
        assert_eq!(distinct, vec![1, 2, 3]);
        assert_eq!(rts.iter().map(|t| t.l2_count).sum::<usize>(), fills.len());
    }

    /// U6 + assign：先分配序号再聚合 ⇒ 分组数 == 回合数（回测期末强平序列）。
    #[test]
    fn u6_assign_then_aggregate_seq_consistent() {
        let code = "600000.SH";
        let mut fills = vec![
            b(code, 0, 0, 1_000, 100.0, 10.0, 5.0),
            s(code, 0, 1, 1_060, 100.0, 11.0, 5.0, 0.55),
            b(code, 0, 2, 1_120, 100.0, 10.0, 5.0),
            s(code, 0, 3, 1_180, 100.0, 9.0, 5.0, 0.45),
        ];
        assign_rt_seq(&mut fills);
        let rts = aggregate_round_trips(&fills);
        assert_eq!(rts.len(), 2);
        assert_eq!(rts.iter().map(|t| t.rt_seq).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(rts[1].pnl, Some((900.0 - 5.0 - 0.45) - (1_000.0 + 5.0)));
    }

    // ───────────────────────── 输出顺序：code 首现升序 + code 内 rt_seq 升序 ─────────────────────────

    #[test]
    fn output_order_code_first_appearance_then_rt_seq() {
        let mut fills = vec![
            b("B", 1, 0, 1_000, 10.0, 20.0, 5.0),
            s("B", 1, 1, 1_060, 10.0, 21.0, 5.0, 0.105),
            b("A", 2, 0, 1_000, 100.0, 10.0, 5.0),
            b("A", 1, 1, 1_060, 100.0, 10.0, 5.0),
            s("A", 1, 2, 1_120, 100.0, 11.0, 5.0, 0.55),
            s("A", 2, 3, 1_180, 100.0, 9.0, 5.0, 0.45),
        ];
        let rts = aggregate_round_trips(&fills);
        let keys: Vec<(&str, u32)> = rts.iter().map(|t| (t.code.as_str(), t.rt_seq)).collect();
        assert_eq!(keys, vec![("B", 1), ("A", 1), ("A", 2)]);
        // 分配器把 A 的第 2 段（输入中先出现）也正确归位
        assign_rt_seq(&mut fills);
        assert_eq!(
            fills.iter().map(|f| (f.code.clone(), f.rt_seq)).collect::<Vec<_>>(),
            vec![
                ("B".into(), 1),
                ("B".into(), 1),
                ("A".into(), 1),
                ("A".into(), 1),
                ("A".into(), 1),
                ("A".into(), 1),
            ],
            "A 的购-卖-购-卖 在 assign 后应成为连续回合（输入顺序决定序号）"
        );
    }

    /// 空输入 ⇒ 空输出（无 panic、无造数）。
    #[test]
    fn empty_fills_yield_empty_round_trips() {
        assert!(aggregate_round_trips(&[]).is_empty());
    }

    // ───────────────────── 稳定字符串 / serde 形状（迁移后逐字节不变） ─────────────────────

    #[test]
    fn fill_reason_and_status_string_round_trip() {
        for r in [
            FillReason::Policy,
            FillReason::StopTrigger,
            FillReason::ForceClose,
            FillReason::Manual,
        ] {
            assert_eq!(FillReason::parse(r.as_str()), Some(r));
        }
        assert_eq!(FillReason::parse("Unknown"), None);
        assert_eq!(FillReason::Policy.as_str(), "Policy");
        assert_eq!(FillReason::Manual.as_str(), "Manual");

        for st in [RoundTripStatus::Open, RoundTripStatus::Closed] {
            assert_eq!(RoundTripStatus::parse(st.as_str()), Some(st));
        }
        assert_eq!(RoundTripStatus::parse("unknown"), None);
    }
}
