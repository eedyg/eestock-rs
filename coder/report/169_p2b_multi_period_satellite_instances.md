# 169 — P2-B 实施报告：多周期**卫星实例**（隐藏 K 线 + 指标继承 + 预算护栏）

- **本文件路径**：`coder/report/169_p2b_multi_period_satellite_instances.md`
- 角色：Coder（worker）；阶段：P2（`design/15-multi-period/04-implementation-plan.md` 的 P2）
- 仓库：`/home/eestock/workspace/git/eestock/eestock-rs` @ `2632c9e`（web：klinecharts 10.0.3 / vitest 3.2.7 / React 18）
- 权威依据：`design/15-multi-period/{01-adr.md,02-spec.md（含新增 §2.1 裁决 A）,03-test-plan.md,04-implementation-plan.md}`、P2-A 红测试交付（`tester/test/269_p2a_satellite_red_execution.md`）
- 本轮**明确不做**：跨图同步（P3）、LIVE 虚线段（P4）、高度拖拽持久化与两步周期选择器（P5）、G4 像素取证（阶段 3 由 tester 做）、宫格内多周期、`1mo`、本地聚合、Rust/生成物改动、线上重启/写请求。

---

## 1. 改动文件清单

### 新增（2）

| 文件 | 行数 | 作用 |
|---|---|---|
| `web/src/features/dashboard/MultiPeriodSatellite.tsx` | 142 | 单个卫星实例：自持 `KlineDataFeed(period=卫星周期)` + `KlineChart(hideCandles)` + 失败可见横幅 + 高度 |
| `web/src/features/dashboard/multiPeriodSatelliteLifecycle.test.tsx` | 362 | **本轮新增测试（先红后绿）**：失败可见 / 关闭零残留 / 切标的不串数据 / G3 预算 / 单周期等价 / 基准覆盖可观测 |

### 修改（4，全部为既有产品代码，未改任何既有测试文件）

| 文件 | +/− | 改动 |
|---|---|---|
| `MultiPeriodChartStack.tsx` | +92/−10 | 卫星容器：`satellites`/`api`/`ws`/`code`/`indicators`/`maWindows`/`dcapParams`/`viewportBars`/`followLatest`/`basePeriod`/`basePeriodSource` props；`<>{children}{satellites}</>`（**基准恒为片段第一个子节点 ⇒ 不 remount**）；无卫星/未启用 ⇒ 逐字节透传 children |
| `DashboardPage.tsx` | +45/−6 | `resolveBasePeriod`（裁决 A）⇒ 基准 feed/图表周期；卫星清单（`periods[1..]` + `heights[period]`）；把指标/MA/dcap/视口/跟随态下传；多周期时基准图表按 `heights[basePeriod]` 渲染 |
| `KlineChart.tsx` | +43/−3 | 新增 `hideCandles`（Effect H：`setPaneOptions({id:'candle_pane',state:'minimize',minHeight:0})` + `setStyles({separator:{size:0}})`）、`onInitError`（`init()` 失败可见，不再静默 return）、`heightPx`（多周期按配置高度；缺省 `h-full` 现状等价） |
| `multiPeriodStore.ts` | +37/−2 | 派生可观测字段 `basePeriodOverridden` / `basePeriodSource`（每次 patch 重算）+ 纯函数 `basePeriodDerivation` / `resolveBasePeriod` |

> `design/15-multi-period/02-spec.md`（新增 §2.1）与 `03-test-plan.md`（T1 细化、G4 前置声明）在工作树中显示为已修改，**均为架构师/tester 侧改动**，本轮 worker 未触碰任何 design 文档。

**架构对齐**：全部改动落在既有分层内——容器/实例属 `features/dashboard`（组件层），数据面复用既有 `KlineDataFeed`/`realtimePoll`（数据流层，零改动），指标一律经 P0.1 的唯一入口 `addOverlayIndicator`（框架层，零改动）；未新增任何依赖、未改 layer 边界、未改 event 契约、未动 Rust/生成物。

---

## 2. 问题 / 需求

