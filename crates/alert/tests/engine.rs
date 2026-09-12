// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/alert/tests/engine.rs>>[init]
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
    SymbolLatestView { code: code.into(), name: None, type_: None, interval_secs: 60,
        settlement: "T1".into(), enabled, last_ts: None, last_close: None, prev_close: None }
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
// ~/~ end
