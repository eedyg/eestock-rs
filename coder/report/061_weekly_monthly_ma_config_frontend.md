# Coder Report 061 — 行情看板 W2 前端：周/月周期切换 + MA 可配置（统一，主图/宫格）

**Report file:** `coder/report/061_weekly_monthly_ma_config_frontend.md`（本文件）

**Repo/工作区：** `eestock-rs`（嵌套 git；`web/` 子目录）。**不 commit、不 git add**（遵循 Acceptance `noStagedFiles: true`）。

**范围铁律：** 只改 `web/src/features/dashboard/*`、`web/src/layouts/DashboardGrid.tsx`、`web/src/api/*`。唯一例外：父级批准（reason=need_decision, 方案 A）给 `web/src/features/backtest/ScopedKlineFeed.ts` 的 `PERIOD_STEP_MS` 加 `1w/1mo` 两键（纯类型完整性修复，零行为改变）。未改后端/DB/SQL/Rust、未改回测弹窗/回测周期。

---

## ①② 实现概览

### ① 周期切周/月（前端）
- **`web/src/layouts/DashboardGrid.tsx`**：`Period` 类型扩为 `'1m'|'5m'|'15m'|'1h'|'1d'|'1w'|'1mo'`；`DASHBOARD_DEFAULTS.period` 注释补 1w(周)/1mo(月)。`api/types.ts` 经 re-export `Period`（无需改动，单一事实源在 DashboardGrid）。
- **`web/src/features/dashboard/chartCommon.ts`**：`PERIOD_MAP` 增 `'1w' → {type:'week',span:1}`、`'1mo' → {type:'month',span:1}`（klinecharts 周期映射）。
- **`web/src/features/dashboard/feed.ts`**：`BARS_PER_TRADING_DAY` 增 `'1w':1`、`'1mo':1`（周/月一个单位即一根）；`defaultPageSizeForPeriod` 对 `1w→30`（≈30 周，半年+）、`1mo→24`（≈24 月，两年）——**非 2×交易日**（2×1=2 根会过疏），含取值注释。
- **`web/src/features/dashboard/Toolbar.tsx`**：周期按钮组增 `{value:'1w',label:'周'}`、`{value:'1mo',label:'月'}`；点按 → `onPeriodChange('1w'/'1mo')`。`DashboardPage` 已把 `state.period` 透传给 `KlineChart`（`PERIOD_MAP` 按新周期加载），`chartTab==='kline'` 显示周/月，`timeshare` 仍恒 1m（不动）。

### ② MA 可配置（统一，主图+宫格）
- **`web/src/api/types.ts`**：`MaConfigDto { windows: number[] }`（GET/PUT /api/config/ma 契约）。
- **`web/src/api/client.ts`**：`ApiClient` 增 `getMaConfig(): Promise<MaConfigDto>`、`saveMaConfig(windows): Promise<MaConfigDto>`；HTTP 实现 `get('/api/config/ma')`、`request('PUT', body {windows})`。
- **`web/src/api/mock.ts`**：`PERIOD_MS` 增 `1w/1mo` 键（7d/30d）；新增 `getMaConfig`/`saveMaConfig`（内存态 `maWindows`，默认 [5,10,20]）；`normalizeMaWindows`（1-3 条、1-500、去重升序，校验 400，与后端 `validate_ma_windows` 同构）。
- **`web/src/features/dashboard/Toolbar.tsx`**：MA 开关附近新增 `MaConfigControl`（`MA(5,10,20)` 点击展开，1-3 条窗口输入框，保存按钮）。保存→调用 `onSaveMaWindows(parsed)`；父级先同步 `setMaWindows` 乐观更新再 await 接口，失败回滚。与既有 MA 指示器 toggle 共存（toggle 控开关、配置控件控窗口）。
- **`web/src/features/dashboard/DashboardPage.tsx`**：新增 `maWindows` state（默认 `[5,10,20]`，mount 时 `api.getMaConfig()` 读）；`saveMaWindows`（乐观更新 + api + 失败回滚 rethrow）；把 `maWindows` 传给 `Toolbar`/`KlineChart`/`GridCell`。
- **`web/src/features/dashboard/KlineChart.tsx`**：增 `maWindows?` prop；`syncIndicators` 接受 `maWindows`，MA `calcParams` 用配置窗口（默认 [5,10,20]）；指示器 effect deps 加 `maWindows`（热生效）。
- **`web/src/features/dashboard/GridCell.tsx`**：增 `maWindows?` prop；MA `calcParams` 用配置窗口。**修复关键点**：MA 窗口变更仅走独立 effect（`chartInstanceRef` 存储 chart 实例，removeIndicator+createIndicator 重刷 MA），**不把 `maWindowsProp` 放进建图/feed effect**——否则会 dispose 掉 memoized `KlineDataFeed` 后复用其 disposed 实例，grid view 在 MA 保存后失效。
- **`web/src/features/backtest/ScopedKlineFeed.ts`**（父级批准）：`PERIOD_STEP_MS` 加 `'1w':7*86400000`、`'1mo':30*86400000`（仅使 `Record<Period,number>` 穷举闭合；回测周期不含 1w/1mo，永不读这两键，零行为改变）。

