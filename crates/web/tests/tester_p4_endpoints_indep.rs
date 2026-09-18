//! **tester 独立验收**（ADR-024 P4 / D8-D10）——结果读取端点（真实 axum server + 临时库）。
//! ⚠️ 非 tangle 手写；由 tester 独立编写，**不复用** worker `crates/web/tests/api_workbench.rs` 的断言。
//!
//! 覆盖：
//!   A. 真实写路径 run（5001 根 = 5000 + 1 块）：分块结构/seq/ts_from·ts_to（直查 DB）+ 分页边界
//!      （恰好一整块 / 跨块 / 越界 / 超上限）+ 区间读跨块外沿 + 逐页拼接无重复无缺失；
//!   B. `/result` 兼容矩阵（chunked 首页 + has_more + next_offset；**不得静默读空**）；
//!   C. 手工 `legacy_single` 行（内联三列）双读全量；
//!   D. 手工 `chunked_v1` 异构块（[7000,3000]）——**唯一写路径不变量探针**（记录实际行为，非契约违约）；
//!   E. `/curve` 抽样（保首尾 / downsampled / original_bars / k 缺省·上限·边界）；
//!   F. `/compare` 净值抽样标记。
//!
//! 所有造出的 run 均以 `tp4w<pid>_` 前缀；测试结束 `DELETE FROM strategy_run` 收尾（FK 级联清结果/分块）。

use chrono::{DateTime, Duration, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 30, 0).unwrap()
}

fn pfx(tag: &str) -> String {
    format!("tp4w{}_{tag}", std::process::id())
}

async fn pool() -> PgPool {
    test_support::test_pool().await
}

const CONST_SCORE: &str = r#"
const PARAMS_SCHEMA = [
  { key: "score", type: "float", default: 80, min: 0, max: 100, description: "恒分" }
];
function on_bar(ctx) { return ctx.params.score; }
"#;

