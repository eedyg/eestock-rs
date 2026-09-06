# 07-app-plane / 02 — 告警引擎（alert crate + 页面⑦ 后端，Wave 2 Phase B）

> 本文档 tangle 生成：
> `crates/alert/src/{lib,rules,engine}.rs`、`crates/alert/tests/engine.rs`、
> `crates/storage/src/alerts.rs`、`crates/storage/tests/alert_store.rs`、
> `crates/web/src/alerts.rs`、`crates/web/tests/api_alerts.rs`。
>
> 决策依据：wave-2.md §2（任务书定稿，通知渠道 = 仅页面⑦ + WS 推送，用户定稿 2026-09-04）、
> 07-alerts.md（页面⑦ 四层布局定稿）、ADR-017（应用面只读库；alert_rules/alert_events 为
> 应用面自有表——与 circuit_reset_requests 同口径，数据面不读写，写不违铁律）。
>
> **数据面零改动**：collector/providers/tushare/storage 写入路径一行不动。加法扩展清单：
> ① domain::ports 尾部追加告警端口与读/写模型（02-domain/contracts.md §2.4 尾，纯加法）；
> ② storage 新增 `alerts.rs`（PgAlertStore/PgAlertEval；lib.rs 声明维护在 04-storage/02-tushare-sync.md）；
> ③ 迁移 0009（04-storage/schema.md §4.3.2）+ migrate_check 关系清单（03-raw-writer.md）；
> ④ web 新增 `alerts.rs` 模块 + 00-web-api.md 既有块加法（路由/state/WS topic/app 装配）；
> ⑤ 新 crate `crates/alert`（Application 层，与 diagnose 并列；架构师已批准）。
> web/diagnose/既有测试块仅做装配字段补齐（AppState.alerts），行为零改动。

## 1. 决策注记

- **alert = Application 层服务**（与 diagnose 同模式）：评估逻辑全部纯函数（rules.rs，离线 TDD），
  `AlertService` 只做「读端口 → 纯函数 → 状态机落库」编排；不依赖 sqlx/web/storage。
- **评估节拍 1min**：由 web::alerts::AlertEvaluator 循环驱动（与 ws::Poller 同模式），
  规则每轮重读 → 阈值/开关/静默时长热生效（07-alerts §3）。
- **聚合防刷屏**（07-alerts §5）：同 rule+source 未恢复事件至多一条（0009 部分唯一索引保证），
  重复触发只累加 fire_count / 推进 last_fired_at。
- **静默期**：同 rule+source 距上次触发（含已恢复事件的 last_fired_at）不足 silence_minutes
  不触发/不续触发——既防刷屏也防条件抖动反复新建事件。
- **生命周期状态机**（07-alerts §5）：triggered → acked → resolved；
  triggered → resolved 直转合法（条件消失自动恢复，无需先确认）；
  已 acked 事件续触发 → 回退 triggered 并清 acked_at（新活动需重新确认，未确认高亮）；
  ack 仅对 triggered 有效（幂等/恢复后 ack 返回 None → web 404）。
- **内置规则首批**（wave-2.md §2，0009 种子；threshold 语义按 id 约定）：
  | id | 级别 | threshold | duration | 触发条件 |
  |---|---|---|---|---|
  | source_success_rate | warning | 0.95（成功率下限） | 10min 窗口 | 窗口成功率 < 阈值（分母排除 na，03 §7；样本 <3 不评估） |
  | symbol_gap_rate | warning | 1.0（缺口率 %） | — | 当日缺口率 > 阈值（开盘后满 30min 才评估，仅启用标的） |
  | collection_stall | critical | 3（分钟） | — | 交易时段连续 threshold 分钟无任何成功事件（D5 联动） |
  | tushare_daily_sync | warning | 0（未用） | — | 最近一条 tushare 事件为抓取失败且 ≤48h（三时点调度窗口） |
- **交易日历**：当前 = 工作日口径（is_trading_day/expected_minutes_elapsed 纯函数）；
  节假日表（0008，wave-2.md §3）接入后改走日历，函数签名不变。
- **缺口率口径**：expected = 当日交易时段已流逝分钟数（09:30-11:30 / 13:00-15:00，共 240），
  actual = kline_raw 当日行数（SymbolStatsRead.today_stats 复用，Asia/Shanghai 日界）。
- **站外通知不做**（用户定稿）；critical 由 shell 右上角 toast 强弹（前端 AppShell 订阅 alert topic）。

## 2. alert crate（Application 层：评估纯函数 + AlertService 编排）

``` {.rust file=crates/alert/src/lib.rs}
//! alert —— 应用层：告警引擎（规则评估 + 生命周期状态机；端口注入，不依赖 sqlx）。
//! 由 design/07-app-plane/02-alerts.md tangle 生成（ADR-007），禁止手改。

pub mod engine;
pub mod rules;
```

``` {.rust file=crates/alert/src/rules.rs}
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
        SymbolLatestView { code: code.into(), name: None, interval_secs: 60,
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
```

``` {.rust file=crates/alert/src/engine.rs}
//! AlertService：1min 评估节拍 + 告警生命周期状态机（触发→确认→恢复，语义见本文档 §1）。
//! 注入 domain 只读/持久化端口（ADR-017：应用面只读库；alert_* 为应用面自有表）。

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use domain::ports::{
    AlertEvalRead, AlertEvent, AlertFilter, AlertRule, AlertRulePatch, AlertStore, Clock,
    KlineRead, SymbolStatsRead,
};
use std::sync::Arc;

use crate::rules::{self, Evaluation};

/// 一轮评估的产出（WS 推送输入：fired=新建/续触发，resolved=恢复）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EvalOutcome {
    pub fired: Vec<AlertEvent>,
    pub resolved: Vec<AlertEvent>,
}

/// 告警服务（Application 层，与 diagnose::health::HealthService 同模式）。
pub struct AlertService {
    eval: Arc<dyn AlertEvalRead>,
    kline: Arc<dyn KlineRead>,
    stats: Arc<dyn SymbolStatsRead>,
    store: Arc<dyn AlertStore>,
    clock: Arc<dyn Clock>,
}

impl AlertService {
    pub fn new(eval: Arc<dyn AlertEvalRead>, kline: Arc<dyn KlineRead>,
               stats: Arc<dyn SymbolStatsRead>, store: Arc<dyn AlertStore>,
               clock: Arc<dyn Clock>) -> Self {
        Self { eval, kline, stats, store, clock }
    }

    /// 评估节拍（默认 1min 一轮，由 web::alerts::AlertEvaluator 循环驱动）：
    /// 规则每轮重读（阈值/开关/静默时长热生效）→ 分派内置规则评估 → 状态机落库。
    pub async fn evaluate(&self) -> Result<EvalOutcome> {
        let now = self.clock.now();
        let rules = self.store.list_rules().await?;
        let mut evals: Vec<Evaluation> = Vec::new();
        for rule in rules.iter().filter(|r| r.enabled) {
            match rule.id.as_str() {
                rules::RULE_SOURCE_SUCCESS_RATE => {
                    let since = now - Duration::minutes(rule.duration_minutes.max(1));
                    let events = self.eval.events_since(since).await?;
                    evals.extend(rules::eval_source_success_rate(rule, &events));
                }
                rules::RULE_SYMBOL_GAP_RATE => {
                    let symbols = self.kline.symbols_with_latest().await?;
                    let stats = self.stats.today_stats().await?;
                    evals.extend(rules::eval_symbol_gap_rate(rule, now, &symbols, &stats));
                }
                rules::RULE_COLLECTION_STALL => {
                    let since = now - Duration::minutes((rule.threshold as i64).max(1));
                    let events = self.eval.events_since(since).await?;
                    evals.extend(rules::eval_collection_stall(rule, now, &events));
                }
                rules::RULE_TUSHARE_DAILY_SYNC => {
                    let latest = self.eval.latest_event_of(rules::TUSHARE_SOURCE).await?;
                    evals.extend(rules::eval_tushare_daily_sync(rule, now, latest.as_ref()));
                }
                other => {
                    tracing::debug!(rule = other, "unknown alert rule id skipped");
                }
            }
        }
        self.apply(now, &rules, evals).await
    }

    /// 状态机应用（聚合防刷屏 + 静默期 + 恢复）：
    /// - breached & 无开放事件：距上次触发（含已恢复）≥ 静默期 → 新建 triggered
    /// - breached & 有开放事件：距 last_fired ≥ 静默期 → 续触发（count+1；已确认回退未确认）
    /// - 非 breached & 有开放事件 → 恢复 resolved
    async fn apply(&self, now: DateTime<Utc>, rules: &[AlertRule],
                   evals: Vec<Evaluation>) -> Result<EvalOutcome> {
        let mut out = EvalOutcome::default();
        for ev in evals {
            let Some(rule) = rules.iter().find(|r| r.id == ev.rule_id) else { continue };
            let open = self.store.open_incident(&ev.rule_id, &ev.source).await?;
            if ev.breached {
                let silence = Duration::minutes(rule.silence_minutes);
                match open {
                    Some(inc) => {
                        if now - inc.last_fired_at >= silence {
                            if let Some(e) = self.store.refire(inc.id, now).await? {
                                out.fired.push(e);
                            }
                        }
                    }
                    None => {
                        let last = self.store.last_fired_at(&ev.rule_id, &ev.source).await?;
                        if last.is_none_or(|t| now - t >= silence) {
                            let e = self.store.insert_incident(
                                &ev.rule_id, rule.level, &ev.source, &ev.message, now).await?;
                            out.fired.push(e);
                        }
                    }
                }
            } else if let Some(inc) = open {
                if let Some(e) = self.store.resolve(inc.id, now).await? {
                    out.resolved.push(e);
                }
            }
        }
        Ok(out)
    }

    /// GET /api/alerts（过滤解析/分页钳制在 web 层）。
    pub async fn list(&self, filter: &AlertFilter) -> Result<Vec<AlertEvent>> {
        self.store.list_events(filter).await
    }

    /// POST /api/alerts/{id}/ack：仅 triggered 可确认（确认时刻持久化，刷新不丢）。
    pub async fn ack(&self, id: i64) -> Result<Option<AlertEvent>> {
        self.store.ack(id, self.clock.now()).await
    }

    /// GET /api/alert-rules。
    pub async fn rules(&self) -> Result<Vec<AlertRule>> {
        self.store.list_rules().await
    }

    /// PATCH /api/alert-rules（热生效：下一评估节拍重读规则）。
    pub async fn update_rule(&self, id: &str, patch: &AlertRulePatch) -> Result<Option<AlertRule>> {
        self.store.patch_rule(id, patch).await
    }
}
```

