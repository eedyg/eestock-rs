# 170 — P3-B 实现：`ChartSyncGroup`（时间跨度对齐 + 重入抑制 + 卫星上限 + 诚实降级）

- **本文件路径（自指）**：`coder/report/170_p3b_sync_group.md`
- 角色：Coder（实现 + 自测；**未改架构/接口边界**，未 commit、未 `git add`）
- 时间：2026-09-15（本地，UTC+8）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs`（HEAD `ec32767`；P0/P1/P2 已入库）
- 权威依据：`design/15-multi-period/{01-adr.md §2.3, 02-spec.md §3, 03-test-plan.md T3/T4/T8bis}` + P3-A 交付（`tester/design/272_p3_sync_red_design.md`）
- 证据目录：`coder/evidence/170_p3b_sync_group/{red_baseline.txt, p3_tests_green.txt, full_suite_green.txt, measurements.txt}`
- 本轮**不含**：LIVE 虚线段（P4）、高度拖拽持久化（P5）、dcap 口径改动、Rust/生成物改动、线上重启/PUT

---

## 1. 改动文件清单

| 文件 | 类型 | 行数变化 | 说明 |
|---|---|---|---|
| `web/src/features/dashboard/chartSyncGroup.ts` | **新增（产品）** | +755 | 同步原语：密度表/估计器/降级取整/右偏移换算/组合护栏纯函数 + `ChartSyncGroup`（对齐 + 重入抑制 + 上限探测 + 诚实降级 + 统计） |
| `web/src/features/dashboard/chartSyncContext.ts` | **新增（产品/React 接线）** | +148 | `ChartSyncContext` + `useChartSyncRegistry()`（消费侧）+ `useChartSyncGroup()`（provider 侧建立/销毁组） |
| `web/src/features/dashboard/MultiPeriodChartStack.tsx` | 改（产品） | +40/-2 | 挂 `Provider`（值＝注册表；**不渲染 DOM**）；降级角标状态；`onSyncStats` 上报 |
| `web/src/features/dashboard/MultiPeriodSatellite.tsx` | 改（产品） | +21 | `data-mp-sync-degraded` 角标（文案/title/跨度差）+ 向 `KlineChart` 传 `barSpaceLimit` |
| `web/src/features/dashboard/KlineChart.tsx` | 改（产品） | +37/-1 | `barSpaceLimit` prop（**仅卫星**传入 `init({layout:{barSpaceLimit}})`）；同步成员注册（Effect S）；程序化写入标记（实时跟随不算交互源） |
| `web/src/features/dashboard/multiPeriodStore.ts` | 改（产品） | +44/-1 | `syncApplied`/`syncSuppressed` 可观测字段 + `applySyncStats()`（去重 patch） |
| `web/src/features/dashboard/DashboardPage.tsx` | 改（产品） | +3 | 把同步统计镜像入 `mpStore`（与页面角标同源） |
| `web/src/test/syncChartStub.ts` | 改（**测试基建**） | 见 §6.1 | `setOffsetRightDistance` 由 no-op 改为**忠实实现**（否则 T3-2/T4-1 的右偏移判据对任何实现都不可能通过） |
| `web/src/features/dashboard/chartSyncGroup.test.ts` | 改（**红测试夹具**，经架构师授权） | 见 §6.2 | 唯一一处：NaN 用例的 `makePair` 增参 `satMax: 5000` + 说明注释（**未删/未弱化任何断言**） |

> 未 `git add` / 未 commit / 未 stash（`git diff --cached` = 0 行）；未新增依赖；未改任何既有测试的判据。

---

## 2. 架构对齐（每处改动所属层）

| 层 | 改动 | 边界纪律 |
|---|---|---|
| L2 同步原语（无 UI） | `chartSyncGroup.ts` | 只读写 klinecharts 公开面（`getBarSpace/setBarSpace/getSize/getVisibleRange/getDataList/scrollToTimestamp/get|setOffsetRightDistance/subscribeAction`）；**无 React、无 store、无网络** |
| L2 React 接线 | `chartSyncContext.ts` | 只做「注册/注销、组重建、程序化写入标记、stats 广播」；不实现同步算法 |
| L3 容器 | `MultiPeriodChartStack.tsx` | 只在**真正启用（有卫星）**时提供注册表；关闭态与现状逐字节等价（Provider 不渲染 DOM） |
| L3 实例 | `MultiPeriodSatellite.tsx` / `KlineChart.tsx` | 卫星的 `barSpaceLimit` 放宽**只**在卫星 init 选项；基准不传（ADR-020 不变）；卫星/基准各自注册，切周期注销后重注册 |
| L3 运行态 | `multiPeriodStore.ts` + `DashboardPage.tsx` | store 只**镜像可观测字段**（不持数据流、不驱动同步，沿用 P1/P2 边界） |

**接口纪律**：`design/15-multi-period/02-spec.md §3.1` 的 4 个方法（`start/stop/scrollAllToLatest/applySatelliteLimits`）与 P3-A 钉死的纯函数面（`densityRatio/estimateDensityRatio/resolveDensityRatio/alignSatelliteBarSpace/mirrorRightOffsetPx/isSyncCombinationAllowed`）+ `stats/onChange` **签名与语义完全一致**；新增的 `beginProgrammatic/endProgrammatic` 是**附加**（生产接线用，不改既有语义）。

---

## 3. 解决的问题 / 新增的能力

多周期模式（每周期一个 klinecharts 实例）下，各 pane 的 x 轴（时间范围）必须同步（ADR-022 口径 1/8）。本轮落地：

1. **时间跨度对齐**：leader 可见窗 → follower `barSpace = clamp(round(leaderBS × D), 1, cap)` + 按 ts **边缘对齐**（`scrollToTimestamp` 是右缘语义）+ 右偏移归零；
2. **重入抑制**：`applyDepth` 守卫 + 单向广播 + 应用后 ≥1 帧抑制窗（P7b：单次滚动即 `reentrantCalls=1`）⇒ 无回声、无漂移；
3. **卫星 `barSpaceLimit` 放宽**：只在卫星 `init({layout:{barSpaceLimit:{min:1,max:350}}})`；**基准不动**；上限不足 ⇒ **探测真实上限并显式降级**；
4. **诚实降级（用户裁决方案 1）**：容不下 ≥2 根 ⇒ 取「能容纳 ≥2 根的最大 barSpace」= `floor(pane/2)` + 右端对齐 + `syncDegraded` + 卫星 pane「对齐受限」角标（hover 给可行动原因 + `data-mp-span-diff-min`）；
5. **可观测**：`syncApplied`/`syncSuppressed`/`syncDegraded`/`lastSpanDiffMinutes` → store + 页面角标；
6. **不冲突既有契约**：④ 非跟随态不滚动（程序化写入不算交互源）、②③ 不重建 pane（开关往返基准 DOM 节点不变，见 §5.4）。

---

## 4. 实现要点（关键决策，均落在既有结构内）

1. **密度比用实测锚定表 + 通用化**
   - 静态表：`1m→5m 4.7 / 1m→15m 12.2 / 1m→1h 37.8 / 1d→1w 4.67 / 1h→1w 24`，同周期 = 1；表外 ⇒ `null`（禁止名义比兜底）。
   - leader/follower 非「基准→卫星」方向时：先查反向（取倒数），再按**同一锚点合成**（例：`15m→1h = D(1m→1h)/D(1m→15m)`）⇒ 4 周期配置（`1m,5m,15m,1h`）里的任意成员组合也能对齐；最后才用运行时估计器（交叠 ts 窗内 bar 数比，二分求索引窗）。
2. **索引窗按 ts 二分**：`lowerBoundByTs/countBarsInWindow`（名义比不成立 ⇒ 只认 ts 窗）；可见窗取 `getVisibleRange().realFrom/realTo` 并钳位到数据范围（真身 `realTo` 可越界）。
3. **右偏移**：真身 `getOffsetRightDistance()` 是 **px**（实测 bs=1/2/5/8/20 → 8/16/40/64/160），且 `scrollToDataIndex` 按 `_lastBarRightSideDiffBarCount` 定位 ⇒ 对齐前**先把所有成员右偏移归零**（`setOffsetRightDistance(0)`，读回 >0 才写，避免每次滚动重复 layout），否则跨周期右端必错位。
4. **上限探测**：`setBarSpace` 越界**静默 return**（零告警）⇒ 写入后**读回校验**；不一致 ⇒ 在 `[1, min(请求值,声明上限)]` **二分探测**真实上限（读回校验），再按真实上限重算并标 `reason='limit'`（G10 实测：请求 113、真实 cap 50 ⇒ 落 50 且 `degraded=true`）。探测后还原原 barSpace（不在启动期留下副作用）。
5. **NaN 视口**：follower 侧由「容量上限 `floor(pane/2)`」保证不进入 NaN；leader 侧读数 NaN ⇒ 直接置 `degraded + degradedPeriod=leader.period` 并中止该轮（不崩、不静默）。
6. **抑制语义**：`applyDepth>0`（重入）或 `programmaticDepth>0`（程序化写入）或落在 ≥16ms 抑制窗内的非 leader 回传 ⇒ 计入 `suppressed` 并丢弃；`reentrySuppression:false`（仅反向证据）⇒ 计数 `echoEvents` 并**真实镜像一级**（深度守卫防无界回声）。
7. **React 接线不加 DOM**：`ChartSyncContext.Provider` 不渲染元素 ⇒ 关闭态 DOM 逐字节等价；且**关闭分支也保留 Provider 包裹**（值 `null`）——若直接返回 `<>{children}</>`，根元素类型 Fragment↔Provider 变化会让 React 卸载重建基准子树（`init/dispose` 重跑、用户 pane 高度被重置），破坏 ②③ 契约（实测见 §5.4）。
8. **程序化写入不算交互源**：`KlineChart` 的 `scrollToRealTime()`（实时跟随 / 回到最新）包在 `beginProgrammatic/endProgrammatic` 内 ⇒ 卫星的实时跟随不会反过来驱动基准图（否则跨周期实时跟随互相拉扯 = 违反 ④）。

---

## 5. 验证

### 5.1 红 → 绿（P3-A 20 例）

| 阶段 | 命令 | 结果 |
|---|---|---|
| 红（改动前） | `vitest run chartSyncDensity.test.ts chartSyncGroup.test.ts multiPeriodSyncBadge.test.tsx` | **3 files / 20 failed**（`red_baseline.txt`） |
| 绿（改动后） | 同上 | **3 files / 20 passed**（`p3_tests_green.txt`） |

逐文件：`chartSyncDensity.test.ts` 6/6（纯函数面）、`chartSyncGroup.test.ts` 12/12（T3-1/T3-2/变异必红/T3-3/T3-4/T4-1/T4-2/T8bis/NaN 路径/上限不足/不泄漏基准/stop 零残留）、`multiPeriodSyncBadge.test.tsx` 2/2（页面级角标出现/消失 + 反向锁「不得静默」）。

### 5.2 全量回归 + 门禁

| 命令 | 结果 |
|---|---|
| `cd web && ./node_modules/.bin/vitest run` | **75 files / 692 tests 全绿**（`full_suite_green.txt`） |
| `cd web && ./node_modules/.bin/tsc -b` | **exit 0** |
| `./scripts/check-tangle.sh` | **exit 0**（`design 与生成物一致`，沙箱重生成 + 逐字节比对；工作区未被修改） |

既有测试**零改动**（除 §6.2 经授权的单行夹具）；无放宽。

### 5.3 实测数值（≥20 轮；`measurements.txt`，临时测量脚本跑完即删）

**同周期 1m↔1m，20 轮镜像**（`base.scrollToDataIndex(300 + 5r)`）：
```
逐轮 drift = max(|Δfrom|,|Δto|) 恒 0；maxDrift = 0
applied = 40，suppressed = 42，echoEvents = 0
```
**跨周期 3 组 × 20 轮**（容差 = 1 根高周期 bar）：

| 组合 | 跨度差 min/max（分钟） | 容差 | 卫星可见 bar（最小） | 右端差（最大，ms） | 右端容差 | 卫星 barSpace | 降级 | applied / suppressed / echo |
|---|---|---|---|---|---|---|---|---|
| 1m↔5m | 4.09 / 4.09 | 5 min | 13 | 127,660 | 300,000 | 38（=round(8×4.7)） | false | 40 / 42 / 0 |
| 1m↔15m | 4.69 / 4.69 | 15 min | 5 | 442,623 | 900,000 | 98（=round(8×12.2)） | false | 40 / 26 / 0 |
| 1d↔1w | 1,538.67 / 1,538.67 | 10,080 min（7 天） | 14 | 259,014,989 | 604,800,000 | 37（=round(8×4.67)） | false | 26 / 26 / 0 |

（三组右偏移均为 0 px；`degraded=false`；`echoEvents=0` ⇒ 无回声循环。1d↔1w 若用**名义比 7**：同一基准窗跨度差必 >1 根周 bar —— 由 `chartSyncGroup.test.ts` 的变异必红用例独立锁定。）

**降级场景（1m↔1h，pane 520）**：
```
退化：基 barSpace=8 ⇒ 推导 ideal=302 > floor(520/2)=260 ⇒ satBS=260、可见 2 根（≥2 ✓）
      跨度差 17.4 min（>0，≤1 根 1h bar=60 min ✓）degraded=true / degradedPeriod='1h'
      右端差 1,409,524 ms ≤ 3,600,000 ms ✓（实算 span 差 17.41 min）
