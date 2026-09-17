//! ADR-023 E6b —— 「测试池必须指向测试库」门禁（R1–R4）。
//!
//! 契约（目标行为）：
//!   1. 所有测试的连接池一律从环境变量 `EESTOCK_TEST_DATABASE_URL` 取；未设即响亮失败（非零退出 + 信息含变量名）。
//!   2. 池构造后必须断言测试库存在哨兵表 `_eestock_test_db`（值为 `test`）；不存在即响亮失败（防误指活库）。
//!   3. 新增 `scripts/testdb-init.sh`：幂等建测试库 + 按序应用 `migrations/*.sql` + 建哨兵表 + 打印 export 行。
//!
//! ## F3：检测面补齐（ADR-023 E6b 第二刀验收 A4/M4）
//!
//! 旧版静态面只认 `PgPool::connect(` 或 `PgPoolOptions … .connect(`，且以「文件里出现过变量名」为通过条件 ⇒
//! `connect_lazy`、`format!` 等非字面量拼接、以及「仅在注释里提到变量名/哨兵表名」三种形态都能**绕过**。现改为：
//!
//!   • **检测面**（`constructs_pool`）：`PgPool::connect(` / `Pool::connect(` / `PgPoolOptions|PoolOptions … .connect`
//!     / **`connect_lazy(`** —— 凡构造池者皆须经统一入口；
//!   • **R1 断言行为落点**（不是「提到名字」）：任何构造池的测试文件都必须引用 `test_support::` 统一建池入口；
//!     其中**会真的建连**的急切形态还必须调 `test_support::test_pool`。判定在**去注释**后的源码上做，
//!     故「仅注释提及变量名」不再骗过门禁；
//!   • **R2 断言哨兵门禁存在**：每个急切建连文件必须含 `test_support::test_pool`（哨兵断言封装于其内）或
//!     直接断言哨兵表名 `_eestock_test_db`（同为去注释后的源码）。
//!
//! ## 变异反证（本条验收硬要求）
//!
//! 已编译的门禁二进制支持 `EESTOCK_GATE_REPO_ROOT=<副本根>`（默认 = 仓库根），可指向 **/tmp 副本** 跑同一套断言，
//! 用于「注入作弊形态 → 门禁必须变红」的变异反证：(i) `PgPool::connect` + 精确活库字面量、
//! (ii) `connect_lazy` + `format!` 拼接、(iii) 仅注释提及变量名 —— 三者都必须变红。
//! 变异本体、变异前后对照、以及本门禁在正常仓库上仍为 GREEN 的证据见
//! `coder/report/295_adr023_e6b_impl_testdb_env_gate.md`（E6b 第二刀修正节）。
//!
//! 本文件只做静态扫描 + 子进程探针；自身**不连库**（对任何库零写入）。子进程探针刻意把 `DATABASE_URL`
//! 指向不可达地址（127.0.0.1:1），确保绝无可能触达活库。本文件自身被排除在扫描之外（**按文件名**排除，
//! 与扫描根无关 ⇒ 副本里的同名文件亦被排除）。

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
/// 本门禁文件名（扫描时按文件名排除，含 /tmp 副本场景）
const GATE_FILE_NAME: &str = "adr023_e6b_testdb_env_gate_red.rs";
/// 受认可的唯一建池入口（判据 R1/R2）
const ENTRY_PREFIX: &str = "test_support::";
/// 统一建池函数（读 `ENV_VAR` + 断言哨兵表）
const ENTRY_FN: &str = "test_support::test_pool";

