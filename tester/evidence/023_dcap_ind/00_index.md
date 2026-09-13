# 023_dcap_ind — 车道 A（dcap 指标本身验证）证据索引

- **报告**：`tester/report/021_dcap_indicator_intrinsic_validation.md`
- **口径**：`design/14-dcap-indicator/03-test-plan.md` §3.2（现行口径）+ `02-spec.md` §1.2/§1.3/§3
- **日期**：2026-09-13 ｜ **对象**：主树 HEAD `3f5425c` 的 dcap 产物（sha256 见 `08_plugin_product_hashes.txt`）
- **硬边界**：纯指标，无任何策略层成分（无阈值/仓位/费率/年化/回撤/胜率/ensemble/ExecutionPolicy）
- **隔离**：`/tmp/dcap_ind_wt`（detach @3f5425c）+ `CARGO_TARGET_DIR=/tmp/dcap_ind_target`；
  主树仅新增本目录与 `tester/report/021_*.md`；未 git add/commit/stash/checkout；未起/未访问服务端口；未 tangle；未写生产数据面

## 阅读顺序

| 文件 | 内容 |
|---|---|
| `03_env_and_scope.txt` | 环境、worktree、隔离与禁忌自查 |
| `08_plugin_product_hashes.txt` | 被验证的产物字节（sha256）与「产物未改」证明 |
| `01_harness_dcap_ind_probe.rs` | rquickjs 取数 harness（产物字节求值、T1 自检、跨方法 crosscheck） |
| `04_selftest_t1_guard.txt` | T1 位级守卫（0 ulp）+ 归一化 + 数据不足边界 + 确定性 |
| `07_data_snapshot.txt` | 数据快照（行数/区间/sha256）+ 生产库只读交叉核对 + 未覆盖声明 |
| `05_determinism_sha256.txt` | 双跑 35 对产物 sha256 全一致 |
| `06_crosscheck_front_vs_roll.txt` | 两种取数路径逐位一致（7 ETF × 63 配置） |
| `10_audit_report.txt` | 独立实现自审 16 条 **ALL PASS**（含逐标的 IC / 等价 n′ / BH-FDR 回算） |
| `tables/sec1_stats_d1.md`, `sec1_stats_m15.md` | §1 分布 / 零穿越 / ACF / 半衰期 / 下界触及 / 振幅单调性 |
| `tables/sec2_equiv_d1.md`, `sec2_equiv_m15.md` | §2 等价 n 映射 + 秩相关分块 + 冗余/非冗余判定 |
| `tables/sec3_ic.md` | §3 IC / ICIR / t / Bonferroni / BH-FDR / 分位分组 / 重叠校正 / 面板横截面 IC |
| `tables/sec4_incremental.md`, `sec4b_dcap_vs_baseline.md` | §4 增量信息（偏 IC + NW t） |
| `tables/sec5_stability.md` | §5 稳定性（跳标的 / 跳时间片 / 跳周期） |
| `code/11..18_*.py` | 分析代码（可单独复算；`02_repro.sh` 为主入口） |
| `02_repro.sh` | 完整复现脚本 |

## 大文件说明

- `tables/sec2_rank_matrix_nprime_*.csv`：`n′ ∈ [2,250]` 之间的秩相关矩阵（249×249）。
- `tables/sec2_rank_matrix_grid63_*.csv`：主网格 63 组合之间的秩相关矩阵（63×63）。
- `tables/sec3_ic_grid.csv`：1134 行全网格 IC（d1 + m15）——**全披露，不静默截断**。
- `tables/sec4_incremental_detail.csv`：§4 的逐 ETF 明细。
