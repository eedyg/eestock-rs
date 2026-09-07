//! 会话生命周期（ADR 11-sim-live §3/§10）：start/stop/get_state；会话内事件流（净值序列/成交）。
//!
//! 纯逻辑、无 IO/无随机：开始会话重置账户为 cash_init；每个 tick `mark_to_market(latest)` 记录净值；
//! `record_trade` 追加成交明细；`stop_session` 置 ended + end_ts 并返回会话状态快照。
//! 会话 id 用时间戳 + 单调计数器生成（可复现、无随机——与 application::new_group_id 同模式）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::account::{Position, SimAccount, SimPosition};
use crate::fill::{Side, SimTrade};

/// 会话状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionStatus {
    Running,
    Ended,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Running => "running",
            SessionStatus::Ended => "ended",
        }
    }
}

/// 会话元数据（落库 simsession 行的领域视图；`strategy_set`/`stock_set` 为 JSON 数组文本）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimSession {
    pub id: String,
    pub name: String,
    pub cash_init: f64,
    pub strategy_set: Vec<String>,
    pub stock_set: Vec<String>,
    pub period: String,
    pub start_ts: i64,
    pub end_ts: Option<i64>,
    pub status: SessionStatus,
    pub source: String, // "mcp" | "web" | "preset"
}

/// 模拟订单（挂单/已成交；L1 简化：成交即填，无在途状态机——duration 字段预留）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimOrder {
    pub id: String,
    pub session_id: String,
    pub intent_id: Option<String>,
    pub code: String,
    pub side: Side,
    pub qty: f64,
    pub limit_price: Option<f64>,
    pub status: OrderStatus,
    pub filled_price: Option<f64>,
    pub filled_qty: f64,
    pub fee: f64,
    pub ts: i64,
    /// 订单来源：`manual` | `aggregate_strategy`（自动单）| `strategy`（预留）。
    /// L4 补（F1）：`SimOrder` 未透传 source，导致面板「来源」列空白；此处补上与 `SimTrade.source` 同口径。
    pub source: String,
}

/// 订单状态（L1 简化：pending→filled；取消→cancelled）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderStatus {
    Pending,
    Filled,
    Cancelled,
}

impl OrderStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderStatus::Pending => "pending",
            OrderStatus::Filled => "filled",
            OrderStatus::Cancelled => "cancelled",
        }
    }
}

/// 基础策略信号结构（ADR §4 L2 用；L1 只定字段，不实现实时评估）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategySignal {
    pub ts: i64,
    pub code: String,
    pub strategy_id: String,
    /// 评分 0-100（每策略对单标的独立评分）。
    pub score: f64,
    /// 方向信号：buy / sell / hold。
    pub signal: String,
    /// 聚合评分（L2 多策略合成；L1 单策略 = 自身评分）。
    pub aggregate_score: f64,
}

/// 会话内信号事件（ADR §10 事件流；L2 每评估一次产出一条）。
/// `ordered` 表示该次评估是否因聚合信号触发下模拟单（由 application 层判定）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignalEvent {
    pub ts: i64,
    pub code: String,
    pub strategy_id: String,
    /// 该策略对该标的的独立评分 0-100。
    pub score: f64,
    /// 方向信号：buy / sell / hold。
    pub signal: String,
    /// 该标的本次聚合评分 0-100。
    pub aggregate_score: f64,
    /// 是否因此触发下模拟单。
    pub ordered: bool,
}

/// 会话状态快照（get_state 返回；供 MCP/web 查询）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionState {
    pub session: SimSession,
    pub cash: f64,
    pub equity: f64,
    pub market_value: f64,
    pub realized_pnl: f64,
    pub unrealized_pnl: f64,
    pub total_fee: f64,
    pub positions: Vec<Position>,
    pub net_value_series: Vec<(i64, f64)>,
    pub trades: Vec<SimTrade>,
    pub signal_events: Vec<SignalEvent>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// 会话管理器（单一账户 + 会话内事件流）。
