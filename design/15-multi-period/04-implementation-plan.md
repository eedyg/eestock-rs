# 多周期指标同显 — 实施计划（TDD 分期与派单）

> 依据：`01-adr.md`（ADR-022）、`02-spec.md`、`03-test-plan.md`。
> 纪律：Red → Green → Refactor；每期先由 tester 落红测试，再由 worker 实现，最后 tester 独立验收。
> **派单硬约束**：每期 ≤20 分钟实现 + ≤10 分钟自测；遇设计问题**停手上报**，禁止调参/凑绿；禁 `git add/commit/stash`；禁 tangle（除指定项）；不重启线上；**0 写请求**。

---

## 0. 前置（本期开工前必须先完成）

| # | 事项 | 负责 | 说明 |
|---|---|---|---|
| 0.1 | **MA 静默消失防护落地** | worker | 封装 `addOverlayIndicator`（§4.3）+ 整改 `KlineChart.tsx`/`GridCell.tsx` 的 `createIndicator(..., false)`；T7 红→绿。这是**独立小改动**，可先单独上线（不依赖多周期） |
| 0.2 | **进行中桶分钟更新性结论** | 定时探针 | `multiperiod-forming-bucket-live-probe`（2026-09-15 09:35）；结论决定 LIVE 段断言语义与 UI 说明 |
| 0.3 | **1w 的 barSpace 上限收敛** | tester | 在真实渲染上确定"基准 1d ↔ 卫星 1w"所需 `barSpace` 与 `barSpaceLimit` 取值（口径 9 的卫星放宽上限需实测锚定） |

## 1. 分期

### P1 骨架与隔离（不改变现有行为）
- 新增 `MultiPeriodChartStack` + `multiPeriodStore`；`enabled=false` 时 **DOM/行为与现状逐字节等价**（T11 的关闭态断言）。
- 新增 config 三层（`dto` 校验 + `rest` 端点 + `ConfigStore`，key=`multi_period`）：**先把校验与护栏做全**（T6 全负例）。
- 验收：T6 + T11（关闭态零残留）。
- 派单：tester（红：T6/T11）→ worker（实现）→ tester（独立验收）。

### P2 卫星实例（隐藏 K 线 + 指标继承）
- 卫星容器与实例；`state:'minimize'` + `separator:0`；指标继承基准勾选集合；每实例一个 `KlineDataFeed`。
- 验收：T2（含"`height:0` 单独无效"的库事实回归）、T5（除 LIVE 段）、**G4 像素取证**、T8（G3 预算）。
- 注意：本期的 LIVE 段先不做（等 P4）。

### P3 跨图同步（**G1 门禁主战场**）
- `ChartSyncGroup`：时间跨度对齐 + 重入抑制 + 卫星 `barSpaceLimit` + 回到最新。
- 验收：**T3（G1）**、T4。
- 反向证据必须具备：关掉抑制 ⇒ 回声/漂移必红。

### P4 LIVE 段与进行中桶语义
- `*_LIVE` 虚线（只画末段）；`1d` 无进行中桶 ⇒ 不画。
- 依赖 0.2 结论：若"进行中桶不随分钟更新"，需在 UI 明确标注（例如卫星 pane 角标"进行中，随桶收盘更新"），并把该语义写进 T5 断言。
- 验收：T5 全量 + 定时探针结论的落地说明。

### P5 布局持久化与稳定性
- 每实例高度拖拽 + 防抖持久化；与 ②③ 契约的联测（保存参数/切周期/切标的都不重置高度）。
- 验收：T9 + T12（失败可见）+ 全量回归（①②③④ + dcap 专项 + ADR-020）。

### P6 文档与上线
- 编程手册增补"多周期使用与限制"（1w 条件、预算 ×N、近似对齐 ≤1 根高周期 bar、总 pane ≤12、仅单图）。
- `design/06-web/01-dashboard.md` 增补多周期口径（纯散文，`file=` 块零触碰）。
- 检查点提交（feat/docs 分笔）→ 第二次部署（前端重建 + 重启，按既有技能：查 sim-live → 回滚件 → 冒烟 → 独立验收）。

## 2. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 跨周期对齐误差累积/漂移 | 高 | **G1**：20 轮镜像 + 连续手势；实现必须单向广播 + 抑制窗 |
| `isStack` 静默清空指标 | 高 | **G2** + `addOverlayIndicator` 断言非空；禁止裸 `createIndicator(..., false)`（grep 门禁） |
| 请求/订阅 ×N 打爆后端 | 中 | **G3** 计数门禁 + 仅单图 + ≤4 周期护栏 |
| 零高 pane 破坏导出/截图 | 中 | **G4** 用页面截图；文档写明禁用 `getConvertPictureUrl` |
| 与 ①②③④ 契约冲突（布局重置/强拉视口） | 中 | T4/T9/T11 联测；实现复用既有 `applied` 差分与 `followLatest` 门控 |
| 卫星实例内存/帧率 | 中 | 4 实例实测帧率/交互延迟写入报告（未证实项闭环） |
| 1w 退化 | 低 | 护栏：1w 仅基准 ≥1d；0.3 锚定 barSpace 取值 |

## 3. 明确不做（避免范围蔓延）

- 不改 dcap 口径（参数/公式/评分/归一化/浮点铁律）；不改 ABI/引擎/`ExecutionPolicy`；
- 不做宫格内多周期、不做 `1mo`、不做跨周期值叠加、不做本地聚合；
- 不引入新前端依赖（除既有 klinecharts/React/vitest/playwright）。
