//! [TESTER 临时独立验收夹具 — 013 批 D11 独立验收，不提交，不属于实现]
//!
//! 独立验收 D11（ADR-019）**web REST 通道**：
//!   E. GET /api/symbols 回显 `type`（D11-5）
//!   F. POST /api/symbols `type` 可选 + 枚举校验（非法/空串 400）+ 未传 → NULL（不静默填默认）+ 既有调用不受影响
//!   G. PATCH /api/symbols/{code} `type` 可选/不改/非法 400
//!   H. POST /api/strategies/test-run 省略 fee → profile（与 MCP 同解析点，落盘供逐字节对拍）
//!   I. POST /api/workbench/runs 省略 fee → 钉住 config.fee（source=profile）；GET 回读一致
//!
//! 目标库由 DATABASE_URL 指定（本批用**隔离探针库** eestock_d11_probe，生产库零写入）。
//! 用法：
//!   DATABASE_URL=postgres://eestock:eestock@127.0.0.1:5433/eestock_d11_probe \
//!   EV_DIR=<abs> cargo test -p web --test zz_tester_013_d11_web -- --nocapture --test-threads=1

use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

const ETF: &str = "510050";
const CONST_BUY: &str = "function on_bar(ctx) { return 100; }";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock_d11_probe".into());
    PgPool::connect(&url).await.expect("探针库可连")
}

fn ev_dir() -> String {
    std::env::var("EV_DIR").unwrap_or_else(|_| "/tmp".into())
}

fn dump(name: &str, v: &Value) {
    let p = format!("{}/{}", ev_dir(), name);
    std::fs::write(&p, serde_json::to_string_pretty(v).unwrap()).unwrap();
    println!("EV file {p}");
}

struct NoopProgress;
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for NoopProgress {
    async fn send(&self, _r: &str, _p: f64, _b: Option<chrono::DateTime<Utc>>) -> anyhow::Result<()> {
        Ok(())
    }
}

/// 生产装配**同构**（app bin 两处 `with_fee_profiles` 的 web 侧镜像）。
fn state(pool: PgPool) -> Arc<AppState> {
    let hub = WsHub::new();
    let strategy_store = Arc::new(storage::strategy::PgStrategyStore::new(pool.clone()));
    let strategies = Arc::new(
        application::strategy::StrategyService::new(
            strategy_store.clone(),
            Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
            Arc::new(domain::ports::SystemClock),
        )
        .with_fee_profiles(Arc::new(storage::fee_profile::PgFeeProfileStore::new(pool.clone()))),
    );
    let workbench = Arc::new(
        application::workbench::WorkbenchService::new(
            Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
            Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
            Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
            strategy_store,
            Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
            Arc::new(NoopProgress),
            Arc::new(domain::ports::SystemClock),
            application::workbench::DEFAULT_MAX_CONCURRENT,
        )
        .with_fee_profiles(Arc::new(storage::fee_profile::PgFeeProfileStore::new(pool.clone()))),
    );
    Arc::new(AppState {
        kline: Arc::new(storage::reader::KlineReader::new(pool.clone())),
        health: diagnose::health::HealthService::new(Arc::new(
            storage::reader::HealthEventReader::new(pool.clone()),
        )),
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
                collector: "0.1.0".into(),
                storage: "0.1.0".into(),
                diagnose: "0.1.0".into(),
            },
            db: storage::system::system_info(pool.clone()),
            started_at: std::time::Instant::now(),
        },
        raw_purge: storage::system::raw_purge(pool.clone()),
        favorites: Arc::new(storage::favorite::PgFavoriteStore::new(pool.clone())),
        ma_config: Arc::new(storage::ma_config::PgMaConfigStore::new(pool.clone())),
        config: Arc::new(storage::config_store::PgConfigStore::new(pool.clone())),
        sim: None,
        strategies: Some(strategies),
        workbench: Some(workbench),
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, web::build_router(state)).await.unwrap();
    });
    format!("http://{addr}")
}

/// 6 位数字 code（validate_code 要求）；前缀含 pid → 并发安全 + 便于清理。
fn code_prefix() -> String {
    format!("99{:02}", std::process::id() % 100)
}
fn code(tag: u32) -> String {
    format!("{}{:02}", code_prefix(), tag % 100)
}

