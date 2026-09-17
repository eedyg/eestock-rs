# ADR-023 E6b 第二刀「收尾修正 4 项」证据

- 证据目录：`/tmp/adr023-e6b-fixup-20260917T041228Z`
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD=`204cb77a2f345c7163b5a93da4540cd5c66f2d6f`，未变）
- 任务：F1 README 播种契约 / F2 源不可达不留脏库 / F3 门禁检测面补齐 + 变异反证 / F4 登记 M3 语义变更
- 约束遵守：禁改 design/、禁 entangled --force/全局 stitch、禁 git add/commit/stash（**无 staged**）、
  活库 eestock **零写**（仅只读 SELECT/COPY）、未重启/杀在线 app（PID 178558）、未改 .gitignore、未动其他项目。

---

## F1 —— README 补播种契约（`README.md:117` 新增小节）

`README.md` 新增 `### 播种契约（测试库 = 活库的**只读快照**，只播最小基线）`，含：

| 表 | 实测行数（本次实测） | 来源 |
|---|---|---|
| `symbols` | 44 | `v3_init.err`（`symbols 播种完成：目标现有 44 行`） |
| `strategy` | 23 | 同上 |
| `strategy_version` | 24 | 同上 |
| `kline_accurate` | **1,631,088** | `kline_accurate 播种完成：目标现有 1631088 行` |
| `kline_accurate_1d`（由 M1 全量 refresh 派生） | 6,768 | `kline_accurate_1d 现有 6768 行` |

并写明：只播 **4 张表**（活库 `public` 共 **37** 张关系 = 26 表 + 11 视图；测试库不是活库克隆）、
**从活库只读快照**（`PGOPTIONS='-c default_transaction_read_only=on'`）、**目标表非空即跳过**、
**活库演进后需重新供应**（dropdb + 重跑）。

活库 37 关系实测（只读）：

```
$ psql <活库只读> -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','m','v')"
37
$ ... group by relkind
r|26
v|11
```

## F2 —— 源不可达不留脏库（`scripts/testdb-init.sh:51-75`）

改动：把 `LIVE_DB_NAME/LIVE_URL/require_live` 定义上移到 `0) 源库可达性（**建库之前**的预检）` 段（`:51`），
并在 `1) 建库` 的 else 分支里 `require_live` **先于** `CREATE DATABASE` 调用（`:73`）。
库已存在时不预检（保持「已供应好的库可离线幂等重跑」）；播种路径仍各自 `require_live`。
`bash -n scripts/testdb-init.sh` → SYNTAX OK。

### V1 判据（原始输出见 `v1_after.err` / `v1_before.err`、库清单 `db_list_*.txt`）

**修后（真实脚本）**：`EESTOCK_TEST_DB_NAME=adr023_e6b_f2_after_iso EESTOCK_LIVE_DB_NAME=eestock_nonexistent_xyz bash scripts/testdb-init.sh`

```
exit=3
[testdb-init] ❌ 源库 `eestock_nonexistent_xyz` 不可达：无法播种测试基线（测试库必须可用，否则集成测试会以难解方式失败）。
[testdb-init]    如源库不在默认位置，设 EESTOCK_TEST_DB_HOST/PORT/USER/PASSWORD 或 EESTOCK_LIVE_DB_NAME。
```

库清单前后 `diff` 相同（**没有新库**）：

```
$ diff db_list_before.txt db_list_after_fixed.txt   # 无输出
$ diff db_list_before.txt db_list_final_v1.txt     # 无输出
V1: DB LIST IDENTICAL TO BEFORE
```

**修前对照**（`mut_script/testdb-init-prefix.sh` = 同一脚本、仅移除建库前预检）：同样 exit 3，但**留下 schema-only 脏库**：

```
exit=3
[testdb-init] 迁移应用完成（账本 26 条）
[testdb-init] 哨兵表 `_eestock_test_db` 就绪（value=test）
[testdb-init] ❌ 源库 `eestock_nonexistent_xyz` 不可达：...
$ psql postgres://.../postgres -Atc "select datname from pg_database order by 1" | grep f2_before
adr023_e6b_f2_before_iso          # ← 脏库（schema-only：select count(*) from symbols = 0）
```

清理：该脏库已 `DROP DATABASE adr023_e6b_f2_before_iso`（`db_list_final_v1.txt` = 基线）。

## F3 —— 门禁检测面补齐（`crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs`）

