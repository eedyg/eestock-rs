//! 页面⑧ 系统设置 S1：系统信息 db 保活 + raw 层清空端口实现（storage 基础设施层）。
//! 由 08-settings.md tangle 生成（ADR-007），禁止手改。
//! 端口契约见 domain::ports::{SystemInfoRead, RawPurgePort}（ADR-017：web 只依赖端口）。

use async_trait::async_trait;
use domain::ports::{RawPurgePort, SystemInfoRead};
use sqlx::PgPool;
use std::sync::Arc;

/// 系统信息 db_ok：SELECT 1 保活探测（GET /api/system/info）。
pub struct PgSystemInfo {
    pool: PgPool,
}

impl PgSystemInfo {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl SystemInfoRead for PgSystemInfo {
    async fn ping(&self) -> anyhow::Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}

/// raw 层清空：DELETE FROM kline_raw（POST /api/system/purge-raw；危险操作）。
/// 仅 raw 层（kline_raw），accurate 层（kline_accurate）不动。
pub struct PgRawPurge {
    pool: PgPool,
}

impl PgRawPurge {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl RawPurgePort for PgRawPurge {
    async fn purge_raw(&self) -> anyhow::Result<u64> {
        let res = sqlx::query("DELETE FROM kline_raw").execute(&self.pool).await?;
        Ok(res.rows_affected())
    }
}

/// 便捷构造（app bin / 集成测试装配用）。
pub fn system_info(pool: PgPool) -> Arc<dyn SystemInfoRead> {
    Arc::new(PgSystemInfo::new(pool))
}

pub fn raw_purge(pool: PgPool) -> Arc<dyn RawPurgePort> {
    Arc::new(PgRawPurge::new(pool))
}
