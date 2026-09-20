# ADR-028 D5 —— 结果页图表卡「上下缩放 + K 线副图可选」**探针取证**报告

> **本报告自身路径**：`tester/evidence/20260920_result_resize_probe/report.md`
> **探针规格（新建，本波唯一新跑规格）**：`web/e2e/adr028-resize-probe.e2e.ts`
> **设计报告**：`tester/design/306_adr028_d5_result_resize_probe_design.md`
> **执行报告**：`tester/test/306_adr028_d5_result_resize_probe_execution.md`
> **原始输出 / 截图**：`tester/evidence/20260920_result_resize_probe/raw/`（**报告所引终轮**）+ `raw_run1/`…`raw_run4/`（前四轮探索，含早期探针缺陷与负结果留痕）

---

## 0. 判词（一行，前置）

**指标选择入口 = 无**（结果页 103 个可交互控件里 `indicatorEntries=[]`、`aria-pressed` 数 = 0，唯一 checkbox 是「各策略评分」图例开关 `legend-slot-0`；当前副图真身 = **VOL**，挂在 `indicator_pane_1789876589121_2`） ｜ **副图拖拽 = 已可用**（klinecharts 10.0.3 内建 `SeparatorWidget`，`dragEnabled=true`/`state=normal`；真鼠标手势实测：上拖 40px ⇒ 分隔线 y 205→165、candle 副图 107→67px、VOL 100→140px，命中即亮 `activeBackgroundColor`；**但只能在固定 256px 卡高内重分配**，VOL 极限 = 177px（candle 触底 `minHeight=30`），且拖拽结果在「全览/回退」后仍保留） ｜ **图表卡高度结构 = K 线卡 256px（`h-64 shrink-0 flex-col`，注入 480px ⇒ 卡片 480px、内层图表 234→458px 跟随）+ 曲线卡 186/190/218/271px（内层 svg 固定 `h-40`/`h-36`/`h-52`/`h-52`，注入卡高 340px ⇒ 卡片变高但 svg 仍 160px 不跟随）**，全链路无 `max-height` 约束，唯一阻挡曲线卡「拖高」的是 svg 固定高度与 `flex-shrink:1` ｜ **表格自适应 = 否**（交易明细/逐bar/事件日志三处容器 `clientHeight == scrollHeight`，无内滚动，全靠结果页 `wb-result`（680 高 / 6540 内容）整页滚动） ｜ **拖高后对齐 ≤2px = 成立**（K 线卡 480/160/256 三档 + VOL 压缩档 + zoom 档共 7 态，四张曲线图 `max|Δ984| ≤ 0.05px`、非 zoom 态 `max|Δraw| ≤ 1.25px`） ｜ **必须开发的项**：①结果页 K 线副图指标**选择入口**（+ 独立配置 key）②**曲线卡「拖高」**（svg 高度须随容器，另需 `shrink-0`/显式高度）③**K 线卡拖高把手 + 高度持久化**（K 线卡结构已就绪、副图拖拽库已内建，只缺外层卡片把手与配置落库）。

---

## 1. 真身、资源纪律与可复现性

