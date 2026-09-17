// ~/~ 手写测试（非 entangled 生成物）：ADR-023 E6a 红阶段 —— R2 符号契约
//
// 【钉死的接口契约（本文件即 TDD 的编译期契约；2026-09-17 按父级裁决 C1 改写归属）】
//   `crates/storage/src/reader.rs` 必须导出（schema 知识 = 基础设施）：
//     - `pub const ORPHAN_TABLES: [&str; 10]` —— 检测覆盖的 10 张 cagg（顺序：7 accurate + kline_5m/15m/1d）
//     - `pub const ORPHAN_ROWS_SQL: &str`     —— 可复用检测 SQL：逐表 `(table_name text, orphan_rows bigint)`，
//                                                口径 = `code NOT IN (SELECT code FROM symbols)`
//   ⇒ 端点 `GET /api/quality/orphans` 与测试经**同一条链路**取同一份 SQL
//      （端点：QualityService::orphan_rows → QualityRead::orphan_rows → storage 实现）。
//   本文件运行该 SQL（只读 SELECT）并与端点对拍。

mod orphan_probe;

use storage::reader::{ORPHAN_ROWS_SQL, ORPHAN_TABLES};
use orphan_probe::CAGGS;
use sqlx::Row;
use std::collections::HashMap;

/// R2：断言复用常量的形状（10 表 / 反连接口径）。
#[test]
fn r2_shared_sql_constant_shape() {
    assert_eq!(ORPHAN_TABLES, CAGGS, "ORPHAN_TABLES 必须是 10 张 cagg 的固定顺序");
    let flat = ORPHAN_ROWS_SQL.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    for t in CAGGS {
        assert!(flat.contains(&format!("from {t}")), "ORPHAN_ROWS_SQL 缺表 {t}");
    }
    assert!(flat.contains("symbols"), "ORPHAN_ROWS_SQL 必须反连 symbols（口径：code 不在 symbols 里）");
    assert!(flat.contains("not exists") || flat.contains("not in"),
        "ORPHAN_ROWS_SQL 必须用反连接（NOT EXISTS / NOT IN）");
    assert!(!flat.contains("null, null"), "检测 SQL 不得含全量刷窗口");
}

/// R2：同一份 SQL 的逐表结果 == 端点 JSON 的 `by_table`/`rows`（共用一份的可验证含义）。
#[tokio::test]
async fn r2_sql_result_equals_endpoint_payload() {
    let pool = orphan_probe::pool().await;
    let rows = sqlx::query(ORPHAN_ROWS_SQL).fetch_all(&pool).await
        .expect("ORPHAN_ROWS_SQL 必须能在活库（只读 SELECT）执行");
    let mut from_sql: HashMap<String, i64> = HashMap::new();
    for r in rows {
        from_sql.insert(r.get::<String, _>("table_name"), r.get::<i64, _>("orphan_rows"));
    }
    assert_eq!(from_sql.len(), 10, "检测 SQL 必须逐表返回 10 行");

    let url = orphan_probe::spawn(orphan_probe::state(pool.clone())).await;
    let v: serde_json::Value = reqwest::Client::new()
        .get(format!("{url}/api/quality/orphans")).send().await.unwrap()
        .json().await.unwrap();
    let by = v["by_table"].as_object().expect("端点必须有 by_table");
    for (t, n) in &from_sql {
        assert_eq!(by.get(t).and_then(|x| x.as_i64()), Some(*n),
            "端点 {t} 与共享 SQL 不一致（必须共用同一份检测式）");
    }
    let sum: i64 = from_sql.values().sum();
    assert_eq!(v["rows"].as_i64(), Some(sum), "端点 rows 必须等于共享 SQL 的并集计数");
    pool.close().await;
}
