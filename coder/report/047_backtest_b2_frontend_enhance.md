# 回测前端增强（B2）变更报告

> 本文件位置：`eestock-rs/coder/report/047_backtest_b2_frontend_enhance.md`

## 需求（来自父 orchestrator）

1. **StrategyForm**：加「初始金额」数字输入（默认 100000，可改）+「回测区间」from/to 日期输入（默认近一年/全历史）；提交 body 带 `initial_capital`/`from`/`to`。校验：金额>0；from<to。周期仍 1m/5m/15m/日。
2. **api client/types**：`submitRun` body 增 `initial_capital/from/to`（类型已具备，验证序列化）；`deleteRun(id)` 调 `DELETE /api/backtest/runs/{id}`；types 加 `RunDto.initial_capital/date_from/date_to`。
3. **TaskList**：每行加删除按钮（done/failed 可删）→ 二次确认 → `deleteRun(id)` → 列表移除（本地 state）；删除后若选中该 run 的结果区清空。
4. **ResultOverview**：净值+回撤 SVG 图加**时间 x 轴**（≥3 刻度、均匀分布、可读；无 ts 占位）。

## 已解决的实现歧义（按上述实现并注明）

- **删除范围**：仅 done/failed（终态）提供删除按钮；running/pending 不提供（任务执行中，避免误删运行中任务）。task 原句「done/failed 可删；或全部可删」取前一种保守口径。
- **初始金额默认值**：100000（task 指定）；已允许任意正数，非法（≤0）内联报错不提交。
- **回测区间默认**：to=今天、from=近一年（「近一年或全历史」取近一年）。
- **from/to 提交格式**：由 `YYYY-MM-DD` 经 `dayToIso` 转为 RFC3339 当日 00:00:00 UTC（与 client 既有默认 `DEFAULT_BT_FROM/TO` 的 RFC3339 口径同构），避免后端期望 datetime 时收到 date-only 造成歧义。
- **删除确认交互**：采用**内联二次确认**（点删除→同列出现「确认/取消」），避免 `window.confirm` 需在 jsdom 额外 mock，测试更可控。
- **时间轴刻度规则**：`evenTickIndices(series.length, 5)` 等距取样（去重后升序），目标约 5 个刻度（满足「4-6 个」）；跨度 <31 天用日粒度（`YYYY-MM-DD`），否则月度（`YYYY-MM`）；ts 无效/非正 → `'—'` 占位。
- **x 轴用 UTC 日期口径**（区别于 `fmtTs`/`fmtIso` 的 +8 展示），避免时区漂移导致日期偏格；测试基于 `Date.UTC(…)` 确定性校验。

## 改动清单（文件 + 行数）

### `web/src/api/*`
- `types.ts`：`BacktestRunDto` 增 `initial_capital?: number`、`date_from?: string`、`date_to?: string`（后端线格式 snake_case）。(+6)
- `client.ts`：`ApiClient` 接口增 `deleteRun(id: number): Promise<void>`；`createHttpClient` 实现 `deleteRun`（`DELETE /api/backtest/runs/{id}`，非 2xx 解析 `{error}` 抛 `ApiError`，容错空/204 响应体）。`submitRun` 的 `toBacktestSubmitBody` 已支持 `from/to/initial_capital`。(+18)
- `mock.ts`：`deleteRun` 实现（从内部 `backtestRuns` 移除；不存在抛 `ApiError 404`）。(+6)
- `client.test.ts`：增 `deleteRun` 用例（DELETE 方法 + URL 正确；404 透传）。(+12)
- `mock.test.ts`：增 `deleteRun` 用例（删除后 list 不再出现；不存在 404）。(+11)

