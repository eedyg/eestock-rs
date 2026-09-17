//! 多周期配置端点集成测试（**红测试，P1-A**）：`GET/PUT /api/config/multi_period` 的配置面与 7 条校验 + 总 pane 护栏。
//! 非 tangle 手写（契约在 `design/15-multi-period/02-spec.md` §2/§7；形状照 `api_ma_config.rs` 三层：
//! `dto` 校验 + `rest` 端点 + `ConfigStore`/`app_config` key=`multi_period`）。
//!
//! 权威依据：`design/15-multi-period/02-spec.md` §2（配置契约 7 条）、§7（护栏 4 条）、`03-test-plan.md` T6。
//! 预期 red 理由：**端点/DTO 尚不存在** ⇒ 每个用例以 404（未注册路由）失败，非 200/400 断言不符。
//!
//! **P1-D-1 追加（P1-C 缺陷 D1：`indicators` 未按 §2-6 去重）**：见本文件 `d1_*` 两个用例 ——
//! ① `["dcap","dcap"]` ⇒ 200 且回显/读回归一化为 `["dcap"]`；② 重复项不得伪造 >12 pane
//! （4 周期 × `["dcap"]×3/11/12` 必 200，读回 4 周期 × `["dcap"]`）。
//! 纯函数侧的 D1 计数语义 + D2 错误串维度名见 `crates/web/tests/multi_period_pane_budget.rs`。
//!
//! ⚠️ 库卫生（共享 dev 库 127.0.0.1:5433 的 app_config，与线上 app 同库）：
//! 1. 本 binary 只碰 key = `multi_period`（当前库中**不存在**该键，见执行报告 §4）；
//! 2. 每个用例开头 `clear_multi_period` + 结尾清理 ⇒ 收敛到「无键 ⇒ 默认关闭」；
//! 3. 全部落库写入**一律 `enabled=false`**（含负例被拒时的前置合法配置）⇒ 即使异常残留，
//!    GET 回默认关闭，**不改变线上行为**；
//! 4. 同 binary 内用例共用同一个 key ⇒ 必须串行（`MULTI_PERIOD_LOCK`），否则「清键→GET 默认」与
//!    「PUT 落库」并行存在执行序竞态（同一根因见 `api_settings.rs` §CONFIG_LOCK 注释）。
//! 5. 端点请求只打到**本进程自建临时端口** axum 实例（`127.0.0.1:0`），不触碰线上 8081/8082。

use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

/// 端点路径（口径 `02-spec.md` §2；下划线命名，勿写成 `multi-period`）。
const PATH: &str = "/api/config/multi_period";

/// 受支持指标集合（首版仅 dcap；`02-spec.md` §2 校验 6）。
const SUPPORTED_INDICATORS: [&str; 1] = ["dcap"];

/// 默认基准高度 px（`02-spec.md` §6：默认基准 420 / 卫星 180）。
const DEFAULT_BASE_HEIGHT: i64 = 420;

/// 高度合法区间（`02-spec.md` §2 校验 5）。
const HEIGHT_MIN: i64 = 80;
const HEIGHT_MAX: i64 = 1200;

async fn pool() -> PgPool {
    // ADR-023 E6b：统一测试库入口（EESTOCK_TEST_DATABASE_URL + 哨兵表校验），不得回退活库。
    test_support::test_pool().await
}

/// 测试装配（与 app bin 同结构；storage/sqlx 仅 dev-deps）——照 `api_ma_config.rs`。
fn state(pool: PgPool) -> Arc<AppState> {
    let backtest_hub = WsHub::new();
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
            app_version: env!("CARGO_PKG_VERSION").to_string(),
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
    tokio::spawn(async move { axum::serve(listener, web::build_router(state)).await.unwrap(); });
    format!("http://{addr}")
}

/// app_config 串行锁：本 binary 内全部用例共用 `multi_period` 单键 ⇒ 必须互斥（见文件头 ⚠️ 4）。
static MULTI_PERIOD_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

fn multi_period_lock() -> &'static tokio::sync::Mutex<()> {
    MULTI_PERIOD_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 清 `multi_period` 键（只删该键，不抹其它键；收敛到「无键 ⇒ 默认」）。
