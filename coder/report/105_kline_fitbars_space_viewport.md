# 105 — 修看板初始 K 线数不随 viewportDays 变化（fitBarSpace 改用配置视口）

> 本文件位置：`eestock-rs/coder/report/105_kline_fitbars_space_viewport.md`

## What changed

源码（3 文件，显示层/feed 类型）+ 测试（3 文件）：

| 文件 | 修改 |
|------|------|
| `web/src/features/dashboard/KlineChart.tsx` | `KlineChartFeedLike` 增 `viewportDays?: number`；`fitBarSpace` 铺满目标改用 `defaultPageSizeForPeriod(period, feed.viewportDays ?? DEFAULT_KLINE_VIEWPORT_DAYS)`；import `DEFAULT_KLINE_VIEWPORT_DAYS` |
| `web/src/features/dashboard/feed.ts` | `KlineDataFeed` 增公开 `get viewportDays()`（返回 `deps.viewportDays ?? DEFAULT_KLINE_VIEWPORT_DAYS`） |
| `web/src/features/backtest/ScopedKlineFeed.ts` | 增 `readonly viewportDays = DEFAULT_KLINE_VIEWPORT_DAYS`（区间弹窗无配置，fallback 2） |
| `web/src/features/dashboard/KlineChart.test.tsx` | 增 2 条 fitBarSpace 测试（viewportDays=4→target68 用 10；无配置 fallback→34 用 20）；chartStub 增 `setBarSpace`；`fakeFeed` 支持 overrides；`renderChart` helper |
| `web/src/features/dashboard/store.test.ts` | 增 2 条 `KlineDataFeed` 测试（`viewportDays` getter 配置/缺省；viewportDays=4(15m)→limit=17×4=68） |
| `web/src/features/backtest/ScopedKlineFeed.test.ts` | 增 1 条测试（无 viewportDays 输入→默认 2） |

净 diff：+93 / -8（`git diff --stat`）。

## Problem solved

根因：`KlineChart.fitBarSpace`（KlineChart.tsx L247）`const target = defaultPageSizeForPeriod(props.period)`——
**无 viewportDays，恒用默认 2 视口**。配置 `viewport_days` 让 feed `loadInitial` 加载了 `BARS_PER_TRADING_DAY×viewportDays`
根（如 15m：viewportDays=4→68），但 `barSpace` 仍按 34（2 视口）算，klinecharts 默认视口只显示 ~34 根（多加载的在右侧/滚动），
**初始可见 K 线数不随配置变化**。后端已验证 limit=68 生效，纯前端显示层问题。

## Implementation approach

- `KlineChartFeedLike`（feed 最小面，`KlineChart` 消费）新增 `viewportDays?: number`；`KlineDataFeed` 公开 `viewportDays`
  getter 暴露配置值（缺省 2），`ScopedKlineFeed` 固定 `DEFAULT_KLINE_VIEWPORT_DAYS`（=2）。
- `fitBarSpace` 铺满目标 = `defaultPageSizeForPeriod(period, feed.viewportDays ?? DEFAULT_KLINE_VIEWPORT_DAYS)`，
  与 feed 的 `pageSize = defaultPageSizeForPeriod(period, viewportDays)` 同源 → barSpace 与加载根数一致，
  初始可见 K 线数即配置视口。
- 其他不动：宫格缩略（GridCell 固定 pageSize:120，不走 KlineChart.fitBarSpace）；回测弹窗 ScopedKlineFeed
  因新增字段补默认 2，行为不变。
- `KlineDataFeed` 已有 `viewportDays` 在 deps 中（`DashboardPage` 经 `GET /api/config/kline` 传入），此处开放 getter，
  不新增数据源。

## Architecture alignment

- `KlineChart.tsx`：**显示层**（klinecharts 适配）。`fitBarSpace` 属 chart 显示铺满逻辑；`KlineChartFeedLike` 属该组件的最小
  feed 契约面，加一个可选字段合法。
- `feed.ts` / `ScopedKlineFeed.ts`：**feed 数据流层**（图表库无关）。只新增公开只读 `viewportDays`（源自已有配置），
  不改取数/分页/WS 逻辑。
- 未触碰后端/数据层（API limit、mock 已由既有 101/102/103/104 实现），未改核心接口契约（`KlineDataFeedLike` 未动，
  `KlineChartFeedLike` 仅追加可选字段）。

## TDD Red → Green

- **Red**：先写测试并跑 vitest——3 条新测试失败：
  - `KlineChart feed.viewportDays=4(15m) → setBarSpace(10)` 实际得 `20`（旧 34 视口）。
  - `KlineDataFeed.viewportDays` getter 实际为 `undefined`（无 getter）。
  - `ScopedKlineFeed.viewportDays` 实际为 `undefined`。
- **Green**：实现后 3 条全绿。

## Test coverage

- `KlineChart.test.tsx`：
  - `viewportDays=4`(15m)→`fitBarSpace` target=17×4=68，`setBarSpace` 用 10（非 34 的 20）。
  - 无 viewportDays（fallback 默认 2）→ target=17×2=34，`setBarSpace` 用 20（旧行为保留）。
- `store.test.ts`（KlineDataFeed）：
  - `viewportDays` getter 配置值生效 / 缺省 2。
  - `viewportDays=4`(15m)→`defaultPageSizeForPeriod('15m',4)=68`，`loadInitial` `getKline` limit=68。
- `ScopedKlineFeed.test.ts`：无 viewportDays 输入 → 暴露默认 2。

## Verification

- `cd eestock-rs/web && npx vitest run src/features/dashboard src/features/backtest` → 20 文件 / 182 测试全过。
- `VITE_API_MOCK=0 npx tsc -b` → 通过（无输出）。
- `VITE_API_MOCK=0 npx vite build` → 通过（128 modules，仅既有 >500kB chunk 告警，与本次无关）。
- 未 commit；`git diff --cached` 为空（无暂存）。

## Residual risks

- 无新增后端依赖；vite build 的 chunk 大小告警为既有，与本次无关。
- 若 `viewportDays` 运行中变化：`DashboardPage` 的 `useMemo([..., viewportDays])` 重建 feed → `KlineChart`
  effect 依赖 `[feed]` 整图重建 → `fitBarSpace` 重算，无陈旧 barSpace。
- `KlineDataFeed` 在宫格缩略（GridCell pageSize:120）/分时（TimeshareChart）中无 viewportDays → getter 返回默认 2，
  二者不读取，无影响。
- GitNexus MCP 工具在当前 worker 会话不可用，未运行 `gitnexus_impact`/`gitnexus_detect_changes`；改动面已被父任务明确
  限定为 KlineChart 显示层 + 两 feed 类型，范围收窄、可控。