## 3. alert crate 生命周期测试（内存端口，无 DB，确定性 fake clock）

``` {.rust file=crates/alert/tests/engine.rs}
//! 告警引擎状态机测试（内存端口 + fake clock，无 DB）：
//! 触发→确认→恢复全生命周期、聚合防刷屏、静默期、续触发回退未确认、四规则分派。

use alert::engine::{AlertService, EvalOutcome};
use alert::rules::{
    RULE_COLLECTION_STALL, RULE_SOURCE_SUCCESS_RATE, RULE_SYMBOL_GAP_RATE, RULE_TUSHARE_DAILY_SYNC,
    STALL_SOURCE, TUSHARE_SOURCE,
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    AlertEvalRead, AlertEvent, AlertFilter, AlertLevel, AlertRule, AlertRulePatch, AlertStatus,
    AlertStore, Clock, HealthEventRow, KlineBarView, KlineRead, SymbolLatestView, SymbolStatView,
    SymbolStatsRead,
};
use domain::types::Period;
use std::sync::{Arc, Mutex};

// ── fake clock ──

struct FakeClock(Mutex<DateTime<Utc>>);

impl FakeClock {
    fn at(t: DateTime<Utc>) -> Arc<Self> { Arc::new(Self(Mutex::new(t))) }
    fn set(&self, t: DateTime<Utc>) { *self.0.lock().unwrap() = t; }
}

impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> { *self.0.lock().unwrap() }
}

// ── 内存评估端口 ──

#[derive(Default)]
struct MemEval {
    events: Mutex<Vec<HealthEventRow>>,
}

impl MemEval {
    fn set(&self, events: Vec<HealthEventRow>) { *self.events.lock().unwrap() = events; }
}

#[async_trait::async_trait]
impl AlertEvalRead for MemEval {
    async fn events_since(&self, since: DateTime<Utc>) -> anyhow::Result<Vec<HealthEventRow>> {
        Ok(self.events.lock().unwrap().iter().filter(|e| e.ts > since).cloned().collect())
    }
    async fn latest_event_of(&self, source: &str) -> anyhow::Result<Option<HealthEventRow>> {
        Ok(self.events.lock().unwrap().iter()
            .filter(|e| e.source == source).max_by_key(|e| e.ts).cloned())
    }
}

struct MemKline(Mutex<Vec<SymbolLatestView>>);

#[async_trait::async_trait]
impl KlineRead for MemKline {
    async fn bars(&self, _p: Period, _c: &str, _b: Option<DateTime<Utc>>, _l: i64)
        -> anyhow::Result<Vec<KlineBarView>> { Ok(vec![]) }
    async fn symbols_with_latest(&self) -> anyhow::Result<Vec<SymbolLatestView>> {
        Ok(self.0.lock().unwrap().clone())
    }
}

struct MemStats(Mutex<Vec<SymbolStatView>>);

#[async_trait::async_trait]
impl SymbolStatsRead for MemStats {
    async fn today_stats(&self) -> anyhow::Result<Vec<SymbolStatView>> {
        Ok(self.0.lock().unwrap().clone())
    }
}

// ── 内存持久化端口（语义与 PgAlertStore SQL 一致，测试锁定同一状态机） ──

struct MemStore {
    rules: Mutex<Vec<AlertRule>>,
    events: Mutex<Vec<AlertEvent>>,
    next_id: Mutex<i64>,
}

impl MemStore {
    fn new(rules: Vec<AlertRule>) -> Self {
        Self { rules: Mutex::new(rules), events: Mutex::new(vec![]), next_id: Mutex::new(1) }
    }
}

#[async_trait::async_trait]
impl AlertStore for MemStore {
    async fn list_rules(&self) -> anyhow::Result<Vec<AlertRule>> {
        Ok(self.rules.lock().unwrap().clone())
    }
    async fn patch_rule(&self, id: &str, patch: &AlertRulePatch) -> anyhow::Result<Option<AlertRule>> {
        let mut rules = self.rules.lock().unwrap();
        let Some(r) = rules.iter_mut().find(|r| r.id == id) else { return Ok(None) };
        if let Some(t) = patch.threshold { r.threshold = t; }
        if let Some(e) = patch.enabled { r.enabled = e; }
        if let Some(s) = patch.silence_minutes { r.silence_minutes = s; }
        Ok(Some(r.clone()))
    }
    async fn open_incident(&self, rule_id: &str, source: &str) -> anyhow::Result<Option<AlertEvent>> {
        Ok(self.events.lock().unwrap().iter()
            .find(|e| e.rule_id == rule_id && e.source == source && e.resolved_at.is_none())
            .cloned())
    }
    async fn last_fired_at(&self, rule_id: &str, source: &str)
        -> anyhow::Result<Option<DateTime<Utc>>> {
        Ok(self.events.lock().unwrap().iter()
            .filter(|e| e.rule_id == rule_id && e.source == source)
            .map(|e| e.last_fired_at).max())
    }
    async fn insert_incident(&self, rule_id: &str, level: AlertLevel, source: &str,
                             message: &str, now: DateTime<Utc>) -> anyhow::Result<AlertEvent> {
        let mut next = self.next_id.lock().unwrap();
        let ev = AlertEvent {
            id: *next, rule_id: rule_id.into(), level, source: source.into(),
            message: message.into(), status: AlertStatus::Triggered, fire_count: 1,
            first_fired_at: now, last_fired_at: now, acked_at: None, resolved_at: None,
        };
        *next += 1;
        self.events.lock().unwrap().push(ev.clone());
        Ok(ev)
    }
    async fn refire(&self, id: i64, now: DateTime<Utc>) -> anyhow::Result<Option<AlertEvent>> {
        let mut events = self.events.lock().unwrap();
        let Some(e) = events.iter_mut().find(|e| e.id == id) else { return Ok(None) };
        e.fire_count += 1;
        e.last_fired_at = now;
        e.status = AlertStatus::Triggered;   // 已确认回退未确认（新活动需重新确认）
        e.acked_at = None;
        Ok(Some(e.clone()))
    }
    async fn resolve(&self, id: i64, now: DateTime<Utc>) -> anyhow::Result<Option<AlertEvent>> {
        let mut events = self.events.lock().unwrap();
        let Some(e) = events.iter_mut().find(|e| e.id == id) else { return Ok(None) };
        if e.resolved_at.is_some() { return Ok(None); }
        e.status = AlertStatus::Resolved;
        e.resolved_at = Some(now);
        Ok(Some(e.clone()))
    }
    async fn ack(&self, id: i64, now: DateTime<Utc>) -> anyhow::Result<Option<AlertEvent>> {
        let mut events = self.events.lock().unwrap();
        let Some(e) = events.iter_mut().find(|e| e.id == id) else { return Ok(None) };
        if e.status != AlertStatus::Triggered { return Ok(None); }
        e.status = AlertStatus::Acked;
        e.acked_at = Some(now);
        Ok(Some(e.clone()))
    }
    async fn list_events(&self, filter: &AlertFilter) -> anyhow::Result<Vec<AlertEvent>> {
        let mut out: Vec<_> = self.events.lock().unwrap().iter().filter(|e| {
            filter.level.is_none_or(|l| e.level == l)
                && filter.from.is_none_or(|f| e.last_fired_at >= f)
                && filter.to.is_none_or(|t| e.last_fired_at < t)
                && filter.source.as_deref().is_none_or(|s| e.source == s)
        }).cloned().collect();
        out.sort_by_key(|e| std::cmp::Reverse(e.last_fired_at));
        out.truncate(filter.limit.max(1) as usize);
        Ok(out)
    }
}

// ── 装配与造数 ──

fn rule(id: &str, level: AlertLevel, threshold: f64, duration: i64, silence: i64) -> AlertRule {
    AlertRule { id: id.into(), name: id.into(), level, threshold,
        duration_minutes: duration, silence_minutes: silence, enabled: true }
}

fn all_rules() -> Vec<AlertRule> {
    vec![
        rule(RULE_SOURCE_SUCCESS_RATE, AlertLevel::Warning, 0.95, 10, 10),
        rule(RULE_SYMBOL_GAP_RATE, AlertLevel::Warning, 1.0, 0, 30),
        rule(RULE_COLLECTION_STALL, AlertLevel::Critical, 3.0, 0, 10),
        rule(RULE_TUSHARE_DAILY_SYNC, AlertLevel::Warning, 0.0, 0, 60),
    ]
}

struct Fixture {
    svc: AlertService,
    eval: Arc<MemEval>,
    kline: Arc<MemKline>,
    stats: Arc<MemStats>,
    store: Arc<MemStore>,
    clock: Arc<FakeClock>,
}

/// t0 = 2026-09-07 10:00 CST（周一，交易中，expected=30min）。
fn t0() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 7, 2, 0, 0).unwrap() }

fn fixture(rules: Vec<AlertRule>) -> Fixture {
    let eval = Arc::new(MemEval::default());
    let kline = Arc::new(MemKline(Mutex::new(vec![])));
    let stats = Arc::new(MemStats(Mutex::new(vec![])));
    let store = Arc::new(MemStore::new(rules));
    let clock = FakeClock::at(t0());
    let svc = AlertService::new(
        eval.clone(), kline.clone(), stats.clone(), store.clone(), clock.clone());
    Fixture { svc, eval, kline, stats, store, clock }
}

fn ok_events(src: &str, n: usize, at: DateTime<Utc>) -> Vec<HealthEventRow> {
    (0..n).map(|i| HealthEventRow { ts: at - Duration::seconds(30 + i as i64),
        source: src.into(), ok: true, latency_ms: Some(100), err_kind: None, code: None }).collect()
}

fn sym(code: &str, enabled: bool) -> SymbolLatestView {
    SymbolLatestView { code: code.into(), name: None, interval_secs: 60, settlement: "T1".into(),
        enabled, last_ts: None, last_close: None, prev_close: None }
}

/// 全规则开启时默认不触发基线：源全部健康 + 标的满格 + tushare 最近成功。
fn seed_healthy(f: &Fixture) {
    let mut events = ok_events("tencent_ifzq", 5, t0());
    events.extend(ok_events(TUSHARE_SOURCE, 1, t0()));
    f.eval.set(events);
    *f.kline.0.lock().unwrap() = vec![sym("600519", true)];
    *f.stats.0.lock().unwrap() =
        vec![SymbolStatView { code: "600519".into(), today_bars: 30, last_bar_ts: None }];
}

// ── 生命周期：触发 → 确认 → 恢复 ──

#[tokio::test]
async fn full_lifecycle_fire_ack_resolve() {
    let f = fixture(all_rules());
    seed_healthy(&f);
    // 基线：全部健康 → 无触发
    assert_eq!(f.svc.evaluate().await.unwrap(), EvalOutcome::default());

    // 源成功率 1/4 = 25% < 95% → 触发
    let mut bad = ok_events("tencent_ifzq", 1, t0());
    for i in 0..3 {
        bad.push(HealthEventRow { ts: t0() - Duration::seconds(i), source: "tencent_ifzq".into(),
            ok: false, latency_ms: None, err_kind: Some("timeout".into()), code: None });
    }
    bad.extend(ok_events(TUSHARE_SOURCE, 1, t0()));
    f.eval.set(bad);
    let out = f.svc.evaluate().await.unwrap();
    assert_eq!(out.fired.len(), 1);
    assert!(out.resolved.is_empty());
    let inc = &out.fired[0];
    assert_eq!(inc.rule_id, RULE_SOURCE_SUCCESS_RATE);
    assert_eq!(inc.source, "tencent_ifzq");
    assert_eq!(inc.status, AlertStatus::Triggered);
    assert_eq!(inc.fire_count, 1);
    assert!(inc.message.contains("25.0%"));

    // 确认（持久化 acked_at）
    let acked = f.svc.ack(inc.id).await.unwrap().expect("triggered 可确认");
    assert_eq!(acked.status, AlertStatus::Acked);
    assert!(acked.acked_at.is_some());
    // 重复确认 → None（幂等，web 404）
    assert!(f.svc.ack(inc.id).await.unwrap().is_none());

    // 恢复健康 → 自动恢复（acked → resolved）
    seed_healthy(&f);
    let out = f.svc.evaluate().await.unwrap();
    assert!(out.fired.is_empty());
    assert_eq!(out.resolved.len(), 1);
    assert_eq!(out.resolved[0].status, AlertStatus::Resolved);
    assert!(out.resolved[0].resolved_at.is_some());
    // 恢复后 ack → None
    assert!(f.svc.ack(inc.id).await.unwrap().is_none());
}

// ── 聚合防刷屏 + 静默期 + 续触发回退未确认 ──

#[tokio::test]
async fn aggregation_silence_and_refire_reopens() {
    let f = fixture(vec![rule(RULE_SOURCE_SUCCESS_RATE, AlertLevel::Warning, 0.95, 10, 10)]);
    // 事件时间跟随 fake clock（评估窗口 = now - duration）
    let bad = |at: DateTime<Utc>| {
        let mut v = ok_events("src_x", 1, at);
        for i in 0..3 {
            v.push(HealthEventRow { ts: at - Duration::seconds(i), source: "src_x".into(),
                ok: false, latency_ms: None, err_kind: Some("http".into()), code: None });
        }
        v
    };
    f.eval.set(bad(t0()));
    let first = f.svc.evaluate().await.unwrap().fired.remove(0);
    assert_eq!(first.fire_count, 1);

    // 静默期内（+1min）持续 breach → 不续触发、不新建
    f.clock.set(t0() + Duration::minutes(1));
    f.eval.set(bad(t0() + Duration::minutes(1)));
    let out = f.svc.evaluate().await.unwrap();
    assert!(out.fired.is_empty(), "静默期内不续触发");

    // 确认后过静默期再 breach → 续触发 count+1 且回退未确认
    let id = f.store.open_incident(RULE_SOURCE_SUCCESS_RATE, "src_x").await.unwrap().unwrap().id;
    f.svc.ack(id).await.unwrap();
    f.clock.set(t0() + Duration::minutes(11));
    f.eval.set(bad(t0() + Duration::minutes(11)));
    let out = f.svc.evaluate().await.unwrap();
    assert_eq!(out.fired.len(), 1);
    assert_eq!(out.fired[0].id, first.id, "聚合为同一条（防刷屏）");
    assert_eq!(out.fired[0].fire_count, 2);
    assert_eq!(out.fired[0].status, AlertStatus::Triggered, "已确认续触发 → 回退未确认");
    assert!(out.fired[0].acked_at.is_none());
}

#[tokio::test]
async fn silence_suppresses_new_incident_after_resolve() {
    let f = fixture(vec![rule(RULE_SOURCE_SUCCESS_RATE, AlertLevel::Warning, 0.95, 10, 10)]);
    // 事件时间跟随 fake clock（评估窗口 = now - duration）
    let bad = |at: DateTime<Utc>| vec![
        HealthEventRow { ts: at, source: "src_y".into(), ok: false, latency_ms: None,
            err_kind: Some("http".into()), code: None },
        HealthEventRow { ts: at, source: "src_y".into(), ok: false, latency_ms: None,
            err_kind: Some("http".into()), code: None },
        HealthEventRow { ts: at, source: "src_y".into(), ok: true, latency_ms: None,
            err_kind: None, code: None },
    ];
    f.eval.set(bad(t0()));
    assert_eq!(f.svc.evaluate().await.unwrap().fired.len(), 1);

    // 恢复（全部成功）
    f.eval.set(ok_events("src_y", 4, t0()));
    assert_eq!(f.svc.evaluate().await.unwrap().resolved.len(), 1);

    // 静默期内再 breach → 不新建（last_fired_at 含已恢复事件，防抖）
    f.clock.set(t0() + Duration::minutes(5));
    f.eval.set(bad(t0() + Duration::minutes(5)));
    assert!(f.svc.evaluate().await.unwrap().fired.is_empty(), "静默期抑制抖动重建");

    // 过静默期 → 新建第二条事件
    f.clock.set(t0() + Duration::minutes(11));
    f.eval.set(bad(t0() + Duration::minutes(11)));
    let out = f.svc.evaluate().await.unwrap();
    assert_eq!(out.fired.len(), 1);
    assert_eq!(out.fired[0].fire_count, 1, "新事件计数从 1 开始");
}

// ── 四规则分派 ──

#[tokio::test]
async fn gap_stall_tushare_rules_dispatch() {
    let f = fixture(all_rules());
    // 缺口：600519 仅 20/30 根（33.3% > 1%）；600510 停用不报
    *f.kline.0.lock().unwrap() = vec![sym("600519", true), sym("600510", false)];
    *f.stats.0.lock().unwrap() =
        vec![SymbolStatView { code: "600519".into(), today_bars: 20, last_bar_ts: None }];
    // 停摆：窗口内无任何成功事件（stall 窗口 3min；成功率窗口 10min 内 tencent 样本 <3 不评估）
    f.eval.set(vec![HealthEventRow { ts: t0() - Duration::hours(2), source: TUSHARE_SOURCE.into(),
        ok: false, latency_ms: None, err_kind: Some("http".into()), code: None }]);
    let out = f.svc.evaluate().await.unwrap();
    let by_rule = |id: &str| out.fired.iter().find(|e| e.rule_id == id);
    assert!(by_rule(RULE_SYMBOL_GAP_RATE).is_some(), "缺口率触发");
    assert_eq!(by_rule(RULE_SYMBOL_GAP_RATE).unwrap().source, "600519");
    let stall = by_rule(RULE_COLLECTION_STALL).expect("停摆触发");
    assert_eq!(stall.level, AlertLevel::Critical);
    assert_eq!(stall.source, STALL_SOURCE);
    let ts = by_rule(RULE_TUSHARE_DAILY_SYNC).expect("tushare 失败触发");
    assert_eq!(ts.source, TUSHARE_SOURCE);
    assert!(ts.message.contains("http"));

    // 午休（12:00 CST）：停摆不评估；缺口继续评估（expected=120）
    f.clock.set(t0() + Duration::hours(2));
    let out = f.svc.evaluate().await.unwrap();
    assert!(out.resolved.iter().all(|e| e.rule_id != RULE_COLLECTION_STALL),
        "午休不评估停摆 → 既有事件不自动恢复（保持原状）");
}

#[tokio::test]
async fn disabled_rule_skipped() {
    let mut rules = all_rules();
    rules.iter_mut().find(|r| r.id == RULE_COLLECTION_STALL).unwrap().enabled = false;
    let f = fixture(rules);
    seed_healthy(&f);
    f.eval.set(vec![]); // 无任何事件：停摆条件成立但规则停用
    let out = f.svc.evaluate().await.unwrap();
    assert!(out.fired.iter().all(|e| e.rule_id != RULE_COLLECTION_STALL), "停用规则不评估");
}

// ── 查询/规则管理透传 ──

#[tokio::test]
async fn list_filter_and_rule_patch_passthrough() {
    let f = fixture(vec![rule(RULE_SOURCE_SUCCESS_RATE, AlertLevel::Warning, 0.95, 10, 10)]);
    f.eval.set(vec![
        HealthEventRow { ts: t0(), source: "src_z".into(), ok: false, latency_ms: None,
            err_kind: Some("http".into()), code: None },
        HealthEventRow { ts: t0(), source: "src_z".into(), ok: false, latency_ms: None,
            err_kind: Some("http".into()), code: None },
        HealthEventRow { ts: t0(), source: "src_z".into(), ok: true, latency_ms: None,
            err_kind: None, code: None },
    ]);
    f.svc.evaluate().await.unwrap();

    let all = f.svc.list(&AlertFilter { limit: 200, ..Default::default() }).await.unwrap();
    assert_eq!(all.len(), 1);
    let by_src = f.svc.list(&AlertFilter { source: Some("nobody".into()), limit: 200,
        ..Default::default() }).await.unwrap();
    assert!(by_src.is_empty());
    let by_level = f.svc.list(&AlertFilter { level: Some(AlertLevel::Critical), limit: 200,
        ..Default::default() }).await.unwrap();
    assert!(by_level.is_empty());

    // 阈值热生效：0.95 → 0.30 后 1/3=33% 不再触发 → 恢复
    let r = f.svc.update_rule(RULE_SOURCE_SUCCESS_RATE,
        &AlertRulePatch { threshold: Some(0.30), ..Default::default() }).await.unwrap();
    assert!(r.is_some());
    assert_eq!(r.unwrap().threshold, 0.30);
    let out = f.svc.evaluate().await.unwrap();
    assert_eq!(out.resolved.len(), 1, "阈值调低后原触发场景不再告警（热生效）");
    assert!(f.svc.update_rule("no_such_rule", &AlertRulePatch::default())
        .await.unwrap().is_none());
}
```

