# 06-web / 09 — 前端工程实施说明（Wave 1 Phase B）

> 2026-09-04 定稿节后 Phase B 开工时落稿。本文档是**手写例外的工程决策说明**（entangled.toml 已声明：前端构建配置不 tangle），不含 tangle 代码块；布局/区域/视觉契约仍以 00-shell.md 与各页文档为事实源。

## 1. 构建配置（手写例外，不 tangle）

`web/` 下以下文件为手写工程文件，不进入 design/ tangle 事实源：

- `package.json` / `package-lock.json` / `vite.config.ts` / `tsconfig*.json` / `tailwind.config.js` / `postcss.config.js` / `index.html` / `components.json`（shadcn 约定清单）
- `web/src/` 下除 `layouts/*Grid.tsx`（tangle 骨架）外的全部实现代码

## 2. 依赖与版本基线（ADR-008 落地）

| 类别 | 选型 | 说明 |
|---|---|---|
| 构建 | Vite 6 + TypeScript 5.8 | `npm run build` = `tsc -b && vite build` |
| 框架 | React 18 + react-router-dom 6 | 路由表与 00-shell §路由索引一致 |
| 样式 | Tailwind 3.4 + shadcn 约定 | shadcn 按需落码（`components.json` + `lib/utils.ts` cn + `components/ui/`），不跑 CLI 全量生成 |
| K线 | klinecharts 10 | 主图 candle pane + 副图 VOL pane 单实例；MA(5/10/20) 内置指标 |
| 测试 | Vitest 3 + Testing Library + jsdom | 行为测试（数据流/交互/状态），不测样式；klinecharts 在测试中整体 mock |

## 3. 骨架组合模式：RegionPortal（禁止手改骨架的落地方式）

L3 骨架（`web/src/layouts/*Grid.tsx`）由 tangle 单向生成、禁止手改，其区域为带 `data-region` 锚点的空容器。业务组件通过 `RegionPortal`（`web/src/components/RegionPortal.tsx`）以 React Portal 挂入对应锚点：

- 页面组件渲染 `<DashboardGrid {...props}/>` 作为布局基座，再按区域 id 各挂一个 `<RegionPortal region="symbol-list">…</RegionPortal>` 等
- 骨架的 Props 契约（`DashboardGridProps`）即页面状态对外接口，页面状态机（store）向其对齐
- 视觉样式/数据获取全部在业务组件内手写，骨架文件零改动

## 4. Mock 层决策：手写 mock，不引 MSW

后端 Phase A 并行开发中，前端按契约先行。决策：**手写 mock client**（`web/src/api/mock.ts`），理由：

1. 契约面仅 3 个端点（§5 下表），fetcher 注入即可切换真/假实现，MSW 的 service worker 拦截对此规模是过度工程
2. 测试直接注入 mock client 断言数据流，无需网络层拦截
3. 零新增 dev 依赖

切换方式：`VITE_API_MOCK=0` 或后端就绪后移除 mock 开关，默认开发态 mock 开启。

## 5. API 契约假设（以 01-dashboard §5 / 02-sources §8 为准；Phase A 对齐）

| 端点 | 请求 | 响应（前端假设，Phase A 需对齐） |
|---|---|---|
| `GET /api/symbols` | — | `[{code, name, last, changePct}]`（latest 快照内联） |
| `GET /api/kline` | `?code=&period=&before=<ts>&limit=` | `[{ts, open, high, low, close, volume, amount}]` 升序；`before` 为排他上界游标，缺省返回最新 limit 根 |
| `GET /api/sources/health` | — | `{collectorRunning: boolean, sources: [{id, name, role: "1m"\|"snapshot", status: "healthy"\|"degraded"\|"circuit"}]}` |
| `WS /ws` | 订阅 `{type:"subscribe", topic, code?, period?}` | 推送 `{type:"bar", code, period, bar}` / `{type:"quote", code, last, changePct}` / `{type:"source_health", ...}` |

WS 订阅键规范（客户端内部）：`bar:<code>:<period>`、`quote`（全量快照推送）、`source_health`。

⚠️ 响应包络（是否包 `{data: ...}`）文档未定稿，前端按裸数组/裸对象实现；Phase A 若采用包络，改 `api/client.ts` 一处解析即可。

## 6. Vite dev proxy

`/api` 与 `/ws`（`ws: true`）代理到 `VITE_PROXY_TARGET`（默认 `http://localhost:8080`）。应用面容器端口由 Phase A 定稿后调整此处默认值。

## 7. 视觉基线落地

`web/src/index.css` 的 CSS 变量直接复用 `preview/01-dashboard.html` 基线：`--bg:#0b0e17`、`--panel:#121627`、`--panel2:#171c33`、`--up:#ff5c6c`（红涨）、`--down:#00e0a4`（绿跌）、`--acc1:#38bdf8`→`--acc2:#a78bfa` 渐变强调、等宽数字（tabular-nums）。Tailwind 色板映射同名 token，组件内用 `bg-panel text-dim` 等语义类。

## 8. 导航置灰口径（按波次）

① 行情看板（W1 Phase B，本波交付）；② 数据源诊断 / ③ 标的管理（W1 Phase C，置灰标 W1）；④ 数据质量 / ⑦ 告警中心（W2）；⑤ 回测（W3）；⑥ 交易（W4）；⑧ 系统设置（各波次，页面未实现前置灰）。置灰项不可点击，无路由。
