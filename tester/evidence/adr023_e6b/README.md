# ADR-023 E6b 第二刀 — 证据归档（/tmp → 仓库）

- **本文件位置（绝对路径）**：`/home/eestock/workspace/git/eestock/eestock-rs/tester/evidence/adr023_e6b/README.md`
- 汇总执行文档：`tester/test/294_adr023_e6b_acceptance_execution.md`
- 归档对象：ADR-023 E6b 第二刀（测试池统一走 `EESTOCK_TEST_DATABASE_URL` + 哨兵门禁 + 幂等供应脚本 + 只读基线播种）四段证据
- 归档时刻：见 `tester/test/294_adr023_e6b_acceptance_execution.md` 头部
- 交付提交：`cf9e19f`（第二刀本体；各段证据生成时的 HEAD 为 `204cb77a2f345c7163b5a93da4540cd5c66f2d6f`）
- **归档动作只从 `/tmp` 复制文本文件到本目录，未改动任何实现 / design / 既有测试；未 `git add` / `git commit` / `git stash`。**

## 来源目录对照（四段）

| 归档子目录 | 原始 /tmp 来源 | 是否存在 | 原始体积 | 原始文件数 | 归档后体积 | 归档后文件数 |
|---|---|---|---|---|---|---|
| `red/` | `/tmp/adr023-e6b-red-20260917T034707Z` | 存在 | 100K | 14 | 53,791 B | 14 |
| `impl/` | `/tmp/adr023-e6b-impl-20260917T035254Z` | 存在 | 308K | 24 | 248,973 B | 24 |
| `verify/` | `/tmp/adr023-e6b-verify-20260917-120416` | 存在 | 392K | 62 | 198,134 B | 62 |
| `fixup/` | `/tmp/adr023-e6b-fixup-20260917T041228Z` | 存在 | 65M | 3431 | 149,205 B | 51 |

另发现两个**不在派单预期内**的路径，如实登记：

| 路径 | 状态 | 处置 |
|---|---|---|
| `/tmp/adr023-e6b-verify-1789617852` | 存在但为**空目录**（0 文件，`ls -la` 仅 `.`/`..`） | 未归档（无内容可归档）。判读：一次未产出内容的验收尝试残留目录 |
| `/tmp/adr023-e6b-red-TS.txt` | 存在，4.0K，内容仅一行 `20260917T034707Z`（red 目录名的时间戳指针） | **未归档**（无判据载荷，等价于指针），内容已逐字记录于本节 |

**结论：四段证据目录全部存在，当前无证据丢失。**

## 取舍说明（体积控制，逐目录）

派单要求「不收大二进制、不做整库/整仓副本镜像；若某目录很大，挑判据承载件并在 README 里列明取舍」。

### `red/`（无取舍，全量归档）
原目录仅 14 个文本文件、无二进制，**逐件全量复制**：`EVIDENCE.md` + R1/R1b/R2/R3/R5 原始运行输出 + 基线两轮计数（`baseline_storage_iso.txt`、`regression_after.txt`）+ `r5_mutation/` 两个变异探针脚本。

### `impl/`（无取舍，全量归档）
原目录 24 个文本文件，**逐件全量复制**（含 `v4a.out` / `v4b.out` 两份同内容异名副本）（含两份 60KB 量级的 `cargo test --workspace` 全量输出 `V3_workspace_tests.log`、`V3_workspace_tests_after.log`、`V5_rerun_tests.log` —— 它们是「两轮一致 732 passed」判据的承载件）。

### `verify/`（无取舍，全量归档）
原目录 62 个文本文件，**逐件全量复制**（含 `A6_vitest.txt` 30KB 前端回归输出、`A2_workspace_tests.txt` 60KB 全量测试输出）。无二进制。

### `fixup/`（**有取舍**：3431 文件 / 65M → 51 文件 / 149,205 B）
被**排除**的内容及理由：

| 排除项 | 原始体积 | 排除理由 |
|---|---|---|
| `tree_base/`、`tree_old_base|mut1..5/`、`tree_new_base|mut1..5/` | 各 ~3.1M，共 12 份 | **整仓副本镜像**（用于变异实验的仓库拷贝），非判据承载件；派单明确禁收 |
| `gate_bin_old`、`gate_bin_new`、`fake_deps/gate_bin_old` | 各 ~8.1M（二进制） | **大二进制**（已编译门禁测试可执行文件），派单明确禁收；其身份由 `gate_bin_old_path.txt` / `gate_bin_new_path.txt` / `gate_orig.md5` 文本记录替代 |
| `migrations`（符号链接） | 0 | 指向仓库内 `migrations/`，非副本内容 |
| `target/debug/deps/zz_gate_*_copy_bin` | — | 已在原始阶段删除（原 EVIDENCE.md 已记） |

被**保留**的判据承载件（51 件，全部文本）：`EVIDENCE.md`、`V1/V3/V4.log`、`v1_before|after.{out,err}`、`v3_init*.*` / `v3_tests.log` / `v3_shellgate.log` / `v3_checktangle.log`、`v4_*.{log,txt}`、`db_list_*.txt`（5 份，库清单前后对照）、`old_run_*.log` / `new_run_*.log`（六格变异矩阵 + 正常仓库回归）、`mutations/zz_mut1..5*.rs`（5 个变异体源码）、`mut_script/testdb-init-prefix.sh`（F2 修前对照脚本）、`gate_orig.rs` / `gate_orig.md5`（门禁文件本体与哈希）、`diffs.txt`、`baseline_meta.txt`、`build_old|new.log`。

> 取舍后 `fixup/` 仍保留「同一门禁二进制 + 副本变异」的**全部输入（变异体源码 / 修前脚本 / 门禁源与哈希）与全部输出（12 次运行的 test result 行 + exit）**，可离线复核六格矩阵结论；丢失的仅是二进制可执行体本身（可由 `gate_orig.rs` + 仓库重建）。

## 未归档的旁证（仅登记路径，未复制）
以下路径在原始 EVIDENCE.md 中被引用，但属**仓库内既有文件**或**阶段日志指针**，不需复制：`tester/design/292_adr023_e6b_testdb_env_gate_red_design.md`、`tester/test/293_adr023_e6b_testdb_env_gate_red_execution.md`、`coder/report/295_adr023_e6b_impl_testdb_env_gate.md`、`design/01-architecture/adr/ADR-023-period-set-extension-30m.md`。

## 完整性声明
- 本目录内容为 `/tmp` 原始文件按名逐字节复制（`cp -p` 保留时间戳），未做任何内容编辑；仅 `README.md` 与 `tester/test/294_*.md` 为本次新增。
- 归档总计：**152 个文件 / 655,595 字节**（含本 `README.md`）。
- 复制后逐目录核对文件数（见上表），除 `fixup/` 的显式取舍外**无缺失**；`cp` 过程中无 `MISSING` 报错。
