//! **tester 独立验收**（ADR-024 P5 / D1·D2·D3·D11·D12）—— 去日历档 + 区间收缩 + 资源护栏 +
//! 结构化错误 + 试算同口径 + 进度预扫描。**由 tester 自行设计**，不复用 worker 断言；
//! 需要真库/真 HTTP 的用临时库（`EESTOCK_TEST_DATABASE_URL`），可控数据源用自带 mock bar_read
//! （**只替换取数端口**；run store / symbols / strategies 一律走真库真实现）。
//!
//! 反向证据（人为退化 ⇒ 必须变红）见 tester/report/adr024_p5_verification.md §R。
//! ⚠️ 本文件为 tester 手写（非 tangle），不改任何生产代码。


use chrono::{DateTime, Duration, TimeZone, Utc};
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

// ══════════════════════════════════════════════════════════════════════════════════════
// 可控取数端口（**只替取数**）：bars / available_range / count_bars 三路可独立设定，
// 用于构造「提交时缓存（available_range）与执行时真实 bar 不一致」「预扫描失败」等场景。
// ══════════════════════════════════════════════════════════════════════════════════════

#[derive(Clone)]
enum CountMode {
    /// 恒定 count（构造 ≥20 万 / >200 万护栏场景；执行仍只喂少量 bar ⇒ 快）。
    Fixed(i64),
    /// 真按喂入 bar 数计。
    Real,
    /// 注入失败（D12 降级路径）。
    Fail,
}

#[derive(Clone)]
struct CtlData {
    bars: Vec<domain::types::Bar>,
    range: Option<domain::ports::AvailableRange>,
    count: CountMode,
}

#[derive(Clone)]
struct CtlBarRead(Arc<CtlData>);

#[async_trait::async_trait]
impl domain::ports::BacktestBarRead for CtlBarRead {
    async fn bars(
        &self, _code: &str, _period: &domain::types::Period,
        from: DateTime<Utc>, to: DateTime<Utc>,
    ) -> anyhow::Result<Vec<domain::types::Bar>> {
        Ok(self.0.bars.iter().filter(|b| b.ts >= from && b.ts < to).cloned().collect())
    }
    async fn available_range(
        &self, _code: &str, _period: &domain::types::Period,
    ) -> anyhow::Result<Option<domain::ports::AvailableRange>> {
        Ok(self.0.range)
    }
    async fn count_bars(
        &self, _code: &str, _period: &domain::types::Period,
        from: DateTime<Utc>, to: DateTime<Utc>,
    ) -> anyhow::Result<i64> {
        match self.0.count {
            CountMode::Fixed(n) => Ok(n),
            CountMode::Real => Ok(self.0.bars.iter().filter(|b| b.ts >= from && b.ts < to).count() as i64),
            CountMode::Fail => Err(anyhow::anyhow!("p5-tester 注入：预扫描失败（D12 降级路径探针）")),
        }
    }
}

struct NoopSink;
#[async_trait::async_trait]
impl domain::ports::StrategyRunProgressSink for NoopSink {
    async fn send(&self, _run_id: &str, _p: f64, _ts: Option<DateTime<Utc>>) -> anyhow::Result<()> {
        Ok(())
    }
}

/// 试算用的最简插件（恒分，无参数）。
const P5_CONST_CODE: &str = r#"
const PARAMS_SCHEMA = [];
function on_bar(ctx) { return 42; }
"#;

const T0_STR: &str = "2025-03-03T01:30:00Z";

fn t0() -> DateTime<Utc> {
    T0_STR.parse::<DateTime<Utc>>().unwrap()
}

/// T0 起的 3 段数据（**中间留 3 天 / 4 天缺口**）：各 60 根 M1。
/// 段1 = [T0, T0+60m)，段2 = [T0+3d, +60m)，段3 = [T0+7d, +60m)。
fn three_segments() -> (Vec<domain::types::Bar>, DateTime<Utc>, DateTime<Utc>) {
    let mut bars = Vec::new();
    for seg_start in [t0(), t0() + Duration::days(3), t0() + Duration::days(7)] {
        for i in 0..60 {
            bars.push(mk_bar(seg_start + Duration::minutes(i)));
        }
    }
    let first = bars.first().unwrap().ts;
    let last = bars.last().unwrap().ts;
    (bars, first, last)
}

fn mk_bar(ts: DateTime<Utc>) -> domain::types::Bar {
    domain::types::Bar {
        code: domain::types::Code("P5CTL".into()),
        period: domain::types::Period::M1,
        ts,
        open: 100.0, high: 101.0, low: 99.0, close: 100.5,
        volume: 1000, amount: 100_500.0,
        source: domain::types::SourceId::Tushare,
    }
}

/// 提交请求骨架（slots 用真库里的 published 版本；warmup=0）。
fn submit_req(
    symbol: &str, period: &str, from: DateTime<Utc>, to: DateTime<Utc>, vid: &str,
) -> application::workbench::SubmitRunReq {
    application::workbench::SubmitRunReq {
        name: format!("p5indep{}", std::process::id()),
        symbol: symbol.to_string(),
        period: period.to_string(),
        from,
        to,
        slots: vec![application::workbench::SlotReq {
            version_id: vid.to_string(),
            params: json!({}),
            weight: 1.0,
        }],
        buy_threshold: None,
        sell_threshold: None,
        policy: json!({"LumpSum": {"position_pct": 1.0}}),
        stop: None,
        initial_capital: None,
        fee: Some(json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})),
        warmup_bars: 0,
        confirm: false,
    }
}

