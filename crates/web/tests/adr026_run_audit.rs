//! ADR-026 §2.2：`GET /api/workbench/runs/{id}/audit`（执行完整度审计）端点集成测试。
//!
//! 需 TimescaleDB（ADR-025 临时库：`EESTOCK_TEST_DB_NAME=tmp_<lane>_<ts> scripts/testdb-init.sh`）。
//! 覆盖：200 结构断言（字段名/语义）、端点间**三方自洽**（/bars 的 orders × /fills × /result 的 trades）、
//! `recorded` 语义（事实源齐全 / 不齐）、404 语义（运行不存在 / 无结果）。
//!
//! 另含 ADR-026 §5 A3/A4 的**真实 run 回放**（`adr026_replay_*` 门禁）：临时库若已播种目标 run 的事实行，
//! 则逐字段断言冻结基准；未播种则**跳过**（不静默通过：打印 skip 原因；播种脚本见交付报告）。

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

fn base() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 9, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    // ADR-023 E6b：统一测试库入口（EESTOCK_TEST_DATABASE_URL + 哨兵表校验），不得回退活库。
    test_support::test_pool().await
}

/// **本用例私有夹具标记**（并发隔离键）：`<pid>_<seq>_<tag>`（`seq` = 进程内原子自增序号）。
///
/// 每个 `#[tokio::test]` 各自持有一个 `Fix`：`code`（symbol 代码，兼作 `kline_accurate.source`）、
/// `source`、`name_prefix`（strategy 名前缀）、`key`（手工插入行的 id 前缀）**四者都只被本用例读写**。
/// 同进程并发用例由 `seq` 区分、跨进程由全量 `pid` 区分 ⇒ 任何清理都不可能命中别家行
/// （旧实现用 `DELETE … WHERE id LIKE 'sr_adr026%'` 跨用例删行，是 FK 23503 的直接成因）。
struct Fix {
    code: String,
    source: String,
    name_prefix: String,
    key: String,
}

impl Fix {
    /// 手工插入的 run 行 id（`strategy_run.id` 恒以 `sr_` 起，与真实 run id 同形）。
    fn run_id(&self, tag: &str) -> String {
        format!("sr_{}_{}", self.key, tag)
    }
}

/// 进程内夹具序号（**单调**，唯一键的一部分；纳米时间戳在并发下会被两次读到同一值 ⇒ 不可作唯一键）。
static FIX_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn fix(tag: &str) -> Fix {
    let seq = FIX_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // 跨进程唯一 = **完整 pid**（活进程 pid 唯一）；进程内唯一 = `seq`（原子自增）。
    // ⚠ 曾用 `nanos % 10^7` 作唯一键 ⇒ 并发用例可能读到**同一纳秒**，两个用例拿到同一 code，
    //    随后 `clean()`（按 symbol 删本用例 run）会误删对方 run（实测 ~7% 红：
    //    `/bars` 报「运行不存在」/ `/fills` recorded=false）。
    let key = format!("{}_{}_{}", std::process::id(), seq, tag);
    Fix {
        // symbol 代码保持「纯数字」形态（与仓内其余测试的夹具习惯一致）。
        code: format!("9{}{:03}", std::process::id(), seq),
        source: format!("adr026_{key}"),
        name_prefix: format!("adr026_{key}"),
        key,
    }
}

/// 趋势插件（close > 105 → 90 分 Buy，否则 20 分 Sell；6 bar fixture）。
const TREND: &str = "function on_bar(ctx) { return ctx.bar.close > 105 ? 90 : 20; }";

/// 测试装配（与 app bin 同口径；与 `api_workbench.rs` 同模板）。
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

// ── 测试辅助 ──

async fn seed_symbol_and_bars(pool: &PgPool, fx: &Fix) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) \
                 VALUES ($1, $1, 60, true) ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(&fx.code).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(&fx.code).execute(pool).await.unwrap();
    for (i, c) in [100.0, 100.0, 110.0, 110.0, 100.0, 100.0].iter().enumerate() {
        // `source` = 本用例唯一标记（隔离键的一部分：只按本用例的 code/source 读写）。
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, $4) ON CONFLICT DO NOTHING")
            .bind(&fx.code).bind(base() + Duration::minutes(i as i64)).bind(c).bind(&fx.source)
            .execute(pool).await.unwrap();
    }
}

async fn create_published(http: &reqwest::Client, url: &str, name: &str, code: &str) -> String {
    let r = http.post(format!("{url}/api/strategies"))
        .json(&json!({ "name": name, "code": code }))
        .send().await.unwrap();
    assert_eq!(r.status(), 201, "create 应 201: {:?}", r.text().await);
    let created: Value = r.json().await.unwrap();
    let vid = created["version"]["id"].as_str().unwrap().to_string();
    let r = http.post(format!("{url}/api/strategies/versions/{vid}/publish"))
        .send().await.unwrap();
    assert_eq!(r.status(), 200, "publish 应 200: {:?}", r.text().await);
    vid
}

