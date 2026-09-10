# 126 · 技术债清算（前端车道）：TD-4 工作台进度竞态 + TD-5 alerts 测试根治

- 报告位置：`eestock-rs/coder/report/126_frontend_tech_debt_td4_td5.md`
- 范围：`eestock-rs/web/` 4 个文件（已 `git add`，未 commit）

---

## TD-4：工作台 store 进度竞态（P3b 评审 NIT-6）

### 根因（证据链）

1. **WS 帧无状态字段**：后端 `crates/web/src/workbench.rs:334` `WorkbenchWsSink` 发布 `{type:"strategy_run_progress", run_id, progress, bar_ts}`——无 status 字段，终态判定无法以帧状态为准。
2. **发帧先于终态提交**：`crates/application/src/workbench.rs` 引擎 observer 循环（~L706-740）每根 bar 先 `sink.send(progress)`，最后一根 bar 发出 `progress=1` 帧之后才 `mark_succeeded`（L757，事务落结果）。`progress>=1` 帧到达前端时立即 GET 可能命中 `running@100%` 行，且之后不再有帧 → 行卡「运行中 100%」直至手动刷新。失败路径 `mark_failed`（L687/770/773）前无终态帧，同理卡「运行中」。
3. **同构模式 grep 结论**：`progress >= 1` / `refreshRunInList` 全仓仅存在于 `src/features/workbench/store.ts`（旧 backtest/store.ts 已随 P4b 删除；simlive store 无 progress 逻辑）。**仅 workbench 一处需修**。

### 修复

`src/features/workbench/store.ts`：

- `refreshRunInList(id, attempt = 0)`：GET 后若 `data.status` 仍为 `queued/running`（竞态命中），**不置终态**，调度 `scheduleRefreshRetry(id, attempt+1)`——`REFRESH_RETRY_MS = 1500`ms 后再次 GET，最多 `REFRESH_MAX_RETRIES = 3` 次复核（即首次 GET + 至多 3 次重试）。
- `scheduleRefreshRetry`：同 run 重复触发时 `clearTimeout` 旧定时器（不产生并行复核链）；`disposed` 后不再调度。
- `dispose()`：统一清理 `retryTimers`（防卸载后泄漏 GET）。
- 既有不变量保留：当前行已终态 → 提前 return；复核拿到 `succeeded` 且当前选中 → 照旧 `loadResult`；GET 异常 → 保留当前行。

### TDD 证据

- **Red**：先写 3 个测试，`npx vitest run src/features/workbench/store.test.ts` → 2 失败（`expected getWorkbenchRun to be called 2 times, but got 1` / `4 times, but got 1`），精确复现「GET 一次后卡死」。
- **Green**：实现后 `src/features/workbench` 5 文件 50 测试全过。

新增测试（`src/features/workbench/store.test.ts`）：
1. `TD-4：progress=1 GET 命中 running@100% → 1.5s 短延迟复核，复核到 succeeded 翻终态（不卡死）`——mock 首次 GET 返回 `running@100%`、第二次返回 `succeeded`；断言 t=0 仍 running（不误置终态）、t=1.5s 复核后翻 succeeded。
2. `TD-4：持续 running 时最多复核 3 次后停手`——GET 恒返回 running，15s 窗口后 `getWorkbenchRun` 恰好 4 次调用（首次+3 复核），行保持 running（不无限轮询、不误置终态）。
3. `TD-4：dispose 清理待复核定时器`——dispose 后推进 15s，无后续 GET。

### 遗留风险

- **失败 run 无终态帧**：失败路径 `mark_failed` 前不发帧，`progress<1` 不触发复核链——失败 run 行仍可能停在「运行中（部分进度）」，兜底仍是 selectRun/手动刷新。根治需后端发终态帧（或帧带 status 字段），属后端改动，本车道未动。
- 复核 3 次（≈4.5s）内后端仍未提交的极端慢事务场景，行保持 running，等下一帧/手动刷新兜底。

---

## TD-5：alerts 前端 7 个既有测试失败根治

### 诊断（调试纪律：先跑测试取证，非读码猜测）

`npx vitest run src/features/alerts` 修复前真实输出：