## 4. storage 加法扩展（PgAlertStore / PgAlertEval）

父级授权口径同 Phase A/C（「storage 接口加法扩展可以」）：`alerts.rs` 为纯新增文件，
写路径（kline/accurate/events/symbols/reader/admin）零改动；
`pub mod alerts;` 声明维护在 design/04-storage/02-tushare-sync.md。

``` {.rust file=crates/storage/src/alerts.rs}
//! 告警引擎端口实现（Wave 2 Phase B 加法扩展，ADR-017 授权口径；数据面既有路径零改动）：
//! - PgAlertStore：alert_rules / alert_events（0009；应用面自有表，数据面不读写）
//! - PgAlertEval：评估读输入（events_since / latest_event_of，读 source_health_events）
//!
//! 状态机转移决策在 alert crate（engine.rs），本层仅提供原子原语；CHECK/唯一索引兜底。

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{
    AlertEvalRead, AlertEvent, AlertFilter, AlertLevel, AlertRule, AlertRulePatch, AlertStatus,
    AlertStore, HealthEventRow,
};
use sqlx::PgPool;

const RULE_COLS: &str = "id, name, level, threshold, duration_minutes, silence_minutes, enabled";
const EVENT_COLS: &str =
    "id, rule_id, level, source, message, status, fire_count, \
     first_fired_at, last_fired_at, acked_at, resolved_at";

type RuleRow = (String, String, String, f64, i32, i32, bool);
type EventRow = (i64, String, String, String, String, String, i32,
                 DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>, Option<DateTime<Utc>>);

fn rule_of((id, name, level, threshold, duration, silence, enabled): RuleRow) -> AlertRule {
    AlertRule {
        id, name,
        level: AlertLevel::parse(&level).expect("alert_rules CHECK 约束保证合法级别"),
        threshold,
        duration_minutes: duration as i64,
        silence_minutes: silence as i64,
        enabled,
    }
}

fn event_of(r: EventRow) -> AlertEvent {
    AlertEvent {
        id: r.0, rule_id: r.1,
        level: AlertLevel::parse(&r.2).expect("alert_events CHECK 约束保证合法级别"),
        source: r.3, message: r.4,
        status: AlertStatus::parse(&r.5).expect("alert_events CHECK 约束保证合法状态"),
        fire_count: r.6 as i64,
        first_fired_at: r.7, last_fired_at: r.8, acked_at: r.9, resolved_at: r.10,
    }
}

/// 告警持久化（alert crate 状态机原语；web REST 数据源）。
pub struct PgAlertStore {
    pool: PgPool,
}

impl PgAlertStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl AlertStore for PgAlertStore {
    async fn list_rules(&self) -> Result<Vec<AlertRule>> {
        let rows: Vec<RuleRow> = sqlx::query_as(
            &format!("SELECT {RULE_COLS} FROM alert_rules ORDER BY id"))
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(rule_of).collect())
    }

    async fn patch_rule(&self, id: &str, patch: &AlertRulePatch) -> Result<Option<AlertRule>> {
        let row: Option<RuleRow> = sqlx::query_as(
            &format!("UPDATE alert_rules SET \
                 threshold = COALESCE($2, threshold), \
                 silence_minutes = COALESCE($3, silence_minutes), \
                 enabled = COALESCE($4, enabled), \
                 updated_at = now() \
             WHERE id = $1 RETURNING {RULE_COLS}"))
            .bind(id).bind(patch.threshold).bind(patch.silence_minutes)
            .bind(patch.enabled)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(rule_of))
    }

    async fn open_incident(&self, rule_id: &str, source: &str) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("SELECT {EVENT_COLS} FROM alert_events \
             WHERE rule_id = $1 AND source = $2 AND resolved_at IS NULL \
             ORDER BY id DESC LIMIT 1"))
            .bind(rule_id).bind(source).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    async fn last_fired_at(&self, rule_id: &str, source: &str) -> Result<Option<DateTime<Utc>>> {
        let (ts,): (Option<DateTime<Utc>>,) = sqlx::query_as(
            "SELECT max(last_fired_at) FROM alert_events WHERE rule_id = $1 AND source = $2")
            .bind(rule_id).bind(source).fetch_one(&self.pool).await?;
        Ok(ts)
    }

    async fn insert_incident(&self, rule_id: &str, level: AlertLevel, source: &str,
                             message: &str, now: DateTime<Utc>) -> Result<AlertEvent> {
        let row: EventRow = sqlx::query_as(
            &format!("INSERT INTO alert_events \
                 (rule_id, level, source, message, first_fired_at, last_fired_at) \
             VALUES ($1, $2, $3, $4, $5, $5) RETURNING {EVENT_COLS}"))
            .bind(rule_id).bind(level.as_str()).bind(source).bind(message).bind(now)
            .fetch_one(&self.pool).await?;
        Ok(event_of(row))
    }

    /// 续触发：计数+1、推进 last_fired_at、回退 triggered 并清 acked_at（新活动需重新确认）。
    async fn refire(&self, id: i64, now: DateTime<Utc>) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("UPDATE alert_events SET \
                 fire_count = fire_count + 1, last_fired_at = $2, \
                 status = 'triggered', acked_at = NULL \
             WHERE id = $1 RETURNING {EVENT_COLS}"))
            .bind(id).bind(now).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    async fn resolve(&self, id: i64, now: DateTime<Utc>) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("UPDATE alert_events SET status = 'resolved', resolved_at = $2 \
             WHERE id = $1 AND resolved_at IS NULL RETURNING {EVENT_COLS}"))
            .bind(id).bind(now).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    /// 仅 triggered 可确认（其余 → None，web 映射 404）。
    async fn ack(&self, id: i64, now: DateTime<Utc>) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("UPDATE alert_events SET status = 'acked', acked_at = $2 \
             WHERE id = $1 AND status = 'triggered' RETURNING {EVENT_COLS}"))
            .bind(id).bind(now).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    /// 列表（last_fired_at 降序；$1..$4 全 None = 全量按 $5 截断）。
    async fn list_events(&self, filter: &AlertFilter) -> Result<Vec<AlertEvent>> {
        let rows: Vec<EventRow> = sqlx::query_as(
            &format!("SELECT {EVENT_COLS} FROM alert_events \
             WHERE ($1::text IS NULL OR level = $1) \
               AND ($2::timestamptz IS NULL OR last_fired_at >= $2) \
               AND ($3::timestamptz IS NULL OR last_fired_at < $3) \
               AND ($4::text IS NULL OR source = $4) \
             ORDER BY last_fired_at DESC LIMIT $5"))
            .bind(filter.level.map(|l| l.as_str()))
            .bind(filter.from).bind(filter.to).bind(filter.source.as_deref())
            .bind(filter.limit)
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(event_of).collect())
    }
}

/// 评估读输入（读 source_health_events，ADR-017 应用面只读库）。
pub struct PgAlertEval {
    pool: PgPool,
}

impl PgAlertEval {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

type EvRow = (DateTime<Utc>, String, bool, Option<i32>, Option<String>, Option<String>);

fn row_of((ts, source, ok, latency_ms, err_kind, code): EvRow) -> HealthEventRow {
    HealthEventRow { ts, source, ok, latency_ms, err_kind, code }
}

#[async_trait]
impl AlertEvalRead for PgAlertEval {
    async fn events_since(&self, since: DateTime<Utc>) -> Result<Vec<HealthEventRow>> {
        let rows: Vec<EvRow> = sqlx::query_as(
            "SELECT ts, source, ok, latency_ms, err_kind, code \
             FROM source_health_events WHERE ts > $1 ORDER BY ts")
            .bind(since).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(row_of).collect())
    }

    async fn latest_event_of(&self, source: &str) -> Result<Option<HealthEventRow>> {
        let row: Option<EvRow> = sqlx::query_as(
            "SELECT ts, source, ok, latency_ms, err_kind, code \
             FROM source_health_events WHERE source = $1 ORDER BY ts DESC LIMIT 1")
            .bind(source).fetch_optional(&self.pool).await?;
        Ok(row.map(row_of))
    }
}
```

