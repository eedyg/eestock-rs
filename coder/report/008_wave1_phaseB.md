# 008 — Wave 1 Phase B：前端骨架 + 页面①行情看板

> 报告位置：`coder/report/008_wave1_phaseB.md`（本文件）
> 任务：web/ 前端工程 scaffold + 应用骨架（导航/状态条/WS/路由）+ 页面①行情看板 + 数据层（API client + mock）+ Vitest 行为测试。
> 依据：wave-1.md（2026-09-04 实施定稿）、00-shell.md、01-dashboard.md（全部定稿）、preview/01-dashboard.html（视觉基线）、ADR-008。
> 断点续跑：首轮完成测试（Red）与数据层/壳部分实现，本轮补齐组件实现、修绿、构建、tangle 门禁、stage。

## What changed（已 git add，未 commit；不含 Cargo*/crates//README/docker-compose——Phase A 地盘）

**工程决策文档（手写例外说明）**
- `design/06-web/09-frontend.md`（新增）：构建配置手写例外清单、依赖版本基线、RegionPortal 骨架组合模式、手写 mock 决策（不引 MSW）、API 契约假设表、dev proxy、视觉 token 落地、导航置灰口径。

**构建配置（手写例外，不 tangle）**
- `web/package.json` `package-lock.json` `vite.config.ts` `tsconfig{,.app,.node}.json` `tailwind.config.js` `postcss.config.js` `index.html` `components.json`（shadcn 约定）`web/.gitignore`（dist/）

**应用骨架（shell）**
- `src/shell/navItems.ts` + `NavBar.tsx`：8 项导航，仅 ① 可点（NavLink aria-current），②③ 置灰标 W1、④⑦ W2、⑤ W3、⑥ W4、⑧ 无标签置灰
- `src/shell/TopBar.tsx`：H=40 状态条——交易时段 pill（客户端计算，写死 09:30-11:30/13:00-15:00）、采集灯、1m 源健康数 pill（Link→/sources）、WS 断开重连提示
- `src/shell/session.ts`：tradingSession/sessionLabel/shanghaiTimeHHMM/shanghaiDayKey（UTC+8 平移法）
- `src/shell/AppShell.tsx`：状态条数据 = GET /api/sources/health + WS source_health 触发刷新；秒级时钟
- `src/App.tsx` `src/main.tsx`：路由仅 `/`（页面①），其余回落 `/`

**WS 客户端（00-shell：单连接 /ws，订阅分发，指数退避重连）**
- `src/ws/WsClient.ts`：订阅键 `bar:<code>:<period>`/`quote`/`source_health`；open 后自动补发订阅；意外断线 1s→2s→4s…封顶 30s 重连并恢复订阅；手动 close 不重连
- `src/ws/index.ts`：defaultWs 单例（同源 /ws，经 Vite proxy）

**页面①行情看板**
- 布局基座 = tangle 骨架 `src/layouts/DashboardGrid.tsx`（**零改动**，git diff --cached 为空）；业务组件经 `src/components/RegionPortal.tsx` portal 进 data-region 锚点
- `features/dashboard/store.ts`：页面状态机（标的集合/选中/周期默认 15m/宫格/跟随/搜索过滤）+ WS quote 增量；useSyncExternalStore 绑定
- `features/dashboard/feed.ts`：KlineDataFeed——初始加载（limit=500）/向前游标分页（before=最早 ts，去重拼接，不足 pageSize 置 hasMore=false）/WS 实时 append·update·ignore/retry；幂等 loadInitial
- `features/dashboard/KlineChart.tsx` + `chartCommon.ts`：klinecharts v10 单实例（candle pane + VOL 副图 pane），MA(5/10/20) 默认开、MACD/KDJ/BOLL 勾选热切换；DataLoader 接线（init→loadInitial、forward→loadBefore、subscribeBar→WS 实时）；跟随最新=scrollToRealTime，手动 onZoom/onScroll 后不强拉（programmatic 标志防自触发），「回到最新」恢复
- `features/dashboard/SymbolList.tsx`：搜索框（code/名称模糊）+ code/名称/最新价/涨跌幅（红涨绿跌）；三态=骨架行/「去标的管理」引导链/错误条+重试
- `features/dashboard/Toolbar.tsx`：周期 1m/5m/15m/1h/日、K线/分时 Tab、指标勾选、宫格 单图/2×2/2×3、回到最新（跟随中禁用）
- `features/dashboard/GridCell.tsx`：宫格缩略图（K线+MA 无副图，pageSize=120），点格→选中+回单图
- `features/dashboard/TimeshareChart.tsx` + `timeshare.ts`：分时=当日 1m bar 客户端计算价格线+均价线（累计额/累计量），轻量 SVG

