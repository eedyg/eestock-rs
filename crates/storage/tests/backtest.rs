//! 回测端口实现集成测试（需 TimescaleDB :5433，迁移 0011 已 apply）。
//! 契约：BacktestBarRead（统一读源 accurate 优先 + 区间升序）、BacktestRunStore（CRUD 状态机）。
//! 每测试独立 group_id：并行执行共享 backtest_runs 表，用唯一 group 隔离 + 清理。

use chrono::{Duration, TimeZone, Utc};
use domain::ports::{BacktestBarRead, BacktestRunStore, NewRun, RunFilter, RunResult, RunStatus};
use domain::types::{Period, SourceId};
use sqlx::PgPool;
use storage::backtest::{BacktestBarReader, PgBacktestStore};

fn base() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean_backtest(pool: &PgPool, group: &str) {
    // run_id PK 级联删除 backtest_results
    sqlx::query("DELETE FROM backtest_runs WHERE group_id = $1")
        .bind(group).execute(pool).await.unwrap();
}

fn new_run(group: &str) -> NewRun {
    NewRun {
        code: "518880".into(),
        period: "D1".into(),
        strategy_id: "dual_ma".into(),
        params: serde_json::json!({ "fast": 5, "slow": 20 }),
        fee: serde_json::json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 }),
        group_id: Some(group.into()),
    }
}

#[tokio::test]
async fn bar_read_m1_accurate_first_in_range() {
    let pool = pool().await;
    let code = "997781".to_string();
    // 5 根 1m raw（close 1..5）；base+1min 处准确层覆盖（close 9.99，777 股，tushare）
    for i in 0..5i64 {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(&code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 'M1', 9.99, 9.99, 9.99, 9.99, 777, 777.0, 'tushare') \
                 ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
        .bind(&code).bind(base() + Duration::minutes(1))
        .execute(&pool).await.unwrap();

    let r = BacktestBarReader::new(pool.clone());
    let bars = r.bars(&code, &Period::M1, base() - Duration::minutes(1),
        base() + Duration::minutes(10)).await.unwrap();
    assert_eq!(bars.len(), 5, "[from,to) 全量 bar");
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "ts 升序（回测口径）");
    assert_eq!(bars[0].close, 1.0);
    assert_eq!(bars[1].close, 9.99, "accurate 优先（ADR-003 merge 视图）");
    assert_eq!(bars[1].volume, 777);
    assert_eq!(bars[1].source, SourceId::Tushare);
    assert_eq!(bars[4].close, 5.0);

    // 区间边界：[from, to) 半开
    let subset = r.bars(&code, &Period::M1, base() + Duration::minutes(2),
        base() + Duration::minutes(4)).await.unwrap();
    assert_eq!(subset.iter().map(|b| b.close).collect::<Vec<_>>(), vec![3.0, 4.0]);

    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(&code).execute(&pool).await.unwrap();
    }
}

#[tokio::test]
async fn run_store_lifecycle() {
    let pool = pool().await;
    let group = format!("bt_store_lifecycle_{}", std::process::id());
    clean_backtest(&pool, &group).await;

    let mut store = PgBacktestStore::new(pool.clone());
    let id = store.create_run(&new_run(&group)).await.unwrap();
    assert!(id > 0, "create_run 返回 id");

    // create 后 pending
    let v0 = store.get_run(id).await.unwrap().expect("run 存在");
    assert_eq!(v0.status, RunStatus::Pending);
    assert_eq!(v0.progress, 0);

    // progress → running + current_ts 写入
    let ts = base() + Duration::minutes(1);
    store.update_run_progress(id, 42, ts).await.unwrap();
    let v1 = store.get_run(id).await.unwrap().expect("run 存在");
    assert_eq!(v1.status, RunStatus::Running);
    assert_eq!(v1.progress, 42);
    assert_eq!(v1.current_ts, Some(ts));

    // mark_done → done + 结果 upsert
    let result = RunResult {
        net_value: serde_json::json!([[ts, 100000.0], [ts + Duration::minutes(1), 101000.0]]),
        trades: serde_json::json!([]),
        metrics: serde_json::json!({ "net_profit": 1000.0, "sharpe": 1.2 }),
    };
    store.mark_done(id, &result).await.unwrap();
    let v2 = store.get_run(id).await.unwrap().expect("run 存在");
    assert_eq!(v2.status, RunStatus::Done);
    assert_eq!(v2.progress, 100);
    assert!(v2.finished_at.is_some());
    let res = v2.result.expect("done 后带结果");
    assert_eq!(res.metrics["net_profit"], serde_json::json!(1000.0));

    // list_runs 按 status=done 命中；按 group 命中
    let done_only = store.list_runs(&RunFilter { status: Some(RunStatus::Done), ..Default::default() })
        .await.unwrap();
    assert!(done_only.iter().any(|r| r.id == id), "done 状态列表命中");
    let by_group = store.list_runs(&RunFilter { group_id: Some(group.clone()), ..Default::default() })
        .await.unwrap();
    assert!(by_group.iter().any(|r| r.id == id), "group 过滤命中");

    // mark_failed → failed + error
    let id2 = store.create_run(&new_run(&group)).await.unwrap();
    store.mark_failed(id2, "simulated error").await.unwrap();
    let v3 = store.get_run(id2).await.unwrap().expect("run 存在");
    assert_eq!(v3.status, RunStatus::Failed);
    assert_eq!(v3.error.as_deref(), Some("simulated error"));

    clean_backtest(&pool, &group).await;
}
