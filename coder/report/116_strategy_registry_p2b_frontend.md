# 116 — P2b 策略管理前端（列表页 + 编辑器 + 试算面板 + 版本 diff）

> 本报告位置：`eestock-rs/coder/report/116_strategy_registry_p2b_frontend.md`
> 任务：12-strategy-system / P2b — eestock-rs 统一策略系统策略管理前端（web/）。
> 红线遵守：未改后端任何文件（crates/、migrations/、design/ 零触碰）。

## 1. 问题/需求

ADR 12-strategy-system §5/§13.5（D13）定稿的 Web 交互落地：策略列表页 `/strategies`、
策略编辑器 `/strategies/:id/edit`（CodeMirror 6 + 保存防呆 + 参数 schema + 指标文档侧栏 +
双模式试算 + 版本 diff），路由/导航接入，契约 mock + 单元测试 + 主流程 e2e。

## 2. 歧义与处理（intercom 裁决 2026-09-09）

| 缺口 | 裁决 | 落地 |
|---|---|---|
| 列表页需「含 draft 的最新版本状态/版本数」，catalog 仅 published | 选 A：后端补 `GET /api/strategies/manage`（{items:[...version_count, latest_version, latest_published]}；?kind=） | 后端 worker 并行落地（报告 115）；前端类型按裁决契约锁定并已与 backend diff 核对一致 |
| 编辑器头部「名称/描述编辑」无持久化端点 | 选 A：后端补 `PATCH /api/strategies/{id}`（{name?, description?} 至少一字段） | 同上 |

## 3. 变更文件

**API 契约层（src/api/，遵循既有「types + client 接口 + http 实现 + 契约 mock」四件套模式）**：
- `types.ts`：+StrategyStatus/ApprovalLevel/Kind、StrategyRowDto、StrategyParamDef、
  StrategyVersionRowDto、StrategyCatalogEntry、StrategyManageItem（+VersionBrief）、
  StrategyCreateReq/Resp、StrategyPatchReq、StrategyUpdateOutcome、StrategyDiffResp、
  StrategyTestRunReq/Resp（ScorePoint/SignalPoint/TradeDetail/TestEvent/Truncation）。
- `client.ts`：ApiClient +11 方法（getStrategyManageList / getStrategyCatalog / createStrategy /
  patchStrategy / getStrategy / getStrategyVersions / createStrategyVersion / updateStrategyVersion /
  publishStrategyVersion / archiveStrategyVersion / diffStrategyVersions / runStrategyTest）+ http 实现
  （versionId → version_id 蛇形转换；manage/catalog 查询参数序列化）。
- `mock.ts`：策略内存仓（种子：双均线 published v1+draft v2、纯评分模板 published、仅 draft 策略），
  全 11 方法行为同构后端（at-least 过滤、published 编辑自动落新 draft、状态机 409、门禁占位 on_bar 检查、
  test-run 确定性评分序列/双模式输出/截断标记）。
- `mock.test.ts`：+5 个契约测试（manage 口径/catalog 过滤/流转/update_draft 双分支/diff+test-run 校验）。

**特性层（src/features/strategies/，参照 backtest/simlive 扁平组件组织）**：
- `StrategiesPage.tsx`：列表页（data-region=strategies）。manage 列表表格（名称/类别/最新版本状态徽章/
  权限徽章/版本数/更新时间/操作）；kind 为前端客户端过滤（manage 全量拉取后本地过滤，未用后端 ?kind= 参数）、
  approval 前端 at-least 过滤（UI 注明语义）；
  新建策略弹窗入口；操作：编辑（Link）/ 新建版本（派生 draft 后进编辑器）/ 归档（仅最新 published 可点，confirm + 409 内联）。
- `CreateStrategyModal.tsx`：名称/描述 + 来源单选（空白骨架代码 / 从模板创建——catalog kind=template 下拉，
  创建后 code 预填模板代码并跳编辑器）；空名内联校验。
- `StrategyEditorPage.tsx`：头部（名称/描述 + PATCH 保存信息 / 版本切换下拉 / 状态+权限徽章 /
  保存·发布·归档）；左 CodeMirror 编辑器；右 Tab 侧栏（试算/参数/文档/Diff）。
  **保存语义（ADR §13.5）**：draft 原地 PUT；published 点保存 → 弹窗「将自动创建新 draft 版本」→
  确认 PUT → outcome=new_draft → 刷新版本列表并切到新版本；archived 只读+保存禁用。
  保存前 `checkSyntax`（new Function 轻量语法门）；发布前有未保存修改时拒绝并提示。
- `CodeEditor.tsx`：@uiw/react-codemirror 封装（dark 主题、行号、foldGutter、lang-javascript）+ checkSyntax。
- `ParamsSchemaPanel.tsx`：只读 PARAMS_SCHEMA 表格（key/类型/默认值/范围/描述）。
- `DocSidebar.tsx`：指标 API 文档（02-plugin-abi §2/§2.5 中文）：生命周期钩子、ctx.bar/index/params、
  indicators 七签名（数据不足返回 null）、position 5 字段、ctx.log、save/load、沙箱禁区。
- `TestRunPanel.tsx`：双模式试算表单（标的/周期 M1·M5·M15·D1/日期区间/schema 驱动参数含 min·max·int 校验/
  pure_score·sim_position）→ test-run（内联 code 即写即跑）→ 评分曲线 + sim_position 成交表 +
  事件日志 + truncated 截断提示；400 错误友好内联。
