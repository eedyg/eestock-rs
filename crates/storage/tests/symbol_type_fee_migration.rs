//! D11（ADR-019）迁移 0025 集成测试：**幂等**（重复执行安全）+ **向后兼容**（type 缺省 NULL、
//! 不静默错判）+ 费率档案播种事实核对（ADR-019 §1）+ 44 只标的回填（D11-4 显式清单）核对。
//!
//! **全程在单个事务内执行并 ROLLBACK**：DDL 在 PostgreSQL 中可回滚（TimescaleDB 仅
//! hypertable/cagg 例外，本迁移不涉及）→ 不向生产库落任何数据（任务纪律：除测试事务外只读）。
//!
//! 并行安全：断言只用「迁移自带的 44 码清单」（从迁移原文解析）+ 抽样硬编码期望，
//! 不做全表计数（其他测试 binary 会并发插入 99xxxx 冒烟标的）。

use sqlx::{Acquire, Executor, PgPool, Row};

/// 迁移原文（直读交付文件——被测的就是将要在生产执行的那份字节）。
const MIGRATION: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../migrations/0025_symbol_type_fee_profiles.sql"
));

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

/// 迁移回填清单（解析迁移原文里的 `('code','type')` 值对）= D11-4 交付清单本身。
fn backfill_pairs() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in MIGRATION.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("('") else { continue };
        let Some((code, tail)) = rest.split_once("','") else { continue };
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) { continue; }
        let Some((ty, _)) = tail.split_once("')") else { continue };
        out.push((code.to_string(), ty.to_string()));
    }
    out
}

