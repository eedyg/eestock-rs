//! 模拟实盘会话存储（SimSessionStore）集成测试（需 TimescaleDB :5433，迁移 0018 已 apply）。
//! 契约：simsession/simsession_result/sim_trades/sim_positions CRUD + 状态机 running→ended。
//! 每测试独立 session_id：并行执行共享 simsession 表，用唯一 id 隔离 + 清理。

use chrono::{Duration, TimeZone, Utc};
use domain::ports::{
    NewSimSession, NewSimTrade, SimSessionResult, SimSessionStatus, SimSessionStore, SimPositionRow,
};
use sqlx::PgPool;
use storage::sim::PgSimSessionStore;

fn base() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool, session_id: &str) {
    // FK 级联删除 simsession_result/sim_trades/sim_positions
    sqlx::query("DELETE FROM simsession WHERE id = $1")
        .bind(session_id).execute(pool).await.unwrap();
}

fn new_session(id: &str, name: &str) -> NewSimSession {
    NewSimSession {
        id: id.into(),
        name: name.into(),
        cash_init: 1_000_000.0,
        strategy_set: vec!["dual_ma".into()],
        stock_set: vec!["510300".into()],
        period: "M1".into(),
        start_ts: base(),
        source: "manual".into(),
    }
}

fn sid(suffix: &str) -> String {
    format!("s_{}_{}", std::process::id(), suffix)
}

#[tokio::test]
async fn create_and_get_session_roundtrip() {
    let pool = pool().await;
    let id = sid("create");
    clean(&pool, &id).await;

    let store = PgSimSessionStore::new(pool.clone());
    let s = new_session(&id, "t1");
    store.create_session(&s).await.unwrap();

    let v = store.get_session(&id).await.unwrap().expect("session 存在");
    assert_eq!(v.name, "t1");
    assert_eq!(v.cash_init, 1_000_000.0);
    assert_eq!(v.strategy_set, vec!["dual_ma".to_string()]);
    assert_eq!(v.stock_set, vec!["510300".to_string()]);
    assert_eq!(v.period, "M1");
    assert_eq!(v.start_ts, base());
    assert_eq!(v.status, SimSessionStatus::Running);
    assert_eq!(v.source, "manual");
    assert!(v.end_ts.is_none());

    // 未知 id → None
    assert!(store.get_session("no_such").await.unwrap().is_none());

    clean(&pool, &id).await;
}

#[tokio::test]
async fn list_sessions_returns_desc_by_start_ts() {
    let pool = pool().await;
    let id1 = sid("list1");
    let id2 = sid("list2");
    clean(&pool, &id1).await;
    clean(&pool, &id2).await;

    let store = PgSimSessionStore::new(pool.clone());
    let mut s1 = new_session(&id1, "older");
    let mut s2 = new_session(&id2, "newer");
    // 造时间差使 start_ts 可排序（newer > older）
    s1.start_ts = base();
    s2.start_ts = base() + Duration::hours(1);
    store.create_session(&s1).await.unwrap();
    store.create_session(&s2).await.unwrap();

    let all = store.list_sessions().await.unwrap();
    let i1 = all.iter().position(|v| v.id == id1).unwrap();
    let i2 = all.iter().position(|v| v.id == id2).unwrap();
    assert!(i2 < i1, "start_ts DESC → newer 在 older 前（但同秒场景不保证相对次序）");

    clean(&pool, &id1).await;
    clean(&pool, &id2).await;
}

