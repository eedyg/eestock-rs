# 042 — 回测 Phase 4：前端回测工作台页面（web）

> 本报告自身路径：`coder/report/042_backtest_phase4_frontend_page.md`（eestock-rs 仓库）。

## 任务

在后端回测 REST/WS（Phase 3c，提交 a9c35d4 上游）已就绪之上，实现 `web/` 前端页面⑤回测工作台：
`BacktestPage` 经 RegionPortal 挂入 tangle 骨架 `BacktestGrid`，8 个区域组件（StrategyForm/TaskList/
ResultOverview/MetricCards/TradeTable/PeriodHeatmap/CompareView/GridRank）+ api client/types/mock 增补 +
路由 `/backtest` + 导航解锁。权威：`design/06-web/05-backtest.md`（L2 区域表 normative）+ 
`design/08-backtest/01-engine-adr.md` §7（API，经 `design/07-app-plane/00-web-api.md` §1.5 落库）。TDD，不 commit。

## What changed

### 新增（web/src/features/backtest/）
- `BacktestPage.tsx`：useState/useMemo + `BacktestStore` + `useSyncExternalStore`；RegionPortal 挂入
  `strategy-form`/`task-list`/`result-overview`/`metric-cards`/`trade-table`/`period-heatmap`/`compare-view`/`grid-rank` 锚点；
  提交回调经 store.submit → POST /api/backtest/runs（网格展开为任务组）；`onJumpToKline` → 跳 `/` 行情看板。
- `store.ts`：`BacktestStore`（strategies/runs/runDetail/compare/progressMap/submitting/submitError + resultView）；
  WS 订阅 topic `backtest`，`backtest_progress` 帧按 `run_id` 落 `progressMap`；`gridGroups()` 聚合网格任务组。
- `StrategyForm.tsx`：策略下拉（GET /api/backtest/strategies 恰 7 款）+ **schema 驱动**参数表单（`ParamDef` 渲染，
  数值参数带「起:止:步长」网格覆盖输入）+ 周期/手续费%/最低费用/滑点bp + 提交。
- `TaskList.tsx`：GET /api/backtest/runs + WS 进度；状态（排队/运行中/完成/失败）+ 进度% + 当前回测日期；
  点已完成载入结果；勾选 2-N 进对比。
- `ResultOverview.tsx`：净值曲线 + 回撤曲线双 SVG（回撤区间着色，TradingView Overview 式）；用 GET /api/backtest/runs/{id}。
- `MetricCards.tsx`：8 项指标卡（NetProfit/MaxDrawdown/Sharpe/胜率/盈亏比/年化/总交易数/平均持仓）。
- `TradeTable.tsx`：交易明细（开平仓时刻/价/量/盈亏/持仓时长），排序+盈利/亏损筛选；点行 → onJumpToKline。
- `PeriodHeatmap.tsx`：月/周收益热力（净值序列客户端聚合；`数据不足一月` 占位；Freqtrade UI 式）。
- `CompareView.tsx`：2-N 次叠加净值曲线 + 指标并排表（GET /api/backtest/compare?ids=）。
- `GridRank.tsx`：网格任务组排行表（参数组合/总收益/夏普，按总收益或夏普排序；点行进单次详情）。
- `format.ts`：展示格式化（periodLabel/statusLabel/fmtTs/fmtIso/fmtPct/fmtMoney/fmtRatio/fmtPnl/deltaClass）。
- `chartUtils.ts`：轻量 SVG 映射（mapLine/lineFrom/areaBelow/extentOf；不引 echarts 新依赖）。

### 新增测试
- `store.test.ts`：init/WS 进度/selectRun/toggleCompare/submit 单&网格/submit 失败内联。
- `BacktestPage.test.tsx`：骨架区域齐备、策略下拉 schema、提交→POST body、网格展开、TaskList 状态/进度、
  ResultOverview 渲染 + MetricCards 8 卡、空态（无任务/无交易）。

### 修改
- `web/src/api/types.ts`：`BacktestStrategyDto`/`BacktestRunDto`/`BacktestParamDef`/`Metrics`/`Trade`/
  `BacktestNetValue`/`BacktestFee`/`BacktestSubmitReq`/`BacktestSubmitResp`/`BacktestStatus`；`BacktestPeriod` 复导出。
