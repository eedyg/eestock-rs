# ADR-024 P2（引擎线性化）独立权威验收报告

- **报告自身路径（self-location）**：`tester/report/adr024_p2_verification.md`（本文件，权威交付路径）
- **执行记录**：`tester/test/299_adr024_p2_verification_execution.md`
- **证据目录**：`tester/evidence/248_adr024_p2_verify/`（索引：该目录 `EVIDENCE.md`）
- **执行者 / 时间**：tester（独立测量；**未复用 worker 的任何断言/输出作为判据**）；2026-09-18 13:22:34 → 13:33 +0800
- **HEAD**：`18d1b9a0d1e17af06ac503fcb2a676eaa2f5520f`（**未变**，**未 commit**；P2 代码为已 staged / 未提交）
- **被测**：**工作树**（P0 staged + P2 未提交），即 `cargo check/test` 跑的就是当前源码
- **纪律**：未改生产代码（内容三方 sha256 一致）、未 `git add`/`commit`、未新建数据库、未复用 worker 数字作为判据；
  ⑧ 的 9 组人为扰动均为**临时**且同块内复原（sha256 + `git diff`(worktree vs index) 双证）

---

# 判词：**PASS** —— **P2 可以冻结**

**8 项任务全部达成，未过项 0 条。**

**「P2 可否冻结」的明确结论**：**可以**。三指纹（`t/n²` 塌缩、`alloc` 线性、局部斜率单调）在 4 个判据组
（`dual_ma` / `indicator_heavy` × slots 1/3）上**一并复验通过**；golden 11 用例 A/B/C + B′ **dev 全 0**；
**前视泄漏判别性测试 PASS 且反向对照自证有鉴别力**；会话/批式/边界/取消语义逐位等价；调用方 crate 零改动
（客观 mtime + worktree-vs-index + 归因三方一致）；回归与 P0 基线逐靶一致、零新增失败；8 组扰动全部变红后复原回绿。

**另有 3 条非阻塞观察**（O1–O3）与 **2 条建议**（R1–R2）见 §9 —— 其中最需知悉的是
**O2：golden 基线仍为 11 例、缺 `m30_*` 两例**（P0 已落地 M30），以及
**O1：`ctx.bars` 在会话路径下的语义由「入参切片」收窄为「`bars[0..=index]`」**（架构师需文档裁定，worker §5.3 已提）。
二者均**不影响本批线性化正确性**，故不构成冻结阻塞。

---

## 0. 结论速览与「worker 自报 vs tester 实测」逐项对照

| # | 判据项 | worker 自报 | **tester 独立实测** | 判定 |
|---|---|---|---|---|
| ① | golden 11 用例 A/B/C + B′ + 持仓台账 | PASS；dev>0 条目 0；报告 sha256 `5c181bf2…` | **PASS**；11 例逐条 `dev>0 = 0`；全局 `max_abs_dev = 0.000000e0`、`max_rel_dev = 0.000000e0`；台账 96 648 叶节点 bitwise PASS + 自证 7 872 叶节点 PASS；`compare_report.txt` sha256 调用前后均 `5c181bf2…` | **一致** |
| ② | `dual_ma` 渐近斜率 ∈ [0.9,1.1] | 0.961（50k→200k） | **0.948**（矩阵 50k→200k 局部）；**0.979 / 0.984**（n≥20k 拟合，slots 1/3） | **一致（均 ∈ 区间）** |
| ② | `indicator_heavy` 渐近斜率 ∈ [0.9,1.1] | 1.005 | **1.007**（局部）；**1.001 / 1.013**（n≥20k 拟合） | **一致** |
| ② | `alloc_bytes` 塌缩为线性（翻倍比 ≈2） | 1.99 / 2.00 / 2.02（dual）；1.99 / 2.00 / 2.00（heavy） | **1.9999 / 2.0004 / 1.9846 / 1.9671**（dual，4 个精确翻倍点）；**1.9991 / 1.9995 / 2.0003 / 1.9996**（heavy） | **一致（≈2，且 <2 方向与 `a·n+b` 一致）** |
| ② | 200k×1slot `dual_ma` 墙钟（post） | 0.618 s（25.2×） | **0.614 s**（0.611/0.614/0.633，中位；25.4×） | **一致（−0.6%）** |
| ② | 200k×1slot `indicator_heavy` 墙钟（post） | 0.725 s | **0.711 s**（0.706/0.711/0.724；重 = 重） | **一致（−1.9%）** |
| ② | 200k×3slots（worker 未测，只到 8k） | —（缺口） | **dual 1.890 s / heavy 2.196 s**（已补） | 补充 |
| ② | `indicator_heavy` **pre** 200k×1slot | 239.7 s（引用 ADR §2.6） | **不可独立复核**（工作树无 pre 态；P1 冻结曲线 `raw_pre.txt` 未含 heavy） | **不可复核（未采信为判据）** |
| ② | 引擎每 bar 分配字节 | 947.3 → 944.6 B/bar，ratio 0.997（pre 56 915.9 → 112 913.8，1.984） | **逐字复现**：947.3 → 944.6，ratio **0.997** | **一致（逐字相同）** |
| ③ | 前视泄漏 | 未做（不在 worker 交付内） | **PASS**（两数据集；A 全量逐点 1499 + 3999 ≡；B 6 组污染不变；C 0 违例；D 反向对照自证） | **新增完成** |
| ④ | 会话/批式等价、warmup、取消 | 自测 7 测试全绿 | **PASS**（自建探针：分块 {1,2,3,7,5000} 逐位等价；warmup 绝对；取消 5 项） | **一致** |
| ⑤ | 边界与异常 | 含在 session.rs 内 | **PASS**（9 个边界用例 + 每例 3 种分块） | **一致** |
| ⑥ | 调用方零改动 | sha256 before==after；application 143 测试 | **成立**（见 §6：客观 mtime + worktree-vs-index + hunk 逐条归因 P0） | **一致** |
| ⑦ | workspace `cargo test` / `check --all-targets` / 前端 | 0 error/0 warning；application 143；未报前端 | **一致**：check **0 error / 0 warning**；workspace **640 passed / 137 failed（33 个 DB 靶，与 P0 基线逐靶一致）**；application **143**；前端 **89 files / 850 tests passed**（与 P0 基线逐字同） | **一致** |
| ⑧ | 测试有效性（防空断言） | 5 组反向证据（13a–13e） | **独立 9 组扰动：8 组变红、1 组判定为语义级不敏感**（见 §8，含 M3b 的如实披露） | **更强** |

**与 worker 报告不符之处**：**无**（0 条）。worker 的自报数字在**所有可独立复核项**上都与我的实测一致（含逐字相同的 947.3/944.6）；
唯一**无法复核**的是 `indicator_heavy` 的 **pre** 数字（239.7 s）与 §2.6 的 1 120 GB —— 因为 pre 态不在工作树、且 P1 冻结曲线未含该插件，
故我**未采信**其作为判据（但其 post 侧数字我已独立测得 0.711 s，量级一致）。

---

## ① golden 三层等价（权威复核）

**入口**：任务指定的 `tester/evidence/240_adr024_golden_baseline/compare.sh`（无参 = 全 11 用例），原始输出：
`tester/evidence/248_adr024_p2_verify/01_golden_compare_raw.txt`。

