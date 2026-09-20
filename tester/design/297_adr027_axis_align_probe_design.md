# 测试设计 297 — ADR-027 缺陷取证：曲线（聚合总分/各策略评分）与 K 线时间轴对齐的真实渲染测量

- **本文件位置**：`tester/design/297_adr027_axis_align_probe_design.md`
- **被测对象**：工作台结果页（`/backtest-workbench` → 选中 run → 结果视图）
  - K 线：`web/src/features/workbench/KlineResultChart.tsx`（klinecharts `ChartImp`，canvas）
  - 曲线：`AggregateScoreChart.tsx`（`wb-aggregate-chart`）、`SlotScoresChart.tsx`（`wb-slot-chart`）
    —— 二者 x 轴均由 `chartUtils.mapLineByTs`（**ts 线性**）映射，定义域来自共享窗口
    （`data-x-domain` 属性 = `useResultWindow().domain`）
- **被取证缺陷**：聚合总分 / 各策略评分 曲线的 x 轴与 K 线蜡烛的 x 轴「对不上」
- **本波角色**：tester，**只测量与取证**（不改生产代码、不修复、不分析失败原因）
- **运行方式**：对**已在跑的线上新版本**（`http://localhost:8081`，静态 = `web/dist` bundle
  `assets/index-D8WPpeNL.js`）跑单个新规格，**不起 vite preview**（资源纪律：单车道）

---

## 1. 测试策略

| 层 | 手段 | 说明 |
|----|------|------|
| 真渲染（primary） | Playwright chromium 打真实 App 容器 + 真实 DB | canvas K 线的像素 x 只能从真身读：`chart.convertToPixel({timestamp},{paneId:'candle_pane'})` |
| 真渲染（primary） | 曲线 SVG 的**已渲染几何** | 读 `<polyline points>`（user units）+ `svg.getScreenCTM()` → 真实屏幕像素 x；不重算公式 |
| 数据对齐 | 同一 ts 的 ts 列表 | `/curve?kind=per_bar&k=2000&from_ts&to_ts` 的 `points[].ts` 与 polyline 顶点**一一对应** |
| 数值推导（secondary，交叉验证） | ts 线性 vs 索引线性模型 | 用真实 bar ts 计算「缺口折叠」模型的预测偏差，与实测偏差量级/符号比对 |
| 反证（mutual） | 缺口普查 | 窗口内相邻 ts 间隔的直方图（300s / 5400s / 66600s / 239400s）→ 定位偏差最大的 ts 是否紧跟大缺口 |

**关键设计决策**：两个图表宽度/左边距不同（K 线容器无 padding；聚合图 `p-1` + SVG 内 `PAD=8`），
所以绝对屏幕像素差包含「容器内缩」假信号。故主判据用**窗口内归一化偏差**：

```
pK(t) = (xK(t) − xK(t0)) / (xK(t1) − xK(t0))        # K 线真实渲染像素，t0/t1 = 锚点 ts
pC(t) = (xC(t) − xC(t0)) / (xC(t1) − xC(t0))        # 曲线真实渲染像素（SVG polyline + CTM）
Δ984(t) = (pK(t) − pC(t)) × 984  [px]               # 984 = 曲线 plot 宽度 user units（W=1000, PAD=8）
```

`984` 是曲线自身 plot 宽度，故 `Δ984` ≈ 用户眼中「同一时刻两条竖线错开多少像素」。
判据：**max|Δ984| > 2px ⇒ 判不对齐**。同时给出 `Δraw = xK − xC`（原始屏幕像素，含内缩，标注为次要口径）。

锚点两套（两套都算，避免单一锚定掩盖窗口级错位）：

- **A（窗内）**：`[t0,t1] = K 线可见 bar 区间的首末 ts` → 量化**窗内时间轴扭曲**（缺口折叠的直接体现）；
- **B（窗口级）**：额外报告 `窗口级偏差`：`((xK(domain_from) − xK(t0)) / (xK(t1) − xK(t0))) × 984`
  与末端的对称量 → 量化**「共享窗口」与「K 线可见 bar 区间」本身是否一致**（全览态必查）。

## 2. 层覆盖计划

| 视图 | 状态 | 驱动方式（真实用户路径） | 预期可见根数 |
|------|------|--------------------------|--------------|
| `wb-aggregate-chart` | ① 全览 | `wb-window-reset` 点击 | run 全量（1949 根 M5）→ K 线物理上限 ~1200 |
| `wb-aggregate-chart` | ② 窄窗口 | L2 逐笔 `[跳转]`（`wb-l2-jump-<rt>-<row>`，span=120） | 120 |
| `wb-aggregate-chart` | ③ 中窗口 | ② 之后在 K 线 canvas 上**滚轮缩小**（真手势，onZoom → 窗口跟随 kline） | ~300 |
| `wb-slot-chart` | 同上 3 态 | 同上（同一窗口事实源） | 同上（附测：第一槽 polyline） |

## 3. 用例清单（should-when）

| # | 名称 | Given / When / Then |
|---|------|---------------------|
| P1 | `probe_three_viewports` | Given 线上 8081 + run `sr_1789832517800_000006`（518880/M5/1949 根，含周末/隔夜/午休缺口）<br>When 依次进入 ①全览 ②L2-120 根 ③滚轮 ~300 根<br>Then 每态产出：窗口态属性、K 线真身读回（from/to/barSpace）、**首/中/末 3 组同 ts 的 xK 与 xC**、Δ984、Δraw、锚点 A/B、缺口普查、模型预测、截图 |

单用例（3 态串行，同一 browser context），避免多用例并发争用 8081 与 Playwright 单车道约束。

## 4. Mock / Stub 策略

**零 mock**（真渲染取证要求）。仅两处**只读**页面侧探针：

1. `addInitScript` 包 `Map.prototype.set` 捕获 klinecharts `ChartImp` 实例（与既有
   `adr028-window-sync.e2e.ts` M2 用例同款、已验证可行）→ 只**读** `getDataList/getVisibleRange/
   getBarSpace/getSize/convertToPixel`，**不写**任何图表状态；
2. 曲线侧只读 DOM（`data-x-domain`、`<polyline points>`、`getScreenCTM()`）。

## 5. 边界与异常用例（防御性，非本次判据）

- K 线容器未布局（width ≤ 0）/ dataList 空 / `convertToPixel` 抛错 → 记为 `ok:false` 并落盘，不猜值；
- 曲线 `<polyline>` 顶点数 ≠ API `points.length`（服务端抽样）→ 记 `vertexMismatch`，改用**按顶点索引**口径并显式标注；
- 滚轮缩放未生效（visible 不变）→ 记 `zoomEffective:false`，③ 态退化为「最接近的目标窗」并显式标注；
- 页面加载失败 → 退化为「接口数据 + 页面暴露窗口态」的**数值测量**，报告内显式标注哪部分是真实渲染。

## 6. 覆盖目标

- 3 个视口状态 × 2 个曲线视图（总分 / 各策略评分）× {xK, xC, Δ984, Δraw} 全落盘 JSON；
- 每态 3 张截图（整页 + K 线区 + 聚合图区）落 `tester/evidence/20260920_adr027_axis_align/raw/`；
- 复现命令一条（见报告「复现步骤」）。

## 7. 产出物

- 规格：`web/e2e/adr028-axis-align-probe.e2e.ts`（新建；只测本测量）
- 原始证据：`tester/evidence/20260920_adr027_axis_align/raw/*.json` + `*.png`
- 判词报告：`tester/evidence/20260920_adr027_axis_align/report.md`
- 执行报告：`tester/test/301_adr027_axis_align_probe_execution.md`
