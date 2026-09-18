//! 回测工作台存储端口实现（12-strategy-system / P3a，**非 tangle 手写**，契约描述见 design/04-storage/schema.md §4.3.14）。
//! 实现 `domain::ports::StrategyRunStore` + `StrategyPresetStore`（PgPool；迁移 0023）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；application/web 经端口读写，不依赖 sqlx。
//!
//! 口径：
//! - 状态迁移全部**条件更新**（`WHERE status IN (...)`），0 行命中 = 已被并发迁移：
//!   `mark_started`（queued→running 原子认领）/ `mark_succeeded`（running→succeeded + 同事务落结果）/
//!   `mark_failed` / `mark_canceled`（queued/running→终态）。终态不可再迁移。
//! - `update_progress` 仅 running 行生效（终态行静默忽略）。
//! - 列表轻量（不联结果表），排序 created_at DESC, id DESC；结果经 `get_result` 单独取。
//! - `strategy_preset.name` UNIQUE 冲突 → sqlx Err（application/web 映射 409）。
//!
//! ADR-024 P4 / D8（迁移 0027）：
//! - `mark_succeeded` 新语义：新 run 写 `result_format='chunked_v1'` + `trades`/`metrics`，
//!   `per_bar`/`net_value`/`drawdown` 三列写 `[]` **占位**（数据在 `strategy_run_bars`，先于 mark_succeeded 写入）。
//! - `append_result_chunk` / `result_chunks` / `result_chunks_in_range` / `result_chunk_count`：分块读写。
//! - 读取路径一律以 `result_format` 判别（`legacy_single` = 旧 run 内联全量，双读**不回填**）。

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{
    NewStrategyPreset, NewStrategyRun, ResultChunk, ResultKind, StrategyPresetRow,
    StrategyPresetStore, StrategyRunFilter, StrategyRunResult, StrategyRunStatus, StrategyRunStore,
    StrategyRunView, RESULT_FORMAT_CHUNKED,
};
use sqlx::PgPool;

/// strategy_run 行元组（13 列）。
type RunTuple = (
    String, String, String, String, DateTime<Utc>, DateTime<Utc>, serde_json::Value, String, f64,
    Option<String>, DateTime<Utc>, Option<DateTime<Utc>>, Option<DateTime<Utc>>,
);

/// strategy_run_result 行元组（5 jsonb 列 + result_format 判别列）。
type ResultTuple = (
    serde_json::Value, serde_json::Value, serde_json::Value, serde_json::Value, serde_json::Value,
    String,
);

/// strategy_run_bars 行元组（kind, seq, ts_from, ts_to, payload）。
type ChunkTuple = (String, i32, DateTime<Utc>, DateTime<Utc>, serde_json::Value);

fn chunk_from_tuple(t: ChunkTuple) -> ResultChunk {
    ResultChunk {
        kind: ResultKind::parse(&t.0).unwrap_or(ResultKind::PerBar),
        seq: t.1,
        ts_from: t.2,
        ts_to: t.3,
        payload: t.4,
    }
}

/// strategy_preset 行元组（5 列）。
type PresetTuple = (String, String, serde_json::Value, DateTime<Utc>, DateTime<Utc>);

/// 从 `config` 快照读 RFC3339 时间字段（ADR-024 P5：requested_* 落 config；旧 run 无该字段 → 回退 effective）。
fn cfg_ts(config: &serde_json::Value, key: &str) -> Option<DateTime<Utc>> {
    config
        .get(key)
        .and_then(|v| serde_json::from_value::<DateTime<Utc>>(v.clone()).ok())
}

fn run_from_tuple(t: RunTuple) -> StrategyRunView {
    let config = t.6;
    // P5：`from_ts`/`to_ts` 存 effective；requested/clamped/预估从 config 快照回读（旧 run 无 → 回退 effective/false）。
    let requested_from = cfg_ts(&config, "requested_from").unwrap_or(t.4);
    let requested_to = cfg_ts(&config, "requested_to").unwrap_or(t.5);
    let clamped = config.get("clamped").and_then(|v| v.as_bool()).unwrap_or(false);
    let clamp_reason = config
        .get("clamp_reason")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let estimated_bars = config.get("estimated_bars").and_then(|v| v.as_i64());
    StrategyRunView {
        id: t.0,
        name: t.1,
        symbol: t.2,
        period: t.3,
        from_ts: t.4,
        to_ts: t.5,
        config,
        status: StrategyRunStatus::parse(&t.7).unwrap_or(StrategyRunStatus::Queued),
        progress: t.8,
        error: t.9,
        created_at: t.10,
        started_at: t.11,
        finished_at: t.12,
        requested_from,
        requested_to,
        clamped,
        clamp_reason,
        estimated_bars,
        // P4 轻量行不内联结果 ⇒ bars_total/result_format 由 `/brief`/`/result` 提供。
        bars_total: None,
        result_format: None,
    }
}

fn preset_from_tuple(t: PresetTuple) -> StrategyPresetRow {
    StrategyPresetRow { id: t.0, name: t.1, config: t.2, created_at: t.3, updated_at: t.4 }
}