正常：基 barSpace=4 ⇒ satBS=151（=round(4×37.8)）、可见 3 根、degraded=false、
      跨度差 25.8 min（实算 25.76 ≤ 60 min ✓）
NaN 路径：基 barSpace=40 ⇒ 推导 1512 ⇒ 组落 260（视口可读，非 NaN；`ideal=1512` 硬塞时才 NaN）
上限不足：声明上限 350 / 真实 50、推导 113 ⇒ **探测**到 50 ⇒ satBS=50 + degraded=true/'1h'（不静默留旧值）
抑制开关：关 ⇒ echo=8 / suppressed=0 / applied=6；开 ⇒ echo=0 / suppressed=4 / applied=2
```
**降级角标（页面级）**：`[data-mp-satellite="1h"] [data-mp-sync-degraded="1h"]` 出现，`textContent` 含「对齐受限」，`title` 同时含「缩小基准」「改选周期」，`data-mp-span-diff-min=17.4`（>0）；基准缩回 4 px/bar ⇒ 卫星 `barSpace=151`、角标**消失**（无残留）；`mpStore` 同步镜像 `syncDegraded/lastSpanDiffMinutes/syncApplied/syncSuppressed`。

### 5.4 开关往返 / 契约不冲突（临时验证脚本，跑完即删）

```
开启态：baseListeners=5（KlineChart 自订 onZoom/onScroll 2 + 同步组 3），satListeners=5
关闭后：baseListeners=2（同步组 3 个订阅**已退订**），卫星订阅=0（实例卸载），
        基准 DOM 节点**仍是同一节点**（未 remount），init 计数仍 = 2
