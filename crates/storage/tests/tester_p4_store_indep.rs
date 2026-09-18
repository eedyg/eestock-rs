//! **tester 独立验收**（ADR-024 P4 / D8）——storage 分块端口（`strategy_run_bars`，迁移 0027）。
//! ⚠️ 非 tangle 手写；本文件由 tester 独立编写，**不复用** worker 的 `workbench_store.rs` 断言。
//! 目标：真实 DB（`EESTOCK_TEST_DATABASE_URL` 临时库）上复核
//!   ① `mark_succeeded` 新语义（强制 `chunked_v1` + 三列 `[]` 占位、trades/metrics 保留、`running` 守卫）；
//!   ② `append_result_chunk` 失败可上报（FK/PK 违反 ⇒ Err ⇒ 应用层可落 failed）；
//!   ③ `result_chunks` 分页边界（0/越界/kind 隔离/seq 升序）；
//!   ④ `result_chunks_in_range` 相交矩阵（含块外沿、完全不相交为空）；
//!   ⑤ `legacy_single` 默认判别列 + 无分块行（双读不回填）。
//! 每测试独立 run id 前缀（`tp4<pid>_`）；结束即删（FK 级联带走分块/结果行）。

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::{
    NewStrategyRun, ResultChunk, ResultKind, StrategyRunResult, StrategyRunStatus, StrategyRunStore,
    RESULT_FORMAT_CHUNKED, RESULT_FORMAT_LEGACY,
};
use sqlx::PgPool;
use storage::workbench::PgStrategyRunStore;

async fn pool() -> PgPool {
    // ADR-023 E6b：统一测试库入口（EESTOCK_TEST_DATABASE_URL + 哨兵表校验）。
    test_support::test_pool().await
}

fn rid(tag: &str) -> String {
    format!("tp4{}__{}", std::process::id(), tag)
}

fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 1, 1, 30, 0).unwrap()
}

fn ts_min(i: i64) -> DateTime<Utc> {
    t0() + Duration::minutes(i)
}

fn new_run(id: &str) -> NewStrategyRun {
    NewStrategyRun {
        id: id.into(),
        name: format!("tester-p4-{id}"),
        symbol: "600000".into(),
        period: "M1".into(),
        from_ts: t0(),
        to_ts: t0() + Duration::days(30),
        config: serde_json::json!({"slots": [], "policy": null}),
    }
}

fn chunk(kind: ResultKind, seq: i32, from_i: i64, to_i: i64, payload: serde_json::Value) -> ResultChunk {
    ResultChunk {
        kind,
        seq,
        ts_from: ts_min(from_i),
        ts_to: ts_min(to_i),
        payload,
    }
}

/// 假的「内联三列有数据」结果：`mark_succeeded` 必须**忽略**这三列（写 `[]` 占位），
/// 只保留 trades/metrics。用非空数据作探针 ⇒ 若占位不是硬写，本断言会红。
fn result_with_fake_inline() -> StrategyRunResult {
    StrategyRunResult {
        per_bar: serde_json::json!([{"ts": 999, "aggregate": 1.0}]),
        trades: serde_json::json!([{"ts": 1, "side": "Buy"}]),
        net_value: serde_json::json!([[999, 1.0]]),
        drawdown: serde_json::json!([[999, -0.5]]),
        metrics: serde_json::json!({"total_return_pct": 3.5}),
        result_format: RESULT_FORMAT_LEGACY.to_string(), // 反探针：调用方谎报 legacy 也不得改变落库形态
    }
}

async fn clean(pool: &PgPool, id: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE id = $1").bind(id).execute(pool).await.unwrap();
}

async fn started_run(pool: &PgPool, store: &PgStrategyRunStore, id: &str) {
    clean(pool, id).await;
    store.create_run(&new_run(id)).await.unwrap();
    assert!(store.mark_started(id, t0()).await.unwrap(), "queued→running 认领应成功");
}

// ───────────────────────── ① mark_succeeded 新语义 ─────────────────────────

