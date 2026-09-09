# 看板收藏 F2 前端（Wave 3 页面①）

本报告文件位置：`eestock-rs/coder/report/058_favorites_frontend.md`
（上一份前端/后端报告：`057_favorites_backend.md`；后端 F1 已就绪 `344753b`。）

## 任务概览

后端 F1 已就绪（commit `344753b`）：`/api/symbols` 恒输出 `favorite`/`favorite_sort` 且收藏优先；
`POST/DELETE /api/symbols/{code}/favorite`（star/unstar，幂等，404=code 未注册）；
`PUT /api/symbols/favorites/order`（body `{codes}`，重排，400=含未收藏 code）。
本任务实现前端 F2：类型/契约、client/mock、SymbolList 收藏置顶 + 星标切换 + 拖拽重排、store 乐观更新。

## 改动清单（文件 + 行数）

`git diff --cached --stat`（12 files changed, 700 insertions(+), 38 deletions(-)）：

| 文件 | 行数变化 | 层 |
|------|---------|----|
| `web/src/layouts/DashboardGrid.tsx` | +6 | 骨架类型（SymbolSnapshot） |
| `web/src/api/types.ts` | +3 | 契约类型（SymbolRow） |
| `web/src/api/client.ts` | +21 | 契约客户端（dtoToSnapshot + 3 方法） |
| `web/src/api/mock.ts` | +59 | 契约 mock（内存收藏状态 + 3 方法） |
| `web/src/features/dashboard/store.ts` | +53 | store（toggleFavorite/reorderFavorites 乐观+回滚） |
| `web/src/features/dashboard/SymbolList.tsx` | +195 | 组件（收藏置顶/星标/拖拽 handle） |
| `web/src/features/dashboard/DashboardPage.tsx` | +2 | 页面（回传收藏回调给 store） |
| `web/src/api/client.test.ts` | +54 | 测试 |
| `web/src/api/mock.test.ts` | +51 | 测试 |
| `web/src/features/dashboard/store.test.ts` | +87 | 测试 |
| `web/src/features/dashboard/SymbolList.test.tsx` | +112 | 测试 |
| `web/src/features/dashboard/DashboardPage.test.tsx` | +95 | 测试 |

## 改动明细

### 1. 类型/契约
- `SymbolSnapshot`（`layouts/DashboardGrid.tsx`）：新增 `favorite?: boolean`、`favoriteSort?: number | null`（可选，兼容既有快照构造；client/mock 恒填充）。
- `SymbolRow`（`api/types.ts`）：新增 `favorite?: boolean`、`favorite_sort?: number | null`（后端恒输出，前端 lenient）。
- `dtoToSnapshot`（`client.ts`）：映射 `favorite: d.favorite ?? false`、`favoriteSort: d.favorite_sort ?? null`。

### 2. client
- `ApiClient` 接口新增：`starSymbol(code)`=POST、`unstarSymbol(code)`=DELETE、`reorderFavorites(codes)`=PUT（body `{codes}`）。
- `createHttpClient` 实现对应请求（`encodeURIComponent(code)`；`PUT` 带 `content-type: application/json`）。

### 3. mock（内存状态）
- 新增 `favoriteOrder: string[]`（有序已收藏 code；下标+1 = sort_order，起点 1）。
- `getSymbols()`：按 `favoriteOrder` 注入 `favorite`/`favoriteSort`，并**收藏优先排序**（favoriteSort 升序在前，非收藏稳定）。
- 新增 `starSymbol(code)`（追加 max+1、幂等、404 校验）、`unstarSymbol(code)`（移除、幂等、404 校验）、`reorderFavorites(codes)`（校验已收藏否则 400、重排）。
- `getSymbolsAdmin`/`registerSymbol` 同步注入 favorite 字段（faithful 到后端 dto）。

