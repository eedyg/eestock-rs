# 295 — ADR-023 E6b 第二刀（红→绿）：所有测试池指向测试库 + 哨兵门禁 + `testdb-init.sh`

- **本文件位置（绝对路径）**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/295_adr023_e6b_impl_testdb_env_gate.md`
- 类型：**实现报告**（红→绿第二刀；未改 tester 红测试、未 commit/add/stash）
- 前置红测试：`crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs`（R1–R5）、`scripts/tests/test_adr023_e6b_testdb_gate.sh`（R3）
- 契约：ADR-023 §6.1 第 8 条（测试隔离债）+ §6.3 第 12 条（测试残留污染生产 cagg）
- 证据目录：`/tmp/adr023-e6b-impl-20260917T035254Z/EVIDENCE.md`

---

## 1. 目标行为（已实现）

1. 所有集成测试的连接池**只**从 `EESTOCK_TEST_DATABASE_URL` 取；**未设即响亮失败**（panic 信息含变量名）。
2. 建池后断言哨兵表 `_eestock_test_db` 存在且值 = `test`；误指活库即响亮失败。
3. 新增 `scripts/testdb-init.sh`：幂等建库 + 按 `migrations/*.sql` 顺序应用 + 建哨兵表 + **只读基线播种** + 打印 export 行。
4. README 增加「跑集成测试的前置步骤」，并说明「未设变量即响亮失败是刻意设计」。

---

## 2. 改动清单

### 2.1 新增（未进 Dockerfile、无新外部依赖）

| 产物 | 说明 |
|---|---|
| `crates/test-support/Cargo.toml`（10 行） | dev-only crate，仅依赖 workspace `sqlx` |
| `crates/test-support/src/lib.rs`（59 行） | `pub async fn test_pool() -> PgPool`：读 env → 连接 → 哨兵断言 → 返回池（**DRY 唯一入口**） |
| `scripts/testdb-init.sh`（163 行，mode 755） | 幂等初始化：建库 / 迁移（账本）/ 哨兵 / 只读基线播种 / export |

### 2.2 doc-first（改 `design/**` → `entangled tangle` 重新生成，13 个文件）

`entangled tangle`（**非 --force**）输出恰写明这 13 个目标：`kline_reader.rs, api_rest.rs, ws_poller.rs, symbol_admin.rs, api_admin.rs, api_quality.rs, mcp_tools_db.rs, alert_store.rs, api_alerts.rs, accurate_upsert.rs, raw_writer.rs, event_sink.rs, symbols_registry.rs`。

| 文档 | 声明文件 |
|---|---|
| `design/07-app-plane/00-web-api.md` | kline_reader / api_rest / ws_poller / symbol_admin / api_admin / api_quality（6） |
| `design/07-app-plane/01-mcp.md` | mcp_tools_db（1） |
| `design/07-app-plane/02-alerts.md` | alert_store / api_alerts（2） |
| `design/04-storage/02-tushare-sync.md` | accurate_upsert（1） |
| `design/04-storage/03-raw-writer.md` | raw_writer / event_sink / symbols_registry（3） |

**产物真更新证据**：13/13 目标 mtime 均新于改前（`...1789617275` / 见 `docfirst_evidence.txt`），grep 命中 `test_support::test_pool`、活库字面量 = 0；`entangled tangle` 日志 `write` 恰 13 条。更强证据 = V2 门禁沙箱全量重生成逐字节一致（exit 0）。

### 2.3 手写改动

- **19 个手写会连库测试文件**：`pool()` / 内联建池 → `test_support::test_pool().await`
  （mcp 1：d11_fee_profile_e2e；web 8：api_favorites/api_kline_period/api_ma_config/api_multi_period_config/api_settings/api_strategies/api_workbench/orphan_probe；storage 10：backtest/config_store/favorite_store/fee_profile_store/ma_config_store/sim_store/strategy_store/symbol_type_fee_migration/workbench_store）
- `crates/web/tests/period30m_d2_multiperiod_red.rs`：`live_snapshot()` 的 `DATABASE_URL` + `PgPoolOptions` 兜底 → `test_support::test_pool()`（快照/恢复由此只作用于测试库）
- `crates/strategy-runtime/tests/dcap_{cross_runtime,plugin_replay}.rs`：仅注释里的活库 URL 字面量 → `$EESTOCK_TEST_DATABASE_URL`（无池构造）
- 每个 crate 的 `[dev-dependencies]` 增 `test-support = { path = "../test-support" }`（storage/web/mcp）
- `Cargo.lock`：+10 行（仅新增 path crate `test-support`，**无新外部 crate**）
- `README.md`：新增「跑集成测试的前置步骤（ADR-023 E6b）」

**合计**：45 个已跟踪文件改动（+148 / −154），34 个测试文件、5 份 design 文档（另 1 份 ADR-023 是改前既存修改，非本刀）、3 个 Cargo.toml、Cargo.lock、README；新增 3 个文件（test-support ×2 + 脚本）。

---

## 3. 架构对齐

| 改动 | 层 / 边界 | 理由 |
|---|---|---|
| `crates/test-support` | **dev-only 基础设施**，只被 `[dev-dependencies]` 引用 | 不进运行时依赖图（`cargo tree -e normal` 不含）、不进 Dockerfile 镜像 |
| 测试文件建池调用 | 测试层 | 不触碰 src 接口 / 事件契约 / 层边界 |
| `scripts/testdb-init.sh` | 工程脚本 | 只写测试库；对活库只读（`PGOPTIONS='-c default_transaction_read_only=on'`），拒绝库名 `eestock` |
| 5 份 design 文档 | 事实源 → 生成物 | 遵守 ADR-007/018 单向工作流（doc-first + `entangled tangle`，未用 `--force`） |

**未引入**任何运行时依赖、框架、接口变更；未动 `composed/measured` 优先级；未重启/杀在线 app。

---

## 4. 实现要点

### 4.1 哨兵门禁（`test_support::test_pool`）

读 `EESTOCK_TEST_DATABASE_URL`（未设/空 → panic，信息含变量名）→ `PgPool::connect`（失败 → panic）→ `SELECT value FROM _eestock_test_db LIMIT 1`，值必须 `=test`（缺失/值错 → panic，信息含哨兵表名）。

### 4.2 `scripts/testdb-init.sh`（幂等）

- 建库：`pg_database` 判存在；默认 `eestock_test`，可 `EESTOCK_TEST_DB_NAME/PORT/HOST/USER/PASSWORD` 覆盖；库名 `eestock` 直接拒绝。
- 迁移：账本 `_eestock_test_migrations`；`psql -v ON_ERROR_STOP=1 -f`（**不加 -1**）；已应用跳过；既有完整 schema 无账本时「认领」不重放（迁移 DDL 本身多半不幂等）。
- 哨兵：`CREATE TABLE IF NOT EXISTS` + 单行 `test`（存在即不重复插入）。
- **只读基线播种（父级裁决 A）**：按「目标表非空即跳过」；源=活库（默认 `eestock`），连接强制只读事务；源不可达 → exit 3 响亮失败。播种集由 8 例失败的真实前提反推：

| 表 | 行数（实测） | 反推的用例 |
|---|---|---|
| `symbols` | 44 | fee_profile_store、symbol_type_fee_migration、mcp list_symbols/get_kline |
| `strategy` / `strategy_version` | 23 / 24 | mcp strategy_list_slim（真实 published Registry） |
| `kline_accurate`（518880+510050 的 M1） | 1,631,088 | kline_reader merged_1m 性能门禁（≥500 根）、d11_fee_profile_e2e（510050 D1） |
| `kline_accurate_1d`（由 M1 全量刷新派生） | 6,768 | d11_fee_profile_e2e（`kline_accurate_1d` 区间） |

- 刷新：`CALL refresh_continuous_aggregate('kline_accurate_1d', NULL, NULL)`（**NULL/NULL 全量无窗口** ⇒ 天然不触及「刷新窗口须按 CST 桶边界对齐」硬规则）。
- stdout **只**留 `export EESTOCK_TEST_DATABASE_URL='...'`（其余日志/psql 输出全走 stderr），故 `eval "$(scripts/testdb-init.sh)"` 可直接用。

---

## 5. 验证（每条原始输出见证据目录）

| # | 命令 | 结果 |
|---|---|---|
| **V1** | 红：`cargo test -p storage --test adr023_e6b_testdb_env_gate_red` / `bash scripts/tests/test_adr023_e6b_testdb_gate.sh` | 红 `0 passed; 5 failed` (exit 101) + shell `PASS=0 FAIL=1 RED` |
| | 绿：同上（改后） | **`5 passed; 0 failed`** + shell **`PASS=7 FAIL=0 GREEN`** |
| **V2** | `./scripts/check-tangle.sh` | **exit 0**（沙箱全量重生成逐字节一致） |
| **V3** | `scripts/testdb-init.sh` 建 `adr023_e6b_v3_test`（17s）→ `cargo test --workspace --tests --no-fail-fast` | **732 passed / 0 failed / exit 0**（连跑两轮一致）；`npx vitest run` 88 files/839 tests 全过；`npm run build` exit 0（前端不受影响，仅既有 chunk 体积警告） |
| **V4** | `env -u EESTOCK_TEST_DATABASE_URL cargo test -p storage --test kline_reader` | **exit 101**，信息含 `EESTOCK_TEST_DATABASE_URL` |
| | `EESTOCK_TEST_DATABASE_URL=<活库> ...` | **exit 101**，哨兵拦下（`_eestock_test_db ... does not exist`） |
| **V5** | 全量测试后活库只读快照 before/after `diff` | **IDENTICAL**：10 张 cagg 孤儿全 0、`app_config` key/值未变（仅 `dcap`）、`symbols`=44 且指纹一致；HEAD 未变（`204cb77a`）；**无 staged**；仓库内无临时残留 |

**测试库去向**：保留 `adr023_e6b_v3_test`（供验收复用；清理 `dropdb -h 127.0.0.1 -p 5433 -U eestock adr023_e6b_v3_test`）；`adr023_e6b_gate_iso` 归 shell 门禁所有（每次运行重建）；中间库 `adr023_e6b_impl_test` 已 DROP。`e6b_red_iso/iso2` 是 tester 前置产物，未动。

---

## 6. 残留风险

1. **`scripts/testdb-init.sh` 的播种依赖活库可达**（源 `eestock` default，可 `EESTOCK_LIVE_DB_NAME` 覆盖）。源不可达即 exit 3（响亮失败，不产出空测试库）——这是父级裁决 A 的明确边界，不是缺陷。
2. **测试库体积**：播种 1.63M M1 行（~17s），测试库不能纯离线自举；若需纯离线的 CI，需另出静态 fixture（超出本轮）。
3. **`crates/tushare/src/bin/tushare_sync.rs:23` 仍有活库兜底默认**（**src**，非测试文件，R4 判据不覆盖）。测试已不再回退活库；该 bin 属运行期工具，未在本刀范围（tester 293 §7-7 登记）。
4. **R1/R2 静态面在「全部池已集中」后为空集**（0 个会连库测试文件）——门禁靠行为探针（kline_reader 二进制）兜底；这是 DRY 集中的必然结果。
5. 5 份 design 文档的单文档 mtime 会被同文档后续块编辑推后；本刀以「门禁沙箱全量重生成逐字节一致（V2 exit 0）」为更强证据。
6. 播种的 `strategy`/`symbols` 是活库快照，若活库结构/数据演进，播种集需同步（脚本按表非空跳过，不会破坏已初始化的库）。

---

## 7. 合规声明

- 未修改 tester 红测试（`adr023_e6b_testdb_env_gate_red.rs`、`test_adr023_e6b_testdb_gate.sh`）与任何断言；未 skip/ignore/放宽。
- 未 `git add/commit/stash`（工作区全部未 staged）。
- 未对活库 `eestock` 做任何写（仅只读 SELECT/COPY）；未重启/杀在线 app；未改 `.gitignore`；未动其他项目。
- 未使用 `entangled tangle --force`、未全局 `stitch`。

---

# 附录 A — E6b 第二刀「收尾修正 4 项」（2026-09-17T04:24:01Z UTC，验收残留 F1–F4）

- **本文件位置（绝对路径）**：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/295_adr023_e6b_impl_testdb_env_gate.md`（本节为**追加**，未新建编号）
- 输入：E6b 第二刀独立验收（核心 PASS；F1/F2/F3/F4 残留）
- 证据目录：`/tmp/adr023-e6b-fixup-20260917T041228Z/EVIDENCE.md`（含各条原始输出）
- 时间盒：25 min（实际在盒内完成）

## A.1 改了什么（文件:行）

| # | 文件:行 | 改动 |
|---|---|---|
| **F1** | `README.md:117` | 新增 `### 播种契约（测试库 = 活库的只读快照，只播最小基线）`：播种清单与**实测行数**（`symbols`=44 / `strategy`=23 / `strategy_version`=24 / `kline_accurate`=1,631,088 / 派生 `kline_accurate_1d`=6,768）+ 只播 **4 张表**（活库 `public` 共 **37** 关系 = 26 表 + 11 视图）+ 从活库**只读快照** + **目标表非空即跳过** + **活库演进后需重新供应**（dropdb + 重跑） |
| **F2** | `scripts/testdb-init.sh:51-75` | `LIVE_DB_NAME/LIVE_URL/require_live` 上移到 `0) 源库可达性（建库之前预检）`；`1) 建库` 的 else 分支在建 `CREATE DATABASE` 前调 `require_live`（`:73`）⇒ 源不可达时 `exit 3` 且**不留新库**。库已存在时不预检（保持离线幂等重跑） |
| **F3** | `crates/storage/tests/adr023_e6b_testdb_env_gate_red.rs` `:55 / :102 / :168 / :177 / :190 / :215 / :239` | 检测面扩到 `connect_lazy(` / `PgPoolOptions` / `PoolOptions` / `Pool::connect(`；新增 `code_only()` **去注释**后判定；R1 改为断言**行为落点**（构造池文件必须引用 `test_support::`，急切建连文件必须调 `test_support::test_pool`）；R2 改为「`test_support::test_pool` 或哨兵表名」；`repo_root()` 支持 `EESTOCK_GATE_REPO_ROOT` 指向 /tmp 副本（变异反证）；自身排除改为**按文件名** |
| **F3（连带）** | `crates/test-support/src/lib.rs:22`、`crates/web/tests/period30m_api_contract.rs:24` | 新增 `pub const UNREACHABLE_TEST_DB_URL`（不可达 URL 的唯一落点），`period30m_api_contract.rs` 的自造常量改为引用它 —— 否则「检测面含 `PgPoolOptions/connect_lazy`」会**误伤**该手写契约测试（它确实构造 lazy 池）。该文件**非** `file=` 生成物（design 无声明），仅 1 行常量替换 |
| **F4** | `README.md:138` | 新增 `### 活库孤儿守卫的归属变更（M3 登记）`：守卫从「测试套件」迁移为「运维检查」，判据 = 部署后 `GET /api/quality/orphans` 应为 `rows: 0`；注明该端点当前**尚未部署**（线上仍 404，见 R-4）；并写明不得把用例改回查活库 |

未改：`design/**`（本节无需 doc-first，门禁与 README 不属 entangled 声明面）、tester 的 `scripts/tests/test_adr023_e6b_testdb_gate.sh`、任何断言语义、`.gitignore`。

## A.2 判据（原始输出见证据目录）

**V1（F2）** —— 不存在的源库名：修后 `exit=3` + 错误信息清楚 + **库清单与基线 `diff` 无输出**；
修前对照（同脚本仅去掉建库前预检）`exit=3` 但留下 schema-only 脏库 `adr023_e6b_f2_before_iso`（`symbols`=0）→ 已 DROP。

**V2（F3）** —— 同一门禁二进制 + `/tmp` 副本（`EESTOCK_GATE_REPO_ROOT`）：

| 变异 | 迭代前 | 迭代后 |
|---|---|---|
| (i) `PgPool::connect`+活库字面量 | RED（3 failed） | RED（R1+R2+R4） |
| (ii) `connect_lazy`+`format!` | **GREEN（绕过）** | **RED**（R1） |
| (iii) 仅注释提及变量名/哨兵表名 | **GREEN（绕过）** | **RED**（R1+R2） |
| (iv) 附加：仅文档注释自称入口（急切） | RED | RED（R1+R2+R4） |
| (v) 附加：仅文档注释自称入口 + lazy 规避 | **GREEN（绕过）** | **RED**（R1） |
| 副本基线（无变异） | GREEN | GREEN |
| **正常仓库**（无 env 覆盖） | GREEN | **GREEN（5 passed / 0 failed，无误伤）** |

**V3（端到端不回归）** —— `scripts/testdb-init.sh` 建一次性库 `adr023_e6b_fixup_test`（16.3s，二次 0.98s 幂等）→
`cargo test --workspace --tests --no-fail-fast` = **732 passed / 0 failed / exit 0**；
shell 门禁 `PASS=7 FAIL=0 VERDICT: GREEN`；DROP 后库清单 = 基线（无残留）；`./scripts/check-tangle.sh` exit 0。

**V4（零副作用）** —— 活库只读快照：`symbols`=44、`strategy`=23、`strategy_version`=24、
`kline_accurate_M1_518880_510050`=1,631,088、`kline_accurate` 全量=16,344,861、`kline_raw`=114,841（均与开工时一致）；
`app_config` 仅 `dcap` 未变；10 张 cagg 孤儿行全 0；HEAD 未变（`204cb77a`）；**无 staged**；
porcelain 条目数 97→98，新增的唯一一条即 F3 连带的 `M crates/web/tests/period30m_api_contract.rs`（其余均为本刀既有条目）。

## A.3 残留风险

1. **静态面无法区分「lazy 指向不可达」与「lazy 指向活库」**（两者都是 URL）。处理 = 把**所有池构造**（含 lazy）
   收束到 `test_support::` 单一入口 + 不可达 URL 常量只此一处；若有人把 `UNREACHABLE_TEST_DB_URL` 改成活库地址，
   静态面抓不住 —— **替代探针**是行为面：未设变量必须响亮失败 + 哨兵表拦截（两者都是实拦截）。已写入门禁文件头与本节。
2. **`code_only()` 是简化实现**：不识别 Rust raw string（`r#"…"#`）与字符字面量 ⇒ 若有人把 `test_support::`
   这类入口串**写进字符串字面量**里，静态面可能误判为「已走入口」。R4 仍按原始源码扫描（活库字面量逃不掉），
   行为探针不受影响。属静态分析的固有边界，**如实登记**。
3. **F2 采取的是「预检提前」而非「失败即 DROP」**：只保证「源不可达不留新库」。若库已存在（非本脚本创建）则无新库问题；
   若建库后**迁移中途**失败，仍可能留下半成品库（旧行为，不在本次判据内）—— 运维可 `dropdb` 重跑，脚本本身幂等。
4. F4 登记的运维检查目前**无人自动执行**（端点未部署，线上 404）—— 需部署后手工执行 `GET /api/quality/orphans`
   并登记 `rows: 0`；这是 M3 语义变更的已知空窗。