```
$ bash tester/evidence/240_adr024_golden_baseline/compare.sh
== ADR-024 golden compare (P1b) ==
# B 层判据（唯一事实源）：PASS ⇔ |Δ| ≤ max(1e-12, 1e-9×|expected|)   [对照·旧判据 P1：abs ≤ 1e-9 或 rel ≤ 1e-9]
# A 层 bitwise 含：result 的整数/结构字段 + 派生序列 derived.{ledger,position,trades_replay}（全部叶节点逐位）
case_id                     bars    A_ck    B_ck  max_abs_dev  max_rel_dev   dev>0  ledger_ck    ledger  layer
d1_1slot                     500    3239    2189      0.000e0      0.000e0       0       3736      PASS  A/B PASS
d1_3slots                    500    4728    3555      0.000e0      0.000e0       0       4028      PASS  A/B PASS
h1_1slot                     800    5175    3493      0.000e0      0.000e0       0       5796      PASS  A/B PASS
h1_3slots                    800    7476    5628      0.000e0      0.000e0       0       6392      PASS  A/B PASS
m15_1slot                   1000    6407    4318      0.000e0      0.000e0       0       7356      PASS  A/B PASS
m15_3slots                  1000    9433    7101      0.000e0      0.000e0       0       8028      PASS  A/B PASS
m1_1slot                    1500    9815    6630      0.000e0      0.000e0       0      10652      PASS  A/B PASS
m1_1slot_stop               3000   19324   13030      0.000e0      0.000e0       0      20020      PASS  A/B PASS
m1_3slots                   1500   14334   10790      0.000e0      0.000e0       0      12036      PASS  A/B PASS
m5_1slot                    1200    7828    5287      0.000e0      0.000e0       0       9076      PASS  A/B PASS
m5_3slots                   1200   11282    8493      0.000e0      0.000e0       0       9528      PASS  A/B PASS

# [B′] 逐字段枚举：所有 dev>0 条目（field, expected, actual, abs, rel）（合计 0 条）
[B′-dev] d1_1slot: 无 dev>0 条目（逐位相等）
[B′-dev] d1_3slots: 无 dev>0 条目（逐位相等）
... （11 例逐条均「无 dev>0 条目」）...

# 容差收紧对照（1e-9 → 1e-12 绝对下限）：按新判据 FAIL 而按旧判据 PASS 的条目数 = 0

# [台账] 派生序列 A 层 bitwise 比较（derived.ledger / derived.position / derived.trades_replay；
#        合计 96648 个叶节点）+ 自证「replay trades ↔ payload trades」（合计 7872 个叶节点）
[台账] m1_1slot_stop: ledger_checks=20020 fills=174 replayed_trades=87 payload_trades=87 final_qty_bits=0 bitwise=PASS self_proof=PASS（self_proof dev>0 0 条）
...

A/B 层：11 用例，失败 0 用例
全局 max_abs_dev = 0.000000e0 @ m5_3slots (result.drawdown[0][1]; expected=...e0 actual=...e0)
全局 max_rel_dev = 0.000000e0 @ m5_3slots (result.drawdown[0][1]; expected=...e0 actual=...e0)
C 层偏差-规模 log-log 斜率 = n/a（全部 dev==0，无规模依赖）（points=[...11 个点全 0.0...]）→ PASS（未观测到随 n 增长）
持仓台账：bitwise FAIL 0 用例 / 自证 FAIL 0 用例 / 自证 dev>0 条目 0
== VERDICT: PASS ==
[exit] 0
```

**断言与结论**

| 断言 | 实测值 | 结论 |
|---|---|---|
| `dev>0` 条目数（B′ 逐字段枚举） | **0 条**（11 例逐条均为"无 dev>0 条目"） | PASS（无被聚合值掩盖的偏差） |
| 全局 `max_abs_dev` | **0.000000e0** | PASS（优于 B 层 `max(1e-12, 1e-9·|exp|)`） |
| 全局 `max_rel_dev` | **0.000000e0** | PASS |
| A 层 bitwise（含 `derived` 台账派生序列） | 11 例 A_ck 合计 **96 648** 叶节点全逐位相等；`bitwise FAIL 0 用例` | PASS |
| 自证（replay trades ↔ payload trades） | 7 872 叶节点，`self_proof FAIL 0 用例`，`dev>0 0 条` | PASS |
| C 层（偏差不得随 n 增长） | 全部 dev==0 ⇒ 斜率判为 n/a，未观测到规模依赖 | PASS |
| 11 用例清单 | `d1_1slot/d1_3slots/h1_1slot/h1_3slots/m15_1slot/m15_3slots/m1_1slot/m1_1slot_stop/m1_3slots/m5_1slot/m5_3slots` | 与任务口径"11 用例"一致 |

**只读资产完整性**：`compare.sh` 无参调用会重写 `tester/evidence/240_adr024_golden_baseline/compare_report.txt`
（该文件**未被 git 跟踪**）；调用前后 sha256 均为 `5c181bf276a72f93a8e8473e76f0675f63d0e90ad2989a4f33c57bcfec845da2`（**未变**），
且与 P1b 冻结副本（`242_adr024_baseline_extension/compare_p1b_report.txt`）用例行逐行一致 ⇒ 未丢失任何信息。

---

## ② 规模曲线（改造后 / raw_post）

**入口（全部为 tester 自有脚本，未改生产代码）**

| 命令 | 输出 | POINT 数 | timeout | 耗时 |
|---|---|---|---|---|
| `bash tester/evidence/241_adr024_scale_curve/run_scale.sh > 02_scale_post_raw.txt` | `02_scale_post_raw.txt` | 36 | 0 | 13.5 s |
| `bash tester/evidence/241_adr024_scale_curve/run_scale_extra.sh` | `03_scale_extra_post_raw.txt` | 12 | 0 | 12.4 s |
| `bash tester/evidence/248_adr024_p2_verify/run_scale_post_heavy.sh`（新增） | `02b_scale_post_heavy_raw.txt` | 42 | 0 | 27.2 s |
| `bash tester/evidence/248_adr024_p2_verify/run_scale_alloc_dbl.sh`（新增） | `02c_scale_post_alloc_dbl.txt` | 60 | 0 | 34.0 s |
| `python3 analyze_p2.py raw_post.txt`（tester 自研分析器） | `04_analysis_post.txt` | — | — | — |
| `python3 analyze_p2.py tester/evidence/241_adr024_scale_curve/raw_pre.txt`（pre 并列） | `05_analysis_pre_rerun.txt` | — | — | — |

> harness 二进制 sha256 = `92311e82079d1eec3a2733ba759cb3e682f933f9535183892d672802afc08e7e`（≠ pre 版 `06c126ba…`）；
> `touch` 三个 `lib.rs` 后重建，binary sha256 **不变** ⇒ 跑的确实是**当前工作树**源码。

### ②-1 每个判据点的三次重复（中位；来源 `04_analysis_post.txt` §①）

```
series                    tag                               bars slots  median_s  spread    bars/s   alloc_MB  rss_MB
ctrl(constant_score)      ctrl_n20000_s1                   20000     1    0.0530    1.9%    377358      15.79    23.6
ctrl(constant_score)      ctrl_n200000_s1                 200000     1    0.5400    3.3%    370370     151.57    65.5
dual_ma(矩阵)               dual_ma_n1000_s1                  1000     1    0.0030    0.0%    333333       0.77    22.7
dual_ma(矩阵)               dual_ma_n5000_s1                  5000     1    0.0160    6.3%    312500       4.12    22.9
dual_ma(矩阵)               dual_ma_n20000_s1                20000     1    0.0640    1.6%    312500      16.51    23.6
dual_ma(矩阵)               dual_ma_n50000_s1                50000     1    0.1650    1.8%    303030      39.59    24.9
dual_ma(矩阵)               dual_ma_n200000_s1              200000     1    0.6140    3.6%    325733     154.57    68.1
dual_ma(矩阵)               dual_ma_n1000_s3                  1000     3    0.0100    0.0%    100000       1.67    22.7
dual_ma(矩阵)               dual_ma_n5000_s3                  5000     3    0.0480    2.1%    104167       8.54    22.9
dual_ma(矩阵)               dual_ma_n20000_s3                20000     3    0.1960    6.6%    102041      34.13    23.5
dual_ma(矩阵)               dual_ma_n50000_s3                50000     3    0.4850    1.4%    103093      83.62    27.1
dual_ma(矩阵)               dual_ma_n200000_s3              200000     3    1.8900    2.2%    105820     330.59    90.7
dual_ma(附加点)              extra_93d_n15000_s1              15000     1    0.0500    6.0%    300000      11.54    23.2
dual_ma(附加点)              extra_93d_n15000_s3              15000     3    0.1430    2.1%    104895      24.76    23.4
dual_ma(附加点)              extra_5y_n290000_s1             290000     1    0.8800    1.5%    329545     236.81    99.6
dual_ma(附加点)              extra_5y_n290000_s3             290000     3    2.7570    2.2%    105187     492.03   131.2
indicator_heavy(矩阵)       heavy_n1000_s1                    1000     1    0.0040    0.0%    250000       0.74    22.7
indicator_heavy(矩阵)       heavy_n5000_s1                    5000     1    0.0180    5.6%    277778       3.98    22.9
indicator_heavy(矩阵)       heavy_n20000_s1                  20000     1    0.0710    4.2%    281690      15.87    23.6
indicator_heavy(矩阵)       heavy_n50000_s1                  50000     1    0.1760    6.8%    284091      38.09    24.9
indicator_heavy(矩阵)       heavy_n200000_s1                200000     1    0.7110    2.7%    281294     152.35    66.0
indicator_heavy(矩阵)       heavy_n1000_s3                    1000     3    0.0110    0.0%     90909       1.64    22.6
indicator_heavy(矩阵)       heavy_n5000_s3                    5000     3    0.0530    1.9%     94340       8.39    22.8
indicator_heavy(矩阵)       heavy_n20000_s3                  20000     3    0.2130    1.4%     93897      33.49    23.5
indicator_heavy(矩阵)       heavy_n50000_s3                  50000     3    0.5380    5.8%     92937      82.10    25.4
indicator_heavy(矩阵)       heavy_n200000_s3                200000     3    2.1960    1.4%     91075     328.37    89.1
indicator_heavy(附加点)      heavy_extra_93d_n15000_s1        15000     1    0.0540    7.4%    277778      11.11    23.4
indicator_heavy(附加点)      heavy_extra_93d_n15000_s3        15000     3    0.1580    0.6%     94937      24.33    23.3
indicator_heavy(附加点)      heavy_extra_5y_n290000_s1       290000     1    1.0540    2.6%    275142     234.87    93.7
indicator_heavy(附加点)      heavy_extra_5y_n290000_s3       290000     3    3.2280    2.5%     89839     490.08   127.5

timeout 点（[EXIT] 124）: 无
```