按裁决与派单，实现 P2 的 4 件事：

1. **卫星实例**：每个 `periods[i>0]` 一个独立 klinecharts 实例 —— 隐藏 K 线（`state:'minimize'+minHeight:0` + `separator:{size:0}`）、**继承基准图指标勾选集合**（各自独立 pane，参数变更走 `overrideIndicator`，不重建 pane）、**每实例一个 `KlineDataFeed`**（period = 该卫星周期，**禁止本地聚合**）、高度取 `heights[period]`。
2. **生命周期**：开关关闭 ⇒ 卫星**完全销毁**（零残留：无订阅、无请求、无实例）；切标的/周期 ⇒ 按新 `(code, period)` 正确重建且不串数据；**任一卫星失败必须可见报错**。
3. **让 P2-A 红测试转绿**，既有测试只允许加强（不得改既有测试文件）。
4. 自测 `vitest run` / `tsc -b` / `scripts/check-tangle.sh`（exit=0）。

---

## 3. 实现方式（关键决策）

### 3.1 基准周期口径（用户裁决 A，02-spec §2.1）

```
basePeriod = (mpState.enabled && mpState.periods.length > 1) ? mpState.periods[0] : state.period
```

- **只有确实存在卫星时**配置才权威；单周期配置下「启用」不改变任何现状行为（P1 已验证的等价性，T11/D4 锁死）。
- 基准 feed 的 `useMemo` deps 用 `basePeriod`（**不放 `enabled`**）⇒ 「启用但无卫星」时 feed 身份不变（不新建实例/订阅/取数）。
- 被配置覆盖时**显式可观测**：`MultiPeriodState.basePeriodOverridden/basePeriodSource`（patch 后自动重算）+ 卫星头 `data-mp-base-period`/`data-mp-base-period-source` + 页面「基准 1m」徽标（`[data-mp-base-override]`）。P5 两步选择器落地时会同时写 `periods[0]` 与 `state.period` 消除该状态。

### 3.2 隐藏 K 线（唯一可行手段）

`KlineChart` 新增 `hideCandles`，在 Effect L（init）**之后**的 Effect H 内执行：

```ts
chart.setPaneOptions({ id: 'candle_pane', state: 'minimize', minHeight: 0 });
chart.setStyles({ separator: { size: 0 } });
```

- 不依赖 `height:0`（`index.esm.js:15421` 守卫静默忽略）；只作用于卫星实例（基准 `hideCandles=false` ⇒ 零调用）。
- 顺序保证：`applyDarkTerminalStyles` 的 `setStyles` 在 Effect L 内，Effect H 后执行 ⇒ **最后一次 `setStyles` 的 `separator.size === 0`**，且后续无其它 `setStyles` 调用（缩放/滚动不回弹）。

### 3.3 指标继承（复用，不重写）

卫星把基准的 `indicators`/`maWindows`/`dcapParams` 原样传给同一个 `KlineChart`：

- MA 走 `addOverlayIndicator`（`removeIndicator({name})` → `createIndicator(spec, true)` → `getIndicators({name})` 非空断言）；
- DCAP/VOL/MACD/KDJ/BOLL 走 `createIndicator(value, true)`（独立 pane）；
- 参数变化走既有 `syncIndicators` 的 `overrideIndicator` 差分，**不重建 pane**（P0.1/P7 契约保持）。

> ⇒ 注册表新增任何指标，多周期自动支持（ADR-022 需求 7）。

### 3.4 数据面

`MultiPeriodSatellite` 自持 `new KlineDataFeed({api, ws, code, period, viewportBars, warmupBars})`：

- `warmupBars = indicators.dcap ? dcapWarmupBars(dcapParams) : 0`（02-spec §5），且**故意不入 feed deps**（dcap 参数保存走 `feed.setWarmupBars` 热更新 + 原地 `resetData`，不重建实例）；卫星的 warmupBars 经 `KlineChart` 的既有热更新路径生效（T8-3 的路径 b：`before` 游标补取）；
- 每实例 `bar:{code}:{period}` 订阅 + 每分钟兜底（既有 `realtimePoll`，`(code,period)` 各自成 key、并发闸 3，零改动）；
- **禁止本地聚合**：请求直接携带实例 period（既有 feed 三条路径；`multiPeriodNoLocalAggregation.test.ts` 5/5 绿）。

