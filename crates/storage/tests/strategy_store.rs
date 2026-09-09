//! 策略 Registry 存储（StrategyStore）集成测试（需 TimescaleDB :5433，迁移 0022 已 apply）。
//! 契约：strategy/strategy_version CRUD + catalog 过滤（at-least 级别语义 + 仅 published +
//! 每策略最新 published 版本）+ **published 不可变 trigger**（BEFORE UPDATE 拦内容变更 /
//! BEFORE DELETE 拦删除，schema §4.3.13 双保险）。
//! 每测试独立 id 前缀（并行隔离）；清理先 archive published 版本再删策略（published 不可删）。

use chrono::Utc;
use domain::ports::{
    NewStrategy, NewStrategyVersion, StrategyStore,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use sqlx::PgPool;
use storage::strategy::PgStrategyStore;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn pid(suffix: &str) -> String {
    format!("t{}{}", std::process::id(), suffix)
}

fn new_strategy(id: &str, name: &str, kind: StrategyKind) -> NewStrategy {
    NewStrategy {
        id: id.into(),
        name: name.into(),
        description: format!("desc-{name}"),
        kind,
        created_by: "test".into(),
    }
}

fn new_version(id: &str, strategy_id: &str, version: i32, code: &str) -> NewStrategyVersion {
    NewStrategyVersion {
        id: id.into(),
        strategy_id: strategy_id.into(),
        version,
        code: code.into(),
        params_schema: serde_json::json!([]),
        sha256: format!("sha-{id}"),
    }
}

/// 清理：published 版本先 archive（trigger 拦删除），再删策略（FK 级联版本）。
async fn clean(pool: &PgPool, strategy_id: &str) {
    sqlx::query("UPDATE strategy_version SET status = 'archived' WHERE strategy_id = $1")
        .bind(strategy_id).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE id = $1")
        .bind(strategy_id).execute(pool).await.unwrap();
}

#[tokio::test]
async fn create_get_roundtrip_and_next_version() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("a_st");
    clean(&pool, &sid).await;

    let s = store.create_strategy(&new_strategy(&sid, "rt-策略", StrategyKind::Strategy)).await.unwrap();
    assert_eq!(s.id, sid);
    assert_eq!(s.kind, StrategyKind::Strategy);
    assert_eq!(s.created_by, "test");

    let got = store.get_strategy(&sid).await.unwrap().expect("应读回");
    assert_eq!(got.name, "rt-策略");
    assert!(store.get_strategy(&pid("none")).await.unwrap().is_none());
    assert_eq!(store.next_version_number(&sid).await.unwrap(), 1, "无版本 → 1");

    let v1 = store.create_version(&new_version(&pid("a_v1"), &sid, 1, "code-v1")).await.unwrap();
    assert_eq!(v1.status, StrategyStatus::Draft);
    assert_eq!(v1.approval_level, ApprovalLevel::BacktestOk);
    assert!(v1.published_at.is_none());
    assert_eq!(store.next_version_number(&sid).await.unwrap(), 2);

    let versions = store.list_versions(&sid).await.unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].code, "code-v1");

    clean(&pool, &sid).await;
}

#[tokio::test]
async fn unique_strategy_version_enforced() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("b_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "uniq", StrategyKind::Strategy)).await.unwrap();
    store.create_version(&new_version(&pid("b_v1"), &sid, 1, "c1")).await.unwrap();
    let dup = store.create_version(&new_version(&pid("b_v2"), &sid, 1, "c2")).await;
    assert!(dup.is_err(), "UNIQUE(strategy_id, version) 应拒绝重复版本号");
    clean(&pool, &sid).await;
}