| 项 | 取值 |
|---|---|
| 真身 | `http://localhost:8081` 主机进程 `eestock-app`（pid 1941108，`./target/debug/eestock-app --config /tmp/app_dev_8081.toml`，按请求读 `./web/dist`） |
| bundle | `/assets/index-BY728MHs.js`，磁盘 sha256 `f2504232e7a4fba582943fdbe020235013fef27752313db6cc69531f37d0fa0e`；**自 8081 拉取的响应体 sha256 与磁盘逐字节一致**（同 hash） |
| 磁盘 mtime | `web/dist/assets/index-BY728MHs.js` = 2026-09-20 10:44:59 +0800 |
| commit | `cf3e6e714e5615227d56dbb4d64253c4dc982bde`（+ 未提交工作树；`git status --porcelain web/src` **为空** = 生产代码零改动） |
| run | `sr_1789832517800_000006`（518880 / M5 / 974 根；窗口态 `source=kline`，`[1789454700, 1789628100]` 103 根） |
| 视口 | 1280×720（Playwright `Desktop Chrome`，`locale=zh-CN`，`timezone=Asia/Shanghai`） |
| 资源纪律 | **单车道，不 spawn 子代理**；**未起 `vite preview`**（只用已在跑的 8081）；**只跑本波新建的 `adr028-resize-probe.e2e.ts` 一个规格**；每条命令 `timeout` 前缀（120s 列表 / 1000s 跑测）；每步记 `free -h`（`raw/step0_free.txt`、`raw/step_free.log`）。 |
| 收尾核查 | `vite preview` 匹配 = **0**、`ms-playwright`/`headless_shell`/`chrome-linux` = **0**、`playwright test` 残留 = **0**（用 `/proc/*/cmdline` 枚举自查，排除自身 shell）；8081 仍 200 |
| 内存 | 起测前 10Gi free / 29Gi available；终测后 9.6Gi free / 28Gi available（无异常增长；跑测期间峰值未触发 OOM） |

## 2. 结论表（逐项：已可用 / 必须开发 / 受限原因）

| # | 事项 | 判定 | 证据 / 受限原因 |
|---|---|---|---|
| 1 | 结果页 K 线**副图指标选择入口** | **必须开发**（当前**无**） | `raw/p1_indicator_entry.json`：`wb-result` 内 103 个 `button/[role=button]/input/select/[aria-pressed]`，其中 `indicatorEntries=[]`、`maEntries=[]`、`aria-pressed` 计数 = 0；唯一 checkbox = `legend-slot-0`（「各策略评分」图例，非副图指标）。源码侧同源：`ResultView`/`KlineResultChart` 未渲染任何指标开关，且 `KlineResultChart` 把 `indicators={DASHBOARD_DEFAULTS.indicators}` **硬编码**（看板配置直通结果页 ⇒ 正是「污染看板」风险点）。 |
| 2 | 当前副图**实际渲染的指标** | **= VOL**（与需求默认一致） | 同文件：真身 `getIndicators()` = `[{MA → paneId=candle_pane}, {VOL → paneId=indicator_pane_1789876589121_2, precision=0}]`；`getPaneOptions()` = candle_pane / indicator_pane_… / x_axis_pane（三者 `minHeight=30`、`dragEnabled=true`、`state=normal`）。 |
| 3 | K 线**副图拖拽**（candle↔VOL 分隔线） | **已可用**（库内建，无需开发；但受卡片高度限制） | `raw/p2_separator_drag.json`：命中 div = `666×7px, z-index:20, cursor:ns-resize`；hover 后 `hitIsSeparator=true` 且背景变 `rgba(22,119,255,0.08)`（= `styles.separator.activeBackgroundColor`）；**上拖 40px** ⇒ 分隔线 y 205→165、candle **107→67px**、VOL **100→140px**；**下拖 40px** ⇒ 复原 107/100；**上拖 200px（触底）** ⇒ candle **30px（= minHeight）**、VOL **177px（该卡高下上限）**；随后「全览」+「回退」后 pane options 仍为 30/177 ⇒ **拖拽结果不被窗口写入重置**（图表实例未重建）。 |
| 4 | 「副图拖拽」的**受限原因** | 不是 bug，是**容器高度** | 卡片 `wb-kline-chart` = `h-64 shrink-0`（256px）；内层 `kline-line` 容器 234px = candle + 1px 分隔条 + VOL + 26px x 轴。故 VOL 最多 177px，K 线主图最少 30px。**要在固定卡高外扩大副图，必须先让卡片高度可控**（见 #6）。 |
| 5 | 图表卡**实测高度与容器约束** | K 线卡 **已就绪**；曲线卡 **必须开发** | `raw/p3_card_structure.json` + `raw/p3_curve_card_injection.json`：K 线卡 256px（内层 `kline-chart` 234px）；聚合分卡 186px（svg 160 = `h-40`）、各策略卡 190px（svg 144 = `h-36`）、净值卡 218px（svg 208 = `h-52`）、持仓卡 271px（svg 208 = `h-52` + 口径说明行）。全链无 `max-height`；`wb-result` 自身 `overflow-y:auto`（680/6540）。注入实验：曲线卡 `height:340px; flex-shrink:0` ⇒ 卡片 340px 但 **svg 仍 160px（`svgFollowsCard=false`）**；若保留默认 `flex-shrink:1` ⇒ 注入的 340px 被 flex 收缩吞回 186px。K 线卡注入 480px ⇒ 卡片 480、内层 458（跟随）。 |
| 6 | **K 线卡拖高** | **结构已就绪，功能必须开发**（把手 + 持久化） | K 线卡自带 `shrink-0 flex-col` + 内层 `min-h-0 flex-1` ⇒ 高度随容器线性传导（234→458px），且 klinecharts `ResizeObserver` 自动重排（480/160 档重排后 bar 数/barSpace **不变**：103 根 / barSpace 6）。缺的是：拖拽把手、独立配置 key 落库。 |
| 7 | **曲线卡拖高** | **必须开发** | 四张曲线卡内 svg 为**固定 Tailwind 高度**（`h-40`/`h-36`/`h-52`），卡片高变化不影响绘图高（实测）。且四卡高度**并不统一**（186/190/218/271），与「预期 h-40」不符。 |
| 8 | 表格类（逐bar / 交易明细 / 事件日志）**自适应滚动** | **否**（与裁定一致，**无需开发**） | `raw/p3_card_structure.json`：三处容器的 `clientHeight == scrollHeight`（逐bar 2525/2525、事件 2036/2036、交易明细内层 5103/5103）⇒ **无内滚动条**，内容撑高后由 `wb-result`（client 680）整页滚动；交易明细表 **48 行**（行高 105px）一次渲染 = **5081px**、逐bar **100 行/页**（分页）= 2579px、事件 **96 行** = 2036px。 |
| 9 | **拖高后「同一根 bar」对齐 ≤2px** | **成立**（回归基线见 §6） | 7 态 × 4 图全绿：`max|Δ984| ≤ 0.05px`、非 zoom 态 `max|Δraw| ≤ 1.25px`；跨视图同一根 bar 的渲染 userX 互差 **恰好 2.0 user unit = 1.24px**（余量已消耗 62%，见 §6.3）。 |