| 补齐项 | 实现位置 |
|---|---|
| 检测面含 `connect_lazy(` / `PgPoolOptions` / `PoolOptions` / `Pool::connect(` | `constructs_pool()` `:168`、`eagerly_connects()` `:177` |
| **去注释**后再判定（仅注释提及不再骗过） | `code_only()` `:102` |
| R1 断言「行为落点」：构造池文件必须引用 `test_support::`；急切建连文件必须调 `test_support::test_pool` | `r1_static_...()` `:215` |
| R2 断言哨兵门禁：急切建连文件必须有 `test_support::test_pool` 或哨兵表 `_eestock_test_db` | `r2_static_...()` `:239` |
| 扫描根可指向 /tmp 副本（变异反证用；默认=仓库根） | `repo_root()` `:55`（`EESTOCK_GATE_REPO_ROOT`） |
| 自身排除改为**按文件名**（与扫描根无关） | `test_sources()` `GATE_FILE_NAME` |
| 为「不连库的契约测试」提供集中 URL 落点 | `crates/test-support/src/lib.rs:22` `UNREACHABLE_TEST_DB_URL`；`crates/web/tests/period30m_api_contract.rs:24` 改为引用之 |

> 唯一必要连带改动：`period30m_api_contract.rs`（手写测试，非 design `file=` 生成）把自造不可达 URL 常量
> 改为引用 `test_support::UNREACHABLE_TEST_DB_URL` —— 否则「检测面含 `PgPoolOptions/connect_lazy`」会误伤它（它确实构造 lazy 池）。

### V2 判据（变异反证；同一门禁二进制 + `EESTOCK_GATE_REPO_ROOT=<副本>`）

变异体（`mutations/`，注入到 /tmp 副本的 `crates/web/tests/`）：

| # | 形态 | 文件 |
|---|---|---|
| (i) | `PgPool::connect` + 精确活库字面量 | `zz_mut1_eager_pgpool_connect_literal.rs` |
| (ii) | `connect_lazy` + `format!` 拼接 | `zz_mut2_connect_lazy_format_splice.rs` |
| (iii) | 仅注释提及变量名/哨兵表名（代码是 `PgPool::connect`+`format!`） | `zz_mut3_comment_only_mention.rs` |
| (iv) 附加 | 仅**文档注释**自称走 `test_support::test_pool`（代码是活库字面量） | `zz_mut4_doccomment_entry_eager.rs` |
| (v) 附加 | 仅文档注释自称入口 + `connect_lazy`+`format!` | `zz_mut5_doccomment_entry_lazy.rs` |

**迭代前→后对照**（都是**已编译门禁二进制**的实跑；`old_run_*.log` / `new_run_*.log`）：

```
OLD case=base exit=0   test result: ok. 5 passed; 0 failed
OLD case=mut1 exit=101 test result: FAILED. 2 passed; 3 failed     ← 规范形态本就被抓
OLD case=mut2 exit=0   test result: ok. 5 passed; 0 failed         ← 绕过（connect_lazy+format!）
OLD case=mut3 exit=0   test result: ok. 5 passed; 0 failed         ← 绕过（仅注释提及）
OLD case=mut4 exit=101 test result: FAILED. 2 passed; 3 failed
OLD case=mut5 exit=0   test result: ok. 5 passed; 0 failed         ← 绕过

NEW case=base exit=0   test result: ok. 5 passed; 0 failed
NEW case=mut1 exit=101 test result: FAILED. 2 passed; 3 failed
NEW case=mut2 exit=101 test result: FAILED. 4 passed; 1 failed     ← 补齐后变红（R1）
NEW case=mut3 exit=101 test result: FAILED. 3 passed; 2 failed     ← 补齐后变红（R1+R2）
NEW case=mut4 exit=101 test result: FAILED. 2 passed; 3 failed
NEW case=mut5 exit=101 test result: FAILED. 4 passed; 1 failed     ← 补齐后变红（R1）
```

逐条失败原因（`new_run_*.log`）：

```
mut1: r1(RED) r2(RED) r4(RED)
  - crates/web/tests/zz_mut1_...rs（构造池但未引用 `test_support::` 统一入口）
  - crates/web/tests/zz_mut1_...rs（急切建连但既无 `test_support::test_pool` 也无哨兵表 `_eestock_test_db` 断言）
  - crates/web/tests/zz_mut1_...rs:4（活库字面量）
mut2: r1(RED)  「构造池但未引用 `test_support::` 统一入口」
mut3: r1(RED) r2(RED)
mut4: r1(RED) r2(RED) r4(RED)
mut5: r1(RED)  「构造池但未引用 `test_support::` 统一入口」
```

**正常仓库仍 GREEN（不得误伤）**：`./target/debug/deps/adr023_e6b_testdb_env_gate_red-eaeb277aac62320f --test-threads=1`（无 `EESTOCK_GATE_REPO_ROOT`）

```
test r1_behaviour_unset_env_var_must_fail_loudly_naming_the_variable ... ok
test r1_static_every_test_file_that_builds_a_pool_must_use_test_support_entry ... ok
test r2_static_every_connecting_test_file_must_carry_sentinel_gate ... ok
test r3_init_script_exists_executable_and_covers_contract ... ok
test r4_static_no_hardcoded_live_db_url_in_test_sources ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
exit=0
```

