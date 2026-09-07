//! 应用层 SimLiveService 集成测试（**mock 端口**，确定性、无实时 DB）。
//! 全部输入为手工固定数据 + 固定时钟，无 RNG / 无时间依赖 / 无实时行情，任意次运行一致。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use domain::ports::{
    BacktestBarRead, BacktestProgressSink, BacktestRunStore, Clock, NewRun, NewSimSession,
    NewSimTrade, RunFilter, RunResult, RunView, SimPositionRow, SimSessionResult, SimSessionStatus,
    SimSessionStore, SimSessionView,
};

use application::service::BacktestService;
use application::simlive::{PlaceOrderReq, SimLiveService, StartSessionReq};
use backtest::{Bar, ParamValue};
use simlive::StrategyConfig;

/// 固定时钟（确定性；11-sim-live 会话/成交 ts 全部来自此）。
struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()
}

/// mock SimSessionStore：记录调用 + 提供会话读模型；mark_end 按状态机转移。
#[derive(Default)]
struct MockSimStore {
    created: Mutex<Vec<NewSimSession>>,
    trades: Mutex<Vec<NewSimTrade>>,
    pos_updates: Mutex<Vec<(String, Vec<SimPositionRow>)>>,
    ended: Mutex<Vec<(String, SimSessionResult)>>,
    sessions: Mutex<HashMap<String, SimSessionView>>,
    results: Mutex<HashMap<String, SimSessionResult>>,
}

#[async_trait]
impl SimSessionStore for MockSimStore {
    async fn create_session(&self, s: &NewSimSession) -> Result<()> {
        self.created.lock().unwrap().push(s.clone());
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
    async fn update_positions(&self, session_id: &str, positions: &[SimPositionRow]) -> Result<()> {
        self.pos_updates
            .lock()
            .unwrap()
            .push((session_id.into(), positions.to_vec()));
        Ok(())
    }
    async fn mark_end(&self, session_id: &str, end_ts: DateTime<Utc>, result: &SimSessionResult) -> Result<bool> {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(v) = sessions.get_mut(session_id) else {
            return Ok(false);
        };
        if v.status != SimSessionStatus::Running {
            return Ok(false);
        }
        v.status = SimSessionStatus::Ended;
        v.end_ts = Some(end_ts);
        self.ended.lock().unwrap().push((session_id.into(), result.clone()));
        self.results.lock().unwrap().insert(session_id.into(), result.clone());
        Ok(true)
    }
    async fn get_result(&self, session_id: &str) -> Result<Option<SimSessionResult>> {
        Ok(self.results.lock().unwrap().get(session_id).cloned())
    }
    async fn delete_session(&self, session_id: &str) -> Result<bool> {
        Ok(self.sessions.lock().unwrap().remove(session_id).is_some())
    }
}

fn service(store: Arc<MockSimStore>) -> SimLiveService {
    SimLiveService::new(
        store,
        Arc::new(FixedClock(fixed_now())),
        backtest::FeeModel::default(),
    )
}

async fn started(store: Arc<MockSimStore>) -> (SimLiveService, String) {
    let svc = service(store);
    let view = svc
        .start_session(&StartSessionReq {
            name: "t1".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
        })
        .await
        .unwrap();
    (svc, view.id.clone())
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

#[tokio::test]
async fn start_session_defaults_cash_to_1m_and_persists() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    assert!(id.starts_with("s_"), "会话 id 前缀 s_");
    // 默认账户状态
    let acct = svc.get_account(&id).unwrap();
    close(acct.cash, 1_000_000.0);
    close(acct.equity, 1_000_000.0);
    assert_eq!(acct.session_id, id);
    // 落库计数
    assert_eq!(store.created.lock().unwrap().len(), 1);
    assert_eq!(store.created.lock().unwrap()[0].cash_init, DEFAULT_CASH);
}

#[tokio::test]
async fn market_buy_fills_at_latest_applies_account_and_persists() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let fill = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: None,
                intent_id: Some("int-1".into()),
                source: "manual".into(),
            },
            10.0,
        )
        .await
        .unwrap()
        .expect("市价即时成交");
    close(fill.price, 10.002); // 含滑点
    close(fill.qty, 1000.0);
    close(fill.fee, 5.0); // 佣金 10002×0.025% < 5 → 取 5

    let acct = svc.get_account(&id).unwrap();
    close(acct.cash, 1_000_000.0 - 1000.0 * 10.002 - 5.0);
    let pos = svc.get_positions(&id).unwrap();
    assert_eq!(pos.len(), 1);
    assert_eq!(pos[0].code, "510300");
    close(pos[0].qty, 1000.0);
    close(pos[0].avg_cost, 10.002);

    // 落库：成交明细 + 持仓
    assert_eq!(store.trades.lock().unwrap().len(), 1);
    assert_eq!(store.trades.lock().unwrap()[0].code, "510300");
    assert_eq!(store.pos_updates.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn limit_not_touched_records_pending_no_fill_no_trade_persist() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let fill = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: Some(9.0),
                intent_id: Some("int-l1".into()),
                source: "manual".into(),
            },
            10.5, // 最新 10.5 > 限价 9 → 不触及
        )
        .await
        .unwrap();
    assert!(fill.is_none(), "限价未触及不成交");
    // pending 单记录
    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].status, "pending");
    assert_eq!(orders[0].filled_qty, 0.0);
    // 不落成交明细 / 不动持仓
    assert!(store.trades.lock().unwrap().is_empty());
    assert!(store.pos_updates.lock().unwrap().is_empty());
    assert!(svc.get_account(&id).unwrap().cash == 1_000_000.0);
}

