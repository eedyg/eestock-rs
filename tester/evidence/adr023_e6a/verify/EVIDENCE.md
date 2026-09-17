# ADR-023 E6a 第一刀 —— 独立验收（只验不改）EVIDENCE

- 本文件位置（绝对路径）：`/tmp/adr023-e6a-verify-20260917-013013/EVIDENCE.md`
- 验收方：Tester Agent（独立验收，**只验不改**：本 agent 未修改仓库任何文件；无 git add/commit/stash；未重启/未杀在线 app PID 178558）
- 时间戳（UTC）：2026-09-17T01:30:13Z 起 ～ 2026-09-17T02:0xZ（时间盒 30min，实际略超）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- HEAD：`d3c2092ff34af5edd117f877d547b393c5080e50`（验收前后一致，§A7）
- 契约：ADR-023 §6.1 第 8 条、§6.3 第 12 条；父级裁决 (C1) + R2 新契约 (a)–(f)
- 日志目录：`/tmp/adr023-e6a-verify-20260917-013013/logs/`

## VERDICT: PASS

（逐条 A1–A8 见下；残留风险见文末，均非阻塞项）

---

## A1 —— (C1) 落地核对（结构性）

### (1) 端口在 domain 且类型化；签名不含任何 SQL 文本参数
```
$ sed -n '294,318p' crates/domain/src/ports.rs
pub struct OrphanReport { pub rows: i64, pub by_table: std::collections::HashMap<String, i64> }
pub trait QualityRead {
    async fn divergence_rows(&self, code: Option<&str>, from: DateTime<Utc>, to: DateTime<Utc>) -> anyhow::Result<Vec<DivergenceRow>>;
    async fn orphan_rows(&self) -> anyhow::Result<OrphanReport> { anyhow::bail!("...未实现...") }
}
```
结论：**PASS**。`orphan_rows(&self) -> anyhow::Result<OrphanReport>`：仅 `&self`，无 `&str`/表清单/SQL 参数；结果类型化（`OrphanReport{rows, by_table}`）；默认实现 `bail!`（不静默返回空，替身实现不会被误当 0）。

### (2) SQL 在 storage 实现处只出现一次，覆盖 10 张表
```
$ grep -rn "NOT IN (SELECT code FROM symbols)" crates/*/src -i | wc -l         → 1 文件
$ grep -rln "not in (select code from symbols)" crates/*/src -i                → crates/storage/src/reader.rs（唯一文件）
$ sed -n '336,368p' crates/storage/src/reader.rs | grep -c "WHERE code NOT IN" → 10
$ 10 个 label：kline_accurate_{5m,15m,30m,1h,1d,1w,1mo} + kline_{5m,15m,1d}（各 1 次）
$ grep -rn "ORPHAN_ROWS_SQL" crates/ --include=*.rs | grep -v tests            → 定义 1 处(reader.rs:336) + 使用 1 处(reader.rs:382 sqlx::query_as(ORPHAN_ROWS_SQL))
$ grep -rn "ORPHAN_TABLES"   crates/ --include=*.rs | grep -v tests            → 定义 1 处(reader.rs:325)
```
`ORPHAN_TABLES = ["kline_accurate_5m","kline_accurate_15m","kline_accurate_30m","kline_accurate_1h","kline_accurate_1d","kline_accurate_1w","kline_accurate_1mo","kline_5m","kline_15m","kline_1d"]` —— 与派单 10 表**逐字一致**。
结论：**PASS**（一次定义、10 分支、10 唯一 label、10 谓词出现）。

### (3) diagnose 与 web 源码里没有孤儿检测 SQL 文本
```
$ grep -rniE "from +kline_(accurate_)?(5m|15m|30m|1h|1d|1w|1mo)" crates/web/src crates/diagnose/src --include=*.rs   → 0 行
$ grep -rn "not in (select code from symbols)" crates/web/src crates/diagnose/src -i                                → 0 行
$ grep -rn "kline_15m" crates/web/src crates/diagnose/src --include=*.rs → crates/web/src/dto.rs:28（散文注释，非 SQL）
```
结论：**PASS**。

