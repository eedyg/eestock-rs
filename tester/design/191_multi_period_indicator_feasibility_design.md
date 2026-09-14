# 191 — 多周期 DCAP 同屏（多 pane）只读可行性调查 · 测试设计报告

- **本报告位置**：`tester/design/191_multi_period_indicator_feasibility_design.md`
- **类型**：Design report（本调查**新设计并编写**的探针测试；非既有用例执行）
- **仓库**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e2a04ee8cfc18904c93560fc77c10cd83f493ada`
- **时间（UTC）**：2026-09-14 08:52 → 09:20
- **性质**：**只读**。未改任何仓库源码；未 git add/commit/stash；未向线上发任何写请求（仅 `GET /api/kline`、`GET /api/symbols`）；未重启 PID 3112540。
- **证据目录**：`tester/evidence/200_multiperiod_feasibility/`
- **执行报告**：`tester/test/191_multi_period_indicator_feasibility_execution.md`

## 1. 目标与待验证命题

用户裁决的形态：同一页面同时显示多个 period 的 dcap 指标 = **多副图 pane**（每周期一个 DCAP pane，各自独立 Y 轴），
**时间范围/平移/缩放同步**；K 线只显示所选周期中最小的那个；参数共享同一套 8 参数；最多 4 周期（含 K 线）；
仅单图模式；与现单周期视图并存（开关）。对齐口径 = **C**（桶结束 ≤ t，严禁未来函数）。

需要实验回答的四个技术未知：
- **P1** 一个 klinecharts 实例内多 indicator pane：x 轴是否强制共用、Y 轴是否各 pane 独立、pane 高度是否可保存/回放。
- **P2** 指标能否吃「外部序列」（高周期序列注入到 1m 图的 pane）。
- **P3** 时间对齐：step-hold 公式、后端 ts 约定、进行中桶、分段虚线。
- **P4** 本地聚合 vs 直接取高周期 bar。

## 2. 测试策略

| 层 | 手段 | 说明 |
|----|------|------|
| 渲染/引擎层（P1/P2/P3d） | **真实 klinecharts 10.0.3 浏览器实测**（Playwright Chromium，`file://` 静默页 + UMD bundle） | 不用 jsdom/打桩：pane/Y 轴/pixel 必须真渲染才可信 |
| API 层（P3b/P3c/P4） | 对**线上实例只读** `GET /api/kline`（PID 3112540 :8081） | 不 PUT 任何 `/api/config/*` |
| 源码判读（P3c/P3d/P5） | `grep`/`read` klinecharts `dist/index.d.ts`+`index.esm.js`、`web/src/features/dashboard/realtimePoll.ts`、`crates/providers/src/exchange.rs` | 只读，佐证实测 |

### 2.1 探针清单（Test case list）

| ID | 用例名（should-when） | 断言要点 |
|----|----------------------|----------|
| P1-T1 | `multi_pane_one_chart_should_share_time_axis` | 5 个副图 pane 对**同一 ts** `convertToPixel().x` 完全相等；`getVisibleRange()` 为 chart 级单值 |
| P1-T2 | `each_indicator_pane_should_have_independent_y_axis` | `getIndicators()` 的 `paneId/yAxisId` 互异；`getYAxes().getRange().realRange` 各 pane 独立；同一 value 在各 pane → 不同 y 像素 |
| P1-T3 | `pane_height_should_be_settable_and_persist_across_zoom_scroll` | `setPaneOptions({id,height})` → `getPaneOptions(id).height` 与 `getSize(id).height` 一致；zoom/scroll 后不变；其他 pane 不受影响 |
| P1-T4 | `createIndicator_should_return_indicator_id_not_pane_id` | 返回值 ≠ paneId（`getDom(返回值)` → null）；paneId 须从 `getIndicators()` 取 |
| P2-T1 | `calc_should_receive_external_series_via_extendData` | `calc(dataList, indicator)` 读到 `indicator.extendData`；`result.length == dataList.length`；格点外为 null；Y 轴按外部序列自标度 |
| P2-T2 | `overrideIndicator_extendData_should_trigger_recalc` | 用新 `extendData` 调 `overrideIndicator` → `calc` 被再次调用且 `result` 更新（返回值 `false` 但生效） |
| P2-T3 | `module_registry_path_should_recalc_only_when_poked` | 改模块级注册表后必须显式 poke（`overrideIndicator`/`resetData`）才重算；无自动失效 |
| P2-T4 | `indicator_draw_callback_should_get_chart_and_axes` | 模板 `draw(params)` 被调用且 `params.xAxis/yAxis/bounding/chart` 可用（可自绘外部序列） |
| P2-T5 | `overlay_path_supported_names_and_dashed_style` | `getSupportedOverlays()` 名单；`brush`/`segment` 可创建且接受 dashed 样式 |
| P3-T1 | `bucket_end_step_hold_should_map_to_first_closed_1m_bar` | 外部序列按桶映射到 1m 网格：`extLen = round(600/P)`；价值锚定唯一 ts，其余 null |
| P3-T2 | `kline_ts_should_be_bucket_start_in_utc` | 用 shift ∈ {0, ±1min} 的本地聚合去匹配后端 5m：仅 shift=0 命中 |
| P3-T3 | `in_progress_bucket_presence_per_period` | 各周期是否有「进行中/占位」bar 及其 OHLC 特征 |
| P4-T1 | `local_agg_vs_backend_high_period_should_be_compared` | 1m→5m/15m 本地聚合 vs 后端同桶逐值比对 |

