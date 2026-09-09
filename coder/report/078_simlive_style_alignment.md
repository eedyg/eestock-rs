# 078 — sim-live 卡片式视觉对齐静态样机（样式落差修复）

本报告文件位置：`eestock-rs/coder/report/078_simlive_style_alignment.md`
（测试报告目录 `cd eestock-rs && ls coder/report`，编号接续 077。）

## 问题是什么

`/sim-live` 与 `design/11-sim-live/preview/sim-live.html` 静态样机的**样式落差**（非结构问题）：
1. Tab 无高亮——`.tab-on` 类被用在按钮上但没有任何实际样式定义。
2. region 无卡片背景/间距——每个 `data-region` 只是 `border-b px-4` 的裸段，内容贴顶、相邻粘连、下半留白。

本次**只动前端样式 / 布局类**，不改数据与结构，不修后端。

## 改了什么

| 文件 | 层 | 改动摘要 |
|---|---|---|
| `web/src/index.css` | 样式表 | 新增 `.tab`（Tab 基态）、`.tab-on`（选中态渐变+高亮，同 01-dashboard `.btn.on`/样机 `.tab.on`）、`.sim-card`（背景 `--panel2`/边框 `--line`/圆角 12px/内边距）+ 卡片内表格规则（`thead th` 表头 / `tbody td` 行 / 末行去底边框），复用 `--up/--down/--dim/--acc1/--acc2`。 |
| `web/src/layouts/SimLiveGrid.tsx` | 布局骨架 | Tab 按钮加 `tab` 基类 + `tab-on` 选中态；容器加 `min-h-0 flex-1 overflow-y-auto`（超长内部滚动，不整页 h-screen 固定）；每个 region 段改为 `sim-card mb-5`（独立卡片 + 两两 20px 间距），并加分段小标题；历史/当前两 Tab 同一卡片式容器。 |
| `web/src/features/simlive/panels.tsx` | 业务组件 | `SessionControl` 重排为 **KPI 布局**（状态 pill + 等宽数字指标 ×4 + 开关/操作行），测试 id 与行为全部保留；其余表格视觉由 `.sim-card table` 作用域样式统一。 |
| `web/src/features/simlive/SimLivePage.tsx` | 页面 | 容器加 `min-h-0`（让 `overflow-y-auto` 生效）；构造 store 时读 `location.hash` 决定初始 Tab（`#history` → 历史）。 |
| `web/src/features/simlive/store.ts` | 状态 | `SimLiveStore` 构造器新增可选 `initialTab`（默认 `'current'`），供深链注入初始 Tab。 |
| `web/src/features/simlive/SimLivePage.test.tsx` | 测试 | 新增 3 条 TDD（Tab 高亮切换、region `sim-card`+`mb-5`、`#history` 深链）。 |

`git diff --stat`：6 files changed, 164 insertions(+), 39 deletions(-)。

## 架构对齐

- **样式层**：`index.css` 承载视觉 token/卡片/表格作用域样式（`.sim-card`、`.tab*`），与既有 `index.css` 的 `--up/--down/--dim` 基线一致；表格细节走作用域选择器不污染全局。
- **布局骨架层**：`SimLiveGrid.tsx`（原为 tangle 生成、禁止手改，本次按任务被明确授权修改）负责 Tab 高亮类、region 卡片化、分段间距、滚动容器。
- **业务展示层**：`panels.tsx` 的 `SessionControl` 做 KPI 布局；表格式样不侵入组件、由作用域 CSS 呈现。
- **状态/页面层**：`store.ts` 加构造参数、`SimLivePage.tsx` 读 hash，均为深链初始态的小改动，不触碰接口契约与数据流。

未改动后端、其它页面、路由、API 契约；未引入新依赖。

## 实现要点

- Tab：基态 `.tab`（圆角/边框/底色），选中态 `.tab-on`（`linear-gradient(135deg,var(--acc1),var(--acc2))` + `box-shadow` 高亮），与样机 `.tab.on`、01-dashboard `.btn.on` 同风格。
- 卡片：`.sim-card`（`background: var(--panel2); border: 1px solid var(--line); border-radius: 12px`），间距由 Tailwind `mb-5`（20px，在 16–20px 区间）逐卡提供；容器 `overflow-y-auto` 承载超长滚动。
- 顶部 `SessionControl`：KPI 行（状态 pill / 总资产 / 可用 / 已实现 / 未实现）+ 操作行（统一交易开关 / MCP / 开始 / 停止），数值用 `.num`（JetBrains Mono tabular-nums），涨跌色复用 token。
- `#history`：`window.location.hash === '#history'` 时构造 `SimLiveStore` 初始 `activeTab='history'`（深链只读一次，不做 hash 监听）。

## TDD 覆盖（新增）

1. `Tab 高亮类(.tab-on)存在且 active 态切换`——默认当前 Tab `.tab-on`，点「历史回顾」后高亮互转。
2. `region 卡片类(.sim-card)存在且相邻有 margin(mb-5)`——5 个当前 region + 历史 `session-history` 均含 `sim-card` 与 `mb-5`。
3. `#history 深链 → 历史 Tab 初始激活`——设 `location.hash='#history'` 渲染，历史 Tab 初始 `.tab-on`。

## 验证结果

- `cd eestock-rs/web && npx vitest run` → **38 files / 352 tests passed**（simlive 单文件 11 tests passed）。
- `VITE_API_MOCK=0 npx tsc -b` → 通过（无输出/无错误）。
- `VITE_API_MOCK=0 npx vite build` → 通过（`dist/assets/index-CZZeWF8G.css` 19.95 kB；已核对 `.sim-card`、`.tab`、`.tab-on`、`.sim-card table`、`.sim-card thead th`、`.sim-card tbody td`、`.text-[--up]`、`.mb-5`、`.overflow-y-auto`、`.min-h-0` 等类均生成）。产出文件：`index-CZZeWF8G.css`、`index-D3W8Mp-b.js`。

> 可选「真容截图对比样机」未执行（需要 dev 服务 + 后端/前端联动，且成本高）；已通过 CSS 产物核对关键类是否生成作为等价验证。

## 残留 / 风险

- **数据异常（单列，非本次范围）**：持仓 `latest=0.000` vs 评分 `latest_price=3.389` 属后端数据问题（`state.positions[].latest` 与 `strategies.stocks[].latest_price` 不一致）。本次仅前端样式 + hash，未修后端。
- **tangle 生成文件**：`SimLiveGrid.tsx` 头部有 `// 由 design/06-web/10-simlive.md 生成，禁止手改` 注释；本次按任务被授权修改，但若后续重跑 tangle 会被覆盖，需同步到 `design/06-web/10-simlive.md`（超出本次范围，特此标注）。
- **jsdom 不装载 CSS**（`test.css:false`）：margin/间距以 `mb-5` 类名断言之（真实 20px 由 Tailwind 生成）；非内联 computed 断言，属于 jsdom 环境下的合理替代。
- **未 `git add`**：为满足验收 `noStagedFiles:true` 与任务「不 commit」，改动保持为工作区未暂存修改（`git status` 显示 `M`）。父评审如希望暂存可自行 `git add`。

## 暂存/变更文件清单（未暂存，工作区修改）

- `web/src/features/simlive/SimLivePage.test.tsx`
- `web/src/features/simlive/SimLivePage.tsx`
- `web/src/features/simlive/panels.tsx`
- `web/src/features/simlive/store.ts`
- `web/src/index.css`
- `web/src/layouts/SimLiveGrid.tsx`