### (4) 零新依赖边（命令 + 输出）
```
$ git status --porcelain -- '*Cargo.toml' '*Cargo.lock'      → （空）
$ cargo tree -e normal -p storage | grep -i diagnose          → （无匹配，grep exit=1）
$ cargo tree -e normal -p domain  | grep -i sqlx              → （无匹配，grep exit=1）
（完整 tree 头见 logs/02_cargo_tree.log；storage 树 = anyhow/async-trait/chrono/domain/serde/sqlx… 无 diagnose）
```
结论：**PASS**。

---

## A2 —— R2 改写的**结构性复核（独立重算，不看 diff 文本）**

独立重算方法：把 R2 断言实现（`crates/web/tests/orphan_detect_endpoint_red.rs::r2_...`，71 行）与 `orphan_probe::{CAGGS, rs_files}` **逐字抽出**为独立 harness（唯一改动：`repo_root()` 从 argv 取），用 `rustc`（无外部依赖）重编译并重跑；先在**真仓**上做保真对照，得与真 cargo 测试**同一结论（GREEN）**。

```
$ rustc --edition 2021 -O -o r2_harness r2harness/src/main.rs && ./r2_harness <repo>
HARNESS_VERDICT=GREEN  (R2 断言全部通过)        # 与 `cargo test -p web --test orphan_detect_endpoint_red` 的 ok 一致（保真对照通过）
```

**重算的断言条数/类型/期望集合**（R2 静态用例 9 条 assert 语句，展开后运行时判定次数）：
| # | 断言（原文语义） | 契约项 | 判定次数 |
|---|---|---|---|
| 1 | `defs.len() == 1`（`crates/*/src` 内谓词字面量恰一处） | (a) | 1（扫描 113 个 src .rs） |
| 2 | 该处 `ends_with("crates/storage/src/reader.rs")` | 归属钉死 | 1 |
| 3 | `hits == 10`（10 张 cagg 各作为 `from <t>` 且其后 120 字符内含谓词） | (b) | 1 |
| 4 | `!flat.contains(PREDICATE)` | (f) | 每个 web/diagnose src 文件 1 次（11+3=14） |
| 5 | 每张 cagg `!flat.contains("from <t>")` | (f) | 14 文件 × 10 表 = 140 |
| 6 | `rest.rs.contains("st.quality.orphan_rows()")` | (c) | 1 |
| 7 | `diagnose/quality.rs.contains("self.quality.orphan_rows()")` | (c) | 1 |
| 8 | `cargo tree -e normal -p storage` 不含 `diagnose` | (d) | 1 |
| 9 | `cargo tree -e normal -p domain` 不含 `sqlx` | (e) | 1 |

独立重算 (b) 的邻域距离（自写脚本，不复用测试代码）：10/10 命中，距离 **25–35 字符**（阈值 120 ⇒ 有 3.4× 余量，非临界）；`UNION ALL` 分支 = 10；谓词在常量内出现 **10** 次。
符号契约用例（`orphan_detect_sql_constant_red.rs`，8 条 assert）另加**运行期**语义：
- `ORPHAN_TABLES == CAGGS`（10 表固定顺序）；
- `ORPHAN_ROWS_SQL` 含 10 张 `from <t>`、含 `symbols`、用反连接（`NOT EXISTS`/`NOT IN`）、无 `null, null`；
- 执行该常量 → 返回 **10 行**；与端点 `by_table`/`rows` **逐表相等**。

