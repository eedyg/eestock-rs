//! **tester 独立验收**（ADR-024 P4+P6 并批重验）—— `/fills` 有界精确源（真实 axum server + 临时库）。
//! ⚠️ 非 tangle 手写；由 tester 独立编写，**不复用** worker `crates/web/tests/api_workbench.rs` 的断言。
//!
//! 覆盖（任务书 ② / ③）：
//!   A. 单块 `seq=0` / `total` / `ts_from·ts_to` / 元素字段 == **ADR-027 §5.4 v2 的 12 键**
//!      （`FillFact` 投影 + `ts`，精确集合，见 `FILL_KEYS_V2`）
//!      （含 `ts` == 对应 bar ts）；分页边界（0 / 恰好一页 / 跨页 / 超末尾 / 上限夹取）。
//!   B. 「无成交」（recorded=true,total=0）vs「未写」（recorded=false）可区分；
//!      legacy `legacy_single` 由内联 per_bar 事件派生（双读、不回填）。
//!   C. **决定性**：含「部分买入（position_pct<1）+ 部分卖出（未清仓）」的 run ⇒
//!      `/fills` 是**逐笔事实源**（含这两笔），而 `trades`（`/result.trades`）是**回合聚合行**：
//!      行数 ≠ 逐笔数、部分卖出没有单独行，但其金额字段按恒等式 I1 与逐笔对账相等（ADR-027 v2）。
//!   D. 反向防误用：`/curve?kind=fills` 与 `/bars?kind=fills` 必须 400 且提示走 `/fills`。
//!
//! 所有造出的 run 均以 `tp6f<pid>_` 前缀；测试结束 `DELETE FROM strategy_run` 收尾（FK 级联清结果/分块）。
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

/// 判别插件 A（决定性用例）：bar 0..=5 Buy(80)；bar 6..=8 Hold(50)（解冻）；bar ≥9 Buy(80)。
/// 配合 `position_pct=0.5` + 上涨价格路径 ⇒ 重快照目标 < 当前持仓 ⇒ **部分卖出（未清仓）**。
const PLUGIN_PARTIAL: &str = r#"
const PARAMS_SCHEMA = [];
function on_bar(ctx) {
  const i = ctx.index;
  if (i >= 6 && i <= 8) return 50;
  return 80;
}
"#;

/// 判别插件 B：三批 DCA 加仓（Buy 持续 3 bar，每 bar 一批），随后期末强平 ⇒ 4 笔成交。
const PLUGIN_BUY_HOLD: &str = r#"
const PARAMS_SCHEMA = [];
function on_bar(ctx) { return 80; }   // 恒 Buy
"#;

/// 判别插件 C：恒 Hold ⇒ **无成交**（但有 fills 空块 ⇒ recorded=true, total=0）。
const PLUGIN_HOLD_ONLY: &str = r#"
const PARAMS_SCHEMA = [];
function on_bar(ctx) { return 50; }   // 恒 Hold（不触发 Policy 订单）
"#;

/// 播种 symbols + kline_accurate（M1，自定义 close 序列；open=close，high/low ±1）。
async fn seed_symbol_and_prices(pool: &PgPool, code: &str, closes: &[f64], ts0: DateTime<Utc>) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
         SELECT $1, $2::timestamptz + ((v.i - 1)::text || ' minutes')::interval, 'M1', \
                v.c, v.c + 1, v.c - 1, v.c, 1000, v.c * 1000, 'tushare' \
         FROM unnest($3::float8[]) WITH ORDINALITY AS v(c, i)")
        .bind(code).bind(ts0).bind(closes).execute(pool).await.unwrap();
}

async fn submit_run(
    http: &reqwest::Client, url: &str, symbol: &str, vid: &str,
    from: DateTime<Utc>, to: DateTime<Utc>, policy: Value,
) -> String {
    let body = json!({
        "symbol": symbol, "period": "M1",
        "from": from.to_rfc3339(), "to": to.to_rfc3339(),
        "slots": [{"version_id": vid, "params": {}, "weight": 1.0}],
        "policy": policy,
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
        "warmup_bars": 0,
    });
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 201, "submit 应 201: {:?}", r.text().await);
    let id = r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(wait_terminal(http, url, &id).await["status"], "succeeded", "run 应成功");
    id
}