---

## Architecture alignment
- 分层：MA 配置契约（types/client/mock）在 `api` 层；看板 UI（Toolbar/DashboardPage/KlineChart/GridCell）在 `features/dashboard`；周期枚举事实源在 `layouts/DashboardGrid`（tangle 骨架）；`feed`/`chartCommon` 为看板数据/周期适配。未改接口、层边界、依赖方向。
- `api/types.ts` 保持从 `DashboardGrid` re-export `Period`（单一事实源），未双写。
- 统一配置：一处（`DashboardPage.maWindows`）→ 主图 + 宫格全部用；回测弹窗独立（只读默认周期，不改）。
- 后端线格式 `MaConfigDto{windows}` 与后端 serde（`crates/web/src/dto.rs`）同构；前端序列化 `saveMaConfig({windows})` 与后端 `Json<MaConfigDto>` 对齐。

## Problem solved / feature added
- 周线/月线在行情看板前端可切（周期数据流 KlineDataFeed → KlineChart 按新 period 加载，PAGEMAP/PERIOD_MAP/视口已适配）。
- MA 窗口统一可配置：一个控件改窗口 → PUT /api/config/ma → 乐观更新 → 主图 + 宫格 K 线 MA `calcParams` 即时生效。

## Implementation approach (within approved architecture)
- 视口：`defaultPageSizeForPeriod` 对周/月用固定窗口（30/24），注释注明取值口径（非 2×交易日）。
- 乐观更新：`DashboardPage.saveMaWindows` 先 `setMaWindows(windows)`（同步）再 `await api.saveMaConfig`，成功后用后端归一化结果覆盖，失败回滚并 rethrow。`MaConfigControl` 只消费 `maWindows` prop 与 `onSaveMaWindows`，保证测试可注入。
- MA 应用：`KlineChart`/`GridCell` 均读 `maWindows` prop（缺省 [5,10,20]），避免双事实源；GridCell 用 chart 实例 ref + 独立 effect 热刷 MA，规避 feed dispose/reuse 缺陷。

