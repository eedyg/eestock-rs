# 执行报告 053 — 「切换 period / stock 重置指标视图布局」诊断（复现 / 定位 / 可行性 / 回归面 / 红测试）

- **本文件位置（self-location）**：`tester/test/053_period_stock_switch_layout_diagnosis_execution.md`
- **测试设计**：`tester/design/017_period_stock_switch_layout_red_test_design.md`（新增红测试设计）
- **证据目录**：`tester/evidence/053/`（`harness/` 探针源 + `json/` 原始输出 + `logs/` 红测试与门禁原始输出 + `shots/` 4 张截图）
- **执行时间**：2026-09-14 09:09 ~ 09:17 (+0800)（`date -u` 01:09 ~ 01:17）
- **仓库根 / commit**：`/home/eestock/workspace/git/eestock/eestock-rs`，**HEAD = `ece1d9d`**（`git diff --cached --name-only` 为空；本车道仅新增 1 个测试文件 + 报告/设计/证据，无 tracked 改动）
- **被测形态**：临时构建（`/tmp/diag53/dist`，root = 仓库 `web/`）+ 临时预览 `127.0.0.1:18097`；`/api`、`/ws` 反向代理到**线上只读** `8081`（**只发 GET**）；真实 `klinecharts@10.0.3`（`harness/kc-spy.ts` 仅包裹实例方法以暴露 `window.__ACC__{inits,log,charts}`）
- **纪律**：未 kill/重启/改配置 8081/8082（PID 2102695 全程未动）；未改线上 `web/dist`；未 `git add/commit/stash`；仓库内未跑 tangle；未改 `design/14-dcap-indicator` 的 `file=` 块；DB 未连；**无任何非 GET 请求、无任何 `PUT`**（4 次探针 `nonGetOther=[]`、`putIntercepted=0/[]`）；无崩溃、无 core dump（4 次探针 `pageErrors=[]`）
- **本报告性质**：**只取证，不分析失败原因之外的因果推断不做修复**；修复提案只写「改哪里、怎么改、副作用面」，**未落地任何代码改动**

> 结论速览：**缺陷复现 ✅（VOL 199→100、DCAP 140→100，主图吸收 +139；pane id 全换；`init` +1）** / **触发点 = `[feed]` 建图 effect 重跑（整图 remount），feed 身份由 `state.selected / state.period / viewportBars` 驱动 ✅** / **首选「不 remount」实测可行 ✅（同一实例 setSymbol+setPeriod+setDataLoader+resetData：pane id/高度逐值不变、数据换新）** / **备选「回放 setPaneOptions」也实测可行但固有缺陷明确 ✅** / **回归面逐条结论 ✅** / **红测试 2 红 1 绿 ✅** / **最小修复提案 + 副作用面 ✅**
> 末行 **VERDICT: DIAGNOSED**

---

## 1. 缺陷复现（真实渲染，量化证据）

### 1.1 场景 A —— 切 **period**（15m → 1h）：拖高 VOL / DCAP 后切换

操作链：页面加载（默认 15m、DCAP 默认关）→ 点开 DCAP（独立副图，默认高 100）→ 鼠标拖第一条分隔线（candle↔VOL）**上移 150px**、拖第二条（VOL↔DCAP）**上移 40px** → 点工具栏 `1h`。

| pane | 切换前（拖高后） | 切换后 | Δ | pane id |
|---|---|---|---|---|
| MA（`candle_pane`，弹性） | DOM **357px** | DOM **496px** | **+139** | `candle_pane`（恒定） |
| VOL | DOM **199px** | DOM **100px** | **−99** | `…8255353_3` → `…8263816_3`（更换） |
| DCAP | DOM **140px** | DOM **100px** | **−40** | `…8259416_2` → `…8263816_6`（更换） |

