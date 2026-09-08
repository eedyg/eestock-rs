//! 页面⑧ S2 配置持久化（ConfigStore）集成测试（需 TimescaleDB :5433，含 0021 迁移）。
//! 非 tangle 手写（契约描述见 design/04-storage/schema.md；web 层校验值域/东财末位，本层只持久化 jsonb）。
//! 覆盖：get 缺失 → None、set 写回后 get 一致、覆盖写、跨 key 独立。
//! ⚠️ app_config 为全局 key-value 表：同一 binary 内并行测试用不同 key 隔离（无串扰）。

use domain::ports::ConfigStore;
use sqlx::PgPool;
use storage::config_store::PgConfigStore;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clear_key(pool: &PgPool, key: &str) {
    sqlx::query("DELETE FROM app_config WHERE key = $1").bind(key).execute(pool).await.unwrap();
}

#[tokio::test]
async fn config_store_get_set_override_and_isolated_key() {
    let pool = pool().await;
    // 用独特 key 隔离本测试（与其他 config 测试/前端共用表，避免互踩）
    let k = "config_store_test_key";
    clear_key(&pool, k).await;
    let store = PgConfigStore::new(pool.clone());

    // 1) 缺失 key → None
    assert!(store.get(k).await.unwrap().is_none(), "表无该 key → None");

    // 2) set 写回 → get 读回一致（jsonb roundtrip）
    let v = serde_json::json!({"default_interval_sec": 60, "trading_hours": "09:30-11:30/13:00-15:00"});
    store.set(k, v.clone()).await.unwrap();
    let got = store.get(k).await.unwrap().expect("写入后有值");
    assert_eq!(got, v, "get 读回与 set 一致（jsonb roundtrip）");

    // 3) 覆盖写
    let v2 = serde_json::json!({"default_interval_sec": 120});
    store.set(k, v2.clone()).await.unwrap();
    assert_eq!(store.get(k).await.unwrap().unwrap(), v2, "覆盖写生效");

    // 4) 跨 key 独立（key 隔离）
    let k2 = "config_store_test_key_other";
    clear_key(&pool, k2).await;
    assert!(store.get(k2).await.unwrap().is_none());
    store.set(k2, serde_json::json!({"enabled": true})).await.unwrap();
    assert_eq!(store.get(k).await.unwrap().unwrap(), v2, "写 k2 不影响 k");
    assert!(store.get(k2).await.unwrap().is_some(), "k2 有值");

    // 5) 单 key 幂等 upsert（同一 key 多次 set 不新增多行）
    store.set(k, serde_json::json!({"x": 1})).await.unwrap();
    store.set(k, serde_json::json!({"x": 2})).await.unwrap();
    let cnt: i64 = sqlx::query_scalar("SELECT count(*) FROM app_config WHERE key = $1")
        .bind(k).fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1, "同一 key 只 1 行");

    // 清理
    clear_key(&pool, k).await;
    clear_key(&pool, k2).await;
}