### ②-2 双插件渐近斜率 ∈ [0.9, 1.1]（n≥20k 段）—— 逐段原始输出

```
---- dual_ma(矩阵) slots=1 ----            ---- dual_ma(矩阵) slots=3 ----
  1000 -> 5000: slope= 1.040                1000 -> 5000: slope= 0.975
  5000 -> 20000: slope= 1.000               5000 -> 20000: slope= 1.015
  20000 -> 50000: slope= 1.034              20000 -> 50000: slope= 0.989
  50000 -> 200000: slope= 0.948             50000 -> 200000: slope= 0.981
  [噪声带] per-rep = [0.979,0.980,0.978]    [噪声带] per-rep = [0.984,0.984,0.985]
  [判据] n>=20000 渐近拟合（3 点）斜率=0.979  [判据] n>=20000 渐近拟合（3 点）斜率=0.984
  [判据] n>=50000 斜率=0.948                [判据] n>=50000 斜率=0.981
  [判据] 斜率 ∈ [0.9,1.1] : PASS            [判据] 斜率 ∈ [0.9,1.1] : PASS

---- indicator_heavy(矩阵) slots=1 ----     ---- indicator_heavy(矩阵) slots=3 ----
  1000 -> 5000: slope= 0.935                1000 -> 5000: slope= 0.977
  5000 -> 20000: slope= 0.990               5000 -> 20000: slope= 1.003
  20000 -> 50000: slope= 0.991              20000 -> 50000: slope= 1.011
  50000 -> 200000: slope= 1.007             50000 -> 200000: slope= 1.015
  [噪声带] per-rep = [0.999,1.001,0.999]    [噪声带] per-rep = [1.014,1.012,1.012]
  [判据] n>=20000 渐近拟合（3 点）斜率=1.001  [判据] n>=20000 渐近拟合（3 点）斜率=1.013
  [判据] n>=50000 斜率=1.007                [判据] n>=50000 斜率=1.015
  [判据] 斜率 ∈ [0.9,1.1] : PASS            [判据] 斜率 ∈ [0.9,1.1] : PASS

（附加点锚定：dual_ma 15000→290000 整体斜率 = 0.968 / 0.999；indicator_heavy = 1.003 / 1.019 ⇒ 亦 ∈ [0.9,1.1]）
（隔离探针 constant_score：20000→200000 斜率 = 1.008 ⇒ 无指标调用时同样线性）
```

**对照（pre，同一分析器跑 P1 冻结数据 `241/raw_pre.txt`）**：

```
---- dual_ma(矩阵) slots=1 ----            ---- dual_ma(矩阵) slots=3 ----
  [噪声带] per-rep = [1.856,1.898,1.873]    [噪声带] per-rep = [1.887,1.881,1.884]
  [判据] n>=20000 渐近拟合斜率=1.878        [判据] n>=20000 渐近拟合斜率=1.882
  [判据] n>=50000 斜率=1.895                [判据] n>=50000 斜率=1.898
  [判据] 斜率 ∈ [0.9,1.1] : FAIL             [判据] 斜率 ∈ [0.9,1.1] : FAIL
---- ctrl(constant_score) slots=1 ----      附加点锚点组：1.892 / 1.895 ⇒ FAIL
  [判据] n>=20000 渐近拟合斜率=1.900 ⇒ FAIL
```

⇒ **同一脚本、同一判据：pre 全 FAIL（1.878–1.900），post 全 PASS（0.979–1.013）** ⇒ 判据有鉴别力，且改造确实生效。

### ②-3 `alloc_bytes` 塌缩为线性（精确 n 翻倍点，来源 `06_prepost_anchors.txt`）

```
series       n   slots     alloc_bytes   alloc_MB ratio(n/2)
dual     12500       1         9897242       9.90          —
dual     25000       1        19793722      19.79     1.9999
dual     50000       1        39594554      39.59     2.0004
dual    100000       1        78577594      78.58     1.9846
dual    200000       1       154566522     154.57     1.9671
dual     12500       3        20920014      20.92          —
dual     25000       3        41816494      41.82     1.9989
dual     50000       3        83617326      83.62     1.9996
dual    100000       3       166600366     166.60     1.9924
dual    200000       3       330589294     330.59     1.9843
heavy    12500       1         9529103       9.53          —
heavy    25000       1        19049199      19.05     1.9991
heavy    50000       1        38088623      38.09     1.9995
heavy   100000       1        76190127      76.19     2.0003
heavy   200000       1       152350959     152.35     1.9996
heavy    12500       3        20545141      20.55          —
heavy    25000       3        41065237      41.07     1.9988
heavy    50000       3        82104661      82.10     1.9994
heavy   100000       3       164206165     164.21     2.0000
heavy   200000       3       328366997     328.37     1.9997

pre（P1 冻结，Σ48(i+1)×slots 二次项）:
  dual_ma  n=20000 slots=1 alloc=     9.61 GB      dual_ma  n= 50000 slots=1 alloc=    60.04 GB
  dual_ma  n=200000 slots=1 alloc=   960.14 GB     dual_ma  n=290000 slots=1 alloc=  2018.61 GB
  dual_ma  n=290000 slots=3 alloc=  6055.70 GB
  ⇒ pre  200k/50k（n ×4）alloc 比 = 15.99×（二次 ⇒ 期望 16×；等价「每翻倍 ≈4×」）
  ⇒ post 200k/50k（n ×4）alloc 比 =  3.90×（线性 ⇒ 期望  4×；等价「每翻倍 ≈2×」）
  ⇒ post 200k/100k（n ×2）alloc 比 = 1.9671× ；post 100k/50k = 1.9846×（**不再是 ≈4**）
```

**判据结论**：n 翻倍 ⇒ 比值 **1.967–2.000（≈2）**，且略低于 2 的方向与 `a·n+b`（含常数项 `b`）一致；
pre 在 ×4 时 **15.99×（≈4²）**⇒ 若按翻倍口径即 **≈4**。**塌缩成立。**

### ②-4 三指纹一并复验（来源 `04_analysis_post.txt` §④）

