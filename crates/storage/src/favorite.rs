//! 看板收藏端口实现（Wave 3 页面①；**非 tangle 手写**，契约描述见 design/04-storage/schema.md §4.3.6）。
//! 实现 `domain::ports::FavoriteStore`（PgPool；favorite_symbols 表，迁移 0013）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；web 只依赖 domain::ports::FavoriteStore。
//! 语义：一键收藏=自动置顶（star → sort_order=max+1）；收藏区拖拽排序（reorder → sort_order=索引）；
//! 仅影响 /api/symbols 的 symbol-list 展示（应用面自有表，数据面不读写，ADR-017 不违）。
//! sort_order 起点 1（首个收藏=1）。

use anyhow::Result;
use async_trait::async_trait;
use domain::ports::{FavoriteItem, FavoriteStore};
use sqlx::PgPool;

pub struct PgFavoriteStore {
    pool: PgPool,
}

impl PgFavoriteStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

/// 全量收藏查询（code + sort_order，按 sort_order 升序）。
const LIST_SQL: &str = "SELECT code, sort_order FROM favorite_symbols ORDER BY sort_order";

#[async_trait]
impl FavoriteStore for PgFavoriteStore {
    /// 全量收藏（按 sort_order 升序）。
    async fn list_favorites(&self) -> Result<Vec<FavoriteItem>> {
        type Row = (String, i32);
        let rows: Vec<Row> = sqlx::query_as(LIST_SQL).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(code, sort_order)| FavoriteItem { code, sort_order }).collect())
    }

    /// 一键收藏（自动置顶）：sort_order = COALESCE(MAX(sort_order),0)+1。
    /// 已存在 → ON CONFLICT DO NOTHING（幂等 Ok，不重复插入）。
    /// code 须为已注册标的——顶层 `WHERE EXISTS` 门控：符号不存在 → 0 行，无插入（FK 不触发）。
    /// 空收藏集时 MAX 为 NULL → COALESCE 0+1 = 1（首个收藏自顶）。
    async fn star(&self, code: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO favorite_symbols (code, sort_order) \
             SELECT $1, COALESCE((SELECT MAX(sort_order) FROM favorite_symbols), 0) + 1 \
             WHERE EXISTS (SELECT 1 FROM symbols WHERE code = $1) \
             ON CONFLICT (code) DO NOTHING")
            .bind(code)
            .execute(&self.pool).await?;
        Ok(())
    }

    /// 取消收藏（不存在收藏 → rows_affected=0，仍 Ok 幂等）。
    async fn unstar(&self, code: &str) -> Result<()> {
        sqlx::query("DELETE FROM favorite_symbols WHERE code = $1")
            .bind(code).execute(&self.pool).await?;
        Ok(())
    }

    /// 批量重排：sort_order = 输入索引（codes 顺序即收藏区展示顺序；可子集）。
    /// 事务内逐行更新（array_position 定位 sort_order）；入参须均为已收藏（web 层经 favorite_map 预检 400）。
    async fn reorder(&self, codes: &[String]) -> Result<()> {
        // 空入参 = 无操作（web 层允许空数组，无收藏命中空重排）。
        if codes.is_empty() { return Ok(()); }
        let mut tx = self.pool.begin().await?;
        for (i, c) in codes.iter().enumerate() {
            sqlx::query("UPDATE favorite_symbols SET sort_order = $2 WHERE code = $1")
                .bind(c).bind((i as i32) + 1)
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// code→sort_order 映射（/api/symbols 展示用：非收藏不在 map）。
    async fn favorite_map(&self) -> Result<std::collections::HashMap<String, i32>> {
        let rows: Vec<(String, i32)> = sqlx::query_as(LIST_SQL).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().collect())
    }
}
