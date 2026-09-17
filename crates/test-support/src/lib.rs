//! dev-only 测试支持：**唯一**的集成测试建池入口（DRY）。
//!
//! ADR-023 §6.1 第 8 条（测试隔离债）与 §6.3 第 12 条（测试残留污染生产 cagg）的落地门禁：
//!
//! 1. 连接串**只**来自环境变量 `EESTOCK_TEST_DATABASE_URL`；未设即 `panic`（响亮失败，点名变量）。
//! 2. 建池后**必须**校验哨兵表 `_eestock_test_db` 存在且值恒为 `test`；否则 `panic`
//!    （防止误把 `EESTOCK_TEST_DATABASE_URL` 指向活库 `eestock` —— 测试会写库，误指即污染生产数据）。
//!
//! 各测试文件一律 `test_support::test_pool().await`，不得各自复制这段逻辑。

use sqlx::PgPool;

/// 唯一允许的测试库连接串环境变量名。
pub const TEST_DB_ENV: &str = "EESTOCK_TEST_DATABASE_URL";
/// 测试库哨兵表名（只有 `scripts/testdb-init.sh` 创建的测试库才应含此表）。
pub const SENTINEL_TABLE: &str = "_eestock_test_db";
/// 「不可达」连接串（端口 59999，**不是**活库 5433）：供**不需要连库**的契约测试构造 lazy 池使用。
///
/// 为什么集中放这里：门禁 R1 要求**任何构造连接池**的测试文件（含 `connect_lazy`）都必须经
/// `test_support::` 统一入口 —— 这样「自己拼一个看起来不可达的 URL」不再有独立落点，
/// 避免以「不可达」之名夹带活库地址（见 `crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs`）。
pub const UNREACHABLE_TEST_DB_URL: &str = "postgres://eestock:eestock@127.0.0.1:59999/eestock";
/// 哨兵表唯一行的约定值。
pub const SENTINEL_VALUE: &str = "test";

/// 建测试池：读 `EESTOCK_TEST_DATABASE_URL` → 连接 → 校验哨兵表 → 返回池。
///
/// 任何一种前置不满足都 `panic`（不是 `unwrap_or_else` 兜底到活库）。
pub async fn test_pool() -> PgPool {
    let url = match std::env::var(TEST_DB_ENV) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => panic!(
            "集成测试拒绝运行：环境变量 `{TEST_DB_ENV}` 未设置（或为空）。\n\
             这是**刻意设计**的响亮失败——禁止回退到活库 `eestock`（测试会写库，误指即污染生产数据）。\n\
             前置步骤：先运行 `scripts/testdb-init.sh`，再 `export {TEST_DB_ENV}=...`（见 README「跑集成测试的前置步骤」）。"
        ),
    };

    let pool = PgPool::connect(&url).await.unwrap_or_else(|e| {
        panic!("`{TEST_DB_ENV}` 连接失败（测试库不可达；请先运行 scripts/testdb-init.sh）: {e}")
    });

    assert_test_db_sentinel(&pool).await;
    pool
}

/// 校验哨兵表 `_eestock_test_db` 存在且值恒为 `test`；否则响亮失败。
async fn assert_test_db_sentinel(pool: &PgPool) {
    let row: Result<Option<(String,)>, sqlx::Error> =
        sqlx::query_as("SELECT value FROM _eestock_test_db LIMIT 1")
            .fetch_optional(pool)
            .await;
    match row {
        Ok(Some((v,))) if v == SENTINEL_VALUE => {}
        Ok(Some((v,))) => panic!(
            "哨兵表 `{SENTINEL_TABLE}` 的 value=`{v}` ≠ `{SENTINEL_VALUE}`：`{TEST_DB_ENV}` 指向的不是测试库。"
        ),
        Ok(None) => panic!(
            "哨兵表 `{SENTINEL_TABLE}` 为空：`{TEST_DB_ENV}` 指向的库未经初始化，请运行 scripts/testdb-init.sh。"
        ),
        Err(e) => panic!(
            "哨兵表 `{SENTINEL_TABLE}` 不存在/查询失败：`{TEST_DB_ENV}` 很可能指向活库 `eestock`（哨兵拦截）。: {e}"
        ),
    }
}
