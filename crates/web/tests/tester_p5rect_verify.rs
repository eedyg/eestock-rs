//! **tester 独立复验（ADR-024 P5 整改 N1/N3）** —— 2026-09-18 第 254 号验收单。
//!
//! 本文件由 tester 自行撰写（非 tangle，**未 add**）；**不复用 worker 断言**
//! （worker 载体 = `crates/web/tests/adr024_structured_errors.rs`）。
//!
//! 覆盖：
//! 1. `t_n1_static_audit`：**静态枚举**两模块内每一条 400 出口，断言
//!    ① 无 `err(StatusCode::BAD_REQUEST)`（字符串形状残留）；
//!    ② 每个 `StatusCode::BAD_REQUEST` 的最近调用头是 `structured(`（而非 `err(`）；
//!    ③ web 层**零**按消息内容判码（`starts_with`/`.contains(`/`classify_config_error`）；
//!    ④ web 层引用的每个 `codes::X` 都在 `application::error::codes::ALL` 内（码集合自洽）。
//! 2. `t_n1_http_every_400_is_structured_object`：**HTTP 级**表驱动（40 条），逐条断言
//!    `status==400` + `error` 为对象 + `code`/`message`/`detail` 齐备 + `detail` 为对象；
//!    提交/试算路径并断言 `detail.period` 存在。
//! 3. `t_n1_frontend_code_map_covers_backend_codes`：`errorMessages.ts` 的码集合 ⊇ `codes::ALL`。
//! 4. `t_n3_long_d1_accepted_and_no_intersection_range_empty`：N3 —— 「6 年 D1 + 有数据 ⇒ 200」与
//!    「无交集 ⇒ 400 range_empty + 回显」两种情形（真库真数据）。
//!
//! 需要临时库：`EESTOCK_TEST_DATABASE_URL`（`scripts/testdb-init.sh` 供应）。
//! 只读契约、不改生产代码。

use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

// ─────────────────────────── 真库 + 真 axum 装配（与 tester_p5_indep 同构） ───────────────────────────

async fn pool() -> PgPool {
    test_support::test_pool().await
}

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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, web::build_router(state)).await.unwrap();
    });
    format!("http://{addr}")
}

/// 发一条请求，返回 `(status, body_json)`（`Content-Type: application/json`）。
async fn call(
    http: &reqwest::Client,
    method: &str,
    url: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let req = match method {
        "GET" => http.get(url),
        "POST" => http.post(url),
        "PUT" => http.put(url),
        other => panic!("未支持方法 {other}"),
    };
    let req = match body {
        Some(b) => req.json(&b),
        None => req,
    };
    let r = req.send().await.unwrap();
    let status = r.status().as_u16();
    let text = r.text().await.unwrap();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, v)
}

/// 结构化 400 形状断言（N1 的核心判据）：`error` 恒为对象，含 `code`/`message`/`detail`，
/// `detail` 恒为对象；**禁止**字符串形状（`{"error":"…"}`）。
fn assert_structured_400(label: &str, status: u16, body: &Value) -> String {
    assert_eq!(status, 400, "[{label}] 期望 400，实得 {status}；body={body}");
    let err = body.get("error").unwrap_or_else(|| panic!("[{label}] 无 error 字段: {body}"));
    assert!(
        err.is_object(),
        "[{label}] error 必须是**对象**（禁与字符串混用）：{err}"
    );
    let code = err
        .get("code")
        .and_then(|c| c.as_str())
        .unwrap_or_else(|| panic!("[{label}] error.code 缺失/非字符串: {err}"));
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or_else(|| panic!("[{label}] error.message 缺失/非字符串: {err}"));
    assert!(!msg.is_empty(), "[{label}] error.message 不得为空");
    let detail = err
        .get("detail")
        .unwrap_or_else(|| panic!("[{label}] error.detail 缺失: {err}"));
    assert!(detail.is_object(), "[{label}] error.detail 必须是对象: {detail}");
    code.to_string()
}

// ─────────────────────────── 1. 静态枚举审计 ───────────────────────────

const WORKBENCH_SRC: &str = include_str!("../src/workbench.rs");
const STRATEGIES_SRC: &str = include_str!("../src/strategies.rs");
const ERROR_SRC: &str = include_str!("../../application/src/error.rs");
const FRONTEND_ERR_MSG: &str = include_str!("../../../web/src/api/errorMessages.ts");