**如实说明（静态面的边界）**：`connect_lazy` 指向「不可达地址」还是「活库地址」在**静态面无法区分**语义
（两者都是 URL）；本刀的处理是把**所有池构造**（含 lazy）收束到 `test_support::` 单一入口，
于是不再存在「自造 URL 落点」；不可达 URL 常量也只此一处（`test_support::UNREACHABLE_TEST_DB_URL`）。
若有人把该常量改成活库地址，静态面抓不住 —— 替代探针是**行为面**：R1 行为探针（未设变量必须响亮失败）
+ 哨兵表拦截（`test_support::test_pool` 内断言），两者对「误指活库」是实打实的拦截。

## F4 —— 登记 M3 语义变更（`README.md:138` 新增小节）

新增 `### 活库孤儿守卫的归属变更（M3 登记）`：

- 活库孤儿守卫**已从「测试套件」迁移为「运维检查」**；判据 = 部署后对在线实例调
  `GET /api/quality/orphans` 应为 `rows: 0`（`by_table` 逐表全 0）。
- 当前该端点**尚未部署**（线上仍 404，见 ADR-023 R-4）；需运维在部署后手工执行并登记。
- 不得把孤儿用例改回查活库（那会重新违反「测试不碰生产」）。

线上实测（只读 GET，未重启/杀 app）：

```
GET http://127.0.0.1:8081/api/quality/orphans -> 404
{"error":"not found"}
GET http://127.0.0.1:8080/api/quality/orphans -> 404
```

## V3 —— 端到端不回归

```
$ EESTOCK_TEST_DB_NAME=adr023_e6b_fixup_test bash scripts/testdb-init.sh      # 首次 16.3s，exit 0
export EESTOCK_TEST_DATABASE_URL='postgres://eestock:eestock@127.0.0.1:5433/adr023_e6b_fixup_test'
（第二次运行 0.98s，exit 0，4 张表全部「跳过播种」= 幂等）
$ EESTOCK_TEST_DATABASE_URL=... cargo test --workspace --tests --no-fail-fast
TOTAL passed=732 failed=0        # exit 0（92 个 test result: ok 行）
$ bash scripts/tests/test_adr023_e6b_testdb_gate.sh
PASS=7 FAIL=0 / VERDICT: GREEN  # exit 0
$ psql -c "DROP DATABASE adr023_e6b_fixup_test"
DROP DATABASE
$ diff db_list_before.txt db_list_after_v3.txt
V3: DB LIST == BASELINE (no residue)
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
exit=0
```

## V4 —— 零副作用

活库只读快照（`v4_live_after.log`，`PGOPTIONS='-c default_transaction_read_only=on'`）：

```
symbols=44 strategy=23 strategy_version=24 kline_accurate=16344861 kline_accurate_M1_518880_510050=1631088 kline_raw=114841
（与任务开始时实测：44 / 23 / 24 / 16344861 / 1631088 / 114841 —— 全部一致）
app_config: 仅 dcap => {"m":3,"n_l":66,"n_m":36,"n_s":8,"r_l":1.0,"r_m":1.0,"r_s":1.0,"smooth":1}（未变）
10 张 cagg 孤儿行全 0（TOTAL_ORPHANS=0，口径 = storage::reader::ORPHAN_ROWS_SQL 单一事实源）
```

仓库状态（`v4_repo_state.log` / `v4_scope.log`）：

```
HEAD=204cb77a2f345c7163b5a93da4540cd5c66f2d6f          # 未变
git diff --cached --stat                              # 空（无 staged）
git status --porcelain | wc -l = 98                   # 基线 97 ⇒ 新增的 1 条 = 本任务唯一新增的已跟踪改动：
                                                      #   M crates/web/tests/period30m_api_contract.rs（F3 连带）
porcelain 中 M 行集合：只有 README.md / period30m_api_contract.rs / scripts/testdb-init.sh(??) 等本刀既有条目
```

本任务实际编辑的仓库文件（5 个）：

```
README.md
scripts/testdb-init.sh
crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs
crates/test-support/src/lib.rs
crates/web/tests/period30m_api_contract.rs
```

## 临时资源 / 清理

- `/tmp`（证据目录内）：`tree_old_*` / `tree_new_*`（副本+变异）、`mutations/`、`mut_script/`、
  `gate_orig.rs` / `gate_bin_old` / `gate_bin_new`、各 `*.log`。
- /tmp 内已清理：`fake_deps/`（失效复现用）。`target/debug/deps/zz_gate_*_copy_bin` 临时副本已删除
  （`ls: 无匹配`）。
- 数据库：`adr023_e6b_f2_before_iso`（修前复现的脏库）与 `adr023_e6b_fixup_test`（V3 一次性库）均已 DROP；
  最终库清单 = 任务开始时的基线清单（`diff` 无输出）。
- 未在仓库留下任何临时文件（`git status --porcelain` 条目集合与基线一致，仅内容变化 + 1 条预期新增）。
