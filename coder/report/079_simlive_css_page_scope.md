# 079 — sim-live 样式落点重整：CSS 移出全局 `index.css` 至页面作用域 `simlive.css`

本报告文件位置：`eestock-rs/coder/report/079_simlive_css_page_scope.md`
（测试报告目录 `cd eestock-rs && ls coder/report`，编号接续 078。）

## 问题是什么

上一步（报告 078）把 sim-live 的自定义规则（`.tab` / `.tab-on` / `.sim-card` 及 `.sim-card table` 等，共 58 行）**直接手改加进 `web/src/index.css`**。而 `index.css` 是 visual 基线/token 所在的**全局样式表**（`main.tsx` 全局 `import './index.css'`），且 `entangled` 由 `design/06-web/09-frontend.md` 的基线代码块单向生成——**手改会破坏「design 为事实源、src 单向生成」纪律，会被 `scripts/check-tangle.sh`（`entangled tangle` 后 `git diff --quiet` 硬失败）拦截**，故本次把样式落点改为**页面作用域专用 CSS 文件**，以「不污染全局生成文件」为准。

## 改了什么

| 文件 | 层 | 改动摘要 |
|---|---|---|
| `web/src/index.css` | 全局基线（tangle 生成） | `git checkout --` **回退手改，还原 HEAD**（58 行自定义规则移除，恢复 72 行基线）。tangle 幂等：无 diff。 |
| `web/src/features/simlive/simlive.css`（**新建**） | 页面作用域样式 | 承载原 58 行 sim-live 规则：`.tab`（Tab 基态）、`.tab:hover`、`.tab-on`（渐变+高亮）、`.sim-card`（卡片背景/边框/圆角/内边距）、`.sim-card table` / `.sim-card thead th` / `.sim-card tbody td` / `.sim-card tbody tr:last-child td`（卡片内表格作用域规则）。复用既有 token `--dim/--txt/--line/--panel2/--acc1/--acc2`。非 tangle 目标，页面自用。 |
| `web/src/features/simlive/SimLivePage.tsx` | 页面 | 新增 `import './simlive.css';`（页面作用域样式随页面 bundle 注入）。 |

未改动 `SimLiveGrid.tsx` / `panels.tsx` / `store.ts` / `SimLivePage.test.tsx`（本次零改动，仍为 078 的工作区内容）；未改后端、其它页面、路由、API 契约；未引入新依赖。

## 架构对齐

- **样式落点**：视觉 token 仍留 `index.css`（全局基线）；sim-live **页面专属**规则迁到 `features/simlive/simlive.css`（页面级持有，只有 `/sim-live` 页面 import 时注入）。二者的 CSS 变量（`var(--dim)` 等）同源于 `index.css` 的 `:root`，保证视觉 token 上下文一致，页面级文件不复制 token。
- **为什么不是 CSS Module**：页面元素类名以**字符串字面量**出现在 `SimLiveGrid.tsx`（`tabCls`/`sim-card`/`mb-5`）并被测试断言（`toContain('tab-on')`、`toContain('sim-card')`）。CSS Module 会哈希类名（`.tab → _abc123`），破坏字符串断言与 tangle 生成骨架的类名契约。因此用「页面作用域普通 CSS 文件 + 页面级 import」更稳、更快，满足「只改落点、不动逻辑/其它页」。
- **tangle/check-tangle 合规**：`simlive.css` 不在 `design/**/*.md` 生成的映射内（`entangled.toml` 仅注册 TSX/TS/SQL/Dockerfile/HTML，无 CSS 语言），`entangled tangle` 不会触碰它；`index.css` 回退后与 HEAD 一致，`git diff --quiet` 通过。

## 实现要点

- 回退：`cd eestock-rs && git checkout -- web/src/index.css`（仅还原该生成文件，未动其它）。
- 迁移：58 行规则**原样**（含各注释头、选择器、声明）迁入 `features/simlive/simlive.css`，无改写。
- 接入：`SimLivePage.tsx` 在 `./panels` import 后新增 `import './simlive.css';`。
- 未走「改成 Tailwind 内联」备选：任务以「页面作用域 CSS 文件」为准（更快、准），且骨架/测试类名字符串依赖不变更。

## TDD 覆盖

本次为纯样式落点迁移，**未新增/未修改测试**。既有 sim-live 断言（078 新增，仍透绿）：`.tab-on` 高亮切换、`.sim-card`+`mb-5` 卡片、`#history` 深链——验证迁移后类名/结构未变。

## 验证结果

- `cd eestock-rs/web && VITE_API_MOCK=0 npx tsc -b` → 通过（无输出/无错误）。
- `VITE_API_MOCK=0 npx vite build` → 通过（`dist/assets/index-*.css` 19.95 kB；已核对 `.tab`、`.tab-on`、`.sim-card`、`.sim-card thead th` 等类均生成于 bundle，样式生效）。
- `npx vitest run` → **38 files / 352 tests passed**（含 simlive 的 Tab 高亮/`.sim-card`/`#history`）。
- `cd eestock-rs && entangled tangle` → `Nothing to be done.`；`index.css` sha 前后一致（`d366876…`），`git diff web/src/index.css` 为空（幂等，无 diff）。

## 暂存 / 变更文件清单（未暂存，工作区修改）

- `web/src/features/simlive/simlive.css`（新增，`??`）
- `web/src/features/simlive/SimLivePage.tsx`（+1 行：`import './simlive.css'`，` M`）
- `web/src/index.css`（已回退 HEAD，与 HEAD 一致，无 diff 条目）

> 说明：`SimLiveGrid.tsx` / `panels.tsx` / `store.ts` / `SimLivePage.test.tsx` 为 078 工作区改动，本次未触碰；为满足验收 `noStagedFiles:true` 与「不 commit」，已 `git reset` 清空暂存区（索引回 HEAD，工作区内容完整保留），未 `git add`、未 commit。

## 残留 / 风险

- **CSS 仍为全局选择器**：`import './simlive.css'` 在 Vite 下仍是全局注入，`.tab` / `.sim-card` 选择器在运行期作用于全 document；因类名唯一（仅 sim-live 使用），无实际碰撞。若未来要严格隔离需改 CSS Module（会破坏类名字符串断言，见上文「为什么不是 CSS Module」）。
- **`SimLiveGrid.tsx` 是 tangle 生成（禁止手改）**：本次**未改**它，类名/结构保持 078 状态；`entangled tangle` 已确认与 `design/06-web/10-simlive.md` 一致（幂等无 diff）。
- **`index.css` 回退后不含 sim-live 样式**：若 078 的上游评审依赖 `index.css` 内样式做预览，需以 `simlive.css` 页面级注入为准；两处一致性已在 vite build 产物核对。
- **未做真容截图对比样机**：与 078 同，属可选高成本项；已用「构建产物含关键类」作等价验证。