#[tokio::test]
async fn append_trade_and_update_positions() {
    let pool = pool().await;
    let id = sid("trade");
    clean(&pool, &id).await;

    let store = PgSimSessionStore::new(pool.clone());
    store.create_session(&new_session(&id, "t1")).await.unwrap();

    store.append_trade(&NewSimTrade {
        session_id: id.clone(), code: "510300".into(), side: "buy".into(),
        qty: 1000.0, price: 10.002, ts: base(), fee: 5.0, source: "manual".into(),
    }).await.unwrap();

    store.update_positions(&id, &[SimPositionRow {
        session_id: id.clone(), code: "510300".into(), qty: 1000.0, avg_cost: 10.002,
    }]).await.unwrap();

    let n: (i64,) = sqlx::query_as("SELECT count(*) FROM sim_trades WHERE session_id = $1")
        .bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(n.0, 1, "成交明细落库");

    let rows: Vec<(String, f64, f64)> = sqlx::query_as(
        "SELECT code, qty, avg_cost FROM sim_positions WHERE session_id = $1")
        .bind(&id).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "510300");
    assert_eq!(rows[0].1, 1000.0);
    assert_eq!(rows[0].2, 10.002);

    clean(&pool, &id).await;
}

#[tokio::test]
async fn mark_end_writes_result_and_transitions_status() {
    let pool = pool().await;
    let id = sid("end");
    clean(&pool, &id).await;

    let store = PgSimSessionStore::new(pool.clone());
    store.create_session(&new_session(&id, "t1")).await.unwrap();

    let result = SimSessionResult {
        net_value: serde_json::json!([[base(), 1_000_000.0], [base() + Duration::minutes(1), 1_001_000.0]]),
        trades: serde_json::json!([{ "side": "buy", "qty": 1000 }]),
        metrics: serde_json::json!({ "net_profit": 1000.0 }),
    };
    let ok = store.mark_end(&id, base() + Duration::hours(1), &result).await.unwrap();
    assert!(ok, "running → ended 成功");

    let v = store.get_session(&id).await.unwrap().expect("session 存在");
    assert_eq!(v.status, SimSessionStatus::Ended);
    assert_eq!(v.end_ts, Some(base() + Duration::hours(1)));

    // 已 ended 再 mark_end → false（状态机只允许 running→ended）
    let ok2 = store.mark_end(&id, base() + Duration::hours(2), &result).await.unwrap();
    assert!(!ok2, "ended 后再 end 应 false");
    // 未知 id → false
    let ok3 = store.mark_end(&id, base() + Duration::hours(2), &result).await.unwrap();
    let unknown = store.mark_end("no_such", base(), &result).await.unwrap();
    assert!(!unknown, "未知 id → false");
    let _ = ok3;

    // 结果落库
    let row: Option<(serde_json::Value, serde_json::Value, serde_json::Value)> = sqlx::query_as(
        "SELECT net_value_json, trades_json, metrics_json FROM simsession_result WHERE session_id = $1")
        .bind(&id).fetch_optional(&pool).await.unwrap();
    let (nv, _, m) = row.expect("结果存在");
    assert_eq!(m["net_profit"], serde_json::json!(1000.0));
    assert_eq!(nv[0][1], serde_json::json!(1_000_000.0));

    clean(&pool, &id).await;
}

#[tokio::test]
async fn delete_session_cascades_children() {
    let pool = pool().await;
    let id = sid("delete");
    clean(&pool, &id).await;

    let store = PgSimSessionStore::new(pool.clone());
    store.create_session(&new_session(&id, "t1")).await.unwrap();
    store.append_trade(&NewSimTrade {
        session_id: id.clone(), code: "510300".into(), side: "buy".into(),
        qty: 100.0, price: 10.0, ts: base(), fee: 5.0, source: "manual".into(),
    }).await.unwrap();
    store.update_positions(&id, &[SimPositionRow {
        session_id: id.clone(), code: "510300".into(), qty: 100.0, avg_cost: 10.0,
    }]).await.unwrap();

    assert!(store.delete_session(&id).await.unwrap(), "存在 session 删除返回 true");
    assert!(store.get_session(&id).await.unwrap().is_none());

    for table in ["simsession_result", "sim_trades", "sim_positions"] {
        let cnt: (i64,) = sqlx::query_as(&format!("SELECT count(*) FROM {table} WHERE session_id = $1"))
            .bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!(cnt.0, 0, "FK ON DELETE CASCADE 级联删除 {table}");
    }

    assert!(!store.delete_session("no_such").await.unwrap(), "未知 id 返回 false");
}