- `web/src/api/client.ts`：`ApiClient` + `getStrategies`/`submitRun`/`listRuns`/`getRun`/`compare`；
  `toBacktestSubmitBody()` 做 period 映射（1m→M1 等）+ params/params_grid 拆分 + fee/initialCapital snake_case + 缺省 from/to。
- `web/src/api/mock.ts`：7 款策略目录、mock 净值/指标/交易、网格展开（parse_range/expand_grid）、单 run & 网格提交，
  种子 run（done/running/pending/failed）；`MockOptions.backtestRuns` 注入。
- `web/src/ws/WsClient.ts`：`IN_TOPIC_ALIAS` 增 `backtest_progress → backtest`（后端帧 type 分发）。
- `web/src/App.tsx`：路由 `/backtest` → BacktestPage。
- `web/src/shell/navItems.ts`：⑤ 回测工作台 `enabled: true`（去 W3 置灰）。
- `web/src/shell/NavBar.test.tsx`：解锁断言更新（⑤ 为链接，W3 标签消失，仅⑥置灰）。
- `web/src/api/client.test.ts`/`mock.test.ts`/`ws/WsClient.test.ts`：回测端点契约测试。

## Architecture alignment

| 文件 | 层次 | 为什么 |
|---|---|---|
| `features/backtest/*` | Presentation（web 特性） | RegionPortal 挂入 tangle 骨架锚点（09-frontend §3）；业务组件手写视觉/数据获取 |
| `api/client.ts`/`types.ts`/`mock.ts` | Presentation（API 客户端/契约） | 前端 API 契约（camelCase 前端入参 → 后端 snake_case body 由 client 适配）；mock 契约模式 |
| `ws/WsClient.ts` | Presentation（WS 客户端） | 单连接 /ws 分发；回测进度复用既有 hub 通配订阅 + 客户端 run_id 过滤 |
| `layouts/BacktestGrid.tsx` | tangle 骨架 | **零改动**（铁律：改 props/结构需先改 design L3 再 tangle；本期未改） |

分层红线：未改后端/DB/SQL/Rust；未引新依赖（图表全轻量 SVG，复用 klinecharts 仅 K线主图，回测区零新增依赖）；
`BacktestGrid.tsx` 完整保留 tangle 标记与 props 契约。

## Problem solved / feature added

补齐页面⑤回测工作台的完整前端：策略目录下拉 + schema 驱动参数表单（数值网格「起:止:步长」→任务组）、
异步任务列表（状态/进度%/当前回测日期，WS 实时推进度）、结果区（净值/回撤双图）、8 项指标卡、交易明细表
（排序/筛选/跳 K 线）、月/周收益热力、2-N 次叠加对比、网格任务组排行。页面以 tangle 骨架 BacktestGrid 为基座
（区域→组件映射+锚点+尺寸类），业务组件经 RegionPortal 挂入，未改动骨架。

## Implementation approach (within approved architecture)

- **前端周期代码映射**：骨架 `BacktestPeriod`（1m/5m/15m/1d）≠ 后端（M1/M5/M15/D1）。client `submitRun` 内
  `BACKTEST_PERIOD_CODE` 映射，页面/骨架契约保持不变（不改骨架）。
- **params / params_grid 拆分**：骨架 `params: Record<string, number|string>`；client 按值类型拆分——数值进
  `params`，字符串「起:止:步长」进 `params_grid`（后端 application::params::expand_grid 展开）。
- **缺省区间**：骨架提交契约无 from/to；client 注入默认 `2026-01-01..2026-12-31`（RFC3339），后端要求闭开区间。
- **WS 进度**：store 订阅 topic `backtest`（通配），前端按 `run_id` 过滤；WsClient 增 `backtest_progress→backtest`
  入站别名，订阅出站帧 `{type:"subscribe", topic:"backtest"}`。
- **确定性 mock**：mock 净值/指标/交易由 run_id 哈希派发，复用 `rand01`；网格展开复刻后端笛卡尔积；
  `opts.backtestRuns` 可注入固定种子。
