//! 回测 K 线读取端口实现集成测试（需 TimescaleDB :5433）。
//! 契约：BacktestBarRead（统一读源 accurate 优先 + 区间升序）。
//! P4b（D16 终章）：PgBacktestStore（backtest_runs/backtest_results CRUD，迁移 0011）随旧回测服务退役删除；
//! BacktestBarReader 保留（新系统 strategy 试算 / workbench / mcp 复用同一取数口径）。

use chrono::{Duration, TimeZone, Utc};
use domain::ports::BacktestBarRead;
use domain::types::{Period, SourceId};
use sqlx::PgPool;
use storage::backtest::BacktestBarReader;

fn base() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap()
}

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
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