- **量化结论**：拖高的 VOL/DCAP 高度**双双被重置为布局默认 `100px`**（合计 139px 回灌给主图 candle），pane id 全部更换 ⇒ **指标视图 layout 大小被重置**。
- **`window.__ACC__.inits`：1 → 2**（整图 remount）。
- **churn burst 开头 = 建图特征**：`setDataLoader → setSymbol → setPeriod → createIndicator×3`（新图从零建指标，无 remove）——即**整图重建**而非原地同步。
- **数据确实重置**：首根 ts `2026-08-28T05:15Z`（15m）→ `2026-07-30T06:00Z`（1h）。
- 截图：`evidence/053/shots/P1-dragged-15m.png`（拖高后）/ `P2-after-period-switch-1h.png`（切换后副图明显缩回）。
- 原始 JSON：`evidence/053/json/probe_period.json`（`scenarios.A_*`、`A.*`、`A.logBurst`）。

### 1.2 场景 B —— 切 **stock**（518880 → 161226，period=15m）：拖高后切换

| pane | 切换前 | 切换后 | Δ | pane id |
|---|---|---|---|---|
| MA（`candle_pane`） | DOM **357px** | DOM **496px** | **+139** | 恒定 |
| VOL | DOM **199px** | DOM **100px** | **−99** | 更换（`…8266865_4` → `…8271748_4`） |
| DCAP | DOM **140px** | DOM **100px** | **−40** | 更换（`…8266866_2` → `…8271748_7`） |

- `__ACC__.inits`：3 → 4；burst 同样为 `setDataLoader/setSymbol/setPeriod/createIndicator×3`。
- **数据确实重置**：末根 close `8.943`（518880）→ `1.913`（161226）；首 3 根 close `9.416…` → `1.881/1.884/1.884`。
- 截图：`P3-dragged-before-stock.png` / `P4-after-stock-switch-161226.png`。

### 1.3 场景 A′ —— 切 **period**（1m → 15m）复验（另一组周期）

- `inits` 2 → 3；VOL 199→100、DCAP 140→100、MA 357→496（同上）。
- 取数 URL：`/api/kline?code=518880&period=1m&limit=188` → `/api/kline?code=518880&period=15m&limit=188`（数据源切换）。
- 原始 JSON：`evidence/053/json/probe_extra.json`。

### 1.4 场景 V —— **viewportBars（配置）变化**也触发同一缺陷（同类第 3 个触发面）

在浏览器侧把 `GET /api/config/kline` 的响应受控改为「首次 120、之后 200」，再派发 `window.focus`（触发 `DashboardPage` 的 focus 重读）：

| | 切换前 | 重读后 |
|---|---|---|
| `inits` | 1 | **2** |
| VOL / DCAP DOM | 199 / 140 | **100 / 100** |
| MA DOM | 357 | **496** |
| `data-viewport-fit` | `{"bars":120,"space":11,...}` | `{"bars":200,"space":6,...}` |

⇒ **改「默认K线根数」配置（含 focus 重读）同样重建 feed ⇒ 整图 remount ⇒ 布局重置**（与 051 的 dcap 保存路径同源）。原始 JSON：`evidence/053/json/probe_viewport.json`。

---

## 2. 触发点与依赖定位

### 2.1 结论：**路径 = `KlineChart` 的 `[feed]` 建图 effect 重跑（整图 dispose+init）**

三条独立证据：

1. **`__ACC__.inits` 每次切换 +1**（A：1→2；B：3→4；A′：2→3；V：1→2）——`init()` **只**在建图 effect（`web/src/features/dashboard/KlineChart.tsx:349`）里被调用；
2. **burst 以 `setDataLoader → setSymbol → setPeriod → createIndicator…` 开头**（= 建图特征；`probe_period.json → A.logBurst`），而**非**原地同步（原地只会有 `overrideIndicator` / `resetData` / `setSymbol` / `setPeriod`，无 `setDataLoader` 重建 loader）；
3. **pane id 全换**（`indicator_pane_<ts>_N` 时间戳前缀 = 新建图时刻）——只有新图才会产生新 id。

### 2.2 是哪几个依赖导致 feed 身份变化

`DashboardPage.tsx:225-238`：

