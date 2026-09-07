// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/ports.rs>>[init]
//! 应用层依赖的端口（由 Infrastructure 实现，DI 注入）。

use crate::types::*;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 标注册表：手工注册的抓取集合（ADR：不跟随券商持仓）。
#[async_trait]
pub trait SymbolRegistry: Send + Sync {
    async fn enabled_codes(&self) -> anyhow::Result<Vec<Code>>;
    async fn interval_secs(&self, code: &Code) -> anyhow::Result<u64>; // 最小 60，可配置
    async fn upsert(&self, code: Code, interval_secs: u64, enabled: bool) -> anyhow::Result<()>;
}

/// K线写入：ON CONFLICT DO NOTHING（首写胜出，ADR-002）。
#[async_trait]
pub trait KlineWriter: Send + Sync {
    /// 返回实际插入行数（冲突跳过不计）。
    async fn write_batch(&self, bars: &[Bar]) -> anyhow::Result<usize>;
}

/// 健康监控：每源成功率/延迟/熔断状态（诊断系统数据源）。
#[async_trait]
pub trait HealthMonitor: Send + Sync {
    async fn report_success(&self, src: SourceId, latency_ms: u64);
    async fn report_failure(&self, src: SourceId, err_kind: &str);
    async fn health(&self, src: SourceId) -> Health;
    async fn healthy_minute_sources(&self) -> Vec<SourceId>;
    // 熔断口径：连续 3 次失败 → CircuitOpen；403/429 → 5s→10s→30s 退避（ADR-005）
}

/// 事件错误分类（03 §7 事件模型 err_kind 列口径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrKind {
    Na,             // 非交易时段/无数据（ok=true + err_kind=na，成功率分母排除）
    Timeout,
    Http,
    Parse,
    RateLimited,    // 403/429
    CircuitOpen,    // 熔断状态迁移事件
    CircuitHalfopen,
    CircuitClosed,
    ManualReset,
    AllFailed,      // code 级失败：attempt_chain 全链失败（03 §3；诊断面板缺口率之因）
    StaleData,      // 陈旧数据：抓取成功但最新 bar 落后于已到期标签（03 §3.1，Wave 2 Phase A 粘源陈旧检测）
}

impl ErrKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrKind::Na => "na", ErrKind::Timeout => "timeout", ErrKind::Http => "http",
            ErrKind::Parse => "parse", ErrKind::RateLimited => "rate_limited",
            ErrKind::CircuitOpen => "circuit_open", ErrKind::CircuitHalfopen => "circuit_halfopen",
            ErrKind::CircuitClosed => "circuit_closed", ErrKind::ManualReset => "manual_reset",
            ErrKind::AllFailed => "all_failed",
            ErrKind::StaleData => "stale_data",
        }
    }
}

/// 源健康事件（写 source_health_events，03 §7）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthEvent {
    pub ts: DateTime<Utc>,
    pub source: SourceId,
    pub ok: bool,
    pub latency_ms: Option<u32>,
    pub err_kind: Option<ErrKind>,
    pub code: Option<Code>,   // 触发标的（心跳/源级事件为空）
    pub trace_id: Option<String>,
}

/// 事件汇：source_health_events 写入端口（storage 实现；diagnose 读库消费，ADR-017 无直连）。
#[async_trait]
pub trait EventSink: Send + Sync {
    async fn emit(&self, ev: HealthEvent) -> anyhow::Result<()>;
}

/// raw 层已有 bar 读取（GapBackfiller 缺口计算输入；storage 实现）。
#[async_trait]
pub trait RawBarReader: Send + Sync {
    /// 某 code 某日（Asia/Shanghai 口径）kline_raw 已有 bar 的 ts 集合。
    async fn existing_ts(&self, code: &Code, date: chrono::NaiveDate)
        -> anyhow::Result<std::collections::HashSet<DateTime<Utc>>>;
}

/// 交易时段判定（交易日 = 工作日 ∧ ¬holidays[0008]；分钟标签口径见 domain::calendar）。
/// trait 不变量（Wave 2 Phase A 预批准范围）：仅实现替换（WeekdayCalendar → HolidayCalendar），签名不动。
pub trait TradingCalendar: Send + Sync {
    fn is_trading_now(&self) -> bool;
    fn is_trading_day(&self, date: chrono::NaiveDate) -> bool;
}

