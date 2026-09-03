// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/src/daily.rs>>[init]
//! 日增量同步定时任务（数据面内置）。纯逻辑可测（注入 Clock / mock Provider / 内存 Store）。

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use domain::ports::{Clock, ErrKind, EventSink, HealthEvent};
use domain::provider::{HistoricalDataProvider, ProviderError};
use domain::types::*;
use domain::tz::cst_to_utc;
use domain::tz::utc_to_cst;
use std::sync::Arc;

pub const RUN_HOUR: u32 = 15;
pub const RUN_MINUTE: u32 = 30;
pub const MAX_ATTEMPTS: u32 = 3;

/// 下次触发时刻：严格晚于 now 的最近一个工作日 15:30 CST（Wave 0 日历=仅工作日）。
pub fn next_run_after(now: DateTime<Utc>) -> DateTime<Utc> {
    let mut date = utc_to_cst(now).date();
    for _ in 0..10 {
        let wd = date.weekday();
        if !matches!(wd, chrono::Weekday::Sat | chrono::Weekday::Sun) {
            let run = cst_to_utc(date.and_hms_opt(RUN_HOUR, RUN_MINUTE, 0).expect("valid hms"));
            if run > now { return run; }
        }
        date += Duration::days(1);
    }
    unreachable!("10 天内必有工作日")
}

/// 退避档：base ×2^n（attempt 0-based），封顶 10min。默认 base 60s。
pub fn retry_backoff(base: std::time::Duration, attempt: u32) -> std::time::Duration {
    (base * 2u32.pow(attempt.min(4))).min(std::time::Duration::from_secs(600))
}

/// 日增量存储端口（测试可内存实现；生产 = PgDailyStore）。
#[async_trait::async_trait]
pub trait DailyStore: Send + Sync {
    async fn checkpoint(&self, code: &str) -> anyhow::Result<Option<NaiveDate>>;
    /// 落 accurate + 推进 checkpoint 到 synced_through。返回 upsert 行数。
    async fn save(&self, code: &str, bars: &[Bar], synced_through: NaiveDate) -> anyhow::Result<u64>;
    async fn enabled_codes(&self) -> anyhow::Result<Vec<String>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DailyOutcome {
    Synced { codes: usize, bars: usize },
    /// 任一 code 重试耗尽（其余已续跑）；RateLimited 整轮中止也归此。
    Failed,
}

pub struct DailySync {
    provider: Arc<dyn HistoricalDataProvider>,
    store: Arc<dyn DailyStore>,
    sink: Arc<dyn EventSink>,
    clock: Arc<dyn Clock>,
    backoff_base: std::time::Duration,
}

impl DailySync {
    pub fn new(provider: Arc<dyn HistoricalDataProvider>, store: Arc<dyn DailyStore>,
               sink: Arc<dyn EventSink>, clock: Arc<dyn Clock>) -> Self {
        Self::with_backoff(provider, store, sink, clock, std::time::Duration::from_secs(60))
    }

    /// 测试可注入零退避。
    pub fn with_backoff(provider: Arc<dyn HistoricalDataProvider>, store: Arc<dyn DailyStore>,
                        sink: Arc<dyn EventSink>, clock: Arc<dyn Clock>,
                        backoff_base: std::time::Duration) -> Self {
        Self { provider, store, sink, clock, backoff_base }
    }

