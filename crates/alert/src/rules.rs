// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/alert/src/rules.rs>>[init]
//! 告警规则评估纯函数（离线 TDD，无 DB）：内置规则首批语义（本文档 §1 表）。
//! 交易时段/缺口分母为纯函数（当前 = 工作日口径，节假日表 0008 接入后改走日历，签名不变）。

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Utc};
use domain::ports::{AlertRule, HealthEventRow, SymbolLatestView, SymbolStatView};
use domain::tz::utc_to_cst;

/// 内置规则 slug（alert_rules.id 种子值，0009 迁移）。
pub const RULE_SOURCE_SUCCESS_RATE: &str = "source_success_rate";
pub const RULE_SYMBOL_GAP_RATE: &str = "symbol_gap_rate";
pub const RULE_COLLECTION_STALL: &str = "collection_stall";
pub const RULE_TUSHARE_DAILY_SYNC: &str = "tushare_daily_sync";

/// 采集停摆规则的来源键（系统组件，07-alerts §2 系统类）。
pub const STALL_SOURCE: &str = "collector";
/// tushare 日增量规则的来源键（SourceId::Tushare as_str 口径）。
pub const TUSHARE_SOURCE: &str = "tushare";

/// 成功率评估最小样本（窗口内非 na 事件数）：低于此不具备统计意义，不评估（事件保持原状）。
pub const MIN_SUCCESS_SAMPLES: i64 = 3;
/// 缺口率评估起点：开盘后满 30 分钟才评估（开盘初期小样本防噪音）。
pub const MIN_GAP_ELAPSED_MINUTES: i64 = 30;
/// tushare 失败事件有效窗口（小时）：三时点调度（00/08/18 CST）48h 覆盖一轮完整补全；
/// 超窗陈旧失败不再告警（采集整体停摆另由 collection_stall 覆盖）。
pub const TUSHARE_FAILURE_LOOKBACK_HOURS: i64 = 48;

/// 单规则单对象评估结论（breached=false 用于驱动恢复）。
#[derive(Debug, Clone, PartialEq)]
pub struct Evaluation {
    pub rule_id: String,
    pub source: String,
    pub breached: bool,
    pub message: String,
}

impl Evaluation {
    fn ok(rule_id: &str, source: &str) -> Self {
        Evaluation { rule_id: rule_id.into(), source: source.into(), breached: false, message: String::new() }
    }
    fn breach(rule_id: &str, source: &str, message: String) -> Self {
        Evaluation { rule_id: rule_id.into(), source: source.into(), breached: true, message }
    }
}

/// 交易时段（Asia/Shanghai）：09:30-11:30 / 13:00-15:00。
fn session_ranges() -> [(NaiveTime, NaiveTime); 2] {
    let t = |h: u32, m: u32| NaiveTime::from_hms_opt(h, m, 0).expect("valid hms");
    [(t(9, 30), t(11, 30)), (t(13, 0), t(15, 0))]
}

/// 交易日判定（当前 = 工作日口径；节假日表接入后改走日历）。
pub fn is_trading_day(date: NaiveDate) -> bool {
    !matches!(date.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun)
}

/// 此刻是否在交易时段内（含边界）。
pub fn in_trading_session(now: DateTime<Utc>) -> bool {
    let cst = utc_to_cst(now);
    if !is_trading_day(cst.date()) { return false; }
    let t = cst.time();
    session_ranges().iter().any(|(s, e)| t >= *s && t <= *e)
}

/// 当日交易时段已流逝分钟数（缺口率分母）：
/// 非交易日/盘前 → 0；09:30 整 → 0；午休 → 120；15:00 及之后 → 240（全天应有分钟数）。
pub fn expected_minutes_elapsed(now: DateTime<Utc>) -> i64 {
    let cst = utc_to_cst(now);
    if !is_trading_day(cst.date()) { return 0; }
    let t = cst.time();
    let mut total = 0i64;
    for (s, e) in session_ranges() {
        if t >= s {
            total += (t.min(e) - s).num_minutes();
        }
    }
    total
}

fn is_na(err: &Option<String>) -> bool { err.as_deref() == Some("na") }

fn is_circuit_migration(err: &Option<String>) -> bool {
    matches!(err.as_deref(),
        Some("circuit_open") | Some("circuit_halfopen")
        | Some("circuit_closed") | Some("manual_reset"))
}