/// 时钟抽象：生产 SystemClock，测试注入 fake clock（不 sleep、确定性）。
/// 放 domain：collector（调度）与 tushare（日增量定时）跨层共用，避免 infra→app 反向依赖。
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> { Utc::now() }
}

// ── 应用面只读端口（Wave 1 Phase A 审查返工：加法扩展，不改既有契约）──
// 分层红线：web(Presentation) 不得依赖 storage，diagnose(Application) 不得依赖 sqlx；
// 与 RawBarReader/SymbolRegistry 同模式——端口在 domain，storage 实现，app bin 装配。

/// K线读模型（应用面查询行）。
/// 不复用 Bar：读模型无 period、volume 为 i64（cagg numeric 归一）、source 可空（cagg 无来源列）。
#[derive(Debug, Clone, PartialEq)]
pub struct KlineBarView {
    pub code: String,
    pub ts: DateTime<Utc>,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,             // 股
    pub amount: f64,             // 元
    pub source: Option<String>,  // 仅 1m merge 视图带来源
}

/// 注册标的 + 最新快照（读模型；last/prev_close 供涨跌幅计算）。
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolLatestView {
    pub code: String,
    pub name: Option<String>,
    pub interval_secs: i32,
    pub settlement: String,
    pub enabled: bool,
    pub last_ts: Option<DateTime<Utc>>,
    pub last_close: Option<f64>,
    pub prev_close: Option<f64>,
}

/// 健康事件读模型（source_health_events 行；diagnose 窗口聚合输入）。
/// 与写模型 HealthEvent 分立：读侧 err_kind 为裸文本（容忍库中任意取值），不背 ErrKind 枚举。
#[derive(Debug, Clone, PartialEq)]
pub struct HealthEventRow {
    pub ts: DateTime<Utc>,
    pub source: String,
    pub ok: bool,
    pub latency_ms: Option<i32>,
    pub err_kind: Option<String>,
    pub code: Option<String>,    // 触发标的（源级/心跳事件为 None）
}

/// K线只读端口（web REST/WS 数据源；storage 实现）。
#[async_trait]
pub trait KlineRead: Send + Sync {
    /// 游标分页：ts < before（None=最新起），取 limit 行，**升序**返回（图表口径）。
    async fn bars(&self, period: Period, code: &str,
                  before: Option<DateTime<Utc>>, limit: i64)
        -> anyhow::Result<Vec<KlineBarView>>;
    /// 最新一根 bar（WS 推送增量判定输入）。默认实现 = bars(.., None, 1) 取尾。
    async fn latest_bar(&self, period: Period, code: &str)
        -> anyhow::Result<Option<KlineBarView>> {
        Ok(self.bars(period, code, None, 1).await?.pop())
    }
    /// 注册表 + 最新快照。
    async fn symbols_with_latest(&self) -> anyhow::Result<Vec<SymbolLatestView>>;
}

/// 健康事件只读端口（diagnose 窗口聚合的读输入；storage 实现）。
#[async_trait]
pub trait HealthEventsRead: Send + Sync {
    /// 窗口内全部事件（ts > now() - window_secs）；无序要求（diagnose 聚合时自行归组排序）。
    async fn window_events(&self, window_secs: i64) -> anyhow::Result<Vec<HealthEventRow>>;
}

// ── Wave 1 Phase C 加法扩展：DB 控制通道端口（ADR-017：应用面只经 DB 影响数据面）──
// 与 Phase A 只读端口同模式：端口在 domain，storage 实现，app bin 装配，web/collector 只依赖端口。

/// 标的管理注册输入（POST /api/symbols；字段校验已在 web 层完成——
/// code 6 位数字+市场前缀、interval_secs≥60、settlement∈{T0,T1}，与 schema CHECK 同口径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolAdminInput {
    pub code: String,
    pub name: Option<String>,     // 服务端不反查行情源（ADR-017 无数据面直连），可空，可后续 PATCH 补
    pub interval_secs: i32,
    pub settlement: String,       // "T0" | "T1"
    pub enabled: bool,
}

/// 标的编辑补丁（PATCH /api/symbols/{code}；None = 该字段不改）。
/// code 主键不可改（03-symbols §3：改 code = 停用旧 + 注册新）；无物理删除（仅 enabled=false 停用）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SymbolPatch {
    pub name: Option<String>,
    pub interval_secs: Option<i32>,
    pub settlement: Option<String>,
    pub enabled: Option<bool>,
}

