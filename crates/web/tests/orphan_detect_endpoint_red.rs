// ~/~ 手写测试（非 entangled 生成物）：ADR-023 E6a 红阶段 —— R1 / R2(静态) / R4(a) / R5
//
// 契约来源：design/01-architecture/adr/ADR-023-period-set-extension-30m.md §6.1 第 8 条
//           （测试隔离债）+ §6.3 第 12 条（孤儿行缺陷与清理记录）。
//
// 【钉死的接口契约（本轮 red 测试定义的实现目标）】
//   1) 端点：`GET /api/quality/orphans` → 200 + JSON 对象：
//        { "rows": <i64 总行数>, "by_table": { "<10 张 cagg 表名>": <i64>, ... } }
//      空库 / 无孤儿时 `rows == 0` 且 10 个表键全 0。
//   2) 口径：检测式 = 「cagg 行的 code 不在 symbols 里」，在 10 张 cagg（7 accurate + 3 raw 派生）上的并集计数。
//   3) 复用（2026-09-17 父级裁决 C1 改写归属）：检测 SQL 必须是**单一**可复用常量，归属**基础设施**
//      （`crates/storage/src/reader.rs`，符号名 `ORPHAN_ROWS_SQL` / `ORPHAN_TABLES`）；端点与测试经
//      `QualityService::orphan_rows` → `QualityRead::orphan_rows` 走同一条链路（web/diagnose 不得内联 SQL）。
//   4) 本文件只用只读操作（SELECT / GET）⇒ 不写活库 eestock。
//
// 期望（红阶段）：R1 = 404（端点不存在）；R2-static = 检测 SQL 定义文件 0 个；
//                R4(a) = 三个 clean() 均无 refresh_continuous_aggregate；R5 = api_rest.rs:151 命中 NULL,NULL。

mod orphan_probe;

use orphan_probe::{rs_files, repo_root, CAGGS};
use serde_json::Value;

/// R1：端点存在 + JSON 口径（rows + 逐表分解）+ 空/无孤儿时 rows == 0。
#[tokio::test]
async fn r1_orphan_endpoint_exists_and_reports_zero_on_clean_db() {
    let pool = orphan_probe::pool().await;
    let url = orphan_probe::spawn(orphan_probe::state(pool.clone())).await;
    let http = reqwest::Client::new();

    let resp = http.get(format!("{url}/api/quality/orphans")).send().await.unwrap();
    assert_eq!(resp.status(), 200, "R1: GET /api/quality/orphans 必须存在并返回 200（当前实现缺失 ⇒ 404）");
    let v: Value = resp.json().await.expect("R1: 响应体必须是 JSON");

    let rows = v.get("rows").and_then(Value::as_i64)
        .expect("R1: JSON 必须含整数键 `rows`（孤儿总行数）");
    let by = v.get("by_table").and_then(Value::as_object)
        .expect("R1: JSON 必须含对象键 `by_table`（逐表分解，本 red 轮钉死键名）");

    let keys: Vec<&String> = by.keys().collect();
    assert_eq!(keys.len(), 10, "R1: by_table 必须逐表列出 10 张 cagg，实际 {keys:?}");
    for t in CAGGS {
        assert!(by.contains_key(t), "R1: by_table 缺表 {t}");
    }
    let sum: i64 = by.values().map(|x| x.as_i64().expect("R1: 每表值必须是整数")).sum();
    assert_eq!(rows, sum, "R1: rows 必须等于各表之和（并集计数口径自洽）");
    assert_eq!(rows, 0, "R1: 当前活库无孤儿（2026-09-17 清理后 0）⇒ rows 必须为 0");
    for t in CAGGS {
        assert_eq!(by[t].as_i64().unwrap(), 0, "R1: 空库/无孤儿时 {t} 必须为 0");
    }

    // 对照（只读）：同一 SQL 口径在 DB 上的直接计数（实现存在时应与端点一致，见 R2 符号测试）。
    pool.close().await;
}

