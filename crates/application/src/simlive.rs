//! 模拟实盘服务（application 层，11-sim-live / L1；手写，非 tangle）。
//! 依赖注入 domain 端口 `SimSessionStore` + `Clock`，并经 `simlive` crate（纯逻辑）；
//! 不依赖 web/storage/sqlx（DI 由 app bin 装配）。
//!
//! 职责：会话生命周期（start/stop）、账户/持仓/订单/盈亏查询、`place_order`（市价/限价→FillEngine）、
//! `cancel_order`（仅取消 pending 限价）、幂等（intent_id 去重）。运行态在内存（SessionManager），
//! 持久化经 `SimSessionStore`（会话元数据 / 成交明细 / 持仓快照 / 结束结果）。

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use std::collections::{BTreeMap, HashMap as Map, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use backtest::{
    Bar, FeeModel, ParamValue, Period, StrategyParams, TradeDetail,
    compute_drawdown, compute_metrics,
};
use domain::ports::{
    Clock, KlineRead, NewSimSession, NewSimTrade, SimPositionRow, SimSessionResult, SimSessionState,
    SimSessionStore, SimSessionStatus, SimSessionView, StrategyStore,
};
use domain::strategy_state::StrategyStatus;
use serde::{Deserialize, Serialize};

use crate::simlive_orch::{spawn_orchestrator_async, OrchestratorHandle};
use crate::strategy::{fill_and_validate_params, schema_from_json, sha256_hex};
use crate::workbench::{SlotReq, SubmitRunReq, WorkbenchService};
// P4a：钉住策略配置/会话事件类型再导出（web/MCP 展示与事件流面共用同型）。
pub use simlive::{PluginStrategyConfig, SessionEvent};
use simlive::{
    current_entry_ts, Fill, FillEngine, Order, OrderStatus, Position,
    PositionInput, SessionManager, Side, SignalEvent, SimAccount, SimOrder,
    SimPosition, SimSession, SimTrade, StockEvaluation, MAX_STOCKS_PER_STRATEGY, MAX_STRATEGIES,
};

static NEXT_ORDER_ID: AtomicU64 = AtomicU64::new(0);

/// 默认初始资金（ADR 11-sim-live §5：1_000_000）。
pub const DEFAULT_CASH_INIT: f64 = 1_000_000.0;
/// 聚合策略默认开仓数量（每股；L2 简化来源 aggregate_strategy）。
pub const DEFAULT_AGGREGATE_QTY: f64 = 100.0;

/// 单策略输入（P4a 切源：**破坏性 wire 变更**，系统 pre-1.0）：
/// `strategy_id` 为 **Registry 策略 id**（st_ 前缀；旧内建 id 如 dual_ma 不再接受，
/// 返回明确错误并引导用 `strategy_list` 查询可用策略）；`version_id` 缺省 = 最新 published。
/// `params` 为 `serde_json::Value`（web/MCP 传参形态）；应用层按版本 schema 校验/缺省填充。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyConfigInput {
    pub strategy_id: String,
    /// 钉住版本 id（sv_ 前缀）；缺省 = 该策略最新 published 版本。
    #[serde(default)]
    pub version_id: Option<String>,
    /// 策略参数（按版本 params_schema；缺省 → schema 默认值填充）。
    #[serde(default = "default_params")]
    pub params: serde_json::Value,
    /// 该策略实时评估的标的子集（须非空 ≤30，均为注册标的）。
    #[serde(default)]
    pub stocks: Vec<String>,
    /// 聚合权重（>0，缺省 1.0）。
    #[serde(default = "default_weight")]
    pub weight: f64,
    /// 按标的覆盖权重（策略×股票级，ADR §4 补充）：未指定某股 → 用 `weight`。
    #[serde(default)]
    pub stock_weights: Map<String, f64>,
}

fn default_params() -> serde_json::Value {
    serde_json::Value::Object(Default::default())
}

fn default_weight() -> f64 {
    1.0
}

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
    /// 聚合做多阈值（缺省 60；P4a：会话级钉住，回测对比同源）。
    #[serde(default)]
    pub buy_long_threshold: Option<f64>,
    /// 聚合卖出阈值（缺省 40；P4a：会话级钉住，回测对比同源）。
    #[serde(default)]
    pub sell_threshold: Option<f64>,
    /// 每策略配置（ADR §4；P4a 切源 Registry）：若提供 → 钉住 published 版本建插件编排器；
    /// 未提供 → 回退 `strategy_set × stock_set`（strategy_set 元素 = Registry strategy_id，
    /// 缺省参数、weight=1）。两者均空 → 纯手动会话（无策略编排器）。
    #[serde(default)]
    pub strategies: Vec<StrategyConfigInput>,
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

/// 会话配置非法（策略 id/params/标的集/weight 校验失败）。web 映射 400 / MCP 映射 isError。
#[derive(Debug, Clone, PartialEq)]
pub struct InvalidConfig(pub String);

impl std::fmt::Display for InvalidConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for InvalidConfig {}

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
    /// 插件策略编排器 worker 句柄（P4a；每「策略×标的」一 QuickJS 实例，专用线程承载）。
    /// Drop 句柄 → worker 线程退出（stop/end/reconfigure 时显式置 None）。
    orchestrator: Option<OrchestratorHandle>,
    /// 编排器代际（MINOR-1：start/恢复 = 0，configure_strategies/故障注入每次 +1）。
    /// `process_bar` 阶段 1 捕获、阶段 3 锁内比对——在飞期间重配的旧 worker 迟到结果据此丢弃。
    generation: u64,
    /// 钉住策略快照（启动时定格：strategy_id+version_id+version+sha256+code+params；
    /// 恢复/回测对比/展示同源）。
    pinned: Vec<PluginStrategyConfig>,
    /// 会话级钉住阈值（默认 60/40；回测对比同源）。
    buy_long_threshold: f64,
    sell_threshold: f64,
    /// code → 最近一次评估（查询用；worker 评估后由 process_bar 更新）。
    latest: BTreeMap<String, StockEvaluation>,
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
/// **P4a 口径变化**：回测从「旧内建回测引擎 × 策略×标的笛卡尔积」切换为**统一 ensemble 引擎**
/// （每标的 1 个 ensemble run，slots=覆盖该标的的钉住策略，阈值=会话钉住阈值，
/// LumpSum 全仓 + 会话 FeeModel；评分语义与 sim-live 一致，可比性增强，
/// 但与切源前的历史对比结果**绝对值不可直接比**）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BacktestCompareView {
    pub session_id: String,
    /// 会话自身的结束结果（净值/交易/指标）。
    pub session_result: Option<SimSessionResult>,
    /// 触发的 ensemble run id 列表（sr_ 前缀字符串；异步：调用方轮询 bt_get_run）。
    pub run_ids: Vec<String>,
}