/// 标的管理写端口（应用面 POST/PATCH /api/symbols；storage 实现）。
/// 写 symbols 表即控制通道：数据面 Scheduler 每周期重读热生效，无需任何直连。
#[async_trait]
pub trait SymbolAdminWrite: Send + Sync {
    /// 注册；code 已存在 → Ok(false)（web 层映射 409）。
    async fn register(&self, input: &SymbolAdminInput) -> anyhow::Result<bool>;
    /// 编辑；code 不存在 → Ok(false)（web 层映射 404）。间隔修改下一采集周期热生效。
    async fn update(&self, code: &str, patch: &SymbolPatch) -> anyhow::Result<bool>;
}

/// 标的当日采集统计读模型（页面③ symbol-table「今日已采 bar 数/最新 bar 时刻」列）。
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolStatView {
    pub code: String,
    pub today_bars: i64,                   // 当日（Asia/Shanghai 日界）kline_raw 行数
    pub last_bar_ts: Option<DateTime<Utc>>,
}

/// 标的采集统计只读端口（GET /api/symbols?with_stats=1；storage 实现）。
#[async_trait]
pub trait SymbolStatsRead: Send + Sync {
    /// 当日（Asia/Shanghai 日界）kline_raw 每 code bar 数与最新 ts；无 bar 的 code 不出现。
    async fn today_stats(&self) -> anyhow::Result<Vec<SymbolStatView>>;
}

/// 熔断复位请求（DB 控制通道 circuit_reset_requests 行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetRequest {
    pub id: i64,
    pub source: String,                    // SourceId::as_str 口径文本；未知源由消费端跳过
}

/// 熔断复位写端口（应用面 POST /api/sources/{id}/reset；storage 实现）。
/// 仅插入请求行；实际复位由数据面 ResetWatcher 消费后执行（事件仍由数据面单写者发出）。
#[async_trait]
pub trait CircuitResetWrite: Send + Sync {
    async fn request_reset(&self, source: &str) -> anyhow::Result<()>;
}

/// 熔断复位消费端口（数据面 collector::reset::ResetWatcher；storage 实现）。
/// 原子取出并标记消费（UPDATE ... RETURNING），避免多实例/重试重复触发。
#[async_trait]
pub trait CircuitResetChannel: Send + Sync {
    async fn take_pending(&self) -> anyhow::Result<Vec<ResetRequest>>;
}

// ── Wave 2 Phase A 加法扩展：数据质量 / 交易日历只读端口（页面④ + MCP④；07-app-plane §2 口径）──
// 与 Wave 1 同模式：端口在 domain，storage 实现，app bin 装配，diagnose/mcp/web 只依赖端口。

/// raw vs accurate 对照行（同 code+ts 的 M1 双侧收盘）。
/// amount 不参与比对——D4 结案（2026-09-04 实盘查证）：两层 amount 规范口径均为元，
/// 但 tencent_ifzq raw 行 amount 不可信且比值不恒定，无法换算（04-storage §4.4 注记 7）。
#[derive(Debug, Clone, PartialEq)]
pub struct DivergenceRow {
    pub ts: DateTime<Utc>,
    pub code: String,
    pub raw_close: f64,
    pub accurate_close: f64,
    pub raw_source: Option<String>,
}

