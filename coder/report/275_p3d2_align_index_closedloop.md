# 275 — P3-D-2 实现报告：多周期对齐改为「按索引定位 + 有界闭环校正」

- **本文件路径**：`coder/report/275_p3d2_align_index_closedloop.md`
- 角色：Coder（实现 + 真渲染自测；**未改任何测试的断言**，P3-D-1 红测试仅转绿）
- 时间：2026-09-14（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `ec32767`；P3 实现在工作树未提交）
- 证据目录：`coder/evidence/275_p3d2_align_index_closedloop/`
  - `real_render_harness.html` + `real_render_driver.mjs`（真身 klinecharts 10.0.3 + **生产** `ChartSyncGroup`，`127.0.0.1` 临时端口、0 外网）
  - `p3d2_harness.json` / `harness_stdout.txt`（真渲染实测）
  - `real_render_dbg_trace.html` + `real_render_dbg_driver.mjs` + `dbg_call_trace.json`（调用轨迹，用于定位闭环问题与取证引擎落点）
  - 重建命令：`web/node_modules/.bin/esbuild web/src/features/dashboard/chartSyncGroup.ts --bundle --format=esm --outfile=/tmp/p3d2-harness/chartSyncGroup.mjs`（+ `cp web/node_modules/klinecharts/dist/umd/klinecharts.min.js`）
- 权威依据：`design/15-multi-period/{01-adr.md §2.3, 02-spec.md §3, 03-test-plan.md}`；P3-C 独立验收
  `tester/evidence/273_p3c_acceptance/p3c_harness.json`；P3-D-1 红测试 `tester/design/274_p3d1_faithful_stub_red_design.md`
- 用户口径（方案 1）：诚实降级 + 「对齐受限」角标；**严禁静默虚假对齐**。
- **架构裁决（2026-09-14，本报告的最终口径）**：(A) 批准「分路径判据」——**定性为判据适用范围澄清，不是放宽**；
  (B) 否决（实测无效）；barSpace 微调**接受**但须有界/可观测/文档化；**新增硬约束：基准实例永不作为 follower**。
  本报告已按该裁决实现并复测（§3.5/§4.6/§6）。

---

## 1. 改动文件清单（工作树，**未 `git add`/未提交**，遵守「禁 git add/commit/stash」）

| 文件 | 性质 | 说明 |
|---|---|---|
| `web/src/features/dashboard/chartSyncGroup.ts` | 实现（P3 同步原语） | **核心改动**：`scrollToTimestamp` → **索引定位 + 有界闭环校正**；新增 `nearestIndexByTs` / `MAX_ALIGN_CORRECTION_ITERATIONS` / 未对齐可观测统计 |
| `web/src/features/dashboard/chartSyncContext.ts` | 接线（统计快照） | `EMPTY_SYNC_STATS` 补齐新统计字段（组销毁 ⇒ 角标/统计归零，零残留不变） |
| `web/src/features/dashboard/multiPeriodStore.ts` | store 可观测 | 新增 `syncDegradedPeriod`（base 作为 follower 降级时可从 store 读出）；`applySyncStats` 镜像 |
| `web/src/features/dashboard/chartSyncAlignClosedLoop.test.ts` | 新增测试 | 闭环迭代上限/收敛、未对齐可观测（未布局/无数据/容差不可达）、base 作为 follower 的降级可观测 + store 可读 |

> `chartSyncGroup.ts` / `chartSyncContext.ts` 在 HEAD 中是 P3 新增文件（未跟踪），故 `git diff --stat` 只显示
> `multiPeriodStore.ts` 等已跟踪文件；工作树改动均已保留、**未暂存**。

## 2. 问题（P3-C 独立验收 FAIL(B1,B2,B4) 的单一根因）

真身 klinecharts 10.0.3 的右缘落点**恒为「请求索引 + 2 根」**，且 `setOffsetRightDistance(0)` **无法消除**；
旧实现按 `scrollToTimestamp(leader.toTs)` 定位 ⇒ 相对漂移恒 2 根（1m↔1m 20/20）、跨周期右端差超容差。

**本轮的实现前提（真渲染实测，`p3d2_harness.json` → `S0_landing_probe`）**：

