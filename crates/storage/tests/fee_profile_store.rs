//! `PgFeeProfileStore` 集成测试（ADR-019 / D11-2/D11-3；需迁移 0025 已 apply，TimescaleDB :5433）。
//!
//! 只读（不写任何库数据）：验证 symbols.type → fee_profiles 解析链与 fail-soft 语义。
//! 迁移幂等/回填/NULL 语义由 `symbol_type_fee_migration.rs` 在事务内锁定。

use domain::ports::FeeProfileStore;
use sqlx::PgPool;
use storage::fee_profile::PgFeeProfileStore;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

#[tokio::test]
async fn for_symbol_resolves_profile_by_type_and_misses_fail_soft() {
    let pool = pool().await;
    let store = PgFeeProfileStore::new(pool);

    // 已回填的 ETF 标的 → etf 档案（ADR-019 §1.1：全佣口径 → 经手费/证管费列 0；印花税 0；过户费 0）
    let etf = store.for_symbol("510050").await.unwrap().expect("510050 应解析到 etf 档案");
    assert_eq!(etf.type_, "etf");
    assert_eq!(etf.commission_rate_pct, 0.025);
    assert_eq!(etf.min_fee, 5.0);
    assert_eq!(etf.exchange_fee_pct, 0.0);
    assert_eq!(etf.regulatory_fee_pct, 0.0);
    assert_eq!(etf.stamp_duty_pct, 0.0, "ETF 印花税不征（D11 主目标）");
    assert_eq!(etf.transfer_fee_pct, 0.0);
    assert!(etf.note.contains("全佣"), "口径说明须写明全佣：{}", etf.note);
    assert!(etf.source.contains("ADR-019"), "来源字段须指 ADR-019：{}", etf.source);

    // LOF 标的 → lof 档案（同 §1.1 口径，独立成行）
    let lof = store.for_symbol("160723").await.unwrap().expect("160723 应解析到 lof 档案");
    assert_eq!(lof.type_, "lof");
    assert_eq!(lof.stamp_duty_pct, 0.0);
    assert_eq!(lof.exchange_fee_pct, 0.0);

    // 该标的类型与档案 type 一致性（解析链 = symbols.type JOIN fee_profiles.type）
    let lof2 = store.for_symbol("161226").await.unwrap().expect("161226 = lof");
    assert_eq!(lof2.type_, "lof");

    // fail-soft：未注册 code → None（调用方回退旧 ADR bt-1 默认，不报错）
    assert!(store.for_symbol("997999").await.unwrap().is_none(), "未注册 code → None");
    // type IS NULL / 该 type 无档案行 → 同为 None（SQL JOIN 语义；事务内用例见迁移测试）
    assert!(store.for_symbol("").await.unwrap().is_none(), "空 code → None");
}