### 3.5 生命周期与失败可见

- **零残留**：关闭开关 / 切标的 / 切周期 ⇒ React 卸载卫星（或 feed 身份变化）⇒ `feed.dispose()`（清 WS 订阅、兜底定时器、监听器）+ `dispose(chart)`；
- **失败可见**：`feed.status === 'error'`（初始化取数失败）或 `init()` 失败（新增 `onInitError`，替代原来的静默 `return`）⇒ 渲染 `[data-mp-satellite-error="<period>"]` 横幅 + 「重试」按钮（重挂载该实例 chart，不新建 feed、不改 pane 布局），**不静默降级为单图**；
- **不 remount 基准**：`MultiPeriodChartStack` 返回 `<>{children}{satellites}</>`，children 恒为片段第一个子节点（片段是位置化协调，前置节点会让基准 chart dispose+init，破坏「开关切换不得重建实例」）。

---

## 4. 测试覆盖

### 4.1 P2-A 红测试（既有文件，**未改动**）→ 9/10 转绿

`coder/evidence/169_p2b_satellite/vitest_p2a_satellite.txt`（原始输出）

| 用例 | 结果 |
|---|---|
| T2-1 卫星 candle_pane `state:'minimize'+minHeight:0`、`separator.size=0`、不得依赖 `height:0`、基准不折叠 | ✅ |
| T2-2 卫星高度 = `heights[period]`（180px） | ✅ |
| T2-3 缩放/滚动后不重建、折叠不回弹、separator 仍 0、订阅不增 | ✅ |
| T5-1 基准勾选 `{MA,MACD,KDJ,BOLL,DCAP}` ⇒ 逐卫星非空且集合一致 | ✅ |
| T5-2 所有 `createIndicator` 显式 `isStack=true`、无静默顶掉、MA 经入口 | ✅ |
| T5-3 DCAP 逐实例：precision 5 / zero 参考线 / 数据不足断线 | ✅ |
| T8-1 每实例 1 feed：init=4 / 每周期恰 1 次初始化 HTTP / 4 个 `bar:` 订阅 | ✅ |
| T8-2 每分钟兜底 ≤4、按 (code,period) 各自成 key、并发闸 ≤3 | ❌ **红测试缺陷（互斥断言）— 见 §5** |
| T8-3 warmup 口径：DCAP 显示时每实例都必须 warmup | ✅ |
| T8-4 禁止本地聚合（行为级）：每周期请求命中各自 period | ✅ |

`Test Files 1 failed (1) / Tests 1 failed | 9 passed (10)`；`coder/evidence/169_p2b_satellite/vitest_p2a_satellite.txt`

### 4.2 本轮新增测试（先红后绿，`multiPeriodSatelliteLifecycle.test.tsx`，6/6）

`coder/evidence/169_p2b_satellite/vitest_lifecycle.txt`：`Test Files 1 passed (1) / Tests 6 passed (6)`