| 观测（真身，pane 520×240，600×1m，bs=8，右偏移 0） | 值 |
|---|---|
| `scrollToDataIndex(300)` → 可见范围 | `[241,302]`（落点 = **请求 + 2 根**） |
| `scrollToDataIndex(302)` / `scrollToDataIndex(250)` | `[243,304]` / `[191,252]`（**偏移恒 +2 根**，与请求索引无关） |
| `scrollToTimestamp(list[300].ts)` | `[241,302]`（与 `scrollToDataIndex(300)` **同落点**，Δts=120000ms） |
| 两实例同 `scrollToDataIndex(k)` | 可见范围**精确一致**（P3-C PROBE 已证） |

⇒ 关键性质：**落点偏移是「确定性 + 同构实例一致」的**，因此「请求 `目标索引 − 偏移`」或用闭环读回残差
反推请求索引，都能把右缘钉到目标索引上。

## 3. 实现说明：索引定位 + 有界闭环校正（`alignFollowerWindow`）

### 3.1 索引定位（替代 `scrollToTimestamp`）
1. 在 **follower 自身** `getDataList()` 上按 `nearestIndexByTs`（二分，`lowerBoundByTs`）求出
   「与 leader 可见窗右端 `toTs` 最接近」的 bar 索引；
2. 用 `scrollToDataIndex(目标索引)` 定位（`scrollToDataIndex` 缺失才回退 `scrollToTimestamp`）；
3. leader 窗口与 follower 索引窗都**先 `zeroRightOffsets`**（右偏移归零），保证「右缘 bar」语义一致。

### 3.2 有界闭环校正（读回 → 残差 → 受限校正）
读回 follower `getVisibleRange()`，残差**以 follower 自身 bar 为单位**（`spacing` = **实测相邻 ts 中位间隔**
优先，周期桶宽兜底）：
- **右端残差** `|follower.toTs − leader.toTs|`、**跨度残差** `|follower.spanMs − leader.spanMs|`；容差 = **1 根自身 bar**；
- 受限校正（每次迭代最多各一次）：
  ① **按残差平移请求索引**（`requestedIdx − round(edgeDiff / spacing)`）——补偿引擎「请求 + 2 根」落点偏移；
  ② **按实测可见根数微调 `barSpace`**（`nextBS = round(bs × nowBars / targetBars)`，`targetBars = round(leaderSpan / spacing)`），
  硬受限：`1 ≤ nextBS ≤ min(cap, floor(paneWidth/2))`（cap：基准 50 / 卫星 350；同时保证「能容纳 ≥2 根」）；
- 校正后**重新定位**并再读回。
- **迭代上限**：`MAX_ALIGN_CORRECTION_ITERATIONS = 3`（首次定位 1 次 + 最多 2 次校正）。
- **收敛/震荡保护**（**禁止无界重试**）：按**分量**（右端/跨度）各自记录最优残差，任一分量残差
  **不再下降**、或候选索引/`barSpace` 与已尝试集合重复、或目标根数不可达 ⇒ **立即返回未收敛**，
  由调用方置 `degraded` + `degradedPeriod` + 统计（**不得**把未达容差当作对齐成功）。

### 3.3 未对齐必须可观测（严禁静默虚假对齐）
`SyncStats` 新增（`EMPTY_SYNC_STATS` 同步补齐）：
- `unalignedFollowers`：最近一次对齐里**未对齐**（含**被跳过**）的 follower 数；
- `lastUnalignedReason`：`<period>:<reason>`，reason ∈
  `no-barspace-api | no-layout | no-density-anchor | no-data | no-scroll-api | no-window | iteration-cap | no-improvement | unreachable | leader-window`；
- `lastCorrectionIterations`：最近一次对齐的闭环迭代次数（1 = 一次定位即收敛）。

原先**静默 `continue`** 的三条路径（无 barSpace 面 / **未布局 pane 宽 0** / **无可用密度锚点**）现在都会
**计数 + 记因**；「无公共锚点」在 `isSyncCombinationAllowed` 构造护栏下对允许组合不可达，故为**防御性分支**，
其可观测性由同一计数器覆盖（`no-density-anchor`）。