fn submit_body(symbol: &str, version_id: &str, policy: Value) -> Value {
    json!({
        "symbol": symbol,
        "period": "M1",
        "from": (base() - Duration::minutes(1)).to_rfc3339(),
        "to": (base() + Duration::minutes(10)).to_rfc3339(),
        "slots": [{"version_id": version_id, "params": {}, "weight": 1.0}],
        "policy": policy,
        "fee": {"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0},
    })
}

async fn wait_terminal(http: &reqwest::Client, url: &str, id: &str) -> Value {
    for _ in 0..1500 {
        let r = http.get(format!("{url}/api/workbench/runs/{id}")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        let status = v["status"].as_str().unwrap();
        if matches!(status, "succeeded" | "failed" | "canceled") {
            return v;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("run {id} 30s 未达终态");
}

/// 清理**只针对本用例自有行**：`symbol = fx.code` ⇒ 本用例的 run；strategy 名前缀 = 本用例私有
/// （`fx.name_prefix` 含 pid+nanos）。**禁止**再出现按 `id LIKE 'sr_adr026%'` 之类的跨用例删除
/// （那是 FK 23503 的成因：本用例的 run 行被并发用例的 clean() 删掉，`strategy_run_result` 插入即违约）。
async fn clean(pool: &PgPool, fx: &Fix) {
    let code = &fx.code;
    let name_prefix = &fx.name_prefix;
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(code).execute(pool).await.unwrap();
    sqlx::query("UPDATE strategy_version SET status = 'archived' \
                 WHERE strategy_id IN (SELECT id FROM strategy WHERE name LIKE $1)")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM strategy WHERE name LIKE $1")
        .bind(format!("{name_prefix}%")).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM kline_accurate WHERE code = $1").bind(code).execute(pool).await.unwrap();
    // ADR-023 §6.3 / ADR-025 D3：清掉由本测试 M1 播种派生的 cagg 视图行（源行已删、cagg 不回删
    // ⇒ 残留即「孤儿行」）。表名清单**复用** `storage::reader::ORPHAN_TABLES`（同一事实源，
    // 不另抄一份）；定向按 code 清理，不误伤其他测试的播种。
    for t in storage::reader::ORPHAN_TABLES {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1")).bind(code).execute(pool).await.unwrap();
    }
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(code).execute(pool).await.unwrap();
}

/// `/audit` 响应键集 = `RunAudit { run_id, #[serde(flatten)] AuditReport }` 的**精确**字段集
/// （= ADR-026 §2.2 十五键 + ADR-027 §5.5 三键），**顺序 = 结构体声明序 = 契约序**。
///
/// P4b 同步（2026-09-20，audit 契约变更的正当跟随）：ADR-027 §5.5 使 `/audit` 增
/// `round_trips_closed` / `round_trips_open` / `rt_reconcile` ⇒ 旧 `[&str; 15]` 冻结集与
/// `assert_eq!(obj.len(), N)` 必红。本冻结集与**事实源同步**：`crates/application/src/audit.rs
/// ::AuditReport` 的字段声明序（其单测 `report_serializes_frozen_field_names` 为同源镜像）。
/// 断言仍是**精确集合**（不多不少）+ 顺序声明（见 [`assert_audit_key_order`]），**非**「包含」式。
const AUDIT_KEYS: [&str; 18] = [
    "run_id", "recorded", "capital_basis", "deployed_notional", "deployed_pct", "cash_consumed",
    "cash_consumed_pct", "planned_tranches", "reachable_batches", "batches_done",
    "unexecuted_orders", "last_bar_unfilled", "round_trips_total", "round_trips_force_closed",
    "round_trips_closed", "round_trips_open", "rt_reconcile", "warnings",
];

fn assert_audit_shape(a: &Value) {
    let obj = a.as_object().unwrap_or_else(|| panic!("audit 响应须为对象：{a}"));
    for k in AUDIT_KEYS {
        assert!(obj.contains_key(k), "audit 缺字段 {k}：{a}");
    }
    assert_eq!(obj.len(), AUDIT_KEYS.len(), "audit 不得多出/少出字段：{a}");
    for k in ["deployed_notional", "deployed_pct", "cash_consumed", "cash_consumed_pct", "capital_basis"] {
        assert!(a[k].is_number(), "{k} 须为数值：{a}");
    }
    assert!(a["round_trips_total"].is_u64() && a["batches_done"].is_u64());
    // ADR-027 §5.5 增量的**形状**断言（只冻结存在性/类型，不冻结值）：
    assert!(a["round_trips_closed"].is_u64() && a["round_trips_open"].is_u64());
    let rc = &a["rt_reconcile"];
    assert!(rc.is_object(), "rt_reconcile 须为对象：{rc}");
    assert!(rc["checked"].is_u64(), "rt_reconcile.checked 须为 u64：{rc}");
    assert!(rc["mismatched"].is_array(), "rt_reconcile.mismatched 须为数组：{rc}");
    assert!(rc["tolerance"].is_number(), "rt_reconcile.tolerance 须为数值：{rc}");
    assert!(a["warnings"].is_array(), "warnings 须为数组");
    for w in a["warnings"].as_array().unwrap() {
        assert!(w["code"].is_string() && w["severity"].is_string() && w["message"].is_string(),
            "warning 须含 code/severity/message：{w}");
    }
}

/// **顺序断言**（把 `AUDIT_KEYS` 的顺序声明变成可执行的断言）：在**原始响应文本**上逐键按下标递增查找，
/// 任一键缺失或次序与契约序不一致 ⇒ 失败。
///
/// 必要性：`serde_json::Value` 的 `Map` 是 `BTreeMap`（键序不可断言，见 `crates/application/src/audit.rs`
/// 同名注记）⇒ 顺序只能在 raw body 上断言。首键固定 `run_id`（`RunAudit` 外层字段先于 flatten）。
#[track_caller]
fn assert_audit_key_order(raw: &str) {
    assert!(raw.starts_with("{\"run_id\":"), "首字段须为 run_id：{raw}");
    let mut cursor = 0usize;
    for k in AUDIT_KEYS {
        let needle = format!("\"{k}\":");
        let pos = raw[cursor..]
            .find(&needle)
            .unwrap_or_else(|| panic!("原始响应缺字段 {k}（或键序与契约序不一致）：{raw}"))
            + cursor;
        cursor = pos;
    }
}

/// 端点间三方自洽：审计的 `reachable_batches`/`batches_done` 必须等于 /bars 的 orders 与 /fills 的成交实况。
async fn cross_check_with_facts(http: &reqwest::Client, url: &str, run_id: &str, audit: &Value) {
    let bars: Value = http
        .get(format!("{url}/api/workbench/runs/{run_id}/bars?kind=per_bar&limit=20000"))
        .send().await.unwrap().json().await.unwrap();
    let per_bar = bars["bars"].as_array().expect("per_bar 数组");
    let buy_intents = per_bar.iter()
        .flat_map(|b| b["orders"].as_array().cloned().unwrap_or_default())
        .filter(|o| o["side"] == json!("Buy"))
        .count();
    assert_eq!(
        audit["reachable_batches"].as_u64().unwrap() as usize, buy_intents,
        "reachable_batches 须 = per_bar 的 Buy 意图数（/bars 实况）"
    );
    let last_in_range = per_bar.iter().rposition(|b| b["warmup"] != json!(true));
    let last_bar_has_buy = last_in_range.is_some_and(|i| {
        per_bar[i]["orders"].as_array().cloned().unwrap_or_default()
            .iter().any(|o| o["side"] == json!("Buy"))
    });
    if let Some(last) = last_in_range {
        // 末 bar 判定：legacy 记录缺 warmup 字段时视为 in-range（与投影同口径）。
        if per_bar[last]["warmup"] == json!(false) || per_bar[last].get("warmup").is_none() {
            assert_eq!(
                audit["last_bar_unfilled"].as_bool().unwrap(), last_bar_has_buy,
                "last_bar_unfilled 须 = 末根 in-range bar 是否存在 Buy 意图"
            );
        }
    }

    let fills: Value = http
        .get(format!("{url}/api/workbench/runs/{run_id}/fills?limit=20000"))
        .send().await.unwrap().json().await.unwrap();
    let buy_fills: Vec<&Value> = fills["fills"].as_array().expect("fills 数组").iter()
        .filter(|f| f["side"] == json!("Buy"))
        .collect();
    assert_eq!(
        audit["batches_done"].as_u64().unwrap() as usize, buy_fills.len(),
        "batches_done 须 = /fills 的 Buy 成交笔数"
    );
    let notional: f64 = buy_fills.iter()
        .map(|f| f["qty"].as_f64().unwrap() * f["price"].as_f64().unwrap())
        .sum();
    let deployed = audit["deployed_notional"].as_f64().unwrap();
    assert!((deployed - notional).abs() < 1e-6,
        "deployed_notional 须 = Σ buy_fill.qty×price（敞口口径）：audit={deployed}, 实况={notional}");
    let capital = audit["capital_basis"].as_f64().unwrap();
    assert!((audit["deployed_pct"].as_f64().unwrap() - deployed / capital).abs() < 1e-12);
    assert!((audit["cash_consumed_pct"].as_f64().unwrap()
        - audit["cash_consumed"].as_f64().unwrap() / capital).abs() < 1e-12);
    assert!(audit["cash_consumed"].as_f64().unwrap() >= deployed,
        "资金占用（含佣金）不得小于名义投入（敞口）");

    let result: Value = http
        .get(format!("{url}/api/workbench/runs/{run_id}/result"))
        .send().await.unwrap().json().await.unwrap();
    let trades = result["trades"].as_array().expect("trades 数组");
    assert_eq!(
        audit["round_trips_total"].as_u64().unwrap() as usize, trades.len(),
        "round_trips_total 须 = trades 长度"
    );
    let force_close_bars: Vec<i64> = fills["fills"].as_array().unwrap().iter()
        .filter(|f| f["side"] == json!("Sell") && f["reason"] == json!("ForceClose"))
        .map(|f| f["bar_index"].as_i64().unwrap())
        .collect();
    let force_closed = trades.iter()
        .filter(|t| force_close_bars.contains(&t["close_bar"].as_i64().unwrap()))
        .count();
    assert_eq!(
        audit["round_trips_force_closed"].as_u64().unwrap() as usize, force_closed,
        "round_trips_force_closed 须 = 与 ForceClose 成交 bar 配对的回合数"
    );
}

// ── 200 结构 + 语义 + 三方自洽 ──

#[tokio::test]
async fn audit_endpoint_matches_recorded_facts_and_404_semantics() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let fx = fix("aud");
    clean(&pool, &fx).await;
    seed_symbol_and_bars(&pool, &fx).await;
    let vid = create_published(&http, &url, &format!("{}-trend", fx.name_prefix), TREND).await;

    // DCA{tranches:10}：区间内只有 2 个 Buy 意图 ⇒ 计划必然未推进完（DCA_PLAN_UNDERFILLED）。
    let body = submit_body(&fx.code, &vid, json!({"Dca": {"mode": "Equal", "tranches": 10, "interval": 1}}));
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 201, "submit 应 201: {:?}", r.text().await);
    let run_id = r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let fin = wait_terminal(&http, &url, &run_id).await;
    assert_eq!(fin["status"], "succeeded", "应成功: {:?}", fin["error"]);

    let r = http.get(format!("{url}/api/workbench/runs/{run_id}/audit")).send().await.unwrap();
    assert_eq!(r.status(), 200, "audit 应 200: {:?}", r.text().await);
    // 顺序声明在**原始响应文本**上挣得（`Value` 的键序不可断言）；再解析为 `Value` 做精确集合/语义断言。
    let raw = r.text().await.unwrap();
    assert_audit_key_order(&raw);
    let a: Value = serde_json::from_str(&raw).unwrap();
    assert_audit_shape(&a);
    assert_eq!(a["run_id"], json!(run_id), "run_id 回显");
    assert_eq!(a["recorded"], json!(true), "chunked run 的 per_bar 可得 ⇒ recorded=true");
    assert_eq!(a["capital_basis"], json!(100000.0), "绩效分母 = run config initial_capital");
    assert_eq!(a["planned_tranches"], json!(10), "Dca ⇒ planned_tranches = tranches");
    assert_eq!(a["reachable_batches"], json!(2), "trend fixture 区间内 2 个 Buy 意图（bar2/bar3）");
    assert_eq!(a["batches_done"], json!(2));
    assert_eq!(a["unexecuted_orders"], json!(0));
    assert_eq!(a["last_bar_unfilled"], json!(false), "末 bar（bar5）只有 Sell 意图");
    let codes: Vec<&str> = a["warnings"].as_array().unwrap().iter()
        .map(|w| w["code"].as_str().unwrap()).collect();
    assert!(codes.contains(&"DCA_PLAN_UNDERFILLED"), "计划 10 批只推进 2 批 ⇒ 须告警：{codes:?}");
    assert!(codes.contains(&"PARTIAL_DEPLOYMENT"), "只投出约 20% ⇒ 须告警：{codes:?}");
    assert_eq!(
        codes,
        vec!["DCA_PLAN_UNDERFILLED", "PARTIAL_DEPLOYMENT"],
        "warning 顺序 = ADR-026 §2.2（DCA → 未满仓 → 挂单）"
    );
    assert!(a["deployed_pct"].as_f64().unwrap() < 0.5, "DCA 等额分批 2/10 ⇒ 敞口约 20%");
    cross_check_with_facts(&http, &url, &run_id, &a).await;

    // ── 404 语义 ──
    // ① 运行不存在（本用例私有 id，绝不指向别家插入的行）
    let absent = fx.run_id("nosuch");
    let r = http.get(format!("{url}/api/workbench/runs/{absent}/audit")).send().await.unwrap();
    assert_eq!(r.status(), 404, "未知 run ⇒ 404");
    // ② 运行存在但无结果（queued 行直插；复用既有错误码体系 = WorkbenchNotFound）
    let queued_id = fx.run_id("queued_noresult");
    sqlx::query("INSERT INTO strategy_run (id, name, symbol, period, from_ts, to_ts, config, status) \
                 VALUES ($1, 'adr026-noresult', $2, 'M1', now(), now() + interval '1 hour', '{}'::jsonb, 'queued')")
        .bind(&queued_id).bind(&fx.code).execute(&pool).await.unwrap();
    let r = http.get(format!("{url}/api/workbench/runs/{queued_id}/audit")).send().await.unwrap();
    assert_eq!(r.status(), 404, "无结果 ⇒ 404（与 /result、/fills 同语义）: {:?}", r.text().await);

    clean(&pool, &fx).await;
}

// ── recorded 语义：事实源不齐 ⇒ 只回零值 + 空 warnings（诚实留白） ──
//
// 本用例**自造**一条 run 行 + 结果行（chunked_v1、不写任何分块 ⇒ per_bar/fills 均不可得），
// run id / symbol 均为本用例私有（`fx`）⇒ 与并发用例零交集（既不删别家行，也不被别家删）。
// 断言的是「事实源缺失 ⇒ 诚实留白」的 recorded 语义，**不依赖**「删掉别人的 run」这种构造。

#[tokio::test]
async fn audit_recorded_false_when_facts_are_missing() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let fx = fix("nofacts");
    let id = fx.run_id("chunked_nofacts");
    sqlx::query("INSERT INTO strategy_run (id, name, symbol, period, from_ts, to_ts, config, status) \
                 VALUES ($1, 'adr026-nofacts', $2, 'D1', now(), now() + interval '1 day', \
                         '{\"initial_capital\": 100000.0, \"policy\": {\"Dca\": {\"mode\":\"Equal\",\"tranches\":100,\"interval\":1}}}'::jsonb, \
                         'succeeded')")
        .bind(&id).bind(&fx.code).execute(&pool).await.unwrap();
    // chunked 判定列 + 空内联列，且**不写任何分块** ⇒ per_bar/fills 均不可得。
    sqlx::query("INSERT INTO strategy_run_result (run_id, per_bar, trades, net_value, drawdown, metrics, result_format) \
                 VALUES ($1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'chunked_v1')")
        .bind(&id).execute(&pool).await.unwrap();

    let r = http.get(format!("{url}/api/workbench/runs/{id}/audit")).send().await.unwrap();
    assert_eq!(r.status(), 200, "有 run 行 + 结果行 ⇒ 200：{:?}", r.text().await);
    let a: Value = r.json().await.unwrap();
    assert_audit_shape(&a);
    assert_eq!(a["recorded"], json!(false), "per_bar/fills 均不可得 ⇒ recorded=false");
    assert_eq!(a["deployed_pct"], json!(0.0));
    assert_eq!(a["cash_consumed"], json!(0.0));
    assert_eq!(a["reachable_batches"], json!(0));
    assert_eq!(a["planned_tranches"], json!(100), "planned 来自 run config（与事实源无关）");
    assert_eq!(a["warnings"], json!([]), "事实源不齐不得产出「0% 投入」这类伪告警");
    // 收尾：只删本用例自己造的行（`strategy_run_result` 对 run 行 ON DELETE CASCADE）。
    sqlx::query("DELETE FROM strategy_run WHERE id = $1").bind(&id).execute(&pool).await.unwrap();
}

// ── ADR-026 §5 A3/A4：真实 run 回放（需先播种目标 run 的事实行） ──

/// 目标 run（A3）与同区间 LumpSum 对照（A4）的 id（冻结基准，见 ADR-026 §5）。
const A3_RUN: &str = "sr_1789738328788_000005";
const A4_RUN: &str = "sr_1789738272901_000004";

async fn run_exists(pool: &PgPool, id: &str) -> bool {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM strategy_run_result WHERE run_id = $1")
        .bind(id).fetch_one(pool).await.unwrap();
    n > 0
}

#[tokio::test]
async fn adr026_replay_target_run_matches_frozen_baseline() {
    let pool = pool().await;
    if !run_exists(&pool, A3_RUN).await || !run_exists(&pool, A4_RUN).await {
        eprintln!(
            "ADR-026 replay：临时库未播种 {A3_RUN} / {A4_RUN} 的事实行 ⇒ 跳过（播种见交付报告 README）"
        );
        return;
    }
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // A3：dca_baseline + Dca{tranches:100,interval:1}，518880/D1
    let a: Value = http.get(format!("{url}/api/workbench/runs/{A3_RUN}/audit"))
        .send().await.unwrap().json().await.unwrap();
    // 原始响应取证（需要时打印）：`EESTOCK_ADR026_DUMP=1 cargo test ... -- --nocapture`
    if std::env::var("EESTOCK_ADR026_DUMP").is_ok() {
        eprintln!("A3 {A3_RUN} 原始响应 = {}", serde_json::to_string_pretty(&a).unwrap());
    }
    assert_eq!(a["recorded"], json!(true), "A3 事实源：{a}");
    assert_eq!(a["capital_basis"], json!(100000.0));
    assert_eq!(a["planned_tranches"], json!(100));
    assert_eq!(a["reachable_batches"], json!(43));
    assert_eq!(a["batches_done"], json!(42));
    assert_eq!(a["unexecuted_orders"], json!(1));
    assert_eq!(a["last_bar_unfilled"], json!(true));
    assert_eq!(a["round_trips_total"], json!(1));
    assert_eq!(a["round_trips_force_closed"], json!(1));
    let dn = a["deployed_notional"].as_f64().unwrap();
    assert!((dn - 41397.97208076086).abs() < 1e-6, "deployed_notional={dn}");
    let dp = a["deployed_pct"].as_f64().unwrap();
    assert!((dp - 0.41397972).abs() < 1e-6, "deployed_pct={dp}（冻结 ≈0.41398）");
    let cc = a["cash_consumed"].as_f64().unwrap();
    assert!((cc - 41607.97208076086).abs() < 1e-6, "cash_consumed={cc}（含佣金 210 = 42×5）");
    let ccp = a["cash_consumed_pct"].as_f64().unwrap();
    assert!((ccp - 0.41607972).abs() < 1e-6, "cash_consumed_pct={ccp}（冻结 ≈0.41608）");
    let codes: Vec<&str> = a["warnings"].as_array().unwrap().iter()
        .map(|w| w["code"].as_str().unwrap()).collect();
    assert_eq!(codes, vec!["DCA_PLAN_UNDERFILLED", "PARTIAL_DEPLOYMENT", "ORDERS_UNEXECUTED"],
        "A3 三条 warning，顺序冻结：{a}");
    cross_check_with_facts(&http, &url, A3_RUN, &a).await;

    // A4：同区间 LumpSum{position_pct:1}
    let b: Value = http.get(format!("{url}/api/workbench/runs/{A4_RUN}/audit"))
        .send().await.unwrap().json().await.unwrap();
    if std::env::var("EESTOCK_ADR026_DUMP").is_ok() {
        eprintln!("A4 {A4_RUN} 原始响应 = {}", serde_json::to_string_pretty(&b).unwrap());
    }
    assert_eq!(b["recorded"], json!(true), "A4 事实源：{b}");
    assert_eq!(b["planned_tranches"], serde_json::Value::Null, "非 Dca ⇒ null");
    let bp = b["deployed_pct"].as_f64().unwrap();
    assert!((bp - 0.9998).abs() < 1e-3, "A4 deployed_pct ≈ 0.9998，实际 {bp}");
    let bcodes: Vec<&str> = b["warnings"].as_array().unwrap().iter()
        .map(|w| w["code"].as_str().unwrap()).collect();
    assert!(!bcodes.contains(&"PARTIAL_DEPLOYMENT"), "A4 满仓不得报未满仓：{b}");
    assert_eq!(b["round_trips_total"], json!(1));
    assert_eq!(b["round_trips_force_closed"], json!(1));
    assert_eq!(b["unexecuted_orders"], json!(0));
    cross_check_with_facts(&http, &url, A4_RUN, &b).await;
}

// ── ADR-026 §4：端点可观测性（tracing span 字段实际落盘） ──

/// 极简 trace 捕获器（**零新依赖**：`tracing` 已在 web 正式依赖内，无需 tracing-subscriber）。
/// 捕获 `new_span`/`record`/`event` 的字段，验证端点确实发出了契约要求的 span 与字段。
///
/// **安装方式（并发隔离）**：以 `tracing::dispatcher::set_default` 装**线程本地** scoped 订阅器
/// （非 `set_global_default`）；`#[tokio::test]` 默认 current-thread runtime ⇒ 本用例的 axum 任务
/// 与客户端同线程，端点 span 被捕获；同二进制内并发用例跑在各自线程上，其 span **不进**本订阅器。
/// 再叠加「按本用例唯一 run_id 过滤 + 不得出现异己 run_id」⇒ 并发下不可能互相捕获。
#[derive(Default)]
struct FieldBuf(Vec<(String, String)>);

impl FieldBuf {
    fn render(&self) -> String {
        self.0.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ")
    }
}

impl tracing::field::Visit for FieldBuf {
    fn record_str(&mut self, f: &tracing::field::Field, v: &str) {
        self.0.push((f.name().to_string(), v.to_string()));
    }
    fn record_f64(&mut self, f: &tracing::field::Field, v: f64) {
        self.0.push((f.name().to_string(), v.to_string()));
    }
    fn record_i64(&mut self, f: &tracing::field::Field, v: i64) {
        self.0.push((f.name().to_string(), v.to_string()));
    }
    fn record_u64(&mut self, f: &tracing::field::Field, v: u64) {
        self.0.push((f.name().to_string(), v.to_string()));
    }
    fn record_bool(&mut self, f: &tracing::field::Field, v: bool) {
        self.0.push((f.name().to_string(), v.to_string()));
    }
    fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
        self.0.push((f.name().to_string(), format!("{v:?}")));
    }
}