/// 质量对照只读端口（diagnose::quality::QualityService 输入；storage 实现）。
#[async_trait]
pub trait QualityRead: Send + Sync {
    /// [from, to) 内 raw ⋈ accurate(M1) 双侧行（code=None 全标的；ts 升序）。
    async fn divergence_rows(&self, code: Option<&str>, from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<DivergenceRow>>;
}

/// 节假日只读端口（0008 holidays 表；collector HolidayCalendar 刷新与 diagnose 缺口报告共用）。
#[async_trait]
pub trait HolidayCalendarRead: Send + Sync {
    /// 全表快照（小表，年度数十行）。
    async fn holidays(&self) -> anyhow::Result<std::collections::HashSet<chrono::NaiveDate>>;
}

/// 健康事件区间只读端口（质量缺口分类输入；与 HealthEventsRead 窗口口径分立——
/// 缺口报告需历史任意闭开区间 [from, to)，非 now() 相对窗口）。
#[async_trait]
pub trait HealthEventsRangeRead: Send + Sync {
    /// [from, to) 内全部事件（ts 升序）。
    async fn events_between(&self, from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<HealthEventRow>>;
}

/// tushare 同步检查点读模型（sync_checkpoints 行，0005）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncCheckpointView {
    pub code: String,
    pub period: String,
    pub last_synced_date: chrono::NaiveDate,
    pub updated_at: DateTime<Utc>,
}

/// tushare 同步状态只读端口（页面④ sync-panel GET /api/tushare/status；storage 实现）。
#[async_trait]
pub trait TushareStatusRead: Send + Sync {
    async fn sync_checkpoints(&self) -> anyhow::Result<Vec<SyncCheckpointView>>;
}

// ── Wave 2 Phase B 加法扩展：告警引擎端口（页面⑦ 告警中心；07-alerts.md 定稿）──
// 与 Phase A/C 同模式：端口在 domain，storage 实现，app bin 装配；
// alert crate（Application 层，与 diagnose 并列）注入以下端口做评估与持久化。
// 通知渠道 = 仅页面⑦ + WS 推送（用户定稿 2026-09-04），无站外 webhook。

/// 告警级别（07-alerts §4 分级定稿）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertLevel { Info, Warning, Critical }

impl AlertLevel {
    pub fn as_str(&self) -> &'static str {
        match self { AlertLevel::Info => "info", AlertLevel::Warning => "warning", AlertLevel::Critical => "critical" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s { "info" => Some(AlertLevel::Info), "warning" => Some(AlertLevel::Warning),
                  "critical" => Some(AlertLevel::Critical), _ => None }
    }
}

/// 告警生命周期状态机（07-alerts §5）：触发 triggered → 确认 acked → 恢复 resolved
/// （triggered → resolved 直转合法：条件消失自动恢复，无需先确认）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertStatus { Triggered, Acked, Resolved }

impl AlertStatus {
    pub fn as_str(&self) -> &'static str {
        match self { AlertStatus::Triggered => "triggered", AlertStatus::Acked => "acked", AlertStatus::Resolved => "resolved" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s { "triggered" => Some(AlertStatus::Triggered), "acked" => Some(AlertStatus::Acked),
                  "resolved" => Some(AlertStatus::Resolved), _ => None }
    }
}

/// 告警规则（内置首批 + 页面仅可调阈值/开关/静默时长，07-alerts §3；无自由规则编辑器）。
/// threshold 语义按规则 id 约定（02-alerts.md §2）：成功率下限(0-1) / 缺口率% / 停摆分钟数 / 未用。
#[derive(Debug, Clone, PartialEq)]
pub struct AlertRule {
    pub id: String,               // 内置规则 slug（source_success_rate / symbol_gap_rate / ...）
    pub name: String,
    pub level: AlertLevel,
    pub threshold: f64,
    pub duration_minutes: i64,    // 评估窗口/持续时长（分钟；0=瞬时判定）
    pub silence_minutes: i64,     // 静默期：同 rule+source 静默期内不再触发/续触发
    pub enabled: bool,
}

/// 规则补丁（PATCH /api/alert-rules；None = 不改；仅这三项可调）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AlertRulePatch {
    pub threshold: Option<f64>,
    pub enabled: Option<bool>,
    pub silence_minutes: Option<i64>,
}

/// 告警事件读模型（alert_events 行；聚合防刷屏单元 = 同 rule+source 未恢复事件一条）。
#[derive(Debug, Clone, PartialEq)]
pub struct AlertEvent {
    pub id: i64,
    pub rule_id: String,
    pub level: AlertLevel,
    pub source: String,           // 来源：源ID / 标的 code / 系统组件（如 collector / tushare）
    pub message: String,
    pub status: AlertStatus,
    pub fire_count: i64,          // 聚合触发计数（07-alerts §5）
    pub first_fired_at: DateTime<Utc>,
    pub last_fired_at: DateTime<Utc>,
    pub acked_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
}

/// 告警列表过滤（GET /api/alerts?level=&from=&to=&source=；last_fired_at 口径）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AlertFilter {
    pub level: Option<AlertLevel>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub source: Option<String>,
    pub limit: i64,               // web 层钳制 1..=1000，默认 200
}

