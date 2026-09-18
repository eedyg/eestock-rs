# ADR-024 P1c — 执行记录（真路径固定开销取证）

- **文件位置**：`tester/test/297_adr024_p1c_execution.md`
- 时间：2026-09-17T16:41–16:52Z ｜ commit `18d1b9a` ｜ 运行时 app `./target/debug/eestock-app --config /tmp/app_dev_8081.toml`（pid 178558）｜ DB `eestock@127.0.0.1:5433`
- 角色：tester ｜ **未改生产代码 ｜ 未 commit ｜ 未改接口/架构 ｜ 未加永久仪表**
- 证据目录：`tester/evidence/244_adr024_fixedcost_realpath/`（`raw.txt` 为主证据；`STATUS.md` 判词；`per_run_table.md` 表；`queries.sql` 可复跑 SQL）
- 报告：`tester/report/adr024_p1c_fixed_cost_realpath.md`

## 1. 本轮执行的测试/探测资产（新增，可复跑）

| 文件 | 作用 | 复跑命令 |
|---|---|---|
| `probe.sh` | v2：REST 提交单次受控 run + 短沉降 Δn_tup_upd + 并发度判定 | `bash tester/evidence/244_adr024_fixedcost_realpath/probe.sh` |
| `probe_lag.sh` | 长窗口协议：前置 90 s guard + 后置 240 s 采样（**取得可用 Δ 的唯一协议**） | `bash .../probe_lag.sh` |
| `refit.sh` + `refit.py` | ③ 只读导出（含 `concurrent` 列）+ 本地最小二乘重拟合 | `bash .../refit.sh && python3.12 .../refit.py` |
| `queries.sql` | ②/④ 全部只读 SQL（含 UPDATE 调用点计数与清理 SQL） | 见文件头注释 |
| `cleanup.txt` | 测试 run 清理的原始命令与输出 | — |

判据（来自测试计划 §2.4 ② / ADR §2.6）：**每 run 理论 UPDATE 数 = min(1001, bars) + 2**；`dur` 是否与 bars 无关、是否与帧数成正比。

## 2. 测试套件结果

| 项 | 值 |
|---|---|
| 受控 run 提交数（真路径 REST） | **8** |
| 有效测量点（长窗口协议） | **1**（`sr_1789663588369_000007`，M5 3500 bar → **Δ=1003**，后置 240 s 零漂移） |
| 无效测量点（短沉降协议，PG 统计 flush 滞后污染） | **7** |
| 断言判定 | 理论 1003 == 实测 1003 ✅ **PASS**（另有 3 档 `dur/(min(1001,bars)+2)` = 2.57–2.65 ms 常数性佐证） |
| 崩溃 / core dump | **无**（0 次 panic、0 core；8 条 run 全部 `succeeded`，`strategy_run` 无 `failed`） |
| 跳过 | 0 |
| 代码失败（plugin/引擎错误） | 0 |

## 3. 失败/无效测量点明细（**均为测量学问题，非被测代码缺陷**）

| 用例 | run_id | Δ 实测 | 理论 | 判定 | 原因（观察，不做修复） |
|---|---|---|---|---|---|
| t1_small_d1_490 | sr_1789663332534_000000 | 226 | 494 | ❌ 无效 | v1 无沉降等待；PG 表级统计按后端最小间隔 flush，尾数迟到 |
| t2_medium_m5_3250 | sr_1789663335760_000001 | 1131 | 1003 | ❌ 无效 | 同上（含上一次 run 的迟到尾数，overshoot） |
| t3_large_m1_15900 | sr_1789663340174_000002 | 1071 | 1003 | ❌ 无效 | 同上 |
| t1_small_d1_492 | sr_1789663435710_000003 | 472 | 494 | ❌ 受污染 | v2 settle 4×0.5 s 仍不足（其后 +22 迟到） |
| t4_small2_m5_650 | sr_1789663443311_000004 | 497 | 652 | ❌ 受污染 | 其后 +64 迟到 |
| t2_medium_m5_3500 | sr_1789663452400_000005 | 940 | 1003 | ❌ 受污染 | 其后 +79 迟到 |
| t3_large_m1_16155 | sr_1789663461850_000006 | 1065 | 1003 | ❌ 受污染 | 其后 +13 迟到 |
| **lagprobe** | **sr_1789663588369_000007** | **1003** | **1003** | ✅ **有效** | 前置 90 s guard（45 次零漂移）+ 后置 240 s（120 次零漂移） |

错误信息/栈：无（无异常抛出）。`pg_stat` 迟到量级：+13 / +22 / +64 / +79（观察值）。

## 4. 覆盖范围

- 分层：**真路径端到端**（REST → application → QuickJS 引擎 → storage → PG `UPDATE`），非副本、非单元。
- 规模：492 / 650 / 3500 / 16155 bar（跨 32.8×；16155 bar ≈ P5 前 M1 93 天上限）。
- 并发控制：每次提交前 `status IN ('queued','running')` = 0；窗口内 `overlapping_other_runs = 0`（8/8）。
- 只读侧：`pg_stat_user_tables` / `pg_stat_database` / `SHOW` / 374 条历史 run 的 CSV（含新增 `concurrent` 协变量）。
- 未覆盖：M30（P5 前 web 白名单拒绝，`crates/web/src/workbench.rs:148`）、并发情景下的 Δ（并发协变量只在历史 CSV 上做回归，未做真路径并发 Δ 实测）、`pg_stat_io`/WAL 层延迟时间序列。

## 5. 清理

8 条测试 run **全部删除**（`DELETE FROM strategy_run WHERE name LIKE 'ADR024-P1c-%'` → `DELETE 8`，外键 `ON DELETE CASCADE` 连带删 8 条 `strategy_run_result`）；回读 0/0；`strategy_run` 恢复 **374 条 succeeded**（与实验前一致）。
原始输出：`cleanup.txt`。
**不可回滚副作用**：累计计数器被本轮抬高（`n_tup_upd 357,386 → 364,041`，+6,655；`n_tup_ins 2349 → 2357`；`n_tup_del 1976 → 1984`）—— 后续引用需扣除。

## 6. 结论/移交

判词与逐条裁定见 `tester/report/adr024_p1c_fixed_cost_realpath.md`（§0 判词、§3.3 上轮结论裁定、§5 与 ADR 文本的差异）。
**本 agent 不做失败分析与修复**；P4b 的仪表/优化方案由 coder/架构裁决。
