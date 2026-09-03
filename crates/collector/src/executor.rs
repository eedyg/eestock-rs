// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/executor.rs>>[init]
//! 单次抓取执行器：attempt_chain（当班源优先 + 注册序轮转）+ 首写胜出 + Trace ID 贯穿。

use crate::circuit::CircuitRegistry;
use crate::clock::Clock;
use chrono::{DateTime, Utc};
use domain::ports::{ErrKind, EventSink, HealthEvent, HealthMonitor, KlineWriter};
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::*;
use std::collections::HashMap;
use std::sync::Arc;

/// ProviderError → ErrKind（01-providers-spec §4 统一口径）。
pub fn err_kind_of(e: &ProviderError) -> ErrKind {
    match e {
        ProviderError::Timeout => ErrKind::Timeout,
        ProviderError::Http(_) => ErrKind::Http,
        ProviderError::Parse(_) => ErrKind::Parse,
        ProviderError::RateLimited => ErrKind::RateLimited,
        ProviderError::NoData => ErrKind::Na,
    }
}

/// FNV-1a 稳定散列：当班窗偏移/乱序的种子（确定性、测试可复现）。
pub fn stable_seed(s: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in s.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}

/// ADR-015：时间窗轮换当班。窗界切换带 0-30s 偏移（按 code 稳定散列，各标的非同刻切换）。
pub fn duty_for(roster: &DutyRoster, code: &Code, now: DateTime<Utc>) -> SourceId {
    let seed = stable_seed(&code.0);
    let shifted = now + chrono::Duration::seconds((seed % 31) as i64);
    roster.duty_at((shifted.timestamp() / 60) as u64, seed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchOutcome {
    Ok { source: SourceId, fetched: usize, inserted: usize },
    NoData,
    AllFailed,
}

pub struct FetchExecutor {
    providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>>,
    selector: SourceSelector,
    roster: DutyRoster,
    circuits: Arc<CircuitRegistry>,
    writer: Arc<dyn KlineWriter>,
    sink: Arc<dyn EventSink>,
    clock: Arc<dyn Clock>,
}

impl FetchExecutor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>>,
        selector: SourceSelector,
        roster: DutyRoster,
        circuits: Arc<CircuitRegistry>,
        writer: Arc<dyn KlineWriter>,
        sink: Arc<dyn EventSink>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { providers, selector, roster, circuits, writer, sink, clock }
    }

    /// 熔断注册表访问口（service 降级恢复探测用）。
    pub fn circuits(&self) -> &Arc<CircuitRegistry> { &self.circuits }

    async fn emit(&self, src: SourceId, ok: bool, latency_ms: Option<u32>,
                  err: Option<ErrKind>, code: Option<&Code>, trace_id: &str) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: src, ok, latency_ms, err_kind: err,
            code: code.cloned(), trace_id: Some(trace_id.to_string()),
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(source = src.as_str(), error = %e, "event emit failed");
        }
    }

    /// 对 code 执行一次 attempt_chain 抓取（§3）：单批次内按序转移、粘源、NoData 不计失败。
    pub async fn fetch_one(&self, code: &Code, limit: usize) -> FetchOutcome {
        let trace_id = new_trace_id();
        let now = self.clock.now();
        let duty = duty_for(&self.roster, code, now);
        let healthy = self.circuits.healthy_minute_sources().await;
        let chain = self.selector.attempt_chain(duty, &healthy);
        if chain.is_empty() {
            tracing::warn!(code = %code.0, trace_id, "attempt_chain empty: all tier1 sources unusable");
            self.emit(duty, false, None, Some(ErrKind::AllFailed), Some(code), &trace_id).await;
            return FetchOutcome::AllFailed;
        }
        for src in &chain {
            let provider = &self.providers[src];
            let t0 = std::time::Instant::now();
            match provider.fetch_m1(code, limit).await {
                Ok(bars) => {
                    let latency = t0.elapsed().as_millis() as u64;
                    self.circuits.report_success(*src, latency).await;
                    self.emit(*src, true, Some(latency as u32), None, Some(code), &trace_id).await;
                    return match self.writer.write_batch(&bars).await {
                        Ok(inserted) => {
                            tracing::info!(code = %code.0, source = src.as_str(), trace_id,
                                fetched = bars.len(), inserted, "fetch ok");
                            FetchOutcome::Ok { source: *src, fetched: bars.len(), inserted }
                        }
                        Err(e) => {
                            tracing::error!(code = %code.0, trace_id, error = %e, "kline write failed");
                            FetchOutcome::AllFailed
                        }
                    };
                }
                Err(ProviderError::NoData) => {
                    // 记 NA 不记失败（非交易时段/新上市），不转移（本批次终止）
                    self.emit(*src, true, None, Some(ErrKind::Na), Some(code), &trace_id).await;
                    return FetchOutcome::NoData;
                }
                Err(e) => {
                    let kind = err_kind_of(&e);
                    self.emit(*src, false, None, Some(kind), Some(code), &trace_id).await;
                    self.circuits.report_failure(*src, kind.as_str()).await;
                    tracing::warn!(code = %code.0, source = src.as_str(), trace_id,
                        err_kind = kind.as_str(), "fetch failed, try next source");
                }
            }
        }
        // 全链失败 → code 级失败事件（诊断面板缺口率的因，§3）
        self.emit(duty, false, None, Some(ErrKind::AllFailed), Some(code), &trace_id).await;
        FetchOutcome::AllFailed
    }
}
// ~/~ end
