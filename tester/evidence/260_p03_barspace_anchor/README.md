# 260_p03_barspace_anchor — evidence index（P0.3 只读探针）

真实 klinecharts **10.0.3**（UMD，sha256 `c985a3b4a784ed526a1ab67d6021e385e532c80ae524a33c5a548abc38ab3818`）+ Playwright Chromium **1.62.1**，真实渲染；数据为**真实后端只读** `GET 127.0.0.1:8081/api/kline?code=518880&period=P&limit=1000`（临时端口只读代理，观测 **0 个非 GET 请求**）。
仓库 `e2a04ee`；隔离 worktree `/tmp/mp_p03`（任务结束已删除）。**未改源码、未 git add/commit/stash、未重启线上 PID 3112540。**

| 文件 | 作用 |
|---|---|
| `mp03.html` | 双实例（base / satellite）探针页 |
| `mp03.js` | 测量内核 + 密度锚定 IIFE（索引→时间戳、密度倍率、同步一轮、扫描、limit 夹紧/隔离/稳定性/卫星上限） |
| `mp03_run.mjs` | 主驱动（7 组合 × barSpace{1,2,5,8,20,50} × {名义/密度/镜像/取整}，输出 `p03_result.json` + 截图） |
| `mp03_density.mjs` | 密度锚定驱动（K8/K16 中位倍率、±25% 扫描、卫星上限扫描）→ `p03_density_result.json` |
| `mp03_zoom.mjs` | 放宽 limit 后的缩放/滚动重对齐稳定性 + 有数据下的 limit 隔离 → `p03_zoom_result.json` |
| `p03_result.json` | 主矩阵原始数值（含全部扫描轨迹、console、`meta.nonGetRequests=0`） |
| `p03_density_result.json` | 密度/扫描原始数值（每个组合逐 barSpace 的 satBS、误差、可见 bar） |
| `p03_zoom_result.json` | 缩放/滚动重对齐 6 步原始数值 |
| `shot_1d_1w_bs8.png` · `shot_density_1d_1w_bs8.png` · `shot_1d_1w_sat_minimized_bs8.png` | 主目标组合（1d/1w）真渲染截图（baseBS=8；含卫星 K 线 pane `minimize` 形态） |
| `shot_1m_5m_bs8.png` · `shot_1m_15m_bs8.png` · `shot_1m_1h_bs8.png` · `shot_1h_1w_bs8.png` · `shot_1m_1d_bs8.png` · `shot_1m_1w_bs8.png` | 各组合真渲染截图 |
| `shot_scan_*.png` · `shot_ceiling_last.png` · `shot_zoom_stability.png` · `shot_last_state.png` | 扫描/上限/稳定性截图 |

> 截图均为 Playwright **页面截图**（按 ADR-022 §2.4 第 2 条，禁用 `getConvertPictureUrl`）。

报告：
- 设计：`tester/design/260_p03_barspace_anchor_design.md`
- 执行：`tester/test/260_p03_barspace_anchor_execution.md`