/// **只为 callsite interest 而存在**的空订阅器：声明 `Interest::always()` 但什么也不记录。
///
/// 为什么需要它（并发隔离的**核心**，实测教训）：`tracing` 把每个调用点的 `Interest` **全局缓存**在
/// callsite 上，且首次命中时的取值取决于**命中线程**当时的默认 dispatcher：
/// - 若首次命中发生在某个并发用例的线程上（该线程默认 = 全局 `NoSubscriber`）⇒ 缓存成 `Interest::never`；
/// - 之后本用例即使装了**线程本地**（scoped）订阅器，调用点也会被宏的 `interest.is_never()` 短路，
///   span/event 根本不会创建（实测默认并行 2/10 红：span 拿到、event 拿不到，或拿到**别人 run** 的 span）。
///
/// 把本订阅器装成**全局默认**（`set_global_default`）后，**任意线程**首次命中调用点都会得到
/// `Interest::always()`（全局订阅器对所有线程生效），再叠加一次 `rebuild_interest_cache()`
/// 抬起此前已被缓存成 `never` 的调用点 ⇒ 调用点 interest 不再受并发时序影响。
/// 它 `enabled() = false`：**不记录任何 span/event** ⇒ 捕获仍只由本线程的 scoped 订阅器完成，
/// 并发用例的 span 不会进本用例的捕获缓冲（`event()`/`new_span()` 均为 no-op）。
struct InterestOnly;

