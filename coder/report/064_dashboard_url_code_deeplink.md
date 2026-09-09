# Coder Report 064 — 行情看板 URL `?code=` 深链选中（批1c C1b 缺口）

**Report file:** `coder/report/064_dashboard_url_code_deeplink.md`（本文件）

**Repo/工作区：** `eestock-rs`（嵌套 git；`web/` 子目录）。**不 commit、不 git add**（遵循 Acceptance `noStagedFiles: true`）。

**范围铁律：** 只改 `web/src/features/dashboard/*`（store/DashboardPage + 对应测试）。未改后端/DB/SQL/Rust、未改收藏/MA/周期/宫格既有逻辑。

---

## ① 问题 / 需求（C1b）

看板打开 `/` 或 reload 后恒选中默认首只（`DashboardStore.init` 未读 `window.location.search`）。要支持「URL 带 `?code=` 则打开后选中该只；无 code 则默认首只」，且满足：

1. 代码为异步加载：需在 `init` 拿到 symbols 后再按 URL code 选中。
2. URL code 不存在（未注册/停用）→ 回退默认首只（不报错）。
3. 与现有 `selectSymbol`/默认选中逻辑协调（不破坏正常点选）。
4. reload 保持：刷新后仍按其选中。

## ② 实现概览

仅改 `web/src/features/dashboard/store.ts`（一处核心逻辑 + 两个私有辅助），`DashboardPage.tsx` 零改动（URL 由 store 在 init 读取，组件无涉）：

- **`store.ts` → `readUrlCode()`**：读 `window.location.search` 的 `code` 参数（`URLSearchParams`），不存在返回 `null`；`typeof window === 'undefined'` 时返回 `null`（SSR/非浏览器兜底，纯防御，当前无 SSR）。
- **`store.ts` → `resolveInitialSelected(symbols, urlCode)`**：初选解析优先级
  1. `urlCode` 存在且在 `symbols` 中 → 返回 `urlCode`（URL 深链选中）；
  2. 现有 `this.current.selected` 在 `symbols` 中 → 保留（重试/既有选中不丢）；
  3. 否则 → `symbols[0]?.code ?? null`（默认首只/空态）。
- **`store.ts` → `init()`**：原来内联的初选三元改为 `const selected = this.resolveInitialSelected(symbols, this.readUrlCode());`。

要点：URL 只在 `init()` 时读取一次，因此「正常点选」走 `selectSymbol`（不写回 URL、不改 URL 优先级），与 URL 深链互不干扰。reload 会新建 `DashboardStore`（`useMemo` 依赖 `[api,ws]` 稳定仍会重新 `init`，且 component 重新挂载），重新读 `location.search` → 仍带 code 则再次选中（刷新保持）。

## Architecture alignment

- 分层：改动全部落在 `features/dashboard/store.ts`（页面① 状态机的图表无关层）。`DashboardPage.tsx`/`SymbolList`/`KlineChart` 等组件零改动；未改 api 层、未改接口/契约、未改 `DashboardGrid`。
- `DashboardStore` 仍在 `init` 后 patch 一次 `{symbols, symbolsStatus, selected}`，只把「selected 的解析内部逻辑」抽成私有 helper，不改变对外暴露的任何方法与 `state` 形状（`DashboardState` 未动）。
- 与批1c 既有语义一致：无 code / code 无效 → 回默认首只，与 C1（URL 无 code reload 回默认首只）契约不冲突。

## Problem solved / feature added

- 打开 `/`、`/?code=161226`、`/?code=159577` 时，symbols 加载后按 URL code 选中对应标的（C1b 契约）。
- URL code 不存在 → 静默回退默认首只（无错误弹层/无崩溃）。
- reload（URL 带 code）→ 仍选中该只（刷新保持）。
- 正常点选/切周期/切指标不受影响（URL 优先级仅在 init 生效，不覆盖用户后续交互）。

## Implementation approach (within approved architecture)

- 优先序用「链式三元」表达（URL 深链 > 既有 selected > 默认首只），逻辑内聚、可单测。
- `URLSearchParams` 读 `code`（兼容 `?code=161226` 及带其他 query 参数的情形）。
- 未在 `DashboardPage` 用 `useSearchParams`/`useLocation`（react-router）——因为 `?code=` 是纯查询参数且不需要路由联动，直接用 `window.location.search` 最小侵入，避免了「浏览器 location」与「MemoryRouter location」两套来源的分歧（也更贴近 e2e 直连 `goto` `/?code=` 的真实语义）。

## Test coverage（Red→Green）

**Red 先行**：先加断言后跑，确认新用例失败（选中仍默认首只 518880），再实现转绿。