```ts
const feed = useMemo(
  () => state.selected ? new KlineDataFeed({ api, ws, code: state.selected, period: state.period, viewportBars, warmupBars: dcapWarmup }) : null,
  [api, ws, state.selected, state.period, viewportBars],
);
```

| useMemo 依赖 | 是否可变 | 变化时是否 remount | 触发场景 |
|---|---|---|---|
| `state.selected`（标的 code） | ✅ | ✅ | **切 stock** |
| `state.period`（周期） | ✅ | ✅ | **切 period** |
| `viewportBars`（配置根数） | ✅ | ✅ | 改「默认K线根数」配置 / **focus·visibility 重读**（§1.4 实测） |
| `api` / `ws`（props，`defaultApi/defaultWs`） | 构造期稳定 | 否（除非父级换实现） | — |
| `dcapWarmup` | ✅（但**故意不入 deps**） | **否**（已由 7949c0b 断开，走 `feed.setWarmupBars` 热更新） | — |

`KlineChart.tsx:349-450`：建图 effect 的依赖是 `[feed]`（`}, [feed]);` @ line 450）⇒ **只要 feed 对象身份变，就 dispose 旧图 + init 新图**。

### 2.3 remount 时被重置的状态（逐项）

| 状态 | remount 行为 | 证据 |
|---|---|---|
| **pane 高度（拖拽记忆）** | **重置**：新 pane 取布局默认 `height:100` | §1.1/1.2：VOL 199→100、DCAP 140→100 |
| **pane id** | 全部更换 | §1.1/1.2 表 |
| **pane 顺序** | 按 `INDICATOR_DEFS` 重建 ⇒ 回到定义序（用户调整过的顺序丢失） | `syncIndicators` 遍历 `INDICATOR_DEFS` |
| **可见区间 / barSpace** | 重算回 fit（`manualAdjusted` 被置 false ⇒ DataLoader init 的 `onInit → fitBarSpace` 生效） | probe_regress：手动 wheel 后 `bar 12.1 / 可见 103` → 切 period 后 `bar 11 / 可见 114` |
| **`manualAdjusted`** | **重置为 false** | `KlineChart.tsx:354`（`manualAdjusted.current = false`） |
| **`offsetRightDistance`** | 重建为引擎默认（本次观测前后同为 80） | `probe_period.json → A.viewport` |
| **overlay** | 随旧图销毁；新图按 `props.overlays` 重建 | 代码 `KlineChart.tsx:418/437-439`；真实实测：主图无 overlay |
| **WS 订阅** | 旧 `feed.dispose()` → unsubscribe；新 `feed.subscribeRealtime()` → subscribe 新 topic | `probe_period.json → wsFrames`：`unsubscribe bar:518880:15m` → `subscribe bar:518880:1h` |
| **实时 bar 标记 `rt`** | `setRt(null)` + 重新 `markRealtime` | 代码 cleanup |
| **指标「已应用」基线 `appliedRef`** | `new Map()` 重置 ⇒ `syncIndicators` 全部 create | `KlineChart.tsx:407` |

---

## 3. 首选方案「不 remount」可行性实测（同一条 chart 实例原地切换）

在真实 chart 实例上执行（页面上下文，真实引擎）：

```js
chart.setDataLoader(newLoader);                                  // 新 loader（闭包捕获目标 code/period）
chart.setSymbol({ ticker: '161226', pricePrecision: 3, volumePrecision: 0 });
chart.setPeriod({ type: 'hour', span: 1 });
chart.resetData();
```