#[tokio::test]
async fn cancel_order_cancels_pending_but_not_filled() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    // pending 单
    let _ = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: Some(9.0),
                intent_id: None,
                source: "manual".into(),
            },
            10.5,
        )
        .await
        .unwrap();
    let orders = svc.get_orders(&id).unwrap();
    let pend_id = orders[0].id.clone();
    assert!(svc.cancel_order(&id, &pend_id).await.unwrap(), "撤 pending 成功");
    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders[0].status, "cancelled");

    // 已成交不可撤
    let fill = svc
        .place_order(
            &id,
            &PlaceOrderReq {
                code: "510300".into(),
                side: "buy".into(),
                qty: 100.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            10.0,
        )
        .await
        .unwrap()
        .expect("成交");
    let filled_id = svc
        .get_orders(&id).unwrap().iter().rev().find(|o| o.status == "filled").unwrap().id.clone();
    assert!(!svc.cancel_order(&id, &filled_id).await.unwrap(), "已成交不可撤");
    assert!(!svc.cancel_order(&id, "no-such").await.unwrap(), "未知单返回 false");
    let _ = fill;
}

#[tokio::test]
async fn pnl_and_mark_to_market_reflect_unrealized() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let _ = svc
        .place_order(
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
        .unwrap();
    // 打市值到 11.0 → 未实现 = 1000×(11 - 10.002) ≈ 998
    let mut latest = std::collections::BTreeMap::new();
    latest.insert("510300".into(), 11.0);
    svc.mark_to_market(&id, &latest, 2000).unwrap();
    let pnl = svc.get_pnl(&id).unwrap();
    close(pnl.realized_pnl, 0.0);
    close(pnl.unrealized_pnl, 1000.0 * (11.0 - 10.002));
    let acct = svc.get_account(&id).unwrap();
    close(acct.equity, 1_000_000.0 - 1000.0 * 10.002 - 5.0 + 1000.0 * 11.0);
}

#[tokio::test]
async fn place_order_is_idempotent_by_intent() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let req = PlaceOrderReq {
        code: "510300".into(),
        side: "buy".into(),
        qty: 1000.0,
        limit_price: None,
        intent_id: Some("int-dup".into()),
        source: "manual".into(),
    };
    let f1 = svc.place_order(&id, &req, 10.0).await.unwrap().expect("首次成交");
    let f2 = svc.place_order(&id, &req, 20.0).await.unwrap().expect("重复调用返回首次");
    // 幂等：返回同一次成交（即便最新价不同）
    assert_eq!(f1, f2);
    // 只记一笔成交明细
    assert_eq!(store.trades.lock().unwrap().len(), 1, "intent 去重不重复落单");
    let pos = svc.get_positions(&id).unwrap();
    close(pos[0].qty, 1000.0); // 不重复加仓
}

