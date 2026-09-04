# 02 — 领域契约（domain crate）

> 本文档 tangle 生成 `crates/domain/src/`。domain 不依赖任何基础设施，所有外部能力以 trait 表达，由 app crate 装配注入。
> 所有类型与 trait 的单元测试规格见各契约小节（TDD：测试先行，测试代码在 `crates/domain/src/*_test.rs` 或 tests/）。

## 2.1 核心类型

``` {.rust file=crates/domain/src/types.rs}
//! 核心领域类型。金额单位：元；成交量单位：股（Provider 适配层负责手→股×100、万元→元×10000 换算）。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 标的代码，如 518880。市场规则：5/6/9→沪(sh)，0/1/2/3→深(sz)，4/8/920→北交所（暂不支持）。
/// ⚠️ 审查修正：初版「5→sh 其他→sz」会把 6 开头沪 A 股误判为深市，属硬伤。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Code(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Market { Sh, Sz }

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CodeError {
    #[error("unsupported market (北交所/未知前缀): {0}")]
    UnsupportedMarket(String),
}

impl Code {
    pub fn market(&self) -> Result<Market, CodeError> {
        // ⚠️ 920 开头为北交所（契约测试实锤：粗粒度 '9'→沪 会把 920xxx 误判沪市），须先行排除
        if self.0.starts_with("920") {
            return Err(CodeError::UnsupportedMarket(self.0.clone()));
        }
        match self.0.chars().next() {
            Some('5') | Some('6') | Some('9') => Ok(Market::Sh),
            Some('0') | Some('1') | Some('2') | Some('3') => Ok(Market::Sz),
            _ => Err(CodeError::UnsupportedMarket(self.0.clone())),
        }
    }
    /// Provider 适配用带前缀形式，如 sh518880
    pub fn prefixed(&self) -> Result<String, CodeError> {
        match self.market()? {
            Market::Sh => Ok(format!("sh{}", self.0)),
            Market::Sz => Ok(format!("sz{}", self.0)),
        }
    }
}

/// 采集周期。本系统采集只写 1m（ADR-004），高周期由连续聚合生成；
/// 历史层（ADR-016）可为多粒度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Period { M1, M5, M15, H1, D1 }

/// 一根 K线 bar（真实 OHLCV）。
/// ts 用 DateTime<Utc>（⚠️ 审查修正：NaiveDateTime 配 timestamptz 是时区炸弹）；
/// Provider 适配层负责把交易所北京时间按 Asia/Shanghai 解析后转 UTC。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bar {
    pub code: Code,
    pub period: Period,           // ADR-016：实时层恒为 M1；历史层多粒度
    pub ts: DateTime<Utc>,        // bar 起始时刻（交易所分钟边界对齐）
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,              // 股
    pub amount: f64,              // 元
    pub source: SourceId,         // 来源标记（诊断/分歧分析用）
}

/// 快照（当前仅用于源健康参考，不入 K线主链路）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quote {
    pub code: Code,
    pub last: f64,
    pub prev_close: f64,
    pub volume: u64,
    pub amount: f64,
    pub data_ts: DateTime<Utc>,
    pub source: SourceId,
}

/// 数据源标识。
/// `*Approx` 变体：03 §6 降级模式产物标记（快照池合成的近似 1m bar），
/// 与真实 bar 物理可区分（落库 source 列为 `*_approx` 文本）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceId {
    TencentIfzq,   // 1m 主力
    SinaJsonp,     // 1m 备源/交叉基准
    TencentQt,     // 快照池
    SinaHq,        // 快照池
    ThsCs,         // 快照池（仅单只）
    Push2delay,    // 快照池，东财系最低频（ADR-006）
    Exchange,      // 交易所官方快照
    Tushare,       // ADR-016：历史层（准确层来源）
    TencentQtApprox,   // 降级模式：腾讯 qt 快照合成
    SinaHqApprox,      // 降级模式：新浪 hq 快照合成
    ThsCsApprox,       // 降级模式：同花顺快照合成
    Push2delayApprox,  // 降级模式：push2delay 快照合成
    ExchangeApprox,    // 降级模式：交易所快照合成
}

impl SourceId {
    /// 落库 source 列文本（单一事实源：storage/诊断共用此口径）。
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceId::TencentIfzq => "tencent_ifzq", SourceId::SinaJsonp => "sina_jsonp",
            SourceId::TencentQt => "tencent_qt", SourceId::SinaHq => "sina_hq",
            SourceId::ThsCs => "ths_cs", SourceId::Push2delay => "push2delay",
            SourceId::Exchange => "exchange", SourceId::Tushare => "tushare",
            SourceId::TencentQtApprox => "tencent_qt_approx",
            SourceId::SinaHqApprox => "sina_hq_approx",
            SourceId::ThsCsApprox => "ths_cs_approx",
            SourceId::Push2delayApprox => "push2delay_approx",
            SourceId::ExchangeApprox => "exchange_approx",
        }
    }
    /// 是否降级模式近似标记。
    pub fn is_approx(&self) -> bool { matches!(self,
        SourceId::TencentQtApprox | SourceId::SinaHqApprox | SourceId::ThsCsApprox
        | SourceId::Push2delayApprox | SourceId::ExchangeApprox) }
    /// 快照池源 → 对应近似变体；非快照池源（Tier1/tushare）→ None。
    pub fn approx(&self) -> Option<SourceId> {
        match self {
            SourceId::TencentQt => Some(SourceId::TencentQtApprox),
            SourceId::SinaHq => Some(SourceId::SinaHqApprox),
            SourceId::ThsCs => Some(SourceId::ThsCsApprox),
            SourceId::Push2delay => Some(SourceId::Push2delayApprox),
            SourceId::Exchange => Some(SourceId::ExchangeApprox),
            _ => None,
        }
    }
    /// 近似变体 → 原型；非近似变体 → 自身。
    pub fn base(&self) -> SourceId {
        match self {
            SourceId::TencentQtApprox => SourceId::TencentQt,
            SourceId::SinaHqApprox => SourceId::SinaHq,
            SourceId::ThsCsApprox => SourceId::ThsCs,
            SourceId::Push2delayApprox => SourceId::Push2delay,
            SourceId::ExchangeApprox => SourceId::Exchange,
            other => *other,
        }
    }
    /// 落库文本 → SourceId（Wave 1 Phase C 加法：熔断复位 DB 控制通道反解析用）。
    /// 未知文本 → None（消费端跳过并告警，不 panic）。
    pub fn parse(s: &str) -> Option<SourceId> {
        Some(match s {
            "tencent_ifzq" => SourceId::TencentIfzq, "sina_jsonp" => SourceId::SinaJsonp,
            "tencent_qt" => SourceId::TencentQt, "sina_hq" => SourceId::SinaHq,
            "ths_cs" => SourceId::ThsCs, "push2delay" => SourceId::Push2delay,
            "exchange" => SourceId::Exchange, "tushare" => SourceId::Tushare,
            "tencent_qt_approx" => SourceId::TencentQtApprox,
            "sina_hq_approx" => SourceId::SinaHqApprox,
            "ths_cs_approx" => SourceId::ThsCsApprox,
            "push2delay_approx" => SourceId::Push2delayApprox,
            "exchange_approx" => SourceId::ExchangeApprox,
            _ => return None,
        })
    }
}

/// 生成 Trace ID：32 位 hex（rand 生成）。
/// 父级裁决（2026-09-03）：不引入 uuid 依赖，每次抓取生成一个贯穿事件/日志。
pub fn new_trace_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32).map(|_| format!("{:x}", rng.gen_range(0..16u8))).collect()
}

/// 源健康状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Health { Healthy, Degraded, CircuitOpen }
```