#[tokio::test]
async fn t_p4_mark_succeeded_forces_chunked_placeholders_and_keeps_trades() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = rid("succ");
    started_run(&pool, &store, &id).await;

    // 分块先于 mark_succeeded（应用层顺序契约的存储侧可观测性）
    store.append_result_chunk(&id, &chunk(ResultKind::PerBar, 0, 0, 9,
        serde_json::json!((0..10).map(|i| serde_json::json!({"ts": i})).collect::<Vec<_>>()))).await.unwrap();
    store.append_result_chunk(&id, &chunk(ResultKind::PerBar, 1, 10, 11,
        serde_json::json!([{"ts": 10}, {"ts": 11}]))).await.unwrap();
    store.append_result_chunk(&id, &chunk(ResultKind::NetValue, 0, 0, 11,
        serde_json::json!([[0, 100000.0], [11, 100100.0]]))).await.unwrap();

    assert!(store.mark_succeeded(&id, &result_with_fake_inline(), t0()).await.unwrap(),
            "running→succeeded 应成功");

    let res = store.get_result(&id).await.unwrap().expect("结果行应存在");
    assert_eq!(res.result_format, RESULT_FORMAT_CHUNKED, "新 run 强制 chunked_v1");
    assert!(res.is_chunked());
    assert_eq!(res.per_bar, serde_json::json!([]), "per_bar 必须为 [] 占位（忽略调用方内联数据）");
    assert_eq!(res.net_value, serde_json::json!([]), "net_value 必须为 [] 占位");
    assert_eq!(res.drawdown, serde_json::json!([]), "drawdown 必须为 [] 占位");
    assert_eq!(res.trades, serde_json::json!([{"ts": 1, "side": "Buy"}]), "trades 保留");
    assert_eq!(res.metrics["total_return_pct"], 3.5, "metrics 保留");

    // 原始行复核（绕过 ORM 映射）
    let (fmt, per_bar_text): (String, String) = sqlx::query_as(
        "SELECT result_format, per_bar::text FROM strategy_run_result WHERE run_id = $1")
        .bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(fmt, "chunked_v1");
    assert_eq!(per_bar_text, "[]");

    // 分块仍在且内容原样（先写后 mark_succeeded 不被覆盖）
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 2);
    assert_eq!(store.result_chunk_count(&id, ResultKind::NetValue).await.unwrap(), 1);
    let c0 = store.result_chunks(&id, ResultKind::PerBar, 0, 1).await.unwrap();
    assert_eq!(c0[0].payload.as_array().unwrap().len(), 10, "分块 payload 原样保留");

    let run = store.get_run(&id).await.unwrap().unwrap();
    assert_eq!(run.status, StrategyRunStatus::Succeeded);
    clean(&pool, &id).await;
}

#[tokio::test]
async fn t_p4_mark_succeeded_guard_blocks_non_running_and_writes_no_result() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());

    // (a) queued：守卫应拒绝
    let id = rid("guard_queued");
    clean(&pool, &id).await;
    store.create_run(&new_run(&id)).await.unwrap();
    assert!(!store.mark_succeeded(&id, &result_with_fake_inline(), t0()).await.unwrap(),
            "queued 不得落 succeeded");
    assert!(store.get_result(&id).await.unwrap().is_none(), "被拒时不得写结果行");
    assert_eq!(store.get_run(&id).await.unwrap().unwrap().status, StrategyRunStatus::Queued);

    // (b) canceled：守卫应拒绝（取消胜出 ⇒ 分块可留、结果不落、状态不翻）
    let id2 = rid("guard_canceled");
    started_run(&pool, &store, &id2).await;
    store.append_result_chunk(&id2, &chunk(ResultKind::PerBar, 0, 0, 0, serde_json::json!([{"ts":0}]))).await.unwrap();
    assert_eq!(store.mark_canceled(&id2, t0()).await.unwrap(), Some(true));
    assert!(!store.mark_succeeded(&id2, &result_with_fake_inline(), t0()).await.unwrap(),
            "canceled 不得落 succeeded（status='running' 守卫）");
    assert!(store.get_result(&id2).await.unwrap().is_none(), "取消后无结果行");
    assert_eq!(store.get_run(&id2).await.unwrap().unwrap().status, StrategyRunStatus::Canceled);
    assert_eq!(store.result_chunk_count(&id2, ResultKind::PerBar).await.unwrap(), 1,
               "取消后已写分块保留（D8）");

    // (c) 未知 id
    assert!(!store.mark_succeeded(&rid("guard_none"), &result_with_fake_inline(), t0()).await.unwrap());
    clean(&pool, &id).await;
    clean(&pool, &id2).await;
}

