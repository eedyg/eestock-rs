# 288 — ADR-023 D1 红阶段**执行报告**

- 本文件位置（绝对路径）：`/home/eestock/workspace/git/eestock/eestock-rs/tester/test/288_adr023_period30m_red_execution.md`
- 设计报告：`tester/design/288_adr023_period30m_red_design.md`
- 证据目录（逐条命令原文 + 原始输出）：`/tmp/adr023-red-20260916-224257/EVIDENCE.md`
- 仓库/提交：`/home/eestock/workspace/git/eestock/eestock-rs` @ `3094018f352dae25752340d78b5e108c284aeecc`（工作区无 tracked 改动）
- 运行时间：2026-09-16 22:42–23:0x；时间盒：25 分钟（未超时）
- 环境隔离：所有命令 `DATABASE_URL=postgres://eestock:eestock@127.0.0.1:59999/eestock`（不可达端口）⇒ 全程**未连接**活库 `eestock@5433`，未触碰 8081/8082，未跑 tangle/stitch/reset，未 git add/commit/stash
- 本阶段性质：**只新增手写测试，零实现改动**（未修任何 bug、未改 src/design/migrations/entangled 产物）

## 1. 结果总览

| 轮次 | 范围 | 命令 | 结果 |
|---|---|---|---|
| 绿基线（加红测试**前**） | workspace lib 单测 | `cargo test --workspace --lib --no-fail-fast` | **276 passed / 0 failed**（exit=0） |
| 绿基线（加红测试**前**） | 前端全量 | `cd web && npx vitest run` | **806 passed / 0 failed**，86 文件全绿 |
| 红（加红测试**后**） | 7 个新 Rust 测试目标 | 见 §2 | domain/storage 两目标**编译失败**；其余 5 目标 **11 failed / 6 passed** |
| 红（加红测试**后**） | 前端新文件 | `npx vitest run src/features/dashboard/period30m.test.tsx` | **7 failed / 1 passed** |
| 回归（加红测试**后**） | 前端全量 | `cd web && npx vitest run` | **7 failed / 807 passed**，`Test Files 1 failed | 86 passed (87)`；失败**全部**落在新文件 |

**红基线计数（当前 HEAD 的失败计数）**：
- Rust：`domain::period30m_contract` 编译失败 1 目标（2 个 E0599）；`storage::period30m_period_str` 编译失败 1 目标（1 个 E0599）；
  可运行目标 `11 failed / 6 passed`（`period30m_read_source` 3F/2P、`period30m_migration` 5F/0P、`period30m_expected_relations` 1F/1P、`period30m_api_contract` 4F/0P、`period30m_scope_guard` 0F/3P）。
- 前端：7 failed / 1 passed。
- **无崩溃、无 core dump**（全部为断言失败或编译错误，exit code 101/1）。

## 2. 失败用例表（逐条，含 crash/core 标志）

| # | 用例 | 目标/文件 | 消息（节选） | crash/core |
|---|---|---|---|---|
| J1 | `j1_period_enum_contains_m30_variant` | `crates/domain/tests/period30m_contract.rs` | `error[E0599]: no variant ... named M30 found for enum Period`（2 处，:12/:14）**编译失败** | 否 |
| J2 | `j2_parse_period_30m_maps_to_m30` | `crates/web/tests/period30m_api_contract.rs` | `assertion left == right failed: parse_period("30m") 必须 = Some(Period::M30)；实际 = None` | 否 |
| J2 | `j2_all_eight_tiers_parse` | 同上 | `ADR-023 §5.1：档位 30m 必须被 parse_period 接受` | 否 |
| J3 | `j3_period_str_m30_is_uppercase_m30` | `crates/storage/tests/period30m_period_str.rs` | `error[E0599]: no variant ... M30 ...` :14 **编译失败** | 否 |
| J4 | `j4a_merged_sql_m30_uses_accurate_30m_relation` | `crates/storage/tests/period30m_read_source.rs` | `period_merged_sql() 中没有 Period::M30 分支` | 否 |
| J4 | `j4b_fallback_is_30m_rollup_over_kline_15m` | 同上 | `找不到 period_merged_sql 的 M30 臂` | 否 |
| J4 | `j4c_forming_sql_m30_is_30_minutes` | 同上 | `forming_sql() 中没有 Period::M30 分支` | 否 |
| J5 | `j5a_api_kline_period_30m_must_not_be_400` | `crates/web/tests/period30m_api_contract.rs` | `assertion left != right failed: period=30m 被 400 拒绝；body = {"error":"period 须为 1m/5m/15m/1h/1d"}`；**实测状态码 = 400** | 否 |
| J5 | `j5b_unknown_period_400_message_lists_all_eight_tiers` | 同上 | `400 错误信息必须含全部现行档位字面名，缺 = ["30m", "1w", "1mo"]；实际 error = "period 须为 1m/5m/15m/1h/1d"` | 否 |
| J6 | `j6_expected_relations_contains_kline_accurate_30m` | `crates/storage/tests/period30m_expected_relations.rs` | `EXPECTED_RELATIONS 必须加入 "kline_accurate_30m"；现状 = [34 项，无该关系]` | 否 |
| J7 | `j7a/j7b/j7c/j7d/j7e`（5 条） | `crates/storage/tests/period30m_migration.rs` | `migrations/ 下缺编号 0026 的新迁移；现状最大编号 0025_symbol_type_fee_profiles.sql` | 否 |
| J8 | J8-a ×2 | `web/src/features/dashboard/period30m.test.tsx` | `type Period 必须含 '30m': expected [ '1m','5m','15m','1h','1d', …(2) ] to include '30m'` | 否 |
| J8 | J8-b ×2 | 同上 | `工具栏周期按钮必须是 8 档…: expected [ '1m','5m','15m','1h','日', …(2) ] to deeply equal [ Array(8) ]`；`Unable to find … role "button" and name "30m"` | 否 |
| J8 | J8-c ×1 | 同上 | `Unable to find an accessible element with the role "button" and name "30m"`（**前置对照点 `1h` 已通过** ⇒ 夹具可用） | 否 |
| J9 | `PERIOD_BUCKET_MS['30m']=1800000` ×2 | 同上 | `expected undefined to be 1800000` / `periodBucketMs("30m") 必须返回 1_800_000` | 否 |

**绿（有意保留的护栏，非缺陷）**：J4d、J4e、J6 第二例、J9 三条后端护栏、J9 前端 `MULTI_PERIOD_PICKER_PERIODS` 不含 30m。

## 3. 遗留与风险

见 EVIDENCE.md §5（J4 为源码文本断言、§5.2 DB 层判据本轮不覆盖、J7 迁移可执行性需落库实测、J9 绿为有意护栏、J8-a 文本断言、AppState 手工装配需随字段变化同步）。

## 4. 红线遵守声明

未修改任何实现/接口/架构/文档；未改设计文档与 entangled 产物（`git diff` 空）；未 tangle/stitch/reset；
未 git add/commit/stash；未改 `.gitignore`；未连活库与在线端口；**未做任何失败分析后的修复动作**（仅观察与报告）。
