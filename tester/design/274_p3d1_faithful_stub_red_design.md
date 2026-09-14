# 274 — P3-D-1 红测试设计报告：让「真渲染对齐精度」成为可自动复现的红（忠实桩 + 容差断言）

- **本文件路径**：`tester/design/274_p3d1_faithful_stub_red_design.md`
- 角色：Tester（设计 + 落地红测试与测试基建；**未改任何产品代码**）
- 时间：2026-09-14（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `ec32767`；P3 实现在工作树未提交）
- 配套执行报告：`tester/test/274_p3d1_faithful_stub_red_execution.md`
- 证据目录：`tester/evidence/274_p3d1_faithful_stub/`
- 权威依据：`design/15-multi-period/{01-adr.md §2.3, 02-spec.md §3, 03-test-plan.md}`（T3 / T4 / T8bis）
- 输入事实（**不重新发现**）：`tester/evidence/273_p3c_acceptance/{real_render_harness.html, real_render_driver.mjs, p3c_harness.json}`
- 用户口径：方案 1 —— 诚实降级 + 「对齐受限」角标；**严禁静默虚假对齐**。

---

## 1. 问题（P3-C 独立验收：FAIL(B1,B2,B4)，根因单一）

- 真身 klinecharts 10.0.3 的 `scrollToTimestamp(ts)` 落点**距右缘固定 2 根**；
- `setOffsetRightDistance(0)` 读回 0，但**无法消除**该缺口（缺口不是右偏移）；
- 旧 jsdom 桩 `web/src/test/syncChartStub.ts` 把它简化为「精确贴右缘」⇒ **掩盖缺陷**：
  `chartSyncGroup.test.ts` 20/20 在 jsdom 绿、在真渲染 20/20 不成立（假绿）。

P3-C PROBE（真渲染，1m×600 根、pane 520×240、`setBarSpace(8)`）：

| 观测 | 值 |
|---|---|
| `offsetBefore` / `offsetAfterZero` | 64 / **0** |
| 同 `scrollToDataIndex` 两实例 | `[241,302] == [241,302]`（**精确**） |
| `scrollToTimestamp(list[302].ts)` | `[243,304]` ⇒ **+2 根** |
| `deltaTs_toTs` | 120000ms = 2 × 1m |

## 2. 测试策略（本轮）

| 层 | 手段 | 承担 |
|---|---|---|
| L2 行为/契约（**红**） | jsdom + **忠实桩**（`syncChartStub.ts`） | G1 / 跨周期 / T8bis 的**真渲染容差**判据 |
| L2 保真度（**绿=仪器**） | jsdom + 忠实桩（新增 `chartSyncStubFidelity.test.ts`） | 把桩的落点钉在真身 PROBE 实测值上；可满足性反向对照 |
| L1 库事实（**绿=仪器**，真身） | Playwright + 真身 UMD（`web/tester/p3-sync-harness/`，`file://`、0 网络） | F7：真渲染**同一环境**复现「2 根缺口不可被右偏移归零消除」 |

**不新增产品级 harness**（真渲染产品驱动仍由 P3-C 承担）；本轮把**真身手感的同一量**搬进 jsdom 可自动断言面。

## 3. 桩忠实化（`web/src/test/syncChartStub.ts`）

1. 新增导出常量 `REAL_SCROLL_TO_TIMESTAMP_RIGHT_GAP_BARS = 2`（注释引用
   `tester/evidence/273_p3c_acceptance/p3c_harness.json` → `scenarios.PROBE`）。
2. `scrollToTimestamp(ts)`：`scrollToDataIndex(nearestIndex(ts))` → `scrollToDataIndex(nearestIndex(ts) + 2)`。
   - 数据末端由 `scrollToDataIndex` 的索引夹取兜底 ⇒ `scrollToDataIndex(lastIndex)` 仍精确（与真身 `S3_t4` 一致，
     T4「回到最新」不受影响）。
3. 顶部补充**已知的剩余不忠实面**（诚实标注，防止把桩内推论当真身证据）：
   - a. 可见根数 `floor(paneWidth/barSpace)` 与真身不一致（真身含部分 bar：bs=8 实测 62 根、bs=260 实测 4 根、
     bs=302 实测 4 根；桩为 65 / 2 / 1）⇒ 「`floor(520/302)=1` ⇒ 可见 <2 根」这类推论**只在桩内成立**；
   - b. `satBS ≫ pane 宽 ⇒ NaN` 的**前置条件**在真身不可达（引擎夹到 `width/2`）⇒ 该 NaN 用例是**防御性路径**，
     其仪器证明只在桩内有效（P3-C B5）。

## 4. 用例清单（Given–When–Then）

### 4.1 `web/src/features/dashboard/chartSyncStubFidelity.test.ts`（**新增**，5 例，绿=仪器）

| # | 用例 | 判据（真身 PROBE 锚定） |
|---|---|---|
| F1 | 右偏移可归零但缺口不消失 | `getOffsetRightDistance()` 64 → `setOffsetRightDistance(0)` → 0；随后 `scrollToTimestamp(bar300)` ⇒ 落点仍 `+2` |
| F2 | 同构双实例 `scrollToDataIndex` 精确 | 两侧右缘索引**精确相等**（缺口不在该原语上） |
| F3 | 跟随者 `scrollToTimestamp(leader.toTs)` | 右缘索引差 `=== 2`，右端 ts 差 `=== 120000ms`（复刻 `[243,304]`） |
| F4 | 可满足性反向对照 | 把目标 ts 前移 2 根（标定补偿）后相对偏移 `0 ≤ 1` ⇒ G1 判据**可满足**（非空、非不可能测试） |
| F5 | 保真度诚实标注 | 桩可见根数 `floor(520/8)=65`（真身 62）；缺口常量 `=== 2` |