#[tokio::test]
async fn migration_0025_idempotent_backfill_and_seed_in_rolled_back_tx() {
    let pool = pool().await;
    let mut conn = pool.acquire().await.unwrap();
    let mut tx = conn.begin().await.unwrap();

    // ── ①/② 首次执行 + 重复执行（幂等：不报错）────────────────────────────
    tx.execute(MIGRATION).await.expect("首次执行 0025 应成功");
    tx.execute(MIGRATION)
        .await
        .expect("重复执行 0025 必须幂等（ADD COLUMN IF NOT EXISTS / DO 块判存在 / CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING）");

    // ── ③ symbols.type：可空 + 无默认值（裁决 A2：不得静默错判）─────────────
    let row = sqlx::query(
        "SELECT is_nullable, column_default FROM information_schema.columns \
         WHERE table_name = 'symbols' AND column_name = 'type'",
    )
    .fetch_one(&mut *tx)
    .await
    .expect("symbols.type 列应存在");
    let nullable: String = row.get("is_nullable");
    let default: Option<String> = row.get("column_default");
    assert_eq!(nullable, "YES", "type 必须可空（NULL = 未知）");
    assert!(
        default.is_none(),
        "type 不得有默认值（裁决 A2：任何具体类型默认都会静默错判另一类标的），got {default:?}"
    );

    // 未设 type 的新标的：缺省即 NULL（不静默借用类型）
    sqlx::query(
        "INSERT INTO symbols (code, interval_secs, settlement) VALUES ('997993', 60, 'T1') \
         ON CONFLICT (code) DO NOTHING",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let fresh: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = '997993'")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert!(fresh.is_none(), "新注册标的 type 缺省应为 NULL（未知），got {fresh:?}");

    // CHECK 约束存在且拒绝枚举外取值（SAVEPOINT：失败语句会 abort 事务，须隔离后继续）
    {
        let mut sp = tx.begin().await.unwrap();
        let bad = sqlx::query(
            "INSERT INTO symbols (code, interval_secs, settlement, type) \
             VALUES ('997994', 60, 'T1', 'bogus')",
        )
        .execute(&mut *sp)
        .await;
        assert!(bad.is_err(), "symbols_type_check 应拒绝枚举外类型");
        sp.rollback().await.unwrap();
    }
    let reserved_ok = sqlx::query(
        "INSERT INTO symbols (code, interval_secs, settlement, type) VALUES ('997995', 60, 'T1', 'bond_etf') \
         ON CONFLICT (code) DO NOTHING",
    )
    .execute(&mut *tx)
    .await;
    assert!(reserved_ok.is_ok(), "D11-6 保留位（bond_etf/money_etf/index）应在枚举内可通过");

    // ── ④ D11-4 回填清单：44 只、42 etf / 2 lof / 0 stock，逐码生效 ──────────
    let pairs = backfill_pairs();
    assert_eq!(pairs.len(), 44, "回填清单应为 44 只（44/44 全覆盖）");
    let n_etf = pairs.iter().filter(|(_, t)| t == "etf").count();
    let n_lof = pairs.iter().filter(|(_, t)| t == "lof").count();
    let n_stock = pairs.iter().filter(|(_, t)| t == "stock").count();
    assert_eq!((n_etf, n_lof, n_stock), (42, 2, 0), "D11-4 清单口径：42 etf / 2 lof / 0 stock");

    // 抽样硬编码期望（防「清单整体写错但自洽」）
    for (code, want) in [
        ("510050", "etf"),
        ("588000", "etf"),
        ("551000", "etf"), // 名称缺失但经第二来源确认为债券型 ETF（分类清单 §4）
        ("160723", "lof"),
        ("161226", "lof"),
    ] {
        let got: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
            .bind(code)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(got.as_deref(), Some(want), "{code} 回填类型应为 {want}");
    }
    // 清单内每一码在库中的 type 与清单一致（如实为「既有 44 只」）
    for (code, want) in &pairs {
        let got: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = $1")
            .bind(code)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(got.as_deref(), Some(want.as_str()), "{code} 回填类型与清单不一致");
    }

    // ── ⑤ fee_profiles 播种（ADR-019 §1 事实；D11-2）───────────────────────
    type ProfileRow = (String, f64, f64, f64, f64, f64, f64, String, String);
    let rows: Vec<ProfileRow> = sqlx::query_as(
        "SELECT type, commission_rate_pct, min_fee, exchange_fee_pct, regulatory_fee_pct, \
                stamp_duty_pct, transfer_fee_pct, note, source FROM fee_profiles ORDER BY type",
    )
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    let types: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(types, vec!["etf", "lof", "stock"], "本批只播种 etf/lof/stock 三行（保留位不播种）");

    let (etf, lof, stock) = (&rows[0], &rows[1], &rows[2]);
    // 场内基金（ETF/LOF）：印花税不征=0、过户费=0、经手费/证管费按全佣口径列 0
    for (name, r) in [("etf", etf), ("lof", lof)] {
        assert_eq!(
            (r.1, r.2, r.3, r.4, r.5, r.6),
            (0.025, 5.0, 0.0, 0.0, 0.0, 0.0),
            "{name} 行费率事实（ADR-019 §1.1：全佣口径 → 经手费/证管费列 0）"
        );
    }
    assert_eq!(lof.1, etf.1, "lof 行与 etf 行同事实值（独立成行仅为审计可读）");
    assert_eq!(lof.5, etf.5, "lof 印花税同样为 0");
    assert!(etf.7.contains("全佣") && etf.7.contains("不征"), "etf note 须写明全佣口径与印花税不征");
    assert!(etf.8.contains("ADR-019"), "etf source 须指 ADR-019（D11-2 来源字段）");
    // A股：事实费率（印花税卖出 0.5‰、过户费 0.01‰、经手费 0.0341‰、证管费 0.02‰）
    assert_eq!(
        (stock.1, stock.2, stock.3, stock.4, stock.5, stock.6),
        (0.025, 5.0, 0.00341, 0.002, 0.05, 0.001),
        "stock 行费率事实（ADR-019 §1.2）"
    );
    assert!(stock.7.contains("D11-follow-up"), "stock note 须登记引擎未建模规费的债务");
    // 保留位（D11-6）本批不播种
    for reserved in ["bond_etf", "money_etf", "index"] {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM fee_profiles WHERE type = $1")
            .bind(reserved)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(n, 0, "D11-6 保留位 {reserved} 本批不播种");
    }

    // ── ⑥ 无档案/未注册 → 查表返回空（调用方回退旧默认，fail-soft）──────────
    let store_sql = "SELECT p.type FROM symbols s JOIN fee_profiles p ON p.type = s.type WHERE s.code = $1";
    let hit: Option<String> = sqlx::query_scalar(store_sql)
        .bind("510050")
        .fetch_optional(&mut *tx)
        .await
        .unwrap();
    assert_eq!(hit.as_deref(), Some("etf"), "已注册 etf 标的应解析到 etf 档案");
    for code in ["997993", "551000"] {
        // 997993 = type NULL（未知）；551000 为已回填 etf（对照项，非空）
        let got: Option<String> = sqlx::query_scalar(store_sql)
            .bind(code)
            .fetch_optional(&mut *tx)
            .await
            .unwrap();
        if code == "997993" {
            assert!(got.is_none(), "type IS NULL → 无档案行（不静默借用他类型）");
        } else {
            assert_eq!(got.as_deref(), Some("etf"));
        }
    }
    let missing: Option<String> = sqlx::query_scalar(store_sql)
        .bind("997999")
        .fetch_optional(&mut *tx)
        .await
        .unwrap();
    assert!(missing.is_none(), "未注册 code → 无档案行");

    // ── ⑦ 幂等语义：重复执行不覆盖运营侧人工维护值；NULL 可被再次回填 ────────
    sqlx::query("UPDATE fee_profiles SET min_fee = 0.5 WHERE type = 'etf'")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE symbols SET type = 'stock' WHERE code = '510050'")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE symbols SET type = NULL WHERE code = '588000'")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.execute(MIGRATION).await.expect("第三/四次执行仍须幂等");

    let min_fee: f64 = sqlx::query_scalar("SELECT min_fee FROM fee_profiles WHERE type = 'etf'")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(min_fee, 0.5, "ON CONFLICT DO NOTHING 不覆盖运营侧调参");
    let kept: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = '510050'")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(kept.as_deref(), Some("stock"), "回填仅填 NULL → 不覆盖人工维护值");
    let refilled: Option<String> = sqlx::query_scalar("SELECT type FROM symbols WHERE code = '588000'")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(refilled.as_deref(), Some("etf"), "NULL 可被回填补齐");

    tx.rollback().await.expect("回滚（不得污染生产库）");
}