/// R2（静态，2026-09-17 按父级裁决 C1 改写：归属改为**基础设施**，意图不变）：
/// (a) 孤儿谓词在全仓 crates/*/src 下**恰有一处**定义（不得端点/测试各内联一份）；
/// (b) 该定义处覆盖全部 10 张 cagg（表清单硬断言）；
/// (c) 端点与测试引用同一处（端点经 QualityService::orphan_rows → port → storage 实现）；
/// (d) `cargo tree -e normal -p storage` 不含 `diagnose`（防 Infrastructure→Application 层倒置）；
/// (e) `cargo tree -e normal -p domain` 不含 `sqlx`（domain 保持纯净）；
/// (f) crates/diagnose 与 crates/web 的 src 不得出现孤儿检测 SQL 文本（谓词 + `from <表>` 形态）。
#[test]
fn r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint() {
    let root = repo_root();
    // 统一谓词（归一化小写后比对）：code not in (select code from symbols)
    const PREDICATE: &str = "not in (select code from symbols)";
    // SQL 文本的 FROM 形态：表名作为 FROM 目标出现（比裸词表名严格得多：doc 注释里提表名不算）。
    let from_forms: Vec<String> = CAGGS.iter().map(|t| format!("from {t}")).collect();

    let mut defs: Vec<(std::path::PathBuf, usize)> = vec![];
    let mut files = rs_files(&root.join("crates"));
    files.retain(|p| p.to_string_lossy().contains("/src/"));
    for f in &files {
        let Ok(src) = std::fs::read_to_string(f) else { continue };
        let flat = src.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
        if !flat.contains(PREDICATE) { continue; }
        // 「检测式定义处」= 10 张 cagg 各自**至少有一处**作为 FROM 目标且其后 ~120 字符内出现该谓词
        // （同一文件内可能有别的同名 FROM 出现在别的 SQL 里 ⇒ 逐处扫描而非只看首次命中）。
        let hits = from_forms.iter().filter(|ff| {
            let mut s = flat.as_str();
            while let Some(i) = s.find(ff.as_str()) {
                let seg = &s[i..(i + 120).min(s.len())];
                if seg.contains(PREDICATE) { return true; }
                s = &s[i + ff.len()..];
            }
            false
        }).count();
        defs.push((f.clone(), hits));
    }
    // (a) 全仓恰一处定义
    assert_eq!(defs.len(), 1,
        "R2(a): 孤儿检测谓词在全仓 crates/*/src 下必须**恰有一处**定义（当前 {} 处：{:?}）",
        defs.len(), defs.iter().map(|(p, _)| p).collect::<Vec<_>>());
    let (path, hits) = &defs[0];
    // 归属：schema 知识（谓词 + 表清单）属**基础设施**，钉在 storage 侧 QualityRead 实现
    assert!(path.to_string_lossy().ends_with("crates/storage/src/reader.rs"),
        "R2: 定义归属钉死为 crates/storage/src/reader.rs（schema 知识属基础设施），实际 {path:?}");
    // (b) 覆盖全部 10 张 cagg
    assert_eq!(hits, &10, "R2(b): 定义必须覆盖全部 10 张 cagg；{path:?} 只命中 {hits}");

    // (c)+(f) 端点/应用层不得内联该口径（谓词或 `from <cagg>` 形态都不得出现在 web/diagnose 的 src）
    for sub in ["crates/web/src", "crates/diagnose/src"] {
        for f in rs_files(&root.join(sub)) {
            let src = std::fs::read_to_string(&f).unwrap();
            let flat = src.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(!flat.contains(PREDICATE),
                "R2(f): {} 不得出现孤儿检测谓词（SQL 归属基础设施）", f.display());
            for ff in &from_forms {
                assert!(!flat.contains(ff.as_str()),
                    "R2(f): {} 不得内联 cagg 检测 SQL（命中 `{ff}`）", f.display());
            }
        }
    }
    // (c) 端点只能经类型化链路取数：web handler → diagnose::quality::QualityService::orphan_rows
    let rest = std::fs::read_to_string(root.join("crates/web/src/rest.rs")).unwrap();
    assert!(rest.contains("st.quality.orphan_rows()"),
        "R2(c): crates/web/src/rest.rs 必须经 `st.quality.orphan_rows()` 取孤儿数（同一条链路）");
    let svc = std::fs::read_to_string(root.join("crates/diagnose/src/quality.rs")).unwrap();
    assert!(svc.contains("self.quality.orphan_rows()"),
        "R2(c): crates/diagnose/src/quality.rs 必须转发 `self.quality.orphan_rows()`（端口链路）");

    // (d)(e) 零新依赖边：storage 不得依赖 diagnose；domain 不得依赖 sqlx
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    for (pkg, forbidden, tag) in [("storage", "diagnose", "d"), ("domain", "sqlx", "e")] {
        let out = std::process::Command::new(&cargo)
            .args(["tree", "-e", "normal", "-p", pkg])
            .current_dir(&root).output().expect("cargo tree 可执行");
        assert!(out.status.success(), "R2({tag}): cargo tree -e normal -p {pkg} 失败");
        let tree = String::from_utf8_lossy(&out.stdout).to_lowercase();
        assert!(!tree.contains(forbidden),
            "R2({tag}): cargo tree -e normal -p {pkg} 不得含 `{forbidden}`（分层红线）：\n{tree}");
    }
}

