// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/gapfill.rs>>[init]
//! 当日缺口回填：启动时 + 每 30 分钟。缺口 = 当日交易分钟序列 − kline_raw 已有 ts（仅当日；
//! 更早历史缺口归 tushare 准确层，ADR-003）。只拉已过去的分钟（未来分钟不是缺口）。

use crate::calendar::{is_weekday, trading_minutes};
use crate::clock::Clock;
use crate::executor::FetchExecutor;
use chrono::{DateTime, NaiveDate, Timelike, Utc};
use domain::ports::{RawBarReader, SymbolRegistry};
use domain::tz::{cst_to_utc, utc_to_cst};
use std::collections::HashSet;
use std::sync::Arc;

pub const BACKFILL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30 * 60);
pub const GAP_LIMIT: usize = 240;

/// 缺口集合：当日已过去的交易分钟（bar 起始时刻）− existing。非当日/非交易日 → 空。
pub fn compute_gaps(existing: &HashSet<DateTime<Utc>>, date: NaiveDate, now: DateTime<Utc>)
    -> Vec<DateTime<Utc>> {
    let cst_now = utc_to_cst(now);
    if cst_now.date() != date || !is_weekday(date) { return vec![]; }
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
}

impl GapBackfiller {
    pub fn new(executor: Arc<FetchExecutor>, reader: Arc<dyn RawBarReader>,
               registry: Arc<dyn SymbolRegistry>, clock: Arc<dyn Clock>) -> Self {
        Self { executor, reader, registry, clock }
    }

    /// 当日缺口回填一轮：返回触发回填的 code 数。
    pub async fn backfill_today(&self) -> anyhow::Result<usize> {
        let now = self.clock.now();
        let today = utc_to_cst(now).date();
        if !is_weekday(today) { return Ok(0); }
        let mut touched = 0usize;
        for code in self.registry.enabled_codes().await? {
            let existing = self.reader.existing_ts(&code, today).await?;
            let gaps = compute_gaps(&existing, today, now);
            if gaps.is_empty() { continue; }
            tracing::info!(code = %code.0, gaps = gaps.len(), "gap backfill start");
            self.executor.fetch_one(&code, GAP_LIMIT).await; // 首写胜出只补缺的部分
            touched += 1;
        }
        Ok(touched)
    }
}
// ~/~ end