| 判据 | 实测结果 | 结论 |
|---|---|---|
| pane 高度（VOL 220 / DCAP 170 预设） | 220→220、170→170、MA 306→306（**Δ=0**，±1px 内） | ✅ **天然保持不变** |
| pane id | 前后完全一致（`candle_pane` / `indicator_pane_…_4` / `indicator_pane_…_7`） | ✅ 不变 |
| `__ACC__.inits` | 4 → 4（**不重建图**） | ✅ |
| 数据：根数 | 188（旧 161226/15m）→ **120**（新 161226/1h） | ✅ 换新 |
| 数据：首时间戳 | `1787894100000`（2026-08-28T05:15Z）→ **`1786928400000`（2026-08-17T01:00Z）** | ✅ 换新 |
| 数据：取值 | 新 head3 close `1.881/1.884/1.884`（1h 周期）；对照切 stock 场景末 close `8.943`→`1.913` | ✅ 换新 |
| `getSymbol()` | `{ticker:'161226', pricePrecision:3, volumePrecision:0}` | ✅ |
| `getPeriod()` | `{type:'hour', span:1}` | ✅ |
| **闪烁 / 残留旧数据** | `resetData` 后旧数据（188 根旧 symbol）**保持约 50–150ms**，第一次新 load 回调到达时**原子替换**为 120 根（`_addData('init')` = `_clearData()` + `_dataList = data` + 重绘）；**无空白闪烁**（不 dispose） | ⚠️ **有 <150ms 残留旧数据窗口**（见 §3.2） |
| 取数请求数 | `setDataLoader`/`setSymbol`/`setPeriod`/`resetData` **各触发一次 init load ⇒ 4 次 GET**（见 §3.3） | ⚠️ 需优化 |
| 库依据 | `setSymbol`/`setPeriod`/`setDataLoader` 内部各自 `resetData()`；`resetData` 只 `_processDataLoad('init')`，**不重建图、不动 pane 布局** | `index.esm.js:13410-13434 / 13518-13524 / 13652-13656 / 15253-15261` |

### 3.1 原地切换的原始时间线（`probe_period.json → C_switch.timeline`）

```
pre                     dataLen 188  first 2026-08-28T05:15Z
after-setDataLoader     188
after-setSymbol         188
after-setPeriod         188
after-resetData(sync)   188
t+50                    188
t+150                   120  first 2026-08-17T01:00Z   ← 原子替换
t+400/1000/2000         120
```

### 3.2 残留旧数据窗口的成因

`resetData()` 是**异步**的：它同步调用 `_processDataUnsubscribe()` 与 `_processDataLoad('init')`（后者发起 `getBars`），`_clearData()`/替换 `_dataList` 只发生在 **`getBars` 回调**里（`_addData(data,'init')`）。故在回调到达前，屏上仍是**旧标的/旧周期的 bars**（本次 ≈150ms，取决于网络/DB）。回调到达时一次清空+替换 ⇒ 无「半新半旧」的持续脏态，但有短暂「旧图仍在」窗口。

### 3.3 冗余取数（实现注意项）

由于 `setDataLoader`/`setSymbol`/`setPeriod` 各自内部 `resetData()`，顺序调用会产生最多 **4 次 init load**（本次实测 `klineGetsDuring=4`）。
- **工程上可接受的最小化**：`setDataLoader` 只在 feed 变化时调用，且把 `setSymbol`/`setPeriod` 放在其**之前**；每次隐式 load 都以「新 loader + 新 feed（closure）」取数 ⇒ 最终状态正确，但仍有 3 次重复 GET。
- 若要严格 1 次：需要一个「只响应最后一次 getBars」的代际（generation）门闩，或让 loader 幂等（同一目标并发去重）。**这是修复实现要处理的点，属实现选型**。

---

## 4. 备选方案可行性实测（remount 后回放 `setPaneOptions`）

在 remount 之后、按「指标名 → pane」映射回放记忆高度：

```js
for (const name of ['VOL','DCAP']) {
  const pid = chart.getIndicators({name})[0].paneId;
  chart.setPaneOptions({ id: pid, height: remembered[name] });
}
```

| 判据 | 实测结果 | 结论 |
|---|---|---|
| 恢复后 VOL / DCAP 渲染高度 | 199 / 140（与 remount 前**逐值相等**，Δ=0，±1px 内） | ✅ **可恢复** |
| `setPaneOptions` 生效时序 | **须等一次 layout/绘制**；同一 `page.evaluate` 内同步读 DOM 仍读到 100（`probe_period.json → D_replay.after`），等待 ~800ms 后读到 199/140（`probe_regress.json → replay.afterReplay`） | ⚠️ **时序敏感** |