### 4. SymbolList（收藏置顶 / 星标 / 拖拽）
- **收藏优先分区**：`partition()` 把列表分成 收藏区（`favorite===true` 按 `favoriteSort` 升序）在上、非收藏区在下；每行保留 价格/涨跌幅（RowPrice 子组件，D2 停用/无数据不伪造 0.000）。
- **星标切换**：每行右侧空心/实心星（`☆`/`★`）；点击 → 调 `onToggleFavorite(code)`（不误触发行选中，`stopPropagation`），失败在顶部提示条「收藏操作未生效，已回滚」。
- **拖拽重排**：仅收藏行带 **drag handle**（`⠿`），凭 handle 触发行内 HTML5 `dragstart`，收藏行作为 drop target；drop 后计算新顺序调 `onReorderFavorites(next)`，失败提示「排序未能保存，已回滚」。
- **空收藏区**：仅当 `favorites.length>0` 才显示「★ 已收藏」分组标签；无收藏则不显示空区。
- **点击选股/选中态**保持：行仍为 `<button data-selected>`，点击文本 → `onSelect`。

### 5. DashboardPage / store
- store 新增 `toggleFavorite(code)`：乐观更新 `favorite`/`favoriteSort`（star=max+1、unstar=null），调 `api.starSymbol/unstarSymbol`，失败回滚 `prev` 并 rethrow。
- store 新增 `reorderFavorites(codes)`：乐观更新收藏行 `favoriteSort`（codes 顺序=index+1），调 `api.reorderFavorites`，失败回滚并 rethrow。
- **决策（Q4 仅影响 symbol-list）**：store 只更新收藏标注（`favorite`/`favoriteSort`），**不改写 `symbols` 数组顺序**（不擅动宫格展示）。收藏置顶的视觉排序由 `SymbolList.partition()` 负责，与 /api/symbols 后端返回的收藏优先顺序保持一致。
- DashboardPage 把 `onToggleFavorite`/`onReorderFavorites` 接到 store 方法。

## 收藏置顶逻辑
`SymbolList.partition(symbols)`：
```
favorites = symbols.filter(s => s.favorite===true).sort(by favoriteSort asc)
rest      = symbols.filter(s => s.favorite!==true)   // 稳定保持原序
render: [...favorites, ...rest]
```
置顶顺序 = 后端 sort_order（起点 1）升序；非收藏紧随其后且保持原相对顺序。

## 星标/拖拽实现
- **星标**：非收藏=空心`☆`（可加星），收藏=实心`★`高亮（琥珀色）。点击 `onToggleFavorite(code)`。
- **拖拽**：仅收藏行 `draggable` 的 handle（`⠿`，`data-handle={code}`）作为拖拽源（`onDragStart` 写 `dragCode` ref + `dataTransfer`）；收藏行自身为 drop target（`onDragOver` preventDefault + `onDrop`）。drop 时把源 code 移到目标 code 位置，生成新 `codes` 调 `onReorderFavorites`。拖拽 handle 只挂在 handle 上，故拖拽不触发选股点击。
- **乐观**：store 在调 api 前后端部先 `patch`（星标/重排），api 失败 `patch(prev)` 回滚并 rethrow → SymbolList `.catch` 显示提示。

## 架构对齐
| 改动 | 属层 | 理由 |
|------|------|------|
| `SymbolSnapshot`/`SymbolRow` 字段 | 契约类型 | 与后端 dto 恒输出对齐 |
| `client.ts` 3 方法 + 映射 | 数据访问层 | 封装 HTTP（URL/方法/body），规避组件直连 |
| `mock.ts` 收藏内存状态 | 契约 mock | 与后端 `favorite.rs` 行为同构（幂等/404/400） |
| `store.ts` 乐观方法 | 页面状态机 | 单一数据源（list 顺序不擅动 → Q4 仅影响 symbol-list） |
| `SymbolList.tsx` 分区/星标/拖拽 | 展示层 | 纯 presentational + 回调上抛 |
| `DashboardPage.tsx` 接线 | 页面组装 | 把 store 方法接到 SymbolList 回调 |

未改动：后端/Db/SQL/Rust、`.gitmodules`、其他 feature（仅测试夹具未触碰——通过可选字段避免扩散）。

## TDD（Red → Green）
- 基线：改动前 80 条相关测试全绿（`SymbolList/store/DashboardPage/client/mock`）。
- 增量（红前绿后）：新增 星标（client 3 端点 + URL/method/body + 404/400 透传）、mock 收藏内存闭环、store 乐观+回滚、SymbolList 收藏置顶/星标/拖拽、DashboardPage 集成（api 调用 + 行归位 + 宫格回归）。
- 运行后 289 条全绿（见下）。

