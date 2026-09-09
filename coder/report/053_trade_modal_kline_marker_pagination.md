# 053 交易明细弹窗 K 线：加开/平仓 B/S 标记 + 缩放/平移分页拉取更早历史

> 本报告位置：`eestock-rs/coder/report/053_trade_modal_kline_marker_pagination.md`

## 任务
真机目验发现交易明细弹窗内嵌 K 线 `KlineChart` + `ScopedKlineFeed` 两个问题：
1. 开/平仓 bar 没有「B」「S」标记（现状只有蓝/橙 `simpleTag` 价线 + 区间高亮）。
2. 缩放/向左平移拉不到更多历史：`ScopedKlineFeed.loadBefore` 恒返回 0，`KlineChart.getBars('forward')` 拿不到增量。

## 两问题根因

**问题 1（无 B/S 标记）**：`TradeDetailModal` 只构造了 `price-line`（simpleTag）与 `range`（tradeRange）两类 overlay，未在开仓/平仓 bar 位置打文本标记；`KlineChart.createChartOverlays` 也只处理 `price-line`/`range`，没有「bar 标注」通道。

**问题 2（拉不到更早）**：`ScopedKlineFeed.loadBefore()` 直接 `return 0`，注释「区间外无更早历史，不向前分页」。但 `KlineChart` 的 `getBars('forward')`（经 `klineDataLoader.loadBarsForKc`）会调用 `feed.loadBefore()` 以获取更早 delta 供 klinecharts `prepend`。`loadBefore` 恒 0 → forward 永远无增量 → 向左平移/缩放变宽看不到历史上下文。

## 改动

### 1. `web/src/features/dashboard/KlineChart.tsx`（按任务允许的「小参数化」，看板默认不变）
- 新增 `KlineMarkerOverlay`（`type: 'marker'`）并并入 `KlineOverlay` 联合类型：
  ```ts
  interface KlineMarkerOverlay {
    type: 'marker';
    ts: number;          // Unix 毫秒锚点（开/平仓 moment）
    text: 'B' | 'S';     // 标记文本
    price?: number;      // 可选锚定价位（决定 pin 的 y）
    color?: string;
  }
  ```
- `createChartOverlays` 新增 `marker` 分支：用 klinecharts 内置 `simpleAnnotation`（竖线 + 箭头 + 文本），
  `points: [{ timestamp: ov.ts, value: ov.price ?? 0 }]`，`extendData: ov.text`（B/S 文本）。timestamp 由
  klinecharts 按当前周期 bar 就近对齐；`lock: true` 防误拖。看板（`DashboardPage`）不传 `overlays`，行为不变。

### 2. `web/src/features/backtest/TradeDetailModal.tsx`
- `overlays` useMemo 新增两条 `marker`：开仓 `{ ts: open_ts*1000, text:'B', price: open_price }`、
  平仓 `{ ts: close_ts*1000, text:'S', price: close_price }`，**叠加**在既有价线 + 区间高亮之上。
- buffer 从 10 → 30（初始上下文更足），并同步「±10 bar」文案 →「±30 bar」。

### 3. `web/src/features/backtest/ScopedKlineFeed.ts`（分页核心）
- 增加 `pageSize?`（默认 `defaultPageSizeForPeriod(period)`，与看板 `KlineDataFeed` 分页口径一致）。
- `loadInitial`：
  - 首屏仍按「开仓→平仓 + 前后 buffer」拉窗口并过滤成闭区间（升序）。
  - `hasMore` 从恒 `false` 改为 `this.bars.length > 0 && fetched.length >= needBars`：**起始 true**（左还可拉）；
    区间无可见 bar 时 false，避免 forward 空拉忙转。
- `loadBefore` 不再恒 0，改为与看板同语义的向前分页：
  - 以当前最左 bar 的 ts 作为 `before`（排他上界）游标，`limit = pageSize` 拉更早页；
  - 去重（按 ts）后**前插** `fresh` 到 `bars` 头部，保持升序；返回新增条数（KlineChart `loadBarsForKc`
    只看 delta，引擎据此 prepend，不叠加重复）；
  - `older.length < pageSize` → `hasMore = false`（到历史尽头）；
  - 增加 `loadingBefore` 防并发重入；`disposed`/`!hasMore`/`bars===0` 直接返回 0。
