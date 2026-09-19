# P5b 交付报告 —— 结果页时间窗状态机 / 时间轴重建 / 持仓比率视图 / 跳转接线

**报告文件位置**：`coder/evidence/20260920_adr027_p5b_frontend_window/report.md`

**完成判词（前置）**：
**窗口状态机 完成** ｜ **KlineChart 回调 完成** ｜ **跳转断言 完成** ｜ **mapLineByTs 完成** ｜ **持仓比率视图 完成** ｜ **前端检查与单测 绿**
（`npx tsc -b` = **0 error**；`npx vitest run` = **99 文件 / 961 用例全绿**，其中本波新增 **4 文件 / 32 用例**；**Rust 零改动**）

---

## 0. 范围与纪律

- 车道：**前端 `web/src` 唯一**。`git diff --name-only` 中**无任何 `crates/`、`migrations/`、`*.rs`** 改动；
  仓库里 `crates/*` 的已暂存条目是 **P1a/P1b/P2/P3 其他车道的既有内容**（与 P5a 报告 §0 同述），非本波产物。
- 依赖方向：窗口**图表面原语**放 `features/dashboard/klineWindowOps.ts`（图表层），
  **窗口状态机**放 `features/workbench/resultWindow.ts` + `useResultWindow.ts`（结果页层）
  ⇒ 依赖恒为 `workbench → dashboard`（workbench 本已 import `KlineChart`），**未倒置**。

---

## 1. 逐项改动

### 1.1 页面级共享窗口事实源（ADR-028 D2 / 02-spec §9.1–9.3、§9.6–9.8）

**新增 `web/src/features/workbench/resultWindow.ts`（纯函数层，可单测）**

| 项 | 实现 |
|---|---|
| 事实源 | `ResultWindowState { from_ts, to_ts, span_bars, source, rev }`；`source ∈ {'kline','jump','reset'}`；**时间单位统一为 Unix 秒**（与 `/curve?from_ts=`、`RoundTrip.open_ts`、`RoundTripFill.ts` 同源） |
| 三个写入者 | ① `kline`：`readVisibleRangeTs(chart)`（`getVisibleRange()` 索引 → 经 `getDataList()` 转 ts，见 §1.3）② `jump`：`roundTripWindow()`（回合区间 ±2 根）与 `centeredWindow()`（目标 bar 居中，默认 120 根）③ `reset`：`pushHistory`/`popHistory`（历史栈上限 **20 步**） |
| 节流 | `throttleLatest(fn, 200)` —— **尾沿节流**：节流窗内「立即一次 + 尾沿最后一次」，最后一次胜出（§9.7） |
| 防乱序 | `isStaleResponse(respRev, latestIssuedRev)`：落后 rev 的响应**丢弃且不回写、不动加载态** |
| 回声抑制 | ① 图内：`KlineChart` 的 `programmaticScroll` 标志（复用 F19 既有模式）② 图外：`useResultWindow` 的 `suppressUntilRef`（程序化写窗后 ~400ms 抑制窗内忽略 `kline` 写窗） |
| 生命周期 | 换 run ⇒ `runId` effect 重置为全区间 + 清历史 + 清错误；切 Tab ⇒ 保留（状态在 `ResultView` 之上，不随 Tab 卸载）；「全览」⇒ `window = null`（= 全区间，见下） |
| 无窗口态 | `window === null` 表示「全区间」：此态下曲线按**既有全区间**取数（**零回归**），视图 x 定义域回退 `[run.from_ts, run.to_ts]` |

**新增 `web/src/features/workbench/useResultWindow.ts`（React 承载）**
- 暴露 `window / domain / command / applyError / applying / onApplied / applyKlineRange / jumpTo / reset / back / canBack / historyDepth / barSeconds`。
- `jumpTo` 从 `JumpTarget` 取 **ts 原值**（L1 = `open_ts`/`close_ts`；L2 = `ts`），**不做 ts↔bar_index 反算**（沿用 P5a「禁复算」纪律）；
  `Open` 回合（`close_ts = null`）窗口退化到开仓点，不造 close。

