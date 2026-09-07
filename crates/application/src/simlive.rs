//! 模拟实盘服务（application 层，11-sim-live / L1；手写，非 tangle）。
//! 依赖注入 domain 端口 `SimSessionStore` + `Clock`，并经 `simlive` crate（纯逻辑）；
//! 不依赖 web/storage/sqlx（DI 由 app bin 装配）。
//!
//! 职责：会话生命周期（start/stop）、账户/持仓/订单/盈亏查询、`place_order`（市价/限价→FillEngine）、
//! `cancel_order`（仅取消 pending 限价）、幂等（intent_id 去重）。运行态在内存（SessionManager），
//! 持久化经 `SimSessionStore`（会话元数据 / 成交明细 / 持仓快照 / 结束结果）。

use anyhow::anyhow;
use chrono::DateTime;
use std::collections::{BTreeMap, HashMap as Map, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use backtest::FeeModel;
use domain::ports::{
    Clock, NewSimSession, NewSimTrade, SimPositionRow, SimSessionResult, SimSessionStore,
    SimSessionStatus, SimSessionView,
};
use backtest::Bar;
use serde::{Deserialize, Serialize};
use simlive::{
    Fill, FillEngine, Order, OrderStatus, RealtimeStrategyOrchestrator, SessionManager, Side,
    SignalEvent, SimOrder, SimPosition, SimSession, SimTrade, StockEvaluation, StrategyConfig,
};

static NEXT_ORDER_ID: AtomicU64 = AtomicU64::new(0);

/// 默认初始资金（ADR 11-sim-live §5：1_000_000）。
pub const DEFAULT_CASH_INIT: f64 = 1_000_000.0;
/// 聚合策略默认开仓数量（每股；L2 简化来源 aggregate_strategy）。
pub const DEFAULT_AGGREGATE_QTY: f64 = 100.0;

/// 启动会话请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartSessionReq {
    pub name: String,
    #[serde(default)]
    pub cash_init: Option<f64>,
    #[serde(default)]
    pub strategy_set: Vec<String>,
    #[serde(default)]
    pub stock_set: Vec<String>,
    pub period: String,
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "manual".into()
}

/// 下单请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceOrderReq {
    pub code: String,
    /// "buy" | "sell"。
    pub side: String,
    pub qty: f64,
    #[serde(default)]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub intent_id: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
}

/// 账户读模型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountView {
    pub session_id: String,
    pub cash: f64,
    pub equity: f64,
    pub market_value: f64,
    pub realized_pnl: f64,
    pub unrealized_pnl: f64,
    pub total_fee: f64,
}

/// 持仓读模型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PositionView {
    pub code: String,
    pub qty: f64,
    pub avg_cost: f64,
    pub latest: f64,
    pub market_value: f64,
    pub unrealized_pnl: f64,
}

/// 盈亏读模型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PnlView {
    pub realized_pnl: f64,
    pub unrealized_pnl: f64,
    pub total_fee: f64,
    pub net_profit: f64,
}

/// 订单读模型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderView {
    pub id: String,
    pub code: String,
    pub side: String,
    pub qty: f64,
    pub limit_price: Option<f64>,
    pub status: String,
    pub filled_price: Option<f64>,
    pub filled_qty: f64,
    pub fee: f64,
    pub ts: i64,
}

/// 会话内运行态。
struct LiveSession {
    manager: SessionManager,
    fill_engine: FillEngine,
    orders: Vec<SimOrder>,
    intent_seen: HashSet<String>,
    intent_fills: Map<String, Fill>,
    /// 实时策略编排器（L2；每新 bar 评估/评分/聚合）。
    orchestrator: Option<RealtimeStrategyOrchestrator>,
    /// 统一交易开关（L2；enabled 且聚合达阈值才下模拟单；disabled 只评估/评分）。
    trading_enabled: bool,
}

/// 模拟实盘服务。
pub struct SimLiveService {
    store: Arc<dyn SimSessionStore>,
    clock: Arc<dyn Clock>,
    fee: FeeModel,
    default_cash: f64,
    /// 聚合策略开仓数量（每股；L2 简化，来源标识 aggregate_strategy）。
    aggregate_qty: f64,
    sessions: Mutex<Map<String, LiveSession>>,
}