```
== ④ 三指纹总判定 ==
   dual_ma(矩阵) slots=1              指纹1(t/n²塌缩)=True  指纹2(alloc线性)=True(翻倍点组)  指纹3(斜率不上升)=True  渐近斜率∈[0.9,1.1]=True  ← 判据组
   dual_ma(矩阵) slots=3              指纹1(t/n²塌缩)=True  指纹2(alloc线性)=True(翻倍点组)  指纹3(斜率不上升)=True  渐近斜率∈[0.9,1.1]=True  ← 判据组
   indicator_heavy(矩阵) slots=1       指纹1(t/n²塌缩)=True  指纹2(alloc线性)=True(翻倍点组)  指纹3(斜率不上升)=True  渐近斜率∈[0.9,1.1]=True  ← 判据组
   indicator_heavy(矩阵) slots=3       指纹1(t/n²塌缩)=True  指纹2(alloc线性)=True(翻倍点组)  指纹3(斜率不上升)=True  渐近斜率∈[0.9,1.1]=True  ← 判据组
   （参考组：ctrl / dual_ma 翻倍点 / dual_ma 附加点 / heavy 翻倍点 / heavy 附加点 —— 见原始输出）

== 总判定（仅判据组：dual_ma / indicator_heavy × slots 1,3）: PASS ==
```

**指纹 1（`t/n²` 收敛）** —— post：`t/n²` 在 n=20k→200k 之间衰减 **9.70–10.42×**（n 比 10×，即 ∝1/n，**无二次项平台**）；
pre：同区间只衰减 **1.26–1.33×**（≈常数平台 ⇒ 非零二次项）⇒ 判据 FAIL。
**指纹 2（alloc 线性）** ⇒ 见 ②-3。
**指纹 3（局部斜率单调）** ⇒ 4 个判据组的 n≥20k 段局部斜率**逐段不上升**（含 per-rep 噪声带 `min/max` 均 ∈ [0.9,1.1]）。

> **测量口径说明（诚实标注）**：harness 只输出整数毫秒（`wall_ms`），n ≤ 20 000 的墙钟量化噪声可达 ±20%
> （如 n=1000 时 3 ms vs 4 ms），故局部斜率判据只在 **n≥20k 渐近段**评估；小 n 段的斜率极值
> （如 `heavy_翻倍点 slots=3` 的 50000→100000 段 1.064 > 前段 1.011+0.05，属参考组）在 per-rep 噪声带内
> （该点离散度 1.4–5.8%），不影响判据组。这与 pre/post 对照无关（两侧同等量化）。

### ②-5 前后锚点绝对对照（要求：200k×1slot 与 290k×1/3slots 必须给绝对值）

```
tag                               bars slots |  pre_wall       pre_alloc_MB  pre_rss |  post_wall      post_alloc_MB  post_rss |  speedup alloc_shrink
dual_ma_n200000_s1              200000     1 |    15.584          960142.20     60.1 |      0.614             154.57      68.1 |    25.4x      6211.8x
extra_5y_n290000_s1             290000     1 |    34.437         2018605.03     85.5 |      0.880             236.81      99.6 |    39.1x      8524.3x
extra_5y_n290000_s3             290000     3 |   104.598         6055697.37    115.0 |      2.757             492.03     131.2 |    37.9x     12307.6x
extra_93d_n15000_s1              15000     1 |     0.127            5410.92     23.3 |      0.050              11.54      23.2 |     2.5x       468.9x
extra_93d_n15000_s3              15000     3 |     0.382           16226.06     23.4 |      0.143              24.76      23.4 |     2.7x       655.3x
dual_ma_n50000_s1                50000     1 |     1.127           60036.50     24.8 |      0.165              39.59      24.9 |     6.8x      1516.3x
dual_ma_n20000_s1                20000     1 |     0.207            9614.64     23.6 |      0.064              16.51      23.6 |     3.2x       582.4x
（pre201k×3slots 补充锚点：47.2150 s → post 1.8900 s = 25.0×）

indicator_heavy（post 实测；P1 冻结曲线未含该插件 ⇒ 无同口径 pre 值）
  heavy_n200000_s1          n=200000 slots=1 wall=0.711s alloc=152.35MB rss=66.0MB trades=726
  heavy_n200000_s3          n=200000 slots=3 wall=2.196s alloc=328.37MB rss=89.1MB trades=726
  heavy_extra_5y_n290000_s1 n=290000 slots=1 wall=1.054s alloc=234.87MB rss=93.7MB trades=1063
  heavy_extra_5y_n290000_s3 n=290000 slots=3 wall=3.228s alloc=490.08MB rss=127.5MB trades=1063
```

**峰值 RSS 变化（如实备案）**：`dual_ma` 200k×1slot 60.1 → 68.1 MB（+8.0 MB）；290k×3slots 115.0 → 131.2 MB（+16.2 MB）；
`heavy` 200k×1slot 66.0 MB、290k×3slots 127.5 MB。与 ADR D7 明示的「n × 48 B 缓冲」代价吻合（290k×3 ≈ 41.8 MB 上界），属**预期代价非回退**。

---

## ③ 前视泄漏（look-ahead）判别性测试【新增·最高优先】

**用例代码路径**：`tester/harness/adr024_p2_probe/src/main.rs`（**tester 新增的独立取证包**：独立 workspace + 独立 `Cargo.lock`；
未修改 `adr024_harness` 的任何文件 —— 其 `Cargo.toml`/`Cargo.lock`/`src/main.rs` 迁移前后 sha256 完全一致，见 `70_probe_relocation.txt`）
**运行入口**：`cargo build --offline --release --manifest-path tester/harness/adr024_p2_probe/Cargo.toml` → `./target/release/adr024_p2_probe lookahead <bars.jsonl> [limit]`
**原始输出**：`10_lookahead.txt`（golden `m1_1slot` 1500 根）、`11_lookahead_large_n.txt`（`m1_200k.jsonl` 取 4000 根）

### ③-A 前缀 `bars[0..=i]` 跑一遍 vs 全序列跑到第 i 根（逐位）

```
### A. 前缀 bars[0..=i] 跑一遍 vs 全序列跑到第 i 根（逐位比较）
  i=    0  prefix_len=1  full_len=1500  bitwise=SAME
  i=    1  prefix_len=2  full_len=1500  bitwise=SAME
  i=    4  prefix_len=5  full_len=1500  bitwise=SAME
  i=    5  prefix_len=6  full_len=1500  bitwise=SAME
  i=   18  prefix_len=19  full_len=1500  bitwise=SAME
  i=   19  prefix_len=20  full_len=1500  bitwise=SAME
  i=   20  prefix_len=21  full_len=1500  bitwise=SAME
  i=   25  prefix_len=26  full_len=1500  bitwise=SAME
  i=   26  prefix_len=27  full_len=1500  bitwise=SAME
  i=  100  prefix_len=101  full_len=1500  bitwise=SAME
  i=  750  prefix_len=751  full_len=1500  bitwise=SAME
  i= 1498  prefix_len=1499  full_len=1500  bitwise=SAME
  i= 1499  prefix_len=1500  full_len=1500  bitwise=SAME
  全量逐点（0..n-1，共 1499 点）前缀≡全序列: true（首个不同点=None）
```

比较对象 = **完整 `BarRecord` 的逐位指纹**（`ts/warmup/aggregate.to_bits()`、每个 slot 的 `score.to_bits()`、
`signal`、`orders{side,reason,qty_bits}`、`events{Fill{qty_bits,price_bits,reason},PluginLog,PluginError,CircuitBreaker}`）。
插件（`MIX_JS`）每 bar 调 **全部 7 条指标路径**（`ma(5)/ma(20)/ema(12)/rsi(14)/macd()/kdj()/boll(20,2)/atr(14)`），
分数取指标和的小数部分映射到 [1,99] ⇒ 任一指标的位级变化都会改变分数。
第二数据集（4000 根，`m1_200k.jsonl`）复现同一结论：`全量逐点（0..n-1，共 3999 点）前缀≡全序列: true`。

### ③-B 未来污染不变性 + 正对照（同一用例的"必须变红"能力自证）