### 3.4 base 作为 follower 的降级可观测
任 follower（含**基准**）降级 ⇒ `stats.degraded=true` 且 `stats.degradedPeriod = 该 follower 周期`；
store 侧新增 `syncDegradedPeriod` 并镜像 `degradedPeriod`（角标仍只渲染在卫星 pane，属已知限制，但**统计/ store 必须可读**）。

## 4. 真渲染实测残差（真身 klinecharts 10.0.3 + 生产 `ChartSyncGroup`）

> 夹具间距按实测密度表校准（`base 间距 = satBucket / D`，同 design/P3-C 口径）；`errors=[]`、非本地请求 `=[]`。

### 4.1 G1：1m↔1m ≥20 轮镜像（P3-C 时 `maxDrift=2`）
| 指标 | 实测 |
|---|---|
| 20 轮 drift 序列 | `[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]` ⇒ **maxDrift = 0**（判据 ≤1）✔ |
| `suppressed` / `echoEvents` / `applied` | 164 / **0** / 41 ✔ |
| `lastCorrectionIterations` / `unalignedFollowers` | 2 / 0 |
| 两侧右偏移 px | 0 / 0（`setOffsetRightDistance(0)` 生效） |

### 4.2 T3-2：三组跨周期（跨度差 + 右端差，单位 = 高周期 bar；容差 1 根）
| 组合 | satBS（闭环后） | 卫星可见根数 | **跨度差** | **右端差** | degraded / iterations | 判据 |
|---|---|---|---|---|---|---|
| 1m↔5m | 38 → **44** | 13 | **0.179 根**（53,617ms ≤ 300,000） | **0.106 根**（31,915ms） | false / 2 | ✔ PASS |
| 1m↔15m | 98 → **137** | 5 | **0.067 根**（60,000ms ≤ 900,000） | **0.344 根**（309,836ms） | false / 2 | ✔ PASS |
| 1d↔1w | 37 → **43** | 13 | **0.062 根**（37.6e6ms ≤ 604.8e6） | **0.403 根**（243.5e6ms） | false / 2 | ✔ PASS |

（P3-C 时：跨度差 1.82 / 1.93 / 1.94 根、右端差同时超容差 ⇒ 现**全部 ≤1 根**。）

### 4.3 T8bis 退化路径（1m↔1h，基准 bs=8 ⇒ 理想 302 > 容量 260）
| 指标 | 实测 | 判据 |
|---|---|---|
| `satBS` / 容量 / 卫星可见根数 | **260** / 260 / **4**（≥2） | ✔（不得照用 302） |
| `degraded` / `degradedPeriod` / 快照 | true / `'1h'` / 4 个、末快照 degraded | ✔ |
| **右端差** | **0.259 根**（933,333ms ≤ 3,600,000） | ✔（P3-C 时 1.74h ⇒ 已修复） |
| **跨度差** | **2.37 根**（8,530,476ms > 3,600,000） | ✘ **真渲染不可达**（见 §6） |
| 缩小基准（bs=4） | satBS 151 → **252**、可见 4 根、degraded=false、跨度差 **0.782 根**、右端差 **0.259 根** | ✔ |

### 4.4 S6：卫星触发 ⇒ base 作为 follower（1d base + 1w sat @bs=300）
| 指标 | 实测 |
|---|---|
| base barSpace / 可见根数 | 50 → **29**（闭环按 base 自身 bar 校正，仍在 ADR-020 的 [1,50] 内） |
| 跨度差 / 右端差 | **0.003 根** / **0.041 根** ✔ |
| `degraded` / `degradedPeriod` / `unaligned` | true / **`'1d'`（基准周期）** / 0 ✔ |

### 4.5 索引定位 + 闭环的迭代与可观测（真渲染）
- 所有收敛用例 `lastCorrectionIterations ∈ {2,3}`（**≤ 上限 3**），`unalignedFollowers=0`；
- 未收敛用例（退化容量受限）`unalignedFollowers=1` + `lastUnalignedReason=<period>:iteration-cap|unreachable`，
  且 `degraded=true`（**没有静默虚假对齐**）。

## 5. 转绿证据与门禁输出