#[tokio::test]
async fn update_draft_only_draft() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("c_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "upd", StrategyKind::Strategy)).await.unwrap();
    let vid = pid("c_v1");
    store.create_version(&new_version(&vid, &sid, 1, "old")).await.unwrap();

    // draft → 原地更新成功
    let updated = store
        .update_draft(&vid, "new-code", &serde_json::json!([{"k":1}]), "sha-new")
        .await.unwrap().expect("draft 应可更新");
    assert_eq!(updated.code, "new-code");
    assert_eq!(updated.sha256, "sha-new");
    assert_eq!(updated.params_schema, serde_json::json!([{"k":1}]));

    // publish 后 → update_draft 不再生效（None）
    let published = store
        .mark_published(&vid, "new-code", "sha-new", &serde_json::json!([{"k":1}]), Utc::now())
        .await.unwrap().expect("mark_published 应命中");
    assert_eq!(published.status, StrategyStatus::Published);
    assert!(published.published_at.is_some());
    let blocked = store.update_draft(&vid, "x", &serde_json::json!([]), "sha-x").await.unwrap();
    assert!(blocked.is_none(), "published 不可 update_draft");

    // archive 流转
    let archived = store.set_status(&vid, StrategyStatus::Archived).await.unwrap().unwrap();
    assert_eq!(archived.status, StrategyStatus::Archived);
    assert!(store.set_status(&pid("none"), StrategyStatus::Archived).await.unwrap().is_none());

    clean(&pool, &sid).await;
}

#[tokio::test]
async fn published_immutable_update_trigger() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("d_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "trig", StrategyKind::Strategy)).await.unwrap();
    let vid = pid("d_v1");
    store.create_version(&new_version(&vid, &sid, 1, "pub-code")).await.unwrap();
    store.mark_published(&vid, "pub-code", "sha-p", &serde_json::json!([]), Utc::now()).await.unwrap();

    // 直改库（绕过应用层）：code 变更 → trigger RAISE EXCEPTION
    for (sql, what) in [
        ("UPDATE strategy_version SET code = 'hacked' WHERE id = $1", "code"),
        ("UPDATE strategy_version SET sha256 = 'hacked' WHERE id = $1", "sha256"),
        ("UPDATE strategy_version SET params_schema = '[9]'::jsonb WHERE id = $1", "params_schema"),
        ("UPDATE strategy_version SET version = 99 WHERE id = $1", "version"),
    ] {
        let r = sqlx::query(sql).bind(&vid).execute(&pool).await;
        assert!(r.is_err(), "published {what} 变更应被 trigger 拦截");
    }
    // status 字段变更（archive）放行
    sqlx::query("UPDATE strategy_version SET status = 'archived' WHERE id = $1")
        .bind(&vid).execute(&pool).await.expect("archive 应放行");

    clean(&pool, &sid).await;
}

#[tokio::test]
async fn published_delete_trigger_blocks_delete_and_cascade() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("e_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "del", StrategyKind::Strategy)).await.unwrap();
    let vid = pid("e_v1");
    store.create_version(&new_version(&vid, &sid, 1, "pub")).await.unwrap();
    store.mark_published(&vid, "pub", "sha-p", &serde_json::json!([]), Utc::now()).await.unwrap();

    // 直接 DELETE published 版本 → trigger 拦
    let r = sqlx::query("DELETE FROM strategy_version WHERE id = $1").bind(&vid).execute(&pool).await;
    assert!(r.is_err(), "published 版本不可删");
    // 删 strategy（FK 级联删 published 版本）→ 同样被拦
    let r = sqlx::query("DELETE FROM strategy WHERE id = $1").bind(&sid).execute(&pool).await;
    assert!(r.is_err(), "含 published 版本的策略不可删（级联被 trigger 拦）");

    // archive 后可删
    store.set_status(&vid, StrategyStatus::Archived).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE id = $1").bind(&sid).execute(&pool).await
        .expect("archive 后级联删除应成功");
    assert!(store.get_strategy(&sid).await.unwrap().is_none());
}

