# ADR-024 P4+P6 并批重验 —— 证据索引

- **本文件路径**：`tester/evidence/252_adr024_p4p6_verify/00_INDEX.md`
- 报告：`tester/report/adr024_p4p6_combined_verification.md`
- 设计报告（新增测试）：`tester/design/294_adr024_p6_fills_verify_design.md`
- 执行报告：`tester/test/295_adr024_p4p6_execution.md`
- 新增测试代码（tester 独立，未 `git add`）：
  - `crates/web/tests/tester_p6_fills_indep.rs`（4 例：/fills 语义 + 决定性 + 已写/未写 + 400 防误用）
  - `crates/web/tests/tester_p4_writepath_indep.rs`（tester 既有 4 例 + **新增 2 例 P6**：fills 写失败⇒failed / fills 单块与 result 行共存）
- 真渲染 harness（tester，未参与构建）：`web/tester/p4p6-render/run.mjs`

| # | 文件 | 内容 |
|---|---|---|
| ① | `01_migration_0027_bytes.txt` | schema.md §4.3.18 块 == migrations/0027（去 tangle 标记后逐字节 + sha256） |
| ① | `02_tangle_and_live_db.txt` | `check-tangle.sh` 绿 + 活库 `strategy_run_bars` 不存在 / `result_format` 列 0 + 库清单 |
| ① | `03_sandbox_regen.txt` | 独立沙箱空 DB `entangled tangle -f` 复算 sha 相同 + 篡改探针可判红 |
| ① | `04_three_way_fills.txt` | 02-spec §2 / schema.md §4.3.18 / migration 三处 `'fills'` |
| — | `05_tempdb_init.txt` | 临时库 `tmp_p4p6_20260918151821` 建库 + 27 条迁移（含 0027） |
| — | `06_existing_tester_storage.txt` | 既有 tester P4 storage 独立测试复跑（6 passed） |
| ④ | `07_existing_tester_writepath.txt` | 既有 tester P4 写路径复跑（4 passed） |
| ②③ | `08_fills_indep_run1.txt` | `/fills` 独立测试 4/4 绿（含两侧原始 JSON：fills 3 笔 vs trades 1 行） |
| ④ | `09_writepath.txt` | 写路径最终 6/6 绿（含 fills fail_kind 定点失败） |
| ⑤ | `10_frontend_gap_grep.txt` | 缺口 grep 重跑（原 0 命中项现全部非 0） |
| ⑤ | `11_single_fetch_entry.txt` | 单一取数入口 `useRunSeries` + 4 类消费者调用点 |
| ⑦ | `12_frontend_vitest.txt` / `28_frontend_vitest_final.txt` | 前端全量 90 files / 864 tests 绿（反向对照还原后复跑） |
| ⑦ | `13_frontend_tsc_build.txt` | `tsc -b` + `vite build` EXIT=0 |
| ⑤ | `14_frontend_reverse_hasmore.txt` | 反向对照：忽略 `has_more` ⇒ 长区间断言必红；逐字节还原后复跑绿 |
| ⑥ | `15_app_build.txt` | 第二实例二进制构建 |
| ⑥ | `16_second_app_config.txt` | 第二 app 实例配置（临时库 + :18083）+ schema self-check ok |
| ⑥ | `17_render_seed.txt` | 真实 chunked run（7953 bar / 200 fills / 100 trades）种子输出 |
| ⑥ | `18_render_playwright.txt` / `.json` / `.png` | 真渲染 14 项断言全 PASS + 截图 + 网络命中 |
| ⑥ | `19_render_neg_abort_fills.txt` / `.png` / `.json` | 真渲染反向对照：掐断 `/fills` ⇒ 显式报错（非静默） |
| ⑦ | `20_backend_tests_4crates.txt` / `21_backend_summary.txt` | 后端四 crate 全量：64 suites / 498 passed / 0 failed |
| ⑦ | `22_p4b_and_check.txt` | P4b 自洽测试绿 + `cargo check --workspace --all-targets` 绿 |
| ⑦ | `23_scope_design16.txt` / `24_scope_classification.txt` / `25_design16_attribution.txt` | 范围分类 + design/16 归属（架构师回填） |
| ⑦ | `26_no_prod_changes_and_core.txt` | 生产源码 sha256 与交付态一致 + 无 core |
| — | `27_teardown.txt` | 停第二实例 + DROP 临时库 + 库清单 `{eestock, postgres}` + 活库未动 |
| ⑦ | `29_p4b_instrumentation.txt` | P4b 仪表符号在位 grep |
