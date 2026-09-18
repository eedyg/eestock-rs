# ADR-024 P2 独立权威验收 —— 证据索引

- **本文件路径**：`tester/evidence/248_adr024_p2_verify/EVIDENCE.md`（自身路径，自证位置）
- **对应报告**：`tester/report/adr024_p2_verification.md`（权威交付路径）
- **执行记录**：`tester/test/299_adr024_p2_verification_execution.md`
- **执行者 / 时间**：tester（独立测量，**未复用 worker 的任何断言或输出作为依据**）；2026-09-18 13:22 → 13:33 +0800
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（未变，未 commit）
- **被测对象**：**工作树**（含已 staged 的 P0 + **未 commit 的 P2**）
  - 本验收**不采信** worker 自报数字（`coder/report/adr024_p2_engine_linearization.md` 仅用于"自报 vs 实测"对照）

## 0. 纪律自证

| 项 | 证据 |
|---|---|
| 未改生产代码（内容） | 被测三文件 sha256 开始/结束一致：`indicators.rs d693c9a1…` / `engine.rs dfa827a9…` / `history.rs 6840f854…`（见 `00_env.txt` 与 `50_mutation.txt` 末段） |
| 未改生产代码（⑧ 临时扰动已复原） | `50_mutation.txt` 末段：`git diff --name-only -- <三文件>` 行数 = **0** |
| 未 `git add` / `commit` | 结束态 `git diff --name-status`（worktree vs index）= 与开始态**完全一致**的 4 个无关文件（`design/01-architecture/adr/ADR-023-…`、`design/16-backtest-scalability/04-implementation-plan.md`、`design/99-decisions-log.md`、`docker-compose.yml`），无新增暂存项 |
| 未新建数据库 | 全程未设 `EESTOCK_TEST_DATABASE_URL`、未连任何库（workspace 测试的 137 项 DB 失败 = 该门禁的**刻意响亮失败**） |
| 未触碰只读基线资产 | `tester/evidence/240_adr024_golden_baseline/compare_report.txt` 调用前后 sha256 均 `5c181bf2…`（`01_golden_compare_raw.txt` BEFORE/AFTER 两处） |
| 未破坏 tester 既有资产 | `adr024_harness/{Cargo.toml,Cargo.lock,src/main.rs}` 迁移前后 sha256 完全一致（`70_probe_relocation.txt`） |

## 1. 文件清单与对应任务项

