//! ADR-027 复现测试（R1 / R2 / R5 / R6）——**先红后绿**（`design/17-trade-detail-layering/03-test-plan.md` §1）。
//!
//! 事实源契约：`design/17-trade-detail-layering/02-spec.md` §1.1/§1.2/§2；
//! 裁决：`design/01-architecture/adr/ADR-027-trade-detail-two-level-round-trip-model.md`。
//!
//! 纪律：
//! - 本文件**只做复现取证**，不修任何生产代码；红是预期结果；
//! - 判据全部为**正向断言**（断言具体值/恒等式），禁止「没报错即通过」；
//! - `strategy-core` 无 `serde_json` 依赖 ⇒ 字段存在性用「运行时 Debug 呈现」断言
//!   （`EngineEvent`/`TradeDetail` 均 `#[derive(Debug)]`），**不**用编译期引用（编译错误不是可判红的断言）；
//! - 确定性：无 RNG / 无系统时钟 / 无 IO；固定 bar 序列 + 固定配置。

use backtest::{Bar, FeeModel, Period, TradeDetail};
use strategy_core::{
    run_ensemble, BarRecord, EngineEvent, EnsembleConfig, EnsembleSession, ExecutionPolicy,
    LoopControl, OrderReason, OrderSide, StopConfig, StopKind, StopTrigger, StrategySlot,
};
use strategy_runtime::{QuickJsRuntime, RuntimeLimits};

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 固定价 bar（open=high=low=close=price）。
fn price_bars(prices: &[f64]) -> Vec<Bar> {
    prices
        .iter()
        .enumerate()
        .map(|(i, p)| Bar {
            ts: 1_700_000_000 + i as i64 * 86_400,
            open: *p,
            high: *p,
            low: *p,
            close: *p,
            volume: 10_000.0,
        })
        .collect()
}

fn slot(code: &str, hash: &str, weight: f64) -> StrategySlot {
    StrategySlot::new(code, hash, backtest::StrategyParams::new(), weight).expect("合法 slot")
}

fn cfg(slots: Vec<StrategySlot>, policy: ExecutionPolicy, capital: f64) -> EnsembleConfig {
    EnsembleConfig {
        // P1b 机械适配（架构裁决 2026-09-20 方案 A）：`EnsembleConfig` 增 `symbol`
        // （`FillFact.code`/`TradeDetail.code` 唯一取值来源）；本复现场景为单标定回测，
        // 用可辨识固定值 TEST.SYMBOL，**未改任何断言**。
        symbol: "TEST.SYMBOL".to_string(),
        slots,
        buy_threshold: 60.0,
        sell_threshold: 40.0,
        policy,
        stop: None,
        initial_capital: capital,
        fee: FeeModel::default(),
        period: Period::D1,
        warmup_bars: 0,
        runtime_limits: RuntimeLimits::default(),
    }
}

fn run(cfg: &EnsembleConfig, bars: &[Bar]) -> strategy_core::EnsembleResult {
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    run_ensemble(cfg, bars, &mut rt).expect("引擎运行成功")
}

/// 逐笔成交事实（**当前** `EngineEvent::Fill` 的全部可用字段）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct FillFactNow {
    bar_index: usize,
    side: OrderSide,
    qty: f64,
    price: f64,
    reason: OrderReason,
}

fn fills(res: &strategy_core::EnsembleResult) -> Vec<FillFactNow> {
    res.per_bar
        .iter()
        .flat_map(|r| r.events.iter())
        .filter_map(|e| match e {
            // P1b 机械适配：`EngineEvent::Fill` 增 rt_seq + 金额三件套（02-spec §1.1）⇒
            // 本投影只消费原有 5 字段，其余以 `..` 忽略（**未放宽任何断言**）。
            EngineEvent::Fill {
                bar_index,
                side,
                qty,
                price,
                reason,
                ..
            } => Some(FillFactNow {
                bar_index: *bar_index,
                side: *side,
                qty: *qty,
                price: *price,
                reason: *reason,
            }),
            _ => None,
        })
        .collect()
}

