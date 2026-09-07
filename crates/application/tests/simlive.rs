//! 应用层 SimLiveService 集成测试（**mock 端口**，确定性、无实时 DB）。
//! 全部输入为手工固定数据 + 固定时钟，无 RNG / 无时间依赖 / 无实时行情，任意次运行一致。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use domain::ports::{
    BacktestBarRead, BacktestProgressSink, BacktestRunStore, Clock, KlineBarView, KlineRead,
    NewRun, NewSimSession, NewSimTrade, RunFilter, RunResult, RunView, SimPositionRow,
    SimSessionResult, SimSessionStatus, SimSessionStore, SimSessionView, SymbolLatestView,
};
use domain::types::Period;

use application::service::BacktestService;
use application::simlive::{InvalidConfig, PlaceOrderReq, SimLiveService, StartSessionReq, StrategyConfigInput};
use application::simlive_feed::SimLiveFeed;
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
            strategies: Default::default(),
        })
        .await
        .unwrap();
    (svc, view.id.clone())
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
}

/// F2：mock `KlineRead` —— 按 code 存最近一根 bar（确定性、无 DB）。`latest_bar` 走默认 `bars(None,1)`。
/// 另存「注册表」= `set_registered` 设定的 code 集（`symbols_with_latest` 返回这些注册行），
/// 供 `start_session` 的**注册表成员校验**（ADR 11-sim-live §4：strategies[].stocks 须为注册标的）。
#[derive(Default)]
struct MockKline {
    latest: Mutex<HashMap<String, KlineBarView>>,
    registered: Mutex<HashSet<String>>,
}

impl MockKline {
    fn set_latest(&self, code: &str, bar: Bar) {
        self.latest.lock().unwrap().insert(
            code.to_string(),
            KlineBarView {
                code: code.to_string(),
                ts: DateTime::from_timestamp(bar.ts, 0).unwrap(),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume as i64,
                amount: 0.0,
                source: None,
            },
        );
    }
    fn set_registered(&self, codes: &[&str]) {
        self.registered.lock().unwrap().extend(codes.iter().map(|s| s.to_string()));
    }
}

#[async_trait]
impl KlineRead for MockKline {
    async fn bars(&self, _period: Period, code: &str, _before: Option<DateTime<Utc>>, limit: i64) -> Result<Vec<KlineBarView>> {
        if limit < 1 {
            return Ok(Vec::new());
        }
        Ok(self.latest.lock().unwrap().get(code).cloned().into_iter().collect())
    }
    async fn symbols_with_latest(&self) -> Result<Vec<SymbolLatestView>> {
        Ok(self.registered.lock().unwrap().iter().map(|code| SymbolLatestView {
            code: code.clone(),
            name: None,
            interval_secs: 60,
            settlement: "T1".into(),
            enabled: true,
            last_ts: None,
            last_close: None,
            prev_close: None,
        }).collect())
    }
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
    let pos = svc.get_positions(&id).await.unwrap();
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
    let pos = svc.get_positions(&id).await.unwrap();
    close(pos[0].qty, 1000.0); // 不重复加仓
}

/// bug 修复（510880 持仓「最新价」=0.000）：持仓 latest/market_value 从本系统行情源解析。
/// start + place(buy 510880) → 持仓 latest=行情源 close（mock 返回 3.389）、market_value=qty×3.389。
#[tokio::test]
async fn place_order_position_latest_resolves_from_market_quote() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    // 模拟 /api/symbols latest last=3.389（510880 真实标的）；mock KlineRead 返回该 close。
    kline.set_latest("510880", dma_bar(100, 3.389));
    let svc = service(store.clone()).with_kline(kline.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t-quote".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510880".into()],
            period: "M1".into(),
            source: "manual".into(),
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let sid = view.id;

    let fill = svc
        .place_order(
            &sid,
            &PlaceOrderReq {
                code: "510880".into(),
                side: "buy".into(),
                qty: 1000.0,
                limit_price: None,
                intent_id: None,
                source: "manual".into(),
            },
            3.389,
        )
        .await
        .unwrap()
        .expect("市价即时成交");
    let _ = fill;

    let pos = svc.get_positions(&sid).await.unwrap();
    assert_eq!(pos.len(), 1);
    assert_eq!(pos[0].code, "510880");
    // 持仓最新价=行情源 close（非 0.000）；市值=qty×行情价（与成交价含滑点无关）。
    close(pos[0].latest, 3.389);
    close(pos[0].market_value, 1000.0 * 3.389);
}

