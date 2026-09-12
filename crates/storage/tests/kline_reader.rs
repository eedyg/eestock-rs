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
const CODE_SYM_D1: &str = "997771";  // 快照昨收（D1 兜底）专用：raw-only，accurate_1d 永不涉及（跨测试残留隔离）
const CODE_D1_YDAY: &str = "997772"; // 昨收语义：昨日 D1 + 今日 M1（动态相对 now()，见测试注释）
const CODE_D1_GAP: &str = "997773";  // 昨收语义：空档跳过（跨周末/节假日同型）
const CODE_D1_NEW: &str = "997775";  // 昨收语义：无 D1 历史 → NULL

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

/// cagg refresh 串行化锁：TimescaleDB 对同 cagg 重叠窗口的并发 refresh 报 55P03
/// （"due to a concurrent refresh"，实锤）。同 binary 测试并行执行，所有 refresh 调用须经此锁。
fn cagg_refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static L: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 刷新 D1 两 cagg（统一读源两侧：accurate + raw 兜底）覆盖 [from, to] UTC 窗口。
/// 窗口须含整桶（D1 桶 ts = 前一 UTC 日 16:00；refresh 只物化完全落入窗口的桶）。
/// 显式窗口 refresh 按当前源表行**重算**桶（自愈：clean 后残留桶被重算/清除），重跑确定。
async fn refresh_d1(pool: &PgPool, from: DateTime<Utc>, to: DateTime<Utc>) {
    let _g = cagg_refresh_lock().lock().await;
    for v in ["kline_accurate_1d", "kline_1d"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '{}', '{}')",
            from.format("%Y-%m-%d %H:%M:%S+00"), to.format("%Y-%m-%d %H:%M:%S+00")))
            .execute(pool).await.unwrap();
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
async fn merged_1m_branch_limit_merge_correctness() {
    // MERGED_1M_SQL 改为双侧各自 (code,ts) 索引 DESC LIMIT 后合并：语义与旧 kline_merged 视图等价。
    // 本测试用「准确层与 raw 交替、双侧行数 > limit」的种子，锁 per-branch LIMIT 合并正确性：
    // ① 准确层优先（同 ts）② raw 兜底（仅无准确层时）③ 无重复 ④ 升序 ⑤ limit 生效 ⑥ before 深翻。
    const CODE_BRANCH: &str = "997763";
    let pool = pool().await;
    clean(&pool, CODE_BRANCH).await;
    // accurate：偶数分钟 0..=24（13 根）；raw：奇数分钟 1..=25（13 根）——交替、无重叠 ts。
    for i in 0..26i64 {
        let ts = base() + Duration::minutes(i);
        if i % 2 == 0 {
            sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                         VALUES ($1, $2, 'M1', $3, $3, $3, $3, 200, 200.0, 'tushare') ON CONFLICT DO NOTHING")
                .bind(CODE_BRANCH).bind(ts).bind(100.0 + i as f64)
                .execute(&pool).await.unwrap();
        } else {
            sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                         VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'webq_src') ON CONFLICT DO NOTHING")
                .bind(CODE_BRANCH).bind(ts).bind(200.0 + i as f64)
                .execute(&pool).await.unwrap();
        }
    }
    let r = KlineReader::new(pool.clone());
    let bars = r.bars(Period::M1, CODE_BRANCH, None, 5).await.unwrap();
    // 总量 26 根（准确 13 + raw 13，无重叠）；limit=5 取最新 5 根 = ts 21..25，升序返回。
    assert_eq!(bars.len(), 5, "limit=5 生效，返回最新 5 根");
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "升序返回（图表口径）");
    let expected: Vec<(i64, f64, &str)> = vec![
        (21, 221.0, "webq_src"), // raw 奇数分钟
        (22, 122.0, "tushare"),  // accurate 偶数分钟
        (23, 223.0, "webq_src"),
        (24, 124.0, "tushare"),
        (25, 225.0, "webq_src"),
    ];
    for (b, (min, close, src)) in bars.iter().zip(&expected) {
        assert_eq!(b.ts, base() + Duration::minutes(*min), "ts 对齐");
        assert_eq!(b.close, *close, "close 对齐（准确层优先/raw 兜底）");
        assert_eq!(b.source.as_deref(), Some(*src),
            "source：raw 保留实际来源，accurate 层 = tushare");
        assert_eq!(b.volume, if *src == "tushare" { 200 } else { 100 }, "volume 按来源区分");
    }
    // before 深翻：before=24min 取下一页（limit=5）→ ts 19..23，降序翻页、无重复/缺口。
    let page = r.bars(Period::M1, CODE_BRANCH, Some(base() + Duration::minutes(24)), 5).await.unwrap();
    assert_eq!(page.len(), 5);
    assert!(page.iter().all(|b| b.ts < base() + Duration::minutes(24)), "before 不含该 ts 本身");
    let distinct: std::collections::HashSet<_> = page.iter().map(|b| b.ts).collect();
    assert_eq!(distinct.len(), page.len(), "深翻页内无重复数据点");
    clean(&pool, CODE_BRANCH).await;
}

