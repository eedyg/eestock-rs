// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/diagnose/src/quality.rs>>[init]
//! 数据质量服务（Wave 2 Phase A，页面④ + MCP④；Application 层纯服务，端口注入，无 sqlx）。
//! 口径：本节 §2.1 头注释（close-only 对照 / 交易日历驱动缺口 / D5 三级分类）。

use anyhow::Result;
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Timelike, Utc};
use domain::calendar::{is_weekday, trading_minute_labels};
use domain::ports::{
    Clock, DivergenceRow, HealthEventRow, HealthEventsRangeRead, HolidayCalendarRead, QualityRead,
    RawBarReader, SyncCheckpointView, TushareStatusRead,
};
use domain::types::Code;
use domain::tz::{cst_to_utc, utc_to_cst};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// 默认分歧/一致阈值（%）：页面④ QUALITY_DEFAULTS.consistencyThresholdPct=0.5 定稿口径。
pub const DEFAULT_THRESHOLD_PCT: f64 = 0.5;
/// 日期跨度上限（天，含端点）：缺口逐日读库，防重查询。
pub const MAX_RANGE_DAYS: i64 = 62;

/// 偏差% = (raw − accurate) / accurate × 100；accurate≈0 防御（实盘不出现）：双≈0 → 0，否则 ±100。
pub fn deviation_pct(raw: f64, accurate: f64) -> f64 {
    if accurate.abs() < 1e-12 {
        return if raw.abs() < 1e-12 { 0.0 } else { 100.0 };
    }
    (raw - accurate) / accurate * 100.0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergenceItem {
    pub ts: DateTime<Utc>,
    pub raw_close: f64,
    pub accurate_close: f64,
    pub deviation_pct: f64,
    pub raw_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergenceSummary {
    pub compared_bars: i64,
    pub divergent_bars: i64,
    /// 分歧率 = |偏差|>threshold 的 bar 占比；无比对样本 → None。
    pub divergence_rate: Option<f64>,
    /// 一致率 = |偏差|≤threshold 占比（页面④「≤0.5% 计一致」同口径，threshold 可调）。
    pub consistency_rate: Option<f64>,
    pub max_deviation_pct: Option<f64>,
}

/// 分歧报告：rows 按 |偏差| 降序（页面④ 默认排序）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergenceReport {
    pub summary: DivergenceSummary,
    pub rows: Vec<DivergenceItem>,
}

/// 对照行 → 分歧报告（纯函数）。
pub fn summarize(rows: Vec<DivergenceRow>, threshold_pct: f64) -> DivergenceReport {
    let mut items: Vec<DivergenceItem> = rows.into_iter().map(|r| DivergenceItem {
        ts: r.ts,
        raw_close: r.raw_close,
        accurate_close: r.accurate_close,
        deviation_pct: deviation_pct(r.raw_close, r.accurate_close),
        raw_source: r.raw_source,
    }).collect();
    items.sort_by(|a, b| b.deviation_pct.abs().total_cmp(&a.deviation_pct.abs()));
    let n = items.len() as i64;
    let divergent = items.iter().filter(|i| i.deviation_pct.abs() > threshold_pct).count() as i64;
    DivergenceReport {
        summary: DivergenceSummary {
            compared_bars: n,
            divergent_bars: divergent,
            divergence_rate: if n > 0 { Some(divergent as f64 / n as f64) } else { None },
            consistency_rate: if n > 0 { Some((n - divergent) as f64 / n as f64) } else { None },
            max_deviation_pct: items.first().map(|i| i.deviation_pct.abs()),
        },
        rows: items,
    }
}

/// 源一致率排行卡（页面④ accuracy-cards；一致率降序，平手按 source 名序）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceAccuracy {
    pub source: String,
    pub samples: i64,
    pub consistency_rate: Option<f64>,
    pub avg_deviation_pct: Option<f64>,
    pub max_deviation_pct: Option<f64>,
}

/// 对照行按 raw_source 归组的一致率统计（纯函数）。
pub fn accuracy_by_source(rows: &[DivergenceRow], threshold_pct: f64) -> Vec<SourceAccuracy> {
    let mut by: HashMap<String, Vec<f64>> = HashMap::new();
    for r in rows {
        by.entry(r.raw_source.clone().unwrap_or_else(|| "unknown".into()))
            .or_default()
            .push(deviation_pct(r.raw_close, r.accurate_close).abs());
    }
    let mut out: Vec<SourceAccuracy> = by.into_iter().map(|(source, devs)| {
        let n = devs.len() as i64;
        let consistent = devs.iter().filter(|d| **d <= threshold_pct).count() as i64;
        SourceAccuracy {
            source,
            samples: n,
            consistency_rate: Some(consistent as f64 / n as f64),
            avg_deviation_pct: Some(devs.iter().sum::<f64>() / devs.len() as f64),
            max_deviation_pct: devs.iter().cloned().reduce(f64::max),
        }
    }).collect();
    out.sort_by(|a, b| b.consistency_rate.partial_cmp(&a.consistency_rate)
        .unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.source.cmp(&b.source)));
    out
}

