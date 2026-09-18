//! 回测工作台存储（StrategyRunStore + StrategyPresetStore）集成测试（需 TimescaleDB :5433，迁移 0023 已 apply）。
//! ⚠️ **非 tangle 手写**（与 strategy_store.rs 同模式）。
//! 契约：strategy_run 任务制状态机（queued→running→succeeded/failed/canceled 条件更新）+
//! 结果五 jsonb 列（FK 级联）+ 列表分页/状态过滤 + strategy_preset CRUD（name UNIQUE → 409 语义）。
//! 每测试独立 id/name 前缀（并行隔离）。

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    NewStrategyPreset, NewStrategyRun, ResultChunk, ResultKind, StrategyPresetStore,
    StrategyRunFilter, StrategyRunResult, StrategyRunStatus, StrategyRunStore,
    RESULT_FORMAT_CHUNKED, RESULT_FORMAT_LEGACY,
};
use sqlx::PgPool;
use storage::workbench::{PgStrategyPresetStore, PgStrategyRunStore};

async fn pool() -> PgPool {
    // ADR-023 E6b：统一测试库入口（EESTOCK_TEST_DATABASE_URL + 哨兵表校验），不得回退活库。
    test_support::test_pool().await
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
        // mark_succeeded 会强制写 chunked_v1（新 run 语义）；此字段不影响落库结果。
        result_format: RESULT_FORMAT_CHUNKED.to_string(),
    }
}

fn chunk(kind: ResultKind, seq: i32, from: i64, to: i64, payload: serde_json::Value) -> ResultChunk {
    ResultChunk {
        kind,
        seq,
        ts_from: DateTime::from_timestamp(from, 0).unwrap(),
        ts_to: DateTime::from_timestamp(to, 0).unwrap(),
        payload,
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

    // ADR-024 P4 / D8：新 run 写 chunked_v1 —— per_bar/net_value/drawdown 为 **占位 []**，
    // trades/metrics 保留；读取路径以 result_format 判别（禁止把占位当数据）。
    let res = store.get_result(&id).await.unwrap().expect("结果应存在");
    assert_eq!(res.result_format, RESULT_FORMAT_CHUNKED, "新 run 判别列 = chunked_v1");
    assert!(res.is_chunked());
    assert_eq!(res.per_bar, serde_json::json!([]), "三列写 [] 占位（数据在 strategy_run_bars）");
    assert_eq!(res.net_value, serde_json::json!([]));
    assert_eq!(res.drawdown, serde_json::json!([]));
    assert_eq!(res.trades, sample_result().trades, "trades 保留");
    assert_eq!(res.metrics, sample_result().metrics, "metrics 保留");
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

// ── ADR-024 P4 / D8：结果分块（strategy_run_bars） ──

/// 分块追加 + 序号分页 + 计数（跨块 + 超末尾边界）。
#[tokio::test]
async fn chunks_append_page_and_count() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_chunk");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();

    // 空 run：计数 0，分页空
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 0);
    assert!(store.result_chunks(&id, ResultKind::PerBar, 0, 100).await.unwrap().is_empty());

    // 追加 3 块（ts 递增，seq 0/1/2）
    for s in 0..3i32 {
        let from = ts(10 + s as i64 * 2).timestamp();
        let to = ts(11 + s as i64 * 2).timestamp();
        store.append_result_chunk(&id, &chunk(
            ResultKind::PerBar, s, from, to,
            serde_json::json!([{"ts": from, "tag": s}, {"ts": to, "tag": s}]),
        )).await.unwrap();
    }
    // 另一 kind（净値）独立序号
    store.append_result_chunk(&id, &chunk(
        ResultKind::NetValue, 0, ts(10).timestamp(), ts(11).timestamp(),
        serde_json::json!([[ts(10).timestamp(), 1.0]]),
    )).await.unwrap();

    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 3);
    assert_eq!(store.result_chunk_count(&id, ResultKind::NetValue).await.unwrap(), 1);
    assert_eq!(store.result_chunk_count(&id, ResultKind::Drawdown).await.unwrap(), 0);

    // 分页：offset=0/limit=2 → 前两块；offset=2/limit=2 → 第三块（跨块/超末尾）
    let p0 = store.result_chunks(&id, ResultKind::PerBar, 0, 2).await.unwrap();
    assert_eq!(p0.len(), 2);
    assert_eq!(p0[0].seq, 0);
    assert_eq!(p0[1].seq, 1);
    let p1 = store.result_chunks(&id, ResultKind::PerBar, 2, 2).await.unwrap();
    assert_eq!(p1.len(), 1, "最后一页不足 limit 仍返回剩余");
    assert_eq!(p1[0].seq, 2);
    assert!(store.result_chunks(&id, ResultKind::PerBar, 3, 2).await.unwrap().is_empty(),
        "超末尾 → 空");
    // 排序：seq 升序
    let all = store.result_chunks(&id, ResultKind::PerBar, 0, 100).await.unwrap();
    assert!(all.windows(2).all(|w| w[0].seq < w[1].seq), "seq 升序");
    assert_eq!(all[0].payload.as_array().unwrap().len(), 2, "payload 数组 roundtrip");
    clean_run(&pool, &id).await;
}

