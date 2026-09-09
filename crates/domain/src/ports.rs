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

// ── 回测 K 线读取端口（ADR 08-backtest §2；engine 为纯逻辑 backtest crate，无 IO/DB）──
// P4b（D16 终章，12-strategy-system §13.8）：旧回测运行存储/进度端口（BacktestRunStore/BacktestProgressSink
// + RunStatus/NewRun/RunFilter/RunResult/RunView）随旧 BacktestService 链物理删除；BacktestBarRead 保留——
// 新系统（strategy 试算 / workbench 工作台 / mcp bt_* 工具）复用同一取数端口。
// ⚠️ Bar 类型归属：端口返回 domain::types::Bar（storage 直接产）；application 层负责
// domain::Bar -> backtest::Bar 映射（backtest crate 刻意不依赖 domain，见 crates/backtest/src/types.rs 注释）。

/// 回测 K线读取端口（storage 实现）。统一读源 = accurate 优先 + cagg 兜底（ADR-003 推广），
/// 复用 KlineReader 口径（period 对应 accurate/cagg 表映射）。返回 [from, to) 区间 bar，ts 升序。
/// 返回 domain::Bar；application 层映射为 backtest::Bar（ADR 08-backtest §3）。
#[async_trait]
pub trait BacktestBarRead: Send + Sync {
    async fn bars(&self, code: &str, period: &Period, from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<Bar>>;
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

// ── 页面⑧ 系统设置 S2：配置持久化端口（app_config 表，迁移 0021）──
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，web 只依赖端口。
// 应用面自有表（数据面不读写，ADR-017 不违）。存 sources/collector/mcp 三块配置，value 为 jsonb；
// 缺值由 web 层回退 SETTINGS_DEFAULTS 默认（内置源参数 / 60s / 交易工具关 / 50000·20 等）。

/// 配置持久化端口（storage 实现；app_config 表：key text PK + value jsonb）。
/// get：按 key 读配置值（表空/无该 key → None，由 web 层回退默认）；
/// set：写/覆盖 key 的配置值（INSERT ... ON CONFLICT DO UPDATE, updated_at=now()）。
/// 键名约定："sources" / "collector" / "mcp"。
#[async_trait]
pub trait ConfigStore: Send + Sync {
    /// 按 key 读配置值；缺失 → Ok(None)。
    async fn get(&self, key: &str) -> anyhow::Result<Option<serde_json::Value>>;
    /// 写/覆盖 key 的配置值（跨 key 独立；updated_at=now()）。
    async fn set(&self, key: &str, value: serde_json::Value) -> anyhow::Result<()>;
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

/// 会话**运行态快照**（重启恢复字段；持久化到 `simsession_state.state_json`，迁移 0019）。
/// 与 `simsession`（元数据/状态机）分层：本结构捕获应用面内存态（现金/持仓/净值序列/策略配置/订单/开关），
/// 供进程重启后重建 SessionManager/编排器**续跑**。中间结果（净值/持仓/PnL）随每次变更实时落盘。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimSessionState {
    pub cash: f64,
    pub realized_pnl: f64,
    /// 累计费用（佣金 + 印花税）。
    pub total_fee: f64,
    /// 持仓（code/qty/avg_cost；`latest` 经 `latest_prices` 还原）。
    pub positions: Vec<SimPositionRow>,
    /// 各持仓标的最新价（重建 position.latest/market_value/unrealized_pnl）。
    pub latest_prices: std::collections::BTreeMap<String, f64>,
    /// 运行期净值序列 `(ts, equity)`。
    pub net_value_series: Vec<(i64, f64)>,
    /// 统一交易开关键（重建 LiveSession.trading_enabled）。
    pub trading_enabled: bool,
    /// 钉住策略快照 JSON（P4a 切源后 schema=2 对象：`{schema, buy_long_threshold, sell_threshold,
    /// strategies: [{strategy_id, version_id, version, sha256, name, params, stocks, weight,
    /// stock_weights}]}`；code 不落盘——恢复时按 version_id 从 strategy_version 表重取）。
    /// 切源前旧形状（内建策略 id 数组）已不可恢复（恢复时降级 ended）。
    pub strategy_configs: serde_json::Value,
    /// 订单 JSON 数组（历史/挂单；重建 orders 面板）。
    pub orders: serde_json::Value,
    /// 上次落盘时间（诊断/幂等用）。
    pub updated_at: DateTime<Utc>,
}

/// 模拟实盘会话存储端口（storage 实现；simsession 等表，迁移 0018/0019）。
/// 会话运行期间应用面内存维护 + 事件流落库；`mark_end` 置 ended + 写结果（幂等重写）。
/// 重启恢复：应用层启动时对 `status='running'` 会话读 `get_state` 重建内存态续跑（`recover_sessions`）。
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
    /// 读会话成交明细（ts 升序；恢复重建用）。
    async fn list_trades(&self, session_id: &str) -> anyhow::Result<Vec<NewSimTrade>>;
    /// 覆盖式写会话内持仓（全量，幂等）。
    async fn update_positions(&self, session_id: &str, positions: &[SimPositionRow]) -> anyhow::Result<()>;
    /// 实时落盘会话运行态（upsert 幂等：存在则覆盖，含 updated_at）。
    async fn upsert_state(&self, session_id: &str, state: &SimSessionState) -> anyhow::Result<()>;
    /// 读会话运行态；未知/未落盘 → Ok(None)。
    async fn get_state(&self, session_id: &str) -> anyhow::Result<Option<SimSessionState>>;
    /// 结束会话：置 ended + end_ts + 结果；返回是否更新到行（未知 id → false）。
    async fn mark_end(&self, session_id: &str, end_ts: DateTime<Utc>, result: &SimSessionResult) -> anyhow::Result<bool>;
    /// 读会话结束结果（simsession_result）；未知/未结束 → Ok(None)。
    /// L3：会话回看（sim_get_session）/回测对比需要取回结果 JSON。
    async fn get_result(&self, session_id: &str) -> anyhow::Result<Option<SimSessionResult>>;
    /// 删除会话（FK 级联结果/成交/持仓）；返回是否删行。
    async fn delete_session(&self, session_id: &str) -> anyhow::Result<bool>;
}

// ── 12-strategy-system / P2a+P2b：Strategy Registry 存储端口（strategy/strategy_version 表，迁移 0022）──
// P2b 加法（架构裁决 A/A）：manage_list（管理列表聚合）/ update_meta（元数据更新）+ ManageItem DTO。
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，web/application 只依赖端口。
// 应用面自有表（数据面不读写，ADR-017 不违）。
// 状态机 draft→published→archived 由 application 层经 `domain::strategy_state` 纯函数校验；
// published 不可变由 DB BEFORE UPDATE/DELETE trigger 双保险（04-storage §4.3.13）。

use crate::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};

