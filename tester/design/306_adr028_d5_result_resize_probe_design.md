# ADR-028 D5「结果页图表卡上下缩放 + K 线副图可选」探针设计（tester 车道 · 探针取证波）

- **本报告自身路径**：`tester/design/306_adr028_d5_result_resize_probe_design.md`
- 主报告（判词与逐项证据）：`tester/evidence/20260920_result_resize_probe/report.md`
- 执行报告：`tester/test/306_adr028_d5_result_resize_probe_execution.md`
- 新建规格：`web/e2e/adr028-resize-probe.e2e.ts`
- 本波定位：**开发前探针**——先确认「哪些已可用、哪些必须开发」，并留下**回归基线**；**不改任何生产代码**。

## 0. 背景与范围

用户需求：结果页**所有图表卡可上下缩放**、**K 线副图（默认 vol）可被选择**。已裁定三条边界：
① 只做高度缩放、不做宽度缩放；② 结果页指标与布局用**独立配置 key**，不污染看板；③ 表格类不自适应拖高。

实现前必须先回答（否则会写无用代码）：
1. 结果页 K 线是否**已有**副图指标勾选入口？当前副图渲染的到底是不是 vol？
2. candle↔VOL 分隔线**现在能否拖**（klinecharts 内建能力是否已打开）？拖拽前后 VOL 高度像素变化？若不能，限制在哪一层？
3. 五张图表卡的**实测高度与容器约束**（哪里是固定高度、哪里会被 flex 吞、哪里 overflow 拦截）？表格类是否已自适应滚动？
4. 改变 K 线卡/副图高度后，「同一根 bar」在 K 线与四张曲线图上的 x 配对偏差是否仍 **≤2px**（后续开发的**硬回归判据**）？

## 1. 测试策略（本波）

| 维度 | 口径 |
|---|---|
| 层面 | **真渲染 E2E**（Playwright + 已在跑的 8081 真身）。理由：本波问的是「DOM/引擎里到底有没有」，单测桩（chart stub）无法回答（`getPaneOptions`/命中测试/像素几何都为真引擎行为）。 |
| 观测手段 | ① **真身 API**：`Map.prototype.set` 只读捕获 klinecharts 实例 → `getPaneOptions()` / `getIndicators()` / `getSize()` / `getStyles()`（**不靠截图猜**）；② **DOM 几何**：pane 层 `getBoundingClientRect()`、分隔线命中 div 的 inline style、祖先链计算样式；③ **真鼠标手势**：`mouse.move/down/…/up`（≥3 帧、每步 60ms > 引擎 20ms 节流）；④ **对齐像素**：复用 `adr028-axis-align-probe.e2e.ts` v2 主口径（曲线渲染顶点 ↔ K 线真身 bar 像素 x 配对）。 |
| 变异手段（探针用，会话内、跑完还原） | inline `height` 注入（K 线卡 / 曲线卡）、`flex-shrink` 开关、`documentElement.style.zoom`。**不改源码、不落盘**。 |
| 反假绿 | ① `getPaneOptions()` 与 DOM pane 高**双口径**互证；② 拖拽必须伴随 hover 回执（`hitIsSeparator` + `activeBackgroundColor`）才算命中；③ 对齐判据要求 `pairs == 可见 bar 数` 且 `duplicateBars=0`（禁「配不上就跳过」）；④ 探针自身缺陷必须留痕披露（见执行报告 §2）。 |
| 资源纪律 | 单车道不 spawn 子代理；不起 `vite preview`（用 8081）；只跑本规格；命令 `timeout` 前缀；每步 `free -h`；收尾核查无残留 chromium / preview。 |

## 2. 用例清单（1 test / 4 段，串行；Given-When-Then）

