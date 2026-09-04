// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/diagnose/tests/quality.rs>>[init]
//! QualityService 离线测试（mock 端口 + FixedClock，无 DB）：
//! 缺口日历口径（周末/节假日排除、未来分钟不算缺口）+ 三级分类 + 单日质量卡 + tushare 状态。

use chrono::{DateTime, NaiveDate, TimeZone, Timelike, Utc};
use diagnose::quality::*;
use domain::ports::*;
use domain::types::Code;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }

struct FixedClock(DateTime<Utc>);
impl Clock for FixedClock { fn now(&self) -> DateTime<Utc> { self.0 } }

struct MemQuality(Vec<DivergenceRow>);
#[async_trait::async_trait]
impl QualityRead for MemQuality {
    async fn divergence_rows(&self, code: Option<&str>, _f: DateTime<Utc>, _t: DateTime<Utc>)
        -> anyhow::Result<Vec<DivergenceRow>> {
        Ok(self.0.iter().filter(|r| code.is_none_or(|c| r.code == c)).cloned().collect())
    }
}

/// 测试内存已有-ts 表类型（提取 type 别名降 clippy 复杂度）。
type TsMap = HashMap<(String, NaiveDate), HashSet<DateTime<Utc>>>;

#[derive(Default)]
struct MemRaw { ts: Mutex<TsMap> }
#[async_trait::async_trait]
impl RawBarReader for MemRaw {
    async fn existing_ts(&self, code: &Code, date: NaiveDate)
        -> anyhow::Result<HashSet<DateTime<Utc>>> {
        Ok(self.ts.lock().unwrap().get(&(code.0.clone(), date)).cloned().unwrap_or_default())
    }
}

struct MemRangeEvents(Vec<HealthEventRow>);
#[async_trait::async_trait]
impl HealthEventsRangeRead for MemRangeEvents {
    async fn events_between(&self, from: DateTime<Utc>, to: DateTime<Utc>)
        -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(self.0.iter().filter(|e| e.ts >= from && e.ts < to).cloned().collect())
    }
}

struct MemHolidays(HashSet<NaiveDate>);
#[async_trait::async_trait]
impl HolidayCalendarRead for MemHolidays {
    async fn holidays(&self) -> anyhow::Result<HashSet<NaiveDate>> { Ok(self.0.clone()) }
}

struct MemTushare(Vec<SyncCheckpointView>);
#[async_trait::async_trait]
impl TushareStatusRead for MemTushare {
    async fn sync_checkpoints(&self) -> anyhow::Result<Vec<SyncCheckpointView>> { Ok(self.0.clone()) }
}

fn svc(now: DateTime<Utc>, raw: Arc<MemRaw>, evs: Vec<HealthEventRow>, hol: HashSet<NaiveDate>,
       rows: Vec<DivergenceRow>, cps: Vec<SyncCheckpointView>) -> QualityService {
    QualityService::new(Arc::new(MemQuality(rows)), raw, Arc::new(MemRangeEvents(evs)),
        Arc::new(MemHolidays(hol)), Arc::new(MemTushare(cps)), Arc::new(FixedClock(now)))
}

fn ev_cst(day: NaiveDate, h: u32, mi: u32, s: u32, ok: bool, kind: Option<&str>, code: &str)
    -> HealthEventRow {
    HealthEventRow {
        ts: domain::tz::cst_to_utc(day.and_hms_opt(h, mi, s).unwrap()),
        source: "tencent_ifzq".into(), ok, latency_ms: None,
        err_kind: kind.map(Into::into), code: Some(code.into()),
    }
}

/// 把某日全部 241 标签（除 skip 列出的 CST (h,m)）标为已有。
fn seed_all_except(raw: &MemRaw, code: &str, day: NaiveDate, skip: &[(u32, u32)]) {
    let set: HashSet<DateTime<Utc>> = domain::calendar::trading_minute_labels(day).into_iter()
        .filter(|l| !skip.contains(&(l.time().hour(), l.time().minute())))
        .map(domain::tz::cst_to_utc).collect();
    raw.ts.lock().unwrap().insert((code.into(), day), set);
}

#[tokio::test]
async fn gaps_exclude_weekend_and_holiday() {
    let now = Utc.with_ymd_and_hms(2026, 10, 9, 2, 0, 0).unwrap();
    let raw = Arc::new(MemRaw::default());
    let mut hol = HashSet::new();
    for dd in 1..=8u32 { hol.insert(d(2026, 10, dd)); } // 国庆（0008 口径）
    for dd in 1..=3u32 { hol.insert(d(2026, 1, dd)); }  // 元旦（0008 口径）
    let s = svc(now, raw, vec![], hol, vec![], vec![]);
    // 周末
    assert!(s.gaps("518880", d(2026, 9, 5), d(2026, 9, 6)).await.unwrap().is_empty(),
        "周末整日排除（任务书验收点）");
    // 节假日（含工作日 10-01 周四）
    assert!(s.gaps("518880", d(2026, 10, 1), d(2026, 10, 8)).await.unwrap().is_empty(),
        "国庆整日排除、不算缺口（任务书验收点）");
    // 元旦（2026-01-01 周四）
    assert!(s.gaps("518880", d(2026, 1, 1), d(2026, 1, 1)).await.unwrap().is_empty(),
        "元旦排除");
}