async fn clear_multi_period(pool: &PgPool) {
    sqlx::query("DELETE FROM app_config WHERE key = 'multi_period'")
        .execute(pool)
        .await
        .unwrap();
}

/// 直接落库 `app_config[multi_period]`（模拟无键之外的存量：坏形状 / 越界旧值）。
async fn seed_raw(pool: &PgPool, value: Value) {
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES ('multi_period', $1) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(value)
    .execute(pool)
    .await
    .unwrap();
}

/// 合法 body 构造器（heights 与 periods 一一对应；基准 420 / 卫星 180）。
fn body(enabled: bool, periods: &[&str], indicators: &[&str]) -> Value {
    let mut heights = serde_json::Map::new();
    for (i, p) in periods.iter().enumerate() {
        heights.insert((*p).to_string(), json!(if i == 0 { DEFAULT_BASE_HEIGHT } else { 180 }));
    }
    json!({ "enabled": enabled, "periods": periods, "heights": heights, "indicators": indicators })
}

/// 默认口径断言（`02-spec.md` §2：无键/坏值 ⇒ `enabled=false` + 单元素基准 + 高度 420 + `["dcap"]`）。
/// 只锁**结构**（基准周期字面量由实现选取，本测试不写死，避免把未裁决口径钉死）：
/// - `enabled === false`；`periods` 恰 1 个元素且 ∈ 合法周期 \ {1mo}；
/// - `heights` 与 `periods` 同键且唯一，值 = 420；
/// - `indicators === ["dcap"]`。
fn assert_default_shape(v: &Value, label: &str) {
    assert_eq!(v["enabled"], json!(false), "{label}: enabled 默认 false");
    let periods = v["periods"].as_array().unwrap_or_else(|| panic!("{label}: periods 必须是数组"));
    assert_eq!(periods.len(), 1, "{label}: 默认仅 1 个周期（基准）：{periods:?}");
    let base = periods[0].as_str().unwrap_or_else(|| panic!("{label}: 基准必须是字符串"));
    assert!(
        ["1m", "5m", "15m", "1h", "1d", "1w"].contains(&base),
        "{label}: 默认基准 ∈ 合法周期 \\ {{1mo}}，收到 {base}"
    );
    let heights = v["heights"].as_object().unwrap_or_else(|| panic!("{label}: heights 必须是对象"));
    assert_eq!(heights.len(), 1, "{label}: heights 键必须与 periods 一致：{heights:?}");
    let h = heights.get(base).unwrap_or_else(|| panic!("{label}: heights 缺基准键 {base}"));
    assert_eq!(h, &json!(DEFAULT_BASE_HEIGHT), "{label}: 默认基准高度 420，收到 {h}");
    assert_eq!(
        v["indicators"],
        json!(SUPPORTED_INDICATORS),
        "{label}: indicators 默认 [\"dcap\"]"
    );
}

/// 断言 PUT 被**明确拒绝**：400 + 错误体含被拒字段名 + 不回显任何配置字段（不得静默截断/归一化）。
async fn assert_rejected(http: &reqwest::Client, url: &str, body: &Value, field: &str, case: &str) {
    let r = http.put(format!("{url}{PATH}")).json(body).send().await
        .unwrap_or_else(|e| panic!("【{case}】请求失败：{e}"));
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    assert_eq!(status, 400, "【{case}】必须 400，收到 {status}，body={text}");
    let v: Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("【{case}】400 body 不是 JSON（{e}）：{text}"));
    let msg = v["error"].as_str()
        .unwrap_or_else(|| panic!("【{case}】400 body 必须含 error 描述，收到 {text}"));
    assert!(msg.contains(field), "【{case}】错误信息必须含被拒字段名 `{field}`，收到：{msg}");
    assert!(
        v.get("periods").is_none() && v.get("heights").is_none() && v.get("indicators").is_none(),
        "【{case}】拒绝时不得回显/截断后的配置字段，收到 {text}"
    );
}

// ── T6 (§2 读侧)：GET 无键 ⇒ 200 默认；坏形状 / 越界旧值 ⇒ 200 回默认（**不 500**）──