/// `/fills` 元素字段集合（**ADR-027 §5.4 v2 增量后** = `FillFact` 投影 + `ts`，**恰为 12 键**）。
///
/// **顺序声明**：`serde_json` 默认**未**开 `preserve_order` ⇒ `Value::Object` = `BTreeMap` ⇒ 键按
/// **字典序**序列化；故此处以字典序声明，并断言实测键序列与该序列**逐项相等**（既验「不多不少」
/// 的精确集合，也验顺序）。键序清单 = `["bar_index", "code", "commission", "price", "qty",
/// "reason", "rt_seq", "side", "stamp_duty", "trade_value", "ts", "type"]`。
///
/// **禁止**放宽为包含式断言（只 `contains_key` 逐项查）：那会让「漏字段」「多字段」静默通过。
/// 本清单与 `crates/application/tests/workbench.rs::c4_fills_filter_and_element_increment`（L-1 同形状）对齐。
const FILL_KEYS_V2: [&str; 12] = [
    "bar_index",
    "code",
    "commission",
    "price",
    "qty",
    "reason",
    "rt_seq",
    "side",
    "stamp_duty",
    "trade_value",
    "ts",
    "type",
];

// ═══════════════════ ② + ③ 决定性：/fills 逐笔精确（v2 12 键） vs trades 回合聚合（I1） ═══════════════════

