# ADR-024 P2 独立验收 —— 执行记录（tester）

- **本文件路径**：`tester/test/299_adr024_p2_verification_execution.md`（自身路径，自证位置）
- **对应报告**：`tester/report/adr024_p2_verification.md`（权威交付路径）
- **证据目录**：`tester/evidence/248_adr024_p2_verify/`（索引 `EVIDENCE.md`）
- **角色**：tester（**只验不改**；可写测试/证据；未改生产代码、未 `git add` / `commit`、未新建数据库）
- **执行窗口**：2026-09-18 13:22:34 → 13:33 +0800（UTC 05:22 → 05:33）
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（未变）
- **被测**：工作树（P0 staged + **P2 未 commit**）；**不采信** worker 自报数字

---

## 0. 执行步骤流水（按时间顺序）

| # | 时刻(+0800) | 动作 | 命令（要点） | 结果 | 证据 |
|---|---|---|---|---|---|
| 1 | 13:22:34 | 环境快照 | `git rev-parse HEAD` / `rustc -V` / `sha256sum` 被测 13 文件 + 3 只读基线 | HEAD 未变；基线 `compare_report.txt` = `5c181bf2…` | `00_env.txt` |
| 2 | 13:22:36 | 构建取证 harness（release） | `cargo build --offline --release --manifest-path tester/harness/adr024_harness/Cargo.toml` | OK；binary sha256 `92311e82…`（≠ pre 版 `06c126ba…`） | 会话输出 |
| 3 | 13:22:38 | **强制新鲜度**（touch 3 个 lib.rs 后重建） | 同上 | 重编译 4 crate，binary sha256 **不变** ⇒ 二进制 == 当前工作树源码 | 会话输出 |
| 4 | 13:22:4x | **① golden 11 用例** | `bash tester/evidence/240_adr024_golden_baseline/compare.sh` | `VERDICT: PASS`；dev>0 条目 **0**；`[exit 0]` | `01_golden_compare_raw.txt` |
| 5 | 13:22:5x | 只读资产完整性 | BEFORE/AFTER `sha256sum compare_report.txt` | 前后均 `5c181bf2…`（未变） | 同上 |
| 6 | 13:23:0x | **② 规模曲线 post（run_scale.sh）** | `bash run_scale.sh > 02_scale_post_raw.txt` | 36 POINT，0 timeout，13.5 s | `02_scale_post_raw.txt` |
| 7 | 13:23:3x | ② 附加段（93 天 / 5 年） | `bash run_scale_extra.sh` | 12 POINT，0 timeout，12.4 s | `03_scale_extra_post_raw.txt` |
| 8 | 13:24:3x | ② **indicator_heavy** 矩阵（tester 新增脚本） | `bash run_scale_post_heavy.sh` | 42 POINT，0 timeout，27.2 s | `02b_scale_post_heavy_raw.txt` |
| 9 | 13:25:0x | ② **alloc 精确翻倍点**（tester 新增脚本） | `bash run_scale_alloc_dbl.sh` | 60 POINT，0 timeout，34.0 s | `02c_scale_post_alloc_dbl.txt` |
| 10 | 13:25:2x | ② 分析（tester 自研 `analyze_p2.py`，不复用 `analyze.py`） | `python3 analyze_p2.py raw_post.txt`（先修 1 处 group 索引 bug） | 判据组 4/4 三指纹全 True；总判定 PASS | `04_analysis_post.txt` |
| 11 | 13:25:4x | ② pre 并列（同脚本跑 P1 冻结数据） | `python3 analyze_p2.py 241/raw_pre.txt` | pre 判据组 **FAIL**（斜率 1.878–1.900；t/n² 不衰） | `05_analysis_pre_rerun.txt` |
| 12 | 13:25:5x | ② 前后锚点绝对值表 | 自写 Python 提取 | 200k×1slot：pre 15.584 s → post 0.614 s | `06_prepost_anchors.txt` |
| 13 | 13:26:5x | **③ 前视泄漏探针**（新建 `p2_probe.rs`，作为 `adr024_harness` 的第 2 个 bin） | 首次 `cargo build --bin p2_probe` | 一次编译通过；**但随后发现该放法破坏冻结入口**（见 T6 / 步骤 30） | — |
| 14 | 13:27:0x | ③ 判别性测试（golden 1500 根） | `p2_probe lookahead m1_1slot/bars.jsonl` | `A` 全量 1499 点 SAME；`B` 6 组污染不变；`C` 0 违例；`D` 反向对照 PASS ⇒ **VERDICT PASS** | `10_lookahead.txt` |
| 15 | 13:27:2x | ③ 第二数据集（200k 数据取 4000 根） | `p2_probe lookahead m1_200k.jsonl 4000` | 同 PASS（3999 点） | `11_lookahead_large_n.txt` |
| 16 | 13:27:3x | ③ 强化反向对照（新增 D3：读 `bars[index+1..]` 极值） | 重编译 + 重跑两数据集 | D3 不变区 750/750、2000/2000 全变红 | `10_/11_` 末段 |
| 17 | 13:27:4x | **④ 会话 vs 批式** | `p2_probe session m1_1slot/bars.jsonl 600` | 分块 {1,2,3,7,5000} 全 SAME；warmup 绝对；取消语义 OK ⇒ **PASS** | `20_session.txt` |
| 18 | 13:27:5x | **⑤ 边界与异常** | `p2_probe boundary` | 9 用例全 PASS | `25_boundary.txt` |
| 19 | 13:28:0x | **⑥ 零改动原始命令** | `git diff HEAD -- crates/{application,web,storage}` 等 | **非空**（7 文件，全 P0） | `30_zero_change_proof.txt` |
| 20 | 13:28:5x | ⑥ 归因 + `design/16-…` + 旧 `Indicators` grep | 见证据 | P2 范围外文件无未暂存改动；旧实现 0 删除行 | `31_zero_change_attribution.txt` |
| 21 | 13:29:0x | **⑦ 后端编译** | `cargo check --workspace --all-targets --offline` | 0 error / 0 warning，0.93 s | `40_check_all_targets.txt` |
| 22 | 13:29:3x | **⑦ workspace 测试** | `cargo test --workspace --no-fail-fast --offline` | passed **640** / failed **137**（33 靶，全 DB 门禁）；与 P0 基线靶集合**完全一致** | `41_workspace_tests.txt` |
| 23 | 13:29:5x | ⑦ 失败归因 | 逐靶/逐 panic 定位 | 137 项全部 = `crates/test-support/src/lib.rs:32` 的 `EESTOCK_TEST_DATABASE_URL` 未设 → 刻意响亮失败 | `42_/43_` |
| 24 | 13:30:1x | ⑦ P2 + 调用方 crate 测试 | `cargo test -p application -p backtest -p strategy-runtime -p strategy-core --no-fail-fast` | passed **302** / failed **0**（application 恰 **143**） | `44_p2_crates_tests.txt` |
| 25 | 13:30:2x | **⑦ 前端** | `npx vitest run`（cwd=web） | **89 files / 850 tests passed**，EXIT=0（与 P0 基线逐字同） | `45_frontend_vitest.txt` |
| 26 | 13:31:0x | **⑧ 测试有效性抽查 v1**（**失败**：`cp -p` 保留旧 mtime ⇒ cargo 不重编译 ⇒ 复原后仍跑扰动版二进制 = 假红） | `bash run_mutation.sh` | 判为无效证据，**整轮废弃并改正** | （已被 v2 覆盖） |
| 27 | 13:31:3x | ⑧ v2：复原改 `cp`（不保时间戳）+ `touch`，并**显式校验复跑输出含 `Compiling`** | `bash run_mutation.sh` | 9 组扰动：**8 组红 / 1 组不敏感**；每组复原后回绿且**确有重编译**；末段 `git diff` 行数 0 | `50_mutation.txt` |
| 28 | 13:31:5x | ⑧ 辅助：独立复跑分配量断言 + P2 全靶 | `cargo test -p strategy-core --test session_alloc -- --nocapture` 等 | 947.3→944.6 B/bar（ratio 0.997）；P2 全靶 0 failed | `60_alloc_and_targets.txt` |
| 29 | 13:32:0x | 结束态完整性 | `git diff --name-status`（worktree vs index） | 与开始态**完全一致**的 4 个无关文件；被测三文件 sha256 与开始快照一致 | 会话输出 + `50_mutation.txt` 末段 |
| 30 | 13:33:0x | **资产完整性修复**：探针由 `adr024_harness/src/bin/p2_probe.rs` 迁至独立包 `tester/harness/adr024_p2_probe/`；删除 `src/bin/` | `cargo run --manifest-path tester/harness/adr024_harness/Cargo.toml --`（迁移前 exit 101 / 迁移后 exit 64=正常用法）；`bash compare.sh m5_1slot` | `adr024_harness` 三文件 sha256 **byte-identical**；冻结入口恢复可用；探针 ③④⑤ 输出与迁移前**逐字节一致** | `70_probe_relocation.txt` |

