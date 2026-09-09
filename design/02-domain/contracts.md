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
/// ⚠️ W1/MO1（看板周/月线，用户定稿）：仅看板读源扩展，回测周期不扩（backtest::Period 独立枚举）——
/// W1=A股交易周（Asia/Shanghai 周一为界）、MO1=自然月（Asia/Shanghai 月界）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Period { M1, M5, M15, H1, D1, W1, MO1 }

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

## 2.8 交易日历分钟标签口径（Wave 2 Phase A，13:00 伪缺口结案）

**实盘数据实证（2026-09-04，证据见 coder/report/011）**：上游三源（tencent ifzq / sina jsonp /
tushare stk_mins）bar 标签集合一致——上午 09:30..=11:30（121 个）、下午 13:01..=15:00（120 个），
全天 **241** 个标签；`kline_raw`/`kline_accurate` 均**无 13:00 标签**、均有 11:30 与 15:00 标签
（准确层 518880 每日 241 行）。旧「bar 起始时刻」口径（240，含 13:00、缺 11:30/15:00）与上游错位，
每日每标的恒产生 13:00 伪缺口（GapBackfiller 每轮空拉一次）。

本节把标签序列/会话窗口/陈旧判定纯函数放 domain（collector 调度与 diagnose 质量缺口报告跨层共用，
避免 Application 层互依）；`TradingCalendar` trait 不变（预批准范围：仅实现替换为节假日感知）。