```
### B. 未来污染不变性（corrupt bars[from..]，断言 bars[0..from-1] 的记录逐位不变）
  from=    0: 不变区 0..0 相同=0 不同=无 | 正对照（from.. 内变化记录数=1500）: OK（有变化 ⇒ 比较器有鉴别力）
  from=    1: 不变区 0..0 相同=1 不同=无 | 正对照（from.. 内变化记录数=1499）: OK
  from=   19: 不变区 0..18 相同=19 不同=无 | 正对照（from.. 内变化记录数=1481）: OK
  from=  100: 不变区 0..99 相同=100 不同=无 | 正对照（from.. 内变化记录数=1400）: OK
  from=  750: 不变区 0..749 相同=750 不同=无 | 正对照（from.. 内变化记录数=750）: OK
  from= 1498: 不变区 0..1497 相同=1498 不同=无 | 正对照（from.. 内变化记录数=2）: OK
```

（污染 = 保序正仿射 `x→3.7x+0.25`（OHLC 同系数，不破坏 high≥low）+ `ts+10^6` + `volume×7+13`。）
**正对照**证明"比较器有鉴别力"：`bars[from..]` 被改写后**必然**有记录变化（1500/1499/1481/1400/750/2 条），
因此"不变区逐位相同"不是恒真断言。

### ③-C `ctx.bars` 可见面探针（真实引擎 + 自建 `PluginInstance`）

```
### C. ctx.bars 可见面探针（真实引擎会话路径；断言 len==index+1 / bars[index]==ctx.bar / 无未来 bar）
  rows=1500 违例=0 首个违例=None
     idx=0 bars_len=1 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true
     idx=1 bars_len=2 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true
     idx=2 bars_len=3 cur_eq_ctx_bar=true ahead_visible=false shared_handle=true
  探针行 前缀 vs 全序列 不同点: "无"
  探针行 未来污染不变区 不同点: "无"
```

探针行含**全部 7 条指标的 `to_bits()`**（`ma5/ema12/rsi14/macd(dif,dea,hist)/kdj(k,d,j)/boll(mid,upper,lower)/atr14`）+
`index/bars_len/cur_eq_ctx_bar/ahead_visible/shared_handle`，共 1500（4000）行**逐位比较**：
- `bars_len == index + 1` **全行成立**（0 违例）；
- `bars[index] == ctx.bar` **全行成立**；
- `ahead_visible = (bars.len() > index+1)` **全行为 false**（看不到未来 bar）；
- 共享句柄已注入（`shared_handle = true`）；
- 前缀 vs 全序列、以及未来污染不变区，**指标取值逐位相同**。

### ③-D 反向对照（若共享缓冲被改成"预填全量"，本用例必须变红）

```
### D. 反向对照（必须变红）：模拟「共享缓冲被改成预填全量」/改造前批式 ctx.bars 口径
  D1 全量 ctx.bars：len != index+1 的 bar 数 = 1499/1500（首个=Some(0)）；可读到 bars[index+1] 的 bar 数 = 1499
     ⇒ 断言 [ctx.bars.len() == index+1] 在此语义下**变红**（区别于 C 的 0 违例）
  D1b 预填 BarHistory（n=1500）在 index=750 处：history.len()=1500（应为 751）⇒ 断言 [len == index+1] 变红 = true
  D2 「偷看 bars[index+1]」的插件在预填/全量语义下：不变区 0..749 内不同点 = 1（>0 ⇒ 前视确实存在，B 的不变性断言**变红**）
  D3 「读 bars[index+1..] 全局极值」的插件在预填/全量语义下：不变区 0..749 内不同点 = 750/750（大面积 ⇒ B 的不变性断言**大面积变红**）
  对照：真实引擎会话路径下，同一偷看语义不可达（ahead_visible 全 false = true）⇒ ctx.bars 无未来 bar
  ⇒ 反向对照鉴别力自证: PASS（D1/D1b 断言变红 且 D2 前视可检出 且 真实路径无未来）
```

4000 根数据集同样：`D1 = 3999/4000`、`D1b len=4000（应 2001）`、`D3 = 2000/2000`。

**反向对照的含义（关键）**：`D1` 复现的正是**改造前批式入口的 `ctx.bars` 口径**（把**全量**入参切片交给插件），
`D2/D3` 用两个"偷看未来"的插件证明：在那种语义下，本用例的**不变性断言会（大面积）变红**；
而在 P2 的真实引擎路径下同一"偷看"**不可达**。⇒ 本用例具备**可证伪性**（不是恒真）。

**结论**：**③ PASS**（两数据集）。第 i 根 bar 上插件可观察到的指标/上下文**只依赖 `bars[0..=i]`**，
与 `bars[i+1..]` 无关；且共享缓冲**不含**未来 bar。

---

## ④ 会话 vs 批式等价（分块边界 / warmup 绝对口径 / 取消语义）

**入口**：`./target/release/adr024_p2_probe session tester/evidence/240_adr024_golden_baseline/m1_1slot/bars.jsonl 600`
**原始输出**：`20_session.txt`（配置 = 3 slots（`dual_ma` w=1.0 / 指标混合 w=0.5 / `ma_rsi` w=1.5）+ `ATR(2.0)` Intrabar 止损 + `warmup=30`）

```
### 1. 分块喂入 vs 批式入口（同一配置 3 slots/权重 1.0/0.5/1.5 + ATR 止损 + warmup=30）
  批式: per_bar=600 trades=72 nav=570 warmup_marks=30
  chunk=1     (n%chunk=  0) 逐位等价=SAME  per_bar=600 trades=72 nav=570
  chunk=2     (n%chunk=  0) 逐位等价=SAME  per_bar=600 trades=72 nav=570
  chunk=3     (n%chunk=  0) 逐位等价=SAME  per_bar=600 trades=72 nav=570
  chunk=7     (n%chunk=  5) 逐位等价=SAME  per_bar=600 trades=72 nav=570
  chunk=5000  (n%chunk=600) 逐位等价=SAME  per_bar=600 trades=72 nav=570

### 2. warmup 绝对口径（分块不得让 warmup 重新计数）
  批式: warmup 标记下标 = "[0..30)"（计数=30）nav 长度=570
  chunk=1     warmup 标记计数=30 与批式一致=YES nav_len=570 (期望 570)
  chunk=2     warmup 标记计数=30 与批式一致=YES nav_len=570 (期望 570)
  chunk=3     warmup 标记计数=30 与批式一致=YES nav_len=570 (期望 570)
  chunk=7     warmup 标记计数=30 与批式一致=YES nav_len=570 (期望 570)
  chunk=5000  warmup 标记计数=30 与批式一致=YES nav_len=570 (期望 570)
  warmup=0               批式 warmup 标记=0（期望 0）| nav_len=600 trades=73 | 分块 1/7 与批式逐位等价=true
  warmup=n（全部 warmup）    批式 warmup 标记=600（期望 600）| nav_len=0 trades=0 | 分块 1/7 与批式逐位等价=true
  warmup=n+50（> n）       批式 warmup 标记=600（期望 600）| nav_len=0 trades=0 | 分块 1/7 与批式逐位等价=true

### 3. 取消语义（observer 每 bar 调用；Break ⇒ 立即跳出 / 不产结果 / Canceled）
  会话: err=Err(Canceled) 回调次数=8 序列==(0..=7,total)=true records=8 ForceClose 成交=0
        ⇒ 立即跳出（无 finish/无强平/无结果）: YES
  批式 run_ensemble_with_observer: err=Err(Canceled) 回调次数=8（期望 8）
  无取消（Continue 全程）: 回调次数=600 序列==(0..n-1,total=n)=true per_bar=600
  流式（未 set_total_hint）total 退化: [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)] ⇒ OK
  分块(7) observer index 全局单调: OK（len=600）

== session VERDICT: PASS ==
```

**断言结论**
- **分块 {1,2,3,7（非整除，600%7=5）,5000（>总量）} vs 批式入口**：`EnsembleResult` 的
  `per_bar`（逐 `BarRecord` 逐位）/ `trades` / `net_value` / `drawdown` / `metrics` **全部逐位相同**。
- **warmup 是绝对口径**：分块不重计数——warmup 标记恒为 `[0,30)`，`nav` 长度恒为 570；
  边界（`warmup = 0 / n / n+50`）下标记数恒为 `min(warmup_bars, n)`，`warmup ≥ n` 时 `nav` 为空、无 policy 成交流。