#[tokio::test]
async fn catalog_filters_level_kind_and_latest_published() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let s1 = pid("f_s1"); // 策略：v1 published + v2 draft → catalog 取 v1
    let s2 = pid("f_s2"); // 模板：published（approval 直升 sim_ok 模拟）
    let s3 = pid("f_s3"); // 仅 draft → 不入册
    for sid in [&s1, &s2, &s3] { clean(&pool, sid).await; }

    store.create_strategy(&new_strategy(&s1, "cat-s1", StrategyKind::Strategy)).await.unwrap();
    store.create_version(&new_version(&pid("f_v1"), &s1, 1, "s1v1")).await.unwrap();
    store.mark_published(&pid("f_v1"), "s1v1", "sha1", &serde_json::json!([]), Utc::now()).await.unwrap();
    store.create_version(&new_version(&pid("f_v2"), &s1, 2, "s1v2-draft")).await.unwrap();

    store.create_strategy(&new_strategy(&s2, "cat-t2", StrategyKind::Template)).await.unwrap();
    store.create_version(&new_version(&pid("f_v3"), &s2, 1, "t2v1")).await.unwrap();
    store.mark_published(&pid("f_v3"), "t2v1", "sha3", &serde_json::json!([]), Utc::now()).await.unwrap();
    sqlx::query("UPDATE strategy_version SET approval_level = 'sim_ok' WHERE id = $1")
        .bind(pid("f_v3")).execute(&pool).await.unwrap();

    store.create_strategy(&new_strategy(&s3, "cat-s3", StrategyKind::Strategy)).await.unwrap();
    store.create_version(&new_version(&pid("f_v4"), &s3, 1, "s3v1-draft")).await.unwrap();

    // 无过滤：s1(最新 published=v1) + s2 入册；s3（仅 draft）不入册
    let all = store.catalog(None, None).await.unwrap();
    let mine: Vec<_> = all.iter().filter(|e| e.strategy.name.starts_with("cat-")).collect();
    assert_eq!(mine.len(), 2);
    let e1 = mine.iter().find(|e| e.strategy.id == s1).unwrap();
    assert_eq!(e1.version.version, 1, "catalog 取最新 published（v1），draft v2 不出现");
    // kind 过滤
    let templates = store.catalog(None, Some(StrategyKind::Template)).await.unwrap();
    assert!(templates.iter().any(|e| e.strategy.id == s2));
    assert!(!templates.iter().any(|e| e.strategy.id == s1));
    // level at-least：sim_ok 要求 → s2(sim_ok) 在、s1(backtest_ok) 不在
    let sim_up = store.catalog(Some(ApprovalLevel::SimOk), None).await.unwrap();
    assert!(sim_up.iter().any(|e| e.strategy.id == s2));
    assert!(!sim_up.iter().any(|e| e.strategy.id == s1));
    // backtest_ok 要求（=无过滤全集语义）→ 两者都在
    let bt_up = store.catalog(Some(ApprovalLevel::BacktestOk), None).await.unwrap();
    assert!(bt_up.iter().any(|e| e.strategy.id == s1));
    assert!(bt_up.iter().any(|e| e.strategy.id == s2));
    // live_approved 要求 → 都不在
    let live = store.catalog(Some(ApprovalLevel::LiveApproved), None).await.unwrap();
    assert!(!live.iter().any(|e| e.strategy.id == s1 || e.strategy.id == s2));

    for sid in [&s1, &s2, &s3] { clean(&pool, sid).await; }
}