## 3. P1 —— 指标入口与副图真身（原始读数）

来源 `raw/p1_indicator_entry.json`：

- `kLineChartId = k_line_chart_1`；`getSize() = 666×234`；`styles.separator = {size:1, color:"#DDDDDD", fill:true, activeBackgroundColor:"rgba(22, 119, 255, 0.08)"}`。
- pane 真身（`getPaneOptions()`，顺序 = DOM 顺序）：
  1. `candle_pane`：`height:100 / minHeight:30 / dragEnabled:true / state:normal`
  2. `indicator_pane_1789876589121_2`（**VOL**）：同上
  3. `x_axis_pane`：同上（`order:9007199254740991`；DOM 实测高 26px，options 里的 `height:100` **不生效**——x 轴按 autoSize）
- DOM 结构（pane 层 = 宿主 div → `chartContainer` → 4 个子元素）：

| # | 形态 | rect（x, y, w×h） | 说明 |
|---|---|---|---|
| 0 | pane（4 canvas） | 601, 101, 666×**107** | candle 主图（弹性 pane：234 − 1 − 100 − 26 = 107） |
| 1 | separator-bar（0 canvas） | 601, 208, 666×**1** | 分隔条本体（`background:#DDDDDD` = `separator.size=1`） |
| 2 | pane（4 canvas） | 601, 209, 666×**100** | **VOL 副图** |
| 3 | pane（2 canvas） | 601, 309, 666×**26** | x 轴 pane |

