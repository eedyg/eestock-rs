// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/storage/src/alerts.rs>>[init]
//! 告警引擎端口实现（Wave 2 Phase B 加法扩展，ADR-017 授权口径；数据面既有路径零改动）：
//! - PgAlertStore：alert_rules / alert_events（0009；应用面自有表，数据面不读写）
//! - PgAlertEval：评估读输入（events_since / latest_event_of，读 source_health_events）
//!
//! 状态机转移决策在 alert crate（engine.rs），本层仅提供原子原语；CHECK/唯一索引兜底。

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use domain::ports::{
    AlertEvalRead, AlertEvent, AlertFilter, AlertLevel, AlertRule, AlertRulePatch, AlertStatus,
    AlertStore, HealthEventRow,
};
use sqlx::PgPool;

const RULE_COLS: &str = "id, name, level, threshold, duration_minutes, silence_minutes, enabled";
const EVENT_COLS: &str =
    "id, rule_id, level, source, message, status, fire_count, \
     first_fired_at, last_fired_at, acked_at, resolved_at";

type RuleRow = (String, String, String, f64, i32, i32, bool);
type EventRow = (i64, String, String, String, String, String, i32,
                 DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>, Option<DateTime<Utc>>);

fn rule_of((id, name, level, threshold, duration, silence, enabled): RuleRow) -> AlertRule {
    AlertRule {
        id, name,
        level: AlertLevel::parse(&level).expect("alert_rules CHECK 约束保证合法级别"),
        threshold,
        duration_minutes: duration as i64,
        silence_minutes: silence as i64,
        enabled,
    }
}

fn event_of(r: EventRow) -> AlertEvent {
    AlertEvent {
        id: r.0, rule_id: r.1,
        level: AlertLevel::parse(&r.2).expect("alert_events CHECK 约束保证合法级别"),
        source: r.3, message: r.4,
        status: AlertStatus::parse(&r.5).expect("alert_events CHECK 约束保证合法状态"),
        fire_count: r.6 as i64,
        first_fired_at: r.7, last_fired_at: r.8, acked_at: r.9, resolved_at: r.10,
    }
}

/// 告警持久化（alert crate 状态机原语；web REST 数据源）。
pub struct PgAlertStore {
    pool: PgPool,
}

impl PgAlertStore {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

#[async_trait]
impl AlertStore for PgAlertStore {
    async fn list_rules(&self) -> Result<Vec<AlertRule>> {
        let rows: Vec<RuleRow> = sqlx::query_as(
            &format!("SELECT {RULE_COLS} FROM alert_rules ORDER BY id"))
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(rule_of).collect())
    }