// MAJOR-2：mark_published 乐观条件——仅当行仍为 draft 且 code=expected_code 才定格。
#[tokio::test]
async fn mark_published_requires_draft_and_expected_code() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("h_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "toctou", StrategyKind::Strategy)).await.unwrap();
    let vid = pid("h_v1");
    store.create_version(&new_version(&vid, &sid, 1, "smoked-code")).await.unwrap();

    // expected_code 不匹配（并发改写后的行 code ≠ 冒烟过的原文）→ 0 行 → None，行保持 draft
    let r = store
        .mark_published(&vid, "stale-code", "sha-x", &serde_json::json!([]), Utc::now())
        .await.unwrap();
    assert!(r.is_none(), "code 不匹配应 0 行命中");
    let v = store.get_version(&vid).await.unwrap().unwrap();
    assert_eq!(v.status, StrategyStatus::Draft, "冲突后版本保持 draft");
    assert_eq!(v.code, "smoked-code");

    // expected_code 匹配 → 命中
    let r = store
        .mark_published(&vid, "smoked-code", "sha-ok", &serde_json::json!([]), Utc::now())
        .await.unwrap().expect("code 匹配应命中");
    assert_eq!(r.status, StrategyStatus::Published);

    // 已 published（status 漂移）→ 再 mark_published → None（WHERE status='draft'）
    let r = store
        .mark_published(&vid, "smoked-code", "sha-y", &serde_json::json!([]), Utc::now())
        .await.unwrap();
    assert!(r.is_none(), "非 draft 行不应再命中");

    clean(&pool, &sid).await;
}

// MINOR-1：trigger 状态机补强——published 仅可 → archived；archived 终态禁止 status 变更；
// NIT-3 并案：published 行 strategy_id/published_at 改写被拒。
#[tokio::test]
async fn trigger_status_machine_and_published_frozen_fields() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("i_st");
    let sid2 = pid("i_st2");
    for s in [&sid, &sid2] { clean(&pool, s).await; }
    store.create_strategy(&new_strategy(&sid, "sm", StrategyKind::Strategy)).await.unwrap();
    store.create_strategy(&new_strategy(&sid2, "sm2", StrategyKind::Strategy)).await.unwrap();
    let vid = pid("i_v1");
    store.create_version(&new_version(&vid, &sid, 1, "sm-code")).await.unwrap();
    store.mark_published(&vid, "sm-code", "sha-sm", &serde_json::json!([]), Utc::now()).await.unwrap();

    // published → draft：拒
    let r = sqlx::query("UPDATE strategy_version SET status = 'draft' WHERE id = $1")
        .bind(&vid).execute(&pool).await;
    assert!(r.is_err(), "published→draft 应被 trigger 拦截");
    // NIT-3：published 行 strategy_id / published_at 改写：拒
    let r = sqlx::query("UPDATE strategy_version SET strategy_id = $2 WHERE id = $1")
        .bind(&vid).bind(&sid2).execute(&pool).await;
    assert!(r.is_err(), "published strategy_id 改写应被 trigger 拦截");
    let r = sqlx::query("UPDATE strategy_version SET published_at = now() WHERE id = $1")
        .bind(&vid).execute(&pool).await;
    assert!(r.is_err(), "published published_at 改写应被 trigger 拦截");
    // published → archived：放行
    sqlx::query("UPDATE strategy_version SET status = 'archived' WHERE id = $1")
        .bind(&vid).execute(&pool).await.expect("published→archived 应放行");
    // archived → draft / published：拒（终态）
    for to in ["draft", "published"] {
        let r = sqlx::query("UPDATE strategy_version SET status = $2 WHERE id = $1")
            .bind(&vid).bind(to).execute(&pool).await;
        assert!(r.is_err(), "archived→{to} 应被 trigger 拦截（终态）");
    }
    // archived 行 status 同值 UPDATE（no-op）不误伤
    sqlx::query("UPDATE strategy_version SET status = 'archived' WHERE id = $1")
        .bind(&vid).execute(&pool).await.expect("archived→archived no-op 应放行");

    for s in [&sid, &sid2] { clean(&pool, s).await; }
}