---

## 1. 工具/资产缺陷与修正（如实记录）

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| T1 | ⑧ v1 用 `cp -p` 复原 ⇒ 源文件 mtime 回退到旧值 ⇒ cargo 判 "fresh" **不重编译** ⇒ "复原后"仍跑扰动版二进制（假红） | v1 的 8 组"复原后红"全部无效 | 整轮作废；v2 改 `cp`（不保时间戳）+ `touch`，并在每个复原复跑里**校验输出含 `Compiling`**（0 个 crate ⇒ 标记"结果无效"） |
| T2 | `analyze_p2.py` 初次运行 group 索引越界（`g[16]` 应为 `g[15]`） | 分析脚本崩溃 | 修正后重跑（脚本本身为 tester 新增资产，非生产代码） |
| T3 | 我在构建新鲜度校验时 `touch` 了 `crates/{backtest,strategy-runtime,strategy-core}/src/lib.rs` | 仅 mtime 变化，内容未变（cargo 重编译后 binary sha256 不变，反证内容一致性） | 已在 `00_env.txt` 之外注明；内容 sha256 三方一致 |
| T4 | `tester/evidence/240_adr024_golden_baseline/compare_report.txt` 为**未跟踪**文件，`compare.sh` 无参调用会重写它 | 仅 mtime 变化（该文件无时间戳字段） | BEFORE/AFTER sha256 均为 `5c181bf2…`，未丢失信息（同 worker §5.4.2 的披露） |
| T5 | harness 的 `wall_ms` 为整数毫秒 | n ≤ 20 000 的墙钟量化噪声可达 ±20% ⇒ 小 n 段局部斜率噪声 ±0.05 | 「局部斜率单调」判据只在 **n ≥ 20 000 渐近段**评估；并对渐近斜率给出 per-rep 噪声带（`04_analysis_post.txt`） |
| **T6（最重要）** | 把 ③④⑤ 探针作为**第 2 个 binary** 放进冻结算证据包 `tester/harness/adr024_harness/src/bin/p2_probe.rs` | `cargo run --manifest-path tester/harness/adr024_harness/Cargo.toml -- ...` 报 `error: cargo run could not determine which binary to run`（exit 101）⇒ **会破坏 P1 冻结入口** `compare.sh` / `run_scale.sh`（二者均无 `--bin`） | 探针**独立成包** `tester/harness/adr024_p2_probe/`（独立 workspace + 独立 `Cargo.lock`），删除 `src/bin/p2_probe.rs`；`adr024_harness` 三文件 sha256 恢复 byte-identical；`compare.sh m5_1slot` 冒烟通过；迁移前后 ③④⑤ 输出逐字节一致（`70_probe_relocation.txt`） |

