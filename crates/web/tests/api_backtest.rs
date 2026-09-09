//! 回测端点集成测试（需 TimescaleDB :5433，含 0011 迁移）：真实起 axum server + reqwest 断言。
//! ⚠️ **非 tangle 手写**（ADR-007 例外）：契约在 design/07-app-plane/00-web-api.md §1.5，本文件不 tangle。
//! 覆盖：strategies 200、submit 校验 400/404/入队、list/get/compare、网格展开、WS 进度推送（sink→hub 订阅过滤）。
//! 每测试用独立 code（并行执行互不共享清理）。

use chrono::{DateTime, TimeZone, Utc};
use domain::ports::BacktestRunStore;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{PushMsg, Subscription, SubscriptionRegistry, Topic, WsHub};

const ENQUEUE_CODE: &str = "996611";
const GRID_CODE: &str = "996612";
const DELETE_CODE: &str = "996613";

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 测试装配（与 app bin 同口径）：storage 具体实现注入 domain 端口 + application 回测服务。
fn state(pool: PgPool) -> Arc<AppState> {
    // Wave 3 Phase 3c：回测 DI（bar reader + store + WS 进度 sink → BacktestService）
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
        alerts: alert::engine::AlertService::new(
            Arc::new(storage::alerts::PgAlertEval::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::alerts::PgAlertStore::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        quality: diagnose::quality::QualityService::new(
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(storage::kline::RawKlineWriter::new(pool.clone())),
            Arc::new(storage::reader::HealthEventReader::new(pool.clone())),
            Arc::new(storage::reader::HolidaysReader::new(pool.clone())),
            Arc::new(storage::reader::KlineReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        ),
        system_info: web::settings::SystemInfoSource {
            app_version: "0.1.0".into(),
            crate_versions: web::dto::CrateVersions {
                collector: "0.1.0".into(), storage: "0.1.0".into(), diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
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

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

/// 清理某 code 的回测 run（async 后台任务可能仍在跑，重复删除无害——UPDATE 影响 0 行）。
async fn clean_bt(pool: &PgPool, code: &str) {
    sqlx::query("DELETE FROM backtest_results WHERE run_id IN \
                 (SELECT id FROM backtest_runs WHERE code = $1)")
        .bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM backtest_runs WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

/// 直造 run（store 侧；测试不走 HTTP 提交以控制排序与结果注入）。
fn new_bt_run(group: &str) -> domain::ports::NewRun {
    domain::ports::NewRun {
        code: "515880".into(),
        period: "D1".into(),
        strategy_id: "dual_ma".into(),
        params: serde_json::json!({}),
        fee: serde_json::json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 }),
        initial_capital: 100_000.0,
        date_from: base(),
        date_to: base() + chrono::Duration::hours(1),
        group_id: Some(group.into()),
    }
}

/// 合法提交 body（D1 / dual_ma / 默认参数 / 默认费用）。
fn valid_body(code: &str) -> serde_json::Value {
    serde_json::json!({
        "code": code,
        "period": "D1",
        "from": "2026-01-01T00:00:00Z",
        "to": "2026-12-31T00:00:00Z",
        "strategy_id": "dual_ma",
        "params": {},
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    })
}

#[tokio::test]
async fn strategies_returns_200_with_seven_catalog() {
    let pool = pool().await;
    let url = spawn(state(pool)).await;
    let http = reqwest::Client::new();

    let v: Value = http.get(format!("{url}/api/backtest/strategies"))
        .send().await.unwrap().json().await.unwrap();
    let arr = v.as_array().expect("strategies 返回数组");
    assert_eq!(arr.len(), 7, "内置策略恰 7 款");
    let ids: Vec<&str> = arr.iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"dual_ma"));
    assert!(ids.contains(&"atr_channel"));
    for s in arr {
        assert!(!s["name"].as_str().unwrap().is_empty());
        assert!(!s["description"].as_str().unwrap().is_empty());
        let schema = s["params_schema"].as_array().expect("params_schema 数组");
        assert!(!schema.is_empty(), "策略 {} schema 非空", s["id"]);
        // 每项参数含 key/label/kind（kind 为 serde 外部标签枚举对象，如 {"Num":{...}}）
        assert!(schema[0]["key"].is_string());
        assert!(schema[0]["label"].is_string());
        assert!(schema[0]["kind"].is_object(), "kind 为枚举对象（Num/Choice）");
    }
}

#[tokio::test]
async fn submit_validations_return_400_and_404() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 非法 period → 400
    let mut b = valid_body(ENQUEUE_CODE);
    b["period"] = serde_json::json!("H1");
    let r = http.post(format!("{url}/api/backtest/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400, "H1 周期 → 400");

    // fee 缺字段 → 400
    let mut b = valid_body(ENQUEUE_CODE);
    b["fee"] = serde_json::json!({"rate_pct": 0.025, "min_fee": 5.0});
    let r = http.post(format!("{url}/api/backtest/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400, "fee 缺 slippage_bp → 400");

    // 无 params 且无 params_grid → 400
    let mut b = valid_body(ENQUEUE_CODE);
    b["params"] = serde_json::Value::Null;
    b["params_grid"] = serde_json::Value::Null;
    let r = http.post(format!("{url}/api/backtest/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 400, "params 与 params_grid 均缺 → 400");

    // 未知策略 → 404
    let mut b = valid_body(ENQUEUE_CODE);
    b["strategy_id"] = serde_json::json!("no_such_strategy");
    let r = http.post(format!("{url}/api/backtest/runs")).json(&b).send().await.unwrap();
    assert_eq!(r.status(), 404, "未知策略 → 404");

    // 全部校验失败不应产生 run 行
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM backtest_runs WHERE code = $1")
        .bind(ENQUEUE_CODE).fetch_one(&pool).await.unwrap();
    assert_eq!(count.0, 0, "校验失败不应入队");
}

#[tokio::test]
async fn submit_enqueue_then_list_get_compare() {
    let pool = pool().await;
    clean_bt(&pool, ENQUEUE_CODE).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 入队 → 200 {run_id}
    let v: Value = http.post(format!("{url}/api/backtest/runs"))
        .json(&valid_body(ENQUEUE_CODE)).send().await.unwrap().json().await.unwrap();
    let run_id = v["run_id"].as_i64().expect("run_id 为正整数");
    assert!(run_id >= 1);

    // list 含该 run（进度/状态/当前回测 ts 字段可空——后台任务异步，不锁定完成态）
    let list: Value = http.get(format!("{url}/api/backtest/runs"))
        .send().await.unwrap().json().await.unwrap();
    let found = list.as_array().unwrap().iter().any(|r| r["id"] == run_id);
    assert!(found, "list 应包含刚提交的 run（id={run_id}）");

    // get 单 run 详情
    let d: Value = http.get(format!("{url}/api/backtest/runs/{run_id}"))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(d["id"], run_id);
    assert_eq!(d["code"], ENQUEUE_CODE);
    assert_eq!(d["strategy_id"], "dual_ma");
    assert!(d["status"].is_string(), "status 为字符串");
    // B1：初始资金与区间持久化并暴露在 DTO
    assert_eq!(d["initial_capital"], 100_000.0, "初始资金默认 100_000（B1）");
    assert_eq!(d["date_from"], "2026-01-01T00:00:00Z", "date_from 持久化（B1）");
    assert_eq!(d["date_to"], "2026-12-31T00:00:00Z", "date_to 持久化（排除端点）");

    // compare 只含存在 run
    let c: Value = http.get(format!("{url}/api/backtest/compare"))
        .query(&[("ids", &run_id.to_string())]).send().await.unwrap().json().await.unwrap();
    let carr = c.as_array().expect("compare 返回数组");
    assert_eq!(carr.len(), 1);
    assert_eq!(carr[0]["id"], run_id);

    // compare 含不存在 id → 被过滤（assert len 仍为存在项）
    let c2: Value = http.get(format!("{url}/api/backtest/compare"))
        .query(&[("ids", &format!("{run_id},999999999"))]).send().await.unwrap().json().await.unwrap();
    assert_eq!(c2.as_array().unwrap().len(), 1, "不存在 run 被排除");

    // list 非法 status → 400
    let r = http.get(format!("{url}/api/backtest/runs"))
        .query(&[("status", "bogus")]).send().await.unwrap();
    assert_eq!(r.status(), 400, "非法 status → 400");

    clean_bt(&pool, ENQUEUE_CODE).await;
}

#[tokio::test]
async fn submit_grid_expands_to_group_with_run_ids() {
    let pool = pool().await;
    clean_bt(&pool, GRID_CODE).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    let mut b = valid_body(GRID_CODE);
    b["params_grid"] = serde_json::json!({"fast": "2:6:2"}); // 2/4/6 → 3 子任务
    b["params"] = serde_json::json!({});
    let v: Value = http.post(format!("{url}/api/backtest/runs"))
        .json(&b).send().await.unwrap().json().await.unwrap();
    let gid = v["group_id"].as_str().expect("网格返回 group_id");
    let run_ids = v["run_ids"].as_array().expect("网格返回 run_ids");
    assert_eq!(run_ids.len(), 3, "网格展开 3 个子任务");
    assert!(run_ids[0].is_i64());

    // list 按 group_id 过滤 → 恰 3 个（后台任务可能已改变 status，但 group_id 不因任务结束改变）
    let list: Value = http.get(format!("{url}/api/backtest/runs"))
        .query(&[("group_id", gid)]).send().await.unwrap().json().await.unwrap();
    let carr = list.as_array().unwrap();
    assert_eq!(carr.len(), 3, "group_id 过滤恰 3 run");
    for r in carr {
        assert_eq!(r["group_id"], gid, "子任务共享 group_id");
    }

    clean_bt(&pool, GRID_CODE).await;
}

#[tokio::test]
async fn ws_backtest_progress_reaches_subscribed_clients() {
    let pool = pool().await;
    let st = state(pool);
    // 模拟 WS 客户端订阅 run 7（handle_socket 会 add 到 registry；本测试直调同路径）
    st.subs.add(Subscription { topic: Topic::Backtest, code: None, period: None, run_id: Some(7), strategy_run_id: None, });
    let mut rx = st.hub.subscribe();

    // 经 AppState.backtest_ws（= BacktestService 注入的 sink）推一帧
    let ts = base();
    st.backtest_ws.send(7, 50, Some(ts)).await.unwrap();

    let msg = rx.recv().await.unwrap();
    match msg {
        PushMsg::BacktestProgress { run_id, pct, bar_ts } => {
            assert_eq!(run_id, 7, "run_id 透传给订阅者");
            assert_eq!(pct, 50);
            assert_eq!(bar_ts, Some(ts));
        }
        other => panic!("应为 backtest_progress，实际 {other:?}"),
    }
}

#[tokio::test]
async fn list_runs_pagination_light_numbered() {
    let pool = pool().await;
    let group = format!("bt_list_page_{}", std::process::id());
    // 清理：FK 级联删结果 → 删 run。
    sqlx::query("DELETE FROM backtest_results WHERE run_id IN \
                 (SELECT id FROM backtest_runs WHERE group_id = $1)")
        .bind(&group).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM backtest_runs WHERE group_id = $1").bind(&group).execute(&pool).await.unwrap();

    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let store = storage::backtest::PgBacktestStore::new(pool.clone());
    // 造 5 个 run（共用 group；created_at DESC, id DESC → 最新 id 最大在前）。
    let mut ids = Vec::new();
    for _ in 0..5 { ids.push(store.create_run(&new_bt_run(&group)).await.unwrap()); }
    let result = domain::ports::RunResult {
        net_value: serde_json::json!([[base(), 100_000.0]]),
        trades: serde_json::json!([]),
        metrics: serde_json::json!({ "net_profit": 1.0 }),
    };
    store.mark_done(ids[0], &result).await.unwrap();
    store.mark_done(ids[1], &result).await.unwrap();

    // limit=2 offset=0 → 2 条，且均为轻量（无 net_value/trades/metrics 键）。
    let p1: Value = http.get(format!("{url}/api/backtest/runs"))
        .query(&[("group_id", group.as_str()), ("limit", "2"), ("offset", "0")])
        .send().await.unwrap().json().await.unwrap();
    let a1 = p1.as_array().expect("list 返回数组");
    assert_eq!(a1.len(), 2, "limit=2 页1 恰 2 条");
    assert_eq!(a1[0]["id"], ids[4], "created_at DESC, id DESC → 最新 id 最大在前");
    assert_eq!(a1[1]["id"], ids[3]);
    assert!(a1[0].get("net_value").is_none(), "列表不返回结果列（轻量）");
    assert!(a1[0].get("metrics").is_none(), "列表不返回 metrics");

    // limit=2 offset=2 → 下 2 条。
    let p2: Value = http.get(format!("{url}/api/backtest/runs"))
        .query(&[("group_id", group.as_str()), ("limit", "2"), ("offset", "2")])
        .send().await.unwrap().json().await.unwrap();
    let a2 = p2.as_array().unwrap();
    assert_eq!(a2.len(), 2);
    assert_eq!(a2[0]["id"], ids[2]);
    assert_eq!(a2[1]["id"], ids[1]);

    // limit=2 offset=4 → 尾 1 条。
    let p3: Value = http.get(format!("{url}/api/backtest/runs"))
        .query(&[("group_id", group.as_str()), ("limit", "2"), ("offset", "4")])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(p3.as_array().unwrap().len(), 1);
    assert_eq!(p3.as_array().unwrap()[0]["id"], ids[0]);

    // get_run 单跑 → 带结果列（详情才读结果）。
    let d: Value = http.get(format!("{url}/api/backtest/runs/{}", ids[0]))
        .send().await.unwrap().json().await.unwrap();
    assert!(d.get("net_value").is_some(), "get_run 返回结果列");
    assert!(d.get("metrics").is_some(), "get_run 返回 metrics");

    // 超限 limit clamp 到 500（封顶）；越界 offset 返回空页而非报错。
    let big: Value = http.get(format!("{url}/api/backtest/runs"))
        .query(&[("group_id", group.as_str()), ("limit", "2000"), ("offset", "0")])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(big.as_array().unwrap().len(), 5, "limit clamp 500 > 5 条则返回全部");
    let oob: Value = http.get(format!("{url}/api/backtest/runs"))
        .query(&[("group_id", group.as_str()), ("limit", "2"), ("offset", "100")])
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(oob.as_array().unwrap().len(), 0, "越界 offset 返回空页");

    // 清理。
    sqlx::query("DELETE FROM backtest_results WHERE run_id IN \
                 (SELECT id FROM backtest_runs WHERE group_id = $1)")
        .bind(&group).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM backtest_runs WHERE group_id = $1").bind(&group).execute(&pool).await.unwrap();
}

#[tokio::test]
async fn delete_run_returns_200_deleted_or_404() {
    let pool = pool().await;
    clean_bt(&pool, DELETE_CODE).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 先创建 run → 200 {run_id}
    let v: Value = http.post(format!("{url}/api/backtest/runs"))
        .json(&valid_body(DELETE_CODE)).send().await.unwrap().json().await.unwrap();
    let run_id = v["run_id"].as_i64().expect("run_id 为正整数");

    // 删除存在 run → 200 {deleted:true}
    let r = http.delete(format!("{url}/api/backtest/runs/{run_id}")).send().await.unwrap();
    assert_eq!(r.status(), 200, "删除存在 run → 200");
    let dv: Value = r.json().await.unwrap();
    assert_eq!(dv["deleted"], true, "响应体 deleted=true");

    // 删除后 get → 404
    let g = http.get(format!("{url}/api/backtest/runs/{run_id}")).send().await.unwrap();
    assert_eq!(g.status(), 404, "删除后 get → 404（B1）");

    // 删除不存在 run → 404
    let r2 = http.delete(format!("{url}/api/backtest/runs/999999999")).send().await.unwrap();
    assert_eq!(r2.status(), 404, "删除不存在 run → 404");

    clean_bt(&pool, DELETE_CODE).await;
}