/// 逐笔成交事实的**全字段**投影（02-spec §1.1 的 `FillFact` 字段集在本 crate 的可见形态：
/// `EngineEvent::Fill` 八字段 + 所属 bar 记录的 `ts`）。用于**两源逐笔比对**。
#[derive(Debug, Clone, PartialEq)]
struct FillFactFull {
    ts: i64,
    bar_index: usize,
    side: OrderSide,
    qty: f64,
    price: f64,
    trade_value: f64,
    commission: f64,
    stamp_duty: f64,
    rt_seq: u32,
    reason: OrderReason,
}

/// 与 `crates/application/src/workbench.rs::collect_fills`（`:2382-2406`）**同扫描口径**：
/// 逐记录 → 逐事件 → 按序投影成交事实（`/result` 的 `per_bar` payload 与 `/fills` 单块
/// 都是这一个扫描的产物）。
fn collect_fill_facts(records: &[BarRecord], out: &mut Vec<FillFactFull>) {
    for rec in records {
        for ev in &rec.events {
            if let EngineEvent::Fill {
                bar_index,
                side,
                qty,
                price,
                trade_value,
                commission,
                stamp_duty,
                rt_seq,
                reason,
            } = ev
            {
                out.push(FillFactFull {
                    ts: rec.ts,
                    bar_index: *bar_index,
                    side: *side,
                    qty: *qty,
                    price: *price,
                    trade_value: *trade_value,
                    commission: *commission,
                    stamp_duty: *stamp_duty,
                    rt_seq: *rt_seq,
                    reason: *reason,
                });
            }
        }
    }
}

/// **源 A —— `per_bar` 事件源**（批式入口 `run_ensemble` 的 `res.per_bar[].events`；
/// 与 `/bars?kind=per_bar` 的 payload 同源）。
fn fill_source_per_bar(res: &strategy_core::EnsembleResult) -> Vec<FillFactFull> {
    let mut out = Vec::new();
    collect_fill_facts(&res.per_bar, &mut out);
    out
}

/// **源 B —— `fills` 事实源**（`/fills` 分块的实际产径）：按 `crates/application/src/workbench.rs`
/// 同序列驱动会话 —— `set_total_hint` → 按 chunk `push_batch` → **非末块 `drain_records()` 逐块收集** →
/// `finish()` 末块纳入 ⇒ 该序列即「单块 `fills` 事实源」的产出路径（含分块边界处理）。
fn fill_source_chunked(cfg: &EnsembleConfig, bars: &[Bar], chunk: usize) -> Vec<FillFactFull> {
    assert!(chunk > 0);
    let mut rt = QuickJsRuntime::new(cfg.runtime_limits);
    let mut session = EnsembleSession::new(cfg, &mut rt).expect("会话构造成功");
    session.set_total_hint(bars.len());
    let mut out = Vec::new();
    let n_chunks = bars.len().div_ceil(chunk);
    for ci in 0..n_chunks {
        let start = ci * chunk;
        let end = ((ci + 1) * chunk).min(bars.len());
        let mut observer = |_i: usize, _t: usize| LoopControl::Continue;
        session
            .push_batch(&bars[start..end], &mut observer)
            .expect("push_batch 成功");
        if ci + 1 < n_chunks {
            let recs = session.drain_records();
            collect_fill_facts(&recs, &mut out);
        }
    }
    let res = session.finish();
    collect_fill_facts(&res.per_bar, &mut out);
    out
}

#[track_caller]
fn assert_close(a: f64, b: f64, tol: f64, what: &str) {
    assert!(
        (a - b).abs() <= tol,
        "{what}: 期望 {b}，实际 {a}（Δ = {}，容差 {tol}）",
        a - b
    );
}

// ---------------------------------------------------------------------------
// R1 / R2 场景脚本（inline 插件：按 bar 序号脚本化评分，避免新增 fixture 文件）
//
// 目标形态（`03-test-plan.md` R1）：买 → 部分卖（更高价）→ 清仓（更低价）。
// 相位的可构造性（见 evidence 文件「构造方式的不确定性」）：
//   部分卖出**只能**由 `delta = target − current < −EPS` 产生（engine.rs:782-810 / F4），
//   而 LumpSum 冻结目标只在「信号中断后重新出现 Buy」时重算（policy.rs:168-183）⇒
//   必须 Buy → Hold → Buy（重新快照，且快照价更高 ⇒ 目标 < 持仓 ⇒ 部分卖出）→ Sell。
// ---------------------------------------------------------------------------