| 任务项 | 证据文件 | 说明 |
|---|---|---|
| — | `00_env.txt` | 环境元数据、HEAD、被测文件 sha256 开始快照、只读基线资产 sha256 |
| ① golden 三层等价 | `01_golden_compare_raw.txt`、`01_golden_compare_report.txt` | `compare.sh` 无参调用（11 用例）的原始 stdout/stderr + 重跑后的 `compare_report.txt` 副本 + BEFORE/AFTER sha256 |
| ② 规模曲线（post） | `02_scale_post_raw.txt` | `tester/evidence/241_adr024_scale_curve/run_scale.sh` 全矩阵（dual_ma × slots{1,3} × 3 reps + ctrl 隔离探针）= 36 POINT |
| ②（补：indicator_heavy） | `02b_scale_post_heavy_raw.txt`、`run_scale_post_heavy.sh` | 与 `run_scale.sh` 同矩阵 + 15000/290000 附加点，插件换 `indicator_heavy.js`（tester 冻结 fixture）= 42 POINT |
| ②（补：精确 n 翻倍） | `02c_scale_post_alloc_dbl.txt`、`run_scale_alloc_dbl.sh` | n ∈ {12500,25000,50000,100000,200000} × slots{1,3} × 2 插件 × 3 reps = 60 POINT（`alloc_bytes` 线性判据需要精确 2× 关系） |
| ②（93 天 / 5 年锚点） | `03_scale_extra_post_raw.txt` | `run_scale_extra.sh`（15000 bar；290000 bar）× slots{1,3} × 3 = 12 POINT |
| ② 合并原始数据 | `raw_post.txt` | `02 + 02b + 02c + 03` 合并（2470 行，供分析脚本消费） |
| ② 分析（tester 自研） | `04_analysis_post.txt`、`analyze_p2.py` | 每点中位/离散度、全域与局部 log-log 斜率、三指纹判据（含 per-rep 噪声带）、两模型拟合 |
| ② 分析（pre 并列，自研脚本复跑冻结数据） | `05_analysis_pre_rerun.txt` | 同一脚本跑 `241/raw_pre.txt` ⇒ pre 侧三指纹判据（对照） |
| ② 前后锚点绝对对照 | `06_prepost_anchors.txt` | 200k×1slot、290k×1/3slots、15k、heavy 200k 等锚点 pre/post 绝对值 + alloc 线性比值表 |
| ③ 前视泄漏判别 | `10_lookahead.txt`、`11_lookahead_large_n.txt` | `tester/harness/adr024_p2_probe/src/main.rs` 的 `lookahead`（1500 根真实 golden bar / 4000 根 200k 数据） |
| ④ 会话 vs 批式 | `20_session.txt` | `p2_probe session`（分块 {1,2,3,7,5000} / warmup 绝对口径 / 取消语义） |
| ⑤ 边界与异常 | `25_boundary.txt` | `p2_probe boundary`（9 个边界用例） |
| ⑥ 零改动证明 | `30_zero_change_proof.txt` | 原始 `git diff HEAD` / `git status --porcelain` / `design/16-…` / 旧 `Indicators` grep 计数 |
| ⑥ 归因分析 | `31_zero_change_attribution.txt` | 越界 hunk 逐条归因 P0 + mtime 证据 + 与 `247_adr024_p0_freeze` 交叉引用 |
| ⑦ 回归 | `40_check_all_targets.txt`、`41_workspace_tests.txt`、`42_workspace_tests_analysis.txt`、`43_workspace_tests_detail.txt`、`44_p2_crates_tests.txt`、`45_frontend_vitest.txt` | `cargo check --workspace --all-targets`、workspace `cargo test`（与 P0 基线逐靶对照）、P2+调用方 crate 测试、前端 `vitest run` |
| ⑧ 测试有效性抽查 | `50_mutation.txt`、`run_mutation.sh`、`mutation_backup/` | 9 组人为扰动（8 组变红 / 1 组不敏感），每组"扰动红 → 复原绿"并校验真的重编译 |
| ⑧ 辅助 | `60_alloc_and_targets.txt` | 独立复跑 `session_alloc` 分配量断言 + P2 全靶 |
| —（资产完整性修复） | `70_probe_relocation.txt` | 探针从 `adr024_harness/src/bin/` 迁到独立包 `adr024_p2_probe/`：原因（第二 binary 破坏冻结入口 `cargo run`）、`adr024_harness` 恢复 byte-identical 的 sha256 复核、冻结入口 `compare.sh m5_1slot` 冒烟、迁移前后探针输出逐字节一致 |
| — | `run_scale_post_heavy.sh`、`run_scale_alloc_dbl.sh`、`run_mutation.sh`、`analyze_p2.py` | 本轮新增的可复现入口（均只读生产代码） |

## 2. 新增的可复现入口（tester 资产，未改任何生产文件）

| 入口 | 用途 | 复现命令 |
|---|---|---|
| `tester/harness/adr024_p2_probe/src/main.rs` | ③④⑤ 判别性探针（**独立成包**：独立 workspace + 独立 `Cargo.lock`；见 `70_probe_relocation.txt`） | `CARGO_TARGET_DIR=$PWD/target cargo build --offline --release --manifest-path tester/harness/adr024_p2_probe/Cargo.toml` → 产物 `target/release/adr024_p2_probe` |
| `run_scale_post_heavy.sh` | indicator_heavy 规模矩阵 | `bash tester/evidence/248_adr024_p2_verify/run_scale_post_heavy.sh` |
| `run_scale_alloc_dbl.sh` | alloc_bytes 精确翻倍点 | `bash tester/evidence/248_adr024_p2_verify/run_scale_alloc_dbl.sh` |
| `analyze_p2.py` | 规模曲线三指纹判据 | `python3 analyze_p2.py raw_post.txt` |
| `run_mutation.sh` | ⑧ 扰动/复原驱动器（含 mtime 陷阱修正） | `bash tester/evidence/248_adr024_p2_verify/run_mutation.sh` |

## 3. 只读引用（未改动）

- `tester/evidence/240_adr024_golden_baseline/`（golden 基线 11 用例 + `compare.sh`）
- `tester/evidence/241_adr024_scale_curve/{raw_pre.txt,run_scale.sh,run_scale_extra.sh,data/m1_{200k,290k}.jsonl}`
- `tester/evidence/242_adr024_baseline_extension/fixtures/indicator_heavy.js`
- `tester/evidence/246_adr024_p0_verify/14_workspace_tests.txt`、`12_frontend_vitest_full.txt`（P0 期基线）
- `tester/evidence/247_adr024_p0_freeze/06_post_deliverable_integrity.txt`（P0 冻结时的 index 指纹）