### 1.2 结果页接线（`ResultView.tsx`）

- 新增窗口控制条 `wb-window-bar`：`[全览]`（`wb-window-reset`）/ `[回退]`（`wb-window-back`，`disabled = !canBack`）+
  `wb-window-state`（`窗口 [from, to] · N 根 · 来源 {source} · rev {rev}` 或「全区间（未显式写窗）」）+
  `wb-window-applying`（跳转中…）+ `wb-window-apply-error`（`role="alert"`，**跳转失败必须显式报错**）+ `wb-window-history`（可回退步数/上限 20）。
- `KlineResultChart` 传入 `onVisibleRangeChange={win.applyKlineRange}` / `windowCommand={win.command}` / `onWindowApplied={win.onApplied}`。
- `RoundTripsTable` 的 `onJump` 改为 `handleJump` = **先写窗口状态机**，再向父层派发既有 `onJump`（不破坏 P5a 预留的出口）。
- **加载态与失败态（§9.8）**：`wb-window-load-note` 三态显式 ——
  「窗口加载中（共享 ~200ms 节流，以最后一次为准）」/「窗口取数失败：…；当前显示的是**上一窗口数据**（from … 到 …，非当前窗口）」/「窗口已应用：[from, to] rev N」。
- 曲线视图全部带上共享窗口定义域：`AggregateScoreChart domain={win.domain}` / `EquityDrawdownChart domain={win.domain}` / 新增 `PositionRatioChart domain={win.domain}`。
  **`ComparePanel` 未参与窗口联动（保持原样）**。

### 1.3 KlineChart 可选回调 + 程序化写窗 + 断言（ADR-028 D2/D4，02-spec §7）

**新增 `web/src/features/dashboard/klineWindowOps.ts`**（图表层原语；用 `@/test/syncChartStub` 可单测）
- `readVisibleRangeTs(chart)`：`getVisibleRange()`（索引空间）+ `getDataList()` → `{from_idx, to_idx, from_ts, to_ts}`；
  **毫秒→秒只在 `CHART_TS_MS` 一处转换**（klinecharts 是 ms，窗口事实源是 s）；无数据 / NaN 视口 ⇒ `null`（**不猜**）。
- `applyWindowOps(chart, cmd, limit)`：① `setBarSpace(clamp(round(width/span_bars), limit))` → **读回 `getBarSpace().bar` 校验**（越界被引擎静默 return ⇒ `ok:false` + 报出 `barSpaceLimit min/max` 原文）② 以**读回的实际可见根数**用 `scrollToDataIndex` 把目标 bar **居中**（不用 `scrollToTimestamp`：真身落点恒距右缘 2 根，F19）③ 读回窗口校验：非 NaN、目标在窗内、居中误差 ≤1 根（数据边缘夹取时豁免居中判据）。所有失败路径都返回**显式 `error`**。

**`KlineChart.tsx` 新增 3 个【可选】prop**
```ts
onVisibleRangeChange?(r: { from_ts: number; to_ts: number; from_idx: number; to_idx: number }): void;  // 02-spec §7 原文
windowCommand?: WindowCommand | null;   // 本波新增（程序化写窗）
onWindowApplied?: (r: WindowApplyResult) => void;  // 本波新增（写窗回执/断言结果）
```
- **不传 `onVisibleRangeChange` ⇒ 一条订阅都不发**（`subscribeAction('onVisibleRangeChange')` 只在 prop 非空时执行）
  ⇒ 既有调用方（看板基准 / 宫格 / 多周期基准与卫星 / 关闭态）**订阅面与渲染不变**（F8 回归用例断言 `__listenerCount('onVisibleRangeChange') === 0` 且 `onZoom`/`onScroll` 仍为 1）。