/// 缺口分类（D5 口径，三级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GapClass { SourceFault, UpstreamNoData, SystemGap }

/// 失败证据类 err_kind（抓取失败/陈旧/熔断张开——源故障时段）。
/// circuit_closed/manual_reset 是恢复不是故障，不列入。
const FAULT_KINDS: &[&str] = &["timeout", "http", "parse", "rate_limited", "all_failed",
    "stale_data", "circuit_open", "circuit_halfopen"];

/// 缺口分钟分类（纯函数）：邻近事件窗口内——
/// ① 有失败证据 → SourceFault（源故障时段）；
/// ② 有 na（源可达无数据）或成功事件 → UpstreamNoData；
/// ③ 无任何事件 → SystemGap（采集停摆/事件空窗；非交易日已由日历排除，不会误归此类）。
pub fn classify_gap_minute(nearby: &[&HealthEventRow]) -> GapClass {
    if nearby.iter().any(|e| !e.ok
        && e.err_kind.as_deref().map(|k| FAULT_KINDS.contains(&k)).unwrap_or(false)) {
        return GapClass::SourceFault;
    }
    if nearby.iter().any(|e| e.ok || e.err_kind.as_deref() == Some("na")) {
        return GapClass::UpstreamNoData;
    }
    GapClass::SystemGap
}

/// 缺口段（连续同分类分钟合并；start/end = CST naive 标签时刻，含端点；count = 缺 bar 数）。
/// 午休两侧不跨段（11:30 → 13:01 标签差 91min > 1min，自然断段）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GapSegment {
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    pub count: i64,
    pub class: GapClass,
}

/// CST 标签 → "HH:MM"（页面④ 缺口段展示口径）。
pub fn hhmm(t: &NaiveDateTime) -> String { format!("{:02}:{:02}", t.hour(), t.minute()) }

/// 缺口分钟（CST naive，升序，带分类）→ 连续段（纯函数）。
pub fn segments_of(missing: &[(NaiveDateTime, GapClass)]) -> Vec<GapSegment> {
    let mut out: Vec<GapSegment> = vec![];
    for (m, class) in missing {
        match out.last_mut() {
            Some(seg) if seg.class == *class && *m - seg.end == Duration::minutes(1) => {
                seg.end = *m;
                seg.count += 1;
            }
            _ => out.push(GapSegment { start: *m, end: *m, count: 1, class: *class }),
        }
    }
    out
}

/// 单日缺口卡（仅当日有缺口时由 gaps() 产出）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayGap {
    pub date: NaiveDate,
    /// 应到 bar 数 = 已到期标签数（当日盘中为部分，历史日为 241）。
    pub expected_bars: i64,
    pub actual_bars: i64,
    pub missing_bars: i64,
    pub segments: Vec<GapSegment>,
}

/// tushare 最近事件视图（source_health_events source='tushare'；skip 审计 ok=true+na 也算可达证据）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TushareEventView {
    pub ts: DateTime<Utc>,
    pub ok: bool,
    pub err_kind: Option<String>,
}

/// 页面④ sync-panel 状态（quota 未入库 → 由 web 层恒置 null，见 §1.1）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TushareStatus {
    pub checkpoints: Vec<SyncCheckpointView>,
    pub covered_codes: usize,
    pub last_updated_at: Option<DateTime<Utc>>,
    pub last_event: Option<TushareEventView>,
}

/// MCP④ 单日质量卡（get_data_quality(code, date)）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DailyQuality {
    pub code: String,
    pub date: NaiveDate,
    pub trading_day: bool,
    /// 当日缺口卡（无缺口 / 非交易日 / 当日尚无到期标签 → None）。
    pub gap: Option<DayGap>,
    pub divergence: DivergenceSummary,
}

/// 范围校验（web/MCP 共用）：from<=to 且跨度 ≤ MAX_RANGE_DAYS。
pub fn validate_range(from: NaiveDate, to: NaiveDate) -> Result<()> {
    if from > to { anyhow::bail!("from 不得晚于 to"); }
    if (to - from).num_days() + 1 > MAX_RANGE_DAYS {
        anyhow::bail!("日期跨度上限 {MAX_RANGE_DAYS} 天");
    }
    Ok(())
}

