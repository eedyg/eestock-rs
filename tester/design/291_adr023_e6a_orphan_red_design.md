# 291 — ADR-023 孤儿行治本（第一刀 P1-1/P2-1/P1-2）红测试 —— **设计报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/design/291_adr023_e6a_orphan_red_design.md`
- 类型：**Design report**（本轮**新设计并新编写**红测试；不改实现、不改既有测试）
- 执行报告（红证据）：`tester/test/291_adr023_e6a_orphan_red_execution.md`
- 证据目录：`/tmp/adr023-e6a-red-20260917T010800Z/EVIDENCE.md`
- 契约：`design/01-architecture/adr/ADR-023-period-set-extension-30m.md` §6.1 第 8 条（测试隔离债）+ §6.3 第 12 条（孤儿行缺陷与清理记录）
- 范围：**第一刀**——不改「测试连库方式」（P0 不动）。P1-1 `clean()` 删完即重算受影响窗口；P2-1 测试内禁 `refresh_continuous_aggregate(NULL,NULL)`；P1-2 新增 `GET /api/quality/orphans` 常态检测。

## 1. 交付物（本报告设计的测试）

| 产物 | 落位 | 判据 |
|---|---|---|
| A. 端点 + 静态判据红测试（4 用例） | `crates/web/tests/orphan_detect_endpoint_red.rs` | R1 / R2(静态) / R4(a) / R5 |
| B. 检测 SQL 复用符号契约红测试（2 用例） | `crates/web/tests/orphan_detect_sql_constant_red.rs` | R2（编译期符号契约 + 端点对拍） |
| C. 共用装配辅助（非测试目标） | `crates/web/tests/orphan_probe/mod.rs` | 无独立判据 |
| D. 隔离库语义实验（R3 + R4(b)） | `/tmp/adr023-e6a-red-20260917T010800Z/r3_r4b_isolated_db.sh`（+ `orphan_detection.sql`） | R3 / R4(b) |

**禁改清单（本轮遵守）**：`design/**`、任何 `file=` 声明的 entangled 生成物、任何既有测试与实现；不 `git add/commit/stash`；**活库 eestock 零写**（只读 `SELECT`/`GET`）；不重启/不杀在线 app（PID 178558）。

## 2. 钉死的接口契约（TDD 目标，实现方须照此落地）

1. **端点**：`GET /api/quality/orphans` → `200` + JSON 对象 `{"rows": <i64>, "by_table": {"<cagg 表名>": <i64>, ×10}}`；空库/无孤儿 ⇒ `rows == 0` 且 10 键全 0。键名 `rows` 由派单钉死；分解键名由本 red 轮钉为 `by_table`（派单允许实现自定，故此处显式钉死以保证测试可判定）。
2. **口径**：`code 不在 symbols 里`（反连接 `NOT EXISTS (SELECT 1 FROM symbols s WHERE s.code = c.code)`）在 10 张 cagg（`kline_accurate_{5m,15m,30m,1h,1d,1w,1mo}` + `kline_{5m,15m,1d}`）上的**并集计数**（= 逐表之和）。
3. **复用**：检测 SQL 必须是**单一**可复用常量，位置钉为 `crates/diagnose/src/quality.rs`，符号名钉为 `pub const ORPHAN_ROWS_SQL: &str`（列 `table_name text, orphan_rows bigint`）与 `pub const ORPHAN_TABLES: [&str; 10]`；`crates/web/src/rest.rs` 必须引用同一符号（⇒ 端点与测试共用同一份，不重复内联）。
   - 为什么钉在 `diagnose`：web 的**正常依赖**只有 `domain/diagnose/alert/application`（`storage` 仅 dev-dependency），端点侧只能引用 `diagnose`（或 domain）里的常量；storage 侧端口实现同样可引用 `diagnose`。
4. **clean() 语义（R4a）**：三处清理函数必须对「其 fixture 涉及的 cagg 窗口」调用 `refresh_continuous_aggregate`，且不得使用 `NULL,NULL`：
   - `crates/web/tests/api_kline_period.rs::clean` → `kline_accurate_1w` + `kline_accurate_1mo`（该测试正是 W1/MO1 夹具）；
   - `crates/web/tests/api_rest.rs::clean_kline` → `kline_5m` + `kline_1d`（raw 派生 cagg 夹具）；`clean_sym` → `kline_1d`；
   - `crates/storage/tests/kline_reader.rs::clean` → `kline_accurate_1d` + `kline_1d` + `kline_accurate_1w` + `kline_accurate_1mo`（该文件夹具覆盖 D1 与 W/MO）。

## 3. R1–R5 判据 → 可执行断言映射