/// 1m 读源**修复前** SQL 原文（ab470b2 前的 `MERGED_1M_SQL`：直查 `kline_merged` 视图 +
/// `ORDER BY ts DESC LIMIT`，无法下推到各分支 → 全量 Append（~77万行）+ top-N）。
/// **仅作性能自校准参考基线与语义等价对照**，不是生产路径；依赖 legacy `kline_merged` 视图
/// （ADR-003 旧实现）——若该视图退役，须同步替换参考基线（缺表会以错误红，不会静默放行）。
const PRE_FIX_1M_SQL: &str = r#"
SELECT code, ts, open, high, low, close, volume, amount, source
FROM kline_merged
WHERE code = $1 AND ($2::timestamptz IS NULL OR ts < $2)
ORDER BY ts DESC LIMIT $3
"#;

/// `PRE_FIX_1M_SQL` 行型（9 列，降序）：code/ts/open/high/low/close/volume/amount/source。
type PreFix1mRow = (String, DateTime<Utc>, f64, f64, f64, f64, i64, f64, Option<String>);

/// 执行 1m 修复前路径（参考基线），返回降序 500 行。
async fn pre_fix_1m_rows(pool: &PgPool, code: &str) -> Vec<PreFix1mRow> {
    sqlx::query_as::<_, PreFix1mRow>(PRE_FIX_1M_SQL)
        .bind(code)
        .bind(None::<DateTime<Utc>>)
        .bind(500i64)
        .fetch_all(pool)
        .await
        .expect("1m 修复前路径（参考基线）可用")
}