- **取消语义**：observer **每 bar 恰调用一次**（index 全局单调，跨块不清零）；返回 `Break` ⇒ **回调序列恰为 `(0..=7, total)`，
  第 8 次后立即停止**，`Err(Canceled)`，会话 `records` 恰 8 条且 **`ForceClose` 成交 = 0**
  ⇒ **未调用 `finish()`、无期末强平、不产出结果**。无取消时回调序列恰为 `(0..n-1, total=n)`。

---

## ⑤ 边界与异常

**入口**：`./target/release/adr024_p2_probe boundary tester/evidence/240_adr024_golden_baseline/m1_1slot/bars.jsonl`
**原始输出**：`25_boundary.txt`（9 用例；每例均额外做 分块 {1,7,5000} 与批式逐位对比）

```
---- 空 bars (n=0) ----
  批式: per_bar=0 nav=0 dd=0 trades=0 warmup_marks=0 | fills: policy=0 force_close=0 stop=0
        metrics=BacktestMetrics { net_profit: 0.0, max_drawdown: 0.0, sharpe: 0.0, win_rate: 0.0, profit_factor: 0.0, annualized_return: 0.0, trade_count: 0, avg_hold_bars: 0.0 }
        分块=1/7/5000 与批式逐位等价=SAME ×3
        空序列断言: per_bar 空=true nav 空=true

---- 单根 bars (n=1) ----                     （含「单根 + 恒 Buy」）
  批式: per_bar=1 nav=1 dd=1 trades=0 warmup_marks=0 | fills: policy=0 force_close=0 stop=0
        nav first=(1788934020, 100000.0) last=(1788934020, 100000.0)   （分块 3 种 SAME）
  （单根 + 恒 Buy：挂单于 bar0、无 bar1 可成交 ⇒ policy fills=0、无期末强平，符合口径）

---- warmup=100 > n=10 ----
  批式: per_bar=10 nav=0 dd=0 trades=0 warmup_marks=10 | fills: policy=0 …
        warmup>n 断言: marks==min(w,n)=true nav 空=true 无 policy 成交=true   （分块 3 种 SAME）

---- warmup=10 == n=10（全 warmup）----
  批式: per_bar=10 nav=0 dd=0 trades=0 warmup_marks=10 | fills: policy=0 …
        全 warmup 断言: marks==n=true nav 空=true 无 policy 成交=true            （分块 3 种 SAME）

---- warmup=0, n=30 ----
  批式: per_bar=30 nav=30 dd=30 trades=0 warmup_marks=0 | fills: policy=0 …
        nav first=(1788934020, 100000.0) last=(1788935760, 100000.0)             （分块 3 种 SAME）

---- 期末强平（恒 Buy, n=40）----
  批式: per_bar=40 nav=40 dd=40 trades=1 warmup_marks=0 | fills: policy=1 force_close=1 stop=0
        metrics=BacktestMetrics { net_profit: -25.57251914385415, max_drawdown: 0.001520898956844791, sharpe: -4.157347071476986, win_rate: 0.0, profit_factor: 0.0, annualized_return: -0.3207091800000489, trade_count: 1, avg_hold_bars: 38.0 }
        nav first=(1788934020, 100000.0) last=(1788936360, 99974.42748085615)
        期末强平断言: force_close 次数=1（期望 1）nav_last==initial+net_profit=YES       （分块 3 种 SAME）

---- 期末强平 + warmup=5（恒 Buy, n=40）----
  批式: per_bar=40 nav=35 dd=35 trades=1 warmup_marks=5 | fills: policy=1 force_close=1 stop=0
        nav first=(1788934320, 100000.0) last=(1788936360, 99974.42748085615)            （分块 3 种 SAME）

---- 恒 Buy + ATR 止损 Intrabar（n=40）----
  批式: per_bar=40 nav=40 dd=40 trades=16 warmup_marks=0 | fills: policy=16 force_close=0 stop=16
        metrics=… net_profit: -2193.050636904314 …                                    （分块 3 种 SAME）

== boundary VERDICT: PASS ==
```

**结论**：空 bars / 单根 / `warmup > n` / 全部 warmup / 期末强平 / 全 warmup + 期末 / Intrabar 止损路径
**全部无 panic、无 crash、无 core dump**；`warmup ≥ n` 时 `nav` 空且无订单；期末强平**恰 1 次**且
`nav_last == initial_capital + metrics.net_profit`（逐位）；每种边界下**分块 {1,7,5000} 与批式逐位等价**。

---

## ⑥ 零改动证明（客观断言）

**原始命令输出**：`30_zero_change_proof.txt`；**归因分析**：`31_zero_change_attribution.txt`

### ⑥-1 `git diff HEAD -- crates/application crates/web crates/storage` → **非空**

```
$ git diff HEAD --stat -- crates/application crates/web crates/storage
 crates/application/src/bar_map.rs                 |  25 ++-
 crates/application/src/simlive.rs                 |   4 +
 crates/application/src/strategy.rs                |  10 +-
 crates/application/tests/backtest_periods_ssot.rs |  97 ++++++++++++
 crates/storage/src/backtest.rs                    |   4 +-
 crates/web/src/workbench.rs                       |  12 +-
 crates/web/tests/adr024_workbench_period_ssot.rs  | 180 ++++++++++++++++++++++
 7 files changed, 322 insertions(+), 10 deletions(-)
```

**不是空，但逐条可归因到 P0（ADR-024 M30 打通 + 周期白名单单一事实源），与 P2 零关系**：

| 文件 | 越界 hunk 内容 | 归属 |
|---|---|---|
| `crates/application/src/bar_map.rs` | 新增 `supported_backtest_periods()` 唯一事实源；`parse_period` 增 `"M30"`；注释 | **P0** |
| `crates/application/src/simlive.rs` | `bt_bar_seconds` 补 `Period::M30 => 1_800` 穷尽分支 | **P0** |
| `crates/application/src/strategy.rs` | M30 归入分钟级档的注释（3 处） | **P0** |
| `crates/application/tests/backtest_periods_ssot.rs`（新） | P0 单一事实源断言 | **P0** |
| `crates/storage/src/backtest.rs` | `period_range_sql` 的 M30 注释更新 | **P0** |
| `crates/web/src/workbench.rs` | 删除手写 period 白名单，改调 `application::bar_map::parse_period` | **P0** |
| `crates/web/tests/adr024_workbench_period_ssot.rs`（新） | P0 web 周期门禁断言 | **P0** |

放宽到所有 P2 范围外目录，另见 `crates/mcp/src/tools.rs` + `crates/mcp/tests/adr024_period_ssot_drift.rs`（P0 漂移断言）、
`crates/domain/src/ports.rs`（P0 注释）、`docker-compose.yml`（并发基础设施事故修复，与 ADR-024 无关）。

### ⑥-2 P2 未触碰调用方的**独立客观证据**（不依赖 worker 的 sha256 对照）

1. **mtime**：所有 P2 范围外源文件 mtime = `12:16:18 – 12:52:00`，**全部早于** P2 源码写入窗口（我的观测：
   `13:17:17`（engine.rs）/ `13:17:24`（history.rs）/ `13:18:12`（indicators.rs））。
2. **worktree vs index**：P2 范围外文件**全部无未暂存改动**（`git status --porcelain` 显示全为 `M `/`A `，
   无 ` M`），即"工作树内容 == index 内容"，排除了"改了没 add / add 后又改"的越界形态。
   本轮**唯一**的未暂存改动是与 ADR-024 P2 无关的 4 个文件：
   ```
   M	design/01-architecture/adr/ADR-023-period-set-extension-30m.md
   M	design/16-backtest-scalability/04-implementation-plan.md
   M	design/99-decisions-log.md
   M	docker-compose.yml
   ```
3. **与 P0 冻结快照交叉引用**（`tester/evidence/247_adr024_p0_freeze/06_post_deliverable_integrity.txt`，13:05:30）：
   该时刻 index = 55 项、`sha256(git diff --cached) = 8f70a57a…`，未暂存清单 = 上述前 3 项；
   本轮未暂存清单 = 上述 3 项 + `04-implementation-plan.md`（架构师 13:06:33 追加的 **P2 范围裁定**）。
   ⇒ **P0 冻结后新增的唯一未暂存项是架构师的 P2 范围说明**，P2 代码本身全部 staged 且不触碰这些目录。