- 不传 `windowCommand` ⇒ Effect K 一条写语句都不执行（回归用例断言 `onWindowApplied` 未被调用、无 `scrollToDataIndex`）。
- 写窗期间置 `programmaticScroll` + `syncRegistry.beginProgrammatic()` ⇒ 引擎同步派发的 `onZoom/onScroll/onVisibleRangeChange` **被抑制**。

**`KlineResultChart.tsx`**：新增导出 `RESULT_BAR_SPACE_LIMIT = { min: 1, max: 400 }`（**仅结果页实例**；看板/宫格一律不传 ⇒ ADR-020 严格不泄漏），并把三个可选 prop 透传给 `KlineChart`。

### 1.4 时间轴重建（ADR-028 D2.1，F6）

- **新增 `mapLineByTs(pts, domainFrom, domainTo, min, max, w, h, pad)`**（`features/backtest/chartUtils.ts`，经 `workbench/chartUtils.ts` 再导出）：
  x = `pad + ((ts − domainFrom)/(domainTo − domainFrom)) × (width − 2·pad)`；**定义域 = 共享窗口**（禁止数据自身 min/max）；退化定义域 ⇒ 全部 x = pad（不除零）；定义域外**不钳位**（防掩盖取数口径错误）。
- **`mapLine` 语义一字未改**（3 个既有调用点：`AggregateScoreChart` / `EquityDrawdownChart` / `ComparePanel`），回归用例显式对比二者行为差异。
- **各曲线按窗口取数**（§9.7「不新增批量端点」）：`useRunSeries({..., window})` 新增**独立窗口 effect**，对 4 个既有 per-kind 端点并发重取
  `{ kind: 'per_bar' | 'net_value' | 'drawdown' | 'position', k, from_ts, to_ts }`；`rev` 落后即丢弃；失败 ⇒ `windowError` 且**不**更新 `windowApplied`（⇒ UI 可标注「显示的是上一窗口数据」）。
  首屏（无窗口）仍走原 4 路全区间取数（新增 `position` 一路）⇒ 向后兼容、零回归。

### 1.5 持仓比率视图（ADR-028 D1 / 02-spec §4.2，F10）

**新增 `web/src/features/workbench/PositionRatioChart.tsx`**（与净值图同风格：SVG 折线 + 叠加读数）
- 曲线数据 = `/curve?kind=position`（`WorkbenchPositionPoint`），x 定义域 = 共享窗口（`mapLineByTs`）；
  抽样标注 `downsampled`/`original_bars` 沿用 ADR-024 D10 模式。
- 同屏读数：`wb-last-position-ratio`（`position_ratio xx%`）、`wb-last-cash-ratio`（`1 − position_ratio`）、
  `wb-last-nav`（`nav X（= 持仓市值 Y + 现金 Z）`，逐点恒等式可见）。
- **口径消歧三件套（强制，标签各含分母）** `data-testid="wb-position-basis"`：
  `wb-basis-position-ratio`（分母 = **时点净值**）、`wb-basis-cash-ratio`（分母 = **时点净值**）、
  `wb-basis-deployed`（分母 = **初始资金**，区间**累计**敞口）、`wb-basis-cash-consumed`（分母 = **初始资金**，区间**累计**资金占用含佣金），
  并注明三者**不同物、不得互相解释**；审计未加载/未记录时显式写「审计未加载 / 未记录」（**不把缺失读成 0%**）。

### 1.6 跳转接线（ADR-028 D4，F9）

- `JumpTarget` 扩为携带 ts：L1 `{ open_bar, close_bar, open_ts, close_ts }` / L2 `{ bar_index, ts }`（**接口原值直传**）。
- L1 `[跳转]` ⇒ 窗口 = `[open_ts − 2·bar, close_ts + 2·bar]`；L2 `[跳转]` ⇒ 目标 bar **居中的 120 根**（`DEFAULT_L2_JUMP_SPAN_BARS`，可配）。
- **断言 + 显式报错**：写窗回执经 `onWindowApplied` 回到 `useResultWindow.onApplied`；`ok=false` ⇒ `wb-window-apply-error`（`role="alert"`）
  文案含 `setBarSpace(N) 未生效（读回 M；barSpaceLimit min=… max=…）⇒ 跳转被引擎静默吞掉`。**不存在静默无反应路径**（F18 零容忍）。
