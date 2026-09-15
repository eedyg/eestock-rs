# 287 — 跨图同步「当前配置下静默失效」修复（TDD 实现阶段）

> **本报告位置**：`coder/report/287_sync_coverage_impl.md`
> 角色：Coder（实现阶段；**未 commit、未部署、未发任何 `/api` 写请求、未改后端/config schema/`web/dist/**/`DASHBOARD_DEFAULTS`、未动 286 的暂存改动**）
> 仓库 / HEAD：`/home/eestock/workspace/git/eestock/eestock-rs` @ `8828d4621d9536687a380462f567590d5fc3ea3b`（`master`）
> 红测试（tester 产出，本阶段未改一字）：`web/src/features/dashboard/syncCoverage.test.ts`（17 例）
> 红测试设计：`tester/design/287_sync_coverage_red_design.md`；红执行：`tester/test/287_sync_coverage_red.md`；红证据：`tester/evidence/287_sync_red/`
> 状态：**完成**；红 → 绿；三条门禁全绿（见 §5）

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 红基线（实现前实测） | `syncCoverage.test.ts`：**13 failed \| 4 passed (17)**（exit 1） |
| 修复后 | 同一文件 **17 passed (17)**；全量 **86 files / 806 tests 全绿** |
| 新增 `SyncStats` 字段 | `excludedSatellites` / `syncableFollowerCount` / `groupEstablished` / `groupReason` / `densityByFollower` |
| 新增页面 DOM 属性 | `[data-mp-sync-excluded="<period>"]`（+ `data-mp-sync-excluded-reason`）、`[data-mp-sync-group-unestablished]`（+ `data-mp-sync-group-reason`） |
| 既有测试适配 | **1 条**（`chartSyncGroup.test.ts` T3-4，经父级裁决的语义变更；见 §6） |
| 门禁 | vitest 全绿 · `tsc -b` exit 0 · `check-tangle.sh` exit 0（原始输出见 §5） |

---

## 1. 缺陷根因（回放，不改口径）

用户配置 `base=5m` + 卫星 `1h/1d`：`ChartSyncGroup` 构造函数对**每个**卫星调用
`isSyncCombinationAllowed(base, sat)`，而该函数**只认实测密度表**（`MEASURED_DENSITY_TABLE`，无 `5m:1h`）
⇒ 构造抛错 ⇒ `chartSyncContext.ts` 的 `try/catch` 只 `console.warn` ⇒ **整组不建立 ⇒ 跨图同步完全静默失效**
（页面 `syncDegraded` 仍 false，无任何可见提示）。

修复即把「**单个卫星不可同步 = 整组失败且静默**」改为「**该卫星只排除自己 + 全链路可见**」。

---

## 2. 改动清单与理由

### 2.1 `web/src/features/dashboard/chartSyncGroup.ts`（+151 / −29）

| 改动 | 理由（对应口径） |
|---|---|
| `composeDensity()` 由模块内私有**改为 `export`** | 口径 A 要求「同锚点合成」可被测试**直接调用**（`syncCoverage.test.ts` U1-2 的钉死判据）。**算法本体未改**（`D(base→sat)=D(锚→sat)/D(锚→base)`，无公共锚点 ⇒ `null`） |
| 新增 `syncExclusionReason(base, sat): SyncExclusionReason \| null`（导出） | 口径 A/B：把「组合是否可用」与「不可用的**原因**」同源化。优先级钉死：`unsupported-period` > `satellite-lower-than-base` > `week-requires-day-or-above` > `no-shared-anchor` |
| `isSyncCombinationAllowed()` 改为 `syncExclusionReason(...) === null` | 口径 A：守门口径统一为「同周期 ∪ 实测表命中 ∪ **同锚点合成可用**」；**既有护栏逐条不变**（卫星<基准 / 含 `1mo` / 未知周期 / `1w` 需基准 ≥`1d`）。**未**放宽任何护栏（U2/U3 绿侧防护保持绿） |
| 构造函数**不再抛错**：逐卫星评估 ⇒ 可同步者登记进 `syncableIds`，不可同步者写入 `stats.excludedSatellites`（周期+原因码） | 口径 B：单个卫星不得拖垮整组。仅「基准缺失」(`missing-base`) 或「可同步跟随者 = 0」(`no-syncable-follower`) 才 `groupEstablished=false`，且该状态**写入 stats**（显式上报，不再只 `console.warn`） |
| `isParticipant()`：`m.isBase \|\| syncableIds.has(m.id)` | 口径 B/D 的单一判据：被排除卫星**既非 leader 也非 follower** |
| `handleEvent()` 对非参与者**早退** | 口径 D：被排除卫星自身的手势不得导致任何写入 |
| `alignFrom()` 的 `targets` 增加 `syncableIds.has(m.id)` 过滤；`zeroRightOffsets()` 只覆盖 `[leader, ...targets]`（被排除者已在筛选外） | 口径 B/D：被排除成员**不进入 targets、不进入 zeroRightOffsets**（否则右偏移仍会被写） |
| `start()`：组未建立 ⇒ 不订阅任何成员；已建立 ⇒ 只订阅参与者 | 口径 B：未建立 = 零行为（零写入），状态经 `stats` 上报 |
| `scrollAllToLatest()` 只作用于参与者 | 口径 D 的必然推论（见 `03-test-plan.md` D11）：被排除成员不参与任何同步写入路径 |
| `publishStats()`（公开） | 口径 C：组（重）建后必须能**至少广播一次**（`chartSyncContext` 调用） |
| `effectiveDensity()` 由「返回 `number \| null`」改为「返回 `{ ratio, source }`」，来源如实标注：实测表命中/反向 ⇒ `static`；同锚点合成 ⇒ `composed`；运行时估计 ⇒ `measured`；不可用 ⇒ `none` | 口径 C：`composeDensity` 的密度来源必须**可区分**（U7 要求 `5m↔1h` ⇒ `composed`；U7-2 要求 `1m↔5m` ⇒ `static`，且**不得**互相伪装） |
| 每次 `alignFrom()` 重建 `stats.densityByFollower`（键 = 跟随者周期；跳过者记 `{ratio: NaN, source:'none'}`）；leader 窗口不可读的早退分支清空该表 | 口径 C：读数必须反映**最近一次**对齐的实际使用值（不留陈旧读数） |
| **未改动**：`MAX_ALIGN_CORRECTION_ITERATIONS` / `MAX_BAR_SPACE_STEP_RATIO` / `SUPPRESSION_WINDOW_MS` / 重入抑制逻辑 / 「基准永不作为 follower」/ 诚实降级（`degraded`/`degradedPeriod`/`unalignedFollowers`/`spanResidualBars`/`edgeResidualBars`/`barSpaceAdjust`） | 硬约束逐条不回退（任务明文要求） |

### 2.2 `web/src/features/dashboard/chartSyncContext.ts`（+17 / −3）

- `EMPTY_SYNC_STATS` 补齐 5 个新字段（关闭态/组销毁归零；`groupReason: null` ⇒ 页面**不**渲染「整组未建立」，
  与「确实建过组但未建立（`groupReason` 非 null）」可区分）。
- `rebuild()`：组创建/`start()` 后调用 **`group.publishStats()`**（口径 C 的「（重）建后至少广播一次」）。
- `catch` 分支：构造函数已不再因单个卫星抛错，保留为兜底；兜底时除 `console.warn` 外**同时广播归零 stats**
  （不再出现「只 warn 无状态」）。

### 2.3 `web/src/features/dashboard/MultiPeriodChartStack.tsx`（+49 / −6）

- `SyncBadgeState` 扩展为 `{ period, spanDiffMinutes, excluded, groupReason }`；`handleSyncStats` 增加
  排除列表的**值等价判定**（`sameExcluded`）⇒ 滚动期间不因新数组引用而 churn（保持既有「非降级态滚动不重渲染」性能口径）。
- 每个卫星传入 `syncExcludedReason`（按周期从 `excluded` 查得；非排除 ⇒ `null`）。
- **整组未建立**页面可见状态：栈根（新增 `relative`）内渲染 `[data-mp-sync-group-unestablished]` +
  `data-mp-sync-group-reason`，**绝对定位** ⇒ 不参与 flex 布局（「Σ pane == 可用高度」不变量不变）。

### 2.4 `web/src/features/dashboard/MultiPeriodSatellite.tsx`（+19 / −0）

- 新增可选 prop `syncExcludedReason?: string | null`（向后兼容：未传 ⇒ 不渲染角标）。
- 被排除时渲染 `[data-mp-sync-excluded="<period>"]`（+ `data-mp-sync-excluded-reason="<reason>"`）：
  文案含「**未同步**（周期）」，`title` 含「周期」+ 可行动处置建议（改为与基准同锚点 / 调整基准周期）。
  非排除态**元素不存在**（不得残留）。既有「对齐受限」`[data-mp-sync-degraded]` 角标语义**不变**（并存，互不替代）。

### 2.5 明确**未改**的文件

- `web/src/features/dashboard/multiPeriodStore.ts`：**未改**。页面角标直接从 `MultiPeriodChartStack` 的
  `onStats` 状态渲染；store 只镜像 `syncDegraded/syncDegradedPeriod/lastSpanDiffMinutes/syncApplied/syncSuppressed`
  （P3 既有口径），验收口径（`SyncStats` + 页面 DOM）均不经 store。新增字段进入 store 会增加无消费者状态与
  既有 `toEqual` 快照断言的风险，故**不透传**（如需页面外持久观测，建议另开任务）。
- 后端 `crates/**`、config schema、`web/dist/**`、`DASHBOARD_DEFAULTS`：**未改**（任务禁令）。
- 286 的暂存改动（`git diff --cached`：14 files）：**未动、未回退**（`git status` 中 286 的文件仍为已暂存态）。

---

## 3. 新增 `SyncStats` 字段命名（口径 C）

```ts
export type SyncExclusionReason =
  | 'unsupported-period'          // 含 1mo / 未知周期
  | 'satellite-lower-than-base'   // 卫星周期 < 基准
  | 'week-requires-day-or-above'  // 卫星 = 1w 且基准 < 1d
  | 'no-shared-anchor';           // 通过护栏但无实测/合成密度（真无重叠）

export type SyncGroupFailureReason = 'missing-base' | 'no-syncable-follower';

export interface FollowerDensityReading {
  ratio: number;
  source: 'measured' | 'static' | 'composed' | 'none';
}

// SyncStats 新增：
excludedSatellites: Array<{ period: string; reason: SyncExclusionReason }>;  // 被排除卫星（周期 + 原因）
syncableFollowerCount: number;                                              // 可同步跟随者数（不含基准）
groupEstablished: boolean;                                                  // 基准存在 && 基准+可同步跟随者 ≥ 2
groupReason: SyncGroupFailureReason | null;                                 // 未建立原因（已建立 ⇒ null）
densityByFollower: Record<string, FollowerDensityReading>;                  // 键 = 跟随者周期
```

同源 DOM 契约（`02-spec.md` §9 已同步）：

```
[data-mp-satellite="<period>"] > [data-mp-sync-excluded="<period>"]
                                   data-mp-sync-excluded-reason="<SyncExclusionReason>"
                                   textContent ⊇「未同步」；title 含「周期」+ 处置建议
[data-mp-stack]                > [data-mp-sync-group-unestablished]
                                   data-mp-sync-group-reason="missing-base"|"no-syncable-follower"
非排除 / 已建立 ⇒ 对应元素不存在（不得残留）
```

---

## 4. 文档改动摘要（事实源同步）

| 文件 | 位置 | 改动 |
|---|---|---|
| `design/15-multi-period/02-spec.md` | **§3.2** 实测锚定表之后 | 新增「密度取值口径与来源可观测」四段：①实测表 ⇒ `static`；②**同锚点合成** ⇒ `composed`（`D(5m→1h)=37.8/4.7≈8.043`、`D(5m→15m)≈2.596`、`D(15m→1h)≈3.098`）；③运行时估计 ⇒ `measured`；④皆不可用 ⇒ `none`（真无公共锚点：`5m/15m/1m/1h↔1d`、`5m/1m↔1w`、含 `1mo`）+ 「守门口径统一」与「来源诚实性（实测不得标注为 composed，反之亦然）」 |
| 同上 | **§7 护栏** | 新增第 **6** 条「运行时同步护栏」：**替代**「周期组合不可用即整组拒绝」⇒ 构造函数不得抛错、不可同步卫星**只排除自己 + 零写入**、每卫星**必须可见角标**、仅「基准缺失 / 可同步跟随者 < 2」不建立组且必须有**页面可见状态**（禁止只 `console.warn`）、原因码优先级；并复述「硬约束逐条不回退」 |
| 同上 | **§9 可观测性** | 新增 `SyncStats` 5 字段说明 + 「（重）建后至少广播一次」+ 关闭态/组销毁归零 + 页面可见状态两类（含「对齐受限」角标语义不变、并存不互替） |
| `design/15-multi-period/03-test-plan.md` | **§6 台账** | 追加 **D9**（同锚点合成值为**推导值**、5m↔1h 尚无真渲染取证 ⇒ 待补 Playwright harness）、**D10**（基准未注册窗口「整组未建立」角标短暂出现 = 诚实降级）、**D11**（`scrollAllToLatest` 同样跳过被排除卫星）、**D12**（两类角标同区域可能视觉重叠） |

**「无 `file=` 生成物块」判据（已实测）**：

```
$ grep -c "file=" design/15-multi-period/02-spec.md design/15-multi-period/03-test-plan.md
design/15-multi-period/02-spec.md:0
design/15-multi-period/03-test-plan.md:0
（grep 退出码 1 = 无匹配）
```

⇒ 两文件**无 `file=` 生成物块**，故**可直接手改**、无需 tangle；`./scripts/check-tangle.sh` 也据此仍 exit 0（§5）。

---

## 5. 门禁（原始输出）

### 5.1 `cd web && ./node_modules/.bin/vitest run`

红基线（实现前，同一命令同文件）：

```
 Test Files  1 failed (1)
      Tests  13 failed | 4 passed (17)
```

实现后（全量）：

```
 ✓ src/features/dashboard/syncCoverage.test.ts (17 tests) 190ms
...
 Test Files  86 passed (86)
      Tests  806 passed (806)
   Start at  22:59:59
   Duration  6.48s (transform 3.02s, setup 3.78s, collect 12.16s, tests 32.96s, environment 26.71s, prepare 6.34s)
```

- 全量 **86 files / 806 tests 全绿**（= 红执行报告基线 85 files/789 + 新增 `syncCoverage.test.ts` 17 例）；
- **`syncCoverage.test.ts` 17/17 全绿**；
- 既有间歇 flaky `StrategyEditorPage.test.tsx:60` **本轮未命中**（连续两次全量运行均全绿）⇒ 无「需证明无关」的情形；
  若后续验收命中该 flaky，其与本次改动无调用面交集（本次仅触及 dashboard 同步/多周期 7 个文件）。

### 5.2 `cd web && ./node_modules/.bin/tsc -b`

```
$ ./node_modules/.bin/tsc -b; echo "tsc exit=$?"
tsc exit=0
（无任何输出）
```

### 5.3 `./scripts/check-tangle.sh`

```
$ ./scripts/check-tangle.sh; echo "tangle exit=$?"
[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）。
tangle exit=0
```

---

## 6. 既有测试适配（逐条）

### 6.1 `web/src/features/dashboard/chartSyncGroup.test.ts`

| # | 位置 | 原断言 | 新断言 | 依据 |
|---|---|---|---|---|
| A1 | 原 `T3-4`（原 L316-324，`it` 内 `expect(...).toThrow(/1m\|1w\|不可用\|退化\|reject\|unsupported/i)`） | `1m↔1w`（唯一卫星）**构造/启动必须抛错** | `expect(() => g.start()).not.toThrow()`；`g.stats.excludedSatellites` **等于** `[{period:'1w', reason:'week-requires-day-or-above'}]`；`syncableFollowerCount === 0`；`groupEstablished === false`；`groupReason === 'no-syncable-follower'`；并**新增更强**的「零写入」断言：`base.scrollToDataIndex(500)` 后该卫星 `setBarSpace/scrollToDataIndex/scrollToTimestamp/setOffsetRightDistance` **调用数 = 0** | 父级裁决 **B**（`tester/design/287_sync_coverage_red_design.md` §1-B/§2.1/§6.2）：构造函数不得因单个卫星抛错；不可同步卫星「排除 + 可观测 + 零写入」。**护栏强度未削弱**（`1m↔1w` 仍被排除/未建立组），判定力由「抛错」转为「排除原因码 + 建组状态 + 零写入」三条更强的可观测断言 |
| A2 | 同文件本地接口 `SyncStatsLike`（原 L32-39） | 无 287 字段 | 增补 `excludedSatellites` / `syncableFollowerCount` / `groupEstablished` / `groupReason`（**纯类型声明**，仅让 T3-4 能读取新字段） | 该文件用局部结构接口对动态 `import()` 做 cast；不加字段则新断言无法通过 `tsc -b`。**未改动任何断言语义** |

> 除上述两处，**未改动任何既有测试**：`git diff --stat` 中测试文件仅 `chartSyncGroup.test.ts`（+34/−5）；
> 其余测试（`chartSyncDensity.test.ts` / `chartSyncAlignClosedLoop.test.ts` / `chartSyncStubFidelity.test.ts` /
> 页面级多周期测试 / `volToggle.test.tsx` 等）**逐字节未改**，且全绿 ⇒ 无「为让绿而弱化断言」的情形。
> 特别地：`chartSyncDensity.test.ts:193-199` 的 `1m↔1w / 1m↔1d / 1h↔1w / 5m↔1m / 含 1mo` 负例
> **全部保持原样并通过**（证明护栏未被为「合成放行」而放宽）。
> 286 的暂存改动（含 `volToggle.test.tsx`、`Toolbar.*`、`KlineChart.*` 等）**一字未动**。

---

## 7. 验证方式（除门禁外的独立核对）

1. **红 → 绿对照**：实现前 `13 failed | 4 passed`（U1/U3-2/U4/U5/U5-2/U6/U7/U7-2/U9/U9-2/U10/U10-2/U1-2 红；
   U2/U3/U8/U10-H 绿侧防护），实现后 `17 passed`——绿侧防护 4 例**自始至终未红**，证明未以放宽判据换绿。
2. **数值核对（U7/U7-2）**：`5m↔1h` 合成密度 `≈8.0426` ⇒ `satBS = round(8 × 8.0426) = 64`（若按名义比 12 ⇒ 96 ⇒ 必红）；
   `1m↔5m` 表内命中 ⇒ `source='static'`、`satBS = round(8 × 4.7) = 38`。均为**推导航为**而非事后对齐。
3. **页面链路**：U10-H（夹具自检，允许组合）保持绿 ⇒ 「基准 registrar → provider → group → 卫星写入」整链可用；
   U10/U10-2 断言新角标存在且 `data-mp-sync-excluded-reason` 精确等于 `no-shared-anchor`、
   `data-mp-sync-group-reason` 精确等于 `no-syncable-follower`（非「存在即过」）。
4. **零残留核对**：`EMPTY_SYNC_STATS` 归零 + `multiPeriodClosedEquivalence`（关闭态 DOM 指纹/`innerHTML` 逐字节等价）
   全绿 ⇒ 新增角标不会泄漏到关闭态（`groupReason: null` 不渲染，且关闭态不挂 provider）。
5. **`check-tangle.sh`**：设计文档改动后重跑仍 exit 0（无 `file=` 生成物块，见 §4）。

---

## 8. 残余风险 / 未做项（如实）

- **D9（重要）**：`5m↔1h` 等「同锚点合成」密度值是**推导值**（`37.8/4.7`），尚无**真渲染（几何/像素）取证**；
  本轮证据止于 jsdom 忠实桩（`satBS=64`）。已记入 `03-test-plan.md §6` D9，建议下一阶段补 Playwright harness。
- **D10**：基准 chart 尚未注册而卫星已注册的短窗内，「整组未建立（基准缺失）」角标会**短暂出现**（诚实降级，非误报）。
- **D11**：「回到最新」不再把**被排除**卫星拉回右端（口径 D 的必然推论，已在文档注明）。
- **D12**：被排除角标与「对齐受限」角标同区域（`right-1 top-4`），极端情形可能视觉重叠（DOM 契约不变）。
- **未执行**：变异测试 M3–M8 的沙箱执行（属 tester 独立验收动作）；真实渲染（Playwright）层面的角标像素取证。
- **未改**：`multiPeriodStore`（理由见 §2.5）；`web/dist/**` 未重建（禁令：不构建部署）。

## 9. 合规声明

- **未** `git commit`（仅 `git add` 暂存）。
- **未**构建/部署（未跑 `npm run build`、未写 `web/dist/**`、未触碰 `/tmp/app_dev_8081.toml`、未重启任何服务）。
- **未**发任何 `/api` 写请求（本阶段全部为 vitest/jsdom 与静态检查；无 HTTP 客户端发起）。
- **未**改后端 `crates/**`、config schema、`DASHBOARD_DEFAULTS`。
- **未**动 286 的暂存改动（`git diff --cached` 与实现前一致；286 文件仍为已暂存态）。
