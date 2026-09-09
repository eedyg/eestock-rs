# 117 — P2b 策略管理前端 reviewer 修复包（10 项，前端为主）

> 本报告位置：`eestock-rs/coder/report/117_strategy_registry_p2b_review_fixpack.md`
> 任务：12-strategy-system / P2b reviewer findings 修复包（前一次启动因引擎 429 零产出，本任务为原样重试）。
> 红线遵守：**未改 crates/、design/、migrations/ 任何文件**；改动限于 web/ 前端 + coder/report。

## 1. 修复 → 测试证据对应表

| # | 修复 | 实现位置 | 测试证据（先红后绿） |
|---|---|---|---|
| MINOR-1 | 徽章与 approval at-least 过滤口径改为 `latest_published?.approval_level ?? latest_version?.approval_level` | `StrategiesPage.tsx`（过滤 useMemo + 权限徽章列 + 头注释） | `StrategiesPage.test.tsx`：「MINOR-1（裁决口径）…徽章 sim_ok」（双均线行 v1 published/sim_ok + v2 draft/backtest_ok → 显示「模拟可用」；仅 draft 策略回退 latest_version）；既有 kind/approval 过滤测试订正为 sim_ok 过滤后双均线行不隐藏（57-58 行悬而未决注释订正为定稿口径） |
| MINOR-2 | 零版本策略渲染空态提示（`editor-empty`），不再永久骨架屏 | `StrategyEditorPage.tsx`（骨架/空态分支拆分） | `StrategyEditorPage.test.tsx`「MINOR-2：零版本策略 → 渲染空态提示」 |
| MINOR-3 | mock 保存时（draft 原地 + published→new_draft 两分支）简易正则重解析 PARAMS_SCHEMA；解析失败置空数组（注释注明与后端 extract_schema 对齐意图） | `mock.ts` `mockExtractParamsSchema` + `updateStrategyVersion` | `mock.test.ts`「MINOR-3：保存时重解析…」；`StrategyEditorPage.test.tsx`「MINOR-3：published 保存后…参数面板/试算参数即时更新」（bias 键出现在参数面板与 `tr-param-bias`） |
| MINOR-4 | mock runStrategyTest 复刻后端区间上限（D1≤1830 天 / 分钟级≤93 天 → 400） | `mock.ts` `runStrategyTest` | `mock.test.ts`「MINOR-4：试算区间上限…」（D1 五年内 OK / 超 5 年 400 / **M1+1 年区间 400** / M1 三月内 OK） |
| NIT-1 | mock patchStrategy 校验顺序对齐后端：先 400（空 patch/name trim 空）后 404 | `mock.ts` `patchStrategy` | `mock.test.ts`「NIT-1：patch 校验顺序…」（未知 id + 空 patch → 400；未知 id + 合法 patch → 404） |
| NIT-3 | meta 保存成功后 `setName(updated.name)/setDesc(updated.description)` 回填 trim 后值，metaDirty 复位 | `StrategyEditorPage.tsx` `handleMetaSave` | `StrategyEditorPage.test.tsx`「NIT-3：meta 保存成功后回填 trim 后值并复位」（输入尾部空格 → 回填 trim 值 + 保存按钮禁用） |
| NIT-4 | draft 原地保存（outcome=updated）后刷新 versions（sha256/schema 摘要即时更新） | `StrategyEditorPage.tsx` `doSaveCode` updated 分支 | `StrategyEditorPage.test.tsx`「NIT-4：draft 原地保存后刷新版本列表」（getStrategyVersions 调用 1→2 次、sha256 文案变化、参数面板即时显示新 schema 键） |
| NIT-5 | ScoreChart marks 预建 ts→index Map（O(m×n) → O(m+n)） | `ScoreChart.tsx` | 新增 `ScoreChart.test.tsx`（信号 ts 对齐/未知 ts 跳过/hold 不渲染/null 熔断断线）——行为锁定下重构，测试始终绿 |
| NIT-6 | 版本下拉旁加「派生 draft」按钮（`createStrategyVersion(strategyId, currentVid)`，任意版本含 archived 可派生，派生后刷新并切换） | `StrategyEditorPage.tsx` `handleDeriveDraft` + 头部按钮 | `StrategyEditorPage.test.tsx`「NIT-6：…任意版本（含 archived）可派生并切换」（归档 v1 后按钮可用 → 调用参数断言 → 版本数 2→3、徽章转草稿） |
| NIT-2 | coder/report/116 §3 「kind 过滤走后端参数」订正为客户端过滤事实 | `coder/report/116_strategy_registry_p2b_frontend.md` §3（同时订正 `StrategiesPage.tsx` 头注释同款表述） | 文档订正，无测试（事实核对：`refresh()` 调 `getStrategyManageList()` 无参数，kind 在 `visible` useMemo 本地过滤） |