/// 启动恢复结果（`recover_sessions` 返回；重启后收敛/恢复遗留 running 会话）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecoveryReport {
    /// 成功恢复（续跑）的会话 id（有持久化运行态→重建内存，不标记中断）。
    pub recovered: Vec<String>,
    /// 降级标记 ended 的会话 id（无运行态/损坏→标记 ended + 告警，不打崩）。
    pub degraded: Vec<String>,
}

/// 模拟实盘服务。
pub struct SimLiveService {
    store: Arc<dyn SimSessionStore>,
    clock: Arc<dyn Clock>,
    fee: FeeModel,
    default_cash: f64,
    /// 聚合策略开仓数量（每股；L2 简化，来源标识 aggregate_strategy）。
    aggregate_qty: f64,
    /// 策略 Registry 读端口（P4a 切源：启动钉住 published 版本 + 恢复重建；None = 未注入，
    /// 注入前任何带策略的会话启动返回 InvalidConfig）。
    strategies: Option<Arc<dyn StrategyStore>>,
    /// 回测工作台（P4a「回测一下」：统一 ensemble 引擎；None = 未注入）。
    workbench: Option<Arc<WorkbenchService>>,
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
            strategies: None,
            workbench: None,
            kline: None,
            sessions: Mutex::new(Map::new()),
            mcp_enabled: AtomicBool::new(true),
        }
    }

    /// 注入策略 Registry 读端口（P4a 切源必需：启动钉住 published 版本 + 恢复重建）。
    pub fn with_strategies(mut self, strategies: Arc<dyn StrategyStore>) -> Self {
        self.strategies = Some(strategies);
        self
    }

    /// 注入回测工作台（P4a「回测一下」走统一 ensemble 引擎；未注入时 sim_run_backtest_compare 返回错误）。
    pub fn with_workbench(mut self, workbench: Arc<WorkbenchService>) -> Self {
        self.workbench = Some(workbench);
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
    /// P4a 切源（ADR 12 §13.6）：策略来源 = Registry **published 版本**——启动时钉住
    /// （strategy_id+version_id+version+sha256+code+params 定格），每「策略×标的」一个 QuickJS 实例；
    /// **无 published / 未知策略 / 实例化失败 → 启动失败（InvalidConfig，web 400 / MCP isError）**，
    /// 旧「未知策略静默跳过」语义废止。未提供 `strategies` → 回退 `strategy_set × stock_set`
    /// （strategy_set 元素 = Registry strategy_id，缺省参数、weight=1）；两者均空 → 纯手动会话。
    pub async fn start_session(&self, req: &StartSessionReq) -> anyhow::Result<SimSessionView> {
        if let Some(existing) = self.current_session_id() {
            return Err(AlreadyRunning(existing).into());
        }
        // 会话级钉住阈值（缺省 60/40；回测对比同源）。
        let buy_long_threshold = req.buy_long_threshold.unwrap_or(simlive::DEFAULT_BUY_LONG_THRESHOLD);
        let sell_threshold = req.sell_threshold.unwrap_or(simlive::DEFAULT_SELL_THRESHOLD);
        if !buy_long_threshold.is_finite()
            || !sell_threshold.is_finite()
            || buy_long_threshold <= sell_threshold
        {
            return Err(InvalidConfig(format!(
                "buy_long_threshold 须严格大于 sell_threshold 且均有限，got {buy_long_threshold} <= {sell_threshold}"
            ))
            .into());
        }
        // MINOR-4（与 strategy-core EnsembleConfig::validate 同规）：阈值须夹中立 50——
        // 保证「全部熔断 → 聚合中立 50 → Hold」契约不被阈值配置破坏（web 400 / MCP isError）。
        if buy_long_threshold <= simlive::NEUTRAL_SCORE || sell_threshold >= simlive::NEUTRAL_SCORE {
            return Err(InvalidConfig(format!(
                "buy_long_threshold 须 > 50 且 sell_threshold 须 < 50（夹中立 50，全熔断→Hold 契约），\
                 got {buy_long_threshold} / {sell_threshold}"
            ))
            .into());
        }
        // strategies 未提供 → 回退 strategy_set × stock_set（元素 = Registry strategy_id）。
        let inputs: Vec<StrategyConfigInput> = if req.strategies.is_empty() {
            req.strategy_set
                .iter()
                .map(|sid| StrategyConfigInput {
                    strategy_id: sid.clone(),
                    version_id: None,
                    params: default_params(),
                    stocks: req.stock_set.clone(),
                    weight: 1.0,
                    stock_weights: Map::new(),
                })
                .collect()
        } else {
            req.strategies.clone()
        };
        // 钉住解析（注册表成员校验 + published 版本定格 + params 校验填充）。
        let pinned: Vec<PluginStrategyConfig> = if inputs.is_empty() {
            Vec::new()
        } else {
            let registered = self.registered_codes().await?;
            match self.resolve_pinned_configs(&inputs, &registered).await {
                Ok(p) => p,
                Err(e) => return Err(e.into()),
            }
        };
        // 插件编排器 worker（每「策略×标的」一 QuickJS 实例；实例化失败 → 启动失败显式报错）。
        let orchestrator = if pinned.is_empty() {
            None
        } else {
            match spawn_orchestrator_async(pinned.clone(), buy_long_threshold, sell_threshold).await {
                Ok(h) => Some(h),
                Err(e) => return Err(InvalidConfig(format!("策略插件实例化失败：{e}")).into()),
            }
        };
        // 会话级 strategy_set/stock_set 由钉住配置派生（去重、保序）。
        let (strategy_set, stock_set) = {
            let mut ids: Vec<String> = Vec::new();
            for c in &pinned {
                if !ids.contains(&c.strategy_id) {
                    ids.push(c.strategy_id.clone());
                }
            }
            let mut stks: Vec<String> = Vec::new();
            for c in &pinned {
                for s in &c.stocks {
                    if !stks.contains(s) {
                        stks.push(s.clone());
                    }
                }
            }
            (ids, stks)
        };
        let now = self.clock.now();
        let mut manager = SessionManager::new();
        let session = manager.start_session(
            &req.name,
            req.cash_init.unwrap_or(self.default_cash),
            strategy_set,
            stock_set,
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
                orchestrator,
                generation: 0,
                pinned,
                buy_long_threshold,
                sell_threshold,
                latest: BTreeMap::new(),
                trading_enabled: false,
            },
        );
        // 实时落盘初始运行态（现金= cash_init、净值序列=[(start_ts,cash_init)]；供重启恢复）。
        self.persist_state(&session.id).await?;
        Ok(to_session_view(&session))
    }

    /// 钉住解析（P4a）：逐输入校验（strategy_id/stocks/weight/上限）→ 版本定格
    /// （version_id 缺省 = 最新 published；无 published → InvalidConfig）→ params 按版本
    /// schema 校验/缺省填充 → `PluginStrategyConfig`（含 code/sha256/name 快照）。
    /// `registered`：注册表 code 集；`None` = 未注入注册表端口 → 回退仅格式校验。
    async fn resolve_pinned_configs(
        &self,
        inputs: &[StrategyConfigInput],
        registered: &Option<HashSet<String>>,
    ) -> Result<Vec<PluginStrategyConfig>, InvalidConfig> {
        let Some(store) = self.strategies.clone() else {
            return Err(InvalidConfig(
                "策略 Registry 未注入（P4a 切源后 sim-live 策略源为 Registry；app 装配 with_strategies）".into(),
            ));
        };
        if inputs.len() > MAX_STRATEGIES {
            return Err(InvalidConfig(format!(
                "策略数 {} 超上限 {MAX_STRATEGIES}（ADR §4：3 策略）",
                inputs.len()
            )));
        }
        let mut out = Vec::with_capacity(inputs.len());
        for input in inputs {
            let sid = input.strategy_id.trim();
            if sid.is_empty() {
                return Err(InvalidConfig("strategy_id 不能为空".into()));
            }
            // 旧内建 id 拒绝 + 引导（破坏性 wire 变更，pre-1.0）。
            let strategy = store.get_strategy(sid).await.map_err(|e| {
                InvalidConfig(format!("查询策略失败: {e}"))
            })?.ok_or_else(|| {
                InvalidConfig(format!(
                    "未知策略 id: {sid}（P4a 切源后仅接受 Registry strategy_id，旧内建 id 如 dual_ma 已废止；\
                     请用 strategy_list 查询可用策略）"
                ))
            })?;
            // 版本定格：显式 version_id（须属于该策略且 published）/ 缺省取最新 published。
            let version = match &input.version_id {
                Some(vid) => {
                    let v = store.get_version(vid).await.map_err(|e| {
                        InvalidConfig(format!("查询策略版本失败: {e}"))
                    })?.ok_or_else(|| InvalidConfig(format!("策略版本不存在: {vid}")))?;
                    if v.strategy_id != sid {
                        return Err(InvalidConfig(format!(
                            "版本 {vid} 不属于策略 {sid}"
                        )));
                    }
                    if v.status != StrategyStatus::Published {
                        return Err(InvalidConfig(format!(
                            "策略版本 {vid} 未发布（status={}），仅 published 版本可用于会话",
                            v.status.as_str()
                        )));
                    }
                    v
                }
                None => store
                    .list_versions(sid)
                    .await
                    .map_err(|e| InvalidConfig(format!("查询策略版本失败: {e}")))?
                    .into_iter()
                    .filter(|v| v.status == StrategyStatus::Published)
                    .max_by_key(|v| v.version)
                    .ok_or_else(|| {
                        InvalidConfig(format!(
                            "策略 {sid} 无 published 版本（仅 published 版本可用于会话；请先 strategy_publish）"
                        ))
                    })?,
            };
            // params 按版本 schema 校验 + 缺省填充（ABI §1 NIT-6：消费方职责）。
            let schema = schema_from_json(&version.params_schema);
            let params = fill_and_validate_params(&schema, &input.params)
                .map_err(InvalidConfig)?;
            // 标的集：非空、≤30、均注册。
            if input.stocks.is_empty() {
                return Err(InvalidConfig(format!("策略 {sid} 至少需指定一个标的")));
            }
            if input.stocks.len() > MAX_STOCKS_PER_STRATEGY {
                return Err(InvalidConfig(format!(
                    "策略 {sid} 标的数 {} 超上限 {MAX_STOCKS_PER_STRATEGY}（ADR §4：≤30 股）",
                    input.stocks.len()
                )));
            }
            for code in &input.stocks {
                validate_registered_stock(code, registered).map_err(|e| InvalidConfig(e.to_string()))?;
            }
            if !input.weight.is_finite() || input.weight <= 0.0 {
                return Err(InvalidConfig(format!("策略 {sid} 权重必须为正数")));
            }
            for (code, w) in &input.stock_weights {
                if !input.stocks.contains(code) {
                    return Err(InvalidConfig(format!(
                        "策略 {sid} 的 stock_weights 键 {code} 不在其标的集内"
                    )));
                }
                if !w.is_finite() || *w <= 0.0 {
                    return Err(InvalidConfig(format!("策略 {sid} 的 {code} 权重必须为正数")));
                }
            }
            out.push(PluginStrategyConfig {
                strategy_id: sid.to_string(),
                version_id: version.id.clone(),
                version: version.version,
                sha256: version.sha256.clone(),
                name: strategy.name.clone(),
                code: version.code.clone(),
                params,
                stocks: input.stocks.clone(),
                weight: input.weight,
                stock_weights: input.stock_weights.clone(),
            });
        }
        Ok(out)
    }

    // ── 11-sim-live / 重启恢复（实时落盘 + 从落盘重建续跑）──

    /// 启动恢复：收敛/恢复进程重启遗留的 `status='running'` 会话。
    /// - 有 `simsession_state` → 重建内存 `LiveSession`（账户/持仓/PnL/策略配置/净值序列/订单），续跑不标记中断；
    /// - 无 state / 损坏 → 标记 ended（最小结束结果）+ 告警，不打崩。
    ///   幂等：仅「内存不存在但仍 running」的会话；已 ended / 已恢复 / 已在内存的不动。
    ///   调用点：app bin 构造 `SimLiveService` 后（`recover_sessions().await?`）。
    pub async fn recover_sessions(&self) -> anyhow::Result<RecoveryReport> {
        let now = self.clock.now();
        let in_memory: std::collections::HashSet<String> =
            self.sessions.lock().expect("sessions poisoned").keys().cloned().collect();
        let mut recovered = Vec::new();
        let mut degraded = Vec::new();
        for view in self.store.list_sessions().await? {
            if view.status != SimSessionStatus::Running {
                continue; // 已 ended / 已恢复不动。
            }
            let id = view.id.clone();
            if in_memory.contains(&id) {
                continue; // 幂等：已在内存（本进程活动会话）不重复恢复。
            }
            match self.store.get_state(&id).await? {
                Some(state) => match self.restore_live_session(&view, &state).await {
                    Ok(live) => {
                        self.sessions.lock().expect("sessions poisoned").insert(id.clone(), live);
                        recovered.push(id);
                    }
                    Err(e) => {
                        tracing::warn!(session_id = %id, error = %e, "sim-live 会话状态损坏/策略不可恢复，标记 ended");
                        degraded.push(id.clone());
                        let _ = self.store.mark_end(&id, now, &degraded_result(&format!("恢复失败: {e}"))).await;
                    }
                },
                None => {
                    tracing::warn!(session_id = %id, "sim-live 运行中会话无 simsession_state，标记 ended");
                    degraded.push(id.clone());
                    let _ = self.store.mark_end(&id, now, &degraded_result("进程重启且无 simsession_state")).await;
                }
            }
        }
        Ok(RecoveryReport { recovered, degraded })
    }

    /// 实时落盘运行态（幂等 upsert）：从内存 `LiveSession` 快照构建 [`SimSessionState`] 写库。
    /// 会话不在内存（未知/已 ended）→ 无操作。
    async fn persist_state(&self, session_id: &str) -> anyhow::Result<()> {
        let now = self.clock.now();
        let state = {
            let sessions = self.sessions.lock().expect("sessions poisoned");
            sessions.get(session_id).and_then(|live| build_live_state(session_id, live, now))
        };
        if let Some(state) = state {
            self.store.upsert_state(session_id, &state).await?;
        }
        Ok(())
    }

    /// 从持久化运行态重建内存 `LiveSession`（续跑）：账户现金/持仓/PnL、订单、意图去重、策略编排器。
    /// 编排器内部 bars/评分状态不持久化 → 重建后首根新 bar 重新评估（残差：重启前的实时评分丢失）。
    async fn restore_live_session(
        &self,
        view: &SimSessionView,
        state: &SimSessionState,
    ) -> anyhow::Result<LiveSession> {
        let session = SimSession {
            id: view.id.clone(),
            name: view.name.clone(),
            cash_init: view.cash_init,
            strategy_set: view.strategy_set.clone(),
            stock_set: view.stock_set.clone(),
            period: view.period.clone(),
            start_ts: view.start_ts.timestamp(),
            end_ts: None,
            status: simlive::SessionStatus::Running,
            source: view.source.clone(),
        };
        let mut account = SimAccount::new(view.cash_init);
        account.cash = state.cash;
        account.realized_pnl = state.realized_pnl;
        account.total_fee = state.total_fee;
        // 持仓重建：`latest` 优先行情源 close（与 `get_positions` 同源，自洽），避免账户级 PnL 与持仓视图不一致。
        // 修复 bug：落盘 `latest_prices[code]` 取自内存 `position.latest`，而模拟实盘 feed/manual 成交后不 mark_to_market，
        // 该值为默认 0.0 → 恢复重建时 `unrealized=qty×(0−avg_cost)=−qty×avg_cost`（大额漂移，深测见 -10172/-16209）。
        // 现改为：行情源 quote 非 0 优先；否则回退落盘 latest_prices；仍无 → 0.0（与持仓视图缺行情兜底一致）。
        let period = dom_period_from_str(&view.period).unwrap_or(domain::types::Period::M1);
        for row in &state.positions {
            let persisted = state.latest_prices.get(&row.code).copied().unwrap_or(0.0);
            let quote = self.resolve_latest_price(period, &row.code).await;
            let latest = if quote != 0.0 { quote } else { persisted };
            account.positions.insert(
                row.code.clone(),
                Position {
                    code: row.code.clone(),
                    qty: row.qty,
                    avg_cost: row.avg_cost,
                    latest,
                    market_value: row.qty * latest,
                    unrealized_pnl: row.qty * (latest - row.avg_cost),
                },
            );
        }
        // 成交明细回填（重建 SessionManager.trades；sim_trades 已按 ts 升序读回）。
        let mut trades = Vec::new();
        for t in self.store.list_trades(&view.id).await? {
            trades.push(SimTrade {
                code: t.code,
                side: Side::parse(&t.side).ok_or_else(|| anyhow!("未知方向：{}", t.side))?,
                qty: t.qty,
                price: t.price,
                ts: t.ts.timestamp(),
                fee: t.fee,
                source: t.source,
            });
        }
        let orders: Vec<SimOrder> = serde_json::from_value(state.orders.clone()).unwrap_or_default();
        let trading_enabled = state.trading_enabled;
        // P4a 恢复：从钉住快照重建插件编排器（读 strategy_version 表取 code + 校验 sha256
        // 与 published 状态；published 不可变保证 code 与钉住 sha256 一致）。
        // 恢复失败（旧内建配置/版本缺失/状态漂移/实例化失败）→ Err → 调用方标 ended + 告警
        //（参照既有恢复口径：恢复失败不打崩，会话降级 ended）。
        let snapshot = parse_pinned_snapshot(&state.strategy_configs)
            .ok_or_else(|| anyhow!("simsession_state.strategy_configs 形状非法"))?;
        let (orchestrator, pinned, buy_long_threshold, sell_threshold) = match snapshot {
            PinnedSnapshotParse::Empty => (None, Vec::new(), simlive::DEFAULT_BUY_LONG_THRESHOLD, simlive::DEFAULT_SELL_THRESHOLD),
            PinnedSnapshotParse::Legacy => {
                return Err(anyhow!("旧内建策略配置（P4a 切源前）不可恢复，会话降级 ended"));
            }
            PinnedSnapshotParse::Pinned(snap) => {
                let rebuilt = self
                    .reinstantiate_pinned(&snap.strategies, snap.buy_long_threshold, snap.sell_threshold)
                    .await?;
                (Some(rebuilt), snap.strategies, snap.buy_long_threshold, snap.sell_threshold)
            }
        };
        // intent 去重重建（同 intent_id 重复下单不重复执行）。
        let mut intent_seen = HashSet::new();
        let mut intent_fills = Map::new();
        for o in &orders {
            if let Some(intent) = &o.intent_id {
                intent_seen.insert(intent.clone());
                if let Some(price) = o.filled_price {
                    intent_fills.insert(intent.clone(), Fill {
                        code: o.code.clone(),
                        side: o.side,
                        qty: o.filled_qty,
                        price,
                        fee: o.fee,
                    });
                }
            }
        }
        let manager = SessionManager::restore(account, session, state.net_value_series.clone(), trades, Vec::new(), Vec::new());
        Ok(LiveSession {
            manager,
            fill_engine: FillEngine::new(self.fee),
            orders,
            intent_seen,
            intent_fills,
            orchestrator,
            generation: 0,
            pinned,
            buy_long_threshold,
            sell_threshold,
            latest: BTreeMap::new(),
            trading_enabled,
        })
    }

    /// 恢复用：按钉住快照重新实例化插件编排器 worker。
    /// 逐钉住项读 strategy_version 表：版本须存在且仍 published、strategy_id/sha256 与钉住一致
    /// （published 不可变 + 此处 sha256 复核双保险）；取表内 code 重新实例化。
    /// 任一失败 → Err（调用方按既有恢复口径降级 ended + 告警）。
    async fn reinstantiate_pinned(
        &self,
        pinned: &[PluginStrategyConfig],
        buy_long_threshold: f64,
        sell_threshold: f64,
    ) -> anyhow::Result<OrchestratorHandle> {
        let Some(store) = self.strategies.clone() else {
            return Err(anyhow!("策略 Registry 未注入，无法恢复策略会话"));
        };
        if pinned.is_empty() {
            return Err(anyhow!("钉住快照为空，无需重建编排器"));
        }
        let mut configs = Vec::with_capacity(pinned.len());
        for p in pinned {
            let v = store.get_version(&p.version_id).await?
                .ok_or_else(|| anyhow!("钉住版本 {} 不存在（策略 {}）", p.version_id, p.strategy_id))?;
            if v.status != StrategyStatus::Published {
                return Err(anyhow!(
                    "钉住版本 {} 已非 published（status={}），会话不可恢复",
                    p.version_id,
                    v.status.as_str()
                ));
            }
            if v.strategy_id != p.strategy_id || v.sha256 != p.sha256 {
                return Err(anyhow!(
                    "钉住版本 {} 与快照漂移（strategy_id/sha256 不一致）",
                    p.version_id
                ));
            }
            // 双保险：复核 code 的 sha256 与钉住一致（published 不可变由 DB trigger 保证）。
            if sha256_hex(&v.code) != p.sha256 {
                return Err(anyhow!(
                    "钉住版本 {} code sha256 复核不一致（数据损坏）",
                    p.version_id
                ));
            }
            let mut c = p.clone();
            c.code = v.code;
            configs.push(c);
        }
        spawn_orchestrator_async(configs, buy_long_threshold, sell_threshold).await
    }

    /// 停止会话：置 ended + 落库结束结果；返回是否转换（未知/已 ended → false）。
    /// P4a：停止即 drop 编排器句柄 → worker 线程退出（裁决契约 ①，禁止泄漏）。
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
            live.orchestrator = None; // drop sender → worker 线程通道断连退出
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
        // 实时落盘运行态（现金/持仓/净值序列/订单/开关；重启恢复）。
        self.persist_state(session_id).await?;
        let _ = order_id;
        Ok(fill)
    }

    /// 撤单：仅取消 pending 单；已成交/未知 → false。变更即实时落盘（重启恢复：订单状态一致）。
    pub async fn cancel_order(&self, session_id: &str, order_id: &str) -> anyhow::Result<bool> {
        let cancelled = {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            let Some(live) = sessions.get_mut(session_id) else {
                return Ok(false);
            };
            let mut changed = false;
            for o in live.orders.iter_mut() {
                if o.id == order_id {
                    if o.status == OrderStatus::Pending {
                        o.status = OrderStatus::Cancelled;
                        changed = true;
                    }
                    break;
                }
            }
            changed
        };
        if cancelled {
            self.persist_state(session_id).await?;
        }
        Ok(cancelled)
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

    /// 拉取已注册标的 code 集（symbols 注册表成员校验输入；经注入的 ports.kline `symbols_with_latest`）。
    /// 未注入行情源读端口 → Ok(None)：调用方回退仅格式校验（兼容既有未注入构造，如前端手动会话）。
    /// 注册表查询失败 → Err（fail-closed：无法确认注册即拒，宁可失败也不放过未注册标的）。
    async fn registered_codes(&self) -> anyhow::Result<Option<HashSet<String>>> {
        let Some(kline) = &self.kline else { return Ok(None) };
        let symbols = kline.symbols_with_latest().await?;
        Ok(Some(symbols.into_iter().map(|s| s.code).collect()))
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
    // P4a 切源（ADR 12 §13.6）：编排器内核 = Registry 钉住插件 + QuickJS 实例（worker 线程承载）。

    /// 重配实时策略编排器（P4a：入参为 Registry wire 形状，重新钉住 + 重建 worker；
    /// 旧句柄 drop → 旧 worker 线程退出，裁决契约 ①）。变更即实时落盘（重启恢复：钉住快照重建）。
    pub async fn configure_strategies(&self, session_id: &str, inputs: Vec<StrategyConfigInput>) -> anyhow::Result<()> {
        let registered = self.registered_codes().await?;
        let pinned = self
            .resolve_pinned_configs(&inputs, &registered)
            .await
            .map_err(|e| anyhow!("{e}"))?;
        let (buy, sell) = {
            let sessions = self.sessions.lock().expect("sessions poisoned");
            let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
            (live.buy_long_threshold, live.sell_threshold)
        };
        let handle = if pinned.is_empty() {
            None
        } else {
            Some(spawn_orchestrator_async(pinned.clone(), buy, sell).await
                .map_err(|e| anyhow!("策略插件实例化失败：{e}"))?)
        };
        {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            let live = sessions.get_mut(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
            live.orchestrator = handle; // 旧句柄随赋值 drop → 旧 worker 退出
            live.generation += 1; // 代际 +1：在飞旧 worker 的迟到结果由 process_bar 阶段 3 丢弃（MINOR-1）
            live.pinned = pinned;
            live.latest.clear();
        }
        self.persist_state(session_id).await?;
        Ok(())
    }

    /// 测试故障注入：替换会话编排器句柄（MINOR-3 actor 生命周期/panic 隔离测试用；
    /// 与 configure_strategies 同语义——旧句柄 drop → 旧 worker 退出 + 代际 +1）。
    /// 生产路径不得使用。
    #[doc(hidden)]
    pub fn __test_inject_orchestrator(
        &self,
        session_id: &str,
        handle: OrchestratorHandle,
    ) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get_mut(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        live.orchestrator = Some(handle);
        live.generation += 1;
        Ok(())
    }

    /// F2：实时 feed 的 poll 目标枚举（P4a：编排器在 start_session/恢复时已钉住配置，
    /// 不再自动配置；无编排器的纯手动会话不产轮询目标）。
    pub fn feed_targets(&self) -> anyhow::Result<Vec<FeedTarget>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let mut targets = Vec::new();
        for (id, live) in sessions.iter() {
            let Some(session) = live.manager.current_session() else { continue };
            if session.status != simlive::SessionStatus::Running {
                continue;
            }
            if live.orchestrator.is_none() {
                continue; // 纯手动会话（无策略）不轮询。
            }
            // 覆盖标的 = 钉住配置的股票并集（去重、升序）。
            let codes: Vec<String> = live
                .pinned
                .iter()
                .flat_map(|c| c.stocks.iter().cloned())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            targets.push(FeedTarget { session_id: id.clone(), period: session.period.clone(), codes });
        }
        Ok(targets)
    }

    /// 统一交易开关：`enabled` 且某 stock 聚合评分达做多/卖阈值 → 下模拟单；disabled → 只评估/评分不入单。
    /// 仅影响聚合策略驱动的下单（source=aggregate_strategy），不影响手动 `place_order`。返回新开关态。
    /// 变更即实时落盘（重启恢复：trading_enabled 重建）。
    pub async fn set_trading(&self, session_id: &str, enabled: bool) -> anyhow::Result<bool> {
        {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            let live = sessions.get_mut(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
            live.trading_enabled = enabled;
        }
        self.persist_state(session_id).await?;
        Ok(enabled)
    }

    /// 当前统一交易开关态。
    pub fn trading_enabled(&self, session_id: &str) -> anyhow::Result<bool> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let live = sessions.get(session_id).ok_or_else(|| anyhow!("会话不存在：{session_id}"))?;
        Ok(live.trading_enabled)
    }

    /// 喂入一根新 bar（实时行情），经编排 worker 线程评估（插件连续分直通 + 聚合）；
    /// 若 `trading_enabled` 且聚合达阈值 → 经 FillEngine 下模拟单（同一会话/账户，
    /// source=aggregate_strategy），并把每信号事件 + 会话事件（插件错误/熔断）append 到会话事件流。
    /// **position 注入**（ABI §2.5）：构建 BarCtx 时从 SimAccount 取该标的实际持仓
    /// （qty/avg_cost/entry_ts FIFO 推导；空仓 → 插件见 null）。
    /// worker 线程死亡（panic 隔离，裁决契约 ②）→ 记错误事件 + 会话降级 ended（不毒化服务）。
    /// 返回本次产出的信号事件（`ordered` 标记该 stock 是否因此下单）。
    pub async fn process_bar(&self, session_id: &str, code: &str, bar: Bar) -> anyhow::Result<Vec<SignalEvent>> {
        let ts = self.clock.now().timestamp();

        // 阶段 1（锁内）：取 worker 句柄 + 编排器代际 + 推导持仓输入（position 注入），随即放锁再 await。
        let (handle, generation, position) = {
            let sessions = self.sessions.lock().expect("sessions poisoned");
            let Some(live) = sessions.get(session_id) else {
                return Err(anyhow!("会话不存在：{session_id}"));
            };
            let Some(orch) = live.orchestrator.as_ref() else {
                return Err(anyhow!("会话未配置策略（先 configure_strategies）：{session_id}"));
            };
            (orch.clone(), live.generation, position_input(live, code))
        };

        // 阶段 2（锁外 await）：worker 线程评估（不阻塞 tokio executor，裁决契约 ③）。
        let outcome = match handle.feed_bar(code, bar, position).await {
            Ok(o) => o,
            Err(dead) => {
                // 裁决契约 ②：worker panic → 错误事件 + 会话降级 ended（不打崩服务）。
                let reason = format!("{dead}");
                tracing::warn!(session_id = %session_id, code = %code, "sim-live 编排 worker 终止，会话降级 ended");
                self.degrade_session(session_id, &reason).await;
                return Err(anyhow!(reason));
            }
        };
        // 未覆盖标的 → 不评估（仍记录行情）。
        let Some(eval) = outcome.eval else {
            // 事件（理论上未覆盖标的无插件调用 → 无事件；防御性归集）。
            if !outcome.events.is_empty() {
                let mut sessions = self.sessions.lock().expect("sessions poisoned");
                if let Some(live) = sessions.get_mut(session_id) {
                    // MINOR-1：同在飞窗口守卫——代际已变/会话已停 → 迟到事件不归集。
                    let still_running = live
                        .manager
                        .current_session()
                        .map(|s| s.status == simlive::SessionStatus::Running)
                        .unwrap_or(false);
                    if still_running && live.generation == generation {
                        for e in outcome.events {
                            live.manager.record_session_event(e);
                        }
                    }
                }
            }
            return Ok(Vec::new());
        };

        // 阶段 3（锁内）：交易判定 + 事件归集。
        let (events, persist) = {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            let Some(live) = sessions.get_mut(session_id) else {
                return Err(anyhow!("会话不存在：{session_id}"));
            };
            // MINOR-1 在飞窗口守卫：评估在锁外 await 期间会话可能已 stop/degrade（→ ended）
            // 或已 configure_strategies 重配（→ 代际 +1）。迟到结果一律丢弃：
            // 不下单（防 ended 会话补成交）、不写 latest（防旧 worker 污染评分表）、不归集事件。
            let still_running = live
                .manager
                .current_session()
                .map(|s| s.status == simlive::SessionStatus::Running)
                .unwrap_or(false);
            if !still_running || live.generation != generation {
                (Vec::new(), None)
            } else {
            live.latest.insert(eval.code.clone(), eval.clone());
            for e in outcome.events {
                live.manager.record_session_event(e);
            }

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
            }
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
        // 实时落盘运行态（每次评估后；账务/净值序列/订单/开关一致）。
        self.persist_state(session_id).await?;
        Ok(events)
    }

    /// 查询某标的最近一次策略评估（聚合分 + 各策略独立分）；未评估/未知 → Ok(None)。
    /// 会话不在内存（未启动/已 ended-降级）→ Ok(None)（不 500；重启恢复合法）。
    pub fn get_strategy_signal(&self, session_id: &str, code: &str) -> anyhow::Result<Option<StockEvaluation>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let Some(live) = sessions.get(session_id) else { return Ok(None); };
        Ok(live.latest.get(code).cloned())
    }

    /// 当前会话钉住策略配置（P4a：strategy_id/version_id/version/sha256/name/params/stocks/
    /// weight/stock_weights；供 web/MCP 展示）。会话不在内存 → Ok(vec![])（不 500；重启恢复合法）。
    pub fn strategy_configs(&self, session_id: &str) -> anyhow::Result<Vec<PluginStrategyConfig>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let Some(live) = sessions.get(session_id) else { return Ok(Vec::new()); };
        Ok(live.pinned.clone())
    }

    /// 会话事件流（P4a：插件错误/熔断告警；内存态不持久化）。返回最近 `limit` 条（尾部）。
    /// 会话不在内存 → Ok(vec![])（不 500；重启恢复合法）。
    pub fn session_events(&self, session_id: &str, limit: usize) -> anyhow::Result<Vec<SessionEvent>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let Some(live) = sessions.get(session_id) else { return Ok(Vec::new()); };
        let events = live.manager.session_events();
        let start = events.len().saturating_sub(limit);
        Ok(events[start..].to_vec())
    }

    /// 会话级钉住阈值（回测对比同源；会话不在内存 → None）。
    pub fn pinned_thresholds(&self, session_id: &str) -> Option<(f64, f64)> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        sessions.get(session_id).map(|l| (l.buy_long_threshold, l.sell_threshold))
    }

    /// 全部标的最近评估概览（多 stock 评估；无编排器 → 空）。
    /// 会话不在内存 → Ok(vec![])（不 500；重启恢复合法）。
    pub fn get_strategy_analysis(&self, session_id: &str) -> anyhow::Result<Vec<StockEvaluation>> {
        let sessions = self.sessions.lock().expect("sessions poisoned");
        let Some(live) = sessions.get(session_id) else { return Ok(Vec::new()); };
        Ok(live.latest.values().cloned().collect())
    }

    /// worker 线程死亡/状态损坏降级（裁决契约 ②）：内存置 ended + 落库最小结束结果 + 告警。
    /// 幂等（已 ended 不动）。
    async fn degrade_session(&self, session_id: &str, reason: &str) {
        let now = self.clock.now();
        {
            let mut sessions = self.sessions.lock().expect("sessions poisoned");
            if let Some(live) = sessions.get_mut(session_id) {
                live.manager.record_session_event(SessionEvent::PluginError {
                    ts: now.timestamp(),
                    code: String::new(),
                    strategy_id: String::new(),
                    sha256: String::new(),
                    bar_index: 0,
                    error: format!("会话降级 ended：{reason}"),
                });
                live.manager.stop_session(now.timestamp());
                live.orchestrator = None; // drop sender → worker 退出（若仍存活）
            }
        }
        let _ = self.store.mark_end(session_id, now, &degraded_result(reason)).await;
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

    /// 「回测一下」（L3：sim_run_backtest_compare）。**P4a 口径变化**：从旧内建回测引擎
    /// （策略×标的笛卡尔积单 run）切换为**统一 ensemble 引擎**（WorkbenchService.submit）——
    /// 会话每个标的触发 1 个 ensemble run：slots = 覆盖该标的的**钉住策略**（version_id 钉住，
    /// weight = w[S,X] = stock_weights[X] ?? weight），阈值 = **会话钉住阈值**（决策点 2 裁决，
    /// 非写死 60/40），policy = LumpSum 全仓，stop = None，initial_capital = cash_init，
    /// fee = 会话 FeeModel（模拟/回测一致）。评分语义与 sim-live 统一（可比性增强；
    /// 与切源前历史对比结果**绝对值不可直接比**）。
    /// 钉住快照来源：会话在内存 → 内存钉住配置；否则 → simsession_state 快照（重启后可比）。
    /// 无钉住快照（切源前旧会话/纯手动会话）→ 明确报错。
    pub async fn run_backtest_compare(&self, session_id: &str) -> anyhow::Result<BacktestCompareView> {
        let Some(workbench) = self.workbench.clone() else {
            return Err(anyhow!("回测工作台未注入（SimLiveService.workbench=None；app 装配时 with_workbench）"));
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
        // 钉住快照：内存优先；否则读落盘运行态。
        let snapshot = {
            let in_mem = {
                let sessions = self.sessions.lock().expect("sessions poisoned");
                sessions.get(session_id).map(|live| PinnedSnapshot {
                    strategies: live.pinned.clone(),
                    buy_long_threshold: live.buy_long_threshold,
                    sell_threshold: live.sell_threshold,
                })
            };
            match in_mem {
                Some(snap) => snap,
                None => match self.store.get_state(session_id).await? {
                    Some(state) => match parse_pinned_snapshot(&state.strategy_configs) {
                        Some(PinnedSnapshotParse::Pinned(snap)) => snap,
                        Some(PinnedSnapshotParse::Empty) => {
                            return Err(anyhow!("会话无策略（纯手动会话），无法回测对比"));
                        }
                        Some(PinnedSnapshotParse::Legacy) => {
                            return Err(anyhow!(
                                "切源前旧会话（内建策略）无插件钉住快照，无法走统一引擎对比"
                            ));
                        }
                        None => return Err(anyhow!("simsession_state.strategy_configs 形状非法")),
                    },
                    None => return Err(anyhow!("会话无钉住策略快照（无 simsession_state），无法回测对比")),
                },
            }
        };
        if snapshot.strategies.is_empty() {
            return Err(anyhow!("会话无策略（纯手动会话），无法回测对比"));
        }
        // 费用口径=会话 FeeModel（复用同源，模拟/回测一致）。
        let fee = serde_json::json!({
            "rate_pct": self.fee.commission_rate_pct,
            "min_fee": self.fee.min_commission,
            "slippage_bp": self.fee.slippage_bp,
        });
        let mut run_ids = Vec::new();
        for stock in &view.stock_set {
            // slots = 覆盖该标的的钉住策略；weight = w[S,X]（stock_weights 覆盖默认）。
            let slots: Vec<SlotReq> = snapshot
                .strategies
                .iter()
                .filter(|c| c.stocks.iter().any(|s| s == stock))
                .map(|c| SlotReq {
                    version_id: c.version_id.clone(),
                    params: strategy_params_to_json(&c.params),
                    weight: c.stock_weights.get(stock).copied().unwrap_or(c.weight),
                })
                .collect();
            if slots.is_empty() {
                continue; // 无策略覆盖该标的 → 不产 run。
            }
            let run = workbench
                .submit(SubmitRunReq {
                    name: format!("sim-compare:{session_id}:{stock}"),
                    symbol: stock.clone(),
                    period: view.period.clone(),
                    from,
                    to,
                    slots,
                    buy_threshold: Some(snapshot.buy_long_threshold),
                    sell_threshold: Some(snapshot.sell_threshold),
                    policy: serde_json::json!({ "LumpSum": { "position_pct": 1.0 } }),
                    stop: None,
                    initial_capital: Some(view.cash_init),
                    fee: fee.clone(),
                })
                .await?;
            run_ids.push(run.id);
        }
        Ok(BacktestCompareView { session_id: session_id.into(), session_result, run_ids })
    }
}

/// 校验注册标的（03-symbols §3 口径）：6 位数字 + 市场前缀（5/6/9→沪、0/1/2/3→深；北交所/未知前缀拒绝），
/// **且须在 symbols 注册表内**（ADR §4 修复：本来只验格式、不查注册表，导致 999999 这类格式合法但未注册
/// 标的通过 → 无行情、评分/市值异常）。`registered` 为注册表 code 集；`None` = 未注入端口 → 回退仅格式。
fn validate_registered_stock(code: &str, registered: &Option<HashSet<String>>) -> anyhow::Result<()> {
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(anyhow!("标的 {code} 须为 6 位数字"));
    }
    domain::types::Code(code.into())
        .market()
        .map_err(|_| anyhow!("标的不支持（北交所/未知前缀）: {code}"))?;
    // 注册表成员校验：code 须在 symbols 注册表；未注入注册表端口（None）才回退仅格式校验。
    if let Some(reg) = registered {
        if !reg.contains(code) {
            return Err(anyhow!("股票 {code} 未注册"));
        }
    }
    Ok(())
}