- 目标 bar **未加载**的处理：本 ADR 的跳转锚点是 **L1/L2 的 ts 原值**（非索引反算），而结果页 K 线区间 = run `[from_ts, to_ts]`
  且回合/成交 ts 必落在该区间内，故正常路径无需额外取数；`applyWindowOps` 对 `dataList` 为空/未布局已给**显式失败**（不静默）。

---

## 2. 测试与证据

### 2.1 新增用例（4 文件 / 32 例，全部先实现后验证 —— 见 §2.4 诚实披露）

| 文件 | 覆盖 | 例数 |
|---|---|---|
| `web/src/features/workbench/resultWindow.test.ts`（**新增**） | **F6** 窗口构造/归一/生命周期；**F7** 历史栈 20、rev 丢旧、同窗不重取、节流（≤2 次且最后一次胜出）、flush；**F8** 索引→ts（秒）与 null 语义；**F9** L2 居中（中心误差 ≤1）、L1 区间、**越界静默失败捕获**、数据未加载/未布局/能力缺失显式失败、rev 回传 | 17 |
| `web/src/features/dashboard/KlineChartVisibleRange.test.tsx`（**新增**） | **F8** 传回调 ⇒ `{from_ts,to_ts,from_idx,to_idx}`（秒）；**不传 ⇒ 不订阅、零写操作（回归）**；**F9** 回声抑制（程序化写窗期间的 `onVisibleRangeChange` 不回写）；写窗越界 ⇒ 回执显式报错；不传 `windowCommand` ⇒ 零影响 | 5 |
| `web/src/features/workbench/resultWindowSync.test.tsx`（**新增**） | **F10** 持仓比率渲染 + 三口径标签各含分母 + 空态 + 结果页同屏；**F7/F9** K 线交互写窗（source=kline）、L1 跳转（source=jump + 落到底层 `scrollToDataIndex` + 无 applyError）、全览/历史回退 | 6 |
| `web/src/features/workbench/chartUtils.test.ts`（**+4 例**） | **F6** `mapLineByTs` 线性/定义域/退化/与 `mapLine` 的语义差异回归 | 4 |

### 2.2 命令与原始输出（证据落盘同目录）

```
cd web && npx tsc -b                        # exit=0（0 error）
cd web && npx vitest run                    # 99 files / 961 tests passed
cd web && npx vitest run <4 个新文件>        # 4 files / 35 tests passed
```

| 证据文件 | 内容 |
|---|---|
| `10_red_mutation_p5b.txt` | **F9 断言非空证明**（MUTATION-CHECK）：临时删掉 `applyWindowOps` 的读回断言 ⇒ 用例 **红**（`expected true to be false` @ `resultWindow.test.ts:200`）；恢复后 17/17 绿，`git diff` 为空 |
| `20_green_tsc.txt` | `npx tsc -b`（exit=0） |
| `21_green_vitest_p5b.txt` | 本波 4 个主载体：`4 passed / 35 passed` |
| `22_green_vitest_all.txt` | 全量 `npx vitest run`：`99 passed / 961 passed` |

### 2.3 回归（既有调用方零影响）

- 全量 **929 条既有用例**在改动后**逐条通过**（`22_green_vitest_all.txt` 中 961 = 929 + 32），含 `ResultView.test.tsx`、`KlineChart.test.tsx`、
  `chartSyncGroup/syncCoverage/…` 等对 `subscribeAction`/`barSpace` 敏感的全部套件 ⇒ F8「不传 prop 逐字节不变」有真实护栏。

### 2.4 TDD 诚实披露

