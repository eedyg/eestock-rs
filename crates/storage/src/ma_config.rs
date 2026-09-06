//! 行情看板 MA 可配置端口实现（后端 W1；**非 tangle 手写**，契约描述见 design/04-storage/schema.md §4.3.7）。
//! 实现 `domain::ports::MaConfigStore`（PgPool；ma_config 表，迁移 0015）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；web 只依赖 domain::ports::MaConfigStore。
//! 语义：单行配置（id 恒 1）存 `ma_windows int4[]`（默认 [5,10,20]）；归一化（升序去重）在 web/dto
//! 层完成，本层只持久化归一化结果并原样返回。应用面自有表（数据面不读写，ADR-017 不违）。
//! 主图+宫格应用 MA 窗口配置；回测弹窗不动（回测周期/参数不扩展）。

use anyhow::Result;
use async_trait::async_trait;
use domain::ports::MaConfigStore;
use sqlx::PgPool;

/// 默认 MA 窗口（前端硬编码 [5,10,20] 改由 DB 持久化配置驱动；表空/未初始化时兜底）。
pub const DEFAULT_MA_WINDOWS: &[i32] = &[5, 10, 20];

pub struct PgMaConfigStore {
    pool: PgPool,
}

impl PgMaConfigStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

/// 单行配置读（id 恒 1；表空 → None → 默认）。
const GET_SQL: &str = "SELECT ma_windows FROM ma_config WHERE id = 1";

#[async_trait]
impl MaConfigStore for PgMaConfigStore {
    /// 读当前 MA 窗口（升序去重归一化；表空/无行 → 默认 [5,10,20]，不抛错）。
    async fn get(&self) -> Result<Vec<i32>> {
        let row: Option<(Vec<i32>,)> = sqlx::query_as(GET_SQL)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(|r| r.0).unwrap_or_else(|| DEFAULT_MA_WINDOWS.to_vec()))
    }

    /// 写回归一化后的 MA 窗口（升序去重；web 层已校验），返回写回后的窗口列表。
    /// `INSERT ... ON CONFLICT (id)` 幂等：首次建行、后随次覆盖（updated_at=now()）。
    async fn set(&self, windows: &[i32]) -> Result<Vec<i32>> {
        sqlx::query(
            "INSERT INTO ma_config (id, ma_windows) VALUES (1, $1) \
             ON CONFLICT (id) DO UPDATE SET ma_windows = EXCLUDED.ma_windows, updated_at = now()")
            .bind(windows.to_vec()) // int4[] 数组列，sqlx 支持 Vec<i32> 映射
            .execute(&self.pool).await?;
        Ok(windows.to_vec())
    }
}
