//! 页面⑧ 系统设置 S2 配置持久化端口实现（**非 tangle 手写**，契约描述见 design/04-storage/schema.md）。
//! 实现 `domain::ports::ConfigStore`（PgPool；app_config 表，迁移 0021）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；web 只依赖 domain::ports::ConfigStore。
//! 语义：通用 key→jsonb 配置存储（sources/collector/mcp 三块），缺值由 web 层回退 SETTINGS_DEFAULTS。
//! 应用面自有表（数据面不读写，ADR-017 不违）。

use anyhow::Result;
use async_trait::async_trait;
use domain::ports::ConfigStore;
use sqlx::PgPool;

pub struct PgConfigStore {
    pool: PgPool,
}

impl PgConfigStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

/// 按 key 读配置值（无该 key → None，web 层回退默认）。
const GET_SQL: &str = "SELECT value FROM app_config WHERE key = $1";

#[async_trait]
impl ConfigStore for PgConfigStore {
    async fn get(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let row: Option<(serde_json::Value,)> = sqlx::query_as(GET_SQL)
            .bind(key).fetch_optional(&self.pool).await?;
        Ok(row.map(|r| r.0))
    }

    /// 写/覆盖 key 的配置值（INSERT ... ON CONFLICT DO UPDATE；updated_at=now()）。
    async fn set(&self, key: &str, value: serde_json::Value) -> Result<()> {
        sqlx::query(
            "INSERT INTO app_config (key, value) VALUES ($1, $2) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()")
            .bind(key)
            .bind(&value)
            .execute(&self.pool).await?;
        Ok(())
    }
}
