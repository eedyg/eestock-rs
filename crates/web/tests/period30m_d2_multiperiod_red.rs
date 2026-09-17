//! ADR-023 **D2 红测试（手写）**：让 30m 进入多周期（后端半边）。
//!
//! 本文件位置：`crates/web/tests/period30m_d2_multiperiod_red.rs`
//! 设计报告：`tester/design/289_adr023_d2_density_and_red_design.md`
//! 执行报告：`tester/test/289_adr023_d2_density_and_red_execution.md`
//! 证据：`/tmp/adr023-d2-red-20260916T152240Z/EVIDENCE.md`
//!
//! 权威依据：
//!  - `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §2.5（后端白名单 + rank 插位）
//!    与 §5.3 D2 交付范围（**同时**打开 `MULTI_PERIOD_ALLOWED` / `MULTI_PERIOD_PICKER_PERIODS` /
//!    `MEASURED_DENSITY_TABLE` 三处）
//!  - 既有不回归契约：`design/15-multi-period/02-spec.md` §2（7 条校验）/§7.4（总 pane ≤12、按去重后
//!    `indicators` 计数）/§2.5（`1mo` 不提供）
//!
//! ## 红因分类（本阶段实测，见执行报告）
//!  - `d2_*` 用例：**断言失败**（实现缺失：`MULTI_PERIOD_ALLOWED` 无 `"30m"`、`multi_period_rank("30m")`
//!    为 `None` ⇒ 含 30m 的配置被 400 拒绝）。**不是**测试写错（无编译错误、无模块缺失）。
//!  - `d2_guard_*` 用例：**绿侧护栏**（既有语义，必须保持；不得因 D2 而被放宽）。
//!
//! ## 不连活库
//! `PgPoolOptions::connect_lazy` + **不可达端口** `127.0.0.1:59999` ⇒ 全程不触碰活库
//! `eestock@127.0.0.1:5433`（与 `period30m_api_contract.rs` 同一手法）。HTTP 用例断言的是
//! 「**非 400**」（400 = 校验门拒绝），无库时的 5xx 亦满足该契约，且**不会产生任何写**。

use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use web::state::AppState;
use web::ws::{SubscriptionRegistry, WsHub};

/// 不可达端口（**不是**活库 5433）：确保本测试文件永不连接 eestock 数据库。
const UNREACHABLE_DB: &str = "postgres://eestock:eestock@127.0.0.1:59999/eestock";

/// D2 交付后完整白名单（ADR-023 §2.5：在 `15m`(2) 与 `1h`(3) 之间插入 `30m`）。
const EXPECTED_ALLOWED: &[&str] = &["1m", "5m", "15m", "30m", "1h", "1d", "1w"];

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect_lazy(UNREACHABLE_DB)
        .expect("lazy connect 只解析 URL，不建连")
}

/// 测试装配（结构同 `crates/web/tests/period30m_api_contract.rs`；隐藏 storage 具体实现由 dev-dep 提供）。
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