/// 规则①：窗口成功率低于阈值（分母排除 na，03 §7；样本 < MIN_SUCCESS_SAMPLES 不评估不出结论）。
/// 边界：rate == threshold 不触发（严格小于）。
pub fn eval_source_success_rate(rule: &AlertRule, events: &[HealthEventRow]) -> Vec<Evaluation> {
    let mut by_source: std::collections::BTreeMap<String, (i64, i64)> = Default::default();
    for e in events {
        if is_na(&e.err_kind) { continue; }
        let ent = by_source.entry(e.source.clone()).or_default();
        ent.0 += 1;
        if e.ok { ent.1 += 1; }
    }
    by_source.into_iter().filter_map(|(source, (attempts, successes))| {
        if attempts < MIN_SUCCESS_SAMPLES { return None; }
        let rate = successes as f64 / attempts as f64;
        if rate < rule.threshold {
            Some(Evaluation::breach(&rule.id, &source, format!(
                "{source} 成功率 {:.1}% < {:.0}%（{}min 窗口，{successes}/{attempts}）",
                rate * 100.0, rule.threshold * 100.0, rule.duration_minutes)))
        } else {
            Some(Evaluation::ok(&rule.id, &source))
        }
    }).collect()
}

/// 规则②：标的当日缺口率超阈（expected=交易时段已流逝分钟数，actual=kline_raw 当日行数）。
/// 非交易日 / 开盘后未满 MIN_GAP_ELAPSED_MINUTES → 不评估（返回空，事件保持原状）；
/// 缺口率 == 阈值不触发（严格大于）。
pub fn eval_symbol_gap_rate(rule: &AlertRule, now: DateTime<Utc>,
                            symbols: &[SymbolLatestView],
                            stats: &[SymbolStatView]) -> Vec<Evaluation> {
    let expected = expected_minutes_elapsed(now);
    if expected < MIN_GAP_ELAPSED_MINUTES { return vec![]; }
    let actual_of = |code: &str| stats.iter().find(|s| s.code == code)
        .map(|s| s.today_bars).unwrap_or(0);
    symbols.iter().filter(|s| s.enabled).map(|s| {
        let actual = actual_of(&s.code);
        let gap = (expected - actual).max(0) as f64 / expected as f64 * 100.0;
        if gap > rule.threshold {
            Evaluation::breach(&rule.id, &s.code, format!(
                "{} 当日缺口率 {gap:.1}%（>{:.0}%）", s.code, rule.threshold))
        } else {
            Evaluation::ok(&rule.id, &s.code)
        }
    }).collect()
}

/// 规则③：采集停摆（D5 联动）——交易时段内连续 threshold 分钟无任何成功事件
/// （na=非交易时段可达事件不算采集成功，D5 口径；非交易时段不评估）。
pub fn eval_collection_stall(rule: &AlertRule, now: DateTime<Utc>,
                             events: &[HealthEventRow]) -> Vec<Evaluation> {
    if !in_trading_session(now) { return vec![]; }
    let any_success = events.iter().any(|e| e.ok && !is_na(&e.err_kind));
    if any_success {
        vec![Evaluation::ok(&rule.id, STALL_SOURCE)]
    } else {
        vec![Evaluation::breach(&rule.id, STALL_SOURCE, format!(
            "采集停摆：交易时段连续 {:.0} 分钟无任何成功事件", rule.threshold))]
    }
}