/// 日期闭区间 [from, to]（CST 日界）→ UTC 半开区间 [from 00:00 CST, to+1 00:00 CST)。
pub fn day_range_utc(from: NaiveDate, to: NaiveDate) -> (DateTime<Utc>, DateTime<Utc>) {
    (cst_to_utc(from.and_hms_opt(0, 0, 0).expect("valid hms")),
     cst_to_utc((to + Duration::days(1)).and_hms_opt(0, 0, 0).expect("valid hms")))
}

/// 质量查询服务（Application）：注入只读端口；聚合/分类全部走纯函数。
/// Clone 派生：eestock-app 装配时 web/mcp 两状态共享同一组端口实例。
#[derive(Clone)]
pub struct QualityService {
    quality: Arc<dyn QualityRead>,
    raw: Arc<dyn RawBarReader>,
    events: Arc<dyn HealthEventsRangeRead>,
    holidays: Arc<dyn HolidayCalendarRead>,
    tushare: Arc<dyn TushareStatusRead>,
    clock: Arc<dyn Clock>,
}

impl QualityService {
    pub fn new(quality: Arc<dyn QualityRead>, raw: Arc<dyn RawBarReader>,
               events: Arc<dyn HealthEventsRangeRead>, holidays: Arc<dyn HolidayCalendarRead>,
               tushare: Arc<dyn TushareStatusRead>, clock: Arc<dyn Clock>) -> Self {
        Self { quality, raw, events, holidays, tushare, clock }
    }

    /// GET /api/quality/divergence 数据源。
    pub async fn divergence(&self, code: &str, from: NaiveDate, to: NaiveDate,
                            threshold_pct: f64) -> Result<DivergenceReport> {
        validate_range(from, to)?;
        let (lo, hi) = day_range_utc(from, to);
        let rows = self.quality.divergence_rows(Some(code), lo, hi).await?;
        Ok(summarize(rows, threshold_pct))
    }

    /// GET /api/quality/source-accuracy 数据源。
    pub async fn source_accuracy(&self, from: NaiveDate, to: NaiveDate,
                                 threshold_pct: f64) -> Result<Vec<SourceAccuracy>> {
        validate_range(from, to)?;
        let (lo, hi) = day_range_utc(from, to);
        let rows = self.quality.divergence_rows(None, lo, hi).await?;
        Ok(accuracy_by_source(&rows, threshold_pct))
    }

    /// GET /api/quality/gaps 数据源：仅返回有缺口的交易日（非交易日整日排除）。
    pub async fn gaps(&self, code: &str, from: NaiveDate, to: NaiveDate) -> Result<Vec<DayGap>> {
        validate_range(from, to)?;
        let holidays = self.holidays.holidays().await?;
        let (lo, hi) = day_range_utc(from, to);
        let evs = self.events.events_between(lo, hi).await?;
        // 缺口分类证据：该 code 事件 ∪ 源级事件（code=None，如 circuit_open 影响全部标的）
        let code_events: Vec<&HealthEventRow> = evs.iter()
            .filter(|e| e.code.as_deref() == Some(code) || e.code.is_none()).collect();
        let now_floor = {
            let c = utc_to_cst(self.clock.now());
            c.with_second(0).and_then(|t| t.with_nanosecond(0)).expect("valid minute floor")
        };
        let mut out = vec![];
        let mut day = from;
        while day <= to {
            if is_weekday(day) && !holidays.contains(&day) {
                let due: Vec<NaiveDateTime> = trading_minute_labels(day).into_iter()
                    .filter(|l| *l <= now_floor).collect();
                if !due.is_empty() {
                    let existing = self.raw.existing_ts(&Code(code.into()), day).await?;
                    let missing: Vec<(NaiveDateTime, GapClass)> = due.iter()
                        .filter(|l| !existing.contains(&cst_to_utc(**l)))
                        .map(|l| {
                            let wlo = cst_to_utc(*l - Duration::minutes(2));
                            let whi = cst_to_utc(*l + Duration::minutes(2));
                            let nearby: Vec<&HealthEventRow> = code_events.iter()
                                .filter(|e| e.ts >= wlo && e.ts < whi).copied().collect();
                            (*l, classify_gap_minute(&nearby))
                        }).collect();
                    if !missing.is_empty() {
                        out.push(DayGap {
                            date: day,
                            expected_bars: due.len() as i64,
                            actual_bars: (due.len() - missing.len()) as i64,
                            missing_bars: missing.len() as i64,
                            segments: segments_of(&missing),
                        });
                    }
                }
            }
            day += Duration::days(1);
        }
        Ok(out)
    }