/// bug 兜底：缺行情（未注入行情端口）→ 持仓 latest 回退 0.000（注明）。
#[tokio::test]
async fn place_order_position_latest_falls_back_zero_without_quote() {
    let store = Arc::new(MockSimStore::default());
    // 不注入 kline → 无行情源 → 回退 0.000。
    let svc = service(store.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t-noq".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let sid = view.id;

    svc.place_order(
        &sid,
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
    .expect("成交");

    let pos = svc.get_positions(&sid).await.unwrap();
    assert_eq!(pos.len(), 1);
    close(pos[0].latest, 0.000); // 无行情兜底
    close(pos[0].market_value, 0.0);
}

/// 评分/持仓价格一致：二者同源（KlineRead::latest_bar close）。
#[tokio::test]
async fn position_latest_matches_scoring_latest_price_same_quote_source() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    kline.set_latest("510300", dma_bar(100, 10.0));
    let svc = service(store.clone()).with_kline(kline.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "t-sync".into(),
            cash_init: None,
            strategy_set: vec!["dual_ma".into()],
            stock_set: vec!["510300".into()],
            period: "M1".into(),
            source: "manual".into(),
            strategies: Default::default(),
        })
        .await
        .unwrap();
    let sid = view.id;

    // 手动建仓 510300。
    svc.place_order(
        &sid,
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
    .expect("成交");

    // 配置策略 + 喂 bar → 评分 latest_price = 该 bar close。
    let configs = vec![StrategyConfig {
        id: "dual_ma".into(),
        params: num_params(&[("fast", 2.0), ("slow", 3.0)]),
        stocks: vec!["510300".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    svc.configure_strategies(&sid, configs).unwrap();
    let events = svc.process_bar(&sid, "510300", dma_bar(100, 10.0)).await.unwrap();
    // dual_ma 单策略 → 1 条信号事件。
    assert_eq!(events.len(), 1, "单策略一条事件");

    let signal = svc.get_strategy_signal(&sid, "510300").unwrap().expect("有评估");
    close(signal.latest_price, 10.0);
    let pos = svc.get_positions(&sid).await.unwrap();
    assert_eq!(pos.len(), 1);
    close(pos[0].latest, signal.latest_price); // 持仓与评分同价
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
        stock_weights: HashMap::new(),
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

/// F1：`get_orders`（OrderView）须含 `source`——手动单 source=manual；聚合自动单 source=aggregate_strategy。
/// （L4 修复：SimOrder/OrderView 未透传 source → 面板「来源」列空白。）
#[tokio::test]
async fn orders_include_source_manual_and_aggregate() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;

    // 手动市价单（码「600000」不在策略标的集内，避免占用聚合标的的持仓判定） → source=manual
    svc.place_order(
        &id,
        &PlaceOrderReq {
            code: "600000".into(),
            side: "buy".into(),
            qty: 1000.0,
            limit_price: None,
            intent_id: Some("int-src-manual".into()),
            source: "manual".into(),
        },
        10.0,
    )
    .await
    .unwrap()
    .expect("市价成交");
    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].code, "600000");
    assert_eq!(orders[0].source, "manual");

    // 聚合自动单 → source=aggregate_strategy（配置策略 + 开启开关 + 达阈值）
    let configs = vec![StrategyConfig {
        id: "dual_ma".into(),
        params: num_params(&[("fast", 2.0), ("slow", 3.0)]),
        stocks: vec!["510300".into()],
        weight: 1.0,
        stock_weights: HashMap::new(),
    }];
    svc.configure_strategies(&id, configs).unwrap();
    svc.set_trading(&id, true).unwrap();
    feed_all(&svc, &id, &golden_buy_bars()).await;

    let orders = svc.get_orders(&id).unwrap();
    assert_eq!(orders.len(), 2, "手动 + 聚合自动各 1 单");
    let agg = orders.iter().rev().find(|o| o.status == "filled").expect("存在 filled 单");
    assert_eq!(agg.source, "aggregate_strategy");
}

/// F2：`SimLiveFeed` poll 驱动——喂新 bar → `process_bar` → 会话 evaluation 非空 + 聚合自动单（enabled+达阈值）。
#[tokio::test]
async fn feed_polls_new_bar_drives_evaluation_and_auto_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc_inst, id) = configured_buy_service(store.clone()).await;
    let svc = Arc::new(svc_inst);
    svc.set_trading(&id, true).unwrap();

    let kline = Arc::new(MockKline::default());
    let feed = SimLiveFeed::new(svc.clone(), kline.clone(), Duration::from_millis(10));

    // 逐根 bar 推进 mock kline 的“最新”一根，再 tick —— 模拟 poll 式 feed 发现新 bar。
    for b in golden_buy_bars() {
        kline.set_latest("510300", b);
        feed.tick().await.unwrap();
    }

    // evaluation 非空（会话评分真实驱动）
    let analysis = svc.get_strategy_analysis(&id).unwrap();
    assert_eq!(analysis.len(), 1);
    assert_eq!(analysis[0].code, "510300");
    assert_eq!(analysis[0].signal, "buy");
    close(analysis[0].aggregate_score, 100.0);

    // 聚合自动单（enabled + 达阈值 → source=aggregate_strategy）
    let pos = svc.get_positions(&id).await.unwrap();
    assert_eq!(pos.len(), 1);
    close(pos[0].qty, 100.0);
    let orders = svc.get_orders(&id).unwrap();
    let agg = orders.iter().rev().find(|o| o.status == "filled").expect("存在自动单");
    assert_eq!(agg.source, "aggregate_strategy");
}

