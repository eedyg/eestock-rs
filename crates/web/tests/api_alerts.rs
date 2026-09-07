// ~/~ begin <<design/07-app-plane/02-alerts.md#crates/web/tests/api_alerts.rs>>[init]
//! 页面⑦ 告警端点集成测试（需 TimescaleDB :5433，含 0009 迁移）：
//! GET/PATCH /api/alert-rules（404/400）、GET /api/alerts（过滤/校验）、
//! POST /api/alerts/{id}/ack（200 持久化 / 404）、AlertEvaluator 评估 → 事件落库 + WS 推送。
//! 并行隔离（同 binary 实锤踩坑口径）：事件用独立 source 段（webalert_*）；
//! 规则表为全局行——rules 测试只 patch symbol_gap_rate 的 threshold/silence（用后复原种子值），
//! evaluator 测试只切 enabled（只留 source_success_rate），两测试不写同列、不断言对方字段。

use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use web::alerts::AlertEvaluator;
use web::state::AppState;
use web::ws::{PushMsg, SubscriptionRegistry, WsHub};

const SRC: &str = "webalert_test_src";
const EVAL_SRC: &str = "webalert_eval_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同结构；storage/sqlx 仅 dev-dependencies）。
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
        symbols_admin: Arc::new(storage::admin::PgSymbolAdmin::new(pool.clone())),
        symbol_stats: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        resets: Arc::new(storage::admin::PgResetStore::new(pool.clone())),
        // Wave 2 Phase B：告警引擎（评估读 + 应用面自有表持久化 + SystemClock）
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
        sim: None,
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

/// 每测试独立 clean（同 binary 并行执行，共享清理会互删——实锤踩坑口径：
/// 曾因两测试共用双 source 清理导致 evaluator 造数被并行测试误删）。
async fn clean(pool: &PgPool, sources: &[&str]) {
    for s in sources {
        sqlx::query("DELETE FROM alert_events WHERE source = $1")
            .bind(s).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM source_health_events WHERE source = $1")
            .bind(s).execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn rules_list_patch_and_validation() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // GET /api/alert-rules：0009 种子 4 条内置规则
    let v: Value = http.get(format!("{url}/api/alert-rules")).send().await.unwrap()
        .json().await.unwrap();
    let rules = v.as_array().unwrap();
    assert_eq!(rules.len(), 4);
    // evaluator 测试不动 source_success_rate（并发安全断言该行字段）
    let ssr = rules.iter().find(|r| r["id"] == "source_success_rate").unwrap();
    assert_eq!(ssr["level"], "warning");
    assert_eq!(ssr["threshold"], 0.95);
    assert_eq!(ssr["duration_minutes"], 10);
    assert_eq!(ssr["silence_minutes"], 10);
    assert_eq!(ssr["enabled"], true);

    // PATCH：阈值/静默热生效（评估节拍每轮重读，alert engine 测试锁定）
    let r = http.patch(format!("{url}/api/alert-rules"))
        .json(&serde_json::json!({"id": "symbol_gap_rate", "threshold": 10.0,
                                  "silence_minutes": 45}))
        .send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["threshold"], 10.0);
    assert_eq!(v["silence_minutes"], 45);

    // 校验：未知 id 404；非法静默/阈值/id 400
    let r = http.patch(format!("{url}/api/alert-rules"))
        .json(&serde_json::json!({"id": "no_such_rule", "enabled": false}))
        .send().await.unwrap();
    assert_eq!(r.status(), 404);
    for body in [
        serde_json::json!({"id": "symbol_gap_rate", "silence_minutes": 0}),
        serde_json::json!({"id": "symbol_gap_rate", "threshold": -1.0}),
        serde_json::json!({"id": "  "}),
    ] {
        let r = http.patch(format!("{url}/api/alert-rules")).json(&body).send().await.unwrap();
        assert_eq!(r.status(), 400, "{body} → 400");
    }

    // 自愈复原种子值（0009 口径；不动 enabled——evaluator 测试持有该列）
    http.patch(format!("{url}/api/alert-rules"))
        .json(&serde_json::json!({"id": "symbol_gap_rate", "threshold": 1.0,
                                  "silence_minutes": 30}))
        .send().await.unwrap();
}