再开启：init = 3（仅卫星新建），基准仍是同一节点
```
⇒ ②③（不重建 pane）+ ④（程序化跟随不作为交互源）+ 关闭零残留均成立。

### 5.5 未做（边界自律）

LIVE 虚线段（P4）、高度拖拽持久化（P5）、dcap 口径、Rust/生成物、线上实例（PID 3112540 未触碰，0 写请求）、未 `git add/commit/stash`、未在仓库内跑 tangle（只跑沙箱化的 `check-tangle.sh`）。

---

## 6. 两处**测试基建**改动（精确 diff + 「非削弱」论证）

### 6.1 `web/src/test/syncChartStub.ts`：`setOffsetRightDistance` 由 no-op → 忠实实现（架构师已批准）

```diff
-  let offsetRightBars = opts.offsetRightBars ?? 8;
+  /** 右偏移 = `_lastBarRightSideDiffBarCount`（bar 数）；px = `diffBarCount × barSpace`。 */
+  let offsetRightBarsCount = opts.offsetRightBars ?? 8;

-    getOffsetRightDistance: () => Math.round(offsetRightBars * barSpace),
+    getOffsetRightDistance: () => Math.round(Math.max(0, offsetRightBarsCount * barSpace)),
     setOffsetRightDistance: (distance: number) => {
       log.push({ method: 'setOffsetRightDistance', args: [distance] });
+      // 忠实 `StoreImp.setOffsetRightDistance`：记 bar 数（px / barSpace），getter 再按当前 barSpace 折算
+      if (Number.isFinite(distance) && barSpace > 0) offsetRightBarsCount = distance / barSpace;
     },
