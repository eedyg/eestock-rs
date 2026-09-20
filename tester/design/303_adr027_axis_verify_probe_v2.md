# 时间轴对齐探针 **v2（口径修正版）** 设计说明 + 降级注入用例

- **本文件位置**：`tester/design/303_adr027_axis_verify_probe_v2.md`
- **被测规格（本波修改，tester 自有）**：`web/e2e/adr028-axis-align-probe.e2e.ts`（v1 → v2，主口径修正）
- **主报告（判词与证据）**：`tester/evidence/20260920_adr027_axis_verify/report.md`
- **执行报告**：`tester/test/303_adr027_axis_verify_execution.md`
- **架构依据**：ADR-028 §4.1（同一 ts / 同一 bar 在 K 线与各曲线视图上的 x 偏差 ≤ 2px）+ 架构师本波裁决（Δ984 仅当曲线按 ts 线性绘制时有效 ⇒ v1 主口径失效）

## 1. 为什么改（口径修正的动机）

| 项 | v1 主口径 | v2 主口径 |
|---|---|---|
| 曲线侧输入 | 渲染 user-unit x **按 ts 线性反解**成 ts（`ts = D0 + ((x−8)/984)·(D1−D0)`） | 渲染顶点 ↔ **数据点 ts（/curve 一对一带出）** ↔ **K 线真身可见 bar**（`convertToPixel` 实测像素）**配对** |
| 成立前提 | 曲线必须按 **ts 线性** 绘制 | 无（配对只依赖 ts 最近邻 + 容差） |
| 修复后是否有效 | **失效**（曲线改为 bar 索引空间后反解与渲染不同源） | 有效 |
| 判据 | ≤2px | 不变：≤2px（`max|Δ984|` 且 `max|Δraw|`） |

v1 主口径**降级为诊断字段** `legacy.tsLinearInverseSolve984`，字段内显式标注
`applicableTo: '仅适用于修复前口径（曲线按 ts 线性绘制）'`；其代码路径逐行保留（可对修复前产物复现历史值）。

## 2. 主口径定义（v2）

1. **配对**：`pairByNearestBar(K线可见 bar ts, 可见范围内曲线数据点 ts, tol = max(60, barSeconds/2) = 150s)`
   —— 单调游标 + 最近邻；超出容差的点计入 `outOfTolerance`，同 bar 多点计入 `duplicateBars`（**不静默跳过**）。
2. **偏差**：
   - `Δraw(bar) = xK(真身屏幕 px) − xC(渲染顶点屏幕 px)`（未归一化，含容器内缩常量）；
   - `Δ984(bar) = ((xK−xK₀)/spanK − (xC−xC₀)/spanC) × 984`（锚点 = **配对首/末**，与 ADR 的 984px 参考宽度对齐）。
3. **判据**：逐态 `max|Δ984| ≤ 2px` **且** `max|Δraw| ≤ 2px`。
4. **自校验 & 可判别性（反假绿）**：
   - `indexResidualMaxUser` = max‖渲染 userX − (8 + j/(N−1)·984)‖ ⇒ 必须 ≈ 0（配对若错，残差爆炸 ⇒ 配对自证）；
   - `tsLinearResidualMaxPx984` = max‖渲染 userX − ts 线性预测‖ ⇒ 大缺口态下应很大（证明本探针**能区分**两种映射）。
5. **跟随性**：`vertices == 可见 bar 数`、配对覆盖全部 bar（`barsCovered == visibleBars`）、
   首/末顶点与首/末可见 bar 的配对偏差、跨度差、曲线 plot 覆盖率（契约 = 1.000）。
6. **原子性**：
   - 静止态不变量：`数据 ts 区间 ⊂ 声明定义域(±容差)` ∧ `⊂ K 线可见区间(±容差)` ∧ 覆盖率 1.000 ∧ 全部 bar 被覆盖；
   - 切换期（页面侧 50ms 采样的渲染签名 `mode|顶点数|首末 userX|Σ userX|viewBox`）：加载态样本的签名必须**恰等于**「切换前」或「切换后」整组快照之一（混合物 ⇒ 红）；非加载态样本若窗口已到新窗口而签名仍为旧快照，**连续 ≥2 帧**才判红（避免 React 两次状态更新间的单帧竞态误报）。

## 3. 新增用例（本波新写）

`P2_degraded_disclosure`（降级链披露注入，路由级注入，不改生产代码）：

| 注入 | 手段 | 期望 |
|---|---|---|
| ① K 线 bar 序列不可得 | `route('**/api/kline**')` 返回 `bars: []` | 出 `wb-axis-degraded`；档位文案含 `per_bar 索引` 或 `ts 线性`；`data-x-mode` 离开主路 |
| ② K 线 + run per_bar 均不可得 | 保持 ① 且 `route('**/api/workbench/runs/**/bars**')`（`kind=per_bar`）返回空 | 出 `wb-axis-degraded` 且文案含 `ts 线性`；`data-x-mode == 'ts'` |

并逐帧（500ms × 16）记录档位演进 + 网络留痕（URL / 状态码 / 点数摘要），用于判定「档位是否后发」。

## 4. 边界与异常用例

| 边界 | 处理 |
|---|---|
| 曲线数据点超出 K 线可见 bar 序列（全览态 1949 → 只绘 614） | 配对只认容差内的点；`unmatchedVertices` 计数并断言 = 0；披露文案数值与 `pointCount − vertices` 对账 |
| 配对不到任何 bar（两图区间不相交） | `pairs = 0` ⇒ 判红（**禁止**「配不上就跳过」） |
| 同 bar 多点 / ts 非升序 | 计入 `duplicateBars` / `outOfTolerance`，落盘可查 |
| 小数 barSpace（317 / 614 根态） | 引擎取整 ⇒ `Δraw ≤ 0.5px` 量化；判据仍 ≤2px |
| 无缺口对照（≤40 根） | 补充态，用于区分「映射差」与「方法偏差」 |
| 手势平移不可用（引擎不支持拖拽） | `pan_gesture_probe` 能力矩阵探测 + 引擎 `scrollToDataIndex` 回退，**且必须披露**（本波实测拖拽/横向滚轮均可用） |

## 5. 覆盖目标

- 六态（初始 / 跟随最新 / 左滚若干根 / 全览 / 120 根跳转 / 300 根）+ 1 补充对照态，每态都要：
  配对偏差 ≤2px、跟随性、原子性、披露数值对账、截图（整页 + K 线 + 聚合 + 策略槽）。
- 降级链两档披露（注入）。
- 断言不做「缺陷存在」的先验假设（判词由报告给出），仅保留恒真的测量有效性约束。