``` {.rust file=crates/domain/src/calendar.rs}
//! 交易日历分钟标签口径（Wave 2 Phase A，实盘数据实证 2026-09-04 定稿，本节头注释）。
//! 标签集合：09:30..=11:30 ∪ 13:01..=15:00（241 个）；采集会话窗口含标签可得性滞后余量。

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Weekday};

pub fn hm(h: u32, m: u32) -> NaiveTime { NaiveTime::from_hms_opt(h, m, 0).expect("valid hm") }

pub fn is_weekday(date: NaiveDate) -> bool {
    matches!(date.weekday(),
        Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu | Weekday::Fri)
}

/// 当日交易分钟标签序列（naive CST）：09:30..=11:30 ∪ 13:01..=15:00，共 241。
/// 09:30=开盘集合竞价+首分钟 bar；11:30=上午收盘 bar；13:00 无标签（午后首分钟标签 13:01）；
/// 15:00=收盘集合竞价 bar。
pub fn trading_minute_labels(date: NaiveDate) -> Vec<NaiveDateTime> {
    let mut out = Vec::with_capacity(241);
    let mut push_range = |start: NaiveTime, end_inclusive: NaiveTime| {
        let mut t = start;
        while t <= end_inclusive {
            out.push(date.and_time(t));
            t += Duration::minutes(1);
        }
    };
    push_range(hm(9, 30), hm(11, 30));
    push_range(hm(13, 1), hm(15, 0));
    out
}

/// 采集会话窗口：该时刻是否应尝试采集（覆盖 11:30/15:00 标签 bar 的可得性滞后 ~1min）。
/// 09:30..=11:31 ∪ 13:00..=15:01。
pub fn is_session_minute(t: NaiveTime) -> bool {
    (hm(9, 30)..hm(11, 32)).contains(&t) || (hm(13, 0)..hm(15, 2)).contains(&t)
}

/// 分钟下取整（naive）。
fn minute_floor(t: NaiveDateTime) -> NaiveDateTime {
    t.date().and_time(NaiveTime::from_hms_opt(t.time().hour(), t.time().minute(), 0)
        .expect("valid hm"))
}

/// 陈旧判定基准（粘源陈旧检测，03-collector §3.1）：now（naive CST）时点「已到期」的最大标签
/// = 标签 ≤ floor_min(now − 60s)（1 分钟宽限：标签时刻后 60s 内允许源端未更新）。
/// None = 当日尚无到期标签（09:31 前）→ 调用方不做陈旧判定。
pub fn latest_due_label(now: NaiveDateTime) -> Option<NaiveDateTime> {
    let floor = minute_floor(now - Duration::seconds(60));
    trading_minute_labels(now.date()).into_iter().filter(|l| *l <= floor).max()
}

/// 陈旧 bar 判定：抓取结果最新标签落后于已到期标签 → 源在喂旧数据。
/// fetched_max / now 均为 naive CST；是否处于会话时段由调用方以 is_session_minute 门控
/// （executor 仅交易时段抓取；盘后/周末回填场景 due=15:00 与非交易日语义见 03 §3.1）。
pub fn is_stale(fetched_max: NaiveDateTime, now: NaiveDateTime) -> bool {
    match latest_due_label(now) {
        Some(due) => fetched_max < due,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }

    #[test]
    fn labels_241_and_boundaries() {
        let mins = trading_minute_labels(d(2026, 9, 3)); // 周四
        assert_eq!(mins.len(), 241);
        assert_eq!(mins.first().unwrap().time(), hm(9, 30), "首标签 09:30");
        assert_eq!(mins.last().unwrap().time(), hm(15, 0), "末标签 15:00（收盘集合竞价 bar）");
        let times: Vec<NaiveTime> = mins.iter().map(|m| m.time()).collect();
        assert!(times.contains(&hm(11, 30)), "11:30 上午收盘 bar 有标签");
        assert!(!times.contains(&hm(13, 0)), "13:00 无标签（上游口径实证）");
        assert!(times.contains(&hm(13, 1)), "午后首标签 13:01");
        assert!(!times.contains(&hm(12, 59)) && !times.contains(&hm(9, 29)));
    }

    #[test]
    fn session_window_covers_label_availability_lag() {
        assert!(!is_session_minute(hm(9, 29)));
        assert!(is_session_minute(hm(9, 30)));
        assert!(is_session_minute(hm(11, 30)) && is_session_minute(hm(11, 31)),
            "11:30 标签 bar 滞后余量");
        assert!(!is_session_minute(hm(11, 32)));
        assert!(!is_session_minute(hm(12, 59)), "午休不采集");
        assert!(is_session_minute(hm(13, 0)));
        assert!(is_session_minute(hm(15, 0)) && is_session_minute(hm(15, 1)),
            "15:00 收盘 bar 滞后余量");
        assert!(!is_session_minute(hm(15, 2)));
    }

    #[test]
    fn weekday_basics() {
        assert!(is_weekday(d(2026, 9, 3)));
        assert!(!is_weekday(d(2026, 9, 5)) && !is_weekday(d(2026, 9, 6)), "周末");
    }

    #[test]
    fn latest_due_label_and_stale() {
        let day = d(2026, 9, 3);
        // 09:30:30 → 无到期标签（宽限 60s）→ None；09:31:01 → due=09:30
        assert_eq!(latest_due_label(day.and_time(hm(9, 30))), None);
        assert_eq!(latest_due_label(day.and_hms_opt(9, 31, 1).unwrap()).unwrap().time(), hm(9, 30));
        // 10:41:20 → due=10:40
        assert_eq!(latest_due_label(day.and_hms_opt(10, 41, 20).unwrap()).unwrap().time(), hm(10, 40));
        // 午休 13:01:30 → floor=13:00，13:01 标签未到期 → due=11:30（午餐边缘不误判）
        assert_eq!(latest_due_label(day.and_hms_opt(13, 1, 30).unwrap()).unwrap().time(), hm(11, 30));
        // 13:02:30 → due=13:01
        assert_eq!(latest_due_label(day.and_hms_opt(13, 2, 30).unwrap()).unwrap().time(), hm(13, 1));
        // 盘后 21:00 → due=15:00（缺口回填场景）
        assert_eq!(latest_due_label(day.and_hms_opt(21, 0, 0).unwrap()).unwrap().time(), hm(15, 0));

        // is_stale：最新 bar 到期内不判陈旧；落后则陈旧
        assert!(!is_stale(day.and_hms_opt(10, 40, 0).unwrap(), day.and_hms_opt(10, 41, 20).unwrap()));
        assert!(is_stale(day.and_hms_opt(10, 39, 0).unwrap(), day.and_hms_opt(10, 41, 20).unwrap()),
            "10:40 bar 已到期而源最新只到 10:39 → 陈旧");
        assert!(!is_stale(day.and_hms_opt(11, 30, 0).unwrap(), day.and_hms_opt(13, 1, 30).unwrap()),
            "午休后首轮：13:01 未到期，11:30 不判陈旧");
        assert!(is_stale(day.and_hms_opt(11, 30, 0).unwrap(), day.and_hms_opt(13, 2, 30).unwrap()),
            "13:01 到期后仍停在 11:30 → 陈旧");
        // 当日无到期标签 → 不判陈旧
        assert!(!is_stale(day.and_hms_opt(9, 30, 0).unwrap(), day.and_hms_opt(9, 30, 30).unwrap()));
    }
}
```

