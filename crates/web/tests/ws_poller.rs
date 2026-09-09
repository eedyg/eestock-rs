// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/web/tests/ws_poller.rs>>[init]
//! WS Poller 集成测试（需 TimescaleDB :5433）：库增量 → hub 推送；无增量不重推；新 bar 再推。

use chrono::{DateTime, Duration, TimeZone, Utc};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use web::state::AppState;
use web::ws::{Poller, PushMsg, Subscription, SubscriptionRegistry, Topic, WsHub};

const CODE: &str = "996603";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构）：storage 具体实现注入 domain 端口 / diagnose 服务。
/// storage/sqlx 仅出现在 dev-dependencies（正常依赖图不含，cargo tree -e normal 验证）。
fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（与 app bin 同口径；本文件不涉及行为，仅装配齐全）
    let backtest_hub = WsHub::new();
    let backtest_ws: Arc<dyn domain::ports::BacktestProgressSink> =
        Arc::new(web::backtest::BacktestWsSink::new(backtest_hub.clone()));
    let backtest = Arc::new(application::service::BacktestService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::backtest::PgBacktestStore::new(pool.clone())),
        backtest_ws.clone(),
        application::service::DEFAULT_MAX_CONCURRENT,
    ));
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(
            Arc::new(storage::reader::HealthEventReader::new(pool.clone()))),
        // Phase C：symbols 写 / 当日统计 / 熔断复位 DB 通道（本文件不涉及行为，仅装配齐全）
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎装配（02-alerts.md；本文件不涉及行为，仅装配齐全）
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        // Wave 2 Phase A：数据质量服务（quality 端口组；仅装配齐全，行为测试见 api_quality.rs）
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        // Wave 3 Phase 3c：回测服务 + WS 进度分发（§1.5）
        backtest,
        backtest_ws,
        // Wave 3 页面①：看板收藏（装配齐全；行为测试见 api_favorites.rs）
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        // 行情看板 MA 可配置（装配齐全；行为测试见 api_ma_config.rs）
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        strategies: None, // P2a：策略 Registry（行为测试见 api_strategies.rs）
        workbench: None, // P3a：回测工作台（行为测试见 api_workbench.rs）
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn seed(pool: &PgPool, min: i64, close: f64) {
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
        .bind(CODE).bind(base() + Duration::minutes(min)).bind(close)
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn poller_publishes_increments_only() {
    let pool = pool().await;
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO symbols (code) VALUES ($1) ON CONFLICT (code) DO NOTHING")
        .bind(CODE).execute(&pool).await.unwrap();
    seed(&pool, 0, 1.0).await;

    let st = state(pool.clone());
    st.subs.add(Subscription { topic: Topic::Bar,
        code: Some(CODE.into()), period: Some("1m".into()), run_id: None, strategy_run_id: None, });
    st.subs.add(Subscription { topic: Topic::Quote, code: None, period: None, run_id: None, strategy_run_id: None });
    let mut rx = st.hub.subscribe();
    let mut poller = Poller::new(st.clone(), StdDuration::from_secs(60));

    // 第 1 轮：bar + quote 各一帧（其他标的的 quote 可能有，过滤找本 code）
    poller.tick().await.unwrap();
    let mut bar_seen = false;
    let mut quote_seen = false;
    while let Ok(m) = rx.try_recv() {
        match m {
            PushMsg::Bar { code, period, bar } if code == CODE => {
                assert_eq!(period, "1m");
                assert_eq!(bar.close, 1.0);
                bar_seen = true;
            }
            PushMsg::Quote { code, last, .. } if code == CODE => {
                assert_eq!(last, 1.0);
                quote_seen = true;
            }
            _ => {}
        }
    }
    assert!(bar_seen && quote_seen, "首轮推送 bar 与 quote");

    // 第 2 轮：无增量 → 不重推
    poller.tick().await.unwrap();
    let mut resent = false;
    while let Ok(m) = rx.try_recv() {
        match m {
            PushMsg::Bar { code, .. } | PushMsg::Quote { code, .. } if code == CODE => resent = true,
            _ => {}
        }
    }
    assert!(!resent, "游标推进，无增量不重推");

    // 新 bar → 再推（bar 与 quote 均为最新值）
    seed(&pool, 1, 2.0).await;
    poller.tick().await.unwrap();
    let mut new_close = None;
    while let Ok(m) = rx.try_recv() {
        if let PushMsg::Bar { code, bar, .. } = m {
            if code == CODE { new_close = Some(bar.close); }
        }
    }
    assert_eq!(new_close, Some(2.0));

    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CODE).execute(&pool).await.unwrap();
}
// ~/~ end
