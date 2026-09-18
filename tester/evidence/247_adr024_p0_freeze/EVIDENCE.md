# 证据索引 —— ADR-024 P0 冻结前最终定向复验（tester, 只验不改）

- **本索引自身路径（self-location）**：`tester/evidence/247_adr024_p0_freeze/EVIDENCE.md`
- **对应报告（权威交付路径）**：`tester/report/adr024_p0_freeze_verification.md`
- **执行窗口**：2026-09-18 13:01:20 → 13:04:41 +0800
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（未变，未 commit）
- **纪律**：未改生产代码、未 `git add`/`git commit`、未新建数据库；一切"扰动"均为**临时**并在同一执行块内复原（逐条附 sha256 + `git diff` 空 + index blob 一致）

| 文件 | 内容 | 对应任务项 |
|---|---|---|
| `00_baseline_capture.txt` | HEAD / 5 个相关文件 sha256 与 disk-vs-index blob 基线（扰动前） | ① |
| `01_A_pre_green_testrunpanel.txt` | 扰动前 `TestRunPanel.test.tsx` 绿（6/6, EXIT=0） | ① |
| `01_B_perturb.txt` | 扰动（`periods.ts` 删 `'M30'`）+ `TestRunPanel.test.tsx` **RED**（1 failed / 6, EXIT=1，含 AssertionError 与 diff） | ① |
| `01_B_bonus_and_01_C_restore.txt` | 同一扰动窗口内 `periods.test.ts`（2 failed）与 `ConfigPanel.test.tsx`（1 failed）同红；随后复原 ⇒ `TestRunPanel` **回绿**（6/6, EXIT=0） | ① |
| `01_D_unchanged_proof.txt` | `periods.ts` / `ConfigPanel.test.tsx` 逐字未变证明（sha256 前后一致、`diff` vs 备份为空、`git diff` 空、`git hash-object == git rev-parse :path`、staged blob 不变） | ① |
| `01_E_concurrent_worktree_observation.txt` | 观察：`design/99-decisions-log.md` 于 13:00:54 被**并发**修改（未 staged，不入 index） | ④ |
| `02_A_rust_application_backtest_periods_ssot.txt` | `cargo test -p application --test backtest_periods_ssot` → 6/6, EXIT=0 | ② |
| `02_B_rust_mcp_adr024_period_ssot_drift.txt` | `cargo test -p mcp --test adr024_period_ssot_drift` → 5/5, EXIT=0 | ② |
| `02_C_rust_web_adr024_workbench_period_ssot.txt` | `cargo test -p web --test adr024_workbench_period_ssot` → 4/4, EXIT=0 | ② |
| `02_D_frontend_targeted.txt` | `npx vitest run`（3 个前端断言文件）→ 22/22, EXIT=0 | ② |
| `02_E_frontend_full_suite.txt` | `npx vitest run`（前端全量）→ 89 files / 850 tests, EXIT=0（用例数不减） | ② |
| `03_A_clean_checkout_export.txt` | `git checkout-index -a --prefix=/tmp/adr024_clean_frz01/` 干净检出导出 + 4 个运行期输入 `test -f` 逐条 + realpath 解析 + blob==index | ③ |
| `03_B_clean_tree_ts_tests.txt` | **在导出树内**跑 3 个前端断言 → 22/22, EXIT=0 | ③ |
| `03_C_clean_tree_rust_freshcompile.txt` | **在导出树内**全新编译并跑 `cargo test -p application --test backtest_periods_ssot` → 6/6, EXIT=0（`Finished in 7.27s`，target 从零） | ③ |
| `03_D_clean_tree_reads_own_file_negative_control.txt` | ① `strings` 证明测试二进制内嵌 `CARGO_MANIFEST_DIR` = 导出树；② **负向对照**：移走导出树的契约向量 ⇒ `panic: 契约向量文件不可读 /tmp/adr024_clean_frz01/crates/application/../../design/16-backtest-scalability/contract-vectors.json：No such file or directory (os error 2)`，EXIT=101；③ 复原 ⇒ 6/6 EXIT=0 | ③ |
| `03_E_clean_tree_other_rust_assertions.txt` | 导出树内 `mcp` drift（5/5, EXIT=0）与 `web` gate（4/4, EXIT=0） | ③ |
| `03_F_clean_tree_ts_negative_control.txt` | 导出树内移走契约向量 ⇒ 3 个前端文件 `ENOENT ... <CLEAN_TREE>/design/16-backtest-scalability/contract-vectors.json`（3 failed / no tests, EXIT=1）⇒ 复原 22/22 | ③ |
| `04_A_index_surface_full.txt` | `git diff --cached --name-only/name-status/numstat` 全量（55 条）+ 分类计数 | ④ |
| `04_B_forbidden_items.txt` | 禁改项：常数「值」三方一致（HEAD/INDEX/WORKTREE）、`crates/strategy-core`/`strategy-runtime`/`storage/src/workbench.rs` staged diff 全空、`docker-compose.yml` 未 staged | ④ |
| `04_C_reverse_declared_check.txt` | 反向核对：index **恰好等于**声明的 55 条（`diff` 空）+ 无越界批次/目录 | ④ |
| `04_D_staged_prod_diff_rust.txt` | staged 生产代码 diff（Rust 侧）——范围目视证据 | ④ |
| `04_D2_staged_prod_diff_web.txt` | staged 生产代码 diff（Web 侧）——范围目视证据 | ④ |
| `04_D3_staged_assertion_diffs.txt` | 3 个前端断言文件的 staged diff（D1/D2/整改#2 修法可见） | ①/④ |
| `04_E_tsc_build.txt` | `npx tsc -b` → EXIT=0 | ④（补充） |
| `04_F_final_snapshot.txt` | 终态快照：HEAD / staged 55 / unstaged 3 / untracked 64 / 各文件 disk==index | ④ |
| `05_cleanup_and_integrity.txt` | 临时目录删除 + 清理后 `sha256(git diff --cached)` 与 13:01:47 时点**完全相同**（index 未被本任务改动） | 全 |
