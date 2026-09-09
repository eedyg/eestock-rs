//! 策略 Registry 存储端口实现（12-strategy-system / P2a，**非 tangle 手写**，契约描述见 design/04-storage/schema.md §4.3.13）。
//! 实现 `domain::ports::StrategyStore`（PgPool；strategy/strategy_version 表，迁移 0022）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；application/web 经端口读写，不依赖 sqlx。
//!
//! 口径：
//! - `catalog`：`DISTINCT ON (s.id)` 取每策略**最新 published 版本**；level 过滤为 at-least 语义
//!   （权限阶梯 backtest_ok ≤ sim_ok ≤ live_approved，SQL 侧按级别集合展开）。
//! - `update_draft` / `mark_published` / `set_status` 均条件更新，0 行 → `Ok(None)`；
//!   流转合法性由 application 层经 `domain::strategy_state` 校验，published 不可变由 DB trigger 兜底。
//! - `mark_published` **乐观并发（TOCTOU 防护）**：`WHERE id=$1 AND status='draft' AND
//!   code=$expected_code`（expected_code = application 层冒烟通过的原文）；0 行 → `Ok(None)` → 409。
//! - `update_draft` 命中时同事务推进 `strategy.updated_at`（与 `create_version` 对齐）。

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{
    CatalogEntry, NewStrategy, NewStrategyVersion, StrategyManageItem,
    StrategyManagePublishedSummary, StrategyManageVersionSummary, StrategyRow, StrategyStore,
    StrategyVersionRow,
};
use domain::strategy_state::{ApprovalLevel, StrategyKind, StrategyStatus};
use sqlx::PgPool;

/// strategy 行元组（id,name,description,kind,created_by,created_at,updated_at）。
type StrategyTuple = (String, String, String, String, String, DateTime<Utc>, DateTime<Utc>);

/// strategy_version 行元组
/// （id,strategy_id,version,code,params_schema,sha256,status,approval_level,created_at,published_at）。
type VersionTuple = (
    String, String, i32, String, serde_json::Value, String, String, String,
    DateTime<Utc>, Option<DateTime<Utc>>,
);

fn strategy_from_tuple(t: StrategyTuple) -> StrategyRow {
    StrategyRow {
        id: t.0,
        name: t.1,
        description: t.2,
        kind: StrategyKind::parse(&t.3).unwrap_or(StrategyKind::Strategy),
        created_by: t.4,
        created_at: t.5,
        updated_at: t.6,
    }
}

fn version_from_tuple(t: VersionTuple) -> StrategyVersionRow {
    StrategyVersionRow {
        id: t.0,
        strategy_id: t.1,
        version: t.2,
        code: t.3,
        params_schema: t.4,
        sha256: t.5,
        status: StrategyStatus::parse(&t.6).unwrap_or(StrategyStatus::Draft),
        approval_level: ApprovalLevel::parse(&t.7).unwrap_or(ApprovalLevel::BacktestOk),
        created_at: t.8,
        published_at: t.9,
    }
}

const STRATEGY_COLS: &str = "id, name, description, kind, created_by, created_at, updated_at";
const VERSION_COLS: &str = "id, strategy_id, version, code, params_schema, sha256, status, \
                            approval_level, created_at, published_at";
/// 联表查询的版本限定列（两表同名列 id/created_at 需表别名消歧）。
const VERSION_COLS_V: &str = "v.id, v.strategy_id, v.version, v.code, v.params_schema, v.sha256, \
                              v.status, v.approval_level, v.created_at, v.published_at";

/// catalog 联表行（17 列超出 sqlx 元组 FromRow 上限；workspace sqlx 未启 macros feature，
/// 手写 FromRow 实现 + 列别名消歧）。
struct CatalogJoinRow {
    s_id: String,
    s_name: String,
    s_description: String,
    s_kind: String,
    s_created_by: String,
    s_created_at: DateTime<Utc>,
    s_updated_at: DateTime<Utc>,
    v_id: String,
    v_strategy_id: String,
    v_version: i32,
    v_code: String,
    v_params_schema: serde_json::Value,
    v_sha256: String,
    v_status: String,
    v_approval_level: String,
    v_created_at: DateTime<Utc>,
    v_published_at: Option<DateTime<Utc>>,
}

