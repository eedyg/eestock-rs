// ~/~ begin <<design/07-app-plane/00-web-api.md#crates/storage/tests/kline_reader.rs>>[init]
//! KlineReader 只读集成测试（需 TimescaleDB :5433）：merge 准确层优先、游标分页、cagg/1h rollup、最新快照。

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use domain::ports::{HealthEventsRangeRead, HealthEventsRead, HolidayCalendarRead, KlineRead,
    QualityRead, TushareStatusRead};
use domain::types::Period;
use sqlx::PgPool;
use storage::reader::{HealthEventReader, HolidaysReader, KlineReader};

// 每测试独立 code：同 binary 测试并行执行，共享 code 会被彼此的 clean 误删（实锤踩坑）。
const CODE_MERGE: &str = "997701";
const CODE_CAGG: &str = "997711";
const CODE_SYM: &str = "997721";
const CODE_SYM_EMPTY: &str = "997722";
const CODE_DEEP: &str = "997751";
const CODE_WM: &str = "997733";   // 周/月聚合测试独占 code（避免与其他并行测试互删；997731 已被 CODE_QUAL 占用）
const CODE_WM_DEEP: &str = "997752"; // W1/MO1 全历史深翻测试独占 code（0016 前 cagg 有 ts>=2024 过滤）

fn base() -> DateTime<Utc> { Utc.with_ymd_and_hms(2026, 9, 3, 1, 30, 0).unwrap() }

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool, code: &str) {
    for t in ["kline_raw", "kline_accurate", "symbols"] {
        sqlx::query(&format!("DELETE FROM {t} WHERE code = $1"))
            .bind(code).execute(pool).await.unwrap();
    }
}

/// 5 根 1m raw bar（收盘 1..5，各 100 股）+ base+1min 处准确层覆盖（收盘 9.99，777 股）。
async fn seed(pool: &PgPool, code: &str) {
    for i in 0..5i64 {
        let c = 1.0 + i as f64;
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(code).bind(base() + Duration::minutes(i)).bind(c)
            .execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 'M1', 9.99, 9.99, 9.99, 9.99, 777, 777.0, 'tushare') \
                 ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
        .bind(code).bind(base() + Duration::minutes(1))
        .execute(pool).await.unwrap();
}

#[tokio::test]
async fn merged_1m_accurate_first_and_cursor_pagination() {
    let pool = pool().await;
    clean(&pool, CODE_MERGE).await;
    seed(&pool, CODE_MERGE).await;
    let r = KlineReader::new(pool.clone());

    let bars = r.bars(Period::M1, CODE_MERGE, None, 10).await.unwrap();
    assert_eq!(bars.len(), 5);
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "升序返回（图表口径）");
    assert_eq!(bars[1].close, 9.99, "准确层优先（ADR-003 merge 视图）");
    assert_eq!(bars[1].volume, 777);
    assert_eq!(bars[1].source.as_deref(), Some("tushare"));
    assert_eq!(bars[4].close, 5.0);
    assert_eq!(bars[4].source.as_deref(), Some("tencent_ifzq"));

    // 游标：before 不含该 ts 本身
    let page = r.bars(Period::M1, CODE_MERGE, Some(base() + Duration::minutes(3)), 10).await.unwrap();
    assert_eq!(page.iter().map(|b| b.close).collect::<Vec<_>>(), vec![1.0, 9.99, 3.0]);

    // limit 降序取后翻转
    let top2 = r.bars(Period::M1, CODE_MERGE, None, 2).await.unwrap();
    assert_eq!(top2.iter().map(|b| b.close).collect::<Vec<_>>(), vec![4.0, 5.0]);
    assert_eq!(r.latest_bar(Period::M1, CODE_MERGE).await.unwrap().unwrap().close, 5.0);
    assert!(r.latest_bar(Period::M1, "000000").await.unwrap().is_none());
    clean(&pool, CODE_MERGE).await;
}