    async fn patch_rule(&self, id: &str, patch: &AlertRulePatch) -> Result<Option<AlertRule>> {
        let row: Option<RuleRow> = sqlx::query_as(
            &format!("UPDATE alert_rules SET \
                 threshold = COALESCE($2, threshold), \
                 silence_minutes = COALESCE($3, silence_minutes), \
                 enabled = COALESCE($4, enabled), \
                 updated_at = now() \
             WHERE id = $1 RETURNING {RULE_COLS}"))
            .bind(id).bind(patch.threshold).bind(patch.silence_minutes)
            .bind(patch.enabled)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(rule_of))
    }

    async fn open_incident(&self, rule_id: &str, source: &str) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("SELECT {EVENT_COLS} FROM alert_events \
             WHERE rule_id = $1 AND source = $2 AND resolved_at IS NULL \
             ORDER BY id DESC LIMIT 1"))
            .bind(rule_id).bind(source).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    async fn last_fired_at(&self, rule_id: &str, source: &str) -> Result<Option<DateTime<Utc>>> {
        let (ts,): (Option<DateTime<Utc>>,) = sqlx::query_as(
            "SELECT max(last_fired_at) FROM alert_events WHERE rule_id = $1 AND source = $2")
            .bind(rule_id).bind(source).fetch_one(&self.pool).await?;
        Ok(ts)
    }

    async fn insert_incident(&self, rule_id: &str, level: AlertLevel, source: &str,
                             message: &str, now: DateTime<Utc>) -> Result<AlertEvent> {
        let row: EventRow = sqlx::query_as(
            &format!("INSERT INTO alert_events \
                 (rule_id, level, source, message, first_fired_at, last_fired_at) \
             VALUES ($1, $2, $3, $4, $5, $5) RETURNING {EVENT_COLS}"))
            .bind(rule_id).bind(level.as_str()).bind(source).bind(message).bind(now)
            .fetch_one(&self.pool).await?;
        Ok(event_of(row))
    }

    /// 续触发：计数+1、推进 last_fired_at、回退 triggered 并清 acked_at（新活动需重新确认）。
    async fn refire(&self, id: i64, now: DateTime<Utc>) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("UPDATE alert_events SET \
                 fire_count = fire_count + 1, last_fired_at = $2, \
                 status = 'triggered', acked_at = NULL \
             WHERE id = $1 RETURNING {EVENT_COLS}"))
            .bind(id).bind(now).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    async fn resolve(&self, id: i64, now: DateTime<Utc>) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("UPDATE alert_events SET status = 'resolved', resolved_at = $2 \
             WHERE id = $1 AND resolved_at IS NULL RETURNING {EVENT_COLS}"))
            .bind(id).bind(now).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    /// 仅 triggered 可确认（其余 → None，web 映射 404）。
    async fn ack(&self, id: i64, now: DateTime<Utc>) -> Result<Option<AlertEvent>> {
        let row: Option<EventRow> = sqlx::query_as(
            &format!("UPDATE alert_events SET status = 'acked', acked_at = $2 \
             WHERE id = $1 AND status = 'triggered' RETURNING {EVENT_COLS}"))
            .bind(id).bind(now).fetch_optional(&self.pool).await?;
        Ok(row.map(event_of))
    }

    /// 列表（last_fired_at 降序；$1..$4 全 None = 全量按 $5 截断）。
    async fn list_events(&self, filter: &AlertFilter) -> Result<Vec<AlertEvent>> {
        let rows: Vec<EventRow> = sqlx::query_as(
            &format!("SELECT {EVENT_COLS} FROM alert_events \
             WHERE ($1::text IS NULL OR level = $1) \
               AND ($2::timestamptz IS NULL OR last_fired_at >= $2) \
               AND ($3::timestamptz IS NULL OR last_fired_at < $3) \
               AND ($4::text IS NULL OR source = $4) \
             ORDER BY last_fired_at DESC LIMIT $5"))
            .bind(filter.level.map(|l| l.as_str()))
            .bind(filter.from).bind(filter.to).bind(filter.source.as_deref())
            .bind(filter.limit)
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(event_of).collect())
    }
}

/// 评估读输入（读 source_health_events，ADR-017 应用面只读库）。
pub struct PgAlertEval {
    pool: PgPool,
}

impl PgAlertEval {
    pub fn new(pool: PgPool) -> Self { Self { pool } }
}

type EvRow = (DateTime<Utc>, String, bool, Option<i32>, Option<String>, Option<String>);

fn row_of((ts, source, ok, latency_ms, err_kind, code): EvRow) -> HealthEventRow {
    HealthEventRow { ts, source, ok, latency_ms, err_kind, code }
}

#[async_trait]
impl AlertEvalRead for PgAlertEval {
    async fn events_since(&self, since: DateTime<Utc>) -> Result<Vec<HealthEventRow>> {
        let rows: Vec<EvRow> = sqlx::query_as(
            "SELECT ts, source, ok, latency_ms, err_kind, code \
             FROM source_health_events WHERE ts > $1 ORDER BY ts")
            .bind(since).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(row_of).collect())
    }

    async fn latest_event_of(&self, source: &str) -> Result<Option<HealthEventRow>> {
        let row: Option<EvRow> = sqlx::query_as(
            "SELECT ts, source, ok, latency_ms, err_kind, code \
             FROM source_health_events WHERE source = $1 ORDER BY ts DESC LIMIT 1")
            .bind(source).fetch_optional(&self.pool).await?;
        Ok(row.map(row_of))
    }
}
// ~/~ end