impl tracing::subscriber::Subscriber for InterestOnly {
    fn register_callsite(&self, _m: &'static tracing::Metadata<'static>) -> tracing::subscriber::Interest {
        tracing::subscriber::Interest::always()
    }
    fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool { false }
    fn new_span(&self, _a: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(0xDEAD)
    }
    fn record(&self, _s: &tracing::span::Id, _v: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _s: &tracing::span::Id, _f: &tracing::span::Id) {}
    fn event(&self, _e: &tracing::Event<'_>) {}
    fn enter(&self, _s: &tracing::span::Id) {}
    fn exit(&self, _s: &tracing::span::Id) {}
}

#[derive(Default)]
struct CaptureSubscriber {
    lines: std::sync::Mutex<Vec<(u64, String)>>,
    next: std::sync::atomic::AtomicU64,
}

impl tracing::subscriber::Subscriber for CaptureSubscriber {
    fn enabled(&self, _m: &tracing::Metadata<'_>) -> bool { true }
    fn new_span(&self, attrs: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        // `Id` 约定必须 > 0。
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let mut v = FieldBuf::default();
        attrs.record(&mut v);
        self.lines.lock().unwrap().push((id, format!("SPAN {} {}", attrs.metadata().name(), v.render())));
        tracing::span::Id::from_u64(id)
    }
    fn record(&self, span: &tracing::span::Id, values: &tracing::span::Record<'_>) {
        let mut v = FieldBuf::default();
        values.record(&mut v);
        let mut g = self.lines.lock().unwrap();
        if let Some(slot) = g.iter_mut().find(|(id, _)| *id == span.into_u64()) {
            slot.1.push(' ');
            slot.1.push_str(&v.render());
        }
    }
    fn record_follows_from(&self, _s: &tracing::span::Id, _f: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut v = FieldBuf::default();
        event.record(&mut v);
        self.lines.lock().unwrap().push((u64::MAX, format!("EVENT {} {}", event.metadata().name(), v.render())));
    }
    fn enter(&self, _span: &tracing::span::Id) {}
    fn exit(&self, _span: &tracing::span::Id) {}
}

impl CaptureSubscriber {
    fn lines(&self) -> String {
        self.lines.lock().unwrap().iter().map(|(_, l)| l.clone()).collect::<Vec<_>>().join("\n")
    }
}

/// 从捕获行里抽出所有 `run_id=` 字段值，只看带 `workbench_run_audit` 业务标识的行。
fn audit_run_ids(lines: &str) -> Vec<String> {
    lines
        .lines()
        .filter(|l| l.contains("workbench_run_audit"))
        .flat_map(|l| {
            l.split_whitespace()
                .filter_map(|t| t.strip_prefix("run_id=").map(str::to_string))
                .collect::<Vec<_>>()
        })
        .collect()
}

#[tokio::test]
async fn audit_endpoint_emits_required_tracing_fields() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let fx = fix("trace");
    clean(&pool, &fx).await;
    seed_symbol_and_bars(&pool, &fx).await;
    let vid = create_published(&http, &url, &format!("{}-trend", fx.name_prefix), TREND).await;
    let body = submit_body(&fx.code, &vid, json!({"LumpSum": {"position_pct": 0.5}}));
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let run_id = r.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    wait_terminal(&http, &url, &run_id).await;

