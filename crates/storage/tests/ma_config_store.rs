//! MA 配置（MaConfigStore）集成测试（需 TimescaleDB :5433，含 0015 迁移）。
//! 非 tangle 手写（契约描述见 design/04-storage/schema.md §4.3.7）。
//! 覆盖：get 默认（表空→[5,10,20]）、set 写回后 get 一致、覆盖、单行约束。
//! ⚠️ ma_config 为全局单行（id 恒 1）：同一 binary 内的并行测试会互踩，故合并为单一测试函数
//! 顺序断言（与 favorite 测试的「每测试独立 code」策略不同——单行配置无可隔离键）。

use domain::ports::MaConfigStore;
use sqlx::PgPool;
use storage::ma_config::PgMaConfigStore;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clear_config(pool: &PgPool) {
    sqlx::query("DELETE FROM ma_config").execute(pool).await.unwrap();
}

#[tokio::test]
async fn ma_config_get_set_override_single_row() {
    let pool = pool().await;
    // 收敛到干净状态（表空 → get 应返回默认 [5,10,20]）
    clear_config(&pool).await;
    let store = PgMaConfigStore::new(pool.clone());

    // 1) 表空 → 默认 [5,10,20]
    assert_eq!(store.get().await.unwrap(), vec![5, 10, 20], "表空 → 默认 [5,10,20]");

    // 2) set 写回 → 返回归一化窗口；get 读回一致
    let written = store.set(&[10, 20, 30]).await.unwrap();
    assert_eq!(written, vec![10, 20, 30]);
    assert_eq!(store.get().await.unwrap(), vec![10, 20, 30], "set 后 get 一致");

    // 3) 覆盖写
    store.set(&[7]).await.unwrap();
    assert_eq!(store.get().await.unwrap(), vec![7], "覆盖写生效");

    // 4) 单行约束（id 恒 1；多次 set 不新增行）
    let cnt: i64 = sqlx::query_scalar("SELECT count(*) FROM ma_config")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1, "单行（id 恒 1）");

    // 清理，避免影响后续测试/前端（web api_ma_config 同表）
    clear_config(&pool).await;
}