## 2.9 策略 Registry 状态机（12-strategy-system / P2a；ADR 12 §5）

**选址理由**：状态机为纯函数校验模块，放 domain 层独立模块 `strategy_state`（不放 strategy-core——
该 crate 是评分/聚合/执行内核，Registry 持久化语义不属其职责；不放 application——web/application
均需共享强类型枚举，domain 是全 workspace 唯一公共依赖点，与 StrategyRunStatus/AlertStatus 等既有
状态枚举同层同模式）。纯函数、无 IO，全流转表可单测。

合法流转（单向）：`draft → published → archived`。其余一律非法（含 draft→archived、
published→draft、archived→\*、同态自转）。published 不可变由 DB trigger 双保险（04-storage §4.3.13）。

权限分级 `approval_level` 为**有序阶梯**：backtest_ok(1) → sim_ok(2) → live_approved(3)；
catalog 过滤用 at-least 语义（`satisfies`：高级别通过低级别过滤）。

``` {.rust file=crates/domain/src/strategy_state.rs}
//! 策略 Registry 状态机与强类型枚举（12-strategy-system / P2a；ADR 12-strategy-system §5）。
//! 纯函数校验模块：流转表驱动、无 IO、可单测（TDD：本模块测试即合法流转的可执行规格）。

use serde::{Deserialize, Serialize};

/// 版本状态（strategy_version.status）：draft → published → archived 单向流转（ADR §5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyStatus { Draft, Published, Archived }

impl StrategyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            StrategyStatus::Draft => "draft",
            StrategyStatus::Published => "published",
            StrategyStatus::Archived => "archived",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "draft" => Some(StrategyStatus::Draft),
            "published" => Some(StrategyStatus::Published),
            "archived" => Some(StrategyStatus::Archived),
            _ => None,
        }
    }
}

/// 权限分级（strategy_version.approval_level）：backtest_ok → sim_ok → live_approved
/// 有序升级（ADR §5：独立标记，升级需显式动作）。rank 用于 catalog at-least 过滤。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalLevel { BacktestOk, SimOk, LiveApproved }

impl ApprovalLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalLevel::BacktestOk => "backtest_ok",
            ApprovalLevel::SimOk => "sim_ok",
            ApprovalLevel::LiveApproved => "live_approved",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "backtest_ok" => Some(ApprovalLevel::BacktestOk),
            "sim_ok" => Some(ApprovalLevel::SimOk),
            "live_approved" => Some(ApprovalLevel::LiveApproved),
            _ => None,
        }
    }
    /// 阶梯 rank（backtest_ok=1 < sim_ok=2 < live_approved=3）。
    pub fn rank(&self) -> u8 {
        match self {
            ApprovalLevel::BacktestOk => 1,
            ApprovalLevel::SimOk => 2,
            ApprovalLevel::LiveApproved => 3,
        }
    }
    /// catalog 过滤（at-least 语义）：本级别是否满足要求的最低级别。
    pub fn satisfies(&self, required: &ApprovalLevel) -> bool {
        self.rank() >= required.rank()
    }
}

/// 策略类别（strategy.kind）：strategy=用户策略 / template=官方模板（ADR §13.2 D10）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyKind { Strategy, Template }

impl StrategyKind {
    pub fn as_str(&self) -> &'static str {
        match self { StrategyKind::Strategy => "strategy", StrategyKind::Template => "template" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "strategy" => Some(StrategyKind::Strategy),
            "template" => Some(StrategyKind::Template),
            _ => None,
        }
    }
}

/// 非法状态流转（状态机校验失败载荷；application 层包装后 web 映射 409）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTransition {
    pub from: StrategyStatus,
    pub to: StrategyStatus,
}

impl std::fmt::Display for InvalidTransition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "非法状态流转: {} → {}（合法：draft→published→archived 单向）",
               self.from.as_str(), self.to.as_str())
    }
}

impl std::error::Error for InvalidTransition {}

/// 合法流转判定（单向表驱动）：draft→published、published→archived。
pub fn can_transition(from: StrategyStatus, to: StrategyStatus) -> bool {
    matches!(
        (from, to),
        (StrategyStatus::Draft, StrategyStatus::Published)
            | (StrategyStatus::Published, StrategyStatus::Archived)
    )
}

/// 流转校验：合法 → Ok(())；非法 → Err(InvalidTransition)。
pub fn validate_transition(from: StrategyStatus, to: StrategyStatus)
    -> Result<(), InvalidTransition> {
    if can_transition(from, to) { Ok(()) } else { Err(InvalidTransition { from, to }) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StrategyStatus::*;

    /// 全流转表（3×3=9 对）：仅 draft→published、published→archived 合法。
    #[test]
    fn transition_table_full() {
        let all = [Draft, Published, Archived];
        for from in all {
            for to in all {
                let expected = matches!((from, to),
                    (Draft, Published) | (Published, Archived));
                assert_eq!(can_transition(from, to), expected, "{from:?} → {to:?}");
                assert_eq!(validate_transition(from, to).is_ok(), expected);
            }
        }
    }

    #[test]
    fn invalid_transition_display_mentions_states() {
        let e = validate_transition(Draft, Archived).unwrap_err();
        assert_eq!(e, InvalidTransition { from: Draft, to: Archived });
        let msg = e.to_string();
        assert!(msg.contains("draft") && msg.contains("archived"));
    }

    #[test]
    fn status_str_roundtrip() {
        for s in [Draft, Published, Archived] {
            assert_eq!(StrategyStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(StrategyStatus::parse("unknown"), None);
    }

    #[test]
    fn approval_level_ladder_and_satisfies() {
        use ApprovalLevel::*;
        assert!(BacktestOk.rank() < SimOk.rank() && SimOk.rank() < LiveApproved.rank());
        // at-least 语义：高级别通过低级别过滤；低级别不满足高级别要求。
        assert!(LiveApproved.satisfies(&BacktestOk));
        assert!(LiveApproved.satisfies(&LiveApproved));
        assert!(SimOk.satisfies(&BacktestOk));
        assert!(!BacktestOk.satisfies(&SimOk));
        assert!(!BacktestOk.satisfies(&LiveApproved));
        for l in [BacktestOk, SimOk, LiveApproved] {
            assert_eq!(ApprovalLevel::parse(l.as_str()), Some(l));
        }
        assert_eq!(ApprovalLevel::parse("admin"), None);
    }

    #[test]
    fn kind_str_roundtrip() {
        for k in [StrategyKind::Strategy, StrategyKind::Template] {
            assert_eq!(StrategyKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(StrategyKind::parse("builtin"), None);
    }

    #[test]
    fn serde_snake_case() {
        assert_eq!(serde_json::to_string(&Draft).unwrap(), "\"draft\"");
        assert_eq!(serde_json::to_string(&ApprovalLevel::LiveApproved).unwrap(),
                   "\"live_approved\"");
        assert_eq!(serde_json::to_string(&StrategyKind::Template).unwrap(), "\"template\"");
    }
}
```
