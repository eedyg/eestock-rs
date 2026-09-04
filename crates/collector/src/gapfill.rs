// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/gapfill.rs>>[init]
//! 当日缺口回填：启动时 + 每 30 分钟。缺口 = 当日交易分钟标签序列（241 个，§2.8 口径）−
//! kline_raw 已有 ts（仅当日；更早历史缺口归 tushare 准确层，ADR-003）。只拉已过去的分钟（未来分钟不是缺口）。
//! Wave 2 Phase A：交易日历驱动（TradingCalendar 注入）——非交易日（周末 ∪ holidays[0008]）不算缺口、不回填。

use crate::calendar::trading_minutes;
use crate::clock::Clock;
use crate::executor::FetchExecutor;
use chrono::{DateTime, NaiveDate, Timelike, Utc};
use domain::ports::{RawBarReader, SymbolRegistry, TradingCalendar};
use domain::tz::{cst_to_utc, utc_to_cst};
use std::collections::HashSet;
use std::sync::Arc;

pub const BACKFILL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// 回填拉取上限：当日 241 标签 + 3 根重叠（§3）。
pub const GAP_LIMIT: usize = 244;

/// 缺口集合：当日已过去的交易分钟标签 − existing。非当日/非交易日 → 空。
/// trading_day 由调用方经 TradingCalendar 判定传入（纯函数保持可离线 TDD）。
pub fn compute_gaps(existing: &HashSet<DateTime<Utc>>, date: NaiveDate, now: DateTime<Utc>,
                    trading_day: bool) -> Vec<DateTime<Utc>> {
    let cst_now = utc_to_cst(now);
    if cst_now.date() != date || !trading_day { return vec![]; }
    let now_floor = cst_now.with_second(0).and_then(|t| t.with_nanosecond(0))
        .map(cst_to_utc).unwrap_or(now);
    trading_minutes(date).into_iter().map(cst_to_utc)
        .filter(|ts| *ts <= now_floor && !existing.contains(ts))
        .collect()
}

pub struct GapBackfiller {
    executor: Arc<FetchExecutor>,
    reader: Arc<dyn RawBarReader>,
    registry: Arc<dyn SymbolRegistry>,
    clock: Arc<dyn Clock>,
    calendar: Arc<dyn TradingCalendar>,
}

impl GapBackfiller {
    pub fn new(executor: Arc<FetchExecutor>, reader: Arc<dyn RawBarReader>,
               registry: Arc<dyn SymbolRegistry>, clock: Arc<dyn Clock>,
               calendar: Arc<dyn TradingCalendar>) -> Self {
        Self { executor, reader, registry, clock, calendar }
    }

    /// 当日缺口回填一轮：返回触发回填的 code 数。非交易日整轮跳过（节假日零噪音）。
    pub async fn backfill_today(&self) -> anyhow::Result<usize> {
        let now = self.clock.now();
        let today = utc_to_cst(now).date();
        if !self.calendar.is_trading_day(today) { return Ok(0); }
        let mut touched = 0usize;
        for code in self.registry.enabled_codes().await? {
            let existing = self.reader.existing_ts(&code, today).await?;
            let gaps = compute_gaps(&existing, today, now, true);
            if gaps.is_empty() { continue; }
            tracing::info!(code = %code.0, gaps = gaps.len(), "gap backfill start");
            self.executor.fetch_one(&code, GAP_LIMIT).await; // 首写胜出只补缺的部分
            touched += 1;
        }
        Ok(touched)
    }
}
// ~/~ end
