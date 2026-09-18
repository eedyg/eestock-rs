# ADR-024 P2b 独立验收 + M30 golden 补例 —— **执行报告**

- **本报告自身路径**：`tester/test/300_adr024_p2b_and_m30_execution.md`
- 角色：tester（执行既有/新增测试，**不改生产代码**，**未** `git add`/`commit`，**未**新建数据库）
- 执行时间：2026-09-18（本地 +0800）
- 冻结源码状态：HEAD `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f` + index 中的 P0/P2/P2b（**worktree == index**）
- 本次执行覆盖：worker P2b 交付的 3 个测试二进制（重跑） + tester 新增 2 个测试二进制（新设计） +
  golden 基线的 `compare.sh`（11→13 例）与 `--selftest`（新增 2 例） + 4 条反向对照。
- **判词与逐项结论见**：`tester/report/adr024_p2b_and_m30_golden_verification.md`（本报告只给执行事实）。

---

## 1. 测试套件结果（汇总）

| 命令 | 结果 | 退出码 | 证据 |
|---|---|---|---|
| `cargo test -p application --no-fail-fast` | **149 passed / 0 failed / 0 ignored**（8 个 target；含 worker 2 + tester 3） | 0 | `249_.../A5_04_cargo_test_application.txt` |
| `cargo test -p simlive --no-fail-fast` | **46 passed / 0 failed / 0 ignored**（4 个 target；含 worker 3 + tester 3） | 0 | `249_.../A5_05_cargo_test_simlive.txt` |
| `cargo test -p application --test adr024_p2b_tryrun -- --nocapture`（worker 重跑） | 2 passed（alloc 855.5→850.4 B/bar，ratio 0.994） | 0 | `249_.../A2A3_01_worker_tryrun_rerun.txt` |
| `cargo test -p simlive --test adr024_p2b_orchestrator -- --nocapture`（worker 重跑） | 3 passed（alloc 1060.2→1058.8 B/bar，ratio 0.999） | 0 | `249_.../A2A3_02_worker_simlive_rerun.txt` |
| `cargo test -p application --lib p2b -- --nocapture`（worker 重跑） | 1 passed（n=8 全行 `bars_len==index+1`/`shared_handle=true`） | 0 | `249_.../A4_01_worker_lib_p2b_rerun.txt` |
| **新增** `cargo test -p application --test tester_p2b_tryrun_indep -- --nocapture` | 3 passed | 0 | `249_.../A2_02_tester_indep_tryrun.txt` |
| **新增** `cargo test -p simlive --test tester_p2b_orchestrator_indep -- --nocapture` | 3 passed | 0 | `249_.../A2A4_03_tester_indep_simlive.txt` |
| `bash tester/evidence/240_adr024_golden_baseline/compare.sh`（**13 例**） | 13/13 A/B PASS，全局 `max_abs_dev = 0.000e0`，台账 bitwise PASS | 0 | `249_.../B_03_compare_13cases.txt`、`B_07_final_state.txt` |
| `bash .../compare.sh --selftest m30_1slot` | **VERDICT FAIL（探针点空仓，成因已定位；非比对器缺陷）** | 2 | `249_.../B_05_selftest_m30.txt` |
| `bash .../compare.sh --selftest m30_3slots` | VERDICT PASS | 0 | 同上 |

**无崩溃、无 core dump、无 panic（除刻意构造的反向对照红态）**。全部失败项为「反向对照红态」，
且均已复原并复绿（§3）。

## 2. 反向对照（人为退化 ⇒ 断言必红 ⇒ 逐字节复原）