    /// GET /api/tushare/status 数据源（最近事件窗口 7 天）。
    pub async fn tushare_status(&self) -> Result<TushareStatus> {
        let cps = self.tushare.sync_checkpoints().await?;
        let now = self.clock.now();
        let evs = self.events.events_between(now - Duration::days(7), now).await?;
        let last_event = evs.iter().rev().find(|e| e.source == "tushare")
            .map(|e| TushareEventView { ts: e.ts, ok: e.ok, err_kind: e.err_kind.clone() });
        Ok(TushareStatus {
            covered_codes: cps.len(),
            last_updated_at: cps.iter().map(|c| c.updated_at).max(),
            checkpoints: cps,
            last_event,
        })
    }

    /// MCP 工具④ get_data_quality(code, date)：单日质量卡（缺口 + 分歧汇总）。
    pub async fn daily_quality(&self, code: &str, date: NaiveDate) -> Result<DailyQuality> {
        let holidays = self.holidays.holidays().await?;
        let trading = is_weekday(date) && !holidays.contains(&date);
        let gap = self.gaps(code, date, date).await?.into_iter().next();
        let div = self.divergence(code, date, date, DEFAULT_THRESHOLD_PCT).await?;
        Ok(DailyQuality {
            code: code.into(), date, trading_day: trading,
            gap, divergence: div.summary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate { NaiveDate::from_ymd_opt(y, m, dd).unwrap() }
    fn ndt(day: NaiveDate, h: u32, mi: u32) -> NaiveDateTime { day.and_hms_opt(h, mi, 0).unwrap() }
    fn row(ts: DateTime<Utc>, raw: f64, acc: f64, src: &str) -> DivergenceRow {
        DivergenceRow { ts, code: "518880".into(), raw_close: raw, accurate_close: acc,
            raw_source: Some(src.into()) }
    }
    fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

    #[test]
    fn deviation_pct_guards_and_sign() {
        assert!((deviation_pct(10.1, 10.0) - 1.0).abs() < 1e-9);
        assert!((deviation_pct(9.9, 10.0) + 1.0).abs() < 1e-9);
        assert_eq!(deviation_pct(0.0, 0.0), 0.0, "双零防御");
        assert_eq!(deviation_pct(1.0, 0.0), 100.0, "accurate 零防御（不产出 inf/nan，JSON 安全）");
    }

    #[test]
    fn summarize_rates_and_deviation_desc_order() {
        let rows = vec![
            row(base(), 10.04, 10.0, "tencent_ifzq"),        // +0.4% ≤0.5 一致
            row(base() + Duration::minutes(1), 9.90, 10.0, "sina_jsonp"), // −1.0% 分歧
            row(base() + Duration::minutes(2), 10.20, 10.0, "sina_jsonp"), // +2.0% 分歧
        ];
        let rep = summarize(rows, 0.5);
        assert_eq!(rep.summary.compared_bars, 3);
        assert_eq!(rep.summary.divergent_bars, 2, "|偏差|>0.5% 计分歧");
        assert!((rep.summary.divergence_rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
        assert!((rep.summary.consistency_rate.unwrap() - 1.0 / 3.0).abs() < 1e-9);
        assert!((rep.summary.max_deviation_pct.unwrap() - 2.0).abs() < 1e-9);
        assert!((rep.rows[0].deviation_pct - 2.0).abs() < 1e-9, "默认 |偏差| 降序");
        assert!((rep.rows[1].deviation_pct + 1.0).abs() < 1e-9);
        assert_eq!(rep.rows[2].raw_source.as_deref(), Some("tencent_ifzq"));
        // 空样本
        let empty = summarize(vec![], 0.5);
        assert_eq!(empty.summary.compared_bars, 0);
        assert!(empty.summary.divergence_rate.is_none() && empty.summary.consistency_rate.is_none()
            && empty.summary.max_deviation_pct.is_none(), "无比对数据 → 汇总全 None（前端空态）");
    }

    #[test]
    fn accuracy_by_source_grouped_and_sorted() {
        let rows = vec![
            row(base(), 10.001, 10.0, "tencent_ifzq"),
            row(base() + Duration::minutes(1), 10.0, 10.0, "tencent_ifzq"),
            row(base() + Duration::minutes(2), 10.10, 10.0, "sina_jsonp"),   // 1.0% 分歧
            row(base() + Duration::minutes(3), 10.0, 10.0, "sina_jsonp"),
        ];
        let acc = accuracy_by_source(&rows, 0.5);
        assert_eq!(acc.len(), 2);
        assert_eq!(acc[0].source, "tencent_ifzq", "一致率降序");
        assert_eq!(acc[0].consistency_rate, Some(1.0));
        assert_eq!(acc[1].source, "sina_jsonp");
        assert_eq!(acc[1].consistency_rate, Some(0.5));
        assert!((acc[1].avg_deviation_pct.unwrap() - 0.5).abs() < 1e-9);
        assert!((acc[1].max_deviation_pct.unwrap() - 1.0).abs() < 1e-9);
        assert_eq!(acc[1].samples, 2);
    }

    fn ev(ts: DateTime<Utc>, ok: bool, kind: Option<&str>) -> HealthEventRow {
        HealthEventRow { ts, source: "tencent_ifzq".into(), ok, latency_ms: None,
            err_kind: kind.map(Into::into), code: Some("518880".into()) }
    }

    #[test]
    fn classify_gap_minute_matrix() {
        let t0 = base();
        // ① 失败证据优先（timeout / stale_data / all_failed / circuit_open 均属源故障）
        for k in ["timeout", "http", "parse", "rate_limited", "all_failed", "stale_data",
                  "circuit_open", "circuit_halfopen"] {
            let e = ev(t0, false, Some(k));
            assert_eq!(classify_gap_minute(&[&e]), GapClass::SourceFault, "{k} 属源故障");
        }
        // ② na / 成功事件 → 源可达无数据
        let na = ev(t0, true, Some("na"));
        assert_eq!(classify_gap_minute(&[&na]), GapClass::UpstreamNoData);
        let ok = ev(t0, true, None);
        assert_eq!(classify_gap_minute(&[&ok]), GapClass::UpstreamNoData);
        // 恢复类迁移不占故障位
        let closed = ev(t0, false, Some("circuit_closed"));
        let reset = ev(t0, false, Some("manual_reset"));
        assert_eq!(classify_gap_minute(&[&closed]), GapClass::SystemGap,
            "circuit_closed 是恢复不是故障（且 ok=false 不入 na/成功位）");
        assert_eq!(classify_gap_minute(&[&reset]), GapClass::SystemGap);
        // ③ 无事件 → 系统缺口（D5：事件空窗/采集停摆；非交易日已被日历排除）
        assert_eq!(classify_gap_minute(&[]), GapClass::SystemGap);
        // 混合：失败证据优先于 na
        let mix_ok = ev(t0, true, Some("na"));
        let mix_bad = ev(t0, false, Some("timeout"));
        assert_eq!(classify_gap_minute(&[&mix_ok, &mix_bad]), GapClass::SourceFault);
    }

    #[test]
    fn segments_merge_consecutive_same_class_and_break_lunch() {
        let day = d(2026, 9, 3);
        let missing = vec![
            (ndt(day, 10, 41), GapClass::SourceFault),
            (ndt(day, 10, 42), GapClass::SourceFault),
            (ndt(day, 10, 43), GapClass::SourceFault),
            (ndt(day, 11, 30), GapClass::SystemGap),
            (ndt(day, 13, 1), GapClass::SystemGap),   // 午休断段：与 11:30 不合并
            (ndt(day, 13, 2), GapClass::SystemGap),
        ];
        let segs = segments_of(&missing);
        assert_eq!(segs.len(), 3);
        assert_eq!((hhmm(&segs[0].start).as_str(), hhmm(&segs[0].end).as_str(), segs[0].count),
            ("10:41", "10:43", 3));
        assert_eq!(segs[0].class, GapClass::SourceFault);
        assert_eq!((hhmm(&segs[1].start).as_str(), segs[1].count), ("11:30", 1), "分类变即断段");
        assert_eq!((hhmm(&segs[2].start).as_str(), hhmm(&segs[2].end).as_str(), segs[2].count),
            ("13:01", "13:02", 2), "午休两侧不跨段");
    }

    #[test]
    fn validate_range_and_day_range_utc() {
        assert!(validate_range(d(2026, 9, 1), d(2026, 9, 3)).is_ok());
        assert!(validate_range(d(2026, 9, 3), d(2026, 9, 1)).is_err(), "from>to → 400");
        assert!(validate_range(d(2026, 1, 1), d(2026, 12, 31)).is_err(), "超 62 天跨度 → 400");
        let (lo, hi) = day_range_utc(d(2026, 9, 3), d(2026, 9, 3));
        assert_eq!(lo, Utc.with_ymd_and_hms(2026, 9, 2, 16, 0, 0).unwrap(), "CST 日界 → UTC");
        assert_eq!(hi, Utc.with_ymd_and_hms(2026, 9, 3, 16, 0, 0).unwrap());
    }
}
// ~/~ end
