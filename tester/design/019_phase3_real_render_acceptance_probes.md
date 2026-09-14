# 测试设计 019 — 阶段 3 独立验收：真渲染探针（切 period/stock 不重置 pane 布局）

- **本文件位置（self-location）**：`tester/design/019_phase3_real_render_acceptance_probes.md`
- 关联执行报告：`tester/test/054_period_stock_switch_layout_phase3_acceptance_execution.md`
- 关联证据：`tester/evidence/phase3_accept/`（`probes/` 探针源码、`json/` 原始输出、`4x_*.log` stdout、`0x/2x/3x_*.txt` 基线/门禁/卫生）
- 被测实现（工作树，未提交）：`web/src/features/dashboard/KlineChart.tsx`（Effect L / Effect W 拆分）
- 权威口径：`design/14-dcap-indicator/02-spec.md` §6、`design/06-web/11-kline-viewport-bars.md`（ADR-020）、`design/06-web/01-dashboard.md`
- 仓库根：`/home/eestock/workspace/git/eestock/eestock-rs`；`HEAD = ece1d9d`

## 1. 测试策略摘要

阶段 3 的判据是「真渲染下，切 period / 切 stock 后既有 pane 的高度/pane id/图表实例不重建，而数据确实重置」，
以及 ADR-020 视口、WS、overlay、DCAP 的回归。设计为**三条独立构建 + 一个受控 harness** 的对照实验：

| 构建 | 根目录 | 端口 | 产物 | 作用 |
|---|---|---|---|---|
| **A（修复/工作树）** | 仓库 `web/` | 18091 | `/tmp/acc3/dist-a` | 被测对象（工作树 = 修复后） |
| **B（HEAD 旧行为）** | `/tmp/acc3/alt`（`git show HEAD:` 覆盖 `KlineChart.tsx`） | 18092 | `/tmp/acc3/dist-b` | 反向对照 ①：退回旧行为 ⇒ **高度族必须红** |
| **C（变异：不换数据）** | `/tmp/acc3/mut`（工作树版 + `getBars` 恒用首个 feed） | 18093 | `/tmp/acc3/dist-c` | 反向对照 ②：不换数据 ⇒ **数据族必须红** |
| **H（受控 harness）** | `/tmp/acc3/harness`（真实 `KlineChart` + 注入 feed/overlays） | 18095 | `/tmp/acc3/dist-h` | overlay 创建/清理、WS 追加、DCAP 断线、参数热更新 |

- 全部临时构建/端口在 `/tmp`；`/api`、`/ws` **只读**代理线上 `127.0.0.1:8081`；浏览器侧写防护：GET 放行、
  `PUT /api/config/*` 本地兑现（不发后端/DB）、其余非 GET 一律 abort。
- klinecharts 用**真身** `10.0.3`（`kc-spy.ts` 仅包裹实例方法以记录调用序列/暴露 `window.__ACC__`，不改算法/渲染）。

## 2. 被测组件与断言族

### 2.1 高度/身份族（H）—— 核心需求①
- `H_heights_within_1px`：所有内容 pane 的 DOM 渲染高度与切换前差 ≤1px；
- `H_pane_ids_same`：pane id 集合（按「pane 内指标名」索引）逐值不变；
- `H_no_remount(inits)`：`window.__ACC__.inits` 不递增（无 `init`）；
- `H_no_dispose`：`disposes` 不递增；
- `H_no_create_remove_churn`：切换窗口内调用序列不含 `createIndicator` / `removeIndicator`。

### 2.2 数据重置族（D）—— 核心需求②
- `D_symbol_updated` / `D_period_updated`：`getSymbol()/getPeriod()` 为新值；
- `D_data_window_matches_GT`：chart 已渲染 `dataList` 与**独立 ground truth**（Node 直连线上 8081
  `GET /api/kline?code=NEW&period=NEW&limit=188`）在**时间戳窗口**一致（允许实时漂移 ≤6 根）；
- `D_data_values_match_GT`：重叠时间戳上的 **close 取值**逐根一致（相对误差 ≤1e-6）；
- `D_data_changed_from_before`：首 5 根 (ts, close) 或首根 ts 相对切换前发生变化；
- `D_request_hit_new_code_period`：切换窗口内出现 `code=NEW&period=NEW` 的 `/api/kline` 请求。

### 2.3 回归族（R）
- `R_viewport*`：`data-viewport-fit.bars==120`、`space==clamp(round(W/120),1,50)` 且 ∈[1,50]、可见 ≈120；
- `R_manual_zoom`：真实 wheel 改 barSpace；其后 resize 不重算；再切周期仍回自动视口归一；
- `R_ws*`：构造真实 WS 帧（`page.addInitScript` 捕获 app 的 `WebSocket`，`dispatchEvent('message')` 走真实
  `onmessage` 链）⇒ dataList +1、末根 ts = 推送 ts；`followLatest=true` ⇒ `scrollToRealTime`；手动缩放后 ⇒ 只追加不强拉；
- `R_dcap*`：独立副图、`precision=5`、figures `s,m,l,zero`、数据不足断线、warmup `limit=120`（关）/ 差额 68 / 窗口 188（开）；
- `R_prev_fix*`：真实 UI 保存 dcap 参数（PUT 本地兑现）⇒ 不重建 pane、高度 ±1px、走 `overrideIndicator`、参数生效；
- `H1..H5`（harness）：overlay 创建（3）/跨 feed 先清后建（3→2）、marker 锚定、WS、DCAP 断线、参数热更新。

### 2.4 反向证据设计（互不掩盖）
- **B（退回旧行为）**：期望 H 族红、D 族绿 ⇒ 证明 H 族能抓住「remount」这一回归，且 D 族不会替它掩盖。
- **C（`getBars` 恒用首个 feed，即「布局保持但数据没换」）**：期望 H 族绿、D 族红 ⇒ 证明 D 族能抓住
  「为保布局而不换数据」，且 H 族不会替它掩盖。

## 3. 边界与构造要点
- 周期覆盖 **15m / 1h / 1m**（三次切换），标的覆盖 **518880 / 161226 / 513310**（两次切换）——满足派单下限；
- 拖拽经真实 `SeparatorWidget` 分隔线（`cursor:ns-resize`）鼠标拖动，非直接写 `options.height`；
- ground truth 与 chart 数据的比较采用「窗口 + 取值」双判据，且允许交易时段实时新增 ≤6 根漂移；
- harness 无 tailwind：用 `<style>` 显式给 `[data-testid="kline-chart"]` 尺寸，保证真实 pane 高度非 0。

## 4. Mock/桩策略
- 真身 klinecharts（不桩）；仅包一层透传 spy 记录 `setDataLoader/setSymbol/setPeriod/resetData/removeOverlay/
  createOverlay/createIndicator/removeIndicator/overrideIndicator/setPaneOptions/scrollToRealTime` 及 `inits/disposes`。
- 后端：只读代理线上 8081（GET）；写请求浏览器侧本地兑现/阻断。harness 的 feed 为测试注入的最小实现。