### 4.1 备选方案的固有缺陷

| 缺陷 | 实测/依据 |
|---|---|
| **pane id 仍会更换**（每次 remount 全新 id） | `probe_regress.json → replay.idsBeforeRemount ≠ idsAfterRemount` |
| **依赖「指标名→pane」映射**：指标停用/重开、同名多 pane、映射缺失时高度丢失或错配 | 代码语义（`syncIndicators` create 顺序 + `getIndicators({name})` 过滤） |
| **顺序漂移**：remount 按 `INDICATOR_DEFS` 重排；若用户曾调整顺序（或指标集合变化），回放无法还原顺序（只能还原高度） | §2.3「pane 顺序」 |
| **视觉闪烁**：remount 会 `dispose` 旧图（容器清空）+ `init` 新图 + 重新取数 ⇒ 一次「白/空 → 数据」闪动；回放只在闪动**之后**改高度 | 结构性（`dispose`/`init`） |
| **回放时机竞态**：回放必须在 `syncIndicators` 建完 pane **之后**；若提前（pane 尚未建）则无效 | §4 表第 2 行 |
| **与 ADR-020 `fitBarSpace` 的冲突** | **无直接冲突**：`fitBarSpace` 只设 `barSpace`（水平），`setPaneOptions` 只设 pane 高度（垂直）；`ResizeObserver` 回调同样只碰 barSpace。但 remount 仍会重置 `manualAdjusted` 并重算 fit（= 现有行为，非新增冲突） | 代码 `barSpaceFit.ts` + `KlineChart.tsx:354` |

⇒ **备选可行但代价更高**（每切一次 period/stock 都闪一次 + 回放时序脆弱）。**首选仍为「不 remount」的原地切换**。

---

## 5. 回归风险面逐条核实

| # | 风险面 | 结论 | 证据 |
|---|---|---|---|
| 1 | **ADR-020：切 period 后可见根数仍 ≈ `viewport_bars`** | **现行（remount）满足**：切 period 把 `manualAdjusted` 重置为 false 并重跑 fit（手动 wheel 后 `bar 12.1/可见 103` → 切换后 `bar 11/可见 114/≈120`）。**改「不 remount」后需显式保持**：若切换时不清 `manualAdjusted`，则用户手动缩放过的会话切周期后**不再回 fit**（实测原地切换 `bar 12.1` 保持不变）；若**不**手动缩放，组件自带 DataLoader 的 `onInit → fitBarSpace` 仍会生效 | `probe_regress.json → zoom`；`probe_extra.json → manual_zoom`；`data-viewport-fit` 属性前后 |
| 2 | **WS 实时：切标的/周期后实时 bar 追加到正确序列（旧订阅清理、followLatest 锁最右）** | **现行满足**：旧 feed `dispose()` 发 `unsubscribe`，新 feed `subscribeRealtime()` 发 `subscribe bar:<code>:<period>`（帧实测）。原地切换方案**必须**同步把 `offRt` 从旧 feed 摘除并挂到新 feed（否则实时 bar 进旧序列）。`scrollToRealTime` 跟随逻辑在切换后需按 `followLatest` 重跑 | `probe_period.json → wsFrames`（sent 序列：`unsub 518880:15m → sub 518880:1h`、`unsub 518880:15m → sub 161226:15m`）；`received=0`（探针期无推送 tick，实时追加未取到活体证据，仅代码+帧证据） |
| 3 | **overlay（开/平仓标记、区间高亮）正确创建/清理** | **主图（看板）不传 overlay**；**工作台 `KlineResultChart` 传**。真实实测：在图上创建 2 个 overlay（`simpleAnnotation`+`simpleTag`）后做**原地切换**，`getOverlays().length` **仍为 2** ⇒ **`resetData` 不清 overlay**，原地切换必须**显式 `removeOverlay()` 旧 overlay 并按新 feed/新数据重建**（否则残留旧 run 的 B/S 标记/价位线） | `probe_regress.json → overlay {before:2, noRemountSwitchAfter:2}`；代码 `KlineChart.tsx:418/437-439` |
| 4 | **DCAP 取数 warmup：切换后 limit 仍 = `viewport_bars + (n_l + m − 1)`；关闭时 = `viewport_bars`** | **现行口径满足**：DCAP **关** → `?limit=120`；DCAP **开**（运行时）→ 增量补取 `?before=…&limit=68`（端态窗口 188 = 120 + (66+3−1)，线上 `n_l=66,m=3`）。**原地切换方案必须保留**：新馈给的 warmup（`setWarmupBars`）在新标的/周期上同样生效，否则 DCAP 副图最左断线 | `probe_regress.json → warmup {observedOff:120, observedOn:68, expectedOn:188}`；`probe_extra.json → klineUrls`（切 1m/15m 时 `limit=188`） |
| 5 | **另一消费者 `web/src/features/workbench/KlineResultChart.tsx`** | **结构上同样受影响**：它 `useMemo` new `ScopedKlineFeed({code:run.symbol, period})`，依赖 `[api, run, period]`；切 run（`run` 变）⇒ feed 变 ⇒ `KlineChart` 整图 remount ⇒ 布局重置。**但影响低**：该图是只读嵌入图、用户不会拖拽其 pane、且每次切 run 本就期望「全新图」。若统一改「不 remount」，它自动受益且需要保证 overlay（B/S 标记）在新 run 上**先 remove 再重建**（见 #3） | 代码 `KlineResultChart.tsx`（feed useMemo + `overlays` prop） |

