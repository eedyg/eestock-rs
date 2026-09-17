# EVIDENCE — ADR-023 E6a 红阶段（孤儿行治本第一刀：P1-1 / P2-1 / P1-2）

- 证据目录（绝对路径）：`/tmp/adr023-e6a-red-20260917T010800Z/`
- 本文件：`/tmp/adr023-e6a-red-20260917T010800Z/EVIDENCE.md`
- 设计报告：`/home/eestock/workspace/git/eestock/eestock-rs/tester/design/291_adr023_e6a_orphan_red_design.md`
- 执行报告：`/home/eestock/workspace/git/eestock/eestock-rs/tester/test/291_adr023_e6a_orphan_red_execution.md`
- 时间戳（UTC）：2026-09-17T01:08Z 起；HEAD = `d3c2092ff34af5edd117f877d547b393c5080e50`
- 红线遵守：活库 `eestock` **零写**（仅 `SELECT`/`GET`）；未动 `design/**` 与 entangled 生成物；未 `git add/commit/stash`（`git diff --cached` 为空，0 条）；未重启/未杀 app（PID 178558 存活，`09:12:41` 运行时长）。

## 判据 → 证据文件

| 判据 | 命令 | 结果 | 日志 |
|---|---|---|---|
| R1 | `cargo test -p web --test orphan_detect_endpoint_red` | **红**：`left: 404 / right: 200` | `runs/rust_endpoint_red.log` |
| R2 静态 | 同上（`r2_orphan_sql_has_single_reusable_definition_shared_with_endpoint`） | **红**：`当前 0 处：[]` | `runs/rust_endpoint_red.log` |
| R2 符号 | `cargo test -p web --test orphan_detect_sql_constant_red` | **红**：`error[E0432]` 未解析导入 `ORPHAN_ROWS_SQL`/`ORPHAN_TABLES` | `runs/rust_sql_constant_red.log` |
| R3 | `bash r3_r4b_isolated_db.sh` | **绿（口径验证）**：`R3-1 rows=2`、`R3-2 rows=0`、10 张 cagg 建成、`DROP DATABASE` 无残留 | `runs/01_migrate.log` `runs/01b_cagg_count.log` `runs/02_*` `runs/03_*` `runs/07_drop_db.log` `runs/08_residue.log` |
| R4(a) | `cargo test -p web --test orphan_detect_endpoint_red` | **红**：4/4 清理函数无 refresh | `runs/rust_endpoint_red.log` |
| R4(b) | `bash r3_r4b_isolated_db.sh` | **绿（修法有效）**：A 路径 `2→2`（孤儿留存）；B 路径 `2→0` | `runs/04_r4b_A_no_refresh_after_delete.log` `runs/05_r4b_B_refresh_after_delete.log` |
| R5 | `cargo test -p web --test orphan_detect_endpoint_red` + shell grep | **红**：违规点 `crates/web/tests/api_rest.rs:151`（真调用 24 处，违规 1 处） | `runs/rust_endpoint_red.log` `runs/r5_grep_evidence.log` |
| 绿基线 | `cargo test -p diagnose --lib` / `-p web --lib` / `-p web --tests --no-run`（移出新增文件） | `10 passed` / `49 passed` / 17 个既有目标全部编译 EXIT=0 | `runs/green_baseline_diagnose_lib.log` `runs/green_baseline_web_lib.log` `runs/green_baseline_web_tests_norun.log` `runs/green_baseline_counts.log` |
| 红线/仓库 | `git status --porcelain crates/`、`git diff --cached --name-only`、新增文件 sha256 前后一致 | 仅 3 条新增未跟踪；暂存区 0；sha256 `OK` | `runs/git_and_redlines.log` `selfile_hashes.txt` |
| 收尾 | 活库只读快照 / PID 存活 / 隔离库残留 | `live_total=0`、PID 178558 存活、`residual_databases=0` | `runs/final_checks.log` `runs/08_residue.log` |

## 本轮新增测试文件（仓库内，未跟踪）

- `/home/eestock/workspace/git/eestock/eestock-rs/crates/web/tests/orphan_detect_endpoint_red.rs`（sha256 `4815f0b7…`）
- `/home/eestock/workspace/git/eestock/eestock-rs/crates/web/tests/orphan_detect_sql_constant_red.rs`（sha256 `c242eb7c…`）
- `/home/eestock/workspace/git/eestock/eestock-rs/crates/web/tests/orphan_probe/mod.rs`（sha256 `4494d908…`）

## 隔离库实验脚本

- `orphan_detection.sql` —— R2 规范检测 SQL（10 张 cagg 反连接 UNION ALL；列 `table_name, orphan_rows`）
- `r3_r4b_isolated_db.sh` —— 建库→迁移→R3/R4(b) 实验→DROP→无残留证明
- `RESULT.txt` —— 最终 `SEMANTIC_EXPERIMENT_EXIT=0`
- `runs_first_run_awk_bug/` —— 首轮日志（**仅聚合 awk 漏 `-F'|'` 导致汇总为 0**，逐表明细本身正确；修后复跑全绿，保留以证无掩盖）