| 用例 | 断言 | 覆盖需求 |
|---|---|---|
| **L1-1** | 卫星 1h 取数失败 ⇒ `[data-mp-satellite-error="1h"]` 出现、文案含周期；基准图仍在（init=2，未降级/未崩） | 失败可见（§9/T12 前半） |
| **L2-1** | 关闭开关 ⇒ 卫星 DOM 消失、`bar:518880:1h` 活跃订阅 0（基准仍 1）、静默窗无新增取数/实例 | 关闭零残留（§7.5/T11） |
| **L3-1** | 518880→513310 ⇒ 卫星按 (新 code, 1h) 取数、新 code 订阅建立、旧 code 订阅释放、卫星节点不串 | 生命周期/不串数据（T11） |
| **L4-1** | 4 周期：init=4；初始化 HTTP ≤4 且周期集合恰 `{1m,5m,15m,1h}`；4 个 `bar:` key 各 1 活跃；挂起时兜底**派发 ≤3** 且 `(code,period)` 互异；释放名额后**排队请求继续发起**、最终覆盖 4 周期且每周期 ≤1 次/分钟、`limit=REALTIME_POLL_LIMIT` | **G3 预算护栏**（正确版两段式） |
| **L5-1** | 单周期配置（`enabled=true, periods:['15m']`）⇒ init=1、无卫星节点、仅 1 个活跃订阅、`getKline` 恰 1 次（period=工具栏周期）、静默窗无迟到 | 裁决 A 第 2 条（单周期等价） |
| **L5-2** | 有卫星且基准被覆盖 ⇒ `data-mp-base-period="1m"`、`data-mp-base-period-source="config"`、`[data-mp-base-override]` 徽标存在 | 裁决 A 第 1 条（禁止静默不一致） |

### 4.3 既有测试（未改动）

`coder/evidence/169_p2b_satellite/vitest_full_suite.txt`：`Test Files 1 failed | 71 passed (72)`、`Tests 1 failed | 671 passed (672)`（唯一失败 = §5 的 T8-2 缺陷）。
其中 `multiPeriodClosedEquivalence.test.tsx`（T11 关闭态等价 + D4 开关 UI 级）**6/6 绿**；`multiPeriodNoLocalAggregation.test.ts` 5/5 绿；`feedRealtime*`、`KlineChart*`、`dcap*`、`indicator*` 等既有回归全绿。

---

## 5. 观察项（唯一）：T8-2 是**红测试缺陷（自相矛盾）**，非实现缺陷

`web/src/features/dashboard/multiPeriodSatellite.test.tsx:648-666` 在**同一个 `polls` 数组**上给出两条互斥断言：

```
:654  expect(pollKeys.sort(), '兜底必须覆盖全部 4 个周期（每周期 ≤1 次/分钟）').toEqual(['15m','1h','1m','5m']);   // ⇒ 需 ≥4 个不同周期
:666  expect(polls.length, `并发闸：未 resolve 时最多放行 ${MAX_CONCURRENT_POLLS} 个在途兜底请求`).toBeLessThanOrEqual(3); // ⇒ 长度 ≤3
```

`pollQueries` 只统计**真正到达 `api.getKline`** 的兜底请求（`limit===5 && before===undefined`），而 `realtimePoll.runGated` 的在途闸为 3 ⇒ 4 个 feed 同刻兜底时**第 4 个排队、不调用 `getKline`**（这正是 02-spec §5「并发闸 3、超出排队」的语义，P1-D-3 已独立验收）。去掉闸则 4 个都在途、`:666` 必红 ⇒ **无合法实现可同时满足**。

实测（本轮实现）：`AssertionError: 兜底必须覆盖全部 4 个周期（每周期 ≤1 次/分钟）: expected [ '15m', '1m', '5m' ] to deeply equal [ '15m', '1h', '1m', '5m' ]`（1h 被闸排队）。

**裁决（架构师，2026-09-14）**：判为红测试缺陷，由 **tester 侧改成两段式**（挂起窗口内「派发 ≤3 且 `(code,period)` 互异」；释放一个名额后「排队请求继续发起 ⇒ 最终覆盖 4 周期且每周期 ≤1 次/分钟」）。worker **不改任何既有测试**；等价语义已由本轮 **L4-1** 按正确两段式覆盖并全绿（`coder/evidence/169_p2b_satellite/vitest_lifecycle.txt`）。

---

## 6. 预算计数证据（G3：4 周期 × 1 标的）

