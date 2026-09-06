//! 看板收藏（FavoriteStore）集成测试（需 TimescaleDB :5433，含 0013 迁移）。
//! 非 tangle 手写（契约描述见 design/04-storage/schema.md §4.3.6）。
//! 覆盖：star 自动置顶（max+1）/ 幂等、unstar 幂等、list_favorites 升序、
//! reorder 批量重排（sort_order=索引）、favorite_map（非收藏不在 map）、FK 级联。
//! ⚠️ 并行踩坑：同 binary 测试并行执行，共享清理会互删——每测试用独立 code 集（symbol_admin.rs 同口径）。

use domain::ports::FavoriteStore;
use sqlx::PgPool;
use storage::favorite::PgFavoriteStore;

const A: &str = "996821";
const B: &str = "996822";
const C: &str = "996823";
// 独立 code 集（每测试一组，避免并行 clean 互删）
const A2: &str = "996824";
const B2: &str = "996825";
const C2: &str = "996826";
const X: &str = "996827";
const Y: &str = "996828";
const Z: &str = "996829";
// 级联删除测试独立 code（避免与其他并行测试共享）
const CASC: &str = "996830";
// star_and_unstar_unknown 专属 code（避免与 favorite_map 的 X/Y/Z 并行互删）
const UNK: &str = "996820";

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://eestock:eestock@127.0.0.1:5433/eestock".into());
    PgPool::connect(&url).await.expect("TimescaleDB :5433 可用")
}

async fn clean(pool: &PgPool, codes: &[&str]) {
    for c in codes {
        sqlx::query("DELETE FROM favorite_symbols WHERE code = $1").bind(c).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM symbols WHERE code = $1").bind(c).execute(pool).await.unwrap();
    }
}

async fn seed_symbols(pool: &PgPool, codes: &[&str]) {
    for (i, c) in codes.iter().enumerate() {
        sqlx::query("INSERT INTO symbols (code, name, interval_secs, settlement, enabled) \
                     VALUES ($1, $2, 60, 'T1', true) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name")
            .bind(c).bind(format!("测试标的{i}"))
            .execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn star_autotop_then_idempotent_unstar() {
    let pool = pool().await;
    clean(&pool, &[A, B, C]).await;
    seed_symbols(&pool, &[A, B, C]).await;
    let store = PgFavoriteStore::new(pool.clone());

    // 首收藏（自动置顶）；sort_order 为全局 max+1（表内可能存在其他测试残留行，不对绝对值断言）。
    store.star(A).await.unwrap();
    store.star(B).await.unwrap();

    let list = store.list_favorites().await.unwrap();
    let mine: Vec<_> = list.iter().filter(|f| [A, B, C].contains(&f.code.as_str())).collect();
    assert_eq!(mine.len(), 2);
    assert_eq!(mine[0].code, A, "A 先收藏 → sort 靠前");
    assert_eq!(mine[1].code, B, "B 后收藏 → 自动置顶（sort 更大）");
    assert!(mine[0].sort_order < mine[1].sort_order, "递增置顶：B.sort > A.sort");

    // star 幂等：重复收藏不新增行、不改变 sort_order
    store.star(A).await.unwrap();
    let list2 = store.list_favorites().await.unwrap();
    let mine2: Vec<_> = list2.iter().filter(|f| [A, B, C].contains(&f.code.as_str())).collect();
    assert_eq!(mine2.len(), 2, "幂等：不重复插入");
    assert_eq!(mine2[0].sort_order, mine[0].sort_order, "幂等：sort_order 不变");

    // unstar 幂等：取消不存在收藏 → Ok
    store.unstar(C).await.unwrap();
    // unstar 已收藏 → 删除
    store.unstar(A).await.unwrap();
    let list3 = store.list_favorites().await.unwrap();
    assert!(!list3.iter().any(|f| f.code == A), "取消收藏后不在列表");

    clean(&pool, &[A, B, C]).await;
}

#[tokio::test]
async fn star_and_unstar_unknown_symbol_noop() {
    let pool = pool().await;
    clean(&pool, &[UNK]).await;
    // 符号不存在：star 应为 no-op（0 行），不触发 FK 错误
    let store = PgFavoriteStore::new(pool.clone());
    store.star(UNK).await.unwrap();
    assert!(!store.favorite_map().await.unwrap().contains_key(UNK), "未收藏未知符号不落行");
    // 取消未知符号 → Ok
    store.unstar(UNK).await.unwrap();
    clean(&pool, &[UNK]).await;
}

#[tokio::test]
async fn reorder_updates_sort_order_by_index() {
    let pool = pool().await;
    clean(&pool, &[A2, B2, C2]).await;
    seed_symbols(&pool, &[A2, B2, C2]).await;
    let store = PgFavoriteStore::new(pool.clone());

    for c in [A2, B2, C2] {
        store.star(c).await.unwrap();
    }
    let order: Vec<String> = [A2, B2, C2].iter().rev().map(|s| s.to_string()).collect();
    store.reorder(&order).await.unwrap();

    let list = store.list_favorites().await.unwrap();
    let mine: Vec<_> = list.iter().filter(|f| [A2, B2, C2].contains(&f.code.as_str())).collect();
    assert_eq!(mine.len(), 3);
    for (i, f) in mine.iter().enumerate() {
        assert_eq!(f.code, order[i], "重排后顺序 = codes 顺序");
        assert_eq!(f.sort_order, (i as i32) + 1, "sort_order = 索引");
    }

    // 空入参 = 无操作
    store.reorder(&[]).await.unwrap();
    let list2 = store.list_favorites().await.unwrap();
    assert_eq!(list2.iter().filter(|f| [A2, B2, C2].contains(&f.code.as_str())).count(), 3);

    clean(&pool, &[A2, B2, C2]).await;
}

#[tokio::test]
async fn favorite_map_excludes_non_favorites() {
    let pool = pool().await;
    clean(&pool, &[X, Y, Z]).await;
    seed_symbols(&pool, &[X, Y, Z]).await;
    let store = PgFavoriteStore::new(pool.clone());

    store.star(X).await.unwrap();
    store.star(Z).await.unwrap();

    let map = store.favorite_map().await.unwrap();
    assert!(map.contains_key(X));
    assert!(map.contains_key(Z));
    assert!(map.get(X) < map.get(Z), "X 先收藏 → sort 靠前");
    assert!(!map.contains_key(Y), "非收藏不在 map");

    let list = store.list_favorites().await.unwrap();
    let mine: Vec<_> = list.iter().filter(|f| [X, Y, Z].contains(&f.code.as_str())).collect();
    assert_eq!(mine[0].code, X);
    assert_eq!(mine[1].code, Z);
    assert!(mine[0].sort_order < mine[1].sort_order);

    clean(&pool, &[X, Y, Z]).await;
}

#[tokio::test]
async fn delete_symbol_cascades_favorite() {
    let pool = pool().await;
    clean(&pool, &[CASC]).await;
    seed_symbols(&pool, &[CASC]).await;
    let store = PgFavoriteStore::new(pool.clone());
    store.star(CASC).await.unwrap();
    assert!(store.favorite_map().await.unwrap().contains_key(CASC), "已收藏");

    sqlx::query("DELETE FROM symbols WHERE code = $1").bind(CASC).execute(&pool).await.unwrap();
    assert!(!store.favorite_map().await.unwrap().contains_key(CASC), "级联删除收藏");

    clean(&pool, &[CASC]).await;
}
