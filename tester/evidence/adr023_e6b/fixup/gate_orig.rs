//! ADR-023 E6b —— 「测试池必须指向测试库」门禁的**红测试**（TDD 红阶段）。
//!
//! 契约（本轮要实现的目标行为）：
//!   1. 所有测试的连接池一律从环境变量 `EESTOCK_TEST_DATABASE_URL` 取；未设即响亮失败（非零退出 + 信息含变量名）。
//!   2. 池构造后必须断言测试库存在哨兵表 `_eestock_test_db`（值为 `test`）；不存在即响亮失败（防误指活库）。
//!   3. 新增 `scripts/testdb-init.sh`：幂等建测试库 + 按序应用 `migrations/*.sql` + 建哨兵表 + 打印 export 行。
//!
//! 本文件是**新编写的红测试**：只做静态扫描 + 子进程探针；自身**不连库**（对任何库零写入）。
//! 子进程探针刻意把 `DATABASE_URL` 指向**不可达地址**（127.0.0.1:1），确保绝无可能触达活库。
//! 本文件自身被排除在扫描之外（否则其常量与自描述会自匹配）。

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 目标环境变量名（判据 R1）
const ENV_VAR: &str = "EESTOCK_TEST_DATABASE_URL";
/// 哨兵表名（判据 R2）
const SENTINEL: &str = "_eestock_test_db";
/// 被钉死的活库兜底 URL（判据 R4）——分片拼接，避免本文件自匹配
const LIVE_URL: &str = concat!("postgres://eestock:eestock@127.0.0.1", ":5433/eestock");
/// 初始化脚本（判据 R3）
const INIT_SCRIPT: &str = "scripts/testdb-init.sh";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates/")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

/// 本门禁文件自身（扫描时排除）
fn self_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/adr023_e6b_testdb_env_gate_red.rs")
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_rs(&p, out);
        } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
            out.push(p);
        }
    }
}

/// 全部测试源码：`crates/*/tests/**/*.rs`（排除本文件）
fn test_sources() -> Vec<PathBuf> {
    let mut v = Vec::new();
    let crates = repo_root().join("crates");
    if let Ok(rd) = fs::read_dir(&crates) {
        for e in rd.flatten() {
            let t = e.path().join("tests");
            if t.is_dir() {
                collect_rs(&t, &mut v);
            }
        }
    }
    let me = self_path();
    v.retain(|p| *p != me);
    v.sort();
    v
}

/// 是否**急切建池**（会真的连库）：`PgPool::connect(` 或 `PgPoolOptions ... .connect(`。
/// 仅 `connect_lazy(` 到不可达地址的文件（如 `period30m_api_contract.rs`）不算连库文件。
fn builds_live_pool(src: &str) -> bool {
    src.contains("PgPool::connect(") || (src.contains("PgPoolOptions") && src.contains(".connect("))
}

fn pool_building_files() -> Vec<PathBuf> {
    test_sources()
        .into_iter()
        .filter(|f| fs::read_to_string(f).map(|s| builds_live_pool(&s)).unwrap_or(false))
        .collect()
}

/// 建池文件里缺 `needle` 的相对路径清单
fn offenders(needle: &str) -> (Vec<PathBuf>, Vec<String>) {
    let files = pool_building_files();
    let mut bad = Vec::new();
    for f in &files {
        let s = fs::read_to_string(f).unwrap();
        if !s.contains(needle) {
            bad.push(f.strip_prefix(repo_root()).unwrap_or(f).display().to_string());
        }
    }
    (files, bad)
}

fn fmt_list(v: &[String]) -> String {
    v.iter().map(|x| format!("  - {x}")).collect::<Vec<_>>().join("\n")
}

/// R1（静态面）：每个会连库的测试文件都必须引用 `EESTOCK_TEST_DATABASE_URL`，不得有活库兜底。
#[test]
fn r1_static_every_test_pool_must_read_eestock_test_database_url() {
    let (files, bad) = offenders(ENV_VAR);
    assert!(
        bad.is_empty(),
        "R1 红：{}/{} 个「会连库」的测试文件未从 {ENV_VAR} 取 URL（无该变量名 ⇒ 无法「未设即响亮失败」）。\n违规清单：\n{}",
        bad.len(),
        files.len(),
        fmt_list(&bad)
    );
}