- **拖拽命中元素**（关键实现细节）：`div`，inline `width:100%; height:7px; position:absolute; top:-3px; z-index:20; cursor:ns-resize`，rect `601,205,666×7`（`REAL_SEPARATOR_HEIGHT=7`；**不是** `klinecharts-separator` 属性节点——klinecharts 10.0.3 内无此串）。
- ⚠ **踩坑留痕（写入本报告以免后人重踩）**：**Y 轴缩放 widget 同样使用 `cursor: ns-resize`**（实测两个 54px 宽的竖条），按 `cursor=ns-resize` 取第一个元素会拿到 Y 轴 widget ⇒ 假「拖不动」。必须用「**宽 > 100 且高 ≤ 10**」筛水平分隔线。第三轮探索（`raw_run3/p2_separator_drag.json` 首轮为负结果 = 选错元素 + 页面被 Playwright 点击 tab 后滚动导致落点变负坐标）已留档。

## 4. P2 —— 副图拖拽（原始读数，真鼠标手势）

来源 `raw/p2_separator_drag.json`（手势 = `mouse.move → down → 12 步 move（每步 60ms，> 20ms 节流）→ up`）：

| 手势 | 分隔线 rect.top | pane DOM 高（candle / VOL / x轴） | `getPaneOptions()`（candle / VOL） |
|---|---|---|---|
| 初始 | 205 | 107 / 100 / 26 | 100 / 100 |
| 上拖 40px | **165**（−40，精确） | **67 / 140** / 26 | **67 / 140** |
| 下拖 40px | 205（回到原点） | 107 / 100 / 26 | 107 / 100 |
| 上拖 200px（触底） | 128 | **30 / 177** / 26 | **30 / 177** |
| 之后「全览」 | 128 | 30 / 177 / 26 | **30 / 177**（保留） |
| 再「回退」 | 128 | 30 / 177 / 26 | **30 / 177**（保留） |

- hover 回执：`{"hitTag":"DIV","hitCursor":"ns-resize","hitIsSeparator":true,"sepBackground":"rgba(22, 119, 255, 0.08)"}`。
- 语义注意（**与常见直觉相反，落库前需与设计对齐**）：klinecharts 的 `isUpDrag` 分支把**上拖**判定为「缩小 topPane、放大 bottomPane」⇒ 结果就是 **上拖放大 VOL**、下拖缩小 VOL。
- 限制：任何时刻 `minHeight=30`（candle / VOL 皆同）；固定 256px 卡高下 **VOL ≤ 177px**。

## 5. P3 —— 卡片高度结构、拖高注入实验、表格滚动（原始读数）

来源 `raw/p3_card_structure.json`、`raw/p3_curve_card_injection.json`、`raw/p3_kline_card_injection.json`。

### 5.1 卡片实测（1280×720 视口）

| 卡片 | 卡高(px) | class | 内层 svg 高 | svg class / viewBox |
|---|---|---|---|---|
| `wb-kline-chart` | **256** | `flex h-64 shrink-0 flex-col rounded-lg border border-line bg-panel2` | 内层 `kline-chart` = **234** | — |
| `wb-aggregate-chart`（净值…总分曲线） | **186** | `rounded-lg border border-line bg-panel2 py-1` | **160** | `h-40 w-full` / `141.45 0 1070.82 160` |
| `wb-slot-chart`（各策略评分） | **190** | 同上 | **144** | `h-36 w-full` / `141.45 0 1070.82 160` |
| `wb-equity-chart`（净值+回撤） | **218** | `relative …` | **208** | `h-52 w-full` / `141.45 0 1070.82 220` |
| `wb-position-chart`（持仓比率） | **271** | `relative …` | **208** | `h-52 w-full` / `141.45 0 1070.82 220` |

