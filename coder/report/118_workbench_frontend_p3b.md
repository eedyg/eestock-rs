# 118 — P3b 回测工作台前端页（/backtest-workbench）+ P3a NIT-2 注释杂务

- 报告位置：`coder/report/118_workbench_frontend_p3b.md`（本文件）
- 范围：eestock-rs/web 前端新页 `features/workbench/` + API/WS/mock 契约层加法 + 路由/导航；`crates/strategy-core` 纯注释对齐（NIT-2）。

## 1. 变更文件

**新增（web/src/features/workbench/）**
| 文件 | 职责 |
|---|---|
| `store.ts` | WorkbenchStore 状态机（catalog/presets/symbols/runs 分页/result/compare/progressMap；WS strategy_run 订阅） |
| `ConfigPanel.tsx` | 配置区：策略多选下拉→slot 卡片（权重+params_schema 参数表单）、阈值 60/40、ExecutionPolicy（LumpSum/DCA）、硬止损（可选）、初始资金、费用、标的+周期+区间、组合预设（选中回填/保存/重命名/删除） |
| `RunList.tsx` | 运行历史（状态/进度/时间 + 进度条 + 取消按钮 + compare 勾选 + 分页加载更多；失败行显 error） |
| `ResultView.tsx` | 结果容器（ADR §13.5 布局 + Tab：交易明细/8项绩效/逐bar评分/事件日志） |
| `KlineResultChart.tsx` | K线+买卖标记（复用看板 KlineChart + ScopedKlineFeed；B/S/⊗ 止损不同图标） |
| `AggregateScoreChart.tsx` | 总分曲线（60/40 阈值虚线 + buy/hold/sell 三区着色） |
| `SlotScoresChart.tsx` | 各策略评分曲线（图例 checkbox 开关，默认前 3；熔断 bar 断线） |
| `EquityDrawdownChart.tsx` | 净值+回撤双曲线 |
| `PerBarTable.tsx` | 逐 bar 评分表（分页 100/页，全量不抽样） |
| `EventLog.tsx` | 事件日志（plugin_error/circuit_breaker/plugin_log/fill；渲染上限 1000 截尾） |
| `ComparePanel.tsx` | compare 模式：净值叠加图 + 8 项绩效并排表（≤4） |
| `WorkbenchPage.tsx` | 页面组装（左列配置+历史 / 右列结果|compare） |
| `chartUtils.ts` | downsample（ADR §13.4 UI 抽样，图表 ≤2000 点）+ re-export 页面⑤ chartUtils |

**修改**
- `web/src/api/types.ts`：+WorkbenchSubmitReq/RunView/RunResult/BarRecord/EngineEvent/CompareItem/PresetRow/PresetConfigInput/Policy/Stop/Fee 等 §1.8 契约类型（snake_case 透传，WorkBenchMetrics 复用既有 Metrics 别名）。
- `web/src/api/client.ts`：ApiClient +11 方法（runs submit/list/get/result/cancel/compare + presets CRUD/apply）；HTTP impl。
- `web/src/api/mock.ts`：契约 mock（同构后端 400/404/409 语义；submit 钉住 config：slots 展开 strategy_id/version/sha256 + params 按 schema 缺省填充；种子四态 runs + 确定性结果生成含 StopTrigger/plugin_error 素材；presets 重名 409）。
- `web/src/ws/WsClient.ts`：IN_TOPIC_ALIAS + `strategy_run_progress → strategy_run`（订阅 topic=strategy_run 通配，页内按 run_id 过滤；与 backtest_progress 同模式）。
- `web/src/App.tsx`：+ `/backtest-workbench` 路由（旧 /backtest 不动，并存期 D16）。
- `web/src/shell/navItems.ts`：+ `⑪ 回测工作台`。
- `web/src/features/dashboard/KlineChart.tsx`：KlineMarkerOverlay.text `'B'|'S'` → `string`（宽化、向后兼容；止损标记 '⊗'）。影响面 grep 核查：extendData 透传 simpleAnnotation，仅 TradeDetailModal 构造 B/S，无破坏。
- `crates/strategy-core/src/engine.rs` 模块头：8 步清单 + 第 9 步（observer 钩子，P3a NIT-2）；`src/lib.rs` 管线图同步 + 第 10 项。**纯注释，零逻辑变更**。
- 测试更新：`NavBar.test.tsx`/`AppShell.test.tsx` 导航项 10→11（有意变更）；其余均为新增测试。