#[tokio::test]
async fn t6_get_without_key_returns_defaults_200() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    let r = http.get(format!("{url}{PATH}")).send().await.unwrap();
    assert_eq!(r.status(), 200, "GET 无键 ⇒ 200（不得 500）");
    let v: Value = r.json().await.unwrap();
    assert_default_shape(&v, "GET 无键默认");

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_get_falls_back_to_defaults_on_bad_or_out_of_range_stored_values() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 存量样本（全部为「GET 必须回默认」的坏值；enabled 一律 true 以证明回默认确实把开关也压回 false）
    let samples: Vec<(&str, Value)> = vec![
        // ① 坏形状：字段类型错（enabled 非 bool、periods 非数组）
        ("字段类型错(enabled/periods)", json!({
            "enabled": "yes", "periods": "oops",
            "heights": { "1m": 420 }, "indicators": ["dcap"]
        })),
        // ② 非对象标量（jsonb 语法合法但形状非法 ⇒ 等价「坏 JSON」）
        ("非对象标量", json!("not-an-object")),
        // ③ 缺字段 / 键不全
        ("缺字段", json!({ "enabled": true })),
        // ④ 越界旧值：高度 5000 ∉ [80,1200]
        ("高度越界 5000", json!({
            "enabled": true, "periods": ["1m", "5m"],
            "heights": { "1m": 5000, "5m": 180 }, "indicators": ["dcap"]
        })),
        // ⑤ 越界旧值：周期数 5 > 4
        ("周期数 5", json!({
            "enabled": true, "periods": ["1m", "5m", "15m", "1h", "1d"],
            "heights": { "1m": 420, "5m": 180, "15m": 180, "1h": 180, "1d": 180 },
            "indicators": ["dcap"]
        })),
        // ⑥ 越界旧值：重复周期
        ("重复周期", json!({
            "enabled": true, "periods": ["1m", "1m"],
            "heights": { "1m": 420 }, "indicators": ["dcap"]
        })),
        // ⑦ 越界旧值：含 1mo（用户裁决不提供）
        ("含 1mo", json!({
            "enabled": true, "periods": ["1m", "1mo"],
            "heights": { "1m": 420, "1mo": 180 }, "indicators": ["dcap"]
        })),
        // ⑧ 越界旧值：1w 但基准 1m（口径 10）
        ("1w 基准<1d", json!({
            "enabled": true, "periods": ["1m", "1w"],
            "heights": { "1m": 420, "1w": 180 }, "indicators": ["dcap"]
        })),
        // ⑨ 越界旧值：未支持指标
        ("未支持指标", json!({
            "enabled": true, "periods": ["1m", "5m"],
            "heights": { "1m": 420, "5m": 180 }, "indicators": ["macd"]
        })),
    ];

    for (label, raw) in samples {
        seed_raw(&pool, raw.clone()).await;
        let r = http.get(format!("{url}{PATH}")).send().await.unwrap();
        let status = r.status();
        let text = r.text().await.unwrap_or_default();
        assert_eq!(status, 200, "【存量 {label}】GET 必须 200（**不 500**），收到 {status}，body={text}");
        let v: Value = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("【存量 {label}】body 不是 JSON（{e}）：{text}"));
        assert_default_shape(&v, &format!("存量 {label} 回默认"));
    }

    clear_multi_period(&pool).await;
}

// ── T6 (§2 写侧正例)：PUT 合法 ⇒ 200 且回显/读回一致 ──

#[tokio::test]
async fn t6_put_valid_roundtrip_200_and_readback_identical() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 合法配置：基准 1m + 卫星 5m/15m（≤4 周期；heights 同键；indicators ⊆ 受支持集）
    let good = body(false, &["1m", "5m", "15m"], &["dcap"]);
    let r = http.put(format!("{url}{PATH}")).json(&good).send().await.unwrap();
    assert_eq!(r.status(), 200, "PUT 合法 ⇒ 200");
    let echo: Value = r.json().await.unwrap();
    assert_eq!(echo, good, "PUT 回显必须与请求一致（含 enabled/periods/heights/indicators 全字段）");

    let back: Value = http.get(format!("{url}{PATH}")).send().await.unwrap().json().await.unwrap();
    assert_eq!(back, good, "GET 读回必须与 PUT 一致（已落 app_config[multi_period]）");

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_valid_1d_base_with_1w_satellite_is_accepted() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 口径 10 的正向面：基准 1d（≥1d）⇒ 1w 卫星**合法**（护栏不得误拒）
    let good = body(false, &["1d", "1w"], &["dcap"]);
    let r = http.put(format!("{url}{PATH}")).json(&good).send().await.unwrap();
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    assert_eq!(status, 200, "基准 1d + 卫星 1w ⇒ 必须 200，收到 {status}，body={text}");
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), good);

    clear_multi_period(&pool).await;
}

