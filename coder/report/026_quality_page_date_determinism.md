# Coder Report 026 — QualityPage.test.tsx 日期确定化（修 flaky）

报告文件位置：`eestock-rs/coder/report/026_quality_page_date_determinism.md`

## What changed

- **文件**：`eestock-rs/web/src/features/quality/QualityPage.test.tsx`（仅 1 文件，`15 insertions / 1 deletion`）
- **修改内容**：
  - 在 vitest import 中新增 `beforeEach, afterEach`。
  - 加入固定系统时钟 `const NOW = new Date('2026-09-04T05:42:00Z')`（= 2026-09-04 13:42 CST）。
  - 顶层 `beforeEach` 执行 `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(NOW)`；`afterEach` 执行 `vi.useRealTimers()`。
- **未改动**：`store.ts`、`QualityPage.tsx` 等任何生产代码；`src/test/setup.ts` 也无需改动（把 Date 假化局部作用在测试文件内即可）。

## Architecture alignment

- 变更完全落在 **web 前端测试层**（`src/features/quality/QualityPage.test.tsx`），属于测试隔离/确定性手段，不涉及任何业务逻辑、接口或层边界。
- 生产代码 `store.ts` 已提供 `deps.now` 注入钩子，但 `QualityPage.tsx` 未把 `now` 透传给 store（`new QualityStore({ api })`）。因此无法从组件 props 注入固定 now；在不改生产代码的前提下，改用**伪造系统时钟 Date**来让 `defaultRange(this.now())` 得到确定值。伪造仅限 `['Date']`，保留真实 `setTimeout`，故 RTL 的 `findBy*`/`waitFor` 仍正常工作。

## Problem solved / Root cause

- **症状**：`npx vitest run` 仅 `QualityPage.test.tsx` 失败：期望「开始日期」`2026-08-29`，实收 `2026-08-30`。
- **根因**：quality store 默认范围由 `defaultRange(now, days=7)` 推导（`from = now - (days-1)*86400000`），`now = deps.now ?? (() => new Date())`。该测试渲染 `<QualityPage />`，而 `QualityPage` 用 `new QualityStore({ api })` 且未透传 `deps.now`，store 落到**真实 `new Date()`**。环境日历滚动后 `from` 漂移（当前为 2026-09-05 → from=2026-08-30），与测试硬编码的 `2026-08-29` 不符 → flaky。
- **对照组** `store.test.ts` 用固定 NOW（`new Date('2026-09-04T05:42:00Z')`）故通过。
- **解法**：测试内固定系统日期为 `2026-09-04T05:42:00Z`，`defaultRange` 得 `from='2026-08-29'`、`to='2026-09-04'`，与硬编码断言及 mock 数据（`DIVERGENCE/ACCURACY/GAPS` 的 from/to 均为 `2026-08-29/2026-09-04`）完全一致，测试不再随日历漂移。

## Implementation approach

- 采用「**伪造 Date 使 now 确定**」而非「用 `defaultRange(new Date())` 计算期望值」：后者虽自洽，但仍依赖真实 now，存在极端跨午夜竞态、且属「测真实 now」的脆弱性。伪造 Date 彻底消除真实时钟依赖，与任务推荐「注入固定 now」的意图一致。
- `only Date` 被伪造，避免干扰 RTL 的 `waitFor`/`findBy*`（它们依赖真实 `setTimeout`）。已用独立探针验证：`new Date()` 返回固定值，同时真实 `setTimeout` 回调仍能触发。

## Test coverage

- `QualityPage.test.tsx`（6/6 通过）——恢复后所有断言仍有效，日期相关断言（`开始日期` = `2026-08-29`）不再漂移。
- **未新增/删除用例**：仅调整测试环境，测试数量与断言集合保持不变。
- 全量 `npx vitest run`：**23 个文件 / 179 个用例全绿**。

## Verification

- `cd web && npx vitest run` → `Test Files 23 passed (23) / Tests 179 passed (179)`。
- `cd web && npm run build` → `tsc -b && vite build` 通过（仅有既存 chunk >500kB 提示，与本变更无关）。
- `git diff --cached` 仅含 `QualityPage.test.tsx`。

## Residual risks

- **跨午夜极小竞态已消除**：伪造 Date 为固定值，`new Date()` 在测试期间恒定，不再依赖真实系统时间。
- **潜在影响面**：本测试文件内所有用例运行于固定时钟 `2026-09-04`，若未来新增依赖「当前日期」的断言，需注意与该固定时钟保持一致的期望值。
- **未触及生产代码**：`store.ts` 的 `deps.now` 注入钩子在页面层仍未透传；若未来页面需要真全局注入（而非仅测试伪造），应优化 `QualityPage` 让 `now` 可注入（属生产改动，非本任务范围，需另行裁决）。
- **范围收敛**：仅修本文件；其它日期类测试（`store.test.ts`、其它页面测试）本就通过，未扩大改动。

## Git state

- 已 `git add eestock-rs/web/src/features/quality/QualityPage.test.tsx`（暂存 1 文件）。
- **未 commit**：HEAD 仍处 `7fab9f1`（上一提交），未创建任何新提交。