**新增测试**
- `features/workbench/store.test.ts`（10）：init/WS 进度/progress≥1 重捞翻终态/selectRun(succeeded vs failed)/submit 成功+400/cancel+409/compare ≤4 截断与 ≥2 进视图/presets 闭环/分页。
- `features/workbench/ConfigPanel.test.tsx`（9）：catalog 下拉+slot 卡片/空 slots 拒绝/阈值倒挂/schema 越界+权重/默认提交形状/DCA+止损序列化/预设回填+保存/重命名删除/catalog 错误重试。
- `features/workbench/ResultView.test.tsx`（7）：三态/布局齐备（阈值线+三区+图例+净值+Tab）/Tab 切换/逐bar分页 250→3页/图例开关/buildMarkers B/S/⊗/loading+404。
- `features/workbench/WorkbenchPage.test.tsx`（8）：骨架/提交全流程/400 友好提示/WS 进度 42%→87%/取消翻终态/选中渲染结果/compare 勾选+退出/预设保存-回填-删除闭环。
- `features/workbench/chartUtils.test.ts`（3）：downsample 首尾保留/升序/边界。
- `api/client.test.ts` +6、`api/mock.test.ts` +6、`ws/WsClient.test.ts` +1。

## 2. 架构对齐

- 全部前端改动在 `web/src`（Presentation），经既有 `ApiClient`/`WsClient` 抽象访问后端；未动 crates/ 逻辑、design/、migrations/（仅 strategy-core 注释杂务为任务书明示项）。
- 状态机复用 BacktestStore 模式（外部 store + useSyncExternalStore + fakeWs emit 测试）；页面未引入 tangle 骨架（工作台无既有 Grid 骨架，与后端 workbench.rs 非 tangle 手写同例）。
- 无新 npm 依赖：图表全部轻量 SVG（chartUtils）+ 复用 klinecharts（K线）。

## 3. 复用说明

- `features/dashboard/KlineChart` + `features/backtest/ScopedKlineFeed`（区间取数）→ 结果页 K线。
- `features/backtest/chartUtils`（mapLine/areaBelow/extentOf/evenTickIndices）、`features/backtest/format`（fmtTs/fmtPct/fmtMoney/fmtRatio/fmtIso/periodLabel/periodCodeToPeriod）直接复用。
- params_schema 参数表单校验与 TestRunPanel 同口径（数值/整数/min/max）。
- `test/apiStub.ts` + `api/mock.ts` 契约 mock 模式；klinecharts jsdom 打桩同 BacktestPage.test。

## 4. 测试矩阵与验证

- `npm run build`（tsc -b + vite build）：**0 error**（✓ built in 1.76s）。
- `npm test`：**481 passed / 7 failed**——7 个全部为 `features/alerts` pre-existing 失败（干净树基线验证：stash -u 后 alerts 单跑 7 failed / 10 passed，与本变更无关；任务书允许）。
- `cargo test -p strategy-core`：82 passed / 0 failed（NIT-2 注释杂务后零回归）。

## 5. 歧义与处理

1. **mock 的 submit 时序**：契约 201 返回 queued 行、异步执行；mock 采用旧回测 mock 先例「同步落 succeeded + 结果可取」（进度/终态流转由 WS 测试桩覆盖）。已在 mock 注释注明。
2. **预设 create 的 config 形态**：后端 validate_preset_config 接受未钉住 slots（{version_id,params,weight}）并自行钉住——前端新增 `WorkbenchPresetConfigInput` 类型（钉住形态 WorkbenchRunConfig 可直接赋值）。
3. **导航重名**：旧 ⑤ 与新增 ⑪ 均标「回测工作台」（任务书指定文案）；以序号前缀区分，P4 后旧入口隐藏（D16）。
4. **K线叠加策略指标线**：ADR §13.5 明示为 P3 可选裁剪项——本次裁剪，未实现。
5. **失败 run 无 WS 终态帧**：行状态靠选中/手动刷新兜底（与旧回测页同口径），store 注释注明。

## 6. 遗留风险

- 分钟级长区间 per_bar 数万点：图表已抽样（≤2000 点），逐bar表分页（100/页），事件日志截尾 1000——均无全量 DOM 渲染；K线走 ScopedKlineFeed 区间+分页取数，无前兆性能风险。
- WS 订阅用通配（topic=strategy_run 无 strategy_run_id 过滤），页内按 run_id 分发；多页同开时帧量略增（后端通配语义支持，§1.8）。
- gitnexus MCP 工具本会话不可用，KlineChart 宽化的影响面以 grep 核查代替 impact 分析（改动为类型宽化+透传，无行为变化）。