| 命令 | 结果 |
|---|---|
| `cd web && ./node_modules/.bin/vitest run` | **77 files / 706 tests 全绿**（P3-D-1 的 5 个红用例全绿；P3-D-2 增补 7 例） |
| `cd web && ./node_modules/.bin/tsc -b` | exit 0（无输出） |
| `./scripts/check-tangle.sh` | exit 0（`✅ design 与生成物一致`；沙箱重生成比对，工作区未被修改） |
| 真渲染 harness | `errors=[]`、非本地请求 `=[]`、S1/S2/S6/S8 全 PASS（§4、§6） |

新增/加强测试（`chartSyncAlignClosedLoop.test.ts`，7 例）：闭环迭代上限/收敛统计、未布局跳过可观测、
无数据跳过可观测、容差不可达时有界停手 + `degraded`、**降级路径可达下界记录 + fail-closed 可读**、
**可对齐的容量降级仍必须完成对齐（降级 ≠ 跳过）**、**基准永不作为 follower（反向变异必红）**。
**P3-D-1 既有红测试的断言一字未改**（未放宽任何阈值）。

## 6. 架构裁决的落实（分路径判据 / fail-closed / 微调约束 / 基准硬约束）

### 6.1 判据分路径（(A)，**澄清而非放宽**）
| 路径 | 判据 | 本轮结果 |
|---|---|---|
| **对齐成功路径**（可对齐） | 跨度差 **≤1 根** 且 右端差 **≤1 根** 且 可见 ≥2 根（**原口径不变**） | 1m↔1m / 1m↔5m / 1m↔15m / 1d↔1w / 15m↔1h 全部达标（§4） |
| **降级路径**（reachability 探针证明不可达） | 可见 ≥2 根 + 右端差 **≤1 根** + `degraded`/`degradedPeriod` + **角标** + **统计可读** + **可达下界记录** | 1m↔1h 容量受限：可见 4 根、右端差 0.259 根、`degraded=true`/`'1h'`、`spanResidualBars=2.37`（下界）、`unalignedFollowers=1` + 原因 ✔ |

### 6.2 fail-closed（先尝试完整对齐，仅探针证明不可达才降级）
- `alignFollowerWindow` 总是先做索引定位 + 受限校正（≤2 次），**只有**在候选用尽/残差不下降/迭代上限时才返回未收敛；
- 降级与「未对齐」是两个独立的可观测位：`degraded`（角标）与 `unalignedFollowers`/`lastUnalignedReason`
  （**降级 ≠ 跳过对齐**）。真渲染证据：容量降级但跨度可达的组合 `unaligned=0`、`spanResidualBars ≤1`；
  容量受限且不可达的组合 `unaligned=1` + 原因 + 下界（**降级态绝不宣称已对齐**）。

### 6.3 barSpace 微调（接受 + 三条约束）
1. **有界**：迭代上限 `MAX_ALIGN_CORRECTION_ITERATIONS=3`（定位 1 + 校正 ≤2）、**单步幅度 ≤ `MAX_BAR_SPACE_STEP_RATIO`（50%）**、
   确定性（无随机；候选索引/barSpace 记入 `tried*` 集合，重复即停）；震荡/无改善 ⇒ 停手 + 降级；
2. **可观测**：新增 `stats.barSpaceAdjust` = **最终 barSpace − 密度推导值 `idealBarSpace`**
   （真渲染实测：1m↔5m 38→44 `+6`；1m↔15m 98→137 `+39`；1d↔1w 37→43 `+6`；15m↔1h 25→35 `+10`；
   1m↔1h 容量降级 302→260 `−42`（容量夹取，非微调））；
3. **文档化**：密度值是**初始估计而非契约**（`chartSyncGroup.ts` 模块头 §4 明写；`design/` 侧文案更新归架构/测试车道
   —— 本轮不动 `design/`，避免与 tangle 门禁冲突）。

### 6.4 【硬约束】基准实例永不作为 follower（ADR-020）
- 实现：`alignFrom` 只对 `!isBase` 的成员做 follower 对齐；卫星做 leader 时**只对齐其它卫星**，基准的
  `barSpace`/可见窗/右偏移**一概不写**（`zeroRightOffsets` 也只作用于 leader + 目标卫星）。
  基准唯一的重定位路径是显式的「回到最新」（`scrollAllToLatest`，不写 barSpace）。