/// F2：`feed_targets` 对无编排器 running 会话自动配置默认策略（strategy_set × stock_set），并返回 poll 目标。
#[tokio::test]
async fn feed_targets_auto_configures_session_strategies() {
    let store = Arc::new(MockSimStore::default());
    let (svc_inst, id) = started(store.clone()).await; // strategy_set=["dual_ma"], stock_set=["510300"]
    let svc = Arc::new(svc_inst);

    // 初始：无编排器 → 无评估
    assert!(svc.get_strategy_analysis(&id).unwrap().is_empty());

    // feed_targets 自动配置编排器并返回 poll 目标
    let targets = svc.feed_targets().unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].session_id, id);
    assert_eq!(targets[0].period, "M1");
    assert_eq!(targets[0].codes, vec!["510300".to_string()]);

    // 喂一根 bar → 评估出现（默认 fast/slow 单 bar → Hold(50)）
    let kline = Arc::new(MockKline::default());
    kline.set_latest("510300", dma_bar(100, 10.0));
    let feed = SimLiveFeed::new(svc.clone(), kline.clone(), Duration::from_millis(10));
    feed.tick().await.unwrap();
    let analysis = svc.get_strategy_analysis(&id).unwrap();
    assert_eq!(analysis.len(), 1);
    assert_eq!(analysis[0].code, "510300");
    assert_eq!(analysis[0].signal, "hold");
}

/// O1：已有 running 会话时再 start → Err（`AlreadyRunning`），防多 running。
#[tokio::test]
async fn start_session_when_already_running_returns_already_running_error() {
    let store = Arc::new(MockSimStore::default());
    let (svc, _first) = started(store.clone()).await;
    let err = svc
        .start_session(&StartSessionReq {
            name: "dup".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            strategies: Default::default(),
        })
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<application::simlive::AlreadyRunning>().is_some(),
        "重复 start 应返回 AlreadyRunning（防多 running）");
}

//// ADR §4 多策略：start_session 带 strategies → 编排器按每策略 参数/标的集 配置（固定输入断言）。
#[tokio::test]
async fn start_session_with_strategies_wires_orchestrator() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "s-multi".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            strategies: vec![
                StrategyConfigInput {
                    id: "dual_ma".into(),
                    params: serde_json::json!({"fast": 2.0, "slow": 3.0}),
                    stocks: vec!["510300".into()],
                    weight: 2.0,
                    stock_weights: HashMap::new(),
                },
                StrategyConfigInput {
                    id: "momentum".into(),
                    params: serde_json::json!({"lookback": 2.0}),
                    stocks: vec!["159577".into()],
                    weight: 1.0,
                    stock_weights: HashMap::new(),
                },
            ],
        })
        .await
        .unwrap();
    let sid = view.id.clone();

    // 会话级 strategy_set/stock_set 由策略派生（去重、保序）。
    let meta = svc.get_session(&sid).await.unwrap().unwrap().session;
    assert_eq!(meta.strategy_set, vec!["dual_ma".to_string(), "momentum".to_string()]);
    assert_eq!(meta.stock_set, vec!["510300".to_string(), "159577".to_string()]);

    // 编排器：dual_ma 只覆盖 510300；momentum 只覆盖 159577。
    svc.process_bar(&sid, "510300", dma_bar(100, 10.0)).await.unwrap();
    let a = svc.get_strategy_signal(&sid, "510300").unwrap().expect("有评估");
    assert_eq!(a.code, "510300");
    assert_eq!(a.per_strategy_scores.len(), 1, "仅 dual_ma 覆盖 510300");
    assert_eq!(a.per_strategy_scores[0].strategy_id, "dual_ma");

    svc.process_bar(&sid, "159577", dma_bar(100, 12.0)).await.unwrap();
    let b = svc.get_strategy_signal(&sid, "159577").unwrap().expect("有评估");
    assert_eq!(b.code, "159577");
    assert_eq!(b.per_strategy_scores.len(), 1, "仅 momentum 覆盖 159577");
    assert_eq!(b.per_strategy_scores[0].strategy_id, "momentum");

    // 未覆盖标的不评估。
    assert!(svc.get_strategy_signal(&sid, "999999").unwrap().is_none());
}

