//! 回测工作台存储（StrategyRunStore + StrategyPresetStore）集成测试（需 TimescaleDB :5433，迁移 0023 已 apply）。
//! ⚠️ **非 tangle 手写**（与 strategy_store.rs 同模式）。
//! 契约：strategy_run 任务制状态机（queued→running→succeeded/failed/canceled 条件更新）+
//! 结果五 jsonb 列（FK 级联）+ 列表分页/状态过滤 + strategy_preset CRUD（name UNIQUE → 409 语义）。
//! 每测试独立 id/name 前缀（并行隔离）。

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    NewStrategyPreset, NewStrategyRun, StrategyPresetStore, StrategyRunFilter, StrategyRunResult,
    StrategyRunStatus, StrategyRunStore,
};
use sqlx::PgPool;
use storage::workbench::{PgStrategyPresetStore, PgStrategyRunStore};

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn pid(suffix: &str) -> String {
    format!("t{}{}", std::process::id(), suffix)
}

fn ts(day: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 1, 1, 30, 0).unwrap() + Duration::days(day)
}

fn new_run(id: &str, symbol: &str) -> NewStrategyRun {
    NewStrategyRun {
        id: id.into(),
        name: format!("run-{id}"),
        symbol: symbol.into(),
        period: "D1".into(),
        from_ts: ts(0),
        to_ts: ts(30),
        config: serde_json::json!({
            "slots": [{"strategy_id": "st_x", "version_id": "sv_x", "version": 1,
                       "sha256": "abc", "params": {"score": 80}, "weight": 1.0}],
            "buy_threshold": 60.0, "sell_threshold": 40.0,
            "policy": {"LumpSum": {"position_pct": 1.0}},
            "stop": null,
            "initial_capital": 100000.0,
            "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
        }),
    }
}

fn sample_result() -> StrategyRunResult {
    StrategyRunResult {
        per_bar: serde_json::json!([{"ts": 1, "scores": [], "aggregate": 50.0,
                                     "signal": "Hold", "orders": [], "events": []}]),
        trades: serde_json::json!([]),
        net_value: serde_json::json!([[1, 100000.0]]),
        drawdown: serde_json::json!([[1, 0.0]]),
        metrics: serde_json::json!({"total_return_pct": 0.0}),
    }
}

async fn clean_run(pool: &PgPool, id: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE id = $1")
        .bind(id).execute(pool).await.unwrap();
}

async fn clean_preset(pool: &PgPool, id: &str) {
    sqlx::query("DELETE FROM strategy_preset WHERE id = $1")
        .bind(id).execute(pool).await.unwrap();
}

#[tokio::test]
async fn run_create_get_roundtrip() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_run_rt");
    clean_run(&pool, &id).await;

    let created = store.create_run(&new_run(&id, "600000")).await.unwrap();
    assert_eq!(created.id, id);
    assert_eq!(created.status, StrategyRunStatus::Queued, "新建应为 queued");
    assert_eq!(created.progress, 0.0);
    assert!(created.error.is_none() && created.started_at.is_none() && created.finished_at.is_none());
    assert_eq!(created.config["slots"][0]["sha256"], "abc", "config 快照原样落库");

    let got = store.get_run(&id).await.unwrap().expect("应存在");
    assert_eq!(got, created, "get_run 应与 create 返回一致");
    assert!(store.get_run(&pid("_run_none")).await.unwrap().is_none(), "未知 id → None");
    clean_run(&pool, &id).await;
}

#[tokio::test]
async fn run_list_order_filter_pagination() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let ids: Vec<String> = (0..3).map(|i| pid(&format!("_list_{i}"))).collect();
    for id in &ids {
        clean_run(&pool, id).await;
        // created_at 相同毫秒内靠 id DESC 定序；人为拉开 created_at 保证确定性。
        let mut r = new_run(id, "600000");
        store.create_run(&r).await.unwrap();
        r.id = r.id.clone();
    }
    // 人为设定 created_at 递增（list 排序 created_at DESC → 后建在前）。
    for (i, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE strategy_run SET created_at = $2 WHERE id = $1")
            .bind(id).bind(ts(100 + i as i64)).execute(&pool).await.unwrap();
    }

    let all = store.list_runs(&StrategyRunFilter { status: None, limit: 500, offset: 0 })
        .await.unwrap();
    let mine: Vec<_> = all.iter().filter(|r| ids.contains(&r.id)).collect();
    assert_eq!(mine.len(), 3);
    assert_eq!(mine[0].id, ids[2], "created_at DESC：最新在前");

    let page = store.list_runs(&StrategyRunFilter { status: None, limit: 1, offset: 1 })
        .await.unwrap();
    assert_eq!(page.len(), 1);

    // 状态过滤：把一个置 failed，filter=failed 只命中它。
    store.mark_failed(&ids[0], "boom", ts(200)).await.unwrap();
    let failed = store.list_runs(&StrategyRunFilter {
        status: Some(StrategyRunStatus::Failed), limit: 500, offset: 0,
    }).await.unwrap();
    assert!(failed.iter().any(|r| r.id == ids[0]));
    assert!(!failed.iter().any(|r| r.id == ids[1]), "queued 不应出现在 failed 过滤中");
    for id in &ids {
        clean_run(&pool, id).await;
    }
}

