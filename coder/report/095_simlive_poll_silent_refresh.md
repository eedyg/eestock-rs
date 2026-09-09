# 095 · /sim-live 轮询刷新改为页内静默刷新（不整页刷新/不滚回顶部）

本文件位置：`eestock-rs/coder/report/095_simlive_poll_silent_refresh.md`（repo: eestock / eestock-rs 子仓库 web）

## 根因

`SimLiveStore.refreshCurrent()`（`SimLivePage` 内 `setInterval(..., 5000)` 轮询调用）原先每次都通过
`loadCurrent()/loadStrategies()/loadOrders()` 执行：

```ts
this.patch({ current: { data: null, loading: true, error: null } });   // ← 每次轮询清空 data + loading
```

即每次轮询都把当前 `data` 置 `null`、`loading` 置 `true`。页面渲染端 `const current = s.current.data ?? EMPTY_STATE`
在 `data` 为 `null` 时退到 `EMPTY_STATE`（`active:false`、空 positions/stocks/orders），于是：

- `session-control` 从「运行中 · <id>」闪退回「未运行」；
- `position-table` 从表格退成「无持仓」（`SimPositionTable` 收敛）；
- `strategy-panel` 退成「未启动会话」，`stock-scoring` 退成「未评估」。

由于这些面板实际渲染于 `SimLiveGrid` 的 `overflow-y-auto` 滚动容器（页面作用域 `[data-region=sim-live]`），
内容高度在「完整运行态 ⇄ 空态」之间每 5 秒塌缩/重建一次，滚动容器随之**滚回顶部**，视觉上等同于整页刷新。

## 修复（refreshCurrent 静默/后台刷新）

将 `loadCurrent/loadStrategies/loadOrders/loadSessions` 增加可选参数 `opts?: { silent?: boolean }`：

- **silent = true（轮询）**：拉取前**不再** `patch({ data: null, loading: true })`，保留原位 `data` 与 `loading`
  （data 在位置原样显示）；拉取成功后 `patch({ data: 新, loading: false, error: null })` 原位更新；
  失败时**保留旧 data**（`{ ...prev, error }`），仅记录 error，下次轮询覆盖。
- **silent = false（默认，首次/init）**：维持原「骨架」语义（`data: null, loading: true`），只有首次/无数据加载走骨架。

`refreshCurrent()` 改为调用三种 load 均传 `{ silent: true }`；`SimLivePage` 的 5s 轮询因此成为原位刷新，
**不清空 data、不真 loading、不触发骨架、不重置滚动**。

`selectSession()` / `runBacktestCompare()` 等用户主动一次性动作**保留**原 loading（切换视图可接受），未改动。

`AsyncSlice` / `SimLiveState` 接口未变；未新增 `refreshing` 标志（task 标注为可选，若需下拉刷新指示可后续加，当前不引入以避免 UI 面扩散）。

## What changed

| 文件 | 变更 | 说明 |
|------|------|------|
| `eestock-rs/web/src/features/simlive/store.ts` | +61 / -15 | 四个 load* 增加 `opts?: { silent?: boolean }`；silent 分支保留原位 data、不置 loading；`refreshCurrent` 传 `{ silent: true }` |
| `eestock-rs/web/src/features/simlive/store.test.ts` | +59 | 新增 `refreshCurrent（静默刷新）` describe：已有 data 不 null/不 loading 且原位更新；首次无 data 骨架 loading；静默失败保留旧 data 仅设 error |
| `eestock-rs/web/src/features/simlive/SimLivePage.test.tsx` | +38 / -? | 新增「轮询刷新（5s）内容保持原位：不闪退骨架/未运行态」用例（fake timers 推进 5s + deferred getSimState 观察拉取中间态） |

合计 `3 files changed, 143 insertions(+), 15 deletions(-)`。

## Architecture alignment

- `store.ts` 属**状态机/数据拉取**层（页面⑨ 模拟实盘业务状态；图表库无关）。改动只在「如何刷新数据」——
  把「整页型重载」收敛为「原位更新」，属同一层内部实现调整，未改变 `SimLiveStore` 对外接口、
  `AsyncSlice`/`SimLiveState` 契约、或任何区域与面板边界。