/// 规则④：tushare 日增量失败——最近一条 tushare 事件为抓取失败（非 na 审计/非熔断迁移）
/// 且在有效窗口内（≤48h，三时点调度口径）；无事件 → 不评估。
pub fn eval_tushare_daily_sync(rule: &AlertRule, now: DateTime<Utc>,
                               latest: Option<&HealthEventRow>) -> Vec<Evaluation> {
    let Some(ev) = latest else { return vec![] };
    let failed = !ev.ok && !is_na(&ev.err_kind) && !is_circuit_migration(&ev.err_kind);
    let fresh = now - ev.ts <= Duration::hours(TUSHARE_FAILURE_LOOKBACK_HOURS);
    if failed && fresh {
        vec![Evaluation::breach(&rule.id, TUSHARE_SOURCE, format!(
            "tushare 日增量同步失败：{}（{}）",
            ev.err_kind.as_deref().unwrap_or("unknown"),
            ev.ts.format("%m-%d %H:%M")))]
    } else {
        vec![Evaluation::ok(&rule.id, TUSHARE_SOURCE)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn rule(id: &str, threshold: f64, duration: i64, silence: i64) -> AlertRule {
        AlertRule { id: id.into(), name: id.into(), level: domain::ports::AlertLevel::Warning,
            threshold, duration_minutes: duration, silence_minutes: silence, enabled: true }
    }

    fn ev(src: &str, ok: bool, err: Option<&str>) -> HealthEventRow {
        HealthEventRow { ts: at(2026, 9, 7, 2, 0), source: src.into(), ok,
            latency_ms: None, err_kind: err.map(Into::into), code: None }
    }

    // ── 交易时段/缺口分母纯函数 ──

    #[test]
    fn trading_session_boundaries() {
        // 2026-09-07 是周一（CST = UTC+8）
        assert!(!in_trading_session(at(2026, 9, 7, 1, 29)), "09:29 盘前");
        assert!(in_trading_session(at(2026, 9, 7, 1, 30)), "09:30 开盘含边界");
        assert!(in_trading_session(at(2026, 9, 7, 3, 30)), "11:30 含边界");
        assert!(!in_trading_session(at(2026, 9, 7, 4, 0)), "12:00 午休");
        assert!(in_trading_session(at(2026, 9, 7, 5, 0)), "13:00 午后开盘");
        assert!(in_trading_session(at(2026, 9, 7, 7, 0)), "15:00 收盘含边界");
        assert!(!in_trading_session(at(2026, 9, 7, 7, 1)), "15:01 收盘后");
        assert!(!in_trading_session(at(2026, 9, 5, 2, 0)), "周六非交易日");
    }

    #[test]
    fn expected_minutes_elapsed_curve() {
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 1, 29)), 0, "盘前");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 1, 30)), 0, "09:30 整");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 2, 0)), 30, "10:00 → 30");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 3, 30)), 120, "11:30 → 120");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 4, 30)), 120, "午休冻结 120");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 5, 30)), 150, "13:30 → 150");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 7, 0)), 240, "15:00 → 240 全天");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 7, 8, 0)), 240, "盘后封项 240");
        assert_eq!(expected_minutes_elapsed(at(2026, 9, 6, 2, 0)), 0, "周日 → 0");
    }

    // ── 规则① 成功率 ──

    #[test]
    fn success_rate_breach_boundary_and_na_exclusion() {
        let r = rule(RULE_SOURCE_SUCCESS_RATE, 0.95, 10, 10);
        // 20 事件 19 成功 = 0.95 → 不触发（严格小于）；na 不入分母
        let mut events: Vec<_> = (0..19).map(|_| ev("src_a", true, None)).collect();
        events.push(ev("src_a", false, Some("timeout")));
        events.push(ev("src_a", true, Some("na")));
        let out = eval_source_success_rate(&r, &events);
        assert_eq!(out.len(), 1);
        assert!(!out[0].breached, "0.95 不 < 0.95");

        // 19/20 少一个成功 → 18/19 ≈ 0.947 < 0.95 → 触发
        let mut events2: Vec<_> = (0..18).map(|_| ev("src_a", true, None)).collect();
        events2.push(ev("src_a", false, Some("timeout")));
        let out2 = eval_source_success_rate(&r, &events2);
        assert!(out2[0].breached);
        assert!(out2[0].message.contains("src_a"));
    }

    #[test]
    fn success_rate_min_samples_guard() {
        let r = rule(RULE_SOURCE_SUCCESS_RATE, 0.95, 10, 10);
        let events = vec![ev("src_b", false, Some("http")), ev("src_b", false, Some("http"))];
        assert!(eval_source_success_rate(&r, &events).is_empty(),
            "2 样本 < MIN_SUCCESS_SAMPLES=3 → 不评估");
    }

    // ── 规则② 缺口率 ──

    fn sym(code: &str, enabled: bool) -> SymbolLatestView {
        SymbolLatestView { code: code.into(), name: None, type_: None, interval_secs: 60,
            settlement: "T1".into(), enabled, last_ts: None, last_close: None, prev_close: None }
    }

    fn stat(code: &str, bars: i64) -> SymbolStatView {
        SymbolStatView { code: code.into(), today_bars: bars, last_bar_ts: None }
    }

    #[test]
    fn gap_rate_fires_only_for_enabled_and_past_grace() {
        let r = rule(RULE_SYMBOL_GAP_RATE, 1.0, 0, 30);
        let t1000 = at(2026, 9, 7, 2, 0); // 10:00 CST，expected=30
        // 600519 有 28 根（缺口 6.7% > 1%）；600510 满格；600511 停用（0 根也不报）
        let symbols = vec![sym("600519", true), sym("600510", true), sym("600511", false)];
        let stats = vec![stat("600519", 28), stat("600510", 30)];
        let out = eval_symbol_gap_rate(&r, t1000, &symbols, &stats);
        assert_eq!(out.len(), 2, "停用标的不评估");
        let fired = out.iter().find(|e| e.source == "600519").unwrap();
        assert!(fired.breached);
        assert!(fired.message.contains("6.7%"));
        let ok = out.iter().find(|e| e.source == "600510").unwrap();
        assert!(!ok.breached);

        // 09:34（开盘后 4 分钟 < 30）→ 不评估
        assert!(eval_symbol_gap_rate(&r, at(2026, 9, 7, 1, 34), &symbols, &stats).is_empty());
        // 周六 → 不评估
        assert!(eval_symbol_gap_rate(&r, at(2026, 9, 5, 2, 0), &symbols, &stats).is_empty());
    }

    #[test]
    fn gap_rate_zero_bars_is_full_gap() {
        let r = rule(RULE_SYMBOL_GAP_RATE, 1.0, 0, 30);
        let out = eval_symbol_gap_rate(&r, at(2026, 9, 7, 2, 0), &[sym("600520", true)], &[]);
        assert!(out[0].breached, "无统计行 = 0 根 = 100% 缺口");
    }

    // ── 规则③ 采集停摆 ──

    #[test]
    fn stall_only_in_session_and_na_not_success() {
        let r = rule(RULE_COLLECTION_STALL, 3.0, 0, 10);
        let t = at(2026, 9, 7, 2, 0); // 10:00 CST 交易中
        let out = eval_collection_stall(&r, t, &[]);
        assert_eq!(out.len(), 1);
        assert!(out[0].breached && out[0].source == STALL_SOURCE);

        // 仅 na 事件（非交易时段可达口径残留）不算成功
        let na_only = vec![ev("tencent_ifzq", true, Some("na"))];
        assert!(eval_collection_stall(&r, t, &na_only)[0].breached);

        let ok = vec![ev("tencent_ifzq", true, None)];
        assert!(!eval_collection_stall(&r, t, &ok)[0].breached);

        // 非交易时段不评估
        assert!(eval_collection_stall(&r, at(2026, 9, 7, 4, 0), &[]).is_empty(), "午休不评估");
        assert!(eval_collection_stall(&r, at(2026, 9, 5, 2, 0), &[]).is_empty(), "周末不评估");
    }

    // ── 规则④ tushare 日增量 ──

    #[test]
    fn tushare_latest_failure_freshness_window() {
        let r = rule(RULE_TUSHARE_DAILY_SYNC, 0.0, 0, 60);
        let now = at(2026, 9, 7, 10, 0); // 18:00 CST 调度点
        let mut fail = ev(TUSHARE_SOURCE, false, Some("http"));
        fail.ts = now - Duration::hours(2);
        assert!(eval_tushare_daily_sync(&r, now, Some(&fail))[0].breached);

        let mut ok_ev = ev(TUSHARE_SOURCE, true, None);
        ok_ev.ts = now - Duration::hours(2);
        assert!(!eval_tushare_daily_sync(&r, now, Some(&ok_ev))[0].breached, "已成功 → 恢复结论");

        // na 跳过审计事件不算失败
        let mut na_ev = ev(TUSHARE_SOURCE, true, Some("na"));
        na_ev.ts = now - Duration::hours(1);
        assert!(!eval_tushare_daily_sync(&r, now, Some(&na_ev))[0].breached);

        // 陈旧失败（>48h）不再告警
        let mut stale = ev(TUSHARE_SOURCE, false, Some("http"));
        stale.ts = now - Duration::hours(49);
        assert!(!eval_tushare_daily_sync(&r, now, Some(&stale))[0].breached);

        // 无事件 → 不评估
        assert!(eval_tushare_daily_sync(&r, now, None).is_empty());
    }
}
// ~/~ end