/// 告警评估只读端口（alert crate 1min 评估节拍输入；storage 实现，ADR-017 应用面只读库）。
/// 与 HealthEventsRead 分立：显式 since 参数（fake clock 确定性测试），且支持单源最近事件查询。
#[async_trait]
pub trait AlertEvalRead: Send + Sync {
    /// since 之后的健康事件（成功率/停摆判定输入；无序要求，alert 聚合时自行归组）。
    async fn events_since(&self, since: DateTime<Utc>) -> anyhow::Result<Vec<HealthEventRow>>;
    /// 指定源最近一条事件（tushare 日增量失败判定；无事件 → None）。
    async fn latest_event_of(&self, source: &str) -> anyhow::Result<Option<HealthEventRow>>;
}

/// 告警持久化端口（alert_rules / alert_events，0009 迁移；应用面自有表，写不违 ADR-017——
/// 与 circuit_reset_requests 同口径：表属应用面，数据面不读）。
/// 状态机转移由 alert crate 决策，本端口只提供原子原语。
#[async_trait]
pub trait AlertStore: Send + Sync {
    /// 全部规则（评估节拍每轮重读 → 阈值/开关/静默时长热生效）。
    async fn list_rules(&self) -> anyhow::Result<Vec<AlertRule>>;
    /// 规则调整；未知 id → Ok(None)（web 映射 404）。
    async fn patch_rule(&self, id: &str, patch: &AlertRulePatch) -> anyhow::Result<Option<AlertRule>>;
    /// 未恢复（resolved_at IS NULL）的聚合事件（同 rule+source 至多一条）。
    async fn open_incident(&self, rule_id: &str, source: &str) -> anyhow::Result<Option<AlertEvent>>;
    /// 同 rule+source 最近一次触发时刻（含已恢复；静默期判定输入，抑制抖动反复新建）。
    async fn last_fired_at(&self, rule_id: &str, source: &str) -> anyhow::Result<Option<DateTime<Utc>>>;
    /// 新建事件（status=triggered，fire_count=1，first/last_fired_at=now）。
    async fn insert_incident(&self, rule_id: &str, level: AlertLevel, source: &str,
                             message: &str, now: DateTime<Utc>) -> anyhow::Result<AlertEvent>;
    /// 续触发：fire_count+1、last_fired_at=now；若已 acked → 回退 triggered 并清 acked_at
    /// （新活动需重新确认，未确认高亮）；未知 id → Ok(None)。
    async fn refire(&self, id: i64, now: DateTime<Utc>) -> anyhow::Result<Option<AlertEvent>>;
    /// 恢复：status→resolved、resolved_at=now（幂等：已恢复/未知 → Ok(None)）。
    async fn resolve(&self, id: i64, now: DateTime<Utc>) -> anyhow::Result<Option<AlertEvent>>;
    /// 确认：仅 triggered → acked 并记录 acked_at；其余（已确认/已恢复/未知）→ Ok(None)
    /// （web 映射 404：无可确认对象）。
    async fn ack(&self, id: i64, now: DateTime<Utc>) -> anyhow::Result<Option<AlertEvent>>;
    /// 列表（last_fired_at 降序；过滤条件 Option 全 None = 全量按 limit 截断）。
    async fn list_events(&self, filter: &AlertFilter) -> anyhow::Result<Vec<AlertEvent>>;
}

// ── 页面⑧ 系统设置 S1（08-settings.md §6）：系统信息/运维端点端口（storage 实现）──
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，web 只依赖端口。

/// 系统信息只读端口（GET /api/system/info 的 db_ok：SELECT 1 保活探测；storage 实现）。
#[async_trait]
pub trait SystemInfoRead: Send + Sync {
    /// SELECT 1；Err → db_ok=false（进程在线但 DB 断开以状态字段表达，非错误态）。
    async fn ping(&self) -> anyhow::Result<()>;
}

/// raw 层清空端口（POST /api/system/purge-raw；storage 实现；危险操作——confirm 校验在 web 层）。
#[async_trait]
pub trait RawPurgePort: Send + Sync {
    /// 执行 DELETE FROM kline_raw；返回受影响（清理）行数。
    async fn purge_raw(&self) -> anyhow::Result<u64>;
}