集成测试（需 TimescaleDB :5433 + 0009 迁移；独立 source 段 alertstore_test_* 前后清理，可重入）：

``` {.rust file=crates/storage/tests/alert_store.rs}
//! PgAlertStore / PgAlertEval 集成测试（需 TimescaleDB :5433，含 0009 迁移）：
//! 规则 CRUD、事件状态机原语（insert/refire/ack/resolve）、开放事件唯一约束、
//! 列表过滤、评估读输入窗口/单源最近事件。
//! 每测试独立 source 段（同 binary 并行执行，共享清理会互删——实锤踩坑口径）；
//! 规则行为全局行：仅 patch 测试改 tushare_daily_sync（其他测试不触碰该规则），用后自愈复原。

use chrono::{Duration, TimeZone, Utc};
use domain::ports::{
    AlertEvalRead, AlertFilter, AlertLevel, AlertRulePatch, AlertStatus, AlertStore,
};
use sqlx::PgPool;
use storage::alerts::{PgAlertEval, PgAlertStore};

const PATCH_RULE: &str = "tushare_daily_sync";   // patch 测试专用规则（无其他测试触碰）

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 仅清理本测试自己的 source 段（rules 行由 patch 测试自行复原，不在公共清理内）。
async fn clean(pool: &PgPool, sources: &[&str]) {
    for s in sources {
        sqlx::query("DELETE FROM alert_events WHERE source = $1")
            .bind(s).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM source_health_events WHERE source = $1")
            .bind(s).execute(pool).await.unwrap();
    }
}

fn t0() -> chrono::DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 7, 2, 0, 0).unwrap() }

#[tokio::test]
async fn rules_seeded_and_patch_roundtrip() {
    let pool = pool().await;
    let store = PgAlertStore::new(pool.clone());

    let rules = store.list_rules().await.unwrap();
    assert_eq!(rules.len(), 4, "0009 种子内置规则首批");
    for id in ["source_success_rate", "symbol_gap_rate", "collection_stall", "tushare_daily_sync"] {
        assert!(rules.iter().any(|r| r.id == id), "种子含 {id}");
    }
    let r = rules.iter().find(|r| r.id == "source_success_rate").unwrap();
    assert_eq!(r.level, AlertLevel::Warning);
    assert_eq!(r.threshold, 0.95);
    assert_eq!(r.duration_minutes, 10);
    assert_eq!(r.silence_minutes, 10);
    assert!(r.enabled);
    let stall = rules.iter().find(|r| r.id == "collection_stall").unwrap();
    assert_eq!(stall.level, AlertLevel::Critical, "停摆 = critical（07-alerts §2 系统类）");

    // patch：阈值/静默/开关 COALESCE 语义（None 不改）
    let patched = store.patch_rule(PATCH_RULE, &AlertRulePatch {
        threshold: Some(1.0), silence_minutes: Some(120), ..Default::default()
    }).await.unwrap().expect("规则存在");
    assert_eq!(patched.threshold, 1.0);
    assert_eq!(patched.silence_minutes, 120);
    assert!(patched.enabled, "None 字段不改");
    let toggled = store.patch_rule(PATCH_RULE, &AlertRulePatch {
        enabled: Some(false), ..Default::default() }).await.unwrap().unwrap();
    assert!(!toggled.enabled);
    assert_eq!(toggled.threshold, 1.0, "开关补丁不动阈值");

    assert!(store.patch_rule("no_such_rule", &AlertRulePatch::default())
        .await.unwrap().is_none(), "未知 id → None（web 404）");

    // 自愈复原种子值（0009 口径）
    store.patch_rule(PATCH_RULE, &AlertRulePatch {
        threshold: Some(0.0), silence_minutes: Some(60), enabled: Some(true),
    }).await.unwrap();
}

#[tokio::test]
async fn incident_state_machine_primitives() {
    const SRC: &str = "alertstore_inc_src";
    const RULE: &str = "source_success_rate";
    let pool = pool().await;
    clean(&pool, &[SRC]).await;
    let store = PgAlertStore::new(pool.clone());

    // insert → open
    let ev = store.insert_incident(RULE, AlertLevel::Warning, SRC, "测试触发", t0()).await.unwrap();
    assert_eq!(ev.status, AlertStatus::Triggered);
    assert_eq!(ev.fire_count, 1);
    assert_eq!(ev.first_fired_at, t0());
    assert!(ev.acked_at.is_none() && ev.resolved_at.is_none());
    let open = store.open_incident(RULE, SRC).await.unwrap().expect("开放事件");
    assert_eq!(open.id, ev.id);

    // 开放事件唯一（部分唯一索引兜底：同 rule+source 未恢复至多一条）
    assert!(store.insert_incident(RULE, AlertLevel::Warning, SRC, "重复", t0()).await.is_err(),
        "alert_events_open_uq 拒绝第二条开放事件");

    // refire：计数+1、推进 last_fired
    let refired = store.refire(ev.id, t0() + Duration::minutes(11)).await.unwrap().unwrap();
    assert_eq!(refired.fire_count, 2);
    assert_eq!(refired.last_fired_at, t0() + Duration::minutes(11));

    // ack（仅 triggered）
    let acked = store.ack(ev.id, t0() + Duration::minutes(12)).await.unwrap().unwrap();
    assert_eq!(acked.status, AlertStatus::Acked);
    assert!(acked.acked_at.is_some());
    assert!(store.ack(ev.id, t0()).await.unwrap().is_none(), "已确认 → None（幂等）");

    // refire 回退未确认（新活动需重新确认）
    let reopened = store.refire(ev.id, t0() + Duration::minutes(30)).await.unwrap().unwrap();
    assert_eq!(reopened.status, AlertStatus::Triggered);
    assert!(reopened.acked_at.is_none());
    assert_eq!(reopened.fire_count, 3);

    // resolve（幂等）
    let resolved = store.resolve(ev.id, t0() + Duration::minutes(31)).await.unwrap().unwrap();
    assert_eq!(resolved.status, AlertStatus::Resolved);
    assert!(resolved.resolved_at.is_some());
    assert!(store.resolve(ev.id, t0()).await.unwrap().is_none(), "已恢复幂等 → None");
    assert!(store.open_incident(RULE, SRC).await.unwrap().is_none(), "恢复后不再开放");
    assert!(store.ack(ev.id, t0()).await.unwrap().is_none(), "已恢复不可确认");

    // last_fired_at 含已恢复事件（静默期防抖输入）
    assert_eq!(store.last_fired_at(RULE, SRC).await.unwrap(),
        Some(t0() + Duration::minutes(30)));
    assert!(store.last_fired_at(RULE, "nobody").await.unwrap().is_none());

    // 恢复后可新建（唯一索引只覆盖开放事件）
    let ev2 = store.insert_incident(RULE, AlertLevel::Warning, SRC, "再次触发",
        t0() + Duration::minutes(40)).await.unwrap();
    assert_eq!(ev2.fire_count, 1);
    assert_ne!(ev2.id, ev.id);
    clean(&pool, &[SRC]).await;
}

#[tokio::test]
async fn list_events_filters() {
    const A: &str = "alertstore_list_a";
    const B: &str = "alertstore_list_b";
    let pool = pool().await;
    clean(&pool, &[A, B]).await;
    let store = PgAlertStore::new(pool.clone());
    store.insert_incident("source_success_rate", AlertLevel::Warning, A, "m1", t0()).await.unwrap();
    store.insert_incident("collection_stall", AlertLevel::Critical, A, "m2",
        t0() + Duration::minutes(5)).await.unwrap();
    store.insert_incident("source_success_rate", AlertLevel::Warning, B, "m3",
        t0() + Duration::minutes(10)).await.unwrap();

    let all = store.list_events(&AlertFilter { limit: 200, ..Default::default() }).await.unwrap();
    let mine: Vec<_> = all.iter().filter(|e| e.source == A || e.source == B).collect();
    assert_eq!(mine.len(), 3);
    assert_eq!(mine[0].source, B, "last_fired_at 降序");

    let warn = store.list_events(&AlertFilter { level: Some(AlertLevel::Warning), limit: 200,
        ..Default::default() }).await.unwrap();
    assert!(warn.iter().all(|e| e.level == AlertLevel::Warning));

    let by_src = store.list_events(&AlertFilter { source: Some(A.into()), limit: 200,
        ..Default::default() }).await.unwrap();
    assert_eq!(by_src.len(), 2);

    let ranged = store.list_events(&AlertFilter {
        from: Some(t0() + Duration::minutes(4)), to: Some(t0() + Duration::minutes(6)),
        limit: 200, ..Default::default() }).await.unwrap();
    assert_eq!(ranged.len(), 1, "from/to 窗口（last_fired_at 口径）");
    assert_eq!(ranged[0].message, "m2");

    let lim = store.list_events(&AlertFilter { limit: 1, ..Default::default() }).await.unwrap();
    assert_eq!(lim.len(), 1);
    clean(&pool, &[A, B]).await;
}

#[tokio::test]
async fn eval_read_window_and_latest_of() {
    const A: &str = "alertstore_eval_a";
    const B: &str = "alertstore_eval_b";
    let pool = pool().await;
    clean(&pool, &[A, B]).await;
    let now = Utc::now();
    for (i, ok) in [true, false, true].into_iter().enumerate() {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms, err_kind) \
                     VALUES ($1, $2, $3, 100, $4)")
            .bind(now - Duration::seconds(30 - i as i64)).bind(A).bind(ok)
            .bind(if ok { None } else { Some("timeout") })
            .execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO source_health_events (ts, source, ok) VALUES ($1, $2, true)")
        .bind(now - Duration::hours(2)).bind(B).execute(&pool).await.unwrap();

    let eval = PgAlertEval::new(pool.clone());
    let events = eval.events_since(now - Duration::minutes(5)).await.unwrap();
    let mine: Vec<_> = events.iter().filter(|e| e.source == A).collect();
    assert_eq!(mine.len(), 3, "窗口内事件");
    assert!(mine.iter().all(|e| e.ts > now - Duration::minutes(5)));
    assert!(events.iter().all(|e| e.source != B), "窗口外不入选");

    let latest = eval.latest_event_of(A).await.unwrap().expect("有事件");
    assert!(latest.ok, "最新一条 = 最后插入的成功事件");
    assert!(eval.latest_event_of("nobody_source").await.unwrap().is_none());
    clean(&pool, &[A, B]).await;
}
```