- **`store.test.ts`**（新增 5 用例，插在「看板收藏 Wave 3」describe 内）：
  - URL 带 `code=161226` → init 后选中 `161226`。
  - reload（URL 仍带 code）→ 新 store init 后仍选中 `161226`（刷新保持）。
  - URL code=不存在（`ZZZZ`）→ 回退默认首只 `518880`（不报错）。
  - URL 无 code → 默认首只 `518880`（对照不误选）。
  - URL 深链选中后 正常点选/切周期 不丢（`setPeriod('1h')` 后选中仍 `161226`；`selectSymbol('513310')` 正常生效）。
  - 另加 `afterEach(() => window.history.replaceState(null,'','/'))` 复位 `location` 防跨用例泄漏。
- **`DashboardPage.test.tsx`**（新增 describe「URL ?code= 深链选中」5 用例，含 `afterEach` 复位 location）：
  - URL 带 `code=161226` → 打开后 `[data-selected=true]` 行为 161226 + `getKline({code:'161226'})`。
  - URL 带 `code=161226` 选中后切周期（1h）不丢（复用批1c 断言）。
  - URL code=不存在 → 默认选中首只 `518880`。
  - URL 无 code → 默认选中首只 `518880`。
  - reload（URL 仍带 code）→ 重新挂载（unmount + render 新组件）后仍选中 `161226`。

首轮 Red：`6 failed | 42 passed`（新增 6 用例失败，既有 42 通过）。
实现后 Green：`store.test.ts 30 passed` + `DashboardPage.test.tsx 18 passed`，全量 `324 passed`。

## Verification

- `npx vitest run src/features/dashboard/store.test.ts src/features/dashboard/DashboardPage.test.tsx` → **48 passed**。
- `npx vitest run`（全量，stack `eestock-rs/web`）→ **37 files / 324 tests 全绿**（含既有 dashboard/backtest/alerts/settings/symbols/quality/ws 回归）。
- `VITE_API_MOCK=0 npx tsc -b` → 通过（0 错误）。
- `VITE_API_MOCK=0 npx vite build` → 通过（121 modules；产物 `index-yw4TZbPb.js` 570.12 kB；>500kB 分块告警为既有，非本次引入）。
- **C1b e2e（真实浏览器）**：`npx playwright test dashboard-state-consistency.e2e.ts -g "C1"`，运行镜像 `eestock-app`（http://127.0.0.1:8081）→ **2 passed**（C1 + C1b 均绿）。
  - 注意：容器内 SPA 为镜像内构建产物（`index-B9RewKvL.js`，不读 URL code）。为做真浏览器验证，先用本机新产物覆盖容器 `/app/dist`（`index-yw4TZbPb.js`）→ 跑 C1b → 已验证后**已还原**容器原始 `/app/dist`（`index-B9RewKvL.js`），不把部署变更留到生产容器。C1b 之所以能转绿，是本次代码 + 真实环境（158 行 API 首行=518880，`161226`/`159577` 均已注册且 enabled）。

## Residual risks

1. **线上未生效**：真实容器已被还原为原 bundle（`index-B9RewKvL.js`）。若要让线上 C1b 持续转绿，需用新前端代码重新构建 app 镜像/容器（部署步骤，非本次「只改前端源码」范围）。本次真浏览器 C1b 绿是在临时换入新 bundle 下达成。
2. **数据依赖**：C1b 探测 `?code=161226`、`?code=159577`；若部署环境未注册/停用这两只，该用例会因「code 不在 symbols → 回退默认」而失败，属环境数据依赖，非代码缺陷。
3. **URL 只读不写**：用户点选后不回写 URL；reload（无 code）仍回默认首只（与 C1 契约一致）。若未来希望「URL 跟随当前选中」，需另议（会与 C1「reload 回默认」契约冲突）。
4. **StrictMode 双执行**：App 用 `<StrictMode>`，effect 会 mount→cleanup→mount。`DashboardStore` 的 `init`/`dispose` 生命周期为既有实现，本次未改；URL 读取在 `init` 内，双执行下第二次 `init` 的 `patch` 因 `disposed` 短路，不影响选中结果（与既有行为一致，非本次引入）。
5. **`readUrlCode` 防御**：`typeof window === 'undefined'` 返回 null（SSR/非浏览器），当前无 SSR，纯防御；不改变任何既有行为。

## 暂存文件清单（changed files，未 commit、未 git add——遵循 Acceptance `noStagedFiles: true`）

**修改（3 tracked 在 `web/`）**：
- `web/src/features/dashboard/store.ts`（+20 –1：新增 `readUrlCode`、`resolveInitialSelected`，`init` 改用之）
- `web/src/features/dashboard/store.test.ts`（+57：URL-code 5 用例 + afterEach 复位 location）
- `web/src/features/dashboard/DashboardPage.test.tsx`（+73：URL-code describe 5 用例）

**未跟踪（既有，非本次改动）**：`web/e2e/dashboard-state-consistency.e2e.ts`（存在且被读取，本次未修改；git 显示 `??` 为既有未跟踪状态）。