/// R4(a)（结构）：三处 clean()（或等价清理函数）必须对「其 fixture 涉及的 cagg 窗口」删完即重算。
#[test]
fn r4a_clean_functions_refresh_affected_cagg_windows() {
    let root = repo_root();
    let cases: [(&str, &str, &[&str]); 4] = [
        ("crates/web/tests/api_kline_period.rs", "async fn clean(",
         &["kline_accurate_1w", "kline_accurate_1mo"]),
        ("crates/web/tests/api_rest.rs", "async fn clean_kline(",
         &["kline_5m", "kline_1d"]),
        ("crates/web/tests/api_rest.rs", "async fn clean_sym(",
         &["kline_1d"]),
        ("crates/storage/tests/kline_reader.rs", "async fn clean(",
         &["kline_accurate_1d", "kline_1d", "kline_accurate_1w", "kline_accurate_1mo"]),
    ];
    let mut msgs = vec![];
    for (rel, marker, required) in cases {
        let src = std::fs::read_to_string(root.join(rel)).unwrap();
        let Some(body) = orphan_probe::fn_body(&src, marker) else {
            msgs.push(format!("{rel}::{marker}: 找不到清理函数（实现改名则本断言须同步）"));
            continue;
        };
        if !body.contains("refresh_continuous_aggregate") {
            msgs.push(format!("{rel}::{marker}: 无 refresh_continuous_aggregate ⇒ 只删不重算（孤儿根因）"));
            continue;
        }
        for t in required {
            if !body.contains(t) {
                msgs.push(format!("{rel}::{marker}: 未对 fixture 涉及的 cagg `{t}` 重算窗口"));
            }
        }
        if body.to_lowercase().replace(' ', "").contains("null,null") {
            msgs.push(format!("{rel}::{marker}: 用了 NULL,NULL（全量刷，R5 禁止）"));
        }
    }
    assert!(msgs.is_empty(), "R4(a) 结构判据未达成:\n{}", msgs.join("\n"));
}

/// 扫描单个文件里的「refresh_continuous_aggregate(..., NULL, NULL)」调用（注释行不计）。
fn null_null_refresh_lines(src: &str) -> Vec<usize> {
    let mut out = vec![];
    for (n, line) in src.lines().enumerate() {
        if line.trim_start().starts_with("//") {
            continue;
        }
        let ident = "refresh_continuous_aggregate";
        let mut s = line;
        while let Some(i) = s.find(ident) {
            let after = &s[i + ident.len()..];
            // 只认「真调用」：标识符后（允许空白）必须是 `(` 且首参是字符串字面量（cagg 名）。
            let t = after.trim_start();
            if !t.starts_with('(') {
                // 字符串字面量/注释里的提及不算调用；前进 1 字节继续找
                let adv = i + 1;
                s = &s[adv..];
                continue;
            }
            let t2 = t[1..].trim_start();
            if !(t2.starts_with('\'') || t2.starts_with('"')) {
                let adv = i + 1;
                s = &s[adv..];
                continue;
            }
            match after.find(')') {
                Some(j) => {
                    let args = after[..j].to_lowercase().replace(' ', "");
                    if args.contains("null,null") {
                        out.push(n + 1);
                    }
                    s = &after[j..];
                }
                None => break,
            }
        }
    }
    out
}

/// R5（静态）：crates 下测试文件内**禁止** refresh_continuous_aggregate(NULL, NULL)。
#[test]
fn r5_no_full_range_refresh_in_test_sources() {
    let root = repo_root();
    let mut total = 0usize;
    let mut viol = vec![];
    for f in rs_files(&root.join("crates")) {
        let s = f.to_string_lossy();
        if !s.contains("/tests/") {
            continue;
        }
        let src = std::fs::read_to_string(&f).unwrap();
        total += src.matches("refresh_continuous_aggregate").count();
        for n in null_null_refresh_lines(&src) {
            viol.push(format!("{}:{}", f.strip_prefix(&root).unwrap().display(), n));
        }
    }
    println!("R5 grep 命令: grep -rn \"refresh_continuous_aggregate\" crates/*/tests | grep -c NULL");
    println!("R5 refresh 调用点计数 = {total}；NULL,NULL 违规点 = {viol:?}");
    assert_eq!(viol, Vec::<String>::new(),
        "R5: 测试内禁 refresh_continuous_aggregate(NULL, NULL)（全量刷）；违规点：{viol:?}");
}