impl<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> for CatalogJoinRow {
    fn from_row(row: &'r sqlx::postgres::PgRow) -> std::result::Result<Self, sqlx::Error> {
        use sqlx::Row;
        Ok(Self {
            s_id: row.try_get("s_id")?,
            s_name: row.try_get("s_name")?,
            s_description: row.try_get("s_description")?,
            s_kind: row.try_get("s_kind")?,
            s_created_by: row.try_get("s_created_by")?,
            s_created_at: row.try_get("s_created_at")?,
            s_updated_at: row.try_get("s_updated_at")?,
            v_id: row.try_get("v_id")?,
            v_strategy_id: row.try_get("v_strategy_id")?,
            v_version: row.try_get("v_version")?,
            v_code: row.try_get("v_code")?,
            v_params_schema: row.try_get("v_params_schema")?,
            v_sha256: row.try_get("v_sha256")?,
            v_status: row.try_get("v_status")?,
            v_approval_level: row.try_get("v_approval_level")?,
            v_created_at: row.try_get("v_created_at")?,
            v_published_at: row.try_get("v_published_at")?,
        })
    }
}

impl CatalogJoinRow {
    fn into_entry(self) -> CatalogEntry {
        CatalogEntry {
            strategy: StrategyRow {
                id: self.s_id,
                name: self.s_name,
                description: self.s_description,
                kind: StrategyKind::parse(&self.s_kind).unwrap_or(StrategyKind::Strategy),
                created_by: self.s_created_by,
                created_at: self.s_created_at,
                updated_at: self.s_updated_at,
            },
            version: StrategyVersionRow {
                id: self.v_id,
                strategy_id: self.v_strategy_id,
                version: self.v_version,
                code: self.v_code,
                params_schema: self.v_params_schema,
                sha256: self.v_sha256,
                status: StrategyStatus::parse(&self.v_status).unwrap_or(StrategyStatus::Draft),
                approval_level: ApprovalLevel::parse(&self.v_approval_level)
                    .unwrap_or(ApprovalLevel::BacktestOk),
                created_at: self.v_created_at,
                published_at: self.v_published_at,
            },
        }
    }
}

