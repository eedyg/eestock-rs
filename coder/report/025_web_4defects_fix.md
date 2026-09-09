# 报告 025：Web 前端修复 D1 / D2 / D9 / N2（严格 TDD Red→Green→Refactor）

> 本报告文件位置：`coder/report/025_web_4defects_fix.md`
> 任务范围：`eestock-rs/web`。仅改动列出的源/测试文件；未改动 feed.ts KlineDataFeed 契约、DB/SQL/Rust；未跑全量 e2e（仅定向 vitest + e2e）；未 commit（仅暂存）。

## 汇总

| 项 | 结论 | 状态 |
|----|------|------|
| D1 数据源详情面板优雅降级 | 不再发 4 条 `/api/sources/{id}/*` 请求，detail-panel 显示占位，移除 4 个「加载失败/404」错误态 | Green |
| D2 停用/无数据标的不显示假读数 0.000 | `SymbolSnapshot` 增 `enabled`/`last:null`；列表按状态渲染「已停用/无数据」 | Green |
| D9 kline-matrix e2e 断言 480→482 | 断言已改，`limit=482`（241×2）与前端一致；单用例在限流断言处已通过 | 断言已修复；用例因环境收盘无分时数据在后段停 |
| N2 visual app 告警基线数据敏感 | 告警列表容器固定 `max-h` + `overflow-y-auto`，doc 高度恒定（实测 1→30 行均 800px） | Green（机制已本地验证 + 重基线） |

---

## D1：数据源详情面板优雅降级（ADR-014，不建后端）

**根因**：点源健康卡后 `detail-panel` 触发 `GET /api/sources/{id}/metrics|events|divergence|rate-limits` 4 条，但后端 `build_router` 未注册（设计 00-web-api §126 Phase A 不做）→ 4×404 console error + UI「加载失败」。

**裁决**：尊重 ADR-014，后端端点延后 → 前端降级，不建后端。

### 改动文件
- `src/features/sources/store.ts`：`DetailState` 由 4 个 `AsyncSlice` 简化为 `{ detailUnavailable: boolean }`；`selectSource(id)` 展开仅置 `detailUnavailable: true`，不再调用 `loadDetail`；`setDetailRange` 仅更新 `detailRange`，不再重查；删除私有 `loadDetail/loadMetrics/loadEvents/loadDivergence/loadRateLimits/detailGuard`；清理不再使用的类型导入（`MetricPoint/DivergenceStat/RateLimitCounters/SourceEventItem`）。
- `src/features/sources/SourceDetailPanel.tsx`：整组件改为占位渲染「详情数据将在后续版本提供（后端端点 Wave 2+ 上线）」，移除 MetricsSparkline/事件流水/分歧率/限流卡及其错误态。
- `src/features/sources/SourcesPage.tsx`：不再向 `SourceDetailPanel` 传 `range/onRangeChange`。
- `src/features/sources/store.test.ts`：重写「点卡展开」与「范围切换」两用例为新 D1 行为。
- `src/features/sources/SourcesPage.test.tsx`：重写「点卡展开详情」为占位 + 未发请求断言；删除已失效的「Trace ID 点击复制」用例。

### Red→Green
- **Red**：新断言 `store.state.detail?.detailUnavailable` 为 `undefined`（旧结果）、`getSourceMetrics/Events/Divergence/RateLimits` 仍被调用 → 3 个用例失败。证实旧代码仍发请求、无占位标志。
- **Green**：改造后 `store` 不再发 4 条请求、`detailUnavailable=true`；`SourcesPage` 点卡后默认折叠→展开 detail-panel 显示占位文本，断言未发出 `/api/sources/{id}/metrics|events|divergence|rate-limits` 请求。`npx vitest run src/features/sources/...` → 19/19 通过。

### 保留（未动）
- `ApiClient` 的 `getSourceEvents/getSourceMetrics/getSourceDivergence/getSourceRateLimits` 4 个方法（后端落地后的契约，不删除）。
- 源卡健康显示、手动复位按钮、缺口摘要（GapCards）、告警预览（AlertPreview）均正常。

---

## D2：停用/无数据标的不显示 0.000

**根因**：`SymbolRow.latest` 为 null（如新注册即停用/尚未采到数据）时，`dtoToSnapshot` 兜底 `last=0/changePct=0`；`SymbolList.tsx` 直接 `s.last.toFixed(3)` 渲染 0.000。

**裁决**：显示「已停用/无数据」，行仍可点看历史 K 线。