- 本波全部新增用例为「**实现后编写并运行**」（首次即绿），**未**取得实现前的红判词 —— 违反了「先红后绿」的时序纪律，**如实登记**。
- 为补偿「空断言」风险，对最关键的 F9 静默失败路径做了 **mutation-check 反向证明**（`10_red_mutation_p5b.txt`）：删掉断言 ⇒ 用例确实红。
  其余用例（`mapLineByTs` 定义域、节流计数、回声抑制）为契约锁定型，未逐条做变异证明。

---

## 3. E 段（E1–E4）可执行步骤与前置条件 —— **本波未运行，禁止声称通过**

**前置条件（缺一不可）**：① 真实后端（非 `VITE_API_MOCK`）+ PostgreSQL（`docker-compose.yml`）已起；
② 已按 ADR-027 批次跑过至少一个 `chunked_v1` run，且该 run 有 ≥1 条 `Closed` 回合与 ≥1 笔 L2 成交；
③ 浏览器环境（Playwright 已配置：`web/playwright.config.ts`，命令 `npm run e2e`）；④ 后端 `/curve?kind=position` 已返回点。

```bash
cd web && npm run e2e -- e2e/p5b-window-sync.e2e.ts   # 需先新增该载体（见下）
```

| ID | 可执行步骤 | 判据（断言点） |
|---|---|---|
| **E1** | 打开工作台 → 选中该 run → 交易明细 Tab → 点 L1 行 `[跳转]`（`wb-rt-jump-{rt_seq}`） | 读 `chart.getVisibleRange()` → 经 `getDataList()` 转 ts，与 `roundTrip.open_ts/close_ts` 比较：覆盖区间相等（±1 根）+ `wb-window-state` 含 `来源 jump` + 无 `wb-window-apply-error`；截图 `artifacts/e1-l1-jump.png` |
| **E2** | 展开该回合 `[明细]`（`wb-rt-detail-{rt_seq}`）→ 点某笔 L2 `[跳转]`（`wb-l2-jump-{rt_seq}-{i}`） | 窗口中心 bar 索引 == 该笔 `bar_index`（±1 根）；`wb-window-state` 的 `span_bars == 120`；`wb-window-applying` 最终消失且无 `applyError`；截图 `artifacts/e2-l2-jump.png` |
| **E3** | 在 K 线图上连续 pan（拖动 ≥5 次）+ zoom（滚轮 ≥5 次），稳定后采集 | 各 SVG 视图的 x 定义域 == 共享窗口（读 `wb-window-state` 的 `[from,to]` 与 `equity-line`/`position-line` 折线点 x：端点应 = `pad` / `width−pad`）；K 线可见 bar ts 集合 == 曲线收到的窗口覆盖集合（±1 根）；`rev` 单调递增 |
| **E4** | 先做 3 次跳转 → 点 `[全览]`（`wb-window-reset`）→ 连点 `[回退]`（`wb-window-back`）3 次 | 窗口依次恢复正确（`wb-window-state` 与历史深度一致）；`wb-window-history` ≤ 20；全览期间 `/curve` 请求次数 ≤ 节流允许值（≈ 每次窗口变化 ≤1 批，无请求风暴） |

> 说明：本波**未**新增 `e2e/p5b-window-sync.e2e.ts`（jest 层已覆盖同判据的可测部分；真渲染载体属 P6/E 段，需真后端与浏览器）。**禁止**把上表当作「已通过」。

---

## 4. 未做项 / 残留风险 / 需评审点

### 4.1 未做（明确登记）

1. **F11 sim-live 跨标的跳转**（目标成交属另一标的时切主图 + 显式提示）：未实现 —— 需 sim-live 运行中 L1/L2 读路由与「切主图标的」能力（P5a 已列为未做项）。
2. **E1–E4 真渲染**：未运行（缺真后端/浏览器）；仅给出可执行步骤与判据（§3）。
3. **「全览」的像素级全区间**：引擎 `barSpace` 有 `min` 下限（结果页 `{min:1,max:400}`），当全区间根数 > 可视槽位时「全览」只能到引擎允许的最密档（`barSpace = min`），**不承诺**一屏装下全部 bar（已如实反映在 `span_bars` 与读数上）。
4. **`useResultWindow` 的 `applying` 超时兜底**：若 `onWindowApplied` 永不到达（图实例缺能力即会立刻到达 error 回执），`applying` 依赖 400ms 抑制窗而非显式超时清态（当前所有已知失败路径都会即时回执）。

