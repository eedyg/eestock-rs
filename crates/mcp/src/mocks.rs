// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/mocks.rs>>[init]
//! 测试替身（仅 #[cfg(test)] 单测用）：mock domain 只读端口装配 McpState——
//! 证明 mcp 与 storage 解耦（分层红线；真实装配由 tests/mcp_tools_db.rs 经 storage 实现锁定）。

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{HealthEventRow, HealthEventsRead, KlineBarView, KlineRead, SymbolLatestView};
use domain::types::Period;
use std::sync::{Arc, Mutex};

use crate::state::McpState;

/// bars 调用记录（断言参数映射/钳制）。
#[derive(Debug, Clone)]
pub struct BarsCall {
    pub period: Period,
    pub code: String,
    pub before: Option<DateTime<Utc>>,
    pub limit: i64,
}

/// mock KlineRead：记录调用参数；正常返回两根升序 1m bar（source=tencent_ifzq）；failing → Err。
pub struct MockKline {
    pub calls: Mutex<Vec<BarsCall>>,
    pub fail: bool,
}

impl MockKline {
    pub fn new() -> Self { Self { calls: Mutex::new(vec![]), fail: false } }
    pub fn failing() -> Self { Self { calls: Mutex::new(vec![]), fail: true } }
}

/// 两根升序样例 bar（收盘 1.00 / 1.05）。
pub fn sample_bars(code: &str) -> Vec<KlineBarView> {
    let base = Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap();
    (0..2i64).map(|i| KlineBarView {
        code: code.into(),
        ts: base + Duration::minutes(i),
        open: 1.0, high: 1.1, low: 0.9, close: 1.0 + i as f64 * 0.05,
        volume: 100, amount: 105.0, source: Some("tencent_ifzq".into()),
    }).collect()
}

#[async_trait::async_trait]
impl KlineRead for MockKline {
    async fn bars(&self, period: Period, code: &str,
                  before: Option<DateTime<Utc>>, limit: i64)
        -> anyhow::Result<Vec<KlineBarView>> {
        self.calls.lock().expect("calls poisoned")
            .push(BarsCall { period, code: code.into(), before, limit });
        if self.fail { anyhow::bail!("mock kline failure"); }
        Ok(sample_bars(code))
    }

    async fn symbols_with_latest(&self) -> anyhow::Result<Vec<SymbolLatestView>> { Ok(vec![]) }
}

/// mock HealthEventsRead：记录窗口参数；正常返回一条 mock_src 成功事件；failing → Err。
pub struct MockEvents {
    pub windows: Mutex<Vec<i64>>,
    pub fail: bool,
}

impl MockEvents {
    pub fn new() -> Self { Self { windows: Mutex::new(vec![]), fail: false } }
    pub fn failing() -> Self { Self { windows: Mutex::new(vec![]), fail: true } }
}

#[async_trait::async_trait]
impl HealthEventsRead for MockEvents {
    async fn window_events(&self, window_secs: i64) -> anyhow::Result<Vec<HealthEventRow>> {
        self.windows.lock().expect("windows poisoned").push(window_secs);
        if self.fail { anyhow::bail!("mock events failure"); }
        Ok(vec![HealthEventRow {
            ts: Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap(),
            source: "mock_src".into(), ok: true, latency_ms: Some(80),
            err_kind: None, code: None,
        }])
    }
}

/// 装配测试用 McpState（default_window_secs=3600）。
pub fn test_state(kline: Arc<MockKline>, events: Arc<MockEvents>) -> Arc<McpState> {
    Arc::new(McpState {
        kline,
        health: diagnose::health::HealthService::new(events),
        default_window_secs: 3600,
        sessions: crate::state::SessionRegistry::default(),
    })
}
// ~/~ end