### 改动文件
- `src/layouts/DashboardGrid.tsx`：`SymbolSnapshot` 增 `enabled: boolean`，`last` 改为 `number | null`（有数据为价格；latest=null → null）。保留 `changePct: number`。
- `src/api/client.ts` `dtoToSnapshot`：`enabled: d.enabled`、`last: d.latest?.last ?? null`。
- `src/api/mock.ts` `getSymbols`：同上映射（`159776` enabled=false → last=null）。
- `src/features/dashboard/SymbolList.tsx`：按状态渲染——`!enabled` →「已停用」（`opacity-50` 置灰）；`enabled && last===null` →「无数据」；`enabled && last!==null` → 正常 `last.toFixed(3)` + 涨跌幅。整行仍为 `<button>` 可点击加载 K 线。
- 测试 fixture 补齐：`src/features/dashboard/SymbolList.test.tsx`（新增 disabled + no-data 符号与新用例）、`src/features/dashboard/DashboardPage.test.tsx`、`src/features/dashboard/store.test.ts`、`src/api/client.test.ts`、`src/api/mock.test.ts`、`src/features/sources/SourcesPage.test.tsx`（getSymbols 覆盖对象补 `enabled`）。

### Red→Green
- **Red**：新增用例 `enabled=false→已停用`、`enabled=true 且 last=null→无数据`。旧 `SymbolList` 对 `last=null` 直接抛 `Cannot read properties of null (reading 'toFixed')`，6 个用例失败（含既有回归用例）。
- **Green**：改造后 `SymbolList.test` 9/9 通过；`store.test`/`DashboardPage.test`/`client.test`/`mock.test`/`SourcesPage.test` 全绿。
  - 断言覆盖：`enabled=false` 行文本含「已停用」且 `queryByText('0.000')` 为 null、click 仍触发 `onSelect('159776')`；`enabled=true 且 last=null` →「无数据」且无 `0.000`；正常行仍渲染 `last/changePct`（回归）。

---

## D9：kline-matrix e2e 断言过期（480→482）

**根因/裁决**：D9 用例断言 `limit=480`，但「2 交易日视口」正确为 `BARS_PER_TRADING_DAY['1m']=241 ×2 = 482`（feed.ts）。前端 `TimeshareChart` 复用 `KlineDataFeed`（默认 `defaultPageSizeForPeriod('1m')=482`）实际请求 `limit=482`；仅断言过期。

### 改动文件
- `e2e/kline-matrix.e2e.ts`：`u.includes('limit=480')` → `u.includes('limit=482')`，注释同步。

### 验证（对 192.168.50.100:8081）
- `E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/kline-matrix.e2e.ts -g "D9"`：
  - **断言 `hit.length>0`（period=1m 且 limit=482）通过**，证明前端确实请求 `limit=482`，断言修复正确。
  - **失败点**：`[data-region="main-chart"] svg` 不可见。环境为「已收盘 08:17 采集停止」，当日无 1m 分时 bar → `TimeshareChart` 渲染「该时段无数据」（无 `<svg>`）。此为环境数据可用性（收盘后无当日数据），与本次断言改动无关（我未触碰分时渲染逻辑）。**结论**：D9 断言本身已修复；用例全绿依赖目标库在交易时段有当日数据。

---

## N2：visual 告警基线数据敏感（告警行数→页高）

**根因**：`/alerts` 的 alert-list 为自然高容器，告警行数变化 → 页高变化 → fullPage 截图高度变化 → 视觉基线像素差（数据驱动 flaky）。

**裁决**：给告警列表容器设固定高度 + `overflow-y-auto`（内部滚动），使 doc 高度恒定。

### 改动文件
- `src/features/alerts/AlertList.tsx`：数据分支根容器 `p-3 text-xs` → `max-h-[680px] overflow-y-auto p-3 text-xs`。

### 验证（对本地代码；192.168.50.100 为本机，app 为 docker 镜像内嵌前端，需重建镜像后环境才含本改动）
- 用本地 vite dev（`VITE_API_MOCK=0` 走真实后端 + 代理）`page.route` 拦截 `/api/alerts` 返回 N 条，逐档实测：

| rows | doc height | 列表容器 clientH | 内容 scrollH | 内部滚动 |
|------|-----------|-----------------|-------------|---------|
| 1 | 800 | 70 | 70 | false |
| 5 | 800 | 254 | 254 | false |
| 13 | 800 | 622 | 622 | false |
| 14 | 800 | 668 | 668 | false |
| 19 | 800 | 680 | 898 | **true** |
| 20 | 800 | 680 | 944 | **true** |
| 30 | 800 | 680 | 1404 | **true** |

- 结论：doc 高度恒为 800（视口），alert-list 区域恒为 712；行数超过 680px 后在容器内滚动。原问题（19→20 行页高 +46px）被消除。

### 重基线说明（有意 UI 变更）
- `E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/visual.e2e.ts -g "告警" --update-snapshots` 已重生成 `web/e2e/screenshots/visual.e2e.ts-snapshots/alerts-full-chromium-linux.png`（94349→88167 字节）。
- 再次运行（无 `--update-snapshots`）对该基线 **PASS**。
- ⚠️ **部署依赖**：192.168.50.100:8081 由 docker-compose `app` 服务（`Dockerfile.app`）内嵌前端 dist 提供，当前运行镜像不含本改动。本报告的重基线是在**本地开发者代码**（localhost:5173）上完成的，镜像重建后需在目标环境再跑一次 `visual.e2e.ts -g "告警"` 复核（结构已 mask，alert-list 内容被屏蔽，region 尺寸恒定，预期稳定）。重基线属有意 UI 变更，进度中如实注明。

