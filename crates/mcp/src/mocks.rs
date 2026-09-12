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
/// `registered` = symbols 注册表口径（`symbols_with_latest` 返回；get_kline 注册成员校验输入——
/// I-1：未注册 code 必须显式 isError，不得静默空）；`empty_bars` = 已注册但区间无数据（bars 空集）；
/// `registry_fail` = 注册表查询失败（fail-closed 路径）。
pub struct MockKline {
    pub calls: Mutex<Vec<BarsCall>>,
    pub fail: bool,
    pub registered: Vec<String>,
    pub empty_bars: bool,
    pub registry_fail: bool,
}

impl MockKline {
    /// 缺省注册表 = ["518880"]（既有用例口径；518880 为平台已注册标的）。
    pub fn new() -> Self {
        Self { calls: Mutex::new(vec![]), fail: false, registered: vec!["518880".into()],
               empty_bars: false, registry_fail: false }
    }
    /// 自定义注册表（未注册 / 多标的用例）。
    pub fn with_registered(codes: &[&str]) -> Self {
        Self { registered: codes.iter().map(|c| (*c).into()).collect(), ..Self::new() }
    }
    /// bars 端口失败（isError 路径）。
    pub fn failing() -> Self { Self { fail: true, ..Self::new() } }
    /// 已注册但区间无数据（bars 返回空集——与「未注册」语义必须区分）。
    pub fn empty_bars() -> Self { Self { empty_bars: true, ..Self::new() } }
    /// 注册表查询失败（fail-closed：无法确认注册即拒）。
    pub fn failing_registry() -> Self { Self { registry_fail: true, ..Self::new() } }
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
        if self.empty_bars { return Ok(vec![]); }
        Ok(sample_bars(code))
    }

    /// symbols 注册表口径（I-1：get_kline 以注册表判定「标的存在」，不以「有无 K 线」推断）。
    async fn symbols_with_latest(&self) -> anyhow::Result<Vec<SymbolLatestView>> {
        if self.registry_fail { anyhow::bail!("mock registry failure"); }
        Ok(self.registered.iter().map(|c| SymbolLatestView {
            code: c.clone(), name: Some(format!("mock {c}")), interval_secs: 60,
            settlement: "T1".into(), enabled: true,
            last_ts: None, last_close: None, prev_close: None,
        }).collect())
    }
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

/// 装配测试用 McpState（default_window_secs=3600；质量服务默认空口径；
/// P3c 策略/工作台服务 None——strategy_*/bt_* 走「未配置 isError」路径，开关默认开）。
pub fn test_state(kline: Arc<MockKline>, events: Arc<MockEvents>) -> Arc<McpState> {
    Arc::new(McpState {
        kline,
        health: diagnose::health::HealthService::new(events),
        quality: quality_for(vec![], HashMap::new(), HashSet::new()),
        default_window_secs: 3600,
        sessions: crate::state::SessionRegistry::default(),
        sim: None,
        strategies: None,
        workbench: None,
        strategy_tools_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    })
}
// ~/~ end
