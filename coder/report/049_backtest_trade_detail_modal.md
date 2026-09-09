# 049 回测前端：交易明细改弹窗展示

本报告文件位置：`eestock-rs/coder/report/049_backtest_trade_detail_modal.md`
（源码改动仅限 `eestock-rs/web/src/features/backtest/*`；本文件为交付说明文档，非源码改动。）

## What changed

- 新增 `web/src/features/backtest/TradeDetailModal.tsx`：交易明细自定义弹窗。
- 新增 `web/src/features/backtest/TradeDetailModal.test.tsx`：弹窗行为/字段测试。
- `web/src/features/backtest/TradeTable.tsx`：prop `onJumpToKline(code, from, to)` → `onShowTrade(trade)`；行 `onClick` 由 `run && onJumpToKline(run.code, fmtTs(open), fmtTs(close))` 改为 `onShowTrade(t)`。
- `web/src/features/backtest/BacktestPage.tsx`：移除 `useNavigate`/`navigate(...)`；新增受控 `selectedTrade` state + 渲染 `<TradeDetailModal>`；`TradeTable` 传 `onShowTrade`；`BacktestGrid` 的 `onJumpToKline` 改为 no-op（该 prop 在骨架中未被接线，仅为占位类型）。
- `web/src/features/backtest/BacktestPage.test.tsx`：新增 2 个用例（点行弹窗不跳转/不重载、关闭弹窗不重载）。

## Architecture alignment

- 全部改动位于页面⑤回测工作台前端组件层（`features/backtest`），未触及 `layouts/` 骨架、`web/src/api/*`、后端 Rust/Go、DB/SQL。
- 未新增任何依赖/框架/库；复用既有 `format.ts` 的 `fmtTs/fmtPnl/fmtPct/fmtHoldBars/deltaClass`。
- 弹窗视觉模式复用 `SymbolFormDialog` 的「遮罩 + 居中 W=480 卡片」（`fixed inset-0 z-50 bg-black/60` + 居中 `w-[480px] max-h-[80vh] overflow-y-auto`），遮罩点击不关闭（防误触，同 SymbolFormDialog），仅顶部关闭按钮关闭。

## Problem solved / feature added

- 原行为：点「交易明细」某行 `onJumpToKline(code,from,to)` → `navigate('/?code=…&ts=…')` 跳转行情看板并切回全重载。
- 新行为：点行改为**弹窗展示该笔交易明细**，不跳转、不重载（受控 state，弹窗关闭 `selectedTrade=null`，页面保持加载态）。
- 弹窗内容字段（来源 `Trade`/`TradeDetail` jsonb，`open_ts/close_ts` 为 Unix 秒）：
  - 标的 `code`（取自 `run.code`）
  - 方向（见下方说明）
  - 开仓时刻 `fmtTs(open_ts)` / 平仓时刻 `fmtTs(close_ts)`
  - 开仓价 `open_price.toFixed(3)` / 平仓价 `close_price.toFixed(3)`
  - 数量 `shares.toLocaleString('zh-CN')`
  - 盈亏额 `fmtPnl(pnl)` + 比例 `fmtPct(pnl/(gross_value-pnl))`
  - 持仓时长 `fmtHoldBars(hold_bars)`
  - 相关费用：佣金 `commission` + 印花税 `stamp_duty`（若任一 > 0）

### 方向字段说明（重要）
`Trade`/后端 `TradeDto`（`crates/backtest/src/types.rs::TradeDetail`、`crates/web/src/dto.rs::TradeDto`）**均无 direction/side 字段**，且回测引擎为长仓（engine.rs 仅 `position > 0` 时开仓买入、平仓卖出，无做空）。故方向按做多口径派生展示「**买入**」，未新增数据字段（避免引入与后端线格式不一致的前端专有字段）。若引擎未来支持做空，需补充 direction 字段。

## Implementation approach

- 受控弹窗：`BacktestPage` 用 `useState<Trade | null>`，点行 `setSelectedTrade(trade)`，关闭 `setSelectedTrade(null)`；`selectedTrade` 非空才渲染 `<TradeDetailModal>`。
- `TradeTable` 只负责把整笔 `Trade` 上抛给 `onShowTrade`，表头/筛选（全部/盈利/亏损）/排序逻辑保持零改动。
- 移除 `useNavigate`：`BacktestGrid.onJumpToKline` 是骨架占位 prop（`layouts/BacktestGrid.tsx` 内未接线调用），改为 no-op，不再触发任何路由跳转。

## Test coverage (Red → Green)

- 先写测试确认 Red：
  - `TradeDetailModal.test.tsx` Red：`Failed to resolve import "./TradeDetailModal"`（模块不存在）。
  - `BacktestPage.test.tsx` 2 新用例 Red：点击交易行后 `trade-detail-modal` 未找到（`[2/2] 2 failed`）。
- 实现后 Green：`npx vitest run src/features/backtest` → 7 files / 39 tests 全绿，含新增 3（modal）+2（BacktestPage 弹窗行为）。
- Round-trip：`BacktestPage.test` 断言「点行 → 弹窗出现 + location 仍为 `/`（不跳转）+ getRun 调用次数不变（不重载）」；「关闭 → 弹窗消失 + 交易表仍在 + getRun 不变」。

## Verification

- `npx vitest run` → 32 files / 244 tests 全绿。
- `VITE_API_MOCK=0 npx tsc -b` → 通过（exit 0，含 test 文件类型检查）。
- `VITE_API_MOCK=0 npx vite build` → 通过（exit 0，120 modules）。

## Residual risks

- 方向「买入」为长仓口径派生；未来做空需扩字段。
- `BacktestGrid.onJumpToKline` 现为 no-op（骨架未接线），如后续恢复需重接线。
- 弹窗无 focus-trap/ESC 关闭（与 SymbolFormDialog 一致）；打开弹窗后若后台 WS 刷新 run 详情，弹窗仅跟随 `selectedTrade`，不强制关闭（轻微 UX 边缘态）。
- 未运行 GitNexus 影响分析：本会话无 `gitnexus_*` 工具，且改动位于独立仓库 `eestock-rs` 前端；已通过 `git status` 核对改动范围仅限 `web/src/features/backtest/*`。

## Staged / commit status

- 未 stage、未 commit（用户/验收契约要求 `noStagedFiles: true`）。改动保留在工作区待父级审阅。
- 本次改动文件清单（eestock-rs 仓库）：
  - `web/src/features/backtest/BacktestPage.tsx`（修改）
  - `web/src/features/backtest/TradeTable.tsx`（修改）
  - `web/src/features/backtest/TradeDetailModal.tsx`（新增）
  - `web/src/features/backtest/BacktestPage.test.tsx`（修改）
  - `web/src/features/backtest/TradeDetailModal.test.tsx`（新增）

> 注：`web/src/features/backtest/` 中另有 `ResultOverview.test.tsx/StrategyForm.test.tsx/TaskList.test.tsx/format.test.ts` 为仓库既有未跟踪文件，非本次改动。