- 祖先链约束（K 线卡）：`wb-kline-chart`(256) → `wb-kline-focus-anchor`(256) → `wb-result`（`flex h-full flex-col gap-2 overflow-auto p-3`，692×680，**唯一 `overflow-y:auto`**）→ `min-h-0 min-w-0 flex-1 bg-panel`(680) → `workbench-page`(1072×680) → `flex h-screen …`(720)。**无 `max-height`、无 `overflow:hidden` 卡点**。
- 曲线卡：静态 flex 项 `flex: 0 1 auto`（**`flex-shrink:1`**，`min-height:auto`）。

### 5.2 「拖高」注入实验（会话内 inline style，**不改源码、跑完即还原**）

| 实验 | 注入 | 结果 | 判读 |
|---|---|---|---|
| 曲线卡变高（含关收缩） | `wb-aggregate-chart` `height:340px; flex-shrink:0` | 卡片 **186 → 340**，svg **160 → 160（不变）** | **曲线图不随卡片变高 ⇒ 拖高必须开发**（`svgFollowsCard=false`） |
| 曲线卡变高（默认收缩） | 仅 `height:340px` | 卡片仍是 **186** | flex 列内 `shrink:1` 把注入高度**吞掉** ⇒ 实现自定义高度时必须显式 `shrink-0`/`flex-basis` |
| K 线卡变高 | `height:480px` | 卡片 **256 → 480**，内层图表 **234 → 458** | 结构已就绪（`shrink-0` + 内层 `flex-1`），图表随容器重排 |

### 5.3 表格类（三个 Tab 逐一切换实测）

| Tab / 锚点 | 表体尺寸 | 内层可滚容器 | 判读 |
|---|---|---|---|
| 交易明细（默认）`wb-round-trips-table` | 844×**5081**（**48 个 L1 回合行**，行高 105px——摘要列换行所致；`tbodyTrCount=48`、行内 testid 元素 768 个） | `div.overflow-auto`：client **5103** / scroll **5103** | 无内滚动 |
| 逐bar评分 `wb-perbar-table` | 650×**2579**（`tbodyTrCount=100`，行高 25px，分页） | `div.overflow-auto`：client **2525** / scroll **2525** | 无内滚动（分页替代） |
| 事件日志 `wb-event-log` | 650×**2036**（`eventRowCount=96`） | 自身 `overflow-auto`：client **2036** / scroll **2036** | 无内滚动 |
| 8项绩效 `wb-metrics-table` | 650×232（`tbodyTrCount=8`） | — | 无内滚动 |
| 结果页面板 `wb-result` | 692×680 | `overflow-y:auto`：client **680** / scroll **6540**（交易明细 Tab） | **整页滚动**——表格不随图表卡高度变化，与「表格类不自适应拖高」裁定一致 |

> 旁证（探针纪律副产物）：Playwright 点击 Tab 会 `scrollIntoView` ⇒ 结果页滚动位置被改（实测 K 线容器 `top` 一度为 −829px，导致首轮拖拽落点为负坐标而失败）。**开发时若在结果页加点按滚动锚点，需注意同一交互冲突**；本波已在每次测量/拖拽/截图前 `wb-result.scrollTop = 0` 复位。

## 6. P4 —— 对齐回归基线（后续开发必须保持的判据）

### 6.1 口径（与 `adr028-axis-align-probe.e2e.ts` **v2 主口径逐行同法，阈值不放宽**）

- **配对**：曲线渲染顶点（已渲染 `<polyline>`）↔ K 线**真身可见 bar** 的实测像素 x（`convertToPixel({timestamp},{paneId:'candle_pane'})` + 容器 `left`），ts 最近邻 + 容差 150s（M5）+ 单调一对一。
- **Δraw** = 同一根 bar 的屏幕像素差；**Δ984** = 归一化到 984px 参考宽（锚点 = 配对首末）的差。**判据：两者均 ≤ 2px**。
- 附加判据：**跨视图同一根 bar 的渲染 userX 互差**（同索引逐点）、各视图 plot 左右边界（应分别 = PAD 与 W−PAD）。
- 状态：`base`(256) → `klineTall`(480) → `klineShort`(160) → `restored`(256) → `volShrunk`（分隔线上拖 60px 后）→ `zoom80`（`documentElement.style.zoom=0.8`）→ `zoomRestored`。