    async fn emit(&self, ok: bool, latency_ms: Option<u32>, err: Option<ErrKind>, code: Option<&str>) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: SourceId::Tushare, ok, latency_ms, err_kind: err,
            code: code.map(|c| Code(c.to_string())), trace_id: Some(new_trace_id()),
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(error = %e, "tushare daily event emit failed");
        }
    }

    /// 单 code 增量：[checkpoint+1日, 今日]（已最新 → 0）。
    async fn sync_code(&self, code: &str, today: NaiveDate) -> Result<usize, ProviderError> {
        let cp = self.store.checkpoint(code).await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        let start = crate::sync::resume_from(cp);
        if start > today { return Ok(0); }
        let bars = self.provider.fetch_history(
            &Code(code.to_string()), Period::M1,
            cst_to_utc(start.and_hms_opt(0, 0, 0).expect("valid hms")),
            cst_to_utc(today.and_hms_opt(15, 0, 0).expect("valid hms"))).await?;
        let n = bars.len();
        self.store.save(code, &bars, today).await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        Ok(n)
    }

    /// 单轮：逐 code 增量，失败指数退避重试 MAX_ATTEMPTS 次；RateLimited 整轮中止。
    pub async fn run(&self) -> DailyOutcome {
        let today = utc_to_cst(self.clock.now()).date();
        let codes = match self.store.enabled_codes().await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "tushare daily: read symbols failed");
                self.emit(false, None, Some(ErrKind::Http), None).await;
                return DailyOutcome::Failed;
            }
        };
        let mut total_bars = 0usize;
        let mut done = 0usize;
        let mut failed = false;
        for code in &codes {
            let mut attempt = 0u32;
            loop {
                let t0 = std::time::Instant::now();
                match self.sync_code(code, today).await {
                    Ok(n) => {
                        self.emit(true, Some(t0.elapsed().as_millis() as u32), None, Some(code)).await;
                        total_bars += n;
                        done += 1;
                        break;
                    }
                    Err(ProviderError::RateLimited) => {
                        // quota 感知：整轮中止，checkpoint 已逐 code 落库（§5 口径）
                        self.emit(false, None, Some(ErrKind::RateLimited), Some(code)).await;
                        tracing::error!(code, "tushare daily: rate limited, abort round");
                        return DailyOutcome::Failed;
                    }
                    Err(e) => {
                        attempt += 1;
                        let kind = match &e {
                            ProviderError::Timeout => ErrKind::Timeout,
                            ProviderError::Parse(_) => ErrKind::Parse,
                            _ => ErrKind::Http,
                        };
                        self.emit(false, None, Some(kind), Some(code)).await;
                        if attempt >= MAX_ATTEMPTS {
                            tracing::error!(code, attempts = attempt, "tushare daily: retries exhausted, skip code");
                            failed = true;
                            break;
                        }
                        let wait = retry_backoff(self.backoff_base, attempt - 1);
                        tracing::warn!(code, attempt, wait_ms = wait.as_millis() as u64,
                            error = %e, "tushare daily: retry after backoff");
                        tokio::time::sleep(wait).await;
                    }
                }
            }
        }
        if failed { DailyOutcome::Failed } else { DailyOutcome::Synced { codes: done, bars: total_bars } }
    }
}

/// 生产 Store：复用 storage 准确层（upsert + sync_checkpoints）与 symbols 表。
pub struct PgDailyStore {
    pool: sqlx::PgPool,
}

impl PgDailyStore {
    pub fn new(pool: sqlx::PgPool) -> Self { Self { pool } }
}

#[async_trait::async_trait]
impl DailyStore for PgDailyStore {
    async fn checkpoint(&self, code: &str) -> anyhow::Result<Option<NaiveDate>> {
        storage::accurate::get_checkpoint(&self.pool, code, "M1").await
    }

    async fn save(&self, code: &str, bars: &[Bar], synced_through: NaiveDate) -> anyhow::Result<u64> {
        let n = storage::accurate::AccurateWriter::new(self.pool.clone()).upsert_batch(bars).await?;
        storage::accurate::set_checkpoint(&self.pool, code, "M1", synced_through).await?;
        Ok(n)
    }

    async fn enabled_codes(&self) -> anyhow::Result<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT code FROM symbols WHERE enabled ORDER BY code")
            .fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }
}

/// 定时循环（薄胶合）：睡到下一触发点 → 跑一轮 → 循环。
pub async fn run_forever(sync: Arc<DailySync>, clock: Arc<dyn Clock>) {
    loop {
        let next = next_run_after(clock.now());
        let wait = (next - clock.now()).to_std().unwrap_or(std::time::Duration::ZERO);
        tracing::info!(next_run = %next, wait_secs = wait.as_secs(), "tushare daily scheduled");
        tokio::time::sleep(wait).await;
        let outcome = sync.run().await;
        tracing::info!(?outcome, "tushare daily round done");
    }
}
// ~/~ end