#[tokio::test]
async fn merged_periods_accurate_first_and_1h_rollup() {
    let pool = pool().await;
    clean(&pool, CODE_CAGG).await;
    seed(&pool, CODE_CAGG).await;
    // 统一读源：所有周期读 merged（accurate 优先）。refres：accurate cagg（窗口覆盖 base() 数据
    // + D1 桶对齐）与 raw-derived cagg（兜底）。窗口 [09-02, 09-04] UTC 覆盖 base()=09-03 01:30 UTC
    // 的 M1 种子（01:30-01:34 UTC）与 D1 桶 ts（09-02 16:00 UTC）。
    for v in ["kline_accurate_5m", "kline_accurate_15m", "kline_accurate_1h", "kline_accurate_1d",
              "kline_5m", "kline_15m", "kline_1d"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2026-09-02 00:00:00+00', '2026-09-04 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    // 准确层优先：overlap 分钟返回 accurate（close=9.99, vol=777, source=tushare），而非 raw 侧。
    for p in [Period::M5, Period::M15, Period::H1, Period::D1] {
        let bars = r.bars(p, CODE_CAGG, None, 10).await.unwrap();
        assert_eq!(bars.len(), 1, "{p:?} 一个桶");
        assert_eq!(bars[0].open, 9.99, "{p:?} accurate 优先（ADR-003 推广）");
        assert_eq!(bars[0].close, 9.99);
        assert_eq!(bars[0].volume, 777, "{p:?} accurate cagg 数值归一");
        assert_eq!(bars[0].source.as_deref(), Some("tushare"), "{p:?} accurate 层来源");
    }
    clean(&pool, CODE_CAGG).await;
}

#[tokio::test]
async fn weekly_monthly_periods_aggregate() {
    let pool = pool().await;
    clean(&pool, CODE_WM).await;
    // 种子：kline_accurate M1 跨两周/两月，验证 W1/MO1 聚合（周=A股交易周周一为界、月=自然月）。
    // 2026-08-31(Mon) 两根 + 2026-09-07(Mon) 一根 → 两周（周 A/B）两月（8月/9月）；
    // 周内多根验证 first(open)/last(close)/sum(volume)。
    for (ts, c) in [
        (Utc.with_ymd_and_hms(2026, 8, 31, 1, 30, 0).unwrap(), 1.0),
        (Utc.with_ymd_and_hms(2026, 8, 31, 2, 0, 0).unwrap(), 2.0),
        (Utc.with_ymd_and_hms(2026, 9, 7, 1, 30, 0).unwrap(), 3.0),
    ] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') \
                     ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
            .bind(CODE_WM).bind(ts).bind(c)
            .execute(&pool).await.unwrap();
    }
    // 刷新 W1/MO1 cagg：refresh_continuous_aggregate 只物化**完全落在窗口内**的桶（含整桶起止），
    // 故窗口须从最早一周桶起点（08-30 16:00 UTC）之前到最晚一月桶终点之后（09 月桶=08-31 16:00→09-30 16:00 UTC）。
    for v in ["kline_accurate_1w", "kline_accurate_1mo"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2026-07-25 00:00:00+00', '2026-10-03 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    // 周线：两个交易周（周一为界）。第一周（2026-08-31）聚合两根 → open=first=1.0, close=last=2.0, vol=200。
    let weekly = r.bars(Period::W1, CODE_WM, None, 10).await.unwrap();
    assert_eq!(weekly.len(), 2, "W1：两个交易周");
    assert_eq!(weekly[0].open, 1.0, "W1 首周 open = first(open)");
    assert_eq!(weekly[0].close, 2.0, "W1 首周 close = last(close)");
    assert_eq!(weekly[0].volume, 200, "W1 首周 volume = sum(volume)");
    assert_eq!(weekly[1].open, 3.0, "W1 第二周单根");
    assert_eq!(weekly[1].close, 3.0);

    // 月线：8月（两根）+ 9月（一根）→ 两月。
    let monthly = r.bars(Period::MO1, CODE_WM, None, 10).await.unwrap();
    assert_eq!(monthly.len(), 2, "MO1：自然月（8月 + 9月）");
    assert_eq!(monthly[0].open, 1.0, "MO1 8月 open = first(open)");
    assert_eq!(monthly[0].close, 2.0, "MO1 8月 close = last(close)");
    assert_eq!(monthly[0].volume, 200, "MO1 8月 volume = sum(volume)");
    assert_eq!(monthly[1].open, 3.0, "MO1 9月单根");
    assert_eq!(monthly[1].close, 3.0);

    clean(&pool, CODE_WM).await;
}

#[tokio::test]
async fn unified_read_deep_history_to_2024() {
    // 修“往前翻几天就没数据”：所有周期能深翻历史。在 2024-01-01 与 2024-01-02 各种子一根 M1
    // （穿越 5m/15m/1h/1d 桶），before 游标从 2024-01-03 往回翻页应持续推进到 2024-01-01，无重复/缺口。
    let pool = pool().await;
    clean(&pool, CODE_DEEP).await;
    for (ts, c) in [
        (Utc.with_ymd_and_hms(2024, 1, 1, 1, 35, 0).unwrap(), 1.0),
        (Utc.with_ymd_and_hms(2024, 1, 2, 2, 0, 0).unwrap(), 2.0),
    ] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') \
                     ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close")
            .bind(CODE_DEEP).bind(ts).bind(c)
            .execute(&pool).await.unwrap();
    }
    // 刷新 accurate cagg（覆盖 2024 窗口：种子在 01-01/01-02。D1 用 Asia/Shanghai 日界，
    // 2024-01-01 交易日的桶 ts = 2023-12-31 16:00 UTC，故窗口须扩展到其前，否则该桶不被刷新）
    for v in ["kline_accurate_5m", "kline_accurate_15m", "kline_accurate_1h", "kline_accurate_1d"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2023-12-31 00:00:00+00', '2024-01-04 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    for p in [Period::M1, Period::M5, Period::M15, Period::H1, Period::D1] {
        // 翻页（limit=1）从 2024-01-03 往回：cursor 持续前进、无重复、至少覆盖两个 2024 数据点。
        let mut cursor = Utc.with_ymd_and_hms(2024, 1, 3, 0, 0, 0).unwrap();
        let mut got: Vec<DateTime<Utc>> = Vec::new();
        for _ in 0..3 {
            let page = r.bars(p, CODE_DEEP, Some(cursor), 1).await.unwrap();
            assert!(page.len() <= 1, "{p:?} 翻页每页 ≤1（limit=1）");
            if page.is_empty() { break; }
            let t = page[0].ts;
            assert!(t < cursor, "{p:?} before 不含该 ts 本身");
            got.push(t);
            cursor = t;
        }
        assert!(got.len() >= 2, "{p:?} 深翻应覆盖两个 2024 数据点，实际 {got:?}");
        assert!(got.windows(2).all(|w| w[0] > w[1]), "{p:?} 降序翻页 cursor 严格前进");
        let distinct: std::collections::HashSet<_> = got.iter().collect();
        assert_eq!(distinct.len(), got.len(), "{p:?} 无重复数据点");
    }
    clean(&pool, CODE_DEEP).await;
}

#[tokio::test]
async fn symbols_with_latest_snapshot() {
    let pool = pool().await;
    clean(&pool, CODE_SYM).await;
    clean(&pool, CODE_SYM_EMPTY).await;
    seed(&pool, CODE_SYM).await;
    for (c, n) in [(CODE_SYM, "测试ETF"), (CODE_SYM_EMPTY, "无数据ETF")] {
        sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, $2) \
                     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
            .bind(c).bind(n).execute(&pool).await.unwrap();
    }
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();

    let s = rows.iter().find(|r| r.code == CODE_SYM).expect("含测试标的");
    assert_eq!(s.name.as_deref(), Some("测试ETF"));
    assert_eq!(s.last_close, Some(5.0));
    assert_eq!(s.prev_close, Some(4.0), "前一根 bar 收盘（涨跌幅输入）");
    assert!(s.last_ts.is_some());

    let empty = rows.iter().find(|r| r.code == CODE_SYM_EMPTY).expect("含无数据标的");
    assert!(empty.last_ts.is_none() && empty.last_close.is_none() && empty.prev_close.is_none(),
        "无 bar 标的 latest 字段全空（前端 — 占位）");
    clean(&pool, CODE_SYM).await;
    clean(&pool, CODE_SYM_EMPTY).await;
}

