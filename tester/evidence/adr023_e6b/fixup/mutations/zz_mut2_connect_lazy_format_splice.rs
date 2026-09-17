//! 变异 2（规避形态）：`connect_lazy` + `format!` 拼接 —— 无精确活库字面量、无 `test_support` 入口。
use sqlx::PgPool;

fn lazy_pool() -> PgPool {
    let host = "postgres://eestock:eestock@127.0.0.1:5433";
    let db = "eestock";
    let url = format!("{host}/{db}");
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy(&url)
        .expect("lazy")
}
