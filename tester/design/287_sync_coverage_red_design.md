# 287 — 跨图同步「当前配置下静默失效」修复：红测试设计（先红规格）

> **本报告位置**：`tester/design/287_sync_coverage_red_design.md`
> 角色：Tester（**只设计与执行测试**；本轮未改任何实现文件 / 设计文档 / 既有测试；未 git add/commit）
> 新增红测试文件（本设计唯一落地产物）：`web/src/features/dashboard/syncCoverage.test.ts`
> 执行报告：`tester/test/287_sync_coverage_red.md`；证据：`tester/evidence/287_sync_red/`
> 仓库 / HEAD：`/home/eestock/workspace/git/eestock/eestock-rs` @ `8828d4621d9536687a380462f567590d5fc3ea3b`（`master`）

---

## 0. 缺陷事实（父级已用证据核实；本设计不改口径）

用户报「左右移动 K 线图，多周期指标 pane 不跟着动」。真因链：

1. `ChartSyncGroup` 构造函数对**每个**卫星调用 `isSyncCombinationAllowed(base, sat)`（`chartSyncGroup.ts:425-436`），
   而该函数**只认实测密度表**（`MEASURED_DENSITY_TABLE` = `1m:5m 4.7 / 1m:15m 12.2 / 1m:1h 37.8 / 1d:1w 4.67 / 1h:1w 24`）：
   `chartSyncGroup.ts:294` → `return densityRatio(basePeriod, satellitePeriod) !== null;`
2. 用户配置 `base=5m + 卫星 1h/1d` ⇒ `5m:1h` 不在表内 ⇒ **构造函数抛错**；
3. `chartSyncContext.ts:108-121` 的 `try/catch` **只 `console.warn`** ⇒ **整组不建立 ⇒ 跨图同步完全失效**；
4. 页面**无任何可见提示**（`syncDegraded` 仍 false）⇒ 静默失效。

真实 console 原文（`tester/evidence/286_vol_acceptance/A6_zero_write.txt:31` 及 `286_results.json:1184`）：

```
[warning] [multi-period] ChartSyncGroup 未建立（周期组合不可用，禁止静默虚假对齐）
Error: 多周期同步组合不可用：基准 5m ↔ 卫星 1h 恒退化/无重叠（禁止静默虚假对齐）
    at new ChartSyncGroup (...)
    at Object.register (...)
```

附带不一致：类内**已有** `composeDensity()`（同锚点合成）与 `effectiveDensity()`，但**守门函数没用它**；
`5m↔1h` 的合成值 = `D(1m→1h)/D(1m→5m)` = `37.8/4.7 ≈ 8.0426`。而 `5m↔1d / 15m↔1d / 1m↔1d / 1h↔1d / 5m↔1w`
确实**无公共锚点**（真无重叠）⇒ 必须继续拒绝。

---

## 1. 修复口径（父级裁决，本设计不得变更）

| # | 口径 |
|---|---|
| **A** | 守门口径统一：`isSyncCombinationAllowed(base, sat) === true` 当且仅当「同周期 ∪ 实测表命中 ∪ **同锚点合成可用**（`composeDensity(base, sat) !== null`）」；既有护栏全部不变（卫星 < 基准 ⇒ false；含 `1mo`/未知周期 ⇒ false；`1w` 需基准 ≥ `1d` ⇒ false）。`composeDensity` 必须**可被测试直接调用**（导出或等价可测入口）。 |
| **B** | 组构建不再因单个卫星抛错：构造函数**不抛错**，把不可同步卫星**从同步目标中排除**并记录周期与原因；其余成员照常同步。仅「基准缺失」或「可同步成员 < 2」才不建立组，且该情形**必须显式上报**（不得只 `console.warn`）。硬约束不回退：**基准永不作为 follower**、重入抑制、有界闭环校正、诚实降级。 |
| **C** | 可观测（**禁止静默**）：被排除卫星「周期 + 原因」必须能从 `SyncStats` 读出（字段名见 §2）；页面侧必须对**每个**被排除卫星渲染**可见角标**（含周期与原因），「整组未建立」也必须有**页面可见状态**。 |
| **D** | 被排除的卫星在其它成员对齐时**完全不被写入**（不 `setBarSpace`、不 `scrollToDataIndex`/`scrollToTimestamp`、不 `setOffsetRightDistance`）。 |