## 测试覆盖（新增/修改）
- `client.test.ts`：`getSymbols` 映射 favorite 两态（true+sort / false+null）；`starSymbol` POST URL；`unstarSymbol` DELETE URL；`reorderFavorites` PUT URL + body `{codes}` + content-type；404/400 ApiError 透传。
- `mock.test.ts`：初始全非收藏；star 置顶 + 幂等 + 收藏优先；unstar 幂等回退；reorder 重排 + 400（含未收藏）；star/unstar 未知 code 404。
- `store.test.ts`：`toggleFavorite` star（乐观标记 + 调 api.starSymbol）/ unstar（乐观移出 + 调 api.unstarSymbol）/ 失败回滚并 rethrow；`reorderFavorites` 乐观改 favoriteSort + 调 api / 失败回滚。
- `SymbolList.test.tsx`：收藏优先（favoriteSort 升序 + `data-fav` 标记）；无收藏不显示「已收藏」标签；收藏行带 handle、非收藏无 handle；星标点击调 `onToggleFavorite`（star/unstar 两路径）且不误触行选中；星标联动移入/移出收藏区；拖拽 drop → `onReorderFavorites` 新顺序。保留既有 9 条回归。
- `DashboardPage.test.tsx`：收藏置顶回归（收藏优先不影响宫格 2×2 / 单图 / 点选回焦点）；点星 → `api.starSymbol` 调用 + 行移入收藏区；收藏行拖拽 → `api.reorderFavorites` 新顺序。保留既有 8 条回归。

## 验证
- `npx vitest run`：**34 文件 / 289 条全绿**（含既有全部回归；无新增失败）。
- `VITE_API_MOCK=0 npx tsc -b`：通过（无类型错误）。
- `VITE_API_MOCK=0 npx vite build`：通过（仅 1 条既有 chunk-size >500KB 警告，非错误）。
  - `tsc -b` 类型检查覆盖 `src`（含测试），`src/layouts` 默认不 include 但被 import 拉入并校验。

## 残留风险 / 说明
1. **`SymbolSnapshot`/`SymbolRow` 收藏字段为可选（`favorite?`）**：为不触碰 `features/symbols`、`features/sources` 等**任务外**测试夹具，类型标记 optional。生产流 `dtoToSnapshot`/mock 恒填充，故行为正确；若后续其它消费者引用未增字段的构造需补者再拓宽。
2. **拖拽用 HTML5 DnD**：与点击选股的冲突通过 drag handle 区分（handle 仅收藏行）。真实浏览器拖动 `draggable` span（在 `<button>` 内）应触发 `dragstart`；jsdom 测试以 `dragCode` ref + 伪 `dataTransfer` 驱动。若浏览器出现 handle 拖拽不生效，可回退 pointer 方案（需升级为 pointerdown/pointermove，成本更高）。
3. **star span 内嵌 `role="button"`**（为可测且避免原生 `<button>` 嵌套警告）：功能与测试均通过；属 a11y 语义折中。
4. **store 不改写 list 顺序**：收藏置顶仅影响 symbol-list（Q4）；宫格沿用后端返回的收藏优先顺序（前端不额外重排）。
5. **mock 收藏状态不持久化**（内存态）：刷新即重置，与后端 DB 行为不等价；仅测试/联调用。
6. **`gitnexus` 工具**在本会话不可用（无对应 MCP 工具），未执行 `gitnexus_detect_changes`；改动均为任务范围内符号，`tsc -b`/vitest 覆盖回归。

## 暂存文件清单（`git add` 且**未 commit**，HEAD 仍为 `344753b`）
```
M web/src/api/client.test.ts
M web/src/api/client.ts
M web/src/api/mock.test.ts
M web/src/api/mock.ts
M web/src/api/types.ts
M web/src/features/dashboard/DashboardPage.test.tsx
M web/src/features/dashboard/DashboardPage.tsx
M web/src/features/dashboard/SymbolList.test.tsx
M web/src/features/dashboard/SymbolList.tsx
M web/src/features/dashboard/store.test.ts
M web/src/features/dashboard/store.ts
M web/src/layouts/DashboardGrid.tsx
```
仅上述任务内文件被暂存；未暂存仓库内其它 untracked（logs/报告等预存文件），未 commit。