const RUN_COLS: &str = "id, name, symbol, period, from_ts, to_ts, config, status, progress, \
                        error, created_at, started_at, finished_at";
const RESULT_COLS: &str =
    "per_bar, trades, net_value, drawdown, metrics, result_format";
const CHUNK_COLS: &str = "kind, seq, ts_from, ts_to, payload";
const PRESET_COLS: &str = "id, name, config, created_at, updated_at";

/// 策略运行存储：strategy_run/strategy_run_result（迁移 0023）。
pub struct PgStrategyRunStore {
    pool: PgPool,
}

impl PgStrategyRunStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl StrategyRunStore for PgStrategyRunStore {
    async fn create_run(&self, run: &NewStrategyRun) -> Result<StrategyRunView> {
        let row: RunTuple = sqlx::query_as(&format!(
            "INSERT INTO strategy_run (id, name, symbol, period, from_ts, to_ts, config) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {RUN_COLS}"))
            .bind(&run.id).bind(&run.name).bind(&run.symbol).bind(&run.period)
            .bind(run.from_ts).bind(run.to_ts).bind(&run.config)
            .fetch_one(&self.pool).await?;
        Ok(run_from_tuple(row))
    }

    async fn get_run(&self, id: &str) -> Result<Option<StrategyRunView>> {
        let row: Option<RunTuple> = sqlx::query_as(&format!(
            "SELECT {RUN_COLS} FROM strategy_run WHERE id = $1"))
            .bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(run_from_tuple))
    }

    async fn list_runs(&self, filter: &StrategyRunFilter) -> Result<Vec<StrategyRunView>> {
        let rows: Vec<RunTuple> = sqlx::query_as(&format!(
            "SELECT {RUN_COLS} FROM strategy_run \
             WHERE ($1::text IS NULL OR status = $1) \
             ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3"))
            .bind(filter.status.map(|s| s.as_str()))
            .bind(filter.limit).bind(filter.offset)
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(run_from_tuple).collect())
    }

    async fn mark_started(&self, id: &str, started_at: DateTime<Utc>) -> Result<bool> {
        // 原子认领：仅 queued 行可转 running（0 行 = 已被并发取消/启动）。
        let res = sqlx::query(
            "UPDATE strategy_run SET status = 'running', started_at = $2 \
             WHERE id = $1 AND status = 'queued'")
            .bind(id).bind(started_at)
            .execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }

    async fn update_progress(&self, id: &str, progress: f64) -> Result<()> {
        sqlx::query(
            "UPDATE strategy_run SET progress = $2 WHERE id = $1 AND status = 'running'")
            .bind(id).bind(progress)
            .execute(&self.pool).await?;
        Ok(())
    }

    async fn mark_succeeded(
        &self,
        id: &str,
        result: &StrategyRunResult,
        finished_at: DateTime<Utc>,
    ) -> Result<bool> {
        // 事务：INSERT 结果 + UPDATE run（仅 running 行；0 行 → rollback，结果不落库）。
        // ADR-024 P4 / D8：新 run 一律写 `result_format='chunked_v1'`——per_bar/net_value/drawdown
        //  三列写 `[]` **占位**（数据在 strategy_run_bars 分块表，已先于本调用写入）；
        //  读取路径一律以 result_format 判别，禁止把占位当数据。
        let mut tx = self.pool.begin().await?;
        let res = sqlx::query(
            "UPDATE strategy_run SET status = 'succeeded', progress = 1, finished_at = $2 \
             WHERE id = $1 AND status = 'running'")
            .bind(id).bind(finished_at)
            .execute(&mut *tx).await?;
        if res.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO strategy_run_result \
             (run_id, per_bar, trades, net_value, drawdown, metrics, result_format) \
             VALUES ($1, '[]'::jsonb, $2, '[]'::jsonb, '[]'::jsonb, $3, $4)")
            .bind(id)
            .bind(&result.trades).bind(&result.metrics).bind(RESULT_FORMAT_CHUNKED)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    async fn mark_failed(&self, id: &str, error: &str, finished_at: DateTime<Utc>) -> Result<bool> {
        let res = sqlx::query(
            "UPDATE strategy_run SET status = 'failed', error = $2, finished_at = $3 \
             WHERE id = $1 AND status IN ('queued','running')")
            .bind(id).bind(error).bind(finished_at)
            .execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }

    async fn mark_canceled(&self, id: &str, finished_at: DateTime<Utc>) -> Result<Option<bool>> {
        // 先探测存在性（区分 404 None 与 409 Some(false)）。
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT status FROM strategy_run WHERE id = $1")
            .bind(id).fetch_optional(&self.pool).await?;
        let Some((status,)) = exists else { return Ok(None) };
        if StrategyRunStatus::parse(&status).is_none_or(|s| s.is_terminal()) {
            return Ok(Some(false));
        }
        let res = sqlx::query(
            "UPDATE strategy_run SET status = 'canceled', finished_at = $2 \
             WHERE id = $1 AND status IN ('queued','running')")
            .bind(id).bind(finished_at)
            .execute(&self.pool).await?;
        // TOCTOU：探测与更新之间被并发迁移 → 0 行 → Some(false)。
        Ok(Some(res.rows_affected() > 0))
    }

    async fn get_result(&self, run_id: &str) -> Result<Option<StrategyRunResult>> {
        let row: Option<ResultTuple> = sqlx::query_as(&format!(
            "SELECT {RESULT_COLS} FROM strategy_run_result WHERE run_id = $1"))
            .bind(run_id).fetch_optional(&self.pool).await?;
        Ok(row.map(|t| StrategyRunResult {
            per_bar: t.0,
            trades: t.1,
            net_value: t.2,
            drawdown: t.3,
            metrics: t.4,
            result_format: t.5,
        }))
    }

    async fn append_result_chunk(&self, run_id: &str, chunk: &ResultChunk) -> Result<()> {
        // 边跑边写：无状态守卫（取消后已写分块保留——D8：取消不落 succeeded 由 mark_succeeded 守卫保证）。
        sqlx::query(
            "INSERT INTO strategy_run_bars (run_id, kind, seq, ts_from, ts_to, payload) \
             VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(run_id)
            .bind(chunk.kind.as_str())
            .bind(chunk.seq)
            .bind(chunk.ts_from)
            .bind(chunk.ts_to)
            .bind(&chunk.payload)
            .execute(&self.pool).await?;
        Ok(())
    }

    async fn result_chunks(
        &self,
        run_id: &str,
        kind: ResultKind,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<ResultChunk>> {
        let rows: Vec<ChunkTuple> = sqlx::query_as(&format!(
            "SELECT {CHUNK_COLS} FROM strategy_run_bars \
             WHERE run_id = $1 AND kind = $2 ORDER BY seq LIMIT $3 OFFSET $4"))
            .bind(run_id).bind(kind.as_str()).bind(limit).bind(offset)
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(chunk_from_tuple).collect())
    }

    async fn result_chunks_in_range(
        &self,
        run_id: &str,
        kind: ResultKind,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<ResultChunk>> {
        // 返回与 [from, to] **相交的整块**（可能含块外沿，调用方在块内按 ts 精确过滤）。
        let rows: Vec<ChunkTuple> = sqlx::query_as(&format!(
            "SELECT {CHUNK_COLS} FROM strategy_run_bars \
             WHERE run_id = $1 AND kind = $2 AND ts_from <= $4 AND ts_to >= $3 \
             ORDER BY seq"))
            .bind(run_id).bind(kind.as_str()).bind(from).bind(to)
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(chunk_from_tuple).collect())
    }

    async fn result_chunk_count(&self, run_id: &str, kind: ResultKind) -> Result<i64> {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM strategy_run_bars WHERE run_id = $1 AND kind = $2")
            .bind(run_id).bind(kind.as_str())
            .fetch_one(&self.pool).await?;
        Ok(n)
    }
}

/// 组合预设存储：strategy_preset（迁移 0023）。
pub struct PgStrategyPresetStore {
    pool: PgPool,
}

impl PgStrategyPresetStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl StrategyPresetStore for PgStrategyPresetStore {
    async fn create_preset(&self, p: &NewStrategyPreset) -> Result<StrategyPresetRow> {
        let row: PresetTuple = sqlx::query_as(&format!(
            "INSERT INTO strategy_preset (id, name, config) VALUES ($1, $2, $3) RETURNING {PRESET_COLS}"))
            .bind(&p.id).bind(&p.name).bind(&p.config)
            .fetch_one(&self.pool).await?;
        Ok(preset_from_tuple(row))
    }

    async fn get_preset(&self, id: &str) -> Result<Option<StrategyPresetRow>> {
        let row: Option<PresetTuple> = sqlx::query_as(&format!(
            "SELECT {PRESET_COLS} FROM strategy_preset WHERE id = $1"))
            .bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(preset_from_tuple))
    }

    async fn find_preset_by_name(&self, name: &str) -> Result<Option<StrategyPresetRow>> {
        let row: Option<PresetTuple> = sqlx::query_as(&format!(
            "SELECT {PRESET_COLS} FROM strategy_preset WHERE name = $1"))
            .bind(name).fetch_optional(&self.pool).await?;
        Ok(row.map(preset_from_tuple))
    }

    async fn list_presets(&self) -> Result<Vec<StrategyPresetRow>> {
        let rows: Vec<PresetTuple> = sqlx::query_as(&format!(
            "SELECT {PRESET_COLS} FROM strategy_preset ORDER BY created_at ASC, id ASC"))
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(preset_from_tuple).collect())
    }

    async fn update_preset(
        &self,
        id: &str,
        name: &str,
        config: &serde_json::Value,
    ) -> Result<Option<StrategyPresetRow>> {
        let row: Option<PresetTuple> = sqlx::query_as(&format!(
            "UPDATE strategy_preset SET name = $2, config = $3, updated_at = now() \
             WHERE id = $1 RETURNING {PRESET_COLS}"))
            .bind(id).bind(name).bind(config)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(preset_from_tuple))
    }

    async fn delete_preset(&self, id: &str) -> Result<bool> {
        let res = sqlx::query("DELETE FROM strategy_preset WHERE id = $1")
            .bind(id).execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }
}
