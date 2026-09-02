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
```

## 2.2 Provider 契约（基础设施实现）

``` {.rust file=crates/domain/src/provider.rs}
//! Provider trait：每个数据源一个适配器（Infrastructure 层）。
//! 约束：GBK 解码、字段单位换算、限频（token bucket）均在适配器内部完成。

use crate::types::*;
use async_trait::async_trait;

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
```

## 2.3 源选取策略（ADR-005）

``` {.rust file=crates/domain/src/selector.rs}
//! 逐股随机起点 + 轮询式故障转移。
//! TDD 要点（测试规格）：
//! - 随机起点在健康池内均匀分布（统计性测试可放宽为：全部源都可能被首先选中）
//! - 转移顺序确定：从起点起按注册序轮转，不重复
//! - 熔断源不出现在序列中
//! - 单标的单次拉取粘住同一源

use crate::types::*;
use rand::seq::SliceRandom;

pub struct SourceSelector {
    /// 注册序即轮转序（优先级从高到低由配置决定，东财系恒在最后——ADR-006）
    ordered: Vec<SourceId>,
}

impl SourceSelector {
    pub fn new(ordered: Vec<SourceId>) -> Self { Self { ordered } }

    /// 为某标的生成本周期的尝试序列：随机起点 + 注册序轮转，剔除熔断源。
    pub fn attempt_chain(&self, healthy: &[SourceId]) -> Vec<SourceId> {
        let pool: Vec<SourceId> = self.ordered.iter()
            .filter(|s| healthy.contains(s)).cloned().collect();
        if pool.is_empty() { return vec![]; }
        let mut rng = rand::thread_rng();
        let start = pool.choose(&mut rng).cloned().unwrap_or(pool[0]);
        let pos = pool.iter().position(|s| *s == start).unwrap_or(0);
        pool.iter().cycle().skip(pos).take(pool.len()).cloned().collect()
    }
}
```

## 2.4 注册表 / 写入 / 健康监控契约

``` {.rust file=crates/domain/src/ports.rs}
//! 应用层依赖的端口（由 Infrastructure 实现，DI 注入）。

use crate::types::*;
use async_trait::async_trait;

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

/// 交易时段判定（工作日 09:30-11:30 / 13:00-15:00，节假日表后续接入）。
pub trait TradingCalendar: Send + Sync {
    fn is_trading_now(&self) -> bool;
    fn is_trading_day(&self, date: chrono::NaiveDate) -> bool;
}
```

## 2.5 真值合并策略（ADR-003）

merge 规则为纯函数，便于 TDD：**accurate 存在的时点取 accurate，否则取 raw**。
实现为 storage 层 SQL 视图 + domain 层同名纯函数（供回测/分析离线使用），两者语义必须一致（契约测试锁定）。

``` {.rust file=crates/domain/src/merge.rs}
//! 双真值层合并：准确层优先（纯函数版，与 SQL 视图语义一致，契约测试锁定）。

use crate::types::Bar;
use std::collections::{HashMap, HashSet};

pub fn merge_prefer_accurate(raw: Vec<Bar>, accurate: Vec<Bar>) -> Vec<Bar> {
    let raw_keys: HashSet<_> = raw.iter().map(|b| (b.code.clone(), b.ts)).collect();
    let acc: HashMap<_, _> = accurate.into_iter().map(|b| ((b.code.clone(), b.ts), b)).collect();
    // ⚠️ 审查修正：初版 acc_only 过滤为 O(n²)，改 HashSet O(n)
    let mut out: Vec<Bar> = raw.into_iter()
        .map(|b| acc.get(&(b.code.clone(), b.ts)).cloned().unwrap_or(b)).collect();
    out.extend(acc.into_values().filter(|b| !raw_keys.contains(&(b.code.clone(), b.ts))));
    out.sort_by_key(|b| (b.code.clone(), b.ts));
    out
}
```