## Test coverage（Red→Green）
- **Red 先行**：先写 `chartCommon.test.ts`、`feed.test.ts`、`KlineChart.test.tsx` + 更新 `Toolbar.test.tsx`/`GridCell.test.tsx`/`DashboardPage.test.tsx`/`client.test.ts`/`mock.test.ts` 断言（1w/1mo 映射、页大小、calcParams、saveMaConfig 调用/乐观/回滚、GET/PUT URL）。首轮 `npx tsc -b` 暴露 2 个编译错误（Toolbar 新必填 props 未在测试 defaults 提供、`placeholder` number/string），修后转绿。
- **增量明细**：
  - `Toolbar.test.tsx`：周期按钮断言补 `周/月`；新增 周/月点击→onPeriodChange(1w/1mo)；MA 配置控件：改窗口→保存→`onSaveMaWindows([7,10,20])`；乐观更新（父级同步 `maWindows` 后标签显示 `MA(7,10,20)`）；保存失败回滚到 `MA(5,10,20)`（用 `MaConfigHarness` 模拟父级乐观处理器）。
  - `chartCommon.test.ts`（新）：PERIOD_MAP 1w→week、1mo→month。
  - `feed.test.ts`（新）：defaultPageSizeForPeriod('1w')=30、('1mo')=24；且均 > BARS_PER_TRADING_DAY×2；常规周期仍 2× 交易日。
  - `KlineChart.test.tsx`（新）：klinecharts 打桩断言 MA `createIndicator` calcParams = 默认 [5,10,20] / 配置 [7,20,60]；maWindows 变更后重新 sync（取 MA 调用断言）。
  - `GridCell.test.tsx`：默认 calcParams=[5,10,20]；传 maWindows=[7,20,60]→calcParams=[7,20,60]。
  - `DashboardPage.test.tsx`：周期切 周/月→getKline period 1w/1mo；MA 保存→调 saveMaConfig([7,10,20]) + KlineChart 应用新 calcParams。
  - `client.test.ts`：getMaConfig→GET /api/config/ma；saveMaConfig→PUT /api/config/ma body {windows}。
  - `mock.test.ts`：getMaConfig 默认 [5,10,20]；saveMaConfig 归一化（去重升序）+ 持久化；校验 400（空/超3条/0/501）。

## Verification
- `npx vitest run`（stack 在 `eestock-rs/web`）：**37 files / 311 tests 全绿**（含既有 dashboard/backtest/alerts/settings 回归）。
- `VITE_API_MOCK=0 npx tsc -b`：通过（0 错误）。
- `VITE_API_MOCK=0 npx vite build`：通过（121 modules，产物 index-*.js 569.71 kB；>500kB 分块告警为既有，非本次引入）。
- 新测试重复运行稳定（连续两次 vitest 全绿）。

## Residual risks
1. **`defaultPageSizeForPeriod` 对 1w/1mo 用固定值（30/24）**：为「合理初始窗口」的工程判断（非交易规则推导）；若上线后觉得周应更多/月应更少，改 `feed.ts` 两处 return 即可，有测试兜底。
2. **GridCell 用独立 effect 热刷 MA**：`chartInstanceRef` 存 chart 实例，maWindows 变更 removeIndicator+createIndicator 重刷。若未来 chart 重建与 MA 热刷的 effect 顺序变化，需重审。当前测试（含 maWindows 变更）通过。
3. **乐观更新期间并发双争**：`saveMaWindows` 用 `useCallback([api, maWindows])`，连续快速保存两次时上一次的 `prev` 可能覆盖下一次的乐观结果（类似收藏乐观更新的既有语义；本任务未加竞态锁，与既有 toggleFavorite 一致）。
4. **maWindows 读取失败保持默认**：`getMaConfig` 失败静默用 [5,10,20]（不阻塞看板，无错误三态）；若后端不可用则在下次成功保存时覆盖。
5. **工具链残余**：`web/tester/` 未跟踪（与本次无关）；chunk-size 告警既有。

## 暂存文件清单（changed files，未 commit、未 git add——遵循 Acceptance `noStagedFiles: true`）
**修改（16 tracked 在 `web/`）**：`web/src/api/client.test.ts`、`web/src/api/client.ts`、`web/src/api/mock.test.ts`、`web/src/api/mock.ts`、`web/src/api/types.ts`、`web/src/features/backtest/ScopedKlineFeed.ts`（父级批准类型完整性）、`web/src/features/dashboard/DashboardPage.test.tsx`、`web/src/features/dashboard/DashboardPage.tsx`、`web/src/features/dashboard/GridCell.test.tsx`、`web/src/features/dashboard/GridCell.tsx`、`web/src/features/dashboard/KlineChart.tsx`、`web/src/features/dashboard/Toolbar.test.tsx`、`web/src/features/dashboard/Toolbar.tsx`、`web/src/features/dashboard/chartCommon.ts`、`web/src/features/dashboard/feed.ts`、`web/src/layouts/DashboardGrid.tsx`。

**新增（3 未跟踪）**：`web/src/features/dashboard/KlineChart.test.tsx`、`web/src/features/dashboard/chartCommon.test.ts`、`web/src/features/dashboard/feed.test.ts`。