/// 字节安全的「向左右扩张到合法字符边界」切片（源码含中文注释）。
fn slice_chars(s: &str, from: usize, to: usize) -> &str {
    let mut a = from.min(s.len());
    let mut b = to.min(s.len());
    while a > 0 && !s.is_char_boundary(a) {
        a -= 1;
    }
    while b < s.len() && !s.is_char_boundary(b) {
        b += 1;
    }
    &s[a..b]
}

/// 每个 `StatusCode::BAD_REQUEST` 的**最近调用头**必须是 `structured(`（不得是 `err(`）。
fn audit_bad_request_sites(file: &str, name: &str) {
    assert!(
        !file.contains("err(StatusCode::BAD_REQUEST"),
        "[{name}] 不得存在 `err(StatusCode::BAD_REQUEST…)`（字符串形状残留）"
    );
    let needle = "StatusCode::BAD_REQUEST";
    let mut idx = 0usize;
    let mut n = 0usize;
    while let Some(pos) = file[idx..].find(needle) {
        let abs = idx + pos;
        n += 1;
        // 同语句内的调用头：从 pos 往前看 400 字节，取最后一个 `structured(` / `err(` 出现位置，
        // 要求 `structured(` 更近（其自身函数定义 `fn structured(` 也算通过）。
        let start = abs.saturating_sub(400);
        let head = slice_chars(file, start, abs);
        let last_structured = head.rfind("structured(");
        let last_err = head.rfind("err(");
        let ok = match (last_structured, last_err) {
            (Some(s0), Some(e0)) => s0 > e0,
            (Some(_), None) => true,
            _ => false,
        };
        assert!(
            ok,
            "[{name}] 第 {abs} 字节处的 StatusCode::BAD_REQUEST 不在 structured( 调用内:\n{}",
            slice_chars(file, start, abs + 40)
        );
        idx = abs + needle.len();
    }
    assert!(n > 0, "[{name}] 未找到任何 StatusCode::BAD_REQUEST —— 静态枚举失效（应至少 1 处）");
    println!("[N1-静态] {name}: {n} 处 StatusCode::BAD_REQUEST，全部位于 structured( 调用内");
}

#[test]
fn t_n1_static_audit() {
    // ①/② 每处 400 都走 structured(（workbench.rs 内联结构化；strategies.rs 由 structured() 内部固定 400）
    audit_bad_request_sites(WORKBENCH_SRC, "workbench.rs");
    audit_bad_request_sites(STRATEGIES_SRC, "strategies.rs");

    // ③ web 层不得按消息内容判码（码必须由 application 校验点同源给出）
    for (name, src) in [("workbench.rs", WORKBENCH_SRC), ("strategies.rs", STRATEGIES_SRC)] {
        for pat in ["classify_config_error", "msg.contains(", "message.contains(", ".starts_with("] {
            assert!(
                !src.contains(pat),
                "[{name}] web 层出现按消息内容判码的痕迹 `{pat}`（应只读 application 给出的 code）"
            );
        }
        println!("[N1-静态] {name}: 无 classify_config_error / contains / starts_with —— 零消息解析");
    }
    // `classify_config_error` 只在 application 层定义与调用（单点）
    assert!(ERROR_SRC.contains("pub fn classify_config_error"));
    assert!(!WORKBENCH_SRC.contains("classify_config_error"));
    assert!(!STRATEGIES_SRC.contains("classify_config_error"));

    // ④ web 层引用的 `codes::X` 必须都在 codes::ALL 内（码集合自洽；防「旁路码」）
    //    从 error.rs 解析 `pub const NAME: &str = "value";` 与 ALL 列表。
    let mut defined: Vec<(String, String)> = Vec::new();
    for line in ERROR_SRC.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("pub const ") {
            if let Some((name, tail)) = rest.split_once(": &str = ") {
                if let Some(val) = tail.trim().trim_end_matches(';').strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                    defined.push((name.trim().to_string(), val.to_string()));
                }
            }
        }
    }
    let all_block = ERROR_SRC
        .split("pub const ALL: &[&str] = &[")
        .nth(1)
        .and_then(|s| s.split("];").next())
        .expect("codes::ALL 未找到");
    // ALL 表里写的是**常量名** ⇒ 解析成字面值集合
    let all: Vec<String> = all_block
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|name| {
            defined
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("codes::ALL 里的 {name} 无对应常量定义"))
        })
        .collect();
    assert!(all.len() >= 20, "codes::ALL 解析异常: {all:?}");

    let mut used: Vec<String> = Vec::new();
    for src in [WORKBENCH_SRC, STRATEGIES_SRC] {
        for tok in src.split("codes::").skip(1) {
            let name: String = tok
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() && name != "ALL" {
                used.push(name);
            }
        }
    }
    used.sort();
    used.dedup();
    assert!(used.len() >= 10, "web 层码引用解析异常（{} 个）: {used:?}", used.len());
    for u in &used {
        let val = defined
            .iter()
            .find(|(n, _)| n == u)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| panic!("web 层引用了 error.rs 未定义的码常量 codes::{u}"));
        assert!(
            all.contains(&val),
            "web 层使用的 `codes::{u}` = \"{val}\" **不在** codes::ALL 表内（码集合不自洽）"
        );
        let used_by_other = [WORKBENCH_SRC, STRATEGIES_SRC]
            .iter()
            .any(|s| s.contains(&format!("codes::{u}")));
        assert!(used_by_other);
    }
    println!(
        "[N1-静态] web 层引用码 {} 个，全部在 codes::ALL（{} 个）内：{used:?}",
        used.len(),
        all.len()
    );
}

