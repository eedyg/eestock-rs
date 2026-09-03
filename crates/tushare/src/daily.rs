// ~/~ begin <<design/04-storage/02-tushare-sync.md#crates/tushare/src/daily.rs>>[init]
//! 日增量同步定时任务（数据面内置）。纯逻辑可测（注入 Clock / mock Provider / 内存 Store）。

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use domain::ports::{Clock, ErrKind, EventSink, HealthEvent};
use domain::provider::{HistoricalDataProvider, ProviderError};
use domain::types::*;
use domain::tz::cst_to_utc;
use domain::tz::utc_to_cst;
use std::sync::Arc;

pub const MAX_ATTEMPTS: u32 = 3;

/// 三时点调度（用户决策 2026-09-03，§6.2）：每自然日 CST 08:00 / 18:00 / 00:00 各触发一轮完整增量。
/// tushare ETF 历史整理耗时长、收盘后不能立即更新，多次补全直至收敛
/// （前提：准确层 upsert 覆盖语义，后次同步修正前次不完整数据，见 §4 accurate_upsert 测试锁定）。
pub const RUN_TIMES: [(u32, u32); 3] = [(0, 0), (8, 0), (18, 0)];

/// 下次触发时刻：严格晚于 now 的最近一个 CST 08:00/18:00/00:00。
/// 含周末触发（周末轮次目标交易日回退到周五，多次补全直至收敛）。
pub fn next_run_after(now: DateTime<Utc>) -> DateTime<Utc> {
    let mut date = utc_to_cst(now).date();
    for _ in 0..10 {
        for &(h, m) in &RUN_TIMES {
            let run = cst_to_utc(date.and_hms_opt(h, m, 0).expect("valid hms"));
            if run > now { return run; }
        }
        date += Duration::days(1);
    }
    unreachable!("10 天内必有触发点")
}

/// 同步目标交易日（三时点口径）：最近一个已收盘（15:00 CST 已过）的工作日。
/// 18:00 触发 → 当日；00:00/08:00 触发 → 前一交易日（跨周末回退，Wave 0 日历=仅工作日）。
pub fn sync_target_date(now: DateTime<Utc>) -> NaiveDate {
    let cst = utc_to_cst(now);
    let close = chrono::NaiveTime::from_hms_opt(15, 0, 0).expect("valid hms");
    let mut d = if cst.time() < close { cst.date() - Duration::days(1) } else { cst.date() };
    while matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun) {
        d -= Duration::days(1);
    }
    d
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

    /// 审计事件（缺陷 2 修复口径 b）：整轮跳过/零调用落 source_health_events
    /// （source=tushare, ok=true, err_kind=na；原因载于 trace_id，形如 "skip:<reason>"）。
    /// 注：0001 schema 无 detail 列，PgEventSink 持久化 ts/source/ok/latency/err_kind/code；
    /// 监控以该 na 事件为信号，跳过原因查日志（trace_id 随内存事件/断言可见）。
    async fn emit_skip_audit(&self, reason: &str) {
        let ev = HealthEvent {
            ts: self.clock.now(), source: SourceId::Tushare, ok: true, latency_ms: None,
            err_kind: Some(ErrKind::Na), code: None, trace_id: Some(format!("skip:{reason}")),
        };
        if let Err(e) = self.sink.emit(ev).await {
            tracing::warn!(error = %e, "tushare daily skip-audit event emit failed");
        }
    }

    /// 单 code 增量：拉取窗口 = [min(checkpoint+1日, target), target]
    /// （target = sync_target_date 最近已收盘工作日，三时点均含目标交易日）。
    /// 缺陷 2 修复（§6.1）：目标交易日**强制同步**（checkpoint==target 也重拉，
    /// 准确层 ON CONFLICT DO UPDATE 幂等去重——三时点多次补全方案的前提）；
    /// checkpoint 推进经 sync::checkpoint_through_cap 封顶（盘中不得标记当日完成）。
    async fn sync_code(&self, code: &str, target: NaiveDate, now: DateTime<Utc>) -> Result<usize, ProviderError> {
        let cp = self.store.checkpoint(code).await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        let start = crate::sync::resume_from(cp).min(target);
        let bars = self.provider.fetch_history(
            &Code(code.to_string()), Period::M1,
            cst_to_utc(start.and_hms_opt(0, 0, 0).expect("valid hms")),
            cst_to_utc(target.and_hms_opt(15, 0, 0).expect("valid hms"))).await?;
        let n = bars.len();
        let through = target.min(crate::sync::checkpoint_through_cap(now));
        self.store.save(code, &bars, through).await
            .map_err(|e| ProviderError::Http(e.to_string()))?;
        Ok(n)
    }

    /// 单轮：逐 code 增量（目标 = 最近已收盘工作日），失败指数退避重试 MAX_ATTEMPTS 次；
    /// RateLimited 整轮中止。三时点各自独立触发一轮（各自独立重试与审计事件）。
    pub async fn run(&self) -> DailyOutcome {
        let now = self.clock.now();
        let target = sync_target_date(now);
        let codes = match self.store.enabled_codes().await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "tushare daily: read symbols failed");
                self.emit(false, None, Some(ErrKind::Http), None).await;
                return DailyOutcome::Failed;
            }
        };
        if codes.is_empty() {
            // 缺陷 2 修复口径 b（禁止静默跳过）：整轮零调用落审计事件
            tracing::warn!("tushare daily: no enabled codes, round skipped (zero API calls)");
            self.emit_skip_audit("no_enabled_codes").await;
            return DailyOutcome::Synced { codes: 0, bars: 0 };
        }
        let mut total_bars = 0usize;
        let mut done = 0usize;
        let mut failed = false;
        for code in &codes {
            let mut attempt = 0u32;
            loop {
                let t0 = std::time::Instant::now();
                match self.sync_code(code, target, now).await {
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