### `web/src/features/backtest/*`
- `StrategyForm.tsx`：增 `initialCapital`（默认 100000）+ `dateFrom/dateTo`（默认近一年）状态；`handleSubmit` 先做金额>0、from<to 校验（不通过→内联 `form-error`，不提交）；提交 `onSubmit` 带 `initialCapital/from/to`；渲染「初始金额 / 回测区间」输入区。(+77)
- `TaskList.tsx`：增 `onDeleteRun` 必填 prop；增内联删除状态 `confirmId/deletingId/deleteError` 与 `handleConfirmDelete`；done/failed 行渲删除→确认/取消；顶部删失败全局错误行 `task-delete-error`。(+60)
- `BacktestPage.tsx`：给 `TaskList` 传 `onDeleteRun={(id) => store.deleteRun(id)}`。(+1)
- `store.ts`：增 `async deleteRun(id)`（调 `api.deleteRun` 成功后从 `runs.data` 移除、`compareIds` 剔除、若选中则清 `selectedRunId/runDetail`，compare <2 → resultView single；rethrow 供 TaskList 显示错误）。(+17)
- `format.ts`：增 `fmtAxis(ts, includeDay)`（`YYYY-MM` / `YYYY-MM-DD` / `'—'`）。(+10)
- `chartUtils.ts`：增 `evenTickIndices(n, count)`（含首尾等距取样、去重）。(+11)
- `ResultOverview.tsx`：增时间 x 轴（基于 `evenTickIndices`+`fmtAxis`，底部 `<div data-testid="chart-x-axis">` 渲染刻度标签）；回撤图例上移避免重叠。(+28)

### 测试文件（新增/扩展）
- `StrategyForm.test.tsx`（**新增**）：初始金额→`initialCapital`；from/to→`from/to`；金额≤0 & from≥to → 内联错误不提交。
- `TaskList.test.tsx`（**新增**）：删除→确认→行消失；取消不删；404 错误提示。
- `store.test.ts`（扩展）：`deleteRun` 删除并清结果区；不存在 rethrow。
- `ResultOverview.test.tsx`（扩展）：含 ts → ≥3 时间刻度；ts 全 0 → 占位 `'—'`。

## 架构对齐

- 所有改动集中在 `web/src/api/*`（client/types/mock，契约与传输层）与 `web/src/features/backtest/*`（页面⑤展示/状态机），未触碰后端/Rust/DB/SQL/其他 feature。
- `store.deleteRun` 延续既有 `loadRuns/selectRun` 的受控状态机模式；TaskList 仍为受控组件（`runs` 来自 store），删除成功后由 store 移除行，符合现有单向数据流。
- x 轴刻度逻辑拆分到 `chartUtils.ts`（纯函数）+ `format.ts`（格式化），与既有 `mapLine/extentOf` 作图工具分层一致。

## 测试覆盖与验证

- 新增/扩展单测：client.deleteRun、mock.deleteRun、StrategyForm（4）、TaskList（3）、store.deleteRun（2）、ResultOverview x 轴（2）。
- `npx vitest run`：**239 passed（31 files）**（基线 226 → 新增 13）。
- `VITE_API_MOCK=0 npx tsc -b`：**通过（exit 0）**。
- `VITE_API_MOCK=0 npx vite build`：**通过（exit 0）**（仅既有 chunk>500k 警告，非本次引入）。

## 重新确认「无效初始金额」行为的一个关键点

`initial-capital` 输入起初带 `min="1" step="1000"`，这使默认 100000 触发原生表单约束校验（stepMismatch），导致原生校验在 React `onSubmit` 前拦截表单提交（`userEvent.click` 不触发提交，但 `fireEvent.submit` 触发）。已将该输入的 `min/step` 移除，改为由 JS 校验（>0），使默认值与用户输入都能正常提交、非法值能内联报错。此为本次修复的关键。

## 残留风险

- 未运行 `gitnexus_impact/detect_changes`（当前子代理环境无 GitNexus MCP 工具）；本改动 blast-radius 局限于页面⑤与回测 API 契约层，BacktestPage/store 单测已覆盖交互闭环。
- `deleteRun` 的 `client` 实现采用独立 fetch（非复用 `request`），以容错 204/空响应体；后端若返回非 2xx 且 body 非 JSON（如 text/plain）时仅显示 `HTTP <status>`，不解析文本。
- x 轴以 UTC 日期口径展示；若未来需工具化/中国时区对齐，可切换 `fmtAxis` 的 +8 口径（不影响测试，DDL 不锁定时区）。
- 日期默认值基于浏览器本地时区 `new Date()`（跨天边界会有 ±1 天差异）；测试通过显式赋值规避。
- 删除仅提供 done/failed；若业务希望允许全量删除（含 running/pending，且处理 WS 进度残留），需扩展。

## 验证命令输出摘要

```
vitest: Test Files 31 passed (31), Tests 239 passed (239)
tsc -b:  exit 0
vite build: exit 0 (dist 产出，仅 554kB chunk 预警)
```

## 报告位置

本文件：`eestock-rs/coder/report/047_backtest_b2_frontend_enhance.md`
