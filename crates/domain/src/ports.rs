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
}

impl ErrKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrKind::Na => "na", ErrKind::Timeout => "timeout", ErrKind::Http => "http",
            ErrKind::Parse => "parse", ErrKind::RateLimited => "rate_limited",
            ErrKind::CircuitOpen => "circuit_open", ErrKind::CircuitHalfopen => "circuit_halfopen",
            ErrKind::CircuitClosed => "circuit_closed", ErrKind::ManualReset => "manual_reset",
            ErrKind::AllFailed => "all_failed",
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

/// 交易时段判定（工作日 09:30-11:30 / 13:00-15:00，节假日表后续接入）。
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
// ~/~ end
