# 051 回测交易明细弹窗：大尺寸可 resize + 复用看板 KlineChart 交互式 K 线

> 本文件位置：`eestock-rs/coder/report/051_backtest_trade_detail_modal_kline.md`

## 需求（Grill 定稿）
把回测交易明细弹窗从「仅交易字段」升级为：**大尺寸可 resize + 上方紧凑交易字段 + 下方/主体复用看板 `KlineChart` 交互式 K 线**。
- 弹窗：居中、可手动调整尺寸（右下角拖拽）、默认 `min(1200px,90vw)×min(80vh,85vh)`、设 min 防过小、内容区可滚动。
- 布局：上方紧凑交易字段行（标的/方向/开平时刻/价格/数量/盈亏/时长/费用）+ 主体大 K 线。
- K 线：复用看板 `KlineChart`（完整 klinecharts）。MA(5/10/20)+VOL 默认开；MACD/KDJ/BOLL 可勾选切换；可左右平移/缩放；周期可切换（弹窗内 1m/5m/15m/日，默认=该 run 的周期）。
- 数据范围：该标的 code + 当前周期「开仓→平仓 + 前后 buffer（默认 10 根）」。
- 标记：开/平仓两条价位线（`createOverlay` price line）+ 开平仓区间高亮。

## 改动面（只动回测前端 + 参数化看板 KlineChart；未改后端/DB/SQL/Rust）

| 文件 | 类型 | 改动 |
|------|------|------|
| `web/src/features/backtest/ScopedKlineFeed.ts` | 新增 | 区间作用域 K 线 feed（`[open−buffer, close+buffer]`）；`loadBefore` 恒 `0`；禁实时 |
| `web/src/features/backtest/TradeDetailModal.tsx` | 重写（244 行） | 大尺寸可 resize + 交易字段 + 周期/指标切换 + 主体 KlineChart + overlay |
| `web/src/features/dashboard/KlineChart.tsx` | 参数化（+117） | ① feed 类型放宽为 `KlineChartFeedLike`；② 新增可选 `overlays?: KlineOverlay[]`；③ 注解自定义 overlay 模板 `tradeRange` |
| `web/src/features/backtest/BacktestPage.tsx` | 改 | 弹窗改传 `period`（run 周期码）+ `api` |
| `web/src/features/backtest/format.ts` | 增 | 新增 `periodCodeToPeriod`（M1/M5/M15/D1→1m/5m/15m/1d） |
| `web/src/features/backtest/TradeDetailModal.test.tsx` | 重写（206 行） | K 线容器/周期切换/指标切换/overlay/resize 断言 |
| `web/src/features/backtest/BacktestPage.test.tsx` | 改 | 补 klinecharts 打桩 + 断言弹窗含 K 线容器 |

## 架构分层对照
- **UI 层（弹窗）**：`TradeDetailModal` —— 布局/交互状态（周期/指标/尺寸）由组件本地状态持有，不进入 store。
- **数据流（feed）**：`ScopedKlineFeed` —— 属于回测特性内的区间数据源，接口对齐看板 `KlineDataFeed` 的最小承接口（`bars/hasMore/loadInitial/loadBefore/onRealtime/applyRealtime/dispose`）。
- **图表适配层**：`KlineChart`（看板）—— 仅做**增量参数化**（新增可选 `overlays`、feed 接口放宽），**保留看板默认行为不变**：未传 `overlays` 时走原路径（DashboardPage/GridCell 不传 → 无 overlay、行为一致）。
- **不属于本次**：未改 store/骨架/后端/API 契约（`api/client.ts` 等未动；`ScopedKlineFeed` 直接复用现有 `api.getKline` 的 `before`+`limit`）。

## 关键实现决策

### 1) ScopedKlineFeed 方案（优先新建，未大改看板主链路）
- 取数用现有 `GET /api/kline` 的 `before`（排他上界）+ `limit`：以 `close_ts + (buffer+1)×step` 为排他上界，`limit = spanBars + 2×buffer + 3`，拉到位后按时间戳过滤 `[open−buffer×step, close+buffer×step]` 闭区间，升序 bar。
- `loadBefore()` 恒返回 `0`（无更早历史）；`onRealtime` 注册监听但从不触发（历史区间不走 WS 实时）；`applyRealtime` 恒 `'ignore'`。
- 结构上 `KlineChart` 的 `feed` 类型由 `KlineDataFeed` 放宽为 `KlineChartFeedLike`（= `KlineDataFeedLike` + `onRealtime`），使 `KlineDataFeed`（看板）与 `ScopedKlineFeed`（弹窗）都能传入，`loadBarsForKc` 复用不变。

### 2) 周期切换
- 弹窗本地状态 `selPeriod`（默认由 `periodCodeToPeriod(run.period)` 得到，D1→1d）。切换周期 → `useMemo` 重建 `ScopedKlineFeed` → KlineChart 的 `[feed]` effect 整图重建并重载区间 bar。

### 3) 指标勾选
- 复用看板 `DASHBOARD_DEFAULTS.indicators` 默认值（ma 开、其余关），由 `KlineChart` 现有 `syncIndicators`（指标勾选 effect）同步；测试断言点 MACD 后 `createIndicator({name:'MACD'}, true)` 被调用。

