# 275 — P3-D-3 独立验收执行报告（真渲染复现 + 反向变异 + 回归卫生）

- **本文件路径**：`tester/test/275_p3d3_independent_acceptance_execution.md`
- 角色：Tester（独立复核 + 取证；**未分析失败、未修任何代码**）
- 执行时间：2026-09-14 23:42–00:20（本地 UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`，HEAD `ec32767d330b0dec4d31e0c8a138a00a32988865`（P3/P3-D 在工作树，未提交）
- 设计报告：`tester/design/275_p3d3_real_render_acceptance_design.md`
- 证据目录：`tester/evidence/275_p3d3_acceptance/`
  （`harness.html`/`run.mjs`/`chartSyncGroup.mjs`(转译物)/`p3d3_harness.json`/`p3d3_harness.png`/`mutations/`/`full_suite.txt`/`tsc.txt`/`check_tangle.txt`）
- 仪器位置：`/tmp/p3d3/**`（临时，不在仓库内；仓库仅新增本报告与证据）

## 1. 命令与结果

| 命令 | 结果 | 摘要 |
|---|---|---|
| `node /tmp/p3d3/run.mjs`（真身 klinecharts 10.0.3 + 生产 `ChartSyncGroup`，`file://`） | **13 PASS / 0 FAIL**，`errors=[]`、`console=none`、**非本地网络请求 0** | 见 A 表 |
| `npx vitest run`（仓库全量） | **77 files / 706 tests passed**（EXIT=0） | 无回归 |
| `npx tsc -b`（`/tmp` 副本，避免改仓库） | EXIT=0，无输出 | 类型 0 错 |
| `./scripts/check-tangle.sh`（**在 `/tmp/p3d3/repo` 全量副本沙箱内**跑，仓库未执行） | EXIT=0 ✅ 逐字节一致 | 无漂移 |
| 反向变异 ×5（`/tmp/p3d3/mut` 副本 + 真渲染 rebundle） | 见 B 表 | 全部取红 |

**崩溃/core dump**：无；`pageerror=0`；无残留进程/端口。

## 2. A 逐项结论（真渲染实测）

| 项 | 结论 | 实测数值（证据 JSON 键） |
|---|---|---|
| A-1 对齐成功：1m↔1m ≥20 轮 | **PASS** | `maxDrift=0`（20/20 轮；样本 `base=[253,302] sat=[253,302]`…），`maxEdgeDiffBars=0`，`suppressed=164>0`，`echoEvents=0`，`lastCorrectionIterations=2` |
| A-1 跨周期 1m↔5m | **PASS** | 跨度差 **0.179 根** / 右端差 **0.106 根**（stats 残差 0.179/0.106），卫星 13 根，`satBS=44`（推导 38 + 闭环微调 +6） |
| A-1 跨周期 1m↔15m | **PASS** | 跨度差 **0.082 根** / 右端差 **0.344 根**（stats 0.067/0.344），卫星 5 根，`satBS=137`（调整 +39） |
| A-1 跨周期 1d↔1w | **PASS** | 跨度差 **0.276 根**（stats 残差 0.205）/ 右端差 **0.403 根**，卫星 13 根，`satBS=43`（调整 +6） |
| A-2 降级路径 1m↔1h | **PASS** | `satBS=260`(= capacity)、卫星 **4 根**、右端差 **0.259 根 ≤1**、`degraded=true`/`degradedPeriod='1h'`、`spanResidualBars=2.370`（>1 ⇒ **实测可达下界，跨度判据不适用**；几何实测 2.360）、`lastUnalignedReason='1h:no-improvement'`、迭代 2、store `syncDegraded=true/syncDegradedPeriod='1h'`、onChange 4 次快照全为 degraded |
| A-2 缩小基准 ⇒ 回到成功路径 | **PASS** | base bs 8→4：`satBS=227`、跨度差 **0.772 根 ≤1**、右端差 **0.259 ≤1**、`degraded=false`、store `syncDegraded=false`、`unalignedFollowers=0` |
| A-3 fail-closed（先尝试完整对齐） | **PASS** | 降级只出现在「闭环迭代上限 / 无改善 / 候选用尽」三处**事后**判定（`alignFollowerWindow` 返回 `aligned:false` 时）；`lastUnalignedReason` ∈ `{no-improvement, iteration-cap, unreachable, no-window, no-scroll-api, no-layout, no-density-anchor, no-data, no-barspace-api}`，`lastCorrectionIterations` 恒 ≤3；变异 ①b（直接降级）双口径红 |
| A-4 基准冻结（口径 7） | **PASS** | 卫星做 leader（`setBarSpace(300)`+`scrollToDataIndex(40)`）：基准 `barSpace` 8→8、可见范围 `[241,302]`→`[241,302]`、右偏移 0→0、**基准 `setBarSpace` 写入 0 次**；对照 `naiveWouldWriteBaseBS=50`（若把基准当 follower：`min(round(300/4.67)=64, 基准上限 50)=50`） |
| A-5 可观测 | **PASS** | 缺 `setBarSpace` 面的 follower：`unalignedFollowers=1`、`lastUnalignedReason='5m:no-barspace-api'`（不再静默）、其余 follower 仍对齐（13 根）、`spanResidualBars=0.179`/`edgeResidualBars=0.106`/`barSpaceAdjust=6` 均可从 `stats` 读出 |
| A-6 有界性（真渲染） | **PASS** | 1m↔1h(base bs=40)：`lastCorrectionIterations=2 ≤3`、写入序列 `[260,260,260,260]`、单步幅度 0%（≤50%） |

> 与实现车道自述的对照：1m↔1m `maxDrift=0`、1m↔5m 0.179/0.106、1m↔15m 0.067/0.344、1d↔1w 0.403（边缘）与 T8bis edge 0.259 / span 2.37、基准 bs 10→10（本 harness 配置下 8→8）**均独立复现**。1d↔1w 跨度差自述 0.062：`stats.spanResidualBars=0.205`；本 harness 的几何口径（用基准数据实测间距 `WEEK/4.67`）为 0.276 ⇒ 两者皆 ≤1，差异来自基准桶宽约定（见已知限制 ②）。

## 3. B 反向变异（每处均红；同一 `/tmp/p3d3/mut` 环境，源码仓库只读）

| # | 变异 | 聚焦 vitest（3 文件 26 例） | 真渲染 harness | 红证据（文件名） |
|---|---|---|---|---|
| ①a | 移除 `probeMaxBarSpace`（写入被静默吞掉即降级，不探真实上限） | **RED** 1 failed / 25 passed | — | 用例：`边界-上限不足：卫星 barSpaceLimit 太小时必须显式降级`（M1a） |
| ①b | 不尝试完整对齐即降级（闭环移除 = fail-closed 破坏） | **RED** 7 failed / 19 passed | **RED 5 PASS / 8 FAIL** | 真渲染红：A1(maxDrift)、A2×3、A3 降级、A3 缩小、A5；vitest 红含 `可对齐的降级 barSpace…先尝试完整对齐` |
| ② | `targets` 过滤去掉 `!m.isBase`（允许基准被改写） | **RED** 1 failed / 25 passed | — | 用例：`【硬约束】基准永不作为 follower：卫星做 leader ⇒ 基准 barSpace/可见范围**逐字段不变**（反向变异必红）`（M2） |
| ③ | 桩 `scrollToTimestamp` 改回「理想贴右缘/精确」 | **RED** 3 failed / 23 passed | 桩与真渲染无关（见下） | 红：`syncChartStubFidelity` F1 / F3 / F4 ⇒ **桩的保真度本身被判据钉住**（M3a） |
| ③' | 同上 + 索引定位退回 `scrollToTimestamp` | 桩保真度 3 红；**同周期 G1 判据变绿（被精确桩掩盖）** | 同一实现缺陷下真渲染 **A1 红**（M1b 口径） | ⇒ 精确桩会掩盖「+2 根落点」缺陷，而真渲染口径能抓住（M3b/M1b/M3c） |
| ④ | `MAX_ALIGN_CORRECTION_ITERATIONS 3→50`、`MAX_BAR_SPACE_STEP_RATIO 0.5→50`、删除「无改善即停手」 | **RED** 1 failed / 25 passed（`expect(MAX_ALIGN_CORRECTION_ITERATIONS).toBeLessThanOrEqual(3)`，`chartSyncAlignClosedLoop.test.ts:65`） | **GREEN**（见已知限制 ③） | 字面量上界判据取红（M4） |

## 4. C 回归与卫生

- 全量 `vitest`：**77 files / 706 tests 全绿**；`tsc -b` EXIT=0；`check-tangle` EXIT=0（在 `/tmp` 全量副本沙箱内执行，**仓库内未跑 tangle**）。
- P1/P2/①②③④/dcap 契约：全量套件包含其用例，未见失败（无 skip）。
- 线上 PID **3112540** 未触碰（`etime=11:57:49`，仍监听 8081/8082）；**0 写请求**（真渲染全程 `file://`，`networkNonFile=0`）；未起临时服务、无临时端口残留、无残留进程。
- `git diff --cached` **空**；tracked 改动 7 个（`design/15-multi-period/{02-spec,03-test-plan}.md` + 5 个前端文件），新增未跟踪文件为 P3 测试/模块与 `tester/` 报告；**未** `git add/commit/stash`。
- 变异只在 `/tmp/p3d3/{mut,repo,h_*}` 副本进行，已还原（`restore()`）。
- 披露：为跑 `tsc -b` 删除了 `web/node_modules/.tmp/tsconfig.app.tsbuildinfo`（**未跟踪的构建缓存**，经符号链接落在仓库 `node_modules` 内），随后 `tsc -b` 已重建。

## 5. 已知限制（如实记录）

1. **T8bis 物理下界**：真身 `capacity=floor(520/2)=260` 时 1h 卫星实际可见接 **4 根**（引擎比 `floor(w/bs)` 多容纳），跨度残差下界 ≈**2.36–2.37 根**、右端 0.259 根。故降级路径**不可能**满足「跨度 ≤1 根」；本报告按 spec 口径把它记录为**可达下界**（`spanResidualBars`），不作为失败。
2. **跨度差口径差**：本 harness 以「基准数据实测间距」计算几何跨度，实现以 follower 桶宽计算残差 ⇒ 1d↔1w 出现 0.276 vs 0.205 的差（两者均 ≤1 根）。自述值 0.062 未在本 harness 复现（同量级、同侧、不改变结论）。
3. **④的步长轴未被钉住**：现有用例只用 `expect(MAX_ALIGN_CORRECTION_ITERATIONS).toBeLessThanOrEqual(3)` 钉迭代常量；`MAX_BAR_SPACE_STEP_RATIO` **无字面量断言**，且真渲染 harness 在放大上限后仍绿（候选去重使循环提前停手）⇒ 步长有界性主要靠代码检视而非判据。
4. **③ 的边界**：仅「索引定位被移除」这一层不被两口径取红（闭环可补偿 +2 根落点差）；能被取红的是「闭环/完整对齐尝试被移除」（M1b）与「桩保真度被破坏」（M3a）。
5. 真渲染数据为合成序列（1d/1w 用理想 5/7 与逐周间距），未含节假日 ⇒ 密度用实测锚定值 4.7/12.2/37.8/4.67。
6. 真渲染未构造「无共同锚点」（`no-density-anchor`）场景：构造器护栏会拒绝表外组合，该跳过路径当前只有 jsdom 覆盖。

## 6. 最小修正建议（未实施，交架构/实现车道裁决）

1. 在 `chartSyncAlignClosedLoop.test.ts` 增补 `expect(MAX_BAR_SPACE_STEP_RATIO).toBeLessThanOrEqual(0.5)`（与 line 65 同构），把步长有界性变成判据（当前不可测）。
2. 闭环起点若改用「当前 `barSpace`」或缓存上次调整值，可消除跨广播的 `ideal → adjust` 反复写入（实测 1m↔5m 写入序列 `[38,38,41,38,44,38,44]`，最终值稳定但抖动使 `barSpaceAdjust` 在 `0/+6` 间跳变）——不影响任何判据，仅提升可观测稳定性。
3. 为 `1d↔1w` 统一「跨度差」的桶宽约定（基准实测间距 vs 周期桶），消除报告口径差（≥0.07 根量级）。
4. （可选）给真渲染 harness 补一个 `measureDensity` 失效探测（同窗无重叠），覆盖 `no-density-anchor` 真实路径。

**未对任何失败做分析、定位或修复**（按 Tester 角色约束）；载体为 `/tmp` 副本，仓库产品代码零改动。

VERDICT: PASS