#[tokio::test]
async fn gaps_classify_three_tiers_and_segments() {
    let day = d(2026, 9, 3); // 周四
    // now = 次日 → 当日 241 标签全到期
    let now = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();
    let raw = Arc::new(MemRaw::default());
    seed_all_except(&raw, "518880", day, &[(10, 41), (10, 42), (13, 5), (14, 0)]);
    let evs = vec![
        ev_cst(day, 10, 41, 30, false, Some("timeout"), "518880"),   // 源故障
        ev_cst(day, 13, 5, 20, true, Some("na"), "518880"),          // 源可达无数据
        // 14:00 邻近无事件 → 系统缺口
    ];
    let s = svc(now, raw, evs, HashSet::new(), vec![], vec![]);
    let days = s.gaps("518880", day, day).await.unwrap();
    assert_eq!(days.len(), 1, "仅缺口日出卡");
    let g = &days[0];
    assert_eq!(g.expected_bars, 241);
    assert_eq!(g.actual_bars, 237);
    assert_eq!(g.missing_bars, 4);
    assert_eq!(g.segments.len(), 3);
    assert_eq!((hhmm(&g.segments[0].start).as_str(), hhmm(&g.segments[0].end).as_str(),
                g.segments[0].count, g.segments[0].class),
        ("10:41", "10:42", 2, GapClass::SourceFault));
    assert_eq!((hhmm(&g.segments[1].start).as_str(), g.segments[1].class),
        ("13:05", GapClass::UpstreamNoData));
    assert_eq!((hhmm(&g.segments[2].start).as_str(), g.segments[2].class),
        ("14:00", GapClass::SystemGap), "交易日邻近零事件 → 系统缺口（D5）");
}

#[tokio::test]
async fn gaps_future_minutes_not_due_and_full_day_ok() {
    let day = d(2026, 9, 3);
    // now = 当日 10:00:30 CST：到期标签 = 09:30..=10:00 共 31
    let now = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 30).unwrap();
    let raw = Arc::new(MemRaw::default()); // 零已有
    let s = svc(now, raw, vec![], HashSet::new(), vec![], vec![]);
    let days = s.gaps("518880", day, day).await.unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].expected_bars, 31, "未来分钟不算缺口");
    assert_eq!(days[0].missing_bars, 31);
    // 全天无缺口 → 不出卡
    let raw2 = Arc::new(MemRaw::default());
    seed_all_except(&raw2, "518880", day, &[]);
    let s2 = svc(Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap(), raw2, vec![],
        HashSet::new(), vec![], vec![]);
    assert!(s2.gaps("518880", day, day).await.unwrap().is_empty(), "无缺口日不出卡");
}

#[tokio::test]
async fn daily_quality_card_and_tushare_status() {
    let day = d(2026, 9, 3);
    let now = Utc.with_ymd_and_hms(2026, 9, 4, 2, 0, 0).unwrap();
    let raw = Arc::new(MemRaw::default());
    seed_all_except(&raw, "518880", day, &[]);
    let rows = vec![
        DivergenceRow { ts: domain::tz::cst_to_utc(day.and_hms_opt(9, 30, 0).unwrap()),
            code: "518880".into(), raw_close: 10.1, accurate_close: 10.0,
            raw_source: Some("tencent_ifzq".into()) },
        DivergenceRow { ts: domain::tz::cst_to_utc(day.and_hms_opt(9, 31, 0).unwrap()),
            code: "518880".into(), raw_close: 10.0, accurate_close: 10.0,
            raw_source: Some("tencent_ifzq".into()) },
    ];
    let cps = vec![SyncCheckpointView { code: "518880".into(), period: "M1".into(),
        last_synced_date: d(2026, 9, 3),
        updated_at: Utc.with_ymd_and_hms(2026, 9, 3, 22, 0, 0).unwrap() }];
    let evs = vec![
        HealthEventRow { ts: Utc.with_ymd_and_hms(2026, 9, 3, 10, 0, 0).unwrap(),
            source: "tushare".into(), ok: true, latency_ms: Some(42000), err_kind: None, code: None },
        HealthEventRow { ts: Utc.with_ymd_and_hms(2026, 9, 3, 10, 30, 0).unwrap(),
            source: "tencent_ifzq".into(), ok: true, latency_ms: None, err_kind: None, code: None },
    ];
    let s = svc(now, raw, evs, HashSet::new(), rows, cps);

    // MCP④ 单日卡：交易日、无缺口、分歧汇总
    let q = s.daily_quality("518880", day).await.unwrap();
    assert!(q.trading_day);
    assert!(q.gap.is_none(), "全天无缺口 → gap=None");
    assert_eq!(q.divergence.compared_bars, 2);
    assert_eq!(q.divergence.divergent_bars, 1, "+1.0% > 0.5% 默认阈值");
    assert!((q.divergence.consistency_rate.unwrap() - 0.5).abs() < 1e-9);

    // 节假日单日卡：trading_day=false
    let mut hol = HashSet::new();
    hol.insert(d(2026, 10, 1));
    let raw2 = Arc::new(MemRaw::default());
    let s2 = svc(now, raw2, vec![], hol, vec![], vec![]);
    let q2 = s2.daily_quality("518880", d(2026, 10, 1)).await.unwrap();
    assert!(!q2.trading_day);
    assert!(q2.gap.is_none());
    assert_eq!(q2.divergence.compared_bars, 0);

    // tushare 状态
    let st = s.tushare_status().await.unwrap();
    assert_eq!(st.covered_codes, 1);
    assert_eq!(st.last_updated_at, Some(Utc.with_ymd_and_hms(2026, 9, 3, 22, 0, 0).unwrap()));
    let le = st.last_event.expect("最近 tushare 事件");
    assert!(le.ok && le.err_kind.is_none(), "过滤 source='tushare' 且取最近一条");
}
// ~/~ end
