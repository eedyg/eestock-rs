# 119 — P3b 修复包：工作台前端 8 项（reviewer findings）

- 报告位置：`coder/report/119_workbench_frontend_p3b_fixpack.md`（本文件）
- 范围：仅 `web/`（crates/、design/、migrations/ 未动）。不修项：NIT-4②（备案）、NIT-6（已登记技术债）。
- 基线：118（P3b 工作台前端初版）之上的 reviewer 修复包；TDD 先红后绿（9 个新测试先红，见 §4）。

## 1. 修复项 → 变更

| 项 | 修复 | 文件 |
|---|---|---|
| MINOR-1 | 双保险：①`WorkbenchPage` 给 `<ResultView key={selectedRun?.id ?? 'none'}>`（切 run 整体重挂载，Tab/图例态一并复位）；②`SlotScoresChart` 以 `slotsKeyOf(slots)`（version_id 序列）渲染期 reconcile `visible`（React「render 期间调整 state」模式）——无中间 loading 的切换也按新 run slots 重置「默认前 3」，勾选态不泄漏 | `WorkbenchPage.tsx`、`SlotScoresChart.tsx` |
| MINOR-2 | 预设就地更新：`presetSel` 非空且表单偏离已应用预设（`canonicalConfig` 规范化串比较，校验失败视为偏离）→「保存」走 `PUT /api/workbench/presets/{id}`（当前表单 config，同名不撞 409）；否则仍 POST 新建。脏标记 `wb-preset-dirty`（「已修改（未保存回预设）」）+ 保存按钮文案「保存/更新」切换。store 新增 `updatePreset(id,name,config)`（PUT + 重捞列表），页面接线 `onUpdatePreset` | `ConfigPanel.tsx`、`store.ts`、`WorkbenchPage.tsx` |
| NIT-1 | `buildConfigCore` 增 slots >10 预校验（`MAX_SLOTS=10`，与后端 1..=10 同口径）：「策略数量须在 1..=10（当前 N）」，提交前拦截 | `ConfigPanel.tsx` |
| NIT-2 | `ResultView` 新增可选 `progressMap` prop，头部进度（`wb-run-progress`）与非终态占位均以 `progressMap[run.id]?.progress ?? run.progress` 渲染（与 RunList 行同模式）；`WorkbenchPage` 传入 `state.progressMap` | `ResultView.tsx`、`WorkbenchPage.tsx` |
| NIT-3 | `handleApplyPreset`：apply 成功（回填 + 落脏检测基线）后才 `setPresetSel(id)`；失败保留原选中态 + 错误提示；清空（id=''）立即落并清基线；删除预设后清基线 | `ConfigPanel.tsx` |
| NIT-4① | mock `submitWorkbenchRun` 拒绝未知 params 键：`HTTP 400: 未知参数键: {k}（schema 未声明）`（对齐后端 `fill_and_validate_params`） | `mock.ts` |
| NIT-5 | 补测试锁定：自定义阈值 70/30 提交的 run，结果页阈值线 y 位置（70→51.2 / 30→108.8）与 hold 区高度（0.4×144）按 70/30 渲染（现有实现已正确，纯测试加固） | `ResultView.test.tsx` |

附带测试适配：`ConfigPanel.test.tsx`「预设管理：重命名/删除」用例的 `onApplyPreset` 改为 resolve `preset.config`（NIT-3 语义下 apply 须成功才落选中态；原默认 `vi.fn()` 返回 undefined 视为失败）。

## 2. 实现要点

- `buildConfig` 拆分为纯校验核心 `buildConfigCore()`（返回 `{ok}|{err}` 不落 formError，供渲染期脏检测复用）+ `buildConfig()` 包装（落 formError）。无行为变更，既有校验文案全部保留。
- 脏检测基线：`appliedJson`（最近一次成功 apply/就地更新的 config 规范化串）；apply 返回的钉住形态经 `pinnedToInput` 归一为未钉住再比较（mock 存储即未钉住形态，两种形态均兼容）。
- 无新依赖、无接口/层边界变更：`updatePreset` 复用既有 `ApiClient.updateWorkbenchPreset`（PUT 端点 118 已就位）。

## 3. 架构对齐

- 全部改动在 `web/src` Presentation 层：组件（ConfigPanel/ResultView/SlotScoresChart/WorkbenchPage）+ 状态机（store）+ 契约 mock（api/mock）；经既有 `ApiClient`/`WsClient` 抽象，未动 crates/、design/、migrations/。

## 4. 测试证据（TDD）

**Red**（实现前）：9 个新测试 8 红 1 绿（NIT-5 为纯测试加固，现有实现已正确而绿）——

- mock 未知 params 键 400 ×红
- store.updatePreset 不存在 ×红
- ResultView progressMap 叠加 ×红（`wb-run-progress` 不存在）
- ResultView 无 loading 间隙切 run 图例泄漏 ×红
- WorkbenchPage 头部进度 WS 推进 ×红
- WorkbenchPage 预设就地更新（PUT/脏标记）×红
- ConfigPanel slots>10 预校验 ×红
- ConfigPanel 脏标记+PUT ×红
- ConfigPanel apply 失败 presetSel 回退 ×红
- （WorkbenchPage 图例不泄漏用例初即绿：页面流 selectRun 有 loading 骨架间隙会卸载图表——保留为回归守护；真正的泄漏路径由 ResultView rerender 单测锁定）

**Green**：实现后目标文件 `135 passed (135)`；全量 `npm test` → **492 passed / 7 failed**，7 个全部为 `features/alerts` pre-existing（与 118 基线 stash 验证一致，任务书允许）。

**Build**：`npm run build`（tsc -b + vite build）**0 error**（✓ built in 2.44s）。

**备注**：全量首跑曾出现 `SettingsPage` 1 例失败（rate_per_sec 110 vs 10），与本变更无涉（未触 settings 及其依赖）；单跑 3/3 通过、全量复跑归零——并行负载下的 pre-existing flaky。

## 5. 遗留风险

- 脏检测基于规范化 JSON 串比较（key 序由同一构造路径保证：schema 序/字面量序）；后端若返回 params key 乱序理论上会误报脏——mock/真实后端均按 schema 序构造，无现实风险。
- `WorkbenchPage` 图例用例因 loading 间隙初即绿（见 §4），MINOR-1 的行为锁主要靠 ResultView rerender 单测。
- NIT-4②（备案）/NIT-6（技术债）按任务书不修。