/// bar0 Buy；bar1..3 Hold（解冻）；bar4..5 Buy（重快照 @ close=12 ⇒ 目标 < 持仓）；
/// bar6..7 Sell（清仓）。
const SCRIPT_PARTIAL_SELL: &str = r#"
function on_bar(ctx) {
  const i = ctx.index;
  if (i === 0 || (i >= 4 && i <= 5)) return 80;
  if (i >= 6) return 20;
  return 50;
}
"#;

/// R1/R2/R6 共用场景（**配置 + bar 序列**；R6 需用同一场景驱动两条产径）。
/// capital=100_000、LumpSum pct=0.5、价序 10,10,10,10,12,12,11,11。
/// 预期事件序列：bar1 open 买 5000 股（@10.002）→ bar5 open 部分卖（@12）→ bar7 open 清仓（@11）。
fn partial_sell_case() -> (EnsembleConfig, Vec<Bar>) {
    let bars = price_bars(&[10.0, 10.0, 10.0, 10.0, 12.0, 12.0, 11.0, 11.0]);
    let cfg = cfg(
        vec![slot(
            SCRIPT_PARTIAL_SELL,
            "sha256:adr027_partial_sell",
            1.0,
        )],
        ExecutionPolicy::LumpSum { position_pct: 0.5 },
        100_000.0,
    );
    (cfg, bars)
}

/// 共用场景的批式入口运行（R1/R2/R5 用）。
fn partial_sell_run() -> strategy_core::EnsembleResult {
    let (cfg, bars) = partial_sell_case();
    run(&cfg, &bars)
}

/// R1：部分卖出下 `TradeDetail.pnl` **不是**该回合真实已实现盈亏。
///
/// 红判据（03-test-plan R1）：`pnl == Σ sell(proceeds) − Σ buy(total_cost)` **失败**。
/// 真值口径（02-spec §2）：本 run 期末空仓且只有一个回合 ⇒
/// `真实已实现盈亏 = nav[-1] − initial_capital`（含全部费用；无二次交易）。
#[test]
fn r1_partial_sell_trade_detail_pnl_is_not_round_trip_realized_pnl() {
    let res = partial_sell_run();
    let f = fills(&res);

    // ---- 构造守卫（绿）：确证场景真的含「部分卖出」（否则本红无意义） ----
    assert_eq!(f.len(), 3, "应为 3 笔成交（买 / 部分卖 / 清仓）：{f:?}");
    let buys: Vec<_> = f.iter().filter(|x| x.side == OrderSide::Buy).collect();
    let sells: Vec<_> = f.iter().filter(|x| x.side == OrderSide::Sell).collect();
    assert_eq!(buys.len(), 1, "一笔买入：{f:?}");
    assert_eq!(sells.len(), 2, "两笔卖出：{f:?}");
    assert_eq!(buys[0].bar_index, 1, "买入在 bar1 成交：{f:?}");
    assert_eq!(sells[0].bar_index, 5, "部分卖出在 bar5 成交：{f:?}");
    assert_eq!(sells[1].bar_index, 7, "清仓在 bar7 成交：{f:?}");
    assert!(
        sells[0].qty > 0.0 && sells[0].qty < buys[0].qty,
        "前置：第一笔卖出必须是**部分**卖出（0 < {} < {}）",
        sells[0].qty,
        buys[0].qty
    );
    assert_close(
        sells[0].qty + sells[1].qty,
        buys[0].qty,
        1e-6,
        "两笔卖出合计 == 买入量（回合闭合）",
    );
    assert_eq!(res.trades.len(), 1, "整段成交 = 1 个回合：{:?}", res.trades);

    // ---- R1 红判据：L1.pnl 必须等于回合真实已实现盈亏 ----
    let t: &TradeDetail = &res.trades[0];
    let nav_last = res.net_value.last().expect("有净值序列").1;
    let realized_true = nav_last - 100_000.0; // 期末空仓 ⇒ nav[-1] = 现金 = 初始资金 + 已实现盈亏
    assert!(
        realized_true != 0.0,
        "前置：真实已实现盈亏非零（{realized_true}），否则红断言空洞"
    );
    assert_close(
        // P1b 机械适配：v2 `pnl: Option<f64>` ⇒ 解包（Closed 回合必为 Some；None 即违约，须 fail loud）。
        t.pnl.expect("Closed 回合必须携带 pnl（02-spec §2）"),
        realized_true,
        1e-9,
        "R1：TradeDetail.pnl 必须 == 该回合真实已实现盈亏（= nav[-1] − initial_capital；\
         02-spec §2 全回合口径 Σ sell proceeds − Σ buy total_cost）",
    );
}