#[tokio::test]
async fn alerts_list_filters_and_ack_lifecycle() {
    let pool = pool().await;
    clean(&pool, &[SRC]).await;
    // 造数：一条 triggered 事件（真实生命周期由 alert engine 测试锁定，此处锁 REST 契约）
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO alert_events (rule_id, level, source, message) \
         VALUES ('source_success_rate', 'warning', $1, '测试告警') RETURNING id")
        .bind(SRC).fetch_one(&pool).await.unwrap();
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 列表 + 过滤
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("source", SRC)]).send().await.unwrap().json().await.unwrap();
    let rows = v.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], id);
    assert_eq!(rows[0]["status"], "triggered");
    assert_eq!(rows[0]["fire_count"], 1);
    assert_eq!(rows[0]["level"], "warning");
    assert!(rows[0]["acked_at"].is_null());
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("level", "critical"), ("source", SRC)]).send().await.unwrap()
        .json().await.unwrap();
    assert!(v.as_array().unwrap().is_empty(), "级别过滤");
    // 非法参数 400
    for q in [[("level", "crit")], [("from", "not-a-time")]] {
        let r = http.get(format!("{url}/api/alerts")).query(&q).send().await.unwrap();
        assert_eq!(r.status(), 400, "{q:?} → 400");
    }

    // ack：200 + 状态持久化（刷新重查不丢）
    let r = http.post(format!("{url}/api/alerts/{id}/ack")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["status"], "acked");
    assert!(v["acked_at"].is_string(), "确认时刻记录");
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("source", SRC)]).send().await.unwrap().json().await.unwrap();
    assert_eq!(v[0]["status"], "acked", "确认状态持久化（重查不丢）");

    // 重复 ack / 未知 id → 404
    let r = http.post(format!("{url}/api/alerts/{id}/ack")).send().await.unwrap();
    assert_eq!(r.status(), 404, "已确认不可重复确认");
    let r = http.post(format!("{url}/api/alerts/999999/ack")).send().await.unwrap();
    assert_eq!(r.status(), 404);
    clean(&pool, &[SRC]).await;
}

#[tokio::test]
async fn evaluator_fires_incident_and_publishes_ws() {
    let pool = pool().await;
    clean(&pool, &[EVAL_SRC]).await;
    // 只留 source_success_rate 启用（其余规则依赖真实时钟/日历，测试隔离；
    // 只切 enabled 列——rules 测试并发 patch threshold/silence 不冲突）
    sqlx::query("UPDATE alert_rules SET enabled = false WHERE id <> 'source_success_rate'")
        .execute(&pool).await.unwrap();
    // 造数：10min 窗口内 1 成功 3 失败（25% < 95%，样本 ≥3）
    for (i, ok) in [true, false, false, false].into_iter().enumerate() {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind) \
                     VALUES (now() - make_interval(secs => $1), $2, $3, $4)")
            .bind(60 + i as i64).bind(EVAL_SRC).bind(ok)
            .bind(if ok { None } else { Some("timeout") })
            .execute(&pool).await.unwrap();
    }
    let st = state(pool.clone());
    let mut rx = st.hub.subscribe();
    let url = spawn(st.clone()).await;
    let evaluator = AlertEvaluator::new(st, StdDuration::from_secs(60));

    evaluator.tick().await.unwrap();

    // 事件落库（triggered）
    let http = reqwest::Client::new();
    let v: Value = http.get(format!("{url}/api/alerts"))
        .query(&[("source", EVAL_SRC)]).send().await.unwrap().json().await.unwrap();
    let rows = v.as_array().unwrap();
    assert_eq!(rows.len(), 1, "评估触发事件落库");
    assert_eq!(rows[0]["rule_id"], "source_success_rate");
    assert_eq!(rows[0]["status"], "triggered");
    assert!(rows[0]["message"].as_str().unwrap().contains("25.0%"));

    // WS 推送帧 {type:"alert", level, ...}
    let mut pushed = None;
    while let Ok(m) = rx.try_recv() {
        if let PushMsg::Alert(dto) = m { pushed = Some(dto); }
    }
    let dto = pushed.expect("fired 事件经 hub 推送");
    assert_eq!(dto.source, EVAL_SRC);
    let frame = serde_json::to_value(PushMsg::Alert(dto)).unwrap();
    assert_eq!(frame["type"], "alert");
    assert_eq!(frame["level"], "warning");
    assert_eq!(frame["source"], EVAL_SRC);

    // 第二轮：静默期内不重复推送
    evaluator.tick().await.unwrap();
    assert!(rx.try_recv().is_err(), "静默期内不重复触发");

    // 自愈复原（全部规则重新启用）
    sqlx::query("UPDATE alert_rules SET enabled = true").execute(&pool).await.unwrap();
    clean(&pool, &[EVAL_SRC]).await;
}
// ~/~ end