impl SimLiveService {
    pub fn new(store: Arc<dyn SimSessionStore>, clock: Arc<dyn Clock>, fee: FeeModel) -> Self {
        Self {
            store,
            clock,
            fee,
            default_cash: DEFAULT_CASH_INIT,
            aggregate_qty: DEFAULT_AGGREGATE_QTY,
            sessions: Mutex::new(Map::new()),
        }
    }

    /// 便捷构造：默认 FeeModel（佣金/印花税/滑点与 backtest 同步口径）。
    pub fn with_default_fee(store: Arc<dyn SimSessionStore>, clock: Arc<dyn Clock>) -> Self {
        Self::new(store, clock, FeeModel::default())
    }

    /// 开始会话：重置账户为 cash_init，落库 running 元数据，缓存运行态。
    pub async fn start_session(&self, req: &StartSessionReq) -> anyhow::Result<SimSessionView> {
        let now = self.clock.now();
        let mut manager = SessionManager::new();
        let session = manager.start_session(
            &req.name,
            req.cash_init.unwrap_or(self.default_cash),
            req.strategy_set.clone(),
            req.stock_set.clone(),
            &req.period,
            now.timestamp(),
            &req.source,
        );
        self.store
            .create_session(&NewSimSession {
                id: session.id.clone(),
                name: session.name.clone(),
                cash_init: session.cash_init,
                strategy_set: session.strategy_set.clone(),
                stock_set: session.stock_set.clone(),
                period: session.period.clone(),
                start_ts: now,
                source: session.source.clone(),
            })
            .await?;
        self.sessions.lock().expect("sessions poisoned").insert(
            session.id.clone(),
            LiveSession {
                manager,
                fill_engine: FillEngine::new(self.fee),
                orders: Vec::new(),
                intent_seen: HashSet::new(),
                intent_fills: Map::new(),
                orchestrator: None,
                trading_enabled: false,
            },
        );
        Ok(to_session_view(&session))
    }

    /// 停止会话：置 ended + 落库结束结果；返回是否转换（未知/已 ended → false）。
    pub async fn stop_session(&self, session_id: &str) -> anyhow::Result<bool> {
        let now = self.clock.now();
        let (ended, result) = {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            let Some(live) = sessions.get_mut(session_id) else {
                return Ok(false);
            };
            let Some(session) = live.manager.stop_session(now.timestamp()) else {
                return Ok(false); // 非 running（已 ended / 未知）
            };
            let state = live.manager.get_state().expect("session 存在");
            let result = SimSessionResult {
                net_value: serde_json::to_value(&state.net_value_series).expect("net_value 可序列化"),
                trades: serde_json::to_value(&state.trades).expect("trades 可序列化"),
                metrics: serde_json::json!({
                    "net_profit": state.realized_pnl + state.unrealized_pnl,
                    "total_fee": state.total_fee,
                    "cash_init": session.cash_init,
                }),
            };
            (session.clone(), result)
        };
        let _ = ended;
        let updated = self.store.mark_end(session_id, now, &result).await?;
        Ok(updated)
    }