#[tokio::test]
async fn window_events_filters_window_and_maps_fields() {
    const SRC: &str = "storage_test_events";
    let pool = pool().await;
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
    let now = Utc::now();
    let rows_in = [
        (now - Duration::seconds(20), true, Some(120), None, None),
        (now - Duration::seconds(10), false, None, Some("timeout"), Some("518880")),
        (now - Duration::hours(2), true, Some(50), None, None),   // 窗口外
    ];
    for (ts, ok, lat, err, code) in rows_in {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, latency_ms, err_kind, code) \
                     VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(ts).bind(SRC).bind(ok).bind(lat).bind(err).bind(code)
            .execute(&pool).await.unwrap();
    }
    let all = HealthEventReader::new(pool.clone()).window_events(3600).await.unwrap();
    let mine: Vec<_> = all.iter().filter(|r| r.source == SRC).collect();
    assert_eq!(mine.len(), 2, "窗口外事件不入选");
    assert!(mine[0].ts < mine[1].ts, "按 ts 升序");
    assert!(mine[0].ok && mine[0].latency_ms == Some(120) && mine[0].err_kind.is_none());
    assert!(!mine[1].ok && mine[1].err_kind.as_deref() == Some("timeout"));
    assert_eq!(mine[1].code.as_deref(), Some("518880"), "触发标的字段透传");
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
}