- 禁实时保持：`onRealtime` 仍只注册监听从不触发，`applyRealtime` 恒 `'ignore'`。

### 4. 测试
- **新增** `web/src/features/backtest/ScopedKlineFeed.test.ts`：分页行为（初始窗口 + hasMore 起始 true、
  `loadBefore` 游标/去重/delta、到尽头置 `hasMore=false`、带重叠返回去重、空区间不拉网、`loadInitial` 幂等）。
- **修改** `web/src/features/backtest/TradeDetailModal.test.tsx`：断言 `createOverlay` 收到 `simpleAnnotation`
  `extendData 'B'/'S'`（锚定 open_ts/close_ts），并验证周期切换后 B/S 重新 `createOverlay`（重定位）。

## B/S overlay 方案（择一稳定）
采用 klinecharts 内置 `simpleAnnotation`（任务建议项）：竖线 + 向下箭头 + 文本，视觉接近 TradingView
买/卖点；`extendData` 承载 `'B'/'S'` 文本。用 `{ timestamp, value }` 锚点：x 由 timestamp 在当前周期 bar
就近对齐（自动满足「周期切换/不对齐则就近」），y 由 open/close 价决定。jsdom 无法真绘 canvas，故测试只
断言 overlay 定义/调用与分页逻辑，**真机目验需另排 tester**（见残留风险）。

## 分页实现要点
- `getBars('forward')` 走既有 `loadBarsForKc` 不变（只看 delta），复用看板分页行为。
- 缩放向右（更晚）保持 `backward: false`（优先保证左向历史）；初始已含平仓后 buffer 作右向上下文。
- `hasMore` 按「取满请求窗口」判断（与 `KlineDataFeed` 同口径）。

## Red → Green
- **Red**：先写 `ScopedKlineFeed.test.ts` + `TradeDetailModal` 新增断言，`vitest` 报 6 失败（确认未实现前即红）。
- **Green**：实现上述改动后，`vitest` 全绿（257 测试过）。

## 验证
```
npx vitest run                                → 33 files / 257 tests 全过
VITE_API_MOCK=0 npx tsc -b                    → exit 0
VITE_API_MOCK=0 npx vite build                → built in ~1.08s（仅既有 chunk>500KB 警告，非本次引入）
```
不 commit；**文件未 stage**（遵守 acceptance 的 `noStagedFiles`，父级/评审可看干净 diff）。

## 暂存文件清单（未 stage，eestock-rs 内）
```
M  web/src/features/backtest/ScopedKlineFeed.ts
M  web/src/features/backtest/TradeDetailModal.tsx
M  web/src/features/dashboard/KlineChart.tsx
M  web/src/features/backtest/TradeDetailModal.test.tsx
?? web/src/features/backtest/ScopedKlineFeed.test.ts
```
（工作区另有其他项目的既有未提交文件，非本次改动，未触碰。）

## 残留风险 / 需真机目验
- **canvas 真绘无法 jsdom 验证**：`simpleAnnotation` 在真机上的视觉（文本是否清晰、箭头位置是否贴 bar、
  B/S 文本颜色是否为主题默认浅色）需真机目验；若因主题样式不如意，可后续在 `styles` 补 text 配色（属于
  该 overlay 样式微调，不涉架构）。
- 标记文本颜色沿用主题默认（`styles.line` 只控制竖线颜色）；若真机需区分 B/S 更醒目，可再调 `styles`。
- 缩放向右（更晚）仍 `backward:false`：右向历史大于「平仓后 buffer」时可能触边；任务明确「优先左向」，可接受。
- `ScopedKlineFeed` 未接 gitnexus MCP/CLI（本机工具非可用）；改动为纯增量/局部，未改 feed 面契约，已由
  tsc/build/测试覆盖。
```