/// 策略元数据行（strategy 表；一等资源，ADR 12 §5）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: StrategyKind,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 策略版本行（strategy_version 表；code + params_schema + sha256 寻址，ABI G4）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyVersionRow {
    pub id: String,
    pub strategy_id: String,
    pub version: i32,
    pub code: String,
    pub params_schema: serde_json::Value,
    pub sha256: String,
    pub status: StrategyStatus,
    pub approval_level: ApprovalLevel,
    pub created_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
}

/// 新建策略（id 由应用层生成后传入，st_<ts>_<seq> 口径）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewStrategy {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: StrategyKind,
    pub created_by: String,
}

/// 新建版本（id 由应用层生成，sv_<ts>_<seq>；status 由存储默认 draft，approval_level 默认 backtest_ok）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewStrategyVersion {
    pub id: String,
    pub strategy_id: String,
    pub version: i32,
    pub code: String,
    pub params_schema: serde_json::Value,
    pub sha256: String,
}

/// catalog 条目（策略 + 其最新 published 版本；消费方下拉数据源，ADR §5 catalog 接口）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub strategy: StrategyRow,
    pub version: StrategyVersionRow,
}

// ── P2b：manage 管理列表 DTO（GET /api/strategies/manage；契约与前端锁定，字段序即 wire 序）──

/// manage 条目 latest_version 槽位（版本号最大版本，**任意状态**；策略零版本 → None）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyManageVersionSummary {
    pub id: String,
    pub version: i32,
    pub status: StrategyStatus,
    pub approval_level: ApprovalLevel,
    pub sha256: String,
    pub created_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
}

/// manage 条目 latest_published 槽位（最新 published 版本；无 published → None）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyManagePublishedSummary {
    pub id: String,
    pub version: i32,
    pub approval_level: ApprovalLevel,
}

/// manage 列表条目（含全部策略——仅 draft / 零版本策略亦在列，与 catalog 仅 published 不同）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyManageItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: StrategyKind,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// 版本总数（任意状态）。
    pub version_count: i64,
    pub latest_version: Option<StrategyManageVersionSummary>,
    pub latest_published: Option<StrategyManagePublishedSummary>,
}