pub struct SessionManager {
    pub account: SimAccount,
    session: Option<SimSession>,
    net_value_series: Vec<(i64, f64)>,
    trades: Vec<SimTrade>,
    signal_events: Vec<SignalEvent>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            account: SimAccount::new(0.0),
            session: None,
            net_value_series: Vec::new(),
            trades: Vec::new(),
            signal_events: Vec::new(),
        }
    }

    /// 开始会话：重置账户为 cash_init，置 running。
    #[allow(clippy::too_many_arguments)]
    pub fn start_session(
        &mut self,
        name: &str,
        cash_init: f64,
        strategy_set: Vec<String>,
        stock_set: Vec<String>,
        period: &str,
        start_ts: i64,
        source: &str,
    ) -> SimSession {
        let id = new_session_id(start_ts);
        let session = SimSession {
            id: id.clone(),
            name: name.into(),
            cash_init,
            strategy_set,
            stock_set,
            period: period.into(),
            start_ts,
            end_ts: None,
            status: SessionStatus::Running,
            source: source.into(),
        };
        self.account = SimAccount::new(cash_init);
        self.session = Some(session.clone());
        self.net_value_series.clear();
        self.trades.clear();
        self.signal_events.clear();
        // 记录初始净值点（现金 = cash_init，市值 0）。
        self.record_net_value(start_ts);
        session
    }

    pub fn current_session(&self) -> Option<&SimSession> {
        self.session.as_ref()
    }

    /// 记录一笔成交（追加到会话事件流；账户状态由调用方经 apply_fill 更新）。
    pub fn record_trade(&mut self, trade: SimTrade) {
        self.trades.push(trade);
    }

    pub fn trades(&self) -> &[SimTrade] {
        &self.trades
    }

    /// 记录一个信号事件（L2 事件流：每评估一次 append 一条）。
    pub fn record_signal_event(&mut self, event: SignalEvent) {
        self.signal_events.push(event);
    }

    /// 会话信号事件列表（L2；供 MCP/web 查询）。
    pub fn signal_events(&self) -> &[SignalEvent] {
        &self.signal_events
    }

    /// 记净值：打市值后追加 `(ts, equity)` 到净值序列（并返回）。`latest` 空 = 沿用上次价。
    pub fn record_net_value(&mut self, ts: i64) -> f64 {
        let equity = self.account.equity();
        self.net_value_series.push((ts, equity));
        equity
    }

    /// 按最新价打市值并追加净值点。
    pub fn tick(&mut self, ts: i64, latest: &BTreeMap<String, f64>) -> f64 {
        let equity = self.account.mark_to_market(latest);
        self.net_value_series.push((ts, equity));
        equity
    }

    /// 停止会话：置 ended + end_ts（不重复 stop 幂等）。
    pub fn stop_session(&mut self, end_ts: i64) -> Option<SimSession> {
        let session = self.session.as_mut()?;
        if session.status == SessionStatus::Ended {
            return None;
        }
        session.status = SessionStatus::Ended;
        session.end_ts = Some(end_ts);
        Some(session.clone())
    }

    /// 会话状态快照（get_state）。
    pub fn get_state(&self) -> Option<SessionState> {
        self.session.as_ref().map(|session| SessionState {
            session: session.clone(),
            cash: self.account.cash,
            equity: self.account.equity(),
            market_value: self.account.market_value(),
            realized_pnl: self.account.realized_pnl,
            unrealized_pnl: self.account.unrealized_pnl(),
            total_fee: self.account.total_fee,
            positions: self.account.positions.values().cloned().collect(),
            net_value_series: self.net_value_series.clone(),
            trades: self.trades.clone(),
            signal_events: self.signal_events.clone(),
        })
    }

    /// 会话位置快照（供落库 sim_positions）。
    pub fn positions(&self) -> Vec<SimPosition> {
        self.account.position_snapshot()
    }
}