fn repo_root() -> PathBuf {
    // 变异反证用：把**已编译的**门禁二进制指向 /tmp 副本跑同一套断言（见文件头「变异反证」）。
    if let Ok(r) = std::env::var("EESTOCK_GATE_REPO_ROOT") {
        let r = r.trim();
        if !r.is_empty() {
            return PathBuf::from(r);
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates/")
        .parent()
        .expect("repo root")
        .to_path_buf()
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

/// 全部测试源码：`crates/*/tests/**/*.rs`（排除本文件，按文件名）
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
    v.retain(|p| p.file_name().map(|n| n != GATE_FILE_NAME).unwrap_or(true));
    v.sort();
    v
}

/// 去注释后的源码（保留字符串字面量、保行结构）：`//` 行注释与 `/* */` 块注释替换为空格。
///
/// 用途：R1/R2 判定「**代码**里是否真的引用统一入口」，使「仅注释提及」不再通过；
/// R4 仍按**原始**源码判定（注释里的活库 URL 也算残留，历史刀口口径不变）。
fn code_only(src: &str) -> String {
    let b: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    let (mut in_str, mut in_line) = (false, false);
    let mut in_block = 0usize;
    while i < b.len() {
        let c = b[i];
        if in_line {
            if c == '\n' {
                in_line = false;
                out.push('\n');
            } else {
                out.push(' ');
            }
            i += 1;
            continue;
        }
        if in_block > 0 {
            if c == '*' && b.get(i + 1) == Some(&'/') {
                in_block -= 1;
                out.push_str("  ");
                i += 2;
            } else {
                out.push(if c == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&'/') {
            in_line = true;
            i += 2;
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&'*') {
            in_block += 1;
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 是否**构造连接池**（含 lazy）：检测面 = `PgPool::connect(` / `Pool::connect(` /
/// `PgPoolOptions|PoolOptions … .connect` / `connect_lazy(`。
fn constructs_pool(code: &str) -> bool {
    code.contains("PgPool::connect(")
        || code.contains("Pool::connect(")
        || ((code.contains("PgPoolOptions") || code.contains("PoolOptions")) && code.contains(".connect"))
        || code.contains("connect_lazy(")
}

/// 是否**急切建连**（`connect_lazy` 不建连，只有真正 `.connect` 才算）：
/// `PgPool::connect(` / `Pool::connect(` / `PgPoolOptions|PoolOptions … .connect(`。
fn eagerly_connects(code: &str) -> bool {
    code.contains("PgPool::connect(")
        || code.contains("Pool::connect(")
        || ((code.contains("PgPoolOptions") || code.contains("PoolOptions")) && code.contains(".connect("))
}

/// 一个「构造池」的测试文件（`code` = 去注释源码）
struct PoolFile {
    rel: String,
    code: String,
    eager: bool,
}

fn pool_files() -> Vec<PoolFile> {
    let mut v = Vec::new();
    for f in test_sources() {
        let Ok(raw) = fs::read_to_string(&f) else { continue };
        let code = code_only(&raw);
        if constructs_pool(&code) {
            v.push(PoolFile {
                rel: f.strip_prefix(repo_root()).unwrap_or(&f).display().to_string(),
                eager: eagerly_connects(&code),
                code,
            });
        }
    }
    v
}

fn fmt_list(v: &[String]) -> String {
    v.iter().map(|x| format!("  - {x}")).collect::<Vec<_>>().join("\n")
}

/// R1（静态面 / 行为落点）：每个**构造池**的测试文件都必须在**代码**里引用统一入口 `test_support::`；
/// 其中**会真的建连**（急切形态）的文件必须调 `test_support::test_pool`。
///
/// 判据由「提到变量名」改为「实际落点」：仅注释提及 `ENV_VAR` 不再通过（注释已被剥离）。
#[test]
fn r1_static_every_test_file_that_builds_a_pool_must_use_test_support_entry() {
    let files = pool_files();
    let mut bad: Vec<String> = Vec::new();
    for f in &files {
        if !f.code.contains(ENTRY_PREFIX) {
            bad.push(format!("{}（构造池但未引用 `{ENTRY_PREFIX}` 统一入口）", f.rel));
        } else if f.eager && !f.code.contains(ENTRY_FN) {
            bad.push(format!("{}（会真建连但未调 `{ENTRY_FN}`）", f.rel));
        }
    }
    assert!(
        bad.is_empty(),
        "R1 红：{}/{} 个「构造池」的测试文件未走统一建池入口（`{ENTRY_PREFIX}` / `{ENTRY_FN}`）；\
         检测面含 `PgPool::connect(` / `Pool::connect(` / `PgPoolOptions|PoolOptions … .connect` / `connect_lazy(`，\
         判定基于**去注释**源码（注释提及不算）。\n违规清单：\n{}",
        bad.len(),
        files.len(),
        fmt_list(&bad)
    );
}

/// R2（静态面）：每个**急切建连**的测试文件都必须在**代码**里携带哨兵门禁
/// —— 或经 `test_support::test_pool`（哨兵断言封装于其内），或直接断言哨兵表名 `_eestock_test_db`。
#[test]
fn r2_static_every_connecting_test_file_must_carry_sentinel_gate() {
    let files: Vec<PoolFile> = pool_files().into_iter().filter(|f| f.eager).collect();
    let mut bad: Vec<String> = Vec::new();
    for f in &files {
        if !(f.code.contains(ENTRY_FN) || f.code.contains(SENTINEL)) {
            bad.push(format!(
                "{}（急切建连但既无 `{ENTRY_FN}` 也无哨兵表 `{SENTINEL}` 断言）",
                f.rel
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "R2 红：{}/{} 个「会真建连」的测试文件无哨兵门禁（误指活库不会被拦）；判定基于**去注释**源码。\n违规清单：\n{}",
        bad.len(),
        files.len(),
        fmt_list(&bad)
    );
}

/// R4（静态面）：`crates/*/tests/**` 中不得再出现活库兜底 URL 字面量；并分别统计「兜底默认」与「注释提及」。
/// 本判据按**原始**源码（含注释）扫描 —— 历史刀口口径不变。
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
