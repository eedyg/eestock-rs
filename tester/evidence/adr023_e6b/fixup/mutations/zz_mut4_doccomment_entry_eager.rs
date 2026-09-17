//! 变异 4（仅在**文档注释**里提统一入口）：本文件自称走 `test_support::test_pool` 入口，
//! 代码里实际是 `PgPool::connect` + 精确活库字面量。
use sqlx::PgPool;

async fn pool() -> PgPool {
    PgPool::connect("postgres://eestock:eestock@127.0.0.1:5433/eestock").await.expect("connect")
}