/// 策略 Registry 存储端口（storage 实现；strategy/strategy_version 表，迁移 0022）。
/// 流转合法性由 application 层校验（domain::strategy_state），本端口只提供原子原语；
/// published 不可变由 DB trigger 兜底（直接改库也会被拦）。
#[async_trait]
pub trait StrategyStore: Send + Sync {
    /// 新建策略元数据行。
    async fn create_strategy(&self, s: &NewStrategy) -> anyhow::Result<StrategyRow>;
    /// 读策略；未知 id → Ok(None)（web 映射 404）。
    async fn get_strategy(&self, id: &str) -> anyhow::Result<Option<StrategyRow>>;
    /// 策略总数（启动播种「表为空」判定输入）。
    async fn count_strategies(&self) -> anyhow::Result<i64>;
    /// catalog：每策略取**最新 published 版本**；`level` 为 at-least 语义（权限分级阶梯：
    /// backtest_ok ≤ sim_ok ≤ live_approved，live_approved 通过一切过滤），`kind` 精确匹配；
    /// 仅 published 版本入册（draft/archived 不出现）。按 strategy.id 升序。
    async fn catalog(&self, level: Option<ApprovalLevel>, kind: Option<StrategyKind>)
        -> anyhow::Result<Vec<CatalogEntry>>;
    /// 新建 draft 版本（status='draft'、approval_level='backtest_ok' 默认）。
    async fn create_version(&self, v: &NewStrategyVersion) -> anyhow::Result<StrategyVersionRow>;
    /// 读版本；未知 id → Ok(None)。
    async fn get_version(&self, id: &str) -> anyhow::Result<Option<StrategyVersionRow>>;
    /// 播种幂等探测：按「策略 name + 版本 sha256」查版本（存在则跳过该款播种）。
    async fn find_version_by_name_sha(&self, name: &str, sha256: &str)
        -> anyhow::Result<Option<StrategyVersionRow>>;
    /// 某策略全部版本（version 升序）。
    async fn list_versions(&self, strategy_id: &str) -> anyhow::Result<Vec<StrategyVersionRow>>;
    /// 下一版本号 = max(version)+1；无版本 → 1。
    async fn next_version_number(&self, strategy_id: &str) -> anyhow::Result<i32>;
    /// 原地更新 draft 代码（code/params_schema/sha256）；仅 status='draft' 生效，
    /// 非 draft / 未知 id → Ok(None)（application 层据此走自动新 draft 或 409）。
    async fn update_draft(&self, id: &str, code: &str, params_schema: &serde_json::Value, sha256: &str)
        -> anyhow::Result<Option<StrategyVersionRow>>;
    /// 发布定格：draft→published，写入最终 sha256/params_schema/published_at。
    /// **乐观并发（TOCTOU 防护）**：`WHERE id=$1 AND status='draft' AND code=$expected_code`——
    /// `expected_code` 为 application 层冒烟通过的 code 原文；0 行命中（未知 id / 状态已漂移 /
    /// code 被并发改写）→ `Ok(None)`（application 映射 409，版本保持 draft）。
    async fn mark_published(&self, id: &str, expected_code: &str, sha256: &str,
                            params_schema: &serde_json::Value,
                            published_at: DateTime<Utc>) -> anyhow::Result<Option<StrategyVersionRow>>;
    /// 通用状态写（archive 用：published→archived）；未知 id → Ok(None)。
    /// 流转合法性由 application 层经 strategy_state 校验后调用。
    async fn set_status(&self, id: &str, status: StrategyStatus)
        -> anyhow::Result<Option<StrategyVersionRow>>;
    // ── P2b：manage 管理端点原语 ──
    /// 管理列表：**全部策略（含仅 draft / 零版本）**，`kind` 精确匹配过滤（None=不过滤）；
    /// 每条目聚合 version_count（版本总数）/ latest_version（版本号最大版本，任意状态）/
    /// latest_published（最新 published，无 → None）。**一查询聚合（无 N+1）**。按 strategy.id 升序。
    async fn manage_list(&self, kind: Option<StrategyKind>)
        -> anyhow::Result<Vec<StrategyManageItem>>;
    /// 更新策略元数据（PATCH /api/strategies/{id}）：name/description 为 application 层
    /// 合并/校验后的**最终值**；命中推进 updated_at 并返回更新后行；未知 id → Ok(None)（web 映射 404）。
    async fn update_meta(&self, id: &str, name: &str, description: &str)
        -> anyhow::Result<Option<StrategyRow>>;
}

