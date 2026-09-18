//! 回测 K 线读取端口实现集成测试（需 TimescaleDB :5433）。
//! 契约：BacktestBarRead（统一读源 accurate 优先 + 区间升序）。
//! P4b（D16 终章）：PgBacktestStore（backtest_runs/backtest_results CRUD，迁移 0011）随旧回测服务退役删除；
//! BacktestBarReader 保留（新系统 strategy 试算 / workbench / mcp 复用同一取数口径）。

use chrono::{DateTime, Duration, TimeZone, Utc};
use domain::ports::BacktestBarRead;
use domain::types::{Period, SourceId};
use sqlx::PgPool;
use storage::backtest::BacktestBarReader;

fn base() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    // ADR-023 E6b：统一测试库入口（EESTOCK_TEST_DATABASE_URL + 哨兵表校验），不得回退活库。
    test_support::test_pool().await
}

#[tokio::test]
async fn bar_read_m1_accurate_first_in_range() {
    let pool = pool().await;
    let code = "997781".to_string();
    // 5 根 1m raw（close 1..5）；base+1min 处准确层覆盖（close 9.99，777 股，tushare）
    for i in 0..5i64 {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(&code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 'M1', 9.99, 9.99, 9.99, 9.99, 777, 777.0, 'tushare') \
                 ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
        .bind(&code).bind(base() + Duration::minutes(1))
        .execute(&pool).await.unwrap();

    let r = BacktestBarReader::new(pool.clone());
    let bars = r.bars(&code, &Period::M1, base() - Duration::minutes(1),
        base() + Duration::minutes(10)).await.unwrap();
    assert_eq!(bars.len(), 5, "[from,to) 全量 bar");
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "ts 升序（回测口径）");
    assert_eq!(bars[0].close, 1.0);
    assert_eq!(bars[1].close, 9.99, "accurate 优先（ADR-003 merge 视图）");
    assert_eq!(bars[1].volume, 777);
    assert_eq!(bars[1].source, SourceId::Tushare);
    assert_eq!(bars[4].close, 5.0);

    // 区间边界：[from, to) 半开
    let subset = r.bars(&code, &Period::M1, base() + Duration::minutes(2),
        base() + Duration::minutes(4)).await.unwrap();
    assert_eq!(subset.iter().map(|b| b.close).collect::<Vec<_>>(), vec![3.0, 4.0]);

    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(&code).execute(&pool).await.unwrap();
    }
}

// ───────────────────────── ADR-024 P5：可得区间（服务口径并集）+ 预扫描计数 ─────────────────────────