---

## 2. 钉死的接口契约（实现方必须满足；本设计与红测试共同锁死）

### 2.1 模块 `web/src/features/dashboard/chartSyncGroup.ts`

```ts
/** （新增导出；A）同锚点密度合成：例 15m→1h = D(1m→1h)/D(1m→15m)；无公共锚点 ⇒ null。 */
export function composeDensity(basePeriod: string, satellitePeriod: string): number | null;
//   · 同周期 ⇒ 1；表内组合可由其锚点还原（如 1d→1w ⇒ 4.67）；
//   · 无公共锚点（5m↔1d / 15m↔1d / 1m↔1d / 1h↔1d / 5m↔1w / 1m↔1w）⇒ **null**（禁止名义比兜底）。
//   既有实现为模块内私有函数（chartSyncGroup.ts:333-346）⇒ 本契约要求**导出**（或提供等价可测入口）。

/** 排除原因码（C；优先级自上而下：先判 order/1w 护栏，再判锚点）。 */
export type SyncExclusionReason =
  | 'unsupported-period'          // 含 1mo / 未知周期
  | 'satellite-lower-than-base'   // 卫星周期 < 基准
  | 'week-requires-day-or-above'  // 卫星 = 1w 且基准 < 1d
  | 'no-shared-anchor';           // 通过上述护栏但无同锚点合成（真无重叠）

export interface SyncStats {
  // …既有一切字段保持不变（applied/suppressed/echoEvents/degraded/degradedPeriod/
  //   unalignedFollowers/lastUnalignedReason/lastCorrectionIterations/spanResidualBars/
  //   edgeResidualBars/barSpaceAdjust/lastSpanDiffMinutes）…
  /** （新增；C）被排除的卫星（周期 + 原因）。空数组 = 无排除。 */
  excludedSatellites: Array<{ period: string; reason: SyncExclusionReason }>;
  /** （新增）可同步的跟随者数（不含基准）。 */
  syncableFollowerCount: number;
  /** （新增；B）组是否建立：基准存在 **且** 基准 + 可同步跟随者 ≥ 2。 */
  groupEstablished: boolean;
  /** （新增；B）未建立原因；已建立 ⇒ null。 */
  groupReason: 'missing-base' | 'no-syncable-follower' | null;
  /** （新增；U7）最近一次对齐中各跟随者的有效密度比与来源（键 = 跟随者周期）。 */
  densityByFollower: Record<string, { ratio: number; source: 'measured' | 'static' | 'composed' | 'none' }>;
}
```

**语义（实现须逐条满足）**

1. **构造函数不抛错**（B）：任何 `members` 组合都返回可用对象；不可同步卫星进入 `excludedSatellites`。
2. **排除 = 从同步目标中剔除**（D）：被排除成员**既不被写入**，也**不进入** `targets`；
   `zeroRightOffsets` 的成员集合必须**不含**被排除成员（否则右偏移会被写）。
3. **`groupEstablished` / `groupReason`**（B）：基准缺失 ⇒ `missing-base`；基准在但可同步跟随者 = 0 ⇒
   `no-syncable-follower`；两者都不得静默（必须能经 `stats` 与 `onChange` 读出）。
4. **初始广播**（C）：`chartSyncContext.useChartSyncGroup` 在**组（重）建后**必须**至少广播一次** `stats`
   （含 `excludedSatellites`/`groupEstablished`/`groupReason`），使页面**在用户任何交互之前**就能显示
   「未同步 / 整组未建立」；不得只 `console.warn`。
5. **密度来源可区分**（U7）：`effectiveDensity` 的取值路径必须如实标注 —— 实测表命中 ⇒ `static`；
   同锚点合成 ⇒ `composed`；运行时估计 ⇒ `measured`；不可用 ⇒ `none`。`5m↔1h` 必须标 `composed`。
6. **`densityByFollower`**：每次对齐后按**跟随者周期**记录「本次实际使用」的 `{ratio, source}`。
7. `EMPTY_SYNC_STATS`（`chartSyncContext.ts:31-45`）必须同步补齐新字段（关闭态/组销毁归零；零残留）。