// ── Wave 3 Phase 3a：回测端口（ADR 08-backtest §2；engine 为纯逻辑 backtest crate，无 IO/DB──
// 本块为数据/应用面端口：storage 实现 BacktestBarRead/BacktestRunStore，application 层实现 BacktestProgressSink）──
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，web/application 只依赖端口。
// ⚠️ Bar 类型归属：端口返回 domain::types::Bar（storage 直接产）；application 层（Phase 3b）负责
// domain::Bar -> backtest::Bar 映射（backtest crate 刻意不依赖 domain，见 crates/backtest/src/types.rs 注释）。

/// 回测运行状态（backtest_runs.status：pending/running/done/failed）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus { Pending, Running, Done, Failed }

impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        match self { RunStatus::Pending => "pending", RunStatus::Running => "running",
                     RunStatus::Done => "done", RunStatus::Failed => "failed" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s { "pending" => Some(RunStatus::Pending), "running" => Some(RunStatus::Running),
                  "done" => Some(RunStatus::Done), "failed" => Some(RunStatus::Failed), _ => None }
    }
}

/// 新建回测运行（POST /api/backtest/runs 输入经 web 层校验解析后；params 为网格展开后单点）。
/// B1 增补：持久化初始资金与回测区间（initial_capital/date_from/date_to，迁移 0012）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewRun {
    pub code: String,
    pub period: String,           // M1/M5/M15/D1（回测支持周期）
    pub strategy_id: String,      // builtin 策略 slug
    pub params: serde_json::Value,
    pub fee: serde_json::Value,   // {rate_pct,min_fee,slippage_bp}
    pub initial_capital: f64,     // 初始资金（默认 100_000，ADR §4）
    pub date_from: DateTime<Utc>, // 区间起点（闭）
    pub date_to: DateTime<Utc>,   // 区间终点（开，[from, to) 半开）
    pub group_id: Option<String>,
}

/// 回测运行列表过滤（GET /api/backtest/runs）。limit/offset 分页（默认 limit=100/offset=0）；
/// ⚠️ 列表走轻量 SELECT（run LEFT JOIN 结果拆出去），`limit` 应始终设正数以约束单页行数。
#[derive(Debug, Clone, PartialEq)]
pub struct RunFilter {
    pub status: Option<RunStatus>,
    pub group_id: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

impl Default for RunFilter {
    fn default() -> Self {
        Self { status: None, group_id: None, limit: 100, offset: 0 }
    }
}

/// 回测结果（backtest_results 三 jsonb 列聚合）。application 层把 backtest::BacktestResult 拆分写入。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunResult {
    pub net_value: serde_json::Value,   // 净值/回撤序列
    pub trades: serde_json::Value,      // 交易明细
    pub metrics: serde_json::Value,     // 8 项绩效指标
}

/// 回测运行读模型（含结果；result=None 表示未完成为 done）。
/// B1 增补：initial_capital/date_from/date_to 持久化（迁移 0012）；前端把 date_from~date_to 展示为区间。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunView {
    pub id: i64,
    pub code: String,
    pub period: String,
    pub strategy_id: String,
    pub params: serde_json::Value,
    pub fee: serde_json::Value,
    pub initial_capital: f64,     // 初始资金（ADR §4 默认 100_000）
    pub date_from: DateTime<Utc>, // 区间起点（闭）
    pub date_to: DateTime<Utc>,   // 区间终点（开，[from, to) 半开）
    pub status: RunStatus,
    pub progress: i32,             // 0-100
    pub current_ts: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub group_id: Option<String>,
    pub result: Option<RunResult>,
}

