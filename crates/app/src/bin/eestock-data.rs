// ~/~ begin <<design/03-collector/02-data-plane.md#crates/app/src/bin/eestock-data.rs>>[init]
//! eestock-data —— 数据面进程（采集 + 降级模式 + 缺口回填 + tushare 日增量 + /healthz）。

use app::{config, healthz};
use collector::circuit::CircuitRegistry;
use collector::executor::FetchExecutor;
use collector::gapfill::GapBackfiller;
use collector::service::CollectorService;
use collector::standby::StandbyReserve;
use domain::ports::{Clock, EventSink, HolidayCalendarRead, KlineWriter, RawBarReader, SystemClock,
    SymbolRegistry};
use domain::provider::{MinuteKlineProvider, SnapshotProvider};
use domain::selector::{DutyRoster, SourceSelector};
use domain::types::SourceId;
use providers::http::{ReqwestHttp, DEFAULT_TIMEOUT, EASTMONEY_TIMEOUT};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // compose healthcheck 子命令（运行时镜像无 curl/wget）
    if args.iter().any(|a| a == "--self-check") {
        let port: u16 = arg_val(&args, "--healthz-port")
            .and_then(|v| v.parse().ok())
            .or_else(|| std::env::var("HEALTHZ_PORT").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(8080);
        std::process::exit(if healthz::self_check(port) { 0 } else { 1 });
    }
    let config_path = arg_val(&args, "--config")
        .unwrap_or_else(|| "./config/data.toml".to_string());
    let cfg = config::load(&config_path)?;

    // JSON 日志（Trace ID 以 span/字段贯穿，03 §3）
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into()))
        .init();
    tracing::info!(config = %config_path, "eestock-data starting");

    let pool = PgPool::connect(&cfg.database_url).await?;
    // ADR-017：启动 schema 自检，缺失即拒绝启动
    storage::migrate_check::verify_schema(&pool).await?;
    tracing::info!("schema self-check ok");

    // ---- providers（Tier1 双源 + Tier2 快照池冷藏）----
    let http_default = Arc::new(ReqwestHttp::new(DEFAULT_TIMEOUT));
    let http_eastmoney = Arc::new(ReqwestHttp::new(EASTMONEY_TIMEOUT));
    let mut minute_providers: HashMap<SourceId, Arc<dyn MinuteKlineProvider>> = HashMap::new();
    minute_providers.insert(SourceId::TencentIfzq,
        Arc::new(providers::tencent_ifzq::TencentIfzq::new(http_default.clone())));
    minute_providers.insert(SourceId::SinaJsonp,
        Arc::new(providers::sina_jsonp::SinaJsonp::new(http_default.clone())));
    let snapshot_pool: Vec<Arc<dyn SnapshotProvider>> = vec![
        Arc::new(providers::tencent_qt::TencentQt::new(http_default.clone())),
        Arc::new(providers::sina_hq::SinaHq::new(http_default.clone())),
        Arc::new(providers::ths_cs::ThsCs::new(http_default.clone())),
        Arc::new(providers::push2delay::Push2delay::new(http_eastmoney)),
        Arc::new(providers::exchange::Exchange::new(http_default)),
    ];

    // ---- collector 装配 ----
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let sink: Arc<dyn EventSink> = Arc::new(storage::events::PgEventSink::new(pool.clone()));
    let writer: Arc<dyn KlineWriter> = Arc::new(storage::kline::RawKlineWriter::new(pool.clone()));
    let reader: Arc<dyn RawBarReader> = Arc::new(storage::kline::RawKlineWriter::new(pool.clone()));
    // Wave 2 Phase A：节假日感知交易日历（0008 holidays 表；HolidayCalendar 实例在 gapfill/service 间共享，
    // 快照由 service 刷新任务维护，刷新失败 fail-open 为仅工作日口径）
    let holiday_source: Arc<dyn HolidayCalendarRead> =
        Arc::new(storage::reader::HolidaysReader::new(pool.clone()));
    let calendar = Arc::new(collector::calendar::HolidayCalendar::new(clock.clone()));
    let registry: Arc<dyn SymbolRegistry> = Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone()));
    let tier1 = vec![SourceId::TencentIfzq, SourceId::SinaJsonp];
    let circuits = Arc::new(CircuitRegistry::new(tier1.clone(), clock.clone(), sink.clone()));
    let executor = Arc::new(FetchExecutor::new(
        minute_providers.clone(),
        SourceSelector::new(tier1.clone()),
        DutyRoster::new([SourceId::TencentIfzq, SourceId::SinaJsonp]),
        circuits.clone(), writer.clone(), sink.clone(), clock.clone()));
    let standby = Arc::new(StandbyReserve::new(snapshot_pool, clock.clone()));
    let gapfill = Arc::new(GapBackfiller::new(
        executor.clone(), reader, registry.clone(), clock.clone(), calendar.clone()));
    // 熔断复位 DB 控制通道消费端（Wave 1 Phase C 加法扩展，03-collector §10；
    // ADR-017：应用面 POST /api/sources/{id}/reset 经 circuit_reset_requests 表触达，无直连）
    let reset_watcher = Arc::new(collector::reset::ResetWatcher::new(
        Arc::new(storage::admin::PgResetStore::new(pool.clone())), circuits.clone()));
    tokio::spawn(collector::reset::run_forever(reset_watcher));
    // 低频探测任务（§4）：HalfOpen Tier1 源冷却到期后单发轻量探测，熔断自愈
    let prober = Arc::new(collector::probe::CircuitProber::new(
        minute_providers, circuits, registry.clone(), sink.clone(), clock.clone()));
    let svc = Arc::new(CollectorService::new(
        executor, standby, gapfill, prober, registry, calendar, holiday_source,
        writer, clock.clone()));

    // ---- tushare 日增量（三时点 08:00/18:00/00:00 Asia/Shanghai，04-storage §6.2）----
    if cfg.tushare_enabled {
        match &cfg.tushare_token {
            Some(token) if !token.is_empty() => {
                let client = tushare::client::TushareClient::with_config(
                    token.clone(), tushare::client::API_URL.to_string(),
                    chrono::Duration::milliseconds(cfg.tushare_interval_ms));
                let daily = Arc::new(tushare::daily::DailySync::new(
                    Arc::new(client),
                    Arc::new(tushare::daily::PgDailyStore::new(pool.clone())),
                    sink.clone(), clock.clone()));
                tokio::spawn(tushare::daily::run_forever(daily, clock.clone()));
                tracing::info!("tushare daily task enabled");
            }
            _ => tracing::warn!("tushare_enabled=true 但无 token（TUSHARE_TOKEN），日增量任务跳过"),
        }
    }

    // ---- /healthz（唯一端口，只读存活探测）----
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.healthz_port)).await?;
    tracing::info!(port = cfg.healthz_port, "healthz listening");
    tokio::spawn(healthz::serve(listener));

    tracing::info!("eestock-data started");
    svc.run().await
}

fn arg_val(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}
// ~/~ end
