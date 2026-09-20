# ADR-028 D4.1 前端实现报告（买卖点醒目化 + L2 跳转 focus/高亮/曲线竖线）

**完成判词**：买卖点醒目化 **完成**（实心圆点+描边+价格×股数标签+同 bar 堆叠，单测与真渲染像素双证） ｜ 精确到笔的高亮 **完成**（`fillKey = rt_seq:成交序号`，只高亮被点那一笔，3 秒回常态） ｜ focus 滚动 **完成**（scrollIntoView，`scrollTop` 1386→40） ｜ 曲线竖线 **完成**（四视图同一时点同位，全览清除） ｜ 真渲染验证 **通过**（新增 `adr028-fill-focus-highlight.e2e.ts` 绿 + 截图像素证据） ｜ 无回归 **绿**（`tsc -b` 0；window-sync 6/6 绿；探针 v2 2/2 绿；前端子集 85 项绿）

- 本报告路径：`coder/evidence/20260920_adr028_features/report.md`
- 需求事实源：①「K 线上最好再标注一下买卖的点」；②「l2 点击跳转之后，可以 focus 到 k 线上，并且高亮一下对应的买卖标记」。
- 契约：`design/01-architecture/adr/ADR-028-...md` §2.4 / **§2.4b（D4.1）**；`design/17-trade-detail-layering/02-spec.md` §9。
- 范围：**只动 `web/`**（+ 本车道证据目录）；**未改任何 Rust**（`git status --porcelain | grep -c crate/.rs = 0`）。

---

## 1. 逐项改动

| # | 文件 | 改动 |
|---|---|---|
| 1 | `web/src/features/workbench/KlineResultChart.tsx` | ①`buildMarkers` 产出 **dot 形态 + `label`（价格×股数）+ `stackIndex`（同 bar 堆叠序）+ `fillKey`**；②新增 `makeFillKey(rt_seq, fillSeq)`；③新增 `highlight`/`onHighlightEnd` prop 与 `wb-jump-highlight-note` **显式降级提示**（loading / unrecorded / unmatched / ok 四态） |
| 2 | `web/src/features/dashboard/KlineChart.tsx` | 注册自定义 overlay 模板 **`fillDot` + `fillDotHighlight`**（实心圆点 + 描边 + 价格×股数标签，同 bar 纵向堆叠 `FILL_DOT_DY_PX=12`，常态半径 3.2px/高亮 6.5px+脉冲）；新增 `highlightFillKey`/`highlightRev`/`onHighlightEnd` prop；新增 **Effect M（marker 重同步，幂等先清后建）**、**Effect P（脉冲定时器，150ms 步进 / 3000ms 回常态）**、**Effect G（高亮 overlay，按 `fillKey` 精确定位并复用堆叠序）**；容器上屏 `data-highlight-key/-active/-pulse`、`data-marker-overlays` 观测属性；`findMarkerByFillKey` 纯函数 |
| 3 | `web/src/features/workbench/ResultView.tsx` | `handleJump` 增 **①focus（`scrollIntoView` 到 K 线锚点 `wb-kline-focus-anchor`）②高亮（L2 ⇒ `fillKey`，L1 清空）④曲线竖线（`markerTs`）**；新增 `handleReset`（「全览」同时清高亮与竖线）；四曲线视图透传 `markerTs` |
| 4 | `web/src/features/workbench/RoundTripsTable.tsx` | `JumpTarget` 的 L2 增 `fill_index`（该回合内成交序号，0 基）、`price`、`qty`；L2 `[跳转]` 携带之（「点击 → 目标标记」一一对应的键来源） |
| 5 | `web/src/features/workbench/{AggregateScoreChart,SlotScoresChart,EquityDrawdownChart,PositionRatioChart}.tsx` | 各增可选 `markerTs` prop + `wb-vline`（`data-view`/`data-vline-ts`）竖线标记，x 由**同一 x 定义域**求出（`vlineX`） |
| 6 | `web/src/features/workbench/chartUtils.ts` | 新增 `vlineX(ts, xd, width, pad)`（复用 `curveXs`；定义域不可得/无槽位 ⇒ `null`，不钳位） |
| 7 | `web/src/features/workbench/adr028FocusHighlight.test.tsx`（新） | 6 项判据（见 §3） |
| 8 | `web/e2e/adr028-fill-focus-highlight.e2e.ts`（新） | 真渲染单规格（见 §4） |