/// 回测 K线读取端口（storage 实现）。统一读源 = accurate 优先 + cagg 兜底（ADR-003 推广），
/// 复用 KlineReader 口径（period 对应 accurate/cagg 表映射）。返回 [from, to) 区间 bar，ts 升序。
/// 返回 domain::Bar；application 层映射为 backtest::Bar（ADR 08-backtest §3）。
#[async_trait]
pub trait BacktestBarRead: Send + Sync {
    async fn bars(&self, code: &str, period: &Period, from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<Bar>>;
}

/// 回测运行存储端口（storage 实现；backtest_runs/backtest_results，迁移 0011）。
/// create_run 写 pending 行并回 id；mark_done 写结果（3 列）+ 置 done；list/get 读联表。
/// ⚠️ 审查修正（Phase 3b 申请）：create_run 由 `&mut self` 改为 `&self` —— storage `PgBacktestStore::create_run`
/// 内部只读 `&self.pool`，无状态变异；此签名与 ports 全文件其余端口一致，避免 application 层为并发共享 store
/// 引入 `Arc<Mutex<...>>` 包装。父级已批准（2026-xx）。
#[async_trait]
pub trait BacktestRunStore: Send + Sync {
    async fn create_run(&self, run: &NewRun) -> anyhow::Result<i64>;
    async fn update_run_progress(&self, id: i64, pct: i32, ts: DateTime<Utc>) -> anyhow::Result<()>;
    async fn mark_done(&self, id: i64, result: &RunResult) -> anyhow::Result<()>;
    async fn mark_failed(&self, id: i64, err: &str) -> anyhow::Result<()>;
    async fn list_runs(&self, filter: &RunFilter) -> anyhow::Result<Vec<RunView>>;
    async fn get_run(&self, id: i64) -> anyhow::Result<Option<RunView>>;
    /// 删除 run（`backtest_results` 由 FK ON DELETE CASCADE 级联删除）。
    /// 返回 true=删了行；false=id 不存在（web 映射 404）。B1 增。
    async fn delete_run(&self, id: i64) -> anyhow::Result<bool>;
}

/// 回测进度推送端口（web/application 实现；WS `{type:"backtest_progress", run_id, pct, bar_ts}`）。
#[async_trait]
pub trait BacktestProgressSink: Send + Sync {
    async fn send(&self, run_id: i64, pct: i32, bar_ts: Option<DateTime<Utc>>) -> anyhow::Result<()>;
}

// ── Wave 3 页面① 看板收藏（置顶+排序）端口（用户定稿 2026-09-05；favorite_symbols 表，迁移 0013）──
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，web 只依赖端口。
// 仅影响 /api/symbols 的 symbol-list 展示（应用面自有表，数据面不读写，ADR-017 不违）。

/// 收藏项（favorite_symbols 行：code + sort_order）。sort_order 起点 1（首个收藏=1）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FavoriteItem {
    pub code: String,
    pub sort_order: i32,
}

/// 看板收藏端口（storage 实现；favorite_symbols 表，迁移 0013）。
/// 一键收藏=自动置顶（star → sort_order=max+1）；已存在幂等（star 再次调用无副作用）。
/// 取消收藏无行幂等（unstar 未知/已取消 → Ok）；标的不存在由 web 层校验映射 404。
#[async_trait]
pub trait FavoriteStore: Send + Sync {
    /// 全量收藏（code + sort_order，按 sort_order 升序）。
    async fn list_favorites(&self) -> anyhow::Result<Vec<FavoriteItem>>;
    /// 收藏（自动置顶：sort_order = max+1；已存在 → 幂等 Ok，不重复插入）。
    async fn star(&self, code: &str) -> anyhow::Result<()>;
    /// 取消收藏（不存在 → 幂等 Ok）。
    async fn unstar(&self, code: &str) -> anyhow::Result<()>;
    /// 批量重排（sort_order = 索引；入参须为当前已收藏 code 子集，web 层校验 400——
    /// 经 favorite_map 预检所有 code 均已在收藏集合，再提交事务内重排）。
    async fn reorder(&self, codes: &[String]) -> anyhow::Result<()>;
    /// code→sort_order 映射（/api/symbols 展示用：非收藏不在 map）。
    async fn favorite_map(&self) -> anyhow::Result<std::collections::HashMap<String, i32>>;
}

// ── 行情看板 MA 可配置（后端 W1；ma_config 表，迁移 0015；用户定稿 2026-09-06）──
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，web 只依赖端口。
// 仅看板主图+宫格应用 MA 窗口配置；回测弹窗不动（回测周期/参数不扩展）。

// MA 窗口配置（ma_config 单行：ma_windows int[]）。约定：归一化升序 + 去重，默认 [5,10,20]（前端硬编码改由 DB 持久化配置驱动）。

/// MA 配置端口（storage 实现；ma_config 表，迁移 0015）。
/// get：读当前配置（表未初始化/空 → 默认 [5,10,20]）；set：web 层已校验 + 归一化升序去重，
/// 层内直接写回并返回归一化后的窗口列表。
#[async_trait]
pub trait MaConfigStore: Send + Sync {
    /// 读当前 MA 窗口配置（升序去重归一化；表空 → 默认 [5,10,20]）。
    async fn get(&self) -> anyhow::Result<Vec<i32>>;
    /// 写回归一化后的 MA 窗口配置（升序去重），返回写回后的窗口列表。
    async fn set(&self, windows: &[i32]) -> anyhow::Result<Vec<i32>>;
}