## 5. web 加法（handlers + 评估推送循环；装配在 00-web-api.md 既有块）

契约（07-alerts §6）：`GET /api/alerts?level=&from=&to=&source=`（+`limit` 默认 200 封顶 1000）、
`POST /api/alerts/{id}/ack`、`GET/PATCH /api/alert-rules`、WS `{type:"alert", ...}`（扁平化事件字段）。
路由/state/WS topic/eestock-app 装配为 00-web-api.md 既有块的加法编辑（本模块由其 `pub mod alerts;` 挂载）。

``` {.rust file=crates/web/src/alerts.rs}
//! 页面⑦ 告警中心 REST handlers + 评估推送循环（Wave 2 Phase B；契约 07-alerts §6）。
//! 由 design/07-app-plane/02-alerts.md tangle 生成（ADR-007），禁止手改。
//! 评估节拍驱动（默认 1min）→ AlertService.evaluate() → 新建/续触发/恢复事件经 WS hub 推送
//! {type:"alert", ...}（info/warning 静默入列表；critical 由前端 shell 右上角 toast 强弹）。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use domain::ports::{AlertEvent, AlertFilter, AlertLevel, AlertRule, AlertRulePatch, AlertStatus};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::state::AppState;
use crate::ws::PushMsg;

const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn internal(e: anyhow::Error) -> Response {
    tracing::warn!(error = %e, "alerts handler failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

// ── DTO（07-alerts §6 线格式；与前端 api/types.ts AlertEventItem/AlertRuleItem 对齐）──

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertEventDto {
    pub id: i64,
    pub rule_id: String,
    pub level: AlertLevel,
    pub source: String,
    pub message: String,
    pub status: AlertStatus,
    pub fire_count: i64,
    pub first_fired_at: DateTime<Utc>,
    pub last_fired_at: DateTime<Utc>,
    pub acked_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
}

impl From<&AlertEvent> for AlertEventDto {
    fn from(e: &AlertEvent) -> Self {
        AlertEventDto {
            id: e.id, rule_id: e.rule_id.clone(), level: e.level, source: e.source.clone(),
            message: e.message.clone(), status: e.status, fire_count: e.fire_count,
            first_fired_at: e.first_fired_at, last_fired_at: e.last_fired_at,
            acked_at: e.acked_at, resolved_at: e.resolved_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AlertRuleDto {
    pub id: String,
    pub name: String,
    pub level: AlertLevel,
    pub threshold: f64,
    pub duration_minutes: i64,
    pub silence_minutes: i64,
    pub enabled: bool,
}

impl From<&AlertRule> for AlertRuleDto {
    fn from(r: &AlertRule) -> Self {
        AlertRuleDto {
            id: r.id.clone(), name: r.name.clone(), level: r.level, threshold: r.threshold,
            duration_minutes: r.duration_minutes, silence_minutes: r.silence_minutes,
            enabled: r.enabled,
        }
    }
}

// ── GET /api/alerts?level=&from=&to=&source=&limit= ──

#[derive(Debug, Deserialize)]
pub struct AlertsQuery {
    pub level: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub source: Option<String>,
    pub limit: Option<i64>,
}

/// 过滤参数校验错误（小错误类型，与 dto.rs FieldError 同惯例；
/// 避免 Result<_, Response> 大 Err 变体——clippy result_large_err 收口）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterError(pub String);

/// 查询参数 → AlertFilter（非法值 FilterError → handler 映射 400；limit 默认 200 封顶 1000）。
pub fn parse_filter(q: AlertsQuery) -> Result<AlertFilter, FilterError> {
    let level = match q.level.as_deref() {
        None => None,
        Some(s) => Some(AlertLevel::parse(s)
            .ok_or_else(|| FilterError("level 须为 info/warning/critical".into()))?),
    };
    let parse_ts = |v: Option<String>, name: &str| -> Result<Option<DateTime<Utc>>, FilterError> {
        v.map(|s| DateTime::parse_from_rfc3339(&s)
            .map(|t| t.with_timezone(&Utc))
            .map_err(|_| FilterError(format!("{name} 须为 RFC3339 时间戳"))))
            .transpose()
    };
    Ok(AlertFilter {
        level,
        from: parse_ts(q.from, "from")?,
        to: parse_ts(q.to, "to")?,
        source: q.source.filter(|s| !s.is_empty()),
        limit: q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
    })
}

pub async fn list_alerts(State(st): State<Arc<AppState>>, Query(q): Query<AlertsQuery>) -> Response {
    let filter = match parse_filter(q) {
        Ok(f) => f,
        Err(e) => return err(StatusCode::BAD_REQUEST, &e.0),
    };
    match st.alerts.list(&filter).await {
        Ok(events) => Json(events.iter().map(AlertEventDto::from).collect::<Vec<_>>())
            .into_response(),
        Err(e) => internal(e),
    }
}

/// POST /api/alerts/{id}/ack —— 确认（记录确认时刻，持久化刷新不丢）。
/// 仅 triggered 可确认；已确认/已恢复/未知 id → 404（无可确认对象）。
pub async fn ack_alert(State(st): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    match st.alerts.ack(id).await {
        Ok(Some(ev)) => Json(AlertEventDto::from(&ev)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "告警不存在或不在未确认状态"),
        Err(e) => internal(e),
    }
}

// ── GET/PATCH /api/alert-rules（内置规则仅阈值/开关/静默时长可调，热生效）──

pub async fn list_rules(State(st): State<Arc<AppState>>) -> Response {
    match st.alerts.rules().await {
        Ok(rules) => Json(rules.iter().map(AlertRuleDto::from).collect::<Vec<_>>())
            .into_response(),
        Err(e) => internal(e),
    }
}

/// PATCH 请求体：id 定位规则；三项可调（None = 不改）。
#[derive(Debug, Deserialize)]
pub struct PatchRuleReq {
    pub id: String,
    pub threshold: Option<f64>,
    pub enabled: Option<bool>,
    pub silence_minutes: Option<i64>,
}

pub async fn patch_rule(State(st): State<Arc<AppState>>, Json(req): Json<PatchRuleReq>) -> Response {
    if req.id.trim().is_empty() { return err(StatusCode::BAD_REQUEST, "id 必填"); }
    if let Some(s) = req.silence_minutes {
        if s < 1 { return err(StatusCode::BAD_REQUEST, "silence_minutes 下限 1"); }
    }
    if let Some(t) = req.threshold {
        if !t.is_finite() || t < 0.0 {
            return err(StatusCode::BAD_REQUEST, "threshold 须为非负有限数");
        }
    }
    let patch = AlertRulePatch {
        threshold: req.threshold, enabled: req.enabled, silence_minutes: req.silence_minutes,
    };
    match st.alerts.update_rule(&req.id, &patch).await {
        Ok(Some(r)) => Json(AlertRuleDto::from(&r)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "规则不存在（内置规则预置，不可增删）"),
        Err(e) => internal(e),
    }
}

/// 评估推送循环（与 ws::Poller 同模式；ADR-017：推送源 = 应用面节拍读库，无数据面直连）。
/// 每轮评估后：fired（新建/续触发）与 resolved（恢复）事件逐一发布 {type:"alert"}。
pub struct AlertEvaluator {
    state: Arc<AppState>,
    interval: Duration,
}

impl AlertEvaluator {
    pub fn new(state: Arc<AppState>, interval: Duration) -> Self { Self { state, interval } }

    pub async fn run(self) {
        loop {
            if let Err(e) = self.tick().await {
                tracing::warn!(error = %e, "alert evaluator tick failed");
            }
            tokio::time::sleep(self.interval).await;
        }
    }

    /// 单轮评估 + 推送（测试可直调）。
    pub async fn tick(&self) -> anyhow::Result<()> {
        let outcome = self.state.alerts.evaluate().await?;
        for ev in outcome.fired.iter().chain(outcome.resolved.iter()) {
            self.state.hub.publish(PushMsg::Alert(AlertEventDto::from(ev)));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_filter_validation_and_defaults() {
        let f = parse_filter(AlertsQuery { level: None, from: None, to: None,
            source: None, limit: None }).unwrap();
        assert_eq!(f.limit, 200, "默认 200");
        let f = parse_filter(AlertsQuery { level: Some("warning".into()), from: None, to: None,
            source: Some("tencent_qt".into()), limit: Some(99999) }).unwrap();
        assert_eq!(f.level, Some(AlertLevel::Warning));
        assert_eq!(f.limit, 1000, "封顶 1000");
        assert_eq!(f.source.as_deref(), Some("tencent_qt"));
        assert!(parse_filter(AlertsQuery { level: Some("crit".into()), from: None, to: None,
            source: None, limit: None }).is_err(), "非法级别 400");
        let e = parse_filter(AlertsQuery { level: None, from: Some("x".into()), to: None,
            source: None, limit: None }).unwrap_err();
        assert_eq!(e, super::FilterError("from 须为 RFC3339 时间戳".into()), "小错误类型载错误文案");
    }

    #[test]
    fn dto_serializes_snake_case_enums() {
        let ev = AlertEvent {
            id: 7, rule_id: "collection_stall".into(), level: AlertLevel::Critical,
            source: "collector".into(), message: "停摆".into(), status: AlertStatus::Triggered,
            fire_count: 3, first_fired_at: Utc::now(), last_fired_at: Utc::now(),
            acked_at: None, resolved_at: None,
        };
        let v = serde_json::to_value(AlertEventDto::from(&ev)).unwrap();
        assert_eq!(v["level"], "critical");
        assert_eq!(v["status"], "triggered");
        assert_eq!(v["fire_count"], 3);
        assert!(v["acked_at"].is_null());
    }
}
```