### 关键实现决定（在既有架构内）
- **判别身份键**：`fillKey = `${rt_seq}:${成交序号}``。序号口径 = 同一 `rt_seq` 在 `/fills` 事实源中的出现次序（`buildMarkers` 内按 `rt_seq` 计数），L2 表行下标（`L2Table` 的 `i`）与之**同序同源**。**只高亮命中的那一笔**，未命中不画并**显式提示**。
- **同 bar 多笔可分辨**：按 `ts` 计数得 `stackIndex`，渲染时像素纵向偏移 `stackIndex×12px`（含不同 `rt_seq` 落在同一 bar 的情形）；标签各不相同。
- **不遮蜡烛主体**：常态半径 3.2px + 标签底色 `rgba(9,13,24,0.72)` 小字号（9px）；**不加跨点连线**。
- **脉冲不重建整图**：Effect G 仅 `removeOverlay({name:'fillDotHighlight'})` + `createOverlay(...)` 单枚高亮 overlay，**不 touch** dataList / barSpace / 视口 / 指标 pane（Effect L 不重跑）；Effect M 亦只按名清 marker 类 overlay。
- **overlay 重建不丢高亮**：Effect M 每次重同步递增 `overlayEpoch`，Effect G 依赖它 ⇒ 高亮自动重新套用（真渲染实测：feed 装载完成后仍 `data-highlight-active=true`）。
- **降级显式**（与 D11 一致）：`loading`（标记未到）/`unrecorded`（`recorded=false`）/`unmatched`（序号跨源不一致）三态文案 + `data-state` 属性，**不静默无反应**。

---

## 2. 真渲染实测发现（缺陷 → 修复，含原始输出）

**缺陷**：首轮真渲染像素对比显示「高亮态 vs 3 秒后」K 线区域**零像素差**（高亮根本没画出来）。
**最小复现（临时 debug 钩子，已删除）**：把 `chart.getOverlays()` 上屏 —— 当时 `names:["fillDot"]`、`n=16`（基础标记在，高亮那枚**不在** store 里）。
**根因**：`createOverlay({name:'fillDotHighlight'})` 的名字**未注册**；`StoreImp.addOverlay` 对
`getOverlayInnerClass(name) === null` **静默 `return null`**（`node_modules/klinecharts/dist/index.esm.js:14366` 分支），高亮 overlay 被丢弃且**零告警**。
**修复**：`register({...template, name:'fillDot'})` + `register({...template, name:'fillDotHighlight'})`（两个名字同一模板；分开命名以便按名单清高亮而不误清常态标记）。
**修复后原始输出**（`coder/evidence/20260920_adr028_features/raw/d41_pixel_diff.json`）：

```json
{"pulse_a":"7","pulse_b":"8",
 "marker_px_phase_a":{"buy#ff5c6c":617,"sell#00e0a4":447,"stop#fb923c":0,"white":135},
 "marker_px_phase_b":{"buy#ff5c6c":587,"sell#00e0a4":447,"stop#fb923c":0,"white":51},
 "marker_px_after_3s":{"buy#ff5c6c":562,"sell#00e0a4":461,"stop#fb923c":0,"white":3},
 "diff_phaseA_vs_phaseB":{"size":[668,256],"diff_bbox":[334,102,428,124],"px_any":765,"px_gt24":603},
 "diff_phaseA_vs_after3s":{"size":[668,256],"diff_bbox":[334,102,428,124],"px_any":1403,"px_gt24":730}}
```
读法：K 线裁切图内 `#ff5c6c`（买点标记色，蜡烛色为 `(181,36,75)`/`(38,143,115)` ⇒ **可区分**）像素在脉冲相位 A/B 分别为 617/587（半径与白描边随相位变化），3 秒后回落 562（白像素 135→51→3 = 描边消失）；**像素差只出现在单点局部区域** `x334–428, y102–124`（含标签随半径平移）⇒ 满足「放大 + 描边脉冲」「只高亮那一笔」「3 秒回常态」。

---

## 3. 单测（新增 `src/features/workbench/adr028FocusHighlight.test.tsx`，6/6 绿）

| 用例 | 判据 |
|---|---|
| 醒目化结构 | `shape==='dot'`、`label==='B 8.417×118'`（与页面 `fmtNum` 同口径：price 3 位 / qty≤4 位）、买红 `#ff5c6c`/卖绿 `#00e0a4`/止损橙 `#fb923c`、无连线类 overlay、`fillKey` 逐 rt 递增 |
| 同 bar 多笔 | 同 ts 三笔 ⇒ `stackIndex=[0,1,2]`（渲染纵向偏移，禁遮盖）、标签互不相同、`fillKey=['7:0','7:1','8:0']` |
| overlay 面 | 真图表调用的 `createOverlay('fillDot')` 携带 `label`/`stackIndex`/`fillKey`，且**先按名清旧再建**（幂等，不累积） |
| 精确到笔 + 3 秒 | 同 bar 两笔，`highlightFillKey='7:1'` ⇒ **所有**高亮 overlay 的 `fillKey` 恒为 `7:1`（绝不出现 `7:0`）、`stackIndex=1`；相位推进（`data-highlight-pulse` 1→2）；`advanceTimersByTime(3000)` 后 `data-highlight-active=false`、`pulse=0`、`removeOverlay({name:'fillDotHighlight'})` 被调用、**不再新建** |
| 结果页集成 | 渲染 `ResultView`（mock API）→ 展开 L2 → 点第 2 行 `[跳转]`：`scrollIntoView` 被调用、`kline-chart[data-highlight-key]='rt:1'`、`wb-jump-highlight-note[data-state]='ok'`、四视图 `wb-vline` 存在且 `data-vline-ts` **唯一**；点「全览」⇒ 竖线清 0、高亮键清空 |

