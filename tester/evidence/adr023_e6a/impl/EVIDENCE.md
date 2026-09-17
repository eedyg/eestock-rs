# EVIDENCE — ADR-023 E6a 第一刀（P1-1 / P2-1 / P1-2）实现轮

- 证据目录（绝对路径）：`/tmp/adr023-e6a-impl-20260917T011303Z/`
- 报告：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/292_adr023_e6a_impl_orphan_first_cut.md`
- 契约：ADR-023 §6.1 第 8 条 + §6.3 第 12 条；父级裁决 **(C1)**（2026-09-17，驳回 A/B）
- 开工：`START.txt`（epoch 1789607583 = 09:13:03 +0800）；收工 09:28+。**超出 30 分钟时间盒**（含一次父级裁决往返 + 两次回归失败返工），见报告 §7。

## 文件索引

| 文件 | 内容 |
|---|---|
| `V1_red.txt` | 红阶段原始确认（R2 符号测试 E0432 编译失败） |
| `V1_red_endpoint.txt` | 红阶段原始确认（endpoint 红测试 0 passed / 4 failed） |
| `V1_green.txt` | **中途**绿（R2(b) 漏判，后修正） |
| `V1_green_final.txt` | **最终绿**：4 + 2 全绿 |
| `V2_check_tangle.txt` / `V2_check_tangle_final.txt` | 门禁 exit 0 |
| `V3_cargo_test.txt` | 第一次全量（FAIL：kline_reader 1 fail — 宽窗干扰） |
| `V3_cargo_test_final.txt` | **最终全量**：EXIT=0，90 个测试二进制全 ok |
| `V3_kline_reader.txt` / `V3_kline_reader2.txt` | kline_reader 单目标（修复前后） |
| `V3_api_rest.txt` | api_rest / api_kline_period（加锁后） |
| `V3_vitest_final.txt` | 前端 88 文件 / 839 用例全绿 |
| `V3_npm_build_final.txt` | `npm run build` ✓ built |
| `V3_assertions_audit.txt` | **既有断言未弱化**：三文件断言行与 HEAD 逐字相同，计数相同 |
| `V3_tester_file_audit.txt` | tester 红测试：用例名/数量未变，R2 外断言行未动 |
| `V4_mtime.txt` / `V4_grep.txt` / `V4_V6_hashes_layers.txt` | doc-first 产物 mtime / grep / sha256 / 分层证明 |
| `V5_orphan_readonly_count.txt` | 只读孤儿计数（开工前 = 0） |
| `V5_orphan_after_suite.txt` | **全量测试后只读孤儿计数 = 0**（P1-1 自清洁实证） |
| `V6_side_effects.txt` | HEAD / git status / staged / stash / tangle no-op / 隔离库 |

## V1 红 → 绿

红（原始，`V1_red_endpoint.txt`）：
```
test result: FAILED. 0 passed; 4 failed
  R1: 404 (端点不存在)
  R2: 检测 SQL ... 当前 0 处：[]
  R4(a): 4 个 clean 均无 refresh_continuous_aggregate
  R5: 违规点 ["crates/web/tests/api_rest.rs:151"]
```
红（`V1_red.txt`）：`orphan_detect_sql_constant_red.rs:15` `error[E0432]: unresolved imports diagnose::quality::{ORPHAN_ROWS_SQL, ORPHAN_TABLES}`

绿（`V1_green_final.txt`）：
```
orphan_detect_endpoint_red:        test result: ok. 4 passed; 0 failed
  r1_orphan_endpoint_exists_and_reports_zero_on_clean_db ... ok
  r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint ... ok
  r4a_clean_functions_refresh_affected_cagg_windows ... ok
  r5_no_full_range_refresh_in_test_sources ... ok