fn state(pool: PgPool) -> Arc<AppState> {
    let hub = WsHub::new();
    let strategy_store = Arc::new(storage::strategy::PgStrategyStore::new(pool.clone()));
    let strategies = Arc::new(application::strategy::StrategyService::new(
        strategy_store.clone(),
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(domain::ports::SystemClock),
    ));
    let workbench_ws: Arc<dyn domain::ports::StrategyRunProgressSink> =
        Arc::new(web::workbench::WorkbenchWsSink::new(hub.clone()));
    let workbench = Arc::new(application::workbench::WorkbenchService::new(
        Arc::new(storage::backtest::BacktestBarReader::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
        strategy_store,
        Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
        workbench_ws,
        Arc::new(domain::ports::SystemClock),
        application::workbench::DEFAULT_MAX_CONCURRENT,
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

async fn get_json(http: &reqwest::Client, url: &str) -> Value {
    let r = http.get(url).send().await.unwrap();
    assert_eq!(r.status(), 200, "GET {url} 应 200: {:?}", r.text().await);
    r.json().await.unwrap()
}

async fn seed_symbol_and_m1(pool: &PgPool, code: &str, n: i64) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
         SELECT $1, $2::timestamptz + (i::text || ' minutes')::interval, 'M1', \
                100,100,100,100,100,100.0,'tushare' FROM generate_series(0, $3 - 1) AS i")
        .bind(code).bind(base()).bind(n).execute(pool).await.unwrap();
}

async fn create_published(http: &reqwest::Client, url: &str, name: &str, code: &str) -> String {
    let r = http.post(format!("{url}/api/strategies"))
        .json(&json!({ "name": name, "code": code })).send().await.unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    let vid = r.json::<Value>().await.unwrap()["version"]["id"].as_str().unwrap().to_string();
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish")).send().await.unwrap();
    assert_eq!(r.status(), 200, "publish 应 200: {:?}", r.text().await);
    vid
}

async fn wait_terminal(http: &reqwest::Client, url: &str, id: &str) -> Value {
    for _ in 0..1500 {
        let v = get_json(http, &format!("{url}/api/workbench/runs/{id}")).await;
        let s = v["status"].as_str().unwrap();
        if matches!(s, "succeeded" | "failed" | "canceled") {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("run {id} 30s 未达终态");
}

async fn clean(pool: &PgPool, code: &str, name_prefix: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy_run WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

/// 期望的 bar ts 序列（M1，逐分钟）：ts[i] = base() + i 分钟。
fn expect_ts(n: i64) -> Vec<DateTime<Utc>> {
    (0..n).map(|i| base() + Duration::minutes(i)).collect()
}

fn epoch(t: DateTime<Utc>) -> i64 {
    t.timestamp()
}

fn rfc(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true) // `Z` 形式（`+00:00` 的 `+` 在 query 中会被解码为空格）
}

/// 手工造 `strategy_run` 行（不跑引擎）。
async fn craft_run(pool: &PgPool, id: &str, name: &str, symbol: &str, status: &str) {
    sqlx::query(
        "INSERT INTO strategy_run (id, name, symbol, period, from_ts, to_ts, config, status, progress, \
                                   created_at, started_at, finished_at) \
         VALUES ($1, $2, $3, 'M1', $4, $5, '{}'::jsonb, $6, 1.0, now(), now(), now())")
        .bind(id).bind(name).bind(symbol)
        .bind(base()).bind(base() + Duration::days(1)).bind(status)
        .execute(pool).await.unwrap();
}

fn per_bar_obj(ts: DateTime<Utc>) -> Value {
    json!({"ts": epoch(ts), "scores": [], "aggregate": 80.0, "signal": "Hold",
           "orders": [], "events": []})
}

// ───────────────────────── A. 真实写路径 run（5001 根） ─────────────────────────

#[tokio::test]
async fn t_p4_real_run_chunked_endpoints_independent() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("82{}", std::process::id() % 10000);
    let p = pfx("real");
    clean(&pool, &code, &p).await;

    let n = 5010i64; // 块结构：5000 + 10（跨块边界，末块留足区间读空间）
    seed_symbol_and_m1(&pool, &code, n).await;
    let vid = create_published(&http, &url, &format!("{p}-const"), CONST_SCORE).await;

    let body = json!({
        "symbol": code, "period": "M1",
        "from": base().to_rfc3339(), "to": (base() + Duration::minutes(n)).to_rfc3339(),
        "slots": [{"version_id": vid, "params": {}, "weight": 1.0}],
        "policy": {"LumpSum": {"position_pct": 1.0}},
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
        "warmup_bars": 0,
    });
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 201, "submit 应 201: {:?}", r.text().await);
    let run_id = r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(wait_terminal(&http, &url, &run_id).await["status"], "succeeded", "真实 run 应成功");

    // ── A1. 直查 DB：分块结构 / seq 单调 / ts_from·ts_to = 本块首末 bar ts ──
    let rows: Vec<(String, i32, DateTime<Utc>, DateTime<Utc>, i32)> = sqlx::query_as(
        "SELECT kind, seq, ts_from, ts_to, jsonb_array_length(payload) \
         FROM strategy_run_bars WHERE run_id = $1 ORDER BY kind, seq")
        .bind(&run_id).fetch_all(&pool).await.unwrap();
    let per_bar: Vec<_> = rows.iter().filter(|r| r.0 == "per_bar").collect();
    assert_eq!(per_bar.len(), 2, "{n} 根 ⇒ 2 块；实际 {:?}", rows);
    assert_eq!(per_bar[0].1, 0, "seq 自 0 起");
    assert_eq!(per_bar[1].1, 1, "seq 单调递增");
    assert_eq!(per_bar[0].4, 5000, "非末块恰 5000 根");
    assert_eq!(per_bar[1].4, (n - 5000) as i32, "末块 n-5000 根");
    let all = expect_ts(n);
    assert_eq!(per_bar[0].2, all[0], "ts_from = 本块首根 bar ts");
    assert_eq!(per_bar[0].3, all[4999], "ts_to = 本块末根 bar ts");
    assert_eq!(per_bar[1].2, all[5000], "末块 ts_from = 第 5001 根 bar ts");
    assert_eq!(per_bar[1].3, all[(n - 1) as usize], "末块 ts_to = 末根 bar ts");
    for kind in ["net_value", "drawdown"] {
        let k: Vec<_> = rows.iter().filter(|r| r.0 == kind).collect();
        assert_eq!(k.len(), 2, "{kind} 亦分块（5000+1）");
        assert_eq!(k[0].4, 5000);
        assert_eq!(k[1].4, (n - 5000) as i32);
        assert_eq!(k[0].2, all[0]);
        assert_eq!(k[1].3, all[(n - 1) as usize]);
    }

    // ── A2. /brief 字段齐备 ──
    let b = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/brief")).await;
    for key in ["id", "name", "symbol", "period", "status", "progress", "error", "created_at",
                "started_at", "finished_at", "requested_from", "requested_to", "effective_from",
                "effective_to", "clamped", "estimated_bars", "bars_total", "result_format",
                "chunk_count", "metrics"] {
        assert!(b.get(key).is_some(), "/brief 缺字段 {key}: {b}");
    }
    assert_eq!(b["status"], "succeeded");
    assert_eq!(b["progress"], 1.0);
    assert!(b["error"].is_null());
    assert_eq!(b["result_format"], "chunked_v1");
    assert_eq!(b["bars_total"], n);
    assert_eq!(b["chunk_count"], 2);
    // ADR-024 P5：区间按可得范围收缩；本用例请求 to = base+n 分钟，而末 bar ts = base+(n-1) 分钟
    // ⇒ 右端被夹（avail.to = max ts + 1s）；from 对齐 ⇒ 左端不夹。
    assert_eq!(b["clamped"], true, "P5：请求 to 超出可得右端 ⇒ clamped=true");
    assert_eq!(b["effective_from"], b["requested_from"], "左端对齐 ⇒ effective_from == requested_from");
    assert_eq!(
        b["effective_to"],
        json!(rfc(all[(n - 1) as usize] + Duration::seconds(1))),
        "effective_to = 末 bar ts + 1s（可得右端）"
    );
    assert_eq!(b["estimated_bars"], json!(n), "P5/D12：count 预扫描回显精确 total");
    assert!(b["metrics"].is_object());
    assert_eq!(b["symbol"], code);
    assert_eq!(b["period"], "M1");

    // ── A3. /result：首页 + has_more + next_offset（不得静默读空） ──
    let rc = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/result")).await;
    assert_eq!(rc["result_format"], "chunked_v1");
    assert_eq!(rc["summary"]["bars_total"], n);
    assert_eq!(rc["summary"]["chunk_count"], 2);
    assert_eq!(rc["summary"]["result_format"], "chunked_v1");
    assert_eq!(rc["per_bar"].as_array().unwrap().len(), 5000, "首页 per_bar = 一整块");
    assert_eq!(rc["per_bar"][0]["ts"], epoch(all[0]), "首页首根 = 首 bar（非占位/非空）");
    assert_eq!(rc["per_bar"][4999]["ts"], epoch(all[4999]), "首页末根 = 第 5000 根");
    assert_eq!(rc["has_more"], true, "显式 has_more（非静默截断）");
    assert_eq!(rc["next_offset"], 5000);
    assert!(rc["metrics"].is_object(), "metrics 齐备");
    assert!(rc["trades"].is_array());
    // 与 /bars 首页逐值一致（两路径同源）
    let pb = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset=0&limit=5000")).await;
    assert_eq!(rc["per_bar"], pb["bars"], "/result 首页 == /bars 首页");

    // ── A4. /bars 分页边界：恰好一整块 / 跨块 / 越界 / 超上限 ──
    let exact = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&limit=5000")).await;
    assert_eq!(exact["bars"].as_array().unwrap().len(), 5000, "limit 恰好一整块");
    assert_eq!(exact["limit"], 5000);
    assert_eq!(exact["has_more"], true);

    let cross = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset=4999&limit=2")).await;
    assert_eq!(cross["bars"].as_array().unwrap().len(), 2, "跨块 2 根");
    assert_eq!(cross["bars"][0]["ts"], epoch(all[4999]), "跨块第 1 根 = 块 0 末根");
    assert_eq!(cross["bars"][1]["ts"], epoch(all[5000]), "跨块第 2 根 = 块 1 首根（无重复/无缺失）");
    assert_eq!(cross["has_more"], true);
    assert_eq!(cross["next_offset"], 5001, "跨块页的 next_offset = offset+返回数");

    // 跨块 + 末页（has_more=false 的跨块读）
    let ctail = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset=5009&limit=2")).await;
    assert_eq!(ctail["bars"].as_array().unwrap().len(), 1);
    assert_eq!(ctail["bars"][0]["ts"], epoch(all[(n - 1) as usize]));
    assert_eq!(ctail["has_more"], false);
    assert!(ctail["next_offset"].is_null());

    let tail = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset=5000&limit=5000")).await;
    assert_eq!(tail["bars"].as_array().unwrap().len(), (n - 5000) as usize, "末页 n-5000 根");
    assert_eq!(tail["bars"][0]["ts"], epoch(all[5000]));
    assert_eq!(tail["has_more"], false);
    assert!(tail["next_offset"].is_null());

    let beyond = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset={n}&limit=5000")).await;
    assert_eq!(beyond["bars"].as_array().unwrap().len(), 0, "超末尾 ⇒ 空页");
    assert_eq!(beyond["has_more"], false);
    assert!(beyond["next_offset"].is_null());
    assert_eq!(beyond["total"], n, "total 不因越界变化");

    let clamp = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset=0&limit=99999")).await;
    assert_eq!(clamp["limit"], 20000, "limit 上限 20000（回显钳制后值）");
    assert_eq!(clamp["bars"].as_array().unwrap().len(), n as usize, "上限内一次取全");
    assert_eq!(clamp["has_more"], false);

    // 逐页拼接（limit=1000）无重复/无缺失，且严格递增
    let mut got_ts = Vec::new();
    let mut off = 0i64;
    loop {
        let page = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset={off}&limit=1000")).await;
        let arr = page["bars"].as_array().unwrap();
        got_ts.extend(arr.iter().map(|v| v["ts"].as_i64().unwrap()));
        if page["has_more"] == false {
            assert!(page["next_offset"].is_null());
            break;
        }
        off = page["next_offset"].as_i64().unwrap();
    }
    assert_eq!(got_ts.len(), n as usize, "逐页拼接总数");
    assert_eq!(got_ts, all.iter().map(|t| epoch(*t)).collect::<Vec<_>>(), "逐页拼接逐值等于期望序列（无重复/无缺失）");

    // ── A5. 区间读：跨块交集 + 块外沿精确过滤 ──
    let rg = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&from={}&to={}",
        rfc(all[4998]), rfc(all[5003]))).await;
    assert_eq!(rg["bars"].as_array().unwrap().len(), 6, "跨块交集 6 根");
    let rg_ts: Vec<i64> = rg["bars"].as_array().unwrap().iter().map(|v| v["ts"].as_i64().unwrap()).collect();
    assert_eq!(rg_ts, all[4998..=5003].iter().map(|t| epoch(*t)).collect::<Vec<_>>(), "块外沿按 ts 精确过滤（无重复/无缺失）");
    assert_eq!(rg["from"], json!(rfc(all[4998])), "区间回声 from");
    assert_eq!(rg["to"], json!(rfc(all[5003])), "区间回声 to");
    assert_eq!(rg["total"], 6);
    assert_eq!(rg["has_more"], false);

    let one = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&from={}&to={}",
        rfc(all[0]), rfc(all[0]))).await;
    assert_eq!(one["bars"].as_array().unwrap().len(), 1, "闭区间单点");

    let empty = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&from={}&to={}",
        rfc(all[0] + Duration::days(10)), rfc(all[0] + Duration::days(11)))).await;
    assert_eq!(empty["bars"].as_array().unwrap().len(), 0, "区间无数据 ⇒ 空（非报错）");
    assert_eq!(empty["total"], 0);

    // 区间读 == 分页切片（交叉复核）
    let slice = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset=4990&limit=20")).await;
    let rg2 = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&from={}&to={}",
        rfc(all[4990]), rfc(all[5009]))).await;
    assert_eq!(rg2["bars"], slice["bars"], "区间读与分页切片逐值一致");

    // 互斥 / 非法参数 400
    for (q, why) in [
        (format!("kind=per_bar&offset=0&from={}&to={}", rfc(all[0]), rfc(all[9])), "offset/limit 与 from/to 互斥"),
        ("kind=per_bar&from=".to_string() + &rfc(all[0]), "只给 from"),
        ("kind=bogus".to_string(), "非法 kind"),
        (format!("kind=per_bar&from={}&to={}", rfc(all[9]), rfc(all[0])), "from>to"),
        (format!("kind=per_bar&from=not-a-time&to={}", rfc(all[9])), "from 非 RFC3339"),
    ] {
        let r = http.get(format!("{url}/api/workbench/runs/{run_id}/bars?{q}")).send().await.unwrap();
        assert_eq!(r.status(), 400, "{why} 应 400: {q}");
    }

    // ── A6. /curve 抽样（保首尾 / 标注 / 缺省·上限·边界） ──
    let full_net = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/curve?kind=net_value&k=20000")).await;
    assert_eq!(full_net["original_bars"], n, "net_value 与 per_bar 同根数");
    assert_eq!(full_net["downsampled"], false, "k >= n ⇒ 未抽样");
    assert_eq!(full_net["points"].as_array().unwrap().len(), n as usize);
    assert_eq!(full_net["k"], 20000);

    let c7 = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/curve?kind=net_value&k=7")).await;
    let pts = c7["points"].as_array().unwrap();
    assert_eq!(pts.len(), 7, "k=7 ⇒ 7 点");
    assert_eq!(c7["downsampled"], true);
    assert_eq!(c7["original_bars"], n);
    assert_eq!(c7["k"], 7);
    assert_eq!(pts[0], full_net["points"][0], "均匀抽样保首（端点保留）");
    assert_eq!(pts[6], full_net["points"][(n - 1) as usize], "均匀抽样保尾（端点保留）");
    let ts_of = |p: &Value| p.as_array().unwrap()[0].as_i64().unwrap();
    assert_eq!(ts_of(&pts[0]), epoch(all[0]));
    assert_eq!(ts_of(&pts[6]), epoch(all[(n - 1) as usize]));
    let mut strictly_inc = true;
    for w in pts.windows(2) {
        if ts_of(&w[0]) >= ts_of(&w[1]) {
            strictly_inc = false;
        }
    }
    assert!(strictly_inc, "抽样点 ts 严格递增（无重复点）");

    let cdef = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/curve?kind=net_value")).await;
    assert_eq!(cdef["k"], 2000, "缺省 k=2000");
    assert_eq!(cdef["points"].as_array().unwrap().len(), 2000);
    assert_eq!(cdef["downsampled"], true);
    assert_eq!(cdef["original_bars"], n);

    let ckind = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/curve?kind=drawdown&k=100")).await;
    assert_eq!(ckind["kind"], "drawdown");
    assert_eq!(ckind["original_bars"], n);
    assert_eq!(ckind["points"].as_array().unwrap().len(), 100);

    // 边界观察（非契约硬约束，记录实际行为）：k=1 / k=0
    let k1 = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/curve?kind=net_value&k=1")).await;
    println!("[probe] /curve k=1 → k={} points={} downsampled={}",
        k1["k"], k1["points"].as_array().unwrap().len(), k1["downsampled"]);
    let k0 = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/curve?kind=net_value&k=0")).await;
    println!("[probe] /curve k=0 → k={} points={} downsampled={}",
        k0["k"], k0["points"].as_array().unwrap().len(), k0["downsampled"]);
    assert_eq!(k0["k"], 1, "k=0 被钳到下限 1");
    // 非法 kind
    let r = http.get(format!("{url}/api/workbench/runs/{run_id}/curve?kind=bogus")).send().await.unwrap();
    assert_eq!(r.status(), 400, "curve 非法 kind ⇒ 400");

    // ── A7. /compare 净值抽样 + 标记 ──
    let r = http.post(format!("{url}/api/workbench/runs/compare"))
        .json(&json!({"ids": [run_id], "k": 50})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let items: Value = r.json().await.unwrap();
    assert_eq!(items[0]["run_id"], run_id);
    assert_eq!(items[0]["downsampled"], true, "compare 净值走抽样且带标记");
    assert_eq!(items[0]["original_bars"], n);
    assert_eq!(items[0]["net_value"].as_array().unwrap().len(), 50);
    assert_eq!(items[0]["net_value"][0], full_net["points"][0], "compare 保首");
    assert_eq!(items[0]["net_value"][49], full_net["points"][(n - 1) as usize], "compare 保尾");
    assert!(items[0]["metrics"].is_object());
    let r = http.post(format!("{url}/api/workbench/runs/compare"))
        .json(&json!({"ids": [run_id]})).send().await.unwrap();
    let def: Value = r.json().await.unwrap();
    assert_eq!(def[0]["net_value"].as_array().unwrap().len(), 2000, "compare 缺省 k=2000（禁止 N×全量）");

    clean(&pool, &code, &p).await;
}