---

## 6. 红测试：位置与当前红状态

- **新增文件**：`web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`（1 文件 / 3 用例）
  - T-1（**红**）`【红】切换 period：既有 pane 高度 ±1px 不变、pane id 不变、无 create/remove；数据确实换成新周期`
  - T-2（**红**）`【红】切换 stock：既有 pane 高度 ±1px 不变、pane id 不变、无 create/remove；数据确实换成新标的`
  - T-3（**守卫，绿**）`【防回归】同一 feed 的 rerender（如指标/参数变化）不得重建 chart`
- **当前红状态（原始输出 `evidence/053/logs/red-test-run.txt`）**：
  ```
  × 【红】切换 period… → AssertionError: 切 period 不得 dispose+init 重建 chart（否则 pane 全部回默认高度）: expected 2 to be 1
  × 【红】切换 stock…  → AssertionError: 切 stock 不得 dispose+init 重建 chart: expected 2 to be 1
  Tests  2 failed | 1 passed (3)
  ```
- **全量回归面**：`cd web && npx vitest run` → **58 files / 577 tests，2 failed（= 本文件两条红测）/ 575 passed**（基线 = 57 files / 574 tests 全绿 ⇒ 仅新增本文件 3 条）；`npx tsc -b` 退出码 0、无输出（干净）。原始输出：`evidence/053/logs/vitest_full.txt`、`logs/tsc_b.log`。
- **真实渲染等价证据**：§1（同一判据在真实 klinecharts 上成立：VOL 199→100、DCAP 140→100、init +1、pane id 全换）。
- **可重复运行前置**：
  ```bash
  cd /home/eestock/workspace/git/eestock/eestock-rs/web
  npx vitest run src/features/dashboard/KlineChartSwitchLayout.test.tsx   # 修复前：2 failed | 1 passed
  ```
  纯 jsdom + 迷你引擎 + 真实 `loadBarsForKc`/`toKcData`；无外部服务；数据确定性。

---

## 7. 最小修复提案（**不改代码**，只给方案）

### 7.1 首选：把「图表生命周期」与「数据接线」拆成两个 effect（保留同一 chart 实例）

改哪里：`web/src/features/dashboard/KlineChart.tsx`（建图 effect `:349-450`）。

怎么改：
1. **Effect L「图表生命周期」**（deps `[]`，仅 mount 一次）：
   - `init(ref.current)`、`applyDarkTerminalStyles(chart)`、`appliedRef.current = new Map()`、`chartRef.current = chart`；
   - cleanup：`dispose(chart)`、`chartRef.current = null`、`setRt(null)`。
   - `useBarSpaceFit` 不变（仍用 `getChart` getter）。