orphan_detect_sql_constant_red:    test result: ok. 2 passed; 0 failed
```
对照：**红 0 passed / 4 failed + 1 目标编译失败 → 绿 6 passed / 0 failed**。

## V2 门禁（原文）

```
$ ./scripts/check-tangle.sh
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
EXIT=0
```

## V3 全量回归（原文摘要）

```
$ cargo test --workspace --tests
EXIT=0            # grep -c '^test result: ok' = 90 ； grep -c '^test result: FAILED' = 0
$ (web) npx vitest run
 Test Files  88 passed (88)
      Tests  839 passed (839)
$ (web) npm run build
✓ built in 1.95s
```

既有断言零弱化（`V3_assertions_audit.txt`）：
```
api_rest.rs              HEAD_assert_lines=23  WORKTREE_assert_lines=23  断言行逐字相同
kline_reader.rs          HEAD_assert_lines=101 WORKTREE_assert_lines=101 断言行逐字相同
api_kline_period.rs      HEAD_assert_lines=11  WORKTREE_assert_lines=11  断言行逐字相同
非注释删除行仅 2 处：chrono import（扩为含 Datelike）与 P2-1 指定要改的 NULL,NULL 那一行。
```

## V4 tangle 真实性

- 全部 7 个生成物由 `entangled tangle`（**写入式，非 --force**）产出，见 `V4_mtime.txt`：
  `analyze 09:18:18` 写入 6 个产物；`09:26:29` 写入 `api_rest.rs`（最后一次文档编辑后）。
- `entangled tangle` 复跑 = `Nothing to be done.`（幂等，无残留漂移）。
- 门禁沙箱**全量重生成 + 逐字节比对** exit 0（比 mtime 更强的等价证明）。
- grep 命中：`grep -c ORPHAN_ROWS_SQL crates/storage/src/reader.rs` = 3；`orphan_rows` 在
  `crates/diagnose/src/quality.rs:323-324`、`crates/web/src/rest.rs:349,351` 命中。
- **mtime 口径注记（诚实披露）**：`design/07-app-plane/00-web-api.md` 是**单文件多块**事实源，
  其 mtime 因后一次（api_rest 块）编辑被推到 09:26，故对 09:18 写入的 5 个产物「产物 mtime 新于
  文档整文件 mtime」不成立；成立的是「产物 mtime（09:18:18）新于其所在块最后一次编辑（09:17:37）」。
  替代且更强的证据 = check-tangle 沙箱全量重生成逐字节一致。

## V5 活库只读自证

- 本轮**手工命令**全程只对 `eestock` 库发 `SELECT`（`V5_orphan_readonly_count.txt` /
  `V5_orphan_after_suite.txt`）；未执行任何 DDL/DML、未手工调用 `refresh_continuous_aggregate`、
  未在本轮创建/占用任何隔离库。
- 孤儿总数（只读，10 张 cagg 并集）：**开工前 0（10 行全 0）→ 全量测试跑完后仍 0（10 行全 0）**。
- **不完全成立的部分（照实报告）**：`V3` 要求跑全量测试，而本仓集成测试**按既有设计连的是共享 dev 库
  eestock**（ADR-023 §6.1 第 8 条登记的隔离债，本轮明确 P0 不动）⇒ 测试进程对 eestock 库有写。
  这些写仅限于各测试自身 fixture 的 code，且 P1-1/P2-1 修好后**写后即重算**、跑完留 0 孤儿（即上一条读数）。

## V6 零副作用（`V6_side_effects.txt`）

```
HEAD = d3c2092ff34af5edd117f877d547b393c5080e50   （未变）
git diff --cached --name-only  → 空（无 staged；本轮遵守「禁 git add/commit/stash」）
git stash list                 → 空
entangled tangle               → Nothing to be done.
隔离库查询（pg_database LIKE orphan/adr023/e6a/r3r4）→ 0 行
git status 中 ' M' 文件 = 本清单 8 个 + ADR-023（预先存在，mtime 09:03:33 早于本轮 09:13 开工 → 非本轮改动）
```