// ── 12-strategy-system / P3a：回测工作台端口（strategy_run/strategy_run_result/strategy_preset 表，迁移 0023）──
// 与既有加法扩展同模式：端口在 domain，storage 实现，app bin 装配，web/application 只依赖端口。
// 应用面自有表（数据面不读写，ADR-017 不违）。ADR 12 §13.4（per_bar 全量落库）/§13.5（组合预设、结果页数据源）。
// 任务制（P4b 前与旧 BacktestRunStore 同型，旧端口已随 D16 退役删除）：create(queued) → mark_started(queued→running 原子认领) →
// update_progress(0..1) → mark_succeeded/mark_failed/mark_canceled（终态迁移均为条件更新，0 行 = 已被并发迁移）。

/// 策略运行状态（strategy_run.status：queued/running/succeeded/failed/canceled）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyRunStatus { Queued, Running, Succeeded, Failed, Canceled }

impl StrategyRunStatus {
    pub fn as_str(&self) -> &'static str {
        match self { StrategyRunStatus::Queued => "queued", StrategyRunStatus::Running => "running",
                     StrategyRunStatus::Succeeded => "succeeded", StrategyRunStatus::Failed => "failed",
                     StrategyRunStatus::Canceled => "canceled" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s { "queued" => Some(StrategyRunStatus::Queued), "running" => Some(StrategyRunStatus::Running),
                  "succeeded" => Some(StrategyRunStatus::Succeeded), "failed" => Some(StrategyRunStatus::Failed),
                  "canceled" => Some(StrategyRunStatus::Canceled), _ => None }
    }
    /// 是否终态（succeeded/failed/canceled 不可再迁移、不可取消）。
    pub fn is_terminal(&self) -> bool {
        matches!(self, StrategyRunStatus::Succeeded | StrategyRunStatus::Failed | StrategyRunStatus::Canceled)
    }
}

/// 新建策略运行（入队快照）。`config` 为完整可复现快照（ADR §13.4 复现前提）：
/// slots[{strategy_id, version_id, version, sha256, params, weight}]（运行钉住），
/// 另有 buy_threshold/sell_threshold、policy、stop、initial_capital、fee。
/// id 由应用层生成（sr_<ts>_<seq> 口径，与 st_/sv_ 同型）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewStrategyRun {
    pub id: String,
    pub name: String,
    pub symbol: String,
    pub period: String,           // M1/M5/M15/D1
    pub from_ts: DateTime<Utc>,   // 区间起点（闭）
    pub to_ts: DateTime<Utc>,     // 区间终点（开，[from, to) 半开）
    pub config: serde_json::Value,
}

/// 策略运行结果（strategy_run_result 五 jsonb 列聚合；ADR §13.4 全量粒度，后端不做有损预处理）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyRunResult {
    pub per_bar: serde_json::Value,   // 各策略分+聚合分+信号+订单+事件全量
    pub trades: serde_json::Value,    // 成交明细
    pub net_value: serde_json::Value, // 净值序列 [(ts, equity)]
    pub drawdown: serde_json::Value,  // 回撤序列 [(ts, dd)]
    pub metrics: serde_json::Value,   // 8 项绩效指标
}

/// 策略运行读模型（strategy_run 行；**结果不内联**——列表/详情走轻量 SELECT，
/// 结果经 `get_result` 单独取，避免列表联大 jsonb 表）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyRunView {
    pub id: String,
    pub name: String,
    pub symbol: String,
    pub period: String,
    pub from_ts: DateTime<Utc>,
    pub to_ts: DateTime<Utc>,
    pub config: serde_json::Value,
    pub status: StrategyRunStatus,
    pub progress: f64,   // 0..1
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// 策略运行列表过滤（GET /api/workbench/runs）。limit/offset 分页（默认 limit=100/offset=0）；
/// 排序 created_at DESC, id DESC。⚠️ `limit` 应始终设正数以约束单页行数。
#[derive(Debug, Clone, PartialEq)]
pub struct StrategyRunFilter {
    pub status: Option<StrategyRunStatus>,
    pub limit: i64,
    pub offset: i64,
}

impl Default for StrategyRunFilter {
    fn default() -> Self {
        Self { status: None, limit: 100, offset: 0 }
    }
}