## 2.2 Provider 契约（基础设施实现）

``` {.rust file=crates/domain/src/provider.rs}
//! Provider trait：每个数据源一个适配器（Infrastructure 层）。
//! 约束：GBK 解码、字段单位换算、限频（token bucket）均在适配器内部完成。

use crate::types::*;
use async_trait::async_trait;
use chrono::{DateTime, Utc}; // ⚠️ 审查修正（2026-09-03）：HistoricalDataProvider 签名用 DateTime<Utc>，原块漏导入无法编译

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("http: {0}")]
    Http(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("rate limited (403/429)")]
    RateLimited,
    #[error("timeout")]
    Timeout,
    #[error("no data (非交易时段/标的无数据)")]
    NoData,
}

#[async_trait]
pub trait MinuteKlineProvider: Send + Sync {
    fn id(&self) -> SourceId;
    /// 拉取最近若干根 1m bar。免费源物理上限：腾讯≈2天/新浪≈8天（ADR-004）。
    async fn fetch_m1(&self, code: &Code, limit: usize) -> Result<Vec<Bar>, ProviderError>;
}

#[async_trait]
pub trait SnapshotProvider: Send + Sync {
    fn id(&self) -> SourceId;
    async fn fetch_snapshot(&self, codes: &[Code]) -> Result<Vec<Quote>, ProviderError>;
}

/// ADR-016：历史数据 Provider（tushare 等）。与实时层解耦：
/// 实时层喂 kline_raw（日内增量），历史层喂 kline_accurate（准确层回填）。
#[async_trait]
pub trait HistoricalDataProvider: Send + Sync {
    fn id(&self) -> SourceId;
    /// 拉取 [start, end]（闭区间，UTC）内指定周期 K线，按 ts 升序。
    async fn fetch_history(&self, code: &Code, period: Period,
                           start: DateTime<Utc>, end: DateTime<Utc>)
                           -> Result<Vec<Bar>, ProviderError>;
    /// 该源支持的周期（tushare：M1/M5/M15/H1/D1，视账户档位，启动时探测）
    fn supported_periods(&self) -> Vec<Period>;
}
```