2. **Effect W「数据接线」**（deps `[feed]`，在 L 之后定义）：
   - `offRtRef.current?.()` 先摘旧 WS 回调；
   - `chart.setDataLoader(newLoader)`（loader 闭包**只**依赖 `feed`，与现实现一致）；
   - `chart.setSymbol({ticker: props.code, …})`、`chart.setPeriod(PERIOD_MAP[props.period])`；
   - **`manualAdjusted.current = false`**（保持 ADR-020「切周期/标的回到自动视口归一」现状；否则手动缩放态会跨周期残留 —— 见 §5 #1，需产品确认，默认**保持现状**）；
   - `chart.resetData()`（或依赖上面三步的隐式 reset；注意 §3.3 冗余取数）；
   - overlays：`chart.removeOverlay()`（清旧）+ `createChartOverlays(chart, props.overlays)`；`feed.loadInitial().then(() => createMarkerOverlays(chart, props.overlays ?? [], feed.bars))`（仍以 `chartRef.current === chart` 守卫）；
   - WS：`offRtRef.current = feed.onRealtime(...)`（`followLatest` 时 `scrollLatest()`）。
   - **不得**在 W 里重置 `appliedRef`（指标仍挂同一 chart ⇒ 差分基线不变 ⇒ 无 create/remove）。
3. 指标差分 effect（`:453-465`）与 warmup effect（`:467-486`）**保持不变**。
4. `DashboardPage` 的 `feed` useMemo **保持不变**（仍随 `state.selected/state.period/viewportBars` 新建 feed；由 KlineChart 原地接管）。若要顺带消除 §1.4 的 `viewportBars` 重建，可另案（把 viewportBars 也改为 feed 的可变属性），本次可不动。

### 7.2 备选（兜底）：remount 后回放 `setPaneOptions`

若 7.1 因风险暂缓：在 Effect L 的 cleanup 里快照 `{指标名 → getPaneOptions().height}`（KlineChart 组件本身不卸载，ref 可跨 feed 变化），新图 `syncIndicators` 完成后逐 pane `setPaneOptions({id, height})`。**必须接受** §4.1 的全部固有缺陷（id 更换、闪烁、时序敏感、顺序不还原）。

### 7.3 副作用面（逐项）

| 既有行为 | 7.1 修复后影响 | 需同步的事 |
|---|---|---|
| 指标勾选开/关 | **不变**（仍 create/remove） | 无 |
| MA/DCAP 参数保存不重建 pane | **不变**（仍 overrideIndicator + setWarmupBars/resetData） | 无 |
| 切 period/stock | 由「remount」变「原地接线」：pane 高度/顺序/手动视口**保持**；`manualAdjusted` 显式重置为 false（若采纳） | 新增红测试转绿 |
| pane 首次创建高度 | 不变（新 pane 仍默认 100） | 无 |
| ADR-020 fit | 不变（resetData → DataLoader init → `onInit` fit；`manualAdjusted=false` 保持「切周期回 fit」） | 回归测试 `barSpaceFit.test.ts` / `DashboardPage.test.tsx` 应保持绿 |
| WS | 需把 `offRt` 挂到新 feed；旧 feed `dispose` 仍由 DashboardPage 负责 | 补/核 WS 相关测试 |
| overlay | 需显式 `removeOverlay()` 再重建（否则残留） | 工作台 overlay 相关测试（`KlineChart` marker/range）需覆盖「切换后旧 overlay 被清」 |
| DCAP warmup | 需保证新 feed 的 warmup 在切换后仍生效（新 feed 构造时已带 `warmupBars`） | T10/warmup 测试保持绿 |
| **需同步更新的既有测试** | 预期**无大面积**：本修复不引入新的 chart API；但若有测试断言「切 period 调用 `init`/`setDataLoader` 次数」，需按新行为更新（当前未见此类断言） | 落地后跑全量 vitest 核对 |

---

## 8. 明确未做 / 边界