```
store.test.ts (10 tests | 6 failed)：
 × ack / ack 失败(404) / ack 失败后再成功 → TypeError: Cannot read properties of undefined (reading 'id')
   （store.state.list.data!.find(a => a.status === 'triggered') 返回 undefined）
 × WS alert 推送新事件入列表头部 → expected +0 to be 1
 × WS 推送按当前过滤收纳 → expected false to be true
 × 列表加载失败→重试恢复 → expected 0 to be greater than 0
AlertsPage.test.tsx (7 tests | 1 failed)：
 × WS 实时推送 → Unable to find an element with the text: 采集停摆：WS 新事件
```

### 根因：时钟漂移（非后端契约漂移，非策略系统引入）

- store 默认过滤 `range:'today'`，`from` 由 `rangeFromIso(range, this.now())` 推导；未注入 `now` 时用**真实时钟**。
- 契约 mock 种子 `initialAlertEvents()`（`src/api/mock.ts:211`）硬编码在 `2026-09-07T01:47–02:35Z`；测试固件 `ev()` / `EVENTS` / WS 推送事件同样固化在 2026-09-07。
- 真实时钟跨过 2026-09-07（CST 日界）后：`from` > 全部种子时间 → mock `queryAlerts` 按 from 过滤后列表为空 → 6 个 store 测试连环失败；WS 推送路径 `matchesFilter` 用真实时钟比较 `last_fired_at < from` → 新事件被过滤 → page 测试失败。
- 同文件前 2 个测试（init/过滤变更）之所以一直通过，正因为它们注入了 `now: () => new Date('2026-09-07T05:00:00+08:00')`——失败的 7 个只是漏注入。测试编写日（2026-09-07 当天）全部通过，属典型时间炸弹。

### 修复（仅测试文件，零生产代码改动，零断言削弱）

- `src/features/alerts/store.test.ts`：describe 内新增 `const FIXED_NOW = () => new Date('2026-09-07T05:00:00+08:00')`，全部 10 处 `new AlertsStore(...)` 统一注入 `now: FIXED_NOW`（含原本就注入的 2 处，统一为常量）。
- `src/features/alerts/AlertsPage.test.tsx`：WS 推送测试用 `vi.useFakeTimers({ now: new Date('2026-09-07T05:00:00+08:00'), toFake: ['Date'] })` 仅 fake Date（定时器保持真实，不影响 waitFor/userEvent），`finally` 中 `vi.useRealTimers()` 恢复。`AlertsPage` 不接受 `now` prop，为不动生产代码选测试侧钉时钟。

### 证据链

- 修复前：7 failed / 17（输出见上）。
- 修复后：`npx vitest run src/features/alerts` → **2 文件 17 测试全过，0 失败**。
- 全量：`npm test` → **45 文件 440 测试全过**；`npm run build` → 0 error（chunk >500kB 警告为既有）。

### 遗留风险

- 契约 mock 的 alerts 种子仍是绝对日期（其余种子均相对 `anchorNow`）。本次以钉测试时钟根治；若未来新增依赖真实时钟的 alerts 测试，需同样注入 `now`（文件内注释已说明）。
- 后端契约无漂移，未改后端。

---

## 变更清单

| 文件 | 改动 |
|---|---|
| `web/src/features/workbench/store.ts` | +38/-2 行：终态复核重试（REFRESH_RETRY_MS/REFRESH_MAX_RETRIES/retryTimers/scheduleRefreshRetry），dispose 清理定时器 |
| `web/src/features/workbench/store.test.ts` | +3 个 TD-4 测试（Red→Green） |
| `web/src/features/alerts/store.test.ts` | 注入 FIXED_NOW（10 处），新增根因注释 |
| `web/src/features/alerts/AlertsPage.test.tsx` | WS 测试 fake Date 钉时钟 + 根因注释 |

## 验证命令

- `npx vitest run src/features/workbench/store.test.ts`（Red：2 失败 → Green：全过）
- `npx vitest run src/features/alerts`（修复前 7 失败 → 修复后 17/17）
- `npm test` → 45 文件 440 测试全过
- `npm run build` → 0 error