| # | 用例 | Given | When | Then（观测点） |
|---|---|---|---|---|
| P1-1 | `副图指标入口普查` | 已打开 run 结果页 | 扫描 `wb-result` 内全部 `button/[role=button]/input/select/[aria-pressed]` | 产出控件总数、`VOL/MACD/KDJ/BOLL/DCAP/指标/副图` 命中列表、`aria-pressed` 计数（判「入口 有/无」） |
| P1-2 | `当前副图指标真身` | 同上 | `getIndicators()` / `getPaneOptions()` | 副图 paneId 与其指标 name（判「副图 = vol?」） |
| P1-3 | `分隔线可拖性静态条件` | 同上 | 读 pane options + separator 样式 + DOM 层结构 | `dragEnabled/state/minHeight`、`separator.size`、命中 div 的 rect/z-index/cursor、pane 层每层像素高 |
| P2-1 | `真手势上拖 40px` | 命中 div 在视口内（先复位滚动） | `mouse.down` → 12×`move(-40/12)` → `up` | hover 回执、分隔线 y 位移、candle/VOL DOM 高与 pane options 变化 |
| P2-2 | `真手势下拖 40px` | P2-1 之后 | 同上方向相反 | 是否可逆复原 |
| P2-3 | `拖到极限（上拖 200px）` | 同上 | 同上 | 归一化的下界（`minHeight=30`）与固定卡高下 VOL 上限 |
| P2-4 | `拖拽在窗口写操作后是否保留` | 已拖到极限 | 点「全览」→ 点「回退」 | pane options 是否仍为拖后值（图表实例是否被重建） |
| P3-1 | `五张卡几何 + 祖先约束链` | 基线态 | 读 rect / computed / 6 级祖先（display/flex/height/min/max/overflow） | 判定「有无固定高度或 overflow 会阻止拖高」 |
| P3-2 | `曲线卡拖高注入` | 同上 | 注入 `height:340px`（分别保留/关闭 `flex-shrink`）→ 读卡片与 svg 高 → 还原 | 卡片是否变高 / svg 是否跟随（判「拖高 已可用/必须开发」） |
| P3-3 | `K 线卡拖高注入` | 同上 | 注入 `height:480px` → 读卡片与内层图表高 → 还原 | 内层图表是否随容器（结构是否已就绪） |
| P3-4 | `表格自适应普查（4 Tab）` | 同上 | 逐 Tab（trades/perbar/events/metrics）读锚点 + 祖先链 + 后代可滚容器（client/scroll/maxHeight） | 「表格 自适应 是/否」 |
| P4-x | `对齐回归（7 态）` | 基线 | ①base ②卡高 480 ③卡高 160 ④还原 ⑤VOL 压缩 ⑥`zoom=0.8` ⑦还原 | 四图逐态 `max|Δ984|`、`max|Δraw|`、跨视图 userX 互差、plot 边界、pairs/dup/oot |

## 3. 层 × 用例覆盖矩阵

| 层 | 覆盖用例 | 说明 |
|---|---|---|
| klinecharts 引擎（pane/分隔线/指标） | P1-2, P1-3, P2-1…4 | 真身 API + 真手势 |
| React 结果页布局（卡片/容器/flex） | P3-1…3, P1-1 | computed style + 祖先链 + 注入 |
| 表格/分页（逐bar/成交/事件/绩效） | P3-4 | 滚动容器判定 |
| 跨图坐标对齐（ADR-028 D2.1） | P4-x | v2 主口径，7 态 |
| 窗口状态机（写入后是否重置布局） | P2-4 | 全览/回退 |

## 4. 边界与例外用例

- 高度极小：K 线卡 160px（能否读 + 对齐是否保持）；
- 高度极大：480px（图表是否跟随、对齐是否保持）；
- 副图压到引擎下界：`minHeight=30`（candle 30 / VOL 177）；
- 曲线卡注入「不关 flex-shrink」→ 预期被吞（验证陷阱）；
- CSS zoom（0.8）：坐标空间混合陷阱（已识别并给出尺度校正口径）；
- 视口外落点：Playwright 点击 Tab 会滚动容器 ⇒ 拖拽落点为负坐标（探针必须显式复位滚动，否则假红）；
- 无数据/空态（本次 run 有数据，空态不属本波范围）。

## 5. Mock / Stub 依赖

- **不需要 mock**：全部走真身 8081 真渲染 + 真接口（`/api/workbench/runs/{id}/curve?kind=…`、`/round-trips`）。
- 唯一"注入"是**页面侧只读**的 `Map.prototype.set` 包装（捕获 klinecharts 实例，只调其只读 getter），与 v2 探针同法，不改变行为。
- 无 stub chart、无 fixture、无离线复算（像素判据由真身 API 与 DOM 几何给出）。

## 6. 覆盖率目标

- 本波不设行覆盖率目标（不启用 `--coverage`，且「有没有入口/能不能拖」属存在性断言，行覆盖率无解释力）。
- 覆盖以**问题 × 判据**计：4 个问题 9 条子判据（§2 表），要求**逐项有原始读数**落盘；对齐回归要求 **7 态 × 4 图 = 28 组**配对读数全部落盘且 `pairs == 可见 bar 数`。