#[tokio::test]
async fn t_p6_fills_is_exact_source_and_trades_misses_partial_fills() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("79{}", std::process::id() % 10000);
    let p = pfx("fills");
    clean(&pool, &code, &p).await;

    let n = 30i64;
    let mut closes: Vec<f64> = vec![100.0; 6];
    closes.extend([150.0, 175.0, 200.0]);
    while closes.len() < n as usize { closes.push(200.0); }
    let ts: Vec<DateTime<Utc>> = (0..n).map(|i| base() + Duration::minutes(i)).collect();
    seed_symbol_and_prices(&pool, &code, &closes, base()).await;
    let vid = create_published(&http, &url, &format!("{p}-pp"), PLUGIN_PARTIAL).await;
    let run_id = submit_run(&http, &url, &code, &vid, base(), base() + Duration::minutes(n),
                            json!({"LumpSum": {"position_pct": 0.5}})).await;

    // ── ②-A DB：fills 单块 seq=0、ts_from/ts_to = 本 run 首/末 bar ts ──
    let chunks: Vec<(i32, DateTime<Utc>, DateTime<Utc>, i32)> = sqlx::query_as(
        "SELECT seq, ts_from, ts_to, jsonb_array_length(payload) FROM strategy_run_bars \
         WHERE run_id = $1 AND kind = 'fills' ORDER BY seq")
        .bind(&run_id).fetch_all(&pool).await.unwrap();
    assert_eq!(chunks.len(), 1, "fills 必须是**单块**；实际 {chunks:?}");
    assert_eq!(chunks[0].0, 0, "fills 单块 seq=0");
    assert_eq!(chunks[0].1, ts[0], "ts_from = 本 run 首根 bar ts");
    assert_eq!(chunks[0].2, ts[n as usize - 1], "ts_to = 本 run 末根 bar ts");

    // ── ②-B /fills 形状 + 元素字段 == EngineEvent::Fill 投影（含 ts 来自对应 bar）──
    let body = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset=0&limit=5000")).await;
    assert_eq!(body["run_id"], run_id);
    assert_eq!(body["total"], chunks[0].3, "total == 服务端全量成交数（不受分页影响）");
    assert_eq!(body["offset"], 0);
    assert_eq!(body["limit"], 5000, "limit 缺省 5000");
    assert_eq!(body["recorded"], true);
    assert_eq!(body["has_more"], false);
    assert!(body["next_offset"].is_null());
    let fills = body["fills"].as_array().unwrap().clone();
    assert_eq!(fills.len() as i64, body["total"].as_i64().unwrap());

    // per_bar 交叉核对（/bars 分页首页）
    let pb = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&offset=0&limit=5000")).await;
    let pbars = pb["bars"].as_array().unwrap();
    for f in &fills {
        let o = f.as_object().unwrap();
        // 精确集合 + 顺序：实测键序列（serde_json 字典序）必须与 v2 的 12 键清单逐项相等。
        let keys: Vec<&str> = o.keys().map(String::as_str).collect();
        assert_eq!(keys, FILL_KEYS_V2, "元素字段集合应恰为 v2 的 12 键（精确集合，不多不少）；实际 {keys:?}");
        // v2 新增字段不得是「有键无值」（键集断言单独无法发现 null/缺失语义退化）。
        assert_eq!(f["code"], Value::String(code.clone()), "code == run 的 symbol（ADR-027 §5.4）");
        for k in ["rt_seq", "trade_value", "commission", "stamp_duty"] {
            assert!(!f[k].is_null(), "v2 新增字段 {k} 不得为 null");
        }
        assert!(f["rt_seq"].as_u64().unwrap() >= 1, "rt_seq 从 1 起（归属由 rt_seq 决定，禁止窗口推断）");
        assert!(f["trade_value"].as_f64().unwrap() > 0.0, "trade_value 为正");
        assert!(f["commission"].as_f64().unwrap() >= 0.0, "commission 非负");
        assert!(f["stamp_duty"].as_f64().unwrap() >= 0.0, "stamp_duty 非负（买入恒 0）");
        assert_eq!(f["type"], "fill");
        let bi = f["bar_index"].as_i64().unwrap() as usize;
        assert!(bi < n as usize);
        assert_eq!(f["ts"].as_i64().unwrap(), epoch(ts[bi]), "ts 必须来自对应 bar（bar_index={bi}）");
        assert_eq!(f["ts"].as_i64().unwrap(), pbars[bi]["ts"].as_i64().unwrap(), "fills.ts == per_bar[bar_index].ts");
        assert!(matches!(f["side"].as_str().unwrap(), "Buy" | "Sell"));
        assert!(f["qty"].as_f64().unwrap() > 0.0, "qty 为正");
        assert!(f["price"].as_f64().unwrap() > 0.0, "price 为正");
        assert!(!f["reason"].as_str().unwrap().is_empty());
    }

    // ── ③ 决定性：部分买入 + 部分卖出 在 /fills，但 trades 不含它们 ──
    let result = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/result")).await;
    let trades = result["trades"].as_array().cloned().unwrap_or_default();
    println!("[probe] /fills total={} records={}", body["total"], serde_json::to_string_pretty(&fills).unwrap());
    println!("[probe] /result trades n={} {}", trades.len(), serde_json::to_string_pretty(&trades).unwrap());

    let buys: Vec<&Value> = fills.iter().filter(|f| f["side"] == "Buy").collect();
    let sells: Vec<&Value> = fills.iter().filter(|f| f["side"] == "Sell").collect();
    assert!(!buys.is_empty(), "应有买入成交");
    assert!(!sells.is_empty(), "应有卖出成交");
    // ① 部分买入：position_pct=0.5 ⇒ 买入股数 ≈ 半仓（远小于全仓 1000 股 @100）
    let buy_qty: f64 = buys.iter().map(|f| f["qty"].as_f64().unwrap()).sum();
    assert!(buy_qty < 900.0, "position_pct=0.5 的部分买入规模应 < 全仓；实际 {buy_qty}");
    assert!(buy_qty > 400.0, "应确实买到半仓附近；实际 {buy_qty}");
    // ② 部分卖出（未清仓）：Policy 卖出且 qty < 累计买入
    let ps = sells.iter().find(|f| f["qty"].as_f64().unwrap() < buy_qty - 1e-6 && f["reason"] == "Policy")
        .copied().expect("应存在一笔 Policy 的部分卖出（未清仓）");
    let ps_bar = ps["bar_index"].as_i64().unwrap();
    assert!(ps_bar < n - 1, "部分卖出不是期末强平（bar_index={ps_bar}）");
    // 反向：trades 是**回合聚合行**（行数 ≠ 逐笔数），不逐笔列出；但其金额字段按 I1 聚合**全部**逐笔
    // （ADR-027 v2 取消了 pre-ADR-027 的「部分卖出只摊薄、不进账本」缺陷，见 02-spec §2）。
    assert_ne!(trades.len() as i64, fills.len() as i64,
               "trades 条数必须 != fills 条数（trades = 回合聚合行，非逐笔事实源）");
    assert!(trades.iter().all(|t| t["close_bar"].as_i64() != Some(ps_bar)),
            "部分卖出不得单独成行：其 bar_index 不得出现在任何 trades.close_bar");
    assert_eq!(trades.len(), 1, "该 run 只有 1 个回合（3 笔成交 ⇒ 1 行 trades）");
    // ADR-027 v2 回合口径（design/17-trade-detail-layering/02-spec.md §1.2 / §2 I1）：
    //   `shares = Σ 买入 qty`（Closed ⇒ 亦 == Σ 卖出 qty）；`commission/stamp_duty` = Σ 本回合逐笔同名字段。
    let trade_shares = trades[0]["shares"].as_f64().unwrap();
    assert!((trade_shares - buy_qty).abs() < 1e-6,
            "v2 §1.2：trade.shares({trade_shares}) == Σ 买入 qty({buy_qty})");
    let sell_qty: f64 = sells.iter().map(|f| f["qty"].as_f64().unwrap()).sum();
    assert!((trade_shares - sell_qty).abs() < 1e-6,
            "v2 §1.2：Closed ⇒ Σ 买入({buy_qty}) == shares({trade_shares}) == Σ 卖出({sell_qty})");
    assert_eq!(trades[0]["l2_count"].as_u64().unwrap() as usize, fills.len(),
               "trades.l2_count == 本回合成交笔数（含部分卖出笔，02-spec §1.2）");
    for k in ["commission", "stamp_duty"] {
        let s: f64 = fills.iter().map(|f| f[k].as_f64().unwrap()).sum();
        let t = trades[0][k].as_f64().unwrap();
        assert!((t - s).abs() < 1e-6,
                "v2 恒等式 I1：trade.{k}({t}) == Σfills.{k}({s}) ⇒ 回合聚合行未漏任何逐笔成交");
    }
    // per_bar 事件流确认该部分卖出确实由引擎发出（非读侧伪造）
    let ev10 = pbars[ps_bar as usize]["events"].as_array().cloned().unwrap_or_default();
    assert!(ev10.iter().any(|e| e["type"] == "fill" && e["side"] == "Sell"
                             && (e["qty"].as_f64().unwrap() - ps["qty"].as_f64().unwrap()).abs() < 1e-9),
            "per_bar[{ps_bar}].events 应含同一笔部分卖出（引擎事实源）");

    clean(&pool, &code, &p).await;
}

