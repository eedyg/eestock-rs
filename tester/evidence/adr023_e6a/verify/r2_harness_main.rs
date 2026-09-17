// R2 mutation harness — 逐字抽取 crates/web/tests/orphan_detect_endpoint_red.rs 的
// `r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint()` 函数体 与
// orphan_probe/mod.rs 的 CAGGS / rs_files()，唯一改动：repo_root() 从 argv[1] 取（以便在 /tmp 变异副本上重跑同一份断言逻辑）。
// 目的：A3/A2 —— 变异验证「把该 SQL 抄进 diagnose/web 会变红」。
use std::path::PathBuf;

fn repo_root() -> PathBuf { PathBuf::from(std::env::args().nth(1).expect("usage: r2_harness <repo_root>")) }

pub const CAGGS: [&str; 10] = [
    "kline_accurate_5m", "kline_accurate_15m", "kline_accurate_30m", "kline_accurate_1h",
    "kline_accurate_1d", "kline_accurate_1w", "kline_accurate_1mo",
    "kline_5m", "kline_15m", "kline_1d",
];

/// 递归收集 <root> 下扩展名为 .rs 的文件。
pub fn rs_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn r2() {
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

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let r = std::panic::catch_unwind(r2);
    let ok = r.is_ok();
    match r {
        Ok(()) => println!("HARNESS_VERDICT=GREEN  (R2 断言全部通过)"),
        Err(e) => {
            let msg = e.downcast_ref::<String>().cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "<non-string panic>".into());
            println!("HARNESS_VERDICT=RED    (R2 断言失败 ⇒ 变异被抓住)");
            println!("panic message: {msg}");
        }
    }
    std::process::exit(if ok { 0 } else { 1 });
}
