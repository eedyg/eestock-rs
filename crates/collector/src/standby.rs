// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/standby.rs>>[init]
//! 冷藏备援：快照池平时零请求；attempt_chain 全链失败的标的进入降级模式——
//! 快照池随机打乱逐源 5-10s 轮询，本地合成近似 1m bar（source=*_approx）；
//! Tier2 源失败指数退避；Tier1 恢复探测成功 → 回切正常。

use crate::clock::Clock;
use chrono::{DateTime, Duration, Timelike, Utc};
use domain::provider::{ProviderError, SnapshotProvider};
use domain::types::*;
use rand::Rng;
use rand::seq::SliceRandom;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub struct StandbyReserve {
    pool: Vec<Arc<dyn SnapshotProvider>>,
    clock: Arc<dyn Clock>,
    degraded: Mutex<HashSet<Code>>,
    fail_counts: Mutex<HashMap<SourceId, u32>>,
    muted_until: Mutex<HashMap<SourceId, DateTime<Utc>>>,
    last_quotes: Mutex<HashMap<Code, Quote>>,
}

impl StandbyReserve {
    pub fn new(pool: Vec<Arc<dyn SnapshotProvider>>, clock: Arc<dyn Clock>) -> Self {
        Self { pool, clock, degraded: Mutex::new(HashSet::new()),
               fail_counts: Mutex::new(HashMap::new()), muted_until: Mutex::new(HashMap::new()),
               last_quotes: Mutex::new(HashMap::new()) }
    }

    pub fn activate(&self, code: &Code) { self.degraded.lock().unwrap().insert(code.clone()); }
    pub fn deactivate(&self, code: &Code) { self.degraded.lock().unwrap().remove(code); }
    pub fn is_degraded(&self, code: &Code) -> bool { self.degraded.lock().unwrap().contains(code) }
    pub fn degraded_codes(&self) -> Vec<Code> { self.degraded.lock().unwrap().iter().cloned().collect() }

    /// 轮询间隔：5-10s（含随机抖动，§6）。
    pub fn next_poll_delay<R: Rng>(rng: &mut R) -> std::time::Duration {
        std::time::Duration::from_millis(rng.gen_range(5000..=10000))
    }

    /// Tier2 源失败退避：10s 指数 ×2 封顶 300s（激活期内冷却，不轰击）。
    pub fn tier2_backoff(fail_count: u32) -> Duration {
        Duration::seconds((10i64 << fail_count.min(5)).min(300))
    }

    /// 分钟边界（bar 起始时刻对齐；UTC/CST 同为整分钟偏移，floor 一致）。
    pub fn minute_floor(ts: DateTime<Utc>) -> DateTime<Utc> {
        ts.with_second(0).and_then(|t| t.with_nanosecond(0)).expect("valid minute floor")
    }

    /// 本地合成近似 1m bar（§6）：OHLC≈快照价、volume/amount 差分估算或 0、source=*_approx。
    pub fn synthesize(code: &Code, q: &Quote, prev: Option<&Quote>, minute_start: DateTime<Utc>) -> Bar {
        Bar {
            code: code.clone(),
            period: Period::M1,
            ts: minute_start,
            open: q.last, high: q.last, low: q.last, close: q.last,
            volume: prev.map(|p| q.volume.saturating_sub(p.volume)).unwrap_or(0),
            amount: prev.map(|p| (q.amount - p.amount).max(0.0)).unwrap_or(0.0),
            source: q.source.approx().expect("快照池源必有近似变体（domain SourceId::approx）"),
        }
    }

    /// 恢复探测口径：Tier1 有可用源即可探测（§6：HalfOpen 探测成功 → 回切）。
    pub fn should_probe_recover(healthy_tier1: &[SourceId]) -> bool { !healthy_tier1.is_empty() }

    fn is_muted(&self, src: SourceId, now: DateTime<Utc>) -> bool {
        self.muted_until.lock().unwrap().get(&src).map(|u| now < *u).unwrap_or(false)
    }

    fn record_failure(&self, src: SourceId, now: DateTime<Utc>) {
        let mut fc = self.fail_counts.lock().unwrap();
        let n = fc.entry(src).or_insert(0);
        *n = (*n + 1).min(10);
        self.muted_until.lock().unwrap().insert(src, now + Self::tier2_backoff(*n - 1));
    }

    fn record_success(&self, src: SourceId) {
        self.fail_counts.lock().unwrap().remove(&src);
        self.muted_until.lock().unwrap().remove(&src);
    }

    /// 降级模式单次轮询：快照池随机打乱后逐源尝试（跳过退避中的源）。
    pub async fn poll_once(&self, code: &Code) -> Result<Bar, ProviderError> {
        let now = self.clock.now();
        let mut order: Vec<&Arc<dyn SnapshotProvider>> = self.pool.iter().collect();
        order.shuffle(&mut rand::thread_rng()); // §6：每次随机打乱（非固定优先级）
        let mut last_err = ProviderError::NoData;
        for p in order {
            let src = p.id();
            if self.is_muted(src, now) { continue; }
            match p.fetch_snapshot(std::slice::from_ref(code)).await {
                Ok(quotes) => {
                    match quotes.into_iter().find(|q| q.code == *code) {
                        Some(q) => {
                            self.record_success(src);
                            let prev = self.last_quotes.lock().unwrap().get(code).cloned();
                            let bar = Self::synthesize(code, &q, prev.as_ref(), Self::minute_floor(now));
                            self.last_quotes.lock().unwrap().insert(code.clone(), q);
                            return Ok(bar);
                        }
                        None => { self.record_failure(src, now); }
                    }
                }
                Err(e) => { self.record_failure(src, now); last_err = e; }
            }
        }
        Err(last_err)
    }
}
// ~/~ end