原始输出：`logs/vitest_subset.log`（本文件 6 passed；受影响既有 8 个文件 79 passed 全绿）。

---

## 4. 真渲染验证（新增 `web/e2e/adr028-fill-focus-highlight.e2e.ts`，1/1 绿，8.4s）

目标 run `sr_1789832477006_000002`（159776/D1，rt_seq=1，16 笔）第 2 笔（`fill_index=1`）。
原始 JSON：`raw/d41_focus_highlight.json`；日志：`logs/e2e_adr028-fill-focus-highlight.log`。

| 判据 | 实测 |
|---|---|
| focus 滚动到 K 线且**视窗已在目标 bar** | `scrollTop` **1386 → 40**；锚点落在结果页可视区内；回执 `wb-window-probe data-ok=true`、`data-center-idx=262` == 该笔 `bar_index=262`（`data-rev=4`） |
| **只高亮被点那一笔** | `kline-chart[data-highlight-key]='1:1'`、`data-highlight-active='true'`、`wb-jump-highlight-note[data-state]='ok'`、`data-fill-key='1:1'` |
| 3 秒后回常态 | `data-highlight-active='false'`、`data-highlight-pulse='0'`（键仍指向目标笔，**无永久选中态**） |
| 曲线竖线 | 4 视图各 1 条（`aggregate/slots/equity/position`），`data-vline-ts=1783440000` **唯一** == 该笔成交 ts |
| 像素证据 | 见 §2（相位差 + 3 秒后差，局部单点区域） |

截图（`raw/`）：`d41_highlight_on.png`（全页·高亮中）、`d41_highlight_after_3s.png`（全页·回常态）、
`d41_kline_phase_a.png`、`d41_kline_phase_b.png`、`d41_kline_after_3s.png`（K 线区域裁切三态）。

**无回归（真渲染）**：`adr028-window-sync.e2e.ts` **6/6 绿**（26.2s）、tester 的探针 v2 `adr028-axis-align-probe.e2e.ts` **2/2 绿**（46.0s）；两个规格**未做任何修改**（`git status` 仅显示我方新增文件）。

---

## 5. 构建与产物

- `npx tsc -b` ⇒ **exit 0**（`logs/tsc_b.log`）。
- `npm run build` ⇒ 绿；**`dist/index.html` 引用 `assets/index-DhgvwmsX.js` == `dist/assets/index-DhgvwmsX.js`**（一致）；静态由 `vite preview`（代理 :8081）提供。
- 资源纪律：vitest 单文件 + `--maxWorkers=1` + `NODE_OPTIONS=--max-old-space-size=2048`；playwright 只跑本规格与两个必跑既有规格（`workers=1`）；每步 `free -h` 记录（19Gi used / 27Gi available，无压力）；结束核验 `pgrep -f '[v]ite preview'`=0、`ps -eo comm | grep -c '^chromium'`=0、无遗留 playwright 进程。

## 6. 未做项 / 已知限制（技术债登记）

1. **L1 `[跳转]` 无单笔高亮**（回合是区间，无「那一笔」语义）；L1 跳转的曲线竖线取 `open_ts`（契约未指定，ADRP §2.4b 只要求「同一时点」）。
2. **跨源序号的一致性假设**：`fillKey` 假定 `/fills` 事实源内同 `rt_seq` 的出现次序 == L2 切片的行下标（二者同引擎事实源、同 ts 升序）。若某日后端改序，UI **不会静默**：`wb-jump-highlight-note[data-state='unmatched']` 显式告警（单测已覆盖 unmatched 分支文案）。
3. **脉冲相位在截图里可见但幅度温和**（半径 ±2.2px + 白描边）；未做「描边扩散动画」等更夸张效果（避免噪声，D4.1 只要求放大+描边脉冲）。
4. 未跑 `adr028-axis-align-verify.e2e.ts`（非必跑清单内，且与本次改动面无关；其依赖的探针 v2 已绿）。
5. 未提交代码：仅 `git add` 暂存（见 §7）。

## 7. 暂存清单（`git add`，**未 commit**）

代码/规格：`web/src/features/dashboard/KlineChart.tsx`、`web/src/features/workbench/{KlineResultChart,ResultView,RoundTripsTable,AggregateScoreChart,SlotScoresChart,EquityDrawdownChart,PositionRatioChart,chartUtils}.tsx|ts`、`web/src/features/workbench/adr028FocusHighlight.test.tsx`、`web/e2e/adr028-fill-focus-highlight.e2e.ts`。
证据：`coder/evidence/20260920_adr028_features/**`。
