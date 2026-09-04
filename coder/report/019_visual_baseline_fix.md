# 019 — E2E 视觉基线误报修复（quality 动态数据区未 mask）

> 本报告位置：`coder/report/019_visual_baseline_fix.md`

## 问题

`web/e2e/visual.e2e.ts` 的质量页（`/quality`）视觉基线在每次运行都漂移，为整 e2e 套件唯一失败项（35 passed / 1 failed）。

前置观察（用真实容器 `curl http://localhost:8081/api/quality/divergence` 与 Playwright 截图/探针确认）：
- 质量页默认范围为「近 7 自然日」（`store.ts::defaultRange(this.now())`，`to=今日`），对于固定交易日窗口，行数稳定（当前 577 行，按 |偏差| 降序）。
- **真正漂移点**是分歧表（divergence-table）最右侧「raw 来源」列：值为源名文本（`腾讯ifzq` / `新浪jsonp` / …），**非 `.num` 单元格**。源归属（`r.raw_source`）会随数据面重同步而变，导致该列文本每次运行不同。旧 mask `[data-region="divergence-table"] .num` 只覆盖数字单元格，漏掉了这一列。
- 对 expected/actual/diff 像素差分分析：唯一差异区 bbox ≈ `x[1158..1215] y[212..300]`，即「raw 来源」列。`sourcecol` 掩膜覆盖率仅 0.188（未覆盖），而其它动态区已全覆盖（topbar/summary/accuracy/sync/gap 均为 magenta 1.0）。
- 附带发现：过滤栏（`[data-region="filter-bar"]`）内两个 `<input type="date">` 起止日期也是「每日会变」数值，属潜在日级漂移。

## 修改内容

只改 `web/e2e/helpers/masks.ts`（+ 必需重生成的质量基线快照 png）：

- `web/e2e/helpers/masks.ts`：`MASKS_BY_PAGE.quality` 掩膜从
  `['[data-region="topbar"]','[data-region="divergence-table"] .num','[data-region="accuracy-cards"]','[data-region="sync-panel"]','[data-region="gap-report"]','[role="alert"]']`
  改为追加两条：
  - `'[data-region="filter-bar"] input[type="date"]'` —— 屏蔽每日会变的起止日期输入框（保留标的 select（含源名）与「分歧表/叠加图」切换按钮）。
  - `'[data-region="divergence-table"] tbody td:not(.num)'` —— 屏蔽分歧表数据行中所有非 `.num` 单元格，即「raw 来源」源名列（数字列仍由既有 `.num` 覆盖）。
  - 更新了对应注释，标明「raw来源 源归属随重同步而变需单独 mask」以及一致率/源成功率所在区域。
- `web/e2e/screenshots/visual.e2e.ts-snapshots/quality-full-chromium-linux.png`：因掩膜变化需重生成（旧基线露出源名文本，与新待掩膜像素不符）。仅用 `--grep "质量" --update-snapshots` 重生成该页，未触碰其它页基线。

未改动：`visual.e2e.ts`（无需改动，其已通过 `shotOptions` 应用掩膜）、任何业务组件、任何 Rust 后端。

## 架构对齐

- 改动落在 **E2E 测试栈 / Test Harness** 层（`web/e2e/helpers/masks.ts` 为测试辅助，`visual.e2e.ts` 消费 `shotOptions`）。这是设计文档 `design/06-web/09-frontend.md`「E2E 测试栈」定义的测试基础设施。
- 不涉及生产组件、API、事件契约或层间依赖；`gitnexus detect-changes` 报告 «No changes detected»（对生产符号/执行流零影响）。
- 策略与既有基线口径一致：`mask` 掉易变数据区，只留稳定结构（布局/导航/区域框/固定文案：表头列名、过滤栏按钮、导航、各 data-region 区域框尺寸）。

## 实现方式（在既有架构内）

- 采用「精确 mask 动态区」路线（需区别于整体 mask 的巨大 tbody）。
- 关键几何事实（Playwright `getBoundingClientRect` 实测）：质量页 fullPage 截图 `1488×720`；`tbody` 高 `21809px`（577 行，位于 `overflow-auto` 滚动容器内）。若直接 mask `tbody` 会把掩膜矩形延展盖过下方 summary/accuracy/sync/gap 区域（实测探针 B 全页被覆盖，Summary 固定文案丢失）。因此改用**单元格粒度** mask：数字列用既有 `.num`，源名列用 `tbody td:not(.num)`（各单元格矩形有界，仅覆盖可见数据区，Header 与 Summary 边框/文案保留）。
- 过滤栏日期：用 `input[type="date"]` 精确命中两个日期框，不掩盖标的 select 与视图切换按钮。

## 测试覆盖

- 复用既有 `visual.e2e.ts` 的 `视觉基线 质量（/quality）` 用例（未新增用例；需求是修基线误报，非加功能）。
- 掩膜变更后先用探针脚本验证：`td:not(.num)`（探针 A）只把源名列置为 magenta（覆盖率 1.0），Header/Summary/准确率卡/同步/缺口均保留；对比 `tbody`（探针 B）会整页过掩。
- 以 `--grep "质量" --update-snapshots` 重生成质量基线并连跑 3 次，3/3 通过（稳定）。

## 验证

- `npm run e2e`（playwright，chromium，workers=1，retries=1）→ **36 passed / 0 failed**（1.5m）。
- 视觉基线质量页连跑 3 次全绿。
- `git status` 仅两处意向改动；`git diff --cached` 仅含 `masks.ts` 与质量基线 png。

## 残余风险

- **过滤栏「标的 select」未 mask**：其显示默认标的（`symbols.data[0]`），若符号列表顺序/默认标的变化可能日级漂移。当前列表稳定，故按「与 dashboard 同口径仅 mask 数值」保留可见（源名属稳定结构）。
- **「空数据」边缘态**：若默认窗口无比对数据，分歧表显示空态（无 tbody → 掩膜不命中），整页布局会变。属无数据日罕见情形；当前窗口恒有 577 行。
- **重基线要求**：本次已重生成质量基线。后续若 UI/结构变更，须重新 `npm run e2e:update`（仅限有意 UI 变更），盘中动态数据变化属掩膜设计内豁免。
- 目标容器 `eestock-app` 未重建、未触及其它 docker；（仅纯前端 e2e/tests 改动）。

## 交付状态

- 已 stage：`web/e2e/helpers/masks.ts`、`web/e2e/screenshots/visual.e2e.ts-snapshots/quality-full-chromium-linux.png`。
- 仅 stage 未 commit（父级红线「只 stage 不 commit」）。