// ═══════════════════ ②-C 分页边界（0 / 恰好一页 / 跨页 / 超末尾 / 夹取） ═══════════════════

#[tokio::test]
async fn t_p6_fills_paging_boundaries_and_clamps() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("78{}", std::process::id() % 10000);
    let p = pfx("page");
    clean(&pool, &code, &p).await;

    let n = 12i64;
    let closes: Vec<f64> = vec![100.0; n as usize];
    let ts: Vec<DateTime<Utc>> = (0..n).map(|i| base() + Duration::minutes(i)).collect();
    seed_symbol_and_prices(&pool, &code, &closes, base()).await;
    let vid = create_published(&http, &url, &format!("{p}-dca"), PLUGIN_BUY_HOLD).await;
    // DCA 3 批（每 bar 一批）⇒ 3 笔加仓买入 + 期末强平 1 笔 = 4 笔成交
    let run_id = submit_run(&http, &url, &code, &vid, base(), base() + Duration::minutes(n),
                            json!({"Dca": {"tranches": 3, "mode": "Equal", "amount": null, "interval": 1}})).await;

    let total = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills")).await["total"].as_i64().unwrap();
    assert_eq!(total, 4, "3 笔 DCA 加仓 + 1 笔期末强平"); 
    let ts_all = ts.clone();

    // 恰好一页
    let full = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset=0&limit={total}")).await;
    assert_eq!(full["fills"].as_array().unwrap().len() as i64, total);
    assert_eq!(full["has_more"], false);
    assert!(full["next_offset"].is_null());
    let all = full["fills"].as_array().unwrap().clone();

    // 跨页：offset=1&limit=2
    let mid = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset=1&limit=2")).await;
    assert_eq!(mid["offset"], 1);
    assert_eq!(mid["has_more"], true);
    assert_eq!(mid["next_offset"], 3);
    assert_eq!(mid["fills"].as_array().unwrap(), &all[1..3].to_vec());

    // 差一笔（has_more 边界）
    let almost = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset=0&limit={}", total - 1)).await;
    assert_eq!(almost["has_more"], true);
    assert_eq!(almost["next_offset"], total - 1);
    assert_eq!(almost["fills"].as_array().unwrap().len() as i64, total - 1);

    // 超末尾（offset == total / offset > total）
    for off in [total, total + 5] {
        let over = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset={off}&limit=2")).await;
        assert_eq!(over["fills"].as_array().unwrap().len(), 0, "超末尾必须空页");
        assert_eq!(over["has_more"], false);
        assert!(over["next_offset"].is_null());
    }

    // 逐页拼接（limit=1）逐值 == 全量
    let mut acc: Vec<Value> = Vec::new();
    let mut off = 0i64;
    loop {
        let pg = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset={off}&limit=1")).await;
        let arr = pg["fills"].as_array().unwrap().clone();
        acc.extend(arr.iter().cloned());
        if !pg["has_more"].as_bool().unwrap() { break; }
        off = pg["next_offset"].as_i64().unwrap();
    }
    assert_eq!(acc, all, "逐页拼接必须与全量逐值一致（无重复无缺失）");

    // 下界/上限夹取（limit=0 → 1；limit=99999 → 20000；offset<0 → 0）
    let l0 = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset=0&limit=0")).await;
    assert_eq!(l0["limit"], 1, "limit=0 夹取为 1");
    assert_eq!(l0["fills"].as_array().unwrap().len(), 1);
    let lmax = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset=0&limit=99999")).await;
    assert_eq!(lmax["limit"], 20000, "limit 上限 20000（与 /bars 同口径）");
    let lneg = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills?offset=-3&limit=2")).await;
    assert_eq!(lneg["offset"], 0, "offset<0 夹取为 0");

    // 位置一致性：fills[i].bar_index 单调不减（成交按 bar 顺序），ts 与 bar_index 对齐
    let mut prev = -1i64;
    for f in &all {
        let bi = f["bar_index"].as_i64().unwrap();
        assert!(bi >= prev, "fills 应按 bar 顺序（bar_index 单调不减）");
        prev = bi;
        assert_eq!(f["ts"].as_i64().unwrap(), epoch(ts_all[bi as usize]));
    }
    println!("[probe] /fills 分页 OK total={total} bar_indices={:?}",
             all.iter().map(|f| f["bar_index"].as_i64().unwrap()).collect::<Vec<_>>());
    clean(&pool, &code, &p).await;
}