    // ① **全局**「interest-only」订阅器（不记录任何东西）：让**任意线程**首次命中调用点都拿到
    //    `Interest::always()`，消除「首次命中发生在并发用例线程 ⇒ 调用点被永久缓存成 never」的
    //    跨用例全局状态污染（旧实现用 `set_global_default(CaptureSubscriber)` ⇒ 会捕到并发用例的 span）。
    //    随后 `rebuild_interest_cache()` 把**此前**已被缓存成 never 的调用点抬起来（含 web 侧
    //    `workbench_run_audit` 的 span/event 两个调用点）。次序：先装全局、再重算。
    let _ = tracing::dispatcher::set_global_default(tracing::Dispatch::new(InterestOnly));
    tracing::callsite::rebuild_interest_cache();

    // ② **scoped**（线程本地）订阅器承担实际捕获：`#[tokio::test]` 默认 current-thread runtime
    //    ⇒ 本用例的 axum 任务与客户端同线程，端点 span/event 只进本缓冲；
    //    并发用例的 span 在其自己线程上（进的是全局 no-op 订阅器）⇒ 不可能互相捕获。
    //    断言再加「按本用例唯一 run_id 过滤 + 不得含异己 run_id」双重保险。`_guard` 活到用例结束。
    let cap = Arc::new(CaptureSubscriber::default());
    let dispatch = tracing::Dispatch::new(cap.clone());
    let _guard = tracing::dispatcher::set_default(&dispatch);

