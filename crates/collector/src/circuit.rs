// ~/~ begin <<design/03-collector/00-design.md#crates/collector/src/circuit.rs>>[init]
//! 熔断状态机：Healthy --连续3败--> Open --冷却60s--> HalfOpen --单次成功--> Healthy；
//! HalfOpen 失败 --> Open（冷却×2 封顶 30min）；RateLimited 不进熔断计数，走 5s→10s→30s 退避；
//! 手动复位任意态 → Healthy。状态迁移事件落 source_health_events（§7）。

use crate::clock::Clock;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use domain::ports::{ErrKind, EventSink, HealthEvent, HealthMonitor};
use domain::types::{Health, SourceId};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const FAIL_THRESHOLD: u32 = 3;
pub const BASE_COOLDOWN: Duration = Duration::seconds(60);
pub const MAX_COOLDOWN: Duration = Duration::minutes(30);
/// RateLimited 退避档：5s→10s→30s（封顶保持 30s）。
pub const RL_LADDER: [Duration; 3] =
    [Duration::seconds(5), Duration::seconds(10), Duration::seconds(30)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState { Healthy, Open, HalfOpen }

#[derive(Debug, Clone)]
struct Entry {
    state: CircuitState,
    consecutive_failures: u32,
    opened_at: DateTime<Utc>,
    cooldown: Duration,
    rl_count: u32,
    rl_muted_until: Option<DateTime<Utc>>,
}

impl Entry {
    fn new(now: DateTime<Utc>) -> Self {
        Self { state: CircuitState::Healthy, consecutive_failures: 0, opened_at: now,
               cooldown: BASE_COOLDOWN, rl_count: 0, rl_muted_until: None }
    }
}

pub struct CircuitRegistry {
    tier1: Vec<SourceId>,
    clock: Arc<dyn Clock>,
    sink: Arc<dyn EventSink>,
    entries: Mutex<HashMap<SourceId, Entry>>,
}

impl CircuitRegistry {
    pub fn new(tier1: Vec<SourceId>, clock: Arc<dyn Clock>, sink: Arc<dyn EventSink>) -> Self {
        Self { tier1, clock, sink, entries: Mutex::new(HashMap::new()) }
    }

    async fn emit_migration(&self, src: SourceId, kind: ErrKind) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: src, ok: false, latency_ms: None,
            err_kind: Some(kind), code: None, trace_id: None,
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(source = src.as_str(), error = %e, "circuit migration event emit failed");
        }
    }

    /// 懒迁移：Open 冷却到期 → HalfOpen（返回需发出的迁移事件）。
    fn resolve(entry: &mut Entry, now: DateTime<Utc>) -> Option<ErrKind> {
        if entry.state == CircuitState::Open && now >= entry.opened_at + entry.cooldown {
            entry.state = CircuitState::HalfOpen;
            return Some(ErrKind::CircuitHalfopen);
        }
        None
    }

    fn usable(entry: &Entry, now: DateTime<Utc>) -> bool {
        entry.state == CircuitState::Healthy
            && entry.rl_muted_until.map(|u| now >= u).unwrap_or(true)
    }

    /// 手动复位（诊断面板 POST /sources/{id}/reset，Wave 1 走 DB 控制通道）：任意态 → Healthy。
    pub async fn manual_reset(&self, src: SourceId) {
        {
            let mut g = self.entries.lock().await;
            *g.entry(src).or_insert_with(|| Entry::new(self.clock.now())) =
                Entry::new(self.clock.now());
        }
        self.emit_migration(src, ErrKind::ManualReset).await;
    }

    /// 当前状态（测试/诊断用，含懒迁移）。
    pub async fn state(&self, src: SourceId) -> CircuitState {
        let now = self.clock.now();
        let (state, migration) = {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(now));
            let m = Self::resolve(e, now);
            (e.state, m)
        };
        if let Some(kind) = migration { self.emit_migration(src, kind).await; }
        state
    }

    /// HalfOpen 态 Tier1 源（低频探测任务用，§4；含懒迁移 Open→HalfOpen 及事件）。
    pub async fn halfopen_sources(&self) -> Vec<SourceId> {
        let now = self.clock.now();
        let mut out = Vec::new();
        let mut migrations = Vec::new();
        {
            let mut g = self.entries.lock().await;
            for src in &self.tier1 {
                let e = g.entry(*src).or_insert_with(|| Entry::new(now));
                if let Some(kind) = Self::resolve(e, now) { migrations.push((*src, kind)); }
                if e.state == CircuitState::HalfOpen { out.push(*src); }
            }
        }
        for (src, kind) in migrations { self.emit_migration(src, kind).await; }
        out
    }
}