    /// 下单：市价按最新价即时成交；限价触及成交；未成交（限价未触及）记 pending 单。
    /// 幂等：同 `intent_id` 重复调用返回首次成交结果（不重复执行 / 不重复记单）。
    /// `latest` 为模拟行情最新价（L1 由调用方提供，而非实时数据链）。
    pub async fn place_order(
        &self,
        session_id: &str,
        req: &PlaceOrderReq,
        latest: f64,
    ) -> anyhow::Result<Option<Fill>> {
        let side = Side::parse(&req.side).ok_or_else(|| anyhow!("未知方向：{}", req.side))?;

        // 幂等已见 intent：返回首次成交（不重复执行）。
        if let Some(intent) = &req.intent_id {
            let sessions = self.sessions.lock().expect("sessions poisoned");
            if let Some(live) = sessions.get(session_id) {
                if live.intent_seen.contains(intent) {
                    return Ok(live.intent_fills.get(intent).cloned());
                }
            }
        }

        // 锁内执行（同步、快速）；账务/状态变更完成后释放锁再 await 持久化。
        let (fill, trade, positions, order_id) = {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            let Some(live) = sessions.get_mut(session_id) else {
                return Err(anyhow!("会话不存在：{session_id}"));
            };
            let ts = self.clock.now().timestamp();
            let order = Order {
                code: req.code.clone(),
                side,
                qty: req.qty,
                limit_price: req.limit_price,
            };
            match live.fill_engine.try_fill(&order, latest) {
                Some(f) => {
                    live.manager.account.apply_fill(&f)?;
                    let trade = SimTrade {
                        code: f.code.clone(),
                        side: f.side,
                        qty: f.qty,
                        price: f.price,
                        ts,
                        fee: f.fee,
                        source: req.source.clone(),
                    };
                    live.manager.record_trade(trade.clone());
                    let order_id = new_order_id(ts);
                    live.orders.push(SimOrder {
                        id: order_id.clone(),
                        session_id: session_id.into(),
                        intent_id: req.intent_id.clone(),
                        code: f.code.clone(),
                        side: f.side,
                        qty: f.qty,
                        limit_price: req.limit_price,
                        status: OrderStatus::Filled,
                        filled_price: Some(f.price),
                        filled_qty: f.qty,
                        fee: f.fee,
                        ts,
                    });
                    if let Some(intent) = &req.intent_id {
                        live.intent_seen.insert(intent.clone());
                        live.intent_fills.insert(intent.clone(), f.clone());
                    }
                    let snapshot = live.manager.positions();
                    (Some(f.clone()), Some(trade), snapshot, order_id)
                }
                None => {
                    // 限价未触及 → pending 单，不成交、不落成交明细。
                    let order_id = new_order_id(ts);
                    live.orders.push(SimOrder {
                        id: order_id.clone(),
                        session_id: session_id.into(),
                        intent_id: req.intent_id.clone(),
                        code: req.code.clone(),
                        side,
                        qty: req.qty,
                        limit_price: req.limit_price,
                        status: OrderStatus::Pending,
                        filled_price: None,
                        filled_qty: 0.0,
                        fee: 0.0,
                        ts,
                    });
                    (None, None, Vec::new(), order_id)
                }
            }
        };

        // 落库（仅成交才写成交明细/持仓；pending 不落）。
        if let Some(t) = trade {
            self.store
                .append_trade(&NewSimTrade {
                    session_id: session_id.into(),
                    code: t.code.clone(),
                    side: t.side.as_str().into(),
                    qty: t.qty,
                    price: t.price,
                    ts: DateTime::from_timestamp(t.ts, 0)
                        .unwrap_or_else(|| self.clock.now()),
                    fee: t.fee,
                    source: t.source,
                })
                .await?;
            let rows: Vec<SimPositionRow> = positions
                .into_iter()
                .map(|p| SimPositionRow {
                    session_id: session_id.into(),
                    code: p.code,
                    qty: p.qty,
                    avg_cost: p.avg_cost,
                })
                .collect();
            self.store.update_positions(session_id, &rows).await?;
        }
        let _ = order_id;
        Ok(fill)
    }

    /// 撤单：仅取消 pending 单；已成交/未知 → false。
    pub async fn cancel_order(&self, session_id: &str, order_id: &str) -> anyhow::Result<bool> {
        let mut sessions = self.sessions.lock().expect("sessions poisoned");
        let Some(live) = sessions.get_mut(session_id) else {
            return Ok(false);
        };
        for o in live.orders.iter_mut() {
            if o.id == order_id {
                if o.status == OrderStatus::Pending {
                    o.status = OrderStatus::Cancelled;
                    return Ok(true);
                }
                return Ok(false);
            }
        }
        Ok(false)
    }