4. **被测 P2 文件内容 sha256**（开始快照 `00_env.txt` vs 结束校验）：`indicators.rs d693c9a1…`、`engine.rs dfa827a9…`、
   `history.rs 6840f854…`、`types.rs c77ef244…`、`quickjs.rs c9aef73c…` —— **完全一致**（本轮未改生产代码内容）。

### ⑥-3 `design/16-backtest-scalability/**` 未被 P2 改动（架构师所有）

```
$ git status --porcelain -- design/16-backtest-scalability
A  design/16-backtest-scalability/01-adr.md
A  design/16-backtest-scalability/02-spec.md
A  design/16-backtest-scalability/03-test-plan.md
AM design/16-backtest-scalability/04-implementation-plan.md
A  design/16-backtest-scalability/contract-vectors.json

$ stat -c '%y %n' design/16-backtest-scalability/*
2026-09-18 00:53:01  design/16-backtest-scalability/01-adr.md
2026-09-17 23:58:21  design/16-backtest-scalability/02-spec.md
2026-09-18 00:39:42  design/16-backtest-scalability/03-test-plan.md
2026-09-18 13:06:33  design/16-backtest-scalability/04-implementation-plan.md
2026-09-17 23:59:02  design/16-backtest-scalability/contract-vectors.json
```

⇒ 5 个文件全部是架构师产出物；`04-implementation-plan.md` 的 `13:06:33`（未暂存段 = **P2 范围裁定**，+6/−1）
早于 P2 代码写入窗口 ⇒ **P2 交付期间 `design/**` 零写入**。

### ⑥-4 旧切片实现未删（客观 grep 计数）

```
$ grep -n 'pub struct Indicators' crates/backtest/src/indicators.rs
50:pub struct Indicators<'a> {

$ # Indicators impl 段逐函数定义位置
56:    pub fn new(bars: &'a [Bar], index: usize) -> Self {
60:    pub fn index(&self) -> usize {
65:    pub fn ma(&self, period: usize) -> Option<f64> {
78:    pub fn ema(&self, period: usize) -> Option<f64> {
91:    pub fn rsi(&self, period: usize) -> Option<f64> {
122:    pub fn macd(&self, fast: usize, slow: usize, signal: usize) -> Option<MacdValue> {
159:    pub fn kdj(&self, n: usize, k_period: usize, d_period: usize) -> Option<KdjValue> {
184:    pub fn boll(&self, period: usize, k: f64) -> Option<BollValue> {
201:    pub fn atr(&self, period: usize) -> Option<f64> {
219:    pub fn true_range_at(&self, i: usize) -> f64 {

$ # 旧实现的黄金样本单测（8 条）仍在
687: fn ma_simple()      698: fn ema_recursive()   705: fn rsi_wilder()      714: fn macd_dif_dea_hist()
723: fn kdj_smoothing()  736: fn boll_population_std()  745: fn atr_wilder()   754: fn true_range_definition()

$ # 本批对 indicators.rs 的 diff：删除行数 = 0
769	0	crates/backtest/src/indicators.rs

$ grep -n 'pub use indicators' crates/backtest/src/lib.rs
19:pub use indicators::{BollValue, Indicators, KdjValue, MacdValue, OnlineIndicators};
```

**函数名清单（仍在）**：`Indicators::{new, index, ma, ema, rsi, macd, kdj, boll, atr, true_range_at}` —— **10 个 pub fn 全部保留**，
`ma/ema/rsi/macd/kdj/boll/atr` **7 条指标 + `true_range_at` + `new/index` 全在**；
`git diff HEAD --numstat` 为 `769 0`（**0 删除行**）⇒ **未删任何旧代码**；`lib.rs` 同时导出 `Indicators` 与 `OnlineIndicators`。

---

## ⑦ 回归

| 门禁 | 命令 | 结果 | 与基线对照 |
|---|---|---|---|
| 后端编译 | `cargo check --workspace --all-targets --offline` | **0 error / 0 warning**（0.93 s） | worker 同结论 |
| 后端 workspace 测试 | `cargo test --workspace --no-fail-fast --offline` | 81 靶：ok **48** / FAILED **33**；**passed 640 / failed 137** | P0 基线（`246/14_workspace_tests.txt`）：111 行结果 / passed **611** / failed **137**；**失败靶集合 33 个逐条完全相同** |
| 失败归因 | 逐 panic 定位 | 137 项**全部** = `crates/test-support/src/lib.rs:32` 的「集成测试拒绝运行：环境变量 `EESTOCK_TEST_DATABASE_URL` 未设置」⇒ **刻意响亮失败**（未设 DB 门禁，与 P2 无关） | 与 P0 基线同因 |
| P2 相关靶 | `cargo test -p backtest -p strategy-runtime -p strategy-core` | `backtest` lib **31**、`strategy-core` lib **33**、`engine.rs` **25**、`observer.rs` **6**、`session.rs` **7**、`session_alloc.rs` **1**、`templates.rs` **3**、`strategy-runtime` lib **17**、`contract.rs` **13**、`dcap_*` **14**、`online_indicators_fixture` **1**、`shared_history` **7**、`shared_history_alloc` **1** —— **0 failed**（唯一 ignored = engine.rs 1 条既有 `#[ignore]`） | — |
| 调用方 | `cargo test -p application --no-fail-fast` | **143 passed / 0 failed**（26 lib + 6 `backtest_periods_ssot` + 55 `simlive` + 39 `strategy` + 17 `workbench`） | 与 worker 自报 **143 逐数一致** |
| P2+调用方 合计 | 同上 4 crate | **passed 302 / failed 0** | — |
| 前端 | `npx vitest run`（cwd=`web`） | **Test Files 89 passed (89) / Tests 850 passed (850)**，`EXIT=0` | P0 基线（`246/12_frontend_vitest_full.txt`）：**89 files / 850 tests**，逐数相同 ⇒ **前端基线一致，P2 未影响前端** |

**取舍说明**：workspace 级 `cargo test` **未**设置 `EESTOCK_TEST_DATABASE_URL`（任务纪律：不新建数据库、不误指活库），
故 33 个 DB 集成靶按设计**响亮失败**——这与 P0 冻结前基线**逐靶一致**，故不构成回归。若需 DB 靶全绿，
须先跑 `scripts/testdb-init.sh` 并导出该环境变量（超出本次任务边界，未执行）。

**崩溃 / core dump**：**0**（无 `SIGSEGV` / `SIGABRT` / `core.*` 文件；全部失败均为 `assert`/`panic!` 的 Rust 断言，非进程级崩溃）。

---

## ⑧ 测试有效性抽查（防空断言）

**驱动器**：`tester/evidence/248_adr024_p2_verify/run_mutation.sh`；**原始输出**：`50_mutation.txt`
**方法**：每组「人为扰动 → 跑判据测试（期望红）→ 复原（`cp` + `touch`）→ 跑同一测试（期望绿）」，
并**显式校验复原复跑里 cargo 确实重编译**（否则标记"结果无效"，见 §10 的 T1 缺陷修正）。