/// 区间读：返回与 [from,to] **相交的整块**（含外沿），由调用方块内过滤。
#[tokio::test]
async fn chunks_in_range_returns_intersecting_chunks() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_range");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();
    // 三块：[10,11] [12,13] [14,15]
    for s in 0..3i32 {
        store.append_result_chunk(&id, &chunk(
            ResultKind::PerBar, s,
            ts(10 + s as i64 * 2).timestamp(), ts(11 + s as i64 * 2).timestamp(),
            serde_json::json!([]),
        )).await.unwrap();
    }
    // 命中中间块（12~13）
    let mid = store.result_chunks_in_range(
        &id, ResultKind::PerBar, ts(12), ts(13)).await.unwrap();
    assert_eq!(mid.len(), 1);
    assert_eq!(mid[0].seq, 1);
    // 跨越三块（9~16）
    let all = store.result_chunks_in_range(
        &id, ResultKind::PerBar, ts(9), ts(16)).await.unwrap();
    assert_eq!(all.len(), 3, "区间覆盖全部块");
    // 相交边界：from 落在块内（10.5）→ 仍返回块 0（含外沿，调用方按 ts 过滤）
    let edge = store.result_chunks_in_range(
        &id, ResultKind::PerBar, ts(10) + Duration::hours(12), ts(12)).await.unwrap();
    assert!(edge.iter().any(|c| c.seq == 0), "部分重叠的块也返回（外沿由调用方过滤）");
    // 区间完全在数据之后 → 空
    let none = store.result_chunks_in_range(
        &id, ResultKind::PerBar, ts(100), ts(200)).await.unwrap();
    assert!(none.is_empty());
    clean_run(&pool, &id).await;
}

/// 级联：删 run → 分块一并删除。
#[tokio::test]
async fn chunks_cascade_delete_with_run() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_chunk_cascade");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();
    store.append_result_chunk(&id, &chunk(
        ResultKind::PerBar, 0, ts(1).timestamp(), ts(2).timestamp(),
        serde_json::json!([{"ts": 1}]),
    )).await.unwrap();
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 1);
    clean_run(&pool, &id).await;
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 0,
        "FK 级联删除分块");
}

/// D8 双读：`legacy_single` 旧 run 全量内联列原样可读（不回填；result_format 默认值）。
#[tokio::test]
async fn legacy_single_dual_read_unchanged() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_legacy");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();
    // 直插旧形态（不写 result_format → 迁移默认 'legacy_single'），模拟迁移前的历史 run。
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, trades, net_value, drawdown, metrics) \
         VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(&id)
        .bind(serde_json::json!([{"ts": 7, "signal": "Buy"}]))
        .bind(serde_json::json!([{"pnl": 1}]))
        .bind(serde_json::json!([[7, 100001.0]]))
        .bind(serde_json::json!([[7, -0.001]]))
        .bind(serde_json::json!({"total_return_pct": 1e-5}))
        .execute(&pool).await.unwrap();

    let res = store.get_result(&id).await.unwrap().expect("旧 run 可读");
    assert_eq!(res.result_format, RESULT_FORMAT_LEGACY, "默认判别列 = legacy_single");
    assert!(!res.is_chunked());
    assert_eq!(res.per_bar.as_array().unwrap().len(), 1, "legacy per_bar 逐値可读");
    assert_eq!(res.per_bar[0]["signal"], serde_json::json!("Buy"));
    assert_eq!(res.net_value, serde_json::json!([[7, 100001.0]]));
    assert_eq!(res.drawdown, serde_json::json!([[7, -0.001]]));
    // 旧 run 无分块行（不回填）
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 0);
    clean_run(&pool, &id).await;
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

/// ADR-024 P6：`kind='fills'` 单块 round-trip（CHECK 接受 'fills'；读取按 kind 隔离）。
#[tokio::test]
async fn chunks_kind_fills_round_trip() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = pid("_fills");
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();

    // 无成交：写空数组块（P6 选择：恒写块 ⇒ 读侧「有块 = 已记录」可判定）。
    store.append_result_chunk(&id, &chunk(
        ResultKind::Fills, 0, ts(0).timestamp(), ts(5).timestamp(),
        serde_json::json!([]),
    )).await.unwrap();
    let empty = store.result_chunks(&id, ResultKind::Fills, 0, 10).await.unwrap();
    assert_eq!(empty.len(), 1, "空成交块照样持久化（与「未写」区分）");
    assert_eq!(empty[0].kind, ResultKind::Fills);
    assert_eq!(empty[0].seq, 0);
    assert_eq!(empty[0].payload.as_array().unwrap().len(), 0);
    assert_eq!(store.result_chunk_count(&id, ResultKind::Fills).await.unwrap(), 1);
    // kind 隔离：不影响其它 kind
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 0);

    // 有成交：单块内容 round-trip 逐值一致
    let payload = serde_json::json!([
        {"type": "fill", "bar_index": 1, "ts": ts(1).timestamp(), "side": "Buy",
         "qty": 100.0, "price": 7.5, "reason": "Policy"},
        {"type": "fill", "bar_index": 2, "ts": ts(2).timestamp(), "side": "Sell",
         "qty": 100.0, "price": 8.0, "reason": "ForceClose"},
    ]);
    clean_run(&pool, &id).await;
    store.create_run(&new_run(&id, "600000")).await.unwrap();
    store.append_result_chunk(&id, &chunk(
        ResultKind::Fills, 0, ts(1).timestamp(), ts(2).timestamp(), payload.clone(),
    )).await.unwrap();
    let got = store.result_chunks(&id, ResultKind::Fills, 0, 10).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].payload, payload, "fills payload round-trip 逐值一致");
    assert_eq!(got[0].ts_from, ts(1));
    assert_eq!(got[0].ts_to, ts(2));
    clean_run(&pool, &id).await;
}