/// 会话 id：时间戳（秒）+ 单调计数器（无随机，可复现）。
fn new_session_id(ts: i64) -> String {
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("s_{}_{}", ts, n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fill::Fill;

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    fn buy(code: &str, qty: f64, price: f64, fee: f64) -> Fill {
        Fill { code: code.into(), side: Side::Buy, qty, price, fee }
    }

    #[test]
    fn start_session_resets_account_and_records_initial_net_value() {
        let mut m = SessionManager::new();
        let s = m.start_session("test", 1_000_000.0, vec!["dual_ma".into()], vec!["510300".into()], "M1", 1000, "manual");
        assert_eq!(s.status, SessionStatus::Running);
        assert!(s.id.starts_with("s_1000_"));
        assert_eq!(s.cash_init, 1_000_000.0);
        assert_eq!(s.strategy_set, vec!["dual_ma".to_string()]);
        assert_eq!(s.stock_set, vec!["510300".to_string()]);
        assert_eq!(s.period, "M1");
        assert_eq!(s.source, "manual");
        assert!(s.end_ts.is_none());
        // 初始净值点 = cash_init
        close(m.account.cash, 1_000_000.0);
        let st = m.get_state().unwrap();
        assert_eq!(st.net_value_series, vec![(1000, 1_000_000.0)], "初始净值点");
        assert!(st.trades.is_empty());
    }

    #[test]
    fn tick_records_equity_with_latest_prices() {
        let mut m = SessionManager::new();
        m.start_session("test", 1_000_000.0, vec![], vec![], "M1", 1000, "manual");
        m.account.apply_fill(&buy("510300", 1000.0, 10.0, 5.0)).unwrap();
        let mut latest = BTreeMap::new();
        latest.insert("510300".into(), 11.0);
        let equity = m.tick(2000, &latest);
        // cash = 1_000_000 - 1000*10 - 5 = 989995；市值 = 1000*11 = 11000；equity = 1000995
        close(equity, 1_000_995.0);
        let st = m.get_state().unwrap();
        assert_eq!(st.net_value_series, vec![(1000, 1_000_000.0), (2000, 1_000_995.0)]);
        close(st.unrealized_pnl, 1000.0 * (11.0 - 10.0));
    }

    #[test]
    fn record_trade_appends_to_event_stream() {
        let mut m = SessionManager::new();
        m.start_session("test", 1_000_000.0, vec![], vec![], "M1", 1000, "manual");
        m.record_trade(SimTrade {
            code: "510300".into(), side: Side::Buy, qty: 1000.0, price: 10.002, ts: 1000, fee: 5.0, source: "manual".into(),
        });
        let st = m.get_state().unwrap();
        assert_eq!(st.trades.len(), 1);
        assert_eq!(st.trades[0].code, "510300");
        assert_eq!(st.trades[0].source, "manual");
    }

    #[test]
    fn stop_session_sets_ended_and_end_ts_is_idempotent() {
        let mut m = SessionManager::new();
        m.start_session("test", 100_000.0, vec![], vec![], "M1", 1000, "manual");
        let s1 = m.stop_session(5000).expect("stop 返回会话");
        assert_eq!(s1.status, SessionStatus::Ended);
        assert_eq!(s1.end_ts, Some(5000));
        // 幂等：已 ended 再次 stop → None
        assert!(m.stop_session(6000).is_none());
        let st = m.get_state().unwrap();
        assert_eq!(st.session.status, SessionStatus::Ended);
        assert_eq!(st.session.end_ts, Some(5000));
    }

    #[test]
    fn positions_snapshot_returns_code_qty_avg_cost() {
        let mut m = SessionManager::new();
        m.start_session("test", 100_000.0, vec![], vec![], "M1", 1000, "manual");
        m.account.apply_fill(&buy("510300", 1000.0, 10.0, 5.0)).unwrap();
        let pos = m.positions();
        assert_eq!(pos.len(), 1);
        assert_eq!(pos[0].code, "510300");
        close(pos[0].qty, 1000.0);
        close(pos[0].avg_cost, 10.0);
    }

    /// 事件流：record_signal_event 追加到会话，get_state 可读，start_session 重置。
    #[test]
    fn signal_event_recorded_reset_on_start() {
        let mut m = SessionManager::new();
        m.start_session("test", 100_000.0, vec![], vec![], "M1", 1000, "manual");
        assert!(m.signal_events().is_empty());

        let ev = SignalEvent {
            ts: 1001,
            code: "510300".into(),
            strategy_id: "dual_ma".into(),
            score: 100.0,
            signal: "buy".into(),
            aggregate_score: 80.0,
            ordered: true,
        };
        m.record_signal_event(ev.clone());
        assert_eq!(m.signal_events().len(), 1);
        assert_eq!(m.signal_events()[0], ev);

        let st = m.get_state().unwrap();
        assert_eq!(st.signal_events.len(), 1);
        assert_eq!(st.signal_events[0].strategy_id, "dual_ma");
        assert_eq!(st.signal_events[0].aggregate_score, 80.0);
        assert!(st.signal_events[0].ordered);

        // 重新 start → 事件流清空。
        m.start_session("test2", 50_000.0, vec![], vec![], "M1", 2000, "manual");
        assert!(m.signal_events().is_empty());
    }
}