## 2.3 源选取策略（ADR-005 + ADR-015 修订）

``` {.rust file=crates/domain/src/selector.rs}
//! 时间窗轮换当班 + 轮询式故障转移（ADR-015 取代 ADR-005 的逐股随机起点）。
//! TDD 要点（测试规格）：
//! - 当班源健康时链首恒为当班源；当班源熔断时退为剩余健康源随机起点
//! - 转移顺序确定：从链首起按注册序轮转，不重复
//! - 熔断源不出现在序列中
//! - DutyRoster：窗长随机 20-40min，两源交替当班，窗界切换带 0-30s 随机偏移

use crate::types::*;
use rand::seq::SliceRandom;

pub struct SourceSelector {
    /// 注册序即轮转序（东财系恒在最后——ADR-006）
    ordered: Vec<SourceId>,
}

impl SourceSelector {
    pub fn new(ordered: Vec<SourceId>) -> Self { Self { ordered } }

    /// 本周期尝试链：当班源优先（健康时），否则健康池随机起点；之后按注册序轮转。
    pub fn attempt_chain(&self, duty: SourceId, healthy: &[SourceId]) -> Vec<SourceId> {
        let pool: Vec<SourceId> = self.ordered.iter()
            .filter(|s| healthy.contains(s)).cloned().collect();
        if pool.is_empty() { return vec![]; }
        let mut rng = rand::thread_rng();
        let start = if pool.contains(&duty) { duty }
                    else { pool.choose(&mut rng).cloned().unwrap_or(pool[0]) };
        let pos = pool.iter().position(|s| *s == start).unwrap_or(0);
        pool.iter().cycle().skip(pos).take(pool.len()).cloned().collect()
    }
}

/// 当班轮换表：随机窗长 20-40min，Tier1 两源交替，切换带 0-30s 随机偏移。
/// 纯函数可测（注入时钟与随机源）。
pub struct DutyRoster {
    tier1: [SourceId; 2],
}

impl DutyRoster {
    pub fn new(tier1: [SourceId; 2]) -> Self { Self { tier1 } }
    /// 由“纪元分钟数 + 抖动种子”确定性推导当班源（测试可复现）。
    pub fn duty_at(&self, epoch_minutes: u64, jitter_seed: u64) -> SourceId {
        // 窗长 20-40min：以 30min 为基准的伪随机窗口序列由 epoch/jitter 推导，
        // 实现细节在 collector 落码时以 TDD 锁定；此处固定契约：
        // 同一 (epoch_minutes, jitter_seed) 输入恒得同一输出。
        let window = 20 + (jitter_seed % 21); // 20-40
        let idx = ((epoch_minutes / window) % 2) as usize;
        self.tier1[idx]
    }
}
```