---

## 2. 汇总计数（本轮全部测试执行）

| 批次 | 靶数 | passed | failed | ignored | 备注 |
|---|---|---|---|---|---|
| `cargo check --workspace --all-targets` | — | — | **0 error / 0 warning** | — | 0.93 s |
| `cargo test --workspace --no-fail-fast` | 81 | **640** | **137** | — | 137 项失败 = 33 个 DB 靶（`EESTOCK_TEST_DATABASE_URL` 未设）；与 P0 基线**逐靶一致** |
| `cargo test -p application -p backtest -p strategy-runtime -p strategy-core` | 22 | **302** | **0** | 1 | application 恰 143（26+6+55+39+17） |
| 前端 `vitest run` | 89 files | **850** | **0** | — | EXIT=0，与 P0 基线 850/850 逐字同 |
| ① golden 比对 | 11 用例 | 11（A/B PASS） | **0** | — | dev>0 条目 0；台账 96 648 叶节点 bitwise PASS |
| ② 规模曲线 | 150 POINT(5×3) | — | 0 timeout | — | 判据组 4/4 三指纹 True |
| ③ 前视探针 | 2 数据集 | PASS | **0** | — | 全量逐点 1499 + 3999 |
| ④ 会话探针 | 1 组 | PASS | **0** | — | 分块 5 种 + warmup 3 种 + 取消 5 项 |
| ⑤ 边界探针 | 9 用例 | PASS | **0** | — | 每例含分块 3 种对比 |
| ⑧ 扰动/复原 | 9 组 | 复原 9/9 回绿 | 扰动 8/9 变红 | — | 1 组（M3b）被判定为"语义级不敏感"，已如实报告 |

**崩溃 / core dump**：**无**（0 crash、0 core dump、0 timeout、0 panic 逃逸到进程级）。

---

## 3. 未过项与阻塞

**未过项：0 条。** 8 项任务全部达成（判据见报告）。

**无阻塞**（无需 `need_decision`）：任务书已给出全部判据；8 项均可独立执行并已附原始输出。
另有 3 条非阻塞观察（含 1 条文档裁定请求）已在报告 §4 列出，交由架构师/父代理裁决，不阻塞本次判词。

---

## 4. 交付清单

| 交付物 | 路径 |
|---|---|
| 权威报告 | `tester/report/adr024_p2_verification.md` |
| 执行记录（本文件） | `tester/test/299_adr024_p2_verification_execution.md` |
| 证据索引 | `tester/evidence/248_adr024_p2_verify/EVIDENCE.md` |
| 证据（**31 个文件**，含 4 个可复现脚本与 `EVIDENCE.md`；另有 1 个 `mutation_backup/` 备份目录） | `tester/evidence/248_adr024_p2_verify/` |
| 新增测试资产（③④⑤ 探针，独立包） | `tester/harness/adr024_p2_probe/{Cargo.toml,Cargo.lock,src/main.rs}` |