/// `backtest::StrategyParams` → `serde_json::Value`（Num→number / Choice→string；供 web/MCP 展示）。
pub fn strategy_params_to_json(params: &backtest::StrategyParams) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    for (k, v) in params {
        match v {
            backtest::ParamValue::Num(n) => {
                obj.insert(k.clone(), serde_json::json!(n));
            }
            backtest::ParamValue::Choice(s) => {
                obj.insert(k.clone(), serde_json::json!(s));
            }
        }
    }
    serde_json::Value::Object(obj)
}

/// `serde_json::Value` → `backtest::StrategyParams`（`strategy_params_to_json` 逆操作：Num→number、Choice→string）。
fn strategy_params_from_json(v: &serde_json::Value) -> StrategyParams {
    let mut m = std::collections::HashMap::new();
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            let pv = if let Some(n) = val.as_f64() {
                ParamValue::Num(n)
            } else if let Some(s) = val.as_str() {
                ParamValue::Choice(s.into())
            } else {
                continue;
            };
            m.insert(k.clone(), pv);
        }
    }
    m
}

/// 钉住策略快照（P4a；simsession_state.strategy_configs 的持久化形状，schema=2）：
/// `{ "schema": 2, "buy_long_threshold": .., "sell_threshold": .., "strategies": [ {strategy_id,
/// version_id, version, sha256, name, params, stocks, weight, stock_weights} ] }`。
/// 恢复/回测对比同源；published 不可变保证 code 与 sha256 一致（恢复时从 strategy_version 表重取 code）。
#[derive(Debug, Clone, PartialEq)]
struct PinnedSnapshot {
    strategies: Vec<PluginStrategyConfig>,
    buy_long_threshold: f64,
    sell_threshold: f64,
}

