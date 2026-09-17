# tester/evidence/adr023_e6a —— ADR-023 E6a 第一刀证据链归档

- 本文件：`tester/evidence/adr023_e6a/README.md`
- 汇总执行报告：`tester/test/292_adr023_e6a_acceptance_execution.md`
- 归档时间（UTC）：2026-09-17T02:2xZ（本 agent 归档动作）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`
- 提交（交付物）：`fb5a7a64442c43cde446538d1019965712a676cd` —— `fix(test,storage,diagnose): 孤儿行止血第一刀 ……`
- 三段证据的**原始**（易失）位置：
  - 红阶段 `/tmp/adr023-e6a-red-20260917T010800Z/`
  - 实现自证 `/tmp/adr023-e6a-impl-20260917T011303Z/`
  - 独立验收 `/tmp/adr023-e6a-verify-20260917-013013/`
- **归档范围声明**：本目录只做**关键文本证据**搬运，**不**做整仓副本镜像、**不**收大二进制。
  原始三段目录合计约 23.3 MB，归档后（不含本 README）**86 文件 / 407,267 字节**（`du -sh` = 684K，含块对齐）；含本 README 共 **87 文件**。

---

## 子目录结构

```
tester/evidence/adr023_e6a/
├── red/                              # 红阶段（P1-1 / P1-2 / P2-1 判据红）
│   ├── EVIDENCE.md                   # 原始证据索引（原文照抄）
│   ├── RESULT.txt                    # SEMANTIC_EXPERIMENT_EXIT=0
│   ├── orphan_detection.sql          # R2 规范检测 SQL（10 cagg 反连接 UNION ALL）
│   ├── r3_r4b_isolated_db.sh         # 建库→迁移→R3/R4(b)→DROP→无残留
│   ├── selfile_hashes.txt            # 新增测试文件 sha256
│   ├── runs/                         # 20 个原始日志（含 rust_endpoint_red.log / rust_sql_constant_red.log）
│   └── runs_first_run_awk_bug/       # 首轮日志（仅聚合 awk 漏 -F'|'；保留以证无掩盖）
├── impl/                             # 实现自证轮
│   ├── EVIDENCE.md, START.txt
│   └── V1..V6*.txt                   # 红→绿、门禁、全量回归、断言零弱化审计、活库只读自证、零副作用
└── verify/                           # 独立验收（只验不改）
    ├── EVIDENCE.md                   # A1–A8 全文（含 R-1..R-6 残留登记）
    ├── logs/                         # 18 个原始日志 + 2 个临时对照件
    ├── a4_isolated_db.sh / a4ep_a8_isolated.sh / a8_probe_uncovered.sql
    ├── orphan_rows_sql_excerpt.txt / orphan_rows_sql_extracted.sql
    ├── r2_body_original.txt / rs_files_original.txt / r2_harness_main.rs
    ├── ref_*.rs                      # 断言行逐字对照用的 HEAD 参考副本（3 个）
    └── mut/MUTANTS.diff              # A3 变异体 M1–M5 的**差分**（见下方取舍）
```

---

## 取舍登记（逐 /tmp 源目录）

| 原始目录 | 原始体积 | 归档内容 | 未收内容与理由 |
|---|---|---|---|
| `adr023-e6a-red-20260917T010800Z` | 128 K / 26 文件 | **全量收**（26/26） | 无实质取舍：目录本身小，逐条日志都是判据承载（R1–R5 红、基线绿、隔离库 R3/R4b、收尾红线）。`runs_first_run_awk_bug/` 亦保留 |
| `adr023-e6a-impl-20260917T011303Z` | 196 K / 25 文件 | **全量收**（25/25） | 无 |
| `adr023-e6a-verify-20260917-013013` | 23 M / 1535 文件 | 收 `EVIDENCE.md` + 全部 `logs/`（18 日志 + 2 临时件）+ 3 个脚本/SQL + 4 个抽离件 + 3 个参考副本 + harness 源码 + 变异差分 | ① `r2harness/r2_harness`（**4.3 M ELF 可执行**，`with debug_info, not stripped`）⇒ **不收二进制**，保留其源码 `r2_harness_main.rs`；② `mut/{base,m1..m5}` 各 3.1 M × 6 = 19 M **整棵 crates/ 加 Cargo.toml/lock 副本** ⇒ **不做镜像**，改收 `mut/MUTANTS.diff`（5,585 字节，含 5 个变异体 vs base 的完整 unified diff，逐字保留注入内容）；**代价**：无法直接复跑变异体，只能凭 diff 复原；**判据不受影响**（A3 结论由 `logs/15_a3_mutations.log` 承载） |

**红阶段完整性**：原始 26 文件 = `red/` 下 26 文件 ⇒ **26/26 全覆盖，零遗漏**（含 `runs/` 的 20 个 `*.log` 与 `runs_first_run_awk_bug/rust_endpoint_red.log`）。**实现阶段完整性**：原始 25 文件 = `impl/` 下 25 文件 ⇒ **25/25 全覆盖，零遗漏**。两者均已逐个 `cmp` 验证**字节一致**。

**未收的非证据件**（原始 verify 目录内、与判据无关）：`r2harness/r2_harness`（二进制）与 `mut/*` 的 250 文件整树，理由同上。

---

## 归档完整性自检（本 agent 复算）

- 归档文件数（不含本 README）`find . -type f | wc -l` = **86**；总字节 `du -sb` = **407267**；分段 = `red/ 26` + `impl/ 25` + `verify/ 35`。
- `verify/logs/06_cargo_test_workspace.log` 逐行复算 ⇒ `targets=90 / passed=727 / failed=0 / ignored=1`（与 EVIDENCE 一致）。
- `verify/logs/11_a7_post_test.log` ⇒ 10 表全 `|0`。
- `red/runs/rust_endpoint_red.log` ⇒ `test result: FAILED. 0 passed; 4 failed`。
- 本 agent 未对活库 `eestock` 发出任何写语句（仅 `SELECT` / 文件读取 / 文件复制）。