| ID | 退化（生产代码，临时） | 变红的断言 | 复原证明 |
|---|---|---|---|
| **R-A** | `strategy.rs::tryrun_bar_ctx`：`&bars[..=index]` → `bars`（暴露未来，保留共享句柄） | worker lib 单测（`left: 8 right: 1`）**红**；worker 的等价性/分配量测试**仍绿**；tester 独立测试**仍绿**（见报告 §A2 局限） | sha256 `6d31ad10…77fe` 相同 + `git diff` 空 + 复绿 |
| **R-A2** | 在 R-A 基础上再删 `.with_history(...)`（= 改造前完整形态） | worker alloc 红（50522.8→98518.0，ratio 1.950）；**tester 独立 alloc 红**（25023.2→97010.3，ratio 1.979） | 同上 |
| **R-B** | `plugin_orchestrator.rs::evaluate`：删 `.with_history(...)` | worker 探针红 + worker alloc 红（50727.5→98726.5，ratio 1.946）；**tester 探针红 + tester alloc 红（49217.8→97216.0，ratio 1.975）** | sha256 `b901affe…d87` 相同 + `git diff` 空 + 复绿 |
| **R-C** | `plugin_orchestrator.rs::evaluate`：`ctx.bars` = `bars + [当前 bar]`（暴露 index 之外） | worker 探针红（`left: 2`）+ worker alloc 红；**tester 探针红**（`left: 2`，`bars_eq_prefix=false`） | 同上 |
| **B-R1** | `backtest/src/types.rs`：`Period::M30` 年化因子 `252×8` → `252×4` | `m30_1slot` **A/B FAIL（退出码 2）**：`metrics.annualized_return` rel=5.06e-1、`metrics.sharpe` rel=2.93e-1；`m30_3slots` 同；**控制组 `m15_1slot` 仍 PASS** | sha256 `177048cb…7b97` 相同 + `git diff` 空 + 复绿 |
| **B-R2** | 官方比对器路径：把 `m30_1slot` **持仓区间内** bar 860 `close ×1.001` 放进临时 case（expected 用冻结基线原文） | `m30_1slot_probe` **A/B FAIL（退出码 2）**（`net_value[860]` rel=1.0e-3、`metrics.sharpe` rel=4.3e-4、`derived.position[860].unrealized_pnl` 位级不等）；控制组原例 PASS | 临时用例目录**已删除**；控制组 PASS |

## 3. 复原核验（逐字节）

```
crates/application/src/strategy.rs            sha256 6d31ad101e6338a70f62db7910481bdaa327800da2e124813c22054c6efc77fe
crates/simlive/src/plugin_orchestrator.rs     sha256 b901affe3e61eb730af6ab1662c68356c106cb85bd40864ef73d3ca256947d87
crates/backtest/src/types.rs                  sha256 177048cb84a2005563e5cdafc5f52787dc98eb407bfefdc1b99d870e83717b97
$ git diff -- crates/application/src/strategy.rs crates/simlive/src/plugin_orchestrator.rs crates/backtest/src/types.rs
(空 ⇒ worktree == index)
```

## 4. 纪律核查

- `git diff --cached --name-only | grep -E 'tester|tester_p2b'` → **空**（tester 本批未 `git add` 任何文件）；
- 未 `commit`；未新建数据库（M30 输入从**既有活库** `eestock-timescaledb` 只读导出）；
- 生产代码最终 worktree == index（§3）；tester 新增产物全部为 untracked：
  `crates/{application,simlive}/tests/tester_p2b_*_indep.rs`、`tester/evidence/249_adr024_p2b_verify/**`、
  `tester/evidence/240_adr024_golden_baseline/{m30_1slot,m30_3slots,sensitivity/m30_*_selftest.txt}`、
  `tester/harness/adr024_harness/src/main.rs`（tester 资产：补 M30 周期分支 + `--baseline-kind/--source-state`）、
  `tester/evidence/240_.../{freeze.sh,compare.sh,README.md,freeze.log}`。
- 证据：`249_.../A5_06_discipline_check.txt`。

## 5. 覆盖缺口 / 未执行项（诚实标注）

1. **试算路径无「集成级」前视探针**：`run_pure_score` 内部自建 `QuickJsRuntime`，无法注入探针；
   JS `ctx` 不注入 `bars` ⇒ 该路径的 `bars_len==index+1` 只能由私有 helper 单测（worker 交付）
   + 静态单点枚举（tester）断言。**未**为此另立生产侧可注入点（属改生产接口，超 tester 权限）。
2. **`m30_1slot` 标准 selftest 探针点为空仓** ⇒ selftest FAIL（成因与替代证据见报告 §B-4 注）。
3. 墙钟为 **debug 口径**、本机单次采样（非统计量）⇒ 只作「比值 ≈2 / ≈1」的定序判据，未做方差控制。
4. 未跑 `cargo clippy` / `check-tangle`（不在本次任务书；worker 已交付其输出）。
5. 未按其规模曲线口径复跑 `scale` 子命令（属 tester P1/P1c 范围，非本批）。