### 「有没有被放宽？」—— 结论：**没有被放宽**，且相对旧集合净增强
- (a) 骨架不变（原先靠「10×`from`+反连接 token」识别，现改为**字面谓词**识别，更精确）；
- (b) 等价（`hits == 10` + 运行期 10 行 + 每表 `from <t>` 三重）；
- (c) 语义等价并**增强**：旧版只查符号名，新版钉调用点（`st.quality.orphan_rows()` / `self.quality.orphan_rows()`）**并**保留运行期逐表对拍；
- (d)(e)(f) 为**新增**（旧集合没有）⇒ 严格更强。
- **两处需登记的 scope 观察（非放宽意图，但影响覆盖面）**：
  - **(i)** (a) 的扫描域是 `crates/*/src`（**不含 tests**）。字面读「全仓唯一处」本应含测试文件；现口径下若将来有人把该 SQL **抄进某个测试**，(a) 不会报（不构成生产层第二份口径）。**残留风险 R-2**。
  - **(ii)** (f) 是**文本级**规则（谓词字面量 + `from <t>` 形态）。若有人用**完全动态拼接**（表名与谓词都运行时构造）绕开，两条都为绿 —— 已在 A3 以变异 M5 实证（见下）。**残留风险 R-1**。
  - **(iii)** 120 字符窗口比旧 180 字符**收紧**；收紧只可能造成**假红**（漏命中 ⇒ `hits<10` 报红），不可能假绿；且实测距离仅 25–35 字符，余量充足。

---

## A3 —— R2(f) 口径裁决复核（变异验证）

方法：`rsync` 真仓 `crates/` + `Cargo.toml`/`Cargo.lock` 到 `/tmp/.../mut/base`（3.1MB），先用 harness 复算保真（GREEN，且 (d)(e) 的 `cargo tree` 在副本内成功）；再对 5 个变异体跑**同一份** R2 断言逻辑。

| 变异 | 注入内容 | 期望 | 实测 |
|---|---|---|---|
| M1 | `ORPHAN_ROWS_SQL` **逐字**抄进 `crates/diagnose/src/quality.rs` | 红 | **RED** — `R2(a): 谓词…必须恰有一处定义（当前 2 处：mutant diagnose/src/quality.rs, storage/src/reader.rs）` |
| M2 | 同上抄进 `crates/web/src/rest.rs` | 红 | **RED** — `R2(a) … 当前 2 处：[storage/src/reader.rs, web/src/rest.rs]` |
| M3 | **手写等价式**（`NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code=c.code)`，谓词字面量不同）抄进 diagnose | 红 | **RED** — `R2(f): …/diagnose/src/quality.rs 不得内联 cagg 检测 SQL（命中 'from kline_accurate_5m'）` |
| M4 | 仅**散文注释**提到 `kline_5m/kline_accurate_15m/kline_1d`（无 SQL） | 绿 | **GREEN**（收窄口径不误报，与既有 `web/src/dto.rs:28` 同型） |
| M5 | **完全动态拼接**（`format!("…FROM {} WHERE code NOT IN (SELECT code FROM {})", table, sym)`） | — | **GREEN（逃逸）** ⇒ 登记为残留 R-1 |

结论：**PASS**。收窄到「谓词 + `from <表>` 的 SQL 形态」**并未掩盖真实 SQL 拷贝**——逐字拷贝（M1/M2）与换写法的等价拷贝（M3）都变红；同时不误伤散文表名（M4）。唯一未覆盖形态是**完全动态拼接**（M5），属文本型 lint 的固有边界，登记为残留而非 FAIL（契约 (f) 原文即规定文本形态）。

---

## A4 —— 检测有效性（隔离库，绝不在活库）

脚本：`/tmp/adr023-e6a-verify-20260917-013013/a4_isolated_db.sh`、`a4ep_a8_isolated.sh`；日志 `logs/07_a4_isolated_db.log`、`logs/12_a4ep_a8.log`。