// ─────────────────────────── 2. HTTP 级：每条 400 都是结构化对象 ───────────────────────────

/// 表驱动用例：`(标签, 方法, 路径, body, 期望 code, detail.period 判据)`。
/// 路径中的 `{BASE}` 由运行时替换。
/// `period` 判据：`"req"` = 必须回显（application 校验点同源码，经 `map_svc_err_ctx` 合并 ctx）；
/// `"gap"` = **当前不回显**（web 层早退校验，见报告 N1-r）——**钉住现状**，一旦补齐即红（提醒更新报告）；
/// `"-"` = 非提交/试算路径，不做 period 判据。
type Case = (&'static str, &'static str, &'static str, Option<Value>, &'static str, &'static str);

const PERIOD_REQ: &str = "req";
const PERIOD_GAP: &str = "gap";
const PERIOD_NA: &str = "-";

fn cases(ver_published: &str, ver_draft: &str) -> Vec<Case> {
    let submit = |symbol: &str, period: &str, from: &str, to: &str, slots: Value, extra: Value| -> Value {
        let mut v = json!({
            "symbol": symbol, "period": period, "from": from, "to": to,
            "slots": slots, "policy": {"LumpSum": {"position_pct": 1.0}},
        });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    };
    let ok_slot = json!([{ "version_id": ver_published, "params": {}, "weight": 1.0 }]);
    let testrun = |code: &str, symbol: &str, period: &str, from: &str, to: &str, extra: Value| -> Value {
        let mut v = json!({
            "code": code, "symbol": symbol, "period": period,
            "from": from, "to": to, "mode": "pure_score",
        });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    };
    let good_code = "function on_bar(ctx) { return 50; }";
    let good_d1 = ("2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z");

    vec![
        // ── POST /api/workbench/runs（web 预校验：period 为 web 早退，未并入 ctx ⇒ gap）──
        ("runs/symbol_required", "POST", "/api/workbench/runs",
         Some(submit("  ", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(), json!({}))),
         "symbol_required", PERIOD_GAP),
        ("runs/period_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "W1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(), json!({}))),
         "period_invalid", PERIOD_REQ),
        ("runs/from_bad", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "not-a-ts", "2025-02-01T00:00:00Z", ok_slot.clone(), json!({}))),
         "timestamp_invalid", PERIOD_GAP),
        ("runs/to_bad", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "not-a-ts", ok_slot.clone(), json!({}))),
         "timestamp_invalid", PERIOD_GAP),
        ("runs/from_after_to", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-02-01T00:00:00Z", "2025-01-01T00:00:00Z", ok_slot.clone(), json!({}))),
         "from_after_to", PERIOD_GAP),
        ("runs/slots_empty", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", json!([]), json!({}))),
         "slots_invalid", PERIOD_GAP),
        ("runs/fee_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(),
                     json!({"fee": {"rate_pct": "x"}}))),
         "fee_invalid", PERIOD_GAP),
        // ── POST /api/workbench/runs（application 校验点码，经 map_svc_err_ctx 并入 period ctx）──
        ("runs/symbol_unregistered", "POST", "/api/workbench/runs",
         Some(submit("830000991", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(), json!({}))),
         "symbol_unregistered", PERIOD_REQ),
        ("runs/version_not_runnable", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z",
                     json!([{ "version_id": ver_draft, "params": {}, "weight": 1.0 }]), json!({}))),
         "version_not_runnable", PERIOD_REQ),
        ("runs/weight_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z",
                     json!([{ "version_id": ver_published, "params": {}, "weight": 0.0 }]), json!({}))),
         "weight_invalid", PERIOD_REQ),
        ("runs/slot_vid_empty", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z",
                     json!([{ "version_id": "", "params": {}, "weight": 1.0 }]), json!({}))),
         "slots_invalid", PERIOD_REQ),
        ("runs/policy_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(),
                     json!({"policy": {"Bogus": {}}}))),
         "policy_invalid", PERIOD_REQ),
        ("runs/stop_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(),
                     json!({"stop": {"kind": "Trailing", "value": -1.0}}))),
         "stop_invalid", PERIOD_REQ),
        ("runs/threshold_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(),
                     json!({"buy_threshold": 40.0, "sell_threshold": 60.0}))),
         "threshold_invalid", PERIOD_REQ),
        ("runs/capital_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", ok_slot.clone(),
                     json!({"initial_capital": 0.0}))),
         "capital_invalid", PERIOD_REQ),
        ("runs/params_invalid", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z",
                     json!([{ "version_id": ver_published, "params": { "__not_in_schema__": 1 }, "weight": 1.0 }]),
                     json!({}))),
         "params_invalid", PERIOD_REQ),
        ("runs/range_empty", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2030-01-01T00:00:00Z", "2031-01-01T00:00:00Z", ok_slot.clone(), json!({}))),
         "range_empty", PERIOD_REQ),
        ("runs/resource_guard(confirm=false)", "POST", "/api/workbench/runs",
         Some(submit("518880", "M1", "2021-01-01T00:00:00Z", "2026-01-01T00:00:00Z", ok_slot.clone(), json!({}))),
         "resource_guard", PERIOD_REQ),
        // ── GET /api/workbench/available_range ──
        ("available_range/symbol_required", "GET", "/api/workbench/available_range?symbol=&period=M1",
         None, "symbol_required", PERIOD_NA),
        ("available_range/period_invalid", "GET", "/api/workbench/available_range?symbol=518880&period=W1",
         None, "period_invalid", PERIOD_NA),
        // ── GET /api/workbench/runs ──
        ("list_runs/status_invalid", "GET", "/api/workbench/runs?status=bogus", None, "status_invalid", PERIOD_NA),
        // ── GET …/bars、…/curve ──
        ("bars/kind_invalid", "GET", "/api/workbench/runs/sr_x/bars?kind=fills", None, "kind_invalid", PERIOD_NA),
        ("curve/kind_invalid", "GET", "/api/workbench/runs/sr_x/curve?kind=bogus", None, "kind_invalid", PERIOD_NA),
        ("bars/paging_and_range", "GET", "/api/workbench/runs/sr_x/bars?offset=0&from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z",
         None, "request_invalid", PERIOD_NA),
        ("bars/range_missing_to", "GET", "/api/workbench/runs/sr_x/bars?from=2025-01-01T00:00:00Z",
         None, "request_invalid", PERIOD_NA),
        ("bars/from_bad", "GET", "/api/workbench/runs/sr_x/bars?from=bad&to=2025-02-01T00:00:00Z",
         None, "timestamp_invalid", PERIOD_NA),
        ("bars/to_bad", "GET", "/api/workbench/runs/sr_x/bars?from=2025-01-01T00:00:00Z&to=bad",
         None, "timestamp_invalid", PERIOD_NA),
        ("bars/from_after_to", "GET", "/api/workbench/runs/sr_x/bars?from=2025-02-01T00:00:00Z&to=2025-01-01T00:00:00Z",
         None, "from_after_to", PERIOD_NA),
        // ── compare / presets ──
        ("compare/ids_required", "POST", "/api/workbench/runs/compare", Some(json!({"ids": []})),
         "ids_required", PERIOD_NA),
        ("presets/name_required", "POST", "/api/workbench/presets", Some(json!({"name": "   ", "config": {}})),
         "name_required", PERIOD_NA),
        ("presets/put_name_required", "PUT", "/api/workbench/presets/pr_x", Some(json!({"name": "", "config": {}})),
         "name_required", PERIOD_NA),
        ("presets/config_invalid", "POST", "/api/workbench/presets", Some(json!({"name": "tester-p5rv", "config": "not-an-object"})),
         "config_invalid", PERIOD_NA),
        // ── strategies 族（web 预校验）──
        ("strategies/level_invalid", "GET", "/api/strategies?level=bogus", None, "level_invalid", PERIOD_NA),
        ("strategies/kind_invalid", "GET", "/api/strategies?kind=bogus", None, "kind_invalid", PERIOD_NA),
        ("strategies/name_required", "POST", "/api/strategies",
         Some(json!({"name": "  ", "code": good_code})), "name_required", PERIOD_NA),
        ("strategies/code_required", "POST", "/api/strategies",
         Some(json!({"name": "tester-p5rv", "code": " "})), "code_required", PERIOD_NA),
        ("strategies/create_kind_invalid", "POST", "/api/strategies",
         Some(json!({"name": "tester-p5rv", "code": good_code, "kind": "bogus"})), "kind_invalid", PERIOD_NA),
        ("strategies/manage_kind_invalid", "GET", "/api/strategies/manage?kind=bogus", None, "kind_invalid", PERIOD_NA),
        ("strategies/draft_source_invalid", "POST", "/api/strategies/st_x/versions",
         Some(json!({"from_version_id": "  "})), "source_invalid", PERIOD_NA),
        ("strategies/update_code_required", "PUT", "/api/strategies/versions/sv_x",
         Some(json!({"code": "  "})), "code_required", PERIOD_NA),
        ("strategies/diff_missing_params", "GET", "/api/strategies/versions/diff", None, "request_invalid", PERIOD_NA),
        // ── POST /api/strategies/test-run（web 早退：gap）──
        ("test-run/source_invalid", "POST", "/api/strategies/test-run",
         Some(json!({"symbol": "518880", "period": "D1", "from": good_d1.0, "to": good_d1.1, "mode": "pure_score"})),
         "source_invalid", PERIOD_GAP),
        ("test-run/symbol_required", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "  ", "D1", good_d1.0, good_d1.1, json!({}))), "symbol_required", PERIOD_GAP),
        ("test-run/mode_invalid", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "D1", good_d1.0, good_d1.1, json!({"mode": "bogus"}))),
         "mode_invalid", PERIOD_GAP),
        ("test-run/from_bad", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "D1", "bad", good_d1.1, json!({}))), "timestamp_invalid", PERIOD_GAP),
        ("test-run/to_bad", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "D1", good_d1.0, "bad", json!({}))), "timestamp_invalid", PERIOD_GAP),
        ("test-run/from_after_to", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "D1", good_d1.1, good_d1.0, json!({}))), "from_after_to", PERIOD_GAP),
        // ── POST /api/strategies/test-run（application 校验点码，经 map_svc_err_ctx 并入 period ctx）──
        ("test-run/period_invalid", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "W1", good_d1.0, good_d1.1, json!({}))), "period_invalid", PERIOD_REQ),
        ("test-run/code_invalid", "POST", "/api/strategies/test-run",
         Some(testrun("const x = ;", "518880", "D1", good_d1.0, good_d1.1, json!({}))), "code_invalid", PERIOD_REQ),
        ("test-run/policy_invalid", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "D1", good_d1.0, good_d1.1,
                      json!({"policy": {"Dca": {"tranches": 0, "mode": "FixedTranches"}}}))),
         "policy_invalid", PERIOD_REQ),
        ("test-run/capital_invalid", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "D1", good_d1.0, good_d1.1, json!({"initial_capital": -1.0}))),
         "capital_invalid", PERIOD_REQ),
        ("test-run/range_empty", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "D1", "2030-01-01T00:00:00Z", "2031-01-01T00:00:00Z", json!({}))),
         "range_empty", PERIOD_REQ),
        ("test-run/resource_guard(confirm=false)", "POST", "/api/strategies/test-run",
         Some(testrun(good_code, "518880", "M1", "2021-01-01T00:00:00Z", "2026-01-01T00:00:00Z", json!({}))),
         "resource_guard", PERIOD_REQ),
    ]
}