// ── T6 (§2 写侧负例全列)：每条一个用例 + 独立断言；错误信息含被拒字段名 ──

#[tokio::test]
async fn t6_put_rejects_base_1mo() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 1：基准 ∈ 全部周期 \ {1mo}
    assert_rejected(&http, &url, &body(false, &["1mo"], &["dcap"]), "periods", "基准 1mo").await;
    assert_rejected(
        &http, &url, &body(false, &["1mo", "1w"], &["dcap"]), "periods", "基准 1mo(+1w)").await;

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_satellite_below_base() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 2：卫星周期 ≥ 基准
    assert_rejected(&http, &url, &body(false, &["5m", "1m"], &["dcap"]), "periods", "5m+卫星 1m").await;
    assert_rejected(&http, &url, &body(false, &["1d", "1h"], &["dcap"]), "periods", "1d+卫星 1h").await;

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_satellite_1mo() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 2：卫星 ∈ 全部周期 \ {1mo}（1mo 是最大周期，单靠「≥ 基准」拦不住）
    assert_rejected(&http, &url, &body(false, &["1m", "1mo"], &["dcap"]), "periods", "卫星 1mo").await;

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_1w_when_base_below_1d() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 3（口径 10）：含 1w ⇒ 基准必须 ≥ 1d
    assert_rejected(&http, &url, &body(false, &["1m", "1w"], &["dcap"]), "periods", "1m+1w").await;
    assert_rejected(&http, &url, &body(false, &["1h", "1w"], &["dcap"]), "periods", "1h+1w").await;

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_more_than_4_periods_without_silent_truncation() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 前置：落一份合法配置（用于证明「拒绝不落库、不静默截断」）
    let good = body(false, &["1m", "5m", "15m"], &["dcap"]);
    let r = http.put(format!("{url}{PATH}")).json(&good).send().await.unwrap();
    assert_eq!(r.status(), 200, "前置合法配置必须 200");

    // 校验 4（口径 2）：总周期数 ≤ 4
    let bad = body(false, &["1m", "5m", "15m", "1h", "1d"], &["dcap"]);
    assert_rejected(&http, &url, &bad, "periods", "周期数 5 (>4)").await;

    // 拒绝后配置未被改写：仍为前置的 3 周期（**不得静默截断为 4**）
    let back: Value = http.get(format!("{url}{PATH}")).send().await.unwrap().json().await.unwrap();
    assert_eq!(back, good, "被拒的 5 周期 PUT 不得落库、不得静默截断");
    assert_eq!(
        back["periods"].as_array().unwrap().len(),
        3,
        "周期数必须仍为 3（若为 4 即静默截断）"
    );

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_duplicate_periods() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 7：去重后周期不重复
    assert_rejected(&http, &url, &body(false, &["1m", "1m"], &["dcap"]), "periods", "重复 1m,1m").await;
    assert_rejected(
        &http, &url, &body(false, &["1m", "5m", "5m"], &["dcap"]), "periods", "重复 5m").await;

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_heights_keys_mismatching_periods() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 5a:缺键（periods 有 5m，heights 无）
    let missing = json!({
        "enabled": false, "periods": ["1m", "5m"],
        "heights": { "1m": 420 }, "indicators": ["dcap"]
    });
    assert_rejected(&http, &url, &missing, "heights", "heights 缺 5m 键").await;

    // 校验 5b:多键（periods 只有 1m，heights 多 5m）
    let extra = json!({
        "enabled": false, "periods": ["1m"],
        "heights": { "1m": 420, "5m": 180 }, "indicators": ["dcap"]
    });
    assert_rejected(&http, &url, &extra, "heights", "heights 多 5m 键").await;

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_heights_out_of_range() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 5c：每值 ∈ [80, 1200]
    let below = json!({
        "enabled": false, "periods": ["1m"],
        "heights": { "1m": HEIGHT_MIN - 1 }, "indicators": ["dcap"]
    });
    assert_rejected(&http, &url, &below, "heights", "heights 79 (<80)").await;

    let above = json!({
        "enabled": false, "periods": ["1m", "5m"],
        "heights": { "1m": DEFAULT_BASE_HEIGHT, "5m": HEIGHT_MAX + 1 }, "indicators": ["dcap"]
    });
    assert_rejected(&http, &url, &above, "heights", "heights 1201 (>1200)").await;

    // 边界（合法）：80 / 1200 必须被接受（护栏不得误拒）
    let edge = json!({
        "enabled": false, "periods": ["1m", "5m"],
        "heights": { "1m": HEIGHT_MIN, "5m": HEIGHT_MAX }, "indicators": ["dcap"]
    });
    let r = http.put(format!("{url}{PATH}")).json(&edge).send().await.unwrap();
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    assert_eq!(status, 200, "heights 边界 80/1200 ⇒ 必须 200，收到 {status}，body={text}");

    clear_multi_period(&pool).await;
}

