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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use backtest::{Bar, FeeModel, Period, TradeDetail, compute_drawdown, compute_metrics};
use domain::ports::{
    Clock, KlineRead, NewSimSession, NewSimTrade, SimPositionRow, SimSessionResult,
    SimSessionStore, SimSessionStatus, SimSessionView,
};
use serde::{Deserialize, Serialize};

use crate::service::BacktestService;
use crate::types::{SubmitOutcome, SubmitReq};
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

/// O1：已有 running 会话时再 start → 约束（防多 running）。web 映射 409 / MCP 映射 isError。
#[derive(Debug, Clone, PartialEq)]
pub struct AlreadyRunning(pub String);

impl std::fmt::Display for AlreadyRunning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "已有运行中会话：{}", self.0)
    }
}

impl std::error::Error for AlreadyRunning {}

/// F2：实时 feed 的 poll 目标（running 会话 × 其策略标的集）。
#[derive(Debug, Clone, PartialEq)]
pub struct FeedTarget {
    pub session_id: String,
    pub period: String,
    /// 需轮询的标的集（= 编排器覆盖标的全集；自动配置时 = 会话 stock_set）。
    pub codes: Vec<String>,
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
    /// 订单来源：`manual` | `aggregate_strategy`（自动单）| `strategy`（预留）。
    /// L4 补（F1）：透传 `SimOrder.source`，供面板「来源」列（`/api/sim-live/orders`）。
    pub source: String,
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

/// 会话列表条目（L3：sim_list_sessions；含结束结果指标摘要）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionListEntry {
    pub session: SimSessionView,
    /// 结束结果指标摘要（未结束 → None；已结束 → metrics_json）。
    pub metrics: Option<serde_json::Value>,
}

/// 会话详情（L3：sim_get_session；元数据 + 结束结果）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionDetail {
    pub session: SimSessionView,
    /// 结束结果（simsession_result 三 jsonb 列；未结束 → None）。
    pub result: Option<SimSessionResult>,
}

/// 回测对比视图（L3：sim_run_backtest_compare）。
/// 模拟实盘用会话自身结果；回测用触发的新 run（异步，调用方轮询 backtest get_run 完成）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BacktestCompareView {
    pub session_id: String,
    /// 会话自身的结束结果（净值/交易/指标）。
    pub session_result: Option<SimSessionResult>,
    /// 为该会话（同周期+同策略集+同标的集）触发的回测 run id 列表（“回测一下”）。
    pub run_ids: Vec<i64>,
}

/// 模拟实盘服务。
pub struct SimLiveService {
    store: Arc<dyn SimSessionStore>,
    clock: Arc<dyn Clock>,
    fee: FeeModel,
    default_cash: f64,
    /// 聚合策略开仓数量（每股；L2 简化，来源标识 aggregate_strategy）。
    aggregate_qty: f64,
    /// 回测服务（L3「回测一下」；经 BacktestService.submit 触发既有回测 run；None = 未注入）。
    backtest: Option<Arc<BacktestService>>,
    /// 本系统行情源读端口（KlineRead；None = 未注入）。
    /// 持仓读模型（PositionView.latest/market_value）经此解析每标的最近一根 close，
    /// 与评分表（相同端口取 latest_bar）同价；缺行情/未注入才回退 0.000。
    kline: Option<Arc<dyn KlineRead>>,
    sessions: Mutex<Map<String, LiveSession>>,
    /// MCP sim_* 服务快捷开关（L3b web：默认开；关闭后 MCP sim_* 工具返回 isError，web 反映状态）。
    /// 与 web 共享同一服务实例（ADR 11-sim-live §7 双通道一致性），故放服务内而非各端各自维护。
    mcp_enabled: AtomicBool,
}

impl SimLiveService {
    pub fn new(store: Arc<dyn SimSessionStore>, clock: Arc<dyn Clock>, fee: FeeModel) -> Self {
        Self {
            store,
            clock,
            fee,
            default_cash: DEFAULT_CASH_INIT,
            aggregate_qty: DEFAULT_AGGREGATE_QTY,
            backtest: None,
            kline: None,
            sessions: Mutex::new(Map::new()),
            mcp_enabled: AtomicBool::new(true),
        }
    }

    /// 注入回测服务（L3「回测一下」；未注入时 sim_run_backtest_compare 返回错误）。
    pub fn with_backtest(mut self, backtest: Arc<BacktestService>) -> Self {
        self.backtest = Some(backtest);
        self
    }

    /// 注入本系统行情源读端口（KlineRead；持仓 latest/market_value 从行情源解析）。
    pub fn with_kline(mut self, kline: Arc<dyn KlineRead>) -> Self {
        self.kline = Some(kline);
        self
    }

