// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/app/src/bin/eestock-app.rs>>[init]
//! eestock-app —— 应用面进程（web REST/WS + diagnose 读库 + SPA 托管）。
//! ADR-017：与数据面零 API 直连，唯一耦合点 = TimescaleDB；启动 schema 自检复用 storage::migrate_check。
//! 由 design/07-app-plane/00-web-api.md tangle 生成（ADR-007），禁止手改。

use app::app_config;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // compose healthcheck 子命令（运行时镜像无 curl/wget；复用数据面 healthz::self_check）
    if args.iter().any(|a| a == "--self-check") {
        let port: u16 = arg_val(&args, "--port")
            .and_then(|v| v.parse().ok())
            .or_else(|| std::env::var("APP_PORT").ok().and_then(|v| v.parse().ok()))
            .unwrap_or(8081);
        std::process::exit(if app::healthz::self_check(port) { 0 } else { 1 });
    }
    let config_path = arg_val(&args, "--config")
        .unwrap_or_else(|| "./config/app.toml".to_string());
    let cfg = app_config::load(&config_path)?;

    // JSON 日志（与数据面同口径）
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into()))
        .init();
    tracing::info!(config = %config_path, "eestock-app starting");

    let pool = PgPool::connect(&cfg.database_url).await?;
    storage::migrate_check::verify_schema(&pool).await?;
    tracing::info!("schema self-check ok");

    // DI 装配（ADR-017：app 是唯一持有 storage 具体实现的应用面组件；
    // web 只见 domain::ports，diagnose 只见 domain::ports::HealthEventsRead）
    // Phase D：HealthEventsRead 实现实例 web 与 mcp 共享（同一 Arc）
    let health_events: Arc<dyn domain::ports::HealthEventsRead> =
        Arc::new(storage::reader::HealthEventReader::new(pool.clone()));
    // 页面⑧ S1：系统信息（crate 版本走 env!，web 不依赖 collector/storage）；uptime 以进程启动 Instant 起算
    let system_info = web::settings::SystemInfoSource {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        crate_versions: web::dto::CrateVersions {
            collector: collector::VERSION.to_string(),
            storage: storage::VERSION.to_string(),
            diagnose: diagnose::VERSION.to_string(),
        },
        db: storage::system::system_info(pool.clone()),
        started_at: std::time::Instant::now(),
    };
    // Wave 3 Phase 3c：回测 DI（storage BarReader + PgBacktestStore + WS 进度 sink → application BacktestService）
    // 并发上限用 application::service::DEFAULT_MAX_CONCURRENT（ADR §7 = 4；本期不开放配置）
    let backtest_hub = web::ws::WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    // Wave 3 页面①：看板收藏（FavoriteStore，favorite_symbols 表 0013）
    let favorites: Arc<dyn domain::ports::FavoriteStore> =
        Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone()));
    // 行情看板 MA 可配置（MaConfigStore，ma_config 表 0015；主图+宫格应用，回测弹窗不动）
    let ma_config: Arc<dyn domain::ports::MaConfigStore> =
        Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone()));
    // 11-sim-live / L1：模拟实盘服务（sim_* 工具 + web 面板 /api/sim-live/*；SimSessionStore + SystemClock + 默认 FeeModel）。
    // L3「回测一下」：注入回测服务，sim_run_backtest_compare 复用既有 backtest 引擎触发对比 run。
    // **MCP 与 web 共享同一服务实例**（ADR 11-sim-live §7 双通道一致性）：同一 Arc 同时装入 AppState.sim 与 McpState.sim。
    // 持仓 latest/market_value 经行情源读端口解析（复用 state.kline 同款 KlineReader）；缺行情才回退 0.000。
    let sim_kline: Arc<dyn domain::ports::KlineRead> =
        Arc::new(storage::reader::KlineReader::new(pool.clone()));
    let sim_service = Arc::new(application::simlive::SimLiveService::with_default_fee(
        Arc::new(storage::sim::PgSimSessionStore::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    )
    .with_backtest(backtest.clone())
    .with_kline(sim_kline.clone()));
    let state = Arc::new(web::state::AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(health_events.clone()),
        // Phase C：symbols 写端点 / with_stats 当日统计 / 熔断复位 DB 控制通道
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎（评估读端口 + 应用面自有表持久化 + SystemClock；02-alerts.md）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（页面④ 三端点 + tushare status；MCP④ 复用同实例）
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info,
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest: backtest.clone(),
        backtest_ws,
        // Wave 3 页面①：看板收藏（FavoriteStore）
        favorites,
        // 行情看板 MA 可配置（MaConfigStore）
        ma_config,
        // 11-sim-live / L3b：模拟实盘服务（与 MCP 共享同一 SimLiveService 实例）
        sim: Some(sim_service.clone()),
        static_dir: cfg.static_dir.clone().into(),
        health_window_secs: cfg.health_window_secs,
        hub: backtest_hub,
        subs: web::ws::SubscriptionRegistry::default(),
    });
    tokio::spawn(web::ws::Poller::new(state.clone(), Duration::from_millis(cfg.ws_poll_ms)).run());

    // Wave 2 Phase B：告警评估节拍（默认 1min；新建/续触发/恢复事件经 WS {type:"alert"} 推送）
    tokio::spawn(web::alerts::AlertEvaluator::new(
        state.clone(), Duration::from_millis(cfg.alert_eval_ms)).run());

    // 11-sim-live / L4（F2）：实时评分 feed（poll 式：每 DEFAULT_POLL_INTERVAL 查每标的最近 bar ts，
    // 新 bar 即 process_bar → 评估/评分/聚合/达阈值+统一开关开 → 自动模拟单）。复用 state.kline。
    tokio::spawn(application::simlive_feed::SimLiveFeed::new(
        sim_service.clone(),
        state.kline.clone(),
        application::simlive_feed::DEFAULT_POLL_INTERVAL,
    ).run());

    // Wave 1 Phase D：MCP HTTP/SSE 服务（ADR-009 范围①②）——与 web 同进程、端口独立
    // （design/07-app-plane/01-mcp.md；复用同一 KlineRead/HealthEventsRead 端口实现实例）
    let mcp_state = Arc::new(mcp::state::McpState {
        kline: state.kline.clone(),
        health: diagnose::health::HealthService::new(health_events),
        // Wave 2 Phase A：MCP④ get_data_quality（与 web 共享同一 QualityService 实例，Clone=同 Arc 组）
        quality: state.quality.clone(),
        default_window_secs: cfg.health_window_secs,
        sessions: mcp::state::SessionRegistry::default(),
        sim: Some(sim_service),
    });
    let mcp_listen = cfg.mcp_listen.clone();
    tokio::spawn(async move {
        if let Err(e) = mcp::server::serve(mcp_state, &mcp_listen).await {
            tracing::error!(error = %e, "mcp server exited");
        }
    });

    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    tracing::info!(listen = %cfg.listen, static_dir = %cfg.static_dir, "eestock-app serving");
    axum::serve(listener, web::build_router(state)).await?;
    Ok(())
}

fn arg_val(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}
// ~/~ end