/// 快照解析结果（恢复口径分支）。
#[derive(Debug, Clone, PartialEq)]
enum PinnedSnapshotParse {
    /// 无策略（纯手动会话）。
    Empty,
    /// 切源前旧形状（内建策略 id 数组）——不可恢复/不可对比（P4b 前降级）。
    Legacy,
    /// 新钉住快照。
    Pinned(PinnedSnapshot),
}

/// 解析 simsession_state.strategy_configs（新旧形状判别）。
/// 旧形状：JSON 数组（空 = 无策略 → Empty；非空 = 旧内建配置 → Legacy）。
/// 新形状：schema=2 对象（strategies 空 → Empty）。
fn parse_pinned_snapshot(v: &serde_json::Value) -> Option<PinnedSnapshotParse> {
    if let Some(arr) = v.as_array() {
        return Some(if arr.is_empty() {
            PinnedSnapshotParse::Empty
        } else {
            PinnedSnapshotParse::Legacy
        });
    }
    let obj = v.as_object()?;
    if obj.get("schema")?.as_i64()? != 2 {
        return None;
    }
    let buy = obj.get("buy_long_threshold")?.as_f64()?;
    let sell = obj.get("sell_threshold")?.as_f64()?;
    let arr = obj.get("strategies")?.as_array()?;
    if arr.is_empty() {
        return Some(PinnedSnapshotParse::Empty);
    }
    let mut strategies = Vec::with_capacity(arr.len());
    for item in arr {
        let strategy_id = item.get("strategy_id")?.as_str()?.to_string();
        let version_id = item.get("version_id")?.as_str()?.to_string();
        let version = item.get("version")?.as_i64()? as i32;
        let sha256 = item.get("sha256")?.as_str()?.to_string();
        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or(&strategy_id).to_string();
        let params = item.get("params").map(strategy_params_from_json).unwrap_or_default();
        let stocks: Vec<String> = item.get("stocks")?.as_array()?
            .iter().filter_map(|s| s.as_str().map(String::from)).collect();
        let weight = item.get("weight")?.as_f64()?;
        let stock_weights = item.get("stock_weights")
            .and_then(|sw| sw.as_object())
            .map(|o| o.iter().filter_map(|(k, val)| val.as_f64().map(|f| (k.clone(), f))).collect())
            .unwrap_or_default();
        strategies.push(PluginStrategyConfig {
            strategy_id,
            version_id,
            version,
            sha256,
            name,
            code: String::new(), // 恢复时从 strategy_version 表重取（reinstantiate_pinned）。
            params,
            stocks,
            weight,
            stock_weights,
        });
    }
    Some(PinnedSnapshotParse::Pinned(PinnedSnapshot {
        strategies,
        buy_long_threshold: buy,
        sell_threshold: sell,
    }))
}