- **未修改任何产品代码、接口、架构**；`web/` 下仅**新增** 1 个测试文件 `web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`。
- 未 kill/重启/改配置 8081/8082（PID 2102695 未动）；未改线上 `web/dist`；未用 deploy 脚本。
- 未 `git add/commit/stash`（`git diff --cached --name-only` 为空）；tracked 改动 0。
- 仓库内未跑 tangle；未改 `design/14-dcap-indicator/*` 的 `file=` 块；未改 `web/src/features/indicators/dcap.ts`。
- DB 未连（本轮无 DB 需求）。
- 未实现/未验证修复（仅给方案）。
- 未启用覆盖率工具 ⇒ 本报告无覆盖率数字。
- 无崩溃 / 无 core dump（4 次探针 `pageErrors=[]`）。
- 临时资源收尾：`vite preview`（18097，PID 2861091）已 kill、端口已释放；`/tmp/diag53` 为临时目录（可留作复跑，非仓库内容）。

---

## 9. 逐项结论（对派单 1~7）

| # | 派单项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 复现（切 period / 切 stock 高度被重置，量化） | ✅ | A：VOL 199→100（−99）、DCAP 140→100（−40）、MA 357→496（+139）；B 同；pane id 全换；`inits` +1；截图 P1~P4 |
| 2 | 精确定位触发点 + 依赖面 + remount 重置清单 | ✅ | `KlineChart.tsx:349-450`（deps `[feed]`）+ `DashboardPage.tsx:225-238`（deps `state.selected/state.period/viewportBars`）；重置清单见 §2.3 |
| 3 | 首选「不 remount」可行性实测 | ✅ 可行 | §3：pane id/高度逐值不变、`inits` 不变、数据换新（根数/首时间戳/取值）、残留旧数据窗口 <150ms、4 次冗余 GET |
| 4 | 备选「回放 setPaneOptions」可行性 + 固有缺陷 | ✅ 可行但更差 | §4：恢复 ±0；缺陷 = id 更换/闪烁/时序敏感/顺序不还原；与 fitBarSpace **无直接冲突** |
| 5 | 回归风险面逐条 | ✅ | §5：ADR-020（现行满足、原地切换需显式清 manualAdjusted）、WS（帧证据）、overlay（`resetData` 不清 overlay，需显式 remove）、warmup（120 / 120+68=188）、workbench KlineResultChart（结构同源、低影响） |
| 6 | 红测试（位置 + 当前红） | ✅ | `web/src/features/dashboard/KlineChartSwitchLayout.test.tsx`（2 红 1 绿）；全量 577 中仅此 2 红；`tsc -b` 干净 |
| 7 | 最小修复提案 + 副作用面 | ✅ | §7（拆 L/W 两个 effect；备选回放；副作用逐项） |

---

## 10. 最小修正建议（交架构师裁决）

1. **【必需】** 按 §7.1 把建图 effect 拆为「图表生命周期（mount 一次）」+「数据接线（`[feed]`）」，切换 period/stock 在同一 chart 实例上以 `setDataLoader + setSymbol + setPeriod + resetData` 完成 ⇒ pane 布局/高度不重置（红测试 3 条转绿）。
2. **【必需·决策点】** 原地切换时是否显式 `manualAdjusted.current = false`：**默认保持现状（清）** 以延续 ADR-020「切周期回到 fit」；若产品希望「手动缩放视口跨周期保留」，则不清 —— 需用户/架构拍板。
3. **【必需】** overlay 在原地切换路径上必须「先 `removeOverlay()` 再重建」；WS 回调必须从旧 feed 摘除并挂到新 feed。
4. **【建议】** 处理 §3.3 的冗余取数（setDataLoader/setSymbol/setPeriod 各触发一次 init load）；可用代际门闩或让 loader 去重。
5. **【建议·同类】** `viewportBars` 变化（改配置 / focus 重读）与 period/stock 同属「feed 身份变化 ⇒ remount ⇒ 布局重置」；若本轮只修 period/stock，建议单独登记该残留项。

**VERDICT: DIAGNOSED**