### 2.2 页面级 DOM 契约（C；`MultiPeriodChartStack` / `MultiPeriodSatellite`）

```
[data-mp-satellite="<period>"]                 （P2 已有）
└── [data-mp-sync-excluded="<period>"]         （新增；仅**被排除**的卫星存在）
      data-mp-sync-excluded-reason="<reason>"  （= SyncExclusionReason 原样）
      textContent 含「未同步」
      title 可行动（含「周期」二字，即提示改选周期）

[data-mp-stack]                                （P5 已有）
└── [data-mp-sync-group-unestablished]         （新增；仅「整组未建立」时存在）
      data-mp-sync-group-reason="missing-base" | "no-syncable-follower"
```

非排除 / 组已建立 ⇒ 对应元素**不存在**（不得残留）。既有「对齐受限」角标 `[data-mp-sync-degraded="<period>"]`
语义**不变**（与新增角标并存，互不替代）。

---

## 3. 分层策略与夹具口径

| 层 | 载体 | 覆盖 |
|---|---|---|
| L0 纯函数 | 动态命名空间访问（`import * as`） | U1/U1-2/U2/U3：守门口径 + `composeDensity` 可调用性 |
| L1 组行为 | jsdom + 忠实桩 `src/test/syncChartStub.ts`（**不改桩**） | U3-2/U4/U5/U5-2/U6/U7/U7-2/U8：构造不抛错、可观测、零写入、密度来源、基准护栏 |
| L2 React 接线 | `renderHook(useChartSyncGroup)` | U9/U9-2：**不得只 console.warn**（初始广播 + 排除/未建立可读） |
| L3 页面 DOM | `MultiPeriodChartStack` + `klinecharts` 忠实桩（同 `multiPeriodSyncBadge.test.tsx` 形态）+ 基准**注册代理** | U10/U10-2：页面可见角标 / 整组未建立可见状态；U10-H 为**夹具自检** |

**夹具要点**

1. 密度校准：`baseSpacing = 该周期桶宽 / D`（与 `chartSyncGroup.test.ts` 同口径）⇒ `round(baseBS × D)` 与
   「跨度 ≤1 根跟随者 bar」两条口径在桩上同时可判；
2. 基准桩 `barSpaceLimit{1,50}`（**不放宽**，ADR-020），卫星桩放宽到 350；
3. **抑制窗（16ms）**：挂载期卫星自身 init 事件会先触发一次对齐并打开 `suppressUntil` 窗；紧随其后的
   手势会被吞（`handleEvent` 的 `suppressUntil` 分支，**既有 P3 语义，非缺陷**）⇒ L3 夹具在手势前
   `settle()`（sleep 40ms）；L1 夹具在 `start()` 后首次手势无此问题（`suppressUntil = 0`）；
4. `composeDensity` 用**动态属性探测**（`(mod as any).composeDensity`）而非静态命名导入 ⇒ 红阶段
   报错形态是**断言失败**（`expected 'undefined' to be 'function'`），不是模块链接/收集错误；
5. 「构造函数抛错」被 `buildGroup()` 捕获后转成断言（`expect(error).toBeNull()`）⇒ 红原因分类恒为
   **断言失败**，不依赖运行时异常形态。

---

## 4. 用例清单（17 例：13 红 + 4 绿侧防护）

