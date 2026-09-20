# 执行报告：ADR-028 §2.4c（D4.2）结果页缩放 + 指标可选 —— tester 独立终验

> **本文件自身路径**：`tester/test/019_adr028_d5_result_resize_verify.md`
> 主报告（判词前置 + 逐条读数）：`tester/evidence/20260920_result_resize_verify/report.md`
> 原始输出：`tester/evidence/20260920_result_resize_verify/raw/`
> 设计报告：`tester/design/307_adr028_d5_result_resize_verify_design.md`

- **运行时间**：2026-09-20 12:19–12:31 CST
- **commit**：`cf3e6e714e5615227d56dbb4d64253c4dc982bde`（工作树 = 波前 + 实现方暂存的 19 文件；**本波未改任何源码**）
- **真身**：`http://localhost:8081`（主机进程 `eestock-app`，`static_dir=./web/dist`，bundle `assets/index-xGaRgVd-.js` sha256 `8d936e11…93a8bc`）
- **环境**：playwright chromium，`--workers=1 --retries=0`；vitest 逐文件 `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`

## 1. 测试套件结果

| 套件 | 命令（略去公共前缀） | total | passed | failed | skipped |
|---|---|---|---|---|---|
| 自建终验规格（真身 8081） | `playwright test e2e/adr028-d5-result-resize-tester-verify.e2e.ts` | 6 | **6** | 0 | 0 |
| 冻结 `adr028-resize-probe` | 同上（改文件名） | 1 | **1** | 0 | 0 |
| 冻结 `adr028-window-sync` | 同上 | 6 | **6** | 0 | 0 |
| 冻结 `adr028-axis-align-probe` | 同上 | 2 | **2** | 0 | 0 |
| 冻结 `adr028-features-verify`（第 1 次全量） | 同上 | 10 | 9 | **1** | 0 |
| 冻结 `adr028-features-verify`（第 2 次全量，复跑） | 同上 | 10 | **10** | 0 | 0 |
| 冻结 `adr028-features-verify -g T4`（隔离复跑） | 同上 | 1 | **1** | 0 | 0 |
| 单元（本波新增 5 文件，逐文件单跑） | `vitest run <file> --maxWorkers=1` | 42 | **42** | 0 | 0 |
| 变异反证 M1（`dist-mut`，固定 svg 高度） | `playwright test …`（`E2E_BASE_URL=:4175`） | 3 运行 / 2 未跑 | 2 | **1（RV-3，预期红）** | 0（serial 中止） |
| 变异反证 M2（`dist-mut`，指标切换重建实例） | 同上（`:4176`） | 2 运行 / 4 未跑 | 1 | **1（RV-2，预期红）** | 0（serial 中止） |

汇总（非变异）：**68 用例 / 67 passed / 1 failed（后两次复跑全绿） / 0 skipped**；变异运行 2 次**均为预期红**。

## 2. 失败用例表

| 用例 | 错误信息 | 栈/位置 | 崩溃/Core |
|---|---|---|---|
| 冻结 `adr028-features-verify` → **T4 只高亮被点击那一笔 [@mut]**（第 1 次全量运行；用时 4.1s，正常 13.6–13.9s） | `跳转后目标笔几何必须可测（按 ts+价格定位）` → `expect(gA != null && gB != null).toBe(true)` | `web/e2e/adr028-features-verify.e2e.ts:583`（前置几何定位步骤，非本波新增断言） | **无**（无 crash / 无 core dump / 无 OOM） |
| 变异 M1 → 自建 RV-3（**预期红**） | `[aggregate] svg 高度必须随容器（实测 160→160）——固定高度即在此变红` | `adr028-d5-result-resize-tester-verify.e2e.ts` RV-3 | **无** |
| 变异 M2 → 自建 RV-2（**预期红**） | `指标切换后已拖高度的 VOL pane 必须保持（切换前 63 / 切换后 null）` | 同上 RV-2 | **无** |

复跑与结论：T4 在随后「全量第 2 次」与「`-g T4` 隔离」两次运行**均 passed** ⇒ 记为**非确定性闪红**
（原文见 `raw/frozen_features_verify.txt`；绿运行见 `raw/frozen_features_verify_run2_green.txt` 与
`raw/frozen_features_verify_T4_isolated_rerun.txt`）。按要求**未做根因分析**，仅登记为残余风险 R1。

## 3. 崩溃 / Core dump

**无**：`find web crates -name "core*" -newermt "-3 hours"` 为空；5+1 个规格运行无进程崩溃、无 OOM（内存记录见 `raw/resource_discipline.md`）。

## 4. 覆盖摘要

| 判据 | 结果 |
|---|---|
| 指标选择（入口/真身/切换） | 通过（6 枚入口；真身 `MA+VOL → MA → MA+MACD → KDJ+MA+MACD`） |
| 隔离性（3 口径） | 通过（增量恰 1 键；哨兵键逐字节不变；非 GET 配置写 = 0；看板仍默认） |
| K 线卡拖高与双击复位 | 通过（256→406，内层 194→344；复位 256/194） |
| 副图 pane 高度切换后保持 | 通过（63→63，Δ=0；MACD 独立新 pane；关净后副图 pane 集合空、分隔条 0） |
| 曲线卡拖高与复位 | 通过（聚合 204→264/svg 160→220；净值 236→296/svg 208→268） |
| 只做高度 | 确认（宽/viewBox/顶点 userX 不变；横向拖 +80px 无宽度变化；无宽度类把手） |
| 表格类 | 通过（三表格把手 0 / inline 高度 null / ns-resize 0） |
| PAD 单源与偏差 | 单源成立 + 守卫单测钉 8 + 运行期首末 8/992 + 跨视图偏差 **0.0px** |
| 持久化 | 通过（刷新后卡高 376 与 macd=开保持；键集不变） |
| 四规格 | 全绿（复跑达成；T4 有 1 次闪红） |
| 冻结常量修改 | 追认（暂存 numstat `2 2`；断言未放宽；新 sha256 独立复算一致） |
| 变异反证 | 有牙（M1→RV-3 定点红；M2→RV-2 定点红；还原后 bundle 逐字节一致） |

## 5. 纪律声明

- **未修改任何生产代码/接口/架构**；两个变异为临时改动，均已按备份还原，且 `git diff` 为 0 行、重建产物与线上 bundle `cmp` 逐字节一致。
- **未尝试修复任何失败**（T4 闪红仅如实登记；M1/M2 为预期红）。
- 跑冻结规格覆盖的 66 个 **tracked** 证据文件已逐一 `git checkout --` 还原（收尾 `git status` 与波前逐行一致）；
  **未入库**的 `tester/evidence/20260920_result_resize_probe/raw/` 30 个历史产物被本次复跑覆盖，**如实披露**（无 git 基线可还原）。
- 收尾残留：`vite preview` 0、playwright 浏览器 0、`dist-mut`/`dist-restore` 已删除、core dump 0；8081 仍 200。