#[tokio::test]
async fn stop_session_ends_and_persists_result_two_stop_returns_false() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    let _ = svc
        .place_order(
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
        .unwrap();
    assert!(svc.stop_session(&id).await.unwrap(), "stop 成功");
    let view = store.get_session(&id).await.unwrap().expect("会话存在");
    assert_eq!(view.status, SimSessionStatus::Ended);
    assert!(view.end_ts.is_some());
    // 结束结果落库
    assert_eq!(store.ended.lock().unwrap().len(), 1);
    // 二次 stop → false（内存已 ended）
    assert!(!svc.stop_session(&id).await.unwrap(), "二次 stop false");
    assert!(!svc.stop_session("no-such").await.unwrap(), "未知会话 false");
}

#[tokio::test]
async fn unknown_session_errors() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store);
    assert!(svc.get_account("no-such").is_err());
    assert!(svc.mark_to_market("no-such", &Default::default(), 0).is_err());
    let r = svc
        .place_order(
            "no-such",
            &PlaceOrderReq { code: "510300".into(), side: "buy".into(), qty: 1.0, limit_price: None, intent_id: None, source: "manual".into() },
            10.0,
        )
        .await;
    assert!(r.is_err(), "未知会话下单应 Err");
}

/// 常量镜像 DEFAULT_CASH_INIT（测试断言用）。
const DEFAULT_CASH: f64 = 1_000_000.0;

// ── 11-sim-live / L2：RealtimeStrategyOrchestrator 联动（固定 bar，无实时 DB）──

fn num_params(pairs: &[(&str, f64)]) -> std::collections::HashMap<String, ParamValue> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), ParamValue::Num(*v)))
        .collect()
}

fn dma_bar(ts: i64, close: f64) -> Bar {
    Bar { ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 10_000.0 }
}

/// 配置一个会产生「金叉买入」的编排器（dual_ma fast=2 slow=3，序列末 bar 金叉）。
async fn configured_buy_service(store: Arc<MockSimStore>) -> (SimLiveService, String) {
    let (svc, id) = started(store.clone()).await;
    let configs = vec![StrategyConfig {
        id: "dual_ma".into(),
        params: num_params(&[("fast", 2.0), ("slow", 3.0)]),
        stocks: vec!["510300".into()],
        weight: 1.0,
    }];
    svc.configure_strategies(&id, configs).unwrap();
    (svc, id)
}

/// 先低后高序列 → dual_ma 于末 bar（ts=103）金叉 → Buy(100)。返回逐 bar。
fn golden_buy_bars() -> Vec<Bar> {
    vec![dma_bar(100, 12.0), dma_bar(101, 8.0), dma_bar(102, 9.0), dma_bar(103, 14.0)]
}

/// 喂入全部 bar，返回最后一次 process_bar 的事件。
async fn feed_all(svc: &SimLiveService, id: &str, bars: &[Bar]) -> Vec<simlive::SignalEvent> {
    let mut last = Vec::new();
    for b in bars {
        last = svc.process_bar(id, "510300", b.clone()).await.unwrap();
    }
    last
}

#[tokio::test]
async fn set_trading_on_and_buy_threshold_places_aggregate_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    assert!(svc.set_trading(&id, true).unwrap(), "开关打开返回 true");
    assert!(svc.trading_enabled(&id).unwrap(), "查询开关态 true");

    let last_events = feed_all(&svc, &id, &golden_buy_bars()).await;

    // 达做多阈值 → 下单（source=aggregate_strategy）。
    let pos = svc.get_positions(&id).unwrap();
    assert_eq!(pos.len(), 1, "建立持仓");
    assert_eq!(pos[0].code, "510300");
    close(pos[0].qty, 100.0); // DEFAULT_AGGREGATE_QTY

    // 落库一笔成交（source=aggregate_strategy）。
    let trades = store.trades.lock().unwrap();
    assert_eq!(trades.len(), 1);
    assert_eq!(trades[0].source, "aggregate_strategy");
    assert_eq!(trades[0].code, "510300");

    // 事件流：末 bar 两策略事件均 ordered=true，聚合分=100。
    assert_eq!(last_events.len(), 1, "仅一个策略覆盖该 stock");
    assert_eq!(last_events[0].strategy_id, "dual_ma");
    assert!(last_events[0].ordered);
    close(last_events[0].aggregate_score, 100.0);
    assert_eq!(last_events[0].signal, "buy");
    assert_eq!(last_events[0].code, "510300");
}