### 6.2 七态结果（`raw/p4_alignment_summary.json`）

| 状态 | K线卡高 | 可见 bar / barSpace | 聚合分 Δ984 / Δraw | 各策略 Δ984 / Δraw | 净值 Δ984 / Δraw | 持仓 Δ984 / Δraw | 跨视图 userX 差 |
|---|---|---|---|---|---|---|---|
| base | 256 | 103 / 6 | 0.05 / 0.03 | 0.05 / 0.03 | 0.05 / 1.25 | 0.05 / 1.25 | 2.00（=1.24px） |
| klineTall | **480** | 103 / 6 | 0.05 / 0.03 | 0.05 / 0.03 | 0.05 / 1.25 | 0.05 / 1.25 | 2.00 |
| klineShort | **160** | 103 / 6 | 0.05 / 0.03 | 0.05 / 0.03 | 0.05 / 1.25 | 0.05 / 1.25 | 2.00 |
| restored | 256 | 103 / 6 | 0.05 / 0.03 | 0.05 / 0.03 | 0.05 / 1.25 | 0.05 / 1.25 | 2.00 |
| volShrunk | 256 | 103 / 6 | 0.05 / 0.03 | 0.05 / 0.03 | 0.05 / 1.25 | 0.05 / 1.25 | 2.00 |
| zoom80 | 205（=256×0.8） | **117 / 8** | 0.05 / **185.96\*** | 0.05 / **185.96\*** | 0.05 / **187.46\*** | 0.05 / **187.46\*** | 2.00 |
| zoomRestored | 256 | 103 / 6 | 0.05 / 0.03 | 0.05 / 0.03 | 0.05 / 1.25 | 0.05 / 1.25 | 2.00 |

- 每态每图 `pairs = 103`（zoom 态 117）、`outOfTolerance = 0`、`duplicateBars = 0` ⇒ 配对完整（禁「配不上就跳过」）。
- **\* zoom80 的绝对 Δraw 是坐标系混合产物，不可比**：`getBoundingClientRect()` 被 CSS zoom 缩放，而 `convertToPixel()` / `getScreenCTM()` 未缩放 ⇒ 出现 ≈93px 的尺度性偏移（`offsetMedianRawPx=92.98`，去中位残差同值 = 线性漂移而非常数偏移，故不能用「去常数偏移」救）。**尺度校正残差**（= Δ984 × spanK/984）为 **0.05px** ⇒ 该态**对齐本身成立**，仅绝对像素口径失效。本波判据：zoom 态以 Δ984 + 尺度校正残差判（不放大不放松），绝对 Δraw 一并落盘披露。
- K 线卡高度变化**不改变**可见 bar 数（103）与 barSpace（6）⇒ 纵向缩放不扰动横向窗口（这正是「同一根 bar 对齐」得以保持的机制）；CSS zoom 触发了容器尺寸变化 ⇒ klinecharts `ResizeObserver` 重排（117 根 / barSpace 8），对齐同样保持。

### 6.3 余量（重要：给后续开发的「对齐预算」）

- 净值/持仓两图与聚合/各策略两图之间存在**系统性 1.24px 差异**（跨视图 userX 差恒 **2.0 user unit**）：聚合/各策略用 `PAD=8`（userX 8→992），净值/持仓用 `PAD=10`（userX 10→990）；在 666px 卡宽（viewBox 宽 1070.82）下 2 user unit = **1.244px**。
- 即：**≤2px 判据的既有余量只有 0.75px**。任何改动（改 PAD / 改 `viewBox`/`plot` 几何 / 改 `xDomain` 映射 / 卡片宽度变化引起的比例变化）都可能一步吃掉余量 ⇒ 后续开发必须把本探针当作回归门（`max|Δ984| ≤ 2px` 且不得让 `crossViewMaxUserX` 从 2.0 上升）。