### 4.2 需架构师追认（本波唯一新增接口项）

- `KlineChartProps` 除 02-spec §7 明列的 `onVisibleRangeChange` 外，**新增了两个可选 prop**：`windowCommand` 与 `onWindowApplied`。
  理由：D4 要求「程序化写窗 + 断言成功 + 失败显式报错」，而结果页 K 线实例的窗口写通道在既有接口中不存在（结果页无 `ChartSyncGroup` provider，F12）。
  **两者皆可选**，不传时零行为（已有回归用例）；未引入新依赖、未改任何既有 prop 语义。**请裁决是否接受，或指定替代通道（如 forwardRef 命令式句柄 / 结果页挂 `ChartSyncProvider`）。**
- `features/dashboard/klineWindowOps.ts` 的**时间单位契约**（`from_ts/to_ts` = Unix **秒**，图内 ms→s 只在 `CHART_TS_MS` 处转换一次）是本波为对齐 `/curve?from_ts=` 口径所做的**显式约定**，请确认（02-spec §7 未写明单位）。

### 4.3 非本波产物（未暂存）

`design/17-trade-detail-layering/02-spec.md` 与 `design/01-architecture/adr/ADR-023-…md` 在工作区有**未暂存**改动（本次 `position` kind / §9 交互契约的规格增补），非本波编辑产物，**未纳入本次 `git add`**（留给规格车道）。

### 4.4 分层与 DRY 对齐

- 取数**仍唯一入口** `useRunSeries`（窗口曲线沿用同一 hook，未新增第二处 fetch）⇒ ADR-024 P6 硬约束保持。
- `mapLine` 未动（3 个调用点原样）；`ComparePanel` 不参与窗口联动。
- 未引入新依赖 / 未改事件契约 / 未触碰 Rust / **未 commit**（仅 `git add`）。

---

## 5. 暂存内容（本波）

```
web/src/features/backtest/chartUtils.ts                     (M)  + mapLineByTs
web/src/features/dashboard/KlineChart.tsx                   (M)  + 3 个可选 prop + Effect V/K
web/src/features/dashboard/klineWindowOps.ts                (A)  窗口读/写原语 + 断言
web/src/features/dashboard/KlineChartVisibleRange.test.tsx  (A)  测试
web/src/features/workbench/AggregateScoreChart.tsx          (M)  + 可选 domain
web/src/features/workbench/EquityDrawdownChart.tsx          (M)  + 可选 domain
web/src/features/workbench/PositionRatioChart.tsx           (A)  持仓比率视图
web/src/features/workbench/KlineResultChart.tsx             (M)  透传 3 prop + barSpaceLimit 放宽
web/src/features/workbench/ResultView.tsx                   (M)  窗口控制条 + 接线 + 加载/失败标注
web/src/features/workbench/RoundTripsTable.tsx              (M)  JumpTarget 携带 ts
web/src/features/workbench/chartUtils.ts                    (M)  再导出 mapLineByTs
web/src/features/workbench/chartUtils.test.ts               (M)  +4 例
web/src/features/workbench/resultWindow.ts                  (A)  窗口状态机（纯函数）
web/src/features/workbench/resultWindow.test.ts             (A)  测试
web/src/features/workbench/resultWindowSync.test.tsx        (A)  集成测试
web/src/features/workbench/useResultWindow.ts               (A)  状态机 React 承载
web/src/features/workbench/useRunSeries.ts                  (M)  窗口曲线取数 + position + rev 丢旧
```

**本报告文件位置**：`coder/evidence/20260920_adr027_p5b_frontend_window/report.md`
