# 055 — 交易明细弹窗 B/S 标记「吸附 + 钳位」跨周期 On-Screen 修复（G4）

> 本报告路径：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/055_trade_modal_bs_marker_snap_clamp.md`

## 根因（Root Cause）

`TradeDetailModal` 的 B/S 标记（`KlineMarkerOverlay`）在 `KlineChart.createChartOverlays` 里用 klinecharts 内置
`simpleAnnotation`，以一个**绝对 `ts`**（`trade.open_ts * 1000` / `trade.close_ts * 1000`）作为 `points[{ timestamp }]` 锚定。

深入 klinecharts 源码（`StoreImp.prototype.timestampToDataIndex`，v10.0.3）确认根因：
- 若 `timestamp` 在已加载数据范围内 → 走 `binarySearchNearest`，锁定**最近 bar**（本已「就近对齐」，正常）。
- 若 `timestamp > lastTimestamp`（或 `< firstTimestamp`，即 D1 桶 ts=16:00Z **非真实盘中时刻**，落在了已加载
  bar 范围之外）→ 代码**只把基准钳到 `lastTimestamp`，却不钳最终 index**，而是按周期步长**继续外推**：
  `baseDataIndex + floor((timestamp - referenceTs) / span)`。

于是 D1 run 的 open/close ts（如 16:00Z）在切到 1m/5m 后，`timestampToDataIndex` 返回一个**远超 `[0, len-1]`
的 dataIndex**，`dataIndexToCoordinate` 把 marker 推到**视口右侧按周期步长指数外推的位置** → B/S 屏外。

即：原实现刻意「就近对齐」，但**没有钳位到已加载范围**，是屏外根因。

## 修复（吸附 + 钳位，保证 On-Screen）

新增纯函数 `snapTsToBars(bars, targetTs)`（`KlineChart.tsx`）：
- 在**当前周期的已加载 bar 集合**里，线性扫描出**距 `targetTs` 最近的 bar**；
- 返回 `{ index, ts }`，其中 `index ∈ [0, bars.length-1]`、`ts` 恒为**已加载某根真实 bar** 的时间戳（毫秒）；
- `bars` 为空返回 `null`（无可吸附对象，跳过标记创建）。

因 `ts` 恒为已加载 bar 的真实 ts，交给 klinecharts 后 `timestampToDataIndex(realBarTs)` 必返回该 bar 的真实
index（在范围内）→ `dataIndexToCoordinate` 时 marker **必在可见数据范围内**（On-Screen）。

## 语义说明

- **等于/粗于 run 周期** → `targetTs` 命中真实交易 bar，吸附**精确不偏移**。
- **细于 run 周期**（如 D1→1m）→ marker 吸附到已加载 bar 中距该 run-bar 桶 ts 最近的 bar，**近似但必可见**。
- 若切到更细周期后「已加载区间 + buffer」覆盖超大（如 10 天 D1 → 1m 上千 bar），marker 会吸附到区间两端最近
  bar（贴近左右边缘）——仍可见。
- **保留区间高亮带**（`tradeRange`，`createChartOverlays` 基础 overlay 未动）。
- **不移除周期切换能力；不引入新依赖**（仅用 `Date.parse` 与数组遍历）。

## 实现：TDD（Red → Green）

### Red（先写失败测试）
- `web/src/features/backtest/markerSnap.test.ts`（新增）——纯函数单测：
  - D1 桶 ts（16:00Z）无同类 1m bar 且晚于末根 → 吸附到最近 bar，index ∈ [0,len-1]，ts ∈ [first,last]。
  - D1 桶 ts 落在两根已加载 bar 中间 → 吸附到最近（平局取前一根）。
  - 正常同周期 ts 恰为某根 bar → 吸附精确不偏移。
  - ts 早于首根 / 晚于末根 → 钳位到首根 / 末根。
  - bars 为空 → 返回 null。
  - 乱序输入 → 仍正确吸附（容错）。
- `TradeDetailModal.test.tsx` 两个 marker 用例改为 `waitFor` + 断言「吸附后」真实 bar ts（非原始 D1 桶 ts），并把
  周期切换用例改到更细的 **1m**（贴合 D1→1m）。

Red 确认：`snapTsToBars` 不存在（7 失败）+ marker 断言未命中（2 失败）。

### Green
- `KlineChart.tsx`：
  - 新增导出 `snapTsToBars`；
  - `createChartOverlays` 只保留基础 overlay（`price-line` + `range`），把 `marker` 分支**移出**；
  - 新增 `createMarkerOverlays(chart, overlays, bars)`，对 `marker` 先 `snapTsToBars` 吸附/钳位再 `createOverlay`；
  - 在 effect 里，`void feed.loadInitial().then(() => { if (chartRef.current === chart) createMarkerOverlays(..., feed.bars) })`。
    依「已加载 bar」吸附/钳位创建；用 `chartRef.current === chart` 防周期切换/卸载后仍回打点。
- Green 确认：17/17 指定用例绿；全量 34 文件 264 用例绿。

## 变更文件与行数

| 文件 | 类型 | 变更 |
|------|------|------|
| `web/src/features/dashboard/KlineChart.tsx` | 修改 | `+~76 / -~34`（新增 `snapTsToBars`、`createMarkerOverlays`；`createChartOverlays` 移除 marker 分支；effect 追加异步创建；注释更新） |
| `web/src/features/backtest/TradeDetailModal.test.tsx` | 修改 | `+~42 / -~30`（BARS 重设、SNAPPED_* 常量、两 marker 用例改 waitFor+吸附断言、切 1m） |
| `web/src/features/backtest/markerSnap.test.ts` | 新增 | `+~95`（纯函数吸附/钳位单测） |

## 架构对齐

- `KlineChart.tsx`（dashboard，图表适配层）持有 `feed`（含 `bars`），且是 klinecharts overlay 的创建点——
  吸附/钳位所需「已加载 bar」与「overlay 创建」都在此层，修改归属正确。
- `snapTsToBars` 为图表适配层的**纯函数**（无 React/klinecharts 副作用），便于单测，归属图表适配层。
- `TradeDetailModal.tsx`（backtest 业务层）**未改**：marker 仍传原始 `trade.open_ts/close_ts`，吸附/钳位由适配层
  依当前周期已加载 bar 完成；未新增层间依赖（dashboard 不 import backtest）。
- 未更动 core 接口/事件契约/层边界；未引入新依赖。

## 测试覆盖

- `markerSnap.test.ts`（7）：D1→1m 无同类 bar、区间中值吸附、同周期精确、早/晚钳位、空集、乱序。
- `TradeDetailModal.test.tsx`（10）：含「吸附到已加载 bar 并钳位」「D1→更细 1m 重吸附」两用例，用 `waitFor` 验证异步
  创建。

## 验证

- `npx vitest run` → **34 文件 / 264 用例 全绿**。
- `VITE_API_MOCK=0 npx tsc -b` → 通过（无输出）。
- `VITE_API_MOCK=0 npx vite build` → 通过（仅存量 chunk >500KB 提示，非本次引入）。

## 残留风险

- **canvas 真绘 jsdom 无法验**：测试仅断言「吸附/钳位逻辑」与传给 klinecharts 的 `snapped.ts`（真实已加载 bar
  ts，非 D1 桶 ts）。B/S 标记在真实 canvas 上的落点需**真机（浏览器）目验**：D1 run 弹窗切 1m/5m 后 B/S 是否
  始终可见、区间高亮是否保留、价位线是否正确。
- **近似标注未实现**：任务「标注注明近似」为语义说明；本次聚焦 on-screen 修复，未在 UI 额外标注「近似」。
  如需，可作为后续增强（传 run-period 与 selPeriod 比较 → 显示近似徽标）。
- **吸附后 marker 的 y（value）锚定**：吸附只改 x（bar ts），y 仍用 `ov.price`（开/平仓价）。若开/平仓价在当前
  周期 bar 的 high/low 之外，pin 的 y 可能超出 candle 图形区——与原实现一致，非本次范围。
- **区间外 ts 钳到边缘根**：当 marker ts 远超已加载区（如 D1 十余天 → 1m）会贴左右边缘（符合任务预期「可见即可」）。
- 手动影响评估：`snapTsToBars` 为新增导出；`createChartOverlays` 行为对 `marker` 类型变化；`KlineChart` 用户仅
  `TradeDetailModal` 传 overlays（看板/GridCell 不传，未见回归）。AGENTS.md 建议的 `gitnexus_impact/detect_changes`
  工具在当前 session 工具集不可用，故以手动 `git diff` 评估替代。

## 暂存文件清单

- 新增：`web/src/features/backtest/markerSnap.test.ts`
- 修改：`web/src/features/backtest/TradeDetailModal.test.tsx`
- 修改：`web/src/features/dashboard/KlineChart.tsx`

（`git add` 已暂存，**未 commit**。）