// MINOR-3 存储形态：v1 published(sim_ok) → v2 published(backtest_ok)；
// 查 level=sim_ok 应返回 v1 条目（先按 level 集合过滤版本行、再取每策略最新 published）。
#[tokio::test]
async fn catalog_filters_level_set_before_latest_published() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("j_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "lvl-form", StrategyKind::Strategy)).await.unwrap();
    store.create_version(&new_version(&pid("j_v1"), &sid, 1, "j-c1")).await.unwrap();
    store.mark_published(&pid("j_v1"), "j-c1", "sha-j1", &serde_json::json!([]), Utc::now()).await.unwrap();
    sqlx::query("UPDATE strategy_version SET approval_level = 'sim_ok' WHERE id = $1")
        .bind(pid("j_v1")).execute(&pool).await.unwrap();
    store.create_version(&new_version(&pid("j_v2"), &sid, 2, "j-c2")).await.unwrap();
    store.mark_published(&pid("j_v2"), "j-c2", "sha-j2", &serde_json::json!([]), Utc::now()).await.unwrap();

    // level=sim_ok：v2(backtest_ok) 不在集合 → 返回 v1 条目
    let sim = store.catalog(Some(ApprovalLevel::SimOk), None).await.unwrap();
    let e = sim.iter().find(|e| e.strategy.id == sid).expect("v1 应入册");
    assert_eq!(e.version.version, 1);
    assert_eq!(e.version.approval_level, ApprovalLevel::SimOk);
    // 无过滤：最新 published = v2
    let all = store.catalog(None, None).await.unwrap();
    let e = all.iter().find(|e| e.strategy.id == sid).expect("应入册");
    assert_eq!(e.version.version, 2);

    clean(&pool, &sid).await;
}

// NIT-1：update_draft 推进 strategy.updated_at（与 create_version 对齐）。
#[tokio::test]
async fn update_draft_advances_strategy_updated_at() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("k_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "upd-ts", StrategyKind::Strategy)).await.unwrap();
    let vid = pid("k_v1");
    store.create_version(&new_version(&vid, &sid, 1, "k-code")).await.unwrap();
    let before = store.get_strategy(&sid).await.unwrap().unwrap().updated_at;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    store.update_draft(&vid, "k-code2", &serde_json::json!([]), "sha-k2").await.unwrap()
        .expect("draft 应可更新");
    let after = store.get_strategy(&sid).await.unwrap().unwrap().updated_at;
    assert!(after > before, "update_draft 应推进 updated_at（{before} → {after}）");
    clean(&pool, &sid).await;
}

// P2b：manage_list 管理列表——全部策略（含仅 draft / 零版本）+ 聚合 version_count /
// latest_version（版本号最大，任意状态）/ latest_published（最新 published，无 → None）。
#[tokio::test]
async fn manage_list_includes_draft_only_and_aggregates() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let s1 = pid("m_s1"); // v1 published + v2 draft → latest_version=v2，latest_published=v1
    let s2 = pid("m_s2"); // 仅 draft → latest_published None
    let s3 = pid("m_s3"); // 零版本（template）→ latest_version None、version_count 0
    for sid in [&s1, &s2, &s3] { clean(&pool, sid).await; }

    store.create_strategy(&new_strategy(&s1, "mg-s1", StrategyKind::Strategy)).await.unwrap();
    store.create_version(&new_version(&pid("m_v1"), &s1, 1, "m1v1")).await.unwrap();
    store.mark_published(&pid("m_v1"), "m1v1", "sha-m1", &serde_json::json!([]), Utc::now()).await.unwrap();
    store.create_version(&new_version(&pid("m_v2"), &s1, 2, "m1v2-draft")).await.unwrap();

    store.create_strategy(&new_strategy(&s2, "mg-s2", StrategyKind::Strategy)).await.unwrap();
    store.create_version(&new_version(&pid("m_v3"), &s2, 1, "m2v1-draft")).await.unwrap();

    store.create_strategy(&new_strategy(&s3, "mg-s3", StrategyKind::Template)).await.unwrap();

    let all = store.manage_list(None).await.unwrap();
    let e1 = all.iter().find(|e| e.id == s1).expect("s1 应在列");
    assert_eq!(e1.version_count, 2);
    let lv = e1.latest_version.as_ref().expect("latest_version = v2（版本号最大，任意状态）");
    assert_eq!(lv.version, 2);
    assert_eq!(lv.status, StrategyStatus::Draft);
    assert_eq!(lv.sha256, format!("sha-{}", pid("m_v2")));
    assert_eq!(lv.approval_level, ApprovalLevel::BacktestOk);
    assert!(lv.published_at.is_none());
    let lp = e1.latest_published.as_ref().expect("latest_published = v1");
    assert_eq!(lp.version, 1);
    assert_eq!(lp.approval_level, ApprovalLevel::BacktestOk);
    assert_eq!(lp.id, pid("m_v1"));

    let e2 = all.iter().find(|e| e.id == s2).expect("仅 draft 策略也应在列");
    assert_eq!(e2.version_count, 1);
    assert_eq!(e2.latest_version.as_ref().unwrap().status, StrategyStatus::Draft);
    assert!(e2.latest_published.is_none(), "无 published → latest_published None");

    let e3 = all.iter().find(|e| e.id == s3).expect("零版本策略也应在列");
    assert_eq!(e3.version_count, 0);
    assert!(e3.latest_version.is_none(), "零版本 → latest_version None");
    assert!(e3.latest_published.is_none());

    // kind 精确匹配过滤
    let templates = store.manage_list(Some(StrategyKind::Template)).await.unwrap();
    assert!(templates.iter().any(|e| e.id == s3));
    assert!(!templates.iter().any(|e| e.id == s1 || e.id == s2));
    let strategies = store.manage_list(Some(StrategyKind::Strategy)).await.unwrap();
    assert!(strategies.iter().any(|e| e.id == s1 || e.id == s2));
    assert!(!strategies.iter().any(|e| e.id == s3));

    for sid in [&s1, &s2, &s3] { clean(&pool, sid).await; }
}

