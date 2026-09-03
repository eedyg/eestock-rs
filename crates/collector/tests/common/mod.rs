// ~/~ begin <<design/03-collector/00-design.md#crates/collector/tests/common/mod.rs>>[init]
//! 测试公共设件：内存 EventSink / KlineWriter / RawBarReader / SymbolRegistry + 脚本化 mock Provider。
#![allow(dead_code)]

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use domain::ports::{EventSink, HealthEvent, KlineWriter, RawBarReader, SymbolRegistry};
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::types::*;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Default)]
pub struct MemSink { pub events: Mutex<Vec<HealthEvent>> }

#[async_trait]
impl EventSink for MemSink {
    async fn emit(&self, ev: HealthEvent) -> anyhow::Result<()> {
        self.events.lock().unwrap().push(ev);
        Ok(())
    }
}

impl MemSink {
    pub fn kinds(&self) -> Vec<Option<String>> {
        self.events.lock().unwrap().iter().map(|e| e.err_kind.map(|k| k.as_str().to_string())).collect()
    }
}

#[derive(Default)]
pub struct MemWriter { pub bars: Mutex<Vec<Bar>> }

#[async_trait]
impl KlineWriter for MemWriter {
    async fn write_batch(&self, bars: &[Bar]) -> anyhow::Result<usize> {
        // 模拟首写胜出：同 (code,ts) 已存在则跳过
        let mut g = self.bars.lock().unwrap();
        let mut n = 0;
        for b in bars {
            if !g.iter().any(|x| x.code == b.code && x.ts == b.ts) { g.push(b.clone()); n += 1; }
        }
        Ok(n)
    }
}

pub type TsKey = (String, NaiveDate);

#[derive(Default)]
pub struct MemReader { pub ts: Mutex<HashMap<TsKey, HashSet<DateTime<Utc>>>> }

#[async_trait]
impl RawBarReader for MemReader {
    async fn existing_ts(&self, code: &Code, date: NaiveDate)
        -> anyhow::Result<HashSet<DateTime<Utc>>> {
        Ok(self.ts.lock().unwrap().get(&(code.0.clone(), date)).cloned().unwrap_or_default())
    }
}

pub struct MemRegistry {
    pub codes: Mutex<Vec<(Code, u64)>>,
}

#[async_trait]
impl SymbolRegistry for MemRegistry {
    async fn enabled_codes(&self) -> anyhow::Result<Vec<Code>> {
        Ok(self.codes.lock().unwrap().iter().map(|(c, _)| c.clone()).collect())
    }
    async fn interval_secs(&self, code: &Code) -> anyhow::Result<u64> {
        Ok(self.codes.lock().unwrap().iter().find(|(c, _)| c == code)
            .map(|(_, i)| *i).unwrap_or(60))
    }
    async fn upsert(&self, code: Code, interval_secs: u64, _enabled: bool) -> anyhow::Result<()> {
        self.codes.lock().unwrap().push((code, interval_secs));
        Ok(())
    }
}

/// 脚本化 mock Provider：按序返回预设结果，记录调用。
pub struct MockMinute {
    pub id: SourceId,
    pub results: Mutex<Vec<Result<Vec<Bar>, ProviderError>>>,
    pub calls: Mutex<usize>,
}

impl MockMinute {
    pub fn new(id: SourceId, results: Vec<Result<Vec<Bar>, ProviderError>>) -> Self {
        Self { id, results: Mutex::new(results), calls: Mutex::new(0) }
    }
    pub fn calls(&self) -> usize { *self.calls.lock().unwrap() }
}

#[async_trait]
impl MinuteKlineProvider for MockMinute {
    fn id(&self) -> SourceId { self.id }
    async fn fetch_m1(&self, _code: &Code, _limit: usize) -> Result<Vec<Bar>, ProviderError> {
        *self.calls.lock().unwrap() += 1;
        let mut g = self.results.lock().unwrap();
        if g.is_empty() { Err(ProviderError::NoData) } else { g.remove(0) }
    }
}

pub fn bar(code: &str, h: u32, mi: u32, src: SourceId) -> Bar {
    Bar {
        code: Code(code.into()), period: Period::M1,
        ts: Utc.with_ymd_and_hms(2026, 9, 3, h, mi, 0).unwrap(),
        open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 100, amount: 100.0, source: src,
    }
}

pub fn quote(code: &str, last: f64, vol: u64, amt: f64, src: SourceId) -> Quote {
    Quote {
        code: Code(code.into()), last, prev_close: last, volume: vol, amount: amt,
        data_ts: Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap(), source: src,
    }
}
// ~/~ end