## 2.4 注册表 / 写入 / 健康监控契约

``` {.rust file=crates/domain/src/ports.rs}
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
```

## 2.5 真值合并策略（ADR-003）

merge 规则为纯函数，便于 TDD：**accurate 存在的时点取 accurate，否则取 raw**。
实现为 storage 层 SQL 视图 + domain 层同名纯函数（供回测/分析离线使用），两者语义必须一致（契约测试锁定）。

## 2.6 时区口径（铁律：Asia/Shanghai 解析、UTC 存储）

Asia/Shanghai 无夏令时，固定 +8（避免引入 chrono-tz 依赖）。providers/collector 统一用此模块；
tushare 有其历史同名实现（保留原样，语义一致）。

``` {.rust file=crates/domain/src/tz.rs}
//! 交易所时区工具：Asia/Shanghai（固定 +8，无 DST）。

use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};

pub const CST_OFFSET_SECS: i32 = 8 * 3600;

pub fn cst() -> FixedOffset {
    FixedOffset::east_opt(CST_OFFSET_SECS).expect("valid offset")
}

/// 北京时间 naive → UTC（固定偏移无歧义）。
pub fn cst_to_utc(naive: NaiveDateTime) -> DateTime<Utc> {
    cst().from_local_datetime(&naive).single()
        .expect("CST 固定偏移无歧义").with_timezone(&Utc)
}

/// UTC → 北京时间 naive。
pub fn utc_to_cst(ts: DateTime<Utc>) -> NaiveDateTime {
    ts.with_timezone(&cst()).naive_local()
}
```

## 2.7 契约测试规格（TDD：本节测试先行）

测试覆盖：Code 市场前缀（5/6/9→sh、0/1/2/3→sz、4/8 拒绝）、Bar/Quote serde 往返、
SourceId 字符串口径（含 `*_approx`，03 §6 降级模式标记）、selector 当班优先/轮转/熔断剔除/空池、
DutyRoster 确定性与窗长范围、merge 准确层优先/补缺/仅准确时点保留/排序、
ProviderError 错误分类显示（01 §4 口径）、ErrKind 字符串、Trace ID 格式。