- `store.test.ts` / `SimLivePage.test.tsx` 属**行为测试**，随实现变更补充，不引入新依赖。

## Implementation approach

- 以 `silent` 开关区分「初载（骨架）」与「轮询（原位）」，而不是另起一套方法，避免重复代码与接口漂移。
- 静默失败时沿用 `{ ...prev, error }` 保留旧 data，保证页面在有数据期间**永不因失败退空态**；下次轮询成功后覆盖 error。
- `refreshCurrent` 本身被 `startSession/stopSession/placeOrder` 复用，统一走静默；这些动作后的数据原位更新，
  用户主动动作（`selectSession/runBacktestCompare`）不受影响。

## Test coverage

- `store.test.ts`（新增 3 例，共 5）：
  1. 已有 data 时 `refreshCurrent` 不置 `data=null`/不置 `loading=true`，拉取后原位更新（`trading_enabled/mcp_enabled` 变化反映）；此例在旧实现下 **Red**（`data` 变 `null`）。
  2. 首次无 data（`init`）→ 骨架 `loading=true`；数据到位后 `loading=false`。
  3. 静默刷新失败 → 保留原位 data、`loading` 不闪 true、仅设 `error`；此例在旧实现下 **Red**（`data` 变 `null`）。
- `SimLivePage.test.tsx`（新增 1 例）：`vi.useFakeTimers({ toFake:['setInterval','clearInterval'] })` + 推进 5s 触发轮询 +
  `mockReturnValueOnce(pending)` 挂起 `getSimState`，断言「拉取中间态」`sim-session-status` 仍含「运行中」、
  `sim-position-table`/`sim-strategy-panel` 节点引用未变（未重挂/未塌缩）；旧实现下 **Red**（闪退「未运行」）。

## Verification

- `cd eestock-rs/web && npx vitest run`：`Test Files 2 failed | 37 passed`；**失败 7 例全部在 `alerts`**
  （`AlertsPage.test.tsx`、`alerts/store.test.ts`），与本次改动无关，且在干净树（stash 我的修改）下亦复现，属既有失败。
  sim-live：`SimLivePage.test.tsx (17)`、`store.test.ts (5)` 全绿。
- `VITE_API_MOCK=0 npx tsc -b`：退出码 0（无类型错误）。
- `VITE_API_MOCK=0 npx vite build`：成功（126 modules；chunk>500KB 为既有警告，非本次引入）。

## 残留风险

1. `alerts` 相关 7 例单测为**既有失败**（干净树复现；疑似与 `Date.now`/时钟/WS 相关），未在本次范围，未处理。
2. 静默刷新不再清空 `sessions`；`sessions` 刷新仅由 `setTab`（首次进历史）/`stopSession` 触发（非轮询），仍走 loading，
   符合「用户主动动作可保留 loading」。
3. 未添加 `refreshing` 指示（可选）。若产品需「下拉刷新/正在刷新」视觉，可在 store 增加 `refreshing` 布尔，页面据此渲染指示器，但不触发骨架/重置滚动——本次未引入以避免 UI 面扩大。
4. jsdom 无真实布局，滚动位置「不滚回顶部」通过「内容未塌缩（节点未重挂）」间接验证；真机目验建议按 tester/test/016 路径复核。
5. GitNexus MCP 工具（`gitnexus_impact`/`gitnexus_detect_changes`）在本会话不可用；已人工确认改动仅触及 simlive store 私有方法及轮询调用点，blast radius 受限。

## 暂存文件清单

**未暂存（working tree 已修改，未 `git add`，未 `git commit`）**：

- `modified: eestock-rs/web/src/features/simlive/store.ts`
- `modified: eestock-rs/web/src/features/simlive/store.test.ts`
- `modified: eestock-rs/web/src/features/simlive/SimLivePage.test.tsx`

`git stash` 验证过程已 pop 恢复；当前仅上述 3 文件处于 modified，无 staged。