/// 便捷构造：`periods` 各 200px 高度、`indicators` 均为 `["dcap"]`。
fn cfg(periods: &[&str]) -> web::dto::MultiPeriodConfigDto {
    let mut heights = std::collections::BTreeMap::new();
    for p in periods { heights.insert((*p).to_string(), 200i64); }
    web::dto::MultiPeriodConfigDto {
        enabled: true,
        periods: periods.iter().map(|p| (*p).to_string()).collect(),
        heights,
        indicators: vec!["dcap".to_string()],
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 白名单：`MULTI_PERIOD_ALLOWED` 含 `"30m"`，且插位正确（15m → 30m → 1h）
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn d2a_multi_period_allowed_contains_30m_between_15m_and_1h() {
    let allowed: &[&str] = web::dto::MULTI_PERIOD_ALLOWED;
    assert!(
        allowed.contains(&"30m"),
        "ADR-023 §2.5：D2 必须把 \"30m\" 加入 MULTI_PERIOD_ALLOWED；实际 = {allowed:?}"
    );
    assert_eq!(
        allowed, EXPECTED_ALLOWED,
        "ADR-023 §2.5：白名单顺序必须为 1m/5m/15m/30m/1h/1d/1w（30m 落在 15m 与 1h 之间）"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. `multi_period_rank`：30m 严格落在 15m 与 1h 之间（经**公开校验函数**间接断言 ——
//    `multi_period_rank` 为私有函数，唯一可观测面是 `validate_multi_period_config` 的
//    「卫星周期 ≥ 基准」判定与拒绝信息）
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn d2b_rank_30m_is_between_15m_and_1h_via_validate() {
    // 15m(基准) + 30m(卫星) 合法 ⇒ rank(30m) ≥ rank(15m)
    assert!(
        web::dto::validate_multi_period_config(&cfg(&["15m", "30m"])).is_ok(),
        "ADR-023 §2.5：基准 15m + 卫星 30m 必须合法（rank(30m) ≥ rank(15m)）；实际 = {:?}",
        web::dto::validate_multi_period_config(&cfg(&["15m", "30m"]))
    );
    // 30m(基准) + 15m(卫星) 非法，且**拒绝原因必须是「卫星 ≥ 基准」比较分支**
    // （若 30m 仍为未知周期，错误会落在「基准周期非法」分支 ⇒ 本断言可识别「因错误原因而绿」）
    let down = web::dto::validate_multi_period_config(&cfg(&["30m", "15m"]));
    let down_msg = down.as_ref().err().cloned().unwrap_or_default();
    assert!(
        down_msg.contains("须 ≥ 基准"),
        "ADR-023 §2.5：基准 30m + 卫星 15m 必须因「卫星 < 基准」被拒（而非「基准周期非法」⇒ rank(30m) 必须存在）；实际 = {down:?}"
    );
    // 30m(基准) + 1h(卫星) 合法 ⇒ rank(1h) ≥ rank(30m)
    assert!(
        web::dto::validate_multi_period_config(&cfg(&["30m", "1h"])).is_ok(),
        "ADR-023 §2.5：基准 30m + 卫星 1h 必须合法（rank(1h) ≥ rank(30m)）；实际 = {:?}",
        web::dto::validate_multi_period_config(&cfg(&["30m", "1h"]))
    );
    // 1h(基准) + 30m(卫星) 非法，原因必须是「卫星 ≥ 基准」分支 ⇒ rank(30m) 必须 **< rank(1h)**
    let down2 = web::dto::validate_multi_period_config(&cfg(&["1h", "30m"]));
    let down2_msg = down2.as_ref().err().cloned().unwrap_or_default();
    assert!(
        down2_msg.contains("须 ≥ 基准"),
        "ADR-023 §2.5：基准 1h + 卫星 30m 必须因「卫星 < 基准」被拒 ⇒ rank(30m) < rank(1h)；实际 = {down2:?}"
    );
    // 15m → 30m → 1h 三段全开（同一配置内含 30m）合法
    assert!(
        web::dto::validate_multi_period_config(&cfg(&["15m", "30m", "1h"])).is_ok(),
        "ADR-023 §2.5：15m/30m/1h 三档同配置必须合法；实际 = {:?}",
        web::dto::validate_multi_period_config(&cfg(&["15m", "30m", "1h"]))
    );
}

#[test]
fn d2c_validate_accepts_config_containing_30m_and_echoes_it() {
    let raw = cfg(&["1m", "30m"]);
    let out = web::dto::validate_multi_period_config(&raw);
    let ok = out.as_ref().ok().cloned().unwrap_or_default();
    assert!(
        out.is_ok(),
        "ADR-023 §2.5：PUT/校验路径必须接受含 30m 的配置；实际 = {out:?}"
    );
    assert_eq!(ok.periods, vec!["1m".to_string(), "30m".to_string()],
        "归一化回显必须保留 30m 且顺序不变");
    assert_eq!(ok.heights.keys().collect::<Vec<_>>(),
        vec![&"1m".to_string(), &"30m".to_string()],
        "heights 键必须与含 30m 的 periods 一一对应");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 不回归：pane 计数与去重口径（02-spec §7.4 / P1-C D1）不得因 30m 加入而改变
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn d2d_pane_count_and_dedup_semantics_unchanged_with_30m() {
    // 去重口径：`["dcap","dcap"]` 视同 1 个 pane（不得按原始数组长度计数）
    let periods = vec!["15m".to_string(), "30m".to_string(), "1h".to_string()];
    let inds_dup = vec!["dcap".to_string(), "dcap".to_string(), "dcap".to_string()];
    assert_eq!(web::dto::multi_period_pane_count(&periods, &inds_dup), 3,
        "02-spec §7.4：基准 1 + 2 卫星 ×（去重后 1 指标）= 3 pane（30m 不得改变去重口径）");
    assert!(web::dto::verify_multi_period_panes(&periods, &inds_dup).is_ok(),
        "3 pane ≤ 12 必须通过");

    // 上限仍为 12：4 周期（含 30m）× 去重后 4 指标 = 1 + 3×4 = 13 ⇒ 必须 Err 且信息含 `indicators`
    let p4 = vec!["1m".to_string(), "15m".to_string(), "30m".to_string(), "1h".to_string()];
    let mut inds4: Vec<String> = Vec::new();
    for i in 0..4 { inds4.push(format!("dcap{i}")); }
    // 「越界」构造：4 周期 × 4 个互异指标名（去重后仍 4）⇒ 1 + 3×4 = 13 > 12：
    let e = web::dto::verify_multi_period_panes(&p4, &inds4);
    let emsg = e.as_ref().err().cloned().unwrap_or_default();
    assert!(
        emsg.contains("indicators"),
        "02-spec §7.4 + P1-C D2：超预算必须 Err 且错误信息含被拒维度名 `indicators`（此处 4 周期 × 去重后 4 指标 = 13 pane）；实际 = {e:?}");

    // 归一化去重（保留首次出现顺序）不得回归
    assert_eq!(
        web::dto::normalize_multi_period_indicators(&["dcap".into(), "dcap".into()]),
        vec!["dcap".to_string()],
        "02-spec §2 校验 6：indicators 去重（保留首次出现顺序）");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HTTP：PUT /api/config/multi_period 含 30m 不得被判 400（校验门必须放行）
//
//    **R4 自隔离（零写）**：本用例的 `AppState` 用**不可达 pool**（`127.0.0.1:59999`，绝非活库 5433）
//    ⇒ PUT 在落库阶段必然 5xx ⇒ 不可能改写任何数据库（尤其不可能改用户看板配置）。
//    为把「不可能」变成**可执行证据**，本用例额外做三件事：
//      ① 断言 pool 目标就是不可达端口（URL 里出现 `:59999` 且不出现 `:5433`）；
//      ② 断言 `pool.acquire()` **必然失败**（⇒ 无任何可达数据库可写）；
//      ③ 断言 PUT 响应**不是 2xx**（2xx 才是「真的落库了」）；
//      ④ **活库只读快照守卫**：PUT 前后各读一次 `app_config.multi_period`（值 + `updated_at::text`），
//         必须逐字节相同；若不同 ⇒ **先尽力恢复原值**再 panic（响亮失败）。
//         （正常路径永不触发恢复分支：①–③ 已证明本用例无从写入。活库不可达时守卫打印 SKIP 并跳过。）
// ─────────────────────────────────────────────────────────────────────────────

/// 活库多周期配置键（`app_config`，migration 0021：`key text PK / value jsonb / updated_at timestamptz`）。
const LIVE_MULTI_PERIOD_KEY: &str = "multi_period";

/// 活库 `app_config.multi_period` 的**只读**快照（`db=None` ⇒ 活库不可达 ⇒ 守卫降级为 SKIP）。
struct LiveSnapshot {
    db: Option<PgPool>,
    value: Option<String>,
    updated_at: Option<String>,
}

/// 只读快照（**绝不写入**；查询失败 ⇒ `db=None` 并打印，不阻断用例）。
async fn live_snapshot() -> LiveSnapshot {
    // ADR-023 E6b：统一测试库入口（EESTOCK_TEST_DATABASE_URL + 哨兵表校验），不得回退活库。
    let pool = test_support::test_pool().await;
    let row: Result<Option<(String, String)>, _> = sqlx::query_as(
        "select value::text, updated_at::text from app_config where key = $1")
        .bind(LIVE_MULTI_PERIOD_KEY)
        .fetch_optional(&pool)
        .await;
    match row {
        Ok(v) => {
            let (value, updated_at) = match v {
                Some((val, ts)) => (Some(val), Some(ts)),
                None => (None, None),
            };
            println!("[R4 守卫] 活库快照（只读）：value={value:?} updated_at={updated_at:?}");
            LiveSnapshot { db: Some(pool), value, updated_at }
        }
        Err(e) => {
            println!("[R4 守卫] 快照查询失败：{e} ⇒ 跳过活库快照守卫");
            LiveSnapshot { db: None, value: None, updated_at: None }
        }
    }
}

/// **只**在「快照不一致」这一异常分支被调用：把 `app_config.multi_period` 恢复成快照原值
/// （原值缺失 ⇒ 删键）。返回值仅用于打印。
async fn restore_live_multi_period(s: &LiveSnapshot) -> Result<(), String> {
    let Some(pool) = &s.db else { return Err("活库不可达，无法恢复".into()) };
    match &s.value {
        Some(v) => {
            // 先删后插，避免依赖 `ON CONFLICT` 的键冲突路径（0021：key 为 PK）
            sqlx::query("delete from app_config where key = $1")
                .bind(LIVE_MULTI_PERIOD_KEY).execute(pool).await.map_err(|e| e.to_string())?;
            sqlx::query("insert into app_config (key, value, updated_at) values ($1, $2::jsonb, $3::timestamptz)")
                .bind(LIVE_MULTI_PERIOD_KEY)
                .bind(v)
                .bind(s.updated_at.clone())
                .execute(pool).await.map_err(|e| e.to_string())?;
            Ok(())
        }
        None => {
            sqlx::query("delete from app_config where key = $1")
                .bind(LIVE_MULTI_PERIOD_KEY).execute(pool).await.map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

#[tokio::test]
async fn d2e_put_multi_period_with_30m_must_not_be_400() {
    // ① R4 自隔离前提：pool 目标必须是不可达端口（不是活库 5433）
    assert!(
        UNREACHABLE_DB.contains(":59999") && !UNREACHABLE_DB.contains(":5433"),
        "R4：测试 pool 必须指向不可达端口，绝不能是活库；实际 = {UNREACHABLE_DB}"
    );
    let probe_pool = lazy_pool();
    let acquire = probe_pool.acquire().await;
    assert!(
        acquire.is_err(),
        "R4 自隔离前提：测试 pool 必须**不可达**（acquire 成功 ⇒ 存在可写数据库 ⇒ 可能改用户配置）"
    );
    drop(acquire);

    // ④ 活库只读快照（PUT 之前）
    let before = live_snapshot().await;

    let base = spawn(state(lazy_pool())).await;
    let body = json!({
        "enabled": true,
        "periods": ["15m", "30m"],
        "heights": {"15m": 300, "30m": 180},
        "indicators": ["dcap"]
    });
    let r = reqwest::Client::new()
        .put(format!("{base}/api/config/multi_period"))
        .json(&body)
        .send().await.expect("HTTP 请求发出");
    let s = r.status().as_u16();
    let b: Value = r.json().await.unwrap_or(Value::Null);
    println!("[证据] PUT /api/config/multi_period periods=[15m,30m] 实际状态码 = {s} body = {b}");

    // ⚠️ 顺序刻意如此：**先**跑 R4 零写守卫**再**跑契约断言 —— 这样即使契约断言在本阶段（红）失败，
    //    守卫仍已执行（否则 panic 会跳过守卫 ⇒ 恰恰在「红」时失去保护）。
    // ③ R4：本用例的 PUT **不得**成功落库（2xx ⇒ 真写入了某个数据库）
    assert!(
        !(200..300).contains(&s),
        "R4 红线：本用例的 PUT 竟然返回 2xx（{s}）⇒ 真的写库了（测试 pool 必须不可达）；body = {b}"
    );
    // ④ R4：活库 `app_config.multi_period` 必须逐字节未变；若变 ⇒ 先恢复再响亮失败
    let after = live_snapshot().await;
    if before.db.is_some() && (after.value != before.value || after.updated_at != before.updated_at) {
        let restored = restore_live_multi_period(&before).await;
        println!("[R4 守卫] 已尝试恢复原值：{restored:?}");
        panic!(
            "[R4] 活库 app_config.multi_period 被本测试改写！before=(value={:?}, updated_at={:?}) after=(value={:?}, updated_at={:?})；恢复结果={:?}",
            before.value, before.updated_at, after.value, after.updated_at, restored
        );
    }
    if before.db.is_some() {
        println!("[R4 守卫] 活库 app_config.multi_period 逐字节未变（value/updated_at 均相同）✔");
    }

    // 契约断言（红阶段在此失败；R4 守卫已先行执行完毕）
    assert_ne!(s, 400,
        "ADR-023 §2.5：含 30m 的配置必须通过 PUT 校验门（400 = `periods` 校验把 30m 判为非法）；body = {b}");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. `1mo` 仍不提供（既有用户裁决不得被 D2 顺手放开）
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn d2f_1mo_still_not_offered_after_30m_lands() {
    let allowed: &[&str] = web::dto::MULTI_PERIOD_ALLOWED;
    assert!(!allowed.contains(&"1mo"), "ADR-022 §2.5：1mo 不在白名单（D2 不得放开）");
    for periods in [vec!["1m", "1mo"], vec!["1mo", "1d"]] {
        let e = web::dto::validate_multi_period_config(&cfg(&periods));
        assert!(e.is_err(), "含 1mo 的配置必须被拒：{periods:?}；实际 = {e:?}");
    }
    let unknown = web::dto::validate_multi_period_config(&cfg(&["1m", "30x"]));
    assert!(unknown.is_err(), "未知周期仍必须被拒；实际 = {unknown:?}");
}
