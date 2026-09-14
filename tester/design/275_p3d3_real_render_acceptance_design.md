# 275 — P3-D-3 独立验收：真渲染 harness 设计（新测试/新仪器设计报告）

- **本文件路径**：`tester/design/275_p3d3_real_render_acceptance_design.md`
- 角色：Tester（独立验收；**只读仓库**，新增仪器只落在 `/tmp` 副本 + `tester/` 报告与证据）
- 权威依据：`design/15-multi-period/02-spec.md` §3.2（items 5–12）、`03-test-plan.md` T8bis（分路径判据）
- 落地证据：`tester/evidence/275_p3d3_acceptance/`（harness 源码、JSON、截图、变异输出）
- 交付物类型：**新增测试/仪器设计**（实现侧不新增断言，不改 P3-D-1/D-2 任何阈值）

## 1. 测试策略

| 层 | 手段 | 目的 |
|---|---|---|
| L0 库事实 | 真身 `klinecharts 10.0.3` UMD（`file://`，0 网络）PROBE | 锚定「同索引定位精确相等 / `scrollToTimestamp` 落点 +2 根」不随时间漂移 |
| L1 真渲染产品级 | 真身库 + **生产 `ChartSyncGroup`**（`esbuild` 由仓库 `.ts` 直接转译为 ESM，非手抄副本） | 逐项复现验收口径 A1–A6（含基准冻结、降级下界、有界性） |
| L2 真渲染变异 | 在 `/tmp` 副本上改 4 处语义 ⇒ 真渲染 harness + 聚焦 vitest 双口径取红 | 证明判据有判别力、桩不掩盖缺陷 |
| L3 回归 | 全量 vitest / `tsc -b` / `check-tangle`（沙箱） | 无回归、无漂移 |

## 2. 用例清单（真渲染 harness，`harness.html`；驱动 `run.mjs`）

| ID | 场景 | 判据 |
|---|---|---|
| PROBE | 600 根 1m，两同构实例 | `scrollToDataIndex(300)` 两图范围**精确相等**；`scrollToTimestamp(a.toTs)` 落点差 = 2 根 |
| A1 | 1m↔1m，base 逐轮 `scrollToDataIndex(300+5r)`，r=0..19 | `maxDrift ≤1`（期望 0）、右端差 ≤1 根、`suppressed>0`、`echoEvents=0` |
| A2 | 1m↔5m / 1m↔15m / 1d↔1w（base 间距 = 高周期桶/实测密度） | 跨度差 ≤1 根**且**右端差 ≤1 根高周期 bar、卫星可见 ≥2 根、`unalignedFollowers=0` |
| A3 | 1m↔1h（base bs=8 ⇒ 推导 302 > 容量 260） | 降级：`degraded`+`degradedPeriod='1h'`、卫星 ≥2 根、右端差 ≤1 根、`spanResidualBars` 记录（>1 根 = 实测下界）、store 角标字段可读、迭代 ≤3、`lastUnalignedReason` 可读 |
| A3' | 同上，base bs 8→4 | **回到成功路径判据**：`degraded=false`、跨度/右端差 ≤1 根、`unalignedFollowers=0` |
| A4 | 1d↔1w，**卫星作 leader**（`setBarSpace(300)`+`scrollToDataIndex(40)`） | 基准 `barSpace`/可见范围/右偏移**逐项不变**、基准 `setBarSpace` 写入计数 0；对照 `naiveWouldWriteBaseBS=50` |
| A5 | base 1m + 卫星 5m + 缺 `setBarSpace` 面的第三个 follower | `unalignedFollowers ≥1`、`lastUnalignedReason='5m:no-barspace-api'`、其它 follower 仍对齐、残差/微调字段可读 |
| A6 | 1m↔1h（base bs=40），探针记录 `setBarSpace` 写入序列 | 迭代 ≤3（**字面量**，不 import 常量）、单步幅度 ≤50% |

## 3. Mock/桩策略

- **不用桩**：真身库 + 生产模块 ⇒ 判据直接落在真实几何上（与 P3-C 同一手法，独立重写）。
- 唯一注入面：`setBarSpace` 写探针（包一层记录），不改变行为。
- 忠实桩（`web/src/test/syncChartStub.ts`）仅在 L2 变异口径中被检验（变异 ③）。

## 4. 边界/异常用例
- 同周期精确对齐（0 漂移）与「库落点 +2 根」并存（PROBE）。
- 降级态：`barSpace` 被容量夹取、视口仍可读、跨度判据**不适用**（记录下界）。
- 基准冻结的反向对照（naive 值 50）。
- 缺 API 的 follower（跳过必须可观测）。
- 有界性：迭代/步长上限；写入序列可取证。

## 5. 变异计划（每处必须红，均在同一 `/tmp/p3d3/mut` 环境可复现）
①a 移除 `probeMaxBarSpace`（写入被吞即降级）；①b 不经完整对齐即降级（fail-closed 破坏）；
② `targets` 过滤去掉 `!m.isBase`（基准被当 follower）；③ 桩 `scrollToTimestamp` 改回理想贴右缘（+ 变体：再叠「索引定位退回 `scrollToTimestamp`」）；
④ 放大 `MAX_ALIGN_CORRECTION_ITERATIONS`/`MAX_BAR_SPACE_STEP_RATIO` 并删除「无改善即停手」。

## 6. 覆盖目标
- 验收口径 A1–A5 全覆盖；spec §3.2 items 5–12：降级策略(5–6)/分路径判据(7)/基准永不 follower(8)/有界可观测(9–10)/索引定位优先(11)/分路径验收(12) 均有真渲染或变异证据。