//// ADR §4：start_session 带非法 strategies（未知 id / weight≤0 / params 越界 / 未知标的 / 空标的集）→ Err(InvalidConfig)。
#[tokio::test]
async fn start_session_invalid_strategies_rejects() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone());
    let base = |strategies: Vec<StrategyConfigInput>| StartSessionReq {
        name: "bad".into(),
        cash_init: None,
        strategy_set: vec![],
        stock_set: vec![],
        period: "M1".into(),
        source: "manual".into(),
        strategies,
    };
    // 未知策略 id
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            id: "not_a_strategy".into(), params: serde_json::json!({}),
            stocks: vec!["510300".into()], weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "未知策略 id → InvalidConfig");
    // weight ≤ 0
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            id: "dual_ma".into(), params: serde_json::json!({}),
            stocks: vec!["510300".into()], weight: 0.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "weight≤0 → InvalidConfig");
    // params 越界（fast 超 max=200）
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            id: "dual_ma".into(), params: serde_json::json!({"fast": 99999.0, "slow": 3.0}),
            stocks: vec!["510300".into()], weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "params 越界 → InvalidConfig");
    // 未知标的（非 6 位数字）
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            id: "dual_ma".into(), params: serde_json::json!({}),
            stocks: vec!["abc".into()], weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "未知标的 → InvalidConfig");
    // 空标的集
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            id: "dual_ma".into(), params: serde_json::json!({}),
            stocks: vec![], weight: 1.0,
            stock_weights: HashMap::new(),
        }]))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "空标的集 → InvalidConfig");
    // stock_weights 键不在标的集
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            id: "dual_ma".into(), params: serde_json::json!({}),
            stocks: vec!["510300".into()], weight: 1.0,
            stock_weights: HashMap::from([("159577".to_string(), 2.0)]),
        }]))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "stock_weights 键不在标的集 → InvalidConfig");
    // stock_weights 值 ≤0
    let err = svc
        .start_session(&base(vec![StrategyConfigInput {
            id: "dual_ma".into(), params: serde_json::json!({}),
            stocks: vec!["510300".into()], weight: 1.0,
            stock_weights: HashMap::from([("510300".to_string(), 0.0)]),
        }]))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<InvalidConfig>().is_some(), "stock_weights 值≤0 → InvalidConfig");
}

// ADR §4：strategies[].stocks 注册表成员校验——格式合法（6 位数字 + 市场前缀）但**未注册**的 code（如 999999）应拒（修复偏差：原来只验格式、不查注册表）。
// 注入 mock 注册表只含 518880/510300；999999 未注册 → Err(InvalidConfig)「未注册」；未落库。
#[tokio::test]
async fn start_session_with_strategies_rejects_unregistered_code() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    kline.set_registered(&["518880", "510300"]); // 注册表={518880,510300}
    let svc = service(store.clone()).with_kline(kline.clone());
    let err = svc
        .start_session(&StartSessionReq {
            name: "reg-reject".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            strategies: vec![StrategyConfigInput {
                id: "dual_ma".into(),
                params: serde_json::json!({}),
                stocks: vec!["999999".into()], // 格式合法（6 位数字 + 前缀 9→沪）但未注册
                weight: 1.0,
                stock_weights: HashMap::new(),
            }],
        })
        .await
        .unwrap_err();
    let e = err.downcast_ref::<InvalidConfig>().expect("应为 InvalidConfig");
    assert!(e.0.contains("999999") && e.0.contains("未注册"), "应提示未注册：{}", e.0);
    // 校验即拒 → 未落库会话元数据
    assert!(store.created.lock().unwrap().is_empty(), "未注册 code → start 应拒且不落库");
}