#[tokio::test]
async fn set_trading_off_only_scores_no_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    // 关闭（默认也 off）：只评估/评分，不入单。
    assert!(!svc.set_trading(&id, false).unwrap(), "开关关闭返回 false");
    assert!(!svc.trading_enabled(&id).unwrap());

    let last_events = feed_all(&svc, &id, &golden_buy_bars()).await;

    assert!(last_events.iter().all(|e| !e.ordered), "off 时不下单");
    close(last_events[0].aggregate_score, 100.0);
    assert_eq!(svc.get_positions(&id).unwrap().len(), 0, "无持仓");
    assert!(store.trades.lock().unwrap().is_empty(), "无成交落库");
}

#[tokio::test]
async fn trading_on_no_threshold_no_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    svc.set_trading(&id, true).unwrap();
    // 单调上涨但无「升级金叉」（首根即有 prev_above=None → Hold；后续一直 above → Hold）。
    let bars = vec![dma_bar(100, 10.0), dma_bar(101, 11.0), dma_bar(102, 12.0), dma_bar(103, 13.0)];
    let last = feed_all(&svc, &id, &bars).await;
    assert!(last.iter().all(|e| !e.ordered), "未达做多阈值不下单");
    assert_eq!(svc.get_positions(&id).unwrap().len(), 0);
}

#[tokio::test]
async fn get_strategy_signal_and_analysis_return_evaluations() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    feed_all(&svc, &id, &golden_buy_bars()).await;

    let sig = svc.get_strategy_signal(&id, "510300").unwrap().expect("有评估");
    close(sig.aggregate_score, 100.0);
    assert_eq!(sig.signal, "buy");
    assert_eq!(sig.per_strategy_scores.len(), 1);
    assert_eq!(sig.per_strategy_scores[0].strategy_id, "dual_ma");
    close(sig.per_strategy_scores[0].score, 100.0);
    close(sig.latest_price, 14.0);

    // 未覆盖标的不评估。
    assert!(svc.get_strategy_signal(&id, "999999").unwrap().is_none());

    let analysis = svc.get_strategy_analysis(&id).unwrap();
    assert_eq!(analysis.len(), 1);
    assert_eq!(analysis[0].code, "510300");
}

#[tokio::test]
async fn process_bar_unconfigured_errors_and_unknown_stock_no_event() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    // 未配置编排器 → Err。
    let r = svc.process_bar(&id, "510300", dma_bar(100, 10.0)).await;
    assert!(r.is_err(), "未配置策略应 Err");

    let (svc2, id2) = configured_buy_service(store).await;
    // 已配置但未覆盖的标的 → Ok(空事件)。
    let ev = svc2.process_bar(&id2, "999999", dma_bar(100, 10.0)).await.unwrap();
    assert!(ev.is_empty(), "未覆盖标的无事件");
}

// ── 11-sim-live / L3：会话记录回看 + 回测对比 ──

/// 回测 run 存储 mock：记录 create_run 触发参数，返回自增 id。
#[derive(Default)]
struct MockBacktestStore {
    created: Mutex<Vec<NewRun>>,
    next_id: AtomicU64,
}

#[async_trait]
impl BacktestRunStore for MockBacktestStore {
    async fn create_run(&self, run: &NewRun) -> Result<i64> {
        self.created.lock().unwrap().push(run.clone());
        Ok(self.next_id.fetch_add(1, Ordering::Relaxed) as i64 + 1)
    }
    async fn update_run_progress(&self, _: i64, _: i32, _: DateTime<Utc>) -> Result<()> { Ok(()) }
    async fn mark_done(&self, _: i64, _: &RunResult) -> Result<()> { Ok(()) }
    async fn mark_failed(&self, _: i64, _: &str) -> Result<()> { Ok(()) }
    async fn list_runs(&self, _: &RunFilter) -> Result<Vec<RunView>> { Ok(Vec::new()) }
    async fn get_run(&self, _: i64) -> Result<Option<RunView>> { Ok(None) }
    async fn delete_run(&self, _: i64) -> Result<bool> { Ok(false) }
}