    let r = http.get(format!("{url}/api/workbench/runs/{run_id}/audit")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let a: Value = r.json().await.unwrap();

    let lines = cap.lines();
    // 并发隔离硬断言：捕获到的审计 span/event 的 run_id **必须全部**是本用例的 run。
    let ids = audit_run_ids(&lines);
    assert!(!ids.is_empty(), "须捕获到 workbench_run_audit 的 run_id 字段：\n{lines}");
    assert!(ids.iter().all(|id| id == &run_id),
        "捕获的审计 span/event 不得含异己 run（并发用例）的 run_id：{ids:?}\n{lines}");
    let span = lines
        .lines()
        .find(|l| l.starts_with("SPAN workbench_run_audit") && l.contains(&format!("run_id={run_id}")))
        .unwrap_or_else(|| panic!("须发出本用例 run 的 workbench_run_audit span：\n{lines}"));
    for key in ["trace_id=", "run_id=", "deployed_pct=", "unexecuted_orders=", "warnings="] {
        assert!(span.contains(key), "span 缺字段 {key}：{span}");
    }
    // 事件名恒为 `event`（宏名），业务标识在 `message=workbench_run_audit` 字段。
    let ev = lines
        .lines()
        .find(|l| l.starts_with("EVENT event")
            && l.contains("message=workbench_run_audit")
            && l.contains(&format!("run_id={run_id}")))
        .unwrap_or_else(|| panic!("须发出本用例 run 的 workbench_run_audit 事件：\n{lines}"));
    for key in ["trace_id=", "run_id=", "deployed_pct=", "unexecuted_orders=", "warnings="] {
        assert!(ev.contains(key), "事件缺字段 {key}：{ev}");
    }
    // 字段值与响应体一致（不是占位常量）。
    assert!(span.contains(&format!("deployed_pct={}", a["deployed_pct"].as_f64().unwrap())),
        "span.deployed_pct 须等于响应值：{span}");
    assert!(span.contains(&format!("warnings={}", a["warnings"].as_array().unwrap().len())),
        "span.warnings 须等于响应 warning 数：{span}");

    clean(&pool, &fx).await;
}