/// R2（静态面）：每个会连库的测试文件都必须在建池后断言哨兵表 `_eestock_test_db`。
#[test]
fn r2_static_every_test_pool_must_assert_sentinel_table() {
    let (files, bad) = offenders(SENTINEL);
    assert!(
        bad.is_empty(),
        "R2 红：{}/{} 个「会连库」的测试文件无哨兵表 `{SENTINEL}` 断言（误指活库不会被拦）。\n违规清单：\n{}",
        bad.len(),
        files.len(),
        fmt_list(&bad)
    );
}

/// R4（静态面）：`crates/*/tests/**` 中不得再出现活库兜底 URL 字面量；并分别统计「兜底默认」与「注释提及」。
#[test]
fn r4_static_no_hardcoded_live_db_url_in_test_sources() {
    let mut hits: Vec<String> = Vec::new();
    let mut fallback_default = 0usize;
    for f in test_sources() {
        let Ok(s) = fs::read_to_string(&f) else { continue };
        for (i, line) in s.lines().enumerate() {
            if line.contains(LIVE_URL) {
                if line.contains("unwrap_or_else") {
                    fallback_default += 1;
                }
                hits.push(format!(
                    "{}:{}",
                    f.strip_prefix(repo_root()).unwrap_or(&f).display(),
                    i + 1
                ));
            }
        }
    }
    assert!(
        hits.is_empty(),
        "R4 红：活库 URL 字面量在 crates/*/tests 下仍有 {} 处（其中 `unwrap_or_else` 兜底默认 {} 处）：\n{}",
        hits.len(),
        fallback_default,
        fmt_list(&hits)
    );
}

/// R3（静态面）：初始化脚本存在、可执行，且契约要素齐备（建库 / 应用迁移 / 建哨兵 / 打印 export）。
#[test]
fn r3_init_script_exists_executable_and_covers_contract() {
    let p = repo_root().join(INIT_SCRIPT);
    assert!(
        p.is_file(),
        "R3 红：`{INIT_SCRIPT}` 不存在（缺幂等建库 + 迁移 + 哨兵 + export 的一键入口）"
    );
    let mode = fs::metadata(&p).unwrap().permissions().mode();
    assert!(mode & 0o111 != 0, "R3 红：`{INIT_SCRIPT}` 不可执行（mode={mode:o}）");
    let s = fs::read_to_string(&p).unwrap();
    for needle in [SENTINEL, ENV_VAR, "migrations"] {
        assert!(s.contains(needle), "R3 红：`{INIT_SCRIPT}` 缺契约要素 `{needle}`");
    }
}

/// R1（行为面 / 子进程探针）：未设 `EESTOCK_TEST_DATABASE_URL` 时，参照测试二进制必须响亮失败并**点名变量**。
///
/// 探针把 `DATABASE_URL` 指向不可达地址（127.0.0.1:1）⇒ 绝无可能触达活库或任何库（零写风险）。
#[test]
fn r1_behaviour_unset_env_var_must_fail_loudly_naming_the_variable() {
    let deps = std::env::current_exe()
        .expect("current exe")
        .parent()
        .expect("deps/")
        .to_path_buf();
    let mut cands: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for e in fs::read_dir(&deps).into_iter().flatten().flatten() {
        let p = e.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if name.starts_with("kline_reader-")
            && !name.ends_with(".d")
            && p.is_file()
            && fs::metadata(&p).unwrap().permissions().mode() & 0o111 != 0
        {
            if let Ok(mt) = e.metadata().and_then(|m| m.modified()) {
                cands.push((mt, p));
            }
        }
    }
    cands.sort_by_key(|(t, _)| *t);
    let bin = cands
        .pop()
        .expect(
            "harness 前提缺失：找不到已编译的 kline_reader 测试二进制；先跑 \
             `cargo test -p storage --test kline_reader --no-run`",
        )
        .1;

    let out = Command::new(&bin)
        .env_remove(ENV_VAR)
        .env("DATABASE_URL", "postgres://eestock:eestock@127.0.0.1:1/eestock")
        .output()
        .expect("spawn reference test binary");
    let merged = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        merged.contains(ENV_VAR),
        "R1 红：未设 {ENV_VAR} 时参照测试二进制未点名该变量（无「未设即响亮失败」门禁）。\n\
         探针：{}（exit={:?}）\n输出节选：\n{}",
        bin.display(),
        out.status.code(),
        merged.lines().take(12).collect::<Vec<_>>().join("\n")
    );
}