// ── Wave 2 Phase A：质量对照 / 节假日 / 事件区间 / 同步状态 / D3 merge 尾部优先级 ──

const CODE_QUAL: &str = "997731";
const CODE_LATEST: &str = "997741";

#[tokio::test]
async fn divergence_rows_join_code_filter_and_range() {
    let pool = pool().await;
    clean(&pool, CODE_QUAL).await;
    // raw 3 根（09:30-09:32 CST）；accurate 覆盖 09:30（close 不同）、09:31（相同）；09:32 无准确层
    for (i, c) in [(0i64, 10.10), (1, 10.0), (2, 10.0)] {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'webq_src') ON CONFLICT DO NOTHING")
            .bind(CODE_QUAL).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    for (i, c) in [(0i64, 10.0), (1, 10.0)] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0) ON CONFLICT DO NOTHING")
            .bind(CODE_QUAL).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());
    // code 过滤 + 仅重叠 ts（09:32 无准确层不入选）
    let rows = r.divergence_rows(Some(CODE_QUAL), base() - Duration::days(1),
        base() + Duration::days(1)).await.unwrap();
    let mine: Vec<_> = rows.iter().filter(|x| x.code == CODE_QUAL).collect();
    assert_eq!(mine.len(), 2, "raw ⋈ accurate 仅重叠 ts");
    assert!(mine[0].ts < mine[1].ts, "ts 升序");
    assert_eq!(mine[0].raw_close, 10.10);
    assert_eq!(mine[0].accurate_close, 10.0);
    assert_eq!(mine[0].raw_source.as_deref(), Some("webq_src"));
    // 区间 [from, to) 边界
    let narrow = r.divergence_rows(Some(CODE_QUAL), base() + Duration::minutes(1),
        base() + Duration::minutes(2)).await.unwrap();
    assert_eq!(narrow.len(), 1, "半开区间只含 09:31");
    // 无 code 过滤（source-accuracy 数据源）：至少含本测试行
    let all = r.divergence_rows(None, base() - Duration::days(1),
        base() + Duration::days(1)).await.unwrap();
    assert!(all.iter().any(|x| x.code == CODE_QUAL));
    clean(&pool, CODE_QUAL).await;
}

#[tokio::test]
async fn holidays_reader_reads_0008_seed() {
    let pool = pool().await;
    let h = HolidaysReader::new(pool).holidays().await.unwrap();
    assert!(h.contains(&NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()), "国庆在表");
    assert!(h.contains(&NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()), "元旦在表");
    assert!(h.len() >= 34, "2026 全量 34 行（迁移内嵌官方口径）");
}