/// R2：L1 的 `commission` / `stamp_duty` / `gross_value` 不是**全回合加总**（现口径只覆盖末笔卖出）。
///
/// 期望（02-spec §2）：
/// - `gross_value == Σ_sell trade_value`
/// - `commission  == Σ_buy commission + Σ_sell commission`
/// - `stamp_duty  == Σ_sell stamp_duty`
///
/// 每笔的事实三件套由 `FeeModel` 在成交点写入（D4）；本场景不含「最低佣金/比例佣金」混合歧义
/// （买腿 trade_value≈50010 走比例分支；两笔卖腿均走最低佣金分支），故由 fills 的
/// `(qty, price)` 经 `FeeModel` 复算与原值**逐位相等**（复算仅作测试 oracle，不是生产口径）。
#[test]
fn r2_l1_amount_fields_are_not_whole_round_trip_sums() {
    let res = partial_sell_run();
    let f = fills(&res);
    assert_eq!(f.len(), 3, "前置：3 笔成交：{f:?}");

    let fee = FeeModel::default();
    let mut exp_gross = 0.0;
    let mut exp_commission = 0.0;
    let mut exp_stamp = 0.0;
    for x in &f {
        let trade_value = x.qty * x.price; // 成交事实：trade_value = qty × price（含滑点有效价）
        exp_commission += fee.commission(trade_value);
        if x.side == OrderSide::Sell {
            exp_gross += trade_value;
            exp_stamp += fee.stamp_duty(trade_value);
        }
    }

    let t: &TradeDetail = &res.trades[0];
    // 三项判据一次性收集（避免首项失败遮蔽其余两项，取证需同时看到三个 Δ）。
    let diffs = [
        ("gross_value", t.gross_value, exp_gross),
        ("commission", t.commission, exp_commission),
        ("stamp_duty", t.stamp_duty, exp_stamp),
    ];
    let bad: Vec<String> = diffs
        .iter()
        .filter(|(_, got, exp)| (got - exp).abs() > 1e-9)
        .map(|(k, got, exp)| format!("L1.{k}: 全回合期望 {exp}，实际 {got}（Δ = {}）", got - exp))
        .collect();
    assert!(
        bad.is_empty(),
        "R2：L1 金额字段必须 == 全回合加总（02-spec §2），实得 {} 项不符:\n  {}",
        bad.len(),
        bad.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// R5：零长回合（同一 bar 内 buy + sell）在**当前数据模型**下无法归属（无 rt_seq）
// ---------------------------------------------------------------------------

/// 恒 80 分（Buy 区）插件：bar0 决策买入 → bar1 open 成交；bar1 的插针 low 触发 Intrabar 硬止损
/// ⇒ 买 / 卖两笔成交落在**同一 bar**（`engine.rs:507` 步骤 1 + `:637-666` 步骤 2，ADR-027 F5）。
const SCRIPT_ALWAYS_BUY: &str = r#"
function on_bar(ctx) { return 80; }
"#;

fn zero_length_run() -> strategy_core::EnsembleResult {
    let mut bars = price_bars(&[10.0, 10.0]);
    // bar1：open 10（买入成交），low 9.4 破线（avg_cost×(1−5%) ≈ 9.5043）→ 当 bar 止损平仓。
    bars[1].low = 9.4;
    bars[1].close = 9.5;
    bars[1].high = 10.0;
    let mut cfg = cfg(
        vec![slot(SCRIPT_ALWAYS_BUY, "sha256:adr027_zero_len", 1.0)],
        ExecutionPolicy::LumpSum { position_pct: 1.0 },
        100_000.0,
    );
    cfg.stop = Some(StopConfig {
        kind: StopKind::FixedPct,
        value: 0.05,
        trigger: StopTrigger::Intrabar,
    });
    run(&cfg, &bars)
}

/// R5 红判据（03-test-plan）：该回合 `l2_count == 2` 且两笔成交归属同一 `rt_seq`。
/// 现数据模型**无** `rt_seq`/`l2_count`（02-spec §1.1/§1.2）⇒ 归属只能退化到
/// `[open_bar, close_bar]` 窗口推断（ADR-027 D6 明确否掉），而零长回合 `open_bar == close_bar`
/// 正是该推断最脆弱的形态。
#[test]
fn r5_zero_length_round_trip_cannot_be_attributed_without_rt_seq() {
    let res = zero_length_run();
    let f = fills(&res);

    // ---- 构造守卫（绿）：零长回合确实被构造出来（open_bar == close_bar == 1，2 笔成交同 bar） ----
    assert_eq!(res.trades.len(), 1, "应恰有 1 个回合：{:?}", res.trades);
    let t = &res.trades[0];
    assert_eq!(t.open_bar, 1, "回合开于 bar1");
    // P1b 机械适配：v2 `close_bar`/`hold_bars` 为 `Option<_>` ⇒ 解包为 `Some(1)`/`Some(0)`。
    assert_eq!(t.close_bar, Some(1), "回合收于同一 bar（零长回合，ADR-027 F5）");
    assert_eq!(t.hold_bars, Some(0), "零长回合 hold_bars == 0");
    let bar1_fills: Vec<_> = f.iter().filter(|x| x.bar_index == 1).collect();
    assert_eq!(bar1_fills.len(), 2, "bar1 内两笔成交：{bar1_fills:?}");
    assert_eq!(bar1_fills[0].side, OrderSide::Buy, "先买");
    assert_eq!(bar1_fills[1].side, OrderSide::Sell, "后卖（Intrabar 止损当 bar 成交）");
    assert_eq!(bar1_fills[1].reason, OrderReason::StopTrigger, "止损来源");

    // ---- R5 红判据（一次性收集全部缺口，避免首项失败遮蔽其余） ----
    let trade_dbg = format!("{t:?}");
    let mut missing: Vec<String> = Vec::new();
    if !trade_dbg.contains("l2_count") {
        missing.push(format!(
            "L1 缺 `l2_count` 摘要字段（02-spec §1.2）⇒ 无法表达「该回合 = 2 笔成交」；Debug: {trade_dbg}"
        ));
    } else if !trade_dbg.contains("l2_count: 2") {
        missing.push(format!("L1.l2_count != 2（该零长回合有 2 笔成交）；Debug: {trade_dbg}"));
    }
    if !trade_dbg.contains("rt_seq") {
        missing.push(format!("L1 缺 `rt_seq` 字段（02-spec §1.2/§3 D6 归属键）；Debug: {trade_dbg}"));
    }
    for (k, x) in bar1_fills.iter().enumerate() {
        let ev = res.per_bar[x.bar_index]
            .events
            .iter()
            .filter(|e| matches!(e, EngineEvent::Fill { .. }))
            .nth(k)
            .expect("按序取回该成交事件");
        let dbg = format!("{ev:?}");
        if !dbg.contains("rt_seq") {
            missing.push(format!(
                "同 bar 第 {k} 笔成交事实缺 `rt_seq`（02-spec §1.1 FillFact）⇒ 归属只能退化到 \
                 [open_bar, close_bar] 窗口推断（D6 明确否掉）；Debug: {dbg}"
            ));
        }
    }
    assert!(
        missing.is_empty(),
        "R5：零长回合必须可归属（l2_count == 2 且两笔同 rt_seq），实得 {} 项缺口:\n  {}",
        missing.len(),
        missing.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// R6：`fills` 事实源 与 `per_bar.events` 事件源在字段完备性上的现状
// ---------------------------------------------------------------------------

/// R6 红判据：**两源同事实**（同一 `Vec<EngineEvent>` 的两个投影——`/fills` 块的唯一来源是
/// `crates/application/src/workbench.rs:2118-2128` 对 `per_bar[i].events` 的扫描；
/// per_bar 落库形态见 `:2247-2253`）⇒ 逐笔必须携带 02-spec §1.1 的
/// `rt_seq`/`trade_value`/`commission`/`stamp_duty`。当前 `EngineEvent::Fill` 仅
/// `{bar_index, side, qty, price, reason}`（`crates/strategy-core/src/engine.rs:224-235`）。
///
/// **P4b 修订（2026-09-20，反假绿）**：原文的「两源一致性」是 `let events_side = f.clone();
/// assert_eq!(events_side, f)` —— **自比较（恒真、覆盖面 0）**。现改为**真实两源**逐笔全字段比对：
/// 源 A = 批式入口的 `per_bar` 事件源，源 B = **会话分块驱动**（与 `/fills` 块同产径，见
/// [`fill_source_chunked`]）的 `fills` 事实源；两源是同一场景的**两条独立产径**（不同入口 +
/// 不同分块边界 chunk=2）⇒ 该断言能真的命中断块 drain 的丢/重/乱序与字段偏离。
#[test]
fn r6_fill_fact_source_lacks_rt_seq_and_fee_triple() {
    let (cfg, bars) = partial_sell_case();
    let res = run(&cfg, &bars);
    let f = fills(&res);
    assert_eq!(f.len(), 3, "前置：3 笔成交：{f:?}");

    // ---- 两源逐笔一致性（绿）：**真实两源**（per_bar 事件源 vs fills 事实源）----
    let events_side = fill_source_per_bar(&res);
    let facts_side = fill_source_chunked(&cfg, &bars, 2);
    assert_eq!(
        facts_side.len(),
        events_side.len(),
        "两源笔数须相等（不等 ⇒ 分块 drain 丢/重成交）：事件源 {events_side:?} / 事实源 {facts_side:?}"
    );
    for (k, (a, b)) in events_side.iter().zip(facts_side.iter()).enumerate() {
        assert_eq!(a.ts, b.ts, "第 {k} 笔 ts 两源不一致：事件源 {a:?} / 事实源 {b:?}");
        assert_eq!(
            a.bar_index, b.bar_index,
            "第 {k} 笔 bar_index 两源不一致：事件源 {a:?} / 事实源 {b:?}"
        );
        assert_eq!(a.side, b.side, "第 {k} 笔 side 两源不一致：事件源 {a:?} / 事实源 {b:?}");
        assert_eq!(
            a.rt_seq, b.rt_seq,
            "第 {k} 笔 rt_seq 两源不一致（回合号须同规则、同序）：事件源 {a:?} / 事实源 {b:?}"
        );
        assert_eq!(
            a.reason, b.reason,
            "第 {k} 笔 reason 两源不一致：事件源 {a:?} / 事实源 {b:?}"
        );
        assert_close(a.qty, b.qty, 0.0, &format!("第 {k} 笔 qty 两源不一致"));
        assert_close(a.price, b.price, 0.0, &format!("第 {k} 笔 price 两源不一致"));
        assert_close(
            a.trade_value,
            b.trade_value,
            0.0,
            &format!("第 {k} 笔 trade_value 两源不一致")
        );
        assert_close(
            a.commission,
            b.commission,
            0.0,
            &format!("第 {k} 笔 commission 两源不一致")
        );
        assert_close(
            a.stamp_duty,
            b.stamp_duty,
            0.0,
            &format!("第 {k} 笔 stamp_duty 两源不一致")
        );
    }
    // 逐字段循环之外的**整表**相等（顺序敏感、长度敏感；防「循环只比了前半」类退化）。
    assert_eq!(
        facts_side, events_side,
        "两源逐笔全字段相等（顺序敏感；同一 run 的两条产径必须同事实）"
    );

    // ---- R6 红判据（一次性收集全部缺口）----
    let required = ["rt_seq", "trade_value", "commission", "stamp_duty"];
    let mut missing: Vec<String> = Vec::new();
    for (k, x) in f.iter().enumerate() {
        let ev = res.per_bar[x.bar_index]
            .events
            .iter()
            .filter(|e| matches!(e, EngineEvent::Fill { .. }))
            .nth(f[..k].iter().filter(|y| y.bar_index == x.bar_index).count())
            .expect("按序取回该成交事件");
        let dbg = format!("{ev:?}");
        for field in required {
            if !dbg.contains(field) {
                missing.push(format!(
                    "第 {k} 笔（bar{} {:?}）缺 `{field}`；Debug: {dbg}",
                    x.bar_index, x.side
                ));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "R6：两源（fills 事实源 / per_bar.events）逐笔必须携带 rt_seq + 金额三件套（02-spec §1.1），\
         实得 {} 项缺口:\n  {}",
        missing.len(),
        missing.join("\n  ")
    );
}