/// 钉住配置 → 落盘快照 JSON（schema=2；code 不落盘——恢复时按 version_id 重取，单一事实源）。
fn pinned_snapshot_json(live: &LiveSession) -> serde_json::Value {
    serde_json::json!({
        "schema": 2,
        "buy_long_threshold": live.buy_long_threshold,
        "sell_threshold": live.sell_threshold,
        "strategies": live.pinned.iter().map(|c| serde_json::json!({
            "strategy_id": c.strategy_id,
            "version_id": c.version_id,
            "version": c.version,
            "sha256": c.sha256,
            "name": c.name,
            "params": strategy_params_to_json(&c.params),
            "stocks": c.stocks,
            "weight": c.weight,
            "stock_weights": c.stock_weights,
        })).collect::<Vec<_>>(),
    })
}

/// 从内存 `LiveSession` 快照构建 `SimSessionState`（重启恢复落盘）。
fn build_live_state(session_id: &str, live: &LiveSession, now: DateTime<Utc>) -> Option<SimSessionState> {
    let st = live.manager.get_state()?;
    let mut latest_prices = BTreeMap::new();
    for p in &st.positions {
        latest_prices.insert(p.code.clone(), p.latest);
    }
    let positions: Vec<SimPositionRow> = st
        .positions
        .iter()
        .map(|p| SimPositionRow {
            session_id: session_id.into(),
            code: p.code.clone(),
            qty: p.qty,
            avg_cost: p.avg_cost,
        })
        .collect();
    // P4a：钉住策略快照（schema=2 对象；含会话级阈值，恢复/回测对比同源）。
    let strategy_configs = pinned_snapshot_json(live);
    let orders = serde_json::to_value(&live.orders).unwrap_or_else(|_| serde_json::Value::Array(vec![]));
    Some(SimSessionState {
        cash: st.cash,
        realized_pnl: st.realized_pnl,
        total_fee: st.total_fee,
        positions,
        latest_prices,
        net_value_series: st.net_value_series.clone(),
        trading_enabled: live.trading_enabled,
        strategy_configs,
        orders,
        updated_at: now,
    })
}