async fn seed_published_version(pool: &PgPool) -> String {
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM strategy_version WHERE status = 'published' ORDER BY id LIMIT 1",
    )
    .fetch_one(pool)
    .await
    .expect("临时库基线应含 published 版本")
}

async fn seed_draft_version(pool: &PgPool) -> String {
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM strategy_version WHERE status = 'draft' ORDER BY id LIMIT 1",
    )
    .fetch_one(pool)
    .await
    .expect("临时库基线应含 draft 版本")
}

#[tokio::test]
async fn t_n1_http_every_400_is_structured_object() {
    let pool = pool().await;
    let ver_pub = seed_published_version(&pool).await;
    let ver_draft = seed_draft_version(&pool).await;
    let base = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let table = cases(&ver_pub, &ver_draft);

    let mut seen: Vec<String> = Vec::new();
    let mut gaps: Vec<String> = Vec::new();
    let mut with_period = 0usize;
    for (label, method, path, body, expect_code, period_rule) in table {
        let url = format!("{base}{path}");
        let (status, v) = call(&http, method, &url, body).await;
        let code = assert_structured_400(label, status, &v);
        assert_eq!(code, expect_code, "[{label}] code 不符；body={v}");
        match period_rule {
            "req" => {
                let period = v["error"]["detail"]["period"].as_str();
                assert!(
                    period.is_some(),
                    "[{label}] application 校验点同源 400 必须回显 detail.period；body={v}"
                );
                with_period += 1;
                println!("[{label}] code={code} detail.period={:?}", period.unwrap());
            }
            "gap" => {
                let period = v["error"]["detail"]["period"].as_str();
                assert!(
                    period.is_none(),
                    "[{label}] 现状已回显 detail.period（N1-r 缺口被补齐）——请更新报告 N1-r；body={v}"
                );
                gaps.push(format!("{label}({code})"));
                println!("[{label}] code={code} detail={} <<< N1-r: 无 detail.period", v["error"]["detail"]);
            }
            _ => println!("[{label}] code={code} detail={}", v["error"]["detail"]),
        }
        seen.push(format!("{label}={code}"));
    }
    assert!(seen.len() >= 45, "表驱动用例数不足（{}）", seen.len());
    println!("[N1-HTTP] {} 条 400 用例全部结构化（error 为对象 + code + message + detail 对象）", seen.len());
    println!("[N1-HTTP] 其中 {} 条（提交/试算）回显 detail.period", with_period);
    println!("[N1-r] web 层早退 400（无 detail.period）{} 条：{gaps:?}", gaps.len());
    let mut codes: Vec<&str> = seen.iter().map(|s0| s0.rsplit_once('=').unwrap().1).collect();
    codes.sort();
    codes.dedup();
    println!("[N1-HTTP] 覆盖码 {} 个: {codes:?}", codes.len());

    // 护栏二次确认放行（confirm=true）：提交路径 201 / 试算路径 200（证明 resource_guard 可编程消费）。
    let (status, v) = call(
        &http,
        "POST",
        &format!("{base}/api/workbench/runs"),
        Some(json!({
            "symbol": "518880", "period": "M1",
            "from": "2021-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z",
            "slots": [{ "version_id": ver_pub, "params": {}, "weight": 1.0 }],
            "policy": {"LumpSum": {"position_pct": 1.0}},
            "confirm": true,
        })),
    )
    .await;
    assert_eq!(status, 201, "resource_guard 带 confirm=true 重提应 201；body={v}");
    println!("[N1-guard] 提交路径 confirm=true ⇒ 201 run={}", v["id"]);
    let (status, v) = call(
        &http,
        "POST",
        &format!("{base}/api/strategies/test-run"),
        Some(json!({
            "code": "function on_bar(ctx) { return 50; }",
            "symbol": "518880", "period": "M1",
            "from": "2021-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z",
            "mode": "pure_score", "confirm": true,
        })),
    )
    .await;
    assert_eq!(status, 200, "试算 resource_guard 带 confirm=true 应 200；body={v}");
    println!("[N1-guard] 试算路径 confirm=true ⇒ 200 bar_count={}", v["bar_count"]);
}

