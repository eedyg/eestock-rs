// ~/~ begin <<design/07-app-plane/01-mcp.md#crates/mcp/src/mocks.rs>>[init]
//! 测试替身（仅 #[cfg(test)] 单测用）：mock domain 只读端口装配 McpState——
//! 证明 mcp 与 storage 解耦（分层红线；真实装配由 tests/mcp_tools_db.rs 经 storage 实现锁定）。

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use domain::ports::{
    Clock, DivergenceRow, HealthEventRow, HealthEventsRangeRead, HealthEventsRead,
    HolidayCalendarRead, KlineBarView, KlineRead, QualityRead, RawBarReader, SyncCheckpointView,
    SymbolLatestView, TushareStatusRead,
};
use domain::types::{Code, Period};
use std::collections::{HashMap, HashSet};
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

// ── Wave 2 Phase A：质量端口 mock（MCP④ get_data_quality 测试）──

struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock { fn now(&self) -> DateTime<Utc> { self.0 } }

/// mock QualityRead：返回预设对照行（可按 code 过滤）。
pub struct MockQualityRows(pub Vec<DivergenceRow>);

#[async_trait::async_trait]
impl QualityRead for MockQualityRows {
    async fn divergence_rows(&self, code: Option<&str>, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<DivergenceRow>> {
        Ok(self.0.iter().filter(|r| code.is_none_or(|c| r.code == c)).cloned().collect())
    }
}

/// mock RawBarReader：按 (code, date) 返回预设已有 ts 集合。
pub struct MockRawDays(pub HashMap<(String, NaiveDate), HashSet<DateTime<Utc>>>);

#[async_trait::async_trait]
impl RawBarReader for MockRawDays {
    async fn existing_ts(&self, code: &Code, date: NaiveDate)
        -> anyhow::Result<HashSet<DateTime<Utc>>> {
        Ok(self.0.get(&(code.0.clone(), date)).cloned().unwrap_or_default())
    }
}

/// mock HealthEventsRangeRead：恒空（缺口分类走 SystemGap 路径）。
pub struct MockRangeEvents;

#[async_trait::async_trait]
impl HealthEventsRangeRead for MockRangeEvents {
    async fn events_between(&self, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(vec![])
    }
}

/// mock HolidayCalendarRead：预设节假日集合。
pub struct MockHolidays(pub HashSet<NaiveDate>);

#[async_trait::async_trait]
impl HolidayCalendarRead for MockHolidays {
    async fn holidays(&self) -> anyhow::Result<HashSet<NaiveDate>> { Ok(self.0.clone()) }
}

/// mock TushareStatusRead：恒空检查点。
pub struct MockTushareStatus;

#[async_trait::async_trait]
impl TushareStatusRead for MockTushareStatus {
    async fn sync_checkpoints(&self) -> anyhow::Result<Vec<SyncCheckpointView>> { Ok(vec![]) }
}

/// 装配质量服务（mock 端口；时钟固定 2026-09-04 12:00 CST = 04:00 UTC——历史日全到期）。
pub fn quality_for(rows: Vec<DivergenceRow>,
                   raw: HashMap<(String, NaiveDate), HashSet<DateTime<Utc>>>,
                   holidays: HashSet<NaiveDate>) -> diagnose::quality::QualityService {
    diagnose::quality::QualityService::new(
        Arc::new(MockQualityRows(rows)), Arc::new(MockRawDays(raw)), Arc::new(MockRangeEvents),
        Arc::new(MockHolidays(holidays)), Arc::new(MockTushareStatus),
        Arc::new(FixedClock(Utc.with_ymd_and_hms(2026, 9, 4, 4, 0, 0).unwrap())))
}

/// 装配测试用 McpState（default_window_secs=3600；质量服务默认空口径）。
pub fn test_state(kline: Arc<MockKline>, events: Arc<MockEvents>) -> Arc<McpState> {
    Arc::new(McpState {
        kline,
        health: diagnose::health::HealthService::new(events),
        quality: quality_for(vec![], HashMap::new(), HashSet::new()),
        default_window_secs: 3600,
        sessions: crate::state::SessionRegistry::default(),
        sim: None,
    })
}
// ~/~ end