    /// 便捷构造：默认 FeeModel（佣金/印花税/滑点与 backtest 同步口径）。
    pub fn with_default_fee(store: Arc<dyn SimSessionStore>, clock: Arc<dyn Clock>) -> Self {
        Self::new(store, clock, FeeModel::default())
    }

    /// 开始会话：重置账户为 cash_init，落库 running 元数据，缓存运行态。
    /// O1：已有 running 会话时拒绝再 start（返回 [`AlreadyRunning`]，防多 running）；web 映射 409。
    pub async fn start_session(&self, req: &StartSessionReq) -> anyhow::Result<SimSessionView> {
        if let Some(existing) = self.current_session_id() {
            return Err(AlreadyRunning(existing).into());
        }
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
            // L3：结束结算用 backtest 指标口径（8 项；结构=backtest_run：
            // net_value={series,drawdown}, trades=TradeDetail 已平仓配对, metrics=BacktestMetrics）。
            let bt_period = bt_period_from_str(&session.period);
            let detail = sim_trades_to_trade_details(&state.trades, bt_period);
            let metrics = compute_metrics(&state.net_value_series, &detail, session.cash_init, bt_period);
            let drawdown = compute_drawdown(&state.net_value_series);
            let result = SimSessionResult {
                net_value: serde_json::json!({ "series": state.net_value_series, "drawdown": drawdown }),
                trades: serde_json::to_value(&detail).expect("trades 可序列化"),
                metrics: serde_json::to_value(metrics).expect("metrics 可序列化"),
            };
            (session.clone(), result)
        };
        let _ = ended;
        let updated = self.store.mark_end(session_id, now, &result).await?;
        Ok(updated)
    }

    // ── 11-sim-live / L3b：web 面板（与 MCP 共享同一服务实例）──

    /// MCP sim_* 服务快捷开关当前态（默认开）。
    pub fn mcp_enabled(&self) -> bool {
        self.mcp_enabled.load(Ordering::Relaxed)
    }

    /// 切换 MCP sim_* 服务开关（返回新态）。关闭后 MCP sim_* 工具应返回 isError。
    pub fn set_mcp_enabled(&self, enabled: bool) -> bool {
        self.mcp_enabled.store(enabled, Ordering::Relaxed);
        enabled
    }

    /// 当前会话解析：返回**最新 running** 会话 id；无 running → None（web 面板展示 idle 态）。
    /// 已结束会话的回看需显式传 `session_id`（存库仍在），此处只服务「当前会话」区域。
    pub fn current_session_id(&self) -> Option<String> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let mut best: Option<(&String, i64)> = None;
        for (id, live) in sessions.iter() {
            if let Some(session) = live.manager.current_session() {
                if session.status == simlive::SessionStatus::Running {
                    let ts = session.start_ts;
                    if best.map(|(_, t)| ts > t).unwrap_or(true) {
                        best = Some((id, ts));
                    }
                }
            }
        }
        best.map(|(id, _)| id.clone())
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
                        source: req.source.clone(),
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
                        source: req.source.clone(),
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
    /// 持仓 latest/market_value 从本系统行情源（KlineRead::latest_bar 每标的最近一根 close）解析，
    /// 与评分表同源同价；缺行情（未上市/停牌/未注入端口）才回退 0.000。
    pub async fn get_positions(&self, session_id: &str) -> anyhow::Result<Vec<PositionView>> {
        // 锁内取持仓快照 + 会话周期（不跨 await 持锁）。
        let (positions, period) = {
            let sessions = self.sessions.lock().expect("sessions poisoned");
            let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
            let st = live.manager.get_state().expect("会话存在");
            (st.positions, dom_period_from_str(&st.session.period).unwrap_or(domain::types::Period::M1))
        };
        let mut out = Vec::with_capacity(positions.len());
        for p in &positions {
            let latest = self.resolve_latest_price(period, &p.code).await;
            out.push(PositionView {
                code: p.code.clone(),
                qty: p.qty,
                avg_cost: p.avg_cost,
                latest,
                market_value: p.qty * latest,
                unrealized_pnl: p.qty * (latest - p.avg_cost),
            });
        }
        Ok(out)
    }

    /// 从行情源解析单标的最近一根 close；未注入端口 / 无 bar / 查询失败 → 0.000（缺行情兜底）。
    async fn resolve_latest_price(&self, period: domain::types::Period, code: &str) -> f64 {
        let Some(kline) = &self.kline else { return 0.0 };
        match kline.latest_bar(period, code).await {
            Ok(Some(bar)) => bar.close,
            _ => 0.0,
        }
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
                source: o.source.clone(),
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

    /// F2：实时 feed 的 poll 目标枚举。对每个 running 会话：
    /// - 若未配置编排器，用会话 `strategy_set × stock_set` 自动配置（默认参数、weight=1.0）；
    /// - 返回其标的集（编排器覆盖标的；自动配置时 = stock_set）作为轮询目标。
    /// 已配置（MCP/web 自定义参数）的会话不被覆盖，仅按现覆盖标的轮询。
    pub fn feed_targets(&self) -> anyhow::Result<Vec<FeedTarget>> {
        let mut sessions = self.sessions.lock().expect("sessions poisoned");
        let mut targets = Vec::new();
        for (id, live) in sessions.iter_mut() {
            let meta = {
                let Some(session) = live.manager.current_session() else { continue };
                if session.status != simlive::SessionStatus::Running {
                    continue;
                }
                (session.period.clone(), session.strategy_set.clone(), session.stock_set.clone())
            };
            if live.orchestrator.is_none() {
                let configs: Vec<StrategyConfig> = meta.1
                    .iter()
                    .map(|sid| StrategyConfig {
                        id: sid.clone(),
                        params: Default::default(), // 缺省参数（各策略 schema 默认值）
                        stocks: meta.2.clone(),
                        weight: 1.0,
                    })
                    .collect();
                if configs.is_empty() {
                    continue;
                }
                live.orchestrator = Some(RealtimeStrategyOrchestrator::with_default_thresholds(configs));
            }
            let codes = live.orchestrator.as_ref().expect("已配置").stocks();
            targets.push(FeedTarget { session_id: id.clone(), period: meta.0, codes });
        }
        Ok(targets)
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
                            source: "aggregate_strategy".into(),
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

    // ── 11-sim-live / L3：会话记录回看 + 回测对比 ──

    /// 历史会话列表（L3：sim_list_sessions；start_ts DESC）。已结束会话附指标摘要。
    pub async fn list_sessions(&self) -> anyhow::Result<Vec<SessionListEntry>> {
        let views = self.store.list_sessions().await?;
        let mut out = Vec::with_capacity(views.len());
        for v in views {
            let metrics = if v.status == SimSessionStatus::Ended {
                self.store.get_result(&v.id).await?.map(|r| r.metrics)
            } else {
                None
            };
            out.push(SessionListEntry { session: v, metrics });
        }
        Ok(out)
    }

    /// 会话详情（L3：sim_get_session；元数据 + 结束结果）。未知 id → Ok(None)。
    pub async fn get_session(&self, session_id: &str) -> anyhow::Result<Option<SessionDetail>> {
        let Some(view) = self.store.get_session(session_id).await? else {
            return Ok(None);
        };
        let result = self.store.get_result(session_id).await?;
        Ok(Some(SessionDetail { session: view, result }))
    }

    /// 「回测一下」（L3：sim_run_backtest_compare）：按该会话 (period, strategy_set, stock_set, date_range)
    /// 触发一次回测 run —— 复用既有 backtest 服务/引擎（```BacktestService::submit``` → ```BacktestRunStore```）。
    /// 因 backtest 引擎为单 code/单策略 run，此处对会话的 stock_set × strategy_set 笛卡尔积逐个触发；
    /// 单 stock + 单策略会话即“一次 run”。返回会话自身结果 + 新回测 run id 列表（异步：调用方轮询 get_run）。
    pub async fn run_backtest_compare(&self, session_id: &str) -> anyhow::Result<BacktestCompareView> {
        let Some(backtest) = self.backtest.clone() else {
            return Err(anyhow!("回测服务未注入（SimLiveService.backtest=None；app 装配时 with_backtest）"));
        };
        let Some(view) = self.store.get_session(session_id).await? else {
            return Err(anyhow!("会话不存在：{session_id}"));
        };
        let session_result = self.store.get_result(session_id).await?;
        let from = view.start_ts;
        let to = view.end_ts.unwrap_or_else(|| self.clock.now());
        if to <= from {
            return Err(anyhow!("回测区间无效（start≥end），无法触发对比"));
        }
        // 费用口径=会话 FeeModel（复用同源，模拟/回测一致）。
        let fee = serde_json::json!({
            "rate_pct": self.fee.commission_rate_pct,
            "min_fee": self.fee.min_commission,
            "slippage_bp": self.fee.slippage_bp,
        });
        let mut run_ids = Vec::new();
        for stock in &view.stock_set {
            for strategy in &view.strategy_set {
                let req = SubmitReq {
                    code: stock.clone(),
                    period: view.period.clone(),
                    from,
                    to,
                    strategy_id: strategy.clone(),
                    params: serde_json::json!({}),
                    params_grid: None,
                    fee: fee.clone(),
                    initial_capital: Some(view.cash_init),
                };
                match backtest.submit(req).await? {
                    SubmitOutcome::Run(id) => run_ids.push(id),
                    // 无 params_grid → 恒为单 run，不会出现 Group。
                    SubmitOutcome::Group(_) => {}
                }
            }
        }
        Ok(BacktestCompareView { session_id: session_id.into(), session_result, run_ids })
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

/// 会话周期字符串 → domain::types::Period（行情源查询用；与 backtest::Period 独立枚举）。
/// 未知周期回退 M1（防御性）。
fn dom_period_from_str(s: &str) -> Option<domain::types::Period> {
    match s {
        "M1" => Some(domain::types::Period::M1),
        "M5" => Some(domain::types::Period::M5),
        "M15" => Some(domain::types::Period::M15),
        "H1" => Some(domain::types::Period::H1),
        "D1" => Some(domain::types::Period::D1),
        "W1" => Some(domain::types::Period::W1),
        "MO1" => Some(domain::types::Period::MO1),
        _ => None,
    }
}

/// 会话周期字符串 → backtest::Period（与 backtest 支持周期一致；未知周期回退 M1，防御性）。
fn bt_period_from_str(s: &str) -> Period {
    match s {
        "M1" => Period::M1,
        "M5" => Period::M5,
        "M15" => Period::M15,
        "D1" => Period::D1,
        _ => Period::M1,
    }
}

/// 周期 → 每根 bar 秒数（用于把成交时间差折算成 hold_bars，与 backtest 口径同周期粒度）。
fn bt_bar_seconds(period: Period) -> i64 {
    match period {
        Period::M1 => 60,
        Period::M5 => 300,
        Period::M15 => 900,
        Period::D1 => 86_400,
    }
}

/// 把模拟会话成交明细（SimTrade，FIFO per code）配对成 backtest 口径的**已平仓** `TradeDetail` 列表。
/// 仅“卖出有对应买入”的已平仓段计入（胜率/交易笔数/持仓时长口径=backtest）；
/// 期末未实现持仓（未平仓）不进入 `win_rate`/`trade_count`/`avg_hold_bars`（与 backtest 强制平仓口径一致）。
/// 费用按其占成交量比例分摊到平仓段（买/卖各一次）；`stamp_duty` 已含在 sim 的 `fee` 内，此处单列 ≈0 保留字段。
/// 确定性、无随机：输入 k 条成交 → 输出确定的一组 TradeDetail。
fn sim_trades_to_trade_details(trades: &[SimTrade], period: Period) -> Vec<TradeDetail> {
    use std::collections::{BTreeMap, VecDeque};

    /// 开仓 lot（FIFO）。
    struct Lot {
        open_ts: i64,
        open_price: f64,
        open_qty: f64,
        remaining: f64,
        fee: f64,
    }

    let bar_sec = bt_bar_seconds(period);
    let mut open: BTreeMap<String, VecDeque<Lot>> = BTreeMap::new();
    let mut closed: Vec<TradeDetail> = Vec::new();

    for t in trades {
        match &t.side {
            Side::Buy => {
                open.entry(t.code.clone()).or_default().push_back(Lot {
                    open_ts: t.ts,
                    open_price: t.price,
                    open_qty: t.qty,
                    remaining: t.qty,
                    fee: t.fee,
                });
            }
            Side::Sell => {
                let Some(queues) = open.get_mut(&t.code) else { continue };
                let mut sell_remaining = t.qty;
                while sell_remaining > 0.0 {
                    let Some(lot) = queues.front_mut() else { break };
                    let matched = lot.remaining.min(sell_remaining);
                    if matched <= 0.0 {
                        break;
                    }
                    let ratio = matched / lot.open_qty;
                    let buy_fee_share = lot.fee * ratio;
                    let sell_fee_share = t.fee * (matched / t.qty);
                    let buy_cost = lot.open_price * matched + buy_fee_share;
                    let sell_gross = t.price * matched;
                    let pnl = (sell_gross - sell_fee_share) - buy_cost;
                    let open_bar = (lot.open_ts / bar_sec) as usize;
                    let close_bar = (t.ts / bar_sec) as usize;
                    closed.push(TradeDetail {
                        open_ts: lot.open_ts,
                        close_ts: t.ts,
                        open_bar,
                        close_bar,
                        open_price: lot.open_price,
                        close_price: t.price,
                        shares: matched,
                        gross_value: sell_gross,
                        commission: buy_fee_share + sell_fee_share,
                        stamp_duty: 0.0,
                        pnl,
                        hold_bars: close_bar.saturating_sub(open_bar),
                    });
                    lot.remaining -= matched;
                    sell_remaining -= matched;
                    if lot.remaining <= 1e-9 {
                        queues.pop_front();
                    }
                }
            }
        }
    }

    closed
}
