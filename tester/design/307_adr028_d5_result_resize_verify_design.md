# 设计报告：ADR-028 §2.4c（D4.2）结果页缩放 + 指标可选 —— tester 独立终验规格

> **本文件自身路径**：`tester/design/307_adr028_d5_result_resize_verify_design.md`
> 被测交付：`coder/evidence/20260920_result_resize/report.md`（实现方报告）
> 设计产物（规格代码）：`web/e2e/adr028-d5-result-resize-tester-verify.e2e.ts`
> 设计/执行产物（证据）：`tester/evidence/20260920_result_resize_verify/`

## 1. 测试策略

| 原则 | 落地 |
|---|---|
| **独立复跑、不引用他人读数** | 全部读数由本规格自建探针在真身 `:8081` 上重算；实现方规格只作为“回归门”单独跑，不引用其 json/结论 |
| **像素/真身双口径** | 几何 → `getBoundingClientRect`；图表真身 → klinecharts `getIndicators()/getPaneOptions()/getSize(paneId)`；曲线位置 → `viewBox` + `polyline points` + `getScreenCTM()` |
| **行为反证优先于结构断言** | 「拖高/复位/保持/只做高度」一律用真鼠标手势（`mouse.down/move/up`）+ 前后像素差作答；横向拖 +80px 作为「只做高度」的行为反证 |
| **隔离性多口径** | localStorage 键**增量** + 看板哨兵键逐字节不变 + 非 GET `/api/config/*` 写入计数 + 跨页对照（切到看板读其真身态） |
| **反假绿** | 变异构建（固定 svg 高度 / 指标切换重建实例）必须使本规格变红；还原后与线上 bundle 逐字节比对 |
| **纪律** | 页面侧探针**只读**；不改生产代码；跑冻结规格后 `git checkout --` 还原被覆盖的 tracked 证据 |

## 2. 分层覆盖计划

| 层 | 覆盖方式 | 规格 |
|---|---|---|
| 单元 | 共享 PAD 常量与净化逻辑 / 缩放原语 / 指标入口组件（实现方新增 5 文件） | `curveGeometry.test.tsx`、`resultChartConfig.test.ts`、`cardResize.test.tsx`、`resultResizeIndicators.test.tsx`、`IndicatorToggles.test.tsx`（我的角色：确认存在、跑绿、并**独立**复算同一性质） |
| 集成（真渲染） | 结果页 K 线卡 + 四张曲线卡 + 三表格的真实交互与几何 | `adr028-d5-result-resize-tester-verify.e2e.ts`（RV-1…RV-6） |
| 契约 | 轮询/取数契约与窗口同步不受缩放影响 | 冻结规格 `adr028-window-sync`、`adr028-axis-align-probe`、`adr028-resize-probe`、`adr028-features-verify` |
| E2E 端到端 | 结果页 → 看板的跨页隔离对照 | RV-6 |

## 3. 用例清单（should-when 命名）

| 用例 | 场景（Given-When-Then） |
|---|---|
| **RV-1** 指标选择入口 + 切换真身 + 配置隔离 | Given 结果页打开某 run / When 读入口、关 VOL、开 MACD、开 KDJ / Then 入口 6 枚且默认 vol 开；`getIndicators()` 真身随之变化；localStorage 仅多 1 个结果页键、哨兵键逐字节不变、无非 GET 配置写请求 |
| **RV-2** K 线卡拖高 + 双击复位 + 副图 pane 高度保持 | Given 默认 VOL 副图 / When 拖分隔条→拖卡片下边缘 +150→开 MACD→双击标题→关全部副图 / Then 副图高度 100→63；卡片 256→406、内层 194→344；切换后仍 63；复位 256/194；关闭后无残留空 pane |
| **RV-3** 曲线卡拖高 + 复位 + 只做高度 | Given 聚合分/净值+回撤两张曲线卡 / When 拖下边缘 +60、双击标题、横向拖 +80 / Then 卡与 svg 同步 ±60 且 svg 类名由固定改 `h-full`；复位精确回默认；宽/viewBox/顶点 userX 不变、结果页无宽度类把手 |
| **RV-4** 表格类 + PAD 单源与跨视图偏差 | Given 三个 tab / When 逐个挂载并读几何；读四曲线顶点与 viewBox / Then 三表格无把手/无 inline 高度/无 ns-resize；四曲线首末 = 8/992；跨视图逐 bar 偏差 ≤0.1 user unit（换算 px ≤0.1） |
| **RV-5** 持久化 | Given 拖高 +150 并开 MACD / When 刷新并重进同一 run / Then 卡高与勾选态保持、真身含 MACD、键集不变 |
| **RV-6** 跨页隔离对照 | Given 结果页置 macd=开/vol=关 / When 切到看板页 / Then 看板仍为默认（vol 开/macd 关）且未新增存储键 |

## 4. Mock / Stub 策略

- **不使用 mock**：全部对真身 `:8081`（真实 app + 真实 DB + 真实 bundle）。变异反证时才起临时 `vite preview`（`dist-mut`）指向同一后端代理。
- 页面侧仅一处“打桩”：包 `Map.prototype.set` 以**只读**捕获 klinecharts 实例（用于调只读 API），不改变行为。
- localStorage 预置：注入 `eestock.dashboard.layout.v1` / `eestock.dashboard.indicators.v1` 两个**看板哨兵键**作为对照（值取极端值 macd/kdj=true），用于证明结果页既不读也不写它们。

## 5. 边界与异常用例

| 类别 | 覆盖 |
|---|---|
| 副图 pane 生命周期 | 0/1/2 个副图 pane（关净 / 单 / 双）；「无残留空 pane」用真身 pane 集合 + DOM 分隔条计数双口径 |
| 缩放边界 | 只测「拖下边缘增高」与「双击复位」；下限/上限（120–1200）本轮不做穷举（不在判据内），仅记录 inline 形态 |
| 横向拖动 | dy=0 的横向拖（宽度不得变化）——覆盖“误引入宽度缩放”的反面 |
| 表格 | 三个 tab 逐个真挂载（不做「文本存在」弱断言） |
| 存储异常 | 只验证“增量恰 1 键 + 哨兵不变”；坏 JSON 净化为实现方单测覆盖（`resultChartConfig.test.ts`，我确认跑绿） |
| 数据配对 | 四曲线顶点数须一致（n=103）且顶点序=bar 序（等距残差 ≤0.06 容差），否则跨视图比对无意义（会直接红） |

## 6. 覆盖目标与达成

| 目标 | 达成 |
|---|---|
| 判据 1–10 全覆盖 | 是（判词逐项见主报告 §0/§2） |
| 新增真渲染用例 | 6 个（RV-1…RV-6），全绿 |
| 反假绿 | 2 个变异均使本规格**定点**变红（且非相关用例仍绿） |
| 单元层守卫 | 确认 `CURVE_PAD === 8` 的守卫单测存在并跑绿，且**独立**用源码扫描 + 运行期首末顶点复算同一性质 |

## 7. 产物位置

- 规格代码：`web/e2e/adr028-d5-result-resize-tester-verify.e2e.ts`
- 原始证据：`tester/evidence/20260920_result_resize_verify/raw/`
- 主报告（判词）：`tester/evidence/20260920_result_resize_verify/report.md`
- 执行报告：`tester/test/019_adr028_d5_result_resize_verify.md`