/// manage_list 联表行（18 列超出 sqlx 元组 FromRow 上限；与 CatalogJoinRow 同模式手写 FromRow）。
/// 三段 LATERAL 聚合：版本计数 / 最新版本（任意状态）/ 最新 published——一查询聚合，无 N+1。
struct ManageJoinRow {
    s_id: String,
    s_name: String,
    s_description: String,
    s_kind: String,
    s_created_by: String,
    s_created_at: DateTime<Utc>,
    s_updated_at: DateTime<Utc>,
    version_count: i64,
    lv_id: Option<String>,
    lv_version: Option<i32>,
    lv_status: Option<String>,
    lv_approval_level: Option<String>,
    lv_sha256: Option<String>,
    lv_created_at: Option<DateTime<Utc>>,
    lv_published_at: Option<DateTime<Utc>>,
    lp_id: Option<String>,
    lp_version: Option<i32>,
    lp_approval_level: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> for ManageJoinRow {
    fn from_row(row: &'r sqlx::postgres::PgRow) -> std::result::Result<Self, sqlx::Error> {
        use sqlx::Row;
        Ok(Self {
            s_id: row.try_get("s_id")?,
            s_name: row.try_get("s_name")?,
            s_description: row.try_get("s_description")?,
            s_kind: row.try_get("s_kind")?,
            s_created_by: row.try_get("s_created_by")?,
            s_created_at: row.try_get("s_created_at")?,
            s_updated_at: row.try_get("s_updated_at")?,
            version_count: row.try_get("version_count")?,
            lv_id: row.try_get("lv_id")?,
            lv_version: row.try_get("lv_version")?,
            lv_status: row.try_get("lv_status")?,
            lv_approval_level: row.try_get("lv_approval_level")?,
            lv_sha256: row.try_get("lv_sha256")?,
            lv_created_at: row.try_get("lv_created_at")?,
            lv_published_at: row.try_get("lv_published_at")?,
            lp_id: row.try_get("lp_id")?,
            lp_version: row.try_get("lp_version")?,
            lp_approval_level: row.try_get("lp_approval_level")?,
        })
    }
}

impl ManageJoinRow {
    fn into_item(self) -> StrategyManageItem {
        // latest_version：lv_id 为 None（零版本策略）→ None；其余列随 LATERAL 同行同生同灭。
        let latest_version = self.lv_id.map(|id| StrategyManageVersionSummary {
            id,
            version: self.lv_version.unwrap_or(0),
            status: StrategyStatus::parse(self.lv_status.as_deref().unwrap_or(""))
                .unwrap_or(StrategyStatus::Draft),
            approval_level: ApprovalLevel::parse(self.lv_approval_level.as_deref().unwrap_or(""))
                .unwrap_or(ApprovalLevel::BacktestOk),
            sha256: self.lv_sha256.unwrap_or_default(),
            created_at: self.lv_created_at.unwrap_or_else(Utc::now),
            published_at: self.lv_published_at,
        });
        let latest_published = self.lp_id.map(|id| StrategyManagePublishedSummary {
            id,
            version: self.lp_version.unwrap_or(0),
            approval_level: ApprovalLevel::parse(self.lp_approval_level.as_deref().unwrap_or(""))
                .unwrap_or(ApprovalLevel::BacktestOk),
        });
        StrategyManageItem {
            id: self.s_id,
            name: self.s_name,
            description: self.s_description,
            kind: StrategyKind::parse(&self.s_kind).unwrap_or(StrategyKind::Strategy),
            created_by: self.s_created_by,
            created_at: self.s_created_at,
            updated_at: self.s_updated_at,
            version_count: self.version_count,
            latest_version,
            latest_published,
        }
    }
}

/// 策略 Registry 存储：strategy/strategy_version（迁移 0022）。
pub struct PgStrategyStore {
    pool: PgPool,
}

impl PgStrategyStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl StrategyStore for PgStrategyStore {
    async fn create_strategy(&self, s: &NewStrategy) -> Result<StrategyRow> {
        let row: StrategyTuple = sqlx::query_as(&format!(
            "INSERT INTO strategy (id, name, description, kind, created_by) \
             VALUES ($1, $2, $3, $4, $5) RETURNING {STRATEGY_COLS}"))
            .bind(&s.id).bind(&s.name).bind(&s.description)
            .bind(s.kind.as_str()).bind(&s.created_by)
            .fetch_one(&self.pool).await?;
        Ok(strategy_from_tuple(row))
    }

    async fn get_strategy(&self, id: &str) -> Result<Option<StrategyRow>> {
        let row: Option<StrategyTuple> = sqlx::query_as(&format!(
            "SELECT {STRATEGY_COLS} FROM strategy WHERE id = $1"))
            .bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(strategy_from_tuple))
    }

