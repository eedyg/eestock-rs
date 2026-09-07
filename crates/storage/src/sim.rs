//! 模拟实盘会话存储端口实现（L1 sim-live，**非 tangle 手写**，契约描述见 design/04-storage/schema.md §4.3.10）。
//! 实现 `domain::ports::SimSessionStore`（PgPool）。
//! 分层：storage（Infrastructure）只依赖 domain 端口；simlive/application 经端口读写，不依赖 sqlx。

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{
    NewSimSession, NewSimTrade, SimSessionResult, SimSessionStatus, SimSessionStore, SimSessionView,
    SimPositionRow,
};
use sqlx::PgPool;

/// simsession 行元组（id,name,cash_init,strategy_set,stock_set,period,start_ts,end_ts,status,source）。
type SessionRow = (
    String, String, f64, serde_json::Value, serde_json::Value, String,
    DateTime<Utc>, Option<DateTime<Utc>>, String, String,
);

/// 模拟实盘会话存储：simsession/simsession_result/sim_trades/sim_positions（迁移 0018）。
pub struct PgSimSessionStore {
    pool: PgPool,
}

impl PgSimSessionStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl SimSessionStore for PgSimSessionStore {
    async fn create_session(&self, s: &NewSimSession) -> Result<()> {
        sqlx::query(
            "INSERT INTO simsession \
             (id, name, cash_init, strategy_set, stock_set, period, start_ts, status, source) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8)")
            .bind(&s.id).bind(&s.name).bind(s.cash_init)
            .bind(serde_json::to_value(&s.strategy_set)?)
            .bind(serde_json::to_value(&s.stock_set)?)
            .bind(&s.period).bind(s.start_ts).bind(&s.source)
            .execute(&self.pool).await?;
        Ok(())
    }

    async fn get_session(&self, id: &str) -> Result<Option<SimSessionView>> {
        let row: Option<SessionRow> =
            sqlx::query_as(
                "SELECT id, name, cash_init, strategy_set, stock_set, period, start_ts, end_ts, status, source \
                 FROM simsession WHERE id = $1")
                .bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(row_to_view))
    }

    async fn list_sessions(&self) -> Result<Vec<SimSessionView>> {
        let rows: Vec<SessionRow> =
            sqlx::query_as(
                "SELECT id, name, cash_init, strategy_set, stock_set, period, start_ts, end_ts, status, source \
                 FROM simsession ORDER BY start_ts DESC")
                .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(row_to_view).collect())
    }

    async fn append_trade(&self, t: &NewSimTrade) -> Result<()> {
        sqlx::query(
            "INSERT INTO sim_trades (session_id, code, side, qty, price, ts, fee, source) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
            .bind(&t.session_id).bind(&t.code).bind(&t.side)
            .bind(t.qty).bind(t.price).bind(t.ts).bind(t.fee).bind(&t.source)
            .execute(&self.pool).await?;
        Ok(())
    }

    async fn update_positions(&self, session_id: &str, positions: &[SimPositionRow]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM sim_positions WHERE session_id = $1")
            .bind(session_id).execute(&mut *tx).await?;
        for p in positions {
            sqlx::query(
                "INSERT INTO sim_positions (session_id, code, qty, avg_cost) VALUES ($1, $2, $3, $4)")
                .bind(session_id).bind(&p.code).bind(p.qty).bind(p.avg_cost)
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    async fn mark_end(&self, session_id: &str, end_ts: DateTime<Utc>, result: &SimSessionResult) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        // 置 ended + end_ts（仅 running → ended 可转移）。
        let res = sqlx::query(
            "UPDATE simsession SET status = 'ended', end_ts = $2 WHERE id = $1 AND status = 'running'")
            .bind(session_id).bind(end_ts).execute(&mut *tx).await?;
        if res.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(false);
        }
        // 写结果（幂等 upsert）。
        sqlx::query(
            "INSERT INTO simsession_result (session_id, net_value_json, trades_json, metrics_json) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (session_id) DO UPDATE SET \
                net_value_json = EXCLUDED.net_value_json, \
                trades_json = EXCLUDED.trades_json, \
                metrics_json = EXCLUDED.metrics_json")
            .bind(session_id).bind(&result.net_value).bind(&result.trades).bind(&result.metrics)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    async fn delete_session(&self, session_id: &str) -> Result<bool> {
        let res = sqlx::query("DELETE FROM simsession WHERE id = $1")
            .bind(session_id).execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }
}

/// 行元组 → 会话读模型（列索引须与 SELECT 顺序一一对应）。
fn row_to_view(row: SessionRow) -> SimSessionView {
    let (id, name, cash_init, strategy_set, stock_set, period, start_ts, end_ts, status, source) = row;
    SimSessionView {
        strategy_set: serde_json::from_value(strategy_set).unwrap_or_default(),
        stock_set: serde_json::from_value(stock_set).unwrap_or_default(),
        id, name, cash_init, period, start_ts, end_ts,
        status: SimSessionStatus::parse(&status).unwrap_or(SimSessionStatus::Running),
        source,
    }
}
