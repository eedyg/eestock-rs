//! 变异 5（仅在**文档注释**里提统一入口 + lazy 规避）：本文件自称走 `test_support::test_pool`，
//! 代码里实际是 `connect_lazy` + `format!` 拼接。
use sqlx::PgPool;

fn lazy_pool() -> PgPool {
    let url = format!("postgres://eestock:eestock@127.0.0.1:5433/{}", "eestock");
    sqlx::postgres::PgPoolOptions::new().connect_lazy(&url).expect("lazy")
}
