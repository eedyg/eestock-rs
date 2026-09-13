# P5 dcap 有效性验证 —— 证据索引（tester/evidence/022_dcap_p5/）

- 对应报告：`tester/report/020_dcap_p5_effectiveness_sweep.md`
- 研究对象：`3f5425c` 的生产 dcap 插件（`crates/strategy-core/reference-plugins/dcap.js`，
  sha256 `60bc9b49e38516267c868bae6a3f60ceebc6c0f377aecfd4e2ab73c5bcb8e3c2`）
- 运行方式：in-process 库调用（`strategy_core::engine::run_ensemble_with_quickjs`），
  **无 HTTP / 无服务 / 无生产数据面写**；隔离 worktree `/tmp/dcap_p5_wt` + 独立 target `/tmp/dcap_p5_target`

## 文件清单

| 文件 | 内容 | 校验方式 |
|---|---|---|
| `00_index.md` | 本索引 | — |
| `01_harness_dcap_sweep.rs` | 扫描 harness 源码逐字副本（唯一计算路径；真插件 `include_str!`） | 与 `/tmp/dcap_p5_wt/crates/strategy-core/examples/dcap_sweep.rs` 同文件 |
| `02_selftest.txt` | `--selftest` 输出（CSV 装载/切分/dcap 逆势语义/买入持有/参数归一化 5 项断言全绿） | 文本 |
| `03_hashes_determinism.txt` | 数据快照 sha256、插件源码 sha256、双跑 sha256 + `diff` 无差异 | `sha256sum` / `diff -q` |
| `04_data_snapshot_db_crosscheck.txt` | 快照 ↔ 生产库只读交叉核对（逐日 close 相等；行数差 1 根为快照冻结所致） | `psql` 只读 SELECT |
| `05_repro.sh` | 一键复现脚本（自检→主网格→扩展网格→敏感性→分析→门禁） | 脚本 |
| `06_env_and_scope.txt` | 环境、worktree 状态、主树 HEAD、未起服务声明 | 文本 |
| `07_report_tables.md` | 报告 A–H 表（`gen_tables.py` 确定性派生） | `python3 gen_tables.py` |
| `07_extended_landscape_top12.md` | 扩展网格（27 组合）OOS MAR 前 12（披露用） | 同上 |
| `grid_all_run1.csv` / `grid_all_run2.csv` | 主网格逐格全量结果（9 组合 × 7 标的 × IS/OOS + 逐 m 买入持有 + 收盘比） | 双跑 sha256 一致 |
| `grid_ext_run1.csv` / `grid_ext_run2.csv` | 扩展网格逐格全量结果（27 组合） | 双跑 sha256 一致 |
| `grid_all_nowarmup.csv` / `grid_ext_nowarmup.csv` | 敏感性：OOS 无预热（`warmup=0`）对照行 | — |
| `analysis_primary.txt` | 主网格分析全表（基准 / IS / OOS 全地貌 / 衰减 / r·m 边际 / 逐标的 / 敏感性） | `python3 analyze.py <csv>` |
| `analysis_extended.txt` | 扩展网格分析全表（同上，含 10 个 r 配置配对检验 + bootstrap CI） | 同上 |
| `analysis_primary_nowarmup.txt` / `analysis_ext_nowarmup.txt` | 无预热敏感性分析 | 同上 |
| `summary_by_combo.csv` | 组合级汇总（IS/OOS 中位数、四分位、IS→OOS 衰减、vs 买入持有） | `analyze.py` 产出 |
| `check_tangle_worktree.txt` | 干净 worktree 上 `./scripts/check-tangle.sh` **exit=0**（P5 未运行任何 tangle） | 门禁脚本 |
| `git_status_main_baseline.txt` | 主树开工前 `git status --porcelain`（58 行：全部为 P3/P4 在车文件，P5 未触碰） | `git status` |

## 自校验（读证据者可用）

```bash
cd tester/evidence/022_dcap_p5
sha256sum grid_all_run1.csv grid_all_run2.csv   # 两者必须相等（见 03_）
diff -q grid_all_run1.csv grid_all_run2.csv     # 必须无输出
python3 analyze.py grid_all_run1.csv --primary | head -40   # 复现报告 §4 表 A–D
```

## 纪律留痕

- **未** `git add` / `commit` / `stash` / `checkout`（含 worktree 内）。
- **未**改主树任何代码 / 文档 / 生成物（主树写入仅限 `tester/report/` 与 `tester/evidence/`）。
- **未**运行 `entangled tangle`（含 `--force`）；只在干净 worktree 上跑了只读门禁。
- **未**起 8081 / 8082；**未**对生产数据面执行任何写操作（仅 `SELECT`）。