// ─────────────────────────── 3. 前端码映射 parity ───────────────────────────

#[test]
fn t_n1_frontend_code_map_covers_backend_codes() {
    let all_block = ERROR_SRC
        .split("pub const ALL: &[&str] = &[")
        .nth(1)
        .and_then(|s| s.split("];").next())
        .expect("codes::ALL 未找到");
    // ALL 表里写的是常量名，转成字面值
    let mut defined: Vec<(String, String)> = Vec::new();
    for line in ERROR_SRC.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("pub const ") {
            if let Some((name, tail)) = rest.split_once(": &str = ") {
                if let Some(val) = tail.trim().trim_end_matches(';').strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                    defined.push((name.trim().to_string(), val.to_string()));
                }
            }
        }
    }
    let mut missing: Vec<String> = Vec::new();
    for name in all_block.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let val = defined
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| panic!("codes::ALL 里的 {name} 无对应常量定义"));
        if !FRONTEND_ERR_MSG.contains(&format!("{val}:")) {
            missing.push(val);
        }
    }
    assert!(
        missing.is_empty(),
        "前端 errorMessages.ts 缺少后端码映射（新增码未覆盖）: {missing:?}"
    );
    println!("[N1-前端] codes::ALL 全部码在 errorMessages.ts 有中文映射");

    // 未知码回退 message 的**实现存在性**（契约：不得只显示「未知错误」/不回退）
    assert!(FRONTEND_ERR_MSG.contains("if (!hint) return message;"), "未知码必须回退 message");
    // 两条消费路径接入
    let store_src = include_str!("../../../web/src/features/workbench/store.ts");
    let testrun_src = include_str!("../../../web/src/features/strategies/TestRunPanel.tsx");
    assert!(store_src.contains("errorDisplayText"), "工作台提交路径未接入 errorDisplayText");
    assert!(testrun_src.contains("errorDisplayText"), "在线试算路径未接入 errorDisplayText");
    println!("[N1-前端] 两条消费路径（workbench/store.ts、strategies/TestRunPanel.tsx）均接入 errorDisplayText");
}