1. `CREATE DATABASE eestock_e6a_verify_20260917`（活库 `eestock` 未被触碰；全程只读 SELECT 于活库）
2. migrations `0001..0026` **按序** `psql -f`（`ON_ERROR_STOP=1`，逐文件非单事务）⇒ 26/26 `exit=0`；`timescaledb_information.continuous_aggregates` = **10**
3. 基线检测（隔离库）= 10 表全 0
4. 插 2 行孤儿 fixture（`998801`@`2026-09-03 01:30Z`、`998802`@`01:35Z`，`period='M1'`，`symbols` 内 0 行）→ `CALL refresh_continuous_aggregate('kline_accurate_5m','2026-09-03 01:00Z','2026-09-03 02:00Z')` ⇒ 物化 **2** 行
5. **与端点同一份 SQL 来源**（从 `crates/storage/src/reader.rs` 抽出的 `ORPHAN_ROWS_SQL` 原文，落盘 `orphan_rows_sql_extracted.sql`）⇒ 逐表 `kline_accurate_5m|2`、其余 9 表 0，**total = 2**
6. **走端口（真链路）**：`DATABASE_URL=…/eestock_e6a_verify_ep_20260917 cargo test -p web --test orphan_detect_endpoint_red r1_*`
   ⇒ `assertion left == right failed … left: 2 right: 0`（端点经 `rest.rs → QualityService::orphan_rows → QualityRead::orphan_rows → storage` **报出 2**；同时证明 R1 的 0 断言是活哨兵，见 A8）
   另：`cargo test -p web --test orphan_detect_sql_constant_red`（隔离库，含 2 孤儿）⇒ **2 passed**（端点 `by_table`/`rows` 与共享 SQL **逐表相等**——这是活库全 0 状态下**不可能**证伪的强证据）
7. 删 2 行 → **同窗** refresh ⇒ 逐表全 0（**total = 0**）
8. `DROP DATABASE … WITH (FORCE)` ⇒ `residual_db_count=0`（`pg_database where datname like 'eestock_e6a%'`），`live_db_exists=1`

结论：**PASS**（检测=2 → 删+同窗 refresh=0；端点与 SQL 单一来源一致；隔离库零残留）。

---

## A5 —— clean() 语义与**跨测试干扰**（重点）

### (1) 四个 clean 的窗口：按夹具跨度取值 + 逐字符桶边界
| clean | 表 | 窗口（原文） | 夹具跨度 | 桶边界核对 |
|---|---|---|---|---|
| `api_kline_period.rs::clean`(997732) | `kline_accurate_1w/1mo` | `['2026-07-31 16:00:00+00','2026-10-31 16:00:00+00')` | 2026-08-31 01:30Z / 02:00Z + 2026-09-07 01:30Z | 两端 = CST 月桶起点（+8h ⇒ 08-01 00:00 CST / 11-01 00:00 CST）✓；含周桶 `[08-30 16:00Z,09-06 16:00Z)`、`[09-06 16:00Z,09-13 16:00Z)` 与月桶 8/9 月，**整桶落窗** ✓ |
| `api_rest.rs::clean_kline`(996601) | `kline_5m` | `['2026-09-03 01:30:00+00','2026-09-03 01:35:00+00')` | base=09-03 01:30Z 5 根 1m | 5m 桶端点（:30/:35 为 5min 整点）✓ |
| 同 | `kline_1d` | `['2026-09-02 16:00:00+00','2026-09-03 16:00:00+00')` | 同上 | = CST 09-03 日桶（+8h ⇒ 09-03 00:00→09-04 00:00 CST）✓ |
| `api_rest.rs::clean_sym`(996602) | `kline_1d` | 同上 | `seed_bars(SCODE,2)` = 09-03（`api_rest.rs:200`） | ✓ |
| `kline_reader.rs::clean`(通用) | intraday+D1：`accurate_{5m,15m,1h,1d}`、`5m/15m/1d` | `[cst_day_start(lo), cst_day_start(hi)+1d)`（由 `min/max(ts) over kline_accurate ∪ kline_raw` 删前推导） | 每 code 自身夹具 | CST 日 = 24h，是 5m/15m/1h 桶整数倍且端点对齐（16:00Z）✓ |
| 同 | `kline_accurate_1w/1mo` | `[cst_month_start(lo,0), cst_month_start(hi,2))` | 同上 | 整周/整月桶须**完全**落窗 ⇒ 上界取 hi 所在 CST 月 + 2 个月首 ✓ |
| `api_rest.rs:151`（原 `NULL,NULL`） | `kline_5m` | `['2026-09-03 01:30:00+00','2026-09-03 01:35:00+00')` | 同上 | ✓（R5 静态判据全文禁 `NULL,NULL`） |
结论：**窗口均由夹具跨度推导、逐字符落在桶边界**；`NULL,NULL` 已清零（`orphan_detect_endpoint_red` 的 R5 用例在真跑中 ok）。