| # | 被测新测试（P2 新增） | 人为扰动 | 扰动后 | 复原后 | 重编译校验 |
|---|---|---|---|---|---|
| M1 | `backtest` lib `indicators::tests::online_rsi_matches_slice_view`（8 条指标等价单测之一） | `RsiState` 种子分母 `period → period-1` | **RED** `EXIT=101`：`rsi(3) @i=3: 位级不一致 got=90.0 want=85.714…` | **GREEN** `EXIT=0` | 1 crate ✅ |
| M1b | `strategy-runtime/tests/online_indicators_fixture.rs`（真实 golden fixture 位级等价） | 同上 | **RED** `EXIT=101`：`m1_1slot @i=6 rsi6: 位级不一致 want=50.0 got=54.545…` | **GREEN** `EXIT=0` | 2 crate ✅ |
| M2 | `strategy-core/tests/session.rs::session_observer_called_per_bar_and_break_is_immediate` | `push_batch` 的 observer index offset 1（`bars_seen-1 → bars_seen`） | **RED** `EXIT=101`：`left=[(1,40)…(7,40)]` vs `right=[(0,40)…(7,40)]` | **GREEN** `EXIT=0` | 3 crate ✅ |
| M3 | `strategy-core/tests/session_alloc.rs::engine_per_bar_allocation_does_not_grow_with_index` | 删除 `.with_history(shared.clone())`（退回每 bar 复制） | **RED** `EXIT=101`：`ratio=1.948`（n=2000:50 614.6 → n=4000:98 612.3 B/bar） | **GREEN** `EXIT=0` | 3 crate ✅ |
| M3b | `session.rs::session_shared_history_exposes_current_bar_to_plugin` | 同上 | **GREEN**（未变红） | GREEN | 3 crate ✅ |
| M4 | `session.rs::session_warmup_marker_is_exact` | warmup 判定 `i < w → i+1 < w` | **RED** `EXIT=101`：`warmup=1: 标记根数 left=0 right=1` | **GREEN** `EXIT=0` | 3 crate ✅ |
| M5 | `strategy-runtime/tests/shared_history.rs::bar_history_indicators_match_slice_view` | `BarHistory::ma` 窗口错位（`index → index-1`） | **RED** `EXIT=101`：`ma(1) @i=1 位级不一致` | **GREEN** `EXIT=0` | 2 crate ✅ |
| M6 | `backtest` lib `online_kdj_matches_slice_view` | KDJ 平滑系数 `1/k_period → 1/(k_period+1)` | **RED** `EXIT=101`：`kdj(9,3,3) @i=8 got=53.1250… want=59.7222…` | **GREEN** `EXIT=0` | 1 crate ✅ |
| M7 | `backtest` lib `online_atr_matches_slice_view` | ATR Wilder 递推 `(period-1) → period` | **RED** `EXIT=101`：`atr(1) @i=1 got=0.16 want=0.07` | **GREEN** `EXIT=0` | 1 crate ✅ |

**结论**：**9 组扰动中 8 组被对应新测试准确捕获（红），全部复原后回绿且经重编译校验**；
覆盖 `backtest` 的 3 条指标等价单测（RSI/KDJ/ATR）、`online_indicators_fixture`、
`session.rs`（observer / warmup）、`session_alloc.rs`、`shared_history.rs` —— 远超"至少 3 条"要求。
**无恒真断言**。

**如实披露（1 条不敏感）**：`session_shared_history_exposes_current_bar_to_plugin`（M3b）在删除共享句柄后**不变红**。
原因：该断言是**语义级**的（`ma(1)` 必须等于当前 bar 收盘价 + 会话结果 == 批式结果），而兼容路径
`BarHistory::from_bars(&bars[..=index])` 与共享句柄路径**语义等价** ⇒ 该测试**不负责**机制替换的检测；
机制级判据由 `session_alloc`（M3，已红）承担。这属**分工而非缺陷**，但应以 M3 为"共享缓冲生效"的唯一判据。

---

## ⑨ 未过项 / 观察 / 建议

### 未过项
**0 条。**

### 非阻塞观察

**O1（需架构师文档裁定）** — 会话路径下 `ctx.bars` 的语义**由「调用方入参切片（含未来 bar）」收窄为「`bars[0..=index]`」**。
我的独立测量（`10_/11_lookahead.txt` §C）：真实引擎会话路径下 `bars_len == index+1` **全行成立**、`ahead_visible` **全 false**；
反向对照 D1/D2/D3 显示改造前口径（全量切片）下同一"偷看"插件会读到未来 bar 并使不变性断言变红。
- 影响面：仅宿主侧 Rust `PluginInstance`（JS `ctx` 不注入 `bars`，见 `quickjs.rs::build_ctx_object`）⇒ **零 ABI 变更**。
- 我独立 grep 确认：**仓内无任何实现读取 `ctx.bars` 中 `index` 之外的 bar**
  （`shared_history.rs` 的探针只做 `bars[i]` / `bars.len()`；`bars[ctx.index+1]` / `bars.last()` / `bars[len-1]` 类写法为 0）。
  **但需注意**：兼容路径的两个生产调用点（`crates/application/src/strategy.rs:907` 试算、`crates/simlive/src/plugin_orchestrator.rs:264`）
  **仍然传入含未来 bar 的全量切片**（改造前口径未变，且均属 P2 范围外）⇒ 该"可读未来"能力在这两处**仍存在但未被使用**，
  与 worker §5.2 的备案一致。
- 该收窄**移除了一个潜在前视面**（安全方向），但**改变了宿主侧可观察契约**，需架构师确认文档措辞（worker §5.3 已提）。

**O2（P2 gate 的 M30 覆盖缺口）** — golden 基线仍为 **11 例**，缺 `m30_1slot` / `m30_3slots`（P0 已落地 M30）。
本报告 ① 按任务口径覆盖 11 例。M30 与 M1 走**同一引擎路径**（`period` 仅作绩效年化因子，不进任何循环/缓冲），
故对本批线性化判据**无实质影响**；但若 P2 gate 要求"档位全覆盖"，须补 2 例后再冻结。

**O3（`04-implementation-plan.md` 未入 index）** — 架构师 13:06:33 追加的 **P2 范围裁定**段处于**未暂存**状态；
若按 **index** 交付，该说明会缺失（与 `247` 冻结报告 §5 观察 O1 同类）。建议架构师确认是否补 `git add`。

### 建议（不阻塞冻结）

**R1** — 把 M3 类（机制级）与 M3b 类（语义级）的分工写进 P2 测试注释，避免后续误判"语义测试也覆盖了机制"。

**R2** — 范围外仍存在同类二次项（`crates/application/src/strategy.rs:894` 试算逐 bar 评分循环、
`crates/simlive/src/plugin_orchestrator.rs:242` sim-live 累计 bars 视图 —— 仍走兼容路径，每 bar 复制 `bars[..=index]`）。
P2 范围裁定内**未动**（正确），但建议**排期 P4/P5**（修法小：各持 `Rc<BarHistory>` + `BarContext::with_history`）。

---

## ⑩ 纪律自证 / 与 worker 的差异声明

| 项 | 证据 |
|---|---|
| 未改生产代码（内容） | 被测 13 文件开始/结束 sha256 一致（`00_env.txt` / `50_mutation.txt` 末段） |
| ⑧ 临时扰动已完全复原 | `50_mutation.txt` 末段 `git diff --name-only -- <三文件>` 行数 = **0**；三文件 sha256 回到开始快照值 |
| 未 `git add` / `commit` | 结束态 `git diff --name-status`（worktree vs index）与开始态**完全一致**（4 个无关文件），无新增暂存项 |
| 未新建数据库 / 未连库 | 全程未设 `EESTOCK_TEST_DATABASE_URL`；workspace 137 项失败即该门禁的刻意失败 |
| 未触碰只读基线资产 | `240/compare_report.txt` BEFORE/AFTER sha256 均 `5c181bf2…`；`241/raw_pre.txt` 仅只读引用 |
| 工具/资产缺陷已如实记录 | §10-T1（`cp -p` 假红，整轮作废并改 v2）、T2（分析脚本索引 bug）、T3（`touch` 仅改 mtime）、T4（基线文件被 `compare.sh` 重写，sha256 未变）、T5（`wall_ms` 整数毫秒量化）、**T6（探针曾作为第 2 个 bin 放进冻结 harness ⇒ 破坏 `cargo run`；已迁到独立包并复核 `adr024_harness` byte-identical）** |
| 与 worker 报告不符之处 | **无**。所有可独立复核项均一致（含逐字相同的 947.3/944.6 B/bar）；唯一**不可复核**项 = `indicator_heavy` 的 **pre** 数字（239.7 s / 1 120 GB），因 pre 态不在工作树且 P1 冻结曲线未含该插件 ⇒ **未采信为判据**，但其 post 侧已独立测得 0.711 s。 |

**证据完整性**：`tester/evidence/248_adr024_p2_verify/` 共 **31** 个文件（含 `EVIDENCE.md` 与 4 个可复现脚本）+ 1 个备份目录（3 个 `.orig`）；
另有 3 个新增可复现入口（`run_scale_post_heavy.sh` / `run_scale_alloc_dbl.sh` / `run_mutation.sh`）与
1 个测试资产（`tester/harness/adr024_p2_probe/`，独立包：`Cargo.toml` + `Cargo.lock` + `src/main.rs`）。