- 断言：`chartSyncAlignClosedLoop.test.ts` →「基准永不作为 follower」：卫星 leader 会把**朴素实现**的基准
  改写成 `round(300/4.67)=64 → 夹到 50`，本用例断言基准 `barSpace`/可见范围/右偏移**逐字段不变**（反向变异必红）。
- 真渲染证据（`p3d2_harness.json` → `S6_base_never_follower`）：卫星 1w@300 为 leader 时
  `baseBsBefore=10 → baseBsAfter=10`、`baseRangeUnchanged=true`、`baseOffsetUnchanged=true`
  （朴素行为会写 64→50）；`S6_sat_to_sat`：15m 卫星 leader ⇒ 1h 卫星对齐（span 0.5 根、edge 0.25 根、`degraded=false`），
  而基准 **完全未动**（`baseBsUnchanged=true`、可见范围/右偏移不变）。

### 6.5 「判据范围澄清」vs「实现改进」对照
| 项 | 归类 |
|---|---|
| 降级路径不再要求「跨度差 ≤1 根」，改为「≥2 根 + 右端 ≤1 根 + 角标 + 统计 + 可达下界记录」 | **判据范围澄清**（架构裁决 A；成功路径判据原样保留） |
| 1m↔1h 容量受限下可达跨度下界 2.37 根（真 1m ≈2.95 根）作为**记录项** | **判据范围澄清**（物理下界，非实现缺陷） |
| 索引定位替代 `scrollToTimestamp`（1m↔1m drift 2 → **0**） | **实现改进** |
| 有界闭环校正 + 分量级震荡保护 + 迭代上限/单步幅度上限 | **实现改进** |
| barSpace 从密度推导值微调（记录 `barSpaceAdjust`） | **实现改进**（受架构裁决约束） |
| 基准永不作为 follower | **实现改进 + 新增硬约束**（架构裁决四） |
| 未对齐/跳过可观测（`unalignedFollowers`/`lastUnalignedReason`/残差记录） | **实现改进**（禁止静默虚假对齐） |

## 7. 观察项 / 残余风险（诚实标注）

1. **barSpace 微调使最终 barSpace ≠ 密度推导值**（真渲染 +6/+39/+6/+10）：这是「真身含部分 bar 的可见根数模型」
   下同时满足「跨度 ≤1 根」与「可见 ≥2 根」的必要手段；密度值按裁决为**初始估计**。jsdom 桩内多数组合一次定位即收敛，
   故 P3-D-1 既有断言不受影响（`barSpaceAdjust` 使其可观测）。
2. **卫星↔卫星在极端倍率下不可达**（例：1h 卫星 @bs=8 作 leader、5m 作 follower：5m 在 520px 下最多显示 ~43h
   < leader 窗 62h）⇒ 诚实降级（`degradedPeriod='5m'`、下界 740 根记录在 `spanResidualBars`）；
   这是单 pane + 独立 barSpace 的物理下界，属「降级路径判据」适用范围。
3. 新增统计字段中，store 只镜像 `syncDegraded`/`syncDegradedPeriod`/`lastSpanDiffMinutes`/`applied`/`suppressed`；
   `unalignedFollowers`/`lastUnalignedReason`/`lastCorrectionIterations`/残差/`barSpaceAdjust` 经 `stats`（`onChange`）可读。
4. 文档侧：**架构车道已在工作树中落地** `design/15-multi-period/02-spec.md` §3.2 第 6–12 条（分路径判据/基准永不作为 follower/barSpace 微调有界可观测/`scrollToDataIndex` 优先/`unalignedFollowers`）与
   `03-test-plan.md` T8bis（含 2.37 根下界、fail-closed 反向、基准不得被改写反向），与本实现逐条一致；
   本轮**未改 `design/`**（Coder 不擅自动事实源），`./scripts/check-tangle.sh` 仍为 exit 0（沙箱重生成 + 逐字节比对通过）。
5. 未做：P4/P5、dcap 口径、ABI/引擎、线上重启/PUT（0 写请求；真渲染 harness 仅 127.0.0.1 临时端口，跑完已拆：端口空闲、无残留进程）。