---

## 验证输出

### vitest（全套）
`cd web && npx vitest run`
```
Test Files  1 failed | 22 passed (23)
Tests       1 failed | 178 passed (179)
```
- **唯一失败**：`src/features/quality/QualityPage.test.tsx > 五区齐备... 开始日期 2026-08-29 比对 2026-08-30`。该用例在改动前即已失败（基线运行确认）；其断言为硬编码过滤栏日期 `2026-08-29`，随系统当前日期漂移，属**既有环境日期敏感失败**，与本次 4 项无关（未改任何 quality 文件）。

### 构建（tsc + vite）
`cd web && npm run build`
```
tsc -b && vite build
✓ 96 modules transformed.
dist/index.html…  dist/assets/index.js (512.88 kB)…
✓ built in 933ms
```
- 一次中间报错：`SymbolList.tsx(71,19) TS6133: 'noData' declared but never read`（引入第 2 版临时变量），已用 `inactive` 替换逻辑并移除，重建通过。

### 定向 e2e
- D9：`E2E_BASE_URL=http://192.168.50.100:8081 npx playwright test e2e/kline-matrix.e2e.ts -g "D9"` → 限流断言（limit=482）通过，后段 svg 因环境收盘无当日分时数据未绿（见 D9 说明）。
- N2：`E2E_BASE_URL=http://localhost:5173 npx playwright test e2e/visual.e2e.ts -g "告警" --update-snapshots` → PASS；再次运行（无 update）→ PASS。

## 跳过的项与原因
- **未跑全量 e2e**：按任务要求仅跑定向 vitest + D9/N2 定向 e2e；未跑 `dashboard.e2e/walkthrough/smoke` 等全量。
- **QualityPage.test.tsx 失败未修**：为既有日期敏感失败，不在本任务范围（未列改动文件），也未触碰 quality 模块。
- **未重建/未 deploy app 镜像到 192.168.50.100:8081**：任务未赋予；N2 视觉基线在本地代码上重生成，镜像重建后需复核。
- **未 commit**：仅 `git add` 暂存。

## 残留风险
1. **GridCell（宫格视图）**：`GridCell.tsx` 仍直接 `symbol.changePct.toFixed(2)%`；对停用/无数据标的（changePct=0）会在 2×2/2×3 宫格显示「0.00%」。本任务 D2 范围聚焦 symbol-list（SymbolList），未改 GridCell；若需求覆盖宫格需另行修复（架构无明显歧义，故未升级，仅记录）。
2. **dashboard 视觉基线**：`MASKS_BY_PAGE.dashboard` 屏蔽 `[data-region="symbol-list"] .num`，但 D2 新增的「已停用/无数据」文本非 `.num`。若真实标的列表出现停用/无数据标的，dashboard fullPage(视口) 基线可能需 `--update-snapshots`；当前环境列表均有价格（见 D9 error-context），未受影响。
3. **D9 全绿依赖数据**：D9 用例后段需当日 1m 分时 bar；收盘后环境「该时段无数据」使 svg 断言不绿。
4. **N2 max-h 值**：`max-h-[680px]` 在 1280×800 下区域可用高度 712px，680 留有裕量；若视口高度显著减小（列表区域 < 680px），可能不足，需按目标视口复核。

## 暂存文件清单（`git add`）
- `web/e2e/kline-matrix.e2e.ts`
- `web/e2e/screenshots/visual.e2e.ts-snapshots/alerts-full-chromium-linux.png`
- `web/src/api/client.test.ts`
- `web/src/api/client.ts`
- `web/src/api/mock.test.ts`
- `web/src/api/mock.ts`
- `web/src/features/alerts/AlertList.tsx`
- `web/src/features/dashboard/DashboardPage.test.tsx`
- `web/src/features/dashboard/SymbolList.test.tsx`
- `web/src/features/dashboard/SymbolList.tsx`
- `web/src/features/dashboard/store.test.ts`
- `web/src/features/sources/SourceDetailPanel.tsx`
- `web/src/features/sources/SourcesPage.test.tsx`
- `web/src/features/sources/SourcesPage.tsx`
- `web/src/features/sources/store.test.ts`
- `web/src/features/sources/store.ts`
- `web/src/layouts/DashboardGrid.tsx`

（未暂存：`../.claude`、`AGENTS.md`、`CLAUDE.md`、`backup_symbols.sql`、`logs/*`、`coder/report/023/024`、`tester/*` 等与本次无关文件。）