| # | 用例（文件内 `it` 名） | 判据（Given–When–Then） | 本阶段 | 红原因 |
|---|---|---|---|---|
| U1 | `U1 合成可用即放行` | Given 同锚点合成可用 When 守门 Then `(5m,15m)/(5m,1h)/(15m,1h)` 全 `true` | **红** | 断言失败（`false !== true` ×3） |
| U1-2 | `U1-2 契约（A）：composeDensity 可直接调用…` | Then `typeof composeDensity === 'function'`；值 = 合成比（±0.1）；无公共锚点 ⇒ `null` | **红** | 断言失败（`'undefined' !== 'function'`） |
| U2 | `U2 无公共锚点仍拒绝…` | `(5m,1d)/(15m,1d)/(1m,1d)/(1h,1d)` 全 `false` | **绿（防护）** | — |
| U3 | `U3 既有护栏不回退…` | 卫星<基准 / 含 `1mo` / 未知周期 / `1w` 需基准≥`1d` 全 `false`；同周期与表内组合 `true` | **绿（防护）** | — |
| U3-2 | `U3-2 构造期排除原因码…` | `5m+1m` ⇒ `satellite-lower-than-base`；`1m+1w` ⇒ `week-requires-day-or-above` | **红** | 断言失败（构造抛错） |
| U4 | `U4 构造不抛错…` | `5m+[1h,1d]`：构造/start/stop 不抛错；`excludedSatellites === [{period:'1d',reason:'no-shared-anchor'}]`；`1h` 不在其中；`syncableFollowerCount===1`；`groupEstablished===true`；`groupReason===null` | **红** | 断言失败（构造抛错） |
| U5 | `U5 无可同步跟随者…` | `5m+仅 1d`：不抛错；`syncableFollowerCount===0`；`groupEstablished===false`；`groupReason==='no-syncable-follower'` | **红** | 断言失败（构造抛错） |
| U5-2 | `U5-2 基准缺失…` | 无 `isBase` 成员：不抛错；`groupEstablished===false`；`groupReason==='missing-base'` | **红** | 断言失败（`undefined !== false`） |
| U6 | `U6 被排除成员零写入…` | 基准手势对齐后：被排除桩 `setBarSpace/scrollToDataIndex/scrollToTimestamp/setOffsetRightDistance` **全 0 次**且 barSpace/视口/右偏移**原样**；可同步桩**有** `setBarSpace` + 定位调用；被排除桩自身派发事件后仍 0 次 | **红** | 断言失败（构造抛错） |
| U7 | `U7 密度来源可观测…` | `5m+1h` 对齐：`densityByFollower['1h'] = {ratio≈8.0426 (容差 ±0.1), source:'composed'}`；`satBS = round(8×8.0426) = 64`（**不得** 名义比 12 的 96） | **红** | 断言失败（构造抛错） |
| U7-2 | `U7-2 来源可区分（static vs composed）` | `1m+5m`：`source==='static'`、`ratio≈4.7`、`satBS=38` | **红** | 断言失败（`densityByFollower` 读数 undefined） |
| U8 | `U8 基准永不作为 follower` | 卫星 `5m` 做 leader：基准 barSpace/可见范围/右偏移**逐字段不变**、无 `setBarSpace` 写入；另一卫星仍被写入；`echoEvents===0` 且 `suppressed>0` | **绿（防护）** | — |
| U9 | `U9 base=5m+[1h,1d] ⇒ onStats 必须广播…` | `renderHook(useChartSyncGroup)`：注册 3 个成员后**不交互**即须有快照；快照含 `excludedSatellites===[{1d,no-shared-anchor}]`、`groupEstablished===true`、`syncableFollowerCount===1` | **红** | 断言失败（无任何快照广播） |
| U9-2 | `U9-2 仅卫星 1d ⇒ 必须上报「整组未建立」` | 同上，但 `groupEstablished===false`、`groupReason==='no-syncable-follower'` | **红** | 断言失败（无任何快照广播） |
| U10-H | `U10-H（夹具自检，绿侧）1m+5m/15m…` | 页面链路：2 个卫星 pane；基准手势后**两卫星都被写入**（regsitrar → provider → group → 写入） | **绿（自检）** | — |
| U10 | `U10 base=5m+[1h,1d]：被排除卫星（1d）必须有可见角标…` | `[data-mp-sync-excluded="1d"]` 存在、`data-mp-sync-excluded-reason==='no-shared-anchor'`、文案含「未同步」、`title` 含「周期」；`1h` **无**角标；无「整组未建立」状态 | **红** | 断言失败（元素不存在 ⇒ `expected null not to be null`） |
| U10-2 | `U10-2 base=5m+仅卫星 1d：整组未建立也必须有页面可见状态` | `[data-mp-sync-group-unestablished]` 存在且 `data-mp-sync-group-reason==='no-syncable-follower'`；被排除卫星角标同时可见 | **红** | 断言失败（元素不存在） |

**判据容差（钉死）**：密度比容差 `±0.1`（`DENSITY_TOLERANCE`）；合成值 `D(5m→1h)=37.8/4.7`。

---

## 5. 变异反证计划（`M#`；沙箱 `/tmp` 副本内进行，禁改工作区）