| 判据 | 断言实现 | 红阶段期望 |
|---|---|---|
| R1 端点存在 + 口径 | `r1_orphan_endpoint_exists_and_reports_zero_on_clean_db`：in-process `web::build_router` 装配 + `GET /api/quality/orphans` ⇒ `200`；JSON 含 `rows`（i64）与 `by_table`（恰 10 键 = 10 张 cagg）；`rows == Σ by_table == 0`（活库 2026-09-17 清理后 0 孤儿） | 404 ⇒ 红 |
| R2 检测口径即规范 + 可复用 | `r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint`（静态：`crates/*/src` 内检测式定义恰 1 处、10 张 cagg 全覆盖、位置= `diagnose/src/quality.rs`、`web/src/rest.rs` 引用同符号）；`orphan_detect_sql_constant_red.rs` 两个用例（符号存在 + 形状 + 逐表结果 == 端点 `by_table`/`rows`） | 静态：0 处定义 ⇒ 红；符号：编译失败（E0432）⇒ 红 |
| R3 检测有效性（隔离库） | `/tmp/.../r3_r4b_isolated_db.sh`：新建一次性库 → `psql -f` 按序 0001..0026 → 插 2 行孤儿（`998801/998802`，`period='M1'`，两个 5m 桶）→ `refresh kline_accurate_5m [01:00,02:00)` → 同一份 `orphan_detection.sql` 计数 = 2；删两行 → 同窗 refresh → 0；`DROP DATABASE` + 无残留查询 | 红阶段：作为「检测式有效性」的正向验证而**执行通过**（本判据验证的是口径正确性，不是实现缺失） |
| R4(a) 结构 | 同上静态用例（4 个清理函数 × 必需 cagg 集合；并禁 `NULL,NULL`） | 4/4 清理函数无 refresh ⇒ 红 |
| R4(b) 语义实验 | 同隔离库脚本：「插入→refresh→删除→不再 refresh」⇒ 计数 2（孤儿留存）；「插入→refresh→删除→再 refresh 同窗」⇒ 0（修法有效） | 执行通过（证明修法有效） |
| R5 测试内禁全量刷 | `r5_no_full_range_refresh_in_test_sources`：扫描 `crates/*/tests/**/*.rs`，解析 `refresh_continuous_aggregate(` 真调用（标识符后须 `(`+字符串字面量；注释行/字符串字面量提及不计），断言 `NULL,NULL` 违规点为空；打印等价 grep 命令与计数 | `crates/web/tests/api_rest.rs:151` ⇒ 红 |

## 4. Mock/stub 策略

无 mock/stub：全部为**真库只读**（R1/R2）与**真隔离库**（R3/R4b）；静态判据为源码文本扫描（无外部依赖）。R2 符号测试对不存在的符号使用编译期引用（TDD 契约），这是刻意的：红因 = 实现缺失。

## 5. 边界与例外用例

- 空库/无孤儿 ⇒ `rows == 0`（R1 全覆盖：10 键逐表为 0）。
- `rows == Σ by_table`（自洽；防「总数为 0 但明细非 0」这类假绿）。
- 两个孤儿行落在**两个** 5m 桶 ⇒ cagg 侧恰 2 行（若落同一桶则只有 1 行，会掩盖计数口径）——设计上刻意分桶。
- 反例路径：「删完不重算」必须仍能观测到孤儿（R4b-A），否则「重算有效」无从证明。
- R5 扫描器显式排除注释行与字符串字面量，避免把「提及」误判为「调用」（首轮实测到自身 self-match，已修正并复跑）。

## 6. 覆盖目标

- 端点面：R1（1 用例，含 5 类断言：status / JSON / 总键 / 分解 10 键 / 自洽+零值）。
- 复用面：R2（静态 1 + 符号 2）。
- 回归面：R4(a) 4 个清理函数 + R5 全仓测试调用点（24 处调用点，1 处违规）。
- 语义面：R3（2 步）+ R4(b)（2 路径）在隔离库上闭环。

## 7. 已知风险 / 交接注记（给实现方与父级）

1. **编译期契约**：`orphan_detect_sql_constant_red.rs` 引用尚未存在的 `diagnose::quality::{ORPHAN_ROWS_SQL, ORPHAN_TABLES}` ⇒ 该测试目标当前**编译失败**（预期红）。实现落地后自然转绿；**若实现选择其它符号名/位置，须同步修改本文件**（本轮契约即此文件）。
2. **`AppState` 增字段**：`orphan_probe/mod.rs` 手工装配 `AppState`（web 无 test-support 装配器）。实现若给 `AppState` 加字段，须同步补齐该辅助模块（否则该测试目标编译失败，属「测试需随装配面同步」而非测试写错的范畴）。
3. **`web/src/rest.rs` 与 `dto.rs` 是 entangled 生成物**：P1-2 端点必须在 `design/07-app-plane/00-web-api.md` 改事实源后 tangle（否则 `scripts/check-tangle.sh` 红）；本红轮**未触碰**这些生成物。
4. **R5 的 grep 口径**：`grep -rn "refresh_continuous_aggregate([^)]*NULL, NULL" crates/*/tests` 会命中测试文件内**注释/字面量提及**；判据口径应取「真调用」，即 shell 复核须排除本红测试自身的注释：`... | grep -v orphan_detect_endpoint_red.rs | wc -l` ⇒ 1（唯一违规 = `api_rest.rs:151`）。
5. **R4(a) 的 cagg 集合**取「fixture 涉及的 cagg」的**安全上界**（`kline_reader.rs` 含 W/MO 两桶夹具）；实现若认为某表无需重算，须给出该表夹具不落 cagg 的推导，而不是放宽断言。