集成测试（需 TimescaleDB :5433 + 0009 迁移；独立 source 段 webalert_test_* 前后清理，可重入）：

``` {.rust file=crates/web/tests/api_alerts.rs}
//! 页面⑦ 告警端点集成测试（需 TimescaleDB :5433，含 0009 迁移）：
//! GET/PATCH /api/alert-rules（404/400）、GET /api/alerts（过滤/校验）、
//! POST /api/alerts/{id}/ack（200 持久化 / 404）、AlertEvaluator 评估 → 事件落库 + WS 推送。
//! 并行隔离（同 binary 实锤踩坑口径）：事件用独立 source 段（webalert_*）；
//! 规则表为全局行——rules 测试只 patch symbol_gap_rate 的 threshold/silence（用后复原种子值），
//! evaluator 测试只切 enabled（只留 source_success_rate），两测试不写同列、不断言对方字段。

use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use web::alerts::AlertEvaluator;
use web::state::AppState;
use web::ws::{PushMsg, SubscriptionRegistry, WsHub};

const SRC: &str = "webalert_test_src";
const EVAL_SRC: &str = "webalert_eval_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构；storage/sqlx 仅 dev-dependencies）。
fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（与 app bin 同口径；本文件不涉及行为，仅装配齐全）
    let backtest_hub = WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎（评估读 + 应用面自有表持久化 + SystemClock）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（quality 端口组；仅装配齐全，行为测试见 api_quality.rs）
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest,
        backtest_ws,
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

/// 每测试独立 clean（同 binary 并行执行，共享清理会互删——实锤踩坑口径：
/// 曾因两测试共用双 source 清理导致 evaluator 造数被并行测试误删）。
async fn clean(pool: &PgPool, sources: &[&str]) {
    for s in sources {
        sqlx::query("DELETE FROM alert_events WHERE source = $1")
            .bind(s).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM source_health_events WHERE source = $1")
            .bind(s).execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn rules_list_patch_and_validation() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // GET /api/alert-rules：0009 种子 4 条内置规则
    let v: Value = http.get(format!("{url}/api/alert-rules")).send().await.unwrap()
        .json().await.unwrap();
    let rules = v.as_array().unwrap();
    assert_eq!(rules.len(), 4);
    // evaluator 测试不动 source_success_rate（并发安全断言该行字段）
    let ssr = rules.iter().find(|r| r["id"] == "source_success_rate").unwrap();
    assert_eq!(ssr["level"], "warning");
    assert_eq!(ssr["threshold"], 0.95);
    assert_eq!(ssr["duration_minutes"], 10);
    assert_eq!(ssr["silence_minutes"], 10);
    assert_eq!(ssr["enabled"], true);

    // PATCH：阈值/静默热生效（评估节拍每轮重读，alert engine 测试锁定）
    let r = http.patch(format!("{url}/api/alert-rules"))
        .json(&serde_json::json!({"id": "symbol_gap_rate", "threshold": 10.0,
                                  "silence_minutes": 45}))
        .send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["threshold"], 10.0);
    assert_eq!(v["silence_minutes"], 45);

    // 校验：未知 id 404；非法静默/阈值/id 400
    let r = http.patch(format!("{url}/api/alert-rules"))
        .json(&serde_json::json!({"id": "no_such_rule", "enabled": false}))
        .send().await.unwrap();
    assert_eq!(r.status(), 404);
    for body in [
        serde_json::json!({"id": "symbol_gap_rate", "silence_minutes": 0}),
        serde_json::json!({"id": "symbol_gap_rate", "threshold": -1.0}),
        serde_json::json!({"id": "  "}),
    ] {
        let r = http.patch(format!("{url}/api/alert-rules")).json(&body).send().await.unwrap();
        assert_eq!(r.status(), 400, "{body} → 400");
    }

    // 自愈复原种子值（0009 口径；不动 enabled——evaluator 测试持有该列）
    http.patch(format!("{url}/api/alert-rules"))
        .json(&serde_json::json!({"id": "symbol_gap_rate", "threshold": 1.0,
                                  "silence_minutes": 30}))
        .send().await.unwrap();
}

#[tokio::test]
async fn alerts_list_filters_and_ack_lifecycle() {
    let pool = pool().await;
    clean(&pool, &[SRC]).await;
    // 造数：一条 triggered 事件（真实生命周期由 alert engine 测试锁定，此处锁 REST 契约）
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO alert_events (rule_id, level, source, message) \
         VALUES ('source_success_rate', 'warning', $1, '测试告警') RETURNING id")
        .bind(SRC).fetch_one(&pool).await.unwrap();
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 列表 + 过滤
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("source", SRC)]).send().await.unwrap().json().await.unwrap();
    let rows = v.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], id);
    assert_eq!(rows[0]["status"], "triggered");
    assert_eq!(rows[0]["fire_count"], 1);
    assert_eq!(rows[0]["level"], "warning");
    assert!(rows[0]["acked_at"].is_null());
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("level", "critical"), ("source", SRC)]).send().await.unwrap()
        .json().await.unwrap();
    assert!(v.as_array().unwrap().is_empty(), "级别过滤");
    // 非法参数 400
    for q in [[("level", "crit")], [("from", "not-a-time")]] {
        let r = http.get(format!("{url}/api/alerts")).query(&q).send().await.unwrap();
        assert_eq!(r.status(), 400, "{q:?} → 400");
    }

    // ack：200 + 状态持久化（刷新重查不丢）
    let r = http.post(format!("{url}/api/alerts/{id}/ack")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "acked");
    assert!(v["acked_at"].is_string(), "确认时刻记录");
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("source", SRC)]).send().await.unwrap().json().await.unwrap();
    assert_eq!(v[0]["status"], "acked", "确认状态持久化（重查不丢）");

    // 重复 ack / 未知 id → 404
    let r = http.post(format!("{url}/api/alerts/{id}/ack")).send().await.unwrap();
    assert_eq!(r.status(), 404, "已确认不可重复确认");
    let r = http.post(format!("{url}/api/alerts/999999/ack")).send().await.unwrap();
    assert_eq!(r.status(), 404);
    clean(&pool, &[SRC]).await;
}

#[tokio::test]
async fn evaluator_fires_incident_and_publishes_ws() {
    let pool = pool().await;
    clean(&pool, &[EVAL_SRC]).await;
    // 只留 source_success_rate 启用（其余规则依赖真实时钟/日历，测试隔离；
    // 只切 enabled 列——rules 测试并发 patch threshold/silence 不冲突）
    sqlx::query("UPDATE alert_rules SET enabled = false WHERE id <> 'source_success_rate'")
        .execute(&pool).await.unwrap();
    // 造数：10min 窗口内 1 成功 3 失败（25% < 95%，样本 ≥3）
    for (i, ok) in [true, false, false, false].into_iter().enumerate() {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind) \
                     VALUES (now() - make_interval(secs => $1), $2, $3, $4)")
            .bind(60 + i as i64).bind(EVAL_SRC).bind(ok)
            .bind(if ok { None } else { Some("timeout") })
            .execute(&pool).await.unwrap();
    }
    let st = state(pool.clone());
    let mut rx = st.hub.subscribe();
    let url = spawn(st.clone()).await;
    let evaluator = AlertEvaluator::new(st, StdDuration::from_secs(60));

    evaluator.tick().await.unwrap();

    // 事件落库（triggered）
    let http = reqwest::Client::new();
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("source", EVAL_SRC)]).send().await.unwrap().json().await.unwrap();
    let rows = v.as_array().unwrap();
    assert_eq!(rows.len(), 1, "评估触发事件落库");
    assert_eq!(rows[0]["rule_id"], "source_success_rate");
    assert_eq!(rows[0]["status"], "triggered");
    assert!(rows[0]["message"].as_str().unwrap().contains("25.0%"));

    // WS 推送帧 {type:"alert", level, ...}
    let mut pushed = None;
    while let Ok(m) = rx.try_recv() {
        if let PushMsg::Alert(dto) = m { pushed = Some(dto); }
    }
    let dto = pushed.expect("fired 事件经 hub 推送");
    assert_eq!(dto.source, EVAL_SRC);
    let frame = serde_json::to_value(PushMsg::Alert(dto)).unwrap();
    assert_eq!(frame["type"], "alert");
    assert_eq!(frame["level"], "warning");
    assert_eq!(frame["source"], EVAL_SRC);

    // 第二轮：静默期内不重复推送
    evaluator.tick().await.unwrap();
    assert!(rx.try_recv().is_err(), "静默期内不重复触发");

    // 自愈复原（全部规则重新启用）
    sqlx::query("UPDATE alert_rules SET enabled = true").execute(&pool).await.unwrap();
    clean(&pool, &[EVAL_SRC]).await;
}
```