- `ScoreChart.tsx`：轻量 SVG 评分曲线（60/40 阈值虚线；熔断 null 断线；buy/sell 信号点）。
- `DiffView.tsx` + `diff.ts`：版本选择（默认次新→最新）→ GET diff → 行级 LCS 渲染
  （del 红/add 绿/same dim，双行号列）。
- `format.ts`：中文标签/徽章样式/approvalRank/at-least 判定/时间格式化。

**路由与导航**：`App.tsx` +/strategies、/strategies/:id/edit 两路由；`navItems.ts` +「⑩ 策略」；
`NavBar.test.tsx`/`AppShell.test.tsx` 导航计数 9→10（既有断言随行为变更更新）。

**e2e**：`e2e/strategies.e2e.ts`（主流程：列表锚点 → 新建进编辑器 → 试算运行结果/错误容忍态；
遵循既有 playwright 模式，针对真容器 :8081，需后端 manage/PATCH 端点已部署）。

## 4. 依赖选型说明

- **批准新增**（package.json 已写入版本）：@uiw/react-codemirror ^4.25.11、codemirror ^6.0.2、
  @codemirror/lang-javascript ^6.2.5。无其他新增依赖。
- **diff 自实现行级 LCS**（未引 @codemirror/merge）：策略代码体量小（百行级），LCS DP 足够且零依赖；
  merge 视图引入会超出批准清单，报告中按任务书要求说明此选择。
- **评分曲线用轻量 SVG**（未引 ECharts）：仓库既有图表选型为 klinecharts（K 线专用，不适配纯时序折线），
  简单 0-100 分折线 + 阈值线 + 信号点用 SVG 直渲，零新依赖、可测试（data-testid 锚点）。
- **「基本 lint」= 保存前 checkSyntax（new Function 解析期 SyntaxError 捕获）**：@codemirror/lint 不在批准
  清单（虽为 codemirror 传递依赖，不直引），语法门覆盖最常见坏代码场景，运行时错误由试算/发布门禁兜底。

## 5. 测试矩阵（TDD：纯逻辑/页面均先红后绿）

| 测试 | 覆盖 |
|---|---|
| diff.test.ts（6） | 全同/纯增/纯删/替换行序/空串边界/双列行号单调 |
| format.test.ts（4） | 标签全枚举/rank 阶梯/at-least 语义/时间格式化 |
| StrategiesPage.test.tsx（8） | 表格渲染含仅 draft 策略/kind+approval 过滤/新建空白/新建模板预填 code/空名校验/归档禁用与调用/新建版本派生+跳转/错误占位 |
| StrategyEditorPage.test.tsx（11） | 加载默认最新版本/元数据 PATCH/draft 原地保存无提示/published 保存弹窗→new_draft 切换/发布流转/门禁 400 内联/归档/参数面板/文档侧栏关键词/diff add 行渲染/404 占位 |
| TestRunPanel.test.tsx（5） | 标的必填/参数 schema 渲染+越界校验/pure_score 请求体+曲线+事件/sim_position 成交表+盈亏/truncated 提示+400 友好展示 |
| mock.test.ts（+5） | manage 口径/catalog at-least/创建+PATCH+流转/update_draft 双分支/diff+test-run 校验 |

## 6. 验证

- `npm test`：420 passed / 7 failed——7 个失败全部在 `features/alerts`（store+page），
  **经 git stash 在干净 HEAD 复现同为 7 失败，系既有失败与本次无关**（未触碰 alerts 任何文件）。
- `npm run build`（tsc -b && vite build）：0 error（chunk >500kB 警告为既有现象，CodeMirror 加入后体积
  1.19MB/gzip 368kB，后续可 code-split，列入遗留）。
- 冒烟：`vite dev` 启动 → `/strategies` SPA 正常服务、StrategiesPage 模块按需编译 200。

**手动冒烟步骤**（dev server，mock 模式默认 VITE_API_MOCK≠0）：
1. `npm run dev` → 打开 `/strategies`：3 行种子（双均线/纯评分模板/未发布草稿），过滤栏可过滤；
2. 「+ 新建策略」→ 空白或选模板 → 创建后自动进入 `/strategies/{id}/edit`，代码预填；
3. 编辑器：版本下拉切 v1（已发布）→ 改代码点保存 → 弹「将自动创建新 draft 版本」→ 确认 → 自动切到新 draft；
4. 右侧「试算」Tab：默认参数点「运行试算」→ 评分曲线出现；切「模拟持仓」模式 → 成交表+信号点出现；
5. 「Diff」Tab 点「对比」→ 红绿行级 diff；「参数」Tab 见 fast/slow schema；「文档」Tab 见指标契约。

## 7. 遗留风险

1. **alerts 既有 7 测试失败**（干净 HEAD 复现）——非本任务范围，建议父级派单排查。
2. **e2e 未在本环境执行**（需真容器 :8081 + 后端 manage/PATCH 已部署；已按断言容忍态编写）。
3. **bundle 体积**：CodeMirror 使主 chunk 超 1MB；后续可对编辑器页做 React.lazy 代码分割（需父级批准改动路由懒加载结构）。
4. **checkSyntax 为轻量门**：无法捕获运行时错误/ABI 违例（缺 on_bar 等），由试算与发布门禁兜底（mock 与后端均已体现）。
5. mock 发布门禁为 `on_bar` 子串占位，真实门禁在后端 QuickJS 冒烟（联调时以真后端为准）。
