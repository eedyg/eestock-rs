//! D11 端到端实测（ADR-019 D11-3）：**真实库** `symbols.type` + `fee_profiles` + 真实 K 线
//! → `StrategyService::test_run` 省略 fee 时按标的类型解析（ETF：印花税 0、过户费 0、规费列 0），
//! 显式传参仍整体优先（可复现旧行为）。
//!
//! 只读：不写任何库数据；无需已发布策略（`TestRunSource::Inline`）。
//! 装配与 app bin 生产装配**同结构**（PgStrategyStore + BacktestBarReader + SystemClock
//! + PgFeeProfileStore.with_fee_profiles），是「生产装配真的接线」的端到端证据。

use std::sync::Arc;

use application::strategy::{StrategyService, TestRunMode, TestRunRequest, TestRunSource};
use chrono::{DateTime, Duration, Utc};
use domain::ports::SystemClock;
use serde_json::json;
use sqlx::PgPool;
use storage::backtest::BacktestBarReader;
use storage::fee_profile::PgFeeProfileStore;
use storage::strategy::PgStrategyStore;

/// 真实注册 ETF（迁移 0025 回填 `type=etf`）。
const ETF: &str = "510050";
/// 恒高分策略：首个 bar 建仓，期末强制平仓（产生卖出成交 → 印花税口径可观测）。
const CONST_BUY: &str = "function on_bar(ctx) { return 100; }";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

fn service(pool: &PgPool) -> StrategyService {
    StrategyService::new(
        Arc::new(PgStrategyStore::new(pool.clone())),
        Arc::new(BacktestBarReader::new(pool.clone())),
        Arc::new(SystemClock),
    )
    .with_fee_profiles(Arc::new(PgFeeProfileStore::new(pool.clone())))
}

fn request(symbol: &str, from: DateTime<Utc>, to: DateTime<Utc>, fee: Option<serde_json::Value>)
    -> TestRunRequest {
    TestRunRequest {
        source: TestRunSource::Inline(CONST_BUY.into()),
        params: json!({}),
        symbol: symbol.into(),
        period: "D1".into(),
        from,
        to,
        mode: TestRunMode::SimPosition,
        warmup_bars: 5,
        fee,
        policy: json!({"LumpSum": {"position_pct": 1.0}}),
        initial_capital: 100_000.0,
    }
}

fn sum(trades: &[serde_json::Value], key: &str) -> f64 {
    trades.iter().map(|t| t[key].as_f64().unwrap_or(0.0)).sum()
}

#[tokio::test]
async fn real_db_etf_default_fee_is_stamp_free_and_explicit_still_wins() {
    let pool = pool().await;
    // 标的类型已回填（迁移 0025 已 apply）——否则本用例无意义，显式失败
    let ty: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
        .bind(ETF).fetch_one(&pool).await.unwrap();
    assert_eq!(ty.as_deref(), Some("etf"), "{ETF} 应为已回填的 etf（迁移 0025）");

    // 真实 K 线区间（近 180 天 D1；由库内实际范围推导，避免硬编码数据边界）
    let (_, max_ts): (Option<DateTime<Utc>>, DateTime<Utc>) =
        sqlx::query_as("SELECT min(ts), max(ts) FROM kline_accurate_1d WHERE code = $1")
            .bind(ETF).fetch_one(&pool).await.unwrap();
    let to = max_ts;
    let from = max_ts - Duration::days(180);

    let svc = service(&pool);

    // ① 省略 fee → 按标的 type 解析：ETF 印花税不征 0 / 过户费 0 / 规费列 0
    let r = svc.test_run(&request(ETF, from, to, None)).await.expect("真实库试算应成功");
    assert!(r.bar_count > 20, "真实库应有足够 bar（got {}）", r.bar_count);
    assert_eq!(r.fee["effective"]["source"], json!("profile"), "来源=profile（按 symbols.type 查档案）");
    assert_eq!(r.fee["symbol_type"], json!("etf"));
    assert_eq!(r.fee["effective"]["stamp_duty_pct"], json!(0.0), "ETF 印花税不征 → 0（D11 主目标）");
    assert_eq!(r.fee["effective"]["commission_rate_pct"], json!(0.025), "佣金仍为全佣口径默认");
    assert_eq!(r.fee["profile"]["transfer_fee_pct"], json!(0.0), "过户费免收 → 0");
    assert_eq!(r.fee["profile"]["exchange_fee_pct"], json!(0.0), "全佣口径：经手费列 0");
    assert_eq!(r.fee["profile"]["regulatory_fee_pct"], json!(0.0), "证管费列 0");
    assert_eq!(r.fee["profile"]["not_modeled"],
        json!(["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"]),
        "三项规费未建模 → 显式标记，且不得出现在 effective 段");
    for k in ["exchange_fee_pct", "regulatory_fee_pct", "transfer_fee_pct"] {
        assert!(r.fee["effective"].get(k).is_none(), "{k} 未参与撮合，不得入 effective");
    }
    let trades = r.trades.as_array().expect("trades 数组");
    assert!(!trades.is_empty(), "恒高分策略应至少一次建仓 + 期末平仓");
    assert_eq!(sum(trades, "stamp_duty"), 0.0, "ETF 缺省口径成交印花税合计为 0");
    let pnl_profile = sum(trades, "pnl");

    // ② 显式传参（缺 stamp）→ 整体以显式为准：旧行为完全可复现（0.05 卖出印花税）
    let explicit = json!({"rate_pct": 0.025, "min_fee": 5.0, "slippage_bp": 2.0});
    let r2 = svc.test_run(&request(ETF, from, to, Some(explicit))).await.expect("显式口径试算");
    assert_eq!(r2.fee["effective"]["source"], json!("explicit"), "显式传参优先于档案");
    assert_eq!(r2.fee["effective"]["stamp_duty_pct"], json!(0.05), "显式分支缺 stamp → 旧 ADR bt-1 默认");
    let trades2 = r2.trades.as_array().unwrap();
    let stamp2 = sum(trades2, "stamp_duty");
    assert!(stamp2 > 0.0, "旧口径下 ETF 被多收印花税（={stamp2}）");
    let pnl_explicit = sum(trades2, "pnl");
    // 实测留痕（--nocapture 可见；D11 背景数字：同一 ETF 同配置旧口径 pnl 偏低）
    println!(
        "[D11 实测] symbol={ETF} bars={} trades={} | profile: fee={} stamp_sum=0 pnl={pnl_profile:.4}          | explicit: stamp_sum={stamp2} pnl={pnl_explicit:.4} | Δpnl={:.4}",
        r.bar_count, trades.len(), r.fee, pnl_profile - pnl_explicit
    );
    assert!(
        pnl_profile > pnl_explicit,
        "修复后 ETF 口径 pnl 应优于旧（多收印花税）口径：profile={pnl_profile} explicit={pnl_explicit}"
    );
}
