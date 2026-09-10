// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/storage/tests/alert_store.rs>>[init]
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

    // source 过滤下推 SQL WHERE（LIMIT 之前）：共享 dev 库有实时 app 持续写真实告警事件，
    // 裸 limit:200 先截断再内存过滤会把固定 t0 的测试事件挤出窗口（全量连跑 flake 实锤）；
    // 按本测试唯一 source 标记分别查询再合并排序，窗口/排序语义不削弱。
    let mut mine = store.list_events(&AlertFilter { source: Some(A.into()), limit: 200,
        ..Default::default() }).await.unwrap();
    mine.extend(store.list_events(&AlertFilter { source: Some(B.into()), limit: 200,
        ..Default::default() }).await.unwrap());
    mine.sort_by_key(|e| std::cmp::Reverse(e.last_fired_at));
    assert_eq!(mine.len(), 3);
    assert_eq!(mine[0].source, B, "last_fired_at 降序");

    let warn = store.list_events(&AlertFilter { level: Some(AlertLevel::Warning), limit: 200,
        ..Default::default() }).await.unwrap();
    assert!(warn.iter().all(|e| e.level == AlertLevel::Warning));

    let by_src = store.list_events(&AlertFilter { source: Some(A.into()), limit: 200,
        ..Default::default() }).await.unwrap();
    assert_eq!(by_src.len(), 2);

    // 窗口查询叠加本测试唯一 source 标记：共享 dev 库中运行中的 app 会写入真实事件
    // （可能恰落入 t0 固定窗口），不带 source 过滤的裸窗口断言会被外部行污染（TD-2 实锤）。
    // 窗口语义不削弱：source=A 的两行 m1@t0 / m2@t0+5m 中仅 m2 落入 4m..6m。
    let ranged = store.list_events(&AlertFilter {
        source: Some(A.into()),
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
// ~/~ end