struct MockBarRead;
#[async_trait]
impl BacktestBarRead for MockBarRead {
    async fn bars(
        &self,
        _: &str,
        _: &domain::types::Period,
        _: DateTime<Utc>,
        _: DateTime<Utc>,
    ) -> Result<Vec<domain::types::Bar>> {
        Ok(Vec::new())
    }
}

struct MockProgress;
#[async_trait]
impl BacktestProgressSink for MockProgress {
    async fn send(&self, _: i64, _: i32, _: Option<DateTime<Utc>>) -> Result<()> { Ok(()) }
}

/// mock 回测服务（记录 create_run；后台任务读到空 bar → mark_failed，不影响断言）。
fn mock_backtest_service() -> (Arc<MockBacktestStore>, BacktestService) {
    let bt_store = Arc::new(MockBacktestStore::default());
    let bt = BacktestService::new(
        Arc::new(MockBarRead),
        bt_store.clone(),
        Arc::new(MockProgress),
        1,
    );
    (bt_store, bt)
}

/// 可控时钟：不再恒返回固定时刻（start/end 需可推进，保证回测区间 start<end）。
struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::Relaxed), 0).unwrap()
    }
}
impl TestClock {
    fn set(&self, ts: i64) { self.0.store(ts, Ordering::Relaxed); }
}

/// 以市价买/卖一笔，并两次打市值，得到固定净值序列（3 点）+ 1 个已平仓 round-trip。
/// 用可控时钟：start=base、end=base+3600（start<end，供回测对比区间）。并在开始时推进时钟使 start≠end。
async fn build_closed_session(store: Arc<MockSimStore>) -> (SimLiveService, String) {
    let base = fixed_now().timestamp();
    let clock = Arc::new(TestClock(AtomicI64::new(base)));
    let svc = SimLiveService::new(store.clone(), clock.clone(), backtest::FeeModel::default());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t1".into(), cash_init: None,
            strategy_set: vec!["dual_ma".into()], stock_set: vec!["510300".into()],
            period: "M1".into(), source: "manual".into(),
        })
        .await
        .unwrap();
    let id = view.id.clone();
    // 推进时钟（在会话内，模拟“一段时间后”），使商谈/stop 的 ts 与 start 不同。
    clock.set(base + 1800);
    // 买 1000 @ 10.0（市价 → 有效价 10.002、费 5）
    svc.place_order(
        &id,
        &PlaceOrderReq { code: "510300".into(), side: "buy".into(), qty: 1000.0,
            limit_price: None, intent_id: None, source: "manual".into() },
        10.0,
    ).await.unwrap().expect("买成交");
    // 打市值 12.0
    let mut latest = std::collections::BTreeMap::new();
    latest.insert("510300".to_string(), 12.0);
    svc.mark_to_market(&id, &latest, 2000).unwrap();
    // 卖 1000 @ 12.0（市价 → 有效价 11.9976、费 5 + 印花税）
    svc.place_order(
        &id,
        &PlaceOrderReq { code: "510300".into(), side: "sell".into(), qty: 1000.0,
            limit_price: None, intent_id: None, source: "manual".into() },
        12.0,
    ).await.unwrap().expect("卖成交");
    // 打市值 12.0（已无持仓 → equity = cash）
    svc.mark_to_market(&id, &latest, 3000).unwrap();
    // 推进到会话结束（end > start）。
    clock.set(base + 3600);
    (svc, id)
}