#[tokio::test]
async fn t6_put_rejects_unsupported_indicators() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 校验 6：indicators ⊆ 受支持集合（首版仅 dcap）
    assert_rejected(
        &http, &url, &body(false, &["1m"], &["macd"]), "indicators", "indicators=[macd]").await;
    assert_rejected(
        &http, &url, &body(false, &["1m", "5m"], &["dcap", "boll"]), "indicators",
        "indicators=[dcap,boll]").await;

    clear_multi_period(&pool).await;
}

// ── §2-6 归一化去重（**P1-C 缺陷 D1**；架构师 P1-D-1 指派的红用例）──
//
// 口径（`02-spec.md` §2 校验 6「`indicators` ⊆ 受支持集合（首版仅 `dcap`），**去重**」+ §7.4
// 「计数必须基于**归一化（去重）后**的 `indicators` 集合」）：
//   ① `PUT indicators=["dcap","dcap"]` ⇒ **200**，且 PUT 回显 / GET 读回均为 **归一化后的 `["dcap"]`**；
//   ② 总 pane 计数基于去重后集合 ⇒ `["dcap"]×n` 与 `["dcap"]` 等价，**重复项不得伪造 >12 pane**；
//   ③ v1 去重后最大合法形态（4 周期）必 200。
// 红理由（P1-C 实测）：现状**未去重**（200 且原样落库 `["dcap","dcap"]`），且 pane 计数按**原始数组
// 长度** ⇒ `["dcap"]×11`（3 周期）被判 23 pane 而 **400「超上限 12」**（语义等价的配置被误拒）。

/// D1①：重复指标名被归一化（去重）——PUT 200、回显与读回都是 `["dcap"]`。
#[tokio::test]
async fn d1_duplicate_indicators_are_normalized_200_and_readback_deduped() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    let raw = body(false, &["1m", "5m", "15m"], &["dcap", "dcap"]);
    let normalized = body(false, &["1m", "5m", "15m"], &["dcap"]);

    let r = http.put(format!("{url}{PATH}")).json(&raw).send().await.unwrap();
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    assert_eq!(
        status, 200,
        "D1：`indicators=[\"dcap\",\"dcap\"]` 与 `[\"dcap\"]` 语义等价 ⇒ 必须 200（归一化去重），\
         收到 {status}，body={text}"
    );
    let echo: Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("D1：200 body 不是 JSON（{e}）：{text}"));
    assert_eq!(
        echo["indicators"],
        json!(["dcap"]),
        "D1：PUT 回显必须是**归一化（去重）后**的 indicators（02-spec §2 校验 6「去重」），收到 {}",
        echo["indicators"]
    );

    let back: Value = http.get(format!("{url}{PATH}")).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        back, normalized,
        "D1：GET 读回必须是归一化去重后的**完整配置**（去重必须落库，不得只在计数时去重）"
    );

    clear_multi_period(&pool).await;
}