// ═══════════════════ ②-D 「无成交」vs「未写」+ legacy 派生 ═══════════════════

#[tokio::test]
async fn t_p6_fills_recorded_vs_unrecorded_and_legacy_derived() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("77{}", std::process::id() % 10000);
    let p = pfx("rec");
    clean(&pool, &code, &p).await;

    // ── (1) 真实 run 但**无成交**（恒 Hold）：仍写空数组块 ⇒ recorded=true, total=0 ──
    let n = 6i64;
    let closes: Vec<f64> = vec![100.0; n as usize];
    let ts: Vec<DateTime<Utc>> = (0..n).map(|i| base() + Duration::minutes(i)).collect();
    seed_symbol_and_prices(&pool, &code, &closes, base()).await;
    let vid = create_published(&http, &url, &format!("{p}-hold"), PLUGIN_HOLD_ONLY).await;
    let run_id = submit_run(&http, &url, &code, &vid, base(), base() + Duration::minutes(n),
                            json!({"LumpSum": {"position_pct": 1.0}})).await;
    let no_fill = get_json(&http, &format!("{url}/api/workbench/runs/{run_id}/fills")).await;
    assert_eq!(no_fill["total"], 0, "恒 Hold ⇒ 无成交");
    assert_eq!(no_fill["recorded"], true, "**无成交**仍应有块（recorded=true）");
    assert_eq!(no_fill["fills"].as_array().unwrap().len(), 0);
    let empty_chunk: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM strategy_run_bars WHERE run_id=$1 AND kind='fills' AND payload='[]'::jsonb")
        .bind(&run_id).fetch_one(&pool).await.unwrap();
    assert_eq!(empty_chunk, 1, "无成交也必须写**空数组块**（『有块 = 已记录』的判据）");

    // ── (2) 手工 chunked run **无 fills 块**（= P6 之前的 chunked run）⇒ recorded=false ──
    let id2 = format!("{p}_unrecorded");
    craft_run(&pool, &id2, &format!("{p}-unrec"), &code, "succeeded").await;
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, net_value, drawdown, trades, metrics, result_format) \
         VALUES ($1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'chunked_v1')")
        .bind(&id2).execute(&pool).await.unwrap();
    let unrec = get_json(&http, &format!("{url}/api/workbench/runs/{id2}/fills")).await;
    assert_eq!(unrec["recorded"], false, "无 fills 块 ⇒ **未写**（recorded=false）");
    assert_eq!(unrec["total"], 0);
    assert_eq!(unrec["has_more"], false);
    assert_eq!(unrec["fills"].as_array().unwrap().len(), 0);
    assert_ne!(no_fill["recorded"], unrec["recorded"], "「无成交」与「未写」必须可区分");

    // ── (3) 手工 legacy_single run：由内联 per_bar 事件派生（双读、不回填）──
    let id3 = format!("{p}_legacy");
    craft_run(&pool, &id3, &format!("{p}-legacy"), &code, "succeeded").await;
    let per_bar = json!([
        {"ts": epoch(ts[0]), "scores": [], "aggregate": 80.0, "signal": "Buy",
         "orders": [], "events": [{"type":"fill","bar_index":0,"side":"Buy","qty":10.0,"price":100.0,"reason":"Policy"},
                                  {"type":"log","msg":"not a fill"}]},
        {"ts": epoch(ts[1]), "scores": [], "aggregate": 50.0, "signal": "Hold", "orders": [], "events": []},
        {"ts": epoch(ts[2]), "scores": [], "aggregate": 30.0, "signal": "Sell",
         "orders": [], "events": [{"type":"fill","bar_index":2,"side":"Sell","qty":10.0,"price":101.0,"reason":"Policy"}]}
    ]);
    sqlx::query(
        "INSERT INTO strategy_run_result (run_id, per_bar, net_value, drawdown, trades, metrics) \
         VALUES ($1, $2::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)")
        .bind(&id3).bind(serde_json::to_string(&per_bar).unwrap()).execute(&pool).await.unwrap();
    let legacy = get_json(&http, &format!("{url}/api/workbench/runs/{id3}/fills")).await;
    assert_eq!(legacy["recorded"], true, "legacy 由内联 per_bar 派生 ⇒ recorded=true");
    assert_eq!(legacy["total"], 2, "只派生 fill 事件（跳过 log）");
    let lf = legacy["fills"].as_array().unwrap();
    assert_eq!(lf[0]["bar_index"], 0);
    assert_eq!(lf[0]["ts"].as_i64().unwrap(), epoch(ts[0]), "legacy fills.ts = 所属 per_bar 记录的 ts");
    assert_eq!(lf[1]["bar_index"], 2);
    assert_eq!(lf[1]["ts"].as_i64().unwrap(), epoch(ts[2]));
    let legacy_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM strategy_run_bars WHERE run_id=$1").bind(&id3).fetch_one(&pool).await.unwrap();
    assert_eq!(legacy_rows, 0, "legacy 双读**不回填**（零分块行）");

    // ── (4) 未知 run ⇒ 404 ──
    let r = http.get(format!("{url}/api/workbench/runs/sr_does_not_exist/fills")).send().await.unwrap();
    assert_eq!(r.status(), 404, "未知 run 应 404：{:?}", r.text().await);

    println!("[probe] 无成交={} 未写={} legacy={}",
             no_fill["recorded"], unrec["recorded"], legacy["recorded"]);
    clean(&pool, &code, &p).await;
}

