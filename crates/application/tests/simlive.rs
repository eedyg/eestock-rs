//! 应用层 SimLiveService 集成测试（**mock 端口**，确定性、无实时 DB）。
//! 全部输入为手工固定数据 + 固定时钟，无 RNG / 无时间依赖 / 无实时行情，任意次运行一致。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use domain::ports::{
    Clock, NewSimSession, NewSimTrade, SimPositionRow, SimSessionResult, SimSessionStatus,
    SimSessionStore, SimSessionView,
};

use application::simlive::{PlaceOrderReq, SimLiveService, StartSessionReq};

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
        Ok(true)
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