| 维度 | 断言值 | 证据 |
|---|---|---|
| 初始化 HTTP | **= 4**（每周期恰 1 次；`limit=viewport_bars=120`，DCAP 未开无 warmup） | T8-1 ✅、L4-1 ✅ |
| WS 订阅 | **= 4**（`bar:518880:{1m,5m,15m,1h}` 各 1 个活跃 handler） | T8-1 ✅、L4-1 ✅ |
| 每分钟兜底 | **≤ 4**（每周期 ≤1 次/分钟；在途 **≤ 3**，第 4 个排队后继续发起、不丢请求） | L4-1 ✅（T8-2 因缺陷见 §5） |
| 实例数 | **= 4**（每实例 1 个 feed；DASHBOARD 单图模式） | T8-1 ✅、L4-1 ✅ |
| 本地聚合 | **0**（每周期直接取后端该周期；代码级门禁 `multiPeriodNoLocalAggregation` 5/5） | ✅ |

## 7. 验证与门禁输出

| 命令 | 结果 | 证据 |
|---|---|---|
| `cd web && ./node_modules/.bin/vitest run src/features/dashboard/multiPeriodSatellite.test.tsx` | 9 passed / 1 failed（T8-2 缺陷） | `coder/evidence/169_p2b_satellite/vitest_p2a_satellite.txt` |
| `cd web && ./node_modules/.bin/vitest run src/features/dashboard/multiPeriodSatelliteLifecycle.test.tsx` | **6 passed (6)**，exit 0 | `coder/evidence/169_p2b_satellite/vitest_lifecycle.txt` |
| `cd web && ./node_modules/.bin/vitest run`（全量） | 71 passed / 1 failed 文件；**671 passed / 672** | `coder/evidence/169_p2b_satellite/vitest_full_suite.txt` |
| `cd web && ./node_modules/.bin/tsc -b` | **exit 0**（无输出） | `coder/evidence/169_p2b_satellite/tsc_b.txt` |
| `./scripts/check-tangle.sh` | **exit 0** —— `[check-tangle] ✅ design 与生成物一致（沙箱重新生成 + 逐字节比对通过；工作区未被修改）` | `coder/evidence/169_p2b_satellite/check_tangle.txt` |

**纪律声明**：未改任何既有测试文件（含 T8-2、D4、T11）；未改 Rust / 生成物（`check-tangle` exit 0 且 `git status` 无 `crates/`、无生成物变更）；**0 写请求**（全程仅本地 vitest/tsc/tangle，未触碰线上）；**未重启线上**（PID 3112540 未动）；**未 git add / commit / stash**（`git diff --cached` 为空 ⇒ 无暂存文件）；未在仓库内跑 entangled tangle（`check-tangle.sh` 为沙箱校验，工作区未被修改）。

**观察项 2（与本轮无关的既有 flake）**：全量套件第二次运行时 `src/features/strategies/StrategyEditorPage.test.tsx` 有 1 例偶发失败（`expected '' to contain 'v2 draft 调整'`），单跑该文件 **17/17 绿**，与多周期模块无交集（未在失败重现中出现于多周期文件）；本轮最终证据（`vitest_full_suite.txt`）为 `1 failed | 671 passed`（仅 T8-2）。

**未证伪项的诚实标注**：G4 像素级渲染取证（真身 klinecharts 画布采样）本轮**未做**（按 `03-test-plan.md` 的 G4 前置声明归阶段 3 的独立验收）；多实例内存/帧率量级未测；本轮高度仅**渲染** `heights[period]`（基准与卫星），拖拽与持久化属 P5。

## 8. 与后续期的接口（供 P3/P5/P6 引用）

- P3：`MultiPeriodSatellite` 目前 `onManualZoom={() => {}}`（跨图同步未落地，卫星手动缩放不写回全局跟随态）；同步原语接入点 = 容器持有各实例 chart。
- P5：卫星高度已按 `heights[period]` 渲染（基准为 `heights[basePeriod]`）；拖拽 + 防抖持久化 + 两步选择器（同时写 `periods[0]` 与 `state.period`，消除 `basePeriodOverridden`）。
- P6 文档：需写明「基准周期只在存在卫星时由 `periods[0]` 决定（02-spec §2.1）」「单周期配置与关闭态逐字节等价」「预算 ×N（≤4）」「G4 禁用图表导出」。
