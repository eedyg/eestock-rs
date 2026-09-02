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

/// 采集周期。本系统采集只写 1m（ADR-004），高周期由连续聚合生成。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Period { M1, M5, M15, H1, D1 }

/// 一根 K线 bar（真实 OHLCV）。
/// ts 用 DateTime<Utc>（⚠️ 审查修正：NaiveDateTime 配 timestamptz 是时区炸弹）；
/// Provider 适配层负责把交易所北京时间按 Asia/Shanghai 解析后转 UTC。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bar {
    pub code: Code,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceId {
    TencentIfzq,   // 1m 主力
    SinaJsonp,     // 1m 备源/交叉基准
    TencentQt,     // 快照池
    SinaHq,        // 快照池
    ThsCs,         // 快照池（仅单只）
    Push2delay,    // 快照池，东财系最低频（ADR-006）
    Exchange,      // 交易所官方快照
}

/// 源健康状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Health { Healthy, Degraded, CircuitOpen }
// ~/~ end