```
**源码依据**：真身 `node_modules/klinecharts/dist/index.esm.js:13692-13710`
（`setOffsetRightDistance` 写 `_lastBarRightSideDiffBarCount = distance / _barSpace`；
`getOffsetRightDistance` 返回 `max(0, _lastBarRightSideDiffBarCount * _barSpace)`），
初始化 `:13162/:13278`（`DEFAULT_OFFSET_RIGHT_DISTANCE=80`，`bs=10` ⇒ 8 根）。

**为什么必须改**：原桩的 setter 是 no-op、getter 恒为 `8 × barSpace` ⇒
`getOffsetRightDistance() ≤ getBarSpace().bar`（T3-2 / T4-1 的判据）**对任何实现都不可能成立**
（需 `barSpace=0`）。改后 `setOffsetRightDistance(0)` 真正生效（px=0）——这正是设计报告
`tester/design/272_p3_sync_red_design.md §2.1.5` 明确允许的路径。
**未削弱任何断言**：默认值语义不变（初始仍是「8 根」，`getOffsetRightDistance` 仍随 barSpace 缩放），
只把 setter 从"假"改"真"；红测试文件与阈值一字未动。

### 6.2 `web/src/features/dashboard/chartSyncGroup.test.ts`：NaN 用例夹具增参 `satMax: 5000`（架构师 A 授权）

```diff
   it('边界-NaN 降级路径：…', async () => {
     const ChartSyncGroup = await loadGroup();
+    // ⚠️ 本用例**必须**显式抬高卫星 `barSpaceLimit.max`（`satMax`），否则下面「仪器证明」一行不成立：
+    //    忠实桩/真身都按 `index.esm.js:13666` 的「越界**静默 return**」处理 `setBarSpace` —— 上限仍是
+    //    默认 350 时 `setBarSpace(1512)` 会被吞掉、视口不可能 NaN（NaN 需 `barSpace > 2×pane 宽`）。
+    //    抬高上限只让「把推导值硬塞进去」这个**前置条件**可满足，判据强度不变（不得删 `satMax`）。
-    const { base, sat } = makePair('1m', '1h', { baseBarSpace: 40, satBarCount: 20 });
+    const { base, sat } = makePair('1m', '1h', { baseBarSpace: 40, satBarCount: 20, satMax: 5000 });
```
**为什么必要**：该用例用 `sat.setBarSpace(1512); expect(NaN).toBe(true)` 做「NaN 视口」的**仪器证明**，
而卫星桩的 `barSpaceLimit.max` 默认 350 ⇒ 1512 被**静默吞掉**（与「越界静默」这一 P0.3 事实一致），
NaN 不可能出现 ⇒ 该断言与同文件的「边界-上限不足」用例（要求越界被吞）**互相矛盾**。
`satMax` 是**该夹具自带旋钮**（同文件另两例已在用）。
**非削弱论证**：只抬高**前置条件**（让引擎接受 1512 ⇒ NaN 才可被独立证明）；
断言、阈值、被测行为零改动；同文件「越界必须静默」用例原样保留并继续通过。
**反向变异（供独立复核）**：删掉 `satMax: 5000` ⇒ 该用例必须回到红（证明它不是装饰）。

---

## 7. 观察项 / 残余风险（供 P3-C 独立验收）

1. **`mirrorRightOffsetPx` 生产路径未直接调用**：本组采用设计明确允许的
   `setOffsetRightDistance(0)` **边缘对齐**（实测更稳、且判据要求跟随者偏移 ≤1 根 bar）；
   该纯函数按 P3-A 钉死的 API 面保留（D5 已锁定其按倍率换算的数值），用于需要**保留**右偏移的等效路径/工具。
2. **卫星↔卫星组合的密度用「同锚点合成」**（表外组合）：`15m↔1h` 等由 `D(1m→q)/D(1m→p)` 推导；
   若两侧锚点不同（如 `1w` vs `15m`）⇒ 合成失败 ⇒ **跳过该 follower 的对齐**（不静默虚假对齐）。
   4 周期配置（`1m,5m,15m,1h`）实测可用；更宽的周期组合需要新锚定实测数据。
3. **base 作为 follower 的降级无角标**：DOM 契约只覆盖卫星 pane；当**卫星**是交互源且基准无法匹配跨度时，
   `degraded/degradedPeriod`（= 基准周期）仍可从 store/日志读出，但页面无角标（基准不得放宽，ADR-020）。
4. **同步统计每次对齐都会广播**：store 侧已做值去重（无变化不 patch）；但 `syncApplied` 增加时会触发一次
   页面重渲染（每次滚动事件 ≤1 次，图表实例不重建）。已在页面侧对「角标相关字段」二次去重，避免非降级态的多余渲染。
5. **`applySatelliteLimits()` 是「登记 + 校验」**：klinecharts 无运行时 `setBarSpaceLimit` ⇒ 真正的放宽在
   卫星 `init` 选项；本方法登记声明上限（基准恒 50），真实上限在**首次写入被吞**时二分探测（不启动期探测、不留副作用）。
6. **未做真实渲染驱动**：本轮全部在 jsdom + 忠实桩下完成；真身几何/事件由 P3-A 的
   `web/tester/p3-sync-harness/`（14 检查、绿）与 **P3-C** 的产品级自动化承担。

---

## 8. 自检清单

- [x] TDD：先有 P3-A 红（20 failed，已存档）→ 实现 → 20/20 绿；未改任何判据
- [x] 全量回归 692/692 绿、`tsc -b` exit 0、`check-tangle.sh` exit 0
- [x] 未新增依赖/框架；未改架构、接口签名、层边界（新方法为附加）
- [x] 未 commit、未 `git add`、未 stash；线上 PID 3112540 未触碰、0 写请求；无临时实例/进程残留
- [x] 报告自指路径已给出（本文件首行）
