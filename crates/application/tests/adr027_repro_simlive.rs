// ADR-027 复现测试（R3 / R4，**sim-live 侧**）——先红后绿（`design/17-trade-detail-layering/03-test-plan.md` §1）。
//
// 纪律：
// - **不启动服务、不接 DB、不起会话编排器**：纯手动会话（strategy_set 空 ⇒ 无 QuickJS worker、无 provider），
//   端口全部用本文件内的最小内存 mock（`SimSessionStore` 11 个方法）+ 可控时钟；
//   这是「单元级复现」而非集成起服务（03-test-plan §1 允许的替代路径见任务书）。
// - 只做复现取证，不修生产代码；红是预期结果；判据为正向断言（断言具体值/恒等式）。
//
// 被测路径（只读，未修改）：
// - R3：`crates/application/src/simlive.rs:1860-1925` `sim_trades_to_trade_details`
//   —— `stamp_duty: 0.0` 硬编码（`:1914`），且卖出侧合并 `fee` 整笔计入 `commission`（`:1905`）。
//   上游事实在 `crates/simlive/src/fill.rs:94-108` 已算出 `commission` 与 `stamp_duty`，落库时被合并为单列 `fee`
//   （`sim_trades.fee`，ADR-027 F9）。
// - R4：同函数 `open_bar = (lot.open_ts / bar_sec) as usize` / `close_bar = (t.ts / bar_sec) as usize`（`:1902-1903`）
//   —— 由 ts 与 `bar_sec` 反算，**不是**真实 bar 序号（02-spec §1.1「禁 ts/bar_sec 反算」；ADR-027 §2.13）。

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};

use application::simlive::{PlaceOrderReq, SimLiveService, StartSessionReq};
use domain::ports::{
    Clock, NewSimSession, NewSimTrade, SimPositionRow, SimSessionResult, SimSessionState,
    SimSessionStatus, SimSessionStore, SimSessionView,
};

// ---------------------------------------------------------------------------
// 最小端口 mock（内存，确定性）
// ---------------------------------------------------------------------------

/// 可控时钟（start/end/成交 ts 全部来自此；无系统时间依赖）。
struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::Relaxed), 0).unwrap()
    }
}
impl TestClock {
    fn set(&self, ts: i64) {
        self.0.store(ts, Ordering::Relaxed);
    }
}

/// 内存 `SimSessionStore`：记录成交 / 持仓 / 结束结果（断言读回）。
#[derive(Default)]
struct MockSimStore {
    trades: Mutex<Vec<NewSimTrade>>,
    sessions: Mutex<HashMap<String, SimSessionView>>,
    results: Mutex<HashMap<String, SimSessionResult>>,
    states: Mutex<HashMap<String, SimSessionState>>,
}

#[async_trait]
impl SimSessionStore for MockSimStore {
    async fn create_session(&self, s: &NewSimSession) -> Result<()> {
        self.sessions.lock().unwrap().insert(
            s.id.clone(),
            SimSessionView {
                id: s.id.clone(),
                name: s.name.clone(),
                cash_init: s.cash_init,
                strategy_set: s.strategy_set.clone(),
                stock_set: s.stock_set.clone(),
                period: s.period.clone(),
                start_ts: s.start_ts,
                end_ts: None,
                status: SimSessionStatus::Running,
                source: s.source.clone(),
            },
        );
        Ok(())
    }
    async fn get_session(&self, id: &str) -> Result<Option<SimSessionView>> {
        Ok(self.sessions.lock().unwrap().get(id).cloned())
    }
    async fn list_sessions(&self) -> Result<Vec<SimSessionView>> {
        Ok(self.sessions.lock().unwrap().values().cloned().collect())
    }
    async fn append_trade(&self, t: &NewSimTrade) -> Result<()> {
        self.trades.lock().unwrap().push(t.clone());
        Ok(())
    }
    async fn list_trades(&self, session_id: &str) -> Result<Vec<NewSimTrade>> {
        Ok(self
            .trades
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect())
    }
    async fn update_positions(&self, _: &str, _: &[SimPositionRow]) -> Result<()> {
        Ok(())
    }
    async fn upsert_state(&self, id: &str, state: &SimSessionState) -> Result<()> {
        self.states.lock().unwrap().insert(id.to_string(), state.clone());
        Ok(())
    }
    async fn get_state(&self, id: &str) -> Result<Option<SimSessionState>> {
        Ok(self.states.lock().unwrap().get(id).cloned())
    }
    async fn mark_end(
        &self,
        id: &str,
        end_ts: DateTime<Utc>,
        result: &SimSessionResult,
    ) -> Result<bool> {
        self.results
            .lock()
            .unwrap()
            .insert(id.to_string(), result.clone());
        let mut sessions = self.sessions.lock().unwrap();
        match sessions.get_mut(id) {
            Some(v) => {
                v.status = SimSessionStatus::Ended;
                v.end_ts = Some(end_ts);
                Ok(true)
            }
            None => Ok(false),
        }
    }
    async fn get_result(&self, id: &str) -> Result<Option<SimSessionResult>> {
        Ok(self.results.lock().unwrap().get(id).cloned())
    }
    async fn delete_session(&self, id: &str) -> Result<bool> {
        self.results.lock().unwrap().remove(id);
        Ok(self.sessions.lock().unwrap().remove(id).is_some())
    }
}