## 6. TDD 规格要点（Red-Green 记录）

- alert/rules（纯函数单测，无 DB）：交易时段边界（含 09:30/15:00 含边界、午休、周末）、
  expected_minutes_elapsed 曲线（0/30/120/150/240）、成功率严格小于阈值 + na 出分母 +
  最小样本守卫、缺口率停用标的跳过 + 宽限期 + 0 根 = 100% 缺口、停摆仅交易时段 + na 不算成功、
  tushare 最近失败 48h 窗口 + na/无事件不触发。
- alert/engine（内存端口 + fake clock）：全生命周期（触发→确认→恢复，确认时刻持久化，重复确认
  None）、聚合防刷屏（同一条续触发 count+1）、静默期（续触发抑制 + 恢复后抖动重建抑制）、
  已确认续触发回退未确认、停用规则不评估、阈值调低热生效恢复、列表过滤透传。
- storage alerts（真实库）：规则种子 4 条 + patch COALESCE/404、状态机原语（insert/refire/ack/
  resolve 幂等边界）、开放事件部分唯一索引兜底、last_fired_at 含已恢复、列表过滤/limit、
  评估读窗口与单源最近事件。
- web alerts（单测 + 真实库集成）：parse_filter 校验矩阵与默认/封顶、DTO snake_case 线格式、
  rules GET/PATCH（200/404/400）、alerts 列表过滤 + ack 200/持久化/404、
  AlertEvaluator tick → 落库 + hub 推送帧 {type:"alert"} + 静默期不重复推。

## 7. 验收映射（wave-2.md 页面⑦ 验收标准）

- 「模拟规则触发（临时阈值）→ 告警出现→确认→恢复全生命周期」：
  alert/tests/engine.rs `full_lifecycle_fire_ack_resolve` + `list_filter_and_rule_patch_passthrough`
  （阈值热生效）+ web/tests/api_alerts.rs `alerts_list_filters_and_ack_lifecycle`（确认持久化）。
- 「WS 实时推送」：web/tests/api_alerts.rs `evaluator_fires_incident_and_publishes_ws`。
- 前端三态与交互：web/src/features/alerts 行为测试（vitest）。