## 2. 架构对齐

- `mock.ts` 属 API 契约层（四件套之契约 mock）：MINOR-3/MINOR-4/NIT-1 均为 mock 行为与后端语义对齐
  （对照后端 `application/src/strategy.rs`：`extract_schema` 保存即重解析、`update_meta` 先 400 后 404、
  `test_run` 区间上限 `D1_MAX_SPAN_DAYS=366*5` / `MINUTE_MAX_SPAN_DAYS=93`），未动任何接口签名。
- `StrategiesPage.tsx`/`StrategyEditorPage.tsx`/`ScoreChart.tsx` 属特性层（features/strategies），
  只改组件内部渲染/交互，未动路由、ApiClient 接口、类型契约。
- `mockExtractParamsSchema` 正则解析为 mock 专用降级方案（mock 无法执行 JS）；解析失败置空数组并注释，
  不影响真实后端行为。draft 原地分支一并重解析（与后端 extract_schema 每次保存均执行同口径；
  任务书点名 new_draft 分支，draft 分支为同函数内同语义顺带对齐，无范围外扩散）。

## 3. 测试与验证

- Red：先加/改 10 项测试，运行确认 10 个失败（ScoreChart 2 个新测试为行为锁定，始终绿）。
- Green：实现后 `npx vitest run src/features/strategies src/api/mock.test.ts` → **7 文件 78 测试全绿**。
- 全量：`npm run build` → **0 error**（`tsc -b && vite build`，built in 1.78s）；
  `npm test` → **431 passed / 7 failed**，7 个失败全部位于 `features/alerts/`（AlertsPage WS 推送 1 +
  store ack/WS/重试 6），为任务书允许的 pre-existing 失败，与本次改动无关（未触碰 alerts 任何文件）。
- `git add` 已暂存本次全部改动文件（不 commit）；`git diff --cached` 核对无范围外文件被本次暂存
  （crates//design/ 下的 ` M` 未暂存修改为上游后端任务遗留，保持原样未触碰）。

## 4. 变更文件清单

- `web/src/api/mock.ts`（MINOR-3/4、NIT-1）
- `web/src/api/mock.test.ts`（+3 契约测试）
- `web/src/features/strategies/StrategiesPage.tsx`（MINOR-1 + 头注释订正）
- `web/src/features/strategies/StrategiesPage.test.tsx`（+1 测试、订正 1 测试）
- `web/src/features/strategies/StrategyEditorPage.tsx`（MINOR-2、NIT-3/4/6）
- `web/src/features/strategies/StrategyEditorPage.test.tsx`（+5 测试）
- `web/src/features/strategies/ScoreChart.tsx`（NIT-5）
- `web/src/features/strategies/ScoreChart.test.tsx`（新增，+2 测试）
- `coder/report/116_strategy_registry_p2b_frontend.md`（NIT-2 订正 §3）
- `coder/report/117_strategy_registry_p2b_review_fixpack.md`（本报告）

## 5. 残余风险

- mock 正则 schema 解析仅覆盖 `key/type/default/min/max/description` 数字与双引号字符串字面量；
  单引号/模板串/嵌套结构会落到「解析失败置空」，与后端 QuickJS 真解析存在能力差（mock 定位可接受）。
- NIT-6 派生按钮在 dirty 时用 window.confirm 防丢稿；e2e 未覆盖（e2e 需真容器，超出本修复包范围）。
