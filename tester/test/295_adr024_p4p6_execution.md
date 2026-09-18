# ADR-024 P4+P6 并批重验 —— 测试**执行报告**

- **本报告自身路径**：`tester/test/295_adr024_p4p6_execution.md`
- 角色：tester（只执行/只观察，**未修任何失败、未改生产源码**）
- 执行时间：2026-09-18 15:16–15:27（+08:00）；基线 commit `18d1b9a`（工作区 = 共享冻结批 index + 架构师未 stage 的 design/16 回填）
- 主报告：`tester/report/adr024_p4p6_combined_verification.md`；设计报告：`tester/design/294_adr024_p6_fills_verify_design.md`
- 证据：`tester/evidence/252_adr024_p4p6_verify/`（30 个文件，索引见 `00_INDEX.md`）
- DB 载体：`EESTOCK_TEST_DB_NAME=tmp_p4p6_20260918151821`（27 条迁移含 0027）→ 跑 → `DROP DATABASE … WITH (FORCE)` → 回读 `{eestock, postgres}`
- 真渲染载体：第二 app 实例 `127.0.0.1:18083`（同临时库），收尾已停

## 0. 总览：无失败、无崩溃

| 套件 | 命令 | 结果 | Exit | 证据 |
|---|---|---|---|---|
| 后端四 crate 全量 | `cargo test -p storage -p application -p web -p mcp`（临时库） | **64 suites / 498 passed / 0 failed / 0 ignored** | 0 | `20_backend_tests_4crates.txt`、`21_backend_summary.txt` |
| 后端新增 `/fills` 独立 | `cargo test -p web --test tester_p6_fills_indep` | **4 passed / 0 failed** | 0 | `08_fills_indep_run1.txt` |
| 写路径（P4 复跑 + P6 定点） | `cargo test -p web --test tester_p4_writepath_indep` | **6 passed / 0 failed** | 0 | `09_writepath.txt` |
| storage 独立（P4 复跑） | `cargo test -p storage --test tester_p4_store_indep` | **6 passed / 0 failed** | 0 | `06_existing_tester_storage.txt` |
| P4 端点独立（P4 复跑） | 含在上表四 crate 全量 | `3 passed` | 0 | `20_backend_tests_4crates.txt` |
| 编译面 | `cargo check --workspace --all-targets` | 绿 | 0 | `22_p4b_and_check.txt` |
| P4b 仪表 | `cargo test -p application --test workbench p4b_run_summary_counters_are_self_consistent` | **1 passed** | 0 | `22_p4b_and_check.txt` |
| 文学式门禁 | `./scripts/check-tangle.sh` | 绿（沙箱重生成 + 逐字节比对） | 0 | `02_tangle_and_live_db.txt` |
| 前端全量 | `npx vitest run` | **90 files / 864 tests passed** | 0 | `12_frontend_vitest.txt`、`28_frontend_vitest_final.txt` |
| 前端类型 | `npx tsc -b` | 绿 | 0 | `13_frontend_tsc_build.txt` |
| 前段构建 | `npx vite build` | 绿（built in 1.93s） | 0 | `13_frontend_tsc_build.txt` |
| 真渲染 | Playwright + 第二 app 实例 | **14/14 断言 PASS**（`RENDER_PASS`） | 0 | `18_render_playwright.txt` |
| 真渲染反向 | 掐断 `/fills` | `RENDER_PASS`（反向断言成立） | 0 | `19_render_neg_abort_fills.txt` |

## 1. 失败用例表

**空**（0 条）。`FAILED` / `panicked` 命中数均为 0（证据 `21_backend_summary.txt`）。

## 2. 崩溃 / core dump

- `ulimit -c = 0`；`find` 未发现任何 `core` / `core.*`（证据 `26_no_prod_changes_and_core.txt`）。
- 所有 suite `test result: ok`，无 SIGSEGV / abort / panic 逃逸。
- 真渲染无 console error / pageerror（证据 `18_render_summary.json`）。

## 3. 反向对照（证明断言非空转）

| # | 变异 | 目标断言 | 实测 | 还原 |
|---|---|---|---|---|
| R1 | `useRunSeries.ts` chunked 首页 `has_more→false` / `next_offset→null`（忽略 `has_more`） | ResultView「长区间（12000 根 chunked）不得静默截断」 | **1 failed**（`findByTestId('wb-perbar-more-note')` 超时） | `sha256sum -c` **逐字节一致**（`05be06ff…`），复跑绿 |
| R2 | 真渲染掐断 `/fills`（`page.route` abort） | K 线成交明细必须显式报错 | 出现 `wb-fills-error`=`成交明细加载失败：Failed to fetch`，成功文案消失 | 无需还原（仅拦截网络） |

> 反向对照期间**未改任何生产文件的最终态**：R1 的变异与还原均在本批同一分钟完成，还原后 sha256 与交付态逐字节相同（证据 `14_frontend_reverse_hasmore.txt`、`26_...`）。

## 4. 覆盖摘要

- 后端新增独立用例 6（`/fills` 4 + 写路径 2）全绿；tester 既有 P4 独立用例 14 全绿。
- 前端 864 例（未减少；P6 净 +14）。
- 契约字段 / URL 命中数全部非 0（证据 `10_frontend_gap_grep.txt`）。
- 真渲染 harness：`18_render_requests.json`（网络命中 curve×3 / bars×2 / fills×1 / result×1）、`18_render_workbench_result.png`。

## 5. 未做/未覆盖（如实标注）

1. 未对**活库**做任何写；未对活库应用 0027。
2. 真渲染只在**临时库**的第二 app 实例上进行（非生产容器/生产库）；未跑既有的 `web/e2e/*.e2e.ts` 全量视觉回归（需生产容器 + 真 DB）。
3. 未覆盖：MCP `/fills` 工具（架构师裁定本批不需要）；`recorded=false` 的**回填**（无实现）。
4. 未独立复跑 release 构建（P2c `debug_assert` 语义由 coder 证据承载）。
5. 新增 tester 测试文件 `crates/web/tests/tester_p6_fills_indep.rs` 复用了既有 tester 夹具片段，产生 5 条 `dead_code` 警告（`CONST_SCORE`/`seed_symbol_and_m1`/`expect_ts`/`rfc`/`per_bar_obj`），**不影响结果**（`cargo check --workspace --all-targets` 仍 EXIT=0）。
