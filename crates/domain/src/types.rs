// ~/~ begin <<design/02-domain/contracts.md#crates/domain/src/types.rs>>[init]
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
// ~/~ end
