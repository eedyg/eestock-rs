//! 变异 1（规范作弊形态）：`PgPool::connect` + 精确活库字面量；无 `test_support` 入口。
use sqlx::PgPool;

const LIVE: &str = "postgres://eestock:eestock@127.0.0.1:5433/eestock";

async fn pool() -> PgPool {
    PgPool::connect(LIVE).await.expect("connect")
}
