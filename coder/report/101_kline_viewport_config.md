# 101 — 行情看板「默认K线数量」做成配置项（viewport_days）

> 本报告文件：`eestock-rs/coder/report/101_kline_viewport_config.md`
> 工作目录：`/home/eestock/workspace/git/eestock/eestock-rs`（独立 git repo）

## 问题 / 需求
`web/src/features/dashboard/feed.ts::defaultPageSizeForPeriod(period) = BARS_PER_TRADING_DAY[period] * 2`
把「默认视口」硬编码为 2 个交易日，用户嫌少。要求做成**用户可配置**（默认更足的初始视口），
只改 sim/backtest 之外的**看板前端 + web/存储配置 + 设置页**。遵循 ADR-007（tangle 事实源 = design/ 文档树）。

## 什么是改变了
- **配置（后端）**：`app_config`（迁移 0021）新增键 `kline`，value=`{"viewport_days":N}`（默认 2，整数 1-50）。
  - `GET /api/config/kline` → `{"viewport_days":N}`；表/键缺省或解析失败 → 回退 2。
  - `PUT /api/config/kline` body `{viewport_days}`：校验（整数 1-50，非整/0/51 → 400）→ 落库 → 返回回显。
- **看板 feed 读配置**：`defaultPageSizeForPeriod(period, viewportDays=2) = BARS_PER_TRADING_DAY[period] * viewportDays`；
  `DashboardPage` mount 时 `GET /api/config/kline` 读 `viewport_days`，作为 `viewportDays` 传入 `KlineDataFeed`（pageSize 初始化），默认 2 兜底。
- **设置页**：新增「K线视口」小节（`kline-config` 区域 + nav 锚点），含「默认K线视口(交易日)」输入（1-50，默认 2）→ `PUT /api/config/kline` → 乐观更新 + 回显，非法禁用保存。
- 文案/公式：每周期实际 bar = 该周期每日 bar 数 × viewport_days（1m=241×N、1d=1×N 等）。

### 文件清单（16 改 + 1 新增，+278/-30，全部暂存未提交）
| 文件 | 层 | 变更 |
|---|---|---|
| `crates/web/src/settings.rs` | web 处理器 | +KlineConfigDto、verify_kline_viewport_days、get_config_kline、put_config_kline、K_KLINE、DEFAULT_KLINE_VIEWPORT_DAYS、单元测试 |
| `crates/web/src/lib.rs` | web 路由 | +`.route("/api/config/kline", get(..).put(..))`（经 00-web-api.md tangle 再生成） |
| `crates/web/tests/api_settings.rs` | web 集成测 | +`config_kline_put_get_and_validate`（缺省 2 / PUT 2→10 落库读回 / 0·51·10.5→400） |
| `design/07-app-plane/00-web-api.md` | design 事实源 | +route 行 + API 契约表行（kline GET/PUT） |
| `design/06-web/08-settings.md` | design 事实源 | +'kline-config' 到 SettingsSection + `<section data-region="kline-config">` |
| `web/src/layouts/SettingsGrid.tsx` | 前端骨架（tangle 再生成） | +kline-config 区域（由 08-settings.md tangle 生成） |
| `web/src/api/types.ts` | 前端契约 | +`KlineConfigDto` |
| `web/src/api/client.ts` | 前端 API 客户端 | +`getKlineConfig`/`saveKlineConfig`（ApiClient 接口+实现） |
| `web/src/api/mock.ts` | 前端 mock | +klineViewportDays 内存态、`getKlineConfig`/`saveKlineConfig`、值域校验 |
| `web/src/features/dashboard/feed.ts` | 看板 feed | +DEFAULT_KLINE_VIEWPORT_DAYS、defaultPageSizeForPeriod(period, viewportDays)、KlineDataFeedDeps.viewportDays |
| `web/src/features/dashboard/DashboardPage.tsx` | 看板页面 | mount 读 getKlineConfig → viewportDays → 传 feed；feed 重建 deps 含 viewportDays |
| `web/src/features/settings/KlineConfigPanel.tsx` | 设置页（新增） | 「默认K线视口(交易日)」输入 + PUT 乐观更新/回显/非法禁用 |
| `web/src/features/settings/SettingsPage.tsx` | 设置页 | +`<KlineConfigPanel/>` 挂 `kline-config` 区域 |
| `web/src/features/settings/SettingsNav.tsx` | 设置页导航 | +`{ id:'kline-config', label:'K线视口' }` 锚点 |
| `web/src/features/dashboard/feed.test.ts` | 前端测试 | 改为可配置视口断言（覆盖缺省 2 / viewport_days / 统一公式） |
| `web/src/features/dashboard/DashboardPage.test.tsx` | 前端测试 | +K线视口配置：mount getKlineConfig → feed 用配置 pageSize(170) |
| `web/src/features/settings/SettingsPage.test.tsx` | 前端测试 | +K线视口面板 PUT/回显/非法禁用 + 区域齐备含 kline-config |