// ───────────────── B/C/D. 手工造行：legacy 双读 + chunked 静默读空 + 异构块探针 ─────────────────

#[tokio::test]
async fn t_p4_crafted_legacy_and_chunked_dual_read_independent() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let p = pfx("craft");
    let code = format!("83{}", std::process::id() % 10000);
    clean(&pool, &code, &p).await;

    // ── (1) legacy_single（旧 run，内联三列全量） ──
    let lid = format!("{p}_legacy");
    craft_run(&pool, &lid, &format!("{p}-legacy"), &code, "succeeded").await;
    let l_ts = expect_ts(3);
    let l_pb: Vec<Value> = l_ts.iter().map(|t| per_bar_obj(*t)).collect();
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, trades, net_value, drawdown, metrics, result_format) \
         VALUES ($1, $2::jsonb, '[]'::jsonb, $3::jsonb, $4::jsonb, '{\"total_return_pct\":1.0}'::jsonb, 'legacy_single')")
        .bind(&lid)
        .bind(serde_json::to_string(&l_pb).unwrap())
        .bind(serde_json::to_string(&json!([[epoch(l_ts[0]), 100000.0], [epoch(l_ts[1]), 100010.0], [epoch(l_ts[2]), 100020.0]])).unwrap())
        .bind(serde_json::to_string(&json!([[epoch(l_ts[0]), 0.0], [epoch(l_ts[1]), -0.01], [epoch(l_ts[2]), -0.02]])).unwrap())
        .execute(&pool).await.unwrap();

    let lr = get_json(&http, &format!("{url}/api/workbench/runs/{lid}/result")).await;
    assert_eq!(lr["result_format"], "legacy_single");
    assert_eq!(lr["per_bar"].as_array().unwrap().len(), 3, "legacy ⇒ 全量 per_bar");
    assert_eq!(lr["per_bar"], json!(l_pb));
    assert_eq!(lr["net_value"].as_array().unwrap().len(), 3, "legacy ⇒ 全量净值");
    assert_eq!(lr["net_value"][2][1], 100020.0);
    assert_eq!(lr["drawdown"].as_array().unwrap().len(), 3, "legacy ⇒ 全量回撤");
    assert_eq!(lr["has_more"], false);
    assert!(lr["next_offset"].is_null());
    assert_eq!(lr["summary"]["bars_total"], 3);
    assert_eq!(lr["summary"]["chunk_count"], 0, "legacy 无分块行");
    assert_eq!(lr["summary"]["result_format"], "legacy_single");

    let lb = get_json(&http, &format!("{url}/api/workbench/runs/{lid}/brief")).await;
    assert_eq!(lb["status"], "succeeded");
    assert_eq!(lb["result_format"], "legacy_single");
    assert_eq!(lb["chunk_count"], 0);
    assert_eq!(lb["bars_total"], 3);

    let lpage = get_json(&http, &format!("{url}/api/workbench/runs/{lid}/bars?kind=per_bar&offset=1&limit=1")).await;
    assert_eq!(lpage["bars"].as_array().unwrap().len(), 1);
    assert_eq!(lpage["bars"][0]["ts"], epoch(l_ts[1]), "legacy 分页亦可用");
    assert_eq!(lpage["total"], 3);
    assert_eq!(lpage["has_more"], true);
    assert_eq!(lpage["next_offset"], 2);

    let lcurve = get_json(&http, &format!("{url}/api/workbench/runs/{lid}/curve?kind=net_value&k=2")).await;
    assert_eq!(lcurve["downsampled"], true);
    assert_eq!(lcurve["original_bars"], 3);
    assert_eq!(lcurve["points"].as_array().unwrap().len(), 2);
    assert_eq!(lcurve["points"][0][1], 100000.0, "legacy 抽样保首尾（取值非占位）");
    assert_eq!(lcurve["points"][1][1], 100020.0);
    // 旧 run 不回填分块
    let cnt: (i64,) = sqlx::query_as("SELECT count(*) FROM strategy_run_bars WHERE run_id = $1")
        .bind(&lid).fetch_one(&pool).await.unwrap();
    assert_eq!(cnt.0, 0, "legacy run 无分块行（双读不回填）");

    // ── (2) chunked_v1（手工造真形态：占位三列 + 分块表） ──
    let cid = format!("{p}_chunked");
    craft_run(&pool, &cid, &format!("{p}-chunked"), &code, "succeeded").await;
    let n = 5001i64;
    let c_ts = expect_ts(n);
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, trades, net_value, drawdown, metrics, result_format) \
         VALUES ($1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{\"total_return_pct\":2.0}'::jsonb, 'chunked_v1')")
        .bind(&cid).execute(&pool).await.unwrap();
    let chunk_a: Vec<Value> = c_ts[..5000].iter().map(|t| per_bar_obj(*t)).collect();
    let chunk_b: Vec<Value> = c_ts[5000..].iter().map(|t| per_bar_obj(*t)).collect();
    for (seq, payload, a, b) in [(0i32, chunk_a, c_ts[0], c_ts[4999]), (1, chunk_b, c_ts[5000], c_ts[5000])] {
        sqlx::query(
            "INSERT INTO strategy_run_bars (run_id, kind, seq, ts_from, ts_to, payload) \
             VALUES ($1, 'per_bar', $2, $3, $4, $5::jsonb)")
            .bind(&cid).bind(seq).bind(a).bind(b)
            .bind(serde_json::to_string(&payload).unwrap()).execute(&pool).await.unwrap();
    }

    // 「不得把三列占位当数据返回」：/result 必须给出 summary + 首页 bars + has_more + next_offset
    let cr = get_json(&http, &format!("{url}/api/workbench/runs/{cid}/result")).await;
    assert_eq!(cr["result_format"], "chunked_v1", "判别列显式");
    assert!(cr["summary"].is_object(), "chunked ⇒ 必带 summary");
    assert_eq!(cr["summary"]["result_format"], "chunked_v1");
    assert_eq!(cr["summary"]["bars_total"], n);
    assert_eq!(cr["summary"]["chunk_count"], 2);
    assert_eq!(cr["per_bar"].as_array().unwrap().len(), 5000, "首页 bars 非空（不得把 [] 占位当数据）");
    assert_eq!(cr["per_bar"][0]["ts"], epoch(c_ts[0]));
    assert_eq!(cr["has_more"], true, "显式 has_more");
    assert_eq!(cr["next_offset"], 5000);
    assert_eq!(cr["metrics"]["total_return_pct"], 2.0);
    // 记录 net_value/drawdown 的实际形态（chunked 下为空数组，客户端须以 result_format 判别 + 走 /curve）
    println!("[probe] /result(chunked_v1) net_value={} drawdown={}",
             cr["net_value"], cr["drawdown"]);
    assert_eq!(cr["net_value"], json!([]), "chunked：/result 不回内联净值（空数组占位形态，需以 result_format 判别）");
    assert_eq!(cr["drawdown"], json!([]));

    let cb = get_json(&http, &format!("{url}/api/workbench/runs/{cid}/brief")).await;
    assert_eq!(cb["result_format"], "chunked_v1");
    assert_eq!(cb["bars_total"], n);
    assert_eq!(cb["chunk_count"], 2);
    assert_eq!(cb["metrics"]["total_return_pct"], 2.0);

    // 分页/区间读在手工造行上同样成立（跨块外沿）
    let ccross = get_json(&http, &format!("{url}/api/workbench/runs/{cid}/bars?kind=per_bar&offset=4999&limit=2")).await;
    assert_eq!(ccross["bars"][0]["ts"], epoch(c_ts[4999]));
    assert_eq!(ccross["bars"][1]["ts"], epoch(c_ts[5000]));
    let crange = get_json(&http, &format!("{url}/api/workbench/runs/{cid}/bars?kind=per_bar&from={}&to={}",
        rfc(c_ts[4998]), rfc(c_ts[5000]))).await;
    assert_eq!(crange["bars"].as_array().unwrap().len(), 3, "跨块外沿：4998/4999 + 5000");
    assert_eq!(crange["bars"][2]["ts"], epoch(c_ts[5000]));

    clean(&pool, &code, &p).await;
}