/// D1②③：**无法通过重复项构造 >12 pane** —— v1 最大周期形态（4 周期）× `["dcap"]×n` ⇒ 必 200，
/// 且读回为归一化的 4 周期 × `["dcap"]`（去重后 pane = 4 ≤ 12）。
#[tokio::test]
async fn d1_duplicate_items_cannot_forge_over_budget_4_periods_always_200() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // 重复次数 3（P1-D-1 派单最小样本）、11（P1-C 实测被判 23 pane 的样本）、12（P1-A 纯函数边界值）
    // 先**全量观测**再断言：红阶段一次性给出全部样本的实测（含现状对被误拒样本的 400）。
    let mut observed: Vec<(usize, u16, Value, Value)> = Vec::new();
    for n in [3usize, 11, 12] {
        let inds = vec!["dcap"; n];
        let raw = body(false, &["1m", "5m", "15m", "1h"], &inds);
        let r = http.put(format!("{url}{PATH}")).json(&raw).send().await.unwrap();
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        let echo: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        observed.push((n, status, echo["indicators"].clone(), echo["periods"].clone()));
    }

    // 全量汇总断言（红阶段把 3 个样本的实测一次性呈现，便于实现方定位）
    let report: Vec<String> = observed
        .iter()
        .map(|(n, st, ind, per)| {
            format!(
                "n={n}: status={st}, indicators={ind}, periods_len={}",
                per.as_array().map(|a| a.len()).unwrap_or(0)
            )
        })
        .collect();
    let mut problems: Vec<String> = Vec::new();
    for (n, status, inds_echo, periods_echo) in &observed {
        if *status != 200 {
            problems.push(format!(
                "n={n}: 必须 200（去重后 1+3×1 = 4 pane ≤ 12），实测 {status} —— 重复项被误判为 >12 pane"
            ));
        }
        if inds_echo != &json!(["dcap"]) {
            problems.push(format!("n={n}: 回显必须归一化为 `[\"dcap\"]`，实测 {inds_echo}"));
        }
        if periods_echo.as_array().map(|a| a.len()) != Some(4) {
            problems.push(format!("n={n}: 周期数必须保持 4（不得截断/归一化），实测 {periods_echo}"));
        }
    }
    assert!(
        problems.is_empty(),
        "D1：`[\"dcap\"]×n` 不得伪造 >12 pane，且必须归一化去重。实测样本：{report:?}；违反项：{problems:#?}"
    );

    let back: Value = http.get(format!("{url}{PATH}")).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        back,
        body(false, &["1m", "5m", "15m", "1h"], &["dcap"]),
        "D1：读回 = 归一化后的 4 周期 × `[\"dcap\"]`（重复项已去重、无残留）"
    );

    clear_multi_period(&pool).await;
}

// ── T6 (§7 护栏)：总 pane 数 ≤ 12 的 HTTP 边界（护栏不得误拒；超限判定见
//    `crates/web/tests/multi_period_pane_budget.rs` 的纯函数契约）──

#[tokio::test]
async fn t6_max_legal_config_is_accepted() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;
    clear_multi_period(&pool).await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();

    // v1 最大合法形态：4 周期（1 基准 + 3 卫星） × 1 指标（dcap） ⇒ 总 pane 4 ≤ 12 ⇒ 200
    let max = body(false, &["1m", "5m", "15m", "1h"], &["dcap"]);
    let r = http.put(format!("{url}{PATH}")).json(&max).send().await.unwrap();
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    assert_eq!(status, 200, "4 周期 × 1 指标（pane 4 ≤ 12）⇒ 必须 200，收到 {status}，body={text}");
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), max);

    clear_multi_period(&pool).await;
}

/// 库卫生**自检**（本轮唯一预期为绿的用例）：清理后 `app_config` 中不得存在 `multi_period` 键
/// ⇒ 共享 dev 库/线上库回到「无键 = 默认关闭」。红阶段本用例同样绿（只碰 DB、不碰端点），
/// 它证明本文件的清理路径真的落地（而非只在注释里声明）。
#[tokio::test]
async fn t6_zz_cleanup_leaves_no_multi_period_key() {
    let _guard = multi_period_lock().lock().await;
    let pool = pool().await;

    clear_multi_period(&pool).await;

    let n: (i64,) = sqlx::query_as("SELECT count(*) FROM app_config WHERE key = 'multi_period'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n.0, 0, "收尾后库中不得残留 multi_period 键（残留会改变线上默认行为）");
}