### 4) 开/平仓 overlay + 区间高亮（参数化 KlineChart，看板默认不变）
- 新增 `overlays?: KlineOverlay[]`（`price-line` / `range`）。
- 价位线：内置 `simpleTag`（已注册模板）——`points:[{value:price}]` 锚定价位，`extendData` 作标签，`lock` 锁住不响应事件。
- 区间高亮：klinecharts 无内置「全高背景 rect」overlay，`createOverlay({name:'tradeRange'})` 在 `addOverlays` 里因模板未注册而返回 null。为此**注册一次自定义 `tradeRange` 模板**（`registerOverlay`，全高 rect，x 由 open/close 时间戳决定，y 用整个 pane 高度）；注册用 `typeof registerOverlay !== 'function'` 守卫，测试环境（klinecharts 打桩）下跳过注册，交由 `createOverlay` 桩断言。
- **看板默认行为不变**：dashboard/GridCell 不传 `overlays` → 不触发 `createChartOverlays`，不调用 `createOverlay`/`registerOverlay`，DashboardPage 回归测试保持绿。

### 5) resize 方式
- 右下角 resize 手柄 `onPointerDown`：记录初始尺寸/坐标 → `window` 上 `pointermove` 计算新宽高（`min(480, 400)` 防过小）→ `pointerup` 清理监听。默认尺寸 `defaultSize()` 用 `window.innerWidth/innerHeight` 计算 `min(1200px,90vw)×min(80vh,85vh)`。
- 注：jsdom 无 `PointerEvent`，`fireEvent.pointerDown` 不携带坐标；测试用手动 `MouseEvent('pointerdown',{clientX,clientY,bubbles:true})` 触发 React `onPointerDown`（已在测试注释说明）。

### 6) 弹窗结构
```
fixed inset-0 z-50 flex items-center justify-center bg-black/60   ← 遮罩，无 onClick（防误触）
 └─ dialog [flex-col, 内联宽/高, overflow-hidden, 可滚动区]
     ├─ header：标题 + 关闭按钮(✕)
     ├─ 上区 [shrink-0, overflow-y-auto]：交易字段 grid + 周期/指标按钮行
     ├─ 主体 [min-h-0 flex-1 p-2]：<KlineChart feed=ScopedKlineFeed ... overlays/>
     └─ resize 手柄 [h-3, cursor-nwse-resize]
```

## Red→Green 证据
1. **Red**：先改写 `TradeDetailModal.test.tsx`（kline-chart / period / macd / overlay / resize 断言）与 `BacktestPage.test.tsx`（klinecharts 打桩 + 弹窗含 K 线）对着「仍只有交易字段」的旧弹窗跑：
   - `vitest run src/features/backtest/TradeDetailModal.test.tsx` → `5 failed | 3 passed`（缺失 `kline-chart`/`trade-detail-dialog`/`trade-detail-resize`/overlay/指标断言）。
2. **Green**：实现 `ScopedKlineFeed`、重写弹窗、参数化 `KlineChart`、接线 BacktestPage、改 format 后：
   - `vitest run src/features/backtest` → `7 files, 44 tests passed`。
   - `vitest run src/features/dashboard` → `8 files, 59 tests passed`（看板回归绿）。

## 验证
- `npx vitest run` → **32 test files, 249 tests passed**。
- `VITE_API_MOCK=0 npx tsc -b` → 无类型错误（exit 0）。
- `VITE_API_MOCK=0 npx vite build` → **built in ~1.0s**（仅 chunk>500kB 体积警告，非错误）。
- 回归：`DashboardPage.test`(8)/`GridCell.test`(6)/`klineDataLoader.test`(3)/`store.test`(20) 等看板测试全绿。

## 残留风险
1. **区间高亮时间戳对齐**：`tradeRange` 全高 rect 的 x 由 open/close 时间戳映射到 bar 下标。若 `open_ts`/`close_ts` 与该周期的 bar 起始 ts **不完全相同**（如跨日/取整偏差），`timestampToDataIndex` 可能返回 null → x=0，即高亮带位置不在预期区间。价位线（value 锚定，无此依赖）不受影响。当前按「引擎在 bar 边界开平仓」假设对齐，真实数据下需人工确认；若偏移明显可后续用「最近 bar ts 归位」修正。
2. **`tradeRange` 为全局注册的自定义 overlay**：`registerOverlay` 一次注册，作用于所有 klinecharts 实例；无命名冲突（唯一新模板名），但属模块级全局状态。
3. **scoped 取数上限**：`limit = spanBars + 2×buffer + 3` 未显式 clamp；单次超长持仓且周期大时「足够覆盖」，但后端若有 limit 上限可能截断（一般持仓 bar 数远小于上限，风险低）。
4. **resize 为指针/鼠标拖拽**：桌面端完好；触屏 PointerEvent 需要 Pointer 事件，本次未专项适配（终端工具，属可接受范围）。
5. **jsdom 环境**：K 线真实渲染（canvas）无法在 jsdom 验证；overlay 的 `createPointFigures` 仅以 mock `createOverlay` 断言调用，真实绘制以 `vite build` + 已注册模板为保障，需在真机/浏览器人工目验一次。
6. **GitNexus**：本会话无 gitnexus 工具，未运行 `gitnexus_impact`/`gitnexus_detect_changes`；改动用 vitest + tsc + vite build 作为替代验证，且改动面已人工控制在 backtest 前端 + 看板参数化内。

## 暂存文件清单
按要求 **不 commit、不 stage**（`noStagedFiles: true`）。涉及文件：
- 新增：`web/src/features/backtest/ScopedKlineFeed.ts`
- 修改：`web/src/features/backtest/TradeDetailModal.tsx`、`web/src/features/backtest/TradeDetailModal.test.tsx`、`web/src/features/backtest/BacktestPage.tsx`、`web/src/features/backtest/BacktestPage.test.tsx`、`web/src/features/backtest/format.ts`、`web/src/features/dashboard/KlineChart.tsx`
