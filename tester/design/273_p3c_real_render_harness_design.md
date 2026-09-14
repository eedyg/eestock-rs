# 273 — P3-C 真实渲染验收仪器设计（真身 klinecharts 10.0.3 × 真 `ChartSyncGroup`）

- **本文件路径（自指）**：`tester/design/273_p3c_real_render_harness_design.md`
- 角色：Tester（设计 + 落地**新仪器**；未改任何产品/测试代码）
- 时间：2026-09-15（本地，UTC+8）
- 配套：执行报告 `tester/test/273_p3c_independent_acceptance_execution.md`；仪器与结果 `tester/evidence/273_p3c_acceptance/`
- 本轮**不含**：产品级 React 组件（`DashboardPage`）真实驱动；LIVE 虚线段（P4）；纵向溢出（P5）

---

## 1. 目的与边界

`chartSyncGroup.test.ts` 用 jsdom + 忠实桩验证「调用面语义」，但**不驱动真身几何/事件**。P3-C 需要产品级**真实渲染**独立复核，故新建一个最小仪器：把**真 `ChartSyncGroup`**（`esbuild` 打包 `chartSyncGroup.ts`，无桩、无别名）与**真身 klinecharts 10.0.3 UMD** 直接对接，在 headless chromium（本地端口）上跑 T3/T4/T8bis 与边界的**真实数值**判据。

- L1（真渲染几何/事件）：本仪器 —— `getVisibleRange()`、`getBarSpace()`、`get|setOffsetRightDistance()`、`scrollToTimestamp/scrollToDataIndex`、事件订阅全部为**真身**。
- L2（DOM/React 角标）：沿用 `multiPeriodSyncBadge.test.tsx`（jsdom）。

## 2. 层覆盖计划

| 场景 | 覆盖任务项 | 手段 |
|---|---|---|
| S1 G1（1m↔1m 20 轮）+ 禁抑制反向 | B1 | 真身事件 + 逐轮视窗对比 |
| PROBE（无组：偏移归零 / 同构实例 / `scrollToTimestamp` 落点） | B1 根因 | 真身对照 |
| S2 跨周期（1m↔5m/1m↔15m/1d↔1w） | B2 | 校准间距 + 跨度/右端/可见根数 |
| S3 T4 `scrollAllToLatest` | B3 | 真身右端对齐 |
| S4 T8bis（1m↔1h 退化 + 缩小 + 反向推导值） | B4 | 真身降级数值 + 快照 |
| S5 边界（NaN/静态密度/不泄漏） | B5 | 真身上限/越界静默/纯函数 |
| S6 卫星↔卫星（15m→1h/base） | B6② | 真身同锚点合成 |

## 3. 夹具与判定口径

- 数据：确定性合成序列（`endTs = T0`）；跨周期 **base 间距 = satBucket / D**（D 取实现侧静态密度表：4.7/12.2/4.67/37.8），同 design 夹具口径 —— 使两侧日历跨度可比。
- `pane` 尺寸固定 520×240（⇒ `capacity = floor(520/2)=260`）。
- 判定：跨度差/右端差 ≤ 1 根高周期 bar；卫星可见 bar ≥ 2；`echoEvents == 0`、`suppressed > 0`。
- 反向：①禁抑制 ⇒ `echoEvents>0`；②照用推导 barSpace ⇒ 必红（真渲染下**未复现**，见执行报告 B4）。

## 4. Mock/桩策略

**不使用桩**。唯一间接依赖：本地静态服务器（`python3 -m http.server`，127.0.0.1 临时端口），仅用于加载 `klinecharts.min.js` + 打包后的 `chartSyncGroup.mjs` + `index.html`；全程 0 外网（`networkNonLocal=[]`）。

## 5. 边界与异常

- 真身右缘报 `to == length`（越界）⇒ 仪器读数对索引做钳位。
- `satBS ≫ pane` 的 NaN：真渲染**不可达**（引擎夹 `barSpace ≤ width/2`）⇒ 记录为「桩面行为」，改判「不崩」。

## 6. 覆盖目标

T3（G1 无漂移 + 反向）、T4、T8bis（含缩小恢复 + 反向）、边界（NaN/静态回退/不泄漏）、卫星↔卫星。**未覆盖**：T4-2 真追加（引擎无 `updateData`）、产品 React 角标（jsdom 承担）。

## 7. 产物

- `tester/evidence/273_p3c_acceptance/real_render_harness.html`（页面 + 场景）、`real_render_driver.mjs`（playwright 驱动）、`p3c_harness.json`、`p3c_harness.png`、`harness_stdout.txt`。
- 运行：`python3 -m http.server <tmpPort> --directory <dir>` → `cd web && node <driver.mjs>`（需 `P3C_PORT`）。