- **三态**：每区域组件骨架/空/错误+重试，对齐 L2 表；深色终端风 token 与 01-dashboard 基线一致。

## Test coverage

- `client.test.ts`（+7）：getStrategies、submitRun 单（period 映射/fee snake_case/默认 from/to）、grid 拆 params_grid、
  显式 from/to/initialCapital、listRuns 过滤、getRun、compare。
- `mock.test.ts`（+4）：7 款策略 schema、单 run 完成态（净值/指标/交易）、网格展开、四态种子 + compare 过滤。
- `WsClient.test.ts`（+1）：backtest 订阅出站 topic=backtest；入站 backtest_progress 分发到 backtest 订阅者。
- `store.test.ts`（+7）：init 载入 + WS 订阅、WS 进度 progressMap、selectRun、toggleCompare、submit 单/网格/失败。
- `BacktestPage.test.tsx`（+8）：区域齐备、策略 schema、提交 body、网格展开、TaskList WS 进度、结果区+指标卡、空态×2。
- `NavBar.test.tsx`：解锁断言更新（⑤ 为链接）。
- 既有 191 项测试全部保持绿草（无回归）。

## Verification

- `cd web && npx vitest run`：27 文件 218 项全部通过。
- `cd web && VITE_API_MOCK=0 npm run build`：tsc -b + vite build 通过（`dist/assets/index-*.js` 550KB 异步 chunk 提示为既有，非本次引入）。
- `npx tsc -b`（无输出）：TypeScript 严格模式（strict/noUnusedLocals/noUncheckedIndexedAccess）零错误。
- `git diff --stat web/src/layouts/BacktestGrid.tsx`：**无变更**（骨架零改动）。

## 残留风险

- **WS 订阅为通配 + 客户端过滤**：WsClient 不支持后端 `run_id` 订阅帧，页面以 `topic:"backtest"` 通配订阅，
  服务器推送全部回测进度到该连接，由 store 按 run_id 过滤。单页面下无碍；若未来同连接存在多个回测页面需复核（本期范围外）。
- **缺省回测区间固定 2026 全年**：UI 未提供日期输入（骨架契约无 from/to），client 注入默认窗口。若实际数据窗口
  与该默认窗口不符，运行会「区间无 K 线 bar」failed（真实后端）；mock 不校验。建议后续从提交表单暴露 from/to。
- **Mock 单 run 提交即完成态**：mock `submitRun` 立即生成 `done` run（便于列表/结果区演示）；真实后端为异步任务制。
  pending/running/failed 态由种子 run 呈现或 `opts.backtestRuns` 注入。
- **GridRank 总收益用 `net_profit/100000` 近似**：展示层用初始资金 10 万近似百分比；真实百分比应由后端 metrics
  或 run.params 携带 initial_capital 精确换算（本期为近似，口径在后端单测锁定）。
- **PeriodHeatmap 端点聚合口径**：以「周期内首末 equity 差/首」近似月/周收益；Freqtrade 式季节性仅示意，
  未复刻逐 bar 复利口径（后端 metrics 为权威）。
- **compare 依赖 done 态**：compare 视图只展示 done run；若勾选中有 pending/running（checklist 仅 done 才有复选框），
  compare 会缺少该行（前端宽容）。

## 暂存文件清单

按父级验收门禁 `noStagedFiles: true`，**未执行 `git add`**，所有改动保留在工作树（未提交），待父级审查。涉及文件：

新增：`web/src/features/backtest/{BacktestPage,store,StrategyForm,TaskList,ResultOverview,MetricCards,TradeTable,PeriodHeatmap,CompareView,GridRank,format,chartUtils}.ts(x)`、
`web/src/features/backtest/{store.test.ts,BacktestPage.test.tsx}`。
修改：`web/src/App.tsx`、`web/src/shell/{navItems.ts,NavBar.test.tsx}`、
`web/src/api/{types.ts,client.ts,mock.ts,client.test.ts,mock.test.ts}`、
`web/src/ws/{WsClient.ts,WsClient.test.ts}`。