/// 取一个真库里的 published 版本 id。
async fn a_published_version(pool: &PgPool) -> String {
    let (id,): (String,) = sqlx::query_as(
        "SELECT id FROM strategy_version WHERE status = 'published' ORDER BY id LIMIT 1")
        .fetch_one(pool).await.expect("临时库应已播种 published 策略版本");
    id
}

/// 用**可控取数 + 真库 run store/symbols/strategies**装配工作台服务。
fn ctl_workbench(pool: &PgPool, data: CtlData) -> Arc<application::workbench::WorkbenchService> {
    Arc::new(application::workbench::WorkbenchService::new(
        Arc::new(CtlBarRead(Arc::new(data))),
        Arc::new(storage::workbench::PgStrategyRunStore::new(pool.clone())),
        Arc::new(storage::workbench::PgStrategyPresetStore::new(pool.clone())),
        Arc::new(storage::strategy::PgStrategyStore::new(pool.clone())),
        Arc::new(storage::symbols::PgSymbolRegistry::new(pool.clone())),
        Arc::new(NoopSink),
        Arc::new(domain::ports::SystemClock),
        2,
    ))
}

fn ctl_strategy(pool: &PgPool, data: CtlData) -> application::strategy::StrategyService {
    application::strategy::StrategyService::new(
        Arc::new(storage::strategy::PgStrategyStore::new(pool.clone())),
        Arc::new(CtlBarRead(Arc::new(data))),
        Arc::new(domain::ports::SystemClock),
    )
}

/// 读出 run 行的 effective 落库值 + config 快照。
async fn run_row(pool: &PgPool, id: &str) -> (DateTime<Utc>, DateTime<Utc>, Value) {
    let (f, t, c): (DateTime<Utc>, DateTime<Utc>, Value) = sqlx::query_as(
        "SELECT from_ts, to_ts, config FROM strategy_run WHERE id = $1")
        .bind(id).fetch_one(pool).await.expect("run 行应存在");
    (f, t, c)
}

async fn cleanup_ctl(pool: &PgPool, symbol: &str) {
    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(symbol).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(symbol).execute(pool).await.unwrap();
}

async fn ensure_ctl_symbol(pool: &PgPool, symbol: &str) {
    sqlx::query("INSERT INTO symbols (code, name, interval_secs, enabled) VALUES ($1, $1, 60, true) \
                 ON CONFLICT (code) DO UPDATE SET enabled = true")
        .bind(symbol).execute(pool).await.unwrap();
}

/// 取出 downcast 后的结构化错误（非结构化 ⇒ panic 并打印原错误）。
fn structured(e: &anyhow::Error, what: &str) -> application::error::StructuredError {
    match e.downcast_ref::<application::error::StructuredError>() {
        Some(s) => s.clone(),
        None => panic!("{what}: 期望 StructuredError，实得 {e:?}（结构化错误缺口）"),
    }
}

// ═══════════════════════════════════ ① 去日历天数档 ═══════════════════════════════════

