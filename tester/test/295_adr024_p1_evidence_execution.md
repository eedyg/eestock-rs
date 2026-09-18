# 295 — ADR-024 阶段 P1 取证执行记录（golden 基线冻结 + 规模曲线）

> 角色：**tester**（只产出证据；**未改任何生产代码**、未 commit、未调试、未修复）。
> 本文件路径：`tester/test/295_adr024_p1_evidence_execution.md`。
> 上游判据：`design/16-backtest-scalability/03-test-plan.md` §1（等价性三层判据）与 §2（规模曲线）。
> 执行窗口（UTC）：**2026-09-17T16:02Z ~ 2026-09-17T16:15Z**（约 13 分钟，含 48 次受测运行）。

---

## 1. 环境

| 项 | 值 |
|---|---|
| host | `eedy` / Linux 6.17.0-29-generic (Ubuntu 24.04) x86_64 |
| CPU / RAM | AMD Ryzen 7 9700X 8-Core（16 线程）/ 47.8 GB（跑测时 ~12.6 GB available；swap 7 GB 已用满） |
| toolchain | rustc 1.97.1 / cargo 1.97.1 / Python 3.13.3 |
| engine_commit | `18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（改造前 HEAD） |
| DB | `docker exec eestock-timescaledb psql -U eestock -d eestock`（TimescaleDB 2.29.2-pg16，活库可读） |
| 计时/资源工具 | `/usr/bin/time -v`、`timeout -k 5 600`、`/proc/self/status:VmHWM`、harness 内全局计数分配器 |

## 2. 受测对象与产物（本次执行产生的文件）

| 子任务 | 产物路径 | 备注 |
|---|---|---|
| harness（比对器/测量器实现） | `tester/harness/adr024_harness/{Cargo.toml,Cargo.lock,src/main.rs}` | 独立 workspace，仅 path 依赖仓内 crate；**未改仓库根 `Cargo.toml`** |
| golden 基线 | `tester/evidence/240_adr024_golden_baseline/`（11 用例 × {bars.jsonl, case.json, expected.json}） | README/脚本/日志/比对报告/sensitivity 齐备 |
| 规模曲线 | `tester/evidence/241_adr024_scale_curve/`（`raw_pre.txt` 1320 行、`analysis.txt`、`fit.md`、`data/`、`run_scale*.sh`、`analyze.py`） | 原始命令 + 完整输出 |
| 报告 | `tester/report/adr024_p1_baseline_and_curve.md` | 给架构师的结论页 |

## 3. 测试套件结果

| 套件 | 运行次数 | PASS | FAIL | SKIP | 退出码 |
|---|---|---|---|---|---|
| golden 冻结（`freeze.sh`，11 用例） | 11 | 11 | 0 | 0 | 全 0 |
| golden 比对（`compare.sh`，A/B/C 三层） | 1（11 用例） | **11** | **0** | 0 | 0 |
| 比对器敏感性（`compare.sh --selftest`） | 3 用例 × 5 探针 | 3 | 0 | 0 | 0 |
| 规模曲线（`run_scale.sh` + `run_scale_extra.sh`） | 48 次单次运行（16 点 × 3 重复） | 48 | 0 | 0 | 全 0（`[EXIT] 0` ×48） |
| **合计** | 63 次受测执行 | 63 | **0** | 0 | — |

- **失败用例表：空**（无失败用例，故无错误信息/堆栈）。
- **崩溃 / core dump：无**。`grep -c '[EXIT] 124' = 0`（无超时）；无 panic 输出；`ulimit -c = 0`
  （core 文件被系统禁用，本轮未产生 core；`/proc/sys/kernel/core_pattern = core-%t-%p`）。
- **覆盖率**：不适用（本轮为取证式对比/测量，非覆盖率收集；未修改任何被测代码）。

### 3.1 golden 比对结果（`compare_report.txt` 摘要）

```
case_id                     bars    A_ck    B_ck   max_abs_dev   max_rel_dev  layer
d1_1slot                     500    3239    2189       0.000e0       0.000e0  A/B PASS
d1_3slots                    500    4728    3555       0.000e0       0.000e0  A/B PASS
h1_1slot                     800    5175    3493       0.000e0       0.000e0  A/B PASS
h1_3slots                    800    7476    5628       0.000e0       0.000e0  A/B PASS
m15_1slot                   1000    6407    4318       0.000e0       0.000e0  A/B PASS
m15_3slots                  1000    9433    7101       0.000e0       0.000e0  A/B PASS
m1_1slot                    1500    9815    6630       0.000e0       0.000e0  A/B PASS
m1_1slot_stop               3000   19324   13030       0.000e0       0.000e0  A/B PASS
m1_3slots                   1500   14334   10790       0.000e0       0.000e0  A/B PASS
m5_1slot                    1200    7828    5287       0.000e0       0.000e0  A/B PASS
m5_3slots                   1200   11282    8493       0.000e0       0.000e0  A/B PASS
A/B 层：11 用例，失败 0 用例；全局 max_abs_dev = 0.0；C 层斜率 = n/a（全部 dev==0）
== VERDICT: PASS ==
```
（A_ck/B_ck = A/B 层实际比较的字段个数，共 ~100k 字段/11 例；同二进制重跑 ⇒ 逐位一致是预期基线状态。）

### 3.2 敏感性反向证据（`sensitivity/*.txt`）

| 用例 | 控制组 | 权重 ×(1+1e-6) | close ×1.001（中段/持仓中） | close ×1.001（末根） | close ×(1+1e-6) | verdict |
|---|---|---|---|---|---|---|
| `m15_3slots` | PASS | **FAIL**（A 7/B 1157） | **FAIL** | **FAIL** | **FAIL**（B 3, rel 7.0e-5） | PASS |
| `m15_1slot` | PASS | PASS（**预期**：单 slot 权重被约掉） | **FAIL** | **FAIL** | **FAIL**（B 3, rel 2.2e-4） | PASS |
| `m1_1slot_stop` | PASS | PASS（同上） | **FAIL** | **FAIL** | **FAIL**（B 3, rel 2.2e-3） | PASS |

## 4. 执行中遇到的坑（含处置，供后续阶段复用）

1. **harness 不能进 workspace**（不得改仓库根 `Cargo.toml`）⇒ 用**独立 workspace** + path 依赖
   （`tester/harness/adr024_harness/Cargo.toml`），并把 `CARGO_TARGET_DIR` 指向仓库 `target/` 复用编译缓存，
   `--offline` 走本地 registry 缓存（首次编译 ~40 s，之后 <1 s）。仓内 crate 的 `version.workspace = true`
   等继承在 path 依赖下正常解析，无需改任何生产清单。
2. **`strategy_core::run_ensemble_with_quickjs` 未在 crate 根 re-export** ⇒ 必须 `use strategy_core::engine::run_ensemble_with_quickjs`。
3. **单 slot 的「权重 +1e-6」是数学无操作**（`aggregate=(w·s)/w ≡ s`）：首版 selftest 因此报「敏感性失败」。
   这是**探针设计问题，不是比对器缺陷** —— 已改为：权重探针的硬断言落在 **3 slots** 用例，单 slot 用例
   改由 close 探针承担（含 1e-6 量级），并把该结论写进 README §4（否则后人会重复踩）。
4. **比对器的相对误差判据对「期望值≈0/denormal」会假 FAIL**（例 `drawdown` 极小值 1e-310 vs 0 ⇒ rel=1.0）
   ⇒ B 层改为 `abs ≤ 1e-9 || rel ≤ 1e-9`（绝对下限），并把分类规则（整数=A 层 / 浮点=B 层）写进 README §3。
5. **两参数模型 `t=a·n²+b·n` 的原始法方程病态**（n² 与 n 强共线）⇒ 首版拟合给出负的 `a`、R²<0。
   处置：标准化 `x=n/n_ref` + 一维网格搜索比值 r=A/B（`analyze.py`），得 R²=0.999998 的稳定解。
6. **小 n 点的计时粒度**：`wall_ms` 为整数毫秒 ⇒ 1k 点（4 ms）相对误差可达 ±25%；已在 `fit.md` §1 标注为
   冷启动敏感点，且不参与渐近斜率判据。
7. **无 DB 依赖复查**：基线固化后 `compare.sh` / `run_scale.sh` **不访问 DB**（只用 `bars.jsonl`），
   已实测（比对与曲线运行时无 psql 调用）。
8. **活库数据小坑**：`kline_accurate_15m`（及 5m/1h）**最后一根是薄桶**（`open=high=low=close`、成交量骤降，
   例 ts=1789542000 `3.367/3.367/3.367/3.367, vol=179500`）。这是既有数据现象，**不是本轮引入**；
   基线按原样固化（输入即真相），仅在此备案。
9. 任务书要求「M30 用例」但**当前 HEAD 无 `M30`**（`backtest::Period` 无变体）⇒ 基线为 11/13，
   已在 README §1 与报告显式标注为**待补用例（P0 落地后）**。
10. `run_scale.sh > raw_pre.txt` 用 `nohup … &` 后台启动后，前几秒 `tail raw_pre.txt` 可能报文件不存在
    （重定向建立时序）；重试即可（无数据丢失）。

## 5. 未做 / 未覆盖（诚实边界）

| 项 | 说明 |
|---|---|
| 改造后曲线（`raw_post.txt`，slope≈1.0） | **本阶段不做**（P2 完成后补；复跑入口见 `fit.md` §7） |
| M30 用例（2 个） | 数据/读源已就绪但引擎 `Period` 无 M30 ⇒ 待 P0 |
| golden 的多标的 / 落库双读 / 并发 run | 属 P4 契约测试范围，不在 P1 |
| 覆盖率收集 | 未做（不适用） |
| 任何生产代码修改 | **零**（`git status` 仅新增 tester/ 下文件与 design/ 下既有未跟踪文档） |
