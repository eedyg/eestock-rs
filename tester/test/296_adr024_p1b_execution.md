# ADR-024 P1b 执行记录（tester）

> 本文件路径：`tester/test/296_adr024_p1b_execution.md`
> 配合报告：`tester/report/adr024_p1b_baseline_extension.md`
> engine_commit `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（**未**产生生产代码改动、**未** commit）
> 执行窗口 UTC 2026-09-17T16:23Z–16:55Z（被架构师提示的进程硬上限截断 ⇒ ③ 收窄、④ 核心档位、⑤ 只做标定回归）

## 0. 纪律声明

- 未修改任何生产代码（`crates/**`、`migrations/**`、仓库根 `Cargo.toml` 全部未动；`git status` 仅显示任务开始前即存在的
  `design/01-architecture/adr/ADR-023-period-set-extension-30m.md` modified）。
- 未 commit（`git diff --cached` 为空）。
- 未调试、未试图修复任何失败（本轮**无 FAIL**：11/11 A/B/C + 台账位级 + 自证全 PASS）。
- ④ 的写库只发生在**测试库** `eestock_test`（run_id 前缀 `sr_adr024p1b_`）；生产库仅 SELECT。

## 1. 命令与结果台账

| # | 命令 | 结果 | 原始输出 |
|---|---|---|---|
| 1 | `cargo build --offline --release --manifest-path tester/harness/adr024_harness/Cargo.toml` | exit 0（1 warning：无） | 本文 |
| 2 | `bash tester/evidence/240_adr024_golden_baseline/freeze.sh` | exit 0；11/11 `[ledger] … self_proof=PASS (A-FAIL 0 / B-FAIL 0 / dev>0 0)` | `242_.../freeze_p1b.log` |
| 3 | `bash tester/evidence/240_adr024_golden_baseline/compare.sh` | exit 0；`VERDICT: PASS`；A/B 失败 0/11；`dev>0` 0 条；收紧新 FAIL 0 | `242_.../compare_p1b_report.txt`、`240_.../compare_report.txt` |
| 4 | `./target/release/adr024_harness tolprobe` | exit 0；19 行边界表（1e-12 下限生效、旧判据对照） | `242_.../tolprobe.txt` |
| 5 | `for c in m15_3slots m15_1slot m1_1slot_stop; do bash compare.sh --selftest $c; done` | exit 0 ×3；`SELFTEST VERDICT: PASS`；新增 `[L0]–[L3]` 台账探针全部符合预期 | `240_.../sensitivity/*_selftest.txt`、`/tmp/adr024_p1b/selftest_*_stdout.txt` |
| 6 | `bash tester/evidence/242_.../run_heavy.sh`（5k/20k/50k/200k × 1 slot ×3） | 11 个 POINT（200k 第 3 次被 operator 终止）；无 timeout | `242_.../raw_heavy_plugin.txt` |
| 7 | `bash tester/evidence/243_.../run_replica.sh`（12 档） | exit 0；`full` 档 n=3250 → 979 bars/s（引擎 15 ms / 进度写库 3,294 ms） | `243_.../raw_replica.txt` |
| 8 | `docker exec … psql \copy (…strategy_run…)` + `python3` 回归 | N=374；`dur~bars` R²=0.0007；`dur~min(1001,bars)` R²=0.2773 | `243_.../calibration/{runs_prod.csv,runs_prod.sql.txt,fit.txt}` |
| 9 | `grep -n "M30" crates/backtest/src/types.rs` | **无命中** ⇒ ⑥ `BLOCKED: 待 P0` | 报告 §6 |

## 2. 计数汇总

- golden 比对：**11/11 用例 PASS**（A 层位级 96,648 个台账叶节点 + 主 payload 叶节点；B 层 `dev>0` **0**；自证 `dev>0` **0**）。
- 敏感性反向证据：**3 例 × 8 探针**（含新增 L0–L3）全部符合预期；控制组无误报。
- ③ 规模点：**11 个 POINT**（3 次重复中位），无 timeout。
- ④ 副本档位：**12 档**（逐项开关 7 + 规模/插件对照 4 + 3 slots 未跑）。
- ⑤ 标定：**N=374** 条真 run。
- 崩溃/核心转储：**无**。超时/OOM：**无**。

## 3. 与报告的对应

- ①② 完成 → 报告 §1/§2；③ 量级结论 → §3；④ 副本归因 → §4；⑤ 负结果 + 帧数不变式 → §5；⑥ BLOCKED → §6；
  未完成项/不一致处/残余风险 → §7；复跑入口 → §9。