// ───────────────────── ② append_result_chunk 失败可上报 ─────────────────────

#[tokio::test]
async fn t_p4_append_result_chunk_errors_are_surfaced() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());

    // (a) run 不存在 ⇒ FK 违反 ⇒ Err（应用层据此落 failed 的机制前提）
    let ghost = rid("ghost");
    clean(&pool, &ghost).await;
    let e = store.append_result_chunk(&ghost, &chunk(ResultKind::PerBar, 0, 0, 0,
        serde_json::json!([{"ts": 0}]))).await;
    assert!(e.is_err(), "未知 run 的 append 必须返回 Err（不得静默丢弃）");
    println!("[probe] append to unknown run → Err: {}", e.unwrap_err());

    // (b) 同 (run,kind,seq) 重复 ⇒ PK 违反 ⇒ Err（seq 单调的硬约束在 DB 侧）
    let id = rid("dup");
    started_run(&pool, &store, &id).await;
    store.append_result_chunk(&id, &chunk(ResultKind::PerBar, 0, 0, 0, serde_json::json!([{"ts":0}]))).await.unwrap();
    let dup = store.append_result_chunk(&id, &chunk(ResultKind::PerBar, 0, 0, 0, serde_json::json!([{"ts":0}]))).await;
    assert!(dup.is_err(), "同 seq 重复 append 必须 Err（PK (run_id,kind,seq)）");
    println!("[probe] duplicate (kind,seq) → Err: {}", dup.unwrap_err());
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 1);

    // (c) 非法 kind 在 domain 层不可构造（枚举）；DB CHECK 由 05_tempdb_schema_probe 独立验证。
    clean(&pool, &id).await;
    clean(&pool, &ghost).await;
}

// ───────────────────────── ③ 分页边界（chunk 序号单位） ─────────────────────────

#[tokio::test]
async fn t_p4_result_chunks_paging_boundaries_and_kind_isolation() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = rid("page");
    started_run(&pool, &store, &id).await;

    for seq in 0..5i32 {
        store.append_result_chunk(&id, &chunk(ResultKind::PerBar, seq, seq as i64 * 10,
            seq as i64 * 10 + 9, serde_json::json!([{"seq": seq}]))).await.unwrap();
    }
    store.append_result_chunk(&id, &chunk(ResultKind::NetValue, 0, 0, 49,
        serde_json::json!([[0, 1.0]]))).await.unwrap();

    // offset=0 / limit=2
    let p0 = store.result_chunks(&id, ResultKind::PerBar, 0, 2).await.unwrap();
    assert_eq!(p0.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![0, 1]);
    // 恰好末块
    let p4 = store.result_chunks(&id, ResultKind::PerBar, 4, 100).await.unwrap();
    assert_eq!(p4.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![4]);
    // 越界 => 空
    assert!(store.result_chunks(&id, ResultKind::PerBar, 5, 10).await.unwrap().is_empty());
    assert!(store.result_chunks(&id, ResultKind::PerBar, 999, 10).await.unwrap().is_empty());
    // 单块窗口（跨页复核：offset=3,limit=1）
    let p3 = store.result_chunks(&id, ResultKind::PerBar, 3, 1).await.unwrap();
    assert_eq!(p3.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![3]);
    // kind 隔离
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 5);
    assert_eq!(store.result_chunk_count(&id, ResultKind::NetValue).await.unwrap(), 1);
    assert_eq!(store.result_chunk_count(&id, ResultKind::Drawdown).await.unwrap(), 0);
    assert_eq!(store.result_chunks(&id, ResultKind::Drawdown, 0, 10).await.unwrap().len(), 0);
    // 逐页拼接 == 全量（无重复/无缺失）
    let mut all_seq = Vec::new();
    for off in 0..5i64 {
        all_seq.extend(store.result_chunks(&id, ResultKind::PerBar, off, 1).await.unwrap().iter().map(|c| c.seq));
    }
    assert_eq!(all_seq, vec![0, 1, 2, 3, 4], "逐页拼接必须等于全量且有序");
    clean(&pool, &id).await;
}

// ─────────────────────── ④ 区间读相交矩阵（含块外沿） ───────────────────────