### 4.2 `web/src/features/dashboard/chartSyncGroup.test.ts`（**加强/拆分**，几何判据改为真渲染容差，**红**）

| # | 用例 | 判据 |
|---|---|---|
| G1/T3-1 | 1m↔1m ≥20 轮镜像 | **相对偏移 ≤1 根**（逐轮采集 drift 序列 + `maxDrift ≤1`）；`applied ≥20`、`suppressed >0`、`echoEvents === 0` |
| T3-2 ×3 | 1m↔5m / 1m↔15m / 1d↔1w（**拆为 3 个独立用例**，全部可上报） | 卫星可见 `≥2` 根；**跨度差 ≤1 根高周期 bar**；**右端差 ≤1 根高周期 bar**；跟随者右偏移 `≤1` 根；`suppressed >0`、`echoEvents === 0`、`degraded === false` |
| T3-2 反向 | 名义比 7 对照 | 同一忠实桩下名义比跨度差 `>1` 根周 bar（保持判别力） |
| T3-3 / T3-4 | 重入抑制双向 / 1m↔1w 护栏 | 不变（原有反向证据） |
| T4-1 / T4-2 | 回到最新 / 尊重手动视口 / `stop()` | 不变（真身 `S3_t4` 亦为 PASS） |
| T8bis | 退化路径 | 新增**右端差 ≤1 根高周期 bar** 与**跨度差 ≤1 根高周期 bar**；`barSpace === 260 ≠ 302`、可见 `≥2`、`degraded/degradedPeriod`、跨度差可读、`onChange` 广播、缩小基准 ⇒ 恢复 |
| 边界 ×4 | NaN / 上限不足 / 不泄漏基准 | 不变（其「仪器证明」按 §3-a/b 标注为**桩内有效**） |

> **G1 判据的变化（关键）**：由「逐字段相等」改为「**相对偏移 ≤1 根**」。
> 原因：真实渲染下两侧绝对窗口本就相差 2 根，用「逐字段相等」会在**与产品无关**的成绩上红，
> 而用「≤1 根」正好把「真身固定 2 根不可补偿」这件事变成**可自动复现的红**。

### 4.3 `web/tester/p3-sync-harness/`（真身 klinecharts，**+2 检查**，绿=库事实）

F7 复刻 P3-C PROBE（两同构 1m 图、pane 520×240、bs=8），检查：
1. `setOffsetRightDistance(0)` 读回 0 **且** `scrollToTimestamp` 落点缺口 `≥2` 根（`gapUnremovableByZeroRightOffset`）；
2. 同 `scrollToDataIndex` 两实例范围**精确相等**（`sameIndexScrollRangeEqual`）。

## 5. 反向证据（**同一环境**）

| 反向证据 | 环境 | 结果 |
|---|---|---|
| 2 根缺口存在且右偏移归零无法消除 | **真身渲染 harness F7** + **忠实桩 F1/F3** | ✔ 两侧同源（真身 `gap=2`、`Δts=120000`） |
| 判据「≤1 根」非空可满足 | 忠实桩 F4（标定补偿 2 根 ⇒ 漂移 0） | ✔ |
| 名义比 7 必超容差（不得按名义周期比兜底） | 忠实桩（T3-2 反向） | ✔ |
| 重入抑制开关双向 | 忠实桩（T3-3） | ✔ |
| ⚠️ 已作废的桩内推断 | — | 「`floor(520/302)=1` ⇒ 照用推导值必可见 1 根」在**真渲染未复现**（P3-C：bs=302 仍 4 根）⇒ 已在桩头标注、不再当作仪器证明 |

## 6. 覆盖目标与不做项

- **覆盖**：G1（≥20 轮 ≤1 根）、跨周期 3 组合的跨度差 + 右端差、T8bis 退化路径的跨度差 + 右端差、桩保真度、真身 F7。
- **不做**：不改产品代码/接口/架构；不做调参凑绿；不为绿回退桩；不重复 P0.3/P1 的既有取证。

## 7. 残余风险（诚实标注）

1. 桩的可见根数模型与真身有已知偏差（§3-a）⇒ **跨度差**判据在桩内偏乐观（1m↔5m 桩内 245k ≤ 300k 通过，
   真身 546k 超容差失败）；该判据的**真渲染**证据由 P3-C `S2_cross_period` 承担，桩内由**右端差**判据保证红。
2. `satBS ≫ pane 宽 ⇒ NaN` 前置条件真身不可达（§3-b）⇒ 该路径为防御性，仪器证明仅桩内有效。
3. 桩内 `scrollToDataIndex` 保持精确（缺口只挂在 `scrollToTimestamp`），与真身「两原语同缺口」在**绝对窗口**上
   差 2 根；对**相对漂移**（判据所依赖的量）等价 —— 由 F2/F3 显式钉住。