## 7. 建议的最小改动面（**仅供参考，不代替设计**）

| 目标 | 证据指向的最小改动 | 关键约束（本波实测） |
|---|---|---|
| ① 副图指标可被选择 | 结果页新增**副图指标开关入口**（现有唯一的 `aria-pressed` 模式在看板 `Toolbar`，结果页需自带一套）；`KlineResultChart` 的 `indicators={DASHBOARD_DEFAULTS.indicators}` 改为**受控 prop**；配置用**独立 key**（不得读写看板指标配置）。 | 切换指标 = `createIndicator/removeIndicator`；**"关态不残留空 pane"**且**参数变化走 `overrideIndicator` 不销毁 pane**（否则用户拖过的副图高度被重置）——该契约已存在于 `KlineChart.syncIndicators`，改动须沿用。 |
| ② K 线卡「上下缩放」 | K 线卡已有 `shrink-0 flex-col` + 内层 `flex-1 min-h-0`：只需加**拖拽把手 + 高度状态**，图表会自行重排（实测 234→458px 正常）；高度落库用独立 key。 | 高度下限需 ≥ candle `minHeight 30` + 分隔条 1 + VOL 最小 30 + x 轴 26 ≈ **87px**；实测 160px 档仍可读且对齐成立。 |
| ③ 副图高度 | **无需再开发拖拽**（库内建，命中/边界/持久化均已验证）；若要「超出卡高」的副图，必须**先**把卡片高度做成可控（见 ②）。 | 上拖语义 = 放大 **bottom** pane（VOL）；`minHeight=30` 双向生效；拖拽结果在「全览/回退」后保留（实测）。 |
| ④ 曲线卡「上下缩放」 | **必须**把四个 svg 的固定高度（`h-40`/`h-36`/`h-52`）改为**随容器**（如 `h-full` + 卡片受控高度），卡片加 `shrink-0` 或显式 `flex-basis`（否则注入高度被 flex 吞掉）。 | **只做高度不做宽度**：`preserveAspectRatio="none"` + `plot`（与 K 线共用 `viewBox` x 几何）不得动；四卡当前高度并不统一（186/190/218/271），若要求「同高」属新增口径。 |
| ⑤ 表格类 | **维持现状**（不参与拖高），与裁定一致；三处容器无内滚动（靠整页滚动），若将来要「表格自适应」需另立需求。 | 交易明细 48 行（行高 105px）一次渲染 = 5081px，若改为内滚动需同时定「默认高度」；本波不加判据。 |
| ⑥ 回归门 | 把本探针加入回归（`Δ984 ≤ 2px` + `Δraw ≤ 2px`（非 zoom 态）+ `crossViewMaxUserX` 不升）。 | 余量仅 0.75px（§6.3）。 |

## 8. 残余风险 / 未测（诚实边界）

1. **跨视图 1.24px 系统性差异**（PAD 8 vs 10）为**本波之前既有**状态，不是本波引入；判据仍成立（≤2px）但余量小（§6.3）。
2. **CSS zoom 下绝对 Δraw 不可比**（坐标系混合）：已用尺度校正残差（0.05px）替代并披露；若后续要求真 zoom 场景的绝对像素判据，需另建口径（例如统一用 `getBoundingClientRect` 反算两图坐标）。
3. **拖拽持久化只验证到「窗口写操作（全览/回退）后保留」**；未验证「run 切换 / 页面跳转 / 浏览器刷新」后的保留（本轮需求未要求，但若做成「用户设置」则须补测）。
4. **未验证副图指标切换后的拖拽高度保持**（指示为 ① ② 组合场景，需在实现后补测）。
5. **未做像素级截图审阅**（本车道的截图已全部落盘，但本次取证以 DOM/真身 API 数值为准；如需像素见证，建议由审阅方看 `raw/state_p2_separator_drag_max_vol.png` 与 `raw/state_p4_klineTall.png`）。
6. 备选 run `sr_1789875082403_000003`（159776/D1）**未纳入**本轮（M5 run 已覆盖缺口态与非缺口态；时间预算内单 run 足够）。
7. 探针会话内的 `documentElement.style.zoom` 与卡片 inline height 均为**会话内临时态**，跑测结束即行还原（`writable` 证据：`raw/p3_*_injection.json` 的 `restored` 字段）；生产代码零改动（`git status --porcelain web/src` 为空）。

