# 141 【UI 修复】回测工作台运行历史无界增长覆盖配置区

- 报告位置：`coder/report/141_workbench_run_history_bounded_layout.md`
- 范围：仅 `web/` 前端（页面⑪ 回测工作台），TDD（先 Red 后 Green），git add 未 commit。

## 问题

/backtest-workbench 左列（配置区 + 运行历史）整列 `overflow-y-auto`，运行历史行直接挂在列内无界增长。真实环境 100+ 条历史时，长列表把配置/操作区顶出可视区，用户需长时间滚动才能回到配置区，页面实操受阻。此外 store 分页单页 limit=100，首屏即渲染 100 条 DOM。

## 修复点

### 1. 历史区有界化（布局结构）

`WorkbenchPage.tsx` 左列重构为「配置区内部滚动 + 历史区有界」flex 列（参照仓内 `flex-1 min-h-0 overflow-y-auto` 滚动面板惯例，如 dashboard/SymbolList）：

- 左列 `wb-left-col`：`flex min-h-0 w-[380px] shrink-0 flex-col`，**移除整列 `overflow-y-auto`**；
- 配置区包装：`min-h-0 flex-1 overflow-y-auto`——配置区占剩余空间（≥55%），超高时自身内部滚动，不被历史挤压、始终完整可操作；
- 历史区包装 `wb-run-history`：`flex max-h-[45%] shrink-0 flex-col border-t`——条数少时自然高度，条数多时封顶视口 45%；
- `RunList.tsx` 根改为 `flex min-h-0 flex-1 flex-col`；新增内部滚动容器 `wb-run-list-scroll`（`min-h-0 flex-1 overflow-y-auto`）承载骨架/历史行/空态；标题栏（含刷新）与「加载更多」分页控件 `shrink-0` 固定在滚动容器外，滚动历史时保持可见；
- 右列补 `min-h-0`（`min-h-0 min-w-0 flex-1`），保证 ResultView 内部 `h-full overflow-auto` 生效，内容高度变化不反向影响左列。

### 2. 分页 / DOM 有界

后端 `GET /api/workbench/runs` 契约核查：`api/client.ts:485-492` 已支持 `status/limit/offset`（limit/offset 分页，非 page/page_size），契约 mock `api/mock.ts listWorkbenchRuns` 同口径 `slice(offset, offset+limit)`。store 此前已接「加载更多」（`loadMoreRuns` 累计 offset 追加、`hasMore = 条数==limit`），本次将单页 `runLimit` 100 → **50**（`store.ts`，注释更新）：首屏 DOM 封顶 50 行，不一次性渲染全部历史；余量走「加载更多」。既有 store 分页测试不受影响（种子 4 条 < 50，仅同步注释）。

### 3. 顺手核查：选中历史项布局稳定性

新增回归测试：选中历史行后左列 `wb-left-col` 类名逐字符不变、`wb-config`/`wb-run-history` 均在 DOM——结果视图（右列）内容高度变化不会把配置区顶走（左右列互为独立 flex 项 + `min-h-0`）。

## 架构对齐

全部改动位于 web 前端 features 层（页面⑪ workbench 模块）：
- `WorkbenchPage.tsx` / `RunList.tsx`：组件层布局（Tailwind class 重组，无接口变更——RunList props 签名未动）；
- `store.ts`：仅私有字段 `runLimit` 常量值调整（100→50），无状态机/契约变更；
- 未触碰 API 契约、WS 协议、后端代码。

## 测试覆盖（TDD：Red→Green）

新增（先写、确认 6 项失败，再实现转绿）：
- `RunList.test.tsx`（新文件，3 例）：200 条 mock 注入，断言 `wb-run-list-scroll` 有界滚动类（`min-h-0`/`flex-1`/`overflow-y-auto`）、行在容器内、标题栏与加载更多在容器外、空态/骨架也在容器内；
- `WorkbenchPage.test.tsx` 新 describe「运行历史无界增长覆盖配置区 回归」（3 例）：
  1. 200 条后端数据（limit/offset 契约 mock）：首屏仅渲染 50 条行 DOM（`< 200`）、分页控件存在、左列无整列滚动且 `min-h-0`、`wb-run-history` 有 `max-h-`、`wb-config`+`wb-submit` 可见；
  2. 加载更多：offset=50 追加第二页（50→100 条），配置区布局不受影响；
  3. 选中历史项后左列类名不变、配置区仍在（布局稳定）。

更新：`store.test.ts` 一处注释同步（limit 100→50），未削弱任何既有断言。

## 验证

- `npx vitest run src/features/workbench`：6 文件 58 例全绿（Red 阶段新 6 例失败→Green 后全过）；
- `npm run build`（tsc -b && vite build）：0 error；
- `npm test` 全量：47 文件 457 例全绿。

## 前后对比

- 前：左列整列滚动，历史 100+ 条无界增长把配置/操作区顶出可视区；首屏一次性渲染至多 100 条行 DOM。
- 后：左列不滚动；配置区 ≥55% 视口高且自身可滚动；历史区封顶 45% 视口高、内部滚动，标题/刷新/「加载更多」固定可见；首屏 DOM 封顶 50 行，翻页加载更多。

## 暂存

`git add` 已暂存（未 commit）以下 6 个文件：
`web/src/features/workbench/{WorkbenchPage.tsx, RunList.tsx, store.ts, RunList.test.tsx, WorkbenchPage.test.tsx, store.test.ts}`
（工作区另有其他会话先前暂存的文件，如 `web/src/api/index.test.ts`、`coder/report/139_*.md` 等，非本任务产物。）
