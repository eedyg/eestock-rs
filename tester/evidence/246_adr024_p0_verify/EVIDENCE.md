# 246 — ADR-024 P0（M30 打通）独立验收 · 证据索引

- **本文件路径（self-location）**：`tester/evidence/246_adr024_p0_verify/EVIDENCE.md`
- **执行记录**：`tester/test/298_adr024_p0_verification_execution.md`
- **报告（判词）**：`tester/report/adr024_p0_m30_verification.md`
- **执行者**：tester（只验不改；未修改生产代码；未 `git add` / `git commit`）
- **执行时间窗**：2026-09-18 12:47:03 → 12:52:24 +0800
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`
- **被测交付状态**：worker 的 P0 改动仅 staged（`git diff --cached --stat` = 48 files, +1807/-56），未 commit

> 全部结论均由**本目录原始输出**支撑；下文每个文件即一段不可再解释的工具输出。

| 文件 | 内容 | 对应任务项 |
|---|---|---|
| `00_preflight.txt` | 形态确认：HEAD / 端口 / 在线 pid 178558 与 exe sha / **M30 在旧进程上被 400 拒** / 库清单 / sim-live 停机门禁 / 残留 run 计数 | ① 前置 |
| `01_build_app_pre_deploy.txt` | `cargo build -p app`（3.31s，EXIT=0）+ 构建前后产物 sha | ① 前置 |
| `02_frontend_build_pre_deploy.txt` | `npx tsc -b` + `npm run build:prod`（EXIT=0，bundle `index-DI8Hug12.js`） | ② 前端构建 |
| `03_redeploy_8081.txt` | 溯源（HEAD/暂存摘要/未 staged 文件）→ 旧 pid/回滚件 sha → kill → nohup 重启 → 新 pid 4083225 与 exe sha 一致 | ① 前置 |
| `03b_app_log.txt` | 新进程启动日志（schema self-check ok、播种 0、sim-live 恢复 0；ERROR=0） | ① 前置 |
| `04_smoke.txt` | 冒烟：`/healthz` 200、`/api/symbols` 200(len=44)、`/api/kline` 200 + **负向对照 W1→400、M300→400** | ① 冒烟 |
| `05_m30_e2e_run.txt` | **M30 真跑**：原始请求、`HTTP 201` 原始响应、轮询输出（running→succeeded）、原始 `/result` | **① 门禁** |
| `05_final_run_view.json` / `05_final_result.json` / `05b_run_view.json` | 上述响应的原始 JSON 落盘 | ① 门禁 |
| `05b_m30_run_assertions.txt` | 断言：`run_view.period=='M30'` && `status=='succeeded'` && `per_bar` 非空(680) && 所有 bar 间距为 1800s 整数倍 && trades=14 | ① 门禁 |
| `06_teardown.txt` | 收尾：DELETE `ADR024-P0-verify-%`（cascade result）→ 回读 0 → REST 404 → **库清单 {eestock, postgres}** | ①/ADR-025 D3 |
| `10_backend_targeted_tests.txt` | `cargo test -p backtest -p application -p web -p mcp --no-fail-fast`：**316 passed / 64 failed**，64 个失败**全部**为同一因（测试库 env 未设） | ② |
| `11_cargo_check_all_targets.txt` | `cargo check --all-targets` EXIT=0 | ② |
| `12_frontend_vitest_full.txt` | `npx vitest run` 全量：**89 files / 850 tests passed** | ② |
| `13_check_tangle.txt` | `./scripts/check-tangle.sh` ✅ 一致（EXIT=0） | ② |
| `14_workspace_tests.txt` | `cargo test --workspace --no-fail-fast`：**611 passed / 137 failed / 1 ignored**，137 个失败**全部**为同一因 | ② |
| `15_final_reruns_and_teardown.txt` | P0 四条 Rust 定向测试 + 五条前端定向测试最终复跑全绿；线上零足迹门禁探针；终态工作区 | ①②收尾 |
| `20_forbidden_changes.txt` | ④ 禁改项：常数 `+/-` 行 0 条；`strategy-core`/`strategy-runtime`/`storage/src/workbench.rs`/`docker-compose.yml` staged diff 全空；列全部 staged 文件 | ④ |
| `20b_constants_and_consistency.txt` | ④ 附：常数所在文件完整 staged diff（仅注释/穷尽臂）；`docker-compose.yml` 未 staged 改动披露；**前端 `periods.test.ts` 未入 index（D1）** | ④/D1 |
| `30_drift_reverse_evidence.txt` | ③ 反向证据：删 `'M30'` ⇒ Rust drift 测试 **2 failed**、前端 `periods.test.ts` **2 failed**；复原 ⇒ 两侧全绿；sha/staged blob 不变、`git diff` 空 | ③ |
| `31_test_effectiveness.txt` | ⑤ ConfigPanel 下拉断言：删常量 M30 ⇒ **仍绿(13/13)**；改组件去 M30 ⇒ **红(1 failed)**；复原 | ⑤/ D2 |
| `32_web_test_falsifiability.txt` | ⑤ `crates/web/tests/adr024_workbench_period_ssot.rs`：临时回填硬编码白名单 ⇒ **2 failed**（含 M30 门禁 + 源码反回归）；复原 ⇒ 4 passed | ⑤ |
| `.run_id` | 本次验收 run 的 id/name（收尾引用） | ① |

**未新建任何数据库**；`pg_database` 全程 = `{eestock, postgres}`（见 `00_preflight.txt` §db list BEFORE 与 `06_teardown.txt` §6.5 AFTER）。