#[tokio::test]
async fn merged_1m_branch_index_limit_performance() {
    // 1m 读源性能门禁：**自校准**（判据与绝对墙钟阈值解耦，见下），2026-09-13 债务清理项 2。
    //
    // 背景：原判据为绝对墙钟 `dt.as_millis() < 500`。tester 014 全量回归中它偶发失败 1 次
    // （504ms vs 500ms，隔离重跑 3/3 绿：282/290/288ms）——绝对阈值随机器/负载/计划开销漂移，
    // 本质不稳。
    // 根因（本次实测）：该耗时含 **Postgres 计划开销**。SQL 引用 hypertable（~1000 chunk），
    // 单次 planning 实测 585–800ms，稳态执行仅 ~60–180ms；sqlx 复用已 prepare 的语句 + PG 数次
    // 执行后选定 generic plan ⇒ 稳态 60–390ms，但同 binary 其它测试的 cagg refresh / DELETE 会令
    // 计划缓存失效并退回 custom plan → 该次执行把「计划+执行」一起计 ~500ms ⇒ 与机器负载无关的假红。
    //
    // 判据（自校准，机器无关）：在**同一次运行内**测修复前路径（`PRE_FIX_1M_SQL`）作参考，要求
    //     比值 = min5(目标) / min5(参考) < 0.25      —— 目标须比修复前路径快 ≥4×
    // 系数依据（实测分布）：
    //   • 探针期（`coder/evidence/151_debt_cleanup/03_perf_ratio_probe_and_mutation.txt`，11 次运行
    //     × 各 5 样本，含 3 次并发压测）：min(目标)/min(参考) ∈ [0.052, 0.069]，最坏
    //     max(目标)/min(参考) = 0.342（该最坏值来自 min-of-1 的瞬时样本，min-of-5 估计量已消除）。
    //   • min-of-5 终稿稳态（`09_perf_min5_20runs.txt` + tester 018 §4.2）：比值 min 0.030 / max 0.063
    //     / mean 0.055；诱导负载（load1 1.6→9.6）4 次：0.051–0.075。
    // **2026-09-13 tester 018 独立验收 R-A：阈值 0.6 → 0.25（收紧）**。
    //   原 0.6 相对稳态比值 0.055 留 ~10.9× 余量 ⇒ 目标侧劣化到 ~5×（仍未退回全量合并）都不触发，
    //   门禁过松；0.25（=要求 ≥4×）相对最坏实测 0.075 仍留 **≥3.3×** 余量，满足"保留 ≥3× 余量"。
    //   收紧后复验（`coder/evidence/151_debt_cleanup/15_rA_20runs_ratio_dist.txt`）：连跑 20 次全绿，
    //     比值 min 0.054 / max 0.060 / mean 0.056（目标 min5 60–66ms、参考 min5 1085–1123ms），
    //     最坏余量 0.25/0.060 = **4.17×**（满足"保留 ≥3× 余量"，最坏值含 tester 018 诱导负载的 0.075
    //     ⇒ 余量 3.3×）；
    //   突变实验（`16_rA_mutation_and_rB_redgreen.txt`）：修复前路径冒充目标 ⇒ 比值 1.014 ⇒ 必红
    //     （判据非空）；同批对照真实路径 0.055 ⇒ 非恒红。
    //   仅用比值、**不**叠加绝对墙钟上限：绝对阈值正是本测试被根治的假红来源（tester 014 的 504ms
    //   假红）；比值判据的设计性质是机器快慢/缓存冷热/并行负载在两侧同向抵消，故更慢的 CI 机上
    //   比值基本不变（实测：load1 1.6→9.6 时比值仅 0.055→0.075），叠加绝对上限会把旧假红重新引入。
    //   相对判据的关键性质：机器快慢、缓存冷热、并行负载在两侧同向抵消。
    //
    // 失效场景（本判据会红的情形，仅两种，皆真回归）：
    //   ① 1m 读源退回「全量 Append + top-N」（如分支级 DESC LIMIT 被绕过）→ 目标 ≈ 参考
    //      （突变实验：以修复前路径冒充目标，实测比值 0.983 / 1.021 / 1.275）⇒ 比值 ≫0.25，红；
    //   ② 该路径整体慢 ≥4×（含计划开销）⇒ 红。**不再**因单次计划抖动/机器负载而红。
    // 功能覆盖（≥ 原断言）：①500 根、严格升序（隐含无重复）；②**语义等价**：与修复前路径同参结果
    //   逐根比对 ts/open/high/low/close/volume/amount/source——锁定「双侧索引 DESC LIMIT 合并」与
    //   旧全量合并同口径（原断言只检长度/升序，此为加强项）。
    //
    // 前置（**R-B，2026-09-13 tester 018 独立验收：前置不足必须响亮失败**）：本测试要求 518880 至少
    //   有 500 根 M1（真实库该 code 全量 769,513 行 M1，只读）。**旧写法** `if w.len() != 500 {
    //   eprintln!("[bench-skip]…"); return; }` 会在数据前提被破坏时**静默 PASS**（vacuous pass）——
    //   门禁报绿却根本没测量，与本项目已反复消灭的"静默失真/假绿"（I-1、门禁假绿 F3）同属一类。
    //   **不得恢复"静默 return 通过"的写法**：换成改名/`#[ignore]`/"打印后 return"均不接受——
    //   skip 语义下门禁同样没有测量，而 `#[ignore]` 默认不执行 ⇒ 仍是无声假绿。
    //   选**方案 (a)：直接 panic**。理由：数据前提是只读查询即可核实的客观事实，不满足只可能来自
    //   换库/数据被删/连接到了错库；此时唯一正确的行为是**让门禁红**并要求人介入，而不是让门禁在
    //   "没测量"的情况下报绿。若将来要在小库上跑本门禁，应在 CI 层显式换 code 或显式排除整条测试
    //   （留下可见记录），而不是让断言静默退化。
    let pool = pool().await;
    let r = KlineReader::new(pool.clone());
    let real_code = "518880"; // 真实全量 M1 code（77万+ 行），只读不改。
    // 预热 8 次：① 命中 sqlx 语句缓存 ② 让 Postgres 选定 generic plan
    // （hypertable 上千 chunk 子计划，单次计划 ~600ms 不属稳态）。
    for _ in 0..8 {
        let w = r.bars(Period::M1, real_code, None, 500).await.unwrap();
        if w.len() != 500 {
            panic!("数据前提不满足（期望 500 根 M1，实得 {} 根）→ 门禁无法测量：{real_code} 的 M1 \
                    数据缺失或不足。本测试不得静默通过（vacuous pass = 假绿），请修复数据或显式另择 code。",
                w.len());
        }
    }
    // 目标（生产路径）：5 次取 min（R5 加固①；对含 planning 的负载敏感侧多取样本，压低最小值噪声）。
    let mut t_target = f64::INFINITY;
    let mut bars = Vec::new();
    for _ in 0..5 {
        let t = std::time::Instant::now();
        bars = r.bars(Period::M1, real_code, None, 500).await.unwrap();
        t_target = t_target.min(t.elapsed().as_secs_f64() * 1000.0);
    }
    // 参考（修复前路径）：预热 2 次越过头次冷启动（头次 1.5–2.8s），随后 5 次取 min（稳态 ~1.1–1.5s）。
    // 样本数与目标侧相同（对称）；参考侧以 cached plan 执行主，对负载不如目标侧敏感，故其 min 被
    // 多取样本压低的幅度远小于目标侧 —— 对称取样净效果是拉大比值余量（实测见 09 号证据）。
    let mut old_rows = pre_fix_1m_rows(&pool, real_code).await;
    for _ in 0..2 {
        old_rows = pre_fix_1m_rows(&pool, real_code).await;
    }
    let mut t_ref = f64::INFINITY;
    for _ in 0..5 {
        let t = std::time::Instant::now();
        old_rows = pre_fix_1m_rows(&pool, real_code).await;
        t_ref = t_ref.min(t.elapsed().as_secs_f64() * 1000.0);
    }

    // 功能断言①：形状（500 根、严格升序 ⇒ 无重复）。
    assert_eq!(bars.len(), 500, "1m 500 bars");
    assert!(bars.windows(2).all(|w| w[0].ts < w[1].ts), "升序返回（图表口径）");
    // 功能断言②：语义等价（参考为降序，反序对齐逐根比对）。
    assert_eq!(old_rows.len(), bars.len(), "参考路径同为 500 根");
    for (b, o) in bars.iter().zip(old_rows.iter().rev()) {
        assert_eq!(b.ts, o.1, "ts 对齐（升序口径）");
        assert_eq!(b.open, o.2, "open 与修复前路径一致");
        assert_eq!(b.high, o.3, "high 与修复前路径一致");
        assert_eq!(b.low, o.4, "low 与修复前路径一致");
        assert_eq!(b.close, o.5, "close 与修复前路径一致");
        assert_eq!(b.volume, o.6, "volume 与修复前路径一致");
        assert_eq!(b.amount, o.7, "amount 与修复前路径一致");
        assert_eq!(b.source, o.8, "source 与修复前路径一致（raw 保留实际来源，accurate 记 tushare）");
    }
    // 性能断言：自校准相对判据（见函数头注释；tester 018 R-A：阈值 0.6 → 0.25 = 要求 ≥4×）。
    let ratio = t_target / t_ref;
    assert!(ratio < 0.25,
        "1m 500 bars 应比修复前路径（kline_merged 全量合并）快 ≥4×：目标 min5={t_target:.0}ms、\
         参考 min5={t_ref:.0}ms（比值 {ratio:.3}，判据 <0.25）。失败通常意味着分支级索引 DESC LIMIT \
         被绕过（退回全量 Append + top-N），或目标路径劣化 ≥4×");
    eprintln!("[bench] 自校准 1m 500 bars：目标 min5={t_target:.0}ms vs 修复前路径 min5={t_ref:.0}ms\
         （比值 {ratio:.3}，判据 <0.25）");
}

