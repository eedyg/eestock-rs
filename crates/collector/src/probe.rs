// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/probe.rs>>[init]
//! 熔断低频探测任务（§4）：对 HalfOpen 态 Tier1 源在冷却到期后单发轻量探测
//! （1 只代表标的 m1、limit=1，不占交易抓取通道、不影响当班轮换）。
//! 成功（含 NoData=源可达口径）→ report_success 闭合熔断（circuit_closed 事件）；
//! 失败 → report_failure 重开熔断、冷却翻倍（封顶 30min，circuit.rs 既有语义）。
//! 探测闭合后健康池恢复非空，降级标的由 §6 degraded_loop 恢复探测接管回切。

use crate::circuit::CircuitRegistry;
use crate::clock::Clock;
use domain::ports::{ErrKind, EventSink, HealthEvent, HealthMonitor, SymbolRegistry};
use domain::provider::{MinuteKlineProvider, ProviderError};
use domain::types::*;
use std::collections::HashMap;
use std::sync::Arc;

/// 探测轻量口径：单只代表标的、limit=1 根 m1。
pub const PROBE_LIMIT: usize = 1;
/// 探测节拍：60s 扫一轮（低频）；重试节奏由熔断冷却翻倍主导（60s→…→30min 封顶）。
pub const PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

pub struct CircuitProber {
    providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>>,
    circuits: Arc<CircuitRegistry>,
    registry: Arc<dyn SymbolRegistry>,
    sink: Arc<dyn EventSink>,
    clock: Arc<dyn Clock>,
}

impl CircuitProber {
    pub fn new(
        providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>>,
        circuits: Arc<CircuitRegistry>,
        registry: Arc<dyn SymbolRegistry>,
        sink: Arc<dyn EventSink>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { providers, circuits, registry, sink, clock }
    }

    async fn emit(&self, src: SourceId, ok: bool, latency_ms: Option<u32>,
                  err: Option<ErrKind>, code: &Code, trace_id: &str) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: src, ok, latency_ms, err_kind: err,
            code: Some(code.clone()), trace_id: Some(trace_id.to_string()),
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(source = src.as_str(), error = %e, "probe event emit failed");
        }
    }

    /// 单轮探测：对每个 HalfOpen Tier1 源单发一次轻量探测（返回探测源数）。
    /// 无 HalfOpen 源 / 无启用标的 → 整轮零调用（不占交易抓取通道）。
    pub async fn probe_round(&self) -> usize {
        let halfopen = self.circuits.halfopen_sources().await;
        if halfopen.is_empty() { return 0; }
        let code = match self.registry.enabled_codes().await {
            Ok(c) if !c.is_empty() => c[0].clone(),
            Ok(_) => { tracing::warn!("circuit probe: no enabled codes, skip round"); return 0; }
            Err(e) => { tracing::warn!(error = %e, "circuit probe: read symbols failed"); return 0; }
        };
        let mut probed = 0;
        for src in halfopen {
            let Some(provider) = self.providers.get(&src) else { continue };
            probed += 1;
            let trace_id = new_trace_id();
            let t0 = std::time::Instant::now();
            match provider.fetch_m1(&code, PROBE_LIMIT).await {
                Ok(_) => {
                    let latency = t0.elapsed().as_millis() as u64;
                    // HalfOpen 单次成功 → Healthy + circuit_closed（circuit.rs §4）
                    self.circuits.report_success(src, latency).await;
                    self.emit(src, true, Some(latency as u32), None, &code, &trace_id).await;
                    tracing::info!(source = src.as_str(), code = %code.0, trace_id,
                        "circuit probe ok -> closed");
                }
                Err(ProviderError::NoData) => {
                    // NoData=源应答正常（非交易时段/无数据）：视为可达闭合熔断（§7 na 口径）
                    self.circuits.report_success(src, 0).await;
                    self.emit(src, true, None, Some(ErrKind::Na), &code, &trace_id).await;
                    tracing::info!(source = src.as_str(), code = %code.0, trace_id,
                        "circuit probe reachable (na) -> closed");
                }
                Err(e) => {
                    let kind = crate::executor::err_kind_of(&e);
                    self.emit(src, false, None, Some(kind), &code, &trace_id).await;
                    // HalfOpen 失败 → Open + 冷却 ×2 封顶 30min（circuit.rs 既有语义）
                    self.circuits.report_failure(src, kind.as_str()).await;
                    tracing::warn!(source = src.as_str(), code = %code.0, trace_id,
                        err_kind = kind.as_str(), "circuit probe failed -> reopen, cooldown doubled");
                }
            }
        }
        probed
    }
}

/// 探测任务主循环（薄胶合）：固定节拍扫描 HalfOpen 源，单轮逻辑见 probe_round（已单测）。
pub async fn run_forever(prober: Arc<CircuitProber>) {
    loop {
        tokio::time::sleep(PROBE_INTERVAL).await;
        prober.probe_round().await;
    }
}
// ~/~ end
