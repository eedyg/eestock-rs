//! ADR-023 D1 红测试（**手写**）：判据 J7 —— 迁移 `0026`（30m cagg + 窗口根治 + 全量刷）。
//!
//! 断言对象 = `migrations/` 目录下的**文本**（编号 + 内容），不连库（D1 阶段无 DB）。
//! 契约出处：ADR-023 §2.2 / §2.4 / §3.3 / §5.2。
//!   (a) 新迁移编号 0026，文件名含 `30m` 或 `period`；
//!   (b) `kline_accurate_30m` continuous 物化视图定义（`FROM kline_accurate WHERE period = 'M1'` + `time_bucket('30 minutes', ts)`）；
//!   (c) **禁止**历史截断过滤（`ts >= '2024-…'` 之类）（0017 教训）；
//!   (d) 30m cagg 的 `start_offset = INTERVAL '3 days'`（**禁止照抄 0017 的 2 hours**）；
//!   (e) 对 30m cagg 的**一次性全量刷新** `CALL refresh_continuous_aggregate('kline_accurate_30m', ...)`。

use std::path::PathBuf;

fn migrations_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../migrations")
}

/// 返回 `0026_*.sql` 迁移文件（编号 0026，ADR-023 §3.3）。缺 ⇒ J7 红。
fn migration_0026() -> (PathBuf, String) {
    let dir = migrations_dir();
    let mut found: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("migrations 目录不可读 {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("0026_") && n.ends_with(".sql"))
                .unwrap_or(false)
        })
        .collect();
    found.sort();
    let path = found.first().cloned().unwrap_or_else(|| {
        let have: Vec<String> = std::fs::read_dir(&dir)
            .map(|it| {
                it.filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                    .collect()
            })
            .unwrap_or_default();
        panic!("ADR-023 §3.3/§2.4：migrations/ 下缺编号 0026 的新迁移（形如 0026_period_30m.sql）；现状 = {have:?}")
    });
    let content = std::fs::read_to_string(&path).expect("迁移文件可读");
    (path, content)
}

fn name_of(p: &std::path::Path) -> String {
    p.file_name().unwrap().to_string_lossy().into_owned()
}

/// J7-a：编号 0026 的迁移存在，且文件名含 `30m` 或 `period`（ADR-023 §3.3）。
#[test]
fn j7a_migration_0026_exists_with_expected_name() {
    let (path, _) = migration_0026();
    let name = name_of(&path).to_lowercase();
    assert!(
        name.contains("30m") || name.contains("period"),
        "ADR-023 §3.3：0026 迁移文件名应含 `30m` 或 `period`；实际 = {name}"
    );
}

/// J7-b：`kline_accurate_30m` 为 continuous 物化视图，源 `kline_accurate` 且 `period = 'M1'`，
/// 桶宽 `30 minutes`（ADR-023 §2.2：1m 本地 cagg 衍生，单一事实源）。
#[test]
fn j7b_cagg_definition_is_full_history_30m_over_accurate_m1() {
    let (path, content) = migration_0026();
    let name = name_of(&path);
    assert!(content.contains("kline_accurate_30m"), "{name}: 缺 kline_accurate_30m 定义");
    assert!(
        content.contains("timescaledb.continuous"),
        "{name}: kline_accurate_30m 必须是 continuous 物化视图（timescaledb.continuous）"
    );
    assert!(
        content.contains("kline_accurate") && content.contains("period = 'M1'"),
        "{name}: 30m cagg 必须 `FROM kline_accurate WHERE period = 'M1'`（ADR-023 §2.1/§2.2）"
    );
    assert!(
        content.contains("30 minutes"),
        "{name}: 30m cagg 必须 `time_bucket('30 minutes', ts)`"
    );
}

/// J7-c：**禁止**历史截断过滤（0017 教训：带 `ts >= '2024-01-01'` 只聚合 2024+）。
#[test]
fn j7c_no_historical_truncation_filter() {
    let (path, content) = migration_0026();
    let name = name_of(&path);
    assert!(
        !content.contains("2024-01-01"),
        "{name}: 30m cagg 不得带 `ts >= '2024-01-01'` 历史截断过滤（ADR-023 §2.2「全历史」，0017 教训）"
    );
    assert!(
        !content.contains("ts >="),
        "{name}: 30m cagg 定义中不得出现任何 `ts >=` 时间下界过滤（ADR-023 §2.2 全历史）"
    );
}

/// J7-d：30m cagg 的刷新策略 `start_offset = INTERVAL '3 days'`（ADR-023 §2.4.4 核心裁决；
/// **禁止**照抄 0017 的 `2 hours`）。容错：允许换行/空白差异。
#[test]
fn j7d_start_offset_is_3_days() {
    let (path, content) = migration_0026();
    let name = name_of(&path);
    let needle = "add_continuous_aggregate_policy";
    let mut cursor = 0usize;
    let mut block: Option<&str> = None;
    while let Some(rel) = content[cursor..].find(needle) {
        let i = cursor + rel;
        let w = &content[i..(i + 400).min(content.len())];
        if w.contains("kline_accurate_30m") {
            block = Some(w);
            break;
        }
        cursor = i + needle.len();
    }
    let block = block.unwrap_or_else(|| {
        panic!("{name}: 缺 30m cagg 的 `add_continuous_aggregate_policy('kline_accurate_30m', ...)`（ADR-023 §2.4.4）")
    });
    assert!(
        block.contains("3 days"),
        "{name}: 30m cagg 的 start_offset 必须为 INTERVAL '3 days'（禁照抄 0017 的 2 hours）；实际块 = {block:?}"
    );
    assert!(
        !block.contains("2 hours"),
        "{name}: 30m cagg 策略不得照抄 0017 的 `INTERVAL '2 hours'`（ADR-023 §2.4.4 明令禁止）；实际块 = {block:?}"
    );
}

/// J7-e：迁移内对 30m cagg 执行**一次性全量刷新**（ADR-023 §2.4.4 第 3 条）。
#[test]
fn j7e_full_refresh_call_present() {
    let (path, content) = migration_0026();
    let name = name_of(&path);
    assert!(
        content.contains("refresh_continuous_aggregate"),
        "{name}: 缺 refresh_continuous_aggregate（ADR-023 §2.4.4 第 3 条一次性全量刷）"
    );
    let flat: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        flat.contains("CALL refresh_continuous_aggregate('kline_accurate_30m'")
            || flat.contains("CALL refresh_continuous_aggregate(\"kline_accurate_30m\""),
        "{name}: 必须对 30m cagg 执行 `CALL refresh_continuous_aggregate('kline_accurate_30m', ...)`"
    );
}