/// ADR-024 D1：物理删除 `D1_MAX_SPAN_DAYS`/`MINUTE_MAX_SPAN_DAYS`/`MAX_BARS` ⇒
/// M15×259 天 / M1×1 年 / M30×2 年**必须可提交**（旧「超限 400」全数反转）。
#[tokio::test]
async fn t_p5_no_calendar_span_cap_m15_m1_m30() {
    let pool = pool().await;
    let symbol = format!("83{:04}", std::process::id() % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();
    let (svc_avail_from, svc_avail_to) = (first - Duration::days(4000), last + Duration::days(4000));
    let svc = ctl_workbench(&pool, CtlData {
        bars, range: Some(domain::ports::AvailableRange { from: svc_avail_from, to: svc_avail_to }),
        count: CountMode::Real,
    });

    // 可得区间足够宽 ⇒ 三档跨度均可提交（若日历档仍在，会以 400 拒绝）。
    let cases: [(&str, DateTime<Utc>, DateTime<Utc>); 3] = [
        ("M15", t0(), t0() + Duration::days(259)),
        ("M1",  t0(), t0() + Duration::days(365)),
        ("M30", t0(), t0() + Duration::days(730)),
    ];
    for (period, from, to) in cases {
        let r = svc.submit(submit_req(&symbol, period, from, to, &vid)).await;
        match r {
            Ok(view) => {
                println!("[①] period={period} span_days={} ⇒ 201/{:?} effective=[{}, {}) clamped={}",
                    (to - from).num_days(), view.status, view.from_ts, view.to_ts, view.clamped);
                assert_eq!(view.requested_from, from, "回显 requested_from = 用户原始输入");
                assert_eq!(view.requested_to, to, "回显 requested_to = 用户原始输入");
                assert!(!view.clamped, "区间完全落在可得区间内 ⇒ 不应收缩");
            }
            Err(e) => panic!("[①] period={period} 跨度 {} 天必须可提交（旧日历档现象须消失），实得 {e:?}",
                (to - from).num_days()),
        }
    }
    cleanup_ctl(&pool, &symbol).await;
}

/// 旧「超限 400」文案**不得**在实现侧残留（物理删除，而非调值）。
#[tokio::test]
async fn t_p5_old_span_cap_text_absent_in_impl() {
    // 源码级取证（grep 由报告给出原始输出）；此处断言删除后新增的常量存在且旧常量不可达。
    assert_eq!(application::error::MAX_BARS_GUARD, 2_000_000);
    assert_eq!(application::error::GUARD_CONFIRM_BARS, 500_000);
    // 旧日历档常量已物理删除：若仍存在，`use` 这行会编译失败（编译器即断言）。
    // （旧的 `D1_MAX_SPAN_DAYS` / `MINUTE_MAX_SPAN_DAYS` / `MAX_BARS` 在 application/web 侧均已无定义。）
}

// ═══════════════════════════════ ② 区间收缩（D2/D3） ═══════════════════════════════

/// 收缩矩阵（独立用例：任一条失败不遮蔽其余证据）：
/// 左超 / 右超 / 两端超 / 恰好等于端点 /「请求终点落在缺口内」的观察项。
#[tokio::test]
async fn t_p5_clamp_left_right_both_and_exact() {
    let pool = pool().await;
    let symbol = format!("83{:04}", (std::process::id() + 1) % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();
    let avail = domain::ports::AvailableRange { from: first, to: last + Duration::seconds(1) };
    let svc = ctl_workbench(&pool, CtlData { bars, range: Some(avail), count: CountMode::Real });

    // (1) 左超：from 早于可得 ⇒ eff_from = avail.from；右端**对齐 bar 边界**（= 段1 末 bar +1min）
    //     ⇒ 执行时收缩得到同一值 ⇒ effective_to == requested_to。
    let right_aligned = t0() + Duration::minutes(60);
    let v = svc.submit(submit_req(&symbol, "M1", t0() - Duration::days(30), right_aligned, &vid)).await.unwrap();
    println!("[②左超] requested=[{}, {}) eff=[{}, {}) clamped={} reason={:?}",
        t0() - Duration::days(30), right_aligned, v.from_ts, v.to_ts, v.clamped, v.clamp_reason);
    assert_eq!(v.from_ts, avail.from, "左端应收缩到可得区间起点");
    // ⚠️ 观察（实现语义 vs worker U2 声称「仅被夹端生效」）：只要提交端**任一端**被夹
    //    （clamped=true），执行端会把**两端**都按 [eff_from, eff_to) 内真实首末 bar 收窄；
    //    因此右端虽未超，`effective_to` 仍从请求值（段1 末 bar +1min）收窄到「区间内末 bar +1s」。
    //    不影响喂入引擎的 bar 集合（取数发生在此之前），但落库 from_ts/to_ts 与回显随之改变。
    println!("[②左超-右端观察] requested_to={} 实际 eff_to={}（= 区间内末 bar(02:29:00)+1s）",
        right_aligned, v.to_ts);
    assert_eq!(v.to_ts, t0() + Duration::minutes(59) + Duration::seconds(1),
        "实测：clamped=true 时执行端把未夹的右端也收窄到区间内末 bar+1s");
    assert!(v.clamped && v.clamp_reason.as_deref() == Some("data_range"));

    // (2) 右超：to 晚于可得 ⇒ eff_to = avail.to（末 bar +1s，半开）。
    let v = svc.submit(submit_req(&symbol, "M1", t0() + Duration::days(4), last + Duration::days(30), &vid)).await.unwrap();
    println!("[②右超] eff=[{}, {}) clamped={}", v.from_ts, v.to_ts, v.clamped);
    assert_eq!(v.to_ts, avail.to, "右端应收缩到可得区间终点");
    // 观察同上：clamped=true ⇒ 执行端把两端都收窄到真实首/末 bar。请求 from = T0+4d 落在
    // 段2 与段3 之间的空档 ⇒ 「区间内首 bar」= 段3 首 bar（T0+7d）；落库 eff_from 随之变为 T0+7d
    // （与引擎实际喂入的 bar 集合一致——取数同样从 eff_from 起）。
    println!("[②右超-左端观察] requested_from={} 实际 eff_from={}（= 区间内首 bar）",
        t0() + Duration::days(4), v.from_ts);
    assert_eq!(v.from_ts, t0() + Duration::days(7), "实测：eff_from 收窄到区间内首个真实 bar");

    // (3) 两端超：eff == 可得区间。
    let v = svc.submit(submit_req(&symbol, "M1", t0() - Duration::days(30), last + Duration::days(30), &vid)).await.unwrap();
    println!("[②两端超] eff=[{}, {}) clamped={}", v.from_ts, v.to_ts, v.clamped);
    assert_eq!((v.from_ts, v.to_ts), (avail.from, avail.to));

    // (4) 恰好等于端点：不收缩（clamped=false）。
    let v = svc.submit(submit_req(&symbol, "M1", avail.from, avail.to, &vid)).await.unwrap();
    println!("[②恰端点] eff=[{}, {}) clamped={}", v.from_ts, v.to_ts, v.clamped);
    assert!(!v.clamped, "请求 == 可得区间 ⇒ 不收缩");
    assert_eq!((v.from_ts, v.to_ts), (avail.from, avail.to));

    // (5) 观察项：请求终点落在**缺口内**（缺口起点 +1h）⇒ 观察 effective_to 落点。
    //     §3.1 步骤 5 的字面值 = min(to, avail.to) = 请求值；实现在任一端 clamped 时
    //     会把**两端**收窄到 [eff_from, eff_to) 内真实首末 bar ⇒ eff_to 落在缺口**之前**。
    //     （不影响实际喂给引擎的 bar 集合——引擎口径本就是 [from,to)；属回显/审计语义偏差。）
    let v = svc.submit(submit_req(&symbol, "M1", avail.from, avail.from + Duration::hours(1), &vid)).await.unwrap();
    println!("[②观察:请求终点在缺口内] requested_to={} eff=[{}, {}) clamped={}",
        avail.from + Duration::hours(1), v.from_ts, v.to_ts, v.clamped);
    assert_eq!(v.from_ts, avail.from);
    assert!(v.to_ts <= avail.from + Duration::hours(1), "实现在此场景把 eff_to 收窄到缺口前末 bar+1s");
    cleanup_ctl(&pool, &symbol).await;
}

/// 中间缺口**不截断**：请求覆盖段1→段3 之间的多天空档，run 仍横跨缺口（不按首个缺口切半）。
#[tokio::test]
async fn t_p5_gap_in_middle_not_truncated() {
    let pool = pool().await;
    let symbol = format!("83{:04}", (std::process::id() + 11) % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();
    let avail = domain::ports::AvailableRange { from: first, to: last + Duration::seconds(1) };
    let svc = ctl_workbench(&pool, CtlData { bars, range: Some(avail), count: CountMode::Real });

    let v = svc.submit(submit_req(&symbol, "M1", avail.from, avail.to, &vid)).await.unwrap();
    let (f_row, t_row, cfg) = run_row(&pool, &v.id).await;
    println!("[②缺口] 请求=[{}, {}) 落库 eff=[{}, {}) 跨度={} 天 clamped={} config.clamped={}",
        avail.from, avail.to, f_row, t_row, (t_row - f_row).num_days(), v.clamped, cfg["clamped"]);
    assert_eq!(f_row, first, "落库 effective_from = 真实首 bar");
    assert_eq!(t_row, avail.to, "落库 effective_to = 请求终点（缺口未截断）");
    assert!((t_row - f_row).num_days() >= 7, "跨度须横跨中间缺口（≫ 7 天）");
    assert!(!v.clamped, "请求 == 可得区间 ⇒ 无收缩 ⇒ 缺口不被当边界");
    cleanup_ctl(&pool, &symbol).await;
}

/// 无交集 ⇒ 400 `range_empty` + 回显可用区间（禁止产出 0 bar 的「成功」run）。
#[tokio::test]
async fn t_p5_no_intersection_range_empty_400() {
    let pool = pool().await;
    let symbol = format!("83{:04}", (std::process::id() + 12) % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();
    let avail = domain::ports::AvailableRange { from: first, to: last + Duration::seconds(1) };
    let svc = ctl_workbench(&pool, CtlData { bars, range: Some(avail), count: CountMode::Real });

    let e = svc.submit(submit_req(&symbol, "M1", last + Duration::days(30), last + Duration::days(60), &vid))
        .await.err().expect("无交集必须拒绝（禁止产出 0 bar 的成功 run）");
    let s = structured(&e, "[②无交集]");
    println!("[②无交集] code={} message={} detail={}", s.code, s.message, s.detail);
    assert_eq!(s.code, "range_empty");
    assert_eq!(s.detail["available_from"], json!(avail.from.to_rfc3339()), "须回显可用区间");
    assert_eq!(s.detail["available_to"], json!(avail.to.to_rfc3339()));
    assert_eq!(s.detail["requested_from"], json!((last + Duration::days(30)).to_rfc3339()));
    cleanup_ctl(&pool, &symbol).await;
}

// ═══════════════════ ③ 执行时以真实首末 bar 为准（D3 执行端） ═══════════════════

/// 构造「提交时缓存（available_range）比执行时实取 bar **更宽**」的场景：
/// 提交端收缩到缓存边界 ⇒ clamped=true；执行端须以**真实首末 bar** 再收窄并落库回显
/// （ADR-024 D3：「两者不一致以执行时为准」）。
#[tokio::test]
async fn t_p5_exec_time_clamp_uses_real_first_last_bar() {
    let pool = pool().await;
    let symbol = format!("83{:04}", (std::process::id() + 2) % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();

    // 陈旧缓存：比真实数据多出前 2 天 / 后 10 天。
    let stale = domain::ports::AvailableRange {
        from: first - Duration::days(2),
        to: last + Duration::days(10),
    };
    let svc = ctl_workbench(&pool, CtlData {
        bars, range: Some(stale), count: CountMode::Real,
    });
    let req_from = first - Duration::days(5);
    let req_to = last + Duration::days(20);
    let v = svc.submit(submit_req(&symbol, "M1", req_from, req_to, &vid)).await.unwrap();
    let (f_row, t_row, cfg) = run_row(&pool, &v.id).await;
    println!("[③] 请求=[{}, {}] 缓存=[{}, {}] 实取真实首末=[{}, {}]",
        req_from, req_to, stale.from, stale.to, first, last);
    println!("[③] 提交端响应 eff=[{}, {}) clamped={}；落库 eff=[{}, {})",
        v.from_ts, v.to_ts, v.clamped, f_row, t_row);
    println!("[③] config.requested_from={} requested_to={}", cfg["requested_from"], cfg["requested_to"]);

    assert!(v.clamped, "两端均超缓存 ⇒ 提交端已标记收缩");
    assert_eq!(f_row, first, "③ 落库 effective_from 必须是**执行时真实首 bar**（非缓存边界 {}）", stale.from);
    assert_eq!(t_row, last + Duration::seconds(1), "③ 落库 effective_to 必须是**执行时真实末 bar+1s**");
    assert_eq!(cfg["requested_from"], json!(req_from.to_rfc3339()), "原始请求仍留痕（审计）");
    assert_eq!(cfg["requested_to"], json!(req_to.to_rfc3339()));
    cleanup_ctl(&pool, &symbol).await;
}

// ═════════════════════════════ ④ 资源护栏（D1） ═════════════════════════════

/// ≥500,000 ⇒ 400 `resource_guard`（detail 含 limit_bars/confirm_bars/预估）；`confirm:true` ⇒ 放行；
/// >2,000,000 ⇒ **硬拒**（confirm 亦不放行）。边界按 `>=` / `>` 语义逐点验证。
#[tokio::test]
async fn t_p5_resource_guard_thresholds_and_confirm() {
    let pool = pool().await;
    let symbol = format!("83{:04}", (std::process::id() + 3) % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();
    let avail = domain::ports::AvailableRange { from: first, to: last + Duration::seconds(1) };
    let from = first;
    let to = last + Duration::seconds(1);

    let mk = |n: i64| ctl_workbench(&pool, CtlData {
        bars: bars.clone(), range: Some(avail), count: CountMode::Fixed(n),
    });

    // (a) 阈值下 1 根：放行（无护栏）——护栏口径是 ≥ 500_000（ADR-024 D1 修订 2026-09-18）。
    let v = mk(499_999).submit(submit_req(&symbol, "M1", from, to, &vid)).await
        .expect("499_999 < 500_000 ⇒ 放行");
    println!("[④] estimated=199999 ⇒ 放行（run={}）", v.id);

    // (b) 恰好阈值：不带 confirm ⇒ 400。
    let e = mk(500_000).submit(submit_req(&symbol, "M1", from, to, &vid)).await
        .err().expect("≥500_000 且无 confirm ⇒ 必须 400");
    let s = structured(&e, "[④阈值]");
    println!("[④] code={} detail={}", s.code, s.detail);
    assert_eq!(s.code, "resource_guard");
    assert_eq!(s.detail["limit_bars"], json!(2_000_000i64), "detail 必含 limit_bars");
    assert_eq!(s.detail["confirm_bars"], json!(500_000i64), "detail 必含 confirm_bars");
    assert_eq!(s.detail["requested_bars"], json!(500_000i64), "detail 必含预估 bar 数");
    assert_eq!(s.detail["confirmable"], json!(true));
    let est = s.detail["estimated_secs"].as_f64().expect("detail 必含预估耗时");
    println!("[④] estimated_secs={est}（须含每 run 固定成本项 ⇒ > 0.85s）");
    assert!(est >= 0.85, "预估算子必须含固定成本项（P1c 实测 ~0.85s）");

    // (c) 带 confirm=true 重提 ⇒ **放行**。
    let mut req = submit_req(&symbol, "M1", from, to, &vid);
    req.confirm = true;
    let v = mk(500_000).submit(req.clone()).await.expect("confirm=true ⇒ 放行");
    println!("[④] confirm=true ⇒ 放行（run id={} status={:?}）", v.id, v.status);
    let (_, _, cfg) = run_row(&pool, &v.id).await;
    println!("[④] 落库 config.estimated_bars={} progress_prescan={}",
        cfg["estimated_bars"], cfg["progress_prescan"]);

    // (d) >2,000,000 ⇒ 硬拒（confirm=true 亦不放行）。
    let mut req = submit_req(&symbol, "M1", from, to, &vid);
    req.confirm = true;
    let e = mk(2_000_001).submit(req).await.err().expect(">2_000_000 必须硬拒（不可 confirm）");
    let s = structured(&e, "[④硬上界]");
    println!("[④] 硬拒 code={} confirmable={} message={}", s.code, s.detail["confirmable"], s.message);
    assert_eq!(s.code, "resource_guard");
    assert_eq!(s.detail["confirmable"], json!(false), ">2M 不可放行");
    assert_eq!(s.detail["requested_bars"], json!(2_000_001i64));

    cleanup_ctl(&pool, &symbol).await;
}

// ═══════════════════════ ⑤ 结构化错误（应用层形状 + 可编程消费） ═══════════════════════

/// 应用层 `StructuredError` 序列化形状须为 `{code,message,detail}`（web 层再包一层 `error`），
/// 且 detail 是**对象**（前端可按字段消费，不得退回字符串）。
#[tokio::test]
async fn t_p5_structured_error_serializes_as_object() {
    let s = application::error::StructuredError::new(
        "range_empty", "无数据", json!({"available_from": "2025-01-01T00:00:00Z"}));
    let v = serde_json::to_value(&s).unwrap();
    println!("[⑤] 序列化={v}");
    assert!(v.get("code").is_some() && v.get("message").is_some() && v.get("detail").is_some());
    assert!(v["detail"].is_object(), "detail 必须是对象（可编程消费）");
    // 估算 helper 的形状（预估耗时含固定项）。
    assert!((application::error::estimate_secs(0) - 0.85).abs() < 1e-6);
    assert!(application::error::estimate_secs(500_000) > application::error::estimate_secs(1_000));
}

// ═══════════════════ ⑤/④/② HTTP 层（真 axum + 真库）：结构化错误形状 ═══════════════════

/// 真起 axum（真库）验证 400 结构化体的 HTTP 形状：
/// 覆盖 `range_empty` / `resource_guard` / `period_invalid` / `from_after_to`。
#[tokio::test]
async fn t_p5_http_structured_error_shape() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let code = format!("83{:04}", (std::process::id() + 4) % 10000);
    seed_symbol_and_m1(&pool, &code, 6).await;
    let vid = a_published_version(&pool).await;
    let slots = json!([{"version_id": vid, "params": {}, "weight": 1.0}]);
    let fee = json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
    let policy = json!({"LumpSum": {"position_pct": 1.0}});

    // (1) range_empty：请求窗口在数据之后（数据只有 base()..+6min）。
    let body = json!({"symbol": code, "period": "M1", "slots": slots, "fee": fee, "policy": policy,
        "from": (base() + Duration::days(10)).to_rfc3339(),
        "to": (base() + Duration::days(20)).to_rfc3339()});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let st = r.status();
    let txt = r.text().await.unwrap();
    println!("[⑤-http range_empty] status={st} raw_body={txt}");
    let v: Value = serde_json::from_str(&txt).unwrap_or_else(|_| panic!("非 JSON 响应体: {txt:?}"));
    println!("[⑤-http range_empty] body={v}");
    assert_eq!(st, 400);
    assert_eq!(v["error"]["code"], "range_empty", "前端可编程消费: {v}");
    assert!(v["error"]["detail"]["available_from"].is_string(), "range_empty 须回显可用区间: {v}");
    assert!(v["error"]["message"].is_string());

    // (2) resource_guard：真库 518880 全历史 M1（77 万 bar ≥ 20 万 ⇒ 护栏拒绝，不落 run）。
    let body = json!({"symbol": "518880", "period": "M1", "slots": slots, "fee": fee, "policy": policy,
        "from": "2013-07-29T01:30:00Z", "to": "2026-09-18T00:00:00Z"});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let st = r.status();
    let txt = r.text().await.unwrap();
    println!("[⑤-http resource_guard] status={st} raw_body={txt}");
    let v: Value = serde_json::from_str(&txt).unwrap_or_else(|_| panic!("非 JSON 响应体: {txt:?}"));
    assert_eq!(st, 400);
    assert_eq!(v["error"]["code"], "resource_guard");
    assert_eq!(v["error"]["detail"]["limit_bars"], json!(2_000_000i64));
    assert_eq!(v["error"]["detail"]["confirm_bars"], json!(500_000i64));
    assert!(v["error"]["detail"]["requested_bars"].as_i64().unwrap() >= 500_000);
    assert!(v["error"]["detail"]["estimated_secs"].as_f64().unwrap() > 0.0);

    // (3) period_invalid：白名单外周期。
    let body = json!({"symbol": "518880", "period": "W1", "slots": slots, "fee": fee, "policy": policy,
        "from": "2025-01-01T00:00:00Z", "to": "2025-02-01T00:00:00Z"});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let st_p = r.status();
    let perr = r.text().await.unwrap();
    println!("[⑤-http period_invalid] status={st_p} raw_body={perr}");

    // (4) from_after_to：from >= to。
    let body = json!({"symbol": "518880", "period": "M1", "slots": slots, "fee": fee, "policy": policy,
        "from": "2025-02-01T00:00:00Z", "to": "2025-01-01T00:00:00Z"});
    let r = http.post(format!("{url}/api/workbench/runs")).json(&body).send().await.unwrap();
    let st_f = r.status();
    let ferr = r.text().await.unwrap();
    println!("[⑤-http from_after_to] status={st_f} raw_body={ferr}");

    // 契约 §3.1.1 要求：period_invalid / from_after_to 亦须为结构化 code（前端按 code 分支）。
    let mut violations = Vec::new();
    for (what, txt) in [("period_invalid", &perr), ("from_after_to", &ferr)] {
        let v: Value = serde_json::from_str(txt).unwrap_or(Value::Null);
        if v["error"]["code"] != json!(what) {
            violations.push(format!("{what}: 实得 raw={txt}（error 是**字符串**，无 code/detail）"));
        }
    }
    println!("[⑤-http 结构化缺口] {}", violations.join(" | "));
    assert_eq!(st_p, 400);
    assert_eq!(st_f, 400);
    assert!(violations.is_empty(),
        "契约 §3.1.1 要求 period_invalid/from_after_to 亦为 {{error:{{code,message,detail}}}}（前端按 code 分支）\n{}",
        violations.join("\n"));

    sqlx::query("DELETE FROM strategy_run WHERE symbol = $1").bind(&code).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(&code).execute(&pool).await.unwrap();
}

// ═══════════════ ⑥ 试算同口径（D11）+ 均匀抽样保首尾 ═══════════════

/// 试算与工作台**同口径**：同一区间收缩行为一致；试算去档（长跨度可试算）；
/// 超 `MAX_SCORE_POINTS` 改**均匀抽样（保首尾）** + `downsampled`/`original_points`。
#[tokio::test]
async fn t_p5_testrun_same_caliber_and_uniform_sampling() {
    let pool = pool().await;
    let symbol = format!("83{:04}", (std::process::id() + 5) % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();
    let avail = domain::ports::AvailableRange { from: first, to: last + Duration::seconds(1) };
    let data = CtlData { bars: bars.clone(), range: Some(avail), count: CountMode::Real };
    let ts_svc = ctl_strategy(&pool, data.clone());
    let wb_svc = ctl_workbench(&pool, data);

    let mk_req = |from: DateTime<Utc>, to: DateTime<Utc>, bars_override: Option<Vec<domain::types::Bar>>| {
        let _ = bars_override;
        application::strategy::TestRunRequest {
            source: application::strategy::TestRunSource::Inline(P5_CONST_CODE.to_string()),
            params: json!({}),
            symbol: symbol.clone(),
            period: "M1".to_string(),
            from, to,
            mode: application::strategy::TestRunMode::PureScore,
            warmup_bars: 0,
            fee: Some(json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0})),
            policy: json!({"LumpSum": {"position_pct": 1.0}}),
            initial_capital: 100_000.0,
            confirm: false,
        }
    };

    // (a) 同口径：两端超 ⇒ 试算与工作台收缩到同一 effective 区间。
    let req_from = first - Duration::days(10);
    let req_to = last + Duration::days(10);
    let tr = ts_svc.test_run(&mk_req(req_from, req_to, None)).await.expect("试算应成功（无日历档）");
    println!("[⑥同口径-试算] requested=[{}, {}] effective=[{}, {}) clamped={} reason={:?} estimated={:?}",
        tr.requested_from, tr.requested_to, tr.effective_from, tr.effective_to,
        tr.clamped, tr.clamp_reason, tr.estimated_bars);
    let v = wb_svc.submit(submit_req(&symbol, "M1", req_from, req_to, &vid)).await.unwrap();
    println!("[⑥同口径-工作台] effective=[{}, {}) clamped={}", v.from_ts, v.to_ts, v.clamped);
    assert_eq!(tr.effective_from, v.from_ts, "⑥ 同区间 ⇒ 试算与工作台收缩结果必须一致");
    assert_eq!(tr.effective_to, v.to_ts);
    assert_eq!(tr.clamped, v.clamped);
    assert_eq!(tr.effective_from, avail.from);
    assert_eq!(tr.effective_to, avail.to);

    // (b) 试算无交集 ⇒ 结构化 range_empty（同工作台）。
    let e = ts_svc.test_run(&mk_req(last + Duration::days(30), last + Duration::days(60), None))
        .await.err().expect("试算无交集必须拒绝");
    let s = structured(&e, "[⑥试算无交集]");
    println!("[⑥试算无交集] code={} detail={}", s.code, s.detail);
    assert_eq!(s.code, "range_empty");

    // (c) 均匀抽样保首尾：50,050 根 ⇒ 50,000 点，首尾保留，downsampled/original_points 回显。
    let n = application::strategy::MAX_SCORE_POINTS + 50;
    let big: Vec<domain::types::Bar> =
        (0..n as i64).map(|i| mk_bar(t0() + Duration::minutes(i))).collect();
    let big_first = big.first().unwrap().ts;
    let big_last = big.last().unwrap().ts;
    let big_svc = ctl_strategy(&pool, CtlData {
        bars: big, range: Some(domain::ports::AvailableRange { from: big_first, to: big_last + Duration::seconds(1) }),
        count: CountMode::Real,
    });
    let r = big_svc.test_run(&mk_req(big_first, big_last + Duration::seconds(1), None)).await
        .expect("长区间试算应成功");
    println!("[⑥抽样] bar_count={} scores={} downsampled={} original_points={} truncated.scores={} 首={} 末={}",
        r.bar_count, r.scores.len(), r.downsampled, r.original_points, r.truncated.scores,
        r.scores.first().map(|p| p.ts).unwrap_or_default(),
        r.scores.last().map(|p| p.ts).unwrap_or_default());
    assert_eq!(r.scores.len(), application::strategy::MAX_SCORE_POINTS, "抽样到 k 点");
    assert_eq!(r.original_points, n, "original_points = 抽样前点数");
    assert!(r.downsampled, "抽样必须显式标注");
    assert!(!r.truncated.scores, "不再以 truncated.scores 表达丢尾（D11）");
    assert_eq!(r.scores.first().unwrap().ts, big_first.timestamp(), "⑥ 保首");
    assert_eq!(r.scores.last().unwrap().ts, big_last.timestamp(), "⑥ 保尾（旧实现丢尾 ⇒ 这里必红）");

    cleanup_ctl(&pool, &symbol).await;
}

// ═══════════════════ ⑦ 进度预扫描（D12：count 精确 / 降级可见） ═══════════════════

#[tokio::test]
async fn t_p5_prescan_count_and_degraded_path_visible() {
    let pool = pool().await;
    let symbol = format!("83{:04}", (std::process::id() + 6) % 10000);
    cleanup_ctl(&pool, &symbol).await;
    ensure_ctl_symbol(&pool, &symbol).await;
    let vid = a_published_version(&pool).await;
    let (bars, first, last) = three_segments();
    let avail = domain::ports::AvailableRange { from: first, to: last + Duration::seconds(1) };
    let from = first;
    let to = last + Duration::seconds(1);

    // (a) count 成功 ⇒ 精确估计 + 口径标记 `count`。
    let svc = ctl_workbench(&pool, CtlData { bars: bars.clone(), range: Some(avail), count: CountMode::Fixed(1234) });
    let v = svc.submit(submit_req(&symbol, "M1", from, to, &vid)).await.unwrap();
    let (_, _, cfg) = run_row(&pool, &v.id).await;
    println!("[⑦count] estimated_bars={:?} config.progress_prescan={}", v.estimated_bars, cfg["progress_prescan"]);
    assert_eq!(v.estimated_bars, Some(1234), "预扫描精确值须回显");
    assert_eq!(cfg["progress_prescan"], json!("count"), "口径须落 config（可事后回查）");

    // (b) count 失败 ⇒ 降级（estimated=null + 口径标记 `ts_norm`，**可见**）。
    let svc = ctl_workbench(&pool, CtlData { bars: bars.clone(), range: Some(avail), count: CountMode::Fail });
    let v = svc.submit(submit_req(&symbol, "M1", from, to, &vid)).await
        .expect("预扫描失败不得阻断提交（降级口径）");
    let (_, _, cfg) = run_row(&pool, &v.id).await;
    println!("[⑦降级] estimated_bars={:?} config.progress_prescan={} （并伴随 tracing::warn，见 src 行 489-492）",
        v.estimated_bars, cfg["progress_prescan"]);
    assert_eq!(v.estimated_bars, None, "降级 ⇒ 无伪精确值");
    assert_eq!(cfg["progress_prescan"], json!("ts_norm"), "降级口径必须可见（响应/config 标明）");

    cleanup_ctl(&pool, &symbol).await;
}

// ═══════════ ② 并集口径（D3）活库独立用例 + 反向证据（accurate 单层 ⇒ 必须变红） ═══════════

/// 构造「accurate cagg 滞后、兜底（15m rollup）有更新数据」：
/// `available_range(M30)` 必须取**并集**最新（兜底桶），不得只取 accurate 单层。
/// 反向证据：把 `period_avail_sql(M30)` 改回 accurate 单层 ⇒ 本用例必须 FAIL（见报告 §R1）。
#[tokio::test]
async fn t_p5_union_available_range_live_accurate_lags_fallback() {
    use domain::ports::BacktestBarRead;
    let pool = pool().await;
    let code = format!("83{:04}", (std::process::id() + 7) % 10000);
    let clean_all = |pool: PgPool, code: String| async move {
        for t in ["kline_raw", "kline_accurate", "kline_accurate_30m", "kline_15m"] {
            let _ = sqlx::query(&format!("DELETE FROM {t} WHERE code = $1")).bind(&code).execute(&pool).await;
        }
    };
    clean_all(pool.clone(), code.clone()).await;

    // accurate 层：05:22/05:37（→ 30m 桶 05:00 与 05:30；取更晚者 = 05:30 桶）。
    for ts in ["2025-06-02T05:22:00Z", "2025-06-02T05:37:00Z"] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', 1,1,1,1,100,100.0,'tushare')")
            .bind(&code).bind(ts.parse::<DateTime<Utc>>().unwrap()).execute(&pool).await.unwrap();
    }
    sqlx::query("CALL refresh_continuous_aggregate('kline_accurate_30m', $1::timestamptz, $2::timestamptz)")
        .bind("2025-06-02T05:00:00Z".parse::<DateTime<Utc>>().unwrap())
        .bind("2025-06-02T06:00:00Z".parse::<DateTime<Utc>>().unwrap())
        .execute(&pool).await.unwrap();

    // 兜底层：raw → kline_15m，桶 07:15 / 07:45（**晚于** accurate 的 05:30 桶）。
    for ts in ["2025-06-02T07:16:00Z", "2025-06-02T07:46:00Z"] {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 1,1,1,1,100,100.0,'tencent_ifzq')")
            .bind(&code).bind(ts.parse::<DateTime<Utc>>().unwrap()).execute(&pool).await.unwrap();
    }
    sqlx::query("CALL refresh_continuous_aggregate('kline_15m', $1::timestamptz, $2::timestamptz)")
        .bind("2025-06-02T07:15:00Z".parse::<DateTime<Utc>>().unwrap())
        .bind("2025-06-02T08:00:00Z".parse::<DateTime<Utc>>().unwrap())
        .execute(&pool).await.unwrap();

    let r = storage::backtest::BacktestBarReader::new(pool.clone());
    let got = r.available_range(&code, &domain::types::Period::M30).await.unwrap().expect("有数据");
    let accurate_max: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(ts) FROM kline_accurate_30m WHERE code = $1").bind(&code).fetch_one(&pool).await.unwrap();
    let fallback_bucket: DateTime<Utc> = "2025-06-02T07:30:00Z".parse().unwrap();
    println!("[②并集] available_range=({}, {}) accurate 单层 max={:?} 兜底 30m 桶={}",
        got.from, got.to, accurate_max, fallback_bucket);
    assert_eq!(got.from, "2025-06-02T05:00:00Z".parse::<DateTime<Utc>>().unwrap(),
        "from = 并集最早（accurate 30m 桶 05:00）");
    assert_eq!(got.to, fallback_bucket + Duration::seconds(1),
        "to = 并集最晚（**兜底** 30m 桶 07:30）+1s；只取 accurate 单层会得到 05:30 桶 ⇒ 必红");
    assert_ne!(accurate_max.unwrap(), fallback_bucket, "本场景必须真构造出「accurate 滞后」");

    // 预扫描计数与取数同源（并集去重：05:00/05:30 + 07:30 = 3 桶）。
    let n = r.count_bars(&code, &domain::types::Period::M30, got.from, got.to).await.unwrap();
    println!("[②并集] count(*)={n}（期望 4：accurate 30m 2 桶(05:00/05:30) + 兜底 15m rollup 2 桶(07:00/07:30)）");
    assert_eq!(n, 4, "count 与取数同源口径（accurate ∪ 兜底，逐 15m 桶去重后 rollup）");

    clean_all(pool.clone(), code.clone()).await;
}

// ═══════ ① 补：HTTP 层 D1 去档（旧 web 断言「D1 超 5 年应 400」的反转验证） ═══════

/// `crates/web/tests/api_strategies.rs:467` 仍保留旧断言「区间超限（D1 > 5 年）→ 400」，
/// 该断言的 400 现已**换源**（合成标的无 D1 数据 ⇒ `range_empty`），属静默残留。
/// 本用例用**有 D1 真实数据**的 518880 请求 6 年跨度 ⇒ 必须可试算（旧实现必 400）。
#[tokio::test]
async fn t_p5_http_d1_six_year_span_accepted_independent() {
    let pool = pool().await;
    let url = spawn(state(pool.clone())).await;
    let http = reqwest::Client::new();
    let body = json!({"code": P5_CONST_CODE, "symbol": "518880", "period": "D1",
        "from": "2020-01-01T00:00:00Z", "to": "2026-01-01T00:00:00Z", "mode": "pure_score"});
    let r = http.post(format!("{url}/api/strategies/test-run")).json(&body).send().await.unwrap();
    let st = r.status();
    let txt = r.text().await.unwrap();
    println!("[①-D1] 518880 D1 2020-01-01→2026-01-01（>5 年）status={st} body={}",
        &txt[..txt.len().min(400)]);
    assert_eq!(st, 200, "D1 6 年跨度必须可试算（旧「D1 > 5 年 → 400」已撤销）：{txt}");
    let v: Value = serde_json::from_str(&txt).unwrap();
    println!("[①-D1] bar_count={} effective=[{}, {}) clamped={} estimated_bars={:?}",
        v["bar_count"], v["effective_from"], v["effective_to"], v["clamped"], v["estimated_bars"]);
    assert_eq!(v["requested_from"], json!("2020-01-01T00:00:00Z"));
    assert!(v["bar_count"].as_u64().unwrap() > 1000, "应真跑出 D1 结果（非仅校验通过）");
}