// ---------------------------------------------------------------------------
// 会话构造（纯手动：无策略、无编排器、无 provider）
// ---------------------------------------------------------------------------

/// 固定会话起点（与既有夹具同口径，确定性）。
fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()
}

/// 手动会话：市价买 1000@10 → 打市值 12 → 市价卖 1000@12 → 打市值 → stop_session。
/// 时钟推进 1800s（会话内、非 bar 边界：`1800 % 60 == 0` ⇒ 见 R4 的前置断言说明）。
async fn build_closed_session(store: Arc<MockSimStore>) -> (SimLiveService, String) {
    let base = fixed_now().timestamp();
    let clock = Arc::new(TestClock(AtomicI64::new(base)));
    let svc = SimLiveService::new(store.clone(), clock.clone(), backtest::FeeModel::default());
    let view = svc
        .start_session(&StartSessionReq {
            name: "adr027_r3r4".into(),
            cash_init: None,
            // 空策略集 ⇒ 纯手动会话：不 spawn 编排器 worker、不触 Registry/provider（无服务启动）
            strategy_set: vec![],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            buy_long_threshold: None,
            sell_threshold: None,
            strategies: Default::default(),
        })
        .await
        .expect("start_session（纯手动）");
    let id = view.id.clone();
    // 时钟推进到会话内 1817s（base+1817：**非 bar 边界**，M1 ⇒ 真实 bar 序号 = 30，余 17s）
    clock.set(base + 1817);
    svc.place_order(
        &id,
        &PlaceOrderReq {
            code: "510300".into(),
            side: "buy".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: None,
            source: "manual".into(),
        },
        10.0,
    )
    .await
    .unwrap()
    .expect("买成交");
    let mut latest = BTreeMap::new();
    latest.insert("510300".to_string(), 12.0);
    svc.mark_to_market(&id, &latest, 2000).unwrap();
    svc.place_order(
        &id,
        &PlaceOrderReq {
            code: "510300".into(),
            side: "sell".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: None,
            source: "manual".into(),
        },
        12.0,
    )
    .await
    .unwrap()
    .expect("卖成交");
    svc.mark_to_market(&id, &latest, 3000).unwrap();
    clock.set(base + 3600);
    (svc, id)
}