#[tokio::test]
async fn events_between_and_sync_checkpoints() {
    const SRC: &str = "storage_test_range";
    let pool = pool().await;
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM sync_checkpoints WHERE code = $1")
        .bind(CODE_QUAL).execute(&pool).await.unwrap();
    let t0 = Utc.with_ymd_and_hms(2026, 9, 3, 2, 0, 0).unwrap();
    for (i, ok) in [(0i64, true), (1, false), (2, true)] {
        sqlx::query("INSERT INTO source_health_events (ts, source, ok, err_kind, code) \
                     VALUES ($1, $2, $3, $4, $5)")
            .bind(t0 + Duration::minutes(i)).bind(SRC).bind(ok)
            .bind(if ok { None } else { Some("timeout") }).bind(Some(CODE_QUAL))
            .execute(&pool).await.unwrap();
    }
    // [from, to) 半开区间 + ts 升序
    let evs = HealthEventReader::new(pool.clone())
        .events_between(t0, t0 + Duration::minutes(2)).await.unwrap();
    let mine: Vec<_> = evs.iter().filter(|e| e.source == SRC).collect();
    assert_eq!(mine.len(), 2, "[from, to) 不含 to 边界行");
    assert!(mine[0].ts < mine[1].ts);
    assert!(!mine[1].ok && mine[1].err_kind.as_deref() == Some("timeout"));

    sqlx::query("INSERT INTO sync_checkpoints (code, period, last_synced_date) \
                 VALUES ($1, 'M1', '2026-09-03') ON CONFLICT (code, period) \
                 DO UPDATE SET last_synced_date = EXCLUDED.last_synced_date")
        .bind(CODE_QUAL).execute(&pool).await.unwrap();
    let cps = KlineReader::new(pool.clone()).sync_checkpoints().await.unwrap();
    let cp = cps.iter().find(|c| c.code == CODE_QUAL).expect("含测试检查点");
    assert_eq!(cp.period, "M1");
    assert_eq!(cp.last_synced_date, NaiveDate::from_ymd_opt(2026, 9, 3).unwrap());
    sqlx::query("DELETE FROM source_health_events WHERE source = $1")
        .bind(SRC).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM sync_checkpoints WHERE code = $1")
        .bind(CODE_QUAL).execute(&pool).await.unwrap();
}

#[tokio::test]
async fn symbols_latest_d3_merge_tail_semantics() {
    // D3 重写语义锁定（merge 尾部 top-2）：
    // ① 准确层比 raw 更新 → 最新取准确层；② 同 ts 并列 → 准确层优先（merge 准确层优先语义）。
    let pool = pool().await;
    clean(&pool, CODE_LATEST).await;
    sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, 'D3测试') ON CONFLICT (code) DO NOTHING")
        .bind(CODE_LATEST).execute(&pool).await.unwrap();
    // raw：09:30(1.0)、09:31(2.0)；accurate：09:31 同 ts 覆盖(9.99) + 09:32 更新(8.88)
    for (i, c) in [(0i64, 1.0), (1, 2.0)] {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'webq_src') ON CONFLICT DO NOTHING")
            .bind(CODE_LATEST).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    for (i, c) in [(1i64, 9.99), (2, 8.88)] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0) ON CONFLICT DO NOTHING")
            .bind(CODE_LATEST).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();
    let s = rows.iter().find(|r| r.code == CODE_LATEST).expect("含测试标的");
    assert_eq!(s.last_ts, Some(base() + Duration::minutes(2)), "准确层更新的 ts 为最新");
    assert_eq!(s.last_close, Some(8.88));
    assert_eq!(s.prev_close, Some(9.99), "同 ts 并列准确层优先（raw 2.0 被掩盖）");
    clean(&pool, CODE_LATEST).await;
}