#[tokio::test]
async fn t_p4_result_chunks_in_range_intersection_matrix() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = rid("range");
    started_run(&pool, &store, &id).await;

    // c0: ts [0,9]  c1: ts [10,19]  c2: ts [20,29]（分钟）
    for seq in 0..3i32 {
        let a = seq as i64 * 10;
        store.append_result_chunk(&id, &chunk(ResultKind::PerBar, seq, a, a + 9,
            serde_json::json!([{"seq": seq}]))).await.unwrap();
    }

    let seqs = |v: Vec<ResultChunk>| v.iter().map(|c| c.seq).collect::<Vec<_>>();
    // 恰好一块
    assert_eq!(seqs(store.result_chunks_in_range(&id, ResultKind::PerBar, ts_min(10), ts_min(19)).await.unwrap()), vec![1]);
    // 跨块（块内相交）
    assert_eq!(seqs(store.result_chunks_in_range(&id, ResultKind::PerBar, ts_min(15), ts_min(25)).await.unwrap()), vec![1, 2]);
    // 外沿：from 落在块内、to 落在块内（块级相交但 bar 需服务端过滤）
    assert_eq!(seqs(store.result_chunks_in_range(&id, ResultKind::PerBar, ts_min(9), ts_min(10)).await.unwrap()), vec![0, 1]);
    // 单点闭区间命中两块（ts=10 同时是 c1 首根与 c0 的 to 外沿）
    assert_eq!(seqs(store.result_chunks_in_range(&id, ResultKind::PerBar, ts_min(10), ts_min(10)).await.unwrap()), vec![1]);
    // 完全不相交（区间在数据之后）
    assert!(store.result_chunks_in_range(&id, ResultKind::PerBar, ts_min(100), ts_min(200)).await.unwrap().is_empty());
    // 完全不相交（区间在数据之前）
    assert!(store.result_chunks_in_range(&id, ResultKind::PerBar, ts_min(-100), ts_min(-1)).await.unwrap().is_empty());
    // 全量区间
    assert_eq!(seqs(store.result_chunks_in_range(&id, ResultKind::PerBar, ts_min(0), ts_min(29)).await.unwrap()), vec![0, 1, 2]);
    // kind 隔离（净值无分块 ⇒ 空）
    assert!(store.result_chunks_in_range(&id, ResultKind::NetValue, ts_min(0), ts_min(29)).await.unwrap().is_empty());
    clean(&pool, &id).await;
}

// ───────────────────── ⑤ legacy_single 默认判别列 + 不回填 ─────────────────────

#[tokio::test]
async fn t_p4_legacy_single_default_discriminator_and_no_backfill() {
    let pool = pool().await;
    let store = PgStrategyRunStore::new(pool.clone());
    let id = rid("legacy");
    started_run(&pool, &store, &id).await;

    // 手工插「旧形态」结果行：**不指定** result_format（模拟迁移前写入的行/默认值）
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, trades, net_value, drawdown, metrics) \
         VALUES ($1, $2::jsonb, '[]'::jsonb, $3::jsonb, $4::jsonb, '{}'::jsonb)")
        .bind(&id)
        .bind(serde_json::json!([{"ts": 1}, {"ts": 2}, {"ts": 3}]).to_string())
        .bind(serde_json::json!([[1, 100000.0], [2, 100010.0], [3, 100020.0]]).to_string())
        .bind(serde_json::json!([[1, 0.0], [2, -0.01], [3, -0.02]]).to_string())
        .execute(&pool).await.unwrap();

    let res = store.get_result(&id).await.unwrap().expect("结果行应存在");
    assert_eq!(res.result_format, RESULT_FORMAT_LEGACY, "未指定 ⇒ 默认 legacy_single");
    assert!(!res.is_chunked());
    assert_eq!(res.per_bar.as_array().unwrap().len(), 3, "内联列逐值可读");
    assert_eq!(res.net_value[0][1], 100000.0);
    assert_eq!(res.drawdown[2][1], -0.02);
    // 不回填：无分块行
    assert_eq!(store.result_chunk_count(&id, ResultKind::PerBar).await.unwrap(), 0, "旧 run 不回填分块");
    assert_eq!(store.result_chunk_count(&id, ResultKind::NetValue).await.unwrap(), 0);
    assert!(store.result_chunks(&id, ResultKind::PerBar, 0, 10).await.unwrap().is_empty());
    clean(&pool, &id).await;
}