async fn create_published(http: &reqwest::Client, url: &str, name: &str) -> String {
    let r = http
        .post(format!("{url}/api/strategies"))
        .json(&json!({ "name": name, "code": CONST_BUY }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201, "create 应 201");
    let created: Value = r.json().await.unwrap();
    let vid = created["version"]["id"].as_str().unwrap().to_string();
    let r = http
        .post(format!("{url}/api/strategies/versions/{vid}/publish"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "publish 应 200");
    vid
}

#[tokio::test]
async fn zz_tester_013_d11_web() {
    let pool = pool().await;
    // 防误跑生产：探针库特征（999999 造数 K 线）
    let probe: i64 = sqlx::query_scalar("SELECT count(*) FROM kline_accurate WHERE code = '999999'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(probe > 0, "本夹具要求隔离探针库（DATABASE_URL=eestock_d11_probe）");

    // 先清理可能的残留（本夹具前缀）
    // 探针库内 99 前缀仅本夹具使用（真实 44 标的前缀为 15/16/51/55/56/58）；999999 为造数标的保留
    sqlx::query("DELETE FROM symbols WHERE code LIKE '99%' AND code <> '999999'")
        .execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM strategy_run WHERE name LIKE 'tester013%'").execute(&pool).await.unwrap();

    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // ═══ E. GET /api/symbols 回显 type ═══
    let rows: Value = http.get(format!("{url}/api/symbols")).send().await.unwrap().json().await.unwrap();
    let arr = rows.as_array().expect("数组");
    let etf = arr.iter().filter(|r| r["type"] == json!("etf")).count();
    let lof = arr.iter().filter(|r| r["type"] == json!("lof")).count();
    let nulls = arr.iter().filter(|r| r["type"].is_null()).count();
    println!("EV E.api_symbols rows={} etf={} lof={} null={}", arr.len(), etf, lof, nulls);
    assert_eq!((arr.len(), etf, lof, nulls), (44, 42, 2, 0));
    let r510050 = arr.iter().find(|r| r["code"] == json!(ETF)).expect("510050");
    assert_eq!(r510050["type"], json!("etf"));
    dump("web_E_api_symbols.json", &json!({
        "rows": arr.len(), "etf": etf, "lof": lof, "null": nulls, "sample_510050": r510050 }));

    // ═══ F. 注册端点 type 可选 + 枚举校验 + 未传 = NULL ═══
    let c_default = code(1); // 不传 type（既有调用形态）
    let c_etf = code(2);     // type=etf
    let c_res = code(3);     // type=index（D11-6 保留位）
    for c in [&c_default, &c_etf, &c_res] {
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(c).execute(&pool).await.unwrap();
    }

    // F1 既有形态（无 type 字段）仍 201 且其余字段语义不变
    let r = http.post(format!("{url}/api/symbols"))
        .json(&json!({ "code": c_default, "name": "T13 no-type", "interval_secs": 60, "settlement": "T1" }))
        .send().await.unwrap();
    let st = r.status().as_u16();
    let body: Value = r.json().await.unwrap();
    println!("EV F1.register_no_type status={st} type={} interval={} settlement={} enabled={}",
        body["type"], body["interval_secs"], body["settlement"], body["enabled"]);
    assert_eq!(st, 201);
    assert!(body["type"].is_null(), "未传 type → null（不得静默填默认）");
    assert_eq!(body["interval_secs"], json!(60));
    assert_eq!(body["settlement"], json!("T1"));
    assert_eq!(body["enabled"], json!(true));
    let db_ty: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
        .bind(&c_default).fetch_one(&pool).await.unwrap();
    assert_eq!(db_ty, None, "DB 侧 type 确为 NULL（无默认值）");

    // F2 枚举/空串拒绝（400）
    for (i, bad) in ["foo", "ETF", "stockx", ""].iter().enumerate() {
        let c = code(10 + i as u32); // 6 位：4 位前缀 + 2 位 tag
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(&c).execute(&pool).await.unwrap();
        let r = http.post(format!("{url}/api/symbols"))
            .json(&json!({ "code": c, "type": bad }))
            .send().await.unwrap();
        let s = r.status().as_u16();
        let t = r.text().await.unwrap();
        println!("EV F2.register_bad_type type={bad:?} status={s} body={t}");
        assert_eq!(s, 400, "非法 type 须 400（{bad:?}）");
        assert!(t.contains("type"), "400 须因 type 校验（got {t}）");
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM symbols WHERE code = $1")
            .bind(&c).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0, "被拒请求不得落库");
    }
    let leaked: i64 = sqlx::query_scalar("SELECT count(*) FROM symbols WHERE code = $1")
        .bind(code(4)).fetch_one(&pool).await.unwrap();
    assert_eq!(leaked, 0, "被拒请求不得落库");

    // F3 合法枚举（含 D11-6 保留位）落库
    let r = http.post(format!("{url}/api/symbols"))
        .json(&json!({ "code": c_etf, "name": "T13 etf", "type": "etf", "interval_secs": 60 }))
        .send().await.unwrap();
    let st = r.status().as_u16();
    let b: Value = r.json().await.unwrap();
    println!("EV F3.register_type_etf status={st} type={}", b["type"]);
    assert_eq!((st, b["type"].as_str()), (201, Some("etf")));
    let r = http.post(format!("{url}/api/symbols"))
        .json(&json!({ "code": c_res, "name": "T13 index", "type": "index", "interval_secs": 60 }))
        .send().await.unwrap();
    assert_eq!(r.status().as_u16(), 201, "D11-6 保留位可登记");
    let db_res: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
        .bind(&c_res).fetch_one(&pool).await.unwrap();
    assert_eq!(db_res.as_deref(), Some("index"));

    // ═══ G. PATCH type ═══
    let r = http.patch(format!("{url}/api/symbols/{c_etf}"))
        .json(&json!({ "type": "stock" })).send().await.unwrap();
    let st = r.status().as_u16();
    let b: Value = r.json().await.unwrap();
    println!("EV G1.patch_type status={st} type={}", b["type"]);
    assert_eq!((st, b["type"].as_str()), (200, Some("stock")));
    // 未给 type → 保留（既有字段语义不受影响）
    let r = http.patch(format!("{url}/api/symbols/{c_etf}"))
        .json(&json!({ "enabled": false })).send().await.unwrap();
    let b: Value = r.json().await.unwrap();
    println!("EV G2.patch_no_type type={} enabled={}", b["type"], b["enabled"]);
    assert_eq!(b["type"].as_str(), Some("stock"), "未给 type 应保留（COALESCE）");
    assert_eq!(b["enabled"], json!(false));
    // 非法 / 空串 → 400
    for bad in ["bogus", ""] {
        let r = http.patch(format!("{url}/api/symbols/{c_etf}"))
            .json(&json!({ "type": bad })).send().await.unwrap();
        println!("EV G3.patch_bad_type type={bad:?} status={}", r.status().as_u16());
        assert_eq!(r.status().as_u16(), 400);
    }
    let db_ty: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
        .bind(&c_etf).fetch_one(&pool).await.unwrap();
    assert_eq!(db_ty.as_deref(), Some("stock"), "被拒 PATCH 不得改动");

    // ═══ H. web 试算省略 fee → profile（与 MCP 同解析点，落盘对拍）═══
    let tr = |fee: Option<Value>| {
        let mut v = json!({
            "code": CONST_BUY, "symbol": ETF, "period": "D1",
            "from": "2026-06-15T00:00:00Z", "to": "2026-09-11T00:00:00Z",
            "mode": "sim_position", "warmup_bars": 0,
            "policy": { "LumpSum": { "position_pct": 1.0 } }, "initial_capital": 100000.0 });
        if let Some(f) = fee { v["fee"] = f; }
        v
    };
    let r = http.post(format!("{url}/api/strategies/test-run")).json(&tr(None)).send().await.unwrap();
    let st = r.status().as_u16();
    let h1: Value = r.json().await.unwrap();
    println!("EV H1.web_profile status={st} fee={}", h1["fee"]);
    assert_eq!(st, 200);
    assert_eq!(h1["fee"]["source"], json!("profile"));
    assert_eq!(h1["fee"]["stamp_duty_pct"], json!(0.0));
    dump("web_H1_profile_test_run.json", &h1);

    let r = http.post(format!("{url}/api/strategies/test-run"))
        .json(&tr(Some(json!({ "rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0 }))))
        .send().await.unwrap();
    let h2: Value = r.json().await.unwrap();
    println!("EV H2.web_explicit fee={}", h2["fee"]);
    assert_eq!(h2["fee"]["source"], json!("explicit"));
    assert_eq!(h2["fee"]["stamp_duty_pct"], json!(0.05));
    dump("web_H2_explicit_test_run.json", &h2);

    // ═══ H3. web 通道：未注册但**有 K 线**的标的省略 fee → default（MCP 侧被注册表门禁拒绝）═══
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM symbols WHERE code = '999999'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0, "999999 应未注册（造数 K 线，无 symbols 行）");
    let mut h3req = tr(None);
    h3req["symbol"] = json!("999999");
    let r = http.post(format!("{url}/api/strategies/test-run")).json(&h3req).send().await.unwrap();
    let st = r.status().as_u16();
    let h3: Value = r.json().await.unwrap();
    println!("EV H3.web_unregistered status={st} fee={}", h3["fee"]);
    assert_eq!(st, 200, "web 试算无注册表门禁（服务层口径），应成功");
    assert_eq!(h3["fee"]["source"], json!("default"));
    assert_eq!(h3["fee"]["stamp_duty_pct"], json!(0.05));
    assert!(h3["fee"]["symbol_type"].is_null());
    dump("web_H3_unregistered_default.json", &h3);

    // ═══ I. 工作台提交省略 fee → 钉住 config.fee ═══
    let vid = create_published(&http, &url, &format!("TESTER013-D11-web-{}", std::process::id())).await;
    let body = json!({
        "name": "tester013-web", "symbol": ETF, "period": "D1",
        "from": "2026-06-15T00:00:00Z", "to": "2026-09-11T00:00:00Z",
        "slots": [{ "version_id": vid, "params": {}, "weight": 1.0 }],
        "policy": { "LumpSum": { "position_pct": 1.0 } }, "warmup_bars": 0 });
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let st = r.status().as_u16();
    let run: Value = r.json().await.unwrap();
    println!("EV I1.web_workbench status={st} config.fee={}", run["config"]["fee"]);
    assert_eq!(st, 201);
    assert_eq!(run["config"]["fee"]["source"], json!("profile"));
    assert_eq!(run["config"]["fee"]["stamp_duty_pct"], json!(0.0));
    let run_id = run["id"].as_str().unwrap().to_string();
    dump("web_I1_workbench_submit.json", &run);

    // 回读一致
    let g: Value = http.get(format!("{url}/api/workbench/runs/{run_id}")).send().await.unwrap().json().await.unwrap();
    let gf = g["config"]["fee"].clone();
    println!("EV I2.web_workbench_get config.fee={gf} status={}", g["status"]);
    assert_eq!(gf["source"], json!("profile"));
    assert_eq!(gf, run["config"]["fee"], "提交与回读 config.fee 必须一致");
    dump("web_I2_workbench_get.json", &g);

    // 等待结束（避免残留 running 行影响清理判定）
    for _ in 0..60 {
        let g: Value = http.get(format!("{url}/api/workbench/runs/{run_id}")).send().await.unwrap().json().await.unwrap();
        let s = g["status"].as_str().unwrap_or("").to_string();
        if matches!(s.as_str(), "done" | "succeeded" | "failed" | "cancelled") {
            println!("EV I3.web_workbench final_status={s}");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // ── 清理（仅探针库）──
    for c in [&c_default, &c_etf, &c_res] {
        sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(c).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(c).execute(&pool).await.unwrap();
    }
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(ETF).execute(&pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' WHERE strategy_id IN \
                 (SELECT id FROM strategy WHERE name LIKE 'TESTER013-D11%')")
        .execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE 'TESTER013-D11%'").execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM strategy_run WHERE name LIKE 'tester013%'").execute(&pool).await.unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM symbols WHERE code LIKE '99%' AND code <> '999999'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0, "测试标的须清理干净");
    println!("EV CLEANUP symbols_left={left}");
    println!("EV DONE web 通道验收完成");
}