/// 降级结果：进程重启且无可用运行态/策略不可恢复/worker 终止 → 标记 ended 的最小结束结果
/// （不打崩，get_session 不 500）。`reason` 入 net_value/metrics note（诊断留痕）。
fn degraded_result(reason: &str) -> SimSessionResult {
    SimSessionResult {
        net_value: serde_json::json!({ "series": [], "drawdown": [], "note": format!("降级 ended：{reason}") }),
        trades: serde_json::json!([]),
        metrics: serde_json::json!({ "note": format!("中断，部分数据；{reason}") }),
    }
}

/// position 注入推导（ABI §2.5）：该标的当前持仓 → `PositionInput`（空仓 → None）。
/// `entry_ts` 从成交台账按 **sticky-first-entry** 推导（自空仓以来首笔建仓 ts 钉死，
/// 部分卖出不前进、清仓重钉——与 strategy-core `Holding` 口径一致，MINOR-2）；
/// 台账缺失（异常重建）回退会话 start_ts。
fn position_input(live: &LiveSession, code: &str) -> Option<PositionInput> {
    let pos = live.manager.account.positions.get(code)?;
    if pos.qty <= 1e-9 {
        return None;
    }
    let entry_ts = current_entry_ts(live.manager.trades(), code)
        .or_else(|| live.manager.current_session().map(|s| s.start_ts))?;
    Some(PositionInput { qty: pos.qty, avg_cost: pos.avg_cost, entry_ts })
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