## 架构对齐
- **存储层**：复用既有 `domain::ports::ConfigStore`（`app_config` 0021，通用 key-value）+ `storage::config_store::PgConfigStore`，无需新增存储代码；`kline` 只是一条新 key（与 `sources/collector/mcp` 并列）。**未改 storage 表/迁移**。
- **web 层**：handler 放 `settings.rs`（既有 S2 配置持久化模块，app_config 键约定处；该文件为手写文件——非 filedb target，仅带旧 tangle 注释标记，文档未见 settings.rs 代码块 → 手改不破坏 tangle 幂等）。DTO/校验纯函数同置于 `settings.rs`。路由经 `00-web-api.md`（tangle 事实源）加一行，`entangled tangle` 再生成 `lib.rs`。
- **看板前端**：`feed.ts` + `DashboardPage.tsx`（手写）改 `defaultPageSizeForPeriod` 与 feed deps；`KlineChart.fitBarSpace` 维持 `defaultPageSizeForPeriod(period)`（默认 2），**不在本次要求范围**（见残留风险）。
- **设置页**：新增 `kline-config` 区域（tangle 骨架经 08-settings.md 再生成）+ 手写面板/导航。
- **未触**：backtest 引擎（`crates/backtest`/`crates/application`）、simlive、storage 读写、alert、collector、data-plane。

## 实现要点（已批准的架构内）
- 后端校验纯函数 `verify_kline_viewport_days(i32)`：`1..=50` 区间，非整由 `serde i32` 反序列化失败映射为 400；0/51/负值 → 400。
- GET 缺省/解析失败统一回退 `DEFAULT_KLINE_VIEWPORT_DAYS=2`（与 GET /api/config/{sources,mcp} 缺省回退同模式）。
- 前端 `defaultPageSizeForPeriod` 参数化 `viewportDays`（缺省 2），`KlineDataFeed` 用 `deps.pageSize ?? defaultPageSizeForPeriod(period, deps.viewportDays)`；宫格缩略图仍显式 `pageSize:120` 覆盖。
- `DashboardPage` 以 `useState(DEFAULT_KLINE_VIEWPORT_DAYS)` + `useEffect` 读 `getKlineConfig`（失败兜底 2），`feed` useMemo deps 含 `viewportDays`（配置加载后重建 feed 吸收新 pageSize）。
- 设置页「K线」小节：面板自取 `api`（与 McpConfigPanel 同模式），PUT 乐观更新，成功用后端回显，失败回滚，非整/越界禁用保存。

## 测试覆盖
- **后端单元**（settings.rs `#[cfg(test)]`）：`kline_viewport_days_validation`（1/2/10/50 合法；0/51/-1 拒）、`kline_config_dto_roundtrip_and_non_integer_rejected`。
- **后端集成**（api_settings.rs）：`config_kline_put_get_and_validate`（缺省 2；PUT 2→10 落库/GET 读回；0/51/10.5 → 400）。
- **前端**：`feed.test.ts`（缺省 2 / viewport_days 参数 / 统一公式 1m=241×N、1w=1×N）；`DashboardPage.test.tsx`（mount 读 getKlineConfig + feed 用配置 viewport_days=10 → 15m pageSize=17×10=170）；`SettingsPage.test.tsx`（K线视口面板 PUT=10 / 回显 / 0·51 禁用保存；区域齐备含 kline-config）。

## 验证
- `cargo test -p web --tests`：**45 passed; 0 failed**（含 settings 单元 + api_settings 集成 kline）。
- `cargo test --workspace`：仅 `crates/storage/tests/alert_store.rs::list_events_filters` 失败——**预存失败**（git stash 我的改动后重跑仍 FAILED；与本次无关，未 touch storage/alert）。
- `cd web && npx vitest run`：38 passed / 2 failed。失败全在 `src/features/alerts/*`（store.test.ts 6 + AlertsPage.test.tsx 1）——**预存失败**（stash 后重跑 alerts/store.test.ts 仍 6 failed；未 touch alerts）。
- `VITE_API_MOCK=0 npx tsc -b`：exit 0。
- `VITE_API_MOCK=0 npx vite build`：exit 0（built 128 modules）。
- `entangled tangle`：`Nothing to be done`（**幂等**；再生成 `lib.rs`、`SettingsGrid.tsx` 后与 markdown 事实源一致）。

## 残留风险
- `KlineChart.fitBarSpace` 仍以 `defaultPageSizeForPeriod(period)`（默认 2 交易日）计算蜡烛宽——当 `viewport_days>2` 时，主图**初始视口密度不随配置自动压缩**；但 feed 已加载 `viewport_days` 天 bar（滚动/缩放可见更多），满足「可见更多」主体语义。若要初始密度同步，可后续把 `viewportDays` 传入 `fitBarSpace`（本次不扩scope）。
- 周/月（1w/1mo）视口由特殊化 30/24 改为统一 `1×viewport_days`（默认 2 根）——**行为变更**：周/月初始窗口变稀疏。这是需求「每周期实际 bar = 每日 bar 数 × viewport_days」的直接结果；1w/1mo 属边缘周期，回测不使用（仅 M1/M5/M15/D1 回测）。
- `design/06-web/preview/08-settings.html`（设置页 L1.5 样机）未同步新增 K线小节——仅为静态文档样机，不影响功能/tangle 幂等。
- 集成测试依赖 TimescaleDB :5433（本环境可用，已跑通）；无 DB 环境会跳过/失败（预存模式）。

## 暂存清单（git add，未 commit）
17 个文件（16 改 + 1 新增）：见上表。
`git status --short | grep '^[MAD]'` 显示全部 `M`/`A`，无 `??` 混入（coder/report、AGENTS.md 等既定未跟踪文件未暂存）。
未 commit（铁律）。