#[tokio::test]
async fn weekly_monthly_deep_scroll_before_2024() {
    // 修复问题①：W1/MO1 accurate cagg 全历史（0016 去掉 ts >= '2024-01-01' 过滤）。
    // 种子 pre-2024（2023）M1 → 周/月桶 <2024；refresh accurate cagg 后深翻应能翻到 <2024-01-01，
    // 且走 accurate（source='tushare'）而非兜底 kline_1d rollup（kline_1d 仅近 2 周数据，无 pre-2024 行）。
    // 〇 兜底保留：FALLBACK_1W/1MO 作为 accurate 缺失时的安全网（reader.rs 不删）；全历史 cagg 后 pre-2024
    //   也走 accurate，故本测试断言 source='tushare' 印证「pre-2024 走 accurate」。
    let pool = pool().await;
    clean(&pool, CODE_WM_DEEP).await;
    for (ts, c) in [
        (Utc.with_ymd_and_hms(2023, 1, 2, 1, 30, 0).unwrap(), 1.0),
        (Utc.with_ymd_and_hms(2023, 6, 5, 1, 30, 0).unwrap(), 2.0),
    ] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') \
                     ON CONFLICT (code, ts, period) DO UPDATE SET close = EXCLUDED.close, volume = EXCLUDED.volume")
            .bind(CODE_WM_DEEP).bind(ts).bind(c)
            .execute(&pool).await.unwrap();
    }
    // refresh W1/MO1 cagg 覆盖 2023 桶（整桶起止须落窗内；周桶=2023-01-01 16:00 UTC / 2023-06-04 16:00 UTC；
    // 月桶=2022-12-31 16:00 UTC（1月）/2023-05-31 16:00 UTC（6月）。放宽窗口覆盖全部）。
    for v in ["kline_accurate_1w", "kline_accurate_1mo"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2022-12-01 00:00:00+00', '2023-07-01 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    let r = KlineReader::new(pool.clone());

    let cutoff = Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap();
    let start = Utc.with_ymd_and_hms(2024, 1, 15, 0, 0, 0).unwrap();
    for p in [Period::W1, Period::MO1] {
        let mut cursor = start;
        let mut got: Vec<DateTime<Utc>> = Vec::new();
        for _ in 0..8 {
            let page = r.bars(p, CODE_WM_DEEP, Some(cursor), 1).await.unwrap();
            if page.is_empty() { break; }
            let b = &page[0];
            assert!(b.ts < cursor, "{p:?} before 不含该 ts 本身");
            assert_eq!(b.source.as_deref(), Some("tushare"), "{p:?} pre-2024 走 accurate cagg（0016 全历史）");
            got.push(b.ts);
            cursor = b.ts;
        }
        let before_cutoff = got.iter().filter(|t| **t < cutoff).count();
        assert!(before_cutoff >= 1, "{p:?} 深翻应覆盖 <2024-01-01 数据点，实际 {got:?}");
        assert!(got.windows(2).all(|w| w[0] > w[1]), "{p:?} 降序翻页 cursor 严格前进");
        let distinct: std::collections::HashSet<_> = got.iter().collect();
        assert_eq!(distinct.len(), got.len(), "{p:?} 无重复数据点");
    }
    clean(&pool, CODE_WM_DEEP).await;
}

#[tokio::test]
async fn high_period_forming_bucket_included_on_latest() {
    // 实时右缘：bars(None) 在日内周期合入「当前未闭合桶」（从最新 raw 聚合），而非停在上一闭合桶。
    // cagg(accurate/兜底) 只承载已闭合桶：5m 右缘落后至上一闭合桶（最多 ~5min）——本测试锁 forming 分支。
    const CODE_FORMING: &str = "997762";
    let pool = pool().await;
    clean(&pool, CODE_FORMING).await;
    // 从 DB now() 取当前 forming 5m 桶（避免测试进程与 DB 时钟偏移/跨桶竞态）。
    let row: (Option<DateTime<Utc>>,) = sqlx::query_as("SELECT time_bucket('5 minutes', now())")
        .fetch_one(&pool).await.unwrap();
    let fb = row.0.expect("forming 5m bucket");
    sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 10.0, 10.5, 9.9, 10.2, 300, 3000.0, 'webq_src') ON CONFLICT DO NOTHING")
        .bind(CODE_FORMING).bind(fb)
        .execute(&pool).await.unwrap();
    let r = KlineReader::new(pool.clone());
    let bars = r.bars(Period::M5, CODE_FORMING, None, 10).await.unwrap();
    let last = bars.last().expect("非空：forming 桶");
    assert_eq!(last.ts, fb, "M5 latest 含当前 forming 桶（右缘随 live 前进）");
    assert_eq!(last.open, 10.0);
    assert_eq!(last.high, 10.5);
    assert_eq!(last.low, 9.9);
    assert_eq!(last.close, 10.2);
    assert_eq!(last.volume, 300);
    assert!(last.source.is_none(), "forming 桶 source 与兜底同型（NULL，非 accurate）");
    // 游标分页（before=Some(fb)）不含 forming 桶（形成于 latest 私有分支，不回填到历史页）。
    let paged = r.bars(Period::M5, CODE_FORMING, Some(fb), 10).await.unwrap();
    assert!(paged.iter().all(|b| b.ts < fb), "before 游标不含 forming 桶");
    clean(&pool, CODE_FORMING).await;
}
// ~/~ end