### (2) 跨测试干扰面（**重点**）：有没有测试依赖「某桶刻意未物化」？
**穷举法**：全仓测试 refresh 调用点 = **24 处**（R5 打印计数）；`refresh_continuous_aggregate` 仅出现在 `storage/tests/kline_reader.rs`、`web/tests/api_rest.rs`、`web/tests/api_kline_period.rs`、`storage/tests/period30m_migration.rs`（后者只读迁移文本，不执行）；`alert/application/collector` 测试**不含** kline cagg 依赖（仅把 `Period::D1` 当配置字段，无 kline 写入/读取）。

**依赖「未物化」的断言全仓唯一一处**：`crates/storage/tests/kline_reader.rs:671 symbols_latest_prev_close_is_prev_trading_day_d1` 的
`assert!(new.prev_close.is_none(), "无 D1 历史的新标的 → prev_close NULL")`（CODE_D1_NEW=997775，夹具 `2026-08-20 01:30Z` 单行 M1）。

**逐窗口可达性判定**（目标桶 = CST 2026-08-20 日桶 = UTC `[2026-08-19 16:00Z, 2026-08-20 16:00Z)`，只受 `kline_accurate_1d` / `kline_1d` 影响）：
- `kline_reader::clean`（d1 窗）逐 code：base() 码 ⇒ `[2026-09-02 16:00Z, 09-04 16:00Z)`；CODE_WM(997733) ⇒ `[2026-08-30 16:00Z, 09-07 16:00Z)`；CODE_DEEP ⇒ `[2023-12-31 16:00Z, 2024-01-03 16:00Z)`；CODE_WM_DEEP ⇒ 2023 段；CODE_D1_YDAY/GAP ⇒ 动态近期(09-1x)；CODE_BRANCH/CODE_FORMING/CODE_QUAL/CODE_LATEST/CODE_SYM* ⇒ base() 日；**无一包含 08-19 16:00Z**（CODE_WM 的下界 08-30 16:00Z 晚于 08-19 16:00Z）
- `refresh_d1`（:98）两处调用：`[2026-09-02 00:00Z, 2026-09-04 00:00Z)`、`[y0-5d, today0+1d)` ⇒ 不含
- `kline_reader.rs:353` 窗口 `[2026-09-02 00:00Z, 2026-09-04 00:00Z)`（含 `accurate_1d`）⇒ 不含
- `api_rest.rs:206`（`kline_1d`）`[2026-09-02 00:00Z, 2026-09-04 00:00Z)`、`api_rest.rs:128` `[09-02 16:00Z, 09-03 16:00Z)` ⇒ 不含
- 唯一会重算该桶的是 **CODE_D1_NEW 自己的 clean()**（`[2026-08-19 16:00Z, 2026-08-21 16:00Z)`）—— 属测试**自清理**（其断言在此之前完成）
- W/MO 窗（含 `[07-31 16:00Z,10-31 16:00Z)`）只重算 `kline_accurate_1w/1mo`，与 D1 昨收路径无关；反向污染（W/MO 桶被提前物化）也无人断言「W/MO 桶缺失」
- 其它方向：`refresh` 是**按当前源表行重算**（非追加），对同一 code 的断言**确定性**（如 `api_kline_period` 的 `bars.len()==2`、`kline_reader` 的 W/MO 聚合值），并行 clean 不会造成假绿/假红