#[tokio::test]
async fn merged_periods_accurate_first_and_1h_rollup() {
    let pool = pool().await;
    clean(&pool, CODE_CAGG).await;
    seed(&pool, CODE_CAGG).await;
    // 统一读源：所有周期读 merged（accurate 优先）。refres：accurate cagg（窗口覆盖 base() 数据
    // + D1 桶对齐）与 raw-derived cagg（兜底）。窗口 [09-02, 09-04] UTC 覆盖 base()=09-03 01:30 UTC
    // 的 M1 种子（01:30-01:34 UTC）与 D1 桶 ts（09-02 16:00 UTC）。
    let _g = cagg_refresh_lock().lock().await;
    for v in ["kline_accurate_5m", "kline_accurate_15m", "kline_accurate_1h", "kline_accurate_1d",
              "kline_5m", "kline_15m", "kline_1d"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2026-09-02 00:00:00+00', '2026-09-04 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    drop(_g);
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
    let _g = cagg_refresh_lock().lock().await;
    for v in ["kline_accurate_1w", "kline_accurate_1mo"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2026-07-25 00:00:00+00', '2026-10-03 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    drop(_g);
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
    let _g = cagg_refresh_lock().lock().await;
    for v in ["kline_accurate_5m", "kline_accurate_15m", "kline_accurate_1h", "kline_accurate_1d"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2023-12-31 00:00:00+00', '2024-01-04 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    drop(_g);
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
    clean(&pool, CODE_SYM_D1).await;
    seed(&pool, CODE_SYM).await;
    // 昨收专用码：raw-only 两根（收 4.0/5.0，base() 日）。不用 seed()（其 accurate 行会被其他测试的
    // accurate_1d 窗口 refresh 物化，跨测试时序使 prev_close 在 5.0/9.99 间漂移——实锤残留见 coder/report）。
    for (i, c) in [(0i64, 4.0), (1, 5.0)] {
        sqlx::query("INSERT INTO kline_raw (code, ts, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, $3, $3, $3, $3, 100, 100.0, 'tencent_ifzq') ON CONFLICT DO NOTHING")
            .bind(CODE_SYM_D1).bind(base() + Duration::minutes(i)).bind(c)
            .execute(&pool).await.unwrap();
    }
    for (c, n) in [(CODE_SYM, "测试ETF"), (CODE_SYM_EMPTY, "无数据ETF"), (CODE_SYM_D1, "昨收ETF")] {
        sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, $2) \
                     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
            .bind(c).bind(n).execute(&pool).await.unwrap();
    }
    // 涨跌幅语义（2026-09-11 修复）：prev_close = 最近一个早于当前交易日（Asia/Shanghai 日界）的 D1 收盘
    // （昨收），非上一根 M1。物化 D1 cagg（窗口含 base()=2026-09-03 日桶；假定运行日晚于该日，
    // 否则日桶被日界排除 prev_close=NULL）。
    refresh_d1(&pool, Utc.with_ymd_and_hms(2026, 9, 2, 0, 0, 0).unwrap(),
                   Utc.with_ymd_and_hms(2026, 9, 4, 0, 0, 0).unwrap()).await;
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();

    let s = rows.iter().find(|r| r.code == CODE_SYM).expect("含测试标的");
    assert_eq!(s.name.as_deref(), Some("测试ETF"));
    assert_eq!(s.last_close, Some(5.0));
    assert!(s.last_ts.is_some());
    // CODE_SYM 的 prev_close 不断言：其 accurate 行可能被其他测试的 accurate_1d 窗口 refresh 物化
    // （优先级高于 raw 兜底），取值依赖并行时序；D1 昨收语义由 CODE_SYM_D1 / 专用测试锁定。

    let d1 = rows.iter().find(|r| r.code == CODE_SYM_D1).expect("含昨收标的");
    assert_eq!(d1.last_close, Some(5.0));
    assert_eq!(d1.prev_close, Some(5.0),
        "昨收=前一交易日 D1 收盘（kline_1d 兜底物化；当日最后 raw bar 收 5.0），非上一根 M1（4.0）");

    let empty = rows.iter().find(|r| r.code == CODE_SYM_EMPTY).expect("含无数据标的");
    assert!(empty.last_ts.is_none() && empty.last_close.is_none() && empty.prev_close.is_none(),
        "无 bar 标的 latest 字段全空（前端 — 占位）");
    clean(&pool, CODE_SYM).await;
    clean(&pool, CODE_SYM_EMPTY).await;
    clean(&pool, CODE_SYM_D1).await;
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
    // D3 重写语义锁定（merge 尾部 last）：
    // ① 准确层比 raw 更新 → 最新取准确层；② 同 ts 并列 → 准确层优先（merge 准确层优先语义）。
    // 涨跌幅语义修复（2026-09-11）：prev_close = 前一交易日 D1 收盘（昨收），同为 accurate 优先 + raw 兜底。
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
    // 物化 D1 两 cagg（窗口含 base() 日桶；假定运行日晚于 2026-09-03）：
    // accurate D1 收 = 当日最后 accurate M1 = 8.88；raw D1 收 = 2.0 → 昨收取 accurate 8.88（优先语义）。
    refresh_d1(&pool, Utc.with_ymd_and_hms(2026, 9, 2, 0, 0, 0).unwrap(),
                   Utc.with_ymd_and_hms(2026, 9, 4, 0, 0, 0).unwrap()).await;
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();
    let s = rows.iter().find(|r| r.code == CODE_LATEST).expect("含测试标的");
    assert_eq!(s.last_ts, Some(base() + Duration::minutes(2)), "准确层更新的 ts 为最新");
    assert_eq!(s.last_close, Some(8.88));
    assert_eq!(s.prev_close, Some(8.88),
        "昨收=前一交易日 D1 收盘；同 ts accurate(8.88) 优先于 raw 兜底(2.0)");
    clean(&pool, CODE_LATEST).await;
}

#[tokio::test]
async fn symbols_latest_prev_close_is_prev_trading_day_d1() {
    // 涨跌幅语义修复（2026-09-11）主测试：prev_close = 最近一个**早于当前交易日**（Asia/Shanghai 日界）
    // 的 D1 收盘。SQL 边界基于 now()，故种子相对运行时刻动态构造（cagg 残留桶由显式窗口 refresh 重算，
    // 重跑确定；各日桶收盘恒定）。
    let pool = pool().await;
    for c in [CODE_D1_YDAY, CODE_D1_GAP, CODE_D1_NEW] {
        clean(&pool, c).await;
        sqlx::query("INSERT INTO symbols (code, name) VALUES ($1, 'D1昨收测试') ON CONFLICT (code) DO NOTHING")
            .bind(c).execute(&pool).await.unwrap();
    }
    // Asia/Shanghai 日界（与 reader TODAY_STATS_SQL / domain::tz 同口径）
    let today_cst = domain::tz::utc_to_cst(Utc::now()).date();
    let today0 = domain::tz::cst_to_utc(today_cst.and_hms_opt(0, 0, 0).expect("valid hms"));
    let y0 = today0 - Duration::days(1);
    // YDAY：昨日 accurate M1 两根（收 7.60/7.77 → 昨日 D1 收 7.77）+ 今日 accurate M1（8.88）。
    // 今日桶被日界排除（跨夜场景：日界后 prev 才换到今日收盘）→ prev_close=7.77；last=最新 8.88。
    for (day0, min, close) in [(y0, 30i64, 7.60), (y0, 31, 7.77), (today0, 30, 8.88)] {
        sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                     VALUES ($1, $2, 'M1', $3, $3, $3, $3, 100, 100.0, 'tushare') ON CONFLICT DO NOTHING")
            .bind(CODE_D1_YDAY).bind(day0 + Duration::minutes(min)).bind(close)
            .execute(&pool).await.unwrap();
    }
    // GAP：仅 4 天前 accurate M1（收 6.66），此后无 bar —— 空档跳过（周一取上周五收盘同型）。
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, $2, 'M1', 6.66, 6.66, 6.66, 6.66, 100, 100.0, 'tushare') ON CONFLICT DO NOTHING")
        .bind(CODE_D1_GAP).bind(y0 - Duration::days(3) + Duration::minutes(30))
        .execute(&pool).await.unwrap();
    // NEW：仅 accurate M1（固定日 2026-08-20 09:30 CST，收 3.33）；两 D1 cagg 均无其桶
    // （本测试 refresh 窗口不覆盖该日；D1 cagg 自动策略仅近 3 天）→ 无 D1 历史 → prev_close NULL。
    sqlx::query("INSERT INTO kline_accurate (code, ts, period, open, high, low, close, volume, amount, source) \
                 VALUES ($1, '2026-08-20 01:30:00+00', 'M1', 3.33, 3.33, 3.33, 3.33, 100, 100.0, 'tushare') \
                 ON CONFLICT DO NOTHING")
        .bind(CODE_D1_NEW).execute(&pool).await.unwrap();
    // 物化 D1 桶：窗口含 4 天前/昨日/今日桶（D1 桶 ts=前一 UTC 日 16:00，前后各留 1 天余量）。
    refresh_d1(&pool, y0 - Duration::days(5), today0 + Duration::days(1)).await;
    let rows = KlineReader::new(pool.clone()).symbols_with_latest().await.unwrap();

    let yday = rows.iter().find(|r| r.code == CODE_D1_YDAY).expect("含 YDAY 标的");
    assert_eq!(yday.last_close, Some(8.88), "last=最新 M1（今日 accurate）");
    assert_eq!(yday.prev_close, Some(7.77),
        "昨收=昨日 D1 收盘；当日 forming 桶（8.88）被 Asia/Shanghai 日界排除");

    let gap = rows.iter().find(|r| r.code == CODE_D1_GAP).expect("含 GAP 标的");
    assert_eq!(gap.prev_close, Some(6.66), "空档跳过：最近非空 D1 即昨收（跨周末/节假日同型）");

    let new = rows.iter().find(|r| r.code == CODE_D1_NEW).expect("含 NEW 标的");
    assert_eq!(new.last_close, Some(3.33));
    assert!(new.prev_close.is_none(), "无 D1 历史的新标的 → prev_close NULL（前端 --）");

    for c in [CODE_D1_YDAY, CODE_D1_GAP, CODE_D1_NEW] { clean(&pool, c).await; }
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
    let _g = cagg_refresh_lock().lock().await;
    for v in ["kline_accurate_1w", "kline_accurate_1mo"] {
        sqlx::query(&format!(
            "CALL refresh_continuous_aggregate('{v}', '2022-12-01 00:00:00+00', '2023-07-01 00:00:00+00')"))
            .execute(&pool).await.unwrap();
    }
    drop(_g);
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