// ═══════════════════ ②-E 反向防误用：/curve?kind=fills 与 /bars?kind=fills 必须 400 ═══════════════════

#[tokio::test]
async fn t_p6_fills_rejected_by_curve_and_bars_with_hint() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("76{}", std::process::id() % 10000);
    let p = pfx("reject");
    clean(&pool, &code, &p).await;
    let n = 6i64;
    let closes: Vec<f64> = vec![100.0; n as usize];
    seed_symbol_and_prices(&pool, &code, &closes, base()).await;
    let vid = create_published(&http, &url, &format!("{p}-buy"), PLUGIN_BUY_HOLD).await;
    let run_id = submit_run(&http, &url, &code, &vid, base(), base() + Duration::minutes(n),
                            json!({"LumpSum": {"position_pct": 1.0}})).await;

    for url_path in ["curve?kind=fills", "curve?kind=fills&k=10", "bars?kind=fills"] {
        let r = http.get(format!("{url}/api/workbench/runs/{run_id}/{url_path}")).send().await.unwrap();
        let status = r.status();
        let text = r.text().await.unwrap();
        assert_eq!(status, 400, "/{url_path} 必须 400；实际 {status} body={text}");
        assert!(text.contains("fills"), "/{url_path} 的 400 提示必须点明 fills；实际 {text}");
        assert!(text.contains("/fills"), "/{url_path} 的 400 提示必须引导走 /fills 端点；实际 {text}");
        println!("[probe] /{url_path} → 400 {text}");
    }
    // 对照：合法的 3 个 kind 均 200
    for url_path in ["curve?kind=net_value&k=10", "curve?kind=drawdown&k=10", "bars?kind=per_bar&limit=2",
                     "curve?kind=per_bar&k=10"] {
        let r = http.get(format!("{url}/api/workbench/runs/{run_id}/{url_path}")).send().await.unwrap();
        assert_eq!(r.status(), 200, "/{url_path} 应 200：{:?}", r.text().await);
    }
    clean(&pool, &code, &p).await;
}