**结论：无跨测试干扰**（P1-1 的 refresh 不会物化任何被刻意保持未物化的桶）；worker 自述的返工根因（全局宽窗物化 CODE_D1_NEW 桶）在本版**已由跨度推导窗口消除**，并经上表逐窗口独立复核。经验证据：`cargo test --workspace --tests` 全量 **727 passed / 0 failed**，其中 `symbols_latest_prev_close_is_prev_trading_day_d1` ok。

---

## A6 —— 端点与回归

| 判据 | 命令 | 原始结果 | 结论 |
|---|---|---|---|
| 端点逐表可读、总数 0 | 真跑 `orphan_detect_endpoint_red::r1_...`（in-process router + **活库** eestock，只读 GET） | `test r4a... ok / ... r1... ok`（4 passed）；`rows == Σ by_table == 0`、10 键全 0、`by_table` 键数 == 10 逐条断言通过 | PASS |
| 端点与 SQL 单一来源对拍 | `orphan_detect_sql_constant_red`（活库） | `2 passed` | PASS |
| 在线 app 工件 | `curl :8081/api/quality/orphans` | **HTTP 404** —— 在线二进制（PID 178558，启动 9h36m 前）**早于本轮改动**；按纪律**未重启**，端点绿由进程内 router 用例建立 | 记录（未决项 R-4） |
| 缠结门禁 | `./scripts/check-tangle.sh` | `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。` **EXIT=0** | PASS |
| 后端全量 | `cargo test --workspace --tests` | **90 个目标 `test result: ok`；passed=727, failed=0, ignored=1；CARGO_EXIT=0**（1m04.9s） | PASS |
| 前端单测 | `npx vitest run` | `Test Files 88 passed (88)` / `Tests 839 passed (839)` / `VITEST_EXIT=0` | PASS |
| 前端构建 | `npm run build` | `✓ built in 1.95s` / `BUILD_EXIT=0` | PASS |
| 既有断言未弱化/删除 | 三文件断言行 vs HEAD 逐字对照 | `api_rest.rs` 23=23、`kline_reader.rs` 101=101、`api_kline_period.rs` 11=11；归一化行号后 **内容逐字相同**（仅行号位移） | PASS |

---

## A7 —— 副作用审计（含诚实披露复核）

| 项 | 命令/证据 | 结果 |
|---|---|---|
| 跑完全量测试后孤儿总数 | 活库只读 SELECT（10 表反连接） | **10 表全 0**（`logs/11_a7_post_test.log`），与测试前一致 ⇒ 清理成果**未被回退** |
| 测试残留 fixture | `symbols` 内 `^99[5-9]` = 0；`kline_accurate` 内 997711/721/732/733/751/752/773 = 0 | 0 / 0 |
| HEAD | `git rev-parse HEAD` | `d3c2092ff34af5edd117f877d547b393c5080e50`（验收前后一致） |
| staged / stash / Cargo | `git diff --cached --name-only` / `git stash list` / `git status -- '*Cargo.toml' '*Cargo.lock'` | 空 / 空 / 空 |
| 隔离库残留 | `pg_database … like 'eestock_e6a%'` | **0**（A4 一轮 + A4EP/A8 一轮，各自 `DROP DATABASE … WITH (FORCE)` 后复核） |
| 在线 app | `ps -o pid,etime -p 178558` | **PID 178558 未变**（etime 由 09:31:27 → 09:36:04 自然增长），未重启未杀 |
| 容器 | `docker ps` | `eestock-timescaledb … Up 11 days (healthy)`、`eestock-data … Up 11 days (healthy)`（未动） |
| worker 披露「全量测试连共享 dev 库并写 eestock（各 fixture）」 | 独立确认：跑完 10 表孤儿 0、无残留 fixture 码 | **属实**（本 agent 对活库**只做 SELECT/GET**） |

---

## A8 —— 兜底风险：哨兵是否真的有效

