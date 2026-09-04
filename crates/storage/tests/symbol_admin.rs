// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/storage/tests/symbol_admin.rs>>[init]
//! PgSymbolAdmin / PgResetStore / today_stats 集成测试（需 TimescaleDB :5433，含 0007 迁移）。

use chrono::{Duration, Utc};
use domain::ports::{
    CircuitResetChannel, CircuitResetWrite, SymbolAdminInput, SymbolAdminWrite, SymbolPatch,
    SymbolStatsRead,
};
use sqlx::PgPool;
use storage::admin::{PgResetStore, PgSymbolAdmin};
use storage::reader::KlineReader;

const CODE: &str = "996810";
const CODE2: &str = "996811";
const STATS_CODE: &str = "996812";
const RSRC: &str = "storage_test_reset_src";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool) {
    for c in [CODE, CODE2] {
        sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(c).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(c).execute(pool).await.unwrap();
    }
}

// 每测试独立 clean（同 binary 测试并行执行，共享清理会互删——实锤踩坑，见 kline_reader.rs 注记）
async fn clean_stats(pool: &PgPool) {
    sqlx::query("DELETE FROM kline_raw WHERE code = $1").bind(STATS_CODE).execute(pool).await.unwrap();
    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(STATS_CODE).execute(pool).await.unwrap();
}

async fn clean_reset(pool: &PgPool) {
    sqlx::query("DELETE FROM circuit_reset_requests WHERE source = $1")
        .bind(RSRC).execute(pool).await.unwrap();
}

fn input(code: &str) -> SymbolAdminInput {
    SymbolAdminInput { code: code.into(), name: Some("测试ETF".into()),
        interval_secs: 60, settlement: "T1".into(), enabled: true }
}

#[tokio::test]
async fn register_update_roundtrip_and_conflict() {
    let pool = pool().await;
    clean(&pool).await;
    let admin = PgSymbolAdmin::new(pool.clone());

    assert!(admin.register(&input(CODE)).await.unwrap(), "首次注册成功");
    assert!(!admin.register(&input(CODE)).await.unwrap(), "重复注册 → false（409 语义）");

    // 编辑：间隔 60→300 + 停用（COALESCE 只动给定字段）
    let patch = SymbolPatch { interval_secs: Some(300), enabled: Some(false), ..Default::default() };
    assert!(admin.update(CODE, &patch).await.unwrap());
    let row: (i32, String, bool, Option<String>) =
        sqlx::query_as("SELECT interval_secs, settlement, enabled, name FROM symbols WHERE code = $1")
            .bind(CODE).fetch_one(&pool).await.unwrap();
    assert_eq!(row.0, 300, "间隔更新落库（数据面下周期热生效）");
    assert_eq!(row.1, "T1", "未给字段保持原值");
    assert!(!row.2, "停用落库（仅停用，无物理删除）");
    assert_eq!(row.3.as_deref(), Some("测试ETF"));

    assert!(!admin.update("996899", &SymbolPatch::default()).await.unwrap(),
        "未知 code → false（404 语义）");

    // schema CHECK 对齐双保险：web 层已拦 <60，此处锁库层约束仍生效
    let bad = SymbolAdminInput { interval_secs: 30, ..input(CODE2) };
    assert!(admin.register(&bad).await.is_err(), "interval_secs<60 被 schema CHECK 拒绝");
    let bad2 = SymbolAdminInput { settlement: "T2".into(), ..input(CODE2) };
    assert!(admin.register(&bad2).await.is_err(), "非法 settlement 被 schema CHECK 拒绝");
    clean(&pool).await;
}

#[tokio::test]
async fn today_stats_counts_shanghai_day_window() {
    let pool = pool().await;
    clean_stats(&pool).await;
    // 今日 2 根 + 昨日 3 根（Asia/Shanghai 日界由实现侧 domain::tz 计算）
    let now = Utc::now();
    for i in 0..2 {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(STATS_CODE).bind(now - Duration::minutes(i + 1)).execute(&pool).await.unwrap();
    }
    for i in 0..3 {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 1, 1, 1, 1, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(STATS_CODE).bind(now - Duration::days(1) - Duration::minutes(i))
            .execute(&pool).await.unwrap();
    }
    let stats = KlineReader::new(pool.clone()).today_stats().await.unwrap();
    let s = stats.iter().find(|r| r.code == STATS_CODE).expect("含测试标的");
    assert_eq!(s.today_bars, 2, "仅当日（Asia/Shanghai 日界）行数");
    assert!(s.last_bar_ts.is_some());
    clean_stats(&pool).await;
}

#[tokio::test]
async fn reset_channel_write_take_consume_once() {
    let pool = pool().await;
    clean_reset(&pool).await;
    let store = PgResetStore::new(pool.clone());

    store.request_reset(RSRC).await.unwrap();
    store.request_reset(RSRC).await.unwrap();
    let taken = store.take_pending().await.unwrap();
    let mine: Vec<_> = taken.iter().filter(|r| r.source == RSRC).collect();
    assert_eq!(mine.len(), 2, "待消费请求原子取出");
    assert!(mine[0].id < mine[1].id, "按 id 顺序");
    let again = store.take_pending().await.unwrap();
    assert!(!again.iter().any(|r| r.source == RSRC), "已消费不重复取出");
    clean_reset(&pool).await;
}
// ~/~ end