#[tokio::test]
async fn mark_started_atomic_claim() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_claim");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();

    assert!(store.mark_started(&id, ts(1)).await.unwrap(), "queued→running 首次认领成功");
    let got = store.get_run(&id).await.unwrap().unwrap();
    assert_eq!(got.status, StrategyRunStatus::Running);
    assert_eq!(got.started_at, Some(ts(1)));
    assert!(!store.mark_started(&id, ts(2)).await.unwrap(), "二次认领（并发）应失败");
    clean_run(&pool, &id).await;
}

#[tokio::test]
async fn update_progress_only_running() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_prog");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();

    // queued 行静默忽略
    store.update_progress(&id, 0.5).await.unwrap();
    assert_eq!(store.get_run(&id).await.unwrap().unwrap().progress, 0.0, "queued 不应更新进度");

    store.mark_started(&id, ts(1)).await.unwrap();
    store.update_progress(&id, 0.42).await.unwrap();
    let got = store.get_run(&id).await.unwrap().unwrap();
    assert!((got.progress - 0.42).abs() < 1e-12, "running 应更新进度");

    store.mark_failed(&id, "x", ts(2)).await.unwrap();
    store.update_progress(&id, 0.99).await.unwrap();
    assert!((store.get_run(&id).await.unwrap().unwrap().progress - 0.42).abs() < 1e-12,
        "终态行进度不再变化");
    clean_run(&pool, &id).await;
}

#[tokio::test]
async fn mark_succeeded_writes_result_transactionally() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_succ");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();

    // 非 running（queued）→ false，不落结果
    assert!(!store.mark_succeeded(&id, &sample_result(), ts(2)).await.unwrap(),
        "queued 不可直接 succeeded");
    assert!(store.get_result(&id).await.unwrap().is_none());

    store.mark_started(&id, ts(1)).await.unwrap();
    assert!(store.mark_succeeded(&id, &sample_result(), ts(2)).await.unwrap());
    let got = store.get_run(&id).await.unwrap().unwrap();
    assert_eq!(got.status, StrategyRunStatus::Succeeded);
    assert_eq!(got.progress, 1.0, "成功进度应钉 1");
    assert_eq!(got.finished_at, Some(ts(2)));

    let res = store.get_result(&id).await.unwrap().expect("结果应存在");
    assert_eq!(res, sample_result(), "五 jsonb 列 roundtrip");
    // 幂等防护：已 succeeded → 再 mark_succeeded 为 false
    assert!(!store.mark_succeeded(&id, &sample_result(), ts(3)).await.unwrap());
    clean_run(&pool, &id).await;
}

#[tokio::test]
async fn mark_failed_terminal_guards() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_fail");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();

    assert!(store.mark_failed(&id, "区间无数据", ts(1)).await.unwrap(), "queued→failed 合法");
    let got = store.get_run(&id).await.unwrap().unwrap();
    assert_eq!(got.status, StrategyRunStatus::Failed);
    assert_eq!(got.error.as_deref(), Some("区间无数据"));
    assert!(!store.mark_failed(&id, "again", ts(2)).await.unwrap(), "终态不可再迁移");
    assert!(!store.mark_canceled(&id, ts(3)).await.unwrap().unwrap(), "failed 不可取消 → Some(false)");
    clean_run(&pool, &id).await;
}