    async fn count_strategies(&self) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM strategy")
            .fetch_one(&self.pool).await?;
        Ok(n)
    }

    async fn catalog(
        &self,
        level: Option<ApprovalLevel>,
        kind: Option<StrategyKind>,
    ) -> Result<Vec<CatalogEntry>> {
        // level at-least 语义 → 级别集合展开（None = 不过滤，等价 backtest_ok 全集）。
        let levels: Vec<&str> = match level {
            None | Some(ApprovalLevel::BacktestOk) => {
                vec!["backtest_ok", "sim_ok", "live_approved"]
            }
            Some(ApprovalLevel::SimOk) => vec!["sim_ok", "live_approved"],
            Some(ApprovalLevel::LiveApproved) => vec!["live_approved"],
        };
        // DISTINCT ON (s.id)：每策略取版本号最大的 published 版本。
        let rows: Vec<CatalogJoinRow> = sqlx::query_as(
            "SELECT DISTINCT ON (s.id) \
                 s.id AS s_id, s.name AS s_name, s.description AS s_description, \
                 s.kind AS s_kind, s.created_by AS s_created_by, \
                 s.created_at AS s_created_at, s.updated_at AS s_updated_at, \
                 v.id AS v_id, v.strategy_id AS v_strategy_id, v.version AS v_version, \
                 v.code AS v_code, v.params_schema AS v_params_schema, v.sha256 AS v_sha256, \
                 v.status AS v_status, v.approval_level AS v_approval_level, \
                 v.created_at AS v_created_at, v.published_at AS v_published_at \
             FROM strategy s \
             JOIN strategy_version v ON v.strategy_id = s.id AND v.status = 'published' \
             WHERE v.approval_level = ANY($1) \
               AND ($2::text IS NULL OR s.kind = $2) \
             ORDER BY s.id, v.version DESC")
            .bind(&levels)
            .bind(kind.map(|k| k.as_str()))
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(CatalogJoinRow::into_entry).collect())
    }

    async fn create_version(&self, v: &NewStrategyVersion) -> Result<StrategyVersionRow> {
        let mut tx = self.pool.begin().await?;
        let row: VersionTuple = sqlx::query_as(&format!(
            "INSERT INTO strategy_version (id, strategy_id, version, code, params_schema, sha256) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING {VERSION_COLS}"))
            .bind(&v.id).bind(&v.strategy_id).bind(v.version)
            .bind(&v.code).bind(&v.params_schema).bind(&v.sha256)
            .fetch_one(&mut *tx).await?;
        // 策略 updated_at 随新版本推进（列表排序/展示口径）。
        sqlx::query("UPDATE strategy SET updated_at = now() WHERE id = $1")
            .bind(&v.strategy_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(version_from_tuple(row))
    }

    async fn get_version(&self, id: &str) -> Result<Option<StrategyVersionRow>> {
        let row: Option<VersionTuple> = sqlx::query_as(&format!(
            "SELECT {VERSION_COLS} FROM strategy_version WHERE id = $1"))
            .bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(version_from_tuple))
    }

    async fn find_version_by_name_sha(
        &self,
        name: &str,
        sha256: &str,
    ) -> Result<Option<StrategyVersionRow>> {
        let row: Option<VersionTuple> = sqlx::query_as(&format!(
            "SELECT {VERSION_COLS_V} FROM strategy_version v \
             JOIN strategy s ON s.id = v.strategy_id \
             WHERE s.name = $1 AND v.sha256 = $2 \
             ORDER BY v.version DESC LIMIT 1"))
            .bind(name).bind(sha256).fetch_optional(&self.pool).await?;
        Ok(row.map(version_from_tuple))
    }

    async fn list_versions(&self, strategy_id: &str) -> Result<Vec<StrategyVersionRow>> {
        let rows: Vec<VersionTuple> = sqlx::query_as(&format!(
            "SELECT {VERSION_COLS} FROM strategy_version \
             WHERE strategy_id = $1 ORDER BY version ASC"))
            .bind(strategy_id).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(version_from_tuple).collect())
    }

    async fn next_version_number(&self, strategy_id: &str) -> Result<i32> {
        let (n,): (Option<i32>,) = sqlx::query_as(
            "SELECT max(version) FROM strategy_version WHERE strategy_id = $1")
            .bind(strategy_id).fetch_one(&self.pool).await?;
        Ok(n.unwrap_or(0) + 1)
    }

    async fn update_draft(
        &self,
        id: &str,
        code: &str,
        params_schema: &serde_json::Value,
        sha256: &str,
    ) -> Result<Option<StrategyVersionRow>> {
        // 仅 draft 原地更新；published 行即使绕过应用层也会被 trigger 拦（双保险）。
        // 命中时同事务推进 strategy.updated_at（与 create_version 对齐，NIT-1）。
        let mut tx = self.pool.begin().await?;
        let row: Option<VersionTuple> = sqlx::query_as(&format!(
            "UPDATE strategy_version SET code = $2, params_schema = $3, sha256 = $4 \
             WHERE id = $1 AND status = 'draft' RETURNING {VERSION_COLS}"))
            .bind(id).bind(code).bind(params_schema).bind(sha256)
            .fetch_optional(&mut *tx).await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(None);
        };
        sqlx::query("UPDATE strategy SET updated_at = now() WHERE id = $1")
            .bind(&row.1).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(version_from_tuple(row)))
    }

    async fn mark_published(
        &self,
        id: &str,
        expected_code: &str,
        sha256: &str,
        params_schema: &serde_json::Value,
        published_at: DateTime<Utc>,
    ) -> Result<Option<StrategyVersionRow>> {
        // 乐观条件（TOCTOU 防护）：仅当行仍为 draft 且 code 未被并发改写（= 冒烟过的原文）才定格；
        // 0 行 → Ok(None)（application 映射 409）。
        let row: Option<VersionTuple> = sqlx::query_as(&format!(
            "UPDATE strategy_version \
             SET status = 'published', sha256 = $3, params_schema = $4, published_at = $5 \
             WHERE id = $1 AND status = 'draft' AND code = $2 RETURNING {VERSION_COLS}"))
            .bind(id).bind(expected_code).bind(sha256).bind(params_schema).bind(published_at)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(version_from_tuple))
    }

    async fn set_status(
        &self,
        id: &str,
        status: StrategyStatus,
    ) -> Result<Option<StrategyVersionRow>> {
        let row: Option<VersionTuple> = sqlx::query_as(&format!(
            "UPDATE strategy_version SET status = $2 WHERE id = $1 RETURNING {VERSION_COLS}"))
            .bind(id).bind(status.as_str())
            .fetch_optional(&self.pool).await?;
        Ok(row.map(version_from_tuple))
    }

    // P2b：manage 管理列表——全部策略（含仅 draft / 零版本），三段 LATERAL 一查询聚合（无 N+1）：
    // ① 版本计数；② 版本号最大版本（任意状态）；③ 最新 published。
    async fn manage_list(&self, kind: Option<StrategyKind>) -> Result<Vec<StrategyManageItem>> {
        let rows: Vec<ManageJoinRow> = sqlx::query_as(
            "SELECT s.id AS s_id, s.name AS s_name, s.description AS s_description, \
                 s.kind AS s_kind, s.created_by AS s_created_by, \
                 s.created_at AS s_created_at, s.updated_at AS s_updated_at, \
                 vc.cnt AS version_count, \
                 lv.id AS lv_id, lv.version AS lv_version, lv.status AS lv_status, \
                 lv.approval_level AS lv_approval_level, lv.sha256 AS lv_sha256, \
                 lv.created_at AS lv_created_at, lv.published_at AS lv_published_at, \
                 lp.id AS lp_id, lp.version AS lp_version, lp.approval_level AS lp_approval_level \
             FROM strategy s \
             LEFT JOIN LATERAL ( \
                 SELECT count(*) AS cnt FROM strategy_version v WHERE v.strategy_id = s.id \
             ) vc ON true \
             LEFT JOIN LATERAL ( \
                 SELECT v.id, v.version, v.status, v.approval_level, v.sha256, \
                        v.created_at, v.published_at \
                 FROM strategy_version v WHERE v.strategy_id = s.id \
                 ORDER BY v.version DESC LIMIT 1 \
             ) lv ON true \
             LEFT JOIN LATERAL ( \
                 SELECT v.id, v.version, v.approval_level \
                 FROM strategy_version v WHERE v.strategy_id = s.id AND v.status = 'published' \
                 ORDER BY v.version DESC LIMIT 1 \
             ) lp ON true \
             WHERE ($1::text IS NULL OR s.kind = $1) \
             ORDER BY s.id")
            .bind(kind.map(|k| k.as_str()))
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(ManageJoinRow::into_item).collect())
    }

    // P2b：update_meta——name/description 最终值落库 + updated_at 推进；未知 id → None。
    async fn update_meta(
        &self,
        id: &str,
        name: &str,
        description: &str,
    ) -> Result<Option<StrategyRow>> {
        let row: Option<StrategyTuple> = sqlx::query_as(&format!(
            "UPDATE strategy SET name = $2, description = $3, updated_at = now() \
             WHERE id = $1 RETURNING {STRATEGY_COLS}"))
            .bind(id).bind(name).bind(description)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(strategy_from_tuple))
    }
}