**Mock/Stub 策略**：P1/P2 用**合成 600 根 1m bar**（随机游走，ts 步长 60s，UTC），高周期序列按 `bucketMs` 对齐生成；
**不打桩 klinecharts**（本调查正是要测真实引擎行为）。P3/P4 用线上只读取数（无 mock）。
**边界用例**：桶边界（整点/整 5m/整 15m）、视口外 ts（`convertToPixel` 返回负/超界像素）、
「进行中桶」= 末根 volume 0 平 bar、空 extendData、多 pane 同名指标。

**Coverage targets**：P1/P2 每条路径 ≥1 真渲染断言（Y 轴量程 / 像素 / result 值三选一以上）；
P3b/P4 用真实后市数据做逐值比对（非抽样目测）。

## 3. 探针实现（新增测试代码）

| 文件 | 作用 |
|------|------|
| `tester/evidence/200_multiperiod_feasibility/harness.html` / `harness.js` | 主探针：单实例 5 个 indicator pane（extendData 路径 ×2、模块注册表 ×1、indicator-draw ×1、VOL ×1）+ P1 全量快照 |
| `tester/evidence/200_multiperiod_feasibility/probe2.html` / `probe2.js` | 补充探针：pane 高度干净对照 + canvas 像素采样 + x-sync 逐点断言 |
| `tester/evidence/200_multiperiod_feasibility/run.mjs` / `run2.mjs` | Playwright 运行器（Chromium headless，产出 JSON + PNG 截图） |
| `../harness_result.json` / `probe2_result.json` | 原始输出（机器可复算） |
| `../harness_render.png` / `probe2_render.png` / `chart_only.png` | 真渲染截图 |

复跑命令（只读，临时进程，无端口占用）：
```bash
cd /home/eestock/workspace/git/eestock/eestock-rs
node tester/evidence/200_multiperiod_feasibility/run.mjs
node tester/evidence/200_multiperiod_feasibility/run2.mjs
```

## 4. 已知设计缺口（诚实标注）

1. `probe2.js` 的 canvas 像素采样**未能给出结论**（`getIndicators()` 在该探针里字段全 undefined，DOM canvas 取证落到错误 pane）——
   像素级「红线确实画出来」未证实；P2 的「外部序列进入指标并驱动 Y 轴标度」已由 `harness_result.json` 的
   `resultLen=600` + `firstNonNull` + `getYAxes().realRange` 佐证（见执行报告）。
2. 指标重算性能（<16ms）**未测**。
3. 「进行中桶 OHLC 是否随分钟更新」**未测**（实测时 A 股已收盘；需下一交易时段重测）。
4. 布局契约 ①②③④（保存配置/切周期/切模式时 pane 生命周期）**未测**（时间盒外）。

## 5. 结论去向

逐条结论、原始证据、代价与推荐实现路线见执行报告
`tester/test/191_multi_period_indicator_feasibility_execution.md`。
