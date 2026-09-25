//! **健康端点契约锁定（应用面 `eestock-app`，axum 路由）** —— 手写（非 tangle）；**不连库**
//! （`PgPool::connect_lazy` 只建池不建连 ⇒ 路由表行为可测且零 DB 依赖）。
//!
//! 背景（本批项 1 依赖盘点结论）：应用面健康端点是 **`/healthz`**（`crates/web/src/lib.rs` 路由
//! `.route("/healthz", get(rest::healthz))` → `{"status":"ok"}`）；`GET /api/health` 走 `spa_fallback`
//! 的「`/api` 前缀一律 404 JSON」分支（**不是**端点）。全仓依赖盘点（代码 / compose / deploy 脚本 /
//! 前端 / MCP / 迁移 / 配置）零依赖 ⇒ 裁决：**不加 `/api/health` 别名**；口径写入
//! `design/07-app-plane/00-web-api.md` §1.1 与 `design/16-backtest-scalability/05-deploy-runbook.md` C1。
//!
//! 本文件把该结论**钉死**（任一被违反 ⇒ 红）：
//!  1. `GET /healthz` → 200 + `application/json` + 响应体 `{"status":"ok"}`（键集合锁定）；
//!  2. `GET /api/health` → **404**（禁别名；API 前缀不回退 index.html）；
//!  3. `/healthz` 只此一途：路由表不得出现 `/api/health`（源码级反回归，见文件末）。
//!
//! 与 `crates/app/tests/healthz_endpoint_contract_lock.rs`（数据面 `:8080` 手写最小 HTTP）配对：
//! 两面**同路径** `/healthz`，任一面的路径/响应体漂移都会红。

use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

/// 懒连接池：只建池、**不建连**（本文件不触碰任何 DB 服务；`/healthz` 与 404 分支皆不查库）。
fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy("postgres://nobody:nobody@127.0.0.1:1/none")
        .expect("connect_lazy 只解析连接串，不建连")
}

/// 测试装配（与 `api_rest.rs::state` 同结构；`sim/strategies/workbench` 留 None ⇒ 不涉及）。
fn state(pool: PgPool) -> Arc<AppState> {
    let backtest_hub = WsHub::new();
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
            app_version: env!("CARGO_PKG_VERSION").to_string(),
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
        strategies: None,
        workbench: None,
        static_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist"),
        health_window_secs: 3600,
        hub: backtest_hub,
        subs: SubscriptionRegistry::default(),
    })
}

async fn spawn(state: Arc<AppState>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn app_plane_healthz_200_exact_body_and_api_health_404() {
    let url = spawn(state(lazy_pool())).await;

    // ① 契约本体（逐键锁定：不得增删字段）
    let r = reqwest::get(format!("{url}/healthz")).await.unwrap();
    assert_eq!(r.status(), 200, "GET /healthz 必须 200");
    assert_eq!(
        r.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
        Some("application/json"),
        "content-type 必须为 application/json"
    );
    let v: serde_json::Value = r.json().await.unwrap();
    assert_eq!(v, serde_json::json!({ "status": "ok" }), "响应体锁定为 {{\"status\":\"ok\"}}");

    // ② 禁别名（spa_fallback：/api 前缀一律 404 JSON，不回退 index.html）
    let r2 = reqwest::get(format!("{url}/api/health")).await.unwrap();
    assert_eq!(r2.status(), 404, "`/api/health` 不得成为 `/healthz` 的别名（依赖盘点为零 ⇒ 不加）");
    let v2: serde_json::Value = r2.json().await.unwrap();
    assert_ne!(v2, serde_json::json!({ "status": "ok" }), "404 响应体不得与健康契约同形");
}

/// 源码级反回归（无 DB）：应用面路由表**只有** `/healthz` 一条健康路由，且**任何** `crates/web/src`
/// 文件都不得出现 `/api/health` 字面量（防「顺手加别名」而只改源码不补文档/契约）。
#[test]
fn app_plane_route_table_has_no_api_health_alias() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0usize;
    let mut hits: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&root).expect("read web/src") {
        let p = entry.expect("dir entry").path();
        if p.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let src = std::fs::read_to_string(&p).expect("read src file");
        checked += 1;
        if src.contains("/api/health") {
            hits.push(p.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    assert!(checked > 0, "必须真的读到 crates/web/src（否则本断言恒真，无鉴别力）");
    assert!(
        hits.is_empty(),
        "crates/web/src 不得出现 `/api/health`（本批裁决：无依赖 ⇒ 不加别名）：{hits:?}"
    );

    let lib = std::fs::read_to_string(root.join("lib.rs")).expect("read lib.rs");
    assert_eq!(
        lib.matches(".route(\"/healthz\"").count(),
        1,
        "应用面健康路由必须恰好一条 `/healthz`"
    );
}