**数据层**
- `src/api/types.ts` `client.ts`：ApiClient（getSymbols/getKline 游标分页/getSourcesHealth），fetcher 可注入
- `src/api/mock.ts`：确定性契约 mock（4+标的、各周期 bar 边界对齐、before 排他游标、可注入 now）；`src/api/index.ts` 默认 mock，`VITE_API_MOCK=0` 切真后端

## Architecture alignment

- 骨架/布局层：tangle 生成物零手改，组合走 RegionPortal（09-frontend.md §3 落稿的决策）；Props 契约直接复用骨架的 DashboardGridProps/DASHBOARD_DEFAULTS（Period/GridMode/SymbolSnapshot 从骨架再导出，无双事实源）
- 视觉：CSS 变量逐值复用 preview 基线（--bg #0b0e17、--up #ff5c6c 红涨、--down #00e0a4 绿跌、--acc1/2 青紫渐变、tabular-nums）
- 无新增设计外依赖：全部依赖在 ADR-008 栈内（react/router/tailwind/shadcn 约定/klinecharts）+ 测试栈（vitest/testing-library/jsdom）；@types/node 仅为 vite.config 类型（devDep）
- 未触碰 crates//Cargo*/README/docker-compose；Phase A 并行改动一律未 stage

## Test coverage（12 文件 79 例，全绿）

- `shell/session.test.ts`：交易时段边界（09:30/11:30/13:00/15:00）+ 周末 + 标签
- `shell/NavBar.test.tsx` / `TopBar.test.tsx` / `AppShell.test.tsx`：8 项置灰与波次标签、状态条三 pill、健康数取 1m 角色源
- `ws/WsClient.test.ts`：订阅帧拆解、topic 分发、退订帧、指数退避（1s→2s→封顶）+重连恢复订阅、手动关闭不重连、状态回调
- `api/client.test.ts` / `api/mock.test.ts`：URL/游标参数、非 2xx 抛错；mock 确定性、周期对齐、before 排他无重复
- `features/dashboard/store.test.ts`：init 三态、默认 15m/单图/跟随、quote 增量、宫格切换不丢状态、搜索过滤、dispose 后免疫推送；KlineDataFeed 分页去重/hasMore/empty·error/retry/实时 append-update-ignore
- `features/dashboard/SymbolList.test.tsx` / `Toolbar.test.tsx`：三态、交互回调、aria-pressed
- `features/dashboard/DashboardPage.test.tsx`：骨架锚点齐备、portal 落位、默认 15m、选标/搜索/quote 实时价、2×2=4 格·2×3=6 格、点格回单图、周期切换触发重取数（klinecharts 整体 mock）
- `features/dashboard/timeshare.test.ts`：均价累计口径、零量 bar 不污染

## Verification

```
npx vitest run   → Test Files 12 passed (12) / Tests 79 passed (79)
npm run build    → tsc -b && vite build ✓（dist js 451.75 kB / gzip 133 kB）
tangle 门禁      → entangled tangle “Nothing to be done”；my scope（web/、design/06-web/）git diff 为空
```

⚠️ 整仓 `./scripts/check-tangle.sh` 当前红，但差异 100% 属 Phase A 并行会话的未 stage 文件（crates/app·storage lib.rs tangle 生成物、crates/*/Cargo.toml、docker-compose.yml、.gitignore 的 app.toml 行、design/03·04·10 三篇文档）。我未 stage 亦未回退（回退会破坏其事实源同步）；Phase A stage 后门禁即绿。本轮已验证我范围内 tangle 一致。

## Residual risks / 待 Phase A 对齐项

1. **API 响应包络假设**（09-frontend.md §5）：/api/symbols、/api/kline、/api/sources/health 按裸数组/裸对象解析；若 Phase A 用 `{data:…}` 包络，改 client.ts 一处
2. **/api/sources/health 形态**（collectorRunning + sources[].role/status）系按 02-sources L2 推断，文档未定字段级契约
3. **klinecharts 真渲染未在 jsdom 验证**（组件测试中整体 mock）；DataLoader/pane/scroll 行为建议后端就绪后人工冒烟一次（npm run dev）
4. **VOL 副图跨区**：klinecharts 副图只能在单容器内分 pane，而骨架 main-chart/sub-chart 是两个锚点；实现用 h-[125%] 容器横跨两区（VOL pane 视觉落入 sub-chart 区），为「禁止手改骨架」约束下的折衷
5. 分时图为轻量 SVG（当日 1m 价格线+均价线），十字光标/缩放在分时 Tab 不支持（K线 Tab 完整）
6. Vite proxy 默认 `http://localhost:8080`，Phase A 端口定稿后用 VITE_PROXY_TARGET 对齐
