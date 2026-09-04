// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/storage/src/admin.rs>>[init]
//! 应用面写/控制通道加法扩展（Wave 1 Phase C，ADR-017 授权口径；数据面既有写路径零改动）：
//! - PgSymbolAdmin：symbols 表注册/编辑（写即控制通道——Scheduler 每周期重读热生效）
//! - PgResetStore：熔断复位 DB 通道（应用面 request_reset 插入；数据面 take_pending 原子消费）
//!
//! 字段校验在 web 层完成（dto.rs 纯函数，与 schema CHECK 同口径）；本层仅落库，CHECK 兜底。

use anyhow::Result;
use async_trait::async_trait;
use domain::ports::{
    CircuitResetChannel, CircuitResetWrite, ResetRequest, SymbolAdminInput, SymbolAdminWrite,
    SymbolPatch,
};
use sqlx::PgPool;

/// symbols 表管理写（POST /api/symbols、PATCH /api/symbols/{code}）。
pub struct PgSymbolAdmin {
    pool: PgPool,
}

impl PgSymbolAdmin {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl SymbolAdminWrite for PgSymbolAdmin {
    /// 注册；ON CONFLICT DO NOTHING → rows_affected=0 即已存在（Ok(false)，web 映射 409）。
    async fn register(&self, input: &SymbolAdminInput) -> Result<bool> {
        let n = sqlx::query(
            "INSERT INTO symbols (code, name, interval_secs, settlement, enabled) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING")
            .bind(&input.code).bind(&input.name)
            .bind(input.interval_secs).bind(&input.settlement).bind(input.enabled)
            .execute(&self.pool).await?
            .rows_affected();
        Ok(n > 0)
    }

    /// 编辑（COALESCE 语义：None 字段不改）；code 不存在 → Ok(false)（web 映射 404）。
    async fn update(&self, code: &str, patch: &SymbolPatch) -> Result<bool> {
        let n = sqlx::query(
            "UPDATE symbols SET \
                 name = COALESCE($2, name), \
                 interval_secs = COALESCE($3, interval_secs), \
                 settlement = COALESCE($4, settlement), \
                 enabled = COALESCE($5, enabled) \
             WHERE code = $1")
            .bind(code).bind(&patch.name).bind(patch.interval_secs)
            .bind(&patch.settlement).bind(patch.enabled)
            .execute(&self.pool).await?
            .rows_affected();
        Ok(n > 0)
    }
}

/// 熔断复位 DB 控制通道（circuit_reset_requests，migrations/0007）：
/// 应用面写（CircuitResetWrite）+ 数据面消费（CircuitResetChannel），单表双角色。
pub struct PgResetStore {
    pool: PgPool,
}

impl PgResetStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl CircuitResetWrite for PgResetStore {
    async fn request_reset(&self, source: &str) -> Result<()> {
        sqlx::query("INSERT INTO circuit_reset_requests (source) VALUES ($1)")
            .bind(source).execute(&self.pool).await?;
        Ok(())
    }
}

#[async_trait]
impl CircuitResetChannel for PgResetStore {
    /// UPDATE ... RETURNING 原子消费（并发下同行只被一个消费者取出；
    /// circuit_reset_pending_idx 部分索引覆盖 consumed_at IS NULL）。
    async fn take_pending(&self) -> Result<Vec<ResetRequest>> {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "UPDATE circuit_reset_requests SET consumed_at = now() \
             WHERE id IN (SELECT id FROM circuit_reset_requests \
                          WHERE consumed_at IS NULL ORDER BY id) \
             RETURNING id, source")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(id, source)| ResetRequest { id, source }).collect())
    }
}
// ~/~ end