// ── 11-sim-live / L1：模拟实盘会话存储端口（simsession/sim_session_result/sim_trades/sim_positions，迁移 0018）──
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，mcp/web/application 只依赖端口。
// 应用面自有表（数据面不读写，ADR-017 不违）；会话状态 running/ended 状态机（ADR 11-sim-live §3/§9）。

/// 模拟实盘会话状态（simsession.status：running/ended）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimSessionStatus { Running, Ended }

impl SimSessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self { SimSessionStatus::Running => "running", SimSessionStatus::Ended => "ended" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s { "running" => Some(SimSessionStatus::Running), "ended" => Some(SimSessionStatus::Ended), _ => None }
    }
}

/// 新建会话（传入；id 由应用层生成后入库）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewSimSession {
    pub id: String,
    pub name: String,
    pub cash_init: f64,
    pub strategy_set: Vec<String>,
    pub stock_set: Vec<String>,
    pub period: String,
    pub start_ts: DateTime<Utc>,
    pub source: String,
}

/// 会话读模型（simsession 行；session 元数据，无结果 JSON）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimSessionView {
    pub id: String,
    pub name: String,
    pub cash_init: f64,
    pub strategy_set: Vec<String>,
    pub stock_set: Vec<String>,
    pub period: String,
    pub start_ts: DateTime<Utc>,
    pub end_ts: Option<DateTime<Utc>>,
    pub status: SimSessionStatus,
    pub source: String,
}

/// 新成交明细（sim_trades 行）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewSimTrade {
    pub session_id: String,
    pub code: String,
    pub side: String,
    pub qty: f64,
    pub price: f64,
    pub ts: DateTime<Utc>,
    pub fee: f64,
    pub source: String,
}

/// 会话内持仓行（sim_positions 行；code/qty/avg_cost，可重建）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimPositionRow {
    pub session_id: String,
    pub code: String,
    pub qty: f64,
    pub avg_cost: f64,
}

/// 会话结束结果（simsession_result 三 jsonb 列；结构=backtest_result）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimSessionResult {
    pub net_value: serde_json::Value,
    pub trades: serde_json::Value,
    pub metrics: serde_json::Value,
}

/// 模拟实盘会话存储端口（storage 实现；simsession 等表，迁移 0018）。
/// 会话运行期间应用面内存维护 + 事件流落库；`mark_end` 置 ended + 写结果（幂等重写）。
#[async_trait]
pub trait SimSessionStore: Send + Sync {
    /// 新建会话（running；返回 ()，id 已由调用方生成）。
    async fn create_session(&self, s: &NewSimSession) -> anyhow::Result<()>;
    /// 读单会话元数据；未知 id → Ok(None)。
    async fn get_session(&self, id: &str) -> anyhow::Result<Option<SimSessionView>>;
    /// 会话列表（start_ts DESC）。
    async fn list_sessions(&self) -> anyhow::Result<Vec<SimSessionView>>;
    /// 追加一条成交明细。
    async fn append_trade(&self, t: &NewSimTrade) -> anyhow::Result<()>;
    /// 覆盖式写会话内持仓（全量，幂等）。
    async fn update_positions(&self, session_id: &str, positions: &[SimPositionRow]) -> anyhow::Result<()>;
    /// 结束会话：置 ended + end_ts + 结果；返回是否更新到行（未知 id → false）。
    async fn mark_end(&self, session_id: &str, end_ts: DateTime<Utc>, result: &SimSessionResult) -> anyhow::Result<bool>;
    /// 读会话结束结果（simsession_result）；未知/未结束 → Ok(None)。
    /// L3：会话回看（sim_get_session）/回测对比需要取回结果 JSON。
    async fn get_result(&self, session_id: &str) -> anyhow::Result<Option<SimSessionResult>>;
    /// 删除会话（FK 级联结果/成交/持仓）；返回是否删行。
    async fn delete_session(&self, session_id: &str) -> anyhow::Result<bool>;
}
// ~/~ end