``` {.rust file=crates/domain/tests/contracts_test.rs}
//! domain 契约测试——由 design/02-domain/contracts.md §2.6 tangle 生成，禁止手改。

use chrono::{TimeZone, Utc};
use domain::merge::merge_prefer_accurate;
use domain::provider::ProviderError;
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;

fn bar(code: &str, h: u32, mi: u32, src: SourceId, close: f64) -> Bar {
    Bar {
        code: Code(code.into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 3, h, mi, 0).unwrap(),
        open: close, high: close, low: close, close,
        volume: 100, amount: 100.0, source: src,
    }
}

#[test]
fn market_prefix_mapping() {
    for c in ["518880", "600519", "900901"] {
        assert_eq!(Code(c.into()).market().unwrap(), Market::Sh, "{c} 应判沪");
    }
    for c in ["159915", "000001", "200002", "300750"] {
        assert_eq!(Code(c.into()).market().unwrap(), Market::Sz, "{c} 应判深");
    }
    for c in ["430001", "830799", "920001"] {
        assert!(Code(c.into()).market().is_err(), "{c} 北交所/未知应拒绝");
    }
}

#[test]
fn prefixed_code() {
    assert_eq!(Code("518880".into()).prefixed().unwrap(), "sh518880");
    assert_eq!(Code("159915".into()).prefixed().unwrap(), "sz159915");
}

#[test]
fn bar_quote_serde_roundtrip() {
    let b = bar("518880", 1, 30, SourceId::TencentIfzq, 8.9);
    let s = serde_json::to_string(&b).unwrap();
    let b2: Bar = serde_json::from_str(&s).unwrap();
    assert_eq!(b, b2);
    let q = Quote { code: Code("518880".into()), last: 8.9, prev_close: 8.8,
                    volume: 1000, amount: 8900.0,
                    data_ts: Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap(),
                    source: SourceId::TencentQt };
    let q2: Quote = serde_json::from_str(&serde_json::to_string(&q).unwrap()).unwrap();
    assert_eq!(q, q2);
}

#[test]
fn source_id_str_and_approx() {
    assert_eq!(SourceId::TencentIfzq.as_str(), "tencent_ifzq");
    assert_eq!(SourceId::Tushare.as_str(), "tushare");
    // 03 §6：降级模式近似 bar 以 *_approx 标记，与真实 bar 物理可区分
    assert_eq!(SourceId::TencentQtApprox.as_str(), "tencent_qt_approx");
    assert_eq!(SourceId::SinaHqApprox.as_str(), "sina_hq_approx");
    assert_eq!(SourceId::ThsCsApprox.as_str(), "ths_cs_approx");
    assert_eq!(SourceId::Push2delayApprox.as_str(), "push2delay_approx");
    assert_eq!(SourceId::ExchangeApprox.as_str(), "exchange_approx");
    assert!(!SourceId::TencentQt.is_approx());
    assert!(SourceId::TencentQtApprox.is_approx());
    assert_eq!(SourceId::TencentQt.approx(), Some(SourceId::TencentQtApprox));
    assert_eq!(SourceId::TencentQtApprox.base(), SourceId::TencentQt);
    // 非快照池源无近似形态
    assert_eq!(SourceId::TencentIfzq.approx(), None);
    assert_eq!(SourceId::Tushare.approx(), None);
}

#[test]
fn selector_duty_first_when_healthy() {
    let sel = SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]);
    let chain = sel.attempt_chain(SourceId::SinaJsonp,
                                  &[SourceId::TencentIfzq, SourceId::SinaJsonp]);
    assert_eq!(chain, vec![SourceId::SinaJsonp, SourceId::TencentIfzq],
               "当班源健康时链首恒为当班源，之后按注册序轮转");
}

#[test]
fn selector_excludes_unhealthy() {
    let sel = SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]);
    let chain = sel.attempt_chain(SourceId::TencentIfzq, &[SourceId::SinaJsonp]);
    assert_eq!(chain, vec![SourceId::SinaJsonp], "熔断源不出现在序列中");
}

#[test]
fn selector_empty_pool() {
    let sel = SourceSelector::new(vec![SourceId::TencentIfzq, SourceId::SinaJsonp]);
    assert!(sel.attempt_chain(SourceId::TencentIfzq, &[]).is_empty(), "空池 → 空链");
}

#[test]
fn duty_roster_deterministic_and_alternates() {
    let r = DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]);
    assert_eq!(r.duty_at(0, 7), r.duty_at(0, 7), "同输入恒同输出");
    assert_eq!(r.duty_at(0, 7), SourceId::TencentIfzq);
    // 找到首次换班点 m：窗长必须落在 20-40min（ADR-015）
    let mut flip = None;
    for m in 1..=60u64 {
        if r.duty_at(m, 7) != r.duty_at(0, 7) { flip = Some(m); break; }
    }
    let m = flip.expect("60 分钟内必换班");
    assert!((20..=40).contains(&m), "窗长 {m} 应 ∈ [20,40]");
    assert_eq!(r.duty_at(m, 7), SourceId::SinaJsonp, "两源交替当班");
    assert_eq!(r.duty_at(2 * m, 7), SourceId::TencentIfzq, "再交替回切");
}

#[test]
fn merge_prefers_accurate_and_fills_and_keeps_accurate_only() {
    let raw = vec![bar("518880", 1, 30, SourceId::TencentIfzq, 1.0),
                   bar("518880", 1, 31, SourceId::TencentIfzq, 2.0)];
    let acc = vec![bar("518880", 1, 31, SourceId::Tushare, 99.0),
                   bar("518880", 1, 32, SourceId::Tushare, 3.0)];
    let out = merge_prefer_accurate(raw, acc);
    assert_eq!(out.len(), 3);
    assert_eq!(out[0].close, 1.0, "raw 补缺");
    assert_eq!(out[1].close, 99.0, "accurate 优先");
    assert_eq!(out[1].source, SourceId::Tushare);
    assert_eq!(out[2].close, 3.0, "仅 accurate 有的时点保留");
    // 排序：按 (code, ts) 升序
    assert!(out.windows(2).all(|w| w[0].ts < w[1].ts));
}

#[test]
fn provider_error_classification() {
    // 01-providers-spec §4 统一口径
    assert_eq!(ProviderError::RateLimited.to_string(), "rate limited (403/429)");
    assert_eq!(ProviderError::Timeout.to_string(), "timeout");
    assert!(ProviderError::Http("x".into()).to_string().starts_with("http: "));
    assert!(ProviderError::Parse("x".into()).to_string().starts_with("parse: "));
    assert!(ProviderError::NoData.to_string().contains("no data"));
}

#[test]
fn err_kind_str_table() {
    // 03 §7 事件模型 err_kind 列口径
    use domain::ports::ErrKind;
    assert_eq!(ErrKind::Na.as_str(), "na");
    assert_eq!(ErrKind::Timeout.as_str(), "timeout");
    assert_eq!(ErrKind::Http.as_str(), "http");
    assert_eq!(ErrKind::Parse.as_str(), "parse");
    assert_eq!(ErrKind::RateLimited.as_str(), "rate_limited");
    assert_eq!(ErrKind::CircuitOpen.as_str(), "circuit_open");
    assert_eq!(ErrKind::CircuitHalfopen.as_str(), "circuit_halfopen");
    assert_eq!(ErrKind::CircuitClosed.as_str(), "circuit_closed");
    assert_eq!(ErrKind::ManualReset.as_str(), "manual_reset");
    assert_eq!(ErrKind::AllFailed.as_str(), "all_failed");
}

#[test]
fn trace_id_format() {
    let a = new_trace_id();
    let b = new_trace_id();
    assert_eq!(a.len(), 32, "32 位 hex（rand 生成，父级裁决：不引 uuid 依赖）");
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b, "两次生成应不同");
}

#[test]
fn source_id_parse_roundtrip_and_unknown() {
    // Phase C 加法：parse 为 as_str 的逆（含 *_approx 全变体）
    for s in [
        SourceId::TencentIfzq, SourceId::SinaJsonp, SourceId::TencentQt, SourceId::SinaHq,
        SourceId::ThsCs, SourceId::Push2delay, SourceId::Exchange, SourceId::Tushare,
        SourceId::TencentQtApprox, SourceId::SinaHqApprox, SourceId::ThsCsApprox,
        SourceId::Push2delayApprox, SourceId::ExchangeApprox,
    ] {
        assert_eq!(SourceId::parse(s.as_str()), Some(s), "{} 应往返一致", s.as_str());
    }
    assert_eq!(SourceId::parse("nonexistent_src"), None, "未知源 → None（消费端跳过不 panic）");
    assert_eq!(SourceId::parse(""), None);
}
```

``` {.rust file=crates/domain/src/merge.rs}
//! 双真值层合并：准确层优先（纯函数版，与 SQL 视图语义一致，契约测试锁定）。

use crate::types::Bar;
use std::collections::{HashMap, HashSet};

pub fn merge_prefer_accurate(raw: Vec<Bar>, accurate: Vec<Bar>) -> Vec<Bar> {
    // ⚠️ ADR-016 连带：key 含 period，防止跨粒度误合并
    let raw_keys: HashSet<_> = raw.iter().map(|b| (b.code.clone(), b.period, b.ts)).collect();
    let acc: HashMap<_, _> = accurate.into_iter().map(|b| ((b.code.clone(), b.period, b.ts), b)).collect();
    let mut out: Vec<Bar> = raw.into_iter()
        .map(|b| acc.get(&(b.code.clone(), b.period, b.ts)).cloned().unwrap_or(b)).collect();
    out.extend(acc.into_values().filter(|b| !raw_keys.contains(&(b.code.clone(), b.period, b.ts))));
    out.sort_by_key(|b| (b.code.clone(), b.ts));
    out
}
```
