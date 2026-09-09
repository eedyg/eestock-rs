# 097 — sim-live 时间显示统一 CST（日期+HH:MM:SS）

## What changed

- **新增** `web/src/features/simlive/format.ts`：CST 格式化纯函数 `formatCstDateTime(ts): 'MM-DD HH:mm:ss'`。
- **新增** `web/src/features/simlive/format.test.ts`：5 个纯函数单测。
- **修改** `web/src/features/simlive/panels.tsx`：引入 `formatCstDateTime`，替换 `OrderTradeList` 委托/成交时刻
  `<td>{new Date(o.ts).toLocaleTimeString('zh-CN')}</td>` → `<td>{formatCstDateTime(o.ts)}</td>`。
- **修改** `web/src/features/simlive/SimLivePage.test.tsx`：新增 1 个面板级测试，断言订单表渲染 CST `09-08 14:54:17`。

## Architecture alignment

全部改动落在 `web/src/features/simlive/`（页面⑨ 模拟实盘展示层）。新增 `format.ts` 为展示层纯函数（与既有
`backtest/format.ts`、`quality/format.ts` 同格局），无跨层/跨模块依赖、未改任何接口/事件契约/后端，未动其它页面。

## Problem solved

委托/成交 `ts` 为 Unix 秒（UTC）。旧 `new Date(ts).toLocaleTimeString('zh-CN')` 取**浏览器本地时区**：若浏览器/机器
非 CST，会按 UTC 显示（如盘中 14:xx 被显示为 06:xx，看起来像时段外）；且只显示时分、无日期。实测 DB `sim_trades`
全部为 CST 盘中 14:xx，仅显示时区错。本次统一固定 Asia/Shanghai (CST, UTC+8) 并含日期+时分秒。

## Implementation approach

`formatCstDateTime` 采用「手算 +8」：对 UTC 时刻 `+8h` 后读其 `getUTC*` 字段即得 CST 墙钟。中国无夏令时、CST 恒为
UTC+8，故该法确定且与运行环境时区无关（等价于 `Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai'})` 的
`MM-DD HH:mm:ss`）。无效/非正输入返回 `'—'`，与 `backtest/format.ts#fmtTs` 口径一致。

`ts` 以秒为单位；`MM-DD HH:mm:ss` 紧凑含日期+时分秒。替换点唯一（simlive 全局检索 `toLocaleTimeString` 仅此一处）。

## Test coverage (TDD Red→Green)

- `format.test.ts`：
  - `Date.UTC(2025,8,8,6,54,17)/1000` → `09-08 14:54:17`（含日期，非仅 `14:54`）。
  - 输出匹配 `/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/` 且含 `:00` 秒。
  - 跨日：`2025-03-04T16:30:00Z` → CST `03-05 00:30:00`。
  - 固定 +8：`2025-01-01T00:00:00Z` → `01-01 08:00:00`，且同 ts 恒定输出。
  - 无效 `null/undefined/NaN/0/-5/Infinity` → `'—'`。
- `SimLivePage.test.tsx`：给定订单 `ts=Date.UTC(2025,8,8,6,54,17)/1000`，断言订单表渲染 `09-08 14:54:17`。
- Red：先写 `format.test.ts`，因 `format.ts` 不存在，vitest 报 `Failed to resolve import "./format"`（确认红）。
- Green：实现 `format.ts` 后全部通过。

## Verification (commands run)

- `cd web && npx vitest run src/features/simlive` → 3 files / 28 tests passed。
- `cd web && VITE_API_MOCK=0 npx tsc -b` → exit 0。
- `cd web && VITE_API_MOCK=0 npx vite build` → built in 1.13s（仅有既存 chunk>500kB 警告，与本次无关）。

## Residual risks

- 本次仅修复既有时间展示点（simlive 内 `toLocaleTimeString` 唯一一处 `panels.tsx` 委托/成交时间）。`SessionHistory`
  展示的是 `period`（M1/M5 等）而非时刻，`StockScoringTable`/`StrategyPanel` 未渲染时刻，故无其它替换点。
  若后续新增时刻展示（如 session start/end、事件流），应复用 `formatCstDateTime`。
- `TZ` 按 UTC 的 CI/容器与本地 CST 均得到一致输出（函数用 `getUTC*`，不依赖运行时时区）。
- 全局 vitest（`npx vitest run`）仍有 `src/features/alerts/store.test.ts` 6 个失败；已通过 `git stash` 回退本次改动
  复测确认 **为既有失败，与本改动无关**（改动不含 alerts 文件）。

## Staged files inventory (for parent review — no stage/commit)

- `web/src/features/simlive/format.ts` (new)
- `web/src/features/simlive/format.test.ts` (new)
- `web/src/features/simlive/panels.tsx` (modified)
- `web/src/features/simlive/SimLivePage.test.tsx` (modified)

report 自身位置：`/home/eestock/workspace/git/eestock/eestock-rs/coder/report/097_simlive_cst_time_format.md`