/// **唯一写路径不变量探针**（worker 残余项 §7.6）：
/// storage 侧 `result_chunks(offset=chunk 序号)` 与 application 侧「bar offset → chunk 序号」映射
/// 依赖「非末块恰 5000 根」。本探针用**手工异构块**（[7000, 3000]）记录越界行为：
/// 结论用于判定该不变量是否为**显式契约**还是**隐式耦合**。非契约违约断言（真实写路径保证均匀块，
/// 见 A1 与 `strategy-core` `step 必产一条 per_bar 记录`）。
#[tokio::test]
async fn t_p4_probe_heterogeneous_chunk_size_invariant() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let p = pfx("hetero");
    let code = format!("84{}", std::process::id() % 10000);
    clean(&pool, &code, &p).await;

    let id = format!("{p}_hetero");
    craft_run(&pool, &id, &format!("{p}-hetero"), &code, "succeeded").await;
    let n = 10000i64; // 期望全量 10000 根；块大小 [7000, 3000]（违反「非末块恰 5000」）
    let ts = expect_ts(n);
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, net_value, drawdown, trades, metrics, result_format) \
         VALUES ($1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'chunked_v1')")
        .bind(&id).execute(&pool).await.unwrap();
    let c0: Vec<Value> = ts[..7000].iter().map(|t| per_bar_obj(*t)).collect();
    let c1: Vec<Value> = ts[7000..].iter().map(|t| per_bar_obj(*t)).collect();
    for (seq, payload, a, b) in [(0i32, c0, ts[0], ts[6999]), (1, c1, ts[7000], ts[9999])] {
        sqlx::query(
            "INSERT INTO strategy_run_bars (run_id, kind, seq, ts_from, ts_to, payload) \
             VALUES ($1, 'per_bar', $2, $3, $4, $5::jsonb)")
            .bind(&id).bind(seq).bind(a).bind(b)
            .bind(serde_json::to_string(&payload).unwrap()).execute(&pool).await.unwrap();
    }

    let brief = get_json(&http, &format!("{url}/api/workbench/runs/{id}/brief")).await;
    println!("[probe] 异构块 [7000,3000]：/brief bars_total={} chunk_count={}（真值 n=10000）",
             brief["bars_total"], brief["chunk_count"]);
    let page = get_json(&http, &format!("{url}/api/workbench/runs/{id}/bars?kind=per_bar&offset=6000&limit=2")).await;
    println!("[probe] 异构块 offset=6000&limit=2 → ts={:?}（期望 {:?}）",
             page["bars"].as_array().unwrap().iter().map(|v| v["ts"].as_i64().unwrap()).collect::<Vec<_>>(),
             vec![epoch(ts[6000]), epoch(ts[6001])]);
    println!("[probe] 异构块 has_more={} next_offset={} total={}", page["has_more"], page["next_offset"], page["total"]);

    // 观察项（不断言正确答案；仅断言「服务端不落 500 且返回的是 JSON」）
    assert!(page["bars"].is_array());

    // 对照：同数据但块大小均匀 [5000,5000] 时应完全正确
    let id2 = format!("{p}_uniform");
    craft_run(&pool, &id2, &format!("{p}-uniform"), &code, "succeeded").await;
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, net_value, drawdown, trades, metrics, result_format) \
         VALUES ($1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'chunked_v1')")
        .bind(&id2).execute(&pool).await.unwrap();
    let u0: Vec<Value> = ts[..5000].iter().map(|t| per_bar_obj(*t)).collect();
    let u1: Vec<Value> = ts[5000..].iter().map(|t| per_bar_obj(*t)).collect();
    for (seq, payload, a, b) in [(0i32, u0, ts[0], ts[4999]), (1, u1, ts[5000], ts[9999])] {
        sqlx::query(
            "INSERT INTO strategy_run_bars (run_id, kind, seq, ts_from, ts_to, payload) \
             VALUES ($1, 'per_bar', $2, $3, $4, $5::jsonb)")
            .bind(&id2).bind(seq).bind(a).bind(b)
            .bind(serde_json::to_string(&payload).unwrap()).execute(&pool).await.unwrap();
    }
    let b2 = get_json(&http, &format!("{url}/api/workbench/runs/{id2}/brief")).await;
    let p2 = get_json(&http, &format!("{url}/api/workbench/runs/{id2}/bars?kind=per_bar&offset=6000&limit=2")).await;
    assert_eq!(b2["bars_total"], n, "均匀块下 bars_total 正确");
    assert_eq!(p2["bars"][0]["ts"], epoch(ts[6000]), "均匀块下偏移映射正确");
    assert_eq!(p2["bars"][1]["ts"], epoch(ts[6001]));
    println!("[probe] 对照（均匀块 [5000,5000]）：bars_total={} ts={:?} ✓",
             b2["bars_total"], p2["bars"].as_array().unwrap().iter().map(|v| v["ts"].as_i64().unwrap()).collect::<Vec<_>>());

    clean(&pool, &code, &p).await;
}