/// **并集口径**（ADR-024 D3）：可得区间必须取 accurate ∪ 兜底的最新/最早 —— 构造
/// 「accurate 滞后而兜底有数据」场景（accurate cagg 已知滞后，单层判定会切掉兜底可服务的新数据）。
///
/// 反向证据：把 `period_avail_sql(M30)` 改回 accurate 单层（`kline_accurate_30m`）⇒
/// `max` 落到 accurate 的 02:00 而非兜底的 02:30 ⇒ 本测必红。
#[tokio::test]
async fn available_range_is_service_union_accurate_plus_fallback() {
    let pool = pool().await;
    let code = "997791";
    // tz 基准桶（UTC；30m/15m time_bucket 对齐）。
    const A0: &str = "2026-08-03T01:31:00Z"; // accurate M1 → 30m 桶 01:30
    const A1: &str = "2026-08-03T02:01:00Z"; // accurate M1 → 30m 桶 02:00
    const F0: &str = "2026-08-03T02:41:00Z"; // 兜底 raw → 15m 桶 02:30/02:45 → 30m 桶 02:30
    const F1: &str = "2026-08-03T02:46:00Z";

    for t in ["kline_raw", "kline_accurate"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(code).execute(&pool).await.unwrap();
    }
    // accurate 层（M1 → kline_accurate_30m cagg）：两桶（01:30 / 02:00）。
    for ts in [A0, A1] {
        sqlx::query(
            "INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
             VALUES ($1, $2, 'M1', 1, 1, 1, 1, 100, 100.0, 'tushare')")
            .bind(code).bind(ts.parse::<DateTime<Utc>>().unwrap()).execute(&pool).await.unwrap();
    }
    sqlx::query("CALL refresh_continuous_aggregate('kline_accurate_30m', $1::timestamptz, $2::timestamptz)")
        .bind("2026-08-03T01:30:00Z".parse::<DateTime<Utc>>().unwrap())
        .bind("2026-08-03T02:30:00Z".parse::<DateTime<Utc>>().unwrap())
        .execute(&pool).await.unwrap();
    // 兜底层（raw → kline_15m cagg）：更新的桶（02:30）——accurate 之后的兜底数据。
    for ts in [F0, F1] {
        sqlx::query(
            "INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
             VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq')")
            .bind(code).bind(ts.parse::<DateTime<Utc>>().unwrap()).execute(&pool).await.unwrap();
    }
    sqlx::query("CALL refresh_continuous_aggregate('kline_15m', $1::timestamptz, $2::timestamptz)")
        .bind("2026-08-03T02:30:00Z".parse::<DateTime<Utc>>().unwrap())
        .bind("2026-08-03T03:00:00Z".parse::<DateTime<Utc>>().unwrap())
        .execute(&pool).await.unwrap();

    let r = BacktestBarReader::new(pool.clone());
    let avail = r.available_range(code, &Period::M30).await.unwrap()
        .expect("有数据（union 非空）");
    let a0_bucket = "2026-08-03T01:30:00Z".parse::<DateTime<Utc>>().unwrap();
    let f0_bucket = "2026-08-03T02:30:00Z".parse::<DateTime<Utc>>().unwrap();
    assert_eq!(avail.from, a0_bucket, "from = union 最早（accurate 30m 桶 01:30）");
    assert_eq!(
        avail.to,
        f0_bucket + Duration::seconds(1),
        "to = union 最晚 +1s（**兜底** 02:30，非 accurate 02:00）——服务口径并集硬约束（D3）"
    );

    // 预扫描计数：union 去重后 3 桶（01:30/02:00 accurate + 02:30 兜底）。
    let n = r.count_bars(code, &Period::M30, avail.from, avail.to).await.unwrap();
    assert_eq!(n, 3, "count(*) 与取数同源口径（accurate ∪ 兜底，去重）");

    // 清理：连同 materialized cagg 行（否则留下孤儿行，破坏 `/api/quality/orphans` 的 0 断言）。
    for t in ["kline_raw", "kline_accurate", "kline_accurate_30m", "kline_15m"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(code).execute(&pool).await.unwrap();
    }
}

/// 可得区间：无数据 → `Ok(None)`（调用方据此 400 `range_empty`）。
#[tokio::test]
async fn available_range_none_when_no_data() {
    let pool = pool().await;
    let r = BacktestBarReader::new(pool);
    let got = r.available_range("999998", &Period::M30).await.unwrap();
    assert!(got.is_none(), "无数据 → None（禁止产出 0 bar 的「成功」run）");
}

// ─────────────────── ADR-024 P5 / R10：取数（读路径）标度量化（**只报告不优化**） ───────────────────

/// 量化 `BacktestBarReader::bars` 取数段随 n 的标度（debug 口径），并给出全历史 M1 外推。
/// **只报告不优化**（R10）：确认是否真为 ~50 µs/bar（P4b 仪表 M1 16k 809 ms 的疑点）。
#[tokio::test]
async fn measure_bars_fetch_scaling_r10() {
    use std::time::Instant;
    let pool = pool().await;
    let code = "510050"; // testdb 播种：M1 ≈ 86 万行（与服务口径一致）
    let r = BacktestBarReader::new(pool.clone());
    let Some(avail) = r.available_range(code, &Period::M1).await.unwrap() else {
        eprintln!("[r10] 跳过：测试库无 {code} M1 数据");
        return;
    };
    println!("[r10] {code} M1 可得区间：{} ~ {}", avail.from, avail.to);
    for n in [1_000i64, 5_000, 20_000, 100_000, 500_000] {
        let from = avail.to - Duration::minutes(n);
        let t = Instant::now();
        let bars = r.bars(code, &Period::M1, from, avail.to).await.unwrap();
        let dt = t.elapsed();
        let got = bars.len().max(1);
        println!(
            "[r10] read n={} got={} wall_ms={:.1} us_per_bar={:.2} bars_per_s={:.0}",
            n,
            bars.len(),
            dt.as_secs_f64() * 1000.0,
            dt.as_micros() as f64 / got as f64,
            got as f64 / dt.as_secs_f64()
        );
    }
    // 全历史外推（沿用最后一点的 us/bar；debug 口径，仅信息项）。
    let t = Instant::now();
    let all = r.bars(code, &Period::M1, avail.from, avail.to).await.unwrap();
    let dt = t.elapsed();
    println!(
        "[r10] read FULL got={} wall_ms={:.1} us_per_bar={:.2}",
        all.len(),
        dt.as_secs_f64() * 1000.0,
        dt.as_micros() as f64 / all.len().max(1) as f64
    );
}