// ADR §4 反向：已注册 code（518880，注册表内）→ 200，会话 stock_set 由策略派生。
#[tokio::test]
async fn start_session_with_strategies_accepts_registered_code() {
    let store = Arc::new(MockSimStore::default());
    let kline = Arc::new(MockKline::default());
    kline.set_registered(&["518880"]);
    let svc = service(store.clone()).with_kline(kline.clone());
    let view = svc
        .start_session(&StartSessionReq {
            name: "reg-ok".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            strategies: vec![StrategyConfigInput {
                id: "dual_ma".into(),
                params: serde_json::json!({}),
                stocks: vec!["518880".into()],
                weight: 1.0,
                stock_weights: HashMap::new(),
            }],
        })
        .await
        .unwrap();
    let meta = svc.get_session(&view.id).await.unwrap().unwrap().session;
    assert_eq!(meta.stock_set, vec!["518880".to_string()], "会话 stock_set 由策略派生");
}

// ADR §4 反向：未注入注册表端口（kline=None）→ 回退格式校验（兼容既有不注入构造），
// 格式合法的 510300 仍可 start 成功（注册表校验仅在注入端口时强制）。
#[tokio::test]
async fn start_session_with_strategies_without_registry_port_falls_back_to_format() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store.clone()); // 不注入 kline
    let view = svc
        .start_session(&StartSessionReq {
            name: "no-reg".into(),
            cash_init: None,
            strategy_set: vec![],
            stock_set: vec![],
            period: "M1".into(),
            source: "manual".into(),
            strategies: vec![StrategyConfigInput {
                id: "dual_ma".into(),
                params: serde_json::json!({}),
                stocks: vec!["510300".into()],
                weight: 1.0,
                stock_weights: HashMap::new(),
            }],
        })
        .await
        .unwrap();
    let meta = svc.get_session(&view.id).await.unwrap().unwrap().session;
    assert_eq!(meta.stock_set, vec!["510300".to_string()]);
}

#[tokio::test]
async fn set_trading_on_and_buy_threshold_places_aggregate_order() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = configured_buy_service(store.clone()).await;
    assert!(svc.set_trading(&id, true).unwrap(), "开关打开返回 true");
    assert!(svc.trading_enabled(&id).unwrap(), "查询开关态 true");

    let last_events = feed_all(&svc, &id, &golden_buy_bars()).await;

    // 达做多阈值 → 下单（source=aggregate_strategy）。
    let pos = svc.get_positions(&id).await.unwrap();
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
    assert_eq!(svc.get_positions(&id).await.unwrap().len(), 0, "无持仓");
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
    assert_eq!(svc.get_positions(&id).await.unwrap().len(), 0);
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
            strategies: Default::default(),
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

// ── 11-sim-live / L3b：web 面板服务侧（与 MCP 共享同一实例）──

/// mcp_enabled 默认为 true；set_mcp_enabled 切换后读回；MCP 与 web 共享同值（同一实例）。
#[tokio::test]
async fn mcp_enabled_toggle_reads_back_same_instance() {
    let store = Arc::new(MockSimStore::default());
    let svc = service(store);
    assert!(svc.mcp_enabled(), "默认开启");
    assert!(!svc.set_mcp_enabled(false), "关闭返回 false");
    assert!(!svc.mcp_enabled(), "读回 false");
    assert!(svc.set_mcp_enabled(true), "恢复 true");
    assert!(svc.mcp_enabled(), "读回 true");
}

/// current_session_id：运行中会话 → 该 running id；stop 后无 running → None（历史回看须显式传 id）。
#[tokio::test]
async fn current_session_resolves_latest_running_only() {
    let store = Arc::new(MockSimStore::default());
    let (svc, id) = started(store.clone()).await;
    assert_eq!(svc.current_session_id().as_deref(), Some(id.as_str()), "运行中会话=current");

    assert!(svc.stop_session(&id).await.unwrap());
    // 已无 running 会话 → current None（内存里已 ended；回看须显式 id）。
    assert!(svc.current_session_id().is_none(), "stop 后无 running → None");
}