| 变异 | 手法 | 必红用例 | 状态 |
|---|---|---|---|
| **M1** | 守门退回「只认实测表」（= **修复前现状**：`chartSyncGroup.ts:294`） | U1 / U1-2 / U4 / U5 / U6 / U7 / U9 / U10 | **已由本轮红基线天然反证**（当前实现即 M1；A1 证据） |
| **M2** | 保持「单卫星不可用 ⇒ 构造函数抛错」（= **修复前现状**） | U4 / U5 / U5-2 / U6 / U7 / U9 / U10 | **已由本轮红基线天然反证**（A1 证据） |
| **M3** | 「排除但**仍写入**」（如把被排除成员留在 `zeroRightOffsets` 集合 / 仍进入跟随循环） | U6（零写入 + 原样切片） | 待实现后沙箱执行 |
| **M4** | `groupEstablished` 恒 `true`（或 `groupReason` 恒 `null`） | U5 / U5-2 / U9-2 / U10-2 | 待实现后沙箱执行 |
| **M5** | 组（重）建后**不广播**初始快照（只 `console.warn`） | U9 / U9-2 / U10 / U10-2 | 待实现后沙箱执行 |
| **M6** | 用**名义周期比**（60/12）代替同锚点合成 | U7（`satBS=96 ≠ 64`、`ratio` 超容差） | 待实现后沙箱执行 |
| **M7** | 页面只渲染角标、不渲染 `data-mp-sync-group-unestablished` | U10-2 | 待实现后沙箱执行 |
| **M8** | 为放行合成而放宽 `1w` 护栏 | U3（`1m↔1w` / `5m↔1w` / `1h↔1w` 必须 false） | 待实现后沙箱执行 |

> M1/M2 的「反证」含义：**当前红基线的失败集合恰好是这两条变异的必红集合**（A1 证据逐条可核）⇒
> 用例具备判别力，且**不需要**改实现来证明。

---

## 6. 红/绿基线与既有测试冲突（**父级须裁决**）

### 6.1 断言失败判定

- 单独运行：`13 failed | 4 passed (17)`；**无**模块缺失/语法/收集错误；**无崩溃/core dump**；退出码 1。
- 全量（含新文件）：`1 failed file | 13 failed | 793 passed (806)`；**唯一失败文件 = 本新增文件**。
- 全量基线（排除新文件）：`85 files / 789 tests` **全绿**（既有未破坏；本轮未命中既有 flaky
  `StrategyEditorPage.test.tsx:60`）。

### 6.2 ⚠️ 既有测试冲突（阻塞实现阶段，需父级授权）

`web/src/features/dashboard/chartSyncGroup.test.ts:316-324`（T3-4）**要求 `1m↔1w` 构造即抛错**：

```ts
expect(() => { const g = new ChartSyncGroup(members(base, sat, '1m', '1w')); g.start(); },
  '1m↔1w 是不可用组合…').toThrow(/1m|1w|不可用|退化|reject|unsupported/i);
```

而修复口径 **B**（父级裁决）要求构造函数**不抛错**（改排除）。`1m↔1w` 在修复后仍是「不可同步组合」
（`1w` 需基准 ≥ `1d`），因此该既有断言**必然转红**。二者在 `1m↔1w` 这一输入上**不可同时成立**。

- 本轮禁令「不得改既有测试」⇒ 该冲突**不在本轮处理**；
- 建议（需父级裁决其一）：① 授权实现阶段把 T3-4 改写为「不得抛错 + 该卫星被排除（reason =
  `week-requires-day-or-above` / 整组未建立可观测）」；或 ② 改口径为「仅当**所有**卫星都不可同步时才抛错」
  （本文件的 U3-2/U5/U10-2 判据需相应复核）。

### 6.3 本轮**未执行**项（如实标注）

- M3–M8 的沙箱变异执行（计划已列，见 §5）；
- 真实渲染（Playwright）层面的「被排除角标」像素级取证（`web/tester/*-harness/`）——本轮为 jsdom 语义层；
- 页面级「被排除角标」在 `DashboardPage` 全页（含标的选择/工具栏联动）下的形态验证（本轮用
  `MultiPeriodChartStack` 直接渲染 + 基准注册代理，已由 U10-H 自检证明链路可用）。