#[tokio::test]
async fn mark_canceled_semantics() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_cancel");
    clean_run(&pool, &id).await;

    assert!(store.mark_canceled(&pid("_cancel_none"), ts(1)).await.unwrap().is_none(),
        "未知 id → None（404）");

    store.create_run(&new_run(&id, "600000")).await.unwrap();
    assert_eq!(store.mark_canceled(&id, ts(1)).await.unwrap(), Some(true), "queued 可取消");
    let got = store.get_run(&id).await.unwrap().unwrap();
    assert_eq!(got.status, StrategyRunStatus::Canceled);
    assert_eq!(got.finished_at, Some(ts(1)));
    // 已取消 → 二次取消 Some(false)；mark_started 认领失败（取消后不会被跑起来）
    assert_eq!(store.mark_canceled(&id, ts(2)).await.unwrap(), Some(false));
    assert!(!store.mark_started(&id, ts(2)).await.unwrap(), "canceled 不可认领");
    clean_run(&pool, &id).await;
}

#[tokio::test]
async fn result_cascade_delete_with_run() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_cascade");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();
    store.mark_started(&id, ts(1)).await.unwrap();
    store.mark_succeeded(&id, &sample_result(), ts(2)).await.unwrap();
    assert!(store.get_result(&id).await.unwrap().is_some());
    clean_run(&pool, &id).await; // DELETE run → result 级联
    assert!(store.get_result(&id).await.unwrap().is_none(), "FK 级联删除结果");
}

// ── strategy_preset ──

#[tokio::test]
async fn preset_crud_and_unique_name() {
    let pool = pool().await;
    let store = PgStrategyPresetStore::new(pool.clone());
    let id = pid("_preset");
    let name = pid("组合A");
    clean_preset(&pool, &id).await;
    sqlx::query("DELETE FROM strategy_preset WHERE name = $1")
        .bind(&name).execute(&pool).await.unwrap();

    let cfg = serde_json::json!({"slots": [], "buy_threshold": 60.0});
    let created = store.create_preset(&NewStrategyPreset {
        id: id.clone(), name: name.clone(), config: cfg.clone(),
    }).await.unwrap();
    assert_eq!(created.name, name);
    assert_eq!(created.config, cfg);
    assert_eq!(created.created_at, created.updated_at);

    // name UNIQUE 冲突 → Err（上层映射 409）
    let dup = store.create_preset(&NewStrategyPreset {
        id: pid("_preset_dup"), name: name.clone(), config: cfg.clone(),
    }).await;
    assert!(dup.is_err(), "name 冲突应报错");

    // get / list
    assert_eq!(store.get_preset(&id).await.unwrap().unwrap().name, name);
    assert!(store.get_preset(&pid("_preset_none")).await.unwrap().is_none());
    // find_preset_by_name（create/update 重名预检查端口）
    assert_eq!(store.find_preset_by_name(&name).await.unwrap().unwrap().id, id);
    assert!(store.find_preset_by_name(&pid("无名")).await.unwrap().is_none());
    let listed = store.list_presets().await.unwrap();
    assert!(listed.iter().any(|p| p.id == id));
    // 列表排序：created_at ASC, id ASC（不依赖其他测试数据，仅校验相邻非降）
    let mut sorted = listed.clone();
    sorted.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    assert_eq!(listed.iter().map(|p| &p.id).collect::<Vec<_>>(),
               sorted.iter().map(|p| &p.id).collect::<Vec<_>>(), "list 应按 created_at ASC, id ASC");

    // update：命中推进 updated_at + 返回更新后行；未知 id → None
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let cfg2 = serde_json::json!({"slots": [], "buy_threshold": 65.0});
    let updated = store.update_preset(&id, &format!("{name}改"), &cfg2).await.unwrap().expect("命中");
    assert_eq!(updated.config, cfg2);
    assert!(updated.updated_at > created.updated_at, "updated_at 应推进");
    assert!(store.update_preset(&pid("_preset_none"), "x", &cfg2).await.unwrap().is_none());

    // update name 冲突 → Err（409）
    let id2 = pid("_preset2");
    let name2 = pid("组合B");
    clean_preset(&pool, &id2).await;
    sqlx::query("DELETE FROM strategy_preset WHERE name = $1")
        .bind(&name2).execute(&pool).await.unwrap();
    store.create_preset(&NewStrategyPreset { id: id2.clone(), name: name2, config: cfg.clone() })
        .await.unwrap();
    assert!(store.update_preset(&id2, &format!("{name}改"), &cfg).await.is_err(),
        "update 撞唯一名应报错");

    // delete
    assert!(store.delete_preset(&id).await.unwrap());
    assert!(!store.delete_preset(&id).await.unwrap(), "二次删除 false");
    clean_preset(&pool, &id2).await;
}