/// stop_session 结算：结果采用 backtest 指标口径（net_value={series,drawdown}、trades=TradeDetail、metrics=8 项）。
#[tokio::test]
async fn stop_session_result_uses_backtest_metrics_structure_and_trade_pnl() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap(), "stop 成功");

    let ended = store.ended.lock().unwrap();
    let (_, result) = &ended[0];
    // net_value = {series, drawdown}（3 点）
    assert!(result.net_value["series"].is_array(), "series 数组");
    assert_eq!(result.net_value["series"].as_array().unwrap().len(), 3);
    assert!(result.net_value["drawdown"].is_array(), "drawdown 数组");
    assert_eq!(result.net_value["drawdown"].as_array().unwrap().len(), 3);
    // trades = 已平仓 TradeDetail（1 笔 round-trip）
    let trades = result.trades.as_array().expect("trades 数组");
    assert_eq!(trades.len(), 1, "买→卖 → 1 个已平仓段");
    assert_eq!(trades[0]["shares"], serde_json::json!(1000.0));
    assert!(trades[0]["open_price"].as_f64().unwrap() > 0.0);
    assert!(trades[0]["close_price"].as_f64().unwrap() > 0.0);
    assert!(trades[0]["pnl"].as_f64().unwrap() > 0.0, "低买高卖盈利");
    // metrics = 8 项 backtest 指标
    let m = &result.metrics;
    for key in ["net_profit", "max_drawdown", "sharpe", "win_rate",
                "annualized_return", "trade_count", "avg_hold_bars"] {
        assert!(m[key].is_number(), "metrics.{key} 存在且为 number");
    }
    // 全盈（无亏损）⇒ profit_factor=∞ → serde_json 序列化为 null；否则为正 number。
    assert!(m["profit_factor"].is_null() || m["profit_factor"].as_f64().unwrap() > 0.0,
        "profit_factor 为 ∞(null) 或正数");
    assert_eq!(m["trade_count"], serde_json::json!(1), "已平仓 1 笔 ⇒ trade_count=1");
    assert_eq!(m["win_rate"], serde_json::json!(1.0), "唯一盈利 ⇒ win_rate=1");
    assert!(m["net_profit"].as_f64().unwrap() > 0.0, "净收益为正");
}

/// sim_list_sessions 返回历史会话（已结束附指标摘要）；sim_get_session 返回详情（元数据 + 结果）。
#[tokio::test]
async fn list_and_get_session_return_history_and_result() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap());

    // 未注入 backtest 时 run_backtest_compare 报错（防御性）。
    let r = svc.run_backtest_compare(&id).await;
    assert!(r.is_err(), "未注入回测服务 → Err");

    let entries = svc.list_sessions().await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].session.id, id);
    assert_eq!(entries[0].session.status, SimSessionStatus::Ended);
    assert!(entries[0].metrics.is_some(), "已结束会话附指标摘要");
    assert!(entries[0].metrics.as_ref().unwrap()["trade_count"].is_number());

    let detail = svc.get_session(&id).await.unwrap().expect("会话存在");
    assert_eq!(detail.session.id, id);
    assert!(detail.result.is_some(), "详情含结束结果");
    assert!(detail.result.as_ref().unwrap().metrics["sharpe"].is_number());

    // 未知 id → None
    assert!(svc.get_session("no-such").await.unwrap().is_none());
}

/// sim_run_backtest_compare：注入回测服务 → 按会话 (period/strategy/stock/date_range/initial) 触发一次 run。
#[tokio::test]
async fn run_backtest_compare_triggers_run_with_session_params() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = build_closed_session(store.clone()).await;
    assert!(svc.stop_session(&id).await.unwrap());

    let (bt_store, bt) = mock_backtest_service();
    let svc = svc.with_backtest(Arc::new(bt));
    let view = svc.run_backtest_compare(&id).await.unwrap();

    // 单 stock + 单策略 → 一次 run。
    assert_eq!(view.run_ids.len(), 1);
    assert_eq!(view.run_ids[0], 1);
    assert!(view.session_result.is_some(), "返回会话自身结果供对比");
    assert_eq!(view.session_id, id);

    // 触发参数 = 会话 (code=stock, period, strategy_id, date_range=[start,end), initial_capital)。
    let created = bt_store.created.lock().unwrap();
    assert_eq!(created.len(), 1);
    let run = &created[0];
    assert_eq!(run.code, "510300");
    assert_eq!(run.period, "M1");
    assert_eq!(run.strategy_id, "dual_ma");
    assert_eq!(run.initial_capital, 1_000_000.0);
    assert_eq!(run.date_from, fixed_now());
    assert!(run.date_to > run.date_from, "date_to > date_from");
}

/// run_backtest_compare 未知会话 → Err。
#[tokio::test]
async fn run_backtest_compare_unknown_session_errors() {
    let store = Arc::new(MockSimStore::default());
    let (bt_store, bt) = mock_backtest_service();
    let svc = service(store).with_backtest(Arc::new(bt));
    let r = svc.run_backtest_compare("no-such").await;
    assert!(r.is_err(), "未知会话 → Err");
    assert!(bt_store.created.lock().unwrap().is_empty(), "未触发 run");
}
