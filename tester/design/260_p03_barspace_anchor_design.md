# 260 — P0.3 只读探针设计：1d/1w 跨图同步的 barSpace 与 barSpaceLimit 锚定

- **本报告位置**：`tester/design/260_p03_barspace_anchor_design.md`
- **类型**：Design report（本探针为**新设计并新编写**的浏览器用例；非既有用例执行）
- **对应派单**：`design/15-multi-period/04-implementation-plan.md` P0.3；口径依据 `01-adr.md` 口径 8/9/10、`02-spec.md` §3.2/§3.3/§4.3
- **仓库/提交**：`/home/eestock/workspace/git/eestock/eestock-rs` @ `e2a04ee`（隔离 worktree：`/tmp/mp_p03`，`git worktree add --detach`，已回收）
- **性质**：**只读**。未改仓库源码、未 `git add/commit/stash`、未重启线上（PID 3112540 未动）、未向线上发任何写请求（**观测到 0 个非 GET 请求**）；临时实例使用临时端口并已全部关闭。
- **证据目录**：`tester/evidence/260_p03_barspace_anchor/`
- **执行报告**：`tester/test/260_p03_barspace_anchor_execution.md`

## 1. 目标（仅被指派范围）

1. 基准 `1d` ↔ 卫星 `1w`：给出使两侧**时间跨度差 ≤1 根高周期 bar** 所需的 barSpace，以及卫星 `barSpaceLimit` 上限建议值。
2. `1m` ↔ `1w` 退化量化：所需 barSpace 量级与可行性 ⇒ 给口径 10 的「1w 仅基准 ≥1d」护栏提供实测依据。
3. 其它相邻组合（1m↔5m、1m↔15m、1m↔1h、1m↔1d、1h↔1w）的 barSpace 与误差（分钟）汇总表。
4. 顺带确认：卫星放宽 `barSpaceLimit` 不影响基准实例；放宽后 `setBarSpace` 在缩放/滚动后仍稳定。

**明确不做**：不改实现、不调参、不做跨周期值叠加、不引入任何新功能；只测量与取证。

## 2. 测试策略

| 层 | 手段 |
|----|------|
| 渲染/引擎层 | **真实 klinecharts 10.0.3**（官方 UMD `web/node_modules/klinecharts/dist/umd/klinecharts.min.js`，sha256 `c985a3b4…3818`，`getSupportedIndicators().length = 27`）+ Playwright Chromium 1.62.1 真渲染；两个真实实例（base/satellite）并排，各 520×420 px。 |
| 数据层 | **真实后端只读取数**：临时端口静态服务器仅转发 `GET /api/kline?code=518880&period=P&limit=1000` 到线上 `127.0.0.1:8081`（非 GET 一律 405；实测 0 次非 GET）。不用合成数据。 |
| 断言口径 | 两侧**日历时间跨度**差（分钟）与折算成「高周期 bar」的倍数；卫星可见 bar 数；卫星 barSpace 实际生效值（是否被 limit 静默吞掉）。 |
| 关键测量学（本探针新发现，必须写进测量设计） | `getVisibleRange()` 返回 **数据索引空间**（`index.esm.js:13556-13567`），不是时间戳 ⇒ 时间跨度需按「索引→时间戳」插值（含缺口）；barSpace 允许小数，越界被**静默忽略**（`index.esm.js:13667`）。 |

### 2.1 探针清单（should-when 命名）

| ID | 用例名 | 断言要点 |
|----|--------|----------|
| P0.3-A1 | `pane_geometry_and_data_availability_should_be_recorded` | 每周期真实 bar 数/覆盖区间/中位 bucket；pane 宽 520 px；每实例独立 DataLoader |
| P0.3-B1 | `nominal_period_ratio_barSpace_should_be_measured` | 按 `02-spec §3.2` 口径 `satBS = baseBS × (T_sat/T_base)` 后两侧跨度差（分钟 / 高周期 bar） |
| P0.3-B2 | `density_multiplier_should_be_measured` | 运行时可算的「密度倍率」D（同窗口内 base bar 数 / sat bar 数）在 K=8/K=16 窗口上的中位数；以及可见窗口局部 D |
| P0.3-B3 | `density_scaled_barSpace_should_minimise_span_error` | `satBS = baseBS × D` 的误差；±25% 扫描求最小误差点（⇒ 「所需 barSpace」实测值） |
| P0.3-B4 | `integer_rounding_and_offset_mirroring_should_be_compared` | 小数 vs 整数 barSpace；中心对齐 vs 同步右侧偏移的误差对比 |
| P0.3-C1 | `satellite_should_pin_at_one_bar_above_ceiling` | 卫星 barSpace 递增时的可见 bar 数（≥1/≥2 bar 的上限）— 退化判据 |
| P0.3-C2 | `1m_vs_1w_should_be_infeasible_at_every_base_zoom` | 基准 barSpace∈[1,50] 全区间所需的卫星 barSpace 与可见 bar 数 |
| P0.3-D1 | `default_barSpaceLimit_should_silently_swallow_large_ratios` | 默认 max=50 下 `setBarSpace(350)` 的静默吞掉；放宽到 400 后生效 |
| P0.3-D2 | `satellite_widening_should_not_leak_into_base` | 基准实例在卫星放宽后仍被 50 夹紧（req 51/350/5000 全部落回 50） |
| P0.3-D3 | `setBarSpace_should_be_stable_after_widening` | 20 轮「基准滚动 + 重对齐」后卫星 barSpace 不变；卫星被外部 set 到 350 后重对齐可复原 |
| P0.3-D4 | `hidden_candle_satellite_should_not_move_the_anchor` | 卫星 `state:'minimize'`（路线②形状）与普通卫星的基准跨度/误差一致 |

**Mock/Stub 策略**：**不打桩 klinecharts、不合成 K 线**；唯一替身是「临时端口只读代理」。
**边界用例**：`barSpace ∈ {1,2,5,8,20,50}`、卫星 barSpace 跨 2×pane 宽、默认/放宽 limit、整数/小数 barSpace、零覆盖重叠（1m↔1w 在 1000 根窗口内无交集）。
**Coverage targets**：每个被指派的组合至少一条真渲染读数；口径 9/10 的每个结论必须有原始数值 + 截图。

## 3. 实现（新增测试代码，均在 `tester/evidence/260_p03_barspace_anchor/`）

| 文件 | 作用 |
|------|------|
| `mp03.html` | 双实例（base / satellite）探针页；内置 CSS 供截图 |
| `mp03.js` | 测量内核（真实 DataLoader 取数、索引→时间戳、密度倍率、同步一轮、扫描、limit 夹紧、隔离、稳定性、卫星上限扫描）+ 追加的密度锚定 IIFE |
| `mp03_run.mjs` | 驱动：临时端口静态服务器 + 只读代理 + 7 组合 × 6 基准 barSpace × {名义/密度/镜像/取整} 全矩阵 + 截图 |
| `mp03_density.mjs` | 驱动：密度锚定（K=8/K=16 中位倍率、±25% 扫描、卫星上限扫描） |
| `mp03_zoom.mjs` | 驱动：放宽 limit 后的缩放/滚动重对齐稳定性 + 有数据下的 limit 隔离 |

## 4. 本报告位置
`tester/design/260_p03_barspace_anchor_design.md`