// P2b：update_meta——name/description 最终值落库 + updated_at 推进；未知 id → None。
#[tokio::test]
async fn update_meta_updates_fields_and_advances_updated_at() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("n_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "meta-old", StrategyKind::Strategy)).await.unwrap();
    let before = store.get_strategy(&sid).await.unwrap().unwrap().updated_at;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let row = store.update_meta(&sid, "meta-new", "desc-new").await.unwrap()
        .expect("命中应返回更新后行");
    assert_eq!(row.name, "meta-new");
    assert_eq!(row.description, "desc-new");
    assert!(row.updated_at > before, "update_meta 应推进 updated_at（{before} → {}）", row.updated_at);
    // 非目标字段不变
    assert_eq!(row.kind, StrategyKind::Strategy);
    assert_eq!(row.created_by, "test");
    // 读回一致
    let got = store.get_strategy(&sid).await.unwrap().unwrap();
    assert_eq!(got.name, "meta-new");

    assert!(store.update_meta(&pid("none"), "x", "y").await.unwrap().is_none(), "未知 id → None");
    clean(&pool, &sid).await;
}

#[tokio::test]
async fn find_version_by_name_sha_for_seed_idempotency() {
    let pool = pool().await;
    let store = PgStrategyStore::new(pool.clone());
    let sid = pid("g_st");
    clean(&pool, &sid).await;
    store.create_strategy(&new_strategy(&sid, "seed-name", StrategyKind::Strategy)).await.unwrap();
    store.create_version(&new_version(&pid("g_v1"), &sid, 1, "c")).await.unwrap();
    sqlx::query("UPDATE strategy_version SET sha256 = 'sha-seed' WHERE id = $1")
        .bind(pid("g_v1")).execute(&pool).await.unwrap();

    assert!(store.find_version_by_name_sha("seed-name", "sha-seed").await.unwrap().is_some());
    assert!(store.find_version_by_name_sha("seed-name", "other").await.unwrap().is_none());
    assert!(store.find_version_by_name_sha("other", "sha-seed").await.unwrap().is_none());
    assert!(store.count_strategies().await.unwrap() >= 1);

    clean(&pool, &sid).await;
}