    /// 账户查询。
    pub fn get_account(&self, session_id: &str) -> anyhow::Result<AccountView> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        let st = live.manager.get_state().expect("会话存在");
        Ok(AccountView {
            session_id: session_id.into(),
            cash: st.cash,
            equity: st.equity,
            market_value: st.market_value,
            realized_pnl: st.realized_pnl,
            unrealized_pnl: st.unrealized_pnl,
            total_fee: st.total_fee,
        })
    }

    /// 持仓查询。
    pub fn get_positions(&self, session_id: &str) -> anyhow::Result<Vec<PositionView>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        Ok(live
            .manager
            .get_state()
            .expect("会话存在")
            .positions
            .into_iter()
            .map(|p| PositionView {
                code: p.code,
                qty: p.qty,
                avg_cost: p.avg_cost,
                latest: p.latest,
                market_value: p.market_value,
                unrealized_pnl: p.unrealized_pnl,
            })
            .collect())
    }

    /// 盈亏查询。
    pub fn get_pnl(&self, session_id: &str) -> anyhow::Result<PnlView> {
        let st = self.get_account(session_id)?;
        Ok(PnlView {
            realized_pnl: st.realized_pnl,
            unrealized_pnl: st.unrealized_pnl,
            total_fee: st.total_fee,
            net_profit: st.realized_pnl + st.unrealized_pnl,
        })
    }

    /// 订单查询（该会话全部订单，placement 顺序）。
    pub fn get_orders(&self, session_id: &str) -> anyhow::Result<Vec<OrderView>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        Ok(live
            .orders
            .iter()
            .map(|o| OrderView {
                id: o.id.clone(),
                code: o.code.clone(),
                side: o.side.as_str().into(),
                qty: o.qty,
                limit_price: o.limit_price,
                status: o.status.as_str().into(),
                filled_price: o.filled_price,
                filled_qty: o.filled_qty,
                fee: o.fee,
                ts: o.ts,
            })
            .collect())
    }

    /// 打市值刷新净值并追加净值点（会话内 mark_to_market）。
    pub fn mark_to_market(&self, session_id: &str, latest: &BTreeMap<String, f64>, ts: i64) -> anyhow::Result<f64> {
        let mut sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get_mut(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        Ok(live.manager.tick(ts, latest))
    }

    // ── 11-sim-live / L2：多策略实时评分 + 聚合 + 统一交易开关 + 事件流 ──

    /// 配置实时策略编排器（3 策略实例 × 其标的集/weight；复用 backtest 内建策略）。
    pub fn configure_strategies(&self, session_id: &str, configs: Vec<StrategyConfig>) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get_mut(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        live.orchestrator = Some(RealtimeStrategyOrchestrator::with_default_thresholds(configs));
        Ok(())
    }

    /// 统一交易开关：`enabled` 且某 stock 聚合评分达做多/卖阈值 → 下模拟单；disabled → 只评估/评分不入单。
    /// 仅影响聚合策略驱动的下单（source=aggregate_strategy），不影响手动 `place_order`。返回新开关态。
    pub fn set_trading(&self, session_id: &str, enabled: bool) -> anyhow::Result<bool> {
        let mut sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get_mut(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        live.trading_enabled = enabled;
        Ok(enabled)
    }

    /// 当前统一交易开关态。
    pub fn trading_enabled(&self, session_id: &str) -> anyhow::Result<bool> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        Ok(live.trading_enabled)
    }

    /// 喂入一根新 bar（实时行情），每策略×标的评估+聚合评分；若 `trading_enabled` 且聚合达阈值 → 经 FillEngine
    /// 下模拟单（同一会话/账户，source=aggregate_strategy），并把每信号事件 append 到会话事件流。
    /// 返回本次产出的信号事件（`ordered` 标记该 stock 是否因此下单）。
    pub async fn process_bar(&self, session_id: &str, code: &str, bar: Bar) -> anyhow::Result<Vec<SignalEvent>> {
        let ts = self.clock.now().timestamp();

        // 锁内：喂 bar → 评估 → 决定下单 → 记录信号事件。
        let (events, persist) = {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            let Some(live) = sessions.get_mut(session_id) else {
                return Err(anyhow!("会话不存在：{session_id}"));
            };
            let Some(orch) = live.orchestrator.as_mut() else {
                return Err(anyhow!("会话未配置策略（先 configure_strategies）：{session_id}"));
            };
            // 未覆盖标的 → 不评估（仍记录行情）。
            let Some(eval) = orch.feed_bar(code, bar) else {
                return Ok(Vec::new());
            };

            let mut did_order = false;
            let mut persist: Option<(SimTrade, Vec<SimPosition>)> = None;
            if live.trading_enabled {
                let held = live
                    .manager
                    .account
                    .positions
                    .get(&eval.code)
                    .map(|p| p.qty)
                    .unwrap_or(0.0);
                // 建仓：已有持仓不重复叠单；平仓：清全部持仓（source=aggregate_strategy）。
                let order = match eval.signal.as_str() {
                    "buy" if held <= 0.0 => Some(Order {
                        code: eval.code.clone(),
                        side: Side::Buy,
                        qty: self.aggregate_qty,
                        limit_price: None,
                    }),
                    "sell" if held > 0.0 => Some(Order {
                        code: eval.code.clone(),
                        side: Side::Sell,
                        qty: held,
                        limit_price: None,
                    }),
                    _ => None,
                };
                if let Some(order) = order {
                    if let Some(fill) = live.fill_engine.try_fill(&order, eval.latest_price) {
                        live.manager.account.apply_fill(&fill)?;
                        let trade = SimTrade {
                            code: fill.code.clone(),
                            side: fill.side,
                            qty: fill.qty,
                            price: fill.price,
                            ts,
                            fee: fill.fee,
                            source: "aggregate_strategy".into(),
                        };
                        live.manager.record_trade(trade.clone());
                        let order_id = new_order_id(ts);
                        live.orders.push(SimOrder {
                            id: order_id,
                            session_id: session_id.into(),
                            intent_id: None,
                            code: fill.code.clone(),
                            side: fill.side,
                            qty: fill.qty,
                            limit_price: None,
                            status: OrderStatus::Filled,
                            filled_price: Some(fill.price),
                            filled_qty: fill.qty,
                            fee: fill.fee,
                            ts,
                        });
                        let positions = live.manager.positions();
                        did_order = true;
                        persist = Some((trade, positions));
                    }
                }
            }

            let events: Vec<SignalEvent> = eval
                .per_strategy_scores
                .iter()
                .map(|s| SignalEvent {
                    ts: eval.ts,
                    code: eval.code.clone(),
                    strategy_id: s.strategy_id.clone(),
                    score: s.score,
                    signal: s.signal.clone(),
                    aggregate_score: eval.aggregate_score,
                    ordered: did_order,
                })
                .collect();
            for e in &events {
                live.manager.record_signal_event(e.clone());
            }
            (events, persist)
        };

        // 锁外持久化（仅成交才写成交明细/持仓）。
        if let Some((trade, positions)) = persist {
            self.store
                .append_trade(&NewSimTrade {
                    session_id: session_id.into(),
                    code: trade.code.clone(),
                    side: trade.side.as_str().into(),
                    qty: trade.qty,
                    price: trade.price,
                    ts: DateTime::from_timestamp(trade.ts, 0).unwrap_or_else(|| self.clock.now()),
                    fee: trade.fee,
                    source: trade.source,
                })
                .await?;
            let rows: Vec<SimPositionRow> = positions
                .into_iter()
                .map(|p| SimPositionRow {
                    session_id: session_id.into(),
                    code: p.code,
                    qty: p.qty,
                    avg_cost: p.avg_cost,
                })
                .collect();
            self.store.update_positions(session_id, &rows).await?;
        }
        Ok(events)
    }

    /// 查询某标的最近一次策略评估（聚合分 + 各策略独立分）；未评估/未知 → Ok(None)。
    pub fn get_strategy_signal(&self, session_id: &str, code: &str) -> anyhow::Result<Option<StockEvaluation>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        Ok(live
            .orchestrator
            .as_ref()
            .and_then(|o| o.latest_evaluation(code).cloned()))
    }

    /// 全部标的最近评估概览（多 stock 评估；无编排器 → 空）。
    pub fn get_strategy_analysis(&self, session_id: &str) -> anyhow::Result<Vec<StockEvaluation>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        Ok(live
            .orchestrator
            .as_ref()
            .map(|o| o.all_evaluations().into_iter().cloned().collect())
            .unwrap_or_default())
    }

    /// 内置策略清单 + 参数 schema（供 MCP sim_list_strategies；复用 backtest 目录）。
    pub fn list_builtin_strategies(&self) -> anyhow::Result<Vec<backtest::StrategyResult>> {
        Ok(backtest::builtin_strategy_catalog())
    }
}

/// 会话 id 生成（时间戳 + 单调计数器；与 simlive SessionManager 同模式命名，无随机）。
fn new_order_id(ts: i64) -> String {
    let n = NEXT_ORDER_ID.fetch_add(1, Ordering::Relaxed);
    format!("o_{}_{}", ts, n)
}

/// simlive::SimSession → domain::SimSessionView。
fn to_session_view(s: &SimSession) -> SimSessionView {
    SimSessionView {
        id: s.id.clone(),
        name: s.name.clone(),
        cash_init: s.cash_init,
        strategy_set: s.strategy_set.clone(),
        stock_set: s.stock_set.clone(),
        period: s.period.clone(),
        start_ts: DateTime::from_timestamp(s.start_ts, 0).unwrap_or_default(),
        end_ts: s.end_ts.map(|t| DateTime::from_timestamp(t, 0).unwrap_or_default()),
        status: match s.status {
            simlive::SessionStatus::Running => SimSessionStatus::Running,
            simlive::SessionStatus::Ended => SimSessionStatus::Ended,
        },
        source: s.source.clone(),
    }
}