#[async_trait]
impl HealthMonitor for CircuitRegistry {
    async fn report_success(&self, src: SourceId, _latency_ms: u64) {
        let mut closed = false;
        {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(self.clock.now()));
            e.consecutive_failures = 0;
            e.rl_count = 0;
            e.rl_muted_until = None;
            if e.state == CircuitState::HalfOpen {
                e.state = CircuitState::Healthy;
                e.cooldown = BASE_COOLDOWN;
                closed = true;
            }
        }
        if closed { self.emit_migration(src, ErrKind::CircuitClosed).await; }
    }

    async fn report_failure(&self, src: SourceId, err_kind: &str) {
        let now = self.clock.now();
        let mut migration = None;
        {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(now));
            if err_kind == ErrKind::RateLimited.as_str() {
                // 限流不进熔断计数：5s→10s→30s 退避档静默该源（§4）
                e.rl_muted_until = Some(now + RL_LADDER[(e.rl_count as usize).min(2)]);
                e.rl_count = (e.rl_count + 1).min(u32::MAX - 1);
            } else {
                e.consecutive_failures += 1;
                match e.state {
                    CircuitState::HalfOpen => {
                        e.state = CircuitState::Open;
                        e.opened_at = now;
                        e.cooldown = (e.cooldown * 2).min(MAX_COOLDOWN);
                        migration = Some(ErrKind::CircuitOpen);
                    }
                    CircuitState::Healthy if e.consecutive_failures >= FAIL_THRESHOLD => {
                        e.state = CircuitState::Open;
                        e.opened_at = now;
                        e.cooldown = BASE_COOLDOWN;
                        migration = Some(ErrKind::CircuitOpen);
                    }
                    _ => {}
                }
            }
        }
        if let Some(kind) = migration { self.emit_migration(src, kind).await; }
    }

    async fn health(&self, src: SourceId) -> Health {
        let now = self.clock.now();
        let (state, rl_muted, migration) = {
            let mut g = self.entries.lock().await;
            let e = g.entry(src).or_insert_with(|| Entry::new(now));
            let m = Self::resolve(e, now);
            (e.state, e.rl_muted_until.map(|u| now < u).unwrap_or(false), m)
        };
        if let Some(kind) = migration { self.emit_migration(src, kind).await; }
        match state {
            CircuitState::Healthy if rl_muted => Health::Degraded,
            CircuitState::Healthy => Health::Healthy,
            CircuitState::Open | CircuitState::HalfOpen => Health::CircuitOpen,
        }
    }

    async fn healthy_minute_sources(&self) -> Vec<SourceId> {
        let now = self.clock.now();
        let mut out = Vec::new();
        let mut migrations = Vec::new();
        {
            let mut g = self.entries.lock().await;
            for src in &self.tier1 {
                let e = g.entry(*src).or_insert_with(|| Entry::new(now));
                if let Some(kind) = Self::resolve(e, now) { migrations.push((*src, kind)); }
                if Self::usable(e, now) { out.push(*src); }
            }
        }
        for (src, kind) in migrations { self.emit_migration(src, kind).await; }
        out
    }
}
// ~/~ end