// ─────────────────────────── 4. N3：6 年 D1 有数据 ⇒ 200 / 无交集 ⇒ range_empty ───────────────────────────

#[tokio::test]
async fn t_n3_long_d1_accepted_and_no_intersection_range_empty() {
    let pool = pool().await;
    let base = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = "function on_bar(ctx) { return 50; }";

    // (a) 6 年 D1（> 旧 5 年日历档）+ 有数据 ⇒ 200（真跑）
    let (status, v) = call(
        &http,
        "POST",
        &format!("{base}/api/strategies/test-run"),
        Some(json!({
            "code": code, "symbol": "518880", "period": "D1",
            "from": "2020-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z",
            "mode": "pure_score",
        })),
    )
    .await;
    assert_eq!(status, 200, "6 年 D1 + 有数据应 200（日历档已删），实得 {status}；body={v}");
    let bars = v["bar_count"].as_i64().unwrap_or(0);
    assert!(bars > 1000, "6 年 D1 应真跑出 > 1000 根 bar，实得 {bars}");
    assert_eq!(v["clamped"], json!(false), "恰在数据范围内的请求不应 clamped；body={v}");
    assert_eq!(v["requested_from"], json!("2020-01-01T00:00:00Z"));
    assert_eq!(v["requested_to"], json!("2026-01-01T00:00:00Z"));
    assert_eq!(v["effective_from"], v["requested_from"]);
    assert_eq!(v["effective_to"], v["requested_to"]);
    println!("[N3-a] 6 年 D1 有数据 ⇒ 200 bar_count={bars} clamped=false requested==effective");

    // (b) 无交集 ⇒ 400 range_empty + 回显可用区间（不是「区间超限」语义）
    let (status, v) = call(
        &http,
        "POST",
        &format!("{base}/api/strategies/test-run"),
        Some(json!({
            "code": code, "symbol": "518880", "period": "D1",
            "from": "2030-01-01T00:00:00Z", "to": "2031-01-01T00:00:00Z",
            "mode": "pure_score",
        })),
    )
    .await;
    let cd = assert_structured_400("n3-range_empty", status, &v);
    assert_eq!(cd, "range_empty");
    assert!(v["error"]["detail"]["available_from"].is_string(), "须回显 available_from；body={v}");
    assert!(v["error"]["detail"]["available_to"].is_string(), "须回显 available_to；body={v}");
    assert!(v["error"]["detail"]["period"].is_string(), "试算路径须回显 detail.period；body={v}");
    let msg = v["error"]["message"].as_str().unwrap();
    assert!(
        !msg.contains("超限") && !msg.contains("5 年") && !msg.contains("上限"),
        "message 不得残留日历档语义：{msg}"
    );
    println!(
        "[N3-b] 无交集 ⇒ 400 range_empty available=[{} .. {}] message={msg}",
        v["error"]["detail"]["available_from"], v["error"]["detail"]["available_to"]
    );
}