fn close_tol(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

// ---------------------------------------------------------------------------
// R3：sim-live 结算的 `stamp_duty` 恒 0（费已含印花税时）
// ---------------------------------------------------------------------------

/// 红判据（03-test-plan R3）：会话内一笔卖出，结算 `TradeDetail.stamp_duty > 0` **失败**。
///
/// 构造事实：买腿 `trade_value = 1000 × buy_price(10) = 10002` ⇒ `commission = 5`（最低佣金）；
/// 卖腿 `trade_value = 1000 × sell_price(12) = 11997.6` ⇒ `commission = 5`（最低）、
/// `stamp_duty = 11997.6 × 0.05% = 5.9988`。
/// 全回合口径应得 `commission = 5 + 5 = 10`、`stamp_duty = 5.9988`（02-spec §1.2/§2）。
#[tokio::test]
async fn r3_simlive_settlement_stamp_duty_is_not_zero() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap(), "stop 成功（结算落库）");

    let fee = backtest::FeeModel::default();
    let buy_tv = 1000.0 * fee.buy_price(10.0);
    let buy_comm = fee.commission(buy_tv);
    let sell_tv = 1000.0 * fee.sell_price(12.0);
    let sell_comm = fee.commission(sell_tv);
    let sell_stamp = fee.stamp_duty(sell_tv);
    assert!(sell_stamp > 0.0, "前置：默认费率下卖腿印花税 > 0");

    // ---- 前置（绿）：撮合点确实算出了佣金与印花税，只是落库时被合并为单列 `fee` ----
    let trades_db = store.trades.lock().unwrap();
    let sell_row = trades_db
        .iter()
        .find(|t| t.side == "sell")
        .expect("卖出一笔落库");
    assert!(
        close_tol(sell_row.fee, sell_comm + sell_stamp, 1e-9),
        "前置：sim_trades.fee == commission + stamp = {}（拆分事实存在，被合并为一列；ADR-027 F9），实际 {}",
        sell_comm + sell_stamp,
        sell_row.fee
    );

    // ---- R3 红判据 ----
    let results = store.results.lock().unwrap();
    let result = results.get(&id).expect("结束结果已落库");
    let trades = result.trades.as_array().expect("trades 数组");
    assert_eq!(trades.len(), 1, "买→卖 ⇒ 1 个已平仓段");
    let t = &trades[0];
    let got_stamp = t["stamp_duty"].as_f64().expect("stamp_duty 为 number");
    let got_comm = t["commission"].as_f64().expect("commission 为 number");
    let exp_comm = buy_comm + sell_comm;
    let d_stamp = got_stamp - sell_stamp;
    let d_comm = got_comm - exp_comm;
    let mut bad: Vec<String> = Vec::new();
    if !(got_stamp > 0.0) {
        bad.push(format!(
            "stamp_duty 必须 > 0（本笔卖出含印花税 {}），实际 {}（simlive.rs:1914 硬编码 0.0）",
            sell_stamp, got_stamp
        ));
    }
    if d_stamp.abs() > 1e-9 {
        bad.push(format!(
            "stamp_duty 必须 == Σ_sell 印花税 = {sell_stamp}，实际 {got_stamp}（Δ = {d_stamp}）"
        ));
    }
    if d_comm.abs() > 1e-9 {
        bad.push(format!(
            "commission 必须 == Σ_buy + Σ_sell 佣金 = {exp_comm}，实际 {got_comm}（Δ = {d_comm}；\
             现口径把卖腿「佣金+印花税」合并值整笔计入 commission）"
        ));
    }
    assert!(
        bad.is_empty(),
        "R3：sim-live 结算费用三件套必须与撮合点事实一致，实得 {} 项不符:\n  {}",
        bad.len(),
        bad.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// R4：sim-live 的 `bar_index` 由 `ts / bar_sec` 反算（非真实 bar 序号）
// ---------------------------------------------------------------------------

/// 红判据（03-test-plan R4）：断言 `open_bar == 真实 bar 序号` **失败**。
///
/// 会话 `period = "M1"` ⇒ `bar_sec = 60`；成交 ts 来自可控时钟（`base + 1817`，**非 bar 边界**）。
/// 真实 bar 序号（会话内 0-based）= `(ts − session_start_ts) / bar_sec = 30`；
/// 现实现产出 `ts / 60`（绝对纪元商，≈ 2.98e7）。
#[tokio::test]
async fn r4_simlive_bar_index_is_not_reverse_computed_from_ts() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap(), "stop 成功（结算落库）");

    let session_start = fixed_now().timestamp();
    let bar_sec = 60_i64; // period = M1
    let results = store.results.lock().unwrap();
    let result = results.get(&id).expect("结束结果已落库");
    let trades = result.trades.as_array().expect("trades 数组");
    let t = &trades[0];
    let open_ts = t["open_ts"].as_i64().expect("open_ts");
    let close_ts = t["close_ts"].as_i64().expect("close_ts");
    let open_bar = t["open_bar"].as_u64().expect("open_bar");
    let close_bar = t["close_bar"].as_u64().expect("close_bar");

    // 前置（绿）：成交 ts 不在 bar 边界上（否则「反算」与「真实序号」可能巧合等价，红判据被弱化）
    assert_ne!(
        open_ts % bar_sec,
        0,
        "前置：成交 ts 必须非 bar 边界对齐（{open_ts} % {bar_sec}）"
    );

    let want_open = (open_ts - session_start) / bar_sec; // 会话内真实 bar 序号（0-based）
    let want_close = (close_ts - session_start) / bar_sec;
    let reverse_open = open_ts / bar_sec; // 现实现的反算商
    let reverse_close = close_ts / bar_sec;

    let mut bad: Vec<String> = Vec::new();
    if open_bar as i64 != want_open {
        bad.push(format!(
            "open_bar 必须 == 真实 bar 序号（会话内 0-based）= {want_open}，实际 {open_bar}"
        ));
    }
    if close_bar as i64 != want_close {
        bad.push(format!(
            "close_bar 必须 == 真实 bar 序号（会话内 0-based）= {want_close}，实际 {close_bar}"
        ));
    }
    if open_bar as i64 == reverse_open {
        bad.push(format!(
            "open_bar 必须**不是** ts/bar_sec 的反算商（02-spec §1.1「禁 ts/bar_sec 反算」），\
             实际 {open_bar} == {open_ts}/{bar_sec}"
        ));
    }
    if close_bar as i64 == reverse_close {
        bad.push(format!(
            "close_bar 必须**不是** ts/bar_sec 的反算商，实际 {close_bar} == {close_ts}/{bar_sec}"
        ));
    }
    assert!(
        bad.is_empty(),
        "R4：sim-live bar_index 必须为真实 bar 序号，实得 {} 项不符:\n  {}",
        bad.len(),
        bad.join("\n  ")
    );
}
