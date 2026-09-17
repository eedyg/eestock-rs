//! 变异 3（仅注释提及）：代码里是 `PgPool::connect` + `format!` 拼接，
//! 变量名与哨兵表名只出现在**注释**里：连接串来自 EESTOCK_TEST_DATABASE_URL，
//! 建池后断言哨兵表 _eestock_test_db（以上两句均为注释，无障碍地骗过旧门禁）。
use sqlx::PgPool;

async fn pool() -> PgPool {
    let url = format!("postgres://eestock:eestock@127.0.0.1:5433/{}", "eestock");
    PgPool::connect(&url).await.expect("connect")
}