/// 策略运行存储端口（storage 实现；strategy_run/strategy_run_result，迁移 0023）。
/// 状态迁移全部条件更新（WHERE status IN (...)），0 行命中 = 已被并发迁移——application 据此放弃执行。
#[async_trait]
pub trait StrategyRunStore: Send + Sync {
    /// 写 queued 行（progress=0）；返回写入行。
    async fn create_run(&self, run: &NewStrategyRun) -> anyhow::Result<StrategyRunView>;
    /// 读 run；未知 id → Ok(None)（web 映射 404）。
    async fn get_run(&self, id: &str) -> anyhow::Result<Option<StrategyRunView>>;
    /// 列表（轻量，不联结果表；created_at DESC, id DESC）。
    async fn list_runs(&self, filter: &StrategyRunFilter) -> anyhow::Result<Vec<StrategyRunView>>;
    /// queued→running 原子认领（`WHERE id=$1 AND status='queued'`），同事务写 started_at；
    /// false = 已被并发取消/启动（后台任务应放弃执行，防止取消后又被跑起来）。
    async fn mark_started(&self, id: &str, started_at: DateTime<Utc>) -> anyhow::Result<bool>;
    /// 进度更新（0..1；仅 running 行生效，终态行忽略）。
    async fn update_progress(&self, id: &str, progress: f64) -> anyhow::Result<()>;
    /// running→succeeded + 同事务落结果（INSERT strategy_run_result + UPDATE strategy_run）；
    /// false = 行已非 running（如并发取消）→ 结果不应落库。
    async fn mark_succeeded(&self, id: &str, result: &StrategyRunResult, finished_at: DateTime<Utc>)
        -> anyhow::Result<bool>;
    /// queued/running→failed + error；false = 行已终态（并发取消胜出，保留 canceled）。
    async fn mark_failed(&self, id: &str, error: &str, finished_at: DateTime<Utc>) -> anyhow::Result<bool>;
    /// queued/running→canceled（协作式取消的 DB 侧）。
    /// None = 未知 id（web 映射 404）；Some(false) = 已终态不可取消（web 映射 409）；Some(true) = 已取消。
    async fn mark_canceled(&self, id: &str, finished_at: DateTime<Utc>) -> anyhow::Result<Option<bool>>;
    /// 读结果（strategy_run_result）；未知 run / 未成功 → Ok(None)。
    async fn get_result(&self, run_id: &str) -> anyhow::Result<Option<StrategyRunResult>>;
}

/// 组合预设行（strategy_preset；ADR §13.5 组合预设，config 同 strategy_run.config 形状）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyPresetRow {
    pub id: String,
    pub name: String,
    pub config: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 新建组合预设（id 由应用层生成，sp_<ts>_<seq> 口径）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewStrategyPreset {
    pub id: String,
    pub name: String,
    pub config: serde_json::Value,
}

/// 组合预设存储端口（storage 实现；strategy_preset 表，迁移 0023）。
/// name UNIQUE 冲突 → sqlx Err（application/web 映射 409）。
#[async_trait]
pub trait StrategyPresetStore: Send + Sync {
    /// 新建预设（name UNIQUE 冲突 → Err）。
    async fn create_preset(&self, p: &NewStrategyPreset) -> anyhow::Result<StrategyPresetRow>;
    /// 读预设；未知 id → Ok(None)（web 映射 404）。
    async fn get_preset(&self, id: &str) -> anyhow::Result<Option<StrategyPresetRow>>;
    /// 按唯一名探测（create/update 前预检查，name UNIQUE 冲突 → 409 语义；DB UNIQUE 约束为最终兑底）。
    async fn find_preset_by_name(&self, name: &str) -> anyhow::Result<Option<StrategyPresetRow>>;
    /// 全部预设（created_at ASC, id ASC）。
    async fn list_presets(&self) -> anyhow::Result<Vec<StrategyPresetRow>>;
    /// 更新预设（name/config 为 application 层校验后最终值）；命中推进 updated_at 并返回更新后行；
    /// 未知 id → Ok(None)（web 映射 404）；name 冲突 → Err（409）。
    async fn update_preset(&self, id: &str, name: &str, config: &serde_json::Value)
        -> anyhow::Result<Option<StrategyPresetRow>>;
    /// 删除预设；false = 未知 id（web 映射 404）。
    async fn delete_preset(&self, id: &str) -> anyhow::Result<bool>;
}

/// 策略运行进度推送端口（web 实现；WS `{type:"strategy_run_progress", run_id, progress, bar_ts}`）。
/// broadcast hub 分发（P4b 前与旧 BacktestProgressSink 同型，旧端口已随 D16 退役删除）；run_id 为 text（sr_<ts>_<seq>）。
#[async_trait]
pub trait StrategyRunProgressSink: Send + Sync {
    async fn send(&self, run_id: &str, progress: f64, bar_ts: Option<DateTime<Utc>>) -> anyhow::Result<()>;
}
// ~/~ end
