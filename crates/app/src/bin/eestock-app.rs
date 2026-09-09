// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/app/src/bin/eestock-app.rs>>[init]
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
    let backtest_hub = web::ws::WsHub::new();
    // Wave 3 页面①：看板收藏（FavoriteStore，favorite_symbols 表 0013）
    let favorites: Arc<dyn domain::ports::FavoriteStore> =
        Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone()));
    // 行情看板 MA 可配置（MaConfigStore，ma_config 表 0015；主图+宫格应用，回测弹窗不动）
    let ma_config: Arc<dyn domain::ports::MaConfigStore> =
        Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone()));
    // 页面⑧ 系统设置 S2：配置持久化（ConfigStore，app_config 表 0021；sources/collector/mcp 三块）
    let config: Arc<dyn domain::ports::ConfigStore> =
        Arc::new(storage::config_store::PgConfigStore::new(pool.clone()));
    // 11-sim-live / L1：模拟实盘服务（sim_* 工具 + web 面板 /api/sim-live/*；SimSessionStore + SystemClock + 默认 FeeModel）。
    // 12-strategy-system / P4a 切源：策略源 = Registry（注入 PgStrategyStore，与 StrategyService/WorkbenchService
    // 共享同一 store 实例）；「回测一下」改走统一 ensemble 引擎（注入 WorkbenchService，见下方后注）。
    // **MCP 与 web 共享同一服务实例**（ADR 11-sim-live §7 双通道一致性）：同一 Arc 同时装入 AppState.sim 与 McpState.sim。
    // 持仓 latest/market_value 经行情源读端口解析（复用 state.kline 同款 KlineReader）；缺行情才回退 0.000。
    let sim_kline: Arc<dyn domain::ports::KlineRead> =
        Arc::new(storage::reader::KlineReader::new(pool.clone()));
    // P4a：Registry store 共享实例（StrategyService / WorkbenchService / SimLiveService 同一事实源）。
    let strategy_store = Arc::new(storage::strategy::PgStrategyStore::new(pool.clone()));
    // 12-strategy-system / P2a：策略 Registry DI（PgStrategyStore + BacktestBarRead（复用回测取数
    // 口径 kline_accurate 优先）+ SystemClock → StrategyService）。
    let strategy_service = Arc::new(application::strategy::StrategyService::new(
        strategy_store.clone(),
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    ));
    // P2a 启动播种：strategy 表为空 → strategy-core::reference 7 参考插件 + 4 官方模板以
    // published 入库（sha256 启动时计算；幂等——表非空整体跳过，按 name+sha256 逐款跳过）。
    let seed_report = strategy_service.seed_reference_plugins().await?;
    tracing::info!(seeded = %seed_report.seeded, skipped = %seed_report.skipped,
        "strategy registry 启动播种完成");
    // 12-strategy-system / P3a：回测工作台 DI（§1.8：PgStrategyRunStore + PgStrategyPresetStore +
    // PgStrategyStore + PgSymbolRegistry + BacktestBarRead + WorkbenchWsSink → WorkbenchService）。
    // 并发上限用 application::workbench::DEFAULT_MAX_CONCURRENT（与回测同口径 = 4，本期不开放配置）。
    let workbench_service = Arc::new(application::workbench::WorkbenchService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
        strategy_store.clone(),
        Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
        Arc::new(web::workbench::WorkbenchWsSink::new(backtest_hub.clone())),
        Arc::new(domain::ports::SystemClock),
        application::workbench::DEFAULT_MAX_CONCURRENT,
    ));
    // 11-sim-live / P4a：SimLiveService 装配（策略源 = Registry 共享 strategy_store；「回测一下」
    // 统一 ensemble 引擎 = workbench_service——消费式 builder，故构造置于 workbench_service 之后）。
    // 启动恢复：收敛/恢复进程重启遗留的 running 会话（读 simsession_state + strategy_version 钉住
    // 快照重建插件实例续跑；无 state / 版本失效 / 实例化失败 → ended + 告警）。
    let sim_service = Arc::new(application::simlive::SimLiveService::with_default_fee(
        Arc::new(storage::sim::PgSimSessionStore::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    )
    .with_strategies(strategy_store.clone())
    .with_workbench(workbench_service.clone())
    .with_kline(sim_kline.clone()));
    let sim_recovery = sim_service.recover_sessions().await?;
    tracing::info!(recovered = %sim_recovery.recovered.len(), degraded = %sim_recovery.degraded.len(), "sim-live 启动恢复完成");
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
        // Wave 3 页面①：看板收藏（FavoriteStore）
        favorites,
        // 行情看板 MA 可配置（MaConfigStore）
        ma_config,
        // 页面⑧ 系统设置 S2：配置持久化（ConfigStore）
        config,
        // 11-sim-live / L3b：模拟实盘服务（与 MCP 共享同一 SimLiveService 实例）
        sim: Some(sim_service.clone()),
        // 12-strategy-system / P2a：策略 Registry 服务（/api/strategies/*；clone 供 MCP P3c 共享同实例）
        strategies: Some(strategy_service.clone()),
        // 12-strategy-system / P3a：回测工作台服务（/api/workbench/*，§1.8；clone 供 MCP P3c 共享同实例）
        workbench: Some(workbench_service.clone()),
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
        // 12-strategy-system / P3c：统一策略系统 MCP 工具族（strategy_*/bt_*）——与 web 共享同一服务实例
        //（同 SimLiveService 双通道口径）；落现有 SSE server（ADR §13.7，不做 transport 迁移）。
        strategies: Some(strategy_service),
        workbench: Some(workbench_service),
        // P3c：strategy_*/bt_* 工具族 MCP 停用开关（父级裁决：McpState 本地单开关，默认开；
        // 后续如需运行时翻转，web 端点写同一 Arc——本期不做端点）。
        strategy_tools_enabled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
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
// ~/~ end