## 9. 产物清单

| 文件 | 内容 |
|---|---|
| `web/e2e/adr028-resize-probe.e2e.ts` | 本波新建探针规格（1 test / P1–P4 串行 36s，硬断言 = 四图逐态 Δ984≤2px + 非 zoom 态 Δraw≤2px + zoom 态尺度校正≤2px） |
| `raw/p1_indicator_entry.json` | 控件普查 + pane/指标真身 + pane DOM + 命中 div + separator 样式 |
| `raw/p2_separator_drag.json` | 三次拖拽（−40/+40/−200）+ hover 回执 + DOM pane 高 + pane options + 窗口写操作后保留 |
| `raw/p2_reset_check.json` | 复位后 K 线几何（证明拖拽前落点在视口内） |
| `raw/p3_card_structure.json` | 五张卡几何/祖先链/滚动容器 + 四个 Tab 的表格锚点链与滚动态（含 `tbodyTrCount` / `eventRowCount` / `testidElementCount` / 首行行高） |
| `raw/p3_curve_card_injection.json` / `raw/p3_kline_card_injection.json` | 拖高注入实验（含 `restored` 还原读数） |
| `raw/p4_state_*.json`（7 个）+ `raw/p4_alignment_summary.json` | 逐态原始测量与压缩汇总（含 CTM、screenHead/Mid/Tail、span、offset/centered/anchored 残差） |
| `raw/summary.json` | 判词输入的汇总（P1/P2/P3） |
| `raw/state_*.png`（13 张） | 逐态截图（含 `p2_separator_drag_max_vol`、`p4_klineTall/klineShort`、`p3_tab_perbar/events`） |
| `raw/run_final_stdout.txt` + `raw_run1/run1_stdout.txt`、`raw_run2/run2_stdout.txt`、`raw_run3/run3_stdout.txt`、`raw_run4/run4_stdout.txt` | 历次运行原始 stdout（含三次「探针自身 bug」的失败留痕：①Y 轴 widget 误选 + 断言键名 ②Playwright 点击 Tab 致滚动、落点负坐标 ③`net_value` 曲线 `points` 为 `[ts,value]` 数组而解析成 `p.ts` ⇒ 均为**探针缺陷**，非产品缺陷） |
| `raw/step0_free.txt` / `raw/step_free.log` | 每步 `free -h` |

> **终轮命令（原始 stdout 见 `raw/run_final_stdout.txt`）**
> `cd web && E2E_BASE_URL=http://localhost:8081 ADR028_RESIZE_OUT=<evidence>/raw timeout 1000 npx playwright test e2e/adr028-resize-probe.e2e.ts --reporter=list --retries=0 --workers=1`
> 结果：**1 passed（36.4s）**，退出码 0，无崩溃 / 无 core dump / 零 skipped。
> 第 1–4 轮探索（同一规格的早期版本）留档于 `raw_run1/`…`raw_run4/`：其失败均为探针缺陷所致（详见 §3 ⚠、§9 与执行报告 §2），**不作为产品结论**。
>
> **可复现性**：测量口径冻结后连跑两次（`raw_run4/…`= 前一版终轮、`raw/…`= 报告所引终轮）逐项数值**完全一致**（P1 控件/指标、P2 三次拖拽像素、P3 卡片高度与表格行数、P4 七态 28 组 Δ984/Δraw）；`raw_run4/run4_stdout.txt` 与 `raw/run_final_stdout.txt` 的探针摘要行逐字节相同（除 chart 实例 id 时间戳）。
