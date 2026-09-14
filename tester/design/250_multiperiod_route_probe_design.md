# 250 — 多周期指标框架架构分叉取证 P7a–P7e · 测试设计报告

- **本报告位置**：`tester/design/250_multiperiod_route_probe_design.md`
- **类型**：Design report（本调查**新设计并编写**的探针浏览器用例；非既有用例执行）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e2a04ee`
- **性质**：**只读**。未改仓库源码；未 git add/commit/stash；未向线上发任何请求（本探头全部 `file://` + 合成数据，0 个网络请求）；未重启 PID 3112540。
- **证据目录**：`tester/evidence/250_multiperiod_route_probe/`
- **执行报告**：`tester/test/250_multiperiod_route_probe_execution.md`

## 1. 目标

为「通用框架、支持将来任何指标」的架构分叉取硬证据：
- **P7a** 路线②前提：单个 klinecharts 实例能否**不显示 K 线**只保留指标 pane（含残留空隙）。
- **P7b** 路线②第二关键：跨实例时间轴同步的公开 API 能力 + 两实例实测（同周期 / 跨周期 / 1m vs 1w）。
- **P7c** 路线②收益：N=2~4 实例的成本；内置指标与自研模板是否「零改动白送」。
- **P7d** 路线②契约：分隔线、pane 高度记忆、交互/参数在 N 实例下的对应做法。
- **P7e**（有余力）路线①重实现代价粗估。

## 2. 测试策略

| 层 | 手段 |
|----|------|
| 渲染/引擎层 | **真实 klinecharts 10.0.3 浏览器实测**（Playwright Chromium，`file://` + UMD bundle）。不用 jsdom：pane 折叠、DOM rect、像素必须真渲染才可信。 |
| 源码佐证 | 只读 `web/node_modules/klinecharts/dist/index.esm.js` / `index.d.ts`（布局、`setPaneOptions`、事件派发、barSpaceLimit）。 |
| 成本 | 4 实例 × (MA/MACD/KDJ/BOLL + 自研模板) 的创建/reset 墙钟时间。 |

### 2.1 探针清单

| ID | 用例名（should-when） | 断言要点 |
|----|----------------------|----------|
| P7a-T1 | `setPaneOptions_height0_should_be_ignored` | `height:0` 后 DOM rect / `getSize` 是否变化；对照源码 `options.height > 0` 守卫 |
| P7a-T2 | `pane_state_minimize_should_collapse_candle_pane` | `state:'minimize',minHeight:0` 后 candle pane rect 高度 == 0；指标 pane 变 flexible 填满 |
| P7a-T3 | `separator_size0_should_remove_residual_gap` | `styles.separator.size=0` 后相邻 pane 的 DOM rect 间隙 == 0 |
| P7a-T4 | `collapsed_candle_should_survive_zoom_scroll` | zoom+scroll 后 candle 仍 0 高、无残留间隙、布局稳定 |
| P7a-T5 | `x_axis_should_be_shared_across_panes` | 同一 ts 在两 pane `convertToPixel().x` 相等 |
| P7a-T6 | `indicator_pane_should_self_scale_y` | 指标 pane `getYAxes().getRange()` 依数据自标度；同 value 在两 pane 像素不同 |
| P7a-T7 | `restore_state_normal_should_unhide_candle` | `state:'normal'` 可还原 candle 高度 |
| P7b-T1 | `public_api_capability_snapshot` | `getVisibleRange`/`scrollToTimestamp`/`scrollToDataIndex`/`zoomAt*`/`setBarSpace`/`subscribeAction` 是否存在；**`setVisibleRange` 不存在** |
| P7b-T2 | `onZoom_onScroll_onVisibleRangeChange_should_fire` | 缩放/滚动回调是否派发及其 payload |
| P7b-T3 | `same_period_index_align_should_be_exact` | 两 1m 实例 `scrollToDataIndex(300)` 后 `getVisibleRange` 完全相同 |
| P7b-T4 | `cross_period_ts_only_should_not_align_spans` | 仅 `scrollToTimestamp` 对齐时两实例可见跨度差多少 |
| P7b-T5 | `cross_period_scaled_barSpace_should_align_time_per_pixel` | `barSpace_B = barSpace_A × (P_B/P_A)` + ts 对齐后的跨度/像素差 |
| P7b-T6 | `barSpaceLimit_should_cap_large_ratios` | 默认 `barSpaceLimit.max=50` 会静默吞掉大倍率；`init({layout:{barSpaceLimit}})` 可放开 |
| P7b-T7 | `1m_vs_1w_should_be_degenerate` | 1w 与 1m 同跨度对齐后退化为「不到一根 bar」 |
| P7b-T8 | `repeated_mirror_should_not_drift` | 20 次 ts-only 镜像后跨度是否漂移 |
| P7b-T9 | `bidirectional_mirror_should_have_feedback_edge` | 双向镜像存在回边（reentrant），需抑制标志 |
| P7c-T1 | `builtin_indicators_should_be_free` | `getSupportedIndicators()` 名单；4 实例各自 `createIndicator(MA/MACD/KDJ/BOLL)` 零注册即可显示 |
| P7c-T2 | `own_template_should_be_reused_per_instance` | 同一模板在 4 实例各 `createIndicator` 带各自 `extendData`，`calc` 各自命中 |
| P7c-T3 | `cost_should_be_measurable` | 4 实例创建 / reset 墙钟；堆内存（若可用） |
| P7d-T1 | `route1_separators_and_pane_height_memory` | 单实例多 pane 的分隔条像素；`setPaneOptions` 高度 + `resize` 后保持 |
| P7d-T2 | `route2_hidden_pane_residual_strip` | 路线②隐藏 candle 后每实例残留条 |
| P7e | 源码清点 | 宿主 Rust `backtest::Indicators` 覆盖的指标与前端 DCAP 端口 |

**Mock/Stub 策略**：全部用**合成 OHLCV**（1m×400/600、15m×40、1w×10，UTC，与后端 ts=桶开始口径无关，仅做引擎行为）；**不打桩 klinecharts**。外部序列按 `bucketMs` 生成注入自研模板（复现 `extendData` 路径）。
**边界用例**：`height:0`、`state:'minimize'`、`barSpace` 超限、1w 大倍率、零高 pane 的 `getConvertPictureUrl`。
**Coverage targets**：P7a/P7b 每条结论至少一条真渲染或真布局读数（DOM rect / `getVisibleRange` / `getSize`）；P7c 需内置与自研两条路径都实测；路线对照表逐格有证据或标注未证实。

## 3. 探针实现（新增测试代码，均在 tester/evidence/ 下）

| 文件 | 作用 |
|------|------|
| `p7.html` / `p7.js` | P7a + P7b(初版) + P7c + P7d 顺序探针 |
| `p7b2.html` / `p7b2.js` | P7b 聚焦重做（可配置 barSpaceLimit、同周期/跨周期/1w/反馈/漂移） |
| `p7view.html` | 可视产出：隐藏 candle 的三指标 pane 图 + 路线② 1m/15m 并排 |
| `run.mjs` / `runb2.mjs` / `runview.mjs` | Playwright 驱动 |

## 4. 本报告位置
`tester/design/250_multiperiod_route_probe_design.md`