1. **正向**：隔离库物化 2 行孤儿 ⇒ R1（`assert_eq!(rows, 0)`）**变红**，panic 原文 `left: 2 / right: 0`（`logs/12_a4ep_a8.log` STEP 5）⇒ 「rows==0」确实是活哨兵。
2. **未覆盖窗口形态**（= P1-1 的真实失效面）：隔离库插入 `998911`@`2026-09-04 05:00Z` → refresh `[05:00,05:05)` 物化 → **删行但不 refresh 该窗** ⇒ 5m 分支探针 **3**（原 2 孤儿 + 1 未覆盖孤儿，`kline_accurate_5m|3`）；随后**同窗 refresh** ⇒ **2**。
   ⇒ 机械上证明：「将来某测试 refresh 未被 clean 覆盖的 cagg/窗口」会留下可被同一份 SQL 检出（且被 R1 的 `rows==0` 断言抓住）的孤儿。
3. 此外 10 表全覆盖（A1-2）+ 单一定义（A1-2/A2）保证哨兵视野无盲区（**除**完全动态拼接形态，R-1）。

结论：**PASS**。

---

## 残留风险 / 未决项（均非 FAIL，登记交接）

- **R-1（低）**：R2(f) 是文本级规则；**完全动态拼接**的 SQL（表名与谓词都在运行时构造）可逃逸（A3 M5 实证）。建议后续若收紧，可加「禁止在 web/diagnose 出现 `refresh_continuous_aggregate`/`code NOT IN` 的动态拼接」或改为 AST/白名单式检查。
- **R-2（低）**：R2(a) 扫描域仅 `crates/*/src`；测试内若出现第二份检测 SQL 不会被报（生产层意图不受影响）。
- **R-3（中，既有）**：`cagg_refresh_lock()` 只在**单 binary 内**串行化；`storage/tests/kline_reader.rs` 与 `web/tests/api_rest.rs`/`api_kline_period.rs` 属不同进程，窗口重叠时仍可能 55P03。本轮全量只跑 1 次（EXIT=0），**未做重复跑以证不 flaky**（时间盒）。
- **R-4（流程）**：在线 app（PID 178558）**未含**本轮端点（`:8081/api/quality/orphans` = 404）；端点的 200/0 由进程内 router 用例（活库）建立，**部署/重启不在本验收范围且被纪律禁止**。
- **R-5（既有债，P0）**：全量测试仍按既有设计连**共享活库** `eestock` 并写各自 fixture（§6.1 第 8 条隔离债本轮未动）。A7 证明「跑完净 0 孤儿」，但**测试中途中止/崩溃**仍可能留残留（本轮未构造该故障）。
- **R-6（低）**：R2(c) 的两条是**子串**匹配（注释里出现调用文本亦可满足）；由「运行期逐表对拍」+ A4 隔离库端点实证兜底。
- **时间盒**：30 分钟时间盒**略超**（收尾已完成：隔离库均 DROP 且残留复核为 0；未改动仓库任何文件）。

## 证据索引
- `logs/00_*` 基线（git/docker/pid）、`logs/01_orphan_symbols.log`、`logs/02_cargo_tree.log`
- `logs/03_caggs.log`、`logs/04_orphans_pre.log`、`logs/05_check_tangle.log`
- `logs/06_cargo_test_workspace.log`（全量）、`logs/10_vitest.log`、`logs/13_npm_build.log`
- `logs/07_a4_isolated_db.log`、`logs/12_a4ep_a8.log`（A4/A8；SQL 抽离件 `orphan_rows_sql_extracted.sql`、`a4_isolated_db.sh`、`a4ep_a8_isolated.sh`）
- `logs/09_a6_assert_verbatim*.log`（断言行 vs HEAD）
- `logs/11_a7_post_test.log`（A7）
- `logs/14_r2_harness_real_repo.log`（保真对照）、`logs/15_a3_mutations.log`（A3 变异 M1–M5）、`logs/16_a2_proximity.log`（A2 独立重算）、`logs/17_live_app_probe.log`
- harness 源码：`r2harness/src/main.rs`（逐字抽取）、`r2_harness`（已编译）
- 变异副本：`mut/{base,m1..m5}`（/tmp，未触碰仓库）
